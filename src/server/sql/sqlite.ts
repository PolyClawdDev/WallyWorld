/* ------------------------------------------------------------------ *
 * The SQLite side of the driver seam.
 *
 * Development storage, and the default. Zero setup: clone the repo, run
 * the server, and there is a database.
 *
 * better-sqlite3 is synchronous. The interface is async because the other
 * driver cannot be anything else, so every method here resolves
 * immediately. That is not a wasted round trip — an already-resolved
 * promise is a microtask — and it is what lets one call site serve both.
 *
 * `transaction` is written by hand rather than through better-sqlite3's
 * `db.transaction()` helper, because that helper refuses an async
 * callback. Nesting is handled with savepoints so a caller that starts a
 * transaction inside one does not get "cannot start a transaction within
 * a transaction".
 * ------------------------------------------------------------------ */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { SqlDriver, SqlExecutor, SqlRow, SqlValue, WriteResult } from './driver'

/** better-sqlite3 binds booleans as-is only from v9; converting keeps it explicit. */
function encode(params: readonly SqlValue[]): unknown[] {
  return params.map(value => {
    if (typeof value === 'boolean') return value ? 1 : 0
    return value
  })
}

class SqliteExecutor implements SqlExecutor {
  readonly dialect = 'sqlite' as const

  constructor(protected readonly db: Database.Database) {}

  async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...encode(params)) as T[]
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...encode(params)) as T | undefined) ?? null
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<WriteResult> {
    const info = this.db.prepare(sql).run(...encode(params))
    return { rowCount: info.changes }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }
}

export class SqliteDriver extends SqliteExecutor implements SqlDriver {
  private depth = 0

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const nested = this.depth > 0
    const savepoint = `sp_${this.depth}`
    this.depth += 1
    this.db.exec(nested ? `savepoint ${savepoint}` : 'begin')
    try {
      const result = await work(new SqliteExecutor(this.db))
      this.db.exec(nested ? `release ${savepoint}` : 'commit')
      return result
    } catch (error) {
      try {
        this.db.exec(nested ? `rollback to ${savepoint}` : 'rollback')
      } catch {
        /* the transaction was already unwound */
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare('select 1').get()
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    // Checkpointing folds the write-ahead log back into the main file, so the
    // database left behind after a shutdown is a single complete artifact
    // rather than a file plus a WAL that a later reader has to replay.
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* nothing useful to do while shutting down */
    }
    this.db.close()
  }

  /** The underlying handle, for callers still using better-sqlite3 directly. */
  get handle(): Database.Database {
    return this.db
  }
}

/** Wraps a handle somebody else opened, so there is only ever one per file. */
export function wrapSqliteDriver(db: Database.Database): SqliteDriver {
  return new SqliteDriver(db)
}

export function createSqliteDriver(path: string): SqliteDriver {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  const db = new Database(absolute)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 4000')
  return new SqliteDriver(db)
}
