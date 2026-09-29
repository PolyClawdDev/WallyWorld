/* ------------------------------------------------------------------ *
 * A budget on display-name CHANGES.
 *
 * WHY
 *   A blocklist that can be probed a thousand times a minute is a puzzle
 *   with a solution. Rate limiting does not make the filter correct, but it
 *   turns "try spellings until one lands" from a script into an afternoon,
 *   and it is four lines on top of the counter the server already has.
 *
 * WHAT IS COUNTED
 *   Only an actual change of name, and only when it is accepted or
 *   rejected on its merits — never a reconnect that re-sends the name the
 *   account already has. The PvP client re-sends its `hello` frame whenever
 *   the loadout changes, and a player switching hats must not spend name
 *   budget doing it.
 *
 * WHAT IT IS KEYED ON
 *   The account, not the address. Keying on IP would let one household
 *   share a budget and one attacker rotate out of it; the account is the
 *   thing whose name is being changed, and minting a new account costs a
 *   sign-in, which has its own tighter budget already.
 *
 * Deliberately generous. Eight changes in ten minutes is far more than
 * anyone naming a character actually needs — the entry screen saves on a
 * button press, not per keystroke — and far less than a search needs.
 * ------------------------------------------------------------------ */

import { overBudget, type Budget } from '../net'

export const NAME_CHANGE_BUDGET: Budget = { windowMs: 10 * 60_000, max: 8 }

/**
 * True when this account may change its name right now.
 *
 * Consumes one unit of budget, so call it once per attempt and only when the
 * name genuinely differs from the stored one.
 */
export function nameChangeAllowed(accountKey: string, now = Date.now()): boolean {
  return !overBudget(`name:${accountKey}`, NAME_CHANGE_BUDGET, now)
}
