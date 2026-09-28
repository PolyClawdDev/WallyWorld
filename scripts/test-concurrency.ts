/*
 * Concurrency, using real operating-system processes.
 *
 * Two questions, both of which only have a meaningful answer under genuine
 * contention:
 *
 *   - N processes each spend `stake` against a balance that funds N−1 of them.
 *     Exactly one must lose, and the balance must land on zero. If the guard were
 *     read-then-write instead of a conditional UPDATE, two winners would share a
 *     stale read and the account would go negative.
 *   - N processes replay one idempotency key. Exactly one may post; the rest must
 *     report themselves as replays, and the money must move once.
 *
 * Run with: npm run test:concurrency
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

const files = useTestDatabases('test-concurrency')

const { balanceOf, playerAvailable, conservationReport, ensureSystemAccounts } = await import('../src/server/money/ledger')
const { creditGold, ensureGoldAccounts } = await import('../src/server/money/gold')

ensureSystemAccounts()

const CONTENDERS = 8
const STAKE = 25n

type ChildResult = { ok: boolean; code: string; idempotent?: boolean; transferId?: string }

function runChildren(mode: 'debit' | 'credit', userId: string, amount: bigint, keys: string[]): Promise<ChildResult[]> {
  // Far enough ahead that every child is spinning on the barrier before it opens.
  const startAt = Date.now() + 1200
  const script = resolve('scripts/lib/spender.ts')
  return Promise.all(
    keys.map(
      key =>
        new Promise<ChildResult>((done, fail) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', script, mode, userId, amount.toString(), key, String(startAt)],
            {
              env: {
                ...process.env,
                WALLY_DB_PATH: files.core,
                WALLY_FINANCE_DB_PATH: files.finance,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
          let out = ''
          let err = ''
          child.stdout.on('data', chunk => { out += chunk })
          child.stderr.on('data', chunk => { err += chunk })
          child.on('error', fail)
          child.on('close', code => {
            const line = out.trim().split('\n').pop() ?? ''
            if (code !== 0 || !line.startsWith('{')) {
              done({ ok: false, code: `child exited ${code}: ${(err || out).trim().slice(0, 200)}` })
              return
            }
            done(JSON.parse(line) as ChildResult)
          })
        }),
    ),
  )
}

/* ------------------------------------------------- one loser, never two */

section(`${CONTENDERS} processes spend ${STAKE} against a balance funding ${CONTENDERS - 1}`)

const SPENDER = 'usr_contended'
ensureGoldAccounts(SPENDER)
const funded = creditGold({
  userId: SPENDER,
  amount: STAKE * BigInt(CONTENDERS - 1),
  provenance: 'test_credit',
  idemScope: 'concurrency-setup',
  idemKey: 'fund',
  note: 'funding the contention test',
})
check('the account is funded for exactly one fewer than the contenders', funded.ok)
equal('starting balance', balanceOf(playerAvailable(SPENDER)), STAKE * BigInt(CONTENDERS - 1))

const spendResults = await runChildren(
  'debit',
  SPENDER,
  STAKE,
  Array.from({ length: CONTENDERS }, (_, index) => `spend-${index}`),
)

const winners = spendResults.filter(result => result.ok)
const losers = spendResults.filter(result => !result.ok)
equal('every child reported', spendResults.length, CONTENDERS)
equal('winners', winners.length, CONTENDERS - 1)
equal('losers', losers.length, 1)
check('the loser lost on funds, not on a crash or a lock timeout',
  losers.every(result => result.code === 'insufficient_funds'),
  losers.map(result => result.code).join(', '))
equal('the balance landed on zero', balanceOf(playerAvailable(SPENDER)), 0n)
check('the account never went negative', balanceOf(playerAvailable(SPENDER)) >= 0n)
check('every winner posted a distinct transfer',
  new Set(winners.map(result => result.transferId)).size === winners.length)

/* ------------------------------------------- one key, one movement of money */

section(`${CONTENDERS} processes replay one idempotency key`)

const REPLAYER = 'usr_replayed'
ensureGoldAccounts(REPLAYER)

const creditResults = await runChildren('credit', REPLAYER, 60n, Array.from({ length: CONTENDERS }, () => 'one-key'))

const posted = creditResults.filter(result => result.ok && !result.idempotent)
const replays = creditResults.filter(result => result.ok && result.idempotent)
const errors = creditResults.filter(result => !result.ok)
equal('every child reported', creditResults.length, CONTENDERS)
check('no child errored', errors.length === 0, errors.map(result => result.code).join(', '))
equal('exactly one child posted', posted.length, 1)
equal('the rest recognised themselves as replays', replays.length, CONTENDERS - 1)
check('every child names the same transfer',
  new Set(creditResults.map(result => result.transferId)).size === 1,
  [...new Set(creditResults.map(result => result.transferId))].join(', '))
equal('the money moved once', balanceOf(playerAvailable(REPLAYER)), 60n)

/* ------------------------------------------------------------ conservation */

section('the ledger still balances after contention')

const report = conservationReport()
check('balances sum to zero', report.balanceSum === 0n, report.balanceSum.toString())
check('entries sum to zero', report.entrySum === 0n, report.entrySum.toString())
check('no transfer is half-written', report.unbalancedTransfers.length === 0, report.unbalancedTransfers.join(','))
check('no balance drifted from its entries', report.driftedAccounts.length === 0,
  report.driftedAccounts.map(account => account.accountId).join(','))

finish('concurrency')
