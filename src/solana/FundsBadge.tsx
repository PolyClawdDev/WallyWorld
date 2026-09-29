/* ------------------------------------------------------------------ *
 * The network badge.
 *
 * Every "is this real money" indicator in the app renders through this
 * component, so the HUD and the wallet panel cannot drift apart or
 * contradict each other. The text itself comes from `fundsLabel` in
 * cluster.ts, which is the single place the demo/live wording is decided.
 *
 * It reads no state. The label depends on the configured cluster alone,
 * which is fixed for the life of the build, so there is nothing here to
 * subscribe to and nothing that can change under the player.
 * ------------------------------------------------------------------ */

import React from 'react'
import { fundsLabel } from './cluster'
// The badge renders in the HUD whether or not the wallet panel is mounted, so it
// carries the stylesheet import too. Vite dedupes it.
import './solana.css'

/** `chip` is the in-world HUD; `dot` is the pre-game header; `foot` is the entry screen. */
export type BadgeVariant = 'chip' | 'dot' | 'foot'

export function FundsBadge({ variant = 'chip' }: { variant?: BadgeVariant }) {
  const label = fundsLabel()
  return (
    <div
      className={`funds-badge funds-${variant} funds-${label.mode}`}
      title={label.long}
      data-funds-mode={label.mode}
    >
      <span>{label.short}</span>
    </div>
  )
}
