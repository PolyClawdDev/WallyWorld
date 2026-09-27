/* ------------------------------------------------------------------ *
 * Keeps the persisted profile schema honest.
 *
 * `src/shared/profile.ts` has to restate the character and wardrobe value
 * sets, because the server validates them and must not import Three.js.
 * Restating them creates a drift risk: add a new hat to `characters.ts`
 * and the server would start rejecting valid saves.
 *
 * The assertions below make that a compile error instead of a runtime
 * surprise. They are types only and emit nothing.
 * ------------------------------------------------------------------ */

import type { MothStyle, WizardId } from '../characters'
import type { Profile, ProfileCharacter, ProfileStyle } from '../shared/profile'

/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// If either of these stops compiling, src/shared/profile.ts has drifted from
// src/characters.ts and the server is validating against a stale list.
export const characterSetsMatch: Exact<ProfileCharacter, WizardId> = true
export const styleSetsMatch: Exact<ProfileStyle, MothStyle> = true

/** Builds the record to persist from the game's live state. */
export function toProfile(input: { character: WizardId; style: MothStyle; playerName: string; gold: number }): Profile {
  return {
    character: input.character,
    style: input.style,
    playerName: input.playerName,
    // Gold is clamped to a whole, non-negative number here so the request cannot
    // be rejected for a shape the UI could have fixed. It remains client-asserted.
    gold: Math.max(0, Math.trunc(input.gold)),
  }
}
