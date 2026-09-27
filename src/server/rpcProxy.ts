/* ------------------------------------------------------------------ *
 * JSON-RPC proxy.
 *
 * The browser must never hold the RPC endpoint URL, because for providers
 * like QuickNode that URL *is* the access token. So the client points at
 * this route instead and the server forwards the call, keeping the
 * credential server-side.
 *
 * This is deliberately not an open relay. A public proxy in front of a
 * paid endpoint gets found and drained, so:
 *
 *   - only the methods the app actually calls are forwarded, by name;
 *   - `requestAirdrop` is allowed on test clusters only;
 *   - expensive whole-block and full-history scans are not forwarded at
 *     all, since one such call can cost more than thousands of balance
 *     reads;
 *   - batches are capped, bodies are capped, and upstream calls time out;
 *   - the response is passed through the secret scrubber, so even an
 *     upstream error that quotes the endpoint cannot reach the caller.
 *
 * Rate limiting and CORS are applied by the caller in index.ts.
 * ------------------------------------------------------------------ */

import { IS_MAINNET, RPC_URL } from './config'
import { describeUpstreamError, redactDeep } from './redact'

/**
 * Exactly what the client needs, and nothing else.
 *
 * Reads for the wallet panel, plus the pieces required to build, submit and
 * confirm a transfer. Anything absent from this list is refused, which means a
 * new client feature has to be a deliberate addition here.
 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  // cluster identity and liveness
  'getGenesisHash',
  'getVersion',
  'getSlot',
  'getBlockHeight',
  // balances
  'getBalance',
  'getAccountInfo',
  'getTokenAccountsByOwner',
  'getTokenAccountBalance',
  // building a transfer
  'getLatestBlockhash',
  'isBlockhashValid',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  // submitting and confirming
  'sendTransaction',
  'simulateTransaction',
  'getSignatureStatuses',
  'getTransaction',
])

/** Faucet calls are meaningless on mainnet and would just burn quota. */
const TEST_CLUSTER_ONLY: ReadonlySet<string> = new Set(['requestAirdrop'])

const MAX_BATCH = 10
const UPSTREAM_TIMEOUT_MS = 15_000
/** Generous enough for a jsonParsed token-account list, small enough to bound abuse. */
const MAX_UPSTREAM_BYTES = 6 * 1024 * 1024

export function isMethodAllowed(method: string): boolean {
  if (ALLOWED_METHODS.has(method)) return true
  return !IS_MAINNET && TEST_CLUSTER_ONLY.has(method)
}

/** The list the health endpoint advertises, so a client can see what it may call. */
export const allowedMethodNames = (): string[] =>
  [...ALLOWED_METHODS, ...(IS_MAINNET ? [] : TEST_CLUSTER_ONLY)].sort()

type RpcCall = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export type ProxyOutcome =
  | { status: number; body: unknown }

/** Mirrors the JSON-RPC error shape so web3.js surfaces something sensible. */
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

function validateCall(call: unknown): { ok: true; method: string; id: unknown } | { ok: false; id: unknown; reason: string } {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return { ok: false, id: null, reason: 'each request must be a JSON-RPC object' }
  const entry = call as RpcCall
  const id = entry.id ?? null
  if (typeof entry.method !== 'string') return { ok: false, id, reason: 'method must be a string' }
  if (entry.params !== undefined && !Array.isArray(entry.params) && typeof entry.params !== 'object') {
    return { ok: false, id, reason: 'params must be an array or object' }
  }
  if (!isMethodAllowed(entry.method)) {
    // Naming the method is fine; it tells an honest client what went wrong and
    // reveals nothing about the endpoint.
    return { ok: false, id, reason: `method "${entry.method}" is not permitted through this proxy` }
  }
  return { ok: true, method: entry.method, id }
}

/**
 * Forwards a validated JSON-RPC payload upstream.
 *
 * Every failure path returns a scrubbed message. The upstream URL is not in the
 * error text, not in the body, and not in any header we copy — no upstream
 * headers are copied at all.
 */
export async function proxyRpc(body: unknown): Promise<ProxyOutcome> {
  const isBatch = Array.isArray(body)
  const calls = isBatch ? body : [body]

  if (calls.length === 0) return { status: 400, body: rpcError(null, -32600, 'empty request') }
  if (calls.length > MAX_BATCH) {
    return { status: 413, body: rpcError(null, -32600, `batch of ${calls.length} exceeds the limit of ${MAX_BATCH}`) }
  }

  // Validate every entry before anything is forwarded: one disallowed method in
  // a batch rejects the whole batch rather than partially spending quota.
  const rejections: unknown[] = []
  for (const call of calls) {
    const checked = validateCall(call)
    if (!checked.ok) rejections.push(rpcError(checked.id, -32601, checked.reason))
  }
  if (rejections.length > 0) {
    return { status: 403, body: isBatch ? rejections : rejections[0] }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      // Only a content type goes up. No client headers are forwarded, so a
      // caller cannot smuggle anything to the provider.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const declared = Number(upstream.headers.get('content-length') ?? '0')
    if (declared > MAX_UPSTREAM_BYTES) {
      return { status: 502, body: rpcError(null, -32603, 'upstream response too large') }
    }

    const text = await upstream.text()
    if (text.length > MAX_UPSTREAM_BYTES) {
      return { status: 502, body: rpcError(null, -32603, 'upstream response too large') }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A provider error page (HTML for a bad token, for instance) must not be
      // passed through, since it can name the endpoint or the account.
      return { status: 502, body: rpcError(null, -32603, 'upstream returned a non-JSON response') }
    }

    // Upstream JSON-RPC errors can quote the request URL; scrub before relaying.
    // The upstream HTTP status is intentionally not mirrored for auth failures:
    // a 401 from the provider is our configuration problem, not the caller's.
    const status = upstream.ok ? 200 : upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status
    return { status, body: redactDeep(parsed) }
  } catch (error) {
    const detail = describeUpstreamError(error)
    const aborted = controller.signal.aborted
    return {
      status: aborted ? 504 : 502,
      body: rpcError(null, -32603, aborted ? 'upstream RPC timed out' : `upstream RPC request failed: ${detail}`),
    }
  } finally {
    clearTimeout(timer)
  }
}
