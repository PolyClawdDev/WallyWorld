import React, { useEffect, useRef, useState } from 'react'
import { AbilityIcon } from './battle/icons'
import { MAX_LEVEL } from './battle/progression'
import type { AbilitySlot } from './battle/progression'
import {
  battleState,
  readKeyboardMove,
  requestCancelAim,
  requestQuickCast,
  requestUpgrade,
  setKeyboardMove,
  subscribeBattle,
} from './battle/store'
import type { SlotView } from './battle/store'
import type { MothStyle, WizardId } from './characters'
import { WizardPortrait } from './wizardPortrait'

import './combatHud.css'

/* ------------------------------------------------------------------ *
 * The combat HUD.
 *
 * Replaces the old bottom-left "EMBER BLAST" card. Nothing here is a
 * permanent block of explanatory text: names and descriptions live in
 * hover/focus tooltips and in an expandable panel, and the bar itself
 * carries only state — level, health, resource, experience, the passive
 * and four abilities.
 *
 * Same split as the hunt HUD next door: numbers that move every frame
 * are written straight to DOM refs from one animation frame, and React
 * only re-renders when the shape changes (a rank bought, a level
 * gained, a tooltip opened). Cut from the same materials as the rest of
 * the UI kit in worldUi.css — flat fields, stepped pixel corners, brass
 * rivets, hard bevels, no blur.
 * ------------------------------------------------------------------ */

const SLOTS: AbilitySlot[] = ['Q', 'W', 'E', 'R']

type TipTarget = AbilitySlot | 'passive' | 'basic' | null

function Tooltip({ target }: { target: Exclude<TipTarget, null> }) {
  if (target === 'passive') {
    return (
      <div className="cbt-tip" role="tooltip">
        <header>
          <strong>{battleState.passiveName}</strong>
          <span>PASSIVE</span>
        </header>
        <p>{battleState.passiveDetail}</p>
      </div>
    )
  }
  if (target === 'basic') {
    return (
      <div className="cbt-tip" role="tooltip">
        <header>
          <strong>{battleState.basicName}</strong>
          <span>BASIC ATTACK</span>
        </header>
        <p>{battleState.basicBlurb}</p>
        <footer>
          <span>RIGHT-CLICK AN ENEMY TO ENGAGE</span>
        </footer>
      </div>
    )
  }
  const view = battleState.slots[target]
  const locked = view.rank < 1
  return (
    <div className="cbt-tip" role="tooltip">
      <header>
        <strong>{view.name}</strong>
        <span>
          {target} · {locked ? 'NOT LEARNED' : `RANK ${view.rank} / ${view.maxRank}`}
        </span>
      </header>
      <p className="cbt-tip-short">{view.short}</p>
      <p>{view.detail}</p>
      <footer>
        <span>
          {view.cost} {battleState.resourceShort}
        </span>
        <span>{view.cooldown}s</span>
        {view.range > 0 && <span>{view.range}m</span>}
        {locked && view.nextRankLevel > 0 && <span className="cbt-tip-lock">UNLOCKS AT LEVEL {view.nextRankLevel}</span>}
        {!locked && view.nextRankLevel > 0 && <span className="cbt-tip-lock">NEXT RANK AT LEVEL {view.nextRankLevel}</span>}
      </footer>
    </div>
  )
}

function Slot({
  slot,
  view,
  onTip,
  register,
}: {
  slot: AbilitySlot
  view: SlotView
  onTip: (target: TipTarget) => void
  register: (key: string, node: HTMLElement | null) => void
}) {
  return (
    <div className="cbt-slot" ref={node => register(`slot:${slot}`, node)} data-state={view.state}>
      <button
        type="button"
        className="cbt-key"
        // Clicking an ability icon must never also issue a world command, so
        // this is a real button in the overlay and the canvas never sees it.
        onMouseEnter={() => onTip(slot)}
        onMouseLeave={() => onTip(null)}
        onFocus={() => onTip(slot)}
        onBlur={() => onTip(null)}
        aria-label={`${view.name} — ${slot}`}
      >
        <span className="cbt-glyph">
          <AbilityIcon id={view.icon} size={30} />
        </span>
        <i className="cbt-sweep" ref={node => register(`sweep:${slot}`, node)} />
        <em className="cbt-secs" ref={node => register(`secs:${slot}`, node)} />
        <b className="cbt-hotkey">{slot}</b>
        <span className="cbt-cost" ref={node => register(`cost:${slot}`, node)}>
          {view.cost}
        </span>
        <span className="cbt-lock" aria-hidden="true" />
      </button>
      <div className="cbt-pips" aria-label={`rank ${view.rank} of ${view.maxRank}`}>
        {Array.from({ length: view.maxRank }, (_, index) => (
          <i key={index} data-on={index < view.rank ? 'yes' : 'no'} />
        ))}
      </div>
      <button
        type="button"
        className="cbt-up"
        ref={node => register(`up:${slot}`, node)}
        onClick={event => {
          event.stopPropagation()
          requestUpgrade(slot)
        }}
        aria-label={`Spend an ability point on ${view.name}`}
        title={`Upgrade ${view.name}`}
      >
        +
      </button>
    </div>
  )
}

function AbilityBook({ onClose }: { onClose: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => subscribeBattle(() => bump(value => value + 1)), [])
  return (
    <section className="cbt-book">
      <header className="cbt-book-head">
        <div>
          <div className="wui-etch">{battleState.wizard} · LEVEL {battleState.level}{battleState.maxed ? ' · MAX' : ''}</div>
          <h3>{battleState.identity}</h3>
        </div>
        <div className="cbt-book-tools">
          <label className="cbt-quick">
            <input
              type="checkbox"
              checked={battleState.quickCast}
              onChange={event => requestQuickCast(event.target.checked)}
            />
            <span />
            QUICK CAST
          </label>
          <label className="cbt-quick" title="Off by default: the world is walked with the mouse.">
            <input
              type="checkbox"
              checked={readKeyboardMove()}
              onChange={event => setKeyboardMove(event.target.checked)}
            />
            <span />
            WASD WALKING
          </label>
          <button type="button" className="cbt-book-close" onClick={onClose} aria-label="Close abilities">
            ×
          </button>
        </div>
      </header>

      <div className="cbt-book-row">
        <span className="cbt-book-icon">
          <AbilityIcon id={battleState.basicIcon} size={26} />
        </span>
        <div>
          <strong>{battleState.basicName}</strong>
          <small>BASIC ATTACK · ALWAYS AVAILABLE</small>
          <p>{battleState.basicBlurb}</p>
        </div>
      </div>
      <div className="cbt-book-row">
        <span className="cbt-book-icon">
          <AbilityIcon id={battleState.passiveIcon} size={26} />
        </span>
        <div>
          <strong>{battleState.passiveName}</strong>
          <small>PASSIVE · ALWAYS AVAILABLE</small>
          <p>{battleState.passiveDetail}</p>
        </div>
      </div>

      {SLOTS.map(slot => {
        const view = battleState.slots[slot]
        return (
          <div className="cbt-book-row" key={slot} data-locked={view.rank < 1 ? 'yes' : 'no'}>
            <span className="cbt-book-icon">
              <AbilityIcon id={view.icon} size={26} />
            </span>
            <div>
              <strong>
                {view.name} <b>{slot}</b>
              </strong>
              <small>
                RANK {view.rank} / {view.maxRank} ·{' '}
                {view.nextRankLevel > 0 ? `NEXT AT LEVEL ${view.nextRankLevel}` : 'MAXED'} · {view.cost}{' '}
                {battleState.resourceShort} · {view.cooldown}s
              </small>
              <p>{view.detail}</p>
            </div>
            <button
              type="button"
              className="cbt-book-up"
              disabled={!view.upgradable}
              onClick={() => requestUpgrade(slot)}
            >
              {view.rank >= view.maxRank ? 'MAX' : '+ RANK'}
            </button>
          </div>
        )
      })}
      <p className="cbt-book-foot">
        {battleState.points} unspent point{battleState.points === 1 ? '' : 's'} · one per level · Q/W/E cap at rank 4,
        R at rank 3.
      </p>
    </section>
  )
}

export function CombatHud({ wizard, style }: { wizard: WizardId; style: MothStyle }) {
  const [, bump] = useState(0)
  const [tip, setTip] = useState<TipTarget>(null)
  const [book, setBook] = useState(false)
  const nodes = useRef(new Map<string, HTMLElement>())
  const register = (key: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node)
    else nodes.current.delete(key)
  }

  useEffect(() => subscribeBattle(() => bump(value => value + 1)), [])

  // One animation frame drives every fast-moving number in the bar.
  useEffect(() => {
    let frame = 0
    const get = (key: string) => nodes.current.get(key)
    const tick = (now: number) => {
      const hpRatio = battleState.maxHp > 0 ? Math.max(0, Math.min(1, battleState.hp / battleState.maxHp)) : 0
      const hp = get('hp')
      if (hp) {
        hp.style.width = `${(hpRatio * 100).toFixed(1)}%`
        const band = hpRatio > 0.55 ? 'good' : hpRatio > 0.25 ? 'warn' : 'low'
        if (hp.dataset.band !== band) hp.dataset.band = band
      }
      const hpText = get('hpText')
      if (hpText) hpText.textContent = `${Math.max(0, Math.ceil(battleState.hp))} / ${Math.round(battleState.maxHp)}`

      const resourceRatio = battleState.maxResource > 0 ? battleState.resource / battleState.maxResource : 0
      const res = get('res')
      if (res) res.style.width = `${(Math.max(0, Math.min(1, resourceRatio)) * 100).toFixed(1)}%`
      const resText = get('resText')
      if (resText) {
        resText.textContent = `${Math.max(0, Math.floor(battleState.resource))} / ${Math.round(battleState.maxResource)}`
      }

      const xp = get('xp')
      if (xp) {
        const ratio = battleState.maxed ? 1 : Math.max(0, Math.min(1, battleState.xp / battleState.xpNeeded))
        xp.style.width = `${(ratio * 100).toFixed(1)}%`
      }
      const xpText = get('xpText')
      if (xpText) {
        xpText.textContent = battleState.maxed
          ? 'MAX LEVEL'
          : `XP ${Math.floor(battleState.xp)} / ${Math.round(battleState.xpNeeded)}`
      }

      const passive = get('passiveCharge')
      if (passive) passive.style.height = `${(Math.max(0, Math.min(1, battleState.passiveCharge)) * 100).toFixed(0)}%`
      const passiveLabel = get('passiveLabel')
      if (passiveLabel && passiveLabel.textContent !== battleState.passiveLabel) {
        passiveLabel.textContent = battleState.passiveLabel
      }

      for (const slot of SLOTS) {
        const view = battleState.slots[slot]
        const host = get(`slot:${slot}`)
        if (host && host.dataset.state !== view.state) host.dataset.state = view.state
        const sweep = get(`sweep:${slot}`)
        const secs = get(`secs:${slot}`)
        const cooling = view.remaining > 0.05 && view.cooldown > 0
        if (sweep) {
          const portion = cooling ? Math.min(1, view.remaining / view.cooldown) : 0
          sweep.style.opacity = cooling ? '1' : '0'
          // A hard-stopped sweep, not a soft gradient: it has to read as a
          // shutter closing over the icon, matching the rest of the kit.
          sweep.style.background = cooling
            ? `conic-gradient(#0b101799 0turn ${portion}turn, transparent ${portion}turn 1turn)`
            : 'transparent'
        }
        if (secs) {
          const text = cooling ? (view.remaining >= 10 ? String(Math.ceil(view.remaining)) : view.remaining.toFixed(1)) : ''
          if (secs.textContent !== text) secs.textContent = text
        }
        const cost = get(`cost:${slot}`)
        if (cost && cost.textContent !== String(view.cost)) cost.textContent = String(view.cost)
        const up = get(`up:${slot}`)
        if (up) up.style.display = view.upgradable ? 'grid' : 'none'
      }

      const notice = get('notice')
      if (notice) {
        const live = battleState.notice
        const age = live ? now - live.at : Infinity
        notice.style.opacity = age < 2200 ? String(Math.min(1, (2200 - age) / 600)) : '0'
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!battleState.active) return null

  const points = battleState.points
  const aiming = battleState.aiming

  return (
    <div
      className="cbt-hud"
      style={{ ['--kit' as string]: battleState.color, ['--kit-accent' as string]: battleState.accent, ['--res' as string]: battleState.resourceColor }}
    >
      <div className="cbt-notice" ref={node => register('notice', node)} data-kind={battleState.notice?.kind ?? 'warn'}>
        {battleState.notice?.text}
      </div>

      {aiming && (
        <div className="cbt-aiming">
          <b>{battleState.slots[aiming].name}</b>
          <span>LEFT CLICK TO CAST · RIGHT CLICK OR ESC TO CANCEL</span>
          <button type="button" onClick={() => requestCancelAim()}>
            CANCEL
          </button>
        </div>
      )}

      {book && <AbilityBook onClose={() => setBook(false)} />}

      <div className="cbt-bar">
        <span className="cbt-rivets" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>

        <button
          type="button"
          className="cbt-portrait"
          onMouseEnter={() => setTip('basic')}
          onMouseLeave={() => setTip(null)}
          onFocus={() => setTip('basic')}
          onBlur={() => setTip(null)}
          aria-label={`${battleState.wizard}, level ${battleState.level}`}
        >
          <WizardPortrait wizard={wizard} style={style} />
          <b className="cbt-level" data-max={battleState.maxed ? 'yes' : 'no'}>
            {battleState.maxed ? 'MAX' : battleState.level}
          </b>
        </button>

        <div className="cbt-gauges">
          <div className="cbt-track cbt-hp">
            <i ref={node => register('hp', node)} data-band="good" />
            <span ref={node => register('hpText', node)}>0 / 0</span>
          </div>
          <div className="cbt-track cbt-res">
            <i ref={node => register('res', node)} />
            <span ref={node => register('resText', node)}>0 / 0</span>
          </div>
          <div className="cbt-xp" title={`Level ${battleState.level} of ${MAX_LEVEL}`}>
            <i ref={node => register('xp', node)} />
            <span ref={node => register('xpText', node)} />
          </div>
        </div>

        <button
          type="button"
          className="cbt-passive"
          onMouseEnter={() => setTip('passive')}
          onMouseLeave={() => setTip(null)}
          onFocus={() => setTip('passive')}
          onBlur={() => setTip(null)}
          aria-label={`Passive: ${battleState.passiveName}`}
        >
          <i className="cbt-passive-charge" ref={node => register('passiveCharge', node)} />
          <AbilityIcon id={battleState.passiveIcon} size={24} />
          <em ref={node => register('passiveLabel', node)} />
        </button>

        <div className="cbt-slots">
          {SLOTS.map(slot => (
            <Slot key={slot} slot={slot} view={battleState.slots[slot]} onTip={setTip} register={register} />
          ))}
        </div>

        <button
          type="button"
          className={`cbt-expand${points > 0 ? ' has-points' : ''}`}
          onClick={() => setBook(open => !open)}
          aria-expanded={book}
          aria-label="Abilities and upgrades"
        >
          <span>{book ? '▾' : '▴'}</span>
          {points > 0 && <b>{points}</b>}
        </button>
      </div>

      {tip && <Tooltip target={tip} />}
    </div>
  )
}
