/* ------------------------------------------------------------------ *
 * "Leave town" is only useful advice if the player can tell where town ends.
 *
 * Town is not the plaza. `isInTown` is the plaza circle *plus* every paved
 * street with a margin, plus a skirt around every building — so the main
 * north–south road is "town" from one edge of the world to the other, and a
 * player who walks straight up it never leaves however far they go. Telling
 * them to "leave town" while they are standing on that road is advice that
 * cannot be followed.
 *
 * So the direction is measured rather than described. This casts rays out
 * from where the player actually is, asks the same predicate the server uses
 * to refuse the challenge, and reports the nearest point that is genuinely
 * outside. Anything it says is therefore true of the geometry that is
 * actually enforced: if the answer is "34 m north-west", then 34 m
 * north-west really is off the paving.
 * ------------------------------------------------------------------ */

import { isInTown, WORLD_HALF } from '../shared/zones'

/**
 * +z is north and +x is east, matching the duel rings and the wild regions.
 *
 * The search is limited to these eight and not to a finer sweep, which is a
 * correctness requirement rather than a shortcut. A player is told a compass
 * word, and a word covers 45°; if the ray that found the exit sat anywhere
 * else inside that arc, then walking the named direction for the named
 * distance would still leave them in town. Searching only the directions
 * that can be named keeps the sentence and the geometry the same claim.
 */
const COMPASS = [
  { word: 'north', dx: 0, dz: 1 },
  { word: 'north-east', dx: Math.SQRT1_2, dz: Math.SQRT1_2 },
  { word: 'east', dx: 1, dz: 0 },
  { word: 'south-east', dx: Math.SQRT1_2, dz: -Math.SQRT1_2 },
  { word: 'south', dx: 0, dz: -1 },
  { word: 'south-west', dx: -Math.SQRT1_2, dz: -Math.SQRT1_2 },
  { word: 'west', dx: -1, dz: 0 },
  { word: 'north-west', dx: -Math.SQRT1_2, dz: Math.SQRT1_2 },
] as const

export type WayOut = {
  /** Whole metres to walk. The point at exactly this distance is outside town. */
  metres: number
  /** One of the eight compass points, as a word. */
  heading: (typeof COMPASS)[number]['word']
}

/**
 * The shortest walk from here to ground where a duel is legal.
 *
 * Returns null when the point is already outside town, which is the caller's
 * signal that there is nothing to explain, and also in the corner case where
 * no compass direction reaches open ground before the world edge — the
 * caller then falls back to wording that names no distance.
 *
 * Distances are whole metres because the endpoint is *checked* at that whole
 * metre. Rounding a fractional answer afterwards would reintroduce exactly
 * the error this avoids.
 */
export function wayOutOfTown(x: number, z: number): WayOut | null {
  if (!isInTown(x, z)) return null
  let best: WayOut | null = null
  for (const { word, dx, dz } of COMPASS) {
    const limit = best ? best.metres - 1 : 2 * WORLD_HALF
    for (let step = 1; step <= limit; step++) {
      const px = x + dx * step
      const pz = z + dz * step
      // Past the world edge there is no ground to stand on, so this ray is
      // not a way out however much of it is clear.
      if (Math.abs(px) > WORLD_HALF || Math.abs(pz) > WORLD_HALF) break
      if (!isInTown(px, pz)) {
        best = { metres: step, heading: word }
        break
      }
    }
  }
  return best
}
