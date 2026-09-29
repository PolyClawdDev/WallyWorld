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
 *
 * NOTHING IMPORTS THIS FILE, AND THAT IS NOT A MISTAKE. `toProfile` used
 * to live here, called by the "save this character to your wallet" block
 * in the wallet panel; that block needed a Phantom sign-in session and
 * went when Phantom did. The assertions did not go with it, because the
 * drift they catch is between `characters.ts` and the *server's*
 * validator, which is still live on `PUT /api/profile`. `tsc -b` compiles
 * every file under `src/` whether or not anything imports it, so the guard
 * still fires; Vite tree-shakes the two booleans out of the bundle.
 * ------------------------------------------------------------------ */

import type { MothStyle, WizardId } from '../characters'
import type { ProfileCharacter, ProfileStyle } from '../shared/profile'

/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// If either of these stops compiling, src/shared/profile.ts has drifted from
// src/characters.ts and the server is validating against a stale list.
export const characterSetsMatch: Exact<ProfileCharacter, WizardId> = true
export const styleSetsMatch: Exact<ProfileStyle, MothStyle> = true
