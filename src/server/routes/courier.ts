/* ------------------------------------------------------------------ *
 * Sable's shielded courier desk, over HTTP.
 *
 * Four stages of the pipeline in `src/server/providers/courier.ts` are
 * reachable from here and the fifth is not:
 *
 *   GET  /api/courier           what the desk is, both halves, before anything
 *   POST /api/courier/address   stage 1 — parse and classify the destination
 *   POST /api/courier/quote     stages 2, 3 and 4 — price it, describe it,
 *                               freeze it into an intent that then goes nowhere
 *
 * There is no fourth route. `fundDeposit` is not called from this module, no
 * handler here can obtain a deposit address — `dryQuote` hardcodes `dry: true`
 * and throws if one ever comes back — and no gold, escrow or ledger account is
 * touched by any of it. The desk is `read-only` in the catalogue for exactly
 * that reason.
 *
 * ---- The player's address is the sensitive value here ---------------------
 *
 * Not a credential, but a lasting one: a Zcash address that has been seen next
 * to a player's session is a link between a person and a shielded wallet, and
 * it is the one thing this feature handles that a player cannot rotate. Three
 * rules follow, and they are enforced in this file rather than remembered:
 *
 *   - **Nothing here logs.** Not on success, not on failure, not on an
 *     unexpected throw. The outermost handler catches everything so that an
 *     error carrying an address cannot reach `safeError` in index.ts, which
 *     scrubs RPC credentials and knows nothing about Zcash addresses.
 *   - **No response echoes it.** Refusals are fixed copy from
 *     `DESTINATION_REFUSALS`, never the provider's `detail`, and any upstream
 *     message that so much as rhymes with the address is dropped by
 *     `echoesAddress` below rather than trimmed.
 *   - **Nothing stores it.** `recordIntent` builds its record and the record
 *     is serialised into the reply and dropped on the floor. No row is
 *     written, because there is no later stage for a row to be read by.
 * ------------------------------------------------------------------ */

import { walletFromAuthHeader } from '../auth'
import { resolveUserForPrincipal } from '../identity/users'
import { overBudget, retryAfterSeconds, type Budget } from '../net'
import { PAYOUTS_ENABLED } from '../config'
import {
  COURIER_DRY_REFUND_TO,
  DESTINATION_REFUSALS,
  PRIVACY_STATEMENT,
  acceptDestination,
  describeDesk,
  describeQuote,
  formatSol,
  formatZec,
  quoteCourierRun,
  recordIntent,
  type AcceptedDestination,
} from '../providers/courier'
import { ZCASH_ADDRESS_SDK } from '../providers/zcashAddress'
import type { RouteContext } from './account'

const PREFIX = '/api/courier'

/**
 * Tighter than the general API budget, and keyed to the session.
 *
 * Every quote is an outbound call to a third party that is not being paid for
 * it, so this is as much their budget as ours. Classification is counted the
 * same way because it loads a WASM parser.
 */
const DESK_BUDGET: Budget = { windowMs: 60_000, max: 20 }

/**
 * How much SOL may be named in a quote.
 *
 * Not a spending limit — nothing is spent, and the real ceiling on a funded
 * run would be `WALLY_COURIER_MAX_LAMPORTS_PER_RUN`, which has no value and no
 * default. This is only the range in which asking a pricing endpoint for a
 * number is a sensible thing to do: below the floor every route quotes dust,
 * and above the ceiling the figure says nothing about what a player would
 * actually convert.
 */
const MIN_LAMPORTS = 10_000_000n
const MAX_LAMPORTS = 100_000_000_000n

/** Matches the deadline `scripts/verify-zec-delivery.ts` sends, for the same reason: long enough that a slow reader does not expire mid-sentence. */
const QUOTE_LIFE_MS = 30 * 60_000

/** One percent. The provider requires a tolerance even on a dry quote. */
const SLIPPAGE_BPS = 100

/* ------------------------------------------------------------------ *
 * Keeping the address out of everything that is not the reply
 * ------------------------------------------------------------------ */

/**
 * True when `text` shares any sixteen-character run with `address`.
 *
 * A binary test rather than a substitution, because a partial echo is the
 * shape this has to catch: an upstream validator that quotes the first forty
 * characters of a recipient back at you would sail past a whole-string
 * replace. When this fires the upstream message is discarded entirely instead
 * of being patched, which is the only version of this with no residue.
 */
function echoesAddress(text: string, address: string): boolean {
  const needle = address.trim()
  if (needle.length < 16) return false
  for (let index = 0; index + 16 <= text.length; index += 1) {
    if (needle.includes(text.slice(index, index + 16))) return true
  }
  return false
}

const SUPPRESSED =
  'The conversion endpoint refused to price this, and its reply quoted the address back, so the reply ' +
  'is not repeated here. Try again in a moment.'

const safeDetail = (detail: string, address: string): string =>
  echoesAddress(detail, address) ? SUPPRESSED : detail.slice(0, 400)

/* ------------------------------------------------------------------ *
 * The amount
 * ------------------------------------------------------------------ */

type AmountResult = { ok: true; lamports: bigint } | { ok: false; detail: string }

/**
 * Decimal SOL to integer lamports, by string surgery.
 *
 * `Number` is never involved. A float cannot hold 0.1 SOL exactly and this
 * value is sent to a pricing endpoint as the thing being converted, so the
 * digits a player typed are the digits that go out.
 */
function lamportsFromSol(value: unknown): AmountResult {
  const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (!/^[0-9]{1,6}(\.[0-9]{1,9})?$/.test(text)) {
    return { ok: false, detail: 'Amount must be a plain number of SOL, with at most nine decimal places.' }
  }
  const [whole, fraction = ''] = text.split('.')
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  if (lamports < MIN_LAMPORTS) {
    return { ok: false, detail: `The smallest amount this desk will price is ${formatSol(MIN_LAMPORTS)} SOL.` }
  }
  if (lamports > MAX_LAMPORTS) {
    return { ok: false, detail: `The largest amount this desk will price is ${formatSol(MAX_LAMPORTS)} SOL.` }
  }
  return { ok: true, lamports }
}

/* ------------------------------------------------------------------ *
 * What the desk says about itself
 * ------------------------------------------------------------------ */

/**
 * The desk, as `describeDesk` builds it, plus the two things only this layer
 * knows: who keeps it, and which parser is installed in this deployment.
 */
const deskView = () => {
  const described = describeDesk({ minLamports: MIN_LAMPORTS, maxLamports: MAX_LAMPORTS })
  return {
    npc: 'SABLE · ALCHEMIST',
    serviceId: 'alchemy.shielded-note',
    title: 'Shielded courier desk',
    ...described,
    accepts: {
      ...described.accepts,
      parser: { ...ZCASH_ADDRESS_SDK, note: 'ZIP-316 receiver parsing. The prefix is never read.' },
    },
    /** A different switch about a different thing, restated so the two are not confused. */
    goldToTokenPayoutsEnabled: PAYOUTS_ENABLED,
  }
}

/* ------------------------------------------------------------------ *
 * Stage 1
 * ------------------------------------------------------------------ */

type Classified =
  | { ok: true; destination: AcceptedDestination }
  | { ok: false; status: number; body: Record<string, unknown> }

async function classify(raw: unknown): Promise<Classified> {
  const result = await acceptDestination(raw)
  if (result.ok) return { ok: true, destination: result.destination }

  // `code` is always set on a failure from `acceptDestination`, but the type
  // does not say so, and `unparseable` is the refusal that assumes least about
  // an address nothing could read.
  const copy = DESTINATION_REFUSALS[result.code ?? 'unparseable']
  return {
    ok: false,
    status: 422,
    // The provider's own `detail` is deliberately absent: it is written for a
    // log, and the parser's version of it quotes the decoder's view of the
    // input. The player gets `says` and `doThis`, which are fixed text.
    body: { error: 'destination_refused', code: result.code ?? 'unparseable', ...copy },
  }
}

const receiverView = (destination: AcceptedDestination) => ({
  receivers: destination.parsed.receivers,
  shieldedOnly: destination.parsed.shieldedOnly,
})

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export async function handleCourierHttp(context: RouteContext): Promise<boolean> {
  const { req, res, path, method, send, fail, readBody } = context
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false

  if (method === 'GET' && path === PREFIX) {
    send(res, 200, deskView())
    return true
  }

  if (method !== 'POST' || (path !== `${PREFIX}/address` && path !== `${PREFIX}/quote`)) {
    fail(res, 404, 'not_found')
    return true
  }

  // Identity from the session, never from the body — the same rule the rest of
  // the API follows. It buys nothing here; it is what keeps one player from
  // spending another player's share of a third party's pricing endpoint.
  const principal = walletFromAuthHeader(req.headers.authorization)
  if (!principal) {
    fail(res, 401, 'unauthenticated', 'This desk needs a session with the world server.')
    return true
  }
  const { userId } = resolveUserForPrincipal(principal)

  const budgetKey = `courier:${userId}`
  if (overBudget(budgetKey, DESK_BUDGET)) {
    res.setHeader('Retry-After', String(retryAfterSeconds(budgetKey)))
    fail(res, 429, 'rate_limited', 'The desk is pricing too many runs for you at once. Wait a minute.')
    return true
  }

  const parsed = await readBody()
  if (!parsed.ok) {
    fail(res, parsed.status, 'bad_request', parsed.reason)
    return true
  }
  const body = (parsed.body ?? {}) as Record<string, unknown>
  const rawAddress = body.address

  /*
   * Everything below touches the address, so all of it sits inside one catch.
   * An exception escaping here would be printed by the unhandled-error path in
   * index.ts, and that scrubber knows about RPC endpoints and bearer tokens —
   * not about Zcash addresses. Nothing is logged; the caller gets a fixed line.
   */
  try {
    const classified = await classify(rawAddress)
    if (!classified.ok) {
      send(res, classified.status, classified.body)
      return true
    }
    const destination = classified.destination

    if (path === `${PREFIX}/address`) {
      send(res, 200, {
        accepted: true,
        ...receiverView(destination),
        says:
          'This address exposes an Orchard receiver and no transparent one, so there is no public ' +
          'receiver in it for a payment to land on instead. That is the only shape this route prices.',
        statement: { ...PRIVACY_STATEMENT },
      })
      return true
    }

    const amount = lamportsFromSol(body.sol)
    if (!amount.ok) {
      fail(res, 400, 'bad_amount', amount.detail)
      return true
    }

    const now = Date.now()
    const quoted = await quoteCourierRun({
      destination,
      lamports: amount.lamports,
      refundTo: (process.env.WALLY_COURIER_TREASURY_ADDRESS ?? '').trim() || COURIER_DRY_REFUND_TO,
      slippageToleranceBps: SLIPPAGE_BPS,
      deadlineIso: new Date(now + QUOTE_LIFE_MS).toISOString(),
    })
    if (!quoted.ok) {
      send(res, 502, {
        error: 'not_priced',
        detail: safeDetail(quoted.detail, destination.address),
        statement: { ...PRIVACY_STATEMENT },
      })
      return true
    }

    const quote = quoted.quote
    const described = describeQuote(quote)

    // Stage 4. The record is built, checked against the quote it came from, and
    // then written into this response and nowhere else.
    const frozen = recordIntent({
      ownerUserId: userId,
      destination,
      quote,
      expiresAtMs: now + QUOTE_LIFE_MS,
      now,
    })

    send(res, 200, {
      dry: true,
      depositAddress: null,
      destination: receiverView(destination),
      quote: {
        headline: described.headline,
        worstCase: described.worstCase,
        sol: formatSol(quote.lamportsIn),
        zec: formatZec(quote.zatoshisOut),
        minZec: formatZec(quote.minZatoshisOut),
        timeEstimateSeconds: quote.timeEstimateSeconds,
        correlationId: quote.correlationId,
        signatureVerified: quote.signatureVerified,
        quotedAtMs: quote.quotedAtMs,
      },
      // Both halves, from the constant, exactly as `describeQuote` returned
      // them. Not re-worded here, and not reduced to the headline.
      statement: {
        delivers: described.delivers,
        doesNotHide: described.doesNotHide,
        cannotProve: described.cannotProve,
      },
      verdict: {
        verdict: quote.assessment.verdict,
        deliveredReceiver: quote.assessment.deliveredReceiver,
        explanation: quote.assessment.explanation,
        documentedSupport: quote.assessment.documentedSupport,
        documentedSupportUrl: quote.assessment.documentedSupportUrl,
      },
      intent: frozen.ok
        ? {
            intentId: frozen.intent.intentId,
            state: frozen.intent.state,
            receivers: frozen.intent.destinationReceivers,
            requirement: frozen.intent.requirement,
            expiresAtMs: frozen.intent.expiresAtMs,
            note:
              'This record exists in this reply and nowhere else. No row was written, nothing is queued, ' +
              'and the stage that would come next cannot run.',
          }
        : null,
      stops: deskView().stops,
    })
    return true
  } catch {
    // Deliberately swallowed. The error object may quote the address, and there
    // is no sink in this process that is safe to hand it to.
    fail(
      res,
      500,
      'desk_error',
      'The desk could not complete that. Nothing was sent anywhere and nothing was recorded.',
    )
    return true
  }
}
