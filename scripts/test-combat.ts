/*
 * Headless checks for the parts of combat that are pure logic: progression
 * rules, ability eligibility, cast validation, kit data integrity and the
 * "a kill pays out once" guard.
 *
 * Run with: npm run test:combat
 */
import * as THREE from 'three'

import { hasIcon } from '../src/battle/icons'
import {
  SLOTS,
  XP_PER_SPECIES,
  abilityCooldown,
  abilityCost,
  attackRateAt,
  basicDamageAt,
  kits,
  maxHpAt,
  maxResourceAt,
  rankValue,
  resolveScale,
} from '../src/battle/kits'
import {
  MAX_LEVEL,
  MAX_NORMAL_RANK,
  MAX_ULT_RANK,
  NORMAL_RANK_LEVELS,
  ULT_RANK_LEVELS,
  applyUpgrade,
  applyXp,
  canUpgrade,
  emptyProgress,
  maxRank,
  pointsAvailable,
  pointsSpent,
  rankUnlockLevel,
  sanitise,
  upgradeStatus,
  xpToNext,
} from '../src/battle/progression'
import type { AbilitySlot, CharacterProgress } from '../src/battle/progression'
import { checkCast } from '../src/battle/rules'
import type { CastInput } from '../src/battle/rules'
import { createBattle } from '../src/battle/engine'
import { SHOT_CLEARANCE, createNavGrid } from '../src/battle/nav'
import { createWildlife } from '../src/wildlife'
import type { WizardId } from '../src/wizards'

let passed = 0
const failures: string[] = []

/*
 * The engine draws damage numbers onto 2D canvases. Node has no DOM, so the
 * canvas and its context are stubbed out: nothing here reads a pixel back, it
 * only needs the calls to succeed so the combat logic can run headless.
 */
function shimDom() {
  const context2d = new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D
  const canvas = () => ({ width: 0, height: 0, getContext: () => context2d, style: {} })
  const globals = globalThis as unknown as { document?: unknown; window?: unknown }
  if (!globals.document) globals.document = { createElement: () => canvas(), body: { appendChild: () => {} } }
  if (!globals.window) globals.window = { setTimeout, clearTimeout, requestAnimationFrame: () => 0 }
}
shimDom()

function check(name: string, condition: boolean, detail = '') {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function group(title: string, body: () => void) {
  const before = failures.length
  body()
  const bad = failures.length - before
  console.log(`${bad ? '✗' : '✓'} ${title}${bad ? ` (${bad} failing)` : ''}`)
}

/** Raise a fresh progress record to `level` by paying XP, as the game does. */
function levelTo(level: number): CharacterProgress {
  const progress = emptyProgress()
  while (progress.level < level) applyXp(progress, xpToNext(progress.level))
  return progress
}

/* ------------------------------------------------------------------ *
 * 1. Progression rules
 * ------------------------------------------------------------------ */
group('progression: levels and points', () => {
  const fresh = emptyProgress()
  eq('starts at level 1', fresh.level, 1)
  eq('starts with no xp', fresh.xp, 0)
  eq('starts with nothing learned', SLOTS.map(s => fresh.ranks[s]), [0, 0, 0, 0])
  eq('level 1 grants one point', pointsAvailable(fresh), 1)

  for (let level = 1; level <= MAX_LEVEL; level++) {
    const at = levelTo(level)
    if (at.level !== level) failures.push(`levelTo(${level}) produced level ${at.level}`)
    if (pointsAvailable(at) !== level) failures.push(`level ${level} should hold ${level} points, holds ${pointsAvailable(at)}`)
  }
  check('level 15 holds exactly 15 points', pointsAvailable(levelTo(MAX_LEVEL)) === 15)

  const curve = Array.from({ length: MAX_LEVEL - 1 }, (_, i) => xpToNext(i + 1))
  check('xp curve rises every level', curve.every((v, i) => i === 0 || v > curve[i - 1]), curve.join(','))

  // One kill worth several levels must not be truncated to a single level-up.
  const jumper = emptyProgress()
  const bigResult = applyXp(jumper, 100000)
  eq('a huge award pins at max level', jumper.level, MAX_LEVEL)
  check('a huge award reports multiple levels', bigResult.levelsGained === MAX_LEVEL - 1, String(bigResult.levelsGained))
  eq('max level reports maxed', bigResult.maxed, true)
  eq('max level parks xp at zero', jumper.xp, 0)

  const after = applyXp(jumper, 5000)
  eq('xp at max level is discarded', after.levelsGained, 0)
  eq('xp at max level stays zero', jumper.xp, 0)

  // A precise two-level award should keep the remainder, not swallow it.
  const two = emptyProgress()
  applyXp(two, xpToNext(1) + xpToNext(2) + 7)
  eq('two-level award lands on level 3', two.level, 3)
  eq('two-level award keeps the remainder', two.xp, 7)
})

group('progression: ability ranks', () => {
  eq('normal abilities cap at rank 4', maxRank('Q'), MAX_NORMAL_RANK)
  eq('the ultimate caps at rank 3', maxRank('R'), MAX_ULT_RANK)
  eq('normal rank unlock levels', [1, 2, 3, 4].map(r => rankUnlockLevel('W', r)), [...NORMAL_RANK_LEVELS])
  eq('ultimate rank unlock levels', [1, 2, 3].map(r => rankUnlockLevel('R', r)), [...ULT_RANK_LEVELS])

  const one = levelTo(1)
  eq('Q is learnable at level 1', upgradeStatus(one, 'Q'), 'ok')
  eq('R is not learnable at level 1', upgradeStatus(one, 'R'), 'levelTooLow')
  check('R cannot be learned at level 1', !canUpgrade(one, 'R'))
  check('learning R at level 1 is refused', applyUpgrade(one, 'R') === false && one.ranks.R === 0)

  applyUpgrade(one, 'Q')
  eq('spending a point records the rank', one.ranks.Q, 1)
  eq('spending a point consumes the budget', pointsAvailable(one), 0)
  eq('a second point is not available yet', upgradeStatus(one, 'W'), 'noPoints')

  const two = levelTo(2)
  applyUpgrade(two, 'Q')
  eq('Q rank 2 needs character level 3', upgradeStatus(two, 'Q'), 'levelTooLow')

  const six = levelTo(6)
  eq('R unlocks at level 6', upgradeStatus(six, 'R'), 'ok')
  check('R can be learned at 6', applyUpgrade(six, 'R') && six.ranks.R === 1)
  eq('R rank 2 waits for level 11', upgradeStatus(six, 'R'), 'levelTooLow')

  const ten = levelTo(10)
  applyUpgrade(ten, 'R')
  eq('R rank 2 is still blocked at level 10', upgradeStatus(ten, 'R'), 'levelTooLow')

  // The full level-15 build has to consume exactly every point.
  const max = levelTo(MAX_LEVEL)
  const order: AbilitySlot[] = ['Q', 'W', 'E', 'Q', 'W', 'E', 'R', 'Q', 'W', 'E', 'R', 'Q', 'W', 'E', 'R']
  let spentAll = true
  for (const slot of order) if (!applyUpgrade(max, slot)) spentAll = false
  check('a full build spends all 15 points', spentAll)
  eq('a full build maxes every ability', [max.ranks.Q, max.ranks.W, max.ranks.E, max.ranks.R], [4, 4, 4, 3])
  eq('a full build has nothing left', pointsAvailable(max), 0)
  eq('a full build spent 15', pointsSpent(max), 15)
  eq('nothing can be added after that', upgradeStatus(max, 'Q'), 'maxRank')
})

group('progression: hand-edited saves are clamped', () => {
  const bad = sanitise({ level: 900, xp: -40, ranks: { Q: 99, W: -3, E: 2, R: 12 } })
  eq('level is clamped to max', bad.level, MAX_LEVEL)
  check('xp is never negative', bad.xp >= 0, String(bad.xp))
  eq('normal ranks are clamped', bad.ranks.Q, MAX_NORMAL_RANK)
  eq('negative ranks become zero', bad.ranks.W, 0)
  eq('ultimate rank is clamped', bad.ranks.R, MAX_ULT_RANK)
  check('a clamped save never overspends', pointsSpent(bad) <= bad.level, `${pointsSpent(bad)} of ${bad.level}`)

  const overspent = sanitise({ level: 1, xp: 0, ranks: { Q: 4, W: 4, E: 4, R: 3 } })
  check('an overspent save is trimmed to its budget', pointsSpent(overspent) <= overspent.level, `${pointsSpent(overspent)} of ${overspent.level}`)

  const junk = sanitise('not a save')
  eq('junk falls back to a fresh record', junk.level, 1)
})

/* ------------------------------------------------------------------ *
 * 2. Cast validation: an illegal cast must be refused before it costs
 * ------------------------------------------------------------------ */
group('cast validation', () => {
  const base: CastInput = {
    rank: 1,
    now: 1000,
    readyAt: 0,
    resource: 100,
    cost: 30,
    targeting: 'point',
    range: 12,
    busy: false,
    dead: false,
    target: null,
    hasPoint: true,
  }
  eq('a legal ground cast passes', checkCast(base), 'ok')
  eq('an unlearned ability is locked', checkCast({ ...base, rank: 0 }), 'locked')
  eq('a cooling ability is refused', checkCast({ ...base, readyAt: 1001 }), 'cooldown')
  eq('a cooldown that has just elapsed passes', checkCast({ ...base, readyAt: 1000 }), 'ok')
  eq('too little resource is refused', checkCast({ ...base, resource: 29 }), 'resource')
  eq('exactly enough resource passes', checkCast({ ...base, resource: 30 }), 'ok')
  eq('a free ability passes at zero resource', checkCast({ ...base, cost: 0, resource: 0 }), 'ok')
  eq('mid-cast presses are busy', checkCast({ ...base, busy: true }), 'busy')
  eq('a dead caster is refused', checkCast({ ...base, dead: true }), 'dead')
  eq('death outranks every other reason', checkCast({ ...base, dead: true, rank: 0, resource: 0 }), 'dead')
  eq('a ground cast with no point is refused', checkCast({ ...base, hasPoint: false }), 'noTarget')
  eq('a self cast needs no point', checkCast({ ...base, targeting: 'self', hasPoint: false }), 'ok')

  const unit: CastInput = { ...base, targeting: 'unit', hasPoint: false }
  eq('a unit cast with no target is refused', checkCast(unit), 'noTarget')
  eq('a unit cast out of range is refused', checkCast({ ...unit, target: { distance: 12.1, visible: true } }), 'range')
  eq('a unit cast at exactly max range passes', checkCast({ ...unit, target: { distance: 12, visible: true } }), 'ok')
  eq('a unit cast through a wall is refused', checkCast({ ...unit, target: { distance: 4, visible: false } }), 'blocked')
  eq('a legal unit cast passes', checkCast({ ...unit, target: { distance: 4, visible: true } }), 'ok')

  // Locked outranks cooldown and cost, so the HUD never tells a player to wait
  // for an ability they have not learned.
  eq('locked outranks cooldown', checkCast({ ...base, rank: 0, readyAt: 9999, resource: 0 }), 'locked')
})

/* ------------------------------------------------------------------ *
 * 3. Kit data integrity and differentiation
 * ------------------------------------------------------------------ */
group('kits: data integrity', () => {
  const roster = Object.keys(kits)
  eq('the roster is the four playable wizards', roster.sort(), ['BRAMBLE', 'CINDER', 'MOTH', 'ORBIT'])

  const ids = new Set<string>()
  const icons = new Set<string>()
  for (const kit of Object.values(kits)) {
    check(`${kit.id} has a basic attack icon`, hasIcon(kit.basic.icon), kit.basic.icon)
    check(`${kit.id} has a passive icon`, hasIcon(kit.passive.icon), kit.passive.icon)
    icons.add(kit.basic.icon)
    icons.add(kit.passive.icon)
    check(`${kit.id} basic attack has reach`, kit.basic.range > 0)
    check(`${kit.id} ranged basics have a travel speed`, kit.basic.kind !== 'projectile' || kit.basic.projectileSpeed > 0)
    check(`${kit.id} basic attack has a windup`, kit.basic.windup > 0)

    for (const slot of SLOTS) {
      const def = kit.abilities[slot]
      const ranks = maxRank(slot)
      const label = `${kit.id} ${slot} (${def.name})`
      eq(`${label} sits in its own slot`, def.slot, slot)
      check(`${label} has a unique id`, !ids.has(def.id), def.id)
      ids.add(def.id)
      check(`${label} has a real icon`, hasIcon(def.icon), def.icon)
      icons.add(def.icon)
      eq(`${label} has one cost per rank`, def.cost.length, ranks)
      eq(`${label} has one cooldown per rank`, def.cooldown.length, ranks)
      check(`${label} costs something`, def.cost.every(c => c >= 0))
      check(`${label} cools down`, def.cooldown.every(c => c > 0))
      check(`${label} has a windup`, def.windup >= 0)
      check(`${label} reaches somewhere`, def.targeting === 'self' || def.range > 0)

      for (const [key, values] of Object.entries(def.scale)) {
        eq(`${label} scale "${key}" has one value per rank`, values.length, ranks)
        check(`${label} scale "${key}" improves or holds with rank`, values.every((v, i) => i === 0 || v >= values[i - 1]) || values.every((v, i) => i === 0 || v <= values[i - 1]), values.join(','))
      }

      // Rank 0 previews rank 1 so a locked tooltip still says what it buys.
      eq(`${label} previews rank 1 while unlearned`, abilityCost(def, 0), def.cost[0])
      eq(`${label} costs its top rank at max`, abilityCost(def, ranks), def.cost[ranks - 1])
      eq(`${label} clamps beyond max rank`, abilityCooldown(def, ranks + 9), def.cooldown[ranks - 1])
      check(`${label} resolves every scale key`, Object.keys(resolveScale(def, 1)).length === Object.keys(def.scale).length)
      check(`${label} has a description`, def.detail(resolveScale(def, 1)).length > 12)
    }
  }
  check('every icon in the kits is distinct', icons.size === 24, `${icons.size} distinct icons`)
  eq('there are 16 distinct abilities', ids.size, 16)
})

group('kits: characters are mechanically different', () => {
  const list = Object.values(kits)
  const elements = new Set(list.map(k => k.element))
  eq('each wizard owns an element', elements.size, 4)
  const resources = new Set(list.map(k => k.resource.name))
  eq('each wizard has its own resource', resources.size, 4)
  const basics = new Set(list.map(k => k.basic.name))
  eq('each wizard has its own basic attack', basics.size, 4)
  check('at least one wizard fights in melee', list.some(k => k.basic.kind === 'melee'))
  check('at least one wizard fights at range', list.some(k => k.basic.kind === 'projectile'))

  const ranges = list.map(k => k.basic.range)
  check('basic attack ranges differ', new Set(ranges).size === 4, ranges.join(','))
  const rates = list.map(k => k.basic.rate)
  check('attack speeds differ', new Set(rates).size === 4, rates.join(','))
  const hp = list.map(k => k.stats.hp)
  check('health pools differ', new Set(hp).size === 4, hp.join(','))

  // The targeting mix is the clearest proof two kits do not play the same.
  const signatures = list.map(k => `${k.id}:${SLOTS.map(s => k.abilities[s].targeting).join('/')}`)
  const modes = list.map(k => SLOTS.map(s => k.abilities[s].targeting).join('/'))
  check('no two wizards share a targeting layout', new Set(modes).size === 4, signatures.join(' | '))
  // Mobility is a deliberate dividing line, not a universal: Bramble is the
  // rooted zone-holder and pays for its sustain by being slow.
  const mobile = list.filter(k => SLOTS.some(s => ['dash', 'self'].includes(k.abilities[s].targeting) || /dash|blink|step|anchor/i.test(k.abilities[s].id)))
  check('some wizards have a movement ability', mobile.length >= 2, mobile.map(k => k.id).join(','))
  check('not every wizard has one', mobile.length < 4, mobile.map(k => k.id).join(','))
})

group('kits: level growth changes real numbers', () => {
  for (const kit of Object.values(kits)) {
    const hp1 = maxHpAt(kit, 1)
    const hp15 = maxHpAt(kit, MAX_LEVEL)
    check(`${kit.id} gains health with level`, hp15 > hp1 * 1.5, `${hp1} → ${hp15}`)
    check(`${kit.id} gains resource with level`, maxResourceAt(kit, MAX_LEVEL) > maxResourceAt(kit, 1))
    check(`${kit.id} gains basic damage with level`, basicDamageAt(kit, MAX_LEVEL) > basicDamageAt(kit, 1) * 1.5)
    check(`${kit.id} attacks faster with level`, attackRateAt(kit, MAX_LEVEL) > attackRateAt(kit, 1))
    eq(`${kit.id} level 1 health matches its base`, hp1, kit.stats.hp)

    // Rank-ups have to move a real number, whether that is the payload, the
    // cost or the cooldown. A rank that changes nothing is a wasted point.
    for (const slot of SLOTS) {
      const def = kit.abilities[slot]
      const top = maxRank(slot)
      const payload = Object.keys(def.scale).some(key => rankValue(def.scale[key], top) !== rankValue(def.scale[key], 1))
      const timing = abilityCooldown(def, top) !== abilityCooldown(def, 1) || abilityCost(def, top) !== abilityCost(def, 1)
      check(`${kit.id} ${slot} (${def.name}) improves between rank 1 and max`, payload || timing)
    }
  }
})

group('xp rewards', () => {
  check('every huntable species pays xp', ['CHICKEN', 'REINDEER', 'BEAR'].every(s => (XP_PER_SPECIES[s] ?? 0) > 0))
  check('tougher animals pay more', XP_PER_SPECIES.CHICKEN < XP_PER_SPECIES.REINDEER && XP_PER_SPECIES.REINDEER < XP_PER_SPECIES.BEAR)
  // A level-1 character should not vault to 15 off one chicken.
  const p = emptyProgress()
  applyXp(p, XP_PER_SPECIES.CHICKEN)
  check('one chicken is not a level', p.level === 1, `reached ${p.level}`)
  const q = emptyProgress()
  applyXp(q, XP_PER_SPECIES.BEAR)
  check('one bear is worth at least a level', q.level > 1, `reached ${q.level}`)
})

/**
 * Stand a character on open ground with a clear line to one animal, hold that
 * animal still, cast one slot and run the engine for three seconds of game
 * time. Returns the damage the animal took.
 */
function castAtStationaryTarget(wizard: WizardId, slot: AbilitySlot, dt: number) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 400)
  const player = new THREE.Object3D()
  // The rig parents the muzzle to the character's body, and that offset is
  // exactly what these checks are about, so the stand-in needs a body too.
  player.add(new THREE.Object3D())
  scene.add(player)
  const wildlife = createWildlife(scene, { onKill: () => {}, onPlayerDamage: () => {} })
  const nav = createNavGrid()
  const vitals = { hp: 200, maxHp: 200, heal: () => {}, damage: () => false }
  const battle = createBattle({ scene, camera, player, wizard, wildlife, nav, vitals })

  // Level up so every slot is available, and cast without an aim step.
  for (let i = 0; i < 40 && battle.progress.level < 15; i++) battle.awardXp(4000)
  for (let i = 0; i < 20; i++) for (const s of SLOTS) battle.upgrade(s)
  battle.setQuickCast(true)
  battle.debugFill()

  // A target on open ground with somewhere clear to shoot from.
  let target = null as ReturnType<typeof wildlife.animalsIn>[number] | null
  let spot: { x: number; z: number } | null = null
  for (const animal of wildlife.animalsIn(new THREE.Vector3(0, 0, 0), 4000)) {
    if (animal.state === 'dead') continue
    const at = animal.group.position
    if (nav.blocked(at.x, at.z)) continue
    for (let a = 0; a < 24 && !spot; a++) {
      const angle = (a / 24) * Math.PI * 2
      const candidate = { x: at.x + Math.cos(angle) * 6, z: at.z + Math.sin(angle) * 6 }
      if (nav.blocked(candidate.x, candidate.z)) continue
      if (!nav.lineOfSight(candidate.x, candidate.z, at.x, at.z, 0.15, SHOT_CLEARANCE)) continue
      spot = candidate
    }
    if (spot) { target = animal; break }
  }
  if (!target || !spot) {
    failures.push(`${wizard} ${slot}: no clear firing position anywhere in the world`)
    wildlife.dispose()
    battle.dispose()
    return 0
  }

  player.position.set(spot.x, 0, spot.z)
  const anchor = target.group.position.clone()
  const hp = target.hp
  let now = 1000
  const ctx = { cursorGround: anchor.clone(), hover: target, manualMove: false, safe: false, paused: false }
  battle.update(dt, now, ctx)
  battle.pressSlot(slot, { cursorGround: anchor.clone(), hover: target })
  for (let i = 0; i < Math.ceil(3 / dt); i++) {
    now += dt * 1000
    // Hold the quarry still: this measures the ability, not the player's lead.
    target.group.position.set(anchor.x, target.group.position.y, anchor.z)
    battle.update(dt, now, ctx)
  }
  const dealt = hp - target.hp
  wildlife.dispose()
  battle.dispose()
  return dealt
}

/* ------------------------------------------------------------------ *
 * 4. A kill pays out exactly once
 * ------------------------------------------------------------------ */
group('enemy death rewards land once', () => {
  const scene = new THREE.Scene()
  const kills: string[] = []
  const wildlife = createWildlife(scene, {
    onKill: kill => kills.push(`${kill.species}:${kill.label}`),
    onPlayerDamage: () => {},
  })
  const now = 1000

  // Work on the live population rather than a fake: this is the same object
  // the engine damages in the running game.
  const world = new THREE.Vector3(0, 0, 0)
  const population = wildlife.animalsIn(world, 4000)
  check('the world spawns wildlife to fight', population.length > 1, `${population.length} animals`)
  const target = population[0] ?? null
  if (!target) {
    failures.push('could not find a spawned animal to test against')
  } else {
    const overkill = target.species.maxHp * 10
    const first = wildlife.hurt(target, overkill, now, {})
    eq('the fatal blow reports a kill', first.killed, true)
    eq('one kill produced one reward', kills.length, 1)

    // Everything that can arrive late: a second projectile, a burn tick, a
    // chain bounce, an area pulse.
    const second = wildlife.hurt(target, overkill, now + 1, {})
    eq('a late hit on a corpse deals nothing', second.dealt, 0)
    eq('a late hit on a corpse is not a kill', second.killed, false)
    for (let i = 0; i < 20; i++) wildlife.hurt(target, overkill, now + 2 + i, {})
    eq('twenty more hits pay nothing extra', kills.length, 1)

    eq('a corpse is excluded from area queries', wildlife.animalsIn(target.group.position.clone(), 6).includes(target), false)
    check('a corpse cannot be rooted', (() => { wildlife.applyStatus(target, 'root', 2000, now + 5); return target.status.rootUntil <= now })())

    // An area hit covering the corpse pays for the living only, once each.
    const blast = target.group.position.clone()
    const bystanders = wildlife.animalsIn(blast, 30).length
    wildlife.damageIn(blast, 30, overkill, now + 40)
    eq('an area hit pays once per living target and nothing for the corpse', kills.length, 1 + bystanders)
    wildlife.damageIn(blast, 30, overkill, now + 60)
    eq('a repeat area hit over corpses pays nothing', kills.length, 1 + bystanders)

    // Status refresh must not stack into a permanent lock.
    const other = wildlife.animalsIn(new THREE.Vector3(0, 0, 0), 4000).find(a => a !== target)
    if (!other) failures.push('needed a second live animal for the status checks')
    else {
      wildlife.applyStatus(other, 'root', 1000, now)
      const firstRoot = other.status.rootUntil
      wildlife.applyStatus(other, 'root', 1000, now + 100)
      check('re-rooting refreshes rather than adds', other.status.rootUntil - firstRoot <= 101, `${firstRoot} → ${other.status.rootUntil}`)
      wildlife.applyStatus(other, 'root', 200, now + 100)
      eq('a weaker root does not cut a longer one short', other.status.rootUntil, firstRoot + 100)

      wildlife.applyStatus(other, 'slow', 1000, now, 0.5)
      wildlife.applyStatus(other, 'slow', 1000, now + 10, 0.8)
      check('the strongest running slow wins', other.status.slowFactor === 0.5, String(other.status.slowFactor))
      wildlife.applyStatus(other, 'slow', 1000, now + 5000, 0.9)
      check('an expired slow is replaced, not compounded', other.status.slowFactor === 0.9, String(other.status.slowFactor))
      check('slow is never total', other.status.slowFactor > 0)
    }
  }
  wildlife.dispose()
})

/* ------------------------------------------------------------------ *
 * 5. Every damaging ability connects with a clear shot
 * ------------------------------------------------------------------ *
 * Drives the real engine frame by frame against a stationary animal on
 * open ground. A skillshot is allowed to miss a moving target — that is
 * the player's aim — but a bolt fired down a clear line at something
 * standing still must land, whatever the frame rate.
 */
group('every damaging ability connects with a clear shot', () => {
  const damaging = (wizard: WizardId, slot: AbilitySlot) =>
    Array.isArray((kits[wizard].abilities[slot].scale as Record<string, number[] | undefined>).damage)

  for (const wizard of ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT'] as WizardId[]) {
    for (const slot of SLOTS) {
      if (!damaging(wizard, slot)) continue
      // Two frame rates: a clean 60fps and the 20fps the engine clamps to.
      for (const dt of [1 / 60, 1 / 20]) {
        const dealt = castAtStationaryTarget(wizard, slot, dt)
        check(
          `${wizard} ${slot} (${kits[wizard].abilities[slot].name}) lands damage at ${Math.round(1 / dt)}fps`,
          dealt > 0,
          `dealt ${dealt.toFixed(1)}`,
        )
      }
    }
  }
})

console.log('')
if (failures.length) {
  console.log(`${passed} checks passed, ${failures.length} FAILED:`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(1)
}
console.log(`${passed} checks passed.`)
