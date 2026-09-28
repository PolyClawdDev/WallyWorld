/* ------------------------------------------------------------------ *
 * Where a unit of gold came from, and whether that origin could ever be
 * redeemed for anything.
 *
 * Every credit carries a provenance. Eligibility is derived from it by one
 * table, in one place, with a default of "no": a provenance that is not
 * explicitly listed as redeemable is not redeemable, so adding a new
 * credit source cannot accidentally make it cashable.
 *
 * Today exactly one provenance is redeemable — `hunt_verified`, gold
 * credited against a server-issued single-use kill token. In particular:
 *
 *   - `pvp_winnings` is not redeemable. Duel gold is player-versus-player
 *     transfer of an existing balance; making it redeemable would turn
 *     the duel into a cash wager, which nobody authorised.
 *   - `legacy_demo` is not redeemable. Balances imported from the old
 *     browser-side demo were asserted by the client and are untrusted
 *     migration data; they are recorded so a player's number does not
 *     vanish, and marked so they can never be paid out.
 *   - `gift` and `test_credit` are not redeemable, for the obvious reason.
 *
 * None of this is a claim that a redemption exists. There is no treasury
 * key and no payout path; see `treasury/withdrawals.ts`.
 * ------------------------------------------------------------------ */

export const PROVENANCES = [
  'hunt_verified',
  'pvp_winnings',
  'gift',
  'test_credit',
  'legacy_demo',
  /* Internal movements, not origins: an escrow reservation, a withdrawal
   * reservation, or the system account a credit is drawn out of. */
  'escrow',
  'withdrawal',
  'system',
] as const

export type Provenance = (typeof PROVENANCES)[number]

/** The complete allowlist. Everything else is ineligible by default. */
const REDEEMABLE: ReadonlySet<Provenance> = new Set<Provenance>(['hunt_verified'])

export function isProvenance(value: unknown): value is Provenance {
  return typeof value === 'string' && (PROVENANCES as readonly string[]).includes(value)
}

export function isRedeemable(provenance: Provenance): boolean {
  return REDEEMABLE.has(provenance)
}

export const REDEEMABLE_PROVENANCES: readonly Provenance[] = PROVENANCES.filter(isRedeemable)

/** Player-facing explanation, so the UI never has to invent one. */
export const PROVENANCE_NOTES: Record<Provenance, string> = {
  hunt_verified: 'Earned from a kill the server issued a single-use token for.',
  pvp_winnings: 'Won from another player in a duel. Not redeemable — duel gold is transferred, not earned.',
  gift: 'Granted by the world. Not redeemable.',
  test_credit: 'Created by a test or a development tool. Not redeemable.',
  legacy_demo: 'Imported from the old browser-side demo balance. Client-asserted, never redeemable.',
  escrow: 'Moved into or out of escrow. Not an origin.',
  withdrawal: 'Moved into or out of a withdrawal reservation. Not an origin.',
  system: 'System counterparty leg. Not an origin.',
}
