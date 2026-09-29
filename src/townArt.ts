import * as THREE from 'three'
import {
  buildingSpecs,
  perimeterTrees,
  serviceNpcs,
  townLayout,
  SHIELDED_NOTICE,
} from './townData'
import type { BuildingKind, BuildingSpec } from './townData'
import { createBatch, spans } from './voxelBuild'
import type { Batch, Surface } from './voxelBuild'
import { emblems, emblemPlate, emblemSize } from './emblems'
import type { EmblemId } from './emblems'
import { createTreeField } from './treeArt'
import type { TreePlacement, TreeSpeciesId } from './treeArt'

/* ------------------------------------------------------------------ *
 * The town.
 *
 * Every building here used to be the same object: a box, a four-sided
 * cone on top, two lit rectangles and a floating word. The word was the
 * only thing distinguishing a bakery from a blacksmith. This module
 * builds each one out of its TRADE instead — a forge with a hooded
 * chimney and an anvil in the yard, an inn with dormers and a hanging
 * tankard, an archive three storeys of tall windows with a reading
 * balcony — so the silhouette tells you what it is before the sign does.
 *
 * ---- Cost ----
 *
 * All of it goes through one `Batch`. Boxes are collected, welded per
 * surface colour, and emitted as about twenty meshes for the entire
 * district: the base, the canal, seventeen buildings, their yard
 * clutter, the hanging signs' timber, and every trade emblem. Detail is
 * therefore nearly free here — a shutter, a barrel or a roof course
 * costs a few triangles and no draw call at all — which is the whole
 * reason the buildings could be given this much.
 *
 * The exceptions, and there are only four kinds:
 *   - lettered sign boards, one small mesh each, because text has to be
 *     a texture and has to stay readable from across the plaza;
 *   - the ground plane and the round plaza paving, which are one mesh
 *     each and would only be made worse by being welded out of cubes;
 *   - the canal and fountain water, which want their own smooth
 *     material rather than a welded cube surface;
 *   - two point lights for the whole town: the forge, and the lamp over
 *     the fountain. Every additional one is another loop iteration in
 *     every material's fragment shader, for every pixel; lamps and
 *     windows glow by emissive instead, which costs nothing.
 *
 * The perimeter woodland is the same instanced tree field the green
 * uses, so the ring around town is built of real species rather than
 * the dodecahedron-on-a-stick it used to be.
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
  /** World z of the front (entrance) face. Doors are all on −z. */
  front: number
  /** World z of the back face. */
  back: number
  left: number
  right: number
  /** Top of the wall, before the roof. */
  eaves: number
}

function frameFor(spec: BuildingSpec): Frame {
  const accent = spec.accent ?? '#d5a64b'
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
 * A stepped gabled roof: courses of slab shrinking towards a ridge.
 *
 * Courses rather than a cone, because a cone on a rectangle is the shape that
 * made every building here look like the same building. A stepped voxel roof
 * also matches how everything else in this world is made.
 */
function gableRoof(
  batch: Batch,
  f: Frame,
  options?: { courses?: number; step?: number; overhang?: number; alongX?: boolean; roof?: Surface; gable?: Surface },
) {
  const { spec } = f
  const courses = options?.courses ?? 5
  const step = options?.step ?? 0.44
  const overhang = options?.overhang ?? 0.6
  const alongX = options?.alongX ?? spec.width >= spec.depth
  const roof = options?.roof ?? f.roof
  const gable = options?.gable ?? f.trim
  const span = (alongX ? spec.depth : spec.width) / 2 + overhang
  const run = (alongX ? spec.width : spec.depth) + overhang * 2
  for (let i = 0; i < courses; i++) {
    const half = span * (1 - i / courses)
    const y = f.eaves + step * i + step / 2
    const size: [number, number, number] = alongX ? [run, step, half * 2] : [half * 2, step, run]
    batch.box(size, [spec.x, y, spec.z], i === 0 ? SLATE : roof)
    // Gable ends: the triangular wall under the slope, stepped to match.
    if (i > 0) {
      const endSize: [number, number, number] = alongX ? [0.36, step, half * 1.9] : [half * 1.9, step, 0.36]
      const offset = (alongX ? spec.width : spec.depth) / 2 - 0.1
      batch.box(endSize, alongX ? [spec.x - offset, y, spec.z] : [spec.x, y, spec.z - offset], gable)
      batch.box(endSize, alongX ? [spec.x + offset, y, spec.z] : [spec.x, y, spec.z + offset], gable)
    }
  }
  // Ridge cap.
  const ridge: [number, number, number] = alongX ? [run, step * 0.7, 0.7] : [0.7, step * 0.7, run]
  batch.box(ridge, [spec.x, f.eaves + step * courses, spec.z], SLATE)
  return f.eaves + step * courses
}

/** A flat roof with a parapet, for the civic buildings. */
function parapetRoof(batch: Batch, f: Frame, options?: { height?: number; merlons?: boolean }) {
  const { spec } = f
  const rail = options?.height ?? 0.95
  batch.box([spec.width + 0.5, 0.36, spec.depth + 0.5], [spec.x, f.eaves + 0.18, spec.z], f.roof)
  for (const pz of [f.front - 0.05, f.back + 0.05]) {
    batch.box([spec.width + 0.5, rail, 0.42], [spec.x, f.eaves + 0.36 + rail / 2, pz], f.trim)
  }
  for (const px of [f.left - 0.05, f.right + 0.05]) {
    batch.box([0.42, rail, spec.depth + 0.5], [px, f.eaves + 0.36 + rail / 2, spec.z], f.trim)
  }
  if (options?.merlons) {
    const count = Math.floor(spec.width / 1.6)
    for (let i = 0; i <= count; i++) {
      const x = f.left + (spec.width / count) * i
      batch.box([0.6, 0.5, 0.6], [x, f.eaves + 0.36 + rail + 0.25, f.front - 0.05], f.trim)
      batch.box([0.6, 0.5, 0.6], [x, f.eaves + 0.36 + rail + 0.25, f.back + 0.05], f.trim)
    }
  }
  return f.eaves + 0.36 + rail
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

/** A recessed door with a lintel, a step and a lamp beside it. */
function doorway(batch: Batch, f: Frame, options?: { width?: number; height?: number; lamp?: boolean; arch?: boolean }) {
  const { spec } = f
  const w = options?.width ?? 1.5
  const h = options?.height ?? 2.5
  const z = f.front - 0.05
  batch.box([w + 0.5, h + 0.4, 0.2], [spec.x, (h + 0.4) / 2 + 0.5, z], TIMBER_DARK)
  batch.box([w, h, 0.16], [spec.x, h / 2 + 0.5, z - 0.08], DARK)
  // Planked door leaf, with a brass handle and hinges.
  for (let i = 0; i < 3; i++) {
    batch.box([w / 3.4, h - 0.2, 0.1], [spec.x + (i - 1) * (w / 3.1), h / 2 + 0.5, z - 0.16], TIMBER)
  }
  batch.box([w + 0.2, 0.2, 0.3], [spec.x, h + 0.62, z - 0.1], f.accent)
  batch.box([0.18, 0.18, 0.18], [spec.x + w / 2 - 0.3, h / 2 + 0.4, z - 0.24], BRASS)
  batch.box([w + 1.0, 0.24, 1.1], [spec.x, 0.62, z - 0.5], STONE)
  batch.box([w + 1.4, 0.22, 0.6], [spec.x, 0.4, z - 1.0], STONE_DARK)
  if (options?.arch) {
    batch.box([w * 0.7, 0.22, 0.3], [spec.x, h + 0.82, z - 0.1], f.trim)
    batch.box([w * 0.35, 0.22, 0.3], [spec.x, h + 1.0, z - 0.1], f.trim)
  }
  if (options?.lamp !== false) {
    const lampX = spec.x + w / 2 + 0.85
    batch.box([0.5, 0.12, 0.12], [lampX - 0.25, h + 0.5, z - 0.2], IRON_DARK)
    batch.box([0.34, 0.14, 0.34], [lampX, h + 0.56, z - 0.3], IRON_DARK)
    batch.box([0.3, 0.42, 0.3], [lampX, h + 0.28, z - 0.3], LAMP)
    batch.box([0.34, 0.12, 0.34], [lampX, h + 0.02, z - 0.3], IRON_DARK)
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

/** An awning over a shopfront: a sloped canopy on two props, with a valance. */
function awning(batch: Batch, at: [number, number, number], width: number, cloth: Surface, options?: { faceYaw?: number; depth?: number }) {
  const yaw = options?.faceYaw ?? 0
  const depth = options?.depth ?? 1.9
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const [x, y, z] = at
  const place = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos]
  batch.box([width, 0.16, depth], place(0, 0, -depth / 2), cloth, { rotY: yaw, rotX: -0.34 })
  // Striped valance: alternating cloth so the awning does not read as a plank.
  const stripes = Math.max(4, Math.round(width / 0.6))
  for (let i = 0; i < stripes; i++) {
    const lx = -width / 2 + (width / stripes) * (i + 0.5)
    batch.box([width / stripes, 0.42, 0.14], place(lx, -0.42, -depth), i % 2 ? cloth : CLOTH_CREAM, { rotY: yaw })
  }
  for (const side of [-1, 1]) {
    batch.box([0.14, 2.4, 0.14], place(side * (width / 2 - 0.2), -1.5, -depth + 0.1), TIMBER_DARK, { rotY: yaw })
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

/** Post-and-rail fencing, for the stable yard and the garden. */
function fence(batch: Batch, from: [number, number], to: [number, number], options?: { height?: number; timber?: Surface }) {
  const height = options?.height ?? 1.25
  const timber = options?.timber ?? TIMBER
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  const yaw = Math.atan2(to[0] - from[0], to[1] - from[1])
  const posts = Math.max(2, Math.round(length / 2.2))
  for (let i = 0; i <= posts; i++) {
    const t = i / posts
    batch.box([0.22, height, 0.22], [from[0] + (to[0] - from[0]) * t, height / 2, from[1] + (to[1] - from[1]) * t], TIMBER_DARK)
  }
  const mid: [number, number, number] = [(from[0] + to[0]) / 2, 0, (from[1] + to[1]) / 2]
  for (const y of [height * 0.42, height * 0.82]) {
    batch.box([0.14, 0.16, length], [mid[0], y, mid[2]], timber, { rotY: yaw })
  }
}

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
