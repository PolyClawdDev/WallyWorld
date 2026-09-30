import * as THREE from 'three'
import { SHIELDED_NOTICE } from './townData'
import type { BuildingSpec } from './townData'
import { emblemPlate, emblemSize } from './emblems'
import { createBatch, disposeMaterial } from './voxelBuild'
import type { Batch, Surface } from './voxelBuild'

/* ------------------------------------------------------------------ *
 * The Zcash house.
 *
 * Sable's premises, built as a struck coin standing on edge in a black
 * stone base. Every other building in town is the same box with a
 * pyramid on it, which is why the shielded desk was impossible to find:
 * the only thing saying what happened there was a sign board two metres
 * across, and you had to already be standing at it to read it.
 *
 * The coin is not a new drawing. It is `emblems.ZCASH` — the same 23x23
 * mark that hangs on Sable's board, measured off the official mark — at
 * a 0.65m cell instead of a 0.096m one, so the thing you see from across
 * the quarter and the thing you read up close are the same art. Nothing
 * here is imported, textured or downloaded; it is 23 by 23 cubes twice.
 *
 * ---- what this building is allowed to say --------------------------
 *
 * A trademark fifteen metres across is a much louder claim than a badge
 * on a sign, and the claim it would make if left alone is false:
 * shielded Zcash transfers DO NOT WORK here and cannot be made to work
 * right now. There is no usable Zcash signing wallet for this project,
 * and a priced quote for a shielded address is not evidence of shielded
 * delivery — `src/server/providers/zcashWallet.ts` and
 * `src/server/providers/oneclick.ts` document both at length.
 *
 * So the unavailability is built into the house rather than left to the
 * board on the back wall. `SHIELDED_NOTICE` is lit across the base's
 * street face, at the height a player reads a door sign, and it is the
 * brightest lettering on the building. The rule that follows from this
 * is short: if the coin is ever made bigger, the notice gets bigger
 * with it. They are one object.
 * ------------------------------------------------------------------ */

/** Zcash's own gold and black, held apart from the town palette. */
const GOLD: Surface = { color: '#f4b728', roughness: 0.4, metalness: 0.2 }
const GOLD_DEEP: Surface = { color: '#b8851a', roughness: 0.45, metalness: 0.3 }
const GOLD_LIT: Surface = { color: '#f4b728', glow: 1.9, roughness: 0.3, noShadow: true }
/** The base: struck-metal dark, a shade off the mark's own rim black. */
const STONE: Surface = { color: '#26262c', roughness: 0.9 }
const STONE_DEEP: Surface = { color: '#191a1f', roughness: 0.92 }
const STONE_SEAM: Surface = { color: '#32333b', roughness: 0.88 }
const INK: Surface = { color: '#121216', roughness: 0.9 }
const WARM_GLASS: Surface = { color: '#f6d98a', glow: 1.5, roughness: 0.3, noShadow: true }

/** Cell size of the coin, in metres. 23 cells across at 0.65 is 14.95m. */
const COIN_CELL = 0.65
/**
 * Cube depth of each struck face, in cells. Two faces make the coin 2.6m thick.
 *
 * Three cells a face was tried first and read as a tyre from the plaza: at
 * 3.9m against a 15m diameter the disc is thicker than a sixth of its width,
 * and the eye stops calling that a coin. Two is still a metre and a half of
 * solid gold per face, which is plenty to catch the light on the rim.
 */
const FACE_CELLS = 2
/**
 * Top of the stone base, and the bottom of the coin.
 *
 * Eight metres because `premisesBoard` in src/npcs.ts stands its board on
 * BOARD_FOOT = 3.2m and Sable's is 4.27m tall, so the board finishes just
 * under 7.5m. Below eight the coin grows down through the sign that explains
 * it, which is the one collision this building cannot have.
 */
const BASE_TOP = 8

/**
 * A lit panel of words, as a canvas on an unlit plane.
 *
 * Same trick as the building labels and Sable's status strip: prose in voxels
 * needs a glyph set this project does not have, and at a legible size it would
 * swamp the mark. The caller owns the mesh and must dispose it — the texture
 * goes with the material, which is the half that gets forgotten.
 */
function plaque(lines: string[], width: number, height: number, accent: string, lead = 1) {
  const px = Math.max(256, Math.min(1400, Math.round(width * 150)))
  const py = Math.max(64, Math.round((px * height) / width))
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = py
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0d0d11f2'
  ctx.fillRect(0, 0, px, py)
  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(2, py * 0.035)
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, px - ctx.lineWidth * 2, py - ctx.lineWidth * 2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const rows = lines.length
  for (let i = 0; i < rows; i++) {
    const lead_ = i < lead
    const size = Math.round((py / (rows + 0.9)) * (lead_ ? 0.82 : 0.62))
    ctx.font = `700 ${size}px monospace`
    ctx.fillStyle = lead_ ? accent : '#f1ead8'
    ctx.fillText(lines[i], px / 2, (py * (i + 0.85)) / (rows + 0.7))
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  )
  mesh.name = 'zcash-plaque'
  return mesh
}

/**
 * The milled edge of the coin, all the way round.
 *
 * Both tones are gold, and that is the point: the mark's outer ring is black,
 * so a black edge made the disc read as a wheel with a gold face rather than as
 * a struck coin. The edge of a coin is the same metal as the rest of it, and
 * alternating two golds is what makes the milling visible at a distance.
 */
function reeding(batch: Batch, x: number, y: number, z: number, radius: number, thickness: number) {
  const teeth = 48
  for (let i = 0; i < teeth; i++) {
    const angle = (i / teeth) * Math.PI * 2
    batch.box(
      [(Math.PI * 2 * radius) / teeth, 0.62, thickness],
      [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, z],
      i % 2 === 0 ? GOLD : GOLD_DEEP,
      { rotZ: angle + Math.PI / 2 },
    )
  }
}

/**
 * Sable's premises as the Zcash house.
 *
 * Footprint is the spec's, untouched: `width` and `depth` are what the
 * navigation grid and the server's copy of the town in src/shared/zones.ts
 * build their obstacles from. The coin overhangs that footprint by a metre and
 * a half either side, which costs nothing — its lowest cell is eight metres up,
 * four times a player's height, so nothing can walk into it.
 */
export function createZcashHouse(spec: BuildingSpec) {
  const group = new THREE.Group()
  group.name = `zcash-house-${spec.name}`
  const batch = createBatch()
  const { x, z, width, depth } = spec
  const front = z - depth / 2
  const texts: THREE.Mesh[] = []

  /* --- the base ------------------------------------------------------ */
  batch.box([width + 0.7, 0.6, depth + 0.7], [x, 0.3, z], STONE_DEEP)
  batch.box([width, BASE_TOP - 0.6, depth], [x, (BASE_TOP + 0.6) / 2, z], STONE)
  // Courses, so eight metres of dark wall has a scale to it rather than being
  // one flat slab with a door in it.
  for (const level of [2.6, 5.2]) {
    batch.box([width + 0.24, 0.22, depth + 0.24], [x, level, z], STONE_SEAM)
  }
  // Corner pilasters, and the cornice the coin sits on.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.box([0.8, BASE_TOP - 0.6, 0.8], [x + sx * (width / 2 - 0.4), (BASE_TOP + 0.6) / 2, z + sz * (depth / 2 - 0.4)], STONE_DEEP)
    }
  }
  batch.box([width + 1, 0.5, depth + 1], [x, BASE_TOP - 0.25, z], GOLD_DEEP)
  batch.box([width + 0.6, 0.26, depth + 0.6], [x, BASE_TOP + 0.1, z], INK)

  /* --- the door, on the street face ---------------------------------- */
  const doorWidth = 2.6
  batch.box([doorWidth + 0.7, 3.5, 0.34], [x, 1.75, front - 0.1], GOLD_DEEP)
  batch.box([doorWidth, 3.1, 0.3], [x, 1.55, front - 0.22], INK)
  batch.box([doorWidth - 0.5, 2.7, 0.18], [x, 1.35, front - 0.3], STONE_DEEP)
  for (const side of [-1, 1]) {
    // Lamps either side, the only warm light on a black building.
    batch.box([0.44, 0.44, 0.44], [x + side * (doorWidth / 2 + 0.9), 3.1, front - 0.35], GOLD_LIT)
    batch.box([0.2, 0.7, 0.2], [x + side * (doorWidth / 2 + 0.9), 3.6, front - 0.35], GOLD_DEEP)
  }

  /* --- window slits, a vault rather than a cottage -------------------- */
  for (const level of [3.9, 6.4]) {
    for (const offset of [-3.6, -1.2, 1.2, 3.6]) {
      batch.box([0.75, 1.1, 0.2], [x + offset, level, front - 0.08], WARM_GLASS)
      batch.box([1.05, 1.4, 0.14], [x + offset, level, front - 0.02], GOLD_DEEP)
    }
    for (const side of [-1, 1]) {
      for (const along of [-2.2, 0.6]) {
        batch.box([0.2, 1.1, 0.75], [x + side * (width / 2 - 0.08), level, z + along], WARM_GLASS)
        batch.box([0.14, 1.4, 1.05], [x + side * (width / 2 - 0.02), level, z + along], GOLD_DEEP)
      }
    }
  }

  /* --- the coin ------------------------------------------------------ *
   * Two struck faces rather than one slab. `emblemPlate` reverses its rows so
   * the art reads correctly for somebody in front of it; turning the back face
   * through 180 degrees means it reads correctly from behind as well. A single
   * plate would have left the reverse mirrored, and a mirrored Ⓩ is an S —
   * a mangled trademark facing the whole north side of the quarter.
   * ------------------------------------------------------------------- */
  const { width: coinSpan } = emblemSize('ZCASH', COIN_CELL)
  const coinY = BASE_TOP + coinSpan / 2
  const faceDepth = FACE_CELLS * COIN_CELL
  batch.plate(emblemPlate('ZCASH', [x, coinY, z - faceDepth / 2], COIN_CELL, { depth: FACE_CELLS, faceYaw: 0 }))
  batch.plate(emblemPlate('ZCASH', [x, coinY, z + faceDepth / 2], COIN_CELL, { depth: FACE_CELLS, faceYaw: Math.PI }))
  // Proud of the rim, not flush with it. Set inside the mark's own outer ring
  // the milling was hidden behind black cells and the coin read as a wheel.
  reeding(batch, x, coinY, z, coinSpan / 2 + 0.05, faceDepth * 2 + 0.12)
  // Two chocks under the rim. A disc this size balanced on one cell of its own
  // edge reads as a mistake; a coin set into a mount reads as deliberate.
  for (const side of [-1, 1]) {
    batch.box([1.5, 1.3, faceDepth * 2 + 1], [x + side * 2.4, BASE_TOP + 0.4, z], GOLD_DEEP, { rotZ: side * 0.5 })
  }
  // Uplights along the cornice, aimed at the coin.
  for (const offset of [-4.4, -1.5, 1.5, 4.4]) {
    batch.box([0.5, 0.3, 0.5], [x + offset, BASE_TOP + 0.35, front + 0.4], GOLD_LIT)
  }

  /* --- what the house is required to say ----------------------------- *
   * The notice, on the street face, under the coin. See the header: the mark
   * and the unavailability are one object, and this is the half of it that
   * players standing at the door will read.
   * ------------------------------------------------------------------- */
  const notice = plaque(
    [SHIELDED_NOTICE.headline, ...SHIELDED_NOTICE.boardLines],
    width - 1.4,
    2.0,
    '#f4b728',
  )
  notice.position.set(x, 6.4, front - 0.5)
  notice.rotation.y = Math.PI
  texts.push(notice)
  batch.box([width - 1.1, 2.3, 0.3], [x, 6.4, front - 0.3], INK)
  batch.box([width - 0.8, 2.6, 0.18], [x, 6.4, front - 0.18], GOLD_DEEP)

  // The trade still worked here, over its own door.
  const trade = plaque([spec.sign], 4.4, 0.9, spec.accent ?? '#7bc9ce', 0)
  trade.position.set(x, 4.05, front - 0.42)
  trade.rotation.y = Math.PI
  texts.push(trade)
  batch.box([4.7, 1.15, 0.24], [x, 4.05, front - 0.28], INK)

  const built = batch.build(group)
  for (const mesh of texts) group.add(mesh)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    built.dispose()
    for (const mesh of texts) {
      mesh.geometry.dispose()
      disposeMaterial(mesh.material as THREE.Material)
    }
  }
  group.userData.dispose = dispose
  group.userData.boxes = built.boxes
  group.userData.triangles = built.triangles
  // Same teardown signal the emblems use: removal from the graph. The case that
  // actually leaks is the world remounting on a wardrobe change and building a
  // second town over the first one's buffers.
  group.addEventListener('removed', dispose)
  return group
}
