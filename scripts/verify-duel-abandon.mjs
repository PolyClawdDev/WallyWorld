/* ------------------------------------------------------------------ *
 * The two ways a duel can be walked away from, tested with real clients.
 *
 * 1. LOSING FOCUS. Duel movement is not a held key, it is a standing
 *    order on the server: "walk to this point", "keep swinging". Nothing
 *    expires either of them. So a fighter who alt-tabs, or opens a panel,
 *    or answers a message, used to leave their wizard walking and
 *    attacking on its own — a latched input in the one place it costs
 *    gold. The tab is genuinely hidden here (a second tab is brought to
 *    the front, which is a real `visibilitychange`), not faked with a
 *    synthetic event.
 *
 * 2. THE OPPONENT VANISHING. One browser is closed outright, mid-fight.
 *    The survivor must be shown that the connection is in its grace
 *    window, must be released when it runs out, and must then be able to
 *    walk away. Nobody may be left standing in a ring waiting for
 *    somebody who is never coming back.
 *
 *   UI_TARGET=http://127.0.0.1:5211 node scripts/verify-duel-abandon.mjs
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5211'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOTS = process.env.SHOT_DIR ?? 'screenshots'
// `screenshots/` is gitignored, so it is absent in a fresh checkout and the
// run would otherwise die on the first capture — after the duel, with both
// browsers still open and nothing reported.
mkdirSync(SHOTS, { recursive: true })

/** Matches `RECONNECT_GRACE_MS` in `src/shared/pvp.ts`. */
const GRACE_MS = 15_000

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
  if (!joined) throw new Error(`${name} never connected at ${UI}`)
  return joined
}

const ui = page => page.evaluate('window.__wally.pvpUi()')
const pvpSend = (page, msg) => page.evaluate(m => window.__wally.pvpSend(m), msg)

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

async function standAt(page, x, z) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const self = await page.evaluate('window.__wally.pvp().self')
    if (!self) { await sleep(250); continue }
    const gap = Math.hypot(self.x - x, self.z - z)
    if (gap < 2) return self
    const step = Math.min(8, gap)
    await page.evaluate((gx, gz) => {
      window.__wally.player.position.set(gx, window.__wally.player.position.y, gz)
    }, self.x + ((x - self.x) / gap) * step, self.z + ((z - self.z) / gap) * step)
    await sleep(350)
  }
  return page.evaluate('window.__wally.pvp().self')
}

/** Where the simulation says this client's own fighter is standing. */
const myFighter = async page => {
  const state = await ui(page)
  if (!state.duel) return null
  return state.duel.a.playerId === state.playerId ? state.duel.a : state.duel.b
}

async function openDuel(pageA, pageB, idA, idB) {
  const SEED = 200
  const openingA = (await ui(pageA)).gold?.available ?? 0
  const openingB = (await ui(pageB)).gold?.available ?? 0
  for (const id of [idA, idB]) await seedGold(id, SEED)
  await until(async () => {
    const a = (await ui(pageA)).gold?.available ?? 0
    const b = (await ui(pageB)).gold?.available ?? 0
    return a >= openingA + SEED && b >= openingB + SEED
  }, 30_000, 500)

  await standAt(pageA, 88, 28)
  await standAt(pageB, 88, 33)
  await pvpSend(pageA, { t: 'challenge', playerId: idB, stake: 10 })
  const invite = await until(async () => (await ui(pageB)).invite, 30_000)
  if (!invite) throw new Error(`no invite: ${(await ui(pageA)).error ?? 'no reason given'}`)
  await pvpSend(pageB, { t: 'accept', challengeId: invite.challengeId })
  const duel = await until(async () => (await ui(pageA)).duel, 30_000)
  if (!duel) throw new Error('no duel opened')
  await pvpSend(pageA, { t: 'ready', duelId: duel.duelId })
  await pvpSend(pageB, { t: 'ready', duelId: duel.duelId })
  const active = await until(async () => {
    const d = (await ui(pageA)).duel
    return d && d.phase === 'active' ? d : null
  }, 45_000)
  if (!active) throw new Error('duel never went active')
  return active
}

async function main() {
  console.log(`Voxels · losing focus and losing an opponent — ${UI}\n`)
  const root = await mkdtemp(join(tmpdir(), 'wally-abandon-'))
  const browserA = await launch(join(root, 'a'))
  let browserB = await launch(join(root, 'b'))

  try {
    const pageA = await browserA.newPage()
    let pageB = await browserB.newPage()
    await pageA.setViewport({ width: 1280, height: 800 })
    await pageB.setViewport({ width: 1280, height: 800 })
    const idA = await enterWorld(pageA, 'Ash')
    const idB = await enterWorld(pageB, 'Birch')
    check('two profiles, two players', idA !== idB)

    /* ---- 1. a standing order must not outlive the player's attention -- */
    const duel = await openDuel(pageA, pageB, idA, idB)
    check('a duel is under way', duel.phase === 'active')

    // The control first, because a check that nothing moved is worthless
    // unless the same measurement can see movement. Same order, same window,
    // tab in front: this has to drift, or the one below proves nothing.
    await pvpSend(pageA, { t: 'input', duelId: duel.duelId, seq: 1, kind: 'move', x: 88, z: 40 })
    const controlStart = await myFighter(pageA)
    await sleep(1800)
    const controlEnd = await myFighter(pageA)
    const controlDrift = controlStart && controlEnd
      ? Math.hypot(controlEnd.x - controlStart.x, controlEnd.z - controlStart.z)
      : -1
    check('a walk order does move the fighter while the tab is watched', controlDrift > 1.5,
      `moved ${controlDrift.toFixed(2)}m in 1.8s`)

    // A long walk across the ring, then the tab is hidden part way through it.
    await pvpSend(pageA, { t: 'input', duelId: duel.duelId, seq: 2, kind: 'move', x: 79, z: 20 })
    await sleep(500)
    const walking = await myFighter(pageA)
    const distractor = await browserA.newPage()
    await distractor.goto('about:blank')
    await distractor.bringToFront()
    const hidden = await pageA.evaluate('document.hidden')
    check('the fighting tab really is hidden, not pretending to be', hidden === true, String(hidden))
    await sleep(1800)
    const afterBlur = await myFighter(pageA)
    const drift = walking && afterBlur ? Math.hypot(afterBlur.x - walking.x, afterBlur.z - walking.z) : -1
    check('the walk order is released when the tab loses focus', drift >= 0 && drift < 1.5,
      `moved ${drift.toFixed(2)}m in 1.8s after being hidden`)
    await pageA.bringToFront()
    await distractor.close()

    /* ---- 2. the opponent vanishes mid-fight -------------------------- */
    const beforeGoldA = (await ui(pageA)).gold?.available ?? 0
    await browserB.close()
    const graceShown = await until(async () => {
      const state = await ui(pageA)
      return state.duel?.reconnectUntilMs ? state.duel : null
    }, 20_000, 250)
    check('the survivor is shown that a reconnect window is open', Boolean(graceShown))
    const graceBanner = await pageA.evaluate(() => document.querySelector('.pvp-duel-meta')?.textContent ?? '')
    check('and told so on screen', /reconnect/i.test(graceBanner), graceBanner.trim().slice(0, 80))
    await pageA.screenshot({ path: `${SHOTS}/duel-grace-window.png` })

    const resolved = await until(async () => (await ui(pageA)).result, GRACE_MS + 20_000, 500)
    check('the duel resolves itself once the window runs out', Boolean(resolved),
      resolved ? `${resolved.kind} · ${resolved.reason}` : 'nothing arrived')
    check('the survivor is awarded the win rather than left waiting',
      resolved?.kind === 'victory' && resolved?.winnerId === idA, resolved?.kind)

    const freed = await until(async () => {
      const state = await ui(pageA)
      return state.duel === null ? state : null
    }, 20_000, 250)
    check('the survivor is out of the duel', Boolean(freed))

    const startAt = await pageA.evaluate(() => {
      const p = window.__wally.player.position
      return { x: p.x, z: p.z }
    })
    await pageA.evaluate(() => {
      const p = window.__wally.player.position
      p.set(p.x + 6, p.y, p.z)
    })
    await sleep(800)
    const walkedAway = await pageA.evaluate(() => {
      const p = window.__wally.player.position
      return { x: p.x, z: p.z }
    })
    check('and can walk away from the ring',
      Math.hypot(walkedAway.x - startAt.x, walkedAway.z - startAt.z) > 1,
      `${startAt.x.toFixed(1)},${startAt.z.toFixed(1)} -> ${walkedAway.x.toFixed(1)},${walkedAway.z.toFixed(1)}`)
    const selfAfter = await pageA.evaluate('window.__wally.pvp().self')
    check('the world server agrees they are exploring again', selfAfter?.state === 'exploring', selfAfter?.state)

    // `beforeGoldA` was read mid-duel, with this player's own stake already in
    // escrow. A win releases that stake and adds the opponent's, so available
    // rises by the whole pot, and nothing may be left reserved.
    const goldAfter = (await ui(pageA)).gold
    check('the forfeit paid the pot and nothing is still escrowed',
      (goldAfter?.available ?? 0) === beforeGoldA + 20 && (goldAfter?.reserved ?? -1) === 0,
      `${beforeGoldA} -> ${goldAfter?.available}, reserved ${goldAfter?.reserved}`)
    await pageA.screenshot({ path: `${SHOTS}/duel-opponent-vanished.png` })

    /* ---- 3. and the one who dropped is not stuck when they return ---- */
    browserB = await launch(join(root, 'b'))
    pageB = await browserB.newPage()
    await pageB.setViewport({ width: 1280, height: 800 })
    await enterWorld(pageB, 'Birch')
    const backUi = await ui(pageB)
    check('the returning player is not put back into the finished duel', !backUi.duel,
      backUi.duel ? backUi.duel.phase : 'no duel')
    const backSelf = await pageB.evaluate('window.__wally.pvp().self')
    check('and is exploring, not duelling', backSelf?.state === 'exploring', backSelf?.state)
    await pageB.screenshot({ path: `${SHOTS}/duel-dropout-returned.png` })
  } finally {
    await browserA.close()
    try { await browserB.close() } catch { /* already closed by the test */ }
  }

  console.log(
    failures.length === 0
      ? '\nNo standing order outlived the tab, and nobody was left in a ring.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
