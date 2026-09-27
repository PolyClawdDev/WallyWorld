import React from 'react'

/* ------------------------------------------------------------------ *
 * Ability icons.
 *
 * Drawn here rather than loaded, because the rest of the project's art
 * is generated too and no image assets ship with the repository. Each
 * one is built from rectangles and straight-edged polygons on a 24×24
 * grid with `shapeRendering="crispEdges"`, so they read as the same
 * chunky pixel work as the town.
 *
 * Two colours only: `currentColor` for the silhouette and `var(--ic)`
 * for the hot accent, both supplied by the HUD from the character's
 * palette. Every glyph is a different shape — no letters, no squares.
 * ------------------------------------------------------------------ */

const A = 'var(--ic, #ffd9a0)'

type Glyph = React.ReactNode

const glyphs: Record<string, Glyph> = {
  /* ---- basic attacks ---- */
  emberbolt: (
    <>
      <polygon points="13,3 19,10 17,10 20,15 13,21 6,15 9,10 7,10" fill="currentColor" />
      <polygon points="13,9 16,14 13,18 10,14" fill={A} />
      <rect x="2" y="11" width="3" height="2" fill="currentColor" opacity="0.65" />
      <rect x="2" y="15" width="4" height="2" fill="currentColor" opacity="0.4" />
    </>
  ),
  thornshot: (
    <>
      <polygon points="21,12 13,7 13,17" fill="currentColor" />
      <rect x="3" y="11" width="11" height="2" fill="currentColor" />
      <polygon points="9,11 5,5 11,10" fill={A} />
      <polygon points="9,13 5,19 11,14" fill={A} />
    </>
  ),
  starshot: (
    <>
      <polygon points="15,2 18,10 23,12 18,14 15,22 12,14 8,12 12,10" fill="currentColor" />
      <polygon points="15,8 17,12 15,16 13,12" fill={A} />
      <rect x="1" y="7" width="6" height="2" fill="currentColor" opacity="0.5" />
      <rect x="2" y="15" width="5" height="2" fill="currentColor" opacity="0.35" />
    </>
  ),
  lanternstrike: (
    <>
      <rect x="9" y="7" width="9" height="11" fill="currentColor" />
      <rect x="11" y="10" width="5" height="6" fill={A} />
      <rect x="8" y="5" width="11" height="2" fill="currentColor" />
      <rect x="12" y="2" width="3" height="3" fill="currentColor" />
      <polygon points="7,4 3,9 4,14 6,18 4,12 6,8" fill={A} opacity="0.85" />
    </>
  ),

  /* ---- passives ---- */
  forgeheat: (
    <>
      <polygon points="12,2 16,8 15,12 18,10 18,16 12,22 6,16 6,10 9,12 8,8" fill="currentColor" />
      <polygon points="12,11 15,16 12,20 9,16" fill={A} />
    </>
  ),
  oldroots: (
    <>
      <polygon points="12,2 18,7 18,12 12,16 6,12 6,7" fill="currentColor" />
      <rect x="11" y="14" width="2" height="8" fill="currentColor" />
      <rect x="5" y="18" width="6" height="2" fill="currentColor" />
      <rect x="13" y="20" width="6" height="2" fill="currentColor" />
      <polygon points="12,5 15,9 12,13 9,9" fill={A} />
    </>
  ),
  resonance: (
    <>
      <rect x="2" y="10" width="5" height="4" fill="currentColor" />
      <rect x="10" y="10" width="5" height="4" fill="currentColor" />
      <rect x="18" y="10" width="4" height="4" fill={A} />
      <polygon points="7,12 10,9 10,15" fill="currentColor" opacity="0.7" />
      <polygon points="15,12 18,9 18,15" fill={A} opacity="0.8" />
      <rect x="18" y="4" width="4" height="3" fill={A} opacity="0.55" />
    </>
  ),
  kindledstep: (
    <>
      <polygon points="8,3 14,3 15,12 7,12" fill="currentColor" />
      <rect x="7" y="15" width="8" height="5" fill="currentColor" />
      <polygon points="18,5 21,10 18,15 20,10" fill={A} />
      <rect x="17" y="17" width="4" height="3" fill={A} opacity="0.7" />
    </>
  ),

  /* ---- CINDER ---- */
  lance: (
    <>
      <polygon points="22,4 14,8 18,12 9,15 13,10 5,13 12,6" fill="currentColor" />
      <polygon points="3,17 9,15 7,21" fill={A} />
      <rect x="15" y="6" width="4" height="2" fill={A} />
    </>
  ),
  bloom: (
    <>
      <polygon points="12,1 15,7 13,7 17,13 11,10 12,15 7,9 10,9 8,4" fill={A} />
      <rect x="2" y="17" width="20" height="2" fill="currentColor" />
      <rect x="4" y="20" width="4" height="2" fill="currentColor" />
      <rect x="10" y="20" width="4" height="2" fill="currentColor" />
      <rect x="16" y="20" width="4" height="2" fill="currentColor" />
    </>
  ),
  flashstep: (
    <>
      <polygon points="21,3 11,13 15,13 8,21 10,14 6,14 14,3" fill={A} />
      <rect x="1" y="6" width="6" height="2" fill="currentColor" opacity="0.7" />
      <rect x="2" y="11" width="5" height="2" fill="currentColor" opacity="0.5" />
      <rect x="1" y="16" width="4" height="2" fill="currentColor" opacity="0.35" />
    </>
  ),
  meteor: (
    <>
      <polygon points="2,2 9,5 5,9" fill="currentColor" opacity="0.6" />
      <polygon points="6,4 13,8 8,12" fill="currentColor" />
      <polygon points="15,5 21,9 18,15 12,14 11,9" fill={A} />
      <rect x="3" y="19" width="18" height="2" fill="currentColor" />
      <rect x="6" y="17" width="12" height="2" fill="currentColor" opacity="0.55" />
    </>
  ),

  /* ---- BRAMBLE ---- */
  snare: (
    <>
      <rect x="2" y="16" width="7" height="2" fill="currentColor" />
      <polygon points="9,17 12,8 18,6 21,11 17,16 12,14" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <polygon points="13,3 16,7 11,7" fill={A} />
      <polygon points="20,14 23,18 18,18" fill={A} />
    </>
  ),
  wellspring: (
    <>
      <polygon points="12,2 17,9 15,14 9,14 7,9" fill={A} />
      <rect x="3" y="16" width="18" height="2" fill="currentColor" />
      <rect x="5" y="19" width="5" height="2" fill="currentColor" opacity="0.6" />
      <rect x="14" y="19" width="5" height="2" fill="currentColor" opacity="0.6" />
    </>
  ),
  sentinel: (
    <>
      <rect x="9" y="12" width="6" height="10" fill="currentColor" />
      <polygon points="12,1 17,6 15,11 9,11 7,6" fill="currentColor" />
      <polygon points="12,4 15,8 9,8" fill={A} />
      <polygon points="4,10 9,13 3,15" fill="currentColor" />
      <polygon points="20,10 15,13 21,15" fill="currentColor" />
    </>
  ),
  overgrowth: (
    <>
      <polygon points="12,1 19,6 22,13 17,17 12,14 7,17 2,13 5,6" fill="currentColor" />
      <polygon points="12,6 16,11 12,15 8,11" fill={A} />
      <rect x="11" y="15" width="2" height="7" fill="currentColor" />
      <rect x="6" y="20" width="12" height="2" fill="currentColor" opacity="0.55" />
    </>
  ),

  /* ---- ORBIT ---- */
  chain: (
    <>
      <polygon points="9,1 4,11 8,11 5,21 14,9 10,9 13,1" fill={A} />
      <rect x="16" y="3" width="5" height="5" fill="currentColor" />
      <rect x="17" y="15" width="5" height="5" fill="currentColor" />
      <rect x="1" y="13" width="4" height="4" fill="currentColor" opacity="0.6" />
    </>
  ),
  stormcell: (
    <>
      <polygon points="5,11 6,7 11,5 16,7 19,10 19,13 5,13" fill="currentColor" />
      <polygon points="9,14 8,18 10,18 8,23 13,16 11,16 12,14" fill={A} />
      <rect x="15" y="15" width="2" height="4" fill={A} opacity="0.8" />
      <rect x="4" y="15" width="2" height="3" fill={A} opacity="0.6" />
    </>
  ),
  blink: (
    <>
      <polygon points="2,4 8,4 8,7 5,7 5,17 8,17 8,20 2,20" fill="currentColor" />
      <polygon points="22,4 16,4 16,7 19,7 19,17 16,17 16,20 22,20" fill="currentColor" />
      <rect x="9" y="11" width="2" height="2" fill={A} />
      <rect x="13" y="11" width="2" height="2" fill={A} />
      <rect x="11" y="6" width="2" height="2" fill={A} opacity="0.6" />
      <rect x="11" y="16" width="2" height="2" fill={A} opacity="0.6" />
    </>
  ),
  starfall: (
    <>
      <polygon points="12,1 15,6 20,7 16,11 17,16 12,13 7,16 8,11 4,7 9,6" fill={A} />
      <polygon points="10,14 14,14 16,22 8,22" fill="currentColor" />
      <rect x="10" y="16" width="4" height="2" fill={A} opacity="0.7" />
    </>
  ),

  /* ---- MOTH ---- */
  glaive: (
    <>
      <polygon points="12,1 20,5 22,13 16,19 16,14 19,11 17,6 12,5 7,7 5,12 8,17 12,18 12,22 5,19 2,12 4,5" fill="currentColor" />
      <polygon points="12,8 16,12 12,16 8,12" fill={A} />
    </>
  ),
  mark: (
    <>
      <polygon points="12,2 18,6 16,12 12,14 8,12 6,6" fill="currentColor" />
      <polygon points="12,14 17,18 12,22 7,18" fill="currentColor" opacity="0.7" />
      <rect x="11" y="6" width="2" height="12" fill={A} />
      <rect x="7" y="10" width="10" height="2" fill={A} />
    </>
  ),
  anchor: (
    <>
      <rect x="11" y="3" width="2" height="13" fill="currentColor" />
      <rect x="7" y="7" width="10" height="2" fill="currentColor" />
      <polygon points="3,13 6,13 6,17 12,20 18,17 18,13 21,13 21,18 12,23 3,18" fill="currentColor" />
      <rect x="10" y="1" width="4" height="3" fill={A} />
    </>
  ),
  lightfall: (
    <>
      <polygon points="9,1 15,1 20,22 4,22" fill="currentColor" />
      <polygon points="11,3 13,3 15,20 9,20" fill={A} />
      <rect x="1" y="8" width="3" height="2" fill={A} opacity="0.6" />
      <rect x="20" y="8" width="3" height="2" fill={A} opacity="0.6" />
      <rect x="0" y="14" width="3" height="2" fill={A} opacity="0.4" />
      <rect x="21" y="14" width="3" height="2" fill={A} opacity="0.4" />
    </>
  ),
}

export function AbilityIcon({ id, size = 26, className }: { id: string; size?: number; className?: string }) {
  const glyph = glyphs[id]
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {glyph ?? <rect x="4" y="4" width="16" height="16" fill="currentColor" opacity="0.4" />}
    </svg>
  )
}

export function hasIcon(id: string) {
  return id in glyphs
}
