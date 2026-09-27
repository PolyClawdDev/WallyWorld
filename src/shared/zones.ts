/* ------------------------------------------------------------------ *
 * Town geometry and PvP rings, as plain numbers.
 *
 * Copied from `townData` / `wildlife` so the server can enforce the same
 * "inside town" rule without importing Three.js or character meshes.
 * `scripts/test-pvp.ts` walks a grid and asserts this module and
 * `wildlife.isInTown` agree, so a street move cannot silently desync.
 * ------------------------------------------------------------------ */

export type Rect = { x: number; z: number; halfW: number; halfD: number }
export type Circle = { x: number; z: number; r: number }

export const WORLD_HALF = 96

export const townPaving: Rect[] = [
  { x: 0, z: 0, halfW: 8, halfD: 95 },
  { x: 0, z: 0, halfW: 75, halfD: 6.5 },
  { x: -48, z: 48, halfW: 6, halfD: 47.5 },
  { x: -14, z: 48, halfW: 43, halfD: 5.5 },
  { x: 34, z: 5, halfW: 5.5, halfD: 62.5 },
  { x: -7, z: -8, halfW: 9, halfD: 1.5 },
]

export const townBuildings: Rect[] = [
  { x: -17, z: 16, halfW: 6, halfD: 4.5 },
  { x: 17, z: 16, halfW: 5.5, halfD: 4.5 },
  { x: -17, z: -17, halfW: 5, halfD: 4 },
  { x: 17, z: -17, halfW: 5.5, halfD: 4 },
  { x: 50, z: -16, halfW: 6, halfD: 4.5 },
  { x: 50, z: 18, halfW: 6.5, halfD: 5 },
  { x: 72, z: 0, halfW: 7, halfD: 6 },
  { x: 50, z: 50, halfW: 6, halfD: 4.5 },
  { x: -59, z: 43, halfW: 6, halfD: 5.5 },
  { x: -72, z: 70, halfW: 7, halfD: 6 },
  { x: -42, z: 76, halfW: 5.5, halfD: 4.5 },
  { x: -82, z: 52, halfW: 5, halfD: 5 },
  { x: -15, z: 74, halfW: 7, halfD: 4.5 },
  { x: 74, z: 72, halfW: 5.5, halfD: 4.5 },
  { x: 83, z: -54, halfW: 6, halfD: 5 },
  { x: 0, z: -68, halfW: 5.5, halfD: 4.5 },
  { x: 52, z: -70, halfW: 5, halfD: 4 },
]

export const townPlaza: Circle = { x: 0, z: 0, r: 18 }
export const SAFE_ZONE: Circle = { x: 0, z: 0, r: 30 }

const PAVING_MARGIN = 4
const BUILDING_MARGIN = 9
const PLAZA_MARGIN = 6

function inRect(rect: Rect, x: number, z: number, margin: number) {
  return Math.abs(x - rect.x) <= rect.halfW + margin && Math.abs(z - rect.z) <= rect.halfD + margin
}

/** Same predicate the client uses in `wildlife.isInTown`. */
export function isInTown(x: number, z: number, margin = 0) {
  if (Math.hypot(x - townPlaza.x, z - townPlaza.z) <= townPlaza.r + PLAZA_MARGIN + margin) return true
  if (townPaving.some(rect => inRect(rect, x, z, PAVING_MARGIN + margin))) return true
  return townBuildings.some(rect => inRect(rect, x, z, BUILDING_MARGIN + margin))
}

export function isSafeZone(x: number, z: number) {
  return Math.hypot(x - SAFE_ZONE.x, z - SAFE_ZONE.z) <= SAFE_ZONE.r
}

export type DuelRing = {
  id: string
  name: string
  x: number
  z: number
  radius: number
}

/**
 * Outdoor rings, each entirely off paved town. Starts sit on opposite
 * edges so both walk the same distance to centre.
 */
export const DUEL_RINGS: readonly DuelRing[] = [
  { id: 'east-heath', name: 'East Heath', x: 88, z: 28, radius: 14 },
  { id: 'south-meadow', name: 'South Meadow', x: 28, z: -88, radius: 14 },
  { id: 'west-verge', name: 'West Verge', x: -88, z: 8, radius: 14 },
  { id: 'north-copse', name: 'North Copse', x: 28, z: 88, radius: 14 },
]

export function ringById(id: string): DuelRing | undefined {
  return DUEL_RINGS.find(ring => ring.id === id)
}

export function pointInRing(ring: DuelRing, x: number, z: number, slack = 0) {
  return Math.hypot(x - ring.x, z - ring.z) <= ring.radius + slack
}

export function ringStarts(ring: DuelRing): [{ x: number; z: number }, { x: number; z: number }] {
  const spread = ring.radius * 0.62
  return [
    { x: ring.x - spread, z: ring.z },
    { x: ring.x + spread, z: ring.z },
  ]
}

export const CHALLENGE_RANGE = 18
export const INSPECT_RANGE = 48
