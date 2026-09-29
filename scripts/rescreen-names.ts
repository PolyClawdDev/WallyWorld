/* ------------------------------------------------------------------ *
 * Re-screens every display name already in the database and neutralises
 * the ones that fail.
 *
 * The broadcast layer in `server/pvp/ids.ts` already stops a stored bad
 * name from reaching another player, so this is not what makes the world
 * safe — it is what stops the row existing. Two different jobs:
 *
 *   the read-side screen  is the guarantee, and needs no deploy step
 *   this sweep            removes the data, so a future code path that
 *                         forgets the screen cannot resurrect it, and so
 *                         nobody reading the table finds a slur in it
 *
 * Idempotent and re-runnable. Run it again whenever the blocklist grows.
 *
 * Usage
 *   npm run rescreen:names              report only, changes nothing
 *   npm run rescreen:names -- --apply   rewrite the failing rows
 *
 *   WALLY_DB_PATH=data/wally.db npm run rescreen:names -- --apply
 *
 * It prints counts and truncated hashes. It never prints a name that
 * failed, so the output is safe to paste into an incident thread.
 * ------------------------------------------------------------------ */

import { clearNameVerdictCache, nameFingerprint, NEUTRAL_DISPLAY_NAME, screenDisplayName } from '../src/server/moderation/names'
import { coreDb } from '../src/server/store'

const apply = process.argv.includes('--apply')
const db = coreDb.raw

/**
 * Every column in the core database that holds a player-authored name.
 *
 * `pvp_accounts.display_name` is the live one. The rest are snapshots the
 * game took when an invite was sent, a duel was created or a result was
 * journalled — they are copies, and a copy of a slur is still a slur sitting
 * in a table, so they are swept too.
 */
const COLUMNS: ReadonlyArray<{ table: string; key: string; column: string }> = [
  { table: 'pvp_accounts', key: 'player_id', column: 'display_name' },
  { table: 'profiles', key: 'wallet', column: 'player_name' },
  { table: 'pvp_challenges', key: 'challenge_id', column: 'from_name' },
  { table: 'pvp_challenges', key: 'challenge_id', column: 'to_name' },
  { table: 'pvp_duels', key: 'duel_id', column: 'a_name' },
  { table: 'pvp_duels', key: 'duel_id', column: 'b_name' },
  { table: 'pvp_journal', key: 'id', column: 'opponent_name' },
]

const tableExists = (table: string) =>
  Boolean(db.prepare<[string], { name: string }>("select name from sqlite_master where type = 'table' and name = ?").get(table))

console.log('Voxels · stored display-name re-screen')
console.log(`  database    ${coreDb.file}`)
console.log(`  mode        ${apply ? 'APPLY — failing rows will be rewritten' : 'report only (pass --apply to write)'}`)
console.log(`  replacement ${NEUTRAL_DISPLAY_NAME}`)
console.log('')

let scanned = 0
let failed = 0
let written = 0
const offenders = new Map<string, number>()
const byTier = { always: 0, word: 0 }

for (const { table, key, column } of COLUMNS) {
  if (!tableExists(table)) {
    console.log(`  skip     ${table}.${column} — table not present`)
    continue
  }
  const rows = db.prepare<[], Record<string, string>>(`select ${key} as k, ${column} as v from ${table}`).all()
  const update = db.prepare(`update ${table} set ${column} = ? where ${key} = ?`)
  let tableFailed = 0
  let tableWritten = 0

  for (const row of rows) {
    scanned += 1
    const value = row.v ?? ''
    const verdict = screenDisplayName(value)
    if (verdict.ok) continue
    failed += 1
    tableFailed += 1
    byTier[verdict.tier] += 1
    offenders.set(verdict.fingerprint, (offenders.get(verdict.fingerprint) ?? 0) + 1)
    if (apply) {
      update.run(NEUTRAL_DISPLAY_NAME, row.k)
      written += 1
      tableWritten += 1
    }
  }

  const state = tableFailed === 0 ? 'clean' : apply ? `${tableWritten} rewritten` : `${tableFailed} would be rewritten`
  const label = tableFailed === 0 ? 'ok      ' : apply ? 'fixed   ' : 'FOUND   '
  console.log(`  ${label} ${table}.${column} — ${rows.length} rows, ${state}`)
}

// The screen memoises on the stored string, so a process that sweeps and then
// keeps serving must not answer from a cache keyed on rows it just rewrote.
clearNameVerdictCache()

console.log('')
console.log(`  scanned     ${scanned} name values`)
console.log(`  failed      ${failed} (${byTier.always} on the substring tier, ${byTier.word} on the whole-token tier)`)
console.log(`  distinct    ${offenders.size} distinct offending string(s)`)
for (const [fingerprint, count] of [...offenders].sort((a, b) => b[1] - a[1])) {
  console.log(`              ${fingerprint} × ${count}`)
}
console.log(`  rewritten   ${written}`)
console.log('')
if (failed > 0 && !apply) {
  console.log('  Nothing was written. Re-run with --apply to neutralise the rows above.')
  process.exit(1)
}
console.log(failed === 0 ? 'PASS — every stored name passes the current blocklist' : `DONE — ${written} row(s) neutralised`)
