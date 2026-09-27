import type { WizardId } from './characters'
import type { SpeciesId, ThreatTier } from './wildlife'

/* ------------------------------------------------------------------ *
 * A single mutable snapshot shared between the render loop and the HUD.
 *
 * The loop writes every frame; React must not. Fast-moving fields
 * (health, cooldown, compass) are read by the HUD on its own animation
 * frame and written straight to DOM refs. Discrete changes (a new
 * target, a death, a kill) call `pingHunt()` and re-render.
 * ------------------------------------------------------------------ */

export type HuntTarget = {
  species: SpeciesId
  label: string
  threat: ThreatTier
  hp: number
  maxHp: number
  goldBaseUnits: number
  distance: number
}

export type DeathNotice = {
  killer: string
  goldDroppedBaseUnits: number
  at: number
}

export type HuntState = {
  hp: number
  maxHp: number
  safe: boolean
  invulnerable: boolean
  inCombat: boolean
  hurtAt: number
  cooldownRatio: number
  abilityId: WizardId
  target: HuntTarget | null
  /** Metres to the current hunt destination, and its bearing relative to the camera. */
  compassDistance: number
  compassDegrees: number
  compassLabel: string
  kills: number
  aggro: number
  death: DeathNotice | null
  active: boolean
}

export const huntState: HuntState = {
  hp: 100,
  maxHp: 100,
  safe: true,
  invulnerable: false,
  inCombat: false,
  hurtAt: 0,
  cooldownRatio: 0,
  abilityId: 'MOTH',
  target: null,
  compassDistance: 0,
  compassDegrees: 0,
  compassLabel: 'THE WILDWOOD',
  kills: 0,
  aggro: 0,
  death: null,
  active: false,
}

const listeners = new Set<() => void>()

export function subscribeHunt(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function pingHunt() {
  listeners.forEach(listener => listener())
}

export function resetHuntState(abilityId: WizardId, maxHp: number) {
  huntState.hp = maxHp
  huntState.maxHp = maxHp
  huntState.abilityId = abilityId
  huntState.target = null
  huntState.death = null
  huntState.kills = 0
  huntState.aggro = 0
  huntState.cooldownRatio = 0
  huntState.active = true
  pingHunt()
}
