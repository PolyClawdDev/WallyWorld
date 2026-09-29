/* ------------------------------------------------------------------ *
 * NEAR Intents 1Click adapter — read-only (§6).
 *
 * Uses the official client, `@defuse-protocol/one-click-sdk-typescript`
 * 0.1.26. Every call in this file is either asset discovery or a quote with
 * `dry: true`, which the API documents as "validate parameters and get a quote
 * without executing the swap". No deposit address is ever used, no funds move,
 * and `prepareDeposit` below refuses rather than moving any.
 *
 * ---- The question this file answers ---------------------------------------
 *
 * Does this route deliver ZEC into a shielded pool, or only to a transparent
 * receiver? The provider's own chain-support page says "⚠️ Partially supported
 * - Transparent addresses only", its OpenAPI schema never mentions a shielded
 * pool, and its quote endpoint nonetheless prices shielded-only addresses. For
 * a long time that looked unresolvable without sending real ZEC.
 *
 * It was resolvable, because 1Click is not the thing that pays. The Zcash leg
 * is executed by NEAR's Omni Bridge connector, which has a public address, a
 * public contract, and a public transaction history. Two read-only
 * observations settle it, and both are recorded in `ZEC_DELIVERY_EVIDENCE`:
 * the quote validator requires a transparent **or an Orchard** receiver and
 * rejects Sapling-only addresses in both encodings; and the connector's wallet
 * is spending transparent UTXOs into Orchard actions with negative
 * valueBalance, in production, most of the time.
 *
 * So the answer is Orchard — but only for an address that leaves no
 * alternative. The structure of this file follows from that one qualification:
 *
 *   - `classifyZecDelivery` returns `deliveredReceiver: 'shielded'` only when
 *     the address exposes an Orchard receiver and **no** transparent receiver.
 *     With both present the sender chooses, the choice is not observable, and
 *     the verdict is `receiver-ambiguous` with `'unknown'` delivery.
 *   - Documented support and observed behaviour stay separate fields. The
 *     documentation is wrong here, and a verdict that overrides a provider's
 *     own words has to keep quoting them.
 *   - `planZecPayout` still refuses rather than downgrading, and there is still
 *     no transparent plan in its return value for a caller to reach by mistake.
 *   - Nothing here has ever funded a deposit. Every call is `dry`.
 * ------------------------------------------------------------------ */

import {
  ApiError,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  type QuoteResponse,
  type TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript'
import type { ObservedReceiver, ReceiverRequirement } from '../../shared/authorization'
import { assertPermitCovers, type ProposedAction, type SpendPermit } from '../policy'
import { readBaseUnits } from '../policy/units'
import {
  deriveState,
  missingConfiguration,
  providerFailure,
  type AdapterResult,
  type Capability,
  type Evidence,
  type IntegrationReport,
} from './types'

export const ONECLICK_PROVIDER_ID = 'near-1click'

export const ONECLICK_SDK = {
  name: '@defuse-protocol/one-click-sdk-typescript',
  version: '0.1.26',
} as const

/** The one native-Zcash-chain asset in the live token list. */
export const ZEC_NATIVE_ASSET_ID = 'nep141:zec.omft.near'

/**
 * Verbatim from the provider's own chain-support page, re-read 2026-09-29.
 *
 * Still says this, and it is still wrong: the observations in
 * `ZEC_DELIVERY_EVIDENCE` below show the route paying into the Orchard pool in
 * production. It is kept because a verdict that contradicts a provider's own
 * documentation has to quote the documentation it is contradicting.
 */
export const ZEC_DOCUMENTED_SUPPORT =
  '⚠️ Partially supported - Transparent addresses only'

export const ZEC_DOCUMENTED_SUPPORT_URL = 'https://docs.near-intents.org/resources/chain-support'

/**
 * The name of the thing that actually executes the Zcash leg.
 *
 * Worth stating separately from 1Click, because 1Click is a quoting and
 * routing front end: the payout is built and broadcast by NEAR's Omni Bridge
 * Zcash connector, and the answer to "what pool does this land in" lives with
 * the connector rather than with the API that priced the swap.
 */
export const ZEC_EXECUTOR = {
  intentsContract: 'intents.near',
  bridgeContract: 'omni.bridge.near',
  connectorContract: 'zcash-connector.bridge.near',
  bridgeToken: 'zec.omft.near',
  /** The connector's transparent UTXO pool, from its own `get_config`. */
  changeAddress: 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua',
} as const

/* ------------------------------------------------------------------ *
 * What was actually observed
 *
 * Read-only, reproducible by `npm run verify:zec-delivery`. The distinction
 * that matters throughout: `documented` rows are claims a provider makes,
 * `observed` rows are things that were measured. Only the observed rows move a
 * verdict, and the documented rows are retained precisely because they
 * disagree.
 * ------------------------------------------------------------------ */

export interface DeliveryEvidenceItem {
  readonly kind: 'documented' | 'observed'
  readonly url: string
  /** Verbatim where the source is text; a measurement where it is not. */
  readonly quote: string
  readonly bearing: string
}

export const ZEC_DELIVERY_EVIDENCE: readonly DeliveryEvidenceItem[] = [
  {
    kind: 'documented',
    url: ZEC_DOCUMENTED_SUPPORT_URL,
    quote: ZEC_DOCUMENTED_SUPPORT,
    bearing:
      'The provider says transparent only. Contradicted by every observed row below, so it is treated as stale rather than authoritative.',
  },
  {
    kind: 'documented',
    url: 'https://github.com/Near-One/bridge-sdk-js/blob/main/docs/guides/bitcoin.mdx',
    quote: 'Zcash only supports transparent addresses (`t1...`). Shielded addresses are not supported.',
    bearing: 'The bridge maintainer’s own guide agrees with 1Click’s page, and is also contradicted by the chain.',
  },
  {
    kind: 'documented',
    url: 'https://github.com/Near-One/bridge-sdk-js/blob/main/packages/core/src/types.ts',
    quote:
      'Optional memo to attach on the destination chain. Currently supported for Zcash shielded recipients, where memos are limited to 512 bytes.',
    bearing:
      'The same repository, in code rather than prose, states that Zcash shielded recipients exist. This is the documentation catching up, and it points the same way the chain does.',
  },
  {
    kind: 'documented',
    url: 'https://github.com/Near-One/omni-bridge/blob/main/near/omni-tests/src/zcash_stale_transfer_poc.rs',
    quote:
      'Real-world Zcash UAs with all three receivers (transparent + Sapling + Orchard) are typically 280-320 chars',
    bearing:
      'A maintainer-written test that treats unified addresses as the ordinary case for this bridge. The same file notes the contract "doesn’t validate Zcash address format".',
  },
  {
    kind: 'observed',
    url: 'https://1click.chaindefuser.com/v0/quote',
    quote:
      'SOL→ZEC dry quotes, three rounds each: t1 transparent HTTP 201; unified Orchard-only 201; unified Sapling+Orchard 201; unified p2pkh+Orchard 201; unified Sapling-only HTTP 400 "recipient is not valid"; legacy zs1 Sapling HTTP 400.',
    bearing:
      'The validator parses receivers and requires a transparent or an Orchard one. An Orchard-only address has no transparent receiver to fall back to, and is accepted anyway; Sapling alone is refused. That is a ZIP-316 sender whose supported set is {p2pkh, p2sh, orchard}.',
  },
  {
    kind: 'observed',
    url: 'https://api.nearblocks.io/v1/account/zec.omft.near/txns',
    quote:
      'Production withdrawals carry `{"Withdraw":{"target_btc_address":"u1…"}}`. Four distinct destinations sampled, all parsed by the ZIP-316 parser as shielded-only (three [sapling,orchard], one [orchard]); none exposes a transparent receiver; all four receipts succeeded.',
    bearing:
      'The route is being used for shielded-only recipients in production, and those withdrawals are not failing.',
  },
  {
    kind: 'observed',
    url: 'https://api.blockchair.com/zcash/raw/transaction/2294dbbf8fe1de9c1e341fc0b034cdcf0a8f76f80e24bd100cb9cee52388a373',
    quote:
      'v6 transaction from the connector’s wallet: 2 transparent inputs (47,790,000 zat), 1 transparent output back to its own change address (45,674,715 zat), and one Orchard action with valueBalance −2,100,285 zat. The residual is exactly 15,000 zat, the ZIP-317 fee for three logical actions.',
    bearing:
      'The decisive observation. A negative Orchard valueBalance is value leaving the transparent pool and entering the Orchard pool, and the fee arithmetic closes to the zatoshi. This is a shielding payout, not a transparent one.',
  },
  {
    kind: 'observed',
    url: 'https://api.blockchair.com/zcash/dashboards/address/t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua',
    quote:
      'Eight of the ten most recent transactions from the connector’s wallet carry exactly one Orchard action with a negative valueBalance (−0.021 to −100.2 ZEC). The other two are transparent-only payouts with no shielded component.',
    bearing:
      'Orchard delivery is the routine behaviour of this wallet, not an isolated event, and transparent delivery still happens for transparent recipients.',
  },
] as const

/**
 * The one thing none of this can show, stated so it is not quietly assumed.
 *
 * An Orchard output is encrypted to its recipient. Nobody outside the payment
 * can read which address a given action paid, so no amount of chain-watching
 * will ever tie one of our swaps to one of those actions. The evidence above is
 * therefore the strongest form this question admits: shielded-only addresses go
 * in, Orchard value comes out, and the arithmetic has no room for a transparent
 * payout hiding in it.
 */
export const ZEC_DELIVERY_UNVERIFIABLE_BY_DESIGN =
  'Orchard outputs are encrypted to the recipient, so an external observer cannot confirm that a specific ' +
  'payout reached a specific address. Per-payment proof of delivery is only available to the holder of the ' +
  'viewing key — that is, the player — and this server never sees it.'

/**
 * Optional partner JWT. Unauthenticated requests work and carry an extra 0.2%
 * fee, so its absence is a cost difference rather than a blocker — which is why
 * discovery and dry quotes below do not report it as missing configuration.
 */
export const ONECLICK_AUTH_VARS = ['NEAR_INTENTS_JWT'] as const

/** Applies the JWT if one exists. Never logs or returns the token itself. */
export function configureOneClickAuth(): { authenticated: boolean } {
  const token = (process.env.NEAR_INTENTS_JWT ?? '').trim()
  if (!token) return { authenticated: false }
  OpenAPI.TOKEN = token
  return { authenticated: true }
}

/* ------------------------------------------------------------------ *
 * Asset discovery
 * ------------------------------------------------------------------ */

export interface ZecAssetFinding {
  readonly totalAssets: number
  /** The single asset on the Zcash chain itself, or null if it vanished. */
  readonly native: { assetId: string; symbol: string; decimals: number; blockchain: string } | null
  /** Assets symbolled ZEC that live on some other chain. Not Zcash. */
  readonly wrappedElsewhere: readonly { assetId: string; blockchain: string }[]
  readonly httpStatus: number
  readonly observedAtMs: number
}

/**
 * Lists supported assets and picks out the Zcash question specifically.
 *
 * The distinction between the native asset and the wrapped ones matters: four
 * other entries are also called ZEC but sit on Solana, Starknet, Aptos and
 * NEAR. Paying out to one of those is not paying out on Zcash, and a lookup by
 * symbol alone would choose wrong.
 */
export async function discoverZecAsset(): Promise<AdapterResult<{ finding: ZecAssetFinding }>> {
  const startedAt = Date.now()
  try {
    const tokens = (await OneClickService.getTokens()) as TokenResponse[]
    const zecEntries = tokens.filter(token => token.symbol.toUpperCase() === 'ZEC')
    const native = zecEntries.find(token => String(token.blockchain) === 'zec') ?? null
    return {
      ok: true,
      finding: {
        totalAssets: tokens.length,
        native: native
          ? {
              assetId: native.assetId,
              symbol: native.symbol,
              decimals: native.decimals,
              blockchain: String(native.blockchain),
            }
          : null,
        wrappedElsewhere: zecEntries
          .filter(token => String(token.blockchain) !== 'zec')
          .map(token => ({ assetId: token.assetId, blockchain: String(token.blockchain) })),
        // The SDK does not surface the status of a success, and the only
        // honest value for a resolved 2xx is 200.
        httpStatus: 200,
        observedAtMs: startedAt,
      },
    }
  } catch (error) {
    return apiFailure(error, 'asset discovery')
  }
}

/* ------------------------------------------------------------------ *
 * Dry quotes
 * ------------------------------------------------------------------ */

export interface DryQuoteInput {
  readonly originAssetId: string
  readonly destinationAssetId: string
  /** Integer base units of the origin asset. */
  readonly amountBaseUnits: bigint
  readonly recipient: string
  readonly refundTo: string
  readonly slippageToleranceBps: number
  readonly deadlineIso: string
}

export interface DryQuoteResult {
  readonly accepted: true
  readonly httpStatus: number
  readonly observedAtMs: number
  readonly amountInBaseUnits: bigint
  readonly amountOutBaseUnits: bigint
  readonly minAmountOutBaseUnits: bigint
  readonly timeEstimateSeconds: number | null
  /** Always absent on a dry quote, and asserted below rather than assumed. */
  readonly depositAddressPresent: boolean
  readonly correlationId: string
  readonly signatureVerified: boolean
}

export class OneClickSafetyError extends Error {}

/**
 * A quote that validates parameters and prices the route without executing it.
 *
 * `dry` is hardcoded `true` rather than taken as an argument. A boolean
 * parameter is one typo away from a live quote that returns a real deposit
 * address, and nothing in this adapter has a use for one.
 */
export async function dryQuote(input: DryQuoteInput): Promise<AdapterResult<{ quote: DryQuoteResult }>> {
  const startedAt = Date.now()
  try {
    const response: QuoteResponse = await OneClickService.getQuote({
      dry: true,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: input.slippageToleranceBps,
      originAsset: input.originAssetId,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: input.destinationAssetId,
      amount: input.amountBaseUnits.toString(),
      refundTo: input.refundTo,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: input.recipient,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: input.deadlineIso,
    })

    const quote = response.quote
    // If a dry quote ever comes back carrying a deposit address, the request
    // was not dry. Refusing loudly is the only safe response: the alternative
    // is an address in memory that some later code path could show a user.
    if (quote.depositAddress) {
      throw new OneClickSafetyError(
        'a dry quote returned a deposit address, which must never happen; refusing to continue',
      )
    }

    let signatureVerified = false
    try {
      // The SDK signs quotes so disputes can be resolved later. Verifying it
      // here means a tampered response is visible immediately rather than at
      // the point it would have been used as evidence.
      const { verifyQuoteSignature } = await import('@defuse-protocol/one-click-sdk-typescript')
      signatureVerified = verifyQuoteSignature(response as never)
    } catch {
      signatureVerified = false
    }

    return {
      ok: true,
      quote: {
        accepted: true,
        httpStatus: 200,
        observedAtMs: startedAt,
        amountInBaseUnits: readBaseUnits(quote.amountIn, 'amountIn'),
        amountOutBaseUnits: readBaseUnits(quote.amountOut, 'amountOut'),
        minAmountOutBaseUnits: readBaseUnits(quote.minAmountOut, 'minAmountOut'),
        timeEstimateSeconds: typeof quote.timeEstimate === 'number' ? quote.timeEstimate : null,
        depositAddressPresent: false,
        correlationId: response.correlationId,
        signatureVerified,
      },
    }
  } catch (error) {
    if (error instanceof OneClickSafetyError) throw error
    return apiFailure(error, 'dry quote')
  }
}

/* ------------------------------------------------------------------ *
 * The shielded-support verdict
 * ------------------------------------------------------------------ */

export type ShieldedVerdict =
  /**
   * An Orchard receiver and no transparent receiver. The provider prices it,
   * and the executor is observed paying Orchard. There is no transparent
   * receiver in the address for a payout to land on instead, so the pool is
   * determined by the address rather than by a choice we cannot see.
   */
  | 'orchard-substantiated'
  /**
   * Orchard *and* transparent receivers both present. ZIP-316 says a sender
   * picks its most preferred supported receiver, which would be Orchard — but
   * "would be" is not an observation, and picking wrong here means paying a
   * private promise into a public address.
   */
  | 'receiver-ambiguous'
  /** Sapling with no Orchard and no transparent receiver: the provider refuses it. */
  | 'sapling-unsupported'
  /** No shielded receiver at all. Transparent delivery is the only possibility. */
  | 'transparent-only'
  /** The provider would not price it, so nothing was established either way. */
  | 'unsubstantiated'

export interface ZecDeliveryAssessment {
  readonly recipient: string
  /** Receiver set actually parsed out of the address, from the ZIP-316 parser. */
  readonly parsedReceivers: readonly string[]
  readonly addressIsShieldedCapable: boolean
  readonly addressHasTransparentReceiver: boolean
  readonly addressHasOrchardReceiver: boolean
  /** Did the live quote endpoint price this address? */
  readonly quoteAccepted: boolean
  readonly quoteHttpStatus: number | null
  /** Verbatim provider documentation, which the observations contradict. */
  readonly documentedSupport: string
  readonly documentedSupportUrl: string
  readonly verdict: ShieldedVerdict
  /**
   * The pool this address forces the payout into.
   *
   * `'shielded'` is reachable only when Orchard is the sole option the address
   * offers. It is never inferred from a priced quote, and never from the
   * presence of a shielded receiver alongside a transparent one.
   */
  readonly deliveredReceiver: ObservedReceiver
  readonly explanation: string
}

const hasAny = (receivers: readonly string[], ...want: string[]) =>
  receivers.some(receiver => want.includes(receiver))

/**
 * Combines a parsed address with a live quote result into a verdict.
 *
 * The rule the whole function turns on is that **`'shielded'` requires the
 * address to leave no alternative.** An Orchard-only unified address can only
 * be paid one way, so observing that the executor pays Orchard settles it. An
 * address carrying both Orchard and a transparent receiver cannot be settled
 * the same way: the sender chooses, the choice is not visible from outside, and
 * guessing the charitable answer is exactly the failure this file exists to
 * prevent. That case returns `'unknown'` and the caller refuses.
 */
export function classifyZecDelivery(input: {
  recipient: string
  parsedReceivers: readonly string[]
  quoteAccepted: boolean
  quoteHttpStatus: number | null
}): ZecDeliveryAssessment {
  const hasOrchard = hasAny(input.parsedReceivers, 'orchard')
  const hasSapling = hasAny(input.parsedReceivers, 'sapling')
  const hasTransparent = hasAny(input.parsedReceivers, 'p2pkh', 'p2sh')
  const shieldedCapable = hasOrchard || hasSapling

  let verdict: ShieldedVerdict
  let deliveredReceiver: ObservedReceiver
  let explanation: string

  if (!input.quoteAccepted) {
    // Nothing was established. In particular a refusal is not proof of
    // transparent delivery, so this does not fall through to `'transparent'`.
    verdict = hasSapling && !hasOrchard && !hasTransparent ? 'sapling-unsupported' : 'unsubstantiated'
    deliveredReceiver = 'unknown'
    explanation =
      verdict === 'sapling-unsupported'
        ? 'The provider refused this address. A Sapling receiver with no Orchard and no transparent receiver ' +
          'is rejected outright with HTTP 400 "recipient is not valid" — the executor builds Orchard outputs, ' +
          'not Sapling ones. Ask for an address that exposes an Orchard receiver.'
        : 'The provider would not price this address, so nothing was established about where it would pay. ' +
          'That is not evidence of transparent delivery either.'
  } else if (hasOrchard && !hasTransparent) {
    verdict = 'orchard-substantiated'
    deliveredReceiver = 'shielded'
    explanation =
      'This address exposes an Orchard receiver and no transparent receiver, so there is nowhere public for ' +
      'a payout to land. The provider prices it, and the Zcash connector that executes the payout is ' +
      'observed on chain spending transparent UTXOs into Orchard actions with a negative valueBalance. ' +
      'What cannot be shown for any individual payment is which address an Orchard action paid, because ' +
      'the output is encrypted to its recipient.'
  } else if (hasOrchard && hasTransparent) {
    verdict = 'receiver-ambiguous'
    deliveredReceiver = 'unknown'
    explanation =
      'This address exposes an Orchard receiver *and* a transparent one. ZIP-316 says a sender should pick ' +
      'the most preferred receiver it supports, which would be Orchard, but that is a reading of the spec ' +
      'rather than something observed of this executor, and being wrong means paying publicly under a ' +
      'private promise. Supply an address with no transparent receiver and the question disappears.'
  } else if (hasSapling) {
    // Accepted despite Sapling means a transparent receiver carried it.
    verdict = hasTransparent ? 'receiver-ambiguous' : 'sapling-unsupported'
    deliveredReceiver = 'unknown'
    explanation = hasTransparent
      ? 'This address exposes Sapling and a transparent receiver but no Orchard receiver. The executor is ' +
        'only observed building Orchard outputs, so the shielded receiver here is one it does not use, and ' +
        'the transparent receiver is the likely destination. Not offered as a private payout.'
      : 'Sapling with no Orchard receiver. The executor builds Orchard outputs only.'
  } else {
    verdict = 'transparent-only'
    deliveredReceiver = 'transparent'
    explanation = 'This address exposes no shielded receiver, so transparent delivery is the only possibility.'
  }

  return {
    recipient: input.recipient,
    parsedReceivers: [...input.parsedReceivers],
    addressIsShieldedCapable: shieldedCapable,
    addressHasTransparentReceiver: hasTransparent,
    addressHasOrchardReceiver: hasOrchard,
    quoteAccepted: input.quoteAccepted,
    quoteHttpStatus: input.quoteHttpStatus,
    documentedSupport: ZEC_DOCUMENTED_SUPPORT,
    documentedSupportUrl: ZEC_DOCUMENTED_SUPPORT_URL,
    verdict,
    deliveredReceiver,
    explanation,
  }
}

export interface ZecPayoutPlan {
  readonly usable: boolean
  readonly assessment: ZecDeliveryAssessment
  readonly refusal?: string
}

/**
 * Decides whether this provider can be used for the owner's stated requirement.
 *
 * When shielded delivery was approved and the provider cannot substantiate it,
 * this returns unusable with a reason. It does not return a transparent plan,
 * does not set a `downgraded` flag for somebody else to notice, and does not
 * ask the caller to check a field. There is no transparent plan in the return
 * value at all, so a caller cannot use one by mistake.
 */
export function planZecPayout(input: {
  requirement: ReceiverRequirement
  assessment: ZecDeliveryAssessment
}): ZecPayoutPlan {
  if (input.requirement === 'shielded-required') {
    if (input.assessment.deliveredReceiver !== 'shielded') {
      return {
        usable: false,
        assessment: input.assessment,
        refusal: `${refusalFor(input.assessment.verdict)} Falling back to transparent delivery would change ` +
          'what the owner agreed to and is not offered; a transparent payout needs its own authorization ' +
          'with destinationReceiver = "transparent-allowed".',
      }
    }
    return { usable: true, assessment: input.assessment }
  }

  if (!input.assessment.addressHasTransparentReceiver) {
    return {
      usable: false,
      assessment: input.assessment,
      refusal:
        'Transparent delivery was approved, but the recipient exposes no transparent receiver, so there ' +
        'is nowhere for a documented payout to land.',
    }
  }
  return { usable: true, assessment: input.assessment }
}

/** The reason a shielded requirement was not met, specific to why. */
function refusalFor(verdict: ShieldedVerdict): string {
  switch (verdict) {
    case 'receiver-ambiguous':
      return (
        'The owner approved shielded delivery, and this recipient also exposes a transparent receiver. ' +
        'Which one the executor pays is its choice and is not observable from outside, so this address ' +
        'cannot be promised as private. A unified address with no transparent receiver can be.'
      )
    case 'sapling-unsupported':
      return (
        'The owner approved shielded delivery, and this recipient offers only a Sapling receiver. The ' +
        'executor builds Orchard outputs, and the provider rejects Sapling-only addresses outright. An ' +
        'address exposing an Orchard receiver is required.'
      )
    case 'transparent-only':
      return 'The owner approved shielded delivery and this recipient exposes no shielded receiver at all.'
    case 'unsubstantiated':
      return (
        'The owner approved shielded delivery and the provider would not price this recipient, so nothing ' +
        'is known about where it would pay.'
      )
    case 'orchard-substantiated':
      // Unreachable: this verdict sets deliveredReceiver to 'shielded'.
      return 'The owner approved shielded delivery.'
  }
}

/* ------------------------------------------------------------------ *
 * Deposits — refused
 * ------------------------------------------------------------------ */

export class OneClickDepositUnavailable extends Error {}

/**
 * Would obtain a deposit address and send the principal to it. Refuses.
 *
 * Two independent reasons, and both must be cleared before this could ever be
 * implemented: NEAR Intents has no testnet, so a first execution is necessarily
 * mainnet with real funds; and once funds are in a quote-specific deposit
 * address they are outside our control until the solver fills or the deadline
 * refunds, which makes this a custody decision rather than a coding task.
 *
 * The permit check runs first so that "unimplemented" cannot be used as a
 * route around the policy engine.
 */
export function prepareDeposit(permit: SpendPermit, action: ProposedAction, nowMs: number): never {
  assertPermitCovers(permit, action, nowMs)
  throw new OneClickDepositUnavailable(
    'Live 1Click deposits are not implemented. There is no NEAR Intents testnet, so the first execution ' +
      'would be mainnet with real funds, and funds inside a quote-specific deposit address are outside ' +
      'our control between deposit and settlement. No deposit address is requested anywhere in this ' +
      'adapter; every call is dry.',
  )
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

export async function probeOneClick(nowMs: number): Promise<IntegrationReport> {
  const evidence: Evidence[] = [
    {
      kind: 'sdk',
      observedAtMs: nowMs,
      environment: 'none',
      summary: 'official 1Click TypeScript client',
      packageName: ONECLICK_SDK.name,
      version: ONECLICK_SDK.version,
    },
    {
      kind: 'doc',
      observedAtMs: nowMs,
      environment: 'none',
      summary: 'Zcash support, verbatim',
      url: ZEC_DOCUMENTED_SUPPORT_URL,
      status: 200,
      quote: ZEC_DOCUMENTED_SUPPORT,
    },
    {
      kind: 'doc',
      observedAtMs: nowMs,
      environment: 'none',
      summary: 'no test environment',
      url: 'https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction',
      status: 200,
      quote: 'There is no testnet version of NEAR Intents - use small amounts for test swaps.',
    },
  ]

  configureOneClickAuth()
  const discovery = await discoverZecAsset()

  if (discovery.ok) {
    const finding = discovery.finding
    evidence.push({
      kind: 'http',
      observedAtMs: finding.observedAtMs,
      environment: 'mainnet',
      summary: 'GET /v0/tokens asset discovery (read-only)',
      url: `${OpenAPI.BASE}/v0/tokens`,
      method: 'GET',
      status: finding.httpStatus,
      durationMs: 0,
      extracted: finding.native
        ? `${finding.totalAssets} assets; native Zcash asset ${finding.native.assetId} ` +
          `(blockchain "${finding.native.blockchain}", ${finding.native.decimals} decimals); ` +
          `${finding.wrappedElsewhere.length} wrapped ZEC entries on other chains`
        : `${finding.totalAssets} assets; no asset on the Zcash chain itself`,
    })
  } else {
    evidence.push({
      kind: 'http',
      observedAtMs: nowMs,
      environment: 'mainnet',
      summary: 'GET /v0/tokens asset discovery (read-only)',
      url: `${OpenAPI.BASE}/v0/tokens`,
      method: 'GET',
      status: 'httpStatus' in discovery && typeof discovery.httpStatus === 'number' ? discovery.httpStatus : null,
      durationMs: 0,
      transportError: discovery.detail,
    })
  }

  const capabilities: Capability[] = [
    {
      id: 'asset-discovery',
      description: 'List supported assets and identify the native Zcash asset',
      verdict: discovery.ok ? 'read-only' : 'unavailable',
      ...(discovery.ok ? {} : { blocker: discovery.detail }),
    },
    { id: 'dry-quote', description: 'Price SOL to ZEC without executing', verdict: 'read-only' },
    {
      id: 'shielded-payout',
      description: 'Deliver ZEC into the Orchard pool, for a recipient with no transparent receiver',
      verdict: 'read-only',
      blocker:
        `The provider still documents Zcash as "${ZEC_DOCUMENTED_SUPPORT}", and that is stale. The quote ` +
        'endpoint requires a transparent or an Orchard receiver and rejects Sapling-only addresses, and ' +
        `the executing connector (${ZEC_EXECUTOR.connectorContract}) is observed spending its transparent ` +
        'UTXOs into Orchard actions in production. What remains unexecuted here is our own swap: no ' +
        'deposit has ever been funded from this repository.',
    },
    {
      id: 'sapling-payout',
      description: 'Deliver ZEC to a Sapling receiver',
      verdict: 'unavailable',
      blocker:
        'The provider rejects Sapling-only recipients with HTTP 400 "recipient is not valid", in both the ' +
        'unified and the legacy zs1 encoding. The executor builds Orchard outputs only.',
    },
    {
      id: 'deposit',
      description: 'Execute a conversion by funding a deposit address',
      verdict: 'blocked',
      blocker:
        'No NEAR Intents testnet exists, so a first execution is mainnet with real funds, and the ' +
        'deposit address holds customer funds outside our control until settlement. Not implemented.',
    },
  ]

  return {
    id: ONECLICK_PROVIDER_ID,
    label: 'NEAR Intents 1Click — cross-chain conversion',
    sdk: ONECLICK_SDK,
    state: deriveState(evidence),
    capabilities,
    evidence,
    // The JWT only removes a 0.2% surcharge, so calling it missing would
    // misreport a fee difference as a blocker.
    missingConfiguration: [],
    nextStep:
      'Discovery and dry quotes are the ceiling here, and they now answer the shielded question: quote ' +
      'only an Orchard-bearing address with no transparent receiver. Execution still cannot be rehearsed ' +
      'anywhere, because there is no NEAR Intents testnet. Re-run npm run verify:zec-delivery to confirm ' +
      'the acceptance rule and the connector’s Orchard output have not changed.',
  }
}

/* ------------------------------------------------------------------ helpers */

function apiFailure(error: unknown, what: string): AdapterResult<never> {
  if (error instanceof ApiError) {
    // 401/403 is the one case that genuinely is a configuration gap, and only
    // then — unauthenticated requests are documented to work otherwise.
    if (error.status === 401 || error.status === 403) {
      return missingConfiguration(
        [...ONECLICK_AUTH_VARS],
        `1Click rejected the ${what} as unauthorised (HTTP ${error.status}). Unauthenticated requests are ` +
          'documented to work with a 0.2% surcharge, so this suggests a partner JWT is now required.',
      )
    }
    const detail = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? {}).slice(0, 300)
    return providerFailure('provider-error', `${what} failed: HTTP ${error.status} ${detail}`, error.status)
  }
  return providerFailure('transport-error', `${what} failed: ${error instanceof Error ? error.message : String(error)}`)
}
