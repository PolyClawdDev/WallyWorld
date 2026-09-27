/* ------------------------------------------------------------------ *
 * Demo reward ledger.
 *
 * TRUTHFUL INTEGRATION BOUNDARY
 * This module is a local, simulated accrual ledger. It is not connected
 * to Solana or to any other network. There is no RPC endpoint, no token
 * mint, no wallet adapter, no signing and no payout path anywhere in
 * this repository. `PAYOUT_STATUS` is the only thing the UI may claim
 * about conversion, and it says the conversion does not happen.
 *
 * Amounts are integer base units end to end. 1 gold = 1 base unit and
 * nothing here ever produces a fraction; formatting happens at render.
 * ------------------------------------------------------------------ */

export const GOLD_DECIMALS = 0
export const GOLD_BASE_UNITS_PER_GOLD = 1

/** Matches the reward queue cadence the wallet panel already advertises. */
export const PAYOUT_WINDOW_MS = 30 * 60 * 1000

export const PAYOUT_STATUS = 'UNAVAILABLE · NO VERIFIED ADAPTER CONFIGURED'
export const DEMO_NOTICE = 'Demo — no real funds.'

/** Percentage of carried gold dropped on death. Integer, so the math stays exact. */
export const DEATH_LOSS_PERCENT = 40

export type LedgerKind = 'KILL' | 'PICKUP' | 'DEATH'

export type LedgerEntry = {
  id: number
  at: number
  kind: LedgerKind
  label: string
  /** Signed integer base units. Negative only for a death forfeit. */
  gold: number
}

const MAX_ENTRIES = 40

let balanceBaseUnits = 0
let accruedThisWindow = 0
let windowStartedAt = Date.now()
let nextId = 1
const entries: LedgerEntry[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach(listener => listener())
}

function push(kind: LedgerKind, label: string, gold: number) {
  entries.unshift({ id: nextId++, at: Date.now(), kind, label, gold })
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
}

export function subscribeRewards(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function goldBalance() {
  return balanceBaseUnits
}

/**
 * A kill only records what hit the ground. The balance moves when the player
 * actually walks over the coins, because anyone can pick a drop up.
 */
export function recordKill(label: string, goldBaseUnits: number) {
  push('KILL', `${label} DOWNED`, goldBaseUnits)
  emit()
}

export function creditPickup(goldBaseUnits: number, label = 'GOLD DROP') {
  const amount = Math.max(0, Math.trunc(goldBaseUnits))
  if (!amount) return 0
  balanceBaseUnits += amount
  accruedThisWindow += amount
  push('PICKUP', label, amount)
  emit()
  return amount
}

/** Returns the integer amount forfeited, which the world drops at the death site. */
export function debitDeath(label: string): number {
  const lost = Math.floor((balanceBaseUnits * DEATH_LOSS_PERCENT) / 100)
  if (lost <= 0) {
    push('DEATH', `${label} · NOTHING TO DROP`, 0)
    emit()
    return 0
  }
  balanceBaseUnits -= lost
  accruedThisWindow = Math.max(0, accruedThisWindow - lost)
  push('DEATH', `${label} · GOLD DROPPED`, -lost)
  emit()
  return lost
}

export type RewardsSnapshot = {
  balanceBaseUnits: number
  accruedThisWindowBaseUnits: number
  windowEndsAt: number
  entries: readonly LedgerEntry[]
  /** Always the unavailable status: no adapter exists in this build. */
  payoutStatus: string
  payoutImplemented: false
}

export function rewardsSnapshot(): RewardsSnapshot {
  const now = Date.now()
  // Windows roll forward on read; nothing is ever paid out when one closes.
  while (now - windowStartedAt >= PAYOUT_WINDOW_MS) {
    windowStartedAt += PAYOUT_WINDOW_MS
    accruedThisWindow = 0
  }
  return {
    balanceBaseUnits,
    accruedThisWindowBaseUnits: accruedThisWindow,
    windowEndsAt: windowStartedAt + PAYOUT_WINDOW_MS,
    entries,
    payoutStatus: PAYOUT_STATUS,
    payoutImplemented: false,
  }
}

/** Formatting is the only place a base-unit integer becomes display text. */
export function formatGold(baseUnits: number) {
  return Math.trunc(baseUnits).toLocaleString('en-US')
}

export function formatCountdown(ms: number) {
  const clamped = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(clamped / 60)
  const seconds = clamped % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
