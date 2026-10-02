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

import { createHash } from 'node:crypto'

/** Shorter than this and a path segment is a route name, not a credential. */
const TOKEN_MIN_LENGTH = 8

const PLACEHOLDER = '[redacted-rpc-endpoint]'

/**
 * Env vars that may hold a credential.
 *
 * Keyed provider URLs carry the token in the path; a managed Postgres URL
 * carries the password in the userinfo. Both are the kind of value a driver
 * puts verbatim into a connection error, so both belong in this list rather
 * than in a second scrubber somewhere else.
 */
const CREDENTIAL_ENV_VARS = [
  'SOLANA_RPC_URL',
  'SOLANA_RPC_URL_MAINNET_BETA',
  'SOLANA_RPC_URL_DEVNET',
  'SOLANA_RPC_URL_TESTNET',
  'DATABASE_URL',
  'WALLY_DATABASE_URL',
]

/**
 * Hostnames that are not worth treating as secret material.
 *
 * A managed database URL's host is not a credential on its own, and adding
 * `localhost` to the pattern would replace that word everywhere it appears in
 * a log line. The password and the whole URL are what matter.
 */
const NON_SECRET_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db'])

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A value this short in a credential variable is a leftover, not a credential.
 *
 * Deployments arrive with these set to `null`, `none` or `-` by a blueprint
 * that had nothing to put in them, and treating such a value as secret turns
 * the scrubber into a find-and-replace for a common English word across every
 * log line and every response body. `null` is the one that did real damage, so
 * the floor is the same `TOKEN_MIN_LENGTH` already applied to path segments:
 * nothing shorter can carry an access token anyway.
 */
function fragmentsFor(raw: string): string[] {
  const value = raw.trim()
  if (value.length < TOKEN_MIN_LENGTH) return []
  const fragments = new Set<string>([value, value.replace(/\/+$/, '')])
  try {
    const url = new URL(value)
    if (!NON_SECRET_HOSTS.has(url.hostname.toLowerCase())) {
      fragments.add(url.origin)
      fragments.add(url.host)
      fragments.add(url.hostname)
    }
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

/**
 * Bearer tokens, wherever they appear in text.
 *
 * Two shapes, both of which this server genuinely produces. `Authorization: Bearer
 * <token>` turns up in any dump of request headers, and `?token=<token>` is how the
 * PvP WebSocket carries its session, because a browser cannot set headers on a
 * WebSocket upgrade — which means the session token is in the upgrade URL, and an
 * upgrade URL is exactly what a connection error quotes.
 *
 * A session token is not a key and cannot sign anything, but it is live authority
 * over one account's records for as long as it lasts, so it does not belong in a
 * log file. These are value-independent patterns rather than env fragments, so
 * unlike the URL scrubber they work whether or not anything is configured.
 *
 * Deliberately narrow. A response body carries a freshly issued token as the JSON
 * field `"token":"..."`, which the client needs and which these patterns do not
 * match — scrubbing that would break sign-in.
 */
const BEARER_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: 'Bearer [redacted-session-token]' },
  { pattern: /([?&](?:token|access_token|guestKey)=)[^&\s"']{8,}/gi, replacement: '$1[redacted-session-token]' },
]

/** Replaces every known credential fragment, and any bearer token, in a string. */
export function redact(text: string): string {
  let out = text
  for (const { pattern, replacement } of BEARER_PATTERNS) out = out.replace(pattern, replacement)
  if (!secretPattern) return out
  return out.replace(secretPattern, PLACEHOLDER)
}

/** Recursively redacts strings inside a JSON-serialisable value. */
export function redactDeep<T>(value: T): T {
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

/**
 * True when `text` still contains something that looks like live authority.
 *
 * Used by the test suite to assert that no response or log line carries a bearer
 * token. It is a detector, not a scrubber: `redact` is the choke point, and this
 * exists to prove the choke point is actually in the path.
 */
export function looksUnredacted(text: string): boolean {
  // The placeholder is itself a run of token-shaped characters, so it has to be
  // taken out before asking whether anything token-shaped is left.
  const withoutPlaceholders = text.replaceAll('[redacted-session-token]', '')
  return BEARER_PATTERNS.some(({ pattern }) =>
    new RegExp(pattern.source, pattern.flags.replace('g', '')).test(withoutPlaceholders),
  )
}

/**
 * A short, non-reversible tag for a secret, so boot output can prove which
 * value is loaded without disclosing any of it.
 *
 * Twelve hex characters of SHA-256 is enough to tell "the production URL" from
 * "the staging URL" at a glance and far too little to recover either.
 */
export function secretFingerprint(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return 'unset'
  return `sha256:${createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 12)}`
}
