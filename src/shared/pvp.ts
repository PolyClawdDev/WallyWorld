/* ------------------------------------------------------------------ *
 * Shared PvP types and protocol.
 *
 * Player identity is always a stable `playerId`. Display names are
 * labels only — never keys for a challenge, a transfer, or a settlement.
 * Game gold is integer base units, separate from SOL / x402 / NPC jobs.
 * ------------------------------------------------------------------ */

import type { ProfileCharacter, ProfileStyle } from './profile'

export const PVP_PROTOCOL = 1

export type PlayerId = string
export type ChallengeId = string
export type DuelId = string
export type WizardId = ProfileCharacter

export type PresenceState =
  | 'exploring'
  | 'unavailable'
  | 'challenged'
  | 'preparing'
  | 'dueling'
  | 'disconnected'

export type DuelPhase =
  | 'preparing'
  | 'countdown'
  | 'active'
  | 'ended'

export type DuelOutcomeKind =
  | 'victory'
  | 'defeat'
  | 'draw'
  | 'forfeit'
  | 'refund'
  | 'void'

export type AnimKind = 'idle' | 'walk' | 'run' | 'attack' | 'cast' | 'hit' | 'down'

export const CHALLENGE_TTL_MS = 30_000
export const COUNTDOWN_MS = 3_000
export const DUEL_CAP_MS = 3 * 60 * 1000
export const RECONNECT_GRACE_MS = 15_000
export const OUT_OF_BOUNDS_MS = 5_000
export const PREPARE_TIMEOUT_MS = 45_000
export const POSE_HZ = 12
export const COMBAT_TICK_MS = 50
export const INTERACT_RANGE = 18
/**
 * The one-time starting grant, in gold base units.
 *
 * This used to be a PvP-only stipend in a PvP-only table. It is now a credit on
 * the single ledger with `gift` provenance — spendable while hunting, trading and
 * duelling alike, and never redeemable. The server-side value is
 * `STARTING_GRANT_GOLD` in `src/server/money/gold.ts`; this copy is for the client
 * to display and must match it.
 */
export const STARTING_GAME_GOLD = 250
export const CHALLENGE_RATE_MS = 8_000
export const CHALLENGE_RATE_BURST = 3
export const MAX_STAKE = 1_000_000_000
export const DEMO_GOLD_NOTICE = 'Demo — no real funds' as const
export const GOLD_KIND = 'game-gold' as const

/* ------------------------------------------------------------------ *
 * Connection health.
 *
 * A public deployment sits behind a load balancer that will drop an
 * idle-looking connection, and behind home routers that quietly forget
 * NAT entries. Both sides ping so neither has to guess.
 * ------------------------------------------------------------------ */

/** How often each side proves it is still there. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** No traffic for this long and the connection is treated as dead. */
export const STALE_CONNECTION_MS = 60_000

/** Reconnect backoff: doubles from the base, capped, with jitter applied by the client. */
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

export type PublicLoadout = {
  character: WizardId
  style: ProfileStyle
  level: number
  ranks: { Q: number; W: number; E: number; R: number }
}

export type PublicPresence = {
  playerId: PlayerId
  displayName: string
  loadout: PublicLoadout
  x: number
  z: number
  facing: number
  anim: AnimKind
  state: PresenceState
  inTown: boolean
}

export type PublicCard = {
  playerId: PlayerId
  displayName: string
  loadout: PublicLoadout
  goldTotal: number
  goldAvailable: number
  wins: number
  losses: number
  draws: number
  state: PresenceState
  inTown: boolean
  youBlockedThem: boolean
  theyBlockedYou: boolean
  incomingDisabled: boolean
  goldKind: typeof GOLD_KIND
  demo: true
  notice: typeof DEMO_GOLD_NOTICE
}

export type ChallengeView = {
  challengeId: ChallengeId
  fromId: PlayerId
  toId: PlayerId
  fromName: string
  toName: string
  fromLevel: number
  toLevel: number
  fromCharacter: WizardId
  toCharacter: WizardId
  fromAvailable: number
  toAvailable: number
  stake: number
  pot: number
  ringId: string
  ringName: string
  expiresAtMs: number
  createdAtMs: number
  youAreChallenger: boolean
  rules: string[]
  goldKind: typeof GOLD_KIND
  demo: true
  notice: typeof DEMO_GOLD_NOTICE
}

export type DuelFighterView = {
  playerId: PlayerId
  displayName: string
  loadout: PublicLoadout
  x: number
  z: number
  facing: number
  hp: number
  maxHp: number
  resource: number
  maxResource: number
  anim: AnimKind
  alive: boolean
  connected: boolean
}

export type DuelSnapshot = {
  duelId: DuelId
  challengeId: ChallengeId
  phase: DuelPhase
  ringId: string
  ringName: string
  stake: number
  pot: number
  a: DuelFighterView
  b: DuelFighterView
  you: PlayerId
  countdownEndsAtMs: number | null
  fightEndsAtMs: number | null
  outOfBoundsUntilMs: number | null
  reconnectUntilMs: number | null
  tick: number
  goldKind: typeof GOLD_KIND
  demo: true
  notice: typeof DEMO_GOLD_NOTICE
}

export type DuelResultView = {
  duelId: DuelId
  kind: DuelOutcomeKind
  winnerId: PlayerId | null
  loserId: PlayerId | null
  stake: number
  pot: number
  refunded: boolean
  yourDelta: number
  yourBalance: number
  yourWins: number
  yourLosses: number
  yourDraws: number
  opponentId: PlayerId
  opponentName: string
  reason: string
  goldKind: typeof GOLD_KIND
  demo: true
  notice: typeof DEMO_GOLD_NOTICE
}

export type JournalEntry = {
  duelId: DuelId
  atMs: number
  opponentId: PlayerId
  opponentName: string
  kind: DuelOutcomeKind
  stake: number
  goldDelta: number
  reason: string
}

export type GoldView = {
  total: number
  available: number
  reserved: number
  /**
   * The part of this balance that could ever be redeemed, if a redemption
   * existed. Only gold credited against a server-issued hunt kill token counts;
   * duel winnings, gifts and imported demo balances never do. There is no payout
   * path, so today this is a label on the ledger rather than a promise.
   */
  redeemable: number
  wins: number
  losses: number
  draws: number
  goldKind: typeof GOLD_KIND
  demo: true
  notice: typeof DEMO_GOLD_NOTICE
}

export type C2S =
  | { t: 'hello'; protocol: number; displayName: string; loadout: PublicLoadout }
  | { t: 'pose'; x: number; z: number; facing: number; anim: AnimKind; sprinting: boolean }
  | { t: 'inspect'; playerId: PlayerId }
  | { t: 'challenge'; playerId: PlayerId; stake: number }
  | { t: 'decline'; challengeId: ChallengeId }
  | { t: 'accept'; challengeId: ChallengeId }
  | { t: 'cancel'; challengeId: ChallengeId }
  | { t: 'ready'; duelId: DuelId }
  | { t: 'input'; duelId: DuelId; seq: number; kind: CombatInputKind; x?: number; z?: number; slot?: 'Q' | 'W' | 'E' | 'R'; sprinting?: boolean }
  | { t: 'surrender'; duelId: DuelId }
  | { t: 'leave'; duelId: DuelId }
  | { t: 'block'; playerId: PlayerId; on: boolean }
  | { t: 'settings'; incomingDisabled: boolean }
  | { t: 'ping'; at: number }

export type CombatInputKind = 'move' | 'stop' | 'attack' | 'attackMove' | 'cast' | 'cancel'

export type S2C =
  | { t: 'welcome'; playerId: PlayerId; gold: GoldView; incomingDisabled: boolean; self: PublicPresence; others: PublicPresence[]; active: DuelSnapshot | null; pending: ChallengeView[] }
  | { t: 'presence'; others: PublicPresence[] }
  | { t: 'you'; self: PublicPresence; gold: GoldView }
  | { t: 'card'; card: PublicCard }
  | { t: 'invite'; invite: ChallengeView }
  | { t: 'inviteGone'; challengeId: ChallengeId; reason: string }
  | { t: 'duel'; snapshot: DuelSnapshot }
  | { t: 'combat'; snapshot: DuelSnapshot; events: CombatEvent[] }
  | { t: 'result'; result: DuelResultView }
  | { t: 'journal'; entries: JournalEntry[] }
  | { t: 'error'; code: string; detail: string }
  | { t: 'pong'; at: number }
  /**
   * This character is now being played somewhere else.
   *
   * Sent to the losing connection just before it is closed. A client that
   * receives this must stop reconnecting: the close that follows is not a
   * network fault, and retrying would kick the other tab straight back
   * out, which is a loop neither tab escapes.
   */
  | { t: 'superseded'; detail: string }
  /**
   * The instance is shutting down. Reconnecting is correct, after a wait
   * long enough for the replacement to be listening.
   */
  | { t: 'serverClosing'; reconnectAfterMs: number; detail: string }

export type CombatEvent =
  | { kind: 'hit'; source: PlayerId; target: PlayerId; amount: number; label: string }
  | { kind: 'cast'; source: PlayerId; slot: 'Q' | 'W' | 'E' | 'R'; name: string }
  | { kind: 'announce'; text: string }

export const DUEL_RULES = [
  'Equal stakes. Winner takes the pot. No house fee.',
  'Game gold only — not SOL, not wallet funds.',
  'Real levels and kits. Nothing is secretly equalized.',
  'First to 0 HP loses. Mutual death or the 3-minute cap is a draw and refunds both stakes.',
  'Leave the ring for 5 seconds and you forfeit.',
  'Town is protected. Challenges and PvP damage only work outside the gates.',
] as const

export function assertIntGold(value: unknown, label = 'amount'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_STAKE) {
    throw new Error(`${label} must be an integer between 0 and ${MAX_STAKE}`)
  }
  return value
}

export function looksLikePlayerId(value: unknown): value is PlayerId {
  return typeof value === 'string' && /^p_[0-9a-f]{32}$/.test(value)
}

export function looksLikeChallengeId(value: unknown): value is ChallengeId {
  return typeof value === 'string' && /^c_[0-9a-f]{32}$/.test(value)
}

export function looksLikeDuelId(value: unknown): value is DuelId {
  return typeof value === 'string' && /^d_[0-9a-f]{32}$/.test(value)
}
