/* ------------------------------------------------------------------ *
 * The privacy courier pipeline: gold → SOL → shielded ZEC.
 *
 *   player pays gold
 *     → treasury signing service sends SOL to the 1Click deposit address
 *       → 1Click delivers ZEC to the player's Zcash address
 *
 * Everything up to the arrow that spends money is implemented and exercised
 * here. The stages are, in the order value would move:
 *
 *   1. `acceptDestination`  parse the player's address with the ZIP-316 parser
 *                           and classify its receivers. Never looks at the
 *                           prefix.
 *   2. `quoteCourierRun`    price the leg with a **dry** 1Click quote and
 *                           produce an assessment of where it would land.
 *   3. `describeQuote`      the sentence shown to the player, including the
 *                           parts that are not reassuring.
 *   4. `recordIntent`       freeze the quote, the address and the verdict into
 *                           a record that later stages compare against.
 *   5. `fundDeposit`        needs the treasury signer. Fails closed.
 *
 * ---- Why the address rule is this strict ----------------------------------
 *
 * `oneclick.ts` will only report `deliveredReceiver: 'shielded'` for an address
 * that exposes an Orchard receiver and no transparent one. This file turns that
 * into the product rule: a private courier run **requires** a shielded-only
 * Orchard address, and anything else is refused with a reason the player can
 * act on rather than quietly downgraded.
 *
 * That looks harsh — most wallets hand out a unified address that includes a
 * transparent receiver — but it is the only version of this feature that can be
 * honestly described. With a transparent receiver present, the executor picks,
 * we cannot see which it picked, and "private" becomes a hope. With it absent,
 * there is no public receiver in the address for the money to land on.
 *
 * ---- What this pipeline does not promise -----------------------------------
 *
 * The player's *entry* is public: gold is bought and the treasury's SOL
 * transfer to the deposit address is an ordinary Solana transaction that anyone
 * can read, forever. The provider also knows the deposit address, the amount
 * and the destination address, and this code cannot make it forget them. What
 * the shielded leg changes is what the *Zcash* chain records about the payout,
 * and that is the only claim `PRIVACY_STATEMENT` makes.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import type { ReceiverRequirement } from '../../shared/authorization'
import {
  ONECLICK_PROVIDER_ID,
  ZEC_DELIVERY_UNVERIFIABLE_BY_DESIGN,
  ZEC_EXECUTOR,
  ZEC_NATIVE_ASSET_ID,
  classifyZecDelivery,
  configureOneClickAuth,
  dryQuote,
  planZecPayout,
  type ZecDeliveryAssessment,
} from './oneclick'
import { parseZcashAddress, type ParsedZcashAddress, type ZcashNetwork } from './zcashAddress'
import { envPresent, providerFailure, type AdapterResult } from './types'

export const COURIER_SERVICE_ID = 'courier.sol-to-shielded-zec'

/** The origin asset for the Solana leg, as 1Click names it. */
export const COURIER_ORIGIN_ASSET_ID = 'nep141:sol.omft.near'

/**
 * What the player is told, in full.
 *
 * Written out as a constant rather than assembled at the call site so that the
 * unflattering half cannot be dropped by a caller that only wanted the
 * headline. The test asserts both halves are present.
 */
export const PRIVACY_STATEMENT = {
  delivers:
    'Your ZEC arrives as a shielded Orchard payment. The Zcash chain records that a payment happened and ' +
    'its fee, but not the amount and not your address.',
  doesNotHide:
    'Buying in is public and stays public. The payment that funds this run is an ordinary Solana ' +
    'transaction that anyone can read, permanently, and the conversion provider sees the amount, the ' +
    'deposit address and the Zcash address you gave us. Nothing here deletes any of that.',
  cannotProve: ZEC_DELIVERY_UNVERIFIABLE_BY_DESIGN,
} as const

/* ------------------------------------------------------------------ *
 * 1. The destination address
 * ------------------------------------------------------------------ */

export type DestinationRefusal =
  | 'unparseable'
  | 'no-shielded-receiver'
  | 'transparent-receiver-present'
  | 'sapling-without-orchard'
  | 'unknown-receivers-only'

export interface AcceptedDestination {
  readonly address: string
  readonly parsed: ParsedZcashAddress
  /** True only for an Orchard receiver with no transparent receiver. */
  readonly privateCapable: boolean
}

/**
 * Validates a player-supplied Zcash address for a private courier run.
 *
 * The refusals are separate codes rather than one boolean because they need
 * different things from the player: a transparent-bearing unified address means
 * "ask your wallet for a shielded-only one", a Sapling address means "your
 * wallet is too old for this route", and an unparseable string means "that is
 * not a Zcash address". Collapsing them into "invalid address" would leave a
 * player with a perfectly good wallet unable to work out what to do.
 */
export async function acceptDestination(
  address: unknown,
  requirement: ReceiverRequirement = 'shielded-required',
  network: ZcashNetwork = 'main',
): Promise<AdapterResult<{ destination: AcceptedDestination }> & { code?: DestinationRefusal }> {
  if (typeof address !== 'string' || !address.trim()) {
    return { ...providerFailure('validation-error', 'a Zcash address is required'), code: 'unparseable' }
  }

  const result = await parseZcashAddress(address, network)
  if (!result.ok) return { ...result, code: 'unparseable' as const }
  const parsed = result.parsed

  if (parsed.receivers.length === 0) {
    return {
      ...providerFailure(
        'unsupported',
        `this address carries only receiver typecodes this build does not understand ` +
          `([${parsed.unknownTypecodes.join(', ')}]). ZIP-316 says to treat it as unusable rather than ` +
          'guess, so it is refused.',
      ),
      code: 'unknown-receivers-only' as const,
    }
  }

  const orchard = parsed.receivers.includes('orchard')
  const privateCapable = orchard && !parsed.hasTransparentReceiver

  if (requirement === 'transparent-allowed') {
    if (!parsed.hasTransparentReceiver && !orchard) {
      return {
        ...providerFailure(
          'unsupported',
          'this address exposes neither a transparent nor an Orchard receiver, and the route can pay ' +
            'into neither of the others.',
        ),
        code: 'sapling-without-orchard' as const,
      }
    }
    return { ok: true, destination: { address: parsed.address, parsed, privateCapable } }
  }

  if (!parsed.hasShieldedReceiver) {
    return {
      ...providerFailure(
        'unsupported',
        'this is a transparent-only address. A private run needs a shielded address; delivering here ' +
          'would put the payment on the public chain under a private promise.',
      ),
      code: 'no-shielded-receiver' as const,
    }
  }

  if (!orchard) {
    return {
      ...providerFailure(
        'unsupported',
        'this address offers a Sapling receiver but no Orchard receiver. The provider rejects ' +
          'Sapling-only recipients outright, and the connector that executes the payout builds Orchard ' +
          'outputs. A wallet that supports Orchard will give you an address this route can pay.',
      ),
      code: 'sapling-without-orchard' as const,
    }
  }

  if (parsed.hasTransparentReceiver) {
    return {
      ...providerFailure(
        'unsupported',
        'this unified address contains a transparent receiver alongside its shielded one. The sender ' +
          'chooses which receiver to pay and that choice is not visible to us, so this address cannot be ' +
          'promised as private. Most wallets can produce a shielded-only address; please use one.',
      ),
      code: 'transparent-receiver-present' as const,
    }
  }

  return { ok: true, destination: { address: parsed.address, parsed, privateCapable } }
}

/**
 * The same five refusals, written for somebody standing at the desk.
 *
 * Kept here rather than in the UI so the words cannot drift away from the code
 * that decides them, and kept as five entries rather than a lookup with a
 * default so adding a sixth `DestinationRefusal` is a type error instead of a
 * silent fallback to "invalid address".
 *
 * `doThis` is the field that earns this constant. The `detail` strings above
 * explain why a refusal happened, which is what an operator reading a log
 * needs; a player needs the next move, and those are five different next
 * moves. `transparent-receiver-present` gets the longest one because it is the
 * case nearly everybody hits — a unified address bundles a transparent
 * receiver so that anyone at all can pay it — and a player whose wallet is
 * working perfectly has to be told that, or they will go looking for a fault
 * that is not there.
 *
 * Nothing here quotes the address back. These strings are fixed text that
 * reaches the response and the screen; the address never does.
 */
export const DESTINATION_REFUSALS: Record<
  DestinationRefusal,
  { readonly headline: string; readonly says: string; readonly doThis: string }
> = {
  unparseable: {
    headline: 'NOT A ZCASH ADDRESS',
    says:
      'The ZIP-316 parser could not read that as a Zcash mainnet address at all. It was not looked up ' +
      'anywhere and it was not sent anywhere.',
    doThis:
      'Copy the receiving address out of your Zcash wallet again — the whole string, with no spaces and ' +
      'nothing trimmed off either end. A Bitcoin, Ethereum or Solana address will not parse here, and ' +
      'neither will a testnet one.',
  },
  'no-shielded-receiver': {
    headline: 'TRANSPARENT ADDRESS · NOTHING SHIELDED IN IT',
    says:
      'That address parses, and every receiver in it is transparent. A payment to it would sit on the ' +
      'public Zcash chain with the amount and the address in plain view, which is the opposite of what ' +
      'this desk is for.',
    doThis:
      'Ask your wallet for a shielded receiving address instead of the one beginning t1 or t3. In most ' +
      'wallets the shielded or unified address is offered alongside it on the same receive screen.',
  },
  'transparent-receiver-present': {
    headline: 'UNIFIED ADDRESS · CARRIES A TRANSPARENT RECEIVER',
    says:
      'That address parses as a unified address holding a shielded receiver and a transparent one. Which ' +
      'of the two a sender pays is the sender\u2019s choice and is not visible from outside, so this ' +
      'address cannot be quoted as private: it could land in public.',
    doThis:
      'This is the ordinary case and not a fault with your wallet — a unified address usually bundles a ' +
      'transparent receiver so that anyone at all can pay it. What you need is a shielded-only address: ' +
      'on your wallet\u2019s receive screen look for the address it calls shielded, private or Orchard, ' +
      'and if it lets you choose which receivers to include, include Orchard and leave transparent out. ' +
      'Paste that one here.',
  },
  'sapling-without-orchard': {
    headline: 'SAPLING ONLY · THIS ROUTE BUILDS ORCHARD OUTPUTS',
    says:
      'That address offers a Sapling receiver and no Orchard one. The conversion provider rejects ' +
      'Sapling-only recipients outright, and the connector that would execute the Zcash leg is only ever ' +
      'observed building Orchard outputs.',
    doThis:
      'Your wallet is either older than Orchard or still handing out Sapling addresses by choice. Update ' +
      'it, or move to a wallet that supports Orchard, and take a shielded-only address from that. An ' +
      'address beginning zs1 will never be quotable here.',
  },
  'unknown-receivers-only': {
    headline: 'RECEIVERS THIS BUILD CANNOT READ',
    says:
      'That address parses, and every receiver in it carries a typecode this deployment has never heard ' +
      'of. ZIP-316 says an address like that must be treated as unusable rather than guessed at, so it ' +
      'is refused.',
    doThis:
      'This one is at our end, not yours: your wallet is ahead of the parser running here. Use an address ' +
      'that exposes an Orchard receiver, or come back once this deployment has caught up.',
  },
}

/* ------------------------------------------------------------------ *
 * 2. The quote
 * ------------------------------------------------------------------ */

/**
 * The refund field sent on a dry quote when no treasury address is configured.
 *
 * The Solana system program's address, which is not a wallet and cannot hold a
 * balance. A dry quote moves nothing and returns no deposit address, so this
 * field is only ever a parameter the validator inspects — but it still has to
 * be *some* address, and inventing a plausible-looking one would put a string
 * on screen that reads like a treasury this project does not have. The same
 * value is used by `scripts/verify-zec-delivery.ts`, for the same reason.
 *
 * `WALLY_COURIER_TREASURY_ADDRESS` takes precedence where an operator has set
 * one. That does not bring funding any closer: `fundDeposit` still needs a
 * signer, and there is none.
 */
export const COURIER_DRY_REFUND_TO = '11111111111111111111111111111112'

export interface CourierQuoteInput {
  readonly destination: AcceptedDestination
  /** Integer lamports the treasury would send. */
  readonly lamports: bigint
  /** Solana address a failed conversion refunds to. The treasury, not the player. */
  readonly refundTo: string
  readonly slippageToleranceBps: number
  readonly deadlineIso: string
  readonly requirement?: ReceiverRequirement
}

export interface CourierQuote {
  readonly lamportsIn: bigint
  readonly zatoshisOut: bigint
  readonly minZatoshisOut: bigint
  readonly timeEstimateSeconds: number | null
  readonly assessment: ZecDeliveryAssessment
  readonly correlationId: string
  readonly signatureVerified: boolean
  readonly quotedAtMs: number
}

/**
 * Prices the leg and decides whether it may be offered.
 *
 * The quote is always `dry`: `dryQuote` hardcodes it and throws if a deposit
 * address ever comes back, so no code path here can obtain one. A quote that
 * the policy check then refuses is returned as a failure rather than as a
 * quote with a warning attached, because a warning is something a caller can
 * forget to read.
 */
export async function quoteCourierRun(input: CourierQuoteInput): Promise<AdapterResult<{ quote: CourierQuote }>> {
  if (input.lamports <= 0n) {
    return providerFailure('validation-error', 'lamports must be greater than zero')
  }

  configureOneClickAuth()
  const quoted = await dryQuote({
    originAssetId: COURIER_ORIGIN_ASSET_ID,
    destinationAssetId: ZEC_NATIVE_ASSET_ID,
    amountBaseUnits: input.lamports,
    recipient: input.destination.address,
    refundTo: input.refundTo,
    slippageToleranceBps: input.slippageToleranceBps,
    deadlineIso: input.deadlineIso,
  })

  const requirement = input.requirement ?? 'shielded-required'
  const assessment = classifyZecDelivery({
    recipient: input.destination.address,
    parsedReceivers: input.destination.parsed.receivers,
    quoteAccepted: quoted.ok,
    quoteHttpStatus: quoted.ok
      ? quoted.quote.httpStatus
      : 'httpStatus' in quoted && typeof quoted.httpStatus === 'number'
        ? quoted.httpStatus
        : null,
  })

  if (!quoted.ok) {
    return providerFailure(
      quoted.reason === 'missing-configuration' ? 'provider-error' : quoted.reason,
      `the conversion could not be priced: ${quoted.detail} — ${assessment.explanation}`,
    )
  }

  const plan = planZecPayout({ requirement, assessment })
  if (!plan.usable) return providerFailure('unsupported', plan.refusal ?? 'this route may not be used')

  return {
    ok: true,
    quote: {
      lamportsIn: quoted.quote.amountInBaseUnits,
      zatoshisOut: quoted.quote.amountOutBaseUnits,
      minZatoshisOut: quoted.quote.minAmountOutBaseUnits,
      timeEstimateSeconds: quoted.quote.timeEstimateSeconds,
      assessment,
      correlationId: quoted.quote.correlationId,
      signatureVerified: quoted.quote.signatureVerified,
      quotedAtMs: quoted.quote.observedAtMs,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 3. What the player is shown
 * ------------------------------------------------------------------ */

export interface QuoteDescription {
  readonly headline: string
  readonly delivers: string
  readonly doesNotHide: string
  readonly cannotProve: string
  readonly worstCase: string
}

/**
 * The player-facing description of a quote.
 *
 * `minZatoshisOut` is what the worst-case line quotes, not `zatoshisOut`. The
 * expected amount is the number a player will remember and the minimum is the
 * number they are actually agreeing to, and showing only the first is how a
 * quote becomes a complaint.
 */
export function describeQuote(quote: CourierQuote): QuoteDescription {
  return {
    headline:
      `${formatZec(quote.zatoshisOut)} ZEC for ${formatSol(quote.lamportsIn)} SOL` +
      (quote.timeEstimateSeconds === null ? '' : `, usually within ${quote.timeEstimateSeconds} seconds`),
    delivers: PRIVACY_STATEMENT.delivers,
    doesNotHide: PRIVACY_STATEMENT.doesNotHide,
    cannotProve: PRIVACY_STATEMENT.cannotProve,
    // No gold is named here. This line used to end "and your gold is returned",
    // written for a route that spent gold; nothing does, and the sentence is now
    // read by a player at a desk that takes no payment of any kind, where it is
    // simply untrue. The refund it describes is the provider's own behaviour.
    worstCase:
      `If the price moves you will receive at least ${formatZec(quote.minZatoshisOut)} ZEC. Below that the ` +
      'conversion is refunded rather than filled, so the run does not go through at a worse rate than this.',
  }
}

/**
 * What the desk is, before a player has typed anything.
 *
 * Lives beside `describeQuote` rather than in the HTTP layer for the same
 * reason that one does: it is the player-facing account of this pipeline, and
 * a route that assembled it field by field would be a route that could leave a
 * field out. `PRIVACY_STATEMENT` is spread whole, so dropping `doesNotHide`
 * would have to be done on purpose.
 *
 * `stops` is not an apology and not a roadmap. It names the stage this route
 * does not reach, the absence that stops it, and the three settings that would
 * still not be enough — which is the shape `/api/withdrawals` already reports
 * the treasury in, so an operator reading both sees the same absence twice
 * rather than two different stories.
 */
export function describeDesk(bounds: { minLamports: bigint; maxLamports: bigint }) {
  return {
    statement: { ...PRIVACY_STATEMENT },
    stops: {
      at: 'stage 5 of 5 — funding the deposit',
      signer: { available: COURIER_SIGNER.available, reason: COURIER_SIGNER.reason },
      // Presence only, never the value — `envPresent` exists so that a report
      // can say which decisions an operator has made without disclosing any of
      // them. All three being set would still leave the signer absent.
      configuration: (Object.keys(COURIER_CONFIG_KEYS) as CourierConfigKey[]).map(key => ({
        key,
        what: COURIER_CONFIG_KEYS[key],
        set: envPresent(key),
      })),
      depositAddress: null,
      depositAddressReason:
        'Every quote this desk asks for is dry. A dry quote returns a price and no deposit address, and ' +
        'the adapter throws rather than continue if one ever appears in a reply. There is nowhere to send ' +
        'money even if there were anything here able to send it.',
      goldInvolved: false,
    },
    accepts: {
      network: 'main' as const,
      requirement: 'shielded-required' as const,
      minSol: formatSol(bounds.minLamports),
      maxSol: formatSol(bounds.maxLamports),
      executor: ZEC_EXECUTOR.connectorContract,
    },
    /** All five, so a client holds the vocabulary rather than inventing a default. */
    refusals: (Object.keys(DESTINATION_REFUSALS) as DestinationRefusal[]).map(code => ({
      code,
      ...DESTINATION_REFUSALS[code],
    })),
  }
}

/** ZEC has 8 decimals. Integer string formatting only; no float arithmetic. */
export function formatZec(zatoshis: bigint): string {
  return formatUnits(zatoshis, 8)
}

/** SOL has 9 decimals. */
export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, 9)
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/* ------------------------------------------------------------------ *
 * 4. The intent record and its state machine
 * ------------------------------------------------------------------ */

export type CourierState =
  | 'quoted'
  | 'intent_recorded'
  | 'awaiting_deposit'
  | 'deposit_submitted'
  | 'delivered'
  | 'refunded'
  | 'failed'
  | 'expired'

/**
 * The transition table, as data, in the same shape as the withdrawal machine.
 *
 * Three properties are enforced structurally rather than by convention.
 * `delivered` and `refunded` are terminal, so nothing can re-run a completed
 * conversion. `deposit_submitted` cannot reach `expired`, because a deadline
 * passing after money has been sent is a refund question and not a tidy-up.
 * And `awaiting_deposit` can reach `expired` directly, which is the ordinary
 * path for a quote nobody funded.
 */
export const COURIER_TRANSITIONS: Record<CourierState, readonly CourierState[]> = {
  quoted: ['intent_recorded', 'expired', 'failed'],
  intent_recorded: ['awaiting_deposit', 'expired', 'failed'],
  awaiting_deposit: ['deposit_submitted', 'expired', 'failed'],
  deposit_submitted: ['delivered', 'refunded', 'failed'],
  delivered: [],
  refunded: [],
  failed: [],
  expired: [],
}

export const canTransition = (from: CourierState, to: CourierState): boolean =>
  COURIER_TRANSITIONS[from].includes(to)

export interface CourierIntent {
  readonly intentId: string
  readonly state: CourierState
  readonly ownerUserId: string
  readonly destination: string
  /** Frozen at record time so a later stage cannot be handed a different address. */
  readonly destinationReceivers: readonly string[]
  readonly requirement: ReceiverRequirement
  readonly lamports: bigint
  readonly minZatoshisOut: bigint
  readonly verdict: ZecDeliveryAssessment['verdict']
  readonly deliveredReceiver: ZecDeliveryAssessment['deliveredReceiver']
  readonly correlationId: string
  readonly providerId: string
  readonly recordedAtMs: number
  readonly expiresAtMs: number
}

/**
 * Freezes a quote into an intent.
 *
 * The verdict and the receiver set are copied onto the record rather than
 * referenced, so that `fundDeposit` checks what was actually approved instead of
 * re-deriving it from an address that could have been swapped underneath.
 */
export function recordIntent(input: {
  ownerUserId: string
  destination: AcceptedDestination
  quote: CourierQuote
  requirement?: ReceiverRequirement
  expiresAtMs: number
  now?: number
}): AdapterResult<{ intent: CourierIntent }> {
  const requirement = input.requirement ?? 'shielded-required'
  const now = input.now ?? Date.now()

  if (input.expiresAtMs <= now) {
    return providerFailure('validation-error', 'an intent cannot be recorded with an expiry in the past')
  }
  if (requirement === 'shielded-required' && input.quote.assessment.deliveredReceiver !== 'shielded') {
    return providerFailure(
      'unsupported',
      'refusing to record a shielded intent whose assessment does not say shielded. ' +
        input.quote.assessment.explanation,
    )
  }
  if (input.quote.assessment.recipient !== input.destination.address) {
    return providerFailure(
      'validation-error',
      'the quote was priced for a different address than the one being recorded',
    )
  }

  return {
    ok: true,
    intent: {
      intentId: `cr_${randomBytes(16).toString('hex')}`,
      state: 'intent_recorded',
      ownerUserId: input.ownerUserId,
      destination: input.destination.address,
      destinationReceivers: [...input.destination.parsed.receivers],
      requirement,
      lamports: input.quote.lamportsIn,
      minZatoshisOut: input.quote.minZatoshisOut,
      verdict: input.quote.assessment.verdict,
      deliveredReceiver: input.quote.assessment.deliveredReceiver,
      correlationId: input.quote.correlationId,
      providerId: ONECLICK_PROVIDER_ID,
      recordedAtMs: now,
      expiresAtMs: input.expiresAtMs,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 5. The treasury seam — fails closed
 * ------------------------------------------------------------------ */

/**
 * Configuration the funded leg would need, and does not have.
 *
 * Separate from `WITHDRAWAL_CONFIG_KEYS` because these are different decisions:
 * the withdrawal keys price gold, and these name the Solana account that would
 * pay and the ceiling it may pay up to. Neither has a default, and a default
 * here would be an operator deciding by omission how much this service may
 * spend.
 */
export const COURIER_CONFIG_KEYS = {
  WALLY_COURIER_TREASURY_ADDRESS:
    'Solana address the courier spends from. Also the refund destination for a conversion that does not fill.',
  WALLY_COURIER_MAX_LAMPORTS_PER_RUN: 'Ceiling on lamports a single courier run may send.',
  WALLY_COURIER_DAILY_LAMPORTS_BUDGET: 'Ceiling on lamports the courier may send across all runs in a day.',
} as const

export type CourierConfigKey = keyof typeof COURIER_CONFIG_KEYS

/**
 * There is no Solana signer in this process, and none can be configured into
 * existence.
 *
 * Mirrors `TREASURY_SIGNER` in `treasury/config.ts` deliberately: the absence is
 * the same absence, and reporting it in the same shape keeps the operator
 * console from implying the courier is closer to running than the withdrawal
 * path is. Setting the three variables above would still leave this false.
 */
export const COURIER_SIGNER = {
  available: false as const,
  reason:
    'No treasury signer exists in this process. It holds no Solana private key and has no signing ' +
    'capability, so it cannot send the SOL that funds a conversion. Adding one is a custody decision, ' +
    'not a configuration change.',
} as const

export type FundDepositResult =
  | {
      ok: false
      code: 'missing_configuration'
      missing: Array<{ key: CourierConfigKey; what: string }>
      detail: string
    }
  | { ok: false; code: 'no_signer'; detail: string; reason: string }
  | { ok: false; code: 'wrong_state' | 'expired' | 'not_private'; detail: string }

/**
 * Would obtain a live deposit address and send the principal to it. Refuses.
 *
 * The order of the checks is the point. State, expiry and the privacy verdict
 * are all re-checked *before* configuration and the signer, so that an operator
 * who eventually sets the variables and attaches a key does not thereby acquire
 * a path that skips them. `no_signer` is the last thing this can say, never the
 * first.
 */
export function fundDeposit(input: { intent: CourierIntent; now?: number }): FundDepositResult {
  const now = input.now ?? Date.now()
  const { intent } = input

  if (intent.state !== 'awaiting_deposit') {
    return {
      ok: false,
      code: 'wrong_state',
      detail: `a courier run must be awaiting its deposit before it can be funded (it is ${intent.state})`,
    }
  }
  if (intent.expiresAtMs <= now) {
    return {
      ok: false,
      code: 'expired',
      detail:
        'this quote has expired. Funding an expired quote risks sending to a deposit address that no ' +
        'longer settles, so it is refused and the run must be re-quoted.',
    }
  }
  if (intent.requirement === 'shielded-required' && intent.deliveredReceiver !== 'shielded') {
    return {
      ok: false,
      code: 'not_private',
      detail:
        `this run was approved as shielded but its recorded verdict is "${intent.verdict}". Funding it ` +
        'would pay a private promise into an address whose pool is not determined.',
    }
  }

  const missing = (Object.keys(COURIER_CONFIG_KEYS) as CourierConfigKey[])
    .filter(key => !(process.env[key] ?? '').trim())
    .map(key => ({ key, what: COURIER_CONFIG_KEYS[key] }))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'missing_configuration',
      missing,
      detail:
        'The courier is not configured. Each value below is a decision the operator has to make; none of ' +
        'them has a default, because a default spending ceiling is an operator deciding by omission.',
    }
  }

  return {
    ok: false,
    code: 'no_signer',
    detail:
      `The run is priced, the destination is a shielded-only Orchard address, and ${ZEC_EXECUTOR.connectorContract} ` +
      'is observed paying such addresses into the Orchard pool. It cannot be funded: there is no treasury signer.',
    reason: COURIER_SIGNER.reason,
  }
}
