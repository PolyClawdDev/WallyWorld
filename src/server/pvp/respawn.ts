/* ------------------------------------------------------------------ *
 * Authorising a respawn.
 *
 * WHAT THIS VERIFIES AND WHAT IT DOES NOT — read this before describing
 * it anywhere.
 *
 * Wildlife and player health are simulated in the browser
 * (`src/wildlife.ts`, `src/combat.ts`). This process cannot see a
 * player's hit points and therefore cannot decide on its own that one
 * has died. A respawn starts as a claim from the client, and a claim
 * that moved a player wherever they asked would be precisely the free
 * teleport the movement speed budget in `presence.ts` exists to refuse.
 *
 * Two properties stop it from being one:
 *
 *   The DESTINATION is never the client's. The message carries no
 *   coordinates at all and the caller places the player on
 *   `TOWN_RESPAWN`. The most a dishonest client can win is a trip to the
 *   plaza — a protected zone with no loot in it, which it could have
 *   walked to anyway. It cannot reach a duel ring, a hunting ground, or
 *   the far side of a wall.
 *
 *   The RATE is bounded here, per character and across reconnects. A
 *   floor longer than the respawn invulnerability window, and a bucket
 *   of a few grants per minute beyond it, so the claim cannot be held
 *   down as an escape button every time a bear connects.
 *
 * Corroboration, and its limits. A death that the money path already
 * charged for is worth more than a bare assertion: `/api/hunt/death`
 * forfeits a share of the account's gold, is idempotent per
 * (hunt, reference), and writes a row to `hunt_deaths` under the same
 * `player_id` this hub knows. Each such row buys back one bucket token,
 * so a player who really is dying — and paying for it every time — never
 * runs out, while a client inventing deaths for nothing stays capped.
 * That row is still created by a client request, so it is evidence that
 * the claim cost something, not proof that a fight happened. It also
 * usually lands a moment AFTER the socket claim it corroborates, because
 * one is an HTTP round trip and the other is not, which is why it
 * refunds the budget rather than gating it.
 * ------------------------------------------------------------------ */

import type { PlayerId } from '../../shared/pvp'
import { db } from '../db'

/**
 * Floor between two granted respawns.
 *
 * Comfortably longer than `RESPAWN_INVULNERABLE_MS` in `src/combat.ts`, so a
 * second death cannot legitimately fall inside it, and short enough that a
 * player who walks straight back out and dies again is never made to wait.
 */
export const RESPAWN_MIN_GAP_MS = 2_500

/** Grants held without any corroboration, and how long the bucket takes to refill. */
export const RESPAWN_BURST = 3
export const RESPAWN_WINDOW_MS = 60_000

const REFILL_MS = RESPAWN_WINDOW_MS / RESPAWN_BURST

/** How far back a forfeit may be and still count as corroborating a respawn. */
const CORROBORATION_WINDOW_MS = 60_000

type Budget = {
  lastGrantMs: number
  /** Fractional on purpose: the bucket refills continuously, not in steps. */
  tokens: number
  refilledAtMs: number
  /** Newest forfeit already counted, so one death cannot be spent twice. */
  countedDeathMs: number
}

/**
 * Kept per character rather than per connection, and deliberately not cleared
 * on close: a budget a player could reset by reconnecting would not be one.
 */
const budgets = new Map<PlayerId, Budget>()

/**
 * Forfeits recorded against this character's hunts.
 *
 * Joined through `hunt_sessions`, which is where the player id is written when
 * the hunt opens, so this cannot be pointed at another account's deaths.
 */
const selectRecentDeaths = db.prepare<[string, number], { created_at_ms: number }>(`
  select d.created_at_ms
    from hunt_deaths d
    join hunt_sessions s on s.hunt_id = d.hunt_id
   where s.player_id = ?
     and d.created_at_ms > ?
   order by d.created_at_ms asc
`)

export type RespawnVerdict =
  | { ok: true; corroborated: boolean }
  | { ok: false; code: 'too_soon' | 'too_many'; detail: string }

/** New forfeits since the last check, each worth one token back. */
function countDeaths(playerId: PlayerId, budget: Budget, now: number): number {
  const since = Math.max(budget.countedDeathMs, now - CORROBORATION_WINDOW_MS)
  const rows = selectRecentDeaths.all(playerId, since)
  if (rows.length) budget.countedDeathMs = rows[rows.length - 1].created_at_ms
  return rows.length
}

export function authoriseRespawn(playerId: PlayerId, now = Date.now()): RespawnVerdict {
  const budget = budgets.get(playerId) ?? { lastGrantMs: 0, tokens: RESPAWN_BURST, refilledAtMs: now, countedDeathMs: 0 }
  budgets.set(playerId, budget)

  const deaths = countDeaths(playerId, budget, now)
  budget.tokens = Math.min(RESPAWN_BURST, budget.tokens + (now - budget.refilledAtMs) / REFILL_MS + deaths)
  budget.refilledAtMs = now

  if (now - budget.lastGrantMs < RESPAWN_MIN_GAP_MS) {
    return { ok: false, code: 'too_soon', detail: 'That death arrived too soon after the last one.' }
  }
  if (budget.tokens < 1) {
    return { ok: false, code: 'too_many', detail: 'Too many deaths claimed in the last minute.' }
  }

  budget.tokens -= 1
  budget.lastGrantMs = now
  return { ok: true, corroborated: deaths > 0 }
}

/** Drops budgets for characters nobody has claimed a respawn for in a long while. */
export function sweepRespawns(now = Date.now()) {
  for (const [id, budget] of budgets) {
    if (now - Math.max(budget.lastGrantMs, budget.refilledAtMs) > RESPAWN_WINDOW_MS * 4) budgets.delete(id)
  }
}

/** Test hook: the budgets are process-global, so suites have to be able to reset them. */
export function clearRespawnBudgetsForTest() {
  budgets.clear()
}
