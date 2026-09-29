/* ------------------------------------------------------------------ *
 * Typed client for the Voxels API.
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

import { API_BASE_URL, API_IS_SAME_ORIGIN, API_ORIGIN, RPC_PROXY_URL } from './cluster'
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
    throw new ApiError(0, 'network_error', `Cannot reach the Voxels API at ${API_ORIGIN}. Is \`npm run server\` running?`)
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

/* ------------------------------------------------------------------ *
 * Is this origin actually serving the Voxels API?
 *
 * By default the client addresses its own page origin, which is right for
 * every deployment that serves the game and the API together and right for the
 * dev server, which proxies `/api`. It is wrong for a static host — Vercel,
 * Netlify, GitHub Pages, `python -m http.server` — which answers `/api/rpc`
 * with its own 404 page. @solana/web3.js turns a non-2xx into
 * `new Error(`${status} ${statusText}: ${body}`)`, so the player was shown a
 * chunk of somebody else's 404 page ("404 : The page could not be found
 * NOT_FOUND arn1::…") with no hint that it was a deployment problem.
 *
 * So the API is identified before it is trusted: `/api/health` must answer
 * with JSON carrying this server's own `cluster` and `chainId`. Anything else
 * is a misconfiguration, and it is reported as one, naming the URL that was
 * tried.
 * ------------------------------------------------------------------ */

export type ApiProbe =
  | { ok: true; cluster: string; chainId: string }
  | { ok: false; kind: 'unreachable' | 'not_the_api'; detail: string }

/** First line of a foreign error page, for the report. Never more than this. */
const snippet = (text: string) =>
  text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

/**
 * Which URLs the probe is talking about.
 *
 * Defaulted from the module constants, which is what the app uses, and passed
 * explicitly by `scripts/test-client-config.ts` so several deployment shapes
 * can be exercised in one process.
 */
export type ApiTarget = { base: string; origin: string; sameOrigin: boolean; rpcUrl: string }

const defaultTarget = (): ApiTarget => ({
  base: API_BASE_URL,
  origin: API_ORIGIN,
  sameOrigin: API_IS_SAME_ORIGIN,
  rpcUrl: RPC_PROXY_URL,
})

function misconfigured(target: ApiTarget, what: string): { ok: false; kind: 'not_the_api'; detail: string } {
  const where = target.sameOrigin
    ? `This page was served from ${target.origin}, and with no VITE_API_BASE_URL set the client asks that same origin for the API. It is serving the game files but not the API.`
    : `VITE_API_BASE_URL points the client at ${target.origin}, and nothing there is answering as the Voxels API.`
  return {
    ok: false,
    kind: 'not_the_api',
    detail:
      `Tried ${target.rpcUrl} and ${target.origin}/api/health. ${what} ${where} ` +
      'This is a configuration problem, not a wallet problem: either run the API on this origin (`npm run server`, which the dev server proxies to), or rebuild with VITE_API_BASE_URL set to wherever the API is deployed.',
  }
}

export async function probeApi(target: ApiTarget = defaultTarget()): Promise<ApiProbe> {
  let response: Response
  try {
    response = await fetch(`${target.base}/api/health`, { headers: { Accept: 'application/json' } })
  } catch (error) {
    return {
      ok: false,
      kind: 'unreachable',
      detail: `Tried ${target.origin}/api/health and the request did not complete (${error instanceof Error ? error.message : String(error)}). Is the API running, and does CORS allow this page?`,
    }
  }

  const text = await response.text()
  if (!response.ok) {
    return misconfigured(target, `It answered ${response.status}${text ? ` ("${snippet(text)}")` : ''} instead of the Voxels health record.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return misconfigured(target, `It answered 200 with something that is not JSON ("${snippet(text)}").`)
  }

  const body = (parsed ?? {}) as Partial<Health>
  if (typeof body.cluster !== 'string' || typeof body.chainId !== 'string') {
    return misconfigured(target, 'It answered with JSON that is not a Voxels health record.')
  }
  return { ok: true, cluster: body.cluster, chainId: body.chainId }
}

export const fetchPayoutStatus = () =>
  call<{ enabled: false; status: string; reason: string }>('/api/payouts/status')
