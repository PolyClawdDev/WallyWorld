/* ------------------------------------------------------------------ *
 * Authoritative duel sim. Clients send inputs; this file decides hits,
 * damage, death, and whether a body is still inside the ring.
 * ------------------------------------------------------------------ */

import {
  COMBAT_TICK_MS,
  COUNTDOWN_MS,
  DEMO_GOLD_NOTICE,
  DUEL_CAP_MS,
  GOLD_KIND,
  OUT_OF_BOUNDS_MS,
  RECONNECT_GRACE_MS,
  type AnimKind,
  type CombatEvent,
  type CombatInputKind,
  type DuelFighterView,
  type DuelSnapshot,
  type PlayerId,
  type PublicLoadout,
} from '../../shared/pvp'
import { isInTown, pointInRing, ringById, ringStarts, type DuelRing } from '../../shared/zones'
import {
  PVP_KITS,
  pvpAttackRate,
  pvpBasicDamage,
  pvpMaxHp,
  pvpMaxResource,
  pvpRankValue,
  pvpRegen,
  type PvpKit,
} from '../../shared/pvpKits'
import type { AbilitySlot } from '../../battle/progression'

export type CombatInput = {
  seq: number
  kind: CombatInputKind
  x?: number
  z?: number
  slot?: AbilitySlot
  sprinting?: boolean
  atMs: number
}

type Fighter = {
  id: PlayerId
  name: string
  loadout: PublicLoadout
  kit: PvpKit
  x: number
  z: number
  facing: number
  hp: number
  maxHp: number
  resource: number
  maxResource: number
  moveX: number | null
  moveZ: number | null
  attacking: boolean
  sprinting: boolean
  rootedUntil: number
  slowUntil: number
  slowFactor: number
  burnUntil: number
  burnDps: number
  nextBurn: number
  markUntil: number
  markStored: number
  markShare: number
  markCap: number
  lockUntil: number
  nextBasic: number
  readyAt: Record<AbilitySlot, number>
  channelUntil: number
  channelDps: number
  channelSlot: AbilitySlot | null
  anchorX: number | null
  anchorZ: number | null
  anchorUntil: number
  hits: number
  anim: AnimKind
  alive: boolean
  connected: boolean
  disconnectAt: number | null
  outSince: number | null
}

type Bolt = {
  owner: PlayerId
  x: number
  z: number
  dx: number
  dz: number
  speed: number
  left: number
  radius: number
  damage: number
  pierce: boolean
  root: number
  hit: Set<PlayerId>
  returning?: boolean
  homeX?: number
  homeZ?: number
}

type Zone = {
  owner: PlayerId
  x: number
  z: number
  radius: number
  until: number
  next: number
  every: number
  damage: number
  heal: number
  healLeft: number
  slow: number
  burn: number
}

type Summon = {
  owner: PlayerId
  x: number
  z: number
  until: number
  next: number
  damage: number
  reach: number
}

export type DuelEnd = {
  kind: 'victory' | 'draw' | 'forfeit' | 'void'
  winnerId: PlayerId | null
  loserId: PlayerId | null
  reason: string
}

export class DuelSim {
  readonly duelId: string
  readonly challengeId: string
  readonly ring: DuelRing
  readonly stake: number
  readonly createdAt: number
  phase: 'preparing' | 'countdown' | 'active' | 'ended' = 'preparing'
  countdownAt = 0
  startedAt = 0
  endedAt = 0
  tick = 0
  ready = new Set<PlayerId>()
  private a: Fighter
  private b: Fighter
  private bolts: Bolt[] = []
  private zones: Zone[] = []
  private summons: Summon[] = []
  private events: CombatEvent[] = []
  private end: DuelEnd | null = null
  private surrender: PlayerId | null = null

  constructor(input: {
    duelId: string
    challengeId: string
    ringId: string
    stake: number
    a: { id: PlayerId; name: string; loadout: PublicLoadout }
    b: { id: PlayerId; name: string; loadout: PublicLoadout }
    now: number
  }) {
    const ring = ringById(input.ringId)
    if (!ring) throw new Error('unknown ring')
    this.duelId = input.duelId
    this.challengeId = input.challengeId
    this.ring = ring
    this.stake = input.stake
    this.createdAt = input.now
    const [sa, sb] = ringStarts(ring)
    this.a = makeFighter(input.a, sa.x, sa.z)
    this.b = makeFighter(input.b, sb.x, sb.z)
    this.a.facing = Math.atan2(this.b.x - this.a.x, this.b.z - this.a.z)
    this.b.facing = Math.atan2(this.a.x - this.b.x, this.a.z - this.b.z)
  }

  fighter(id: PlayerId) {
    if (this.a.id === id) return this.a
    if (this.b.id === id) return this.b
    return null
  }

  other(id: PlayerId) {
    if (this.a.id === id) return this.b
    if (this.b.id === id) return this.a
    return null
  }

  markReady(id: PlayerId, now: number) {
    if (this.phase !== 'preparing') return
    if (!this.fighter(id)) return
    this.ready.add(id)
    if (this.ready.has(this.a.id) && this.ready.has(this.b.id)) {
      this.phase = 'countdown'
      this.countdownAt = now
    }
  }

  applyInput(id: PlayerId, input: CombatInput, now: number) {
    const self = this.fighter(id)
    if (!self || !self.alive) return
    if (this.phase !== 'active') return
    if (input.kind === 'move' || input.kind === 'attackMove') {
      if (typeof input.x === 'number' && typeof input.z === 'number') {
        self.moveX = input.x
        self.moveZ = input.z
        self.attacking = input.kind === 'attackMove'
      }
    } else if (input.kind === 'stop' || input.kind === 'cancel') {
      self.moveX = null
      self.moveZ = null
      self.attacking = false
      self.channelUntil = 0
      self.channelSlot = null
    } else if (input.kind === 'attack') {
      self.attacking = true
    } else if (input.kind === 'cast' && input.slot) {
      this.tryCast(self, input.slot, input.x, input.z, now)
    }
    if (input.sprinting !== undefined) self.sprinting = input.sprinting
  }

  requestSurrender(id: PlayerId) {
    if (!this.fighter(id)) return
    this.surrender = id
  }

  setConnected(id: PlayerId, on: boolean, now: number) {
    const self = this.fighter(id)
    if (!self) return
    self.connected = on
    self.disconnectAt = on ? null : now
  }

  step(now: number): { events: CombatEvent[]; ended: DuelEnd | null } {
    const carried = this.events
    this.events = []
    if (this.phase === 'ended') return { events: carried, ended: this.end }

    /*
     * Giving up and dropping out are resolved before the phase is looked at.
     * They used to be checked only inside the `active` branch, which meant a
     * fighter who closed their laptop during `preparing` or the countdown was
     * invisible: their opponent sat in front of a "Ready" button waiting on
     * somebody who was never coming back, and the only thing that eventually
     * moved was the 45-second prepare timeout. A duel must have the same exit
     * in every phase it can be in.
     */
    const abandoned = this.resolveAbandonment(now)
    if (abandoned) return { events: [...carried, ...abandoned.events], ended: abandoned.ended }

    if (this.phase === 'preparing') return { events: carried, ended: null }
    if (this.phase === 'countdown') {
      if (now - this.countdownAt >= COUNTDOWN_MS) {
        this.phase = 'active'
        this.startedAt = now
      }
      return { events: carried, ended: null }
    }

    this.tick += 1
    const dt = COMBAT_TICK_MS / 1000

    if (now - this.startedAt >= DUEL_CAP_MS) {
      return this.finish({ kind: 'draw', winnerId: null, loserId: null, reason: 'Fight reached the 3-minute cap' }, now)
    }

    this.tickFighter(this.a, this.b, dt, now)
    this.tickFighter(this.b, this.a, dt, now)
    this.tickBolts(now)
    this.tickZones(now)
    this.tickSummons(now)

    const deadA = !this.a.alive
    const deadB = !this.b.alive
    if (deadA && deadB) return this.finish({ kind: 'draw', winnerId: null, loserId: null, reason: 'Both fell on the same tick' }, now)
    if (deadA) return this.finish({ kind: 'victory', winnerId: this.b.id, loserId: this.a.id, reason: 'Opponent reached 0 HP' }, now)
    if (deadB) return this.finish({ kind: 'victory', winnerId: this.a.id, loserId: this.b.id, reason: 'Opponent reached 0 HP' }, now)

    const outA = this.outTooLong(this.a, now)
    const outB = this.outTooLong(this.b, now)
    if (outA && outB) return this.finish({ kind: 'draw', winnerId: null, loserId: null, reason: 'Both left the ring' }, now)
    if (outA) return this.finish({ kind: 'forfeit', winnerId: this.b.id, loserId: this.a.id, reason: 'Left the ring' }, now)
    if (outB) return this.finish({ kind: 'forfeit', winnerId: this.a.id, loserId: this.b.id, reason: 'Left the ring' }, now)

    return { events: [...carried, ...this.events], ended: null }
  }

  snapshot(you: PlayerId): DuelSnapshot {
    const reconnect = [this.a, this.b].find(f => !f.connected && f.disconnectAt)
    const oob = [this.a, this.b].find(f => f.outSince)
    return {
      duelId: this.duelId,
      challengeId: this.challengeId,
      phase: this.phase,
      ringId: this.ring.id,
      ringName: this.ring.name,
      stake: this.stake,
      pot: this.stake * 2,
      a: viewOf(this.a),
      b: viewOf(this.b),
      you,
      countdownEndsAtMs: this.phase === 'countdown' ? this.countdownAt + COUNTDOWN_MS : null,
      fightEndsAtMs: this.phase === 'active' ? this.startedAt + DUEL_CAP_MS : null,
      outOfBoundsUntilMs: oob?.outSince ? oob.outSince + OUT_OF_BOUNDS_MS : null,
      reconnectUntilMs: reconnect?.disconnectAt ? reconnect.disconnectAt + RECONNECT_GRACE_MS : null,
      tick: this.tick,
      goldKind: GOLD_KIND,
      demo: true,
      notice: DEMO_GOLD_NOTICE,
    }
  }

  persist(): string {
    return JSON.stringify({
      phase: this.phase,
      tick: this.tick,
      countdownAt: this.countdownAt,
      startedAt: this.startedAt,
      a: persistFighter(this.a),
      b: persistFighter(this.b),
    })
  }

  restore(raw: string) {
    const data = JSON.parse(raw) as ReturnType<DuelSim['persist']> extends string ? {
      phase: DuelSim['phase']
      tick: number
      countdownAt: number
      startedAt: number
      a: ReturnType<typeof persistFighter>
      b: ReturnType<typeof persistFighter>
    } : never
    this.phase = data.phase
    this.tick = data.tick
    this.countdownAt = data.countdownAt
    this.startedAt = data.startedAt
    Object.assign(this.a, data.a)
    Object.assign(this.b, data.b)
  }

  /**
   * Whether either fighter has stopped fighting, in any phase.
   *
   * Returns null when both are still in it. `disconnectAt` is only set by
   * `setConnected`, so a fighter who never dropped can never be reaped here,
   * and a fighter who dropped and came back has it cleared.
   */
  private resolveAbandonment(now: number) {
    if (this.surrender) {
      const loser = this.fighter(this.surrender)!
      const winner = this.other(this.surrender)!
      return this.finish({ kind: 'forfeit', winnerId: winner.id, loserId: loser.id, reason: 'Surrendered' }, now)
    }
    const goneA = !this.a.connected && this.a.disconnectAt !== null && now - this.a.disconnectAt >= RECONNECT_GRACE_MS
    const goneB = !this.b.connected && this.b.disconnectAt !== null && now - this.b.disconnectAt >= RECONNECT_GRACE_MS
    if (goneA && goneB) {
      return this.finish({ kind: 'void', winnerId: null, loserId: null, reason: 'Both players abandoned the duel' }, now)
    }
    if (goneA) return this.finish({ kind: 'forfeit', winnerId: this.b.id, loserId: this.a.id, reason: 'Disconnected past the reconnect window' }, now)
    if (goneB) return this.finish({ kind: 'forfeit', winnerId: this.a.id, loserId: this.b.id, reason: 'Disconnected past the reconnect window' }, now)
    return null
  }

  private finish(end: DuelEnd, now: number) {
    this.phase = 'ended'
    this.endedAt = now
    this.end = end
    this.events.push({ kind: 'announce', text: end.reason })
    return { events: this.events, ended: end }
  }

  private outTooLong(f: Fighter, now: number) {
    const inside = pointInRing(this.ring, f.x, f.z, 0.4)
    if (inside) {
      f.outSince = null
      return false
    }
    if (f.outSince === null) f.outSince = now
    return now - f.outSince >= OUT_OF_BOUNDS_MS
  }

  private tickFighter(self: Fighter, foe: Fighter, dt: number, now: number) {
    if (!self.alive) return
    self.resource = Math.min(self.maxResource, self.resource + pvpRegen(self.kit, self.loadout.level) * dt)
    if (self.burnUntil > now && now >= self.nextBurn) {
      this.hurt(self, Math.round(self.burnDps), foe.id, 'Burn')
      self.nextBurn = now + 1000
    }
    if (self.markUntil && self.markUntil <= now && self.markStored > 0) {
      this.hurt(self, Math.round(self.markStored), foe.id, 'Mark')
      self.markStored = 0
      self.markUntil = 0
    }
    if (self.channelUntil > now && self.channelSlot) {
      const aimX = foe.x - self.x
      const aimZ = foe.z - self.z
      const dist = Math.hypot(aimX, aimZ)
      if (dist <= self.kit.abilities.R.range + 0.6) {
        this.hurt(foe, Math.round(self.channelDps * dt), self.id, 'Starfall')
        self.facing = Math.atan2(aimX, aimZ)
        self.anim = 'cast'
      }
      return
    } else if (self.channelSlot) {
      self.channelSlot = null
    }

    const rooted = self.rootedUntil > now
    if (!rooted && self.moveX !== null && self.moveZ !== null) {
      const dx = self.moveX - self.x
      const dz = self.moveZ - self.z
      const dist = Math.hypot(dx, dz)
      if (dist > 0.12) {
        const slow = self.slowUntil > now ? self.slowFactor : 1
        const speed = (self.sprinting ? self.kit.stats.runSpeed : self.kit.stats.moveSpeed) * slow
        const step = Math.min(dist, speed * dt)
        const nx = self.x + (dx / dist) * step
        const nz = self.z + (dz / dist) * step
        this.place(self, nx, nz)
        self.facing = Math.atan2(dx, dz)
        self.anim = self.sprinting ? 'run' : 'walk'
      } else {
        self.moveX = null
        self.moveZ = null
        self.anim = 'idle'
      }
    } else if (rooted) {
      self.anim = 'idle'
    }

    if (self.attacking && now >= self.nextBasic && now >= self.lockUntil) {
      const range = self.kit.basic.range
      const dist = Math.hypot(foe.x - self.x, foe.z - self.z)
      if (dist <= range + 0.45) {
        self.facing = Math.atan2(foe.x - self.x, foe.z - self.z)
        this.basicHit(self, foe, now)
        self.nextBasic = now + 1000 / pvpAttackRate(self.kit, self.loadout.level)
        self.lockUntil = now + (self.kit.basic.windup + self.kit.basic.recovery) * 1000
        self.anim = 'attack'
      } else {
        self.moveX = foe.x
        self.moveZ = foe.z
      }
    }
  }

  private place(self: Fighter, x: number, z: number) {
    if (isInTown(x, z)) return
    const dx = x - this.ring.x
    const dz = z - this.ring.z
    const dist = Math.hypot(dx, dz)
    const cap = this.ring.radius + 1.2
    if (dist > cap) {
      self.x = this.ring.x + (dx / dist) * cap
      self.z = this.ring.z + (dz / dist) * cap
      return
    }
    self.x = x
    self.z = z
  }

  private basicHit(self: Fighter, foe: Fighter, now: number) {
    let damage = pvpBasicDamage(self.kit, self.loadout.level)
    if (self.kit.id === 'MOTH' && self.anchorUntil > now) damage = Math.round(damage * 1.6)
    this.hurt(foe, damage, self.id, 'Basic')
    this.afterHit(self, foe, damage, now)
  }

  private afterHit(self: Fighter, foe: Fighter, amount: number, now: number) {
    self.hits += 1
    if (self.kit.id === 'CINDER') {
      foe.burnUntil = now + 3000
      foe.burnDps = 4 + self.loadout.level
      foe.nextBurn = Math.min(foe.nextBurn || now + 1000, now + 1000)
    }
    if (self.kit.id === 'BRAMBLE' && self.hits % 5 === 0) {
      const heal = 12 + self.loadout.level * 3
      self.hp = Math.min(self.maxHp, self.hp + heal)
    }
    if (foe.markUntil > now && foe.markShare > 0) {
      foe.markStored = Math.min(foe.markCap, foe.markStored + amount * (foe.markShare / 100))
    }
  }

  private tryCast(self: Fighter, slot: AbilitySlot, x: number | undefined, z: number | undefined, now: number) {
    const def = self.kit.abilities[slot]
    const rank = self.loadout.ranks[slot]
    if (rank < 1) return
    if (now < self.readyAt[slot] || now < self.lockUntil) return
    const cost = pvpRankValue(def.cost, rank)
    if (self.resource < cost) return
    const foe = this.other(self.id)!
    const aimX = x ?? foe.x
    const aimZ = z ?? foe.z
    const dist = Math.hypot(aimX - self.x, aimZ - self.z)
    if (def.targeting === 'unit' && Math.hypot(foe.x - self.x, foe.z - self.z) > def.range + 0.5) return
    if (def.targeting !== 'self' && def.targeting !== 'unit' && dist > def.range + 0.5) return

    self.resource -= cost
    self.readyAt[slot] = now + pvpRankValue(def.cooldown, rank) * 1000
    self.lockUntil = now + (def.windup + def.recovery) * 1000
    self.facing = Math.atan2((x ?? foe.x) - self.x, (z ?? foe.z) - self.z)
    self.anim = 'cast'
    this.events.push({ kind: 'cast', source: self.id, slot, name: def.name })
    this.resolveAbility(self, foe, slot, aimX, aimZ, now)
  }

  private resolveAbility(self: Fighter, foe: Fighter, slot: AbilitySlot, x: number, z: number, now: number) {
    const def = self.kit.abilities[slot]
    const rank = self.loadout.ranks[slot]
    const values: Record<string, number> = {}
    for (const [key, list] of Object.entries(def.scale)) values[key] = pvpRankValue(list, rank)

    switch (def.id) {
      case 'cinder.lance':
      case 'bramble.snare':
      case 'moth.glaive': {
        const dx = x - self.x
        const dz = z - self.z
        const len = Math.hypot(dx, dz) || 1
        this.bolts.push({
          owner: self.id,
          x: self.x,
          z: self.z,
          dx: dx / len,
          dz: dz / len,
          speed: 28,
          left: def.range,
          radius: def.radius,
          damage: values.damage,
          pierce: false,
          root: values.root ?? 0,
          hit: new Set(),
          returning: def.id === 'moth.glaive',
          homeX: self.x,
          homeZ: self.z,
        })
        break
      }
      case 'cinder.bloom':
        this.zones.push({ owner: self.id, x, z, radius: def.radius, until: now + 3750, next: now + 750, every: 1000, damage: values.damage, heal: 0, healLeft: 0, slow: 0, burn: values.burn })
        break
      case 'cinder.flashstep': {
        const dx = x - self.x
        const dz = z - self.z
        const len = Math.hypot(dx, dz) || 1
        const step = Math.min(def.range, len)
        const nx = self.x + (dx / len) * step
        const nz = self.z + (dz / len) * step
        if (Math.hypot(foe.x - self.x, foe.z - self.z) < def.radius + 2.2) this.hurt(foe, values.damage, self.id, def.name)
        this.place(self, nx, nz)
        break
      }
      case 'cinder.meteor':
        this.zones.push({ owner: self.id, x, z, radius: def.radius, until: now + 1600, next: now + 1600, every: 99999, damage: values.damage, heal: 0, healLeft: 0, slow: 0, burn: 12 })
        break
      case 'bramble.wellspring':
        this.zones.push({ owner: self.id, x, z, radius: def.radius, until: now + 4000, next: now, every: 1000, damage: 0, heal: values.rate, healLeft: values.total, slow: 0, burn: 0 })
        break
      case 'bramble.sentinel':
        this.summons = this.summons.filter(s => s.owner !== self.id)
        this.summons.push({ owner: self.id, x, z, until: now + values.life * 1000, next: now + 1100, damage: values.damage, reach: 7 })
        break
      case 'bramble.overgrowth':
        this.zones.push({ owner: self.id, x, z, radius: def.radius, until: now + 6000, next: now, every: 1000, damage: values.damage, heal: values.heal, healLeft: 9999, slow: values.slow, burn: 0 })
        break
      case 'orbit.chain':
        this.hurt(foe, values.damage, self.id, def.name)
        this.afterHit(self, foe, values.damage, now)
        break
      case 'orbit.stormcell':
        this.zones.push({ owner: self.id, x, z, radius: def.radius, until: now + (values.duration ?? 4) * 1000, next: now, every: 600, damage: values.damage, heal: 0, healLeft: 0, slow: 0, burn: 0 })
        break
      case 'orbit.blink': {
        const dx = x - self.x
        const dz = z - self.z
        const len = Math.hypot(dx, dz) || 1
        const step = Math.min(values.distance || def.range, len)
        this.place(self, self.x + (dx / len) * step, self.z + (dz / len) * step)
        break
      }
      case 'orbit.starfall':
        self.channelUntil = now + (values.duration ?? 3) * 1000
        self.channelDps = values.dps
        self.channelSlot = 'R'
        break
      case 'moth.mark':
        foe.markUntil = now + 3500
        foe.markShare = values.share
        foe.markCap = values.cap
        foe.markStored = 0
        break
      case 'moth.anchor':
        if (self.anchorX !== null && self.anchorUntil > now) {
          this.place(self, self.anchorX, self.anchorZ!)
          self.anchorX = null
          self.anchorUntil = 0
        } else {
          self.anchorX = self.x
          self.anchorZ = self.z
          self.anchorUntil = now + (values.window ?? 6) * 1000
        }
        break
      case 'moth.lightfall': {
        const missing = 1 - foe.hp / foe.maxHp
        const bonus = missing >= 0.65 ? values.execute : Math.round(values.execute * (missing / 0.65))
        const dmg = Math.round(values.damage * (1 + bonus / 100))
        this.hurt(foe, dmg, self.id, def.name)
        this.afterHit(self, foe, dmg, now)
        break
      }
    }
  }

  private tickBolts(now: number) {
    const dt = COMBAT_TICK_MS / 1000
    this.bolts = this.bolts.filter(bolt => {
      bolt.x += bolt.dx * bolt.speed * dt
      bolt.z += bolt.dz * bolt.speed * dt
      bolt.left -= bolt.speed * dt
      const target = this.other(bolt.owner)
      const caster = this.fighter(bolt.owner)
      if (!target || !caster) return false
      if (isInTown(target.x, target.z)) return bolt.left > 0
      if (Math.hypot(bolt.x - target.x, bolt.z - target.z) <= bolt.radius + 0.55 && !bolt.hit.has(target.id)) {
        bolt.hit.add(target.id)
        this.hurt(target, bolt.damage, bolt.owner, 'Bolt')
        this.afterHit(caster, target, bolt.damage, now)
        if (bolt.root) target.rootedUntil = now + bolt.root * 1000
        if (!bolt.pierce && !bolt.returning) return false
      }
      if (bolt.left <= 0 && bolt.returning && bolt.homeX !== undefined) {
        const dx = bolt.homeX - bolt.x
        const dz = (bolt.homeZ ?? 0) - bolt.z
        const len = Math.hypot(dx, dz) || 1
        bolt.dx = dx / len
        bolt.dz = dz / len
        bolt.left = len
        bolt.returning = false
        bolt.damage = Math.round(bolt.damage * 0.6)
        bolt.hit = new Set()
        return true
      }
      return bolt.left > 0
    })
  }

  private tickZones(now: number) {
    this.zones = this.zones.filter(zone => {
      if (now >= zone.next && now <= zone.until) {
        zone.next = now + zone.every
        for (const f of [this.a, this.b]) {
          if (Math.hypot(f.x - zone.x, f.z - zone.z) > zone.radius) continue
          if (f.id !== zone.owner && zone.damage && !isInTown(f.x, f.z)) {
            this.hurt(f, zone.damage, zone.owner, 'Zone')
            if (zone.burn) {
              f.burnUntil = now + 3000
              f.burnDps = zone.burn
            }
            if (zone.slow) {
              f.slowUntil = now + 800
              f.slowFactor = 1 - zone.slow / 100
            }
          }
          if (f.id === zone.owner && zone.heal && zone.healLeft > 0) {
            const give = Math.min(zone.heal, zone.healLeft, f.maxHp - f.hp)
            f.hp += give
            zone.healLeft -= give
          }
        }
      }
      return now < zone.until
    })
  }

  private tickSummons(now: number) {
    this.summons = this.summons.filter(summon => {
      if (now > summon.until) return false
      if (now < summon.next) return true
      summon.next = now + 1100
      const foe = this.other(summon.owner)
      if (!foe || isInTown(foe.x, foe.z)) return true
      if (Math.hypot(foe.x - summon.x, foe.z - summon.z) <= summon.reach) {
        this.hurt(foe, summon.damage, summon.owner, 'Sentinel')
      }
      return true
    })
  }

  private hurt(target: Fighter, amount: number, source: PlayerId, label: string) {
    if (!target.alive || amount <= 0) return
    if (isInTown(target.x, target.z)) return
    target.hp = Math.max(0, target.hp - amount)
    target.anim = target.hp <= 0 ? 'down' : 'hit'
    this.events.push({ kind: 'hit', source, target: target.id, amount, label })
    if (target.hp <= 0) target.alive = false
  }
}

function makeFighter(input: { id: PlayerId; name: string; loadout: PublicLoadout }, x: number, z: number): Fighter {
  const kit = PVP_KITS[input.loadout.character]
  const level = input.loadout.level
  return {
    id: input.id,
    name: input.name,
    loadout: input.loadout,
    kit,
    x,
    z,
    facing: 0,
    hp: pvpMaxHp(kit, level),
    maxHp: pvpMaxHp(kit, level),
    resource: pvpMaxResource(kit, level),
    maxResource: pvpMaxResource(kit, level),
    moveX: null,
    moveZ: null,
    attacking: false,
    sprinting: false,
    rootedUntil: 0,
    slowUntil: 0,
    slowFactor: 1,
    burnUntil: 0,
    burnDps: 0,
    nextBurn: 0,
    markUntil: 0,
    markStored: 0,
    markShare: 0,
    markCap: 0,
    lockUntil: 0,
    nextBasic: 0,
    readyAt: { Q: 0, W: 0, E: 0, R: 0 },
    channelUntil: 0,
    channelDps: 0,
    channelSlot: null,
    anchorX: null,
    anchorZ: null,
    anchorUntil: 0,
    hits: 0,
    anim: 'idle',
    alive: true,
    connected: true,
    disconnectAt: null,
    outSince: null,
  }
}

function viewOf(f: Fighter): DuelFighterView {
  return {
    playerId: f.id,
    displayName: f.name,
    loadout: f.loadout,
    x: f.x,
    z: f.z,
    facing: f.facing,
    hp: f.hp,
    maxHp: f.maxHp,
    resource: f.resource,
    maxResource: f.maxResource,
    anim: f.anim,
    alive: f.alive,
    connected: f.connected,
  }
}

function persistFighter(f: Fighter) {
  return {
    x: f.x,
    z: f.z,
    facing: f.facing,
    hp: f.hp,
    resource: f.resource,
    alive: f.alive,
    connected: f.connected,
  }
}

/** Headless helper used by tests to drive a duel without sockets. */
export function forceKill(sim: DuelSim, id: PlayerId) {
  const f = sim.fighter(id)
  if (f) {
    f.hp = 0
    f.alive = false
  }
}
