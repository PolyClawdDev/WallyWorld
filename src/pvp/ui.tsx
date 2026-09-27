import React, { useEffect, useState } from 'react'
import { wizards } from '../characters'
import { DEMO_GOLD_NOTICE } from '../shared/pvp'
import { fetchPvpJournal, send } from './net'
import { isDuelLocked, pingPvp, pvpState, subscribePvp } from './store'
import './pvp.css'

function usePvp() {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribePvp(() => setTick(n => n + 1))
  }, [])
  return pvpState
}

function GoldNote() {
  return <p className="pvp-demo">{DEMO_GOLD_NOTICE} · game gold only · not SOL</p>
}

export function PvpOverlay() {
  const s = usePvp()
  return (
    <div className="pvp-layer" onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {!s.connected && <div className="pvp-chip">{s.reconnecting ? 'Reconnecting to the shared town…' : 'Joining the shared town…'}</div>}
      {s.signedIn && s.connected && (
        <div className="pvp-chip pvp-gold-chip">
          ✦ {s.gold.available} GAME GOLD<small>{s.gold.reserved ? ` · ${s.gold.reserved} in escrow` : ''} · DEMO</small>
        </div>
      )}
      {s.error && <div className="pvp-error" onClick={() => { pvpState.error = null; pingPvp() }}>{s.error}</div>}
      {s.inspect && !s.composer && <InspectCard />}
      {s.composer && <ChallengeComposer />}
      {s.invite && <InviteCard />}
      {s.duel && <DuelHud />}
      {s.result && <ResultCard />}
    </div>
  )
}

function InspectCard() {
  const card = pvpState.inspect!
  const you = pvpState.self
  const inTown = Boolean(you?.inTown || card.inTown)
  const available = Math.min(pvpState.gold.available, card.goldAvailable)
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
          disabled={inTown || card.state !== 'exploring' || available <= 0 || card.theyBlockedYou || card.incomingDisabled}
          onClick={() => { pvpState.composer = card; pingPvp() }}
        >
          {inTown ? 'Leave town to challenge this player.' : 'Challenge'}
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
      <div className="jr-ledger-head"><span>PVP LEDGER</span><b>GAME GOLD · DEMO</b></div>
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
