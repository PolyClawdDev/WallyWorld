/*
 * Does the wood look like a wood, and can the player and the camera stand up in
 * it?
 *
 * Everything here is measured off the real scene graph and the real navigation
 * grid in Node, not off a screenshot, because the questions are geometric:
 *
 *   1. SPECIES     — where each species' leaves start and stop, how wide its
 *                    bole actually is, and what one instance costs in triangles.
 *   2. FOREST      — trees, draw calls, triangles, and how many stand outside
 *                    the hunting regions.
 *   3. CLUMPING    — for every tree, how close its nearest neighbour's crown
 *                    comes, as a fraction of the two crown radii. This is the
 *                    number the clumping complaint was about.
 *   4. CORRIDOR    — at every position a player can legally stand, is there any
 *                    tree voxel in the space the player's body and the
 *                    first-person eye occupy? Must be zero.
 *   5. CAMERA      — the same question for the third-person orbit, swept over
 *                    yaw, zoom and pitch, before and after the canopy pull-in.
 *   6. ROUTES      — can you still walk from the plaza to every region and
 *                    every duel ring, and how much longer is the trip?
 *   7. RESOURCES   — every geometry, material and texture created against how
 *                    many dispose() frees.
 *
 * Usage: npx tsx scripts/verify-canopy.ts
 */
import * as THREE from 'three'

/* wildscape paints its signpost lettering onto a 2D canvas; nothing here
 * rasterises anything, so a recording stub is enough to build the scene. */
const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D
;(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
}

const disposed = new Set<object>()
for (const proto of [THREE.BufferGeometry.prototype, THREE.Material.prototype, THREE.Texture.prototype]) {
  const original = (proto as { dispose: () => void }).dispose
  ;(proto as { dispose: () => void }).dispose = function patched(this: object) {
    disposed.add(this)
    return original.call(this)
  }
}

const { createWildscape } = await import('../src/wildscape')
const { treeSpecies } = await import('../src/treeArt')
const { createNavGrid } = await import('../src/battle/nav')
const { wildRegions, insideRegion } = await import('../src/wildlife')
const { DUEL_RINGS, TOWN_RESPAWN, WORLD_HALF } = await import('../src/shared/zones')

type Crown = {
  id: string
  scale: number
  squash: number
  x: number
  z: number
  crownRadius: number
  reach: number
  base: number
  top: number
}
type Canopy = {
  corridor: number
  crowns: Crown[]
  inWood: (x: number, y: number, z: number) => boolean
  clearOfWood: (eye: THREE.Vector3, anchor: THREE.Vector3) => THREE.Vector3
}

const root = createWildscape()
const canopy = root.userData.canopy as Canopy
const stats = root.userData.stats as {
  trees: { meshes: number; trees: number; triangles: number; bySpecies: Array<{ id: string; trees: number }> }
  country: { copses: number; hedges: number; hedgePlants: number; lone: number }
  obstacles: number
  corridor: number
  regionArea: Array<{ id: string; area: number }>
}
const nav = createNavGrid(root.userData.obstacles as never[])

const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(2)}%`
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

/* ------------------------------ 1. species ------------------------------ */
console.log('=== 1. species geometry (at scale 1) ===')
console.log('species        height  leafFrom  leafTo  crownR  boleR<4.2  tri/instance')
const SPECIES = ['pine', 'titanpine', 'oak', 'elder', 'birch', 'ironbark', 'scrub'] as const
const triangleCost = new Map<string, number>()
for (const id of SPECIES) {
  const species = treeSpecies(id)
  const triangles = species.shells.reduce((sum, shell) => sum + (shell.geometry.index?.count ?? 0) / 3, 0)
  triangleCost.set(id, triangles)
  console.log(
    `${id.padEnd(13)} ${species.height.toFixed(1).padStart(6)} ${species.canopy.base.toFixed(2).padStart(9)} ` +
    `${species.canopy.top.toFixed(1).padStart(7)} ${species.canopy.radius.toFixed(2).padStart(7)} ` +
    `${species.solidRadiusBelow(4.2).toFixed(2).padStart(10)} ${triangles.toLocaleString().padStart(13)}`,
  )
}

/* ------------------------------ 2. forest ------------------------------- */
const inAnyRegion = (x: number, z: number) => wildRegions.some(region => insideRegion(region, x, z, 0))
const countryTrees = canopy.crowns.filter(crown => !inAnyRegion(crown.x, crown.z)).length
console.log()
console.log('=== 2. the forest ===')
console.log(`trees                ${canopy.crowns.length}`)
console.log(`  inside regions     ${canopy.crowns.length - countryTrees}`)
console.log(`  open country       ${countryTrees}   (${stats.country.copses} copses, ${stats.country.hedges} hedgerows of ${stats.country.hedgePlants} plants, ${stats.country.lone} lone)`)
console.log(`draw calls           ${stats.trees.meshes}`)
console.log(`triangles            ${stats.trees.triangles.toLocaleString()}`)
console.log(`navigation obstacles ${stats.obstacles}`)
console.log()
console.log('species        trees   triangles')
for (const entry of stats.trees.bySpecies) {
  const cost = (triangleCost.get(entry.id) ?? 0) * entry.trees
  console.log(`${entry.id.padEnd(13)} ${String(entry.trees).padStart(6)} ${cost.toLocaleString().padStart(11)}`)
}
console.log()
console.log('region          openGreen m2   trees   m2/tree')
for (const { id, area } of stats.regionArea) {
  const region = wildRegions.find(one => one.id === id)!
  const trees = canopy.crowns.filter(crown => insideRegion(region, crown.x, crown.z, 0)).length
  console.log(`${id.padEnd(14)} ${area.toFixed(0).padStart(12)} ${String(trees).padStart(7)} ${(trees ? area / trees : 0).toFixed(0).padStart(9)}`)
}

/* ----------------------------- 3. clumping ------------------------------ */
/*
 * For each tree, the closest its nearest neighbour's crown comes, expressed as
 * centre distance over the sum of the two crown radii. 0 is concentric, 1 is
 * crowns exactly touching. The planting rule this replaced allowed 0.34, which
 * is why the world was full of single lumps of leaf with several trunks in.
 */
const ratios: number[] = []
for (let i = 0; i < canopy.crowns.length; i++) {
  let closest = Infinity
  for (let j = 0; j < canopy.crowns.length; j++) {
    if (i === j) continue
    const a = canopy.crowns[i]
    const b = canopy.crowns[j]
    const ratio = Math.hypot(a.x - b.x, a.z - b.z) / (a.crownRadius + b.crownRadius)
    if (ratio < closest) closest = ratio
  }
  if (Number.isFinite(closest)) ratios.push(closest)
}
ratios.sort((a, b) => a - b)
console.log()
console.log('=== 3. clumping: nearest neighbour, centre distance / summed crown radii ===')
console.log(`  min      ${quantile(ratios, 0).toFixed(2)}`)
console.log(`  p5       ${quantile(ratios, 0.05).toFixed(2)}`)
console.log(`  p25      ${quantile(ratios, 0.25).toFixed(2)}`)
console.log(`  median   ${quantile(ratios, 0.5).toFixed(2)}`)
console.log(`  p90      ${quantile(ratios, 0.9).toFixed(2)}`)
console.log(`trees whose nearest crown is closer than 0.34 (the old rule's floor): ${ratios.filter(r => r < 0.34).length}`)
console.log(`trees whose nearest crown is closer than 0.46 (the grove floor):      ${ratios.filter(r => r < 0.46).length}`)
console.log(`trees with a crown that touches nothing at all:                       ${ratios.filter(r => r >= 1).length}`)

/* ----------------------------- 4. corridor ------------------------------ */
/*
 * Every position a body of the navigation agent's radius can legally stand, on a
 * 1.5m lattice over the whole playable box. At each one, probe the column the
 * player occupies plus the first-person eye, at the centre and at four points on
 * the body's own circumference — because standing beside a trunk is what puts a
 * shoulder in the leaves.
 */
const BODY = 0.62
const HEIGHTS = [0.3, 0.9, 1.6, 1.9, 2.7]
const RING = [[0, 0], [BODY, 0], [-BODY, 0], [0, BODY], [0, -BODY]] as const
let stands = 0
let violations = 0
const worstCases: Array<{ x: number; z: number; y: number }> = []
for (let x = -WORLD_HALF + 2; x <= WORLD_HALF - 2; x += 1.5) {
  for (let z = -WORLD_HALF + 2; z <= WORLD_HALF - 2; z += 1.5) {
    if (nav.blocked(x, z)) continue
    stands += 1
    let hit: { x: number; z: number; y: number } | null = null
    for (const y of HEIGHTS) {
      for (const [ox, oz] of RING) {
        if (!canopy.inWood(x + ox, y, z + oz)) continue
        hit = { x: x + ox, z: z + oz, y }
        break
      }
      if (hit) break
    }
    if (!hit) continue
    violations += 1
    if (worstCases.length < 8) worstCases.push(hit)
  }
}
console.log()
console.log(`=== 4. the trunk corridor (${stats.corridor}m) ===`)
console.log(`legal standing positions probed   ${stands.toLocaleString()}`)
console.log(`positions with tree voxels in the player's body or eye: ${violations} (${pct(violations, stands)})`)
for (const spot of worstCases) console.log(`  inside wood at ${spot.x.toFixed(1)}, ${spot.y.toFixed(1)}, ${spot.z.toFixed(1)}`)

/* ------------------------------ 5. camera ------------------------------- */
/*
 * The third-person rig, reproduced from src/main.tsx: zoom picks a height and a
 * boom, pitch is an offset on the elevation that framing implies, and the lens
 * never drops below 1.4m. Swept over a sample of standable ground.
 */
const ZOOMS = [3.2, 7, 13, 22, 32]
const PITCHES = [-0.34, 0, 0.4, 0.85]
const YAWS = 8
const standable: Array<[number, number]> = []
for (let x = -WORLD_HALF + 2; x <= WORLD_HALF - 2; x += 3) {
  for (let z = -WORLD_HALF + 2; z <= WORLD_HALF - 2; z += 3) {
    if (!nav.blocked(x, z)) standable.push([x, z])
  }
}
/* A deterministic thinning, so the sweep is a few hundred thousand tests rather
 * than a few million, and the same few hundred thousand every run. */
const sample = standable.filter((_, index) => index % 7 === 0)

const anchor = new THREE.Vector3()
const eye = new THREE.Vector3()
let shots = 0
let insideBefore = 0
let insideAfter = 0
let pulled = 0
let pullTotal = 0
let pullWorst = 0
/** Pull-in as a fraction of the boom, so "the lens slammed into the player" is visible. */
const collapse: number[] = []
for (const [x, z] of sample) {
  anchor.set(x, 1.6, z)
  for (const zoom of ZOOMS) {
    const height = 0.6 + zoom * 0.43
    const baseElevation = Math.atan2(height, zoom)
    const boom = Math.hypot(zoom, height)
    for (const pitch of PITCHES) {
      const elevation = baseElevation + pitch
      const flat = Math.cos(elevation) * boom
      for (let y = 0; y < YAWS; y++) {
        const yaw = (y / YAWS) * Math.PI * 2
        eye.set(
          anchor.x + Math.sin(yaw) * flat,
          Math.max(anchor.y + Math.sin(elevation) * boom, 1.4),
          anchor.z + Math.cos(yaw) * flat,
        )
        shots += 1
        const before = canopy.inWood(eye.x, eye.y, eye.z)
        if (before) insideBefore += 1
        const was = eye.clone()
        canopy.clearOfWood(eye, anchor)
        const moved = was.distanceTo(eye)
        if (moved > 1e-6) {
          pulled += 1
          pullTotal += moved
          pullWorst = Math.max(pullWorst, moved)
          collapse.push(1 - eye.distanceTo(anchor) / was.distanceTo(anchor))
        }
        if (canopy.inWood(eye.x, eye.y, eye.z)) insideAfter += 1
      }
    }
  }
}
console.log()
console.log('=== 5. the third-person camera ===')
console.log(`vantage points swept              ${shots.toLocaleString()}  (${sample.length} stand positions x ${ZOOMS.length} zooms x ${PITCHES.length} pitches x ${YAWS} yaws)`)
console.log(`inside a trunk or canopy, raw     ${insideBefore.toLocaleString()} (${pct(insideBefore, shots)})`)
console.log(`inside after the canopy pull-in   ${insideAfter.toLocaleString()} (${pct(insideAfter, shots)})`)
console.log(`pulled in at all                  ${pulled.toLocaleString()} (${pct(pulled, shots)}), mean ${pulled ? (pullTotal / pulled).toFixed(2) : '0'}m, worst ${pullWorst.toFixed(2)}m`)
collapse.sort((a, b) => a - b)
if (collapse.length) {
  console.log(`  boom shortened by, of those:    median ${(quantile(collapse, 0.5) * 100).toFixed(0)}%, p90 ${(quantile(collapse, 0.9) * 100).toFixed(0)}%, worst ${(quantile(collapse, 1) * 100).toFixed(0)}%`)
  console.log(`  shortened past 70% of the boom: ${collapse.filter(c => c > 0.7).length} (${pct(collapse.filter(c => c > 0.7).length, shots)} of all vantage points)`)
}

/* First person sits at the aim point plus 1.1m, so 2.7m above the ground. */
let firstPerson = 0
for (const [x, z] of standable) if (canopy.inWood(x, 2.7, z)) firstPerson += 1
console.log(`first-person eye (2.7m) inside wood, over ${standable.length.toLocaleString()} stand positions: ${firstPerson}`)

/* ------------------------------ 6. routes ------------------------------- */
console.log()
console.log('=== 6. routes off the plaza ===')
const from = new THREE.Vector3(TOWN_RESPAWN.x, 0, TOWN_RESPAWN.z)
const destinations: Array<[string, number, number]> = [
  ...wildRegions.map(region => [region.id, region.x, region.z] as [string, number, number]),
  ...DUEL_RINGS.map(ring => [ring.id, ring.x, ring.z] as [string, number, number]),
]
for (const [label, x, z] of destinations) {
  const path = nav.findPath(from, new THREE.Vector3(x, 0, z))
  if (!path) {
    console.log(`${label.padEnd(16)} NO ROUTE`)
    continue
  }
  let walked = 0
  let at = from
  for (const point of path) {
    walked += at.distanceTo(point)
    at = point
  }
  const direct = Math.hypot(x - from.x, z - from.z)
  console.log(`${label.padEnd(16)} ${walked.toFixed(1).padStart(6)}m over ${direct.toFixed(1).padStart(6)}m direct  (+${((walked / direct - 1) * 100).toFixed(1)}%)`)
}

/* ---------------------------- 7. resources ------------------------------ */
const geometries = new Set<THREE.BufferGeometry>()
const materials = new Set<THREE.Material>()
const textures = new Set<THREE.Texture>()
root.traverse(object => {
  const mesh = object as THREE.Mesh
  if (mesh.geometry) geometries.add(mesh.geometry)
  const material = mesh.material as THREE.Material | THREE.Material[] | undefined
  if (!material) return
  for (const one of Array.isArray(material) ? material : [material]) {
    materials.add(one)
    for (const value of Object.values(one as unknown as Record<string, unknown>)) {
      if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture)
    }
  }
})
const dispose = root.userData.dispose as (() => void) | undefined
console.log()
console.log('=== 7. resource disposal ===')
if (dispose) dispose()
for (const [label, all] of [['geometries', geometries], ['materials', materials], ['textures', textures]] as const) {
  const freed = [...all].filter(item => disposed.has(item as object)).length
  console.log(`${label.padEnd(12)} created ${String(all.size).padStart(4)}   freed ${String(freed).padStart(4)}   LEAKED ${all.size - freed}`)
}

const failed = violations > 0 || insideAfter > 0 || firstPerson > 0
console.log()
console.log(failed ? 'FAIL: something can stand inside a tree.' : 'ok: nothing the player or camera can reach is inside a tree.')
process.exit(failed ? 1 : 0)
