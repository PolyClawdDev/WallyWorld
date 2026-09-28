/* ------------------------------------------------------------------ *
 * Background worker.
 *
 * A separate process from the game server, and that separation is the
 * whole point rather than an organisational preference.
 *
 * The world runs a fixed tick. Every fifty milliseconds it advances every
 * live duel, and a player feels it the moment that tick slips. Payment
 * reconciliation, by contrast, means waiting on a Solana RPC call that
 * can take seconds and can hang. Run them in one process and one slow
 * confirmation stutters everybody's combat — not because the code is
 * wrong, but because a single-threaded runtime cannot do both at once.
 *
 * So: the web service owns the simulation and answers players. This
 * process owns everything that can afford to be slow. They share the
 * database and nothing else. This process opens no listening socket, and
 * on Render it is a `worker`, which cannot receive inbound traffic even
 * if something here tried to.
 *
 * DELIBERATELY NOT IMPORTED HERE
 *   `./pvp/hub` and anything that reaches it. Importing that module
 *   starts the combat interval and the duel recovery pass, which would
 *   give this process a second, competing copy of the world. The import
 *   graph is the enforcement; there is no flag to get wrong.
 * ------------------------------------------------------------------ */

import { setTimeout as sleep } from 'node:timers/promises'
import {
  assertConfigValid,
  CLUSTER,
  DATABASE_URL,
  DB_DRIVER,
  NODE_ENV,
  SHUTDOWN_GRACE_MS,
} from '../server/config'
import { safeError, safeLog, secretFingerprint } from '../server/redact'
import { closeAllDrivers, sql } from '../server/sql'
import { sweepExpired } from '../server/db'
import { drainOnce, workerId } from '../server/jobs/runner'

/** One identity for the lifetime of the process, so leases are attributable. */
const QUEUE_WORKER_ID = workerId()

export type Job = {
  name: string
  /** How often to run, in milliseconds. */
  everyMs: number
  run: () => Promise<void> | void
}

/**
 * The job table.
 *
 * Kept as data rather than a pile of `setInterval` calls so the schedule
 * is one readable thing, every job is named in logs and failures, and a
 * throw in one job cannot stop the others.
 */
const jobs: Job[] = []

export function registerJob(job: Job) {
  jobs.push(job)
}

/**
 * Expired sign-in nonces and sessions.
 *
 * The web service also does this, because it must keep working when this
 * process is not deployed. Doing it in both is harmless — the sweep is a
 * delete of already-dead rows — and it means the worker is an optimisation
 * rather than a dependency.
 */
registerJob({
  name: 'sweep-expired-sessions',
  everyMs: 10 * 60 * 1000,
  run: () => { sweepExpired() },
})

/**
 * Proves the database handle is alive and reconnects the pool if it is not.
 *
 * A worker with no inbound traffic can sit idle long enough for every
 * pooled connection to be reaped by the database or by something in
 * between. Without this the next real job is the thing that discovers it.
 */
registerJob({
  name: 'database-keepalive',
  everyMs: 60 * 1000,
  run: async () => { await sql('game').ping() },
})

/**
 * The durable job queue.
 *
 * Registered here rather than run from its own process so there is one worker to
 * deploy and one place to read the schedule. `drainOnce` recovers expired leases
 * before claiming anything, so a job whose worker was killed mid-flight is picked
 * up on the next turn — a safe read goes back to the queue and financial work goes
 * to `needs_reconcile`, never straight to a retry.
 *
 * `npm run worker:queue` runs the same drain on its own when that is what you want.
 */
registerJob({
  name: 'durable-queue',
  everyMs: 1_000,
  run: async () => { await drainOnce(QUEUE_WORKER_ID) },
})

let stopping = false

async function runOnce(job: Job) {
  try {
    await job.run()
  } catch (error) {
    // A failing job must not take the loop down with it. It will be tried
    // again on its next turn, and the reason is scrubbed on the way out.
    safeError(`[voxels-worker] ${job.name} failed`, error)
  }
}

async function loop(job: Job) {
  // Staggered so a worker that has just started does not fire every job in
  // the same millisecond and hand the database a thundering herd of one.
  await sleep(Math.random() * Math.min(job.everyMs, 5_000))
  while (!stopping) {
    const started = Date.now()
    await runOnce(job)
    const remaining = job.everyMs - (Date.now() - started)
    if (remaining > 0) await sleep(remaining)
  }
}

async function main() {
  assertConfigValid()

  safeLog(`Voxels worker — ${NODE_ENV}`)
  safeLog(`  role           background jobs only. No listening socket, no game simulation.`)
  safeLog(`  persistence    ${DB_DRIVER}${DB_DRIVER === 'postgres' ? ` · ${secretFingerprint(DATABASE_URL)}` : ' (local file)'}`)
  safeLog(`  cluster        ${CLUSTER}`)
  safeLog(`  jobs           ${jobs.map(job => `${job.name}@${Math.round(job.everyMs / 1000)}s`).join(', ')}`)

  const running = jobs.map(job => loop(job))

  const stop = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1)
    stopping = true
    safeLog(`Voxels worker draining — ${signal}`)
    // The loops check `stopping` between jobs, so the wait is for whatever
    // is mid-flight. Past the grace period the platform is going to kill
    // this process anyway; exiting on our own terms at least closes the pool.
    const deadline = setTimeout(() => {
      safeLog('Voxels worker drain timed out; exiting')
      process.exit(0)
    }, SHUTDOWN_GRACE_MS)
    deadline.unref()
    void Promise.allSettled(running)
      .then(() => closeAllDrivers())
      .then(() => {
        safeLog('Voxels worker stopped cleanly')
        process.exit(0)
      })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  await Promise.all(running)
}

main().catch(error => {
  safeError('[voxels-worker] fatal', error)
  process.exit(1)
})
