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
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  COURIER_CONFIG_KEYS,
  COURIER_SIGNER,
  COURIER_TRANSITIONS,
  DESTINATION_REFUSALS,
  PRIVACY_STATEMENT,
  acceptDestination,
  canTransition,
  describeDesk,
  describeQuote,
  formatSol,
  formatZec,
  fundDeposit,
  recordIntent,
  type CourierIntent,
  type CourierQuote,
  type DestinationRefusal,
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

/* -------------------------------------------- what a refused player reads */

/**
 * The refusals are the product here, not an error path.
 *
 * Five codes exist because they need five different things from the player,
 * and a desk that collapsed them into "invalid address" would leave somebody
 * holding a perfectly good wallet with nothing to try. These tests pin that
 * each code reaches distinct copy, that the copy tells them what to do, and
 * that none of it quotes the address back.
 */

const REFUSAL_CODES: DestinationRefusal[] = [
  'unparseable',
  'no-shielded-receiver',
  'transparent-receiver-present',
  'sapling-without-orchard',
  'unknown-receivers-only',
]

test('every refusal code has copy, and no two codes share any of it', () => {
  assert.deepEqual(Object.keys(DESTINATION_REFUSALS).sort(), [...REFUSAL_CODES].sort())
  // A headline is a line on a card; `says` and `doThis` are the two paragraphs
  // that do the work, so they are held to a length a real explanation needs.
  const floor = { headline: 12, says: 90, doThis: 90 }
  for (const field of ['headline', 'says', 'doThis'] as const) {
    const values = REFUSAL_CODES.map(code => DESTINATION_REFUSALS[code][field])
    assert.equal(new Set(values).size, REFUSAL_CODES.length, `two codes share a ${field}`)
    for (const value of values) assert.ok(value.length > floor[field], `a ${field} is too short: "${value}"`)
  }
})

test('every refusal tells the player what to do next, not only what went wrong', () => {
  for (const code of REFUSAL_CODES) {
    const { doThis } = DESTINATION_REFUSALS[code]
    // An instruction, not a restatement. Every one of these names something to
    // go and do: copy it again, ask the wallet for a different address, update
    // the wallet, or wait for this deployment.
    assert.match(doThis, /\b(Copy|Ask|Update|Use|Look|paste|Paste|move|come back)\b/, code)
  }
})

test('a transparent-bearing unified address is told to ask for a shielded-only one', async () => {
  const result = await acceptDestination(TRANSPARENT_ORCHARD)
  assert.equal(result.ok, false)
  if (result.ok) return
  const copy = DESTINATION_REFUSALS[result.code!]
  // The common case: this is what most wallets hand out, so the copy has to say
  // that it is ordinary and then say precisely what to ask for instead.
  assert.match(copy.doThis, /shielded-only/)
  assert.match(copy.doThis, /Orchard/)
  assert.match(copy.doThis, /not a fault with your wallet/)
})

test('a Sapling-only address is told its wallet is the problem, and which way out', async () => {
  const result = await acceptDestination(SAPLING_ONLY)
  assert.equal(result.ok, false)
  if (result.ok) return
  const copy = DESTINATION_REFUSALS[result.code!]
  assert.match(copy.headline, /SAPLING/)
  assert.match(copy.doThis, /Orchard/)
  assert.match(copy.doThis, /zs1/)
})

test('a transparent-only address is told the payment would be public, not that it is invalid', async () => {
  const result = await acceptDestination(TRANSPARENT_ONLY)
  assert.equal(result.ok, false)
  if (result.ok) return
  const copy = DESTINATION_REFUSALS[result.code!]
  assert.match(copy.says, /public/)
  assert.match(copy.doThis, /shielded/)
  assert.doesNotMatch(copy.headline, /INVALID/i)
})

test('a string that is not an address is told so, and is not described as the wrong kind of address', async () => {
  const result = await acceptDestination('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'unparseable')
  const copy = DESTINATION_REFUSALS.unparseable
  assert.match(copy.headline, /NOT A ZCASH ADDRESS/)
  assert.match(copy.doThis, /Bitcoin/)
})

/**
 * The literal `scripts/verify-zip316.ts` uses for its unknown-typecode case.
 *
 * `acceptDestination` has an `unknown-receivers-only` branch for an address
 * that decodes to an empty receiver set, and @jp4g/zcash.js 0.1.0-rc.1 never
 * produces one: it throws out of `decode` rather than returning a parse with
 * nothing known in it. So the branch is unreachable with the installed parser
 * and this address lands on `unparseable` instead.
 *
 * It stays, and the test records why rather than deleting either. A later
 * parser that surfaces unknown typecodes instead of refusing would make this
 * live, and `unparseable` is the wrong thing to tell somebody whose wallet is
 * simply newer than ours — which is precisely the difference the two copies
 * carry. If this assertion ever starts failing, the branch has woken up.
 */
const UNKNOWN_ONLY = 'u1ldhmqnkm57nvjrkpvqz6tcy44su7l9rgd0n4qljmvd4v0zwft05tzzhwewslcvhmawhpvrhrhqg8qrwmgwsjcf'

test('an unknown-typecode-only address is refused, and today that refusal is unparseable', async () => {
  const result = await acceptDestination(UNKNOWN_ONLY)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'unparseable')
  // The two are not interchangeable, which is why the branch is worth keeping.
  assert.notEqual(DESTINATION_REFUSALS.unparseable.doThis, DESTINATION_REFUSALS['unknown-receivers-only'].doThis)
})

test('the refusal a player sees never quotes their address back', async () => {
  // Address-shaped strings are the thing that must not survive into copy. The
  // detail strings from `acceptDestination` are written for a log; these are
  // what reaches a screen, and they are fixed text with no interpolation in
  // them at all.
  for (const address of [ORCHARD_ONLY, SAPLING_ONLY, TRANSPARENT_ONLY, TRANSPARENT_ORCHARD]) {
    for (const code of REFUSAL_CODES) {
      const copy = DESTINATION_REFUSALS[code]
      const whole = `${copy.headline} ${copy.says} ${copy.doThis}`
      for (let index = 0; index + 12 <= address.length; index += 1) {
        assert.equal(whole.includes(address.slice(index, index + 12)), false, `${code} echoes the address`)
      }
    }
  }
})

/* --------------------------------------------- what reaches the player's screen */

test('the desk describes itself with both halves of the statement, verbatim', () => {
  const desk = describeDesk({ minLamports: 10_000_000n, maxLamports: 100_000_000_000n })
  assert.equal(desk.statement.delivers, PRIVACY_STATEMENT.delivers)
  assert.equal(desk.statement.doesNotHide, PRIVACY_STATEMENT.doesNotHide)
  assert.equal(desk.statement.cannotProve, PRIVACY_STATEMENT.cannotProve)
  // Not a prefix, not a summary. The whole string or nothing.
  assert.match(desk.statement.doesNotHide, /Buying in is public and stays public/)
  assert.match(desk.statement.doesNotHide, /Nothing here deletes any of that\.$/)
})

test('the desk states where it stops, and never offers a deposit address', () => {
  const desk = describeDesk({ minLamports: 10_000_000n, maxLamports: 100_000_000_000n })
  assert.equal(desk.stops.depositAddress, null)
  assert.equal(desk.stops.signer.available, false)
  assert.equal(desk.stops.goldInvolved, false)
  assert.match(desk.stops.at, /stage 5 of 5/)
  assert.equal(desk.stops.configuration.length, Object.keys(COURIER_CONFIG_KEYS).length)
  // Presence, never a value: an operator's address must not travel to a client.
  for (const entry of desk.stops.configuration) {
    assert.equal(typeof entry.set, 'boolean')
    assert.equal(Object.keys(entry).sort().join(','), 'key,set,what')
  }
  assert.equal(desk.accepts.minSol, '0.01')
  assert.equal(desk.accepts.maxSol, '100')
})

test('the desk hands the client all five refusals rather than a default', () => {
  const desk = describeDesk({ minLamports: 10_000_000n, maxLamports: 100_000_000_000n })
  assert.deepEqual(desk.refusals.map(entry => entry.code).sort(), [...REFUSAL_CODES].sort())
})

/**
 * The two seams between `PRIVACY_STATEMENT` and a player's eyes, read off the
 * source rather than asserted about in the abstract.
 *
 * The statement is a server constant and the screen is a React component, so
 * nothing in a unit test can watch the pixels. What a unit test can do is
 * assert that neither end has quietly dropped the half it would rather not
 * show: that the route forwards all three fields out of `describeQuote`, and
 * that the panel renders all three through one list with one class, which is
 * what makes "equal prominence" a property of the code instead of a promise.
 * `npm run build` plus the browser pass is what confirms it on screen.
 */
const sourceOf = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

test('the quote route forwards all three fields of the statement to the client', () => {
  const route = sourceOf('src/server/routes/courier.ts')
  for (const field of ['delivers', 'doesNotHide', 'cannotProve']) {
    assert.match(route, new RegExp(`${field}: described\\.${field}`), `the quote reply drops ${field}`)
  }
  // Nothing may shorten a half on its way out.
  assert.doesNotMatch(route, /described\.doesNotHide\.(slice|substring|split)/)
})

test('the journal renders all three halves, through one list and one class', () => {
  const panel = sourceOf('src/panels.tsx')
  const halves = panel.slice(panel.indexOf('const halves'), panel.indexOf('</div>', panel.indexOf('const halves')))
  for (const field of ['delivers', 'doesNotHide', 'cannotProve']) {
    assert.match(halves, new RegExp(`statement\\.${field}`), `the panel drops ${field}`)
  }
  assert.match(halves, /className="jr-shield-half"/)
  // One class for all three. A second one would be how "equal prominence"
  // stops being true without anybody editing the words.
  assert.equal(panel.match(/jr-shield-half/g)?.length, 1)
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
