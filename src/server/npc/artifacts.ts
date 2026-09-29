/* ------------------------------------------------------------------ *
 * The artifacts an NPC service actually hands over.
 *
 * Every generator in this file is a pure function of data this repository
 * already holds — `src/townData.ts` and `src/shared/zones.ts` for the town,
 * the gold ledger for a holdings statement, the PvP journal for a duel
 * record. Nothing is invented, nothing is fetched, and no language model is
 * involved: the same request produces the same document, and every name,
 * coordinate and distance in the output can be traced back to a row or a
 * constant in the source tree.
 *
 * Output is plain text. It is rendered into the journal as text, so there is
 * no markup in it and nothing here escapes anything, because there is nothing
 * to escape.
 *
 * `src/townData.ts` is the client's town plan and `src/shared/zones.ts` is the
 * server's copy of the same footprints. Reading both is deliberate — a brief
 * that quotes the plan and the collision boxes side by side is describing the
 * world players are standing in rather than a description of it.
 * ------------------------------------------------------------------ */

import { buildingSpecs, districts, serviceNpcs, townLayout, type BuildingSpec } from '../../townData'
import { DUEL_RINGS, SAFE_ZONE, TOWN_RESPAWN, WORLD_HALF, townBuildings, townPaving, townPlaza } from '../../shared/zones'
import { conservationReport, entriesForUser } from '../money/ledger'
import { goldSnapshot, provenanceBreakdown } from '../money/gold'
import { journalFor } from '../pvp/hub'

const RULE = '─'.repeat(64)

/**
 * Compass names read clockwise from +z, which is south in this town.
 *
 * The same eight names and the same rounding as `headingOf` in
 * `src/WorldMap.tsx`, so a direction printed on paper agrees with the arrow
 * drawn on the chart. Duplicated rather than imported because that module is a
 * React component and this one runs on the server.
 */
const COMPASS = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'] as const
const COMPASS_LONG: Record<string, string> = {
  S: 'south', SE: 'south-east', E: 'east', NE: 'north-east',
  N: 'north', NW: 'north-west', W: 'west', SW: 'south-west',
}

export function bearingOf(dx: number, dz: number): string {
  const facing = Math.atan2(dx, dz)
  return COMPASS[((Math.round(facing / (Math.PI / 4)) % 8) + 8) % 8]
}

const metres = (value: number) => `${Math.round(value)}m`
const at = (x: number, z: number) => `(${Math.round(x)}, ${Math.round(z)})`
const distance = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az)

/** Label-only grouping, straight out of `districts` in the town plan. */
const quarterOf = (x: number, z: number) => districts.find(district => district.holds(x, z))!

function pad(text: string, width: number) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** Wraps prose at a fixed column so the journal never has to reflow it. */
function wrap(text: string, width = 64, indent = ''): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(indent + line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(indent + line)
  return lines
}

/** The service NPC standing closest to a building, and how far off it is. */
function keeperOf(building: BuildingSpec) {
  let best: { name: string; trade: string; away: number } | null = null
  for (const npc of serviceNpcs) {
    const away = distance(building.x, building.z, npc.x, npc.z)
    if (!best || away < best.away) best = { name: npc.name, trade: npc.trade, away }
  }
  return best && best.away <= 24 ? best : null
}

/** Each building's nearest neighbour. A real relationship, measured, not asserted. */
function nearestNeighbour(building: BuildingSpec) {
  let best: { name: string; away: number } | null = null
  for (const other of buildingSpecs) {
    if (other === building) continue
    const away = distance(building.x, building.z, other.x, other.z)
    if (!best || away < best.away) best = { name: other.name, away }
  }
  return best!
}

/** The collision footprint the server enforces, matched to the plan by position. */
function footprintOf(building: BuildingSpec) {
  return townBuildings.find(rect => rect.x === building.x && rect.z === building.z) ?? null
}

export const buildingByName = (name: string) =>
  buildingSpecs.find(spec => spec.name.toLowerCase() === name.trim().toLowerCase()) ?? null

export const landmarkNames = () => buildingSpecs.map(spec => spec.name)

/* ----------------------------------------------------- the town history brief */

/**
 * Lyra's brief. One page about this town, assembled from the town plan.
 *
 * The shape is a survey rather than a story, because a survey is what the data
 * supports: ground and bounds, the quarters and what stands in them, each
 * building's trade, height, footprint and nearest neighbour, and who keeps a
 * post nearby. Everything in it is a number or a name from the plan.
 */
export function townHistoryBrief(): string {
  const archive = buildingByName('The Archive')!
  const tallest = [...buildingSpecs].sort((a, b) => b.height - a.height)[0]
  const lines: string[] = []

  lines.push('TOWN HISTORY BRIEF — VOXELS, WORLD 01')
  lines.push(`Lyra, archivist · The Archive ${at(archive.x, archive.z)} · ${quarterOf(archive.x, archive.z).name}`)
  lines.push(RULE)
  lines.push(...wrap(
    `Surveyed from the town plan this world is built from: ${buildingSpecs.length} buildings, ` +
    `${serviceNpcs.length} service posts, ${townLayout.streets.length} paved streets and one canal. ` +
    'The figures below are the same ones the world is assembled from, so a step paced out in town matches the page.',
  ))
  lines.push('')

  lines.push('THE GROUND')
  lines.push(`  Ground plate      ${townLayout.ground}m × ${townLayout.ground}m`)
  lines.push(`  Walkable half     ${WORLD_HALF}m from the fountain in any direction`)
  lines.push(`  Plaza             ${townLayout.plaza.radius}m circle at ${at(townLayout.plaza.x, townLayout.plaza.z)}`)
  lines.push(`  Fountain          ${townLayout.fountain.radius}m at the plaza centre`)
  lines.push(`  Safe ground       ${SAFE_ZONE.r}m circle at ${at(SAFE_ZONE.x, SAFE_ZONE.z)} — no duel may be fought inside it`)
  lines.push(`  Return point      ${at(TOWN_RESPAWN.x, TOWN_RESPAWN.z)}, on the plaza`)
  lines.push(`  Notice board      ${at(townLayout.noticeBoard.x, townLayout.noticeBoard.z)}`)
  lines.push(`  Market stalls     ${townLayout.marketStalls.count}, stepped ${townLayout.marketStalls.step}m from ${at(townLayout.marketStalls.x, townLayout.marketStalls.z)}`)
  lines.push('')

  lines.push('THE STREETS AND THE WATER')
  for (const street of townLayout.streets) {
    const run = street.depth >= street.width ? `${street.depth}m north-south` : `${street.width}m east-west`
    const across = street.depth >= street.width ? `${street.width}m wide` : `${street.depth}m wide`
    lines.push(`  ${pad(at(street.x, street.z), 12)} ${pad(run, 20)} ${across}`)
  }
  const canal = townLayout.canal
  lines.push(`  Canal at x=${canal.x}: ${canal.waterWidth}m of water down ${canal.waterLength}m, banks ${canal.bankWidth}m`)
  lines.push(`  Crossed at z=${townLayout.bridges.join(' and z=')}`)
  lines.push(`  Paved rectangles the server checks against: ${townPaving.length}`)
  lines.push('')

  lines.push('THE QUARTERS')
  for (const district of districts) {
    const held = buildingSpecs.filter(spec => quarterOf(spec.x, spec.z).id === district.id)
    const highest = [...held].sort((a, b) => b.height - a.height)[0]
    lines.push(`  ${pad(district.name, 14)} ${held.length} buildings` + (highest ? ` · tallest ${highest.name} at ${metres(highest.height)}` : ''))
    lines.push(...wrap(held.map(spec => spec.name).join(', '), 60, '    '))
  }
  lines.push('')

  lines.push('THE BUILDINGS')
  lines.push(`  ${pad('NAME', 22)}${pad('TRADE', 12)}${pad('STANDS AT', 12)}${pad('HEIGHT', 8)}FOOTPRINT`)
  for (const spec of buildingSpecs) {
    const box = footprintOf(spec)
    lines.push(
      `  ${pad(spec.name, 22)}${pad(spec.kind, 12)}${pad(at(spec.x, spec.z), 12)}${pad(metres(spec.height), 8)}` +
      (box ? `${box.halfW * 2}m × ${box.halfD * 2}m` : `${spec.width}m × ${spec.depth}m (plan only)`),
    )
  }
  lines.push('')

  lines.push('WHO STANDS WHERE')
  for (const npc of serviceNpcs) {
    const premises = buildingSpecs
      .map(spec => ({ spec, away: distance(spec.x, spec.z, npc.x, npc.z) }))
      .sort((a, b) => a.away - b.away)[0]
    const works = premises && premises.away <= 24
      ? `nearest premises ${premises.spec.name}, ${metres(premises.away)} off`
      : 'no premises within 24m'
    lines.push(`  ${pad(npc.name, 24)}${pad(npc.trade, 12)}${pad(at(npc.x, npc.z), 12)}${works}`)
  }
  lines.push('')

  lines.push('NEIGHBOURS, MEASURED')
  for (const spec of buildingSpecs) {
    const neighbour = nearestNeighbour(spec)
    const keeper = keeperOf(spec)
    lines.push(
      `  ${pad(spec.name, 22)}nearest ${pad(neighbour.name, 22)}${pad(metres(neighbour.away), 7)}` +
      (keeper ? `· ${keeper.name.split(' ·')[0]} nearby` : ''),
    )
  }
  lines.push('')

  lines.push('WHERE DUELS ARE FOUGHT')
  // Distance only, no compass name: the rings carry their own directional names
  // in `src/shared/zones.ts` and two of them disagree with the heading convention
  // the chart uses, which is not a disagreement a brief should quietly settle.
  for (const ring of DUEL_RINGS) {
    const fromTown = distance(0, 0, ring.x, ring.z)
    lines.push(`  ${pad(ring.name, 16)}${pad(at(ring.x, ring.z), 12)}radius ${metres(ring.radius)} · ${metres(fromTown)} from the fountain`)
  }
  lines.push('')

  lines.push('NOTE ON THIS BRIEF')
  lines.push(...wrap(
    `Assembled from the town plan in src/townData.ts and the server's footprint copy in ` +
    `src/shared/zones.ts. The skyline it describes is real: ${tallest.name} is the tallest thing ` +
    `standing at ${metres(tallest.height)}. No part of this page was written by a model and no part ` +
    'of it was fetched from anywhere; the same request produces this same document.',
  ))
  return lines.join('\n')
}

/* ------------------------------------------------------------- directions */

/** The nearest point on a paved rectangle, used to find the street a door opens onto. */
function nearestOnRect(rect: { x: number; z: number; halfW: number; halfD: number }, x: number, z: number) {
  const px = Math.min(Math.max(x, rect.x - rect.halfW), rect.x + rect.halfW)
  const pz = Math.min(Math.max(z, rect.z - rect.halfD), rect.z + rect.halfD)
  return { x: px, z: pz, away: Math.hypot(x - px, z - pz) }
}

/**
 * Mira's directions to a named landmark.
 *
 * A real two-leg route rather than a sentence: from the fountain to the point
 * on the paved street network closest to the destination, then off the paving
 * to the door. Both legs carry a measured length and a compass heading, and the
 * street chosen is whichever paved rectangle in `townPaving` actually comes
 * nearest the building.
 */
export function directionsTo(building: BuildingSpec): string {
  const joins = townPaving
    .map((rect, index) => ({ index, rect, point: nearestOnRect(rect, building.x, building.z) }))
    .sort((a, b) => a.point.away - b.point.away)
  const chosen = joins[0]
  const legOne = distance(townLayout.fountain.x, townLayout.fountain.z, chosen.point.x, chosen.point.z)
  const legTwo = chosen.point.away
  const straight = distance(0, 0, building.x, building.z)
  const box = footprintOf(building)
  const keeper = keeperOf(building)
  const quarter = quarterOf(building.x, building.z)

  const lines: string[] = []
  lines.push(`DIRECTIONS — ${building.name.toUpperCase()}`)
  lines.push(`Mira, wayfinder · from the fountain ${at(townLayout.fountain.x, townLayout.fountain.z)}`)
  lines.push(RULE)
  lines.push(`  Destination     ${building.name} · ${building.kind} · sign reads "${building.sign}"`)
  lines.push(`  Stands at       ${at(building.x, building.z)} in the ${quarter.name}`)
  lines.push(`  As the crow     ${metres(straight)} ${COMPASS_LONG[bearingOf(building.x, building.z)]}`)
  lines.push('')
  lines.push('THE WALK')
  lines.push(`  Leg 1  ${metres(legOne)} ${COMPASS_LONG[bearingOf(chosen.point.x, chosen.point.z)]} across the plaza and along the paving`)
  lines.push(`         to ${at(chosen.point.x, chosen.point.z)}, the nearest paved ground to the door.`)
  lines.push(`         That stretch is paving rectangle ${chosen.index + 1} of ${townPaving.length}, ` +
    `${chosen.rect.halfW * 2}m × ${chosen.rect.halfD * 2}m centred on ${at(chosen.rect.x, chosen.rect.z)}.`)
  if (legTwo < 1) {
    lines.push('  Leg 2  None. The door opens straight onto that paving.')
  } else {
    lines.push(`  Leg 2  ${metres(legTwo)} ${COMPASS_LONG[bearingOf(building.x - chosen.point.x, building.z - chosen.point.z)]} off the paving to the door.`)
  }
  lines.push(`  Total  ${metres(legOne + legTwo)} walked, against ${metres(straight)} straight.`)
  lines.push('')
  lines.push('WHEN YOU ARRIVE')
  lines.push(`  The building stands ${metres(building.height)} tall` + (box ? ` on a ${box.halfW * 2}m × ${box.halfD * 2}m footprint.` : '.'))
  if (keeper) lines.push(`  ${keeper.name} keeps a post ${metres(keeper.away)} off, trading in ${keeper.trade.toLowerCase()}.`)
  const neighbour = nearestNeighbour(building)
  lines.push(`  Nearest other roof: ${neighbour.name}, ${metres(neighbour.away)} away.`)
  lines.push(`  Inside the safe ground? ${Math.hypot(building.x - SAFE_ZONE.x, building.z - SAFE_ZONE.z) <= SAFE_ZONE.r ? 'yes' : 'no'}.`)
  lines.push('')
  lines.push(...wrap(
    'Measured from the same plan the world is built from, and from the same paved rectangles the ' +
    'server checks a step against, so the route exists on the ground and not only on this page.',
  ))
  return lines.join('\n')
}

/* ------------------------------------------------------------ map extract */

const GRID_COLS = 48
const GRID_ROWS = 24

/**
 * Pip's route card: the town drawn as characters, plus the numbers behind it.
 *
 * Plotted from the server's own collision geometry — `townPaving`,
 * `townBuildings`, `townPlaza` — at 4m per column and 8m per row, so a mark on
 * the card is a thing that is really in the way. Buildings are lettered and
 * listed underneath with their true positions.
 */
export function mapExtract(): string {
  const cell = (WORLD_HALF * 2) / GRID_COLS
  const row = (WORLD_HALF * 2) / GRID_ROWS
  const grid = Array.from({ length: GRID_ROWS }, () => Array.from({ length: GRID_COLS }, () => ' '))

  const colOf = (x: number) => Math.round((x + WORLD_HALF) / cell)
  const rowOf = (z: number) => Math.round((z + WORLD_HALF) / row)
  const put = (x: number, z: number, mark: string) => {
    const c = colOf(x)
    const r = rowOf(z)
    if (c < 0 || c >= GRID_COLS || r < 0 || r >= GRID_ROWS) return
    grid[r][c] = mark
  }
  const fill = (rect: { x: number; z: number; halfW: number; halfD: number }, mark: string) => {
    for (let x = rect.x - rect.halfW; x <= rect.x + rect.halfW; x += cell / 2) {
      for (let z = rect.z - rect.halfD; z <= rect.z + rect.halfD; z += row / 2) put(x, z, mark)
    }
  }

  for (const rect of townPaving) fill(rect, '=')
  const canal = townLayout.canal
  fill({ x: canal.x, z: canal.z, halfW: canal.waterWidth / 2, halfD: canal.waterLength / 2 }, '~')
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    for (let r = 0; r <= townPlaza.r; r += cell / 2) put(townPlaza.x + Math.cos(a) * r, townPlaza.z + Math.sin(a) * r, 'o')
  }
  for (const ring of DUEL_RINGS) {
    for (let a = 0; a < Math.PI * 2; a += 0.05) put(ring.x + Math.cos(a) * ring.radius, ring.z + Math.sin(a) * ring.radius, '*')
  }
  for (const z of townLayout.bridges) put(canal.x, z, '+')
  for (const rect of townBuildings) fill(rect, '#')

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  buildingSpecs.forEach((spec, index) => put(spec.x, spec.z, letters[index] ?? '#'))
  put(townLayout.fountain.x, townLayout.fountain.z, '@')

  const lines: string[] = []
  lines.push('TOWN MAP EXTRACT — COURIER\'S ROUTE CARD')
  lines.push(`Pip, courier · ${GRID_COLS} × ${GRID_ROWS} characters · ${cell}m per column, ${row}m per row`)
  lines.push(RULE)
  lines.push(`  north  ·  ${WORLD_HALF}m to each edge  ·  @ fountain  = paving  ~ canal  + bridge  o plaza  * duel ring  # wall`)
  lines.push(`  +${'-'.repeat(GRID_COLS)}+`)
  for (const cells of grid) lines.push(`  |${cells.join('')}|`)
  lines.push(`  +${'-'.repeat(GRID_COLS)}+`)
  lines.push('  south')
  lines.push('')
  lines.push('KEYED BUILDINGS')
  buildingSpecs.forEach((spec, index) => {
    const box = footprintOf(spec)
    lines.push(`  ${letters[index] ?? '#'}  ${pad(spec.name, 22)}${pad(at(spec.x, spec.z), 12)}` +
      (box ? `${box.halfW * 2}m × ${box.halfD * 2}m` : 'plan only'))
  })
  lines.push('')
  lines.push('CROSSINGS AND EDGES')
  lines.push(`  Canal water   ${canal.waterWidth}m wide at x=${canal.x}, running ${canal.waterLength}m`)
  lines.push(`  Bridges       z=${townLayout.bridges.join(', z=')}`)
  lines.push(`  Plaza         ${townPlaza.r}m at ${at(townPlaza.x, townPlaza.z)}`)
  lines.push(`  Safe ground   ${SAFE_ZONE.r}m at ${at(SAFE_ZONE.x, SAFE_ZONE.z)}`)
  lines.push(`  Duel rings    ${DUEL_RINGS.map(ring => `${ring.name} ${at(ring.x, ring.z)} r${ring.radius}`).join(' · ')}`)
  lines.push('')
  lines.push(...wrap(
    'Drawn from the collision rectangles the server checks movement against, not from a picture of ' +
    'the town, which is why the walls on this card are the walls you cannot walk through.',
  ))
  return lines.join('\n')
}

/* --------------------------------------------------------- holdings statement */

/**
 * Vellum's statement of what an account actually holds.
 *
 * Read off the one authoritative ledger: balance, where every credit came from
 * and whether it could ever be redeemed, the last movements, and the result of
 * re-summing the whole ledger. The redemption line says no, because the answer
 * is no.
 */
export function holdingsStatement(userId: string): string {
  const gold = goldSnapshot(userId)
  const breakdown = provenanceBreakdown(userId)
  const entries = entriesForUser(userId, 12)
  const report = conservationReport()

  const lines: string[] = []
  lines.push('STATEMENT OF HOLDINGS')
  lines.push('Vellum, merchant · Market Hall (72, 0) · weighed on the house scales')
  lines.push(RULE)
  lines.push(`  Available     ${gold.available} gold`)
  lines.push(`  Reserved      ${gold.reserved} gold`)
  lines.push(`  Total         ${gold.total} gold`)
  lines.push(`  Redeemable    ${gold.redeemable} gold`)
  lines.push('')
  lines.push('WHERE IT CAME FROM')
  if (breakdown.length === 0) lines.push('  Nothing has ever been credited to this account.')
  for (const row of breakdown) {
    lines.push(`  ${pad(row.provenance, 16)}${pad(`${row.amount} gold`, 14)}${row.redeemable ? 'redeemable origin' : 'not redeemable'}`)
    lines.push(...wrap(row.note, 58, '    '))
  }
  lines.push('')
  lines.push('LAST MOVEMENTS')
  if (entries.length === 0) lines.push('  No entries.')
  for (const entry of entries) {
    const side = entry.account.endsWith(':gold:reserved') ? 'reserved' : 'available'
    lines.push(`  ${pad(new Date(entry.atMs).toISOString().slice(0, 19).replace('T', ' '), 21)}${pad(`${entry.amount} gold`, 10)}${pad(side, 11)}${entry.provenance}`)
    lines.push(...wrap(entry.note, 58, '    '))
  }
  lines.push('')
  lines.push('THE HOUSE CHECK')
  lines.push(`  Every balance in the ledger summed: ${report.balanceSum}`)
  lines.push(`  Every entry in the ledger summed:   ${report.entrySum}`)
  lines.push(`  Half-written transfers:             ${report.unbalancedTransfers.length}`)
  lines.push(`  Accounts drifted from history:      ${report.driftedAccounts.length}`)
  lines.push(`  Verdict: ${report.ok ? 'the ledger balances.' : 'THE LEDGER DOES NOT BALANCE.'}`)
  lines.push('')
  lines.push(...wrap(
    'Gold is game currency. There is no payout path in this world and this statement is not a claim ' +
    'on anything outside it: a redeemable origin means the amount was earned against a server-issued ' +
    'token, not that it can be withdrawn.',
  ))
  return lines.join('\n')
}

/* ------------------------------------------------------------- duel record */

export const duelCount = (playerId: string) => journalFor(playerId, 100).length

/**
 * Bronze's attested duel record, straight out of the PvP journal.
 *
 * The journal is the server's own record of settled duels, so the tallies here
 * are re-counted from it rather than kept anywhere. A player with no duels is
 * refused before any gold moves; there is nothing to attest and charging for a
 * blank page would be the same trick this replaced.
 */
export function duelRecord(playerId: string, displayName: string): string {
  const entries = journalFor(playerId, 100)
  const tally: Record<string, number> = {}
  let gained = 0
  let given = 0
  let staked = 0
  for (const entry of entries) {
    staked += entry.stake
    if (entry.goldDelta > 0) gained += entry.goldDelta
    if (entry.goldDelta < 0) given += -entry.goldDelta
    tally[entry.kind] = (tally[entry.kind] ?? 0) + 1
  }
  const count = (kind: string) => tally[kind] ?? 0

  const lines: string[] = []
  lines.push('DUEL RECORD, ATTESTED')
  lines.push('Bronze, blacksmith · Workshop (50, 18) · copied from the town\'s own journal')
  lines.push(RULE)
  lines.push(`  Wayfinder     ${displayName}`)
  lines.push(`  Duels settled ${entries.length}`)
  lines.push(`  Record        ${count('victory')} won · ${count('defeat')} lost · ${count('draw')} drawn · ` +
    `${count('forfeit')} forfeit · ${count('refund') + count('void')} void`)
  lines.push(`  Gold staked   ${staked}`)
  lines.push(`  Gold taken    ${gained}`)
  lines.push(`  Gold given    ${given}`)
  lines.push(`  Net           ${gained - given >= 0 ? '+' : ''}${gained - given} gold`)
  lines.push('')
  lines.push('EVERY DUEL, NEWEST FIRST')
  lines.push(`  ${pad('WHEN', 21)}${pad('AGAINST', 20)}${pad('RESULT', 8)}${pad('STAKE', 7)}${pad('DELTA', 8)}WHY`)
  for (const entry of entries) {
    lines.push(
      `  ${pad(new Date(entry.atMs).toISOString().slice(0, 19).replace('T', ' '), 21)}` +
      `${pad(entry.opponentName, 20)}${pad(entry.kind, 8)}${pad(String(entry.stake), 7)}` +
      `${pad(`${entry.goldDelta > 0 ? '+' : ''}${entry.goldDelta}`, 8)}${entry.reason}`,
    )
  }
  lines.push('')
  lines.push('WHERE THEY ARE FOUGHT')
  for (const ring of DUEL_RINGS) lines.push(`  ${pad(ring.name, 16)}${at(ring.x, ring.z)} · radius ${metres(ring.radius)}`)
  lines.push('')
  lines.push(...wrap(
    'Copied from the settled-duel journal the server writes when a duel ends, and from the same escrow ' +
    'the stakes moved through. Duel gold is real game gold and is not redeemable; winning transfers a ' +
    'balance between players rather than creating one.',
  ))
  return lines.join('\n')
}
