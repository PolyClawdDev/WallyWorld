import * as THREE from 'three'

/**
 * The pouch lives in the DOM, the townspeople live in the Three.js scene, so a
 * drop has to be resolved by raycasting screen coordinates into the live world.
 * WorldCanvas registers its camera/canvas here and nothing else is shared: the
 * bridge holds no React state and never mutates the scene.
 */
type WorldHandle = { scene: THREE.Scene; camera: THREE.Camera; canvas: HTMLCanvasElement; player: THREE.Object3D }

let handle: WorldHandle | null = null
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

export function registerWorld(next: WorldHandle) {
  handle = next
  // Mirrors the __wally probe in main.tsx so drop resolution can be exercised
  // from a verification script without going through the pointer pipeline.
  if (import.meta.env.DEV) (window as unknown as { __wallyBridge?: unknown }).__wallyBridge = { npcAtScreen, playerPose, handle: () => handle }
  return () => { if (handle === next) handle = null }
}

export function isWorldReady() {
  return handle !== null
}

export type PlayerPose = { x: number; z: number; facing: number }

/** Live player position and heading, in world metres and radians. */
export function playerPose(): PlayerPose | null {
  if (!handle) return null
  const { player } = handle
  return { x: player.position.x, z: player.position.z, facing: player.rotation.y }
}

/** Name of the interactive NPC under the given client coordinates, if any. */
export function npcAtScreen(clientX: number, clientY: number): string | null {
  if (!handle) return null
  const rect = handle.canvas.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, handle.camera)
  // Only the named NPC groups are candidates, so the town geometry never has to
  // be walked and a hit on a name label still counts as a hit on its owner.
  const candidates = handle.scene.children.filter(child => typeof child.userData.npc === 'string' && child.userData.npc)
  for (const hit of raycaster.intersectObjects(candidates, true)) {
    let node: THREE.Object3D | null = hit.object
    while (node) {
      const name = node.userData.npc
      if (typeof name === 'string' && name) return name
      node = node.parent
    }
  }
  return null
}
