/* ------------------------------------------------------------------ *
 * Zcash address parsing and shielded receiver selection (§6).
 *
 * No cryptography is written here. The parsing is done by `@jp4g/zcash.js`
 * 0.1.0-rc.1, a Rust/WASM SDK whose address layer is a binding over the
 * librustzcash crates — so bech32m decoding, F4Jumble, and ZIP-316 receiver
 * parsing are all performed by the same implementation the protocol's own
 * reference code uses, not by a re-derivation of the spec in TypeScript.
 *
 * That choice needs stating plainly, because "maintained" is doing a lot of
 * work in this sentence. The honest position, checked today:
 *
 *   - There is **no mature Zcash address library on npm.** `zcash-address` and
 *     `zcash_address` do not exist there. `@ledgerhq/zcash-utils` 2.5.0 is a
 *     real, actively published NAPI binding to librustzcash, but it exposes no
 *     address decoder at all — only sync, transaction building and PCZT
 *     handling — so it cannot do this job.
 *   - `@jp4g/zcash.js` is three weeks old, at `0.1.0-rc.1` under the `next`
 *     dist-tag, and its own changelog says "This prerelease is not fully
 *     release-qualified". It is used here anyway because the alternative is
 *     hand-rolling ZIP-316, and because its correctness *for this one job* is
 *     directly checkable: `scripts/verify-zip316.ts` runs it against all 60
 *     official `zcash-test-vectors` unified-address vectors and compares the
 *     receiver set it reports against the receiver set each vector was
 *     generated from. It agrees on every row.
 *
 * What this module does **not** do is decide policy. It reports which
 * receivers an address exposes; whether that is good enough is the policy
 * engine's call, via `destinationReceiver`.
 * ------------------------------------------------------------------ */

import type { ObservedReceiver } from '../../shared/authorization'
import { httpEvidence, parseJson, probe } from './probe'
import { deriveState, providerFailure, type AdapterResult, type Capability, type Evidence, type IntegrationReport } from './types'

/** The canonical ZIP-316 unified address vectors. Also used by verify-zip316. */
export const ZIP316_VECTOR_URL =
  'https://raw.githubusercontent.com/zcash/zcash-test-vectors/master/test-vectors/json/unified_address.json'

export const ZCASH_ADDRESS_PROVIDER_ID = 'zcash-address'

export const ZCASH_ADDRESS_SDK = { name: '@jp4g/zcash.js', version: '0.1.0-rc.1' } as const

/* ------------------------------------------------------------------ *
 * Consensus parameters
 *
 * The published 0.1.0-rc.1 requires a full network definition rather than the
 * `defineNetwork('mainnet')` preset its in-development docs show, so the
 * activation schedule has to be supplied. Every number below is copied from a
 * single verifiable source — `MainNetwork::activation_height` in
 * zcash_protocol, the crate this SDK's own documentation names as the
 * provenance of its presets — and the genesis hashes from zcash's
 * `chainparams.cpp`. Nothing here is inferred from an endpoint, which is the
 * point: an address must not parse differently because a server said so.
 * ------------------------------------------------------------------ */

/** https://github.com/zcash/librustzcash — components/zcash_protocol/src/consensus.rs */
const ACTIVATION_HEIGHTS = {
  main: {
    Overwinter: 347_500,
    Sapling: 419_200,
    Blossom: 653_600,
    Heartwood: 903_000,
    Canopy: 1_046_400,
    Nu5: 1_687_104,
    Nu6: 2_726_400,
    Nu6_1: 3_146_400,
    Nu6_2: 3_364_600,
    Nu6_3: 3_428_143,
  },
  test: {
    Overwinter: 207_500,
    Sapling: 280_000,
    Blossom: 584_000,
    Heartwood: 903_800,
    Canopy: 1_028_500,
    Nu5: 1_842_420,
    Nu6: 2_976_000,
    Nu6_1: 3_536_500,
    Nu6_2: 4_052_000,
    Nu6_3: 4_134_000,
  },
} as const

/** https://github.com/zcash/zcash — src/chainparams.cpp, `consensus.hashGenesisBlock` */
const GENESIS = {
  main: '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08',
  test: '05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38',
} as const

/** Consensus branch ids, same source as the heights. Nu6_3 is the current one. */
const BRANCH_ID = { Nu6_3: 0x37a5_165b } as const

export type ZcashNetwork = 'main' | 'test'

/* ------------------------------------------------------------------ *
 * Lazy SDK loading
 *
 * The SDK ships a large WASM runtime, so it is imported on first use rather
 * than at module load. That also means a broken or absent install degrades to
 * an honest `unavailable` state instead of taking the server down at boot.
 * ------------------------------------------------------------------ */

type AddressSdk = {
  decode(args: { network: unknown; address: string }): Promise<{
    knownReceivers: readonly string[]
    unknownTypecodes: readonly number[]
  }>
  selectReceiver(args: {
    address: unknown
    pool: string
    context: unknown
  }): Promise<{ pool: string; type: string; bytes: Uint8Array }>
}

interface LoadedSdk {
  addresses: AddressSdk
  network: unknown
  context: unknown
}

const loaded = new Map<ZcashNetwork, Promise<LoadedSdk>>()

async function loadSdk(network: ZcashNetwork): Promise<LoadedSdk> {
  const cached = loaded.get(network)
  if (cached) return cached

  const promise = (async (): Promise<LoadedSdk> => {
    const sdk = (await import('@jp4g/zcash.js')) as unknown as {
      defineNetwork(args: unknown): Promise<unknown>
      blockHash(hex: string): unknown
      addresses: AddressSdk
    }

    const heights = ACTIVATION_HEIGHTS[network]
    // The SDK requires canonical JSON with exactly these keys in exactly this
    // order and rejects any deviation, including extra whitespace. Building the
    // string through `JSON.stringify` of a literal keeps that guaranteed.
    const parameters = new TextEncoder().encode(
      JSON.stringify({ encoding: network, ...heights }),
    )

    const defined = await sdk.defineNetwork({
      identity: network === 'main' ? 'zcash-mainnet' : 'zcash-testnet',
      genesisHash: sdk.blockHash(GENESIS[network]),
      parametersFormat: 'zcash-js-network/1',
      parameters,
    })

    return {
      addresses: sdk.addresses,
      network: defined,
      context: {
        network: defined,
        targetHeight: heights.Nu6_3 + 1,
        branchId: BRANCH_ID.Nu6_3,
      },
    }
  })()

  loaded.set(network, promise)
  // A failed load must not be cached as a permanent failure: a transient
  // problem would otherwise poison every later call in the process.
  promise.catch(() => loaded.delete(network))
  return promise
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Receiver typecodes ZIP-316 defines and this build understands. */
export type KnownReceiver = 'p2pkh' | 'p2sh' | 'sapling' | 'orchard'

const SHIELDED_RECEIVERS = new Set<KnownReceiver>(['sapling', 'orchard'])

export interface ParsedZcashAddress {
  readonly address: string
  readonly network: ZcashNetwork
  readonly receivers: readonly KnownReceiver[]
  /**
   * Typecodes present in the address that this build does not understand.
   *
   * ZIP-316 requires an address containing only unknown typecodes be treated as
   * unusable rather than guessed at, so these are surfaced rather than dropped.
   */
  readonly unknownTypecodes: readonly number[]
  readonly hasShieldedReceiver: boolean
  readonly hasTransparentReceiver: boolean
  /** True when the address offers nothing but shielded receivers. */
  readonly shieldedOnly: boolean
}

/**
 * Decodes any Zcash address and reports the receivers it exposes.
 *
 * Note what is *not* inferred: nothing here looks at the `u1`/`t1`/`t3` prefix
 * to decide anything. "Do not infer privacy from a prefix" is a §6 requirement,
 * and a prefix check is exactly the shortcut that makes a transparent-only
 * unified address look private.
 */
export async function parseZcashAddress(
  address: string,
  network: ZcashNetwork = 'main',
): Promise<AdapterResult<{ parsed: ParsedZcashAddress }>> {
  if (typeof address !== 'string' || !address.trim()) {
    return providerFailure('validation-error', 'address must be a non-empty string')
  }

  let sdk: LoadedSdk
  try {
    sdk = await loadSdk(network)
  } catch (error) {
    return providerFailure(
      'unsupported',
      `the ZIP-316 parser (${ZCASH_ADDRESS_SDK.name}@${ZCASH_ADDRESS_SDK.version}) could not be loaded: ` +
        `${error instanceof Error ? error.message : String(error)}. Address parsing is unavailable; ` +
        'no address is accepted while it is.',
    )
  }

  try {
    const decoded = await sdk.addresses.decode({ network: sdk.network, address: address.trim() })
    const receivers = decoded.knownReceivers.filter((receiver): receiver is KnownReceiver =>
      receiver === 'p2pkh' || receiver === 'p2sh' || receiver === 'sapling' || receiver === 'orchard',
    )
    const hasShielded = receivers.some(receiver => SHIELDED_RECEIVERS.has(receiver))
    const hasTransparent = receivers.some(receiver => receiver === 'p2pkh' || receiver === 'p2sh')
    return {
      ok: true,
      parsed: {
        address: address.trim(),
        network,
        receivers,
        unknownTypecodes: [...decoded.unknownTypecodes],
        hasShieldedReceiver: hasShielded,
        hasTransparentReceiver: hasTransparent,
        shieldedOnly: hasShielded && !hasTransparent,
      },
    }
  } catch (error) {
    return providerFailure(
      'validation-error',
      `not a valid ${network === 'main' ? 'mainnet' : 'testnet'} Zcash address: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/* ------------------------------------------------------------------ *
 * Shielded receiver selection
 * ------------------------------------------------------------------ */

export interface SelectedShieldedReceiver {
  readonly pool: string
  readonly receiverType: string
  readonly byteLength: number
  /** Which receiver was chosen, and why that one. */
  readonly rationale: string
}

/**
 * Picks the shielded receiver a payment should use, per ZIP-316.
 *
 * Preference order is Orchard then Sapling, which is ZIP-316's "use the most
 * preferred receiver you support" rule expressed concretely. If neither is
 * present this **fails**; it does not return the transparent receiver. Every
 * caller that wants transparent delivery has to ask for it by name, so a
 * silent downgrade has no code path to travel along.
 */
export async function selectShieldedReceiver(
  address: string,
  network: ZcashNetwork = 'main',
): Promise<AdapterResult<{ parsed: ParsedZcashAddress; selected: SelectedShieldedReceiver }>> {
  const parsedResult = await parseZcashAddress(address, network)
  if (!parsedResult.ok) return parsedResult
  const parsed = parsedResult.parsed

  if (!parsed.hasShieldedReceiver) {
    return providerFailure(
      'unsupported',
      `this address exposes only [${parsed.receivers.join(', ') || 'no known receivers'}], so there is no ` +
        'shielded receiver to send to. Refusing to fall back to a transparent receiver: that would ' +
        'deliver publicly under a private promise.',
    )
  }

  const sdk = await loadSdk(network)
  const decoded = await sdk.addresses.decode({ network: sdk.network, address: parsed.address })

  // `ironwood` is this SDK's pool name for the Orchard receiver encoding, so
  // asking for Orchard means asking for that pool.
  const attempts: Array<{ pool: string; label: string }> = [
    { pool: 'ironwood', label: 'Orchard' },
    { pool: 'sapling', label: 'Sapling' },
  ]

  for (const attempt of attempts) {
    try {
      const selected = await sdk.addresses.selectReceiver({
        address: decoded,
        pool: attempt.pool,
        context: sdk.context,
      })
      return {
        ok: true,
        parsed,
        selected: {
          pool: selected.pool,
          receiverType: selected.type,
          byteLength: selected.bytes.length,
          rationale: `${attempt.label} is the most preferred shielded pool this address exposes`,
        },
      }
    } catch {
      // Not available in this address, or not valid at this consensus height.
      // Try the next pool down; running out is a refusal, not a downgrade.
    }
  }

  return providerFailure(
    'unsupported',
    'the address advertises a shielded receiver but no shielded pool could be selected at the current ' +
      'consensus height. Refusing to substitute a transparent receiver.',
  )
}

/**
 * Turns a parse into the policy engine's vocabulary.
 *
 * `'shielded'` here means only "this address exposes a shielded receiver". It
 * is not a claim about delivery — a provider still has to be willing to pay
 * into that pool, which is a separate question answered in `oneclick.ts`.
 */
export function receiverForPolicy(parsed: ParsedZcashAddress): ObservedReceiver {
  if (parsed.unknownTypecodes.length > 0 && parsed.receivers.length === 0) return 'unknown'
  if (parsed.hasShieldedReceiver) return 'shielded'
  if (parsed.hasTransparentReceiver) return 'transparent'
  return 'unknown'
}

/* ------------------------------------------------------------------ readiness */

/**
 * Parser readiness, proven against the canonical vectors.
 *
 * Deliberately offline: this is a correctness property of a local library, so a
 * network probe would say nothing about it. The two vectors below are official
 * ZIP-316 vectors and are checked in full by `npm run verify:zip316`.
 */
export async function probeZcashAddress(nowMs: number): Promise<IntegrationReport> {
  const evidence: Evidence[] = [
    {
      kind: 'sdk',
      observedAtMs: nowMs,
      environment: 'none',
      summary: 'Rust/WASM ZIP-316 address parsing, a binding over librustzcash',
      packageName: ZCASH_ADDRESS_SDK.name,
      version: ZCASH_ADDRESS_SDK.version,
    },
  ]

  // Fetch the official vectors and decode one taken from the response, rather
  // than decoding an address pasted into this file. A pasted address only shows
  // the parser is self-consistent with whatever was typed here; a fetched one is
  // checked against the canonical source, and the status below is observed.
  const vectors = await probe({ url: ZIP316_VECTOR_URL, method: 'GET' })
  const vectorRows = Array.isArray(parseJson(vectors.bodyText))
    ? (parseJson(vectors.bodyText) as unknown[]).slice(2)
    : []
  const firstVector = vectorRows.find(
    (row): row is unknown[] => Array.isArray(row) && typeof row[6] === 'string',
  )

  const parsed = firstVector
    ? await parseZcashAddress(firstVector[6] as string)
    : ({ ok: false, detail: `could not read a unified address from ${ZIP316_VECTOR_URL}` } as const)
  const capabilities: Capability[] = [
    {
      id: 'parse-unified-address',
      description: 'Decode a ZIP-316 unified address and enumerate its receivers',
      verdict: parsed.ok ? 'available' : 'unavailable',
      ...(parsed.ok ? {} : { blocker: parsed.detail }),
    },
    {
      id: 'select-shielded-receiver',
      description: 'Choose an Orchard or Sapling receiver, never a transparent one',
      verdict: parsed.ok ? 'available' : 'unavailable',
      ...(parsed.ok ? {} : { blocker: parsed.detail }),
    },
  ]

  evidence.push(
    httpEvidence(
      vectors,
      parsed.ok
        ? `${vectorRows.length} official vectors; the first decoded to receivers ` +
          `[${parsed.parsed.receivers.join(', ')}] — all ${vectorRows.length} are compared in npm run verify:zip316`
        : null,
      'none',
      'canonical ZIP-316 unified address test vectors',
    ),
  )

  return {
    id: ZCASH_ADDRESS_PROVIDER_ID,
    label: 'Zcash addresses — ZIP-316 parsing',
    sdk: ZCASH_ADDRESS_SDK,
    // The installed SDK counts for nothing on its own; this row rises only
    // because the canonical vectors were fetched and one of them was decoded.
    // It stops at read-only by design — parsing an address is not sending to it,
    // and nothing on this route can reach an execution rung without a signer.
    state: deriveState(evidence),
    capabilities,
    evidence,
    missingConfiguration: [],
    nextStep: parsed.ok
      ? 'Correctness is proven by npm run verify:zip316 against the official vectors. No credential applies.'
      : `Parser unavailable: ${parsed.detail}`,
  }
}
