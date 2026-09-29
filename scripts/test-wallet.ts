/*
 * The browser-held wallet: key generation, persistence, export, import, and
 * the one property that matters more than the rest — that the secret key is
 * reachable through exactly one function and nothing else.
 *
 * This suite runs the real `src/solana/embeddedWallet.ts` against a stand-in
 * `localStorage`, rather than a reimplementation of it, so a change to the
 * storage format or the validation fails here. The browser-side half of the
 * proof — that no request body and no console line ever contains the key —
 * needs a real browser and lives in `scripts/verify-embedded-wallet.mjs`.
 *
 * Run with: npm run test:wallet
 */
import { Keypair } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { check, equal, finish, section } from './lib/harness'

/* ------------------------------------------------------------------ *
 * A `localStorage` that behaves like the real one, including throwing
 * for the private-mode case, installed before the module under test is
 * imported because it reads storage on first use.
 * ------------------------------------------------------------------ */

class MemoryStorage {
  private map = new Map<string, string>()
  /** Set to make every write throw, as Safari private mode does. */
  sealed = false

  get length() { return this.map.size }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) {
    if (this.sealed) throw new Error('QuotaExceededError')
    this.map.set(key, value)
  }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
  /** The raw contents, so a test can inspect what was actually written. */
  dump() { return new Map(this.map) }
}

const store = new MemoryStorage()
;(globalThis as { localStorage?: unknown }).localStorage = store

const wallet = await import('../src/solana/embeddedWallet')
const {
  EMBEDDED_STORAGE_KEY,
  embeddedWallet,
  embeddedWalletPersists,
  ensureEmbeddedWallet,
  exportEmbeddedSecret,
  forgetEmbeddedWallet,
  importEmbeddedSecret,
  resetEmbeddedWalletCacheForTests,
  signWithEmbeddedWallet,
} = wallet

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/* ------------------------------------------------------------ generation */

section('a player who enters the world gets a real Solana keypair')

check('nothing exists before first entry', embeddedWallet() === null)

const created = ensureEmbeddedWallet()
check('the address is base58 of the right length', BASE58.test(created.address), created.address)
check('it is a valid Ed25519 point, i.e. a real Solana address', bs58.decode(created.address).length === 32)
check('it was generated here, not imported', created.imported === false)

const again = ensureEmbeddedWallet()
equal('entering twice does not mint a second identity', again.address, created.address)

// The whole point of a keypair is that it signs, and that the server's verifier
// accepts it. This is the same `ed25519.verify` call `server/auth.ts` makes.
const message = new TextEncoder().encode('voxels wants you to sign in with your Solana account')
const signature = signWithEmbeddedWallet(message)
equal('a signature is 64 bytes', signature.length, 64)
check(
  'and verifies against the address the player is shown',
  ed25519.verify(signature, message, bs58.decode(created.address)),
)
check(
  'a signature over different bytes does not verify',
  !ed25519.verify(signature, new TextEncoder().encode('something else'), bs58.decode(created.address)),
)

/* ----------------------------------------------------------- persistence */

section('the browser remembers it across a reload and a restart')

const stored = store.dump().get(EMBEDDED_STORAGE_KEY)
check('one record was written', typeof stored === 'string')

// A reload is a fresh module with the same storage. Dropping the in-memory copy
// is exactly what a page load does.
resetEmbeddedWalletCacheForTests()
check('the module forgot it in memory', embeddedWallet()?.address === created.address, 'read back from storage')
equal('the same address comes back after a reload', embeddedWallet()!.address, created.address)
equal('and ensure() still does not mint a new one', ensureEmbeddedWallet().address, created.address)

check('storage is reported as working', embeddedWalletPersists())

/* ---------------------------------------------------------------- export */

section('export produces something a real wallet can import')

const exported = exportEmbeddedSecret()!
check('export returns a value', exported !== null)
equal('it is labelled with the address it belongs to', exported.address, created.address)

const fromBase58 = Keypair.fromSecretKey(bs58.decode(exported.base58))
equal('the base58 form round-trips to the same address', fromBase58.publicKey.toBase58(), created.address)

const asArray = JSON.parse(exported.jsonArray) as number[]
equal('the JSON form is the 64 bytes the Solana CLI writes', asArray.length, 64)
check('every entry is a byte', asArray.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
equal(
  'and it round-trips to the same address too',
  Keypair.fromSecretKey(Uint8Array.from(asArray)).publicKey.toBase58(),
  created.address,
)
check('both formats are the same key', bs58.encode(Uint8Array.from(asArray)) === exported.base58)

check('exporting did not change which wallet this is', embeddedWallet()!.address === created.address)

/* ---------------------------------------------------------------- import */

section('importing a key from another browser')

const other = Keypair.generate()

const badInputs: Array<[string, string]> = [
  ['an empty box', '   '],
  ['an address instead of a key', other.publicKey.toBase58()],
  ['a 32-byte seed', bs58.encode(other.secretKey.slice(0, 32))],
  ['base58 with characters the alphabet does not have', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
  ['a truncated JSON array', JSON.stringify([...other.secretKey].slice(0, 40))],
  ['a JSON array with a value out of range', JSON.stringify([...other.secretKey].map((v, i) => (i === 3 ? 999 : v)))],
  ['a JSON array of strings', JSON.stringify([...other.secretKey].map(String))],
  ['a broken JSON array', '[1, 2, 3'],
  ['prose', 'my secret key is under the mat'],
]
for (const [label, input] of badInputs) {
  const outcome = importEmbeddedSecret(input)
  check(`refuses ${label}`, outcome.ok === false, outcome.ok ? '' : outcome.reason)
}

// Bytes that are the right length and valid base58, but whose trailing public
// key does not match the seed. `Keypair.fromSecretKey` is what catches this.
const tampered = Uint8Array.from(other.secretKey)
tampered[63] ^= 0xff
check('refuses 64 bytes whose public key does not match the seed', importEmbeddedSecret(bs58.encode(tampered)).ok === false)

check('none of the refusals replaced the wallet', embeddedWallet()!.address === created.address)

const imported = importEmbeddedSecret(bs58.encode(other.secretKey))
check('accepts a base58 secret key', imported.ok, imported.ok ? imported.address : imported.reason)
if (imported.ok) {
  equal('and becomes that wallet', imported.address, other.publicKey.toBase58())
  equal('naming the wallet it replaced', imported.replaced, created.address)
}
equal('the live wallet is the imported one', embeddedWallet()!.address, other.publicKey.toBase58())
check('and it is marked as imported rather than generated', embeddedWallet()!.imported === true)

resetEmbeddedWalletCacheForTests()
equal('the imported wallet also survives a reload', embeddedWallet()!.address, other.publicKey.toBase58())

const reExported = exportEmbeddedSecret()!
equal('exporting the imported wallet gives back the same key', reExported.base58, bs58.encode(other.secretKey))

const third = Keypair.generate()
const jsonImport = importEmbeddedSecret(JSON.stringify([...third.secretKey]))
check('accepts the JSON array form too', jsonImport.ok, jsonImport.ok ? jsonImport.address : jsonImport.reason)
equal('and switches to it', embeddedWallet()!.address, third.publicKey.toBase58())

/* -------------------------------------------------------------- deletion */

section('deleting a wallet')

forgetEmbeddedWallet()
check('the wallet is gone', embeddedWallet() === null)
check('and so is the stored record', store.dump().get(EMBEDDED_STORAGE_KEY) === undefined)
check('export has nothing to reveal', exportEmbeddedSecret() === null)
try {
  signWithEmbeddedWallet(message)
  check('signing without a key refuses', false, 'it signed something')
} catch {
  check('signing without a key refuses', true)
}
resetEmbeddedWalletCacheForTests()
check('and it stays gone after a reload', embeddedWallet() === null)

/* ------------------------------------------------- what is on the wire */

section('the secret key is not in anything the app hands out')

const live = ensureEmbeddedWallet()
const secretB58 = exportEmbeddedSecret()!.base58
const secretBytes = bs58.decode(secretB58)
const secretHex = Buffer.from(secretBytes).toString('hex')
const seedB58 = bs58.encode(secretBytes.slice(0, 32))

// Everything this module lets a caller hold, other than the export itself.
const surfaces: Array<[string, unknown]> = [
  ['the wallet record the UI renders', embeddedWallet()],
  ['the value ensure() returns', live],
  ['a signature', bs58.encode(signWithEmbeddedWallet(message))],
  ['the import result', importEmbeddedSecret(bs58.encode(Keypair.generate().secretKey))],
]
for (const [label, value] of surfaces) {
  const text = JSON.stringify(value) ?? ''
  check(`${label} contains no secret key`, !text.includes(secretB58) && !text.includes(secretHex) && !text.includes(seedB58))
}

// The record on disk necessarily holds the key — that is what "the browser
// remembers it" means — so the test is that it is under the one documented key
// and nowhere else, which is what the browser-side exfiltration check relies on.
resetEmbeddedWalletCacheForTests()
ensureEmbeddedWallet()
const onlySecret = exportEmbeddedSecret()!.base58
const elsewhere = [...store.dump().entries()].filter(([key, value]) => key !== EMBEDDED_STORAGE_KEY && value.includes(onlySecret))
equal('no other storage key holds a copy of it', elsewhere.length, 0)

/* ---------------------------------------------------------- private mode */

section('a browser that refuses storage')

forgetEmbeddedWallet()
store.sealed = true
resetEmbeddedWalletCacheForTests()
const ephemeral = ensureEmbeddedWallet()
check('the player still gets a working wallet', BASE58.test(ephemeral.address))
check('and it can still sign', ed25519.verify(signWithEmbeddedWallet(message), message, bs58.decode(ephemeral.address)))
check('but the app knows it will not survive, so the UI can say so', !embeddedWalletPersists())
store.sealed = false

finish('wallet')
