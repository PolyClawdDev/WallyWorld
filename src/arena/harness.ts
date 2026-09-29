import * as THREE from 'three'
import { animateCharacter, createWizard, type WizardId } from '../characters'
import { createArena, type Arena } from './index'

/* ------------------------------------------------------------------ *
 * The arena, standing on its own.
 *
 * Served at /arena.html. No wallet, no server, no town, no duel flow —
 * the point of this harness is that the arena can be looked at, measured
 * and screenshotted before any of that exists, and that whatever is on
 * screen is the arena and nothing else.
 *
 * Everything it does is driven from `window.__arena`, so the screenshot
 * script can place the camera, park characters on the spawns and read
 * the renderer's own counters back out rather than being told them.
 * ------------------------------------------------------------------ */

type Actor = { root: THREE.Object3D; id: WizardId }

export type ArenaHarness = {
  arena: Arena
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  /** Point the camera at something. Angles in metres, world space. */
  look: (from: [number, number, number], at: [number, number, number], fov?: number) => void
  /** Stand a character somewhere. `who` is 0 or 1; null clears it. */
  place: (who: number, id: WizardId | null, at?: [number, number], facing?: number) => void
  /** Put both duellists on their spawn marks, facing each other. */
  atSpawns: (a?: WizardId, b?: WizardId) => void
  /** Walk a body into the boundary and report where the arena stopped it. */
  pushInto: (angle: number, metres: number) => { x: number; z: number; radius: number; contained: boolean }
  /** Renderer counters for the frame just drawn, plus a measured frame rate. */
  measure: (ms?: number) => Promise<{ calls: number; triangles: number; fps: number; frames: number }>
  /** Build, tear down and rebuild, reporting what was freed. Proves it in situ. */
  recycle: (times: number) => { cycles: number; geometries: number; materials: number; textures: number }
  dispose: () => void
}

declare global {
  interface Window {
    __arena?: ArenaHarness
  }
}

export function mountHarness(mount: HTMLElement): ArenaHarness {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  mount.appendChild(renderer.domElement)

  let arena = createArena()
  arena.attach(scene)

  const actors: Array<Actor | null> = [null, null]

  /** Characters are borrowed art, so the harness frees them the same way. */
  const dropActor = (index: number) => {
    const actor = actors[index]
    if (!actor) return
    actor.root.removeFromParent()
    actor.root.traverse(node => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          const texture = value as THREE.Texture | null
          if (texture && texture.isTexture) texture.dispose()
        }
        material.dispose()
      }
    })
    actors[index] = null
  }

  const place: ArenaHarness['place'] = (who, id, at, facing) => {
    dropActor(who)
    if (!id) return
    const root = createWizard(id)
    root.traverse(node => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
    const spawn = arena.spawns[who] ?? arena.spawns[0]
    const [x, z] = at ?? [spawn.position.x, spawn.position.z]
    root.position.set(x, arena.floorY, z)
    root.rotation.y = facing ?? Math.atan2(-x, -z)
    scene.add(root)
    actors[who] = { root, id }
  }

  const atSpawns: ArenaHarness['atSpawns'] = (a = 'MOTH', b = 'CINDER') => {
    const ids: WizardId[] = [a, b]
    for (const [index, spawn] of arena.spawns.entries()) {
      place(index, ids[index], [spawn.position.x, spawn.position.z], spawn.facing)
    }
  }

  const look: ArenaHarness['look'] = (from, at, fov) => {
    camera.position.set(...from)
    camera.lookAt(new THREE.Vector3(...at))
    if (fov) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  const pushInto: ArenaHarness['pushInto'] = (angle, metres) => {
    const p = new THREE.Vector3(0, arena.floorY, 0)
    arena.slide(p, Math.cos(angle) * metres, Math.sin(angle) * metres)
    return { x: p.x, z: p.z, radius: Math.hypot(p.x, p.z), contained: arena.contains(p) }
  }

  /* ---------------------------------------------------------- the loop */
  let running = true
  let frames = 0
  const resize = () => {
    const w = mount.clientWidth || window.innerWidth
    const h = mount.clientHeight || window.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  const tick = (now: number) => {
    if (!running) return
    requestAnimationFrame(tick)
    arena.update(now)
    for (const actor of actors) if (actor) animateCharacter(actor.root, now)
    renderer.render(scene, camera)
    frames++
  }
  requestAnimationFrame(tick)

  const measure: ArenaHarness['measure'] = async (ms = 2000) => {
    const start = frames
    const t0 = performance.now()
    await new Promise(resolve => setTimeout(resolve, ms))
    const drawn = frames - start
    const elapsed = performance.now() - t0
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: (drawn / elapsed) * 1000,
      frames: drawn,
    }
  }

  /**
   * The leak test, run against the live renderer rather than in Node.
   *
   * Same census as scripts/verify-arena.ts: patch the two methods every
   * geometry and material constructor goes through, then count the
   * dispose events that come back.
   */
  const recycle: ArenaHarness['recycle'] = times => {
    const realSetAttribute = THREE.BufferGeometry.prototype.setAttribute
    const realSetValues = THREE.Material.prototype.setValues
    let allocated = 0
    let materialsAllocated = 0
    let texturesAllocated = 0
    let freedGeometries = 0
    let freedMaterials = 0
    let freedTextures = 0
    const seenGeometries = new Set<THREE.BufferGeometry>()
    const seenMaterials = new Set<THREE.Material>()

    THREE.BufferGeometry.prototype.setAttribute = function (this: THREE.BufferGeometry, ...args) {
      if (!seenGeometries.has(this)) {
        seenGeometries.add(this)
        allocated++
        const self = this
        self.addEventListener('dispose', function once() {
          self.removeEventListener('dispose', once)
          freedGeometries++
        })
      }
      return realSetAttribute.apply(this, args as Parameters<typeof realSetAttribute>)
    }
    THREE.Material.prototype.setValues = function (this: THREE.Material, ...args) {
      if (!seenMaterials.has(this)) {
        seenMaterials.add(this)
        materialsAllocated++
        const self = this
        self.addEventListener('dispose', function once() {
          self.removeEventListener('dispose', once)
          freedMaterials++
        })
      }
      return realSetValues.apply(this, args as Parameters<typeof realSetValues>)
    }

    for (let i = 0; i < times; i++) {
      arena.dispose()
      arena = createArena()
      arena.attach(scene)
      renderer.render(scene, camera)
    }

    THREE.BufferGeometry.prototype.setAttribute = realSetAttribute
    THREE.Material.prototype.setValues = realSetValues
    for (const material of seenMaterials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | null
        if (texture && texture.isTexture) {
          texturesAllocated++
          texture.addEventListener('dispose', () => { freedTextures++ })
        }
      }
    }

    return {
      cycles: times,
      // The arena still standing at the end was allocated but not yet freed,
      // so one build's worth is subtracted before the comparison.
      geometries: allocated - freedGeometries - arena.stats.geometries,
      materials: materialsAllocated - freedMaterials - arena.stats.materials,
      textures: texturesAllocated - freedTextures,
    }
  }

  const dispose = () => {
    running = false
    window.removeEventListener('resize', resize)
    dropActor(0)
    dropActor(1)
    arena.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }

  const harness: ArenaHarness = {
    get arena() {
      return arena
    },
    scene,
    camera,
    renderer,
    look,
    place,
    atSpawns,
    pushInto,
    measure,
    recycle,
    dispose,
  } as ArenaHarness

  return harness
}

const mount = document.getElementById('arena')
if (mount) {
  const harness = mountHarness(mount)
  // Default framing: the wide establishing shot.
  harness.look([0, 30, 52], [0, 0, 0], 46)
  window.__arena = harness
}
