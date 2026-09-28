/* ------------------------------------------------------------------ *
 * Route preflight, exercised.
 *
 *   npm run verify:preflight
 *
 * Four scenarios, each chosen to fail at a different stage, because a preflight
 * that always fails at the same place proves nothing about whether it names the
 * right one. The scenarios move the failure earlier and earlier: the point is
 * that the route stops before `conversion-deposit`, which is the stage after
 * which funds are no longer recoverable.
 * ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef, AuthorizationFields } from '../src/shared/authorization'
import { OwnerConsent, mintAuthorization } from '../src/server/policy'
import {
  FUNDS_AT_RISK_FROM,
  preflightRoute,
  renderPreflight,
  type RouteStage,
} from '../src/server/providers/preflight'

const NOW = Date.now()

const SOL: AssetRef = {
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  assetId: 'native',
  decimals: 9,
  symbol: 'SOL',
}
const ZEC: AssetRef = { network: 'zcash:main', assetId: 'native', decimals: 8, symbol: 'ZEC' }

/* ------------------------------------------------------------------ *
 * Addresses come from the cached official ZIP-316 vectors rather than being
 * written out here. A hand-copied unified address is one transcription slip
 * away from failing the parse stage for the wrong reason, which would make this
 * script report a correct preflight as broken. Run `npm run verify:zip316`
 * first; it writes the cache.
 * ------------------------------------------------------------------ */

const vectorPath = join(dirname(fileURLToPath(import.meta.url)), '.fixtures', 'zip316-unified-address-vectors.json')

type Row = [string | null, string | null, string | null, string | null, number | null, string | null, string, ...unknown[]]

const rows = (JSON.parse(readFileSync(vectorPath, 'utf8')) as unknown[]).slice(2) as Row[]

const pick = (want: (row: Row) => boolean, label: string): string => {
  const row = rows.find(want)
  if (!row) throw new Error(`no ZIP-316 vector available for: ${label}`)
  return row[6]
}

/** Sapling and/or Orchard, and no transparent receiver at all. */
const SHIELDED_ONLY_UA = pick(
  row => Boolean(row[2] ?? row[3]) && !row[0] && !row[1],
  'a shielded-only unified address',
)

/** Carries both a transparent and a shielded receiver. */
const TRANSPARENT_AND_SAPLING = pick(
  row => Boolean(row[0]) && Boolean(row[2] ?? row[3]),
  'a unified address with both transparent and shielded receivers',
)

const REFUND_SOL = '8oYg8sfWzwpwaLypnaFny6QZfvHedc2pCUxF2aipa8Jg'

function authorization(overrides: Partial<AuthorizationFields>) {
  const consent = OwnerConsent.fromVerifiedSession({
    sessionOwner: 'operatorTestOwner',
    jobId: 'preflight-job',
    grantedAtMs: NOW - 1000,
  })
  const fields: AuthorizationFields = {
    authorizationId: 'auth_preflight',
    version: 1,
    owner: 'operatorTestOwner',
    serviceId: 'courier.sol-to-shielded-zec',
    jobId: 'preflight-job',
    sourceAsset: SOL,
    maxPrincipalBaseUnits: 100_000_000n,
    maxTotalDebitBaseUnits: 112_000_000n,
    costs: {
      serviceFeeBaseUnits: 5_000_000n,
      conversionCostBaseUnits: 4_000_000n,
      networkFeesBaseUnits: 2_000_000n,
      contingencyBaseUnits: 1_000_000n,
    },
    destinationNetwork: 'zcash:main',
    destinationRecipient: SHIELDED_ONLY_UA,
    destinationReceiver: 'shielded-required',
    refundDestination: { network: SOL.network, address: REFUND_SOL },
    minNetOutputBaseUnits: 700_000n,
    minNetOutputAsset: ZEC,
    slippageLimitBps: 100,
    approvedProviders: ['near-1click'],
    allowedActionTypes: ['conversion.deposit', 'zcash.send'],
    approvedRouteDigest: 'route-digest-approved',
    expiresAtMs: NOW + 600_000,
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    cumulativeBudgetBaseUnits: 500_000_000n,
    revoked: false,
    ...overrides,
  }
  return mintAuthorization({ consent, fields })
}

interface Scenario {
  readonly name: string
  readonly expectedStage: RouteStage
  readonly build: () => Promise<Awaited<ReturnType<typeof preflightRoute>>>
}

const scenarios: Scenario[] = [
  {
    name: 'a revoked authorization stops at stage 1, before anything is contacted',
    expectedStage: 'authorization',
    build: () =>
      preflightRoute({ authorization: authorization({ revoked: true }), nowMs: NOW, principalLamports: 100_000_000n }),
  },
  {
    name: 'a principal above the approved maximum stops at stage 1',
    expectedStage: 'authorization',
    build: () =>
      preflightRoute({ authorization: authorization({}), nowMs: NOW, principalLamports: 900_000_000n }),
  },
  {
    name: 'shielded delivery with a transparent-only-capable recipient stops at the address stage',
    expectedStage: 'destination-address',
    build: () =>
      preflightRoute({
        // A t-address cannot carry a shielded receiver, so the requirement and
        // the recipient are in direct conflict.
        authorization: authorization({ destinationRecipient: 't1V9mnyk5Z5cTNMCkLbaDwSskgJZucTLdgW' }),
        nowMs: NOW,
        principalLamports: 100_000_000n,
      }),
  },
  {
    // The headline case. Both the address and the live quote are fine — 1Click
    // prices this shielded-only address — and the route still stops, because a
    // priced quote is not evidence of shielded delivery. It stops at
    // `zec-shielded-support`, one stage before funds could move.
    name: 'a shielded-required route stops at the shielded-support stage, before the deposit',
    expectedStage: 'zec-shielded-support',
    build: () =>
      preflightRoute({ authorization: authorization({}), nowMs: NOW, principalLamports: 100_000_000n }),
  },
  {
    name: 'a transparent-allowed route with a transparent-capable recipient also stops at the deposit',
    expectedStage: 'conversion-deposit',
    build: () =>
      preflightRoute({
        authorization: authorization({
          destinationRecipient: TRANSPARENT_AND_SAPLING,
          destinationReceiver: 'transparent-allowed',
        }),
        nowMs: NOW,
        principalLamports: 100_000_000n,
      }),
  },
  {
    name: 'with networking disabled, shielded support cannot be assumed',
    expectedStage: 'zec-shielded-support',
    build: () =>
      preflightRoute({
        authorization: authorization({}),
        nowMs: NOW,
        principalLamports: 100_000_000n,
        allowNetwork: false,
      }),
  },
]

async function main() {
  console.log('Voxels · route preflight')
  console.log(`  funds become unrecoverable from stage "${FUNDS_AT_RISK_FROM}"`)
  console.log('')

  let failures = 0
  for (const scenario of scenarios) {
    const outcome = await scenario.build()
    const stage = outcome.ok ? '(passed entirely)' : outcome.failedStage
    const correct = !outcome.ok && outcome.failedStage === scenario.expectedStage
    if (!correct) failures += 1

    console.log(`${correct ? 'ok  ' : 'FAIL'}  ${scenario.name}`)
    console.log(`      expected stage ${scenario.expectedStage}, got ${stage}`)
    console.log(renderPreflight(outcome))
    console.log('')
  }

  if (failures) {
    console.log(`FAIL — ${failures} scenario(s) did not fail closed at the expected stage`)
    process.exit(1)
  }
  console.log('PASS — every scenario failed closed, each naming the correct stage, all before funds could move')
}

main().catch(error => {
  console.error(`FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
