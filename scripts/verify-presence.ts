/*
 * Two separate Chrome profiles enter the same town. Proves a remote
 * voxel character appears, not an NPC, after one player walks.
 *
 * Usage: npm run verify:presence
 */
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer'

const TARGET = process.env.UI_TARGET ?? 'http://127.0.0.1:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const clickText = async (page: Page, text: string) => {
  const ok = await page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(t)) as HTMLButtonElement | undefined
    if (el && !el.disabled) el.click()
    return Boolean(el && !el.disabled)
  }, text)
  await wait(800)
  return ok
}

async function enterWorld(page: Page, name: string) {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await wait(1500)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 30_000 })
  await page.evaluate(value => {
    const input = document.querySelector('#wayfinder-name') as HTMLInputElement | null
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, name)
  await clickText(page, 'Continue with')
  await wait(800)
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.player && !!window.__wally.pvp', { timeout: 120_000 })
  await page.waitForFunction('window.__wally.pvp().connected === true', { timeout: 30_000 })
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __wally: {
        player: { position: { x: number; z: number } }
        remotes: () => Array<{ playerId: string; x: number; z: number; targetX: number; targetZ: number; character: string }>
        pvp: () => { playerId: string | null; connected: boolean; others: Array<{ playerId: string; displayName: string; x: number; z: number; loadout: { character: string; level: number } }> }
      }
    }
    const pvp = w.__wally.pvp()
    return {
      playerId: pvp.playerId,
      connected: pvp.connected,
      x: w.__wally.player.position.x,
      z: w.__wally.player.position.z,
      others: pvp.others,
      remotes: w.__wally.remotes(),
    }
  })
}

async function walkTo(page: Page, x: number, z: number) {
  await page.evaluate((gx, gz) => {
    const w = window as unknown as { __wally: { player: { position: { set: (x: number, y: number, z: number) => void } }; battle?: { primaryClick?: (p: { x: number; y: number; z: number }, t: null) => void } } }
    w.__wally.player.position.set(gx, 0, gz)
    const click = w.__wally.battle?.primaryClick
    if (click) click({ x: gx + 4, y: 0, z: gz }, null)
  }, x, z)
}

async function launch(profile: string): Promise<Browser> {
  mkdirSync(profile, { recursive: true })
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 240_000,
    userDataDir: profile,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--window-size=1280,800',
    ],
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'wally-presence-'))
  const browserA = await launch(join(root, 'a'))
  const browserB = await launch(join(root, 'b'))
  const pageA = await browserA.newPage()
  const pageB = await browserB.newPage()
  pageA.setViewport({ width: 1280, height: 800 })
  pageB.setViewport({ width: 1280, height: 800 })

  const failures: string[] = []
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    await enterWorld(pageA, 'Ash')
    await enterWorld(pageB, 'Birch')

    const startA = await snapshot(pageA)
    const startB = await snapshot(pageB)
    check('A connected', startA.connected, startA.playerId ?? '')
    check('B connected', startB.connected, startB.playerId ?? '')
    check('different player ids', Boolean(startA.playerId && startB.playerId && startA.playerId !== startB.playerId))

    await walkTo(pageA, 12, 18)
    let seen = false
    let lastB = startB
    for (let i = 0; i < 40 && !seen; i++) {
      await wait(500)
      lastB = await snapshot(pageB)
      const remote = lastB.remotes.find(r => r.playerId === startA.playerId)
        ?? lastB.others.find(o => o.playerId === startA.playerId)
      if (remote && Math.hypot(remote.x - 12, ('z' in remote ? remote.z : 0) - 18) < 8) seen = true
      if (remote && 'targetX' in remote && Math.hypot(remote.targetX - 12, remote.targetZ - 18) < 6) seen = true
    }

    const otherOnB = lastB.others.find(o => o.playerId === startA.playerId)
    const meshOnB = lastB.remotes.find(r => r.playerId === startA.playerId)
    check('B lists A in presence', Boolean(otherOnB), otherOnB ? `${otherOnB.displayName} @ ${otherOnB.x.toFixed(1)},${otherOnB.z.toFixed(1)}` : `others=${lastB.others.length}`)
    check('B spawned a remote mesh for A', Boolean(meshOnB), meshOnB ? `${meshOnB.character} @ ${meshOnB.x.toFixed(1)},${meshOnB.z.toFixed(1)}` : '')
    check('remote is near where A walked', seen, meshOnB ? `mesh ${meshOnB.x.toFixed(1)},${meshOnB.z.toFixed(1)} target ${meshOnB.targetX.toFixed(1)},${meshOnB.targetZ.toFixed(1)}` : '')
    check('name is Ash, not an NPC label', otherOnB?.displayName === 'Ash', otherOnB?.displayName ?? '')
    check('A is not listed as an NPC id', !/LYRA|MIRA|VELLUM|townsperson/i.test(JSON.stringify(lastB)))
  } finally {
    await browserA.close()
    await browserB.close()
  }

  if (failures.length) {
    console.error(`\n${failures.length} failed`)
    process.exit(1)
  }
  console.log('\nTwo browsers saw each other in the shared town.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
