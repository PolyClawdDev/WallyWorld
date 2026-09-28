/* ------------------------------------------------------------------ *
 * The withdrawal state machine. Unfunded, unsigned, and complete up to
 * the point where a key would be needed.
 *
 * What is implemented and exercised:
 *   - quoting, against configuration that is absent, so the endpoint
 *     returns a precise `missing_configuration` state rather than a number;
 *   - authenticated destination confirmation — an ed25519 signature from
 *     the destination address over a server-issued challenge bound to the
 *     withdrawal, the domain, the session, a single-use nonce and an
 *     expiry. Typing an address is not confirming it;
 *   - atomic reservation of the player's eligible rewards *and* the
 *     treasury lamports, in one transaction, so a reservation cannot exist
 *     on one side only;
 *   - the settlement and reconcile states, with `reconcile_required`
 *     non-terminal;
 *   - idempotent completion.
 *
 * What is NOT implemented, and cannot be by configuration:
 *   - any payout. There is no treasury key in this process and no signing
 *     capability. `submit` returns the signer's absence as a state.
 *
 * Cancellation releases an unspent reservation. It does not reverse a
 * settled payment, and the machine has no transition that would let it: a
 * `settled` withdrawal cannot reach `cancelled`.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { buildSiwsMessage, looksLikeAddress, looksLikeNonce, SIWS_VERSION, type SiwsFields } from '../../shared/siws'
import { CHAIN_ID, CLUSTER, NONCE_TTL_MS } from '../config'
import { ENV_STAMP, sessionIsLive } from '../db'
import { coreDb, financeDb, immediateTransaction } from '../store'
import { fromStored, toStored } from '../money/amount'
import {
  LAMPORTS,
  SYSTEM_SINK,
  TREASURY_LAMPORTS,
  balanceOf,
  consumeEligible,
  eligibilityOf,
  playerAvailable,
  playerReserved,
  postTransfer,
  releaseEligible,
  withdrawalLamports,
  ensureLedgerAccount,
} from '../money/ledger'
import { readWithdrawalConfig, TREASURY_SIGNER, type MissingConfig, type WithdrawalConfig } from './config'

const fin = financeDb
const core = coreDb

export const DESTINATION_STATEMENT =
  'Confirm this address as the destination for a Voxels reward withdrawal. This proves you control the address. It is not a transaction, it costs no fees, and it cannot move funds.'

/* ----------------------------------------------------------- the machine */

export type WithdrawalState =
  | 'draft'
  | 'quoted'
  | 'destination_confirmed'
  | 'reserved'
  | 'submitted'
  | 'settling'
  | 'settled'
  | 'failed'
  | 'reconcile_required'
  | 'cancelled'

/**
 * The transition table, as data.
 *
 * Three things are worth reading off it directly. `reconcile_required` is
 * non-terminal and can only move on to `settled` or `failed`, so an unknown
 * outcome cannot be resolved by retrying. `settled` has no outgoing transitions
 * at all, which is how "cancelling does not reverse a settled payment" is
 * enforced rather than merely intended. And `cancelled` is reachable only from
 * the pre-submission states.
 */
export const TRANSITIONS: Record<WithdrawalState, readonly WithdrawalState[]> = {
  draft: ['quoted', 'cancelled', 'failed'],
  quoted: ['destination_confirmed', 'quoted', 'cancelled', 'failed'],
  destination_confirmed: ['reserved', 'cancelled', 'failed'],
  /**
   * `reserved` can settle and can need reconciling without passing through
   * `submitted`, because this server never submits anything. If a payout is ever
   * made against a held reservation, the evidence arrives from outside and the
   * withdrawal it settles is the one sitting in `reserved`.
   */
  reserved: ['submitted', 'settled', 'reconcile_required', 'cancelled', 'failed'],
  submitted: ['settling', 'settled', 'reconcile_required', 'failed'],
  settling: ['settled', 'reconcile_required', 'failed'],
  settled: [],
  failed: [],
  reconcile_required: ['settled', 'failed'],
  cancelled: [],
}

export const canTransition = (from: WithdrawalState, to: WithdrawalState) => TRANSITIONS[from].includes(to)

/* -------------------------------------------------------------- statements */

type WithdrawalRow = {
  withdrawal_id: string
  owner_user_id: string
  state: WithdrawalState
  currency: string
  gold_amount: string
  rate_lamports_per_gold: string | null
  gross_lamports: string | null
  fee_lamports: string | null
  net_lamports: string | null
  dest_network: string | null
  dest_address: string | null
  dest_confirmed_at_ms: number | null
  dest_proof_nonce: string | null
  reservation_id: string | null
  treasury_reservation_id: string | null
  config_fingerprint: string | null
  missing_config: string | null
  signature: string | null
  failure_reason: string | null
  idem_key: string
}

const insertWithdrawal = fin.raw.prepare(`
  insert into withdrawals (
    withdrawal_id, owner_user_id, state, currency, gold_amount, rate_lamports_per_gold,
    gross_lamports, fee_lamports, net_lamports, dest_network, dest_address, dest_confirmed_at_ms,
    dest_proof_nonce, reservation_id, treasury_reservation_id, config_fingerprint, missing_config,
    signature, failure_reason, idem_key, env_stamp, created_at_ms, updated_at_ms,
    quoted_at_ms, reserved_at_ms, submitted_at_ms, terminal_at_ms
  ) values (
    @withdrawal_id, @owner_user_id, @state, 'GOLD', @gold_amount, @rate,
    @gross, @fee, @net, @dest_network, null, null,
    null, null, null, @fingerprint, @missing_config,
    null, null, @idem_key, @env_stamp, @now, @now,
    @quoted_at_ms, null, null, null
  )
  on conflict (idem_key) do nothing
`)

const selectWithdrawal = fin.raw.prepare<[string], WithdrawalRow>('select * from withdrawals where withdrawal_id = ?')
const selectWithdrawalByIdem = fin.raw.prepare<[string], WithdrawalRow>('select * from withdrawals where idem_key = ?')
const selectWithdrawalsForOwner = fin.raw.prepare<[string, number], WithdrawalRow>(
  'select * from withdrawals where owner_user_id = ? order by created_at_ms desc limit ?',
)

/** Every state change is a conditional UPDATE naming the state it expects to find. */
const advance = fin.raw.prepare(`
  update withdrawals
     set state = @to_state,
         updated_at_ms = @now,
         terminal_at_ms = case when @terminal = 1 then @now else terminal_at_ms end
   where withdrawal_id = @withdrawal_id
     and state = @from_state
`)

const setDestination = fin.raw.prepare(`
  update withdrawals
     set dest_network = @network,
         dest_address = @address,
         dest_confirmed_at_ms = @now,
         dest_proof_nonce = @nonce,
         state = 'destination_confirmed',
         updated_at_ms = @now
   where withdrawal_id = @withdrawal_id
     and state = 'quoted'
`)

const setReservations = fin.raw.prepare(`
  update withdrawals
     set reservation_id = @reservation_id,
         treasury_reservation_id = @treasury_reservation_id,
         state = 'reserved',
         reserved_at_ms = @now,
         updated_at_ms = @now
   where withdrawal_id = @withdrawal_id
     and state = 'destination_confirmed'
`)

const setSignature = fin.raw.prepare(
  'update withdrawals set signature = @signature, updated_at_ms = @now where withdrawal_id = @withdrawal_id',
)

const setFailure = fin.raw.prepare(
  'update withdrawals set failure_reason = @reason, updated_at_ms = @now where withdrawal_id = @withdrawal_id',
)

const insertEvent = fin.raw.prepare(`
  insert into withdrawal_events (event_id, withdrawal_id, seq, from_state, to_state, reason, evidence_json, created_at_ms)
  values (@event_id, @withdrawal_id, @seq, @from_state, @to_state, @reason, @evidence_json, @now)
  on conflict (withdrawal_id, seq) do nothing
`)

const nextEventSeq = fin.raw.prepare<[string], { seq: number | null }>(
  'select max(seq) as seq from withdrawal_events where withdrawal_id = ?',
)

const selectEvents = fin.raw.prepare<[string], { seq: number; from_state: string; to_state: string; reason: string; created_at_ms: number }>(
  'select seq, from_state, to_state, reason, created_at_ms from withdrawal_events where withdrawal_id = ? order by seq asc',
)

const insertBudgetReservation = fin.raw.prepare(`
  insert into budget_reservations (reservation_id, owner_user_id, authorization_id, job_id, purpose, currency, amount, status, transfer_id, release_transfer_id, created_at_ms, updated_at_ms, expires_at_ms, settled_at_ms, released_at_ms)
  values (@reservation_id, @owner_user_id, null, null, 'withdrawal', 'GOLD', @amount, 'held', @transfer_id, null, @now, @now, null, null, null)
`)

const closeBudgetReservation = fin.raw.prepare(`
  update budget_reservations
     set status = @status,
         release_transfer_id = @release_transfer_id,
         settled_at_ms = case when @status = 'settled' then @now else settled_at_ms end,
         released_at_ms = case when @status = 'released' then @now else released_at_ms end,
         updated_at_ms = @now
   where reservation_id = @reservation_id
     and status = 'held'
`)

const insertTreasuryReservation = fin.raw.prepare(`
  insert into treasury_reservations (reservation_id, withdrawal_id, currency, amount, fee_reserve, status, transfer_id, release_transfer_id, created_at_ms, updated_at_ms, released_at_ms)
  values (@reservation_id, @withdrawal_id, 'LAMPORTS', @amount, @fee_reserve, 'held', @transfer_id, null, @now, @now, null)
`)

const closeTreasuryReservation = fin.raw.prepare(`
  update treasury_reservations
     set status = @status,
         release_transfer_id = @release_transfer_id,
         released_at_ms = case when @status = 'released' then @now else released_at_ms end,
         updated_at_ms = @now
   where reservation_id = @reservation_id
     and status = 'held'
`)

const sumWithdrawnGold = fin.raw.prepare<[string], { gold_amount: string; state: string }>(
  'select gold_amount, state from withdrawals where owner_user_id = ?',
)

/* -------------------------------------------------- destination challenge */

const insertDestChallenge = core.raw.prepare(`
  insert into link_challenges (nonce, user_id, wallet, domain, uri, chain_id, session_sha256, intent, issued_at, expiration, expires_at_ms, consumed_at_ms, outcome)
  values (@nonce, @user_id, @wallet, @domain, @uri, @chain_id, @session_sha256, @intent, @issued_at, @expiration, @expires_at_ms, null, null)
`)

type DestChallengeRow = {
  nonce: string
  user_id: string
  wallet: string
  domain: string
  uri: string
  chain_id: string
  session_sha256: string
  intent: string
  issued_at: string
  expiration: string
  expires_at_ms: number
  consumed_at_ms: number | null
}

const selectDestChallenge = core.raw.prepare<[string], DestChallengeRow>('select * from link_challenges where nonce = ?')

const consumeDestChallenge = core.raw.prepare(`
  update link_challenges
     set consumed_at_ms = @now,
         outcome = 'destination_confirmed'
   where nonce = @nonce
     and wallet = @wallet
     and session_sha256 = @session_sha256
     and intent = @intent
     and consumed_at_ms is null
     and expires_at_ms > @now
`)

/* --------------------------------------------------------------- helpers */

const newWithdrawalId = () => `wd_${randomBytes(16).toString('hex')}`

function event(
  withdrawalId: string,
  from: WithdrawalState,
  to: WithdrawalState,
  reason: string,
  evidence: unknown,
  now: number,
): void {
  insertEvent.run({
    event_id: `we_${randomBytes(12).toString('hex')}`,
    withdrawal_id: withdrawalId,
    seq: (nextEventSeq.get(withdrawalId)?.seq ?? 0) + 1,
    from_state: from,
    to_state: to,
    reason,
    evidence_json: evidence === undefined ? null : JSON.stringify(evidence),
    now,
  })
}

function move(row: WithdrawalRow, to: WithdrawalState, reason: string, now: number, evidence?: unknown): boolean {
  if (!canTransition(row.state, to)) return false
  const terminal = TRANSITIONS[to].length === 0
  if (advance.run({ withdrawal_id: row.withdrawal_id, from_state: row.state, to_state: to, terminal: terminal ? 1 : 0, now }).changes !== 1) {
    return false
  }
  event(row.withdrawal_id, row.state, to, reason, evidence, now)
  return true
}

/* ----------------------------------------------------------------- quote */

export type QuoteResult =
  | {
      ok: true
      withdrawalId: string
      state: WithdrawalState
      goldAmount: string
      rateLamportsPerGold: string
      grossLamports: string
      feeLamports: string
      netLamports: string
      configFingerprint: string
      idempotent: boolean
    }
  | { ok: false; code: 'missing_configuration'; missing: MissingConfig[]; invalid: Array<{ key: string; reason: string }>; detail: string }
  | { ok: false; code: 'not_eligible' | 'below_minimum' | 'over_limit' | 'invalid_amount' | 'treasury_unfunded'; detail: string }

/**
 * Quotes a withdrawal, or explains exactly why it cannot.
 *
 * `configOverride` exists so the state machine can be tested end to end. It is
 * never populated from the environment or from a request: a caller inside the HTTP
 * layer has no way to pass it, so a live quote can only ever come from real
 * configuration.
 */
export function quoteWithdrawal(input: {
  userId: string
  goldAmount: unknown
  idempotencyKey?: string
  configOverride?: WithdrawalConfig
  now?: number
}): QuoteResult {
  const now = input.now ?? Date.now()

  const configOutcome = input.configOverride ? { ok: true as const, config: input.configOverride } : readWithdrawalConfig()
  if (!configOutcome.ok) {
    return {
      ok: false,
      code: 'missing_configuration',
      missing: configOutcome.missing,
      invalid: configOutcome.invalid,
      detail:
        'Withdrawals are not configured. Each value below is a decision the operator has to make; none of them has a default and this server will not invent a reward rate.',
    }
  }
  const config = configOutcome.config

  const amount =
    typeof input.goldAmount === 'string' && /^[1-9][0-9]{0,18}$/.test(input.goldAmount)
      ? BigInt(input.goldAmount)
      : typeof input.goldAmount === 'number' && Number.isSafeInteger(input.goldAmount) && input.goldAmount > 0
        ? BigInt(input.goldAmount)
        : null
  if (amount === null) return { ok: false, code: 'invalid_amount', detail: 'goldAmount must be a whole number greater than zero' }

  const redeemable = eligibilityOf(input.userId).redeemable
  if (amount > redeemable) {
    return {
      ok: false,
      code: 'not_eligible',
      detail: `only ${redeemable} gold is redeemable on this account. Redeemable gold comes from verified hunt rewards; duel winnings, gifts and imported demo balances are not redeemable.`,
    }
  }
  if (amount < config.minimumGold) {
    return { ok: false, code: 'below_minimum', detail: `the minimum withdrawal is ${config.minimumGold} gold` }
  }

  let alreadyCommitted = 0n
  for (const row of sumWithdrawnGold.all(input.userId)) {
    if (row.state === 'cancelled' || row.state === 'failed' || row.state === 'draft' || row.state === 'quoted') continue
    alreadyCommitted += fromStored(row.gold_amount)
  }
  if (alreadyCommitted + amount > config.perPlayerLimitGold) {
    return {
      ok: false,
      code: 'over_limit',
      detail: `this account has committed ${alreadyCommitted} gold and the per-player limit is ${config.perPlayerLimitGold}`,
    }
  }

  const gross = amount * config.rateLamportsPerGold
  const fee = config.feeReserveLamports
  if (gross <= fee) {
    return { ok: false, code: 'below_minimum', detail: 'at this rate the fee reserve is not smaller than the payout' }
  }
  const net = gross - fee

  const idemKey = input.idempotencyKey ?? `wd:${input.userId}:${amount}:${config.fingerprint}`
  const withdrawalId = newWithdrawalId()
  const created =
    insertWithdrawal.run({
      withdrawal_id: withdrawalId,
      owner_user_id: input.userId,
      state: 'quoted',
      gold_amount: toStored(amount),
      rate: toStored(config.rateLamportsPerGold),
      gross: toStored(gross),
      fee: toStored(fee),
      net: toStored(net),
      dest_network: `solana:${CLUSTER}`,
      fingerprint: config.fingerprint,
      missing_config: null,
      idem_key: idemKey,
      env_stamp: ENV_STAMP,
      now,
      quoted_at_ms: now,
    }).changes === 1

  const row = created ? selectWithdrawal.get(withdrawalId)! : selectWithdrawalByIdem.get(idemKey)!
  if (created) event(row.withdrawal_id, 'draft', 'quoted', 'quoted against explicit configuration', { fingerprint: config.fingerprint }, now)

  return {
    ok: true,
    withdrawalId: row.withdrawal_id,
    state: row.state,
    goldAmount: row.gold_amount,
    rateLamportsPerGold: row.rate_lamports_per_gold!,
    grossLamports: row.gross_lamports!,
    feeLamports: row.fee_lamports!,
    netLamports: row.net_lamports!,
    configFingerprint: row.config_fingerprint!,
    idempotent: !created,
  }
}

/* -------------------------------------------- destination confirmation */

export function issueDestinationChallenge(input: {
  userId: string
  withdrawalId: string
  address: unknown
  domain: string
  uri: string
  sessionHash: string
  now?: number
}): { ok: true; fields: SiwsFields } | { ok: false; reason: string } {
  const now = input.now ?? Date.now()
  if (!looksLikeAddress(input.address)) return { ok: false, reason: 'destination must be a base58 Solana address' }
  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row || row.owner_user_id !== input.userId) return { ok: false, reason: 'no such withdrawal' }
  if (row.state !== 'quoted') return { ok: false, reason: `a destination can only be confirmed while the withdrawal is quoted (it is ${row.state})` }

  const expiresAtMs = now + NONCE_TTL_MS
  const fields: SiwsFields = {
    domain: input.domain,
    address: input.address,
    uri: input.uri,
    statement: DESTINATION_STATEMENT,
    version: SIWS_VERSION,
    chainId: CHAIN_ID,
    nonce: randomBytes(32).toString('hex'),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(expiresAtMs).toISOString(),
  }
  insertDestChallenge.run({
    nonce: fields.nonce,
    user_id: input.userId,
    wallet: input.address,
    domain: input.domain,
    uri: input.uri,
    chain_id: fields.chainId,
    session_sha256: input.sessionHash,
    // The intent column carries the withdrawal the challenge authorises, so one
    // nonce cannot confirm a destination for a different withdrawal.
    intent: `withdrawal_destination:${input.withdrawalId}`,
    issued_at: fields.issuedAt,
    expiration: fields.expirationTime,
    expires_at_ms: expiresAtMs,
  })
  return { ok: true, fields }
}

export function confirmDestination(input: {
  userId: string
  sessionHash: string
  withdrawalId: string
  address: unknown
  nonce: unknown
  signature: unknown
  now?: number
}): { ok: true; address: string } | { ok: false; reason: string } {
  const now = input.now ?? Date.now()
  if (!looksLikeAddress(input.address)) return { ok: false, reason: 'destination must be a base58 Solana address' }
  if (!looksLikeNonce(input.nonce)) return { ok: false, reason: 'malformed nonce' }
  if (typeof input.signature !== 'string' || input.signature.length > 128) return { ok: false, reason: 'malformed signature' }
  if (!sessionIsLive(input.sessionHash, now)) return { ok: false, reason: 'this session is no longer valid' }

  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row || row.owner_user_id !== input.userId) return { ok: false, reason: 'no such withdrawal' }

  const intent = `withdrawal_destination:${input.withdrawalId}`
  const challenge = selectDestChallenge.get(input.nonce)
  if (
    !challenge ||
    challenge.intent !== intent ||
    challenge.wallet !== input.address ||
    challenge.session_sha256 !== input.sessionHash ||
    challenge.consumed_at_ms !== null ||
    challenge.expires_at_ms <= now
  ) {
    return { ok: false, reason: 'destination challenge is unknown, already used, expired, or not for this withdrawal' }
  }

  let publicKeyBytes: Uint8Array
  let signatureBytes: Uint8Array
  try {
    publicKeyBytes = bs58.decode(input.address)
    signatureBytes = bs58.decode(input.signature)
  } catch {
    return { ok: false, reason: 'address or signature is not valid base58' }
  }
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) return { ok: false, reason: 'malformed key or signature' }

  const message = buildSiwsMessage({
    domain: challenge.domain,
    address: challenge.wallet,
    uri: challenge.uri,
    statement: DESTINATION_STATEMENT,
    version: SIWS_VERSION,
    chainId: challenge.chain_id,
    nonce: challenge.nonce,
    issuedAt: challenge.issued_at,
    expirationTime: challenge.expiration,
  })

  let valid = false
  try {
    valid = ed25519.verify(signatureBytes, new TextEncoder().encode(message), publicKeyBytes)
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'signature does not match the challenge' }

  if (
    consumeDestChallenge.run({ nonce: challenge.nonce, wallet: input.address, session_sha256: input.sessionHash, intent, now })
      .changes !== 1
  ) {
    return { ok: false, reason: 'destination challenge was already used' }
  }
  if (setDestination.run({ withdrawal_id: row.withdrawal_id, network: `solana:${CLUSTER}`, address: input.address, nonce: challenge.nonce, now }).changes !== 1) {
    return { ok: false, reason: `this withdrawal is ${row.state} and cannot take a destination` }
  }
  event(row.withdrawal_id, 'quoted', 'destination_confirmed', 'destination proved by signature from the destination address', { nonce: challenge.nonce }, now)
  return { ok: true, address: input.address }
}

/* ------------------------------------------------------------- reserve */

class Rollback extends Error {
  constructor(readonly payload: { code: ReserveFailure; detail: string }) {
    super(payload.detail)
  }
}

export type ReserveFailure = 'wrong_state' | 'stale_config' | 'not_eligible' | 'treasury_unfunded' | 'contention'

export type ReserveResult =
  | { ok: true; reservationId: string; treasuryReservationId: string; idempotent: boolean }
  | { ok: false; code: ReserveFailure; detail: string }

/**
 * Reserves the player's eligible gold and the treasury's lamports together.
 *
 * Both sides happen in one transaction on the financial database, so there is no
 * state in which the player's gold is held but the campaign budget is not. With no
 * campaign funding the treasury leg fails on insufficient funds and the whole
 * thing rolls back — which is the honest outcome, and the path is exercised in the
 * test suite by funding a test treasury explicitly.
 */
export function reserveWithdrawal(input: {
  userId: string
  withdrawalId: string
  configOverride?: WithdrawalConfig
  now?: number
}): ReserveResult {
  const now = input.now ?? Date.now()
  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row || row.owner_user_id !== input.userId) return { ok: false, code: 'wrong_state', detail: 'no such withdrawal' }
  if (row.state === 'reserved') {
    return { ok: true, reservationId: row.reservation_id!, treasuryReservationId: row.treasury_reservation_id!, idempotent: true }
  }
  if (row.state !== 'destination_confirmed') {
    return { ok: false, code: 'wrong_state', detail: `a withdrawal must have a confirmed destination before it can reserve (it is ${row.state})` }
  }

  const configOutcome = input.configOverride ? { ok: true as const, config: input.configOverride } : readWithdrawalConfig()
  if (!configOutcome.ok) return { ok: false, code: 'stale_config', detail: 'withdrawals are no longer configured' }
  if (configOutcome.config.fingerprint !== row.config_fingerprint) {
    return { ok: false, code: 'stale_config', detail: 'the reward configuration changed after this withdrawal was quoted. Re-quote it.' }
  }

  const gold = fromStored(row.gold_amount)
  const gross = fromStored(row.gross_lamports!)
  const fee = fromStored(row.fee_lamports!)
  const reservationId = `br_${randomBytes(12).toString('hex')}`
  const treasuryReservationId = `tr_${randomBytes(12).toString('hex')}`

  ensureLedgerAccount({ accountId: withdrawalLamports(row.withdrawal_id), kind: 'pending', currency: LAMPORTS }, now)

  try {
    return immediateTransaction(fin, (): ReserveResult => {
      if (eligibilityOf(input.userId).redeemable < gold) {
        throw new Rollback({ code: 'not_eligible', detail: 'this account no longer has that much redeemable gold' })
      }

      const goldLeg = postTransfer({
        kind: 'withdrawal.reserve',
        idemScope: 'withdrawal-reserve-gold',
        idemKey: row.withdrawal_id,
        refType: 'withdrawal',
        refId: row.withdrawal_id,
        note: 'Redeemable gold reserved for a withdrawal',
        now,
        legs: [
          {
            accountId: playerAvailable(input.userId),
            amount: -gold,
            provenance: 'withdrawal',
            ownerUserId: input.userId,
            note: 'Reserved for withdrawal',
          },
          {
            accountId: playerReserved(input.userId),
            amount: gold,
            provenance: 'withdrawal',
            ownerUserId: input.userId,
            note: 'Reserved for withdrawal',
          },
        ],
      })
      if (!goldLeg.ok) {
        throw new Rollback({
          code: goldLeg.code === 'insufficient_funds' ? 'not_eligible' : 'contention',
          detail: goldLeg.reason,
        })
      }

      // Raising `consumed` is what stops the same redeemable gold being quoted
      // twice while this withdrawal is outstanding.
      if (!consumeEligible(input.userId, gold, now)) {
        throw new Rollback({ code: 'contention', detail: 'reward eligibility changed underneath this reservation' })
      }

      const treasuryLeg = postTransfer({
        kind: 'treasury.reserve',
        idemScope: 'withdrawal-reserve-treasury',
        idemKey: row.withdrawal_id,
        currency: LAMPORTS,
        refType: 'withdrawal',
        refId: row.withdrawal_id,
        note: 'Campaign lamports reserved for a withdrawal',
        now,
        legs: [
          { accountId: TREASURY_LAMPORTS, amount: -gross, provenance: 'withdrawal', note: 'Campaign budget reserved' },
          {
            accountId: withdrawalLamports(row.withdrawal_id),
            amount: gross,
            provenance: 'withdrawal',
            ownerUserId: input.userId,
            note: 'Held against this withdrawal, fee reserve included',
          },
        ],
      })
      if (!treasuryLeg.ok) {
        throw new Rollback({
          code: treasuryLeg.code === 'insufficient_funds' ? 'treasury_unfunded' : 'contention',
          detail:
            treasuryLeg.code === 'insufficient_funds'
              ? `the campaign budget holds ${balanceOf(TREASURY_LAMPORTS)} lamports and cannot fund ${gross}. No treasury is funded in this deployment.`
              : treasuryLeg.reason,
        })
      }

      insertBudgetReservation.run({
        reservation_id: reservationId,
        owner_user_id: input.userId,
        amount: toStored(gold),
        transfer_id: goldLeg.transferId,
        now,
      })
      insertTreasuryReservation.run({
        reservation_id: treasuryReservationId,
        withdrawal_id: row.withdrawal_id,
        amount: toStored(gross),
        fee_reserve: toStored(fee),
        transfer_id: treasuryLeg.transferId,
        now,
      })
      if (
        setReservations.run({
          withdrawal_id: row.withdrawal_id,
          reservation_id: reservationId,
          treasury_reservation_id: treasuryReservationId,
          now,
        }).changes !== 1
      ) {
        throw new Rollback({ code: 'contention', detail: 'the withdrawal changed state underneath this reservation' })
      }
      event(row.withdrawal_id, 'destination_confirmed', 'reserved', 'gold and treasury lamports reserved atomically', {
        gold: toStored(gold),
        lamports: toStored(gross),
      }, now)
      return { ok: true, reservationId, treasuryReservationId, idempotent: false }
    })
  } catch (error) {
    if (error instanceof Rollback) return { ok: false, ...error.payload }
    throw error
  }
}

/* -------------------------------------------------------------- submit */

export type SubmitResult =
  | { ok: false; code: 'no_signer'; detail: string; reason: string }
  | { ok: false; code: 'wrong_state'; detail: string }

/**
 * There is nothing to call.
 *
 * This is not a stub waiting for an environment variable: the process holds no
 * key. The state machine stops here and says so, and `submitted` is reachable only
 * from `settleWithSignature`, which requires evidence rather than producing it.
 */
export function submitWithdrawal(input: { userId: string; withdrawalId: string }): SubmitResult {
  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row || row.owner_user_id !== input.userId) return { ok: false, code: 'wrong_state', detail: 'no such withdrawal' }
  if (row.state !== 'reserved') return { ok: false, code: 'wrong_state', detail: `a withdrawal must be reserved before submission (it is ${row.state})` }
  return {
    ok: false,
    code: 'no_signer',
    detail: 'The reservation is held and the withdrawal is ready. It cannot be paid: there is no treasury signer.',
    reason: TREASURY_SIGNER.reason,
  }
}

/* ------------------------------------------------- settle and reconcile */

export type SettleResult =
  | { ok: true; state: WithdrawalState; idempotent: boolean }
  | { ok: false; code: 'wrong_state' | 'contention'; detail: string }

/**
 * Records that a payout landed, and consumes both reservations.
 *
 * Idempotent on the withdrawal id: the reservation-consuming transfers carry it as
 * their idempotency key, so calling this twice with the same signature moves money
 * once. Reachable only with externally supplied settlement evidence, which in this
 * deployment means only from a test.
 */
export function settleWithSignature(input: {
  withdrawalId: string
  signature: string
  now?: number
}): SettleResult {
  const now = input.now ?? Date.now()
  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row) return { ok: false, code: 'wrong_state', detail: 'no such withdrawal' }
  if (row.state === 'settled') return { ok: true, state: 'settled', idempotent: true }
  if (row.state !== 'reserved' && row.state !== 'submitted' && row.state !== 'settling' && row.state !== 'reconcile_required') {
    return { ok: false, code: 'wrong_state', detail: `a ${row.state} withdrawal cannot settle` }
  }

  const gold = fromStored(row.gold_amount)
  const gross = fromStored(row.gross_lamports!)

  try {
    return immediateTransaction(fin, (): SettleResult => {
      // The reserved gold is spent: it leaves the player's reserved account for the
      // sink, because it has been exchanged for something outside this ledger.
      const spendGold = postTransfer({
        kind: 'withdrawal.settle',
        idemScope: 'withdrawal-settle-gold',
        idemKey: row.withdrawal_id,
        refType: 'withdrawal',
        refId: row.withdrawal_id,
        note: 'Redeemed gold retired on settlement',
        now,
        legs: [
          {
            accountId: playerReserved(row.owner_user_id),
            amount: -gold,
            provenance: 'withdrawal',
            ownerUserId: row.owner_user_id,
            note: 'Redeemed',
          },
          { accountId: SYSTEM_SINK, amount: gold, provenance: 'withdrawal', note: 'Redeemed gold retired' },
        ],
      })
      if (!spendGold.ok) throw new Rollback({ code: 'contention', detail: spendGold.reason })

      const spendTreasury = postTransfer({
        kind: 'treasury.settle',
        idemScope: 'withdrawal-settle-treasury',
        idemKey: row.withdrawal_id,
        currency: LAMPORTS,
        refType: 'withdrawal',
        refId: row.withdrawal_id,
        note: 'Campaign lamports paid out',
        now,
        legs: [
          {
            accountId: withdrawalLamports(row.withdrawal_id),
            amount: -gross,
            provenance: 'withdrawal',
            ownerUserId: row.owner_user_id,
            note: 'Paid out',
          },
          { accountId: SYSTEM_SINK, amount: gross, provenance: 'withdrawal', note: 'Left the ledger as a chain payment' },
        ],
        allowNegative: [SYSTEM_SINK],
      })
      if (!spendTreasury.ok) throw new Rollback({ code: 'contention', detail: spendTreasury.reason })

      closeBudgetReservation.run({ reservation_id: row.reservation_id, status: 'settled', release_transfer_id: spendGold.transferId, now })
      closeTreasuryReservation.run({ reservation_id: row.treasury_reservation_id, status: 'settled', release_transfer_id: spendTreasury.transferId, now })
      setSignature.run({ withdrawal_id: row.withdrawal_id, signature: input.signature, now })
      if (!move(row, 'settled', 'settlement evidence recorded', now, { signature: input.signature })) {
        throw new Rollback({ code: 'contention', detail: 'the withdrawal changed state underneath this settlement' })
      }
      return { ok: true, state: 'settled', idempotent: false }
    })
  } catch (error) {
    if (error instanceof Rollback) {
      // The rollback vocabulary is wider than settlement's, so narrow it here
      // rather than widening the result type and inviting a caller to handle a
      // code this path cannot produce.
      const code = error.payload.code === 'wrong_state' ? 'wrong_state' : 'contention'
      return { ok: false, code, detail: error.payload.detail }
    }
    throw error
  }
}

/**
 * Moves an indeterminate withdrawal to `reconcile_required`.
 *
 * Called when a submission times out or a status read comes back unknown. It is
 * deliberately not `failed`: a timeout is not evidence that no payment occurred,
 * and a withdrawal in this state must not be retried until something has actually
 * been checked.
 */
export function requireWithdrawalReconcile(withdrawalId: string, reason: string, now = Date.now()): boolean {
  const row = selectWithdrawal.get(withdrawalId)
  if (!row) return false
  setFailure.run({ withdrawal_id: withdrawalId, reason, now })
  return move(row, 'reconcile_required', reason, now)
}

export function failWithdrawal(withdrawalId: string, reason: string, now = Date.now()): boolean {
  const row = selectWithdrawal.get(withdrawalId)
  if (!row) return false
  if (!canTransition(row.state, 'failed')) return false
  const released = releaseReservations(row, 'released', now)
  setFailure.run({ withdrawal_id: withdrawalId, reason, now })
  return move(row, 'failed', reason, now, { released })
}

/* -------------------------------------------------------------- cancel */

export type CancelResult =
  | { ok: true; releasedGold: string; releasedLamports: string }
  | { ok: false; code: 'not_cancellable'; detail: string }

/**
 * Cancels an unspent withdrawal and releases what it was holding.
 *
 * `settled` has no transition to `cancelled`, so this cannot reverse a payment.
 * That distinction is the point: releasing a reservation gives budget back, and a
 * payment that already happened is not a reservation.
 */
export function cancelWithdrawal(input: { userId: string; withdrawalId: string; now?: number }): CancelResult {
  const now = input.now ?? Date.now()
  const row = selectWithdrawal.get(input.withdrawalId)
  if (!row || row.owner_user_id !== input.userId) return { ok: false, code: 'not_cancellable', detail: 'no such withdrawal' }
  if (!canTransition(row.state, 'cancelled')) {
    return {
      ok: false,
      code: 'not_cancellable',
      detail:
        row.state === 'settled'
          ? 'this withdrawal has settled. Cancelling releases an unspent reservation; it does not reverse a payment that already happened.'
          : `a ${row.state} withdrawal cannot be cancelled`,
    }
  }
  const released = releaseReservations(row, 'released', now)
  if (!move(row, 'cancelled', 'cancelled by the owner', now, released)) {
    return { ok: false, code: 'not_cancellable', detail: 'the withdrawal changed state underneath this cancellation' }
  }
  return { ok: true, releasedGold: released.gold, releasedLamports: released.lamports }
}

function releaseReservations(row: WithdrawalRow, status: 'released', now: number): { gold: string; lamports: string } {
  let gold = '0'
  let lamports = '0'
  if (row.reservation_id) {
    const amount = fromStored(row.gold_amount)
    const back = postTransfer({
      kind: 'withdrawal.release',
      idemScope: 'withdrawal-release-gold',
      idemKey: row.withdrawal_id,
      refType: 'withdrawal',
      refId: row.withdrawal_id,
      note: 'Withdrawal reservation released',
      now,
      legs: [
        {
          accountId: playerReserved(row.owner_user_id),
          amount: -amount,
          provenance: 'withdrawal',
          ownerUserId: row.owner_user_id,
          note: 'Released',
        },
        {
          accountId: playerAvailable(row.owner_user_id),
          amount,
          provenance: 'withdrawal',
          ownerUserId: row.owner_user_id,
          note: 'Released back to available',
        },
      ],
    })
    if (back.ok) {
      releaseEligible(row.owner_user_id, amount, now)
      closeBudgetReservation.run({ reservation_id: row.reservation_id, status, release_transfer_id: back.transferId, now })
      gold = toStored(amount)
    }
  }
  if (row.treasury_reservation_id && row.gross_lamports) {
    const amount = fromStored(row.gross_lamports)
    const back = postTransfer({
      kind: 'treasury.release',
      idemScope: 'withdrawal-release-treasury',
      idemKey: row.withdrawal_id,
      currency: LAMPORTS,
      refType: 'withdrawal',
      refId: row.withdrawal_id,
      note: 'Campaign reservation released',
      now,
      legs: [
        {
          accountId: withdrawalLamports(row.withdrawal_id),
          amount: -amount,
          provenance: 'withdrawal',
          ownerUserId: row.owner_user_id,
          note: 'Released',
        },
        { accountId: TREASURY_LAMPORTS, amount, provenance: 'withdrawal', note: 'Returned to the campaign budget' },
      ],
    })
    if (back.ok) {
      closeTreasuryReservation.run({ reservation_id: row.treasury_reservation_id, status, release_transfer_id: back.transferId, now })
      lamports = toStored(amount)
    }
  }
  return { gold, lamports }
}

/* --------------------------------------------------------------- views */

export type WithdrawalView = {
  withdrawalId: string
  state: WithdrawalState
  goldAmount: string
  rateLamportsPerGold: string | null
  grossLamports: string | null
  feeLamports: string | null
  netLamports: string | null
  destination: string | null
  destinationConfirmedAtMs: number | null
  signature: string | null
  failureReason: string | null
  nextStates: readonly WithdrawalState[]
  events: Array<{ seq: number; from: string; to: string; reason: string; atMs: number }>
}

const viewWithdrawal = (row: WithdrawalRow): WithdrawalView => ({
  withdrawalId: row.withdrawal_id,
  state: row.state,
  goldAmount: row.gold_amount,
  rateLamportsPerGold: row.rate_lamports_per_gold,
  grossLamports: row.gross_lamports,
  feeLamports: row.fee_lamports,
  netLamports: row.net_lamports,
  destination: row.dest_address,
  destinationConfirmedAtMs: row.dest_confirmed_at_ms,
  signature: row.signature,
  failureReason: row.failure_reason,
  nextStates: TRANSITIONS[row.state],
  events: selectEvents.all(row.withdrawal_id).map(e => ({
    seq: e.seq,
    from: e.from_state,
    to: e.to_state,
    reason: e.reason,
    atMs: e.created_at_ms,
  })),
})

export function readWithdrawalForOwner(withdrawalId: string, userId: string): WithdrawalView | null {
  const row = selectWithdrawal.get(withdrawalId)
  if (!row || row.owner_user_id !== userId) return null
  return viewWithdrawal(row)
}

export function listWithdrawalsForOwner(userId: string, limit = 25): WithdrawalView[] {
  return selectWithdrawalsForOwner.all(userId, limit).map(viewWithdrawal)
}

/** Test-only: credits the campaign budget so the reservation path can be exercised. */
export function fundTestTreasury(lamports: bigint, now = Date.now()) {
  return postTransfer({
    kind: 'treasury.test_fund',
    idemScope: 'treasury-test-fund',
    idemKey: `${lamports}:${now}`,
    currency: LAMPORTS,
    note: 'Test-only campaign funding. Not real lamports and not a payout capability.',
    now,
    legs: [
      { accountId: 'system:lamports:mint', amount: -lamports, provenance: 'system', note: 'test funding' },
      { accountId: TREASURY_LAMPORTS, amount: lamports, provenance: 'system', note: 'test funding' },
    ],
  })
}
