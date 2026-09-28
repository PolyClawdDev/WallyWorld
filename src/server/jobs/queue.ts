/* ------------------------------------------------------------------ *
 * The durable job queue.
 *
 * Replaces `setTimeout(...).unref()`, which survived a restart in the sense
 * that the row was still there and the work was gone.
 *
 * The lock is a lease. A worker claims a job with one conditional UPDATE
 * against an expired lease, so a worker that is killed mid-job releases it
 * by timing out rather than by needing anybody to notice. Nothing here
 * needs Redis and nothing here needs a second process to be healthy.
 *
 * The important column is `retry_safety`, and it exists because of one
 * rule: **a timeout is not evidence that no payment occurred.**
 *
 *   safe_read  a read with no side effect. Retried on a backoff, freely,
 *              because retrying it twice is the same as retrying it once.
 *   financial  anything that can spend money or create a duplicate charge.
 *              NOT retried. When its lease expires or it errors, it moves
 *              to `needs_reconcile` and stops there. A reconcile step has
 *              to write evidence of what actually happened before the job
 *              becomes eligible to run again, and that transition is the
 *              only way out of `needs_reconcile`.
 *
 * Five state machines are tracked separately and never collapsed into the
 * job's own status, because a settled payment does not imply a delivered
 * job. Each one keeps a non-terminal `unknown`, matching the vocabulary
 * `chain.ts` already uses.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import { ENV_STAMP } from '../db'
import { financeDb, immediateTransaction } from '../store'

const db = financeDb

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_reconcile' | 'cancelled'
export type RetrySafety = 'safe_read' | 'financial'

/** Each machine keeps its own `unknown`. None of them is the job's status. */
export type DeliveryState = 'pending' | 'in_progress' | 'delivered' | 'failed' | 'unknown'
export type PaymentState = 'not_started' | 'required' | 'authorized' | 'settling' | 'settled' | 'failed' | 'unknown'
export type ConversionState = 'not_started' | 'quoted' | 'deposited' | 'processing' | 'complete' | 'refunded' | 'failed' | 'unknown'
export type ShieldingState = 'not_started' | 'detected' | 'shielding' | 'shielded' | 'failed' | 'unknown'
export type TransferState = 'not_started' | 'submitted' | 'confirming' | 'confirmed' | 'failed' | 'unknown'

export const DEFAULT_MACHINE_STATES = {
  delivery_state: 'pending' satisfies DeliveryState,
  payment_state: 'not_started' satisfies PaymentState,
  conversion_state: 'not_started' satisfies ConversionState,
  shielding_state: 'not_started' satisfies ShieldingState,
  transfer_state: 'not_started' satisfies TransferState,
}

export const LEASE_MS = 30_000

/** Exponential-ish, capped. Only ever applied to `safe_read` work. */
export const backoffMs = (attempt: number) => Math.min(60_000, 500 * 2 ** Math.min(attempt, 7))

export type JobRow = {
  job_id: string
  owner_user_id: string
  kind: string
  status: JobStatus
  retry_safety: RetrySafety
  idempotency_key: string
  request_json: string
  result_json: string | null
  delivery_state: string
  payment_state: string
  conversion_state: string
  shielding_state: string
  transfer_state: string
  attempt: number
  max_attempts: number
  priority: number
  run_after_ms: number
  lease_owner: string | null
  lease_expires_at_ms: number | null
  last_error: string | null
  reconcile_reason: string | null
  env_stamp: string
  created_at_ms: number
  updated_at_ms: number
  terminal_at_ms: number | null
}

const insertJob = db.raw.prepare(`
  insert into jobs (
    job_id, owner_user_id, kind, status, retry_safety, idempotency_key, request_json, result_json,
    delivery_state, payment_state, conversion_state, shielding_state, transfer_state,
    attempt, max_attempts, priority, run_after_ms, lease_owner, lease_expires_at_ms,
    last_error, reconcile_reason, env_stamp, created_at_ms, updated_at_ms, terminal_at_ms
  ) values (
    @job_id, @owner_user_id, @kind, 'queued', @retry_safety, @idempotency_key, @request_json, null,
    @delivery_state, @payment_state, @conversion_state, @shielding_state, @transfer_state,
    0, @max_attempts, @priority, @run_after_ms, null, null,
    null, null, @env_stamp, @now, @now, null
  )
  on conflict (idempotency_key) do nothing
`)

const selectJob = db.raw.prepare<[string], JobRow>('select * from jobs where job_id = ?')
const selectJobByIdem = db.raw.prepare<[string], JobRow>('select * from jobs where idempotency_key = ?')
const selectJobsForOwner = db.raw.prepare<[string, number], JobRow>(
  'select * from jobs where owner_user_id = ? order by created_at_ms desc limit ?',
)

/**
 * The claim.
 *
 * One statement. The inner select picks the next eligible job and the outer update
 * takes it, both under the same write lock, so two workers cannot claim one job:
 * the second finds `lease_expires_at_ms` in the future and matches nothing.
 *
 * `needs_reconcile` is deliberately absent from the eligible statuses. Reconcile
 * work is enqueued as its own `safe_read` job; a financial job never picks itself
 * back up.
 */
const pickClaimable = db.raw.prepare<{ now: number }, { job_id: string }>(`
  select job_id from jobs
   where status = 'queued'
     and run_after_ms <= @now
     and (lease_expires_at_ms is null or lease_expires_at_ms < @now)
   order by priority desc, run_after_ms asc, created_at_ms asc
   limit 1
`)

const claimStatement = db.raw.prepare(`
  update jobs
     set status = 'running',
         lease_owner = @worker,
         lease_expires_at_ms = @lease_until,
         attempt = attempt + 1,
         updated_at_ms = @now
   where job_id = @job_id
     and status = 'queued'
     and (lease_expires_at_ms is null or lease_expires_at_ms < @now)
`)

const heartbeatStatement = db.raw.prepare(`
  update jobs
     set lease_expires_at_ms = @lease_until,
         updated_at_ms = @now
   where job_id = @job_id
     and lease_owner = @worker
     and status = 'running'
`)

const succeedStatement = db.raw.prepare(`
  update jobs
     set status = 'succeeded',
         result_json = @result_json,
         delivery_state = 'delivered',
         lease_owner = null,
         lease_expires_at_ms = null,
         last_error = null,
         updated_at_ms = @now,
         terminal_at_ms = @now
   where job_id = @job_id
     and lease_owner = @worker
     and status = 'running'
`)

const retryStatement = db.raw.prepare(`
  update jobs
     set status = 'queued',
         run_after_ms = @run_after_ms,
         lease_owner = null,
         lease_expires_at_ms = null,
         last_error = @last_error,
         updated_at_ms = @now
   where job_id = @job_id
     and status = 'running'
     and retry_safety = 'safe_read'
`)

const failStatement = db.raw.prepare(`
  update jobs
     set status = 'failed',
         delivery_state = 'failed',
         lease_owner = null,
         lease_expires_at_ms = null,
         last_error = @last_error,
         updated_at_ms = @now,
         terminal_at_ms = @now
   where job_id = @job_id
     and status in ('running', 'queued', 'needs_reconcile')
`)

/**
 * The only destination for a financial job that did not clearly finish.
 *
 * Note what it does *not* do: it does not set `payment_state` to `failed`. The
 * payment state becomes `unknown`, because that is what is true.
 */
const reconcileStatement = db.raw.prepare(`
  update jobs
     set status = 'needs_reconcile',
         payment_state = case when payment_state in ('settled', 'failed') then payment_state else 'unknown' end,
         lease_owner = null,
         lease_expires_at_ms = null,
         reconcile_reason = @reason,
         updated_at_ms = @now
   where job_id = @job_id
     and status in ('running', 'queued')
`)

/** Lease recovery. Safe reads go back to the queue; financial work goes to reconcile. */
const expireSafeLeases = db.raw.prepare(`
  update jobs
     set status = 'queued',
         run_after_ms = @run_after_ms,
         lease_owner = null,
         lease_expires_at_ms = null,
         last_error = 'worker lease expired',
         updated_at_ms = @now
   where status = 'running'
     and retry_safety = 'safe_read'
     and lease_expires_at_ms is not null
     and lease_expires_at_ms < @now
`)

const expireFinancialLeases = db.raw.prepare(`
  update jobs
     set status = 'needs_reconcile',
         payment_state = case when payment_state in ('settled', 'failed') then payment_state else 'unknown' end,
         lease_owner = null,
         lease_expires_at_ms = null,
         reconcile_reason = 'worker lease expired: a timeout is not evidence that no payment occurred',
         updated_at_ms = @now
   where status = 'running'
     and retry_safety = 'financial'
     and lease_expires_at_ms is not null
     and lease_expires_at_ms < @now
`)

/**
 * The only way out of `needs_reconcile`.
 *
 * Requires the caller to have written a reconcile step with evidence — the
 * `exists` clause is the enforcement, not a comment about the intention.
 */
const clearReconcile = db.raw.prepare(`
  update jobs
     set status = 'queued',
         run_after_ms = @run_after_ms,
         payment_state = @payment_state,
         reconcile_reason = null,
         updated_at_ms = @now
   where job_id = @job_id
     and status = 'needs_reconcile'
     and exists (
       select 1 from job_steps
        where job_id = @job_id
          and name = 'reconcile'
          and status = 'succeeded'
          and evidence_json is not null
     )
`)

const exhaustedToReconcile = db.raw.prepare(`
  update jobs
     set status = 'needs_reconcile',
         reconcile_reason = 'attempt limit reached',
         lease_owner = null,
         lease_expires_at_ms = null,
         updated_at_ms = @now
   where job_id = @job_id
`)

const setMachineState = db.raw.prepare(`
  update jobs
     set delivery_state = coalesce(@delivery_state, delivery_state),
         payment_state = coalesce(@payment_state, payment_state),
         conversion_state = coalesce(@conversion_state, conversion_state),
         shielding_state = coalesce(@shielding_state, shielding_state),
         transfer_state = coalesce(@transfer_state, transfer_state),
         updated_at_ms = @now
   where job_id = @job_id
`)

/* ------------------------------------------------------------------ steps */

const insertStep = db.raw.prepare(`
  insert into job_steps (step_id, job_id, seq, name, status, attempt, detail, evidence_json, started_at_ms, ended_at_ms)
  values (@step_id, @job_id, @seq, @name, @status, @attempt, @detail, @evidence_json, @now, @ended_at_ms)
  on conflict (job_id, seq) do nothing
`)

const nextSeq = db.raw.prepare<[string], { seq: number | null }>('select max(seq) as seq from job_steps where job_id = ?')

const selectSteps = db.raw.prepare<[string], {
  seq: number
  name: string
  status: string
  detail: string | null
  evidence_json: string | null
  started_at_ms: number
  ended_at_ms: number | null
}>('select seq, name, status, detail, evidence_json, started_at_ms, ended_at_ms from job_steps where job_id = ? order by seq asc')

/* ------------------------------------------------------------------- api */

const newJobId = () => `job_${randomBytes(16).toString('hex')}`

export type EnqueueInput = {
  ownerUserId: string
  kind: string
  retrySafety: RetrySafety
  idempotencyKey: string
  request: unknown
  runAfterMs?: number
  maxAttempts?: number
  priority?: number
  now?: number
}

/** Idempotent on `idempotencyKey`. A repeat returns the job that already exists. */
export function enqueueJob(input: EnqueueInput): { job: JobRow; created: boolean } {
  const now = input.now ?? Date.now()
  const jobId = newJobId()
  const created =
    insertJob.run({
      job_id: jobId,
      owner_user_id: input.ownerUserId,
      kind: input.kind,
      retry_safety: input.retrySafety,
      idempotency_key: input.idempotencyKey,
      request_json: JSON.stringify(input.request ?? {}),
      ...DEFAULT_MACHINE_STATES,
      max_attempts: input.maxAttempts ?? (input.retrySafety === 'safe_read' ? 5 : 1),
      priority: input.priority ?? 0,
      run_after_ms: input.runAfterMs ?? now,
      env_stamp: ENV_STAMP,
      now,
    }).changes === 1
  const job = created ? selectJob.get(jobId)! : selectJobByIdem.get(input.idempotencyKey)!
  return { job, created }
}

export function claimNextJob(worker: string, now = Date.now()): JobRow | null {
  const leaseUntil = now + LEASE_MS
  return immediateTransaction(db, () => {
    const next = pickClaimable.get({ now })
    if (!next) return null
    if (claimStatement.run({ job_id: next.job_id, worker, lease_until: leaseUntil, now }).changes !== 1) return null
    return selectJob.get(next.job_id) ?? null
  })
}

export function heartbeat(jobId: string, worker: string, now = Date.now()): boolean {
  return heartbeatStatement.run({ job_id: jobId, worker, lease_until: now + LEASE_MS, now }).changes === 1
}

export function succeedJob(jobId: string, worker: string, result: unknown, now = Date.now()): boolean {
  return succeedStatement.run({ job_id: jobId, worker, result_json: JSON.stringify(result ?? null), now }).changes === 1
}

/**
 * Records a failure and chooses what happens next from `retry_safety`.
 *
 * A safe read with attempts left goes back to the queue on a backoff. A safe read
 * out of attempts fails terminally. Financial work never takes either path: it
 * goes to `needs_reconcile`, whatever the error said.
 */
export function failAttempt(job: JobRow, error: string, now = Date.now()): JobStatus {
  if (job.retry_safety === 'financial') {
    reconcileStatement.run({ job_id: job.job_id, reason: `attempt failed: ${error}`, now })
    return 'needs_reconcile'
  }
  if (job.attempt >= job.max_attempts) {
    failStatement.run({ job_id: job.job_id, last_error: error, now })
    return 'failed'
  }
  retryStatement.run({ job_id: job.job_id, run_after_ms: now + backoffMs(job.attempt), last_error: error, now })
  return 'queued'
}

export function requireReconcile(jobId: string, reason: string, now = Date.now()): boolean {
  return reconcileStatement.run({ job_id: jobId, reason, now }).changes === 1
}

export function failJob(jobId: string, error: string, now = Date.now()): boolean {
  return failStatement.run({ job_id: jobId, last_error: error, now }).changes === 1
}

export function exhaust(jobId: string, now = Date.now()): void {
  exhaustedToReconcile.run({ job_id: jobId, now })
}

/**
 * Releases a reconciled job back to the queue.
 *
 * `paymentState` is the *finding*, not a guess: the caller passes what the
 * reconcile step actually established. Passing `unknown` leaves the job blocked,
 * which is correct — an inconclusive reconcile is not a licence to retry.
 */
export function reconciled(input: {
  jobId: string
  paymentState: PaymentState
  runAfterMs?: number
  now?: number
}): boolean {
  const now = input.now ?? Date.now()
  if (input.paymentState === 'unknown') return false
  return (
    clearReconcile.run({
      job_id: input.jobId,
      run_after_ms: input.runAfterMs ?? now,
      payment_state: input.paymentState,
      now,
    }).changes === 1
  )
}

export function recoverExpiredLeases(now = Date.now()): { requeued: number; reconciling: number } {
  return immediateTransaction(db, () => ({
    requeued: expireSafeLeases.run({ run_after_ms: now, now }).changes,
    reconciling: expireFinancialLeases.run({ now }).changes,
  }))
}

export function updateMachineStates(
  jobId: string,
  states: Partial<{
    delivery: DeliveryState
    payment: PaymentState
    conversion: ConversionState
    shielding: ShieldingState
    transfer: TransferState
  }>,
  now = Date.now(),
): void {
  setMachineState.run({
    job_id: jobId,
    delivery_state: states.delivery ?? null,
    payment_state: states.payment ?? null,
    conversion_state: states.conversion ?? null,
    shielding_state: states.shielding ?? null,
    transfer_state: states.transfer ?? null,
    now,
  })
}

export function addStep(input: {
  jobId: string
  name: string
  status: 'running' | 'succeeded' | 'failed'
  detail?: string | null
  evidence?: unknown
  attempt?: number
  now?: number
}): number {
  const now = input.now ?? Date.now()
  const seq = (nextSeq.get(input.jobId)?.seq ?? 0) + 1
  insertStep.run({
    step_id: `js_${randomBytes(12).toString('hex')}`,
    job_id: input.jobId,
    seq,
    name: input.name,
    status: input.status,
    attempt: input.attempt ?? 0,
    detail: input.detail ?? null,
    evidence_json: input.evidence === undefined ? null : JSON.stringify(input.evidence),
    now,
    ended_at_ms: input.status === 'running' ? null : now,
  })
  return seq
}

/* -------------------------------------------------------------- owner reads */

export type JobView = {
  jobId: string
  kind: string
  status: JobStatus
  retrySafety: RetrySafety
  states: {
    delivery: string
    payment: string
    conversion: string
    shielding: string
    transfer: string
  }
  attempt: number
  maxAttempts: number
  lastError: string | null
  reconcileReason: string | null
  envStamp: string
  createdAtMs: number
  updatedAtMs: number
  /** What was asked for. Owner-scoped like everything else on this view. */
  request: unknown
  result: unknown
  steps: Array<{ seq: number; name: string; status: string; detail: string | null; atMs: number }>
}

const viewJob = (row: JobRow): JobView => ({
  jobId: row.job_id,
  kind: row.kind,
  status: row.status,
  retrySafety: row.retry_safety,
  states: {
    delivery: row.delivery_state,
    payment: row.payment_state,
    conversion: row.conversion_state,
    shielding: row.shielding_state,
    transfer: row.transfer_state,
  },
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  lastError: row.last_error,
  reconcileReason: row.reconcile_reason,
  envStamp: row.env_stamp,
  createdAtMs: row.created_at_ms,
  updatedAtMs: row.updated_at_ms,
  request: JSON.parse(row.request_json) as unknown,
  result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
  steps: selectSteps.all(row.job_id).map(step => ({
    seq: step.seq,
    name: step.name,
    status: step.status,
    detail: step.detail,
    atMs: step.ended_at_ms ?? step.started_at_ms,
  })),
})

/** Owner-scoped: a job belonging to another account reads as absent, not as forbidden. */
export function readJobForOwner(jobId: string, ownerUserId: string): JobView | null {
  const row = selectJob.get(jobId)
  if (!row || row.owner_user_id !== ownerUserId) return null
  return viewJob(row)
}

export function listJobsForOwner(ownerUserId: string, limit = 25): JobView[] {
  return selectJobsForOwner.all(ownerUserId, limit).map(viewJob)
}

/** Unscoped read, for the worker. Never reachable from an HTTP route. */
export function readJobInternal(jobId: string): JobRow | undefined {
  return selectJob.get(jobId)
}

export function jobSteps(jobId: string) {
  return selectSteps.all(jobId)
}

/* ------------------------------------------------------------- artifacts */

const insertArtifact = db.raw.prepare(`
  insert into artifacts (artifact_id, job_id, owner_user_id, kind, media_type, byte_length, sha256, storage_ref, env_stamp, created_at_ms)
  values (@artifact_id, @job_id, @owner_user_id, @kind, @media_type, @byte_length, @sha256, @storage_ref, @env_stamp, @now)
`)

const selectArtifact = db.raw.prepare<[string], {
  artifact_id: string
  owner_user_id: string
  job_id: string | null
  kind: string
  media_type: string
  byte_length: number
  sha256: string
  storage_ref: string
  created_at_ms: number
}>('select * from artifacts where artifact_id = ?')

const selectArtifactsForOwner = db.raw.prepare<[string, number], { artifact_id: string; kind: string; media_type: string; byte_length: number; sha256: string; created_at_ms: number }>(
  'select artifact_id, kind, media_type, byte_length, sha256, created_at_ms from artifacts where owner_user_id = ? order by created_at_ms desc limit ?',
)

export function saveArtifact(input: {
  ownerUserId: string
  jobId?: string | null
  kind: string
  mediaType: string
  byteLength: number
  sha256: string
  storageRef: string
  now?: number
}): string {
  const artifactId = `art_${randomBytes(16).toString('hex')}`
  insertArtifact.run({
    artifact_id: artifactId,
    job_id: input.jobId ?? null,
    owner_user_id: input.ownerUserId,
    kind: input.kind,
    media_type: input.mediaType,
    byte_length: input.byteLength,
    sha256: input.sha256,
    storage_ref: input.storageRef,
    env_stamp: ENV_STAMP,
    now: input.now ?? Date.now(),
  })
  return artifactId
}

/** Owner-only. This is the download check, so it returns null rather than throwing. */
export function readArtifactForOwner(artifactId: string, ownerUserId: string) {
  const row = selectArtifact.get(artifactId)
  if (!row || row.owner_user_id !== ownerUserId) return null
  return {
    artifactId: row.artifact_id,
    jobId: row.job_id,
    kind: row.kind,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    storageRef: row.storage_ref,
    createdAtMs: row.created_at_ms,
  }
}

export function listArtifactsForOwner(ownerUserId: string, limit = 25) {
  return selectArtifactsForOwner.all(ownerUserId, limit).map(row => ({
    artifactId: row.artifact_id,
    kind: row.kind,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    createdAtMs: row.created_at_ms,
  }))
}

/* --------------------------------------------------------- idempotency keys */

const insertIdemKey = db.raw.prepare(`
  insert into idempotency_keys (scope, idem_key, owner_user_id, state, response_json, created_at_ms, updated_at_ms)
  values (@scope, @idem_key, @owner_user_id, 'in_progress', null, @now, @now)
  on conflict (scope, idem_key) do nothing
`)

const selectIdemKey = db.raw.prepare<[string, string], { owner_user_id: string; state: string; response_json: string | null }>(
  'select owner_user_id, state, response_json from idempotency_keys where scope = ? and idem_key = ?',
)

const completeIdemKey = db.raw.prepare(`
  update idempotency_keys
     set state = 'complete',
         response_json = @response_json,
         updated_at_ms = @now
   where scope = @scope and idem_key = @idem_key and state = 'in_progress'
`)

export type IdempotentOutcome<T> =
  | { ok: true; value: T; replayed: boolean }
  | { ok: false; code: 'in_progress' | 'owner_mismatch'; reason: string }

/**
 * Generalises the `on conflict (signature) do nothing` trick in `db.ts` to any
 * operation, keyed on `(scope, key)` with the response stored.
 *
 * What this gives is at-least-once delivery with idempotent effects. It is
 * deliberately not described as exactly-once: a caller that never sees the
 * response cannot know whether the effect happened, only that asking again will
 * not double it.
 */
export function withIdempotency<T>(
  scope: string,
  key: string,
  ownerUserId: string,
  fn: () => T,
  now = Date.now(),
): IdempotentOutcome<T> {
  const claimed = insertIdemKey.run({ scope, idem_key: key, owner_user_id: ownerUserId, now }).changes === 1
  const existing = selectIdemKey.get(scope, key)
  if (!existing) return { ok: false, code: 'in_progress', reason: 'could not claim the idempotency key' }
  if (existing.owner_user_id !== ownerUserId) {
    return { ok: false, code: 'owner_mismatch', reason: 'that idempotency key belongs to another account' }
  }
  if (!claimed) {
    if (existing.state === 'complete') {
      return { ok: true, value: JSON.parse(existing.response_json ?? 'null') as T, replayed: true }
    }
    return { ok: false, code: 'in_progress', reason: 'an identical request is still running' }
  }
  const value = fn()
  completeIdemKey.run({ scope, idem_key: key, response_json: JSON.stringify(value ?? null), now })
  return { ok: true, value, replayed: false }
}
