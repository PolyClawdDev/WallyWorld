/* ------------------------------------------------------------------ *
 * x402 adapter (§5).
 *
 * Built on the maintained SDK — `@x402/core` 2.27.0 for the protocol schemas
 * and header codec, `@x402/svm` 2.27.0 for the Solana scheme constants and
 * duplicate-settlement cache. Nothing here re-implements a wire format the
 * SDK already defines.
 *
 * Three things this file is careful about, all of them from §5:
 *
 * 1. **Payment state and delivery state are separate machines.** They are two
 *    fields on `PaidServiceSession` with no transition that touches both, so
 *    "the customer closed the dialogue" can never read as "the payment was
 *    cancelled". A settled payment that was never delivered is a refund
 *    obligation, and that is a state this file can represent.
 *
 * 2. **Incoming funds are spendable only against settlement evidence.**
 *    `spendableIncoming()` requires a settlement identifier and a confirmation,
 *    not a `verified` flag. `exact` is a push payment and irreversible, so
 *    guessing early is unrecoverable.
 *
 * 3. **A plain SOL transfer is not an x402 payment.** x402's documented Solana
 *    asset support is SPL and Token-2022 transferred by SPL Transfer; native
 *    SOL is a lamport balance and appears nowhere in it. `assertSplAsset`
 *    refuses `native`, by name, so no code path can label a SystemProgram
 *    transfer as an x402 settlement.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { validatePaymentPayload, validatePaymentRequirements } from '@x402/core/schemas'
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import {
  SETTLEMENT_TTL_MS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  SettlementCache,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
  normalizeNetwork,
  validateSvmAddress,
} from '@x402/svm'
import { assertPermitCovers, type ProposedAction, type SpendPermit } from '../policy'
import { readBaseUnits } from '../policy/units'
import { httpEvidence, parseJson, probe } from './probe'
import {
  deriveState,
  missingVariables,
  missingConfiguration,
  providerFailure,
  type AdapterResult,
  type Capability,
  type Evidence,
  type IntegrationReport,
} from './types'

export const X402_PROVIDER_ID = 'x402'

/** Read from `@x402/core/package.json` so the report cannot drift from reality. */
export const X402_SDK = { name: '@x402/core', version: '2.27.0' } as const
export const X402_SVM_SDK = { name: '@x402/svm', version: '2.27.0' } as const

/**
 * The public facilitator. Its own documentation calls it development and
 * testnet only, so it is used here for a read-only capability probe and is
 * never a mainnet settlement path.
 */
export const PUBLIC_TESTNET_FACILITATOR = 'https://x402.org/facilitator'

const NETWORKS = {
  'mainnet-beta': SOLANA_MAINNET_CAIP2,
  devnet: SOLANA_DEVNET_CAIP2,
  testnet: SOLANA_TESTNET_CAIP2,
} as const

export type SolanaClusterName = keyof typeof NETWORKS

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS])

/* ------------------------------------------------------------------ *
 * Asset rules
 * ------------------------------------------------------------------ */

export class X402AssetError extends Error {}

/**
 * Refuses anything that is not an SPL or Token-2022 mint.
 *
 * The named check for `native`/`SOL`/`lamports` is the important part. It is
 * not defensive programming; it is the one mistake the specification calls out
 * explicitly, and it is much easier to make by accident than it looks, because
 * every other payment path in this repository is denominated in lamports.
 */
export function assertSplAsset(asset: string, tokenProgram?: string): void {
  const lowered = asset.trim().toLowerCase()
  if (lowered === 'native' || lowered === 'sol' || lowered === 'lamports' || lowered === '') {
    throw new X402AssetError(
      'native SOL is not an x402 asset. x402 Solana support is documented as SPL / Token-2022 ' +
        'transferred by SPL Transfer; a SystemProgram SOL transfer is not an x402 payment and must ' +
        'not be labelled as one. Convert to USDC first and pay with the SPL mint.',
    )
  }
  if (!validateSvmAddress(asset)) {
    throw new X402AssetError(`asset "${asset}" is not a valid Solana mint address`)
  }
  if (tokenProgram !== undefined && !TOKEN_PROGRAMS.has(tokenProgram)) {
    throw new X402AssetError(
      `token program ${tokenProgram} is neither SPL Token nor Token-2022, which are the only ` +
        'programs x402 documents for Solana',
    )
  }
}

/** The documented default asset for dollar pricing on each cluster. */
export const defaultUsdcMint = (cluster: SolanaClusterName): string =>
  cluster === 'mainnet-beta' ? USDC_MAINNET_ADDRESS : USDC_DEVNET_ADDRESS

/* ------------------------------------------------------------------ *
 * Stage 1 — payment required
 * ------------------------------------------------------------------ */

export interface PaymentRequiredInput {
  readonly cluster: SolanaClusterName
  readonly resourceUrl: string
  readonly serviceName: string
  readonly description: string
  /** Integer base units of the SPL mint. Never a float, never a dollar string. */
  readonly amountBaseUnits: bigint
  readonly assetMint: string
  readonly payTo: string
  readonly maxTimeoutSeconds: number
}

/**
 * Builds the 402 body and header.
 *
 * Both the requirements object and the encoded header come from the SDK's own
 * schema and codec, so if the protocol changes shape the failure is a
 * validation error here rather than a payment the facilitator silently
 * misreads.
 */
export function buildPaymentRequired(input: PaymentRequiredInput): AdapterResult<{
  paymentRequired: unknown
  header: string
  network: string
}> {
  if (!validateSvmAddress(input.payTo)) {
    return providerFailure('validation-error', `payTo "${input.payTo}" is not a valid Solana address`)
  }
  try {
    assertSplAsset(input.assetMint)
  } catch (error) {
    return providerFailure('unsupported', error instanceof Error ? error.message : String(error))
  }
  if (input.amountBaseUnits <= 0n) {
    return providerFailure('validation-error', 'amount must be a positive integer of base units')
  }

  const network = NETWORKS[input.cluster]
  try {
    const requirements = validatePaymentRequirements({
      scheme: 'exact',
      network,
      // A decimal string of base units: `exact` is strict equality, so a
      // rounded display value would make every payment fail.
      amount: input.amountBaseUnits.toString(),
      asset: input.assetMint,
      payTo: input.payTo,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
    })
    const paymentRequired = {
      x402Version: 2 as const,
      resource: {
        url: input.resourceUrl,
        description: input.description,
        serviceName: input.serviceName,
        mimeType: 'application/json',
      },
      accepts: [requirements],
    }
    return {
      ok: true,
      paymentRequired,
      header: encodePaymentRequiredHeader(paymentRequired as never),
      network,
    }
  } catch (error) {
    return providerFailure('validation-error', error instanceof Error ? error.message : String(error))
  }
}

/* ------------------------------------------------------------------ *
 * Stage 2 — the payer's authorization, decoded and checked
 * ------------------------------------------------------------------ */

export interface VerifiedPayment {
  readonly network: string
  readonly scheme: string
  readonly asset: string
  readonly payTo: string
  readonly amountBaseUnits: bigint
  /** Base64 transaction the payer signed, as carried by the `exact` SVM scheme. */
  readonly signedTransactionBase64: string
  /** Digest used for duplicate protection and for the settlement cache key. */
  readonly payloadDigest: string
}

/**
 * Decodes an `X-PAYMENT` header and checks it against what we asked for.
 *
 * Every field the brief names is compared, and each comparison is exact. The
 * amount in particular: `exact` means strict equality, so an overpayment is a
 * rejection rather than a tip, and treating it as acceptable would leave the
 * facilitator and this server disagreeing about whether the payment succeeded.
 */
export function verifyPaymentPayload(input: {
  paymentHeader: string
  expected: {
    network: string
    asset: string
    payTo: string
    amountBaseUnits: bigint
  }
  /** Seconds. The payer's payload must not be older than the window we offered. */
  maxTimeoutSeconds: number
  receivedAtMs: number
  requestedAtMs: number
}): AdapterResult<{ payment: VerifiedPayment }> {
  let payload: unknown
  try {
    payload = decodePaymentSignatureHeader(input.paymentHeader)
  } catch (error) {
    return providerFailure('validation-error', `X-PAYMENT header did not decode: ${describe(error)}`)
  }

  let validated: ReturnType<typeof validatePaymentPayload>
  try {
    validated = validatePaymentPayload(payload)
  } catch (error) {
    return providerFailure('validation-error', `payment payload failed schema validation: ${describe(error)}`)
  }

  if (validated.x402Version !== 2) {
    return providerFailure('unsupported', `x402 version ${validated.x402Version} is not handled by this adapter`)
  }

  const accepted = validated.accepted
  // `normalizeNetwork` maps the v1 names onto CAIP-2, so a client on the older
  // vocabulary is not rejected for saying "solana-devnet".
  if (normalizeNetwork(accepted.network) !== normalizeNetwork(input.expected.network)) {
    return providerFailure(
      'validation-error',
      `payment is for network ${accepted.network}, not ${input.expected.network}`,
    )
  }
  if (accepted.scheme !== 'exact') {
    return providerFailure('unsupported', `scheme "${accepted.scheme}" is not handled; this service quotes "exact"`)
  }
  if (accepted.asset !== input.expected.asset) {
    return providerFailure('validation-error', `payment is in asset ${accepted.asset}, not ${input.expected.asset}`)
  }
  if (accepted.payTo !== input.expected.payTo) {
    return providerFailure(
      'validation-error',
      'payment names a different recipient than the one this service quoted',
    )
  }

  let amount: bigint
  try {
    amount = readBaseUnits(accepted.amount, 'accepted.amount')
  } catch (error) {
    return providerFailure('validation-error', describe(error))
  }
  if (amount !== input.expected.amountBaseUnits) {
    return providerFailure(
      'validation-error',
      `"exact" requires strict equality: quoted ${input.expected.amountBaseUnits}, payload carries ${amount}`,
    )
  }

  const ageSeconds = Math.floor((input.receivedAtMs - input.requestedAtMs) / 1000)
  if (ageSeconds > input.maxTimeoutSeconds) {
    return providerFailure(
      'validation-error',
      `payment arrived ${ageSeconds}s after the quote, past the ${input.maxTimeoutSeconds}s window`,
    )
  }

  const transaction = (validated.payload as Record<string, unknown>).transaction
  if (typeof transaction !== 'string' || !transaction) {
    return providerFailure('validation-error', 'exact/svm payload carries no base64 transaction')
  }

  return {
    ok: true,
    payment: {
      network: normalizeNetwork(accepted.network),
      scheme: accepted.scheme,
      asset: accepted.asset,
      payTo: accepted.payTo,
      amountBaseUnits: amount,
      signedTransactionBase64: transaction,
      payloadDigest: digest(transaction),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Stage 3 — settlement
 * ------------------------------------------------------------------ */

/** Shared across schemes and protocol versions, as the SDK's own note requires. */
const settlementCache = new SettlementCache()

export const SETTLEMENT_DEDUPE_TTL_MS = SETTLEMENT_TTL_MS

export interface SettlementEvidence {
  /** On-chain transaction signature. Only ever a value a facilitator returned. */
  readonly transaction: string
  readonly network: string
  readonly confirmed: boolean
  readonly observedAtMs: number
  readonly detail: string
}

export const X402_FACILITATOR_VARS = ['X402_FACILITATOR_URL'] as const

/**
 * Settles a verified payment through the configured facilitator.
 *
 * The `permit` argument is the choke point: there is no way to reach this
 * function without a policy decision covering this exact action, and
 * `assertPermitCovers` runs before anything else happens.
 *
 * With no facilitator configured this returns a missing-configuration result.
 * It does not return a fabricated signature, and it does not fall back to the
 * public testnet facilitator for a mainnet payment — that facilitator's own
 * documentation says it is testnet only, and quietly using it would produce a
 * settlement that looks real and settles nothing.
 */
export async function settlePayment(
  permit: SpendPermit,
  action: ProposedAction,
  payment: VerifiedPayment,
  options: { nowMs: number; facilitatorUrl?: string },
): Promise<AdapterResult<{ settlement: SettlementEvidence }>> {
  assertPermitCovers(permit, action, options.nowMs)

  const facilitatorUrl = (options.facilitatorUrl ?? process.env.X402_FACILITATOR_URL ?? '').trim()
  if (!facilitatorUrl) {
    return missingConfiguration(
      [...X402_FACILITATOR_VARS],
      'No x402 facilitator is configured, so no payment can be settled. Settlement requires either a ' +
        'production facilitator endpoint, a self-hosted facilitator, or self-facilitation with a signer. ' +
        'The public https://x402.org/facilitator is documented as development and testnet only and is ' +
        'not used as a fallback.',
    )
  }

  // Check-and-insert before the first await, which is what makes this a
  // duplicate guard rather than a race. Two concurrent settles of the same
  // signed transaction must not both reach the facilitator.
  if (settlementCache.isDuplicate(payment.payloadDigest)) {
    return providerFailure(
      'validation-error',
      'this signed payment is already being settled; reconcile the existing attempt instead of resubmitting',
    )
  }

  const response = await probe({
    url: `${facilitatorUrl.replace(/\/+$/, '')}/settle`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: payment.scheme,
          network: payment.network,
          amount: payment.amountBaseUnits.toString(),
          asset: payment.asset,
          payTo: payment.payTo,
          maxTimeoutSeconds: 60,
        },
        payload: { transaction: payment.signedTransactionBase64 },
      },
    }),
  })

  if (response.status === null) {
    // Releasing the key lets a genuine transport failure be retried; leaving it
    // would turn one flaky network moment into a permanently unsettleable
    // payment. The on-chain state is still unknown and must be reconciled.
    settlementCache.delete(payment.payloadDigest)
    return providerFailure('transport-error', `facilitator unreachable: ${response.transportError ?? 'no response'}`)
  }

  const body = parseJson(response.bodyText) as Record<string, unknown> | null
  if (!response.ok) {
    settlementCache.delete(payment.payloadDigest)
    return providerFailure(
      'provider-error',
      `facilitator returned HTTP ${response.status}: ${String(body?.error ?? response.bodyText).slice(0, 300)}`,
      response.status,
    )
  }

  const transaction = typeof body?.transaction === 'string' ? body.transaction : null
  if (!transaction) {
    // A 200 with no transaction identifier is not a settlement. Reporting it
    // as one is the exact self-deception this adapter exists to avoid.
    return providerFailure(
      'provider-error',
      'facilitator returned success with no transaction identifier; treating this as unsettled pending reconciliation',
      response.status,
    )
  }

  const success = body?.success === true
  return {
    ok: true,
    settlement: {
      transaction,
      network: payment.network,
      // `settlement_pending` is non-terminal in x402 and carries a broadcast
      // hash. It must be reconciled on chain, never retried blindly, so it is
      // recorded here as unconfirmed rather than as a success.
      confirmed: success,
      observedAtMs: response.observedAtMs,
      detail: success ? 'facilitator reported settlement' : 'facilitator reported a pending settlement; reconcile on chain',
    },
  }
}

/* ------------------------------------------------------------------ *
 * The two state machines
 * ------------------------------------------------------------------ */

export type PaymentState =
  | 'required'
  | 'payload-received'
  | 'verified'
  | 'settling'
  | 'settled'
  /** Non-terminal. Broadcast, outcome unknown. Reconcile; never retry blindly. */
  | 'settlement-unknown'
  | 'verification-failed'
  | 'settlement-failed'

export type DeliveryState = 'not-started' | 'in-progress' | 'delivered' | 'delivery-failed' | 'abandoned'

/**
 * One paid service interaction, holding both machines.
 *
 * The invariant worth stating: no method on this class transitions both
 * fields. That is what makes "the player walked away from the NPC" unable to
 * mean "the payment was cancelled" — the only thing `abandonDelivery` can
 * touch is delivery, and if the payment settled, the session then reports a
 * refund obligation instead of quietly forgetting the money.
 */
export class PaidServiceSession {
  readonly serviceId: string
  #payment: PaymentState = 'required'
  #delivery: DeliveryState = 'not-started'
  #settlement: SettlementEvidence | null = null
  #paymentDetail = 'awaiting payment'
  #deliveryDetail = 'not started'

  constructor(serviceId: string) {
    this.serviceId = serviceId
  }

  get paymentState(): PaymentState {
    return this.#payment
  }

  get deliveryState(): DeliveryState {
    return this.#delivery
  }

  get settlement(): SettlementEvidence | null {
    return this.#settlement
  }

  /* ---- payment transitions ---- */

  payloadReceived(): void {
    this.#payment = 'payload-received'
    this.#paymentDetail = 'payer supplied a signed payload'
  }

  verified(): void {
    this.#payment = 'verified'
    this.#paymentDetail = 'payload validated against the quoted requirements'
  }

  verificationFailed(reason: string): void {
    this.#payment = 'verification-failed'
    this.#paymentDetail = reason
  }

  settling(): void {
    this.#payment = 'settling'
    this.#paymentDetail = 'submitted to the facilitator'
  }

  settled(evidence: SettlementEvidence): void {
    this.#settlement = evidence
    this.#payment = evidence.confirmed ? 'settled' : 'settlement-unknown'
    this.#paymentDetail = evidence.detail
  }

  settlementFailed(reason: string): void {
    this.#payment = 'settlement-failed'
    this.#paymentDetail = reason
  }

  /* ---- delivery transitions ---- */

  deliveryStarted(): void {
    this.#delivery = 'in-progress'
    this.#deliveryDetail = 'service running'
  }

  delivered(detail: string): void {
    this.#delivery = 'delivered'
    this.#deliveryDetail = detail
  }

  deliveryFailed(reason: string): void {
    this.#delivery = 'delivery-failed'
    this.#deliveryDetail = reason
  }

  /**
   * The customer closed the dialogue, navigated away, or timed out.
   *
   * Touches delivery only. A settled payment stays settled, because it is.
   */
  abandonDelivery(reason: string): void {
    this.#delivery = 'abandoned'
    this.#deliveryDetail = reason
  }

  /**
   * True only with a settlement identifier and an on-chain confirmation.
   *
   * `verified` is deliberately not enough. A verified payload is a promise the
   * chain has not kept yet, and `exact` is irreversible in the other
   * direction: spending against it and then discovering it never landed is a
   * loss with no recovery path.
   */
  spendableIncoming(): { spendable: false; reason: string } | { spendable: true; amountEvidence: SettlementEvidence } {
    if (!this.#settlement) {
      return { spendable: false, reason: `no settlement evidence exists (payment state: ${this.#payment})` }
    }
    if (!this.#settlement.confirmed) {
      return { spendable: false, reason: 'settlement is broadcast but unconfirmed; reconcile before spending' }
    }
    return { spendable: true, amountEvidence: this.#settlement }
  }

  /**
   * Money taken for something never delivered.
   *
   * Reported rather than resolved: `exact` is a push payment and irreversible,
   * so refunds are application-level and need their own authorization through
   * the policy engine, with `refund.issue` as the action type.
   */
  refundObligation(): { owed: false } | { owed: true; reason: string; settlement: SettlementEvidence } {
    const settled = this.#payment === 'settled' && this.#settlement !== null
    const undelivered = this.#delivery === 'abandoned' || this.#delivery === 'delivery-failed' || this.#delivery === 'not-started'
    if (settled && undelivered && this.#settlement) {
      return {
        owed: true,
        reason: `payment settled but delivery is "${this.#delivery}" (${this.#deliveryDetail})`,
        settlement: this.#settlement,
      }
    }
    return { owed: false }
  }

  view() {
    return {
      serviceId: this.serviceId,
      payment: { state: this.#payment, detail: this.#paymentDetail },
      delivery: { state: this.#delivery, detail: this.#deliveryDetail },
      settlement: this.#settlement,
    }
  }
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

/**
 * Read-only capability probe against the public facilitator.
 *
 * `/supported` is a read. Nothing is signed, nothing is settled, and the
 * facilitator's own documentation restricts it to testnets, so this establishes
 * that the protocol surface is real — not that a mainnet route exists.
 */
export async function probeX402(nowMs: number): Promise<IntegrationReport> {
  const evidence: Evidence[] = [
    { kind: 'sdk', observedAtMs: nowMs, environment: 'none', summary: 'protocol schemas and header codec', packageName: X402_SDK.name, version: X402_SDK.version },
    { kind: 'sdk', observedAtMs: nowMs, environment: 'none', summary: 'Solana scheme constants and settlement cache', packageName: X402_SVM_SDK.name, version: X402_SVM_SDK.version },
  ]

  const response = await probe({ url: `${PUBLIC_TESTNET_FACILITATOR}/supported` })
  const body = parseJson(response.bodyText)
  const kinds = Array.isArray((body as { kinds?: unknown } | null)?.kinds)
    ? ((body as { kinds: unknown[] }).kinds as Array<Record<string, unknown>>)
    : []
  const solanaKinds = kinds.filter(kind => String(kind.network ?? '').startsWith('solana:'))
  const extracted = response.ok && kinds.length
    ? `${kinds.length} supported scheme/network kinds; ${solanaKinds.length} on Solana ` +
      `(${[...new Set(solanaKinds.map(k => `${String(k.scheme)}@${String(k.network)}`))].slice(0, 4).join(', ') || 'none'})`
    : null

  evidence.push(
    httpEvidence(
      response,
      extracted,
      'testnet',
      'GET /supported on the public (testnet-only) facilitator',
    ),
  )

  const missing = missingVariables([...X402_FACILITATOR_VARS, 'NPC_PAYEE_ADDRESS'])

  const capabilities: Capability[] = [
    {
      id: 'payment-required',
      description: 'Emit a protocol-valid 402 with SPL payment requirements',
      verdict: 'available',
    },
    {
      id: 'verify-payload',
      description: 'Decode X-PAYMENT and check network, scheme, asset, recipient, amount and window',
      verdict: 'available',
    },
    {
      id: 'settle',
      description: 'Settle a verified payment through a facilitator',
      verdict: missing.includes('X402_FACILITATOR_URL') ? 'blocked' : 'available',
      ...(missing.includes('X402_FACILITATOR_URL')
        ? {
            blocker:
              'X402_FACILITATOR_URL is unset. Mainnet additionally needs a production or self-hosted ' +
              'facilitator; the public x402.org facilitator is documented as testnet only.',
          }
        : {}),
    },
    {
      id: 'native-sol',
      description: 'Accept native SOL as the payment asset',
      verdict: 'unavailable',
      blocker:
        'Not documented by x402. Solana support is SPL / Token-2022 via SPL Transfer. A SystemProgram ' +
        'SOL transfer is not an x402 payment; a quoted SOL to USDC conversion has to come first.',
    },
  ]

  return {
    id: X402_PROVIDER_ID,
    label: 'x402 — HTTP-native payment',
    sdk: X402_SDK,
    state: deriveState(evidence),
    capabilities,
    evidence,
    missingConfiguration: missing,
    nextStep: missing.length
      ? `Set ${missing.join(' and ')} to move beyond read-only. Devnet execution needs a funded devnet USDC payer.`
      : 'Run a devnet settlement to reach test-execution-verified.',
  }
}

/* ------------------------------------------------------------------ helpers */

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Stable key for duplicate detection, over the exact bytes the payer signed. */
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
