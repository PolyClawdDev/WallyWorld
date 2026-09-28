/* ------------------------------------------------------------------ *
 * Proves the built client contains no RPC credential.
 *
 * Anything in a `VITE_*` variable is compiled into the bundle and is
 * public. The provider endpoint is a credential — the access token sits in
 * the URL path — so it must only ever live in a server-side variable. This
 * script reads the real values out of the environment and searches every
 * byte of the build output for them, so the check is against the actual
 * secret rather than a guess at its shape.
 *
 * Run after `npm run build`:  npm run audit:bundle
 * ------------------------------------------------------------------ */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIRS = (process.env.AUDIT_DIRS ?? 'dist').split(',').map(value => value.trim()).filter(Boolean)

const CREDENTIAL_VARS = [
  'SOLANA_RPC_URL',
  'SOLANA_RPC_URL_MAINNET_BETA',
  'SOLANA_RPC_URL_DEVNET',
  'SOLANA_RPC_URL_TESTNET',
]

/**
 * Database URLs are searched for too, but differently.
 *
 * The secret in `postgres://user:password@host/db` is the password and
 * the URL as a whole. The host is not, and treating it as one would be
 * worse than useless: a local `localhost` or a Render `dpg-…` hostname
 * would match ordinary strings in the bundle and report a leak that is
 * not one. So only the whole URL and the password are looked for.
 */
const DATABASE_VARS = ['DATABASE_URL', 'WALLY_DATABASE_URL']

/** Hosts that are public infrastructure, so finding one is not a leak. */
const PUBLIC_HOSTS = /(^|\.)solana\.com$/

type Needle = { label: string; value: string; fatal: boolean }

/**
 * Everything derived from the endpoint that would be damaging on its own:
 * the whole URL, its host, and each path segment long enough to be a token.
 */
function needles(): Needle[] {
  const found: Needle[] = []
  const seen = new Set<string>()
  const add = (label: string, value: string, fatal = true) => {
    const trimmed = value.trim()
    if (trimmed.length < 8) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ label, value: trimmed, fatal })
  }

  for (const name of CREDENTIAL_VARS) {
    const raw = process.env[name]
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      add(`${name} (unparseable value)`, raw)
      continue
    }
    // A public endpoint carries no token, and the cluster defaults in
    // src/shared/clusters.ts name them deliberately, so finding one in the
    // bundle is expected rather than a leak.
    if (PUBLIC_HOSTS.test(url.hostname)) {
      console.log(`  skipping    ${name} — public endpoint (${url.hostname}), carries no credential`)
      continue
    }
    add(`${name} (full URL)`, raw)
    add(`${name} host`, url.hostname)
    const [first] = url.hostname.split('.')
    if (first) add(`${name} subdomain`, first)
    for (const segment of url.pathname.split('/')) add(`${name} path segment`, segment)
    for (const value of url.searchParams.values()) add(`${name} query value`, value)
    if (url.password) add(`${name} password`, url.password)
  }

  for (const name of DATABASE_VARS) {
    const raw = process.env[name]
    if (!raw) continue
    add(`${name} (full URL)`, raw)
    try {
      const url = new URL(raw)
      if (url.password) add(`${name} password`, decodeURIComponent(url.password))
    } catch {
      /* an unparseable value is still searched for whole, above */
    }
  }

  // Provider names, in case an endpoint is configured that this run cannot see.
  add('provider name "quiknode"', 'quiknode')
  add('provider name "quicknode"', 'quicknode')
  add('provider name "helius"', 'helius')
  add('provider name "alchemy"', 'alchemy')
  return found
}

function filesIn(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(dir)
  return out
}

let leaks = 0
const targets = needles()

console.log('Voxels · bundle credential audit')
console.log(`  searching   ${DIRS.join(', ')}`)
console.log(`  needles     ${targets.length}`)
const configured = [...CREDENTIAL_VARS, ...DATABASE_VARS].filter(name => process.env[name])
console.log(`  from env    ${configured.length ? configured.join(', ') : 'none set — provider-name checks only'}`)
if (!configured.length) {
  console.log('\n  NOTE: no endpoint variables are set in this shell, so the audit could')
  console.log('        not search for a real token. Run it with the same environment the')
  console.log('        build uses (npm run audit:bundle loads .env) for a meaningful result.')
}

for (const dir of DIRS) {
  let files: string[]
  try {
    files = filesIn(dir)
  } catch {
    console.log(`\n${dir}: MISSING — run the build first`)
    leaks += 1
    continue
  }
  const blobs = files.map(path => ({ path, text: readFileSync(path, 'utf8') }))
  const bytes = blobs.reduce((total, blob) => total + Buffer.byteLength(blob.text), 0)
  console.log(`\n${dir} — ${files.length} files, ${bytes.toLocaleString()} bytes`)

  for (const needle of targets) {
    const hits = blobs.filter(blob => blob.text.toLowerCase().includes(needle.value.toLowerCase()))
    if (hits.length === 0) {
      console.log(`  clean   ${needle.label}`)
    } else {
      leaks += 1
      console.log(`  LEAK    ${needle.label} — found in ${hits.map(h => h.path).join(', ')}`)
    }
  }

  // Everything the bundle could talk to, so an unexpected host is visible
  // even if it matched none of the needles above.
  const hosts = new Set<string>()
  for (const blob of blobs) {
    for (const match of blob.text.matchAll(/https?:\/\/[A-Za-z0-9._~:\-]+/g)) {
      try {
        hosts.add(new URL(match[0]).host)
      } catch {
        /* not a usable URL */
      }
    }
  }
  console.log(`  hosts referenced: ${[...hosts].sort().join(', ') || 'none'}`)
}

console.log(`\n${leaks === 0 ? 'PASS — no credential material in the build output' : `FAIL — ${leaks} problem(s)`}`)
process.exit(leaks === 0 ? 0 : 1)
