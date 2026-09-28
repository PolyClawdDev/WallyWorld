/* ------------------------------------------------------------------ *
 * Driver selection.
 *
 * One place decides whether this process talks to a SQLite file or to a
 * managed Postgres, and every caller goes through the handle it returns.
 *
 * The two logical databases this project keeps apart — game state and
 * financial records — stay apart here too. Under SQLite they are separate
 * files, which is the strongest available separation because SQLite
 * cannot declare a foreign key across files. Under Postgres a managed
 * plan gives you one database, so the same boundary becomes a schema: the
 * finance handle pins its `search_path` on every connection in the pool,
 * and nothing else reaches those tables without naming the schema aloud.
 *
 * This module is additive. It does not replace `db.ts`, which still owns
 * the game schema and its statements, and it opens its own handle rather
 * than borrowing that one so the two can be developed independently.
 * SQLite in WAL mode is built for several connections in one process.
 * ------------------------------------------------------------------ */

import { DATABASE_URL, DB_DRIVER, DB_FINANCE_SCHEMA, DB_PATH } from '../config'
import type { SqlDriver } from './driver'
import { createPostgresDriver } from './postgres'
import { createSqliteDriver } from './sqlite'

export type { SqlDriver, SqlExecutor, SqlRow, SqlValue, WriteResult, SqlDialect } from './driver'
export { toPositionalPlaceholders } from './driver'

/** Which logical database a caller wants. Not a connection — a boundary. */
export type DatabaseScope = 'game' | 'finance'

/**
 * Deliberately not imported from `config`.
 *
 * The finance database belongs to another part of this codebase and its
 * location is read from the same variable rather than through a shared
 * export, so the two can move independently without either breaking the
 * other's build.
 */
function financeSqlitePath(): string {
  const explicit = (process.env.WALLY_FINANCE_DB_PATH ?? '').trim()
  return explicit || `${DB_PATH.replace(/(\.db)?$/, '')}-finance.db`
}

const open = new Map<DatabaseScope, SqlDriver>()

function build(scope: DatabaseScope): SqlDriver {
  if (DB_DRIVER === 'sqlite') {
    return createSqliteDriver(scope === 'finance' ? financeSqlitePath() : DB_PATH)
  }
  if (!DATABASE_URL) {
    // Unreachable in practice: `assertConfigValid` refuses to boot without it.
    throw new Error('the postgres driver was selected but DATABASE_URL is not set')
  }
  return createPostgresDriver({ schema: scope === 'finance' ? DB_FINANCE_SCHEMA : null })
}

/** The process-wide handle for one logical database. Opened on first use. */
export function sql(scope: DatabaseScope = 'game'): SqlDriver {
  const existing = open.get(scope)
  if (existing) return existing
  const driver = build(scope)
  open.set(scope, driver)
  return driver
}

/** Every handle opened so far, for readiness probes and for shutdown. */
export function openDrivers(): Array<{ scope: DatabaseScope; driver: SqlDriver }> {
  return [...open.entries()].map(([scope, driver]) => ({ scope, driver }))
}

export async function closeAllDrivers(): Promise<void> {
  const drivers = openDrivers()
  open.clear()
  await Promise.allSettled(drivers.map(({ driver }) => driver.close()))
}
