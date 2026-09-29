import { spans } from '../voxelBuild'

/* ------------------------------------------------------------------ *
 * Pixel art for the floor.
 *
 * Same technique as src/emblems.ts: rows of characters extruded into
 * cubes by `Batch.plate`, authored through `spans` so every row is the
 * declared width by construction rather than by careful typing.
 *
 * `#` lights. `-` is the dim inlay channel cut around a lit glyph, which
 * is what stops a rune reading as a sticker: the eye needs the unlit
 * groove to believe the light is coming out of the stone.
 * ------------------------------------------------------------------ */

const W = 7

/** Eight perimeter runes, so the ring never shows the same mark twice running. */
export const PERIMETER_RUNES: string[][] = [
  // spear
  spans(W, [
    [[3, 3, '#']],
    [[2, 4, '#']],
    [[3, 3, '#']],
    [[1, 5, '#']],
    [[3, 3, '#']],
    [[3, 3, '#']],
    [[2, 4, '#']],
  ]),
  // lens
  spans(W, [
    [[3, 3, '#']],
    [[2, 2, '#'], [4, 4, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[0, 0, '#'], [6, 6, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[2, 2, '#'], [4, 4, '#']],
    [[3, 3, '#']],
  ]),
  // gate
  spans(W, [
    [[1, 5, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[1, 1, '#'], [3, 3, '#'], [5, 5, '#']],
    [[1, 1, '#'], [3, 3, '#'], [5, 5, '#']],
    [[1, 1, '#'], [3, 3, '#'], [5, 5, '#']],
    [[0, 6, '#']],
  ]),
  // fork
  spans(W, [
    [[1, 1, '#'], [5, 5, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[2, 2, '#'], [4, 4, '#']],
    [[3, 3, '#']],
    [[3, 3, '#']],
    [[2, 4, '#']],
    [[1, 5, '#']],
  ]),
  // current
  spans(W, [
    [[0, 2, '#']],
    [[2, 2, '#'], [4, 6, '#']],
    [[2, 2, '#'], [4, 4, '#']],
    [[0, 6, '#']],
    [[2, 2, '#'], [4, 4, '#']],
    [[0, 2, '#'], [4, 4, '#']],
    [[4, 6, '#']],
  ]),
  // knot
  spans(W, [
    [[2, 4, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[1, 1, '#'], [3, 3, '#'], [5, 5, '#']],
    [[0, 6, '#']],
    [[1, 1, '#'], [3, 3, '#'], [5, 5, '#']],
    [[1, 1, '#'], [5, 5, '#']],
    [[2, 4, '#']],
  ]),
  // chevron
  spans(W, [
    [[3, 3, '#']],
    [[2, 4, '#']],
    [[1, 5, '#']],
    [[0, 6, '#']],
    [[2, 4, '#']],
    [[2, 4, '#']],
    [[2, 4, '#']],
  ]),
  // crescent
  spans(W, [
    [[1, 4, '#']],
    [[0, 1, '#'], [4, 5, '#']],
    [[0, 0, '#'], [5, 5, '#']],
    [[0, 0, '#'], [3, 3, '#'], [5, 5, '#']],
    [[0, 0, '#'], [5, 5, '#']],
    [[0, 1, '#'], [4, 5, '#']],
    [[1, 4, '#']],
  ]),
]

/* ------------------------------------------------------------------ *
 * The two marks that are not decoration.
 *
 * Spawn sigils and the centre medallion are rasterised rather than typed
 * because they are rings, and a hand-typed ring is always slightly oval.
 * ------------------------------------------------------------------ */

type Ink = (x: number, y: number, r: number, a: number) => string | null

/** Draw a square grid of `size` cells by asking `ink` about each one. */
function raster(size: number, ink: Ink): string[] {
  const c = (size - 1) / 2
  const rows: string[] = []
  for (let y = 0; y < size; y++) {
    let row = ''
    for (let x = 0; x < size; x++) {
      const dx = x - c
      // Rows read top-down, so screen-y is inverted to get world-forward +y.
      const dy = c - y
      row += ink(dx, dy, Math.hypot(dx, dy), Math.atan2(dy, dx)) ?? '.'
    }
    rows.push(row)
  }
  return rows
}

/**
 * The mark a duellist stands on: a broken ring with a chevron inside it
 * pointing at the centre of the floor, so a player who spawns facing the
 * wrong way can see which way the fight is.
 *
 * 13 cells across. At the 0.2m cell the arena builds it with, that is a
 * 2.6m disc — wide enough to stand in and be seen from the far spawn,
 * small enough that it is a marking rather than a dais.
 */
export const SPAWN_SIGIL = raster(15, (dx, dy, r, a) => {
  // Outer ring, with four gaps on the diagonals so it reads as forged
  // rather than printed.
  if (r > 5.9 && r < 7.2) {
    const near = Math.abs(((a / Math.PI) * 4 + 8) % 2 - 1)
    return near < 0.26 ? null : '#'
  }
  // A double chevron aimed at -y, which the arena then turns to point at
  // the middle of the floor. Two strokes read as a direction; one reads
  // as a scratch.
  if (Math.abs(dx) <= 3.5) {
    if (Math.abs(Math.abs(dx) + dy - 1) < 0.6) return '#'
    if (Math.abs(Math.abs(dx) + dy + 2) < 0.6) return '#'
  }
  if (r > 3.2 && r < 4.4) return '-'
  return null
})

/**
 * The centre medallion.
 *
 * Deliberately the dimmest lit thing on the floor. The brief wants an
 * unobstructed middle, so this is flush inlay and low glow: it gives the
 * centre a landmark to orient against without competing with a health
 * bar or a telegraph drawn on top of it.
 */
export const CENTRE_MEDALLION = raster(23, (_dx, _dy, r, a) => {
  if (r > 10.3 && r < 11.2) return '#'
  if (r > 9.2 && r < 9.8) return '-'
  // Eight spokes, stopping well short of the middle. Unlit: the centre of
  // the floor is where telegraphs and health bars get drawn, and a bright
  // ring under a fight is one more thing to read past.
  if (r > 5.6 && r < 9.0) {
    const near = Math.abs(((a / Math.PI) * 4 + 8) % 1 - 0.5)
    return near > 0.44 ? '-' : null
  }
  if (r > 3.4 && r < 4.1) return '-'
  if (r < 1.6) return '-'
  return null
})
