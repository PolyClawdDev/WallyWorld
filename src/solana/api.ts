/* ------------------------------------------------------------------ *
 * Typed client for the Wally World API.
 *
 * The only credential this module handles is an opaque session bearer
 * token issued after a wallet signature. It is not a key, it cannot sign
 * anything, and it grants access to one wallet's game record and nothing
 * else.
 *
 * Tradeoff worth naming: the token is kept in localStorage so a page
 * reload does not demand a fresh Phantom signature. That means script
 * injection on this origin could steal a session. It could not steal a
 * key — the key is never here — and a stolen session can read and write a
 * character record, not move funds. A cookie would need SameSite=None and
 * Secure to work across the dev ports, which plain http cannot do.
 * ------------------------------------------------------------------ */

import { API_BASE_URL } from './cluster'
import type { Profile } from '../shared/profile'
import type { SiwsFields } from '../shared/siws'

const SESSION_KEY = 'wally-session-v1'

export type StoredSession = { token: string; wallet: string; expiresAtMs: number }

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (typeof parsed.token !== 'string' || typeof parsed.wallet !== 'string' || typeof parsed.expiresAtMs !== 'number') return null
    if (parsed.expiresAtMs <= Date.now()) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return { token: parsed.token, wallet: parsed.wallet, expiresAtMs: parsed.expiresAtMs }
  } catch {
    return null
  }
}

export function saveSession(session: StoredSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* nothing to clear */
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
  /** True when the session is gone or was never valid, so the UI can re-prompt sign-in. */
  get needsSignIn() {
    return this.status === 401
  }
}

async function call<T>(path: string, options: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers.Authorization = `Bearer ${options.token}`

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, 'network_error', `Cannot reach the Wally World API at ${API_BASE_URL}. Is \`npm run server\` running?`)
  }

  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ApiError(response.status, 'bad_response', 'The API returned a response that was not JSON.')
    }
  }

  if (!response.ok) {
    const body = (parsed ?? {}) as { error?: string; detail?: string }
    throw new ApiError(response.status, body.error ?? 'error', body.detail ?? body.error ?? `Request failed (${response.status}).`)
  }
  return parsed as T
}

/* ------------------------------------------------------------------ auth */

export const requestChallenge = (publicKey: string) =>
  call<{ challenge: SiwsFields }>('/api/auth/nonce', { method: 'POST', body: { publicKey } })

export const submitSignature = (publicKey: string, nonce: string, signature: string) =>
  call<{ token: string; expiresAtMs: number; wallet: string; profile: Profile }>('/api/auth/verify', {
    method: 'POST',
    body: { publicKey, nonce, signature },
  })

export const logout = (token: string) => call<{ ok: true }>('/api/auth/logout', { method: 'POST', token })

/* --------------------------------------------------------------- profile */

export const fetchProfile = (token: string) =>
  call<{ profile: Profile | null; updatedAtMs: number | null }>('/api/profile', { token })

export const saveProfile = (token: string, profile: Profile) =>
  call<{ profile: Profile; updatedAtMs: number }>('/api/profile', { method: 'PUT', body: { profile }, token })

/* -------------------------------------------------------------- payments */

export type Quote =
  | { available: true; service: string; label: string; recipient: string; lamports: string; cluster: string }
  | { available: false; reason: string }

export const fetchQuote = (token: string) => call<Quote>('/api/payments/quote', { token })

export type ReceiptView = {
  signature: string
  service: string
  recipient: string
  lamports: string
  cluster: string
  status: 'submitted' | 'confirmed' | 'failed' | 'unknown'
  detail: string | null
  createdAtMs: number
  confirmedAtMs: number | null
}

/** Safe to retry: the server keys receipts on the signature. */
export const postReceipt = (token: string, signature: string) =>
  call<{ receipt: ReceiptView; idempotent: boolean }>('/api/payments/receipt', { method: 'POST', body: { signature }, token })

export const recheckReceipt = (token: string, signature: string) =>
  call<{ receipt: ReceiptView }>('/api/payments/recheck', { method: 'POST', body: { signature }, token })

export const fetchReceipts = (token: string) => call<{ receipts: ReceiptView[] }>('/api/payments/receipts', { token })

/* ---------------------------------------------------------------- status */

export type Health = {
  ok: boolean
  cluster: string
  chainId: string
  rpcReachable: boolean
  rpcDetail: string
  persistence: string
  paymentsEnabled: boolean
  payoutsEnabled: false
  custody: string
}

export const fetchHealth = () => call<Health>('/api/health')

export const fetchPayoutStatus = () =>
  call<{ enabled: false; status: string; reason: string }>('/api/payouts/status')
