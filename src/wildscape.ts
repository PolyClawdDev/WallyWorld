import * as THREE from 'three'
import { huntingArea, isGreen, trailWaypoints, wildRegions } from './wildlife'
import type { WildRegion } from './wildlife'

/* ------------------------------------------------------------------ *
 * The green. Everything the player needs in order to find the hunt:
 * tinted ground patches, dense pine, rocks, ferns, a pond, a hunter's
 * camp, and a lit dirt trail out of the plaza with signposts on it.
 *
 * Props are instanced, so several hundred trees and ferns cost about
 * ten draw calls.
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

type Placement = { x: number; z: number; scale: number; rotation: number }

function scatter(region: WildRegion, count: number, rng: () => number, margin: number): Placement[] {
  const out: Placement[] = []
  for (let i = 0; i < count * 5 && out.length < count; i++) {
    const angle = rng() * Math.PI * 2
    const radius = Math.sqrt(rng()) * region.radius
    const x = region.x + Math.cos(angle) * radius
    const z = region.z + Math.sin(angle) * radius
    if (!isGreen(x, z, margin)) continue
    // Keep the trail walkable rather than growing a pine in the middle of it.
    if (trailWaypoints.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 4)) continue
    out.push({ x, z, scale: 0.75 + rng() * 0.6, rotation: rng() * Math.PI * 2 })
  }
  return out
}

function instanced(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  placements: Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }>,
) {
  if (!placements.length) return null
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length)
  const matrix = new THREE.Matrix4()
  const quaternion = new THREE.Quaternion()
  const axis = new THREE.Vector3(0, 1, 0)
  placements.forEach((placement, index) => {
    quaternion.setFromAxisAngle(axis, placement.rotationY)
    matrix.compose(placement.position, quaternion, placement.scale)
    mesh.setMatrixAt(index, matrix)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  root.add(mesh)
  return mesh
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

/** A signpost that always reads from the direction the player approaches. */
function signpost(root: THREE.Group, x: number, z: number, faceYaw: number, lines: string[], accent: string) {
  const group = new THREE.Group()
  group.position.set(x, 0, z)
  group.rotation.y = faceYaw

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 3.1, 0.22),
    new THREE.MeshStandardMaterial({ color: '#59422c', roughness: 0.9 }),
  )
  post.position.y = 1.55
  post.castShadow = true
  group.add(post)

  const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.04, 0.14), woodSign(lines, accent))
  board.position.y = 2.6
  board.castShadow = true
  group.add(board)

  // Behind the board, so the lettering faces the group's local +z.
  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(2.66, 1.1, 0.1),
    new THREE.MeshStandardMaterial({ color: '#2d1f13', roughness: 0.9 }),
  )
  backing.position.set(0, 2.6, -0.11)
  group.add(backing)

  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.5, 0.34),
    new THREE.MeshStandardMaterial({ color: '#f0b84d', emissive: '#f0b84d', emissiveIntensity: 2.6, roughness: 0.2 }),
  )
  lamp.position.set(0, 3.35, 0)
  group.add(lamp)
  group.add(new THREE.PointLight('#f0b84d', 2.2, 11))
  root.add(group)
  return group
}

export function createWildscape() {
  const root = new THREE.Group()
  root.name = 'wildscape'
  const rng = mulberry32(90210)

  /* --- green ground patches, so "the green" is visible from a distance --- */
  const patchGeometry = new THREE.CircleGeometry(1, 28)
  for (const region of wildRegions) {
    const patch = new THREE.Mesh(
      patchGeometry,
      new THREE.MeshStandardMaterial({ color: region.color, roughness: 0.95 }),
    )
    patch.rotation.x = -Math.PI / 2
    patch.position.set(region.x, 0.05, region.z)
    patch.scale.setScalar(region.radius)
    patch.receiveShadow = true
    root.add(patch)
  }

  /* --- pine, rocks and ferns ------------------------------------------- */
  const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6)
  trunkGeometry.translate(0, 1.6, 0)
  const crownGeometry = new THREE.ConeGeometry(1.7, 4.8, 7)
  crownGeometry.translate(0, 4.2, 0)
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0)
  const fernGeometry = new THREE.ConeGeometry(0.42, 0.72, 5)
  fernGeometry.translate(0, 0.36, 0)
  const logGeometry = new THREE.CylinderGeometry(0.3, 0.34, 3.4, 6)

  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#3f3128', roughness: 0.92 })
  const crownMaterials = [
    new THREE.MeshStandardMaterial({ color: '#26402f', roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: '#2f4d36', roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: '#1d3527', roughness: 0.9 }),
  ]
  const rockMaterial = new THREE.MeshStandardMaterial({ color: '#5a6167', roughness: 0.95 })
  const fernMaterial = new THREE.MeshStandardMaterial({ color: '#436143', roughness: 0.95 })

  const trunks: Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }> = []
  const crowns: Array<Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }>> = [[], [], []]
  const rocks: Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }> = []
  const ferns: Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }> = []

  for (const region of wildRegions) {
    const dense = region.kind === 'wildwood' || region.kind === 'woods'
    // Dense enough to read as woodland, open enough that game stays visible.
    const treeCount = dense ? Math.round(region.radius * 2.0) : Math.round(region.radius * 0.5)
    const fernCount = Math.round(region.radius * (dense ? 3.4 : 2.0))
    const rockCount = dense ? Math.round(region.radius * 0.5) : Math.round(region.radius * 0.2)

    for (const tree of scatter(region, treeCount, rng, 3)) {
      // The clearing stays open: wide enough that the third-person camera has
      // somewhere to sit during a fight instead of clipping into a pine.
      if (region.kind === 'wildwood' && Math.hypot(tree.x - region.x, tree.z - region.z) < 15) continue
      const position = new THREE.Vector3(tree.x, 0, tree.z)
      const scale = new THREE.Vector3(tree.scale, tree.scale * (0.85 + rng() * 0.5), tree.scale)
      trunks.push({ position, scale, rotationY: tree.rotation })
      crowns[Math.floor(rng() * 3)].push({ position: position.clone(), scale, rotationY: tree.rotation })
    }
    for (const fern of scatter(region, fernCount, rng, 1)) {
      ferns.push({
        position: new THREE.Vector3(fern.x, 0, fern.z),
        scale: new THREE.Vector3(fern.scale, fern.scale * (0.7 + rng() * 0.9), fern.scale),
        rotationY: fern.rotation,
      })
    }
    for (const rock of scatter(region, rockCount, rng, 2)) {
      const size = 0.5 + rng() * 1.3
      rocks.push({
        position: new THREE.Vector3(rock.x, size * 0.35, rock.z),
        scale: new THREE.Vector3(size, size * 0.72, size),
        rotationY: rock.rotation,
      })
    }
  }

  instanced(root, trunkGeometry, trunkMaterial, trunks)
  crownMaterials.forEach((material, index) => instanced(root, crownGeometry, material, crowns[index]))
  instanced(root, rockGeometry, rockMaterial, rocks)
  instanced(root, fernGeometry, fernMaterial, ferns)

  /* --- the wildwood pond and standing stones --------------------------- */
  const pondX = huntingArea.x + 11
  const pondZ = huntingArea.z - 9
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(7.4, 24),
    new THREE.MeshStandardMaterial({ color: '#1d5560', emissive: '#10323a', emissiveIntensity: 0.7, roughness: 0.15, metalness: 0.2 }),
  )
  pond.rotation.x = -Math.PI / 2
  pond.position.set(pondX, 0.09, pondZ)
  root.add(pond)
  const bankStones: Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotationY: number }> = []
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2
    const size = 0.5 + rng() * 0.5
    bankStones.push({
      position: new THREE.Vector3(pondX + Math.cos(angle) * 7.7, size * 0.3, pondZ + Math.sin(angle) * 7.7),
      scale: new THREE.Vector3(size, size * 0.6, size),
      rotationY: rng() * Math.PI,
    })
  }
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.4
    const stone = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 3.6 + rng() * 1.6, 0.7),
      new THREE.MeshStandardMaterial({ color: '#59605f', roughness: 0.95 }),
    )
    stone.position.set(huntingArea.x + Math.cos(angle) * 13, 1.9, huntingArea.z + Math.sin(angle) * 13)
    stone.rotation.z = (rng() - 0.5) * 0.14
    stone.castShadow = true
    root.add(stone)
  }
  instanced(root, rockGeometry, rockMaterial, bankStones)

  /* --- fallen logs in the clearing -------------------------------------- */
  const logMaterial = new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 0.95 })
  for (let i = 0; i < 4; i++) {
    const angle = rng() * Math.PI * 2
    const radius = 10 + rng() * 12
    const x = huntingArea.x + Math.cos(angle) * radius
    const z = huntingArea.z + Math.sin(angle) * radius
    if (!isGreen(x, z, 2)) continue
    const log = new THREE.Mesh(logGeometry, logMaterial)
    log.position.set(x, 0.32, z)
    log.rotation.set(Math.PI / 2, rng() * Math.PI, 0)
    log.castShadow = true
    root.add(log)
  }

  /* --- the trail out of town ------------------------------------------- */
  const trailMaterial = new THREE.MeshStandardMaterial({ color: '#6b5a44', roughness: 0.95 })
  const lanternPosts: THREE.Mesh[] = []
  for (let i = 0; i < trailWaypoints.length - 1; i++) {
    const [ax, az] = trailWaypoints[i]
    const [bx, bz] = trailWaypoints[i + 1]
    const length = Math.hypot(bx - ax, bz - az)
    const segments = Math.max(2, Math.round(length / 1.6))
    for (let s = 0; s < segments; s++) {
      const t = s / segments
      const x = ax + (bx - ax) * t
      const z = az + (bz - az) * t
      const plank = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.12, 1.5), trailMaterial)
      plank.position.set(x, 0.07, z)
      plank.rotation.y = Math.atan2(bx - ax, bz - az)
      plank.receiveShadow = true
      root.add(plank)
    }
    // A waist-high lantern every waypoint: the trail stays readable at night.
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.55, 0.4),
      new THREE.MeshStandardMaterial({ color: '#f0b84d', emissive: '#f0b84d', emissiveIntensity: 2.4, roughness: 0.2 }),
    )
    lantern.position.set(bx + 1.9, 1.7, bz + 1.1)
    root.add(lantern)
    lanternPosts.push(lantern)
    const pole = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 1.7, 0.16),
      new THREE.MeshStandardMaterial({ color: '#4c3b2d', roughness: 0.9 }),
    )
    pole.position.set(bx + 1.9, 0.85, bz + 1.1)
    root.add(pole)
    if (i % 2 === 0) root.add(new THREE.PointLight('#f0b84d', 1.6, 9))
  }

  const trailYaw = Math.atan2(trailWaypoints[0][0] - 0, trailWaypoints[0][1] - 8)
  signpost(root, trailWaypoints[0][0], trailWaypoints[0][1], trailYaw + Math.PI, ['HUNTING', 'THIS WAY →'], '#d5a64b')
  signpost(root, trailWaypoints[2][0] + 2.4, trailWaypoints[2][1] + 2.4, trailYaw + Math.PI, ['WILDWOOD', '40 PACES'], '#9ca66d')

  /* --- hunter's camp at the edge of the wildwood ------------------------ */
  const camp = new THREE.Group()
  const campX = huntingArea.x + 13
  const campZ = huntingArea.z + 16
  camp.position.set(campX, 0, campZ)
  const tent = new THREE.Mesh(
    new THREE.ConeGeometry(2.3, 2.6, 4),
    new THREE.MeshStandardMaterial({ color: '#6d5a42', roughness: 0.92 }),
  )
  tent.position.y = 1.3
  tent.rotation.y = Math.PI / 4
  tent.castShadow = true
  camp.add(tent)
  const fire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({ color: '#e35e35', emissive: '#e35e35', emissiveIntensity: 2.8, roughness: 0.3 }),
  )
  fire.position.set(3.2, 0.5, 1.2)
  camp.add(fire)
  const fireLight = new THREE.PointLight('#e8863c', 3.2, 16)
  fireLight.position.set(3.2, 1.1, 1.2)
  camp.add(fireLight)
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2
    const stone = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.28, 0),
      new THREE.MeshStandardMaterial({ color: '#555c5f', roughness: 0.95 }),
    )
    stone.position.set(3.2 + Math.cos(angle) * 1.05, 0.16, 1.2 + Math.sin(angle) * 1.05)
    camp.add(stone)
  }
  const rack = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.14, 0.14),
    new THREE.MeshStandardMaterial({ color: '#4c3b2d', roughness: 0.9 }),
  )
  rack.position.set(-2.6, 1.5, 1.4)
  camp.add(rack)
  root.add(camp)

  signpost(
    root,
    campX - 3.4,
    campZ + 3.4,
    Math.atan2(campX - huntingArea.x, campZ - huntingArea.z),
    ['THE WILDWOOD', 'BEARS · KEEP CLEAR'],
    '#e35e35',
  )
  // At the tree line, not in the middle of the clearing it names.
  signpost(root, huntingArea.x + 3, huntingArea.z + 16.5, 0, ['CLEARING', 'GAME GATHERS HERE'], '#9ca66d')

  const flicker = { fire, fireLight, lanternPosts }
  root.userData.flicker = flicker
  return root
}

/** Cheap life for the camp fire and trail lanterns. */
export function animateWildscape(wildscape: THREE.Object3D, time: number) {
  const flicker = wildscape.userData.flicker as
    | { fire: THREE.Mesh; fireLight: THREE.PointLight; lanternPosts: THREE.Mesh[] }
    | undefined
  if (!flicker) return
  const pulse = 0.82 + Math.sin(time * 0.009) * 0.1 + Math.sin(time * 0.021) * 0.06
  flicker.fire.scale.setScalar(pulse)
  flicker.fireLight.intensity = 2.6 + pulse * 0.9
  flicker.lanternPosts.forEach((lantern, index) => {
    const material = lantern.material as THREE.MeshStandardMaterial
    material.emissiveIntensity = 2.1 + Math.sin(time * 0.004 + index) * 0.4
  })
}
