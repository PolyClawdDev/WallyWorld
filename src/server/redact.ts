/* ------------------------------------------------------------------ *
 * Secret scrubbing for anything that leaves this process.
 *
 * The RPC endpoint URL is a credential: providers such as QuickNode embed
 * the access token in the URL path, so whoever holds the URL can spend
 * the operator's quota. It must not appear in an HTTP response, in a log
 * line, or in a stack trace.
 *
 * That is harder than it looks, because the leak usually is not ours.
 * `fetch` and `@solana/web3.js` both put the endpoint they were talking
 * to into their error messages, and those messages are exactly what a
 * naive handler forwards to the client or prints to stdout. So rather
 * than trying to remember to sanitise at every call site, this module
 * builds a list of secret fragments once and every outbound string is
 * pushed through `redact` at the boundary — the JSON writer and the
 * logger — which makes the safe path the default one.
 *
 * Fragments include the whole URL, its origin, its hostname, and any
 * path segment or query value long enough to be a token, so a message
 * that mentions only the host is caught too.
 * ------------------------------------------------------------------ */

/** Shorter than this and a path segment is a route name, not a credential. */
const TOKEN_MIN_LENGTH = 8

const PLACEHOLDER = '[redacted-rpc-endpoint]'

/** Env vars that may hold a keyed provider URL. */
const CREDENTIAL_ENV_VARS = [
  'SOLANA_RPC_URL',
  'SOLANA_RPC_URL_MAINNET_BETA',
  'SOLANA_RPC_URL_DEVNET',
  'SOLANA_RPC_URL_TESTNET',
]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function fragmentsFor(raw: string): string[] {
  const value = raw.trim()
  if (!value) return []
  const fragments = new Set<string>([value, value.replace(/\/+$/, '')])
  try {
    const url = new URL(value)
    fragments.add(url.origin)
    fragments.add(url.host)
    fragments.add(url.hostname)
    for (const segment of url.pathname.split('/')) {
      if (segment.length >= TOKEN_MIN_LENGTH) fragments.add(segment)
    }
    url.searchParams.forEach(param => {
      if (param.length >= TOKEN_MIN_LENGTH) fragments.add(param)
    })
    if (url.username) fragments.add(url.username)
    if (url.password) fragments.add(url.password)
  } catch {
    /* not a URL: the raw value is still treated as secret */
  }
  return [...fragments].filter(Boolean)
}

/**
 * Built once at startup. Longest fragments first, so the full URL is replaced
 * before its own hostname would be, which keeps the output readable.
 */
const secretPattern: RegExp | null = (() => {
  const fragments = new Set<string>()
  for (const name of CREDENTIAL_ENV_VARS) {
    for (const fragment of fragmentsFor(process.env[name] ?? '')) fragments.add(fragment)
  }
  if (fragments.size === 0) return null
  const ordered = [...fragments].sort((a, b) => b.length - a.length).map(escapeRegExp)
  return new RegExp(ordered.join('|'), 'gi')
})()

/** Replaces every known credential fragment in a string. */
export function redact(text: string): string {
  if (!secretPattern) return text
  return text.replace(secretPattern, PLACEHOLDER)
}

/** Recursively redacts strings inside a JSON-serialisable value. */
export function redactDeep<T>(value: T): T {
  if (!secretPattern) return value
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item)
    return out as unknown as T
  }
  return value
}

/**
 * A single-line, redacted description of an error, with no stack.
 *
 * Stacks are dropped rather than redacted: they carry filesystem paths and
 * internals that a client has no business seeing, and the message is the only
 * part that is ever useful to a caller. Undici nests the real cause one level
 * down, which is where the endpoint usually appears.
 */
export function describeUpstreamError(error: unknown): string {
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.message)
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) parts.push(cause.message)
    else if (typeof cause === 'string') parts.push(cause)
  } else if (typeof error === 'string') {
    parts.push(error)
  } else {
    parts.push('unrecognised upstream error')
  }
  return redact(parts.join(': ')).slice(0, 300)
}

/** Console writers that scrub before printing, so no log line can carry the URL. */
export const safeLog = (...args: unknown[]) => console.log(...args.map(arg => (typeof arg === 'string' ? redact(arg) : redactDeep(arg))))
export const safeError = (...args: unknown[]) =>
  console.error(...args.map(arg => (arg instanceof Error ? describeUpstreamError(arg) : typeof arg === 'string' ? redact(arg) : redactDeep(arg))))

/** Exposed for the verification script, which asserts the scrubber actually fires. */
export const hasSecrets = () => secretPattern !== null
