/* ------------------------------------------------------------------ *
 * The VOXELS wordmark, authored as a pixel bitmap and extruded.
 *
 * Drawn here rather than set in a pixel webfont for two reasons. The game
 * builds all of its own art the same way — authored pixel sprites extruded
 * into cubes — so the title is made of the same material as the world it
 * opens. And a wordmark that depends on a font download is a wordmark that
 * renders as fallback Manrope for the first second, or forever if the font
 * host is blocked.
 *
 * Each lit cell becomes a square block, with a second copy offset behind it
 * in a darker tone so the letters read as solid voxels catching light from
 * the upper left rather than as flat pixels.
 * ------------------------------------------------------------------ */

/**
 * Five wide and seven tall, the smallest grid where these six letters stay
 * legible: `S` needs the middle row for its spine and `X` needs an odd width
 * so the crossing lands on a single cell instead of smearing across two.
 */
const GLYPHS: Record<string, readonly string[]> = {
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  X: ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
}

const GLYPH_HEIGHT = 7

/** Cells of empty space between letters. One reads as kerning; two as a word gap. */
const TRACKING = 1

type Cell = { x: number; y: number; letter: number }

/**
 * Lays the word out on one grid so the blocks are siblings rather than nested
 * per letter. Each cell remembers which letter it came from, so the accent
 * colour can fall on whole letters instead of a count of trailing blocks.
 */
function layout(word: string): { cells: Cell[]; width: number } {
  const cells: Cell[] = []
  let cursor = 0
  for (let letter = 0; letter < word.length; letter += 1) {
    const glyph = GLYPHS[word[letter]]
    // An unmapped character advances the cursor instead of throwing: a missing
    // letter should cost a gap in the title, not the whole landing page.
    if (!glyph) {
      cursor += 5 + TRACKING
      continue
    }
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        if (row[x] === 'X') cells.push({ x: cursor + x, y, letter })
      }
    })
    cursor += glyph[0].length + TRACKING
  }
  return { cells, width: Math.max(0, cursor - TRACKING) }
}

/**
 * How many trailing letters take the brass accent, so the mark is not one flat
 * slab. Whole letters, so the colour change never lands mid-stroke.
 */
const ACCENT_LETTERS = 2

export function PixelWordmark({ word = 'VOXELS' }: { word?: string }) {
  const { cells, width } = layout(word)
  const accentFrom = word.length - ACCENT_LETTERS
  // The grid is sized in cells and the cell size comes from CSS, so the
  // wordmark scales with the viewport without any of the blocks going
  // fractional and picking up a seam.
  const style = { '--vx-cols': width, '--vx-rows': GLYPH_HEIGHT } as React.CSSProperties
  return (
    <h1 className="pixel-wordmark" style={style}>
      {/* The readable name for screen readers and page titles; the blocks are decorative. */}
      <span className="pixel-wordmark-label">{word.charAt(0) + word.slice(1).toLowerCase()}</span>
      <span className="pixel-wordmark-grid" aria-hidden="true">
        {cells.map(cell => (
          <i
            key={`${cell.x}-${cell.y}`}
            className={cell.letter >= accentFrom ? 'vx-accent' : undefined}
            style={{ gridColumn: cell.x + 1, gridRow: cell.y + 1 }}
          />
        ))}
      </span>
    </h1>
  )
}
