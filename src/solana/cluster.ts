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
 * Two rules, in this order:
 *
 *   1. An explicit *non-loopback* `VITE_API_BASE_URL` wins. That is a real
 *      deployment naming its own API, and it is the only way this client will
 *      ever address a host other than the one the page came from.
 *   2. Otherwise the client uses the page origin, expressed as the empty
 *      prefix, so every request is a same-origin relative `/api/...`. In dev
 *      the Vite server proxies `/api` and `/ws` to the API on this machine.
 *
 * A baked `VITE_API_BASE_URL=http://127.0.0.1:8787` — the default in local
 * `.env` files — is therefore ignored in the browser. It is correct only on the
 * machine that built it: a friend who opens `http://192.168.x.x:5173` would be
 * sent to *their* loopback, which is a different computer, and the proxy makes
 * the absolute URL unnecessary even on this one.
 *
 * What this cannot do is know whether the page origin actually serves an API.
 * A static host answers `/api/rpc` with its own 404 page, and @solana/web3.js
 * quotes that page back verbatim as `404 : …`. `probeApi()` in `api.ts` is what
 * turns that into a named configuration error instead of a bare 404.
 */
function resolveApiBaseUrl(): string {
  const configured = (viteEnv.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location?.hostname) {
    if (configured) {
      try {
        if (!isLoopbackHostname(new URL(configured).hostname)) return configured
      } catch {
        /* ignore an unparseable override and fall through to the page origin */
      }
    }
    return ''
  }
  return configured || 'http://127.0.0.1:8787'
}

/**
 * Prefix for every API request. Empty means "same origin as this page", which
 * is the default, so `${API_BASE_URL}/api/gold` is a relative `/api/gold`.
 */
export const API_BASE_URL = resolveApiBaseUrl()

/**
 * The same base, always absolute, for the two things that cannot take a
 * relative URL: `@solana/web3.js`'s `Connection`, which parses its endpoint,
 * and error text, which has to name the host the player's browser actually
 * tried.
 */
export const API_ORIGIN: string =
  API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin.replace(/\/+$/, '') : 'http://127.0.0.1:8787')

/** True when the API is assumed to live on the page's own origin. */
export const API_IS_SAME_ORIGIN = API_BASE_URL === ''

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
export const RPC_PROXY_URL = `${API_ORIGIN}/api/rpc`

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
 * Two states, decided by the configured cluster and nothing else: a demo
 * state must never look real, and a real state must never look like a
 * demo. Every badge in the app derives its text from `fundsLabel` so the
 * two can never drift apart.
 *
 * There used to be a third state for "a wallet is connected", which meant
 * Phantom. Nothing connects any more — the browser-held keypair in
 * `embeddedWallet.ts` is always there and signs messages only — so a
 * connection flag would have been a branch that could never be taken, and
 * a label that said "not connected" would have been describing a thing
 * this app no longer has.
 * ------------------------------------------------------------------ */

export type FundsMode =
  /** A test cluster. The SOL on it is worth nothing. */
  | 'demo'
  /** mainnet-beta. The browser's wallet address is a real mainnet address. */
  | 'live'

export type FundsLabel = { mode: FundsMode; short: string; long: string }

/**
 * What is true in both states, and the reason neither of them is an alarm:
 * there is no transaction signer anywhere in this client. The browser-held
 * key signs UTF-8 challenges to prove identity and has no `signTransaction`
 * of any kind, so no sequence of clicks in this app can move value — not on
 * devnet and not on mainnet.
 *
 * `live` therefore names the network rather than warning about it, and says
 * the one thing that *is* at stake on mainnet: the address is real, so SOL
 * sent to it is real, and only the key holder can ever move it back out.
 */
export function fundsLabel(): FundsLabel {
  if (IS_MAINNET) {
    return {
      mode: 'live',
      short: 'MAINNET',
      long:
        'Mainnet-beta. The wallet in this browser is a real mainnet address, so anything you send to it is real SOL. ' +
        'This app cannot spend it: the key signs messages only and there is no transaction signer in the client at all.',
    }
  }
  return {
    mode: 'demo',
    short: 'DEMO · NO REAL FUNDS',
    long: `The app is pointed at ${CLUSTER}, where SOL is worth nothing, and the client has no transaction signer in any case. Nothing in this session can send value.`,
  }
}

/** Solana Explorer deep links. The cluster query is omitted on mainnet, as the explorer expects. */
function explorerUrl(path: string) {
  const suffix = IS_MAINNET ? '' : `?cluster=${CLUSTER === 'mainnet-beta' ? 'mainnet' : CLUSTER}`
  return `https://explorer.solana.com/${path}${suffix}`
}

export const explorerAddress = (address: string) => explorerUrl(`address/${encodeURIComponent(address)}`)

/** Middle-truncated address for display. Never used for comparison or signing. */
export function truncateAddress(address: string, lead = 4, tail = 4) {
  return address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`
}
