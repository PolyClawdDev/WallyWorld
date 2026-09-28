/* ------------------------------------------------------------------ *
 * Operator readiness console.
 *
 *   npm run operator:console
 *   npm run operator:console -- --prove-env
 *
 * Runs every provider probe for real and prints one row per integration, each
 * in exactly one of the five states, each with the evidence that produced it.
 *
 * `--prove-env` is the demonstration the brief asks for, and it does two things
 * rather than one:
 *
 *   1. It sets real, non-empty values into `process.env` for every variable any
 *      integration wants, re-runs the whole console, and compares. A populated
 *      environment must not move a single row.
 *   2. It re-derives every row with simulated configuration evidence *and* a
 *      mocked confirmed execution, and shows the state does not move either.
 *
 * The first is the end-to-end version; the second isolates the rule in the
 * derivation. Both are printed because the interesting failure would be a row
 * that the derivation protects but some adapter sets directly.
 * ------------------------------------------------------------------ */

import {
  collectReadiness,
  provePopulatedEnvCannotGoGreen,
  renderReadiness,
} from '../src/server/operator/readiness'
import { READINESS_STATES } from '../src/server/providers/types'
import { X402_FACILITATOR_VARS } from '../src/server/providers/x402'
import { ONECLICK_AUTH_VARS } from '../src/server/providers/oneclick'

/** Every variable any integration in this layer reads. */
const ALL_VARS = [
  ...X402_FACILITATOR_VARS,
  ...ONECLICK_AUTH_VARS,
  'JUPITER_API_KEY',
  'NPC_PAYEE_ADDRESS',
  'ZCASH_LIGHTWALLETD_URL',
]

async function main() {
  const proveEnv = process.argv.includes('--prove-env')

  const before = await collectReadiness()
  console.log(renderReadiness(before))

  if (!proveEnv) {
    console.log('')
    console.log('run with --prove-env to demonstrate that populating configuration cannot turn a row green')
    return
  }

  console.log('')
  console.log('════ demonstration 1: populate every variable and re-run the real probes ════')
  console.log('')

  const saved = new Map<string, string | undefined>()
  for (const name of ALL_VARS) {
    saved.set(name, process.env[name])
    // Plausible non-empty values, so nothing is skipped for being obviously
    // blank. They are not credentials and cannot become any: the point is that
    // presence alone changes nothing.
    process.env[name] = name.endsWith('_URL') ? 'https://example.invalid/configured' : 'set-by-the-env-proof'
  }

  const after = await collectReadiness()

  for (const name of ALL_VARS) {
    const original = saved.get(name)
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }

  // Only an upward move falsifies the claim. A row that drops is the console
  // working: a fabricated key gets a real rejection from the real provider, and
  // the row reports the rejection. Treating that as a failure would pressure the
  // derivation towards ignoring bad credentials, which is the opposite of the
  // property being protected here.
  const rung = (state: string): number => READINESS_STATES.indexOf(state as never)

  let promoted = 0
  let demoted = 0
  for (const row of before.rows) {
    const other = after.rows.find(candidate => candidate.id === row.id)
    const delta = other === undefined ? 0 : rung(other.state) - rung(row.state)
    if (delta > 0) promoted += 1
    if (delta < 0) demoted += 1
    const label = delta > 0 ? 'PROMOTED ' : delta < 0 ? 'demoted  ' : 'unchanged'
    console.log(
      `  ${label}  ${row.id.padEnd(16)} ${row.state}` + (delta === 0 ? '' : `  ->  ${other?.state}`),
    )
  }
  console.log('')
  console.log(`  variables set: ${ALL_VARS.join(', ')}`)
  if (demoted > 0) {
    console.log(
      `  ${demoted} row(s) dropped, as they should: a fabricated credential is sent to the real provider ` +
        'and the provider rejects it. Configuration cannot buy a rung, and a bad value costs one.',
    )
  }
  console.log(
    promoted === 0
      ? '  PASS — every variable was populated and not one row rose. Configuration is not evidence.'
      : `  FAIL — ${promoted} row(s) rose on configuration alone, which is a bug in the derivation.`,
  )

  console.log('')
  console.log('════ demonstration 2: add config evidence and a mocked confirmed execution ════')
  console.log('')

  const proofs = provePopulatedEnvCannotGoGreen(before.rows)
  for (const proof of proofs) {
    console.log(
      `  ${proof.unchanged ? 'unchanged' : 'MOVED   '}  ${proof.id.padEnd(16)} ` +
        `${proof.stateWithoutConfig}  ->  ${proof.stateWithEveryVariableSet}`,
    )
  }
  console.log('')
  const allUnchanged = proofs.every(proof => proof.unchanged)
  console.log(
    allUnchanged
      ? '  PASS — a mocked confirmed execution plus full configuration still scores zero rungs.'
      : '  FAIL — a mocked result or a config value raised a row.',
  )

  if (promoted !== 0 || !allUnchanged) process.exit(1)
}

main().catch(error => {
  console.error(`FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
