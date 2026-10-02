/* ------------------------------------------------------------------ *
 * Authoritative duel sim. Clients send inputs; this file decides hits,
 * damage, death, and whether a body is still inside the arena.
 *
 * The fight happens in an INSTANCE, not in the town. Positions here are in
 * the coordinate space `src/arena/space.ts` lays out: a frame whose origin
 * is 512 m from the town, with a circular boundary and two opposite marks.
 * Three things follow from that and all three used to be bugs.
 *
 *   There is no town in here, so there is no town protection to apply. The
 *   `isInTown` guards that used to be threaded through every damage path
 *   were not protecting anyone in a duel — they were a pocket of the
 *   `east-heath` ring in which a fighter could not be hit, because that
 *   ring overlapped a building's skirt. Town is enforced where it belongs,
 *   on the challenge.
 *
 *   The boundary is a circle with nothing in it, so containment is one
 *   comparison and there is no pathfinding. `src/battle/nav.ts` is
 *   deliberately not imported: constructing a NavGrid bakes the entire
 *   town into a blocking grid, which is precisely what put trees in the
 *   duel area.
 *
 *   The arena outlives the duel. A mutual rematch is a new `DuelSim` with
 *   a new id and its own escrow, handed the same `ArenaHost`, so the two
 *   fighters never leave the floor between matches.
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
  type ArenaPhase,
  type ArenaSeries,
  type ArenaView,
  type CombatEvent,
  type CombatInputKind,
  type DuelFighterView,
  type DuelSnapshot,
  type PlayerId,
  type PublicLoadout,
} from '../../shared/pvp'
import { ringById, type DuelRing } from '../../shared/zones'
/*
 * `arena/space` and `arena/dimensions` only, never `arena/index` — the
 * index builds meshes and imports Three.js, and the server has no business
 * loading a renderer to work out where two people are standing.
 */
import { arenaConfine, arenaSpawns, BOUNDARY_RADIUS, type ArenaFrame } from '../../arena/space'
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

/**
 * The instance a match is fought in.
 *
 * Owned and mutated by the hub, read here. The split is deliberate: a
 * simulation is one match and knows nothing about rematches, while the
 * series score, the standing rematch offers and the results deadline
 * belong to the instance and have to survive the match that produced them.
 * Passing the live object rather than a copy is what lets a snapshot taken
 * after settlement still report the score the hub has just updated.
 */
export type ArenaHost = {
  id: string
  frame: ArenaFrame
  matchNumber: number
  series: ArenaSeries
  rematch: { a: boolean; b: boolean }
  /** Set while the results phase is running, null otherwise. */
  resultsEndsAtMs: number | null
  /** Set once the instance is retired and both fighters are back in the town. */
  closed: boolean
}

export class DuelSim {
  readonly duelId: string
  readonly challengeId: string
  readonly ring: DuelRing
  readonly arena: ArenaHost
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
    arena: ArenaHost
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
    this.arena = input.arena
    this.stake = input.stake
    this.createdAt = input.now
    // Opposite marks, from the arena's own published layout rather than from
    // a spread this file invents: the spawn separation is derived from the
    // longest reach in any kit, so neither fighter can open by hitting
    // somebody who has not moved yet.
    const [sa, sb] = arenaSpawns(input.arena.frame)
    this.a = makeFighter(input.a, sa.x, sa.z)
    this.b = makeFighter(input.b, sb.x, sb.z)
    this.a.facing = sa.facing
    this.b.facing = sb.facing
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

  /**
   * What the client's state machine runs on.
   *
   * Derived rather than stored, so it cannot drift from the simulation. Note
   * that `ended` is not `closed`: a settled match with a results panel on
   * screen is over as a duel and still very much in the arena, and the two
   * fighters stay on the floor until the hub retires the instance.
   */
  arenaPhase(): ArenaPhase {
    if (this.arena.closed) return 'closed'
    switch (this.phase) {
      case 'preparing': return 'loading'
      case 'countdown': return 'countdown'
      case 'active': return 'fighting'
      case 'ended': return 'results'
    }
  }

  arenaView(): ArenaView {
    return {
      id: this.arena.id,
      originX: this.arena.frame.x,
      originZ: this.arena.frame.z,
      boundaryRadius: BOUNDARY_RADIUS,
      matchNumber: this.arena.matchNumber,
      phase: this.arenaPhase(),
      series: { ...this.arena.series },
      rematch: { ...this.arena.rematch },
      resultsEndsAtMs: this.arena.resultsEndsAtMs,
    }
  }

  snapshot(you: PlayerId): DuelSnapshot {
    const reconnect = [this.a, this.b].find(f => !f.connected && f.disconnectAt)
    const oob = [this.a, this.b].find(f => f.outSince)
    return {
      duelId: this.duelId,
      challengeId: this.challengeId,
      phase: this.phase,
      arena: this.arenaView(),
      ringId: this.ring.id,
      ringName: this.ring.name,
      stake: this.stake,
      pot: this.stake * 2,
      a: viewOf(this.a),
      b: viewOf(this.b),
      you,
      countdownEndsAtMs: this.phase === 'countdown' ? this.countdownAt + COUNTDOWN_MS : null,
      // Not gated on the phase, unlike the two deadlines either side of it:
      // the moment combat opened is still the truth after the match has
      // ended, and the results panel is read from an `ended` snapshot.
      roundStartedAtMs: this.startedAt || null,
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

  /**
   * The out-of-bounds forfeit, kept as a backstop rather than as a rule.
   *
   * `place` confines every move to the boundary, so in an arena this cannot
   * fire from play — there is no outside to walk to, which is why the duel
   * rules no longer promise a player they can forfeit by leaving. What it
   * still catches is a position that arrived from somewhere other than a
   * move: a restored `persist_json` written before the instance frame
   * existed, say. A fighter who is somehow outside a sealed floor has to
   * have SOME exit, and five seconds is the one this protocol already had.
   */
  private outTooLong(f: Fighter, now: number) {
    const slack = 0.4
    if (Math.hypot(f.x - this.arena.frame.x, f.z - this.arena.frame.z) <= BOUNDARY_RADIUS + slack) {
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

  /**
   * The only way a fighter's position ever changes.
   *
   * Every mover goes through here — walking, Flashstep, Blink, the Lantern
   * Anchor recall — so the boundary cannot be jumped by an ability that
   * forgot to check it. Clamping the radius and keeping the bearing is what
   * makes running into the wall slide along it instead of stopping dead.
   */
  private place(self: Fighter, x: number, z: number) {
    const held = arenaConfine(this.arena.frame, x, z)
    self.x = held.x
    self.z = held.z
    // The client is sent a position that is already inside the wall, so
    // without this it sees its wizard stop for no visible reason. One event
    // per fighter per tick at most, since there is one `place` per mover.
    if (held.moved) this.events.push({ kind: 'boundary', target: self.id })
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
      // `bolt.hit` is what keeps one shot to one hit per fighter, and
      // `other(bolt.owner)` is what keeps it scoped to this match's opponent:
      // a projectile can reach neither its own caster nor anyone in another
      // instance, because the only body it is ever tested against is that one.
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
          if (f.id !== zone.owner && zone.damage) {
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
      if (!foe) return true
      if (Math.hypot(foe.x - summon.x, foe.z - summon.z) <= summon.reach) {
        this.hurt(foe, summon.damage, summon.owner, 'Sentinel')
      }
      return true
    })
  }

  /**
   * The single chokepoint for losing hit points.
   *
   * The phase test is the invariant the brief asks for — no damage during
   * load or countdown — stated once, here, rather than trusted to hold
   * because every caller happens to be reached from the active branch. A
   * dead fighter cannot be hurt again and cannot act, which is what makes
   * one hit cost exactly one lot of damage.
   */
  private hurt(target: Fighter, amount: number, source: PlayerId, label: string) {
    if (this.phase !== 'active') return
    if (!target.alive || amount <= 0) return
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
