/*
 * The ledger: conservation, double entry, provenance, redemption eligibility,
 * idempotency, hunt rewards and PvP escrow.
 *
 * Every claim this suite makes is about behaviour it actually exercises. Where a
 * guarantee is narrower than it sounds, the check name says so.
 *
 * Run with: npm run test:ledger
 */
import { useTestDatabases, check, equal, section, finish } from './lib/harness'

useTestDatabases('test-ledger')

const {
  postTransfer,
  conservationReport,
  eligibilityOf,
  consumeEligible,
  releaseEligible,
  balanceOf,
  playerAvailable,
  playerReserved,
  ensureSystemAccounts,
  SYSTEM_MINT,
  SYSTEM_SINK,
  TREASURY_GOLD,
  creditsByProvenance,
  entriesForUser,
} = await import('../src/server/money/ledger')
const {
  creditGold,
  debitGold,
  grantStartingGold,
  goldSnapshot,
  provenanceBreakdown,
  reservePairGold,
  settleDuelGold,
  mergeGoldInto,
  ensureGoldAccounts,
  STARTING_GRANT_GOLD,
} = await import('../src/server/money/gold')
const { PROVENANCES, REDEEMABLE_PROVENANCES, isRedeemable } = await import('../src/server/money/provenance')
const { fromStored, toStored, parseAmount, toSafeNumber, multiplyByIntegerRate } = await import('../src/server/money/amount')

ensureSystemAccounts()

const ALICE = 'usr_alice'

// Bob goes through identity rather than being a bare string, because the legacy
// import reads the profile row the server already stores for an account, and a
// profile row is keyed by user id. Faking the id would test nothing.
const { resolveUserForPrincipal } = await import('../src/server/identity/users')
const BOB = resolveUserForPrincipal('dev-legacy-bob').userId

/* --------------------------------------------------------------- amounts */

section('amounts are integer base units, stored as text')

equal('round trip through storage', fromStored(toStored(123456789012345678901n)), 123456789012345678901n)
equal('a decimal string is rejected', parseAmount('1.5'), null)
equal('a float is rejected', parseAmount(1.5), null)
equal('scientific notation is rejected', parseAmount('1e3'), null)
equal('a leading zero is rejected', parseAmount('0100'), null)
equal('a plain integer string parses', parseAmount('100'), 100n)
equal('a negative is rejected when min is zero', parseAmount('-5', { min: 0n }), null)
equal('above max is rejected', parseAmount('101', { max: 100n }), null)
check('an amount past Number.MAX_SAFE_INTEGER throws rather than rounding', (() => {
  try { toSafeNumber(2n ** 53n); return false } catch { return true }
})())
equal('integer rate multiplication stays exact', multiplyByIntegerRate(7n, 1_000_000_007n), 7_000_000_049n)

/* -------------------------------------------------------------- provenance */

section('provenance and the redemption rule')

equal('every provenance is accounted for', PROVENANCES.length, 8)
equal('exactly one provenance is redeemable', REDEEMABLE_PROVENANCES.length, 1)
check('hunt_verified is the redeemable one', isRedeemable('hunt_verified'))
for (const provenance of ['pvp_winnings', 'gift', 'test_credit', 'legacy_demo', 'escrow', 'withdrawal', 'system'] as const) {
  check(`${provenance} is not redeemable`, !isRedeemable(provenance))
}

/* ------------------------------------------------------------ double entry */

section('gold is moved, never conjured')

const grant = grantStartingGold(ALICE)
check('starting grant posted', grant.ok)
equal('starting grant amount', balanceOf(playerAvailable(ALICE)), STARTING_GRANT_GOLD)
equal('the mint went equally negative', balanceOf(SYSTEM_MINT), -STARTING_GRANT_GOLD)
equal('the grant is a gift, so it accrues nothing redeemable', eligibilityOf(ALICE).accrued, 0n)

const unbalanced = postTransfer({
  kind: 'test.unbalanced',
  idemScope: 'test',
  idemKey: 'unbalanced',
  note: 'legs that do not sum to zero',
  legs: [
    { accountId: SYSTEM_MINT, amount: -10n, provenance: 'system' },
    { accountId: playerAvailable(ALICE), amount: 11n, provenance: 'test_credit', ownerUserId: ALICE },
  ],
})
check('an unbalanced transfer is refused', !unbalanced.ok && unbalanced.code === 'unbalanced',
  unbalanced.ok ? 'it posted' : unbalanced.code)

const overspend = debitGold({
  userId: ALICE,
  amount: STARTING_GRANT_GOLD + 1n,
  idemScope: 'test',
  idemKey: 'overspend',
  note: 'more than the player has',
})
check('a player account cannot go negative', !overspend.ok && overspend.code === 'insufficient_funds',
  overspend.ok ? 'it posted' : overspend.code)

/* ------------------------------------------------------------ idempotency */

section('idempotency: the same credit applied twice lands once')

const once = creditGold({ userId: ALICE, amount: 40n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'token-1', note: 'a bear' })
const twice = creditGold({ userId: ALICE, amount: 40n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'token-1', note: 'a bear' })
check('first credit posted', once.ok && !once.idempotent)
check('second credit reports itself as a replay', twice.ok && twice.idempotent)
check('both calls name the same transfer', once.ok && twice.ok && once.transferId === twice.transferId)
equal('the balance moved once', balanceOf(playerAvailable(ALICE)), STARTING_GRANT_GOLD + 40n)
equal('one entry pair, not two', entriesForUser(ALICE).filter(entry => entry.note === 'a bear').length, 1)

// A different key is a different credit even with identical arguments, which is
// what makes the key the unit of deduplication rather than the amount.
const third = creditGold({ userId: ALICE, amount: 40n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'token-2', note: 'another bear' })
check('a different key credits again', third.ok && !third.idempotent)
equal('redeemable headroom tracks only hunt credits', eligibilityOf(ALICE).accrued, 80n)

/* ------------------------------------------------------------ eligibility */

section('redemption eligibility is capped by the live balance')

const snapshot = goldSnapshot(ALICE)
equal('total is available plus reserved', snapshot.total, snapshot.available + snapshot.reserved)
equal('redeemable is the hunt accrual while the balance covers it', snapshot.redeemable, 80n)

// Spending down below the accrual must lower what is redeemable, or a player could
// hunt, spend the proceeds in the game, and still withdraw against them.
const spend = debitGold({ userId: ALICE, amount: 290n, idemScope: 'test', idemKey: 'spend-down', note: 'spent in game' })
check('spending posted', spend.ok, spend.ok ? '' : spend.reason)
equal('balance after spending', balanceOf(playerAvailable(ALICE)), 40n)
equal('redeemable is capped by the balance, not the accrual', goldSnapshot(ALICE).redeemable, 40n)
equal('the accrual itself is unchanged history', eligibilityOf(ALICE).accrued, 80n)

const topUp = creditGold({ userId: ALICE, amount: 500n, provenance: 'gift', idemScope: 'test', idemKey: 'gift-1', note: 'a gift' })
check('a gift credits', topUp.ok)
equal('a gift cannot raise redeemable above the hunt accrual', goldSnapshot(ALICE).redeemable, 80n)

check('consuming more headroom than accrued is refused', !consumeEligible(ALICE, 1000n))
check('consuming within the accrual succeeds', consumeEligible(ALICE, 30n))
equal('consumed headroom lowers redeemable', goldSnapshot(ALICE).redeemable, 50n)
check('releasing puts the headroom back', releaseEligible(ALICE, 30n))
equal('redeemable restored', goldSnapshot(ALICE).redeemable, 80n)

/* --------------------------------------------------------- legacy demo gold */

section('legacy demo gold is spendable and never redeemable')

const { writeProfile } = await import('../src/server/db')
const { DEFAULT_PROFILE } = await import('../src/shared/profile')
const { importLegacyDemoGold, legacyImportIsNotRedeemable } = await import('../src/server/money/legacyImport')

const legacyProfile = { ...DEFAULT_PROFILE, gold: 4000 }
writeProfile('dev-legacy-bob', legacyProfile, 'test')
ensureGoldAccounts(BOB)

const imported = importLegacyDemoGold(BOB)
check('the old browser balance imported', imported.ok, imported.ok ? imported.imported : imported.reason)
equal('it is spendable in the game', balanceOf(playerAvailable(BOB)), 4000n)
equal('it accrues no redeemable headroom', eligibilityOf(BOB).accrued, 0n)
equal('so nothing is redeemable', goldSnapshot(BOB).redeemable, 0n)
check('the import is provably not redeemable', legacyImportIsNotRedeemable(BOB))
const reimport = importLegacyDemoGold(BOB)
check('a second import is a replay, not a second 4000', reimport.ok && reimport.idempotent)
equal('balance after the repeat', balanceOf(playerAvailable(BOB)), 4000n)

const bobProvenance = provenanceBreakdown(BOB)
check('the breakdown labels it legacy_demo and not redeemable',
  bobProvenance.some(row => row.provenance === 'legacy_demo' && row.amount === '4000' && !row.redeemable))

/* -------------------------------------------------------------- pvp escrow */

section('PvP escrow moves on the same ledger')

const CARL = 'usr_carl'
const DORA = 'usr_dora'
grantStartingGold(CARL)
grantStartingGold(DORA)

const reserved = reservePairGold({ aUserId: CARL, bUserId: DORA, stake: 40n, duelId: 'duel_1' })
check('both stakes reserved in one transfer', reserved.ok, reserved.ok ? '' : reserved.reason)
equal('challenger available', balanceOf(playerAvailable(CARL)), 210n)
equal('challenger reserved', balanceOf(playerReserved(CARL)), 40n)
equal('opponent reserved', balanceOf(playerReserved(DORA)), 40n)
check('reserving the same duel again is a replay', (() => {
  const again = reservePairGold({ aUserId: CARL, bUserId: DORA, stake: 40n, duelId: 'duel_1' })
  return again.ok && again.idempotent
})())

const settled = settleDuelGold({ duelId: 'duel_1', aUserId: CARL, bUserId: DORA, stake: 40n, kind: 'payout', winnerUserId: CARL })
check('the duel settled', settled.ok, settled.ok ? '' : settled.reason)
equal('the winner holds both stakes', balanceOf(playerAvailable(CARL)), 290n)
equal('the loser is down the stake', balanceOf(playerAvailable(DORA)), 210n)
equal('no gold is left in escrow', balanceOf(playerReserved(CARL)) + balanceOf(playerReserved(DORA)), 0n)
check('settling twice is a replay', (() => {
  const again = settleDuelGold({ duelId: 'duel_1', aUserId: CARL, bUserId: DORA, stake: 40n, kind: 'payout', winnerUserId: CARL })
  return again.ok && again.idempotent
})())
equal('the winner was not paid twice', balanceOf(playerAvailable(CARL)), 290n)

// The point of splitting the payout legs: winnings are not redeemable, so a duel
// cannot be used to launder unredeemable gold into redeemable gold.
equal('winning a duel creates no redeemable headroom', eligibilityOf(CARL).accrued, 0n)
const carlCredits = creditsByProvenance(CARL)
check('the pot is recorded as pvp_winnings', carlCredits.pvp_winnings === '40', JSON.stringify(carlCredits))

const refundDuel = reservePairGold({ aUserId: CARL, bUserId: DORA, stake: 10n, duelId: 'duel_2' })
check('a second duel reserved', refundDuel.ok)
const voided = settleDuelGold({ duelId: 'duel_2', aUserId: CARL, bUserId: DORA, stake: 10n, kind: 'refund' })
check('a refund settles', voided.ok, voided.ok ? '' : voided.reason)
equal('both players are whole again', balanceOf(playerAvailable(CARL)) + balanceOf(playerAvailable(DORA)), 500n)

check('a player cannot stake more than they hold', !reservePairGold({ aUserId: CARL, bUserId: DORA, stake: 10_000n, duelId: 'duel_3' }).ok)
check('a player cannot duel themselves', !reservePairGold({ aUserId: CARL, bUserId: CARL, stake: 10n, duelId: 'duel_4' }).ok)

/* ---------------------------------------------------------------- merging */

section('merging an account moves gold without inventing headroom')

const GUEST = 'usr_guest_merge'
creditGold({ userId: GUEST, amount: 100n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'guest-kill', note: 'guest hunt' })
const guestAccrued = eligibilityOf(GUEST).accrued
equal('the guest accrued redeemable headroom', guestAccrued, 100n)

const beforeMerge = balanceOf(playerAvailable(DORA))
const merged = mergeGoldInto({ fromUserId: GUEST, intoUserId: DORA, nonce: 'test-nonce' })
check('the merge posted', merged.ok, merged.ok ? merged.moved.toString() : merged.reason)
equal('the gold moved', balanceOf(playerAvailable(DORA)), beforeMerge + 100n)
equal('the source account is empty', balanceOf(playerAvailable(GUEST)), 0n)
equal('the source keeps no redeemable headroom', goldSnapshot(GUEST).redeemable, 0n)
// Deliberate and worth stating plainly: eligibility does not transfer. The gold
// arrives spendable but not redeemable, because the destination account did not
// earn it. Anything else would let a player farm headroom on throwaway guests.
equal('the destination gains no redeemable headroom from the merge', eligibilityOf(DORA).accrued, 0n)

/* ------------------------------------------------------------ hunt rewards */

section('a hunt reward is decided by the server and paid once')

const { openHunt, claimKill, recordHuntDeath, SPECIES_REWARD, rosterSize, rosterFor, HUNT_ROSTER_ROUNDS, MIN_CLAIM_GAP_MS, DEATH_LOSS_PERCENT } =
  await import('../src/server/hunt/rewards')
const { speciesSpecs, wildRegions } = await import('../src/wildlife')

// The server keeps its own copy of the reward table so this process stays free of
// Three.js. That copy is only safe if it cannot drift, which is what this asserts.
for (const [species, reward] of Object.entries(SPECIES_REWARD)) {
  const client = speciesSpecs[species as keyof typeof speciesSpecs]
  check(`${species} pays what the world says it pays`, client !== undefined && BigInt(client.goldBaseUnits) === reward,
    `server ${reward}, world ${client?.goldBaseUnits}`)
}
equal('the world has no species the server has not priced',
  Object.keys(speciesSpecs).filter(id => !(id in SPECIES_REWARD)).length, 0)

// The roster is the region's own population. A region renamed or repopulated in the
// world without the server being told would otherwise refuse every hunt silently.
for (const region of wildRegions) {
  const minted = rosterFor(region.id)
  const expected = Object.values(region.counts).reduce((total, count) => total + (count ?? 0), 0) * HUNT_ROSTER_ROUNDS
  equal(`${region.id} mints a roster the world agrees with`, minted.length, expected)
  const species = new Set(minted)
  check(`${region.id} mints only the species that live there`,
    [...species].every(id => (region.counts as Record<string, number | undefined>)[id] !== undefined),
    [...species].join(','))
}

// A real user row, because `hunt_sessions.user_id` is a foreign key into `users`.
// That constraint is the point: a hunt cannot exist for an account that does not.
const HUNTER = resolveUserForPrincipal('dev-hunter').userId
grantStartingGold(HUNTER)

check('hunting a level-8 region under-level is refused',
  !openHunt({ userId: HUNTER, playerId: 'p_hunter', region: 'brasswood', level: 3 }).ok)
check('an unknown region is refused', !openHunt({ userId: HUNTER, playerId: 'p_hunter', region: 'atlantis', level: 9 }).ok)

const opened = openHunt({ userId: HUNTER, playerId: 'p_hunter', region: 'wildwood', level: 9 })
check('a hunt opened', opened.ok, opened.ok ? opened.hunt.huntId : opened.reason)
if (!opened.ok) finish('ledger')
const hunt = opened.hunt
equal('the roster caps what the session can pay', hunt.tokens.length, rosterSize('wildwood'))
check('every token names a species the server priced',
  hunt.tokens.every(token => SPECIES_REWARD[token.species] !== undefined))
check('every token carries the server-decided reward',
  hunt.tokens.every(token => token.rewardGold === SPECIES_REWARD[token.species]!.toString()))
check('token ids are unique', new Set(hunt.tokens.map(token => token.tokenId)).size === hunt.tokens.length)

const first = hunt.tokens[0]!
const balanceBeforeKill = balanceOf(playerAvailable(HUNTER))
const claimed = claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: first.tokenId })
check('a kill claim credits', claimed.ok, claimed.ok ? claimed.credited : claimed.code)
equal('it credits exactly the token reward', balanceOf(playerAvailable(HUNTER)), balanceBeforeKill + SPECIES_REWARD[first.species]!)
equal('hunt gold is redeemable headroom', eligibilityOf(HUNTER).accrued, SPECIES_REWARD[first.species]!)

const replay = claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: first.tokenId })
check('claiming the same token again is refused', !replay.ok && replay.code === 'already_claimed',
  replay.ok ? 'it paid again' : replay.code)
equal('so the reward landed exactly once', balanceOf(playerAvailable(HUNTER)), balanceBeforeKill + SPECIES_REWARD[first.species]!)

const notMine = claimKill({ userId: ALICE, huntId: hunt.huntId, tokenId: hunt.tokens[1]!.tokenId })
check('another account cannot claim this hunt\'s tokens', !notMine.ok && notMine.code === 'not_yours',
  notMine.ok ? 'it paid' : notMine.code)
check('a forged token id is refused', !claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: 'hk_' + 'f'.repeat(32) }).ok)
check('a malformed token id is refused', !claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: 'not-a-token' }).ok)

// The rate gate is a burst limit, not a security boundary, and the check says so.
const immediate = claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: hunt.tokens[1]!.tokenId })
check('a second claim in the same millisecond is rate limited', !immediate.ok && immediate.code === 'rate_limited',
  immediate.ok ? 'it paid' : immediate.code)
const afterGap = claimKill({ userId: HUNTER, huntId: hunt.huntId, tokenId: hunt.tokens[1]!.tokenId, now: Date.now() + MIN_CLAIM_GAP_MS + 1 })
check('after the gap it is allowed', afterGap.ok, afterGap.ok ? afterGap.credited : afterGap.code)

const carried = balanceOf(playerAvailable(HUNTER))
const death = recordHuntDeath({ userId: HUNTER, huntId: hunt.huntId, clientRef: 'death-0001' })
check('death forfeits gold', death.ok, death.ok ? death.forfeited : death.reason)
equal('the forfeit is the server\'s percentage of the carried balance',
  death.ok ? BigInt(death.forfeited) : -1n, (carried * DEATH_LOSS_PERCENT) / 100n)
const deathReplay = recordHuntDeath({ userId: HUNTER, huntId: hunt.huntId, clientRef: 'death-0001' })
check('the same death reference forfeits once', deathReplay.ok && deathReplay.idempotent)
equal('so the balance only dropped once', balanceOf(playerAvailable(HUNTER)), carried - (carried * DEATH_LOSS_PERCENT) / 100n)

/* ------------------------------------------------------------ conservation */

section('the ledger balances')

const report = conservationReport()
check('every balance sums to zero', report.balanceSum === 0n, report.balanceSum.toString())
check('every entry sums to zero', report.entrySum === 0n, report.entrySum.toString())
check('no transfer has unbalanced legs', report.unbalancedTransfers.length === 0, report.unbalancedTransfers.join(','))
check('no balance has drifted from its entries', report.driftedAccounts.length === 0,
  report.driftedAccounts.map(a => `${a.accountId} ${a.balance} vs ${a.entrySum}`).join('; '))
check('the report agrees with itself', report.ok)

// Conservation is not an accident of these particular transfers. The mint is the
// only account allowed to be negative, and what it owes is exactly the gold that
// exists: held by players, retired into the sink, or sitting in the treasury.
const held = [ALICE, BOB, CARL, DORA, GUEST, HUNTER].reduce((total, user) => total + goldSnapshot(user).total, 0n)
const retired = balanceOf(SYSTEM_SINK)
equal('the mint owes exactly the gold that exists', -balanceOf(SYSTEM_MINT), held + retired + balanceOf(TREASURY_GOLD))
check('gold has actually been retired, so the sink is doing work', retired > 0n, retired.toString())

finish('ledger')
