/* ------------------------------------------------------------------ *
 * Courier pipeline tests. No network, no funds, no signer.
 *
 *   npm run test:courier
 *
 * The delivery verdict changed when the executor was identified and observed,
 * so these tests pin the *shape* of the new rule rather than the old refusal:
 * shielded delivery is reachable, and it is reachable from exactly one kind of
 * address. The cases that matter most are the near-misses — an address with
 * both an Orchard and a transparent receiver, and a Sapling address — because
 * those are the two ways a plausible-looking wallet address would quietly turn
 * a private payment into a public one.
 * ------------------------------------------------------------------ */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  COURIER_CONFIG_KEYS,
  COURIER_SIGNER,
  COURIER_TRANSITIONS,
  PRIVACY_STATEMENT,
  acceptDestination,
  canTransition,
  describeQuote,
  formatSol,
  formatZec,
  fundDeposit,
  recordIntent,
  type CourierIntent,
  type CourierQuote,
} from './courier'
import { classifyZecDelivery, planZecPayout } from './oneclick'
import { loadVectors, transparentAddressFrom, vectorWithReceivers } from '../../../scripts/lib/zec-vectors'

/* ---------------------------------------------------------- addresses */

const { rows } = await loadVectors()
const ua = (want: string[]) => vectorWithReceivers(rows, want)[6]

const ORCHARD_ONLY = ua(['orchard'])
const SAPLING_ORCHARD = ua(['sapling', 'orchard'])
const SAPLING_ONLY = ua(['sapling'])
const TRANSPARENT_ORCHARD = ua(['p2pkh', 'orchard'])
const TRANSPARENT_ONLY = transparentAddressFrom(vectorWithReceivers(rows, ['p2pkh', 'sapling'])[0]!)

/* ------------------------------------------------- destination acceptance */

test('an Orchard-only unified address is accepted for a private run', async () => {
  const result = await acceptDestination(ORCHARD_ONLY)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.destination.privateCapable, true)
  assert.equal(result.destination.parsed.hasTransparentReceiver, false)
})

test('Sapling alongside Orchard is still accepted — Orchard is what matters', async () => {
  const result = await acceptDestination(SAPLING_ORCHARD)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.destination.privateCapable, true)
})

test('a unified address carrying a transparent receiver is refused, not downgraded', async () => {
  const result = await acceptDestination(TRANSPARENT_ORCHARD)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'transparent-receiver-present')
  assert.match(result.detail, /cannot be promised as private/)
})

test('a Sapling-only address is refused with a reason naming Orchard', async () => {
  const result = await acceptDestination(SAPLING_ONLY)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'sapling-without-orchard')
  assert.match(result.detail, /Orchard/)
})

test('a transparent-only address is refused for a private run', async () => {
  const result = await acceptDestination(TRANSPARENT_ONLY)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'no-shielded-receiver')
})

test('a transparent-only address is fine once transparent delivery is authorized', async () => {
  const result = await acceptDestination(TRANSPARENT_ONLY, 'transparent-allowed')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.destination.privateCapable, false)
})

test('a non-Zcash string is refused as unparseable rather than treated as an address', async () => {
  for (const value of ['', '   ', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 42, null]) {
    const result = await acceptDestination(value)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.code, 'unparseable')
  }
})

/* --------------------------------------------------------- the verdict */

test('Orchard with no transparent receiver is the only route to shielded delivery', () => {
  const assessment = classifyZecDelivery({
    recipient: ORCHARD_ONLY,
    parsedReceivers: ['orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.equal(assessment.verdict, 'orchard-substantiated')
  assert.equal(assessment.deliveredReceiver, 'shielded')
  assert.equal(planZecPayout({ requirement: 'shielded-required', assessment }).usable, true)
})

test('Orchard plus a transparent receiver is ambiguous and is refused', () => {
  const assessment = classifyZecDelivery({
    recipient: TRANSPARENT_ORCHARD,
    parsedReceivers: ['p2pkh', 'orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.equal(assessment.verdict, 'receiver-ambiguous')
  assert.equal(assessment.deliveredReceiver, 'unknown')
  const plan = planZecPayout({ requirement: 'shielded-required', assessment })
  assert.equal(plan.usable, false)
  assert.match(plan.refusal ?? '', /not observable from outside/)
  // There is still no transparent plan in the return value to reach by mistake.
  assert.equal('transparentFallback' in plan, false)
})

test('a provider rejection is never read as transparent delivery', () => {
  const assessment = classifyZecDelivery({
    recipient: SAPLING_ONLY,
    parsedReceivers: ['sapling'],
    quoteAccepted: false,
    quoteHttpStatus: 400,
  })
  assert.equal(assessment.verdict, 'sapling-unsupported')
  assert.equal(assessment.deliveredReceiver, 'unknown')
  assert.notEqual(assessment.deliveredReceiver, 'transparent')
})

test('the documented claim is carried alongside the verdict that contradicts it', () => {
  const assessment = classifyZecDelivery({
    recipient: ORCHARD_ONLY,
    parsedReceivers: ['orchard'],
    quoteAccepted: true,
    quoteHttpStatus: 200,
  })
  assert.match(assessment.documentedSupport, /Transparent addresses only/)
  assert.equal(assessment.verdict, 'orchard-substantiated')
})

/* ------------------------------------------------------- presentation */

const quoteFor = (assessmentReceivers: string[], recipient: string): CourierQuote => ({
  lamportsIn: 1_000_000_000n,
  zatoshisOut: 8_472_274n,
  minZatoshisOut: 8_387_551n,
  timeEstimateSeconds: 135,
  assessment: classifyZecDelivery({
    recipient,
    parsedReceivers: assessmentReceivers,
    quoteAccepted: true,
    quoteHttpStatus: 200,
  }),
  correlationId: 'test-correlation',
  signatureVerified: true,
  quotedAtMs: 1_700_000_000_000,
})

test('base units are formatted without floating point', () => {
  assert.equal(formatZec(8_472_274n), '0.08472274')
  assert.equal(formatSol(1_000_000_000n), '1')
  assert.equal(formatZec(0n), '0')
  assert.equal(formatZec(100_000_000n), '1')
  assert.equal(formatSol(1n), '0.000000001')
})

test('the quote a player sees states the minimum, not just the expected amount', () => {
  const described = describeQuote(quoteFor(['orchard'], ORCHARD_ONLY))
  assert.match(described.headline, /0\.08472274 ZEC for 1 SOL/)
  assert.match(described.worstCase, /at least 0\.08387551 ZEC/)
})

test('the privacy statement says what is not hidden as well as what is', () => {
  const described = describeQuote(quoteFor(['orchard'], ORCHARD_ONLY))
  assert.match(described.delivers, /shielded Orchard payment/)
  assert.match(described.doesNotHide, /Buying in is public/)
  assert.match(described.doesNotHide, /conversion provider sees/)
  assert.match(described.cannotProve, /encrypted to the recipient/)
  assert.equal(described.doesNotHide, PRIVACY_STATEMENT.doesNotHide)
})

/* --------------------------------------------------- intent and machine */

const intentFor = (overrides: Partial<CourierIntent> = {}): CourierIntent => ({
  intentId: 'cr_test',
  state: 'awaiting_deposit',
  ownerUserId: 'user_1',
  destination: ORCHARD_ONLY,
  destinationReceivers: ['orchard'],
  requirement: 'shielded-required',
  lamports: 1_000_000_000n,
  minZatoshisOut: 8_387_551n,
  verdict: 'orchard-substantiated',
  deliveredReceiver: 'shielded',
  correlationId: 'test-correlation',
  providerId: 'near-1click',
  recordedAtMs: 1_000,
  expiresAtMs: 10_000,
  ...overrides,
})

test('an intent freezes the receiver set and the verdict onto the record', async () => {
  const accepted = await acceptDestination(ORCHARD_ONLY)
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  const result = recordIntent({
    ownerUserId: 'user_1',
    destination: accepted.destination,
    quote: quoteFor(['orchard'], ORCHARD_ONLY),
    expiresAtMs: 2_000,
    now: 1_000,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([...result.intent.destinationReceivers], ['orchard'])
  assert.equal(result.intent.deliveredReceiver, 'shielded')
  assert.equal(result.intent.state, 'intent_recorded')
})

test('a shielded intent cannot be recorded against an ambiguous assessment', async () => {
  const accepted = await acceptDestination(TRANSPARENT_ORCHARD, 'transparent-allowed')
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  const result = recordIntent({
    ownerUserId: 'user_1',
    destination: accepted.destination,
    quote: quoteFor(['p2pkh', 'orchard'], TRANSPARENT_ORCHARD),
    requirement: 'shielded-required',
    expiresAtMs: 2_000,
    now: 1_000,
  })
  assert.equal(result.ok, false)
})

test('an intent cannot be recorded for an address other than the one quoted', async () => {
  const accepted = await acceptDestination(ORCHARD_ONLY)
  assert.equal(accepted.ok, true)
  if (!accepted.ok) return
  const result = recordIntent({
    ownerUserId: 'user_1',
    destination: accepted.destination,
    quote: quoteFor(['sapling', 'orchard'], SAPLING_ORCHARD),
    expiresAtMs: 2_000,
    now: 1_000,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.detail, /different address/)
})

test('delivered and refunded are terminal, so a completed run cannot re-run', () => {
  assert.deepEqual([...COURIER_TRANSITIONS.delivered], [])
  assert.deepEqual([...COURIER_TRANSITIONS.refunded], [])
  assert.equal(canTransition('delivered', 'awaiting_deposit'), false)
  assert.equal(canTransition('refunded', 'deposit_submitted'), false)
})

test('a submitted deposit cannot expire — after money moves it is a refund question', () => {
  assert.equal(canTransition('deposit_submitted', 'expired'), false)
  assert.equal(canTransition('deposit_submitted', 'refunded'), true)
  assert.equal(canTransition('awaiting_deposit', 'expired'), true)
})

/* ----------------------------------------------------- the treasury seam */

test('funding is refused before configuration is even consulted, when the state is wrong', () => {
  const result = fundDeposit({ intent: intentFor({ state: 'quoted' }), now: 2_000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'wrong_state')
})

test('an expired quote is refused rather than funded late', () => {
  const result = fundDeposit({ intent: intentFor(), now: 20_000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'expired')
})

test('a shielded run whose verdict is not shielded is refused before any signer question', () => {
  const result = fundDeposit({
    intent: intentFor({ verdict: 'receiver-ambiguous', deliveredReceiver: 'unknown' }),
    now: 2_000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_private')
})

test('missing configuration is reported by name, with what each value decides', () => {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(COURIER_CONFIG_KEYS)) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    const result = fundDeposit({ intent: intentFor(), now: 2_000 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing_configuration')
    if (result.code !== 'missing_configuration') return
    assert.equal(result.missing.length, Object.keys(COURIER_CONFIG_KEYS).length)
    for (const entry of result.missing) assert.ok(entry.what.length > 0)
  } finally {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
})

test('with configuration present the answer is no_signer, and it names the absence', () => {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(COURIER_CONFIG_KEYS)) {
    saved.set(key, process.env[key])
    process.env[key] = '1'
  }
  try {
    const result = fundDeposit({ intent: intentFor(), now: 2_000 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'no_signer')
    if (result.code !== 'no_signer') return
    assert.equal(result.reason, COURIER_SIGNER.reason)
    assert.match(result.reason, /custody decision/)
  } finally {
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
})

test('the signer is unavailable as a constant, not as a configuration gap', () => {
  assert.equal(COURIER_SIGNER.available, false)
})
