import puppeteer from 'puppeteer'

/* Frames the wildwood signpost head-on to check the lettering is unobstructed. */

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await click('Enter the world')
await sleep(250)
await click('Continue with')
await sleep(300)
await click('Enter Wally World')
await page.waitForFunction('!!window.__wally', { timeout: 25000 })
await sleep(1200)

// Camp sign sits at (-48.4, -38.6) facing yaw atan2(13, 16).
const info = await page.evaluate(async () => {
  const w = window.__wally
  const yaw = Math.atan2(13, 16)
  const sx = -48.4
  const sz = -38.6
  const dist = 4.6
  // Stand off to one side of the board so the player does not cover the text.
  const tx = Math.cos(yaw)
  const tz = -Math.sin(yaw)
  const px = sx + Math.sin(yaw) * dist + tx * 3.2
  const pz = sz + Math.cos(yaw) * dist + tz * 3.2
  // The render loop can move the player, so hold the position while the camera catches up.
  const hold = setInterval(() => w.player.position.set(px, 0, pz), 16)
  await new Promise(r => setTimeout(r, 14000))
  clearInterval(hold)
  return {
    wanted: [px, pz].map(n => +n.toFixed(2)),
    player: w.player.position.toArray().map(n => +n.toFixed(2)),
    cam: w.camera.position.toArray().map(n => +n.toFixed(2)),
  }
})
await sleep(200)
await page.screenshot({ path: '/tmp/sign-fixed.png' })
console.log(info)
await browser.close()
