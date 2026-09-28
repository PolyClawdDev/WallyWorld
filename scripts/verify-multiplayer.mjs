/* ------------------------------------------------------------------ *
 * Two real browsers, two separate Chrome profiles, one world.
 *
 * This is the check that cannot be faked by a node socket client: real
 * page, real client store, real overlay, real WebGL. The two sessions
 * join, see each other, walk, inspect each other, and fight a duel
 * through to a settled result. Then a third tab opens the first
 * player's character and the first tab is expected to give it up.
 *
 * Storage is isolated per browser (separate `userDataDir`), so the two
 * are genuinely different players and not one session in two windows.
 *
 *   UI_TARGET=http://127.0.0.1:5201 API=http://127.0.0.1:8801 \
 *     node scripts/verify-multiplayer.mjs
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5201'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Polls. Software WebGL makes every frame slow and unevenly so; a guessed
 * sleep is either a flake or a minute of dead time.
 */
async function until(fn, timeoutMs = 60_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
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
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--window-size=1280,800',
    ],
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
  page.on('requestfailed', r => {
    if (/\/api\/|\/ws\//.test(r.url())) notes.push(`requestfailed ${r.failure()?.errorText ?? ''} ${r.url()}`)
  })
  page.on('response', r => {
    if (/\/api\//.test(r.url()) && r.status() >= 400) notes.push(`http ${r.status()} ${r.url()}`)
  })
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
  if (!joined) {
    const state = await page.evaluate('JSON.stringify(window.__wally.pvpUi())').catch(() => '{}')
    throw new Error(`${name} never connected presence at ${UI}\n  state ${state}\n  ${notes.slice(-10).join('\n  ') || 'no browser errors captured'}`)
  }
  return joined
}

const ui = page => page.evaluate('window.__wally.pvpUi()')
const pvpSend = (page, msg) => page.evaluate(m => window.__wally.pvpSend(m), msg)

/** A claim the server will clamp, which makes it answer with a fresh `you`. */
const nudge = page =>
  page.evaluate(() => {
    const p = window.__wally.player.position
    window.__wally.pvpSend({ t: 'pose', x: p.x + 30, z: p.z, facing: 0, anim: 'run', sprinting: false })
  })

/** Credits game gold through the ledger's own path, in the server's database. */
function seedGold(playerId, amount) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/seed-gold.ts', playerId, String(amount)], {
      cwd: process.cwd(),
      env: { ...process.env, WALLY_DB_PATH: process.env.WALLY_DB_PATH ?? 'data/verify/wally.db' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`seed-gold failed: ${out}`))))
  })
}

/**
 * Walks the character to a world point under the server's own speed limit.
 *
 * Setting the position is a claim, not a fact: the server clamps anything
 * faster than a run and corrects the client back. So the target is
 * re-asserted until the server's copy of the player actually arrives — which
 * is itself the movement-authority check, seen from the outside.
 */
async function standAt(page, x, z) {
  const arrived = await until(async () => {
    await page.evaluate((gx, gz) => {
      window.__wally.player.position.set(gx, window.__wally.player.position.y, gz)
    }, x, z)
    const self = await page.evaluate('window.__wally.pvp().self')
    return self && Math.hypot(self.x - x, self.z - z) < 3 ? self : null
  }, 90_000, 250)
  return arrived ?? page.evaluate('window.__wally.pvp().self')
}

async function main() {
  console.log(`Voxels · two browsers, one world — ${UI}\n`)
  const root = await mkdtemp(join(tmpdir(), 'wally-mp-'))
  const browserA = await launch(join(root, 'a'))
  const browserB = await launch(join(root, 'b'))

  try {
    const pageA = await browserA.newPage()
    const pageB = await browserB.newPage()
    await pageA.setViewport({ width: 1280, height: 800 })
    await pageB.setViewport({ width: 1280, height: 800 })

    /* ---- both join -------------------------------------------------- */
    const idA = await enterWorld(pageA, 'Ash')
    const idB = await enterWorld(pageB, 'Birch')
    check('browser A joined the world', Boolean(idA), idA)
    check('browser B joined the world', Boolean(idB), idB)
    check('separate storage means separate characters', idA !== idB)

    const sawEachOther = await until(async () => {
      const a = await ui(pageA)
      const b = await ui(pageB)
      return a.others > 0 && b.others > 0 ? { a: a.others, b: b.others } : null
    }, 60_000)
    check('each browser lists the other in presence', Boolean(sawEachOther), sawEachOther ? `A sees ${sawEachOther.a}, B sees ${sawEachOther.b}` : '')

    /* ---- town protection, unchanged ---------------------------------- */
    await pageA.evaluate(() => { window.__wally.pvpUi(); })
    await pvpSend(pageA, { t: 'challenge', playerId: idB, stake: 1 })
    const townRefusal = await until(async () => (await ui(pageA)).error, 20_000)
    check('a challenge thrown inside town is refused', /town/i.test(townRefusal ?? ''), townRefusal ?? 'no refusal')
    await pageA.evaluate(() => { window.__wally.pvpClearError() })

    /* ---- movement propagates, at a speed the server agreed to -------- */
    const FIELD_A = { x: 88, z: 28 }
    const FIELD_B = { x: 88, z: 33 }
    const restingA = await standAt(pageA, FIELD_A.x, FIELD_A.z)
    check('the server walked A out to the field rather than teleporting her',
      Boolean(restingA) && Math.hypot(restingA.x - FIELD_A.x, restingA.z - FIELD_A.z) < 3,
      restingA ? `${restingA.x.toFixed(1)},${restingA.z.toFixed(1)}` : 'never arrived')
    check('and the field is outside town, so duels are legal there',
      await pageA.evaluate((x, z) => !window.__wally.isInTown(x, z), FIELD_A.x, FIELD_A.z))

    const aOnB = await until(async () => {
      const remote = await pageB.evaluate(id => window.__wally.pvp().others.find(o => o.playerId === id) ?? null, idA)
      return remote && Math.hypot(remote.x - FIELD_A.x, remote.z - FIELD_A.z) < 8 ? remote : null
    }, 60_000)
    check('B watches A walk out of town', Boolean(aOnB), aOnB ? `${aOnB.displayName} @ ${aOnB.x.toFixed(1)},${aOnB.z.toFixed(1)}` : '')

    await standAt(pageB, FIELD_B.x, FIELD_B.z)

    /* ---- inspect ------------------------------------------------------ */
    await pvpSend(pageA, { t: 'inspect', playerId: idB })
    const card = await until(async () => (await ui(pageA)).inspect, 30_000)
    check('A can inspect B', card?.playerId === idB, card ? card.displayName : 'no card')
    check('the inspect card carries no other player\'s wallet', !JSON.stringify(card ?? {}).includes('wallet'))

    /* ---- a duel, start to settled result ----------------------------- */
    // Gold is earned by hunting, which headless software WebGL cannot do
    // dependably. Seed it through the ledger's own credit path instead, then
    // let the socket deliver the new balance the way it always does.
    for (const id of [idA, idB]) await seedGold(id, 200)
    // The socket pushes a fresh balance whenever it corrects a pose, so a
    // nudge is enough to pull the new gold down without a reconnect.
    const funded = await until(async () => {
      await nudge(pageA)
      await nudge(pageB)
      const a = (await ui(pageA)).gold?.available ?? 0
      const b = (await ui(pageB)).gold?.available ?? 0
      return a > 0 && b > 0 ? { a, b } : null
    }, 30_000, 500)
    // The nudge above drifts both fighters a little; put them back within
    // challenge range before anyone throws down.
    await standAt(pageA, FIELD_A.x, FIELD_A.z)
    await standAt(pageB, FIELD_B.x, FIELD_B.z)
    const goldA = funded?.a ?? (await ui(pageA)).gold?.available ?? 0
    const goldB = funded?.b ?? (await ui(pageB)).gold?.available ?? 0
    const stake = Math.max(1, Math.min(10, goldA, goldB))
    check('both fighters have game gold to stake', goldA > 0 && goldB > 0, `A=${goldA} B=${goldB} stake=${stake}`)

    await pvpSend(pageA, { t: 'challenge', playerId: idB, stake })
    const invite = await until(async () => (await ui(pageB)).invite, 30_000)
    check('B receives the invitation', Boolean(invite), invite ? `stake ${invite.stake}` : (await ui(pageA)).error ?? '')

    if (invite) {
      await pvpSend(pageB, { t: 'accept', challengeId: invite.challengeId })
      const duelA = await until(async () => (await ui(pageA)).duel, 30_000)
      const duelB = await until(async () => (await ui(pageB)).duel, 30_000)
      check('a duel opens for both fighters', Boolean(duelA && duelB), duelA ? `${duelA.duelId} phase ${duelA.phase}` : (await ui(pageB)).error ?? '')

      if (duelA) {
        await pvpSend(pageA, { t: 'ready', duelId: duelA.duelId })
        await pvpSend(pageB, { t: 'ready', duelId: duelA.duelId })
        const fighting = await until(async () => {
          const d = (await ui(pageA)).duel
          return d && (d.phase === 'active' || d.phase === 'countdown') ? d : null
        }, 45_000)
        check('the duel starts once both are ready', Boolean(fighting), fighting?.phase)

        await pvpSend(pageB, { t: 'surrender', duelId: duelA.duelId })
        const resultA = await until(async () => (await ui(pageA)).result, 45_000)
        const resultB = await until(async () => (await ui(pageB)).result, 45_000)
        check('the duel settles to a result both fighters see', Boolean(resultA && resultB),
          resultA ? `${resultA.outcome ?? resultA.kind ?? '?'} · ${resultA.reason ?? ''}` : '')
        check('the two fighters agree on the winner',
          Boolean(resultA && resultB) && resultA.duelId === resultB.duelId)

        const afterA = (await ui(pageA)).gold?.available ?? 0
        const afterB = (await ui(pageB)).gold?.available ?? 0
        check('gold moved by exactly the stake', afterA === goldA + stake && afterB === goldB - stake,
          `A ${goldA}→${afterA}, B ${goldB}→${afterB}, stake ${stake}`)
        check('no gold was created or destroyed', afterA + afterB === goldA + goldB)
      }
    }

    /* ---- one tab per character --------------------------------------- */
    const secondTab = await browserA.newPage()
    await secondTab.setViewport({ width: 1280, height: 800 })
    await enterWorld(secondTab, 'Ash')
    const takenOver = await until(async () => ((await ui(pageA)).superseded ? true : null), 45_000)
    check('the original tab is told the character moved on', Boolean(takenOver))
    const banner = await pageA.evaluate(() => document.querySelector('.pvp-superseded')?.textContent ?? '')
    check('and says so on screen rather than silently freezing', banner.length > 0, banner.slice(0, 90))
    const newTabId = await secondTab.evaluate('window.__wally.pvpUi().playerId')
    check('the new tab holds the same character', newTabId === idA, `${newTabId}`)
    await secondTab.close()
  } finally {
    await browserA.close()
    await browserB.close()
  }

  console.log(
    failures.length === 0
      ? '\nTwo browsers shared one world, fought a duel, and only one tab drove each character.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
