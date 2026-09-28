/* ------------------------------------------------------------------ *
 * The bounded-authorization record (§4).
 *
 * This is the only thing in the system that permits money to move. It is
 * declared in `src/shared` rather than inside the policy engine because the
 * ledger needs to persist it and the operator console needs to display it,
 * and all three must agree on the field list down to the last fee bucket.
 *
 * Two rules shape the whole file:
 *
 *   1. **Every amount is an integer of base units, held as a bigint.** No
 *      float ever touches a money path. `SerializedAuthorization` below is
 *      the on-the-wire and in-the-database form, where the same values are
 *      decimal strings — the shape the existing `receipts` table already
 *      uses for lamports, so the convention is not new.
 *
 *   2. **An authorization is not data that can be described; it is a value
 *      that must be minted.** The runtime type carries a symbol-keyed brand
 *      (see `src/server/policy/mint.ts`), and a symbol key cannot survive
 *      `JSON.parse`. That is the structural reason a language model, a
 *      scraped page, or a creator-supplied prompt cannot produce one: they
 *      can only ever produce parsed JSON.
 * ------------------------------------------------------------------ */

/**
 * Operations that can move money or produce a signature.
 *
 * Quoting, asset discovery, and address parsing are deliberately absent:
 * they are read-only and need no authorization, and keeping them out of this
 * list is what makes "research does not authorize a trade" a type error
 * rather than a convention.
 */
export const ACTION_TYPES = [
  /** Settle a verified x402 payment on chain. */
  'x402.settle',
  /** Send the conversion principal to a provider-controlled deposit address. */
  'conversion.deposit',
  /** Shield a transparent receipt into a shielded pool. */
  'zcash.shield',
  /** Spend from a shielded pool to the approved recipient. */
  'zcash.send',
  /** Return funds to the approved refund destination. */
  'refund.issue',
] as const

export type ActionType = (typeof ACTION_TYPES)[number]

export const isActionType = (value: unknown): value is ActionType =>
  typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value)

/**
 * What the destination receiver must be, stated by the owner at approval time.
 *
 * `shielded-required` is the flagship route's promise. It exists as an
 * explicit field so a downgrade to transparent delivery is a policy denial
 * with a name, not an unnoticed change of behaviour.
 */
export type ReceiverRequirement = 'shielded-required' | 'transparent-allowed'

/** What a route stage actually observed the receiver to be. */
export type ObservedReceiver = 'shielded' | 'transparent' | 'unknown'

/** A specific asset on a specific network, with the decimals its base units imply. */
export interface AssetRef {
  /** CAIP-2 network identifier, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. */
  readonly network: string
  /** Contract, mint, or protocol asset id. `native` for a chain's own unit. */
  readonly assetId: string
  /** Decimals the base units are expressed in. Recorded, never used to divide. */
  readonly decimals: number
  /** Display symbol. Never used for comparison. */
  readonly symbol: string
}

/**
 * The four cost buckets §4 requires be bounded separately.
 *
 * They are separate because they fail differently: a network fee spike is
 * not a service-fee increase, and collapsing them into one ceiling means a
 * provider can quietly move cost from a bucket the owner priced into one
 * they did not.
 */
export interface CostEnvelope {
  readonly serviceFeeBaseUnits: bigint
  readonly conversionCostBaseUnits: bigint
  readonly networkFeesBaseUnits: bigint
  readonly contingencyBaseUnits: bigint
}

/** Where money goes if the route fails. Bound at approval time, never inferred. */
export interface RefundDestination {
  readonly network: string
  readonly address: string
}

/** The fields of an authorization, without the mint brand. */
export interface AuthorizationFields {
  /* ---- identity and binding ---- */
  readonly authorizationId: string
  /** Bumped whenever the owner re-approves. A permit for v1 is void at v2. */
  readonly version: number
  /** The account that approved. Comes from a verified session, never a body. */
  readonly owner: string
  readonly serviceId: string
  readonly jobId: string

  /* ---- source of funds ---- */
  readonly sourceAsset: AssetRef
  /** Ceiling on the value being converted, excluding fees. */
  readonly maxPrincipalBaseUnits: bigint
  /** Ceiling on principal plus every fee. The number the owner actually agreed to lose. */
  readonly maxTotalDebitBaseUnits: bigint
  readonly costs: CostEnvelope

  /* ---- destination ---- */
  readonly destinationNetwork: string
  /** The exact recipient. Substituting it is a denial, not a warning. */
  readonly destinationRecipient: string
  readonly destinationReceiver: ReceiverRequirement
  readonly refundDestination: RefundDestination

  /* ---- execution bounds ---- */
  readonly minNetOutputBaseUnits: bigint
  readonly minNetOutputAsset: AssetRef
  readonly slippageLimitBps: number
  /** Provider ids that may be used. An unlisted provider is out of bounds. */
  readonly approvedProviders: readonly string[]
  readonly allowedActionTypes: readonly ActionType[]
  /**
   * Digest of the route the owner approved. A stage that proposes a different
   * route presents a different digest and is denied, which is what makes an
   * out-of-bounds route change detectable rather than merely unlikely.
   */
  readonly approvedRouteDigest: string

  /* ---- lifecycle ---- */
  readonly expiresAtMs: number
  /** Single-use. Consumed by the ledger, checked here on every action. */
  readonly nonce: string
  /** The owner's rolling ceiling across all authorizations, not just this one. */
  readonly cumulativeBudgetBaseUnits: bigint
  readonly revoked: boolean
}

/**
 * Brand applied by `mintAuthorization`.
 *
 * A `unique symbol` used as a property key is the enforcement mechanism, not
 * documentation: `JSON.parse` cannot produce a symbol-keyed property, so no
 * value that arrived as text — model output, a scraped page, a request body —
 * can satisfy this type at runtime, and a cast cannot conjure the key either.
 */
declare const authorizationBrand: unique symbol

export type Authorization = AuthorizationFields & {
  readonly [authorizationBrand]: 'owner-minted'
}

/** The database and wire form: every bigint as an exact decimal string. */
export interface SerializedAuthorization {
  readonly authorizationId: string
  readonly version: number
  readonly owner: string
  readonly serviceId: string
  readonly jobId: string
  readonly sourceAsset: AssetRef
  readonly maxPrincipalBaseUnits: string
  readonly maxTotalDebitBaseUnits: string
  readonly costs: {
    readonly serviceFeeBaseUnits: string
    readonly conversionCostBaseUnits: string
    readonly networkFeesBaseUnits: string
    readonly contingencyBaseUnits: string
  }
  readonly destinationNetwork: string
  readonly destinationRecipient: string
  readonly destinationReceiver: ReceiverRequirement
  readonly refundDestination: RefundDestination
  readonly minNetOutputBaseUnits: string
  readonly minNetOutputAsset: AssetRef
  readonly slippageLimitBps: number
  readonly approvedProviders: readonly string[]
  readonly allowedActionTypes: readonly ActionType[]
  readonly approvedRouteDigest: string
  readonly expiresAtMs: number
  readonly nonce: string
  readonly cumulativeBudgetBaseUnits: string
  readonly revoked: boolean
}

/**
 * Persistence form. Deliberately loses the brand: a round trip through the
 * database must go back through `mintAuthorization`, which re-validates every
 * bound instead of trusting whatever is in the row.
 */
export function serializeAuthorization(auth: AuthorizationFields): SerializedAuthorization {
  return {
    authorizationId: auth.authorizationId,
    version: auth.version,
    owner: auth.owner,
    serviceId: auth.serviceId,
    jobId: auth.jobId,
    sourceAsset: auth.sourceAsset,
    maxPrincipalBaseUnits: auth.maxPrincipalBaseUnits.toString(),
    maxTotalDebitBaseUnits: auth.maxTotalDebitBaseUnits.toString(),
    costs: {
      serviceFeeBaseUnits: auth.costs.serviceFeeBaseUnits.toString(),
      conversionCostBaseUnits: auth.costs.conversionCostBaseUnits.toString(),
      networkFeesBaseUnits: auth.costs.networkFeesBaseUnits.toString(),
      contingencyBaseUnits: auth.costs.contingencyBaseUnits.toString(),
    },
    destinationNetwork: auth.destinationNetwork,
    destinationRecipient: auth.destinationRecipient,
    destinationReceiver: auth.destinationReceiver,
    refundDestination: auth.refundDestination,
    minNetOutputBaseUnits: auth.minNetOutputBaseUnits.toString(),
    minNetOutputAsset: auth.minNetOutputAsset,
    slippageLimitBps: auth.slippageLimitBps,
    approvedProviders: [...auth.approvedProviders],
    allowedActionTypes: [...auth.allowedActionTypes],
    approvedRouteDigest: auth.approvedRouteDigest,
    expiresAtMs: auth.expiresAtMs,
    nonce: auth.nonce,
    cumulativeBudgetBaseUnits: auth.cumulativeBudgetBaseUnits.toString(),
    revoked: auth.revoked,
  }
}

/* ------------------------------------------------------------------ *
 * What the ledger has to provide.
 *
 * The policy engine is pure and holds no state, so the two facts it cannot
 * derive — how much has already been debited, and whether the single-use
 * nonce has been burned — must be handed to it. This interface is the
 * request to the ledger owner; nothing in this directory implements it.
 * ------------------------------------------------------------------ */

/**
 * Point-in-time spend facts for one authorization.
 *
 * Both "already debited" figures are required rather than optional because a
 * missing number must not read as zero. An unavailable ledger is a denial
 * (`ledger_unavailable`), not an implicit clean slate.
 */
export interface LedgerSnapshot {
  /** Base units already irreversibly debited under this authorization. */
  readonly debitedBaseUnits: bigint
  /** Base units debited under every authorization counted against the owner's rolling budget. */
  readonly cumulativeDebitedBaseUnits: bigint
  /** True once the single-use nonce has been consumed by any action. */
  readonly nonceConsumed: boolean
  /**
   * Action digests already settled under this authorization.
   *
   * Presence means "this exact action already happened", which is how a
   * retry is told apart from a second spend. An x402 settlement that is
   * already in here must not be broadcast again.
   */
  readonly settledActionDigests: readonly string[]
}

/**
 * The persistence the policy engine needs but does not own. Handed to the
 * ledger agent as-is.
 *
 * `consumeNonce` and `recordDebit` must be a single conditional `UPDATE`
 * inside one transaction, in the shape `src/server/db.ts` already uses for
 * sign-in nonces, so that two concurrent jobs cannot both win.
 */
export interface AuthorizationLedger {
  /** Never throws for a missing row; a missing authorization is a denial upstream. */
  snapshot(authorizationId: string): Promise<LedgerSnapshot | null>
  /** Returns false if the nonce was already consumed. Must be atomic. */
  consumeNonce(authorizationId: string, nonce: string): Promise<boolean>
  /** Append-only. `actionDigest` makes it idempotent under retry. */
  recordDebit(input: {
    authorizationId: string
    actionDigest: string
    baseUnits: bigint
    countsTowardCumulativeBudget: boolean
  }): Promise<void>
  /** Releases an unspent reservation. Must never reverse a recorded debit. */
  releaseReservation(authorizationId: string, actionDigest: string): Promise<void>
}
