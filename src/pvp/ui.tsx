import React, { useEffect, useState } from 'react'
import { ChatBox } from '../chat/ChatBox'
import { wizards } from '../characters'
import { DEMO_GOLD_NOTICE, type DuelSnapshot, type PublicCard, type PublicPresence } from '../shared/pvp'
import { wayOutOfTown } from './leaveTown'
import { fetchPvpJournal, reclaimPvp, retryPvp, send } from './net'
import { isDuelLocked, pingPvp, pvpState, subscribePvp, type PvpLink } from './store'
import './pvp.css'

function usePvp() {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribePvp(() => setTick(n => n + 1))
  }, [])
  return pvpState
}

function GoldNote() {
  return <p className="pvp-demo">{DEMO_GOLD_NOTICE} · not SOL and not wallet funds</p>
}

export function PvpOverlay() {
  const s = usePvp()
  return (
    <div className="pvp-layer" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {s.superseded && <SupersededCard />}
      {!s.connected && !s.superseded && <JoinChip link={s.link} />}
      {/* Only while gold is actually staked. This used to sit in the corner for
          the whole session restating a balance the pouch already shows, with a
          "NOT REDEEMABLE" line the pouch and the PVP ledger both state anyway.
          Escrow is the one thing a player cannot see anywhere else and must not
          miss, so that is what is left. */}
      {s.signedIn && s.connected && s.gold.reserved > 0 && (
        <div className="pvp-chip pvp-gold-chip">
          ✦ {s.gold.reserved} GOLD<small> · staked in a duel</small>
        </div>
      )}
      {s.error && <div className="pvp-error" onClick={() => { pvpState.error = null; pingPvp() }}>{s.error}</div>}
      {s.inspect && !s.composer && <InspectCard />}
      {s.composer && <ChallengeComposer />}
      {s.invite && <InviteCard />}
      {s.duel && <DuelHud />}
      {s.result && <ResultCard />}
      {/* Chat lives here rather than in `main.tsx` because this overlay is
          already mounted in the HUD, already a child of `.pvp-layer` (which
          is what gives it pointer events while the rest of the layer stays
          transparent to the world), and already the place the shared-world
          connection's UI lives — which is what chat is. It is rendered
          unconditionally: a chat box that appears and disappears with the
          connection is a chat box nobody learns the position of, and it has
          something useful to say while offline. */}
      <ChatBox />
    </div>
  )
}

/**
 * What the player is told while they are not in the shared world.
 *
 * The rule is that it may not claim to be doing something it is not. "Joining"
 * is only true for an attempt that has not failed yet; past a few failures the
 * chip names what went wrong and offers the one useful action, because a
 * spinner that never resolves is worse than a sentence that admits the problem.
 * It is gone entirely the moment `welcome` arrives — there is no residual strip.
 */
function JoinChip({ link }: { link: PvpLink }) {
  if (link.phase === 'offline') {
    return (
      <div className="pvp-chip pvp-chip-offline" role="status">
        <b>Could not reach the shared world</b>
        <span>{link.reason ?? 'The presence connection did not come up.'}</span>
        <span className="pvp-chip-foot">
          {link.attempts} failed attempt{link.attempts === 1 ? '' : 's'}
          {link.retrying ? ' · still retrying in the background' : ' · not retrying'}
          {' · the rest of the game keeps working'}
        </span>
        <button type="button" onClick={() => retryPvp()}>Try again now</button>
      </div>
    )
  }
  return (
    <div className="pvp-chip" role="status">
      {link.phase === 'retrying' ? `Reconnecting to the shared town… (attempt ${link.attempts + 1})` : 'Joining the shared town…'}
      {link.phase === 'retrying' && link.attempts > 1 && link.reason && <small>{link.reason}</small>}
    </div>
  )
}

/**
 * One character, one tab.
 *
 * Shown to the tab that lost the claim. It is a prompt rather than an
 * automatic recovery on purpose: reconnecting from here takes the
 * character back, so doing it silently would put the two tabs straight
 * into a loop of evicting each other.
 */
function SupersededCard() {
  return (
    <div className="pvp-card pvp-superseded">
      <h3>Playing somewhere else</h3>
      <p>
        This character was opened in another tab or on another device. Only one can control a wizard at a time, so this
        one has stopped.
      </p>
      <div className="pvp-actions">
        <button type="button" onClick={() => reclaimPvp()}>Play here instead</button>
      </div>
      <p className="pvp-demo">Taking it back here will stop the other tab.</p>
    </div>
  )
}

/**
 * Why the Challenge button is dead, in the player's language.
 *
 * Five separate rules can close this button and they are not
 * interchangeable — one is fixed by walking, one by waiting, one by
 * hunting, and two cannot be fixed by this player at all. The button used
 * to carry the only one of them that had any words attached, inside its own
 * label, which left the other four looking like a bug: a button that says
 * "Challenge" and does nothing.
 *
 * So the reasons are text and the button is a button. Every rule here has a
 * counterpart on the server — `offerChallenge` and `onAccept` refuse the
 * same things — and nothing in this list is what enforces them. It exists so
 * a refusal is legible before it happens, not instead of it.
 */
function challengeBlockers(card: PublicCard, self: PublicPresence | null): string[] {
  const reasons: string[] = []
  const them = card.displayName

  if (self?.inTown) {
    const out = wayOutOfTown(self.x, self.z)
    reasons.push(
      out
        ? `You are in town, and town is protected — duels happen on open ground only. Town is the plaza and every paved street, so walking further up a road will not leave it. The nearest open ground is about ${out.metres} m ${out.heading} of you.`
        : 'You are in town, and town is protected — duels happen on open ground only. Town is the plaza and every paved street, so step off the paving onto the grass.',
    )
  }
  if (card.inTown) {
    reasons.push(`${them} is in town, where nobody can be challenged. They have to walk out onto open ground themselves.`)
  }
  if (card.state !== 'exploring') {
    reasons.push(stateBlocker(them, card.state))
  }
  if (pvpState.gold.available <= 0 && card.goldAvailable <= 0) {
    reasons.push('A duel stakes the same amount of gold from each side, and neither of you has any available to stake.')
  } else if (pvpState.gold.available <= 0) {
    reasons.push(
      pvpState.gold.reserved > 0
        ? `A duel stakes gold from both sides, and all ${pvpState.gold.reserved} of your gold is already held in escrow.`
        : 'A duel stakes gold from both sides, and you have none available. Hunt for a while and come back.',
    )
  } else if (card.goldAvailable <= 0) {
    reasons.push(`A duel stakes the same amount from each side, and ${them} has no gold available to match you.`)
  }
  if (card.theyBlockedYou) reasons.push(`${them} has blocked you.`)
  if (card.incomingDisabled) reasons.push(`${them} has turned incoming challenges off.`)

  return reasons
}

function stateBlocker(them: string, state: PublicCard['state']): string {
  switch (state) {
    case 'dueling':
      return `${them} is in the middle of a duel. Wait for it to settle.`
    case 'preparing':
      return `${them} is about to start a duel. Wait for it to settle.`
    case 'challenged':
      return `${them} already has a challenge waiting on an answer.`
    case 'disconnected':
      return `${them} has dropped out of the world.`
    default:
      return `${them} is not out exploring right now, so there is nobody to challenge.`
  }
}

function InspectCard() {
  const card = pvpState.inspect!
  const you = pvpState.self
  const available = Math.min(pvpState.gold.available, card.goldAvailable)
  const blockers = challengeBlockers(card, you)
  return (
    <aside className="pvp-card" role="dialog" aria-label="Player card">
      <button className="pvp-x" onClick={() => { pvpState.inspect = null; pingPvp() }}>×</button>
      <div className="pvp-swatch" style={{ background: wizards[card.loadout.character].accent }} />
      <div className="wui-etch">WAYFINDER</div>
      <h3>{card.displayName}</h3>
      <p>{wizards[card.loadout.character].name} · Lv {card.loadout.level}</p>
      <dl className="pvp-stats">
        <div><dt>Game gold</dt><dd>{card.goldTotal}</dd></div>
        <div><dt>Available</dt><dd>{card.goldAvailable}</dd></div>
        <div><dt>W / L / D</dt><dd>{card.wins} / {card.losses} / {card.draws}</dd></div>
      </dl>
      <GoldNote />
      <div className="pvp-actions">
        <button
          className="primary"
          disabled={blockers.length > 0}
          onClick={() => { pvpState.composer = card; pingPvp() }}
        >
          Challenge
        </button>
        <button onClick={() => {
          const on = !pvpState.muted.has(card.playerId)
          if (on) pvpState.muted.add(card.playerId)
          else pvpState.muted.delete(card.playerId)
          pingPvp()
        }}>{pvpState.muted.has(card.playerId) ? 'Unmute' : 'Mute'}</button>
        <button onClick={() => {
          const on = !card.youBlockedThem
          send({ t: 'block', playerId: card.playerId, on })
          send({ t: 'inspect', playerId: card.playerId })
        }}>{card.youBlockedThem ? 'Unblock' : 'Block'}</button>
      </div>
      {blockers.length > 0
        ? blockers.map(reason => <p className="pvp-why" key={reason}>{reason}</p>)
        : (
          <p className="pvp-wager">
            You each stake the same gold — up to {available} apiece, {available * 2} to the winner. The server holds both
            stakes while you fight and pays out on the result.
          </p>
        )}
    </aside>
  )
}

function ChallengeComposer() {
  const card = pvpState.composer!
  const max = Math.min(pvpState.gold.available, card.goldAvailable)
  const [stake, setStake] = useState(Math.min(10, max) || 0)
  const pot = stake * 2
  return (
    <aside className="pvp-card pvp-wide" role="dialog" aria-label="Challenge wager">
      <button className="pvp-x" onClick={() => { pvpState.composer = null; pingPvp() }}>×</button>
      <div className="wui-etch">EQUAL STAKES</div>
      <h3>Challenge {card.displayName}</h3>
      <p>{wizards[card.loadout.character].name} · Lv {card.loadout.level} · you are Lv {pvpState.self?.loadout.level ?? 1}</p>
      <dl className="pvp-stats">
        <div><dt>Your available</dt><dd>{pvpState.gold.available}</dd></div>
        <div><dt>Their available</dt><dd>{card.goldAvailable}</dd></div>
        <div><dt>Stake each</dt><dd>{stake}</dd></div>
        <div><dt>Winner receives</dt><dd>{pot}</dd></div>
      </dl>
      <label className="pvp-stake">
        Stake
        <input type="number" min={1} max={max} step={1} value={stake} onChange={e => setStake(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
      </label>
      <div className="pvp-actions">
        <button onClick={() => setStake(n => Math.max(1, n - 10))}>-10</button>
        <button onClick={() => setStake(n => Math.min(max, n + 10))}>+10</button>
        <button onClick={() => setStake(max)}>Maximum both can stake</button>
      </div>
      <p className="pvp-loc">Location: nearest outdoor ring · no house fee · kits stay as they are</p>
      <p className="pvp-wager">
        Both stakes are taken the moment {card.displayName} accepts and held until the duel settles — they leave your
        available balance together or not at all. A draw, a server restart or an unfinished duel returns both.
      </p>
      <GoldNote />
      <button
        className="primary full"
        disabled={stake < 1 || stake > max}
        onClick={() => {
          send({ t: 'challenge', playerId: card.playerId, stake })
          pvpState.composer = null
          pingPvp()
        }}
      >
        Send challenge · {stake} each
      </button>
    </aside>
  )
}

function InviteCard() {
  const invite = pvpState.invite!
  return (
    <aside className="pvp-card pvp-invite" role="dialog" aria-label="Duel invite">
      <div className="wui-etch">CHALLENGE</div>
      <h3>{invite.fromName} challenges you.</h3>
      <p>Each player stakes {invite.stake} gold. Winner receives {invite.pot} gold.</p>
      <p>Arena: {invite.ringName}. Levels {invite.fromLevel} vs {invite.toLevel}.</p>
      <GoldNote />
      <div className="pvp-actions">
        <button className="primary" onClick={() => send({ t: 'accept', challengeId: invite.challengeId })}>Accept</button>
        <button onClick={() => send({ t: 'decline', challengeId: invite.challengeId })}>Decline</button>
      </div>
    </aside>
  )
}

/**
 * The duel HUD's own 100 ms beat, shared by everything in it that counts.
 *
 * The presence tick is twelve a second and lands wherever the network put it;
 * a number that changes on a whole second has to change ON that second. One
 * interval for the whole HUD rather than one per readout: two intervals
 * started at different moments tick at different offsets, so the countdown
 * digit and the round clock beside it would disagree about when a second
 * turned.
 */
function useHudClock() {
  const [, setBeat] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setBeat(n => n + 1), 100)
    return () => clearInterval(timer)
  }, [])
}

/** m:ss, for a clock that is read at a glance in the middle of a fight. */
function clockText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * "3", "2", "1", "FIGHT".
 *
 * Driven off `countdownEndsAtMs`, which is a server timestamp both clients
 * receive in the same frame, so the two screens count together rather than
 * each running its own timer from whenever it happened to notice. The last
 * beat reads FIGHT rather than 0 because 0 is not a number anybody counts to,
 * and it is also the moment damage actually becomes possible.
 *
 * Re-rendered by `useHudClock` in `DuelHud`, which is mounted for the whole
 * duel and is the only interval the HUD runs.
 */
function Countdown({ endsAtMs }: { endsAtMs: number }) {
  const left = endsAtMs - Date.now()
  if (left <= 0) return <div className="pvp-count is-go" aria-live="assertive">FIGHT</div>
  return <div className="pvp-count" aria-live="assertive" key={Math.ceil(left / 1000)}>{Math.ceil(left / 1000)}</div>
}

/**
 * How long this round has been running, counted up from the server's clock.
 *
 * `roundStartedAtMs` is the tick on which the simulation enabled combat, sent
 * to both clients in the same snapshot — the same arrangement as the
 * countdown's deadline and for the same reason. Noting the time locally on
 * the frame a client happened to notice the phase change would give the two
 * fighters two different round lengths, drifting further apart the longer
 * they fought.
 *
 * Quiet on purpose. It sits in the meta line under the health bars rather
 * than anywhere near the middle of the screen: during a fight the loudest
 * thing in the HUD should be the two HP numbers.
 */
function RoundClock({ startedAtMs }: { startedAtMs: number }) {
  return <b className="pvp-duel-clock" aria-label="Round time">{clockText(Date.now() - startedAtMs)}</b>
}

/** The session score from this client's own side. A snapshot is symmetric; a reader is not. */
function seriesLine(duel: DuelSnapshot) {
  const { aWins, bWins, draws } = duel.arena.series
  const iAmA = duel.a.playerId === duel.you
  return { mine: iAmA ? aWins : bWins, theirs: iAmA ? bWins : aWins, draws, fought: aWins + bWins + draws }
}

function DuelHud() {
  useHudClock()
  const duel = pvpState.duel!
  const you = duel.a.playerId === pvpState.playerId ? duel.a : duel.b
  const foe = you === duel.a ? duel.b : duel.a
  const phase = duel.arena.phase
  const score = seriesLine(duel)
  return (
    <div className="pvp-duel-hud">
      {phase === 'countdown' && duel.countdownEndsAtMs && <Countdown endsAtMs={duel.countdownEndsAtMs} />}
      <div className="pvp-duel-bar">
        <strong>{you.displayName}</strong>
        <span>{you.hp}/{you.maxHp}</span>
        <em>vs</em>
        <strong>{foe.displayName}</strong>
        <span>{foe.hp}/{foe.maxHp}</span>
      </div>
      <div className="pvp-duel-meta">
        {/* Named "match N" rather than by the ring, because the ring is now
            only a booking: the fight happens in an instance of its own. */}
        {phase === 'loading' && 'Building the arena…'}
        {phase === 'countdown' && 'On your marks.'}
        {phase === 'fighting' && `Match ${duel.arena.matchNumber} · pot ${duel.pot} · ${DEMO_GOLD_NOTICE} · `}
        {phase === 'fighting' && duel.roundStartedAtMs !== null && <RoundClock startedAtMs={duel.roundStartedAtMs} />}
        {phase === 'results' && 'Match over.'}
        {score.fought > 0 && <b> Session {score.mine}–{score.theirs}{score.draws ? ` (${score.draws}D)` : ''}</b>}
        {duel.reconnectUntilMs && <b> Waiting on a reconnect…</b>}
      </div>
      {/* No manual Ready button. The gate is answered by the client the moment
          its floor is up — see the arena block in main.tsx — which is what
          makes it a load gate rather than a click nobody understands. */}
      {phase === 'fighting' && !pvpState.surrenderAsk && (
        <button onClick={() => { pvpState.surrenderAsk = true; pingPvp() }}>Forfeit</button>
      )}
      {pvpState.surrenderAsk && (
        <div className="pvp-actions">
          {/* Asked, never done on one press: a forfeit hands the whole pot to
              the other player, and it is one button away from the ability keys. */}
          <button className="primary" onClick={() => send({ t: 'surrender', duelId: duel.duelId })}>
            Forfeit · lose {duel.stake}
          </button>
          <button onClick={() => { pvpState.surrenderAsk = false; pingPvp() }}>Keep fighting</button>
        </div>
      )}
    </div>
  )
}

/**
 * The compact results panel, read standing in the arena.
 *
 * Deliberately small: it sits over a floor the player is still on, with their
 * opponent standing across it, and a full-screen scoreboard would hide the one
 * thing worth looking at. The score above the buttons is the session's, not the
 * account's — "how are we doing tonight" is the question a rematch asks.
 *
 * Rematch is MUTUAL and it is not a new challenge. Pressing it puts an offer
 * up; the match starts when both are standing, in the same instance, with the
 * score carried over. Pressing it again withdraws it, because an offer you
 * cannot take back is a trap of a smaller kind.
 */
function ResultCard() {
  const result = pvpState.result!
  const duel = pvpState.duel
  const arena = duel?.arena ?? null
  const you = duel ? (duel.a.playerId === pvpState.playerId ? 'a' : 'b') : null
  const yours = arena && you ? arena.rematch[you] : false
  const theirs = arena && you ? arena.rematch[you === 'a' ? 'b' : 'a'] : false
  // The arena is gone once the instance closes, and with it any rematch: what
  // is left on the card is the record of what happened.
  const stillInside = Boolean(arena && arena.phase === 'results')
  return (
    <aside className="pvp-card pvp-result" role="dialog" aria-label="Duel result">
      <div className="wui-etch">MATCH {result.matchNumber}</div>
      <h3>{result.kind === 'draw' || result.kind === 'void' || result.refunded ? 'Draw' : result.kind === 'victory' ? 'Victory' : 'Defeat'}</h3>
      <p>{result.reason}</p>
      {/* Six stats in the same two-column grid the other cards use, so the
          panel grows by one row rather than by a section. The opponent used
          to be named only inside the rematch button's label, which left the
          card reading as a result against nobody. The duration is the
          server's own measurement — see `roundMs` — so the two fighters are
          not shown two lengths for the round they just fought. */}
      <dl className="pvp-stats">
        <div><dt>Opponent</dt><dd>{result.opponentName}</dd></div>
        <div><dt>Session</dt><dd>{result.series.yours}–{result.series.theirs}{result.series.draws ? ` · ${result.series.draws}D` : ''}</dd></div>
        <div><dt>Round</dt><dd>{clockText(result.roundMs)}</dd></div>
        <div><dt>Stake</dt><dd>{result.stake}</dd></div>
        <div><dt>Net gold</dt><dd>{result.yourDelta >= 0 ? `+${result.yourDelta}` : result.yourDelta}</dd></div>
        <div><dt>Balance</dt><dd>{result.yourBalance}</dd></div>
      </dl>
      <GoldNote />
      {stillInside ? (
        <>
          <div className="pvp-actions">
            <button
              className={yours ? 'primary pvp-armed' : 'primary'}
              onClick={() => send({ t: 'rematch', duelId: result.duelId, on: !yours })}
            >
              {yours ? 'Waiting · cancel' : `Rematch · ${result.stake} each`}
            </button>
            <button onClick={() => send({ t: 'leave', duelId: result.duelId })}>Leave arena</button>
          </div>
          <p className="pvp-why">
            {theirs && !yours
              ? `${result.opponentName} has asked for another match. Both of you have to agree.`
              : yours
                ? `Waiting for ${result.opponentName}. Another ${result.stake} is staked when they agree.`
                : 'A rematch is fought here, in this arena, and the session score carries over.'}
          </p>
        </>
      ) : (
        <>
          <div className="pvp-actions">
            <button className="primary" onClick={() => { pvpState.result = null; pingPvp() }}>Close</button>
          </div>
          <p className="pvp-why">The arena has closed and you are back in the town.</p>
        </>
      )}
    </aside>
  )
}

export function PvpJournal() {
  const s = usePvp()
  useEffect(() => { void fetchPvpJournal() }, [])
  return (
    <div className="pvp-journal">
      <div className="jr-ledger-head"><span>PVP LEDGER</span><b>REAL IN-GAME GOLD</b></div>
      <p className="pvp-demo">{DEMO_GOLD_NOTICE} W / L / D · {s.gold.wins} / {s.gold.losses} / {s.gold.draws} · available {s.gold.available}</p>
      <label className="st-toggle" style={{ margin: '8px 0' }}>
        <input
          type="checkbox"
          checked={s.incomingDisabled}
          onChange={e => send({ t: 'settings', incomingDisabled: e.target.checked })}
        />
        <span className="st-label">Refuse incoming challenges</span>
      </label>
      {!s.journal.length && <p className="jr-empty">No duels yet. Challenges happen outside the gates.</p>}
      {s.journal.map(entry => (
        <div className="jr-row" key={`${entry.duelId}-${entry.atMs}`}>
          <i aria-hidden="true" />
          <div>
            <strong>{entry.kind.toUpperCase()} · {entry.opponentName}</strong>
            <small>{entry.stake} stake · {entry.goldDelta >= 0 ? '+' : ''}{entry.goldDelta} gold · {new Date(entry.atMs).toLocaleString()} · {entry.reason}</small>
          </div>
        </div>
      ))}
    </div>
  )
}

export { isDuelLocked }
