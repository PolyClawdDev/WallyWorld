/* ------------------------------------------------------------------ *
 * Routes for the account, the gold ledger, hunting, jobs and
 * withdrawals.
 *
 * Every route here follows the `requireWallet()` discipline the rest of the
 * API already uses: the identity comes from the session, is resolved to a
 * canonical `user_id`, and is never read from the request body. There is no
 * handler below that takes an account id, a player id or a wallet address
 * from the caller and uses it to decide what to read or write.
 *
 * Ownership is checked on every read as well as every write. A resource
 * belonging to another account reads as 404 rather than 403, so the API does
 * not confirm that somebody else's job or receipt exists.
 * ------------------------------------------------------------------ */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLUSTER } from '../config'
import { sessionHashFromAuthHeader, walletFromAuthHeader } from '../auth'
import { issueClaimChallenge, resolveClaimConflict, verifyClaim } from '../identity/claim'
import { linkHistory, principalsFor, readUser, walletsFor } from '../identity/users'
import { resolveUserForPrincipal } from '../identity/users'
import { claimKill, closeHunt, huntTokens, openHunt, recordHuntDeath, MIN_CLAIM_GAP_MS } from '../hunt/rewards'
import { goldSnapshot, provenanceBreakdown } from '../money/gold'
import { conservationReport, entriesForUser } from '../money/ledger'
import { importLegacyDemoGold } from '../money/legacyImport'
import { PROVENANCES, REDEEMABLE_PROVENANCES, PROVENANCE_NOTES } from '../money/provenance'
import { enqueueJob, listArtifactsForOwner, listJobsForOwner, readArtifactForOwner, readJobForOwner } from '../jobs/queue'
import { handlerFor, handlerKinds } from '../jobs/handlers'
import { catalogueView } from '../npc/catalogue'
import { listOrdersForOwner, purchaseService, readArtifactTextForOwner, readOrderForOwner } from '../npc/orders'
import { originContext } from '../origin'
import { ensureAccount } from '../pvp/ids'
import { WITHDRAWAL_CONFIG_KEYS, TREASURY_SIGNER } from '../treasury/config'
import {
  cancelWithdrawal,
  confirmDestination,
  issueDestinationChallenge,
  listWithdrawalsForOwner,
  quoteWithdrawal,
  readWithdrawalForOwner,
  reserveWithdrawal,
  submitWithdrawal,
} from '../treasury/withdrawals'

export type Send = (res: ServerResponse, status: number, body: Record<string, unknown> | Array<unknown>) => void
export type Fail = (res: ServerResponse, status: number, error: string, detail?: string) => void
export type ReadBody = () => Promise<{ ok: true; body: unknown } | { ok: false; status: number; reason: string }>

export type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  path: string
  method: string
  send: Send
  fail: Fail
  readBody: ReadBody
}

/** Prefixes this module owns. Checked before any work so the router stays cheap. */
const PREFIXES = ['/api/account', '/api/gold', '/api/hunt', '/api/jobs', '/api/artifacts', '/api/withdrawals', '/api/ledger', '/api/services']

const body = (parsed: unknown) => (parsed ?? {}) as Record<string, unknown>

/**
 * Job kinds a player may create for themselves.
 *
 * An allowlist rather than a filter: a kind that is not named here cannot be
 * enqueued over HTTP at all, so adding a handler does not implicitly expose it.
 * `withdrawal.reconcile` is absent deliberately — reconciliation of a financial
 * operation is scheduled by the server, not requested by a client.
 */
const CLIENT_JOB_KINDS = new Set(['ledger.audit', 'receipt.reconcile'])

export async function handleAccountHttp(context: RouteContext): Promise<boolean> {
  const { req, res, path, method, send, fail, readBody } = context
  if (!PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false

  const principal = walletFromAuthHeader(req.headers.authorization)
  if (!principal) {
    fail(res, 401, 'unauthenticated', 'Sign in with your wallet, or start a guest session, first.')
    return true
  }
  const sessionHash = sessionHashFromAuthHeader(req.headers.authorization)
  if (!sessionHash) {
    fail(res, 401, 'unauthenticated')
    return true
  }
  const { userId } = resolveUserForPrincipal(principal)
  // Makes sure the player record and the ledger accounts exist before anything
  // reads them, so a brand-new guest session does not see a 404 for its own gold.
  const account = ensureAccount(principal)

  /* ---- account ---------------------------------------------------------- */

  if (method === 'GET' && path === '/api/account') {
    const user = readUser(userId)
    const gold = goldSnapshot(userId)
    send(res, 200, {
      // The account id is an opaque server token. It is not a wallet address and
      // is not derived from one.
      accountId: userId,
      playerId: account.player_id,
      status: user?.status ?? 'active',
      origin: user?.origin ?? 'guest',
      claimed: Boolean(user?.claimed_at_ms),
      primaryWallet: user?.primary_wallet ?? null,
      linkedWallets: walletsFor(userId),
      principals: principalsFor(userId),
      history: linkHistory(userId),
      gold: {
        available: gold.available.toString(),
        reserved: gold.reserved.toString(),
        total: gold.total.toString(),
        redeemable: gold.redeemable.toString(),
      },
      cluster: CLUSTER,
      notice:
        'One account. Linking a wallet attaches it to this account; it never resets your character and never creates a second player.',
    })
    return true
  }

  if (method === 'POST' && path === '/api/account/claim/challenge') {
    const origin = originContext(req)
    if (!origin) {
      fail(res, 403, 'origin_not_allowed', 'This origin may not request a wallet-link challenge.')
      return true
    }
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const publicKey = body(parsed.body).publicKey
    if (typeof publicKey !== 'string') {
      fail(res, 400, 'bad_request', 'publicKey must be a base58 Solana address.')
      return true
    }
    const issued = issueClaimChallenge({
      userId,
      wallet: publicKey,
      domain: origin.domain,
      uri: origin.uri,
      sessionHash,
    })
    send(res, 201, {
      challenge: issued.fields,
      expiresAtMs: issued.expiresAtMs,
      notice:
        'Sign this to prove you control the wallet. It is bound to this site, this wallet, this session, a single-use nonce and an expiry. Connecting a wallet on its own proves nothing.',
    })
    return true
  }

  if (method === 'POST' && path === '/api/account/claim/verify') {
    if (!originContext(req)) {
      fail(res, 403, 'origin_not_allowed')
      return true
    }
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const outcome = verifyClaim({
      userId,
      sessionHash,
      wallet: input.publicKey,
      nonce: input.nonce,
      signature: input.signature,
    })
    if (!outcome.ok) {
      fail(res, 401, 'claim_failed', outcome.reason)
      return true
    }
    if (outcome.kind === 'choice_required') {
      send(res, 409, {
        error: 'wallet_linked_elsewhere',
        nonce: outcome.nonce,
        options: outcome.options,
        detail: outcome.detail,
      })
      return true
    }
    const gold = goldSnapshot(userId)
    send(res, 200, {
      linked: true,
      alreadyLinked: outcome.alreadyLinked,
      accountId: userId,
      playerId: account.player_id,
      wallet: outcome.wallet,
      gold: { available: gold.available.toString(), reserved: gold.reserved.toString(), redeemable: gold.redeemable.toString() },
      detail: 'Wallet linked. Same account, same character, same balance.',
    })
    return true
  }

  if (method === 'POST' && path === '/api/account/claim/resolve') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const outcome = resolveClaimConflict({ userId, sessionHash, nonce: input.nonce, action: input.action })
    if (!outcome.ok) {
      fail(res, 409, 'resolve_failed', outcome.reason)
      return true
    }
    send(res, 200, {
      action: outcome.action,
      accountId: outcome.userId,
      wallet: outcome.wallet,
      movedGold: outcome.action === 'merge' ? outcome.movedGold : '0',
      detail:
        outcome.action === 'switch'
          ? 'Switched to the account that already owns this wallet. Nothing was moved and the guest account is untouched — sign in again from this browser to return to it.'
          : 'Merged. Gold moved as a balanced ledger transfer and the guest account is retired. Redeemable eligibility did not transfer.',
      reauthenticate: true,
    })
    return true
  }

  if (method === 'POST' && path === '/api/account/legacy-gold/import') {
    const outcome = importLegacyDemoGold(userId)
    if (!outcome.ok) {
      fail(res, 409, 'nothing_to_import', outcome.reason)
      return true
    }
    send(res, 200, {
      imported: outcome.imported,
      idempotent: outcome.idempotent,
      redeemable: false,
      provenance: 'legacy_demo',
      detail: PROVENANCE_NOTES.legacy_demo,
    })
    return true
  }

  /* ---- gold ------------------------------------------------------------- */

  if (method === 'GET' && path === '/api/gold') {
    const gold = goldSnapshot(userId)
    send(res, 200, {
      available: gold.available.toString(),
      reserved: gold.reserved.toString(),
      total: gold.total.toString(),
      redeemable: gold.redeemable.toString(),
      eligibility: {
        accrued: gold.accrued.toString(),
        consumed: gold.consumed.toString(),
        rule: 'redeemable = min(accrued redeemable credits − consumed, available balance)',
        redeemableProvenances: REDEEMABLE_PROVENANCES,
      },
      byProvenance: provenanceBreakdown(userId),
      provenances: PROVENANCES.map(p => ({ provenance: p, note: PROVENANCE_NOTES[p] })),
      goldKind: 'game-gold',
      notice: 'One server-owned balance for hunting, inventory, inspection and PvP. There is no payout path; see /api/withdrawals/quote.',
    })
    return true
  }

  if (method === 'GET' && path === '/api/gold/ledger') {
    send(res, 200, { entries: entriesForUser(userId, 100) })
    return true
  }

  if (method === 'GET' && path === '/api/ledger/conservation') {
    const report = conservationReport()
    send(res, 200, {
      balances: report.ok,
      balanceSum: report.balanceSum.toString(),
      entrySum: report.entrySum.toString(),
      unbalancedTransfers: report.unbalancedTransfers,
      driftedAccounts: report.driftedAccounts.map(a => ({
        accountId: a.accountId,
        balance: a.balance.toString(),
        entrySum: a.entrySum.toString(),
      })),
      detail: 'Every balance summed, and every transfer summed, must be zero. Gold is moved out of a system account, never conjured.',
    })
    return true
  }

  /* ---- hunting ---------------------------------------------------------- */

  if (method === 'POST' && path === '/api/hunt/session') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const opened = openHunt({ userId, playerId: account.player_id, region: input.region, level: input.level })
    if (!opened.ok) {
      fail(res, 422, 'hunt_not_available', opened.reason)
      return true
    }
    send(res, 201, {
      huntId: opened.hunt.huntId,
      region: opened.hunt.region,
      level: opened.hunt.level,
      expiresAtMs: opened.hunt.expiresAtMs,
      rosterSize: opened.hunt.tokens.length,
      minClaimGapMs: MIN_CLAIM_GAP_MS,
      tokens: opened.hunt.tokens,
      detail:
        'The server chose this roster and each animal is worth what the server says. One token per animal, each payable once. The fight itself still runs in the browser, so this proves the amount and the count, not that a fight happened.',
    })
    return true
  }

  if (method === 'POST' && path === '/api/hunt/claim') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const outcome = claimKill({ userId, huntId: input.huntId, tokenId: input.tokenId })
    if (!outcome.ok) {
      const status = outcome.code === 'not_yours' ? 404 : outcome.code === 'rate_limited' ? 429 : 409
      fail(res, status, outcome.code, outcome.reason)
      return true
    }
    send(res, 200, {
      credited: outcome.credited,
      species: outcome.species,
      provenance: 'hunt_verified',
      redeemable: true,
      balance: outcome.balance,
    })
    return true
  }

  if (method === 'POST' && path === '/api/hunt/death') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const outcome = recordHuntDeath({ userId, huntId: input.huntId, clientRef: input.clientRef })
    if (!outcome.ok) {
      fail(res, 409, 'death_not_recorded', outcome.reason)
      return true
    }
    send(res, 200, { forfeited: outcome.forfeited, idempotent: outcome.idempotent, balance: outcome.balance })
    return true
  }

  if (method === 'POST' && path === '/api/hunt/close') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const huntId = body(parsed.body).huntId
    if (typeof huntId !== 'string' || !closeHunt(huntId, userId)) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { closed: true, unclaimed: huntTokens(huntId).length })
    return true
  }

  /* ---- jobs ------------------------------------------------------------- */

  if (method === 'GET' && path === '/api/jobs') {
    send(res, 200, { jobs: listJobsForOwner(userId), kinds: handlerKinds().filter(k => CLIENT_JOB_KINDS.has(k.kind)) })
    return true
  }

  if (method === 'POST' && path === '/api/jobs') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    const kind = input.kind
    if (typeof kind !== 'string' || !CLIENT_JOB_KINDS.has(kind)) {
      fail(res, 422, 'unknown_kind', `kind must be one of: ${[...CLIENT_JOB_KINDS].join(', ')}`)
      return true
    }
    const handler = handlerFor(kind)!
    const idempotencyKey = typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9_:-]{8,120}$/.test(input.idempotencyKey)
      ? `${userId}:${input.idempotencyKey}`
      : null
    if (!idempotencyKey) {
      fail(res, 400, 'bad_request', 'idempotencyKey must be 8-120 characters of A-Z a-z 0-9 _ : -')
      return true
    }
    const { job, created } = enqueueJob({
      ownerUserId: userId,
      kind,
      retrySafety: handler.retrySafety,
      idempotencyKey,
      request: input.request ?? {},
    })
    send(res, created ? 201 : 200, { job: readJobForOwner(job.job_id, userId), created })
    return true
  }

  if (method === 'GET' && path.startsWith('/api/jobs/')) {
    const view = readJobForOwner(path.slice('/api/jobs/'.length), userId)
    if (!view) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { job: view })
    return true
  }

  /* ---- artifacts -------------------------------------------------------- */

  if (method === 'GET' && path === '/api/artifacts') {
    send(res, 200, { artifacts: listArtifactsForOwner(userId) })
    return true
  }

  if (method === 'GET' && path.startsWith('/api/artifacts/')) {
    const artifact = readArtifactForOwner(path.slice('/api/artifacts/'.length), userId)
    if (!artifact) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { artifact })
    return true
  }

  /* ---- npc services ----------------------------------------------------- */

  if (method === 'GET' && path === '/api/services') {
    const gold = goldSnapshot(userId)
    send(res, 200, {
      services: catalogueView(),
      orders: listOrdersForOwner(userId),
      gold: { available: gold.available.toString(), reserved: gold.reserved.toString(), total: gold.total.toString() },
      currency: 'gold',
      notice:
        'Services are paid for in game gold out of the one server-owned balance. Prices are set here, not by the caller. An unavailable service cannot be bought and moves nothing.',
    })
    return true
  }

  if (method === 'POST' && path === '/api/services/purchase') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const input = body(parsed.body)
    // The price is never read from the body. It comes from the server catalogue,
    // keyed by service id, and nothing here looks at a balance the caller sent.
    const outcome = purchaseService({
      userId,
      playerId: account.player_id,
      displayName: account.display_name,
      serviceId: input.serviceId,
      request: (input.request ?? {}) as Record<string, unknown>,
      idempotencyKey: input.idempotencyKey,
    })
    if (!outcome.ok) {
      const status =
        outcome.code === 'unknown_service' ? 404
        : outcome.code === 'service_unavailable' ? 501
        : outcome.code === 'insufficient_gold' ? 402
        : outcome.code === 'contention' ? 409
        : outcome.code === 'bad_request' ? 400
        : 422
      send(res, status, {
        error: outcome.code,
        detail: outcome.reason,
        options: outcome.options,
        order: outcome.order,
        gold: outcome.balance === undefined ? undefined : { available: outcome.balance },
      })
      return true
    }
    send(res, outcome.replayed ? 200 : 201, {
      order: outcome.order,
      artifact: outcome.artifact,
      replayed: outcome.replayed,
      gold: { available: outcome.balance },
    })
    return true
  }

  const serviceOrder = /^\/api\/services\/orders\/(so_[0-9a-f]{32})$/.exec(path)
  if (method === 'GET' && serviceOrder) {
    const order = readOrderForOwner(serviceOrder[1], userId)
    if (!order) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { order, artifact: readArtifactTextForOwner(serviceOrder[1], userId) })
    return true
  }

  /* ---- withdrawals ------------------------------------------------------ */

  if (method === 'GET' && path === '/api/withdrawals') {
    send(res, 200, {
      withdrawals: listWithdrawalsForOwner(userId),
      signer: TREASURY_SIGNER,
      configuration: Object.entries(WITHDRAWAL_CONFIG_KEYS).map(([key, what]) => ({ key, what })),
    })
    return true
  }

  if (method === 'POST' && path === '/api/withdrawals/quote') {
    const parsed = await readBody()
    if (!parsed.ok) {
      fail(res, parsed.status, 'bad_request', parsed.reason)
      return true
    }
    const outcome = quoteWithdrawal({ userId, goldAmount: body(parsed.body).goldAmount })
    if (!outcome.ok) {
      if (outcome.code === 'missing_configuration') {
        // 409, not 501: the endpoint works, the deployment is unconfigured, and the
        // response says precisely which decisions are outstanding.
        send(res, 409, {
          error: 'missing_configuration',
          detail: outcome.detail,
          missing: outcome.missing,
          invalid: outcome.invalid,
          signer: TREASURY_SIGNER,
        })
        return true
      }
      fail(res, 422, outcome.code, outcome.detail)
      return true
    }
    send(res, 201, { quote: outcome })
    return true
  }

  const withdrawalAction = /^\/api\/withdrawals\/(wd_[0-9a-f]{32})\/([a-z/-]+)$/.exec(path)
  if (method === 'POST' && withdrawalAction) {
    const [, withdrawalId, action] = withdrawalAction
    if (!readWithdrawalForOwner(withdrawalId, userId)) {
      fail(res, 404, 'not_found')
      return true
    }

    if (action === 'destination/challenge') {
      const origin = originContext(req)
      if (!origin) {
        fail(res, 403, 'origin_not_allowed')
        return true
      }
      const parsed = await readBody()
      if (!parsed.ok) {
        fail(res, parsed.status, 'bad_request', parsed.reason)
        return true
      }
      const issued = issueDestinationChallenge({
        userId,
        withdrawalId,
        address: body(parsed.body).address,
        domain: origin.domain,
        uri: origin.uri,
        sessionHash,
      })
      if (!issued.ok) {
        fail(res, 422, 'destination_challenge_failed', issued.reason)
        return true
      }
      send(res, 201, {
        challenge: issued.fields,
        detail: 'Sign this from the destination wallet. Typing an address is not confirming it.',
      })
      return true
    }

    if (action === 'destination/confirm') {
      const parsed = await readBody()
      if (!parsed.ok) {
        fail(res, parsed.status, 'bad_request', parsed.reason)
        return true
      }
      const input = body(parsed.body)
      const outcome = confirmDestination({
        userId,
        sessionHash,
        withdrawalId,
        address: input.address,
        nonce: input.nonce,
        signature: input.signature,
      })
      if (!outcome.ok) {
        fail(res, 401, 'destination_not_confirmed', outcome.reason)
        return true
      }
      send(res, 200, { withdrawal: readWithdrawalForOwner(withdrawalId, userId) })
      return true
    }

    if (action === 'reserve') {
      const outcome = reserveWithdrawal({ userId, withdrawalId })
      if (!outcome.ok) {
        send(res, outcome.code === 'treasury_unfunded' ? 409 : 422, {
          error: outcome.code,
          detail: outcome.detail,
          signer: TREASURY_SIGNER,
        })
        return true
      }
      send(res, 200, { withdrawal: readWithdrawalForOwner(withdrawalId, userId), idempotent: outcome.idempotent })
      return true
    }

    if (action === 'submit') {
      const outcome = submitWithdrawal({ userId, withdrawalId })
      send(res, outcome.code === 'no_signer' ? 501 : 422, {
        error: outcome.code,
        detail: outcome.detail,
        reason: 'reason' in outcome ? outcome.reason : undefined,
        withdrawal: readWithdrawalForOwner(withdrawalId, userId),
      })
      return true
    }

    if (action === 'cancel') {
      const outcome = cancelWithdrawal({ userId, withdrawalId })
      if (!outcome.ok) {
        fail(res, 409, outcome.code, outcome.detail)
        return true
      }
      send(res, 200, {
        withdrawal: readWithdrawalForOwner(withdrawalId, userId),
        releasedGold: outcome.releasedGold,
        releasedLamports: outcome.releasedLamports,
        detail: 'Reservation released. Cancelling returns budget; it does not reverse a settled payment.',
      })
      return true
    }
  }

  const withdrawalRead = /^\/api\/withdrawals\/(wd_[0-9a-f]{32})$/.exec(path)
  if (method === 'GET' && withdrawalRead) {
    const view = readWithdrawalForOwner(withdrawalRead[1], userId)
    if (!view) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { withdrawal: view, signer: TREASURY_SIGNER })
    return true
  }

  fail(res, 404, 'not_found')
  return true
}
