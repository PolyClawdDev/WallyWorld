/* ------------------------------------------------------------------ *
 * The database driver seam.
 *
 * This file owns no schema, no migration and no query. It describes the
 * narrowest interface that both better-sqlite3 and node-postgres can
 * satisfy, so the rest of the server can be written once and run against
 * a file on a laptop or a managed Postgres in production.
 *
 * WHAT THIS IS FOR
 *   A container filesystem is ephemeral. On Render — and on Fly, Railway,
 *   Heroku and the rest — a redeploy replaces the instance and anything
 *   written to disk goes with it. `data/wally.db` is therefore correct for
 *   development and a data-loss bug in production. Rather than rewrite the
 *   storage layer, this seam lets the same statements run through a driver
 *   chosen by configuration.
 *
 * WHAT THIS IS NOT
 *   Not an ORM and not a query builder. Callers still write SQL. The seam
 *   only standardises "run this statement with these parameters and give
 *   me rows back", which is the part that actually differs between the two
 *   libraries.
 *
 * CONVENTIONS THAT MUST HOLD ON BOTH SIDES
 *   Placeholders are `?`, positional, in order. The Postgres driver
 *   rewrites them to `$1..$n`; SQLite takes them as they are. Writing `$1`
 *   directly would work on one driver and silently break the other.
 *
 *   Money is TEXT holding a decimal integer, end to end. Neither driver
 *   may widen an amount into a float or a numeric: `9007199254740993` is a
 *   perfectly ordinary number of base units and a JavaScript `number`
 *   cannot hold it. Integer columns that are not money are ordinary
 *   integers and are unaffected.
 * ------------------------------------------------------------------ */

/** Everything a parameter is allowed to be, on either driver. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array

export type SqlRow = Record<string, unknown>

export type SqlDialect = 'sqlite' | 'postgres'

export type WriteResult = {
  /** Rows the statement inserted, updated or deleted. */
  rowCount: number
}

/**
 * A handle that can run statements.
 *
 * A transaction hands its callback another `SqlExecutor` rather than the
 * pool, which is what stops a caller from accidentally issuing half a
 * transaction on a different connection — on Postgres that is not a
 * transaction at all, and the bug only shows up under concurrency.
 */
export interface SqlExecutor {
  readonly dialect: SqlDialect
  /** Rows from a SELECT, or from any statement with a RETURNING clause. */
  all<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  /** The first row, or null. */
  get<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T | null>
  /** A statement run for its effect. */
  run(sql: string, params?: readonly SqlValue[]): Promise<WriteResult>
  /** Multiple statements, no parameters. For schema setup only. */
  exec(sql: string): Promise<void>
}

export interface SqlDriver extends SqlExecutor {
  /**
   * Runs the callback inside one transaction on one connection, committing
   * on return and rolling back on throw.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>
  /**
   * Cheap liveness probe for the readiness endpoint. Resolves false rather
   * than throwing, because "is the database reachable" is a question with a
   * legitimate negative answer.
   */
  ping(timeoutMs?: number): Promise<boolean>
  /** Releases connections. Called once, from the shutdown path. */
  close(): Promise<void>
}

/**
 * Rewrites `?` placeholders to `$1..$n`.
 *
 * Quoted text has to be skipped or a `?` inside a string literal becomes a
 * parameter and the statement stops meaning what it says. Handles single
 * quotes (with SQL's doubled-quote escape), double-quoted identifiers, and
 * dollar-quoted bodies, which is the whole set this codebase can produce.
 */
export function toPositionalPlaceholders(sql: string): string {
  let out = ''
  let index = 0
  let quote: "'" | '"' | null = null
  let dollarTag: string | null = null

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]

    if (dollarTag) {
      out += char
      if (sql.startsWith(dollarTag, i)) {
        out += sql.slice(i + 1, i + dollarTag.length)
        i += dollarTag.length - 1
        dollarTag = null
      }
      continue
    }

    if (quote) {
      out += char
      if (char === quote) {
        // A doubled quote is an escaped quote, not the end of the literal.
        if (sql[i + 1] === quote) {
          out += quote
          i += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }

    if (char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (match) {
        dollarTag = match[0]
        out += dollarTag
        i += dollarTag.length - 1
        continue
      }
    }

    if (char === '?') {
      index += 1
      out += `$${index}`
      continue
    }

    out += char
  }

  return out
}
