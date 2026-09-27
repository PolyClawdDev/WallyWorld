import { API_BASE_URL } from '../solana/cluster'
import { loadSession } from '../solana/api'

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
 * Wallet session if Phantom already signed in, otherwise a guest session
 * minted from the browser's stored key. Never asks for a seed phrase.
 */
export async function resolvePresenceAuth(): Promise<PresenceAuth | null> {
  const wallet = loadSession()
  if (wallet) return { token: wallet.token, expiresAtMs: wallet.expiresAtMs, guest: false }

  const cached = readGuestSession()
  if (cached) return cached

  try {
    const response = await fetch(`${API_BASE_URL}/api/pvp/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestKey: guestKey() }),
    })
    const body = await response.json() as { token?: string; expiresAtMs?: number }
    if (!response.ok || typeof body.token !== 'string' || typeof body.expiresAtMs !== 'number') return null
    const session = { token: body.token, expiresAtMs: body.expiresAtMs, guest: true }
    writeGuestSession(session)
    return session
  } catch {
    return null
  }
}

export function presenceTokenSync(): string | null {
  const wallet = loadSession()
  if (wallet) return wallet.token
  return readGuestSession()?.token ?? null
}
