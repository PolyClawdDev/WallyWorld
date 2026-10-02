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

/**
 * How long two fighters may stand in the arena after a match.
 *
 * The results panel is the one place in the flow where nothing is being
 * simulated and nobody is under any pressure to act, which is exactly the
 * shape of state that strands people. So it has a deadline like every
 * other phase: when it runs out the instance closes itself and both
 * players are put back in the town whether or not either touched a button.
 *
 * Generous, because it is not a hurry-up — a rematch involves two people
 * agreeing, and being thrown out of the arena while reading the numbers
 * would be worse than the wait.
 */
export const RESULTS_TIMEOUT_MS = 90_000

/**
 * The fade over the scene swap, each way.
 *
 * Long enough to hide the town being taken down and the arena being put
 * up, short enough that it reads as a cut rather than as a cinematic. The
 * brief asked for "a brief fade in and out, no long cinematics".
 */
export const ARENA_FADE_MS = 380
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
/**
 * The one line every gold surface carries.
 *
 * It used to read "Demo — no real funds", which is now two claims and only
 * one of them is true. The gold is not a demo: it is server-authoritative,
 * append-only, double-entry, in whole base units, and duel stakes go through
 * real escrow. Calling that a demo taught players the opposite of what to
 * expect — that losing a wager did not really cost them anything.
 *
 * What has not changed is that it is not money and cannot become money.
 * There is no treasury signer, no mint, and `PAYOUTS_ENABLED` is `false as
 * const`. So the notice keeps saying the part that is still true and stops
 * saying the part that is not.
 *
 * The constant's *name* is deliberately unchanged: it is imported across the
 * server, and renaming it would be a wide edit for no reader's benefit.
 */
/*
 * Reworded again because it was still being read as fake money. Duel gold is
 * server-authoritative and escrowed atomically: staking it can genuinely lose
 * it. Leading with "not redeemable" made the real half sound like the demo
 * half, so the order is reversed. The legal half is kept, just second.
 */
export const DEMO_GOLD_NOTICE = 'Real in-game gold · no cash value' as const
export const GOLD_KIND = 'game-gold' as const

/* ------------------------------------------------------------------ *
 * Connection health.
 *
 * A public deployment sits behind a load balancer that will drop an
 * idle-looking connection, and behind home routers that quietly forget
 * NAT entries. Both sides ping so neither has to guess.
 * ------------------------------------------------------------------ */

/**
 * How often each side proves it is still there, and how long silence is
 * tolerated before the far end is presumed gone.
 *
 * These two are one decision, not two, because the server's reaping sweep
 * runs on the heartbeat timer. The worst case a player waits to disappear
 * from everyone else's town is `STALE + HEARTBEAT`: the silence has to
 * exceed the threshold, and then the next sweep has to come round. The
 * arithmetic at 6 s / 21 s:
 *
 *   healthy connection   proof of life every 6 s, so three consecutive
 *                        heartbeats have to be lost before anyone is
 *                        suspected — a 3.5× margin, not a borderline one.
 *                        (Presence is also broadcast every ~250 ms while
 *                        the world ticks, so in practice the margin is
 *                        larger still; 6 s is the floor.)
 *   hard drop            detected between 21 s and 27 s. Previously
 *                        60–80 s, which is long enough that a closed
 *                        laptop looked like a player standing in the road.
 *
 * A clean close does not wait for any of this: the socket's close handler
 * removes the player immediately, and the client sends that close on
 * `pagehide` so a closed tab takes the same fast path.
 *
 * The lower bound on `STALE` is `RECONNECT_GRACE_MS` (15 s): a fighter who
 * drops mid-duel must still be inside their reconnect window when the
 * sweep notices, or the grace period would be unreachable in the one case
 * it exists for.
 */
export const HEARTBEAT_INTERVAL_MS = 6_000

/** No traffic for this long and the connection is treated as dead. */
export const STALE_CONNECTION_MS = 21_000

/** Reconnect backoff: doubles from the base, capped, with jitter applied by the client. */
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

/* ------------------------------------------------------------------ *
 * Chat.
 *
 * Chat rides the presence socket. It is not a second connection and not a
 * second service: one small instance, one hub, one set of heartbeats.
 *
 * THE TWO PROPERTIES EVERYTHING HERE EXISTS TO HOLD
 *   `fromName` is the SERVER's name for the sender, read through
 *   `server/pvp/ids.ts` like every other name in the protocol. A client may
 *   put whatever it likes in the frame it sends; there is no name field in
 *   `C2S` for it to put it in.
 *
 *   `text` is TEXT. It is rendered as a DOM text node and nothing else —
 *   no markup, no parsing, no link embedding — and it can never authorise
 *   anything. There is no chat command that moves gold, accepts a duel, or
 *   changes any state: the channel carries words between players and that
 *   is the whole of its power.
 * ------------------------------------------------------------------ */

/**
 * `system` is the server talking to one player — a refusal, or `/help`. It
 * is never relayed and never carries another player's text, so it is the one
 * channel a client can trust the wording of.
 */
export type ChatChannel = 'all' | 'say' | 'whisper' | 'system'

/** What a player may address. `system` is server-only, so it is not in here. */
export type ChatTarget = Exclude<ChatChannel, 'system'>

/**
 * The cap, in UTF-16 code units of the frame as sent.
 *
 * Over the cap is REFUSED, not trimmed. Truncating would publish half a
 * sentence under the sender's name and leave them believing the rest
 * arrived, which is a worse failure than being told to be brief.
 */
export const CHAT_MAX_LEN = 240

/**
 * How far `/say` carries, in metres.
 *
 * Deliberately wider than `INTERACT_RANGE` (18) — you should be able to
 * answer someone you can see across the plaza, not only someone close
 * enough to duel — and well short of the world, or `/say` would be `/all`
 * with extra steps.
 */
export const CHAT_SAY_RADIUS = 40

/**
 * Messages per window, per player, enforced on the server.
 *
 * Sized for conversation and not for a scroller: a person types a few lines
 * in ten seconds, a flood script types hundreds. It is also what bounds
 * `/w` guessing, since a whisper costs the same budget as anything else.
 */
export const CHAT_RATE = { windowMs: 10_000, max: 8 } as const

/** How many lines the client keeps. Old lines are dropped, never persisted. */
export const CHAT_LOG_LIMIT = 80

/**
 * How long a new line holds the box at full opacity before it recedes.
 *
 * The box is furniture for most of a session, so it dims out of the way of
 * the world and comes back on a new message or when the player engages it.
 */
export const CHAT_FADE_MS = 7_000

export type ChatMessage = {
  id: string
  channel: ChatChannel
  /** Null for `system`, which has no sender. */
  fromId: PlayerId | null
  /** The server's name for the sender. Never the one the client sent. */
  fromName: string
  /** Set only on the sender's own copy of a whisper, so they can see who they told. */
  toName?: string
  /** Untrusted player input on every channel but `system`. Render as text. */
  text: string
  atMs: number
  /** Why a `system` line was emitted. For the client's styling and the tests. */
  code?: string
}

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

/* ------------------------------------------------------------------ *
 * The arena instance.
 *
 * A duel is one match. An arena instance can hold several: a mutual
 * rematch is a new match with a new `duelId` and its own escrow, fought
 * in the SAME instance, which is why the instance needs an identity and a
 * phase of its own rather than being a property of the duel.
 *
 * `ArenaPhase` is the client's whole state machine. It is derived from the
 * simulation's phase and the session's, and every one of its states has a
 * bounded exit on the server — `loading` by the prepare timeout,
 * `countdown` by its own length, `fighting` by the three-minute cap, and
 * `results` by `RESULTS_TIMEOUT_MS`. `closed` is the one that means "you
 * are out"; nothing else does, and the client must not infer it from the
 * duel's phase, because a settled match with a results panel on screen is
 * `ended` as a duel and very much still in the arena.
 * ------------------------------------------------------------------ */

export type ArenaPhase = 'loading' | 'countdown' | 'fighting' | 'results' | 'closed'

/** Matches won in this instance. Reset by leaving it, not by a rematch. */
export type ArenaSeries = { aWins: number; bWins: number; draws: number }

export type ArenaView = {
  /** Stable for the life of the instance, across every rematch in it. */
  id: string
  /**
   * Instance origin, in world coordinates. The client puts the arena's
   * root here so the server's fighter positions need no translation: what
   * arrives in the snapshot is where the wizard goes.
   */
  originX: number
  originZ: number
  /** Where the wall stands, so the client can draw a boundary warning against it. */
  boundaryRadius: number
  /** 1 for the first match in this instance, 2 for the first rematch, and so on. */
  matchNumber: number
  phase: ArenaPhase
  series: ArenaSeries
  /** Who has asked for another match. Both true is what starts one. */
  rematch: { a: boolean; b: boolean }
  /** Deadline on the results phase. Null outside it. */
  resultsEndsAtMs: number | null
}

export type DuelSnapshot = {
  duelId: DuelId
  challengeId: ChallengeId
  phase: DuelPhase
  arena: ArenaView
  ringId: string
  ringName: string
  stake: number
  pot: number
  a: DuelFighterView
  b: DuelFighterView
  you: PlayerId
  countdownEndsAtMs: number | null
  /**
   * When combat was enabled, on the server's clock. Null until it is.
   *
   * The HUD counts the round up from this for the same reason the countdown
   * counts down to `countdownEndsAtMs`: a start time each client noted for
   * itself is a different start time on each screen, so the two fighters
   * would read different elapsed times for the same round. It stays set
   * through `ended` so the arena still knows when the round it just finished
   * began.
   */
  roundStartedAtMs: number | null
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
  /** The instance this match was fought in, so a rematch can name it. */
  arenaId: string
  matchNumber: number
  /**
   * The running score in this instance, including the match just settled,
   * from the reader's own side — like `yourDelta` and `yourBalance` beside it.
   * `ArenaSeries` is a/b because a snapshot is symmetric; a result is not.
   */
  series: { yours: number; theirs: number; draws: number }
  kind: DuelOutcomeKind
  winnerId: PlayerId | null
  loserId: PlayerId | null
  stake: number
  pot: number
  /**
   * How long the round ran, in milliseconds.
   *
   * A duration measured entirely on the server clock rather than the two
   * timestamps it came from, so both panels state the same length: a client
   * subtracting its own `Date.now()` from a server start would be out by
   * whatever its clock is out by, and the two fighters would disagree about
   * a round they fought together. Zero for a match that never reached
   * combat — a prepare timeout or a drain has no round to measure.
   */
  roundMs: number
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
  /**
   * "I want another match in this arena." Mutual: the instance starts a
   * new match only once both fighters have one of these standing, and
   * either may withdraw it with `on: false`.
   *
   * Deliberately not a fresh challenge. Rematching by re-challenging gave
   * a new ring, a new arena instance and a new walk out of town, and threw
   * the session score away — which is most of what a rematch is for.
   */
  | { t: 'rematch'; duelId: DuelId; on: boolean }
  | { t: 'leave'; duelId: DuelId }
  | { t: 'block'; playerId: PlayerId; on: boolean }
  | { t: 'settings'; incomingDisabled: boolean }
  /**
   * "Wildlife killed me, put me back in town."
   *
   * Carries no coordinates, and must never be given any. The server owns the
   * destination — `TOWN_RESPAWN` — because a message that named its own would
   * be exactly the free teleport the movement speed budget exists to refuse.
   * What the server does and does not take on trust here is set out in
   * `src/server/pvp/respawn.ts`.
   */
  | { t: 'respawn' }
  /**
   * Note what is NOT here: a sender name. The hub reads the name from the
   * accounts table on every broadcast, so there is nothing for a client to
   * spoof. `to` is a display name because that is the only handle a player
   * has for someone they can see; resolving it is the server's job.
   */
  | { t: 'chat'; channel: ChatTarget; text: string; to?: string }
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
  /**
   * One frame for every channel, including the server's own refusals. A
   * refusal is a line in the same log the player is already reading, which
   * is where they are looking when it arrives.
   */
  | { t: 'chat'; msg: ChatMessage }
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
  /**
   * A fighter was held by the boundary this tick.
   *
   * The server is the only side that knows: it owns the position, and what
   * the client receives is already inside the wall. Without this event a
   * player walking into the barrier sees their wizard stop for no visible
   * reason, which reads as the controls having failed.
   */
  | { kind: 'boundary'; target: PlayerId }

export const DUEL_RULES = [
  'Equal stakes. Winner takes the pot. No house fee.',
  'Game gold only — not SOL, not wallet funds.',
  'Real levels and kits. Nothing is secretly equalized.',
  'First to 0 HP loses. Mutual death or the 3-minute cap is a draw and refunds both stakes.',
  // Was "leave the ring for 5 seconds and you forfeit", which described the
  // old open-ground rings. The arena has a wall: there is no out to go to,
  // so the honest rule is that the floor keeps you on it.
  'The arena is sealed. The boundary holds you in — there is nowhere to run to.',
  'Town is protected. Challenges only work outside the gates; the duel is fought elsewhere.',
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
