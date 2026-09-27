import React, { useEffect, useRef } from 'react'

/**
 * Shared popup chrome. One centred frame, one backdrop, one close affordance,
 * so the pouch, the map, and any panel adopting it later stay identical.
 * Escape is owned by the App shortcut handler; clicking the backdrop closes.
 */
export function Popup({ label, size = 'panel', onClose, children }: {
  label: string
  size?: 'panel' | 'wide'
  onClose: () => void
  children: React.ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => { frame.current?.focus({ preventScroll: true }) }, [])
  return <div className="popup-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className={`popup popup-${size}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={frame}>
      <span className="popup-corners" aria-hidden="true"><i /><i /><i /><i /></span>
      <button className="popup-close" onClick={onClose} aria-label="Close">×</button>
      <div className="popup-body">{children}</div>
    </div>
  </div>
}
