/*
 * Containment measurement for the hunting regions.
 *
 * The complaint this answers is "the animals sometimes come out of the area".
 * There are two different ways that can be true, and they need two different
 * tests:
 *
 *   1. The animal leaves the SIGNED-DISTANCE FENCE that src/wildlife.ts holds
 *      it inside (`regionDistance > 0`). That is the logic bug.
 *   2. The animal stays inside the fence but leaves the POLYGON that the
 *      player can actually see — the ground patch in wildscape.ts and the
 *      chart in WorldMap.tsx, both cut from `regionOutline`. That looks
 *      identical from the player's chair, and it is a different bug.
 *
 * So this drives the real system — real spawns, real wander/flee/chase, real
 * knockback, pull and separation — and measures both.
 *
 * Usage: npx tsx scripts/verify-containment.ts [ticks]
 */
import * as THREE from 'three'
import {
  ROAM_INSET,
  createWildlife,
  regionDistance,
  regionOutline,
  wildRegions,
} from '../src/wildlife'
import type { WildRegion } from '../src/wildlife'

const TICKS = Number(process.argv[2] ?? 36_000)
const SEEDS = (process.argv[3] ?? '20260927,1,777').split(',').map(Number)
const DT = 1 / 60

/* --- polygon helpers ------------------------------------------------- */

type Poly = Array<[number, number]>

function insidePoly(poly: Poly, x: number, z: number) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Unsigned metres from a point to the polygon boundary. */
function distToPoly(poly: Poly, x: number, z: number) {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]
    const [bx, bz] = poly[i]
    const vx = bx - ax
    const vz = bz - az
    const len = vx * vx + vz * vz
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len))
    best = Math.min(best, Math.hypot(x - (ax + vx * t), z - (az + vz * t)))
  }
  return best
}

/* --- test A: does the drawn outline enclose the fence? --------------- */
/*
 * regionOutline() bisects along rays from the region heart, which only finds
 * the true edge if the shape is star-shaped about that heart. If it is not,
 * the drawn polygon cuts a bulge off the fence and an animal standing legally
 * inside the fence appears to be standing off the green.
 */
function outlineVsFence(region: WildRegion) {
  const poly = regionOutline(region, 48)
  const far = region.reach + 10
  let fenceCells = 0
  let outsidePoly = 0
  let worst = 0
  let worstAt: [number, number] = [0, 0]
  for (let x = region.x - far; x <= region.x + far; x += 0.5) {
    for (let z = region.z - far; z <= region.z + far; z += 0.5) {
      // Everywhere an animal is legally allowed to stand.
      if (regionDistance(region, x, z) > -ROAM_INSET) continue
      fenceCells += 1
      if (insidePoly(poly, x, z)) continue
      outsidePoly += 1
      const d = distToPoly(poly, x, z)
      if (d > worst) { worst = d; worstAt = [x, z] }
    }
  }
  return { fenceCells, outsidePoly, worst, worstAt }
}

/* --- test B: drive the real simulation ------------------------------ */

function simulate(seed: number) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 600)
  let kills = 0
  const wildlife = createWildlife(scene, {
    onKill: () => { kills += 1 },
    onPlayerDamage: () => {},
    seed,
  })

  const polys = new Map<string, Poly>()
  const groundPolys = new Map<string, Poly>()
  for (const region of wildRegions) {
    polys.set(region.id, regionOutline(region, 48))
    groundPolys.set(region.id, regionOutline(region, 56))
  }

  const worst = new Map<string, { fence: number; poly: number; ground: number; fenceAt: [number, number]; polyAt: [number, number] }>()
  for (const region of wildRegions) {
    worst.set(region.id, { fence: -Infinity, poly: 0, ground: 0, fenceAt: [0, 0], polyAt: [0, 0] })
  }
  let fenceEscapes = 0
  let polyEscapes = 0
  let groundEscapes = 0
  let samples = 0

  const playerPos = new THREE.Vector3()
  const order = wildRegions.slice()
  let now = 0

  for (let tick = 0; tick < TICKS; tick++) {
    now += DT * 1000

    /* Walk the player on a slow circuit through each region in turn, so every
     * animal in the world gets provoked into fleeing and chasing rather than
     * only grazing. One region gets visited per (TICKS / regions) window. */
    const window = TICKS / order.length
    const region = order[Math.min(order.length - 1, Math.floor(tick / window))]
    const phase = ((tick % window) / window) * Math.PI * 2
    const sweep = region.reach * 0.75
    playerPos.set(
      region.x + Math.cos(phase * 3) * sweep,
      0,
      region.z + Math.sin(phase * 2) * sweep,
    )

    wildlife.update(DT, now, playerPos, camera, true)

    /* Stress the paths that used to bypass the fence: a hit with knockback
     * aimed outward from the region heart, and the pull ability. */
    if (tick % 90 === 0) {
      for (const animal of wildlife.animals) {
        if (animal.state === 'dead') continue
        const out = new THREE.Vector3(
          animal.group.position.x - animal.region.x,
          0,
          animal.group.position.z - animal.region.z,
        )
        if (out.lengthSq() < 1e-6) out.set(1, 0, 0)
        wildlife.hurt(animal, 1, now, { knockback: 26, from: new THREE.Vector3(animal.region.x, 0, animal.region.z), aggro: true })
        wildlife.knockBack(animal, out, 26)
      }
    }
    if (tick % 137 === 0) {
      // Pull toward a point well outside the region, which is the worst case.
      wildlife.pull(new THREE.Vector3(region.x + region.reach * 2.5, 0, region.z), 400, 3)
    }

    for (const animal of wildlife.animals) {
      if (animal.state === 'dead') continue
      samples += 1
      const { x, z } = animal.group.position
      const w = worst.get(animal.region.id)!
      const fence = regionDistance(animal.region, x, z)
      if (fence > w.fence) { w.fence = fence; w.fenceAt = [x, z] }
      if (fence > 0) fenceEscapes += 1
      const poly = polys.get(animal.region.id)!
      if (!insidePoly(poly, x, z)) {
        polyEscapes += 1
        const d = distToPoly(poly, x, z)
        if (d > w.poly) { w.poly = d; w.polyAt = [x, z] }
      }
      const ground = groundPolys.get(animal.region.id)!
      if (!insidePoly(ground, x, z)) {
        groundEscapes += 1
        const d = distToPoly(ground, x, z)
        if (d > w.ground) w.ground = d
      }
    }
  }

  const tracked = wildlife.animals.length
  // Proof the seed actually moved the world, so identical escape counts across
  // seeds cannot be mistaken for the seed being ignored.
  const checksum = wildlife.animals
    .reduce((sum, a) => sum + a.group.position.x * 31.7 + a.group.position.z * 7.3, 0)
    .toFixed(3)
  wildlife.dispose()
  return { tracked, kills, samples, fenceEscapes, polyEscapes, groundEscapes, worst, checksum }
}

/* --- report --------------------------------------------------------- */

console.log('=== A. does the drawn outline enclose the fence? ===')
console.log('region            fenceCells  cellsOutsidePolygon  worstMetresOutside')
let anyGap = false
for (const region of wildRegions) {
  const r = outlineVsFence(region)
  if (r.outsidePoly > 0) anyGap = true
  console.log(
    `${region.id.padEnd(16)} ${String(r.fenceCells).padStart(10)} ${String(r.outsidePoly).padStart(20)} ${r.worst.toFixed(2).padStart(18)}` +
      (r.outsidePoly ? `  at ${r.worstAt[0].toFixed(1)},${r.worstAt[1].toFixed(1)}` : ''),
  )
}
console.log(anyGap ? 'RESULT: outline does NOT cover the whole fence.' : 'RESULT: outline covers the whole fence.')

let clean = !anyGap
for (const seed of SEEDS) {
  console.log()
  console.log(`=== B. live simulation, seed ${seed}, ${TICKS} ticks (${(TICKS * DT).toFixed(0)}s of world time) ===`)
  const sim = simulate(seed)
  console.log(`animals tracked        ${sim.tracked}  (position checksum ${sim.checksum})`)
  console.log(`animal-ticks sampled   ${sim.samples}`)
  console.log(`kills (stress damage)  ${sim.kills}`)
  console.log(`fence escapes          ${sim.fenceEscapes}`)
  console.log(`map-polygon escapes    ${sim.polyEscapes}`)
  console.log(`ground-patch escapes   ${sim.groundEscapes}`)
  console.log('region            worstFenceSignedDist  worstMetresOutsideMapPoly  worstOutsideGroundPatch')
  for (const region of wildRegions) {
    const w = sim.worst.get(region.id)!
    console.log(
      `${region.id.padEnd(16)} ${(w.fence === -Infinity ? NaN : w.fence).toFixed(6).padStart(20)} ${w.poly.toFixed(3).padStart(26)} ${w.ground.toFixed(3).padStart(23)}`,
    )
  }
  if (sim.fenceEscapes || sim.polyEscapes || sim.groundEscapes) clean = false
}
console.log()
console.log(clean ? 'CONTAINMENT: clean.' : 'CONTAINMENT: FAILED — see numbers above.')
