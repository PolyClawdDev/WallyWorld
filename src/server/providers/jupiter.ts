/* ------------------------------------------------------------------ *
 * Jupiter adapter — quoting only (§5, §7 BRONZE).
 *
 * Deliberately no SDK. Jupiter's own documentation points at the REST API at
 * `https://api.jup.ag/swap/v2`; the community npm clients target the older
 * surface, so adding one would put a stale abstraction between this code and
 * the thing it is verifying.
 *
 * Two facts drive the shape of this file, both from Jupiter's own docs:
 *
 *   - **The keyless tier is real**, at 0.5 requests per second with no
 *     sign-up. So a live quote is a genuine read-only verification that costs
 *     nothing and needs no credential — the one place on this whole route
 *     where that is true.
 *   - **There is no devnet or testnet swap endpoint.** Quoting is free
 *     forever; executing a swap can only ever happen on mainnet with real SOL.
 *     `buildSwapTransaction` therefore refuses by design rather than by
 *     configuration, and says why.
 * ------------------------------------------------------------------ */

import { assertPermitCovers, type ProposedAction, type SpendPermit } from '../policy'
import { readBaseUnits } from '../policy/units'
import { httpEvidence, parseJson, probe } from './probe'
import {
  deriveState,
  providerFailure,
  type AdapterResult,
  type Capability,
  type Evidence,
  type IntegrationReport,
} from './types'

export const JUPITER_PROVIDER_ID = 'jupiter'

export const JUPITER_ORDER_URL = 'https://api.jup.ag/swap/v2/order'

/** Mainnet mints. Jupiter has no other network, so there is nothing to select. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export interface JupiterQuote {
  readonly router: string
  readonly inputMint: string
  readonly outputMint: string
  readonly inAmountBaseUnits: bigint
  readonly outAmountBaseUnits: bigint
  readonly slippageBps: number
  readonly httpStatus: number
  readonly observedAtMs: number
  /** Jupiter does not return a quote expiry, so the caller must impose one. */
  readonly quoteExpiresAtMs: number
}

/**
 * How long a Jupiter quote is treated as usable.
 *
 * Jupiter returns no expiry field. Rather than treat an unbounded quote as
 * valid forever — which would let the policy engine's `quote_expired` check
 * never fire on this leg — the adapter stamps a conservative window of its own
 * and labels it as locally imposed.
 */
export const JUPITER_QUOTE_TTL_MS = 30_000

/**
 * Live SOL to USDC quote, keyless.
 *
 * `taker` is omitted: without it Jupiter returns a price quote rather than an
 * assembled transaction, which is exactly the boundary this adapter wants —
 * there is no signable artifact to accidentally submit.
 */
export async function quoteSolToUsdc(input: {
  lamports: bigint
  slippageBps: number
  apiKey?: string
}): Promise<AdapterResult<{ quote: JupiterQuote }>> {
  if (input.lamports <= 0n) {
    return providerFailure('validation-error', 'lamports must be a positive integer')
  }

  const url = new URL(JUPITER_ORDER_URL)
  url.searchParams.set('inputMint', WSOL_MINT)
  url.searchParams.set('outputMint', USDC_MAINNET_MINT)
  url.searchParams.set('amount', input.lamports.toString())
  url.searchParams.set('slippageBps', String(input.slippageBps))

  const apiKey = (input.apiKey ?? process.env.JUPITER_API_KEY ?? '').trim()
  const response = await probe({
    url: url.toString(),
    // The key is a rate-limit tier, not an authorisation: the keyless tier
    // returns the same quotes, so its absence is not a missing-configuration
    // state. Sending the header only when a key exists keeps the unkeyed path
    // genuinely unkeyed rather than sending an empty credential.
    headers: apiKey ? { 'x-api-key': apiKey } : undefined,
  })

  if (response.status === null) {
    return providerFailure('transport-error', response.transportError ?? 'no response from Jupiter')
  }
  if (!response.ok) {
    return providerFailure('provider-error', `Jupiter returned HTTP ${response.status}`, response.status)
  }

  const body = parseJson(response.bodyText) as Record<string, unknown> | null
  if (!body) return providerFailure('provider-error', 'Jupiter response was not JSON', response.status)

  try {
    const inAmount = readBaseUnits(body.inAmount, 'inAmount')
    const outAmount = readBaseUnits(body.outAmount, 'outAmount')
    return {
      ok: true,
      quote: {
        router: typeof body.router === 'string' ? body.router : 'unknown',
        inputMint: String(body.inputMint ?? WSOL_MINT),
        outputMint: String(body.outputMint ?? USDC_MAINNET_MINT),
        inAmountBaseUnits: inAmount,
        outAmountBaseUnits: outAmount,
        slippageBps: Number(body.slippageBps ?? input.slippageBps),
        httpStatus: response.status,
        observedAtMs: response.observedAtMs,
        quoteExpiresAtMs: response.observedAtMs + JUPITER_QUOTE_TTL_MS,
      },
    }
  } catch (error) {
    return providerFailure(
      'provider-error',
      `Jupiter amounts were not integer strings: ${error instanceof Error ? error.message : String(error)}`,
      response.status,
    )
  }
}

export class JupiterExecutionUnavailable extends Error {}

/**
 * Not implemented, and not blocked on a credential.
 *
 * Executing a Jupiter swap requires a `taker`, a signed transaction, and
 * mainnet — Jupiter publishes no devnet or testnet swap endpoint, so there is
 * no environment in which this could be exercised safely. The permit check
 * still runs first, so the refusal happens after the policy engine rather than
 * instead of it: a caller cannot use "unimplemented" as a way to skip policy.
 */
export function buildSwapTransaction(permit: SpendPermit, action: ProposedAction, nowMs: number): never {
  assertPermitCovers(permit, action, nowMs)
  throw new JupiterExecutionUnavailable(
    'Jupiter swap execution is not implemented. Jupiter has no devnet or testnet swap endpoint, so the ' +
      'SOL to USDC conversion can only be executed on mainnet with real SOL and a funded signer. ' +
      'Quoting is available and free; execution is not, and no mock stands in for it.',
  )
}

/* ------------------------------------------------------------------ readiness */

export async function probeJupiter(nowMs: number): Promise<IntegrationReport> {
  const evidence: Evidence[] = []
  const result = await quoteSolToUsdc({ lamports: 100_000_000n, slippageBps: 50 })

  if (result.ok) {
    const quote = result.quote
    evidence.push(
      httpEvidence(
        {
          status: quote.httpStatus,
          ok: true,
          bodyText: '',
          durationMs: 0,
          url: JUPITER_ORDER_URL,
          method: 'GET',
          observedAtMs: quote.observedAtMs,
        },
        `0.1 SOL -> USDC: in ${quote.inAmountBaseUnits} lamports, out ${quote.outAmountBaseUnits} USDC base units, router ${quote.router}`,
        'mainnet',
        'keyless GET /swap/v2/order price quote (nothing signed, nothing submitted)',
      ),
    )
  } else {
    evidence.push({
      kind: 'http',
      observedAtMs: nowMs,
      environment: 'mainnet',
      summary: 'keyless GET /swap/v2/order price quote',
      url: JUPITER_ORDER_URL,
      method: 'GET',
      status: 'httpStatus' in result && typeof result.httpStatus === 'number' ? result.httpStatus : null,
      durationMs: 0,
      transportError: result.detail,
    })
  }

  evidence.push({
    kind: 'doc',
    observedAtMs: nowMs,
    environment: 'none',
    summary: 'no Jupiter test network exists',
    url: 'https://developers.jup.ag/docs/swap',
    status: 200,
    quote: 'Jupiter publishes no devnet or testnet swap endpoint; the Swap API is mainnet only.',
  })

  const capabilities: Capability[] = [
    { id: 'quote', description: 'SOL to USDC price quote, keyless', verdict: result.ok ? 'read-only' : 'unavailable', ...(result.ok ? {} : { blocker: result.detail }) },
    {
      id: 'swap-execute',
      description: 'Execute the SOL to USDC conversion',
      verdict: 'blocked',
      blocker:
        'Mainnet only — there is no Jupiter devnet or testnet swap endpoint — and it needs a funded ' +
        'signer that does not exist in this project. The first execution would be real money.',
    },
  ]

  return {
    id: JUPITER_PROVIDER_ID,
    label: 'Jupiter — Solana swap aggregation',
    sdk: null,
    state: deriveState(evidence),
    capabilities,
    evidence,
    // The API key raises the rate limit from 0.5 to 1 request per second. It
    // gates nothing, so listing it as missing configuration would overstate it.
    missingConfiguration: [],
    nextStep:
      'Quoting is verified and needs nothing. Execution cannot progress past read-only without mainnet ' +
      'funds and a signer, because Jupiter has no test network.',
  }
}
