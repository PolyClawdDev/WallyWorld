/* ------------------------------------------------------------------ *
 * The old demo balance, imported once and marked forever.
 *
 * Before the ledger existed, gold was a number the browser kept and
 * occasionally synced to `profiles.gold`. A player who had 4,000 of it is
 * not lying, and deleting it would be rude — but the server never saw any
 * of it happen, so it is untrusted migration data and it must never become
 * redeemable.
 *
 * So: one import per account, capped, recorded as a real ledger credit with
 * `legacy_demo` provenance. That provenance is not in the redeemable set,
 * so the imported gold is spendable in the game and can never be part of a
 * withdrawal. `scripts/test-ledger.ts` asserts exactly that.
 * ------------------------------------------------------------------ */

import { GOLD_MAX } from '../../shared/profile'
import { coreDb } from '../store'
import { fromStored } from './amount'
import { creditGold } from './gold'
import { creditsByProvenance, eligibilityOf } from './ledger'
import { isRedeemable, type Provenance } from './provenance'

const selectStoredGold = coreDb.raw.prepare<[string], { gold: number }>('select gold from profiles where wallet = ?')

export type LegacyImport =
  | { ok: true; imported: string; idempotent: boolean; redeemable: false }
  | { ok: false; reason: string }

/**
 * Imports the client-asserted demo balance stored on this account's profile row.
 *
 * The amount is read from the server's own copy rather than from the request, and
 * capped at `GOLD_MAX`, so the worst a tampered client can do is claim the cap
 * once — in gold that is explicitly not redeemable.
 */
export function importLegacyDemoGold(userId: string, now = Date.now()): LegacyImport {
  const row = selectStoredGold.get(userId)
  if (!row) return { ok: false, reason: 'this account has no stored profile to import from' }
  if (!Number.isInteger(row.gold) || row.gold <= 0) {
    return { ok: false, reason: 'there is no demo balance on this account to import' }
  }
  const amount = BigInt(Math.min(row.gold, GOLD_MAX))

  const posted = creditGold({
    userId,
    amount,
    provenance: 'legacy_demo',
    idemScope: 'legacy-demo-import',
    idemKey: userId,
    refType: 'profile',
    refId: userId,
    note: 'Imported from the old browser-side demo balance. Client-asserted, never redeemable.',
    now,
  })
  if (!posted.ok) return { ok: false, reason: posted.reason }
  return { ok: true, imported: amount.toString(), idempotent: posted.idempotent, redeemable: false }
}

/**
 * True when none of this account's redeemable headroom came from a legacy import.
 *
 * Computed from the append-only entries rather than trusting the eligibility row:
 * total up every credit by provenance, add the ones whose provenance is in the
 * redeemable set, and check that `accrued` is exactly that and no more. If a
 * legacy import had contributed, `accrued` would be higher than the sum of the
 * redeemable credits and this returns false.
 */
export function legacyImportIsNotRedeemable(userId: string): boolean {
  const credits = creditsByProvenance(userId)
  let fromRedeemableSources = 0n
  for (const [provenance, amount] of Object.entries(credits)) {
    if (isRedeemable(provenance as Provenance)) fromRedeemableSources += fromStored(amount)
  }
  return eligibilityOf(userId).accrued === fromRedeemableSources
}
