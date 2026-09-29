import React, { useCallback, useEffect, useState } from 'react'
import { PvpJournal } from './pvp/ui'
import { API_BASE_URL } from './solana/cluster'
import { resolvePresenceAuth } from './pvp/guest'

/* ------------------------------------------------------------------ *
 * Journal and settings, as objects rather than dashboards: the journal
 * is a bound book with an inked ledger, settings is an engraved brass
 * plate with physical switches.
 *
 * The service desk in this panel used to be a three-second animation on a
 * timer that charged "2 demo credits" — a currency that existed nowhere in
 * the system — and wrote a receipt for an artifact it never made. All of
 * that is gone. Every card below is a real purchase: the server names the
 * price, takes it out of the one gold balance through the ledger in
 * `src/server/money/`, generates the document from this repository's own
 * town data, and hands it back. Nothing here is on a timer and nothing here
 * pretends.
 *
 * Three of the eight service NPCs cannot do anything real — the shielded
 * Zcash desk has no signer anywhere in this project, and the other two
 * would need world state that does not exist. They are drawn as shut, with
 * the reason, and they have no button. That is deliberate: removing the word
 * "demo" from something that does not work would be worse than the demo.
 *
 * Artifacts are rendered as text, never as markup.
 * ------------------------------------------------------------------ */

type Availability =
  | { state: 'available' }
  | { state: 'unavailable'; headline: string; because: string[] }

type Service = {
  id: string
  npc: string
  keeper: string
  title: string
  what: string
  derivedFrom: string[]
  priceGold: string | null
  availability: Availability
  landmarks?: string[]
}

type OrderView = {
  orderId: string
  npc: string
  title: string
  state: 'reserved' | 'delivered' | 'refunded'
  priceGold: string
  sha256: string | null
  bytes: number | null
  failure: string | null
  deliveredAtMs: number | null
  createdAtMs: number
  ledger: { settled: 'charge' | 'refund' | null; settledGold: string | null; reconciles: boolean }
}

type Artifact = { title: string; kind: string; text: string; sha256: string }

type Desk = {
  services: Service[]
  orders: OrderView[]
  gold: { available: string; reserved: string; total: string }
}

/** A fresh key per attempt, so a retry after a refusal is a new purchase. */
function newIdempotencyKey() {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `svc-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

const short = (digest: string | null) => (digest ? `${digest.slice(0, 12)}…` : '—')
const when = (atMs: number) => new Date(atMs).toLocaleString()

const ARTIFACT_STYLE: React.CSSProperties = {
  marginTop: 10,
  maxHeight: 280,
  overflow: 'auto',
  padding: 10,
  background: '#fdf6e3',
  border: '1px solid #c9b48c',
  color: '#33251a',
  font: "9px/1.55 'DM Mono', ui-monospace, monospace",
  // `pre`, not `pre-wrap`: the documents have columns in them, and the
  // generators already wrap their prose at a fixed width, so scrolling sideways
  // keeps a table readable where reflowing it would not.
  whiteSpace: 'pre',
}

export function JournalPanel() {
  const [desk, setDesk] = useState<Desk | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState('')
  const [landmark, setLandmark] = useState('The Archive')
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const auth = await resolvePresenceAuth()
    if (!auth) {
      setProblem('This desk needs a session with the world server. Nothing can be bought or delivered without one.')
      return
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/services`, { headers: { Authorization: `Bearer ${auth.token}` } })
      if (!response.ok) {
        setProblem(`The desk answered ${response.status}. No gold has moved.`)
        return
      }
      setDesk((await response.json()) as Desk)
      setProblem('')
    } catch {
      setProblem('The world server is not reachable, so no service can be bought. Nothing has been charged.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const buy = async (service: Service) => {
    setBusy(service.id)
    setMessage('')
    const auth = await resolvePresenceAuth()
    if (!auth) {
      setBusy('')
      setMessage('No session, so nothing was charged.')
      return
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/services/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          serviceId: service.id,
          idempotencyKey: newIdempotencyKey(),
          request: service.landmarks ? { landmark } : {},
        }),
      })
      const payload = (await response.json()) as { artifact?: Artifact; detail?: string; error?: string; order?: OrderView }
      if (response.ok && payload.artifact) {
        setArtifact(payload.artifact)
        setMessage(`Delivered. ${service.priceGold} gold paid to ${service.npc.split(' ·')[0]}.`)
      } else {
        // The server says what happened and whether anything moved. It is shown
        // as it came, rather than being softened into a success.
        setMessage(payload.detail ?? `The purchase was refused (${payload.error ?? response.status}).`)
      }
    } catch {
      setMessage('The request did not reach the server. If nothing was charged, nothing was delivered.')
    }
    setBusy('')
    await load()
  }

  const gold = desk?.gold.available ?? '—'

  return <>
    <div className="jr-head">
      <div className="wui-etch" style={{ color: '#8a5a1e' }}>THE ARCHIVE · SERVICES</div>
      <h3>Paid in gold. Delivered in full.</h3>
    </div>
    <p className="jr-quote">“I can survey any corner of this town from the plan it was built from. My fee is gold, and you get the page.” — Lyra, archivist</p>

    <div className="jr-ledger-head"><span>YOUR PURSE</span><b>{gold} GOLD</b></div>
    {desk && desk.gold.reserved !== '0' && <p className="jr-empty">{desk.gold.reserved} gold is reserved against an order in flight.</p>}
    {problem && <p className="jr-empty">{problem}</p>}
    {message && <p className="jr-empty">{message}</p>}

    {artifact && <div className="jr-card">
      <div className="task-head"><span>DELIVERED</span><b>{artifact.kind.toUpperCase()}</b></div>
      <h4>{artifact.title}</h4>
      <div className="jr-meta"><span>{artifact.text.length} characters</span><span>sha256 {short(artifact.sha256)}</span></div>
      {/* Text, deliberately. The artifact is never interpreted as markup. */}
      <div style={ARTIFACT_STYLE}>{artifact.text}</div>
      <button className="primary full" onClick={() => setArtifact(null)}>Close the page</button>
    </div>}

    {desk?.services.map(service => service.availability.state === 'available'
      ? <div className="jr-card" key={service.id}>
          <div className="task-head"><span>{service.npc}</span><b>{service.priceGold} GOLD</b></div>
          <h4>{service.title}</h4>
          <p>{service.what}</p>
          <div className="jr-meta"><span>{service.keeper}</span><span>from {service.derivedFrom.join(', ')}</span></div>
          {service.landmarks && <select
            value={landmark}
            onChange={event => setLandmark(event.target.value)}
            style={{ width: '100%', margin: '10px 0', padding: 6, font: "11px 'DM Mono', ui-monospace, monospace" }}
          >
            {service.landmarks.map(name => <option key={name} value={name}>{name}</option>)}
          </select>}
          <button className="primary full" disabled={busy !== ''} onClick={() => void buy(service)}>
            {busy === service.id ? 'Paying and drawing it up…' : `Pay ${service.priceGold} gold`}
          </button>
        </div>
      : <div className="jr-card" key={service.id} style={{ opacity: 0.72 }}>
          <div className="task-head"><span>{service.npc}</span><b style={{ color: '#8a3a1e' }}>UNAVAILABLE</b></div>
          <h4>{service.title}</h4>
          <p>{service.availability.state === 'unavailable' ? service.availability.headline : ''}</p>
          <p style={{ marginTop: 8 }}>{service.availability.state === 'unavailable' ? service.availability.because.join(' ') : ''}</p>
          <div className="jr-meta"><span>No price</span><span>Nothing to buy</span></div>
        </div>)}

    <div className="jr-ledger">
      {/* Was "SIMULATED". These rows are the gold ledger's own account of what
          was charged, checked back against it rather than written beside it. */}
      <div className="jr-ledger-head"><span>RECEIPT LEDGER</span><b>REAL GOLD</b></div>
      {desk && desk.orders.length > 0
        ? desk.orders.map(order => <div className="jr-row" key={order.orderId}>
            <i aria-hidden="true" style={order.state === 'delivered' ? undefined : { background: '#8a5a1e' }} />
            <div>
              <strong>{order.title} — {order.state}</strong>
              <small>
                {order.state === 'delivered'
                  ? `${order.priceGold} gold paid · ${order.npc.split(' ·')[0]} · sha256 ${short(order.sha256)}`
                  : order.state === 'refunded'
                    ? `${order.priceGold} gold refunded in full · nothing was delivered`
                    : `${order.priceGold} gold reserved · not yet delivered`}
                {order.ledger.reconciles ? ' · reconciles with the gold ledger' : ' · DOES NOT RECONCILE'}
                {` · ${when(order.deliveredAtMs ?? order.createdAtMs)}`}
              </small>
            </div>
          </div>)
        : <p className="jr-empty">No purchases yet. Anything you buy is written here with the gold it cost.</p>}
    </div>
    <PvpJournal />
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
    <p className="st-note">
      Right-drag the world to look around, and tap the right button to walk there.
      Either button attacks the animal under the cursor. The wheel zooms, SPACE swings
      the view back behind you, SHIFT runs, and V drops you into first person.
      The normal cursor stays available for the pouch, chart, journal, and this plate.
    </p>
  </>
}
