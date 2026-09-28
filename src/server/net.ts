/* ------------------------------------------------------------------ *
 * Client identity and request budgets, behind a reverse proxy.
 *
 * WHO IS THE CLIENT
 *   On a hosting platform every request arrives from the platform's
 *   router, so `socket.remoteAddress` is the router for all of them. Rate
 *   limiting on that value puts the entire internet in one bucket and the
 *   first busy player locks everyone out.
 *
 *   The real address is in `X-Forwarded-For`, which is a list the client
 *   can prepend to. Only the entries added by proxies we control can be
 *   believed, so the address is counted from the RIGHT: with one trusted
 *   hop, the client is the last entry, because that is the one our proxy
 *   wrote. Anything further left was supplied by the caller.
 *
 *   `WALLY_TRUST_PROXY_HOPS` therefore has no safe default above zero and
 *   is deliberately explicit. Zero — the local default — ignores the
 *   header entirely.
 *
 * WHAT IS BUDGETED
 *   Three separate budgets, because the costs are not alike. General API
 *   calls are cheap. Sign-in does signature verification and writes rows,
 *   so it is the natural way to make this server do expensive work for
 *   free. A socket upgrade allocates a connection and a slot in the room.
 *   Sharing one bucket between them would mean tuning for the cheapest.
 * ------------------------------------------------------------------ */

import type { IncomingMessage } from 'node:http'
import { TRUST_PROXY_HOPS } from './config'

export type Budget = { windowMs: number; max: number }

/** General API traffic. Generous: a panel render issues several reads. */
export const API_BUDGET: Budget = { windowMs: 60_000, max: 120 }

/**
 * Nonce issuance, signature verification, guest minting.
 *
 * Tight on purpose. These are the routes that turn a request into
 * cryptographic work and a database row, and no honest client needs to sign
 * in twenty times a minute.
 */
export const AUTH_BUDGET: Budget = { windowMs: 60_000, max: 20 }

/**
 * WebSocket handshakes.
 *
 * A reconnecting client backs off, so a legitimate one makes a handful of
 * attempts a minute even through a bad patch. This is well above that and far
 * below what it takes to exhaust the room.
 */
export const UPGRADE_BUDGET: Budget = { windowMs: 60_000, max: 30 }

/** The RPC proxy: the only route that costs the operator money per call. */
export const RPC_BUDGET: Budget = { windowMs: 60_000, max: 240 }

/**
 * The caller's address, as far as it can be trusted.
 *
 * Counting from the right means a spoofed prefix is ignored: a client that
 * sends `X-Forwarded-For: 1.2.3.4` gets its own address appended by the
 * proxy, and with one trusted hop that appended entry is the one read.
 */
export function clientAddress(req: IncomingMessage): string {
  const direct = req.socket.remoteAddress ?? 'unknown'
  if (TRUST_PROXY_HOPS <= 0) return direct

  const header = req.headers['x-forwarded-for']
  const raw = Array.isArray(header) ? header.join(',') : header
  if (!raw) return direct

  const chain = raw.split(',').map(value => value.trim()).filter(Boolean)
  if (chain.length === 0) return direct

  // With N trusted hops the client is N entries from the right.
  const index = chain.length - TRUST_PROXY_HOPS
  return chain[Math.max(0, index)] ?? direct
}

/**
 * The scheme the browser actually used.
 *
 * Behind a TLS terminator the hop into this process is plain HTTP, so
 * anything that needs to know whether the player is on a secure origin has
 * to read the forwarded header rather than the socket.
 */
export function clientProtocol(req: IncomingMessage): 'http' | 'https' {
  if (TRUST_PROXY_HOPS > 0) {
    const header = req.headers['x-forwarded-proto']
    const raw = Array.isArray(header) ? header[0] : header
    const first = (raw ?? '').split(',')[0]?.trim().toLowerCase()
    if (first === 'https') return 'https'
    if (first === 'http') return 'http'
  }
  return 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
}

/* ------------------------------------------------------------------ *
 * Fixed-window counters.
 *
 * Crude but real, and in-memory on purpose: a shared store would be a new
 * dependency and a new failure mode, and there is exactly one instance of
 * this world by design. If that ever changes, this is the thing to move.
 * ------------------------------------------------------------------ */

const buckets = new Map<string, { count: number; resetAt: number }>()

export function overBudget(key: string, budget: Budget, now = Date.now()): boolean {
  const entry = buckets.get(key)
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + budget.windowMs })
    return false
  }
  entry.count += 1
  return entry.count > budget.max
}

/** Seconds a limited caller should wait, for the `Retry-After` header. */
export function retryAfterSeconds(key: string, now = Date.now()): number {
  const entry = buckets.get(key)
  if (!entry) return 1
  return Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
}

export const apiRateLimited = (req: IncomingMessage) => overBudget(`api:${clientAddress(req)}`, API_BUDGET)
export const authRateLimited = (req: IncomingMessage) => overBudget(`auth:${clientAddress(req)}`, AUTH_BUDGET)
export const upgradeRateLimited = (req: IncomingMessage) => overBudget(`ws:${clientAddress(req)}`, UPGRADE_BUDGET)

/** Expired buckets would otherwise accumulate for every address ever seen. */
export function sweepBuckets(now = Date.now()) {
  for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key)
}

/** Test and diagnostic hook. */
export function bucketCount() {
  return buckets.size
}

export function clearBuckets() {
  buckets.clear()
}
