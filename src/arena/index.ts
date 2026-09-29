import * as THREE from 'three'
import { createBatch, disposeMaterial, type Surface } from '../voxelBuild'
import { CENTRE_MEDALLION, PERIMETER_RUNES, SPAWN_SIGIL } from './glyphs'
import {
  BODY_RADIUS,
  BOUNDARY_RADIUS,
  PLATFORM_RADIUS,
  SPAWN_RADIUS,
  checkDimensions,
} from './dimensions'

export * from './dimensions'

/* ------------------------------------------------------------------ *
 * The duelling arena, as a world of its own.
 *
 * This module builds a floor, a perimeter, a boundary and the lights to
 * read them by, and it imports NOTHING from the town. No terrain, no
 * trees, no NPCs, no buildings, no town colliders, no town fog. The
 * complaint that started this work was pines standing in the duel area;
 * the fix is not to hide them, it is for the arena to be somewhere else.
 *
 * Three rules shape the code as much as the brief does:
 *
 *   COST      Everything the player walks on is one `Batch`. A thousand
 *             stone tiles are welded into a handful of meshes, one per
 *             surface, the way the town's buildings are.
 *
 *   DISPOSAL  Every geometry, material and texture allocated here is put
 *             in a ledger at the moment it is made, and `dispose()`
 *             walks the ledger. Nothing is freed by being forgotten.
 *             An arena is entered and left once per duel, so a single
 *             orphaned material is a leak that grows all evening.
 *
 *   NO STATE  No timers, no listeners, no globals, no module-level
 *             mutables. `update(t)` is driven by the caller's clock, so
 *             an arena that is not being rendered is not doing anything.
 * ------------------------------------------------------------------ */

/** Feet stand here. The whole walkable surface is flat, on purpose. */
export const FLOOR_Y = 0

/* ------------------------------- palette ------------------------------ */
/*
 * Dark stone, in the town's own register: desaturated blue-greys, the
 * same family as the Town Hall's #626b70 walls, dropped several stops so
 * that a lit rune and a lit character are the brightest things in frame.
 */
const STONE: Surface[] = [
  { color: '#2c3441', roughness: 0.94 },
  { color: '#232a35', roughness: 0.96 },
  { color: '#343d4d', roughness: 0.92 },
  { color: '#1d2430', roughness: 0.97 },
]
const TRIM: Surface = { color: '#3d4759', roughness: 0.88, metalness: 0.06 }
const BAND: Surface[] = [
  { color: '#272f3c', roughness: 0.93 },
  { color: '#2e3644', roughness: 0.91 },
]
const RUNE_BAND: Surface[] = [
  { color: '#232a36', roughness: 0.94 },
  { color: '#1d2430', roughness: 0.95 },
]
const KERB: Surface = { color: '#394252', roughness: 0.86, metalness: 0.08 }
/* Kept below the characters in value on purpose: the perimeter is the
 * biggest lit area in frame, and if it out-brightens a duellist the eye
 * goes to the furniture instead of the fight. */
const KERB_TOP: Surface = { color: '#39435a', roughness: 0.8, metalness: 0.1 }
const GROOVE: Surface = { color: '#12171f', roughness: 1 }

/** The lit family. `glow` drives emissive, which `update` then breathes. */
const RUNE_LIT: Surface = { color: '#7bc9ce', glow: 2.4, roughness: 0.5, noShadow: true }
const RUNE_GROOVE: Surface = { color: '#1a3038', roughness: 0.9 }
const MEDALLION_LIT: Surface = { color: '#43647a', glow: 0.3, roughness: 0.6, noShadow: true }
const MEDALLION_GROOVE: Surface = { color: '#161d27', roughness: 0.95 }
const POST_STONE: Surface = { color: '#1b212b', roughness: 0.9 }
const POST_LIT: Surface = { color: '#9580b8', glow: 2.8, roughness: 0.4, noShadow: true }

/** Each spawn takes one of the two established duelling colours. */
const SPAWN_COLORS = ['#7bc9ce', '#e35e35'] as const

/* ------------------------------- layout ------------------------------- */
/*
 * Radii, from the middle out. The gaps between bands are the seams; the
 * dark bed underneath is what shows through them.
 */
const COURT_TRIM_IN = 11.6
const COURT_TRIM_OUT = 13.8
const MID_BAND_OUT = 17.0
const RUNE_TRIM_IN = 16.9
const RUNE_TRIM_OUT = 17.5
const RUNE_RING_RADIUS = 18.25
const KERB_OUT = PLATFORM_RADIUS - 0.1

const TILE_PITCH = 2.0
const SEAM = 0.15
/** Tiles are 0.26m thick and sink into the bed, so a seam is a hole, not a line. */
const TILE_THICK = 0.26
const BED_TOP = FLOOR_Y - 0.09

/* ------------------------------- ledger ------------------------------- */

type Ledger = {
  geometry: <T extends THREE.BufferGeometry>(g: T) => T
  material: <T extends THREE.Material>(m: T) => T
  adopt: (meshes: THREE.Mesh[]) => void
  counts: () => { geometries: number; materials: number }
  free: () => DisposalReport
}

/** What `dispose()` actually did, so a caller can assert on it. */
export type DisposalReport = {
  geometries: number
  materials: number
  /** Textures found hanging off those materials and freed with them. */
  textures: number
  lights: number
  meshes: number
}

/**
 * Nothing is built without being written down here first.
 *
 * The four leaks this project has shipped were all the same shape: an
 * allocation that no teardown path knew about. A ledger makes that
 * impossible by construction — `free()` cannot miss what `geometry()`
 * and `material()` were the only way to create.
 */
function createLedger(): Ledger {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  let meshes = 0
  return {
    geometry(g) {
      geometries.add(g)
      return g
    },
    material(m) {
      materials.add(m)
      return m
    },
    adopt(list) {
      for (const mesh of list) {
        meshes += 1
        geometries.add(mesh.geometry)
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m)
      }
    },
    counts: () => ({ geometries: geometries.size, materials: materials.size }),
    free() {
      let textures = 0
      for (const material of materials) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          const texture = value as THREE.Texture | null
          if (texture && texture.isTexture) textures += 1
        }
        // Frees the material AND every map on it, which is the half that
        // Material.dispose() on its own has never done.
        disposeMaterial(material)
      }
      for (const geometry of geometries) geometry.dispose()
      const report = { geometries: geometries.size, materials: materials.size, textures, lights: 0, meshes }
      geometries.clear()
      materials.clear()
      return report
    },
  }
}

/* ------------------------------ the floor ----------------------------- */

/** Stable per-tile shade pick, so the same tile is the same colour forever. */
function tileShade(ix: number, iz: number, length: number) {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453
  return Math.floor((n - Math.floor(n)) * length) % length
}

type Batch = ReturnType<typeof createBatch>

/**
 * The middle of the floor: square flagstones, seamed, flat.
 *
 * Clipped by FARTHEST CORNER rather than by centre, so the ragged edge of
 * the grid always finishes underneath the trim ring that covers it. Clip
 * by centre instead and a stone pokes out into the ring at four points.
 */
function paveCourt(batch: Batch) {
  const half = TILE_PITCH / 2
  const reach = Math.ceil(COURT_TRIM_OUT / TILE_PITCH) + 1
  let laid = 0
  for (let ix = -reach; ix <= reach; ix++) {
    for (let iz = -reach; iz <= reach; iz++) {
      const cx = (ix + 0.5) * TILE_PITCH
      const cz = (iz + 0.5) * TILE_PITCH
      const corner = Math.hypot(Math.abs(cx) + half, Math.abs(cz) + half)
      if (corner > COURT_TRIM_OUT) continue
      laid += 1
      batch.box(
        [TILE_PITCH - SEAM, TILE_THICK, TILE_PITCH - SEAM],
        [cx, FLOOR_Y - TILE_THICK / 2, cz],
        STONE[tileShade(ix, iz, STONE.length)],
      )
      /*
       * Restrained surface detail: about one stone in twelve is chipped
       * along an edge. Two small boxes of the bed colour, set flush, so
       * the stone reads as cut and laid rather than printed. Deliberately
       * sparse — at one in three it becomes a texture, and a busy floor
       * is a floor you cannot see a telegraph on.
       */
      if (tileShade(ix + 41, iz - 17, 12) !== 0) continue
      const along = tileShade(ix + 7, iz + 3, 4)
      const flip = along < 2 ? 1 : -1
      const lengthwise = along % 2 === 0
      const nick = 0.34
      batch.box(
        lengthwise ? [nick * 2, 0.08, nick] : [nick, 0.08, nick * 2],
        [
          cx + (lengthwise ? 0 : flip * (TILE_PITCH - SEAM - nick) / 2),
          FLOOR_Y - 0.04,
          cz + (lengthwise ? flip * (TILE_PITCH - SEAM - nick) / 2 : 0),
        ],
        GROOVE,
      )
    }
  }
  return laid
}

/**
 * A ring of radial flagstones.
 *
 * Boxes are straight and a ring is not, but at these segment counts the
 * sagitta is under two centimetres — smaller than the seam it sits in —
 * so the chord reads as a cut stone rather than as a faceted cylinder.
 *
 * A box rotated by `PI/2 - angle` about Y has its local +z pointing
 * straight out from the middle, which is what makes the stone radial.
 */
function paveRing(
  batch: Batch,
  inner: number,
  outer: number,
  segments: number,
  surfaces: Surface[],
  top = FLOOR_Y,
  thickness = TILE_THICK,
  seam = SEAM,
) {
  const mid = (inner + outer) / 2
  const depth = outer - inner - seam
  const width = 2 * mid * Math.tan(Math.PI / segments) - seam
  for (let i = 0; i < segments; i++) {
    const angle = ((i + 0.5) / segments) * Math.PI * 2
    batch.box(
      [width, thickness, depth],
      [Math.cos(angle) * mid, top - thickness / 2, Math.sin(angle) * mid],
      surfaces[i % surfaces.length],
      { rotY: Math.PI / 2 - angle },
    )
  }
  return segments
}

/** Twenty-four runes, cycling the eight designs so no two neighbours match. */
function inlayRunes(batch: Batch) {
  const count = 24
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    batch.plate({
      rows: PERIMETER_RUNES[i % PERIMETER_RUNES.length],
      palette: { '#': RUNE_LIT, '-': RUNE_GROOVE },
      cell: 0.2,
      depth: 1,
      at: [Math.cos(angle) * RUNE_RING_RADIUS, FLOOR_Y - 0.06, Math.sin(angle) * RUNE_RING_RADIUS],
      // Turns the glyph's own "up" to point out of the circle.
      faceYaw: Math.PI / 2 - angle,
      tiltX: -Math.PI / 2,
    })
  }
  return count
}

/**
 * The posts that hold the boundary up.
 *
 * Deliberately OUTSIDE the wall, standing on the unreachable kerb. A post
 * a player can stand behind is a post that hides a player, and the whole
 * point of the lighting here is that both duellists stay visible.
 */
function raisePosts(batch: Batch) {
  const count = 12
  const radius = (BOUNDARY_RADIUS + KERB_OUT) / 2
  for (let i = 0; i < count; i++) {
    const angle = ((i + 0.5) / count) * Math.PI * 2
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const rotY = Math.PI / 2 - angle
    batch.box([0.78, 0.26, 0.78], [x, 0.3, z], POST_STONE, { rotY })
    batch.box([0.52, 1.3, 0.52], [x, 1.06, z], POST_STONE, { rotY })
    batch.box([0.66, 0.18, 0.66], [x, 1.8, z], POST_STONE, { rotY })
    // The lantern: a small lit cube in a stone collar, not a lamp model.
    batch.box([0.3, 0.3, 0.3], [x, 2.05, z], POST_LIT, { rotY })
    batch.box([0.46, 0.12, 0.46], [x, 2.26, z], POST_STONE, { rotY })
  }
  return count
}

/** Both spawn marks, each turned so its chevron points at the middle. */
function markSpawns(batch: Batch) {
  const spawns: ArenaSpawn[] = []
  for (const [index, sign] of [1, -1].entries()) {
    const z = SPAWN_RADIUS * sign
    const color = SPAWN_COLORS[index]
    batch.plate({
      rows: SPAWN_SIGIL,
      palette: {
        '#': { color, glow: 2.6, roughness: 0.45, noShadow: true },
        '-': { color: '#151b24', roughness: 0.95 },
      },
      cell: 0.2,
      depth: 1,
      at: [0, FLOOR_Y - 0.06, z],
      // The sigil is drawn with its chevron aimed at -y; +z spawn needs it
      // turned a half turn so both marks point inward.
      faceYaw: sign > 0 ? Math.PI : 0,
      tiltX: -Math.PI / 2,
    })
    spawns.push({
      id: index === 0 ? 'a' : 'b',
      position: new THREE.Vector3(0, FLOOR_Y, z),
      // Characters in this project face +z, so this is the yaw that looks
      // at the centre of the floor from wherever the spawn is.
      facing: Math.atan2(0, -z),
      color,
    })
  }
  return spawns as [ArenaSpawn, ArenaSpawn]
}

/* ------------------------------ the arena ----------------------------- */

export type ArenaSpawn = {
  id: 'a' | 'b'
  /** Feet position. Flat floor, so y is always FLOOR_Y. */
  position: THREE.Vector3
  /** Y rotation that faces the middle. */
  facing: number
  /** The colour of this side's floor mark, for matching a nameplate or a bar. */
  color: string
}

export type ArenaStats = {
  boxes: number
  triangles: number
  meshes: number
  lights: number
  geometries: number
  materials: number
}

export type Arena = {
  /** Everything: floor, boundary, posts, lights. Add this to a scene. */
  root: THREE.Object3D
  spawns: [ArenaSpawn, ArenaSpawn]
  /** Outer edge of the stone. */
  radius: number
  /** Where the magical wall stands. Nothing walks past this. */
  boundaryRadius: number
  floorY: number

  /** True when a body of `bodyRadius` standing at `p` is fully inside. */
  contains: (p: THREE.Vector3, bodyRadius?: number) => boolean
  /** Push `p` back inside if it is out. Returns true if it had to. Mutates `p`. */
  confine: (p: THREE.Vector3, bodyRadius?: number) => boolean
  /** Move by (dx,dz) and stay in. Sliding along the wall is preserved. */
  slide: (p: THREE.Vector3, dx: number, dz: number, bodyRadius?: number) => void
  /** Nearest legal standing point to an arbitrary target, e.g. a blink. */
  clampTarget: (p: THREE.Vector3, bodyRadius?: number) => THREE.Vector3

  /** Swap the scene over to the arena's black void, keeping what was there. */
  attach: (scene: THREE.Scene) => void
  /** Put the scene's own sky and fog back. */
  detach: () => void
  /** Breathe the runes and the boundary. `ms` is any monotonic millisecond clock. */
  update: (ms: number) => void

  stats: ArenaStats
  dispose: () => DisposalReport
}

export type ArenaOptions = {
  /**
   * Body radius the boundary is sized against when a call does not say.
   * Defaults to the same 0.62m src/battle/nav.ts uses for the player.
   */
  bodyRadius?: number
}

export function createArena(options: ArenaOptions = {}): Arena {
  const problems = checkDimensions()
  if (problems.length) throw new Error(`arena dimensions are wrong:\n  ${problems.join('\n  ')}`)

  const defaultBody = options.bodyRadius ?? BODY_RADIUS
  const ledger = createLedger()
  const root = new THREE.Group()
  root.name = 'arena'

  /* ---- the welded body: one batch, a handful of meshes ---- */
  const batch = createBatch()
  paveCourt(batch)
  paveRing(batch, COURT_TRIM_IN, COURT_TRIM_OUT, 64, [TRIM], FLOOR_Y + 0.02, TILE_THICK + 0.02)
  paveRing(batch, COURT_TRIM_OUT, MID_BAND_OUT, 56, BAND)
  paveRing(batch, RUNE_TRIM_IN, RUNE_TRIM_OUT, 64, [TRIM], FLOOR_Y + 0.02, TILE_THICK + 0.02)
  paveRing(batch, RUNE_TRIM_OUT, BOUNDARY_RADIUS, 48, RUNE_BAND)
  // A dark groove where the wall meets the floor, so the barrier has a footing.
  paveRing(batch, BOUNDARY_RADIUS - 0.16, BOUNDARY_RADIUS + 0.16, 72, [GROOVE], FLOOR_Y + 0.01, 0.3, 0)
  // Beyond the wall: a raised lip nobody can reach, which is what makes the
  // platform read as a built thing rather than a hole cut in the dark.
  paveRing(batch, BOUNDARY_RADIUS, KERB_OUT, 72, [KERB], FLOOR_Y + 0.12, 0.6, 0.1)
  paveRing(batch, BOUNDARY_RADIUS + 0.28, KERB_OUT - 0.12, 72, [KERB_TOP], FLOOR_Y + 0.22, 0.24, 0.1)
  inlayRunes(batch)
  batch.plate({
    rows: CENTRE_MEDALLION,
    palette: { '#': MEDALLION_LIT, '-': MEDALLION_GROOVE },
    cell: 0.22,
    depth: 1,
    at: [0, FLOOR_Y - 0.08, 0],
    tiltX: -Math.PI / 2,
  })
  const spawns = markSpawns(batch)

  const stone = new THREE.Group()
  stone.name = 'arena-stone'
  root.add(stone)
  const built = batch.build(stone)
  ledger.adopt(built.meshes)
  /*
   * The floor casts nothing.
   *
   * A flat floor's shadow falls on itself, so every one of these meshes
   * in the shadow pass is a draw call that changes no pixel. Dropping
   * them halves the arena's cost and the picture is identical. The
   * shadows that matter — the duellists' — are cast by the duellists,
   * and by the posts, which are built separately below for exactly this.
   */
  for (const mesh of built.meshes) {
    mesh.castShadow = false
    mesh.receiveShadow = true
  }

  // The posts stand proud of the floor, so their shadows do land somewhere.
  const postBatch = createBatch()
  raisePosts(postBatch)
  const posts = postBatch.build(stone)
  ledger.adopt(posts.meshes)

  /* ---- the mass under the floor ---- */
  /*
   * Three stacked shells falling away from the rim. Almost none of it is
   * lit, which is the point: the platform has to have thickness where the
   * light reaches and then simply stop existing.
   */
  const shell = (
    top: number,
    bottom: number,
    height: number,
    color: string,
    openEnded: boolean,
    segments: number,
  ) => {
    const geometry = ledger.geometry(
      new THREE.CylinderGeometry(top, bottom, height, segments, 1, openEnded),
    )
    const material = ledger.material(
      new THREE.MeshStandardMaterial({ color, roughness: 0.98, metalness: 0 }),
    )
    const mesh = new THREE.Mesh(geometry, material)
    mesh.receiveShadow = true
    mesh.castShadow = false
    stone.add(mesh)
    return mesh
  }
  // The bed: what shows through every seam in the floor above it.
  const bed = shell(PLATFORM_RADIUS - 0.08, PLATFORM_RADIUS - 0.08, 0.62, '#0a0d13', false, 72)
  // Same reasoning as the floor: nothing below the rim is ever in light.
  bed.position.y = BED_TOP - 0.31
  const plinth = shell(PLATFORM_RADIUS - 0.5, 15.2, 3.6, '#070a0f', true, 64)
  plinth.position.y = BED_TOP - 0.62 - 1.8
  const footing = shell(15.2, 8.4, 3.0, '#05070b', true, 40)
  footing.position.y = BED_TOP - 0.62 - 3.6 - 1.5

  /* ---- the boundary ---- */
  /*
   * A low wall of light. Three nested shells rather than one gradient
   * texture: banding is on style for a voxel world, the bands give the
   * falloff a gradient would, and there is no texture to leak.
   *
   * Additive over a black world means the wall glows without lighting
   * anything, so it can be bright enough to read as a hard edge without
   * washing the floor out.
   */
  const fieldMeshes: THREE.Mesh[] = []
  const fieldBase: number[] = []
  const WALL_HEIGHT = 1.15

  const wallBand = (radius: number, height: number, bottom: number, color: string, opacity: number, order: number) => {
    const geometry = ledger.geometry(new THREE.CylinderGeometry(radius, radius, height, 96, 1, true))
    const material = ledger.material(
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.y = bottom + height / 2
    mesh.renderOrder = order
    stone.add(mesh)
    fieldMeshes.push(mesh)
    fieldBase.push(opacity)
    return mesh
  }

  /*
   * The body of the wall: three shells, each shorter and slightly further
   * out than the last, so the field is densest at the floor and thins
   * toward the top. A gradient without a gradient texture.
   */
  wallBand(BOUNDARY_RADIUS, WALL_HEIGHT, FLOOR_Y, '#3fa8c4', 0.2, 2)
  wallBand(BOUNDARY_RADIUS + 0.05, WALL_HEIGHT * 0.66, FLOOR_Y, '#4fbcd6', 0.2, 2)
  wallBand(BOUNDARY_RADIUS + 0.1, WALL_HEIGHT * 0.3, FLOOR_Y, '#66d2e6', 0.22, 2)
  /*
   * The two rails are what turn a pane of frosted glass into a barrier:
   * one bright line where the field meets the stone, and one along its
   * top edge. An edge is what the eye reads as "this is where you stop".
   */
  wallBand(BOUNDARY_RADIUS, 0.07, FLOOR_Y + 0.01, '#cff6fb', 0.75, 3)
  wallBand(BOUNDARY_RADIUS + 0.02, 0.05, FLOOR_Y + WALL_HEIGHT - 0.05, '#b8eef7', 0.5, 3)

  /* ---- lighting ---- */
  /*
   * Seven lights, and every one of them has a job:
   *
   *   key      overhead, the only shadow caster, fitted to the platform
   *   fill     low warm bounce from the opposite side, so a character's
   *            shadow side is dark rather than black
   *   sky      hemisphere at near nothing, to stop pure-black silhouettes
   *   rim x2   cool light along the boundary, which is what keeps a
   *            player standing at the edge readable against the void
   *   spawn x2 one over each mark, tinted to that side
   *
   * The void gets no light at all, which is what the brief asked for: if
   * a light reached past the rim there would be something out there.
   */
  const lights: THREE.Light[] = []
  const addLight = <T extends THREE.Light>(light: T) => {
    root.add(light)
    lights.push(light)
    return light
  }

  const key = addLight(new THREE.DirectionalLight('#dce9ff', 2.9))
  key.position.set(7, 30, 12)
  key.target.position.set(0, 0, 0)
  root.add(key.target)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  const shadowCam = key.shadow.camera as THREE.OrthographicCamera
  shadowCam.left = -PLATFORM_RADIUS - 2
  shadowCam.right = PLATFORM_RADIUS + 2
  shadowCam.top = PLATFORM_RADIUS + 2
  shadowCam.bottom = -PLATFORM_RADIUS - 2
  shadowCam.near = 1
  shadowCam.far = 80
  shadowCam.updateProjectionMatrix()
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.035

  const fill = addLight(new THREE.DirectionalLight('#ffd9a8', 0.95))
  fill.position.set(-14, 11, -16)
  fill.target.position.set(0, 0, 0)
  root.add(fill.target)

  addLight(new THREE.HemisphereLight('#4c5c7a', '#04060a', 0.5))

  for (const angle of [Math.PI / 2, -Math.PI / 2]) {
    const rim = addLight(new THREE.PointLight('#8fd4e0', 40, 30, 2))
    rim.position.set(Math.cos(angle) * (BOUNDARY_RADIUS - 1.5), 3.0, Math.sin(angle) * (BOUNDARY_RADIUS - 1.5))
  }
  for (const spawn of spawns) {
    const lamp = addLight(new THREE.PointLight(spawn.color, 14, 16, 2))
    lamp.position.set(spawn.position.x, 3.4, spawn.position.z)
  }

  /* ---- animation targets ---- */
  /*
   * Collected by looking at what was actually built rather than by
   * keeping a second list in step with the first. A surface with
   * emissive strength is a thing that glows; that is the whole test.
   */
  const glowMaterials: THREE.MeshStandardMaterial[] = []
  const glowBase: number[] = []
  for (const mesh of [...built.meshes, ...posts.meshes]) {
    const material = mesh.material as THREE.MeshStandardMaterial
    if (material.emissiveIntensity > 0 && material.emissive && material.emissive.getHex() !== 0) {
      glowMaterials.push(material)
      glowBase.push(material.emissiveIntensity)
    }
  }

  /* ---- scene environment ---- */
  let attached: THREE.Scene | null = null
  let priorBackground: THREE.Scene['background'] = null
  let priorFog: THREE.Scene['fog'] = null
  const voidColor = new THREE.Color('#000000')

  const attach = (scene: THREE.Scene) => {
    if (attached) detach()
    attached = scene
    priorBackground = scene.background
    priorFog = scene.fog
    // Total darkness, and no fog: fog would put a colour on the void and
    // the void is supposed to be nothing at all.
    scene.background = voidColor
    scene.fog = null
    scene.add(root)
  }

  const detach = () => {
    if (!attached) return
    attached.remove(root)
    attached.background = priorBackground
    attached.fog = priorFog
    attached = null
    priorBackground = null
    priorFog = null
  }

  /* ---- containment ---- */
  /*
   * The boundary is a circle, so the whole of it is one comparison and
   * there is no corner for a body to squeeze through. Clamping the RADIUS
   * and leaving the angle alone is also what gives sliding for free: a
   * player running at the wall keeps every bit of their movement that was
   * along it and loses only the part that was into it.
   */
  const limitFor = (bodyRadius: number) => Math.max(0, BOUNDARY_RADIUS - bodyRadius)

  const contains = (p: THREE.Vector3, bodyRadius = defaultBody) =>
    Number.isFinite(p.x) && Number.isFinite(p.z) && Math.hypot(p.x, p.z) <= limitFor(bodyRadius)

  const confine = (p: THREE.Vector3, bodyRadius = defaultBody) => {
    const limit = limitFor(bodyRadius)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      p.set(0, FLOOR_Y, 0)
      return true
    }
    const d = Math.hypot(p.x, p.z)
    if (d <= limit) return false
    if (d < 1e-9) {
      // Degenerate: at the exact centre nothing is out of bounds anyway.
      return false
    }
    // Scaled to a hair inside, because a point landing exactly ON the limit
    // comes back out of Math.hypot a float above it about half the time.
    const k = (limit * (1 - 1e-9)) / d
    p.x *= k
    p.z *= k
    return true
  }

  const slide = (p: THREE.Vector3, dx: number, dz: number, bodyRadius = defaultBody) => {
    p.x += dx
    p.z += dz
    confine(p, bodyRadius)
  }

  const clampTarget = (p: THREE.Vector3, bodyRadius = defaultBody) => {
    const out = p.clone()
    out.y = FLOOR_Y
    confine(out, bodyRadius)
    return out
  }

  /* ---- per-frame ---- */
  const update = (ms: number) => {
    const t = ms * 0.001
    // Two beats of different lengths, so the ring never looks like it is
    // on a metronome. Nothing is allocated here.
    const slow = 0.88 + Math.sin(t * 0.7) * 0.12
    const fast = 0.9 + Math.sin(t * 1.9 + 1.1) * 0.1
    for (let i = 0; i < glowMaterials.length; i++) {
      glowMaterials[i].emissiveIntensity = glowBase[i] * slow
    }
    for (let i = 0; i < fieldMeshes.length; i++) {
      ;(fieldMeshes[i].material as THREE.MeshBasicMaterial).opacity = fieldBase[i] * fast
    }
  }

  /* ---- teardown ---- */
  let disposed = false
  const dispose = (): DisposalReport => {
    if (disposed) return { geometries: 0, materials: 0, textures: 0, lights: 0, meshes: 0 }
    disposed = true
    detach()
    for (const light of lights) {
      light.removeFromParent()
      // PointLight/SpotLight hold a shadow with a map once they have been
      // rendered; DirectionalLight.dispose() is the only thing that frees it.
      light.dispose()
    }
    const report = ledger.free()
    // Drop the graph itself, so nothing keeps a reference to a freed buffer.
    root.clear()
    stone.clear()
    return { ...report, lights: lights.length }
  }

  const counts = ledger.counts()
  const stats: ArenaStats = {
    boxes: built.boxes + posts.boxes,
    triangles:
      built.triangles +
      posts.triangles +
      bedTriangles(bed) +
      bedTriangles(plinth) +
      bedTriangles(footing) +
      fieldTriangles(fieldMeshes),
    meshes: built.meshes.length + posts.meshes.length + 3 + fieldMeshes.length,
    lights: lights.length,
    geometries: counts.geometries,
    materials: counts.materials,
  }

  return {
    root,
    spawns,
    radius: PLATFORM_RADIUS,
    boundaryRadius: BOUNDARY_RADIUS,
    floorY: FLOOR_Y,
    contains,
    confine,
    slide,
    clampTarget,
    attach,
    detach,
    update,
    stats,
    dispose,
  }
}

/** Triangle count of a mesh, read off its index rather than guessed. */
function bedTriangles(mesh: THREE.Mesh) {
  const index = mesh.geometry.getIndex()
  if (index) return index.count / 3
  return mesh.geometry.getAttribute('position').count / 3
}

function fieldTriangles(meshes: THREE.Mesh[]) {
  return meshes.reduce((sum, mesh) => sum + bedTriangles(mesh), 0)
}
