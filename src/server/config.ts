/* ------------------------------------------------------------------ *
 * Server configuration, read from the environment only.
 *
 * Nothing here has a secret default and nothing is committed: `.env` is
 * gitignored and `.env.example` carries empty placeholders. The server
 * holds no private key of any kind — it verifies signatures and reads the
 * chain, and it has no signing authority, so there is no treasury key to
 * leak.
 * ------------------------------------------------------------------ */

import { PUBLIC_RPC, chainIdFor, normaliseCluster } from '../shared/clusters'
import { hostnameOf, isPrivateSiteHostname } from '../shared/hosts'

const env = (key: string): string => (process.env[key] ?? '').trim()

/**
 * Problems found while reading configuration, reported together at boot.
 *
 * Collecting rather than throwing on the first fault means an operator fixes
 * one deploy's worth of mistakes in one pass instead of discovering them one
 * restart at a time. Only the variable NAME is ever recorded — never the value,
 * because a malformed secret is still a secret.
 */
const problems: string[] = []

const configProblem = (message: string) => {
  problems.push(message)
}

function intEnv(key: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const raw = env(key)
  if (!raw) return fallback
  const parsed = Number(raw)
  const min = bounds.min ?? 1
  if (!Number.isInteger(parsed) || parsed < min || (bounds.max !== undefined && parsed > bounds.max)) {
    configProblem(`${key} must be an integer${bounds.max === undefined ? ` >= ${min}` : ` between ${min} and ${bounds.max}`}`)
    return fallback
  }
  return parsed
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = env(key).toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  configProblem(`${key} must be one of 1/0/true/false/yes/no/on/off`)
  return fallback
}

/* ------------------------------------------------------------------ *
 * Deployment shape.
 *
 * `production` is what a hosting platform sets, and it is the switch that
 * turns off every local convenience: private-LAN origins stop being
 * automatically trusted, a public origin becomes mandatory, and the health
 * endpoint stops volunteering interface addresses.
 * ------------------------------------------------------------------ */

export const NODE_ENV = env('NODE_ENV') || 'development'
export const IS_PRODUCTION = NODE_ENV === 'production'

/**
 * Render, Fly, Heroku and the rest all assign the port and expect the process
 * to listen on every interface inside its container. There is no correct
 * hardcoded value, so `PORT` wins whenever it is set.
 */
export const PORT = intEnv('PORT', IS_PRODUCTION ? 10000 : 8787, { min: 1, max: 65535 })

/**
 * The interface to bind.
 *
 * `0.0.0.0` in both modes, for different reasons: in a container it is the
 * only address the platform's router can reach, and locally it is what lets a
 * friend on the same Wi-Fi open the game. It stays overridable so a operator
 * who wants loopback-only development can have it.
 */
export const BIND_HOST = env('WALLY_BIND') || '0.0.0.0'

/** Documented Vite / UI port. Logged so the host can send the LAN URL. */
export const UI_PORT = intEnv('WALLY_UI_PORT', 5173, { min: 1, max: 65535 })

/**
 * How many reverse proxies sit in front of this process.
 *
 * This is the number of hops whose `X-Forwarded-For` entries are ours to
 * believe. Behind Render's router that is exactly 1. Getting it wrong in
 * either direction breaks rate limiting: too low and every client shares one
 * bucket (the proxy's address), too high and a client spoofs its own bucket
 * key by sending its own `X-Forwarded-For`. There is no safe default above
 * zero, so it must be set deliberately.
 */
export const TRUST_PROXY_HOPS = intEnv('WALLY_TRUST_PROXY_HOPS', IS_PRODUCTION ? 1 : 0, { min: 0, max: 8 })

/**
 * The origin players actually type, e.g. `https://voxels.example.com`.
 *
 * Required in production and used for the allowlist, for the SIWS domain
 * binding, and for the boot banner. It is not a secret.
 */
export const PUBLIC_ORIGIN: string | null = (() => {
  const raw = env('WALLY_PUBLIC_ORIGIN').replace(/\/+$/, '')
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      configProblem('WALLY_PUBLIC_ORIGIN must be an http or https origin')
      return null
    }
    if (IS_PRODUCTION && url.protocol !== 'https:') {
      configProblem('WALLY_PUBLIC_ORIGIN must use https in production — WebSocket upgrades over ws:// are redirected and fail')
    }
    return url.origin
  } catch {
    configProblem('WALLY_PUBLIC_ORIGIN is not a valid URL')
    return null
  }
})()

/** Seconds the process keeps draining after SIGTERM. Render allows up to 300. */
export const SHUTDOWN_GRACE_MS = intEnv('WALLY_SHUTDOWN_GRACE_MS', 25_000, { min: 1_000, max: 300_000 })

/**
 * Declared capacity of the single world.
 *
 * One process owns one world. There is no room ownership or routing in this
 * codebase, so a second instance would be a second, separate town wearing the
 * same URL. The cap is enforced at the socket upgrade and published on
 * `/api/health` so the number is a promise rather than a hope.
 */
export const ROOM_CAPACITY = intEnv('WALLY_ROOM_CAPACITY', 64, { min: 1, max: 512 })

export const CLUSTER = normaliseCluster(env('SOLANA_CLUSTER'))
export const IS_MAINNET = CLUSTER === 'mainnet-beta'
export const CHAIN_ID = chainIdFor(CLUSTER)

/* ------------------------------------------------------------------ *
 * RPC endpoint resolution.
 *
 * Endpoints are resolved per cluster, so a keyed mainnet provider URL is
 * only ever used when mainnet is actually selected. The alternative — one
 * generic SOLANA_RPC_URL — means a devnet run silently talks to a paid
 * mainnet endpoint and reports mainnet balances under a devnet label,
 * which is both a quota leak and the exact "real state looks like a demo"
 * failure this app is meant to avoid.
 *
 * Order for the selected cluster:
 *   1. SOLANA_RPC_URL_<CLUSTER>   e.g. SOLANA_RPC_URL_MAINNET_BETA
 *   2. SOLANA_RPC_URL             generic, applies to whatever is selected
 *   3. the public Solana endpoint, for devnet and testnet only
 *
 * The resolved URL is treated as a credential everywhere downstream: it is
 * never logged, never returned, and never sent to the browser. Only the
 * *name* of the variable it came from is safe to print.
 * ------------------------------------------------------------------ */

const clusterEnvSuffix = CLUSTER.toUpperCase().replace(/-/g, '_')

function readRpc(): { url: string; sourceVar: string; isPublic: boolean } {
  const scopedVar = `SOLANA_RPC_URL_${clusterEnvSuffix}`
  const scoped = env(scopedVar)
  if (scoped) return { url: scoped, sourceVar: scopedVar, isPublic: scoped === PUBLIC_RPC[CLUSTER] }

  const generic = env('SOLANA_RPC_URL')
  if (generic) return { url: generic, sourceVar: 'SOLANA_RPC_URL', isPublic: generic === PUBLIC_RPC[CLUSTER] }

  if (IS_MAINNET) {
    configProblem(
      `SOLANA_CLUSTER=mainnet-beta requires ${scopedVar} (or SOLANA_RPC_URL). The public mainnet endpoint is rate-limited and unsuitable for an application; configure a provider endpoint such as QuickNode or Helius.`,
    )
  }
  return { url: PUBLIC_RPC[CLUSTER], sourceVar: `public ${CLUSTER} endpoint`, isPublic: true }
}

const resolved = readRpc()

/** Credential. Never log this, never put it in a response, never ship it to the browser. */
export const RPC_URL = resolved.url

/** Safe to print: the variable name, not its value. */
export const RPC_SOURCE_VAR = resolved.sourceVar

/** True for a Solana-operated public endpoint, which carries no credential. */
export const RPC_IS_PUBLIC = resolved.isPublic

export const DB_PATH = env('WALLY_DB_PATH') || 'data/wally.db'

/**
 * Financial records live in their own database file, never alongside game data.
 *
 * A separate file is the strongest available form of "no foreign key crosses the
 * boundary": SQLite cannot declare a foreign key into another database, so the
 * separation is enforced by the engine rather than by reviewer discipline. The
 * financial side therefore stores `user_id` as an opaque string and resolves
 * identity through the identity module, not through a join.
 *
 * Derived from WALLY_DB_PATH unless overridden, so one setting still moves both.
 */
export const FINANCE_DB_PATH = env('WALLY_FINANCE_DB_PATH') || DB_PATH.replace(/(\.db)?$/, '') + '-finance.db'

/* ------------------------------------------------------------------ *
 * Database driver selection.
 *
 * The schema, the migrations and the SQL are not decided here: this block
 * only chooses which low-level driver the rest of the server talks through,
 * so a managed Postgres can back production while local development keeps
 * the zero-setup SQLite file. Both logical databases — game and finance —
 * move together, because a deployment that put one on Postgres and the other
 * on a container filesystem would silently lose the second on every redeploy.
 *
 * `DATABASE_URL` is a credential: the password is in the userinfo. It is
 * registered in `redact.ts` and is never printed, only fingerprinted.
 * ------------------------------------------------------------------ */

export type DbDriverName = 'sqlite' | 'postgres'

/** Credential. Never log this; use `secretFingerprint` if you need to identify it. */
export const DATABASE_URL: string | null = env('DATABASE_URL') || env('WALLY_DATABASE_URL') || null

export const DB_DRIVER: DbDriverName = (() => {
  const explicit = env('WALLY_DB_DRIVER').toLowerCase()
  if (explicit && explicit !== 'sqlite' && explicit !== 'postgres') {
    configProblem('WALLY_DB_DRIVER must be "sqlite" or "postgres"')
    return DATABASE_URL ? 'postgres' : 'sqlite'
  }
  const chosen: DbDriverName = explicit ? (explicit as DbDriverName) : DATABASE_URL ? 'postgres' : 'sqlite'
  if (chosen === 'postgres') {
    if (!DATABASE_URL) {
      configProblem('WALLY_DB_DRIVER=postgres requires DATABASE_URL')
    } else {
      try {
        const url = new URL(DATABASE_URL)
        if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
          configProblem('DATABASE_URL must start with postgres:// or postgresql://')
        }
        if (!url.hostname) configProblem('DATABASE_URL has no host')
      } catch {
        // Deliberately shapeless: quoting the malformed value would print the password.
        configProblem('DATABASE_URL is not a valid URL')
      }
    }
  }
  return chosen
})()

/**
 * The driver seam exists, but the ledger does not sit on it yet.
 *
 * `src/server/store/index.ts` opens both databases through `store/sqlite.ts`
 * unconditionally, because the world tick reads gold synchronously and the
 * Postgres driver is async. So selecting `postgres` today would move the
 * readiness probe onto Postgres while every account, ledger entry, receipt and
 * wallet link kept landing in a SQLite file — on a host with no persistent
 * disk, destroyed on the next deploy, behind a green probe. Refusing to boot is
 * the only honest answer until `store/` is converted.
 */
if (DB_DRIVER === 'postgres') {
  configProblem(
    'WALLY_DB_DRIVER=postgres is not yet supported by the ledger: src/server/store/ is still ' +
      'synchronous SQLite, so Postgres would be probed as healthy while accounts, gold and receipts ' +
      'were written to a file that does not survive a deploy. Use sqlite with a persistent disk, or ' +
      'convert src/server/store/ to the async driver in src/server/sql/ first.',
  )
}

/**
 * Schema that separates the two logical databases inside one Postgres
 * instance, mirroring the two SQLite files. A managed plan gives you one
 * database, not two, so the boundary is expressed as a schema there.
 */
export const DB_FINANCE_SCHEMA = env('WALLY_DB_FINANCE_SCHEMA') || 'finance'

/** Pool ceiling per driver handle. Render's smaller Postgres plans allow 100 connections in total. */
export const DB_POOL_MAX = intEnv('WALLY_DB_POOL_MAX', 8, { min: 1, max: 100 })

/** Managed Postgres requires TLS; a local container usually does not. */
export const DB_SSL = boolEnv('WALLY_DB_SSL', IS_PRODUCTION && DB_DRIVER === 'postgres')

/* ------------------------------------------------------------------ *
 * Origin policy.
 *
 * Local development trusts loopback and private LAN origins automatically,
 * because that is the entire point of playing over Wi-Fi with someone in the
 * same room. Production does not: on a public host, "the request came from a
 * 10.x address" tells you nothing about who sent it, and an automatic
 * allowance there would let a page on any private network drive this API. In
 * production the list is exactly what the operator wrote down.
 * ------------------------------------------------------------------ */

const DEFAULT_DEV_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'

export const ALLOWED_ORIGINS: readonly string[] = (() => {
  const configured = env('WALLY_ALLOWED_ORIGINS')
  const raw = configured || (IS_PRODUCTION ? '' : DEFAULT_DEV_ORIGINS)
  const list: string[] = []
  for (const entry of raw.split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean)) {
    try {
      const url = new URL(entry)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        configProblem('WALLY_ALLOWED_ORIGINS contains an entry that is neither http nor https')
        continue
      }
      if (!list.includes(url.origin)) list.push(url.origin)
    } catch {
      configProblem('WALLY_ALLOWED_ORIGINS contains an entry that is not a valid origin')
    }
  }
  if (PUBLIC_ORIGIN && !list.includes(PUBLIC_ORIGIN)) list.push(PUBLIC_ORIGIN)
  if (IS_PRODUCTION && list.length === 0) {
    configProblem('production needs WALLY_PUBLIC_ORIGIN or WALLY_ALLOWED_ORIGINS — otherwise no browser origin can reach the API at all')
  }
  return list
})()

/** True only outside production, where a LAN address really does mean "someone in the room". */
export const TRUST_PRIVATE_ORIGINS = !IS_PRODUCTION

export function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  const clean = origin.replace(/\/+$/, '')
  if (ALLOWED_ORIGINS.includes(clean)) return true
  if (!TRUST_PRIVATE_ORIGINS) return false
  try {
    const url = new URL(clean)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return isPrivateSiteHostname(url.hostname)
  } catch {
    return false
  }
}

export function isAllowedPageHost(host: string): boolean {
  if (SIWS_DOMAINS.includes(host)) return true
  if (!TRUST_PRIVATE_ORIGINS) return false
  return isPrivateSiteHostname(hostnameOf(host))
}

/**
 * Hostnames accepted in the `domain` field of a sign-in message. Derived from
 * the allowed origins unless overridden, so the signed domain binding and the
 * CORS policy cannot disagree.
 */
export const SIWS_DOMAINS: readonly string[] = (() => {
  const explicit = env('WALLY_SIWS_DOMAINS')
  if (explicit) return explicit.split(',').map(value => value.trim()).filter(Boolean)
  return ALLOWED_ORIGINS.flatMap(origin => {
    try {
      return [new URL(origin).host]
    } catch {
      return []
    }
  })
})()

export const NONCE_TTL_MS = intEnv('WALLY_NONCE_TTL_MS', 5 * 60 * 1000)
export const SESSION_TTL_MS = intEnv('WALLY_SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000)

/**
 * Where an NPC service fee is paid. There is no default: paying an address this
 * repository invented would send real money to a keypair nobody controls, so the
 * payment feature stays switched off until an operator sets this.
 */
export const NPC_PAYEE_ADDRESS: string | null = env('NPC_PAYEE_ADDRESS') || null

/** Integer lamports, as a bigint. 0.001 SOL by default. */
export const SERVICE_PRICE_LAMPORTS: bigint = (() => {
  const raw = env('NPC_SERVICE_PRICE_LAMPORTS')
  if (!raw) return 1_000_000n
  if (!/^\d+$/.test(raw)) {
    configProblem('NPC_SERVICE_PRICE_LAMPORTS must be a whole number of lamports')
    return 1_000_000n
  }
  const value = BigInt(raw)
  if (value <= 0n) {
    configProblem('NPC_SERVICE_PRICE_LAMPORTS must be greater than zero')
    return 1_000_000n
  }
  return value
})()

export const PAYMENTS_ENABLED = NPC_PAYEE_ADDRESS !== null

/**
 * Gold-to-token payout. Hardcoded off, and not switchable by configuration:
 * see the README for what would have to exist first.
 */
export const PAYOUTS_ENABLED = false as const

/* ------------------------------------------------------------------ *
 * Boot gate.
 *
 * Every malformed setting collected above is reported at once and the
 * process refuses to start. Failing here rather than at first use is the
 * whole point: a server that boots with a broken origin list looks healthy
 * to the platform's health check and is unusable to every player.
 *
 * The report names variables and describes the fault. It never quotes a
 * value, because the fault is often in a secret and "malformed" is not a
 * reason to print one.
 * ------------------------------------------------------------------ */

export const configProblems: readonly string[] = problems

export function assertConfigValid(): void {
  if (problems.length === 0) return
  const lines = problems.map((problem, index) => `  ${index + 1}. ${problem}`).join('\n')
  throw new Error(
    `Voxels refuses to start: ${problems.length} configuration problem(s).\n${lines}\n` +
      '\nNo value is shown above on purpose — a malformed secret is still a secret.\n' +
      'See .env.production.example for the full list of settings.',
  )
}
