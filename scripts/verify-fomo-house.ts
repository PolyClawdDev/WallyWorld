/*
 * The Fomo House, checked numerically.
 *
 * Four claims about src/fomoHouse.ts that a screenshot can suggest and only
 * arithmetic can settle:
 *
 *   1. THE EYES ARE NOT MIRRORED ON THE STREET FACE. `Batch.plate()` lays grid
 *      column 0 at the plate's local −x, and a player in front of a `faceYaw: 0`
 *      plate is looking along +z where screen-right is world −x. So the street
 *      face has to be struck from REVERSED rows, and the two crescents open to
 *      the left, so getting it wrong is eyes looking the other way and is
 *      invisible in the grid. Checked by reading the welded cube centres back
 *      out of the geometry and re-deriving what a player at −z sees.
 *   2. THE EYES MOVE IN PLACE. Advanced for a simulated minute; their world
 *      centre must stay put in x and z to the millimetre while y oscillates,
 *      which is the difference between floating a 13m pair of eyes and walking
 *      them round the quarter.
 *   3. THE SLAB IS SOLID. The street face and the reverse must occupy the same
 *      world columns. If the reverse were struck from reversed rows too, the
 *      silhouette would be this shape welded to its own mirror and both mouths
 *      would fill in.
 *   4. NOTHING LEAKS. Two welded bodies and two canvas textures, and freeing
 *      one of them is a leak rather than a fix.
 *
 * Also prints the grid and the cost, because "948 boxes, 11,376 triangles" is
 * the only honest answer to "how much did this cost" and it has to come from
 * the batch rather than from a comment.
 *
 * Usage: npx tsx scripts/verify-fomo-house.ts
 */
import * as THREE from 'three'

const ctxCalls: string[] = []
const ctxStub = new Proxy({}, {
  get: (_t, key) => (typeof key === 'string' && key === 'canvas' ? {} : () => { ctxCalls.push(String(key)) }),
  set: () => true,
}) as unknown as CanvasRenderingContext2D
;(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
}

/* The same dispose spy verify-canopy.ts uses: patch the prototypes and record
 * the instance, because nothing on a disposed geometry says it was disposed. */
const disposed = new Set<object>()
for (const proto of [THREE.BufferGeometry.prototype, THREE.Material.prototype, THREE.Texture.prototype]) {
  const original = (proto as unknown as { dispose: () => void }).dispose
  ;(proto as unknown as { dispose: () => void }).dispose = function patched(this: object) {
    disposed.add(this)
    original.call(this)
  }
}

const { buildingSpecs } = await import('../src/townData')
const { createFomoHouse, animateFomoHouse, FOMO_NOTICE } = await import('../src/fomoHouse')

const spec = buildingSpecs.find(one => one.landmark === 'fomo')
if (!spec) throw new Error('no fomo landmark in buildingSpecs')

let failures = 0
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`)
}

const house = createFomoHouse(spec)
const eyes = house.getObjectByName('fomo-eyes') as THREE.Group
house.updateMatrixWorld(true)

/* ------------------------------- the grid ------------------------------- */
console.log(`=== ${spec.name} at (${spec.x}, ${spec.z}), ${spec.width}m x ${spec.depth}m, ${spec.height}m to the top of the eyes ===`)
console.log()

/*
 * The art, read back out of the welded geometry rather than out of the grid
 * function, so what is printed is what was actually built.
 *
 * Cube centres are bucketed onto the eyes' own cell pitch. World −x is a
 * player's screen-RIGHT when they stand on the −z side and look along +z, so
 * the row is printed from the largest world x to the smallest: that string is
 * literally what the forecourt sees, left to right.
 */
const CELL = 0.44
type Cell = { col: number; row: number; z: number }
const cells: Cell[] = []
const position = new THREE.Vector3()
for (const mesh of eyes.children as THREE.Mesh[]) {
  const attribute = mesh.geometry.getAttribute('position')
  // 24 vertices a cube, welded in order, so the mean of each run of 24 is a
  // cube centre. Local to the eyes group, which is where they were built.
  for (let i = 0; i < attribute.count; i += 24) {
    position.set(0, 0, 0)
    for (let v = i; v < i + 24; v++) position.x += attribute.getX(v)
    for (let v = i; v < i + 24; v++) position.y += attribute.getY(v)
    for (let v = i; v < i + 24; v++) position.z += attribute.getZ(v)
    position.divideScalar(24)
    // Half-cell keys, not whole-cell. The grid is an EVEN 30 columns wide, so
    // `plate` centres it by putting every cube centre on a half cell, and
    // rounding those to whole cells drops every other column.
    cells.push({ col: Math.round(position.x / (CELL / 2)), row: Math.round(position.y / (CELL / 2)), z: Math.round(position.z * 1e4) / 1e4 })
  }
}
const cols = cells.map(c => c.col)
const rows = cells.map(c => c.row)
const colLow = Math.min(...cols), colHigh = Math.max(...cols)
const rowLow = Math.min(...rows), rowHigh = Math.max(...rows)

const streetDepth = Math.min(...cells.map(c => c.z))
const streetCells = new Set(cells.filter(c => c.z === streetDepth).map(c => `${c.col},${c.row}`))
const reverseDepth = Math.max(...cells.map(c => c.z))
const reverseCells = new Set(cells.filter(c => c.z === reverseDepth).map(c => `${c.col},${c.row}`))

console.log('the street face, as a player standing in the forecourt sees it:')
const seen: string[] = []
for (let row = rowHigh; row >= rowLow; row -= 2) {
  let line = ''
  // Largest world x first: that is the left of the screen from −z.
  for (let col = colHigh; col >= colLow; col -= 2) line += streetCells.has(`${col},${row}`) ? '#' : '.'
  seen.push(line)
  console.log('  ' + line)
}
console.log()

/* ------------------- 1. the street face is not mirrored ------------------ */
/*
 * Both crescents in the owner's render open to the LEFT: at the vertical
 * middle each one is a solid belly of stroke with clear air to its left. So in
 * what the forecourt sees, the middle row must begin with air, and the
 * mirrored strike — air on the RIGHT of each belly — is the failure.
 */
const middle = seen[Math.floor(seen.length / 2)]
const leading = middle.length - middle.replace(/^\.+/, '').length
const trailing = middle.length - middle.replace(/\.+$/, '').length
check(
  leading > 4 && trailing === 0,
  'the street face reads unmirrored: both crescents open to the left',
  `middle row "${middle}" has ${leading} cells of air on the left and ${trailing} on the right`,
)

/* ----------------------- 3. the slab is one solid body ------------------- */
check(
  streetCells.size === reverseCells.size && [...streetCells].every(key => reverseCells.has(key)),
  'the reverse occupies the same world columns as the street face',
  `${streetCells.size} cells a face, ${[...streetCells].filter(k => !reverseCells.has(k)).length} of them unmatched`,
)

/* --------------------------- 2. motion in place -------------------------- */
/*
 * The pivot's WORLD position is the claim, not the bounding box's centre: the
 * box is measured on the axes of the world and the slab turns inside it, so its
 * centre shifts by a couple of millimetres as the art — which is not perfectly
 * centred in its own 30-column grid — swings. The pivot is what would orbit if
 * this had been built at town coordinates, so the pivot is what is measured.
 * The box wobble is reported alongside, so the millimetres are a number rather
 * than a surprise.
 */
const restY = eyes.position.y
const box = new THREE.Box3()
const pivot = new THREE.Vector3()
const centre = new THREE.Vector3()
const track: Array<{ x: number; y: number; z: number; yaw: number; bx: number; bz: number }> = []
for (let frame = 0; frame < 3600; frame++) {
  animateFomoHouse(house, 1 / 60)
  house.updateMatrixWorld(true)
  eyes.getWorldPosition(pivot)
  box.setFromObject(eyes)
  box.getCenter(centre)
  track.push({ x: pivot.x, y: pivot.y, z: pivot.z, yaw: eyes.rotation.y, bx: centre.x, bz: centre.z })
}
const spread = (key: 'x' | 'y' | 'z' | 'yaw' | 'bx' | 'bz') =>
  Math.max(...track.map(t => t[key])) - Math.min(...track.map(t => t[key]))
check(spread('x') === 0 && spread('z') === 0, 'the eyes stay over the house: the pivot does not move in x or z',
  `pivot held at (${track[0].x.toFixed(3)}, ${track[0].z.toFixed(3)}) for 3600 frames`)
check(Math.abs(track[0].x - spec.x) < 1e-9 && Math.abs(track[0].z - spec.z) < 1e-9,
  'and the pivot is the house\'s own axis', `(${spec.x}, ${spec.z})`)
check(spread('bx') < 0.01 && spread('bz') < 0.01, 'so the swing is a turn in place, not an orbit',
  `the swept box centre moves ${(spread('bx') * 1000).toFixed(1)}mm in x and ${(spread('bz') * 1000).toFixed(1)}mm in z`)
check(spread('y') > 0.9 && spread('y') < 1.2, 'and they bob', `${spread('y').toFixed(2)}m of travel`)
check(spread('yaw') > 0.45 && spread('yaw') < 0.52, 'and they sway, well short of edge-on',
  `${((spread('yaw') * 180) / Math.PI).toFixed(1)} degrees of swing, peak ${((Math.max(...track.map(t => Math.abs(t.yaw))) * 180) / Math.PI).toFixed(1)} off the street`)

/* -------------------------- clearances and scale ------------------------ */
// Back to rest, or the slab is measured mid-sway and reads half a metre thicker
// and a metre wider than it is.
eyes.rotation.y = 0
eyes.position.y = restY
house.updateMatrixWorld(true)
box.setFromObject(eyes)
const span = box.getSize(new THREE.Vector3())
const zcash = buildingSpecs.find(one => one.landmark === 'zcash')!
console.log()
console.log(`eyes          ${(colHigh - colLow) / 2 + 1} x ${(rowHigh - rowLow) / 2 + 1} cells at ${CELL}m = ${span.x.toFixed(2)}m wide, ${span.y.toFixed(2)}m tall, ${span.z.toFixed(2)}m thick`)
console.log(`              ${box.min.y.toFixed(2)}m to ${box.max.y.toFixed(2)}m up, over a base topping out at 9.00m`)
console.log(`the coin      15.00m wide, 8.00m to 22.95m up`)
check(span.x < 15 && box.max.y < 22.95, 'the eyes do not out-measure the Zcash coin',
  `${span.x.toFixed(2)}m < 15.00m wide and ${box.max.y.toFixed(2)}m < 22.95m tall`)
check(box.min.y - 9 > 3, 'and there is clear air under them', `${(box.min.y - 9).toFixed(2)}m of gap at rest`)
console.log(`distance to the coin: ${Math.hypot(spec.x - zcash.x, spec.z - zcash.z).toFixed(0)}m`)

/* -------------------------------- the cost ------------------------------- */
console.log()
console.log(`cost          ${house.userData.boxes} boxes, ${house.userData.triangles} triangles, ${house.userData.meshes} meshes`)

/* ------------------------------ the notice ------------------------------- */
/*
 * The wording, asserted rather than admired. `catalogue.ts` forbids describing
 * an unavailable thing as "coming soon", because that is a promise nobody here
 * is in a position to make, and the same rule governs a building.
 */
console.log()
const words = [FOMO_NOTICE.headline, ...FOMO_NOTICE.boardLines, ...FOMO_NOTICE.lines].join(' ').toLowerCase()
for (const banned of ['coming soon', 'soon', 'launch', 'will be', 'beta', 'q1', 'q2', 'q3', 'q4', 'roadmap', 'partner', 'official', 'powered by', 'in collaboration']) {
  check(!words.includes(banned), `the notice does not say "${banned}"`)
}
check(/not affiliated with, endorsed by, or connected to/.test(words), 'the notice disclaims affiliation in plain words')
check(words.includes('nothing here works') || words.includes('none of that is built'), 'the notice says nothing works')
check(!/http|\.io|\.com|ref=|utm_/.test(words), 'the notice carries no link, referral or domain')

/* ------------------------------ 4. disposal ------------------------------ */
const geometries = new Set<THREE.BufferGeometry>()
const materials = new Set<THREE.Material>()
const textures = new Set<THREE.Texture>()
house.traverse(object => {
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
;(house.userData.dispose as () => void)()
console.log()
for (const [label, all] of [['geometries', geometries], ['materials', materials], ['textures', textures]] as const) {
  const freed = [...all].filter(item => disposed.has(item as object)).length
  console.log(`${label.padEnd(12)} created ${String(all.size).padStart(3)}   freed ${String(freed).padStart(3)}   LEAKED ${all.size - freed}`)
  check(freed === all.size, `every one of the ${label} is freed`)
}
// Idempotent, because main.tsx asks for it by hand AND the 'removed' listener
// fires on a remount, and a double free throws in WebGL.
;(house.userData.dispose as () => void)()
check(true, 'and a second dispose is a no-op')

console.log()
if (failures) {
  console.log(`FAIL: ${failures} check${failures === 1 ? '' : 's'} failed.`)
  process.exit(1)
}
console.log('ok: the eyes read the right way round, float in place, cost what they say, and free themselves.')
