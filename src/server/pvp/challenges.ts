import {
  CHALLENGE_RATE_BURST,
  CHALLENGE_RATE_MS,
  CHALLENGE_TTL_MS,
  DEMO_GOLD_NOTICE,
  DUEL_RULES,
  GOLD_KIND,
  INTERACT_RANGE,
  MAX_STAKE,
  type ChallengeId,
  type ChallengeView,
  type PlayerId,
  type PresenceState,
  type PublicCard,
  type WizardId,
} from '../../shared/pvp'
import { DUEL_RINGS, isInTown, ringById } from '../../shared/zones'
import { publicDisplayName } from '../moderation/names'
import { accountByPlayer, loadoutOf, newId, type AccountRow } from './ids'
import { goldView, readGold } from './ledger'
import { db } from './schema'

export type ChallengeRow = {
  challenge_id: string
  from_id: string
  to_id: string
  stake: number
  ring_id: string | null
  from_name: string
  to_name: string
  from_level: number
  to_level: number
  from_character: string
  to_character: string
  from_available: number
  to_available: number
  status: string
  created_at_ms: number
  expires_at_ms: number
  resolved_at_ms: number | null
}

const insertChallenge = db.prepare(`
  insert into pvp_challenges (
    challenge_id, from_id, to_id, stake, ring_id, from_name, to_name, from_level, to_level,
    from_character, to_character, from_available, to_available, status, created_at_ms, expires_at_ms
  ) values (
    @challenge_id, @from_id, @to_id, @stake, @ring_id, @from_name, @to_name, @from_level, @to_level,
    @from_character, @to_character, @from_available, @to_available, 'pending', @now, @expires
  )
`)

const selectChallenge = db.prepare<[string], ChallengeRow>('select * from pvp_challenges where challenge_id = ?')

const outgoingPending = db.prepare<[string], ChallengeRow>(
  `select * from pvp_challenges where from_id = ? and status = 'pending' order by created_at_ms desc`,
)

const incomingPending = db.prepare<[string], ChallengeRow>(
  `select * from pvp_challenges where to_id = ? and status = 'pending' order by created_at_ms desc`,
)

const expireDue = db.prepare(`
  update pvp_challenges
     set status = 'expired', resolved_at_ms = @now
   where status = 'pending' and expires_at_ms <= @now
`)

const claimChallenge = db.prepare(`
  update pvp_challenges
     set status = @status, resolved_at_ms = @now, ring_id = coalesce(@ring_id, ring_id)
   where challenge_id = @challenge_id
     and status = 'pending'
     and expires_at_ms > @now
     and stake = @stake
     and from_id = @from_id
     and to_id = @to_id
`)

const cancelOutgoing = db.prepare(`
  update pvp_challenges
     set status = 'cancelled', resolved_at_ms = @now
   where challenge_id = @challenge_id and from_id = @from_id and status = 'pending'
`)

const declineIncoming = db.prepare(`
  update pvp_challenges
     set status = 'declined', resolved_at_ms = @now
   where challenge_id = @challenge_id and to_id = @to_id and status = 'pending'
`)

const insertBlock = db.prepare('insert or ignore into pvp_blocks (player_id, blocked_id, created_at_ms) values (?, ?, ?)')
const deleteBlock = db.prepare('delete from pvp_blocks where player_id = ? and blocked_id = ?')
const isBlocked = db.prepare<[string, string], { n: number }>(
  'select 1 as n from pvp_blocks where player_id = ? and blocked_id = ?',
)

const recentFrom = db.prepare<[string, number], { n: number }>(
  `select count(*) as n from pvp_challenges where from_id = ? and created_at_ms >= ?`,
)

export type Pose = { x: number; z: number; state: string; online: boolean }

export function expireChallenges(now = Date.now()) {
  expireDue.run({ now })
}

export function blocked(from: PlayerId, to: PlayerId) {
  return Boolean(isBlocked.get(from, to) || isBlocked.get(to, from))
}

export function setBlock(playerId: PlayerId, otherId: PlayerId, on: boolean, now = Date.now()) {
  if (playerId === otherId) return
  if (on) insertBlock.run(playerId, otherId, now)
  else deleteBlock.run(playerId, otherId)
}

export function youBlocked(playerId: PlayerId, otherId: PlayerId) {
  return Boolean(isBlocked.get(playerId, otherId))
}

function distance(a: Pose, b: Pose) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

export type OfferError = { ok: false; reason: string; code: string }
export type OfferOk = { ok: true; row: ChallengeRow; view: ChallengeView }

export function offerChallenge(input: {
  from: AccountRow
  to: AccountRow
  stake: number
  fromPose: Pose
  toPose: Pose
  busy: (id: PlayerId) => boolean
  now?: number
}): OfferOk | OfferError {
  const now = input.now ?? Date.now()
  expireChallenges(now)

  const stake = input.stake
  if (!Number.isInteger(stake) || stake <= 0 || stake > MAX_STAKE) {
    return { ok: false, code: 'bad_stake', reason: 'Stake must be a positive whole number of game gold.' }
  }
  if (input.from.player_id === input.to.player_id) {
    return { ok: false, code: 'self', reason: 'You cannot challenge yourself.' }
  }
  if (!input.fromPose.online || !input.toPose.online) {
    return { ok: false, code: 'offline', reason: 'Both players must be online.' }
  }
  if (isInTown(input.fromPose.x, input.fromPose.z) || isInTown(input.toPose.x, input.toPose.z)) {
    // Not "leave town": the gate is isInTown, which is the plaza plus every
    // paved street and a skirt around each building, so the main road is town
    // from one edge of the world to the other. The client computes a real
    // direction for the player; this fallback can only state the rule.
    return { ok: false, code: 'in_town', reason: 'Duels happen outside town. Step clear of the plaza, the streets and the buildings first.' }
  }
  if (distance(input.fromPose, input.toPose) > INTERACT_RANGE) {
    return { ok: false, code: 'range', reason: 'Move closer to challenge this player.' }
  }
  const busyStates = new Set(['challenged', 'preparing', 'dueling', 'unavailable', 'disconnected'])
  if (busyStates.has(input.fromPose.state) || input.busy(input.from.player_id)) {
    return { ok: false, code: 'busy', reason: 'You are already in a challenge or duel.' }
  }
  if (busyStates.has(input.toPose.state) || input.busy(input.to.player_id)) {
    return { ok: false, code: 'busy', reason: 'That player is not available.' }
  }
  if (input.to.incoming_off) {
    return { ok: false, code: 'disabled', reason: 'That player is not accepting challenges.' }
  }
  if (blocked(input.from.player_id, input.to.player_id)) {
    return { ok: false, code: 'blocked', reason: 'A block is in place. This invite cannot be sent.' }
  }
  if (outgoingPending.all(input.from.player_id).length) {
    return { ok: false, code: 'outgoing', reason: 'You already have an outgoing challenge.' }
  }
  const recent = recentFrom.get(input.from.player_id, now - CHALLENGE_RATE_MS * CHALLENGE_RATE_BURST)?.n ?? 0
  if (recent >= CHALLENGE_RATE_BURST) {
    return { ok: false, code: 'rate', reason: 'Too many challenges. Wait a moment.' }
  }

  const fromGold = readGold(input.from.player_id)
  const toGold = readGold(input.to.player_id)
  if (fromGold.available < stake) return { ok: false, code: 'gold', reason: 'You do not have enough available game gold.' }
  if (toGold.available < stake) return { ok: false, code: 'gold', reason: 'They do not have enough available game gold.' }

  const ring = pickFreeRing(id => input.busy(id), now)
  const row = {
    challenge_id: newId('c'),
    from_id: input.from.player_id,
    to_id: input.to.player_id,
    stake,
    ring_id: ring?.id ?? null,
    from_name: input.from.display_name,
    to_name: input.to.display_name,
    from_level: input.from.level,
    to_level: input.to.level,
    from_character: input.from.character,
    to_character: input.to.character,
    from_available: fromGold.available,
    to_available: toGold.available,
    status: 'pending',
    created_at_ms: now,
    expires_at_ms: now + CHALLENGE_TTL_MS,
    resolved_at_ms: null,
  }
  insertChallenge.run({ ...row, now, expires: row.expires_at_ms })
  return { ok: true, row, view: challengeView(row, input.from.player_id) }
}

export function claimPending(challengeId: ChallengeId, actor: PlayerId, now = Date.now()) {
  expireChallenges(now)
  const row = selectChallenge.get(challengeId)
  if (!row) return null
  if (row.to_id !== actor && row.from_id !== actor) return null
  return row
}

export function markAccepted(row: ChallengeRow, ringId: string, now = Date.now()) {
  const result = claimChallenge.run({
    status: 'accepted',
    now,
    ring_id: ringId,
    challenge_id: row.challenge_id,
    stake: row.stake,
    from_id: row.from_id,
    to_id: row.to_id,
  })
  return result.changes === 1
}

export function declineChallenge(challengeId: ChallengeId, actor: PlayerId, now = Date.now()) {
  expireChallenges(now)
  return declineIncoming.run({ challenge_id: challengeId, to_id: actor, now }).changes === 1
}

export function cancelChallenge(challengeId: ChallengeId, actor: PlayerId, now = Date.now()) {
  expireChallenges(now)
  return cancelOutgoing.run({ challenge_id: challengeId, from_id: actor, now }).changes === 1
}

export function readChallenge(challengeId: string): ChallengeRow | undefined {
  return selectChallenge.get(challengeId)
}

export function pendingFor(playerId: PlayerId): ChallengeRow[] {
  expireChallenges()
  return [...outgoingPending.all(playerId), ...incomingPending.all(playerId)]
}

export function challengeView(row: ChallengeRow, you: PlayerId): ChallengeView {
  const ring = row.ring_id ? ringById(row.ring_id) : undefined
  return {
    challengeId: row.challenge_id,
    fromId: row.from_id,
    toId: row.to_id,
    // These are name snapshots taken when the invite was sent. New rows copy an
    // already-screened account name, so this only matters for a row that
    // predates moderation — but an old invite is exactly the kind of thing that
    // outlives a fix, so it is screened on the way out too.
    fromName: publicDisplayName(row.from_name),
    toName: publicDisplayName(row.to_name),
    fromLevel: row.from_level,
    toLevel: row.to_level,
    fromCharacter: row.from_character as WizardId,
    toCharacter: row.to_character as WizardId,
    fromAvailable: row.from_available,
    toAvailable: row.to_available,
    stake: row.stake,
    pot: row.stake * 2,
    ringId: row.ring_id ?? '',
    ringName: ring?.name ?? 'Outdoor ring',
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    youAreChallenger: row.from_id === you,
    rules: [...DUEL_RULES],
    goldKind: GOLD_KIND,
    demo: true,
    notice: DEMO_GOLD_NOTICE,
  }
}

export function maxStake(aAvailable: number, bAvailable: number) {
  return Math.max(0, Math.min(aAvailable, bAvailable))
}

export function publicCard(row: AccountRow, you: PlayerId, pose: Pose): PublicCard {
  const gold = goldView(row.player_id)
  const loadout = loadoutOf(row)
  return {
    playerId: row.player_id,
    displayName: row.display_name,
    loadout,
    goldTotal: gold.total,
    goldAvailable: gold.available,
    wins: gold.wins,
    losses: gold.losses,
    draws: gold.draws,
    state: pose.state as PresenceState,
    inTown: isInTown(pose.x, pose.z),
    youBlockedThem: youBlocked(you, row.player_id),
    theyBlockedYou: youBlocked(row.player_id, you),
    incomingDisabled: Boolean(row.incoming_off),
    goldKind: GOLD_KIND,
    demo: true as const,
    notice: DEMO_GOLD_NOTICE,
  }
}

const busyRings = new Set<string>()

export function occupyRing(ringId: string) {
  busyRings.add(ringId)
}

export function freeRing(ringId: string) {
  busyRings.delete(ringId)
}

export function pickFreeRing(_busy: (id: string) => boolean, _now: number) {
  for (const ring of DUEL_RINGS) {
    if (!busyRings.has(ring.id) && !isInTown(ring.x, ring.z)) return ring
  }
  return DUEL_RINGS[0]
}

export function accountOrThrow(playerId: PlayerId) {
  const row = accountByPlayer(playerId)
  if (!row) throw new Error('unknown player')
  return row
}
