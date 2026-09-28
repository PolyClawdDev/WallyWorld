/* ------------------------------------------------------------------ *
 * The two database handles, migrated on first import.
 *
 * Importing this module is what brings a database up to date, and it is
 * safe to do from the API process and the worker process at the same
 * time: the runner is idempotent and each migration commits atomically
 * with its own version row, so the loser of a race finds the work
 * already done.
 * ------------------------------------------------------------------ */

import { DB_PATH, FINANCE_DB_PATH } from '../config'
import { runMigrations, schemaVersion } from './migrate'
import { openDatabase, type OpenedDatabase } from './sqlite'

export { immediateTransaction } from './sqlite'
export type { OpenedDatabase } from './sqlite'
export { schemaVersion } from './migrate'

/** Game and identity. Characters, progression, sessions, wallets, PvP matches. */
export const coreDb: OpenedDatabase = openDatabase('core', DB_PATH)

/**
 * Money. Ledger, reservations, jobs, receipts, withdrawals.
 *
 * `durable: true` sets synchronous = FULL. A financial database that loses its
 * last commit to a power cut is worse than a slow one.
 */
export const financeDb: OpenedDatabase = openDatabase('finance', FINANCE_DB_PATH, { durable: true })

export const migrationReport = {
  core: runMigrations(coreDb, 'core'),
  finance: runMigrations(financeDb, 'finance'),
}

export const schemaVersions = () => ({
  core: schemaVersion(coreDb),
  finance: schemaVersion(financeDb),
})

/** Paths, for the health endpoint and the startup banner. Not credentials. */
export const databaseFiles = { core: coreDb.file, finance: financeDb.file }
