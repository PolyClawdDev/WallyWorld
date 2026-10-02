import * as THREE from 'three'
import type { BuildingSpec } from './townData'
import { createBatch, disposeMaterial } from './voxelBuild'
import type { Batch, PlatePlan, Surface } from './voxelBuild'

/* ------------------------------------------------------------------ *
 * The Fomo House.
 *
 * A second landmark, on the north-west shoulder of the old town, with
 * the owner's voxel eyes hanging in the air above it.
 *
 * ---- the rule that governs this building ---------------------------
 *
 * NOTHING IN THIS HOUSE WORKS, AND THE HOUSE HAS TO SAY SO ITSELF.
 *
 * The precedent is src/zcashHouse.ts, whose header states the general
 * form: a claim fifteen metres across is much louder than a badge on a
 * sign, so the unavailability cannot be left to a board round the back.
 * It is built into the building. `FOMO_NOTICE` below is lit across the
 * base's street face at the height a player reads a door sign, it is
 * the widest and the brightest panel on the wall, and the door behind
 * it is boarded over rather than merely shut. If the eyes are ever made
 * bigger or brighter, the notice gets bigger and brighter with them.
 * They are one object.
 *
 * The facts the notice is holding down, none of which this file is in a
 * position to change:
 *
 *   - There is NO partnership, affiliation, endorsement or agreement
 *     with Fomo or with anyone else. Putting up a building does not
 *     create one, and nothing on or in this house may imply that it did.
 *   - There is NO data integration and none is being built. No feed, no
 *     socket, no prices, no leaderboard, no trader profiles, no
 *     holdings. There is no provider adapter, no environment variable
 *     and no fetch call anywhere behind this building, and the one
 *     third-party API that describes this data calls ITSELF independent
 *     and unofficial — authenticated requests to it have never been
 *     tested here and its authorisation to redistribute is unverified.
 *   - NO TRADE can be placed from inside this game, ever. There is no
 *     transaction signer in the client at all: the browser-held key
 *     signs messages and nothing else, `PAYOUTS_ENABLED` and
 *     `PAYMENTS_ENABLED` are `false as const`, and a data API is not an
 *     execution venue in any case.
 *   - There is no referral or affiliate link in this build. Acceptance
 *     into any such programme has not happened.
 *
 * And one thing the notice deliberately does NOT say. It carries no
 * date, no "soon" and no certainty that the house opens at all.
 * src/server/npc/catalogue.ts forbids exactly that phrasing — "coming
 * soon" is "a promise nobody here is in a position to make" — so the
 * wording says what the place would be FOR in the subjunctive, and then
 * says plainly that none of it exists.
 *
 * ---- what artwork is used, and what is not -------------------------
 *
 * The eyes are the OWNER'S OWN voxel artwork, reproduced from their
 * reference render as a pixel grid in code. Nothing else is borrowed:
 * no logo, no wordmark, no brand colour used as a trademark, and
 * nothing downloaded, imported or textured. There is not an image file
 * in this project and this building does not add the first one. The
 * palette is sampled off the owner's own render — a near-white body
 * with a cool lavender in shade, against the render's own near-black,
 * which is why the base is the colour it is.
 *
 * The word FOMO on a twenty-two metre building is a trademark question,
 * and it is the owner's to settle before this is promoted anywhere.
 * This file is not the place that decides it.
 *
 * ---- why the eyes are a second batch -------------------------------
 *
 * The eyes MOVE and the base does not, so the two cannot share a mesh.
 * Everything static — base, boarded door, dead lamps, blank windows,
 * cornice uplights, notice and sign — welds into one batch. The eyes
 * get a batch of their own, welded into a `THREE.Group` standing at the
 * eyes' own centre and built at that group's ORIGIN, so its local axes
 * are the eyes' axes. Built at town coordinates instead, the group's
 * origin would be the town's, and bobbing or swaying it would walk a
 * thirteen-metre pair of eyes round the quarter rather than float them
 * where they stand. That is the Zcash coin's lesson, copied verbatim.
 *
 * The teardown changes with it: `dispose()` has two welded bodies to
 * free and freeing one of them is a leak rather than a fix.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The teaser.
 *
 * Held as data beside the only thing that reads it. `SHIELDED_NOTICE`
 * lives in src/townData.ts because a board in the world and a panel in
 * the UI both have to say the same words; this notice has exactly one
 * consumer, because there is deliberately no NPC, no service, no
 * catalogue entry and no Journal desk for this house. Moving it to the
 * town plan would advertise a second reader that does not exist.
 *
 * Every clause below is either an existing fact about this repository or
 * a subjunctive. There is no indicative future tense anywhere in it.
 * ------------------------------------------------------------------ */
export const FOMO_NOTICE = {
  headline: 'FOMO HOUSE · NOTHING HERE WORKS',
  /** Two lines, for the lit panel over the boarded door. */
  boardLines: ['NO DOOR, NO DESK, NO DATA', 'NOT OPEN — AND NOT PROMISED'],
  lines: [
    'A shell with a sign on it, built before anything to put inside.',
    'Were it ever finished it would be a room for talking about trades:',
    'a wall of calls, tables to sit at, someone to ask what changed.',
    'None of that is built, and none of it is promised to be.',
    'There is no price feed, no leaderboard and no trader list here,',
    'and no trade can be placed from this game by anyone, ever — the',
    'key in your browser signs messages, never transactions.',
    'Voxels is not affiliated with, endorsed by, or connected to any',
    'trading service. The eyes overhead are the owner\'s own artwork.',
  ],
} as const

/* ------------------------------------------------------------------ *
 * The palette, sampled off the owner's reference render rather than
 * guessed: #e5e7fe on the lit faces, #aeadce where the extrusion turns
 * away, #5a587d in the recesses, #0c0a1f behind it all.
 *
 * The base takes the render's own backdrop so the eyes hang against the
 * colour they were drawn against. Held apart from the town palette on
 * purpose, the way zcashHouse.ts holds Zcash's gold apart: this is not
 * a restyling of somebody else's device into this project's colours.
 * ------------------------------------------------------------------ */
/**
 * The eyes' lit body.
 *
 * Emissive at 0.5 and not zero, which is a decision about this world's
 * lighting rather than about the art. The moon is a directional light at
 * (-20, 30, 10), so it rakes the −x, +y and +z faces and leaves every −z face
 * — the whole street side of everything in town — on the hemisphere light
 * alone. Unlit, the eyes read mid-grey from the one direction the house is
 * approached from. At 0.5 the faces hold the owner's near-white from any angle
 * and the moon still differentiates them, which is what the reference's
 * white-to-lavender falloff actually is.
 *
 * `noShadow` is deliberately NOT set. The eyes casting a moving shadow across
 * the cornice and the forecourt is the single strongest thing selling them as
 * airborne rather than mounted, and it costs one shadow-pass draw.
 */
const EYE_LIT: Surface = { color: '#e5e7fe', glow: 0.5, roughness: 0.55 }
/** The reverse of the eyes, in the render's own shade. See `strikeEyes`. */
const EYE_SHADE: Surface = { color: '#8f8eb8', roughness: 0.62 }
const STONE: Surface = { color: '#17152e', roughness: 0.9 }
const STONE_DEEP: Surface = { color: '#0c0a1f', roughness: 0.92 }
const STONE_SEAM: Surface = { color: '#221f3c', roughness: 0.88 }
const INK: Surface = { color: '#080712', roughness: 0.9 }
const LAVENDER: Surface = { color: '#6f6d95', roughness: 0.6, metalness: 0.15 }
/** The cornice uplights, and the only glow on the base other than the notice. */
const LAVENDER_LIT: Surface = { color: '#cfcdf2', glow: 1.6, roughness: 0.3, noShadow: true }

/** The notice's accent. Matches `spec.accent` in the town plan. */
const ACCENT = '#cfcdf2'

/**
 * Cell size of the eyes, in metres. 30 cells across at 0.44 is 13.2m.
 *
 * Sized against the Zcash coin rather than against the sky. That coin is 15m
 * across and spans 8m to 23m up, and it was the first landmark; a second one
 * that out-measured it would restate the quarter's skyline for the sake of a
 * building that does nothing. At 0.44 the eyes are 13.2m across and 9.24m
 * tall and top out at 22.2m, so they are narrower and no taller than the coin
 * from every angle, and still 13m of artwork — wider than the house under them.
 */
const EYE_CELL = 0.44

/**
 * Cube depth of the eyes, in cells: three for the struck body, one for the
 * reverse, so the slab is four cells and 1.76m thick.
 *
 * Measured off the reference at one of its stepped right edges, where a side
 * face spans about 40px of screen against a 26.8px cell, and the one-cell step
 * beside it spans 22px. A step riser is perpendicular to the side face, so
 * 22 = 26.8·cos θ puts the view about 35° off-axis, and 40 = depth·sin 35°
 * puts the real depth at about two and a half cells. Rounded up to four, which
 * is the smallest depth that leaves the reverse a whole cell of its own, and
 * costs nothing: a plate of depth n is one cube per cell whatever n is. One
 * cell was tried and at 13m of width it reads as a decal the moment the sway
 * turns it; six reads as a block with a picture on the end of it.
 */
const BODY_CELLS = 3
const REVERSE_CELLS = 1

/** Top of the base, and the floor the eyes hang over. */
const BASE_TOP = 9
/**
 * Clear air between the top of the base and the lowest cell of the eyes.
 *
 * Four metres, which is a bit over twice a player's height, because the entire
 * read of this building is that the eyes are NOT attached to it. Two metres
 * looked like a parapet ornament sitting on the cornice. Six put the eyes into
 * the sky on their own and lost the house, and it pushed the top of them past
 * the Zcash coin. Nothing bridges the gap: no mast, no bracket, no post. The
 * only things crossing it are the uplights' glow and the eyes' own shadow.
 */
const FLOAT_GAP = 4

/**
 * How the eyes move: a slow bob, and a slow sway about their own vertical axis.
 *
 * Not a revolution. The Zcash coin turns because a struck coin spun on edge is
 * a thing coins do and both faces are meant to come round; a pair of eyes put
 * through a full turn goes edge-on twice a revolution and spends half of it
 * facing away, which reads as signage rather than as something watching the
 * street. So the yaw is bounded well short of edge-on and the artwork stays
 * legible from the forecourt at all times.
 *
 * The two periods are deliberately not multiples of each other — 8.5s and
 * 15.5s — so the pair never settles into a visible loop. 14 degrees of sway is
 * enough to show the slab's thickness and the stepped edges, which is what
 * tells a player it is a solid object rather than a billboard, and not enough
 * to turn the eyes away from anyone standing in front of them.
 *
 * Both are driven by `dt` in seconds and never by a frame count. Every time
 * something in this project has been advanced per frame the speed has turned
 * out to be a reading of the player's hardware.
 */
const BOB_SECONDS = 8.5
const SWAY_SECONDS = 15.5
const BOB_RISE = 0.5
const SWAY_LIMIT = (14 * Math.PI) / 180
const TAU = Math.PI * 2
const BOB_RATE = TAU / BOB_SECONDS
const SWAY_RATE = TAU / SWAY_SECONDS

/* ------------------------------------------------------------------ *
 * The eyes, as a pixel grid.
 *
 * Generated from measured geometry rather than hand-typed, for the same reason
 * `zcashMark()` in src/emblems.ts is: one wrong cell in an arc is visible from
 * across the quarter and invisible in the source. The measurements come off the
 * owner's reference render, read back as a silhouette mask at the render's own
 * cell pitch — about 26.8 screen pixels in an 886 x 583 body, so 30 cells wide
 * by 21 tall, which is also the smallest grid the form survives at: the crescent
 * needs six cells of belly to read as a stroke and nine of mouth to read as an
 * opening.
 *
 * The form itself is ONE crescent, struck twice. Each crescent is a superellipse
 * with a second superellipse bitten out of it, offset left and half a cell up:
 *
 *   outer   8.0 x 10.5 cells, exponent 2.2 — squarer than an ellipse, which is
 *           what the reference's flat eight-cell top and long straight right
 *           edge actually are. A true ellipse came to a five-cell point there.
 *   bite    5.0 x 4.0 cells, exponent 2.8, centre four cells to the left of the
 *           outer centre and half a cell above it. Left far enough that the
 *           mouth opens out through the outer edge instead of being a hole, and
 *           up by half a cell because in the reference the lower horn reaches
 *           about two cells further out than the upper one.
 *   repeat  the second crescent sits 14.5 cells to the right of the first. The
 *           two merge into one body across the top and bottom and leave a notch
 *           between them at either end, and the right crescent's mouth is closed
 *           on its left by the left crescent's belly — which is the enclosed
 *           dark square in the middle of the owner's render.
 *
 * Fitted against the reference mask this reproduces 92% of its cells. The
 * residual is the render's own perspective: its back face is offset up and to
 * the right, so the reference's top edge sits about a cell right of the art's.
 * ------------------------------------------------------------------ */
const EYES_WIDE = 30
const EYES_TALL = 21
const CRESCENT = { a: 8, b: 10.5, outerPower: 2.2, biteLeft: 4, biteUp: 0.5, ai: 5, bi: 4, bitePower: 2.8 }
/** Centre of the left crescent, and how far right the second one stands. */
const FIRST_CENTRE = 7
const CRESCENT_PITCH = 14.5

const inside = (dx: number, dy: number, ax: number, by: number, power: number) =>
  Math.abs(dx / ax) ** power + Math.abs(dy / by) ** power <= 1

function eyesRows(): string[] {
  const cy = (EYES_TALL - 1) / 2
  const { a, b, outerPower, biteLeft, biteUp, ai, bi, bitePower } = CRESCENT
  const centres = [FIRST_CENTRE, FIRST_CENTRE + CRESCENT_PITCH]
  return Array.from({ length: EYES_TALL }, (_, y) =>
    Array.from({ length: EYES_WIDE }, (_, x) =>
      centres.some(
        cx =>
          inside(x - cx, y - cy, a, b, outerPower) &&
          !inside(x - (cx - biteLeft), y - (cy - biteUp), ai, bi, bitePower),
      )
        ? '#'
        : '.',
    ).join(''),
  )
}

/**
 * One struck face of the eyes.
 *
 * The rows are REVERSED on the way out, and it is not a style choice.
 * `Batch.plate()` puts grid column 0 at the plate's local −x; a player standing
 * on the −z side of a `faceYaw: 0` plate is looking along +z, where screen-right
 * is world −x, so column 0 lands on their right and unreversed art arrives back
 * to front. src/emblems.ts carries the same flip at the same seam for the same
 * reason, and it cannot be reused here: this grid is not an emblem and that file
 * is not this building's to edit.
 *
 * This matters more here than it does for a trade badge. The pair is ASYMMETRIC
 * — both crescents open to the left — so a mirrored strike is not a flipped
 * detail, it is eyes looking the other way, and it is invisible to anyone
 * checking the grid. The only proof is a screenshot pair at θ and θ+180.
 *
 * `face: 'reverse'` is the SAME cells, not their mirror. `faceYaw: Math.PI`
 * already inverts the plate's own x mapping, so passing the rows through
 * unreversed lands every cell on the world column the street face put it in,
 * and the slab stays one solid shape. Reversing them there instead would weld
 * the silhouette to its own mirror image, and the union of this shape with its
 * mirror fills both mouths and stops being a pair of eyes at all — which is why
 * the Zcash coin's two-struck-faces trick does not transfer here. That coin's
 * asymmetry is interior COLOUR on a symmetric disc; this one's asymmetry is the
 * outline itself, and an outline cannot read the same way from both sides of a
 * solid body.
 */
function strikeEyes(rows: string[], at: [number, number, number], depth: number, face: 'street' | 'reverse', surface: Surface): PlatePlan {
  return {
    rows: face === 'street' ? rows.map(row => [...row].reverse().join('')) : rows,
    palette: { '#': surface },
    cell: EYE_CELL,
    depth,
    at,
    faceYaw: face === 'street' ? 0 : Math.PI,
  }
}

/**
 * A lit panel of words, as a canvas on an unlit plane.
 *
 * The same trick, and the same caveat, as the Zcash house's `plaque`: prose in
 * voxels needs a glyph set this project does not have, and at a legible size it
 * would swamp the art. Written out here rather than shared because the two
 * buildings tune it differently — this one has to be legible at a door rather
 * than from a plaza, so it takes more pixels per metre and leads with its
 * headline at a larger size. The caller owns the mesh and must dispose it; the
 * texture goes with the material, which is the half that gets forgotten.
 */
function plaque(lines: string[], width: number, height: number, accent: string, lead = 1) {
  const px = Math.max(256, Math.min(1600, Math.round(width * 190)))
  const py = Math.max(64, Math.round((px * height) / width))
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = py
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#07060ff5'
  ctx.fillRect(0, 0, px, py)
  ctx.strokeStyle = accent
  ctx.lineWidth = Math.max(2, py * 0.04)
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, px - ctx.lineWidth * 2, py - ctx.lineWidth * 2)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const rows = lines.length
  for (let i = 0; i < rows; i++) {
    const heading = i < lead
    const size = Math.round((py / (rows + 0.8)) * (heading ? 0.86 : 0.66))
    ctx.font = `700 ${size}px monospace`
    ctx.fillStyle = heading ? accent : '#eceaff'
    ctx.fillText(lines[i], px / 2, (py * (i + 0.8)) / (rows + 0.6))
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  )
  mesh.name = 'fomo-plaque'
  return mesh
}

/**
 * A window opening with nothing behind it.
 *
 * Every other building in town puts warm glass in its windows, because every
 * other building is occupied. These are the same openings with the light left
 * out: a dark recess in a lavender frame. It is the cheapest honest sentence
 * this house can say from a distance too far to read the notice — a building
 * with its lights off is a building nobody is in.
 */
function blankWindow(batch: Batch, size: [number, number, number], at: [number, number, number], frame: [number, number, number]) {
  batch.box(size, at, INK)
  batch.box(frame, [at[0], at[1], at[2] + 0.06], LAVENDER)
}

/**
 * The Fomo House, and the eyes over it.
 *
 * ---- where it stands, and why --------------------------------------
 *
 * x −32, z 33, 12m by 9m, which is the only plot in the town that is clear of
 * every one of the things that had a claim on the ground. Searched rather than
 * chosen: footprints plus skirts, the four paved streets, the plaza, the canal
 * banks, both NPC lists, the perimeter tree ring, the four duel rings and their
 * run-ups, the seven hunting regions' signed-distance fields, and the twenty
 * metre view corridors the landmarks already own.
 *
 * What the site gets right:
 *
 *   - Its door is on the −z face, like every door in town, and the twenty metre
 *     approach in front of it runs over open ground down to the north edge of
 *     the main east–west street, two metres short of the paving. Standing on
 *     that street at x=−32 and looking north, the house is dead ahead with
 *     nothing in between. That is the "down the street" read, and it is the
 *     only clean one left: the other free plots are all 70m or more out, in the
 *     corners of the world.
 *   - It is 45m from the plaza — the nearest clear plot there is — in OLD TOWN,
 *     on the shoulder between the plaza and the Star Quarter.
 *   - Its approach corridor does not touch a hunting region at all. The Zcash
 *     house's own corridor is 22% inside the East Common, so this is better
 *     than the precedent rather than a concession to it. Nothing is taken off
 *     anybody's hunt, which is why the canopy and sightline numbers do not move.
 *   - It is 95m from the Zcash coin, in a different quarter. The two landmarks
 *     hold opposite shoulders of the town and are never in frame together, so
 *     neither has to be shrunk to avoid dwarfing the other.
 *   - Nearest neighbour is the Hearth Inn, 3m clear in x and 8m in z — corner
 *     to corner, not wall to wall — and the two paved streets that box the plot
 *     in are 4m and 5m off the skirt.
 *
 * ---- what the footprint means --------------------------------------
 *
 * `width` and `depth` are the spec's, untouched: `createNavGrid` builds its
 * obstacles from them and `townBuildings` in src/shared/zones.ts repeats them
 * for the server. The eyes overhang that footprint by 0.6m either side, which
 * costs nothing — their lowest cell is thirteen metres up.
 */
export function createFomoHouse(spec: BuildingSpec) {
  const group = new THREE.Group()
  group.name = `fomo-house-${spec.name}`
  const batch = createBatch()
  const { x, z, width, depth } = spec
  const front = z - depth / 2
  const texts: THREE.Mesh[] = []

  /* --- the base ------------------------------------------------------ */
  batch.box([width + 0.7, 0.6, depth + 0.7], [x, 0.3, z], STONE_DEEP)
  batch.box([width, BASE_TOP - 0.6, depth], [x, (BASE_TOP + 0.6) / 2, z], STONE)
  // Courses, so nine metres of near-black wall has a scale to it rather than
  // being one flat slab with a notice on it.
  for (const level of [2.9, 5.8]) {
    batch.box([width + 0.24, 0.22, depth + 0.24], [x, level, z], STONE_SEAM)
  }
  // Corner pilasters, and the cornice the eyes hang over.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.box([0.8, BASE_TOP - 0.6, 0.8], [x + sx * (width / 2 - 0.4), (BASE_TOP + 0.6) / 2, z + sz * (depth / 2 - 0.4)], STONE_DEEP)
    }
  }
  batch.box([width + 1, 0.5, depth + 1], [x, BASE_TOP - 0.25, z], LAVENDER)
  batch.box([width + 0.6, 0.26, depth + 0.6], [x, BASE_TOP + 0.1, z], INK)

  /* --- the door, boarded over --------------------------------------- *
   * Not a shut door: a door-shaped opening with a board across it and two
   * battens over the board. A shut door is a building that is closed today and
   * open tomorrow, which is the promise this house is not allowed to make. A
   * boarded one is a building that was never fitted out, which is what it is.
   * ------------------------------------------------------------------- */
  const doorWidth = 2.6
  batch.box([doorWidth + 0.7, 3.5, 0.34], [x, 1.75, front - 0.1], LAVENDER)
  batch.box([doorWidth, 3.1, 0.3], [x, 1.55, front - 0.22], INK)
  batch.box([doorWidth - 0.2, 2.9, 0.18], [x, 1.5, front - 0.34], STONE_SEAM)
  for (const lean of [0.68, -0.68]) {
    batch.box([doorWidth + 0.5, 0.3, 0.14], [x, 1.5, front - 0.45], LAVENDER, { rotZ: lean })
  }
  for (const side of [-1, 1]) {
    // Lamp housings either side of the door with no lamp in them. Deliberately
    // the one place on this wall that a player expects light and does not get it.
    batch.box([0.44, 0.44, 0.44], [x + side * (doorWidth / 2 + 0.9), 3.1, front - 0.35], STONE_DEEP)
    batch.box([0.2, 0.7, 0.2], [x + side * (doorWidth / 2 + 0.9), 3.6, front - 0.35], LAVENDER)
  }

  /* --- windows, unglazed, on the flanks only ------------------------- *
   * The street face is given over to the notice and the sign; there is no room
   * left on it for windows, and that is the right trade. A player who can see
   * a window on this building is standing side-on to it and cannot read the
   * notice anyway, so the flanks are where "nobody is in" has to be carried.
   * ------------------------------------------------------------------- */
  for (const level of [3.4, 6.5]) {
    for (const side of [-1, 1]) {
      for (const along of [-2.4, 0.4, 3.2]) {
        blankWindow(batch, [0.2, 1.1, 0.8], [x + side * (width / 2 - 0.08), level, z + along], [0.14, 1.45, 1.1])
      }
    }
  }

  /* --- the eyes ----------------------------------------------------- *
   * One solid slab, struck for the street and backed in its own shade. The
   * pivot stands at the eyes' centre and everything below is built at its
   * origin, so `eyes.position.y` and `eyes.rotation.y` are the eyes' own bob
   * and their own sway. See the header.
   * ------------------------------------------------------------------- */
  const rows = eyesRows()
  const eyesHeight = EYES_TALL * EYE_CELL
  const eyesY = BASE_TOP + FLOAT_GAP + eyesHeight / 2
  const bodyDepth = BODY_CELLS * EYE_CELL
  const reverseDepth = REVERSE_CELLS * EYE_CELL
  const eyes = new THREE.Group()
  eyes.name = 'fomo-eyes'
  eyes.position.set(x, eyesY, z)
  const eyesBatch = createBatch()
  // The struck body: three cells deep, its front face on the slab's −z side,
  // mirrored rows so it reads the right way round from the forecourt.
  eyesBatch.plate(strikeEyes(rows, [0, 0, (bodyDepth + reverseDepth) / -2 + bodyDepth / 2], BODY_CELLS, 'street', EYE_LIT))
  // The reverse: the same cells, one cell deep, in the render's shade and
  // without the glow. A player behind the house sees the unlit back of an
  // object, which is honest, rather than a bright mirror copy of the owner's
  // mark — the mirror is what any solid asymmetric body shows from behind, so
  // the only choice available is whether it is presented as the artwork.
  eyesBatch.plate(strikeEyes(rows, [0, 0, (bodyDepth + reverseDepth) / 2 - reverseDepth / 2], REVERSE_CELLS, 'reverse', EYE_SHADE))

  // Uplights along the cornice, aimed up into the eyes. They are also the
  // reason the eyes are lit at all from this side, and they stop four metres
  // short of them: nothing on this building touches the eyes.
  for (const offset of [-4.4, -1.5, 1.5, 4.4]) {
    batch.box([0.5, 0.3, 0.5], [x + offset, BASE_TOP + 0.35, front + 0.4], LAVENDER_LIT)
  }

  /* --- what the house is required to say ----------------------------- *
   * The notice, at door-sign height, filling the street face. See the header:
   * the eyes and the unavailability are one object, and this is the half of it
   * that a player standing at the door will read. It sits BELOW the name rather
   * than above it on purpose — a player reads up a wall from the door, and the
   * first thing they must meet is what does not work.
   * ------------------------------------------------------------------- */
  const notice = plaque(
    [FOMO_NOTICE.headline, ...FOMO_NOTICE.boardLines],
    width - 1.2,
    2.4,
    ACCENT,
  )
  notice.position.set(x, 5.1, front - 0.5)
  notice.rotation.y = Math.PI
  texts.push(notice)
  batch.box([width - 0.9, 2.7, 0.3], [x, 5.1, front - 0.3], INK)
  batch.box([width - 0.6, 3.0, 0.18], [x, 5.1, front - 0.18], LAVENDER)

  // The name, over its own boarded door.
  const trade = plaque([spec.sign], 5.6, 1.0, ACCENT, 0)
  trade.position.set(x, 7.5, front - 0.42)
  trade.rotation.y = Math.PI
  texts.push(trade)
  batch.box([5.9, 1.25, 0.24], [x, 7.5, front - 0.28], INK)

  const built = batch.build(group)
  const eyesBuilt = eyesBatch.build(eyes)
  group.add(eyes)
  for (const mesh of texts) group.add(mesh)

  /**
   * One frame of the eyes: a bob and a sway, both about their own centre.
   *
   * Two independently wrapped phases rather than one clock, so neither period
   * has to divide the other and a long session cannot drift the angle into a
   * float range where a degree costs more precision than the motion has to give.
   *
   * Allocates nothing. Assigning `position.y` and `rotation.y` writes through
   * the objects that already exist; a new Vector3 or Euler here would be sixty
   * of each a second for the life of the session.
   */
  let bob = 0
  let sway = 0
  group.userData.float = (dt: number) => {
    bob = (bob + BOB_RATE * dt) % TAU
    sway = (sway + SWAY_RATE * dt) % TAU
    eyes.position.y = eyesY + Math.sin(bob) * BOB_RISE
    eyes.rotation.y = Math.sin(sway) * SWAY_LIMIT
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    // Both welded bodies. The base's batch and the eyes' are separate owners of
    // separate buffers, and freeing one of them is the leak, not the fix.
    built.dispose()
    eyesBuilt.dispose()
    for (const mesh of texts) {
      mesh.geometry.dispose()
      disposeMaterial(mesh.material as THREE.Material)
    }
  }
  group.userData.dispose = dispose
  // Published because the height the eyes return to is the only way to tell a
  // paused frame from a mid-bob one, and both the verifier and the screenshot
  // harness have to hold them still to compare one side against the other. A
  // harness that hardcodes the number stops agreeing with the building the
  // first time a constant above it moves.
  group.userData.eyesRestY = eyesY
  group.userData.boxes = built.boxes + eyesBuilt.boxes
  group.userData.triangles = built.triangles + eyesBuilt.triangles
  group.userData.meshes = built.meshes.length + eyesBuilt.meshes.length
  // Same teardown signal the emblems and the Zcash house use: removal from the
  // graph. The case that actually leaks is the world remounting on a wardrobe
  // change and building a second town over the first one's buffers.
  group.addEventListener('removed', dispose)
  return group
}

/**
 * Advance the eyes by one frame.
 *
 * Same shape as `animateZcashHouse`: the house is handed to the render loop as
 * a plain Object3D, so the per-frame work hangs off `userData` and this is the
 * typed door to it. Silently does nothing if the house is absent, which is what
 * the loop wants — the town is built once and the loop should not have to know
 * which landmarks happen to move.
 */
export function animateFomoHouse(house: THREE.Object3D | null | undefined, dt: number) {
  const float = house?.userData.float as ((dt: number) => void) | undefined
  float?.(dt)
}
