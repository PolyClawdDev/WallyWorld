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

function intEnv(key: string, fallback: number): number {
  const raw = env(key)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`)
  return parsed
}

export const PORT = intEnv('PORT', 8787)
/** Listen on every interface so a second machine on the LAN can reach this world. */
export const BIND_HOST = env('WALLY_BIND') || '0.0.0.0'
/** Documented Vite / UI port. Logged so the host can send the LAN URL. */
export const UI_PORT = intEnv('WALLY_UI_PORT', 5173)

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
    throw new Error(
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
 * Extra browser origins allowed to call this API (comma-separated). Loopback
 * and private LAN origins are always accepted in addition to this list, so a
 * friend opening `http://192.168.x.x:5173` is not rejected as CORS. Public
 * internet origins still need an explicit entry — this laptop is not a
 * public host.
 */
export const ALLOWED_ORIGINS: readonly string[] = (env('WALLY_ALLOWED_ORIGINS') || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',')
  .map(value => value.trim().replace(/\/+$/, ''))
  .filter(Boolean)

export function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  const clean = origin.replace(/\/+$/, '')
  if (ALLOWED_ORIGINS.includes(clean)) return true
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
  if (!/^\d+$/.test(raw)) throw new Error('NPC_SERVICE_PRICE_LAMPORTS must be a whole number of lamports')
  const value = BigInt(raw)
  if (value <= 0n) throw new Error('NPC_SERVICE_PRICE_LAMPORTS must be greater than zero')
  return value
})()

export const PAYMENTS_ENABLED = NPC_PAYEE_ADDRESS !== null

/**
 * Gold-to-token payout. Hardcoded off, and not switchable by configuration:
 * see the README for what would have to exist first.
 */
export const PAYOUTS_ENABLED = false as const
