/* ------------------------------------------------------------------ *
 * Liveness and readiness are different questions.
 *
 * LIVENESS ("/api/health") asks whether this process is running. It does
 * no I/O and it is what a platform should restart on. If it answers at
 * all, the answer is yes.
 *
 * READINESS ("/api/ready") asks whether this process can serve a player
 * right now. A Node process whose database has gone away is perfectly
 * alive and completely useless: it accepts the connection, accepts the
 * sign-in, and then fails on the first write. Reporting that as healthy
 * is how a load balancer routes traffic into a black hole, so readiness
 * actually touches the database.
 *
 * The probe is cached for a second. A readiness endpoint is polled hard —
 * by the platform, by uptime monitors, and by anyone who finds the URL —
 * and an uncached probe turns that polling into a denial-of-service
 * vector against the database it is meant to protect.
 * ------------------------------------------------------------------ */

import { DB_DRIVER } from './config'
import { openDrivers, sql } from './sql'

export type ReadinessCheck = {
  name: string
  ok: boolean
  detail: string
}

export type Readiness = {
  ready: boolean
  checks: ReadinessCheck[]
  checkedAtMs: number
}

const CACHE_MS = 1_000
const PROBE_TIMEOUT_MS = 2_000

let cached: Readiness | null = null
let inFlight: Promise<Readiness> | null = null

/**
 * Set while the process is draining.
 *
 * A shutting-down instance must report not-ready before it reports
 * not-alive, so the router stops sending it new players while the ones it
 * already has finish what they are doing.
 */
let draining = false

export function beginDraining() {
  draining = true
  cached = null
}

export function isDraining() {
  return draining
}

async function probe(): Promise<Readiness> {
  const checks: ReadinessCheck[] = []

  if (draining) {
    checks.push({ name: 'process', ok: false, detail: 'draining for shutdown; not accepting new work' })
  } else {
    checks.push({ name: 'process', ok: true, detail: 'accepting work' })
  }

  // Touching the handle forces it open on the first probe, so a database that
  // was never reachable is reported at once rather than at first player action.
  try {
    sql('game')
  } catch (error) {
    checks.push({
      name: `database:${DB_DRIVER}`,
      ok: false,
      detail: error instanceof Error ? error.message : 'driver could not be created',
    })
  }

  for (const { scope, driver } of openDrivers()) {
    let ok = false
    try {
      ok = await driver.ping(PROBE_TIMEOUT_MS)
    } catch {
      ok = false
    }
    checks.push({
      name: `database:${scope}`,
      ok,
      detail: ok ? `${driver.dialect} reachable` : `${driver.dialect} did not answer within ${PROBE_TIMEOUT_MS}ms`,
    })
  }

  return { ready: checks.every(check => check.ok), checks, checkedAtMs: Date.now() }
}

export async function readiness(now = Date.now()): Promise<Readiness> {
  if (cached && now - cached.checkedAtMs < CACHE_MS) return cached
  // One probe at a time: a burst of readiness requests should cost the
  // database one query, not one per request.
  if (!inFlight) {
    inFlight = probe().then(result => {
      cached = result
      inFlight = null
      return result
    }).catch(error => {
      inFlight = null
      throw error
    })
  }
  return inFlight
}

/** Forces the next call to re-probe. Used by tests and by the drain path. */
export function invalidateReadiness() {
  cached = null
}
