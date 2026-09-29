/* ------------------------------------------------------------------ *
 * TEST FIXTURES ONLY.
 *
 * Generates throwaway devnet keypairs so `verify-solana.ts` can produce
 * real ed25519 signatures and stand in for a player's wallet. Nothing here
 * is, or may become, a user wallet:
 *
 *   - it runs only from scripts/, never from src/ and never in the browser;
 *   - the files land in scripts/.fixtures/, which is gitignored;
 *   - the application has no code that reads them.
 *
 * Do not fund these keys on mainnet and do not reuse them anywhere.
 * ------------------------------------------------------------------ */

import { Keypair } from '@solana/web3.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dirname, '.fixtures')

/** Loads a fixture keypair, creating it on first use. */
export function fixtureKeypair(name: string): Keypair {
  const path = resolve(FIXTURE_DIR, `${name}.json`)
  try {
    const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[]
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  } catch {
    mkdirSync(dirname(path), { recursive: true })
    const keypair = Keypair.generate()
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 })
    return keypair
  }
}
