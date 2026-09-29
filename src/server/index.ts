/* ------------------------------------------------------------------ *
 * Voxels API.
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
import { networkInterfaces } from 'node:os'
import {
  ALLOWED_ORIGINS,
  assertConfigValid,
  BIND_HOST,
  CHAIN_ID,
  CLUSTER,
  DATABASE_URL,
  DB_DRIVER,
  IS_PRODUCTION,
  isAllowedBrowserOrigin,
  isAllowedPageHost,
  NODE_ENV,
  NPC_PAYEE_ADDRESS,
  PAYMENTS_ENABLED,
  PAYOUTS_ENABLED,
  PORT,
  PUBLIC_ORIGIN,
  ROOM_CAPACITY,
  RPC_IS_PUBLIC,
  RPC_SOURCE_VAR,
  SERVICE_PRICE_LAMPORTS,
  SESSION_TTL_MS,
  SHUTDOWN_GRACE_MS,
  TRUST_PRIVATE_ORIGINS,
  TRUST_PROXY_HOPS,
  UI_PORT,
} from './config'
import {
  apiRateLimited,
  authRateLimited,
  clientAddress,
  overBudget,
  retryAfterSeconds,
  RPC_BUDGET,
  sweepBuckets,
} from './net'
import { readiness } from './readiness'
import { installSignalHandlers, onDrain } from './shutdown'
import { createSession, issueChallenge, revokeFromAuthHeader, verifySignIn, walletFromAuthHeader } from './auth'
import { issueGuestSession } from './pvp/guest'
import { ensureAccount } from './pvp/ids'
import { goldView } from './pvp/ledger'
import { nameChangeAllowed } from './moderation/nameRate'
import { blocklistSize, screenDisplayName } from './moderation/names'
import { originContext } from './origin'
import { handleOperatorHttp } from './operator/http'
import { handleAccountHttp } from './routes/account'
import { schemaVersions } from './store'
import { handlerKinds } from './jobs/handlers'
import { recoverExpiredLeases } from './jobs/queue'
import { TREASURY_SIGNER } from './treasury/config'
import {
  advanceDemoTask,
  createDemoTask,
  listReceipts,
  readDemoTask,
  readProfile,
  readReceipt,
  receiptBelongsTo,
  recordReceipt,
  setReceiptStatus,
  sweepExpired,
  writeProfile,
  type ReceiptRow,
  type ReceiptStatus,
} from './db'
import { verifyClusterIdentity, verifyTransfer } from './chain'
import { allowedMethodNames, proxyRpc } from './rpcProxy'
import { redact, safeError, safeLog, secretFingerprint } from './redact'
import { attachPvpUpgrade, handlePvpHttp, upgradePolicy } from './pvp'
import { drainLive } from './pvp/hub'

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

/** Echoes the origin only when it is allowed, so the header is never `*`. */
function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (!origin) return true // same-origin or non-browser caller; no CORS headers needed
  if (!isAllowedBrowserOrigin(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  // `solana-client` is added by @solana/web3.js to every request it makes. It
  // is a version string, not a credential, but the preflight fails without it
  // and every RPC call from the browser dies.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, solana-client')
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
 * Per session when the caller has one, per address otherwise.
 *
 * Balances are shown before sign-in, so the proxy cannot require a session; an
 * address bucket is the fallback. Keying signed-in traffic by session means one
 * busy player cannot exhaust the budget for everyone behind the same NAT.
 */
function rpcRateLimited(req: IncomingMessage): boolean {
  const wallet = walletFromAuthHeader(req.headers.authorization)
  return overBudget(wallet ? `rpc:session:${wallet}` : `rpc:ip:${clientAddress(req)}`, RPC_BUDGET)
}

/** Sends a 429 that tells the caller how long to wait, rather than just "no". */
function tooManyRequests(req: IncomingMessage, res: ServerResponse, key: string, detail: string) {
  res.setHeader('Retry-After', String(retryAfterSeconds(key)))
  fail(res, 429, 'rate_limited', detail)
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
      return tooManyRequests(req, res, `rpc:ip:${clientAddress(req)}`, 'Too many RPC requests. Slow down.')
    }
    const parsed = await readJson(req, { allowArray: true })
    if (!parsed.ok) return failBody(res, parsed)
    const outcome = await proxyRpc(parsed.body)
    return send(res, outcome.status, outcome.body as Json)
  }

  /* ---- liveness -------------------------------------------------------- */
  /**
   * Is this process alive? No I/O, no dependencies, no database.
   *
   * A platform restarts an instance whose liveness check fails, so this
   * must not fail for anything a restart would not fix. A database outage
   * is exactly such a thing: restarting into the same outage helps nobody,
   * and it is `/api/ready` that is supposed to notice.
   */
  if (method === 'GET' && (path === '/api/live' || path === '/healthz')) {
    return send(res, 200, { ok: true, status: 'live', uptimeSeconds: Math.round(process.uptime()) })
  }

  /* ---- readiness ------------------------------------------------------- */
  /**
   * Can this process actually serve a player?
   *
   * Answers 503 when the database is unreachable or while the instance is
   * draining for shutdown, so a load balancer stops routing here instead of
   * delivering players into a world that cannot save anything.
   */
  if (method === 'GET' && (path === '/api/ready' || path === '/readyz')) {
    const state = await readiness()
    return send(res, state.ready ? 200 : 503, {
      ok: state.ready,
      status: state.ready ? 'ready' : 'not-ready',
      checks: state.checks,
      checkedAtMs: state.checkedAtMs,
    })
  }

  /* ---- health ---------------------------------------------------------- */
  if (method === 'GET' && path === '/api/health') {
    const chain = await verifyClusterIdentity()
    const state = await readiness()
    return send(res, 200, {
      ok: true,
      ready: state.ready,
      environment: NODE_ENV,
      publicOrigin: PUBLIC_ORIGIN,
      allowedOrigins: ALLOWED_ORIGINS,
      trustProxyHops: TRUST_PROXY_HOPS,
      world: { instances: 1, ...upgradePolicy(), note: 'One authoritative world process. There is no room routing; a second instance would be a second town.' },
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
      /**
       * The driver name, never the connection string. `DATABASE_URL`
       * carries a password in its userinfo, so the fingerprint is what an
       * operator gets: enough to tell one configured database from
       * another, not enough to connect to either.
       */
      persistence: DB_DRIVER,
      databaseFingerprint: DB_DRIVER === 'postgres' ? secretFingerprint(DATABASE_URL) : 'local-file',
      pvp: { presence: '/ws/pvp', gold: 'game-gold', demo: true },
      /**
       * Two databases with no foreign key between them: game and identity in one,
       * money in the other. The numbers are the highest applied migration in each.
       */
      schema: schemaVersions(),
      gold: {
        authority: 'server',
        model: 'append-only double-entry ledger, integer base units stored as TEXT',
        conservation: '/api/ledger/conservation',
        redeemableProvenances: ['hunt_verified'],
      },
      jobs: { queue: 'sqlite lease', worker: 'npm run worker', handlers: handlerKinds() },
      withdrawals: { endpoint: '/api/withdrawals/quote', signer: TREASURY_SIGNER },
      auth: 'sign-in-with-solana',
      /**
       * Always false, and not a function of `NPC_PAYEE_ADDRESS` any more. A
       * service payment needs a player-signed transfer and no client can sign
       * one: see the reasoning on `PAYMENTS_ENABLED` in config.ts.
       */
      paymentsEnabled: PAYMENTS_ENABLED,
      paymentsDisabledReason: 'no client-side transaction signer exists',
      /** Always false. Not switchable by configuration; see the README. */
      payoutsEnabled: PAYOUTS_ENABLED,
      custody: 'none — this server holds no keys and cannot sign',
    })
  }

  /* ---- sign-in --------------------------------------------------------- */
  /**
   * Every route that mints an identity shares one tight budget.
   *
   * Nonce issuance writes a row, verification runs ed25519, and guest
   * minting does both. Left on the general API budget they are the cheapest
   * way to make this server do expensive work on someone else's schedule.
   */
  const MINTS_IDENTITY = ['/api/auth/nonce', '/api/auth/verify', '/api/pvp/guest', '/api/dev/session']
  if (method === 'POST' && MINTS_IDENTITY.includes(path) && authRateLimited(req)) {
    return tooManyRequests(req, res, `auth:${clientAddress(req)}`, 'Too many sign-in attempts. Wait a minute.')
  }

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

    /*
     * Display-name moderation, at the edge.
     *
     * Rejecting here rather than silently renaming is a deliberate trade. A
     * reject tells an attacker that something tripped, which a silent rename
     * would not — but a silent rename tells an HONEST player nothing at all,
     * and they walk into town under a name they did not choose and cannot
     * fix. That is a worse outcome more often, because most rejections are
     * ordinary players hitting a false positive, not the one person probing.
     *
     * The cost is paid down two ways. The message is generic, so it does not
     * say which rule fired or which part of the name did it; and the attempt
     * spends name-change budget, so iterating towards a pass is slow. The
     * broadcast layer in `pvp/ids.ts` is what makes the reject non-essential
     * anyway: a name that gets past this check by some other route still
     * never reaches another player's screen.
     *
     * Only counted when the name actually changes, so saving a hat is free.
     */
    const heldName = readProfile(wallet)?.profile.playerName
    if (check.profile.playerName !== heldName) {
      if (!nameChangeAllowed(wallet)) {
        return fail(res, 429, 'too_many_name_changes', 'Too many name changes. Wait a few minutes.')
      }
      const verdict = screenDisplayName(check.profile.playerName)
      if (!verdict.ok) {
        // The fingerprint, never the name: an operator can tell two attempts
        // apart in an incident without the string entering the logs.
        safeLog(`profile: display name refused (${verdict.tier}, ${verdict.fingerprint})`)
        return fail(res, 422, 'invalid_profile', 'That name is not available. Please choose a different name.')
      }
    }

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
      // Not a configuration gap, so the reason does not name a variable to set.
      // A service payment is a transfer the player signs, and there is no
      // transaction signer in the client: the browser-held key signs identity
      // challenges only. Setting NPC_PAYEE_ADDRESS would not change this.
      return send(res, 200, {
        available: false,
        reason: 'Service payments are switched off. Paying would need a transfer signed by you, and this app has no transaction signer — the wallet in your browser signs identity messages only.',
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
      if (!receiptBelongsTo(existing, wallet)) return fail(res, 409, 'signature_already_recorded')
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
    if (!row || !receiptBelongsTo(row, wallet)) return fail(res, 404, 'not_found')
    return send(res, 200, { receipt: receiptView(await reconcile(row, wallet)) })
  }

  if (method === 'GET' && path === '/api/payments/receipts') {
    const wallet = requireWallet(req, res)
    if (!wallet) return
    return send(res, 200, { receipts: listReceipts(wallet).map(receiptView) })
  }

  /* ---- payouts: still unavailable, for the current reasons -------------
   *
   * This string is the one the player reads: the wallet panel prefers it over
   * its own fallback. It used to say gold was "accumulated by the browser",
   * which stopped being true when `money/ledger.ts` landed, and a stale reason
   * implies the remaining blockers were solved. Each clause below is checkable
   * against code: `money/ledger.ts` (append-only double-entry, bigint base
   * units), `money/provenance.ts` (`hunt_verified` is the only redeemable
   * origin), `treasury/config.ts` (five keys, no defaults, `TREASURY_SIGNER`
   * unavailable), `treasury/withdrawals.ts` (`submitWithdrawal` returns
   * `no_signer`), and `hunt/rewards.ts`'s header for the caveat.
   * -------------------------------------------------------------------- */
  if (method === 'GET' && path === '/api/payouts/status') {
    return send(res, 200, {
      enabled: PAYOUTS_ENABLED,
      status: 'UNAVAILABLE · NO TREASURY SIGNER, NO RATE, NO MINT',
      reason:
        'Gold is server-authoritative now: it lives in an append-only double-entry ledger in whole base units, so it is no longer "counted by your browser". Only gold with hunt_verified provenance is even eligible to be redeemed — gifts, duel winnings and imported demo gold never are. What is still missing is everything on the payout side, and none of it is a switch: there is no treasury signing key and no code in this process that could use one; the five withdrawal settings have no values and no defaults, so /api/withdrawals/quote answers 409 naming each one; submission returns no_signer; and no WALLY token mint exists. One caveat that is not hidden: hunt combat still runs in the browser. The server proves the reward amount, the species, that each animal pays at most once, and a bounded per-session ceiling. It does not prove a fight happened.',
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

  if (method === 'POST' && path === '/api/pvp/guest') {
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const issued = issueGuestSession((parsed.body as { guestKey?: unknown }).guestKey)
    if (!issued) return fail(res, 400, 'bad_request', 'guestKey must be a hex secret from this browser.')
    return send(res, 200, issued)
  }

  if (method === 'POST' && path === '/api/dev/session') {
    if (process.env.WALLY_DEV_SESSIONS !== '1') return fail(res, 404, 'not_found')
    const parsed = await readJson(req)
    if (!parsed.ok) return failBody(res, parsed)
    const label = String((parsed.body as { label?: unknown }).label ?? 'dev').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'dev'
    const accountId = `dev${label}${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const session = createSession(accountId)
    const account = ensureAccount(accountId)
    return send(res, 200, {
      token: session.token,
      expiresAtMs: session.expiresAtMs,
      playerId: account.player_id,
      gold: goldView(account.player_id),
      mode: 'dev-session',
      notice: 'Test identity only. Not a wallet. Not Solana.',
    })
  }

  if (handlePvpHttp(req, res, path, method, send, fail)) return

  /**
   * Owner-only integration readiness console.
   *
   * The identity comes from the session header, never the body, and the handler
   * itself 404s when `WALLY_OPERATOR_ACCOUNTS` is unset, so mounting it here
   * exposes nothing on a deployment that has not opted in.
   */
  if (
    await handleOperatorHttp({
      path,
      method,
      account: walletFromAuthHeader(req.headers.authorization),
      send: (status, body) => send(res, status, body),
      fail: (status, error, detail) => fail(res, status, error, detail),
    })
  ) {
    return
  }

  /**
   * Account, gold ledger, hunting, jobs and withdrawals.
   *
   * Mounted last and given its own module so the financial surface has one entry
   * point. Every route inside resolves identity from the session through
   * `walletFromAuthHeader`, exactly as `requireWallet` does here, and never from
   * the body.
   */
  if (await handleAccountHttp({ req, res, path, method, send, fail, readBody: () => readJson(req) })) return

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
  if (apiRateLimited(req)) {
    res.setHeader('Retry-After', String(retryAfterSeconds(`api:${clientAddress(req)}`)))
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
/**
 * Lease recovery runs here as well as in the worker.
 *
 * A job whose worker died is stranded until something notices. The worker does
 * notice, but only if a worker is running — and `npm run worker` is a separate
 * process that an operator can forget to start. Recovering leases from the API too
 * means a safe read goes back on the queue and a financial job reaches
 * `needs_reconcile` regardless.
 */
setInterval(() => recoverExpiredLeases(), 60 * 1000).unref()
attachPvpUpgrade(server)

/**
 * What to do with the thirty seconds between SIGTERM and SIGKILL.
 *
 * Players first: they are told the world is restarting and given a moment
 * for that frame to reach them, open duels are voided with both stakes
 * returned, and positions are recorded so a reconnect resumes where the
 * player stood. Sessions are swept afterwards. The database closes last,
 * because everything above writes to it.
 */
onDrain({ name: 'players', run: () => drainLive(5_000) })
onDrain({ name: 'sessions', run: () => { sweepExpired() } })

function lanIpv4(): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      found.push(info.address)
    }
  }
  return found
}

/**
 * Nothing starts listening until the configuration is known to be sound.
 *
 * A server that boots with a broken origin list passes the platform's
 * health check and is unusable to every player, which is the worst of both
 * outcomes: the deploy looks green and the game is down. Failing here means
 * the deploy goes red and the previous version keeps serving.
 */
assertConfigValid()

server.listen(PORT, BIND_HOST, () => {
  // Every line goes through `safeLog`. No credential is printed — only the
  // name of the variable one came from, or a fingerprint of its value.
  safeLog(`Voxels API on ${BIND_HOST}:${PORT} — one shared world · ${NODE_ENV}`)
  if (IS_PRODUCTION) {
    safeLog(`  public         ${PUBLIC_ORIGIN ?? '(no WALLY_PUBLIC_ORIGIN — clients use the page origin)'}`)
    safeLog(`  origins        ${ALLOWED_ORIGINS.join(', ') || 'none'} · private LAN origins are NOT auto-trusted in production`)
    safeLog(`  proxy          trusting ${TRUST_PROXY_HOPS} forwarded hop(s) for client address and scheme`)
  } else {
    const lan = lanIpv4()
    safeLog(`  local game     http://127.0.0.1:${UI_PORT}`)
    if (lan.length) {
      for (const ip of lan) safeLog(`  same Wi-Fi     http://${ip}:${UI_PORT}`)
    } else {
      safeLog('  same Wi-Fi     (no LAN IPv4 — only this machine can open the game)')
    }
    safeLog('  public         none. This process is not on the public internet. A friend on another network cannot join without a tunnel or a deployed host.')
    safeLog(`  origins        ${ALLOWED_ORIGINS.join(', ')}${TRUST_PRIVATE_ORIGINS ? ' + any loopback/LAN origin (development only)' : ''}`)
  }
  safeLog(`  world          1 instance · capacity ${ROOM_CAPACITY} players · no room routing exists, do not scale out`)
  safeLog(`  cluster        ${CLUSTER}${CLUSTER === 'mainnet-beta' ? '  *** MAINNET · REAL FUNDS ***' : ''}`)
  safeLog(`  persistence    ${DB_DRIVER}${DB_DRIVER === 'postgres' ? ` · ${secretFingerprint(DATABASE_URL)}` : ' (file — ephemeral on a container filesystem)'}`)
  if (IS_PRODUCTION && DB_DRIVER === 'sqlite') {
    safeLog('  !! Production on SQLite. A container filesystem is wiped on every redeploy, so every account and duel will be lost.')
    safeLog('  !! Provision a managed Postgres and set DATABASE_URL.')
  }
  safeLog(`  health         GET /api/live (liveness) · GET /api/ready (readiness, checks the database)`)
  safeLog(`  shutdown       ${SHUTDOWN_GRACE_MS}ms drain on SIGTERM`)
  safeLog(`  rpc endpoint   from ${RPC_SOURCE_VAR}${RPC_IS_PUBLIC ? ' (public endpoint)' : ' (keyed — treated as a credential, never logged or served)'}`)
  safeLog(`  rpc proxy      POST /api/rpc · ${allowedMethodNames().length} methods allowlisted`)
  // Counts only. The terms themselves never reach a log line.
  safeLog(`  name filter    ${blocklistSize.always + blocklistSize.word} blocked terms · ${blocklistSize.innocent} allowlisted words · enforced at the profile API and at every presence broadcast`)
  safeLog(`  payments       disabled (no client-side transaction signer)${NPC_PAYEE_ADDRESS ? ' · NPC_PAYEE_ADDRESS is set but unused' : ''}`)
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

installSignalHandlers(server)
