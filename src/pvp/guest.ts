import { API_BASE_URL, API_ORIGIN } from '../solana/cluster'
import { clearSession, loadSession } from '../solana/api'

const GUEST_KEY = 'wally-guest-v1'
const GUEST_SESSION = 'wally-guest-session-v1'

export type PresenceAuth = {
  token: string
  expiresAtMs: number
  guest: boolean
}

function randomKey() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Stable per-browser secret. Same reload = same person. Another browser = someone else. */
export function guestKey(): string {
  try {
    const existing = localStorage.getItem(GUEST_KEY)
    if (existing && /^[0-9a-f]{64}$/i.test(existing)) return existing.toLowerCase()
    const next = randomKey()
    localStorage.setItem(GUEST_KEY, next)
    return next
  } catch {
    return randomKey()
  }
}

function readGuestSession(): PresenceAuth | null {
  try {
    const raw = localStorage.getItem(GUEST_SESSION)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PresenceAuth>
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAtMs !== 'number') return null
    if (parsed.expiresAtMs <= Date.now() + 60_000) {
      localStorage.removeItem(GUEST_SESSION)
      return null
    }
    return { token: parsed.token, expiresAtMs: parsed.expiresAtMs, guest: true }
  } catch {
    return null
  }
}

function writeGuestSession(session: PresenceAuth) {
  try {
    localStorage.setItem(GUEST_SESSION, JSON.stringify(session))
  } catch {
    /* private mode */
  }
}

/**
 * Why the last attempt to get a session failed, in words a player can act on.
 *
 * Kept here rather than thrown, because every caller of `resolvePresenceAuth`
 * treats "no session" the same way and only the presence chip wants to say why.
 */
let lastProblem: string | null = null

export const presenceAuthProblem = () => lastProblem

/**
 * In-flight mint, shared by every caller.
 *
 * Entering the world starts three things that all want a session — the presence
 * socket, the wallet link, and the gold sync — and on a cold start none of them
 * finds a cached one. Without this they minted three sessions each time the
 * world was entered, which is three rows and three hits against the auth
 * budget for one player; a few reloads exhausted it and the socket could no
 * longer get a session at all.
 */
let minting: Promise<PresenceAuth | null> | null = null

/**
 * Wallet session if Phantom already signed in, otherwise a guest session
 * minted from the browser's stored key. Never asks for a seed phrase.
 */
export async function resolvePresenceAuth(): Promise<PresenceAuth | null> {
  const wallet = loadSession()
  if (wallet) return { token: wallet.token, expiresAtMs: wallet.expiresAtMs, guest: false }

  const cached = readGuestSession()
  if (cached) return cached

  minting ??= mintGuestSession().finally(() => {
    minting = null
  })
  return minting
}

async function mintGuestSession(): Promise<PresenceAuth | null> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/pvp/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestKey: guestKey() }),
    })
  } catch (error) {
    lastProblem =
      `Could not reach ${API_ORIGIN}/api/pvp/guest to get a session for the shared world ` +
      `(${error instanceof Error ? error.message : String(error)}).`
    return null
  }
  if (response.status === 429) {
    lastProblem = `${API_ORIGIN} is rate-limiting sign-ins from this browser, so no session could be issued yet.`
    return null
  }
  let body: { token?: string; expiresAtMs?: number } = {}
  try {
    body = await response.json() as typeof body
  } catch {
    /* handled below: a non-JSON answer is not this API */
  }
  if (!response.ok || typeof body.token !== 'string' || typeof body.expiresAtMs !== 'number') {
    lastProblem = `${API_ORIGIN}/api/pvp/guest answered ${response.status} instead of a session for the shared world.`
    return null
  }
  const session = { token: body.token, expiresAtMs: body.expiresAtMs, guest: true }
  writeGuestSession(session)
  lastProblem = null
  return session
}

/**
 * Throws away the token the server just refused.
 *
 * A session token is only valid as long as the server still holds its row, and
 * the browser cannot tell from the outside when that stops being true — a
 * restart on a different database, or a swept expiry, leaves a token that looks
 * perfectly good here and means nothing there. Without this the client replayed
 * the dead token on every reconnect forever, so the socket opened, was refused,
 * and the player watched "Joining the shared town…" for the rest of the session.
 *
 * Only the client's own cache is cleared. The server's check is untouched: the
 * next attempt has to earn a session through `/api/pvp/guest` like any other.
 */
export function forgetPresenceAuth(): 'wallet' | 'guest' | 'none' {
  const wallet = loadSession()
  if (wallet) {
    // The wallet session is the one being refused, so it is no more usable than
    // a guest one. Dropping it lets the next attempt fall back to a guest
    // session and stand in the town; reconnecting Phantom is a click away.
    clearSession()
    return 'wallet'
  }
  try {
    const had = localStorage.getItem(GUEST_SESSION) !== null
    localStorage.removeItem(GUEST_SESSION)
    return had ? 'guest' : 'none'
  } catch {
    return 'none'
  }
}

export function presenceTokenSync(): string | null {
  const wallet = loadSession()
  if (wallet) return wallet.token
  return readGuestSession()?.token ?? null
}
