import type { Targeting } from './kits'

/* ------------------------------------------------------------------ *
 * Cast legality, as a pure function.
 *
 * The engine calls this and nothing else before spending a resource or
 * starting a cooldown, so "an invalid cast must not cost anything" is a
 * property of one testable predicate rather than of a scattering of
 * early returns.
 * ------------------------------------------------------------------ */

export type CastCheck = 'ok' | 'dead' | 'locked' | 'cooldown' | 'busy' | 'resource' | 'noTarget' | 'range' | 'blocked'

export type CastInput = {
  /** 0 means the ability has not been learned. */
  rank: number
  now: number
  readyAt: number
  resource: number
  cost: number
  targeting: Targeting
  range: number
  /** True while a cast, channel or recovery is running. */
  busy: boolean
  dead: boolean
  /** Unit casts only. */
  target: { distance: number; visible: boolean } | null
  /** Ground and skillshot casts only. */
  hasPoint: boolean
}

/**
 * Order matters: the most specific reason the player can act on is returned
 * first, so the HUD's refusal message is the one that helps.
 */
export function checkCast(input: CastInput): CastCheck {
  if (input.dead) return 'dead'
  if (input.rank < 1) return 'locked'
  if (input.now < input.readyAt) return 'cooldown'
  if (input.busy) return 'busy'
  if (input.resource < input.cost) return 'resource'
  if (input.targeting === 'unit') {
    if (!input.target) return 'noTarget'
    if (input.target.distance > input.range) return 'range'
    if (!input.target.visible) return 'blocked'
  }
  if (input.targeting !== 'unit' && input.targeting !== 'self' && !input.hasPoint) return 'noTarget'
  return 'ok'
}

export const castFailureMessages: Record<Exclude<CastCheck, 'ok' | 'busy'>, string> = {
  dead: 'You are down',
  locked: 'Not learned',
  cooldown: 'Still cooling',
  resource: 'Not enough resource',
  noTarget: 'No valid target',
  range: 'Target out of reach',
  blocked: 'No clear line to the target',
}
