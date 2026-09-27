import { API_BASE_URL } from '../solana/cluster'
import { loadSession } from '../solana/api'
import { PVP_PROTOCOL, type C2S, type S2C } from '../shared/pvp'
import type { PublicLoadout } from '../shared/pvp'
import { pingPvp, pvpState } from './store'

let socket: WebSocket | null = null
let hello: { displayName: string; loadout: PublicLoadout } | null = null
let retries = 0
let timer: ReturnType<typeof setTimeout> | null = null

function wsUrl(token: string) {
  const base = API_BASE_URL.replace(/^http/, 'ws')
  return `${base}/ws/pvp?token=${encodeURIComponent(token)}`
}

function apply(msg: S2C) {
  switch (msg.t) {
    case 'welcome':
      pvpState.connected = true
      pvpState.reconnecting = false
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
    case 'error':
      pvpState.error = msg.detail
      break
    case 'pong':
      break
  }
  pingPvp()
}

function open() {
  const session = loadSession()
  pvpState.signedIn = Boolean(session)
  if (!session || !hello) {
    pvpState.connected = false
    pingPvp()
    return
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  try {
    socket = new WebSocket(wsUrl(session.token))
  } catch {
    schedule()
    return
  }
  socket.onopen = () => {
    send({ t: 'hello', protocol: PVP_PROTOCOL, displayName: hello!.displayName, loadout: hello!.loadout })
  }
  socket.onmessage = event => {
    try {
      apply(JSON.parse(String(event.data)) as S2C)
    } catch {
      /* ignore junk */
    }
  }
  socket.onclose = () => {
    pvpState.connected = false
    pvpState.reconnecting = Boolean(pvpState.duel && pvpState.duel.phase !== 'ended')
    pingPvp()
    socket = null
    schedule()
  }
  socket.onerror = () => {
    /* close handler reconnects */
  }
}

function schedule() {
  if (timer) return
  const wait = Math.min(8000, 400 * 2 ** retries)
  retries += 1
  timer = setTimeout(() => {
    timer = null
    open()
  }, wait)
}

export function send(msg: C2S) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

export function startPvp(displayName: string, loadout: PublicLoadout) {
  hello = { displayName, loadout }
  open()
}

export function stopPvp() {
  hello = null
  if (timer) clearTimeout(timer)
  timer = null
  socket?.close()
  socket = null
}

export function refreshPvpIdentity(displayName: string, loadout: PublicLoadout) {
  hello = { displayName, loadout }
  send({ t: 'hello', protocol: PVP_PROTOCOL, displayName, loadout })
}

export async function fetchPvpJournal() {
  const session = loadSession()
  if (!session) return
  try {
    const res = await fetch(`${API_BASE_URL}/api/pvp/journal`, { headers: { Authorization: `Bearer ${session.token}` } })
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
  const session = loadSession()
  if (!session) return
  try {
    const res = await fetch(`${API_BASE_URL}/api/pvp/player/${playerId}`, { headers: { Authorization: `Bearer ${session.token}` } })
    const body = await res.json() as { card?: typeof pvpState.inspect }
    if (res.ok && body.card) {
      pvpState.inspect = body.card
      pingPvp()
    }
  } catch {
    /* offline */
  }
}
