/* ------------------------------------------------------------------ *
 * What happens to two real players AFTER a duel settles.
 *
 * `verify-multiplayer.mjs` drives a duel to a settled result and stops
 * there, which is why the freeze in this report survived it: everything
 * that goes wrong goes wrong in the seconds after the result card
 * appears, and it goes wrong for BOTH fighters at once.
 *
 * Two separate Chrome profiles, so these are two genuinely different
 * players and not one session in two windows. Both fight, the fight
 * settles, and then the run asks the only question that matters: can
 * either of them move again, and does every path out of the duel
 * actually lead out of it.
 *
 *   UI_TARGET=http://127.0.0.1:5211 node scripts/verify-duel-lifecycle.mjs
 *
 * `DUEL_EXIT=rematch|leave|none|reload` picks which way the fighters try
 * to leave. Default `rematch`, because that is the primary button on the
 * result card and therefore what a player actually presses.
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5211'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXIT = process.env.DUEL_EXIT ?? 'rematch'
const SHOTS = process.env.SHOT_DIR ?? 'screenshots'
// `screenshots/` is gitignored, so it is absent in a fresh checkout and the
// run would otherwise die on the first capture — after the duel, with both
// browsers still open and nothing reported.
mkdirSync(SHOTS, { recursive: true })

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(fn, timeoutMs = 60_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = await fn()
    if (last) return last
    await sleep(stepMs)
  }
  return null
}

/*
 * The real GL backend, deliberately. SwiftShader runs this world at about
 * 3fps, and the world tick clamps dt — so frame rate becomes movement speed
 * and a software client behaves like a different game. Chasing a freeze on
 * one would be chasing the renderer.
 */
async function launch(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 300_000,
    userDataDir: profileDir,
    args: ['--no-sandbox', '--window-size=1280,800'],
  })
}

const clickText = async (page, text) => {
  const hit = await page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(t))
    if (el && !el.disabled) {
      el.click()
      return true
    }
    return false
  }, text)
  await sleep(600)
  return hit
}

async function enterWorld(page, name) {
  const notes = []
  page.on('pageerror', e => notes.push(`pageerror ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') notes.push(`console ${m.text()}`) })
  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1200)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  await page.evaluate(value => {
    const input = document.querySelector('#wayfinder-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, name)
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.pvpUi', { timeout: 180_000 })
  const joined = await until(() => page.evaluate('window.__wally.pvpUi().connected === true ? window.__wally.pvpUi().playerId : null'), 90_000)
  if (!joined) throw new Error(`${name} never connected at ${UI}\n  ${notes.slice(-8).join('\n  ') || 'no browser errors'}`)
  return joined
}

const ui = page => page.evaluate('window.__wally.pvpUi()')
const pvpSend = (page, msg) => page.evaluate(m => window.__wally.pvpSend(m), msg)
const locked = page => page.evaluate('typeof window.__pvpLocked === "function" ? window.__pvpLocked() : null')

function seedGold(playerId, amount) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/seed-gold.ts', playerId, String(amount)], {
      cwd: process.cwd(),
      env: { ...process.env, WALLY_DB_PATH: process.env.WALLY_DB_PATH ?? 'data/duelfix/wally.db' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`seed-gold failed: ${out}`))))
  })
}

/**
 * Walks to a world point at a speed the server will actually agree to.
 *
 * Asserting the destination outright does not work and is worth spelling
 * out, because it is the same shape as the bug being hunted: the server
 * clamps anything faster than a run, the client snaps itself back once the
 * two disagree by more than `DESYNC_SNAP_DISTANCE`, and the two
 * corrections then fight each other for as long as you keep asking. So
 * this asks for one short hop at a time — under the snap threshold, so
 * nothing ever disagrees enough to snap — and waits for the server's copy
 * to arrive before asking for the next.
 */
async function standAt(page, x, z) {
  const HOP = 8
  for (let attempt = 0; attempt < 120; attempt++) {
    const self = await page.evaluate('window.__wally.pvp().self')
    if (!self) { await sleep(250); continue }
    const gap = Math.hypot(self.x - x, self.z - z)
    if (gap < 2) return self
    const step = Math.min(HOP, gap)
    const nx = self.x + ((x - self.x) / gap) * step
    const nz = self.z + ((z - self.z) / gap) * step
    await page.evaluate((gx, gz) => {
      window.__wally.player.position.set(gx, window.__wally.player.position.y, gz)
    }, nx, nz)
    await sleep(350)
  }
  return page.evaluate('window.__wally.pvp().self')
}

/**
 * Whether this client can still move its own wizard.
 *
 * Two halves, because a freeze can come from either end. The local half
 * asks whether anything in the client is pinning the player object back
 * over the top of the move; the server half asks whether the world server
 * accepted it. A player is only really free when both say yes.
 */
async function canMove(page, label) {
  const start = await page.evaluate(() => {
    const p = window.__wally.player.position
    return { x: p.x, z: p.z }
  })
  await page.evaluate(() => {
    const p = window.__wally.player.position
    p.set(p.x + 6, p.y, p.z)
  })
  await sleep(700)
  const local = await page.evaluate(() => {
    const p = window.__wally.player.position
    return { x: p.x, z: p.z }
  })
  const self = await page.evaluate('window.__wally.pvp().self')
  const localMoved = Math.hypot(local.x - start.x, local.z - start.z) > 1
  const serverMoved = Boolean(self) && Math.hypot(self.x - local.x, self.z - local.z) < 4
  console.log(`      ${label}: local ${start.x.toFixed(1)},${start.z.toFixed(1)} -> ${local.x.toFixed(1)},${local.z.toFixed(1)} · server ${self ? `${self.x.toFixed(1)},${self.z.toFixed(1)} (${self.state})` : 'none'}`)
  return { localMoved, serverMoved, local, self }
}

async function main() {
  console.log(`Voxels · duel lifecycle, two Chrome profiles — ${UI} · exit via "${EXIT}"\n`)
  const root = await mkdtemp(join(tmpdir(), 'wally-duel-'))
  const browserA = await launch(join(root, 'a'))
  const browserB = await launch(join(root, 'b'))

  try {
    const pageA = await browserA.newPage()
    const pageB = await browserB.newPage()
    await pageA.setViewport({ width: 1280, height: 800 })
    await pageB.setViewport({ width: 1280, height: 800 })

    const idA = await enterWorld(pageA, 'Ash')
    const idB = await enterWorld(pageB, 'Birch')
    check('two profiles are two different players', Boolean(idA && idB) && idA !== idB, `${idA} / ${idB}`)

    const sawEachOther = await until(async () => {
      const a = await ui(pageA)
      const b = await ui(pageB)
      return a.others > 0 && b.others > 0
    }, 60_000)
    check('each browser sees the other in presence', Boolean(sawEachOther))

    const SEED = 200
    // Measured against what each side held BEFORE the credit, and waited for on
    // both sides. Reading a balance that the credit has not reached yet gives a
    // baseline the conservation sum is then measured against, and a wrong
    // baseline invents a conservation failure that is not there.
    const openingA = (await ui(pageA)).gold?.available ?? 0
    const openingB = (await ui(pageB)).gold?.available ?? 0
    for (const id of [idA, idB]) await seedGold(id, SEED)
    const funded = await until(async () => {
      const a = (await ui(pageA)).gold?.available ?? 0
      const b = (await ui(pageB)).gold?.available ?? 0
      return a >= openingA + SEED && b >= openingB + SEED ? { a, b } : null
    }, 30_000, 500)
    check('both credits landed before anything was staked', Boolean(funded))

    const FIELD_A = { x: 88, z: 28 }
    const FIELD_B = { x: 88, z: 33 }
    const restA = await standAt(pageA, FIELD_A.x, FIELD_A.z)
    const restB = await standAt(pageB, FIELD_B.x, FIELD_B.z)
    check('both fighters walked out of town to open ground',
      Boolean(restA && restB) && Math.hypot(restA.x - FIELD_A.x, restA.z - FIELD_A.z) < 4 && Math.hypot(restB.x - FIELD_B.x, restB.z - FIELD_B.z) < 4,
      `A ${restA?.x?.toFixed(1)},${restA?.z?.toFixed(1)} · B ${restB?.x?.toFixed(1)},${restB?.z?.toFixed(1)}`)

    const goldA = funded?.a ?? 0
    const goldB = funded?.b ?? 0
    const stake = Math.max(1, Math.min(10, goldA, goldB))
    check('both fighters can stake', goldA > 0 && goldB > 0, `A=${goldA} B=${goldB} stake=${stake}`)

    /* ---- the duel ---------------------------------------------------- */
    await pvpSend(pageA, { t: 'challenge', playerId: idB, stake })
    const invite = await until(async () => (await ui(pageB)).invite, 30_000)
    check('the invitation arrives', Boolean(invite), (await ui(pageA)).error ?? '')
    if (!invite) return

    await pvpSend(pageB, { t: 'accept', challengeId: invite.challengeId })
    const duel = await until(async () => (await ui(pageA)).duel, 30_000)
    check('a duel opens for both', Boolean(duel) && Boolean((await ui(pageB)).duel), duel ? `phase ${duel.phase}` : '')
    if (!duel) return

    await pvpSend(pageA, { t: 'ready', duelId: duel.duelId })
    await pvpSend(pageB, { t: 'ready', duelId: duel.duelId })
    const fighting = await until(async () => {
      const d = (await ui(pageA)).duel
      return d && d.phase === 'active' ? d : null
    }, 45_000)
    check('the fight goes active for both', Boolean(fighting), fighting?.phase)

    // Fought, not forced: both left-click attack, which is what a player does.
    for (let i = 0; i < 40; i++) {
      await pvpSend(pageA, { t: 'input', duelId: duel.duelId, seq: 100 + i, kind: 'attack' })
      await pvpSend(pageB, { t: 'input', duelId: duel.duelId, seq: 200 + i, kind: 'attack' })
      const d = (await ui(pageA)).duel
      if (!d || d.phase === 'ended' || (await ui(pageA)).result) break
      await sleep(500)
    }
    let resultA = await until(async () => (await ui(pageA)).result, 20_000)
    if (!resultA) {
      // A stalemate is not what is under test; end it the defined way.
      await pvpSend(pageB, { t: 'surrender', duelId: duel.duelId })
      resultA = await until(async () => (await ui(pageA)).result, 30_000)
    }
    const resultB = await until(async () => (await ui(pageB)).result, 30_000)
    check('the duel settles for both fighters', Boolean(resultA && resultB),
      resultA ? `${resultA.kind} · ${resultA.reason}` : '')

    const afterA = (await ui(pageA)).gold?.available ?? 0
    const afterB = (await ui(pageB)).gold?.available ?? 0
    check('stakes are conserved across the settlement', afterA + afterB === goldA + goldB,
      `A ${goldA}->${afterA}, B ${goldB}->${afterB}`)

    await pageA.screenshot({ path: `${SHOTS}/duel-a-result.png` })
    await pageB.screenshot({ path: `${SHOTS}/duel-b-result.png` })

    /* ---- and now the part nothing else tests ------------------------- */
    console.log(`\n  leaving the duel via "${EXIT}"`)
    if (EXIT === 'rematch') {
      check('A finds the Rematch button', await clickText(pageA, 'Rematch'))
      check('B finds the Rematch button', await clickText(pageB, 'Rematch'))
    } else if (EXIT === 'leave') {
      check('A finds Leave Arena', await clickText(pageA, 'Leave Arena'))
      check('B finds Leave Arena', await clickText(pageB, 'Leave Arena'))
    } else if (EXIT === 'reload') {
      await pageA.reload({ waitUntil: 'domcontentloaded' })
      await enterWorld(pageA, 'Ash')
    }
    await sleep(2500)

    const uiA = await ui(pageA)
    const uiB = await ui(pageB)
    console.log(`      A duel=${uiA.duel ? uiA.duel.phase : 'null'} result=${uiA.result ? 'shown' : 'null'} locked=${await locked(pageA)} error=${uiA.error ?? '-'}`)
    console.log(`      B duel=${uiB.duel ? uiB.duel.phase : 'null'} result=${uiB.result ? 'shown' : 'null'} locked=${await locked(pageB)} error=${uiB.error ?? '-'}`)

    const moveA = await canMove(pageA, 'A')
    const moveB = await canMove(pageB, 'B')

    check('A is not pinned in place by a finished duel', moveA.localMoved)
    check('B is not pinned in place by a finished duel', moveB.localMoved)
    check('the world server accepts A walking again', moveA.serverMoved)
    check('the world server accepts B walking again', moveB.serverMoved)
    check('A is out of the duel client-side', !uiA.duel)
    check('B is out of the duel client-side', !uiB.duel)
    check('A is no longer duel-locked', (await locked(pageA)) === false)
    check('B is no longer duel-locked', (await locked(pageB)) === false)
    // Not "is exploring": after a rematch the honest answer is `challenged`,
    // because the rematch invitation is real and pending. What must be gone is
    // the duel itself.
    const freeState = state => state === 'exploring' || state === 'challenged'
    check('the server no longer calls A a duellist', freeState(moveA.self?.state), moveA.self?.state)
    check('the server no longer calls B a duellist', freeState(moveB.self?.state), moveB.self?.state)

    await pageA.screenshot({ path: `${SHOTS}/duel-a-after-${EXIT}.png` })
    await pageB.screenshot({ path: `${SHOTS}/duel-b-after-${EXIT}.png` })

    /* ---- and a second duel is possible ------------------------------- */
    await standAt(pageA, FIELD_A.x, FIELD_A.z)
    await standAt(pageB, FIELD_B.x, FIELD_B.z)
    await pageA.evaluate(() => window.__wally.pvpClearError())
    await pvpSend(pageA, { t: 'challenge', playerId: idB, stake: 1 })
    const second = await until(async () => (await ui(pageB)).invite, 20_000)
    check('a second duel can be challenged after the first', Boolean(second),
      second ? '' : (await ui(pageA)).error ?? 'no invite and no reason')
  } finally {
    await browserA.close()
    await browserB.close()
  }

  console.log(
    failures.length === 0
      ? '\nBoth fighters left the duel and kept playing.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
