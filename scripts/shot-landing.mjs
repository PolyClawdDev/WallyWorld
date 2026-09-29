/* Screenshots the landing page so the wordmark can be looked at rather than
 * assumed. Takes a desktop and a narrow viewport, since the mark is sized in
 * viewport units and the mobile breakpoint overrides the cell size. */

import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5173'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.env.OUT ?? 'screenshots/landing'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
})

try {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['narrow', { width: 430, height: 880 }],
  ]) {
    const page = await browser.newPage()
    await page.setViewport(viewport)
    await page.goto(UI, { waitUntil: 'domcontentloaded' })
    // Poll for the wordmark blocks instead of guessing at a load time.
    await page.waitForSelector('.pixel-wordmark-grid i', { timeout: 30_000 })
    const report = await page.evaluate(() => {
      const grid = document.querySelector('.pixel-wordmark-grid')
      const first = grid?.querySelector('i')
      const label = document.querySelector('.pixel-wordmark-label')
      const box = grid?.getBoundingClientRect()
      const cell = first?.getBoundingClientRect()
      return {
        blocks: grid?.children.length ?? 0,
        accessibleName: label?.textContent ?? null,
        markWidth: box ? Math.round(box.width) : null,
        markHeight: box ? Math.round(box.height) : null,
        cell: cell ? `${cell.width.toFixed(2)}x${cell.height.toFixed(2)}` : null,
        overflowsViewport: box ? box.right > window.innerWidth : null,
        eyebrow: document.querySelector('.eyebrow')?.textContent ?? null,
        foot: document.querySelector('.entry-foot')?.textContent ?? null,
      }
    })
    console.log(name, JSON.stringify(report))
    await sleep(400)
    await page.screenshot({ path: `${OUT}-${name}.png` })
    await page.close()
  }
} finally {
  await browser.close()
}
