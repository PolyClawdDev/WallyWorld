/* ------------------------------------------------------------------ *
 * Route preflight (§6).
 *
 * Runs the whole route on paper before a single unit of value could be
 * collected, and fails closed with the name of the stage that stopped it.
 *
 * The ordering is the design. Every stage is evaluated in the order value would
 * actually flow, and the first unavailable stage ends the preflight — because
 * the point is to discover the blocker while the user still has their money,
 * not after stage 3 has already moved it. In particular the shielded-ZEC
 * question is answered at stage 5, before the deposit at stage 6, which is
 * precisely the ordering that keeps funds out of a deposit address whose payout
 * pool nobody can substantiate.
 *
 * `fundsAtRiskFrom` names the first stage after which money is no longer
 * recoverable by us. Any refusal at or before it is free; any failure after it
 * is a refund problem. Stating that explicitly is what stops "preflight passed"
 * from being read as "this is safe".
 * ------------------------------------------------------------------ */

import type { Authorization } from '../../shared/authorization'
import { formatBaseUnits, sumBaseUnits } from '../policy/units'
import {
  ZEC_DOCUMENTED_SUPPORT,
  ZEC_NATIVE_ASSET_ID,
  classifyZecDelivery,
  discoverZecAsset,
  dryQuote,
  planZecPayout,
  configureOneClickAuth,
  ONECLICK_PROVIDER_ID,
} from './oneclick'
import { JUPITER_PROVIDER_ID, quoteSolToUsdc } from './jupiter'
import { parseZcashAddress, receiverForPolicy } from './zcashAddress'
import { SIGNER_STATUS, CONFIRMATION_POLICY } from './zcashWallet'
import { X402_FACILITATOR_VARS, X402_PROVIDER_ID } from './x402'
import { envPresent } from './types'

/** The stages of the flagship route, in the order value moves through them. */
export const ROUTE_STAGES = [
  'authorization',
  'destination-address',
  'service-payment',
  'source-conversion',
  'zec-shielded-support',
  'conversion-deposit',
  'transparent-receipt',
  'shielding',
  'shielded-send',
  'confirmation',
] as const

export type RouteStage = (typeof ROUTE_STAGES)[number]

export interface StageResult {
  readonly stage: RouteStage
  readonly ready: boolean
  readonly detail: string
  readonly evidence?: string
}

export type PreflightOutcome =
  | { readonly ok: true; readonly stages: readonly StageResult[]; readonly fundsAtRiskFrom: RouteStage }
  | {
      readonly ok: false
      /** The stage that stopped the route. Always named. */
      readonly failedStage: RouteStage
      readonly reason: string
      readonly stages: readonly StageResult[]
      readonly fundsAtRiskFrom: RouteStage
    }

/**
 * The first stage after which we can no longer give the money back.
 *
 * Once the principal is inside a quote-specific deposit address it is out of our
 * control until a solver fills or the deadline refunds, so that is the line.
 */
export const FUNDS_AT_RISK_FROM: RouteStage = 'conversion-deposit'

export interface PreflightInput {
  readonly authorization: Authorization
  readonly nowMs: number
  /** Lamports of SOL the job would convert. Integer base units. */
  readonly principalLamports: bigint
  /** Set false to skip the two live read-only probes, for an offline preflight. */
  readonly allowNetwork?: boolean
  /**
   * The 1Click asset id for the source. Defaults from the source network.
   *
   * It has to match the source chain or 1Click rejects the quote on the refund
   * address — which would look like a recipient rejection and be nothing of the
   * kind, quietly turning the shielded-support probe into a false negative.
   */
  readonly originAssetId?: string
}

/** 1Click asset ids for the source chains this route can start on. */
const ORIGIN_ASSETS: Record<string, string> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'nep141:sol.omft.near',
}

/**
 * Preflight the entire route.
 *
 * Returns rather than throws: the caller needs the partial stage list to show
 * an operator how far the route got, and an exception would discard it.
 */
export async function preflightRoute(input: PreflightInput): Promise<PreflightOutcome> {
  const stages: StageResult[] = []
  const auth = input.authorization
  const allowNetwork = input.allowNetwork !== false

  const fail = (stage: RouteStage, reason: string): PreflightOutcome => {
    stages.push({ stage, ready: false, detail: reason })
    return { ok: false, failedStage: stage, reason, stages, fundsAtRiskFrom: FUNDS_AT_RISK_FROM }
  }
  const pass = (stage: RouteStage, detail: string, evidence?: string) => {
    stages.push(evidence === undefined ? { stage, ready: true, detail } : { stage, ready: true, detail, evidence })
  }

  /* ---- 1. authorization ------------------------------------------------- */

  if (auth.revoked) return fail('authorization', 'the authorization has been revoked')
  if (input.nowMs >= auth.expiresAtMs) {
    return fail('authorization', `the authorization expired at ${auth.expiresAtMs}`)
  }
  if (input.principalLamports > auth.maxPrincipalBaseUnits) {
    return fail(
      'authorization',
      `principal ${input.principalLamports} exceeds the approved maximum ${auth.maxPrincipalBaseUnits}`,
    )
  }
  const envelope = sumBaseUnits(
    input.principalLamports,
    auth.costs.serviceFeeBaseUnits,
    auth.costs.conversionCostBaseUnits,
    auth.costs.networkFeesBaseUnits,
  )
  if (envelope > auth.maxTotalDebitBaseUnits) {
    return fail(
      'authorization',
      `principal plus quoted fees (${envelope}) exceeds the approved total debit ${auth.maxTotalDebitBaseUnits}`,
    )
  }
  pass(
    'authorization',
    `within bounds: principal ${formatBaseUnits(input.principalLamports, auth.sourceAsset.decimals)} ` +
      `${auth.sourceAsset.symbol}, total debit ceiling ${auth.maxTotalDebitBaseUnits} base units`,
  )

  /* ---- 2. destination address ------------------------------------------- */

  const parsed = await parseZcashAddress(auth.destinationRecipient, 'main')
  if (!parsed.ok) {
    return fail('destination-address', `the approved recipient did not parse: ${parsed.detail}`)
  }
  const observedReceiver = receiverForPolicy(parsed.parsed)
  if (auth.destinationReceiver === 'shielded-required' && !parsed.parsed.hasShieldedReceiver) {
    return fail(
      'destination-address',
      'shielded delivery was approved but the recipient exposes no shielded receiver ' +
        `(receivers: ${parsed.parsed.receivers.join(', ') || 'none'})`,
    )
  }
  if (parsed.parsed.receivers.length === 0) {
    return fail(
      'destination-address',
      `the recipient contains only receiver typecodes this build does not understand ` +
        `(${parsed.parsed.unknownTypecodes.join(', ')}), so there is no receiver to pay`,
    )
  }
  pass(
    'destination-address',
    `parsed to receivers [${parsed.parsed.receivers.join(', ')}]${parsed.parsed.shieldedOnly ? ', shielded-only' : ''}`,
    `ZIP-316 parse, offline; policy receiver = ${observedReceiver}`,
  )

  /* ---- 3. service payment (x402) ---------------------------------------- */

  if (!auth.approvedProviders.includes(X402_PROVIDER_ID)) {
    pass('service-payment', 'not part of this route: x402 is not an approved provider for this authorization')
  } else if (!envPresent(X402_FACILITATOR_VARS[0])) {
    return fail(
      'service-payment',
      `no x402 facilitator is configured (${X402_FACILITATOR_VARS[0]} unset), so the service fee cannot ` +
        'be settled. The public x402.org facilitator is documented as testnet only and is not a fallback.',
    )
  } else {
    pass('service-payment', 'a facilitator endpoint is configured; settlement still needs a funded payer')
  }

  /* ---- 4. source conversion (SOL -> USDC, Jupiter) ---------------------- */

  if (!auth.approvedProviders.includes(JUPITER_PROVIDER_ID)) {
    pass('source-conversion', 'not part of this route: Jupiter is not an approved provider for this authorization')
  } else if (!allowNetwork) {
    return fail('source-conversion', 'network probes are disabled, so the conversion quote could not be checked')
  } else {
    const quote = await quoteSolToUsdc({ lamports: input.principalLamports, slippageBps: auth.slippageLimitBps })
    if (!quote.ok) {
      return fail('source-conversion', `Jupiter quote failed: ${quote.detail}`)
    }
    pass(
      'source-conversion',
      `quoted ${quote.quote.inAmountBaseUnits} lamports to ${quote.quote.outAmountBaseUnits} USDC base units ` +
        `via ${quote.quote.router}`,
      `HTTP ${quote.quote.httpStatus}; execution is mainnet-only — Jupiter has no test swap endpoint`,
    )
  }

  /* ---- 5. the shielded-ZEC question ------------------------------------- *
   * Deliberately ahead of the deposit. This is the stage that has to fail
   * before funds move, because once they are in a deposit address the payout
   * pool is no longer a question we get to ask.                              */

  if (!allowNetwork) {
    return fail(
      'zec-shielded-support',
      'network probes are disabled, so shielded support could not be re-verified; refusing to assume it',
    )
  }

  configureOneClickAuth()
  const discovery = await discoverZecAsset()
  if (!discovery.ok) {
    return fail('zec-shielded-support', `1Click asset discovery failed: ${discovery.detail}`)
  }
  if (!discovery.finding.native) {
    return fail('zec-shielded-support', 'no asset on the Zcash chain itself appears in the 1Click token list')
  }

  const originAssetId = input.originAssetId ?? ORIGIN_ASSETS[auth.sourceAsset.network]
  if (!originAssetId) {
    return fail(
      'zec-shielded-support',
      `no 1Click asset id is known for source network ${auth.sourceAsset.network}, so the conversion ` +
        'could not be quoted. Refusing to guess one.',
    )
  }

  const quoteProbe = await dryQuote({
    originAssetId,
    destinationAssetId: ZEC_NATIVE_ASSET_ID,
    amountBaseUnits: input.principalLamports,
    recipient: auth.destinationRecipient,
    refundTo: auth.refundDestination.address,
    slippageToleranceBps: auth.slippageLimitBps,
    deadlineIso: new Date(input.nowMs + 3_600_000).toISOString(),
  })

  const assessment = classifyZecDelivery({
    recipient: auth.destinationRecipient,
    parsedReceivers: parsed.parsed.receivers,
    quoteAccepted: quoteProbe.ok,
    quoteHttpStatus: quoteProbe.ok
      ? quoteProbe.quote.httpStatus
      : 'httpStatus' in quoteProbe && typeof quoteProbe.httpStatus === 'number'
        ? quoteProbe.httpStatus
        : null,
  })

  const plan = planZecPayout({ requirement: auth.destinationReceiver, assessment })
  if (!plan.usable) {
    return fail('zec-shielded-support', plan.refusal ?? 'the payout could not be substantiated')
  }
  pass(
    'zec-shielded-support',
    `documented support: "${ZEC_DOCUMENTED_SUPPORT}"; verdict ${assessment.verdict}`,
    `quote accepted: ${assessment.quoteAccepted}, delivered receiver: ${assessment.deliveredReceiver}`,
  )

  /* ---- 6. the deposit — the point of no return -------------------------- */

  return fail(
    'conversion-deposit',
    'Live 1Click deposits are not implemented and would be the point of no return. There is no NEAR ' +
      'Intents testnet, so a first execution is mainnet with real funds, and the principal would sit in ' +
      'a provider-controlled deposit address until a solver fills or the deadline refunds. Stages ' +
      `"transparent-receipt", "shielding", "shielded-send" and "confirmation" are unreachable regardless: ${SIGNER_STATUS.blocker}`,
  )
}

/** Human-readable preflight, for the operator console and the verification script. */
export function renderPreflight(outcome: PreflightOutcome): string {
  const lines: string[] = []
  for (const stage of outcome.stages) {
    lines.push(`  ${stage.ready ? 'ok      ' : 'BLOCKED '} ${stage.stage.padEnd(22)} ${stage.detail}`)
    if (stage.evidence) lines.push(`${' '.repeat(35)}${stage.evidence}`)
  }
  const unreached = ROUTE_STAGES.filter(stage => !outcome.stages.some(result => result.stage === stage))
  for (const stage of unreached) {
    lines.push(`  ·        ${stage.padEnd(22)} not reached`)
  }
  lines.push('')
  if (outcome.ok) {
    lines.push(`  PREFLIGHT PASSED — funds become unrecoverable from stage "${outcome.fundsAtRiskFrom}"`)
  } else {
    lines.push(`  PREFLIGHT FAILED CLOSED at stage "${outcome.failedStage}"`)
    lines.push(`  ${outcome.reason}`)
  }
  lines.push(
    `  shielding latency floor: ${CONFIRMATION_POLICY.untrustedTxos} confirmations for untrusted TXOs (ZIP 315)`,
  )
  return lines.join('\n')
}
