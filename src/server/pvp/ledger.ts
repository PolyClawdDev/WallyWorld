/* ------------------------------------------------------------------ *
 * PvP's view of the one gold ledger.
 *
 * This module used to *be* the gold ledger: a `game_gold` row per player
 * with an `available` integer, sitting in the same database file as
 * `profiles`. It is now an adapter. Balances live in the financial
 * database as append-only double-entry records, hunting and PvP credit
 * the same account, and the separate PvP stipend is gone — replaced by a
 * one-time starting grant on that same ledger, with `gift` provenance so
 * it can never be redeemed.
 *
 * The exported shape is unchanged so the duel hub, the challenge code and
 * the existing test suite did not have to be rewritten alongside the
 * storage. What changed underneath:
 *
 *   - a balance is the materialised total of an append-only entry list,
 *     not a mutable integer;
 *   - reserving both stakes is one four-leg transfer rather than two
 *     UPDATEs with a compensating rollback;
 *   - settlement is idempotent on the transfer's idempotency key rather
 *     than on a uniqueness index over a ledger note;
 *   - win/loss/draw counts moved to `pvp_records` in the game database,
 *     because a scoreboard is game data and has no business in a
 *     financial table.
 * ------------------------------------------------------------------ */

import { DEMO_GOLD_NOTICE, GOLD_KIND, MAX_STAKE, type GoldView } from '../../shared/pvp'
import { toSafeNumber } from '../money/amount'
import {
  creditGold as creditLedgerGold,
  ensureGoldAccounts,
  goldSnapshot,
  playerGoldTotals,
  reservePairGold,
  settleDuelGold,
} from '../money/gold'
import type { Provenance } from '../money/provenance'
import { userIdForPlayer } from './ids'
import { db } from './schema'

export type GoldRow = {
  player_id: string
  available: number
  reserved: number
  wins: number
  losses: number
  draws: number
}

export type LedgerKind = 'stipend' | 'reserve' | 'release' | 'payout' | 'adjust'

/**
 * The old `kind` vocabulary mapped onto real provenance.
 *
 * `adjust` is what tests and development tools used, so it becomes
 * `test_credit` — visible, and never redeemable.
 */
const PROVENANCE_FOR_KIND: Record<LedgerKind, Provenance> = {
  stipend: 'gift',
  adjust: 'test_credit',
  payout: 'pvp_winnings',
  reserve: 'escrow',
  release: 'escrow',
}

/* -------------------------------------------------------------- records */

const insertRecord = db
  .prepare(`insert into pvp_records (player_id, wins, losses, draws, updated_at_ms)
            values (@player_id, 0, 0, 0, @now)
            on conflict (player_id) do nothing`)

const selectRecord = db.prepare<[string], { wins: number; losses: number; draws: number }>(
  'select wins, losses, draws from pvp_records where player_id = ?',
)

const bumpRecord = db.prepare(`
  update pvp_records
     set wins = wins + @w,
         losses = losses + @l,
         draws = draws + @d,
         updated_at_ms = @now
   where player_id = @player_id
`)

function recordOf(playerId: string, now = Date.now()) {
  insertRecord.run({ player_id: playerId, now })
  return selectRecord.get(playerId) ?? { wins: 0, losses: 0, draws: 0 }
}

/* ---------------------------------------------------------------- reads */

/**
 * Balance plus scoreboard for one player.
 *
 * The amounts are converted from bigint at this boundary because the PvP wire
 * protocol carries JS numbers. `toSafeNumber` throws rather than rounds, so the
 * conversion cannot quietly lose a unit.
 */
export function readGold(playerId: string): GoldRow {
  const userId = userIdForPlayer(playerId)
  if (!userId) return { player_id: playerId, available: 0, reserved: 0, wins: 0, losses: 0, draws: 0 }
  ensureGoldAccounts(userId)
  const snapshot = goldSnapshot(userId)
  const record = recordOf(playerId)
  return {
    player_id: playerId,
    available: toSafeNumber(snapshot.available),
    reserved: toSafeNumber(snapshot.reserved),
    wins: record.wins,
    losses: record.losses,
    draws: record.draws,
  }
}

export function goldView(playerId: string): GoldView {
  const row = readGold(playerId)
  const userId = userIdForPlayer(playerId)
  const redeemable = userId ? toSafeNumber(goldSnapshot(userId).redeemable) : 0
  return {
    total: row.available + row.reserved,
    available: row.available,
    reserved: row.reserved,
    redeemable,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    goldKind: GOLD_KIND,
    demo: true,
    notice: DEMO_GOLD_NOTICE,
  }
}

/* --------------------------------------------------------------- writes */

/**
 * Credits a player, idempotently on `(kind, refId)` as before.
 *
 * Kept signature-compatible with the previous module so the duel hub and the
 * existing tests did not change; the provenance is derived rather than accepted,
 * so no caller can mark its own credit redeemable.
 */
export function creditGold(
  playerId: string,
  amount: number,
  kind: LedgerKind,
  refType: string,
  refId: string,
  note: string,
  now = Date.now(),
): GoldRow {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_STAKE) throw new Error('invalid credit')
  const userId = userIdForPlayer(playerId)
  // Deliberately a refusal rather than an account creation. A player id is not a
  // principal, so there is nothing here to prove who it belongs to, and creating
  // an account on a credit path would mean a mistyped id ends up holding gold.
  // The player has to have connected at least once.
  if (!userId) throw new Error(`no account for player ${playerId}; they have to sign in once before gold can be credited`)
  creditLedgerGold({
    userId,
    amount: BigInt(amount),
    provenance: PROVENANCE_FOR_KIND[kind],
    idemScope: `pvp-credit:${kind}`,
    idemKey: `${userId}:${refId}`,
    refType,
    refId,
    note,
    now,
  })
  return readGold(playerId)
}

export type ReserveResult = { ok: true; a: GoldRow; b: GoldRow } | { ok: false; reason: string }

/** Atomically reserve the same stake from both players. Idempotent on the duel id. */
export function reserveBoth(aId: string, bId: string, stake: number, duelId: string, now = Date.now()): ReserveResult {
  if (!Number.isInteger(stake) || stake <= 0 || stake > MAX_STAKE) return { ok: false, reason: 'stake must be a positive integer' }
  if (aId === bId) return { ok: false, reason: 'cannot reserve against yourself' }
  const aUserId = userIdForPlayer(aId)
  const bUserId = userIdForPlayer(bId)
  if (!aUserId || !bUserId) return { ok: false, reason: 'one of these players has no account' }

  const outcome = reservePairGold({ aUserId, bUserId, stake: BigInt(stake), duelId, now })
  if (!outcome.ok) {
    // `reservePairGold` names accounts by user id; translate back to the
    // challenger/opponent wording the UI already shows.
    const reason = outcome.reason.includes(aUserId)
      ? 'challenger cannot cover the stake'
      : outcome.reason.includes(bUserId)
        ? 'opponent cannot cover the stake'
        : outcome.reason
    return { ok: false, reason }
  }
  return { ok: true, a: readGold(aId), b: readGold(bId) }
}

export type SettleKind = 'payout' | 'refund' | 'void'

/** One settlement per duel, whichever way it ended. */
export function settleEscrow(input: {
  duelId: string
  aId: string
  bId: string
  stake: number
  kind: SettleKind
  winnerId?: string | null
  now?: number
}): { ok: true; idempotent: boolean } | { ok: false; reason: string } {
  const { duelId, aId, bId, stake, kind, winnerId } = input
  if (!Number.isInteger(stake) || stake <= 0) return { ok: false, reason: 'invalid stake' }
  const aUserId = userIdForPlayer(aId)
  const bUserId = userIdForPlayer(bId)
  if (!aUserId || !bUserId) return { ok: false, reason: 'one of these players has no account' }
  const winnerUserId = winnerId ? userIdForPlayer(winnerId) : null
  if (kind === 'payout' && !winnerUserId) return { ok: false, reason: 'payout needs a fighter id' }

  return settleDuelGold({
    duelId,
    aUserId,
    bUserId,
    stake: BigInt(stake),
    kind,
    winnerUserId,
    now: input.now,
  })
}

export function recordOutcome(winnerId: string | null, loserId: string | null, draw: boolean, now = Date.now()) {
  for (const id of [winnerId, loserId]) if (id) insertRecord.run({ player_id: id, now })
  if (draw) {
    if (winnerId) bumpRecord.run({ player_id: winnerId, w: 0, l: 0, d: 1, now })
    if (loserId) bumpRecord.run({ player_id: loserId, w: 0, l: 0, d: 1, now })
    return
  }
  if (winnerId) bumpRecord.run({ player_id: winnerId, w: 1, l: 0, d: 0, now })
  if (loserId) bumpRecord.run({ player_id: loserId, w: 0, l: 1, d: 0, now })
}

/**
 * Total gold held by players, available plus reserved.
 *
 * Kept for the escrow-conservation assertions that already existed. The stronger
 * statement — that the whole ledger sums to zero and every account's balance
 * matches its own entry history — is `money/gold.ts`'s `conservationReport`.
 */
export function conservationSum(): { available: number; reserved: number; total: number } {
  return playerGoldTotals()
}
