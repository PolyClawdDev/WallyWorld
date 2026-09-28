/* ------------------------------------------------------------------ *
 * The choke point.
 *
 * Every spend in this system goes through `authorizeSpend`. It is the only
 * exported function that produces a `SpendPermit`, and a `SpendPermit` is the
 * required first argument of every provider method that could sign or move
 * money. So "the policy engine runs before every spending operation" is a
 * compile error when violated, not a code-review note.
 *
 * The ordering inside is the part that matters: decide first, then burn the
 * single-use nonce atomically, and only hand back the permit if the burn won.
 * Deciding after burning would leak nonces on denial; handing back the permit
 * before burning would let two concurrent jobs both receive one.
 * ------------------------------------------------------------------ */

import type { Authorization, AuthorizationLedger, LedgerSnapshot } from '../../shared/authorization'
import { decide, type PolicyDecision, type ProposedAction } from './engine'

export {
  DENY_CODES,
  MalformedActionError,
  PERMIT_TTL_MS,
  PermitError,
  SpendPermit,
  actionDigest,
  assertPermitCovers,
  decide,
  describeForModel,
  readProposal,
  type DenyCode,
  type PolicyDecision,
  type PolicyInput,
  type ProposedAction,
} from './engine'

export {
  OwnerConsent,
  TrustBoundaryError,
  Untrusted,
  assertMinted,
  isMintedAuthorization,
  mintAuthorization,
  remintFromStorage,
  untrusted,
  type AuthorizationRequest,
} from './mint'

export {
  BaseUnitError,
  applyBps,
  baseUnits,
  formatBaseUnits,
  positiveBaseUnits,
  readBaseUnits,
  sumBaseUnits,
} from './units'

/**
 * Evaluate, then consume the nonce, then release the permit.
 *
 * `nonceAlreadyConsumed` is reported as the engine's own `nonce_replayed`
 * rather than a separate error, so a race lost at the database and a replay
 * detected in the snapshot produce the same code and the caller needs only
 * one branch.
 */
export async function authorizeSpend(input: {
  authorization: Authorization
  action: ProposedAction
  ledger: AuthorizationLedger
  nowMs: number
}): Promise<PolicyDecision> {
  let snapshot: LedgerSnapshot | null = null
  try {
    snapshot = await input.ledger.snapshot(input.authorization.authorizationId)
  } catch {
    // Swallowed deliberately: the engine's `ledger_unavailable` denial is the
    // correct outcome, and an exception here would otherwise be caught further
    // out where it is much easier to mistake for a transport hiccup and retry.
    snapshot = null
  }

  const decision = decide({
    authorization: input.authorization,
    action: input.action,
    ledger: snapshot,
    nowMs: input.nowMs,
  })
  if (!decision.allow) return decision

  const won = await input.ledger.consumeNonce(input.authorization.authorizationId, input.authorization.nonce)
  if (!won) {
    return {
      allow: false,
      code: 'nonce_replayed',
      reason: 'another operation consumed this authorization\'s single-use nonce first',
      actionDigest: decision.actionDigest,
    }
  }
  return decision
}

/* ------------------------------------------------------------------ *
 * Test-only ledger.
 *
 * The real implementation belongs to the ledger owner and must satisfy
 * `AuthorizationLedger` in `src/shared/authorization.ts`: a conditional
 * `UPDATE` inside a transaction for `consumeNonce`, and an append-only
 * double-entry table for `recordDebit`. This one lives in memory, loses
 * everything on restart, and is named so that it cannot be mistaken for the
 * real thing in a stack trace.
 * ------------------------------------------------------------------ */

export class InMemoryTestLedger implements AuthorizationLedger {
  #rows = new Map<string, { debited: bigint; cumulative: bigint; nonce: string | null; settled: Set<string> }>()

  constructor(seed?: Record<string, { debited?: bigint; cumulative?: bigint; settled?: string[] }>) {
    for (const [id, row] of Object.entries(seed ?? {})) {
      this.#rows.set(id, {
        debited: row.debited ?? 0n,
        cumulative: row.cumulative ?? 0n,
        nonce: null,
        settled: new Set(row.settled ?? []),
      })
    }
  }

  #row(id: string) {
    let row = this.#rows.get(id)
    if (!row) {
      row = { debited: 0n, cumulative: 0n, nonce: null, settled: new Set() }
      this.#rows.set(id, row)
    }
    return row
  }

  async snapshot(authorizationId: string): Promise<LedgerSnapshot> {
    const row = this.#row(authorizationId)
    return {
      debitedBaseUnits: row.debited,
      cumulativeDebitedBaseUnits: row.cumulative,
      nonceConsumed: row.nonce !== null,
      settledActionDigests: [...row.settled],
    }
  }

  async consumeNonce(authorizationId: string, nonce: string): Promise<boolean> {
    const row = this.#row(authorizationId)
    if (row.nonce !== null) return false
    row.nonce = nonce
    return true
  }

  async recordDebit(input: {
    authorizationId: string
    actionDigest: string
    baseUnits: bigint
    countsTowardCumulativeBudget: boolean
  }): Promise<void> {
    const row = this.#row(input.authorizationId)
    if (row.settled.has(input.actionDigest)) return
    row.settled.add(input.actionDigest)
    row.debited += input.baseUnits
    if (input.countsTowardCumulativeBudget) row.cumulative += input.baseUnits
  }

  async releaseReservation(): Promise<void> {
    // A no-op here, and that is the point: this ledger records debits only,
    // never reservations, so there is nothing for a release to undo. The real
    // implementation must keep reservations in their own rows precisely so
    // that releasing one can never reach a settled debit — cancelling an
    // unspent reservation returns budget, cancelling a settled payment does
    // not, and collapsing the two is a data-model bug, not a copy bug.
  }
}
