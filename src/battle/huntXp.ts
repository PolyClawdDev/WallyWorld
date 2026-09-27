import { speciesSpecs } from '../wildlife'
import type { SpeciesId } from '../wildlife'

/* ------------------------------------------------------------------ *
 * Kill XP. Base amounts live on the species; this is the only place
 * they are scaled for the player's level. Gold is not touched here.
 *
 * Rule: each level above recommendedLevel cuts the award by 20%.
 * The floor is 5%, so a chicken at level 10 still pays a coin of XP
 * and never goes to zero (which would look like a bug).
 * ------------------------------------------------------------------ */

export const XP_OVERLEVEL_STEP = 0.2
export const XP_OVERLEVEL_FLOOR = 0.05

export function xpScale(playerLevel: number, recommendedLevel: number) {
  const gap = Math.max(0, Math.round(playerLevel) - recommendedLevel)
  return Math.max(XP_OVERLEVEL_FLOOR, 1 - gap * XP_OVERLEVEL_STEP)
}

/** Integer XP granted for killing `species` at `playerLevel`. */
export function killXp(species: SpeciesId, playerLevel: number) {
  const spec = speciesSpecs[species]
  return Math.max(0, Math.round(spec.xpBase * xpScale(playerLevel, spec.recommendedLevel)))
}
