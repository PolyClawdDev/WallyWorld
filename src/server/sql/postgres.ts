/* ------------------------------------------------------------------ *
 * The Postgres side of the driver seam.
 *
 * Production storage. A managed instance survives the redeploy that wipes
 * a container's filesystem, which is the reason this exists at all.
 *
 * Two decisions worth stating, because getting either wrong corrupts
 * money quietly rather than loudly:
 *
 *   `int8` is parsed as a string. node-postgres does this by default and
 *   the default is kept deliberately: a 64-bit integer does not fit in a
 *   JavaScript `number`, and letting one round is how an amount becomes
 *   almost right. The codebase's convention is that amounts are TEXT
 *   decimal integers anyway, so the string form is what callers expect.
 *
 *   `numeric` is parsed as a string too, for the same reason. Nothing here
 *   should be storing money as numeric, but if a migration ever does, the
 *   value must not arrive as a float.
 *
 * The connection string is a credential — the password is in its userinfo
 * — so it is never logged. `redact.ts` knows about `DATABASE_URL` and
 * scrubs it out of any driver error that quotes it.
 * ------------------------------------------------------------------ */

import pg from 'pg'
import { DATABASE_URL, DB_POOL_MAX, DB_SSL } from '../config'
import { describeUpstreamError } from '../redact'
import { toPositionalPlaceholders, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue, type WriteResult } from './driver'

/**
 * OIDs for the types whose default JS mapping would lose precision.
 * Registering the identity parser is what keeps them as exact strings.
 */
const OID_INT8 = 20
const OID_NUMERIC = 1700

pg.types.setTypeParser(OID_INT8, value => value)
pg.types.setTypeParser(OID_NUMERIC, value => value)

/** `bigint` has no wire format of its own; send it as the decimal text it is. */
function encode(params: readonly SqlValue[]): unknown[] {
  return params.map(value => (typeof value === 'bigint' ? value.toString() : value))
}

class PgExecutor implements SqlExecutor {
  readonly dialect = 'postgres' as const

  constructor(protected readonly client: pg.Pool | pg.PoolClient) {}

  async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    const result = await this.client.query(toPositionalPlaceholders(sql), encode(params))
    return result.rows as T[]
  }

  async get<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params)
    return rows[0] ?? null
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<WriteResult> {
    const result = await this.client.query(toPositionalPlaceholders(sql), encode(params))
    return { rowCount: result.rowCount ?? 0 }
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql)
  }
}

export type PostgresDriverOptions = {
  max: number
  ssl: boolean
  /**
   * Schema pinned on every connection in the pool.
   *
   * It has to be a startup option rather than a `set search_path` statement:
   * a pool hands out a different connection each time, so a statement would
   * configure one connection and leave the rest pointing at `public`, which
   * is the kind of bug that only appears once there is concurrency.
   */
  schema: string | null
}

export class PostgresDriver extends PgExecutor implements SqlDriver {
  private readonly pool: pg.Pool
  private readonly ready: Promise<void>

  constructor(connectionString: string, options: PostgresDriverOptions) {
    const pool = new pg.Pool({
      connectionString,
      max: options.max,
      options: options.schema ? `-c search_path=${options.schema},public` : undefined,
      // Managed Postgres presents a certificate chain the platform terminates
      // for us; verification here would fail against Render's internal CA
      // while adding nothing, since the connection never leaves the private
      // network. TLS is still on, so the traffic is not in the clear.
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Named after the service so `pg_stat_activity` says who is holding a
      // connection when the pool is exhausted at 3am.
      application_name: 'voxels',
    })
    // An idle client that errors (a Postgres restart, a network blip) emits on
    // the pool. Without a listener Node treats it as an unhandled 'error' event
    // and kills the process, turning a recoverable blip into an outage.
    pool.on('error', error => {
      console.error('[voxels-db] idle postgres client error:', describeUpstreamError(error))
    })
    super(pool)
    this.pool = pool
    // `search_path` happily points at a schema that does not exist yet, so the
    // first CREATE TABLE would land in `public` instead and the boundary would
    // be gone without anything failing. Creating it up front, and awaiting that
    // before any other statement, is what makes the pinning mean something.
    this.ready = options.schema
      ? pool.query(`create schema if not exists "${options.schema.replace(/"/g, '""')}"`).then(() => undefined)
      : Promise.resolve()
    this.ready.catch(() => { /* surfaced by the first real query instead */ })
  }

  override async all<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    await this.ready
    return super.all<T>(sql, params)
  }

  override async run(sql: string, params: readonly SqlValue[] = []): Promise<WriteResult> {
    await this.ready
    return super.run(sql, params)
  }

  override async exec(sql: string): Promise<void> {
    await this.ready
    return super.exec(sql)
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.ready
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await work(new PgExecutor(client))
      await client.query('commit')
      return result
    } catch (error) {
      try {
        await client.query('rollback')
      } catch {
        /* the connection is already gone; releasing it below is all that is left */
      }
      throw error
    } finally {
      client.release()
    }
  }

  async ping(timeoutMs = 2_000): Promise<boolean> {
    // A pool that cannot hand out a connection hangs rather than rejecting, so
    // readiness needs its own clock. Without this the health check inherits the
    // platform's timeout and the instance is reported unhealthy with no reason.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([
        this.pool.query('select 1').then(() => true).catch(() => false),
        deadline,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export function createPostgresDriver(options: { schema?: string | null } = {}): PostgresDriver {
  if (!DATABASE_URL) throw new Error('createPostgresDriver called without DATABASE_URL')
  return new PostgresDriver(DATABASE_URL, { max: DB_POOL_MAX, ssl: DB_SSL, schema: options.schema ?? null })
}
