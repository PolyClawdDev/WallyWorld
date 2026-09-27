/* ------------------------------------------------------------------ *
 * Combat numbers for authoritative PvP.
 *
 * Copied from `battle/kits.ts` so the server never imports Three.js /
 * wildlife. Tests assert HP, basic damage, and one ability per kit still
 * match the live kit tables.
 * ------------------------------------------------------------------ */

import type { WizardId } from './pvp'
import type { AbilitySlot } from '../battle/progression'

export type PvpAbility = {
  id: string
  name: string
  targeting: 'skillshot' | 'point' | 'unit' | 'self' | 'dash' | 'channel'
  range: number
  radius: number
  cost: number[]
  cooldown: number[]
  windup: number
  recovery: number
  scale: Record<string, number[]>
}

export type PvpKit = {
  id: WizardId
  color: string
  stats: { hp: number; hpPerLevel: number; damage: number; damagePerLevel: number; moveSpeed: number; runSpeed: number }
  resource: { name: string; base: number; perLevel: number; regen: number; regenPerLevel: number }
  basic: { kind: 'projectile' | 'melee'; range: number; rate: number; ratePerLevel: number; windup: number; recovery: number; projectileSpeed: number }
  abilities: Record<AbilitySlot, PvpAbility>
}

function rankValue(values: number[], rank: number) {
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.max(0, rank - 1))]
}

export function pvpRankValue(values: number[], rank: number) {
  return rankValue(values, rank)
}

export function pvpMaxHp(kit: PvpKit, level: number) {
  return Math.round(kit.stats.hp + kit.stats.hpPerLevel * (level - 1))
}

export function pvpMaxResource(kit: PvpKit, level: number) {
  return Math.round(kit.resource.base + kit.resource.perLevel * (level - 1))
}

export function pvpRegen(kit: PvpKit, level: number) {
  return kit.resource.regen + kit.resource.regenPerLevel * (level - 1)
}

export function pvpBasicDamage(kit: PvpKit, level: number) {
  return Math.round(kit.stats.damage + kit.stats.damagePerLevel * (level - 1))
}

export function pvpAttackRate(kit: PvpKit, level: number) {
  return kit.basic.rate + kit.basic.ratePerLevel * (level - 1)
}

export const PVP_KITS: Record<WizardId, PvpKit> = {
  CINDER: {
    id: 'CINDER',
    color: '#e35e35',
    stats: { hp: 98, hpPerLevel: 13, damage: 11, damagePerLevel: 1.7, moveSpeed: 3.2, runSpeed: 5.6 },
    resource: { name: 'EMBER', base: 100, perLevel: 8, regen: 5, regenPerLevel: 0.3 },
    basic: { kind: 'projectile', range: 17, rate: 0.82, ratePerLevel: 0.028, windup: 0.22, recovery: 0.1, projectileSpeed: 30 },
    abilities: {
      Q: { id: 'cinder.lance', name: 'Ember Lance', targeting: 'skillshot', range: 20, radius: 2.8, cost: [40, 45, 50, 55], cooldown: [6, 5.5, 5, 4.5], windup: 0.24, recovery: 0.12, scale: { damage: [55, 85, 115, 145] } },
      W: { id: 'cinder.bloom', name: 'Cinder Bloom', targeting: 'point', range: 15, radius: 3.4, cost: [55, 60, 65, 70], cooldown: [12, 11, 10, 9], windup: 0.3, recovery: 0.16, scale: { damage: [50, 80, 110, 140], burn: [8, 12, 16, 20] } },
      E: { id: 'cinder.flashstep', name: 'Flashstep', targeting: 'dash', range: 7.5, radius: 1.6, cost: [35, 35, 35, 35], cooldown: [14, 12.5, 11, 9.5], windup: 0.06, recovery: 0.1, scale: { damage: [30, 45, 60, 75] } },
      R: { id: 'cinder.meteor', name: 'Meteor', targeting: 'point', range: 22, radius: 5.5, cost: [100, 110, 120], cooldown: [90, 80, 70], windup: 0.45, recovery: 0.3, scale: { damage: [220, 330, 440] } },
    },
  },
  BRAMBLE: {
    id: 'BRAMBLE',
    color: '#9ca66d',
    stats: { hp: 126, hpPerLevel: 18, damage: 10, damagePerLevel: 1.4, moveSpeed: 3.1, runSpeed: 5.3 },
    resource: { name: 'SAP', base: 110, perLevel: 9, regen: 6, regenPerLevel: 0.35 },
    basic: { kind: 'projectile', range: 15, rate: 0.76, ratePerLevel: 0.024, windup: 0.26, recovery: 0.12, projectileSpeed: 26 },
    abilities: {
      Q: { id: 'bramble.snare', name: 'Vine Snare', targeting: 'skillshot', range: 17, radius: 1.2, cost: [45, 45, 50, 50], cooldown: [11, 10, 9, 8], windup: 0.28, recovery: 0.14, scale: { damage: [40, 65, 90, 115], root: [1, 1.25, 1.5, 1.75] } },
      W: { id: 'bramble.wellspring', name: 'Wellspring', targeting: 'point', range: 12, radius: 4.5, cost: [60, 60, 65, 65], cooldown: [16, 15, 14, 13], windup: 0.3, recovery: 0.16, scale: { rate: [10, 16, 22, 28], total: [70, 110, 150, 190] } },
      E: { id: 'bramble.sentinel', name: 'Bramble Sentinel', targeting: 'point', range: 10, radius: 7, cost: [55, 55, 60, 60], cooldown: [18, 17, 16, 15], windup: 0.34, recovery: 0.18, scale: { damage: [16, 24, 32, 40], life: [12, 12, 12, 14] } },
      R: { id: 'bramble.overgrowth', name: 'Overgrowth', targeting: 'point', range: 16, radius: 7, cost: [100, 110, 120], cooldown: [100, 90, 80], windup: 0.5, recovery: 0.3, scale: { damage: [28, 42, 56], heal: [18, 26, 34], slow: [40, 45, 50] } },
    },
  },
  ORBIT: {
    id: 'ORBIT',
    color: '#7bc9ce',
    stats: { hp: 90, hpPerLevel: 11, damage: 8, damagePerLevel: 1.2, moveSpeed: 3.4, runSpeed: 5.9 },
    resource: { name: 'CHARGE', base: 80, perLevel: 6, regen: 9, regenPerLevel: 0.5 },
    basic: { kind: 'projectile', range: 16, rate: 1.45, ratePerLevel: 0.05, windup: 0.1, recovery: 0.06, projectileSpeed: 46 },
    abilities: {
      Q: { id: 'orbit.chain', name: 'Chain Lightning', targeting: 'unit', range: 16, radius: 7, cost: [40, 45, 50, 55], cooldown: [7, 6.5, 6, 5.5], windup: 0.18, recovery: 0.1, scale: { damage: [45, 70, 95, 120] } },
      W: { id: 'orbit.stormcell', name: 'Storm Cell', targeting: 'point', range: 18, radius: 4.2, cost: [55, 55, 60, 60], cooldown: [13, 12, 11, 10], windup: 0.26, recovery: 0.14, scale: { damage: [14, 21, 28, 35], duration: [4, 4, 4.5, 4.5] } },
      E: { id: 'orbit.blink', name: 'Blink', targeting: 'point', range: 9, radius: 0, cost: [40, 40, 40, 40], cooldown: [16, 14, 12, 10], windup: 0.05, recovery: 0.08, scale: { distance: [9, 9, 9, 9] } },
      R: { id: 'orbit.starfall', name: 'Starfall Beam', targeting: 'channel', range: 18, radius: 1.4, cost: [80, 90, 100], cooldown: [85, 75, 65], windup: 0.35, recovery: 0.35, scale: { dps: [140, 200, 260], duration: [3, 3, 3] } },
    },
  },
  MOTH: {
    id: 'MOTH',
    color: '#f0b84d',
    stats: { hp: 112, hpPerLevel: 15, damage: 14, damagePerLevel: 2, moveSpeed: 3.3, runSpeed: 5.7 },
    resource: { name: 'LUMEN', base: 90, perLevel: 7, regen: 5.5, regenPerLevel: 0.3 },
    basic: { kind: 'melee', range: 3.6, rate: 0.95, ratePerLevel: 0.03, windup: 0.2, recovery: 0.14, projectileSpeed: 0 },
    abilities: {
      Q: { id: 'moth.glaive', name: 'Lantern Glaive', targeting: 'skillshot', range: 13, radius: 1.2, cost: [45, 45, 50, 50], cooldown: [9, 8.5, 8, 7.5], windup: 0.22, recovery: 0.12, scale: { damage: [50, 75, 100, 125] } },
      W: { id: 'moth.mark', name: 'Moth Mark', targeting: 'unit', range: 11, radius: 0, cost: [50, 50, 55, 55], cooldown: [14, 13, 12, 11], windup: 0.2, recovery: 0.1, scale: { share: [30, 40, 50, 60], cap: [90, 140, 190, 240] } },
      E: { id: 'moth.anchor', name: 'Lantern Anchor', targeting: 'self', range: 0, radius: 0, cost: [30, 30, 30, 30], cooldown: [18, 16, 14, 12], windup: 0.08, recovery: 0.06, scale: { window: [6, 6, 7, 7] } },
      R: { id: 'moth.lightfall', name: 'Lightfall', targeting: 'unit', range: 12, radius: 2.2, cost: [100, 100, 100], cooldown: [80, 70, 60], windup: 0.4, recovery: 0.3, scale: { damage: [200, 300, 400], execute: [40, 60, 80] } },
    },
  },
}
