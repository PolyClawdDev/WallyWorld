/* ------------------------------------------------------------------ *
 * The hunt ledger the HUD reads.
 *
 * TRUTHFUL INTEGRATION BOUNDARY
 * Two balances can appear here and they are not the same thing.
 *
 *   The server balance, when `serverGold.ts` has a session, is the real
 *   one: one account, credited only against single-use tokens the server
 *   issued, recorded with provenance, and the only balance any future
 *   redemption could ever read. `authority` is then 'server'.
 *
 *   The local counter is what runs when there is no session — offline, or
 *   before the first request comes back. It is an optimistic display. It
 *   is never redeemable and nothing reads it but the HUD.
 *
 * Neither is money. There is no payout path in this repository: no token
 * mint, no treasury key, no signing. `PAYOUT_STATUS` is the only thing
 * the UI may claim about conversion, and it says it does not happen.
 *
 * Amounts are integer base units end to end. 1 gold = 1 base unit and
 * nothing here ever produces a fraction; formatting happens at render.
 * ------------------------------------------------------------------ */

export const GOLD_DECIMALS = 0
export const GOLD_BASE_UNITS_PER_GOLD = 1

/** Matches the reward queue cadence the wallet panel already advertises. */
export const PAYOUT_WINDOW_MS = 30 * 60 * 1000

export const PAYOUT_STATUS = 'UNAVAILABLE · NO VERIFIED ADAPTER CONFIGURED'

/**
 * Renamed from `DEMO_NOTICE`, because the balance stopped being a demo.
 *
 * Hunt gold is credited by the server against a single-use token it issued,
 * recorded with provenance on the append-only ledger above. "Demo — no real
 * funds" described none of that, and it understated the one thing a player
 * needs to know is real: losing this gold on a wager actually loses it.
 *
 * The half that has not changed is the half that matters legally, so it is
 * the half the string keeps. Nothing here converts to a token or to money,
 * and there is no code in this repository that could make it.
 */
export const GOLD_NOTICE = 'Real in-game gold · no cash value.'

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

/* --------------------------------------------------- the server's figures */

type ServerGold = { total: number; redeemable: number; atMs: number }

let serverGold: ServerGold | null = null
let serverUnavailableReason: string | null = null

/**
 * Adopts the server's balance. Called by `serverGold.ts` after every credit.
 *
 * The local counter is realigned rather than left to drift, so the HUD shows one
 * number and it is the authoritative one. A claim that was refused — a spent
 * token, a rate limit — therefore visibly does not pay, which is correct.
 */
export function applyServerGold(figures: { total: number; redeemable: number }) {
  serverGold = { total: figures.total, redeemable: figures.redeemable, atMs: Date.now() }
  serverUnavailableReason = null
  balanceBaseUnits = figures.total
  emit()
}

export function markServerUnavailable(reason: string) {
  serverUnavailableReason = reason
  emit()
}

export function goldBalance() {
  return serverGold?.total ?? balanceBaseUnits
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
  /** Which balance the number above came from. */
  authority: 'server' | 'local'
  /**
   * Gold this account could present for redemption if a redemption existed.
   * Server-computed, and null whenever there is no server to ask.
   */
  redeemableBaseUnits: number | null
  serverUnavailableReason: string | null
}

export function rewardsSnapshot(): RewardsSnapshot {
  const now = Date.now()
  // Windows roll forward on read; nothing is ever paid out when one closes.
  while (now - windowStartedAt >= PAYOUT_WINDOW_MS) {
    windowStartedAt += PAYOUT_WINDOW_MS
    accruedThisWindow = 0
  }
  return {
    balanceBaseUnits: serverGold?.total ?? balanceBaseUnits,
    accruedThisWindowBaseUnits: accruedThisWindow,
    windowEndsAt: windowStartedAt + PAYOUT_WINDOW_MS,
    entries,
    payoutStatus: PAYOUT_STATUS,
    payoutImplemented: false,
    authority: serverGold ? 'server' : 'local',
    redeemableBaseUnits: serverGold?.redeemable ?? null,
    serverUnavailableReason,
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
