/*
 * Does the arena hold, and does it let go?
 *
 * Two questions, both answered by counting rather than by looking:
 *
 *   A. CONTAINMENT.  A duellist shoved as hard as the game can shove
 *      one, from everywhere on the floor, in every direction, must never
 *      end up off the platform. Same shape as scripts/verify-containment.ts,
 *      which proves the same thing about animals and their regions.
 *
 *   B. DISPOSAL.  Every geometry and material the arena allocates must
 *      receive a dispose. `renderer.info.memory` cannot answer this —
 *      it only counts what reached the GPU, and the thing that leaks is
 *      usually the thing that never got drawn. So this instruments the
 *      allocation path instead:
 *
 *        Material.prototype.setValues       runs in every material ctor
 *        BufferGeometry.prototype.setAttribute  runs in every geometry ctor
 *
 *      Anything the arena builds is caught there, whether or not it was
 *      ever put in the scene, and a one-shot listener on each object's
 *      own 'dispose' event records when it is freed. Allocated minus
 *      disposed is the leak, exactly.
 *
 * Usage: npx tsx scripts/verify-arena.ts [cycles] [ticks]
 */
import * as THREE from 'three'
import { createArena } from '../src/arena'
import { DIMENSION_NOTES, checkDimensions } from '../src/arena/dimensions'
import { PVP_KITS } from '../src/shared/pvpKits'

const CYCLES = Number(process.argv[2] ?? 200)
const TICKS = Number(process.argv[3] ?? 40_000)

let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failed++
}

/* =================================================================== *
 * 0. The size, and where it came from
 * =================================================================== */

console.log('=== 0. platform size, derived from the live kit tables ===')
for (const note of DIMENSION_NOTES) console.log(`  ${note}`)
check('the derivation is self-consistent', checkDimensions().length === 0, checkDimensions().join('; '))

/* =================================================================== *
 * 1. Containment
 * =================================================================== */

/**
 * The hardest shove in the game, and then some.
 *
 * ORBIT blinks 9m instantly and CINDER dashes 7.5m; a sprint frame at
 * 144Hz is 4cm. The 100m and 1e6 entries are not gameplay, they are the
 * corrupt-input case — a desync or a bad server correction — because a
 * boundary that only holds against legal inputs is not a boundary.
 */
const SHOVES = [0.041, 0.098, 0.5, 2, 7.5, 9, 25, 100, 1e6]

const arena = createArena()
const body = 0.62
const limit = arena.boundaryRadius - body

console.log()
console.log(`=== 1. containment: boundary ${arena.boundaryRadius}m, body ${body}m, legal centre <= ${limit.toFixed(3)}m ===`)

let attempts = 0
let escapes = 0
let worstOvershoot = 0
let worstAt = ''

const probe = (p: THREE.Vector3, what: string) => {
  attempts++
  const d = Math.hypot(p.x, p.z)
  const over = d - limit
  if (over > worstOvershoot) {
    worstOvershoot = over
    worstAt = what
  }
  // 1e-9 of slack: the clamp scales a vector to `limit`, and the hypot of
  // the scaled result is allowed to land one float above it.
  if (over > 1e-9 || !arena.contains(p, body)) escapes++
}

/* --- 1a. a single shove, from everywhere, in every direction --- */
const p = new THREE.Vector3()
let singleShoves = 0
for (let r = 0; r <= arena.boundaryRadius + 6; r += 0.25) {
  for (let a = 0; a < 64; a++) {
    const angle = (a / 64) * Math.PI * 2
    for (let d = 0; d < 64; d++) {
      const push = (d / 64) * Math.PI * 2
      for (const magnitude of SHOVES) {
        p.set(Math.cos(angle) * r, 0, Math.sin(angle) * r)
        arena.confine(p, body)
        arena.slide(p, Math.cos(push) * magnitude, Math.sin(push) * magnitude, body)
        probe(p, `single shove ${magnitude}m from r=${r.toFixed(2)}`)
        singleShoves++
      }
    }
  }
}
console.log(`  single shoves            ${singleShoves.toLocaleString()}`)

/* --- 1b. sustained pressure: hold the stick into the wall for a long time --- */
/*
 * A one-off push can be absorbed by a clamp that quietly drifts. Holding
 * the input is what finds drift, so each of these runs the same direction
 * into the wall for the whole tick budget and checks every single frame.
 */
const SPRINT = Math.max(...Object.values(PVP_KITS).map(k => k.stats.runSpeed))
const STEP = SPRINT / 60
let held = 0
for (let a = 0; a < 24; a++) {
  const angle = (a / 24) * Math.PI * 2
  p.set(0, 0, 0)
  for (let tick = 0; tick < TICKS; tick++) {
    arena.slide(p, Math.cos(angle) * STEP, Math.sin(angle) * STEP, body)
    probe(p, `held sprint into ${((angle * 180) / Math.PI).toFixed(0)}deg`)
    held++
  }
}
console.log(`  held-sprint frames       ${held.toLocaleString()}`)

/* --- 1c. a duel's worth of real movement, with blinks and dashes --- */
/*
 * Deterministic pseudo-random so a failure can be reproduced: a wanderer
 * that turns, sprints, and every so often blinks 9m in a random direction,
 * which is the one move that can cross the wall in a single frame.
 */
let seed = 20260929
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
let walked = 0
let blinks = 0
for (let runner = 0; runner < 24; runner++) {
  p.set((rand() * 2 - 1) * 12, 0, (rand() * 2 - 1) * 12)
  arena.confine(p, body)
  let heading = rand() * Math.PI * 2
  for (let tick = 0; tick < TICKS; tick++) {
    heading += (rand() - 0.5) * 0.35
    if (rand() < 0.004) {
      // A blink aimed at wherever, clamped the way the lifecycle agent will.
      const target = new THREE.Vector3(p.x + Math.cos(heading) * 9, 0, p.z + Math.sin(heading) * 9)
      const legal = arena.clampTarget(target, body)
      p.copy(legal)
      blinks++
    } else {
      arena.slide(p, Math.cos(heading) * STEP, Math.sin(heading) * STEP, body)
    }
    probe(p, `wanderer ${runner}`)
    walked++
  }
}
console.log(`  wandering frames         ${walked.toLocaleString()}  (${blinks.toLocaleString()} blinks)`)

/* --- 1d. other body sizes --- */
/* A projectile is a small body and a summon is a large one; the boundary
 * has to be right for both, not just for the 0.62m player. */
let sized = 0
for (const radius of [0, 0.2, 0.62, 1.2, 2.5, 5]) {
  const localLimit = arena.boundaryRadius - radius
  for (let a = 0; a < 128; a++) {
    const angle = (a / 128) * Math.PI * 2
    p.set(Math.cos(angle) * 500, 0, Math.sin(angle) * 500)
    arena.confine(p, radius)
    sized++
    const d = Math.hypot(p.x, p.z)
    if (d - localLimit > 1e-9) {
      escapes++
      worstOvershoot = Math.max(worstOvershoot, d - localLimit)
      worstAt = `body radius ${radius}`
    }
    attempts++
  }
}
console.log(`  body-radius probes       ${sized.toLocaleString()}`)

/* --- 1e. garbage in --- */
const nasty = [
  [NaN, NaN],
  [Infinity, 0],
  [0, -Infinity],
  [1e308, 1e308],
  [0, 0],
]
for (const [x, z] of nasty) {
  p.set(x, 0, z)
  arena.confine(p, body)
  attempts++
  if (!arena.contains(p, body)) {
    escapes++
    worstAt = `garbage input ${x},${z}`
  }
}

console.log()
console.log(`  total attempts           ${attempts.toLocaleString()}`)
console.log(`  escapes                  ${escapes}`)
console.log(`  worst overshoot          ${worstOvershoot.toExponential(3)} m  (${worstAt})`)
check('nothing ever leaves the platform', escapes === 0, `${escapes} escapes in ${attempts.toLocaleString()} attempts`)
check('the worst overshoot is float noise, not metres', worstOvershoot < 1e-9, `${worstOvershoot.toExponential(3)}m`)

/* --- 1f. the spawns are legal, and are where the derivation says --- */
const [a, b] = arena.spawns
const separation = a.position.distanceTo(b.position)
check('both spawns stand inside the boundary', arena.contains(a.position, body) && arena.contains(b.position, body))
check('spawn separation matches the derivation', Math.abs(separation - 24) < 1e-9, `${separation}m`)
check('each spawn faces the middle', Math.abs(a.facing - Math.PI) < 1e-9 && Math.abs(b.facing) < 1e-9)

console.log(`  stats  boxes=${arena.stats.boxes}  triangles=${arena.stats.triangles}  meshes=${arena.stats.meshes}  lights=${arena.stats.lights}`)
arena.dispose()

/* =================================================================== *
 * 2. Disposal, by census
 * =================================================================== */

type Census = {
  geometries: Set<THREE.BufferGeometry>
  materials: Set<THREE.Material>
  textures: Set<THREE.Texture>
  disposedGeometries: number
  disposedMaterials: number
  disposedTextures: number
}

const realSetAttribute = THREE.BufferGeometry.prototype.setAttribute
const realSetValues = THREE.Material.prototype.setValues

/**
 * Watch every allocation for the duration of one arena's life.
 *
 * The listener is attached at allocation time and fires from the object's
 * own dispose(), so it cannot be fooled by an object that is dropped on
 * the floor: an orphan simply never fires, and shows up in the
 * difference.
 */
function watch(): { census: Census; stop: () => void } {
  const census: Census = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
    disposedGeometries: 0,
    disposedMaterials: 0,
    disposedTextures: 0,
  }

  const seeTexture = (texture: THREE.Texture) => {
    if (census.textures.has(texture)) return
    census.textures.add(texture)
    texture.addEventListener('dispose', function once() {
      texture.removeEventListener('dispose', once)
      census.disposedTextures++
    })
  }

  THREE.BufferGeometry.prototype.setAttribute = function (this: THREE.BufferGeometry, ...args) {
    if (!census.geometries.has(this)) {
      census.geometries.add(this)
      const self = this
      self.addEventListener('dispose', function once() {
        self.removeEventListener('dispose', once)
        census.disposedGeometries++
      })
    }
    return realSetAttribute.apply(this, args as Parameters<typeof realSetAttribute>)
  }

  THREE.Material.prototype.setValues = function (this: THREE.Material, ...args) {
    if (!census.materials.has(this)) {
      census.materials.add(this)
      const self = this
      self.addEventListener('dispose', function once() {
        self.removeEventListener('dispose', once)
        census.disposedMaterials++
      })
    }
    return realSetValues.apply(this, args as Parameters<typeof realSetValues>)
  }

  return {
    census,
    stop() {
      THREE.BufferGeometry.prototype.setAttribute = realSetAttribute
      THREE.Material.prototype.setValues = realSetValues
      // Textures are not created through a common method, so they are found
      // by looking at what the materials are actually holding.
      for (const material of census.materials) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          const texture = value as THREE.Texture | null
          if (texture && texture.isTexture) seeTexture(texture)
        }
      }
    },
  }
}

console.log()
console.log('=== 2. disposal: every allocation accounted for ===')

const warm = watch()
const warmArena = createArena()
warm.stop()
const warmCounts = {
  geometries: warm.census.geometries.size,
  materials: warm.census.materials.size,
  textures: warm.census.textures.size,
}
const warmReport = warmArena.dispose()
console.log(`  one arena allocates      ${warmCounts.geometries} geometries, ${warmCounts.materials} materials, ${warmCounts.textures} textures`)
console.log(`  dispose() reports        ${warmReport.geometries} geometries, ${warmReport.materials} materials, ${warmReport.textures} textures, ${warmReport.lights} lights`)
console.log(`  dispose events observed  ${warm.census.disposedGeometries} geometries, ${warm.census.disposedMaterials} materials, ${warm.census.disposedTextures} textures`)
check('every allocated geometry received a dispose event',
  warm.census.disposedGeometries === warmCounts.geometries,
  `${warm.census.disposedGeometries}/${warmCounts.geometries}`)
check('every allocated material received a dispose event',
  warm.census.disposedMaterials === warmCounts.materials,
  `${warm.census.disposedMaterials}/${warmCounts.materials}`)
check('every allocated texture received a dispose event',
  warm.census.disposedTextures === warmCounts.textures,
  `${warm.census.disposedTextures}/${warmCounts.textures}`)
check('the arena allocates no textures at all', warmCounts.textures === 0, `${warmCounts.textures}`)
check('the arena builds something worth counting', warmCounts.geometries > 10 && warmCounts.materials > 10)
check('dispose() agrees with the census',
  warmReport.geometries === warmCounts.geometries && warmReport.materials === warmCounts.materials)
check('a second dispose() is a no-op rather than a double free',
  warmArena.dispose().geometries === 0)

/* =================================================================== *
 * 3. Re-entrancy: build and tear down many times
 * =================================================================== */

console.log()
console.log(`=== 3. re-entrancy: ${CYCLES} build/attach/update/detach/dispose cycles ===`)

const scene = new THREE.Scene()
const priorBackground = new THREE.Color('#141c28')
const priorFog = new THREE.Fog('#141c28', 18, 36)
scene.background = priorBackground
scene.fog = priorFog
const marker = new THREE.Object3D()
marker.name = 'the-rest-of-the-world'
scene.add(marker)
const baselineChildren = scene.children.length

let allocGeo = 0
let allocMat = 0
let allocTex = 0
let freedGeo = 0
let freedMat = 0
let freedTex = 0
let strayChildren = 0
let strayLights = 0
let strayRootChildren = 0
let environmentRestored = 0

for (let cycle = 0; cycle < CYCLES; cycle++) {
  const w = watch()
  const instance = createArena()
  w.stop()

  instance.attach(scene)
  // Drive a few frames, because an update that allocates is a slower leak
  // but a leak all the same.
  for (let frame = 0; frame < 30; frame++) instance.update(cycle * 1000 + frame * 16.7)

  const lightsInScene = countLights(scene)
  if (lightsInScene !== instance.stats.lights) strayLights++

  instance.detach()
  if (scene.background === priorBackground && scene.fog === priorFog) environmentRestored++
  if (scene.children.length !== baselineChildren) strayChildren++

  const report = instance.dispose()
  if (instance.root.children.length !== 0) strayRootChildren++

  allocGeo += w.census.geometries.size
  allocMat += w.census.materials.size
  allocTex += w.census.textures.size
  freedGeo += w.census.disposedGeometries
  freedMat += w.census.disposedMaterials
  freedTex += w.census.disposedTextures
  if (report.geometries !== w.census.geometries.size) strayChildren++
}

function countLights(target: THREE.Object3D) {
  let n = 0
  target.traverse(node => {
    if ((node as THREE.Light).isLight) n++
  })
  return n
}

console.log(`  geometries  allocated ${allocGeo.toLocaleString()}   disposed ${freedGeo.toLocaleString()}   leaked ${allocGeo - freedGeo}`)
console.log(`  materials   allocated ${allocMat.toLocaleString()}   disposed ${freedMat.toLocaleString()}   leaked ${allocMat - freedMat}`)
console.log(`  textures    allocated ${allocTex.toLocaleString()}   disposed ${freedTex.toLocaleString()}   leaked ${allocTex - freedTex}`)
console.log(`  scene children after ${CYCLES} cycles: ${scene.children.length} (baseline ${baselineChildren})`)
console.log(`  lights left in the scene: ${countLights(scene)}`)

check(`${CYCLES} cycles leaked no geometry`, allocGeo === freedGeo, `${allocGeo - freedGeo} leaked`)
check(`${CYCLES} cycles leaked no material`, allocMat === freedMat, `${allocMat - freedMat} leaked`)
check(`${CYCLES} cycles leaked no texture`, allocTex === freedTex, `${allocTex - freedTex} leaked`)
check('every cycle allocated the same amount', allocGeo === warmCounts.geometries * CYCLES,
  `${allocGeo} vs ${warmCounts.geometries * CYCLES}`)
check('no arena light was left behind', strayLights === 0 && countLights(scene) === 0, `${strayLights} cycles`)
check('the scene graph came back to baseline every time', strayChildren === 0 && scene.children.length === baselineChildren)
check('dispose() empties the arena root', strayRootChildren === 0)
check('detach() restored the scene background and fog every time', environmentRestored === CYCLES,
  `${environmentRestored}/${CYCLES}`)
check('the rest of the world survived', scene.children[0] === marker)

/* =================================================================== *
 * 4. No hidden state
 * =================================================================== */

console.log()
console.log('=== 4. the module keeps nothing to itself ===')
const one = createArena()
const two = createArena()
check('two arenas can exist at once', one.root !== two.root && one.spawns[0].position !== two.spawns[0].position)
one.dispose()
check('disposing one does not disturb the other', two.stats.boxes > 0 && two.contains(new THREE.Vector3(0, 0, 0)))
two.dispose()

console.log()
console.log(failed === 0 ? 'ARENA: clean.' : `ARENA: FAILED — ${failed} check(s) above.`)
process.exit(failed === 0 ? 0 : 1)
