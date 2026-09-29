/* ------------------------------------------------------------------ *
 * What the town's service NPCs will actually do for gold.
 *
 * Eight NPCs stand in this town. Five of them can do something real,
 * because the thing they would hand over is derivable from data this
 * repository already holds. Three cannot, and say so.
 *
 * The distinction is the whole point of this file. A service is `available`
 * only when there is a deterministic generator behind it that reads real
 * local data; otherwise it is `unavailable` and carries the reason in plain
 * language. Nothing is dressed up: an unavailable service cannot be bought,
 * moves no gold, and is not described as "coming soon", because that is a
 * promise nobody here is in a position to make.
 *
 * Prices are in gold — the one server-owned game balance in
 * `src/server/money/`. There is no second currency, and in particular there
 * are no "credits": that unit never existed anywhere in this system.
 *
 * Prices live here and only here. A purchase request cannot carry a price,
 * and no handler reads one from a body.
 * ------------------------------------------------------------------ */

import { SHIELDED_NOTICE } from '../../townData'
import {
  buildingByName,
  directionsTo,
  duelCount,
  duelRecord,
  holdingsStatement,
  landmarkNames,
  mapExtract,
  townHistoryBrief,
} from './artifacts'

export type ServiceContext = {
  userId: string
  playerId: string
  displayName: string
  request: Record<string, unknown>
}

/** A refusal that happens before any gold moves. */
export type Refusal = { ok: false; code: 'bad_request' | 'nothing_to_do'; reason: string; options?: readonly string[] }

export type Prepared = { ok: true; title: string; render: () => string }

export type Availability =
  | { state: 'available' }
  | { state: 'unavailable'; headline: string; because: readonly string[] }

export type ServiceDefinition = {
  id: string
  npc: string
  keeper: string
  title: string
  /** What the buyer gets, in one honest sentence. */
  what: string
  /** The files the artifact is derived from. Shown to the buyer. */
  derivedFrom: readonly string[]
  artifactKind: string
  priceGold: bigint | null
  availability: Availability
  /**
   * Validates the request and returns the work to do, without doing it.
   *
   * Split from `render` on purpose: everything that can be refused is refused
   * here, before the price is reserved, so a purchase that was never going to
   * work does not touch the ledger at all.
   */
  prepare?: (context: ServiceContext) => Prepared | Refusal
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const SERVICES: readonly ServiceDefinition[] = [
  {
    id: 'archive.town-brief',
    npc: 'LYRA · ARCHIVIST',
    keeper: 'The Archive',
    title: 'Town history brief',
    what: 'A one-page survey of this town: every building with its trade, height, footprint and nearest neighbour, the quarters, the streets, the canal and its crossings, and who keeps a post where.',
    derivedFrom: ['src/townData.ts', 'src/shared/zones.ts'],
    artifactKind: 'town.brief',
    priceGold: 25n,
    availability: { state: 'available' },
    prepare: () => ({ ok: true, title: 'Town history brief', render: () => townHistoryBrief() }),
  },
  {
    id: 'guide.directions',
    npc: 'MIRA · GUIDE',
    keeper: 'the plaza',
    title: 'Directions to a landmark',
    what: 'A measured two-leg walking route from the fountain to any building in town, with the paving it follows, the headings and the distances.',
    derivedFrom: ['src/townData.ts', 'src/shared/zones.ts'],
    artifactKind: 'town.directions',
    priceGold: 8n,
    availability: { state: 'available' },
    prepare: context => {
      const wanted = text(context.request.landmark)
      if (!wanted) {
        return { ok: false, code: 'bad_request', reason: 'Name the landmark you want directions to.', options: landmarkNames() }
      }
      const building = buildingByName(wanted)
      if (!building) {
        return { ok: false, code: 'bad_request', reason: `There is no "${wanted}" in this town.`, options: landmarkNames() }
      }
      return { ok: true, title: `Directions — ${building.name}`, render: () => directionsTo(building) }
    },
  },
  {
    id: 'courier.route-card',
    npc: 'PIP · COURIER',
    keeper: 'Post Office',
    title: "Courier's route card",
    what: 'The town drawn as a character grid from the server\'s own collision rectangles, with every building keyed to its real position, plus the canal crossings, the plaza, the safe ground and the duel rings.',
    derivedFrom: ['src/shared/zones.ts', 'src/townData.ts'],
    artifactKind: 'town.map',
    priceGold: 15n,
    availability: { state: 'available' },
    prepare: () => ({ ok: true, title: "Courier's route card", render: () => mapExtract() }),
  },
  {
    id: 'market.holdings',
    npc: 'VELLUM · MERCHANT',
    keeper: 'Market Hall',
    title: 'Statement of holdings',
    what: 'Your balance read off the ledger: available, reserved, where every credit came from, whether each origin could ever be redeemed, your last movements, and the result of re-summing the whole ledger.',
    derivedFrom: ['src/server/money/ledger.ts', 'src/server/money/provenance.ts'],
    artifactKind: 'account.holdings',
    priceGold: 6n,
    availability: { state: 'available' },
    prepare: context => ({
      ok: true,
      title: 'Statement of holdings',
      render: () => holdingsStatement(context.userId),
    }),
  },
  {
    id: 'arms.duel-record',
    npc: 'BRONZE · BLACKSMITH',
    keeper: 'Workshop',
    title: 'Duel record, attested',
    what: 'Every settled duel on your name, copied out of the PvP journal the server writes when a duel ends, with the stakes and the gold that moved.',
    derivedFrom: ['src/server/pvp/hub.ts'],
    artifactKind: 'pvp.record',
    priceGold: 12n,
    availability: { state: 'available' },
    prepare: context => {
      if (duelCount(context.playerId) === 0) {
        return {
          ok: false,
          code: 'nothing_to_do',
          reason: 'You have no settled duels, so there is nothing to attest. Bronze will not charge you for a blank page.',
        }
      }
      return {
        ok: true,
        title: 'Duel record, attested',
        render: () => duelRecord(context.playerId, context.displayName),
      }
    },
  },

  /* ---------------------------------------------------------------------- *
   * The three that cannot be made real. Each one names the missing piece.
   * ---------------------------------------------------------------------- */

  {
    id: 'alchemy.shielded-note',
    npc: 'SABLE · ALCHEMIST',
    keeper: 'Potion Shop',
    title: 'Shielded courier note',
    what: 'A private payout carried out of this world over Zcash.',
    derivedFrom: ['src/server/providers/zcashWallet.ts', 'src/server/providers/oneclick.ts'],
    artifactKind: 'zec.payout',
    priceGold: null,
    availability: {
      state: 'unavailable',
      headline: SHIELDED_NOTICE.headline,
      because: [
        ...SHIELDED_NOTICE.lines,
        'Nothing in this repository can sign a Zcash transaction, and a payee',
        'address in an environment variable is not an integration. This desk',
        'stays shut until a signer exists.',
      ],
    },
  },
  {
    id: 'orrery.almanac',
    npc: 'ASTRA · ORRERY KEEPER',
    keeper: 'Observatory',
    title: 'Almanac of the sky',
    what: 'Risings, settings and seasons for this world.',
    derivedFrom: [],
    artifactKind: 'sky.almanac',
    priceGold: null,
    availability: {
      state: 'unavailable',
      headline: 'NO SKY TO READ',
      because: [
        'This world has no clock. There is no day, no season and no orbit',
        'simulated anywhere in it — even the dial on the Town Hall is built',
        'with its hands stopped. An almanac would have to be invented rather',
        'than derived, so Astra sells nothing.',
      ],
    },
  },
  {
    id: 'inn.lodging',
    npc: 'NELL · INNKEEPER',
    keeper: 'Hearth Inn',
    title: 'Board and a room',
    what: 'Lodging at the Hearth Inn, and rest that means something.',
    derivedFrom: [],
    artifactKind: 'inn.lodging',
    priceGold: null,
    availability: {
      state: 'unavailable',
      headline: 'NOTHING TO SELL YET',
      because: [
        'There is no rest, fatigue or lodging state anywhere in this world, so',
        'a room would change nothing and the receipt would be the only thing',
        'you received. Nell would rather say so than take the gold.',
      ],
    },
  },
]

const byId = new Map(SERVICES.map(service => [service.id, service]))

export const serviceById = (id: unknown): ServiceDefinition | null =>
  (typeof id === 'string' ? byId.get(id) ?? null : null)

/** Every service, with its price, for the catalogue endpoint. */
export const catalogueView = () =>
  SERVICES.map(service => ({
    id: service.id,
    npc: service.npc,
    keeper: service.keeper,
    title: service.title,
    what: service.what,
    derivedFrom: service.derivedFrom,
    artifactKind: service.artifactKind,
    priceGold: service.priceGold === null ? null : service.priceGold.toString(),
    availability: service.availability,
    /** Only `guide.directions` takes an argument today; the UI reads this rather than guessing. */
    landmarks: service.id === 'guide.directions' ? landmarkNames() : undefined,
  }))
