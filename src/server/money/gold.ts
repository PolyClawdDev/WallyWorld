/* ------------------------------------------------------------------ *
 * Gold, in account terms.
 *
 * This is the only module the game is allowed to move gold through.
 * Hunting, inventory, inspection, PvP escrow and withdrawals all land
 * here, which is what makes the balance single and authoritative: there is
 * no second place a credit can come from.
 *
 * Every operation below is one balanced ledger transfer with an explicit
 * idempotency key, so a retried request applies once. Gold enters the
 * world only out of `system:gold:mint` and leaves only into
 * `system:gold:sink`, so the sum of every balance stays zero and the
 * conservation test is meaningful rather than decorative.
 * ------------------------------------------------------------------ */

import { MAX_STAKE } from '../../shared/pvp'
import { financeDb } from '../store'
import { toSafeNumber, toStored } from './amount'
import {
  SYSTEM_MINT,
  SYSTEM_SINK,
  balanceOf,
  conservationReport,
  creditsByProvenance,
  eligibilityOf,
  ensurePlayerAccounts,
  playerAvailable,
  playerReserved,
  postTransfer,
  type PostResult,
} from './ledger'
import { PROVENANCE_NOTES, isRedeemable, type Provenance } from './provenance'

/** Upper bound on any single gold movement. Matches the PvP stake ceiling. */
export const MAX_GOLD_MOVE = BigInt(MAX_STAKE)

/**
 * The one-time starting grant.
 *
 * This is the PvP stipend's replacement. It is no longer a PvP-only balance in a
 * PvP-only table: it is a credit on the single ledger with `gift` provenance, so
 * it funds hunting, inspection and duels alike and is not redeemable. The amount
 * is unchanged so existing balances and tests are not disturbed by the move.
 */
export const STARTING_GRANT_GOLD = 250n

export type GoldSnapshot = {
  available: bigint
  reserved: bigint
  total: bigint
  redeemable: bigint
  accrued: bigint
  consumed: bigint
}

export function ensureGoldAccounts(userId: string, now = Date.now()): void {
  ensurePlayerAccounts(userId, now)
}

export function goldSnapshot(userId: string): GoldSnapshot {
  const available = balanceOf(playerAvailable(userId))
  const reserved = balanceOf(playerReserved(userId))
  const eligibility = eligibilityOf(userId)
  return {
    available,
    reserved,
    total: available + reserved,
    redeemable: eligibility.redeemable,
    accrued: eligibility.accrued,
    consumed: eligibility.consumed,
  }
}

/** Where a player's lifetime credits came from, and whether each could be redeemed. */
export function provenanceBreakdown(userId: string) {
  const credits = creditsByProvenance(userId)
  return Object.entries(credits).map(([provenance, amount]) => ({
    provenance,
    amount,
    redeemable: isRedeemable(provenance as Provenance),
    note: PROVENANCE_NOTES[provenance as Provenance] ?? 'Unknown origin. Treated as not redeemable.',
  }))
}

/* ------------------------------------------------------------------ credit */

export type CreditInput = {
  userId: string
  amount: bigint
  provenance: Provenance
  idemScope: string
  idemKey: string
  note: string
  refType?: string | null
  refId?: string | null
  now?: number
}

/**
 * Creates gold and credits it to a player.
 *
 * The counterparty is `system:gold:mint`, which goes more negative by exactly the
 * amount credited. That is what "no operation mints gold" means concretely: gold
 * is not conjured, it is moved out of an account whose negative balance is the
 * running record of how much gold exists.
 */
export function creditGold(input: CreditInput): PostResult {
  if (input.amount <= 0n || input.amount > MAX_GOLD_MOVE) {
    return { ok: false, code: 'invalid_amount', reason: `credit must be between 1 and ${MAX_GOLD_MOVE}` }
  }
  ensureGoldAccounts(input.userId, input.now)
  return postTransfer({
    kind: `credit.${input.provenance}`,
    idemScope: input.idemScope,
    idemKey: input.idemKey,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    note: input.note,
    now: input.now,
    legs: [
      { accountId: SYSTEM_MINT, amount: -input.amount, provenance: 'system', note: input.note },
      {
        accountId: playerAvailable(input.userId),
        amount: input.amount,
        provenance: input.provenance,
        ownerUserId: input.userId,
        note: input.note,
      },
    ],
  })
}

/** Destroys gold. Used for the hunt death forfeit and nothing else so far. */
export function debitGold(input: {
  userId: string
  amount: bigint
  idemScope: string
  idemKey: string
  note: string
  refType?: string | null
  refId?: string | null
  now?: number
}): PostResult {
  if (input.amount <= 0n || input.amount > MAX_GOLD_MOVE) {
    return { ok: false, code: 'invalid_amount', reason: 'debit must be positive' }
  }
  ensureGoldAccounts(input.userId, input.now)
  return postTransfer({
    kind: 'debit.forfeit',
    idemScope: input.idemScope,
    idemKey: input.idemKey,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    note: input.note,
    now: input.now,
    legs: [
      {
        accountId: playerAvailable(input.userId),
        amount: -input.amount,
        provenance: 'system',
        ownerUserId: input.userId,
        note: input.note,
      },
      { accountId: SYSTEM_SINK, amount: input.amount, provenance: 'system', note: input.note },
    ],
  })
}

/** The one-time onboarding grant. Idempotent per account, and never redeemable. */
export function grantStartingGold(userId: string, now = Date.now()): PostResult {
  return creditGold({
    userId,
    amount: STARTING_GRANT_GOLD,
    provenance: 'gift',
    idemScope: 'starting-grant',
    idemKey: userId,
    refType: 'account',
    refId: userId,
    note: 'Starting gold. Game currency, not SOL, and not redeemable.',
    now,
  })
}

/* ----------------------------------------------------------- reservations */

export type ReserveOutcome =
  | { ok: true; idempotent: boolean }
  | { ok: false; reason: string }

/**
 * Reserves the same stake from two players, atomically.
 *
 * One transfer with four legs. Either both stakes move from available to reserved
 * or neither does — there is no window where one player is reserved and the other
 * is not, because there is no second statement to fail.
 *
 * The balance pre-check exists only to name which player is short; the guard that
 * actually prevents an overspend is the bigint check inside `postTransfer`.
 */
export function reservePairGold(input: {
  aUserId: string
  bUserId: string
  stake: bigint
  duelId: string
  now?: number
}): ReserveOutcome {
  const { aUserId, bUserId, stake, duelId } = input
  if (stake <= 0n || stake > MAX_GOLD_MOVE) return { ok: false, reason: 'stake must be a positive integer' }
  if (aUserId === bUserId) return { ok: false, reason: 'cannot reserve against yourself' }
  ensureGoldAccounts(aUserId, input.now)
  ensureGoldAccounts(bUserId, input.now)

  if (balanceOf(playerAvailable(aUserId)) < stake) return { ok: false, reason: 'challenger cannot cover the stake' }
  if (balanceOf(playerAvailable(bUserId)) < stake) return { ok: false, reason: 'opponent cannot cover the stake' }

  const note = 'Stake reserved in escrow'
  const posted = postTransfer({
    kind: 'duel.reserve',
    idemScope: 'duel-reserve',
    idemKey: duelId,
    refType: 'duel',
    refId: duelId,
    note,
    now: input.now,
    legs: [
      { accountId: playerAvailable(aUserId), amount: -stake, provenance: 'escrow', ownerUserId: aUserId, note },
      { accountId: playerReserved(aUserId), amount: stake, provenance: 'escrow', ownerUserId: aUserId, note },
      { accountId: playerAvailable(bUserId), amount: -stake, provenance: 'escrow', ownerUserId: bUserId, note },
      { accountId: playerReserved(bUserId), amount: stake, provenance: 'escrow', ownerUserId: bUserId, note },
    ],
  })
  if (!posted.ok) {
    if (posted.code === 'insufficient_funds') {
      const short = posted.reason.includes(aUserId) ? 'challenger cannot cover the stake' : 'opponent cannot cover the stake'
      return { ok: false, reason: short }
    }
    return { ok: false, reason: posted.reason }
  }
  return { ok: true, idempotent: posted.idempotent }
}

export type SettleKind = 'payout' | 'refund' | 'void'

/**
 * Settles a duel exactly once.
 *
 * `payout` splits the winner's credit into two legs on purpose: their own stake
 * comes back as an `escrow` movement, and only the pot they took off the loser is
 * `pvp_winnings`. That keeps the provenance record accurate, which is what the
 * redemption rule reads — a duel cannot manufacture redeemable gold.
 */
export function settleDuelGold(input: {
  duelId: string
  aUserId: string
  bUserId: string
  stake: bigint
  kind: SettleKind
  winnerUserId?: string | null
  now?: number
}): { ok: true; idempotent: boolean } | { ok: false; reason: string } {
  const { duelId, aUserId, bUserId, stake, kind, winnerUserId } = input
  if (stake <= 0n || stake > MAX_GOLD_MOVE) return { ok: false, reason: 'invalid stake' }

  if (kind === 'payout') {
    if (!winnerUserId || (winnerUserId !== aUserId && winnerUserId !== bUserId)) {
      return { ok: false, reason: 'payout needs a fighter id' }
    }
    const loserUserId = winnerUserId === aUserId ? bUserId : aUserId
    const posted = postTransfer({
      kind: 'duel.payout',
      idemScope: 'duel-settle',
      idemKey: duelId,
      refType: 'duel',
      refId: duelId,
      note: 'Pot paid to winner',
      now: input.now,
      legs: [
        {
          accountId: playerReserved(winnerUserId),
          amount: -stake,
          provenance: 'escrow',
          ownerUserId: winnerUserId,
          note: 'Own stake released',
        },
        {
          accountId: playerAvailable(winnerUserId),
          amount: stake,
          provenance: 'escrow',
          ownerUserId: winnerUserId,
          note: 'Own stake returned',
        },
        {
          accountId: playerReserved(loserUserId),
          amount: -stake,
          provenance: 'escrow',
          ownerUserId: loserUserId,
          note: 'Stake consumed by loss',
        },
        {
          accountId: playerAvailable(winnerUserId),
          amount: stake,
          provenance: 'pvp_winnings',
          ownerUserId: winnerUserId,
          note: 'Pot won from opponent. Not redeemable.',
        },
      ],
    })
    return posted.ok ? { ok: true, idempotent: posted.idempotent } : { ok: false, reason: posted.reason }
  }

  const note = kind === 'void' ? 'Voided — stake returned' : 'Stake refunded'
  const posted = postTransfer({
    kind: `duel.${kind}`,
    idemScope: 'duel-settle',
    idemKey: duelId,
    refType: 'duel',
    refId: duelId,
    note,
    now: input.now,
    legs: [
      { accountId: playerReserved(aUserId), amount: -stake, provenance: 'escrow', ownerUserId: aUserId, note },
      { accountId: playerAvailable(aUserId), amount: stake, provenance: 'escrow', ownerUserId: aUserId, note },
      { accountId: playerReserved(bUserId), amount: -stake, provenance: 'escrow', ownerUserId: bUserId, note },
      { accountId: playerAvailable(bUserId), amount: stake, provenance: 'escrow', ownerUserId: bUserId, note },
    ],
  })
  return posted.ok ? { ok: true, idempotent: posted.idempotent } : { ok: false, reason: posted.reason }
}

/* ------------------------------------------------------------------ merge */

/**
 * Moves one account's whole gold position to another, as a balanced transfer.
 *
 * Used by the authenticated merge path. Available gold moves as `gift`
 * provenance — deliberately not as the provenance it originally had, because the
 * merge is a movement between accounts and re-labelling it `hunt_verified` on the
 * destination would inflate that account's redeemable total. The destination's
 * redeemable eligibility is raised separately and only by the amount the source
 * had actually accrued and not yet consumed.
 */
export function mergeGoldInto(input: {
  fromUserId: string
  intoUserId: string
  nonce: string
  now?: number
}): { ok: true; moved: bigint; idempotent: boolean } | { ok: false; reason: string } {
  const { fromUserId, intoUserId } = input
  ensureGoldAccounts(fromUserId, input.now)
  ensureGoldAccounts(intoUserId, input.now)

  const reserved = balanceOf(playerReserved(fromUserId))
  if (reserved > 0n) return { ok: false, reason: 'the account being merged still has gold reserved in escrow' }

  const available = balanceOf(playerAvailable(fromUserId))
  if (available === 0n) return { ok: true, moved: 0n, idempotent: false }

  const note = 'Merged from a claimed guest account'
  const posted = postTransfer({
    kind: 'account.merge',
    idemScope: 'account-merge',
    idemKey: `${fromUserId}->${intoUserId}`,
    refType: 'merge',
    refId: input.nonce,
    note,
    now: input.now,
    legs: [
      { accountId: playerAvailable(fromUserId), amount: -available, provenance: 'system', ownerUserId: fromUserId, note },
      { accountId: playerAvailable(intoUserId), amount: available, provenance: 'gift', ownerUserId: intoUserId, note },
    ],
  })
  if (!posted.ok) return { ok: false, reason: posted.reason }
  return { ok: true, moved: available, idempotent: posted.idempotent }
}

/* ------------------------------------------------------------ conservation */

const selectPlayerBalances = financeDb.raw.prepare<[], { account_id: string; amount: string }>(
  "select account_id, amount from ledger_balances where account_id like 'user:%'",
)

/**
 * Total gold in player hands, available and reserved.
 *
 * Read straight off the ledger rather than kept as a counter, so it cannot drift.
 * Reported as JS numbers because the existing PvP protocol carries numbers; the
 * conversion throws rather than rounds if a value ever outgrows that.
 */
export function playerGoldTotals(): { available: number; reserved: number; total: number } {
  const rows = selectPlayerBalances.all()
  let available = 0n
  let reserved = 0n
  for (const row of rows) {
    const amount = BigInt(row.amount)
    if (row.account_id.endsWith(':gold:available')) available += amount
    else if (row.account_id.endsWith(':gold:reserved')) reserved += amount
  }
  return {
    available: toSafeNumber(available),
    reserved: toSafeNumber(reserved),
    total: toSafeNumber(available + reserved),
  }
}

export { conservationReport }

/** The conservation report with amounts rendered as canonical decimal strings. */
export const goldLedgerBalances = () => {
  const report = conservationReport()
  return { ...report, balanceSum: toStored(report.balanceSum), entrySum: toStored(report.entrySum) }
}
