import type { PlatePlan, Surface } from './voxelBuild'
import { spans } from './voxelBuild'

/* ------------------------------------------------------------------ *
 * Trade emblems.
 *
 * Every emblem in this file is DRAWN HERE, as a pixel grid, in the same
 * idiom as the characters and the animals. Nothing is downloaded, no
 * image file is imported, and no texture is baked outside the code: the
 * grids below are extruded into cubes by `Batch.plate()` and welded into
 * the town mesh, so an emblem costs nothing but the boxes you can count.
 *
 * They exist so a player can tell what somebody does before talking to
 * them. Each one hangs twice: on the shop's own sign board, and on a
 * standard planted beside the townsperson who works there.
 *
 * ---- The Zcash mark ------------------------------------------------
 *
 * `ZCASH` below is a third-party trademark, drawn at 23x23 by
 * `zcashMark()` from the official mark's own measured proportions: black
 * rim, light ring, gold disc, and the struck-through Ⓩ. It is here for
 * one reason only: to label WHICH external network the shielded-transfer
 * desk would talk to. It is deliberately kept in Zcash's own gold and
 * its own ring structure rather than being
 * recoloured into this project's palette, because restyling somebody
 * else's mark into your own brand is exactly what makes it read as an
 * endorsement. It is hung as a separate "integrates with" plate beside
 * the shop's own emblem, never merged into one badge with it.
 *
 * It is a label, not a claim. Shielded transfers DO NOT WORK in this
 * project and cannot be made to work right now — there is no usable
 * Zcash signing wallet, which `src/server/providers/zcashWallet.ts`
 * documents in detail, and `src/server/providers/oneclick.ts` documents
 * why a priced quote for a shielded address proves nothing. The board
 * that carries this mark therefore also carries the unavailability, from
 * `SHIELDED_NOTICE` in src/townData.ts, on the same sign.
 * ------------------------------------------------------------------ */

/* The emblem palette. Board ink plus the established accents: bone, brass,
 * leather, the teals and the purples already used per NPC. */
const INK: Surface = { color: '#241a12', roughness: 0.9 }
const BONE: Surface = { color: '#e5ddc8', roughness: 0.8 }
const SHADE: Surface = { color: '#b9ae93', roughness: 0.85 }
const BRASS: Surface = { color: '#d5a64b', roughness: 0.35, metalness: 0.55 }
const BRASS_DARK: Surface = { color: '#9a7431', roughness: 0.4, metalness: 0.5 }
const IRON: Surface = { color: '#6a7078', roughness: 0.5, metalness: 0.4 }
const IRON_DARK: Surface = { color: '#3d4349', roughness: 0.55, metalness: 0.35 }
const LEATHER: Surface = { color: '#7a5a38', roughness: 0.88 }
const LEATHER_DARK: Surface = { color: '#4c3722', roughness: 0.9 }
const TEAL: Surface = { color: '#7bc9ce', roughness: 0.4 }
const TEAL_GLOW: Surface = { color: '#7bc9ce', glow: 1.1, roughness: 0.3, noShadow: true }
const PURPLE: Surface = { color: '#9580b8', roughness: 0.5 }
const EMBER: Surface = { color: '#e37c42', glow: 1.3, roughness: 0.35, noShadow: true }
const RED: Surface = { color: '#c2543f', roughness: 0.8 }
const GREEN: Surface = { color: '#7f9a53', roughness: 0.85 }
const GREEN_DARK: Surface = { color: '#4c6b3f', roughness: 0.88 }
const CREAM: Surface = { color: '#f0dcb0', roughness: 0.8 }
const WARM: Surface = { color: '#e8c079', glow: 0.55, roughness: 0.5, noShadow: true }

/** Zcash's own gold. Held apart from the project palette on purpose. */
const ZCASH_GOLD: Surface = { color: '#f4b728', roughness: 0.4, metalness: 0.2 }
const ZCASH_COUNTER: Surface = { color: '#1b1b1b', roughness: 0.9 }
/** The mark's outer rim, and the light ring between rim and disc. */
const ZCASH_RIM: Surface = { color: '#101010', roughness: 0.85 }
const ZCASH_LIGHT: Surface = { color: '#f4f2ec', roughness: 0.7 }

export type Emblem = { rows: string[]; palette: Record<string, Surface | undefined>; width: number }

function emblem(width: number, rows: Array<Array<[number, number, string]>>, palette: Record<string, Surface | undefined>): Emblem {
  return { rows: spans(width, rows), palette, width }
}

/**
 * The Zcash mark: black rim, light ring, gold disc, struck-through Ⓩ.
 *
 * Generated rather than typed. Measured off the official mark at 280px: the
 * gold disc reaches 0.78 of the outer radius, the light ring 0.83, and the rim
 * the edge; the glyph is 97x172px inside a 213px disc, so it is tall and
 * narrow, with a short vertical stroke above the top bar and another below the
 * bottom bar in the way a currency symbol is struck through. Two concentric
 * circles do not survive being hand-typed as spans — one wrong cell in a ring
 * is visible from across the plaza — so the body comes from those radii and
 * only the glyph is authored by hand.
 *
 * 23 cells across, and it needs to be about that: the rim wants two cells to
 * read as a rim, the light ring one, and the Ⓩ nine across to carry two bars,
 * a three-cell diagonal and both strokes. Odd, so the glyph keeps the centre
 * column and the disc stays concentric.
 *
 * One deliberate infidelity: the light ring is 0.087 of the radius where the
 * real mark's is 0.048. At this resolution that ring is one cell or none, and
 * none loses the ring altogether.
 */
function zcashMark(): Emblem {
  const size = 23
  const centre = (size - 1) / 2
  const DISC = 8.5
  const LIGHT = 9.5
  const RIM = 11.5
  const grid: string[][] = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const radius = Math.hypot(x - centre, y - centre)
      return radius <= DISC ? 'Z' : radius <= LIGHT ? 'W' : radius <= RIM ? 'K' : '.'
    }),
  )
  /* The Ⓩ, as [row, from, to] runs so each one can be counted against the
   * mark: the stroke above, two nine-cell bars, a three-cell diagonal stepping
   * one cell a row from the right end of the top bar to the left end of the
   * bottom one, then the stroke below. */
  const glyph: Array<[number, number, number]> = [
    [4, 10, 12], [5, 10, 12],
    [6, 7, 15], [7, 7, 15],
    [8, 13, 15], [9, 12, 14], [10, 11, 13], [11, 10, 12], [12, 9, 11], [13, 8, 10], [14, 7, 9],
    [15, 7, 15], [16, 7, 15],
    [17, 10, 12], [18, 10, 12],
  ]
  for (const [y, from, to] of glyph) {
    for (let x = from; x <= to; x++) grid[y][x] = 'i'
  }
  return {
    rows: grid.map(row => row.join('')),
    palette: { Z: ZCASH_GOLD, i: ZCASH_COUNTER, K: ZCASH_RIM, W: ZCASH_LIGHT },
    width: size,
  }
}

export type EmblemId =
  | 'COMPASS' | 'BOOK' | 'SCALES' | 'MORTAR' | 'HAMMER' | 'LETTER' | 'ORRERY' | 'TANKARD'
  | 'LOAF' | 'HORSESHOE' | 'WHEEL' | 'FISH' | 'BELL' | 'SPOOL' | 'LEAF' | 'CRYSTAL'
  | 'STAR' | 'SEAL' | 'CRATE' | 'ZCASH'

export const emblems: Record<EmblemId, Emblem> = {
  /* MIRA the guide: a compass rose. Four points and a boxed ring, so it still
   * reads as a compass at thirteen pixels where a needle would not. */
  COMPASS: emblem(13, [
    [[6, 6, 'B']],
    [[5, 7, 'B']],
    [[6, 6, 'B']],
    [[1, 11, 'r'], [6, 6, 'B']],
    [[1, 1, 'r'], [5, 7, 'B'], [11, 11, 'r']],
    [[1, 1, 'r'], [4, 8, 'B'], [11, 11, 'r']],
    [[0, 2, 'B'], [3, 9, 'B'], [10, 12, 'B']],
    [[1, 1, 'r'], [4, 8, 'B'], [11, 11, 'r']],
    [[1, 1, 'r'], [5, 7, 'B'], [11, 11, 'r']],
    [[1, 11, 'r'], [6, 6, 'B']],
    [[6, 6, 'B']],
    [[5, 7, 'B']],
    [[6, 6, 'B']],
  ], { B: TEAL, r: BRASS_DARK }),

  /* LYRA the archivist: an open book, two leaves and a spine. */
  BOOK: emblem(13, [
    [],
    [[1, 5, 'S'], [7, 11, 'S']],
    [[0, 5, 'W'], [6, 6, 'K'], [7, 12, 'W']],
    [[0, 5, 'W'], [6, 6, 'K'], [7, 12, 'W']],
    [[0, 0, 'W'], [1, 4, 'l'], [5, 5, 'W'], [6, 6, 'K'], [7, 7, 'W'], [8, 11, 'l'], [12, 12, 'W']],
    [[0, 5, 'W'], [6, 6, 'K'], [7, 12, 'W']],
    [[0, 0, 'W'], [1, 4, 'l'], [5, 5, 'W'], [6, 6, 'K'], [7, 7, 'W'], [8, 11, 'l'], [12, 12, 'W']],
    [[0, 5, 'W'], [6, 6, 'K'], [7, 12, 'W']],
    [[0, 0, 'W'], [1, 4, 'l'], [5, 5, 'W'], [6, 6, 'K'], [7, 7, 'W'], [8, 11, 'l'], [12, 12, 'W']],
    [[0, 5, 'W'], [6, 6, 'K'], [7, 12, 'W']],
    [[1, 5, 'S'], [6, 6, 'K'], [7, 11, 'S']],
    [[2, 10, 'K']],
    [],
  ], { W: BONE, S: SHADE, K: TEAL, l: SHADE }),

  /* VELLUM the merchant: a two-pan balance. */
  SCALES: emblem(13, [
    [[6, 6, 'B']],
    [[5, 7, 'B']],
    [[6, 6, 'B']],
    [[1, 11, 'B']],
    [[1, 1, 'B'], [6, 6, 'B'], [11, 11, 'B']],
    [[1, 1, 'B'], [6, 6, 'B'], [11, 11, 'B']],
    [[0, 3, 'P'], [6, 6, 'B'], [9, 12, 'P']],
    [[1, 2, 'P'], [6, 6, 'B'], [10, 11, 'P']],
    [[6, 6, 'B']],
    [[6, 6, 'B']],
    [[5, 7, 'B']],
    [[3, 9, 'D']],
    [],
  ], { B: BRASS, P: BRASS_DARK, D: LEATHER_DARK }),

  /* SABLE's shop: mortar and pestle with a green draught in it. */
  MORTAR: emblem(13, [
    [[9, 10, 'p']],
    [[8, 9, 'p']],
    [[7, 8, 'p']],
    [[6, 7, 'p']],
    [[5, 6, 'p']],
    [[2, 10, 'G']],
    [[1, 11, 'M']],
    [[1, 11, 'M']],
    [[2, 10, 'M']],
    [[2, 10, 'm']],
    [[3, 9, 'm']],
    [[4, 8, 'D']],
    [],
  ], { M: BONE, m: SHADE, G: TEAL_GLOW, p: LEATHER, D: LEATHER_DARK }),

  /* BRONZE the blacksmith: hammer head over an anvil. */
  HAMMER: emblem(13, [
    [],
    [[2, 9, 'I']],
    [[2, 9, 'I'], [10, 11, 'i']],
    [[2, 9, 'i']],
    [[5, 6, 'H']],
    [[5, 6, 'H']],
    [[5, 6, 'H']],
    [[1, 11, 'A']],
    [[0, 12, 'A']],
    [[3, 9, 'a']],
    [[4, 8, 'a']],
    [[2, 10, 'A']],
    [],
  ], { I: IRON, i: IRON_DARK, H: LEATHER, A: IRON_DARK, a: IRON }),

  /* PIP the courier: a sealed letter. */
  LETTER: emblem(13, [
    [],
    [[0, 12, 'W']],
    [[0, 0, 'W'], [1, 2, 'S'], [3, 9, 'W'], [10, 11, 'S'], [12, 12, 'W']],
    [[0, 0, 'W'], [2, 3, 'S'], [4, 8, 'W'], [9, 10, 'S'], [12, 12, 'W']],
    [[0, 1, 'W'], [3, 4, 'S'], [5, 7, 'W'], [8, 9, 'S'], [11, 12, 'W']],
    [[0, 2, 'W'], [4, 5, 'S'], [6, 6, 'W'], [7, 8, 'S'], [10, 12, 'W']],
    [[0, 12, 'W'], [5, 7, 'R']],
    [[0, 12, 'W'], [4, 8, 'R']],
    [[0, 12, 'W'], [5, 7, 'R']],
    [[0, 12, 'W']],
    [[0, 12, 'S']],
    [],
    [],
  ], { W: CREAM, S: SHADE, R: RED }),

  /* ASTRA the orrery keeper: a ringed world. */
  ORRERY: emblem(13, [
    [],
    [[5, 7, 'C']],
    [[4, 8, 'C']],
    [[3, 9, 'C']],
    [[3, 9, 'C']],
    [[0, 12, 'R']],
    [[0, 1, 'R'], [3, 9, 'C'], [11, 12, 'R']],
    [[0, 12, 'R']],
    [[3, 9, 'c']],
    [[4, 8, 'c']],
    [[5, 7, 'c']],
    [[2, 2, 'S'], [10, 10, 'S']],
    [],
  ], { C: PURPLE, c: { color: '#6a5a8f', roughness: 0.55 }, R: BRASS, S: WARM }),

  /* NELL the innkeeper: a tankard with a head on it. */
  TANKARD: emblem(13, [
    [],
    [[2, 8, 'F']],
    [[1, 9, 'F']],
    [[2, 8, 'M'], [9, 11, 'H']],
    [[2, 8, 'M'], [11, 11, 'H']],
    [[2, 8, 'M'], [11, 11, 'H']],
    [[2, 8, 'M'], [9, 11, 'H']],
    [[2, 8, 'M']],
    [[2, 8, 'M']],
    [[2, 8, 'm']],
    [[1, 9, 'D']],
    [],
    [],
  ], { M: WARM, m: { color: '#c08a3e', roughness: 0.6 }, F: CREAM, H: LEATHER, D: LEATHER_DARK }),

  /* The bakery: a scored loaf. */
  LOAF: emblem(13, [
    [],
    [],
    [[4, 8, 'C']],
    [[2, 10, 'C']],
    [[1, 11, 'C'], [3, 4, 'S'], [6, 7, 'S'], [9, 10, 'S']],
    [[0, 12, 'C'], [3, 4, 'S'], [6, 7, 'S'], [9, 10, 'S']],
    [[0, 12, 'C']],
    [[0, 12, 'B']],
    [[1, 11, 'B']],
    [[2, 10, 'D']],
    [],
    [],
    [],
  ], { C: { color: '#d9a35c', roughness: 0.85 }, B: { color: '#b57e3e', roughness: 0.85 }, S: { color: '#f0dcb0', roughness: 0.8 }, D: LEATHER_DARK }),

  /* The stable: a horseshoe. */
  HORSESHOE: emblem(13, [
    [],
    [[4, 8, 'I']],
    [[2, 10, 'I']],
    [[1, 3, 'I'], [9, 11, 'I']],
    [[1, 2, 'I'], [10, 11, 'I']],
    [[0, 2, 'I'], [10, 12, 'I']],
    [[0, 2, 'I'], [10, 12, 'I']],
    [[0, 2, 'I'], [10, 12, 'I']],
    [[1, 3, 'i'], [9, 11, 'i']],
    [[1, 3, 'i'], [9, 11, 'i']],
    [[2, 4, 'i'], [8, 10, 'i']],
    [],
    [],
  ], { I: IRON, i: IRON_DARK }),

  /* The cartwright: a spoked wheel. */
  WHEEL: emblem(13, [
    [],
    [[4, 8, 'T']],
    [[2, 10, 'T']],
    [[1, 3, 'T'], [6, 6, 'S'], [9, 11, 'T']],
    [[1, 2, 'T'], [5, 7, 'S'], [10, 11, 'T']],
    [[0, 1, 'T'], [3, 9, 'S'], [11, 12, 'T']],
    [[0, 1, 'T'], [2, 10, 'S'], [11, 12, 'T']],
    [[0, 1, 'T'], [3, 9, 'S'], [11, 12, 'T']],
    [[1, 2, 'T'], [5, 7, 'S'], [10, 11, 'T']],
    [[1, 3, 'T'], [6, 6, 'S'], [9, 11, 'T']],
    [[2, 10, 'T']],
    [[4, 8, 'T']],
    [],
  ], { T: LEATHER, S: LEATHER_DARK }),

  /* The fisher shed: a fish. */
  FISH: emblem(13, [
    [],
    [],
    [[9, 11, 'T']],
    [[3, 8, 'F'], [9, 12, 'T']],
    [[1, 10, 'F'], [11, 12, 'T']],
    [[0, 11, 'F'], [2, 2, 'E'], [12, 12, 'T']],
    [[0, 11, 'F'], [11, 12, 'T']],
    [[1, 10, 'f'], [9, 12, 'T']],
    [[3, 8, 'f'], [9, 11, 'T']],
    [],
    [],
    [],
    [],
  ], { F: TEAL, f: { color: '#4f8f96', roughness: 0.5 }, T: { color: '#356e75', roughness: 0.6 }, E: INK }),

  /* The chapel: a bell. */
  BELL: emblem(13, [
    [[5, 7, 'Y']],
    [[5, 7, 'B']],
    [[4, 8, 'B']],
    [[3, 9, 'B']],
    [[2, 10, 'B']],
    [[2, 10, 'B']],
    [[1, 11, 'B']],
    [[1, 11, 'B']],
    [[0, 12, 'B']],
    [[0, 12, 'b']],
    [[4, 8, 'b']],
    [[5, 7, 'b']],
    [],
  ], { B: BRASS, b: BRASS_DARK, Y: LEATHER_DARK }),

  /* The weaver: a spool with thread coming off it. */
  SPOOL: emblem(13, [
    [],
    [[2, 10, 'W']],
    [[2, 10, 'w']],
    [[4, 8, 'T']],
    [[4, 8, 'T']],
    [[4, 8, 't']],
    [[4, 8, 'T']],
    [[4, 8, 'T']],
    [[2, 10, 'W']],
    [[2, 10, 'w']],
    [[0, 1, 'T'], [11, 12, 'T']],
    [],
    [],
  ], { W: BONE, w: SHADE, T: { color: '#e39a6d', roughness: 0.8 }, t: { color: '#c2795180', roughness: 0.8 } }),

  /* The garden house: a leaf. */
  LEAF: emblem(13, [
    [],
    [[7, 9, 'G']],
    [[5, 10, 'G']],
    [[4, 11, 'G'], [7, 7, 'v']],
    [[3, 11, 'G'], [6, 7, 'v']],
    [[2, 11, 'G'], [5, 7, 'v']],
    [[2, 10, 'G'], [4, 6, 'v']],
    [[1, 9, 'g'], [3, 5, 'v']],
    [[1, 7, 'g'], [2, 4, 'v']],
    [[2, 5, 'g']],
    [[1, 2, 'S']],
    [],
    [],
  ], { G: GREEN, g: GREEN_DARK, v: { color: '#cfe0a4', roughness: 0.85 }, S: LEATHER_DARK }),

  /* The conservatory: a cut crystal. */
  CRYSTAL: emblem(13, [
    [],
    [[6, 6, 'L']],
    [[5, 7, 'L']],
    [[4, 8, 'C']],
    [[3, 9, 'C'], [6, 6, 'L']],
    [[3, 9, 'C'], [5, 7, 'L']],
    [[3, 9, 'C'], [6, 6, 'L']],
    [[4, 8, 'c']],
    [[4, 8, 'c']],
    [[5, 7, 'c']],
    [[6, 6, 'c']],
    [],
    [],
  ], { C: TEAL, c: { color: '#4f8f96', roughness: 0.4 }, L: TEAL_GLOW }),

  /* The spell tower and the observatory: a star. */
  STAR: emblem(13, [
    [],
    [[6, 6, 'S']],
    [[6, 6, 'S']],
    [[5, 7, 'S']],
    [[1, 11, 'S']],
    [[3, 9, 'S']],
    [[4, 8, 'L']],
    [[3, 9, 'S']],
    [[2, 4, 'S'], [8, 10, 'S']],
    [[1, 2, 'S'], [10, 11, 'S']],
    [],
    [],
    [],
  ], { S: PURPLE, L: WARM }),

  /* The town hall: a wax seal with a ribbon. */
  SEAL: emblem(13, [
    [],
    [[4, 8, 'R']],
    [[2, 10, 'R']],
    [[1, 11, 'R'], [5, 7, 'B']],
    [[1, 11, 'R'], [4, 8, 'B']],
    [[0, 12, 'R'], [4, 8, 'B']],
    [[1, 11, 'R'], [4, 8, 'B']],
    [[1, 11, 'R'], [5, 7, 'B']],
    [[2, 10, 'r']],
    [[3, 4, 'r'], [8, 9, 'r']],
    [[2, 4, 'P'], [8, 10, 'P']],
    [[2, 3, 'P'], [9, 10, 'P']],
    [],
  ], { R: PURPLE, r: { color: '#6a5a8f', roughness: 0.6 }, B: BRASS, P: RED }),

  /* The market hall: a crate of goods. */
  CRATE: emblem(13, [
    [],
    [[2, 4, 'A']],
    [[2, 5, 'A'], [7, 9, 'G']],
    [[1, 11, 'T']],
    [[1, 11, 'T'], [3, 3, 'S'], [6, 6, 'S'], [9, 9, 'S']],
    [[1, 11, 'T'], [3, 3, 'S'], [6, 6, 'S'], [9, 9, 'S']],
    [[1, 11, 'S']],
    [[1, 11, 'T'], [3, 3, 'S'], [6, 6, 'S'], [9, 9, 'S']],
    [[1, 11, 'T'], [3, 3, 'S'], [6, 6, 'S'], [9, 9, 'S']],
    [[1, 11, 'T']],
    [[2, 10, 'S']],
    [],
    [],
  ], { T: LEATHER, S: LEATHER_DARK, A: RED, G: GREEN }),

  /**
   * The Zcash mark. Third-party trademark, the only emblem here that is not
   * this project's own device, and the only one generated rather than typed —
   * see `zcashMark()` above for the measurements it is built from and for why
   * a bare gold disc was wrong.
   */
  ZCASH: zcashMark(),
}

/**
 * A hanging board's emblem, sized to the board it goes on.
 *
 * The rows are REVERSED on the way out, and that is not a style choice.
 * `Batch.plate()` puts grid column 0 at the plate's local −x and then turns the
 * plate to face the street; a player standing in front of that face is looking
 * back down the plate's own +x, so column 0 lands on their RIGHT and the art
 * arrives back to front. Every emblem here is authored to be read left to
 * right, so the flip belongs at this seam rather than in each caller.
 *
 * It is worth a paragraph because the emblem it matters most for is the Zcash
 * mark: a mirrored Ⓩ reads as an S, which is a mangled trademark rather than a
 * label, and the mangling is invisible to anyone checking the pixel grid.
 */
export function emblemPlate(id: EmblemId, at: [number, number, number], cell: number, options?: { faceYaw?: number; depth?: number; tiltX?: number }): PlatePlan {
  const art = emblems[id]
  return {
    rows: art.rows.map(row => [...row].reverse().join('')),
    palette: art.palette,
    cell,
    depth: options?.depth ?? 1,
    at,
    faceYaw: options?.faceYaw,
    tiltX: options?.tiltX,
  }
}

/** Width and height of an emblem in metres at a given cell size. */
export function emblemSize(id: EmblemId, cell: number) {
  const art = emblems[id]
  return { width: art.width * cell, height: art.rows.length * cell }
}

/**
 * Whether a string names an emblem drawn in this file.
 *
 * src/townData.ts carries its emblem and `integrates` ids as plain strings, so
 * that it stays free of any dependency on how they are drawn. Both the world
 * and the map narrow them through here rather than each keeping its own guess
 * at what is drawable.
 */
export const isEmblemId = (id: string): id is EmblemId => id in emblems

export { INK as EMBLEM_INK, BONE as EMBLEM_BONE, BRASS as EMBLEM_BRASS, EMBER as EMBLEM_EMBER, WARM as EMBLEM_WARM }
