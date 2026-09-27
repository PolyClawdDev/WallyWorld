import * as THREE from 'three'
import { animateCharacter, createWizard, wizards } from '../characters'
import { createCharacterNameplate, displayNameFor, type CharacterNameplate } from '../nameplate'
import { send } from './net'
import { pvpState } from './store'
import { DUEL_RINGS } from '../shared/zones'
import type { PublicPresence } from '../shared/pvp'

type Remote = {
  id: string
  group: THREE.Group
  plate: CharacterNameplate
  character: PublicPresence['loadout']['character']
  target: THREE.Vector3
  facing: number
}

const remotes = new Map<string, Remote>()
let rings: THREE.Group | null = null
let lastPose = 0

function syncRemote(scene: THREE.Scene, presence: PublicPresence) {
  let remote = remotes.get(presence.playerId)
  if (remote && remote.character !== presence.loadout.character) {
    remote.plate.dispose()
    scene.remove(remote.group)
    remotes.delete(presence.playerId)
    remote = undefined
  }
  if (!remote) {
    const wizard = createWizard(presence.loadout.character, 1, presence.loadout.style)
    wizard.userData.pvpId = presence.playerId
    wizard.userData.remotePlayer = true
    const plate = createCharacterNameplate()
    plate.attachTo(wizard)
    scene.add(wizard)
    remote = {
      id: presence.playerId,
      group: wizard,
      plate,
      character: presence.loadout.character,
      target: new THREE.Vector3(presence.x, 0, presence.z),
      facing: presence.facing,
    }
    remotes.set(presence.playerId, remote)
  }
  remote.target.set(presence.x, 0, presence.z)
  remote.facing = presence.facing
  remote.plate.setLabel(
    displayNameFor(presence.displayName, wizards[presence.loadout.character].name),
    presence.loadout.level,
    { accent: wizards[presence.loadout.character].accent },
  )
}

function dropMissing(scene: THREE.Scene, seen: Set<string>) {
  for (const [id, remote] of remotes) {
    if (seen.has(id)) continue
    remote.plate.dispose()
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

export function listRemotes() {
  return [...remotes.values()].map(remote => ({
    playerId: remote.id,
    x: remote.group.position.x,
    z: remote.group.position.z,
    targetX: remote.target.x,
    targetZ: remote.target.z,
    character: remote.character,
  }))
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
  for (const remote of remotes.values()) {
    remote.plate.dispose()
    scene.remove(remote.group)
  }
  remotes.clear()
  if (rings) {
    scene.remove(rings)
    rings = null
  }
}
