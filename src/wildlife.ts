import * as THREE from 'three'
import { buildingSpecs, huntingRegions, townLayout } from './townData'

/* ------------------------------------------------------------------ *
 * Wildlife: where the green is, what lives on it, and how it behaves.
 *
 * Animals are authored as side-view pixel grids and extruded into
 * cubes, the same art direction as the characters in characters.ts,
 * except the silhouette runs along Z (nose at +Z, tail at -Z) and the
 * extrusion runs along X so a quadruped reads as a quadruped.
 * ------------------------------------------------------------------ */

/* ---------------------------- zoning ---------------------------- */

export type Rect = { x: number; z: number; halfW: number; halfD: number }
export type Circle = { x: number; z: number; r: number }

/** Playable half-extent. Matches the clamp applied to the player in WorldCanvas. */
export const WORLD_HALF = townLayout.bounds

/**
 * Everything paved, built or flooded, derived from the same townData the
 * district is built from. Nothing is retyped here, so when a street moves the
 * exclusion moves with it.
 */
export const townPaving: Rect[] = [
  ...townLayout.streets.map(street => ({ x: street.x, z: street.z, halfW: street.width / 2, halfD: street.depth / 2 })),
  {
    x: townLayout.canal.x,
    z: townLayout.canal.z,
    halfW: townLayout.canal.bankWidth / 2,
    halfD: townLayout.canal.bankLength / 2,
  },
  {
    // The stall row runs from its origin along +x in `count` steps.
    x: townLayout.marketStalls.x + ((townLayout.marketStalls.count - 1) * townLayout.marketStalls.step) / 2,
    z: townLayout.marketStalls.z,
    halfW: ((townLayout.marketStalls.count - 1) * townLayout.marketStalls.step) / 2 + 1,
    halfD: 1.5,
  },
]

export const townBuildings: Rect[] = buildingSpecs.map(spec => ({
  x: spec.x,
  z: spec.z,
  halfW: spec.width / 2,
  halfD: spec.depth / 2,
}))

export const townPlaza: Circle = { x: townLayout.plaza.x, z: townLayout.plaza.z, r: townLayout.plaza.radius }

/** Town is safe: nothing hunts you here and you heal fast. */
export const SAFE_ZONE: Circle = { x: 0, z: 0, r: 30 }

const PAVING_MARGIN = 4
const BUILDING_MARGIN = 9
const PLAZA_MARGIN = 6

function inRect(rect: Rect, x: number, z: number, margin: number) {
  return Math.abs(x - rect.x) <= rect.halfW + margin && Math.abs(z - rect.z) <= rect.halfD + margin
}

export function isInTown(x: number, z: number, margin = 0) {
  if (Math.hypot(x - townPlaza.x, z - townPlaza.z) <= townPlaza.r + PLAZA_MARGIN + margin) return true
  if (townPaving.some(rect => inRect(rect, x, z, PAVING_MARGIN + margin))) return true
  return townBuildings.some(rect => inRect(rect, x, z, BUILDING_MARGIN + margin))
}

/** True where wildlife is allowed to stand: open green, never town. */
export function isGreen(x: number, z: number, margin = 0) {
  if (Math.abs(x) > WORLD_HALF - 4 || Math.abs(z) > WORLD_HALF - 4) return false
  return !isInTown(x, z, margin)
}

export function isSafeZone(x: number, z: number) {
  return Math.hypot(x - SAFE_ZONE.x, z - SAFE_ZONE.z) <= SAFE_ZONE.r
}

/* --------------------------- species --------------------------- */

export type SpeciesId = 'CHICKEN' | 'REINDEER' | 'BEAR' | 'WOLF' | 'BOAR'
export type ThreatTier = 'passive' | 'defensive' | 'aggressive'

export type SpeciesSpec = {
  id: SpeciesId
  label: string
  blurb: string
  threat: ThreatTier
  maxHp: number
  /** Integer base units. Bigger animal, bigger payout, bigger risk. */
  goldBaseUnits: number
  /** Kill loot is split into this many coins so the pickup is visible. */
  coins: number
  /** Base XP for a kill at or below recommendedLevel. Scaled at the award site. */
  xpBase: number
  /** Level this animal is meant for. Farming below this still pays full XP. */
  recommendedLevel: number
  height: number
  depth: number
  walkSpeed: number
  fleeSpeed: number
  chaseSpeed: number
  /** How close the player must get before the animal reacts at all. */
  noticeRadius: number
  attackRange: number
  attackDamage: number
  attackCooldownMs: number
  /** Telegraph length: the animal rears up this long before damage lands. */
  windUpMs: number
  respawnMs: number
  mapColor: string
}

export const speciesSpecs: Record<SpeciesId, SpeciesSpec> = {
  CHICKEN: {
    id: 'CHICKEN',
    label: 'CHICKEN',
    blurb: 'Skittish. Runs, never fights.',
    threat: 'passive',
    maxHp: 12,
    goldBaseUnits: 2,
    coins: 1,
    xpBase: 30,
    recommendedLevel: 1,
    // Generous for a chicken, but the wayfinders stand 3.5m tall: at true
    // scale a hen is a speck you cannot see, let alone aim at.
    height: 1.1,
    depth: 6,
    walkSpeed: 1.1,
    fleeSpeed: 5.4,
    chaseSpeed: 0,
    noticeRadius: 9,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownMs: 0,
    windUpMs: 0,
    respawnMs: 12000,
    mapColor: '#e8e2d2',
  },
  REINDEER: {
    id: 'REINDEER',
    label: 'REINDEER',
    blurb: 'Defends itself. Bolts when badly hurt.',
    threat: 'defensive',
    maxHp: 70,
    goldBaseUnits: 12,
    coins: 3,
    xpBase: 140,
    recommendedLevel: 3,
    height: 2.35,
    depth: 6,
    walkSpeed: 1.6,
    fleeSpeed: 6.2,
    chaseSpeed: 4.2,
    noticeRadius: 16,
    attackRange: 2.9,
    attackDamage: 9,
    attackCooldownMs: 2200,
    windUpMs: 520,
    respawnMs: 20000,
    mapColor: '#8a6f52',
  },
  BEAR: {
    id: 'BEAR',
    label: 'BEAR',
    blurb: 'Hunts you on sight. Hits very hard.',
    threat: 'aggressive',
    maxHp: 200,
    goldBaseUnits: 45,
    coins: 5,
    xpBase: 420,
    recommendedLevel: 6,
    height: 1.95,
    depth: 9,
    walkSpeed: 1.4,
    fleeSpeed: 0,
    chaseSpeed: 4.6,
    noticeRadius: 17,
    attackRange: 3.4,
    attackDamage: 22,
    attackCooldownMs: 1900,
    windUpMs: 650,
    respawnMs: 32000,
    mapColor: '#4a3a34',
  },
  WOLF: {
    id: 'WOLF',
    label: 'WOLF',
    blurb: 'Hunts in the Brasswood. Fast, and it does not miss often.',
    threat: 'aggressive',
    maxHp: 240,
    goldBaseUnits: 58,
    coins: 5,
    xpBase: 720,
    recommendedLevel: 9,
    height: 1.72,
    depth: 7,
    walkSpeed: 1.9,
    fleeSpeed: 0,
    chaseSpeed: 5.5,
    noticeRadius: 20,
    attackRange: 3.0,
    attackDamage: 26,
    attackCooldownMs: 1550,
    windUpMs: 420,
    respawnMs: 36000,
    mapColor: '#6a6e74',
  },
  BOAR: {
    id: 'BOAR',
    label: 'BOAR',
    blurb: 'Brasswood brute. Hits harder than a bear and does not run.',
    threat: 'aggressive',
    maxHp: 380,
    goldBaseUnits: 95,
    coins: 7,
    xpBase: 1100,
    recommendedLevel: 12,
    height: 1.78,
    depth: 10,
    walkSpeed: 1.25,
    fleeSpeed: 0,
    chaseSpeed: 4.3,
    noticeRadius: 15,
    attackRange: 3.6,
    attackDamage: 36,
    attackCooldownMs: 2100,
    windUpMs: 720,
    respawnMs: 42000,
    mapColor: '#3d2a1f',
  },
}

/* --------------------------- regions --------------------------- */

export type WildRegionKind = 'wildwood' | 'woods' | 'grassland' | 'meadow' | 'fields' | 'outskirts' | 'brasswood'

/** One blob of a region's footprint. A region is the smooth union of its lobes. */
export type Lobe = { x: number; z: number; r: number }

export type WildRegion = {
  id: string
  label: string
  kind: WildRegionKind
  /** The region's heart: the compass target, and the anchor its props hang off. */
  x: number
  z: number
  /** Absolute lobe centres and radii. `regionDistance` blends them into one shape. */
  lobes: Lobe[]
  /** Farthest the footprint reaches from the heart. Framing and scatter budgets only. */
  reach: number
  note: string
  /** Ground tint used by the scenery pass, reused by the map panel. */
  color: string
  counts: Partial<Record<SpeciesId, number>>
}

/* ------------------------------------------------------------------ *
 * Why a signed-distance blend of lobes, and not a circle or a polygon.
 *
 * A circle was what this used to be, and it was visibly a circle: a disc
 * of lighter grass with a hard rim, and animals ringed inside it.
 *
 * A polygon would fix the look but not the work. What the rest of this
 * module actually asks of a region is not "draw me" — it is:
 *
 *   - is this point inside, with at least N metres of slack? (spawning,
 *     wander targets, and the movement fence, thousands of times a
 *     second)
 *   - which way is inward from here? (turning a fleeing animal back
 *     before it grinds into the boundary)
 *   - where is the edge, as a line? (the ground patch and the map)
 *
 * A signed distance field answers all three in a few multiplies, and a
 * polygon answers only the first cheaply. `smoothUnion` is the standard
 * polynomial smooth-min, which fuses overlapping lobes into one organic
 * outline with no corner where two circles meet — so the shape reads as
 * a clearing that grew, rather than as several circles.
 * ------------------------------------------------------------------ */

/** Lobe fusion width in metres. Bigger swells the joins and rounds the outline. */
const LOBE_BLEND = 7

function smoothUnion(a: number, b: number, k: number) {
  const h = Math.max(0, k - Math.abs(a - b)) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** Signed metres to the region's edge: negative inside, positive outside. */
export function regionDistance(region: WildRegion, x: number, z: number) {
  const first = region.lobes[0]
  let distance = Math.hypot(x - first.x, z - first.z) - first.r
  for (let i = 1; i < region.lobes.length; i++) {
    const lobe = region.lobes[i]
    distance = smoothUnion(distance, Math.hypot(x - lobe.x, z - lobe.z) - lobe.r, LOBE_BLEND)
  }
  return distance
}

/** Inside, with `inset` metres of slack to the edge. */
export function insideRegion(region: WildRegion, x: number, z: number, inset = 0) {
  return regionDistance(region, x, z) <= -inset
}

/**
 * Open green inside the region, in square metres, measured rather than derived.
 *
 * Sampled on a grid because the union of blended lobes has no closed form and
 * because what the scenery pass actually wants to know is how much PLANTABLE
 * ground there is — which means the town cut-outs have to come off it too. The
 * tree and grass budgets are densities per square metre against this number, so
 * enlarging a region plants more trees without anyone retuning a count.
 */
export function regionArea(region: WildRegion, inset = ROAM_INSET, step = 1.5) {
  let inside = 0
  const far = region.reach + LOBE_BLEND
  for (let x = region.x - far; x <= region.x + far; x += step) {
    for (let z = region.z - far; z <= region.z + far; z += step) {
      if (!insideRegion(region, x, z, inset)) continue
      if (!isGreen(x, z, 1)) continue
      inside += 1
    }
  }
  return inside * step * step
}

/** Unit vector pointing into the region: the downhill direction of the field. */
export function regionInward(region: WildRegion, x: number, z: number) {
  const e = 0.7
  const gx = regionDistance(region, x + e, z) - regionDistance(region, x - e, z)
  const gz = regionDistance(region, x, z + e) - regionDistance(region, x, z - e)
  const length = Math.hypot(gx, gz)
  if (length < 1e-6) return { x: 0, z: 0 }
  return { x: -gx / length, z: -gz / length }
}

/**
 * The edge as a ring of points, for the ground patch and the map.
 *
 * Found by bisection along rays from the heart, which assumes the shape is
 * star-shaped about that heart — true for the footprints below, because each
 * one is a chain of lobes overlapping the first. Only the DRAWING relies on
 * that assumption; every containment test goes through `regionDistance`, which
 * is exact for any arrangement.
 */
export function regionOutline(region: WildRegion, steps = 64): Array<[number, number]> {
  const far = region.reach + LOBE_BLEND + 6
  const points: Array<[number, number]> = []
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    let inside = 0
    let outside = far
    for (let k = 0; k < 22; k++) {
      const mid = (inside + outside) / 2
      if (regionDistance(region, region.x + cos * mid, region.z + sin * mid) < 0) inside = mid
      else outside = mid
    }
    points.push([region.x + cos * inside, region.z + sin * inside])
  }
  return points
}

/**
 * How far inside its own ground an animal is held. The fence, in metres.
 *
 * Kept small and positive rather than zero so an animal is always standing on
 * ground the player can see is green, instead of balancing on the contour line.
 */
export const ROAM_INSET = 1.5

/** Within this band of the edge, a fleeing animal turns along it rather than into it. */
const FLEE_TURN_BAND = 7

/** How far outside its ground a player can stand and still be hunted. */
const AGGRO_REACH = 8

type RegionPlan = Omit<WildRegion, 'lobes' | 'reach'> & {
  /** Lobes as [dx, dz, r] from the heart, so moving a region moves its whole shape. */
  shape: Array<[number, number, number]>
}

function plan(region: RegionPlan): WildRegion {
  const lobes = region.shape.map(([dx, dz, r]) => ({ x: region.x + dx, z: region.z + dz, r }))
  const reach = Math.max(...lobes.map(lobe => Math.hypot(lobe.x - region.x, lobe.z - region.z) + lobe.r))
  const { shape: _shape, ...rest } = region
  // The smooth union bulges slightly past the lobes it fuses, by at most k/4.
  return { ...rest, lobes, reach: reach + LOBE_BLEND * 0.25 }
}

/**
 * Exported as plain data so the map panel can draw the hunting region without
 * reaching into the Three.js scene.
 *
 * The lobes are laid out to stay clear of the streets, the canal and every
 * building footprint — `npm run verify:regions` measures that rather than
 * trusting it, and prints how much of each footprint is open green.
 */
export const wildRegions: WildRegion[] = [
  plan({
    id: 'wildwood',
    label: 'THE WILDWOOD',
    kind: 'wildwood',
    x: -58,
    z: -58,
    // A wide, lopsided clearing with two arms: one reaching north-east toward
    // the trail out of town, one south into the deep pine.
    shape: [[0, 0, 25], [-16, -14, 16], [16, -14, 15], [-4, 20, 18], [22, 10, 14]],
    note: 'Dense pine, standing stones, a still pond. Bears range the whole clearing.',
    color: '#2c3f34',
    counts: { BEAR: 4, REINDEER: 5, CHICKEN: 1 },
  }),
  plan({
    id: 'hollow',
    label: 'ELDER HOLLOW',
    kind: 'woods',
    x: -25,
    z: -78,
    shape: [[0, 0, 13], [-13, 3, 11], [4, 4, 8]],
    note: 'Old wood south of the chapel. One bear works this patch.',
    color: '#2f4338',
    counts: { BEAR: 1, REINDEER: 2, CHICKEN: 2 },
  }),
  plan({
    id: 'northmeadow',
    label: 'LANTERN MEADOW',
    kind: 'grassland',
    x: 28,
    z: 78,
    shape: [[0, 0, 14], [-14, 2, 11], [14, -2, 10]],
    note: 'Open grass above the post road. Reindeer graze the long side of it.',
    color: '#3b5342',
    counts: { REINDEER: 2, CHICKEN: 4 },
  }),
  plan({
    id: 'eastmeadow',
    label: 'EAST COMMON',
    kind: 'meadow',
    x: 80,
    z: -28,
    // A corridor, not a disc: it threads the gap between the market hall and
    // the cartwright's yard, which is the shape the ground there actually has.
    shape: [[0, 0, 12], [-14, 4, 13], [-12, -12, 10]],
    note: 'Scrub east of the market, running down to the cartwright. Easy starting ground.',
    color: '#3e5544',
    counts: { REINDEER: 1, CHICKEN: 3 },
  }),
  plan({
    id: 'southfields',
    label: 'SOUTH FIELDS',
    kind: 'fields',
    x: 18,
    z: -45,
    shape: [[0, 0, 10], [-2, -13, 8], [3, 10, 7]],
    note: 'Field strip between the south road and the canal. Chickens everywhere.',
    color: '#42583f',
    counts: { REINDEER: 1, CHICKEN: 3 },
  }),
  plan({
    id: 'westoutskirts',
    label: 'WEST OUTSKIRTS',
    kind: 'outskirts',
    x: -82,
    z: -24,
    shape: [[0, 0, 10], [2, 14, 9], [0, -16, 9]],
    note: 'A long ribbon of thin grass down the world edge.',
    color: '#3d5140',
    counts: { CHICKEN: 2 },
  }),
  plan({
    id: 'brasswood',
    label: 'THE BRASSWOOD',
    kind: 'brasswood',
    x: 74,
    z: -74,
    shape: [[0, 0, 17], [-6, 14, 11], [6, -10, 8]],
    note: 'Far south-east timber under the tall ironbark. Wolves and boars. Come at level 8 or do not come.',
    color: '#2a3226',
    counts: { WOLF: 4, BOAR: 3 },
  }),
]

/** The starter hunting area. Compass points here until the high-level bracket. */
export const huntingArea = wildRegions[0]

/** Far south-east ground for players approaching level 10. */
export const highHuntArea = wildRegions.find(region => region.id === 'brasswood') ?? wildRegions[0]

/** Compass switches to the Brasswood once levelling off town game goes stale. */
export const HIGH_HUNT_LEVEL = 8

export function compassHuntRegion(level: number) {
  return level >= HIGH_HUNT_LEVEL ? highHuntArea : huntingArea
}

const regionAccent: Record<WildRegionKind, string> = {
  wildwood: '#e35e35',
  woods: '#9ca66d',
  grassland: '#9ca66d',
  meadow: '#7bc9ce',
  fields: '#7bc9ce',
  outskirts: '#849394',
  brasswood: '#c4893a',
}

// townData leaves an empty `huntingRegions` seam for exactly this. Filling it
// here keeps the map popup a projection of the live spawn data.
huntingRegions.push(
  ...wildRegions.map(region => ({
    name: region.label,
    x: region.x,
    z: region.z,
    reach: region.reach,
    // The chart traces the same edge the ground patch is cut to, so the map is
    // still a projection of the world and not a circle standing in for one.
    outline: regionOutline(region, 48),
    accent: regionAccent[region.kind],
  })),
)

/**
 * The lit dirt trail from the cross street out to the wildwood. Routed west of
 * the bakery so the path never runs through a building.
 */
export const trailWaypoints: Array<[number, number]> = [
  [-24, -9],
  [-30, -17],
  [-36, -26],
  [-43, -35],
  [-49, -44],
  [-55, -52],
]

/**
 * Lit dirt south-east to the Brasswood. Crosses at the south canal bridge
 * and stays east of the fisher shed, south of the cartwright.
 */
export const brassTrailWaypoints: Array<[number, number]> = [
  [22, -9],
  [30, -20],
  [38, -32],
  [48, -44],
  [58, -56],
  [70, -68],
  [78, -78],
]

/** Every marked hunt trail. Map, scenery and tree scatter share this list. */
export const huntTrails: Array<Array<[number, number]>> = [trailWaypoints, brassTrailWaypoints]

/* ------------------------ sprite building ------------------------ */

type PartId = 'body' | 'head' | 'legFront' | 'legBack' | 'tail'
type SpreadKind = 'full' | 'pair' | 'sides' | 'left' | 'right' | 'centre'

type SpritePlan = {
  rows: string[]
  palette: Record<string, string>
  spread: Record<string, SpreadKind>
  part: Record<string, PartId>
  emissive: string[]
  height: number
  depth: number
}

/**
 * Rows are declared as span lists so every row is exactly `width` long by
 * construction. Hand-typed strings drift by a character and voxels vanish.
 */
function grid(width: number, rows: Array<Array<[number, number, string]>>): string[] {
  return rows.map(segments => {
    const cells = new Array<string>(width).fill('.')
    for (const [from, to, ch] of segments) {
      for (let x = Math.max(0, from); x <= Math.min(width - 1, to); x++) cells[x] = ch
    }
    return cells.join('')
  })
}

function slabIndices(kind: SpreadKind, depth: number): number[] {
  const all = Array.from({ length: depth }, (_, i) => i)
  if (kind === 'full') return all
  if (kind === 'sides') return depth <= 1 ? [0] : [0, depth - 1]
  if (kind === 'left') return [0]
  if (kind === 'right') return [depth - 1]
  if (kind === 'centre') {
    const w = Math.max(1, Math.round(depth / 3))
    const start = Math.floor((depth - w) / 2)
    return all.slice(start, start + w)
  }
  const w = Math.max(1, Math.round(depth * 0.3))
  return [...all.slice(0, w), ...all.slice(depth - w)]
}

type BuiltSprite = {
  group: THREE.Group
  parts: Partial<Record<PartId, THREE.Group>>
  cell: number
  size: { x: number; y: number; z: number }
  materials: THREE.Material[]
  geometry: THREE.BoxGeometry
}

function buildAnimalSprite(plan: SpritePlan): BuiltSprite {
  const rows = plan.rows
  const height = rows.length
  const width = rows[0].length
  const cell = plan.height / height
  const geometry = new THREE.BoxGeometry(cell * 0.94, cell * 0.94, cell * 0.94)
  const emissive = new Set(plan.emissive)

  const filled = (x: number, y: number) =>
    y >= 0 && y < height && x >= 0 && x < width && rows[y][x] !== '.' && plan.palette[rows[y][x]] !== undefined

  type Cell = { key: string; x: number; y: number }
  const cellsByPart = new Map<PartId, Cell[]>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = rows[y][x]
      if (key === '.' || !plan.palette[key]) continue
      const part = plan.part[key] ?? 'body'
      if (!cellsByPart.has(part)) cellsByPart.set(part, [])
      cellsByPart.get(part)!.push({ key, x, y })
    }
  }

  const toZ = (x: number) => (x - (width - 1) / 2) * cell
  const toY = (y: number) => (height - 1 - y) * cell + cell / 2

  // Each part rotates about a joint, so legs swing from the hip and heads
  // pivot at the neck instead of orbiting the animal's centre.
  const pivotFor = (part: PartId, cells: Cell[]) => {
    const meanY = cells.reduce((sum, c) => sum + toY(c.y), 0) / cells.length
    const meanZ = cells.reduce((sum, c) => sum + toZ(c.x), 0) / cells.length
    if (part === 'legFront' || part === 'legBack') {
      return new THREE.Vector3(0, Math.max(...cells.map(c => toY(c.y))), meanZ)
    }
    if (part === 'head') return new THREE.Vector3(0, meanY, Math.min(...cells.map(c => toZ(c.x))))
    if (part === 'tail') return new THREE.Vector3(0, meanY, Math.max(...cells.map(c => toZ(c.x))))
    return new THREE.Vector3(0, 0, 0)
  }

  const group = new THREE.Group()
  const parts: Partial<Record<PartId, THREE.Group>> = {}
  const materials: THREE.Material[] = []

  for (const [part, cells] of cellsByPart) {
    const pivot = pivotFor(part, cells)
    const partGroup = new THREE.Group()
    partGroup.position.copy(pivot)
    const buckets = new Map<string, THREE.Matrix4[]>()

    for (const { key, x, y } of cells) {
      const spread = plan.spread[key] ?? 'full'
      const slabs = slabIndices(spread, plan.depth)
      const enclosed = spread === 'full' && filled(x - 1, y) && filled(x + 1, y) && filled(x, y - 1) && filled(x, y + 1)
      for (const slab of slabs) {
        // Interior cubes of a solid region are never visible, so skip them.
        if (enclosed && slab > 0 && slab < plan.depth - 1) continue
        const matrix = new THREE.Matrix4().setPosition(
          (slab - (plan.depth - 1) / 2) * cell - pivot.x,
          toY(y) - pivot.y,
          toZ(x) - pivot.z,
        )
        const bucket = `${key}:${plan.palette[key]}`
        if (!buckets.has(bucket)) buckets.set(bucket, [])
        buckets.get(bucket)!.push(matrix)
      }
    }

    for (const [bucket, matrices] of buckets) {
      const [key, color] = bucket.split(':')
      const material = emissive.has(key)
        ? new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.35 })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.86 })
      materials.push(material)
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      partGroup.add(mesh)
    }

    parts[part] = partGroup
    group.add(partGroup)
  }

  return {
    group,
    parts,
    cell,
    size: { x: plan.depth * cell, y: plan.height, z: width * cell },
    materials,
    geometry,
  }
}

/* ---------------------------- the art ---------------------------- */

const chickenPlan = (): SpritePlan => ({
  // 12 wide, nose at +Z. Round body, bushy tail, upright comb.
  rows: grid(12, [
    [[9, 10, 'C']],
    [[8, 10, 'F']],
    [[8, 10, 'F'], [9, 9, 'E'], [11, 11, 'K']],
    [[8, 10, 'F'], [11, 11, 'K']],
    [[7, 9, 'F']],
    [[0, 1, 'T'], [2, 9, 'F']],
    [[0, 1, 'T'], [2, 9, 'F'], [4, 7, 'W']],
    [[1, 1, 'T'], [2, 9, 'F'], [4, 7, 'W']],
    [[3, 8, 'f']],
    [[5, 5, '2'], [7, 7, '1']],
    [[5, 5, '2'], [7, 7, '1']],
    [[4, 5, '4'], [7, 8, '3']],
  ]),
  palette: {
    F: '#e8e2d2',
    f: '#bfb49f',
    W: '#d3c9b2',
    T: '#b3a68d',
    C: '#c4453b',
    K: '#e0a63f',
    E: '#ffb15c',
    '1': '#d79a3c',
    '2': '#c68c34',
    '3': '#c0862f',
    '4': '#b07a2a',
  },
  spread: { W: 'sides', T: 'centre', E: 'sides', C: 'centre', K: 'centre', '1': 'left', '3': 'left', '2': 'right', '4': 'right' },
  part: { '1': 'legFront', '3': 'legFront', '2': 'legBack', '4': 'legBack', T: 'tail' },
  emissive: ['E'],
  height: speciesSpecs.CHICKEN.height,
  depth: speciesSpecs.CHICKEN.depth,
})

const reindeerPlan = (): SpritePlan => ({
  // 24 wide, 22 tall. Long legs, high shoulder, branching antlers.
  rows: grid(24, [
    [[18, 18, 'A'], [21, 21, 'A'], [23, 23, 'A']],
    [[17, 17, 'A'], [19, 19, 'A'], [21, 21, 'A'], [23, 23, 'A']],
    [[17, 18, 'A'], [19, 21, 'A'], [22, 23, 'A']],
    [[18, 20, 'A']],
    [[18, 18, 'A'], [19, 23, 'H']],
    [[18, 23, 'H'], [22, 22, 'E']],
    [[19, 23, 'M']],
    [[16, 20, 'N']],
    [[2, 3, 'T'], [4, 14, 'B'], [15, 18, 'N']],
    [[2, 2, 'T'], [3, 18, 'B']],
    [[2, 3, 'T'], [3, 18, 'B']],
    [[3, 17, 'B']],
    [[4, 17, 'B']],
    [[4, 16, 'b']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[5, 6, '2'], [14, 15, '1']],
    [[4, 6, '4'], [13, 15, '3']],
  ]),
  palette: {
    B: '#8a6f52',
    b: '#6a5540',
    N: '#7d6349',
    H: '#7a5f47',
    M: '#3b3129',
    E: '#f7d98d',
    A: '#cdbfa4',
    T: '#e3dac6',
    '1': '#5f4c38',
    '2': '#584631',
    '3': '#2e2823',
    '4': '#2a241f',
  },
  spread: { A: 'pair', E: 'sides', T: 'centre', '1': 'pair', '2': 'pair', '3': 'pair', '4': 'pair' },
  part: { '1': 'legFront', '3': 'legFront', '2': 'legBack', '4': 'legBack', T: 'tail', H: 'head', M: 'head', E: 'head', A: 'head' },
  emissive: ['E'],
  height: speciesSpecs.REINDEER.height,
  depth: speciesSpecs.REINDEER.depth,
})

const bearPlan = (): SpritePlan => ({
  // 22 wide, 17 tall. Shoulder hump, heavy barrel, head carried low.
  rows: grid(22, [
    [[12, 15, 'B']],
    [[10, 16, 'B']],
    [[7, 17, 'B']],
    [[4, 18, 'B']],
    [[3, 18, 'B']],
    [[3, 18, 'B']],
    [[3, 18, 'B'], [17, 17, 'R'], [19, 19, 'R']],
    [[3, 18, 'B'], [18, 20, 'H']],
    [[2, 18, 'B'], [18, 21, 'H'], [20, 20, 'E']],
    [[2, 18, 'b'], [18, 21, 'H'], [20, 21, 'M']],
    [[4, 17, 'b'], [19, 21, 'M']],
    [[4, 6, '2'], [14, 17, '1']],
    [[4, 6, '2'], [14, 17, '1']],
    [[4, 6, '2'], [14, 17, '1']],
    [[4, 6, '2'], [14, 17, '1']],
    [[4, 6, '2'], [14, 17, '1']],
    [[3, 7, '4'], [13, 17, '3']],
  ]),
  palette: {
    B: '#4a3a34',
    b: '#362a26',
    H: '#4a3a34',
    M: '#241d1b',
    R: '#372b28',
    E: '#ffb15c',
    '1': '#3d302b',
    '2': '#362b26',
    '3': '#1f1819',
    '4': '#1b1516',
  },
  spread: { E: 'sides', R: 'pair', '1': 'pair', '2': 'pair', '3': 'pair', '4': 'pair' },
  part: { '1': 'legFront', '3': 'legFront', '2': 'legBack', '4': 'legBack', H: 'head', M: 'head', E: 'head', R: 'head' },
  emissive: ['E'],
  height: speciesSpecs.BEAR.height,
  depth: speciesSpecs.BEAR.depth,
})

const wolfPlan = (): SpritePlan => ({
  // 24 wide, 18 tall. Lean, long muzzle, pointed ears, brush tail.
  rows: grid(24, [
    [[17, 17, 'A'], [20, 20, 'A']],
    [[16, 17, 'A'], [19, 21, 'A']],
    [[16, 21, 'H']],
    [[16, 22, 'H'], [18, 18, 'E'], [23, 23, 'N']],
    [[15, 22, 'H'], [23, 23, 'N']],
    [[14, 18, 'C'], [19, 21, 'M']],
    [[2, 4, 'T'], [8, 18, 'B']],
    [[1, 5, 'T'], [7, 18, 'B']],
    [[1, 4, 'T'], [6, 17, 'B']],
    [[2, 3, 'T'], [6, 16, 'b']],
    [[7, 8, '2'], [14, 15, '1']],
    [[7, 8, '2'], [14, 15, '1']],
    [[7, 8, '2'], [14, 15, '1']],
    [[7, 8, '2'], [14, 15, '1']],
    [[7, 8, '2'], [14, 15, '1']],
    [[7, 8, '2'], [14, 15, '1']],
    [[6, 8, '4'], [13, 15, '3']],
    [[6, 8, '4'], [13, 15, '3']],
  ]),
  palette: {
    B: '#6a6e74',
    b: '#4e5358',
    C: '#5c6166',
    H: '#6a6e74',
    M: '#3a3d40',
    N: '#2a2c2e',
    A: '#3a3d40',
    E: '#ffb15c',
    T: '#8a8e92',
    '1': '#4a4e52',
    '2': '#43474b',
    '3': '#1f2123',
    '4': '#1b1d1f',
  },
  spread: { A: 'pair', E: 'sides', T: 'centre', N: 'centre', '1': 'pair', '2': 'pair', '3': 'pair', '4': 'pair' },
  part: { '1': 'legFront', '3': 'legFront', '2': 'legBack', '4': 'legBack', T: 'tail', H: 'head', M: 'head', E: 'head', A: 'head', N: 'head', C: 'head' },
  emissive: ['E'],
  height: speciesSpecs.WOLF.height,
  depth: speciesSpecs.WOLF.depth,
})

const boarPlan = (): SpritePlan => ({
  // 20 wide, 14 tall. Barrel body, bristle ridge, ivory tusks, short legs.
  rows: grid(20, [
    [[7, 12, 'R']],
    [[5, 14, 'R'], [8, 11, 'B']],
    [[3, 16, 'B'], [7, 12, 'R']],
    [[2, 17, 'B']],
    [[1, 2, 'T'], [2, 17, 'B'], [16, 16, 'K']],
    [[1, 2, 'T'], [2, 17, 'B'], [15, 18, 'H'], [16, 16, 'E'], [19, 19, 'K']],
    [[2, 16, 'B'], [15, 18, 'H'], [17, 18, 'M']],
    [[3, 15, 'b'], [15, 18, 'M']],
    [[4, 6, '2'], [12, 15, '1']],
    [[4, 6, '2'], [12, 15, '1']],
    [[4, 6, '2'], [12, 15, '1']],
    [[4, 6, '2'], [12, 15, '1']],
    [[3, 6, '4'], [12, 16, '3']],
    [[3, 6, '4'], [12, 16, '3']],
  ]),
  palette: {
    B: '#3d2a1f',
    b: '#2a1c16',
    R: '#1a1410',
    H: '#4a3326',
    M: '#2a1c16',
    K: '#c4a574',
    E: '#ffb15c',
    T: '#4a3326',
    '1': '#332218',
    '2': '#2c1d15',
    '3': '#1a120e',
    '4': '#16100c',
  },
  spread: { R: 'centre', E: 'sides', K: 'pair', T: 'centre', '1': 'pair', '2': 'pair', '3': 'pair', '4': 'pair' },
  part: { '1': 'legFront', '3': 'legFront', '2': 'legBack', '4': 'legBack', T: 'tail', H: 'head', M: 'head', E: 'head', K: 'head' },
  emissive: ['E'],
  height: speciesSpecs.BOAR.height,
  depth: speciesSpecs.BOAR.depth,
})

const plans: Record<SpeciesId, () => SpritePlan> = {
  CHICKEN: chickenPlan,
  REINDEER: reindeerPlan,
  BEAR: bearPlan,
  WOLF: wolfPlan,
  BOAR: boarPlan,
}

/** One template per species; animals are clones with their own materials. */
function buildTemplate(species: SpeciesId) {
  return buildAnimalSprite(plans[species]())
}

/* ----------------------------- runtime ----------------------------- */

export type AnimalState = 'graze' | 'wander' | 'flee' | 'chase' | 'windup' | 'recover' | 'dead'

/**
 * Crowd control the player's kit can apply. Held as absolute timestamps rather
 * than remaining durations, so reapplying an effect refreshes it instead of
 * stacking, and nothing can accumulate without bound.
 *
 * The distinction the combat system relies on: a root stops movement only, a
 * stun stops movement and actions.
 */
export type AnimalStatus = {
  slowUntil: number
  /** Movement multiplier while slowed; 1 is unslowed. */
  slowFactor: number
  rootUntil: number
  stunUntil: number
  /** Decaying shove in metres per second, applied after the AI has moved. */
  knock: THREE.Vector3
  /** Current knock-up height and when the animal lands again. */
  lift: number
  liftUntil: number
  liftFrom: number
}

export function emptyStatus(): AnimalStatus {
  return { slowUntil: 0, slowFactor: 1, rootUntil: 0, stunUntil: 0, knock: new THREE.Vector3(), lift: 0, liftUntil: 0, liftFrom: 0 }
}

export type Animal = {
  id: number
  species: SpeciesSpec
  group: THREE.Group
  hitbox: THREE.Mesh
  parts: Partial<Record<PartId, THREE.Group>>
  materials: THREE.MeshStandardMaterial[]
  hp: number
  state: AnimalState
  region: WildRegion
  home: THREE.Vector3
  destination: THREE.Vector3
  heading: number
  phase: number
  stateUntil: number
  nextAttackAt: number
  flashUntil: number
  barUntil: number
  deadAt: number
  respawnAt: number
  velocity: THREE.Vector3
  bar: THREE.Group | null
  barFill: THREE.Mesh | null
  telegraph: THREE.Mesh | null
  strike: number
  status: AnimalStatus
}

export type Kill = {
  species: SpeciesId
  label: string
  position: THREE.Vector3
  goldBaseUnits: number
  coins: number[]
}

export type WildlifeOptions = {
  onKill: (kill: Kill) => void
  onPlayerDamage: (amount: number, species: SpeciesSpec, from: THREE.Vector3) => void
  seed?: number
}

export type WildlifeSystem = {
  animals: Animal[]
  update: (dt: number, now: number, playerPos: THREE.Vector3, camera: THREE.Camera, playerVulnerable: boolean) => void
  damageIn: (center: THREE.Vector3, radius: number, damage: number, now: number) => { hits: number; killed: number; hit: Animal[] }
  /**
   * The single place one animal takes damage. Every ability, projectile and
   * damage-over-time in src/battle routes through here, so a kill — and the
   * reward it pays — can only ever happen once.
   */
  hurt: (animal: Animal, damage: number, now: number, options?: { knockback?: number; from?: THREE.Vector3; aggro?: boolean }) => { killed: boolean; dealt: number }
  /** Living animals whose body overlaps a circle on the ground. */
  animalsIn: (center: THREE.Vector3, radius: number) => Animal[]
  applyStatus: (animal: Animal, kind: 'slow' | 'root' | 'stun', durationMs: number, now: number, factor?: number) => void
  knockBack: (animal: Animal, direction: THREE.Vector3, strength: number) => void
  knockUp: (animal: Animal, height: number, durationMs: number, now: number) => void
  pull: (center: THREE.Vector3, radius: number, strength: number) => void
  nearest: (position: THREE.Vector3, radius: number) => Animal | null
  pick: (raycaster: THREE.Raycaster, maxDistance: number) => Animal | null
  aimAssist: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, maxAngle: number) => Animal | null
  clearAggro: () => void
  aggroCount: () => number
  dispose: () => void
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Split an integer payout into whole coins; no floating point ever escapes. */
function splitCoins(total: number, count: number): number[] {
  const coins = Math.max(1, Math.min(count, total))
  const base = Math.floor(total / coins)
  const remainder = total - base * coins
  return Array.from({ length: coins }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * A point somewhere on the region's open green, chosen without bias toward its
 * heart: a lobe is picked in proportion to its area, then a point inside it.
 * Sampling the bounding circle instead would crowd everything into the middle
 * of the largest lobe, which is the look this replaced.
 */
function randomGreenPoint(region: WildRegion, rng: () => number): THREE.Vector3 | null {
  const area = region.lobes.reduce((sum, lobe) => sum + lobe.r * lobe.r, 0)
  for (let attempt = 0; attempt < 120; attempt++) {
    let pick = rng() * area
    let lobe = region.lobes[0]
    for (const candidate of region.lobes) {
      lobe = candidate
      pick -= candidate.r * candidate.r
      if (pick <= 0) break
    }
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * lobe.r
    const x = lobe.x + Math.cos(angle) * radius
    const z = lobe.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2)) continue
    if (!insideRegion(region, x, z, ROAM_INSET + 0.5)) continue
    return new THREE.Vector3(x, 0, z)
  }
  return null
}

let active: WildlifeSystem | null = null

/** Live animal positions for the map panel, without exposing the scene. */
export function wildlifeMarkers(): Array<{ x: number; z: number; species: SpeciesId; alive: boolean }> {
  if (!active) return []
  return active.animals.map(animal => ({
    x: animal.group.position.x,
    z: animal.group.position.z,
    species: animal.species.id,
    alive: animal.state !== 'dead',
  }))
}

export function createWildlife(scene: THREE.Scene, options: WildlifeOptions): WildlifeSystem {
  const rng = mulberry32(options.seed ?? 20260927)
  const root = new THREE.Group()
  root.name = 'wildlife'
  scene.add(root)

  const templates = new Map<SpeciesId, BuiltSprite>()
  const templateFor = (species: SpeciesId) => {
    if (!templates.has(species)) templates.set(species, buildTemplate(species))
    return templates.get(species)!
  }

  const barBack = new THREE.PlaneGeometry(1, 0.1)
  const barFillGeometry = new THREE.PlaneGeometry(1, 0.08)
  barFillGeometry.translate(0.5, 0, 0)
  const ringGeometry = new THREE.RingGeometry(0.72, 0.98, 20)
  const disposables: Array<{ dispose: () => void }> = [barBack, barFillGeometry, ringGeometry]

  const animals: Animal[] = []
  let nextId = 1

  const cloneSprite = (species: SpeciesId) => {
    const template = templateFor(species)
    const group = template.group.clone(true)
    const parts: Partial<Record<PartId, THREE.Group>> = {}
    const materials: THREE.MeshStandardMaterial[] = []
    const partIds = Object.keys(template.parts) as PartId[]
    partIds.forEach((part, index) => {
      parts[part] = group.children[index] as THREE.Group
    })
    group.traverse(object => {
      const mesh = object as THREE.InstancedMesh
      if (!mesh.isInstancedMesh) return
      const cloned = (mesh.material as THREE.MeshStandardMaterial).clone()
      mesh.material = cloned
      materials.push(cloned)
    })
    return { group, parts, materials, size: template.size }
  }

  const spawn = (species: SpeciesSpec, region: WildRegion) => {
    const point = randomGreenPoint(region, rng)
    if (!point) return
    const { group, parts, materials, size } = cloneSprite(species.id)
    const holder = new THREE.Group()
    holder.add(group)
    holder.position.copy(point)
    holder.rotation.y = rng() * Math.PI * 2
    // The town's proximity prompt reads userData.animal, so keep that contract.
    holder.userData.animal = species.label
    holder.userData.species = species.id

    // Aim target. Raycasting a box is far cheaper than walking a few hundred
    // instanced cubes, and THREE.Raycaster ignores `visible`, so it costs no
    // draw call either.
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(size.x, 0.6), size.y, size.z),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    hitbox.visible = false
    hitbox.position.y = size.y / 2
    holder.add(hitbox)
    disposables.push(hitbox.geometry, hitbox.material as THREE.Material)

    const animal: Animal = {
      id: nextId++,
      species,
      group: holder,
      hitbox,
      parts,
      materials,
      hp: species.maxHp,
      state: 'graze',
      region,
      home: point.clone(),
      destination: point.clone(),
      heading: holder.rotation.y,
      phase: rng() * Math.PI * 2,
      stateUntil: 0,
      nextAttackAt: 0,
      flashUntil: 0,
      barUntil: 0,
      deadAt: 0,
      respawnAt: 0,
      velocity: new THREE.Vector3(),
      bar: null,
      barFill: null,
      telegraph: null,
      strike: 0,
      status: emptyStatus(),
    }
    hitbox.userData.animalId = animal.id
    animals.push(animal)
    root.add(holder)
  }

  for (const region of wildRegions) {
    for (const [id, count] of Object.entries(region.counts) as Array<[SpeciesId, number]>) {
      for (let i = 0; i < count; i++) spawn(speciesSpecs[id], region)
    }
  }

  const byId = new Map(animals.map(animal => [animal.id, animal]))

  const ensureBar = (animal: Animal) => {
    if (animal.bar) return
    const bar = new THREE.Group()
    const width = Math.max(0.7, animal.species.height * 0.55)
    const back = new THREE.Mesh(barBack, new THREE.MeshBasicMaterial({ color: '#10141f', transparent: true, opacity: 0.85 }))
    back.scale.x = width
    const fill = new THREE.Mesh(barFillGeometry, new THREE.MeshBasicMaterial({ color: '#8fbf5a' }))
    fill.position.x = -width / 2
    fill.position.z = 0.01
    fill.scale.x = width
    bar.add(back, fill)
    bar.position.y = animal.species.height + 0.42
    bar.visible = false
    animal.group.add(bar)
    animal.bar = bar
    animal.barFill = fill
    disposables.push(back.material as THREE.Material, fill.material as THREE.Material)
  }

  const ensureTelegraph = (animal: Animal) => {
    if (animal.telegraph) return
    const ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ color: '#e35e35', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.07
    ring.scale.setScalar(animal.species.attackRange * 0.9)
    ring.visible = false
    animal.group.add(ring)
    animal.telegraph = ring
    disposables.push(ring.material as THREE.Material)
  }

  // Remember the original glow before any hit flash overwrites it.
  animals.forEach(animal =>
    animal.materials.forEach(material => {
      material.userData.glow = material.emissiveIntensity
      material.userData.glowColor = material.emissive.getHex()
    }),
  )

  const flash = (animal: Animal, now: number) => {
    animal.flashUntil = now + 130
    animal.materials.forEach(material => {
      material.emissive.set('#ffd9a0')
      material.emissiveIntensity = 0.9
    })
  }

  const unflash = (animal: Animal) => {
    animal.materials.forEach(material => {
      material.emissive.setHex((material.userData.glowColor as number) ?? 0)
      material.emissiveIntensity = (material.userData.glow as number) ?? 0
    })
  }

  const kill = (animal: Animal, now: number) => {
    animal.state = 'dead'
    animal.hp = 0
    animal.deadAt = now
    animal.respawnAt = now + animal.species.respawnMs
    if (animal.bar) animal.bar.visible = false
    if (animal.telegraph) animal.telegraph.visible = false
    const total = animal.species.goldBaseUnits
    options.onKill({
      species: animal.species.id,
      label: animal.species.label,
      position: animal.group.position.clone(),
      goldBaseUnits: total,
      coins: splitCoins(total, animal.species.coins),
    })
  }

  /** How each threat tier answers being hit. Shared by every damage source. */
  const reactToHit = (animal: Animal, now: number) => {
    if (animal.species.threat === 'passive') {
      animal.state = 'flee'
      animal.stateUntil = now + 2600
    } else if (animal.species.threat === 'defensive') {
      // Reindeer stand their ground until badly hurt, then bolt.
      animal.state = animal.hp < animal.species.maxHp * 0.35 ? 'flee' : 'chase'
      if (animal.state === 'flee') animal.stateUntil = now + 3200
    } else {
      animal.state = 'chase'
    }
  }

  const respawn = (animal: Animal, now: number) => {
    const point = randomGreenPoint(animal.region, rng) ?? animal.home.clone()
    animal.group.position.copy(point)
    animal.group.rotation.set(0, rng() * Math.PI * 2, 0)
    animal.home.copy(point)
    animal.destination.copy(point)
    animal.hp = animal.species.maxHp
    animal.state = 'graze'
    animal.stateUntil = now + 1200 + rng() * 2000
    animal.velocity.set(0, 0, 0)
    animal.group.visible = true
    animal.group.scale.setScalar(1)
    animal.strike = 0
    // A respawn is a new animal: nothing it suffered before carries over.
    animal.status = emptyStatus()
  }

  /**
   * The one place an animal moves. Two rules, and both hold for every caller.
   *
   * Rule one, which was always here: stay on open green, never on pavement.
   * Rule two, which was NOT here and is why animals escaped: stay on your own
   * ground.
   *
   * The region bound used to be applied in exactly two places — when an animal
   * was spawned, and when it chose a wander destination. Nowhere else. So
   * fleeing (which steers purely away from the player), chasing (bounded only
   * by a 30m leash from the spawn point, larger than most regions), knockback,
   * the pull ability and crowd separation all moved animals with `isGreen` as
   * their only constraint, and walked them clean out of the wood. Applying the
   * bound at the funnel instead of at each of those call sites is what makes it
   * impossible for the next movement path to leak.
   *
   * An animal that somehow starts outside is not frozen in place: any step that
   * reduces its distance to the region is allowed, so it walks itself home
   * rather than standing in a field forever.
   */
  const step = (animal: Animal, dx: number, dz: number) => {
    const position = animal.group.position
    const from = regionDistance(animal.region, position.x, position.z)
    const allowed = (x: number, z: number) => {
      if (!isGreen(x, z, 0.5)) return false
      const to = regionDistance(animal.region, x, z)
      return to <= -ROAM_INSET || to < from
    }
    if (allowed(position.x + dx, position.z + dz)) {
      position.x += dx
      position.z += dz
      return true
    }
    if (allowed(position.x + dx, position.z)) {
      position.x += dx
      return true
    }
    if (allowed(position.x, position.z + dz)) {
      position.z += dz
      return true
    }
    return false
  }

  const separate = (animal: Animal, dt: number) => {
    for (const other of animals) {
      if (other === animal || other.state === 'dead') continue
      const dx = animal.group.position.x - other.group.position.x
      const dz = animal.group.position.z - other.group.position.z
      const minimum = (animal.species.depth * 0.09 + other.species.depth * 0.09) + 0.8
      const distanceSq = dx * dx + dz * dz
      if (distanceSq > minimum * minimum || distanceSq < 1e-6) continue
      const distance = Math.sqrt(distanceSq)
      const push = ((minimum - distance) / minimum) * dt * 2.4
      step(animal, (dx / distance) * push, (dz / distance) * push)
    }
  }

  const moveToward = (animal: Animal, targetX: number, targetZ: number, speed: number, dt: number) => {
    const dx = targetX - animal.group.position.x
    const dz = targetZ - animal.group.position.z
    const distance = Math.hypot(dx, dz)
    if (distance < 0.05) return 0
    const stepSize = Math.min(speed * dt, distance)
    const moved = step(animal, (dx / distance) * stepSize, (dz / distance) * stepSize)
    animal.heading = Math.atan2(dx, dz)
    return moved ? stepSize : 0
  }

  /** Knockback and knock-up, drained on their own clock so CC never sticks. */
  const applyShove = (animal: Animal, dt: number, now: number) => {
    const status = animal.status
    if (status.knock.lengthSq() > 1e-5) {
      step(animal, status.knock.x * dt, status.knock.z * dt)
      status.knock.multiplyScalar(Math.exp(-dt * 6))
      if (status.knock.lengthSq() < 1e-5) status.knock.set(0, 0, 0)
    }
    if (status.lift !== 0 && now >= status.liftUntil) status.lift = 0
  }

  /** Height above the ground right now, from the knock-up arc. */
  const airHeight = (animal: Animal, now: number) => {
    const { lift, liftFrom, liftUntil } = animal.status
    if (!lift || now >= liftUntil) return 0
    const span = Math.max(1, liftUntil - liftFrom)
    return Math.sin(Math.min(1, Math.max(0, (now - liftFrom) / span)) * Math.PI) * lift
  }

  /** Turning, gait, strike pose and the health bar: the same tail every frame. */
  const faceAndSettle = (animal: Animal, dt: number, now: number, camera: THREE.Camera, moving: boolean) => {
    const spec = animal.species
    const delta = ((animal.heading - animal.group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    animal.group.rotation.y += delta * Math.min(1, dt * 7)
    animal.phase += dt * (moving ? 7 + spec.walkSpeed : 1.3)
    const swing = moving ? 0.5 : 0.04
    if (animal.parts.legFront) animal.parts.legFront.rotation.x = Math.sin(animal.phase) * swing
    if (animal.parts.legBack) animal.parts.legBack.rotation.x = -Math.sin(animal.phase) * swing
    if (animal.parts.tail) animal.parts.tail.rotation.y = Math.sin(animal.phase * 0.6) * 0.35
    if (animal.parts.head) {
      const graze = animal.state === 'graze' ? 0.34 + Math.sin(animal.phase * 0.5) * 0.12 : 0
      animal.parts.head.rotation.x = graze + animal.strike
    }
    const airborne = airHeight(animal, now)
    animal.group.position.y =
      (moving ? Math.abs(Math.sin(animal.phase)) * 0.03 : Math.sin(animal.phase * 0.7) * 0.012) +
      animal.strike * -0.12 +
      airborne
    animal.group.rotation.x = animal.strike * 0.5

    if (animal.bar) {
      const show = now < animal.barUntil && animal.hp > 0
      animal.bar.visible = show
      if (show) {
        animal.bar.quaternion.copy(camera.quaternion)
        const ratio = Math.max(0, animal.hp / spec.maxHp)
        const width = Math.max(0.7, spec.height * 0.55)
        if (animal.barFill) {
          animal.barFill.scale.x = width * ratio
          const material = animal.barFill.material as THREE.MeshBasicMaterial
          material.color.set(ratio > 0.55 ? '#8fbf5a' : ratio > 0.25 ? '#e0a63f' : '#e35e35')
        }
      }
    }
  }

  /**
   * Where to graze next.
   *
   * Mostly somewhere nearby, which reads as grazing. The rest of the time,
   * anywhere on the region — because the old version only ever sampled within
   * twenty metres of the spawn point, so a herd lived out its whole life inside
   * one circle whatever shape the ground was. Drifting `home` along with the
   * far walks is what lets an animal end up genuinely on the other side of the
   * wood from where it started.
   */
  const pickDestination = (animal: Animal) => {
    const position = animal.group.position
    if (rng() < 0.68) {
      for (let attempt = 0; attempt < 18; attempt++) {
        const angle = rng() * Math.PI * 2
        const radius = 4 + rng() * 16
        const x = position.x + Math.cos(angle) * radius
        const z = position.z + Math.sin(angle) * radius
        if (isGreen(x, z, 1.5) && insideRegion(animal.region, x, z, ROAM_INSET + 0.5)) {
          animal.destination.set(x, 0, z)
          return
        }
      }
    }
    const far = randomGreenPoint(animal.region, rng)
    if (far) {
      animal.destination.copy(far)
      animal.home.copy(far)
      return
    }
    animal.destination.copy(animal.home)
  }

  const system: WildlifeSystem = {
    animals,
    update(dt, now, playerPos, camera, playerVulnerable) {
      const playerSafe = isSafeZone(playerPos.x, playerPos.z)
      for (const animal of animals) {
        const spec = animal.species
        if (animal.flashUntil && now > animal.flashUntil) {
          animal.flashUntil = 0
          unflash(animal)
        }

        if (animal.state === 'dead') {
          const elapsed = now - animal.deadAt
          if (elapsed < 900) {
            // Topple sideways and sink: unmistakably dead, no ragdoll needed.
            const t = elapsed / 900
            animal.group.rotation.z = -t * Math.PI * 0.42
            animal.group.position.y = -t * spec.height * 0.18
          } else if (animal.group.visible) {
            animal.group.visible = false
          }
          if (now >= animal.respawnAt) {
            animal.group.rotation.z = 0
            animal.group.position.y = 0
            respawn(animal, now)
          }
          continue
        }

        const toPlayer = new THREE.Vector3(playerPos.x - animal.group.position.x, 0, playerPos.z - animal.group.position.z)
        const distance = toPlayer.length()
        const huntable = playerVulnerable && !playerSafe
        /* Aggro is bounded by the animal's own ground, not by a radius around
         * wherever it happened to spawn. The old leash was 30m from the spawn
         * point — larger than every region on the map — so an aggressive animal
         * was positively licensed to chase the player out of the wood, and once
         * out, nothing but `isGreen` was still holding it. Now a wolf hunts
         * while the player is in the Brasswood or within a few strides of its
         * edge, and loses interest beyond that. */
        const leashed = regionDistance(animal.region, playerPos.x, playerPos.z) < AGGRO_REACH

        // --- crowd control ------------------------------------------------
        // A stun stops everything; a root only stops the feet, which is why it
        // is expressed as a speed of zero rather than as an early return.
        const status = animal.status
        const stunned = now < status.stunUntil
        const rooted = now < status.rootUntil
        const speedScale = stunned || rooted ? 0 : now < status.slowUntil ? status.slowFactor : 1
        if (stunned) {
          if (animal.state === 'windup') {
            if (animal.telegraph) animal.telegraph.visible = false
            animal.state = 'chase'
            animal.strike = 0
          }
          // Still bleed off knockback and finish a knock-up while stunned.
          applyShove(animal, dt, now)
          faceAndSettle(animal, dt, now, camera, false)
          continue
        }

        // --- threat behaviour -------------------------------------------------
        if (spec.threat === 'aggressive' && huntable && leashed && distance < spec.noticeRadius && animal.state !== 'windup' && animal.state !== 'recover') {
          animal.state = 'chase'
        }
        if (spec.threat === 'passive' && distance < spec.noticeRadius && animal.state !== 'flee') {
          animal.state = 'flee'
          animal.stateUntil = now + 1400 + rng() * 900
        }
        if ((animal.state === 'chase' || animal.state === 'recover') && (!huntable || distance > spec.noticeRadius * 1.8 || !leashed)) {
          animal.state = 'graze'
          animal.stateUntil = now + 800
        }

        let moving = false
        switch (animal.state) {
          case 'graze':
            if (now > animal.stateUntil) {
              pickDestination(animal)
              animal.state = 'wander'
              animal.stateUntil = now + 4000 + rng() * 6000
            }
            break
          case 'wander': {
            const advanced = moveToward(animal, animal.destination.x, animal.destination.z, spec.walkSpeed * speedScale, dt)
            moving = advanced > 0
            if (!moving || animal.group.position.distanceTo(animal.destination) < 0.8 || now > animal.stateUntil) {
              animal.state = 'graze'
              animal.stateUntil = now + 1500 + rng() * 4000
            }
            break
          }
          case 'flee': {
            const away = distance > 0.01 ? toPlayer.clone().multiplyScalar(-1 / distance) : new THREE.Vector3(1, 0, 0)
            // Skitter: a perpendicular wobble so flight is never a straight line.
            const wobble = Math.sin(now * 0.006 + animal.phase) * 0.5
            const ax = away.x - away.z * wobble
            const az = away.z + away.x * wobble
            away.set(ax, 0, az).normalize()
            /* Approaching the edge of its own ground, flight bends back along
             * it. The fence in step() would stop the animal dead otherwise, and
             * a chicken shuddering against an invisible wall for three seconds
             * is the other half of what "the animals bug out of the area" looks
             * like — the escape was one symptom, this was the other. */
            const edge = regionDistance(animal.region, animal.group.position.x, animal.group.position.z)
            if (edge > -FLEE_TURN_BAND) {
              const inward = regionInward(animal.region, animal.group.position.x, animal.group.position.z)
              const blend = Math.min(1, (edge + FLEE_TURN_BAND) / FLEE_TURN_BAND)
              away.set(away.x + inward.x * blend * 1.8, 0, away.z + inward.z * blend * 1.8).normalize()
            }
            const speed = (spec.fleeSpeed || spec.walkSpeed) * speedScale
            moving = moveToward(animal, animal.group.position.x + away.x * 4, animal.group.position.z + away.z * 4, speed, dt) > 0
            if (!moving) {
              animal.heading += 1.2 * dt
            }
            if (now > animal.stateUntil && distance > spec.noticeRadius * 0.9) {
              animal.state = 'graze'
              animal.stateUntil = now + 900 + rng() * 1500
            }
            break
          }
          case 'chase': {
            if (distance <= spec.attackRange && now >= animal.nextAttackAt) {
              animal.state = 'windup'
              animal.stateUntil = now + spec.windUpMs
              ensureTelegraph(animal)
              if (animal.telegraph) animal.telegraph.visible = true
            } else {
              moving = moveToward(animal, playerPos.x, playerPos.z, spec.chaseSpeed * speedScale, dt) > 0
              if (!moving && !rooted && distance > spec.attackRange) {
                // Blocked by town geometry: give up rather than grind at the wall.
                animal.state = 'graze'
                animal.stateUntil = now + 1200
              }
            }
            break
          }
          case 'windup': {
            const t = 1 - (animal.stateUntil - now) / Math.max(spec.windUpMs, 1)
            animal.strike = -0.42 * Math.min(1, Math.max(0, t))
            if (animal.telegraph) {
              const material = animal.telegraph.material as THREE.MeshBasicMaterial
              material.opacity = 0.35 + 0.5 * Math.abs(Math.sin(now * 0.02))
            }
            animal.heading = Math.atan2(toPlayer.x, toPlayer.z)
            if (now >= animal.stateUntil) {
              if (animal.telegraph) animal.telegraph.visible = false
              animal.strike = 0.3
              animal.nextAttackAt = now + spec.attackCooldownMs
              animal.state = 'recover'
              animal.stateUntil = now + 420
              // The telegraph is the contract: step out of range and it misses.
              if (huntable && distance <= spec.attackRange * 1.25) {
                options.onPlayerDamage(spec.attackDamage, spec, animal.group.position.clone())
              }
            }
            break
          }
          case 'recover': {
            animal.strike *= Math.exp(-dt * 8)
            if (now >= animal.stateUntil) {
              animal.state = spec.threat === 'passive' ? 'flee' : 'chase'
              if (animal.state === 'flee') animal.stateUntil = now + 1200
            }
            break
          }
        }

        separate(animal, dt)
        applyShove(animal, dt, now)
        faceAndSettle(animal, dt, now, camera, moving)
      }
    },

    damageIn(center, radius, damage, now) {
      const hit: Animal[] = []
      let killed = 0
      for (const animal of system.animalsIn(center, radius)) {
        const result = system.hurt(animal, damage, now, { from: center, knockback: 1.4 })
        hit.push(animal)
        if (result.killed) killed++
      }
      return { hits: hit.length, killed, hit }
    },

    hurt(animal, damage, now, options) {
      // Dead animals absorb nothing. This is the guard that makes a kill, and
      // therefore its XP and loot, land exactly once no matter how many
      // projectiles, ticks or chains arrive in the same frame.
      if (animal.state === 'dead') return { killed: false, dealt: 0 }
      const dealt = Math.max(0, Math.round(damage))
      if (dealt <= 0) return { killed: false, dealt: 0 }
      animal.hp -= dealt
      animal.barUntil = now + 4500
      ensureBar(animal)
      flash(animal, now)
      if (options?.knockback && options.from) {
        const away = new THREE.Vector3(animal.group.position.x - options.from.x, 0, animal.group.position.z - options.from.z)
        if (away.lengthSq() > 1e-6) system.knockBack(animal, away.normalize(), options.knockback)
      }
      if (animal.hp <= 0) {
        kill(animal, now)
        return { killed: true, dealt }
      }
      if (options?.aggro !== false) reactToHit(animal, now)
      return { killed: false, dealt }
    },

    animalsIn(center, radius) {
      const out: Animal[] = []
      for (const animal of animals) {
        if (animal.state === 'dead') continue
        const dx = animal.group.position.x - center.x
        const dz = animal.group.position.z - center.z
        if (Math.hypot(dx, dz) <= radius + animal.species.height * 0.35) out.push(animal)
      }
      return out
    },

    applyStatus(animal, kind, durationMs, now, factor = 1) {
      if (animal.state === 'dead') return
      const status = animal.status
      // Refresh, never extend: the later of "already running" and "just applied".
      if (kind === 'slow') {
        const active = now < status.slowUntil
        const wanted = Math.max(0.15, Math.min(1, factor))
        // The strongest slow wins while one is already running; otherwise the
        // new one simply replaces the stale value.
        status.slowFactor = active ? Math.min(status.slowFactor, wanted) : wanted
        status.slowUntil = Math.max(active ? status.slowUntil : 0, now + durationMs)
      } else if (kind === 'root') {
        status.rootUntil = Math.max(status.rootUntil, now + durationMs)
      } else {
        status.stunUntil = Math.max(status.stunUntil, now + durationMs)
      }
    },

    knockBack(animal, direction, strength) {
      if (animal.state === 'dead') return
      animal.status.knock.copy(direction).setY(0).normalize().multiplyScalar(strength)
    },

    knockUp(animal, height, durationMs, now) {
      if (animal.state === 'dead') return
      animal.status.lift = height
      animal.status.liftFrom = now
      animal.status.liftUntil = now + durationMs
      // A knock-up is a stun for as long as the animal is off the ground.
      animal.status.stunUntil = Math.max(animal.status.stunUntil, now + durationMs)
    },

    pull(center, radius, strength) {
      for (const animal of animals) {
        if (animal.state === 'dead') continue
        const dx = center.x - animal.group.position.x
        const dz = center.z - animal.group.position.z
        const distance = Math.hypot(dx, dz)
        if (distance > radius || distance < 0.2) continue
        const amount = (1 - distance / radius) * strength
        step(animal, (dx / distance) * amount, (dz / distance) * amount)
      }
    },

    nearest(position, radius) {
      let best: Animal | null = null
      let bestDistance = radius
      for (const animal of animals) {
        if (animal.state === 'dead') continue
        const distance = animal.group.position.distanceTo(position)
        if (distance < bestDistance) {
          best = animal
          bestDistance = distance
        }
      }
      return best
    },

    pick(raycaster, maxDistance) {
      const boxes = animals.filter(animal => animal.state !== 'dead').map(animal => animal.hitbox)
      for (const intersection of raycaster.intersectObjects(boxes, false)) {
        if (intersection.distance > maxDistance) continue
        const animal = byId.get(intersection.object.userData.animalId as number)
        if (animal && animal.state !== 'dead') return animal
      }
      return null
    },

    aimAssist(origin, direction, maxDistance, maxAngle) {
      let best: Animal | null = null
      let bestAngle = maxAngle
      const toAnimal = new THREE.Vector3()
      for (const animal of animals) {
        if (animal.state === 'dead') continue
        toAnimal.copy(animal.group.position).setY(animal.species.height * 0.5).sub(origin)
        const distance = toAnimal.length()
        if (distance > maxDistance || distance < 0.001) continue
        const angle = direction.angleTo(toAnimal.divideScalar(distance))
        if (angle < bestAngle) {
          bestAngle = angle
          best = animal
        }
      }
      return best
    },

    clearAggro() {
      for (const animal of animals) {
        if (animal.state === 'chase' || animal.state === 'windup' || animal.state === 'recover') {
          animal.state = 'graze'
          animal.stateUntil = 0
          animal.strike = 0
          if (animal.telegraph) animal.telegraph.visible = false
        }
      }
    },

    aggroCount() {
      return animals.filter(animal => animal.state === 'chase' || animal.state === 'windup' || animal.state === 'recover').length
    },

    dispose() {
      scene.remove(root)
      for (const template of templates.values()) {
        template.geometry.dispose()
        template.materials.forEach(material => material.dispose())
      }
      animals.forEach(animal => animal.materials.forEach(material => material.dispose()))
      disposables.forEach(item => item.dispose())
      animals.length = 0
      if (active === system) active = null
    },
  }

  active = system
  return system
}
