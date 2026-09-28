import {
  DEMO_GOLD_NOTICE,
  GOLD_KIND,
  type ChallengeView,
  type DuelResultView,
  type DuelSnapshot,
  type GoldView,
  type JournalEntry,
  type PlayerId,
  type PublicCard,
  type PublicPresence,
} from '../shared/pvp'

export type PvpUi = {
  connected: boolean
  signedIn: boolean
  playerId: PlayerId | null
  gold: GoldView
  self: PublicPresence | null
  others: PublicPresence[]
  inspect: PublicCard | null
  composer: PublicCard | null
  invite: ChallengeView | null
  outgoing: ChallengeView | null
  duel: DuelSnapshot | null
  result: DuelResultView | null
  journal: JournalEntry[]
  incomingDisabled: boolean
  blocked: Set<PlayerId>
  muted: Set<PlayerId>
  error: string | null
  reconnecting: boolean
  /**
   * This character is being played in another tab or on another device.
   *
   * Distinct from `reconnecting`, and the UI must not treat them alike:
   * reconnecting resolves itself, whereas this waits for the player to
   * decide which tab wins.
   */
  superseded: boolean
  surrenderAsk: boolean
}

const emptyGold = (): GoldView => ({
  total: 0,
  available: 0,
  reserved: 0,
  redeemable: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  goldKind: GOLD_KIND,
  demo: true,
  notice: DEMO_GOLD_NOTICE,
})

export const pvpState: PvpUi = {
  connected: false,
  signedIn: false,
  playerId: null,
  gold: emptyGold(),
  self: null,
  others: [],
  inspect: null,
  composer: null,
  invite: null,
  outgoing: null,
  duel: null,
  result: null,
  journal: [],
  incomingDisabled: false,
  blocked: new Set(),
  muted: new Set(),
  error: null,
  reconnecting: false,
  superseded: false,
  surrenderAsk: false,
}

const listeners = new Set<() => void>()

export function subscribePvp(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function pingPvp() {
  listeners.forEach(fn => fn())
}

export function isDuelLocked() {
  const phase = pvpState.duel?.phase
  return phase === 'preparing' || phase === 'countdown' || phase === 'active'
}

export function remoteAt(id: PlayerId) {
  return pvpState.others.find(p => p.playerId === id) ?? null
}
