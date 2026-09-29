import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isWorldReady, npcAtScreen } from './worldBridge'
import { embeddedWallet, subscribeEmbeddedWallet } from './solana/embeddedWallet'
import { fetchSolLamports } from './solana/rpc'

/* ------------------------------------------------------------------ *
 * The pouch. Nothing here custodies, sends, or receives value, and no
 * wallet, key, or Solana endpoint is involved anywhere.
 *
 * It holds two different kinds of thing, which is why the labelling is
 * per item rather than one badge over the lot. The SOL and shard stacks
 * are local fiction with no mint behind them. Gold is not: it is real
 * server-held ledger balance, earned by hunting and escrowed for duels,
 * so calling it a demo item was wrong. It is still not redeemable, and
 * `PAYOUTS_ENABLED` in src/server/config.ts is what would change that.
 *
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

/*
 * The Wally and Ember shard art lived here. Both were invented tokens with no
 * mint behind them, handed out as starting stacks, so the pouch opened full of
 * things that could never mean anything. They are gone, along with the shard
 * grid that drew them.
 */

/** Gold is the only thing that can sit in a slot. SOL is read, never carried. */
type ItemId = 'gold'

type ItemDef = {
  id: ItemId
  name: string
  symbol: string
  /** Display divisor only. Stored amounts are always integer base units. */
  decimals: number
  art: PixelArt
  note: string
}

const items: Record<ItemId, ItemDef> = {
  gold: { id: 'gold', name: 'Town Gold', symbol: 'GOLD', decimals: 0, art: coinArt, note: 'Earned by hunting · held by the server' },
}

/** Lamports per SOL. Display divisor only; the balance stays an integer. */
const LAMPORTS_PER_SOL = 1_000_000_000n

const SLOT_COUNT = 20
const STORE_KEY = 'wally-pouch-v1'

type Stack = { def: ItemId; amount: bigint }
type Slots = (Stack | null)[]
type Gift = { npc: string; label: string; at: number; proximity: boolean }

const emptySlots = (): Slots => Array.from({ length: SLOT_COUNT }, () => null)

/*
 * A new pouch starts empty. It used to open with 0.25 invented SOL and two
 * invented shards already in it, which made the first thing a player saw a set
 * of holdings they had not earned and could not use. Gold arrives from the
 * world's loot counter as they hunt.
 */

type Saved = { slots: Array<{ def: string; amount: string } | null>; gifts?: Gift[] }

function load(): { slots: Slots; gifts: Gift[] } {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { slots: emptySlots(), gifts: [] }
    const parsed = JSON.parse(raw) as Saved
    const slots = emptySlots()
    parsed.slots?.slice(0, SLOT_COUNT).forEach((entry, index) => {
      if (entry && entry.def in items) slots[index] = { def: entry.def as ItemId, amount: BigInt(entry.amount || '0') }
    })
    return { slots, gifts: Array.isArray(parsed.gifts) ? parsed.gifts.slice(0, 8) : [] }
  } catch {
    return { slots: emptySlots(), gifts: [] }
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

export function WalletPouch({ gold, onGoldChange, nearbyNpc, onToast, connection }: {
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
  /*
   * There was a `demo` prop here, defaulting to true, meant to be switched off
   * once real custody existed. The one caller never passed it and `.wui-state`
   * has no `live` rule, so the "LIVE FUNDS — REAL VALUE" branch it guarded was
   * never reachable or even styled. Labelling now comes from each item's own
   * `demo` flag, which is the thing that actually differs.
   */
}) {
  const initial = useRef(load())
  const [slots, setSlots] = useState<Slots>(initial.current.slots)
  const [gifts, setGifts] = useState<Gift[]>(initial.current.gifts)
  const [selected, setSelected] = useState<number | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Handing a stack over is irreversible, so a drop only proposes the gift and
  // the player has to confirm it against the named amount and recipient.
  const [pending, setPending] = useState<{ from: number; npc: string; proximity: boolean } | null>(null)
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

  const goldHeld = useMemo(
    () => slots.reduce((sum, stack) => (stack?.def === 'gold' ? sum + BigInt(Math.max(0, Math.trunc(gold))) : sum), 0n),
    [slots, gold],
  )

  /*
   * The real balance of the wallet in this browser, read through the RPC proxy.
   * A fresh wallet reads 0 and goes up when someone deposits to that address,
   * which is the whole point: the address is a genuine mainnet address.
   *
   * Read-only by construction. There is no transaction signer in this app, so
   * nothing here can move the balance; the only way it leaves is the player
   * importing the key into a wallet of their own.
   *
   * `null` is "not known", not zero. An unreachable RPC and an empty wallet are
   * different facts, and rendering the first as 0 would be telling the player
   * something false about their own money.
   */
  const [solLamports, setSolLamports] = useState<bigint | null>(null)
  const [solAddress, setSolAddress] = useState<string | null>(() => embeddedWallet()?.address ?? null)

  useEffect(() => subscribeEmbeddedWallet(() => setSolAddress(embeddedWallet()?.address ?? null)), [])

  useEffect(() => {
    if (!solAddress) { setSolLamports(null); return }
    let cancelled = false
    const read = async () => {
      try {
        const lamports = await fetchSolLamports(solAddress)
        if (!cancelled) setSolLamports(lamports)
      } catch {
        // Swallowed on purpose: a failed read must not clear a balance we
        // already showed, and it must not be reported as zero either.
        if (!cancelled) setSolLamports(current => current)
      }
    }
    void read()
    // Polled because a deposit happens outside this app entirely. There is no
    // event here to subscribe to.
    const timer = window.setInterval(() => { void read() }, 20_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [solAddress])

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

  /** Checks the stack is worth giving, then puts the gift up for confirmation. */
  const askGive = (index: number, npcRaw: string, proximity: boolean) => {
    const stack = slotsRef.current[index]
    if (!stack) { live.current.onToast('That slot is empty — there is nothing to hand over.'); return }
    if (amountOf(stack) <= 0n) { live.current.onToast(`No ${items[stack.def].symbol} left to give.`); return }
    setPending({ from: index, npc: npcRaw, proximity })
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
    askGive(current.from, target, !hit)
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

  // Resolved here rather than in the dialog so a stack that empties or moves
  // while the question is open simply withdraws it.
  const pendingStack = (() => {
    if (!pending) return null
    const stack = slots[pending.from]
    if (!stack) return null
    const amount = amountOf(stack)
    return amount > 0n ? { def: items[stack.def], amount } : null
  })()
  useEffect(() => { if (pending && !pendingStack) setPending(null) }, [pending, pendingStack])
  useEffect(() => {
    if (!pending) return
    // Captured, so Escape closes the question and not the whole pouch behind it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      setPending(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

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
      {/* Scoped to the pouch on purpose. Unqualified this sat directly under
          the mainnet strip and read as a claim about the wallet, whose SOL
          balance below is real. It is the carried gold that stays in the game. */}
      <span className="wui-state demo">
        <i aria-hidden="true" />GOLD STAYS IN THE GAME
      </span>
    </div>
    {connection && <div className="pouch-connect">{connection}</div>}
    <div className="pouch-balances">
      <div className="pouch-bal">
        <PixelIcon art={items.gold.art} />
        <div><strong>{formatUnits(goldHeld, items.gold.decimals)}</strong><small>GOLD</small></div>
        <em>EARNED</em>
      </div>
      <div className="pouch-bal">
        <PixelIcon art={solArt} />
        <div><strong>{solLamports === null ? '—' : formatUnits(solLamports, 9)}</strong><small>SOL</small></div>
        <em>{solLamports === null ? (solAddress ? 'READING' : 'NO WALLET') : 'ON CHAIN'}</em>
      </div>
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
          aria-label={def ? `${def.name}, ${formatUnits(amount, def.decimals)} ${def.symbol}` : `Empty slot ${index + 1}`}
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
        <button className="primary full" disabled={!hovering} onClick={() => selected !== null && hovering && askGive(selected, hovering, true)}>
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
    <p className="pouch-note">Dropped over open ground a stack goes to whoever you stand beside. Gold is held
      by the server and stays in the game. The SOL figure is the real balance of your wallet's address, read
      from the chain — send SOL to that address and it appears here. This app cannot spend it: there is no
      transaction signer in it at all, and it will never ask you for a seed phrase.</p>
    {/* the pouch frame is cut out with clip-path, which clips fixed descendants,
        so the carried stack has to hang off the body to follow the cursor */}
    {dragged && createPortal(<>
      <div className="pouch-ghost" style={{ left: drag!.x, top: drag!.y }}><PixelIcon art={items[dragged.def].art} /></div>
      <div className={`pouch-hint${drag!.target ? ' on' : ''}`} style={{ left: drag!.x, top: drag!.y }}>
        {drag!.target ? `GIVE TO ${shortName(drag!.target).toUpperCase()}` : hovering ? `DROP ON SOMEONE · OR OFFER TO ${shortName(hovering).toUpperCase()}` : 'DROP ON A TOWNSPERSON'}
      </div>
    </>, document.body)}
    {pendingStack && createPortal(
      <div
        className="give-ask-backdrop"
        onPointerDown={event => { if (event.target === event.currentTarget) setPending(null) }}
      >
        <div className="give-ask" role="alertdialog" aria-modal="true" aria-labelledby="give-ask-title">
          <div className="popup-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          <span className="give-ask-eyebrow">CONFIRM HANDOVER</span>
          <div className="give-ask-subject">
            <PixelIcon art={pendingStack.def.art} />
            <div>
              <strong id="give-ask-title">
                {formatUnits(pendingStack.amount, pendingStack.def.decimals)} {pendingStack.def.symbol}
              </strong>
              <small>to {shortName(pending!.npc)}</small>
            </div>
          </div>
          <p>
            Are you sure? This leaves your pouch for good — {shortName(pending!.npc)} keeps it and
            there is no way to take it back.
            {pending!.proximity && ' They are simply the townsperson you are standing beside.'}
          </p>
          <span className="wui-state demo">
            <i aria-hidden="true" />GOLD STAYS IN THE GAME
          </span>
          <div className="give-ask-row">
            <button type="button" className="give-ask-no" onClick={() => setPending(null)}>Keep it</button>
            <button
              type="button"
              className="primary give-ask-yes"
              autoFocus
              onClick={() => { const it = pending!; setPending(null); give(it.from, it.npc, it.proximity) }}
            >
              Give it to {shortName(pending!.npc)}
            </button>
          </div>
        </div>
      </div>, document.body)}
  </>
}
