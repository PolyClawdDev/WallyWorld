/* ------------------------------------------------------------------ *
 * ZIP-316 parsing, checked against the official test vectors.
 *
 *   npm run verify:zip316
 *
 * The vectors come from `zcash/zcash-test-vectors`, which is the canonical
 * source, and are cached next to this script after the first run so the check
 * works offline afterwards. Column order is declared by that repository's own
 * `unified_address.py` generator:
 *
 *   p2pkh_bytes, p2sh_bytes, sapling_raw_addr, orchard_raw_addr,
 *   unknown_typecode, unknown_bytes, unified_addr, root_seed, account,
 *   diversifier_index
 *
 * So each row states which receivers its address was built from, and the test is
 * a comparison against that rather than against our own expectation. Three
 * things are proven:
 *
 *   1. The parser reports exactly the receiver set each vector was generated
 *      from, for all 60 vectors.
 *   2. A shielded receiver can be selected from every shielded-capable address,
 *      and the bytes come back.
 *   3. Transparent-only delivery is **refused** for a shielded-capable address —
 *      `selectShieldedReceiver` never returns the transparent receiver, which is
 *      the silent-downgrade failure §6 forbids.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import bs58 from 'bs58'
import { parseZcashAddress, selectShieldedReceiver } from '../src/server/providers/zcashAddress'

const VECTOR_URL =
  'https://raw.githubusercontent.com/zcash/zcash-test-vectors/master/test-vectors/json/unified_address.json'

const here = dirname(fileURLToPath(import.meta.url))
const cachePath = join(here, '.fixtures', 'zip316-unified-address-vectors.json')

type Row = [string | null, string | null, string | null, string | null, number | null, string | null, string, string, number, number]

async function vectors(): Promise<{ rows: Row[]; source: string; httpStatus: number | null }> {
  try {
    const response = await fetch(VECTOR_URL)
    const text = await response.text()
    if (response.ok) {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, text)
      const parsed = JSON.parse(text) as unknown[]
      return { rows: parsed.slice(2) as Row[], source: VECTOR_URL, httpStatus: response.status }
    }
    console.log(`  fetch returned HTTP ${response.status}; falling back to the cached copy`)
  } catch (error) {
    console.log(`  fetch failed (${error instanceof Error ? error.message : String(error)}); trying the cache`)
  }
  if (!existsSync(cachePath)) {
    throw new Error(`no cached vectors at ${cachePath} and the canonical copy could not be fetched`)
  }
  const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown[]
  return { rows: parsed.slice(2) as Row[], source: cachePath, httpStatus: null }
}

const expectedReceivers = (row: Row): string[] => {
  const [p2pkh, p2sh, sapling, orchard] = row
  const receivers: string[] = []
  if (p2pkh) receivers.push('p2pkh')
  if (p2sh) receivers.push('p2sh')
  if (sapling) receivers.push('sapling')
  if (orchard) receivers.push('orchard')
  return receivers
}

const sorted = (values: readonly string[]) => [...values].sort().join(',')

async function main() {
  console.log('Voxels · ZIP-316 unified address parsing')
  const { rows, source, httpStatus } = await vectors()
  console.log(`  vectors     ${rows.length} from ${source}${httpStatus === null ? '' : ` (HTTP ${httpStatus})`}`)
  console.log('')

  let checked = 0
  let receiverMismatches = 0
  let shieldedSelected = 0
  let shieldedRefusedCorrectly = 0
  let unknownTypecodeRejected = 0
  let transparentOnlyRefusals = 0
  const failures: string[] = []

  for (const [index, row] of rows.entries()) {
    const address = row[6]
    const unknownTypecode = row[4]
    const expected = expectedReceivers(row)

    const parsed = await parseZcashAddress(address, 'main')
    if (!parsed.ok) {
      // A vector built solely from an unknown typecode has no receiver this
      // build understands, so a refusal is the correct outcome.
      if (expected.length === 0 && unknownTypecode !== null) {
        unknownTypecodeRejected += 1
        checked += 1
        continue
      }
      failures.push(`vector ${index}: expected [${expected.join(',')}] but the parser refused — ${parsed.detail}`)
      receiverMismatches += 1
      continue
    }

    checked += 1
    if (sorted(parsed.parsed.receivers) !== sorted(expected)) {
      receiverMismatches += 1
      failures.push(
        `vector ${index}: vector was built from [${expected.join(',')}], parser reported ` +
          `[${parsed.parsed.receivers.join(',')}]`,
      )
      continue
    }
    if (unknownTypecode !== null && !parsed.parsed.unknownTypecodes.includes(unknownTypecode)) {
      failures.push(`vector ${index}: unknown typecode ${unknownTypecode} was not surfaced`)
      receiverMismatches += 1
      continue
    }

    const selection = await selectShieldedReceiver(address, 'main')
    if (parsed.parsed.hasShieldedReceiver) {
      if (!selection.ok) {
        failures.push(`vector ${index}: shielded receiver present but selection failed — ${selection.detail}`)
        continue
      }
      shieldedSelected += 1
      // The downgrade check: a shielded-capable address that also carries a
      // transparent receiver must still select the shielded one.
      if (parsed.parsed.hasTransparentReceiver) {
        if (selection.selected.receiverType === 'p2pkh' || selection.selected.receiverType === 'p2sh') {
          failures.push(`vector ${index}: selection fell back to a transparent receiver`)
        } else {
          transparentOnlyRefusals += 1
        }
      }
    } else if (parsed.parsed.hasTransparentReceiver) {
      // Transparent-only address: selection must refuse rather than return the
      // transparent receiver dressed up as a shielded one.
      if (selection.ok) {
        failures.push(`vector ${index}: transparent-only address produced a "shielded" selection`)
      } else {
        shieldedRefusedCorrectly += 1
      }
    }
  }

  /* ---- explicit negative cases ------------------------------------------ *
   * The official vector matrix contains no transparent-only address and no
   * address built solely from an unknown typecode, so the two refusals that
   * matter most are not exercised by it. They are constructed here instead.   */

  // A real mainnet P2PKH address, built from the 20-byte key hash in vector 1
  // using the documented mainnet t-addr prefix. The parser reporting exactly
  // `[p2pkh]` for it is what confirms the construction, so this is a check in
  // both directions rather than a trusted fixture.
  const keyHash = rows.find(row => row[0])?.[0]
  if (keyHash) {
    const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.from(keyHash, 'hex')])
    const checksum = createHash('sha256')
      .update(createHash('sha256').update(payload).digest())
      .digest()
      .subarray(0, 4)
    const taddr = bs58.encode(Buffer.concat([payload, checksum]))

    const parsedT = await parseZcashAddress(taddr, 'main')
    if (!parsedT.ok || sorted(parsedT.parsed.receivers) !== 'p2pkh') {
      failures.push(
        `constructed t-address ${taddr} did not parse as a transparent-only address ` +
          `(${parsedT.ok ? parsedT.parsed.receivers.join(',') : parsedT.detail})`,
      )
    } else {
      const refused = await selectShieldedReceiver(taddr, 'main')
      if (refused.ok) {
        failures.push('a transparent-only t-address produced a shielded selection')
      } else {
        shieldedRefusedCorrectly += 1
        console.log(`  transparent-only t-address      ${taddr}`)
        console.log(`    parsed receivers              [${parsedT.parsed.receivers.join(',')}]`)
        console.log(`    shielded selection            REFUSED — ${refused.detail.slice(0, 96)}…`)
      }
    }
  }

  // An address whose only receiver is a typecode this build does not know must
  // be unusable rather than guessed at.
  const unknownOnly = 'u1ldhmqnkm57nvjrkpvqz6tcy44su7l9rgd0n4qljmvd4v0zwft05tzzhwewslcvhmawhpvrhrhqg8qrwmgwsjcf'
  const parsedUnknown = await parseZcashAddress(unknownOnly, 'main')
  if (parsedUnknown.ok && parsedUnknown.parsed.receivers.length === 0) {
    unknownTypecodeRejected += 1
    console.log(`  unknown-typecode-only address   unusable, typecodes [${parsedUnknown.parsed.unknownTypecodes.join(',')}]`)
  } else if (!parsedUnknown.ok) {
    unknownTypecodeRejected += 1
    console.log(`  unknown-typecode-only address   rejected outright — ${parsedUnknown.detail.slice(0, 80)}…`)
  } else {
    failures.push('an address with no known receiver reported usable receivers')
  }
  console.log('')

  console.log(`  parsed                          ${checked}/${rows.length}`)
  console.log(`  receiver sets matching vectors  ${checked - receiverMismatches}/${checked}`)
  console.log(`  shielded receivers selected     ${shieldedSelected}`)
  console.log(`  transparent fallback refused    ${transparentOnlyRefusals} (shielded chosen over an available transparent receiver)`)
  console.log(`  transparent-only refused        ${shieldedRefusedCorrectly} (no shielded receiver to send to)`)
  console.log(`  unknown-typecode-only rejected  ${unknownTypecodeRejected}`)
  console.log('')

  if (failures.length) {
    console.log('FAIL')
    for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`)
    process.exit(1)
  }
  console.log('PASS — the parser agrees with every official ZIP-316 vector, and never downgrades to transparent')
}

main().catch(error => {
  console.error(`FAIL — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
