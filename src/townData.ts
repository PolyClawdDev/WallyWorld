import type { WizardId } from './characters'

/* ------------------------------------------------------------------ *
 * Single source of truth for the town's plan. `createTown()` builds the
 * Three.js district from these numbers and the map popup draws the same
 * numbers, so the two can never drift apart.
 * ------------------------------------------------------------------ */

export type BuildingSpec = { name: string; x: number; z: number; width: number; depth: number; height: number; wall: string; roof: string; sign: string; accent?: string }

export const buildingSpecs: BuildingSpec[] = [
  { name: 'Hearth Inn', x: -17, z: 16, width: 12, depth: 9, height: 5.3, wall: '#795c50', roof: '#463b43', sign: 'HEARTH', accent: '#d5a64b' },
  { name: 'Town Hall', x: 17, z: 16, width: 11, depth: 9, height: 5.8, wall: '#626b70', roof: '#39444d', sign: 'HALL', accent: '#9580b8' },
  { name: 'Bakery', x: -17, z: -17, width: 10, depth: 8, height: 4.6, wall: '#8a6a55', roof: '#57434a', sign: 'BAKERY', accent: '#d9a35c' },
  { name: 'Stable', x: 17, z: -17, width: 11, depth: 8, height: 4.3, wall: '#6d594b', roof: '#4a3d39', sign: 'STABLE', accent: '#9a7046' },
  { name: 'Potion Shop', x: 50, z: -16, width: 12, depth: 9, height: 5.2, wall: '#5c6e68', roof: '#3d4d4d', sign: 'ALCHEMY', accent: '#7bc9ce' },
  { name: 'Workshop', x: 50, z: 18, width: 13, depth: 10, height: 5.5, wall: '#765a46', roof: '#4e3d38', sign: 'WORKSHOP', accent: '#e37c42' },
  { name: 'Market Hall', x: 72, z: 0, width: 14, depth: 12, height: 5.6, wall: '#68655d', roof: '#45494a', sign: 'MARKET', accent: '#d5a64b' },
  { name: 'Post Office', x: 50, z: 50, width: 12, depth: 9, height: 5.0, wall: '#78645c', roof: '#4b4145', sign: 'POST', accent: '#9580b8' },
  { name: 'The Archive', x: -59, z: 43, width: 12, depth: 11, height: 9.0, wall: '#5a6879', roof: '#3b4350', sign: 'ARCHIVE', accent: '#7bc9ce' },
  { name: 'Observatory', x: -72, z: 70, width: 14, depth: 12, height: 7.4, wall: '#645b7d', roof: '#39364d', sign: 'STARS', accent: '#9580b8' },
  { name: 'Garden House', x: -42, z: 76, width: 11, depth: 9, height: 4.7, wall: '#5e705c', roof: '#3d5546', sign: 'GARDEN', accent: '#9ca66d' },
  { name: 'Spell Tower', x: -82, z: 52, width: 10, depth: 10, height: 11, wall: '#555b70', roof: '#38384d', sign: 'TOWER', accent: '#9580b8' },
  { name: 'Crystal Conservatory', x: -15, z: 74, width: 14, depth: 9, height: 5.2, wall: '#587275', roof: '#354f58', sign: 'GLASS', accent: '#7bc9ce' },
  { name: 'Weaver', x: 74, z: 72, width: 11, depth: 9, height: 5.0, wall: '#826557', roof: '#544047', sign: 'WEAVER', accent: '#e39a6d' },
  { name: 'Cartwright', x: 83, z: -54, width: 12, depth: 10, height: 4.8, wall: '#74604d', roof: '#4c443d', sign: 'CARTS', accent: '#d5a64b' },
  { name: 'River Chapel', x: 0, z: -68, width: 11, depth: 9, height: 6.0, wall: '#69767b', roof: '#424e57', sign: 'CHAPEL', accent: '#7bc9ce' },
  { name: 'Fisher Shed', x: 52, z: -70, width: 10, depth: 8, height: 4.0, wall: '#596b67', roof: '#3d4b48', sign: 'FISH', accent: '#7bc9ce' },
]

export const serviceNpcs: Array<{ name: string; id: WizardId; x: number; z: number; color: string }> = [
  { name: 'MIRA · GUIDE', id: 'ORBIT', x: 3.5, z: 5.2, color: '#7bc9ce' },
  { name: 'LYRA · ARCHIVIST', id: 'ORBIT', x: -52, z: 36, color: '#7bc9ce' },
  { name: 'VELLUM · MERCHANT', id: 'BRAMBLE', x: 65, z: -7, color: '#d5a64b' },
  { name: 'SABLE · ALCHEMIST', id: 'CINDER', x: 43, z: -9, color: '#7bc9ce' },
  { name: 'BRONZE · BLACKSMITH', id: 'CINDER', x: 43, z: 11, color: '#e37c42' },
  { name: 'PIP · COURIER', id: 'MOTH', x: 43, z: 43, color: '#9580b8' },
  { name: 'ASTRA · ORRERY KEEPER', id: 'ORBIT', x: -68, z: 61, color: '#9580b8' },
  { name: 'NELL · INNKEEPER', id: 'MOTH', x: -10, z: 10, color: '#d5a64b' },
]

export const ambientNpcs: Array<{ id: WizardId; x: number; z: number }> = [
  { id: 'BRAMBLE', x: -8, z: 3 }, { id: 'CINDER', x: 8, z: 4 }, { id: 'MOTH', x: -5, z: -5 },
  { id: 'ORBIT', x: 12, z: -4 }, { id: 'BRAMBLE', x: 27, z: -22 }, { id: 'CINDER', x: 40, z: 30 },
  { id: 'MOTH', x: -29, z: 24 }, { id: 'ORBIT', x: -34, z: 51 }, { id: 'BRAMBLE', x: 18, z: 55 },
  { id: 'CINDER', x: 69, z: 53 },
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
export type HuntingRegion = { name: string; x: number; z: number; radius: number; accent: string }
export const huntingRegions: HuntingRegion[] = []
