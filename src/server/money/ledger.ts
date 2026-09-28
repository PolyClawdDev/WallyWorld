/* ------------------------------------------------------------------ *
 * The one authoritative gold ledger.
 *
 * Append-only and double-entry. A transfer is a set of legs whose signed
 * amounts sum to zero; a leg is one row in `ledger_entries`; no row is
 * ever updated or deleted, and the database enforces that with triggers
 * rather than trusting this file.
 *
 * Gold is created by moving it out of `system:gold:mint`, which is the one
 * account allowed to hold a negative balance. That is why "the ledger
 * balances" is a real query: the sum of every balance is always exactly
 * zero, and an operation that minted or destroyed gold would break it.
 *
 * Concurrency safety is the same technique `db.ts` uses for nonces. Every
 * balance write is a conditional UPDATE that matches the row's current
 * version *and* its current amount:
 *
 *     update ledger_balances set amount = ?, version = version + 1
 *      where account_id = ? and version = ? and amount = ?
 *
 * so of two writers holding the same snapshot, exactly one can land. The
 * whole transfer runs inside BEGIN IMMEDIATE, so the read that produced
 * the snapshot and the write that consumes it are serialisable across
 * processes, not just within one.
 *
 * Every comparison and every sum happens in bigint. No SQL in this file
 * casts a money column or adds one up.
 * ------------------------------------------------------------------ */

import { createHash, randomBytes } from 'node:crypto'
import { financeDb, immediateTransaction } from '../store'
import { fromStored, toStored } from './amount'
import { isRedeemable, type Provenance } from './provenance'

export const GOLD = 'GOLD' as const

/**
 * Lamports appear in the ledger only as *treasury* balances.
 *
 * The treasury is unfunded and there is no signer, so these accounts exist to
 * make a withdrawal's budget reservation a real ledger operation rather than a
 * placeholder. Nothing credits `treasury:lamports:campaign` outside a test.
 */
export const LAMPORTS = 'LAMPORTS' as const

export type Currency = typeof GOLD | typeof LAMPORTS

export type AccountKind = 'player' | 'system' | 'escrow' | 'treasury' | 'pending'

const db = financeDb

const newId = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`

/* ------------------------------------------------------------------ names */

/**
 * Account names are structured strings rather than foreign keys, because the row
 * they would point at lives in the other database. The structure is the contract:
 * `user:<userId>:gold:available` is parsed nowhere and compared everywhere.
 */
export const playerAvailable = (userId: string) => `user:${userId}:gold:available`
export const playerReserved = (userId: string) => `user:${userId}:gold:reserved`

export const SYSTEM_MINT = 'system:gold:mint'
export const SYSTEM_SINK = 'system:gold:sink'
export const TREASURY_GOLD = 'treasury:gold:campaign'

export const SYSTEM_LAMPORTS_MINT = 'system:lamports:mint'
export const TREASURY_LAMPORTS = 'treasury:lamports:campaign'
export const withdrawalLamports = (withdrawalId: string) => `withdrawal:${withdrawalId}:lamports`

/* --------------------------------------------------------------- accounts */

const insertAccount = db.raw.prepare(`
  insert into ledger_accounts (account_id, currency, kind, owner_user_id, allow_negative, created_at_ms)
  values (@account_id, @currency, @kind, @owner_user_id, @allow_negative, @now)
  on conflict (account_id) do nothing
`)

const insertBalance = db.raw.prepare(`
  insert into ledger_balances (account_id, currency, amount, version, updated_at_ms)
  values (@account_id, @currency, '0', 0, @now)
  on conflict (account_id) do nothing
`)

const selectAccount = db.raw.prepare<[string], { account_id: string; allow_negative: number; currency: string }>(
  'select account_id, allow_negative, currency from ledger_accounts where account_id = ?',
)

const selectBalance = db.raw.prepare<[string], { amount: string; version: number }>(
  'select amount, version from ledger_balances where account_id = ?',
)

/**
 * Conditional balance write. Matches version *and* prior amount, so a stale
 * snapshot cannot overwrite a newer one even if the version counter were somehow
 * reused. Returns whether it landed; the caller treats a miss as contention.
 */
const writeBalance = db.raw.prepare(`
  update ledger_balances
     set amount = @next,
         version = version + 1,
         updated_at_ms = @now
   where account_id = @account_id
     and version = @version
     and amount = @previous
`)

export type AccountSpec = {
  accountId: string
  kind: AccountKind
  ownerUserId?: string | null
  allowNegative?: boolean
  currency?: Currency
}

export function ensureLedgerAccount(spec: AccountSpec, now = Date.now()): void {
  insertAccount.run({
    account_id: spec.accountId,
    currency: spec.currency ?? GOLD,
    kind: spec.kind,
    owner_user_id: spec.ownerUserId ?? null,
    allow_negative: spec.allowNegative ? 1 : 0,
    now,
  })
  insertBalance.run({ account_id: spec.accountId, currency: spec.currency ?? GOLD, now })
}

/** The system counterparties. Idempotent, and cheap enough to call on every open. */
export function ensureSystemAccounts(now = Date.now()): void {
  ensureLedgerAccount({ accountId: SYSTEM_MINT, kind: 'system', allowNegative: true }, now)
  ensureLedgerAccount({ accountId: SYSTEM_SINK, kind: 'system', allowNegative: true }, now)
  ensureLedgerAccount({ accountId: TREASURY_GOLD, kind: 'treasury' }, now)
  ensureLedgerAccount({ accountId: SYSTEM_LAMPORTS_MINT, kind: 'system', allowNegative: true, currency: LAMPORTS }, now)
  ensureLedgerAccount({ accountId: TREASURY_LAMPORTS, kind: 'treasury', currency: LAMPORTS }, now)
}

export function ensurePlayerAccounts(userId: string, now = Date.now()): void {
  ensureLedgerAccount({ accountId: playerAvailable(userId), kind: 'player', ownerUserId: userId }, now)
  ensureLedgerAccount({ accountId: playerReserved(userId), kind: 'player', ownerUserId: userId }, now)
}

export function balanceOf(accountId: string): bigint {
  const row = selectBalance.get(accountId)
  return row ? fromStored(row.amount) : 0n
}

/* ------------------------------------------------------------- eligibility */

const insertEligibility = db.raw.prepare(`
  insert into reward_eligibility (user_id, currency, accrued, consumed, version, updated_at_ms)
  values (@user_id, @currency, '0', '0', 0, @now)
  on conflict (user_id) do nothing
`)

const selectEligibility = db.raw.prepare<[string], { accrued: string; consumed: string; version: number }>(
  'select accrued, consumed, version from reward_eligibility where user_id = ?',
)

const writeEligibility = db.raw.prepare(`
  update reward_eligibility
     set accrued = @accrued,
         consumed = @consumed,
         version = version + 1,
         updated_at_ms = @now
   where user_id = @user_id
     and version = @version
`)

export type Eligibility = { accrued: bigint; consumed: bigint; redeemable: bigint }

/**
 * Redeemable gold is `min(accrued − consumed, available balance)`.
 *
 * The `min` is what makes this conservative without per-debit bookkeeping: a
 * player who earns 100 redeemable gold hunting and then loses 80 of it in a duel
 * has 20 available, so 20 redeemable — the loss reduced it automatically. And a
 * player who wins 500 in duels raises `available` but not `accrued`, so winning
 * cannot manufacture redeemable gold.
 */
export function eligibilityOf(userId: string): Eligibility {
  const row = selectEligibility.get(userId)
  const accrued = row ? fromStored(row.accrued) : 0n
  const consumed = row ? fromStored(row.consumed) : 0n
  const headroom = accrued - consumed
  const available = balanceOf(playerAvailable(userId))
  const redeemable = headroom < 0n ? 0n : headroom < available ? headroom : available
  return { accrued, consumed, redeemable: redeemable < 0n ? 0n : redeemable }
}

/* --------------------------------------------------------------- transfers */

const insertTransfer = db.raw.prepare(`
  insert into ledger_transfers (transfer_id, kind, currency, idem_scope, idem_key, ref_type, ref_id, note, created_at_ms)
  values (@transfer_id, @kind, @currency, @idem_scope, @idem_key, @ref_type, @ref_id, @note, @now)
  on conflict (idem_scope, idem_key) do nothing
`)

const selectTransferByIdem = db.raw.prepare<[string, string], { transfer_id: string }>(
  'select transfer_id from ledger_transfers where idem_scope = ? and idem_key = ?',
)

const insertEntry = db.raw.prepare(`
  insert into ledger_entries (entry_id, transfer_id, leg, account_id, currency, amount, provenance, redeemable, owner_user_id, note, created_at_ms)
  values (@entry_id, @transfer_id, @leg, @account_id, @currency, @amount, @provenance, @redeemable, @owner_user_id, @note, @now)
`)

export type Leg = {
  accountId: string
  /** Signed base units. Negative debits, positive credits. */
  amount: bigint
  provenance: Provenance
  ownerUserId?: string | null
  note?: string
}

export type PostInput = {
  kind: string
  /** Idempotency is (scope, key). A repeat of the same pair is a no-op that reports itself. */
  idemScope: string
  idemKey: string
  legs: readonly Leg[]
  note: string
  refType?: string | null
  refId?: string | null
  currency?: Currency
  now?: number
  /** Accounts that may end the transfer negative, beyond those declared so. */
  allowNegative?: readonly string[]
}

export type PostResult =
  | { ok: true; transferId: string; idempotent: boolean }
  | { ok: false; reason: string; code: PostFailure }

export type PostFailure =
  | 'unbalanced'
  | 'too_few_legs'
  | 'unknown_account'
  | 'insufficient_funds'
  | 'contention'
  | 'invalid_amount'

/**
 * Writes one balanced transfer, or nothing.
 *
 * Order of operations matters and is deliberate:
 *   1. reject legs that do not sum to zero, before touching anything;
 *   2. claim the idempotency key — the insert is `on conflict do nothing`, so a
 *      repeat changes no rows and the original transfer id is returned;
 *   3. read every affected balance inside the transaction;
 *   4. check each resulting balance against zero in bigint;
 *   5. write each balance with the conditional UPDATE;
 *   6. append the entries.
 *
 * Step 4 is the overspend guard and step 5 is the race guard. They are separate
 * on purpose: the bigint check is what makes the *rule* correct and the
 * conditional UPDATE is what makes it correct under contention.
 */
export function postTransfer(input: PostInput): PostResult {
  const now = input.now ?? Date.now()
  const currency = input.currency ?? GOLD
  if (input.legs.length < 2) return { ok: false, code: 'too_few_legs', reason: 'a transfer needs at least two legs' }

  let total = 0n
  for (const leg of input.legs) {
    if (leg.amount === 0n) return { ok: false, code: 'invalid_amount', reason: 'a leg of zero moves nothing' }
    total += leg.amount
  }
  if (total !== 0n) return { ok: false, code: 'unbalanced', reason: `legs sum to ${total}, not zero` }

  const extraNegative = new Set(input.allowNegative ?? [])

  // Derived rather than random, so a retry computes the same id and the
  // append-only table never has to be patched after the fact.
  const transferId = transferIdFor(input.idemScope, input.idemKey)

  return immediateTransaction(db, (): PostResult => {
    const claim = insertTransfer.run({
      transfer_id: transferId,
      kind: input.kind,
      currency,
      idem_scope: input.idemScope,
      idem_key: input.idemKey,
      ref_type: input.refType ?? null,
      ref_id: input.refId ?? null,
      note: input.note,
      now,
    })
    if (claim.changes === 0) {
      // The idempotency pair was already claimed. Whatever that first call wrote
      // stands; this one writes nothing and says so.
      const existing = selectTransferByIdem.get(input.idemScope, input.idemKey)
      if (!existing) return { ok: false, code: 'contention', reason: 'idempotency key vanished mid-transaction' }
      return { ok: true, transferId: existing.transfer_id, idempotent: true }
    }

    // Net movement per account, so a transfer that touches one account twice is
    // checked once against its final position.
    const net = new Map<string, bigint>()
    for (const leg of input.legs) net.set(leg.accountId, (net.get(leg.accountId) ?? 0n) + leg.amount)

    const snapshots = new Map<string, { amount: bigint; version: number; allowNegative: boolean }>()
    for (const accountId of net.keys()) {
      const account = selectAccount.get(accountId)
      const balance = selectBalance.get(accountId)
      if (!account || !balance) return { ok: false, code: 'unknown_account', reason: `ledger account ${accountId} does not exist` }
      snapshots.set(accountId, {
        amount: fromStored(balance.amount),
        version: balance.version,
        allowNegative: account.allow_negative === 1 || extraNegative.has(accountId),
      })
    }

    for (const [accountId, delta] of net) {
      const snapshot = snapshots.get(accountId)!
      const next = snapshot.amount + delta
      if (next < 0n && !snapshot.allowNegative) {
        return {
          ok: false,
          code: 'insufficient_funds',
          reason: `${accountId} holds ${snapshot.amount} and cannot fund ${-delta}`,
        }
      }
    }

    for (const [accountId, delta] of net) {
      const snapshot = snapshots.get(accountId)!
      const landed = writeBalance.run({
        account_id: accountId,
        next: toStored(snapshot.amount + delta),
        previous: toStored(snapshot.amount),
        version: snapshot.version,
        now,
      })
      if (landed.changes !== 1) {
        // Another writer moved this balance between the read and the write. The
        // transaction rolls back whole; the caller retries or reports.
        return { ok: false, code: 'contention', reason: `${accountId} changed underneath this transfer` }
      }
    }

    let leg = 0
    for (const entry of input.legs) {
      insertEntry.run({
        entry_id: newId('le'),
        transfer_id: transferId,
        leg,
        account_id: entry.accountId,
        currency,
        amount: toStored(entry.amount),
        provenance: entry.provenance,
        redeemable: entry.amount > 0n && isRedeemable(entry.provenance) ? 1 : 0,
        owner_user_id: entry.ownerUserId ?? null,
        note: entry.note ?? input.note,
        now,
      })
      leg += 1
    }

    // Redeemable accrual. Only a positive leg into a player's available account
    // with a redeemable provenance moves the needle.
    for (const entry of input.legs) {
      if (entry.amount <= 0n) continue
      if (!entry.ownerUserId) continue
      if (entry.accountId !== playerAvailable(entry.ownerUserId)) continue
      if (!isRedeemable(entry.provenance)) continue
      if (!accrueEligible(entry.ownerUserId, entry.amount, now)) {
        return { ok: false, code: 'contention', reason: 'reward eligibility changed underneath this transfer' }
      }
    }

    return { ok: true, transferId, idempotent: false }
  })
}

/**
 * The transfer id is derived from the idempotency pair rather than random.
 *
 * That keeps the append-only rule and idempotency compatible: a retry recomputes
 * the same id, so there is never a moment where a second id has to be reconciled
 * against a first.
 */
function transferIdFor(scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\u0000${key}`, 'utf8').digest('hex')
  return `lt_${digest.slice(0, 32)}`
}

/* ------------------------------------------------------------- accrual */

function accrueEligible(userId: string, amount: bigint, now: number): boolean {
  insertEligibility.run({ user_id: userId, currency: GOLD, now })
  const row = selectEligibility.get(userId)
  if (!row) return false
  return (
    writeEligibility.run({
      user_id: userId,
      accrued: toStored(fromStored(row.accrued) + amount),
      consumed: row.consumed,
      version: row.version,
      now,
    }).changes === 1
  )
}

/** Raises `consumed`, which lowers redeemable gold. Used when a withdrawal reserves. */
export function consumeEligible(userId: string, amount: bigint, now = Date.now()): boolean {
  insertEligibility.run({ user_id: userId, currency: GOLD, now })
  const row = selectEligibility.get(userId)
  if (!row) return false
  const consumed = fromStored(row.consumed) + amount
  if (consumed > fromStored(row.accrued)) return false
  return (
    writeEligibility.run({
      user_id: userId,
      accrued: row.accrued,
      consumed: toStored(consumed),
      version: row.version,
      now,
    }).changes === 1
  )
}

/** Lowers `consumed` again when a withdrawal reservation is released. */
export function releaseEligible(userId: string, amount: bigint, now = Date.now()): boolean {
  const row = selectEligibility.get(userId)
  if (!row) return false
  const consumed = fromStored(row.consumed) - amount
  if (consumed < 0n) return false
  return (
    writeEligibility.run({
      user_id: userId,
      accrued: row.accrued,
      consumed: toStored(consumed),
      version: row.version,
      now,
    }).changes === 1
  )
}

/* ------------------------------------------------------------ conservation */

const allBalances = db.raw.prepare<[], { account_id: string; amount: string }>(
  'select account_id, amount from ledger_balances',
)

const allEntries = db.raw.prepare<[], { transfer_id: string; account_id: string; amount: string }>(
  'select transfer_id, account_id, amount from ledger_entries',
)

export type ConservationReport = {
  ok: boolean
  balanceSum: bigint
  entrySum: bigint
  unbalancedTransfers: string[]
  driftedAccounts: Array<{ accountId: string; balance: bigint; entrySum: bigint }>
}

/**
 * The "does the ledger balance" query, run in bigint.
 *
 * Three independent checks, because they fail in different ways:
 *   - every balance summed is zero: nothing was minted or destroyed;
 *   - every transfer's legs sum to zero: no half-written movement;
 *   - each account's balance equals the sum of its own entries: the
 *     materialised total has not drifted from the append-only history.
 */
export function conservationReport(): ConservationReport {
  let balanceSum = 0n
  const balances = new Map<string, bigint>()
  for (const row of allBalances.all()) {
    const amount = fromStored(row.amount)
    balances.set(row.account_id, amount)
    balanceSum += amount
  }

  let entrySum = 0n
  const perTransfer = new Map<string, bigint>()
  const perAccount = new Map<string, bigint>()
  for (const row of allEntries.all()) {
    const amount = fromStored(row.amount)
    entrySum += amount
    perTransfer.set(row.transfer_id, (perTransfer.get(row.transfer_id) ?? 0n) + amount)
    perAccount.set(row.account_id, (perAccount.get(row.account_id) ?? 0n) + amount)
  }

  const unbalancedTransfers = [...perTransfer.entries()].filter(([, total]) => total !== 0n).map(([id]) => id)
  const driftedAccounts: ConservationReport['driftedAccounts'] = []
  for (const [accountId, balance] of balances) {
    const fromEntries = perAccount.get(accountId) ?? 0n
    if (fromEntries !== balance) driftedAccounts.push({ accountId, balance, entrySum: fromEntries })
  }

  return {
    ok: balanceSum === 0n && entrySum === 0n && unbalancedTransfers.length === 0 && driftedAccounts.length === 0,
    balanceSum,
    entrySum,
    unbalancedTransfers,
    driftedAccounts,
  }
}

/* ------------------------------------------------------------------ views */

const selectEntriesForOwner = db.raw.prepare<[string, number], {
  entry_id: string
  transfer_id: string
  account_id: string
  amount: string
  provenance: string
  redeemable: number
  note: string
  created_at_ms: number
}>(`
  select entry_id, transfer_id, account_id, amount, provenance, redeemable, note, created_at_ms
    from ledger_entries
   where owner_user_id = ?
   order by created_at_ms desc, entry_id desc
   limit ?
`)

export type LedgerEntryView = {
  entryId: string
  transferId: string
  account: string
  amount: string
  provenance: string
  redeemable: boolean
  note: string
  atMs: number
}

/** Owner-scoped. The caller has already resolved the user from the session. */
export function entriesForUser(userId: string, limit = 50): LedgerEntryView[] {
  return selectEntriesForOwner.all(userId, limit).map(row => ({
    entryId: row.entry_id,
    transferId: row.transfer_id,
    account: row.account_id,
    amount: row.amount,
    provenance: row.provenance,
    redeemable: row.redeemable === 1,
    note: row.note,
    atMs: row.created_at_ms,
  }))
}

const selectProvenanceTotals = db.raw.prepare<[string, string], { provenance: string; amount: string }>(
  'select provenance, amount from ledger_entries where owner_user_id = ? and amount not like ?',
)

/** Lifetime credits per provenance, so the UI can say where a balance came from. */
export function creditsByProvenance(userId: string): Record<string, string> {
  const totals = new Map<string, bigint>()
  // `not like '-%'` keeps this to credit legs without a numeric comparison in SQL.
  for (const row of selectProvenanceTotals.all(userId, '-%')) {
    totals.set(row.provenance, (totals.get(row.provenance) ?? 0n) + fromStored(row.amount))
  }
  const out: Record<string, string> = {}
  for (const [provenance, amount] of totals) out[provenance] = toStored(amount)
  return out
}

ensureSystemAccounts()
