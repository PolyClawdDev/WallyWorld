/* ------------------------------------------------------------------ *
 * The policy engine (§4).
 *
 * A pure, deterministic function: an authorization plus a proposed action
 * plus a ledger snapshot in, allow-or-deny-with-a-reason out. No clock, no
 * network, no database, no randomness — `nowMs` is an argument precisely so
 * that expiry is testable and so that two callers evaluating the same action
 * at the same instant cannot reach different verdicts.
 *
 * It is called before **every** signing or spending operation rather than
 * once at approval time, and the way that is enforced is `SpendPermit`: the
 * only value the engine hands out is scoped to one action digest, expires,
 * and is the required argument of every adapter method that could move money
 * (see `src/server/providers/`). There is no "authorized job" flag anywhere;
 * there is only a permit for one action, obtained immediately before it.
 *
 * Deny order is fixed and the first failure wins. That is a deliberate
 * choice: a stable reason code makes the operator console and the tests agree
 * on why something was refused, and "revoked" should never be reported as
 * "quote expired" just because the checks ran in a different order.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import {
  isActionType,
  type ActionType,
  type Authorization,
  type AssetRef,
  type LedgerSnapshot,
  type ObservedReceiver,
} from '../../shared/authorization'
import { assertMinted } from './mint'
import { sumBaseUnits } from './units'

/* ------------------------------------------------------------------ *
 * Reason codes
 * ------------------------------------------------------------------ */

export const DENY_CODES = [
  'authorization_revoked',
  'authorization_expired',
  'authorization_version_mismatch',
  'owner_mismatch',
  'job_mismatch',
  'action_type_not_allowed',
  'provider_not_approved',
  'route_out_of_bounds',
  'source_network_mismatch',
  'source_asset_mismatch',
  'destination_network_mismatch',
  'destination_substituted',
  'refund_destination_substituted',
  'shielded_delivery_required',
  'receiver_unverified',
  'quote_expired',
  'quote_not_yet_valid',
  'slippage_exceeds_limit',
  'output_below_minimum',
  'output_asset_mismatch',
  'principal_exceeds_maximum',
  'fee_cap_exceeded',
  'total_debit_exceeds_maximum',
  'cumulative_budget_exhausted',
  'nonce_replayed',
  'duplicate_action',
  'ledger_unavailable',
  'malformed_action',
] as const

export type DenyCode = (typeof DENY_CODES)[number]

/* ------------------------------------------------------------------ *
 * The proposed action
 * ------------------------------------------------------------------ */

/**
 * What a route stage is about to do, in the stage's own words.
 *
 * Note what is absent: there is no `approved`, no `authorized`, no
 * `skipChecks`. The type has no field through which a caller could assert its
 * own legitimacy, and `readProposal` below rejects an object carrying extra
 * keys, so an injected one is an error rather than a field the engine happens
 * not to read.
 */
export interface ProposedAction {
  readonly type: ActionType
  /** Provider id, matched against the authorization's approved list. */
  readonly provider: string
  /** Digest of the concrete route this stage belongs to. */
  readonly routeDigest: string

  readonly sourceAsset: AssetRef
  /** Value being moved, excluding fees. */
  readonly principalBaseUnits: bigint
  readonly fees: {
    readonly serviceFeeBaseUnits: bigint
    readonly conversionCostBaseUnits: bigint
    readonly networkFeesBaseUnits: bigint
  }

  readonly destinationNetwork: string
  readonly destinationRecipient: string
  /**
   * What the stage actually established about the receiver, not what the
   * address looks like. `unknown` is a denial when shielded delivery was
   * promised — a provider accepting an address is not a receiver check.
   */
  readonly destinationReceiver: ObservedReceiver
  readonly refundDestination: { readonly network: string; readonly address: string }

  readonly expectedNetOutputBaseUnits: bigint
  readonly outputAsset: AssetRef
  readonly slippageBps: number

  /** Quote validity window, from the provider. Both bounds are checked. */
  readonly quotedAtMs: number
  readonly quoteExpiresAtMs: number

  /** Must equal the authorization's single-use nonce. */
  readonly nonce: string
}

const PROPOSAL_KEYS = new Set<string>([
  'type',
  'provider',
  'routeDigest',
  'sourceAsset',
  'principalBaseUnits',
  'fees',
  'destinationNetwork',
  'destinationRecipient',
  'destinationReceiver',
  'refundDestination',
  'expectedNetOutputBaseUnits',
  'outputAsset',
  'slippageBps',
  'quotedAtMs',
  'quoteExpiresAtMs',
  'nonce',
])

export class MalformedActionError extends Error {}

/**
 * Validates an untyped proposal.
 *
 * Adapters build proposals in TypeScript and do not need this, but anything
 * that arrived over a wire does: an unknown key here means something added a
 * field the engine does not evaluate, and silently ignoring it is how an
 * injected `approved` becomes invisible rather than harmless.
 */
export function readProposal(value: unknown): ProposedAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedActionError('proposed action must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_KEYS.has(key)) {
      throw new MalformedActionError(`proposed action carries unknown field "${key}"`)
    }
  }
  const action = value as Record<string, unknown>
  if (!isActionType(action.type)) throw new MalformedActionError('proposed action has no known type')
  return value as ProposedAction
}

/* ------------------------------------------------------------------ *
 * Action digest
 * ------------------------------------------------------------------ */

/**
 * A stable fingerprint of everything about an action that matters for money.
 *
 * It exists for three jobs: binding a permit to exactly one action, letting
 * the ledger recognise a retry of the same action rather than a second spend,
 * and making a changed route visibly a different action. bigints are written
 * as decimal strings so the digest is stable across serialisation.
 */
export function actionDigest(action: ProposedAction): string {
  const canonical = JSON.stringify([
    action.type,
    action.provider,
    action.routeDigest,
    [action.sourceAsset.network, action.sourceAsset.assetId, action.sourceAsset.decimals],
    action.principalBaseUnits.toString(),
    [
      action.fees.serviceFeeBaseUnits.toString(),
      action.fees.conversionCostBaseUnits.toString(),
      action.fees.networkFeesBaseUnits.toString(),
    ],
    action.destinationNetwork,
    action.destinationRecipient,
    action.destinationReceiver,
    [action.refundDestination.network, action.refundDestination.address],
    action.expectedNetOutputBaseUnits.toString(),
    [action.outputAsset.network, action.outputAsset.assetId, action.outputAsset.decimals],
    action.slippageBps,
    action.quotedAtMs,
    action.quoteExpiresAtMs,
    action.nonce,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/* ------------------------------------------------------------------ *
 * The permit
 * ------------------------------------------------------------------ */

const permits = new WeakSet<object>()

/**
 * Permission for exactly one action, valid for a short window.
 *
 * Every adapter method that can sign or spend takes one of these. Because it
 * is a registered class instance it cannot be produced by `JSON.parse`, so
 * there is no wire representation of "already authorized" for a model, a
 * scraped page, or a request body to supply. And because it names one action
 * digest, it cannot be reused for the next stage of the route: that stage has
 * to come back through the engine.
 */
export class SpendPermit {
  readonly authorizationId: string
  readonly authorizationVersion: number
  readonly owner: string
  readonly jobId: string
  readonly actionType: ActionType
  readonly actionDigest: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  /** Principal plus fees this one action is allowed to debit. */
  readonly debitBaseUnits: bigint

  private constructor(input: {
    authorizationId: string
    authorizationVersion: number
    owner: string
    jobId: string
    actionType: ActionType
    actionDigest: string
    issuedAtMs: number
    expiresAtMs: number
    debitBaseUnits: bigint
  }) {
    this.authorizationId = input.authorizationId
    this.authorizationVersion = input.authorizationVersion
    this.owner = input.owner
    this.jobId = input.jobId
    this.actionType = input.actionType
    this.actionDigest = input.actionDigest
    this.issuedAtMs = input.issuedAtMs
    this.expiresAtMs = input.expiresAtMs
    this.debitBaseUnits = input.debitBaseUnits
    Object.freeze(this)
  }

  /** Module-private: only `decide` reaches this. */
  static issue(input: {
    authorizationId: string
    authorizationVersion: number
    owner: string
    jobId: string
    actionType: ActionType
    actionDigest: string
    issuedAtMs: number
    expiresAtMs: number
    debitBaseUnits: bigint
  }): SpendPermit {
    const permit = new SpendPermit(input)
    permits.add(permit)
    return permit
  }

  /** Never put a permit in a log line or an LLM prompt; this keeps that cheap. */
  toString(): string {
    return `[spend-permit:${this.actionType}:${this.actionDigest.slice(0, 12)}]`
  }
}

/** How long a permit is good for. Short, because it is consumed immediately. */
export const PERMIT_TTL_MS = 60_000

export class PermitError extends Error {}

/**
 * The guard every adapter calls first.
 *
 * Checks the registry (so the permit came from this engine), the expiry (so a
 * permit left in a retry queue cannot be replayed an hour later), and that the
 * digest matches the action about to be performed (so a permit for stage 3 is
 * not accepted by stage 4).
 */
export function assertPermitCovers(permit: unknown, action: ProposedAction, nowMs: number): SpendPermit {
  if (!(permit instanceof SpendPermit) || !permits.has(permit)) {
    throw new PermitError('missing spend permit: this operation requires a policy decision first')
  }
  if (nowMs > permit.expiresAtMs) {
    throw new PermitError('spend permit expired; re-evaluate the policy before retrying')
  }
  const digest = actionDigest(action)
  if (digest !== permit.actionDigest) {
    throw new PermitError('spend permit does not cover this action; the action changed after approval')
  }
  if (permit.actionType !== action.type) {
    throw new PermitError('spend permit was issued for a different action type')
  }
  return permit
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

export interface PolicyInput {
  readonly authorization: Authorization
  readonly action: ProposedAction
  /** `null` means the ledger could not be read, which denies rather than assumes zero. */
  readonly ledger: LedgerSnapshot | null
  readonly nowMs: number
}

export type PolicyDecision =
  | {
      readonly allow: true
      readonly permit: SpendPermit
      readonly actionDigest: string
      /** What this action will debit if it succeeds. */
      readonly debitBaseUnits: bigint
    }
  | {
      readonly allow: false
      readonly code: DenyCode
      readonly reason: string
      readonly actionDigest: string
    }

const sameAsset = (a: AssetRef, b: AssetRef): boolean =>
  a.network === b.network && a.assetId === b.assetId && a.decimals === b.decimals

/**
 * Evaluate one proposed action against one authorization.
 *
 * Pure. Given the same four inputs it returns the same verdict, which is why
 * every case in the test file is a plain function call with no fixtures, no
 * server, and no clock.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const authorization = assertMinted(input.authorization)
  const action = input.action
  const now = input.nowMs
  const digest = actionDigest(action)

  const deny = (code: DenyCode, reason: string): PolicyDecision => ({
    allow: false,
    code,
    reason,
    actionDigest: digest,
  })

  /* ---- 1. is this authorization alive at all ---- */

  if (authorization.revoked) {
    return deny('authorization_revoked', `authorization ${authorization.authorizationId} has been revoked`)
  }
  if (now >= authorization.expiresAtMs) {
    return deny(
      'authorization_expired',
      `authorization expired at ${authorization.expiresAtMs}, now ${now}`,
    )
  }

  /* ---- 2. does it even describe this action ---- */

  if (!authorization.allowedActionTypes.includes(action.type)) {
    return deny(
      'action_type_not_allowed',
      `action "${action.type}" is not in the approved list [${authorization.allowedActionTypes.join(', ')}]`,
    )
  }
  if (!authorization.approvedProviders.includes(action.provider)) {
    return deny(
      'provider_not_approved',
      `provider "${action.provider}" is not approved; approved: [${authorization.approvedProviders.join(', ')}]`,
    )
  }
  if (action.routeDigest !== authorization.approvedRouteDigest) {
    return deny(
      'route_out_of_bounds',
      'the route changed after approval: proposed route digest does not match the approved one',
    )
  }

  /* ---- 3. money in ---- */

  if (!sameAsset(action.sourceAsset, authorization.sourceAsset)) {
    if (action.sourceAsset.network !== authorization.sourceAsset.network) {
      return deny(
        'source_network_mismatch',
        `source network ${action.sourceAsset.network} is not the approved ${authorization.sourceAsset.network}`,
      )
    }
    return deny(
      'source_asset_mismatch',
      `source asset ${action.sourceAsset.assetId} is not the approved ${authorization.sourceAsset.assetId}`,
    )
  }

  /* ---- 4. money out ---- */

  if (action.destinationNetwork !== authorization.destinationNetwork) {
    return deny(
      'destination_network_mismatch',
      `destination network ${action.destinationNetwork} is not the approved ${authorization.destinationNetwork}`,
    )
  }
  if (action.destinationRecipient !== authorization.destinationRecipient) {
    // Exact string equality on purpose. There is no normalisation step here,
    // because "these two addresses are probably the same" is precisely the
    // judgement an attacker wants the engine to make.
    return deny(
      'destination_substituted',
      'proposed recipient is not the exact recipient the owner approved',
    )
  }
  if (
    action.refundDestination.network !== authorization.refundDestination.network ||
    action.refundDestination.address !== authorization.refundDestination.address
  ) {
    return deny(
      'refund_destination_substituted',
      'proposed refund destination is not the approved refund destination',
    )
  }
  if (authorization.destinationReceiver === 'shielded-required') {
    if (action.destinationReceiver === 'transparent') {
      return deny(
        'shielded_delivery_required',
        'the owner approved shielded delivery; this stage would deliver to a transparent receiver',
      )
    }
    if (action.destinationReceiver !== 'shielded') {
      return deny(
        'receiver_unverified',
        'shielded delivery was approved but the receiver could not be established as shielded; ' +
          'a provider accepting the address is not evidence of shielded delivery',
      )
    }
  }

  /* ---- 5. is the quote still real ---- */

  if (action.quotedAtMs > now) {
    return deny('quote_not_yet_valid', `quote is timestamped ${action.quotedAtMs}, in the future relative to ${now}`)
  }
  if (now >= action.quoteExpiresAtMs) {
    return deny('quote_expired', `quote expired at ${action.quoteExpiresAtMs}, now ${now}`)
  }

  /* ---- 6. execution bounds ---- */

  if (action.slippageBps > authorization.slippageLimitBps) {
    return deny(
      'slippage_exceeds_limit',
      `slippage ${action.slippageBps} bps exceeds the approved limit of ${authorization.slippageLimitBps} bps`,
    )
  }
  if (!sameAsset(action.outputAsset, authorization.minNetOutputAsset)) {
    return deny(
      'output_asset_mismatch',
      `output asset ${action.outputAsset.assetId} is not the asset the minimum was set in ` +
        `(${authorization.minNetOutputAsset.assetId})`,
    )
  }
  if (action.expectedNetOutputBaseUnits < authorization.minNetOutputBaseUnits) {
    return deny(
      'output_below_minimum',
      `expected net output ${action.expectedNetOutputBaseUnits} is below the approved minimum ` +
        `${authorization.minNetOutputBaseUnits}`,
    )
  }

  /* ---- 7. cost ceilings, bucket by bucket then in total ---- */

  if (action.principalBaseUnits > authorization.maxPrincipalBaseUnits) {
    return deny(
      'principal_exceeds_maximum',
      `principal ${action.principalBaseUnits} exceeds the approved maximum ${authorization.maxPrincipalBaseUnits}`,
    )
  }

  const caps = authorization.costs
  const fees = action.fees
  if (fees.serviceFeeBaseUnits > caps.serviceFeeBaseUnits) {
    return deny(
      'fee_cap_exceeded',
      `service fee ${fees.serviceFeeBaseUnits} exceeds the approved ${caps.serviceFeeBaseUnits}`,
    )
  }
  if (fees.conversionCostBaseUnits > caps.conversionCostBaseUnits) {
    return deny(
      'fee_cap_exceeded',
      `conversion cost ${fees.conversionCostBaseUnits} exceeds the approved ${caps.conversionCostBaseUnits}`,
    )
  }
  // Network fees may draw on the contingency the owner priced in, because a
  // fee market moving is the one cost nobody can quote exactly. Nothing else
  // may touch it.
  const networkFeeCeiling = caps.networkFeesBaseUnits + caps.contingencyBaseUnits
  if (fees.networkFeesBaseUnits > networkFeeCeiling) {
    return deny(
      'fee_cap_exceeded',
      `network fees ${fees.networkFeesBaseUnits} exceed the approved ${caps.networkFeesBaseUnits} ` +
        `plus contingency ${caps.contingencyBaseUnits}`,
    )
  }

  const debit = sumBaseUnits(
    action.principalBaseUnits,
    fees.serviceFeeBaseUnits,
    fees.conversionCostBaseUnits,
    fees.networkFeesBaseUnits,
  )
  if (debit > authorization.maxTotalDebitBaseUnits) {
    return deny(
      'total_debit_exceeds_maximum',
      `total debit ${debit} exceeds the approved maximum ${authorization.maxTotalDebitBaseUnits}`,
    )
  }

  /* ---- 8. what has already been spent ---- */

  const ledger = input.ledger
  if (!ledger) {
    return deny(
      'ledger_unavailable',
      'spend history could not be read; refusing to treat an unreadable ledger as an unspent one',
    )
  }

  if (ledger.settledActionDigests.includes(digest)) {
    // Not a failure: this exact action already happened. The caller must
    // reconcile rather than broadcast again. Closing a dialogue does not undo
    // it and re-running the stage must not duplicate it.
    return deny(
      'duplicate_action',
      'this exact action is already recorded as settled; reconcile it instead of repeating it',
    )
  }
  if (ledger.nonceConsumed) {
    return deny(
      'nonce_replayed',
      `single-use authorization nonce ${authorization.nonce} has already been consumed`,
    )
  }
  if (action.nonce !== authorization.nonce) {
    return deny('nonce_replayed', 'proposed action does not carry this authorization\'s single-use nonce')
  }

  if (ledger.debitedBaseUnits + debit > authorization.maxTotalDebitBaseUnits) {
    return deny(
      'total_debit_exceeds_maximum',
      `already debited ${ledger.debitedBaseUnits}; adding ${debit} would exceed ` +
        `${authorization.maxTotalDebitBaseUnits}`,
    )
  }
  if (ledger.cumulativeDebitedBaseUnits + debit > authorization.cumulativeBudgetBaseUnits) {
    return deny(
      'cumulative_budget_exhausted',
      `cumulative spend ${ledger.cumulativeDebitedBaseUnits} plus ${debit} would exceed the rolling ` +
        `budget of ${authorization.cumulativeBudgetBaseUnits}`,
    )
  }

  /* ---- allow ---- */

  // The permit expires at whichever comes first: its own short TTL, the
  // quote's validity, or the authorization's. A permit must never outlive the
  // thing that justified it.
  const expiresAtMs = Math.min(now + PERMIT_TTL_MS, action.quoteExpiresAtMs, authorization.expiresAtMs)

  return {
    allow: true,
    actionDigest: digest,
    debitBaseUnits: debit,
    permit: SpendPermit.issue({
      authorizationId: authorization.authorizationId,
      authorizationVersion: authorization.version,
      owner: authorization.owner,
      jobId: authorization.jobId,
      actionType: action.type,
      actionDigest: digest,
      issuedAtMs: now,
      expiresAtMs,
      debitBaseUnits: debit,
    }),
  }
}

/**
 * What is safe to show a model or write into a prompt.
 *
 * One-way on purpose: there is no `fromModelView`. A model can be told the
 * shape of the envelope it is working inside — that is genuinely useful for
 * planning — without that description being convertible back into permission.
 * Amounts are decimal strings so nothing downstream reintroduces a float.
 */
export function describeForModel(authorization: Authorization): Record<string, string | number | boolean | string[]> {
  return {
    serviceId: authorization.serviceId,
    jobId: authorization.jobId,
    sourceAsset: `${authorization.sourceAsset.symbol} on ${authorization.sourceAsset.network}`,
    maxPrincipalBaseUnits: authorization.maxPrincipalBaseUnits.toString(),
    maxTotalDebitBaseUnits: authorization.maxTotalDebitBaseUnits.toString(),
    minNetOutputBaseUnits: authorization.minNetOutputBaseUnits.toString(),
    destinationNetwork: authorization.destinationNetwork,
    destinationReceiver: authorization.destinationReceiver,
    slippageLimitBps: authorization.slippageLimitBps,
    approvedProviders: [...authorization.approvedProviders],
    allowedActionTypes: [...authorization.allowedActionTypes],
    expiresAtMs: authorization.expiresAtMs,
    revoked: authorization.revoked,
    // Deliberately omitted: the nonce, the exact recipient, the refund
    // address, and the authorization id. A model that never sees them cannot
    // leak them, and it needs none of them to plan.
    note: 'Describes limits only. Not permission. Spending requires a SpendPermit from the policy engine.',
  }
}
