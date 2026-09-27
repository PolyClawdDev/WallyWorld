/* ------------------------------------------------------------------ *
 * Durable storage: SQLite via better-sqlite3.
 *
 * Replaces the previous in-memory Map, which lost every record on
 * restart. Every statement is prepared with bound parameters, so no
 * caller-supplied value is ever concatenated into SQL.
 *
 * Lamport amounts are stored as TEXT holding a decimal integer. SQLite
 * would hold a 64-bit integer happily, but better-sqlite3 hands those
 * back as JS numbers by default; keeping the text form means an amount
 * round-trips through the database as an exact bigint with no float or
 * precision decision anywhere in the path.
 * ------------------------------------------------------------------ */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DB_PATH } from './config'
import { DEFAULT_PROFILE, type Profile, type ProfileStyle } from '../shared/profile'

const absolutePath = resolve(DB_PATH)
mkdirSync(dirname(absolutePath), { recursive: true })

export const db = new Database(absolutePath)

// WAL keeps readers from blocking on the writer; foreign_keys is on for correctness
// if relations are added later.
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 4000')

db.exec(`
  create table if not exists profiles (
    wallet        text primary key,
    character     text not null,
    style_json    text not null,
    player_name   text not null,
    gold          integer not null,
    last_cluster  text not null,
    created_at_ms integer not null,
    updated_at_ms integer not null
  );

  create table if not exists nonces (
    nonce          text primary key,
    wallet         text not null,
    domain         text not null,
    uri            text not null,
    chain_id       text not null,
    issued_at      text not null,
    expiration     text not null,
    expires_at_ms  integer not null,
    consumed_at_ms integer
  );
  create index if not exists nonces_expiry on nonces(expires_at_ms);

  create table if not exists sessions (
    token_sha256  text primary key,
    wallet        text not null,
    created_at_ms integer not null,
    expires_at_ms integer not null,
    last_seen_ms  integer not null
  );
  create index if not exists sessions_wallet on sessions(wallet);
  create index if not exists sessions_expiry on sessions(expires_at_ms);

  create table if not exists receipts (
    signature      text primary key,
    wallet         text not null,
    service        text not null,
    recipient      text not null,
    lamports       text not null,
    cluster        text not null,
    status         text not null,
    detail         text,
    created_at_ms  integer not null,
    updated_at_ms  integer not null,
    confirmed_at_ms integer
  );
  create index if not exists receipts_wallet on receipts(wallet, created_at_ms desc);

  -- The pre-existing scripted Archivist demo, moved off the in-memory Map so a
  -- restart no longer loses it. Still a demo: 'cost' is demo credits, not money.
  create table if not exists demo_tasks (
    id            text primary key,
    status        text not null,
    cost          integer not null,
    created_at_ms integer not null,
    updated_at_ms integer not null
  );
`)

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

export type StoredProfile = { profile: Profile; updatedAtMs: number }

/**
 * Reads one wallet's record. A stored style that no longer parses falls back to
 * the default rather than throwing, so a schema change cannot lock a player out
 * of their own save.
 */
export function readProfile(wallet: string): StoredProfile | null {
  const row = selectProfile.get(wallet)
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

export function writeProfile(wallet: string, profile: Profile, cluster: string, now = Date.now()): StoredProfile {
  upsertProfile.run({
    wallet,
    character: profile.character,
    style_json: JSON.stringify(profile.style),
    player_name: profile.playerName,
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

/** Returns the wallet this session belongs to, or null. Expired rows are removed on sight. */
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

/* ---------------------------------------------------------------- receipts */

export type ReceiptStatus = 'submitted' | 'confirmed' | 'failed' | 'unknown'

export type ReceiptRow = {
  signature: string
  wallet: string
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

/**
 * Idempotent on the transaction signature. A retried submission re-reads the
 * existing row instead of creating a second receipt for one payment, which is
 * what makes the client safe to retry after a dropped response.
 */
const insertReceipt = db.prepare(`
  insert into receipts (signature, wallet, service, recipient, lamports, cluster, status, detail, created_at_ms, updated_at_ms)
  values (@signature, @wallet, @service, @recipient, @lamports, @cluster, @status, @detail, @now, @now)
  on conflict(signature) do nothing
`)

const selectReceipt = db.prepare<[string], ReceiptRow>('select * from receipts where signature = ?')

const updateReceiptStatus = db.prepare(`
  update receipts
     set status = @status,
         detail = @detail,
         updated_at_ms = @now,
         confirmed_at_ms = case when @status = 'confirmed' then coalesce(confirmed_at_ms, @now) else confirmed_at_ms end
   where signature = @signature
`)

const selectReceiptsForWallet = db.prepare<[string, number], ReceiptRow>(
  'select * from receipts where wallet = ? order by created_at_ms desc limit ?',
)

export function recordReceipt(row: {
  signature: string
  wallet: string
  service: string
  recipient: string
  lamports: bigint
  cluster: string
  status: ReceiptStatus
  detail: string | null
  now?: number
}): ReceiptRow {
  insertReceipt.run({ ...row, lamports: row.lamports.toString(), now: row.now ?? Date.now() })
  // Non-null: either the insert landed or a row with this signature already existed.
  return selectReceipt.get(row.signature)!
}

export function readReceipt(signature: string): ReceiptRow | undefined {
  return selectReceipt.get(signature)
}

export function setReceiptStatus(signature: string, status: ReceiptStatus, detail: string | null, now = Date.now()): void {
  updateReceiptStatus.run({ signature, status, detail, now })
}

export function listReceipts(wallet: string, limit = 20): ReceiptRow[] {
  return selectReceiptsForWallet.all(wallet, limit)
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

/** Expired nonces and sessions are dead weight; sweep them periodically. */
export function sweepExpired(now = Date.now()): void {
  deleteStaleNonces.run(now)
  deleteStaleSessions.run(now)
}

export const databaseFile = absolutePath
