/* ------------------------------------------------------------------ *
 * Planning a SOL transfer, and reading what became of one.
 *
 * NOTHING HERE CAN SEND A TRANSFER, and that is now structural rather
 * than a matter of care. `signAndSend` used to live in this file: it took
 * a Phantom provider and was the single path by which this client could
 * move value. Phantom has been removed, so the function was removed with
 * it rather than left dormant — a dormant signer is a signer somebody
 * wires back up. The browser-held keypair in `embeddedWallet.ts` cannot
 * replace it: it exposes message signing only, deliberately, because the
 * key sits in localStorage where any script on this origin could reach it.
 *
 * What is left does two things, neither of which needs a key:
 *
 *   - `planTransfer` builds an *unsigned* transaction and asks the cluster
 *     to price it. The object it returns has no signature on it and there
 *     is no code in `src/` that could put one there.
 *   - `awaitConfirmation` polls a signature somebody else submitted.
 *
 * Both are exercised by `scripts/verify-solana.ts`, which is their only
 * caller now: it signs with a throwaway Node-side fixture key to prove the
 * server's receipt verification and the confirmation state machine agree
 * with the chain. No module under `src/` imports this file, so none of it
 * reaches the browser bundle.
 *
 * Amounts are lamports as bigint throughout. The one narrowing to a JS
 * number happens at the SystemProgram.transfer boundary, which takes a
 * number or bigint; the value is range-checked first so the conversion
 * cannot silently lose precision.
 *
 * Confirmation is never assumed. `awaitConfirmation` reports five
 * distinct outcomes and three of them are honest forms of "we do not
 * know yet", because telling someone their payment succeeded when it may
 * not have is worse than telling them it is uncertain.
 * ------------------------------------------------------------------ */

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { getConnection } from './rpc'

/** Above this, a lamport count would not survive the number conversion exactly. */
const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER)

export type TransferPlan = {
  payer: string
  recipient: string
  lamports: bigint
  /** Network fee quoted by the cluster for exactly this message. */
  feeLamports: bigint | null
  /** Total debit if the transfer succeeds. Null fee means the quote was unavailable. */
  totalLamports: bigint | null
  blockhash: string
  lastValidBlockHeight: number
  transaction: Transaction
}

export class PaymentError extends Error {}

/**
 * Prepares the transfer and asks the cluster what it will cost, so the
 * confirmation dialog can state the real fee rather than an assumed one.
 */
export async function planTransfer(payer: string, recipient: string, lamports: bigint): Promise<TransferPlan> {
  if (lamports <= 0n) throw new PaymentError('Amount must be greater than zero.')
  if (lamports > MAX_SAFE_LAMPORTS) throw new PaymentError('Amount is implausibly large.')
  if (payer === recipient) throw new PaymentError('Payer and recipient are the same address.')

  let payerKey: PublicKey
  let recipientKey: PublicKey
  try {
    payerKey = new PublicKey(payer)
    recipientKey = new PublicKey(recipient)
  } catch {
    throw new PaymentError('Payer or recipient is not a valid Solana address.')
  }

  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')

  const transaction = new Transaction({ feePayer: payerKey, blockhash, lastValidBlockHeight })
  transaction.add(SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: recipientKey, lamports }))

  // A quote is nice-to-have, not load-bearing: if the RPC will not price the
  // message we say so rather than inventing a number.
  let feeLamports: bigint | null = null
  try {
    const quote = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')
    if (typeof quote.value === 'number' && Number.isInteger(quote.value)) feeLamports = BigInt(quote.value)
  } catch {
    feeLamports = null
  }

  return {
    payer,
    recipient,
    lamports,
    feeLamports,
    totalLamports: feeLamports === null ? null : lamports + feeLamports,
    blockhash,
    lastValidBlockHeight,
    transaction,
  }
}

export type ConfirmOutcome =
  /** The cluster confirmed it and it did not error. */
  | { status: 'confirmed'; slot: number | null; commitment: 'confirmed' | 'finalized' }
  /** The cluster ran it and it errored. Nothing moved beyond the fee. */
  | { status: 'failed'; detail: string }
  /**
   * The blockhash expired with no status. Overwhelmingly likely never to land,
   * but "expired" is stated rather than "failed" because the two are not the
   * same claim.
   */
  | { status: 'expired'; detail: string }
  /** We stopped waiting. It may still be in flight. */
  | { status: 'timeout'; detail: string }
  /** We could not ask the cluster. Says nothing about the payment. */
  | { status: 'unknown'; detail: string }

/**
 * Polls until the cluster gives a definite answer, the transaction's blockhash
 * expires, or the deadline passes.
 *
 * Deliberately not `connection.confirmTransaction`, which collapses several of
 * these cases into a thrown error and makes it easy to treat "we do not know"
 * as "it failed".
 */
export async function awaitConfirmation(
  signature: string,
  lastValidBlockHeight: number,
  options: { timeoutMs?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void } = {},
): Promise<ConfirmOutcome> {
  const timeoutMs = options.timeoutMs ?? 90_000
  const intervalMs = options.intervalMs ?? 1_500
  const connection = getConnection()
  const started = Date.now()
  let consecutiveRpcErrors = 0

  for (;;) {
    const elapsed = Date.now() - started
    options.onTick?.(elapsed)

    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      const status = value[0]
      consecutiveRpcErrors = 0

      if (status) {
        if (status.err) return { status: 'failed', detail: `The cluster rejected it: ${JSON.stringify(status.err)}` }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { status: 'confirmed', slot: status.slot ?? null, commitment: status.confirmationStatus }
        }
      } else {
        // No status at all: once the block window has passed, this transaction can
        // no longer be accepted, so waiting further is pointless.
        const height = await connection.getBlockHeight('confirmed')
        if (height > lastValidBlockHeight) {
          return {
            status: 'expired',
            detail: `The transaction's blockhash expired at block height ${lastValidBlockHeight} without being recorded.`,
          }
        }
      }
    } catch (error) {
      consecutiveRpcErrors += 1
      // Several failures in a row means we genuinely cannot see the chain; stop
      // rather than spin, and be explicit that this is not a verdict.
      if (consecutiveRpcErrors >= 5) {
        return { status: 'unknown', detail: `RPC unreachable while confirming: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    if (Date.now() - started >= timeoutMs) {
      return { status: 'timeout', detail: `No confirmation after ${Math.round(timeoutMs / 1000)}s. The transaction may still land.` }
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
