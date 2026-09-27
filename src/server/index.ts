/* ------------------------------------------------------------------ *
 * Wally World API.
 *
 * Replaces the previous in-memory demo with durable SQLite storage,
 * Sign-In With Solana authentication, and server-verified payment
 * receipts.
 *
 * Security posture:
 *   - No private key, seed phrase, or signing capability exists in this
 *     process. It verifies signatures and reads the chain; it cannot move
 *     anyone's funds, including its own, because it has none.
 *   - Every record is scoped to the wallet on the session. A handler never
 *     takes a wallet address from the request body to decide what to read
 *     or write, only from `requireWallet`.
 *   - All input is validated against a whitelist before it is stored.
 *   - CORS is an explicit origin allowlist, not `*`, and auth is a bearer
 *     token rather than a cookie, so there is no CSRF surface.
 * ------------------------------------------------------------------ */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
// Imported explicitly: the DOM lib is in scope for this project, and its timer
// overloads return a number without `unref`.
import { setInterval, setTimeout } from 'node:timers'
import { validateProfile, DEFAULT_PROFILE } from '../shared/profile'
import { looksLikeAddress } from '../shared/siws'
import {
  ALLOWED_ORIGINS,
  CHAIN_ID,
  CLUSTER,
  NPC_PAYEE_ADDRESS,
  PAYMENTS_ENABLED,
  PAYOUTS_ENABLED,
  PORT,
  RPC_IS_PUBLIC,
  RPC_SOURCE_VAR,
  SERVICE_PRICE_LAMPORTS,
  SESSION_TTL_MS,
} from './config'
import { createSession, issueChallenge, isAllowedDomain, revokeFromAuthHeader, verifySignIn, walletFromAuthHeader } from './auth'
import {
  advanceDemoTask,
  createDemoTask,
  listReceipts,
  readDemoTask,
  readProfile,
  readReceipt,
  recordReceipt,
  setReceiptStatus,
  sweepExpired,
  writeProfile,
  type ReceiptRow,
  type ReceiptStatus,
} from './db'
import { verifyClusterIdentity, verifyTransfer } from './chain'
import { allowedMethodNames, proxyRpc } from './rpcProxy'
import { redact, safeError, safeLog } from './redact'

const MAX_BODY_BYTES = 32 * 1024
/** Read-and-discard ceiling above the cap, so an oversized request still gets a 413. */
const DRAIN_LIMIT_BYTES = 1024 * 1024
const SERVICE_ID = 'archivist.town-history-brief'
const SERVICE_LABEL = 'Town history brief · The Archive'

/* ------------------------------------------------------------------ http */

type Json = Record<string, unknown> | Array<unknown>

/**
 * The single writer for every response body.
 *
 * Serialising first and scrubbing the finished string means the RPC endpoint
 * cannot escape through any route, however deeply it was nested or whichever
 * library put it there — `@solana/web3.js` and `fetch` both quote the endpoint
 * in their error messages, and those messages end up inside receipt details and
 * health payloads. Doing it here rather than at each call site makes the safe
 * behaviour the default instead of something to remember.
 */
function send(res: ServerResponse, status: number, body: Json) {
  const payload = redact(JSON.stringify(body))
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.end(payload)
}

const fail = (res: ServerResponse, status: number, error: string, detail?: string) =>
  send(res, status, detail ? { error, detail } : { error })

/** Echoes the origin only when it is on the allowlist, so the header is never `*`. */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return true // same-origin or non-browser caller; no CORS headers needed
  if (!ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''))) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '600')
  return true
}

type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; reason: string }

/**
 * Reads a JSON body under a hard byte cap.
 *
 * Over the cap, the remainder is drained up to a second, larger ceiling rather
 * than the socket being destroyed outright: draining lets the client receive a
 * real 413 instead of a connection reset it cannot interpret. Only a body that
 * blows past the drain ceiling gets the socket torn down.
 */
async function readJson(req: IncomingMessage, options: { allowArray?: boolean } = {}): Promise<BodyResult> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
  if (type && type !== 'application/json') return { ok: false, status: 415, reason: 'expected application/json' }

  const chunks: Buffer[] = []
  let size = 0
  let overflowed = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      overflowed = true
      if (size > DRAIN_LIMIT_BYTES) {
        req.destroy()
        return { ok: false, status: 413, reason: `request body exceeds ${MAX_BODY_BYTES} bytes` }
      }
      continue
    }
    chunks.push(buffer)
  }
  if (overflowed) return { ok: false, status: 413, reason: `request body exceeds ${MAX_BODY_BYTES} bytes` }

  if (!size) return { ok: true, body: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, status: 400, reason: 'body must be a JSON object' }
    }
    // JSON-RPC batches are arrays, so the proxy route opts in; every other route
    // wants an object and rejecting an array keeps their handlers simple.
    if (Array.isArray(parsed) && !options.allowArray) {
      return { ok: false, status: 400, reason: 'body must be a JSON object' }
    }
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, status: 400, reason: 'body is not valid JSON' }
  }
}

/** Sends the status `readJson` chose, so 413 and 415 are not flattened into 400. */
const failBody = (res: ServerResponse, result: { status: number; reason: string }) =>
  fail(res, result.status, result.status === 413 ? 'payload_too_large' : result.status === 415 ? 'unsupported_media_type' : 'bad_request', result.reason)

/**
 * Fixed-window request cap per client address. Crude but real: it keeps nonce
 * issuance and signature verification from being used as a free oracle or a
 * cheap way to fill the database.
 */
const RATE_LIMIT = { windowMs: 60_000, max: 120 }

/**
 * The RPC proxy gets its own, separate budget.
 *
 * It needs a higher ceiling than the rest of the API, because a single panel
 * render legitimately issues several reads and the balance refreshes on demand —
 * but it is also the only route that costs the operator money per call, so it
 * must not share a bucket with cheap local endpoints.
 */
const RPC_RATE_LIMIT = { windowMs: 60_000, max: 240 }

const buckets = new Map<string, { count: number; resetAt: number }>()

function overBudget(key: string, limit: { windowMs: number; max: number }): boolean {
  const now = Date.now()
  const entry = buckets.get(key)
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
    return false
  }
  entry.count += 1
  return entry.count > limit.max
}

const clientKey = (req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown'

const rateLimited = (req: IncomingMessage) => overBudget(`api:${clientKey(req)}`, RATE_LIMIT)

/**
 * Per session when the caller has one, per address otherwise.
 *
 * Balances are shown before sign-in, so the proxy cannot require a session; an
 * address bucket is the fallback. Keying signed-in traffic by session means one
 * busy player cannot exhaust the budget for everyone behind the same NAT.
 */
function rpcRateLimited(req: IncomingMessage): boolean {
  const wallet = walletFromAuthHeader(req.headers.authorization)
  return overBudget(wallet ? `rpc:session:${wallet}` : `rpc:ip:${clientKey(req)}`, RPC_RATE_LIMIT)
}

/** Expired buckets would otherwise accumulate for every address ever seen. */
function sweepBuckets(now = Date.now()) {
  for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key)
}

/* ------------------------------------------------------------------ auth */

function requireWallet(req: IncomingMessage, res: ServerResponse): string | null {
  const wallet = walletFromAuthHeader(req.headers.authorization)
  if (!wallet) {
    fail(res, 401, 'unauthenticated', 'Sign in with your wallet first.')
    return null
  }
  return wallet
}

/**
 * The domain and URI that end up inside the signed message come from the
 * request's own Origin header, checked against the allowlist. They are never
 * taken from the request body, so a caller cannot ask to be issued a challenge
 * bound to somebody else's site.
 */
function originContext(req: IncomingMessage): { domain: string; uri: string } | null {
  const origin = req.headers.origin?.replace(/\/+$/, '')
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return null
  try {
    const url = new URL(origin)
    return isAllowedDomain(url.host) ? { domain: url.host, uri: origin } : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------- payments */

const receiptView = (row: ReceiptRow) => ({
  signature: row.signature,
  service: row.service,
  recipient: row.recipient,
  lamports: row.lamports,
  cluster: row.cluster,
  status: row.status,
  detail: row.detail,
  createdAtMs: row.created_at_ms,
  confirmedAtMs: row.confirmed_at_ms,
})

/**
 * Asks the chain what really happened and moves the receipt to match.
 *
 * `unknown` is deliberately preserved rather than collapsed into success or
 * failure: a signature the cluster has not seen yet may still land, and saying
 * either "paid" or "not paid" would be a guess. The row keeps its previous
 * status and the caller is told the truth.
 */
async function reconcile(row: ReceiptRow, wallet: string): Promise<ReceiptRow> {
  if (row.status === 'confirmed' || row.status === 'failed') return row
  const verdict = await verifyTransfer(row.signature, {
    payer: wallet,
    recipient: row.recipient,
    lamports: BigInt(row.lamports),
  })
  const next: ReceiptStatus | null =
    verdict.status === 'confirmed' ? 'confirmed'
    : verdict.status === 'failed' ? 'failed'
    : verdict.status === 'mismatch' ? 'failed'
    : 'unknown'
  const detail =
    verdict.status === 'confirmed' ? `confirmed in slot ${verdict.slot}` : verdict.detail

  if (next === 'unknown' && row.status === 'submitted') {
    // Keep 'submitted' so the UI can go on polling rather than presenting a
    // freshly sent payment as permanently indeterminate.
    setReceiptStatus(row.signature, 'submitted', detail)
  } else {
    setReceiptStatus(row.signature, next, detail)
  }
  return readReceipt(row.signature)!
}

/* ------------------------------------------------------------------ routes */

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method ?? 'GET'

  /* ---- RPC proxy -------------------------------------------------------- */
  if (path === '/api/rpc') {
    // POST only: a GET with params in the query string would land the call in
    // access logs and browser history.
    if (method !== 'POST') return fail(res, 405, 'method_not_allowed', 'The RPC proxy accepts POST only.')
    if (rpcRateLimited(req)) {
      res.setHeader('Retry-After', '60')
      return fail(res, 429, 'rate_limited', 'Too many RPC requests. Slow down.')
    }
    const parsed = await readJson(req, { allowArray: true })
    if (!parsed.ok) return failBody(res, parsed)
    const outcome = await proxyRpc(parsed.body)
    return send(res, outcome.status, outcome.body as Json)
  }

  /* ---- health ---------------------------------------------------------- */
  if (method === 'GET' && path === '/api/health') {
    const chain = await verifyClusterIdentity()
    return send(res, 200, {
      ok: true,
      cluster: CLUSTER,
      chainId: CHAIN_ID,
      rpcReachable: chain.ok,
      /**
       * Cluster name and genesis hash only. The endpoint URL is a credential and
       * is never reported here; `rpcEndpointSource` names the variable it was
       * read from, which is safe to disclose and is what an operator needs when
       * diagnosing a mismatch.
       */
      rpcDetail: chain.detail,
      rpcEndpointSource: RPC_SOURCE_VAR,
      rpcEndpointIsPublic: RPC_IS_PUBLIC,
      rpcProxy: '/api/rpc',
      rpcAllowedMethods: allowedMethodNames(),
      persistence: 'sqlite',
      auth: 'sign-in-with-solana',
      paymentsEnabled: PAYMENTS_ENABLED,
      /** Always false. Not switchable by configuration; see the README. */
      payoutsEnabled: PAYOUTS_ENABLED,
      custody: 'none — this server holds no keys and cannot sign',
    })
  }

  /* ---- sign-in --------------------------------------------------------- */
  if (method === 'POST' && path === '/api/auth/nonce') {
    const context = originContext(req)
    if (!context) return fail(res, 403, 'origin_not_allowed', 'This origin may not request a sign-in challenge.')
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const wallet = (parsed.body as { publicKey?: unknown }).publicKey
    if (!looksLikeAddress(wallet)) return fail(res, 400, 'bad_request', 'publicKey must be a base58 Solana address.')
    return send(res, 201, { challenge: issueChallenge(wallet, context.domain, context.uri) })
  }

  if (method === 'POST' && path === '/api/auth/verify') {
    if (!originContext(req)) return fail(res, 403, 'origin_not_allowed')
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const body = parsed.body as { publicKey?: unknown; nonce?: unknown; signature?: unknown }
    const outcome = verifySignIn({ wallet: body.publicKey, nonce: body.nonce, signature: body.signature })
    if (!outcome.ok) return fail(res, 401, 'sign_in_failed', outcome.reason)
    const session = createSession(outcome.wallet)
    // First sign-in gets a starting record so the client always has something to load.
    const stored = readProfile(outcome.wallet) ?? writeProfile(outcome.wallet, DEFAULT_PROFILE, CLUSTER)
    return send(res, 200, {
      token: session.token,
      expiresAtMs: session.expiresAtMs,
      ttlMs: SESSION_TTL_MS,
      wallet: outcome.wallet,
      profile: stored.profile,
    })
  }

  if (method === 'GET' && path === '/api/auth/me') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    return send(res, 200, { wallet, cluster: CLUSTER })
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    revokeFromAuthHeader(req.headers.authorization)
    return send(res, 200, { ok: true })
  }

  /* ---- profile --------------------------------------------------------- */
  if (path === '/api/profile' && (method === 'GET' || method === 'PUT')) {
    const wallet = requireWallet(req, res)
    if (!wallet) return

    if (method === 'GET') {
      const stored = readProfile(wallet)
      return send(res, 200, {
        profile: stored?.profile ?? null,
        updatedAtMs: stored?.updatedAtMs ?? null,
        // Restated on every read so a client cannot come to treat this as a balance.
        goldIsClientAsserted: true,
      })
    }

    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const check = validateProfile((parsed.body as { profile?: unknown }).profile)
    if (!check.ok) return fail(res, 422, 'invalid_profile', check.reason)
    // The wallet comes from the session, never from the body: there is no code
    // path by which one session can write another wallet's row.
    const stored = writeProfile(wallet, check.profile, CLUSTER)
    return send(res, 200, { profile: stored.profile, updatedAtMs: stored.updatedAtMs, goldIsClientAsserted: true })
  }

  /* ---- payments -------------------------------------------------------- */
  if (method === 'GET' && path === '/api/payments/quote') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    if (!PAYMENTS_ENABLED || !NPC_PAYEE_ADDRESS) {
      return send(res, 200, {
        available: false,
        reason: 'No NPC payee address is configured. Set NPC_PAYEE_ADDRESS on the server to enable service payments.',
      })
    }
    // The price and the recipient are decided here, not by the client.
    return send(res, 200, {
      available: true,
      service: SERVICE_ID,
      label: SERVICE_LABEL,
      recipient: NPC_PAYEE_ADDRESS,
      lamports: SERVICE_PRICE_LAMPORTS.toString(),
      cluster: CLUSTER,
    })
  }

  if (method === 'POST' && path === '/api/payments/receipt') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    if (!PAYMENTS_ENABLED || !NPC_PAYEE_ADDRESS) return fail(res, 409, 'payments_disabled')
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const signature = (parsed.body as { signature?: unknown }).signature
    // Signatures are 64 bytes in base58, so 86–88 characters.
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      return fail(res, 400, 'bad_request', 'signature must be a base58 transaction signature.')
    }

    const existing = readReceipt(signature)
    if (existing) {
      // Idempotent, and scoped: a signature already claimed by another wallet is
      // not readable or re-claimable here.
      if (existing.wallet !== wallet) return fail(res, 409, 'signature_already_recorded')
      return send(res, 200, { receipt: receiptView(await reconcile(existing, wallet)), idempotent: true })
    }

    const created = recordReceipt({
      signature,
      wallet,
      service: SERVICE_ID,
      recipient: NPC_PAYEE_ADDRESS,
      lamports: SERVICE_PRICE_LAMPORTS,
      cluster: CLUSTER,
      status: 'submitted',
      detail: 'awaiting on-chain confirmation',
    })
    return send(res, 201, { receipt: receiptView(await reconcile(created, wallet)), idempotent: false })
  }

  if (method === 'POST' && path === '/api/payments/recheck') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const signature = (parsed.body as { signature?: unknown }).signature
    if (typeof signature !== 'string') return fail(res, 400, 'bad_request', 'signature is required.')
    const row = readReceipt(signature)
    if (!row || row.wallet !== wallet) return fail(res, 404, 'not_found')
    return send(res, 200, { receipt: receiptView(await reconcile(row, wallet)) })
  }

  if (method === 'GET' && path === '/api/payments/receipts') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    return send(res, 200, { receipts: listReceipts(wallet).map(receiptView) })
  }

  /* ---- payouts: permanently unavailable -------------------------------- */
  if (method === 'GET' && path === '/api/payouts/status') {
    return send(res, 200, {
      enabled: PAYOUTS_ENABLED,
      status: 'UNAVAILABLE · NO VERIFIED ADAPTER CONFIGURED',
      reason:
        'Gold is accumulated by the browser and is therefore client-asserted, so it cannot authorise a payment out of a treasury. A real payout needs server-authoritative gameplay, a custodied treasury with key management, idempotent reconciliation against on-chain confirmation, and legal review. No WALLY token mint exists.',
    })
  }

  if (method === 'POST' && path.startsWith('/api/payouts')) {
    return fail(res, 501, 'not_implemented', 'Gold-to-token payout is not implemented. See /api/payouts/status.')
  }

  /* ---- legacy scripted demo task, now restart-safe --------------------- */
  if (method === 'POST' && path === '/api/tasks') {
    const id = `demo_${randomUUID()}`
    const task = createDemoTask(id, 2)
    // Same scripted cadence as before; the states are now durable.
    setTimeout(() => advanceDemoTask(id, 'running'), 800).unref()
    setTimeout(() => advanceDemoTask(id, 'delivered'), 2500).unref()
    return send(res, 201, { id: task.id, status: task.status, cost: task.cost, mode: 'demo' })
  }

  if (method === 'GET' && path.startsWith('/api/tasks/')) {
    const task = readDemoTask(path.slice('/api/tasks/'.length))
    if (!task) return fail(res, 404, 'not_found')
    return send(res, 200, { id: task.id, status: task.status, cost: task.cost, mode: 'demo' })
  }

  return fail(res, 404, 'not_found')
}

/* ------------------------------------------------------------------ boot */

const server = createServer((req, res) => {
  if (!applyCors(req, res)) {
    fail(res, 403, 'origin_not_allowed')
    return
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (rateLimited(req)) {
    res.setHeader('Retry-After', '60')
    fail(res, 429, 'rate_limited')
    return
  }
  route(req, res).catch(error => {
    // `safeError` drops the stack and scrubs the message, so an upstream failure
    // that quotes the RPC endpoint cannot reach stdout either. The caller gets
    // nothing diagnostic at all.
    safeError('[wally-api] unhandled', error)
    if (!res.headersSent) fail(res, 500, 'internal_error')
    else res.end()
  })
})

sweepExpired()
setInterval(() => sweepExpired(), 10 * 60 * 1000).unref()
setInterval(() => sweepBuckets(), 5 * 60 * 1000).unref()

server.listen(PORT, () => {
  // Every line goes through `safeLog`. The endpoint URL is never printed — only
  // the name of the variable it came from, which is not a credential.
  safeLog(`Wally World API on http://127.0.0.1:${PORT}`)
  safeLog(`  cluster        ${CLUSTER}${CLUSTER === 'mainnet-beta' ? '  *** MAINNET · REAL FUNDS ***' : ''}`)
  safeLog(`  persistence    sqlite`)
  safeLog(`  rpc endpoint   from ${RPC_SOURCE_VAR}${RPC_IS_PUBLIC ? ' (public endpoint)' : ' (keyed — treated as a credential, never logged or served)'}`)
  safeLog(`  rpc proxy      POST /api/rpc · ${allowedMethodNames().length} methods allowlisted`)
  safeLog(`  payments       ${PAYMENTS_ENABLED ? `enabled → ${NPC_PAYEE_ADDRESS}` : 'disabled (NPC_PAYEE_ADDRESS unset)'}`)
  safeLog(`  gold payouts   disabled (not implemented by design)`)
  safeLog(`  custody        none — no keys in this process`)
  verifyClusterIdentity().then(chain => {
    safeLog(`  cluster check  ${chain.ok ? 'ok' : 'MISMATCH'} · ${chain.detail}`)
    if (!chain.ok) {
      safeLog('  !! The RPC endpoint does not serve the cluster named in SOLANA_CLUSTER.')
      safeLog('  !! Balances and payment verification will not mean what the labels say. Fix this before continuing.')
    }
  })
})
