/* ------------------------------------------------------------------ *
 * Adapter tests that need no network (§13).
 *
 *   npm run test:providers
 *
 * Covers the three §5 invariants that are pure logic — the SPL-only asset rule,
 * the separation of payment state from delivery state, and the refusal to spend
 * incoming funds without settlement evidence — plus the readiness derivation,
 * because a console that can be made green by a stub is worse than no console.
 * ------------------------------------------------------------------ */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { PaidServiceSession, X402AssetError, assertSplAsset, buildPaymentRequired, defaultUsdcMint, verifyPaymentPayload } from './x402'
import { deriveState, type Evidence } from './types'
import { classifyZecDelivery, planZecPayout } from './oneclick'

/* ------------------------------------------------------------- asset rules */

test('native SOL is refused as an x402 asset, by name', () => {
  for (const value of ['native', 'SOL', 'sol', 'lamports', '']) {
    assert.throws(() => assertSplAsset(value), X402AssetError)
  }
  assert.throws(() => assertSplAsset('native'), /not an x402 asset/)
})

test('a real USDC mint is accepted and a non-address is not', () => {
  assert.doesNotThrow(() => assertSplAsset(defaultUsdcMint('mainnet-beta')))
  assert.throws(() => assertSplAsset('not-an-address'), X402AssetError)
})

test('a token program that is neither SPL nor Token-2022 is refused', () => {
  assert.throws(
    () => assertSplAsset(defaultUsdcMint('devnet'), 'SomeOtherProgram1111111111111111111111111111'),
    /neither SPL Token nor Token-2022/,
  )
})

test('buildPaymentRequired refuses native SOL rather than quoting it', () => {
  const result = buildPaymentRequired({
    cluster: 'devnet',
    resourceUrl: 'https://example.test/api/service',
    serviceName: 'test',
    description: 'test',
    amountBaseUnits: 10_000n,
    assetMint: 'native',
    payTo: 'BPFLoaderUpgradeab1e11111111111111111111111',
    maxTimeoutSeconds: 60,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'unsupported')
})

test('buildPaymentRequired emits a protocol-valid 402 for a real SPL mint', () => {
  const result = buildPaymentRequired({
    cluster: 'devnet',
    resourceUrl: 'https://example.test/api/service',
    serviceName: 'Town history brief',
    description: 'A brief',
    amountBaseUnits: 10_000n,
    assetMint: defaultUsdcMint('devnet'),
    payTo: 'BPFLoaderUpgradeab1e11111111111111111111111',
    maxTimeoutSeconds: 60,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.network, /^solana:/)
  // The header is produced by the SDK's codec, so a non-empty string here means
  // the object passed the SDK's own schema.
  assert.ok(result.header.length > 0)
})

/* -------------------------------------------------- payload verification */

test('a malformed X-PAYMENT header is a validation error, not a throw', () => {
  const result = verifyPaymentPayload({
    paymentHeader: 'not-base64-and-not-a-payload',
    expected: { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: 'x', payTo: 'y', amountBaseUnits: 1n },
    maxTimeoutSeconds: 60,
    receivedAtMs: 1000,
    requestedAtMs: 0,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'validation-error')
})

/* ------------------------------------------- payment vs delivery state */

test('closing a dialogue abandons delivery and leaves a settled payment settled', () => {
  const session = new PaidServiceSession('archivist.town-history-brief')
  session.payloadReceived()
  session.verified()
  session.settling()
  session.settled({
    transaction: 'facilitator-returned-signature',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    confirmed: true,
    observedAtMs: 1000,
    detail: 'facilitator reported settlement',
  })
  assert.equal(session.paymentState, 'settled')

  session.abandonDelivery('player walked away from the NPC')

  assert.equal(session.deliveryState, 'abandoned')
  // The whole point: the payment is untouched.
  assert.equal(session.paymentState, 'settled')
  assert.notEqual(session.settlement, null)
})

test('an abandoned delivery after a settled payment reports a refund obligation', () => {
  const session = new PaidServiceSession('svc')
  session.verified()
  session.settled({
    transaction: 'sig',
    network: 'solana:devnet',
    confirmed: true,
    observedAtMs: 1,
    detail: 'settled',
  })
  session.abandonDelivery('timed out')
  const obligation = session.refundObligation()
  assert.equal(obligation.owed, true)
})

test('a delivered service owes no refund', () => {
  const session = new PaidServiceSession('svc')
  session.settled({ transaction: 'sig', network: 'n', confirmed: true, observedAtMs: 1, detail: 'settled' })
  session.deliveryStarted()
  session.delivered('brief written')
  assert.equal(session.refundObligation().owed, false)
})

test('incoming funds are not spendable on a verified payload alone', () => {
  const session = new PaidServiceSession('svc')
  session.payloadReceived()
  session.verified()
  const verdict = session.spendableIncoming()
  assert.equal(verdict.spendable, false)
  if (verdict.spendable) return
  assert.match(verdict.reason, /no settlement evidence/)
})

test('incoming funds are not spendable on an unconfirmed broadcast', () => {
  const session = new PaidServiceSession('svc')
  session.settled({
    transaction: 'broadcast-hash',
    network: 'n',
    confirmed: false,
    observedAtMs: 1,
    detail: 'settlement_pending',
  })
  // `settlement_pending` is non-terminal in x402 and must be reconciled.
  assert.equal(session.paymentState, 'settlement-unknown')
  assert.equal(session.spendableIncoming().spendable, false)
})

test('incoming funds become spendable only with a confirmed settlement', () => {
  const session = new PaidServiceSession('svc')
  session.settled({ transaction: 'sig', network: 'n', confirmed: true, observedAtMs: 1, detail: 'settled' })
  assert.equal(session.spendableIncoming().spendable, true)
})

/* ------------------------------------------------ readiness derivation */

const at = 1_700_000_000_000

test('a populated environment variable cannot raise a row above the bottom rung', () => {
  const evidence: Evidence[] = [
    { kind: 'config', observedAtMs: at, environment: 'none', summary: 'all set', variables: ['A', 'B', 'C'], present: true },
  ]
  assert.equal(deriveState(evidence), 'missing-configuration')
})

test('an installed SDK is not a reachable service', () => {
  const evidence: Evidence[] = [
    { kind: 'sdk', observedAtMs: at, environment: 'none', summary: 'installed', packageName: '@x402/core', version: '2.27.0' },
  ]
  assert.equal(deriveState(evidence), 'missing-configuration')
})

test('documentation is not evidence of a working integration', () => {
  const evidence: Evidence[] = [
    { kind: 'doc', observedAtMs: at, environment: 'none', summary: 'docs say yes', url: 'https://example.test', status: 200, quote: 'Supported.' },
  ]
  assert.equal(deriveState(evidence), 'missing-configuration')
})

test('a mocked confirmed mainnet execution scores zero rungs', () => {
  const evidence: Evidence[] = [
    {
      kind: 'execution',
      observedAtMs: at,
      environment: 'mock',
      summary: 'stubbed',
      identifier: 'mock-signature',
      confirmed: true,
      detail: 'produced by a stub',
    },
  ]
  assert.equal(deriveState(evidence), 'missing-configuration')
})

test('a real non-2xx response proves reachability and nothing more', () => {
  const evidence: Evidence[] = [
    { kind: 'http', observedAtMs: at, environment: 'mainnet', summary: 'probe', url: 'https://example.test', method: 'GET', status: 400, durationMs: 12 },
  ]
  assert.equal(deriveState(evidence), 'reachable')
})

test('a 2xx with nothing extracted is reachable, not read-only verified', () => {
  const evidence: Evidence[] = [
    { kind: 'http', observedAtMs: at, environment: 'mainnet', summary: 'probe', url: 'https://example.test', method: 'GET', status: 200, durationMs: 12 },
  ]
  assert.equal(deriveState(evidence), 'reachable')
})

test('a 2xx with an extracted fact is read-only verified', () => {
  const evidence: Evidence[] = [
    {
      kind: 'http',
      observedAtMs: at,
      environment: 'mainnet',
      summary: 'probe',
      url: 'https://example.test',
      method: 'GET',
      status: 200,
      durationMs: 12,
      extracted: '198 assets, native ZEC present',
    },
  ]
  assert.equal(deriveState(evidence), 'read-only-verified')
})

test('a transport failure is not reachability', () => {
  const evidence: Evidence[] = [
    { kind: 'http', observedAtMs: at, environment: 'mainnet', summary: 'probe', url: 'https://example.test', method: 'GET', status: null, durationMs: 15000, transportError: 'ENOTFOUND' },
  ]
  assert.equal(deriveState(evidence), 'missing-configuration')
})

test('an unconfirmed execution does not reach a verified-execution rung', () => {
  const evidence: Evidence[] = [
    { kind: 'execution', observedAtMs: at, environment: 'devnet', summary: 'broadcast', identifier: 'sig', confirmed: false, detail: 'pending' },
  ]
  assert.equal(deriveState(evidence), 'reachable')
})

test('a confirmed devnet execution is test-execution-verified, never live', () => {
  const evidence: Evidence[] = [
    { kind: 'execution', observedAtMs: at, environment: 'devnet', summary: 'settled', identifier: 'sig', confirmed: true, detail: 'confirmed in slot 1' },
  ]
  assert.equal(deriveState(evidence), 'test-execution-verified')
})

test('only a confirmed mainnet execution reaches live-execution-verified', () => {
  const evidence: Evidence[] = [
    { kind: 'execution', observedAtMs: at, environment: 'mainnet', summary: 'settled', identifier: 'sig', confirmed: true, detail: 'confirmed' },
  ]
  assert.equal(deriveState(evidence), 'live-execution-verified')
})

/* ------------------------------------------ the shielded-ZEC assessment */

test('a priced quote for a shielded address never yields shielded delivery', () => {
  const assessment = classifyZecDelivery({
    recipient: 'u1...',
    parsedReceivers: ['sapling', 'orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.equal(assessment.verdict, 'unsubstantiated')
  assert.equal(assessment.deliveredReceiver, 'unknown')
  assert.notEqual(assessment.deliveredReceiver, 'shielded')
})

test('a shielded requirement is refused rather than downgraded to transparent', () => {
  const assessment = classifyZecDelivery({
    recipient: 'u1...',
    parsedReceivers: ['p2pkh', 'sapling', 'orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  const plan = planZecPayout({ requirement: 'shielded-required', assessment })
  assert.equal(plan.usable, false)
  assert.match(plan.refusal ?? '', /Falling back to transparent delivery/)
  // There is no transparent plan in the return value to accidentally use.
  assert.equal('transparentFallback' in plan, false)
})

test('a transparent-allowed requirement is usable when a transparent receiver exists', () => {
  const assessment = classifyZecDelivery({
    recipient: 'u1...',
    parsedReceivers: ['p2pkh'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.equal(planZecPayout({ requirement: 'transparent-allowed', assessment }).usable, true)
})

test('a transparent-allowed requirement is refused when there is no transparent receiver', () => {
  const assessment = classifyZecDelivery({
    recipient: 'u1...',
    parsedReceivers: ['orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.equal(planZecPayout({ requirement: 'transparent-allowed', assessment }).usable, false)
})
