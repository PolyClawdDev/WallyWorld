import type { WizardId } from '../characters'
import type { AbilitySlot } from './progression'

/* ------------------------------------------------------------------ *
 * The bridge between the combat engine and the combat HUD.
 *
 * Same contract as huntStore: one mutable snapshot, written by the
 * render loop, read by the HUD on its own animation frame. Only shape
 * changes (a rank bought, a level gained, an aim started) ping React.
 *
 * The HUD never mutates gameplay state. It asks through `commands`,
 * which the engine registers, so resource spend, cooldowns and ability
 * points can only ever be applied in one place.
 * ------------------------------------------------------------------ */

export type SlotState =
  | 'locked'
  | 'ready'
  | 'cooldown'
  | 'noResource'
  | 'casting'
  | 'aiming'
  | 'active'

export type SlotView = {
  slot: AbilitySlot
  id: string
  name: string
  icon: string
  short: string
  detail: string
  rank: number
  maxRank: number
  /** Character level at which the next rank becomes legal; 0 when maxed. */
  nextRankLevel: number
  cost: number
  cooldown: number
  /** Seconds left, written every frame. */
  remaining: number
  state: SlotState
  upgradable: boolean
  range: number
}

export type BattleTarget = {
  label: string
  hp: number
  maxHp: number
  distance: number
  inRange: boolean
}

export type BattleNotice = { text: string; kind: 'level' | 'point' | 'warn'; at: number }

export type BattleState = {
  active: boolean
  wizard: WizardId
  identity: string
  color: string
  accent: string
  level: number
  maxed: boolean
  xp: number
  xpNeeded: number
  points: number
  hp: number
  maxHp: number
  resource: number
  maxResource: number
  resourceName: string
  resourceShort: string
  resourceColor: string
  basicName: string
  basicIcon: string
  basicBlurb: string
  passiveName: string
  passiveIcon: string
  passiveBlurb: string
  passiveDetail: string
  /** Fraction 0..1 of the passive's own charge, where the passive has one. */
  passiveCharge: number
  passiveLabel: string
  slots: Record<AbilitySlot, SlotView>
  aiming: AbilitySlot | null
  quickCast: boolean
  order: 'idle' | 'move' | 'attack' | 'attackMove' | 'attackMovePending'
  target: BattleTarget | null
  notice: BattleNotice | null
  /** Bumped on level-up so the HUD can flash without a modal. */
  levelPulse: number
}

function blankSlot(slot: AbilitySlot): SlotView {
  return {
    slot,
    id: '',
    name: '',
    icon: '',
    short: '',
    detail: '',
    rank: 0,
    maxRank: slot === 'R' ? 3 : 4,
    nextRankLevel: 1,
    cost: 0,
    cooldown: 0,
    remaining: 0,
    state: 'locked',
    upgradable: false,
    range: 0,
  }
}

export const battleState: BattleState = {
  active: false,
  wizard: 'MOTH',
  identity: '',
  color: '#d5a64b',
  accent: '#fff0c4',
  level: 1,
  maxed: false,
  xp: 0,
  xpNeeded: 1,
  points: 0,
  hp: 100,
  maxHp: 100,
  resource: 100,
  maxResource: 100,
  resourceName: 'MANA',
  resourceShort: 'MP',
  resourceColor: '#7bc9ce',
  basicName: '',
  basicIcon: '',
  basicBlurb: '',
  passiveName: '',
  passiveIcon: '',
  passiveBlurb: '',
  passiveDetail: '',
  passiveCharge: 0,
  passiveLabel: '',
  slots: { Q: blankSlot('Q'), W: blankSlot('W'), E: blankSlot('E'), R: blankSlot('R') },
  aiming: null,
  quickCast: false,
  order: 'idle',
  target: null,
  notice: null,
  levelPulse: 0,
}

const listeners = new Set<() => void>()

export function subscribeBattle(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function pingBattle() {
  listeners.forEach(listener => listener())
}

/* ----------------------------- commands ----------------------------- */

export type BattleCommands = {
  /** Spends one ability point. Returns false when the rules forbid it. */
  upgrade: (slot: AbilitySlot) => boolean
  setQuickCast: (on: boolean) => void
  cancelAim: () => void
}

let commands: BattleCommands | null = null

export function registerBattleCommands(next: BattleCommands) {
  commands = next
  return () => {
    if (commands === next) commands = null
  }
}

export function requestUpgrade(slot: AbilitySlot) {
  return commands?.upgrade(slot) ?? false
}

export function requestQuickCast(on: boolean) {
  commands?.setQuickCast(on)
}

export function requestCancelAim() {
  commands?.cancelAim()
}

/** True while the world wants Escape for itself (cancel an aim or an order). */
export function battleWantsEscape() {
  return battleState.active && (battleState.aiming !== null || battleState.order !== 'idle')
}

/*
 * Escape is shared: the world cancels targeting first and the menu opens only
 * when there was nothing to cancel. Both handlers sit on `window`, so the
 * world marks the key as spent and the menu checks that mark rather than
 * trying to re-derive the state it has just cleared.
 */
let escapeConsumedAt = -1e9

export function markEscapeConsumed() {
  escapeConsumedAt = performance.now()
}

export function escapeWasConsumed() {
  return performance.now() - escapeConsumedAt < 80
}

export function showNotice(text: string, kind: BattleNotice['kind']) {
  battleState.notice = { text, kind, at: performance.now() }
  pingBattle()
}
