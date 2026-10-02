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
 * Two of the eight service NPCs cannot do anything real — they would need
 * world state that does not exist. They are drawn as shut, with the reason,
 * and they have no button. That is deliberate: removing the word "demo"
 * from something that does not work would be worse than the demo.
 *
 * Sable's shielded desk is the third kind, `read-only`: it works, and it
 * cannot pay. `ShieldedCourierDesk` below is that desk, and the one rule it
 * is built around is that the half of the truth a player would rather not
 * read is never the half that gets dropped, shortened or folded away.
 *
 * Artifacts are rendered as text, never as markup.
 * ------------------------------------------------------------------ */

type Availability =
  | { state: 'available' }
  | { state: 'read-only'; headline: string; does: string[]; because: string[] }
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
  desk?: string
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

/* ------------------------------------------------------------------ *
 * Sable's shielded courier desk
 * ------------------------------------------------------------------ */

type Statement = { delivers: string; doesNotHide: string; cannotProve: string }

type Stops = {
  at: string
  signer: { available: boolean; reason: string }
  configuration: Array<{ key: string; what: string; set: boolean }>
  depositAddress: null
  depositAddressReason: string
  goldInvolved: boolean
}

type DeskInfo = {
  statement: Statement
  stops: Stops
  accepts: {
    network: string
    requirement: string
    minSol: string
    maxSol: string
    parser: { name: string; version: string; note: string }
    executor: string
  }
}

type Refused = { error: string; code: string; headline: string; says: string; doThis: string }

type Checked = { accepted: true; receivers: string[]; shieldedOnly: boolean; says: string }

type Priced = {
  dry: boolean
  depositAddress: null
  destination: { receivers: string[]; shieldedOnly: boolean }
  quote: {
    headline: string
    worstCase: string
    sol: string
    zec: string
    minZec: string
    timeEstimateSeconds: number | null
    correlationId: string
    signatureVerified: boolean
  }
  statement: Statement
  verdict: { verdict: string; deliveredReceiver: string; explanation: string; documentedSupport: string; documentedSupportUrl: string }
  intent: { intentId: string; state: string; receivers: string[]; expiresAtMs: number; note: string } | null
  stops: Stops
}

/**
 * The privacy statement, whole, wherever it is shown.
 *
 * Rendered by walking one list rather than placing three paragraphs, so that
 * an edit which only wanted the headline cannot quietly leave `doesNotHide`
 * out — which is the exact thing `PRIVACY_STATEMENT` is held as a constant on
 * the server to prevent. All three rows carry the same class: equal prominence
 * is the requirement, and giving the unflattering half a smaller one would be
 * the same omission done in CSS.
 */
function PrivacyStatement({ statement }: { statement: Statement }) {
  const halves: Array<[string, string]> = [
    ['DELIVERS', statement.delivers],
    ['DOES NOT HIDE', statement.doesNotHide],
    ['CANNOT PROVE', statement.cannotProve],
  ]
  return <div className="jr-shield-say">
    {halves.map(([label, text]) => <p className="jr-shield-half" key={label}><b>{label}</b>{text}</p>)}
  </div>
}

function WhereItStops({ stops }: { stops: Stops }) {
  return <div className="jr-shield-stop">
    <div className="jr-ledger-head"><span>WHERE THIS STOPS</span><b>{stops.at.toUpperCase()}</b></div>
    <p>{stops.signer.reason}</p>
    <p>{stops.depositAddressReason}</p>
    <div className="jr-shield-rows">
      {stops.configuration.map(entry => <div key={entry.key}>
        <b>{entry.key}</b><small>{entry.what}</small><em>{entry.set ? 'set · still no signer' : 'unset'}</em>
      </div>)}
    </div>
  </div>
}

/**
 * The desk, in four moves: read the statement, hand over an address, name an
 * amount, read the price.
 *
 * No gold is involved at any point and there is no purchase button, because
 * there is nothing to purchase. The address is sent to the world server and
 * held nowhere — not in storage, not in a URL, and not in this component past
 * the moment the field is cleared.
 */
function ShieldedCourierDesk({ endpoint }: { endpoint: string }) {
  const [info, setInfo] = useState<DeskInfo | null>(null)
  const [address, setAddress] = useState('')
  const [sol, setSol] = useState('1')
  const [busy, setBusy] = useState('')
  const [refused, setRefused] = useState<Refused | null>(null)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [priced, setPriced] = useState<Priced | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`)
        if (response.ok) setInfo((await response.json()) as DeskInfo)
      } catch {
        setNote('The desk could not be reached, so nothing can be parsed or priced right now.')
      }
    })()
  }, [endpoint])

  const ask = async (what: 'address' | 'quote') => {
    setBusy(what)
    setNote('')
    setRefused(null)
    if (what === 'address') { setChecked(null); setPriced(null) }
    const auth = await resolvePresenceAuth()
    if (!auth) {
      setBusy('')
      setNote('This desk needs a session with the world server.')
      return
    }
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}/${what}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify(what === 'address' ? { address } : { address, sol }),
      })
      const payload = (await response.json()) as Record<string, unknown>
      if (response.ok && what === 'address') setChecked(payload as unknown as Checked)
      else if (response.ok) { setPriced(payload as unknown as Priced); setChecked(null) }
      // The address in the field is refused, so anything already on screen is
      // about a different address. A price and a refusal shown together would
      // be the desk contradicting itself about what the player typed.
      else if (payload.error === 'destination_refused') {
        setRefused(payload as unknown as Refused)
        setChecked(null)
        setPriced(null)
      }
      else setNote(String(payload.detail ?? `The desk answered ${response.status}.`))
    } catch {
      setNote('The request did not reach the world server. Nothing was parsed and nothing was priced.')
    }
    setBusy('')
  }

  if (!info) return <p className="jr-empty">{note || 'Opening the courier desk…'}</p>

  const quote = priced?.quote

  return <div className="jr-shield-desk">
    {/* First, and never behind anything. A player reads what this does and
        what it does not hide before they are asked for an address. */}
    <PrivacyStatement statement={priced?.statement ?? info.statement} />

    <label className="jr-shield-field">
      <span>YOUR ZCASH ADDRESS</span>
      <input
        value={address}
        onChange={event => setAddress(event.target.value)}
        placeholder="a shielded-only unified address"
        spellCheck={false}
        autoComplete="off"
      />
      <small>
        Parsed by {info.accepts.parser.name} {info.accepts.parser.version}. {info.accepts.parser.note}
      </small>
    </label>
    <button className="primary full" disabled={busy !== '' || address.trim() === ''} onClick={() => void ask('address')}>
      {busy === 'address' ? 'Reading the address…' : 'Check this address'}
    </button>

    {refused && <div className="jr-shield-refusal">
      <div className="jr-ledger-head"><span>REFUSED</span><b>{refused.code}</b></div>
      <h5>{refused.headline}</h5>
      <p>{refused.says}</p>
      <p className="jr-shield-do"><b>WHAT TO DO</b>{refused.doThis}</p>
    </div>}

    {checked && <div className="jr-shield-ok">
      <div className="jr-ledger-head"><span>ACCEPTED</span><b>{checked.receivers.join(' · ').toUpperCase()}</b></div>
      <p>{checked.says}</p>
    </div>}

    {(checked || priced) && <>
      <label className="jr-shield-field">
        <span>AMOUNT TO PRICE</span>
        <input value={sol} onChange={event => setSol(event.target.value)} spellCheck={false} autoComplete="off" />
        <small>
          SOL, between {info.accepts.minSol} and {info.accepts.maxSol}. Naming an amount prices the route and
          nothing else: no gold moves, nothing is reserved, and no payment is prepared.
        </small>
      </label>
      <button className="primary full" disabled={busy !== ''} onClick={() => void ask('quote')}>
        {busy === 'quote' ? 'Pricing the route…' : 'Price this run'}
      </button>
    </>}

    {note && <p className="jr-empty">{note}</p>}

    {priced && quote && <div className="jr-shield-quote">
      <div className="jr-ledger-head"><span>PRICED · DRY QUOTE</span><b>NO DEPOSIT ADDRESS</b></div>
      <strong>{quote.headline}</strong>
      <div className="jr-shield-rows">
        <div><b>{quote.sol} SOL</b><small>in</small></div>
        <div><b>{quote.zec} ZEC</b><small>expected out</small></div>
        <div><b>{quote.minZec} ZEC</b><small>least you would get</small></div>
      </div>
      <p>{quote.worstCase}</p>
      <div className="jr-meta">
        <span>verdict {priced.verdict.verdict}</span>
        <span>{quote.signatureVerified ? 'quote signature verified' : 'quote signature unverified'}</span>
      </div>
      <p>{priced.verdict.explanation}</p>
      <p className="jr-shield-do"><b>THE PROVIDER STILL DOCUMENTS</b>{priced.verdict.documentedSupport} — contradicted by what the connector is observed doing on chain, and kept here because a verdict that overrides a provider&rsquo;s own words has to quote them.</p>
      {priced.intent && <div className="jr-shield-ok">
        <div className="jr-ledger-head"><span>INTENT FROZEN</span><b>{priced.intent.state.toUpperCase()}</b></div>
        <p>{priced.intent.intentId} · receivers {priced.intent.receivers.join(', ')} · expires {when(priced.intent.expiresAtMs)}</p>
        <p>{priced.intent.note}</p>
      </div>}
    </div>}

    <WhereItStops stops={priced?.stops ?? info.stops} />
  </div>
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

    {desk?.services.map(service => {
      if (service.availability.state === 'available') {
        return <div className="jr-card" key={service.id}>
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
      }

      /* Open, and unable to pay. Drawn at full strength rather than dimmed
         like a shut desk, with what it does and where it stops side by side
         and neither of them collapsed. */
      if (service.availability.state === 'read-only') {
        const { headline, does, because } = service.availability
        return <div className="jr-card jr-shield" key={service.id}>
          <div className="task-head"><span>{service.npc}</span><b className="jr-shield-state">{headline}</b></div>
          <h4>{service.title}</h4>
          <p>{service.what}</p>
          <div className="jr-meta"><span>{service.keeper}</span><span>from {service.derivedFrom.join(', ')}</span></div>
          <div className="jr-shield-split">
            <div><b>THE DESK DOES</b><span>{does.join(' ')}</span></div>
            <div className="jr-shield-not"><b>AND CANNOT</b><span>{because.join(' ')}</span></div>
          </div>
          {service.desk
            ? <ShieldedCourierDesk endpoint={service.desk} />
            : <p className="jr-empty">This desk names no endpoint, so nothing can be worked at it.</p>}
        </div>
      }

      return <div className="jr-card" key={service.id} style={{ opacity: 0.72 }}>
        <div className="task-head"><span>{service.npc}</span><b style={{ color: '#8a3a1e' }}>UNAVAILABLE</b></div>
        <h4>{service.title}</h4>
        <p>{service.availability.headline}</p>
        <p style={{ marginTop: 8 }}>{service.availability.because.join(' ')}</p>
        <div className="jr-meta"><span>No price</span><span>Nothing to buy</span></div>
      </div>
    })}

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
