import { createHash, randomBytes } from 'node:crypto'
import { CHARACTERS, DEFAULT_PROFILE, sanitisePlayerName, type ProfileStyle } from '../../shared/profile'
import { type PublicLoadout, type WizardId } from '../../shared/pvp'
import { resolveUserForPrincipal } from '../identity/users'
import { ensureGoldAccounts, grantStartingGold } from '../money/gold'
import { nameChangeAllowed } from '../moderation/nameRate'
import { publicDisplayName, screenDisplayName } from '../moderation/names'
import { db } from './schema'

export type AccountRow = {
  player_id: string
  account_id: string
  display_name: string
  character: WizardId
  style_json: string
  level: number
  ranks_json: string
  incoming_off: number
}

const selectByAccount = db.prepare<[string], AccountRow>('select * from pvp_accounts where account_id = ?')
const selectByPlayer = db.prepare<[string], AccountRow>('select * from pvp_accounts where player_id = ?')

/**
 * The single choke point between the accounts table and everything that
 * shows a name.
 *
 * `selectByAccount` and `selectByPlayer` are private to this module, so every
 * presence broadcast, player card, challenge and journal entry in the server
 * reads its `display_name` through here. Screening on the way OUT rather than
 * only on the way in is what makes the guarantee hold for rows that were
 * written before this code existed, or by a route nobody has thought of yet:
 * a blocked name in the database is still never broadcast.
 *
 * The row object is a fresh one per query, so rewriting the field in place is
 * safe and keeps every caller unchanged.
 */
function screened(row: AccountRow | undefined): AccountRow | undefined {
  if (row) row.display_name = publicDisplayName(row.display_name)
  return row
}

const fetchByAccount = (userId: string) => screened(selectByAccount.get(userId))
const fetchByPlayer = (playerId: string) => screened(selectByPlayer.get(playerId))

const insertAccount = db.prepare(`
  insert into pvp_accounts (player_id, account_id, display_name, character, style_json, level, ranks_json, incoming_off, created_at_ms, updated_at_ms)
  values (@player_id, @account_id, @display_name, @character, @style_json, @level, @ranks_json, 0, @now, @now)
`)

/**
 * Adopts a row that was keyed on the raw session principal before the
 * `users` table existed, so an existing development database keeps its
 * character and its player id instead of silently gaining a second one.
 */
const adoptLegacyAccount = db.prepare(
  'update pvp_accounts set account_id = @user_id, updated_at_ms = @now where account_id = @principal_id',
)

const updateLoadout = db.prepare(`
  update pvp_accounts
     set display_name = @display_name,
         character = @character,
         style_json = @style_json,
         level = @level,
         ranks_json = @ranks_json,
         updated_at_ms = @now
   where player_id = @player_id
`)

const updateIncoming = db.prepare('update pvp_accounts set incoming_off = @off, updated_at_ms = @now where player_id = @player_id')

export function newId(prefix: 'p' | 'c' | 'd' | 'e' | 'j' | 's'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

/**
 * The player record for whoever this session belongs to.
 *
 * `accountId` is the session principal — a wallet address, a hashed guest key, or
 * a dev label. It is resolved to a canonical `user_id` first, and the player row
 * is keyed on that. This is why linking a wallet to a guest account does not
 * create a second player: both principals resolve to the same user, so both find
 * the same row.
 *
 * The public `player_id` is a random token, not a hash of the wallet.
 */
export function ensureAccount(accountId: string, now = Date.now()): AccountRow {
  const { userId } = resolveUserForPrincipal(accountId, now)
  const existing = fetchByAccount(userId)
  if (existing) {
    ensureGoldAccounts(userId, now)
    return existing
  }

  const open = db.transaction(() => {
    if (adoptLegacyAccount.run({ principal_id: accountId, user_id: userId, now }).changes === 1) {
      return fetchByAccount(userId)!
    }
    insertAccount.run({
      player_id: newId('p'),
      account_id: userId,
      display_name: DEFAULT_PROFILE.playerName,
      character: DEFAULT_PROFILE.character,
      style_json: JSON.stringify(DEFAULT_PROFILE.style),
      level: 1,
      ranks_json: JSON.stringify({ Q: 0, W: 0, E: 0, R: 0 }),
      now,
    })
    return fetchByAccount(userId)!
  })
  const row = open()
  // Outside the core-database transaction on purpose: the grant is a write to the
  // *financial* database, and the two cannot share a transaction. It is
  // idempotent on the user id, so a crash between the two leaves a player with an
  // account and no grant, and the next call completes it.
  ensureGoldAccounts(userId, now)
  grantStartingGold(userId, now)
  return row
}

export function accountByPlayer(playerId: string): AccountRow | undefined {
  return fetchByPlayer(playerId)
}

/** Looks up by session principal, resolving through the identity layer. */
export function accountByWallet(accountId: string): AccountRow | undefined {
  const { userId } = resolveUserForPrincipal(accountId)
  return fetchByAccount(userId)
}

/** The canonical account a public player id belongs to. Used by the gold adapter. */
export function userIdForPlayer(playerId: string): string | null {
  return fetchByPlayer(playerId)?.account_id ?? null
}

/** The public player id for a canonical account, if the player record exists. */
export function playerIdForUser(userId: string): string | null {
  return fetchByAccount(userId)?.player_id ?? null
}

export function parseLoadout(input: unknown): PublicLoadout | null {
  if (!input || typeof input !== 'object') return null
  const body = input as Record<string, unknown>
  if (typeof body.character !== 'string' || !(CHARACTERS as readonly string[]).includes(body.character)) return null
  const style = body.style
  if (!style || typeof style !== 'object') return null
  const ranks = body.ranks
  if (!ranks || typeof ranks !== 'object') return null
  const r = ranks as Record<string, unknown>
  const clampRank = (value: unknown) => Math.max(0, Math.min(4, Math.round(Number(value) || 0)))
  const level = Math.max(1, Math.min(15, Math.round(Number(body.level) || 1)))
  return {
    character: body.character as WizardId,
    style: style as ProfileStyle,
    level,
    ranks: { Q: clampRank(r.Q), W: clampRank(r.W), E: clampRank(r.E), R: Math.min(3, clampRank(r.R)) },
  }
}

/**
 * Why a blocked name here does not close the socket.
 *
 * This is the presence path, not a form submission. The frame that carries
 * the name also carries the character and the loadout, and it is re-sent on
 * reconnect and on every cosmetic change, so refusing the whole frame would
 * either desync an honest client's appearance or hand an attacker a trivial
 * way to make their own client unusable and blame the game. Instead the
 * loadout is saved and the name is simply not: the account keeps the name it
 * already had, which is the server deciding, and the caller is told so it can
 * pass a notice back without saying which rule fired.
 */
export type NameOutcome = 'stored' | 'blocked' | 'rate_limited' | 'unchanged'

export type SaveLoadoutResult = { name: string; nameOutcome: NameOutcome }

export function saveLoadout(playerId: string, displayName: string, loadout: PublicLoadout, now = Date.now()): SaveLoadoutResult {
  // The existing sanitisation is untouched and still runs first: control
  // characters, whitespace collapsing and the length clamp are about what a
  // name may *contain*, and moderation is about what it may *say*.
  const requested = sanitisePlayerName(displayName) || DEFAULT_PROFILE.playerName
  const current = selectByPlayer.get(playerId)
  const held = current ? publicDisplayName(current.display_name) : DEFAULT_PROFILE.playerName

  const allowed = screenDisplayName(requested).ok
  const isChange = requested !== current?.display_name

  let name: string
  let nameOutcome: NameOutcome
  if (!isChange && allowed) {
    // A reconnect or a cosmetic change re-sending the name the account already
    // has. Costs no budget, or a player swapping hats would run out.
    name = requested
    nameOutcome = 'unchanged'
  } else if (isChange && !nameChangeAllowed(playerId, now)) {
    // Budget is spent before the verdict is known, so a rejected attempt costs
    // the same as an accepted one. Charging only for successes would make the
    // filter free to probe, which is the one thing the budget exists to stop.
    name = held
    nameOutcome = 'rate_limited'
  } else if (!allowed) {
    // `held` is already screened, so a row that predates moderation is cleaned
    // up by the next frame its owner sends rather than sitting there.
    name = held
    nameOutcome = 'blocked'
  } else {
    name = requested
    nameOutcome = 'stored'
  }

  updateLoadout.run({
    player_id: playerId,
    display_name: name,
    character: loadout.character,
    style_json: JSON.stringify(loadout.style),
    level: loadout.level,
    ranks_json: JSON.stringify(loadout.ranks),
    now,
  })
  return { name, nameOutcome }
}

export function setIncomingDisabled(playerId: string, disabled: boolean, now = Date.now()) {
  updateIncoming.run({ player_id: playerId, off: disabled ? 1 : 0, now })
}

export function loadoutOf(row: AccountRow): PublicLoadout {
  let style = DEFAULT_PROFILE.style
  try {
    style = JSON.parse(row.style_json) as ProfileStyle
  } catch {
    /* default */
  }
  let ranks = { Q: 0, W: 0, E: 0, R: 0 }
  try {
    ranks = JSON.parse(row.ranks_json) as typeof ranks
  } catch {
    /* default */
  }
  return { character: row.character, style, level: row.level, ranks }
}

/** Fingerprint used only in tests to prove we never emit the wallet. */
export function accountFingerprint(accountId: string) {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}
