/* ------------------------------------------------------------------ *
 * The client end of the presence socket.
 *
 * On a public deployment this connection goes through a load balancer,
 * a home router's NAT table, and whatever a coffee shop calls a network.
 * All three drop connections without telling anyone, so the socket is
 * treated as unreliable by default rather than as a pipe that happens to
 * break occasionally.
 *
 * Three behaviours matter, and they interact:
 *
 *   Reconnect with exponential backoff and jitter. Backoff keeps a
 *   struggling server from being finished off by its own clients;
 *   jitter keeps every player who dropped at the same moment from
 *   returning at the same moment, which is how a recovering server is
 *   knocked straight back over.
 *
 *   A heartbeat, because a dead connection looks exactly like a quiet
 *   one. Without a ping, a socket whose far end vanished sits in
 *   `OPEN` forever and the player stares at a world that stopped moving.
 *
 *   A reason for the close. "Superseded" and "dropped" demand opposite
 *   responses: a dropped socket should come back hard, and a superseded
 *   one must never come back at all, or two tabs kick each other out in
 *   a loop that neither can win.
 * ------------------------------------------------------------------ */

import { API_BASE_URL, wsBaseUrl } from '../solana/cluster'
import {
  HEARTBEAT_INTERVAL_MS,
  PVP_PROTOCOL,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STALE_CONNECTION_MS,
  type C2S,
  type S2C,
} from '../shared/pvp'
import type { PublicLoadout } from '../shared/pvp'
import { presenceTokenSync, resolvePresenceAuth } from './guest'
import { pingPvp, pvpState } from './store'

let socket: WebSocket | null = null
let hello: { displayName: string; loadout: PublicLoadout } | null = null
let retries = 0
let timer: ReturnType<typeof setTimeout> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let opening = false
let lastServerMessageAt = 0

/**
 * Set when the server says this character is being played elsewhere.
 *
 * It suppresses reconnection until the player explicitly asks to take the
 * character back, which is the only thing that stops two open tabs from
 * evicting each other forever.
 */
let superseded = false

/** Set while the server is restarting: reconnect, but not immediately. */
let serverClosingUntil = 0

function wsUrl(token: string) {
  return `${wsBaseUrl()}/ws/pvp?token=${encodeURIComponent(token)}`
}

function apply(msg: S2C) {
  lastServerMessageAt = Date.now()
  switch (msg.t) {
    case 'welcome':
      pvpState.connected = true
      pvpState.signedIn = true
      pvpState.reconnecting = false
      pvpState.superseded = false
      pvpState.playerId = msg.playerId
      pvpState.gold = msg.gold
      pvpState.self = msg.self
      pvpState.others = msg.others
      pvpState.incomingDisabled = msg.incomingDisabled
      pvpState.duel = msg.active
      pvpState.invite = msg.pending.find(i => !i.youAreChallenger) ?? null
      pvpState.outgoing = msg.pending.find(i => i.youAreChallenger) ?? null
      retries = 0
      break
    case 'presence':
      pvpState.others = msg.others
      break
    case 'you':
      pvpState.self = msg.self
      pvpState.gold = msg.gold
      break
    case 'card':
      pvpState.inspect = msg.card
      break
    case 'invite':
      if (msg.invite.youAreChallenger) pvpState.outgoing = msg.invite
      else pvpState.invite = msg.invite
      break
    case 'inviteGone':
      if (pvpState.invite?.challengeId === msg.challengeId) pvpState.invite = null
      if (pvpState.outgoing?.challengeId === msg.challengeId) pvpState.outgoing = null
      if (pvpState.composer && msg.reason === 'accepted') pvpState.composer = null
      break
    case 'duel':
      pvpState.duel = msg.snapshot
      pvpState.inspect = null
      pvpState.composer = null
      pvpState.invite = null
      pvpState.outgoing = null
      break
    case 'combat':
      pvpState.duel = msg.snapshot
      break
    case 'result':
      pvpState.result = msg.result
      pvpState.surrenderAsk = false
      break
    case 'journal':
      pvpState.journal = msg.entries
      break
    case 'superseded':
      // The close that follows is not a fault. Stop reconnecting and say so,
      // otherwise this tab and the new one take turns evicting each other.
      superseded = true
      pvpState.superseded = true
      pvpState.reconnecting = false
      pvpState.error = msg.detail
      break
    case 'serverClosing':
      serverClosingUntil = Date.now() + msg.reconnectAfterMs
      pvpState.reconnecting = true
      pvpState.error = msg.detail
      break
    case 'error':
      pvpState.error = msg.detail
      break
    case 'pong':
      break
  }
  pingPvp()
}

/**
 * Proves the connection is alive, and gives up on it when it is not.
 *
 * A browser cannot send a protocol-level ping frame, so the application
 * `ping`/`pong` pair stands in for one. The server also sends protocol
 * pings, which the browser answers automatically; those keep the
 * *server's* view fresh. This timer keeps the client's.
 */
function startHeartbeat() {
  stopHeartbeat()
  lastServerMessageAt = Date.now()
  heartbeat = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastServerMessageAt > STALE_CONNECTION_MS) {
      // Nothing has arrived for a minute, including our own pongs coming
      // back. The socket says OPEN and it is not; closing it is what starts
      // the reconnect that the player is waiting for.
      socket.close(4000, 'stale')
      return
    }
    send({ t: 'ping', at: Date.now() })
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
}

async function open() {
  if (!hello) {
    pvpState.connected = false
    pingPvp()
    return
  }
  if (superseded) return
  if (opening) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  opening = true
  const auth = await resolvePresenceAuth()
  opening = false
  pvpState.signedIn = Boolean(auth)
  if (!auth) {
    schedule()
    pingPvp()
    return
  }
  try {
    socket = new WebSocket(wsUrl(auth.token))
  } catch {
    schedule()
    return
  }
  socket.onopen = () => {
    send({ t: 'hello', protocol: PVP_PROTOCOL, displayName: hello!.displayName, loadout: hello!.loadout })
    startHeartbeat()
  }
  socket.onmessage = event => {
    try {
      apply(JSON.parse(String(event.data)) as S2C)
    } catch {
      /* ignore junk */
    }
  }
  socket.onclose = () => {
    stopHeartbeat()
    pvpState.connected = false
    pvpState.reconnecting = superseded
      ? false
      : Boolean(pvpState.duel && pvpState.duel.phase !== 'ended') || Boolean(hello)
    pingPvp()
    socket = null
    if (!superseded) schedule()
  }
  socket.onerror = () => {
    /* close handler reconnects */
  }
}

/**
 * Exponential backoff with full jitter, floored by any restart window the
 * server asked us to respect.
 *
 * Full jitter — a uniform draw from [0, delay] rather than delay ± a bit —
 * is what actually spreads a thundering herd out. Retrying at "8 seconds,
 * give or take 10%" still means everyone retries at roughly 8 seconds.
 */
function schedule() {
  if (timer || superseded) return
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retries)
  const jittered = Math.random() * ceiling
  const restartFloor = Math.max(0, serverClosingUntil - Date.now())
  const wait = Math.max(restartFloor, jittered, RECONNECT_BASE_MS / 2)
  retries += 1
  timer = setTimeout(() => {
    timer = null
    void open()
  }, wait)
}

export function send(msg: C2S) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

export function startPvp(displayName: string, loadout: PublicLoadout) {
  hello = { displayName, loadout }
  retries = 0
  superseded = false
  pvpState.superseded = false
  void open()
}

export function stopPvp() {
  hello = null
  if (timer) clearTimeout(timer)
  timer = null
  stopHeartbeat()
  socket?.close()
  socket = null
}

/**
 * Takes the character back into this tab after it was claimed elsewhere.
 *
 * Reconnecting supersedes whoever holds it now, which is symmetric and
 * deliberate: the rule is "the most recent request wins", and the player
 * clicking here is making the most recent request.
 */
export function reclaimPvp() {
  if (!hello) return
  superseded = false
  pvpState.superseded = false
  pvpState.error = null
  retries = 0
  pingPvp()
  void open()
}

export function isSuperseded() {
  return superseded
}

export function refreshPvpIdentity(displayName: string, loadout: PublicLoadout) {
  hello = { displayName, loadout }
  send({ t: 'hello', protocol: PVP_PROTOCOL, displayName, loadout })
}

async function authHeader(): Promise<Record<string, string>> {
  const token = presenceTokenSync() ?? (await resolvePresenceAuth())?.token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function fetchPvpJournal() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/pvp/journal`, { headers: await authHeader() })
    const body = await res.json() as { entries?: typeof pvpState.journal }
    if (res.ok && body.entries) {
      pvpState.journal = body.entries
      pingPvp()
    }
  } catch {
    /* offline */
  }
}

export async function fetchPvpCard(playerId: string) {
  try {
    const res = await fetch(`${API_BASE_URL}/api/pvp/player/${playerId}`, { headers: await authHeader() })
    const body = await res.json() as { card?: typeof pvpState.inspect }
    if (res.ok && body.card) {
      pvpState.inspect = body.card
      pingPvp()
    }
  } catch {
    /* offline */
  }
}
