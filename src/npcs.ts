import * as THREE from 'three'
import { createBatch, disposeMaterial } from './voxelBuild'
import type { Batch, Surface } from './voxelBuild'
import { emblemPlate, emblems, emblemSize, isEmblemId } from './emblems'
import type { EmblemId } from './emblems'
import { SHIELDED_NOTICE, buildingSpecs, serviceNpcs } from './townData'
import type { BuildingSpec, ServiceNpc } from './townData'

/* ------------------------------------------------------------------ *
 * Townsfolk.
 *
 * Same rendering technique as the player wizards — authored 2D pixel
 * grids extruded into cubes — but a deliberately different wardrobe.
 * The cone hat and floor-length robe silhouette belongs to the player;
 * everyone here wears work clothes, aprons, caps and tool belts, and
 * shows trousers or a skirt hem above their boots.
 *
 * The builder below is a local copy of the one in `characters.ts`.
 * That file is being rewritten concurrently and does not export its
 * internals, so duplicating ~40 lines is cheaper than coupling to a
 * moving target. Fold the two together once `characters.ts` settles.
 *
 * Palette keys shared by every design:
 *   F face   E eyes(glow)  K hair   S bare skin   Y gloves
 *   C top    c top shade   T trim   A apron   a apron shade
 *   P legs   O boots       G belt   L leather    W linen/paper
 *   Q cap    q cap shade   H hood   M metal      V glow
 * ------------------------------------------------------------------ */

const GRID = 18
const SPRITE_DEPTH = 5
/** Cubes overlap slightly. Anything under 1 leaves gaps you can see the sky through. */
const VOXEL_FILL = 1.02

const emissiveKeys = new Set(['E', 'V'])

type Palette = Record<string, string>

function materialFor(key: string, color: string) {
  if (emissiveKeys.has(key)) {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3 })
  }
  return new THREE.MeshStandardMaterial({ color, roughness: 0.84 })
}

/** Stable per-voxel brightness jitter, so cubes stay readable without physical gaps. */
function shadeJitter(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return 0.94 + (n - Math.floor(n)) * 0.12
}

/**
 * Extrude a pixel grid into instanced cubes.
 *
 * Interior cells are culled only in the middle depth layers; the front,
 * back and silhouette cells form a closed shell around that cavity.
 */
function buildSprite(rows: string[], palette: Palette, worldHeight: number) {
  const group = new THREE.Group()
  const height = rows.length
  const cell = worldHeight / height
  const geometry = new THREE.BoxGeometry(cell * VOXEL_FILL, cell * VOXEL_FILL, cell * VOXEL_FILL)
  const filled = (x: number, y: number) =>
    y >= 0 && y < height && x >= 0 && x < GRID && rows[y][x] !== '.' && palette[rows[y][x]] !== undefined

  const buckets = new Map<string, { matrices: THREE.Matrix4[]; shades: number[] }>()
  let reach = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < GRID; x++) {
      const key = rows[y][x]
      const color = palette[key]
      if (key === '.' || !color) continue
      const offsetX = (x - (GRID - 1) / 2) * cell
      reach = Math.max(reach, Math.abs(offsetX))
      const enclosed = filled(x - 1, y) && filled(x + 1, y) && filled(x, y - 1) && filled(x, y + 1)
      for (let z = 0; z < SPRITE_DEPTH; z++) {
        if (enclosed && z > 0 && z < SPRITE_DEPTH - 1) continue
        const matrix = new THREE.Matrix4().setPosition(
          offsetX,
          (height - 1 - y) * cell + cell / 2,
          (z - (SPRITE_DEPTH - 1) / 2) * cell,
        )
        const bucketKey = `${key}:${color}`
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, { matrices: [], shades: [] })
        const bucket = buckets.get(bucketKey)!
        bucket.matrices.push(matrix)
        bucket.shades.push(emissiveKeys.has(key) ? 1 : shadeJitter(x, y, z))
      }
    }
  }

  for (const [bucketKey, { matrices, shades }] of buckets) {
    const [key, color] = bucketKey.split(':')
    const mesh = new THREE.InstancedMesh(geometry, materialFor(key, color), matrices.length)
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix))
    mesh.instanceMatrix.needsUpdate = true
    const tint = new THREE.Color()
    shades.forEach((shade, index) => mesh.setColorAt(index, tint.setScalar(shade)))
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  group.userData.cell = cell
  group.userData.reach = reach
  return group
}

/** A short row silently shifts every voxel after it, so normalise and shout. */
function grid(name: string, rows: string[]) {
  return rows.map((row, index) => {
    if (row.length === GRID) return row
    console.error(`npc design "${name}" row ${index} is ${row.length} wide, expected ${GRID}`)
    return row.length > GRID ? row.slice(0, GRID) : row + '.'.repeat(GRID - row.length)
  })
}

/* ------------------------------------------------------------------ *
 * Shared colour vocabulary. Work clothes: canvas, wool, leather, ash.
 * Deliberately clear of the player robe colours (midnight, plum, moss,
 * ember, slate) so nobody reads as an off-brand wizard.
 * ------------------------------------------------------------------ */

const SKIN = { pale: '#d8b193', warm: '#c08a60', deep: '#8a5a3c', ruddy: '#c9926f' }
const DARK_BOOT = '#2a2119'

function base(extra: Palette): Palette {
  return {
    F: SKIN.warm,
    E: '#f7d98d',
    S: SKIN.warm,
    O: DARK_BOOT,
    G: '#5a4128',
    W: '#e5ddc8',
    M: '#a9a7a0',
    ...extra,
  }
}

type PropBuilder = (cell: number, reach: number, height: number) => THREE.Object3D

type NpcDesign = {
  rows: string[]
  /** World-space height in metres, feet to crown. Adults sit around 3.1–3.5. */
  height: number
  palette: Palette
  /** Drives the floating name label and the ground ring. */
  accent: string
  /** Forward tilt in radians, pivoting at the feet. Stoops and mid-stride leans. */
  lean?: number
  prop?: PropBuilder
}

/* ------------------------------------------------------------------ *
 * Props. Built from solid primitives, same spirit as the wizard staff.
 * Anything named `familiar` is picked up by animateCharacter() in
 * characters.ts and gets free bobbing, spin and wing flap.
 * ------------------------------------------------------------------ */

function solid(color: string, roughness = 0.8, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function glow(color: string, intensity = 1.8) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.25 })
}

function slab(parent: THREE.Object3D, size: [number, number, number], pos: [number, number, number], material: THREE.Material, rotation?: [number, number, number]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...pos)
  if (rotation) mesh.rotation.set(...rotation)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

/** Rolled route map tucked under the arm, plus a hovering waypoint marker. */
const guideProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const side = reach + cell * 1.4
  const paper = solid('#ded3b4', 0.9)
  slab(group, [cell * 1.6, cell * 1.6, cell * 7], [side, height * 0.44, cell * 1.2], paper, [0, 0, 0.1])
  slab(group, [cell * 1.9, cell * 1.9, cell * 1.2], [side, height * 0.44, cell * 4.4], solid('#8d6a43', 0.85), [0, 0, 0.1])

  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(cell * 1.7), glow('#7bc9ce', 1.7))
  familiar.add(marker)
  familiar.add(new THREE.PointLight('#7bc9ce', 0.8, 3))
  familiar.position.set(-(reach + cell * 2.2), height * 0.82, cell * 2.4)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Quill behind the ear and a slowly turning open ledger. */
const archivistProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  slab(group, [cell * 0.5, cell * 3.2, cell * 0.5], [reach * 0.55, height * 0.86, cell * 2.4], solid('#e8e2cd', 0.9), [0.35, 0, 0.5])

  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  for (const dir of [-1, 1]) {
    slab(familiar, [cell * 2.4, cell * 0.5, cell * 3], [dir * cell * 1.3, 0, 0], solid('#efe7cf', 0.9), [0, 0, dir * 0.22])
  }
  slab(familiar, [cell * 0.8, cell * 0.9, cell * 3], [0, -cell * 0.3, 0], solid('#6d3f4a', 0.85))
  const page = new THREE.Mesh(new THREE.BoxGeometry(cell * 4.6, cell * 0.2, cell * 2.4), glow('#d5a64b', 1.1))
  page.position.y = cell * 0.35
  familiar.add(page)
  familiar.position.set(-(reach + cell * 2.4), height * 0.78, cell * 3)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Two-pan coin balance held out to one side. */
const merchantProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const brass = solid('#c79a48', 0.35, 0.65)
  const side = reach + cell * 2.2
  const beamY = height * 0.58
  slab(group, [cell * 0.7, cell * 5, cell * 0.7], [side, height * 0.44, cell * 2.6], brass)
  slab(group, [cell * 6.4, cell * 0.6, cell * 0.6], [side, beamY, cell * 2.6], brass)
  for (const dir of [-1, 1]) {
    const panX = side + dir * cell * 2.9
    const panY = beamY - cell * 2.2
    slab(group, [cell * 0.3, cell * 2.2, cell * 0.3], [panX, beamY - cell * 1.1, cell * 2.6], brass)
    slab(group, [cell * 2.4, cell * 0.5, cell * 2.4], [panX, panY, cell * 2.6], brass)
    slab(group, [cell * 1.2, cell * 0.4, cell * 1.2], [panX, panY + cell * 0.45, cell * 2.6], glow('#f0b84d', 0.9))
  }
  return group
}

/** Rack of stoppered vials on the hip and a bubbling flask at the shoulder. */
const alchemistProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const rackX = -(reach + cell * 1.5)
  slab(group, [cell * 4.6, cell * 0.7, cell * 1.6], [rackX, height * 0.42, cell * 2.6], solid('#4a3a2c', 0.9))
  ;['#8fe0a6', '#e0708f', '#7bc9ce'].forEach((color, index) => {
    slab(group, [cell * 1, cell * 2.4, cell * 1], [rackX + (index - 1) * cell * 1.5, height * 0.48, cell * 2.6], glow(color, 1.3))
  })

  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  slab(familiar, [cell * 2.4, cell * 2.4, cell * 2.4], [0, 0, 0], glow('#8fe0a6', 1.5))
  slab(familiar, [cell * 1, cell * 1.6, cell * 1], [0, cell * 1.9, 0], solid('#c9c2ad', 0.4))
  slab(familiar, [cell * 0.7, cell * 0.7, cell * 0.7], [0, cell * 3, 0], glow('#8fe0a6', 2.2))
  familiar.add(new THREE.PointLight('#8fe0a6', 0.9, 3))
  familiar.position.set(reach + cell * 2.4, height * 0.8, cell * 2.8)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Heavy cross-peen hammer resting head-up, and a forge ember drifting nearby. */
const smithProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const side = reach + cell * 1.6
  slab(group, [cell * 1.2, cell * 6.5, cell * 1.2], [side, height * 0.3, cell * 2.6], solid('#6b4d36', 0.9), [0, 0, -0.12])
  slab(group, [cell * 4.6, cell * 2.4, cell * 2.4], [side + cell * 0.6, height * 0.52, cell * 2.6], solid('#4e5157', 0.45, 0.6))
  slab(group, [cell * 1, cell * 2.6, cell * 2.6], [side + cell * 3, height * 0.52, cell * 2.6], solid('#7c7f86', 0.4, 0.7))

  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  slab(familiar, [cell * 1.1, cell * 1.1, cell * 1.1], [0, 0, 0], glow('#ff8a3d', 2.6))
  slab(familiar, [cell * 0.6, cell * 0.6, cell * 0.6], [cell * 1.4, cell * 0.9, 0], glow('#ffc06a', 2.2))
  familiar.add(new THREE.PointLight('#ff8a3d', 1.2, 3.4))
  familiar.position.set(-(reach + cell * 2), height * 0.7, cell * 3)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Parcel under the arm and a sealed letter flapping alongside. */
const courierProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const side = reach + cell * 1.5
  slab(group, [cell * 3.4, cell * 2.6, cell * 3], [side, height * 0.46, cell * 1.8], solid('#b79a70', 0.9))
  slab(group, [cell * 3.6, cell * 0.5, cell * 3.2], [side, height * 0.46, cell * 1.8], solid('#6d4f36', 0.85))

  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  slab(familiar, [cell * 2.6, cell * 1.8, cell * 0.5], [0, 0, 0], solid('#ede4cc', 0.9))
  slab(familiar, [cell * 0.9, cell * 0.9, cell * 0.7], [0, 0, cell * 0.3], glow('#c2543f', 0.8))
  const wings: THREE.Object3D[] = []
  for (const dir of [-1, 1]) {
    const pivot = new THREE.Group()
    slab(pivot, [cell * 2, cell * 1.4, cell * 0.3], [dir * cell * 1.6, cell * 0.4, -cell * 0.3], solid('#f6f1e0', 0.85))
    familiar.add(pivot)
    wings.push(pivot)
  }
  familiar.userData.wings = wings
  familiar.position.set(-(reach + cell * 2.3), height * 0.84, cell * 2.6)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Brass armillary orbiting at the shoulder. */
const orreryProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  const brass = solid('#c79a48', 0.35, 0.7)
  const radius = cell * 2.6
  const rings: Array<[number, number, number]> = [
    [Math.PI / 2, 0, 0],
    [0, 0, 0],
    [Math.PI / 2, 0, Math.PI / 3],
  ]
  for (const rotation of rings) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, cell * 0.28, 4, 14), brass)
    ring.rotation.set(...rotation)
    ring.castShadow = true
    familiar.add(ring)
  }
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(cell * 1, 0), glow('#f0b84d', 2.2))
  familiar.add(core)
  const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(cell * 0.5, 0), glow('#9ad7db', 1.6))
  moon.position.set(radius, 0, 0)
  familiar.add(moon)
  familiar.add(new THREE.PointLight('#f0b84d', 0.9, 3.6))
  familiar.position.set(reach + cell * 3, height * 0.76, cell * 2.8)
  familiar.userData.restY = familiar.position.y
  group.add(familiar)
  return group
}

/** Serving tray carried flat, two mugs and a curl of steam. */
const innkeeperProp: PropBuilder = (cell, reach, height) => {
  const group = new THREE.Group()
  // Carried clear of the apron: any closer and the tray disappears into her front.
  const trayY = height * 0.64
  const trayZ = cell * 6.4
  // Pewter, not wood: a brown tray vanishes against a brown dress.
  slab(group, [cell * 6.8, cell * 0.7, cell * 4.4], [reach * 0.35, trayY, trayZ], solid('#a9a49a', 0.5, 0.3))
  for (const dir of [-1, 1]) {
    const mugX = reach * 0.35 + dir * cell * 1.9
    slab(group, [cell * 1.8, cell * 2.2, cell * 1.8], [mugX, trayY + cell * 1.4, trayZ], solid('#43342a', 0.85))
    slab(group, [cell * 1.5, cell * 0.5, cell * 1.5], [mugX, trayY + cell * 2.5, trayZ], glow('#e8c079', 0.8))
  }
  for (let i = 0; i < 3; i++) {
    slab(
      group,
      [cell * 0.7, cell * 0.7, cell * 0.7],
      [reach * 0.35 + (i - 1) * cell * 0.9, trayY + cell * (3.2 + i * 0.8), trayZ],
      new THREE.MeshStandardMaterial({ color: '#e8e4d6', transparent: true, opacity: 0.45, roughness: 1 }),
    )
  }
  return group
}

/* ------------------------------------------------------------------ *
 * The eight named service NPCs. Silhouette first: read the outline and
 * you should already know the trade.
 * ------------------------------------------------------------------ */

const namedDesigns: Record<string, NpcDesign> = {
  // Lean and upright, broad flat ranger brim, short travel cape, mid-stride.
  MIRA: {
    height: 3.3,
    accent: '#7bc9ce',
    prop: guideProp,
    rows: grid('MIRA', [
      '......QQQQQQ......',
      '.....QQQQQQQQ.....',
      '...QQQQQQQQQQQQ...',
      '...qqqqqqqqqqqq...',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....TTTTTTTT.....',
      '....CCCCCCCCCC....',
      '...CCCCCCCCCCCC...',
      '..LCCCCCCCCCCCCS..',
      '..LCCCCCCCCCCCCS..',
      '...CCCCCCCCCCCC...',
      '....GGGGGGGGGG....',
      '.....PPPPPPPP.....',
      '.....PPPPPPPP.....',
      '.....PPP..PPP.....',
      '....PPP....PPP....',
      '....OOO....OOO....',
    ]),
    palette: base({
      Q: '#4f6b55', q: '#33463a', T: '#c2543f',
      C: '#6f7b5c', c: '#4a5340', L: '#6d4f36',
      P: '#6a5b45', G: '#4a3524',
    }),
  },

  // Stooped, head pushed forward, spectacles, arms full of books, long smock.
  LYRA: {
    height: 2.95,
    accent: '#9ad7db',
    lean: 0.13,
    prop: archivistProp,
    rows: grid('LYRA', [
      '......KKKKKK......',
      '.....KKKKKKKK.....',
      '....KKFFFFFFK.....',
      '....KKFEFFEFK.....',
      '.....KFFFFFF......',
      '......TTTTTT......',
      '....CCCCCCCCCC....',
      '...CCCCCCCCCCCC...',
      '..SCCCCCCCCCCCS...',
      '..SWWWWWWWWWWS....',
      '..SWWWWWWWWWWS....',
      '...TTTTTTTTTT.....',
      '...CCCCCCCCCC.....',
      '...CGGGGGGGGC.....',
      '...CCCCCCCCCC.....',
      '..CCCCCCCCCCCC....',
      '..cccccccccccc....',
      '....OOO..OOO......',
    ]),
    palette: base({
      F: SKIN.pale, S: SKIN.pale, K: '#b9b2a4', E: '#cfe8ea',
      C: '#57607a', c: '#3a4155', T: '#8e96ad',
      W: '#c8b88f', G: '#4b4438',
    }),
  },

  // Comfortable middle, buttoned waistcoat, flat merchant cap, coin balance.
  VELLUM: {
    height: 3.15,
    accent: '#d5a64b',
    prop: merchantProp,
    rows: grid('VELLUM', [
      '.....QQQQQQQQ.....',
      '....QQQQQQQQQQ....',
      '....qqqqqqqqqq....',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....WWWWWWWW.....',
      '....CCCCTTCCCC....',
      '...CCCCCTTCCCCC...',
      '..SCCCCCTTCCCCCS..',
      '..SCCCCCTTCCCCCS..',
      '...CCCCCTTCCCC....',
      '...CGGGGGGGGGGC...',
      '...CCCCCCCCCCCC...',
      '....PPPPPPPPPP....',
      '....PPPP..PPPP....',
      '....PPP....PPP....',
      '...OOOO....OOOO...',
    ]),
    palette: base({
      F: SKIN.ruddy, S: SKIN.ruddy,
      Q: '#5c3f52', q: '#3d2937',
      C: '#7a4f5f', c: '#523440', T: '#d5a64b',
      P: '#3f3a44', G: '#2f2a22',
    }),
  },

  // Wiry, goggles shoved up on the forehead, gloves, vial-loop apron.
  SABLE: {
    height: 3.05,
    accent: '#8fe0a6',
    prop: alchemistProp,
    rows: grid('SABLE', [
      '......KKKKKK......',
      '.....MMMMMMMM.....',
      '.....MVMMMMVM.....',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....TTTTTTTT.....',
      '....CCCCCCCCCC....',
      '...CCCCCCCCCCCC...',
      '..YCCAAAAAACCCY...',
      '..YCAAAAAAAACY....',
      '...AAVAAAAVAAA....',
      '...AAVAAAAVAAA....',
      '...AGGGGGGGGGA....',
      '...AAAAAAAAAAA....',
      '....AAAAAAAA......',
      '....PPPP..PPP.....',
      '....OOO....OOO....',
    ]),
    palette: base({
      F: SKIN.deep, S: SKIN.deep, K: '#2f2722',
      M: '#8a6a3f', V: '#8fe0a6',
      T: '#2d3a34', C: '#4c6b62', c: '#32473f',
      A: '#c9c0a3', a: '#a79b7c', Y: '#5d4a34',
      P: '#3b4440', G: '#4b3a26',
    }),
  },

  // The widest silhouette in town. Bare arms, thick leather apron, no hat.
  BRONZE: {
    height: 3.45,
    accent: '#ff8a3d',
    prop: smithProp,
    rows: grid('BRONZE', [
      '.....TTTTTTTT.....',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....FFFFFFFF.....',
      '..CCCCCCCCCCCCCC..',
      '.CCCCCCCCCCCCCCCC.',
      '.SSCCAAAAAAAACCSS.',
      '.SSCCAAAAAAAACCSS.',
      '.SS.AAAAAAAAAA.SS.',
      '..S.AAAAAAAAAA.S..',
      '....AAAAAAAAAA....',
      '....AGGGGGGGGA....',
      '....AAAAAAAAAA....',
      '...AAAAAAAAAAAA...',
      '..PPPPP....PPPPP..',
      '..PPPP......PPPP..',
      '.OOOOO......OOOOO.',
    ]),
    palette: base({
      // Bare arms have to read against the apron, so the leather goes dark and
      // the skin and shirt stay light. Brown on brown turned him into one lump.
      F: '#c08a60', S: '#c08a60',
      T: '#b8452f', C: '#5d6b74', c: '#3d474e',
      A: '#43281a', a: '#2c190e', G: '#7a5a2e',
      P: '#444d54', O: '#211a14',
    }),
  },

  // Small, light, leaning into the next delivery. Bill cap, hip satchel.
  PIP: {
    height: 2.8,
    accent: '#9580b8',
    lean: 0.1,
    prop: courierProp,
    rows: grid('PIP', [
      '......QQQQQQQ.....',
      '.....QQQQQQQQQ....',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '....TTTTTTTT......',
      '......CCCCCC......',
      '.....CCCCCCCC.....',
      '....LCCCCCCCCS....',
      '...LLLCCCCCCS.....',
      '..LLLLLLCCCC......',
      '..LLLLLLGGGG......',
      '...LLLLCCCCC......',
      '.....PPPPPP.......',
      '....PPP..PPP......',
      '...PPP.....PP.....',
      '..OOO.......OOO...',
    ]),
    palette: base({
      F: SKIN.pale, S: SKIN.pale,
      Q: '#4a4470', q: '#302c4c', T: '#c48a4a',
      C: '#61578f', c: '#413a63',
      L: '#7a5a38', P: '#3d3a4a', G: '#4d3f2a',
    }),
  },

  // Tall and narrow, brass circlet, high-collared longcoat over trousers.
  ASTRA: {
    height: 3.5,
    accent: '#f0b84d',
    prop: orreryProp,
    rows: grid('ASTRA', [
      '.....MMMMMMMM.....',
      '......KKKKKK......',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....TTTTTTTT.....',
      '....TTCCCCCCTT....',
      '....CCCCCCCCCC....',
      '...CCCCTTCCCCCC...',
      '..SCCCTTCCCCCCS...',
      '..SCCTTCCCCCCCS...',
      '...CTTCCCCCCCC....',
      '...CGGGGGGGGGC....',
      '....CCCCCCCCCC....',
      '....CCCCCCCCCC....',
      '....CCCCCCCCCC....',
      '...cccccccccccc...',
      '....PPPP..PPPP....',
      '....OOO....OOO....',
    ]),
    palette: base({
      F: SKIN.warm, S: SKIN.warm, K: '#4a3b2e',
      M: '#c79a48',
      C: '#3f5570', c: '#2a3a4e', T: '#c9a86a',
      P: '#4a4640', G: '#7b6236',
    }),
  },

  // Round and low-slung, kerchief, apron over a full skirt, tray forward.
  NELL: {
    height: 2.9,
    accent: '#e6a15a',
    prop: innkeeperProp,
    rows: grid('NELL', [
      '.....TTTTTTTT.....',
      '....TKKKKKKKKT....',
      '......FFFFFF......',
      '......FEFFEF......',
      '......FFFFFF......',
      '.....WWWWWWWW.....',
      '...CCCCCCCCCCCC...',
      '..CCCCCCCCCCCCCC..',
      '.SCCCCAAAAAACCCCS.',
      '.SCCCAAAAAAAACCCS.',
      '.SCCAAAAAAAAAACCS.',
      '..CCAAAAAAAAAACC..',
      '..CCAGGGGGGGGACC..',
      '..CCCAAAAAAAACCC..',
      '...CCCAAAAAACCC...',
      '...CCCCCCCCCCCC...',
      '...cccccccccccc...',
      '.....OOO..OOO.....',
    ]),
    palette: base({
      F: SKIN.ruddy, S: SKIN.ruddy, K: '#7a4a2c',
      T: '#c2543f', W: '#efe7d2',
      C: '#8a5a3f', c: '#5d3b28',
      A: '#ded3b4', G: '#4f3a22',
    }),
  },
}

/** `MIRA · GUIDE` and `MIRA` both resolve to the MIRA design. */
function designFor(name: string): NpcDesign {
  const key = name.split('·')[0].trim().toUpperCase()
  const named = namedDesigns[key]
  // Every townsperson in the world is now one of the eight named service
  // posts; the generic wardrobe that unnamed residents used to fall back to is
  // gone with them. Returning a blank design instead of raising would put an
  // invisible, unclickable service NPC on their pitch, which is the failure
  // that is hardest to notice and worst to live with.
  if (!named) throw new Error(`No NPC design for "${name}"`)
  return named
}

/** Label and ground-ring colour for an NPC, so markers match the model. */
export function npcAccent(name: string) {
  return designFor(name).accent
}

/**
 * Build a townsperson. Height comes from the design, not the caller, because
 * varied stature is most of what distinguishes one post from the next.
 */
export function createTownsfolk(name: string, scale = 1) {
  const key = name.split('·')[0].trim().toUpperCase()
  const design = designFor(name)
  const root = new THREE.Group()
  root.scale.setScalar(scale)
  root.userData.npcDesign = key

  const sprite = buildSprite(design.rows, design.palette, design.height)
  if (design.lean) sprite.rotation.x = design.lean
  root.add(sprite)

  const cell = sprite.userData.cell as number
  const reach = sprite.userData.reach as number
  if (design.prop) root.add(design.prop(cell, reach, design.height))

  root.userData.cell = cell
  // World height, feet to crown, after the caller's scale. Nameplates ride on it.
  root.userData.height = design.height * scale
  return root
}

/* ------------------------------------------------------------------ *
 * Nameplates.
 *
 * makeLabel() sizes its sprite in world units and createNpc() parents the
 * label to the NPC group, so the label inherits whatever scale that group
 * carries. Both numbers below are therefore divided by the group scale:
 * a nameplate must be the same size in the world whether it is floating
 * over a 2.3m child or a 3.5m orrery keeper.
 * ------------------------------------------------------------------ */

/** Narrower than the 3.6-unit building signs, so a person never outshouts a shop. */
const LABEL_WIDTH = 2.4
/** makeLabel draws into a 256x64 canvas; keep that aspect or the text stretches. */
const LABEL_ASPECT = 64 / 256
/** Clearance between the crown of the head and the bottom of the plate. */
const LABEL_GAP = 0.5

/**
 * Size and position an NPC nameplate, then parent it. Height comes from the
 * model rather than a fixed offset, because these designs are not one height.
 */
export function placeNpcLabel(npc: THREE.Object3D, label: THREE.Object3D) {
  const groupScale = npc.scale.x || 1
  const height = (npc.userData.height as number | undefined) ?? 3.2
  label.scale.set(LABEL_WIDTH / groupScale, (LABEL_WIDTH * LABEL_ASPECT) / groupScale, 1)
  label.position.set(0, (height + LABEL_GAP) / groupScale, 0)
  npc.add(label)
}

/* ------------------------------------------------------------------ *
 * Trade emblems, on the premises.
 *
 * Every emblem in src/emblems.ts was authored and then had nowhere to
 * hang, because the module that was going to mount them never exported
 * anything. This section mounts them, off the same townData rows the
 * world map already draws, so a player walking up to a building can see
 * what is sold there before anyone speaks:
 *
 *   - a framed board on the premises each service NPC works from, on
 *     whichever wall faces that NPC, centred on that wall and sat just
 *     above the door head so it reads from across the street; and
 *   - a standard planted beside the NPC, which is the close read at
 *     walking height.
 *
 * Buildings are 13–52m tall, so a badge tucked under the eaves is a
 * badge nobody looks at. Both mounts are therefore held down at the
 * height of the person standing next to them, and sized in metres
 * rather than as a fraction of the wall: the board is the same 2.8m
 * whether it hangs on the Post Office or the Observatory.
 *
 * Everything here is welded through one Batch, so the whole set — eight
 * boards, eight standards, every frame, batten and pole — is a handful
 * of draw calls rather than one per box.
 *
 * ---- the third-party mark -----------------------------------------
 *
 * A service carrying an `integrates` id in src/townData.ts gets a
 * SECOND, separately framed panel on the same board, holding that
 * external network's mark, captioned with SHIELDED_NOTICE.markCaption,
 * over the service's own `status` lines along the foot of the board.
 *
 * That layout is the point, not decoration. The mark names WHICH network
 * the desk would talk to. It is not a claim that the desk works, and
 * Sable's does not: nothing in this project can sign a Zcash
 * transaction, so no shielded transfer can be sent. So the mark never
 * travels alone — it is never merged into the shop's own badge, it is
 * kept off the standard beside her, and it cannot be hung without the
 * status lines under it, because one function draws both from one
 * record. Take the notice away and the mark loses its frame with it.
 * ------------------------------------------------------------------ */

const BOARD_TIMBER: Surface = { color: '#4b4037', roughness: 0.92 }
const BOARD_BATTEN: Surface = { color: '#6b5544', roughness: 0.9 }
const BOARD_RECESS: Surface = { color: '#20252d', roughness: 0.9 }
const BOARD_IRON: Surface = { color: '#272b30', roughness: 0.6, metalness: 0.35 }
const BOARD_STONE: Surface = { color: '#4a5257', roughness: 0.94 }
const BOARD_STONE_PALE: Surface = { color: '#68777b', roughness: 0.92 }

/** Bottom of every premises board. Clear of the 2.86m door head under it. */
const BOARD_FOOT = 3.2

/** A wall to mount on: which way it looks, how wide it is, and where its face is. */
type Mount = {
  yaw: number
  /** Outward normal in world x/z. */
  nx: number
  nz: number
  /** Width of this wall, so a board can be kept inside it. */
  span: number
  /** Board-local (sideways, absolute height, outward) to world. */
  at: (along: number, up: number, out: number) => [number, number, number]
}

/**
 * The wall of `spec` that looks at (`towardX`, `towardZ`).
 *
 * Service NPCs stand off a corner of their premises — seven of the eight are
 * at a dead 7m diagonal — so the two candidate walls are usually within a
 * metre of each other. Ties go to the z wall, which is the axis createBuilding
 * puts the door, the sign and the window band on.
 */
function wallMount(spec: BuildingSpec, towardX: number, towardZ: number): Mount {
  const dx = towardX - spec.x
  const dz = towardZ - spec.z
  const onZ = Math.abs(dz) + 1 >= Math.abs(dx)
  const nx = onZ ? 0 : Math.sign(dx) || 1
  const nz = onZ ? Math.sign(dz) || -1 : 0
  // faceYaw 0 faces −z, so the plate normal is (−sin yaw, −cos yaw).
  const yaw = Math.atan2(-nx, -nz)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const ox = spec.x + nx * (spec.width / 2)
  const oz = spec.z + nz * (spec.depth / 2)
  return {
    yaw,
    nx,
    nz,
    span: nx === 0 ? spec.width : spec.depth,
    at: (along, up, out) => [ox + along * cos + nx * out, up, oz - along * sin + nz * out],
  }
}

/**
 * How high a board may reach on a given wall before it fouls something.
 *
 * createBuilding hangs a pair of posts on the front wall centred at
 * height*0.55, and an awning and a shelf above those. The other three walls
 * are blank brick to the eaves, so a board there only has to stay off the roof.
 */
function wallCeiling(spec: BuildingSpec, mount: Mount) {
  return mount.nz < 0 ? spec.height * 0.55 - 1.15 : spec.height * 0.86
}

/**
 * Sign copy, drawn to a canvas and hung flat on a board.
 *
 * The emblems are cubes, but prose is not: a status notice spelled out in
 * voxels needs a glyph set this project does not have, and at the size it
 * would have to be to stay legible it would swamp the mark it qualifies. So
 * the words are a texture — the same trick makeLabel() already uses for the
 * building signs — on an unlit material, so a notice stays readable at dusk.
 *
 * The caller owns the result and must dispose it; disposeMaterial() frees the
 * canvas texture with the material, which is the half this project has
 * forgotten three times.
 */
function signText(
  lines: string[],
  size: [number, number],
  options: { accent: string; leadRows?: number },
) {
  const [worldWidth, worldHeight] = size
  const px = Math.max(96, Math.min(1024, Math.round(worldWidth * 240)))
  const py = Math.max(32, Math.round((px * worldHeight) / worldWidth))
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = py
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#101923f2'
  ctx.fillRect(0, 0, px, py)
  const stroke = Math.max(2, Math.round(py * 0.05))
  ctx.strokeStyle = options.accent
  ctx.lineWidth = stroke
  ctx.strokeRect(stroke / 2, stroke / 2, px - stroke, py - stroke)
  // Fit to the longest line as measured, not to a guess at monospace advance:
  // one over-long status line silently clipped is how a notice stops being one.
  const rowPx = py / lines.length
  ctx.font = '700 100px monospace'
  const widest = Math.max(...lines.map(line => ctx.measureText(line).width))
  const fontPx = Math.floor(Math.min(rowPx * 0.62, (100 * (px - stroke * 4)) / widest))
  ctx.font = `700 ${fontPx}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const leadRows = options.leadRows ?? 0
  lines.forEach((line, index) => {
    ctx.fillStyle = index < leadRows ? options.accent : '#e5ddc8'
    ctx.fillText(line, px / 2, rowPx * (index + 0.5))
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldHeight),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  )
  mesh.name = 'sign-text'
  return mesh
}

type BoardPlan = {
  trade: EmblemId
  tradeCaption: string
  accent: string
  /** An external network's mark, and the words that have to travel with it. */
  mark?: { emblem: EmblemId; caption: string; status: string[] }
}

/* Board layout, in metres, before it is scaled to fit its wall. Two shapes:
 * a plain trade board, and a wider one with a second framed panel for a
 * third-party mark and a status strip along the foot. */
const PAD = 0.26
const GAP = 0.14
const CAPTION = 0.32
const TRADE_ART = 1.7
/**
 * The third-party mark is sized larger than the trade badge because most of it
 * is coin: rim and ring take three of its eleven-and-a-half cell radius, so at
 * 2.2m the Ⓩ inside comes out about 1.43m — a shade under the 1.5m trade badge
 * beside it. The devices read as equals, which is the point. Sizing the two
 * discs equal instead would leave somebody else's mark shouting over the
 * shop's own.
 */
const MARK_ART = 2.2
const MULLION = 0.22
const STATUS = 0.95

/** A framed board on a wall, carrying one trade emblem and maybe one mark. */
function premisesBoard(batch: Batch, mount: Mount, ceiling: number, plan: BoardPlan) {
  const texts: THREE.Mesh[] = []
  const tradeCell = (plan.mark ? 1.5 : TRADE_ART) / emblems[plan.trade].rows.length
  const trade = emblemSize(plan.trade, tradeCell)
  const mark = plan.mark ? emblemSize(plan.mark.emblem, MARK_ART / emblems[plan.mark.emblem].rows.length) : null
  const markCell = plan.mark ? MARK_ART / emblems[plan.mark.emblem].rows.length : 0

  // Height first, because the wall decides whether any of this fits.
  const tradeColumn = trade.height + GAP + CAPTION
  const rowHeight = mark ? Math.max(CAPTION + GAP + mark.height, tradeColumn) : tradeColumn
  const boardHeight = mark
    ? PAD + rowHeight + GAP + STATUS + PAD
    : PAD + rowHeight + PAD
  const tradePanel = trade.width + 0.5
  const markPanel = mark ? mark.width + 0.5 : 0
  const boardWidth = mark
    ? PAD * 2 + tradePanel + MULLION + markPanel
    : trade.width + 0.7

  // One scale for the whole board, so a tight wall shrinks the art rather than
  // cropping it. Every premises in townData clears this at 1.
  const fit = Math.min(1, (ceiling - BOARD_FOOT) / boardHeight, (mount.span - 1.6) / boardWidth)
  const centreY = BOARD_FOOT + (boardHeight * fit) / 2
  const at = (along: number, up: number, out: number) => mount.at(along * fit, centreY + up * fit, out * fit)
  const box = (size: [number, number, number], along: number, up: number, out: number, surface: Surface) =>
    batch.box([size[0] * fit, size[1] * fit, size[2] * fit], at(along, up, out), surface, { rotY: mount.yaw })

  // Plank flush to the wall, then battens round it and a recess per panel, so
  // the badge sits in shadow instead of floating on a brown rectangle.
  box([boardWidth, boardHeight, 0.16], 0, 0, 0.08, BOARD_TIMBER)
  for (const side of [-1, 1]) {
    box([boardWidth + 0.16, 0.16, 0.26], 0, (side * boardHeight) / 2, 0.13, BOARD_BATTEN)
    box([0.16, boardHeight + 0.16, 0.26], (side * boardWidth) / 2, 0, 0.13, BOARD_BATTEN)
  }

  const top = boardHeight / 2 - PAD
  const rowMid = top - rowHeight / 2
  const plate = (id: EmblemId, cell: number, along: number, up: number) =>
    batch.plate(emblemPlate(id, at(along, up, 0.23 + cell), cell * fit, { faceYaw: mount.yaw, depth: 2 }))
  const text = (lines: string[], width: number, height: number, along: number, up: number, accent: string, leadRows?: number) => {
    const mesh = signText(lines, [width * fit, height * fit], { accent, leadRows })
    mesh.position.set(...at(along, up, 0.24))
    mesh.rotation.y = Math.atan2(mount.nx, mount.nz)
    texts.push(mesh)
    return mesh
  }

  if (!mark || !plan.mark) {
    box([trade.width + 0.44, rowHeight, 0.07], 0, rowMid, 0.195, BOARD_RECESS)
    plate(plan.trade, tradeCell, 0, top - trade.height / 2)
    text([plan.tradeCaption], trade.width + 0.24, CAPTION, 0, top - trade.height - GAP - CAPTION / 2, plan.accent)
    return { texts, width: boardWidth * fit, height: boardHeight * fit, top: BOARD_FOOT + boardHeight * fit }
  }

  // Two panels, divided by a mullion: the shop's own badge and, beside it and
  // never inside the same frame, the external mark it would talk to.
  const left = -boardWidth / 2 + PAD
  const tradeX = left + tradePanel / 2
  const markX = left + tradePanel + MULLION + markPanel / 2
  box([tradePanel - 0.12, rowHeight, 0.07], tradeX, rowMid, 0.195, BOARD_RECESS)
  box([markPanel - 0.12, rowHeight, 0.07], markX, rowMid, 0.195, BOARD_RECESS)
  box([MULLION, rowHeight + 0.12, 0.26], left + tradePanel + MULLION / 2, rowMid, 0.13, BOARD_BATTEN)

  const tradeTop = rowMid + tradeColumn / 2
  plate(plan.trade, tradeCell, tradeX, tradeTop - trade.height / 2)
  text([plan.tradeCaption], tradePanel - 0.3, CAPTION, tradeX, tradeTop - trade.height - GAP - CAPTION / 2, plan.accent)

  // Caption above the mark, status below the board: the mark is bracketed by
  // what it means and where the service actually stands.
  text([plan.mark.caption], markPanel - 0.3, CAPTION, markX, top - CAPTION / 2, '#d5a64b')
  plate(plan.mark.emblem, markCell, markX, top - CAPTION - GAP - mark.height / 2)
  text(
    ['SERVICE STATUS', ...plan.mark.status],
    boardWidth - PAD * 2,
    STATUS,
    0,
    top - rowHeight - GAP - STATUS / 2,
    '#e37c42',
    1,
  )
  return { texts, width: boardWidth * fit, height: boardHeight * fit, top: BOARD_FOOT + boardHeight * fit }
}

/**
 * A standard planted beside a service NPC: a stone foot, a pole, a crossbar
 * and the trade emblem on a board at head height. Harvested from the unbuilt
 * helper in src/townArt.ts, which nothing has ever imported.
 *
 * The pole is 0.2m and is deliberately not a navigation obstacle, for the same
 * reason the NPCs themselves are not: a body-width post on the plaza that
 * click-to-move has to route around would make the fountain kerb a maze.
 */
function npcStandard(batch: Batch, at: [number, number], yaw: number, emblem: EmblemId, accent: Surface) {
  const [x, z] = at
  const height = 3.4
  const cell = 0.14
  const { width, height: artHeight } = emblemSize(emblem, cell)
  batch.box([0.5, 0.3, 0.5], [x, 0.15, z], BOARD_STONE)
  batch.box([0.34, 0.24, 0.34], [x, 0.36, z], BOARD_STONE_PALE)
  batch.box([0.2, height, 0.2], [x, height / 2 + 0.3, z], BOARD_IRON)
  batch.box([width + 0.9, 0.16, 0.16], [x, height + 0.26, z], BOARD_IRON, { rotY: yaw })
  batch.box([0.42, 0.42, 0.42], [x, height + 0.55, z], accent, { rotY: 0.78, rotZ: 0.62 })
  for (const side of [-1, 1]) {
    const along = side * width * 0.34
    batch.box([0.1, 0.42, 0.1], [x + Math.cos(yaw) * along, height + 0.02, z - Math.sin(yaw) * along], BOARD_IRON)
  }
  // The board rides 0.06 forward of the pole rather than centred on it: at
  // equal depth the 0.2m pole shows through the gaps between emblem cells.
  const boardY = height - artHeight / 2 - 0.34
  const out = (distance: number): [number, number, number] => [
    x - Math.sin(yaw) * distance,
    boardY,
    z - Math.cos(yaw) * distance,
  ]
  batch.box([width + 0.4, artHeight + 0.4, 0.18], out(0.06), BOARD_TIMBER, { rotY: yaw })
  batch.plate(emblemPlate(emblem, out(0.2), cell, { faceYaw: yaw, depth: 2 }))
}

/** How far a service NPC may stand from the premises it works out of. */
const PREMISES_REACH = 14

/**
 * Which building a service NPC works from, by proximity.
 *
 * Deliberately derived rather than declared: seven of the eight stand exactly
 * 9.9m off a corner of their own shop, and the nearest building is the one the
 * map already implies. Mira is the eighth — she works the fountain, not a shop,
 * and the nearest roof is 17m away, so she gets a standard and no board.
 */
function premisesFor(npc: ServiceNpc) {
  let best: BuildingSpec | null = null
  let bestDistance = PREMISES_REACH * PREMISES_REACH
  for (const spec of buildingSpecs) {
    const distance = (spec.x - npc.x) ** 2 + (spec.z - npc.z) ** 2
    if (distance < bestDistance) {
      best = spec
      bestDistance = distance
    }
  }
  return best
}

/**
 * Every service emblem in the town, as one welded body.
 *
 * Add the returned group to the scene; it frees its own geometry, materials and
 * sign textures when it is removed from the graph, and `userData.dispose` is
 * the same teardown for a caller that would rather run it by hand.
 */
export function createServiceEmblems() {
  const group = new THREE.Group()
  group.name = 'service-emblems'
  const batch = createBatch()
  const texts: THREE.Mesh[] = []

  for (const npc of serviceNpcs) {
    if (!isEmblemId(npc.emblem)) {
      console.error(`service npc "${npc.name}" has no emblem named ${npc.emblem}`)
      continue
    }
    const trade = npc.emblem
    const premises = premisesFor(npc)
    // The standard looks the same way the board does, so whoever can read one
    // can read the other. Mira has no premises, so hers faces +z, which is the
    // way every named NPC is built to stand.
    const mount = premises ? wallMount(premises, npc.x, npc.z) : null
    const facing = mount ? { nx: mount.nx, nz: mount.nz } : { nx: 0, nz: 1 }

    if (premises && mount) {
      const markId = npc.integrates
      const mark =
        markId && isEmblemId(markId) && npc.status?.length
          ? { emblem: markId, caption: SHIELDED_NOTICE.markCaption, status: [...npc.status] }
          : undefined
      if (markId && !mark) {
        // A mark with nothing qualifying it would read as an endorsement, so it
        // does not get hung at all. See the header above.
        console.error(`service npc "${npc.name}" names ${markId} with no status lines; mark withheld`)
      }
      const board = premisesBoard(batch, mount, wallCeiling(premises, mount), {
        trade,
        tradeCaption: npc.trade,
        accent: premises.accent ?? npc.color,
        mark,
      })
      texts.push(...board.texts)
    }

    // Beside the person, offset along the wall they face so it never lands in
    // front of them or inside the shop. 2.8m, not less: the boards are 2.2m
    // wide and the wider designs carry a prop a metre and a half out, so a
    // closer standard grows through somebody's vial rack. The trade emblem
    // only — the external mark stays on the board that carries the status.
    npcStandard(
      batch,
      [npc.x - facing.nz * 2.8, npc.z + facing.nx * 2.8],
      Math.atan2(-facing.nx, -facing.nz),
      trade,
      { color: npc.color, roughness: 0.5, metalness: 0.3 },
    )
  }

  const built = batch.build(group)
  for (const mesh of texts) group.add(mesh)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    built.dispose()
    for (const mesh of texts) {
      mesh.geometry.dispose()
      disposeMaterial(mesh.material as THREE.Material)
    }
  }
  group.userData.dispose = dispose
  group.userData.boxes = built.boxes
  // Removal from the graph is the one teardown signal this module gets, and it
  // covers the case that actually leaks: the world remounting on a wardrobe
  // change and building a second town over the first one's GPU buffers.
  group.addEventListener('removed', dispose)
  return group
}
