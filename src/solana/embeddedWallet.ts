/* ------------------------------------------------------------------ *
 * The embedded wallet: a real Solana keypair, generated in the player's
 * browser, kept by the browser, exportable by the player.
 *
 * WHY THIS EXISTS
 *   Every player who walks into the world needs a signing key, because
 *   the account system proves ownership with an ed25519 signature over a
 *   server-issued challenge and nothing else. This is that key, for every
 *   player, with no extension to install and nothing to connect: 32 bytes
 *   of seed, an Ed25519 public key, a base58 Solana address that any
 *   wallet will recognise.
 *
 * WHAT IT CANNOT DO
 *   Sign a transaction. There is no `signTransaction` here and there must
 *   never be one: this key lives in `localStorage`, so a signer would turn
 *   any XSS on this origin into stolen funds. Message signing is the whole
 *   capability, and the identity flow is the whole requirement — a gold
 *   payout is signed and sent by the treasury, with the player's signature
 *   proving only that they control the destination address.
 *
 * WHAT IT IS NOT
 *   It is not hardware-grade and it is not custodial-grade. A key sitting
 *   in browser storage can be read by any script that achieves XSS on
 *   this origin, and by anyone with access to the machine and the browser
 *   profile. That is the honest ceiling, it is stated in the UI at
 *   creation and again at export, and it is why this wallet defaults to
 *   devnet. It is appropriate for a game balance and for small amounts.
 *   It is not appropriate for savings.
 *
 * WHERE THE KEY LIVES, AND WHY THERE
 *   `localStorage`, under one key, as base58.
 *
 *   The requirement is "the browser has to remember it" across reloads
 *   *and* restarts, which rules out `sessionStorage` and in-memory state.
 *   That leaves `localStorage` and IndexedDB. IndexedDB is asynchronous
 *   and more code for no security gain: both are origin-scoped, both are
 *   readable by injected script, and neither is encrypted at rest.
 *
 *   The one option that *would* be stronger is a non-extractable
 *   WebCrypto key, which script can use but cannot read. It is ruled out
 *   by the product: the player must be able to export the key and carry
 *   it to another wallet, and a key you can export is by definition a key
 *   that script can read. That tradeoff is the player's to make and it is
 *   spelled out rather than hidden.
 *
 * WHAT NEVER LEAVES
 *   The secret key is decoded into a module-private variable and handed
 *   out through exactly one function, `exportEmbeddedSecret`, which the UI
 *   calls only from a deliberate click. It is never put into React state,
 *   never logged, never sent in a request. What does leave this module is
 *   the public address and, on request, a signature.
 *
 * CRYPTO
 *   No primitive is implemented here. Keys come from `@solana/web3.js`'s
 *   `Keypair`, signatures from `@noble/curves`' audited ed25519, base58
 *   from `bs58` — all three already dependencies of this project and all
 *   three also used by the server that verifies the result.
 *
 * MNEMONICS
 *   There is deliberately no seed phrase. This key is random, not derived
 *   through BIP39/BIP44, so showing twelve words would be showing
 *   something that does not restore this account. Export is the raw
 *   secret key, in the two formats real wallets actually import.
 * ------------------------------------------------------------------ */

import { Keypair } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'

export const EMBEDDED_STORAGE_KEY = 'wally-embedded-wallet-v1'

/** A Solana secret key is the 32-byte seed followed by the 32-byte public key. */
const SECRET_KEY_BYTES = 64
const SEED_BYTES = 32

export type EmbeddedWalletInfo = {
  address: string
  createdAtMs: number
  /** True when this key was pasted in rather than generated here. */
  imported: boolean
}

type StoredWallet = { v: 1; secretKey: string; address: string; createdAtMs: number; imported?: boolean }

/* ------------------------------------------------------------------ *
 * Storage access, kept behind one accessor so a private-mode browser
 * (where `localStorage` throws on touch) degrades to a session-only
 * wallet instead of crashing the world on load.
 * ------------------------------------------------------------------ */

function storage(): Storage | null {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage
    if (!store) return null
    return store
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * In-memory state. `secret` is the only place the key material exists
 * outside storage, and nothing outside this module holds a reference.
 * ------------------------------------------------------------------ */

let secret: Uint8Array | null = null
let info: EmbeddedWalletInfo | null = null
let loaded = false

const listeners = new Set<() => void>()

function announce() {
  listeners.forEach(listener => listener())
}

export function subscribeEmbeddedWallet(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Rebuilds a keypair from stored bytes and checks it against itself.
 *
 * `Keypair.fromSecretKey` verifies that the trailing public key really is the
 * one the seed produces, so a truncated or edited storage entry fails here
 * rather than producing an address whose signatures nobody can verify.
 */
function keypairFromSecret(bytes: Uint8Array): Keypair {
  if (bytes.length !== SECRET_KEY_BYTES) throw new Error(`a Solana secret key is ${SECRET_KEY_BYTES} bytes, this one is ${bytes.length}`)
  return Keypair.fromSecretKey(bytes)
}

function persist(bytes: Uint8Array, address: string, createdAtMs: number, imported: boolean) {
  const store = storage()
  if (!store) return
  const record: StoredWallet = { v: 1, secretKey: bs58.encode(bytes), address, createdAtMs, imported }
  try {
    store.setItem(EMBEDDED_STORAGE_KEY, JSON.stringify(record))
  } catch {
    /* quota or private mode: the wallet lives for this tab only, and
       `storageWorks()` tells the UI to say so rather than pretend. */
  }
}

/** Reads storage once per page. A corrupt entry is discarded, not repaired. */
function loadFromStorage(): void {
  loaded = true
  const store = storage()
  if (!store) return
  let raw: string | null
  try {
    raw = store.getItem(EMBEDDED_STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as Partial<StoredWallet>
    if (parsed.v !== 1 || typeof parsed.secretKey !== 'string') throw new Error('unrecognised record')
    const bytes = bs58.decode(parsed.secretKey)
    const keypair = keypairFromSecret(bytes)
    secret = bytes
    info = {
      // Derived, never read from the record: the stored address is a
      // convenience for tooling and is not allowed to decide anything.
      address: keypair.publicKey.toBase58(),
      createdAtMs: typeof parsed.createdAtMs === 'number' ? parsed.createdAtMs : Date.now(),
      imported: parsed.imported === true,
    }
  } catch {
    secret = null
    info = null
  }
}

function ensureLoaded() {
  if (!loaded) loadFromStorage()
}

/* ------------------------------------------------------------------ reads */

/** The wallet this browser already has, without creating one. */
export function embeddedWallet(): EmbeddedWalletInfo | null {
  ensureLoaded()
  return info
}

/**
 * True when the key will survive a restart.
 *
 * False in a browser that refuses storage, where the wallet is real but
 * disappears with the tab — which the UI has to say, because "we remember it"
 * would then be a lie.
 */
export function embeddedWalletPersists(): boolean {
  const store = storage()
  if (!store) return false
  try {
    const probe = `${EMBEDDED_STORAGE_KEY}-probe`
    store.setItem(probe, '1')
    store.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- writes */

/**
 * The wallet for this browser, generated on first entry.
 *
 * `Keypair.generate()` draws from the platform CSPRNG. Calling this twice
 * returns the same wallet: a second key would mean a second identity and a
 * player who silently loses the first one.
 */
export function ensureEmbeddedWallet(now = Date.now()): EmbeddedWalletInfo {
  ensureLoaded()
  if (info && secret) return info

  const keypair = Keypair.generate()
  secret = keypair.secretKey
  info = { address: keypair.publicKey.toBase58(), createdAtMs: now, imported: false }
  persist(secret, info.address, info.createdAtMs, false)
  announce()
  return info
}

export type ImportOutcome = { ok: true; address: string; replaced: string | null } | { ok: false; reason: string }

/**
 * Accepts a key exported from somewhere else, in either format a real wallet
 * produces: base58, or the 64-number JSON array that `solana-keygen` writes.
 *
 * Every failure names what was wrong with the input and nothing about the
 * bytes themselves.
 */
export function importEmbeddedSecret(input: string, now = Date.now()): ImportOutcome {
  ensureLoaded()
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: 'Paste a secret key first.' }

  let bytes: Uint8Array
  if (trimmed.startsWith('[')) {
    let numbers: unknown
    try {
      numbers = JSON.parse(trimmed)
    } catch {
      return { ok: false, reason: 'That looks like a JSON array but it will not parse. Copy the whole thing, including both brackets.' }
    }
    if (!Array.isArray(numbers)) return { ok: false, reason: 'A JSON key file is an array of numbers.' }
    if (numbers.length !== SECRET_KEY_BYTES) {
      return { ok: false, reason: `A Solana JSON key file holds ${SECRET_KEY_BYTES} numbers; this one holds ${numbers.length}.` }
    }
    if (!numbers.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return { ok: false, reason: 'Every entry in a JSON key file is a whole number from 0 to 255.' }
    }
    bytes = Uint8Array.from(numbers as number[])
  } else {
    try {
      bytes = bs58.decode(trimmed)
    } catch {
      return { ok: false, reason: 'That is not valid base58. A base58 secret key has no 0, O, I or l in it, and no spaces.' }
    }
    if (bytes.length === SEED_BYTES) {
      return {
        ok: false,
        reason: 'That is a 32-byte seed, not a full secret key. Export the 64-byte secret key from your other wallet, or the JSON array form.',
      }
    }
    if (bytes.length !== SECRET_KEY_BYTES) {
      return { ok: false, reason: `A secret key decodes to ${SECRET_KEY_BYTES} bytes; this decodes to ${bytes.length}. It may be an address rather than a key.` }
    }
  }

  let keypair: Keypair
  try {
    keypair = keypairFromSecret(bytes)
  } catch {
    return { ok: false, reason: 'Those bytes are not a valid Solana keypair: the public key in them does not match the seed.' }
  }

  const replaced = info && info.address !== keypair.publicKey.toBase58() ? info.address : null
  secret = bytes
  info = { address: keypair.publicKey.toBase58(), createdAtMs: now, imported: true }
  persist(secret, info.address, info.createdAtMs, true)
  announce()
  return { ok: true, address: info.address, replaced }
}

/**
 * Deletes the key from this browser.
 *
 * Irreversible unless the player exported it first, which is why the UI asks
 * twice and says so.
 */
export function forgetEmbeddedWallet(): void {
  ensureLoaded()
  secret = null
  info = null
  const store = storage()
  try {
    store?.removeItem(EMBEDDED_STORAGE_KEY)
  } catch {
    /* nothing to remove */
  }
  announce()
}

/* --------------------------------------------------------------- export */

export type ExportedSecret = {
  address: string
  /** What a wallet's "import private key" field expects. */
  base58: string
  /** What `solana-keygen`/the CLI reads: the 64-byte array, as JSON text. */
  jsonArray: string
}

/**
 * Reveals the secret key.
 *
 * Called from one place — a button the player pressed after being told what a
 * revealed key means. The value is returned, not stored, not logged, and not
 * put into component state beyond the open dialog.
 */
export function exportEmbeddedSecret(): ExportedSecret | null {
  ensureLoaded()
  if (!secret || !info) return null
  return {
    address: info.address,
    base58: bs58.encode(secret),
    jsonArray: JSON.stringify(Array.from(secret)),
  }
}

/* -------------------------------------------------------------- signing */

/**
 * Signs arbitrary bytes with the embedded key.
 *
 * Used for one thing today: the account-link challenge, which is plain UTF-8
 * text issued by this server and cannot move funds. There is no transaction
 * signer here, deliberately — nothing in this build spends from the embedded
 * wallet, so nothing in this build needs one.
 */
export function signWithEmbeddedWallet(message: Uint8Array): Uint8Array {
  ensureLoaded()
  if (!secret) throw new Error('no embedded wallet in this browser')
  return ed25519.sign(message, secret.slice(0, SEED_BYTES))
}

/** Test seam: drops the in-memory copy so the next read comes from storage. */
export function resetEmbeddedWalletCacheForTests(): void {
  secret = null
  info = null
  loaded = false
}
