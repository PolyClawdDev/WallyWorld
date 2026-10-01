import * as THREE from 'three'
import { animateCharacter, createWizard, wizards } from '../characters'
import { createCharacterNameplate, displayNameFor, type CharacterNameplate } from '../nameplate'
import { send } from './net'
import { disposeArenaStage } from './arenaStage'
import { clearDuelCues } from './feedback'
import { isDuelLocked, isFighting, pvpState } from './store'
import { DUEL_RINGS } from '../shared/zones'
import type { DuelSnapshot, PublicPresence } from '../shared/pvp'

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

/**
 * How far the local wizard may drift from the server's opinion before it
 * is snapped back.
 *
 * Small corrections are left alone. The server clamps movement to a speed
 * budget, and under normal latency that produces a metre or two of
 * disagreement that resolves itself within a frame or two — yanking the
 * player for that would feel far worse than the drift. A gap this large is
 * not latency: either the client teleported, or it is so far out of sync
 * that what the player sees no longer matches what anyone else does.
 */
const DESYNC_SNAP_DISTANCE = 12

/**
 * Smoothing rate for remote players, per second.
 *
 * Applied as `1 - e^(-rate * dt)` rather than `rate * dt`, so the result
 * does not depend on frame rate. The naive form converges faster at 120fps
 * than at 30fps, which makes other players visibly smoother on a better
 * machine — and, at a low enough frame rate, overshoots past the target.
 */
const REMOTE_SMOOTHING = 9

/**
 * How far a remote may jump before it is moved rather than eased.
 *
 * Smoothing is for latency. A gap this size is not latency, it is a change
 * of place: an opponent entering an arena 512 m outside the world, or coming
 * back out of one. Eased, that draws a wizard skating across the whole map
 * for half a second, through a town that is no longer being rendered.
 */
const REMOTE_SNAP_DISTANCE = 40

/**
 * The opponent, as presence would have described them.
 *
 * Inside an arena the fighters' positions do NOT come from presence. Presence
 * reports where a duellist is standing in the TOWN, because that is where
 * their overworld record stays for the whole duel — the arena is not a place
 * in the town and publishing its coordinates would put both of them off the
 * map for everybody else. The duel snapshot is the only frame that carries
 * arena positions, and it goes to the two fighters and nobody else.
 */
function foeAsPresence(duel: DuelSnapshot): PublicPresence {
  const foe = duel.a.playerId === duel.you ? duel.b : duel.a
  return {
    playerId: foe.playerId,
    displayName: foe.displayName,
    loadout: foe.loadout,
    x: foe.x,
    z: foe.z,
    facing: foe.facing,
    anim: foe.anim,
    state: 'dueling',
    inTown: false,
  }
}

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

/**
 * Tells the world server this wizard was killed, so it moves its own copy.
 *
 * Without this the respawn is a local teleport the server never agreed to: it
 * clamps the jump to a walking pace, still believes the player is lying where
 * they fell, and the correction below drags them back there within a frame.
 *
 * The message deliberately carries nothing. The server owns the destination,
 * and one that named its own would be the free teleport the speed budget
 * exists to refuse. Offline this is a no-op and the local respawn stands
 * alone, because there is then nobody to disagree with it.
 */
export function reportRespawn() {
  if (!pvpState.connected) return
  send({ t: 'respawn' })
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

/* ------------------------------------------------------------------ *
 * Letting go of a duel order when the window does.
 *
 * Overworld movement is held in a key set that `main.tsx` clears on blur
 * and on `visibilitychange`, so alt-tabbing cannot leave a key down. Duel
 * movement is not held here at all: "walk to this point" and "attack" are
 * standing orders on the server, and nothing expires them. A player who
 * alt-tabs, opens a panel, or answers a message mid-fight therefore left
 * their wizard walking and swinging at an opponent they could no longer
 * see — a latched input in the one place it costs gold.
 *
 * `stop` is the frame the protocol already has for this, and the server
 * already refuses it outside an active duel, so this cannot do anything
 * else by accident.
 * ------------------------------------------------------------------ */

let inputReleaseBound = false

/**
 * Cancels the standing order. Safe to call at any time.
 *
 * Exported because a third case fires neither `blur` nor `visibilitychange`:
 * opening an in-page panel. The map, the pouch and the journal are all in
 * this document, so the window keeps focus and the tab stays visible while
 * the player's attention — and the whole world view — is somewhere else.
 * `main.tsx` already clears its held-key set when a panel pauses the world;
 * this is the duel's half of the same clearing.
 */
export function releaseDuelInput() {
  const duel = pvpState.duel
  if (!duel || !isFighting()) return
  // The same counter `main.tsx` uses, so the two cannot disagree about which
  // order came last.
  const holder = window as unknown as { __pvpSeq?: number }
  holder.__pvpSeq = (holder.__pvpSeq ?? 0) + 1
  send({ t: 'input', duelId: duel.duelId, seq: holder.__pvpSeq, kind: 'stop' })
}

function bindInputRelease() {
  if (inputReleaseBound || typeof window === 'undefined') return
  inputReleaseBound = true
  window.addEventListener('blur', releaseDuelInput)
  document.addEventListener('visibilitychange', releaseDuelInput)
}

function unbindInputRelease() {
  if (!inputReleaseBound || typeof window === 'undefined') return
  inputReleaseBound = false
  window.removeEventListener('blur', releaseDuelInput)
  document.removeEventListener('visibilitychange', releaseDuelInput)
}

export type LocalCorrection = { x: number; z: number }

/**
 * Advances remote players, sends this player's pose, and reports any
 * correction the server has issued for the local wizard.
 *
 * The caller applies the correction, because only it owns the player
 * object. Returning it rather than reaching for that object keeps this
 * module free of any writable handle on the local player.
 */
export function updatePvpWorld(scene: THREE.Scene, dt: number, now: number, local: {
  x: number
  z: number
  facing: number
  anim: 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'hit' | 'down'
  sprinting: boolean
}): LocalCorrection | null {
  bindInputRelease()
  const duel = pvpState.duel
  const seen = new Set<string>()
  if (duel && isDuelLocked()) {
    /*
     * An arena has exactly two people in it. Everyone else is dropped rather
     * than hidden, so a non-participant cannot be in the duel by having been
     * missed — and their wizard is not sitting in the scene at a town
     * position waiting to be drawn the moment something un-hides it.
     */
    const foe = foeAsPresence(duel)
    seen.add(foe.playerId)
    syncRemote(scene, foe)
  } else {
    // Built lazily, and deliberately never while an arena is up: the stage
    // hides what is in the scene when the duel starts, so a group added after
    // that would be the one piece of town left standing in the void.
    markDuelRings(scene)
    for (const other of pvpState.others) {
      if (pvpState.muted.has(other.playerId)) continue
      seen.add(other.playerId)
      syncRemote(scene, other)
    }
  }
  dropMissing(scene, seen)
  const blend = 1 - Math.exp(-REMOTE_SMOOTHING * dt)
  for (const remote of remotes.values()) {
    if (remote.group.position.distanceTo(remote.target) > REMOTE_SNAP_DISTANCE) {
      remote.group.position.copy(remote.target)
    }
    remote.group.position.lerp(remote.target, blend)
    // Rotate the short way round, or a wizard turning past π spins all the
    // way back through every angle it did not take.
    const delta = Math.atan2(
      Math.sin(remote.facing - remote.group.rotation.y),
      Math.cos(remote.facing - remote.group.rotation.y),
    )
    remote.group.rotation.y += delta * blend
    animateCharacter(remote.group, now)
  }
  // `isDuelLocked` rather than "is there a duel object": the simulation owns
  // this wizard's position only while the fight is actually happening. Gating
  // on the object's mere existence meant a duel that had finished but not been
  // cleared went on suppressing every pose this client would have sent, so the
  // player stood frozen in everyone else's town as well as their own.
  if (now - lastPose > 80 && !isDuelLocked()) {
    lastPose = now
    send({ t: 'pose', x: local.x, z: local.z, facing: local.facing, anim: local.anim, sprinting: local.sprinting })
  }

  // The server's copy of this player is the one everybody else sees. When the
  // two have diverged this far, the local view is the wrong one by definition.
  const self = pvpState.self
  if (!isDuelLocked() && self && Math.hypot(self.x - local.x, self.z - local.z) > DESYNC_SNAP_DISTANCE) {
    return { x: self.x, z: self.z }
  }
  return null
}

export function applyDuelPose(player: THREE.Object3D, you: string) {
  const duel = pvpState.duel
  // Same gate, and for the sharper reason: this function is the thing that
  // pins the player object, so a stale duel here is not a cosmetic problem,
  // it is a wizard that cannot be moved by anything.
  if (!duel || !isDuelLocked()) return false
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
    // The ring markers are built once and never rebuilt, so they were never
    // handed back either: removing the group leaves its geometries and
    // materials on the GPU, and a second mount allocates a fresh set.
    rings.traverse(node => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach(one => one.dispose())
      else material.dispose()
    })
    rings = null
  }
  unbindInputRelease()
  // The arena holds a floor, seven lights and the town's visibility record.
  // Unmounting the world without this leaves every one of them on the GPU and
  // leaves the town hidden if the unmount happened mid-duel.
  disposeArenaStage()
  clearDuelCues()
  lastPose = 0
}
