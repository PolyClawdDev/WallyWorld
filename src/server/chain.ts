/* ------------------------------------------------------------------ *
 * Server-side confirmation of a payment.
 *
 * The client reports a transaction signature. That is all it reports that
 * is trusted: the amount, the recipient and the payer are re-derived here
 * from the chain, so a client claiming to have paid cannot make the server
 * believe it. A receipt only reaches `confirmed` when the ledger agrees.
 *
 * Verification reads the balance deltas in the transaction's metadata
 * rather than decoding instruction data. That way a transfer still
 * verifies whether it arrived as a bare SystemProgram transfer or wrapped
 * in something else, and the thing being checked is the outcome that
 * actually matters: the recipient ended up with at least the expected
 * lamports, paid for by the expected wallet.
 * ------------------------------------------------------------------ */

import { Connection } from '@solana/web3.js'
import { CLUSTER, RPC_URL } from './config'
import { GENESIS_HASH } from '../shared/clusters'
import { describeUpstreamError } from './redact'

const connection = new Connection(RPC_URL, 'confirmed')

export type TransferVerdict =
  /** On chain, and it did what was expected. */
  | { status: 'confirmed'; lamportsReceived: bigint; slot: number }
  /** On chain and it failed. Nothing moved beyond the fee. */
  | { status: 'failed'; detail: string }
  /** On chain, but not the payment we were told it was. */
  | { status: 'mismatch'; detail: string }
  /** The cluster has never heard of it, or has not caught up yet. */
  | { status: 'unknown'; detail: string }
  /** We could not ask. Deliberately distinct from "it did not happen". */
  | { status: 'unreachable'; detail: string }

export async function verifyClusterIdentity(): Promise<{ ok: boolean; detail: string }> {
  try {
    const actual = await connection.getGenesisHash()
    const expected = GENESIS_HASH[CLUSTER]
    return actual === expected
      ? { ok: true, detail: `${CLUSTER} (${actual})` }
      : { ok: false, detail: `SOLANA_CLUSTER=${CLUSTER} but the RPC reports genesis ${actual}` }
  } catch (error) {
    return { ok: false, detail: `RPC unreachable: ${describeUpstreamError(error)}` }
  }
}

export async function verifyTransfer(
  signature: string,
  expected: { payer: string; recipient: string; lamports: bigint },
): Promise<TransferVerdict> {
  let status
  try {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    status = value[0]
  } catch (error) {
    return { status: 'unreachable', detail: describeUpstreamError(error) }
  }

  if (!status) return { status: 'unknown', detail: 'the cluster has no record of this signature yet' }
  if (status.err) return { status: 'failed', detail: `transaction failed on chain: ${JSON.stringify(status.err)}` }
  if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') {
    return { status: 'unknown', detail: `only reached commitment "${status.confirmationStatus ?? 'processed'}"` }
  }

  let parsed
  try {
    parsed = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  } catch (error) {
    return { status: 'unreachable', detail: describeUpstreamError(error) }
  }
  // Confirmed a moment ago but not yet queryable: still genuinely unknown, not failed.
  if (!parsed) return { status: 'unknown', detail: 'signature is confirmed but the transaction is not retrievable yet' }
  if (parsed.meta?.err) return { status: 'failed', detail: `transaction failed on chain: ${JSON.stringify(parsed.meta.err)}` }

  const keys = parsed.transaction.message.accountKeys
  const pre = parsed.meta?.preBalances
  const post = parsed.meta?.postBalances
  if (!pre || !post || pre.length !== keys.length || post.length !== keys.length) {
    return { status: 'mismatch', detail: 'transaction metadata did not include usable balance information' }
  }

  // The fee payer is always the first account and must be the signed-in wallet,
  // so one user cannot claim credit for another user's payment.
  const feePayer = keys[0]?.pubkey.toBase58()
  if (feePayer !== expected.payer) {
    return { status: 'mismatch', detail: 'the transaction was paid for by a different wallet than the signed-in one' }
  }

  const recipientIndex = keys.findIndex(key => key.pubkey.toBase58() === expected.recipient)
  if (recipientIndex === -1) {
    return { status: 'mismatch', detail: 'the expected recipient does not appear in the transaction' }
  }

  // Lamport balances are exact integers far below 2^53, so this conversion is
  // lossless; all comparison happens in bigint.
  const received = BigInt(post[recipientIndex]) - BigInt(pre[recipientIndex])
  if (received < expected.lamports) {
    return {
      status: 'mismatch',
      detail: `recipient received ${received} lamports, expected at least ${expected.lamports}`,
    }
  }

  return { status: 'confirmed', lamportsReceived: received, slot: parsed.slot }
}
