/* ------------------------------------------------------------------ *
 * Server authority over hunt rewards.
 *
 * WHAT THIS DOES AND DOES NOT PROVE — read this before describing it.
 *
 * The wildlife simulation runs in the browser. Moving it to the server is
 * a large piece of work (`src/wildlife.ts` is ~1,500 lines of Three.js
 * scene code plus AI, and `src/battle/engine.ts` drives the abilities), and
 * it is not what has been done here. What has been done is a
 * server-validated kill claim with per-animal single-use tokens:
 *
 *   - the SERVER decides how many animals a hunt contains and which
 *     species each one is, from its own table, before the client sees
 *     anything;
 *   - the SERVER decides what each is worth. The reward is read from
 *     `SPECIES_REWARD`, never from the request;
 *   - each animal gets one token. Claiming it is a single conditional
 *     UPDATE, so a token pays exactly once no matter how many times it is
 *     submitted or how concurrently;
 *   - claims are rate-limited per session and capped per session, so the
 *     total a client can extract from one hunt is bounded by the server
 *     before the hunt starts.
 *
 * What this does NOT prove is that a fight happened. A client that holds a
 * valid token can claim it without fighting the animal. The guarantees are
 * therefore: the reward amount is authoritative, the species is
 * authoritative, each reward is granted at most once, and the total per
 * session is bounded. That is strictly stronger than the previous
 * situation, where the browser decided the balance outright — and it is
 * weaker than a server-side simulation. Both halves of that sentence
 * belong in any description of this feature.
 * ------------------------------------------------------------------ */

import { randomBytes, randomInt } from 'node:crypto'
import { coreDb, immediateTransaction } from '../store'
import { creditGold, debitGold, goldSnapshot } from '../money/gold'

const db = coreDb

/**
 * Reward per species, in gold base units.
 *
 * Duplicated from `src/wildlife.ts`'s `speciesSpecs` rather than imported,
 * because that module pulls in Three.js and this process must stay free of it.
 * `scripts/test-ledger.ts` asserts the two tables agree, so the duplication
 * cannot drift silently.
 */
export const SPECIES_REWARD: Record<string, bigint> = {
  CHICKEN: 2n,
  REINDEER: 12n,
  BEAR: 45n,
  WOLF: 58n,
  BOAR: 95n,
}

export type SpeciesId = keyof typeof SPECIES_REWARD

/**
 * What each region actually contains, and the level needed to hunt it.
 *
 * The ids and the counts are `wildRegions` from `src/wildlife.ts`, copied for the
 * same reason `SPECIES_REWARD` is: importing that module would pull Three.js into
 * the server. `scripts/test-ledger.ts` asserts both tables against the world, so a
 * region renamed there fails a test rather than silently refusing every hunt.
 */
const REGION_ROSTER: Record<string, { minLevel: number; counts: Partial<Record<SpeciesId, number>> }> = {
  wildwood: { minLevel: 1, counts: { BEAR: 4, REINDEER: 5, CHICKEN: 1 } },
  hollow: { minLevel: 1, counts: { BEAR: 1, REINDEER: 2, CHICKEN: 2 } },
  northmeadow: { minLevel: 1, counts: { REINDEER: 2, CHICKEN: 4 } },
  eastmeadow: { minLevel: 1, counts: { REINDEER: 1, CHICKEN: 3 } },
  southfields: { minLevel: 1, counts: { REINDEER: 1, CHICKEN: 3 } },
  westoutskirts: { minLevel: 1, counts: { CHICKEN: 2 } },
  brasswood: { minLevel: 8, counts: { WOLF: 4, BOAR: 3 } },
}

/**
 * How many times over a session may be paid for clearing a region.
 *
 * The roster is what the region holds, multiplied by this. Wildlife respawns, so a
 * roster of exactly one clear would stop paying a legitimate player after a few
 * minutes; four clears per hour-long session is the rate limit instead, and it is
 * a real ceiling rather than a formality — a scripted client cannot exceed it.
 */
export const HUNT_ROSTER_ROUNDS = 4

/** The roster a region mints. The ceiling on what one session can ever pay out. */
export function rosterFor(region: string): SpeciesId[] {
  const roster = REGION_ROSTER[region]
  if (!roster) return []
  const animals: SpeciesId[] = []
  for (const [species, count] of Object.entries(roster.counts)) {
    for (let index = 0; index < (count ?? 0) * HUNT_ROSTER_ROUNDS; index += 1) animals.push(species as SpeciesId)
  }
  return animals
}

/** Exposed so the route and the tests can state a session's ceiling. */
export const rosterSize = (region: string) => rosterFor(region).length

/** How long a hunt's tokens stay claimable. */
export const HUNT_TTL_MS = 60 * 60 * 1000

/**
 * Minimum gap between two claims in one hunt.
 *
 * Not a security boundary — a patient client still gets the roster — but it stops
 * a single request burst from draining every token at once, which is the shape a
 * scripted client takes.
 */
export const MIN_CLAIM_GAP_MS = 400

/** Percentage of carried gold forfeited on death. Integer, so the arithmetic stays exact. */
export const DEATH_LOSS_PERCENT = 40n

export const isSpecies = (value: unknown): value is SpeciesId =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SPECIES_REWARD, value)

export const isRegion = (value: unknown): value is string =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGION_ROSTER, value)

/* ------------------------------------------------------------------ rows */

const insertHunt = db.raw.prepare(`
  insert into hunt_sessions (hunt_id, user_id, player_id, region, level, status, claimed_count, death_count, last_claim_ms, created_at_ms, expires_at_ms, closed_at_ms)
  values (@hunt_id, @user_id, @player_id, @region, @level, 'open', 0, 0, 0, @now, @expires_at_ms, null)
`)

type HuntRow = {
  hunt_id: string
  user_id: string
  player_id: string
  region: string
  level: number
  status: string
  claimed_count: number
  death_count: number
  last_claim_ms: number
  expires_at_ms: number
}

const selectHunt = db.raw.prepare<[string], HuntRow>('select * from hunt_sessions where hunt_id = ?')

const insertToken = db.raw.prepare(`
  insert into hunt_kill_tokens (token_id, hunt_id, user_id, species, reward_gold, issued_at_ms, consumed_at_ms, transfer_id)
  values (@token_id, @hunt_id, @user_id, @species, @reward_gold, @now, null, null)
`)

type TokenRow = { token_id: string; hunt_id: string; user_id: string; species: string; reward_gold: string; consumed_at_ms: number | null }

const selectToken = db.raw.prepare<[string], TokenRow>('select * from hunt_kill_tokens where token_id = ?')

/**
 * The single-use claim.
 *
 * Every condition that matters is in the WHERE clause: the token belongs to this
 * hunt, this hunt belongs to this account, the token has not been consumed, the
 * hunt is open, it has not expired, and the rate gap has elapsed. Two concurrent
 * submissions of one token cannot both see `consumed_at_ms is null`, so exactly
 * one of them earns the reward.
 */
const consumeToken = db.raw.prepare(`
  update hunt_kill_tokens
     set consumed_at_ms = @now
   where token_id = @token_id
     and hunt_id = @hunt_id
     and user_id = @user_id
     and consumed_at_ms is null
     and exists (
       select 1 from hunt_sessions
        where hunt_id = @hunt_id
          and user_id = @user_id
          and status = 'open'
          and expires_at_ms > @now
          and last_claim_ms <= @gate
     )
`)

const attachTransfer = db.raw.prepare('update hunt_kill_tokens set transfer_id = @transfer_id where token_id = @token_id')

const bumpHuntClaim = db.raw.prepare(`
  update hunt_sessions
     set claimed_count = claimed_count + 1,
         last_claim_ms = @now
   where hunt_id = @hunt_id
`)

const closeHuntRow = db.raw.prepare(
  "update hunt_sessions set status = 'closed', closed_at_ms = @now where hunt_id = @hunt_id and user_id = @user_id and status = 'open'",
)

const selectOpenTokens = db.raw.prepare<[string], { token_id: string; species: string; reward_gold: string }>(
  'select token_id, species, reward_gold from hunt_kill_tokens where hunt_id = ? and consumed_at_ms is null order by issued_at_ms asc',
)

const insertDeath = db.raw.prepare(`
  insert into hunt_deaths (death_id, hunt_id, user_id, client_ref, forfeit_gold, transfer_id, created_at_ms)
  values (@death_id, @hunt_id, @user_id, @client_ref, @forfeit_gold, null, @now)
  on conflict (hunt_id, client_ref) do nothing
`)

const selectDeath = db.raw.prepare<[string, string], { death_id: string; forfeit_gold: string; transfer_id: string | null }>(
  'select death_id, forfeit_gold, transfer_id from hunt_deaths where hunt_id = ? and client_ref = ?',
)

const attachDeathTransfer = db.raw.prepare(
  'update hunt_deaths set transfer_id = @transfer_id, forfeit_gold = @forfeit_gold where death_id = @death_id',
)

const bumpDeaths = db.raw.prepare('update hunt_sessions set death_count = death_count + 1 where hunt_id = @hunt_id')

/* ------------------------------------------------------------------ open */

export type HuntToken = { tokenId: string; species: SpeciesId; rewardGold: string }

export type OpenedHunt = {
  huntId: string
  region: string
  level: number
  expiresAtMs: number
  tokens: HuntToken[]
}

/**
 * Fisher-Yates with `randomInt`, which is OS-CSPRNG-backed rather than
 * `Math.random`. The order is not secret, but the roster decides what a session is
 * worth and there is no reason to make any part of that predictable.
 */
function shuffled<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    ;[items[index], items[swap]] = [items[swap]!, items[index]!]
  }
  return items
}

/**
 * Opens a hunt and mints its roster.
 *
 * The roster is the region's own population, from the server's copy of the world
 * table, so a session can never be paid for more animals than the region holds
 * times `HUNT_ROSTER_ROUNDS`.
 */
export function openHunt(input: {
  userId: string
  playerId: string
  region: unknown
  level: unknown
  now?: number
}): { ok: true; hunt: OpenedHunt } | { ok: false; reason: string } {
  const now = input.now ?? Date.now()
  if (!isRegion(input.region)) return { ok: false, reason: 'unknown hunting region' }
  const level = typeof input.level === 'number' && Number.isInteger(input.level) ? input.level : 0
  if (level < 1 || level > 15) return { ok: false, reason: 'level must be between 1 and 15' }

  const roster = REGION_ROSTER[input.region]
  if (level < roster.minLevel) {
    return { ok: false, reason: `${input.region} requires level ${roster.minLevel}` }
  }

  const huntId = `h_${randomBytes(16).toString('hex')}`
  const expiresAtMs = now + HUNT_TTL_MS
  const tokens: HuntToken[] = []

  immediateTransaction(db, () => {
    insertHunt.run({
      hunt_id: huntId,
      user_id: input.userId,
      player_id: input.playerId,
      region: input.region as string,
      level,
      now,
      expires_at_ms: expiresAtMs,
    })
    for (const species of shuffled(rosterFor(input.region as string))) {
      const tokenId = `hk_${randomBytes(16).toString('hex')}`
      insertToken.run({
        token_id: tokenId,
        hunt_id: huntId,
        user_id: input.userId,
        species,
        reward_gold: SPECIES_REWARD[species].toString(),
        now,
      })
      tokens.push({ tokenId, species, rewardGold: SPECIES_REWARD[species].toString() })
    }
  })

  return { ok: true, hunt: { huntId, region: input.region as string, level, expiresAtMs, tokens } }
}

export function huntTokens(huntId: string): HuntToken[] {
  return selectOpenTokens.all(huntId).map(row => ({
    tokenId: row.token_id,
    species: row.species as SpeciesId,
    rewardGold: row.reward_gold,
  }))
}

export function readHunt(huntId: string): HuntRow | undefined {
  return selectHunt.get(huntId)
}

export function closeHunt(huntId: string, userId: string, now = Date.now()): boolean {
  return closeHuntRow.run({ hunt_id: huntId, user_id: userId, now }).changes === 1
}

/* ----------------------------------------------------------------- claim */

export type ClaimOutcome =
  | { ok: true; credited: string; species: SpeciesId; idempotent: boolean; balance: string }
  | { ok: false; reason: string; code: 'unknown_token' | 'already_claimed' | 'not_yours' | 'closed' | 'rate_limited' | 'credit_failed' }

/**
 * Claims one kill.
 *
 * Two databases are involved and they cannot share a transaction, so the order is
 * chosen so the failure modes are safe: the token is consumed first, then the
 * credit is posted. A crash between them loses a reward rather than paying one
 * twice, and the ledger credit is itself idempotent on the token id, so a retry
 * after a dropped response completes the pair instead of duplicating it.
 */
export function claimKill(input: {
  userId: string
  huntId: unknown
  tokenId: unknown
  now?: number
}): ClaimOutcome {
  const now = input.now ?? Date.now()
  if (typeof input.huntId !== 'string' || !/^h_[0-9a-f]{32}$/.test(input.huntId)) {
    return { ok: false, code: 'unknown_token', reason: 'huntId is malformed' }
  }
  if (typeof input.tokenId !== 'string' || !/^hk_[0-9a-f]{32}$/.test(input.tokenId)) {
    return { ok: false, code: 'unknown_token', reason: 'tokenId is malformed' }
  }

  const token = selectToken.get(input.tokenId)
  if (!token || token.hunt_id !== input.huntId) return { ok: false, code: 'unknown_token', reason: 'no such kill token' }
  if (token.user_id !== input.userId) return { ok: false, code: 'not_yours', reason: 'that kill token belongs to another account' }

  const hunt = selectHunt.get(input.huntId)
  if (!hunt || hunt.user_id !== input.userId) return { ok: false, code: 'not_yours', reason: 'that hunt belongs to another account' }
  if (hunt.status !== 'open') return { ok: false, code: 'closed', reason: 'that hunt is closed' }
  if (hunt.expires_at_ms <= now) return { ok: false, code: 'closed', reason: 'that hunt has expired' }

  const claimed = immediateTransaction(db, () => {
    const landed = consumeToken.run({
      token_id: input.tokenId as string,
      hunt_id: input.huntId as string,
      user_id: input.userId,
      now,
      gate: now - MIN_CLAIM_GAP_MS,
    })
    if (landed.changes !== 1) return false
    bumpHuntClaim.run({ hunt_id: input.huntId as string, now })
    return true
  })

  if (!claimed) {
    const after = selectToken.get(input.tokenId)
    if (after?.consumed_at_ms !== null) {
      return { ok: false, code: 'already_claimed', reason: 'that kill has already been rewarded' }
    }
    return { ok: false, code: 'rate_limited', reason: 'claims are coming in too fast' }
  }

  const reward = BigInt(token.reward_gold)
  const posted = creditGold({
    userId: input.userId,
    amount: reward,
    provenance: 'hunt_verified',
    idemScope: 'hunt-kill',
    idemKey: input.tokenId as string,
    refType: 'hunt_kill_token',
    refId: input.tokenId as string,
    note: `${token.species} reward, against a server-issued single-use token`,
    now,
  })
  if (!posted.ok) return { ok: false, code: 'credit_failed', reason: posted.reason }
  attachTransfer.run({ token_id: input.tokenId as string, transfer_id: posted.transferId })

  return {
    ok: true,
    credited: reward.toString(),
    species: token.species as SpeciesId,
    idempotent: posted.idempotent,
    balance: goldSnapshot(input.userId).available.toString(),
  }
}

/* ----------------------------------------------------------------- death */

export type DeathOutcome =
  | { ok: true; forfeited: string; idempotent: boolean; balance: string }
  | { ok: false; reason: string }

/**
 * Applies the death forfeit.
 *
 * Idempotent on `(huntId, clientRef)`. The client supplies the reference, which is
 * safe in the only direction that matters: a client that invents a fresh reference
 * forfeits its own gold again, and a client that repeats one is charged once. The
 * amount is computed here from the server's balance, never sent by the client.
 */
export function recordHuntDeath(input: {
  userId: string
  huntId: unknown
  clientRef: unknown
  now?: number
}): DeathOutcome {
  const now = input.now ?? Date.now()
  if (typeof input.huntId !== 'string' || !/^h_[0-9a-f]{32}$/.test(input.huntId)) {
    return { ok: false, reason: 'huntId is malformed' }
  }
  if (typeof input.clientRef !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(input.clientRef)) {
    return { ok: false, reason: 'clientRef must be 8-64 url-safe characters' }
  }
  const hunt = selectHunt.get(input.huntId)
  if (!hunt || hunt.user_id !== input.userId) return { ok: false, reason: 'that hunt belongs to another account' }

  const existing = selectDeath.get(input.huntId, input.clientRef)
  if (existing?.transfer_id) {
    return { ok: true, forfeited: existing.forfeit_gold, idempotent: true, balance: goldSnapshot(input.userId).available.toString() }
  }

  const available = goldSnapshot(input.userId).available
  const forfeit = (available * DEATH_LOSS_PERCENT) / 100n
  const deathId = existing?.death_id ?? `hd_${randomBytes(16).toString('hex')}`

  if (!existing) {
    insertDeath.run({
      death_id: deathId,
      hunt_id: input.huntId,
      user_id: input.userId,
      client_ref: input.clientRef,
      forfeit_gold: forfeit.toString(),
      now,
    })
    bumpDeaths.run({ hunt_id: input.huntId })
  }

  if (forfeit === 0n) {
    attachDeathTransfer.run({ death_id: deathId, transfer_id: 'none', forfeit_gold: '0' })
    return { ok: true, forfeited: '0', idempotent: false, balance: available.toString() }
  }

  const posted = debitGold({
    userId: input.userId,
    amount: forfeit,
    idemScope: 'hunt-death',
    idemKey: deathId,
    refType: 'hunt_death',
    refId: deathId,
    note: `Death forfeit: ${DEATH_LOSS_PERCENT}% of carried gold`,
    now,
  })
  if (!posted.ok) return { ok: false, reason: posted.reason }
  attachDeathTransfer.run({ death_id: deathId, transfer_id: posted.transferId, forfeit_gold: forfeit.toString() })
  return {
    ok: true,
    forfeited: forfeit.toString(),
    idempotent: posted.idempotent,
    balance: goldSnapshot(input.userId).available.toString(),
  }
}
