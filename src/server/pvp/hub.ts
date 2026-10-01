/* ------------------------------------------------------------------ *
 * Live presence, challenges, and duel orchestration.
 *
 * Wallets stay on the session. Every public message uses playerId.
 * ------------------------------------------------------------------ */

import { setInterval } from 'node:timers'
import {
  CHAT_SAY_RADIUS,
  COMBAT_TICK_MS,
  DEMO_GOLD_NOTICE,
  GOLD_KIND,
  HEARTBEAT_INTERVAL_MS,
  PREPARE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  RESULTS_TIMEOUT_MS,
  STALE_CONNECTION_MS,
  type ArenaSeries,
  type C2S,
  type ChatMessage,
  type CombatEvent,
  type DuelOutcomeKind,
  type DuelResultView,
  type JournalEntry,
  type PlayerId,
  type PresenceState,
  type PublicPresence,
  type S2C,
} from '../../shared/pvp'
import { isInTown, TOWN_RESPAWN } from '../../shared/zones'
// Numbers only. `arena/index.ts` builds meshes and imports Three.js; the
// server needs the floor plan, not the floor.
import { ARENA_SLOTS, arenaFrame } from '../../arena/space'
import { ROOM_CAPACITY } from '../config'
import { walletFromAuthHeader } from '../auth'
import { newChatId, systemLine, vetChat } from '../chat/chat'
import { publicDisplayName } from '../moderation/names'
import { CharacterClaims } from './claims'
import { rememberPosition, resolveMove, resumePosition, sweepPositions } from './presence'
import { authoriseRespawn, sweepRespawns } from './respawn'
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
  freeRing,
  markAccepted,
  occupyRing,
  offerChallenge,
  pendingFor,
  pickFreeRing,
  publicCard,
  readChallenge,
  setBlock,
  takeExpiredChallenges,
  youBlocked,
  type Pose,
} from './challenges'
import { DuelSim, type ArenaHost, type DuelEnd } from './combat'
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

/* ------------------------------------------------------------------ *
 * Arena instances.
 *
 * An instance is a private floor with exactly two people on it and a
 * lifetime longer than the match that opened it: a mutual rematch is a new
 * `DuelSim` with a new id and its own escrow, handed the same instance, so
 * the two fighters never leave the floor between matches.
 *
 * THE THING THIS MUST NEVER DO is leave anybody on that floor with no way
 * off it. Every state an instance can be in therefore has a deadline held
 * somewhere outside the players' hands: `loading` by `PREPARE_TIMEOUT_MS`,
 * `countdown` by its own length, `fighting` by `DUEL_CAP_MS`, `results` by
 * `RESULTS_TIMEOUT_MS`, and a dropped socket in any of them by
 * `RECONNECT_GRACE_MS`. `retireDuel` is the single exit and it is reached
 * from all of them, including a settlement that failed and a server drain.
 * ------------------------------------------------------------------ */

type TownPose = { x: number; z: number; facing: number }

type ArenaSession = {
  host: ArenaHost
  ringId: string
  aId: PlayerId
  bId: PlayerId
  stake: number
  /** The match being fought or the one whose results are on screen. */
  sim: DuelSim
  /**
   * Where each fighter was standing in the town, and which way they were
   * facing, at the moment they accepted.
   *
   * This is the only copy. A fighter's `Live` record does not follow them
   * into the arena — see `emitCombat` — so the overworld already believes
   * they are standing here, and restoring it is what makes stepping out of
   * a duel a no-op rather than a teleport the speed clamp has to be argued
   * with. It also means a process that dies mid-duel leaves a remembered
   * position in the town rather than one 512 m outside the world.
   */
  townPose: Map<PlayerId, TownPose>
  /** When a fighter's socket dropped. Cleared when they come back. */
  awayAt: Map<PlayerId, number>
}

/** By arena id. */
const sessions = new Map<string, ArenaSession>()
const sessionByPlayer = new Map<PlayerId, ArenaSession>()
const takenSlots = new Set<number>()

/**
 * Hands out an instance slot, which is what decides where the floor stands.
 *
 * Bounded by `ARENA_SLOTS`, and that bound is never the thing that refuses a
 * duel: a match needs a free duel ring too, and there are four of those.
 */
function takeArenaSlot(): number | null {
  for (let slot = 0; slot < ARENA_SLOTS; slot++) {
    if (takenSlots.has(slot)) continue
    takenSlots.add(slot)
    return slot
  }
  return null
}

function emptySeries(): ArenaSeries {
  return { aWins: 0, bWins: 0, draws: 0 }
}

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
    // The token was presented and is not live here. "Sign in first" was the old
    // wording and it misled every guest, who had nothing to sign into and was
    // already standing in the world: the fix is a new session, not a login.
    conn.send(JSON.stringify({
      t: 'error',
      code: 'unauthenticated',
      detail: 'This world does not recognise that session, so a new one is needed.',
    } satisfies S2C))
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
      // Per-connection scratch, and the only thing holding it was this
      // connection. Left behind it is one entry per player this process has
      // ever seen, for as long as the process lives.
      lastPoseAt.delete(account.player_id)
      const session = sessionByPlayer.get(account.player_id)
      if (session) {
        // Told to the simulation, which forfeits past the grace window while a
        // match is running, and recorded on the session, which is what reaps a
        // fighter who dropped with the results panel up — no match is being
        // stepped then, so nothing else would ever notice.
        session.sim.setConnected(account.player_id, false, Date.now())
        session.awayAt.set(account.player_id, Date.now())
      }
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
  /*
   * Read through the session rather than through `duels`, because a settled
   * match is taken out of `duels` and its two fighters are still in the
   * arena. Looking it up the old way sent `active: null` to somebody standing
   * on the floor, which put their client back in the town while this process
   * went on refusing their poses — the freeze, by another route.
   */
  const session = sessionByPlayer.get(live.playerId)
  const sim = session?.sim
  if (session) {
    session.awayAt.delete(live.playerId)
    session.sim.setConnected(live.playerId, true, Date.now())
  }
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
  sweepExpiredChallenges()
  switch (msg.t) {
    case 'hello': {
      const loadout = parseLoadout(msg.loadout)
      if (!loadout) return send(live, { t: 'error', code: 'bad_loadout', detail: 'Loadout was rejected.' })
      if (live.state === 'dueling' || live.state === 'preparing') {
        return send(live, { t: 'error', code: 'locked', detail: 'Character and loadout are locked during a duel.' })
      }
      // The server decides the name. A blocked or rate-limited one leaves the
      // account with the name it already had; the loadout still lands, so an
      // honest client's appearance is never left out of step with the world.
      // The notice says nothing about which rule fired — see `moderation/names.ts`.
      const saved = saveLoadout(live.playerId, msg.displayName, loadout)
      if (saved.nameOutcome === 'blocked' || saved.nameOutcome === 'rate_limited') {
        send(live, { t: 'error', code: 'name_rejected', detail: 'That name is not available. Your character kept its previous name.' })
      }
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
    case 'rematch':
      return onRematch(live, msg.duelId, msg.on)
    case 'leave':
      return onLeave(live, msg.duelId)
    case 'respawn': {
      // Inside a ring the simulation owns the position outright, and dying
      // there is a duel outcome with its own settlement, not a trip to town.
      if (live.state === 'dueling' || live.state === 'preparing') return
      const now = Date.now()
      const verdict = authoriseRespawn(live.playerId, now)
      if (!verdict.ok) {
        // Nothing moves. The browser has already predicted the plaza, so the
        // ordinary desync correction pulls it back to wherever this player
        // really is — which is the right answer to a claim that could not be
        // justified, and the same answer any other unearned jump would get.
        return send(live, { t: 'error', code: 'respawn_refused', detail: verdict.detail })
      }
      placeLive(live, TOWN_RESPAWN, now)
      live.facing = 0
      live.anim = 'idle'
      broadcastPresence()
      return
    }
    case 'chat':
      return onChat(live, msg)
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

/**
 * Moves a player somewhere this server decided on.
 *
 * The speed budget is re-based with the move, so the first pose afterwards is
 * measured from the new position instead of being read as a teleport back to
 * it. Every authorised reposition goes through here — ring exits and respawns
 * — and the client is not one of them: what it sends is a request, and
 * `resolveMove` is the only path that ever acts on one.
 */
function placeLive(live: Live, at: { x: number; z: number }, now: number) {
  live.x = at.x
  live.z = at.z
  live.lastMoveAtMs = now
  live.awaitingSeed = false
  rememberPosition(live.playerId, live, now)
}

/* ------------------------------------------------------------------ *
 * Chat delivery.
 *
 * `chat/chat.ts` decided whether the message may exist. This decides who
 * hears it, which is the half that needs the hub's private state: `lives`
 * for who is connected, their poses for `/say`, and the block table.
 * ------------------------------------------------------------------ */

/**
 * Whether `listener` has chosen not to hear from `speaker`.
 *
 * The same `youBlocked` row the duel system uses, read in the same
 * direction: blocking somebody stops their challenges AND their words. A
 * block that silenced one but not the other would be a block in name only,
 * since the abuse just moves to whichever half still works.
 */
const deafTo = (listener: PlayerId, speaker: PlayerId) =>
  listener !== speaker && youBlocked(listener, speaker)

/**
 * The one online player going by this name, or null.
 *
 * Names are not unique in this world, so an ambiguous name resolves to
 * nobody rather than to a guess — delivering a private message to the wrong
 * person because two players picked the same label is the one outcome a
 * whisper must never have.
 *
 * Read through `accountByPlayer`, so the name being matched is the SCREENED
 * name every other player can see. A player whose stored name was
 * neutralised is reachable as "Wayfinder" and not as what they typed, which
 * is the only answer consistent with the rest of the protocol.
 */
function whisperTarget(name: string): PlayerId | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  let found: PlayerId | null = null
  for (const id of lives.keys()) {
    if (accountByPlayer(id)?.display_name.toLowerCase() !== wanted) continue
    if (found) return null
    found = id
  }
  return found
}

function onChat(live: Live, frame: Extract<C2S, { t: 'chat' }>) {
  const now = Date.now()
  const verdict = vetChat({ playerId: live.playerId, channel: frame.channel, text: frame.text, to: frame.to, now })
  if (!verdict.ok) {
    // To the sender, and only the sender. A refusal is not an event in the
    // world and nobody else has any business knowing it happened.
    return send(live, { t: 'chat', msg: systemLine(verdict.code, verdict.detail, now) })
  }

  const account = accountByPlayer(live.playerId)
  if (!account) return
  // THE name. Read from the accounts table through the screening accessor in
  // `ids.ts`, not from the frame — which has no name field to read.
  const fromName = account.display_name

  const line: ChatMessage = {
    id: newChatId(),
    channel: verdict.channel,
    fromId: live.playerId,
    fromName,
    text: verdict.text,
    atMs: now,
  }

  if (verdict.channel === 'whisper') {
    const targetId = whisperTarget(verdict.to ?? '')
    if (!targetId) {
      /*
       * One wording for every way a whisper can fail to find someone:
       * nobody online has that name, two players share it, or they logged
       * out a second ago. The sender cannot tell which, so the refusal is
       * not a probe for who is in the world.
       *
       * And the set it could probe is one the server already publishes:
       * every online display name is in the presence broadcast that draws
       * the other players, so there is nothing here to enumerate that a
       * player cannot simply read. What the limit is really for is cost —
       * a whisper spends the same rate budget as any other message.
       */
      return send(live, {
        t: 'chat',
        msg: systemLine('no_target', 'Nobody is listening for that name right now. Nothing was sent.', now),
      })
    }
    const targetName = accountByPlayer(targetId)?.display_name ?? fromName
    // The sender's echo carries the target's name so they can see who they
    // told; the recipient's copy does not, because it would be their own.
    send(live, { t: 'chat', msg: { ...line, toName: targetName } })
    /*
     * A blocked whisper stops here, and the sender's echo above already
     * looked like success. That asymmetry is deliberate and it is the only
     * place in chat where the sender is not told the truth: telling them
     * would out the person who blocked them, which is precisely what a
     * blocked player would use to find someone to harass by another route.
     * A block is the one refusal whose subject is entitled to privacy.
     */
    if (targetId !== live.playerId && !deafTo(targetId, live.playerId)) {
      sendTo(targetId, { t: 'chat', msg: line })
    }
    return
  }

  const near = verdict.channel === 'say'
  for (const listener of lives.values()) {
    if (deafTo(listener.playerId, live.playerId)) continue
    // The sender always hears themselves, so they can see what was published
    // rather than trusting their own client's guess at it.
    if (near && listener.playerId !== live.playerId) {
      if (Math.hypot(listener.x - live.x, listener.z - live.z) > CHAT_SAY_RADIUS) continue
    }
    send(listener, { t: 'chat', msg: line })
  }
}

/**
 * Ends the invitations whose thirty seconds are up, and tells both players.
 *
 * One sweep, called from both the tick and the top of `handle`, because
 * whichever notices first has to be the one that reports it. The silent
 * `expireChallenges` that used to run on every inbound message would take the
 * row out from under the tick, leaving the pair `challenged` for ever with a
 * dead invite on screen and no way to open another duel.
 */
function sweepExpiredChallenges(now = Date.now()) {
  for (const row of takeExpiredChallenges(now)) {
    sendTo(row.from_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'expired' })
    sendTo(row.to_id, { t: 'inviteGone', challengeId: row.challenge_id, reason: 'expired' })
    clearChallenged(row.from_id, row.to_id)
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
    return send(live, { t: 'error', code: 'in_town', detail: 'Duels happen outside town. Step clear of the plaza, the streets and the buildings first.' })
  }
  if (duelByPlayer.has(from.player_id) || duelByPlayer.has(to.player_id)) {
    return send(live, { t: 'error', code: 'busy', detail: 'A fighter is already in a duel.' })
  }

  const ring = pickFreeRing(isBusy, Date.now())
  const slot = takeArenaSlot()
  if (slot === null) {
    return send(live, { t: 'error', code: 'busy', detail: 'Every arena is in use. Try again in a moment.' })
  }
  occupyRing(ring.id)
  const duelId = newId('d')
  const reserved = reserveBoth(from.player_id, to.player_id, pending.stake, duelId)
  if (!reserved.ok) {
    freeRing(ring.id)
    takenSlots.delete(slot)
    return send(live, { t: 'error', code: 'gold', detail: reserved.reason })
  }

  if (!markAccepted(pending, ring.id)) {
    settleEscrow({ duelId, aId: from.player_id, bId: to.player_id, stake: pending.stake, kind: 'refund' })
    freeRing(ring.id)
    takenSlots.delete(slot)
    return send(live, { t: 'error', code: 'gone', detail: 'That invite was already resolved.' })
  }

  const now = Date.now()
  const host: ArenaHost = {
    id: newId('a'),
    frame: arenaFrame(slot),
    matchNumber: 1,
    series: emptySeries(),
    rematch: { a: false, b: false },
    resultsEndsAtMs: null,
    closed: false,
  }
  const sim = new DuelSim({
    duelId,
    challengeId: pending.challenge_id,
    ringId: ring.id,
    arena: host,
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

  const session: ArenaSession = {
    host,
    ringId: ring.id,
    aId: from.player_id,
    bId: to.player_id,
    stake: pending.stake,
    sim,
    townPose: new Map(),
    awayAt: new Map(),
  }
  sessions.set(host.id, session)

  /*
   * Teleporting in is the one thing this block deliberately does NOT do.
   *
   * The fighters go to the arena because the simulation's snapshot says so
   * and their client draws them there. Their overworld record stays exactly
   * where they were standing, so nothing outside the duel — presence, the
   * `/say` radius, the remembered position a crash would resume from — ever
   * sees an arena coordinate. Restoring them afterwards is then a matter of
   * putting back what was never taken away.
   */
  for (const player of [from.player_id, to.player_id]) {
    const fighter = lives.get(player)
    if (!fighter) continue
    fighter.state = 'preparing'
    session.townPose.set(player, { x: fighter.x, z: fighter.z, facing: fighter.facing })
    sessionByPlayer.set(player, session)
  }
  sendTo(from.player_id, { t: 'inviteGone', challengeId: pending.challenge_id, reason: 'accepted' })
  sendTo(to.player_id, { t: 'inviteGone', challengeId: pending.challenge_id, reason: 'accepted' })
  pushDuel(sim)
  broadcastPresence()
}

/**
 * Takes a finished duel apart, with no client in the loop.
 *
 * This is the half that used to be missing, and it was the whole of the
 * freeze. Ending a duel was effectively something the *client* did:
 * `closeDuel` settled the gold and sent a result, and everything else — the
 * `dueling` presence state, the `duelByPlayer` entry, the occupied ring, the
 * simulation itself — waited for a `leave` frame, which only arrived if the
 * player happened to press "Leave Arena". Press "Rematch" instead, or
 * reload, or drop, and both fighters were left with this server refusing
 * their poses and their own client pinning them to the ring. Neither could
 * ever move again, which is exactly what two players fighting each other
 * reported.
 *
 * So the transition lives here. `leave` is now an acknowledgement rather
 * than the mechanism, and the final `ended` snapshot is what tells each
 * client the fight is over — sent independently of the result card, so
 * losing one frame cannot strand anybody.
 */
function retireDuel(sim: DuelSim, now: number, note?: string) {
  const session = sessions.get(sim.arena.id)
  /*
   * `closed` before anything is sent, because it is what makes the final
   * snapshot say "you are out" rather than "the match is over". The client
   * tears its arena down on `arena.phase === 'closed'` and on nothing else,
   * so setting this after the send would ship a frame that leaves both
   * fighters standing on a floor this process has stopped believing in.
   */
  sim.arena.closed = true
  sim.arena.resultsEndsAtMs = null
  for (const playerId of [sim.snapshot('x').a.playerId, sim.snapshot('x').b.playerId]) {
    duelByPlayer.delete(playerId)
    sessionByPlayer.delete(playerId)
    const live = lives.get(playerId)
    if (!live) continue
    live.state = 'exploring'
    live.anim = 'idle'
    /*
     * Back to the town position and orientation saved when the challenge was
     * accepted. In the ordinary case this is where `live` already is — the
     * arena never touched it — so the restore is an assertion rather than a
     * move, and the one thing it does change is `facing`, which the fighter
     * did turn while they were in there.
     *
     * The speed budget is re-based either way: measured from the accept, the
     * first step after a three-minute duel reads as standing still, and
     * measured from nothing at all it reads as a teleport.
     */
    const home = session?.townPose.get(playerId) ?? { x: live.x, z: live.z, facing: live.facing }
    live.facing = home.facing
    placeLive(live, home, now)
    send(live, { t: 'duel', snapshot: sim.snapshot(playerId) })
    if (note) send(live, { t: 'error', code: 'settlement', detail: note })
  }
  freeRing(sim.ring.id)
  takenSlots.delete(sim.arena.frame.slot)
  duels.delete(sim.duelId)
  sessions.delete(sim.arena.id)
  broadcastPresence()
}

/**
 * The match is settled and the two of them are still on the floor.
 *
 * This is the half of the brief that does not fit "a duel ends and everyone
 * goes home": the result is read in the arena, a rematch happens in the same
 * arena, and the score is kept across both. So settlement stops the
 * simulation without retiring the instance.
 *
 * What keeps that from being the freeze bug again is that it is not a wait
 * for a client to do something. `resultsEndsAtMs` is a deadline the sweep
 * below enforces, a dropped socket is reaped by the same sweep, and either
 * player may end it alone. The sim is taken out of `duels` so the combat
 * tick stops stepping a finished fight.
 */
function enterResults(sim: DuelSim, now: number) {
  const session = sessions.get(sim.arena.id)
  if (!session) return retireDuel(sim, now)
  sim.arena.rematch = { a: false, b: false }
  sim.arena.resultsEndsAtMs = now + RESULTS_TIMEOUT_MS
  duels.delete(sim.duelId)
  // Still `dueling` as far as the town is concerned: these two are not
  // available to be challenged by a third party while they are in here.
  pushDuel(sim)
}

/**
 * Another match in this instance, once both have asked for one.
 *
 * A rematch is a NEW match — new id, new escrow, its own row — fought on the
 * same floor. Rebuilding it as a fresh challenge is what it used to be, and
 * that meant a new ring, a new instance, another walk out of town and a
 * score that reset every time.
 */
function onRematch(live: Live, duelId: string, on: boolean) {
  const session = sessionByPlayer.get(live.playerId)
  if (!session || session.sim.duelId !== duelId) {
    return send(live, { t: 'error', code: 'gone', detail: 'That match is no longer on offer.' })
  }
  if (session.sim.arenaPhase() !== 'results') {
    return send(live, { t: 'error', code: 'phase', detail: 'A rematch can only be offered after a match has settled.' })
  }
  const side = live.playerId === session.aId ? 'a' : 'b'
  session.host.rematch[side] = on
  if (session.host.rematch.a && session.host.rematch.b) startRematch(session, Date.now())
  else pushDuel(session.sim)
}

function startRematch(session: ArenaSession, now: number) {
  const from = accountByPlayer(session.aId)
  const to = accountByPlayer(session.bId)
  if (!from || !to) return retireDuel(session.sim, now, 'A fighter is no longer in this world.')

  const duelId = newId('d')
  /*
   * Its own challenge id, because `pvp_duels.challenge_id` is unique and a
   * rematch is a second agreement between the same two people rather than a
   * second acceptance of the first. There is no row in `pvp_challenges` for
   * it: nothing was offered, declined or expired, and inventing one would
   * put an invite in the record that no player ever saw.
   */
  const challengeId = newId('c')
  const reserved = reserveBoth(session.aId, session.bId, session.stake, duelId)
  if (!reserved.ok) {
    // The offers come down and the results panel stays up, still on its own
    // deadline. Nobody is stuck and nobody has been charged.
    session.host.rematch = { a: false, b: false }
    for (const id of [session.aId, session.bId]) {
      sendTo(id, { t: 'error', code: 'gold', detail: reserved.reason })
    }
    return pushDuel(session.sim)
  }

  session.host.matchNumber += 1
  session.host.rematch = { a: false, b: false }
  session.host.resultsEndsAtMs = null
  const sim = new DuelSim({
    duelId,
    challengeId,
    ringId: session.ringId,
    arena: session.host,
    stake: session.stake,
    a: { id: session.aId, name: from.display_name, loadout: loadoutOf(from) },
    b: { id: session.bId, name: to.display_name, loadout: loadoutOf(to) },
    now,
  })
  insertDuel.run({
    duel_id: duelId,
    challenge_id: challengeId,
    a_id: session.aId,
    b_id: session.bId,
    ring_id: session.ringId,
    stake: session.stake,
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
    challenge_id: challengeId,
    a_id: session.aId,
    b_id: session.bId,
    stake: session.stake,
    pot: session.stake * 2,
    now,
  })
  session.sim = sim
  duels.set(duelId, sim)
  duelByPlayer.set(session.aId, duelId)
  duelByPlayer.set(session.bId, duelId)
  // Back through the same both-ready gate as the first match. The clients are
  // already standing in the arena, so their ready arrives immediately — but
  // it is the same one code path, bounded by the same prepare timeout.
  pushDuel(sim)
}

/**
 * The client saying it has closed the result card.
 *
 * By the time this arrives the duel is normally already retired, which is
 * the point — it is no longer load-bearing. What is left is the defensive
 * case: a client holding a snapshot this process no longer has must still
 * be able to get itself marked as out of the duel, or a lost frame would be
 * a trap again.
 */
/**
 * A player leaving the arena.
 *
 * Either of them may, alone, and it ends the instance for both: there is no
 * match left to fight and the alternative is one person standing on a floor
 * waiting out a deadline for company that is not coming back. Their opponent
 * is told, and put back in the town by the same path as every other exit.
 *
 * Refused while a match is being fought — that is what surrender is for, and
 * it costs the stake. The defensive branch at the bottom is the one that is
 * load-bearing: a client holding a snapshot this process no longer has must
 * still be able to get itself marked as out, or a lost frame is a trap.
 */
function onLeave(live: Live, duelId: string) {
  const session = sessionByPlayer.get(live.playerId)
  if (session && session.sim.duelId === duelId) {
    const phase = session.sim.arenaPhase()
    if (phase === 'results') {
      const other = live.playerId === session.aId ? session.bId : session.aId
      sendTo(other, { t: 'error', code: 'opponent_left', detail: 'Your opponent left the arena. You are back in the town.' })
      retireDuel(session.sim, Date.now())
      return
    }
    // Loading, counting down or fighting: this is not the frame for it.
    return send(live, { t: 'error', code: 'phase', detail: 'The match is still running. Surrender if you want out of it.' })
  }
  if (!duelByPlayer.has(live.playerId) && (live.state === 'dueling' || live.state === 'preparing')) {
    live.state = 'exploring'
    placeLive(live, live, Date.now())
    broadcastPresence()
  }
}

function pushDuel(sim: DuelSim) {
  const snap = sim.snapshot('x')
  for (const id of [snap.a.playerId, snap.b.playerId]) {
    const live = lives.get(id)
    if (!live) continue
    /*
     * `preparing` only while the arena is being loaded into; anything past
     * that is `dueling`, including the results panel. Presence is what stops
     * a third player challenging somebody who is standing in an arena, so it
     * has to stay set until they are actually out of it.
     */
    live.state = sim.phase === 'preparing' ? 'preparing' : 'dueling'
    send(live, { t: 'duel', snapshot: sim.snapshot(id) })
  }
  broadcastPresence()
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

/**
 * Duels this process has already settled, and when.
 *
 * `closeDuel` is reachable from the combat tick, from a prepare timeout and
 * from a shutdown drain, and the escrow must move exactly once however many
 * of those fire. The timestamp is what stops this being a set that only
 * grows: a long-lived instance would otherwise keep one entry per duel for
 * the life of the process.
 */
const settledDuels = new Map<string, number>()

/** How long a settled duel id is remembered, purely to keep settlement idempotent. */
const SETTLED_MEMORY_MS = 10 * 60 * 1000

function closeDuel(sim: DuelSim, end: DuelEnd, now: number) {
  if (settledDuels.has(sim.duelId)) return
  settledDuels.set(sim.duelId, now)
  const snap = sim.snapshot(sim.snapshot('x').a.playerId)
  const aId = snap.a.playerId
  const bId = snap.b.playerId
  const settlement = end.kind === 'victory' || end.kind === 'forfeit'
    ? settleEscrow({ duelId: sim.duelId, aId, bId, stake: sim.stake, kind: 'payout', winnerId: end.winnerId, now })
    : settleEscrow({ duelId: sim.duelId, aId, bId, stake: sim.stake, kind: end.kind === 'void' ? 'void' : 'refund', now })

  if (!settlement.ok) {
    // A settlement that will not go through must not also strand two players
    // in a ring. The duel row is deliberately left open, so the next boot's
    // `recoverOpenDuels` voids it and returns both stakes; what cannot wait
    // for a restart is the two people standing in it.
    retireDuel(sim, now, `The duel could not be settled (${settlement.reason}). Both stakes are still held and are returned automatically.`)
    return
  }

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
  // A draw has no winner and no loser, so the two ids have to come from the
  // fighters. Passing the outcome's nulls straight through recorded a drawn
  // duel against nobody, and the D column never moved. A `void` is left
  // uncounted on purpose: a server restart or an abandoned ring is not a
  // result either of them fought to.
  if (end.kind === 'draw') recordOutcome(aId, bId, true, now)
  else if (!draw) recordOutcome(end.winnerId, end.loserId, false, now)

  /*
   * The session score, which is the instance's tally and not the account's.
   * `recordOutcome` above is the lifetime W/L/D; this is "best of however
   * many you two feel like", and it exists because a rematch that forgot the
   * last match is not a rematch. A `void` is not counted for the same reason
   * it is not recorded above: a restart is not a result anybody fought to.
   */
  const series = sim.arena.series
  if (end.kind === 'draw') series.draws += 1
  else if (end.kind !== 'void') {
    if (end.winnerId === aId) series.aWins += 1
    else if (end.winnerId === bId) series.bWins += 1
  }

  for (const id of [aId, bId]) {
    const youWon = end.winnerId === id
    const delta = draw || end.kind === 'void' ? 0 : youWon ? sim.stake : -sim.stake
    const kind = outcomeKind(end, id)
    writeJournal(sim.duelId, id, id === aId ? bId : aId, kind, sim.stake, delta, end.reason, now)
    const gold = goldView(id)
    const rec = gold
    const result: DuelResultView = {
      duelId: sim.duelId,
      arenaId: sim.arena.id,
      matchNumber: sim.arena.matchNumber,
      series: {
        yours: id === aId ? series.aWins : series.bWins,
        theirs: id === aId ? series.bWins : series.aWins,
        draws: series.draws,
      },
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

  // Settled is not the same as over, and over is not the same as out. The
  // match stops here and the two of them stay on the floor to read the
  // result and decide about another one — on a deadline, enforced below.
  enterResults(sim, now)
}

setInterval(() => {
  const now = Date.now()
  // An invitation nobody answered ends on its own, and both players are told
  // so: the row expiring is not the same as them being free again.
  sweepExpiredChallenges(now)
  for (const sim of [...duels.values()]) {
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
  /*
   * Nobody is left standing in a settled arena.
   *
   * Two ways out, both of them clocks rather than decisions: the fighter who
   * dropped is not coming back inside the reconnect window, or the results
   * panel has simply been up long enough. Iterating a copy because both
   * paths retire the instance, which mutates `sessions`.
   */
  for (const session of [...sessions.values()]) {
    const host = session.host
    if (host.resultsEndsAtMs === null) continue
    const gone = [...session.awayAt.values()].some(at => now - at >= RECONNECT_GRACE_MS)
    if (gone) {
      retireDuel(session.sim, now, 'Your opponent did not come back. You are back in the town.')
      continue
    }
    if (now >= host.resultsEndsAtMs) retireDuel(session.sim, now)
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

/**
 * The 20 Hz frame the two fighters run on, and nobody else.
 *
 * It used to copy each fighter's simulated position onto their `Live` record,
 * which is what the whole town reads. That was right when a duel was fought
 * on town ground and wrong now: an arena is 512 m outside the world, so
 * publishing those coordinates would put both duellists off the map for
 * every other player, feed them to the `/say` radius, and — worst — write
 * them into the remembered position that a reconnect resumes from, stranding
 * anyone whose process died mid-duel outside the world.
 *
 * So the town's copy of a duellist does not move. It stays where they were
 * standing when they accepted, which is exactly where they are put back.
 * The arena positions live only in this frame, and only the two people in it
 * ever receive one.
 */
function emitCombat(sim: DuelSim, events: CombatEvent[]) {
  const snap = sim.snapshot('x')
  for (const id of [snap.a.playerId, snap.b.playerId]) {
    sendTo(id, { t: 'combat', snapshot: sim.snapshot(id), events })
  }
}

export function journalFor(playerId: PlayerId, limit = 40): JournalEntry[] {
  return listJournal.all(playerId, limit).map(row => ({
    duelId: row.duel_id,
    atMs: row.created_at_ms,
    opponentId: row.opponent_id,
    // A historic snapshot, screened on read for the same reason as an old invite.
    opponentName: publicDisplayName(row.opponent_name),
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
  sessions.clear()
  sessionByPlayer.clear()
  takenSlots.clear()
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
  sweepRespawns(now)
  for (const [duelId, at] of settledDuels) {
    if (now - at > SETTLED_MEMORY_MS) settledDuels.delete(duelId)
  }
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
  /*
   * And then every instance, including the ones whose match had already
   * settled and whose fighters were reading the result. `closeDuel` leaves
   * those standing in the arena on purpose; a shutdown is the one moment that
   * is not a courtesy, and a player who reconnects to the replacement has to
   * arrive in the town rather than on a floor that no longer exists.
   */
  for (const session of [...sessions.values()]) {
    retireDuel(session.sim, now, 'This world is restarting, so the arena closed. You are back in the town.')
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
