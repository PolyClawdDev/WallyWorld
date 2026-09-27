import React, { useEffect, useMemo, useRef, useState } from 'react'
import { isWorldReady, npcAtScreen } from './worldBridge'

/* ------------------------------------------------------------------ *
 * Demo pouch. Nothing here custodies, sends, or receives value: the
 * items are local fiction, the SOL and token stacks are labelled demo
 * items, and no wallet, key, or Solana endpoint is involved anywhere.
 * Every amount is an integer of base units (lamports-style) and is only
 * turned into a decimal string at render time.
 * ------------------------------------------------------------------ */

type PixelArt = { palette: Record<string, string>; grid: string[] }

/* Icons reuse the occupancy-grid idea from the character sprites: a 12x12
 * grid of palette keys, drawn as crisp squares so they read as chunky pixels
 * next to the voxel town. '.' is transparent. */

/**
 * Coins are rasterised rather than hand-typed: a 12px disc with a dark rim, a
 * top-lit face, and a stamp function that carves the design out of the middle.
 */
function disc(palette: Record<string, string>, stamp: (dx: number, dy: number) => string | null, face: (dx: number, dy: number) => string): PixelArt {
  const centre = 5.5
  const radius = 5.6
  const grid = Array.from({ length: 12 }, (_, y) => {
    let row = ''
    for (let x = 0; x < 12; x++) {
      const dx = x - centre
      const dy = y - centre
      const distance = Math.hypot(dx, dy)
      row += distance > radius ? '.' : distance > radius - 1.05 ? 'o' : stamp(dx, dy) ?? face(dx, dy)
    }
    return row
  })
  return { palette, grid }
}

const litFace = (light: string, mid: string, dark: string) => (dx: number, dy: number) => (dy < -2 ? light : dy + dx * 0.4 > 2.4 ? dark : mid)

/* Town gold: a struck cross stamp, the same brass the lanterns use. */
const coinArt = disc(
  { o: '#6f451a', h: '#ffe6a3', g: '#f0b84d', s: '#c08029', k: '#8a5a1e' },
  (dx, dy) => ((Math.abs(dx) <= 1 && Math.abs(dy) <= 3) || (Math.abs(dy) <= 1 && Math.abs(dx) <= 3) ? 'k' : null),
  litFace('h', 'g', 's'),
)

/* Demo SOL coin: three slanted bars, drawn here, not imported from anywhere. */
const solArt = disc(
  { o: '#161a2e', d: '#474d76', h: '#636aa0', s: '#2f3358', c: '#8ff0f5', p: '#c3aff0' },
  (dx, dy) => {
    for (const band of [{ centre: -3, key: 'c' }, { centre: 0, key: 'p' }, { centre: 3, key: 'c' }]) {
      const local = dy - band.centre
      if (Math.abs(local) > 1) continue
      if (Math.abs(dx - (local < 0 ? -1 : 1)) <= 3.4) return band.key
    }
    return null
  },
  litFace('h', 'd', 's'),
)

/* One faceted shard, recoloured per token so the tokens stay siblings. */
const shardGrid = [
  '....oooo....',
  '...olltdo...',
  '..olltttdo..',
  '.olltttttdo.',
  'olltttttttdo',
  'oltttttttddo',
  'oltttttttddo',
  '.olttttttdo.',
  '..olttttdo..',
  '...olttdo...',
  '....oddo....',
  '.....oo.....',
]

const shard = (o: string, l: string, t: string, d: string): PixelArt => ({ palette: { o, l, t, d }, grid: shardGrid })

type ItemId = 'gold' | 'sol' | 'wally' | 'ember'

type ItemDef = {
  id: ItemId
  name: string
  symbol: string
  /** Display divisor only. Stored amounts are always integer base units. */
  decimals: number
  art: PixelArt
  note: string
  demo: boolean
}

const items: Record<ItemId, ItemDef> = {
  gold: { id: 'gold', name: 'Town Gold', symbol: 'GOLD', decimals: 0, art: coinArt, note: 'Hunting loot · simulated', demo: true },
  sol: { id: 'sol', name: 'Demo SOL Coin', symbol: 'SOL', decimals: 9, art: solArt, note: 'Demo item · not real SOL', demo: true },
  wally: { id: 'wally', name: 'Demo Wally Shard', symbol: 'WALLY', decimals: 6, art: shard('#22383a', '#cdf3f4', '#7bc9ce', '#3f7f86'), note: 'Demo token · no mint exists', demo: true },
  ember: { id: 'ember', name: 'Demo Ember Shard', symbol: 'EMBER', decimals: 4, art: shard('#3a2320', '#ffcfa4', '#e37c42', '#94451f'), note: 'Demo token · no mint exists', demo: true },
}

const SLOT_COUNT = 20
const STORE_KEY = 'wally-pouch-v1'

type Stack = { def: ItemId; amount: bigint }
type Slots = (Stack | null)[]
type Gift = { npc: string; label: string; at: number; proximity: boolean }

const emptySlots = (): Slots => Array.from({ length: SLOT_COUNT }, () => null)

/** Starting demo stacks. Gold is injected from the world's loot counter. */
function startingSlots(): Slots {
  const slots = emptySlots()
  slots[1] = { def: 'sol', amount: 250_000_000n }
  slots[2] = { def: 'wally', amount: 1_250_000_000n }
  slots[3] = { def: 'ember', amount: 420_000n }
  return slots
}

type Saved = { slots: Array<{ def: string; amount: string } | null>; gifts?: Gift[] }

function load(): { slots: Slots; gifts: Gift[] } {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { slots: startingSlots(), gifts: [] }
    const parsed = JSON.parse(raw) as Saved
    const slots = emptySlots()
    parsed.slots?.slice(0, SLOT_COUNT).forEach((entry, index) => {
      if (entry && entry.def in items) slots[index] = { def: entry.def as ItemId, amount: BigInt(entry.amount || '0') }
    })
    return { slots, gifts: Array.isArray(parsed.gifts) ? parsed.gifts.slice(0, 8) : [] }
  } catch {
    return { slots: startingSlots(), gifts: [] }
  }
}

function save(slots: Slots, gifts: Gift[]) {
  const payload: Saved = { slots: slots.map(stack => (stack ? { def: stack.def, amount: stack.amount.toString() } : null)), gifts }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)) } catch { /* private mode: the pouch just stays in memory */ }
}

/** Integer base units to a display string. No float ever touches an amount. */
function formatUnits(amount: bigint, decimals: number) {
  const digits = (amount < 0n ? -amount : amount).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : ''
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${amount < 0n ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}

/** World-supplied text is untrusted display data and can never authorise anything. */
function safeName(raw: string) {
  return raw.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40)
}

const shortName = (raw: string) => safeName(raw).split('·')[0].trim() || 'Someone'
const giveable = (target: string | null) => (target && !target.startsWith('ANIMAL:') ? target : null)

function PixelIcon({ art }: { art: PixelArt }) {
  const cells: React.ReactNode[] = []
  art.grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = art.palette[row[x]]
      if (color) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={color} />)
    }
  })
  return <svg className="pixel-icon" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">{cells}</svg>
}

type DragState = { from: number; x: number; y: number; ox: number; oy: number; moved: boolean; target: string | null }

export function WalletPouch({ gold, onGoldChange, nearbyNpc, onToast, connection, demo = true }: {
  gold: number
  onGoldChange: (next: number) => void
  nearbyNpc: string | null
  onToast: (message: string) => void
  /**
   * Slot for the Solana integration: render connection state, the wallet
   * address, and any live balances here. It is drawn inside the pouch strap
   * area, above the demo stacks, and this component never reads or writes it.
   */
  connection?: React.ReactNode
  /**
   * True while the pouch holds simulated items only. Pass false once real
   * custody is wired up so the money state plate switches from
   * "Demo — no real funds" to a live-funds warning instead of the label
   * being permanent decoration.
   */
  demo?: boolean
}) {
  const initial = useRef(load())
  const [slots, setSlots] = useState<Slots>(initial.current.slots)
  const [gifts, setGifts] = useState<Gift[]>(initial.current.gifts)
  const [selected, setSelected] = useState<number | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const slotsRef = useRef(slots)
  // Window-level pointer handlers outlive a render, so live props and slots are
  // read through refs instead of stale closures.
  const live = useRef({ gold, onGoldChange, nearbyNpc, onToast })
  useEffect(() => { live.current = { gold, onGoldChange, nearbyNpc, onToast } })
  useEffect(() => { slotsRef.current = slots; save(slots, gifts) }, [slots, gifts])

  // Loot picked up in the world lands in the first free slot and keeps counting.
  useEffect(() => {
    setSlots(current => {
      const held = current.findIndex(stack => stack?.def === 'gold')
      if (gold <= 0) return held === -1 ? current : current.map((stack, index) => (index === held ? null : stack))
      if (held !== -1) return current.map((stack, index) => (index === held ? { def: 'gold', amount: BigInt(gold) } : stack))
      const free = current.indexOf(null)
      if (free === -1) return current
      return current.map((stack, index) => (index === free ? { def: 'gold', amount: BigInt(gold) } : stack))
    })
  }, [gold])

  const amountOf = (stack: Stack) => (stack.def === 'gold' ? BigInt(Math.max(0, Math.trunc(live.current.gold))) : stack.amount)

  const balances = useMemo(() => {
    const totals = new Map<ItemId, bigint>()
    slots.forEach(stack => {
      if (!stack) return
      const amount = stack.def === 'gold' ? BigInt(Math.max(0, Math.trunc(gold))) : stack.amount
      totals.set(stack.def, (totals.get(stack.def) ?? 0n) + amount)
    })
    return (['sol', 'wally', 'ember', 'gold'] as ItemId[])
      .map(id => ({ def: items[id], amount: totals.get(id) ?? 0n }))
  }, [slots, gold])

  const setDragState = (next: DragState | null) => { dragRef.current = next; setDrag(next) }

  const slotAtPoint = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest('[data-slot]') as HTMLElement | null
    const index = el ? Number(el.dataset.slot) : NaN
    return Number.isInteger(index) ? index : null
  }

  const moveStack = (from: number, to: number) => {
    if (from === to) return
    setSlots(current => {
      const next = current.slice()
      const moved = next[from]
      next[from] = next[to]
      next[to] = moved
      return next
    })
    setSelected(to)
  }

  const give = (index: number, npcRaw: string, proximity: boolean) => {
    const stack = slotsRef.current[index]
    if (!stack) { live.current.onToast('That slot is empty — there is nothing to hand over.'); return }
    const def = items[stack.def]
    const amount = amountOf(stack)
    if (amount <= 0n) { live.current.onToast(`No ${def.symbol} left to give.`); return }
    const label = `${formatUnits(amount, def.decimals)} ${def.symbol}`
    const npc = shortName(npcRaw)
    setSlots(current => current.map((entry, i) => (i === index ? null : entry)))
    if (def.id === 'gold') live.current.onGoldChange(0)
    setGifts(current => [{ npc, label, at: Date.now(), proximity }, ...current].slice(0, 8))
    setSelected(null)
    live.current.onToast(`${npc} accepted ${label}${proximity ? ' (nearest townsperson)' : ''} · simulated gift, no real funds moved`)
  }

  const finish = (x: number, y: number) => {
    const current = dragRef.current
    setDragState(null)
    if (!current) return
    if (!current.moved) {
      const stack = slotsRef.current[current.from]
      if (!stack) { setSelected(null); live.current.onToast('Empty slot.'); return }
      setSelected(previous => (previous === current.from ? null : current.from))
      return
    }
    // A drag that ends outside the panel would otherwise synthesise a click on
    // the backdrop and close the pouch mid-give.
    const swallow = (event: Event) => { event.stopPropagation(); event.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 60)

    const slot = slotAtPoint(x, y)
    if (slot !== null) { moveStack(current.from, slot); return }
    const hit = npcAtScreen(x, y)
    const fallback = hit ? null : giveable(live.current.nearbyNpc)
    const target = hit ?? fallback
    if (!target) {
      live.current.onToast(isWorldReady()
        ? 'No one under the cursor. Drop an item on a townsperson, or stand beside one first.'
        : 'The world is not loaded, so there is no one to give this to.')
      return
    }
    give(current.from, target, !hit)
  }

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current) return
      const moved = current.moved || Math.abs(event.clientX - current.ox) > 4 || Math.abs(event.clientY - current.oy) > 4
      const overSlot = slotAtPoint(event.clientX, event.clientY) !== null
      setDragState({
        ...current,
        x: event.clientX,
        y: event.clientY,
        moved,
        target: moved && !overSlot ? npcAtScreen(event.clientX, event.clientY) : null,
      })
    }
    const up = (event: PointerEvent) => finish(event.clientX, event.clientY)
    const cancel = () => setDragState(null)
    document.body.classList.add('pouch-dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      document.body.classList.remove('pouch-dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [dragging])
  useEffect(() => () => document.body.classList.remove('pouch-dragging'), [])

  const startDrag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    setDragState({ from: index, x: event.clientX, y: event.clientY, ox: event.clientX, oy: event.clientY, moved: false, target: null })
  }

  const dragged = drag && drag.moved ? slots[drag.from] : null
  const hovering = giveable(nearbyNpc)
  const chosen = selected !== null ? slots[selected] : null

  return <>
    <div className="pouch-strap">
      <span className="pouch-buckle" aria-hidden="true" />
      <div>
        <strong>WAYFINDER'S POUCH</strong>
        <small>{slots.filter(Boolean).length} of {SLOT_COUNT} compartments filled</small>
      </div>
      <span className={`wui-state ${demo ? 'demo' : 'live'}`}>
        <i aria-hidden="true" />{demo ? 'DEMO — NO REAL FUNDS' : 'LIVE FUNDS — REAL VALUE'}
      </span>
    </div>
    {connection && <div className="pouch-connect">{connection}</div>}
    <div className="pouch-balances">
      {balances.map(({ def, amount }) => <div key={def.id} className="pouch-bal">
        <PixelIcon art={def.art} />
        <div><strong>{formatUnits(amount, def.decimals)}</strong><small>{def.symbol}</small></div>
        <em>{demo ? 'DEMO' : 'LIVE'}</em>
      </div>)}
    </div>
    <div className="pouch-grid" role="group" aria-label="Pouch inventory grid">
      {slots.map((stack, index) => {
        const def = stack ? items[stack.def] : null
        const amount = stack ? amountOf(stack) : 0n
        const classes = ['pouch-slot']
        if (!stack) classes.push('empty')
        if (selected === index) classes.push('chosen')
        if (drag?.moved && drag.from === index) classes.push('lifted')
        return <button
          key={index}
          type="button"
          data-slot={index}
          className={classes.join(' ')}
          onPointerDown={stack ? startDrag(index) : undefined}
          onClick={() => { if (!stack) { setSelected(null); live.current.onToast('Empty slot.') } }}
          aria-label={def ? `${def.name}, ${formatUnits(amount, def.decimals)} ${def.symbol}, demo item` : `Empty slot ${index + 1}`}
          title={def ? `${def.name} · ${def.note}` : 'Empty slot'}
        >
          {def && <PixelIcon art={def.art} />}
          {def && <span className="pouch-qty">{def.decimals === 0 ? `×${formatUnits(amount, 0)}` : formatUnits(amount, def.decimals)}</span>}
        </button>
      })}
    </div>
    <div className="pouch-action">
      {chosen ? <>
        <span>{items[chosen.def].name} · {formatUnits(amountOf(chosen), items[chosen.def].decimals)} {items[chosen.def].symbol}</span>
        <button className="primary full" disabled={!hovering} onClick={() => selected !== null && hovering && give(selected, hovering, true)}>
          {hovering ? `Give to ${shortName(hovering)}` : 'No one nearby to give this to'}
        </button>
      </> : <span>Tap a slot to select it, or drag a stack onto a townsperson in the world.</span>}
    </div>
    {gifts.length > 0 && <div className="pouch-gifts">
      <div className="task-head"><span>GIFT LOG</span><b>SIMULATED</b></div>
      {gifts.map(gift => <div key={gift.at} className="pouch-gift">
        <i>✓</i>
        <div><strong>{gift.label} → {gift.npc}</strong><small>{gift.proximity ? 'Offered to the nearest townsperson' : 'Dropped directly on them'} · no real funds moved</small></div>
      </div>)}
    </div>}
    <p className="pouch-note">{demo
      ? 'Dropped over open ground a stack goes to whoever you stand beside. Every stack here is simulated: no mint behind the items, no key in this panel, and it will never ask for a seed phrase.'
      : 'Dropped over open ground a stack goes to whoever you stand beside. Real funds: amounts are held as integer base units and formatted only for display. This panel will never ask for a seed phrase.'}</p>
    {dragged && <>
      <div className="pouch-ghost" style={{ left: drag!.x, top: drag!.y }}><PixelIcon art={items[dragged.def].art} /></div>
      <div className={`pouch-hint${drag!.target ? ' on' : ''}`} style={{ left: drag!.x, top: drag!.y }}>
        {drag!.target ? `GIVE TO ${shortName(drag!.target).toUpperCase()}` : hovering ? `DROP ON SOMEONE · OR OFFER TO ${shortName(hovering).toUpperCase()}` : 'DROP ON A TOWNSPERSON'}
      </div>
    </>}
  </>
}
