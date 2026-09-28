/* ------------------------------------------------------------------ *
 * Live presence, challenges, and duel orchestration.
 *
 * Wallets stay on the session. Every public message uses playerId.
 * ------------------------------------------------------------------ */

import { setInterval } from 'node:timers'
import {
  COMBAT_TICK_MS,
  DEMO_GOLD_NOTICE,
  GOLD_KIND,
  HEARTBEAT_INTERVAL_MS,
  PREPARE_TIMEOUT_MS,
  STALE_CONNECTION_MS,
  type C2S,
  type CombatEvent,
  type DuelOutcomeKind,
  type DuelResultView,
  type JournalEntry,
  type PlayerId,
  type PresenceState,
  type PublicPresence,
  type S2C,
} from '../../shared/pvp'
import { isInTown, ringById, ringStarts } from '../../shared/zones'
import { ROOM_CAPACITY } from '../config'
import { walletFromAuthHeader } from '../auth'
import { CharacterClaims } from './claims'
import { rememberPosition, resolveMove, resumePosition, sweepPositions } from './presence'
import {
  accountByPlayer,
  accountByWallet,
  ensureAccount,
  loadoutOf,
  parseLoadout,
  saveLoadout,
  setIncomingDisabled,
  type AccountRow,
} from './ids'
import {
  cancelChallenge,
  challengeView,
  claimPending,
  declineChallenge,
  expireChallenges,
  freeRing,
  markAccepted,
  occupyRing,
  offerChallenge,
  pendingFor,
  pickFreeRing,
  publicCard,
  readChallenge,
  setBlock,
  youBlocked,
  type Pose,
} from './challenges'
import { DuelSim, type DuelEnd } from './combat'
import { goldView, recordOutcome, reserveBoth, settleEscrow } from './ledger'
import { newId } from './ids'
import { db } from './schema'
import { CLOSE, type WsConn } from './socket'

type Live = {
  playerId: PlayerId
  accountId: string
  conn: WsConn
  /**
   * Which claim on this character this connection holds. Every mutation
   * checks it, so a connection that has already been superseded cannot
   * still move the wizard the new tab is now driving.
   */
  epoch: number
  x: number
  z: number
  facing: number
  anim: PublicPresence['anim']
  state: PresenceState
  muted: Set<PlayerId>
  /** When the last accepted pose landed, for the movement speed budget. */
  lastMoveAtMs: number
  /**
   * True until the first pose of a connection that could not resume a
   * remembered position. That one pose is trusted absolutely; everything
   * after it is measured against the speed budget.
   */
  awaitingSeed: boolean
}

const lives = new Map<PlayerId, Live>()

/**
 * One process, one world, one claim per character.
 *
 * There is no room ownership and no routing here, so this map is the whole
 * town. Scaling to a second instance would not add capacity, it would create
 * a second town behind the same URL — see `ROOM_CAPACITY`.
 */
const claims = new CharacterClaims<Live>()
const byAccount = new Map<string, PlayerId>()
const duels = new Map<string, DuelSim>()
const duelByPlayer = new Map<PlayerId, string>()
const lastPoseAt = new Map<PlayerId, number>()
let lastPresenceBroadcast = 0

const insertDuel = db.prepare(`
  insert into pvp_duels (
    duel_id, challenge_id, a_id, b_id, ring_id, stake, phase, a_wizard, b_wizard,
    a_level, b_level, a_ranks, b_ranks, a_name, b_name, persist_json, created_at_ms
  ) values (
    @duel_id, @challenge_id, @a_id, @b_id, @ring_id, @stake, 'preparing', @a_wizard, @b_wizard,
    @a_level, @b_level, @a_ranks, @b_ranks, @a_name, @b_name, @persist_json, @now
  )
`)

const updateDuel = db.prepare(`
  update pvp_duels
     set phase = @phase,
         persist_json = @persist_json,
         countdown_at_ms = @countdown_at_ms,
         started_at_ms = @started_at_ms,
         ended_at_ms = @ended_at_ms,
         outcome = @outcome,
         winner_id = @winner_id,
         reason = @reason,
         settlement_id = coalesce(settlement_id, @settlement_id)
   where duel_id = @duel_id
`)

const selectOpenDuels = db.prepare(`select * from pvp_duels where phase in ('preparing','countdown','active')`)
const selectDuel = db.prepare('select * from pvp_duels where duel_id = ?')
const insertEscrowRow = db.prepare(`
  insert into pvp_escrow (duel_id, challenge_id, a_id, b_id, stake, pot, status, created_at_ms)
  values (@duel_id, @challenge_id, @a_id, @b_id, @stake, @pot, 'held', @now)
`)
const settleEscrowRow = db.prepare(`
  update pvp_escrow set status = @status, settled_at_ms = @now, settlement_id = @settlement_id
   where duel_id = @duel_id and settled_at_ms is null
`)
const insertJournal = db.prepare(`
  insert or ignore into pvp_journal (id, duel_id, player_id, opponent_id, opponent_name, kind, stake, gold_delta, reason, created_at_ms)
  values (@id, @duel_id, @player_id, @opponent_id, @opponent_name, @kind, @stake, @gold_delta, @reason, @now)
`)
const listJournal = db.prepare<[string, number], {
  duel_id: string
  created_at_ms: number
  opponent_id: string
  opponent_name: string
  kind: string
  stake: number
  gold_delta: number
  reason: string
}>('select * from pvp_journal where player_id = ? order by created_at_ms desc limit ?')

export function recoverOpenDuels(now = Date.now()) {
  const rows = selectOpenDuels.all() as Array<{
    duel_id: string
    a_id: string
    b_id: string
    stake: number
    ring_id: string
  }>
  for (const row of rows) {
    settleEscrow({ duelId: row.duel_id, aId: row.a_id, bId: row.b_id, stake: row.stake, kind: 'void', now })
    settleEscrowRow.run({ status: 'void', now, settlement_id: newId('s'), duel_id: row.duel_id })
    updateDuel.run({
      phase: 'ended',
      persist_json: null,
      countdown_at_ms: null,
      started_at_ms: null,
      ended_at_ms: now,
      outcome: 'void',
      winner_id: null,
      reason: 'Server recovered an unfinished duel and refunded both stakes',
      settlement_id: newId('s'),
      duel_id: row.duel_id,
    })
    freeRing(row.ring_id)
    writeJournal(row.duel_id, row.a_id, row.b_id, 'void', row.stake, 0, 'Server recovered an unfinished duel and refunded both stakes', now)
    writeJournal(row.duel_id, row.b_id, row.a_id, 'void', row.stake, 0, 'Server recovered an unfinished duel and refunded both stakes', now)
  }
}

recoverOpenDuels()

/** Where a player with no remembered position appears. Just inside the town gate. */
const SPAWN = { x: 8, z: 8 }

/** Players currently connected, against the declared capacity of this one world. */
export function occupancy() {
  return { players: lives.size, capacity: ROOM_CAPACITY }
}

export function attachLive(tokenHeader: string | undefined, conn: WsConn): Live | null {
  const accountId = walletFromAuthHeader(tokenHeader)
  if (!accountId) {
    conn.send(JSON.stringify({ t: 'error', code: 'unauthenticated', detail: 'Sign in first.' } satisfies S2C))
    conn.close(CLOSE.policy, 'unauthenticated')
    return null
  }
  const account = ensureAccount(accountId)
  const now = Date.now()

  // Capacity is counted in characters, not sockets: a player taking over their
  // own character from a second tab is not a new occupant, so they are let in
  // even at a full house.
  const reconnecting = lives.has(account.player_id)
  if (!reconnecting && lives.size >= ROOM_CAPACITY) {
    conn.send(JSON.stringify({
      t: 'error',
      code: 'at_capacity',
      detail: `This world is full (${lives.size}/${ROOM_CAPACITY}). Try again in a moment.`,
    } satisfies S2C))
    conn.close(CLOSE.policy, 'at capacity')
    return null
  }

  // A recent position survives a dropped socket, so reconnecting puts you back
  // where you were standing rather than at the gate — and, more to the point,
  // stops "disconnect, reconnect, arrive anywhere" from being a free teleport.
  const resumed = resumePosition(account.player_id, SPAWN, now)

  const live: Live = {
    playerId: account.player_id,
    accountId,
    conn,
    epoch: 0,
    x: resumed.at.x,
    z: resumed.at.z,
    facing: 0,
    anim: 'idle',
    state: duelByPlayer.has(account.player_id) ? 'dueling' : 'exploring',
    muted: new Set(),
    lastMoveAtMs: now,
    awaitingSeed: !resumed.resumed,
  }

  // Taking the claim is what makes this the one connection that drives the
  // character. Whoever held it is told why they are being closed, so their
  // client knows not to reconnect and start a tug of war.
  const { epoch, displaced } = claims.take(account.player_id, live, now)
  live.epoch = epoch
  if (displaced) {
    try {
      displaced.conn.send(JSON.stringify({
        t: 'superseded',
        detail: 'This character was opened in another tab or on another device. Only one can play at a time.',
      } satisfies S2C))
    } catch {
      /* the old socket may already be gone; closing it is all that is left */
    }
    displaced.conn.close(CLOSE.policy, 'superseded')
  }

  lives.set(account.player_id, live)
  byAccount.set(accountId, account.player_id)

  conn.onMessage = text => {
    // A message from a connection that has lost its claim is discarded. This
    // is the second half of one-tab-per-character: closing the old socket is
    // asynchronous, and anything it sends in the meantime must not land.
    if (!claims.holds(live.playerId, live.epoch)) return
    try {
      handle(live, JSON.parse(text) as C2S)
    } catch {
      send(live, { t: 'error', code: 'bad_message', detail: 'Message was not valid JSON.' })
    }
  }

  conn.onClose = () => {
    // Guarded by epoch: a displaced connection's close fires *after* the new
    // tab has claimed the character, and an unguarded cleanup here would
    // evict the tab the player is actually looking at.
    if (!claims.release(live.playerId, live.epoch)) return
    if (lives.get(account.player_id) === live) {
      rememberPosition(live.playerId, live, Date.now())
      lives.delete(account.player_id)
      const duelId = duelByPlayer.get(account.player_id)
      if (duelId) duels.get(duelId)?.setConnected(account.player_id, false, Date.now())
    }
    broadcastPresence()
  }

  welcome(live)
  broadcastPresence()
  return live
}

export function playerIdForWallet(accountId: string) {
  return accountByWallet(accountId)?.player_id ?? byAccount.get(accountId) ?? null
}

export function livePose(playerId: PlayerId): Pose {
  const live = lives.get(playerId)
  if (!live) return { x: 0, z: 0, state: 'disconnected', online: false }
  return { x: live.x, z: live.z, state: live.state, online: true }
}

export function isBusy(playerId: PlayerId) {
  if (duelByPlayer.has(playerId)) return true
  const live = lives.get(playerId)
  return Boolean(live && (live.state === 'challenged' || live.state === 'preparing' || live.state === 'dueling'))
}

function send(live: Live, msg: S2C) {
  live.conn.send(JSON.stringify(msg))
}

function sendTo(playerId: PlayerId, msg: S2C) {
  const live = lives.get(playerId)
  if (live) send(live, msg)
}

function welcome(live: Live) {
  const account = accountByPlayer(live.playerId)
  if (!account) return
  const duelId = duelByPlayer.get(live.playerId)
  const sim = duelId ? duels.get(duelId) : undefined
  if (sim) sim.setConnected(live.playerId, true, Date.now())
  send(live, {
    t: 'welcome',
    playerId: live.playerId,
    gold: goldView(live.playerId),
    incomingDisabled: Boolean(account.incoming_off),
    self: presenceOf(live, account),
    others: othersFor(live.playerId),
    active: sim ? sim.snapshot(live.playerId) : null,
    pending: pendingFor(live.playerId).map(row => challengeView(row, live.playerId)),
  })
}

function presenceOf(live: Live, account: AccountRow): PublicPresence {
  return {
    playerId: live.playerId,
    displayName: account.display_name,
    loadout: loadoutOf(account),
    x: live.x,
    z: live.z,
    facing: live.facing,
    anim: live.anim,
    state: live.state,
    inTown: isInTown(live.x, live.z),
  }
}

function othersFor(you: PlayerId): PublicPresence[] {
  const out: PublicPresence[] = []
  for (const live of lives.values()) {
    if (live.playerId === you) continue
    const account = accountByPlayer(live.playerId)
    if (!account) continue
    out.push(presenceOf(live, account))
  }
  return out
}

function broadcastPresence() {
  for (const live of lives.values()) {
    const account = accountByPlayer(live.playerId)
    if (!account) continue
    send(live, { t: 'you', self: presenceOf(live, account), gold: goldView(live.playerId) })
    send(live, { t: 'presence', others: othersFor(live.playerId) })
  }
}

function handle(live: Live, msg: C2S) {
  expireChallenges()
  switch (msg.t) {
    case 'hello': {
      const loadout = parseLoadout(msg.loadout)
      if (!loadout) return send(live, { t: 'error', code: 'bad_loadout', detail: 'Loadout was rejected.' })
      if (live.state === 'dueling' || live.state === 'preparing') {
        return send(live, { t: 'error', code: 'locked', detail: 'Character and loadout are locked during a duel.' })
      }
      saveLoadout(live.playerId, msg.displayName, loadout)
      welcome(live)
      broadcastPresence()
      return
    }
    case 'pose': {
      // Inside a ring the simulation owns the position outright; a pose from
      // the client there is not late, it is an attempt to bypass combat.
      if (live.state === 'dueling' || live.state === 'preparing') return
      const now = Date.now()
      const last = lastPoseAt.get(live.playerId) ?? 0
      if (now - last < 40) return
      lastPoseAt.set(live.playerId, now)

      const verdict = resolveMove(live, msg, now - live.lastMoveAtMs, live.awaitingSeed)
      if (verdict.rejected) return
      live.awaitingSeed = false
      live.lastMoveAtMs = now
      live.x = verdict.x
      live.z = verdict.z
      live.facing = verdict.facing
      live.anim = verdict.anim
      rememberPosition(live.playerId, live, now)

      // A clamped player is told immediately rather than at the next
      // broadcast tick, so an honest client whose connection stuttered
      // reconciles in one frame instead of sliding for a fifth of a second.
      if (verdict.clamped) {
        const account = accountByPlayer(live.playerId)
        if (account) send(live, { t: 'you', self: presenceOf(live, account), gold: goldView(live.playerId) })
      }

      if (now - lastPresenceBroadcast > 80) {
        lastPresenceBroadcast = now
        broadcastPresence()
      }
      return
    }
    case 'inspect': {
      const row = accountByPlayer(msg.playerId)
      if (!row) return send(live, { t: 'error', code: 'not_found', detail: 'No such player.' })
      send(live, { t: 'card', card: publicCard(row, live.playerId, livePose(row.player_id)) })
      return
    }
    case 'challenge':
      return onChallenge(live, msg.playerId, msg.stake)
    case 'decline':
      if (declineChallenge(msg.challengeId, live.playerId)) {
        const row = readChallenge(msg.challengeId)
        if (row) {
          sendTo(row.from_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'declined' })
          sendTo(row.to_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'declined' })
          clearChallenged(row.from_id, row.to_id)
        }
      }
      return
    case 'cancel':
      if (cancelChallenge(msg.challengeId, live.playerId)) {
        const row = readChallenge(msg.challengeId)
        if (row) {
          sendTo(row.from_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'cancelled' })
          sendTo(row.to_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'cancelled' })
          clearChallenged(row.from_id, row.to_id)
        }
      }
      return
    case 'accept':
      return onAccept(live, msg.challengeId)
    case 'ready': {
      const sim = duels.get(msg.duelId)
      if (!sim) return
      sim.markReady(live.playerId, Date.now())
      pushDuel(sim)
      return
    }
    case 'input': {
      const sim = duels.get(msg.duelId)
      if (!sim) return
      sim.applyInput(live.playerId, { ...msg, atMs: Date.now() }, Date.now())
      return
    }
    case 'surrender': {
      const sim = duels.get(msg.duelId)
      if (!sim) return
      sim.requestSurrender(live.playerId)
      return
    }
    case 'leave':
      return onLeave(live, msg.duelId)
    case 'block':
      setBlock(live.playerId, msg.playerId, msg.on)
      return
    case 'settings':
      setIncomingDisabled(live.playerId, msg.incomingDisabled)
      return
    case 'ping':
      send(live, { t: 'pong', at: msg.at })
      return
  }
}

function clearChallenged(a: PlayerId, b: PlayerId) {
  for (const id of [a, b]) {
    const live = lives.get(id)
    if (live && live.state === 'challenged' && !duelByPlayer.has(id)) live.state = 'exploring'
  }
  broadcastPresence()
}

function onChallenge(live: Live, targetId: PlayerId, stake: number) {
  const from = accountByPlayer(live.playerId)
  const to = accountByPlayer(targetId)
  if (!from || !to) return send(live, { t: 'error', code: 'not_found', detail: 'No such player.' })
  const offered = offerChallenge({
    from,
    to,
    stake,
    fromPose: livePose(from.player_id),
    toPose: livePose(to.player_id),
    busy: isBusy,
  })
  if (!offered.ok) return send(live, { t: 'error', code: offered.code, detail: offered.reason })
  const fromLive = lives.get(from.player_id)
  const toLive = lives.get(to.player_id)
  if (fromLive) fromLive.state = 'challenged'
  if (toLive) toLive.state = 'challenged'
  sendTo(from.player_id, { t: 'invite', invite: challengeView(offered.row, from.player_id) })
  sendTo(to.player_id, { t: 'invite', invite: challengeView(offered.row, to.player_id) })
  broadcastPresence()
}

function onAccept(live: Live, challengeId: string) {
  const pending = claimPending(challengeId, live.playerId)
  if (!pending) return send(live, { t: 'error', code: 'gone', detail: 'That invite is gone.' })
  if (pending.to_id !== live.playerId) return send(live, { t: 'error', code: 'auth', detail: 'Only the challenged player can accept.' })

  const from = accountByPlayer(pending.from_id)
  const to = accountByPlayer(pending.to_id)
  if (!from || !to) return send(live, { t: 'error', code: 'not_found', detail: 'A fighter is missing.' })

  const fromPose = livePose(from.player_id)
  const toPose = livePose(to.player_id)
  if (!fromPose.online || !toPose.online) return send(live, { t: 'error', code: 'offline', detail: 'Both players must still be online.' })
  if (isInTown(fromPose.x, fromPose.z) || isInTown(toPose.x, toPose.z)) {
    return send(live, { t: 'error', code: 'in_town', detail: 'Leave town to accept this challenge.' })
  }
  if (duelByPlayer.has(from.player_id) || duelByPlayer.has(to.player_id)) {
    return send(live, { t: 'error', code: 'busy', detail: 'A fighter is already in a duel.' })
  }

  const ring = pickFreeRing(isBusy, Date.now())
  occupyRing(ring.id)
  const duelId = newId('d')
  const reserved = reserveBoth(from.player_id, to.player_id, pending.stake, duelId)
  if (!reserved.ok) {
    freeRing(ring.id)
    return send(live, { t: 'error', code: 'gold', detail: reserved.reason })
  }

  if (!markAccepted(pending, ring.id)) {
    settleEscrow({ duelId, aId: from.player_id, bId: to.player_id, stake: pending.stake, kind: 'refund' })
    freeRing(ring.id)
    return send(live, { t: 'error', code: 'gone', detail: 'That invite was already resolved.' })
  }

  const now = Date.now()
  const sim = new DuelSim({
    duelId,
    challengeId: pending.challenge_id,
    ringId: ring.id,
    stake: pending.stake,
    a: { id: from.player_id, name: from.display_name, loadout: loadoutOf(from) },
    b: { id: to.player_id, name: to.display_name, loadout: loadoutOf(to) },
    now,
  })
  insertDuel.run({
    duel_id: duelId,
    challenge_id: pending.challenge_id,
    a_id: from.player_id,
    b_id: to.player_id,
    ring_id: ring.id,
    stake: pending.stake,
    a_wizard: from.character,
    b_wizard: to.character,
    a_level: from.level,
    b_level: to.level,
    a_ranks: from.ranks_json,
    b_ranks: to.ranks_json,
    a_name: from.display_name,
    b_name: to.display_name,
    persist_json: sim.persist(),
    now,
  })
  insertEscrowRow.run({
    duel_id: duelId,
    challenge_id: pending.challenge_id,
    a_id: from.player_id,
    b_id: to.player_id,
    stake: pending.stake,
    pot: pending.stake * 2,
    now,
  })
  duels.set(duelId, sim)
  duelByPlayer.set(from.player_id, duelId)
  duelByPlayer.set(to.player_id, duelId)

  const starts = ringStarts(ring)
  const fromLive = lives.get(from.player_id)
  const toLive = lives.get(to.player_id)
  if (fromLive) {
    fromLive.state = 'preparing'
    fromLive.x = starts[0].x
    fromLive.z = starts[0].z
    fromLive.lastMoveAtMs = now
  }
  if (toLive) {
    toLive.state = 'preparing'
    toLive.x = starts[1].x
    toLive.z = starts[1].z
    toLive.lastMoveAtMs = now
  }
  sendTo(from.player_id, { t: 'inviteGone', challengeId: pending.challenge_id, reason: 'accepted' })
  sendTo(to.player_id, { t: 'inviteGone', challengeId: pending.challenge_id, reason: 'accepted' })
  pushDuel(sim)
  broadcastPresence()
}

function onLeave(live: Live, duelId: string) {
  const sim = duels.get(duelId)
  if (!sim) return
  if (sim.phase !== 'ended') return
  duelByPlayer.delete(sim.snapshot(live.playerId).a.playerId)
  duelByPlayer.delete(sim.snapshot(live.playerId).b.playerId)
  const liveA = lives.get(sim.snapshot(live.playerId).a.playerId)
  const liveB = lives.get(sim.snapshot(live.playerId).b.playerId)
  const ring = ringById(sim.ring.id)
  const exits = ring ? ringStarts(ring) : [{ x: 40, z: 40 }, { x: -40, z: -40 }]
  // Both fighters are placed by the server, so the budget clock restarts with
  // them: the walk out of the ring is measured from the exit, not from
  // wherever each of them was standing when the challenge was accepted.
  const now = Date.now()
  if (liveA) {
    liveA.state = 'exploring'
    liveA.x = exits[0].x
    liveA.z = exits[0].z
    liveA.lastMoveAtMs = now
    rememberPosition(liveA.playerId, liveA, now)
  }
  if (liveB) {
    liveB.state = 'exploring'
    liveB.x = exits[1].x
    liveB.z = exits[1].z
    liveB.lastMoveAtMs = now
    rememberPosition(liveB.playerId, liveB, now)
  }
  freeRing(sim.ring.id)
  duels.delete(duelId)
  broadcastPresence()
}

function pushDuel(sim: DuelSim) {
  for (const id of [sim.snapshot('x').a.playerId, sim.snapshot('x').b.playerId]) {
    const live = lives.get(id)
    if (live) {
      if (sim.phase === 'preparing') live.state = 'preparing'
      if (sim.phase === 'countdown' || sim.phase === 'active') live.state = 'dueling'
      send(live, { t: 'duel', snapshot: sim.snapshot(id) })
    }
  }
}

function writeJournal(
  duelId: string,
  playerId: PlayerId,
  opponentId: PlayerId,
  kind: DuelOutcomeKind,
  stake: number,
  goldDelta: number,
  reason: string,
  now: number,
) {
  const opp = accountByPlayer(opponentId)
  insertJournal.run({
    id: `j_${duelId}_${playerId}`,
    duel_id: duelId,
    player_id: playerId,
    opponent_id: opponentId,
    opponent_name: opp?.display_name ?? 'Wayfinder',
    kind,
    stake,
    gold_delta: goldDelta,
    reason,
    now,
  })
}

function outcomeKind(end: DuelEnd, you: PlayerId): DuelOutcomeKind {
  if (end.kind === 'void') return 'void'
  if (end.kind === 'draw') return 'draw'
  if (end.kind === 'forfeit') return you === end.winnerId ? 'victory' : 'forfeit'
  return you === end.winnerId ? 'victory' : 'defeat'
}

const settledDuels = new Set<string>()

function closeDuel(sim: DuelSim, end: DuelEnd, now: number) {
  if (settledDuels.has(sim.duelId)) return
  settledDuels.add(sim.duelId)
  const snap = sim.snapshot(sim.snapshot('x').a.playerId)
  const aId = snap.a.playerId
  const bId = snap.b.playerId
  const settlement = end.kind === 'victory' || end.kind === 'forfeit'
    ? settleEscrow({ duelId: sim.duelId, aId, bId, stake: sim.stake, kind: 'payout', winnerId: end.winnerId, now })
    : settleEscrow({ duelId: sim.duelId, aId, bId, stake: sim.stake, kind: end.kind === 'void' ? 'void' : 'refund', now })

  if (!settlement.ok) return

  const settlementId = newId('s')
  settleEscrowRow.run({ status: end.kind, now, settlement_id: settlementId, duel_id: sim.duelId })
  updateDuel.run({
    phase: 'ended',
    persist_json: sim.persist(),
    countdown_at_ms: sim.countdownAt,
    started_at_ms: sim.startedAt,
    ended_at_ms: now,
    outcome: end.kind,
    winner_id: end.winnerId,
    reason: end.reason,
    settlement_id: settlementId,
    duel_id: sim.duelId,
  })

  const draw = end.kind === 'draw' || end.kind === 'void'
  recordOutcome(end.winnerId, end.loserId, draw, now)

  for (const id of [aId, bId]) {
    const youWon = end.winnerId === id
    const delta = draw || end.kind === 'void' ? 0 : youWon ? sim.stake : -sim.stake
    const kind = outcomeKind(end, id)
    writeJournal(sim.duelId, id, id === aId ? bId : aId, kind, sim.stake, delta, end.reason, now)
    const gold = goldView(id)
    const rec = gold
    const result: DuelResultView = {
      duelId: sim.duelId,
      kind,
      winnerId: end.winnerId,
      loserId: end.loserId,
      stake: sim.stake,
      pot: sim.stake * 2,
      refunded: draw || end.kind === 'void',
      yourDelta: delta,
      yourBalance: gold.available,
      yourWins: rec.wins,
      yourLosses: rec.losses,
      yourDraws: rec.draws,
      opponentId: id === aId ? bId : aId,
      opponentName: id === aId ? snap.b.displayName : snap.a.displayName,
      reason: end.reason,
      goldKind: GOLD_KIND,
      demo: true,
      notice: DEMO_GOLD_NOTICE,
    }
    sendTo(id, { t: 'result', result })
    const live = lives.get(id)
    const account = accountByPlayer(id)
    if (live && account) sendTo(id, { t: 'you', self: presenceOf(live, account), gold })
  }
}

setInterval(() => {
  const now = Date.now()
  expireChallenges(now)
  for (const sim of duels.values()) {
    if (sim.phase === 'preparing' && now - sim.createdAt > PREPARE_TIMEOUT_MS) {
      closeDuel(sim, { kind: 'void', winnerId: null, loserId: null, reason: 'Prepare timed out. Stakes returned.' }, now)
      continue
    }
    const { events, ended } = sim.step(now)
    if (ended) closeDuel(sim, ended, now)
    else if (sim.phase !== 'ended') {
      persistSim(sim)
      emitCombat(sim, events)
    }
  }
  if (now % 250 < COMBAT_TICK_MS) broadcastPresence()
}, COMBAT_TICK_MS).unref()

function persistSim(sim: DuelSim) {
  updateDuel.run({
    phase: sim.phase,
    persist_json: sim.persist(),
    countdown_at_ms: sim.countdownAt || null,
    started_at_ms: sim.startedAt || null,
    ended_at_ms: sim.endedAt || null,
    outcome: null,
    winner_id: null,
    reason: null,
    settlement_id: null,
    duel_id: sim.duelId,
  })
}

function emitCombat(sim: DuelSim, events: CombatEvent[]) {
  const snap = sim.snapshot('x')
  for (const id of [snap.a.playerId, snap.b.playerId]) {
    sendTo(id, { t: 'combat', snapshot: sim.snapshot(id), events })
    const live = lives.get(id)
    const fighter = id === snap.a.playerId ? snap.a : snap.b
    if (live) {
      // The simulation is authoritative inside the ring, so the overworld
      // record follows it rather than the other way round — and the speed
      // budget is re-based here so stepping out of a duel is not read as a
      // teleport from wherever the player stood before it started.
      live.x = fighter.x
      live.z = fighter.z
      live.facing = fighter.facing
      live.anim = fighter.anim
      live.lastMoveAtMs = Date.now()
      rememberPosition(live.playerId, live)
    }
  }
}

export function journalFor(playerId: PlayerId, limit = 40): JournalEntry[] {
  return listJournal.all(playerId, limit).map(row => ({
    duelId: row.duel_id,
    atMs: row.created_at_ms,
    opponentId: row.opponent_id,
    opponentName: row.opponent_name,
    kind: row.kind as JournalEntry['kind'],
    stake: row.stake,
    goldDelta: row.gold_delta,
    reason: row.reason,
  }))
}

export function inspectCard(you: PlayerId, other: PlayerId) {
  const row = accountByPlayer(other)
  if (!row) return null
  return publicCard(row, you, livePose(other))
}

export function publicPresenceList() {
  return othersFor('' as PlayerId)
}

/** Test hook: run one accept path without sockets. */
export function acceptForTest(challengeId: string, actor: PlayerId) {
  const fake = lives.get(actor)
  if (fake) onAccept(fake, challengeId)
}

export function seedLiveForTest(playerId: PlayerId, pose: { x: number; z: number }, conn: WsConn) {
  const account = accountByPlayer(playerId)
  if (!account) throw new Error('missing account')
  const now = Date.now()
  const live: Live = {
    playerId,
    accountId: account.account_id,
    conn,
    epoch: 0,
    x: pose.x,
    z: pose.z,
    facing: 0,
    anim: 'idle',
    state: 'exploring',
    muted: new Set(),
    lastMoveAtMs: now,
    awaitingSeed: false,
  }
  live.epoch = claims.take(playerId, live, now).epoch
  lives.set(playerId, live)
  return live
}

export function clearLivesForTest() {
  lives.clear()
  byAccount.clear()
  duels.clear()
  duelByPlayer.clear()
  claims.clear()
}

/* ------------------------------------------------------------------ *
 * Connection health.
 *
 * Two different failures look identical from here and need separate
 * handling. A client that closed cleanly fires `onClose` and is gone. A
 * client whose network vanished — laptop lid, tunnel dropped, NAT entry
 * expired — leaves a socket that is open as far as this process knows and
 * will stay that way indefinitely, holding a claim on a character its
 * owner can no longer reach.
 *
 * The ping is what tells them apart. Anything arriving on the socket
 * counts as proof of life; silence past `STALE_CONNECTION_MS` means the
 * far end is not there and the claim is released so the player can get
 * back in from a new tab.
 * ------------------------------------------------------------------ */

setInterval(() => {
  const now = Date.now()
  for (const live of [...lives.values()]) {
    if (now - live.conn.lastSeenAt > STALE_CONNECTION_MS) {
      live.conn.close(1001, 'stale connection')
      continue
    }
    live.conn.ping()
  }
  sweepPositions(now)
}, HEARTBEAT_INTERVAL_MS).unref()

/**
 * Says goodbye before the instance goes away.
 *
 * Told explicitly that the server is closing, a client waits and then
 * reconnects to whatever replaced it. Left to discover the socket drop on
 * its own it reconnects immediately, at the exact moment the replacement
 * is not yet listening, and burns its backoff on refused connections.
 *
 * Open duels are voided and both stakes returned. Finishing them is not
 * an option inside a shutdown window, and a duel that simply vanishes
 * with the escrow still held is the one outcome nobody would forgive.
 */
export async function drainLive(reconnectAfterMs = 5_000): Promise<void> {
  const now = Date.now()
  for (const sim of [...duels.values()]) {
    closeDuel(sim, {
      kind: 'void',
      winnerId: null,
      loserId: null,
      reason: 'The server restarted mid-duel. Both stakes were returned.',
    }, now)
  }
  for (const live of [...lives.values()]) {
    rememberPosition(live.playerId, live, now)
    try {
      live.conn.send(JSON.stringify({
        t: 'serverClosing',
        reconnectAfterMs,
        detail: 'This world is restarting. You will be reconnected.',
      } satisfies S2C))
    } catch {
      /* the socket is already gone */
    }
  }
  // A beat for those frames to reach the wire before the sockets are torn
  // down; a close that races the message ahead of it teaches the client
  // nothing.
  await new Promise(resolve => setTimeout(resolve, 150))
  for (const live of [...lives.values()]) live.conn.close(1001, 'server restarting')
}

export { duels as _duelsForTest, lives as _livesForTest }
