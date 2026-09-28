/* ------------------------------------------------------------------ *
 * NEAR Intents 1Click adapter — read-only (§6).
 *
 * Uses the official client, `@defuse-protocol/one-click-sdk-typescript`
 * 0.1.26. Every call in this file is either asset discovery or a quote with
 * `dry: true`, which the API documents as "validate parameters and get a quote
 * without executing the swap". No deposit address is ever used, no funds move,
 * and `prepareDeposit` below refuses rather than moving any.
 *
 * ---- The trap this file exists to defuse ----------------------------------
 *
 * 1Click's quote endpoint **accepts shielded-only unified addresses** and
 * returns priced quotes for them, while its own chain-support page says Zcash
 * is "⚠️ Partially supported - Transparent addresses only" and its OpenAPI
 * schema never mentions shielded pools, Sapling, Orchard, or unified addresses
 * at all. So the API's behaviour invites a conclusion its documentation
 * contradicts, and the only way to find out which is true is to send real ZEC
 * and inspect what got delivered.
 *
 * A naive implementation would take the priced quote as confirmation, hand the
 * user a deposit address, and discover the incompatibility after the funds were
 * already inside it. This adapter is built so that cannot happen:
 *
 *   - `classifyZecDelivery` reports quote acceptance and documented support as
 *     two separate fields and never derives one from the other. Its verdict for
 *     a shielded receiver is `unsubstantiated`, not `supported`.
 *   - `deliveredReceiver` is `'unknown'` for a shielded-capable address, because
 *     no sourced statement says which pool the funds land in. It is never
 *     `'shielded'`, and it is not `'transparent'` either: claiming transparent
 *     delivery would be the same unsourced guess in the other direction.
 *   - `planZecPayout` refuses outright when the owner required shielded
 *     delivery. It does not return a transparent plan instead. Silently
 *     downgrading is the specific failure §6 names, and a caller that wanted a
 *     fallback has to ask for one explicitly and re-authorize it.
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
 * Verbatim from the provider's own chain-support page.
 *
 * Held as a constant because it is the only sourced statement about what 1Click
 * actually delivers to a Zcash address, and every verdict in this file is
 * traceable back to it.
 */
export const ZEC_DOCUMENTED_SUPPORT =
  '⚠️ Partially supported - Transparent addresses only'

export const ZEC_DOCUMENTED_SUPPORT_URL = 'https://docs.near-intents.org/resources/chain-support'

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
  /** Documented as supported by the provider. Nothing reaches this today. */
  | 'documented-supported'
  /** The API priced it, the documentation contradicts it. Not evidence. */
  | 'unsubstantiated'
  /** Documented as unsupported and the API agreed. */
  | 'documented-unsupported'

export interface ZecDeliveryAssessment {
  readonly recipient: string
  /** Receiver set actually parsed out of the address, from the ZIP-316 parser. */
  readonly parsedReceivers: readonly string[]
  readonly addressIsShieldedCapable: boolean
  readonly addressHasTransparentReceiver: boolean
  /** Did the live quote endpoint price this address? */
  readonly quoteAccepted: boolean
  readonly quoteHttpStatus: number | null
  /** Verbatim provider documentation. */
  readonly documentedSupport: string
  readonly documentedSupportUrl: string
  readonly verdict: ShieldedVerdict
  /**
   * What the route would actually deliver to. Never `'shielded'`, because no
   * sourced statement supports that and a priced quote is not one.
   */
  readonly deliveredReceiver: ObservedReceiver
  readonly explanation: string
}

/**
 * Combines a parsed address with a live quote result into a verdict.
 *
 * The important line is the one that does *not* exist: there is no branch in
 * which `quoteAccepted === true` produces `deliveredReceiver: 'shielded'`. The
 * two inputs are reported side by side, and the disagreement between them is
 * the finding.
 */
export function classifyZecDelivery(input: {
  recipient: string
  parsedReceivers: readonly string[]
  quoteAccepted: boolean
  quoteHttpStatus: number | null
}): ZecDeliveryAssessment {
  const shieldedCapable = input.parsedReceivers.some(
    receiver => receiver === 'sapling' || receiver === 'orchard',
  )
  const hasTransparent = input.parsedReceivers.some(
    receiver => receiver === 'p2pkh' || receiver === 'p2sh',
  )

  const verdict: ShieldedVerdict = shieldedCapable
    ? input.quoteAccepted
      ? 'unsubstantiated'
      : 'documented-unsupported'
    : 'documented-unsupported'

  const explanation = shieldedCapable
    ? input.quoteAccepted
      ? 'The quote endpoint priced a shielded-capable unified address, but the provider documents Zcash ' +
        'as transparent addresses only and its OpenAPI schema never mentions shielded pools. Quote-time ' +
        'acceptance validates an address string; it is not a promise about which pool the payout lands ' +
        'in. Treating it as one would put funds in a deposit address before the truth was known.'
      : 'The quote endpoint rejected this shielded-capable address, which agrees with the documentation.'
    : 'This address exposes no shielded receiver, so transparent delivery is the only possibility.'

  return {
    recipient: input.recipient,
    parsedReceivers: [...input.parsedReceivers],
    addressIsShieldedCapable: shieldedCapable,
    addressHasTransparentReceiver: hasTransparent,
    quoteAccepted: input.quoteAccepted,
    quoteHttpStatus: input.quoteHttpStatus,
    documentedSupport: ZEC_DOCUMENTED_SUPPORT,
    documentedSupportUrl: ZEC_DOCUMENTED_SUPPORT_URL,
    verdict,
    // Documented support is transparent-only, and documentation is the only
    // sourced statement available. A shielded-capable address whose delivery
    // pool is unproven is `unknown`, which the policy engine denies when the
    // owner required shielded — it does not fall through to transparent.
    deliveredReceiver: shieldedCapable ? 'unknown' : 'transparent',
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
        refusal:
          'The owner approved shielded delivery. This provider documents Zcash as ' +
          `"${ZEC_DOCUMENTED_SUPPORT}" and cannot substantiate a shielded payout, so the route stops ` +
          'here. Falling back to transparent delivery would change what the owner agreed to and is not ' +
          'offered; a transparent payout needs its own authorization with ' +
          'destinationReceiver = "transparent-allowed".',
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
      description: 'Deliver ZEC to a shielded receiver',
      verdict: 'unavailable',
      blocker:
        `Documented as "${ZEC_DOCUMENTED_SUPPORT}". The quote endpoint nonetheless prices shielded-only ` +
        'unified addresses, which is not evidence of shielded delivery — resolving the contradiction ' +
        'needs a real mainnet swap and an inspection of the delivered transaction.',
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
      'Discovery and dry quotes are the ceiling here. Execution cannot be tested anywhere: there is no ' +
      'NEAR Intents testnet, and shielded delivery is undocumented.',
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
