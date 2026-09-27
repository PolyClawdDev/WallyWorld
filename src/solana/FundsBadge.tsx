/* ------------------------------------------------------------------ *
 * The network badge.
 *
 * Every "is this real money" indicator in the app renders through this
 * component, reading the same store as the wallet panel, so the HUD and
 * the panel cannot drift apart or contradict each other. The text itself
 * comes from `fundsLabel` in cluster.ts, which is the single place the
 * demo/test/live wording is decided.
 * ------------------------------------------------------------------ */

import React from 'react'
import { fundsLabel } from './cluster'
import { useWallet } from './wallet'
// The badge renders in the HUD whether or not the wallet panel is mounted, so it
// carries the stylesheet import too. Vite dedupes it.
import './solana.css'

/** `chip` is the in-world HUD; `dot` is the pre-game header; `foot` is the entry screen. */
export type BadgeVariant = 'chip' | 'dot' | 'foot'

export function FundsBadge({ variant = 'chip' }: { variant?: BadgeVariant }) {
  const wallet = useWallet()
  const label = fundsLabel(wallet.status === 'connected')
  return (
    <div
      className={`funds-badge funds-${variant} funds-${label.mode}`}
      title={label.long}
      role={label.mode === 'live' ? 'alert' : undefined}
      data-funds-mode={label.mode}
    >
      {label.mode === 'live' && <i className="funds-siren" aria-hidden="true" />}
      <span>{label.short}</span>
    </div>
  )
}

/**
 * Full-width banner shown only on mainnet. Separate from the badge because a
 * chip in the corner is not proportionate to "this can spend your money".
 */
export function MainnetWarningBanner() {
  const wallet = useWallet()
  const label = fundsLabel(wallet.status === 'connected')
  if (label.mode !== 'live') return null
  return (
    <div className="mainnet-banner" role="alert">
      <strong>MAINNET — REAL FUNDS</strong>
      <span>{label.long}</span>
    </div>
  )
}
