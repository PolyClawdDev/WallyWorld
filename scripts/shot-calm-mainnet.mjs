/* Screenshots of the mainnet code path after the alarm was calmed down.
 *
 * Point it at a build served with VITE_SOLANA_CLUSTER=mainnet-beta, otherwise
 * it is photographing the devnet branch and proves nothing.
 *
 * Usage: SHOT_TARGET=http://127.0.0.1:5199 node scripts/shot-calm-mainnet.mjs
 */

import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const TARGET = process.env.SHOT_TARGET ?? 'http://127.0.0.1:5199'
const SHOTS = 'screenshots/calm-mainnet'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Polls until `fn` returns something truthy or the deadline passes. No blind sleeps. */
async function until(fn, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, stepMs))
  }
}

const clickText = (page, text) =>
  page.evaluate(t => {
    const el = [...document.querySelectorAll('button, a')].find(n => n.textContent?.includes(t))
    el?.click()
    return !!el
  }, text)

/** React owns the input's value, so the native setter is the only way in. */
const typeIntoReact = (page, selector, value) =>
  page.evaluate((sel, v) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, selector, value)

const alarmProbe = () =>
  ({
    banner: !!document.querySelector('.mainnet-banner'),
    siren: !!document.querySelector('.funds-siren'),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent?.trim().slice(0, 60)),
    badge: document.querySelector('[data-funds-mode]')?.textContent?.trim() ?? null,
    mode: document.querySelector('[data-funds-mode]')?.getAttribute('data-funds-mode') ?? null,
    tooltip: document.querySelector('[data-funds-mode]')?.getAttribute('title') ?? null,
    /* Anything painted in the alarm ember, so a leftover red block cannot hide. */
    emberish: [...document.querySelectorAll('body *')]
      .filter(n => {
        const s = getComputedStyle(n)
        return /227,\s*94,\s*53/.test(s.backgroundColor) || /58,\s*17,\s*8/.test(s.backgroundColor)
      })
      .map(n => `${n.className || n.tagName}: ${n.textContent?.trim().slice(0, 50)}`),
  })

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    protocolTimeout: 180_000,
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    console.log(`Voxels · calm-mainnet screenshots\n  target ${TARGET}`)

    /* ------------------------------------------------------------ landing */
    await page.goto(TARGET, { waitUntil: 'networkidle0', timeout: 120_000 })
    const landingBadge = await until(() => page.evaluate(() => document.querySelector('[data-funds-mode]')?.getAttribute('data-funds-mode')), 30_000)
    const landing = await page.evaluate(alarmProbe)
    check('the build really is on the mainnet code path', landing.mode === 'live', String(landing.mode))
    check('landing badge reads MAINNET with nothing appended', landing.badge === 'MAINNET', String(landing.badge))
    check('no siren dot on the landing badge', !landing.siren)
    check('nothing on the landing screen is role="alert"', landing.alerts.length === 0, landing.alerts.join(' | '))
    check('no ember-red block on the landing screen', landing.emberish.length === 0, landing.emberish.join(' | '))
    console.log(`  tooltip: ${JSON.stringify(landing.tooltip)}`)
    await page.screenshot({ path: `${SHOTS}/1-landing.png` })

    /* ------------------------------------------------------------- entry */
    await clickText(page, 'Enter world')
    const nameReady = await until(() => page.$('#wayfinder-name'), 30_000)
    check('the character screen opened', !!nameReady)
    await typeIntoReact(page, '#wayfinder-name', 'Rowan')
    await page.screenshot({ path: `${SHOTS}/2-character-select.png` })

    await clickText(page, 'Continue with')
    await until(async () => (await clickText(page, 'Enter Voxels')) || null, 30_000)

    /* ------------------------------------------------------------- world */
    const canvasLit = await until(async () => {
      const state = await page.evaluate(() => {
        const c = document.querySelector('canvas')
        return c && c.width > 100 && !!document.querySelector('.topbar') ? { w: c.width, h: c.height } : null
      })
      return state
    }, 180_000, 1000)
    check('the world rendered with the HUD present', !!canvasLit, canvasLit ? `${canvasLit.w}x${canvasLit.h}` : 'never appeared')

    const world = await page.evaluate(() => {
      const probe = (() => {
        const el = document.querySelector('.topbar')
        return el ? Math.round(el.getBoundingClientRect().top) : null
      })()
      return { topbarTop: probe }
    })
    const worldAlarm = await page.evaluate(alarmProbe)
    check('no full-width mainnet banner across the world', !worldAlarm.banner)
    check('no siren in the HUD badge', !worldAlarm.siren)
    check('the HUD badge reads MAINNET', worldAlarm.badge === 'MAINNET', String(worldAlarm.badge))
    check('nothing in the world is role="alert"', worldAlarm.alerts.length === 0, worldAlarm.alerts.join(' | '))
    check('no ember-red block in the world', worldAlarm.emberish.length === 0, worldAlarm.emberish.join(' | '))
    // 52px was the banner's offset. Anything near the viewport top means no gap.
    check('the topbar is not offset for a banner that no longer exists', world.topbarTop !== null && world.topbarTop < 40, `top=${world.topbarTop}px`)
    await page.screenshot({ path: `${SHOTS}/3-world-hud.png` })

    /* ------------------------------------------------------ wallet panel */
    const panel = await until(async () => {
      if (await page.$('.sol-panel')) return true
      await page.keyboard.press('k')
      if (await page.$('.sol-panel')) return true
      await clickText(page, 'Wallet')
      return (await page.$('.sol-panel')) ? true : null
    }, 60_000, 1200)
    check('the wallet panel opened', !!panel)

    // The embedded block mounts its wallet on an effect, so wait for the text.
    await until(() => page.evaluate(() => /THIS BROWSER/.test(document.querySelector('.sol-panel')?.textContent ?? '')), 30_000)

    const panelState = await page.evaluate(() => {
      const root = document.querySelector('.sol-panel')
      const text = root?.textContent ?? ''
      return {
        text,
        banner: document.querySelector('.sol-banner')?.textContent ?? '',
        bannerClass: document.querySelector('.sol-banner')?.className ?? '',
        clusterTagClass: document.querySelector('.sol-block-head b')?.className ?? '',
        errors: [...document.querySelectorAll('.sol-panel .sol-error')].map(n => n.textContent?.trim().slice(0, 120)),
        popupText: document.querySelector('.popup')?.textContent ?? '',
      }
    })
    const panelAlarm = await page.evaluate(alarmProbe)
    console.log(`  panel banner: ${JSON.stringify(panelState.banner.slice(0, 160))}`)
    console.log(`  banner class: ${panelState.bannerClass} · cluster tag class: ${panelState.clusterTagClass}`)
    check('the panel banner is styled live-but-calm', /funds-live/.test(panelState.bannerClass))
    check('the cluster tag is no longer sol-bad-text', !/sol-bad-text/.test(panelState.clusterTagClass), panelState.clusterTagClass)
    check('the old "Do not fund it" mainnet paragraph is gone', !/Do not fund it/i.test(panelState.text))
    check('no red sol-error block in the panel', panelState.errors.length === 0, panelState.errors.join(' | '))
    check('nothing in the panel is role="alert"', panelAlarm.alerts.length === 0, panelAlarm.alerts.join(' | '))

    // The facts that had to survive.
    check('storage risk is still stated', /can read it/i.test(panelState.text) && /not a place for savings/i.test(panelState.text))
    check('it says the game never spends from the key', /never spends from it/i.test(panelState.text))
    check('irreversibility of an approved payment is still stated', /cannot be reversed/i.test(panelState.text))
    check('the seed-phrase assurance is intact', /never ask for a seed phrase/i.test(panelState.popupText))
    check('the DEMO — NO REAL FUNDS pouch label is untouched', /DEMO — NO REAL FUNDS/.test(panelState.popupText))
    check('the gold-to-tokens UNAVAILABLE explanation is intact', /UNAVAILABLE/.test(panelState.text), panelState.text.match(/.{0,40}UNAVAILABLE.{0,20}/)?.[0] ?? 'absent')

    await page.screenshot({ path: `${SHOTS}/4-wallet-panel.png` })

    /* The Solana panel sits below the pouch inside a scrolling popup body, so
       each part has to be brought into view before it can be photographed. */
    const scrollTo = selector =>
      page.evaluate(sel => {
        const body = document.querySelector('.popup-body')
        const target = document.querySelector(sel)
        if (!body || !target) return null
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12
        return Math.round(body.scrollTop)
      }, selector)

    await scrollTo('.sol-banner')
    await until(() => page.evaluate(() => {
      const r = document.querySelector('.sol-banner')?.getBoundingClientRect()
      return r && r.top > 0 && r.top < 400
    }), 10_000, 250)
    await page.screenshot({ path: `${SHOTS}/5-panel-network-banner.png` })

    await scrollTo('.sol-block')
    await until(() => page.evaluate(() => {
      const r = document.querySelector('.sol-block')?.getBoundingClientRect()
      return r && r.top > 0 && r.top < 400
    }), 10_000, 250)
    await page.screenshot({ path: `${SHOTS}/6-panel-embedded-wallet.png` })
  } finally {
    await browser.close()
  }

  console.log('')
  if (failed) {
    console.log(`CALM MAINNET: ${failed} failure(s)`)
    process.exit(1)
  }
  console.log('CALM MAINNET: all checks passed')
}

await main()
