/*
 * One plate of the in-game map panel.
 *
 * The hunting grounds' real shape is hard to read off the world itself: the
 * region ground patches are within a few percent of the world ground's own
 * colour, so what the player actually sees the footprint on is this chart,
 * which traces `regionOutline` directly. So this is the plate that answers
 * "is the hunting area still a circle".
 *
 * Usage: UI=http://127.0.0.1:5262 node scripts/shot-map.mjs screenshots/green
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI ?? 'http://127.0.0.1:5251'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/art'

await fs.mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 980, deviceScaleFactor: 1 })

const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

await page.goto(UI, { waitUntil: 'domcontentloaded' })
await click('Enter world')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
  { timeout: 60_000 },
)
await page.evaluate(() => {
  const input = document.querySelector('#wayfinder-name')
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'PLATE')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await click('Continue with')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Enter Voxels')),
  { timeout: 60_000 },
)
await click('Enter Voxels')
// The map reads live animal positions, so wait for the wildlife to exist first.
await page.waitForFunction('!!window.__wally && !!window.__wally.wildlife && window.__wally.wildlife.animals.length > 0', {
  timeout: 180_000,
})

await click('Map')
await page.waitForFunction(() => !!document.querySelector('svg polygon'), { timeout: 60_000 })
// The chart is SVG, so it is complete as soon as React has committed it.
const popup = await page.$('.popup') ?? await page.$('svg')
const file = path.join(OUT, 'map-hunting-regions.png')
await popup.screenshot({ path: file })
console.log(`wrote ${file}`)

const regions = await page.evaluate(() =>
  [...document.querySelectorAll('svg polygon')]
    .map(p => (p.getAttribute('points') ?? '').split(' ').length)
    .filter(n => n > 20).length,
)
console.log(`polygons with more than 20 vertices on the chart: ${regions}`)
await browser.close()
