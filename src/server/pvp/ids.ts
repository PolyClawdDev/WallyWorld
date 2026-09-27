import { createHash, randomBytes } from 'node:crypto'
import { CHARACTERS, DEFAULT_PROFILE, sanitisePlayerName, type ProfileStyle } from '../../shared/profile'
import { STARTING_GAME_GOLD, type PublicLoadout, type WizardId } from '../../shared/pvp'
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

const insertAccount = db.prepare(`
  insert into pvp_accounts (player_id, account_id, display_name, character, style_json, level, ranks_json, incoming_off, created_at_ms, updated_at_ms)
  values (@player_id, @account_id, @display_name, @character, @style_json, @level, @ranks_json, 0, @now, @now)
`)

const insertGold = db.prepare(`
  insert into game_gold (player_id, available, reserved, wins, losses, draws, updated_at_ms)
  values (@player_id, @available, 0, 0, 0, 0, @now)
`)

const insertLedger = db.prepare(`
  insert or ignore into game_gold_ledger (id, player_id, kind, amount, available_after, reserved_after, ref_type, ref_id, note, created_at_ms)
  values (@id, @player_id, @kind, @amount, @available_after, @reserved_after, @ref_type, @ref_id, @note, @now)
`)

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

/** Public player id is a random token, not a hash of the wallet. */
export function ensureAccount(accountId: string, now = Date.now()): AccountRow {
  const existing = selectByAccount.get(accountId)
  if (existing) return existing
  const playerId = newId('p')
  const open = db.transaction(() => {
    insertAccount.run({
      player_id: playerId,
      account_id: accountId,
      display_name: DEFAULT_PROFILE.playerName,
      character: DEFAULT_PROFILE.character,
      style_json: JSON.stringify(DEFAULT_PROFILE.style),
      level: 1,
      ranks_json: JSON.stringify({ Q: 0, W: 0, E: 0, R: 0 }),
      now,
    })
    insertGold.run({ player_id: playerId, available: STARTING_GAME_GOLD, now })
    insertLedger.run({
      id: newId('s'),
      player_id: playerId,
      kind: 'stipend',
      amount: STARTING_GAME_GOLD,
      available_after: STARTING_GAME_GOLD,
      reserved_after: 0,
      ref_type: 'account',
      ref_id: playerId,
      note: 'Demo starting game gold. Not SOL.',
      now,
    })
    return selectByAccount.get(accountId)!
  })
  return open()
}

export function accountByPlayer(playerId: string): AccountRow | undefined {
  return selectByPlayer.get(playerId)
}

export function accountByWallet(accountId: string): AccountRow | undefined {
  return selectByAccount.get(accountId)
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

export function saveLoadout(playerId: string, displayName: string, loadout: PublicLoadout, now = Date.now()) {
  const name = sanitisePlayerName(displayName) || DEFAULT_PROFILE.playerName
  updateLoadout.run({
    player_id: playerId,
    display_name: name,
    character: loadout.character,
    style_json: JSON.stringify(loadout.style),
    level: loadout.level,
    ranks_json: JSON.stringify(loadout.ranks),
    now,
  })
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
