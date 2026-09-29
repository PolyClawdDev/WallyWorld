/*
 * Can you SEE in this wood, and does it still look like a wood?
 *
 * `verify-canopy.ts` answers "can the player and the camera stand up in it",
 * which is a question about the volume a body occupies. This file answers the
 * question the owner actually asked, which is about the volume a body LOOKS
 * through:
 *
 *   1. HORIZONTAL VISIBILITY — from many legal standing positions inside each
 *      hunting region, rays at the first-person eye height in many compass
 *      directions. What fraction reach 25m without meeting wood or leaf? This
 *      is the number that decides whether a hunt is playable. Foliage starting
 *      1.5m over the player's eye is a wall at every range that matters.
 *   2. ANIMAL SIGHTING — the same positions, but the ray runs from the eye down
 *      to an animal-sized body at 0.9m, which is the sightline a player takes
 *      when looking for something to kill. Reported as how far that target can
 *      be and still be seen.
 *   3. CANOPY CLOSURE — from inside each region, rays straight up and in two
 *      cones around the vertical. The fraction occluded is what makes a wood
 *      read as a wood from underneath, and raising the canopy must not spend it.
 *   4. TRUNK SEPARATION — nearest trunk to every trunk, in metres. The clumping
 *      complaint in its simplest form: two boles you cannot walk between.
 *   5. CAMERA HEADROOM — what fraction of third-person vantage points sit in
 *      wood at all, banded by how high the lens is. Under a high canopy the low
 *      bands should be empty, which is a different fix for the camera's problem
 *      than tuning the pull-in.
 *
 * Usage: npx tsx scripts/verify-sightlines.ts
 */
import * as THREE from 'three'

const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D
;(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
}

const { createWildscape } = await import('../src/wildscape')
const { createNavGrid } = await import('../src/battle/nav')
const { wildRegions, insideRegion } = await import('../src/wildlife')
const { inFoliage } = await import('../src/treeArt')

type Crown = { id: string; scale: number; squash: number; x: number; z: number; crownRadius: number; reach: number; base: number; top: number }
type Canopy = {
  corridor: number
  crowns: Crown[]
  inWood: (x: number, y: number, z: number) => boolean
  clearOfWood: (eye: THREE.Vector3, anchor: THREE.Vector3) => THREE.Vector3
}

const root = createWildscape()
const canopy = root.userData.canopy as Canopy
const stats = root.userData.stats as {
  trees: { meshes: number; trees: number; triangles: number }
  obstacles: number
  corridor: number
}
const nav = createNavGrid(root.userData.obstacles as never[])

/** Deterministic, so two runs of this file are comparable to the metre. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(1337)

const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN
  const list = sorted(values)
  return list[Math.min(list.length - 1, Math.floor(q * list.length))]
}
const pct = (value: number) => `${(value * 100).toFixed(0)}%`

/* The first-person eye: the camera sits at the aim point plus 1.1m, see
 * src/main.tsx. This is the height the complaint is about. */
const EYE = 2.7
/** A reindeer's flank, roughly: the point a player has to see to shoot it. */
const TARGET = 0.9
const REACH = 25
const STEP = 0.25
const DIRECTIONS = 36

/** Legal standing positions, rejection-sampled inside one region. */
function standsIn(region: (typeof wildRegions)[number], count: number) {
  const out: Array<[number, number]> = []
  let tries = 0
  while (out.length < count && tries < count * 400) {
    tries += 1
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * region.reach
    const x = region.x + Math.cos(angle) * radius
    const z = region.z + Math.sin(angle) * radius
    if (!insideRegion(region, x, z, 1.5)) continue
    if (nav.blocked(x, z)) continue
    out.push([x, z])
  }
  return out
}

/** Is every point on the segment clear of wood? Sampled, not analytic. */
function clear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, step = STEP) {
  const span = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
  const steps = Math.max(1, Math.ceil(span / step))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    if (canopy.inWood(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t)) return false
  }
  return true
}

/** How far a horizontal eye-height ray gets before it meets wood, capped at REACH. */
function reachOf(x: number, z: number, dx: number, dz: number) {
  const steps = Math.ceil(REACH / STEP)
  for (let i = 1; i <= steps; i++) {
    const d = i * STEP
    if (canopy.inWood(x + dx * d, EYE, z + dz * d)) return d - STEP
  }
  return REACH
}

/* ------------------- 1 & 2. visibility and sighting ------------------- */
console.log(`=== canopy corridor ${stats.corridor}m, ${stats.trees.trees} trees, ${stats.trees.meshes} draw calls ===`)
console.log()
console.log('=== 1. horizontal visibility at eye height (2.7m): rays reaching 25m ===')
console.log('region          stands  median  p10   worstPos  meanSightM')

const STANDS = 48
const SIGHT_DIRECTIONS = 12
const perRegion: Array<{ id: string; median: number; worst: number; sight: number; kind: string }> = []
const animalRows: Array<{ id: string; kind: string; median: number; p10: number; worst: number; at20: number }> = []
/** Ranges beyond this are not a hunt, they are a skybox; the scan stops here. */
const SIGHT_CAP = 60

for (const region of wildRegions) {
  const stands = standsIn(region, STANDS)
  const fractions: number[] = []
  const distances: number[] = []
  for (const [x, z] of stands) {
    let open = 0
    for (let i = 0; i < DIRECTIONS; i++) {
      const angle = (i / DIRECTIONS) * Math.PI * 2
      const got = reachOf(x, z, Math.sin(angle), Math.cos(angle))
      distances.push(got)
      if (got >= REACH) open += 1
    }
    fractions.push(open / DIRECTIONS)
  }
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length
  perRegion.push({
    id: region.id,
    kind: region.kind,
    median: quantile(fractions, 0.5),
    worst: quantile(fractions, 0),
    sight: mean,
  })
  console.log(
    `${region.id.padEnd(14)} ${String(stands.length).padStart(6)} ${pct(quantile(fractions, 0.5)).padStart(7)} ` +
    `${pct(quantile(fractions, 0.1)).padStart(5)} ${pct(quantile(fractions, 0)).padStart(9)} ${mean.toFixed(1).padStart(11)}`,
  )

  /* 2. An animal-sized target: the ray declines from the eye to 0.9m, so brush
   * near the target blocks it even when the eye-height ray is clear. Scanned
   * outward a metre at a time and stopped at the first range that is blocked. */
  const perDirection: number[] = []
  let clearAt25 = 0
  let directions = 0
  for (const [x, z] of stands) {
    for (let i = 0; i < SIGHT_DIRECTIONS; i++) {
      const angle = ((i + rng() * 0.5) / SIGHT_DIRECTIONS) * Math.PI * 2
      const dx = Math.sin(angle)
      const dz = Math.cos(angle)
      let got = 0
      for (let d = 4; d <= SIGHT_CAP; d += 1) {
        if (!clear(x, EYE, z, x + dx * d, TARGET, z + dz * d, 0.4)) break
        got = d
      }
      perDirection.push(got)
      directions += 1
      if (got >= 25) clearAt25 += 1
    }
  }
  animalRows.push({
    id: region.id,
    kind: region.kind,
    median: quantile(perDirection, 0.5),
    p10: quantile(perDirection, 0.1),
    worst: quantile(perDirection, 0),
    at20: clearAt25 / directions,
  })
}

const medians = perRegion.map(entry => entry.median)
const worstRegion = perRegion.reduce((worst, entry) => (entry.median < worst.median ? entry : worst))
console.log()
console.log(`median over regions            ${pct(quantile(medians, 0.5))}`)
console.log(`worst region                   ${worstRegion.id} (${worstRegion.kind}) at ${pct(worstRegion.median)}, mean sightline ${worstRegion.sight.toFixed(1)}m`)

console.log()
console.log('=== 2. how far an animal-sized target (0.9m) can be and still be seen ===')
console.log('region          medianDir  p10Dir  worstDir  dirs clear at 25m')
for (const row of animalRows) {
  console.log(
    `${row.id.padEnd(14)} ${`${row.median}m`.padStart(9)} ${`${row.p10}m`.padStart(7)} ` +
    `${`${row.worst}m`.padStart(9)} ${pct(row.at20).padStart(18)}`,
  )
}

/* ------------------------ 3. canopy closure -------------------------- */
/*
 * Looking up. A ray straight up from the eye, plus rings at 15 and 30 degrees
 * off the vertical, out to 45m. Occluded means the sky is hidden by leaf or
 * bole, which is what "it still looks like woods" means from underneath.
 */
console.log()
console.log('=== 3. canopy closure: sky occluded looking up from a standing eye ===')
console.log('region          straightUp  cone15  cone30')
const TILTS = [0, 15, 30]
const closureRows: Array<{ id: string; kind: string; up: number; cone: number }> = []
for (const region of wildRegions) {
  const stands = standsIn(region, 40)
  const hits = [0, 0, 0]
  const shots = [0, 0, 0]
  for (const [x, z] of stands) {
    for (let band = 0; band < TILTS.length; band++) {
      const tilt = (TILTS[band] * Math.PI) / 180
      const spokes = band === 0 ? 1 : 8
      for (let s = 0; s < spokes; s++) {
        const yaw = (s / spokes) * Math.PI * 2
        const dx = Math.sin(tilt) * Math.sin(yaw)
        const dz = Math.sin(tilt) * Math.cos(yaw)
        const dy = Math.cos(tilt)
        shots[band] += 1
        for (let d = 0.5; d <= 45; d += 0.35) {
          if (!canopy.inWood(x + dx * d, EYE + dy * d, z + dz * d)) continue
          hits[band] += 1
          break
        }
      }
    }
  }
  closureRows.push({
    id: region.id,
    kind: region.kind,
    up: hits[0] / shots[0],
    cone: (hits[1] + hits[2]) / (shots[1] + shots[2]),
  })
  console.log(
    `${region.id.padEnd(14)} ${pct(hits[0] / shots[0]).padStart(10)} ${pct(hits[1] / shots[1]).padStart(7)} ${pct(hits[2] / shots[2]).padStart(7)}`,
  )
}
const wooded = closureRows.filter(row => row.kind === 'wildwood' || row.kind === 'woods' || row.kind === 'brasswood')
console.log(`wooded regions, mean closure straight up: ${pct(wooded.reduce((sum, row) => sum + row.up, 0) / wooded.length)}`)

/* ----------------------- 4. trunk separation ------------------------- */
console.log()
console.log('=== 4. trunk to trunk, metres ===')
const gaps: number[] = []
for (let i = 0; i < canopy.crowns.length; i++) {
  let closest = Infinity
  for (let j = 0; j < canopy.crowns.length; j++) {
    if (i === j) continue
    const a = canopy.crowns[i]
    const b = canopy.crowns[j]
    closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z))
  }
  if (Number.isFinite(closest)) gaps.push(closest)
}
console.log(`nearest trunk: min ${quantile(gaps, 0).toFixed(2)}m  p5 ${quantile(gaps, 0.05).toFixed(2)}m  median ${quantile(gaps, 0.5).toFixed(2)}m  p90 ${quantile(gaps, 0.9).toFixed(2)}m`)
console.log(`trunk pairs closer than 4m: ${gaps.filter(g => g < 4).length}`)

/* ----------------------- 5. camera headroom -------------------------- */
/*
 * The rig from src/main.tsx, but asking a narrower question than
 * verify-canopy: how many vantage points are in wood, split by how high the
 * lens sits. A high canopy should empty the low bands entirely.
 */
console.log()
console.log('=== 5. third-person vantage points inside wood, by lens height ===')
const ZOOMS = [3.2, 7, 13, 22, 32]
const PITCHES = [-0.34, 0, 0.4, 0.85]
const bands = [
  { label: 'under 4m', low: 0, high: 4, hits: 0, leaf: 0, shots: 0 },
  { label: '4 to 8m', low: 4, high: 8, hits: 0, leaf: 0, shots: 0 },
  { label: '8 to 14m', low: 8, high: 14, hits: 0, leaf: 0, shots: 0 },
  { label: 'over 14m', low: 14, high: Infinity, hits: 0, leaf: 0, shots: 0 },
]
/*
 * FOLIAGE ONLY, separately from wood of any kind. The two are different problems
 * for the camera: a lens inside leaf renders a wall of green and has to be
 * pulled in, while a lens behind a bole is a thin occluder the rig could just as
 * well ignore or step round. Raising the canopy is a fix for the first and not
 * for the second, and the report should not blur them.
 */
const inLeaf = (x: number, y: number, z: number) => {
  for (const crown of canopy.crowns) {
    if (y < crown.base || y > crown.top) continue
    const distance = Math.hypot(x - crown.x, z - crown.z) / crown.squash
    if (distance > crown.reach) continue
    if (inFoliage(crown.id as never, crown.scale, distance, y)) return true
  }
  return false
}
const cameraStands: Array<[number, number]> = []
for (const region of wildRegions) cameraStands.push(...standsIn(region, 60))
for (const [x, z] of cameraStands) {
  for (const zoom of ZOOMS) {
    const height = 0.6 + zoom * 0.43
    const baseElevation = Math.atan2(height, zoom)
    const boom = Math.hypot(zoom, height)
    for (const pitch of PITCHES) {
      const elevation = baseElevation + pitch
      const flat = Math.cos(elevation) * boom
      for (let y = 0; y < 8; y++) {
        const yaw = (y / 8) * Math.PI * 2
        const ex = x + Math.sin(yaw) * flat
        const ey = Math.max(1.6 + Math.sin(elevation) * boom, 1.4)
        const ez = z + Math.cos(yaw) * flat
        const band = bands.find(one => ey >= one.low && ey < one.high)!
        band.shots += 1
        if (canopy.inWood(ex, ey, ez)) band.hits += 1
        if (inLeaf(ex, ey, ez)) band.leaf += 1
      }
    }
  }
}
for (const band of bands) {
  console.log(
    `${band.label.padEnd(10)} ${String(band.shots).padStart(7)} vantage points, in wood ${String(band.hits).padStart(6)} ` +
    `(${pct(band.hits / band.shots)}), in FOLIAGE ${String(band.leaf).padStart(6)} (${pct(band.leaf / band.shots)})`,
  )
}
const lowBands = bands.filter(band => band.high <= 8)
const lowShots = lowBands.reduce((s, b) => s + b.shots, 0)
console.log(`orbit below 8m: inside wood ${pct(lowBands.reduce((s, b) => s + b.hits, 0) / lowShots)}, inside foliage ${pct(lowBands.reduce((s, b) => s + b.leaf, 0) / lowShots)}`)
console.log(`all vantage points: inside foliage ${pct(bands.reduce((s, b) => s + b.leaf, 0) / bands.reduce((s, b) => s + b.shots, 0))}`)

/* --------------------------- the standing check ---------------------- */
/*
 * Thresholds, not observations. A future edit that closes the sightlines again
 * fails here rather than being noticed in a screenshot six weeks later.
 */
const VISIBILITY_FLOOR = 0.55
const CLOSURE_FLOOR = 0.6
const SEPARATION_FLOOR = 4
const SIGHT_FLOOR = 20

const failures: string[] = []
for (const entry of perRegion) {
  if (entry.median < VISIBILITY_FLOOR) failures.push(`${entry.id}: only ${pct(entry.median)} of eye-height rays reach 25m (floor ${pct(VISIBILITY_FLOOR)})`)
}
for (const row of animalRows) {
  if (row.median < SIGHT_FLOOR) failures.push(`${row.id}: the median direction shows an animal only ${row.median}m off (floor ${SIGHT_FLOOR}m)`)
}
const closure = wooded.reduce((sum, row) => sum + row.up, 0) / wooded.length
if (closure < CLOSURE_FLOOR) failures.push(`wooded canopy closure ${pct(closure)} is below ${pct(CLOSURE_FLOOR)} — the woods have gone thin`)
if (quantile(gaps, 0) < SEPARATION_FLOOR) failures.push(`two trunks stand ${quantile(gaps, 0).toFixed(2)}m apart (floor ${SEPARATION_FLOOR}m)`)

console.log()
if (failures.length) {
  for (const line of failures) console.log(`FAIL ${line}`)
  process.exit(1)
}
console.log('ok: you can see at standing height, the canopy still closes overhead, and no two trunks are jammed together.')
