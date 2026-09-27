import puppeteer from 'puppeteer'

/* Checks the two seams the hunt shares with the rest of the app: the map popup
 * reading the exported hunting regions, and the cost the wildlife adds to a
 * frame. Also confirms the wallet panel still labels gold as demo-only. */

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await click('Enter the world')
await sleep(200)
await click('Continue with')
await sleep(250)
await click('Enter Wally World')
await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 25000 })
await sleep(1500)

const cost = await page.evaluate(() => {
  const info = window.__wally.renderer.info.render
  return { calls: info.calls, triangles: info.triangles }
})
console.log(`frame cost: ${cost.calls} draw calls, ${cost.triangles.toLocaleString()} triangles`)

await page.keyboard.press('m')
await sleep(900)
const map = await page.evaluate(() => {
  const popup = document.querySelector('.mp-seam')?.closest('*')
  return {
    seam: document.querySelector('.mp-seam')?.textContent ?? null,
    text: document.body.innerText.includes('WILDWOOD'),
    popupPresent: !!popup,
  }
})
console.log('map seam:', JSON.stringify(map))
await page.screenshot({ path: '/tmp/hunt-09-map.png' })
await page.keyboard.press('Escape')
await sleep(400)

await page.keyboard.press('k')
await sleep(700)
const wallet = await page.evaluate(() => document.body.innerText)
await page.screenshot({ path: '/tmp/hunt-10-wallet.png' })
console.log('wallet mentions demo:', /demo/i.test(wallet), '| mentions solana payout claim:', /payout (was|has been) (sent|made)/i.test(wallet))
console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no page errors')
await browser.close()
