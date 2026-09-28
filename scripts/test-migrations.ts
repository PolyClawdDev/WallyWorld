/*
 * Migrations: apply from empty, re-run without effect, refuse to be edited, and
 * actually enforce append-only where the schema claims to.
 *
 * Run with: npm run test:migrations
 */
import { useTestDatabases, check, equal, section, finish, throws } from './lib/harness'

const files = useTestDatabases('test-migrations')

const { coreDb, financeDb, migrationReport, schemaVersions } = await import('../src/server/store')
const { CORE_MIGRATIONS, FINANCE_MIGRATIONS } = await import('../src/server/store/migrations')
const { runMigrations, schemaVersion } = await import('../src/server/store/migrate')

section('applying from empty')

// Importing the store ran them, so the report describes this process's own work.
check('core migrations applied from empty', migrationReport.core.length === CORE_MIGRATIONS.length,
  `applied ${migrationReport.core.length} of ${CORE_MIGRATIONS.length}`)
check('finance migrations applied from empty', migrationReport.finance.length === FINANCE_MIGRATIONS.length,
  `applied ${migrationReport.finance.length} of ${FINANCE_MIGRATIONS.length}`)
equal('core schema version', schemaVersions().core, CORE_MIGRATIONS.length)
equal('finance schema version', schemaVersions().finance, FINANCE_MIGRATIONS.length)

section('migration list is a forward-only sequence')

for (const [name, list] of [['core', CORE_MIGRATIONS], ['finance', FINANCE_MIGRATIONS]] as const) {
  const ids = list.map(m => m.id)
  check(`${name} ids are 1..${ids.length} with no gaps`, ids.every((id, index) => id === index + 1), ids.join(','))
  check(`${name} names are unique`, new Set(list.map(m => m.name)).size === list.length)
}

section('re-running is a no-op')

equal('second core run applies nothing', runMigrations(coreDb, 'core').length, 0)
equal('second finance run applies nothing', runMigrations(financeDb, 'finance').length, 0)
equal('core version unchanged', schemaVersion(coreDb), CORE_MIGRATIONS.length)
equal('finance version unchanged', schemaVersion(financeDb), FINANCE_MIGRATIONS.length)

section('every declared table exists')

const tablesIn = (db: typeof coreDb) =>
  new Set(
    db.raw
      .prepare<[], { name: string }>("select name from sqlite_master where type = 'table'")
      .all()
      .map(row => row.name),
  )

const coreTables = tablesIn(coreDb)
const financeTables = tablesIn(financeDb)

for (const table of ['users', 'principals', 'linked_wallets', 'guest_sessions', 'link_challenges', 'account_links',
  'profiles', 'nonces', 'sessions', 'hunt_sessions', 'hunt_kill_tokens', 'hunt_deaths', 'pvp_accounts', 'pvp_records']) {
  check(`core has ${table}`, coreTables.has(table))
}
for (const table of ['ledger_accounts', 'ledger_transfers', 'ledger_entries', 'ledger_balances', 'reward_eligibility',
  'services', 'quotes', 'authorizations', 'budget_reservations', 'jobs', 'job_steps', 'artifacts', 'idempotency_keys',
  'monitors', 'receipts', 'payment_attempts', 'conversion_attempts', 'zcash_operations', 'withdrawals',
  'withdrawal_events', 'treasury_reservations']) {
  check(`finance has ${table}`, financeTables.has(table))
}

section('game data and financial records are separate databases')

// The guarantee is structural rather than a convention: SQLite cannot express a
// foreign key into another database file, so no financial row can depend on a
// game row even if someone later writes the constraint by mistake.
check('finance database holds no game tables',
  !financeTables.has('profiles') && !financeTables.has('hunt_kill_tokens') && !financeTables.has('pvp_accounts'))
check('core database holds no ledger tables',
  !coreTables.has('ledger_entries') && !coreTables.has('ledger_balances') && !coreTables.has('withdrawals'))
check('the retired core gold tables are not recreated', !coreTables.has('game_gold') && !coreTables.has('game_gold_ledger'))

section('append-only is enforced by the database, not by convention')

const { ensureSystemAccounts, postTransfer, SYSTEM_MINT, playerAvailable } = await import('../src/server/money/ledger')
const { ensureGoldAccounts } = await import('../src/server/money/gold')

ensureSystemAccounts()
ensureGoldAccounts('u_append_only')
const posted = postTransfer({
  kind: 'test.credit',
  idemScope: 'test-append',
  idemKey: 'one',
  note: 'append-only probe',
  legs: [
    { accountId: SYSTEM_MINT, amount: -10n, provenance: 'system' },
    { accountId: playerAvailable('u_append_only'), amount: 10n, provenance: 'test_credit', ownerUserId: 'u_append_only' },
  ],
})
check('probe transfer posted', posted.ok, posted.ok ? posted.transferId : posted.reason)

throws('a ledger entry cannot be updated', () =>
  financeDb.raw.prepare("update ledger_entries set amount = '999' where entry_id is not null").run())
throws('a ledger entry cannot be deleted', () =>
  financeDb.raw.prepare('delete from ledger_entries').run())
throws('a transfer cannot be updated', () =>
  financeDb.raw.prepare("update ledger_transfers set note = 'rewritten'").run())
throws('a transfer cannot be deleted', () =>
  financeDb.raw.prepare('delete from ledger_transfers').run())

section('quotes are immutable once written')

financeDb.raw
  .prepare(
    `insert into services (service_id, npc, label, status, price_policy, env_stamp, created_at_ms, updated_at_ms)
     values ('svc_test', 'test-npc', 'test service', 'active', 'fixed', 'test', ?, ?)`,
  )
  .run(Date.now(), Date.now())
financeDb.raw
  .prepare(
    `insert into quotes (quote_id, service_id, owner_user_id, source_network, source_asset, source_decimals,
                         principal, service_fee, conversion_cost, network_fees, contingency, max_total_debit,
                         provider, env_stamp, created_at_ms, expires_at_ms)
     values ('q_test', 'svc_test', 'u_quote', 'solana', 'USDC', 6,
             '1000', '0', '0', '0', '0', '1000',
             'none', 'test', ?, ?)`,
  )
  .run(Date.now(), Date.now() + 60_000)
throws('a quote cannot be repriced', () =>
  financeDb.raw.prepare("update quotes set max_total_debit = '1' where quote_id = 'q_test'").run())
throws('a quote cannot be deleted', () =>
  financeDb.raw.prepare("delete from quotes where quote_id = 'q_test'").run())

section('amounts are stored as text, never as a number')

const amountColumns = financeDb.raw
  .prepare<[], { tbl: string; name: string; type: string }>(
    `select m.name as tbl, i.name as name, i.type as type
       from sqlite_master m join pragma_table_info(m.name) i
      where m.type = 'table'
        and (i.name = 'amount' or i.name like '%_lamports' or i.name like '%_gold' or i.name = 'gold_amount')`,
  )
  .all()
const numeric = amountColumns.filter(column => !/^TEXT$/i.test(column.type))
check('no money column is declared numeric', numeric.length === 0,
  numeric.map(c => `${c.tbl}.${c.name}:${c.type}`).join(', ') || `${amountColumns.length} columns, all TEXT`)

section('the files are where configuration said they would be')

equal('core file', coreDb.file, files.core)
equal('finance file', financeDb.file, files.finance)

finish('migrations')
