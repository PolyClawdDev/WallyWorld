import * as THREE from 'three'

/* ------------------------------------------------------------------ *
 * The four playable wayfinders.
 *
 * They are four different kinds of being, not four palettes of the same
 * robed figure. Read the outline with the colour stripped out and you
 * should still know which one you are looking at:
 *
 *   WICK   tall, cone-hatted, floor-length robe, face lost in a cowl
 *   LOAM   short and barrel-wide, no neck, no arms, roots for feet
 *   KILN   squat and lopsided, brass casing, one oversized clamp arm
 *   VANE   tall and narrow, sealed plate, dome helmet, split legs
 *
 * WizardId is the internal key and is deliberately frozen: the combat
 * kits, the persisted profile schema in src/shared/profile.ts and the
 * town data all key off 'MOTH' | 'BRAMBLE' | 'CINDER' | 'ORBIT'. The
 * name the player sees lives in `wizards[id].name`, and the element
 * each key owns is unchanged:
 *
 *   MOTH    -> WICK   light / lantern
 *   BRAMBLE -> LOAM   nature
 *   CINDER  -> KILN   fire
 *   ORBIT   -> VANE   storm / star
 *
 * The wardrobe keys (hat/robe/familiar/accessory) and their option ids
 * are frozen for the same reason — the server validates them. What each
 * slot *means* is per archetype: 'hat' is a witch hat on WICK, the fungus
 * growing out of LOAM's crown, KILN's flue and VANE's helmet. The label
 * the player reads comes from `wardrobes[id][slot].label`.
 * ------------------------------------------------------------------ */

export type WizardId = 'MOTH' | 'BRAMBLE' | 'CINDER' | 'ORBIT'

/** Frozen value sets. Mirrored by src/shared/profile.ts; do not rename. */
export type MothStyle = {
  hat: 'crooked' | 'moon' | 'witch' | 'traveler' | 'starfold'
  robe: 'midnight' | 'plum' | 'moss' | 'ember' | 'slate'
  familiar: 'moth' | 'firefly' | 'rune' | 'bat' | 'orb'
  accessory: 'lantern' | 'satchel' | 'talisman' | 'book' | 'compass'
}

export type StyleSlot = keyof MothStyle
export type Element = 'light' | 'nature' | 'fire' | 'storm'

export const wizards: Record<
  WizardId,
  { name: string; element: Element; color: string; accent: string; desc: string; role: string }
> = {
  MOTH: {
    name: 'WICK',
    element: 'light',
    color: '#2b3557',
    accent: '#d5a64b',
    desc: 'Walks the canal at dusk and leaves every lamp burning behind her.',
    role: 'Lamplighter',
  },
  BRAMBLE: {
    name: 'LOAM',
    element: 'nature',
    color: '#4a3a2c',
    accent: '#9ca66d',
    desc: 'A stump that got up and kept going. Moss, fungus, and a very long memory.',
    role: 'Grovewalker',
  },
  CINDER: {
    name: 'KILN',
    element: 'fire',
    color: '#6a3a24',
    accent: '#ff8a3d',
    desc: 'A brass furnace on two short legs. The grate in its chest is the fire.',
    role: 'Forge-walker',
  },
  ORBIT: {
    name: 'VANE',
    element: 'storm',
    color: '#2f3a66',
    accent: '#7bc9ce',
    desc: 'Sealed against the weather and sent up into it. Visor where a face should be.',
    role: 'Stormdiver',
  },
}

export const defaultMothStyle: MothStyle = { hat: 'crooked', robe: 'midnight', familiar: 'moth', accessory: 'lantern' }

/* ------------------------------------------------------------------ *
 * Wardrobe.
 *
 * Four slots per archetype so the selector UI keeps one shape, but the
 * label and the meaning of each slot belong to the archetype.
 * ------------------------------------------------------------------ */

type SlotOption<K extends StyleSlot> = { id: MothStyle[K]; label: string; note: string }
type SlotSpec<K extends StyleSlot> = { label: string; options: readonly SlotOption<K>[] }
type Wardrobe = { [K in StyleSlot]: SlotSpec<K> }

function slot<K extends StyleSlot>(label: string, entries: Array<[MothStyle[K], string, string]>): SlotSpec<K> {
  return { label, options: entries.map(([id, optionLabel, note]) => ({ id, label: optionLabel, note })) }
}

const wardrobes: Record<WizardId, Wardrobe> = {
  MOTH: {
    hat: slot('HAT', [
      ['crooked', 'Crooked Gold', 'Bent crown · brass band'],
      ['moon', 'Moon Tip', 'Tip curls left · violet cloth'],
      ['witch', 'Tall Witch', 'High straight cone'],
      ['traveler', 'Traveler', 'Low crown · broad brim'],
      ['starfold', 'Starfold', 'Folded indigo cloth'],
    ]),
    robe: slot('ROBE', [
      ['midnight', 'Midnight Blue', 'Brass embroidery'],
      ['plum', 'Dusk Plum', 'Cyan stitchwork'],
      ['moss', 'Lantern Moss', 'Warm leather hem'],
      ['ember', 'Ember Lining', 'Copper thread'],
      ['slate', 'Rain Slate', 'Silver edgework'],
    ]),
    familiar: slot('FAMILIAR', [
      ['moth', 'Moth', 'Four beating wings'],
      ['firefly', 'Firefly', 'A tiny warm orbit'],
      ['rune', 'Rune Sprite', 'Cyan geometric charm'],
      ['bat', 'Pocket Bat', 'Quiet little shadow'],
      ['orb', 'Moon Orb', 'Cool violet glow'],
    ]),
    accessory: slot('STAFF', [
      ['lantern', 'Hanging Lantern', 'Lit staff · casts from the glass'],
      ['satchel', 'Potion Satchel', 'Three glass vials'],
      ['talisman', 'Brass Talisman', 'Old-world fastener'],
      ['book', 'Field Journal', 'Maps and receipts'],
      ['compass', 'Brass Compass', 'Points to home'],
    ]),
  },
  BRAMBLE: {
    hat: slot('GROWTH', [
      ['crooked', 'Fern Crown', 'Two fronds off one stem'],
      ['moon', 'Toadstool Cap', 'Wide red cap · pale gills'],
      ['witch', 'Antler Branch', 'Bare winter twigs'],
      ['traveler', 'Lichen Shelf', 'Flat pale bracket'],
      ['starfold', 'Blossom Sprig', 'Four late flowers'],
    ]),
    robe: slot('BARK', [
      ['midnight', 'Bog Oak', 'Black and waterlogged'],
      ['plum', 'Heartwood', 'Split to the red core'],
      ['moss', 'Spring Moss', 'Green all over'],
      ['ember', 'Autumn Rot', 'Warm and crumbling'],
      ['slate', 'Ashen Birch', 'Pale bark · dark scars'],
    ]),
    familiar: slot('SPRITE', [
      ['moth', 'Seed Pod', 'Drifts on two leaf wings'],
      ['firefly', 'Glowbug', 'One green spark'],
      ['rune', 'Seed Rune', 'A carved stone charm'],
      ['bat', 'Fruit Bat', 'Hangs about hopefully'],
      ['orb', 'Spore Orb', 'A ball of drifting dust'],
    ]),
    accessory: slot('BURDEN', [
      ['lantern', 'Lantern Fungus', 'Glowing caps on the shoulder'],
      ['satchel', 'Seed Pouch', 'Woven grass · three pods'],
      ['talisman', 'Amber Bead', 'Old resin set in the bark'],
      ['book', 'Leaf Tally', 'Pressed leaves on a bark slab'],
      ['compass', 'Dew Stone', 'A wet stone and its drop'],
    ]),
  },
  CINDER: {
    hat: slot('FLUE', [
      ['crooked', 'Bent Flue', 'Leans off to one side'],
      ['moon', 'Ash Cowl', 'Low hood over the dome'],
      ['witch', 'Tall Stack', 'Straight chimney · open top'],
      ['traveler', 'Flat Hood', 'Wide deflector plate'],
      ['starfold', 'Split Vents', 'Two short pipes'],
    ]),
    robe: slot('CASING', [
      ['midnight', 'Cold Iron', 'Blue-black plate'],
      ['plum', 'Oxblood Enamel', 'Chipped deep red'],
      ['moss', 'Verdigris', 'Green with age'],
      ['ember', 'Quenched Copper', 'Warm and scorched'],
      ['slate', 'Tinplate', 'Plain workshop grey'],
    ]),
    familiar: slot('SWARM', [
      ['moth', 'Ember Swarm', 'Three coals that will not settle'],
      ['firefly', 'Forge Spark', 'One bright cinder'],
      ['rune', 'Gear Rune', 'A brass geometric charm'],
      ['bat', 'Soot Bat', 'Lives up the flue'],
      ['orb', 'Slag Orb', 'A cooling ball of glass'],
    ]),
    accessory: slot('TOOL', [
      ['lantern', 'Coal Scoop', 'Live coals · casts from the pan'],
      ['satchel', 'Ore Crate', 'Strapped across the back'],
      ['talisman', 'Brass Seal', 'Guild mark on the chest'],
      ['book', 'Tally Plate', 'Riveted iron ledger'],
      ['compass', 'Ember Gauge', 'Needle that reads heat'],
    ]),
  },
  ORBIT: {
    hat: slot('HELMET', [
      ['crooked', 'Swept Crest', 'Ridge combed backwards'],
      ['moon', 'Hook Antenna', 'Curls out to one side'],
      ['witch', 'Spire Vane', 'Single tall spike'],
      ['traveler', 'Low Dome', 'Smooth · nothing to snag'],
      ['starfold', 'Split Fins', 'Two upright fins'],
    ]),
    robe: slot('SUIT', [
      ['midnight', 'Storm Indigo', 'Deep blue weatherplate'],
      ['plum', 'Nightviolet', 'Violet shell · pale seams'],
      ['moss', 'Sea Glass', 'Canal green'],
      ['ember', 'Sun Copper', 'Scorched on the windward side'],
      ['slate', 'Hail White', 'Bright · high-altitude'],
    ]),
    familiar: slot('DRONE', [
      ['moth', 'Kite Drone', 'Two stiff fins and a lamp'],
      ['firefly', 'Static Mote', 'A held spark'],
      ['rune', 'Star Rune', 'Cut glass · cyan core'],
      ['bat', 'Night Kite', 'Silent · dark canopy'],
      ['orb', 'Pilot Orb', 'Rolls along beside you'],
    ]),
    accessory: slot('RIG', [
      ['lantern', 'Signal Flare', 'Lit rod · casts from the tip'],
      ['satchel', 'Sample Case', 'Hard case on the hip'],
      ['talisman', 'Sky Sigil', 'Floats at the shoulder'],
      ['book', 'Chart Slate', 'Backlit glass chart'],
      ['compass', 'Storm Dial', 'Ring gauge · one bead'],
    ]),
  },
}

/** Ordered slots for the selector UI: label, key and options for one character. */
export function styleSlots(id: WizardId) {
  const wardrobe = wardrobes[id]
  return (['hat', 'robe', 'familiar', 'accessory'] as StyleSlot[]).map(key => ({
    key,
    label: wardrobe[key].label,
    count: wardrobe[key].options.length,
  }))
}

/** What the player should read for the option currently selected in one slot. */
export function styleLabel(id: WizardId, style: MothStyle, key: StyleSlot) {
  const options = wardrobes[id][key].options as readonly { id: string; label: string; note: string }[]
  return options.find(option => option.id === style[key]) ?? { label: '—', note: '' }
}

/**
 * Step one slot forwards or backwards. Option ids are shared across the four
 * archetypes on purpose, so switching character never leaves a style value
 * that its wardrobe cannot render.
 */
export function cycleStyle(id: WizardId, style: MothStyle, key: StyleSlot, step: number): MothStyle {
  const options = wardrobes[id][key].options as readonly { id: string }[]
  const index = options.findIndex(option => option.id === style[key])
  const next = options[(index + step + options.length) % options.length]
  return { ...style, [key]: next.id } as MothStyle
}

/** Back-compat view of WICK's option lists, used by the dev harnesses. */
export const mothStyleOptions = {
  hat: wardrobes.MOTH.hat.options,
  robe: wardrobes.MOTH.robe.options,
  familiar: wardrobes.MOTH.familiar.options,
  accessory: wardrobes.MOTH.accessory.options,
} as const

/* ------------------------------------------------------------------ *
 * Voxel builder.
 *
 * Characters are authored as 2D pixel grids and extruded into cubes.
 * Every grid is GRID columns wide and every row must be exactly that
 * long, otherwise voxels silently shift or vanish — grid() enforces it.
 *
 * Palette keys, shared by all four designs:
 *   R/r  main covering (robe · bark · casing · suit)   C trim
 *   H/h  headgear main/dark   B/b brim + underside   D headgear band
 *   F face recess   E eyes (glow)   S skin   O boots/roots   G belt
 *   M metal plate   P copper   V vent glow   I visor glow
 *   Y gloves/clamps   W moss   A twig/stem   N fungus
 * ------------------------------------------------------------------ */

const GRID = 18
/** Cubes overlap slightly. Anything under 1 leaves gaps you can see the sky through. */
const VOXEL_FILL = 1.02

const emissiveKeys = new Set(['E', 'I', 'V'])

type Palette = Record<string, string>

/** A short row silently shifts every voxel after it, so normalise and shout. */
function grid(name: string, rows: string[]) {
  return rows.map((row, index) => {
    if (row.length === GRID) return row
    console.error(`character design "${name}" row ${index} is ${row.length} wide, expected ${GRID}`)
    return row.length > GRID ? row.slice(0, GRID) : row + '.'.repeat(GRID - row.length)
  })
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
function buildSprite(rows: string[], palette: Palette, worldHeight: number, depth: number) {
  const group = new THREE.Group()
  const height = rows.length
  const cell = worldHeight / height
  const fill = cell * VOXEL_FILL
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
      for (let z = 0; z < depth; z++) {
        if (enclosed && z > 0 && z < depth - 1) continue
        const matrix = new THREE.Matrix4().setPosition(
          offsetX,
          (height - 1 - y) * cell + cell / 2,
          (z - (depth - 1) / 2) * cell,
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

/* ------------------------------------------------------------------ *
 * Prop helpers. Props are built from solid primitives — an open frame
 * of posts and bars leaves interior gaps you can see the world through.
 * ------------------------------------------------------------------ */

function solid(color: string, roughness = 0.82, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function glowMaterial(color: string, intensity = 1.8) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.25 })
}

function slab(
  parent: THREE.Object3D,
  size: [number, number, number],
  pos: [number, number, number],
  material: THREE.Material,
  rotation?: [number, number, number],
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...pos)
  if (rotation) mesh.rotation.set(...rotation)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

/**
 * Where a projectile is born, in the local space of whatever it is added to.
 * Parented to the held prop so it travels with a staff lift or an arm swing:
 * a bolt genuinely leaves the lantern glass rather than the character's feet.
 */
function markCastOrigin(parent: THREE.Object3D, pos: [number, number, number]) {
  const origin = new THREE.Object3D()
  origin.name = 'castOrigin'
  origin.position.set(...pos)
  parent.add(origin)
  return origin
}

/** Geometry context handed to every prop builder. */
type Ctx = {
  cell: number
  /** Half-width of the widest voxel row, in metres. */
  reach: number
  /** Feet to crown, in metres. */
  height: number
  /**
   * Z just clear of the front face. The four archetypes are extruded to
   * different depths, so a prop pinned to a fixed multiple of `cell` sits
   * proud of WICK and buried inside LOAM.
   */
  front: number
  /** World-space Y of the centre of one grid row. */
  y: (row: number) => number
}

/* ------------------------------------------------------------------ *
 * WICK · lamplighter. The one true robed figure in the roster.
 * Cone hat on a cowled head, floor-length robe, hands at the sides.
 * ------------------------------------------------------------------ */

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

const wickHats: Record<MothStyle['hat'], string[]> = {
  crooked: buildHatRows(hatSpecs.crooked),
  moon: buildHatRows(hatSpecs.moon),
  witch: buildHatRows(hatSpecs.witch),
  traveler: buildHatRows(hatSpecs.traveler),
  starfold: buildHatRows(hatSpecs.starfold),
}

// Narrow shoulders under a short cape, robe flaring to a floor-length hem.
const wickBody = grid('WICK', [
  '.....CCCCCCCC.....',
  '....CCFFFFFFCC....',
  '....CFFEFFEFFC....',
  '....CCFFFFFFCC....',
  '.....CCCCCCCC.....',
  '....CCCCCCCCCC....',
  '...CCCCCCCCCCCC...',
  '...RRRRRRRRRRRR...',
  '..SRRRRRRRRRRRRS..',
  '..SRRRRRRRRRRRRS..',
  '...RRRGGGGGGRRR...',
  '...RRRRRRRRRRRR...',
  '...RRRRRRRRRRRR...',
  '...RRRRRRRRRRRR...',
  '..RRRRRRRRRRRRRR..',
  '..RRRRRRRRRRRRRR..',
  '..RRRRRRRRRRRRRR..',
  '..RRRRRRRRRRRRRR..',
  '..rrrrrrrrrrrrrr..',
  '....OOO....OOO....',
])

const wickRobes: Record<MothStyle['robe'], { main: string; dark: string; trim: string }> = {
  midnight: { main: '#2f3b62', dark: '#1d2440', trim: '#4a5b8c' },
  plum: { main: '#4b3860', dark: '#2f2340', trim: '#9b7fc4' },
  moss: { main: '#415a4a', dark: '#2a3b32', trim: '#8aa06a' },
  ember: { main: '#6d3a2e', dark: '#43211a', trim: '#c9763e' },
  slate: { main: '#3c454f', dark: '#262d35', trim: '#9aa7b3' },
}

const wickHatColors: Record<MothStyle['hat'], { main: string; dark: string; brim: string; under: string; band: string }> = {
  crooked: { main: '#d5a64b', dark: '#a87c31', brim: '#c9953e', under: '#7a5726', band: '#5f4430' },
  moon: { main: '#8878ad', dark: '#5f5280', brim: '#7d6da2', under: '#473c63', band: '#4a3c52' },
  witch: { main: '#b1712f', dark: '#84501f', brim: '#a56729', under: '#623b16', band: '#4e3a26' },
  traveler: { main: '#9b6a3e', dark: '#714a29', brim: '#8d5f36', under: '#52371e', band: '#59422c' },
  starfold: { main: '#5a5d92', dark: '#3f416b', brim: '#535688', under: '#2f3050', band: '#414466' },
}

/** WICK's staff and lantern. Built solid; an open lantern frame shows daylight through it. */
function buildLanternStaff(ctx: Ctx) {
  const { cell, height } = ctx
  const staff = new THREE.Group()
  const wood = solid('#6b4d36', 0.85)
  const brass = solid('#b6813d', 0.4, 0.6)
  const pole = slab(staff, [cell * 1.1, height * 0.86, cell * 1.1], [0, height * 0.43, 0], wood)
  pole.name = 'staffPole'

  const arm = cell * 2.6
  const hookY = height * 0.84
  slab(staff, [arm, cell * 1.1, cell * 1.1], [arm / 2, hookY, 0], brass)
  const lanternY = height * 0.66
  slab(staff, [cell * 0.6, hookY - lanternY, cell * 0.6], [arm, (hookY + lanternY) / 2, 0], brass)

  const lantern = new THREE.Group()
  lantern.position.set(arm, lanternY, 0)
  slab(lantern, [cell * 2.8, cell * 2.6, cell * 2.8], [0, 0, 0], glowMaterial('#f0b84d', 2.4))
  for (const y of [cell * 1.9, -cell * 1.9]) slab(lantern, [cell * 3.4, cell * 1.2, cell * 3.4], [0, y, 0], brass)
  // Corner ribs overlap the core, so there is no line of sight between them.
  for (const x of [-cell * 1.3, cell * 1.3]) {
    for (const z of [-cell * 1.3, cell * 1.3]) slab(lantern, [cell * 0.9, cell * 3.2, cell * 0.9], [x, 0, z], brass)
  }
  lantern.add(new THREE.PointLight('#f0b84d', 1.4, 4))
  staff.add(lantern)
  markCastOrigin(staff, [arm, lanternY, cell * 2])
  return staff
}

function wickAccessory(style: MothStyle, ctx: Ctx) {
  const group = new THREE.Group()
  const { cell, height } = ctx
  const side = ctx.reach + cell * 2

  if (style.accessory === 'lantern') {
    const staff = buildLanternStaff(ctx)
    staff.position.set(side, 0, cell * 2.6)
    staff.rotation.z = -0.05
    group.add(staff)
    return group
  }
  if (style.accessory === 'satchel') {
    slab(group, [cell * 3.4, cell * 3.4, cell], [-side * 0.82, height * 0.3, cell * 3], solid('#6d5238', 0.9))
    ;['#7bc9ce', '#d5a64b', '#c96f8f'].forEach((color, index) => {
      slab(group, [cell * 0.9, cell * 2, cell * 0.9], [-side * 0.82 + (index - 1) * cell * 1.2, height * 0.36, cell * 3.4], glowMaterial(color, 1.1))
    })
    markCastOrigin(group, [side * 0.9, ctx.y(24), cell * 3])
    return group
  }
  if (style.accessory === 'talisman') {
    slab(group, [cell * 0.6, cell * 3, cell * 0.6], [0, height * 0.47, cell * 3], solid('#b6813d', 0.4, 0.6))
    const disc = new THREE.Mesh(
      new THREE.OctahedronGeometry(cell * 1.9),
      new THREE.MeshStandardMaterial({ color: '#e0b458', emissive: '#8a5f1d', emissiveIntensity: 0.9, metalness: 0.7, roughness: 0.3 }),
    )
    disc.position.set(0, height * 0.38, cell * 3.2)
    group.add(disc)
    markCastOrigin(group, [0, height * 0.38, cell * 3.6])
    return group
  }
  if (style.accessory === 'book') {
    for (const [color, w, d] of [['#7d4550', 3, 1], ['#e5ddc8', 2.6, 1.4]] as const) {
      slab(group, [cell * w, cell * 4, cell * d], [-side * 0.9, height * 0.34, cell * (d === 1 ? 3 : 3.3)], solid(color, 0.88), [0, 0, 0.18])
    }
    markCastOrigin(group, [-side * 0.9, height * 0.42, cell * 4])
    return group
  }
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(cell * 1.8, cell * 1.8, cell * 0.8, 8),
    solid('#c79a48', 0.3, 0.7),
  )
  housing.rotation.x = Math.PI / 2
  housing.position.set(side * 0.72, height * 0.4, cell * 3.2)
  group.add(housing)
  slab(group, [cell * 0.5, cell * 2.4, cell * 0.5], [side * 0.72, height * 0.4, cell * 3.6], glowMaterial('#7bc9ce', 1.4), [0, 0, 0.5])
  markCastOrigin(group, [side * 0.72, height * 0.4, cell * 4])
  return group
}

/* ------------------------------------------------------------------ *
 * LOAM · grovewalker. A hollow stump that got up: barrel body, knothole
 * eyes, no neck, no arms, roots for feet, and something growing on top.
 * ------------------------------------------------------------------ */

const LOAM_CROWN_ROWS = 6

const loamCrowns: Record<MothStyle['hat'], string[]> = {
  crooked: grid('LOAM fern', [
    '.......H..H.......',
    '......HH..HH......',
    '.....HHH..HHH.....',
    '......HHHHHH......',
    '.......AAAA.......',
    '.......AAAA.......',
  ]),
  moon: grid('LOAM toadstool', [
    '..................',
    '.....HHHHHHHH.....',
    '....HHDHHHHDHH....',
    '....HHHHHHHHHH....',
    '.....hhhhhhhh.....',
    '.......AAAA.......',
  ]),
  witch: grid('LOAM antler', [
    '...H..........H...',
    '...H...H..H...H...',
    '....H..H..H..H....',
    '.....H.H..H.H.....',
    '......HH..HH......',
    '.......AAAA.......',
  ]),
  traveler: grid('LOAM lichen', [
    '..................',
    '..................',
    '...HHHHHHHHHHHH...',
    '..HHHHHHHHHHHHHH..',
    '...hhhhhhhhhhhh...',
    '.......AAAA.......',
  ]),
  starfold: grid('LOAM blossom', [
    '....DHD....DHD....',
    '.....A......A.....',
    '......A....A......',
    '.......A..A.......',
    '.......HHHH.......',
    '.......AAAA.......',
  ]),
}

// No shoulders, no neck, no arms: one barrel wider than it is tall, with a
// hollow in the front and bracket fungus low on one side, off-centre on purpose.
const loamBody = grid('LOAM', [
  '.....WWWWWWWW.....',
  '...WWWWWWWWWWWW...',
  '..RRRRRRRRRRRRRR..',
  '.RRRFFRRRRRRFFRRR.',
  '.RRRFERRRRRREFRRR.',
  'RRRRRRRFFFFRRRRRRR',
  'NRRRRRRFFFFRRRRRRR',
  'NNRRRRRRRRRRRRRRRR',
  'RRRRRRRRRRRRRRRRRN',
  '.rrrrrrrrrrrrrrrr.',
  '..OOOO......OOOO..',
])

const loamBarks: Record<MothStyle['robe'], { main: string; dark: string; trim: string }> = {
  midnight: { main: '#4a3a2c', dark: '#2b2119', trim: '#6b573c' },
  plum: { main: '#5c3a44', dark: '#38222a', trim: '#8a5a62' },
  moss: { main: '#44583c', dark: '#293626', trim: '#7f9a5c' },
  ember: { main: '#6d4426', dark: '#402715', trim: '#c07a34' },
  slate: { main: '#8e8a7c', dark: '#5b584e', trim: '#c7c2ae' },
}

const loamCrownColors: Record<MothStyle['hat'], { main: string; dark: string; accent: string }> = {
  crooked: { main: '#6f8f4a', dark: '#4a6330', accent: '#c9d98a' },
  moon: { main: '#b8493c', dark: '#7a2e26', accent: '#efe3c8' },
  witch: { main: '#7a6146', dark: '#51402d', accent: '#9c8763' },
  traveler: { main: '#a8b58c', dark: '#74805d', accent: '#d6dfc0' },
  starfold: { main: '#7f9a5c', dark: '#54663c', accent: '#e6a9c4' },
}

function loamAccessory(style: MothStyle, ctx: Ctx) {
  const group = new THREE.Group()
  const { cell } = ctx
  const side = ctx.reach + cell * 1.2
  const shoulder = ctx.y(LOAM_CROWN_ROWS + 2)
  // LOAM is extruded nine layers deep, so anything pinned to a small multiple
  // of `cell` ends up inside the barrel. Everything here hangs off the front face.
  const f = ctx.front

  if (style.accessory === 'lantern') {
    // Glowing caps growing straight out of the bark, in place of a held light.
    const caps = new THREE.Group()
    caps.position.set(side * 0.72, shoulder, f - cell * 0.4)
    const glow = glowMaterial('#f2d488', 2.2)
    for (const [x, y, s] of [[0, 0, 2.3], [cell * 1.8, -cell * 1.1, 1.5], [-cell * 1.6, -cell * 1.4, 1.2]] as const) {
      slab(caps, [cell * s, cell * s * 0.7, cell * s], [x, y, 0], glow)
      slab(caps, [cell * s * 0.4, cell * 1.2, cell * s * 0.4], [x, y - cell * 1, 0], solid('#d8cbae', 0.9))
    }
    caps.add(new THREE.PointLight('#f2d488', 1.2, 3.4))
    group.add(caps)
    markCastOrigin(group, [side * 0.72, shoulder + cell, f + cell])
    return group
  }
  if (style.accessory === 'satchel') {
    slab(group, [cell * 3.6, cell * 3, cell * 1.4], [-side * 0.8, ctx.y(LOAM_CROWN_ROWS + 7), f], solid('#8a7a4e', 0.95))
    slab(group, [cell * 0.8, cell * 5, cell * 0.8], [-side * 0.8, ctx.y(LOAM_CROWN_ROWS + 4), f], solid('#6f6238', 0.95), [0, 0, -0.25])
    ;['#8fa64a', '#b8a24a', '#c9a25a'].forEach((color, index) => {
      slab(group, [cell * 0.9, cell * 1.4, cell * 0.9], [-side * 0.8 + (index - 1) * cell * 1.2, ctx.y(LOAM_CROWN_ROWS + 6), f + cell * 0.6], solid(color, 0.9))
    })
    markCastOrigin(group, [side * 0.9, ctx.y(LOAM_CROWN_ROWS + 6), f])
    return group
  }
  if (style.accessory === 'talisman') {
    // Resin set into the trunk itself, so it reads as part of the creature.
    slab(group, [cell * 2.6, cell * 2.6, cell * 1.6], [0, ctx.y(LOAM_CROWN_ROWS + 7), f - cell * 0.4], glowMaterial('#e0a13c', 1.5))
    slab(group, [cell * 3.6, cell * 3.6, cell * 1.1], [0, ctx.y(LOAM_CROWN_ROWS + 7), f - cell * 0.8], solid('#3b2d1e', 0.95))
    markCastOrigin(group, [0, ctx.y(LOAM_CROWN_ROWS + 7), f + cell * 0.6])
    return group
  }
  if (style.accessory === 'book') {
    slab(group, [cell * 3.4, cell * 4.4, cell * 0.9], [-side * 0.72, ctx.y(LOAM_CROWN_ROWS + 6), f], solid('#6b5335', 0.95), [0, 0, 0.2])
    for (const [i, color] of ['#8fa64a', '#c07a34', '#d6dfc0'].entries()) {
      slab(group, [cell * 1.6, cell * 0.8, cell * 0.5], [-side * 0.72 + cell * 0.4, ctx.y(LOAM_CROWN_ROWS + 5) - i * cell * 1.2, f + cell * 0.5], solid(color, 0.9), [0, 0, 0.2])
    }
    markCastOrigin(group, [-side * 0.72, ctx.y(LOAM_CROWN_ROWS + 5), f + cell])
    return group
  }
  slab(group, [cell * 2.8, cell * 2, cell * 2.4], [side * 0.7, ctx.y(LOAM_CROWN_ROWS + 8), f - cell * 0.2], solid('#77808a', 0.6))
  const drop = new THREE.Mesh(new THREE.OctahedronGeometry(cell * 1.1), glowMaterial('#9ad7db', 2))
  drop.position.set(side * 0.7, ctx.y(LOAM_CROWN_ROWS + 6), f - cell * 0.2)
  group.add(drop)
  group.add(new THREE.PointLight('#9ad7db', 0.7, 2.4))
  markCastOrigin(group, [side * 0.7, ctx.y(LOAM_CROWN_ROWS + 6), f + cell * 0.4])
  return group
}

/* ------------------------------------------------------------------ *
 * KILN · forge-walker. Squat brass casing, a furnace grate for a chest,
 * a sunken head with a visor slit, and one oversized clamp arm.
 * ------------------------------------------------------------------ */

const KILN_CROWN_ROWS = 6

const kilnCrowns: Record<MothStyle['hat'], string[]> = {
  crooked: grid('KILN bent flue', [
    '..........VVV.....',
    '..........HHH.....',
    '.........HHH......',
    '........HHH.......',
    '.......HHH........',
    '......DDDDD.......',
  ]),
  moon: grid('KILN ash cowl', [
    '..................',
    '..................',
    '.....HHHHHHHH.....',
    '....HHHHHHHHHH....',
    '....hhhhhhhhhh....',
    '.....DDDDDDDD.....',
  ]),
  witch: grid('KILN tall stack', [
    '.......VVVV.......',
    '.......HHHH.......',
    '.......HHHH.......',
    '.......HHHH.......',
    '......HHHHHH......',
    '.....DDDDDDDD.....',
  ]),
  traveler: grid('KILN flat hood', [
    '..................',
    '..................',
    '..................',
    '...HHHHHHHHHHHH...',
    '..hhhhhhhhhhhhhh..',
    '.....DDDDDDDD.....',
  ]),
  starfold: grid('KILN split vents', [
    '.....V......V.....',
    '.....H......H.....',
    '.....H.HHHH.H.....',
    '.....HHHHHHHH.....',
    '.....hhhhhhhh.....',
    '.....DDDDDDDD.....',
  ]),
}

// Lopsided on purpose: a short piston arm on one side, a clamp that reaches
// well past the casing on the other, and short legs with daylight between them.
const kilnBody = grid('KILN', [
  '......MMMMMM......',
  '......MIIIIM......',
  '......MMMMMM......',
  '.....MMMMMMMM.....',
  '....PMMMMMMMMP....',
  '...PPRRRRRRRRMMMM.',
  '...PPRVRVVRVRMMMM.',
  '...PPRVRVVRVRMMMM.',
  '...PPRVRVVRVRMMMM.',
  '...YYRRRRRRRRMMMMM',
  '....PRRRRRRRRYYYYY',
  '....GGGGGGGGGYYYYY',
  '....RRRRRRRRRR....',
  '....rrrrrrrrrr....',
  '.....OOO..OOO.....',
  '.....OOO..OOO.....',
  '....OOOO..OOOO....',
])

const kilnCasings: Record<MothStyle['robe'], { main: string; dark: string; trim: string }> = {
  midnight: { main: '#3b4450', dark: '#252b34', trim: '#79848f' },
  plum: { main: '#6a2f33', dark: '#411b1e', trim: '#a8565a' },
  moss: { main: '#3e6357', dark: '#274038', trim: '#79ab97' },
  ember: { main: '#7a4626', dark: '#4c2915', trim: '#c9803c' },
  slate: { main: '#6f7378', dark: '#474b50', trim: '#adb2b8' },
}

const kilnFlueColors: Record<MothStyle['hat'], { main: string; dark: string; accent: string }> = {
  crooked: { main: '#5a4b3f', dark: '#3a2f27', accent: '#b9763c' },
  moon: { main: '#4f4a44', dark: '#32302c', accent: '#8c8578' },
  witch: { main: '#6b5344', dark: '#453428', accent: '#c08a4a' },
  traveler: { main: '#55606a', dark: '#363e46', accent: '#9aa7b3' },
  starfold: { main: '#7a6a52', dark: '#4d4335', accent: '#d5a64b' },
}

function kilnAccessory(style: MothStyle, ctx: Ctx) {
  const group = new THREE.Group()
  const { cell } = ctx
  const clampY = ctx.y(KILN_CROWN_ROWS + 10)
  const side = ctx.reach + cell * 1.6
  const iron = solid('#4e5157', 0.45, 0.6)
  const brass = solid('#c79a48', 0.35, 0.65)
  // Seven layers deep: front and back props are placed off the faces, not off `cell`.
  const f = ctx.front

  if (style.accessory === 'lantern') {
    // Long-handled scoop held out by the clamp, with live coals in the pan.
    const scoop = new THREE.Group()
    scoop.position.set(side, clampY, f - cell)
    slab(scoop, [cell * 7, cell * 0.9, cell * 0.9], [-cell * 2, 0, 0], solid('#6b4d36', 0.9), [0, 0, 0.18])
    slab(scoop, [cell * 3.4, cell * 1, cell * 3], [cell * 2, cell * 0.6, 0], iron)
    slab(scoop, [cell * 3, cell * 1.2, cell * 2.6], [cell * 2, cell * 1.4, 0], glowMaterial('#ff8a3d', 2.6))
    scoop.add(new THREE.PointLight('#ff8a3d', 1.5, 3.6))
    group.add(scoop)
    markCastOrigin(group, [side + cell * 2, clampY + cell * 2, f - cell])
    return group
  }
  if (style.accessory === 'satchel') {
    // Slung to the back corner rather than squarely behind: a crate centred on
    // the spine disappears entirely behind a body this wide.
    const crateY = ctx.y(KILN_CROWN_ROWS + 6)
    const crateX = -(ctx.reach * 0.62)
    slab(group, [cell * 5, cell * 4.4, cell * 3], [crateX, crateY, -(f + cell * 0.2)], solid('#7a5a38', 0.92))
    slab(group, [cell * 5.4, cell * 0.7, cell * 3.2], [crateX, crateY + cell * 1.8, -(f + cell * 0.2)], solid('#4a3524', 0.9))
    slab(group, [cell * 0.9, cell * 6, cell * 0.9], [crateX + cell * 2, crateY + cell * 2.4, -(f - cell * 2)], solid('#4a3524', 0.9), [0, 0, -0.3])
    markCastOrigin(group, [side, clampY, f - cell])
    return group
  }
  if (style.accessory === 'talisman') {
    const chestY = ctx.y(KILN_CROWN_ROWS + 7)
    slab(group, [cell * 3.2, cell * 3.2, cell * 1], [-cell * 4.6, chestY, f], brass)
    slab(group, [cell * 1.6, cell * 1.6, cell * 1.4], [-cell * 4.6, chestY, f + cell * 0.2], glowMaterial('#f0b84d', 1.4))
    markCastOrigin(group, [side, clampY, f - cell])
    return group
  }
  if (style.accessory === 'book') {
    slab(group, [cell * 3.4, cell * 4.6, cell * 0.8], [side * 0.9, ctx.y(KILN_CROWN_ROWS + 10), f + cell * 0.2], iron, [0, 0, 0.16])
    for (let i = 0; i < 3; i++) {
      slab(group, [cell * 2.2, cell * 0.4, cell * 0.5], [side * 0.9, ctx.y(KILN_CROWN_ROWS + 10) + (1 - i) * cell * 1.2, f + cell * 0.6], brass, [0, 0, 0.16])
    }
    markCastOrigin(group, [side * 0.9, ctx.y(KILN_CROWN_ROWS + 10), f + cell])
    return group
  }
  const dialY = ctx.y(KILN_CROWN_ROWS + 7)
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(cell * 2, cell * 2, cell * 0.9, 10), brass)
  dial.rotation.x = Math.PI / 2
  dial.position.set(-cell * 4.4, dialY, f + cell * 0.2)
  group.add(dial)
  slab(group, [cell * 0.5, cell * 2.6, cell * 0.5], [-cell * 4.4, dialY, f + cell * 0.7], glowMaterial('#ff8a3d', 1.8), [0, 0, -0.7])
  markCastOrigin(group, [side, clampY, f - cell])
  return group
}

/** Bellows and pipework welded to KILN's back, plus the light from the grate. */
function kilnExtras(ctx: Ctx) {
  const parts: THREE.Object3D[] = []
  const { cell, front: f } = ctx
  const back = new THREE.Group()
  back.name = 'bellows'
  const bodyY = ctx.y(KILN_CROWN_ROWS + 7)
  slab(back, [cell * 6, cell * 4.4, cell * 2.4], [0, bodyY, -(f + cell * 0.4)], solid('#5a4331', 0.92))
  slab(back, [cell * 6.4, cell * 0.8, cell * 2.6], [0, bodyY + cell * 2, -(f + cell * 0.4)], solid('#8a6a3f', 0.6, 0.3))
  for (const x of [-cell * 2.2, cell * 2.2]) {
    slab(back, [cell * 1, cell * 5.5, cell * 1], [x, bodyY + cell * 4, -f], solid('#b9763c', 0.4, 0.6))
  }
  parts.push(back)

  const fire = new THREE.PointLight('#ff8a3d', 1.6, 3.2)
  fire.name = 'furnaceGlow'
  fire.position.set(0, ctx.y(KILN_CROWN_ROWS + 7), ctx.front)
  parts.push(fire)
  return parts
}

/* ------------------------------------------------------------------ *
 * VANE · stormdiver. Sealed plate, dome helmet with a visor band where
 * a face should be, split legs, thruster pack. No cloth anywhere.
 * ------------------------------------------------------------------ */

const VANE_CROWN_ROWS = 7

const vaneHelmets: Record<MothStyle['hat'], string[]> = {
  crooked: grid('VANE swept crest', [
    '..................',
    '..................',
    '........DDD.......',
    '.......DDDD.......',
    '......HHHHHHH.....',
    '......HHHHHH......',
    '.....HHHHHHHH.....',
  ]),
  moon: grid('VANE hook antenna', [
    '....VV............',
    '.....D............',
    '......D...........',
    '......D...........',
    '......HHHHHH......',
    '......HHHHHH......',
    '.....HHHHHHHH.....',
  ]),
  witch: grid('VANE spire vane', [
    '........V.........',
    '........D.........',
    '.......DDD........',
    '.......DDD........',
    '......HHHHHH......',
    '......HHHHHH......',
    '.....HHHHHHHH.....',
  ]),
  traveler: grid('VANE low dome', [
    '..................',
    '..................',
    '..................',
    '.......HHHH.......',
    '......HHHHHH......',
    '.....HHHHHHHH.....',
    '....HHHHHHHHHH....',
  ]),
  starfold: grid('VANE split fins', [
    '..................',
    '.....D......D.....',
    '.....DD....DD.....',
    '.....DDH..HDD.....',
    '......HHHHHH......',
    '......HHHHHH......',
    '.....HHHHHHHH.....',
  ]),
}

// Narrow and hard-edged: pauldrons, a lit core, gauntlets, and split legs.
const vaneBody = grid('VANE', [
  '.....HHHHHHHH.....',
  '.....HIIIIIIH.....',
  '.....hhhhhhhh.....',
  '......MMMMMM......',
  '....MMMMMMMMMM....',
  '...MMRRRRRRRRMM...',
  '...MMRRRVVRRRMM...',
  '...MMRRRVVRRRMM...',
  '....YRRRVVRRRY....',
  '....YRRRRRRRRY....',
  '.....RGGGGGGR.....',
  '.....RRRRRRRR.....',
  '.....RRRRRRRR.....',
  '.....RRRRRRRR.....',
  '.....RRR..RRR.....',
  '.....RRR..RRR.....',
  '....MRRR..RRRM....',
  '.....RRR..RRR.....',
  '....OOOO..OOOO....',
  '....OOOO..OOOO....',
])

const vaneSuits: Record<MothStyle['robe'], { main: string; dark: string; trim: string }> = {
  midnight: { main: '#2f3a66', dark: '#1c2340', trim: '#6d7fb8' },
  plum: { main: '#463560', dark: '#2b2040', trim: '#9a7fc4' },
  moss: { main: '#2f5a58', dark: '#1c3937', trim: '#74b6ae' },
  ember: { main: '#6d3f2c', dark: '#43251a', trim: '#c9803c' },
  slate: { main: '#8d949c', dark: '#5c6268', trim: '#d6dbe0' },
}

const vaneHelmetColors: Record<MothStyle['hat'], { main: string; dark: string; accent: string }> = {
  crooked: { main: '#c6ccd4', dark: '#8c939b', accent: '#d5a64b' },
  moon: { main: '#aeb6c0', dark: '#787f89', accent: '#7bc9ce' },
  witch: { main: '#b9bec6', dark: '#83888f', accent: '#9580b8' },
  traveler: { main: '#9ea6ae', dark: '#6c737a', accent: '#b6813d' },
  starfold: { main: '#cdd3da', dark: '#939aa2', accent: '#7bc9ce' },
}

function vaneAccessory(style: MothStyle, ctx: Ctx) {
  const group = new THREE.Group()
  const { cell } = ctx
  const handY = ctx.y(VANE_CROWN_ROWS + 8)
  const side = ctx.reach + cell * 1.6
  const plate = solid('#aab1ba', 0.4, 0.5)

  if (style.accessory === 'lantern') {
    const rod = new THREE.Group()
    rod.position.set(side, handY, cell * 3)
    slab(rod, [cell * 0.7, cell * 9, cell * 0.7], [0, cell * 1.6, 0], plate, [0, 0, 0.08])
    slab(rod, [cell * 1.1, cell * 1.1, cell * 1.1], [cell * 0.5, cell * 6.2, 0], glowMaterial('#9ad7db', 2.8))
    slab(rod, [cell * 0.9, cell * 0.9, cell * 0.9], [cell * 0.4, cell * 5.1, 0], glowMaterial('#9ad7db', 1.6))
    rod.add(new THREE.PointLight('#9ad7db', 1.3, 3.6))
    group.add(rod)
    markCastOrigin(group, [side + cell * 0.6, handY + cell * 7, cell * 3])
    return group
  }
  if (style.accessory === 'satchel') {
    slab(group, [cell * 4, cell * 3, cell * 2], [-side * 0.85, ctx.y(VANE_CROWN_ROWS + 11), cell * 2.6], plate)
    slab(group, [cell * 4.2, cell * 0.6, cell * 2.2], [-side * 0.85, ctx.y(VANE_CROWN_ROWS + 10) - cell * 0.4, cell * 2.6], solid('#3a3f4a', 0.8))
    slab(group, [cell * 1, cell * 1, cell * 0.8], [-side * 0.85, ctx.y(VANE_CROWN_ROWS + 11), cell * 3.6], glowMaterial('#7bc9ce', 1.6))
    markCastOrigin(group, [side, handY, cell * 3])
    return group
  }
  if (style.accessory === 'talisman') {
    const sigil = new THREE.Mesh(new THREE.OctahedronGeometry(cell * 1.8), glowMaterial('#7bc9ce', 2.2))
    sigil.position.set(side * 0.95, ctx.y(VANE_CROWN_ROWS + 4), cell * 2.4)
    group.add(sigil)
    group.add(new THREE.PointLight('#7bc9ce', 0.9, 2.8))
    markCastOrigin(group, [side * 0.95, ctx.y(VANE_CROWN_ROWS + 4), cell * 3.2])
    return group
  }
  if (style.accessory === 'book') {
    slab(group, [cell * 4.4, cell * 3, cell * 0.7], [side * 0.8, ctx.y(VANE_CROWN_ROWS + 8), cell * 3.4], plate, [0, 0, 0.12])
    slab(group, [cell * 3.6, cell * 2.2, cell * 0.5], [side * 0.8, ctx.y(VANE_CROWN_ROWS + 8), cell * 3.8], glowMaterial('#9ad7db', 1.3), [0, 0, 0.12])
    markCastOrigin(group, [side * 0.8, ctx.y(VANE_CROWN_ROWS + 8), cell * 4.2])
    return group
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(cell * 2, cell * 0.4, 4, 12), plate)
  ring.position.set(side, handY, cell * 3)
  group.add(ring)
  const bead = new THREE.Mesh(new THREE.IcosahedronGeometry(cell * 0.8, 0), glowMaterial('#d5a64b', 2))
  bead.position.set(side + cell * 2, handY, cell * 3)
  group.add(bead)
  markCastOrigin(group, [side + cell * 2, handY, cell * 3.4])
  return group
}

/** VANE's thruster pack. Welded to the body so it leans with every pose. */
function vaneExtras(ctx: Ctx) {
  const { cell } = ctx
  const pack = new THREE.Group()
  pack.name = 'thruster'
  const bodyY = ctx.y(VANE_CROWN_ROWS + 7)
  slab(pack, [cell * 6, cell * 5, cell * 2.2], [0, bodyY, -cell * 3.2], solid('#828a94', 0.45, 0.4))
  slab(pack, [cell * 6.4, cell * 0.8, cell * 2.4], [0, bodyY + cell * 2.2, -cell * 3.2], solid('#3a3f4a', 0.7))
  for (const x of [-cell * 1.8, cell * 1.8]) {
    slab(pack, [cell * 1.8, cell * 2.4, cell * 1.8], [x, bodyY - cell * 3.2, -cell * 3.2], solid('#5c6268', 0.5, 0.4))
    slab(pack, [cell * 1.4, cell * 0.9, cell * 1.4], [x, bodyY - cell * 4.3, -cell * 3.2], glowMaterial('#9ad7db', 2.4))
  }
  const wash = new THREE.PointLight('#9ad7db', 1, 2.6)
  wash.name = 'thrusterGlow'
  wash.position.set(0, bodyY - cell * 4.4, -cell * 3.4)
  pack.add(wash)
  return [pack]
}

/* ------------------------------------------------------------------ *
 * Companions. One small library of shapes, re-themed per archetype, so
 * every option in the slot is a different silhouette and not a recolour.
 * ------------------------------------------------------------------ */

/**
 * Companions are sized in world units, not in the host's voxel size: LOAM's
 * cubes are 40% larger than WICK's, and a companion scaled off those landed
 * across the body instead of beside it.
 */
const COMPANION_UNIT = 0.09

type CompanionLook = { body: string; wingUpper: string; wingLower: string; glow: string; charm: string }

const companionLooks: Record<WizardId, CompanionLook> = {
  MOTH: { body: '#4a3b28', wingUpper: '#e0b665', wingLower: '#a87c31', glow: '#f0b84d', charm: '#7bc9ce' },
  BRAMBLE: { body: '#4c5a34', wingUpper: '#9ab866', wingLower: '#61793c', glow: '#8fe0a6', charm: '#c9d98a' },
  CINDER: { body: '#3a3129', wingUpper: '#c98a4a', wingLower: '#7c4a22', glow: '#ff8a3d', charm: '#d5a64b' },
  ORBIT: { body: '#cdd3da', wingUpper: '#e6ecf2', wingLower: '#8d949c', glow: '#9ad7db', charm: '#7bc9ce' },
}

/** Wings hang off a pivot so flapping rotates about the spine. */
function addWings(parent: THREE.Object3D, cell: number, upper: string, lower: string, stiff: boolean) {
  const wings: THREE.Object3D[] = []
  const segments: Array<[number, number, number, number, 0 | 1]> = stiff
    ? [
        [3.2, 0.7, 2, 0.9, 0],
        [2, 0.6, 3.7, 0.4, 0],
      ]
    : [
        [2.6, 2.8, 1.7, 0.9, 0],
        [1.8, 1.9, 3.5, 1.8, 0],
        [2.1, 1.7, 1.5, -1.3, 1],
        [1.3, 1.1, 2.9, -2.0, 1],
      ]
  for (const dir of [-1, 1]) {
    const pivot = new THREE.Group()
    for (const [w, h, x, y, tier] of segments) {
      slab(pivot, [cell * w, cell * h, cell * 0.5], [dir * cell * x, cell * y, 0], solid(tier ? lower : upper, 0.72))
    }
    parent.add(pivot)
    wings.push(pivot)
  }
  return wings
}

function buildCompanion(id: WizardId, style: MothStyle, cell: number) {
  const companion = new THREE.Group()
  companion.name = 'familiar'
  const look = companionLooks[id]
  let wings: THREE.Object3D[] = []

  if (style.familiar === 'moth') {
    if (id === 'CINDER') {
      // An ember swarm rather than anything alive: three coals, no wings.
      for (const [x, y, s] of [[0, 0, 1.4], [cell * 1.8, cell * 1.2, 0.9], [-cell * 1.5, -cell * 1.1, 0.7]] as const) {
        slab(companion, [cell * s, cell * s, cell * s], [x, y, 0], glowMaterial(look.glow, 2.6))
      }
      companion.add(new THREE.PointLight(look.glow, 1.1, 2.8))
    } else {
      const stiff = id === 'ORBIT'
      slab(companion, [cell * 1.3, cell * (stiff ? 2.2 : 3.6), cell * 1.3], [0, 0, 0], solid(look.body, 0.8))
      if (stiff) slab(companion, [cell * 0.9, cell * 0.9, cell * 0.9], [0, cell * 1.6, cell * 0.5], glowMaterial(look.glow, 2))
      else {
        for (const dir of [-1, 1]) {
          slab(companion, [cell * 0.4, cell * 1.8, cell * 0.4], [dir * cell * 0.7, cell * 2.5, 0], solid(look.body, 0.8), [0, 0, dir * 0.45])
        }
      }
      wings = addWings(companion, cell, look.wingUpper, look.wingLower, stiff)
    }
  } else if (style.familiar === 'firefly') {
    slab(companion, [cell * 1.5, cell * 1.5, cell * 1.5], [0, 0, 0], glowMaterial(look.glow, 2.6))
    companion.add(new THREE.PointLight(look.glow, 1.1, 2.6))
  } else if (style.familiar === 'rune') {
    const rune = new THREE.Mesh(new THREE.OctahedronGeometry(cell * 2), glowMaterial(look.charm, 1.9))
    companion.add(rune)
  } else if (style.familiar === 'bat') {
    slab(companion, [cell * 1.3, cell * 3.2, cell * 1.3], [0, 0, 0], solid(look.body, 0.9))
    for (const dir of [-1, 1]) {
      slab(companion, [cell * 0.5, cell * 1.2, cell * 0.5], [dir * cell * 0.5, cell * 2.1, 0], solid(look.body, 0.9))
    }
    wings = addWings(companion, cell, look.wingLower, look.body, false)
  } else {
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(cell * 1.8, 1), glowMaterial(look.glow, 1.5))
    companion.add(orb)
  }

  companion.userData.wings = wings
  return companion
}

/* ------------------------------------------------------------------ *
 * The four archetypes.
 * ------------------------------------------------------------------ */

type Archetype = {
  /** Feet to crown in metres. Varying it is half of what makes the four read apart. */
  height: number
  /** Extrusion layers. LOAM is built deep so the barrel reads round, not slab-like. */
  depth: number
  crownRows: number
  crown: (hat: MothStyle['hat']) => string[]
  body: string[]
  palette: (style: MothStyle) => Palette
  /** Grid rows the combat anchors sit on, measured from the top of the full grid. */
  anchorRows: { head: number; chest: number; hand: number }
  accessory: (style: MothStyle, ctx: Ctx) => THREE.Object3D
  /** Props welded into the body sprite, so a lean or a lunge carries them along. */
  extras?: (ctx: Ctx) => THREE.Object3D[]
  /** Grid row the companion floats level with. Kept clear of hats, flues and crests. */
  companionRow: number
  /** How far out the companion sits, as a share of the figure's own half-width. */
  companionSide: number
}

const shared = (id: WizardId) => ({
  F: '#12151f',
  E: wizards[id].accent,
  S: '#c0a482',
  G: '#b6813d',
  O: '#1e2330',
})

const archetypes: Record<WizardId, Archetype> = {
  /* WICK */
  MOTH: {
    height: 3.62,
    depth: 5,
    crownRows: HAT_ROWS,
    crown: hat => wickHats[hat],
    body: wickBody,
    anchorRows: { head: HAT_ROWS + 2, chest: HAT_ROWS + 7, hand: HAT_ROWS + 8 },
    companionRow: HAT_ROWS + 4,
    companionSide: 1,
    accessory: wickAccessory,
    palette: style => {
      const robe = wickRobes[style.robe]
      const hat = wickHatColors[style.hat]
      return {
        ...shared('MOTH'),
        R: robe.main,
        r: robe.dark,
        C: robe.trim,
        H: hat.main,
        h: hat.dark,
        B: hat.brim,
        b: hat.under,
        D: hat.band,
        E: '#f7d98d',
      }
    },
  },

  /* LOAM */
  BRAMBLE: {
    height: 2.4,
    depth: 9,
    crownRows: LOAM_CROWN_ROWS,
    crown: hat => loamCrowns[hat],
    body: loamBody,
    anchorRows: { head: LOAM_CROWN_ROWS + 4, chest: LOAM_CROWN_ROWS + 6, hand: LOAM_CROWN_ROWS + 7 },
    // Negative rows are above the crown: a creature with no shoulders has
    // nowhere at its side for a companion to sit without overlapping it.
    companionRow: -1,
    companionSide: 0.62,
    accessory: loamAccessory,
    palette: style => {
      const bark = loamBarks[style.robe]
      const crown = loamCrownColors[style.hat]
      return {
        ...shared('BRAMBLE'),
        R: bark.main,
        r: bark.dark,
        C: bark.trim,
        H: crown.main,
        h: crown.dark,
        B: crown.main,
        b: crown.dark,
        D: crown.accent,
        A: '#6b5335',
        N: '#c98a4a',
        W: '#5f7a41',
        F: '#110d09',
        E: '#cfe07a',
        O: '#33251a',
      }
    },
  },

  /* KILN */
  CINDER: {
    height: 3.15,
    depth: 7,
    crownRows: KILN_CROWN_ROWS,
    crown: hat => kilnCrowns[hat],
    body: kilnBody,
    anchorRows: { head: KILN_CROWN_ROWS + 1, chest: KILN_CROWN_ROWS + 7, hand: KILN_CROWN_ROWS + 10 },
    companionRow: KILN_CROWN_ROWS + 1,
    companionSide: 0.62,
    accessory: kilnAccessory,
    extras: kilnExtras,
    palette: style => {
      const casing = kilnCasings[style.robe]
      const flue = kilnFlueColors[style.hat]
      return {
        ...shared('CINDER'),
        R: casing.main,
        r: casing.dark,
        C: casing.trim,
        H: flue.main,
        h: flue.dark,
        B: flue.main,
        b: flue.dark,
        D: flue.accent,
        M: '#8a8f96',
        P: '#b9763c',
        V: '#ff8a3d',
        I: '#ffb15c',
        Y: '#5b6068',
        O: '#2a2b31',
      }
    },
  },

  /* VANE */
  ORBIT: {
    height: 3.5,
    depth: 5,
    crownRows: VANE_CROWN_ROWS,
    crown: hat => vaneHelmets[hat],
    body: vaneBody,
    anchorRows: { head: VANE_CROWN_ROWS + 1, chest: VANE_CROWN_ROWS + 6, hand: VANE_CROWN_ROWS + 8 },
    companionRow: VANE_CROWN_ROWS + 6,
    companionSide: 1.35,
    accessory: vaneAccessory,
    extras: vaneExtras,
    palette: style => {
      const suit = vaneSuits[style.robe]
      const helmet = vaneHelmetColors[style.hat]
      return {
        ...shared('ORBIT'),
        R: suit.main,
        r: suit.dark,
        C: suit.trim,
        H: helmet.main,
        h: helmet.dark,
        B: helmet.main,
        b: helmet.dark,
        D: helmet.accent,
        M: '#a6adb6',
        V: '#9ad7db',
        I: '#7bc9ce',
        Y: '#3a3f4a',
        G: '#8a8f96',
        O: '#23262e',
      }
    },
  },
}

/** Every grid row must be exactly GRID wide; checked here as well as at authoring time. */
export function characterRows(id: WizardId, style: MothStyle = defaultMothStyle) {
  const archetype = archetypes[id]
  return [...archetype.crown(style.hat), ...archetype.body]
}

/* ------------------------------------------------------------------ *
 * Assembly.
 * ------------------------------------------------------------------ */

export function createWizard(id: WizardId, scale = 1, style: MothStyle = defaultMothStyle) {
  const archetype = archetypes[id]
  const root = new THREE.Group()
  root.scale.setScalar(scale)
  root.userData.characterId = id
  root.userData.displayName = wizards[id].name
  root.userData.element = wizards[id].element

  const rows = characterRows(id, style)
  // The body sprite stays the first, unnamed child: src/battle/rig.ts finds it
  // that way and poses it, so anything named has to come after it.
  const sprite = buildSprite(rows, archetype.palette(style), archetype.height, archetype.depth)
  const cell = sprite.userData.cell as number
  const reach = sprite.userData.reach as number
  const y = (row: number) => (rows.length - 1 - row) * cell + cell / 2
  const front = ((archetype.depth - 1) / 2 + 1) * cell
  const ctx: Ctx = { cell, reach, height: archetype.height, front, y }
  root.add(sprite)

  // Welded props ride inside the sprite group, so a lean or a lunge carries
  // them with the body instead of leaving them hanging in the air.
  for (const extra of archetype.extras?.(ctx) ?? []) sprite.add(extra)

  const accessory = archetype.accessory(style, ctx)
  accessory.name = 'accessory'
  root.add(accessory)

  const companion = buildCompanion(id, style, COMPANION_UNIT)
  // Held off the side by a share of the figure's own width: a fixed offset put
  // LOAM's companion a metre clear of a creature only two metres tall.
  companion.position.set(-(reach * archetype.companionSide + COMPANION_UNIT * 3), y(archetype.companionRow), front)
  companion.userData.restY = companion.position.y
  root.add(companion)

  /* Anchor points for combat. Named objects, so a caller can do
   *   character.getObjectByName('castOrigin').getWorldPosition(v)
   * and get the tip of the staff, the mouth of the scoop or the flare tip,
   * wherever the current wardrobe put it. `anchors` holds the same objects
   * plus the fixed body points for recoil, hit flashes and channel beams. */
  const anchor = (name: string, position: [number, number, number], parent: THREE.Object3D = sprite) => {
    const marker = new THREE.Object3D()
    marker.name = name
    marker.position.set(...position)
    parent.add(marker)
    return marker
  }
  const anchors = {
    head: anchor('head', [0, y(archetype.anchorRows.head), front]),
    chest: anchor('chest', [0, y(archetype.anchorRows.chest), front]),
    handRight: anchor('handRight', [reach, y(archetype.anchorRows.hand), front]),
    handLeft: anchor('handLeft', [-reach, y(archetype.anchorRows.hand), front]),
    feet: anchor('feet', [0, 0, 0]),
    cast: accessory.getObjectByName('castOrigin') ?? anchor('castOrigin', [reach, y(archetype.anchorRows.hand), front], accessory),
  }

  root.userData.cell = cell
  root.userData.reach = reach
  /** Feet to crown after the caller's scale, for nameplates and camera framing. */
  root.userData.height = archetype.height * scale
  root.userData.anchors = anchors
  root.userData.castOrigin = anchors.cast
  return root
}

/** Shared idle motion so previews, the player, and NPCs animate identically. */
export function animateCharacter(character: THREE.Object3D, time: number, phase = 0) {
  const flicker = character.getObjectByName('furnaceGlow') ?? character.getObjectByName('thrusterGlow')
  if (flicker instanceof THREE.PointLight) {
    const base = (flicker.userData.base as number) ?? (flicker.userData.base = flicker.intensity)
    flicker.intensity = base * (0.82 + Math.abs(Math.sin(time * 0.006 + phase)) * 0.35)
  }
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
