import React, { useEffect, useState } from 'react'
import { ChatBox } from '../chat/ChatBox'
import { wizards } from '../characters'
import { DEMO_GOLD_NOTICE, type PublicCard, type PublicPresence } from '../shared/pvp'
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

function DuelHud() {
  const duel = pvpState.duel!
  const you = duel.a.playerId === pvpState.playerId ? duel.a : duel.b
  const foe = you === duel.a ? duel.b : duel.a
  const count = duel.countdownEndsAtMs ? Math.max(0, Math.ceil((duel.countdownEndsAtMs - Date.now()) / 1000)) : 0
  return (
    <div className="pvp-duel-hud">
      <div className="pvp-duel-bar">
        <strong>{you.displayName}</strong>
        <span>{you.hp}/{you.maxHp}</span>
        <em>vs</em>
        <strong>{foe.displayName}</strong>
        <span>{foe.hp}/{foe.maxHp}</span>
      </div>
      <div className="pvp-duel-meta">
        {duel.phase === 'preparing' && 'Waiting for both wayfinders…'}
        {duel.phase === 'countdown' && `Fight starts in ${count}`}
        {duel.phase === 'active' && `${duel.ringName} · pot ${duel.pot} · ${DEMO_GOLD_NOTICE}`}
        {duel.reconnectUntilMs && <b> Reconnect window open</b>}
        {duel.outOfBoundsUntilMs && <b> Return to the ring</b>}
      </div>
      {duel.phase === 'preparing' && (
        <button className="primary" onClick={() => send({ t: 'ready', duelId: duel.duelId })}>Ready</button>
      )}
      {duel.phase === 'active' && !pvpState.surrenderAsk && (
        <button onClick={() => { pvpState.surrenderAsk = true; pingPvp() }}>Surrender</button>
      )}
      {pvpState.surrenderAsk && (
        <div className="pvp-actions">
          <button className="primary" onClick={() => send({ t: 'surrender', duelId: duel.duelId })}>Confirm surrender</button>
          <button onClick={() => { pvpState.surrenderAsk = false; pingPvp() }}>Keep fighting</button>
        </div>
      )}
    </div>
  )
}

function ResultCard() {
  const result = pvpState.result!
  return (
    <aside className="pvp-card" role="dialog" aria-label="Duel result">
      <div className="wui-etch">RESULT</div>
      <h3>{result.kind === 'draw' || result.kind === 'void' || result.refunded ? 'Draw' : result.kind === 'victory' ? 'Victory' : 'Defeat'}</h3>
      <p>{result.reason}</p>
      <dl className="pvp-stats">
        <div><dt>Stake</dt><dd>{result.stake}</dd></div>
        <div><dt>{result.refunded ? 'Refund' : 'Pot'}</dt><dd>{result.refunded ? result.stake : result.pot}</dd></div>
        <div><dt>Net gold</dt><dd>{result.yourDelta >= 0 ? `+${result.yourDelta}` : result.yourDelta}</dd></div>
        <div><dt>Balance</dt><dd>{result.yourBalance}</dd></div>
        <div><dt>W / L</dt><dd>{result.yourWins} / {result.yourLosses}</dd></div>
      </dl>
      <GoldNote />
      <div className="pvp-actions">
        <button className="primary" onClick={() => {
          send({ t: 'challenge', playerId: result.opponentId, stake: result.stake })
          pvpState.result = null
          pingPvp()
        }}>Rematch</button>
        <button onClick={() => {
          send({ t: 'leave', duelId: result.duelId })
          pvpState.result = null
          pvpState.duel = null
          pingPvp()
        }}>Leave Arena</button>
      </div>
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
