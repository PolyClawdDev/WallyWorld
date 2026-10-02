import type { WizardId } from './characters'

/* ------------------------------------------------------------------ *
 * Single source of truth for the town's plan. `createTown()` builds the
 * Three.js district from these numbers and the map popup draws the same
 * numbers, so the two can never drift apart.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * The shielded-transfer notice.
 *
 * Held here, as data, for one reason: Sable's board in the world, and
 * any panel that ever describes the service, must say the same thing,
 * and that thing must not drift into optimism.
 *
 * What it says is not a stylistic choice. The desk behind it is open
 * and it cannot send money, and both of those have to survive on a
 * sign with room for three lines:
 *
 *   - It is open. `src/server/providers/courier.ts` parses the address
 *     with the ZIP-316 parser, classifies its receivers, prices the leg
 *     against the live conversion endpoint and freezes the result into
 *     an intent. A player can do all of that, and the Journal desk is
 *     where they do it.
 *   - It cannot pay. `src/server/providers/zcashWallet.ts` surveys every
 *     candidate backend against its own words and concludes, as a value
 *     the operator console reports rather than an inference: "Nothing in
 *     this repository can sign a Zcash transaction." `COURIER_SIGNER` in
 *     courier.ts says the same of the Solana side, and calls adding one
 *     a custody decision rather than a configuration change.
 *   - The quote cannot become a payment by accident. Every quote this
 *     project asks for is `dry`, which `oneclick.ts` hardcodes rather
 *     than accepting as an argument, and a dry quote returns a price and
 *     no deposit address at all.
 *
 * This wording used to say a priced quote for a shielded address was
 * not proof of shielded delivery and that the payout planner refused
 * outright. That stopped being the live verdict when the executing
 * connector was identified and observed paying into the Orchard pool:
 * `classifyZecDelivery` now returns `orchard-substantiated` for an
 * Orchard-only address and `planZecPayout` calls that route usable. What
 * is missing is no longer the verdict. It is the signer.
 *
 * The emblem on Sable's board says which network the desk talks to.
 * These lines say what it will not do, and that half does not get
 * shortened to fit the sign.
 * ------------------------------------------------------------------ */
export const SHIELDED_NOTICE = {
  headline: 'SHIELDED · QUOTE ONLY',
  lines: [
    'This desk reads your Zcash address and prices the route. It',
    'cannot send anything: no usable Zcash signing wallet exists for',
    'this project and there is no treasury signer, so the last stage',
    'of the run has nothing to carry it out. Every quote is dry, which',
    'means it comes back with a price and no deposit address.',
  ],
  /** Short form, for a sign board that only has room for two lines. */
  boardLines: ['QUOTES ONLY · NO SIGNER', 'NOTHING HERE CAN SEND ZEC'],
  /** Why the mark is on the board at all, so it cannot read as an endorsement. */
  markCaption: 'INTEGRATES WITH',
} as const

/**
 * What trade a building plies, which is what decides how it is BUILT.
 *
 * Before this existed every building was the same box with a pyramid on top and
 * a floating label, so the only thing telling a smithy from a bakery was the
 * word on the sign. `createTown()` in src/townArt.ts switches on this to give
 * each one its own roofline, chimneys, shutters, signage and yard clutter.
 */
export type BuildingKind =
  | 'inn' | 'hall' | 'bakery' | 'stable' | 'apothecary' | 'smithy' | 'market' | 'post'
  | 'archive' | 'observatory' | 'garden' | 'tower' | 'glasshouse' | 'weaver' | 'cartwright'
  | 'chapel' | 'fishery'

export type BuildingSpec = {
  name: string
  kind: BuildingKind
  x: number
  z: number
  width: number
  depth: number
  height: number
  wall: string
  roof: string
  sign: string
  accent?: string
  /** Extra timber/plaster tone for courses and gable ends. Falls back to the wall. */
  trim?: string
  /**
   * Built by its own renderer instead of the standard box-and-pyramid.
   *
   * One value so far: `zcash`, which builds Sable's premises as a struck coin
   * in src/zcashHouse.ts. `wall`, `roof` and `trim` are ignored for a landmark
   * — it brings its own palette — but `width`, `depth` and `sign` still mean
   * exactly what they mean everywhere else, because navigation and the map read
   * them without knowing or caring how the building is drawn.
   */
  landmark?: 'zcash'
}

/**
 * Heights only. Every footprint below is byte-identical to before on purpose.
 *
 * `width`/`depth` are what `createNavGrid` builds its obstacles from and what
 * the duplicate `townBuildings` table in src/shared/zones.ts repeats for
 * server-side checks, so moving or resizing a building means changing both or
 * players walk through walls. Height is outside all of that, which is how a
 * skyline can be had without touching navigation.
 *
 * Meant to read as a skyline rather than a list. The Spell Tower clears the 39m
 * trees so it is visible from the hunting grounds, the Observatory, Archive and
 * Chapel answer it from the other quarters, and the trades ringing the plaza
 * stay low enough that the plaza still reads as a room you are standing in.
 */
export const buildingSpecs: BuildingSpec[] = [
  { name: 'Hearth Inn', kind: 'inn', x: -17, z: 16, width: 12, depth: 9, height: 14, wall: '#795c50', roof: '#463b43', sign: 'HEARTH', accent: '#d5a64b', trim: '#e5ddc8' },
  { name: 'Town Hall', kind: 'hall', x: 17, z: 16, width: 11, depth: 9, height: 26, wall: '#626b70', roof: '#39444d', sign: 'HALL', accent: '#9580b8', trim: '#e5ddc8' },
  { name: 'Bakery', kind: 'bakery', x: -17, z: -17, width: 10, depth: 8, height: 10, wall: '#8a6a55', roof: '#57434a', sign: 'BAKERY', accent: '#d9a35c', trim: '#e5ddc8' },
  { name: 'Stable', kind: 'stable', x: 17, z: -17, width: 11, depth: 8, height: 8, wall: '#6d594b', roof: '#4a3d39', sign: 'STABLE', accent: '#9a7046' },
  /* Sable's. The shielded-transfer desk is here, so the house is a coin — see
   * src/zcashHouse.ts, including what such a building is obliged to say. The
   * height is the top of that coin rather than an eaves line, and the footprint
   * is unchanged: the coin overhangs it eight metres up, where nothing walks. */
  { name: 'Potion Shop', kind: 'apothecary', x: 50, z: -16, width: 12, depth: 9, height: 23, wall: '#5c6e68', roof: '#3d4d4d', sign: 'ALCHEMY', accent: '#7bc9ce', trim: '#e5ddc8', landmark: 'zcash' },
  { name: 'Workshop', kind: 'smithy', x: 50, z: 18, width: 13, depth: 10, height: 15, wall: '#765a46', roof: '#4e3d38', sign: 'FORGE', accent: '#e37c42' },
  { name: 'Market Hall', kind: 'market', x: 72, z: 0, width: 14, depth: 12, height: 21, wall: '#68655d', roof: '#45494a', sign: 'MARKET', accent: '#d5a64b', trim: '#e5ddc8' },
  { name: 'Post Office', kind: 'post', x: 50, z: 50, width: 12, depth: 9, height: 13, wall: '#78645c', roof: '#4b4145', sign: 'POST', accent: '#9580b8', trim: '#e5ddc8' },
  { name: 'The Archive', kind: 'archive', x: -59, z: 43, width: 12, depth: 11, height: 31, wall: '#5a6879', roof: '#3b4350', sign: 'ARCHIVE', accent: '#7bc9ce', trim: '#e5ddc8' },
  { name: 'Observatory', kind: 'observatory', x: -72, z: 70, width: 14, depth: 12, height: 37, wall: '#645b7d', roof: '#39364d', sign: 'STARS', accent: '#9580b8' },
  { name: 'Garden House', kind: 'garden', x: -42, z: 76, width: 11, depth: 9, height: 9, wall: '#5e705c', roof: '#3d5546', sign: 'GARDEN', accent: '#9ca66d', trim: '#e5ddc8' },
  { name: 'Spell Tower', kind: 'tower', x: -82, z: 52, width: 10, depth: 10, height: 52, wall: '#555b70', roof: '#38384d', sign: 'TOWER', accent: '#9580b8' },
  { name: 'Crystal Conservatory', kind: 'glasshouse', x: -15, z: 74, width: 14, depth: 9, height: 16, wall: '#587275', roof: '#354f58', sign: 'GLASS', accent: '#7bc9ce' },
  { name: 'Weaver', kind: 'weaver', x: 74, z: 72, width: 11, depth: 9, height: 12, wall: '#826557', roof: '#544047', sign: 'WEAVER', accent: '#e39a6d', trim: '#e5ddc8' },
  { name: 'Cartwright', kind: 'cartwright', x: 83, z: -54, width: 12, depth: 10, height: 11, wall: '#74604d', roof: '#4c443d', sign: 'CARTS', accent: '#d5a64b' },
  { name: 'River Chapel', kind: 'chapel', x: 0, z: -68, width: 11, depth: 9, height: 28, wall: '#69767b', roof: '#424e57', sign: 'CHAPEL', accent: '#7bc9ce', trim: '#e5ddc8' },
  { name: 'Fisher Shed', kind: 'fishery', x: 52, z: -70, width: 10, depth: 8, height: 7, wall: '#596b67', roof: '#3d4b48', sign: 'FISH', accent: '#7bc9ce' },
]

/**
 * The emblem each service NPC's standard carries, and the premises they work
 * from. Ids are drawn as pixel art in src/emblems.ts — nothing is imported.
 *
 * `integrates` names an EXTERNAL network the service would talk to. It is a
 * label on a third-party mark, not a statement that anything works; anything
 * with an `integrates` mark must also carry a `status` line saying where it
 * actually stands, which src/townArt.ts hangs on the same board.
 */
export type ServiceNpc = {
  name: string
  id: WizardId
  x: number
  z: number
  color: string
  trade: string
  emblem: string
  integrates?: string
  status?: string[]
}

export const serviceNpcs: ServiceNpc[] = [
  { name: 'MIRA · GUIDE', id: 'ORBIT', x: 3.5, z: 5.2, color: '#7bc9ce', trade: 'WAYFINDING', emblem: 'COMPASS' },
  { name: 'LYRA · ARCHIVIST', id: 'ORBIT', x: -52, z: 36, color: '#7bc9ce', trade: 'RECORDS', emblem: 'BOOK' },
  { name: 'VELLUM · MERCHANT', id: 'BRAMBLE', x: 65, z: -7, color: '#d5a64b', trade: 'TRADE', emblem: 'SCALES' },
  {
    name: 'SABLE · ALCHEMIST',
    id: 'CINDER',
    x: 43,
    z: -9,
    color: '#7bc9ce',
    trade: 'DRAUGHTS',
    emblem: 'MORTAR',
    // Sable keeps the shielded courier desk. It quotes and cannot pay, and the
    // sign says so; see SHIELDED_NOTICE above for why that half is not softened.
    integrates: 'ZCASH',
    status: [...SHIELDED_NOTICE.boardLines],
  },
  { name: 'BRONZE · BLACKSMITH', id: 'CINDER', x: 43, z: 11, color: '#e37c42', trade: 'IRONWORK', emblem: 'HAMMER' },
  { name: 'PIP · COURIER', id: 'MOTH', x: 43, z: 43, color: '#9580b8', trade: 'DELIVERY', emblem: 'LETTER' },
  { name: 'ASTRA · ORRERY KEEPER', id: 'ORBIT', x: -68, z: 61, color: '#9580b8', trade: 'THE SKY', emblem: 'ORRERY' },
  { name: 'NELL · INNKEEPER', id: 'MOTH', x: -10, z: 10, color: '#d5a64b', trade: 'BOARD', emblem: 'TANKARD' },
]

/** Streets, plaza, canal and landmarks in world metres. */
export const townLayout = {
  ground: 220,
  /** Movement is clamped to this half-extent, so the map frames the same box. */
  bounds: 96,
  streets: [
    { x: 0, z: 0, width: 16, depth: 190, y: 0.09, color: '#555d59' },
    { x: 0, z: 0, width: 150, depth: 13, y: 0.1, color: '#555d59' },
    { x: -48, z: 48, width: 12, depth: 95, y: 0.2, color: '#61635c' },
    { x: -14, z: 48, width: 86, depth: 11, y: 0.2, color: '#61635c' },
  ],
  plaza: { x: 0, z: 0, radius: 18, color: '#65706a' },
  canal: { x: 34, z: 5, bankWidth: 11, bankLength: 125, waterWidth: 7.2, waterLength: 122, bank: '#4d655f', water: '#1b5660' },
  /** Canal crossings, given as world z. */
  bridges: [-34, 38],
  fountain: { x: 0, z: 0, radius: 4.8 },
  noticeBoard: { x: -10, z: 7 },
  marketStalls: { x: -15, z: -8, count: 5, step: 4 },
}

/** Perimeter woodland ring: one deterministic sweep shared by world and map. */
export function perimeterTrees() {
  return Array.from({ length: 48 }, (_, i) => {
    const a = i * 2.7
    return { x: Math.cos(a) * (92 + (i % 4) * 3), z: Math.sin(a) * (92 + (i % 5) * 2), alt: i % 2 === 1 }
  })
}

/** Label-only groupings, derived from where things actually stand. */
export const districts: Array<{ id: string; name: string; accent: string; holds: (x: number, z: number) => boolean }> = [
  { id: 'star', name: 'STAR QUARTER', accent: '#9580b8', holds: (x, z) => z > 38 && x < 20 },
  { id: 'market', name: 'RIVER MARKET', accent: '#7bc9ce', holds: x => x >= 34 },
  { id: 'old', name: 'OLD TOWN', accent: '#d5a64b', holds: () => true },
]

export function districtAt(x: number, z: number) {
  return districts.find(district => district.holds(x, z))!
}

/* ------------------------------------------------------------------ *
 * Seam for the hunting grounds. src/wildlife.ts fills this at import time
 * from its own spawn regions, which keeps the map a projection of the live
 * data and keeps this module free of any Three.js dependency. If nothing
 * publishes regions, the list stays empty and the map draws none rather
 * than guessing at coordinates.
 * ------------------------------------------------------------------ */
export type HuntingRegion = {
  name: string
  /** The region's heart, for the label and the compass. */
  x: number
  z: number
  /** Farthest the footprint reaches from the heart. Used to place the label clear of it. */
  reach: number
  /** The region edge as a closed ring of world points. Regions are not circles. */
  outline: Array<[number, number]>
  accent: string
}
export const huntingRegions: HuntingRegion[] = []
