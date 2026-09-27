import type { WizardId } from '../characters'
import { speciesSpecs } from '../wildlife'
import type { SoundId } from './audio'
import type { AbilitySlot } from './progression'

/* ------------------------------------------------------------------ *
 * Character kits, as data.
 *
 * Nothing in this file executes: it describes what each ability costs,
 * how it is aimed, how long it takes, what it scales into at each rank,
 * and which shared behaviour in engine.ts runs it. Adding a character
 * means adding an entry here plus, if it needs one, a bespoke branch in
 * the engine's ability registry.
 *
 * The four wayfinders were given deliberately different shapes rather
 * than four recoloured bolts:
 *   CINDER  fire     burst and area denial, everything leaves a burn
 *   BRAMBLE nature   sustain and zoning, the only summoner and healer
 *   ORBIT   storm    fastest attacks, chaining, a blink, a channel
 *   MOTH    lantern  shortest range, mark-and-detonate burst, recall
 * ------------------------------------------------------------------ */

export type Element = 'fire' | 'nature' | 'storm' | 'light'

/** How the player points an ability, and therefore what preview is drawn. */
export type Targeting =
  /** Aimed line from the caster toward the cursor. */
  | 'skillshot'
  /** Circle placed on the ground inside range. */
  | 'point'
  /** Requires a living enemy under the cursor or already selected. */
  | 'unit'
  /** Fires immediately from the caster, no aiming step. */
  | 'self'
  /** Aimed line, but the caster travels it. */
  | 'dash'
  /** Held beam re-aimed at the cursor until interrupted. */
  | 'channel'

export type AnimKind = 'thrust' | 'raise' | 'sweep' | 'slam' | 'dash' | 'channel' | 'melee'

export type AbilityDef = {
  slot: AbilitySlot
  /** Stable identifier, also the key into the engine's behaviour registry. */
  id: string
  name: string
  icon: string
  targeting: Targeting
  /** Maximum reach in metres. Zero for self-cast. */
  range: number
  /** Effect radius where one applies. */
  radius: number
  /** Resource cost per rank. */
  cost: number[]
  /** Cooldown in seconds per rank. */
  cooldown: number[]
  /** Seconds of cast motion before the effect leaves the caster. */
  windup: number
  /** Seconds after release during which no other action starts. */
  recovery: number
  anim: AnimKind
  sound: SoundId
  /** Per-rank numbers, keyed so the tooltip and the engine read the same values. */
  scale: Record<string, number[]>
  /** One line of identity, shown under the name. */
  short: string
  /** Full description; `v` holds this rank's resolved `scale` values. */
  detail: (v: Record<string, number>) => string
}

export type BasicAttackDef = {
  name: string
  icon: string
  kind: 'projectile' | 'melee'
  range: number
  /** Attacks per second at level 1. */
  rate: number
  ratePerLevel: number
  /** Seconds from committing to the swing until damage or projectile release. */
  windup: number
  recovery: number
  projectileSpeed: number
  anim: AnimKind
  sound: SoundId
  blurb: string
}

export type PassiveDef = {
  name: string
  icon: string
  blurb: string
  detail: string
}

export type ResourceDef = {
  name: string
  short: string
  color: string
  base: number
  perLevel: number
  /** Regeneration per second at level 1. */
  regen: number
  regenPerLevel: number
}

export type CharacterKit = {
  id: WizardId
  element: Element
  identity: string
  role: string
  color: string
  accent: string
  stats: {
    hp: number
    hpPerLevel: number
    /** Basic-attack damage at level 1. */
    damage: number
    damagePerLevel: number
    moveSpeed: number
    runSpeed: number
  }
  resource: ResourceDef
  basic: BasicAttackDef
  passive: PassiveDef
  abilities: Record<AbilitySlot, AbilityDef>
}

/** Rank 0 (unlearned) previews rank 1 so tooltips can show what learning it buys. */
export function rankValue(values: number[], rank: number) {
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.max(0, rank - 1))]
}

export function resolveScale(def: AbilityDef, rank: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, values] of Object.entries(def.scale)) out[key] = rankValue(values, rank)
  return out
}

export function abilityCost(def: AbilityDef, rank: number) {
  return rankValue(def.cost, rank)
}

export function abilityCooldown(def: AbilityDef, rank: number) {
  return rankValue(def.cooldown, rank)
}

/* --------------------------------------------------------------- *
 * CINDER · fire
 * Longest reach of the four, everything it touches keeps burning,
 * and its only escape is also a damage tool. Fragile in melee.
 * --------------------------------------------------------------- */
const cinder: CharacterKit = {
  id: 'CINDER',
  element: 'fire',
  identity: 'Fire · burst and area denial',
  role: 'Firestarter',
  color: '#e35e35',
  accent: '#ffc46a',
  stats: { hp: 98, hpPerLevel: 13, damage: 11, damagePerLevel: 1.7, moveSpeed: 3.2, runSpeed: 5.6 },
  resource: { name: 'EMBER', short: 'EM', color: '#e35e35', base: 100, perLevel: 8, regen: 5, regenPerLevel: 0.3 },
  basic: {
    name: 'Emberbolt',
    icon: 'emberbolt',
    kind: 'projectile',
    range: 17,
    rate: 0.82,
    ratePerLevel: 0.028,
    windup: 0.22,
    recovery: 0.1,
    projectileSpeed: 30,
    anim: 'thrust',
    sound: 'basic.fire',
    blurb: 'A thrown coal that travels. Long reach, slow cadence.',
  },
  passive: {
    name: 'Forge Heat',
    icon: 'forgeheat',
    blurb: 'Everything CINDER hits keeps burning.',
    detail:
      'Damage from CINDER sets a burn dealing 4 (+1 per level) damage per second for 3s. Reapplying refreshes the duration; a target can carry at most 3 stacks.',
  },
  abilities: {
    Q: {
      slot: 'Q',
      id: 'cinder.lance',
      name: 'Ember Lance',
      icon: 'lance',
      targeting: 'skillshot',
      range: 20,
      radius: 2.8,
      cost: [40, 45, 50, 55],
      cooldown: [6, 5.5, 5, 4.5],
      windup: 0.24,
      recovery: 0.12,
      anim: 'thrust',
      sound: 'cast.fire',
      scale: { damage: [55, 85, 115, 145] },
      short: 'Fast fire skillshot, explodes on first contact',
      detail: v =>
        `Hurls a lance of fire that flies until it strikes an enemy, then bursts for ${v.damage} damage in a 2.8m sphere. Sets Forge Heat on everything caught.`,
    },
    W: {
      slot: 'W',
      id: 'cinder.bloom',
      name: 'Cinder Bloom',
      icon: 'bloom',
      targeting: 'point',
      range: 15,
      radius: 3.4,
      cost: [55, 60, 65, 70],
      cooldown: [12, 11, 10, 9],
      windup: 0.3,
      recovery: 0.16,
      anim: 'slam',
      sound: 'cast.fire',
      scale: { damage: [50, 80, 110, 140], burn: [8, 12, 16, 20], telegraph: [0.75, 0.75, 0.75, 0.75] },
      short: 'Telegraphed eruption that leaves a burning ring',
      detail: v =>
        `Marks the ground for 0.75s, then erupts for ${v.damage} damage. The scorched ring burns for a further 3s, dealing ${v.burn} damage per second to anything standing in it.`,
    },
    E: {
      slot: 'E',
      id: 'cinder.flashstep',
      name: 'Flashstep',
      icon: 'flashstep',
      targeting: 'dash',
      range: 7.5,
      radius: 1.6,
      cost: [35, 35, 35, 35],
      cooldown: [14, 12.5, 11, 9.5],
      windup: 0.06,
      recovery: 0.1,
      anim: 'dash',
      sound: 'dash',
      scale: { damage: [30, 45, 60, 75] },
      short: 'Short dash that leaves a burning wake',
      detail: v =>
        `Dashes 7.5m, dealing ${v.damage} damage to anything passed through and leaving a trail of flame that burns for 2s.`,
    },
    R: {
      slot: 'R',
      id: 'cinder.meteor',
      name: 'Meteor',
      icon: 'meteor',
      targeting: 'point',
      range: 22,
      radius: 5.5,
      cost: [100, 110, 120],
      cooldown: [90, 80, 70],
      windup: 0.45,
      recovery: 0.3,
      anim: 'raise',
      sound: 'ultimate',
      scale: { damage: [220, 330, 440], delay: [1.6, 1.6, 1.6] },
      short: 'Delayed meteor into a marked crater',
      detail: v =>
        `Calls a meteor onto a marked 5.5m circle. After 1.6s it lands for ${v.damage} damage and leaves the crater burning. The marker is visible to everything standing in it.`,
    },
  },
}

/* --------------------------------------------------------------- *
 * BRAMBLE · nature
 * The only character that heals, roots and summons. Slowest cadence,
 * highest health, wants to hold one patch of ground rather than duel.
 * --------------------------------------------------------------- */
const bramble: CharacterKit = {
  id: 'BRAMBLE',
  element: 'nature',
  identity: 'Nature · sustain and zone control',
  role: 'Grove tender',
  color: '#9ca66d',
  accent: '#d7e39a',
  stats: { hp: 126, hpPerLevel: 18, damage: 10, damagePerLevel: 1.4, moveSpeed: 3.1, runSpeed: 5.3 },
  resource: { name: 'SAP', short: 'SP', color: '#9ca66d', base: 110, perLevel: 9, regen: 6, regenPerLevel: 0.35 },
  basic: {
    name: 'Thornshot',
    icon: 'thornshot',
    kind: 'projectile',
    range: 15,
    rate: 0.76,
    ratePerLevel: 0.024,
    windup: 0.26,
    recovery: 0.12,
    projectileSpeed: 26,
    anim: 'sweep',
    sound: 'basic.thorn',
    blurb: 'A spitted thorn. Heavy, unhurried, feeds the passive.',
  },
  passive: {
    name: 'Old Roots',
    icon: 'oldroots',
    blurb: 'Steady hits pay BRAMBLE back in health.',
    detail:
      'Every 5th attack or ability that connects heals BRAMBLE for 12 (+3 per level). Cannot trigger more than once every 6s, so chip damage never becomes infinite sustain.',
  },
  abilities: {
    Q: {
      slot: 'Q',
      id: 'bramble.snare',
      name: 'Vine Snare',
      icon: 'snare',
      targeting: 'skillshot',
      range: 17,
      radius: 1.2,
      cost: [45, 45, 50, 50],
      cooldown: [11, 10, 9, 8],
      windup: 0.28,
      recovery: 0.14,
      anim: 'thrust',
      sound: 'cast.nature',
      scale: { damage: [40, 65, 90, 115], root: [1, 1.25, 1.5, 1.75] },
      short: 'Vine that roots the first enemy struck',
      detail: v =>
        `Whips a vine forward. The first enemy hit takes ${v.damage} damage and is rooted for ${v.root}s. A root stops movement; it does not stop an enemy attacking whatever is already in reach.`,
    },
    W: {
      slot: 'W',
      id: 'bramble.wellspring',
      name: 'Wellspring',
      icon: 'wellspring',
      targeting: 'point',
      range: 12,
      radius: 4.5,
      cost: [60, 60, 65, 65],
      cooldown: [16, 15, 14, 13],
      windup: 0.3,
      recovery: 0.16,
      anim: 'raise',
      sound: 'heal',
      scale: { rate: [10, 16, 22, 28], total: [70, 110, 150, 190], duration: [4, 4, 4, 4] },
      short: 'Healing pool with a hard total cap',
      detail: v =>
        `Opens a spring for 4s. Standing in it restores ${v.rate} health per second, up to ${v.total} in total — the pool closes early once that is spent.`,
    },
    E: {
      slot: 'E',
      id: 'bramble.sentinel',
      name: 'Bramble Sentinel',
      icon: 'sentinel',
      targeting: 'point',
      range: 10,
      radius: 7,
      cost: [55, 55, 60, 60],
      cooldown: [18, 17, 16, 15],
      windup: 0.34,
      recovery: 0.18,
      anim: 'slam',
      sound: 'cast.nature',
      scale: { damage: [16, 24, 32, 40], cap: [1, 1, 2, 2], life: [12, 12, 12, 14] },
      short: 'A rooted thorn turret, strictly capped',
      detail: v =>
        `Grows a sentinel that lashes the nearest enemy within 7m every 1.1s for ${v.damage} damage, for ${v.life}s. At most ${v.cap} may stand at once; growing another replaces the oldest.`,
    },
    R: {
      slot: 'R',
      id: 'bramble.overgrowth',
      name: 'Overgrowth',
      icon: 'overgrowth',
      targeting: 'point',
      range: 16,
      radius: 7,
      cost: [100, 110, 120],
      cooldown: [100, 90, 80],
      windup: 0.5,
      recovery: 0.3,
      anim: 'raise',
      sound: 'ultimate',
      scale: { damage: [28, 42, 56], heal: [18, 26, 34], slow: [40, 45, 50], duration: [6, 6, 6] },
      short: 'A grove that mends you and strangles them',
      detail: v =>
        `Raises a 7m grove for 6s. Enemies inside take ${v.damage} damage per second and are slowed by ${v.slow}%. BRAMBLE recovers ${v.heal} health per second while inside — it works alone.`,
    },
  },
}

/* --------------------------------------------------------------- *
 * ORBIT · storm
 * Twice the attack cadence of anyone else, the only chain, the only
 * blink and the only channel. Lowest health; loses any trade it stands still for.
 * --------------------------------------------------------------- */
const orbit: CharacterKit = {
  id: 'ORBIT',
  element: 'storm',
  identity: 'Storm · speed and sustained damage',
  role: 'Navigator',
  color: '#7bc9ce',
  accent: '#c2a6e8',
  stats: { hp: 90, hpPerLevel: 11, damage: 8, damagePerLevel: 1.2, moveSpeed: 3.4, runSpeed: 5.9 },
  resource: { name: 'CHARGE', short: 'CH', color: '#7bc9ce', base: 80, perLevel: 6, regen: 9, regenPerLevel: 0.5 },
  basic: {
    name: 'Starshot',
    icon: 'starshot',
    kind: 'projectile',
    range: 16,
    rate: 1.45,
    ratePerLevel: 0.05,
    windup: 0.1,
    recovery: 0.06,
    projectileSpeed: 46,
    anim: 'thrust',
    sound: 'basic.spark',
    blurb: 'Quick bright shots. Nearly twice anyone else’s cadence.',
  },
  passive: {
    name: 'Resonance',
    icon: 'resonance',
    blurb: 'Every third shot forks to a second enemy.',
    detail:
      'Every 3rd basic attack that connects arcs to one further enemy within 7m for 60% of the damage. The counter only advances on hits, so missing does not bank it.',
  },
  abilities: {
    Q: {
      slot: 'Q',
      id: 'orbit.chain',
      name: 'Chain Lightning',
      icon: 'chain',
      targeting: 'unit',
      range: 16,
      radius: 7,
      cost: [40, 45, 50, 55],
      cooldown: [7, 6.5, 6, 5.5],
      windup: 0.18,
      recovery: 0.1,
      anim: 'thrust',
      sound: 'cast.storm',
      scale: { damage: [45, 70, 95, 120], bounces: [2, 3, 4, 5] },
      short: 'Arc that jumps between separate targets',
      detail: v =>
        `Strikes the target for ${v.damage} damage, then leaps up to ${v.bounces} more times to enemies within 7m. Each leap does 15% less, and no enemy is ever struck twice by the same cast.`,
    },
    W: {
      slot: 'W',
      id: 'orbit.stormcell',
      name: 'Storm Cell',
      icon: 'stormcell',
      targeting: 'point',
      range: 18,
      radius: 4.2,
      cost: [55, 55, 60, 60],
      cooldown: [13, 12, 11, 10],
      windup: 0.26,
      recovery: 0.14,
      anim: 'raise',
      sound: 'cast.storm',
      scale: { damage: [14, 21, 28, 35], duration: [4, 4, 4.5, 4.5] },
      short: 'A charged cloud that keeps discharging',
      detail: v =>
        `Hangs a storm cell over a 4.2m circle for ${v.duration}s. It discharges every 0.6s for ${v.damage} damage to everything beneath it.`,
    },
    E: {
      slot: 'E',
      id: 'orbit.blink',
      name: 'Blink',
      icon: 'blink',
      targeting: 'point',
      range: 9,
      radius: 0,
      cost: [40, 40, 40, 40],
      cooldown: [16, 14, 12, 10],
      windup: 0.05,
      recovery: 0.08,
      anim: 'dash',
      sound: 'dash',
      scale: { distance: [9, 9, 9, 9] },
      short: 'Instant step to a reachable spot',
      detail: () =>
        'Vanishes and reappears up to 9m away. The destination is snapped to the nearest standable ground, so it never lands inside a wall.',
    },
    R: {
      slot: 'R',
      id: 'orbit.starfall',
      name: 'Starfall Beam',
      icon: 'starfall',
      targeting: 'channel',
      range: 18,
      radius: 1.4,
      cost: [80, 90, 100],
      cooldown: [85, 75, 65],
      windup: 0.35,
      recovery: 0.35,
      anim: 'channel',
      sound: 'ultimate',
      scale: { dps: [140, 200, 260], duration: [3, 3, 3], drain: [14, 14, 14] },
      short: 'Aimed beam held until something breaks it',
      detail: v =>
        `Channels a beam for up to 3s, dealing ${v.dps} damage per second along its length and following the cursor. It ends early on a move order, on S or Escape, on being stunned, or when CHARGE runs out.`,
    },
  },
}

/* --------------------------------------------------------------- *
 * MOTH · lantern light
 * Shortest range of the four and the only one that must close. Pays
 * for that with the hardest single burst and two ways back out.
 * --------------------------------------------------------------- */
const moth: CharacterKit = {
  id: 'MOTH',
  element: 'light',
  identity: 'Lantern · precise burst and repositioning',
  role: 'Wayfinder',
  color: '#f0b84d',
  accent: '#fff0c4',
  stats: { hp: 112, hpPerLevel: 15, damage: 14, damagePerLevel: 2, moveSpeed: 3.3, runSpeed: 5.7 },
  resource: { name: 'LUMEN', short: 'LU', color: '#f0b84d', base: 90, perLevel: 7, regen: 5.5, regenPerLevel: 0.3 },
  basic: {
    name: 'Lantern Strike',
    icon: 'lanternstrike',
    kind: 'melee',
    range: 3.6,
    rate: 0.95,
    ratePerLevel: 0.03,
    windup: 0.2,
    recovery: 0.14,
    projectileSpeed: 0,
    anim: 'melee',
    sound: 'basic.lantern',
    blurb: 'Swings the lantern itself. Hardest hit, shortest reach.',
  },
  passive: {
    name: 'Kindled Step',
    icon: 'kindledstep',
    blurb: 'Moving abilities charge the next strike.',
    detail:
      'For 4s after Lantern Anchor moves MOTH, the next basic attack deals 60% extra damage and flares on impact. Cannot trigger more than once every 6s.',
  },
  abilities: {
    Q: {
      slot: 'Q',
      id: 'moth.glaive',
      name: 'Lantern Glaive',
      icon: 'glaive',
      targeting: 'skillshot',
      range: 13,
      radius: 1.2,
      cost: [45, 45, 50, 50],
      cooldown: [9, 8.5, 8, 7.5],
      windup: 0.22,
      recovery: 0.12,
      anim: 'sweep',
      sound: 'cast.light',
      scale: { damage: [50, 75, 100, 125] },
      short: 'Thrown light that hits going out and coming back',
      detail: v =>
        `Throws a disc of lantern light 13m and back. It deals ${v.damage} on the way out and ${Math.round(v.damage * 0.6)} on the return, but never twice to the same enemy on the same leg.`,
    },
    W: {
      slot: 'W',
      id: 'moth.mark',
      name: 'Moth Mark',
      icon: 'mark',
      targeting: 'unit',
      range: 11,
      radius: 0,
      cost: [50, 50, 55, 55],
      cooldown: [14, 13, 12, 11],
      windup: 0.2,
      recovery: 0.1,
      anim: 'thrust',
      sound: 'cast.light',
      scale: { share: [30, 40, 50, 60], cap: [90, 140, 190, 240], duration: [3.5, 3.5, 3.5, 3.5] },
      short: 'Stores a slice of your damage, then detonates it',
      detail: v =>
        `Brands an enemy for 3.5s. ${v.share}% of the damage MOTH deals to it is stored, up to ${v.cap}, and detonates when the mark ends.`,
    },
    E: {
      slot: 'E',
      id: 'moth.anchor',
      name: 'Lantern Anchor',
      icon: 'anchor',
      targeting: 'self',
      range: 0,
      radius: 0,
      cost: [30, 30, 30, 30],
      cooldown: [18, 16, 14, 12],
      windup: 0.08,
      recovery: 0.06,
      anim: 'raise',
      sound: 'cast.light',
      scale: { window: [6, 6, 7, 7] },
      short: 'Leave a light behind, step back to it once',
      detail: v =>
        `Sets an anchor of light where MOTH stands. For the next ${v.window}s, casting again returns MOTH to it and triggers Kindled Step. The cooldown only begins once the anchor is used or expires.`,
    },
    R: {
      slot: 'R',
      id: 'moth.lightfall',
      name: 'Lightfall',
      icon: 'lightfall',
      targeting: 'unit',
      range: 12,
      radius: 2.2,
      cost: [100, 100, 100],
      cooldown: [80, 70, 60],
      windup: 0.4,
      recovery: 0.3,
      anim: 'slam',
      sound: 'ultimate',
      scale: { damage: [200, 300, 400], execute: [40, 60, 80] },
      short: 'Column of light, crueller to the wounded',
      detail: v =>
        `Drops a column of light on one enemy for ${v.damage} damage, plus up to ${v.execute}% more the lower its health — full bonus below 35%.`,
    },
  },
}

export const kits: Record<WizardId, CharacterKit> = {
  MOTH: moth,
  BRAMBLE: bramble,
  CINDER: cinder,
  ORBIT: orbit,
}

export const SLOTS: AbilitySlot[] = ['Q', 'W', 'E', 'R']

/* ------------------------------ growth ------------------------------ */

export function maxHpAt(kit: CharacterKit, level: number) {
  return Math.round(kit.stats.hp + kit.stats.hpPerLevel * (level - 1))
}

export function maxResourceAt(kit: CharacterKit, level: number) {
  return Math.round(kit.resource.base + kit.resource.perLevel * (level - 1))
}

export function resourceRegenAt(kit: CharacterKit, level: number) {
  return kit.resource.regen + kit.resource.regenPerLevel * (level - 1)
}

export function basicDamageAt(kit: CharacterKit, level: number) {
  return Math.round(kit.stats.damage + kit.stats.damagePerLevel * (level - 1))
}

export function attackRateAt(kit: CharacterKit, level: number) {
  return kit.basic.rate + kit.basic.ratePerLevel * (level - 1)
}

/** Unscaled kill XP, mirrored from speciesSpecs so older callers keep working. */
export const XP_PER_SPECIES: Record<string, number> = Object.fromEntries(
  Object.values(speciesSpecs).map(species => [species.id, species.xpBase]),
)
