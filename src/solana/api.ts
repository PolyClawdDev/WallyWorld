/* ------------------------------------------------------------------ *
 * Typed client for the Voxels API.
 *
 * This module handles no key material and no signing capability. The one
 * credential it touches is an opaque session bearer token, which cannot
 * sign anything and grants access to one account's game record.
 *
 * NOTE ON THE SESSION HELPERS BELOW. Nothing in this client issues a
 * wallet session any more: `POST /api/auth/nonce` + `/api/auth/verify`
 * were driven by the Phantom sign-in button, and that is gone. The
 * server routes remain and `scripts/verify-solana.ts` still exercises
 * them, but no browser code calls them, so there is no `saveSession` here
 * any more either.
 *
 * `loadSession` stays because a session minted by the old Phantom sign-in
 * can still be live in a returning player's browser, and
 * `src/pvp/guest.ts` prefers it over minting a guest one for as long as it
 * lasts. Those keys drain on their own as the sessions expire.
 *
 * Tradeoff worth naming: the token is in localStorage, so script injection
 * on this origin could steal a session. A stolen session can read and
 * write a character record; it cannot move funds, because nothing in this
 * client can.
 * ------------------------------------------------------------------ */

import { API_BASE_URL, API_IS_SAME_ORIGIN, API_ORIGIN, RPC_PROXY_URL } from './cluster'

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

/* ---------------------------------------------------------------- status */

export type Health = {
  ok: boolean
  cluster: string
  chainId: string
  rpcReachable: boolean
  rpcDetail: string
  persistence: string
  /** Always false, like `payoutsEnabled`: no client path can sign a transfer. */
  paymentsEnabled: false
  payoutsEnabled: false
  custody: string
}

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
