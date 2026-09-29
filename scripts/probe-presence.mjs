/* ------------------------------------------------------------------ *
 * What the presence socket actually does, in a real browser.
 *
 * Prints the URL the client built, whether the handshake completed, every
 * frame in both directions, and the chip the player would be reading.
 *
 *   UI_TARGET=http://127.0.0.1:5221 node scripts/probe-presence.mjs
 * ------------------------------------------------------------------ */

import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5221'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const NAME = process.env.NAME ?? 'Probe'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(fn, timeoutMs = 60_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // A sibling saving a source file makes the dev server push a full reload,
    // which destroys the execution context mid-evaluate. That is noise here,
    // not a result, so it is waited out rather than thrown.
    const value = await fn().catch(() => null)
    if (value) return value
    await sleep(stepMs)
  }
  return null
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

const root = process.env.PROFILE ?? (await mkdtemp(join(tmpdir(), 'wally-probe-')))
mkdirSync(root, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300_000,
  userDataDir: join(root, 'profile'),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,800'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  const log = []
  const say = line => {
    log.push(line)
    console.log(line)
  }

  const cdp = await page.target().createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.webSocketCreated', e => say(`WS created  ${e.url}`))
  cdp.on('Network.webSocketHandshakeResponseReceived', e =>
    say(`WS handshake ${e.response.status} ${e.response.statusText}`),
  )
  cdp.on('Network.webSocketFrameSent', e => say(`WS  ->  ${e.response.payloadData.slice(0, 200)}`))
  cdp.on('Network.webSocketFrameReceived', e => say(`WS  <-  ${e.response.payloadData.slice(0, 300)}`))
  cdp.on('Network.webSocketFrameError', e => say(`WS  !!  ${e.errorMessage}`))
  cdp.on('Network.webSocketClosed', () => say('WS closed'))

  page.on('pageerror', e => say(`pageerror ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') say(`console ${m.text()}`)
  })
  page.on('requestfailed', r => {
    if (/\/api\/|\/ws\//.test(r.url())) say(`requestfailed ${r.failure()?.errorText ?? ''} ${r.url()}`)
  })
  page.on('response', r => {
    if (/\/api\//.test(r.url())) say(`http ${r.status()} ${r.request().method()} ${r.url()}`)
  })

  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  // Plants exactly the state the bug report describes: a stored session token
  // that looks perfectly valid to the browser and means nothing to the server.
  if (process.env.POISON) {
    await page.evaluate(() => {
      localStorage.setItem(
        'wally-guest-session-v1',
        JSON.stringify({ token: 'a'.repeat(43), expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000, guest: true }),
      )
    })
    say('planted a session token the server has never seen')
    await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  }
  await sleep(1200)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  await page.evaluate(value => {
    const input = document.querySelector('#wayfinder-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, NAME)
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.pvpUi', { timeout: 180_000 })
  say('--- in the world ---')

  const connected = await until(
    () => page.evaluate('window.__wally.pvpUi().connected === true ? window.__wally.pvpUi().playerId : null'),
    Number(process.env.WAIT_MS ?? 30_000),
  )
  say(`connected: ${connected ?? 'NO'}`)
  say(`pvpUi: ${await page.evaluate('JSON.stringify(window.__wally.pvpUi())')}`)

  const chip = await page.evaluate(() =>
    [...document.querySelectorAll('.pvp-chip, .pvp-chip *')]
      .filter(el => el.children.length === 0 && (el.textContent ?? '').trim())
      .map(el => el.textContent.trim())
      .slice(0, 10),
  )
  say(`on-screen chip text: ${JSON.stringify(chip)}`)
  say(`localStorage: ${await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort()))}`)

  await page.screenshot({ path: process.env.SHOT ?? '/tmp/presence-probe.png' })
  say(`screenshot ${process.env.SHOT ?? '/tmp/presence-probe.png'}`)

  // Proves the offline chip's one action is real: the API is brought back
  // during this window, and the button has to get the player into the world.
  if (!connected && process.env.RECOVER) {
    const back = await until(async () => {
      await clickText(page, 'Try again now')
      return page.evaluate('window.__wally.pvpUi().connected === true ? window.__wally.pvpUi().playerId : null')
    }, Number(process.env.RECOVER), 3_000)
    say(`after "Try again now": ${back ?? 'still offline'}`)
    say(`pvpUi: ${await page.evaluate('JSON.stringify(window.__wally.pvpUi().link)')}`)
    await page.screenshot({ path: process.env.SHOT2 ?? '/tmp/presence-recovered.png' })
    say(`screenshot ${process.env.SHOT2 ?? '/tmp/presence-recovered.png'}`)
    if (back) process.exitCode = 0
  }

  if (!connected) process.exitCode = 1
} finally {
  await browser.close()
}
