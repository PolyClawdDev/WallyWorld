/* ------------------------------------------------------------------ *
 * Graceful shutdown.
 *
 * A platform replaces instances constantly — every deploy, and again for
 * routine maintenance. Render sends SIGTERM and allows 30 seconds by
 * default (up to 300 with `maxShutdownDelaySeconds`). What happens in
 * that window is the difference between "the world blinked" and "the
 * world ate my duel".
 *
 * The order matters and is not arbitrary:
 *
 *   1. Stop reporting ready, so the router stops sending new players
 *      here while the existing ones are still mid-sentence.
 *   2. Stop accepting new connections.
 *   3. Run the registered drains — tell WebSocket clients to reconnect,
 *      persist whatever is only in memory — while sockets are still open
 *      enough to carry the message.
 *   4. Let the in-flight HTTP requests finish. Cutting a request that is
 *      halfway through a settlement is exactly the failure this ordering
 *      exists to avoid.
 *   5. Close the database handles last, because steps 3 and 4 write.
 *
 * A hard deadline sits over the whole thing. A drain that hangs is worse
 * than a drain that is cut short: the platform will SIGKILL anyway, and
 * it will do it at a moment nobody chose.
 * ------------------------------------------------------------------ */

import type { Server } from 'node:http'
import { SHUTDOWN_GRACE_MS } from './config'
import { beginDraining } from './readiness'
import { closeAllDrivers } from './sql'
import { safeError, safeLog } from './redact'

export type DrainStep = {
  name: string
  run: (deadlineMs: number) => Promise<void> | void
}

const steps: DrainStep[] = []
let started = false

/**
 * Registers work to do while shutting down.
 *
 * Steps run in registration order and each is given the absolute deadline,
 * so a step that waits for something can decide how long it is worth
 * waiting rather than guessing.
 */
export function onDrain(step: DrainStep) {
  steps.push(step)
}

export function isShuttingDown() {
  return started
}

async function withDeadline<T>(label: string, work: Promise<T> | T, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms))
  })
  try {
    const outcome = await Promise.race([Promise.resolve(work).then(() => 'done' as const), expiry])
    if (outcome === 'timeout') safeLog(`  drain          ${label} did not finish in time; continuing`)
  } catch (error) {
    safeError(`  drain          ${label} failed`, error)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function shutdown(server: Server, reason: string, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
  if (started) return
  started = true
  const deadline = Date.now() + graceMs
  safeLog(`Voxels API shutting down — ${reason} (${graceMs}ms grace)`)

  beginDraining()

  // `server.close` stops new connections immediately and resolves once the
  // open ones have finished. Upgraded WebSockets count as open, and it is the
  // drain steps below that close those, so the callback is armed here but
  // waited on afterwards. Waiting here instead would burn the whole grace
  // window watching sockets that nobody has yet asked to leave.
  const closed = new Promise<void>(resolve => server.close(() => resolve()))
  server.closeIdleConnections?.()

  for (const step of steps) {
    await withDeadline(step.name, step.run(deadline), Math.max(0, deadline - Date.now()))
  }

  // Keep-alive sockets can still hold this open past the deadline, so the wait
  // is bounded and the process moves on regardless.
  await withDeadline('http', closed, Math.min(5_000, Math.max(0, deadline - Date.now())))

  await withDeadline('database', closeAllDrivers(), Math.max(1_000, deadline - Date.now()))
  safeLog('Voxels API stopped cleanly')
}

/**
 * Wires the signals a platform actually sends.
 *
 * SIGTERM is the deploy path; SIGINT is Ctrl-C locally. A second signal
 * exits immediately, because an operator who presses Ctrl-C twice has
 * stopped caring about a clean shutdown and should not have to wait.
 */
export function installSignalHandlers(server: Server) {
  const handle = (signal: NodeJS.Signals) => {
    if (started) {
      safeLog(`${signal} again — exiting now`)
      process.exit(1)
    }
    void shutdown(server, signal).then(() => process.exit(0))
  }
  process.on('SIGTERM', handle)
  process.on('SIGINT', handle)
}
