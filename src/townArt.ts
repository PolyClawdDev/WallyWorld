import * as THREE from 'three'
import { buildingSpecs, serviceNpcs, townLayout, SHIELDED_NOTICE } from './townData'
import type { BuildingKind, BuildingSpec } from './townData'
import { createBatch } from './voxelBuild'
import type { Batch, Surface } from './voxelBuild'
import { emblemPlate, emblemSize } from './emblems'
import type { EmblemId } from './emblems'

/* ------------------------------------------------------------------ *
 * The town.
 *
 * Every building here used to be the same object: a box four to nine
 * metres tall, a four-sided cone on top, two lit rectangles and a
 * floating word. The word was the only thing distinguishing a bakery
 * from a blacksmith, and nine metres is a shed.
 *
 * So this module builds each one out of its TRADE and builds it TALL:
 * a forge under a thirty-six metre hooded flue with the fire showing at
 * its mouth, an inn of six jettied storeys under a lantern, an archive
 * of stepped reading galleries, an observatory with a ribbed dome and a
 * telescope out of the shutter, and a spell tower whose crystal sits
 * ninety-six metres up. Five bridges cross between roofs. The silhouette
 * tells you what a building is before the sign does, and the skyline is
 * readable from the far side of the world.
 *
 * ---- What stayed still ----
 *
 * Not one FOOTPRINT moved. Every building keeps the x, z, width and
 * depth it had, because three separate things are keyed to those
 * numbers: `townObstacles()` in battle/nav.ts derives the blocking grid
 * from `buildingSpecs` directly, `townBuildings` in shared/zones.ts
 * duplicates them for the server's "inside town" test, and WorldMap
 * draws them. Height is read by none of the three. Growing upward is
 * therefore free of navigation risk in a way that growing outward is
 * not, and everything above is built upward.
 *
 * The bridges are the one thing that crosses a street, and they cross it
 * at fourteen metres and higher with nothing touching the ground in
 * between, so they are deliberately absent from the nav grid: a player
 * walks under them.
 *
 * ---- Cost ----
 *
 * All of it goes through one `Batch`. Boxes are collected, welded per
 * surface colour, and emitted as a couple of dozen meshes for the entire
 * district: seventeen buildings, their towers and spires, the bridges,
 * the yard clutter, the hanging signs' timber, and every trade emblem.
 * Detail is therefore nearly free here — a shutter, a barrel or a roof
 * course costs a few triangles and no draw call at all — which is the
 * whole reason the buildings could be given this much.
 *
 * The exceptions, and there are only two kinds:
 *   - lettered sign boards, one small mesh each, because text has to be
 *     a texture and has to stay readable from across the plaza. They are
 *     made by a factory the caller passes in, so this module still owns
 *     no canvas and no texture of its own;
 *   - nothing else. In particular there are NO point lights. Every one
 *     is another loop iteration in every material's fragment shader for
 *     every pixel, and a forge mouth or a tower crystal reads just as
 *     hot as an emissive surface, which costs nothing.
 * ------------------------------------------------------------------ */

/* ---- shared palette ------------------------------------------------ *
 * The bone/brass/leather/teal/purple set already in use elsewhere, named
 * once here so seventeen buildings cannot drift apart.
 * ------------------------------------------------------------------- */
const BONE: Surface = { color: '#e5ddc8', roughness: 0.86 }
const BONE_DIM: Surface = { color: '#c8c0ac', roughness: 0.88 }
const BRASS: Surface = { color: '#d5a64b', roughness: 0.42, metalness: 0.55 }
const BRASS_DARK: Surface = { color: '#9f7a34', roughness: 0.5, metalness: 0.5 }
const IRON: Surface = { color: '#3c4147', roughness: 0.55, metalness: 0.4 }
const IRON_DARK: Surface = { color: '#272b30', roughness: 0.6, metalness: 0.35 }
const TIMBER: Surface = { color: '#6b5544', roughness: 0.9 }
const TIMBER_DARK: Surface = { color: '#4b4037', roughness: 0.92 }
const TIMBER_PALE: Surface = { color: '#8a6848', roughness: 0.9 }
const STONE: Surface = { color: '#68777b', roughness: 0.92 }
const STONE_DARK: Surface = { color: '#4a5257', roughness: 0.94 }
const SLATE: Surface = { color: '#394247', roughness: 0.9 }
const DARK: Surface = { color: '#20252d', roughness: 0.9 }
const LEATHER: Surface = { color: '#70543c', roughness: 0.9 }
const CLOTH_CREAM: Surface = { color: '#ddd0ad', roughness: 0.95 }
const CLOTH_RED: Surface = { color: '#9c4b3c', roughness: 0.95 }
const TEAL: Surface = { color: '#7bc9ce', roughness: 0.5 }
const PURPLE: Surface = { color: '#9580b8', roughness: 0.6 }
const GREEN: Surface = { color: '#9ca66d', roughness: 0.9 }
const EMBER: Surface = { color: '#e35e35', glow: 2.6, roughness: 0.3, noShadow: true }
const EMBER_HOT: Surface = { color: '#f6c453', glow: 3.4, roughness: 0.25, noShadow: true }
const SMOKE: Surface = { color: '#9aa0a6', opacity: 0.4, roughness: 1, noShadow: true }
const STEAM: Surface = { color: '#cfe3e6', opacity: 0.32, roughness: 1, noShadow: true }
const GLASS: Surface = { color: '#8fd2d8', opacity: 0.42, roughness: 0.15, metalness: 0.2, glow: 0.35, noShadow: true }

/** Warm window light, in the building's own accent. */
const lit = (color: string, glow = 1.15): Surface => ({ color, glow, roughness: 0.3, noShadow: true })
/** A lamp flame: the same tone everywhere, so the town reads as one lighting rig. */
const LAMP: Surface = { color: '#f0b84d', glow: 2.4, roughness: 0.2, noShadow: true }

const surface = (color: string, roughness = 0.88): Surface => ({ color, roughness })

/* ---- building primitives ------------------------------------------- *
 * Every one of these takes the batch and writes boxes into it. None of
 * them creates a Mesh, which is why detail is cheap.
 * ------------------------------------------------------------------- */

type Frame = {
  spec: BuildingSpec
  wall: Surface
  trim: Surface
  roof: Surface
  accent: Surface
  glow: Surface
  /** World z of the −z face. */
  front: number
  /** World z of the +z face. */
  back: number
  left: number
  right: number
  /** Top of the main block's wall, before the roof. */
  eaves: number
  /**
   * Yaw of the wall that looks at the plaza, in the same convention
   * `windowUnit` and `Batch.plate` use: 0 faces −z.
   *
   * Doors used to be nailed to the −z face of every building, which put
   * half the town's entrances facing out of town: the bakery's door
   * opened onto empty grass and its blank back wall faced the street the
   * player actually walks up. This is derived from where the building
   * stands instead, so every entrance, sign and awning is on the side you
   * arrive from.
   */
  faceYaw: number
  /** Width of the plaza-facing wall, which is not always `spec.width`. */
  faceWidth: number
  /**
   * A point relative to the plaza-facing wall: `along` sideways from its
   * centre, `up` from the ground, `out` outward from the wall plane.
   */
  onFace: (along: number, up: number, out: number) => [number, number, number]
}

/** Which wall looks at the plaza. The long axis wins, so doors stay on a broad face. */
function plazaYaw(spec: BuildingSpec) {
  if (Math.abs(spec.x) >= Math.abs(spec.z)) return spec.x < 0 ? -Math.PI / 2 : Math.PI / 2
  return spec.z < 0 ? Math.PI : 0
}

function frameFor(spec: BuildingSpec): Frame {
  const accent = spec.accent ?? '#d5a64b'
  const faceYaw = plazaYaw(spec)
  // Outward normal of that wall is the plate convention's local −z.
  const nx = -Math.sin(faceYaw)
  const nz = -Math.cos(faceYaw)
  const tx = Math.cos(faceYaw)
  const tz = -Math.sin(faceYaw)
  const acrossZ = Math.abs(nz) > 0.5
  const halfOut = (acrossZ ? spec.depth : spec.width) / 2
  return {
    spec,
    wall: surface(spec.wall),
    trim: surface(spec.trim ?? spec.wall, 0.86),
    roof: surface(spec.roof, 0.9),
    accent: surface(accent, 0.6),
    glow: lit(accent),
    front: spec.z - spec.depth / 2,
    back: spec.z + spec.depth / 2,
    left: spec.x - spec.width / 2,
    right: spec.x + spec.width / 2,
    eaves: spec.height + 0.5,
    faceYaw,
    faceWidth: acrossZ ? spec.width : spec.depth,
    onFace: (along, up, out) => [
      spec.x + nx * (halfOut + out) + tx * along,
      up,
      spec.z + nz * (halfOut + out) + tz * along,
    ],
  }
}

/** Plinth, walls, a stone course at the base and corner posts. */
function shell(batch: Batch, f: Frame, options?: { plinth?: Surface; posts?: Surface; course?: boolean }) {
  const { spec } = f
  batch.box([spec.width + 0.7, 0.5, spec.depth + 0.7], [spec.x, 0.25, spec.z], options?.plinth ?? SLATE)
  batch.box([spec.width, spec.height, spec.depth], [spec.x, spec.height / 2 + 0.5, spec.z], f.wall)
  // A course of stone at knee height: the single cheapest thing that stops a
  // wall reading as one flat extrusion.
  if (options?.course !== false) {
    batch.box([spec.width + 0.16, 0.42, spec.depth + 0.16], [spec.x, 1.05, spec.z], STONE_DARK)
    batch.box([spec.width + 0.24, 0.3, spec.depth + 0.24], [spec.x, f.eaves - 0.2, spec.z], f.trim)
  }
  const posts = options?.posts ?? TIMBER_DARK
  for (const px of [f.left + 0.2, f.right - 0.2]) {
    for (const pz of [f.front + 0.2, f.back - 0.2]) {
      batch.box([0.4, spec.height, 0.4], [px, spec.height / 2 + 0.5, pz], posts)
    }
  }
}

/**
 * A block, as the roofs and arcades want it: centre, and the plan it covers.
 * Taken from a `Frame` for a main block and written by hand for a tower stage.
 */
type Block = { x: number; z: number; width: number; depth: number }
const blockOf = (f: Frame): Block => ({ x: f.spec.x, z: f.spec.z, width: f.spec.width, depth: f.spec.depth })

/**
 * A stepped gabled roof: courses of slab shrinking towards a ridge.
 *
 * Courses rather than a cone, because a cone on a rectangle is the shape that
 * made every building here look like the same building. A stepped voxel roof
 * also matches how everything else in this world is made.
 */
function ridgeRoof(
  batch: Batch,
  block: Block,
  eaves: number,
  options?: { courses?: number; step?: number; overhang?: number; alongX?: boolean; roof: Surface; gable?: Surface; dormers?: { count: number; glow: Surface } },
) {
  const courses = options?.courses ?? 5
  const step = options?.step ?? 0.44
  const overhang = options?.overhang ?? 0.6
  const alongX = options?.alongX ?? block.width >= block.depth
  const roof = options?.roof ?? SLATE
  const gable = options?.gable ?? SLATE
  const span = (alongX ? block.depth : block.width) / 2 + overhang
  const run = (alongX ? block.width : block.depth) + overhang * 2
  for (let i = 0; i < courses; i++) {
    const half = span * (1 - i / courses)
    const y = eaves + step * i + step / 2
    const size: [number, number, number] = alongX ? [run, step, half * 2] : [half * 2, step, run]
    batch.box(size, [block.x, y, block.z], i === 0 ? SLATE : roof)
    // Gable ends: the triangular wall under the slope, stepped to match.
    if (i > 0) {
      const endSize: [number, number, number] = alongX ? [0.36, step, half * 1.9] : [half * 1.9, step, 0.36]
      const offset = (alongX ? block.width : block.depth) / 2 - 0.1
      batch.box(endSize, alongX ? [block.x - offset, y, block.z] : [block.x, y, block.z - offset], gable)
      batch.box(endSize, alongX ? [block.x + offset, y, block.z] : [block.x, y, block.z + offset], gable)
    }
  }
  // Ridge cap.
  const ridge: [number, number, number] = alongX ? [run, step * 0.7, 0.7] : [0.7, step * 0.7, run]
  batch.box(ridge, [block.x, eaves + step * courses, block.z], SLATE)
  // Dormers: little gabled boxes pushed out of the slope, each with a lit pane.
  // They are what tells you the attic is lived in.
  if (options?.dormers) {
    const runLength = alongX ? block.width : block.depth
    const side = (alongX ? block.depth : block.width) / 2
    for (let i = 0; i < options.dormers.count; i++) {
      const along = -runLength / 2 + (runLength / options.dormers.count) * (i + 0.5)
      for (const sign of [-1, 1]) {
        const cx = alongX ? block.x + along : block.x + sign * (side - 0.9)
        const cz = alongX ? block.z + sign * (side - 0.9) : block.z + along
        const yaw = alongX ? (sign < 0 ? 0 : Math.PI) : sign < 0 ? Math.PI / 2 : -Math.PI / 2
        batch.box([1.5, 1.9, 1.5], [cx, eaves + step * 1.6, cz], gable, { rotY: yaw })
        batch.box([1.0, 1.0, 0.2], onWall(cx, cz, 1.5, 1.5, yaw, 0, eaves + step * 1.7, 0.02), options.dormers.glow, { rotY: yaw })
        for (let s = 0; s < 3; s++) {
          batch.box([1.62 - s * 0.5, 0.34, 1.62 - s * 0.5], [cx, eaves + step * 1.6 + 1.1 + s * 0.34, cz], SLATE, { rotY: yaw })
        }
      }
    }
  }
  return eaves + step * courses
}

/** A flat roof with a parapet, for the civic buildings. */
function parapet(batch: Batch, block: Block, eaves: number, options: { rail?: number; merlons?: boolean; roof: Surface; trim: Surface }) {
  const rail = options.rail ?? 0.95
  batch.box([block.width + 0.5, 0.36, block.depth + 0.5], [block.x, eaves + 0.18, block.z], options.roof)
  for (const yaw of WALLS) {
    const span = wallSpan(block.width + 0.5, block.depth + 0.5, yaw)
    batch.box([span, rail, 0.42], onWall(block.x, block.z, block.width + 0.5, block.depth + 0.5, yaw, 0, eaves + 0.36 + rail / 2, -0.21), options.trim, { rotY: yaw })
    if (options.merlons) {
      const count = Math.max(2, Math.floor(span / 1.7))
      for (let i = 0; i <= count; i++) {
        batch.box([0.62, 0.55, 0.62], onWall(block.x, block.z, block.width + 0.5, block.depth + 0.5, yaw, -span / 2 + (span / count) * i, eaves + 0.36 + rail + 0.28, -0.21), options.trim, { rotY: yaw })
      }
    }
  }
  return eaves + 0.36 + rail
}

/** A window: frame, lit pane, sill, and shutters that are actually open. */
function windowUnit(
  batch: Batch,
  at: [number, number, number],
  size: [number, number],
  glow: Surface,
  options?: { faceYaw?: number; shutters?: Surface; frame?: Surface; mullion?: boolean; arch?: boolean },
) {
  const yaw = options?.faceYaw ?? 0
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const [x, y, z] = at
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos]
  const [w, h] = size
  const frame = options?.frame ?? TIMBER_DARK
  batch.box([w + 0.34, h + 0.34, 0.18], place(0, 0, 0.02), frame, { rotY: yaw })
  batch.box([w, h, 0.14], place(0, 0, -0.08), glow, { rotY: yaw })
  if (options?.mullion) {
    batch.box([0.12, h, 0.2], place(0, 0, -0.12), frame, { rotY: yaw })
    batch.box([w, 0.12, 0.2], place(0, 0, -0.12), frame, { rotY: yaw })
  }
  if (options?.arch) {
    batch.box([w * 0.62, 0.2, 0.2], place(0, h / 2 + 0.25, -0.02), frame, { rotY: yaw })
    batch.box([w * 0.3, 0.2, 0.2], place(0, h / 2 + 0.42, -0.02), frame, { rotY: yaw })
  }
  // Sill, with a slight overhang: the detail that makes a hole read as a window.
  batch.box([w + 0.6, 0.16, 0.34], place(0, -h / 2 - 0.22, -0.1), options?.frame ?? TIMBER, { rotY: yaw })
  if (options?.shutters) {
    for (const side of [-1, 1]) {
      batch.box([w * 0.52, h + 0.2, 0.12], place(side * (w * 0.78), 0, -0.2), options.shutters, { rotY: yaw + side * 0.5 })
    }
  }
}

/**
 * A recessed door with a lintel, a step and a lamp beside it, cut into the
 * plaza-facing wall wherever that happens to be.
 */
function doorway(
  batch: Batch,
  f: Frame,
  options?: { width?: number; height?: number; lamp?: boolean; arch?: boolean; along?: number; grand?: boolean },
) {
  const w = options?.width ?? 1.5
  const h = options?.height ?? 2.5
  const along = options?.along ?? 0
  const yaw = f.faceYaw
  const at = (a: number, up: number, out: number) => f.onFace(along + a, up, out)
  batch.box([w + 0.5, h + 0.4, 0.2], at(0, (h + 0.4) / 2 + 0.5, 0.05), TIMBER_DARK, { rotY: yaw })
  batch.box([w, h, 0.16], at(0, h / 2 + 0.5, -0.03), DARK, { rotY: yaw })
  // Planked door leaf, with a brass handle and hinges.
  for (let i = 0; i < 3; i++) {
    batch.box([w / 3.4, h - 0.2, 0.1], at((i - 1) * (w / 3.1), h / 2 + 0.5, 0.11), TIMBER, { rotY: yaw })
  }
  batch.box([w + 0.2, 0.2, 0.3], at(0, h + 0.62, 0.05), f.accent, { rotY: yaw })
  batch.box([0.18, 0.18, 0.18], at(w / 2 - 0.3, h / 2 + 0.4, 0.19), BRASS, { rotY: yaw })
  batch.box([w + 1.0, 0.24, 1.1], at(0, 0.62, 0.45), STONE, { rotY: yaw })
  batch.box([w + 1.4, 0.22, 0.6], at(0, 0.4, 0.95), STONE_DARK, { rotY: yaw })
  if (options?.arch) {
    batch.box([w * 0.7, 0.22, 0.3], at(0, h + 0.82, 0.05), f.trim, { rotY: yaw })
    batch.box([w * 0.35, 0.22, 0.3], at(0, h + 1.0, 0.05), f.trim, { rotY: yaw })
  }
  // A grand entrance: pilasters either side carrying a pediment, for the
  // buildings whose whole point is that you are meant to walk in.
  if (options?.grand) {
    for (const side of [-1, 1]) {
      batch.box([0.7, h + 1.6, 0.7], at(side * (w / 2 + 0.85), (h + 1.6) / 2 + 0.5, 0.3), STONE, { rotY: yaw })
      batch.box([0.95, 0.3, 0.95], at(side * (w / 2 + 0.85), h + 2.25, 0.3), f.trim, { rotY: yaw })
    }
    for (let i = 0; i < 4; i++) {
      batch.box([w + 2.6 - i * 0.62, 0.32, 0.6], at(0, h + 2.55 + i * 0.32, 0.3), f.trim, { rotY: yaw })
    }
  }
  if (options?.lamp !== false) {
    for (const side of options?.grand ? [-1, 1] : [1]) {
      const a = side * (w / 2 + (options?.grand ? 1.9 : 0.85))
      batch.box([0.5, 0.12, 0.12], at(a - side * 0.25, h + 0.5, 0.2), IRON_DARK, { rotY: yaw })
      batch.box([0.34, 0.14, 0.34], at(a, h + 0.56, 0.3), IRON_DARK, { rotY: yaw })
      batch.box([0.3, 0.42, 0.3], at(a, h + 0.28, 0.3), LAMP, { rotY: yaw })
      batch.box([0.34, 0.12, 0.34], at(a, h + 0.02, 0.3), IRON_DARK, { rotY: yaw })
    }
  }
}

/** A chimney, with an optional plume. Smoke is what makes a building inhabited. */
function chimney(
  batch: Batch,
  at: [number, number],
  base: number,
  height: number,
  options?: { width?: number; stone?: Surface; smoke?: number; ember?: boolean },
) {
  const [x, z] = at
  const w = options?.width ?? 0.9
  const stone = options?.stone ?? STONE_DARK
  batch.box([w + 0.3, 0.4, w + 0.3], [x, base + 0.2, z], stone)
  batch.box([w, height, w], [x, base + height / 2, z], stone)
  batch.box([w + 0.32, 0.34, w + 0.32], [x, base + height, z], STONE)
  batch.box([w * 0.55, 0.3, w * 0.55], [x, base + height + 0.3, z], DARK)
  if (options?.ember) batch.box([w * 0.4, 0.2, w * 0.4], [x, base + height + 0.36, z], EMBER)
  const puffs = options?.smoke ?? 0
  for (let i = 0; i < puffs; i++) {
    // The plume drifts and widens as it rises; the wind blows the same way over
    // the whole town, because one town has one wind.
    const t = (i + 1) / puffs
    const size = 0.55 + t * 1.5
    batch.box(
      [size, size * 0.8, size],
      [x + t * 2.6 + Math.sin(i * 1.7) * 0.4, base + height + 0.9 + i * 1.15, z - t * 1.4 + Math.cos(i * 2.1) * 0.35],
      SMOKE,
      { rotY: i * 0.5 },
    )
  }
}

/** A bracketed sign hanging out over the street, carrying a trade emblem. */
function hangingSign(
  batch: Batch,
  at: [number, number, number],
  emblem: EmblemId,
  options?: { faceYaw?: number; cell?: number; board?: Surface; bracket?: Surface },
) {
  const yaw = options?.faceYaw ?? 0
  const cell = options?.cell ?? 0.115
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const [x, y, z] = at
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos]
  const { width, height } = emblemSize(emblem, cell)
  const bracket = options?.bracket ?? IRON_DARK
  // Wall bracket: an upright, an arm out over the pavement, and a diagonal stay.
  batch.box([0.18, 1.0, 0.18], place(-width / 2 - 0.9, 0.35, 0.18), bracket, { rotY: yaw })
  batch.box([width + 1.1, 0.16, 0.16], place(0, 0.8, 0.1), bracket, { rotY: yaw })
  batch.box([1.1, 0.14, 0.14], place(-width / 2 - 0.5, 0.42, 0.14), bracket, { rotY: yaw, rotZ: 0.7 })
  // Two chains down to the board.
  for (const side of [-1, 1]) {
    batch.box([0.1, 0.5, 0.1], place(side * width * 0.32, 0.5, 0.02), bracket, { rotY: yaw })
  }
  // The board, then the emblem sunk into its face.
  batch.box([width + 0.42, height + 0.42, 0.16], place(0, 0, 0), options?.board ?? TIMBER_DARK, { rotY: yaw })
  batch.plate(emblemPlate(emblem, place(0, 0, -0.12), cell, { faceYaw: yaw }))
  return { width, height }
}

/* ---- yard clutter: the things that say a trade is worked here ------- */

function barrel(batch: Batch, at: [number, number], options?: { size?: number; lid?: Surface; yaw?: number }) {
  const [x, z] = at
  const s = options?.size ?? 0.8
  const yaw = options?.yaw ?? 0
  batch.box([s, s * 1.3, s], [x, s * 0.65, z], LEATHER, { rotY: yaw })
  batch.box([s + 0.1, 0.14, s + 0.1], [x, s * 0.42, z], IRON_DARK, { rotY: yaw })
  batch.box([s + 0.1, 0.14, s + 0.1], [x, s * 1.02, z], IRON_DARK, { rotY: yaw })
  batch.box([s * 0.92, 0.12, s * 0.92], [x, s * 1.32, z], options?.lid ?? TIMBER, { rotY: yaw })
}

function crate(batch: Batch, at: [number, number, number], options?: { size?: number; yaw?: number; goods?: Surface }) {
  const [x, y, z] = at
  const s = options?.size ?? 0.85
  const yaw = options?.yaw ?? 0
  batch.box([s, s, s], [x, y + s / 2, z], TIMBER_PALE, { rotY: yaw })
  batch.box([s + 0.06, 0.12, s + 0.06], [x, y + s * 0.5, z], TIMBER_DARK, { rotY: yaw })
  if (options?.goods) batch.box([s * 0.7, s * 0.3, s * 0.7], [x, y + s + 0.12, z], options.goods, { rotY: yaw })
}

function sack(batch: Batch, at: [number, number], options?: { size?: number; yaw?: number; cloth?: Surface }) {
  const [x, z] = at
  const s = options?.size ?? 0.7
  const yaw = options?.yaw ?? 0
  const cloth = options?.cloth ?? CLOTH_CREAM
  batch.box([s, s * 0.8, s * 0.8], [x, s * 0.4, z], cloth, { rotY: yaw })
  batch.box([s * 0.7, s * 0.4, s * 0.6], [x, s * 0.95, z], cloth, { rotY: yaw, rotZ: 0.2 })
  batch.box([s * 0.35, 0.16, s * 0.35], [x, s * 1.2, z], TIMBER_DARK, { rotY: yaw })
}

/**
 * A shopfront canopy: sloped cloth on iron brackets, with a striped valance.
 *
 * Cantilevered off the wall on purpose. The version of this that stood on two
 * timber props reached nearly two metres into the street, and the navigation
 * grid is baked from building footprints alone — so those props were solid to
 * the eye and thin air to the pathfinder, which is exactly the thing this town
 * is not allowed to have. Everything here hangs from above head height instead.
 */
function canopy(batch: Batch, at: [number, number, number], width: number, cloth: Surface, options?: { faceYaw?: number; depth?: number }) {
  const yaw = options?.faceYaw ?? 0
  const depth = options?.depth ?? 1.9
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const [x, y, z] = at
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos]
  batch.box([width, 0.16, depth], place(0, 0, -depth / 2), cloth, { rotY: yaw, rotX: -0.34 })
  // Striped valance: alternating cloth so the canopy does not read as a plank.
  const stripes = Math.max(4, Math.round(width / 0.6))
  for (let i = 0; i < stripes; i++) {
    const lx = -width / 2 + (width / stripes) * (i + 0.5)
    batch.box([width / stripes, 0.42, 0.14], place(lx, -0.42, -depth), i % 2 ? cloth : CLOTH_CREAM, { rotY: yaw })
  }
  // Brackets back to the wall, in place of props down to the pavement.
  for (const side of [-1, 1]) {
    batch.box([0.14, 0.16, depth * 1.15], place(side * (width / 2 - 0.25), -0.5, -depth / 2), IRON_DARK, { rotY: yaw, rotX: 0.5 })
    batch.box([0.14, 0.8, 0.14], place(side * (width / 2 - 0.25), -0.4, 0.08), IRON_DARK, { rotY: yaw })
  }
}

/** A trestle with goods on it: the front-of-shop display. */
function trestle(batch: Batch, at: [number, number, number], width: number, options?: { faceYaw?: number; goods?: Surface[] }) {
  const yaw = options?.faceYaw ?? 0
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const [x, y, z] = at
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos]
  batch.box([width, 0.16, 1.0], place(0, 0.9, 0), TIMBER_PALE, { rotY: yaw })
  batch.box([width - 0.4, 0.14, 0.3], place(0, 0.45, 0), TIMBER_DARK, { rotY: yaw })
  for (const side of [-1, 1]) {
    batch.box([0.18, 0.9, 0.18], place(side * (width / 2 - 0.3), 0.45, -0.3), TIMBER_DARK, { rotY: yaw })
    batch.box([0.18, 0.9, 0.18], place(side * (width / 2 - 0.3), 0.45, 0.3), TIMBER_DARK, { rotY: yaw })
  }
  const goods = options?.goods ?? []
  goods.forEach((good, index) => {
    const lx = -width / 2 + (width / (goods.length + 1)) * (index + 1)
    const h = 0.26 + (index % 3) * 0.1
    batch.box([0.5, h, 0.5], place(lx, 1.0 + h / 2, (index % 2) * 0.16 - 0.08), good, { rotY: yaw + index })
  })
}

/* Post-and-rail fencing used to live here. It was cut rather than used: a rail
 * run is read as a wall, and any wall out in the yard is a wall the navigation
 * grid does not know about, because the grid is baked from footprints. The
 * stable's paddock is suggested with a stone kerb inside the footprint instead. */

/** A cartwheel, stood on edge. Spokes read even at four of them. */
function wheel(batch: Batch, at: [number, number, number], radius: number, options?: { yaw?: number; lean?: number }) {
  const [x, y, z] = at
  const yaw = options?.yaw ?? 0
  const lean = options?.lean ?? 0
  const segments = 10
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    batch.box(
      [radius * 0.62, 0.22, 0.24],
      [x + Math.cos(angle) * radius * 0.94, y + Math.sin(angle) * radius * 0.94, z],
      IRON_DARK,
      { rotY: yaw, rotZ: angle + Math.PI / 2 + lean },
    )
  }
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI + 0.2
    batch.box([radius * 1.7, 0.16, 0.16], [x, y, z], TIMBER, { rotY: yaw, rotZ: angle + lean })
  }
  batch.box([0.44, 0.44, 0.3], [x, y, z], TIMBER_DARK, { rotY: yaw })
}

/* ================================================================== *
 * Going up.
 *
 * Everything above this line existed to dress a building four to nine
 * metres tall. Everything below it is what makes them thirty to ninety-
 * six, and all of it works on any axis-aligned block: a point on a wall
 * is addressed by which wall (a yaw), how far along it, how high, and
 * how far out, so the same storey stack and the same window row serve a
 * tower's north face and an inn's street front without special cases.
 * ================================================================== */

/** The four walls of an axis-aligned block, as yaws. 0 is the −z wall. */
const WALLS = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const

/** A point on one wall of a block: `along` sideways, `up` absolute, `out` outward. */
function onWall(
  cx: number,
  cz: number,
  width: number,
  depth: number,
  yaw: number,
  along: number,
  up: number,
  out: number,
): [number, number, number] {
  const nx = -Math.sin(yaw)
  const nz = -Math.cos(yaw)
  const halfOut = Math.abs(nz) > 0.5 ? depth / 2 : width / 2
  return [cx + nx * (halfOut + out) + Math.cos(yaw) * along, up, cz + nz * (halfOut + out) - Math.sin(yaw) * along]
}

/** How wide one wall of a block is. */
const wallSpan = (width: number, depth: number, yaw: number) => (Math.abs(Math.cos(yaw)) > 0.5 ? width : depth)

/**
 * A cheap window: frame, lit pane, sill. Three boxes.
 *
 * `windowUnit` above is nine to fifteen boxes once it has shutters and a
 * mullion, which is right for the six windows a player stands in front of and
 * wrong for the two hundred above their head. A twenty-storey tower is lit
 * with these.
 */
function pane(
  batch: Batch,
  at: [number, number, number],
  size: [number, number],
  glow: Surface,
  yaw: number,
  frame: Surface = TIMBER_DARK,
) {
  const [w, h] = size
  batch.box([w + 0.3, h + 0.3, 0.16], at, frame, { rotY: yaw })
  batch.box([w, h, 0.2], at, glow, { rotY: yaw })
  batch.box([w + 0.46, 0.14, 0.3], [at[0], at[1] - h / 2 - 0.2, at[2]], frame, { rotY: yaw })
}

/** A row of panes across one wall of a block. */
function paneRow(
  batch: Batch,
  block: { x: number; z: number; width: number; depth: number },
  yaw: number,
  y: number,
  options?: { count?: number; size?: [number, number]; glow?: Surface; frame?: Surface; inset?: number },
) {
  const span = wallSpan(block.width, block.depth, yaw)
  const count = options?.count ?? Math.max(2, Math.round(span / 3))
  const size = options?.size ?? [1.1, 1.35]
  const glow = options?.glow ?? lit('#e8c079')
  for (let i = 0; i < count; i++) {
    const along = -span / 2 + (span / count) * (i + 0.5)
    if (Math.abs(along) > span / 2 - 0.9) continue
    pane(batch, onWall(block.x, block.z, block.width, block.depth, yaw, along, y, options?.inset ?? 0.02), size, glow, yaw, options?.frame)
  }
}

/**
 * A stack of jettied storeys, each floor oversailing the one below.
 *
 * The jetty is the whole reason a tall timber building reads as storeys
 * rather than as one extruded rectangle: the bracket course at every floor
 * catches the light and counts the floors for you from the street. It is also
 * why the overhang is only allowed upward — the ground floor keeps the
 * footprint the nav grid was baked from, and the sixth floor leaning two
 * metres over the pavement is four storeys above anybody's head.
 */
function storeys(
  batch: Batch,
  f: Frame,
  options: {
    count: number
    storey?: number
    jetty?: number
    base?: number
    glow?: Surface
    studs?: boolean
    windowsPerWall?: number
  },
): { top: number; width: number; depth: number } {
  const { spec } = f
  const storey = options.storey ?? 3.3
  const jetty = options.jetty ?? 0.22
  const base = options.base ?? 0.5
  const glow = options.glow ?? f.glow
  let width = spec.width
  let depth = spec.depth
  for (let i = 0; i < options.count; i++) {
    width = spec.width + i * jetty * 2
    depth = spec.depth + i * jetty * 2
    const y0 = base + i * storey
    batch.box([width, storey, depth], [spec.x, y0 + storey / 2, spec.z], f.wall)
    // The bracket course: a lip under each jettied floor, plus corbels.
    if (i > 0) {
      batch.box([width + 0.4, 0.44, depth + 0.4], [spec.x, y0 + 0.16, spec.z], TIMBER_DARK)
      for (const yaw of WALLS) {
        const span = wallSpan(width, depth, yaw)
        const corbels = Math.max(2, Math.round(span / 2.4))
        for (let k = 0; k <= corbels; k++) {
          const along = -span / 2 + (span / corbels) * k
          batch.box([0.3, 0.5, 0.5], onWall(spec.x, spec.z, width, depth, yaw, along, y0 - 0.1, -0.1), TIMBER_DARK, { rotY: yaw })
        }
      }
    }
    // Half-timbering: studs and a brace on every wall, which is what stops a
    // five-storey plaster box reading as a five-storey plaster box.
    if (options.studs !== false) {
      for (const yaw of WALLS) {
        const span = wallSpan(width, depth, yaw)
        const studs = Math.max(2, Math.round(span / 2.1))
        for (let k = 0; k <= studs; k++) {
          const along = -span / 2 + (span / studs) * k
          batch.box([0.28, storey - 0.5, 0.22], onWall(spec.x, spec.z, width, depth, yaw, along, y0 + storey / 2, 0.02), TIMBER_DARK, { rotY: yaw })
        }
        batch.box([span * 0.42, 0.24, 0.2], onWall(spec.x, spec.z, width, depth, yaw, span * 0.22, y0 + storey * 0.5, 0.03), TIMBER_DARK, { rotY: yaw, rotZ: 0.62 })
      }
    }
    // Windows everywhere but the ground floor, which belongs to the shopfront.
    if (i > 0) {
      for (const yaw of WALLS) {
        paneRow(batch, { x: spec.x, z: spec.z, width, depth }, yaw, y0 + storey * 0.56, {
          glow,
          size: [1.05, 1.45],
          count: Math.max(2, options.windowsPerWall ?? Math.round(wallSpan(width, depth, yaw) / 3.4)),
          inset: 0.06,
        })
      }
    }
  }
  return { top: base + options.count * storey, width, depth }
}

/**
 * A stepped, tapering tower shaft.
 *
 * Built as `stages` stacked blocks rather than one tall box, each narrower
 * than the last with a cornice band between, because a taper made of visible
 * steps is the voxel version of a taper and a smooth one would be a cone.
 * Returns the top and how wide it ended up, so a spire or a dome can be sat
 * on it without either end guessing.
 */
function shaft(
  batch: Batch,
  options: {
    x: number
    z: number
    base: number
    top: number
    width: number
    depth?: number
    taper?: number
    stages?: number
    wall: Surface
    trim: Surface
    glow?: Surface
    windowsPerWall?: number
    balconyEvery?: number
    corners?: Surface
    walls?: readonly number[]
  },
): { top: number; width: number; depth: number } {
  const stages = options.stages ?? Math.max(2, Math.round((options.top - options.base) / 6))
  const taper = options.taper ?? 0.24
  const baseDepth = options.depth ?? options.width
  const stageHeight = (options.top - options.base) / stages
  let width = options.width
  let depth = baseDepth
  for (let i = 0; i < stages; i++) {
    const shrink = 1 - taper * (i / stages)
    width = options.width * shrink
    depth = baseDepth * shrink
    const y0 = options.base + i * stageHeight
    batch.box([width, stageHeight, depth], [options.x, y0 + stageHeight / 2, options.z], options.wall)
    // Cornice at the foot of every stage: the step that makes the taper visible.
    batch.box([width + 0.66, 0.42, depth + 0.66], [options.x, y0 + 0.21, options.z], options.trim)
    if (options.corners) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          batch.box([0.66, stageHeight, 0.66], [options.x + sx * (width / 2 - 0.25), y0 + stageHeight / 2, options.z + sz * (depth / 2 - 0.25)], options.corners)
        }
      }
    }
    if (options.glow) {
      for (const yaw of options.walls ?? WALLS) {
        paneRow(batch, { x: options.x, z: options.z, width, depth }, yaw, y0 + stageHeight * 0.58, {
          glow: options.glow,
          size: [0.95, 1.7],
          count: options.windowsPerWall ?? 2,
          inset: 0.06,
        })
      }
    }
    if (options.balconyEvery && i > 0 && i % options.balconyEvery === 0) {
      balconyRing(batch, { x: options.x, z: options.z, y: y0 + 0.42, width, depth, out: 0.85, rail: options.trim })
    }
  }
  return { top: options.top, width, depth }
}

/** A projecting walkway all the way round a block, with a rail you can see through. */
function balconyRing(
  batch: Batch,
  options: { x: number; z: number; y: number; width: number; depth: number; out?: number; rail?: Surface; deck?: Surface },
) {
  const out = options.out ?? 0.8
  const rail = options.rail ?? IRON_DARK
  const width = options.width + out * 2
  const depth = options.depth + out * 2
  batch.box([width, 0.32, depth], [options.x, options.y, options.z], options.deck ?? SLATE)
  for (const yaw of WALLS) {
    const span = wallSpan(width, depth, yaw)
    batch.box([span, 0.22, 0.2], onWall(options.x, options.z, width, depth, yaw, 0, options.y + 1.06, -0.1), rail, { rotY: yaw })
    const posts = Math.max(3, Math.round(span / 1.1))
    for (let k = 0; k <= posts; k++) {
      const along = -span / 2 + (span / posts) * k
      batch.box([0.16, 1.0, 0.16], onWall(options.x, options.z, width, depth, yaw, along, options.y + 0.66, -0.1), rail, { rotY: yaw })
    }
  }
}

/**
 * A stepped spire: shrinking courses to a point, with a finial on top.
 * Returns the apex, which is what the skyline is measured from.
 */
function spire(
  batch: Batch,
  options: {
    x: number
    z: number
    base: number
    height: number
    width: number
    depth?: number
    courses?: number
    roof: Surface
    trim?: Surface
    finial?: Surface
    twist?: number
  },
): number {
  const courses = options.courses ?? Math.max(5, Math.round(options.height / 1.5))
  const step = options.height / courses
  const baseDepth = options.depth ?? options.width
  for (let i = 0; i < courses; i++) {
    const shrink = 1 - i / courses
    const y = options.base + step * i + step / 2
    batch.box(
      [options.width * shrink, step, baseDepth * shrink],
      [options.x, y, options.z],
      i % 3 === 2 && options.trim ? options.trim : options.roof,
      { rotY: (options.twist ?? 0) * i },
    )
  }
  const apex = options.base + options.height
  if (options.finial) {
    batch.box([0.34, 1.5, 0.34], [options.x, apex + 0.75, options.z], IRON_DARK)
    batch.box([0.8, 0.8, 0.8], [options.x, apex + 1.7, options.z], options.finial, { rotY: 0.78, rotZ: 0.62 })
    return apex + 2.1
  }
  return apex
}

/**
 * A stepped dome, as levels of crossed slabs.
 *
 * Two boxes per level gives an octagonal plan, which is as round as a voxel
 * dome should get: a real ring of cubes per level is forty boxes for a shape
 * that reads identically from the street. Ribs are added over the top.
 */
function voxDome(
  batch: Batch,
  options: { x: number; z: number; base: number; radius: number; height?: number; shell: Surface; rib?: Surface; levels?: number },
): number {
  const levels = options.levels ?? 8
  const height = options.height ?? options.radius * 1.05
  const step = height / levels
  for (let i = 0; i < levels; i++) {
    const r = options.radius * Math.sqrt(Math.max(0.02, 1 - ((i + 0.5) / levels) ** 2))
    const y = options.base + step * i + step / 2
    batch.box([r * 2, step, r * 1.42], [options.x, y, options.z], options.shell)
    batch.box([r * 1.42, step, r * 2], [options.x, y, options.z], options.shell)
    if (options.rib) {
      for (let k = 0; k < 4; k++) {
        batch.box([r * 2.02, step * 0.55, 0.34], [options.x, y + step * 0.3, options.z], options.rib, { rotY: (k / 4) * Math.PI })
      }
    }
  }
  return options.base + height
}

/**
 * A stepped sloping pier against a wall: the thing that makes a tall stone
 * building look like it is holding itself up rather than balancing.
 */
function buttress(
  batch: Batch,
  options: { x: number; z: number; yaw: number; base: number; top: number; steps?: number; reach?: number; thickness?: number; stone?: Surface; cap?: Surface },
) {
  const steps = options.steps ?? 5
  const reach = options.reach ?? 1.6
  const thickness = options.thickness ?? 1.1
  const stone = options.stone ?? STONE
  const span = (options.top - options.base) / steps
  for (let i = 0; i < steps; i++) {
    const out = reach * (1 - i / steps)
    const y0 = options.base + span * i
    const cx = options.x - Math.sin(options.yaw) * (out / 2)
    const cz = options.z - Math.cos(options.yaw) * (out / 2)
    batch.box([thickness, span, out + 0.6], [cx, y0 + span / 2, cz], stone, { rotY: options.yaw })
    batch.box([thickness + 0.24, 0.3, out + 0.7], [cx, y0 + span, cz], options.cap ?? SLATE, { rotY: options.yaw })
  }
}

/** A run of arched openings along one wall: piers, dark recesses, stepped heads. */
function arcade(
  batch: Batch,
  block: { x: number; z: number; width: number; depth: number },
  yaw: number,
  options: { base: number; height: number; bays?: number; pier?: Surface; recess?: Surface; depthOut?: number },
) {
  const span = wallSpan(block.width, block.depth, yaw)
  const bays = options.bays ?? Math.max(2, Math.round(span / 3.2))
  const pier = options.pier ?? STONE
  const out = options.depthOut ?? 0.9
  const bay = span / bays
  for (let i = 0; i <= bays; i++) {
    const along = -span / 2 + bay * i
    batch.box([0.95, options.height, out], onWall(block.x, block.z, block.width, block.depth, yaw, along, options.base + options.height / 2, out / 2), pier, { rotY: yaw })
  }
  for (let i = 0; i < bays; i++) {
    const along = -span / 2 + bay * (i + 0.5)
    const clear = bay - 0.95
    batch.box([clear, options.height - 1.3, out * 0.8], onWall(block.x, block.z, block.width, block.depth, yaw, along, options.base + (options.height - 1.3) / 2, out * 0.3), options.recess ?? DARK, { rotY: yaw })
    // Stepped arch head over each bay.
    for (let s = 0; s < 3; s++) {
      batch.box([clear * (1 - s * 0.26), 0.42, out], onWall(block.x, block.z, block.width, block.depth, yaw, along, options.base + options.height - 1.1 + s * 0.42, out / 2), pier, { rotY: yaw })
    }
  }
  batch.box([span + 1.2, 0.5, out + 0.5], onWall(block.x, block.z, block.width, block.depth, yaw, 0, options.base + options.height + 0.25, out / 2 - 0.1), SLATE, { rotY: yaw })
}

/**
 * A bridge between two roofs, and the stair turrets that explain how anybody
 * got up there.
 *
 * These are the only pieces of the town that cross a street, and they are
 * deliberately NOT in the navigation grid. Nothing touches the ground between
 * the two ends: the deck is a single span, the haunch under it is stone that
 * stops well above a player's head, and the turrets at each end stand inside
 * footprints the grid already blocks. A player walks underneath.
 */
function skyBridge(
  batch: Batch,
  from: [number, number],
  to: [number, number],
  y: number,
  options?: { width?: number; rise?: number; deck?: Surface; rail?: Surface; stone?: Surface; turrets?: [number, number]; lamps?: boolean; roofed?: Surface },
) {
  const width = options?.width ?? 3.2
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  const yaw = Math.atan2(dx, dz)
  const ux = dx / length
  const uz = dz / length
  // Local x of the rotation is the perpendicular; the rails ride on it.
  const px = uz
  const pz = -ux
  const mid: [number, number, number] = [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2]
  const deck = options?.deck ?? STONE
  const rail = options?.rail ?? IRON_DARK
  batch.box([width, 0.52, length], mid, deck, { rotY: yaw })
  batch.box([width + 0.5, 0.26, length], [mid[0], y - 0.36, mid[2]], SLATE, { rotY: yaw })
  // The haunch: a stone belly under the deck, deepest at midspan.
  const rise = options?.rise ?? Math.min(4.2, length * 0.22)
  const ribs = Math.max(6, Math.round(length / 1.6))
  for (let i = 0; i < ribs; i++) {
    const t = (i + 0.5) / ribs
    const drop = rise * (1 - (2 * t - 1) ** 2)
    if (drop < 0.2) continue
    batch.box(
      [width * 0.74, drop, length / ribs + 0.1],
      [from[0] + dx * t, y - 0.5 - drop / 2, from[1] + dz * t],
      options?.stone ?? STONE_DARK,
      { rotY: yaw },
    )
  }
  // Rails and balusters.
  const posts = Math.max(4, Math.round(length / 1.5))
  for (const side of [-1, 1]) {
    batch.box([0.22, 0.24, length], [mid[0] + px * side * (width / 2), y + 1.24, mid[2] + pz * side * (width / 2)], rail, { rotY: yaw })
    for (let i = 0; i <= posts; i++) {
      const t = i / posts
      batch.box(
        [0.18, 1.1, 0.18],
        [from[0] + dx * t + px * side * (width / 2), y + 0.82, from[1] + dz * t + pz * side * (width / 2)],
        rail,
        { rotY: yaw },
      )
    }
  }
  if (options?.lamps) {
    for (const t of [0.25, 0.5, 0.75]) {
      batch.box([0.2, 1.5, 0.2], [from[0] + dx * t + px * (width / 2), y + 2.0, from[1] + dz * t + pz * (width / 2)], IRON_DARK)
      batch.box([0.42, 0.5, 0.42], [from[0] + dx * t + px * (width / 2), y + 2.85, from[1] + dz * t + pz * (width / 2)], LAMP)
      batch.box([0.5, 0.16, 0.5], [from[0] + dx * t + px * (width / 2), y + 3.14, from[1] + dz * t + pz * (width / 2)], IRON_DARK)
    }
  }
  // A covered walk: posts and a pitched lid, for the bridges over the plaza.
  if (options?.roofed) {
    const bays = Math.max(3, Math.round(length / 3.2))
    for (let i = 0; i <= bays; i++) {
      const t = i / bays
      for (const side of [-1, 1]) {
        batch.box([0.24, 2.5, 0.24], [from[0] + dx * t + px * side * (width / 2), y + 1.8, from[1] + dz * t + pz * side * (width / 2)], TIMBER_DARK, { rotY: yaw })
      }
    }
    for (let c = 0; c < 3; c++) {
      batch.box([(width + 1.2) * (1 - c * 0.3), 0.36, length], [mid[0], y + 3.15 + c * 0.36, mid[2]], options.roofed, { rotY: yaw })
    }
  }
  // Stair turrets, standing inside the footprints the nav grid already blocks.
  const turretBase = options?.turrets
  if (turretBase) {
    const pairs: Array<[number, number, number]> = [
      [from[0] - ux * 1.35, from[1] - uz * 1.35, turretBase[0]],
      [to[0] + ux * 1.35, to[1] + uz * 1.35, turretBase[1]],
    ]
    for (const [tx, tz, tBase] of pairs) {
      batch.box([2.9, y + 2.3 - tBase, 2.9], [tx, (y + 2.3 + tBase) / 2, tz], deck, { rotY: yaw })
      batch.box([3.3, 0.4, 3.3], [tx, y + 2.4, tz], SLATE, { rotY: yaw })
      spire(batch, { x: tx, z: tz, base: y + 2.6, height: 2.6, width: 2.9, courses: 5, roof: SLATE, twist: 0.06 })
      // A lit stair window every three metres, so the turret reads as a stair.
      for (let h = tBase + 2.4; h < y; h += 3) {
        batch.box([0.6, 1.0, 3.06], [tx, h, tz], lit('#e8c079', 0.9), { rotY: yaw })
      }
    }
  }
}

/** A hanging cloth banner, optionally carrying an emblem. */
function banner(
  batch: Batch,
  at: [number, number, number],
  options: { width: number; height: number; cloth: Surface; yaw?: number; emblem?: EmblemId; cell?: number; pole?: Surface },
) {
  const yaw = options.yaw ?? 0
  const [x, y, z] = at
  batch.box([options.width + 0.8, 0.22, 0.22], [x, y + options.height / 2 + 0.2, z], options.pole ?? IRON_DARK, { rotY: yaw })
  batch.box([options.width, options.height, 0.14], [x, y, z], options.cloth, { rotY: yaw })
  // Tapered tail, two steps, so it hangs rather than ending flat.
  batch.box([options.width * 0.66, options.height * 0.2, 0.14], [x, y - options.height * 0.6, z], options.cloth, { rotY: yaw })
  batch.box([options.width * 0.3, options.height * 0.16, 0.14], [x, y - options.height * 0.75, z], options.cloth, { rotY: yaw })
  if (options.emblem) {
    const cell = options.cell ?? (options.width / 15) * 0.9
    batch.plate(emblemPlate(options.emblem, [x - Math.sin(yaw) * 0.14, y + options.height * 0.08, z - Math.cos(yaw) * 0.14], cell, { faceYaw: yaw }))
  }
}

/** A clock: octagonal dial, twelve marks, two hands stopped at a quarter past. */
function clockDial(batch: Batch, at: [number, number, number], radius: number, yaw: number, options?: { face?: Surface; ink?: Surface }) {
  const [x, y, z] = at
  const face = options?.face ?? BONE
  const ink = options?.ink ?? DARK
  batch.box([radius * 2.3, radius * 2.3 * 0.7, 0.3], [x, y, z], BRASS_DARK, { rotY: yaw })
  batch.box([radius * 2.3 * 0.7, radius * 2.3, 0.3], [x, y, z], BRASS_DARK, { rotY: yaw })
  const inward = (d: number): [number, number, number] => [x - Math.sin(yaw) * d, y, z - Math.cos(yaw) * d]
  batch.box([radius * 2, radius * 2 * 0.7, 0.2], inward(0.2), face, { rotY: yaw })
  batch.box([radius * 2 * 0.7, radius * 2, 0.2], inward(0.2), face, { rotY: yaw })
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const mark = inward(0.34)
    batch.box([0.22, 0.3, 0.16], [mark[0] + Math.cos(a) * radius * 0.82 * Math.cos(yaw), mark[1] + Math.sin(a) * radius * 0.82, mark[2] - Math.cos(a) * radius * 0.82 * Math.sin(yaw)], ink, { rotY: yaw })
  }
  batch.box([radius * 0.9, 0.2, 0.16], inward(0.4), ink, { rotY: yaw, rotZ: 0.3 })
  batch.box([radius * 1.3, 0.16, 0.16], inward(0.4), ink, { rotY: yaw, rotZ: 1.9 })
  batch.box([0.34, 0.34, 0.24], inward(0.42), BRASS, { rotY: yaw })
}

/** A louvred belfry with a bell hung in it. Returns the top of the stage. */
function belfry(
  batch: Batch,
  options: { x: number; z: number; base: number; height: number; width: number; pier: Surface; louvre?: Surface; bell?: Surface },
): number {
  const { x, z, base, height, width } = options
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.box([1.0, height, 1.0], [x + sx * (width / 2 - 0.5), base + height / 2, z + sz * (width / 2 - 0.5)], options.pier)
    }
  }
  // Louvres: slats across each opening, which is what a belfry is.
  for (const yaw of WALLS) {
    for (let i = 0; i < 6; i++) {
      batch.box([width - 1.4, 0.26, 0.5], onWall(x, z, width, width, yaw, 0, base + 0.8 + i * (height - 1.4) / 6, 0.05), options.louvre ?? TIMBER_DARK, { rotY: yaw, rotX: 0.34 })
    }
  }
  const bell = options.bell ?? BRASS
  batch.box([width - 1.6, 0.3, 0.3], [x, base + height - 0.7, z], IRON_DARK)
  for (let i = 0; i < 4; i++) {
    const r = 0.5 + i * 0.28
    batch.box([r * 2, 0.42, r * 2], [x, base + height - 1.4 - i * 0.42, z], bell)
  }
  batch.box([0.5, 0.4, 0.5], [x, base + height - 3.1, z], BRASS_DARK)
  batch.box([width + 0.9, 0.42, width + 0.9], [x, base + height + 0.2, z], SLATE)
  return base + height + 0.4
}

/** A timber hoist: a beam out of a gable, a pulley and a rope with a hook. */
function hoist(batch: Batch, at: [number, number, number], reach: number, yaw: number) {
  const [x, y, z] = at
  const out = (d: number): [number, number, number] => [x - Math.sin(yaw) * d, y, z - Math.cos(yaw) * d]
  batch.box([0.4, 0.4, reach], out(reach / 2), TIMBER_DARK, { rotY: yaw })
  batch.box([0.34, 1.3, 0.34], out(reach * 0.35), TIMBER_DARK, { rotY: yaw, rotZ: 0.5 })
  const tip = out(reach - 0.3)
  batch.box([0.5, 0.5, 0.24], [tip[0], tip[1] - 0.42, tip[2]], IRON_DARK, { rotY: yaw })
  batch.box([0.1, 2.6, 0.1], [tip[0], tip[1] - 1.8, tip[2]], IRON_DARK)
  batch.box([0.34, 0.5, 0.2], [tip[0], tip[1] - 3.2, tip[2]], IRON, { rotY: yaw })
}

/** A stone water trough. */
function trough(batch: Batch, at: [number, number], yaw = 0) {
  const [x, z] = at
  batch.box([2.6, 0.8, 1.1], [x, 0.4, z], STONE, { rotY: yaw })
  batch.box([2.2, 0.16, 0.8], [x, 0.78, z], { color: '#2f6a70', roughness: 0.2, metalness: 0.15 }, { rotY: yaw })
}

/** An anvil on a block. Reads as a forge from further away than a sign does. */
function anvil(batch: Batch, at: [number, number], yaw = 0) {
  const [x, z] = at
  batch.box([0.9, 0.7, 0.9], [x, 0.35, z], TIMBER_DARK, { rotY: yaw })
  batch.box([0.5, 0.3, 1.0], [x, 0.85, z], IRON, { rotY: yaw })
  batch.box([0.34, 0.24, 0.6], [x, 1.08, z], IRON_DARK, { rotY: yaw })
  batch.box([0.34, 0.2, 1.7], [x, 1.3, z], IRON, { rotY: yaw })
  batch.box([0.5, 0.16, 0.5], [x, 1.42, z], IRON_DARK, { rotY: yaw })
}

/** Stacked hay, for the stable yard. */
function hayStack(batch: Batch, at: [number, number], rows = 2) {
  const HAY: Surface = { color: '#c8a257', roughness: 0.95 }
  const [x, z] = at
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 2 - r; i++) {
      batch.box([1.5, 0.8, 1.0], [x + i * 1.6, 0.4 + r * 0.82, z], HAY, { rotY: r * 0.2 })
      batch.box([1.54, 0.1, 1.04], [x + i * 1.6, 0.62 + r * 0.82, z], TIMBER_DARK, { rotY: r * 0.2 })
    }
  }
}

/** A drying frame with cloth on it, for the weaver, or nets, for the fishery. */
function dryingFrame(batch: Batch, at: [number, number], length: number, yaw: number, cloths: Surface[]) {
  const [x, z] = at
  const ux = Math.sin(yaw)
  const uz = Math.cos(yaw)
  for (const side of [-1, 1]) {
    batch.box([0.24, 3.4, 0.24], [x + ux * side * (length / 2), 1.7, z + uz * side * (length / 2)], TIMBER_DARK)
  }
  batch.box([0.2, 0.2, length], [x, 3.3, z], TIMBER_DARK, { rotY: yaw })
  cloths.forEach((cloth, i) => {
    const t = -length / 2 + (length / (cloths.length + 1)) * (i + 1)
    const h = 1.8 + (i % 3) * 0.5
    batch.box([0.16, h, 1.1], [x + ux * t, 3.2 - h / 2, z + uz * t], cloth, { rotY: yaw })
    batch.box([0.2, 0.22, 1.3], [x + ux * t, 3.24, z + uz * t], TIMBER, { rotY: yaw })
  })
}

/**
 * A standard planted beside a service NPC: a pole, a crossbar, a board and
 * the trade emblem on it.
 *
 * Poles are 0.2m and are deliberately not navigation obstacles, for the same
 * reason the NPCs themselves are not: a body-width post on the plaza that
 * click-to-move has to route around would make the fountain kerb a maze.
 */
function standard(
  batch: Batch,
  at: [number, number],
  emblem: EmblemId,
  options: { yaw?: number; accent: Surface; cell?: number; height?: number },
) {
  const [x, z] = at
  const yaw = options.yaw ?? 0
  const height = options.height ?? 3.4
  const cell = options.cell ?? 0.14
  const { width, height: artHeight } = emblemSize(emblem, cell)
  batch.box([0.5, 0.3, 0.5], [x, 0.15, z], STONE_DARK)
  batch.box([0.34, 0.24, 0.34], [x, 0.36, z], STONE)
  batch.box([0.2, height, 0.2], [x, height / 2 + 0.3, z], IRON_DARK)
  batch.box([width + 0.9, 0.16, 0.16], [x, height + 0.26, z], IRON_DARK, { rotY: yaw })
  batch.box([0.42, 0.42, 0.42], [x, height + 0.55, z], options.accent, { rotY: 0.78, rotZ: 0.62 })
  for (const side of [-1, 1]) {
    batch.box([0.1, 0.42, 0.1], [x + Math.cos(yaw) * side * width * 0.34, height + 0.02, z - Math.sin(yaw) * side * width * 0.34], IRON_DARK)
  }
  const boardY = height - artHeight / 2 - 0.34
  batch.box([width + 0.4, artHeight + 0.4, 0.18], [x, boardY, z], TIMBER_DARK, { rotY: yaw })
  batch.plate(emblemPlate(emblem, [x - Math.sin(yaw) * 0.14, boardY, z - Math.cos(yaw) * 0.14], cell, { faceYaw: yaw }))
  return { boardY, width, artHeight }
}
