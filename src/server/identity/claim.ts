/* ------------------------------------------------------------------ *
 * Claiming a guest account with a wallet.
 *
 * Connecting a wallet proves nothing. A browser extension will hand out a
 * public key to any page that asks, and a public key is not a secret, so
 * "the client told us its address" is not evidence of ownership of
 * anything. The only proof accepted here is an ed25519 signature over a
 * challenge this server issued, and the challenge binds five things:
 *
 *   domain    the application origin, taken from the request's own Origin
 *             header and checked against the allowlist — never from the
 *             body, so a caller cannot get a challenge minted for another
 *             site
 *   wallet    the address being claimed, inside the signed bytes
 *   session   the SHA-256 of the session token that asked. A signature
 *             captured from somewhere else cannot be replayed against a
 *             different session, so it cannot be used to seize an account
 *             it was not issued for
 *   nonce     32 random bytes from the OS CSPRNG, single-use, consumed by
 *             one conditional UPDATE
 *   expiry    both as an absolute timestamp in the signed text and as a
 *             column the consuming UPDATE tests
 *
 * The statement differs from the sign-in statement, so a sign-in signature
 * cannot be replayed as a link and a link signature cannot be replayed as
 * a sign-in: the signed bytes differ.
 *
 * Linking never creates a user and never touches character, progression or
 * balance. If the wallet already belongs to a different account, this
 * module refuses to guess: it returns the two explicit options, switch or
 * merge, and requires a second authenticated call naming one. There is no
 * code path that merges on a client-supplied account id or on a public
 * address alone.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { buildSiwsMessage, LINK_STATEMENT, looksLikeAddress, looksLikeNonce, SIWS_VERSION, type SiwsFields } from '../../shared/siws'
import { CHAIN_ID, NONCE_TTL_MS } from '../config'
import { coreDb, immediateTransaction } from '../store'
import { sessionIsLive } from '../db'
import { mergeGoldInto } from '../money/gold'
import { consumeEligible, eligibilityOf } from '../money/ledger'
import {
  followMerges,
  linkWalletToUser,
  mergeUserInto,
  recordSwitch,
  walletOwner,
  type LinkOutcome,
} from './users'

const db = coreDb

/**
 * Distinct from SIWS_STATEMENT on purpose: different bytes, different meaning.
 * Shared with the client so the browser can rebuild the exact text it signs;
 * re-exported here because this module is where it is enforced.
 */
export { LINK_STATEMENT }

export type ClaimIntent = 'link'

const insertChallenge = db.raw.prepare(`
  insert into link_challenges (nonce, user_id, wallet, domain, uri, chain_id, session_sha256, intent, issued_at, expiration, expires_at_ms, consumed_at_ms, outcome)
  values (@nonce, @user_id, @wallet, @domain, @uri, @chain_id, @session_sha256, @intent, @issued_at, @expiration, @expires_at_ms, null, null)
`)

type ChallengeRow = {
  nonce: string
  user_id: string
  wallet: string
  domain: string
  uri: string
  chain_id: string
  session_sha256: string
  intent: string
  issued_at: string
  expiration: string
  expires_at_ms: number
  consumed_at_ms: number | null
  outcome: string | null
}

const selectChallenge = db.raw.prepare<[string], ChallengeRow>('select * from link_challenges where nonce = ?')

/**
 * Single-use consumption. Same conditional-UPDATE discipline as the sign-in
 * nonce: two requests carrying one nonce cannot both see `consumed_at_ms is null`.
 */
const consumeChallenge = db.raw.prepare(`
  update link_challenges
     set consumed_at_ms = @now,
         outcome = @outcome
   where nonce = @nonce
     and wallet = @wallet
     and session_sha256 = @session_sha256
     and consumed_at_ms is null
     and expires_at_ms > @now
`)

/**
 * A consumed challenge that ended in "this wallet belongs to someone else" stays
 * usable for exactly one follow-up decision, identified by the same nonce. The
 * `outcome` column is the state: `pending_choice` means a switch or a merge may
 * still be recorded against it.
 */
const resolveChallengeOutcome = db.raw.prepare(`
  update link_challenges
     set outcome = @outcome
   where nonce = @nonce
     and session_sha256 = @session_sha256
     and outcome = 'pending_choice'
`)

/* ------------------------------------------------------------- challenge */

export type IssuedClaim = { fields: SiwsFields; expiresAtMs: number }

export function issueClaimChallenge(input: {
  userId: string
  wallet: string
  domain: string
  uri: string
  sessionHash: string
  now?: number
}): IssuedClaim {
  const now = input.now ?? Date.now()
  const expiresAtMs = now + NONCE_TTL_MS
  const fields: SiwsFields = {
    domain: input.domain,
    address: input.wallet,
    uri: input.uri,
    statement: LINK_STATEMENT,
    version: SIWS_VERSION,
    chainId: CHAIN_ID,
    nonce: randomBytes(32).toString('hex'),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(expiresAtMs).toISOString(),
  }
  insertChallenge.run({
    nonce: fields.nonce,
    user_id: input.userId,
    wallet: input.wallet,
    domain: input.domain,
    uri: input.uri,
    chain_id: fields.chainId,
    session_sha256: input.sessionHash,
    intent: 'link' satisfies ClaimIntent,
    issued_at: fields.issuedAt,
    expiration: fields.expirationTime,
    expires_at_ms: expiresAtMs,
  })
  return { fields, expiresAtMs }
}

/* ---------------------------------------------------------------- verify */

export type ClaimResult =
  | { ok: true; kind: 'linked'; userId: string; wallet: string; alreadyLinked: boolean }
  | {
      ok: true
      kind: 'choice_required'
      nonce: string
      wallet: string
      currentUserId: string
      otherUserId: string
      options: readonly ['switch', 'merge']
      detail: string
    }
  | { ok: false; reason: string }

/**
 * Verifies a link signature and applies it.
 *
 * The bytes that get verified are rebuilt from the stored challenge row, never
 * from the request, so the client can only fail to match them. The nonce is
 * consumed only after a good signature, and the consuming UPDATE is the real
 * gate — if a concurrent request redeemed it first, this one loses there.
 */
export function verifyClaim(input: {
  userId: string
  sessionHash: string
  wallet: unknown
  nonce: unknown
  signature: unknown
  now?: number
}): ClaimResult {
  const now = input.now ?? Date.now()
  const { wallet, nonce, signature } = input

  if (!looksLikeAddress(wallet)) return { ok: false, reason: 'malformed wallet address' }
  if (!looksLikeNonce(nonce)) return { ok: false, reason: 'malformed nonce' }
  if (typeof signature !== 'string' || signature.length > 128) return { ok: false, reason: 'malformed signature' }
  if (!sessionIsLive(input.sessionHash, now)) return { ok: false, reason: 'this session is no longer valid' }

  const row = selectChallenge.get(nonce)
  // Unknown, spent, expired, for another wallet, or for another session all give
  // the same answer. There is nothing useful to learn from telling them apart.
  if (
    !row ||
    row.wallet !== wallet ||
    row.session_sha256 !== input.sessionHash ||
    row.consumed_at_ms !== null ||
    row.expires_at_ms <= now
  ) {
    return { ok: false, reason: 'link challenge is unknown, already used, expired, or not for this session' }
  }
  if (row.chain_id !== CHAIN_ID) return { ok: false, reason: 'link challenge is not valid for this deployment' }
  if (followMerges(row.user_id) !== input.userId) {
    return { ok: false, reason: 'link challenge was issued to a different account' }
  }

  let publicKeyBytes: Uint8Array
  let signatureBytes: Uint8Array
  try {
    publicKeyBytes = bs58.decode(wallet)
    signatureBytes = bs58.decode(signature)
  } catch {
    return { ok: false, reason: 'wallet address or signature is not valid base58' }
  }
  if (publicKeyBytes.length !== 32) return { ok: false, reason: 'wallet address is not a 32-byte key' }
  if (signatureBytes.length !== 64) return { ok: false, reason: 'signature is not 64 bytes' }

  const message = buildSiwsMessage({
    domain: row.domain,
    address: row.wallet,
    uri: row.uri,
    statement: LINK_STATEMENT,
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
    valid = false
  }
  if (!valid) return { ok: false, reason: 'signature does not match the challenge' }

  const owner = walletOwner(row.wallet)
  const conflict = owner !== null && owner !== input.userId

  if (
    consumeChallenge.run({
      nonce: row.nonce,
      wallet: row.wallet,
      session_sha256: input.sessionHash,
      outcome: conflict ? 'pending_choice' : 'linked',
      now,
    }).changes !== 1
  ) {
    return { ok: false, reason: 'link challenge was already used' }
  }

  if (conflict) {
    return {
      ok: true,
      kind: 'choice_required',
      nonce: row.nonce,
      wallet: row.wallet,
      currentUserId: input.userId,
      otherUserId: owner,
      options: ['switch', 'merge'] as const,
      detail:
        'This wallet already belongs to another Voxels account. Choose explicitly: switch to that account and leave this one alone, or merge this account into it. Nothing has been changed yet.',
    }
  }

  const linked: LinkOutcome = linkWalletToUser({
    userId: input.userId,
    wallet: row.wallet,
    chainId: row.chain_id,
    nonce: row.nonce,
    domain: row.domain,
    now,
  })
  if (!linked.ok) {
    // The wallet was claimed between the ownership read and the link. Report it
    // rather than retrying: the choice belongs to the player.
    return { ok: false, reason: 'that wallet was linked to another account a moment ago. Start again.' }
  }
  return { ok: true, kind: 'linked', userId: input.userId, wallet: row.wallet, alreadyLinked: linked.alreadyLinked }
}

/* --------------------------------------------------------------- resolve */

export type Resolution = 'switch' | 'merge'

export type ResolutionResult =
  | { ok: true; action: 'switch'; userId: string; wallet: string }
  | { ok: true; action: 'merge'; userId: string; wallet: string; movedGold: string }
  | { ok: false; reason: string }

/**
 * Applies the player's explicit choice.
 *
 * Authority comes from the nonce, which was only marked `pending_choice` after a
 * verified signature from this session. Neither the account id nor the wallet is
 * read from the request — both come from the stored challenge row. So there is no
 * input to this function that an attacker could substitute to merge an account
 * they do not control.
 */
export function resolveClaimConflict(input: {
  userId: string
  sessionHash: string
  nonce: unknown
  action: unknown
  now?: number
}): ResolutionResult {
  const now = input.now ?? Date.now()
  if (!looksLikeNonce(input.nonce)) return { ok: false, reason: 'malformed nonce' }
  if (input.action !== 'switch' && input.action !== 'merge') {
    return { ok: false, reason: 'action must be "switch" or "merge"' }
  }
  if (!sessionIsLive(input.sessionHash, now)) return { ok: false, reason: 'this session is no longer valid' }

  const row = selectChallenge.get(input.nonce)
  if (!row || row.session_sha256 !== input.sessionHash || row.outcome !== 'pending_choice') {
    return { ok: false, reason: 'there is no pending account decision for this session' }
  }
  if (followMerges(row.user_id) !== input.userId) {
    return { ok: false, reason: 'that decision belongs to a different account' }
  }
  const target = walletOwner(row.wallet)
  if (!target) return { ok: false, reason: 'that wallet is no longer linked to any account' }
  if (target === input.userId) return { ok: false, reason: 'that wallet already belongs to this account' }

  if (input.action === 'switch') {
    if (resolveChallengeOutcome.run({ nonce: row.nonce, session_sha256: input.sessionHash, outcome: 'switched' }).changes !== 1) {
      return { ok: false, reason: 'that decision was already applied' }
    }
    recordSwitch(target, row.wallet, input.userId, row.nonce, now)
    // Nothing is moved and nothing is deleted. The guest account stays exactly as
    // it was, reachable again from the same browser key.
    return { ok: true, action: 'switch', userId: target, wallet: row.wallet }
  }

  // Merge. Gold moves first, as a balanced ledger transfer, because the identity
  // update is the cheap part and the ledger write is the one that must not be
  // half-done. Both are idempotent, so a crash between them is recoverable by
  // repeating the call.
  const eligibility = eligibilityOf(input.userId)
  const moved = mergeGoldInto({ fromUserId: input.userId, intoUserId: target, nonce: row.nonce, now })
  if (!moved.ok) return { ok: false, reason: moved.reason }

  // Redeemable headroom the source had genuinely accrued is retired with it. It is
  // not granted to the destination: the destination's redeemable total is its own
  // hunt history, and carrying eligibility across a merge would let two accounts'
  // worth of grants become one account's worth of redeemable gold.
  const headroom = eligibility.accrued - eligibility.consumed
  if (headroom > 0n) consumeEligible(input.userId, headroom, now)

  if (!mergeUserInto(input.userId, target, row.nonce, now)) {
    return { ok: false, reason: 'that account could not be merged (it may already have been)' }
  }
  immediateTransaction(db, () => {
    resolveChallengeOutcome.run({ nonce: row.nonce, session_sha256: input.sessionHash, outcome: 'merged' })
  })
  return { ok: true, action: 'merge', userId: target, wallet: row.wallet, movedGold: moved.moved.toString() }
}
