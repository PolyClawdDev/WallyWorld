import puppeteer from 'puppeteer'

/* One framed screenshot of the hunt HUD in the field, for the record. */

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await click('Enter the world')
await sleep(200)
await click('Continue with')
await sleep(250)
await click('Enter Wally World')
await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 25000 })

// Stand east of the wildwood so the compass has to swing left of straight
// ahead, then hurt the player a little so the health bar is not full.
const where = await page.evaluate(async () => {
  const w = window.__wally
  const deer = w.wildlife.animals.find(a => a.species.id === 'REINDEER' && a.region.id === 'wildwood')
  w.player.position.set(deer.group.position.x + 5, 0, deer.group.position.z + 9)
  w.vitals.damage(34, null, 'BEAR', performance.now())
  await new Promise(r => setTimeout(r, 1200))
  return { hp: Math.round(w.vitals.hp), compass: Math.round(w.huntState.compassDegrees), metres: Math.round(w.huntState.compassDistance) }
})
// Put the cursor on the deer so the target plate and an ability are on screen.
await page.mouse.move(720, 470)
await sleep(300)
await page.mouse.click(720, 470)
await sleep(260)
await page.screenshot({ path: '/tmp/hunt-11-hud.png' })
console.log('hud shot:', JSON.stringify(where))
await browser.close()
