import * as THREE from 'three'
import { materialFor, shadeJitter, weldVoxelShell } from './voxelBuild'
import type { Surface } from './voxelBuild'

/* ------------------------------------------------------------------ *
 * Trees.
 *
 * Authored the same way as everything else here: a pixel grid, extruded
 * into cubes. The only difference from a character sprite is which way
 * the grid is read. A wayfinder is a side view extruded along Z. A tree
 * is a HALF PROFILE revolved about its trunk — column index is radius
 * from the axis, row index is height — because a tree seen from any side
 * is the same tree, and revolving the profile is what makes that true
 * without authoring four views.
 *
 * Seven species, so a wood reads as a wood: two kinds of conifer, three
 * broadleaves, the Brasswood's bronze ironbark, and a scrub for meadow
 * edges. Two of them are deliberately enormous — the titan pine and the
 * elder oak stand 34m and 31m, five or six times a townhouse and tall
 * enough that the canopy leaves the top of the frame from underneath.
 *
 * ---- What this costs, and why it is built this way ----
 *
 * One geometry per species per colour, welded once at startup, stamped
 * across the world by one THREE.InstancedMesh each. So the whole forest
 * is about two dozen draw calls no matter how many trees there are, and
 * adding a species costs draw calls in single figures, not hundreds.
 *
 * Only the exposed faces of each voxel body are welded (see
 * `weldVoxelShell`). A tree is the one thing here that is both large and
 * repeated hundreds of times, and drawing the buried cubes would have
 * cost about four times the triangles for exactly the same picture.
 *
 * Variety per instance is free: yaw, a small lean, non-uniform scale and
 * a canopy tint all ride in the instance matrix and the instance colour,
 * so no two trees in the same InstancedMesh look alike.
 * ------------------------------------------------------------------ */

export type TreeSpeciesId = 'pine' | 'titanpine' | 'oak' | 'elder' | 'birch' | 'ironbark' | 'scrub'

type Profile = {
  /** Metres per cell. Bigger cells read chunkier and cost fewer of them. */
  cell: number
  /**
   * Half profile, top row first. Character at index `r` is the surface at
   * radius `r` cells from the trunk axis; '.' is air. Revolved about the axis.
   */
  half: string[]
  palette: Record<string, Surface | undefined>
  /** Trunk radius in metres, for the navigation obstacle. */
  trunk: number
  note: string
}

/* Bark and leaf tones. Deliberately several greens plus one bronze, so the
 * Brasswood does not read as the Wildwood with different signposts. */
const BARK = { color: '#4a3a2c', roughness: 0.92 }
const BARK_DARK = { color: '#33281e', roughness: 0.94 }
const BARK_PALE = { color: '#c9c4ad', roughness: 0.86 }
const BARK_PALE_MARK = { color: '#6e6a58', roughness: 0.88 }
const BARK_RED = { color: '#5c3a28', roughness: 0.9 }
const PINE = { color: '#26402f', roughness: 0.9 }
const PINE_LIT = { color: '#34573c', roughness: 0.9 }
const PINE_DEEP = { color: '#1a2f24', roughness: 0.92 }
const LEAF = { color: '#3f6438', roughness: 0.9 }
const LEAF_LIT = { color: '#557f3f', roughness: 0.9 }
const LEAF_DEEP = { color: '#2c4a2c', roughness: 0.92 }
const BIRCH_LEAF = { color: '#7f9a4a', roughness: 0.88 }
const BIRCH_LIT = { color: '#9cb45a', roughness: 0.88 }
const BRONZE_LEAF = { color: '#8a5f2c', roughness: 0.9 }
const BRONZE_LIT = { color: '#b07c33', roughness: 0.88 }
const BRONZE_DEEP = { color: '#5c3d1c', roughness: 0.92 }

const profiles: Record<TreeSpeciesId, Profile> = {
  /* The workhorse conifer. Layered skirts made by letting the radius step out,
   * tuck back and step out again, with the lit tone on each skirt's outer ring —
   * which is what makes one silhouette read as branches rather than a cone. */
  pine: {
    cell: 0.85,
    trunk: 0.55,
    note: 'Wildwood pine, about 17m.',
    half: [
      'L',
      'NL',
      'NNL',
      'NNd',
      'NNNL',
      'NNNd',
      'NNNNL',
      'NNNd',
      'NNNNL',
      'NNNNd',
      'NNNNNL',
      'NNNNd',
      'NNNNNL',
      'NNNNNd',
      'NNNNNNL',
      'NNNNNd',
      'ttNNNNL',
      'tt',
      'TT',
      'TTt',
    ],
    palette: { N: PINE, L: PINE_LIT, d: PINE_DEEP, T: BARK, t: BARK_DARK },
  },

  /* The one the brief asked for twice: a genuinely dramatic tree. Thirty cells
   * at 1.15m is 34.5m, against a 5m townhouse. Most of that is a bare red trunk
   * with the canopy starting two thirds of the way up, which is what makes a
   * tall tree read as tall instead of as a big tree. */
  titanpine: {
    cell: 1.15,
    trunk: 0.9,
    note: 'Titan pine, about 34m — six townhouses.',
    half: [
      'L',
      'NL',
      'NNL',
      'NNd',
      'NNNL',
      'NNNd',
      'NNNNL',
      'NNNd',
      'NNNNL',
      'NNNNd',
      'NNNNNL',
      'NNNNd',
      'NNNNNL',
      'NNNNNd',
      'NNNNNNL',
      'NNNNNd',
      'NNNNNNL',
      'ttNNNNd',
      'ttNNNL',
      'ttNNd',
      'RRt',
      'RRt',
      'RRt',
      'RRt',
      'RRt',
      'RRt',
      'RRRt',
      'RRRt',
      'RRRt',
      'RRRtt',
    ],
    palette: { N: PINE, L: PINE_LIT, d: PINE_DEEP, R: BARK_RED, T: BARK, t: BARK_DARK },
  },

  /* Broadleaf: a wide round crown on a short thick bole. The crown is widest a
   * third of the way down, not in the middle, so it does not read as a ball. */
  oak: {
    cell: 0.95,
    trunk: 0.7,
    note: 'Oak, about 16m, canopy 9m across.',
    half: [
      '.LL',
      'LLLl',
      'GGGLl',
      'GGGGLl',
      'GGGGGLl',
      'GGGGGGl',
      'gGGGGGLl',
      'gGGGGGGl',
      'ggGGGGGl',
      'ggGGGGg',
      'TtgGGGg',
      'Tt.ggg',
      'Tt',
      'TTt',
      'TTt',
      'TTTt',
    ],
    palette: { G: LEAF, L: LEAF_LIT, l: LEAF_LIT, g: LEAF_DEEP, T: BARK, t: BARK_DARK },
  },

  /* The landmark broadleaf. A buttressed trunk four cells wide at the base, and
   * a crown twenty metres across, so one of these anchors a whole clearing. */
  elder: {
    cell: 1.1,
    trunk: 1.15,
    note: 'Elder oak, about 31m, canopy 20m across.',
    half: [
      '..LLL',
      '.LLLLl',
      'GGGLLLl',
      'GGGGGLLl',
      'GGGGGGLLl',
      'GGGGGGGLl',
      'gGGGGGGGLl',
      'gGGGGGGGGl',
      'ggGGGGGGGl',
      'ggGGGGGGGl',
      'gggGGGGGGl',
      'TtgGGGGGGg',
      'Tt.gGGGGg',
      'Tt..ggGgg',
      'Tt...ggg',
      'Tt',
      'TTt',
      'TTt',
      'TTt',
      'TTTt',
      'TTTt',
      'TTTt',
      'TTTTt',
      'TTTTt',
      'TTTTTt',
      'TTTTTt',
      'TTTTTTt',
      'TTTTTTt',
    ],
    palette: { G: LEAF, L: LEAF_LIT, l: LEAF_LIT, g: LEAF_DEEP, T: BARK, t: BARK_DARK },
  },

  /* Slender, pale, and marked. The trunk is the point of this species: a white
   * bole with dark scars, so a stand of them breaks up a wall of dark conifer. */
  birch: {
    cell: 0.7,
    trunk: 0.35,
    note: 'Birch, about 12m, pale marked bole.',
    half: [
      '.L',
      'LLl',
      'BBLl',
      'BBBl',
      'BBBLl',
      'bBBBl',
      'bBBl',
      'WM',
      'WW',
      'WM',
      'WW',
      'WW',
      'WM',
      'WW',
      'WW',
      'WM',
      'WW',
    ],
    palette: { B: BIRCH_LEAF, L: BIRCH_LIT, l: BIRCH_LIT, b: LEAF_DEEP, W: BARK_PALE, M: BARK_PALE_MARK },
  },

  /* The Brasswood's own tree, and the reason the wood has that name: bronze
   * foliage on a near-black trunk, tall enough to keep the hollow in shadow. */
  ironbark: {
    cell: 1.05,
    trunk: 0.8,
    note: 'Ironbark, about 29m, bronze canopy.',
    half: [
      '.L',
      'LLl',
      'BBLl',
      'BBBLl',
      'BBBBLl',
      'BBBBBl',
      'dBBBBLl',
      'dBBBBBl',
      'ddBBBBl',
      'ddBBBl',
      'tdBBBl',
      'tt.dBd',
      'tt',
      'tTt',
      'tTt',
      'tTTt',
      'tTTt',
      'tTTt',
      'tTTTt',
      'tTTTt',
      'tTTTt',
      'tTTTTt',
      'tTTTTt',
      'tTTTTt',
      'tTTTTTt',
      'tTTTTTt',
      'tTTTTTt',
      'tTTTTTTt',
    ],
    palette: { B: BRONZE_LEAF, L: BRONZE_LIT, l: BRONZE_LIT, d: BRONZE_DEEP, T: BARK_DARK, t: { color: '#241c15', roughness: 0.94 } },
  },

  /* Meadow scrub. Three metres and almost no trunk, so open ground can be
   * dressed without closing the sightlines a hunt needs. */
  scrub: {
    cell: 0.6,
    trunk: 0.3,
    note: 'Thorn scrub, about 3m.',
    half: [
      '.L',
      'GLl',
      'GGLl',
      'GGGl',
      'gGGl',
      'Ttg',
    ],
    palette: { G: LEAF, L: LEAF_LIT, l: BIRCH_LIT, g: LEAF_DEEP, T: BARK, t: BARK_DARK },
  },
}

export type TreeSpecies = {
  id: TreeSpeciesId
  /** Metres, feet to crown, at scale 1. */
  height: number
  /** Metres, widest canopy half-width at scale 1. */
  canopyRadius: number
  /** Metres, trunk half-width at scale 1. What blocks movement. */
  trunkRadius: number
  note: string
  /** One welded surface per colour key, with the material it wants. */
  shells: Array<{ geometry: THREE.BufferGeometry; surface: Surface; cells: number }>
  cells: number
}

/**
 * Revolve one profile into voxels and weld each colour's exposed surface.
 *
 * Built once per species, never per tree. The cost is a few thousand
 * `Math.hypot` calls at startup, and what comes out is shared by every instance
 * of that species in the world.
 */
function speciesFrom(id: TreeSpeciesId): TreeSpecies {
  const profile = profiles[id]
  const rows = profile.half
  const rowCount = rows.length
  const maxRadius = Math.max(...rows.map(row => row.length - 1))

  const keyAt = (y: number, r: number) => {
    if (y < 0 || y >= rowCount) return undefined
    const row = rows[y]
    if (r < 0 || r >= row.length) return undefined
    const key = row[r]
    if (key === '.' || !profile.palette[key]) return undefined
    return key
  }
  /* Cell (dx, dz) at row y takes the profile's surface at the rounded radial
   * distance. Rounding rather than flooring is what keeps the revolved outline
   * round instead of octagonal at small radii. */
  const at = (dx: number, y: number, dz: number) => keyAt(y, Math.round(Math.hypot(dx, dz)))

  const byKey = new Map<string, Array<[number, number, number]>>()
  let cells = 0
  let canopyRadius = 0
  for (let y = 0; y < rowCount; y++) {
    for (let dx = -maxRadius; dx <= maxRadius; dx++) {
      for (let dz = -maxRadius; dz <= maxRadius; dz++) {
        const key = at(dx, y, dz)
        if (!key) continue
        const cy = rowCount - 1 - y
        if (!byKey.has(key)) byKey.set(key, [])
        byKey.get(key)!.push([dx, cy, dz])
        canopyRadius = Math.max(canopyRadius, Math.abs(dx), Math.abs(dz))
        cells += 1
      }
    }
  }

  /* Neighbour tests run against the WHOLE body, so the boundary between two
   * colours stays buried instead of being drawn from the inside. */
  const occupiedBuilt = (dx: number, cy: number, dz: number) => at(dx, rowCount - 1 - cy, dz) !== undefined

  const shells = [...byKey.entries()].map(([key, list]) => ({
    geometry: weldVoxelShell(list, occupiedBuilt, profile.cell),
    surface: profile.palette[key]!,
    cells: list.length,
  }))

  return {
    id,
    height: rowCount * profile.cell,
    canopyRadius: (canopyRadius + 0.5) * profile.cell,
    trunkRadius: profile.trunk,
    note: profile.note,
    shells,
    cells,
  }
}

const built = new Map<TreeSpeciesId, TreeSpecies>()

export function treeSpecies(id: TreeSpeciesId): TreeSpecies {
  let species = built.get(id)
  if (!species) {
    species = speciesFrom(id)
    built.set(id, species)
  }
  return species
}

/** Metrics only, for scatter spacing and navigation, without building geometry. */
export function treeMetrics(id: TreeSpeciesId) {
  const species = treeSpecies(id)
  return { height: species.height, canopyRadius: species.canopyRadius, trunkRadius: species.trunkRadius, note: species.note }
}

export type TreePlacement = {
  x: number
  z: number
  /** Uniform scale. 1 is the species' authored height. */
  scale: number
  yaw: number
  /** Trunk lean in radians. A wood with every trunk plumb reads as a diagram. */
  lean?: number
  /** Slight non-uniform width, so instances of one species are not clones. */
  squash?: number
  /** Multiplies the canopy colour: 0.88 to 1.12 covers a season's worth of variation. */
  tint?: number
}

export type TreeField = {
  group: THREE.Group
  stats: {
    /** One per species per colour. The honest draw-call cost of the whole forest. */
    meshes: number
    trees: number
    triangles: number
    bySpecies: Array<{ id: TreeSpeciesId; trees: number; cells: number; height: number }>
  }
  dispose: () => void
}

/**
 * Stamp every placement into one InstancedMesh per species per colour.
 *
 * The tint rides in the instance colour rather than in a material, which is what
 * keeps the variation free: a hundred differently-coloured oaks are still one
 * draw call.
 */
export function createTreeField(placements: Map<TreeSpeciesId, TreePlacement[]>): TreeField {
  const group = new THREE.Group()
  group.name = 'trees'
  const materials: THREE.Material[] = []
  const geometries: THREE.BufferGeometry[] = []
  let meshes = 0
  let triangles = 0
  let trees = 0
  const bySpecies: TreeField['stats']['bySpecies'] = []

  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const tint = new THREE.Color()

  for (const [id, list] of placements) {
    if (!list.length) continue
    const species = treeSpecies(id)
    trees += list.length
    bySpecies.push({ id, trees: list.length, cells: species.cells, height: species.height })
    for (const shell of species.shells) {
      const material = materialFor(shell.surface)
      materials.push(material)
      geometries.push(shell.geometry)
      const mesh = new THREE.InstancedMesh(shell.geometry, material, list.length)
      list.forEach((placement, index) => {
        const lean = placement.lean ?? 0
        const squash = placement.squash ?? 1
        euler.set(lean, placement.yaw, lean * 0.6)
        quaternion.setFromEuler(euler)
        position.set(placement.x, 0, placement.z)
        scale.set(placement.scale * squash, placement.scale, placement.scale / squash)
        matrix.compose(position, quaternion, scale)
        mesh.setMatrixAt(index, matrix)
        const shade = (placement.tint ?? 1) * shadeJitter(placement.x, index, placement.z)
        mesh.setColorAt(index, tint.setScalar(shade))
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.castShadow = !shell.surface.noShadow
      mesh.receiveShadow = !shell.surface.noShadow
      // A tall tree's bounding sphere has to cover the leaning, scaled instance,
      // or the whole species pops out of view when the camera looks up at it.
      mesh.frustumCulled = true
      group.add(mesh)
      meshes += 1
      triangles += ((shell.geometry.index?.count ?? 0) / 3) * list.length
    }
  }

  return {
    group,
    stats: { meshes, trees, triangles, bySpecies },
    dispose() {
      materials.forEach(material => material.dispose())
      geometries.forEach(geometry => geometry.dispose())
    },
  }
}
