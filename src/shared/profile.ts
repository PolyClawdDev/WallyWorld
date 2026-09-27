/* ------------------------------------------------------------------ *
 * The persisted player record, and its validator.
 *
 * Shared by client and server. It deliberately does not import from
 * `src/characters.ts`, because that module pulls in Three.js and the
 * server must stay free of it; `src/solana/profileSync.ts` carries a
 * compile-time assertion that these value sets have not drifted from the
 * real character types.
 *
 * `gold` is stored but is NOT authoritative. The game simulation runs
 * entirely in the browser, so a client can claim any gold total it likes.
 * This record is convenience state for resuming on another device, and is
 * explicitly not a balance that anything of value may be paid against.
 * See the payout section of the README.
 * ------------------------------------------------------------------ */

export const CHARACTERS = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT'] as const
export const HATS = ['crooked', 'moon', 'witch', 'traveler', 'starfold'] as const
export const ROBES = ['midnight', 'plum', 'moss', 'ember', 'slate'] as const
export const FAMILIARS = ['moth', 'firefly', 'rune', 'bat', 'orb'] as const
export const ACCESSORIES = ['lantern', 'satchel', 'talisman', 'book', 'compass'] as const

export type ProfileCharacter = (typeof CHARACTERS)[number]

export type ProfileStyle = {
  hat: (typeof HATS)[number]
  robe: (typeof ROBES)[number]
  familiar: (typeof FAMILIARS)[number]
  accessory: (typeof ACCESSORIES)[number]
}

export type Profile = {
  character: ProfileCharacter
  style: ProfileStyle
  playerName: string
  gold: number
}

export const PLAYER_NAME_MAX = 24

/** Bounds the stored value. Not a security control — gold is client-asserted either way. */
export const GOLD_MAX = 1_000_000_000

export const DEFAULT_PROFILE: Profile = {
  character: 'MOTH',
  style: { hat: 'crooked', robe: 'midnight', familiar: 'moth', accessory: 'lantern' },
  playerName: 'Moth',
  gold: 0,
}

/**
 * Player names are free text, so they are stripped of control characters and
 * clamped. They are rendered as text nodes by React, never as HTML, and are
 * never used in a query string or a SQL fragment.
 */
export function sanitisePlayerName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAYER_NAME_MAX)
}

const inSet = <T extends readonly string[]>(set: T, value: unknown): value is T[number] =>
  typeof value === 'string' && (set as readonly string[]).includes(value)

export type ProfileCheck = { ok: true; profile: Profile } | { ok: false; reason: string }

/** Whitelist validation: unknown values are rejected, never coerced to a default. */
export function validateProfile(input: unknown): ProfileCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'profile must be an object' }
  const body = input as Record<string, unknown>

  if (!inSet(CHARACTERS, body.character)) return { ok: false, reason: 'character is not one of the four archetypes' }

  const style = body.style
  if (!style || typeof style !== 'object' || Array.isArray(style)) return { ok: false, reason: 'style must be an object' }
  const s = style as Record<string, unknown>
  if (!inSet(HATS, s.hat)) return { ok: false, reason: 'style.hat is not a known option' }
  if (!inSet(ROBES, s.robe)) return { ok: false, reason: 'style.robe is not a known option' }
  if (!inSet(FAMILIARS, s.familiar)) return { ok: false, reason: 'style.familiar is not a known option' }
  if (!inSet(ACCESSORIES, s.accessory)) return { ok: false, reason: 'style.accessory is not a known option' }

  const playerName = sanitisePlayerName(body.playerName)
  if (!playerName) return { ok: false, reason: 'playerName must contain at least one printable character' }

  const gold = body.gold
  if (typeof gold !== 'number' || !Number.isInteger(gold) || gold < 0 || gold > GOLD_MAX) {
    return { ok: false, reason: `gold must be an integer between 0 and ${GOLD_MAX}` }
  }

  return {
    ok: true,
    profile: { character: body.character, style: { hat: s.hat, robe: s.robe, familiar: s.familiar, accessory: s.accessory }, playerName, gold },
  }
}
