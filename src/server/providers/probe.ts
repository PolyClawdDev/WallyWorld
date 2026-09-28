/* ------------------------------------------------------------------ *
 * The one place a provider request is made.
 *
 * Every read-only probe goes through here so that the evidence an operator
 * sees is produced by the same code that made the call, rather than written
 * separately and hoped to match. Three properties matter:
 *
 *   - **A non-2xx is not an exception.** The status code is the evidence, and
 *     a 400 from a validator is often exactly the fact being established.
 *     Throwing would discard it.
 *   - **A transport failure is distinguishable from a rejection.** "DNS did
 *     not resolve" and "the API said no" must never collapse into one state.
 *   - **Nothing here reads a credential.** Callers pass headers explicitly, so
 *     no probe can quietly start using a key the operator did not intend.
 * ------------------------------------------------------------------ */

import type { HttpEvidence, ProbeEnvironment } from './types'

export interface ProbeResponse {
  /** `null` when no HTTP response was produced at all. */
  readonly status: number | null
  readonly ok: boolean
  readonly bodyText: string
  readonly durationMs: number
  readonly url: string
  readonly method: string
  readonly observedAtMs: number
  readonly transportError?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Enough for a token list; small enough that a runaway response cannot fill memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export async function probe(input: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<ProbeResponse> {
  const method = input.method ?? 'GET'
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(input.url, {
      method,
      headers: input.headers,
      body: input.body,
      signal: controller.signal,
    })
    const raw = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      bodyText: raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw,
      durationMs: Date.now() - started,
      url: input.url,
      method,
      observedAtMs: started,
    }
  } catch (error) {
    // No response was produced. `status: null` is what keeps this out of the
    // `reachable` rung in types.ts, rather than a zero that sorts like one.
    return {
      status: null,
      ok: false,
      bodyText: '',
      durationMs: Date.now() - started,
      url: input.url,
      method,
      observedAtMs: started,
      transportError: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turns a probe into evidence.
 *
 * `extracted` is what lifts a 2xx from "reachable" to "read-only verified", so
 * it is a required argument rather than an optional one: a caller that has not
 * read the body has to say so by passing `null`.
 */
export function httpEvidence(
  response: ProbeResponse,
  extracted: string | null,
  environment: ProbeEnvironment,
  summary: string,
): HttpEvidence {
  const base = {
    kind: 'http' as const,
    observedAtMs: response.observedAtMs,
    summary,
    environment,
    url: response.url,
    method: response.method,
    status: response.status,
    durationMs: response.durationMs,
  }
  if (extracted !== null && response.transportError !== undefined) {
    return { ...base, extracted, transportError: response.transportError }
  }
  if (extracted !== null) return { ...base, extracted }
  if (response.transportError !== undefined) return { ...base, transportError: response.transportError }
  return base
}

/** Parses JSON without letting a malformed body become an unhandled throw. */
export function parseJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown
  } catch {
    return null
  }
}
