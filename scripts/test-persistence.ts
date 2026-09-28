/*
 * Restart persistence.
 *
 * One process writes an account, a claim, a balance, a job, an artifact and a held
 * withdrawal reservation, then exits. A second, entirely fresh process reads them
 * back. This parent never opens the databases itself, so nothing here can be kept
 * alive by a handle the test happens to be holding.
 *
 * Run with: npm run test:persistence
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

const files = useTestDatabases('test-persistence')

function runPhase(script: string, args: string[] = []): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(script), ...args], {
      env: { ...process.env, WALLY_DB_PATH: files.core, WALLY_FINANCE_DB_PATH: files.finance },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', fail)
    child.on('close', code => {
      const line = out.trim().split('\n').pop() ?? ''
      if (code !== 0 || !line.startsWith('{')) {
        fail(new Error(`${script} exited ${code}: ${(err || out).trim().slice(0, 600)}`))
        return
      }
      done(JSON.parse(line) as Record<string, unknown>)
    })
  })
}

section('first process: create an account and spend into it')

const written = (await runPhase('scripts/lib/persist-write.ts')) as {
  guestPrincipal: string
  userId: string
  wallet: string
  jobId: string
  artifactId: string
  withdrawalId: string | null
  linked: boolean
  gold: { available: string; reserved: string; redeemable: string }
  migrationsApplied: number
  schema: { core: number; finance: number }
}

check('the write process ran', written.userId.length > 0, written.userId)
check('the wallet was linked with a signature', written.linked)
check('it applied the migrations from empty', written.migrationsApplied > 0, String(written.migrationsApplied))
equal('gold available after the reservation', written.gold.available, '1450')
equal('gold held in the withdrawal reservation', written.gold.reserved, '1000')
equal('redeemable headroom left after the hold', written.gold.redeemable, '500')
check('a withdrawal is held open', written.withdrawalId !== null)

section('second process: everything is still there')

const read = (await runPhase('scripts/lib/persist-read.ts', [written.guestPrincipal, written.userId, written.wallet])) as {
  byGuestKey: string
  byGuestKeyCreated: boolean
  byWallet: string
  byWalletCreated: boolean
  walletOwner: string | null
  walletCount: number
  profile: { playerName: string; character: string } | null
  gold: { available: string; reserved: string; redeemable: string }
  provenance: Array<{ provenance: string; amount: string; redeemable: boolean }>
  jobs: number
  jobRequest: unknown
  strangerCanReadJob: boolean
  artifacts: number
  withdrawals: number
  withdrawalState: string | null
  withdrawalIsOwned: boolean
  withdrawalLeaksToStranger: boolean
  conservation: { ok: boolean; balanceSum: string; drifted: number }
  migrationsApplied: number
  schema: { core: number; finance: number }
}

equal('the guest key still finds the same account', read.byGuestKey, written.userId)
check('and did not create a new one', !read.byGuestKeyCreated)
equal('the wallet finds the same account', read.byWallet, written.userId)
check('and did not create a new one either', !read.byWalletCreated)
equal('the wallet is still linked', read.walletOwner, written.userId)
equal('one wallet, not two', read.walletCount, 1)

equal('the character survived', read.profile?.character, 'ORBIT')
equal('the name survived', read.profile?.playerName, 'Ember')

equal('available gold survived', read.gold.available, written.gold.available)
equal('held gold survived', read.gold.reserved, written.gold.reserved)
equal('redeemable headroom survived', read.gold.redeemable, written.gold.redeemable)

const hunt = read.provenance.find(entry => entry.provenance === 'hunt_verified')
const legacy = read.provenance.find(entry => entry.provenance === 'legacy_demo')
equal('hunt provenance survived', hunt?.amount, '1500')
check('and is still the redeemable one', hunt?.redeemable === true)
equal('legacy demo provenance survived', legacy?.amount, '700')
check('and is still not redeemable', legacy?.redeemable === false)

equal('the job survived', read.jobs, 1)
check('with its request intact', JSON.stringify(read.jobRequest).includes('survives a restart'))
check('and is still owner-only', !read.strangerCanReadJob)
equal('the artifact survived', read.artifacts, 1)

equal('the withdrawal survived', read.withdrawals, 1)
equal('still in the state it was left in', read.withdrawalState, 'reserved')
check('still readable by its owner', read.withdrawalIsOwned)
check('still not readable by anyone else', !read.withdrawalLeaksToStranger)

check('the ledger still balances', read.conservation.ok, `sum ${read.conservation.balanceSum}, drifted ${read.conservation.drifted}`)

section('the second process did not re-run the migrations')

equal('nothing was applied', read.migrationsApplied, 0)
equal('core schema version is unchanged', read.schema.core, written.schema.core)
equal('finance schema version is unchanged', read.schema.finance, written.schema.finance)

section('a third process sees the same thing')

const third = (await runPhase('scripts/lib/persist-read.ts', [written.guestPrincipal, written.userId, written.wallet])) as typeof read
equal('the account is stable', third.byWallet, written.userId)
equal('the balance is stable', third.gold.available, read.gold.available)
equal('the withdrawal is stable', third.withdrawalState, 'reserved')
equal('and still nothing to migrate', third.migrationsApplied, 0)

finish('persistence')
