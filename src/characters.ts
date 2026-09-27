import * as THREE from 'three'

export type WizardId = 'MOTH' | 'BRAMBLE' | 'CINDER' | 'ORBIT'
export type MothStyle = {
  hat: 'crooked' | 'moon' | 'witch' | 'traveler' | 'starfold'
  robe: 'midnight' | 'plum' | 'moss' | 'ember' | 'slate'
  familiar: 'moth' | 'firefly' | 'rune' | 'bat' | 'orb'
  accessory: 'lantern' | 'satchel' | 'talisman' | 'book' | 'compass'
}

export const wizards: Record<WizardId, { color: string; accent: string; desc: string; role: string }> = {
  MOTH: { color: '#2b3557', accent: '#d5a64b', desc: 'Lantern keeper with a moth familiar.', role: 'Wayfinder' },
  BRAMBLE: { color: '#56685a', accent: '#9ca66d', desc: 'Seed-sower who listens to the old roots.', role: 'Grove tender' },
  CINDER: { color: '#3c2930', accent: '#e35e35', desc: 'A little furnace with a lot of spark.', role: 'Maker' },
  ORBIT: { color: '#625b86', accent: '#7bc9ce', desc: 'Star mapper from the quiet observatory.', role: 'Navigator' },
}

export const defaultMothStyle: MothStyle = { hat: 'crooked', robe: 'midnight', familiar: 'moth', accessory: 'lantern' }

export const mothStyleOptions = {
  hat: [
    { id: 'crooked', label: 'Crooked Gold', note: 'Bent crown · brass band' },
    { id: 'moon', label: 'Moon Tip', note: 'Tip curls left · violet cloth' },
    { id: 'witch', label: 'Tall Witch', note: 'High straight cone' },
    { id: 'traveler', label: 'Traveler', note: 'Low crown · broad brim' },
    { id: 'starfold', label: 'Starfold', note: 'Folded indigo cloth' },
  ],
  robe: [
    { id: 'midnight', label: 'Midnight Blue', note: 'Brass embroidery' },
    { id: 'plum', label: 'Dusk Plum', note: 'Cyan stitchwork' },
    { id: 'moss', label: 'Lantern Moss', note: 'Warm leather hem' },
    { id: 'ember', label: 'Ember Lining', note: 'Copper thread' },
    { id: 'slate', label: 'Rain Slate', note: 'Silver edgework' },
  ],
  familiar: [
    { id: 'moth', label: 'Moth', note: 'Four beating wings' },
    { id: 'firefly', label: 'Firefly', note: 'A tiny warm orbit' },
    { id: 'rune', label: 'Rune Sprite', note: 'Cyan geometric charm' },
    { id: 'bat', label: 'Pocket Bat', note: 'Quiet little shadow' },
    { id: 'orb', label: 'Moon Orb', note: 'Cool violet glow' },
  ],
  accessory: [
    { id: 'lantern', label: 'Hanging Lantern', note: 'Illuminated staff' },
    { id: 'satchel', label: 'Potion Satchel', note: 'Three glass vials' },
    { id: 'talisman', label: 'Brass Talisman', note: 'Old-world fastener' },
    { id: 'book', label: 'Field Journal', note: 'Maps and receipts' },
    { id: 'compass', label: 'Brass Compass', note: 'Points to home' },
  ],
} as const

/* ------------------------------------------------------------------ *
 * Characters are authored as 2D pixel grids and extruded into cubes.
 * Every grid is GRID columns wide and every row must be exactly that
 * long, otherwise voxels silently shift or vanish.
 *
 * A character = a swappable hat block stacked on a body block. Both
 * share one palette-key convention so a single palette drives all four:
 *   R/r robe   C trim    F face   E eyes   S hands   O boots   G belt
 *   H/h/B/b/D  hat       A antler N mushroom W beard  P copper
 *   Y gloves   I visor
 * ------------------------------------------------------------------ */

const CHAR_HEIGHT = 3.4
const SPRITE_DEPTH = 5
const GRID = 18
const HAT_ROWS = 16

function span(from: number, to: number, ch: string) {
  const a = Math.max(0, from)
  const b = Math.min(GRID - 1, to)
  return '.'.repeat(a) + ch.repeat(b - a + 1) + '.'.repeat(GRID - 1 - b)
}

type HatSpec = {
  crownRows: number
  tipHalf: number
  baseHalf: number
  /** Kept at or below 6.5 so brims never reach the outer two columns. */
  brimHalf: number
  /** Horizontal offset of the crown centreline, t=0 at the tip, t=1 at the base. */
  bend: (t: number) => number
}

/**
 * Crowns taper on both sides around a curved centreline. Stepping only one
 * edge reads as a flight of stairs rather than a hat, so any lean comes from
 * moving the centreline instead of pinning an edge.
 */
function buildHatRows(spec: HatSpec): string[] {
  const rows: string[] = []
  const centre = (GRID - 1) / 2
  for (let i = 0; i < HAT_ROWS - 3 - spec.crownRows; i++) rows.push('.'.repeat(GRID))
  for (let i = 0; i < spec.crownRows; i++) {
    const t = spec.crownRows === 1 ? 1 : i / (spec.crownRows - 1)
    const half = spec.tipHalf + (spec.baseHalf - spec.tipHalf) * t
    const mid = centre + spec.bend(t)
    const left = Math.max(0, Math.round(mid - half))
    const right = Math.min(GRID - 1, Math.round(mid + half))
    let row = ''
    for (let x = 0; x < GRID; x++) row += x < left || x > right ? '.' : x === right ? 'h' : 'H'
    rows.push(row)
  }
  const bandHalf = spec.baseHalf + 0.5
  rows.push(span(Math.round(centre - bandHalf), Math.round(centre + bandHalf), 'D'))
  rows.push(span(Math.round(centre - spec.brimHalf), Math.round(centre + spec.brimHalf), 'B'))
  rows.push(span(Math.round(centre - spec.brimHalf), Math.round(centre + spec.brimHalf), 'b'))
  return rows
}

const hatSpecs: Record<MothStyle['hat'], HatSpec> = {
  crooked: { crownRows: 13, tipHalf: 1.0, baseHalf: 4.8, brimHalf: 6.5, bend: t => 2.4 * Math.pow(1 - t, 1.5) },
  moon: { crownRows: 13, tipHalf: 1.0, baseHalf: 4.6, brimHalf: 6.2, bend: t => -3.0 * Math.pow(1 - t, 1.6) },
  witch: { crownRows: 13, tipHalf: 0.8, baseHalf: 5.2, brimHalf: 6.5, bend: () => 0 },
  traveler: { crownRows: 7, tipHalf: 3.4, baseHalf: 5.2, brimHalf: 6.5, bend: () => 0 },
  starfold: { crownRows: 13, tipHalf: 1.0, baseHalf: 4.8, brimHalf: 6.0, bend: t => 2.6 * Math.sin((1 - t) * 2.6) },
}

const hatRows: Record<MothStyle['hat'], string[]> = {
  crooked: buildHatRows(hatSpecs.crooked),
  moon: buildHatRows(hatSpecs.moon),
  witch: buildHatRows(hatSpecs.witch),
  traveler: buildHatRows(hatSpecs.traveler),
  starfold: buildHatRows(hatSpecs.starfold),
}

/* Bodies. Signature identity lives here so hats and robes stay swappable. */

// Broad and balanced.
const mothBody = [
  '....FFFFFFF.......',
  '....FEFFFEF.......',
  '....FEFFFEF.......',
  '....FFFFFFF.......',
  '...CCCCCCCCC......',
  '..RRRRRRRRRRR.....',
  '..RRRRRRRRRRR.....',
  '.SRRRRRRRRRRRS....',
  '.SRRRRRRRRRRRS....',
  '..RGGGGGGGGGR.....',
  '..RRRRRRRRRRR.....',
  '..RRRRRRRRRRR.....',
  '..RRRRRRRRRRR.....',
  '.RRRRRRRRRRRRR....',
  '.RRRRRRRRRRRRR....',
  '.rrrrrrrrrrrrr....',
  '...OOO...OOO......',
  '...OOO...OOO......',
]

// Short and wide. Antlers are a separate prop: drawn in the grid they leave a
// pocket beside the head that the brim seals into a see-through hole.
const brambleBody = [
  '.....FFFFFFFF.....',
  '.....FEFFFFEF.....',
  '.....FFFFFFFF.....',
  '....WWWWWWWWWW....',
  '....WWWWWWWWWW....',
  '.NNCCCCCCCCCC.....',
  '.NNRRRRRRRRRR.....',
  '.RRRRRRRRRRRRR....',
  'SRRRRRRRRRRRRRS...',
  '.RGGGGGGGGGGGR....',
  '.RRRRRRRRRRRRR....',
  '.RRRRRRRRRRRRR....',
  'RRRRRRRRRRRRRRR...',
  'rrrrrrrrrrrrrrr...',
  '..OOO.....OOO.....',
]

// Small and wiry, copper fittings and oversized gloves.
const cinderBody = [
  '.....FFFFFF.......',
  '.....FEFFEF.......',
  '.....FFFFFF.......',
  '....PPPPPPPP......',
  '...CRRRRRRRRC.....',
  '..YRRRRRRRRRRY....',
  '..YRRRRRRRRRRY....',
  '...RGGGGGGGGR.....',
  '...RRRRRRRRRR.....',
  '...PRRRRRRRRP.....',
  '...RRRRRRRRRR.....',
  '..RRRRRRRRRRRR....',
  '..rrrrrrrrrrrr....',
  '...OOO...OOO......',
]

// Tall and narrow, single visor band.
const orbitBody = [
  '.....FFFFFFFF.....',
  '.....IIIIIIII.....',
  '.....FFFFFFFF.....',
  '....CCCCCCCCCC....',
  '.....RRRRRRRR.....',
  '.....RRRRRRRR.....',
  '....SRRRRRRRRS....',
  '....SRRRRRRRRS....',
  '.....RGGGGGGR.....',
  '.....RRRRRRRR.....',
  '.....RRRRRRRR.....',
  '.....RRRRRRRR.....',
  '....RRRRRRRRRR....',
  '....RRRRRRRRRR....',
  '....RRRRRRRRRR....',
  '...RRRRRRRRRRRR...',
  '...rrrrrrrrrrrr...',
  '.....OOO..OOO.....',
]

const bodies: Record<WizardId, string[]> = {
  MOTH: mothBody,
  BRAMBLE: brambleBody,
  CINDER: cinderBody,
  ORBIT: orbitBody,
}

const robeColors: Record<MothStyle['robe'], { main: string; dark: string; trim: string }> = {
  midnight: { main: '#2f3b62', dark: '#1d2440', trim: '#4a5b8c' },
  plum: { main: '#4b3860', dark: '#2f2340', trim: '#9b7fc4' },
  moss: { main: '#415a4a', dark: '#2a3b32', trim: '#8aa06a' },
  ember: { main: '#6d3a2e', dark: '#43211a', trim: '#c9763e' },
  slate: { main: '#3c454f', dark: '#262d35', trim: '#9aa7b3' },
}

const hatColors: Record<MothStyle['hat'], { main: string; dark: string; brim: string; under: string; band: string }> = {
  crooked: { main: '#d5a64b', dark: '#a87c31', brim: '#c9953e', under: '#7a5726', band: '#5f4430' },
  moon: { main: '#8878ad', dark: '#5f5280', brim: '#7d6da2', under: '#473c63', band: '#4a3c52' },
  witch: { main: '#b1712f', dark: '#84501f', brim: '#a56729', under: '#623b16', band: '#4e3a26' },
  traveler: { main: '#9b6a3e', dark: '#714a29', brim: '#8d5f36', under: '#52371e', band: '#59422c' },
  starfold: { main: '#5a5d92', dark: '#3f416b', brim: '#535688', under: '#2f3050', band: '#414466' },
}

const eyeColors: Record<WizardId, string> = {
  MOTH: '#f7d98d',
  BRAMBLE: '#cfe07a',
  CINDER: '#ffb15c',
  ORBIT: '#7bc9ce',
}

type Palette = Record<string, string>

const emissiveKeys = new Set(['E', 'I'])

/** One palette drives every character: robe choice fills R/r/C, hat choice fills H/h/B/b/D. */
function paletteFor(id: WizardId, style: MothStyle): Palette {
  const robe = robeColors[style.robe]
  const hat = hatColors[style.hat]
  return {
    R: robe.main,
    r: robe.dark,
    C: robe.trim,
    H: hat.main,
    h: hat.dark,
    B: hat.brim,
    b: hat.under,
    D: hat.band,
    F: '#161b28',
    E: eyeColors[id],
    S: '#c0a482',
    G: '#b6813d',
    O: '#1e2330',
    // Fixed identity accents, deliberately not driven by the robe choice.
    A: '#7a6146',
    N: '#c9776a',
    W: '#cdd6b4',
    P: '#b9763c',
    Y: '#3a3b47',
    I: '#7bc9ce',
  }
}

function materialFor(key: string, color: string) {
  if (emissiveKeys.has(key)) {
    return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8, roughness: 0.3 })
  }
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82 })
}

/** Stable per-voxel brightness jitter, so cubes stay readable without physical gaps. */
function shadeJitter(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return 0.94 + (n - Math.floor(n)) * 0.12
}

/**
 * Extrude a pixel grid into instanced cubes.
 *
 * Cubes are a hair over full size so neighbours overlap: any gap lets the
 * background show straight through the figure. Voxel definition comes from
 * lighting and the per-instance shade jitter instead.
 *
 * Interior cells are culled only in the middle depth layers. The front and
 * back layers plus the silhouette cells (which are never `enclosed`, since
 * they always border an empty cell) form a closed shell around that cavity.
 */
function buildSprite(rows: string[], palette: Palette) {
  const group = new THREE.Group()
  const height = rows.length
  const cell = CHAR_HEIGHT / height
  // Cubes overlap slightly so neighbours leave no gap to see through.
  const fill = cell * 1.02
  const geometry = new THREE.BoxGeometry(fill, fill, fill)
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

function buildStaffWithLantern(cell: number) {
  const staff = new THREE.Group()
  const wood = new THREE.MeshStandardMaterial({ color: '#6b4d36', roughness: 0.85 })
  const brass = new THREE.MeshStandardMaterial({ color: '#b6813d', roughness: 0.4, metalness: 0.6 })
  const pole = new THREE.Mesh(new THREE.BoxGeometry(cell * 1.1, CHAR_HEIGHT * 0.86, cell * 1.1), wood)
  pole.position.y = CHAR_HEIGHT * 0.43
  pole.castShadow = true
  staff.add(pole)

  const reach = cell * 2.6
  const hookY = CHAR_HEIGHT * 0.84
  const hook = new THREE.Mesh(new THREE.BoxGeometry(reach, cell * 1.1, cell * 1.1), brass)
  hook.position.set(reach / 2, hookY, 0)
  staff.add(hook)

  const lanternY = CHAR_HEIGHT * 0.66
  const chain = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.6, hookY - lanternY, cell * 0.6), brass)
  chain.position.set(reach, (hookY + lanternY) / 2, 0)
  staff.add(chain)

  // Built as a solid body rather than an open frame: a frame of posts and bars
  // leaves interior gaps you can see the background through.
  const lantern = new THREE.Group()
  lantern.position.set(reach, lanternY, 0)
  const glow = new THREE.MeshStandardMaterial({ color: '#f0b84d', emissive: '#f0b84d', emissiveIntensity: 2.4, roughness: 0.2 })
  const core = new THREE.Mesh(new THREE.BoxGeometry(cell * 2.8, cell * 2.6, cell * 2.8), glow)
  lantern.add(core)
  // Brass cap and base, slightly wider than the core.
  for (const y of [cell * 1.9, -cell * 1.9]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(cell * 3.4, cell * 1.2, cell * 3.4), brass)
    plate.position.y = y
    lantern.add(plate)
  }
  // Corner ribs overlap the core, so there is no line of sight between them.
  for (const x of [-cell * 1.3, cell * 1.3]) {
    for (const z of [-cell * 1.3, cell * 1.3]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.9, cell * 3.2, cell * 0.9), brass)
      rib.position.set(x, 0, z)
      lantern.add(rib)
    }
  }
  lantern.add(new THREE.PointLight('#f0b84d', 1.4, 4))
  staff.add(lantern)
  return staff
}

function buildAccessory(style: MothStyle, cell: number, reach: number) {
  const group = new THREE.Group()
  group.name = 'accessory'
  const side = reach + cell * 2

  if (style.accessory === 'lantern') {
    const staff = buildStaffWithLantern(cell)
    staff.position.set(side, 0, cell * 2.6)
    staff.rotation.z = -0.05
    group.add(staff)
    return group
  }
  if (style.accessory === 'satchel') {
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(cell * 3.4, cell * 3.4, cell * 1),
      new THREE.MeshStandardMaterial({ color: '#6d5238', roughness: 0.9 }),
    )
    strap.position.set(-side * 0.82, CHAR_HEIGHT * 0.3, cell * 3)
    group.add(strap)
    const vialColors = ['#7bc9ce', '#d5a64b', '#c96f8f']
    vialColors.forEach((color, index) => {
      const vial = new THREE.Mesh(
        new THREE.BoxGeometry(cell * 0.9, cell * 2, cell * 0.9),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1, roughness: 0.25 }),
      )
      vial.position.set(-side * 0.82 + (index - 1) * cell * 1.2, CHAR_HEIGHT * 0.36, cell * 3.4)
      group.add(vial)
    })
    return group
  }
  if (style.accessory === 'talisman') {
    const chain = new THREE.Mesh(
      new THREE.BoxGeometry(cell * 0.6, cell * 3, cell * 0.6),
      new THREE.MeshStandardMaterial({ color: '#b6813d', metalness: 0.6, roughness: 0.4 }),
    )
    chain.position.set(0, CHAR_HEIGHT * 0.47, cell * 3)
    group.add(chain)
    const disc = new THREE.Mesh(
      new THREE.OctahedronGeometry(cell * 1.9),
      new THREE.MeshStandardMaterial({ color: '#e0b458', emissive: '#8a5f1d', emissiveIntensity: 0.9, metalness: 0.7, roughness: 0.3 }),
    )
    disc.position.set(0, CHAR_HEIGHT * 0.38, cell * 3.2)
    group.add(disc)
    return group
  }
  if (style.accessory === 'book') {
    for (const [color, w, d] of [['#7d4550', 3, 1], ['#e5ddc8', 2.6, 1.4]] as const) {
      const part = new THREE.Mesh(
        new THREE.BoxGeometry(cell * w, cell * 4, cell * d),
        new THREE.MeshStandardMaterial({ color, roughness: 0.88 }),
      )
      part.position.set(-side * 0.9, CHAR_HEIGHT * 0.34, cell * (d === 1 ? 3 : 3.3))
      part.rotation.z = 0.18
      group.add(part)
    }
    return group
  }
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(cell * 1.8, cell * 1.8, cell * 0.8, 8),
    new THREE.MeshStandardMaterial({ color: '#c79a48', metalness: 0.7, roughness: 0.3 }),
  )
  housing.rotation.x = Math.PI / 2
  housing.position.set(side * 0.72, CHAR_HEIGHT * 0.4, cell * 3.2)
  group.add(housing)
  const needle = new THREE.Mesh(
    new THREE.BoxGeometry(cell * 0.5, cell * 2.4, cell * 0.5),
    new THREE.MeshStandardMaterial({ color: '#7bc9ce', emissive: '#7bc9ce', emissiveIntensity: 1.4 }),
  )
  needle.position.set(side * 0.72, CHAR_HEIGHT * 0.4, cell * 3.6)
  needle.rotation.z = 0.5
  group.add(needle)
  return group
}

/** BRAMBLE's antlers, rooted at the brim edge so they clear the crown and read against the sky. */
function buildAntlers(cell: number) {
  const group = new THREE.Group()
  group.name = 'antlers'
  const wood = new THREE.MeshStandardMaterial({ color: '#7a6146', roughness: 0.9 })
  const geometry = new THREE.BoxGeometry(cell * 1.05, cell * 1.05, cell * 1.05)
  const beam: Array<[number, number]> = [
    [6.2, 16.9], [6.8, 18.0], [7.3, 19.1], [7.7, 20.2], [8.0, 21.3], [8.2, 22.4],
    [9.0, 20.4], [9.7, 21.4], [10.2, 22.3],
    [6.9, 21.0], [6.8, 22.1],
  ]
  for (const dir of [-1, 1]) {
    for (const [x, y] of beam) {
      const cube = new THREE.Mesh(geometry, wood)
      cube.position.set(dir * x * cell, y * cell, 0)
      cube.castShadow = true
      group.add(cube)
    }
  }
  return group
}

function buildFamiliar(style: MothStyle, cell: number) {
  const familiar = new THREE.Group()
  familiar.name = 'familiar'
  const wings: THREE.Object3D[] = []

  // Wings hang off a pivot at the body so flapping rotates about the spine.
  // Each wing is stepped out of several blocks; a single slab just reads as a bar.
  const addWings = (upper: string, lower: string) => {
    const segments: Array<[number, number, number, number, 0 | 1]> = [
      // width, height, x, y, upper(0) or lower(1)
      [2.6, 2.8, 1.7, 0.9, 0],
      [1.8, 1.9, 3.5, 1.8, 0],
      [2.1, 1.7, 1.5, -1.3, 1],
      [1.3, 1.1, 2.9, -2.0, 1],
    ]
    for (const dir of [-1, 1]) {
      const pivot = new THREE.Group()
      for (const [w, h, x, y, tier] of segments) {
        const part = new THREE.Mesh(
          new THREE.BoxGeometry(cell * w, cell * h, cell * 0.5),
          new THREE.MeshStandardMaterial({ color: tier ? lower : upper, roughness: 0.72 }),
        )
        part.position.set(dir * cell * x, cell * y, 0)
        pivot.add(part)
      }
      familiar.add(pivot)
      wings.push(pivot)
    }
  }

  if (style.familiar === 'firefly') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(cell * 1.5, cell * 1.5, cell * 1.5),
      new THREE.MeshStandardMaterial({ color: '#f0b84d', emissive: '#f0b84d', emissiveIntensity: 2.6 }),
    )
    familiar.add(body)
    familiar.add(new THREE.PointLight('#f0b84d', 1.1, 2.6))
  } else if (style.familiar === 'rune') {
    const rune = new THREE.Mesh(
      new THREE.OctahedronGeometry(cell * 2),
      new THREE.MeshStandardMaterial({ color: '#7bc9ce', emissive: '#7bc9ce', emissiveIntensity: 1.9 }),
    )
    familiar.add(rune)
  } else if (style.familiar === 'bat') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(cell * 1.3, cell * 3.2, cell * 1.3),
      new THREE.MeshStandardMaterial({ color: '#2a2433', roughness: 0.9 }),
    )
    familiar.add(body)
    for (const dir of [-1, 1]) {
      const ear = new THREE.Mesh(
        new THREE.BoxGeometry(cell * 0.5, cell * 1.2, cell * 0.5),
        new THREE.MeshStandardMaterial({ color: '#2a2433', roughness: 0.9 }),
      )
      ear.position.set(dir * cell * 0.5, cell * 2.1, 0)
      familiar.add(ear)
    }
    addWings('#4d3c61', '#352a44')
  } else if (style.familiar === 'orb') {
    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(cell * 1.8, 1),
      new THREE.MeshStandardMaterial({ color: '#9580b8', emissive: '#7bc9ce', emissiveIntensity: 1.5 }),
    )
    familiar.add(orb)
  } else {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(cell * 1.3, cell * 3.6, cell * 1.3),
      new THREE.MeshStandardMaterial({ color: '#4a3b28', roughness: 0.8 }),
    )
    familiar.add(body)
    for (const dir of [-1, 1]) {
      const antenna = new THREE.Mesh(
        new THREE.BoxGeometry(cell * 0.4, cell * 1.8, cell * 0.4),
        new THREE.MeshStandardMaterial({ color: '#4a3b28', roughness: 0.8 }),
      )
      antenna.position.set(dir * cell * 0.7, cell * 2.5, 0)
      antenna.rotation.z = dir * 0.45
      familiar.add(antenna)
    }
    addWings('#e0b665', '#a87c31')
  }

  familiar.userData.wings = wings
  return familiar
}

export function createWizard(id: WizardId, scale = 1, style: MothStyle = defaultMothStyle) {
  const root = new THREE.Group()
  root.scale.setScalar(scale)
  root.userData.characterId = id

  const sprite = buildSprite([...hatRows[style.hat], ...bodies[id]], paletteFor(id, style))
  const cell = sprite.userData.cell as number
  const reach = sprite.userData.reach as number
  root.add(sprite)

  if (id === 'BRAMBLE') root.add(buildAntlers(cell))

  root.add(buildAccessory(style, cell, reach))

  const familiar = buildFamiliar(style, cell)
  familiar.position.set(-(reach + cell * 2.4), CHAR_HEIGHT * 0.78, cell * 3)
  familiar.userData.restY = familiar.position.y
  root.add(familiar)

  root.userData.cell = cell
  return root
}

/** Shared idle motion so previews, the player, and NPCs animate identically. */
export function animateCharacter(character: THREE.Object3D, time: number, phase = 0) {
  const familiar = character.getObjectByName('familiar')
  if (!familiar) return
  const restY = (familiar.userData.restY as number) ?? familiar.position.y
  familiar.position.y = restY + Math.sin(time * 0.0035 + phase) * 0.08
  familiar.rotation.y += 0.01
  const wings = familiar.userData.wings as THREE.Object3D[] | undefined
  if (wings?.length) {
    wings.forEach((wing, index) => {
      wing.rotation.z = (index ? 1 : -1) * (0.3 + Math.sin(time * 0.02 + phase) * 0.35)
    })
  }
}
