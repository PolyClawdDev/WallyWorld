/*
 * Shared plumbing for the persistence, ledger and withdrawal suites.
 *
 * Two jobs. `useTestDatabases` points the process at throwaway database files and
 * must run before anything imports the store, because opening a database is a
 * side effect of importing `src/server/store`. Every suite therefore calls it at
 * the top and then reaches for its modules with `await import(...)`.
 *
 * The rest is a counter and a printer, matching the shape of `test-combat.ts` so
 * output from all of the suites reads the same way.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

let passed = 0
const failures: string[] = []

export type TestDatabases = { core: string; finance: string; remove: () => void }

/**
 * Names, and by default clears, the two database files for one suite.
 *
 * Pass `{ keep: true }` to attach to files a previous process left behind, which
 * is how the restart test proves that data outlives the process that wrote it.
 */
export function useTestDatabases(name: string, options: { keep?: boolean } = {}): TestDatabases {
  const core = resolve(`data/${name}.db`)
  const finance = resolve(`data/${name}-finance.db`)
  mkdirSync(resolve('data'), { recursive: true })
  const remove = () => {
    for (const base of [core, finance]) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(`${base}${suffix}`) } catch { /* nothing to remove */ }
      }
    }
  }
  if (!options.keep) remove()
  process.env.WALLY_DB_PATH = core
  process.env.WALLY_FINANCE_DB_PATH = finance
  process.env.WALLY_DEV_SESSIONS = '1'
  return { core, finance, remove }
}

export function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

export const equal = (label: string, actual: unknown, expected: unknown) =>
  check(label, actual === expected, `expected ${String(expected)}, got ${String(actual)}`)

export function section(title: string) {
  console.log(`\n${title}`)
}

/** Asserts a block throws. Used where refusing is the whole behaviour under test. */
export function throws(label: string, fn: () => unknown) {
  try {
    fn()
    check(label, false, 'it returned instead of throwing')
  } catch (error) {
    check(label, true, error instanceof Error ? error.message.slice(0, 80) : 'threw')
  }
}

export function finish(suite: string): never {
  console.log('')
  if (failures.length) {
    console.log(`${suite}: ${passed} passed, ${failures.length} FAILED:`)
    for (const failure of failures) console.log(`   ✗ ${failure}`)
    process.exit(1)
  }
  console.log(`${suite}: ${passed} passed, 0 failed`)
  process.exit(0)
}
