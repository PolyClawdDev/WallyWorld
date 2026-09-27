import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shared popup shell for every panel in the world: pouch, chart, journal,
 * brass plate. The shell owns the material frame, the corner rivets, the
 * label banner, the close stud and window dragging, so all four read as
 * objects from the same town and behave the same way.
 *
 * Dragging is deliberately limited to the banner. The pouch drags item
 * stacks out of its slots and drops them on NPCs in the 3D scene, so a
 * body-wide drag handle would make both gestures fight each other.
 *
 * Escape is owned by the App shortcut handler; clicking the backdrop closes.
 */
export type PopupVariant = 'pouch' | 'chart' | 'book' | 'plate'

type Offset = { x: number; y: number }

/** Where each panel was left this session, with the viewport it was left in. */
const remembered = new Map<PopupVariant, Offset & { vw: number; vh: number }>()

const EDGE = 12

export function Popup({ variant, eyebrow, title, note, size = 'panel', onClose, children }: {
  variant: PopupVariant
  eyebrow: string
  title: string
  /** Small right-aligned text on the banner, e.g. a map's scale. */
  note?: React.ReactNode
  size?: 'panel' | 'wide'
  onClose: () => void
  children: React.ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const offset = useRef<Offset>((() => {
    const saved = remembered.get(variant)
    // A materially different viewport makes the remembered spot meaningless.
    if (!saved || Math.abs(saved.vw - window.innerWidth) > 120 || Math.abs(saved.vh - window.innerHeight) > 120) return { x: 0, y: 0 }
    return { x: saved.x, y: saved.y }
  })())
  const [, redraw] = useState(0)
  const [dragging, setDragging] = useState(false)
  const grab = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  /** Keeps the whole frame inside the viewport, so a panel can never be lost. */
  const clamp = useCallback(({ x, y }: Offset): Offset => {
    const element = frame.current
    if (!element) return { x, y }
    const box = element.getBoundingClientRect()
    const baseLeft = box.left - offset.current.x
    const baseTop = box.top - offset.current.y
    const minX = EDGE - baseLeft
    const maxX = window.innerWidth - EDGE - box.width - baseLeft
    const minY = EDGE - baseTop
    const maxY = window.innerHeight - EDGE - box.height - baseTop
    return {
      x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
      y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
    }
  }, [])

  const move = useCallback((next: Offset) => {
    offset.current = next
    const element = frame.current
    if (element) element.style.transform = `translate(${next.x}px, ${next.y}px)`
  }, [])

  useEffect(() => {
    frame.current?.focus({ preventScroll: true })
    move(clamp(offset.current))
    redraw(value => value + 1)
  }, [clamp, move])

  // A smaller window can leave a remembered offset hanging off the edge.
  useEffect(() => {
    const onResize = () => move(clamp(offset.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp, move])

  const release = useCallback(() => {
    if (!grab.current) return
    grab.current = null
    setDragging(false)
    remembered.set(variant, { ...offset.current, vw: window.innerWidth, vh: window.innerHeight })
  }, [variant])

  // Pointer capture normally keeps the stream alive, but a drag that ends off
  // the window (or loses capture) must still let go of the panel.
  useEffect(() => {
    if (!dragging) return
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [dragging, release])

  const onGrab = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    grab.current = { px: event.clientX, py: event.clientY, ox: offset.current.x, oy: offset.current.y }
    setDragging(true)
  }
  const onDrag = (event: React.PointerEvent) => {
    const held = grab.current
    if (!held) return
    move(clamp({ x: held.ox + event.clientX - held.px, y: held.oy + event.clientY - held.py }))
  }

  return <div className="popup-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div
      className={`popup popup-${variant}${size === 'wide' ? ' popup-wide' : ''}${dragging ? ' dragging' : ''}`}
      style={{ transform: `translate(${offset.current.x}px, ${offset.current.y}px)` }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      ref={frame}
    >
      <span className="popup-corners" aria-hidden="true"><i /><i /><i /><i /></span>
      <button className="popup-close" onClick={onClose} aria-label="Close">×</button>
      <header
        className="popup-banner"
        onPointerDown={onGrab}
        onPointerMove={onDrag}
        onPointerUp={release}
        title="Drag to move this panel"
      >
        <span className="popup-grip" aria-hidden="true" />
        <div className="popup-banner-text">
          <div className="eyebrow">{eyebrow}</div>
          <h2>{title}</h2>
        </div>
        {note && <div className="popup-note">{note}</div>}
      </header>
      <div className="popup-body">{children}</div>
    </div>
  </div>
}
