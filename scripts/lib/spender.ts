/*
 * A child process that tries to spend, used by `scripts/test-concurrency.ts`.
 *
 * Separate processes rather than promises on one event loop, because the thing
 * under test is a database guarantee. Every `postTransfer` is synchronous, so N
 * calls inside one Node process would simply run one after another and prove
 * nothing at all. Two operating-system processes really do arrive at the same
 * row at the same time.
 *
 * Reads its instructions from argv and the database paths from the environment,
 * both handed down by the parent. Prints one line of JSON and exits.
 */
const [, , mode, userId, amountText, key, startAtText] = process.argv

const amount = BigInt(amountText!)
const startAt = Number(startAtText)

const { debitGold, creditGold, ensureGoldAccounts } = await import('../../src/server/money/gold')

ensureGoldAccounts(userId!)

// Spin to the agreed instant so every child reaches the row together. A sleep
// would be kinder to the CPU and much worse at colliding.
while (Date.now() < startAt) { /* barrier */ }

const result =
  mode === 'debit'
    ? debitGold({ userId: userId!, amount, idemScope: 'concurrency', idemKey: key!, note: 'concurrent spend' })
    : creditGold({
        userId: userId!,
        amount,
        provenance: 'hunt_verified',
        idemScope: 'concurrency',
        idemKey: key!,
        note: 'concurrent credit',
      })

process.stdout.write(
  `${JSON.stringify(
    result.ok
      ? { ok: true, code: 'posted', idempotent: result.idempotent, transferId: result.transferId }
      : { ok: false, code: result.code, reason: result.reason },
  )}\n`,
)
process.exit(0)
