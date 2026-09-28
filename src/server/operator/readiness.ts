/* ------------------------------------------------------------------ *
 * Operator readiness console (§9, §12).
 *
 * One row per integration, each in exactly one of five states, each backed by
 * the evidence that produced it. The console's value is entirely in what it
 * refuses to say, so the refusals are concentrated here:
 *
 *   - Rows are **assembled from adapter probes**, and the state is computed by
 *     `deriveState` in `providers/types.ts` from the evidence those probes
 *     returned. No row carries a hand-written status.
 *   - `auditStateClaims` re-derives every row's state from its own evidence and
 *     reports a mismatch. An adapter that started asserting its own state would
 *     be caught by the console rather than believed by it.
 *   - `provePopulatedEnvCannotGoGreen` exists to be run: it takes a real report,
 *     adds configuration evidence for every variable the integration wants, and
 *     shows the derived state does not move. That is the brief's demonstration,
 *     as an executable rather than a claim.
 *
 * Nothing in this module reads a secret value. It reads variable *names* and
 * whether they are non-empty, which is all an operator needs and all that is
 * safe to print.
 * ------------------------------------------------------------------ */

import {
  READINESS_STATES,
  deriveState,
  envPresent,
  probeJupiter,
  probeOneClick,
  probeX402,
  probeZcashAddress,
  probeZcashWallet,
  type Evidence,
  type IntegrationReport,
  type ReadinessState,
} from '../providers'

export interface ReadinessSnapshot {
  readonly generatedAtMs: number
  readonly rows: readonly IntegrationReport[]
  /** Rows whose declared state does not match their own evidence. Should be empty. */
  readonly inconsistencies: readonly { id: string; declared: ReadinessState; derived: ReadinessState }[]
  readonly counts: Readonly<Record<ReadinessState, number>>
  /** True only if some row genuinely reached the top rung. Expected false. */
  readonly anyLiveVerified: boolean
}

/**
 * Runs every probe and assembles the console.
 *
 * Probes run in parallel and each one is individually guarded: a provider being
 * down must produce one honest row, not an empty console. A probe that throws
 * becomes a bottom-rung row naming the throw, because "we could not tell" is a
 * state an operator can act on and a blank space is not.
 */
export async function collectReadiness(nowMs = Date.now()): Promise<ReadinessSnapshot> {
  const probes: Array<{ id: string; label: string; run: () => Promise<IntegrationReport> | IntegrationReport }> = [
    { id: 'x402', label: 'x402 — HTTP-native payment', run: () => probeX402(nowMs) },
    { id: 'jupiter', label: 'Jupiter — Solana swap aggregation', run: () => probeJupiter(nowMs) },
    { id: 'near-1click', label: 'NEAR Intents 1Click — cross-chain conversion', run: () => probeOneClick(nowMs) },
    { id: 'zcash-address', label: 'Zcash addresses — ZIP-316 parsing', run: () => probeZcashAddress(nowMs) },
    { id: 'zcash-wallet', label: 'Zcash wallet — shielding and shielded spend', run: () => probeZcashWallet(nowMs) },
  ]

  const rows = await Promise.all(
    probes.map(async ({ id, label, run }) => {
      try {
        return await run()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const report: IntegrationReport = {
          id,
          label,
          sdk: null,
          state: 'missing-configuration',
          capabilities: [{ id: 'probe', description: 'probe this integration', verdict: 'unavailable', blocker: detail }],
          evidence: [
            {
              kind: 'http',
              observedAtMs: nowMs,
              environment: 'none',
              summary: 'the probe itself failed',
              url: '(probe)',
              method: 'INTERNAL',
              status: null,
              durationMs: 0,
              transportError: detail,
            },
          ],
          missingConfiguration: [],
          nextStep: `The probe threw: ${detail}. Fix the probe before trusting any other row.`,
        }
        return report
      }
    }),
  )

  const inconsistencies = auditStateClaims(rows)

  const counts = Object.fromEntries(READINESS_STATES.map(state => [state, 0])) as Record<ReadinessState, number>
  for (const row of rows) counts[row.state] += 1

  return {
    generatedAtMs: nowMs,
    rows,
    inconsistencies,
    counts,
    anyLiveVerified: rows.some(row => row.state === 'live-execution-verified'),
  }
}

/**
 * Re-derives each row's state from its own evidence.
 *
 * The console does not trust the adapters it calls. If an adapter ever set a
 * state directly instead of deriving it, this is what surfaces the discrepancy —
 * and an inconsistent console is a louder failure than an over-optimistic row.
 */
export function auditStateClaims(
  rows: readonly IntegrationReport[],
): { id: string; declared: ReadinessState; derived: ReadinessState }[] {
  const problems: { id: string; declared: ReadinessState; derived: ReadinessState }[] = []
  for (const row of rows) {
    const derived = deriveState(row.evidence)
    if (derived !== row.state) problems.push({ id: row.id, declared: row.state, derived })
  }
  return problems
}

/* ------------------------------------------------------------------ *
 * The demonstration
 * ------------------------------------------------------------------ */

export interface EnvGreenProof {
  readonly id: string
  readonly stateWithoutConfig: ReadinessState
  readonly stateWithEveryVariableSet: ReadinessState
  readonly variablesSimulated: readonly string[]
  readonly unchanged: boolean
}

/**
 * Shows that populating configuration cannot move a row.
 *
 * Config evidence is added for every variable the integration asks for — as
 * though an operator had filled in the entire `.env` — and the state is
 * re-derived. `unchanged` must be true for every row. It is true because
 * `rungFor` scores `kind: 'config'` at zero no matter how much of it there is,
 * which is the one guarantee this console rests on.
 */
export function provePopulatedEnvCannotGoGreen(rows: readonly IntegrationReport[], nowMs = Date.now()): EnvGreenProof[] {
  return rows.map(row => {
    const variables = row.missingConfiguration.length
      ? row.missingConfiguration
      : ['EVERY_VARIABLE_THIS_INTEGRATION_COULD_WANT']
    const pretendConfigured: Evidence = {
      kind: 'config',
      observedAtMs: nowMs,
      environment: 'none',
      summary: 'simulated: every variable this integration wants is set to a non-empty value',
      variables,
      present: true,
    }
    // A mocked execution as well, since "I stubbed the provider" is the other
    // way a row would go green if the derivation let it.
    const pretendMocked: Evidence = {
      kind: 'execution',
      observedAtMs: nowMs,
      environment: 'mock',
      summary: 'simulated: a mocked settlement returned success',
      identifier: 'mock-transaction-identifier',
      confirmed: true,
      detail: 'produced by a stub, not by a chain',
    }
    const withConfig = deriveState([...row.evidence, pretendConfigured, pretendMocked])
    return {
      id: row.id,
      stateWithoutConfig: row.state,
      stateWithEveryVariableSet: withConfig,
      variablesSimulated: variables,
      unchanged: withConfig === row.state,
    }
  })
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const LABELS: Record<ReadinessState, string> = {
  'missing-configuration': 'MISSING CONFIGURATION',
  reachable: 'REACHABLE',
  'read-only-verified': 'READ-ONLY VERIFIED',
  'test-execution-verified': 'TEST EXECUTION VERIFIED',
  'live-execution-verified': 'LIVE EXECUTION VERIFIED',
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Plain text, wide enough to read in a terminal and safe to paste into a report. */
export function renderReadiness(snapshot: ReadinessSnapshot): string {
  const out: string[] = []
  out.push('Voxels · operator readiness console')
  out.push(`  generated   ${iso(snapshot.generatedAtMs)}`)
  out.push(`  states      ${READINESS_STATES.map(state => `${state}=${snapshot.counts[state]}`).join('  ')}`)
  out.push('')

  for (const row of snapshot.rows) {
    out.push(`── ${row.label}`)
    out.push(`   state      ${LABELS[row.state]}`)
    if (row.sdk) out.push(`   sdk        ${row.sdk.name}@${row.sdk.version}`)
    else out.push('   sdk        none installed')

    out.push('   evidence')
    for (const item of row.evidence) out.push(`     · ${describeEvidence(item)}`)

    out.push('   capabilities')
    for (const capability of row.capabilities) {
      out.push(`     ${capability.verdict.toUpperCase().padEnd(12)} ${capability.description}`)
      if (capability.blocker) out.push(`${' '.repeat(18)}blocker: ${wrap(capability.blocker, 18)}`)
    }

    if (row.missingConfiguration.length) {
      out.push(`   missing    ${row.missingConfiguration.join(', ')}`)
    }
    out.push(`   next       ${wrap(row.nextStep, 14)}`)
    out.push('')
  }

  if (snapshot.inconsistencies.length) {
    out.push('!! CONSOLE INCONSISTENT — an adapter reported a state its own evidence does not support:')
    for (const problem of snapshot.inconsistencies) {
      out.push(`   ${problem.id}: declared ${problem.declared}, evidence supports ${problem.derived}`)
    }
  } else {
    out.push('every row\'s state was re-derived from its own evidence and matched')
  }

  out.push(
    snapshot.anyLiveVerified
      ? '!! a row claims LIVE EXECUTION VERIFIED — check it is backed by a confirmed mainnet transaction'
      : 'no row reaches LIVE EXECUTION VERIFIED, which is correct: nothing here has executed on mainnet',
  )
  return out.join('\n')
}

function describeEvidence(evidence: Evidence): string {
  const when = iso(evidence.observedAtMs)
  switch (evidence.kind) {
    case 'config':
      return `${when}  config    ${evidence.variables.join(', ')} ${evidence.present ? 'set' : 'unset'} — worth zero rungs`
    case 'sdk':
      return `${when}  sdk       ${evidence.packageName}@${evidence.version} — ${evidence.summary}`
    case 'doc':
      return `${when}  doc       ${evidence.url}${evidence.status === null ? '' : ` HTTP ${evidence.status}`} — "${evidence.quote}"`
    case 'http':
      return (
        `${when}  http      ${evidence.method} ${evidence.url} → ` +
        `${evidence.status === null ? `no response (${evidence.transportError ?? 'unknown'})` : `HTTP ${evidence.status}`}` +
        ` [${evidence.environment}] ${evidence.durationMs}ms` +
        (evidence.extracted ? `\n${' '.repeat(7)}read: ${evidence.extracted}` : '')
      )
    case 'execution':
      return (
        `${when}  execution ${evidence.identifier} [${evidence.environment}] ` +
        `${evidence.confirmed ? 'confirmed' : 'UNCONFIRMED'} — ${evidence.detail}`
      )
  }
}

/** Soft-wraps a long blocker so a terminal does not swallow the reason. */
function wrap(text: string, indent: number, width = 100): string {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.join(`\n${' '.repeat(indent)}`)
}

/**
 * JSON view, for an owner-only HTTP route.
 *
 * Variable names are included; values never are. `bigint` does not appear in
 * any report field, so this serialises without a replacer.
 */
export function readinessJson(snapshot: ReadinessSnapshot) {
  return {
    generatedAtMs: snapshot.generatedAtMs,
    states: READINESS_STATES,
    counts: snapshot.counts,
    anyLiveVerified: snapshot.anyLiveVerified,
    inconsistencies: snapshot.inconsistencies,
    rows: snapshot.rows.map(row => ({
      id: row.id,
      label: row.label,
      state: row.state,
      sdk: row.sdk,
      capabilities: row.capabilities,
      evidence: row.evidence,
      missingConfiguration: row.missingConfiguration,
      nextStep: row.nextStep,
    })),
    note:
      'A state is derived from evidence, never asserted. Configuration evidence and any evidence stamped ' +
      '"mock" are scored at zero rungs, so neither a populated environment variable nor a stubbed result ' +
      'can produce a live status.',
  }
}

/** Reports which of a list of variables are set, by name only. */
export const configurationPresence = (names: readonly string[]) =>
  names.map(name => ({ name, present: envPresent(name) }))
