/* ------------------------------------------------------------------ *
 * Buying a service from an NPC, once, for real gold.
 *
 * The order of operations is the safety property, so it is written out
 * rather than left to be read off the code:
 *
 *   1. resolve the service from the server's catalogue — never from the
 *      request, which carries no price and no balance;
 *   2. refuse everything refusable *before* any money moves: an unknown
 *      service, an unavailable one, a malformed request, a duel record for
 *      somebody who has never duelled;
 *   3. claim the order row. `(owner_user_id, idempotency_key)` is unique, so
 *      two clicks are one order;
 *   4. reserve the price out of available gold. An unaffordable purchase is
 *      refused here, by the ledger, and the row is dropped again;
 *   5. generate the artifact. This is the only step allowed to fail;
 *   6. on success, charge the reservation and record the artifact in one
 *      transaction. On failure, refund the reservation in full and record
 *      why.
 *
 * Two invariants follow, and both are tested:
 *
 *   You cannot be charged for an artifact you did not receive. The charge
 *   and the artifact row land in the same transaction, after the text
 *   exists; if anything throws, the transaction rolls back and the
 *   reservation is refunded under the same idempotency key the charge would
 *   have used — so the charge can never arrive afterwards.
 *
 *   You cannot receive an artifact without being charged. The text is only
 *   ever readable from an order in `delivered`, and an order reaches
 *   `delivered` only in that same transaction as the charge.
 *
 * Nothing here creates gold, and nothing here creates a redeemable balance:
 * the only positive leg a purchase writes is into `system:gold:sink`.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { financeDb, immediateTransaction } from '../store'
import { saveArtifact } from '../jobs/queue'
import { goldSnapshot } from '../money/gold'
import {
  chargeServiceGold,
  refundServiceGold,
  reserveServiceGold,
  reservationOf,
  settlementOf,
} from '../money/services'
import { serviceById, type ServiceDefinition } from './catalogue'

export type OrderState = 'reserved' | 'delivered' | 'refunded'

type OrderRow = {
  order_id: string
  owner_user_id: string
  service_id: string
  price: string
  state: string
  idempotency_key: string
  request_json: string
  reserve_transfer_id: string | null
  settle_transfer_id: string | null
  artifact_id: string | null
  artifact_kind: string | null
  artifact_title: string | null
  artifact_text: string | null
  artifact_sha256: string | null
  failure: string | null
  created_at_ms: number
  updated_at_ms: number
  delivered_at_ms: number | null
}

const db = financeDb

const insertOrder = db.raw.prepare(`
  insert into service_orders (
    order_id, owner_user_id, service_id, price, state, idempotency_key, request_json,
    reserve_transfer_id, created_at_ms, updated_at_ms
  ) values (
    @order_id, @owner_user_id, @service_id, @price, 'reserved', @idempotency_key, @request_json,
    null, @now, @now
  )
  on conflict (order_id) do nothing
`)

const selectOrder = db.raw.prepare<[string], OrderRow>('select * from service_orders where order_id = ?')

const selectOrdersForOwner = db.raw.prepare<[string, number], OrderRow>(
  'select * from service_orders where owner_user_id = ? order by created_at_ms desc limit ?',
)

const markReserved = db.raw.prepare(`
  update service_orders
     set reserve_transfer_id = @transfer_id, updated_at_ms = @now
   where order_id = @order_id and state = 'reserved'
`)

/**
 * The delivery transition. Conditional on the row still being `reserved`, so of
 * two writers exactly one can deliver, and the loser reads the winner's row
 * instead of writing a second artifact.
 */
const markDelivered = db.raw.prepare(`
  update service_orders
     set state = 'delivered',
         settle_transfer_id = @transfer_id,
         artifact_id = @artifact_id,
         artifact_kind = @artifact_kind,
         artifact_title = @artifact_title,
         artifact_text = @artifact_text,
         artifact_sha256 = @artifact_sha256,
         delivered_at_ms = @now,
         updated_at_ms = @now
   where order_id = @order_id and state = 'reserved'
`)

const markRefunded = db.raw.prepare(`
  update service_orders
     set state = 'refunded',
         settle_transfer_id = @transfer_id,
         failure = @failure,
         updated_at_ms = @now
   where order_id = @order_id and state = 'reserved'
`)

const dropOrder = db.raw.prepare("delete from service_orders where order_id = ? and state = 'reserved'")

const IDEM_KEY = /^[A-Za-z0-9_:-]{8,120}$/

/**
 * Carries a failed ledger post out of its transaction by throwing.
 *
 * Returning the failure would commit the transaction, and `postTransfer` claims
 * its idempotency pair before it checks the balance — so a committed failure
 * would leave the pair claimed with no legs behind it, and the retry would be
 * told "already applied" about a movement that never happened. Throwing rolls
 * the claim back with everything else, which is what makes a refused purchase
 * retryable rather than permanently stuck.
 */
class LedgerRefused extends Error {
  constructor(readonly code: PurchaseFailure, reason: string) {
    super(reason)
  }
}

/**
 * Derived from the buyer, the service and the buyer's idempotency key.
 *
 * Derived rather than random for the same reason the ledger derives a transfer
 * id: a retry has to compute the same id, or the second attempt would reserve a
 * second time under a different key and charge twice.
 */
function orderIdFor(userId: string, serviceId: string, idemKey: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${serviceId}\u0000${idemKey}`, 'utf8').digest('hex')
  return `so_${digest.slice(0, 32)}`
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/* --------------------------------------------------------------- test seam */

let faultOnce: string | null = null
let abandonOnce = false

/**
 * Makes the next delivery throw, once.
 *
 * A seam, in the same spirit as `acceptForTest` in the PvP hub: the refund path
 * has to be exercised by a delivery that genuinely fails after the gold is
 * reserved, and no honest generator can be asked to fail on demand. Nothing in
 * the server calls this.
 *
 * `abandon` additionally skips the refund, which is the one state this design
 * can be left in by a process that dies mid-purchase: reserved, undelivered,
 * uncharged. That is what `sweepAbandonedOrders` is for, and it cannot be tested
 * without being able to produce it.
 */
export function failNextDeliveryForTest(reason: string, options: { abandon?: boolean } = {}): void {
  faultOnce = reason
  abandonOnce = options.abandon === true
}

/* ------------------------------------------------------------------ views */

export type ServiceOrderView = {
  orderId: string
  serviceId: string
  npc: string
  title: string
  state: OrderState
  priceGold: string
  artifactId: string | null
  artifactKind: string | null
  artifactTitle: string | null
  sha256: string | null
  bytes: number | null
  failure: string | null
  createdAtMs: number
  deliveredAtMs: number | null
  /** What the gold ledger says, read back from it rather than copied off the row. */
  ledger: {
    reserveTransferId: string | null
    settleTransferId: string | null
    settled: 'charge' | 'refund' | null
    settledGold: string | null
    /** True when the ledger's own entries agree with this receipt, amount and all. */
    reconciles: boolean
  }
}

function viewOf(row: OrderRow): ServiceOrderView {
  const service = serviceById(row.service_id)
  const settlement = settlementOf(row.order_id)
  const reservation = reservationOf(row.order_id)
  const price = BigInt(row.price)
  const state = row.state as OrderState

  // The receipt is checked against the ledger rather than trusted: the amount is
  // re-summed from the entry rows and the direction has to match the state.
  const expected = state === 'delivered' ? 'charge' : state === 'refunded' ? 'refund' : null
  const reconciles = settlement.settled
    ? settlement.kind === expected && settlement.amount === price && reservation.reserved
    : expected === null && reservation.reserved

  return {
    orderId: row.order_id,
    serviceId: row.service_id,
    npc: service?.npc ?? row.service_id,
    title: row.artifact_title ?? service?.title ?? row.service_id,
    state,
    priceGold: row.price,
    artifactId: row.artifact_id,
    artifactKind: row.artifact_kind,
    artifactTitle: row.artifact_title,
    sha256: row.artifact_sha256,
    bytes: row.artifact_text === null ? null : Buffer.byteLength(row.artifact_text, 'utf8'),
    failure: row.failure,
    createdAtMs: row.created_at_ms,
    deliveredAtMs: row.delivered_at_ms,
    ledger: {
      reserveTransferId: reservation.transferId,
      settleTransferId: settlement.settled ? settlement.transferId : null,
      settled: settlement.settled ? settlement.kind : null,
      settledGold: settlement.settled ? settlement.amount.toString() : null,
      reconciles,
    },
  }
}

export function listOrdersForOwner(userId: string, limit = 25): ServiceOrderView[] {
  return selectOrdersForOwner.all(userId, limit).map(viewOf)
}

export function readOrderForOwner(orderId: string, userId: string): ServiceOrderView | null {
  const row = selectOrder.get(orderId)
  if (!row || row.owner_user_id !== userId) return null
  return viewOf(row)
}

/** The artifact itself. Readable only from a delivered order, and only by its owner. */
export function readArtifactTextForOwner(orderId: string, userId: string): { title: string; kind: string; text: string; sha256: string } | null {
  const row = selectOrder.get(orderId)
  if (!row || row.owner_user_id !== userId) return null
  if (row.state !== 'delivered' || row.artifact_text === null) return null
  return {
    title: row.artifact_title ?? row.service_id,
    kind: row.artifact_kind ?? 'text',
    text: row.artifact_text,
    sha256: row.artifact_sha256 ?? sha256(row.artifact_text),
  }
}

/* --------------------------------------------------------------- purchase */

export type PurchaseInput = {
  userId: string
  playerId: string
  displayName: string
  serviceId: unknown
  request?: Record<string, unknown>
  idempotencyKey: unknown
  now?: number
}

export type PurchaseFailure =
  | 'unknown_service'
  | 'service_unavailable'
  | 'bad_request'
  | 'nothing_to_do'
  | 'insufficient_gold'
  | 'delivery_failed'
  | 'contention'

export type PurchaseOutcome =
  | { ok: true; order: ServiceOrderView; artifact: { title: string; kind: string; text: string; sha256: string }; replayed: boolean; balance: string }
  | { ok: false; code: PurchaseFailure; reason: string; options?: readonly string[]; order?: ServiceOrderView; balance?: string }

export function purchaseService(input: PurchaseInput): PurchaseOutcome {
  const now = input.now ?? Date.now()
  // Nobody schedules a sweeper in this deployment, so the buy path does it: any
  // reservation left standing for ten minutes belongs to a process that died, and
  // ten minutes is thousands of times longer than a generator takes.
  sweepOccasionally(now)
  const service = serviceById(input.serviceId)
  if (!service) return { ok: false, code: 'unknown_service', reason: 'No such service.' }

  if (service.availability.state === 'unavailable' || service.priceGold === null || !service.prepare) {
    const because = service.availability.state === 'unavailable' ? service.availability.because.join(' ') : 'This service has nothing behind it.'
    return { ok: false, code: 'service_unavailable', reason: because }
  }

  if (typeof input.idempotencyKey !== 'string' || !IDEM_KEY.test(input.idempotencyKey)) {
    return { ok: false, code: 'bad_request', reason: 'idempotencyKey must be 8-120 characters of A-Z a-z 0-9 _ : -' }
  }

  const orderId = orderIdFor(input.userId, service.id, input.idempotencyKey)
  const existing = selectOrder.get(orderId)
  if (existing && existing.owner_user_id !== input.userId) {
    return { ok: false, code: 'bad_request', reason: 'that idempotency key belongs to another account' }
  }
  if (existing?.state === 'delivered') {
    const artifact = readArtifactTextForOwner(orderId, input.userId)!
    return { ok: true, order: viewOf(selectOrder.get(orderId)!), artifact, replayed: true, balance: goldSnapshot(input.userId).available.toString() }
  }
  if (existing?.state === 'refunded') {
    return {
      ok: false,
      code: 'delivery_failed',
      reason: existing.failure ?? 'delivery failed and the gold was refunded',
      order: viewOf(existing),
      balance: goldSnapshot(input.userId).available.toString(),
    }
  }

  // Everything that can be refused without spending anything is refused here.
  const prepared = service.prepare({
    userId: input.userId,
    playerId: input.playerId,
    displayName: input.displayName,
    request: input.request ?? {},
  })
  if (!prepared.ok) return { ok: false, code: prepared.code, reason: prepared.reason, options: prepared.options }

  const price = service.priceGold

  /* ---- 3 and 4: claim the order and reserve the price ------------------- */

  try {
    immediateTransaction(db, () => {
      insertOrder.run({
        order_id: orderId,
        owner_user_id: input.userId,
        service_id: service.id,
        price: price.toString(),
        idempotency_key: input.idempotencyKey as string,
        request_json: JSON.stringify(input.request ?? {}),
        now,
      })
      const row = selectOrder.get(orderId)
      if (!row) throw new LedgerRefused('contention', 'the order row vanished')
      // Already settled by a writer that got here first. Nothing to reserve.
      if (row.state !== 'reserved') return

      const posted = reserveServiceGold({ userId: input.userId, orderId, serviceId: service.id, price, now })
      if (!posted.ok) {
        // Nothing was delivered and nothing was charged, so the order must not
        // survive. Throwing drops the row *and* the ledger's idempotency claim,
        // which leaves the buyer free to try again once they can afford it.
        dropOrder.run(orderId)
        throw posted.code === 'insufficient_funds'
          ? new LedgerRefused('insufficient_gold', `That costs ${price} gold and you cannot cover it.`)
          : new LedgerRefused('contention', posted.reason)
      }
      markReserved.run({ order_id: orderId, transfer_id: posted.transferId, now })
    })
  } catch (error) {
    if (!(error instanceof LedgerRefused)) throw error
    return { ok: false, code: error.code, reason: error.message, balance: goldSnapshot(input.userId).available.toString() }
  }

  // A concurrent writer may have finished the whole order while this one was
  // claiming it. Their artifact is the artifact; this call reports it.
  const settledAlready = selectOrder.get(orderId)
  if (settledAlready && settledAlready.state !== 'reserved') {
    const artifact = readArtifactTextForOwner(orderId, input.userId)
    const balance = goldSnapshot(input.userId).available.toString()
    if (artifact) return { ok: true, order: viewOf(settledAlready), artifact, replayed: true, balance }
    return {
      ok: false,
      code: 'delivery_failed',
      reason: settledAlready.failure ?? 'delivery failed and the gold was refunded',
      order: viewOf(settledAlready),
      balance,
    }
  }

  /* ---- 5: do the work. The only step allowed to fail. ------------------ */

  let artifactText: string
  try {
    if (faultOnce !== null) {
      const reason = faultOnce
      faultOnce = null
      throw new Error(reason)
    }
    artifactText = prepared.render()
    if (artifactText.trim().length === 0) throw new Error('the generator produced nothing')
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'delivery failed'
    if (abandonOnce) {
      // Stands in for a process that died between the reserve and the settle.
      abandonOnce = false
      return {
        ok: false,
        code: 'contention',
        reason: `Nothing was delivered. ${price} gold is still reserved and will be returned.`,
        order: readOrderForOwner(orderId, input.userId) ?? undefined,
        balance: goldSnapshot(input.userId).available.toString(),
      }
    }
    try {
      immediateTransaction(db, () => {
        const posted = refundServiceGold({ userId: input.userId, orderId, serviceId: service.id, price, reason: failure, now })
        if (!posted.ok) throw new LedgerRefused('contention', posted.reason)
        markRefunded.run({ order_id: orderId, transfer_id: posted.transferId, failure: failure.slice(0, 300), now })
      })
    } catch (refundError) {
      if (!(refundError instanceof LedgerRefused)) throw refundError
      // The reservation is still standing and still the buyer's. `sweepAbandonedOrders`
      // will return it, and the settle key means it can never be charged instead.
      return {
        ok: false,
        code: 'contention',
        reason: refundError.message,
        order: readOrderForOwner(orderId, input.userId) ?? undefined,
        balance: goldSnapshot(input.userId).available.toString(),
      }
    }
    return {
      ok: false,
      code: 'delivery_failed',
      reason: `Nothing was delivered, so nothing was charged: ${failure}. Your ${price} gold has been returned in full.`,
      order: readOrderForOwner(orderId, input.userId) ?? undefined,
      balance: goldSnapshot(input.userId).available.toString(),
    }
  }

  /* ---- 6: charge and hand over, together ------------------------------- */

  let wrote = false
  try {
    immediateTransaction(db, () => {
      const posted = chargeServiceGold({ userId: input.userId, orderId, serviceId: service.id, price, now })
      if (!posted.ok) throw new LedgerRefused('contention', posted.reason)

      const current = selectOrder.get(orderId)
      if (!current || current.state !== 'reserved') {
        // Somebody else delivered this order. Their artifact stands; this attempt
        // writes nothing, which is why there is exactly one artifact per charge.
        return
      }
      const digest = sha256(artifactText)
      const artifactId = saveArtifact({
        ownerUserId: input.userId,
        kind: service.artifactKind,
        mediaType: 'text/plain; charset=utf-8',
        byteLength: Buffer.byteLength(artifactText, 'utf8'),
        sha256: digest,
        storageRef: `service-order:${orderId}`,
        now,
      })
      const landed = markDelivered.run({
        order_id: orderId,
        transfer_id: posted.transferId,
        artifact_id: artifactId,
        artifact_kind: service.artifactKind,
        artifact_title: prepared.title,
        artifact_text: artifactText,
        artifact_sha256: digest,
        now,
      })
      if (landed.changes !== 1) throw new LedgerRefused('contention', 'the order changed underneath its own delivery')
      wrote = true
    })
  } catch (error) {
    if (!(error instanceof LedgerRefused)) throw error
    return {
      ok: false,
      code: error.code,
      reason: error.message,
      order: readOrderForOwner(orderId, input.userId) ?? undefined,
      balance: goldSnapshot(input.userId).available.toString(),
    }
  }

  const artifact = readArtifactTextForOwner(orderId, input.userId)
  if (!artifact) {
    return { ok: false, code: 'contention', reason: 'the delivered artifact could not be read back' }
  }
  return {
    ok: true,
    order: readOrderForOwner(orderId, input.userId)!,
    artifact,
    replayed: !wrote,
    balance: goldSnapshot(input.userId).available.toString(),
  }
}

/* ------------------------------------------------------- abandoned orders */

const selectStale = db.raw.prepare<[number], OrderRow>(
  "select * from service_orders where state = 'reserved' and updated_at_ms < ?",
)

/**
 * Refunds reservations nobody finished.
 *
 * Only reachable if a process died between the reserve and the settle. The
 * refund goes through the same settle key, so an order swept here can never be
 * charged afterwards.
 */
let lastSweepAtMs = 0

/** At most once a minute, so a busy desk does not re-run the scan per purchase. */
function sweepOccasionally(now: number): void {
  if (now - lastSweepAtMs < 60_000) return
  lastSweepAtMs = now
  sweepAbandonedOrders(10 * 60_000, now)
}

export function sweepAbandonedOrders(olderThanMs = 10 * 60_000, now = Date.now()): { refunded: number } {
  let refunded = 0
  for (const row of selectStale.all(now - olderThanMs)) {
    const posted = refundServiceGold({
      userId: row.owner_user_id,
      orderId: row.order_id,
      serviceId: row.service_id,
      price: BigInt(row.price),
      reason: 'the order was abandoned before delivery',
      now,
    })
    if (!posted.ok) continue
    markRefunded.run({
      order_id: row.order_id,
      transfer_id: posted.transferId,
      failure: 'Abandoned before delivery. The reservation was returned in full.',
      now,
    })
    refunded += 1
  }
  return { refunded }
}
