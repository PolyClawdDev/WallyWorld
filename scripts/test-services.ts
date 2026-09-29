/*
 * NPC services: real gold out of the real ledger, real artifacts out of real
 * town data, and honest refusals for the services that cannot exist.
 *
 * What this suite is actually asserting, in order: that a purchase moves gold
 * off the buyer and out of the player economy; that the ledger still balances
 * afterwards; that a delivery which fails refunds in full and can never be
 * charged instead; that an unaffordable purchase is refused before any work
 * happens and leaves nothing behind; that duplicate and cross-process
 * concurrent purchases charge once and deliver once; and that the artifact
 * text is derived from the town plan rather than typed out — proved by adding
 * a building to the plan in memory and finding it in the next brief.
 *
 * Run with: npm run test:services
 */
import { spawn } from 'node:child_process'
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

const files = useTestDatabases('test-services')

const { coreDb } = await import('../src/server/store')
const { resolveUserForPrincipal } = await import('../src/server/identity/users')
const { ensureAccount } = await import('../src/server/pvp/ids')
const { balanceOf, conservationReport, playerAvailable, playerReserved, creditsByProvenance } =
  await import('../src/server/money/ledger')
const { goldSnapshot, grantStartingGold, creditGold, debitGold } = await import('../src/server/money/gold')
const { chargeServiceGold, refundServiceGold, settlementOf } = await import('../src/server/money/services')
const { SERVICES, catalogueView, serviceById } = await import('../src/server/npc/catalogue')
const {
  purchaseService,
  listOrdersForOwner,
  readOrderForOwner,
  readArtifactTextForOwner,
  failNextDeliveryForTest,
  sweepAbandonedOrders,
} = await import('../src/server/npc/orders')
const { buildingSpecs, serviceNpcs, townLayout } = await import('../src/townData')
const { listArtifactsForOwner } = await import('../src/server/jobs/queue')

const PRINCIPAL = 'dev-service-buyer'
const { userId } = resolveUserForPrincipal(PRINCIPAL)
const account = ensureAccount(PRINCIPAL)
grantStartingGold(userId)

const available = () => balanceOf(playerAvailable(userId))
const reserved = () => balanceOf(playerReserved(userId))
const priceOf = (id: string) => serviceById(id)!.priceGold!

const buy = (serviceId: string, idempotencyKey: string, request: Record<string, unknown> = {}) =>
  purchaseService({ userId, playerId: account.player_id, displayName: account.display_name, serviceId, request, idempotencyKey })

/* ------------------------------------------------------------- catalogue */

section('the catalogue is priced in gold and honest about what is missing')

const catalogue = catalogueView()
const live = catalogue.filter(service => service.availability.state === 'available')
const shut = catalogue.filter(service => service.availability.state === 'unavailable')

equal('every service NPC in town is accounted for', catalogue.length, serviceNpcs.length)
check('five services are real', live.length === 5, live.map(s => s.id).join(', '))
check('three are plainly unavailable', shut.length === 3, shut.map(s => s.id).join(', '))
check('every available service names a price in gold', live.every(s => s.priceGold !== null && /^[1-9][0-9]*$/.test(s.priceGold!)))
check('no unavailable service names a price', shut.every(s => s.priceGold === null))
check('every unavailable service says why, in sentences', shut.every(s =>
  s.availability.state === 'unavailable' && s.availability.because.join(' ').length > 80))

// "demo credits" was an invented currency. It is gone, and the catalogue is not
// allowed to quote a price in anything but gold.
const catalogueText = JSON.stringify(catalogue).toLowerCase()
check('no service is priced in credits', !/\d+\s*credits?\b/.test(catalogueText))
check('the phrase "demo credit" is gone', !catalogueText.includes('demo credit'))
check('nothing in the catalogue calls itself a demo', !catalogueText.includes('demo'))
check('nothing calls its output a simulated artifact', !catalogueText.includes('simulated artifact'))
check('nothing calls itself scripted', !catalogueText.includes('scripted'))

/* ------------------------------------------------- a real purchase, charged */

section('buying the town history brief spends real gold')

const startGold = available()
equal('the buyer starts with the starting grant', startGold, 250n)

const brief = buy('archive.town-brief', 'brief-first-copy')
check('the purchase succeeded', brief.ok, brief.ok ? brief.order.orderId : brief.reason)
if (!brief.ok) finish('services')

equal('gold left the buyer', available(), startGold - priceOf('archive.town-brief'))
equal('nothing is left sitting in escrow', reserved(), 0n)
equal('the receipt records what was charged', brief.order.priceGold, priceOf('archive.town-brief').toString())
equal('the order is delivered', brief.order.state, 'delivered')
equal('the ledger says the gold was spent, not refunded', brief.order.ledger.settled, 'charge')
equal('the ledger agrees on the amount', brief.order.ledger.settledGold, priceOf('archive.town-brief').toString())
check('the receipt reconciles against the gold ledger', brief.order.ledger.reconciles)
check('the ledger still balances', conservationReport().ok)

check('the artifact came back with the purchase', brief.artifact.text.length > 1500, `${brief.artifact.text.length} characters`)
equal('the artifact digest matches the receipt', brief.artifact.sha256, brief.order.sha256)
check('the artifact is registered as an artifact', listArtifactsForOwner(userId).some(a => a.sha256 === brief.artifact.sha256))

section('the brief is derived from the town plan, not typed out')

const text = brief.artifact.text
check('every building in the plan appears by name', buildingSpecs.every(spec => text.includes(spec.name)))
check('a real position appears', text.includes('(-59, 43)'), 'The Archive stands there in src/townData.ts')
check('the tallest building is named as tallest', text.includes('Spell Tower is the tallest thing standing at 52m'))
check('the plan\'s street count is quoted', text.includes(`${townLayout.streets.length} paved streets`))
check('a measured neighbour distance appears', /nearest\s+\S[^\n]*?\d+m/.test(text))
check('the brief is text, with no markup in it', !text.includes('<') && !text.includes('&lt;'))

// The real test of derivation: change the town, and the next brief changes with
// it. A fixed string cannot pass this.
buildingSpecs.push({
  name: 'Auditor Shed', kind: 'post', x: -90, z: -90, width: 4, depth: 4, height: 3,
  wall: '#000000', roof: '#000000', sign: 'AUDIT',
})
const afterEdit = buy('archive.town-brief', 'brief-after-town-edit')
buildingSpecs.pop()
check('a building added to the plan appears in the next brief', afterEdit.ok && afterEdit.artifact.text.includes('Auditor Shed'))
check('and it is described with its own position', afterEdit.ok && afterEdit.artifact.text.includes('(-90, -90)'))
check('so the two briefs differ', afterEdit.ok && afterEdit.artifact.sha256 !== brief.artifact.sha256)

/* ------------------------------------------------------ paying twice, once */

section('the same purchase cannot be charged twice')

const before = available()
const replay = buy('archive.town-brief', 'brief-first-copy')
check('a repeat with the same key replays', replay.ok && replay.replayed)
equal('and charges nothing more', available(), before)
equal('and hands back the same artifact', replay.ok ? replay.artifact.sha256 : '', brief.artifact.sha256)
equal('there is one order for that key', listOrdersForOwner(userId, 100).filter(o => o.orderId === brief.order.orderId).length, 1)

const chargedAgain = chargeServiceGold({ userId, orderId: brief.order.orderId, serviceId: 'archive.town-brief', price: priceOf('archive.town-brief') })
check('the ledger reports a second charge as already applied', chargedAgain.ok && chargedAgain.idempotent)
equal('and moves nothing', available(), before)

const refundAfterCharge = refundServiceGold({ userId, orderId: brief.order.orderId, serviceId: 'archive.town-brief', price: priceOf('archive.town-brief'), reason: 'should be impossible' })
check('a refund of a charged order is refused as already settled', refundAfterCharge.ok && refundAfterCharge.idempotent)
equal('and moves nothing either', available(), before)
equal('the ledger still calls that order a charge', settlementOf(brief.order.orderId).settled && settlementOf(brief.order.orderId).kind, 'charge')
check('the ledger still balances', conservationReport().ok)

section('a second copy under a new key is a second purchase')

const second = buy('archive.town-brief', 'brief-second-copy')
check('it is charged', second.ok && !second.replayed)
equal('twice the price has now gone', available(), before - priceOf('archive.town-brief'))
check('and it is a different order', second.ok && second.order.orderId !== brief.order.orderId)

/* --------------------------------------------------- failure means refunded */

section('a delivery that fails refunds in full')

const beforeFailure = available()
failNextDeliveryForTest('the archive lamp went out mid-page')
const failed = buy('archive.town-brief', 'brief-that-fails')
check('the purchase reports the failure', !failed.ok && failed.code === 'delivery_failed', failed.ok ? 'it succeeded' : failed.reason)
equal('the gold is back, in full', available(), beforeFailure)
equal('nothing is stranded in escrow', reserved(), 0n)
equal('the order is marked refunded', !failed.ok && failed.order?.state, 'refunded')
equal('the ledger calls it a refund', !failed.ok && failed.order?.ledger.settled, 'refund')
check('the refunded receipt reconciles too', !failed.ok && Boolean(failed.order?.ledger.reconciles))
check('no artifact is readable from it', !failed.ok && readArtifactTextForOwner(failed.order!.orderId, userId) === null)
check('the ledger still balances', conservationReport().ok)

const chargeAfterRefund = chargeServiceGold({ userId, orderId: (failed as { order?: { orderId: string } }).order!.orderId, serviceId: 'archive.town-brief', price: priceOf('archive.town-brief') })
check('a refunded order can never be charged afterwards', chargeAfterRefund.ok && chargeAfterRefund.idempotent)
equal('so the gold stays with the buyer', available(), beforeFailure)

section('an order abandoned mid-flight is swept back to the buyer')

const beforeAbandon = available()
failNextDeliveryForTest('the process died', { abandon: true })
const abandoned = buy('archive.town-brief', 'brief-abandoned-midway')
check('the caller is told nothing was delivered', !abandoned.ok)
equal('the price is still held in escrow', reserved(), priceOf('archive.town-brief'))
equal('and is out of reach for now', available(), beforeAbandon - priceOf('archive.town-brief'))
// A minute later, from the sweeper's point of view, so the test does not depend
// on two calls landing in different milliseconds.
equal('the sweep returns exactly one reservation', sweepAbandonedOrders(60_000, Date.now() + 120_000).refunded, 1)
equal('the buyer has it all back', available(), beforeAbandon)
equal('escrow is empty', reserved(), 0n)
check('the ledger still balances', conservationReport().ok)

/* ------------------------------------------------- refused before any work */

section('an unaffordable purchase is refused before anything happens')

const drained = available() - 5n
debitGold({ userId, amount: drained, idemScope: 'test-drain', idemKey: 'drain-1', note: 'test: spend down to 5 gold' })
equal('the buyer is left with 5 gold', available(), 5n)

const ordersBefore = listOrdersForOwner(userId, 100).length
const tooDear = buy('archive.town-brief', 'brief-cannot-afford')
check('the purchase is refused for want of gold', !tooDear.ok && tooDear.code === 'insufficient_gold', tooDear.ok ? 'it went through' : tooDear.reason)
equal('the balance is untouched', available(), 5n)
equal('nothing was reserved', reserved(), 0n)
equal('no order row was left behind', listOrdersForOwner(userId, 100).length, ordersBefore)
check('the ledger still balances', conservationReport().ok)

creditGold({ userId, amount: 400n, provenance: 'test_credit', idemScope: 'test-topup', idemKey: 'topup-1', note: 'test: refill' })
const afterRefill = buy('archive.town-brief', 'brief-cannot-afford')
check('the same key works once the gold is there', afterRefill.ok, afterRefill.ok ? '' : afterRefill.reason)
check('so a refusal does not burn the idempotency key', afterRefill.ok && !afterRefill.replayed)

/* ------------------------------------------------------------ concurrency */

section('concurrent purchases of one order charge once and deliver once')

// Four separate processes, one shared SQLite pair, the same buyer and the same
// idempotency key. This is the real race: inside one process a purchase is
// synchronous, so nothing interleaves; across processes BEGIN IMMEDIATE and the
// unique order key are what has to hold.
const raceKey = 'race-one-brief-please'
const beforeRace = available()
const artifactsBeforeRace = listArtifactsForOwner(userId, 500).length
const runners = await Promise.all([0, 1, 2, 3].map(index => new Promise<{ status: string; sha?: string; orderId?: string }>(resolve => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/lib/race-purchase.ts', PRINCIPAL, 'archive.town-brief', raceKey, String(index)], {
    env: { ...process.env, WALLY_DB_PATH: files.core, WALLY_FINANCE_DB_PATH: files.finance, WALLY_DEV_SESSIONS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', () => { /* a child that fails is reported by its absent line */ })
  child.on('close', () => {
    const line = out.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '{}'
    try { resolve(JSON.parse(line)) } catch { resolve({ status: `unparsed: ${out.slice(0, 120)}` }) }
  })
})))

const delivered = runners.filter(runner => runner.status === 'delivered' || runner.status === 'replayed')
equal('every racing process got an artifact', delivered.length, 4)
equal('exactly one of them was the one that created it', runners.filter(r => r.status === 'delivered').length, 1)
equal('they all got the same artifact', new Set(delivered.map(r => r.sha)).size, 1)
equal('they all got the same order', new Set(delivered.map(r => r.orderId)).size, 1)
equal('the buyer was charged exactly once', available(), beforeRace - priceOf('archive.town-brief'))
equal('nothing is left in escrow', reserved(), 0n)
const raceOrderId = delivered[0]?.orderId ?? ''
equal('one order row exists for that key', listOrdersForOwner(userId, 200).filter(o => o.orderId === raceOrderId).length, 1)
// Counted rather than matched on digest: the brief is deterministic, so every
// separately bought copy has the same digest. What matters is that four racing
// processes added exactly one artifact between them.
equal('the race produced exactly one artifact', listArtifactsForOwner(userId, 500).length, artifactsBeforeRace + 1)
check('and the order points at it', Boolean(readOrderForOwner(raceOrderId, userId)?.artifactId))
check('the ledger still balances after the race', conservationReport().ok)

section('concurrent purchases with different keys are separate purchases')

const beforeMany = available()
const keys = ['many-card-alpha', 'many-card-bravo', 'many-card-charlie']
const many = await Promise.all(keys.map(key => new Promise<{ status: string; sha?: string }>(resolve => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/lib/race-purchase.ts', PRINCIPAL, 'courier.route-card', key, key], {
    env: { ...process.env, WALLY_DB_PATH: files.core, WALLY_FINANCE_DB_PATH: files.finance, WALLY_DEV_SESSIONS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.on('close', () => {
    const line = out.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '{}'
    try { resolve(JSON.parse(line)) } catch { resolve({ status: 'unparsed' }) }
  })
})))
equal('all three were delivered', many.filter(m => m.status === 'delivered').length, 3)
equal('three prices left the buyer', available(), beforeMany - priceOf('courier.route-card') * 3n)
equal('the same card was produced each time', new Set(many.map(m => m.sha)).size, 1)
check('the ledger still balances', conservationReport().ok)

/* ------------------------------------------------ the rest of the services */

section('directions are measured, and an unknown landmark costs nothing')

const beforeDirections = available()
const nowhere = buy('guide.directions', 'directions-to-nowhere', { landmark: 'The Pyramids' })
check('an unknown landmark is refused', !nowhere.ok && nowhere.code === 'bad_request', nowhere.ok ? 'it sold' : nowhere.reason)
check('and the refusal lists the real landmarks', !nowhere.ok && Boolean(nowhere.options?.includes('The Archive')))
equal('and nothing was charged for it', available(), beforeDirections)

const missing = buy('guide.directions', 'directions-with-no-landmark', {})
check('a request with no landmark is refused too', !missing.ok && missing.code === 'bad_request')
equal('still nothing charged', available(), beforeDirections)

const route = buy('guide.directions', 'directions-to-the-tower', { landmark: 'Spell Tower' })
check('a real landmark sells', route.ok, route.ok ? '' : route.reason)
equal('and costs the catalogue price', available(), beforeDirections - priceOf('guide.directions'))
if (route.ok) {
  const tower = buildingSpecs.find(spec => spec.name === 'Spell Tower')!
  check('the route names the destination position', route.artifact.text.includes(`(${tower.x}, ${tower.z})`))
  check('it has two measured legs', route.artifact.text.includes('Leg 1') && route.artifact.text.includes('Leg 2'))
  check('it totals the walk', /Total\s+\d+m walked/.test(route.artifact.text))
  check('it is text, with no markup', !route.artifact.text.includes('<'))
}

section('a client cannot name its own price, its own balance, or its own service')

const beforeSpoof = available()
const spoofed = buy('guide.directions', 'directions-spoofed-price', {
  landmark: 'Spell Tower', price: 0, priceGold: '0', gold: 999999, balance: 999999, amount: 0,
})
check('the purchase still works', spoofed.ok)
equal('and still costs the catalogue price', available(), beforeSpoof - priceOf('guide.directions'))

const unknown = buy('archive.free-lunch', 'no-such-service-here')
check('an unknown service id is refused', !unknown.ok && unknown.code === 'unknown_service')

section('the holdings statement is read off the ledger')

const holdings = buy('market.holdings', 'holdings-statement-one')
check('it sells', holdings.ok, holdings.ok ? '' : holdings.reason)
if (holdings.ok) {
  const snapshot = goldSnapshot(userId)
  check('it quotes the balance the ledger holds', holdings.artifact.text.includes(`Available     ${snapshot.available} gold`),
    `available is ${snapshot.available}`)
  check('it says redeemable gold is zero', holdings.artifact.text.includes('Redeemable    0 gold'))
  check('it reports the conservation verdict', holdings.artifact.text.includes('the ledger balances.'))
  check('it names a real provenance note', holdings.artifact.text.includes('Not redeemable'))
}

section('a duel record is refused when there are no duels, and copied out when there are')

const beforeRecord = available()
const noDuels = buy('arms.duel-record', 'duel-record-with-no-duels')
check('it is refused', !noDuels.ok && noDuels.code === 'nothing_to_do', noDuels.ok ? 'it sold a blank page' : noDuels.reason)
equal('and charges nothing', available(), beforeRecord)

coreDb.raw.prepare(`
  insert into pvp_journal (id, duel_id, player_id, opponent_id, opponent_name, kind, stake, gold_delta, reason, created_at_ms)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('jr_test_1', 'duel_test_1', account.player_id, 'pl_someone', 'Testing Opponent', 'victory', 40, 40, 'opponent fell', Date.now())

const record = buy('arms.duel-record', 'duel-record-after-one-duel')
check('now it sells', record.ok, record.ok ? '' : record.reason)
equal('at the catalogue price', available(), beforeRecord - priceOf('arms.duel-record'))
if (record.ok) {
  check('the opponent from the journal is named', record.artifact.text.includes('Testing Opponent'))
  check('the stake from the journal appears', record.artifact.text.includes('Gold staked   40'))
  check('one duel is counted', record.artifact.text.includes('Duels settled 1'))
  check('and the record reads one win', record.artifact.text.includes('1 won · 0 lost'))
}

/* ----------------------------------------------- the shut desks stay shut */

section('the services that cannot exist refuse, and charge nothing')

for (const service of SERVICES.filter(s => s.availability.state === 'unavailable')) {
  const beforeShut = available()
  const ordersWere = listOrdersForOwner(userId, 500).length
  const refused = buy(service.id, `unavailable-${service.id.replace(/[^a-z]/g, '-')}`)
  check(`${service.id} refuses`, !refused.ok && refused.code === 'service_unavailable', refused.ok ? 'it sold something' : '')
  check(`${service.id} explains itself`, !refused.ok && refused.reason.length > 80)
  equal(`${service.id} charges nothing`, available(), beforeShut)
  equal(`${service.id} writes no order`, listOrdersForOwner(userId, 500).length, ordersWere)
}

/* ---------------------------------------------------- money, in aggregate */

section('every gold the buyer spent on services is accounted for')

const orders = listOrdersForOwner(userId, 500)
const chargedOrders = orders.filter(order => order.state === 'delivered')
const refundedOrders = orders.filter(order => order.state === 'refunded')
check('there are charged orders to check', chargedOrders.length >= 8, `${chargedOrders.length} delivered`)
check('every delivered order reconciles against the ledger', chargedOrders.every(order => order.ledger.reconciles))
check('every refunded order reconciles against the ledger', refundedOrders.every(order => order.ledger.reconciles))
check('every delivered order carries an artifact digest', chargedOrders.every(order => order.sha256?.length === 64))
check('every delivered artifact is readable by its owner', chargedOrders.every(order => readArtifactTextForOwner(order.orderId, userId) !== null))
check('no refunded artifact is readable', refundedOrders.every(order => readArtifactTextForOwner(order.orderId, userId) === null))

const spentOnServices = chargedOrders.reduce((total, order) => total + BigInt(order.priceGold), 0n)
const ledgerSpend = orders.reduce((total, order) => {
  const settlement = settlementOf(order.orderId)
  return settlement.settled && settlement.kind === 'charge' ? total + settlement.amount : total
}, 0n)
equal('the receipts and the ledger agree on the total spent', ledgerSpend, spentOnServices)
check('the total is a positive integer of gold', spentOnServices > 0n)

section('spending gold never makes gold redeemable, and never mints any')

const snapshot = goldSnapshot(userId)
equal('redeemable gold is still zero', snapshot.redeemable, 0n)
equal('nothing accrued redeemable eligibility', snapshot.accrued, 0n)
const credits = creditsByProvenance(userId)
check('no purchase credited a player account', !Object.keys(credits).includes('service'), Object.keys(credits).join(', '))
check('the only credit origins are the grant, the test credit and escrow returns',
  Object.keys(credits).every(provenance => ['gift', 'test_credit', 'escrow'].includes(provenance)),
  Object.keys(credits).join(', '))

const finalReport = conservationReport()
check('the whole ledger balances', finalReport.ok)
equal('every balance in it sums to zero', finalReport.balanceSum, 0n)
equal('every entry in it sums to zero', finalReport.entrySum, 0n)
equal('no transfer is half written', finalReport.unbalancedTransfers.length, 0)
equal('no account has drifted from its history', finalReport.driftedAccounts.length, 0)

section('an order belongs to one account only')

const other = resolveUserForPrincipal('dev-service-stranger')
check('a stranger cannot read the order', readOrderForOwner(brief.order.orderId, other.userId) === null)
check('a stranger cannot read the artifact', readArtifactTextForOwner(brief.order.orderId, other.userId) === null)

finish('services')
