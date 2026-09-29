import * as THREE from 'three'

/* ------------------------------------------------------------------ *
 * The voxel workshop: the shared plumbing behind the town buildings,
 * the trees and the trade emblems.
 *
 * Everything in this project is authored as pixel art and extruded into
 * cubes. The technique is settled; what this module adds is the cost
 * discipline the technique needs once the art gets detailed.
 *
 * A building with a forge, shutters, a chimney and a hanging sign is a
 * couple of hundred boxes. Built as a couple of hundred THREE.Mesh
 * objects it is a couple of hundred draw calls, and seventeen of those
 * is a slideshow. So boxes are COLLECTED, not added: a `Batch` takes
 * boxes tagged with a surface, welds every box sharing a surface into
 * one BufferGeometry, and emits one Mesh per surface. The whole town
 * comes out as about a dozen meshes however much detail goes into it.
 *
 * Cubes are drawn at VOXEL_FILL, slightly over their cell, which is the
 * same trick characters.ts and npcs.ts use: neighbours overlap and no
 * seam shows through to the sky.
 * ------------------------------------------------------------------ */

/** Cubes overlap slightly. Anything under 1 leaves gaps you can see the sky through. */
export const VOXEL_FILL = 1.02

export type Surface = {
  color: string
  /** Emissive strength. Above zero the surface glows: window light, forge heat, lamps. */
  glow?: number
  roughness?: number
  metalness?: number
  /** Below 1 the surface is see-through: glass panes, chimney smoke, steam. */
  opacity?: number
  /** Skip this surface in the shadow pass. Lamps and glass gain nothing from casting. */
  noShadow?: boolean
}

type Bucket = {
  surface: Surface
  positions: number[]
  normals: number[]
  indices: number[]
  vertices: number
}

const surfaceKey = (surface: Surface) =>
  `${surface.color}|${surface.glow ?? 0}|${surface.roughness ?? 0.82}|${surface.metalness ?? 0}|${surface.opacity ?? 1}|${surface.noShadow ? 1 : 0}`

/**
 * One box, welded into a growing buffer.
 *
 * Written out by hand rather than pulled from BufferGeometryUtils so the world
 * keeps its single `three` import and the bundle audit has nothing new to find.
 */
const UNIT = new THREE.BoxGeometry(1, 1, 1)
const UNIT_POSITION = UNIT.attributes.position.array as Float32Array
const UNIT_NORMAL = UNIT.attributes.normal.array as Float32Array
const UNIT_INDEX = Array.from(UNIT.index!.array)

const scratch = new THREE.Matrix4()
const scratchNormal = new THREE.Matrix3()
const vertex = new THREE.Vector3()
const normal = new THREE.Vector3()

function weld(bucket: Bucket, matrix: THREE.Matrix4) {
  scratchNormal.getNormalMatrix(matrix)
  const base = bucket.vertices
  for (let i = 0; i < UNIT_POSITION.length; i += 3) {
    vertex.set(UNIT_POSITION[i], UNIT_POSITION[i + 1], UNIT_POSITION[i + 2]).applyMatrix4(matrix)
    bucket.positions.push(vertex.x, vertex.y, vertex.z)
    normal.set(UNIT_NORMAL[i], UNIT_NORMAL[i + 1], UNIT_NORMAL[i + 2]).applyMatrix3(scratchNormal).normalize()
    bucket.normals.push(normal.x, normal.y, normal.z)
  }
  for (const index of UNIT_INDEX) bucket.indices.push(base + index)
  bucket.vertices += UNIT_POSITION.length / 3
}

export type BoxOptions = {
  /** Yaw in radians, about the box's own centre. */
  rotY?: number
  rotX?: number
  rotZ?: number
}

export type Batch = {
  /** One box: size in metres, centre in metres, and the surface it belongs to. */
  box: (size: [number, number, number], at: [number, number, number], surface: Surface, options?: BoxOptions) => void
  /**
   * A pixel grid extruded into cubes on a plane, the emblem/sign primitive.
   * `rows` are read top-down, `x` runs left to right in the plane's local +x.
   */
  plate: (plan: PlatePlan) => void
  /** Boxes collected so far. The honest number behind "how much did this cost". */
  count: () => number
  /**
   * One Mesh per surface, parented to `into`.
   *
   * `dispose` frees the geometry and material of every mesh this call built.
   * A batch owns those outright — nothing else shares them — so whoever tears
   * down the group the meshes were parented to has to call it, or the whole
   * welded body stays resident on the GPU.
   */
  build: (into: THREE.Object3D) => { meshes: THREE.Mesh[]; boxes: number; triangles: number; dispose: () => void }
}

export type PlatePlan = {
  rows: string[]
  palette: Record<string, Surface | undefined>
  /** Cell size in metres. */
  cell: number
  /** Cube depth, in cells. 1 is a flat plate, 2 reads as a carved board. */
  depth?: number
  /** Centre of the plate. */
  at: [number, number, number]
  /** Rotation of the plate about Y; 0 faces −z, the side every shop door is on. */
  faceYaw?: number
  /** Tilt, for a board that hangs at an angle or lies on a lectern. */
  tiltX?: number
}

export function createBatch(): Batch {
  const buckets = new Map<string, Bucket>()
  let boxes = 0

  const bucketFor = (surface: Surface) => {
    const key = surfaceKey(surface)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { surface, positions: [], normals: [], indices: [], vertices: 0 }
      buckets.set(key, bucket)
    }
    return bucket
  }

  const box: Batch['box'] = (size, at, surface, options) => {
    const bucket = bucketFor(surface)
    scratch.makeRotationFromEuler(new THREE.Euler(options?.rotX ?? 0, options?.rotY ?? 0, options?.rotZ ?? 0))
    scratch.scale(new THREE.Vector3(size[0], size[1], size[2]))
    scratch.setPosition(at[0], at[1], at[2])
    weld(bucket, scratch)
    boxes += 1
  }

  const plate: Batch['plate'] = plan => {
    const rows = plan.rows
    const height = rows.length
    const width = Math.max(...rows.map(row => row.length))
    const cell = plan.cell
    const depth = plan.depth ?? 1
    const yaw = plan.faceYaw ?? 0
    const tilt = plan.tiltX ?? 0
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const key = rows[y][x]
        const surface = key === undefined ? undefined : plan.palette[key]
        if (!surface) continue
        // Local plate coordinates: +x right across the board, +y up it.
        const lx = (x - (width - 1) / 2) * cell
        const ly = ((height - 1) / 2 - y) * cell
        const tiltedY = ly * Math.cos(tilt)
        const tiltedZ = -ly * Math.sin(tilt)
        box(
          [cell * VOXEL_FILL, cell * VOXEL_FILL, cell * depth * VOXEL_FILL],
          [
            plan.at[0] + lx * cos + tiltedZ * sin,
            plan.at[1] + tiltedY,
            plan.at[2] - lx * sin + tiltedZ * cos,
          ],
          surface,
          { rotY: yaw, rotX: tilt },
        )
      }
    }
  }

  return {
    box,
    plate,
    count: () => boxes,
    build(into) {
      const meshes: THREE.Mesh[] = []
      let triangles = 0
      for (const bucket of buckets.values()) {
        if (!bucket.indices.length) continue
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
        geometry.setIndex(bucket.indices)
        geometry.computeBoundingSphere()
        const mesh = new THREE.Mesh(geometry, materialFor(bucket.surface))
        mesh.castShadow = !bucket.surface.noShadow
        mesh.receiveShadow = !bucket.surface.noShadow
        into.add(mesh)
        meshes.push(mesh)
        triangles += bucket.indices.length / 3
      }
      return {
        meshes,
        boxes,
        triangles,
        dispose() {
          for (const mesh of meshes) {
            mesh.geometry.dispose()
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              disposeMaterial(material)
            }
          }
        },
      }
    },
  }
}

/**
 * Free a material and the textures hanging off it.
 *
 * `Material.dispose()` releases the shader program and nothing else: any map
 * still holds its own GPU texture. Every leak this project has shipped — the
 * spell VFX disc, the loot coins — was a material disposed without its map.
 */
export function disposeMaterial(material: THREE.Material) {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    const texture = value as THREE.Texture | null
    if (texture && texture.isTexture) texture.dispose()
  }
  material.dispose()
}

export function materialFor(surface: Surface) {
  const glow = surface.glow ?? 0
  const opacity = surface.opacity ?? 1
  return new THREE.MeshStandardMaterial({
    color: surface.color,
    roughness: surface.roughness ?? 0.82,
    metalness: surface.metalness ?? 0,
    emissive: glow > 0 ? surface.color : '#000000',
    emissiveIntensity: glow,
    transparent: opacity < 1,
    opacity,
    // Smoke and glass keep writing depth: these are chunky solids seen from
    // outside, and sorting a hundred welded quads per frame costs more than the
    // few overlaps it would tidy up.
    depthWrite: true,
  })
}

/**
 * Weld a list of cube cells into one geometry, for art that is INSTANCED
 * rather than placed once: a tree species is built as cells, welded, and then
 * stamped across the world by one InstancedMesh per colour.
 */
export function weldCells(cells: Array<[number, number, number]>, cell: number): THREE.BufferGeometry {
  const bucket: Bucket = { surface: { color: '#000' }, positions: [], normals: [], indices: [], vertices: 0 }
  const size = cell * VOXEL_FILL
  for (const [x, y, z] of cells) {
    scratch.identity()
    scratch.scale(new THREE.Vector3(size, size, size))
    scratch.setPosition(x * cell, y * cell, z * cell)
    weld(bucket, scratch)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3))
  geometry.setIndex(bucket.indices)
  geometry.computeBoundingSphere()
  return geometry
}

/* Face order: +x, −x, +y, −y, +z, −z. Corners wound counter-clockwise seen
 * from outside, which is what THREE's default front-face culling expects. */
const FACES: Array<{ n: [number, number, number]; corners: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], corners: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
  { n: [-1, 0, 0], corners: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, 1, 0], corners: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], corners: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { n: [0, 0, 1], corners: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], corners: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
]

/**
 * Weld the VISIBLE SURFACE of a voxel body: one quad per cell face whose
 * neighbour is empty, and nothing for the faces that are buried.
 *
 * This is the same geometry a pile of cubes would produce, minus the parts
 * nobody can see. It matters because trees are the one thing in this world that
 * is both large and numerous: a mid-sized pine is about 360 canopy cells, which
 * is 4,300 triangles as whole cubes and about 1,000 as its own surface. Across
 * a forest that is the difference between a scene that draws and one that does
 * not, and the picture is identical either way.
 *
 * `occupied` is asked about neighbours across the WHOLE body, not just the cells
 * being welded, so the seam between two colours of the same tree stays buried
 * instead of being drawn twice from inside.
 */
export function weldVoxelShell(
  cells: Array<[number, number, number]>,
  occupied: (x: number, y: number, z: number) => boolean,
  cell: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let vertices = 0
  for (const [cx, cy, cz] of cells) {
    for (const face of FACES) {
      if (occupied(cx + face.n[0], cy + face.n[1], cz + face.n[2])) continue
      for (const [ox, oy, oz] of face.corners) {
        positions.push((cx + ox) * cell, (cy + oy) * cell, (cz + oz) * cell)
        normals.push(face.n[0], face.n[1], face.n[2])
      }
      indices.push(vertices, vertices + 1, vertices + 2, vertices, vertices + 2, vertices + 3)
      vertices += 4
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** Stable per-cell brightness jitter, so a flat colour still reads as cubes. */
export function shadeJitter(x: number, y: number, z: number) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return 0.93 + (n - Math.floor(n)) * 0.14
}

/**
 * Rows are declared as span lists so every row is exactly `width` long by
 * construction. Hand-typed strings drift by a character and voxels vanish.
 * Same helper, same reason, as the animal sprites in wildlife.ts.
 */
export function spans(width: number, rows: Array<Array<[number, number, string]>>): string[] {
  return rows.map(segments => {
    const cells = new Array<string>(width).fill('.')
    for (const [from, to, ch] of segments) {
      for (let x = Math.max(0, from); x <= Math.min(width - 1, to); x++) cells[x] = ch
    }
    return cells.join('')
  })
}
