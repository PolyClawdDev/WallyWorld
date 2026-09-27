import type { WizardId } from '../characters'

/* ------------------------------------------------------------------ *
 * Per-character progression: level, XP, ability ranks, unspent points.
 *
 * Every rule the HUD and the engine need lives here as a pure function
 * so it can be unit tested without a browser, and so no other module
 * can invent its own answer to "can this be ranked up yet".
 *
 * Storage is behind `ProgressStore`. Today that is localStorage; when
 * the accounts work lands, a server-backed store can be swapped in via
 * `useProgressStore` without touching gameplay code.
 * ------------------------------------------------------------------ */

export type AbilitySlot = 'Q' | 'W' | 'E' | 'R'

export const MAX_LEVEL = 15
export const MAX_NORMAL_RANK = 4
export const MAX_ULT_RANK = 3

/** Character level at which each normal-ability rank becomes eligible. */
export const NORMAL_RANK_LEVELS = [1, 3, 5, 7] as const
/** Character level at which each ultimate rank becomes eligible. */
export const ULT_RANK_LEVELS = [6, 11, 15] as const

export type Ranks = Record<AbilitySlot, number>

export type CharacterProgress = {
  level: number
  /** XP accumulated toward the next level, never carried past MAX_LEVEL. */
  xp: number
  ranks: Ranks
}

export type ProgressTable = Record<WizardId, CharacterProgress>

export function emptyProgress(): CharacterProgress {
  return { level: 1, xp: 0, ranks: { Q: 0, W: 0, E: 0, R: 0 } }
}

/* ----------------------------- the curve ----------------------------- */

/**
 * XP required to go from `level` to `level + 1`. Tunable and strictly
 * increasing; the exponent keeps early levels quick without making the last
 * few a wall. Returns 0 at max level so callers never divide by it.
 */
export function xpToNext(level: number) {
  if (level >= MAX_LEVEL) return 0
  return Math.round(90 * Math.pow(level, 1.22))
}

/** Total XP from level 1 to `level`, used by tests and by the debug probe. */
export function xpToReach(level: number) {
  let total = 0
  for (let l = 1; l < Math.min(level, MAX_LEVEL); l++) total += xpToNext(l)
  return total
}

/* ----------------------------- the rules ----------------------------- */

export function maxRank(slot: AbilitySlot) {
  return slot === 'R' ? MAX_ULT_RANK : MAX_NORMAL_RANK
}

/** Level at which rank `rank` (1-based) of `slot` becomes legal to buy. */
export function rankUnlockLevel(slot: AbilitySlot, rank: number) {
  const table = slot === 'R' ? ULT_RANK_LEVELS : NORMAL_RANK_LEVELS
  return table[rank - 1] ?? Infinity
}

export function pointsSpent(progress: CharacterProgress) {
  return progress.ranks.Q + progress.ranks.W + progress.ranks.E + progress.ranks.R
}

/** One point at level 1, one more per level gained: 15 points at level 15. */
export function pointsAvailable(progress: CharacterProgress) {
  return Math.max(0, progress.level - pointsSpent(progress))
}

export type UpgradeBlock = 'ok' | 'maxRank' | 'noPoints' | 'levelTooLow'

export function upgradeStatus(progress: CharacterProgress, slot: AbilitySlot): UpgradeBlock {
  const next = progress.ranks[slot] + 1
  if (next > maxRank(slot)) return 'maxRank'
  if (progress.level < rankUnlockLevel(slot, next)) return 'levelTooLow'
  if (pointsAvailable(progress) < 1) return 'noPoints'
  return 'ok'
}

export function canUpgrade(progress: CharacterProgress, slot: AbilitySlot) {
  return upgradeStatus(progress, slot) === 'ok'
}

/** Spends one point if legal. Returns whether anything changed. */
export function applyUpgrade(progress: CharacterProgress, slot: AbilitySlot) {
  if (!canUpgrade(progress, slot)) return false
  progress.ranks[slot] += 1
  return true
}

export type XpResult = { levelsGained: number; level: number; leftover: number; maxed: boolean }

/**
 * Awards XP, crossing as many levels as the amount covers. At max level the
 * bar is pinned full and further XP is discarded rather than silently banked.
 */
export function applyXp(progress: CharacterProgress, amount: number): XpResult {
  if (progress.level >= MAX_LEVEL) {
    progress.xp = 0
    return { levelsGained: 0, level: progress.level, leftover: 0, maxed: true }
  }
  let gained = 0
  progress.xp += Math.max(0, Math.round(amount))
  while (progress.level < MAX_LEVEL && progress.xp >= xpToNext(progress.level)) {
    progress.xp -= xpToNext(progress.level)
    progress.level += 1
    gained += 1
  }
  if (progress.level >= MAX_LEVEL) progress.xp = 0
  return { levelsGained: gained, level: progress.level, leftover: progress.xp, maxed: progress.level >= MAX_LEVEL }
}

/**
 * Ranks bought at a level the character no longer has cannot exist, but a
 * hand-edited or older save might claim them. Clamp on load rather than trust.
 */
export function sanitise(raw: unknown): CharacterProgress {
  const source = (raw ?? {}) as Partial<CharacterProgress> & { ranks?: Partial<Ranks> }
  const level = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(source.level) || 1)))
  const progress: CharacterProgress = { level, xp: 0, ranks: { Q: 0, W: 0, E: 0, R: 0 } }
  const slots: AbilitySlot[] = ['Q', 'W', 'E', 'R']
  for (const slot of slots) {
    const wanted = Math.max(0, Math.round(Number(source.ranks?.[slot]) || 0))
    let rank = 0
    while (rank < wanted && rank < maxRank(slot) && level >= rankUnlockLevel(slot, rank + 1)) rank++
    progress.ranks[slot] = rank
  }
  // Drop anything that would overspend the budget, highest slot first.
  for (const slot of ['R', 'E', 'W', 'Q'] as AbilitySlot[]) {
    while (pointsSpent(progress) > level && progress.ranks[slot] > 0) progress.ranks[slot] -= 1
  }
  const cap = xpToNext(progress.level)
  progress.xp = cap === 0 ? 0 : Math.max(0, Math.min(cap - 1, Math.round(Number(source.xp) || 0)))
  return progress
}

/* ---------------------------- persistence ---------------------------- */

export type ProgressStore = {
  load: () => Partial<Record<WizardId, unknown>>
  save: (table: ProgressTable) => void
}

export const STORAGE_KEY = 'wally.progression.v1'

/**
 * Default store. Deliberately tolerant: a corrupt or absent entry produces a
 * fresh level 1 character rather than throwing on boot.
 */
export const localProgressStore: ProgressStore = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  },
  save(table) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(table))
    } catch {
      /* private browsing, quota, or no storage at all: progression stays in memory */
    }
  },
}

let store: ProgressStore = localProgressStore

/** Swap the backing store (for example to the per-wallet server profile). */
export function useProgressStore(next: ProgressStore) {
  store = next
  table = null
}

let table: ProgressTable | null = null

const WIZARD_IDS: WizardId[] = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']

function ensureTable(): ProgressTable {
  if (table) return table
  const raw = store.load()
  table = WIZARD_IDS.reduce((acc, id) => {
    acc[id] = raw[id] ? sanitise(raw[id]) : emptyProgress()
    return acc
  }, {} as ProgressTable)
  return table
}

export function progressFor(wizard: WizardId): CharacterProgress {
  return ensureTable()[wizard]
}

export function persistProgress() {
  store.save(ensureTable())
}

/** Test and debug hook: wipes every character back to level 1. */
export function resetAllProgress() {
  table = WIZARD_IDS.reduce((acc, id) => {
    acc[id] = emptyProgress()
    return acc
  }, {} as ProgressTable)
  persistProgress()
}
