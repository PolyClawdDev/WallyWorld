/* ------------------------------------------------------------------ *
 * Readiness states and the evidence that produces them (§9, §12).
 *
 * This file is the anti-self-deception instrument. Its whole job is to make
 * an optimistic status impossible to reach by accident:
 *
 *   - A state is never assigned. It is **derived** from evidence, by
 *     `deriveState` below, and the derivation refuses to climb a rung it has
 *     no evidence for.
 *   - Evidence carries the environment it came from. Evidence stamped `mock`
 *     raises nothing, ever. A mocked result satisfying a failure test is
 *     useful; a mocked result turning a row green is a lie.
 *   - A populated environment variable is not evidence of anything except
 *     that somebody typed a value. `configured: true` on its own leaves the
 *     row at the bottom rung, which is the behaviour the brief asks to see
 *     demonstrated rather than asserted.
 *   - The top rung additionally requires a confirmed mainnet transaction
 *     identifier. There is no code path that produces one in this repository,
 *     which is why every row is expected to sit below it.
 * ------------------------------------------------------------------ */

/** The five states, lowest rung first. Exactly one applies to an integration. */
export const READINESS_STATES = [
  /** Nothing has been demonstrated. Configuration may be absent, or merely present. */
  'missing-configuration',
  /** The endpoint answered. Says nothing about whether the answer was useful. */
  'reachable',
  /** A real read returned the specific fact we needed, and we recorded it. */
  'read-only-verified',
  /** An operation actually executed on a test network. */
  'test-execution-verified',
  /** An operation actually executed and confirmed on mainnet. */
  'live-execution-verified',
] as const

export type ReadinessState = (typeof READINESS_STATES)[number]

const RUNG: Record<ReadinessState, number> = {
  'missing-configuration': 0,
  reachable: 1,
  'read-only-verified': 2,
  'test-execution-verified': 3,
  'live-execution-verified': 4,
}

/**
 * Where an observation came from.
 *
 * `mock` exists so that a stubbed result can be recorded honestly rather than
 * disguised, and `deriveState` treats it as worth zero rungs.
 */
export type ProbeEnvironment = 'none' | 'mock' | 'devnet' | 'testnet' | 'mainnet'

interface EvidenceBase {
  /** Wall-clock time of the observation. Displayed so a stale row is visible. */
  readonly observedAtMs: number
  readonly summary: string
  readonly environment: ProbeEnvironment
}

/** Somebody set a variable. Deliberately the weakest thing in the union. */
export interface ConfigEvidence extends EvidenceBase {
  readonly kind: 'config'
  readonly variables: readonly string[]
  readonly present: boolean
}

/** A package resolved at a specific version. Real, but not a capability. */
export interface SdkEvidence extends EvidenceBase {
  readonly kind: 'sdk'
  readonly packageName: string
  readonly version: string
}

/** A live HTTP exchange. `status` is the number the server actually returned. */
export interface HttpEvidence extends EvidenceBase {
  readonly kind: 'http'
  readonly url: string
  readonly method: string
  /** `null` only when the request never produced a response at all. */
  readonly status: number | null
  readonly durationMs: number
  /** The specific fact the response established, quoted or extracted. */
  readonly extracted?: string
  readonly transportError?: string
}

/** A sourced statement from a provider's own documentation. */
export interface DocEvidence extends EvidenceBase {
  readonly kind: 'doc'
  readonly url: string
  readonly status: number | null
  readonly quote: string
}

/** A transaction or provider operation that actually happened. */
export interface ExecutionEvidence extends EvidenceBase {
  readonly kind: 'execution'
  /** Transaction signature, txid, or provider operation id. Never invented. */
  readonly identifier: string
  readonly confirmed: boolean
  readonly detail: string
}

export type Evidence = ConfigEvidence | SdkEvidence | HttpEvidence | DocEvidence | ExecutionEvidence

/**
 * The rung a single piece of evidence can support on its own.
 *
 * Every gate here is a refusal rather than a permission, which is why the
 * function reads as a list of ways to score zero.
 */
function rungFor(evidence: Evidence): number {
  // A stub proves the code path runs. It proves nothing about a provider, so
  // it is recorded and then scored at the floor.
  if (evidence.environment === 'mock') return 0

  switch (evidence.kind) {
    case 'config':
      // The entire point. Setting a variable moves nothing.
      return 0
    case 'sdk':
      // An installed package is not a reachable service.
      return 0
    case 'doc':
      // Documentation tells you what a provider claims, not what it did.
      return 0
    case 'http': {
      if (evidence.status === null) return 0
      if (evidence.status < 100 || evidence.status > 599) return 0
      // Any real response proves reachability, including a 4xx: the host
      // exists and spoke HTTP.
      if (evidence.status < 200 || evidence.status >= 300) return RUNG.reachable
      // A 2xx only counts as a verified read when the probe says what it
      // actually extracted. "200 OK" from an unread body is reachability.
      return evidence.extracted ? RUNG['read-only-verified'] : RUNG.reachable
    }
    case 'execution': {
      if (!evidence.identifier || !evidence.confirmed) return RUNG.reachable
      if (evidence.environment === 'devnet' || evidence.environment === 'testnet') {
        return RUNG['test-execution-verified']
      }
      if (evidence.environment === 'mainnet') return RUNG['live-execution-verified']
      return 0
    }
  }
}

/** The state is the best rung any single piece of evidence genuinely supports. */
export function deriveState(evidence: readonly Evidence[]): ReadinessState {
  let best = 0
  for (const item of evidence) best = Math.max(best, rungFor(item))
  return READINESS_STATES[best]
}

/** True when a state is safe to present to an operator as "this works live". */
export const isLiveVerified = (state: ReadinessState): boolean => state === 'live-execution-verified'

/**
 * One capability of one integration, with the honest verdict attached.
 *
 * `blocker` is required whenever the capability is not usable, and the
 * console prints it verbatim. A capability that is unavailable without a
 * stated reason is not reportable.
 */
export interface Capability {
  readonly id: string
  readonly description: string
  readonly verdict: 'available' | 'read-only' | 'unavailable' | 'blocked'
  readonly blocker?: string
}

/** What every adapter returns when asked to report on itself. */
export interface IntegrationReport {
  readonly id: string
  readonly label: string
  /** Package name and exact installed version, or null when there is no SDK. */
  readonly sdk: { readonly name: string; readonly version: string } | null
  readonly state: ReadinessState
  readonly capabilities: readonly Capability[]
  readonly evidence: readonly Evidence[]
  /** Configuration this integration needs and does not have. */
  readonly missingConfiguration: readonly string[]
  /** One line an operator can act on. */
  readonly nextStep: string
}

/* ------------------------------------------------------------------ *
 * Missing configuration, as a value rather than a thrown error.
 *
 * An adapter with no credential must return this instead of a fake success
 * and instead of throwing: the operator console needs to render the precise
 * gap, and an exception loses which variable was missing by the time it has
 * been caught and logged.
 * ------------------------------------------------------------------ */

export interface MissingConfiguration {
  readonly ok: false
  readonly reason: 'missing-configuration'
  /** Environment variable names. Never values. */
  readonly variables: readonly string[]
  readonly detail: string
}

export const missingConfiguration = (variables: readonly string[], detail: string): MissingConfiguration => ({
  ok: false,
  reason: 'missing-configuration',
  variables,
  detail,
})

/** A real failure that is not a configuration gap. */
export interface ProviderFailure {
  readonly ok: false
  readonly reason: 'provider-error' | 'validation-error' | 'unsupported' | 'transport-error'
  readonly detail: string
  readonly httpStatus?: number
}

export const providerFailure = (
  reason: ProviderFailure['reason'],
  detail: string,
  httpStatus?: number,
): ProviderFailure => (httpStatus === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, httpStatus })

export type AdapterResult<T> = ({ readonly ok: true } & T) | MissingConfiguration | ProviderFailure

/** Reads a variable without ever returning or logging it beyond presence. */
export const envPresent = (name: string): boolean => (process.env[name] ?? '').trim().length > 0

export const missingVariables = (names: readonly string[]): string[] => names.filter(name => !envPresent(name))
