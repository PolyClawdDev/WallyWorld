/* ------------------------------------------------------------------ *
 * The trust boundary: where an authorization can come from, and where it
 * structurally cannot (§4).
 *
 * The requirement is that NPC dialogue, scraped pages, and creator-supplied
 * prompts are data — that a model-generated `approved: true` is not an
 * authorization. Comments do not enforce that, so three mechanisms do:
 *
 *   1. **Runtime registries.** `mintAuthorization` puts the object it returns
 *      into a module-private `WeakSet`. `assertMinted` checks membership. A
 *      `WeakSet` has no literal form and no wire format, so there is no
 *      sequence of characters a model can emit that lands an object inside
 *      it. This is the mechanism that actually holds; the TypeScript brands
 *      are the compile-time echo of it.
 *
 *   2. **`Untrusted<T>` at ingestion.** Anything a model, a web page, or a
 *      creator produced is wrapped in a class instance whose payload can be
 *      read but which has no path to an `Authorization`. `JSON.parse` cannot
 *      produce a class instance, so the wrapper cannot be forged either.
 *
 *   3. **A closed field set.** `mintAuthorization` rejects an input object
 *      that carries any key outside the authorization's own field list, and
 *      rejects a small set of escalation-shaped keys (`approved`,
 *      `authorized`, `override`, `bypass`, …) anywhere in the input tree. A
 *      prompt-injected extra field is a thrown error, not an ignored one,
 *      because "ignored" is indistinguishable from "honoured" in a log.
 * ------------------------------------------------------------------ */

import {
  ACTION_TYPES,
  isActionType,
  type Authorization,
  type AuthorizationFields,
  type ActionType,
  type AssetRef,
  type ReceiverRequirement,
} from '../../shared/authorization'

export class TrustBoundaryError extends Error {}

/* ------------------------------------------------------------------ *
 * 1. Untrusted data
 * ------------------------------------------------------------------ */

/**
 * A value that came from somewhere with no authority: model output, a fetched
 * page, a creator's prompt, an NPC's line of dialogue.
 *
 * There is deliberately no method on this class that returns anything
 * privileged. `read()` hands back the payload for display, logging, or
 * parsing — and a parsed payload is still just data, because the only way to
 * reach an `Authorization` is `mintAuthorization`, which needs an
 * `OwnerConsent` this class cannot produce.
 */
export class Untrusted<T> {
  readonly origin: string
  #value: T

  constructor(origin: string, value: T) {
    this.origin = origin
    this.#value = value
  }

  /** The payload. Safe to show a user, parse, or store. Never an authority. */
  read(): T {
    return this.#value
  }

  /** So an accidental interpolation into a prompt or log says what it is. */
  toString(): string {
    return `[untrusted:${this.origin}]`
  }
}

/** Wrap at the boundary, as close to the source as possible. */
export const untrusted = <T>(origin: string, value: T): Untrusted<T> => new Untrusted(origin, value)

/* ------------------------------------------------------------------ *
 * 2. Owner consent
 * ------------------------------------------------------------------ */

const consents = new WeakSet<object>()

/**
 * Evidence that a specific signed-in owner approved a specific job.
 *
 * Constructed only from a wallet the session layer already verified — the
 * `requireWallet()` discipline in `src/server/index.ts`, where the wallet
 * comes from the bearer session and never from a request body. This class is
 * the reason the policy engine cannot be reached from a request body at all:
 * the body has no way to produce one.
 */
export class OwnerConsent {
  readonly owner: string
  readonly jobId: string
  readonly grantedAtMs: number

  private constructor(owner: string, jobId: string, grantedAtMs: number) {
    this.owner = owner
    this.jobId = jobId
    this.grantedAtMs = grantedAtMs
  }

  /**
   * The single entry point. `sessionOwner` must be the value the auth layer
   * returned for the current request; passing anything read out of a body,
   * a tool result, or a model response defeats the whole file.
   */
  static fromVerifiedSession(input: {
    sessionOwner: string
    jobId: string
    grantedAtMs: number
  }): OwnerConsent {
    if (!input.sessionOwner || typeof input.sessionOwner !== 'string') {
      throw new TrustBoundaryError('owner consent requires a verified session owner')
    }
    if (!input.jobId || typeof input.jobId !== 'string') {
      throw new TrustBoundaryError('owner consent must be bound to a job id')
    }
    if (!Number.isInteger(input.grantedAtMs) || input.grantedAtMs <= 0) {
      throw new TrustBoundaryError('owner consent needs an integer grant timestamp')
    }
    const consent = new OwnerConsent(input.sessionOwner, input.jobId, input.grantedAtMs)
    consents.add(consent)
    return consent
  }
}

const assertConsent = (value: unknown): OwnerConsent => {
  if (!(value instanceof OwnerConsent) || !consents.has(value)) {
    throw new TrustBoundaryError('authorization requires owner consent from a verified session')
  }
  return value
}

/* ------------------------------------------------------------------ *
 * 3. Minting
 * ------------------------------------------------------------------ */

const minted = new WeakSet<object>()

/** Keys that only appear because something tried to grant itself permission. */
const ESCALATION_KEYS = new Set([
  'approved',
  'approval',
  'authorized',
  'authorised',
  'authorization',
  'authorisation',
  'permit',
  'override',
  'overrides',
  'bypass',
  'force',
  'skipPolicy',
  'policy',
  'allow',
  'trusted',
  'admin',
  'root',
  'systemPrompt',
  'instructions',
])

const FIELD_KEYS = new Set<string>([
  'authorizationId',
  'version',
  'owner',
  'serviceId',
  'jobId',
  'sourceAsset',
  'maxPrincipalBaseUnits',
  'maxTotalDebitBaseUnits',
  'costs',
  'destinationNetwork',
  'destinationRecipient',
  'destinationReceiver',
  'refundDestination',
  'minNetOutputBaseUnits',
  'minNetOutputAsset',
  'slippageLimitBps',
  'approvedProviders',
  'allowedActionTypes',
  'approvedRouteDigest',
  'expiresAtMs',
  'nonce',
  'cumulativeBudgetBaseUnits',
  'revoked',
])

/**
 * Walks the whole input looking for escalation-shaped keys.
 *
 * Nested rather than top-level only, because the interesting injection is
 * `{ costs: { serviceFeeBaseUnits: "1", approved: true } }` — a shape that a
 * top-level allowlist would wave straight through.
 */
function rejectEscalationKeys(value: unknown, path: string, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectEscalationKeys(entry, `${path}[${index}]`, depth + 1))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (ESCALATION_KEYS.has(key)) {
      throw new TrustBoundaryError(
        `refusing to mint: input carries an escalation field at ${path}.${key}. ` +
          'A generated "approved" field is not authorization.',
      )
    }
    rejectEscalationKeys(child, `${path}.${key}`, depth + 1)
  }
}

const assetRef = (value: unknown, field: string): AssetRef => {
  if (!value || typeof value !== 'object') throw new TrustBoundaryError(`${field} must be an object`)
  const { network, assetId, decimals, symbol } = value as Record<string, unknown>
  if (typeof network !== 'string' || !network) throw new TrustBoundaryError(`${field}.network required`)
  if (typeof assetId !== 'string' || !assetId) throw new TrustBoundaryError(`${field}.assetId required`)
  if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30) {
    throw new TrustBoundaryError(`${field}.decimals must be an integer in 0..30`)
  }
  if (typeof symbol !== 'string' || !symbol) throw new TrustBoundaryError(`${field}.symbol required`)
  return { network, assetId, decimals: decimals as number, symbol }
}

const requireBigInt = (value: unknown, field: string): bigint => {
  if (typeof value !== 'bigint') throw new TrustBoundaryError(`${field} must be a bigint of base units`)
  if (value < 0n) throw new TrustBoundaryError(`${field} must not be negative`)
  return value
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new TrustBoundaryError(`${field} required`)
  return value
}

const requireIntegerMs = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TrustBoundaryError(`${field} must be a positive integer millisecond timestamp`)
  }
  return value as number
}

/** The input to `mintAuthorization`: the fields, plus the consent that permits it. */
export interface AuthorizationRequest {
  readonly consent: OwnerConsent
  readonly fields: unknown
}

/**
 * The only way to obtain an `Authorization`.
 *
 * Every bound is validated here rather than trusted, including on a round
 * trip out of the database, so a row edited by hand or written by an earlier
 * version of the schema cannot widen a limit. The returned object is frozen
 * and registered; nothing later in the pipeline can raise a ceiling on it.
 */
export function mintAuthorization(request: AuthorizationRequest): Authorization {
  const consent = assertConsent(request.consent)
  const raw = request.fields
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TrustBoundaryError('authorization fields must be an object')
  }

  rejectEscalationKeys(raw, 'fields')

  for (const key of Object.keys(raw)) {
    if (!FIELD_KEYS.has(key)) {
      throw new TrustBoundaryError(`refusing to mint: unknown authorization field "${key}"`)
    }
  }

  const input = raw as Record<string, unknown>

  const owner = requireString(input.owner, 'owner')
  const jobId = requireString(input.jobId, 'jobId')
  // The consent is bound to an owner and a job, so an authorization for a
  // different owner or job is not a validation slip — it is one session
  // trying to spend another's budget.
  if (owner !== consent.owner) {
    throw new TrustBoundaryError('authorization owner does not match the consenting session owner')
  }
  if (jobId !== consent.jobId) {
    throw new TrustBoundaryError('authorization job id does not match the consented job')
  }

  const costsRaw = input.costs
  if (!costsRaw || typeof costsRaw !== 'object') throw new TrustBoundaryError('costs required')
  const costs = costsRaw as Record<string, unknown>

  const refundRaw = input.refundDestination
  if (!refundRaw || typeof refundRaw !== 'object') {
    throw new TrustBoundaryError('refundDestination required')
  }
  const refund = refundRaw as Record<string, unknown>

  const version = input.version
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new TrustBoundaryError('version must be an integer >= 1')
  }

  const slippageLimitBps = input.slippageLimitBps
  if (!Number.isInteger(slippageLimitBps) || (slippageLimitBps as number) < 0 || (slippageLimitBps as number) > 10_000) {
    throw new TrustBoundaryError('slippageLimitBps must be an integer in 0..10000')
  }

  const providers = input.approvedProviders
  if (!Array.isArray(providers) || providers.length === 0 || providers.some(p => typeof p !== 'string' || !p)) {
    throw new TrustBoundaryError('approvedProviders must be a non-empty array of provider ids')
  }

  const actions = input.allowedActionTypes
  if (!Array.isArray(actions) || actions.length === 0 || actions.some(a => !isActionType(a))) {
    throw new TrustBoundaryError(`allowedActionTypes must be a non-empty subset of ${ACTION_TYPES.join(', ')}`)
  }

  const receiver = input.destinationReceiver
  if (receiver !== 'shielded-required' && receiver !== 'transparent-allowed') {
    throw new TrustBoundaryError('destinationReceiver must be shielded-required or transparent-allowed')
  }

  if (typeof input.revoked !== 'boolean') throw new TrustBoundaryError('revoked must be a boolean')

  const maxPrincipal = requireBigInt(input.maxPrincipalBaseUnits, 'maxPrincipalBaseUnits')
  const maxTotalDebit = requireBigInt(input.maxTotalDebitBaseUnits, 'maxTotalDebitBaseUnits')
  const serviceFee = requireBigInt(costs.serviceFeeBaseUnits, 'costs.serviceFeeBaseUnits')
  const conversionCost = requireBigInt(costs.conversionCostBaseUnits, 'costs.conversionCostBaseUnits')
  const networkFees = requireBigInt(costs.networkFeesBaseUnits, 'costs.networkFeesBaseUnits')
  const contingency = requireBigInt(costs.contingencyBaseUnits, 'costs.contingencyBaseUnits')
  const cumulativeBudget = requireBigInt(input.cumulativeBudgetBaseUnits, 'cumulativeBudgetBaseUnits')

  // An envelope that cannot hold its own parts is not a bound, it is a
  // rounding error waiting to be discovered mid-route.
  const envelope = maxPrincipal + serviceFee + conversionCost + networkFees + contingency
  if (maxTotalDebit < envelope) {
    throw new TrustBoundaryError(
      `maxTotalDebitBaseUnits (${maxTotalDebit}) is below principal plus all fees (${envelope})`,
    )
  }
  if (cumulativeBudget < maxTotalDebit) {
    throw new TrustBoundaryError(
      `cumulativeBudgetBaseUnits (${cumulativeBudget}) is below this authorization's own ceiling (${maxTotalDebit})`,
    )
  }

  const fields: AuthorizationFields = {
    authorizationId: requireString(input.authorizationId, 'authorizationId'),
    version: version as number,
    owner,
    serviceId: requireString(input.serviceId, 'serviceId'),
    jobId,
    sourceAsset: assetRef(input.sourceAsset, 'sourceAsset'),
    maxPrincipalBaseUnits: maxPrincipal,
    maxTotalDebitBaseUnits: maxTotalDebit,
    costs: {
      serviceFeeBaseUnits: serviceFee,
      conversionCostBaseUnits: conversionCost,
      networkFeesBaseUnits: networkFees,
      contingencyBaseUnits: contingency,
    },
    destinationNetwork: requireString(input.destinationNetwork, 'destinationNetwork'),
    destinationRecipient: requireString(input.destinationRecipient, 'destinationRecipient'),
    destinationReceiver: receiver as ReceiverRequirement,
    refundDestination: {
      network: requireString(refund.network, 'refundDestination.network'),
      address: requireString(refund.address, 'refundDestination.address'),
    },
    minNetOutputBaseUnits: requireBigInt(input.minNetOutputBaseUnits, 'minNetOutputBaseUnits'),
    minNetOutputAsset: assetRef(input.minNetOutputAsset, 'minNetOutputAsset'),
    slippageLimitBps: slippageLimitBps as number,
    approvedProviders: Object.freeze([...(providers as string[])]),
    allowedActionTypes: Object.freeze([...(actions as ActionType[])]),
    approvedRouteDigest: requireString(input.approvedRouteDigest, 'approvedRouteDigest'),
    expiresAtMs: requireIntegerMs(input.expiresAtMs, 'expiresAtMs'),
    nonce: requireString(input.nonce, 'nonce'),
    cumulativeBudgetBaseUnits: cumulativeBudget,
    revoked: input.revoked,
  }

  const authorization = Object.freeze(fields) as Authorization
  minted.add(authorization)
  return authorization
}

/**
 * Runtime guard used at the top of the policy engine.
 *
 * `Authorization` is only a compile-time brand, and a cast erases it, so the
 * engine checks the registry instead. This is what stops a plain object —
 * including one that round-tripped through `JSON.parse` and therefore came
 * from outside this process — being evaluated as if an owner had approved it.
 */
export function assertMinted(value: unknown): Authorization {
  if (!value || typeof value !== 'object' || !minted.has(value as object)) {
    throw new TrustBoundaryError(
      'not a minted authorization. Authorizations must come from mintAuthorization(); ' +
        'a parsed object, however well-shaped, carries no owner consent.',
    )
  }
  return value as Authorization
}

export const isMintedAuthorization = (value: unknown): value is Authorization =>
  !!value && typeof value === 'object' && minted.has(value as object)

/**
 * Re-mints a persisted authorization.
 *
 * The consent is re-supplied from the current session rather than recovered
 * from the row, so reading a stored authorization back cannot resurrect an
 * approval the owner has since stopped giving.
 */
export function remintFromStorage(consent: OwnerConsent, fields: AuthorizationFields): Authorization {
  return mintAuthorization({ consent, fields })
}
