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

/**
 * How the presence connection is doing, as three states rather than one flag.
 *
 * A single "reconnecting" boolean could only ever say "still trying", which
 * stays true forever when the reason is not going to go away on its own. The
 * player then reads a chip that claims to be working while nothing is. These
 * three are distinguishable to a player and each implies something different:
 *
 *   connecting  the first attempt is in flight and nothing has failed yet;
 *   retrying    an attempt failed, another is scheduled, and this is normal
 *               for a moment after a dropped connection;
 *   offline     enough attempts have failed that calling it "connecting"
 *               would be untrue. `reason` says what went wrong and `retrying`
 *               says whether anything further is being attempted.
 */
export type PvpLinkPhase = 'connecting' | 'retrying' | 'offline'

export type PvpLink = {
  phase: PvpLinkPhase
  /** Failed attempts since the last `welcome`. */
  attempts: number
  /** What went wrong, naming the URL that was tried. Null before anything has. */
  reason: string | null
  /** True while a further attempt is scheduled. False means the client has stopped. */
  retrying: boolean
}

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
  link: PvpLink
  /**
   * This character is being played in another tab or on another device.
   *
   * Distinct from every `link` phase, and the UI must not treat them alike:
   * retrying resolves itself, whereas this waits for the player to decide
   * which tab wins.
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
  link: { phase: 'connecting', attempts: 0, reason: null, retrying: false },
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

/**
 * True while this client is standing in an arena instance.
 *
 * Read off the INSTANCE's phase, not the duel's. A settled match with a
 * results panel on screen is `ended` as a duel and the player is still on
 * the floor, with the server owning their position; gating on the duel's
 * phase there would hand control back to the town while the wizard was
 * 512 m outside it. `closed` is the only state that means "you are out",
 * and the server is the only thing that says it.
 */
export function isDuelLocked() {
  const arena = pvpState.duel?.arena
  return Boolean(arena && arena.phase !== 'closed')
}

/** True only while damage can be dealt. Not during load, countdown or results. */
export function isFighting() {
  return pvpState.duel?.arena.phase === 'fighting'
}

export function remoteAt(id: PlayerId) {
  return pvpState.others.find(p => p.playerId === id) ?? null
}
