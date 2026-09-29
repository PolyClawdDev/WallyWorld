/*
 * Is the third-person camera out of the leaves, and is it still a camera?
 *
 * `scripts/verify-canopy.ts` answers the first half: nothing a player can reach
 * is inside a tree. It also measured the cost of the old one-axis pull-in — the
 * boom collapsing onto the wayfinder's back — and this script is the standing
 * check for the fix. It fails the build if any of these stop being true:
 *
 *   A. no solved vantage point has its lens inside wood, and none is below the
 *      1.4m street floor;
 *   B. no boom is shortened below the arm's own floor (6.5m, or the request if
 *      the request was already shorter);
 *   C. the titan-pine case — minimum zoom, orbit yawed into the trunk — never
 *      produces a boom near the wayfinder's own head;
 *   D. the last-resort climb straight over the crowns never fires;
 *   E. walking a wood edge does not pop the lens: the damped rig's vertical
 *      speed and its number of direction changes stay under a budget, and both
 *      are compared against the same walk with the damper switched off.
 *
 * Usage: npx tsx scripts/verify-springarm.ts
 */
import * as THREE from 'three'

const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D
;(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
}

const { createWildscape } = await import('../src/wildscape')
const { createNavGrid } = await import('../src/battle/nav')
const { wildRegions, insideRegion } = await import('../src/wildlife')
const { WORLD_HALF } = await import('../src/shared/zones')

type Crown = { id: string; x: number; z: number; scale: number; top: number; crownRadius: number }
type Arm = { yaw: number; elevation: number; boom: number; mode: string; cost: number }
type Canopy = {
  corridor: number
  boomFloor: number
  crowns: Crown[]
  inWood: (x: number, y: number, z: number) => boolean
  canopyTopAt: (x: number, z: number) => number
  clearOfWood: (eye: THREE.Vector3, anchor: THREE.Vector3) => THREE.Vector3
  springArm: (eye: THREE.Vector3, anchor: THREE.Vector3, dt: number) => THREE.Vector3
  settle: (eye: THREE.Vector3, goal: THREE.Vector3, anchor: THREE.Vector3) => THREE.Vector3
  solveArm: (
    ax: number, ay: number, az: number,
    yaw: number, elevation: number, boom: number,
    prev?: { lift: number; slide: number; keep: number },
  ) => Arm
  resetArm: () => void
  armCounters: { calls: number; candidates: number; over: number }
}

const root = createWildscape()
const canopy = root.userData.canopy as Canopy
const nav = createNavGrid(root.userData.obstacles as never[])

const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(2)}%`
const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0
const failures: string[] = []

/* The rig from src/main.tsx, so nothing here is a model of the camera: it is
 * the camera's own arithmetic. zoom picks a height, pitch offsets the elevation
 * that framing implies, and the lens never drops below 1.4m. */
const EYE_FLOOR = 1.4
const rig = (zoom: number, pitch: number) => {
  const height = 0.6 + zoom * 0.43
  const baseElevation = Math.atan2(height, zoom)
  const boom = Math.hypot(zoom, height)
  return { elevation: baseElevation + pitch, boom }
}
const place = (out: THREE.Vector3, anchor: THREE.Vector3, yaw: number, elevation: number, boom: number) => {
  const flat = Math.cos(elevation) * boom
  return out.set(
    anchor.x + Math.sin(yaw) * flat,
    anchor.y + Math.sin(elevation) * boom,
    anchor.z + Math.cos(yaw) * flat,
  )
}

/* ------------------------- 1. the whole sweep ---------------------------- */
/*
 * Every zoom, pitch and yaw of the orbit over a thinned lattice of standable
 * ground — the same sample verify-canopy.ts uses, so the two scripts' numbers
 * are comparable. Stateless: this is what the arm settles on, with the damper
 * and its memory taken out of the question.
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
const sample = standable.filter((_, index) => index % 7 === 0)
const inWood = wildRegions.find(region => region.id === 'wildwood')!

const anchor = new THREE.Vector3()
const eye = new THREE.Vector3()
const modes = new Map<string, number>()
let shots = 0
let blockedRaw = 0
let insideAfter = 0
let belowFloor = 0
let floorBroken = 0
const loss: number[] = []
const rise: number[] = []
const oldLoss: number[] = []
let oldPulled = 0
let oldWorstBoom = Infinity
let newWorstBoom = Infinity
let occBefore = 0
let occAfter = 0

/* Sampled every 1.2m, the same way the arm prices it, so the numbers here and
 * the numbers the arm acts on are the same numbers. */
const occlusionOf = (from: THREE.Vector3, to: THREE.Vector3) => {
  const span = from.distanceTo(to)
  const samples = Math.max(6, Math.min(28, Math.round(span / 1.2)))
  let hits = 0
  for (let i = 1; i <= samples; i++) {
    const t = i / (samples + 1)
    if (canopy.inWood(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t)) hits += 1
  }
  return hits / samples
}

canopy.resetArm()
const sweepStart = performance.now()
for (const [x, z] of sample) {
  anchor.set(x, 1.6, z)
  for (const zoom of ZOOMS) {
    for (const pitch of PITCHES) {
      const { elevation, boom } = rig(zoom, pitch)
      for (let y = 0; y < YAWS; y++) {
        const yaw = (y / YAWS) * Math.PI * 2
        place(eye, anchor, yaw, elevation, boom)
        eye.y = Math.max(eye.y, EYE_FLOOR)
        shots += 1
        const requested = eye.clone()
        const wasBlocked = canopy.inWood(eye.x, eye.y, eye.z)
        if (wasBlocked) blockedRaw += 1

        /* The old behaviour, for the comparison: slide down the boom only. */
        const old = requested.clone()
        canopy.clearOfWood(old, anchor)
        if (old.distanceTo(requested) > 1e-6) {
          oldPulled += 1
          oldLoss.push(1 - old.distanceTo(anchor) / requested.distanceTo(anchor))
        }
        oldWorstBoom = Math.min(oldWorstBoom, old.distanceTo(anchor))

        const arm = canopy.solveArm(anchor.x, anchor.y, anchor.z, yaw, elevation, boom)
        modes.set(arm.mode, (modes.get(arm.mode) ?? 0) + 1)
        place(eye, anchor, arm.yaw, arm.elevation, arm.boom)
        if (canopy.inWood(eye.x, eye.y, eye.z)) insideAfter += 1
        if (eye.y < EYE_FLOOR - 1e-6) belowFloor += 1
        const solvedBoom = eye.distanceTo(anchor)
        newWorstBoom = Math.min(newWorstBoom, solvedBoom)
        if (solvedBoom < Math.min(boom, canopy.boomFloor) - 1e-6) floorBroken += 1
        if (solvedBoom < boom - 1e-6) loss.push(1 - solvedBoom / boom)
        if (eye.y > requested.y + 1e-6) rise.push(eye.y - requested.y)
        if (wasBlocked) {
          occBefore += occlusionOf(requested, anchor)
          occAfter += occlusionOf(eye, anchor)
        }
      }
    }
  }
}
const sweepMs = performance.now() - sweepStart

loss.sort((a, b) => a - b)
oldLoss.sort((a, b) => a - b)
rise.sort((a, b) => a - b)

console.log('=== 1. the orbit swept over standable ground ===')
console.log(`vantage points                    ${shots.toLocaleString()}  (${sample.length} positions x ${ZOOMS.length} zooms x ${PITCHES.length} pitches x ${YAWS} yaws)`)
console.log(`lens inside wood as requested     ${blockedRaw.toLocaleString()} (${pct(blockedRaw, shots)})`)
console.log(`lens inside wood after the arm    ${insideAfter} (${pct(insideAfter, shots)})`)
console.log(`lens below the ${EYE_FLOOR}m street floor  ${belowFloor}`)
console.log()
console.log('resolution                        share')
for (const mode of ['clear', 'lift', 'duck', 'slide', 'short', 'over']) {
  const count = modes.get(mode) ?? 0
  console.log(`  ${mode.padEnd(30)} ${String(count).padStart(7)} (${pct(count, shots)})`)
}
console.log()
console.log('boom length, spring arm vs the old one-axis pull-in')
console.log(`  lost any length at all          arm ${loss.length} (${pct(loss.length, shots)})   old ${oldPulled} (${pct(oldPulled, shots)})`)
console.log(`  of those, median loss           arm ${(quantile(loss, 0.5) * 100).toFixed(0)}%   old ${(quantile(oldLoss, 0.5) * 100).toFixed(0)}%`)
console.log(`  of those, p90 loss              arm ${(quantile(loss, 0.9) * 100).toFixed(0)}%   old ${(quantile(oldLoss, 0.9) * 100).toFixed(0)}%`)
console.log(`  of those, worst loss            arm ${(quantile(loss, 1) * 100).toFixed(0)}%   old ${(quantile(oldLoss, 1) * 100).toFixed(0)}%`)
console.log(`  shortest boom anywhere          arm ${newWorstBoom.toFixed(2)}m   old ${oldWorstBoom.toFixed(2)}m`)
console.log(`  booms shortened below the floor ${floorBroken}`)
console.log()
console.log(`lens lifted above the requested height: ${rise.length} (${pct(rise.length, shots)}), median +${quantile(rise, 0.5).toFixed(1)}m, p90 +${quantile(rise, 0.9).toFixed(1)}m, worst +${quantile(rise, 1).toFixed(1)}m`)
if (blockedRaw) {
  console.log(`wood between lens and wayfinder, over the ${blockedRaw.toLocaleString()} blocked requests: ${(occBefore / blockedRaw * 100).toFixed(1)}% of the boom as requested, ${(occAfter / blockedRaw * 100).toFixed(1)}% where the arm put it`)
}
console.log(`search cost: ${(canopy.armCounters.candidates / canopy.armCounters.calls).toFixed(2)} candidate poses per solve, ${(sweepMs / shots * 1000).toFixed(1)}us per solve`)
console.log(`last-resort climbs over the crowns: ${canopy.armCounters.over}`)

if (insideAfter > 0) failures.push(`${insideAfter} solved vantage points have the lens inside wood`)
if (belowFloor > 0) failures.push(`${belowFloor} solved vantage points are below the ${EYE_FLOOR}m floor`)
if (floorBroken > 0) failures.push(`${floorBroken} booms were shortened below the ${canopy.boomFloor}m floor`)
if (canopy.armCounters.over > 0) failures.push(`${canopy.armCounters.over} vantage points needed the last-resort climb over the crowns`)

/* ---------------------- 2. the titan pine, close up ---------------------- */
/*
 * The case that produced 2.1m of boom: stand as close to the biggest trunk in
 * the world as the navigation grid allows, at minimum zoom, and orbit into it.
 * A boom near the wayfinder's own head (1.9m, and 2.7m at the first-person eye)
 * is a failure however clear of leaves it is.
 */
const HEAD = 2.7
const titans = canopy.crowns.filter(crown => crown.id === 'titanpine')
titans.sort((a, b) => b.scale - a.scale)
console.log()
console.log('=== 2. standing at a titan pine, minimum zoom, orbit into the trunk ===')
let titanWorst = Infinity
let titanWorstAt = ''
for (const titan of titans.slice(0, 12)) {
  for (let step = 0; step < 24; step++) {
    const bearing = (step / 24) * Math.PI * 2
    // The closest standable metre to this trunk on this bearing.
    let stood: [number, number] | null = null
    for (let radius = 1; radius <= 12; radius += 0.25) {
      const px = titan.x + Math.cos(bearing) * radius
      const pz = titan.z + Math.sin(bearing) * radius
      if (Math.abs(px) > WORLD_HALF - 2 || Math.abs(pz) > WORLD_HALF - 2) break
      if (!nav.blocked(px, pz)) { stood = [px, pz]; break }
    }
    if (!stood) continue
    anchor.set(stood[0], 1.6, stood[1])
    for (const zoom of [3.2, 5]) {
      for (const pitch of PITCHES) {
        const { elevation, boom } = rig(zoom, pitch)
        for (let y = 0; y < 16; y++) {
          const yaw = (y / 16) * Math.PI * 2
          const arm = canopy.solveArm(anchor.x, anchor.y, anchor.z, yaw, elevation, boom)
          place(eye, anchor, arm.yaw, arm.elevation, arm.boom)
          const got = eye.distanceTo(anchor)
          if (got < titanWorst) {
            titanWorst = got
            titanWorstAt = `zoom ${zoom}, pitch ${pitch}, ${anchor.x.toFixed(1)},${anchor.z.toFixed(1)} beside the trunk at ${titan.x.toFixed(1)},${titan.z.toFixed(1)}`
          }
        }
      }
    }
  }
}
console.log(`trunks probed                     ${Math.min(12, titans.length)} of the ${titans.length} titan pines, 24 bearings each`)
console.log(`shortest boom                     ${titanWorst.toFixed(2)}m   (was 2.10m)`)
console.log(`  at                              ${titanWorstAt}`)
console.log(`the wayfinder's first-person eye  ${HEAD.toFixed(2)}m`)
if (titanWorst < HEAD) failures.push(`the titan-pine boom collapses to ${titanWorst.toFixed(2)}m, inside the wayfinder's own head`)

/* --------------------- 3. max zoom, deep in the wood --------------------- */
/*
 * The other headline number: 11.1m of boom at maximum zoom inside the wildwood
 * where open ground gives 35.8m.
 */
const deep = sample.filter(([x, z]) => insideRegion(inWood, x, z, 0))
const open = sample.filter(([x, z]) => !wildRegions.some(region => insideRegion(region, x, z, 0)))
const maxZoom = rig(32, 0.85)
const boomsIn = (spots: Array<[number, number]>) => {
  const out: number[] = []
  for (const [x, z] of spots) {
    anchor.set(x, 1.6, z)
    for (let y = 0; y < YAWS; y++) {
      const yaw = (y / YAWS) * Math.PI * 2
      const arm = canopy.solveArm(anchor.x, anchor.y, anchor.z, yaw, maxZoom.elevation, maxZoom.boom)
      place(eye, anchor, arm.yaw, arm.elevation, arm.boom)
      out.push(eye.distanceTo(anchor))
    }
  }
  return out.sort((a, b) => a - b)
}
const deepBooms = boomsIn(deep)
const openBooms = boomsIn(open)
console.log()
console.log(`=== 3. maximum zoom (requested boom ${maxZoom.boom.toFixed(1)}m), full pitch up ===`)
console.log(`inside the wildwood (${deep.length} positions):  min ${quantile(deepBooms, 0).toFixed(1)}m, median ${quantile(deepBooms, 0.5).toFixed(1)}m, mean ${(deepBooms.reduce((a, b) => a + b, 0) / deepBooms.length).toFixed(1)}m`)
console.log(`open country (${open.length} positions):        min ${quantile(openBooms, 0).toFixed(1)}m, median ${quantile(openBooms, 0.5).toFixed(1)}m, mean ${(openBooms.reduce((a, b) => a + b, 0) / openBooms.length).toFixed(1)}m`)

/* -------------------------- 4. walking an edge --------------------------- */
/*
 * The playability question. A lens that pops over the treetops every few steps
 * is worse than a short boom, so this walks the real rig at 60fps across the
 * wildwood's edge and back, with the damper in and with it out, and measures:
 *
 *   - peak and mean vertical speed of the lens, in metres a second;
 *   - REVERSALS: how many times the lens changes vertical direction by more
 *     than 0.4m/s, which is what reads on screen as a bob or a pop.
 *
 * The undamped run is the same walk with the solved pose applied whole every
 * frame. If the damper does nothing, the two columns match.
 */
const WALK = 3.2
const DT = 1 / 60
const walkAcross = (damped: boolean, zoom: number, pitch: number) => {
  canopy.resetArm()
  const player = new THREE.Vector3(inWood.x - 34, 0, inWood.z)
  const camera = new THREE.Vector3()
  const target = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const { elevation, boom } = rig(zoom, pitch)
  const yaw = 0.25
  let previousY = 0
  let previousRate = 0
  let reversals = 0
  let peak = 0
  let total = 0
  let frames = 0
  let lifted = 0
  let episodes = 0
  let liftedLast = false
  let jolts = 0
  let cut = 0
  let cuts = 0
  let occluded = 0
  const was = new THREE.Vector3()
  const rates: number[] = []
  const walkModes = new Map<string, number>()
  for (let frame = 0; frame < 60 * 22; frame++) {
    // Straight east for eleven seconds, then straight back.
    player.x += (frame < 60 * 11 ? WALK : -WALK) * DT
    target.copy(player).add(new THREE.Vector3(0, 1.6, 0))
    place(desired, target, yaw, elevation, boom)
    desired.y = Math.max(desired.y, EYE_FLOOR)
    if (damped) {
      /* The mode is read from a stateless solve of the same request, purely to
       * report how the arm is resolving the walk; the damped call below is what
       * actually moves the lens. */
      const mode = canopy.solveArm(target.x, target.y, target.z, yaw, elevation, boom).mode
      walkModes.set(mode, (walkModes.get(mode) ?? 0) + 1)
      canopy.springArm(desired, target, DT)
    }
    else {
      const arm = canopy.solveArm(target.x, target.y, target.z, yaw, elevation, boom)
      place(desired, target, arm.yaw, arm.elevation, arm.boom)
    }
    if (frame === 0) camera.copy(desired)
    was.copy(camera)
    camera.lerp(desired, 1 - Math.exp(-DT * 12))
    camera.y = Math.max(camera.y, EYE_FLOOR)
    canopy.settle(camera, desired, target)
    if (canopy.inWood(camera.x, camera.y, camera.z)) failures.push(`the walked lens is inside wood at frame ${frame}`)
    if (camera.distanceTo(target) < Math.min(boom, canopy.boomFloor) - 1e-6) {
      failures.push(`the walked boom is ${camera.distanceTo(target).toFixed(2)}m at frame ${frame}`)
    }
    /* How far the lens moved in one frame, which is what a cut looks like. The
     * player walks 5cm a frame, so the camera following them is about that;
     * anything over half a metre is the arm moving, not the walk. */
    if (frame > 0) {
      const jump = was.distanceTo(camera)
      cut = Math.max(cut, jump)
      if (jump > 0.5) cuts += 1
    }
    occluded += occlusionOf(camera, target)
    const above = camera.y > target.y + Math.sin(elevation) * boom + 1
    if (above) lifted += 1
    // One episode is one trip up over the crowns and back down again.
    if (above && !liftedLast) episodes += 1
    liftedLast = above
    if (frame > 0) {
      const rate = (camera.y - previousY) / DT
      rates.push(Math.abs(rate))
      peak = Math.max(peak, Math.abs(rate))
      if (Math.abs(rate) > 8) jolts += 1
      total += Math.abs(rate)
      frames += 1
      if (Math.abs(rate) > 0.4 && Math.abs(previousRate) > 0.4 && Math.sign(rate) !== Math.sign(previousRate)) reversals += 1
      previousRate = rate
    }
    previousY = camera.y
  }
  rates.sort((a, b) => a - b)
  const top = [...walkModes.entries()].sort((a, b) => b[1] - a[1])
  return {
    peak, mean: total / frames, p99: quantile(rates, 0.99), jolts, cut, cuts, reversals, lifted, episodes, frames,
    occluded: occluded / (frames + 1),
    modes: top.map(([mode, count]) => `${mode} ${Math.round((count / (frames + 1)) * 100)}%`).join(', '),
  }
}
console.log()
console.log('=== 4. walking into the wildwood and back out, 22s at 60fps ===')
for (const [zoom, pitch] of [[9.5, 0], [22, 0.5], [32, 0.85], [32, 0.2]] as const) {
  const damped = walkAcross(true, zoom, pitch)
  const raw = walkAcross(false, zoom, pitch)
  console.log()
  console.log(`zoom ${zoom}, pitch ${pitch} — lens asked for ${(1.6 + Math.sin(rig(zoom, pitch).elevation) * rig(zoom, pitch).boom).toFixed(1)}m up on a ${rig(zoom, pitch).boom.toFixed(1)}m boom`)
  console.log('                                            damped     undamped')
  console.log(`lens vertical speed, mean                 ${damped.mean.toFixed(2).padStart(6)}m/s  ${raw.mean.toFixed(2).padStart(7)}m/s`)
  console.log(`lens vertical speed, p99                  ${damped.p99.toFixed(2).padStart(6)}m/s  ${raw.p99.toFixed(2).padStart(7)}m/s`)
  console.log(`lens vertical speed, peak                 ${damped.peak.toFixed(2).padStart(6)}m/s  ${raw.peak.toFixed(2).padStart(7)}m/s`)
  console.log(`biggest move in one frame                 ${damped.cut.toFixed(2).padStart(6)}m    ${raw.cut.toFixed(2).padStart(6)}m`)
  console.log(`frames the lens moved over 0.5m           ${String(damped.cuts).padStart(6)}    ${String(raw.cuts).padStart(7)}   of ${damped.frames}`)
  console.log(`frames faster than 8m/s                   ${String(damped.jolts).padStart(6)}    ${String(raw.jolts).padStart(7)}   of ${damped.frames}`)
  console.log(`direction reversals over 0.4m/s           ${String(damped.reversals).padStart(6)}    ${String(raw.reversals).padStart(7)}`)
  console.log(`trips up over the crowns and back         ${String(damped.episodes).padStart(6)}    ${String(raw.episodes).padStart(7)}`)
  console.log(`frames over 1m above the asked height     ${pct(damped.lifted, damped.frames).padStart(6)}   ${pct(raw.lifted, raw.frames).padStart(7)}`)
  console.log(`wood between lens and wayfinder, mean     ${(damped.occluded * 100).toFixed(1).padStart(5)}%   ${(raw.occluded * 100).toFixed(1).padStart(6)}%`)
  console.log(`how the arm resolved it: ${damped.modes}`)
  const at = `at zoom ${zoom}`
  if (damped.reversals > raw.reversals) failures.push(`the damper adds vertical direction reversals ${at}`)
  if (damped.episodes > raw.episodes) failures.push(`the damper adds trips over the crowns ${at}`)
  /*
   * Budgets rather than comparisons: one bob a second is a bob whatever the
   * undamped run does.
   *
   * They are set on METRES MOVED IN A FRAME and on sustained speed, not on peak
   * or p99 speed. A p99 of 7m/s sounds alarming and is 12cm of lens in a
   * sixtieth of a second, which nobody can see; the thing that reads on screen
   * is a single frame that moves the lens a couple of metres, and how much of
   * the time the lens is moving at all.
   */
  if (damped.mean > 3) failures.push(`the damped lens averages ${damped.mean.toFixed(2)}m/s of vertical travel ${at}`)
  if (damped.cut > 2.5) failures.push(`the damped lens cuts ${damped.cut.toFixed(2)}m in one frame ${at}`)
  if (damped.cuts > 40) failures.push(`the damped lens moves over half a metre in a frame ${damped.cuts} times ${at}`)
  if (damped.reversals > 22) failures.push(`the damped lens reverses vertically ${damped.reversals} times in 22s ${at}`)
  if (damped.episodes > 8) failures.push(`the damped lens goes over the crowns and back ${damped.episodes} times in 22s ${at}`)
}

console.log()
if (failures.length) {
  for (const line of failures.slice(0, 12)) console.log(`FAIL: ${line}`)
  console.log(`FAIL: the spring arm does not hold (${failures.length} findings).`)
  process.exit(1)
}
console.log('ok: the lens is never in the wood, the boom keeps its floor, and the edge walk does not pop.')
process.exit(0)
