import * as THREE from 'three'
import type { WizardId } from '../characters'
import type { Animal, WildlifeSystem } from '../wildlife'
import { isSafeZone } from '../wildlife'
import { playSound, primeAudio } from './audio'
import type { SoundId } from './audio'
import {
  abilityCooldown,
  abilityCost,
  attackRateAt,
  basicDamageAt,
  kits,
  maxHpAt,
  maxResourceAt,
  resolveScale,
  resourceRegenAt,
  SLOTS,
} from './kits'
import type { AbilityDef, CharacterKit } from './kits'
import type { NavGrid } from './nav'
import { SHOT_CLEARANCE } from './nav'
import {
  applyUpgrade,
  applyXp,
  maxRank,
  pointsAvailable,
  progressFor,
  persistProgress,
  rankUnlockLevel,
  xpToNext,
  MAX_LEVEL,
} from './progression'
import type { AbilitySlot, CharacterProgress } from './progression'
import { castFailureMessages, checkCast } from './rules'
import type { CastCheck } from './rules'
import { createRig } from './rig'
import { battleState, pingBattle, showNotice } from './store'
import type { SlotState } from './store'
import { createVfx } from './vfx'

/* ------------------------------------------------------------------ *
 * The combat engine.
 *
 * One system owns everything that can change a number: damage, healing,
 * resource spend, cooldowns, status effects and XP. The HUD only reads
 * the snapshot in store.ts and asks for upgrades through a registered
 * command, so nothing can be applied twice by two different handlers.
 *
 * Order of business each frame:
 *   1  resolve the current order (move / attack / attack-move)
 *   2  advance any cast or channel
 *   3  advance the basic-attack cycle
 *   4  step projectiles, zones, summons and damage over time
 *   5  publish the snapshot the HUD reads
 *
 * Everything is driven by `dt`, never by frame counts, so a 5 fps
 * software-WebGL session and a 120 Hz one resolve identically.
 * ------------------------------------------------------------------ */

export type OrderKind = 'idle' | 'move' | 'attack' | 'attackMove' | 'attackMovePending'

export type FrameContext = {
  /** Ground point under the cursor, or null when the cursor is off the world. */
  cursorGround: THREE.Vector3 | null
  /** Living animal under the cursor, if any. */
  hover: Animal | null
  /** True while the player is driving with WASD this frame. */
  manualMove: boolean
  /**
   * Live Shift hold this frame. Path following (click-to-move, attack-move,
   * chase) reads this every tick so releasing Shift drops back to a walk
   * mid-route. False while a popup has paused input.
   */
  sprinting: boolean
  safe: boolean
  paused: boolean
}

export type BattleDeps = {
  scene: THREE.Scene
  camera: THREE.Camera
  player: THREE.Object3D
  wizard: WizardId
  wildlife: WildlifeSystem
  nav: NavGrid
  /** Player health lives in vitals so the existing hurt/regen/death flow keeps working. */
  vitals: {
    hp: number
    maxHp: number
    heal: (amount: number) => void
    damage: (amount: number, away: THREE.Vector3 | null, source: string, now: number) => boolean
  }
  onLevelUp?: (level: number) => void
}

type Projectile = {
  bolt: ReturnType<ReturnType<typeof createVfx>['bolt']>
  position: THREE.Vector3
  direction: THREE.Vector3
  speed: number
  travelled: number
  maxDistance: number
  radius: number
  /** Enemies already struck by this projectile, so it never double-hits. */
  struck: Set<number>
  pierce: boolean
  /** Soft homing keeps a slow bolt honest against a moving animal. */
  homing: Animal | null
  onHit: (animal: Animal, at: THREE.Vector3) => void
  onEnd: (at: THREE.Vector3, hitSomething: boolean) => void
  /** Returning projectiles reverse once instead of expiring. */
  returnTo: THREE.Object3D | null
  returning: boolean
  /** Passes through enemies and walls; used for the falling meteor. */
  ghost: boolean
}

type Zone = {
  centre: THREE.Vector3
  radius: number
  until: number
  nextTick: number
  every: number
  onTick: (now: number) => void
  handle: { end: () => void }
}

type Burn = { stacks: number; until: number; dps: number; nextTick: number; flag: { end: () => void } | null }
type Mark = { stored: number; cap: number; share: number; until: number; flag: { end: () => void } | null }

type Sentinel = {
  group: THREE.Group
  until: number
  nextAt: number
  damage: number
  reach: number
}

type Cast = {
  slot: AbilitySlot
  def: AbilityDef
  rank: number
  values: Record<string, number>
  releaseAt: number
  endAt: number
  released: boolean
  aimPoint: THREE.Vector3
  aimDir: THREE.Vector3
  target: Animal | null
}

type Channel = {
  slot: AbilitySlot
  def: AbilityDef
  values: Record<string, number>
  until: number
  nextTick: number
  drain: number
  beam: ReturnType<ReturnType<typeof createVfx>['beam']>
}

/** Bodies are wider than a point; reuse one rule everywhere. */
function bodyRadius(animal: Animal) {
  return Math.max(0.45, animal.species.height * 0.35)
}

function centreOf(animal: Animal, out = new THREE.Vector3()) {
  return out.copy(animal.group.position).setY(animal.species.height * 0.55)
}

export function createBattle(deps: BattleDeps) {
  const { scene, camera, player, wildlife, nav, vitals } = deps
  const kit: CharacterKit = kits[deps.wizard]
  const progress: CharacterProgress = progressFor(deps.wizard)
  const vfx = createVfx(scene, camera)
  const rig = createRig(player)
  const reticle = vfx.reticle(kit.accent)
  const preview = vfx.preview(kit.color)

  let resource = maxResourceAt(kit, progress.level)
  const readyAt: Record<AbilitySlot, number> = { Q: 0, W: 0, E: 0, R: 0 }

  /* ------------------------------ orders ----------------------------- */

  let order: OrderKind = 'idle'
  let path: THREE.Vector3[] = []
  let pathIndex = 0
  let orderMarker: { end: () => void } | null = null
  /** Where an attack-move was heading, so it resumes after a kill. */
  let attackMoveGoal: THREE.Vector3 | null = null
  let attackTarget: Animal | null = null
  let selected: Animal | null = null
  /** Set by pressing A; the next left click becomes an attack-move. */
  let attackMoveArmed = false
  /** Guards against grinding forever at something that cannot be reached. */
  let chaseSince = 0
  let chaseBestDistance = Infinity
  /* Wedged-on-a-corner detection for click-to-move. */
  let moveGoal: THREE.Vector3 | null = null
  let wedgeAnchor: THREE.Vector3 | null = null
  let wedgeAsked = 0
  let repaths = 0

  /* ------------------------------ combat ----------------------------- */

  let cast: Cast | null = null
  let channel: Channel | null = null
  let aiming: AbilitySlot | null = null
  let quickCast = readQuickCast()
  let swingReleaseAt = 0
  let swingTarget: Animal | null = null
  let nextAttackAt = 0
  let actionLockUntil = 0

  const projectiles: Projectile[] = []
  const zones: Zone[] = []
  const burns = new Map<number, Burn>()
  const marks = new Map<number, Mark>()
  const sentinels: Sentinel[] = []
  const rooted = new Map<number, { end: () => void }>()

  /* ---------------------------- passives ----------------------------- */

  let hitCounter = 0
  let passiveReadyAt = 0
  let empoweredUntil = 0
  let anchor: { position: THREE.Vector3; until: number; flag: { end: () => void } } | null = null

  const scratch = new THREE.Vector3()
  const scratchB = new THREE.Vector3()

  /* --------------------------- helpers ------------------------------- */

  function readQuickCast() {
    try {
      return localStorage.getItem('wally.quickcast') === 'on'
    } catch {
      return false
    }
  }

  function facePoint(point: THREE.Vector3) {
    const dx = point.x - player.position.x
    const dz = point.z - player.position.z
    if (dx * dx + dz * dz > 1e-5) player.rotation.y = Math.atan2(dx, dz)
  }

  function forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y))
  }

  function muzzle(out = new THREE.Vector3()) {
    rig.muzzlePoint(out)
    // A guard for the styles with no staff: never fire from inside the floor.
    if (out.y < 0.8) out.set(player.position.x, 1.7, player.position.z)
    // The staff is held about a metre to the character's side, which can put
    // the tip inside a wall or a boulder the character is standing clear of.
    // A bolt born in there dies against it on the first frame and the cast is
    // silently eaten, so fall back to the body — which is where the targeting
    // check was made from in the first place.
    if (!nav.lineOfSight(player.position.x, player.position.z, out.x, out.z, 0.15, SHOT_CLEARANCE)) {
      out.set(player.position.x, out.y, player.position.z)
    }
    return out
  }

  function alive(animal: Animal | null): animal is Animal {
    return !!animal && animal.state !== 'dead'
  }

  function canSee(animal: Animal) {
    return nav.lineOfSight(
      player.position.x,
      player.position.z,
      animal.group.position.x,
      animal.group.position.z,
      0.1,
      SHOT_CLEARANCE,
    )
  }

  function planarDistance(animal: Animal) {
    return Math.hypot(animal.group.position.x - player.position.x, animal.group.position.z - player.position.z)
  }

  /* ------------------------- damage and healing ---------------------- */

  /**
   * The only path from an ability to an enemy's health. Centralising it is what
   * keeps on-hit passives, marks, burns, floating numbers and the kill reward
   * from being applied twice by two different callers.
   */
  function dealDamage(
    animal: Animal,
    amount: number,
    now: number,
    options?: { source?: string; burn?: boolean; countsForPassive?: boolean; knockback?: number; from?: THREE.Vector3; colour?: string; scale?: number },
  ) {
    if (!alive(animal) || amount <= 0) return 0
    const rounded = Math.max(1, Math.round(amount))
    const result = wildlife.hurt(animal, rounded, now, {
      knockback: options?.knockback,
      from: options?.from,
    })
    if (result.dealt <= 0) return 0

    centreOf(animal, scratch).setY(animal.species.height * 0.95)
    vfx.number(String(result.dealt), scratch, options?.colour ?? kit.accent, {
      key: `dmg:${animal.id}`,
      gapMs: 220,
      scale: options?.scale ?? 1,
    })

    // Mark storage is taken from damage actually dealt, so it is capped twice:
    // by the share and by the cap.
    const mark = marks.get(animal.id)
    if (mark && now < mark.until) {
      mark.stored = Math.min(mark.cap, mark.stored + result.dealt * (mark.share / 100))
    }

    if (options?.burn !== false && kit.element === 'fire') applyBurn(animal, now)
    if (options?.countsForPassive !== false) onHitPassive(animal, now)

    if (result.killed) onEnemyKilled(animal, now)
    return result.dealt
  }

  function healPlayer(amount: number, now: number, colour = '#8fbf5a') {
    if (amount <= 0 || vitals.hp <= 0) return 0
    const before = vitals.hp
    vitals.heal(amount)
    const gained = Math.round(vitals.hp - before)
    if (gained > 0) {
      scratch.copy(player.position).setY(3.4)
      vfx.number(`+${gained}`, scratch, colour, { key: 'heal', gapMs: 420 })
    }
    return gained
  }

  function onEnemyKilled(animal: Animal, now: number) {
    playSound('death')
    // Detonate a mark the moment its host dies rather than leaking the stored
    // damage into nothing.
    const mark = marks.get(animal.id)
    if (mark) {
      mark.flag?.end()
      marks.delete(animal.id)
    }
    const burn = burns.get(animal.id)
    burn?.flag?.end()
    burns.delete(animal.id)
    rooted.get(animal.id)?.end()
    rooted.delete(animal.id)
    if (attackTarget === animal) {
      attackTarget = null
      // Attack-move keeps going; a plain attack order simply completes.
      if (order === 'attack') order = attackMoveGoal ? 'attackMove' : 'idle'
    }
    if (selected === animal) selected = null
    void now
  }

  /* ---------------------------- status ------------------------------- */

  function applyBurn(animal: Animal, now: number) {
    const dps = 4 + progress.level
    const existing = burns.get(animal.id)
    if (existing) {
      // Refresh the duration and add a stack, but never past the cap.
      existing.until = now + 3000
      existing.stacks = Math.min(3, existing.stacks + 1)
      existing.dps = dps
      return
    }
    burns.set(animal.id, {
      stacks: 1,
      until: now + 3000,
      dps,
      nextTick: now + 500,
      flag: vfx.attach(animal.group, 'burn', kit.color, animal.species.height),
    })
    playSound('impact.burn', 220)
  }

  function applyRoot(animal: Animal, seconds: number, now: number) {
    wildlife.applyStatus(animal, 'root', seconds * 1000, now)
    rooted.get(animal.id)?.end()
    rooted.set(animal.id, vfx.attach(animal.group, 'root', kit.color, animal.species.height))
    window.setTimeout(() => {
      rooted.get(animal.id)?.end()
      rooted.delete(animal.id)
    }, seconds * 1000)
    playSound('root')
  }

  function applySlow(animal: Animal, seconds: number, factor: number, now: number) {
    wildlife.applyStatus(animal, 'slow', seconds * 1000, now, factor)
  }

  /* --------------------------- passives ------------------------------ */

  function onHitPassive(animal: Animal, now: number) {
    if (kit.id === 'ORBIT') {
      hitCounter += 1
      if (hitCounter >= 3) {
        hitCounter = 0
        const extra = nearestOther(animal, 7)
        if (extra) {
          const damage = basicDamageAt(kit, progress.level) * 0.6
          centreOf(animal, scratch)
          centreOf(extra, scratchB)
          const arc = vfx.beam(scratch, scratchB, kit.color, kit.accent, 0.22)
          window.setTimeout(() => arc.end(), 130)
          playSound('cast.storm', 60)
          dealDamage(extra, damage, now, { countsForPassive: false, colour: kit.accent })
        }
      }
    } else if (kit.id === 'BRAMBLE') {
      hitCounter += 1
      if (hitCounter >= 5 && now >= passiveReadyAt) {
        hitCounter = 0
        passiveReadyAt = now + 6000
        healPlayer(12 + progress.level * 3, now, kit.accent)
        vfx.flare(player, kit.accent, 2.6, 0.5)
        playSound('heal')
      } else if (hitCounter >= 5) {
        hitCounter = 5
      }
    }
    void animal
  }

  function passiveChargeView(now: number) {
    if (kit.id === 'ORBIT') return { charge: hitCounter / 3, label: `${hitCounter} / 3` }
    if (kit.id === 'BRAMBLE') {
      const cooling = now < passiveReadyAt
      return { charge: cooling ? 1 - (passiveReadyAt - now) / 6000 : hitCounter / 5, label: cooling ? 'COOLING' : `${hitCounter} / 5` }
    }
    if (kit.id === 'MOTH') {
      if (now < empoweredUntil) return { charge: 1, label: 'READY' }
      return { charge: now >= passiveReadyAt ? 0 : 1 - (passiveReadyAt - now) / 6000, label: now >= passiveReadyAt ? 'ARMED' : 'COOLING' }
    }
    const burning = [...burns.values()].filter(burn => now < burn.until).length
    return { charge: Math.min(1, burning / 3), label: burning ? `${burning} BURNING` : 'IDLE' }
  }

  function nearestOther(exclude: Animal, radius: number) {
    let best: Animal | null = null
    let bestDistance = radius
    for (const animal of wildlife.animals) {
      if (animal === exclude || animal.state === 'dead') continue
      const distance = animal.group.position.distanceTo(exclude.group.position)
      if (distance < bestDistance) {
        best = animal
        bestDistance = distance
      }
    }
    return best
  }

  /* --------------------------- projectiles --------------------------- */

  function spawnProjectile(config: {
    from: THREE.Vector3
    direction: THREE.Vector3
    /**
     * What the shot is actually aimed at. Bolts leave the staff, which is held
     * about a metre to the character's side, so firing parallel to the line
     * from the character's feet sends them that metre wide of everything. When
     * an aim point is given the direction is taken from the muzzle to it
     * instead, and the shot goes where the player pointed.
     */
    aimAt?: THREE.Vector3 | null
    speed: number
    maxDistance: number
    radius: number
    colour?: string
    accent?: string
    size?: number
    shape?: 'shard' | 'disc' | 'spike'
    pierce?: boolean
    homing?: Animal | null
    onHit: (animal: Animal, at: THREE.Vector3) => void
    onEnd?: (at: THREE.Vector3, hitSomething: boolean) => void
    returnToCaster?: boolean
    ghost?: boolean
  }) {
    const bolt = vfx.bolt(config.colour ?? kit.color, config.accent ?? kit.accent, config.size ?? 0.34, config.shape)
    bolt.group.position.copy(config.from)
    // Flatten only horizontal shots; a meteor needs to keep its vertical axis.
    const direction = config.direction.clone()
    if (config.aimAt) {
      const corrected = config.aimAt.clone().sub(config.from).setY(0)
      if (corrected.lengthSq() > 1e-4) direction.copy(corrected)
    }
    if (Math.abs(direction.y) < 1e-6) direction.setY(0)
    const projectile: Projectile = {
      bolt,
      position: config.from.clone(),
      direction: direction.normalize(),
      speed: config.speed,
      travelled: 0,
      maxDistance: config.maxDistance,
      radius: config.radius,
      struck: new Set(),
      pierce: config.pierce ?? false,
      homing: config.homing ?? null,
      onHit: config.onHit,
      onEnd: config.onEnd ?? (() => {}),
      returnTo: config.returnToCaster ? player : null,
      returning: false,
      ghost: config.ghost ?? false,
    }
    projectiles.push(projectile)
    return projectile
  }

  function stepProjectiles(dt: number, now: number) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i]
      // Gentle homing: enough that a slow bolt lands on a walking animal,
      // not so much that a skillshot becomes a guided missile.
      if (alive(p.homing)) {
        centreOf(p.homing, scratch).sub(p.position).setY(0)
        if (scratch.lengthSq() > 1e-5) {
          scratch.normalize()
          p.direction.lerp(scratch, Math.min(1, dt * 6)).normalize()
        }
      }
      if (p.returning && p.returnTo) {
        scratch.copy(p.returnTo.position).setY(p.position.y).sub(p.position)
        if (scratch.lengthSq() > 1e-5) p.direction.copy(scratch.normalize())
      }
      const stepSize = p.speed * dt
      const fromX = p.position.x
      const fromZ = p.position.z
      p.position.addScaledVector(p.direction, stepSize)
      p.travelled += stepSize
      p.bolt.group.position.copy(p.position)

      let consumed = false
      if (!p.ghost) {
        // A fast bolt covers more ground in one frame than a body is wide, so
        // the test is against the segment it swept, not the point it landed
        // on. Sampling points instead lets shots pass clean through animals
        // whenever the frame rate dips.
        const segX = p.position.x - fromX
        const segZ = p.position.z - fromZ
        const segLengthSq = segX * segX + segZ * segZ
        for (const animal of wildlife.animals) {
          if (animal.state === 'dead' || p.struck.has(animal.id)) continue
          const toX = animal.group.position.x - fromX
          const toZ = animal.group.position.z - fromZ
          const along = segLengthSq > 1e-9 ? Math.min(1, Math.max(0, (toX * segX + toZ * segZ) / segLengthSq)) : 0
          const dx = toX - segX * along
          const dz = toZ - segZ * along
          const reach = p.radius + bodyRadius(animal)
          if (dx * dx + dz * dz > reach * reach) continue
          const hitX = fromX + segX * along
          const hitZ = fromZ + segZ * along
          // Do not let the swept test reach through a wall the bolt would have
          // died against partway along the step.
          if (!nav.lineOfSight(fromX, fromZ, hitX, hitZ, 0.15, SHOT_CLEARANCE)) continue
          p.struck.add(animal.id)
          p.onHit(animal, new THREE.Vector3(hitX, p.position.y, hitZ))
          if (!p.pierce) {
            consumed = true
            break
          }
        }
      }

      // Walls stop shots. This is what "no attacking through a building" means
      // in practice: the bolt dies against the wall rather than the target. It
      // uses the same clearance as the targeting check, so a shot that was
      // allowed to be fired past a trunk is not quietly eaten by that trunk,
      // and it sweeps the step so a thin wall cannot be jumped over.
      const hitWall = !p.ghost && !nav.lineOfSight(fromX, fromZ, p.position.x, p.position.z, 0.15, SHOT_CLEARANCE)
      const spent = p.travelled >= p.maxDistance || (p.ghost && p.position.y <= 0.4)
      // Caught, measured on the ground plane. A returning shot keeps the height
      // it was born at — the muzzle, better than two metres up — while
      // `returnTo.position` is the catcher's feet, so a straight distance can
      // never fall under this threshold and the glaive would hover on its owner
      // for the rest of the session. The return steering is planar for the same
      // reason, so the plane is the honest place to ask whether it arrived.
      const home =
        p.returning &&
        p.returnTo &&
        Math.hypot(p.position.x - p.returnTo.position.x, p.position.z - p.returnTo.position.z) < 1.2

      // A spent return leg expires too. Without it a shot whose owner blinked
      // out of reach mid-flight has no ending left to reach.
      if (consumed || hitWall || home || (spent && (p.returning || !p.returnTo))) {
        p.onEnd(p.position.clone(), consumed)
        p.bolt.end()
        projectiles.splice(i, 1)
        continue
      }
      if (spent && p.returnTo && !p.returning) {
        // The glaive turns around and gets a fresh set of legal targets.
        p.returning = true
        p.struck.clear()
        p.travelled = 0
        p.maxDistance = 40
      }
      void now
    }
  }

  /* ------------------------------ zones ------------------------------ */

  function addZone(config: {
    centre: THREE.Vector3
    radius: number
    duration: number
    every: number
    colour?: string
    accent?: string
    onTick: (now: number) => void
    motes?: number
  }) {
    const handle = vfx.zone(
      config.centre,
      config.radius,
      config.colour ?? kit.color,
      config.accent ?? kit.accent,
      config.duration,
      { motes: config.motes },
    )
    const now = performance.now()
    const zone: Zone = {
      centre: config.centre.clone(),
      radius: config.radius,
      until: now + config.duration * 1000,
      nextTick: now + config.every * 1000,
      every: config.every * 1000,
      onTick: config.onTick,
      handle,
    }
    zones.push(zone)
    return zone
  }

  function stepZones(now: number) {
    for (let i = zones.length - 1; i >= 0; i--) {
      const zone = zones[i]
      if (now >= zone.until) {
        zone.handle.end()
        zones.splice(i, 1)
        continue
      }
      if (now >= zone.nextTick) {
        zone.nextTick += zone.every
        // A long stall (tab hidden, software rendering) must not fire a burst
        // of back-dated ticks.
        if (zone.nextTick < now) zone.nextTick = now + zone.every
        zone.onTick(now)
      }
    }
  }

  function stepBurns(now: number) {
    for (const [id, burn] of burns) {
      const animal = wildlife.animals.find(a => a.id === id)
      if (!animal || animal.state === 'dead' || now >= burn.until) {
        burn.flag?.end()
        burns.delete(id)
        continue
      }
      if (now >= burn.nextTick) {
        burn.nextTick = Math.max(now, burn.nextTick) + 500
        dealDamage(animal, (burn.dps * burn.stacks) / 2, now, {
          burn: false,
          countsForPassive: false,
          colour: '#ff9a4d',
          scale: 0.75,
        })
      }
    }
  }

  function stepMarks(now: number) {
    for (const [id, mark] of marks) {
      if (now < mark.until) continue
      mark.flag?.end()
      marks.delete(id)
      const animal = wildlife.animals.find(a => a.id === id)
      if (!animal || animal.state === 'dead' || mark.stored <= 0) continue
      centreOf(animal, scratch)
      vfx.impact(scratch, kit.color, kit.accent, 2.2)
      playSound('impact.hard')
      dealDamage(animal, mark.stored, now, { countsForPassive: false, colour: '#fff0c4', scale: 1.3 })
    }
  }

  /** Sentinels are built from their own meshes, so they free their own materials. */
  function retireSentinel(sentinel: Sentinel) {
    scene.remove(sentinel.group)
    sentinel.group.traverse(node => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) (mesh.material as THREE.Material).dispose?.()
    })
  }

  function stepSentinels(dt: number, now: number) {
    for (let i = sentinels.length - 1; i >= 0; i--) {
      const sentinel = sentinels[i]
      if (now >= sentinel.until) {
        retireSentinel(sentinel)
        sentinels.splice(i, 1)
        continue
      }
      sentinel.group.rotation.y += dt * 0.6
      if (now < sentinel.nextAt) continue
      let best: Animal | null = null
      let bestDistance = sentinel.reach
      for (const animal of wildlife.animals) {
        if (animal.state === 'dead') continue
        const distance = animal.group.position.distanceTo(sentinel.group.position)
        if (distance < bestDistance) {
          best = animal
          bestDistance = distance
        }
      }
      if (!best) continue
      sentinel.nextAt = now + 1100
      const from = sentinel.group.position.clone().setY(1.2)
      centreOf(best, scratch)
      const lash = vfx.beam(from, scratch, kit.color, kit.accent, 0.16)
      window.setTimeout(() => lash.end(), 110)
      playSound('basic.thorn', 90)
      dealDamage(best, sentinel.damage, now, { countsForPassive: false })
    }
  }

  /* ------------------------ ability behaviours ----------------------- */

  type CastArgs = { values: Record<string, number>; point: THREE.Vector3; dir: THREE.Vector3; target: Animal | null; now: number; def: AbilityDef }

  const behaviours: Record<string, (args: CastArgs) => void> = {
    /* ---------------- CINDER ---------------- */
    'cinder.lance': ({ values, dir, def, point, target }) => {
      const from = muzzle()
      spawnProjectile({
        from,
        direction: dir,
        aimAt: alive(target) ? target.group.position : point,
        speed: 42,
        maxDistance: def.range,
        radius: 0.55,
        size: 0.5,
        shape: 'spike',
        onHit: (animal, at) => {
          vfx.impact(at, kit.color, kit.accent, def.radius)
          playSound('impact.hard')
          for (const caught of wildlife.animalsIn(at, def.radius)) {
            dealDamage(caught, values.damage, performance.now(), { knockback: 2.2, from: at })
          }
        },
        onEnd: (at, hit) => {
          if (!hit) vfx.impact(at, kit.color, kit.accent, 1)
        },
      })
    },
    'cinder.bloom': ({ values, point, def }) => {
      const at = point.clone().setY(0)
      const telegraph = vfx.telegraph(at, def.radius, kit.color, values.telegraph)
      const fireAt = performance.now() + values.telegraph * 1000
      pending.push({
        at: fireAt,
        run: now => {
          telegraph.end()
          vfx.impact(at.clone().setY(0.6), kit.color, kit.accent, def.radius, 0.4)
          playSound('impact.hard')
          for (const animal of wildlife.animalsIn(at, def.radius)) {
            dealDamage(animal, values.damage, now, { knockback: 1.6, from: at })
          }
          addZone({
            centre: at,
            radius: def.radius,
            duration: 3,
            every: 0.5,
            onTick: tickNow => {
              for (const animal of wildlife.animalsIn(at, def.radius)) {
                dealDamage(animal, values.burn / 2, tickNow, { countsForPassive: false, colour: '#ff9a4d', scale: 0.8 })
              }
            },
          })
        },
      })
    },
    'cinder.flashstep': ({ values, dir, def }) => {
      const from = player.position.clone()
      const to = from.clone().addScaledVector(dir, def.range)
      const landing = nav.nearestOpen(to.x, to.z) ?? from
      // Walk the dash in short steps so a wall stops it instead of teleporting through.
      const steps = 10
      let final = from.clone()
      for (let i = 1; i <= steps; i++) {
        const probe = from.clone().lerp(landing, i / steps)
        if (nav.blocked(probe.x, probe.z)) break
        final = probe
      }
      player.position.copy(final)
      facePoint(to)
      vfx.flare(player, kit.color, 2.4, 0.4)
      const now = performance.now()
      const mid = from.clone().lerp(final, 0.5)
      for (const animal of wildlife.animalsIn(mid, from.distanceTo(final) / 2 + def.radius)) {
        dealDamage(animal, values.damage, now, { knockback: 1.2, from: mid })
      }
      addZone({
        centre: mid,
        radius: Math.max(def.radius, from.distanceTo(final) / 2),
        duration: 2,
        every: 0.5,
        motes: 14,
        onTick: tickNow => {
          for (const animal of wildlife.animalsIn(mid, from.distanceTo(final) / 2 + def.radius)) {
            dealDamage(animal, values.damage / 6, tickNow, { countsForPassive: false, colour: '#ff9a4d', scale: 0.7 })
          }
        },
      })
    },
    'cinder.meteor': ({ values, point, def }) => {
      const at = point.clone().setY(0)
      const telegraph = vfx.telegraph(at, def.radius, kit.color, values.delay)
      const sky = at.clone().setY(34)
      pending.push({
        at: performance.now() + values.delay * 1000 - 420,
        run: () => {
          // The rock itself only exists for the last stretch of the fall, and
          // passes through everything: the crater below does the damage.
          spawnProjectile({
            from: sky,
            direction: new THREE.Vector3(0, -1, 0),
            speed: 80,
            maxDistance: 40,
            radius: 0,
            size: 1.4,
            ghost: true,
            onHit: () => {},
            onEnd: () => {},
          })
        },
      })
      pending.push({
        at: performance.now() + values.delay * 1000,
        run: now => {
          telegraph.end()
          vfx.impact(at.clone().setY(1), kit.color, kit.accent, def.radius * 1.3, 0.55)
          playSound('impact.hard')
          for (const animal of wildlife.animalsIn(at, def.radius)) {
            dealDamage(animal, values.damage, now, { knockback: 4, from: at, scale: 1.4 })
          }
          addZone({
            centre: at,
            radius: def.radius,
            duration: 3,
            every: 0.5,
            motes: 16,
            onTick: tickNow => {
              for (const animal of wildlife.animalsIn(at, def.radius)) {
                dealDamage(animal, 10 + progress.level, tickNow, { countsForPassive: false, colour: '#ff9a4d', scale: 0.8 })
              }
            },
          })
        },
      })
    },

    /* ---------------- BRAMBLE ---------------- */
    'bramble.snare': ({ values, dir, def, point, target }) => {
      spawnProjectile({
        from: muzzle(),
        direction: dir,
        aimAt: alive(target) ? target.group.position : point,
        speed: 26,
        maxDistance: def.range,
        radius: 0.6,
        shape: 'spike',
        size: 0.42,
        onHit: (animal, at) => {
          const now = performance.now()
          vfx.impact(at, kit.color, kit.accent, 1.3)
          dealDamage(animal, values.damage, now)
          applyRoot(animal, values.root, now)
        },
      })
    },
    'bramble.wellspring': ({ values, point, def }) => {
      const at = point.clone().setY(0)
      let remaining = values.total
      const zone = addZone({
        centre: at,
        radius: def.radius,
        duration: values.duration,
        every: 0.25,
        colour: '#3f7a52',
        accent: kit.accent,
        onTick: now => {
          if (remaining <= 0) {
            zone.until = now
            return
          }
          if (Math.hypot(player.position.x - at.x, player.position.z - at.z) > def.radius) return
          const tick = Math.min(remaining, values.rate * 0.25)
          // Only healing actually delivered is charged against the pool, so
          // standing in it at full health does not waste it.
          remaining -= healPlayer(tick, now, kit.accent)
        },
      })
      playSound('heal')
    },
    'bramble.sentinel': ({ values, point }) => {
      const at = nav.nearestOpen(point.x, point.z) ?? point.clone()
      while (sentinels.length >= values.cap) {
        const oldest = sentinels.shift()
        if (oldest) {
          scene.remove(oldest.group)
        }
      }
      const group = new THREE.Group()
      group.position.copy(at).setY(0)
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.42, 1.5, 6),
        new THREE.MeshStandardMaterial({ color: '#4b3a22', roughness: 0.9 }),
      )
      trunk.position.y = 0.75
      trunk.castShadow = true
      const crown = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.62, 0),
        new THREE.MeshStandardMaterial({ color: kit.color, emissive: kit.accent, emissiveIntensity: 1.1, roughness: 0.6 }),
      )
      crown.position.y = 1.7
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2
        const thorn = new THREE.Mesh(
          new THREE.ConeGeometry(0.1, 0.55, 4),
          new THREE.MeshStandardMaterial({ color: kit.accent, emissive: kit.accent, emissiveIntensity: 1.4 }),
        )
        thorn.position.set(Math.cos(angle) * 0.5, 1.7, Math.sin(angle) * 0.5)
        thorn.rotation.z = -Math.cos(angle) * 1.1
        thorn.rotation.x = Math.sin(angle) * 1.1
        group.add(thorn)
      }
      group.add(trunk, crown)
      scene.add(group)
      sentinels.push({
        group,
        until: performance.now() + values.life * 1000,
        nextAt: performance.now() + 600,
        damage: values.damage,
        reach: 7,
      })
      playSound('cast.nature')
    },
    'bramble.overgrowth': ({ values, point, def }) => {
      const at = point.clone().setY(0)
      addZone({
        centre: at,
        radius: def.radius,
        duration: values.duration,
        every: 0.5,
        colour: '#2f5c3a',
        accent: kit.accent,
        motes: 18,
        onTick: now => {
          for (const animal of wildlife.animalsIn(at, def.radius)) {
            dealDamage(animal, values.damage / 2, now, { countsForPassive: false })
            applySlow(animal, 0.8, 1 - values.slow / 100, now)
          }
          // Solo play is the normal case here, so the grove has to be useful
          // with nobody else standing in it.
          if (Math.hypot(player.position.x - at.x, player.position.z - at.z) <= def.radius) {
            healPlayer(values.heal / 2, now, kit.accent)
          }
        },
      })
      vfx.impact(at.clone().setY(0.5), kit.color, kit.accent, def.radius, 0.6)
    },

    /* ---------------- ORBIT ---------------- */
    'orbit.chain': ({ values, target, def }) => {
      if (!alive(target)) return
      const now = performance.now()
      const struck = new Set<number>()
      let current: Animal | null = target
      let from = muzzle()
      let damage = values.damage
      // bounces counts leaps after the first strike, so the cast touches at
      // most bounces + 1 separate enemies and never the same one twice.
      for (let bounce = 0; bounce <= values.bounces; bounce++) {
        const victim: Animal | null = current
        if (!victim) break
        struck.add(victim.id)
        centreOf(victim, scratch)
        const arc = vfx.beam(from.clone(), scratch.clone(), kit.color, kit.accent, 0.2)
        const delay = bounce * 70
        window.setTimeout(() => arc.end(), 150 + delay)
        const amount = damage
        const first = bounce === 0
        pending.push({
          at: now + delay,
          run: tickNow => {
            vfx.impact(centreOf(victim, new THREE.Vector3()), kit.color, kit.accent, 0.9, 0.22)
            playSound('cast.storm', 50)
            dealDamage(victim, amount, tickNow, { countsForPassive: first })
          },
        })
        from = scratch.clone()
        damage *= 0.85
        let next: Animal | null = null
        let bestDistance = def.radius
        for (const animal of wildlife.animals) {
          if (animal.state === 'dead' || struck.has(animal.id)) continue
          const distance = animal.group.position.distanceTo(victim.group.position)
          if (distance < bestDistance) {
            next = animal
            bestDistance = distance
          }
        }
        current = next
      }
    },
    'orbit.stormcell': ({ values, point, def }) => {
      const at = point.clone().setY(0)
      addZone({
        centre: at,
        radius: def.radius,
        duration: values.duration,
        every: 0.6,
        colour: '#2c5a6d',
        accent: kit.accent,
        motes: 8,
        onTick: now => {
          const caught = wildlife.animalsIn(at, def.radius)
          if (caught.length) playSound('cast.storm', 120)
          for (const animal of caught) {
            centreOf(animal, scratch)
            const strike = vfx.beam(scratch.clone().setY(12), scratch.clone(), kit.color, kit.accent, 0.24)
            window.setTimeout(() => strike.end(), 110)
            dealDamage(animal, values.damage, now, { countsForPassive: false })
          }
        },
      })
    },
    'orbit.blink': ({ point, def }) => {
      const from = player.position.clone()
      const wanted = point.clone().setY(0)
      const offset = wanted.clone().sub(from).setY(0)
      if (offset.length() > def.range) offset.setLength(def.range)
      const landing = nav.nearestOpen(from.x + offset.x, from.z + offset.z) ?? from
      vfx.impact(from.clone().setY(1.4), kit.color, kit.accent, 1.2, 0.3)
      player.position.copy(landing)
      vfx.impact(landing.clone().setY(1.4), kit.accent, kit.color, 1.2, 0.3)
      vfx.flare(player, kit.accent, 2.6, 0.35)
    },
    'orbit.starfall': ({ values, def }) => {
      const from = muzzle()
      const beam = vfx.beam(from, from.clone().addScaledVector(forward(), def.range), kit.color, kit.accent, 0.55)
      channel = {
        slot: 'R',
        def,
        values,
        until: performance.now() + values.duration * 1000,
        nextTick: performance.now() + 150,
        drain: values.drain,
        beam,
      }
      rig.play('channel')
    },

    /* ---------------- MOTH ---------------- */
    'moth.glaive': ({ values, dir, def, point, target }) => {
      spawnProjectile({
        from: muzzle(),
        direction: dir,
        aimAt: alive(target) ? target.group.position : point,
        speed: 22,
        maxDistance: def.range,
        radius: 0.75,
        shape: 'disc',
        size: 0.8,
        pierce: true,
        returnToCaster: true,
        onHit: (animal, at) => {
          const now = performance.now()
          vfx.impact(at, kit.color, kit.accent, 1)
          playSound('impact.soft', 60)
          dealDamage(animal, values.damage, now)
        },
      })
    },
    'moth.mark': ({ values, target }) => {
      if (!alive(target)) return
      const now = performance.now()
      marks.get(target.id)?.flag?.end()
      marks.set(target.id, {
        stored: 0,
        cap: values.cap,
        share: values.share,
        until: now + values.duration * 1000,
        flag: vfx.attach(target.group, 'mark', kit.accent, target.species.height),
      })
      centreOf(target, scratch)
      vfx.impact(scratch, kit.accent, '#ffffff', 1, 0.24)
    },
    'moth.anchor': ({ values }) => {
      const now = performance.now()
      if (anchor && now < anchor.until) {
        // Second cast inside the window: step back to the light.
        const landing = nav.nearestOpen(anchor.position.x, anchor.position.z) ?? anchor.position
        vfx.impact(player.position.clone().setY(1.5), kit.color, kit.accent, 1.2, 0.3)
        player.position.copy(landing)
        vfx.flare(player, kit.accent, 3, 0.45)
        anchor.flag.end()
        anchor = null
        empoweredUntil = now + 4000
        readyAt.E = now + abilityCooldown(kit.abilities.E, progress.ranks.E) * 1000
        playSound('dash')
        return
      }
      const marker = vfx.marker(player.position, kit.accent)
      anchor = { position: player.position.clone(), until: now + values.window * 1000, flag: marker }
      empoweredUntil = now + 4000
      playSound('cast.light')
      // The real cooldown only starts once the anchor is spent or lapses; until
      // then E is a recast, gated by a short arming delay rather than by the
      // full cooldown that commit() just wrote.
      readyAt.E = now + 600
    },
    'moth.lightfall': ({ values, target, def }) => {
      if (!alive(target)) return
      const now = performance.now()
      centreOf(target, scratch)
      const column = vfx.beam(scratch.clone().setY(26), scratch.clone().setY(0), kit.accent, '#ffffff', 1.5)
      window.setTimeout(() => column.end(), 280)
      vfx.impact(scratch.clone(), kit.color, '#ffffff', def.radius, 0.5)
      const missing = 1 - target.hp / target.species.maxHp
      // Full execute bonus below 35% health, scaled in smoothly above it.
      const ramp = Math.min(1, missing / 0.65)
      const bonus = 1 + (values.execute / 100) * ramp
      dealDamage(target, values.damage * bonus, now, { scale: 1.5, colour: '#ffffff' })
      for (const splash of wildlife.animalsIn(target.group.position, def.radius)) {
        if (splash === target) continue
        dealDamage(splash, values.damage * 0.3, now, { countsForPassive: false })
      }
    },
  }

  /** Effects scheduled for a later moment, ticked from the main loop. */
  const pending: Array<{ at: number; run: (now: number) => void }> = []

  function stepPending(now: number) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now < pending[i].at) continue
      const job = pending[i]
      pending.splice(i, 1)
      job.run(now)
    }
  }

  /* ---------------------------- casting ------------------------------ */

  function validate(slot: AbilitySlot, now: number, aim: { point: THREE.Vector3 | null; target: Animal | null }): CastCheck {
    const rank = progress.ranks[slot]
    const def = kit.abilities[slot]
    return checkCast({
      rank,
      now,
      readyAt: readyAt[slot],
      resource,
      cost: abilityCost(def, rank),
      targeting: def.targeting,
      range: def.range,
      busy: !!cast || !!channel || now < actionLockUntil,
      dead: vitals.hp <= 0,
      target: alive(aim.target) ? { distance: planarDistance(aim.target), visible: canSee(aim.target) } : null,
      hasPoint: !!aim.point,
    })
  }

  /**
   * The single commit point. Cost and cooldown are applied here, once, only
   * after every check has passed; an invalid cast returns before either.
   */
  function commit(slot: AbilitySlot, aim: { point: THREE.Vector3 | null; target: Animal | null }, now: number) {
    const failure = validate(slot, now, aim)
    if (failure !== 'ok') {
      // 'busy' is the player double-tapping mid-cast; that deserves silence
      // rather than a scolding banner.
      if (failure !== 'busy') {
        playSound('deny')
        const detail =
          failure === 'locked'
            ? `${kit.abilities[slot].name} is not learned`
            : failure === 'cooldown'
              ? `${kit.abilities[slot].name} is cooling`
              : failure === 'resource'
                ? `Not enough ${kit.resource.name}`
                : castFailureMessages[failure]
        showNotice(detail, 'warn')
      }
      return false
    }

    const def = kit.abilities[slot]
    const rank = progress.ranks[slot]
    const values = resolveScale(def, rank)
    const cost = abilityCost(def, rank)

    const point = (aim.point ?? player.position.clone().addScaledVector(forward(), def.range)).clone().setY(0)
    // Ground casts are clamped to their own reach rather than silently letting
    // the player out-range the number in the tooltip.
    const offset = point.clone().sub(player.position).setY(0)
    if (def.range > 0 && offset.length() > def.range) point.copy(player.position.clone().addScaledVector(offset.normalize(), def.range)).setY(0)
    const dir = (alive(aim.target) ? aim.target.group.position : point).clone().sub(player.position).setY(0)
    if (dir.lengthSq() < 1e-6) dir.copy(forward())
    dir.normalize()

    resource -= cost
    readyAt[slot] = now + abilityCooldown(def, rank) * 1000
    cancelAim()
    stopBasicAttack()
    facePoint(alive(aim.target) ? aim.target.group.position : point)
    rig.play(def.anim, def.windup + def.recovery)
    playSound(def.sound)

    cast = {
      slot,
      def,
      rank,
      values,
      releaseAt: now + def.windup * 1000,
      endAt: now + (def.windup + def.recovery) * 1000,
      released: false,
      aimPoint: point,
      aimDir: dir,
      target: aim.target,
    }
    actionLockUntil = cast.endAt
    // A committed cast overrides whatever the feet were doing, except an
    // attack order, which resumes once the spell finishes.
    if (order === 'move') clearOrder()
    pingBattle()
    return true
  }

  function releaseCast(now: number) {
    if (!cast || cast.released) return
    cast.released = true
    const behaviour = behaviours[cast.def.id]
    if (behaviour) {
      behaviour({
        values: cast.values,
        point: cast.aimPoint,
        dir: cast.aimDir,
        target: cast.target,
        now,
        def: cast.def,
      })
    }
  }

  /* ------------------------ basic attack loop ------------------------ */

  function stopBasicAttack() {
    swingReleaseAt = 0
    swingTarget = null
  }

  function basicRange() {
    return kit.basic.range
  }

  function startSwing(target: Animal, now: number) {
    swingTarget = target
    swingReleaseAt = now + kit.basic.windup * 1000
    facePoint(target.group.position)
    rig.play(kit.basic.anim, kit.basic.windup + kit.basic.recovery)
    playSound(kit.basic.sound, 90)
  }

  function releaseSwing(now: number) {
    const target = swingTarget
    swingReleaseAt = 0
    swingTarget = null
    if (!alive(target)) return
    let damage = basicDamageAt(kit, progress.level)
    let empowered = false
    if (kit.id === 'MOTH' && now < empoweredUntil && now >= passiveReadyAt) {
      damage *= 1.6
      empowered = true
      empoweredUntil = 0
      passiveReadyAt = now + 6000
    }

    if (kit.basic.kind === 'melee') {
      // Reach is checked at the moment of impact, not at the moment of commit:
      // step out of a swing and it misses.
      if (planarDistance(target) > basicRange() + bodyRadius(target) + 0.4 || !canSee(target)) return
      centreOf(target, scratch)
      vfx.impact(scratch, kit.color, empowered ? '#ffffff' : kit.accent, empowered ? 1.7 : 1.1, 0.26)
      playSound(empowered ? 'impact.hard' : 'impact.soft', 60)
      dealDamage(target, damage, now, { knockback: empowered ? 2.4 : 0.8, from: player.position, scale: empowered ? 1.3 : 1 })
      if (empowered) vfx.flare(player, kit.accent, 2.4, 0.4)
      return
    }

    const from = muzzle()
    centreOf(target, scratch)
    const dir = scratch.clone().sub(from).setY(0)
    if (dir.lengthSq() < 1e-6) dir.copy(forward())
    spawnProjectile({
      from,
      direction: dir.normalize(),
      speed: kit.basic.projectileSpeed,
      maxDistance: basicRange() + 10,
      radius: 0.45,
      homing: target,
      size: kit.id === 'ORBIT' ? 0.26 : 0.34,
      shape: kit.id === 'BRAMBLE' ? 'spike' : 'shard',
      onHit: (animal, at) => {
        vfx.impact(at, kit.color, empowered ? '#ffffff' : kit.accent, empowered ? 1.5 : 0.9, 0.22)
        playSound('impact.soft', 50)
        dealDamage(animal, damage, performance.now(), { scale: empowered ? 1.3 : 1 })
      },
    })
  }

  /* ----------------------------- orders ------------------------------ */

  function clearOrder() {
    order = 'idle'
    path = []
    pathIndex = 0
    attackTarget = null
    attackMoveGoal = null
    orderMarker?.end()
    orderMarker = null
    chaseBestDistance = Infinity
    moveGoal = null
    wedgeAnchor = null
    wedgeAsked = 0
    repaths = 0
  }

  /**
   * Movement is the whole game now that there is no keyboard fallback, so a
   * click that lands on a roof, a wall or the canal is snapped to the nearest
   * standable ground rather than refused. Only a click with nothing standable
   * anywhere near it fails, and it says so.
   */
  function setPath(to: THREE.Vector3, showMarker: boolean) {
    const goal = nav.blocked(to.x, to.z) ? nav.nearestOpen(to.x, to.z) : to
    orderMarker?.end()
    orderMarker = null
    const found = goal ? nav.findPath(player.position, goal) : null
    if (!found) {
      showNotice('No route there', 'warn')
      playSound('deny')
      return false
    }
    path = found
    pathIndex = 0
    moveGoal = found[found.length - 1].clone()
    wedgeAnchor = null
    wedgeAsked = 0
    repaths = 0
    if (showMarker) orderMarker = vfx.marker(moveGoal, kit.accent)
    return true
  }

  function issueMove(to: THREE.Vector3) {
    attackTarget = null
    attackMoveGoal = null
    if (!setPath(to, true)) {
      order = 'idle'
      return
    }
    order = 'move'
    pingBattle()
  }

  function issueAttack(target: Animal) {
    if (!alive(target)) return
    attackTarget = target
    selected = target
    attackMoveGoal = null
    order = 'attack'
    path = []
    pathIndex = 0
    chaseSince = performance.now()
    chaseBestDistance = Infinity
    orderMarker?.end()
    orderMarker = null
    playSound('select')
    pingBattle()
  }

  function issueAttackMove(to: THREE.Vector3) {
    attackTarget = null
    attackMoveGoal = to.clone()
    if (!setPath(to, true)) {
      order = 'idle'
      return
    }
    order = 'attackMove'
    pingBattle()
  }

  /**
   * Every visual and timer the player owns, ended in one place.
   *
   * Each of these used to be retired only where it succeeded or expired, so any
   * path that skipped that moment — dying mid-cast above all — left the visual
   * parented to the world with nothing left that could ever remove it. Death
   * and teardown both come through here so neither can drift from the other.
   */
  function clearTransientEffects() {
    projectiles.forEach(projectile => projectile.bolt.end())
    projectiles.length = 0
    zones.forEach(zone => zone.handle.end())
    zones.length = 0
    sentinels.forEach(retireSentinel)
    sentinels.length = 0
    // Delayed jobs carry damage as well as visuals: a telegraph that lands
    // after its caster died would hit for a player who is no longer there.
    pending.length = 0
    burns.forEach(burn => burn.flag?.end())
    burns.clear()
    marks.forEach(mark => mark.flag?.end())
    marks.clear()
    rooted.forEach(flag => flag.end())
    rooted.clear()
    anchor?.flag.end()
    anchor = null
    channel?.beam.end()
    channel = null
  }

  function stopEverything(now: number) {
    clearOrder()
    stopBasicAttack()
    cancelAim()
    if (channel) endChannel()
    // The stop must stick: without this the very next frame reacquires and the
    // command does nothing visible.
    nextAttackAt = Math.max(nextAttackAt, now + 250)
    pingBattle()
  }

  /* ----------------------------- aiming ------------------------------ */

  function beginAim(slot: AbilitySlot) {
    const rank = progress.ranks[slot]
    if (rank < 1) {
      playSound('deny')
      showNotice(`${kit.abilities[slot].name} is not learned`, 'warn')
      return
    }
    aiming = slot
    battleState.aiming = slot
    pingBattle()
  }

  function cancelAim() {
    if (!aiming) return
    aiming = null
    battleState.aiming = null
    preview.hide()
    pingBattle()
  }

  function endChannel() {
    if (!channel) return
    channel.beam.end()
    channel = null
    rig.stop()
    actionLockUntil = performance.now() + 200
    pingBattle()
  }

  /* --------------------------- progression --------------------------- */

  function applyLevelStats(previousLevel: number) {
    const beforeHp = maxHpAt(kit, previousLevel)
    const afterHp = maxHpAt(kit, progress.level)
    const beforeResource = maxResourceAt(kit, previousLevel)
    const afterResource = maxResourceAt(kit, progress.level)
    vitals.maxHp = afterHp
    // Growth adds the difference rather than refilling: a level-up in the
    // middle of a fight must not be a free full heal.
    if (vitals.hp > 0) vitals.hp = Math.min(afterHp, vitals.hp + (afterHp - beforeHp))
    resource = Math.min(afterResource, resource + (afterResource - beforeResource))
  }

  function awardXp(amount: number) {
    if (amount <= 0) return
    const before = progress.level
    const result = applyXp(progress, amount)
    if (result.levelsGained > 0) {
      applyLevelStats(before)
      persistProgress()
      playSound('levelup')
      vfx.flare(player, kit.accent, 4.2, 0.9)
      battleState.levelPulse += 1
      showNotice(
        result.maxed
          ? `LEVEL ${progress.level} · MAX`
          : `LEVEL ${progress.level} · ${pointsAvailable(progress)} POINT${pointsAvailable(progress) === 1 ? '' : 'S'}`,
        'level',
      )
      deps.onLevelUp?.(progress.level)
      scratch.copy(player.position).setY(4.2)
      vfx.number(`LEVEL ${progress.level}`, scratch, kit.accent, { scale: 1.2, announce: true })
    } else {
      persistProgress()
    }
    pingBattle()
  }

  function upgrade(slot: AbilitySlot) {
    if (!applyUpgrade(progress, slot)) {
      playSound('deny')
      return false
    }
    persistProgress()
    playSound('upgrade')
    showNotice(`${kit.abilities[slot].name} → rank ${progress.ranks[slot]}`, 'point')
    pingBattle()
    return true
  }

  /* ---------------------------- the frame ---------------------------- */

  function advanceAlongPath(dt: number, speed: number) {
    if (!path.length) return false
    const waypoint = path[pathIndex]
    if (!waypoint) {
      path = []
      return false
    }
    const dx = waypoint.x - player.position.x
    const dz = waypoint.z - player.position.z
    const distance = Math.hypot(dx, dz)
    if (distance < 0.35) {
      pathIndex += 1
      if (pathIndex >= path.length) {
        path = []
        pathIndex = 0
        orderMarker?.end()
        orderMarker = null
        return false
      }
      return true
    }
    const stepSize = Math.min(speed * dt, distance)
    nav.slide(player.position, (dx / distance) * stepSize, (dz / distance) * stepSize)
    player.rotation.y = Math.atan2(dx, dz)
    return unwedge(stepSize)
  }

  /**
   * `slide` can leave the body grinding along a corner it will never round,
   * which with mouse-only movement is the game locking up. Progress is judged
   * in metres asked for versus metres actually gained, never in seconds: a
   * slow frame rate is not a wedge. Once a stretch of walking has bought
   * almost no ground, re-plan from where the body really is, and if a second
   * re-plan does not help either, give the order up out loud rather than
   * shuffling in place forever.
   */
  function unwedge(asked: number) {
    if (!wedgeAnchor) {
      wedgeAnchor = player.position.clone()
      wedgeAsked = 0
    }
    wedgeAsked += asked
    if (wedgeAsked < 2.5) return true
    const gained = Math.hypot(player.position.x - wedgeAnchor.x, player.position.z - wedgeAnchor.z)
    if (gained > wedgeAsked * 0.3) {
      wedgeAnchor.copy(player.position)
      wedgeAsked = 0
      return true
    }
    wedgeAnchor = null
    wedgeAsked = 0
    if (!moveGoal || repaths >= 2) {
      showNotice('Cannot get there', 'warn')
      playSound('deny')
      clearOrder()
      return false
    }
    repaths += 1
    const goal = moveGoal.clone()
    nav.resolve(player.position)
    const found = nav.findPath(player.position, goal)
    if (!found) {
      showNotice('Cannot get there', 'warn')
      playSound('deny')
      clearOrder()
      return false
    }
    path = found
    pathIndex = 0
    moveGoal = goal
    return true
  }

  function updateOrders(dt: number, now: number, ctx: FrameContext) {
    if (ctx.manualMove) {
      // Direct movement always wins: it cancels a queued click-to-move but
      // deliberately keeps an attack order, so you can kite.
      if (order === 'move' || order === 'attackMove') {
        clearOrder()
      } else {
        path = []
      }
    }

    if (order === 'attack' && !alive(attackTarget)) {
      attackTarget = null
      order = attackMoveGoal ? 'attackMove' : 'idle'
    }

    if (order === 'attackMove' && !alive(attackTarget)) {
      // Acquire the closest valid enemy inside a small margin over reach.
      let best: Animal | null = null
      let bestDistance = basicRange() + 4
      for (const animal of wildlife.animals) {
        if (animal.state === 'dead') continue
        const distance = planarDistance(animal)
        if (distance < bestDistance && canSee(animal)) {
          best = animal
          bestDistance = distance
        }
      }
      if (best) {
        attackTarget = best
        selected = best
        chaseSince = now
        chaseBestDistance = Infinity
        path = []
      }
    }

    const moveSpeed = ctx.sprinting ? kit.stats.runSpeed : kit.stats.moveSpeed
    if (order === 'move' || (order === 'attackMove' && !alive(attackTarget))) {
      if (!advanceAlongPath(dt, moveSpeed)) {
        if (order === 'attackMove' && attackMoveGoal && player.position.distanceTo(attackMoveGoal) < 1.2) clearOrder()
        else if (order === 'move') clearOrder()
      }
      return
    }

    if (alive(attackTarget) && (order === 'attack' || order === 'attackMove')) {
      const target = attackTarget
      const distance = planarDistance(target)
      const reach = basicRange() + bodyRadius(target)
      const visible = canSee(target)
      if (distance <= reach && visible) {
        path = []
        if (!cast && !channel && now >= nextAttackAt && !swingTarget && now >= actionLockUntil) {
          startSwing(target, now)
          nextAttackAt = now + 1000 / attackRateAt(kit, progress.level)
        }
        if (!swingTarget) facePoint(target.group.position)
        chaseBestDistance = Infinity
        return
      }
      // Out of range: walk to it, but give up rather than grind forever.
      if (distance < chaseBestDistance - 0.4) {
        chaseBestDistance = distance
        chaseSince = now
      }
      if (now - chaseSince > 4000) {
        showNotice('Cannot reach that target', 'warn')
        playSound('deny')
        clearOrder()
        return
      }
      if (!path.length) {
        const found = nav.findPath(player.position, target.group.position)
        if (!found) {
          showNotice('No route to that target', 'warn')
          playSound('deny')
          clearOrder()
          return
        }
        path = found
        pathIndex = 0
        moveGoal = target.group.position.clone()
        wedgeAnchor = null
        wedgeAsked = 0
        repaths = 0
      }
      if (!advanceAlongPath(dt, moveSpeed)) path = []
    }
  }

  function updateAimPreview(ctx: FrameContext) {
    if (!aiming) {
      preview.hide()
      return
    }
    const def = kit.abilities[aiming]
    const ground = ctx.cursorGround
    if (!ground) {
      preview.hide()
      return
    }
    const offset = ground.clone().sub(player.position).setY(0)
    const clamped = offset.length() > def.range ? player.position.clone().addScaledVector(offset.clone().normalize(), def.range) : ground.clone()
    const affordable = resource >= abilityCost(def, progress.ranks[aiming])
    preview.tint(affordable ? kit.color : '#8c8f99')
    if (def.targeting === 'point') preview.circle(clamped.setY(0), Math.max(def.radius, 0.8), player.position, def.range)
    else preview.line(player.position, clamped.setY(0), def.targeting === 'dash' ? 1.4 : Math.max(0.6, def.radius * 0.6), def.range)
  }

  function publish(now: number) {
    battleState.active = true
    battleState.wizard = kit.id
    battleState.identity = kit.identity
    battleState.color = kit.color
    battleState.accent = kit.accent
    battleState.level = progress.level
    battleState.maxed = progress.level >= MAX_LEVEL
    battleState.xp = progress.xp
    battleState.xpNeeded = xpToNext(progress.level) || 1
    battleState.points = pointsAvailable(progress)
    battleState.hp = vitals.hp
    battleState.maxHp = vitals.maxHp
    battleState.resource = resource
    battleState.maxResource = maxResourceAt(kit, progress.level)
    battleState.resourceName = kit.resource.name
    battleState.resourceShort = kit.resource.short
    battleState.resourceColor = kit.resource.color
    battleState.basicName = kit.basic.name
    battleState.basicIcon = kit.basic.icon
    battleState.basicBlurb = kit.basic.blurb
    battleState.passiveName = kit.passive.name
    battleState.passiveIcon = kit.passive.icon
    battleState.passiveBlurb = kit.passive.blurb
    battleState.passiveDetail = kit.passive.detail
    const passive = passiveChargeView(now)
    battleState.passiveCharge = passive.charge
    battleState.passiveLabel = passive.label
    battleState.quickCast = quickCast
    battleState.order = order
    battleState.aiming = aiming

    for (const slot of SLOTS) {
      const def = kit.abilities[slot]
      const rank = progress.ranks[slot]
      const view = battleState.slots[slot]
      const cost = abilityCost(def, rank)
      const remaining = Math.max(0, (readyAt[slot] - now) / 1000)
      let state: SlotState = 'ready'
      if (rank < 1) state = 'locked'
      else if (channel?.slot === slot) state = 'active'
      else if (kit.id === 'MOTH' && slot === 'E' && anchor) state = 'active'
      else if (cast?.slot === slot) state = 'casting'
      else if (aiming === slot) state = 'aiming'
      else if (remaining > 0) state = 'cooldown'
      else if (resource < cost) state = 'noResource'
      view.id = def.id
      view.name = def.name
      view.icon = def.icon
      view.short = def.short
      view.detail = def.detail(resolveScale(def, rank))
      view.rank = rank
      view.maxRank = maxRank(slot)
      view.nextRankLevel = rank >= maxRank(slot) ? 0 : rankUnlockLevel(slot, rank + 1)
      view.cost = cost
      view.cooldown = abilityCooldown(def, rank)
      view.remaining = remaining
      view.state = state
      view.range = def.range
      view.upgradable =
        rank < maxRank(slot) && progress.level >= rankUnlockLevel(slot, rank + 1) && pointsAvailable(progress) >= 1
    }

    const shown = alive(attackTarget) ? attackTarget : alive(selected) ? selected : null
    if (shown) {
      const distance = planarDistance(shown)
      battleState.target = {
        label: shown.species.label,
        hp: Math.max(0, shown.hp),
        maxHp: shown.species.maxHp,
        distance,
        inRange: distance <= basicRange() + bodyRadius(shown),
      }
    } else {
      battleState.target = null
    }
  }

  let lastPublishedKey = ''

  const system = {
    /* ---- per-frame ---- */
    update(dt: number, now: number, ctx: FrameContext) {
      if (ctx.paused) {
        vfx.update(dt, now)
        rig.update(dt)
        return { moved: false }
      }

      const before = player.position.clone()

      // Resource regenerates on a clock, not per frame.
      const maxResource = maxResourceAt(kit, progress.level)
      if (resource < maxResource) {
        resource = Math.min(maxResource, resource + resourceRegenAt(kit, progress.level) * dt * (ctx.safe ? 3 : 1))
      }

      if (anchor && now >= anchor.until) {
        anchor.flag.end()
        anchor = null
        readyAt.E = now + abilityCooldown(kit.abilities.E, progress.ranks.E) * 1000
      }

      // 1. orders
      updateOrders(dt, now, ctx)

      // 2. cast / channel
      if (cast) {
        if (!cast.released && now >= cast.releaseAt) releaseCast(now)
        if (now >= cast.endAt) {
          cast = null
          pingBattle()
        }
      }
      if (channel) {
        const drain = channel.drain * dt
        resource -= drain
        const groundAim = ctx.cursorGround
        const origin = muzzle()
        const aimPoint = groundAim
          ? origin.clone().add(groundAim.clone().sub(player.position).setY(0).normalize().multiplyScalar(channel.def.range))
          : origin.clone().addScaledVector(forward(), channel.def.range)
        facePoint(groundAim ?? aimPoint)
        channel.beam.aim(origin, aimPoint)
        if (now >= channel.nextTick) {
          channel.nextTick = now + 150
          const step = origin.clone()
          const direction = aimPoint.clone().sub(origin).normalize()
          const struck = new Set<number>()
          for (let d = 1; d <= channel.def.range; d += 1.2) {
            step.copy(origin).addScaledVector(direction, d)
            for (const animal of wildlife.animalsIn(step, channel.def.radius)) {
              if (struck.has(animal.id)) continue
              struck.add(animal.id)
              dealDamage(animal, channel.values.dps * 0.15, now, { countsForPassive: false, scale: 0.8 })
            }
          }
        }
        if (now >= channel.until || resource <= 0 || vitals.hp <= 0 || ctx.manualMove) endChannel()
      }

      // 3. basic attack release
      if (swingTarget && now >= swingReleaseAt) releaseSwing(now)

      // 4. world effects
      stepProjectiles(dt, now)
      stepPending(now)
      stepZones(now)
      stepBurns(now)
      stepMarks(now)
      stepSentinels(dt, now)

      // 5. selection reticle and preview
      const shown = alive(attackTarget) ? attackTarget : alive(selected) ? selected : null
      if (shown) reticle.show(shown.group.position, Math.max(0.9, shown.species.depth * 0.14), true)
      else reticle.hide()
      updateAimPreview(ctx)

      rig.update(dt)
      vfx.update(dt, now)
      publish(now)

      // React only when the HUD's shape changes, not on every frame.
      const key = `${progress.level}|${progress.ranks.Q}${progress.ranks.W}${progress.ranks.E}${progress.ranks.R}|${battleState.points}|${order}|${aiming ?? '-'}|${battleState.target?.label ?? '-'}`
      if (key !== lastPublishedKey) {
        lastPublishedKey = key
        pingBattle()
      }

      return { moved: player.position.distanceToSquared(before) > 1e-7 }
    },

    /* ---- input ---- */
    pressSlot(slot: AbilitySlot, ctx: { cursorGround: THREE.Vector3 | null; hover: Animal | null }) {
      primeAudio()
      const now = performance.now()
      const def = kit.abilities[slot]
      if (channel && channel.slot === slot) {
        endChannel()
        return
      }
      if (progress.ranks[slot] < 1) {
        playSound('deny')
        showNotice(`${def.name} is not learned`, 'warn')
        return
      }
      if (def.targeting === 'self') {
        commit(slot, { point: null, target: null }, now)
        return
      }
      if (def.targeting === 'unit') {
        const target = alive(ctx.hover) ? ctx.hover : alive(selected) ? selected : alive(attackTarget) ? attackTarget : null
        commit(slot, { point: ctx.cursorGround, target }, now)
        return
      }
      if (quickCast || aiming === slot) {
        commit(slot, { point: ctx.cursorGround, target: alive(ctx.hover) ? ctx.hover : null }, now)
        return
      }
      beginAim(slot)
    },

    primaryClick(ground: THREE.Vector3 | null, hover: Animal | null) {
      primeAudio()
      const now = performance.now()
      if (aiming) {
        commit(aiming, { point: ground, target: alive(hover) ? hover : null }, now)
        return
      }
      if (attackMoveArmed) {
        attackMoveArmed = false
        if (ground) issueAttackMove(ground)
        return
      }
      /* A living animal under the cursor is attacked, open ground is a walk
       * order. Both buttons run the *same* `issueAttack`, so approach, range,
       * facing, cooldowns, aggro, loot and XP cannot drift apart depending on
       * which one started the fight. Attacking also selects, so the HUD plate
       * behaves as it did when the left button only selected. */
      if (alive(hover)) {
        issueAttack(hover)
        return
      }
      selected = null
      if (ground) issueMove(ground)
      pingBattle()
    },

    secondaryClick(ground: THREE.Vector3 | null, hover: Animal | null) {
      primeAudio()
      if (aiming) {
        cancelAim()
        return
      }
      if (alive(hover)) {
        issueAttack(hover)
        return
      }
      if (ground) issueMove(ground)
    },

    pressStop() {
      stopEverything(performance.now())
    },

    armAttackMove() {
      attackMoveArmed = true
      cancelAim()
      pingBattle()
    },

    isAttackMoveArmed: () => attackMoveArmed,

    /** Escape and right-click share this: cancel the most recent intent only. */
    cancel() {
      if (aiming) {
        cancelAim()
        return true
      }
      if (attackMoveArmed) {
        attackMoveArmed = false
        return true
      }
      if (channel) {
        endChannel()
        return true
      }
      if (order !== 'idle') {
        stopEverything(performance.now())
        return true
      }
      return false
    },

    /* ---- outside events ---- */
    awardXp,
    upgrade,
    setQuickCast(on: boolean) {
      quickCast = on
      try {
        localStorage.setItem('wally.quickcast', on ? 'on' : 'off')
      } catch {
        /* storage is optional */
      }
      if (on) cancelAim()
      pingBattle()
    },
    onPlayerHurt() {
      rig.hurt()
      if (channel) endChannel()
    },
    onPlayerDied() {
      const now = performance.now()
      stopEverything(now)
      // A cast committed a moment before the killing blow still has its release
      // pending; dropping it here is what stops the spell — and its visual —
      // from arriving after the caster is already on the respawn screen.
      cast = null
      actionLockUntil = now
      rig.stop()
      clearTransientEffects()
    },
    onRespawn() {
      resource = maxResourceAt(kit, progress.level)
    },

    /* ---- read-only views used by main.tsx and the tests ---- */
    get kit() {
      return kit
    },
    get progress() {
      return progress
    },
    selectedTarget: () => selected,
    attackOrderTarget: () => attackTarget,
    currentOrder: () => order,
    isAiming: () => aiming,
    resourceValue: () => resource,
    /**
     * Only reached through the dev-only `window.__wally` probe, so the
     * verification harness can test a four-ability kit without waiting out
     * four regeneration cycles per character.
     */
    debugFill() {
      resource = maxResourceAt(kit, progress.level)
      readyAt.Q = 0
      readyAt.W = 0
      readyAt.E = 0
      readyAt.R = 0
    },
    maxResourceValue: () => maxResourceAt(kit, progress.level),
    cooldownRemaining: (slot: AbilitySlot) => Math.max(0, (readyAt[slot] - performance.now()) / 1000),
    floatText(
      text: string,
      at: THREE.Vector3,
      colour: string,
      options?: { key?: string; scale?: number; gapMs?: number; announce?: boolean },
    ) {
      vfx.number(text, at, colour, options)
    },

    /** A hit spark, for damage this engine did not deal. */
    hitSpark(at: THREE.Vector3, colour: string, accent = '#ffffff', radius = 1.1) {
      vfx.impact(at, colour, accent, radius, 0.26)
    },

    /**
     * Advances the shared visuals and nothing else.
     *
     * A duel does not run this engine — the server owns the orders, the
     * cooldowns and the damage — but the damage numbers and impacts it throws
     * still have to rise, fade and be released back to the pool. Without this
     * the first float label of a duel would hang in the air until the fight
     * ended and the ordinary update resumed.
     */
    pumpEffects(dt: number, now: number) {
      vfx.update(dt, now)
    },

    dispose() {
      clearTransientEffects()
      cast = null
      orderMarker?.end()
      reticle.end()
      preview.end()
      rig.dispose()
      vfx.dispose()
      battleState.active = false
    },
  }

  // Seed the snapshot so the HUD has real numbers on its first paint.
  vitals.maxHp = maxHpAt(kit, progress.level)
  vitals.hp = Math.min(vitals.hp, vitals.maxHp) || vitals.maxHp
  publish(performance.now())
  pingBattle()

  return system
}

export type BattleSystem = ReturnType<typeof createBattle>
