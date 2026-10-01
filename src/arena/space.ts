/* ------------------------------------------------------------------ *
 * Where a duel instance stands, as plain numbers.
 *
 * The arena in `index.ts` is geometry centred on its own origin. This
 * module is the other half of "instanced": it says where that origin is
 * in the coordinate space the server and the client both speak, and it
 * does the containment maths for a body standing in it.
 *
 * WHY THE INSTANCES ARE NOT IN THE TOWN WORLD
 *
 * The duel rings used to be places in the town — circles of grass at
 * ±88 m with trees growing through them. Two consequences followed from
 * that and both were bugs. One is the obvious one: town geometry was in
 * the duel area, because the duel area *was* town. The other is subtler
 * and worse. `isInTown` is not the plaza; it is the plaza plus every
 * paved street with a 4 m margin plus a 9 m skirt around every building,
 * and the `east-heath` ring at (88, 28) reaches to within 13 m of the
 * skirt around the building at (72, 0). Damage is refused inside town, so
 * there was a pocket of that ring in which a fighter could not be hit.
 *
 * So an instance is not anywhere in the town. `ARENA_STRIP_X` is five and
 * a half times further out than the furthest point `isInTown` can reach,
 * which makes town protection vacuously satisfied inside an arena rather
 * than something the duel code has to keep negotiating with. Nothing in
 * the town can be near an arena because the town is 96 m across and the
 * strip is at 512 m.
 *
 * NO THREE.JS HERE, DELIBERATELY. The server imports this module, and it
 * must not be made to load a renderer to work out where two people are
 * standing. `index.ts` is the half that needs meshes; this half is sums.
 * ------------------------------------------------------------------ */

import { BODY_RADIUS, BOUNDARY_RADIUS, PLATFORM_RADIUS, SPAWN_RADIUS } from './dimensions'

/**
 * How many instances can be live at once.
 *
 * One per concurrent duel, and a duel occupies a ring, so this is bounded
 * above by `DUEL_RINGS.length`. It is larger than that on purpose: the
 * slot allocator must never be the thing that fails, and a spare slot
 * costs nothing but a number.
 */
export const ARENA_SLOTS = 16

/**
 * Gap between instance centres: two platform diameters.
 *
 * Instances are already isolated by being separate simulations, so this
 * is not what stops a shot crossing between them. It is what makes a
 * coordinate unambiguous — a position can belong to at most one arena —
 * so a leak of one match's numbers into another's is arithmetic that does
 * not add up rather than a plausible-looking position.
 */
export const ARENA_PITCH = PLATFORM_RADIUS * 4

/** The line the instances stand on, far outside the 96 m town world. */
export const ARENA_STRIP_X = 512

export type ArenaFrame = {
  /** Which slot this instance holds, for the allocator to hand back. */
  slot: number
  /** Instance origin: the centre of the floor, in world coordinates. */
  x: number
  z: number
}

/** The frame for a slot. Pure, so both ends derive the same origin from the same id. */
export function arenaFrame(slot: number): ArenaFrame {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ARENA_SLOTS) {
    throw new Error(`arena slot ${slot} is outside 0..${ARENA_SLOTS - 1}`)
  }
  // Centred on the strip so the slots spread both ways from it rather than
  // marching off in one direction.
  return { slot, x: ARENA_STRIP_X, z: (slot - (ARENA_SLOTS - 1) / 2) * ARENA_PITCH }
}

export type ArenaMark = {
  x: number
  z: number
  /** Y rotation that looks at the middle of the floor. */
  facing: number
}

/**
 * The two opposite marks, in the same order and the same places as
 * `createArena().spawns`.
 *
 * Both are on the z axis at `SPAWN_RADIUS`, which the dimensions module
 * derives from the longest reach in any kit plus two metres — so neither
 * fighter can touch the other before somebody commits to closing.
 *
 * `facing` uses the project's convention that a character faces +z, and
 * the same `atan2(dx, dz)` the duel simulation uses to aim, so a mark and
 * a fighter turning to face each other agree on what a yaw means.
 */
export function arenaSpawns(frame: ArenaFrame): [ArenaMark, ArenaMark] {
  return [
    { x: frame.x, z: frame.z + SPAWN_RADIUS, facing: Math.atan2(0, -SPAWN_RADIUS) },
    { x: frame.x, z: frame.z - SPAWN_RADIUS, facing: Math.atan2(0, SPAWN_RADIUS) },
  ]
}

/** How far from the middle a body of this size may stand. */
export function arenaLimit(bodyRadius = BODY_RADIUS) {
  return Math.max(0, BOUNDARY_RADIUS - bodyRadius)
}

/** True when a body of `bodyRadius` standing here is fully inside the boundary. */
export function arenaHolds(frame: ArenaFrame, x: number, z: number, bodyRadius = BODY_RADIUS) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false
  return Math.hypot(x - frame.x, z - frame.z) <= arenaLimit(bodyRadius)
}

/**
 * The nearest legal standing point to (x, z).
 *
 * Clamping the radius and leaving the bearing alone is what gives sliding
 * along the wall for free: a fighter running into the boundary keeps every
 * part of their movement that was along it and loses only the part that
 * was into it. Same reasoning, and the same one-comparison circle, as
 * `confine` in `index.ts` — there is no corner for a body to squeeze
 * through because there are no corners.
 */
export function arenaConfine(frame: ArenaFrame, x: number, z: number, bodyRadius = BODY_RADIUS) {
  const limit = arenaLimit(bodyRadius)
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { x: frame.x, z: frame.z, moved: true }
  }
  const dx = x - frame.x
  const dz = z - frame.z
  const distance = Math.hypot(dx, dz)
  if (distance <= limit) return { x, z, moved: false }
  // At the exact centre there is no bearing to preserve and nothing is out.
  if (distance < 1e-9) return { x: frame.x, z: frame.z, moved: false }
  // A hair inside, because a point landing exactly ON the limit comes back
  // out of Math.hypot a float above it about half the time.
  const k = (limit * (1 - 1e-9)) / distance
  return { x: frame.x + dx * k, z: frame.z + dz * k, moved: true }
}

export { BODY_RADIUS, BOUNDARY_RADIUS, PLATFORM_RADIUS, SPAWN_RADIUS }
