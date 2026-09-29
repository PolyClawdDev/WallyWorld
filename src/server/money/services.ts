/* ------------------------------------------------------------------ *
 * Paying an NPC for a service, in game gold.
 *
 * Three movements, and they are deliberately the same three the duel
 * escrow already uses, for the same reason: money must never be in a
 * half-moved state.
 *
 *   reserve   available → reserved      the price is taken out of reach
 *   charge    reserved  → system sink   the price is spent on delivery
 *   refund    reserved  → available     delivery failed; the gold comes back
 *
 * `charge` and `refund` share one idempotency pair, `('service-settle',
 * orderId)`, exactly as `settleDuelGold` shares `('duel-settle', duelId)`
 * across payout, refund and void. That is not a tidiness choice: it is the
 * guarantee. The ledger will accept whichever of the two arrives first and
 * report the other as idempotent, so an order can never be both charged and
 * refunded, and never charged twice.
 *
 * A charge ends in `system:gold:sink`, the account `debitGold` already
 * destroys gold into. A service fee is a spend: no player account receives a
 * positive leg, so a purchase cannot manufacture a balance, redeemable or
 * otherwise. Gold remains unredeemable — `PAYOUTS_ENABLED` is untouched, and
 * nothing here moves lamports or talks to a chain.
 * ------------------------------------------------------------------ */

import { financeDb } from '../store'
import { fromStored } from './amount'
import { MAX_GOLD_MOVE } from './gold'
import { SYSTEM_SINK, ensurePlayerAccounts, playerAvailable, playerReserved, postTransfer, type PostResult } from './ledger'

/** Reservation and settlement scopes. One order, one of each, at most once. */
export const SERVICE_RESERVE_SCOPE = 'service-reserve'
export const SERVICE_SETTLE_SCOPE = 'service-settle'

export type ServicePriceInput = {
  userId: string
  orderId: string
  serviceId: string
  /** Base units, from the server's catalogue. A client-supplied price never reaches here. */
  price: bigint
  now?: number
}

const priceIsSane = (price: bigint) => price > 0n && price <= MAX_GOLD_MOVE

/**
 * Takes the price out of the buyer's available balance and holds it.
 *
 * Nothing is delivered on the strength of this; it is the point at which an
 * unaffordable purchase is refused, and it is refused by the ledger's own
 * bigint check rather than by a balance read this module performed earlier.
 */
export function reserveServiceGold(input: ServicePriceInput): PostResult {
  if (!priceIsSane(input.price)) {
    return { ok: false, code: 'invalid_amount', reason: 'a service price must be a positive integer amount of gold' }
  }
  ensurePlayerAccounts(input.userId, input.now)
  const note = `Reserved for ${input.serviceId}`
  return postTransfer({
    kind: 'service.reserve',
    idemScope: SERVICE_RESERVE_SCOPE,
    idemKey: input.orderId,
    refType: 'service_order',
    refId: input.orderId,
    note,
    now: input.now,
    legs: [
      { accountId: playerAvailable(input.userId), amount: -input.price, provenance: 'escrow', ownerUserId: input.userId, note },
      { accountId: playerReserved(input.userId), amount: input.price, provenance: 'escrow', ownerUserId: input.userId, note },
    ],
  })
}

/** Spends the reservation. The gold leaves the player economy for good. */
export function chargeServiceGold(input: ServicePriceInput): PostResult {
  if (!priceIsSane(input.price)) {
    return { ok: false, code: 'invalid_amount', reason: 'a service price must be a positive integer amount of gold' }
  }
  const note = `Paid for ${input.serviceId}`
  return postTransfer({
    kind: 'service.charge',
    idemScope: SERVICE_SETTLE_SCOPE,
    idemKey: input.orderId,
    refType: 'service_order',
    refId: input.orderId,
    note,
    now: input.now,
    legs: [
      { accountId: playerReserved(input.userId), amount: -input.price, provenance: 'escrow', ownerUserId: input.userId, note },
      { accountId: SYSTEM_SINK, amount: input.price, provenance: 'system', note },
    ],
  })
}

/** Returns the reservation in full. Shares the settle key with `chargeServiceGold`. */
export function refundServiceGold(input: ServicePriceInput & { reason: string }): PostResult {
  if (!priceIsSane(input.price)) {
    return { ok: false, code: 'invalid_amount', reason: 'a service price must be a positive integer amount of gold' }
  }
  const note = `Refunded ${input.serviceId}: ${input.reason}`.slice(0, 200)
  return postTransfer({
    kind: 'service.refund',
    idemScope: SERVICE_SETTLE_SCOPE,
    idemKey: input.orderId,
    refType: 'service_order',
    refId: input.orderId,
    note,
    now: input.now,
    legs: [
      { accountId: playerReserved(input.userId), amount: -input.price, provenance: 'escrow', ownerUserId: input.userId, note },
      { accountId: playerAvailable(input.userId), amount: input.price, provenance: 'escrow', ownerUserId: input.userId, note },
    ],
  })
}

/* ---------------------------------------------------------- reconciliation */

const selectTransferKind = financeDb.raw.prepare<[string, string], { transfer_id: string; kind: string }>(
  'select transfer_id, kind from ledger_transfers where idem_scope = ? and idem_key = ?',
)

const selectLegs = financeDb.raw.prepare<[string], { account_id: string; amount: string }>(
  'select account_id, amount from ledger_entries where transfer_id = ?',
)

export type SettlementFact =
  | { settled: false }
  | { settled: true; kind: 'charge' | 'refund'; transferId: string; amount: bigint }

/**
 * What the gold ledger says happened to one order, read back from the ledger.
 *
 * The receipt shown to a player is checked against this rather than trusted,
 * which is what makes "the receipt reconciles" a query instead of a promise.
 * The amount is re-summed from the entry rows, not read off the order.
 */
export function settlementOf(orderId: string): SettlementFact {
  const transfer = selectTransferKind.get(SERVICE_SETTLE_SCOPE, orderId)
  if (!transfer) return { settled: false }
  const kind = transfer.kind === 'service.charge' ? 'charge' : 'refund'
  let debited = 0n
  for (const leg of selectLegs.all(transfer.transfer_id)) {
    const amount = fromStored(leg.amount)
    if (amount < 0n) debited += -amount
  }
  return { settled: true, kind, transferId: transfer.transfer_id, amount: debited }
}

export function reservationOf(orderId: string): { reserved: boolean; transferId: string | null } {
  const transfer = selectTransferKind.get(SERVICE_RESERVE_SCOPE, orderId)
  return { reserved: Boolean(transfer), transferId: transfer?.transfer_id ?? null }
}
