/* ------------------------------------------------------------------ *
 * Durable storage.
 *
 * Two databases, opened and migrated by `store/`:
 *
 *   core     game and identity. Characters, progression, sign-in nonces,
 *            sessions, linked wallets, PvP match state.
 *   finance  money. The gold ledger, reservations, jobs, receipts,
 *            withdrawals.
 *
 * No foreign key crosses between them, which is why `profiles.gold` no
 * longer sits one row away from a receipt. The financial side refers to a
 * player by `user_id` as an opaque string and resolves it through
 * `identity/users.ts`, never through a join.
 *
 * Schema changes go in `store/migrations.ts`. This file only reads and
 * writes; it declares nothing.
 *
 * Amounts are TEXT holding a decimal integer, as they always were here, so
 * a value round-trips as an exact bigint with no float or precision
 * decision anywhere in the path.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import { CLUSTER } from './config'
import { resolveUserForPrincipal } from './identity/users'
import { coreDb, financeDb } from './store'
import { DEFAULT_PROFILE, type Profile, type ProfileStyle } from '../shared/profile'

/** The raw core handle, for the modules that predate the `store/` seam. */
export const db = coreDb.raw

const finance = financeDb.raw

/**
 * Marks every financial row with the environment that produced it, so a record
 * created against a mock or a devnet can never be mistaken for a live one. §12 of
 * the specification asks for exactly this and it costs one column.
 */
export const ENV_STAMP = `cluster=${CLUSTER}`

const principalUser = (principal: string) => resolveUserForPrincipal(principal).userId

/* ---------------------------------------------------------------- profiles */

type ProfileRow = {
  wallet: string
  character: string
  style_json: string
  player_name: string
  gold: number
  updated_at_ms: number
}

const selectProfile = db.prepare<[string], ProfileRow>('select * from profiles where wallet = ?')

/**
 * The primary key column is still called `wallet` but now holds a `user_id`.
 *
 * Renaming it would break nothing except every prepared statement in this file
 * for no behavioural gain, and the column comment in the migration says what it
 * holds. What matters is that a profile belongs to an account, not to an address,
 * so linking a wallet finds the character that already exists.
 */
const upsertProfile = db.prepare(`
  insert into profiles (wallet, character, style_json, player_name, gold, last_cluster, created_at_ms, updated_at_ms)
  values (@wallet, @character, @style_json, @player_name, @gold, @cluster, @now, @now)
  on conflict(wallet) do update set
    character    = excluded.character,
    style_json   = excluded.style_json,
    player_name  = excluded.player_name,
    gold         = excluded.gold,
    last_cluster = excluded.last_cluster,
    updated_at_ms = excluded.updated_at_ms
`)

/** One-time adoption of a row keyed on the raw principal, from before `users` existed. */
const adoptLegacyProfile = db.prepare(
  'update profiles set wallet = @user_id, updated_at_ms = @now where wallet = @principal and not exists (select 1 from profiles where wallet = @user_id)',
)

export type StoredProfile = { profile: Profile; updatedAtMs: number }

/**
 * Reads one account's record. A stored style that no longer parses falls back to
 * the default rather than throwing, so a schema change cannot lock a player out
 * of their own save.
 */
export function readProfile(principal: string): StoredProfile | null {
  const userId = principalUser(principal)
  adoptLegacyProfile.run({ principal, user_id: userId, now: Date.now() })
  const row = selectProfile.get(userId)
  if (!row) return null
  let style: ProfileStyle = DEFAULT_PROFILE.style
  try {
    const parsed = JSON.parse(row.style_json) as unknown
    if (parsed && typeof parsed === 'object') style = parsed as ProfileStyle
  } catch {
    /* keep the default */
  }
  return {
    profile: {
      character: row.character as Profile['character'],
      style,
      playerName: row.player_name,
      gold: row.gold,
    },
    updatedAtMs: row.updated_at_ms,
  }
}

export function writeProfile(principal: string, profile: Profile, cluster: string, now = Date.now()): StoredProfile {
  const userId = principalUser(principal)
  adoptLegacyProfile.run({ principal, user_id: userId, now })
  upsertProfile.run({
    wallet: userId,
    character: profile.character,
    style_json: JSON.stringify(profile.style),
    player_name: profile.playerName,
    // Stored for resume-on-another-device only. It is NOT a balance: the
    // authoritative figure is the ledger, and nothing reads this to decide what a
    // player can spend. `gold/legacy.ts` is the only thing that ever looks at it,
    // once, to record a `legacy_demo` credit that can never be redeemed.
    gold: profile.gold,
    cluster,
    now,
  })
  return { profile, updatedAtMs: now }
}

/* ----------------------------------------------------------------- nonces */

const insertNonce = db.prepare(`
  insert into nonces (nonce, wallet, domain, uri, chain_id, issued_at, expiration, expires_at_ms)
  values (@nonce, @wallet, @domain, @uri, @chain_id, @issued_at, @expiration, @expires_at_ms)
`)

export type NonceRow = {
  nonce: string
  wallet: string
  domain: string
  uri: string
  chain_id: string
  issued_at: string
  expiration: string
  expires_at_ms: number
  consumed_at_ms: number | null
}

const selectNonce = db.prepare<[string], NonceRow>('select * from nonces where nonce = ?')

/**
 * Single-use consumption, expressed as one conditional UPDATE so that two
 * concurrent requests carrying the same nonce cannot both succeed: SQLite
 * serialises the writes and only the first sees `consumed_at_ms is null`.
 *
 * This is the shape every other single-use claim in the codebase copies — kill
 * tokens, link challenges, job leases, ledger balances.
 */
const consumeNonceStatement = db.prepare(`
  update nonces
     set consumed_at_ms = @now
   where nonce = @nonce
     and wallet = @wallet
     and consumed_at_ms is null
     and expires_at_ms > @now
`)

const deleteStaleNonces = db.prepare('delete from nonces where expires_at_ms < ?')

export function saveNonce(row: Omit<NonceRow, 'consumed_at_ms'>): void {
  insertNonce.run(row)
}

export function peekNonce(nonce: string): NonceRow | undefined {
  return selectNonce.get(nonce)
}

/** True exactly once per nonce, and only for the wallet it was issued to. */
export function consumeNonce(nonce: string, wallet: string, now = Date.now()): boolean {
  return consumeNonceStatement.run({ nonce, wallet, now }).changes === 1
}

/* ---------------------------------------------------------------- sessions */

const insertSession = db.prepare(`
  insert into sessions (token_sha256, wallet, created_at_ms, expires_at_ms, last_seen_ms)
  values (?, ?, ?, ?, ?)
`)

const selectSession = db.prepare<[string], { wallet: string; expires_at_ms: number }>(
  'select wallet, expires_at_ms from sessions where token_sha256 = ?',
)

const touchSession = db.prepare('update sessions set last_seen_ms = ? where token_sha256 = ?')
const deleteSession = db.prepare('delete from sessions where token_sha256 = ?')
const deleteStaleSessions = db.prepare('delete from sessions where expires_at_ms < ?')

export function saveSession(tokenHash: string, wallet: string, now: number, expiresAtMs: number): void {
  insertSession.run(tokenHash, wallet, now, expiresAtMs, now)
}

/** Returns the principal this session belongs to, or null. Expired rows are removed on sight. */
export function resolveSession(tokenHash: string, now = Date.now()): string | null {
  const row = selectSession.get(tokenHash)
  if (!row) return null
  if (row.expires_at_ms <= now) {
    deleteSession.run(tokenHash)
    return null
  }
  touchSession.run(now, tokenHash)
  return row.wallet
}

export function destroySession(tokenHash: string): void {
  deleteSession.run(tokenHash)
}

/** True when this session hash is live. Used to bind a link challenge to one session. */
export function sessionIsLive(tokenHash: string, now = Date.now()): boolean {
  const row = selectSession.get(tokenHash)
  return Boolean(row && row.expires_at_ms > now)
}

/* ---------------------------------------------------------------- receipts */

export type ReceiptStatus = 'submitted' | 'confirmed' | 'failed' | 'unknown'

/**
 * A receipt, in the shape the API already returns.
 *
 * The row itself lives in the financial database with a wider column set
 * (`network`, `asset`, `env_stamp`, `owner_user_id`); this view keeps the field
 * names the client is already reading, and `ownerUserId` replaces the old
 * `wallet` because ownership is now per account rather than per address — a
 * player who links a second wallet still sees their own receipts.
 */
export type ReceiptRow = {
  signature: string
  ownerUserId: string
  service: string
  recipient: string
  lamports: string
  cluster: string
  status: ReceiptStatus
  detail: string | null
  created_at_ms: number
  updated_at_ms: number
  confirmed_at_ms: number | null
}

type ReceiptDbRow = {
  receipt_id: string
  owner_user_id: string
  service: string
  recipient: string
  amount: string
  network: string
  signature: string | null
  status: string
  detail: string | null
  created_at_ms: number
  updated_at_ms: number
  confirmed_at_ms: number | null
}

const viewReceipt = (row: ReceiptDbRow): ReceiptRow => ({
  signature: row.signature ?? '',
  ownerUserId: row.owner_user_id,
  service: row.service,
  recipient: row.recipient,
  lamports: row.amount,
  cluster: row.network,
  status: row.status as ReceiptStatus,
  detail: row.detail,
  created_at_ms: row.created_at_ms,
  updated_at_ms: row.updated_at_ms,
  confirmed_at_ms: row.confirmed_at_ms,
})

/**
 * Idempotent on the transaction signature. A retried submission re-reads the
 * existing row instead of creating a second receipt for one payment, which is
 * what makes the client safe to retry after a dropped response.
 */
const insertReceipt = finance.prepare(`
  insert into receipts (receipt_id, owner_user_id, job_id, kind, service, network, asset, amount, recipient, signature, status, detail, env_stamp, created_at_ms, updated_at_ms)
  values (@receipt_id, @owner_user_id, null, 'sol_transfer', @service, @network, 'SOL', @amount, @recipient, @signature, @status, @detail, @env_stamp, @now, @now)
  on conflict (signature) do nothing
`)

const selectReceipt = finance.prepare<[string], ReceiptDbRow>('select * from receipts where signature = ?')

const updateReceiptStatus = finance.prepare(`
  update receipts
     set status = @status,
         detail = @detail,
         updated_at_ms = @now,
         confirmed_at_ms = case when @status = 'confirmed' then coalesce(confirmed_at_ms, @now) else confirmed_at_ms end
   where signature = @signature
`)

const selectReceiptsForOwner = finance.prepare<[string, number], ReceiptDbRow>(
  'select * from receipts where owner_user_id = ? order by created_at_ms desc limit ?',
)

export function recordReceipt(row: {
  signature: string
  /** Session principal. Resolved to the owning account here. */
  wallet: string
  service: string
  recipient: string
  lamports: bigint
  cluster: string
  status: ReceiptStatus
  detail: string | null
  now?: number
}): ReceiptRow {
  insertReceipt.run({
    receipt_id: `rc_${randomBytes(16).toString('hex')}`,
    owner_user_id: principalUser(row.wallet),
    service: row.service,
    network: row.cluster,
    amount: row.lamports.toString(),
    recipient: row.recipient,
    signature: row.signature,
    status: row.status,
    detail: row.detail,
    env_stamp: ENV_STAMP,
    now: row.now ?? Date.now(),
  })
  // Non-null: either the insert landed or a row with this signature already existed.
  return viewReceipt(selectReceipt.get(row.signature)!)
}

export function readReceipt(signature: string): ReceiptRow | undefined {
  const row = selectReceipt.get(signature)
  return row ? viewReceipt(row) : undefined
}

/** Owner check, by account rather than by address. */
export function receiptBelongsTo(row: ReceiptRow, principal: string): boolean {
  return row.ownerUserId === principalUser(principal)
}

export function setReceiptStatus(signature: string, status: ReceiptStatus, detail: string | null, now = Date.now()): void {
  updateReceiptStatus.run({ signature, status, detail, now })
}

export function listReceipts(principal: string, limit = 20): ReceiptRow[] {
  return selectReceiptsForOwner.all(principalUser(principal), limit).map(viewReceipt)
}

/* -------------------------------------------------------------- demo tasks */

export type DemoTaskStatus = 'queued' | 'running' | 'delivered'
export type DemoTaskRow = { id: string; status: DemoTaskStatus; cost: number; created_at_ms: number }

const insertDemoTask = db.prepare(
  'insert into demo_tasks (id, status, cost, created_at_ms, updated_at_ms) values (?, ?, ?, ?, ?)',
)
const selectDemoTask = db.prepare<[string], DemoTaskRow>('select id, status, cost, created_at_ms from demo_tasks where id = ?')
const updateDemoTask = db.prepare('update demo_tasks set status = ?, updated_at_ms = ? where id = ?')

export function createDemoTask(id: string, cost: number, now = Date.now()): DemoTaskRow {
  insertDemoTask.run(id, 'queued', cost, now, now)
  return selectDemoTask.get(id)!
}

export function readDemoTask(id: string): DemoTaskRow | undefined {
  return selectDemoTask.get(id)
}

export function advanceDemoTask(id: string, status: DemoTaskStatus, now = Date.now()): void {
  updateDemoTask.run(status, now, id)
}

/* ---------------------------------------------------------------- upkeep */

const deleteStaleLinkChallenges = db.prepare('delete from link_challenges where expires_at_ms < ? and consumed_at_ms is null')

/** Expired nonces, sessions and link challenges are dead weight; sweep them periodically. */
export function sweepExpired(now = Date.now()): void {
  deleteStaleNonces.run(now)
  deleteStaleSessions.run(now)
  deleteStaleLinkChallenges.run(now)
}

export const databaseFile = coreDb.file
export const financeDatabaseFile = financeDb.file
