/*
 * Gives a player game gold so a verification run can stake a duel.
 *
 * Gold is normally earned by hunting, which headless software WebGL is in
 * no position to do reliably. This writes through the ledger's own credit
 * path rather than touching a table, so the conservation invariants still
 * hold and the credit is non-redeemable like any other adjustment.
 *
 * Point it at the same database the server has open:
 *   WALLY_DB_PATH=data/verify/wally.db tsx scripts/seed-gold.ts p_abc 500
 */
import { creditGold, readGold } from '../src/server/pvp/ledger'

const [playerId, rawAmount] = process.argv.slice(2)
if (!playerId) {
  console.error('usage: tsx scripts/seed-gold.ts <playerId> [amount]')
  process.exit(1)
}

const amount = Number(rawAmount ?? 500)
const before = readGold(playerId).available
creditGold(playerId, amount, 'adjust', 'verify', `seed-${playerId}-${amount}`, 'verification top-up')
const after = readGold(playerId).available
console.log(`${playerId} ${before} -> ${after}`)
