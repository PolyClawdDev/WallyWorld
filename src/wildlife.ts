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

export type SpeciesId = 'CHICKEN' | 'REINDEER' | 'BEAR'
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
}

/* --------------------------- regions --------------------------- */

export type WildRegionKind = 'wildwood' | 'woods' | 'grassland' | 'meadow' | 'fields' | 'outskirts'

export type WildRegion = {
  id: string
  label: string
  kind: WildRegionKind
  x: number
  z: number
  radius: number
  note: string
  /** Ground tint used by the scenery pass, reused by the map panel. */
  color: string
  counts: Partial<Record<SpeciesId, number>>
}

/**
 * Exported as plain data so the map panel can draw the hunting region without
 * reaching into the Three.js scene.
 */
export const wildRegions: WildRegion[] = [
  {
    id: 'wildwood',
    label: 'THE WILDWOOD',
    kind: 'wildwood',
    x: -58,
    z: -58,
    radius: 30,
    note: 'Dense pine, standing stones, a still pond. Bears.',
    color: '#2c3f34',
    counts: { BEAR: 4, REINDEER: 5, CHICKEN: 1 },
  },
  {
    id: 'hollow',
    label: 'ELDER HOLLOW',
    kind: 'woods',
    x: -25,
    z: -78,
    radius: 14,
    note: 'Old wood south of the chapel. One bear works this patch.',
    color: '#2f4338',
    counts: { BEAR: 1, REINDEER: 2, CHICKEN: 2 },
  },
  {
    id: 'northmeadow',
    label: 'LANTERN MEADOW',
    kind: 'grassland',
    x: 28,
    z: 78,
    radius: 16,
    note: 'Open grass above the post road. Reindeer graze here.',
    color: '#3b5342',
    counts: { REINDEER: 2, CHICKEN: 4 },
  },
  {
    id: 'eastmeadow',
    label: 'EAST COMMON',
    kind: 'meadow',
    x: 80,
    z: -28,
    radius: 13,
    note: 'Scrub east of the market. Easy starting ground.',
    color: '#3e5544',
    counts: { REINDEER: 1, CHICKEN: 3 },
  },
  {
    id: 'southfields',
    label: 'SOUTH FIELDS',
    kind: 'fields',
    x: 18,
    z: -45,
    radius: 12,
    note: 'Fenced fields by the canal. Chickens everywhere.',
    color: '#42583f',
    counts: { REINDEER: 1, CHICKEN: 3 },
  },
  {
    id: 'westoutskirts',
    label: 'WEST OUTSKIRTS',
    kind: 'outskirts',
    x: -85,
    z: -24,
    radius: 11,
    note: 'Thin grass at the world edge.',
    color: '#3d5140',
    counts: { CHICKEN: 2 },
  },
]

/** The headline hunting area, and where the HUD compass points. */
export const huntingArea = wildRegions[0]

const regionAccent: Record<WildRegionKind, string> = {
  wildwood: '#e35e35',
  woods: '#9ca66d',
  grassland: '#9ca66d',
  meadow: '#7bc9ce',
  fields: '#7bc9ce',
  outskirts: '#849394',
}

// townData leaves an empty `huntingRegions` seam for exactly this. Filling it
// here keeps the map popup a projection of the live spawn data.
huntingRegions.push(
  ...wildRegions.map(region => ({
    name: region.label,
    x: region.x,
    z: region.z,
    radius: region.radius,
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

const plans: Record<SpeciesId, () => SpritePlan> = {
  CHICKEN: chickenPlan,
  REINDEER: reindeerPlan,
  BEAR: bearPlan,
}

/** One template per species; animals are clones with their own materials. */
function buildTemplate(species: SpeciesId) {
  return buildAnimalSprite(plans[species]())
}

/* ----------------------------- runtime ----------------------------- */

export type AnimalState = 'graze' | 'wander' | 'flee' | 'chase' | 'windup' | 'recover' | 'dead'

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

function randomGreenPoint(region: WildRegion, rng: () => number): THREE.Vector3 | null {
  for (let attempt = 0; attempt < 80; attempt++) {
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * region.radius
    const x = region.x + Math.cos(angle) * radius
    const z = region.z + Math.sin(angle) * radius
    if (isGreen(x, z, 2)) return new THREE.Vector3(x, 0, z)
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
  }

  const step = (animal: Animal, dx: number, dz: number) => {
    const position = animal.group.position
    if (isGreen(position.x + dx, position.z + dz, 0.5)) {
      position.x += dx
      position.z += dz
      return true
    }
    if (isGreen(position.x + dx, position.z, 0.5)) {
      position.x += dx
      return true
    }
    if (isGreen(position.x, position.z + dz, 0.5)) {
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

  const pickDestination = (animal: Animal) => {
    const leash = Math.min(animal.region.radius * 0.8, 20)
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = rng() * Math.PI * 2
      const radius = 3 + rng() * leash
      const x = animal.home.x + Math.cos(angle) * radius
      const z = animal.home.z + Math.sin(angle) * radius
      if (isGreen(x, z, 1.5) && Math.hypot(x - animal.region.x, z - animal.region.z) < animal.region.radius) {
        animal.destination.set(x, 0, z)
        return
      }
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
        const leashed = animal.group.position.distanceTo(animal.home) < 30

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
            const advanced = moveToward(animal, animal.destination.x, animal.destination.z, spec.walkSpeed, dt)
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
            const speed = spec.fleeSpeed || spec.walkSpeed
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
              moving = moveToward(animal, playerPos.x, playerPos.z, spec.chaseSpeed, dt) > 0
              if (!moving && distance > spec.attackRange) {
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

        // --- animation --------------------------------------------------------
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
        animal.group.position.y = (moving ? Math.abs(Math.sin(animal.phase)) * 0.03 : Math.sin(animal.phase * 0.7) * 0.012) + animal.strike * -0.12
        animal.group.rotation.x = animal.strike * 0.5

        // --- health bar -------------------------------------------------------
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
    },

    damageIn(center, radius, damage, now) {
      const hit: Animal[] = []
      let killed = 0
      for (const animal of animals) {
        if (animal.state === 'dead') continue
        const dx = animal.group.position.x - center.x
        const dz = animal.group.position.z - center.z
        const bodyRadius = animal.species.height * 0.35
        if (Math.hypot(dx, dz) > radius + bodyRadius) continue
        animal.hp -= damage
        animal.barUntil = now + 4500
        ensureBar(animal)
        flash(animal, now)
        const knock = new THREE.Vector3(dx, 0, dz)
        if (knock.lengthSq() > 1e-6) {
          knock.normalize().multiplyScalar(0.22)
          step(animal, knock.x, knock.z)
        }
        hit.push(animal)
        if (animal.hp <= 0) {
          kill(animal, now)
          killed++
        } else if (animal.species.threat === 'passive') {
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
      return { hits: hit.length, killed, hit }
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
