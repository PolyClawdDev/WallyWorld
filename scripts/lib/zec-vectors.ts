/* ------------------------------------------------------------------ *
 * The Zcash address set used by the delivery experiment.
 *
 * Every address here is derived from the official `zcash-test-vectors`
 * unified-address vectors, the same file `npm run verify:zip316` checks
 * against, and each one is re-parsed by the librustzcash-backed parser before
 * it is used. Nothing is a pasted literal whose receiver set is asserted from
 * memory: if a construction were wrong, the parse would disagree with the
 * receiver set the vector was generated from and the caller refuses.
 *
 * No keys are generated and no signing happens. These are receiving addresses
 * from a public test-vector file; they hold nothing, and the experiment that
 * uses them only ever asks for a `dry` quote.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import bs58 from 'bs58'

const here = dirname(fileURLToPath(import.meta.url))
const cachePath = join(here, '..', '.fixtures', 'zip316-unified-address-vectors.json')

export const VECTOR_URL =
  'https://raw.githubusercontent.com/zcash/zcash-test-vectors/master/test-vectors/json/unified_address.json'

/**
 * Column order is declared by `unified_address.py` in `zcash/zcash-test-vectors`:
 * p2pkh_bytes, p2sh_bytes, sapling_raw_addr, orchard_raw_addr, unknown_typecode,
 * unknown_bytes, unified_addr, root_seed, account, diversifier_index.
 */
export type VectorRow = [
  string | null, string | null, string | null, string | null,
  number | null, string | null, string, string, number, number,
]

export async function loadVectors(): Promise<{ rows: VectorRow[]; source: string }> {
  try {
    const response = await fetch(VECTOR_URL)
    if (response.ok) {
      const parsed = JSON.parse(await response.text()) as unknown[]
      return { rows: parsed.slice(2) as VectorRow[], source: VECTOR_URL }
    }
  } catch {
    // fall through to the cache written by npm run verify:zip316
  }
  if (!existsSync(cachePath)) {
    throw new Error(`no cached vectors at ${cachePath} and the canonical copy could not be fetched`)
  }
  return { rows: (JSON.parse(readFileSync(cachePath, 'utf8')) as unknown[]).slice(2) as VectorRow[], source: cachePath }
}

export const receiversOf = (row: VectorRow): string[] => {
  const out: string[] = []
  if (row[0]) out.push('p2pkh')
  if (row[1]) out.push('p2sh')
  if (row[2]) out.push('sapling')
  if (row[3]) out.push('orchard')
  return out
}

/** Finds the first vector whose receiver set is exactly `want`. */
export function vectorWithReceivers(rows: VectorRow[], want: readonly string[]): VectorRow {
  const target = [...want].sort().join(',')
  const found = rows.find(row => receiversOf(row).sort().join(',') === target)
  if (!found) throw new Error(`no official vector has exactly the receiver set [${want.join(',')}]`)
  return found
}

/* --------------------------------------------------- legacy encodings */

/**
 * Mainnet P2PKH, base58check with the two-byte `0x1cb8` prefix from zcash's
 * `chainparams.cpp`. Same construction `verify-zip316.ts` already uses.
 */
export function transparentAddressFrom(p2pkhHex: string): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.from(p2pkhHex, 'hex')])
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4)
  return bs58.encode(Buffer.concat([payload, checksum]))
}

/* ---- bech32, BIP-173, for the legacy Sapling `zs` encoding --------------- *
 * This is a checksummed base32 encoding, not cryptography: no key material is
 * derived and no signature is produced. It is here because ZIP-316 is not the
 * only way to name a Sapling receiver, and an address in the older encoding is
 * a materially different string for a server-side validator to look at.
 * Correctness is not assumed — the caller round-trips the result through the
 * librustzcash-backed parser and requires it to report exactly `[sapling]`.   */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const polymod = (values: number[]): number => {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= generators[bit]!
  }
  return checksum
}

const expandHrp = (hrp: string): number[] => [
  ...[...hrp].map(character => character.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map(character => character.charCodeAt(0) & 31),
]

const toFiveBit = (bytes: Uint8Array): number[] => {
  const out: number[] = []
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((accumulator >>> bits) & 31)
    }
  }
  if (bits > 0) out.push((accumulator << (5 - bits)) & 31)
  return out
}

export function saplingAddressFrom(saplingRawHex: string): string {
  const hrp = 'zs'
  const data = toFiveBit(Buffer.from(saplingRawHex, 'hex'))
  const checksum = polymod([...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const tail = [0, 1, 2, 3, 4, 5].map(index => (checksum >>> (5 * (5 - index))) & 31)
  return `${hrp}1${[...data, ...tail].map(value => CHARSET[value]).join('')}`
}
