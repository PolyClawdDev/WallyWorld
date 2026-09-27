import * as THREE from 'three'
import type { AnimKind } from './kits'

/* ------------------------------------------------------------------ *
 * Casting motion for the voxel wayfinders.
 *
 * The characters in characters.ts are extruded pixel grids: there are
 * no skinned arms to pose. What there is, is a body sprite, a held
 * accessory (the staff and its lantern), optional antlers and a
 * familiar — all separate groups. Animating those about their own
 * origins is enough to read as a wind-up, a release and a recovery
 * without touching the art itself.
 *
 * Nothing here moves the character's world position; that belongs to
 * movement. A lunge is expressed as a local offset on the body so the
 * two never fight.
 * ------------------------------------------------------------------ */

export type Rig = ReturnType<typeof createRig>

type Pose = {
  /** Forward pitch of the whole body, radians. Positive leans into the target. */
  lean: number
  /** Local forward offset in metres: the lunge. */
  push: number
  /** Staff pitch: negative lifts the head of the staff. */
  staffPitch: number
  /** Staff swing across the body. */
  staffYaw: number
  /** Vertical bounce on the body only. */
  hop: number
  /** Body twist about the vertical axis. */
  twist: number
}

const REST: Pose = { lean: 0, push: 0, staffPitch: 0, staffYaw: 0, hop: 0, twist: 0 }

type Motion = { duration: number; at: (t: number) => Pose }

/** Ease helpers: fast out, slow back, which is what makes a swing read. */
const snap = (t: number) => 1 - Math.pow(1 - t, 3)
const pulse = (t: number, peak = 0.35) => (t < peak ? t / peak : 1 - (t - peak) / (1 - peak))

const motions: Record<AnimKind, Motion> = {
  // A straight jab: staff drops level and the body follows it forward.
  thrust: {
    duration: 0.34,
    at: t => {
      const wind = t < 0.42 ? -snap(t / 0.42) : -(1 - (t - 0.42) / 0.58)
      const strike = t < 0.42 ? 0 : snap((t - 0.42) / 0.58)
      return {
        lean: wind * -0.16 + strike * 0.26,
        push: strike * 0.34 - Math.max(0, wind * -0.12),
        staffPitch: wind * 0.5 - strike * 0.95,
        staffYaw: 0,
        hop: 0,
        twist: strike * 0.1,
      }
    },
  },
  // Lantern swung across the body, with the shoulders turning through it.
  melee: {
    duration: 0.36,
    at: t => {
      const wind = t < 0.36 ? snap(t / 0.36) : 1 - snap((t - 0.36) / 0.64)
      const swing = t < 0.36 ? 0 : snap((t - 0.36) / 0.64)
      return {
        lean: swing * 0.22,
        push: swing * 0.42,
        staffPitch: -0.3 * wind - 0.2 * swing,
        staffYaw: 1.15 * wind - 2.1 * swing,
        hop: pulse(t) * 0.05,
        twist: 0.35 * wind - 0.5 * swing,
      }
    },
  },
  // Wide horizontal arc, used when something is thrown rather than jabbed.
  sweep: {
    duration: 0.42,
    at: t => {
      const arc = Math.sin(t * Math.PI)
      return {
        lean: Math.sin(t * Math.PI * 0.9) * 0.14,
        push: arc * 0.2,
        staffPitch: -0.45 * arc,
        staffYaw: -1.7 * snap(t) + 0.6 * (1 - t),
        hop: arc * 0.04,
        twist: -0.42 * snap(t) + 0.2,
      }
    },
  },
  // Staff overhead, body opened up: the "summon something" shape.
  raise: {
    duration: 0.52,
    at: t => {
      const lift = t < 0.5 ? snap(t / 0.5) : 1 - snap((t - 0.5) / 0.5)
      return {
        lean: -0.2 * lift,
        push: -0.12 * lift,
        staffPitch: 1.5 * lift,
        staffYaw: 0.25 * lift,
        hop: 0.12 * lift,
        twist: 0,
      }
    },
  },
  // Overhead then straight down into the ground.
  slam: {
    duration: 0.48,
    at: t => {
      const wind = t < 0.4 ? snap(t / 0.4) : 1
      const down = t < 0.4 ? 0 : snap((t - 0.4) / 0.6)
      return {
        lean: -0.24 * wind + 0.5 * down,
        push: 0.26 * down,
        staffPitch: 1.5 * wind - 2.6 * down,
        staffYaw: 0,
        hop: 0.16 * wind - 0.16 * down,
        twist: 0,
      }
    },
  },
  // Hard forward lean with the staff trailing behind.
  dash: {
    duration: 0.3,
    at: t => {
      const fade = 1 - t
      return {
        lean: 0.55 * fade,
        push: 0.2 * fade,
        staffPitch: -0.7 * fade,
        staffYaw: 0.5 * fade,
        hop: 0,
        twist: -0.2 * fade,
      }
    },
  },
  // Held, not played once: the engine keeps restarting it while channelling.
  channel: {
    duration: 0.25,
    at: t => ({
      lean: -0.12,
      push: 0.1,
      staffPitch: 1.1 + Math.sin(t * Math.PI * 4) * 0.05,
      staffYaw: 0,
      hop: 0.04,
      twist: 0,
    }),
  },
}

export function createRig(character: THREE.Object3D) {
  // children[0] is the extruded body sprite; the rest are named props.
  const body = character.children.find(child => !child.name) ?? character.children[0]
  const accessory = character.getObjectByName('accessory') ?? null
  const antlers = character.getObjectByName('antlers') ?? null
  const familiar = character.getObjectByName('familiar') ?? null
  const parts = [body, antlers].filter(Boolean) as THREE.Object3D[]
  const rest = new Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>()
  for (const part of [...parts, accessory].filter(Boolean) as THREE.Object3D[]) {
    rest.set(part, { position: part.position.clone(), rotation: part.rotation.clone() })
  }

  /**
   * Where projectiles are born. Parented to the staff so it swings with the
   * cast: a bolt genuinely leaves the lantern rather than the character's feet.
   */
  const muzzle = new THREE.Object3D()
  muzzle.position.set(1.02, 2.22, 0.34)
  ;(accessory ?? body).add(muzzle)

  let playing: AnimKind | null = null
  let elapsed = 0
  let speed = 1
  let held = false
  let flinch = 0

  const play = (kind: AnimKind, duration?: number) => {
    playing = kind
    elapsed = 0
    // Abilities with a long wind-up should stretch the motion to match, not
    // finish early and stand still waiting for the effect.
    speed = duration && duration > 0 ? motions[kind].duration / duration : 1
    held = kind === 'channel'
  }

  const stop = () => {
    held = false
    if (playing === 'channel') playing = null
  }

  const hurt = () => {
    flinch = 1
  }

  const update = (dt: number) => {
    let pose = REST
    if (playing) {
      elapsed += dt * speed
      const motion = motions[playing]
      if (elapsed >= motion.duration) {
        if (held) elapsed %= motion.duration
        else playing = null
      }
      if (playing) pose = motion.at(Math.min(0.999, elapsed / motion.duration))
    }
    flinch = Math.max(0, flinch - dt * 6)

    for (const part of parts) {
      const base = rest.get(part)!
      part.rotation.x = base.rotation.x + pose.lean - flinch * 0.25
      part.rotation.y = base.rotation.y + pose.twist
      part.position.z = base.position.z + pose.push - flinch * 0.12
      part.position.y = base.position.y + pose.hop
    }
    if (accessory) {
      const base = rest.get(accessory)!
      accessory.rotation.x = base.rotation.x + pose.staffPitch
      accessory.rotation.y = base.rotation.y + pose.staffYaw
      accessory.rotation.z = base.rotation.z + pose.lean * 0.4
      accessory.position.z = base.position.z + pose.push * 1.4
      accessory.position.y = base.position.y + pose.hop
    }
    if (familiar) {
      // The familiar swings out of the way of a big cast and drifts back.
      const target = playing ? 0.5 : 0
      familiar.position.x += ((familiar.userData.restX ?? familiar.position.x) - familiar.position.x) * 0
      familiar.rotation.z = THREE.MathUtils.lerp(familiar.rotation.z, target, Math.min(1, dt * 6))
    }
  }

  const muzzlePoint = (out = new THREE.Vector3()) => muzzle.getWorldPosition(out)

  const dispose = () => {
    for (const [part, base] of rest) {
      part.position.copy(base.position)
      part.rotation.copy(base.rotation)
    }
    muzzle.removeFromParent()
  }

  return { play, stop, hurt, update, muzzlePoint, dispose, isPlaying: () => playing !== null }
}
