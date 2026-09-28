/*
 * The withdrawal state machine, with no treasury key and no payout call.
 *
 * Read the first section carefully before reading anything into the rest: with the
 * environment as it ships, a withdrawal cannot be quoted at all, because five
 * numbers the operator has to decide are absent and this server will not invent
 * them. Everything after that uses an explicit test configuration to drive the
 * state machine, which is a test of the machine and not a claim that withdrawals
 * work. Submission always refuses, because there is no signer.
 *
 * Run with: npm run test:withdrawals
 */
import { createHash, randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

useTestDatabases('test-withdrawals')

const { WITHDRAWAL_CONFIG_KEYS, readWithdrawalConfig, withFingerprint, TREASURY_SIGNER } =
  await import('../src/server/treasury/config')
const {
  TRANSITIONS,
  canTransition,
  quoteWithdrawal,
  issueDestinationChallenge,
  confirmDestination,
  reserveWithdrawal,
  submitWithdrawal,
  settleWithSignature,
  requireWithdrawalReconcile,
  cancelWithdrawal,
  readWithdrawalForOwner,
  listWithdrawalsForOwner,
  fundTestTreasury,
  DESTINATION_STATEMENT,
} = await import('../src/server/treasury/withdrawals')
const { buildSiwsMessage, SIWS_VERSION, SIWS_STATEMENT } = await import('../src/shared/siws')
const { CHAIN_ID } = await import('../src/server/config')
const { saveSession } = await import('../src/server/db')
const { creditGold, goldSnapshot, ensureGoldAccounts } = await import('../src/server/money/gold')
const { balanceOf, playerAvailable, playerReserved, conservationReport, TREASURY_LAMPORTS, eligibilityOf } =
  await import('../src/server/money/ledger')
const { resolveUserForPrincipal } = await import('../src/server/identity/users')

/* ------------------------------------------------- unconfigured, on purpose */

section('with nothing configured, the endpoint says exactly what is missing')

for (const key of Object.keys(WITHDRAWAL_CONFIG_KEYS)) {
  check(`${key} is absent from this environment`, process.env[key] === undefined,
    process.env[key] === undefined ? '' : 'it is set, so the next checks are not testing what they claim')
}

const unconfigured = readWithdrawalConfig()
check('reading the configuration fails', !unconfigured.ok)
if (!unconfigured.ok) {
  equal('all five values are reported missing', unconfigured.missing.length, 5)
  check('each one is explained', unconfigured.missing.every(entry => entry.what.length > 20))
  equal('none is merely invalid', unconfigured.invalid.length, 0)
}

const UNCONFIGURED_USER = resolveUserForPrincipal('dev-unconfigured').userId
ensureGoldAccounts(UNCONFIGURED_USER)
creditGold({ userId: UNCONFIGURED_USER, amount: 5000n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'u-1', note: 'hunt' })

const refused = quoteWithdrawal({ userId: UNCONFIGURED_USER, goldAmount: '1000' })
check('a quote is refused', !refused.ok)
check('and refused specifically for missing configuration', !refused.ok && refused.code === 'missing_configuration',
  refused.ok ? 'it quoted' : refused.code)
if (!refused.ok && refused.code === 'missing_configuration') {
  equal('naming all five', refused.missing.length, 5)
  check('and saying it will not invent a rate', refused.detail.includes('will not invent'))
}
equal('no withdrawal row was created', listWithdrawalsForOwner(UNCONFIGURED_USER).length, 0)

section('there is no signer, and that is not a configuration gap')

check('the signer reports itself unavailable', TREASURY_SIGNER.available === false)
check('and says why in words an operator can act on', TREASURY_SIGNER.reason.includes('custody decision'))

/* ---------------------------------------------- the machine, driven by a test */

section('the transition table refuses what it should')

check('a settled withdrawal has nowhere to go', TRANSITIONS.settled.length === 0)
check('so a settled payment cannot be cancelled', !canTransition('settled', 'cancelled'))
check('nor reversed to reserved', !canTransition('settled', 'reserved'))
check('a draft cannot jump straight to settled', !canTransition('draft', 'settled'))
check('a quote cannot reserve before the destination is confirmed', !canTransition('quoted', 'reserved'))
check('a confirmed destination may reserve', canTransition('destination_confirmed', 'reserved'))
check('a reserved withdrawal may need reconciling', canTransition('reserved', 'reconcile_required'))

const CONFIG = withFingerprint({
  rateLamportsPerGold: 1_000n,
  minimumGold: 100n,
  perPlayerLimitGold: 2_000n,
  campaignBudgetLamports: 10_000_000n,
  feeReserveLamports: 5_000n,
})

const PRINCIPAL = 'dev-withdrawer'
const USER = resolveUserForPrincipal(PRINCIPAL).userId
ensureGoldAccounts(USER)

const sessionToken = randomBytes(32).toString('base64url')
const sessionHash = createHash('sha256').update(sessionToken).digest('hex')
saveSession(sessionHash, PRINCIPAL, Date.now(), Date.now() + 60 * 60 * 1000)

const secret = ed25519.utils.randomSecretKey()
const destination = bs58.encode(ed25519.getPublicKey(secret))
const sign = (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret))

section('only redeemable gold can be quoted')

creditGold({ userId: USER, amount: 900n, provenance: 'pvp_winnings', idemScope: 'duel', idemKey: 'w-1', note: 'duel winnings' })
creditGold({ userId: USER, amount: 900n, provenance: 'legacy_demo', idemScope: 'legacy', idemKey: 'w-2', note: 'old demo balance' })
equal('the account has gold', goldSnapshot(USER).available, 1800n)
equal('but none of it is redeemable', goldSnapshot(USER).redeemable, 0n)

const notEligible = quoteWithdrawal({ userId: USER, goldAmount: '500', configOverride: CONFIG })
check('a quote against unredeemable gold is refused', !notEligible.ok && notEligible.code === 'not_eligible',
  notEligible.ok ? 'it quoted' : notEligible.code)
check('and the reason names which sources do not count',
  !notEligible.ok && notEligible.code !== 'missing_configuration' && notEligible.detail.includes('duel winnings'))

creditGold({ userId: USER, amount: 1_200n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'w-3', note: 'verified hunt' })
equal('hunting makes gold redeemable', goldSnapshot(USER).redeemable, 1_200n)

check('below the minimum is refused',
  !quoteWithdrawal({ userId: USER, goldAmount: '50', configOverride: CONFIG }).ok)
check('a fractional amount is refused',
  !quoteWithdrawal({ userId: USER, goldAmount: '1.5', configOverride: CONFIG }).ok)
check('a float is refused',
  !quoteWithdrawal({ userId: USER, goldAmount: 1.5, configOverride: CONFIG }).ok)
check('more than is redeemable is refused',
  !quoteWithdrawal({ userId: USER, goldAmount: '1300', configOverride: CONFIG }).ok)

section('quoting')

const quote = quoteWithdrawal({ userId: USER, goldAmount: '1000', configOverride: CONFIG, idempotencyKey: 'wd-1' })
check('the quote was produced', quote.ok, quote.ok ? quote.withdrawalId : quote.code)
if (!quote.ok) finish('withdrawals')

equal('it is quoted', quote.state, 'quoted')
equal('gross is amount times rate, exactly', quote.grossLamports, (1_000n * CONFIG.rateLamportsPerGold).toString())
equal('the fee reserve is held back', quote.feeLamports, CONFIG.feeReserveLamports.toString())
equal('net is gross minus fee', quote.netLamports, (1_000n * CONFIG.rateLamportsPerGold - CONFIG.feeReserveLamports).toString())
equal('the configuration is fingerprinted onto the row', quote.configFingerprint, CONFIG.fingerprint)
check('re-quoting the same key returns the same withdrawal', (() => {
  const again = quoteWithdrawal({ userId: USER, goldAmount: '1000', configOverride: CONFIG, idempotencyKey: 'wd-1' })
  return again.ok && again.idempotent && again.withdrawalId === quote.withdrawalId
})())
equal('no gold has moved yet', balanceOf(playerReserved(USER)), 0n)

section('the destination must be signed for by the key that will receive it')

check('reserving before the destination is confirmed is refused',
  !reserveWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId, configOverride: CONFIG }).ok)

const destChallenge = issueDestinationChallenge({
  userId: USER,
  withdrawalId: quote.withdrawalId,
  address: destination,
  domain: 'voxels.test',
  uri: 'https://voxels.test',
  sessionHash,
})
check('a destination challenge was issued', destChallenge.ok)
if (!destChallenge.ok) finish('withdrawals')
check('the destination statement is its own', DESTINATION_STATEMENT !== SIWS_STATEMENT)

const destMessage = buildSiwsMessage({ ...destChallenge.fields, statement: DESTINATION_STATEMENT })

const wrongKey = ed25519.utils.randomSecretKey()
check('a signature from another key is refused', !confirmDestination({
  userId: USER,
  sessionHash,
  withdrawalId: quote.withdrawalId,
  address: destination,
  nonce: destChallenge.fields.nonce,
  signature: bs58.encode(ed25519.sign(new TextEncoder().encode(destMessage), wrongKey)),
}).ok)

check('a sign-in signature cannot confirm a destination', !confirmDestination({
  userId: USER,
  sessionHash,
  withdrawalId: quote.withdrawalId,
  address: destination,
  nonce: destChallenge.fields.nonce,
  signature: sign(buildSiwsMessage({ ...destChallenge.fields, statement: SIWS_STATEMENT })),
}).ok)

const confirmed = confirmDestination({
  userId: USER,
  sessionHash,
  withdrawalId: quote.withdrawalId,
  address: destination,
  nonce: destChallenge.fields.nonce,
  signature: sign(destMessage),
})
check('the right signature confirms it', confirmed.ok, confirmed.ok ? confirmed.address : confirmed.reason)
equal('the state advanced', readWithdrawalForOwner(quote.withdrawalId, USER)?.state, 'destination_confirmed')
check('the nonce cannot be reused', !confirmDestination({
  userId: USER,
  sessionHash,
  withdrawalId: quote.withdrawalId,
  address: destination,
  nonce: destChallenge.fields.nonce,
  signature: sign(destMessage),
}).ok)

section('reservation is atomic across the player and the treasury')

// With no campaign funding the treasury leg cannot cover the payout, and the
// player's gold must not be left held. This is the unfunded case, which is the
// real one for this deployment.
equal('the treasury is empty', balanceOf(TREASURY_LAMPORTS), 0n)
const unfunded = reserveWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId, configOverride: CONFIG })
check('reserving against an empty treasury fails', !unfunded.ok && unfunded.code === 'treasury_unfunded',
  unfunded.ok ? 'it reserved' : unfunded.code)
equal('and the player\'s gold was not left held', balanceOf(playerReserved(USER)), 0n)
equal('their available balance is untouched', balanceOf(playerAvailable(USER)), 3_000n)
equal('the withdrawal did not advance', readWithdrawalForOwner(quote.withdrawalId, USER)?.state, 'destination_confirmed')

check('a stale configuration cannot reserve a quote priced under another one', (() => {
  const different = withFingerprint({ ...CONFIG, rateLamportsPerGold: 2_000n })
  const stale = reserveWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId, configOverride: different })
  return !stale.ok && stale.code === 'stale_config'
})())

check('the test treasury funded', fundTestTreasury(5_000_000n).ok)
equal('the treasury holds lamports', balanceOf(TREASURY_LAMPORTS), 5_000_000n)

const reserved = reserveWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId, configOverride: CONFIG })
check('now the reservation succeeds', reserved.ok, reserved.ok ? reserved.reservationId : reserved.code)
equal('the player\'s gold is held', balanceOf(playerReserved(USER)), 1_000n)
equal('and is no longer available', balanceOf(playerAvailable(USER)), 2_000n)
equal('their redeemable headroom is consumed while it is held', goldSnapshot(USER).redeemable, 200n)
equal('the treasury holds less', balanceOf(TREASURY_LAMPORTS), 5_000_000n - 1_000n * CONFIG.rateLamportsPerGold)
equal('the state advanced', readWithdrawalForOwner(quote.withdrawalId, USER)?.state, 'reserved')
check('reserving again is a replay, not a second hold', (() => {
  const again = reserveWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId, configOverride: CONFIG })
  return again.ok && again.idempotent
})())
equal('so nothing was held twice', balanceOf(playerReserved(USER)), 1_000n)

section('submission has nothing to call')

const submitted = submitWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId })
check('submission refuses', !submitted.ok)
check('and refuses because there is no signer', !submitted.ok && submitted.code === 'no_signer',
  submitted.ok ? 'it submitted' : submitted.code)
equal('the reservation is still held', balanceOf(playerReserved(USER)), 1_000n)
equal('and the withdrawal is still reserved', readWithdrawalForOwner(quote.withdrawalId, USER)?.state, 'reserved')

section('settlement is idempotent — driven here by a test, never by this server')

const treasuryBeforeSettle = balanceOf(TREASURY_LAMPORTS)
const settled = settleWithSignature({ withdrawalId: quote.withdrawalId, signature: 'test-signature-1' })
check('settlement recorded', settled.ok, settled.ok ? settled.state : settled.code)
equal('it is settled', readWithdrawalForOwner(quote.withdrawalId, USER)?.state, 'settled')
equal('the held gold is spent, not returned', balanceOf(playerReserved(USER)), 0n)
equal('and did not come back as available', balanceOf(playerAvailable(USER)), 2_000n)

const settledAgain = settleWithSignature({ withdrawalId: quote.withdrawalId, signature: 'test-signature-1' })
check('settling twice is a replay', settledAgain.ok && settledAgain.idempotent)
equal('the treasury paid once', balanceOf(TREASURY_LAMPORTS), treasuryBeforeSettle)
equal('the player was debited once', balanceOf(playerAvailable(USER)), 2_000n)

check('a settled withdrawal cannot be cancelled',
  !cancelWithdrawal({ userId: USER, withdrawalId: quote.withdrawalId }).ok)
check('and cannot be forced back into reconcile',
  !requireWithdrawalReconcile(quote.withdrawalId, 'trying to reopen a settled payment'))

section('cancelling an unsettled withdrawal releases everything it held')

const second = quoteWithdrawal({ userId: USER, goldAmount: '200', configOverride: CONFIG, idempotencyKey: 'wd-2' })
check('a second withdrawal quoted', second.ok, second.ok ? second.withdrawalId : second.code)
if (!second.ok) finish('withdrawals')

const secondChallenge = issueDestinationChallenge({
  userId: USER, withdrawalId: second.withdrawalId, address: destination,
  domain: 'voxels.test', uri: 'https://voxels.test', sessionHash,
})
if (!secondChallenge.ok) finish('withdrawals')
confirmDestination({
  userId: USER, sessionHash, withdrawalId: second.withdrawalId, address: destination,
  nonce: secondChallenge.fields.nonce,
  signature: sign(buildSiwsMessage({ ...secondChallenge.fields, statement: DESTINATION_STATEMENT })),
})
const secondReserved = reserveWithdrawal({ userId: USER, withdrawalId: second.withdrawalId, configOverride: CONFIG })
check('it reserved', secondReserved.ok, secondReserved.ok ? '' : secondReserved.code)
equal('gold is held', balanceOf(playerReserved(USER)), 200n)

const treasuryBeforeCancel = balanceOf(TREASURY_LAMPORTS)
const cancelled = cancelWithdrawal({ userId: USER, withdrawalId: second.withdrawalId })
check('it cancelled', cancelled.ok, cancelled.ok ? '' : cancelled.detail)
equal('the gold came back', balanceOf(playerAvailable(USER)), 2_000n)
equal('nothing is held', balanceOf(playerReserved(USER)), 0n)
equal('the campaign budget was released', balanceOf(TREASURY_LAMPORTS), treasuryBeforeCancel + 200n * CONFIG.rateLamportsPerGold)
equal('redeemable headroom came back too', goldSnapshot(USER).redeemable, 200n)
check('cancelling twice is refused or a replay, never a second refund', (() => {
  const again = cancelWithdrawal({ userId: USER, withdrawalId: second.withdrawalId })
  return balanceOf(playerAvailable(USER)) === 2_000n && (!again.ok || again.ok)
})())

section('ownership')

check('another account cannot read this withdrawal',
  readWithdrawalForOwner(quote.withdrawalId, UNCONFIGURED_USER) === null)
check('another account cannot cancel it',
  !cancelWithdrawal({ userId: UNCONFIGURED_USER, withdrawalId: second.withdrawalId }).ok)
check('another account cannot reserve it',
  !reserveWithdrawal({ userId: UNCONFIGURED_USER, withdrawalId: second.withdrawalId, configOverride: CONFIG }).ok)
check('another account cannot settle it by confirming a destination',
  !issueDestinationChallenge({
    userId: UNCONFIGURED_USER, withdrawalId: second.withdrawalId, address: destination,
    domain: 'voxels.test', uri: 'https://voxels.test', sessionHash,
  }).ok)

section('the ledger balances, in gold and in lamports')

const report = conservationReport()
check('balances sum to zero across both currencies', report.balanceSum === 0n, report.balanceSum.toString())
check('entries sum to zero', report.entrySum === 0n, report.entrySum.toString())
check('no transfer is half-written', report.unbalancedTransfers.length === 0, report.unbalancedTransfers.join(','))
check('no balance drifted from its entries', report.driftedAccounts.length === 0,
  report.driftedAccounts.map(account => account.accountId).join(','))
equal('consumed headroom equals the settled withdrawal', eligibilityOf(USER).consumed, 1_000n)

finish('withdrawals')
