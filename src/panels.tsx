import React from 'react'

/* ------------------------------------------------------------------ *
 * Journal and settings, as objects rather than dashboards: the journal
 * is a bound book with an inked ledger, settings is an engraved brass
 * plate with physical switches. Both are pure presentation, and the
 * behaviour they had in the side panels is unchanged.
 * ------------------------------------------------------------------ */

export type TaskState = 'idle' | 'queued' | 'running' | 'delivered'

export function JournalPanel({ task, receipt, onApprove }: {
  task: TaskState
  receipt: boolean
  onApprove: () => void
}) {
  return <>
    <div className="jr-head">
      <div className="wui-etch" style={{ color: '#8a5a1e' }}>ENTRY 01 · THE ARCHIVE</div>
      <h3>Research, made tangible.</h3>
    </div>
    <p className="jr-quote">“I can map the quiet history of any place in town. Shall I make a sample report?” — Lyra, archivist</p>

    <div className="jr-card">
      <div className="task-head"><span>DEMO SERVICE</span><b>{task === 'idle' ? 'READY' : task.toUpperCase()}</b></div>
      <h4>Town history brief</h4>
      <p>One-page summary of Wally World landmarks, delivered as a simulated artifact.</p>
      <div className="jr-meta"><span>2 demo credits</span><span>~ 3 seconds</span><span>Scripted demo</span></div>
      <button className="primary full" disabled={task !== 'idle'} onClick={onApprove}>
        {task === 'idle' ? 'Approve · 2 credits' : task === 'delivered' ? 'Delivered' : `Task ${task}…`}
      </button>
    </div>

    <div className="jr-ledger">
      <div className="jr-ledger-head"><span>RECEIPT LEDGER</span><b>SIMULATED</b></div>
      {receipt
        ? <div className="jr-row">
            <i aria-hidden="true" />
            <div><strong>Town history brief delivered</strong><small>Simulated artifact · no real funds · 2 demo credits</small></div>
          </div>
        : <p className="jr-empty">No entries yet. Approved demo tasks are written here.</p>}
    </div>
  </>
}

export function SettingsPanel() {
  return <>
    <div className="st-rows">
      <div className="st-row">
        <label htmlFor="set-look">Camera sensitivity</label>
        <input id="set-look" type="range" defaultValue="40" />
        <small>How far the view swings when you right-drag the world.</small>
      </div>
      <div className="st-row">
        <label htmlFor="set-audio">Audio</label>
        <input id="set-audio" type="range" defaultValue="60" />
        <small>Lantern hum, canal water, footsteps.</small>
      </div>
      <div className="st-row">
        <label className="st-toggle">
          <input type="checkbox" defaultChecked />
          <span className="st-switch" aria-hidden="true" />
          <span className="st-label">Reduced motion</span>
        </label>
        <small>Damps camera sway and panel animation.</small>
      </div>
    </div>
    <p className="st-note">The normal cursor stays available for the pouch, chart, journal, and this plate. Right-drag the world to look around, WASD to walk, SHIFT to run.</p>
  </>
}
