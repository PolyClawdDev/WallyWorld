/* ------------------------------------------------------------------ *
 * The migration runner.
 *
 * Forward-only, numbered, and idempotent: applying the list to a database
 * that is already current does nothing at all and reports nothing
 * applied, which is what makes it safe to run unconditionally at import
 * time and again from the worker process.
 *
 * Each migration runs inside a transaction together with its own
 * `schema_version` row, so a migration either lands completely or not at
 * all. A checksum of the statements is stored: if an already-applied
 * migration is later edited, startup fails loudly rather than running a
 * database whose shape does not match the code that reads it.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { MIGRATIONS, type DatabaseName, type Migration } from './migrations'
import type { OpenedDatabase } from './sqlite'

export type AppliedMigration = { id: number; name: string }

const SCHEMA_VERSION_TABLE = `
  create table if not exists schema_version (
    id            integer primary key,
    name          text not null,
    checksum      text not null,
    applied_at_ms integer not null
  )
`

function checksumOf(migration: Migration): string {
  const hash = createHash('sha256')
  hash.update(`${migration.id}:${migration.name}\n`)
  for (const statement of migration.sql ?? []) hash.update(`${statement}\n`)
  for (const [dialect, statements] of Object.entries(migration.dialectSql ?? {})) {
    for (const statement of statements ?? []) hash.update(`${dialect}:${statement}\n`)
  }
  // A `run` step is code, not text; its identity is its name. Changing what it
  // does without renumbering is the one thing the checksum cannot catch, which
  // is why `run` is reserved for steps that are idempotent by construction.
  if (migration.run) hash.update('run-step\n')
  return hash.digest('hex').slice(0, 32)
}

/** Ascending, no gaps, no duplicates. Caught at startup rather than in review. */
function assertWellOrdered(name: DatabaseName, list: readonly Migration[]): void {
  let previous = 0
  for (const migration of list) {
    if (migration.id !== previous + 1) {
      throw new Error(`${name} migrations must be numbered 1..n with no gaps; found ${migration.id} after ${previous}`)
    }
    previous = migration.id
  }
}

export function runMigrations(db: OpenedDatabase, name: DatabaseName): AppliedMigration[] {
  const list = MIGRATIONS[name]
  assertWellOrdered(name, list)

  db.raw.exec(SCHEMA_VERSION_TABLE)
  const selectApplied = db.raw.prepare<[number], { id: number; name: string; checksum: string }>(
    'select id, name, checksum from schema_version where id = ?',
  )
  const insertApplied = db.raw.prepare(
    'insert into schema_version (id, name, checksum, applied_at_ms) values (?, ?, ?, ?)',
  )

  const applied: AppliedMigration[] = []
  for (const migration of list) {
    const existing = selectApplied.get(migration.id)
    const checksum = checksumOf(migration)
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `${name} migration ${migration.id} (${existing.name}) has changed since it was applied. ` +
            'Migrations are forward-only: add a new numbered migration instead of editing an applied one.',
        )
      }
      continue
    }

    db.raw.transaction(() => {
      for (const statement of migration.sql ?? []) db.raw.exec(statement)
      for (const statement of migration.dialectSql?.[db.dialect] ?? []) db.raw.exec(statement)
      migration.run?.(db)
      insertApplied.run(migration.id, migration.name, checksum, Date.now())
    })()
    applied.push({ id: migration.id, name: migration.name })
  }
  return applied
}

/** Highest applied migration, or 0 for an untouched database. */
export function schemaVersion(db: OpenedDatabase): number {
  const row = db.raw
    .prepare<[], { version: number | null }>('select max(id) as version from schema_version')
    .get()
  return row?.version ?? 0
}
