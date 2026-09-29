/* ------------------------------------------------------------------ *
 * Does this route deliver ZEC into a shielded pool?
 *
 *   npm run verify:zec-delivery
 *
 * Read-only from end to end. It asks for `dry` quotes, reads public NEAR and
 * Zcash data, and moves nothing. No key is loaded and no transaction is built.
 *
 * Three independent checks, in increasing order of how much they prove:
 *
 *   1. **Capability metadata.** Ask the provider what it will tell us about
 *      Zcash. The answer is nothing — there is no field anywhere in its schema
 *      for a receiver type or a pool — and recording that absence is what stops
 *      a later reader assuming the question was never asked.
 *
 *   2. **The differential quote.** Price the same swap against seven Zcash
 *      addresses whose receiver sets are known, because each is built from the
 *      official ZIP-316 vectors and re-parsed before use. The acceptances and
 *      rejections are not uniform, and the shape of the difference is the
 *      finding: a transparent or an Orchard receiver is required, and Sapling
 *      alone is refused in both its encodings.
 *
 *   3. **The executor, on chain.** 1Click does not pay; NEAR's Omni Bridge
 *      Zcash connector does. Read its wallet's recent transactions and count
 *      Orchard actions with a negative valueBalance — value leaving the
 *      transparent pool for the shielded one.
 *
 * Check 3 is the one that settles it, and it is also the reason this script
 * exists as a standing check rather than a one-off investigation: if the
 * connector ever stops building Orchard outputs, or the validator starts
 * accepting Sapling, the product's central claim changes and this fails.
 * ------------------------------------------------------------------ */

import {
  loadVectors,
  saplingAddressFrom,
  transparentAddressFrom,
  vectorWithReceivers,
  type VectorRow,
} from './lib/zec-vectors'
import { parseZcashAddress } from '../src/server/providers/zcashAddress'
import { ZEC_EXECUTOR, ZEC_NATIVE_ASSET_ID } from '../src/server/providers/oneclick'
import { COURIER_ORIGIN_ASSET_ID } from '../src/server/providers/courier'

const ONECLICK = 'https://1click.chaindefuser.com'
const NEARBLOCKS = 'https://api.nearblocks.io/v1'
const BLOCKCHAIR = 'https://api.blockchair.com/zcash'

/** A burn address. Only ever sent as a refund field on a dry quote. */
const REFUND_TO = '11111111111111111111111111111112'

const failures: string[] = []
const fail = (message: string) => {
  failures.push(message)
  console.log(`  FAIL  ${message}`)
}

/* ------------------------------------------------------------------ *
 * 1. Capability metadata
 * ------------------------------------------------------------------ */

async function checkCapabilityMetadata(): Promise<void> {
  console.log('1. What the provider will tell us about Zcash')

  const spec = await fetch(`${ONECLICK}/docs/v0/openapi.yaml`)
  const text = await spec.text()
  console.log(`  GET /docs/v0/openapi.yaml            HTTP ${spec.status}, ${text.length} bytes`)

  // If any of these ever appears, the provider has started describing receiver
  // support and this script should be reading it instead of inferring.
  const terms = ['shielded', 'orchard', 'sapling', 'unified', 'zip-316', 'transparent']
  const found = terms.filter(term => text.toLowerCase().includes(term))
  console.log(`  pool or receiver vocabulary in spec  ${found.length === 0 ? 'none' : found.join(', ')}`)
  if (found.length > 0) {
    console.log('        the schema now mentions receivers — read it rather than relying on the inference below')
  }

  const tokens = await fetch(`${ONECLICK}/v0/tokens`)
  const list = (await tokens.json()) as Array<Record<string, unknown>>
  const native = list.find(token => token.assetId === ZEC_NATIVE_ASSET_ID)
  console.log(`  GET /v0/tokens                       HTTP ${tokens.status}, ${list.length} assets`)
  if (!native) {
    fail(`${ZEC_NATIVE_ASSET_ID} is no longer in the token list`)
    return
  }
  console.log(`  native Zcash asset fields            ${Object.keys(native).join(', ')}`)
  console.log('        no field describes a receiver type, an address format, or a pool')
}

/* ------------------------------------------------------------------ *
 * 2. The differential quote
 * ------------------------------------------------------------------ */

interface AddressCase {
  readonly label: string
  readonly address: string
  /** Receiver set this construction must parse back to, or null for the control. */
  readonly expect: readonly string[] | null
  /** The status this script asserts, from the observed acceptance rule. */
  readonly expectAccepted: boolean
}

function buildCases(rows: VectorRow[]): AddressCase[] {
  const ua = (want: string[]) => vectorWithReceivers(rows, want)[6]
  const orchardOnly = ua(['orchard'])
  return [
    {
      label: 't1 transparent only',
      address: transparentAddressFrom(vectorWithReceivers(rows, ['p2pkh', 'sapling'])[0]!),
      expect: ['p2pkh'],
      expectAccepted: true,
    },
    {
      label: 'zs1 Sapling only (legacy)',
      address: saplingAddressFrom(vectorWithReceivers(rows, ['sapling'])[2]!),
      expect: ['sapling'],
      expectAccepted: false,
    },
    { label: 'UA Sapling only', address: ua(['sapling']), expect: ['sapling'], expectAccepted: false },
    { label: 'UA Orchard only', address: orchardOnly, expect: ['orchard'], expectAccepted: true },
    {
      label: 'UA Sapling + Orchard',
      address: ua(['sapling', 'orchard']),
      expect: ['sapling', 'orchard'],
      expectAccepted: true,
    },
    {
      label: 'UA transparent + Sapling',
      address: ua(['p2pkh', 'sapling']),
      expect: ['p2pkh', 'sapling'],
      expectAccepted: true,
    },
    {
      label: 'UA transparent + Orchard',
      address: ua(['p2pkh', 'orchard']),
      expect: ['p2pkh', 'orchard'],
      expectAccepted: true,
    },
    // The control. Without it, "the validator accepted our address" would be
    // indistinguishable from "the validator accepts anything".
    {
      label: 'CONTROL corrupted UA',
      address: `${orchardOnly.slice(0, -1)}${orchardOnly.endsWith('1') ? '0' : '1'}`,
      expect: null,
      expectAccepted: false,
    },
  ]
}

async function checkDifferentialQuote(rows: VectorRow[]): Promise<void> {
  console.log('')
  console.log('2. Differential dry quotes, SOL to ZEC, one SOL each')

  const cases = buildCases(rows)

  // Every construction is confirmed against the librustzcash-backed parser
  // before it is used as evidence. A mis-built address that happened to be
  // rejected would otherwise look like a finding about the provider.
  for (const item of cases) {
    const parsed = await parseZcashAddress(item.address, 'main')
    const got = parsed.ok ? [...parsed.parsed.receivers].sort().join(',') : null
    const want = item.expect === null ? null : [...item.expect].sort().join(',')
    if (got !== want) {
      fail(`${item.label}: parser reports ${got ?? 'invalid'}, construction intended ${want ?? 'invalid'}`)
    }
  }
  if (failures.length > 0) return
  console.log(`  all ${cases.length} constructions confirmed by the ZIP-316 parser`)
  console.log('')

  const deadline = new Date(Date.now() + 30 * 60_000).toISOString()
  console.log(`  ${'address class'.padEnd(26)} ${'HTTP'.padEnd(6)} ${'amountOut (zat)'.padEnd(17)} message`)

  for (const item of cases) {
    const response = await fetch(`${ONECLICK}/v0/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: COURIER_ORIGIN_ASSET_ID,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: ZEC_NATIVE_ASSET_ID,
        amount: '1000000000',
        refundTo: REFUND_TO,
        refundType: 'ORIGIN_CHAIN',
        recipient: item.address,
        recipientType: 'DESTINATION_CHAIN',
        deadline,
      }),
    })
    const body = (await response.json()) as { quote?: { amountOut?: string; depositAddress?: string }; message?: string }
    const accepted = response.status >= 200 && response.status < 300

    if (body.quote?.depositAddress) {
      fail(`${item.label}: a dry quote returned a deposit address, which must never happen`)
    }
    console.log(
      `  ${item.label.padEnd(26)} ${String(response.status).padEnd(6)} ` +
        `${(body.quote?.amountOut ?? '—').padEnd(17)} ${body.message ?? ''}`,
    )
    if (accepted !== item.expectAccepted) {
      fail(
        `${item.label}: expected the provider to ${item.expectAccepted ? 'accept' : 'reject'} this, ` +
          `got HTTP ${response.status}. The acceptance rule has changed and the verdict in oneclick.ts ` +
          'must be re-derived.',
      )
    }
  }

  console.log('')
  console.log('  Reading: a transparent receiver or an Orchard receiver is required. An Orchard-only address')
  console.log('  has no transparent receiver to fall back to and is accepted anyway; Sapling alone is refused')
  console.log('  in both encodings. That is a ZIP-316 sender supporting {p2pkh, p2sh, orchard}.')
}

/* ------------------------------------------------------------------ *
 * 3. The executor, on chain
 * ------------------------------------------------------------------ */

async function checkProductionDestinations(): Promise<void> {
  console.log('')
  console.log(`3a. Recent withdrawals queued on ${ZEC_EXECUTOR.bridgeToken}`)

  // Two pages, because withdrawals to unified addresses are frequent but not
  // constant, and a one-page window can easily hold none of them. A quiet
  // window is reported as quiet rather than as an absence of support.
  const txns: Array<{ actions?: Array<{ args?: string }> }> = []
  for (const page of [1, 2]) {
    const response = await fetch(
      `${NEARBLOCKS}/account/${ZEC_EXECUTOR.bridgeToken}/txns?per_page=50&page=${page}&order=desc`,
    )
    const body = (await response.json()) as { txns?: Array<{ actions?: Array<{ args?: string }> }> }
    txns.push(...(body.txns ?? []))
    console.log(`  GET /account/${ZEC_EXECUTOR.bridgeToken}/txns?page=${page}   HTTP ${response.status}`)
  }
  console.log(`  ${txns.length} receipt rows scanned`)

  const destinations = new Set<string>()
  for (const txn of txns) {
    for (const action of txn.actions ?? []) {
      for (const match of (action.args ?? '').matchAll(/\b(u1[a-z0-9]{60,})\b/g)) destinations.add(match[1]!)
    }
  }
  if (destinations.size === 0) {
    console.log('  no unified-address withdrawals in this window — not a failure, just a quiet sample')
    return
  }

  let shieldedOnly = 0
  for (const address of destinations) {
    const parsed = await parseZcashAddress(address, 'main')
    if (!parsed.ok) {
      console.log(`  ${address.slice(0, 18)}…  unparseable`)
      continue
    }
    if (parsed.parsed.shieldedOnly) shieldedOnly += 1
    console.log(
      `  ${address.slice(0, 18)}…  [${parsed.parsed.receivers.join(',')}]` +
        `${parsed.parsed.shieldedOnly ? '  shielded-only, no transparent receiver' : ''}`,
    )
  }
  console.log(`  ${shieldedOnly}/${destinations.size} production destinations expose no transparent receiver`)
}

async function checkOrchardOnChain(): Promise<void> {
  console.log('')
  console.log(`3b. What ${ZEC_EXECUTOR.connectorContract} actually broadcasts`)
  console.log(`  wallet ${ZEC_EXECUTOR.changeAddress}`)

  const dashboard = await fetch(`${BLOCKCHAIR}/dashboards/address/${ZEC_EXECUTOR.changeAddress}?limit=10`)
  const body = (await dashboard.json()) as {
    data?: Record<string, { transactions?: string[] }>
  }
  const hashes = body.data?.[ZEC_EXECUTOR.changeAddress]?.transactions ?? []
  if (hashes.length === 0) {
    fail('no recent transactions for the connector wallet; the executor could not be observed')
    return
  }

  console.log('')
  console.log(`  ${'txid'.padEnd(20)} ${'t-in'.padEnd(5)} ${'t-out'.padEnd(6)} ${'orchard'.padEnd(8)} shielded value (zat)`)

  let withOrchard = 0
  for (const hash of hashes.slice(0, 10)) {
    const raw = await fetch(`${BLOCKCHAIR}/raw/transaction/${hash}`)
    const parsed = (await raw.json()) as {
      data?: Record<string, { decoded_raw_transaction?: DecodedTx }>
    }
    const decoded = parsed.data?.[hash]?.decoded_raw_transaction
    if (!decoded) {
      console.log(`  ${hash.slice(0, 18)}  (no decode)`)
      continue
    }
    // Two bundle names because the chain is mid-upgrade: `orchard` is the v5
    // bundle, `ironwood` the NU7 successor. Both are Orchard; counting only one
    // would undercount as the network moves over.
    const actions = (decoded.orchard?.actions?.length ?? 0) + (decoded.ironwood?.actions?.length ?? 0)
    const balance = (decoded.orchard?.valueBalanceZat ?? 0) + (decoded.ironwood?.valueBalanceZat ?? 0)
    if (actions > 0 && balance < 0) withOrchard += 1
    console.log(
      `  ${hash.slice(0, 18)} ${String(decoded.vin?.length ?? 0).padEnd(5)} ` +
        `${String(decoded.vout?.length ?? 0).padEnd(6)} ${String(actions).padEnd(8)} ${balance}`,
    )
    await new Promise(resolve => setTimeout(resolve, 350))
  }

  console.log('')
  console.log(`  ${withOrchard}/${Math.min(hashes.length, 10)} recent transactions move value INTO the Orchard pool`)
  console.log('  (a negative Orchard valueBalance is value leaving the transparent pool for the shielded one)')

  if (withOrchard === 0) {
    fail(
      'the connector wallet shows no Orchard output in its recent transactions. Shielded delivery can no ' +
        'longer be substantiated, and the courier must not be offered as private.',
    )
  }
}

interface DecodedTx {
  vin?: unknown[]
  vout?: unknown[]
  orchard?: { actions?: unknown[]; valueBalanceZat?: number }
  ironwood?: { actions?: unknown[]; valueBalanceZat?: number }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('Voxels · does NEAR Intents deliver ZEC into a shielded pool?')
  console.log('')

  const { rows, source } = await loadVectors()
  console.log(`  ZIP-316 vectors  ${rows.length} from ${source}`)
  console.log('')

  await checkCapabilityMetadata()
  await checkDifferentialQuote(rows)
  await checkProductionDestinations()
  await checkOrchardOnChain()

  console.log('')
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} check(s) did not hold:`)
    for (const failure of failures) console.log(`  ${failure}`)
    process.exit(1)
  }
  console.log('PASS — the provider requires a transparent or Orchard receiver and refuses Sapling alone, and')
  console.log('the connector that executes the Zcash leg is paying into the Orchard pool. An address with an')
  console.log('Orchard receiver and no transparent receiver has no public destination available to it.')
  console.log('')
  console.log('Still not shown, and unshowable: which address any individual Orchard action paid. That is')
  console.log('encrypted to its recipient, so only the player can confirm their own payment arrived.')
}

main().catch(error => {
  console.error(`FAIL — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
