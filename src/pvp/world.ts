import * as THREE from 'three'
import { animateCharacter, createWizard } from '../characters'
import { send } from './net'
import { pingPvp, pvpState } from './store'
import { DUEL_RINGS } from '../shared/zones'
import type { PublicPresence } from '../shared/pvp'

type Remote = {
  id: string
  group: THREE.Group
  label: THREE.Sprite
  target: THREE.Vector3
  facing: number
}

const remotes = new Map<string, Remote>()
let rings: THREE.Group | null = null
let lastPose = 0

function nameplate(text: string, color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#101923e8'
  ctx.fillRect(4, 4, 248, 56)
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.strokeRect(5, 5, 246, 54)
  ctx.font = '700 18px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#e5ddc8'
  ctx.fillText(text.slice(0, 18), 128, 32)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }))
  sprite.scale.set(3.2, 0.8, 1)
  sprite.userData.ignorePick = true
  return sprite
}

function syncRemote(scene: THREE.Scene, presence: PublicPresence) {
  let remote = remotes.get(presence.playerId)
  if (!remote) {
    const wizard = createWizard(presence.loadout.character, 1, presence.loadout.style)
    const label = nameplate(presence.displayName, '#d5a64b')
    label.position.set(0, 3.2, 0)
    wizard.add(label)
    wizard.userData.pvpId = presence.playerId
    scene.add(wizard)
    remote = { id: presence.playerId, group: wizard, label, target: new THREE.Vector3(presence.x, 0, presence.z), facing: presence.facing }
    remotes.set(presence.playerId, remote)
  }
  remote.target.set(presence.x, 0, presence.z)
  remote.facing = presence.facing
  const map = remote.label.material.map
  if (map && remote.label.userData.name !== presence.displayName) {
    remote.label.userData.name = presence.displayName
  }
}

function dropMissing(scene: THREE.Scene, seen: Set<string>) {
  for (const [id, remote] of remotes) {
    if (seen.has(id)) continue
    scene.remove(remote.group)
    remotes.delete(id)
  }
}

export function markDuelRings(scene: THREE.Scene) {
  if (rings) return
  rings = new THREE.Group()
  for (const ring of DUEL_RINGS) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(ring.radius - 0.35, ring.radius, 36),
      new THREE.MeshBasicMaterial({ color: '#c4a15a', transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(ring.x, 0.12, ring.z)
    rings.add(mesh)
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 16),
      new THREE.MeshBasicMaterial({ color: '#8a5a1e', transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    )
    plate.rotation.x = -Math.PI / 2
    plate.position.set(ring.x, 0.1, ring.z)
    rings.add(plate)
  }
  scene.add(rings)
}

export function pickRemote(raycaster: THREE.Raycaster): string | null {
  const list = [...remotes.values()].map(r => r.group)
  if (!list.length) return null
  const hits = raycaster.intersectObjects(list, true)
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object
    while (obj) {
      if (typeof obj.userData.pvpId === 'string') return obj.userData.pvpId
      obj = obj.parent
    }
  }
  return null
}

export function inspectRemote(playerId: string) {
  send({ t: 'inspect', playerId })
}

export function updatePvpWorld(scene: THREE.Scene, dt: number, now: number, local: {
  x: number
  z: number
  facing: number
  anim: 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'hit' | 'down'
  sprinting: boolean
}) {
  markDuelRings(scene)
  const seen = new Set<string>()
  for (const other of pvpState.others) {
    if (pvpState.muted.has(other.playerId)) continue
    seen.add(other.playerId)
    syncRemote(scene, other)
  }
  dropMissing(scene, seen)
  for (const remote of remotes.values()) {
    remote.group.position.lerp(remote.target, Math.min(1, dt * 8))
    remote.group.rotation.y += (remote.facing - remote.group.rotation.y) * Math.min(1, dt * 8)
    animateCharacter(remote.group, now)
  }
  if (now - lastPose > 80 && !pvpState.duel) {
    lastPose = now
    send({ t: 'pose', x: local.x, z: local.z, facing: local.facing, anim: local.anim, sprinting: local.sprinting })
  }
}

export function applyDuelPose(player: THREE.Object3D, you: string) {
  const duel = pvpState.duel
  if (!duel) return false
  const mine = duel.a.playerId === you ? duel.a : duel.b
  player.position.x = mine.x
  player.position.z = mine.z
  player.rotation.y = mine.facing
  return true
}

export function disposePvpWorld(scene: THREE.Scene) {
  for (const remote of remotes.values()) scene.remove(remote.group)
  remotes.clear()
  if (rings) {
    scene.remove(rings)
    rings = null
  }
}
