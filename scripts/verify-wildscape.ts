/*
 * Two measurements on the green, both taken off the real scene graph rather
 * than off the source:
 *
 *   1. TREES — species, count, and the actual height of every planted tree,
 *      read out of the instance matrices, so "very very high trees" is a
 *      number and not an adjective.
 *   2. RESOURCES — every BufferGeometry, Material and Texture the wildscape
 *      creates, against how many of them its dispose() actually frees.
 *
 * Usage: npx tsx scripts/verify-wildscape.ts
 */
import * as THREE from 'three'

/* --- the DOM the sign boards need ----------------------------------- */
/* wildscape.ts paints its signpost lettering onto a 2D canvas. Nothing here
 * rasterises anything, so a recording stub is enough to build the scene. */
const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D
;(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
}

/* --- count disposals ------------------------------------------------ */
const disposed = new Set<object>()
for (const proto of [THREE.BufferGeometry.prototype, THREE.Material.prototype, THREE.Texture.prototype]) {
  const original = (proto as { dispose: () => void }).dispose
  ;(proto as { dispose: () => void }).dispose = function patched(this: object) {
    disposed.add(this)
    return original.call(this)
  }
}

const { createWildscape } = await import('../src/wildscape')
const { treeMetrics } = await import('../src/treeArt')

const root = createWildscape()

/* --- 1. trees ------------------------------------------------------- */
/*
 * Height is taken per instance as scale.y x the top of that shell's geometry,
 * then maximised across every shell stamped at the same trunk position — so
 * the number is the real world height of the real tree, canopy included, not
 * the species' authored height.
 */
const trees = new Map<string, number>()
const trunkPos = new THREE.Vector3()
const trunkScale = new THREE.Vector3()
const trunkQuat = new THREE.Quaternion()
const matrix = new THREE.Matrix4()
let instanceCount = 0
root.getObjectByName('trees')!.traverse(object => {
  const mesh = object as THREE.InstancedMesh
  if (!mesh.isInstancedMesh) return
  mesh.geometry.computeBoundingBox()
  const top = mesh.geometry.boundingBox!.max.y
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix)
    matrix.decompose(trunkPos, trunkQuat, trunkScale)
    const key = `${trunkPos.x.toFixed(2)},${trunkPos.z.toFixed(2)}`
    const height = top * trunkScale.y
    if (height > (trees.get(key) ?? 0)) trees.set(key, height)
    instanceCount += 1
  }
})

const tallest = [...trees.entries()]
  .map(([key, height]) => ({ x: Number(key.split(',')[0]), z: Number(key.split(',')[1]), height }))
  .sort((a, b) => b.height - a.height)
const heights = [...trees.values()].sort((a, b) => a - b)
const quantile = (q: number) => heights[Math.min(heights.length - 1, Math.floor(q * heights.length))]
const stats = root.userData.stats as {
  trees: { meshes: number; trees: number; triangles: number; bySpecies: Array<{ id: string; trees: number; height: number }> }
  propMeshes: number
  propBoxes: number
}

console.log('=== 2. trees ===')
console.log(`species defined      ${stats.trees.bySpecies.length} of 7 (only species the mix actually planted appear)`)
console.log(`trees placed         ${heights.length}   (instances across all shells: ${instanceCount})`)
console.log(`forest draw calls    ${stats.trees.meshes}`)
console.log(`forest triangles     ${stats.trees.triangles.toLocaleString()}`)
console.log()
console.log('height of planted trees, world metres (crown included):')
console.log(`  min      ${heights[0].toFixed(1)}`)
console.log(`  p25      ${quantile(0.25).toFixed(1)}`)
console.log(`  median   ${quantile(0.5).toFixed(1)}`)
console.log(`  p90      ${quantile(0.9).toFixed(1)}`)
console.log(`  p99      ${quantile(0.99).toFixed(1)}`)
console.log(`  max      ${heights[heights.length - 1].toFixed(1)}`)
console.log(`  over 25m ${heights.filter(h => h >= 25).length}`)
console.log(`  over 30m ${heights.filter(h => h >= 30).length}`)
console.log()
console.log('the ten tallest, with where they stand (for aiming a camera at them):')
for (const tree of tallest.slice(0, 10)) console.log(`  ${tree.height.toFixed(1).padStart(5)}m at ${tree.x.toFixed(1)}, ${tree.z.toFixed(1)}`)
console.log()
console.log('species            trees  authoredHeight  note')
for (const species of stats.trees.bySpecies) {
  const m = treeMetrics(species.id as never)
  console.log(`${species.id.padEnd(16)} ${String(species.trees).padStart(6)} ${m.height.toFixed(1).padStart(15)}  ${m.note}`)
}
console.log()
console.log(`for scale: the tallest townhouse roof in this world is about 5-7m.`)

/* Density: how many trees the planting rules ASKED for against how many
 * survived the trunk-clash rejection, per region. A big gap here means the
 * wood is thinner than it was budgeted to be. */
const areas = (root.userData.stats as { regionArea: Array<{ id: string; area: number }> }).regionArea
const spacing: Record<string, number> = {
  wildwood: 46, hollow: 52, northmeadow: 210, eastmeadow: 230, southfields: 240, westoutskirts: 260, brasswood: 44,
}
console.log()
console.log('region          openGreen m2   treesWanted')
let wanted = 0
for (const { id, area } of areas) {
  const want = Math.round(area / spacing[id])
  wanted += want
  console.log(`${id.padEnd(14)} ${area.toFixed(0).padStart(12)} ${String(want).padStart(13)}`)
}
console.log(`total wanted ${wanted}, actually planted ${heights.length} (${((heights.length / wanted) * 100).toFixed(0)}% survived trunk-clash rejection)`)

/* --- 4. resources --------------------------------------------------- */
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
console.log('=== 4. resource disposal ===')
console.log(`root.userData.dispose present: ${dispose ? 'yes' : 'NO'}`)
if (dispose) dispose()

const report = (label: string, all: Set<object>) => {
  const freed = [...all].filter(item => disposed.has(item)).length
  console.log(`${label.padEnd(12)} created ${String(all.size).padStart(4)}   freed ${String(freed).padStart(4)}   LEAKED ${all.size - freed}`)
}
report('geometries', geometries as Set<object>)
report('materials', materials as Set<object>)
report('textures', textures as Set<object>)
console.log(`prop meshes ${stats.propMeshes}, prop boxes ${stats.propBoxes}`)
