/* ------------------------------------------------------------------ *
 * Sign-In With Solana: challenge issuance, signature verification, and
 * session issuance.
 *
 * There is no password anywhere, and no key material of any kind reaches
 * this process. Proof of control is an ed25519 signature over a
 * server-issued nonce, produced inside the user's wallet.
 *
 * The ed25519 verification is @noble/curves — an audited implementation.
 * Nothing in this file implements a primitive by hand; it only sequences
 * vetted ones.
 *
 * Replay protection has three parts:
 *   1. the nonce is random, 32 bytes from the OS CSPRNG;
 *   2. it is bound at issue time to one wallet, one domain and one chain,
 *      all of which are inside the signed bytes;
 *   3. it is consumed by a single conditional UPDATE, so exactly one
 *      request can ever redeem it, and it expires regardless.
 * ------------------------------------------------------------------ */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { buildSiwsMessage, looksLikeAddress, looksLikeNonce, SIWS_STATEMENT, SIWS_VERSION, type SiwsFields } from '../shared/siws'
import { CHAIN_ID, NONCE_TTL_MS, SESSION_TTL_MS, SIWS_DOMAINS } from './config'
import { consumeNonce, destroySession, peekNonce, resolveSession, saveNonce, saveSession } from './db'

const ED25519_PUBLIC_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64

export const isAllowedDomain = (domain: string) => SIWS_DOMAINS.includes(domain)

/** The exact challenge the client is expected to assemble and sign. */
export function issueChallenge(wallet: string, domain: string, uri: string, now = Date.now()): SiwsFields {
  const expiresAtMs = now + NONCE_TTL_MS
  const fields: SiwsFields = {
    domain,
    address: wallet,
    uri,
    statement: SIWS_STATEMENT,
    version: SIWS_VERSION,
    chainId: CHAIN_ID,
    nonce: randomBytes(32).toString('hex'),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(expiresAtMs).toISOString(),
  }
  saveNonce({
    nonce: fields.nonce,
    wallet,
    domain,
    uri,
    chain_id: fields.chainId,
    issued_at: fields.issuedAt,
    expiration: fields.expirationTime,
    expires_at_ms: expiresAtMs,
  })
  return fields
}

export type VerifyOutcome =
  | { ok: true; wallet: string }
  | { ok: false; reason: string }

/**
 * Verifies a sign-in.
 *
 * The message that gets verified is rebuilt here from the row the server
 * stored at issue time, never from anything in the request body. The client
 * sends only a nonce and a signature, so it cannot influence which bytes are
 * checked — it can only fail to match them.
 */
export function verifySignIn(input: { wallet: unknown; nonce: unknown; signature: unknown }, now = Date.now()): VerifyOutcome {
  const { wallet, nonce, signature } = input

  if (!looksLikeAddress(wallet)) return { ok: false, reason: 'malformed wallet address' }
  if (!looksLikeNonce(nonce)) return { ok: false, reason: 'malformed nonce' }
  if (typeof signature !== 'string' || signature.length > 128) return { ok: false, reason: 'malformed signature' }

  const row = peekNonce(nonce)
  // A nonce that was never issued, was already spent, or has aged out all give
  // the same answer: there is nothing useful to learn from distinguishing them.
  if (!row || row.wallet !== wallet || row.consumed_at_ms !== null || row.expires_at_ms <= now) {
    return { ok: false, reason: 'sign-in challenge is unknown, already used, or expired' }
  }
  if (!isAllowedDomain(row.domain) || row.chain_id !== CHAIN_ID) {
    return { ok: false, reason: 'sign-in challenge is not valid for this deployment' }
  }

  let publicKeyBytes: Uint8Array
  let signatureBytes: Uint8Array
  try {
    publicKeyBytes = bs58.decode(wallet)
    signatureBytes = bs58.decode(signature)
  } catch {
    return { ok: false, reason: 'wallet address or signature is not valid base58' }
  }
  if (publicKeyBytes.length !== ED25519_PUBLIC_KEY_BYTES) return { ok: false, reason: 'wallet address is not a 32-byte key' }
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: 'signature is not 64 bytes' }

  const message = buildSiwsMessage({
    domain: row.domain,
    address: row.wallet,
    uri: row.uri,
    statement: SIWS_STATEMENT,
    version: SIWS_VERSION,
    chainId: row.chain_id,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expirationTime: row.expiration,
  })

  let valid = false
  try {
    valid = ed25519.verify(signatureBytes, new TextEncoder().encode(message), publicKeyBytes)
  } catch {
    // Malformed points and non-canonical encodings throw rather than return false.
    valid = false
  }
  if (!valid) return { ok: false, reason: 'signature does not match the challenge' }

  // Consumed only after a good signature, and the UPDATE is the real gate: if
  // another request redeemed this nonce first, this one loses here.
  if (!consumeNonce(nonce, wallet, now)) return { ok: false, reason: 'sign-in challenge was already used' }

  return { ok: true, wallet }
}

/* ---------------------------------------------------------------- sessions */

/** Session tokens are opaque random bytes. They are not JWTs and carry no claims. */
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

export type IssuedSession = { token: string; expiresAtMs: number }

/**
 * Only the SHA-256 of the token is stored, so a database copy cannot be replayed
 * as a live session.
 */
export function createSession(wallet: string, now = Date.now()): IssuedSession {
  const token = randomBytes(32).toString('base64url')
  const expiresAtMs = now + SESSION_TTL_MS
  saveSession(hashToken(token), wallet, now, expiresAtMs)
  return { token, expiresAtMs }
}

/** Bearer tokens only: no cookie is set, so there is no CSRF surface to defend. */
export function walletFromAuthHeader(header: string | undefined, now = Date.now()): string | null {
  if (!header) return null
  const match = /^Bearer (.+)$/.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  if (!token || token.length > 512) return null
  return resolveSession(hashToken(token), now)
}

export function revokeFromAuthHeader(header: string | undefined): void {
  if (!header) return
  const match = /^Bearer (.+)$/.exec(header.trim())
  if (match) destroySession(hashToken(match[1].trim()))
}

/** Used for fixed-string comparisons where an attacker controls one side. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
