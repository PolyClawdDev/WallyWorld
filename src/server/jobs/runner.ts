/* ------------------------------------------------------------------ *
 * Draining the durable queue.
 *
 * Separated from any particular process so it can be driven two ways
 * without a second copy of the logic:
 *
 *   - as a scheduled job inside the background worker (`src/worker/`),
 *     which is the normal deployment;
 *   - as a standalone loop (`npm run worker:queue`), which is what the
 *     tests drive and what an operator reaches for when they want the
 *     queue and nothing else.
 *
 * The important behaviour lives here rather than in either caller: a
 * handler that throws is a retry for a safe read and a *reconcile* for
 * financial work, because an exception says nothing about whether the side
 * effect happened.
 * ------------------------------------------------------------------ */

import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { safeError } from '../redact'
import { handlerFor } from './handlers'
import {
  claimNextJob,
  failAttempt,
  heartbeat,
  recoverExpiredLeases,
  requireReconcile,
  succeedJob,
  type JobRow,
  type JobStatus,
} from './queue'

export const workerId = () => `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`

export type RunOutcome = 'succeeded' | 'failed' | 'queued' | 'needs_reconcile' | 'no_handler'

/**
 * Reports what `failAttempt` decided, rather than guessing.
 *
 * Worth stating because getting it wrong is silent: the row would be blocked in
 * `needs_reconcile` while the caller was told the job had merely been requeued.
 */
const outcomeOf = (status: JobStatus): RunOutcome =>
  status === 'needs_reconcile' ? 'needs_reconcile' : status === 'failed' ? 'failed' : 'queued'

export async function runJob(job: JobRow, worker: string): Promise<RunOutcome> {
  const handler = handlerFor(job.kind)
  if (!handler) {
    // An unknown kind is a deployment mismatch, not a transient error. Financial
    // work still goes to reconcile rather than to failure.
    if (job.retry_safety === 'financial') requireReconcile(job.job_id, `no handler for kind ${job.kind}`)
    else failAttempt(job, `no handler for kind ${job.kind}`)
    return 'no_handler'
  }

  const beat = setInterval(() => heartbeat(job.job_id, worker), 10_000)
  beat.unref?.()
  try {
    const outcome = await handler.run(job)
    if (outcome.outcome === 'succeeded') {
      succeedJob(job.job_id, worker, outcome.result)
      return 'succeeded'
    }
    if (outcome.outcome === 'reconcile') {
      requireReconcile(job.job_id, outcome.reason)
      return 'needs_reconcile'
    }
    return outcomeOf(failAttempt(job, outcome.error))
  } catch (error) {
    safeError(`[queue] ${job.kind} threw`, error)
    return outcomeOf(failAttempt(job, error instanceof Error ? error.message : 'handler threw'))
  } finally {
    clearInterval(beat)
  }
}

/**
 * Recovers stranded leases and runs up to `max` jobs.
 *
 * Returns how many ran, so a caller can decide whether to come straight back for
 * more or wait. Lease recovery happens first every time: it is two conditional
 * UPDATEs and it is the only thing that unsticks a job whose worker was killed.
 */
export async function drainOnce(worker: string, max = 16): Promise<number> {
  recoverExpiredLeases()
  let ran = 0
  while (ran < max) {
    const job = claimNextJob(worker)
    if (!job) break
    await runJob(job, worker)
    ran += 1
  }
  return ran
}

export async function runQueueLoop(options: { idleMs?: number; stop?: () => boolean } = {}): Promise<void> {
  const worker = workerId()
  const idleMs = options.idleMs ?? 500
  const stop = options.stop ?? (() => false)
  while (!stop()) {
    try {
      if ((await drainOnce(worker)) === 0) await sleep(idleMs)
    } catch (error) {
      safeError('[queue] loop error', error)
      await sleep(idleMs)
    }
  }
}
