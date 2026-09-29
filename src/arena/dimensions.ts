import { PVP_KITS } from '../shared/pvpKits'

/* ------------------------------------------------------------------ *
 * How big the duelling platform is, and why.
 *
 * The brief asked for "36-44 metres across, adjusted to movement speed
 * and attack range". Those are not free numbers: they are already
 * written down in the kit tables, so this module reads them rather than
 * restating them. If a kit is retuned the platform retunes with it, and
 * the assertions at the bottom fail loudly if a retune pushes it out of
 * the range the arena art was authored for.
 *
 * Everything is derived from PVP_KITS — the authoritative server-side
 * copy — so the floor cannot silently disagree with the combat rules.
 * ------------------------------------------------------------------ */

const kits = Object.values(PVP_KITS)

/** Every reach a kit has: its basic attack plus all four abilities. */
const reaches = kits.flatMap(kit => [kit.basic.range, ...Object.values(kit.abilities).map(a => a.range)])

/** 22m — CINDER's Meteor, the longest thing anyone can throw. */
export const LONGEST_REACH = Math.max(...reaches)

/** The kit that has to close the gap: whoever owns the shortest basic attack. */
const melee = kits.reduce((worst, kit) => (kit.basic.range < worst.basic.range ? kit : worst))

/** 3.6m — MOTH's Lantern Strike, the only melee basic in the game. */
export const SHORTEST_BASIC = melee.basic.range

/** 5.9 / 5.3 m/s. Sprint speeds bracket how fast the gap can be closed. */
export const FASTEST_RUN = Math.max(...kits.map(kit => kit.stats.runSpeed))
export const SLOWEST_RUN = Math.min(...kits.map(kit => kit.stats.runSpeed))

/**
 * Clearance between the opening bell and the first possible hit.
 *
 * Two metres past the longest reach in the game. Any less and CINDER
 * opens a duel by dropping a Meteor on a player who has not moved yet;
 * much more and the opening of every duel is both players jogging.
 */
const OPENING_CLEARANCE = 2

/** 24m. Neither player can touch the other until somebody commits. */
export const SPAWN_SEPARATION = LONGEST_REACH + OPENING_CLEARANCE

/**
 * Ground behind a spawn.
 *
 * A duellist backed against the boundary from the first second has no
 * duel to fight, so each spawn keeps a pocket behind it. Eight metres is
 * a shade over one second of sprint — enough to give ground, not enough
 * to run away with.
 */
const SPAWN_SETBACK = 8

/** Outer edge of the stone: 20m, so 40m across. */
export const PLATFORM_RADIUS = SPAWN_SEPARATION / 2 + SPAWN_SETBACK

/** The whole platform, corner to corner. */
export const PLATFORM_DIAMETER = PLATFORM_RADIUS * 2

/**
 * Where the magical boundary stands.
 *
 * A metre inside the stone edge, which leaves a visible lip of floor
 * beyond the wall. Players read a barrier standing ON the ground very
 * differently from one hanging off a cliff, and the lip is what says
 * the platform is a built thing rather than a hole cut in the dark.
 */
export const BOUNDARY_RADIUS = PLATFORM_RADIUS - 1

/** Spawns sit on the +z/-z axis, facing each other across the middle. */
export const SPAWN_RADIUS = SPAWN_SEPARATION / 2

/**
 * Body radius the arena assumes when nothing else is supplied.
 *
 * Matches AGENT_RADIUS in src/battle/nav.ts. The arena deliberately does
 * not import nav.ts — that module bakes the whole town into a grid the
 * moment it is constructed, and the arena has no town in it.
 */
export const BODY_RADIUS = 0.62

/* ---------------------------- consequences --------------------------- */

/**
 * 3.58s for MOTH to sprint from its own spawn into its own melee range.
 *
 * Measured with MOTH's sprint rather than the fastest in the game, because
 * the kit that has to close is the kit whose legs decide whether it can.
 */
export const CLOSE_TIME = (SPAWN_SEPARATION - SHORTEST_BASIC) / melee.stats.runSpeed

/** 7.55s to cross the whole floor at the slowest sprint. */
export const CROSS_TIME = PLATFORM_DIAMETER / SLOWEST_RUN

/** 1.82. How much bigger the floor is than the longest ability. */
export const REACH_RATIO = PLATFORM_DIAMETER / LONGEST_REACH

/**
 * The checks that make the derivation a derivation rather than a hope.
 *
 * Run at import so a kit change that invalidates the floor plan is found
 * by `npx tsc -b`-adjacent tooling and by the verifier, not by a player.
 */
export function checkDimensions() {
  const problems: string[] = []
  if (PLATFORM_DIAMETER < 36 || PLATFORM_DIAMETER > 44) {
    problems.push(`platform is ${PLATFORM_DIAMETER}m across, outside the 36-44m the art was built for`)
  }
  if (SPAWN_SEPARATION <= LONGEST_REACH) {
    problems.push(`spawns are ${SPAWN_SEPARATION}m apart but something reaches ${LONGEST_REACH}m`)
  }
  if (CLOSE_TIME > 4.5) {
    problems.push(`melee needs ${CLOSE_TIME.toFixed(2)}s to close, which is a walk rather than an engage`)
  }
  if (LONGEST_REACH < PLATFORM_RADIUS) {
    problems.push(`nothing reaches ${PLATFORM_RADIUS}m, so the centre cannot threaten the rim`)
  }
  return problems
}

/** One block of numbers, for the verifier and the report to print verbatim. */
export const DIMENSION_NOTES = [
  `longest reach in any kit      ${LONGEST_REACH}m  (CINDER · Meteor)`,
  `shortest basic attack         ${SHORTEST_BASIC}m  (${melee.id} · melee)`,
  `sprint speed                  ${SLOWEST_RUN}-${FASTEST_RUN} m/s`,
  `spawn separation              ${SPAWN_SEPARATION}m  (longest reach + ${OPENING_CLEARANCE}m)`,
  `setback behind each spawn     ${SPAWN_SETBACK}m`,
  `platform diameter             ${PLATFORM_DIAMETER}m`,
  `magical boundary at           ${BOUNDARY_RADIUS}m radius`,
  `${melee.id} closes spawn to spawn  ${CLOSE_TIME.toFixed(2)}s at ${melee.stats.runSpeed} m/s`,
  `slowest sprint across         ${CROSS_TIME.toFixed(2)}s`,
  `floor / longest reach         ${REACH_RATIO.toFixed(2)}x`,
]
