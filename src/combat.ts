import * as THREE from 'three'
import type { WizardId } from './characters'

/* ------------------------------------------------------------------ *
 * Combat: one signature ability per wayfinder, plus the player's own
 * vitals. Every ability resolves damage through the injected `world`
 * so this file never needs to know what wildlife is.
 *
 * The four abilities differ in visual, range, travel time and shape:
 *   MOTH    close dome of lantern light, fast, hits everything nearby
 *   BRAMBLE a line of thorns that erupts along the ground, heavy
 *   CINDER  a fast ember bolt with a small explosion
 *   ORBIT   a slow star that implodes and drags animals inward
 * ------------------------------------------------------------------ */

export type AbilityKind = 'burst' | 'lash' | 'bolt' | 'pulse'

export type AbilitySpec = {
  id: WizardId
  name: string
  note: string
  kind: AbilityKind
  damage: number
  cooldownMs: number
  /** Maximum distance the ability can resolve at. */
  range: number
  /** Radius of the damaging area at the impact point. */
  radius: number
  color: string
  accent: string
}

export const abilities: Record<WizardId, AbilitySpec> = {
  MOTH: {
    id: 'MOTH',
    name: 'LANTERN BURST',
    note: 'Close dome of light · hits every animal around you',
    kind: 'burst',
    damage: 14,
    cooldownMs: 550,
    range: 5.2,
    radius: 4.6,
    color: '#f0b84d',
    accent: '#fff0c4',
  },
  BRAMBLE: {
    id: 'BRAMBLE',
    name: 'THORN LASH',
    note: 'Roots erupt in a line · heaviest single hit',
    kind: 'lash',
    damage: 30,
    cooldownMs: 950,
    range: 15,
    radius: 2.6,
    color: '#9ca66d',
    accent: '#d7e39a',
  },
  CINDER: {
    id: 'CINDER',
    name: 'EMBER BLAST',
    note: 'Fast bolt · small explosion on impact',
    kind: 'bolt',
    damage: 22,
    cooldownMs: 700,
    range: 26,
    radius: 3,
    color: '#e35e35',
    accent: '#ffc46a',
  },
  ORBIT: {
    id: 'ORBIT',
    name: 'GRAVITY PULSE',
    note: 'Slow star · wide implosion, drags animals in',
    kind: 'pulse',
    damage: 20,
    cooldownMs: 1150,
    range: 34,
    radius: 5.5,
    color: '#7bc9ce',
    accent: '#c2a6e8',
  },
}

type Effect = {
  update: (dt: number, now: number) => boolean
  dispose: () => void
}

export type CombatWorld = {
  applyDamage: (center: THREE.Vector3, radius: number, damage: number) => { hits: number; killed: number }
  pull: (center: THREE.Vector3, radius: number, strength: number) => void
}

export type CombatSystem = {
  spec: AbilitySpec
  ready: (now: number) => boolean
  cooldownRatio: (now: number) => number
  /** Fires at `target` if given, otherwise straight ahead to maximum range. */
  attack: (origin: THREE.Vector3, yaw: number, target: THREE.Vector3 | null, now: number) => boolean
  update: (dt: number, now: number, camera: THREE.Camera) => void
  floatText: (text: string, at: THREE.Vector3, color: string) => void
  dispose: () => void
}

/* ------------------------- floating numbers ------------------------- */

type FloatSlot = {
  sprite: THREE.Sprite
  canvas: HTMLCanvasElement
  texture: THREE.CanvasTexture
  until: number
  from: THREE.Vector3
}

function createFloatPool(scene: THREE.Scene, size = 12) {
  const slots: FloatSlot[] = []
  for (let i = 0; i < size; i++) {
    const canvas = document.createElement('canvas')
    canvas.width = 192
    canvas.height = 96
    const texture = new THREE.CanvasTexture(canvas)
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
    sprite.scale.set(1.9, 0.95, 1)
    sprite.visible = false
    sprite.renderOrder = 20
    scene.add(sprite)
    slots.push({ sprite, canvas, texture, until: 0, from: new THREE.Vector3() })
  }
  let cursor = 0

  return {
    show(text: string, at: THREE.Vector3, color: string, now: number) {
      const slot = slots[cursor++ % slots.length]
      const ctx = slot.canvas.getContext('2d')!
      ctx.clearRect(0, 0, 192, 96)
      ctx.font = '800 56px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 8
      ctx.strokeStyle = '#0b1017'
      ctx.strokeText(text, 96, 48)
      ctx.fillStyle = color
      ctx.fillText(text, 96, 48)
      slot.texture.needsUpdate = true
      slot.from.copy(at)
      slot.until = now + 900
      slot.sprite.position.copy(at)
      slot.sprite.visible = true
      ;(slot.sprite.material as THREE.SpriteMaterial).opacity = 1
    },
    update(now: number) {
      for (const slot of slots) {
        if (!slot.sprite.visible) continue
        const remaining = slot.until - now
        if (remaining <= 0) {
          slot.sprite.visible = false
          continue
        }
        const t = 1 - remaining / 900
        slot.sprite.position.set(slot.from.x, slot.from.y + t * 1.5, slot.from.z)
        ;(slot.sprite.material as THREE.SpriteMaterial).opacity = 1 - t * t
      }
    },
    dispose() {
      for (const slot of slots) {
        scene.remove(slot.sprite)
        slot.texture.dispose()
        ;(slot.sprite.material as THREE.Material).dispose()
      }
    },
  }
}

/* ---------------------------- abilities ---------------------------- */

export function createCombat(scene: THREE.Scene, wizard: WizardId, world: CombatWorld): CombatSystem {
  const spec = abilities[wizard]
  const effects: Effect[] = []
  const floats = createFloatPool(scene)
  let readyAt = 0

  const sphere = new THREE.SphereGeometry(1, 16, 12)
  const ringGeometry = new THREE.RingGeometry(0.82, 1, 28)
  const spikeGeometry = new THREE.ConeGeometry(0.22, 1.5, 5)
  spikeGeometry.translate(0, 0.75, 0)
  const shardGeometry = new THREE.OctahedronGeometry(0.3, 0)
  const torusGeometry = new THREE.TorusGeometry(1, 0.08, 6, 28)
  const moteGeometry = new THREE.BoxGeometry(0.16, 0.16, 0.16)
  const shared: Array<{ dispose: () => void }> = [sphere, ringGeometry, spikeGeometry, shardGeometry, torusGeometry, moteGeometry]

  const track = (effect: Effect) => effects.push(effect)

  const damage = (center: THREE.Vector3, radius: number, amount: number) => {
    const result = world.applyDamage(center, radius, amount)
    if (result.hits > 0) {
      floats.show(`-${amount}`, center.clone().setY(center.y + 1.1), spec.accent, performance.now())
    }
    return result
  }

  /** MOTH: a dome of lantern light that flares out from the player. */
  const burst = (center: THREE.Vector3) => {
    const group = new THREE.Group()
    group.position.copy(center)
    const dome = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: spec.accent, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    const rim = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    )
    rim.rotation.x = -Math.PI / 2
    rim.position.y = -center.y + 0.12
    const light = new THREE.PointLight(spec.color, 9, spec.radius * 2.4)
    const motes: THREE.Mesh[] = []
    const moteMaterial = new THREE.MeshBasicMaterial({ color: spec.accent, transparent: true, opacity: 0.95 })
    for (let i = 0; i < 12; i++) {
      const mote = new THREE.Mesh(moteGeometry, moteMaterial)
      const angle = (i / 12) * Math.PI * 2
      mote.userData.dir = new THREE.Vector3(Math.cos(angle), 0.35 + (i % 3) * 0.2, Math.sin(angle))
      motes.push(mote)
      group.add(mote)
    }
    group.add(dome, rim, light)
    scene.add(group)

    let t = 0
    track({
      update(dt) {
        t += dt / 0.42
        if (t >= 1) return false
        const radius = 0.5 + spec.radius * Math.sqrt(t)
        dome.scale.setScalar(radius)
        rim.scale.setScalar(radius * 1.1)
        ;(dome.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t)
        ;(rim.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t)
        light.intensity = 9 * (1 - t)
        motes.forEach(mote => mote.position.copy((mote.userData.dir as THREE.Vector3).clone().multiplyScalar(radius * 1.05)))
        moteMaterial.opacity = 1 - t
        return true
      },
      dispose() {
        scene.remove(group)
        ;(dome.material as THREE.Material).dispose()
        ;(rim.material as THREE.Material).dispose()
        moteMaterial.dispose()
      },
    })
  }

  /** BRAMBLE: thorns tear along the ground and clamp shut at the far end. */
  const lash = (from: THREE.Vector3, to: THREE.Vector3) => {
    const group = new THREE.Group()
    scene.add(group)
    // Dark root with a bright edge, so a thorn never reads as one of the ferns
    // it is erupting through.
    const material = new THREE.MeshStandardMaterial({ color: '#4b3a22', emissive: spec.color, emissiveIntensity: 0.16, roughness: 0.9 })
    const tipMaterial = new THREE.MeshStandardMaterial({ color: spec.accent, emissive: spec.accent, emissiveIntensity: 2.4, roughness: 0.4 })
    const spikes: THREE.Mesh[] = []
    const count = 9
    for (let i = 0; i < count; i++) {
      const t = (i + 1) / count
      const spike = new THREE.Mesh(spikeGeometry, material)
      spike.position.lerpVectors(from, to, t)
      spike.position.y = 0
      spike.rotation.z = (Math.random() - 0.5) * 0.7
      spike.rotation.y = Math.random() * Math.PI
      spike.scale.set(0.01, 0.01, 0.01)
      spike.userData.delay = i * 0.028
      spike.userData.size = 1.1 + (i / count) * 1.9
      const tip = new THREE.Mesh(spikeGeometry, tipMaterial)
      tip.scale.set(0.42, 0.3, 0.42)
      tip.position.y = 1.2
      spike.add(tip)
      spikes.push(spike)
      group.add(spike)
    }
    const crownLight = new THREE.PointLight(spec.accent, 4, 8)
    crownLight.position.copy(to).setY(1)
    group.add(crownLight)

    let t = 0
    let resolved = false
    track({
      update(dt) {
        t += dt
        spikes.forEach(spike => {
          const local = Math.min(1, Math.max(0, (t - (spike.userData.delay as number)) / 0.1))
          const size = (spike.userData.size as number) * local
          spike.scale.set(size * 0.8, size, size * 0.8)
        })
        if (!resolved && t > 0.27) {
          resolved = true
          damage(to, spec.radius, spec.damage)
        }
        crownLight.intensity = Math.max(0, 4 * (1 - t / 0.6))
        if (t > 0.62) {
          const fade = Math.max(0, 1 - (t - 0.62) / 0.3)
          spikes.forEach(spike => spike.scale.multiplyScalar(0.88))
          material.emissiveIntensity = 0.16 * fade
          tipMaterial.emissiveIntensity = 2.4 * fade
        }
        return t < 0.95
      },
      dispose() {
        scene.remove(group)
        material.dispose()
        tipMaterial.dispose()
      },
    })
  }

  /** CINDER: a bolt with a burning trail, then a hot little explosion. */
  const bolt = (from: THREE.Vector3, to: THREE.Vector3) => {
    const group = new THREE.Group()
    const head = new THREE.Mesh(
      shardGeometry,
      new THREE.MeshStandardMaterial({ color: spec.accent, emissive: spec.color, emissiveIntensity: 3.2, roughness: 0.3 }),
    )
    head.scale.setScalar(1.5)
    const light = new THREE.PointLight(spec.color, 5, 9)
    group.add(head, light)
    group.position.copy(from)
    scene.add(group)

    const trailMaterial = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.85 })
    const trail: THREE.Mesh[] = []
    const direction = to.clone().sub(from)
    const distance = direction.length()
    direction.normalize()
    const speed = 30
    let travelled = 0
    let exploded = false
    let fade = 0

    track({
      update(dt, now) {
        if (!exploded) {
          travelled += speed * dt
          group.position.copy(from).addScaledVector(direction, Math.min(travelled, distance))
          head.rotation.x += dt * 9
          head.rotation.y += dt * 7
          if (trail.length < 26 && Math.random() < 0.9) {
            const ember = new THREE.Mesh(moteGeometry, trailMaterial)
            ember.position.copy(group.position)
            ember.userData.born = now
            scene.add(ember)
            trail.push(ember)
          }
          if (travelled >= distance) {
            exploded = true
            damage(to, spec.radius, spec.damage)
            head.visible = false
            // Fire, not light: a hot core inside an orange shell with a ground
            // shockwave, so this never reads like MOTH's pale lantern dome.
            const blast = new THREE.Mesh(
              sphere,
              new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.7, depthWrite: false }),
            )
            blast.name = 'blast'
            const core = new THREE.Mesh(
              sphere,
              new THREE.MeshBasicMaterial({ color: spec.accent, transparent: true, opacity: 0.95, depthWrite: false }),
            )
            core.name = 'core'
            const wave = new THREE.Mesh(
              ringGeometry,
              new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
            )
            wave.name = 'wave'
            wave.rotation.x = -Math.PI / 2
            wave.position.y = -to.y + 0.12
            group.add(blast, core, wave)
          }
        } else {
          fade += dt / 0.4
          const blast = group.getObjectByName('blast') as THREE.Mesh | undefined
          if (blast) {
            blast.scale.setScalar(0.6 + spec.radius * Math.sqrt(fade))
            ;(blast.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - fade)
          }
          const core = group.getObjectByName('core') as THREE.Mesh | undefined
          if (core) {
            core.scale.setScalar(0.4 + spec.radius * 0.45 * Math.sqrt(fade))
            ;(core.material as THREE.MeshBasicMaterial).opacity = 0.95 * Math.max(0, 1 - fade * 2.1)
          }
          const wave = group.getObjectByName('wave') as THREE.Mesh | undefined
          if (wave) {
            wave.scale.setScalar(0.5 + spec.radius * 1.5 * fade)
            ;(wave.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - fade)
          }
          light.intensity = 14 * (1 - fade)
        }
        for (let i = trail.length - 1; i >= 0; i--) {
          const ember = trail[i]
          const age = (now - (ember.userData.born as number)) / 420
          if (age >= 1) {
            scene.remove(ember)
            trail.splice(i, 1)
            continue
          }
          ember.scale.setScalar(1 - age)
          ember.position.y += dt * 0.7
        }
        return !exploded || fade < 1 || trail.length > 0
      },
      dispose() {
        trail.forEach(ember => scene.remove(ember))
        scene.remove(group)
        ;(head.material as THREE.Material).dispose()
        trailMaterial.dispose()
        for (const name of ['blast', 'core', 'wave']) {
          const part = group.getObjectByName(name) as THREE.Mesh | undefined
          if (part) (part.material as THREE.Material).dispose()
        }
      },
    })
  }

  /** ORBIT: a slow star that collapses and drags everything toward it. */
  const pulse = (from: THREE.Vector3, to: THREE.Vector3) => {
    const group = new THREE.Group()
    const star = new THREE.Mesh(
      shardGeometry,
      new THREE.MeshStandardMaterial({ color: spec.accent, emissive: spec.color, emissiveIntensity: 3, roughness: 0.2 }),
    )
    star.scale.setScalar(1.8)
    const halo = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    )
    halo.scale.setScalar(0.9)
    const light = new THREE.PointLight(spec.color, 4, 12)
    group.add(star, halo, light)
    group.position.copy(from)
    scene.add(group)

    const rings: THREE.Mesh[] = []
    const ringMaterial = new THREE.MeshBasicMaterial({ color: spec.accent, transparent: true, opacity: 0.9 })
    const direction = to.clone().sub(from)
    const distance = direction.length()
    direction.normalize()
    const speed = 14
    let travelled = 0
    let collapsed = false
    let fade = 0

    track({
      update(dt) {
        if (!collapsed) {
          travelled += speed * dt
          group.position.copy(from).addScaledVector(direction, Math.min(travelled, distance))
          star.rotation.y += dt * 4
          star.rotation.z += dt * 3
          halo.lookAt(from)
          if (travelled >= distance) {
            collapsed = true
            damage(to, spec.radius, spec.damage)
            for (let i = 0; i < 3; i++) {
              const ring = new THREE.Mesh(torusGeometry, ringMaterial)
              ring.rotation.x = -Math.PI / 2
              ring.position.copy(to).setY(0.2 + i * 0.5)
              ring.userData.offset = i * 0.12
              rings.push(ring)
              scene.add(ring)
            }
          }
        } else {
          fade += dt / 0.7
          // The implosion keeps dragging for as long as the rings are visible.
          world.pull(to, spec.radius, dt * 2.6 * (1 - fade))
          star.scale.setScalar(Math.max(0.01, 1.8 * (1 - fade * 1.6)))
          light.intensity = 10 * (1 - fade)
          rings.forEach(ring => {
            const local = Math.min(1, Math.max(0, fade - (ring.userData.offset as number)))
            ring.scale.setScalar(0.4 + spec.radius * local)
          })
          ringMaterial.opacity = 0.9 * (1 - fade)
        }
        return !collapsed || fade < 1
      },
      dispose() {
        rings.forEach(ring => scene.remove(ring))
        scene.remove(group)
        ;(star.material as THREE.Material).dispose()
        ;(halo.material as THREE.Material).dispose()
        ringMaterial.dispose()
      },
    })
  }

  return {
    spec,
    ready(now) {
      return now >= readyAt
    },
    cooldownRatio(now) {
      const remaining = readyAt - now
      return remaining <= 0 ? 0 : Math.min(1, remaining / spec.cooldownMs)
    },
    attack(origin, yaw, target, now) {
      if (now < readyAt) return false
      readyAt = now + spec.cooldownMs
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
      const muzzle = origin.clone().add(new THREE.Vector3(0, 1.5, 0))

      if (spec.kind === 'burst') {
        const centre = origin.clone().addScaledVector(forward, 1.8).setY(0.9)
        burst(centre)
        damage(centre, spec.radius, spec.damage)
        return true
      }

      const aim = target
        ? target.clone()
        : origin.clone().addScaledVector(forward, spec.range)
      if (target) {
        // Clamp a distant target back to the ability's reach instead of silently
        // letting the player out-range the number printed in the HUD.
        const offset = aim.clone().sub(origin)
        offset.y = 0
        if (offset.length() > spec.range) aim.copy(origin.clone().addScaledVector(offset.normalize(), spec.range))
      }

      if (spec.kind === 'lash') {
        lash(origin.clone().addScaledVector(forward, 0.8).setY(0), aim.clone().setY(0))
      } else if (spec.kind === 'bolt') {
        bolt(muzzle, aim.clone().setY(Math.max(0.7, aim.y)))
      } else {
        pulse(muzzle, aim.clone().setY(Math.max(0.9, aim.y)))
      }
      return true
    },
    update(dt, now) {
      for (let i = effects.length - 1; i >= 0; i--) {
        if (!effects[i].update(dt, now)) {
          effects[i].dispose()
          effects.splice(i, 1)
        }
      }
      floats.update(now)
    },
    floatText(text, at, color) {
      floats.show(text, at, color, performance.now())
    },
    dispose() {
      effects.forEach(effect => effect.dispose())
      effects.length = 0
      floats.dispose()
      shared.forEach(item => item.dispose())
    },
  }
}

/* ------------------------- the player's hide ------------------------- */

export const PLAYER_MAX_HP = 100
/** Seconds out of combat before regeneration kicks in. */
const REGEN_DELAY_MS = 6000
const REGEN_PER_SECOND = 7
const SAFE_REGEN_PER_SECOND = 26
const RESPAWN_INVULNERABLE_MS = 2500

export type Vitals = {
  hp: number
  maxHp: number
  impulse: THREE.Vector3
  lastDamageAt: number
  invulnerableUntil: number
  isInvulnerable: (now: number) => boolean
  /** `away` is the direction the hit should shove the player, not a position. */
  damage: (amount: number, away: THREE.Vector3 | null, source: string, now: number) => boolean
  heal: (amount: number) => void
  update: (dt: number, now: number, safe: boolean) => void
  reset: (now: number) => void
}

export function createVitals(onDeath: (source: string) => void): Vitals {
  const vitals: Vitals = {
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    impulse: new THREE.Vector3(),
    lastDamageAt: 0,
    invulnerableUntil: 0,
    isInvulnerable(now) {
      return now < vitals.invulnerableUntil
    },
    damage(amount, away, source, now) {
      if (vitals.hp <= 0 || vitals.isInvulnerable(now)) return false
      vitals.hp = Math.max(0, vitals.hp - Math.trunc(amount))
      vitals.lastDamageAt = now
      if (away) {
        const knock = away.clone().setY(0)
        if (knock.lengthSq() > 1e-6) vitals.impulse.copy(knock.normalize().multiplyScalar(7))
      }
      if (vitals.hp <= 0) {
        vitals.impulse.set(0, 0, 0)
        onDeath(source)
        return true
      }
      return false
    },
    heal(amount) {
      vitals.hp = Math.min(vitals.maxHp, vitals.hp + amount)
    },
    update(dt, now, safe) {
      vitals.impulse.multiplyScalar(Math.exp(-dt * 7))
      if (vitals.hp <= 0 || vitals.hp >= vitals.maxHp) return
      if (safe) {
        vitals.heal(SAFE_REGEN_PER_SECOND * dt)
      } else if (now - vitals.lastDamageAt > REGEN_DELAY_MS) {
        vitals.heal(REGEN_PER_SECOND * dt)
      }
    },
    reset(now) {
      vitals.hp = vitals.maxHp
      vitals.impulse.set(0, 0, 0)
      vitals.lastDamageAt = 0
      vitals.invulnerableUntil = now + RESPAWN_INVULNERABLE_MS
    },
  }
  return vitals
}
