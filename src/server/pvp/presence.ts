/* ------------------------------------------------------------------ *
 * Server authority over where a player is standing.
 *
 * The overworld uses client prediction: your own wizard moves the instant
 * you click, because waiting a round trip to take a step feels broken.
 * What the client sends is therefore a *request*, and this module decides
 * what actually happened. The value it returns is the one that gets
 * broadcast, the one other players see, and the one the duel system reads
 * when it checks whether you are in town.
 *
 * The rule is a speed budget. Between two accepted updates a player may
 * have covered at most `MAX_GROUND_SPEED` metres per second plus a little
 * slack for network jitter. A request inside the budget is taken as sent.
 * A request outside it is not rejected — rejecting would freeze a player
 * whose connection hiccuped — it is *clamped*: the server advances them
 * toward where they asked to be, at the fastest speed the game allows,
 * and reports the clamp so the client can reconcile.
 *
 * This is what stops a modified client from blinking across the map,
 * standing on top of someone to open a duel, or leaving a ring and
 * returning between two ticks. It does not try to stop small cheats that
 * are indistinguishable from lag, because nothing can, and pretending
 * otherwise would mean punishing honest players on bad Wi-Fi.
 *
 * Duel movement does not come through here at all. Inside a ring the
 * server simulates positions from inputs in `combat.ts`, which is
 * stricter still, and this module's values are overwritten by that
 * simulation.
 * ------------------------------------------------------------------ */

import { WORLD_HALF } from '../../shared/zones'
import type { AnimKind, PlayerId } from '../../shared/pvp'

/**
 * Fastest legal ground speed, with headroom.
 *
 * The quickest kit runs at 5.9 m/s (`src/shared/pvpKits.ts`). The extra
 * covers a knockback impulse and the fact that a client's frame clock and
 * the server's wall clock never agree exactly.
 */
export const MAX_GROUND_SPEED = 7.5

/**
 * Distance forgiven regardless of elapsed time.
 *
 * Two poses arriving in the same millisecond must not imply a budget of
 * zero, or a client that batches under load gets clamped to a standstill.
 */
const FREE_SLACK = 1.25

/** A gap longer than this is a stall, not travel; budget stops accumulating. */
const MAX_BUDGET_WINDOW_MS = 1_500

/**
 * How long a disconnected player's position stays authoritative.
 *
 * Within this window a reconnect resumes from where they stood, so a
 * dropped socket does not move anyone. Past it, the first pose of a new
 * connection is trusted as a fresh spawn. The window is what stops
 * "disconnect, reconnect, appear anywhere" from being a teleport.
 */
export const POSITION_MEMORY_MS = 120_000

export const ANIMS: readonly AnimKind[] = ['idle', 'walk', 'run', 'attack', 'cast', 'hit', 'down']

export type Vec2 = { x: number; z: number }

export type MoveRequest = {
  x: unknown
  z: unknown
  facing: unknown
  anim: unknown
}

export type MoveVerdict = {
  /** Where the player now is, as far as this server is concerned. */
  x: number
  z: number
  facing: number
  anim: AnimKind
  /** True when the request was outside the budget and was reeled in. */
  clamped: boolean
  /** True when the request was unusable and the previous position was kept. */
  rejected: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Last known good position per player, kept across reconnects. */
const remembered = new Map<PlayerId, { x: number; z: number; atMs: number }>()

export function rememberPosition(playerId: PlayerId, at: Vec2, now = Date.now()) {
  remembered.set(playerId, { x: at.x, z: at.z, atMs: now })
}

export function forgetPosition(playerId: PlayerId) {
  remembered.delete(playerId)
}

/**
 * Where a (re)connecting player should be placed before their first pose.
 *
 * A recent memory wins, so a reconnect is continuous. Otherwise the caller's
 * spawn point is used and the next pose is trusted as a fresh seed.
 */
export function resumePosition(playerId: PlayerId, spawn: Vec2, now = Date.now()): { at: Vec2; resumed: boolean } {
  const memory = remembered.get(playerId)
  if (memory && now - memory.atMs <= POSITION_MEMORY_MS) {
    return { at: { x: memory.x, z: memory.z }, resumed: true }
  }
  remembered.delete(playerId)
  return { at: spawn, resumed: false }
}

export function sweepPositions(now = Date.now()) {
  for (const [id, memory] of remembered) {
    if (now - memory.atMs > POSITION_MEMORY_MS) remembered.delete(id)
  }
}

/**
 * Applies one movement request against the previous accepted state.
 *
 * `trustAbsolute` is set for the first pose of a connection that could not
 * resume a remembered position — there is nothing to measure against, so
 * the client's claim is accepted once and every later pose is budgeted.
 */
export function resolveMove(
  previous: { x: number; z: number; facing: number; anim: AnimKind },
  request: MoveRequest,
  elapsedMs: number,
  trustAbsolute = false,
): MoveVerdict {
  const facing = finite(request.facing) ? normaliseAngle(request.facing) : previous.facing
  const anim = ANIMS.includes(request.anim as AnimKind) ? (request.anim as AnimKind) : 'idle'

  if (!finite(request.x) || !finite(request.z)) {
    return { x: previous.x, z: previous.z, facing, anim, clamped: false, rejected: true }
  }

  const wantX = clamp(request.x, -WORLD_HALF, WORLD_HALF)
  const wantZ = clamp(request.z, -WORLD_HALF, WORLD_HALF)

  if (trustAbsolute) {
    return { x: wantX, z: wantZ, facing, anim, clamped: false, rejected: false }
  }

  const window = clamp(elapsedMs, 0, MAX_BUDGET_WINDOW_MS)
  const budget = FREE_SLACK + (MAX_GROUND_SPEED * window) / 1000
  const dx = wantX - previous.x
  const dz = wantZ - previous.z
  const distance = Math.hypot(dx, dz)

  if (distance <= budget) {
    return { x: wantX, z: wantZ, facing, anim, clamped: false, rejected: false }
  }

  // Move as far along the requested direction as the budget allows. The player
  // keeps heading where they wanted to go; they simply do not arrive early.
  const scale = budget / distance
  return {
    x: clamp(previous.x + dx * scale, -WORLD_HALF, WORLD_HALF),
    z: clamp(previous.z + dz * scale, -WORLD_HALF, WORLD_HALF),
    facing,
    anim,
    clamped: true,
    rejected: false,
  }
}

/** Keeps a heading in (-π, π] so it never accumulates into a huge float. */
function normaliseAngle(radians: number): number {
  const wrapped = radians % (Math.PI * 2)
  if (wrapped > Math.PI) return wrapped - Math.PI * 2
  if (wrapped <= -Math.PI) return wrapped + Math.PI * 2
  return wrapped
}

/** Test hook: the memory is process-global, so suites have to be able to reset it. */
export function clearPositionMemoryForTest() {
  remembered.clear()
}
