import React, { useEffect, useRef, useState } from 'react'
import { kits } from './battle/kits'
import { huntState, subscribeHunt } from './huntStore'
import type { HuntTarget } from './huntStore'
import {
  DEATH_LOSS_PERCENT,
  DEMO_NOTICE,
  formatCountdown,
  formatGold,
  rewardsSnapshot,
  subscribeRewards,
} from './rewards'
import { speciesSpecs } from './wildlife'
import type { WizardId } from './characters'

import './hunt.css'

/* ------------------------------------------------------------------ *
 * The hunt HUD. Health, the active ability, the current target, a
 * compass out to the current hunt ground, and the demo reward ledger.
 *
 * Fast-moving values are written straight to DOM refs from a single
 * animation frame; React state is only used for things that actually
 * change shape (target acquired, player died, log opened). A 60 Hz
 * setState here would stall the render loop next door.
 * ------------------------------------------------------------------ */

const threatLabel = { passive: 'PASSIVE', defensive: 'DEFENSIVE', aggressive: 'AGGRESSIVE' } as const

function TargetPlate({ target, range }: { target: HuntTarget; range: number }) {
  const fill = useRef<HTMLElement>(null)
  const hp = useRef<HTMLElement>(null)
  const reach = useRef<HTMLElement>(null)
  useEffect(() => {
    let frame = 0
    const tick = () => {
      const live = huntState.target
      if (live && fill.current && hp.current && reach.current) {
        const ratio = Math.max(0, live.hp / live.maxHp)
        fill.current.style.width = `${(ratio * 100).toFixed(1)}%`
        const band = ratio > 0.55 ? 'good' : ratio > 0.25 ? 'warn' : 'low'
        if (fill.current.dataset.band !== band) fill.current.dataset.band = band
        hp.current.textContent = `${Math.max(0, Math.ceil(live.hp))} / ${live.maxHp}`
        // You can inspect much further than you can strike, so say which it is.
        const near = live.distance <= range
        reach.current.textContent = near ? `${live.distance.toFixed(1)} M · IN RANGE` : `${live.distance.toFixed(1)} M · TOO FAR`
        reach.current.className = near ? 'reach near' : 'reach far'
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [range])
  return (
    <div className="target-plate">
      <div className="row">
        <strong>{target.label}</strong>
        <span className={`threat-${target.threat}`}>{threatLabel[target.threat]}</span>
      </div>
      <div className="target-track">
        <i ref={fill} />
      </div>
      <div className="meta">
        <span ref={hp}>
          {target.hp} / {target.maxHp}
        </span>
        <span className="reach" ref={reach}>
          {target.distance.toFixed(1)} M
        </span>
        <span>
          DROPS <b>{formatGold(target.goldBaseUnits)} GOLD</b> · DEMO
        </span>
      </div>
    </div>
  )
}

function HuntLog({ onClose }: { onClose: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => {
    const unsubscribe = subscribeRewards(() => bump(value => value + 1))
    return () => {
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => bump(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const snapshot = rewardsSnapshot()
  return (
    <section className="hunt-log">
      <button className="close-log" onClick={onClose} aria-label="Close hunt log">
        ×
      </button>
      <div className="eyebrow">HUNT LEDGER · DISTRICT 01</div>
      <h3>Gold from the green.</h3>
      <p className="demo-line">{DEMO_NOTICE} Gold is a local demo counter.</p>

      <div className="hunt-key">
        {Object.values(speciesSpecs).map(species => (
          <div key={species.id}>
            <i style={{ background: species.mapColor }} />
            <span>
              {species.label} · {threatLabel[species.threat]}
            </span>
            <b>{formatGold(species.goldBaseUnits)}</b>
          </div>
        ))}
      </div>

      <div className="queue">
        <div className="queue-head">
          <span>CONVERSION QUEUE · EVERY 30 MIN</span>
          <b>BLOCKED</b>
        </div>
        <p>
          Accrued this window: <b>{formatGold(snapshot.accruedThisWindowBaseUnits)}</b> gold. Window rolls in{' '}
          {formatCountdown(snapshot.windowEndsAt - Date.now())}.
        </p>
        <p>
          Status: {snapshot.payoutStatus}. No Solana or token conversion is implemented in this build — no network is
          contacted, no address is held, and nothing is ever paid out. {DEMO_NOTICE}
        </p>
        <p>
          Death forfeits {DEATH_LOSS_PERCENT}% of carried gold onto the ground where anyone can pick it up.
        </p>
      </div>

      {snapshot.entries.length === 0 ? (
        <p className="empty">No kills yet. Follow the lit trail south-west to the Wildwood, or south-east to the Brasswood once town game stops paying.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>EVENT</th>
              <th style={{ textAlign: 'right' }}>GOLD</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.entries.slice(0, 14).map(entry => (
              <tr key={entry.id}>
                <td>{entry.label}</td>
                <td className={`amount${entry.gold < 0 ? ' negative' : ''}`}>
                  {entry.gold < 0 ? '' : entry.kind === 'KILL' ? 'dropped ' : '+'}
                  {formatGold(entry.gold)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function HuntHud({ wizard }: { wizard: WizardId }) {
  const [logOpen, setLogOpen] = useState(false)
  const [target, setTarget] = useState<HuntTarget | null>(null)
  const [death, setDeath] = useState(huntState.death)
  const flash = useRef<HTMLDivElement>(null)
  const standing = useRef<HTMLElement>(null)
  const compassArrow = useRef<HTMLElement>(null)
  const compassDistance = useRef<HTMLElement>(null)
  const compassLabel = useRef<HTMLSpanElement>(null)

  // Discrete changes only: a different species under the cursor, or a death.
  useEffect(() => {
    const unsubscribe = subscribeHunt(() => {
      const live = huntState.target
      setTarget(current => {
        if (!live) return null
        if (current && current.species === live.species) return current
        return { ...live }
      })
      setDeath(huntState.death)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let frame = 0
    const tick = (now: number) => {
      // The health readout moved to the combat HUD; what survives here is the
      // one-word standing that tells you whether the town is protecting you.
      if (standing.current) {
        const status = huntState.safe
          ? 'TOWN · SAFE'
          : huntState.aggro > 0
            ? `${huntState.aggro} HOSTILE`
            : huntState.invulnerable
              ? 'RECOVERING'
              : 'IN THE GREEN'
        if (standing.current.textContent !== status) standing.current.textContent = status
        standing.current.className = huntState.safe ? 'safe' : huntState.aggro > 0 ? 'danger' : ''
      }
      if (flash.current) {
        const since = now - huntState.hurtAt
        flash.current.style.opacity = huntState.hurtAt && since < 420 ? String(0.85 * (1 - since / 420)) : '0'
      }
      if (compassArrow.current) compassArrow.current.style.transform = `rotate(${huntState.compassDegrees.toFixed(1)}deg)`
      if (compassDistance.current) compassDistance.current.textContent = `${Math.round(huntState.compassDistance)} M`
      if (compassLabel.current && compassLabel.current.textContent !== huntState.compassLabel) {
        compassLabel.current.textContent = huntState.compassLabel
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  // Own listener rather than touching the shared shortcut effect in App.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (key === 'h') {
        event.preventDefault()
        setLogOpen(open => !open)
      }
      if (key === 'escape') setLogOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showDeath = death && Date.now() - death.at < 7000

  return (
    <div className="hunt-hud">
      <div className="hurt-flash" ref={flash} />

      {/* Health, the ability card and its key legend now live in the combat
          HUD at the bottom centre. What is left here is the hunt's own
          furniture: what you are pointing at, where the wildwood is, and the
          ledger. */}
      <div className="hunt-standing">
        <em ref={standing}>TOWN · SAFE</em>
      </div>

      {target && <TargetPlate target={target} range={kits[wizard].basic.range} />}

      <div className="hunt-compass">
        <span ref={compassLabel}>{huntState.compassLabel}</span>
        {/* the needle is a clipped shape in hunt.css, not a glyph */}
        <em className="arrow" ref={compassArrow} aria-hidden="true" />
        <b ref={compassDistance}>0 M</b>
        <span>H · LEDGER</span>
      </div>

      {logOpen && <HuntLog onClose={() => setLogOpen(false)} />}

      {showDeath && death && (
        <div className="death-banner">
          <div className="eyebrow">YOU WENT DOWN</div>
          <h3>{death.killer} killed you.</h3>
          <p>
            You dropped <b>{formatGold(death.goldDroppedBaseUnits)} gold</b> where you fell —{' '}
            {DEATH_LOSS_PERCENT}% of what you carried. Anyone can pick it up, including you. Walk back and get it.
          </p>
          <small>RESPAWNED AT THE PLAZA · {DEMO_NOTICE.toUpperCase()}</small>
        </div>
      )}
    </div>
  )
}
