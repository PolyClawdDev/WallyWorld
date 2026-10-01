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
 *
 * The fourth behaviour is about what the player is told. Retrying forever
 * is right for a socket that dropped and wrong for one the server is
 * refusing, and from the outside those look identical: the socket opens,
 * something arrives, the socket closes. So every attempt records why it
 * failed, and after a few failures the UI stops claiming to be
 * "connecting" and says what actually went wrong. A session token the
 * server no longer holds is the case that made this necessary — it can be
 * replayed indefinitely without ever succeeding, so it is now thrown away
 * the first time it is refused rather than retried until the tab closes.
 * ------------------------------------------------------------------ */

import { API_BASE_URL, API_IS_SAME_ORIGIN, API_ORIGIN, wsBaseUrl } from '../solana/cluster'
import {
  HEARTBEAT_INTERVAL_MS,
  PVP_PROTOCOL,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STALE_CONNECTION_MS,
  type C2S,
  type DuelSnapshot,
  type S2C,
} from '../shared/pvp'
import type { PublicLoadout } from '../shared/pvp'
import { pushChatLine } from '../chat/store'
import { clearDuelCues, queueDuelCues } from './feedback'
import { forgetPresenceAuth, presenceAuthProblem, presenceTokenSync, resolvePresenceAuth } from './guest'
import { pingPvp, pvpState } from './store'

let socket: WebSocket | null = null
let hello: { displayName: string; loadout: PublicLoadout } | null = null
let retries = 0
let timer: ReturnType<typeof setTimeout> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let opening = false
let lastServerMessageAt = 0

/**
 * Failures tolerated before the chip stops saying "connecting".
 *
 * Four covers the ordinary cases this should ride out silently — a laptop
 * waking up, a router re-establishing NAT, a server restart — while still
 * being reached in a few seconds of backoff when the cause is not going away.
 */
const FAILURES_BEFORE_OFFLINE = 4

/** True once this attempt has been welcomed, so a close can tell why it closed. */
let welcomed = false

/** True once this attempt's socket reached OPEN. Separates "refused" from "unreachable". */
let sawOpen = false

/** The server's own explanation for the close, when it sent one. */
let serverReason: string | null = null

/** Set when a refused session has already been replaced once. A second refusal is not the token. */
let sessionReplaced = false

/** Set when nothing further is being attempted, so the UI can stop implying otherwise. */
let stopped = false

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

/** The presence endpoint without the token, which is the part worth showing a player. */
const presenceEndpoint = () => `${wsBaseUrl()}/ws/pvp`

/**
 * Names the URL that was tried and the setting that decides it.
 *
 * Same shape as the wallet panel's API-base message on purpose: a player who
 * has misconfigured one has misconfigured both, and a chip that says only
 * "could not connect" leaves them with nowhere to look.
 */
function unreachableReason(): string {
  return API_IS_SAME_ORIGIN
    ? `Nothing answered at ${presenceEndpoint()}. This page came from ${API_ORIGIN}, and with no VITE_API_BASE_URL set the shared world is expected on that same origin — so either the API is not running (\`npm run server\`, which the dev server proxies to) or this host serves only the game files.`
    : `Nothing answered at ${presenceEndpoint()}. VITE_API_BASE_URL points the shared world at ${API_ORIGIN}.`
}

/**
 * Records a failed attempt.
 *
 * `retrying` is the honest part: it is whatever `schedule()` decided, not an
 * assumption, so the chip can never say "still trying" while nothing is.
 */
function noteFailure(reason: string) {
  const attempts = pvpState.link.attempts + 1
  pvpState.link = {
    phase: attempts >= FAILURES_BEFORE_OFFLINE ? 'offline' : 'retrying',
    attempts,
    reason,
    retrying: !stopped,
  }
}

/** Gives up, and says so. Only for failures that retrying cannot fix. */
function stopTrying(reason: string) {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
  pvpState.link = { phase: 'offline', attempts: Math.max(1, pvpState.link.attempts), reason, retrying: false }
}

/**
 * Replaces a session the server refused, once.
 *
 * The token in localStorage is only meaningful while the server still holds its
 * row; a restart on another database leaves one that looks valid here and is
 * unknown there. Discarding it means the next attempt mints a fresh one through
 * the normal route. A second refusal is not the token's fault, and pretending
 * otherwise would be an infinite loop wearing a spinner.
 */
function repairSession(detail: string) {
  if (sessionReplaced) {
    stopTrying(
      `${API_ORIGIN} refused this browser's session for the shared world, and refused a freshly issued one too. ${detail}`,
    )
    return
  }
  sessionReplaced = true
  const discarded = forgetPresenceAuth()
  serverReason =
    discarded === 'wallet'
      ? `The signed-in session had expired at ${API_ORIGIN}. Rejoining as a guest; reconnect the wallet from the wallet panel.`
      : `The stored session had expired at ${API_ORIGIN}. Asking for a new one.`
}

/* ------------------------------------------------------------------ *
 * What may be installed as "the arena you are in".
 *
 * The test used to be the DUEL's phase: an `ended` snapshot was news that
 * the fight was over, so it was refused, and `pvpState.duel` was cleared.
 * That is no longer the same question. A match now settles while both
 * fighters are still standing on the floor reading the result and deciding
 * about another one, so `ended` is an ordinary state to be in and the
 * server keeps owning both positions through it.
 *
 * The state that means "you are out" is `arena.phase === 'closed'`, and the
 * server sets it on exactly one path — `retireDuel` — which runs from every
 * exit including a failed settlement and a shutdown drain. So that is the
 * only thing this client treats as the end.
 *
 * Two staleness guards, for the two ways a late frame can lie:
 *
 *   `closedArenaId` makes a replay of an instance we have left harmless. A
 *   `combat` frame already on the wire, or a snapshot resent after a
 *   reconnect, cannot put the player back onto a floor that is gone.
 *
 *   `matchNumber` makes a replay of an earlier MATCH harmless. One instance
 *   holds several, so a duel id is not enough: a frame from match one
 *   arriving during match two would otherwise reinstate the old HP bars.
 * ------------------------------------------------------------------ */

let closedArenaId: string | null = null

function liveDuel(snapshot: DuelSnapshot | null | undefined): DuelSnapshot | null {
  if (!snapshot) return null
  if (snapshot.arena.id === closedArenaId) return null
  if (snapshot.arena.phase === 'closed') {
    leaveArenaState(snapshot.arena.id)
    return null
  }
  const held = pvpState.duel
  if (held && held.arena.id === snapshot.arena.id && snapshot.arena.matchNumber < held.arena.matchNumber) {
    return null
  }
  return snapshot
}

/** Puts the player back in the world, whatever closed the arena. */
function leaveArenaState(arenaId: string | null) {
  if (arenaId) closedArenaId = arenaId
  pvpState.duel = null
  /*
   * The result is kept. Its buttons stop working when the instance goes, and
   * the card says so, but clearing it here meant the one player who most needs
   * to be told what happened never saw it: when an opponent drops for good, the
   * match settles and the sweep retires the arena in the same tick, so the card
   * appeared and was wiped inside 50ms. A new match clears it — see `duel`.
   */
  pvpState.surrenderAsk = false
  clearDuelCues()
}

function apply(msg: S2C) {
  lastServerMessageAt = Date.now()
  switch (msg.t) {
    case 'welcome':
      welcomed = true
      serverReason = null
      sessionReplaced = false
      pvpState.connected = true
      pvpState.signedIn = true
      pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: false }
      pvpState.superseded = false
      pvpState.playerId = msg.playerId
      pvpState.gold = msg.gold
      pvpState.self = msg.self
      pvpState.others = msg.others
      pvpState.incomingDisabled = msg.incomingDisabled
      pvpState.duel = liveDuel(msg.active)
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
    // Chat keeps its own log rather than living in `pvpState`, because the
    // whole PvP overlay re-renders on every presence tick and a chat backlog
    // does not want to be rebuilt twelve times a second.
    case 'chat':
      pushChatLine(msg.msg)
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
    case 'duel': {
      const live = liveDuel(msg.snapshot)
      if (!live) break
      pvpState.duel = live
      // A new match in the same instance clears the last one's result card,
      // so the rematch is not fought behind the numbers from the last round.
      if (pvpState.result && pvpState.result.duelId !== live.duelId) pvpState.result = null
      pvpState.inspect = null
      pvpState.composer = null
      pvpState.invite = null
      pvpState.outgoing = null
      break
    }
    case 'combat': {
      const live = liveDuel(msg.snapshot)
      if (!live) break
      pvpState.duel = live
      // Queued against the snapshot they arrived with, because that is where
      // the blows landed; by the next frame both fighters have moved.
      queueDuelCues(live, msg.events)
      break
    }
    case 'result':
      /*
       * The result is the end of the MATCH, not of the arena. `duel` is
       * deliberately left alone: the server sends a `results` snapshot with
       * it, both fighters stay on the floor, and what takes them off it is a
       * `closed` snapshot — from a rematch neither wanted, a leave, a drop, or
       * the results deadline. Every one of those is bounded on the server, so
       * nothing here is waiting on a button.
       */
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
      pvpState.link = { phase: 'offline', attempts: pvpState.link.attempts, reason: msg.detail, retrying: false }
      pvpState.error = msg.detail
      break
    case 'serverClosing':
      serverClosingUntil = Date.now() + msg.reconnectAfterMs
      serverReason = msg.detail
      break
    case 'error':
      // A refusal of the connection itself is not a gameplay error, and putting
      // it in the error banner said "Sign in first." over a world the player was
      // already standing in. It belongs to the connection state instead.
      if (msg.code === 'unauthenticated') {
        repairSession(msg.detail)
        break
      }
      if (msg.code === 'at_capacity') {
        serverReason = msg.detail
        break
      }
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

/* ------------------------------------------------------------------ *
 * Leaving on purpose.
 *
 * A clean close is the fast path: the server drops the player from the
 * town the instant it arrives, with no sweep involved. The problem is
 * that a browser being closed, or navigated away from, does not reliably
 * get one onto the wire — the socket is torn down with the page and the
 * server is left holding a connection it can only reap on a timer.
 *
 * `pagehide` is the event that fires for all of those, including the iOS
 * cases where nothing else does. `unload` is not used: it is skipped
 * outright in several browsers, and merely registering a listener for it
 * disqualifies the page from the back/forward cache, which would trade a
 * faster goodbye for a slower return.
 *
 * Which is the other half of this. `pagehide` does not mean gone —
 * `persisted` says the page went into the bfcache and may be restored. So
 * the close here is deliberate and the reconnect on `pageshow` is what
 * makes it safe: the character is given up on the way out and taken back
 * on the way in, which is the ordinary supersede path and not a new one.
 * ------------------------------------------------------------------ */

/** True while this tab has handed its character back at `pagehide`. */
let parked = false

let pageLifecycleBound = false

function leaveForPageHide() {
  const going = socket
  if (!going) return
  stopHeartbeat()
  if (timer) clearTimeout(timer)
  timer = null
  socket = null
  // This close was chosen, so it must not be read as a drop: the ordinary
  // handler would schedule a reconnect and file a failed attempt against a
  // page that is no longer there.
  going.onclose = null
  going.onerror = null
  try {
    going.close(1000, 'pagehide')
  } catch {
    /* the page is going away regardless */
  }
  parked = true
  pvpState.connected = false
}

function returnFromPageShow(persisted: boolean) {
  if (!parked) return
  parked = false
  // A non-persisted `pageshow` is a fresh document; this module was reloaded
  // with it and `startPvp` will run again on its own.
  if (!persisted) return
  if (!hello || superseded || stopped) return
  retries = 0
  pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: false }
  pingPvp()
  void open()
}

function bindPageLifecycle() {
  if (pageLifecycleBound || typeof window === 'undefined') return
  pageLifecycleBound = true
  window.addEventListener('pagehide', () => leaveForPageHide())
  window.addEventListener('pageshow', event => returnFromPageShow(event.persisted))
}

async function open() {
  if (!hello) {
    pvpState.connected = false
    pingPvp()
    return
  }
  if (superseded || stopped) return
  if (opening) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  opening = true
  const auth = await resolvePresenceAuth()
  opening = false
  pvpState.signedIn = Boolean(auth)
  if (!auth) {
    // No socket is created here, so no close handler will run and nothing else
    // would ever mark this attempt as failed. This is the path that left the
    // chip reading "Joining the shared town…" with nothing behind it.
    schedule()
    noteFailure(presenceAuthProblem() ?? `Could not get a session for the shared world from ${API_ORIGIN}.`)
    pingPvp()
    return
  }
  welcomed = false
  sawOpen = false
  try {
    socket = new WebSocket(wsUrl(auth.token))
  } catch (error) {
    schedule()
    noteFailure(`${presenceEndpoint()} is not a usable WebSocket URL (${error instanceof Error ? error.message : String(error)}).`)
    pingPvp()
    return
  }
  socket.onopen = () => {
    sawOpen = true
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
    const wasWelcomed = welcomed
    pvpState.connected = false
    socket = null
    if (!superseded && !stopped) {
      schedule()
      // A welcomed connection that closed is a drop, and the count restarts:
      // the player was in the world a moment ago, so this is attempt one of a
      // recovery rather than the fifth failure of a join that never worked.
      if (wasWelcomed) pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: true }
      noteFailure(serverReason ?? (sawOpen ? `${presenceEndpoint()} accepted the connection and then closed it without letting this character in.` : unreachableReason()))
      serverReason = null
    }
    pingPvp()
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
  if (timer || superseded || stopped) return
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
  bindPageLifecycle()
  hello = { displayName, loadout }
  retries = 0
  parked = false
  superseded = false
  stopped = false
  sessionReplaced = false
  serverReason = null
  pvpState.superseded = false
  pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: false }
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
 * The player asking, from the offline chip, to try the shared world again.
 *
 * Distinct from the automatic retry: it clears the give-up flag and the attempt
 * count, so a configuration that has since been fixed — the API started, the
 * network back — is picked up immediately instead of waiting out a backoff.
 */
export function retryPvp() {
  if (!hello) return
  stopped = false
  sessionReplaced = false
  serverReason = null
  retries = 0
  if (timer) clearTimeout(timer)
  timer = null
  pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: false }
  pingPvp()
  void open()
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
  stopped = false
  pvpState.superseded = false
  pvpState.error = null
  pvpState.link = { phase: 'connecting', attempts: 0, reason: null, retrying: false }
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
