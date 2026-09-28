/* ------------------------------------------------------------------ *
 * What the worker knows how to do.
 *
 * Deliberately short. There are no provider credentials of any kind in this
 * repository — no language model, no x402 facilitator, no NEAR, no Zcash,
 * no search — so there is no handler that calls one, and none is stubbed
 * out to look as though there were. Every handler here either reads local
 * state or reads the chain through the existing RPC proxy path.
 *
 * `retrySafety` is declared per handler rather than per call site, so the
 * decision "is this safe to retry" is made once, next to the code that
 * would be retried.
 * ------------------------------------------------------------------ */

import { verifyTransfer } from '../chain'
import { readReceipt, setReceiptStatus } from '../db'
import { conservationReport } from '../money/ledger'
import { readWithdrawalForOwner, requireWithdrawalReconcile } from '../treasury/withdrawals'
import { addStep, type JobRow, type RetrySafety } from './queue'

export type HandlerResult =
  | { outcome: 'succeeded'; result: unknown }
  | { outcome: 'failed'; error: string }
  /** Financial work whose outcome is genuinely not known. Never retried from here. */
  | { outcome: 'reconcile'; reason: string; evidence: unknown }

export type Handler = {
  kind: string
  retrySafety: RetrySafety
  describe: string
  run: (job: JobRow) => Promise<HandlerResult> | HandlerResult
}

/**
 * Re-runs the conservation query and records the answer.
 *
 * A pure read of local state, so it is safe to retry and cheap to run often. If it
 * ever reports `ok: false` the job still succeeds — the *job* worked; the finding
 * is the result — because a failed audit needs to be visible, not lost in a retry
 * loop.
 */
const ledgerAudit: Handler = {
  kind: 'ledger.audit',
  retrySafety: 'safe_read',
  describe: 'Re-sums the ledger and reports whether it balances.',
  run: job => {
    const report = conservationReport()
    addStep({
      jobId: job.job_id,
      name: 'audit',
      status: 'succeeded',
      detail: report.ok ? 'ledger balances' : 'ledger does NOT balance',
      evidence: {
        balanceSum: report.balanceSum.toString(),
        entrySum: report.entrySum.toString(),
        unbalancedTransfers: report.unbalancedTransfers,
        driftedAccounts: report.driftedAccounts.map(a => ({
          accountId: a.accountId,
          balance: a.balance.toString(),
          entrySum: a.entrySum.toString(),
        })),
      },
    })
    return {
      outcome: 'succeeded',
      result: {
        balances: report.ok,
        balanceSum: report.balanceSum.toString(),
        entrySum: report.entrySum.toString(),
        unbalancedTransfers: report.unbalancedTransfers.length,
        driftedAccounts: report.driftedAccounts.length,
      },
    }
  },
}

/**
 * Asks the chain what happened to a payment signature.
 *
 * A read, so retryable — and the interesting part is what it does with an
 * inconclusive answer: `unknown` is written back as `unknown`, not collapsed into
 * success or failure, exactly as the synchronous path in `index.ts` already does.
 */
const receiptReconcile: Handler = {
  kind: 'receipt.reconcile',
  retrySafety: 'safe_read',
  describe: 'Re-checks a submitted payment signature against the cluster.',
  run: async job => {
    const request = JSON.parse(job.request_json) as { signature?: unknown; payer?: unknown }
    if (typeof request.signature !== 'string' || typeof request.payer !== 'string') {
      return { outcome: 'failed', error: 'receipt.reconcile needs a signature and a payer' }
    }
    const row = readReceipt(request.signature)
    if (!row) return { outcome: 'failed', error: 'no such receipt' }
    if (row.ownerUserId !== job.owner_user_id) return { outcome: 'failed', error: 'that receipt belongs to another account' }

    const verdict = await verifyTransfer(row.signature, {
      payer: request.payer,
      recipient: row.recipient,
      lamports: BigInt(row.lamports),
    })
    const next =
      verdict.status === 'confirmed' ? 'confirmed' : verdict.status === 'failed' || verdict.status === 'mismatch' ? 'failed' : 'unknown'
    const detail = verdict.status === 'confirmed' ? `confirmed in slot ${verdict.slot}` : verdict.detail
    setReceiptStatus(row.signature, next, detail)
    addStep({ jobId: job.job_id, name: 'reconcile', status: 'succeeded', detail: next, evidence: verdict })
    return { outcome: 'succeeded', result: { signature: row.signature, status: next, detail } }
  },
}

/**
 * The reconcile path for a withdrawal whose outcome is unknown.
 *
 * With no treasury signer and no payout provider there is nothing to query, so this
 * handler's honest answer is "unknown", and it says so rather than concluding that
 * nothing was paid. The job stays blocked, which is the correct behaviour: the rule
 * is that reconciliation must happen *before* a retry, and an inconclusive
 * reconciliation is not a reconciliation.
 */
const withdrawalReconcile: Handler = {
  kind: 'withdrawal.reconcile',
  retrySafety: 'financial',
  describe: 'Attempts to establish whether a withdrawal paid out. There is no provider to ask.',
  run: job => {
    const request = JSON.parse(job.request_json) as { withdrawalId?: unknown }
    if (typeof request.withdrawalId !== 'string') return { outcome: 'failed', error: 'withdrawal.reconcile needs a withdrawalId' }
    const withdrawal = readWithdrawalForOwner(request.withdrawalId, job.owner_user_id)
    if (!withdrawal) return { outcome: 'failed', error: 'no such withdrawal' }

    const evidence = {
      checked: [] as string[],
      signature: withdrawal.signature,
      conclusion: withdrawal.signature ? 'settled' : 'unknown',
      why: withdrawal.signature
        ? 'a settlement signature is recorded on the withdrawal'
        : 'no payout provider and no treasury signer exist in this deployment, so there is nothing to query. A timeout is not evidence that no payment occurred.',
    }
    addStep({ jobId: job.job_id, name: 'reconcile', status: 'succeeded', detail: evidence.conclusion, evidence })

    if (!withdrawal.signature) {
      requireWithdrawalReconcile(withdrawal.withdrawalId, evidence.why)
      return { outcome: 'reconcile', reason: evidence.why, evidence }
    }
    return { outcome: 'succeeded', result: evidence }
  },
}

export const HANDLERS: readonly Handler[] = [ledgerAudit, receiptReconcile, withdrawalReconcile]

const byKind = new Map(HANDLERS.map(handler => [handler.kind, handler]))

export const handlerFor = (kind: string): Handler | undefined => byKind.get(kind)

export const handlerKinds = () => HANDLERS.map(handler => ({ kind: handler.kind, retrySafety: handler.retrySafety, describe: handler.describe }))
