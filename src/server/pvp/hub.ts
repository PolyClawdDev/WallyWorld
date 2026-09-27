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
  PREPARE_TIMEOUT_MS,
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
import { walletFromAuthHeader } from '../auth'
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
import type { WsConn } from './socket'

type Live = {
  playerId: PlayerId
  accountId: string
  conn: WsConn
  x: number
  z: number
  facing: number
  anim: PublicPresence['anim']
  state: PresenceState
  muted: Set<PlayerId>
}

const lives = new Map<PlayerId, Live>()
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

export function attachLive(tokenHeader: string | undefined, conn: WsConn): Live | null {
  const accountId = walletFromAuthHeader(tokenHeader)
  if (!accountId) {
    conn.send(JSON.stringify({ t: 'error', code: 'unauthenticated', detail: 'Sign in first.' } satisfies S2C))
    conn.close()
    return null
  }
  const account = ensureAccount(accountId)
  const existing = lives.get(account.player_id)
  if (existing) {
    existing.conn.close()
    lives.delete(account.player_id)
  }
  const live: Live = {
    playerId: account.player_id,
    accountId,
    conn,
    x: 8,
    z: 8,
    facing: 0,
    anim: 'idle',
    state: duelByPlayer.has(account.player_id) ? 'dueling' : 'exploring',
    muted: new Set(),
  }
  lives.set(account.player_id, live)
  byAccount.set(accountId, account.player_id)
  conn.onMessage = text => {
    try {
      handle(live, JSON.parse(text) as C2S)
    } catch {
      send(live, { t: 'error', code: 'bad_message', detail: 'Message was not valid JSON.' })
    }
  }
  conn.onClose = () => {
    if (lives.get(account.player_id) === live) {
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
      if (live.state === 'dueling' || live.state === 'preparing') return
      const now = Date.now()
      const last = lastPoseAt.get(live.playerId) ?? 0
      if (now - last < 40) return
      lastPoseAt.set(live.playerId, now)
      if (typeof msg.x !== 'number' || typeof msg.z !== 'number') return
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.z)) return
      live.x = Math.max(-96, Math.min(96, msg.x))
      live.z = Math.max(-96, Math.min(96, msg.z))
      live.facing = Number.isFinite(msg.facing) ? msg.facing : live.facing
      live.anim = msg.anim
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
  }
  if (toLive) {
    toLive.state = 'preparing'
    toLive.x = starts[1].x
    toLive.z = starts[1].z
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
  if (liveA) {
    liveA.state = 'exploring'
    liveA.x = exits[0].x
    liveA.z = exits[0].z
  }
  if (liveB) {
    liveB.state = 'exploring'
    liveB.x = exits[1].x
    liveB.z = exits[1].z
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
      live.x = fighter.x
      live.z = fighter.z
      live.facing = fighter.facing
      live.anim = fighter.anim
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
  const live: Live = {
    playerId,
    accountId: account.account_id,
    conn,
    x: pose.x,
    z: pose.z,
    facing: 0,
    anim: 'idle',
    state: 'exploring',
    muted: new Set(),
  }
  lives.set(playerId, live)
  return live
}

export function clearLivesForTest() {
  lives.clear()
  byAccount.clear()
  duels.clear()
  duelByPlayer.clear()
}

export { duels as _duelsForTest, lives as _livesForTest }
