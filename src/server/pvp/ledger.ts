/* ------------------------------------------------------------------ *
 * Server-owned game gold. Integer base units. Separate from profile.gold
 * (client-asserted hunt loot), receipts (SOL), and NPC demo credits.
 * ------------------------------------------------------------------ */

import { DEMO_GOLD_NOTICE, GOLD_KIND, MAX_STAKE, type GoldView } from '../../shared/pvp'
import { db } from './schema'
import { newId } from './ids'

export type GoldRow = {
  player_id: string
  available: number
  reserved: number
  wins: number
  losses: number
  draws: number
}

export type LedgerKind =
  | 'stipend'
  | 'reserve'
  | 'release'
  | 'payout'
  | 'adjust'

const selectGold = db.prepare<[string], GoldRow>('select * from game_gold where player_id = ?')
const insertGold = db.prepare(`
  insert or ignore into game_gold (player_id, available, reserved, wins, losses, draws, updated_at_ms)
  values (?, 0, 0, 0, 0, 0, ?)
`)

const addAvailable = db.prepare(`
  update game_gold
     set available = available + @delta,
         updated_at_ms = @now
   where player_id = @player_id
     and available + @delta >= 0
`)

const addReserved = db.prepare(`
  update game_gold
     set reserved = reserved + @delta,
         updated_at_ms = @now
   where player_id = @player_id
     and reserved + @delta >= 0
`)

const moveAvailableToReserved = db.prepare(`
  update game_gold
     set available = available - @stake,
         reserved = reserved + @stake,
         updated_at_ms = @now
   where player_id = @player_id
     and available >= @stake
`)

const moveReservedToAvailable = db.prepare(`
  update game_gold
     set reserved = reserved - @stake,
         available = available + @stake,
         updated_at_ms = @now
   where player_id = @player_id
     and reserved >= @stake
`)

const consumeReserved = db.prepare(`
  update game_gold
     set reserved = reserved - @stake,
         updated_at_ms = @now
   where player_id = @player_id
     and reserved >= @stake
`)

const bumpRecord = db.prepare(`
  update game_gold
     set wins = wins + @w,
         losses = losses + @l,
         draws = draws + @d,
         updated_at_ms = @now
   where player_id = @player_id
`)

const insertLedger = db.prepare(`
  insert into game_gold_ledger (id, player_id, kind, amount, available_after, reserved_after, ref_type, ref_id, note, created_at_ms)
  values (@id, @player_id, @kind, @amount, @available_after, @reserved_after, @ref_type, @ref_id, @note, @now)
`)

const ledgerExists = db.prepare<[string, string, string], { id: string }>(
  'select id from game_gold_ledger where player_id = ? and kind = ? and ref_id = ?',
)

function mustGold(playerId: string): GoldRow {
  insertGold.run(playerId, Date.now())
  const row = selectGold.get(playerId)
  if (!row) throw new Error('game gold row missing')
  return row
}

function writeLedger(playerId: string, kind: LedgerKind, amount: number, refType: string, refId: string, note: string, now: number) {
  const after = mustGold(playerId)
  insertLedger.run({
    id: newId('s'),
    player_id: playerId,
    kind,
    amount,
    available_after: after.available,
    reserved_after: after.reserved,
    ref_type: refType,
    ref_id: refId,
    note,
    now,
  })
}

export function readGold(playerId: string): GoldRow {
  return mustGold(playerId)
}

export function goldView(playerId: string): GoldView {
  const row = mustGold(playerId)
  return {
    total: row.available + row.reserved,
    available: row.available,
    reserved: row.reserved,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    goldKind: GOLD_KIND,
    demo: true,
    notice: DEMO_GOLD_NOTICE,
  }
}

export function creditGold(playerId: string, amount: number, kind: LedgerKind, refType: string, refId: string, note: string, now = Date.now()) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_STAKE) throw new Error('invalid credit')
  if (ledgerExists.get(playerId, kind, refId)) return mustGold(playerId)
  const txn = db.transaction(() => {
    const moved = addAvailable.run({ player_id: playerId, delta: amount, now })
    if (moved.changes !== 1) throw new Error('credit failed')
    writeLedger(playerId, kind, amount, refType, refId, note, now)
    return mustGold(playerId)
  })
  return txn()
}

export type ReserveResult =
  | { ok: true; a: GoldRow; b: GoldRow }
  | { ok: false; reason: string }

/**
 * Atomically reserve the same stake from both players. Any failure
 * leaves neither reserved. Idempotent on (player, kind=reserve, duelId).
 */
export function reserveBoth(aId: string, bId: string, stake: number, duelId: string, now = Date.now()): ReserveResult {
  if (!Number.isInteger(stake) || stake <= 0 || stake > MAX_STAKE) return { ok: false, reason: 'stake must be a positive integer' }
  if (aId === bId) return { ok: false, reason: 'cannot reserve against yourself' }

  const txn = db.transaction((): ReserveResult => {
    const alreadyA = ledgerExists.get(aId, 'reserve', duelId)
    const alreadyB = ledgerExists.get(bId, 'reserve', duelId)
    if (alreadyA && alreadyB) return { ok: true, a: mustGold(aId), b: mustGold(bId) }
    if (alreadyA || alreadyB) return { ok: false, reason: 'partial reserve already exists' }

    const a = mustGold(aId)
    const b = mustGold(bId)
    if (a.available < stake) return { ok: false, reason: 'challenger cannot cover the stake' }
    if (b.available < stake) return { ok: false, reason: 'opponent cannot cover the stake' }

    const first = moveAvailableToReserved.run({ player_id: aId, stake, now })
    if (first.changes !== 1) return { ok: false, reason: 'challenger cannot cover the stake' }
    const second = moveAvailableToReserved.run({ player_id: bId, stake, now })
    if (second.changes !== 1) {
      moveReservedToAvailable.run({ player_id: aId, stake, now })
      return { ok: false, reason: 'opponent cannot cover the stake' }
    }
    writeLedger(aId, 'reserve', -stake, 'duel', duelId, 'Stake reserved in escrow', now)
    writeLedger(bId, 'reserve', -stake, 'duel', duelId, 'Stake reserved in escrow', now)
    return { ok: true, a: mustGold(aId), b: mustGold(bId) }
  })
  return txn()
}

export type SettleKind = 'payout' | 'refund' | 'void'

/**
 * One settlement per duel. Winner receives the pot (2 * stake).
 * Draw / void / refund returns each reserved stake exactly once.
 */
export function settleEscrow(input: {
  duelId: string
  aId: string
  bId: string
  stake: number
  kind: SettleKind
  winnerId?: string | null
  now?: number
}): { ok: true; idempotent: boolean } | { ok: false; reason: string } {
  const now = input.now ?? Date.now()
  const { duelId, aId, bId, stake, kind, winnerId } = input
  if (!Number.isInteger(stake) || stake <= 0) return { ok: false, reason: 'invalid stake' }

  const txn = db.transaction(() => {
    const settled = ledgerExists.get(aId, kind === 'payout' ? 'payout' : 'release', duelId)
      || ledgerExists.get(bId, kind === 'payout' ? 'payout' : 'release', duelId)
    if (settled) return { ok: true as const, idempotent: true }

    if (kind === 'payout') {
      if (!winnerId || (winnerId !== aId && winnerId !== bId)) return { ok: false as const, reason: 'payout needs a fighter id' }
      const loserId = winnerId === aId ? bId : aId
      const takeA = consumeReserved.run({ player_id: aId, stake, now })
      const takeB = consumeReserved.run({ player_id: bId, stake, now })
      if (takeA.changes !== 1 || takeB.changes !== 1) return { ok: false as const, reason: 'reserved stake missing' }
      const pot = stake * 2
      const paid = addAvailable.run({ player_id: winnerId, delta: pot, now })
      if (paid.changes !== 1) return { ok: false as const, reason: 'payout credit failed' }
      writeLedger(winnerId, 'payout', pot, 'duel', duelId, 'Pot paid to winner', now)
      writeLedger(loserId, 'release', 0, 'duel', duelId, 'Stake consumed by loss', now)
      return { ok: true as const, idempotent: false }
    }

    const backA = moveReservedToAvailable.run({ player_id: aId, stake, now })
    const backB = moveReservedToAvailable.run({ player_id: bId, stake, now })
    if (backA.changes !== 1 || backB.changes !== 1) return { ok: false as const, reason: 'reserved stake missing' }
    writeLedger(aId, 'release', stake, 'duel', duelId, kind === 'void' ? 'Voided — stake returned' : 'Stake refunded', now)
    writeLedger(bId, 'release', stake, 'duel', duelId, kind === 'void' ? 'Voided — stake returned' : 'Stake refunded', now)
    return { ok: true as const, idempotent: false }
  })
  return txn()
}

export function recordOutcome(winnerId: string | null, loserId: string | null, draw: boolean, now = Date.now()) {
  if (draw) {
    if (winnerId) bumpRecord.run({ player_id: winnerId, w: 0, l: 0, d: 1, now })
    if (loserId) bumpRecord.run({ player_id: loserId, w: 0, l: 0, d: 1, now })
    return
  }
  if (winnerId) bumpRecord.run({ player_id: winnerId, w: 1, l: 0, d: 0, now })
  if (loserId) bumpRecord.run({ player_id: loserId, w: 0, l: 1, d: 0, now })
}

export function conservationSum(): { available: number; reserved: number; total: number } {
  const row = db.prepare('select coalesce(sum(available),0) as available, coalesce(sum(reserved),0) as reserved from game_gold').get() as {
    available: number
    reserved: number
  }
  return { available: row.available, reserved: row.reserved, total: row.available + row.reserved }
}
