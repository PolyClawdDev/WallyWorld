/* ------------------------------------------------------------------ *
 * The Zcash wallet the courier needs, and why it does not exist (§6).
 *
 * This file contains no signer. It contains the interface a signer would have
 * to satisfy, and a sourced account of what is actually obtainable — because
 * the honest deliverable here is a precise blocker, not a stub that looks like
 * progress.
 *
 * Checked today against each project's own words:
 *
 *   - **zallet** — the closest thing to a wallet service. GitHub releases only:
 *     v0.1.0-beta.3. It is NOT on npm, and the `zallet` crate on crates.io is a
 *     0.0.0 placeholder that is not the wallet. Its README: "Current phase:
 *     Beta release. Breaking changes may occur at any time, requiring you to
 *     delete and recreate your Zallet wallet" and "Many JSON-RPC methods that
 *     will be ported from zcashd have not yet been implemented."
 *   - **zcash-devtool** — self-describes with "DO NOT USE THIS IN PRODUCTION!!!"
 *     and "This app has not been written with security in mind." Excellent as a
 *     testnet harness; disqualified as custody by its own authors.
 *   - **librustzcash** — actively maintained, and its security warning says
 *     "These libraries are under development and have not been fully reviewed."
 *     They are libraries, not a wallet: sync, reorg handling, backup, restore
 *     and a Rust-to-Node boundary would all be ours to build.
 *   - **zcashd** — archived. Not an option for new work.
 *   - **lightwalletd / Zebra** — a chain-data server and a consensus node. A
 *     blockchain data server is NOT a signing wallet, and conflating them is the
 *     specific mistake §6 warns about.
 *   - **@ledgerhq/zcash-utils 2.5.0** — a genuinely maintained NAPI binding to
 *     librustzcash, published this month, and the most production-shaped thing
 *     on npm. It still does not close the gap: its real signing path is a
 *     Ledger hardware device (`testSignPczt` is explicitly a test helper), so it
 *     replaces "we hold keys" with "an operator physically confirms every send",
 *     which is not an unattended courier.
 *
 * Nothing in this repository can sign a Zcash transaction. That is stated as a
 * value — `SIGNER_STATUS` — so the operator console reports it rather than
 * having to infer it.
 * ------------------------------------------------------------------ */

import type { SpendPermit, ProposedAction } from '../policy'
import { assertPermitCovers } from '../policy'
import { deriveState, type Capability, type Evidence, type IntegrationReport } from './types'

export const ZCASH_WALLET_PROVIDER_ID = 'zcash-wallet'

/* ------------------------------------------------------------------ *
 * The interface a courier wallet would have to satisfy
 *
 * Written out in full because it is the actual deliverable: it names every
 * operation, and each one is a thing some candidate backend does not do.
 * ------------------------------------------------------------------ */

export type ZcashPool = 'transparent' | 'sapling' | 'orchard'

export interface SyncStatus {
  readonly syncedHeight: number
  readonly chainTipHeight: number
  readonly fullyScanned: boolean
  /** Scanning must resume from a checkpoint after a restart, not start over. */
  readonly resumedFromCheckpoint: boolean
}

export interface TransparentReceipt {
  readonly txid: string
  readonly address: string
  readonly zatoshis: bigint
  readonly confirmations: number
  readonly minedHeight: number
}

export interface ShieldingOperation {
  readonly operationId: string
  readonly txid: string | null
  readonly sourceAddress: string
  readonly zatoshis: bigint
  readonly targetPool: 'sapling' | 'orchard'
  readonly confirmations: number
}

export interface ShieldedSend {
  readonly operationId: string
  readonly txid: string | null
  readonly recipient: string
  readonly zatoshis: bigint
  readonly pool: 'sapling' | 'orchard'
  readonly confirmations: number
}

/**
 * The wallet the courier route needs. No implementation exists.
 *
 * Confirmation thresholds are not a parameter of this interface by accident:
 * ZIP 315 recommends 10 confirmations for untrusted TXOs and 3 for trusted, and
 * funds arriving from a conversion provider are untrusted. That sets the real
 * latency floor for the shielding stage, and an implementation that picks its
 * own number is not implementing this interface.
 */
export interface ZcashCourierWallet {
  /** Scan to the chain tip. Must be resumable and must survive a restart. */
  sync(options: { timeoutMs: number }): Promise<SyncStatus>

  /**
   * One transparent receive address per job.
   *
   * Per-job rather than reused because ZIP 315 says wallets SHOULD NOT
   * auto-shield from multiple transparent addresses in the same transaction:
   * doing so links those addresses to each other permanently.
   */
  allocateJobReceiveAddress(jobId: string): Promise<{ address: string; derivationIndex: number }>

  /** Detect an incoming transparent payment to a job's own address. */
  detectTransparentReceipt(input: {
    address: string
    minZatoshis: bigint
  }): Promise<TransparentReceipt | null>

  /** Shield one transparent address on its own, never batched with others. */
  shield(input: {
    permit: SpendPermit
    action: ProposedAction
    sourceAddress: string
    targetPool: 'sapling' | 'orchard'
    /** ZIP 315: 10 for untrusted TXOs, which a provider payout is. */
    minConfirmations: number
  }): Promise<ShieldingOperation>

  /** Spend from a shielded pool to a shielded receiver. */
  sendShielded(input: {
    permit: SpendPermit
    action: ProposedAction
    recipient: string
    zatoshis: bigint
    /** ZIP 315: 3 for trusted TXOs, which our own change notes are. */
    minConfirmations: number
  }): Promise<ShieldedSend>

  /** Track an operation to a terminal state, preserving "unknown" as distinct. */
  trackConfirmations(operationId: string): Promise<{
    state: 'pending' | 'confirmed' | 'failed' | 'unknown'
    confirmations: number
    txid: string | null
  }>

  /**
   * Re-establish every in-flight operation after a restart.
   *
   * The hard requirement, and the one a prototype tool will not give you: a
   * process that dies mid-shield must come back knowing what it was doing, or a
   * customer's funds sit in a transparent address nobody is watching.
   */
  recoverAfterRestart(): Promise<{
    inFlight: readonly string[]
    rescanRequiredFromHeight: number | null
  }>
}

/* ------------------------------------------------------------------ *
 * What is actually available
 * ------------------------------------------------------------------ */

export interface BackendAssessment {
  readonly id: string
  readonly version: string
  readonly distribution: string
  readonly maintained: boolean
  /** The project's own words about production readiness. */
  readonly selfDeclaration: string
  readonly isSigner: boolean
  readonly verdict: 'unavailable' | 'testnet-only' | 'partially-available'
  readonly gap: string
  /**
   * Where the self-declaration above was read. Written out per backend and never
   * built from the id: a guessed URL renders as a citation and is not one.
   */
  readonly sourceUrl: string
}

export const WALLET_BACKENDS: readonly BackendAssessment[] = [
  {
    id: 'zallet',
    version: 'v0.1.0-beta.3',
    distribution: 'GitHub releases only. NOT on npm. The crates.io `zallet` crate is a 0.0.0 placeholder and is not the wallet.',
    maintained: true,
    selfDeclaration:
      'Current phase: Beta release. Breaking changes may occur at any time, requiring you to delete and ' +
      'recreate your Zallet wallet. Many JSON-RPC methods that will be ported from zcashd have not yet ' +
      'been implemented.',
    isSigner: true,
    verdict: 'partially-available',
    gap:
      'The service shape is right and it can sign, but the ported RPC surface is incomplete, so each ' +
      'operation this route needs — sync status, receipt detection, shielding, shielded spend, rescan — ' +
      'has to be confirmed individually against beta.3 with a running node. "Delete and recreate your ' +
      'wallet" between betas is a data-loss risk for a wallet holding customer funds mid-job.',
    sourceUrl: 'https://github.com/zcash/zallet',
  },
  {
    id: 'librustzcash',
    version: 'zcash_client_backend 0.24.0, zcash_keys 0.16.1, zcash_primitives 0.30.1, orchard 0.15.5',
    distribution: 'crates.io. Rust, so it needs a Rust-to-Node boundary this repository does not have.',
    maintained: true,
    selfDeclaration: 'These libraries are under development and have not been fully reviewed.',
    isSigner: true,
    verdict: 'partially-available',
    gap:
      'Every primitive exists and none of the wallet does. We would own seed generation and encryption, ' +
      'chain sync and checkpointing, reorg handling, a confirmation policy, backup and restore, and the ' +
      'FFI boundary. "Not fully reviewed" is about cryptographic code that would hold customer funds.',
    sourceUrl: 'https://github.com/zcash/librustzcash',
  },
  {
    id: 'zcash-devtool',
    version: 'no releases; `cargo run` from a git checkout',
    distribution: 'Not on crates.io at all.',
    maintained: true,
    selfDeclaration: 'DO NOT USE THIS IN PRODUCTION!!! This app has not been written with security in mind.',
    isSigner: true,
    verdict: 'testnet-only',
    gap:
      'Genuinely useful as a testnet harness — it can init a testnet wallet, sync, and restore from a ' +
      'mnemonic, which makes the shielding stages testable for free. Its authors disqualify it from ' +
      'custody in capital letters, so it cannot be the production signer.',
    sourceUrl: 'https://github.com/zcash/zcash-devtool',
  },
  {
    id: '@ledgerhq/zcash-utils',
    version: '2.5.0',
    distribution: 'npm. A NAPI binding to librustzcash with prebuilt binaries, published this month.',
    maintained: true,
    selfDeclaration:
      'The UFVK must be obtained from the Ledger device — never derive it from a seed phrase directly in ' +
      'this layer.',
    isSigner: false,
    verdict: 'partially-available',
    gap:
      'Sync, transaction building and PCZT handling are all there and production-shaped. The signing ' +
      'authority is a Ledger device: the only key-derivation entry point in the package is named ' +
      '`testDeriveKeys`/`testSignPczt` and is a test helper. That makes it a hardware-custody wallet ' +
      'needing physical confirmation per send, which an unattended courier job cannot use. It also ' +
      'exposes no address decoder, so it cannot serve the ZIP-316 parsing job either.',
    sourceUrl: 'https://www.npmjs.com/package/@ledgerhq/zcash-utils',
  },
  {
    id: 'zcashd',
    version: 'v6.20.0, repository archived',
    distribution: 'Archived on GitHub. Zallet describes the zcashd wallet as deprecated.',
    maintained: false,
    selfDeclaration: 'Archived.',
    isSigner: true,
    verdict: 'unavailable',
    gap: 'Ruled out. Not an option for new work.',
    sourceUrl: 'https://github.com/zcash/zcash',
  },
  {
    id: 'lightwalletd / zebra',
    version: 'lightwalletd v0.5.4, zebra v6.4.2',
    distribution: 'Both actively maintained and both production-ready as what they are.',
    maintained: true,
    selfDeclaration: 'A bandwidth-efficient blockchain interface, and a consensus node.',
    isSigner: false,
    verdict: 'unavailable',
    gap:
      'Neither is a wallet and neither holds a spending key. A chain-data server is not a signer. They ' +
      'are a dependency of any option above, not an alternative to one.',
    sourceUrl: 'https://github.com/zcash/lightwalletd',
  },
]

/** ZIP 315 confirmation policy. Not an invented number. */
export const CONFIRMATION_POLICY = {
  untrustedTxos: 10,
  trustedTxos: 3,
  source: 'https://zips.z.cash/zip-0315',
  note:
    'Funds arriving from a conversion provider are untrusted, so the shielding stage cannot start for ' +
    '10 confirmations. That is the real latency floor for this route.',
} as const

/**
 * The single sentence an operator needs.
 *
 * Held as a constant so the console, the preflight, and any report all quote
 * the same blocker rather than three paraphrases that could drift apart.
 */
export const SIGNER_STATUS = {
  signerExists: false as const,
  blocker:
    'No Zcash signer exists in this project and none can be stood up from npm. The shielded send needs a ' +
    'mainnet wallet holding spending keys for customer funds, built on components their own authors call ' +
    'beta, unreviewed, or explicitly not for production — on a route whose conversion leg has no test ' +
    'network. Standing one up means: a synced node or lightwalletd endpoint, a 24-word BIP-39 seed ' +
    'generated and encrypted outside this repository, a wallet database with backup and restore, a ' +
    'checkpointed scanner that survives restart, the ZIP 315 confirmation policy above, one transparent ' +
    'receive address per job, and a signing process isolated from both the web server and the language ' +
    'model. Accepting custody of customer ZEC is a decision that precedes all of it.',
  privacyDisclosure:
    'Even fully built, only the final hop is private. The conversion leg is public, and ZIP 315 notes a ' +
    'shielding transaction is permanently linked to the transparent address it spends from. Claiming ' +
    'end-to-end privacy for this route would be false.',
} as const

/* ------------------------------------------------------------------ *
 * The refusal
 * ------------------------------------------------------------------ */

export class NoZcashSignerError extends Error {}

/**
 * Every signing entry point, in one place, refusing identically.
 *
 * The permit is checked first on purpose. It would be simpler to throw
 * immediately, but then an unimplemented stage would be a way to reach a
 * money-moving call site without a policy decision, and the day it gets
 * implemented that omission travels with it.
 */
export const unavailableSigner: Pick<ZcashCourierWallet, 'shield' | 'sendShielded'> = {
  async shield(input) {
    assertPermitCovers(input.permit, input.action, Date.now())
    throw new NoZcashSignerError(SIGNER_STATUS.blocker)
  },
  async sendShielded(input) {
    assertPermitCovers(input.permit, input.action, Date.now())
    throw new NoZcashSignerError(SIGNER_STATUS.blocker)
  },
}

/* ------------------------------------------------------------------ readiness */

export function probeZcashWallet(nowMs: number): IntegrationReport {
  const evidence: Evidence[] = WALLET_BACKENDS.map(backend => ({
    kind: 'doc' as const,
    observedAtMs: nowMs,
    environment: 'none' as const,
    summary: `${backend.id} ${backend.version} — ${backend.verdict}`,
    url: backend.sourceUrl,
    status: null,
    quote: backend.selfDeclaration,
  }))

  evidence.push({
    kind: 'doc',
    observedAtMs: nowMs,
    environment: 'none',
    summary: 'confirmation policy the shielding stage must obey',
    url: CONFIRMATION_POLICY.source,
    status: 200,
    quote: `${CONFIRMATION_POLICY.untrustedTxos} confirmations for untrusted TXOs, ${CONFIRMATION_POLICY.trustedTxos} for trusted.`,
  })

  const capabilities: Capability[] = [
    { id: 'sync', description: 'Scan the chain and resume from a checkpoint', verdict: 'unavailable', blocker: SIGNER_STATUS.blocker },
    { id: 'receipt-detection', description: 'Detect a transparent payout arriving for a job', verdict: 'unavailable', blocker: SIGNER_STATUS.blocker },
    { id: 'shield', description: 'Shield one transparent address into a shielded pool', verdict: 'unavailable', blocker: SIGNER_STATUS.blocker },
    { id: 'shielded-spend', description: 'Spend from a shielded pool to a shielded receiver', verdict: 'unavailable', blocker: SIGNER_STATUS.blocker },
    { id: 'restart-recovery', description: 'Re-establish in-flight operations after a restart', verdict: 'unavailable', blocker: SIGNER_STATUS.blocker },
  ]

  return {
    id: ZCASH_WALLET_PROVIDER_ID,
    label: 'Zcash wallet — shielding and shielded spend',
    // No SDK is claimed. Listing one here would imply a signer is installed.
    sdk: null,
    state: deriveState(evidence),
    capabilities,
    evidence,
    missingConfiguration: [
      'ZCASH_LIGHTWALLETD_URL (a chain-data endpoint, not a signer)',
      'a wallet backend decision (zallet beta.3 or librustzcash)',
      'a custody decision, which is not a variable',
    ],
    nextStep:
      'Blocked on a custody decision, not on configuration. Zcash testnet can exercise stages 6 to 9 for ' +
      'free via zcash-devtool once a backend is chosen; the conversion leg in the middle still has no ' +
      'test network.',
  }
}
