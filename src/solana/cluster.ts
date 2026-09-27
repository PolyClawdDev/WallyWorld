/// <reference types="vite/client" />
/* ------------------------------------------------------------------ *
 * Network configuration and the one source of truth for whether real
 * funds are in play.
 *
 * Defaults to devnet. mainnet-beta is an explicit opt-in.
 *
 * Chain reads go through the backend's `/api/rpc` proxy by default, so the
 * browser never holds a provider endpoint. That matters because a keyed
 * provider URL is itself the credential, and any VITE_* value is compiled
 * into the public bundle.
 *
 * No provider URL or API key is hardcoded anywhere in this file, and none
 * can be introduced through a VITE_* variable on mainnet.
 * ------------------------------------------------------------------ */

import { PUBLIC_RPC, chainIdFor, normaliseCluster, type Cluster } from '../shared/clusters'
import { isLoopbackHostname } from '../shared/hosts'

export type { Cluster }

/**
 * In the browser this is `import.meta.env`, which Vite substitutes at build
 * time. Under plain Node — where `scripts/verify-solana.ts` imports this module
 * so the tests exercise the real client code rather than a reimplementation of
 * it — `import.meta.env` does not exist, so the same VITE_* names are read from
 * `process.env` instead. `process` is absent in the browser, so the bundle is
 * unaffected.
 */
const viteEnv: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ??
  (typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>))

export const CLUSTER: Cluster = normaliseCluster(viteEnv.VITE_SOLANA_CLUSTER)
export const IS_MAINNET = CLUSTER === 'mainnet-beta'

/**
 * Where the browser talks to this world's API.
 *
 * A baked `VITE_API_BASE_URL=http://127.0.0.1:8787` is the default in local
 * `.env` files. That is correct only when the page itself was loaded from
 * loopback. If a friend opens `http://192.168.x.x:5173`, sending them to
 * *their* 127.0.0.1 is a different computer — they never join this world.
 *
 * In the browser we therefore use the page origin (Vite proxies `/api` and
 * `/ws` to the API on this machine) whenever the configured URL is loopback
 * and the page is not. An explicit non-loopback `VITE_API_BASE_URL` still
 * wins, for a real deploy. The QuickNode URL never belongs here.
 */
function resolveApiBaseUrl(): string {
  const configured = (viteEnv.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location?.hostname) {
    if (configured) {
      try {
        const apiHost = new URL(configured).hostname
        const pageHost = window.location.hostname
        if (!(isLoopbackHostname(apiHost) && !isLoopbackHostname(pageHost))) return configured
      } catch {
        /* ignore an unparseable override and fall through to the page origin */
      }
    }
    return window.location.origin.replace(/\/+$/, '')
  }
  return configured || 'http://127.0.0.1:8787'
}

export const API_BASE_URL = resolveApiBaseUrl()

export function wsBaseUrl(apiBase = API_BASE_URL): string {
  if (apiBase.startsWith('https:')) return apiBase.replace(/^https/, 'wss')
  if (apiBase.startsWith('http:')) return apiBase.replace(/^http/, 'ws')
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}`
  }
  return 'ws://127.0.0.1:8787'
}

/** The backend's JSON-RPC proxy. Holds no credential, so it is safe in the bundle. */
export const RPC_PROXY_URL = `${API_BASE_URL}/api/rpc`

const RPC_OVERRIDE = (viteEnv.VITE_SOLANA_RPC_URL ?? '').trim()

export type RpcConfig = {
  endpoint: string
  /** True when reads go through the backend proxy rather than straight to a provider. */
  viaProxy: boolean
  /** Only ever true for a Solana-operated public endpoint. */
  isPublicEndpoint: boolean
  /** Set when the configuration is unusable; the UI surfaces this instead of half-working. */
  problem?: string
} & ({ ok: true } | { ok: false; problem: string })

/**
 * Where the browser sends its RPC calls.
 *
 * The default is the backend proxy, and that is the only correct answer for
 * mainnet. A keyed provider URL — QuickNode embeds its access token in the URL
 * path — cannot go in a VITE_* variable, because Vite inlines those into the
 * JavaScript bundle where anyone who loads the page can read them. Routing
 * through the proxy keeps the credential on the server.
 *
 * `VITE_SOLANA_RPC_URL` remains as an escape hatch for devnet and local
 * validator work, where the endpoint carries no secret. It is refused outright
 * on mainnet: there is no way to put a mainnet provider URL in the bundle
 * safely, so the code does not offer the option.
 */
function readRpc(): RpcConfig {
  if (RPC_OVERRIDE) {
    let parsed: URL
    try {
      parsed = new URL(RPC_OVERRIDE)
    } catch {
      return { ok: false, endpoint: RPC_PROXY_URL, viaProxy: true, isPublicEndpoint: false, problem: 'VITE_SOLANA_RPC_URL is not a valid URL.' }
    }
    const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (parsed.protocol !== 'https:' && !isLocal) {
      return {
        ok: false,
        endpoint: RPC_PROXY_URL,
        viaProxy: true,
        isPublicEndpoint: false,
        problem: 'VITE_SOLANA_RPC_URL must use https (or point at localhost for a local validator).',
      }
    }
    if (IS_MAINNET && !isLocal) {
      return {
        ok: false,
        endpoint: RPC_PROXY_URL,
        viaProxy: true,
        isPublicEndpoint: false,
        problem:
          'VITE_SOLANA_RPC_URL must not be used on mainnet. Anything in a VITE_* variable is compiled into the public JavaScript bundle, and a provider URL is a credential. Remove it and let mainnet traffic go through the backend proxy at /api/rpc, configuring SOLANA_RPC_URL_MAINNET_BETA on the server instead.',
      }
    }
    return { ok: true, endpoint: RPC_OVERRIDE, viaProxy: false, isPublicEndpoint: RPC_OVERRIDE === PUBLIC_RPC[CLUSTER] }
  }
  // No override: everything goes through the backend, on every cluster.
  return { ok: true, endpoint: RPC_PROXY_URL, viaProxy: true, isPublicEndpoint: false }
}

export const RPC: RpcConfig = readRpc()

export const CHAIN_ID = chainIdFor(CLUSTER)

/* ------------------------------------------------------------------ *
 * Funds labelling.
 *
 * Three states, and the distinction matters in both directions: a demo
 * state must never look real, and a real state must never look like a
 * demo. Every badge in the app derives its text from `fundsLabel` so the
 * two can never drift apart.
 * ------------------------------------------------------------------ */

export type FundsMode =
  /** Test cluster, no wallet connected. Nothing in the app can move value. */
  | 'demo'
  /** Test cluster, wallet connected: real signatures over worthless SOL. */
  | 'test'
  /** mainnet-beta. Real money. */
  | 'live'

/**
 * Note the asymmetry, which is deliberate.
 *
 * `live` depends only on the configured cluster, not on whether a wallet is
 * currently connected: on a mainnet build a real transfer is one click away, so
 * the warning must be up before the click, not after it. `demo` is the narrow
 * case — a test cluster with nothing connected — so a demo can never be dressed
 * up as real, and a real deployment can never be mistaken for a demo.
 */
export function fundsMode(walletConnected: boolean): FundsMode {
  if (IS_MAINNET) return 'live'
  return walletConnected ? 'test' : 'demo'
}

export type FundsLabel = { mode: FundsMode; short: string; long: string }

export function fundsLabel(walletConnected: boolean): FundsLabel {
  const mode = fundsMode(walletConnected)
  if (mode === 'live') {
    return {
      mode,
      short: 'MAINNET · REAL FUNDS',
      long: walletConnected
        ? 'Mainnet-beta. Anything you approve in Phantom moves real money and cannot be reversed.'
        : 'Mainnet-beta is configured. Connecting a wallet here exposes real money.',
    }
  }
  if (mode === 'test') {
    const name = CLUSTER === 'testnet' ? 'TESTNET' : 'DEVNET'
    return {
      mode,
      short: `${name} · TEST FUNDS`,
      long: `Connected on ${CLUSTER}. Signatures are real, but the SOL has no value and cannot be exchanged for anything.`,
    }
  }
  return {
    mode,
    short: 'DEMO · NO REAL FUNDS',
    long: `No wallet connected, and the app is pointed at ${CLUSTER}. Nothing in this session can send or receive value.`,
  }
}

/** Solana Explorer deep links. The cluster query is omitted on mainnet, as the explorer expects. */
function explorerUrl(path: string) {
  const suffix = IS_MAINNET ? '' : `?cluster=${CLUSTER === 'mainnet-beta' ? 'mainnet' : CLUSTER}`
  return `https://explorer.solana.com/${path}${suffix}`
}

export const explorerAddress = (address: string) => explorerUrl(`address/${encodeURIComponent(address)}`)
export const explorerTx = (signature: string) => explorerUrl(`tx/${encodeURIComponent(signature)}`)

/** Middle-truncated address for display. Never used for comparison or signing. */
export function truncateAddress(address: string, lead = 4, tail = 4) {
  return address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`
}
