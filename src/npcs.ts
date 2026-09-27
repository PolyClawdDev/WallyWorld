import * as THREE from 'three'

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

/* ------------------------------------------------------------------ *
 * Ambient residents. Five body plans, each with a few wardrobes, so a
 * crowd of ten never shows the same person twice in one glance.
 * ------------------------------------------------------------------ */

const ambientBodies = {
  // Stocky, flat cap, working vest over a long tunic.
  stocky: grid('stocky', [
    '.....QQQQQQQQ.....',
    '....QQQQQQQQQQ....',
    '......FFFFFF......',
    '......FEFFEF......',
    '......FFFFFF......',
    '.....TTTTTTTT.....',
    '...CCCCCCCCCCCC...',
    '..CCCCCCCCCCCCCC..',
    '..SCCCCCCCCCCCCS..',
    '..SCCCCCCCCCCCCS..',
    '..SCCCCCCCCCCCCS..',
    '...CGGGGGGGGGGC...',
    '...CCCCCCCCCCCC...',
    '...cccccccccccc...',
    '....PPPPPPPPPP....',
    '....PPPP..PPPP....',
    '....PPP....PPP....',
    '...OOOO....OOOO...',
  ]),
  // Slim, bare head, long shop apron.
  slim: grid('slim', [
    '......KKKKKK......',
    '.....KKKKKKKK.....',
    '......FFFFFF......',
    '......FEFFEF......',
    '......FFFFFF......',
    '.....WWWWWWWW.....',
    '....CCCCCCCCCC....',
    '...CCCCCCCCCCCC...',
    '..SCCAAAAAAAACCS..',
    '..SCAAAAAAAAAACS..',
    '...CAAAAAAAAAAC...',
    '...CAGGGGGGGGAC...',
    '...CAAAAAAAAAAC...',
    '...CAAAAAAAAAAC...',
    '....CCCCCCCCCC....',
    '.....PPPPPPPP.....',
    '.....PPP..PPP.....',
    '.....OOO..OOO.....',
  ]),
  // Short, round-headed, simple smock. Reads as a kid at a distance.
  small: grid('small', [
    '......KKKKKK......',
    '.....KKKKKKKK.....',
    '.....KFFFFFFK.....',
    '.....FEFFFFEF.....',
    '.....FFFFFFFF.....',
    '......FFFFFF......',
    '......CCCCCC......',
    '.....CCCCCCCC.....',
    '....SCCCCCCCCS....',
    '.....CGGGGGGC.....',
    '.....CCCCCCCC.....',
    '.....CCCCCCCC.....',
    '......PPPPPP......',
    '......PP..PP......',
    '......OO..OO......',
  ]),
  // Hooded, hauling a sack that swallows one shoulder.
  hauler: grid('hauler', [
    '......HHHHHH......',
    '.....HHHHHHHH.....',
    '....HHHHHHHHHH....',
    '....HHFFFFFFHH....',
    '....HHFEFFEFHH....',
    '.....HFFFFFFH.....',
    '.....HHHHHHHH.....',
    '..LLLHHHHHHHH.....',
    '.LLLLLCCCCCCCC....',
    'LLLLLLLCCCCCCCS...',
    'LLLLLLLCCCCCCCS...',
    '.LLLLLCGGGGGGC....',
    '..LLLCCCCCCCCC....',
    '....CCCCCCCCCC....',
    '....cccccccccc....',
    '....PPPPPPPP......',
    '....PPP..PPP......',
    '....OOO..OOO......',
  ]),
  // Stooped elder under a heavy shawl, leaning on a stick.
  elder: grid('elder', [
    '......KKKKKK......',
    '.....KKKKKKKK.....',
    '....KKFFFFFFK.....',
    '....KKFEFFEFK.....',
    '.....KFFFFFF......',
    '.....TTTTTTTT.....',
    '...TTTTTTTTTTTT...',
    '..TTTTTTTTTTTTTT..',
    '..STTTTTTTTTTTTS..',
    '..M.TTTTTTTTTT....',
    '..M.CCCCCCCCCC....',
    '..M.CGGGGGGGGC....',
    '..M.CCCCCCCCCC....',
    '..M.CCCCCCCCCC....',
    '..M.cccccccccc....',
    '..M..PPPPPPPP.....',
    '..M..PPP..PPP.....',
    '..M..OOO..OOO.....',
  ]),
} satisfies Record<string, string[]>

type AmbientKind = keyof typeof ambientBodies

/**
 * Ordered so a round-robin walk never puts two of the same body plan next to
 * each other, and ten residents cover all five plans twice.
 */
const ambientWardrobe: Array<{ kind: AmbientKind; height: number; accent: string; lean?: number; palette: Palette }> = [
  {
    kind: 'stocky', height: 3.2, accent: '#9aa7a8',
    palette: base({ Q: '#4d4338', q: '#332c25', T: '#8a5a3f', C: '#7d6a4f', c: '#54462f', P: '#3e4a52', F: SKIN.warm, S: SKIN.warm }),
  },
  {
    kind: 'slim', height: 3.15, accent: '#a6947c',
    palette: base({ K: '#6b4a2e', C: '#8a5f4a', c: '#5d3f31', A: '#ded3b4', P: '#4a4238', F: SKIN.pale, S: SKIN.pale }),
  },
  {
    kind: 'hauler', height: 3.3, accent: '#8f9684', lean: 0.09,
    palette: base({ H: '#5a5347', C: '#6b5f4c', c: '#463d30', L: '#7a5a38', P: '#3f3a32', F: SKIN.warm, S: SKIN.warm }),
  },
  {
    kind: 'elder', height: 2.85, accent: '#b0a7b5', lean: 0.16,
    palette: base({ K: '#cfc9ba', T: '#8a6f7d', C: '#4f4a52', c: '#332f36', P: '#3d3a33', M: '#7a5a38', F: SKIN.pale, S: SKIN.pale }),
  },
  {
    kind: 'small', height: 2.3, accent: '#c69a72',
    palette: base({ K: '#c08a3e', C: '#b5714f', c: '#7c4b34', P: '#485162', F: SKIN.pale, S: SKIN.pale }),
  },
  {
    kind: 'stocky', height: 3.35, accent: '#8fa38c',
    palette: base({ Q: '#3b5364', q: '#26353f', T: '#c2543f', C: '#5b6f63', c: '#3b4a41', P: '#4a3f33', F: SKIN.deep, S: SKIN.deep }),
  },
  {
    kind: 'slim', height: 3.25, accent: '#93a2b5',
    palette: base({ K: '#2f2a26', C: '#4f6b70', c: '#334749', A: '#c9c0a3', P: '#3d3a33', F: SKIN.deep, S: SKIN.deep }),
  },
  {
    kind: 'hauler', height: 3.4, accent: '#7f8c97', lean: 0.11,
    palette: base({ H: '#3f4a55', C: '#505a63', c: '#353d44', L: '#6a4a2e', P: '#3a3630', F: SKIN.ruddy, S: SKIN.ruddy }),
  },
  {
    kind: 'elder', height: 2.95, accent: '#9fb096', lean: 0.14,
    palette: base({ K: '#d6d0c2', T: '#6f7f6a', C: '#4a5148', c: '#2f342e', P: '#3a3a36', M: '#6b4d36', F: SKIN.deep, S: SKIN.deep }),
  },
  {
    kind: 'small', height: 2.45, accent: '#a8b58c',
    palette: base({ K: '#4a3b2e', C: '#6d7f5c', c: '#47543c', P: '#4c4238', F: SKIN.warm, S: SKIN.warm }),
  },
]

function hash(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * Hashing names straight into the wardrobe collides often enough that a crowd
 * of ten can miss whole body plans, so residents are dealt round-robin in the
 * order they are first built and then remembered by name.
 */
const residentSlots = new Map<string, number>()

function slotFor(name: string) {
  let slot = residentSlots.get(name)
  if (slot === undefined) {
    slot = residentSlots.size % ambientWardrobe.length
    residentSlots.set(name, slot)
  }
  return slot
}

/** `MIRA · GUIDE` and `MIRA` both resolve to the MIRA design. */
function designFor(name: string): NpcDesign {
  const key = name.split('·')[0].trim().toUpperCase()
  const named = namedDesigns[key]
  if (named) return named
  const wardrobe = ambientWardrobe[slotFor(name)]
  return {
    rows: ambientBodies[wardrobe.kind],
    height: wardrobe.height,
    palette: wardrobe.palette,
    accent: wardrobe.accent,
    lean: wardrobe.lean,
  }
}

/** Label and ground-ring colour for an NPC, so markers match the model. */
export function npcAccent(name: string) {
  return designFor(name).accent
}

/**
 * Build a townsperson. Height comes from the design, not the caller, because
 * varied stature is most of what stops the crowd reading as clones.
 */
export function createTownsfolk(name: string, scale = 1) {
  const key = name.split('·')[0].trim().toUpperCase()
  const design = designFor(name)
  const root = new THREE.Group()
  root.scale.setScalar(scale)
  root.userData.npcDesign = key
  // Named NPCs keep a predictable facing so their props read from the street.
  // Residents get a stable scatter, otherwise the crowd stands in formation.
  if (!namedDesigns[key]) root.rotation.y = ((hash(name) % 360) / 360) * Math.PI * 2

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
