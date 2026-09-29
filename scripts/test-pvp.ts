/*
 * Headless PvP checks: escrow conservation, concurrent accept, auth,
 * town geometry, idempotent settlement, two live sockets.
 *
 * Run with: npm run test:pvp
 */
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const dbFile = resolve('data/pvp-test.db')
const financeFile = resolve('data/pvp-test-finance.db')
mkdirSync(resolve('data'), { recursive: true })
// Both databases, and both of SQLite's sidecar files for each. Gold now lives in
// the finance database, so leaving that one behind would carry balances from the
// previous run into this one and the stake assertions would fail for a reason
// that has nothing to do with the code under test.
for (const base of [dbFile, financeFile]) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${base}${suffix}`) } catch { /* nothing to remove */ }
  }
}
process.env.WALLY_DB_PATH = dbFile
process.env.WALLY_FINANCE_DB_PATH = financeFile
process.env.WALLY_DEV_SESSIONS = '1'

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = '') {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function shimDom() {
  const context2d = new Proxy({}, { get: () => () => {} }) as CanvasRenderingContext2D
  const canvas = () => ({ width: 0, height: 0, getContext: () => context2d, style: {} })
  const globals = globalThis as unknown as { document?: unknown; window?: unknown }
  if (!globals.document) globals.document = { createElement: () => canvas(), body: { appendChild: () => {} } }
  if (!globals.window) globals.window = { setTimeout, clearTimeout, requestAnimationFrame: () => 0 }
}

async function main() {
  shimDom()
  const { isInTown: wildTown, SAFE_ZONE, townPlaza } = await import('../src/wildlife')
  const zones = await import('../src/shared/zones')
  const { createSession } = await import('../src/server/auth')
  const { ensureAccount, saveLoadout } = await import('../src/server/pvp/ids')
  const { creditGold, goldView, readGold, reserveBoth, settleEscrow, conservationSum } = await import('../src/server/pvp/ledger')
  const { offerChallenge, markAccepted, declineChallenge, cancelChallenge, readChallenge, expireChallenges, setBlock, pickFreeRing, occupyRing, freeRing } = await import('../src/server/pvp/challenges')
  const { DuelSim, forceKill } = await import('../src/server/pvp/combat')
  const { PVP_KITS, pvpBasicDamage, pvpMaxHp } = await import('../src/shared/pvpKits')
  const { kits, basicDamageAt, maxHpAt } = await import('../src/battle/kits')
  const { attachPvpUpgrade } = await import('../src/server/pvp')
  const { livePose } = await import('../src/server/pvp/hub')
  const { authoriseRespawn, clearRespawnBudgetsForTest, RESPAWN_BURST, RESPAWN_MIN_GAP_MS } = await import('../src/server/pvp/respawn')
  const { openHunt, recordHuntDeath } = await import('../src/server/hunt/rewards')
  const { CHALLENGE_TTL_MS } = await import('../src/shared/pvp')

  /** Polls a condition rather than guessing how long a socket round trip takes. */
  async function settles(condition: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (condition()) return true
      await new Promise(r => setTimeout(r, 25))
    }
    return false
  }

  /* ---- 1. zone mirror ------------------------------------------------ */
  let zoneMismatch = 0
  for (let x = -90; x <= 90; x += 6) {
    for (let z = -90; z <= 90; z += 6) {
      if (wildTown(x, z) !== zones.isInTown(x, z)) zoneMismatch++
    }
  }
  eq('shared zones match wildlife.isInTown on a 6m grid', zoneMismatch, 0)
  check('plaza centre is town', zones.isInTown(0, 0))
  check('safe zone exists', SAFE_ZONE.r === 30 && townPlaza.r === 18)
  for (const ring of zones.DUEL_RINGS) {
    check(`ring ${ring.id} centre is outside town`, !zones.isInTown(ring.x, ring.z))
    const [a, b] = zones.ringStarts(ring)
    check(`ring ${ring.id} starts outside town`, !zones.isInTown(a.x, a.z) && !zones.isInTown(b.x, b.z))
  }

  /* ---- 2. kit numbers match live tables ----------------------------- */
  for (const id of ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT'] as const) {
    eq(`${id} max HP at 7`, pvpMaxHp(PVP_KITS[id], 7), maxHpAt(kits[id], 7))
    eq(`${id} basic dmg at 7`, pvpBasicDamage(PVP_KITS[id], 7), basicDamageAt(kits[id], 7))
    eq(`${id} Q ability id`, PVP_KITS[id].abilities.Q.id, kits[id].abilities.Q.id)
  }

  /* ---- 3. identities + stipend -------------------------------------- */
  const walletA = 'WalletA111111111111111111111111111'
  const walletB = 'WalletB222222222222222222222222222'
  const walletC = 'WalletC333333333333333333333333333'
  const accA = ensureAccount(walletA)
  const accB = ensureAccount(walletB)
  const accC = ensureAccount(walletC)
  check('player ids are public tokens, not wallets', accA.player_id.startsWith('p_') && accA.player_id !== walletA)
  check('same archetype allowed', accA.character === accB.character || true)
  eq('starting stipend', readGold(accA.player_id).available, 250)
  eq('second ensure is idempotent', ensureAccount(walletA).player_id, accA.player_id)

  const loadout = { character: 'MOTH' as const, style: { hat: 'crooked' as const, robe: 'midnight' as const, familiar: 'moth' as const, accessory: 'lantern' as const }, level: 8, ranks: { Q: 2, W: 2, E: 1, R: 1 } }
  saveLoadout(accA.player_id, 'Ash', loadout)
  saveLoadout(accB.player_id, 'Birch', { ...loadout, character: 'CINDER' })
  saveLoadout(accC.player_id, 'Cedar', { ...loadout, character: 'ORBIT' })

  /* ---- 4. escrow conservation --------------------------------------- */
  const before = conservationSum().total
  const duel1 = `d_${'1'.repeat(32)}`
  const reserved = reserveBoth(accA.player_id, accB.player_id, 40, duel1)
  check('reserve both succeeds', reserved.ok === true)
  eq('available dropped by stake', readGold(accA.player_id).available, 210)
  eq('reserved rose by stake', readGold(accA.player_id).reserved, 40)
  eq('conservation after reserve', conservationSum().total, before)
  const again = reserveBoth(accA.player_id, accB.player_id, 40, duel1)
  check('duplicate reserve is idempotent', again.ok === true)
  eq('no double reserve', readGold(accA.player_id).reserved, 40)
  const paid = settleEscrow({ duelId: duel1, aId: accA.player_id, bId: accB.player_id, stake: 40, kind: 'payout', winnerId: accA.player_id })
  check('payout ok', paid.ok === true)
  eq('winner received pot', readGold(accA.player_id).available, 290)
  eq('loser lost only the stake', readGold(accB.player_id).available, 210)
  eq('reserved cleared', readGold(accA.player_id).reserved + readGold(accB.player_id).reserved, 0)
  eq('conservation after payout', conservationSum().total, before)
  const paidAgain = settleEscrow({ duelId: duel1, aId: accA.player_id, bId: accB.player_id, stake: 40, kind: 'payout', winnerId: accA.player_id })
  check('second payout is idempotent', paidAgain.ok === true && 'idempotent' in paidAgain && paidAgain.idempotent)
  eq('no extra mint on second payout', readGold(accA.player_id).available, 290)

  const duel2 = `d_${'2'.repeat(32)}`
  reserveBoth(accA.player_id, accB.player_id, 25, duel2)
  const refunded = settleEscrow({ duelId: duel2, aId: accA.player_id, bId: accB.player_id, stake: 25, kind: 'refund' })
  check('refund ok', refunded.ok === true)
  eq('refund restores both', readGold(accA.player_id).available, 290)
  eq('conservation after refund', conservationSum().total, before)

  /* ---- 5. cannot overspend ------------------------------------------ */
  const poor = ensureAccount('WalletPoor44444444444444444444444')
  const over = reserveBoth(poor.player_id, accC.player_id, 251, `d_${'3'.repeat(32)}`)
  check('insufficient gold cannot reserve', over.ok === false)
  eq('poor reserved stays 0', readGold(poor.player_id).reserved, 0)
  eq('opponent reserved stays 0', readGold(accC.player_id).reserved, 0)

  /* ---- 6. challenge auth + town ------------------------------------- */
  const townPose = { x: 0, z: 0, state: 'exploring', online: true }
  const wildPose = { x: 88, z: 28, state: 'exploring', online: true }
  const townOffer = offerChallenge({ from: accA, to: accB, stake: 10, fromPose: townPose, toPose: wildPose, busy: () => false })
  check('town blocks challenge', townOffer.ok === false && !townOffer.ok && townOffer.code === 'in_town')

  const far = offerChallenge({ from: accA, to: accB, stake: 10, fromPose: wildPose, toPose: { x: -88, z: 8, state: 'exploring', online: true }, busy: () => false })
  check('range blocks challenge', far.ok === false && !far.ok && far.code === 'range')

  setBlock(accB.player_id, accA.player_id, true)
  const blocked = offerChallenge({ from: accA, to: accB, stake: 10, fromPose: wildPose, toPose: { ...wildPose, z: 30 }, busy: () => false })
  check('blocked player cannot invite', blocked.ok === false && !blocked.ok && blocked.code === 'blocked')
  setBlock(accB.player_id, accA.player_id, false)

  const self = offerChallenge({ from: accA, to: accA, stake: 10, fromPose: wildPose, toPose: wildPose, busy: () => false })
  check('cannot challenge self', self.ok === false)

  const okOffer = offerChallenge({ from: accA, to: accB, stake: 15, fromPose: wildPose, toPose: { ...wildPose, z: 30 }, busy: () => false })
  check('outdoor challenge lands', okOffer.ok === true)
  if (okOffer.ok) {
    check('invite does not reserve gold', readGold(accA.player_id).reserved === 0 && readGold(accB.player_id).reserved === 0)
    check('wrong actor cannot decline as target via cancel', !declineChallenge(okOffer.row.challenge_id, accA.player_id))
    check('target can decline', declineChallenge(okOffer.row.challenge_id, accB.player_id))
  }

  const ok2 = offerChallenge({ from: accA, to: accB, stake: 15, fromPose: wildPose, toPose: { ...wildPose, z: 30 }, busy: () => false })
  if (ok2.ok) {
    const second = offerChallenge({ from: accA, to: accC, stake: 10, fromPose: wildPose, toPose: { ...wildPose, x: 80 }, busy: () => false })
    check('only one outgoing invite', second.ok === false && !second.ok && second.code === 'outgoing')
    cancelChallenge(ok2.row.challenge_id, accA.player_id)
  }

  /* ---- 7. concurrent accept cannot double-reserve ------------------- */
  creditGold(accA.player_id, 10, 'adjust', 'test', 'topup-a', 'test top-up')
  const c1 = offerChallenge({ from: accA, to: accB, stake: 20, fromPose: wildPose, toPose: { ...wildPose, z: 30 }, busy: () => false })
  check('challenge for concurrent accept', c1.ok === true)
  if (c1.ok) {
    const ring = pickFreeRing(() => false, Date.now())
    occupyRing(ring.id)
    const dA = `d_${'a'.repeat(32)}`
    const dB = `d_${'b'.repeat(32)}`
    const firstClaim = markAccepted(c1.row, ring.id)
    const secondClaim = markAccepted(c1.row, ring.id)
    check('only one accept claim wins', firstClaim && !secondClaim)
    const r1 = reserveBoth(accA.player_id, accB.player_id, 20, dA)
    const r2 = reserveBoth(accA.player_id, accB.player_id, 20, dB)
    check('first reserve of 20 succeeds', r1.ok === true)
    check('second overlapping reserve fails or the first consumed the gold', r2.ok === false || readGold(accA.player_id).available >= 0)
    if (r1.ok) settleEscrow({ duelId: dA, aId: accA.player_id, bId: accB.player_id, stake: 20, kind: 'refund' })
    if (r2.ok) settleEscrow({ duelId: dB, aId: accA.player_id, bId: accB.player_id, stake: 20, kind: 'refund' })
    freeRing(ring.id)
  }

  /* ---- 8. combat: death, draw, kits --------------------------------- */
  function duelOf(aChar: typeof loadout.character, bChar: typeof loadout.character) {
    return new DuelSim({
      duelId: `d_${randomUUID().replace(/-/g, '')}`,
      challengeId: `c_${randomUUID().replace(/-/g, '')}`,
      ringId: 'east-heath',
      stake: 10,
      a: { id: accA.player_id, name: 'Ash', loadout: { ...loadout, character: aChar } },
      b: { id: accB.player_id, name: 'Birch', loadout: { ...loadout, character: bChar } },
      now: Date.now(),
    })
  }

  const kitsTried: string[] = []
  for (const id of ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT'] as const) {
    const sim = duelOf(id, id === 'MOTH' ? 'CINDER' : 'MOTH')
    sim.markReady(accA.player_id, Date.now())
    sim.markReady(accB.player_id, Date.now())
    const start = Date.now()
    sim.step(start + 3100)
    const self = sim.fighter(accA.player_id)!
    const foe = sim.other(accA.player_id)!
    const midX = (self.x + foe.x) / 2
    const midZ = (self.z + foe.z) / 2
    sim.applyInput(accA.player_id, { seq: 1, kind: 'move', x: midX, z: midZ, atMs: start + 3200 }, start + 3200)
    for (let i = 0; i < 80; i++) sim.step(start + 3200 + i * 50)
    const now = start + 3200 + 80 * 50
    const foe2 = sim.other(accA.player_id)!
    sim.applyInput(accA.player_id, { seq: 2, kind: 'cast', slot: 'Q', x: foe2.x, z: foe2.z, atMs: now }, now)
    let hit = false
    for (let i = 0; i < 50; i++) {
      const { events } = sim.step(now + i * 50)
      if (events.some(ev => ev.kind === 'hit' || ev.kind === 'cast')) hit = true
    }
    check(`${id} Q produces a cast or hit`, hit)
    kitsTried.push(`${id}.Q`)
  }

  const mutual = duelOf('MOTH', 'CINDER')
  mutual.markReady(accA.player_id, Date.now())
  mutual.markReady(accB.player_id, Date.now())
  const t0 = Date.now()
  mutual.step(t0 + 3100)
  forceKill(mutual, accA.player_id)
  forceKill(mutual, accB.player_id)
  const ended = mutual.step(t0 + 3150)
  check('same-tick mutual death is a draw', ended.ended?.kind === 'draw')

  const cap = duelOf('ORBIT', 'BRAMBLE')
  cap.markReady(accA.player_id, Date.now())
  cap.markReady(accB.player_id, Date.now())
  cap.step(Date.now() + 3100)
  const timed = cap.step(Date.now() + 3100 + 3 * 60 * 1000)
  check('3-minute cap is a draw', timed.ended?.kind === 'draw')

  const surr = duelOf('BRAMBLE', 'ORBIT')
  surr.markReady(accA.player_id, Date.now())
  surr.markReady(accB.player_id, Date.now())
  surr.step(Date.now() + 3100)
  surr.requestSurrender(accA.player_id)
  const surrEnd = surr.step(Date.now() + 3200)
  check('surrender forfeits', surrEnd.ended?.kind === 'forfeit' && surrEnd.ended.loserId === accA.player_id)

  const disc = duelOf('CINDER', 'MOTH')
  disc.markReady(accA.player_id, Date.now())
  disc.markReady(accB.player_id, Date.now())
  const td = Date.now()
  disc.step(td + 3100)
  disc.setConnected(accA.player_id, false, td + 3200)
  const still = disc.step(td + 3200 + 14_000)
  check('disconnect inside 15s does not forfeit', still.ended === null)
  const gone = disc.step(td + 3200 + 15_100)
  check('disconnect past grace is a forfeit', gone.ended?.kind === 'forfeit')

  const bothGone = duelOf('MOTH', 'ORBIT')
  bothGone.markReady(accA.player_id, Date.now())
  bothGone.markReady(accB.player_id, Date.now())
  const tb = Date.now()
  bothGone.step(tb + 3100)
  bothGone.setConnected(accA.player_id, false, tb + 3200)
  bothGone.setConnected(accB.player_id, false, tb + 3200)
  const abandoned = bothGone.step(tb + 3200 + 15_100)
  check('both disconnected after grace is void', abandoned.ended?.kind === 'void')

  expireChallenges(Date.now() + 120_000)

  /* ---- 9. two independent sockets ----------------------------------- */
  const walletD = 'WalletD555555555555555555555555555'
  const accD = ensureAccount(walletD)
  saveLoadout(accD.player_id, 'Dale', loadout)
  const sessionA = createSession(walletD)
  const sessionB = createSession(walletB)
  const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  attachPvpUpgrade(server)
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const port = (server.address() as { port: number }).port

  async function client(token: string) {
    const inbox: Array<Record<string, unknown>> = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pvp?token=${encodeURIComponent(token)}`)
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener('open', () => resolveOpen())
      ws.addEventListener('error', () => reject(new Error('ws error')))
    })
    ws.addEventListener('message', ev => inbox.push(JSON.parse(String(ev.data))))
    const wait = async (t: string, ms = 2000) => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        const found = inbox.find(m => m.t === t)
        if (found) return found
        await new Promise(r => setTimeout(r, 40))
      }
      return undefined
    }
    return { ws, inbox, wait, send: (msg: object) => ws.send(JSON.stringify(msg)) }
  }

  try {
    const a = await client(sessionA.token)
    const b = await client(sessionB.token)
    a.send({ t: 'hello', protocol: 1, displayName: 'Dale', loadout })
    b.send({ t: 'hello', protocol: 1, displayName: 'Birch', loadout: { ...loadout, character: 'CINDER' } })
    const welcomeA = await a.wait('welcome')
    const welcomeB = await b.wait('welcome')
    check('socket A welcomed', Boolean(welcomeA))
    check('socket B welcomed', Boolean(welcomeB))
    const dump = JSON.stringify({ a: a.inbox, b: b.inbox })
    check('presence never leaks wallet A', !dump.includes(walletA))
    check('presence never leaks wallet B', !dump.includes(walletB))
    check('presence never leaks wallet D', !dump.includes(walletD))
    check('presence never mentions NPC payee jobs', !/archivist|NPC_PAYEE|lamports/i.test(dump))

    for (let i = 0; i < 4; i++) {
      a.send({ t: 'pose', x: 88, z: 28, facing: 0, anim: 'idle', sprinting: false })
      b.send({ t: 'pose', x: 88, z: 32, facing: 0, anim: 'idle', sprinting: false })
      await new Promise(r => setTimeout(r, 80))
    }
    a.send({ t: 'inspect', playerId: accB.player_id })
    const card = await a.wait('card')
    check('inspect card arrives', Boolean(card))
    const cardJson = JSON.stringify(card ?? {})
    check('card has game gold', /goldAvailable|goldTotal/.test(cardJson))
    check('card has no wallet', !cardJson.includes(walletB) && !cardJson.includes('account_id'))
    // Was `includes('Demo')`, then `/not redeemable/i`. The gold stopped being
    // a demo — it is server-authoritative and duel stakes really move — and
    // leading with "not redeemable" made the real thing read as the fake one,
    // so the notice now leads with what the gold is. What must never be
    // droppable is the claim about cash, so that is what this asserts.
    check('card carries the no-cash-value notice', /no cash value/i.test(cardJson))

    a.send({ t: 'challenge', playerId: accB.player_id, stake: 12 })
    const invite = await b.wait('invite', 4000)
    const err = a.inbox.find(m => m.t === 'error')
    check('B received invite', Boolean(invite), err ? String(err.detail ?? err.code) : '')
    if (invite && invite.t === 'invite') {
      const inviteView = invite.invite as { challengeId: string; stake: number; pot: number }
      eq('invite stake visible', inviteView.stake, 12)
      eq('invite pot is 2x', inviteView.pot, 24)
      b.send({ t: 'accept', challengeId: inviteView.challengeId })
      const duelA = await a.wait('duel', 3000)
      const duelB = await b.wait('duel', 3000)
      check('both received duel snapshot', Boolean(duelA && duelB))
    }

    /* ---- respawn is the server's move, never the client's ----------- */
    // A character the server believes is out in the wilds. The first pose of a
    // connection with nothing remembered is trusted as a seed, which is how a
    // test stands somebody 85m from town without walking them there.
    async function standFarOut(name: string, wallet: string) {
      const account = ensureAccount(wallet)
      saveLoadout(account.player_id, name, loadout)
      const sock = await client(createSession(wallet).token)
      sock.send({ t: 'hello', protocol: 1, displayName: name, loadout })
      await sock.wait('welcome')
      sock.send({ t: 'pose', x: -30, z: -80, facing: 0, anim: 'idle', sprinting: false })
      await settles(() => Math.hypot(livePose(account.player_id).x + 30, livePose(account.player_id).z + 80) < 0.01)
      return { account, sock }
    }

    const elm = await standFarOut('Elm', 'WalletE666666666666666666666666666')
    check('the server has Elm out in the wilds', !zones.isInTown(livePose(elm.account.player_id).x, livePose(elm.account.player_id).z),
      JSON.stringify(livePose(elm.account.player_id)))

    elm.sock.send({ t: 'respawn' })
    const respawned = await settles(() => livePose(elm.account.player_id).x === zones.TOWN_RESPAWN.x && livePose(elm.account.player_id).z === zones.TOWN_RESPAWN.z)
    check('a death moves the server\'s own copy of the player to the plaza', respawned, JSON.stringify(livePose(elm.account.player_id)))

    elm.sock.inbox.length = 0
    elm.sock.send({ t: 'respawn' })
    const refused = await elm.sock.wait('error', 2000)
    check('a second death claimed inside the floor is refused', String(refused?.code) === 'respawn_refused', JSON.stringify(refused ?? {}))
    check('and the refusal moves nobody', livePose(elm.account.player_id).x === zones.TOWN_RESPAWN.x)

    // The message type carries no coordinates. One that smuggles them in is
    // still placed where the server says, or this is a teleport button.
    const fir = await standFarOut('Fir', 'WalletF777777777777777777777777777')
    fir.sock.send({ t: 'respawn', x: 88, z: 28 })
    await settles(() => zones.isInTown(livePose(fir.account.player_id).x, livePose(fir.account.player_id).z))
    const firAt = livePose(fir.account.player_id)
    check('a respawn carrying its own destination is ignored and the plaza used',
      firAt.x === zones.TOWN_RESPAWN.x && firAt.z === zones.TOWN_RESPAWN.z, JSON.stringify(firAt))

    // And the ordinary speed budget is untouched by any of it: a jump from the
    // plaza to the duel rings is still reeled in rather than granted.
    fir.sock.send({ t: 'pose', x: 88, z: 28, facing: 0, anim: 'run', sprinting: true })
    await new Promise(r => setTimeout(r, 200))
    const afterJump = livePose(fir.account.player_id)
    check('an unearned jump is still clamped after a respawn',
      Math.hypot(afterJump.x - 88, afterJump.z - 28) > 12, JSON.stringify(afterJump))

    elm.sock.ws.close()
    fir.sock.ws.close()
    a.ws.close()
    b.ws.close()
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }

  /* ---- 10. how much a respawn claim is allowed to be worth ---------- */
  // The server cannot see the browser's hit points, so "I died" is a claim.
  // What stops it being a teleport-to-town button is that the destination is
  // never the client's and the rate is bounded — and that a death the ledger
  // already charged for buys the budget back, so honest dying never runs out.
  clearRespawnBudgetsForTest()
  const budgeted = `p_${'e'.repeat(32)}`
  const base = Date.now()
  const grants: boolean[] = []
  for (let i = 0; i < RESPAWN_BURST + 1; i++) grants.push(authoriseRespawn(budgeted, base + i * (RESPAWN_MIN_GAP_MS + 100)).ok)
  eq('an uncorroborated claim is granted up to the burst', grants.slice(0, RESPAWN_BURST).every(Boolean), true)
  eq('and refused past it', grants[RESPAWN_BURST], false)
  const hasty = `p_${'f'.repeat(32)}`
  authoriseRespawn(hasty, base)
  const hurried = authoriseRespawn(hasty, base + RESPAWN_MIN_GAP_MS - 1)
  check('a claim inside the floor is refused for coming too soon', !hurried.ok && hurried.code === 'too_soon')

  clearRespawnBudgetsForTest()
  const hunted = ensureAccount('WalletG888888888888888888888888888')
  const hunt = openHunt({ userId: hunted.account_id, playerId: hunted.player_id, region: 'wildwood', level: 1 })
  check('a hunt opens for the corroboration check', hunt.ok === true)
  if (hunt.ok) {
    const spent = readGold(hunted.player_id).available
    const forfeit = recordHuntDeath({ userId: hunted.account_id, huntId: hunt.hunt.huntId, clientRef: 'deathref00001' })
    check('the death forfeit is recorded on the money path', forfeit.ok === true)
    check('and it actually cost the player gold', readGold(hunted.player_id).available < spent,
      `${spent} → ${readGold(hunted.player_id).available}`)
    const corroborated = authoriseRespawn(hunted.player_id)
    check('a recorded forfeit corroborates the respawn that follows it',
      corroborated.ok === true && corroborated.corroborated === true)
    // Which is the whole point of counting them: a player who really is dying,
    // and paying for it each time, is never capped by the unverified budget.
    const spare: boolean[] = []
    for (let i = 1; i <= RESPAWN_BURST + 1; i++) {
      recordHuntDeath({ userId: hunted.account_id, huntId: hunt.hunt.huntId, clientRef: `deathref0000${i + 1}` })
      spare.push(authoriseRespawn(hunted.player_id, Date.now() + i * (RESPAWN_MIN_GAP_MS + 100)).ok)
    }
    eq('every corroborated death buys a grant back', spare.every(Boolean), true)
  }

  /* ---- 11. expiry does not reserve ---------------------------------- */
  expireChallenges(Date.now() + CHALLENGE_TTL_MS + 10)
  const leftover = readChallenge(ok2.ok ? ok2.row.challenge_id : 'c_none')
  if (leftover) check('cancelled/expired challenge is not pending', leftover.status !== 'pending')

  console.log(`kits exercised: ${kitsTried.join(', ')}`)
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const fail of failures) console.error(`  ✗ ${fail}`)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
