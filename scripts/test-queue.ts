/*
 * The durable job queue: leases, retries, reconciliation, ownership.
 *
 * The behaviour that matters most here is negative. A financial job must never be
 * retried on its own, a lost lease must not become a second attempt at spending,
 * and an inconclusive reconcile must leave the job blocked rather than release it.
 * Each of those is checked by driving the queue into the state and asserting it
 * refuses to move.
 *
 * Run with: npm run test:queue
 */
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

useTestDatabases('test-queue')

const {
  enqueueJob,
  claimNextJob,
  heartbeat,
  succeedJob,
  failAttempt,
  requireReconcile,
  reconciled,
  recoverExpiredLeases,
  addStep,
  updateMachineStates,
  readJobForOwner,
  listJobsForOwner,
  readJobInternal,
  jobSteps,
  saveArtifact,
  readArtifactForOwner,
  listArtifactsForOwner,
  withIdempotency,
  backoffMs,
  LEASE_MS,
  DEFAULT_MACHINE_STATES,
} = await import('../src/server/jobs/queue')
const { handlerKinds, handlerFor } = await import('../src/server/jobs/handlers')
const { drainOnce, runJob } = await import('../src/server/jobs/runner')

const OWNER = 'usr_job_owner'
const STRANGER = 'usr_stranger'
const WORKER = 'worker-a'
const OTHER_WORKER = 'worker-b'

/* -------------------------------------------------------------- enqueueing */

section('enqueueing is idempotent and owned')

const first = enqueueJob({ ownerUserId: OWNER, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'audit-1', request: {} })
check('the job was created', first.created, first.job.job_id)
equal('it starts queued', first.job.status, 'queued')
equal('every state machine starts at its own beginning', first.job.payment_state, DEFAULT_MACHINE_STATES.payment_state)
equal('an unknown is not the starting state', first.job.delivery_state, 'pending')

const again = enqueueJob({ ownerUserId: OWNER, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'audit-1', request: {} })
check('enqueueing the same key again creates nothing', !again.created)
equal('and returns the original job', again.job.job_id, first.job.job_id)
equal('one job, not two', listJobsForOwner(OWNER).length, 1)

section('a job is only visible to its owner')

check('the owner can read it', readJobForOwner(first.job.job_id, OWNER) !== null)
check('a stranger cannot', readJobForOwner(first.job.job_id, STRANGER) === null)
equal('and it does not appear in their list', listJobsForOwner(STRANGER).length, 0)

/* ------------------------------------------------------------------ leases */

section('a lease is exclusive')

const claimed = claimNextJob(WORKER)
check('a worker claimed it', claimed !== null && claimed.job_id === first.job.job_id)
equal('it is running', readJobInternal(first.job.job_id)?.status, 'running')
equal('the lease is attributed', readJobInternal(first.job.job_id)?.lease_owner, WORKER)
equal('the attempt was counted', readJobInternal(first.job.job_id)?.attempt, 1)
check('a second worker finds nothing to claim', claimNextJob(OTHER_WORKER) === null)
check('the lease holder can heartbeat', heartbeat(first.job.job_id, WORKER))
check('another worker cannot heartbeat someone else\'s lease', !heartbeat(first.job.job_id, OTHER_WORKER))

check('the lease holder can succeed the job', succeedJob(first.job.job_id, WORKER, { audited: true }))
equal('it is succeeded', readJobInternal(first.job.job_id)?.status, 'succeeded')
check('a stale worker cannot succeed it again', !succeedJob(first.job.job_id, OTHER_WORKER, { audited: false }))

/* ------------------------------------------------- retries for safe reads */

section('a safe read retries on a backoff, then fails terminally')

const safe = enqueueJob({
  ownerUserId: OWNER, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'audit-retry', request: {}, maxAttempts: 2,
})
const safeClaim = claimNextJob(WORKER)!
equal('claimed the retryable job', safeClaim.job_id, safe.job.job_id)
equal('a first failure requeues it', failAttempt(safeClaim, 'upstream hiccup'), 'queued')
check('the retry is delayed', (readJobInternal(safe.job.job_id)?.run_after_ms ?? 0) > Date.now())
check('the backoff grows', backoffMs(1) < backoffMs(4))
check('and is capped', backoffMs(40) <= 60_000)

const secondClaim = claimNextJob(WORKER, Date.now() + backoffMs(4))!
equal('it comes back after the delay', secondClaim.job_id, safe.job.job_id)
equal('out of attempts, it fails terminally', failAttempt(secondClaim, 'still broken'), 'failed')
equal('and stays failed', readJobInternal(safe.job.job_id)?.status, 'failed')

/* ------------------------------------- financial work is never auto-retried */

section('financial work goes to reconcile, never to a retry')

const financial = enqueueJob({
  ownerUserId: OWNER, kind: 'withdrawal.reconcile', retrySafety: 'financial', idempotencyKey: 'fin-1', request: {},
})
equal('a financial job gets one attempt by default', financial.job.max_attempts, 1)
const financialClaim = claimNextJob(WORKER)!
equal('a failure sends it to reconcile, not back to the queue',
  failAttempt(financialClaim, 'request timed out'), 'needs_reconcile')
equal('and that is where it sits', readJobInternal(financial.job.job_id)?.status, 'needs_reconcile')
check('a blocked job is not claimable', claimNextJob(OTHER_WORKER) === null)

// The whole point: a timeout tells you nothing about whether money moved, so the
// reconcile must establish a finding before the job is allowed to move again.
check('an inconclusive reconcile does not release it', !reconciled({ jobId: financial.job.job_id, paymentState: 'unknown' }))
equal('still blocked', readJobInternal(financial.job.job_id)?.status, 'needs_reconcile')

check('releasing without a recorded reconcile step is refused',
  !reconciled({ jobId: financial.job.job_id, paymentState: 'settled' }))

addStep({ jobId: financial.job.job_id, name: 'reconcile', status: 'succeeded', detail: 'settled', evidence: { signature: 'sig-abc' } })
check('with evidence recorded, the finding releases it', reconciled({ jobId: financial.job.job_id, paymentState: 'settled' }))
equal('it is queued again', readJobInternal(financial.job.job_id)?.status, 'queued')
equal('and carries the finding', readJobInternal(financial.job.job_id)?.payment_state, 'settled')
check('the reconcile evidence is on the record',
  jobSteps(financial.job.job_id).some(step => step.name === 'reconcile' && step.evidence_json !== null))

/* -------------------------------------------------------- lease recovery */

section('a worker that dies mid-job strands nothing')

// Clear whatever is still claimable first. The queue picks by priority and then by
// readiness, not by the order a test wrote its jobs, so leaving anything behind
// would make the next two claims ambiguous.
for (let drained = claimNextJob('drainer'); drained; drained = claimNextJob('drainer')) {
  succeedJob(drained.job_id, 'drainer', { drained: true })
}

const strandedSafe = enqueueJob({
  ownerUserId: OWNER, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'stranded-safe', request: {},
})
const strandedFinancial = enqueueJob({
  ownerUserId: OWNER, kind: 'withdrawal.reconcile', retrySafety: 'financial', idempotencyKey: 'stranded-fin', request: {},
})
// Claim both and then never heartbeat again, which is what a killed process looks
// like from the database's point of view.
claimNextJob(WORKER)
claimNextJob(WORKER)
equal('the safe read is running', readJobInternal(strandedSafe.job.job_id)?.status, 'running')
equal('the financial job is running', readJobInternal(strandedFinancial.job.job_id)?.status, 'running')

const recovered = recoverExpiredLeases(Date.now() + LEASE_MS + 1)
equal('one safe read was requeued', recovered.requeued, 1)
equal('one financial job was sent to reconcile', recovered.reconciling, 1)
equal('the safe read went back on the queue', readJobInternal(strandedSafe.job.job_id)?.status, 'queued')
// The reason, in the row, in plain words: a timeout is not evidence.
equal('the financial job went to reconcile instead', readJobInternal(strandedFinancial.job.job_id)?.status, 'needs_reconcile')
check('and the row says why, in words', (readJobInternal(strandedFinancial.job.job_id)?.reconcile_reason ?? '').includes('not evidence'),
  readJobInternal(strandedFinancial.job.job_id)?.reconcile_reason ?? '')
equal('its payment state is unknown, which is not a terminal state',
  readJobInternal(strandedFinancial.job.job_id)?.payment_state, 'unknown')

/* -------------------------------------------------------------- handlers */

section('handlers are registered, and only safe ones retry')

const kinds = handlerKinds()
check('there is at least one handler', kinds.length > 0, kinds.map(kind => kind.kind).join(', '))
check('ledger.audit is a safe read', kinds.some(kind => kind.kind === 'ledger.audit' && kind.retrySafety === 'safe_read'))
check('withdrawal.reconcile is financial', kinds.some(kind => kind.kind === 'withdrawal.reconcile' && kind.retrySafety === 'financial'))
check('an unregistered kind has no handler', handlerFor('does.not.exist') === undefined)

const auditJob = enqueueJob({
  ownerUserId: OWNER, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'audit-run', request: {},
})
const ran = await drainOnce(WORKER, 8)
check('the drain ran work', ran > 0, String(ran))
equal('the audit succeeded', readJobInternal(auditJob.job.job_id)?.status, 'succeeded')
const auditView = readJobForOwner(auditJob.job.job_id, OWNER)
check('its result is readable by the owner', auditView !== null && auditView.result !== null)

// With no provider configured, the honest answer from a withdrawal reconcile is
// "unknown", and the job must stay blocked rather than pretend to have finished.
for (let drained = claimNextJob('drainer'); drained; drained = claimNextJob('drainer')) {
  succeedJob(drained.job_id, 'drainer', { drained: true })
}
const unresolvable = enqueueJob({
  ownerUserId: OWNER, kind: 'withdrawal.reconcile', retrySafety: 'financial', idempotencyKey: 'fin-unresolvable',
  request: { withdrawalId: 'wd_does_not_exist' },
})
const unresolvableClaim = claimNextJob(WORKER)!
equal('the claim is the job under test', unresolvableClaim.job_id, unresolvable.job.job_id)
const outcome = await runJob(unresolvableClaim, WORKER)
equal('an unresolvable financial job stays blocked', outcome, 'needs_reconcile')
equal('in needs_reconcile', readJobInternal(unresolvable.job.job_id)?.status, 'needs_reconcile')

/* -------------------------------------------------------------- artifacts */

section('artifacts and their receipts are owner-only')

const artifactId = saveArtifact({
  ownerUserId: OWNER,
  jobId: auditJob.job.job_id,
  kind: 'report',
  mediaType: 'application/json',
  byteLength: 128,
  sha256: 'a'.repeat(64),
  storageRef: 'file://reports/audit-1.json',
})
check('the owner can read their artifact', readArtifactForOwner(artifactId, OWNER) !== null)
check('a stranger cannot', readArtifactForOwner(artifactId, STRANGER) === null)
equal('the owner sees it listed', listArtifactsForOwner(OWNER).length, 1)
equal('the stranger sees nothing', listArtifactsForOwner(STRANGER).length, 0)

/* ------------------------------------------------------------ idempotency */

section('withIdempotency applies an effect once')

let effects = 0
const runOnce = withIdempotency('test-scope', 'key-1', OWNER, () => { effects += 1; return { value: effects } })
const runTwice = withIdempotency('test-scope', 'key-1', OWNER, () => { effects += 1; return { value: effects } })
check('the first call ran', runOnce.ok && !runOnce.replayed)
check('the second call replayed the stored response', runTwice.ok && runTwice.replayed)
equal('the effect happened once', effects, 1)
check('both calls return the same value',
  runOnce.ok && runTwice.ok && JSON.stringify(runOnce.value) === JSON.stringify(runTwice.value))

const stolen = withIdempotency('test-scope', 'key-1', STRANGER, () => ({ value: -1 }))
check('another account cannot reuse the key', !stolen.ok && stolen.code === 'owner_mismatch',
  stolen.ok ? 'it ran' : stolen.code)
equal('and nothing ran', effects, 1)

/* ----------------------------------------------------------- state machines */

section('each state machine keeps a non-terminal unknown')

updateMachineStates(auditJob.job.job_id, { payment: 'unknown', transfer: 'unknown' })
const withUnknowns = readJobInternal(auditJob.job.job_id)!
equal('payment can be unknown', withUnknowns.payment_state, 'unknown')
equal('transfer can be unknown', withUnknowns.transfer_state, 'unknown')
equal('an untouched machine is left alone', withUnknowns.conversion_state, 'not_started')

finish('queue')
