/* ------------------------------------------------------------------ *
 * One canonical account per person.
 *
 * A `user` is the account. Everything a person owns — character,
 * progression, inventory, gold, hunt sessions, jobs, receipts, linked
 * wallets — hangs off `user_id`, and nothing hangs off a wallet address.
 *
 * A `principal` is a credential that resolves to a user. There are three
 * kinds and they are all equal citizens:
 *
 *   wallet  a base58 Solana address, proven by an ed25519 signature
 *   guest   the SHA-256 of a browser-held secret, issued as a real
 *           server session (this is the existing guest concept, given a
 *           user row rather than a second parallel identity)
 *   dev     a labelled test identity, only when WALLY_DEV_SESSIONS=1
 *
 * This indirection is the whole fix for "linking a wallet creates a
 * second player". Claiming does not create a user; it adds a principal to
 * the user that already exists. The character, the progression and the
 * balance are untouched because nothing about them was keyed on the
 * principal in the first place.
 *
 * `linked_wallets.wallet` is a primary key, so a wallet belongs to
 * exactly one account and the "already linked elsewhere" case is a
 * constraint violation rather than something this code has to remember to
 * look for.
 * ------------------------------------------------------------------ */

import { createHash, randomBytes } from 'node:crypto'
import { looksLikeAddress } from '../../shared/siws'
import { coreDb, immediateTransaction } from '../store'

const db = coreDb

export type PrincipalKind = 'wallet' | 'guest' | 'dev'
export type UserStatus = 'active' | 'merged'

export type UserRow = {
  user_id: string
  status: UserStatus
  origin: PrincipalKind
  primary_wallet: string | null
  claimed_at_ms: number | null
  merged_into: string | null
  created_at_ms: number
  updated_at_ms: number
}

const newUserId = () => `u_${randomBytes(16).toString('hex')}`

export const hashGuestKey = (guestKey: string) =>
  createHash('sha256').update(guestKey.toLowerCase(), 'utf8').digest('hex')

/**
 * Classifies a session principal.
 *
 * The shapes are the ones already in use: `gst_` prefixes come from
 * `pvp/guest.ts`, `dev` prefixes from the development session route, and anything
 * that looks like a base58 address is a wallet. An unrecognised shape is treated
 * as a dev principal rather than a wallet, because mislabelling something as a
 * wallet is the direction that matters.
 */
export function principalKind(principalId: string): PrincipalKind {
  if (principalId.startsWith('gst_')) return 'guest'
  if (looksLikeAddress(principalId) && !principalId.startsWith('dev')) return 'wallet'
  return 'dev'
}

/* ------------------------------------------------------------------ rows */

const insertUser = db.raw.prepare(`
  insert into users (user_id, status, origin, primary_wallet, claimed_at_ms, merged_into, created_at_ms, updated_at_ms)
  values (@user_id, 'active', @origin, @primary_wallet, @claimed_at_ms, null, @now, @now)
`)

const selectUser = db.raw.prepare<[string], UserRow>('select * from users where user_id = ?')

const touchUser = db.raw.prepare('update users set updated_at_ms = ? where user_id = ?')

const setPrimaryWallet = db.raw.prepare(`
  update users
     set primary_wallet = @wallet,
         claimed_at_ms = coalesce(claimed_at_ms, @now),
         updated_at_ms = @now
   where user_id = @user_id
`)

const markMerged = db.raw.prepare(`
  update users set status = 'merged', merged_into = @into, updated_at_ms = @now where user_id = @user_id and status = 'active'
`)

const insertPrincipal = db.raw.prepare(`
  insert into principals (principal_id, user_id, kind, revoked_at_ms, created_at_ms)
  values (@principal_id, @user_id, @kind, null, @now)
  on conflict (principal_id) do nothing
`)

const selectPrincipal = db.raw.prepare<[string], { user_id: string; kind: string; revoked_at_ms: number | null }>(
  'select user_id, kind, revoked_at_ms from principals where principal_id = ?',
)

const repointPrincipal = db.raw.prepare(
  'update principals set user_id = @user_id, created_at_ms = created_at_ms where principal_id = @principal_id',
)

const selectPrincipalsFor = db.raw.prepare<[string], { principal_id: string; kind: string }>(
  'select principal_id, kind from principals where user_id = ? and revoked_at_ms is null',
)

const insertLinkedWallet = db.raw.prepare(`
  insert into linked_wallets (wallet, user_id, chain_id, is_primary, proof_nonce, proof_domain, verified_at_ms, created_at_ms)
  values (@wallet, @user_id, @chain_id, @is_primary, @proof_nonce, @proof_domain, @now, @now)
  on conflict (wallet) do nothing
`)

const selectLinkedWallet = db.raw.prepare<[string], { wallet: string; user_id: string; is_primary: number }>(
  'select wallet, user_id, is_primary from linked_wallets where wallet = ?',
)

const selectWalletsFor = db.raw.prepare<[string], { wallet: string; is_primary: number; verified_at_ms: number }>(
  'select wallet, is_primary, verified_at_ms from linked_wallets where user_id = ? order by created_at_ms asc',
)

const moveWallets = db.raw.prepare('update linked_wallets set user_id = @into where user_id = @from')

const movePrincipals = db.raw.prepare('update principals set user_id = @into where user_id = @from')

const touchGuest = db.raw.prepare('update guest_sessions set last_seen_ms = ? where guest_sha256 = ?')

const insertGuestSession = db.raw.prepare(`
  insert into guest_sessions (guest_sha256, user_id, principal_id, claimed_at_ms, claimed_wallet, created_at_ms, last_seen_ms)
  values (@guest_sha256, @user_id, @principal_id, null, null, @now, @now)
  on conflict (guest_sha256) do update set last_seen_ms = @now
`)

const selectGuestSession = db.raw.prepare<[string], {
  guest_sha256: string
  user_id: string
  claimed_at_ms: number | null
  claimed_wallet: string | null
}>('select guest_sha256, user_id, claimed_at_ms, claimed_wallet from guest_sessions where guest_sha256 = ?')

const markGuestClaimed = db.raw.prepare(`
  update guest_sessions
     set claimed_at_ms = coalesce(claimed_at_ms, @now),
         claimed_wallet = coalesce(claimed_wallet, @wallet),
         last_seen_ms = @now
   where user_id = @user_id
`)

const insertLinkAudit = db.raw.prepare(`
  insert into account_links (id, user_id, wallet, action, from_user_id, nonce, detail, created_at_ms)
  values (@id, @user_id, @wallet, @action, @from_user_id, @nonce, @detail, @now)
`)

const selectLinkAudit = db.raw.prepare<[string, number], {
  action: string
  wallet: string
  from_user_id: string | null
  detail: string
  created_at_ms: number
}>('select action, wallet, from_user_id, detail, created_at_ms from account_links where user_id = ? order by created_at_ms desc limit ?')

/* ------------------------------------------------------------- resolution */

export type ResolvedUser = { userId: string; created: boolean; kind: PrincipalKind }

/**
 * Resolves a session principal to its user, creating the user on first sight.
 *
 * For a wallet principal, an existing `linked_wallets` row wins: signing in with
 * a wallet that was linked from a guest session lands on the account that guest
 * built, which is the entire point of the claim flow. The principal row is
 * repointed if it ever disagreed.
 */
export function resolveUserForPrincipal(principalId: string, now = Date.now()): ResolvedUser {
  const kind = principalKind(principalId)

  return immediateTransaction(db, (): ResolvedUser => {
    const linked = kind === 'wallet' ? selectLinkedWallet.get(principalId) : undefined
    const existing = selectPrincipal.get(principalId)

    if (existing) {
      const canonical = linked?.user_id ?? existing.user_id
      if (canonical !== existing.user_id) repointPrincipal.run({ principal_id: principalId, user_id: canonical })
      const resolved = followMerges(canonical)
      touchUser.run(now, resolved)
      return { userId: resolved, created: false, kind }
    }

    if (linked) {
      insertPrincipal.run({ principal_id: principalId, user_id: linked.user_id, kind, now })
      const resolved = followMerges(linked.user_id)
      touchUser.run(now, resolved)
      return { userId: resolved, created: false, kind }
    }

    const userId = newUserId()
    insertUser.run({
      user_id: userId,
      origin: kind,
      primary_wallet: kind === 'wallet' ? principalId : null,
      claimed_at_ms: kind === 'wallet' ? now : null,
      now,
    })
    insertPrincipal.run({ principal_id: principalId, user_id: userId, kind, now })
    if (kind === 'wallet') {
      // A wallet that signs in directly, never having been a guest, is its own
      // proof: the signature that produced this session is the link evidence.
      insertLinkedWallet.run({
        wallet: principalId,
        user_id: userId,
        chain_id: 'siws',
        is_primary: 1,
        proof_nonce: 'sign-in',
        proof_domain: 'sign-in',
        now,
      })
    }
    if (kind === 'guest') {
      insertGuestSession.run({
        guest_sha256: principalId.slice('gst_'.length),
        user_id: userId,
        principal_id: principalId,
        now,
      })
    }
    return { userId, created: true, kind }
  })
}

/** A merged account forwards to its destination. Bounded so a cycle cannot hang. */
export function followMerges(userId: string, depth = 0): string {
  if (depth > 8) return userId
  const row = selectUser.get(userId)
  if (!row || row.status !== 'merged' || !row.merged_into) return userId
  return followMerges(row.merged_into, depth + 1)
}

export function readUser(userId: string): UserRow | undefined {
  return selectUser.get(userId)
}

export function walletOwner(wallet: string): string | null {
  const row = selectLinkedWallet.get(wallet)
  return row ? followMerges(row.user_id) : null
}

export function walletsFor(userId: string) {
  return selectWalletsFor.all(userId).map(row => ({
    wallet: row.wallet,
    isPrimary: row.is_primary === 1,
    verifiedAtMs: row.verified_at_ms,
  }))
}

export function principalsFor(userId: string) {
  return selectPrincipalsFor.all(userId).map(row => ({ kind: row.kind as PrincipalKind }))
}

export function guestSessionFor(guestSha256: string) {
  return selectGuestSession.get(guestSha256)
}

/* ------------------------------------------------------------------ links */

export type LinkOutcome =
  | { ok: true; userId: string; alreadyLinked: boolean }
  | { ok: false; code: 'wallet_linked_elsewhere'; otherUserId: string }

/**
 * Attaches a proven wallet to an account.
 *
 * Called only from `claim.ts`, only after an ed25519 signature over a
 * server-issued challenge has been verified and the challenge consumed. It never
 * creates a user and never touches character, progression or balance — it writes
 * two rows and a primary-wallet pointer.
 */
export function linkWalletToUser(input: {
  userId: string
  wallet: string
  chainId: string
  nonce: string
  domain: string
  now?: number
}): LinkOutcome {
  const now = input.now ?? Date.now()
  return immediateTransaction(db, (): LinkOutcome => {
    const existing = selectLinkedWallet.get(input.wallet)
    if (existing) {
      const owner = followMerges(existing.user_id)
      if (owner !== input.userId) return { ok: false, code: 'wallet_linked_elsewhere', otherUserId: owner }
      return { ok: true, userId: input.userId, alreadyLinked: true }
    }

    insertLinkedWallet.run({
      wallet: input.wallet,
      user_id: input.userId,
      chain_id: input.chainId,
      is_primary: selectWalletsFor.all(input.userId).length === 0 ? 1 : 0,
      proof_nonce: input.nonce,
      proof_domain: input.domain,
      now,
    })
    insertPrincipal.run({ principal_id: input.wallet, user_id: input.userId, kind: 'wallet', now })
    setPrimaryWallet.run({ user_id: input.userId, wallet: input.wallet, now })
    markGuestClaimed.run({ user_id: input.userId, wallet: input.wallet, now })
    insertLinkAudit.run({
      id: `al_${randomBytes(12).toString('hex')}`,
      user_id: input.userId,
      wallet: input.wallet,
      action: 'link',
      from_user_id: null,
      nonce: input.nonce,
      detail: 'Wallet linked to the existing account. Character, progression and balance unchanged.',
      now,
    })
    return { ok: true, userId: input.userId, alreadyLinked: false }
  })
}

/**
 * Retires `fromUserId` in favour of `intoUserId`.
 *
 * Identity only: this moves principals and wallets and sets the forwarding
 * pointer. Moving the *balance* is a ledger operation and lives in
 * `money/gold.ts`, because a balance must move as a balanced transfer and not as
 * an UPDATE of two rows.
 */
export function mergeUserInto(fromUserId: string, intoUserId: string, nonce: string, now = Date.now()): boolean {
  if (fromUserId === intoUserId) return false
  return immediateTransaction(db, () => {
    if (markMerged.run({ user_id: fromUserId, into: intoUserId, now }).changes !== 1) return false
    moveWallets.run({ from: fromUserId, into: intoUserId })
    movePrincipals.run({ from: fromUserId, into: intoUserId })
    insertLinkAudit.run({
      id: `al_${randomBytes(12).toString('hex')}`,
      user_id: intoUserId,
      wallet: selectUser.get(intoUserId)?.primary_wallet ?? '',
      action: 'merge',
      from_user_id: fromUserId,
      nonce,
      detail: 'Authenticated merge: the guest account was retired into the wallet account.',
      now,
    })
    return true
  })
}

export function recordSwitch(userId: string, wallet: string, fromUserId: string, nonce: string, now = Date.now()): void {
  insertLinkAudit.run({
    id: `al_${randomBytes(12).toString('hex')}`,
    user_id: userId,
    wallet,
    action: 'switch',
    from_user_id: fromUserId,
    nonce,
    detail: 'Account switch: the guest account was left intact and the wallet account resumed.',
    now,
  })
}

export function linkHistory(userId: string, limit = 20) {
  return selectLinkAudit.all(userId, limit).map(row => ({
    action: row.action,
    wallet: row.wallet,
    fromUserId: row.from_user_id,
    detail: row.detail,
    atMs: row.created_at_ms,
  }))
}

export function touchGuestSession(guestSha256: string, now = Date.now()): void {
  touchGuest.run(now, guestSha256)
}
