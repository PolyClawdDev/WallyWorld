import * as THREE from 'three'
import {
  ROAM_INSET,
  brassTrailWaypoints,
  highHuntArea,
  huntingArea,
  huntTrails,
  insideRegion,
  isGreen,
  regionArea,
  regionOutline,
  trailWaypoints,
  wildRegions,
} from './wildlife'
import type { WildRegion } from './wildlife'
import { createBatch, disposeMaterial } from './voxelBuild'
import type { Surface } from './voxelBuild'
import { createTreeField, treeMetrics } from './treeArt'
import type { TreePlacement, TreeSpeciesId } from './treeArt'

/* ------------------------------------------------------------------ *
 * The green. Everything the player needs in order to find the hunt:
 * the shape of the open ground, the woods standing on it, a pond, a
 * hunter's camp, and lit dirt trails out of the plaza with signposts.
 *
 * Three things here are deliberate and worth reading before changing:
 *
 * 1. THE GROUND IS NOT A DISC. Each region's grass is cut to the same
 *    signed-distance outline the animals are fenced by, so what the
 *    player sees is exactly where the animals can be. It used to be a
 *    `CircleGeometry` scaled to a radius, which is why the hunting
 *    ground looked like a circle: it was one.
 *
 * 2. PROPS ARE BATCHED. Trail planks, fence rails, stumps, boulders,
 *    grass and signpost timber all go into one `Batch` and come out as
 *    about a dozen meshes. Built one THREE.Mesh at a time — which is
 *    how it used to be — the trails alone were a hundred and fifty
 *    draw calls.
 *
 * 3. THERE ARE THREE POINT LIGHTS OUT HERE, NOT EIGHTEEN. Every extra
 *    point light is another iteration inside every material's fragment
 *    shader for every pixel of the scene, and on a software renderer
 *    that is the most expensive thing in this file by a wide margin.
 *    Lamps still glow — emissive costs nothing — they just do not each
 *    light the world.
 * ------------------------------------------------------------------ */

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Spot = { x: number; z: number; roll: number }

/**
 * Scatter `count` points across a region's open green, lobe by lobe in
 * proportion to area, so a lopsided region gets planted lopsidedly instead of
 * piling everything into the middle of its biggest blob.
 */
function scatter(region: WildRegion, count: number, rng: () => number, inset: number): Spot[] {
  const out: Spot[] = []
  const area = region.lobes.reduce((sum, lobe) => sum + lobe.r * lobe.r, 0)
  for (let attempt = 0; attempt < count * 8 && out.length < count; attempt++) {
    let pick = rng() * area
    let lobe = region.lobes[0]
    for (const candidate of region.lobes) {
      lobe = candidate
      pick -= candidate.r * candidate.r
      if (pick <= 0) break
    }
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * lobe.r
    const x = lobe.x + Math.cos(angle) * radius
    const z = lobe.z + Math.sin(angle) * radius
    if (!isGreen(x, z, inset)) continue
    if (!insideRegion(region, x, z, inset)) continue
    // Keep every hunt trail walkable rather than growing a pine in the middle.
    if (huntTrails.some(trail => trail.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 4.5))) continue
    out.push({ x, z, roll: rng() })
  }
  return out
}

/* --- surfaces -------------------------------------------------------- */

const TIMBER: Surface = { color: '#59422c', roughness: 0.9 }
const TIMBER_DARK: Surface = { color: '#3b2b1c', roughness: 0.92 }
const PLANK: Surface = { color: '#6b5a44', roughness: 0.95 }
const PLANK_WORN: Surface = { color: '#7c6a50', roughness: 0.95 }
const STONE: Surface = { color: '#5a6167', roughness: 0.95 }
const STONE_DARK: Surface = { color: '#44494e', roughness: 0.95 }
const MOSS: Surface = { color: '#4a6248', roughness: 0.95 }
const GRASS: Surface = { color: '#54723f', roughness: 0.95 }
const GRASS_DRY: Surface = { color: '#7a7c44', roughness: 0.95 }
const FERN: Surface = { color: '#436143', roughness: 0.95 }
const CANVAS: Surface = { color: '#6d5a42', roughness: 0.92 }
const LAMP: Surface = { color: '#f0b84d', glow: 2.2, roughness: 0.2, noShadow: true }
const BRASS_LAMP: Surface = { color: '#c4893a', glow: 1.9, roughness: 0.25, noShadow: true }

/** One ground tone per region kind, cut to the region's own outline. */
function groundPatch(region: WildRegion) {
  const outline = regionOutline(region, 56)
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)))
  const geometry = new THREE.ShapeGeometry(shape)
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: region.color, roughness: 0.95 }),
  )
  // ShapeGeometry is drawn in XY; lay it down so shape-y becomes world z.
  mesh.rotation.x = Math.PI / 2
  mesh.position.y = 0.05
  mesh.receiveShadow = true
  return mesh
}

/* --- what grows where ------------------------------------------------ *
 * Per region kind: which species, in what proportion, and how much ground each
 * tree gets. Densities are metres squared per tree against the region's MEASURED
 * open green, so a bigger clearing fills itself in without anyone retuning a
 * count — and the giants are rationed by a flat maximum, because two titans in
 * one clearing is a landmark and nine is a wall.
 * ------------------------------------------------------------------- */
type Planting = {
  /** Square metres of open green per tree. */
  spacing: number
  /** Cumulative weights over species; the last one catches the remainder. */
  mix: Array<[TreeSpeciesId, number]>
  /** Hard cap per region on the two enormous species. */
  giants: number
  /** Square metres per grass tuft. */
  grass: number
  /** Square metres per boulder. */
  rock: number
  /** Nothing is planted within this radius of the region heart, for sightlines. */
  clearing: number
}

const planting: Record<WildRegion['kind'], Planting> = {
  wildwood: { spacing: 46, mix: [['pine', 0.5], ['birch', 0.66], ['oak', 0.84], ['titanpine', 0.95], ['elder', 1]], giants: 7, grass: 26, rock: 120, clearing: 13 },
  woods: { spacing: 52, mix: [['pine', 0.45], ['oak', 0.75], ['birch', 0.94], ['elder', 1]], giants: 2, grass: 30, rock: 150, clearing: 7 },
  brasswood: { spacing: 44, mix: [['ironbark', 0.72], ['titanpine', 0.86], ['pine', 0.96], ['scrub', 1]], giants: 9, grass: 34, rock: 70, clearing: 10 },
  grassland: { spacing: 210, mix: [['oak', 0.4], ['birch', 0.7], ['scrub', 1]], giants: 1, grass: 18, rock: 300, clearing: 0 },
  meadow: { spacing: 230, mix: [['oak', 0.35], ['scrub', 1]], giants: 1, grass: 20, rock: 320, clearing: 0 },
  fields: { spacing: 240, mix: [['birch', 0.5], ['scrub', 1]], giants: 0, grass: 22, rock: 400, clearing: 0 },
  outskirts: { spacing: 260, mix: [['scrub', 0.7], ['birch', 1]], giants: 1, grass: 24, rock: 260, clearing: 0 },
}

const GIANT_SPECIES = new Set<TreeSpeciesId>(['titanpine', 'elder'])

/** Height multiplier ranges, so one species still covers a range of ages. */
const sizeRange: Record<TreeSpeciesId, [number, number]> = {
  pine: [0.78, 1.26],
  titanpine: [0.9, 1.18],
  oak: [0.8, 1.2],
  elder: [0.92, 1.12],
  birch: [0.8, 1.25],
  ironbark: [0.84, 1.16],
  scrub: [0.7, 1.4],
}

export function createWildscape() {
  const root = new THREE.Group()
  root.name = 'wildscape'
  const rng = mulberry32(90210)
  const batch = createBatch()
  /* Everything here that is NOT batched and NOT instanced: the ground patches,
   * the water, the fire and the lettered sign boards. Each owns its own
   * geometry and material, so each has to be handed back by dispose(). */
  const loose: THREE.Mesh[] = []
  const placements = new Map<TreeSpeciesId, TreePlacement[]>()
  const obstacles: Array<{ kind: 'circle'; x: number; z: number; r: number }> = []
  const plant = (id: TreeSpeciesId, placement: TreePlacement) => {
    if (!placements.has(id)) placements.set(id, [])
    placements.get(id)!.push(placement)
    const metrics = treeMetrics(id)
    obstacles.push({ kind: 'circle', x: placement.x, z: placement.z, r: metrics.trunkRadius * placement.scale + 0.15 })
  }

  /* --- the shape of the open ground ---------------------------------- */
  const areas = new Map<string, number>()
  for (const region of wildRegions) {
    const patch = groundPatch(region)
    root.add(patch)
    loose.push(patch)
    areas.set(region.id, regionArea(region))
  }

  /* --- woods --------------------------------------------------------- */
  for (const region of wildRegions) {
    const rule = planting[region.kind]
    const area = areas.get(region.id) ?? 0
    const wanted = Math.round(area / rule.spacing)
    let giants = 0
    const planted: Array<{ x: number; z: number; r: number }> = []

    for (const spot of scatter(region, wanted, rng, 2.5)) {
      // Clearings stay open so the third-person camera has somewhere to sit and
      // the player can see what is coming.
      if (rule.clearing && Math.hypot(spot.x - region.x, spot.z - region.z) < rule.clearing) continue
      let id = rule.mix[rule.mix.length - 1][0]
      for (const [candidate, ceiling] of rule.mix) {
        if (spot.roll <= ceiling) { id = candidate; break }
      }
      if (GIANT_SPECIES.has(id)) {
        if (giants >= rule.giants) id = region.kind === 'brasswood' ? 'ironbark' : 'pine'
        else giants += 1
      }
      const [low, high] = sizeRange[id]
      const scale = low + rng() * (high - low)
      const metrics = treeMetrics(id)
      const radius = metrics.canopyRadius * scale
      // Crowns may interlock — that is what a wood looks like — but two trunks
      // in the same square metre reads as one broken tree.
      const clash = planted.some(other => Math.hypot(other.x - spot.x, other.z - spot.z) < Math.max(1.6, (other.r + radius) * 0.34))
      if (clash) continue
      plant(id, {
        x: spot.x,
        z: spot.z,
        scale,
        yaw: rng() * Math.PI * 2,
        lean: (rng() - 0.5) * (GIANT_SPECIES.has(id) ? 0.03 : 0.09),
        squash: 0.92 + rng() * 0.16,
        tint: 0.88 + rng() * 0.24,
      })
      planted.push({ x: spot.x, z: spot.z, r: radius })
    }

    /* --- undergrowth: grass tufts and ferns, cut into the same ground --- */
    for (const spot of scatter(region, Math.round(area / rule.grass), rng, 1)) {
      const dry = region.kind === 'brasswood' || region.kind === 'outskirts'
      const blades = 2 + Math.floor(spot.roll * 3)
      for (let i = 0; i < blades; i++) {
        const height = 0.25 + rng() * 0.5
        batch.box(
          [0.14, height, 0.14],
          [spot.x + (rng() - 0.5) * 0.9, height / 2, spot.z + (rng() - 0.5) * 0.9],
          rng() < 0.3 ? FERN : dry ? GRASS_DRY : GRASS,
          { rotY: rng() * Math.PI, rotZ: (rng() - 0.5) * 0.5 },
        )
      }
    }

    /* --- boulders ------------------------------------------------------ */
    for (const spot of scatter(region, Math.round(area / rule.rock), rng, 2)) {
      const size = 0.7 + spot.roll * 1.6
      // Three stacked slabs, shrinking: a voxel boulder rather than a polyhedron.
      batch.box([size, size * 0.5, size * 0.9], [spot.x, size * 0.22, spot.z], STONE, { rotY: spot.roll * 3 })
      batch.box([size * 0.72, size * 0.42, size * 0.66], [spot.x + 0.1, size * 0.62, spot.z - 0.08], STONE_DARK, { rotY: spot.roll * 5 })
      if (spot.roll > 0.55) batch.box([size * 0.5, size * 0.2, size * 0.46], [spot.x - 0.1, size * 0.9, spot.z + 0.1], MOSS, { rotY: spot.roll * 7 })
      obstacles.push({ kind: 'circle', x: spot.x, z: spot.z, r: size * 0.6 })
    }
  }

  /* --- the wildwood pond and standing stones ------------------------- */
  const pondX = huntingArea.x + 12
  const pondZ = huntingArea.z - 10
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(8.2, 22),
    new THREE.MeshStandardMaterial({ color: '#1d5560', emissive: '#10323a', emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.2 }),
  )
  pond.rotation.x = -Math.PI / 2
  pond.position.set(pondX, 0.09, pondZ)
  root.add(pond)
  loose.push(pond)
  for (let i = 0; i < 22; i++) {
    const angle = (i / 22) * Math.PI * 2
    const size = 0.5 + rng() * 0.6
    const x = pondX + Math.cos(angle) * 8.5
    const z = pondZ + Math.sin(angle) * 8.5
    batch.box([size, size * 0.5, size], [x, size * 0.2, z], i % 3 === 0 ? MOSS : STONE, { rotY: rng() * 3 })
  }
  // Reeds on the near bank, so the water has an edge rather than a rim.
  for (let i = 0; i < 40; i++) {
    const angle = rng() * Math.PI * 2
    const x = pondX + Math.cos(angle) * (8.4 + rng() * 1.6)
    const z = pondZ + Math.sin(angle) * (8.4 + rng() * 1.6)
    if (!isGreen(x, z, 1)) continue
    const height = 0.6 + rng() * 0.8
    batch.box([0.12, height, 0.12], [x, height / 2, z], GRASS_DRY, { rotZ: (rng() - 0.5) * 0.4 })
  }

  const standingStones: Array<{ x: number; z: number }> = []
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.4
    const x = huntingArea.x + Math.cos(angle) * 14
    const z = huntingArea.z + Math.sin(angle) * 14
    const height = 4.2 + rng() * 2.2
    const tilt = (rng() - 0.5) * 0.16
    // Built as three courses so the monolith reads as cut stone, not a box.
    batch.box([1.5, 0.5, 1.2], [x, 0.25, z], STONE_DARK)
    batch.box([1.1, height, 0.9], [x, height / 2 + 0.4, z], STONE, { rotZ: tilt, rotY: angle })
    batch.box([1.25, 0.5, 1.05], [x + Math.sin(tilt) * height, height + 0.6, z], STONE_DARK, { rotY: angle })
    standingStones.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 0.95 })
  }

  /* --- fallen logs in the clearing ----------------------------------- */
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2
    const radius = 10 + rng() * 16
    const x = huntingArea.x + Math.cos(angle) * radius
    const z = huntingArea.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2)) continue
    const length = 3 + rng() * 2.4
    const yaw = rng() * Math.PI
    batch.box([length, 0.68, 0.68], [x, 0.34, z], { color: '#4a3a2c', roughness: 0.95 }, { rotY: yaw })
    batch.box([0.3, 0.72, 0.72], [x + Math.cos(yaw) * length * 0.5, 0.36, z - Math.sin(yaw) * length * 0.5], TIMBER_DARK, { rotY: yaw })
  }

  /* --- the trails out of town ---------------------------------------- */
  const lanternAt: Array<[number, number]> = []
  const layTrail = (waypoints: Array<[number, number]>) => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [ax, az] = waypoints[i]
      const [bx, bz] = waypoints[i + 1]
      const length = Math.hypot(bx - ax, bz - az)
      const segments = Math.max(2, Math.round(length / 1.6))
      const yaw = Math.atan2(bx - ax, bz - az)
      for (let s = 0; s < segments; s++) {
        const t = s / segments
        const x = ax + (bx - ax) * t
        const z = az + (bz - az) * t
        // Two worn tones alternating: a trodden path, not a boardwalk.
        batch.box([3.1, 0.12, 1.6], [x, 0.07, z], s % 2 ? PLANK : PLANK_WORN, { rotY: yaw })
        if (s % 3 === 0) batch.box([0.5, 0.1, 0.5], [x + Math.cos(yaw) * 1.8, 0.1, z + Math.sin(yaw) * 1.8], STONE, { rotY: yaw })
      }
      lanternAt.push([bx + 1.9, bz + 1.1])
    }
  }
  layTrail(trailWaypoints)
  layTrail(brassTrailWaypoints)

  for (const [x, z] of lanternAt) {
    batch.box([0.18, 1.8, 0.18], [x, 0.9, z], TIMBER_DARK)
    batch.box([0.3, 0.1, 0.3], [x, 1.85, z], TIMBER)
    batch.box([0.42, 0.56, 0.42], [x, 1.62, z], LAMP)
  }

  /* --- hunter's camp at the edge of the wildwood --------------------- */
  const campX = huntingArea.x + 15
  const campZ = huntingArea.z + 18
  // A ridge tent: two sloped canvas walls on a pole, not a cone.
  batch.box([0.14, 2.4, 0.14], [campX - 2.2, 1.2, campZ], TIMBER_DARK)
  batch.box([0.14, 2.4, 0.14], [campX + 2.2, 1.2, campZ], TIMBER_DARK)
  batch.box([5.0, 0.16, 0.16], [campX, 2.4, campZ], TIMBER)
  for (const side of [-1, 1]) {
    batch.box([5.2, 0.16, 3.4], [campX, 1.3, campZ + side * 1.2], CANVAS, { rotX: side * 0.72 })
  }
  batch.box([5.2, 0.2, 0.2], [campX, 0.1, campZ + 2.3], TIMBER_DARK)
  batch.box([5.2, 0.2, 0.2], [campX, 0.1, campZ - 2.3], TIMBER_DARK)
  obstacles.push({ kind: 'circle', x: campX, z: campZ, r: 2.6 })

  // Drying rack with pelts, and a crate: signs somebody hunts here.
  batch.box([0.16, 1.7, 0.16], [campX - 4.4, 0.85, campZ + 1.4], TIMBER_DARK)
  batch.box([0.16, 1.7, 0.16], [campX - 1.4, 0.85, campZ + 1.4], TIMBER_DARK)
  batch.box([3.2, 0.14, 0.14], [campX - 2.9, 1.65, campZ + 1.4], TIMBER)
  for (let i = 0; i < 3; i++) {
    batch.box([0.7, 0.9, 0.08], [campX - 4.0 + i * 1.1, 1.15, campZ + 1.4], { color: '#7a5a38', roughness: 0.9 })
  }
  batch.box([1.1, 0.9, 0.9], [campX + 3.4, 0.45, campZ + 2.6], { color: '#70543c', roughness: 0.9 }, { rotY: 0.3 })

  // The fire keeps its own mesh, because it pulses: a batched box cannot be
  // scaled on its own. One point light out here, and this is it.
  const fireX = campX + 3.4
  const fireZ = campZ - 1.2
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2
    batch.box([0.44, 0.3, 0.4], [fireX + Math.cos(angle) * 1.15, 0.15, fireZ + Math.sin(angle) * 1.15], STONE_DARK, { rotY: angle })
  }
  for (let i = 0; i < 4; i++) {
    batch.box([1.5, 0.22, 0.22], [fireX, 0.2 + i * 0.12, fireZ], TIMBER_DARK, { rotY: (i / 4) * Math.PI })
  }
  const fire = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.9, 0.7),
    new THREE.MeshStandardMaterial({ color: '#e35e35', emissive: '#e35e35', emissiveIntensity: 2.8, roughness: 0.3 }),
  )
  fire.position.set(fireX, 0.6, fireZ)
  root.add(fire)
  loose.push(fire)
  const fireLight = new THREE.PointLight('#e8863c', 3.2, 18)
  fireLight.position.set(fireX, 1.4, fireZ)
  root.add(fireLight)

  /* --- the brasswood: dry hollow, timber cribs, brass lamps ---------- */
  const brass = highHuntArea
  const hollow = new THREE.Mesh(
    new THREE.CircleGeometry(6.0, 18),
    new THREE.MeshStandardMaterial({ color: '#1a1814', roughness: 0.98 }),
  )
  hollow.rotation.x = -Math.PI / 2
  hollow.position.set(brass.x - 3, 0.08, brass.z + 2)
  root.add(hollow)
  loose.push(hollow)

  const brassStumps: Array<{ x: number; z: number }> = []
  for (let i = 0; i < 11; i++) {
    const angle = (i / 11) * Math.PI * 2 + 0.3
    const radius = 8 + (i % 4) * 1.6
    const x = brass.x + Math.cos(angle) * radius
    const z = brass.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2) || !insideRegion(brass, x, z, ROAM_INSET)) continue
    batch.box([1.5, 0.7, 1.5], [x, 0.35, z], { color: '#2c241c', roughness: 0.95 }, { rotY: rng() * 3 })
    batch.box([1.2, 0.16, 1.2], [x, 0.76, z], { color: '#4a3a2c', roughness: 0.9 }, { rotY: rng() * 3 })
    brassStumps.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 0.8 })
  }

  const cribs: Array<{ x: number; z: number }> = []
  for (const [dx, dz] of [[7.5, -5.5], [-8.2, -4.0], [4.0, 9.0]] as Array<[number, number]>) {
    const x = brass.x + dx
    const z = brass.z + dz
    if (!isGreen(x, z, 2) || !insideRegion(brass, x, z, ROAM_INSET)) continue
    const yaw = rng() * 0.8
    for (let layer = 0; layer < 4; layer++) {
      for (let log = -1; log <= 1; log++) {
        batch.box(
          [3.4, 0.5, 0.5],
          [x + (layer % 2 ? 0 : log * 0.6), 0.3 + layer * 0.5, z + (layer % 2 ? log * 0.6 : 0)],
          log === 0 ? { color: '#4a3a2c', roughness: 0.95 } : TIMBER_DARK,
          { rotY: yaw + (layer % 2 ? Math.PI / 2 : 0) },
        )
      }
    }
    cribs.push({ x, z })
    obstacles.push({ kind: 'circle', x, z, r: 1.8 })
  }

  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 + 0.2
    const x = brass.x + Math.cos(angle) * 13.5
    const z = brass.z + Math.sin(angle) * 13.5
    if (!isGreen(x, z, 1.5) || !insideRegion(brass, x, z, 1)) continue
    batch.box([0.2, 2.6, 0.2], [x, 1.3, z], { color: '#3a2d1e', roughness: 0.9 })
    batch.box([0.34, 0.16, 0.34], [x, 2.68, z], TIMBER_DARK)
    batch.box([0.42, 0.5, 0.42], [x, 2.4, z], BRASS_LAMP)
  }
  const brassLight = new THREE.PointLight('#c4893a', 2.4, 22)
  brassLight.position.set(brass.x - 3, 3.2, brass.z + 2)
  root.add(brassLight)

  /* --- signposts ------------------------------------------------------ */
  const signMeshes: THREE.Mesh[] = []
  const signpost = (x: number, z: number, faceYaw: number, lines: string[], accent: string) => {
    const cos = Math.cos(faceYaw)
    const sin = Math.sin(faceYaw)
    const local = (lx: number, ly: number, lz: number): [number, number, number] => [
      x + lx * cos + lz * sin,
      ly,
      z - lx * sin + lz * cos,
    ]
    for (const px of [-1.12, 1.12]) {
      batch.box([0.24, 3.2, 0.24], local(px, 1.6, -0.18), TIMBER, { rotY: faceYaw })
    }
    batch.box([2.7, 1.16, 0.12], local(0, 2.6, -0.1), TIMBER_DARK, { rotY: faceYaw })
    batch.box([0.8, 0.1, 0.1], local(1.5, 3.3, 0), TIMBER, { rotY: faceYaw })
    batch.box([0.3, 0.42, 0.3], local(1.86, 2.95, 0), LAMP, { rotY: faceYaw })
    // The lettering is a canvas board, which is the one thing here that cannot
    // be a cube: it is text, and it has to stay readable at a distance.
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.04, 0.1), woodSign(lines, accent))
    const [bx, by, bz] = local(0, 2.6, 0.02)
    board.position.set(bx, by, bz)
    board.rotation.y = faceYaw
    board.castShadow = true
    root.add(board)
    signMeshes.push(board)
    loose.push(board)
    obstacles.push({ kind: 'circle', x, z, r: 0.7 })
  }

  const trailYaw = Math.atan2(trailWaypoints[0][0] - 0, trailWaypoints[0][1] - 8)
  signpost(trailWaypoints[0][0], trailWaypoints[0][1], trailYaw + Math.PI, ['HUNTING', 'THIS WAY →'], '#d5a64b')
  signpost(trailWaypoints[2][0] + 2.4, trailWaypoints[2][1] + 2.4, trailYaw + Math.PI, ['WILDWOOD', '40 PACES'], '#9ca66d')
  const brassYaw = Math.atan2(brassTrailWaypoints[0][0] - 0, brassTrailWaypoints[0][1] - 8)
  signpost(brassTrailWaypoints[0][0], brassTrailWaypoints[0][1], brassYaw + Math.PI, ['BRASSWOOD', 'HIGH GAME →'], '#c4893a')
  signpost(brassTrailWaypoints[3][0] + 2.2, brassTrailWaypoints[3][1] + 1.6, brassYaw + Math.PI, ['BRASSWOOD', 'KEEP EAST'], '#c4893a')
  signpost(
    campX - 4.0,
    campZ + 3.8,
    Math.atan2(campX - huntingArea.x, campZ - huntingArea.z),
    ['THE WILDWOOD', 'BEARS · KEEP CLEAR'],
    '#e35e35',
  )
  signpost(huntingArea.x + 3, huntingArea.z + 17.5, 0, ['THE CLEARING', 'OPEN GROUND'], '#9ca66d')
  signpost(brass.x - 2.2, brass.z + 15.5, Math.PI, ['THE BRASSWOOD', 'WOLVES · BOARS'], '#c4893a')
  signpost(brass.x + 6.0, brass.z + 8.5, -0.4, ['DRY HOLLOW', 'HIGH GAME'], '#d5a64b')

  /* --- everything above becomes about a dozen meshes ------------------ */
  const welded = batch.build(root)
  const trees = createTreeField(placements)
  root.add(trees.group)

  root.userData.flicker = {
    fire,
    fireLight,
    lampMaterials: welded.meshes
      .map(mesh => mesh.material as THREE.MeshStandardMaterial)
      .filter(material => material.emissiveIntensity > 1),
  }

  /**
   * What the navigation grid in src/battle/nav.ts should treat as solid out
   * here. Published rather than re-derived: the scatter above consumes one
   * shared RNG in sequence, so any second pass would produce a different wood.
   * Only trunks, boulders, monoliths and stacked timber block — grass, trail
   * planks and the pond surface stay walkable on purpose.
   */
  root.userData.obstacles = obstacles
  root.userData.stats = {
    propMeshes: welded.meshes.length,
    propBoxes: welded.boxes,
    propTriangles: welded.triangles,
    signBoards: signMeshes.length,
    groundPatches: wildRegions.length,
    pointLights: 2,
    trees: trees.stats,
    regionArea: [...areas.entries()].map(([id, area]) => ({ id, area })),
  }
  /**
   * Hand back everything this function allocated: the instanced forest, the
   * welded props, and the handful of meshes that own their own geometry. Used
   * to free only the trees, which left the props, the seven ground patches, the
   * water and eight canvas-textured sign boards resident.
   */
  root.userData.dispose = () => {
    trees.dispose()
    welded.dispose()
    for (const mesh of loose) {
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        disposeMaterial(material)
      }
    }
  }
  return root
}

function woodSign(lines: string[], accent: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#26190f'
  ctx.fillRect(0, 0, 320, 128)
  ctx.fillStyle = '#3c2a19'
  ctx.fillRect(6, 6, 308, 116)
  ctx.strokeStyle = accent
  ctx.lineWidth = 4
  ctx.strokeRect(12, 12, 296, 104)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((line, index) => {
    const centre = 64 + (index - (lines.length - 1) / 2) * 34
    ctx.font = index === 0 ? '700 30px monospace' : '500 21px monospace'
    ctx.fillStyle = index === 0 ? '#f0dcb0' : accent
    ctx.fillText(line, 160, centre)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.75, emissive: '#2a1d10', emissiveIntensity: 0.55 })
}

/** Cheap life for the camp fire and the lamps. */
export function animateWildscape(wildscape: THREE.Object3D, time: number) {
  const flicker = wildscape.userData.flicker as
    | { fire: THREE.Mesh; fireLight: THREE.PointLight; lampMaterials: THREE.MeshStandardMaterial[] }
    | undefined
  if (!flicker) return
  const pulse = 0.82 + Math.sin(time * 0.009) * 0.1 + Math.sin(time * 0.021) * 0.06
  flicker.fire.scale.set(pulse, 0.9 + pulse * 0.24, pulse)
  flicker.fireLight.intensity = 2.6 + pulse * 0.9
  // Every lamp shares one material per tone now, so they breathe together
  // rather than each carrying its own phase. Nobody can see the difference,
  // and it costs one assignment instead of twenty.
  const lampPulse = 2.0 + Math.sin(time * 0.004) * 0.35
  flicker.lampMaterials.forEach(material => { material.emissiveIntensity = lampPulse })
}
