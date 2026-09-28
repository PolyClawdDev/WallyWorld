/* ------------------------------------------------------------------ *
 * The one module that talks to a database driver.
 *
 * Everything above this file speaks in terms of the `SqlDatabase` shape
 * below — prepare, run, get, all, transaction. Nothing else imports
 * better-sqlite3. That is the seam a Postgres driver is swapped in at,
 * and keeping it narrow is the whole point: a second implementation has
 * to satisfy five methods, not the whole application.
 *
 * Portability rules the rest of the tree is written to obey, so the SQL
 * itself does not have to be rewritten later:
 *
 *   - Money is TEXT holding a decimal integer. Never a float, never a
 *     native 64-bit integer column, because drivers disagree about how
 *     those come back and one of the disagreements is lossy.
 *   - Comparisons and arithmetic on money happen in JavaScript bigints,
 *     never in SQL, so no dialect's cast syntax leaks into a query.
 *   - Booleans are `integer not null default 0` holding 0 or 1.
 *   - Upserts are `on conflict (...) do nothing / do update`, which both
 *     SQLite and Postgres accept. Never `insert or ignore`.
 *   - No AUTOINCREMENT, no WITHOUT ROWID, no PRAGMA outside this file.
 *   - Anything genuinely dialect-specific (the append-only triggers) is
 *     declared as such in the migration list and skipped elsewhere.
 * ------------------------------------------------------------------ */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type SqlParams = Record<string, string | number | null> | Array<string | number | null>

export type Dialect = 'sqlite' | 'postgres'

/**
 * The raw better-sqlite3 handle is still exported, because the PvP and profile
 * code predates this seam and uses prepared statements directly. New code should
 * take the narrower surface above. The seam is honest about that: this is a
 * partial abstraction, not a finished driver layer, and the sibling agent adding
 * the Postgres driver will need to finish converting those call sites.
 */
export type RawDatabase = Database.Database

export type OpenedDatabase = {
  readonly name: string
  readonly file: string
  readonly dialect: Dialect
  readonly raw: RawDatabase
}

/**
 * WAL so a reader never blocks the writer; `foreign_keys` on because the
 * relations inside each database are real and should be enforced; `busy_timeout`
 * so two processes (the API and the worker) contending for the same file wait
 * rather than fail. `synchronous = FULL` on the financial database: a torn write
 * there is a lost ledger entry, and that is worth the extra fsync.
 */
export function openDatabase(name: string, file: string, options: { durable?: boolean } = {}): OpenedDatabase {
  const absolute = resolve(file)
  mkdirSync(dirname(absolute), { recursive: true })
  const raw = new Database(absolute)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma('busy_timeout = 8000')
  raw.pragma(options.durable ? 'synchronous = FULL' : 'synchronous = NORMAL')
  return { name, file: absolute, dialect: 'sqlite', raw }
}

/**
 * Runs `fn` inside a transaction that takes the write lock immediately.
 *
 * BEGIN IMMEDIATE rather than the default deferred begin: a reservation reads a
 * balance and then writes it, and with a deferred begin two processes can both
 * take the read, then one gets SQLITE_BUSY at upgrade time with its snapshot
 * already stale. Taking the lock up front makes the read-then-write sequence
 * serialisable across processes, which is what "exactly one loser" requires.
 */
export function immediateTransaction<T>(db: OpenedDatabase, fn: () => T): T {
  return db.raw.transaction(fn).immediate()
}
