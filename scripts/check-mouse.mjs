/**
 * Does the mouse actually drive the game? Measures wheel zoom and
 * right-click-to-move against a running dev server, using real dispatched
 * events on the canvas rather than the probe's own helpers, so the listeners
 * and their options are what is under test.
 */
import puppeteer from 'puppeteer'

const TARGET = process.env.TARGET ?? 'http://127.0.0.1:5173'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1440,900'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('pageerror', e => console.log('  page error:', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('  console error:', m.text().slice(0, 160)) })

await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 60000 })

/* Walk the whole entry flow: landing, then the character screen (which gates
 * its button on a name), then the world. Each step is retried because the
 * software renderer makes the transitions slow. */
await wait(2500)
for (let step = 0; step < 8; step++) {
  const done = await page.evaluate(() => !!window.__wally)
  if (done) break
  const what = await page.evaluate(() => {
    const input = document.querySelector('#wayfinder-name') ?? document.querySelector('input[type="text"]')
    if (input && !input.value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'TESTER')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed a name'
    }
    const hit = [...document.querySelectorAll('button')]
      .filter(b => !b.disabled)
      .find(b => /enter|begin|start|world|continue|confirm/i.test(b.textContent ?? ''))
    if (!hit) return 'nothing clickable'
    hit.click()
    return `clicked "${hit.textContent?.trim()}"`
  })
  console.log(`  entry step ${step + 1}: ${what}`)
  await wait(2500)
}
// Software WebGL builds the town slowly; poll rather than guess a duration.
let ready = false
for (let i = 0; i < 40; i++) {
  await wait(1500)
  ready = await page.evaluate(() => !!window.__wally)
  if (ready) { console.log(`__wally appeared after ~${((i + 1) * 1.5).toFixed(1)}s`); break }
}
if (!ready) {
  await page.screenshot({ path: '/tmp/mouse-stuck.png' })
  console.log('stuck — screenshot at /tmp/mouse-stuck.png')
  console.log(await page.evaluate(() => document.body.innerText.slice(0, 400)))
}
check('the world loaded and exposed __wally', ready)
if (!ready) { await browser.close(); process.exit(1) }

/* ----------------------------------------------------------- wheel zoom */
console.log('\nWheel zoom')
const before = await page.evaluate(() => window.__wally.camState())
await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
})
await wait(1200)
const afterOut = await page.evaluate(() => window.__wally.camState())
check('wheel down raises zoomWanted (pull back)', afterOut.zoomWanted > before.zoomWanted + 0.1,
  `${before.zoomWanted.toFixed(2)} -> ${afterOut.zoomWanted.toFixed(2)}`)
check('the camera actually chases it', Math.abs(afterOut.zoom - before.zoom) > 0.05,
  `zoom ${before.zoom.toFixed(2)} -> ${afterOut.zoom.toFixed(2)}`)

await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  for (let i = 0; i < 4; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
})
await wait(1200)
const afterIn = await page.evaluate(() => window.__wally.camState())
check('wheel up lowers zoomWanted (push in)', afterIn.zoomWanted < afterOut.zoomWanted - 0.1,
  `${afterOut.zoomWanted.toFixed(2)} -> ${afterIn.zoomWanted.toFixed(2)}`)

/* -------------------------------------------------- right-click to move */
console.log('\nRight-click to move')
const start = await page.evaluate(() => {
  const p = window.__wally.player.position
  return { x: p.x, z: p.z, keyboardMove: window.__wally.camState().keyboardMove }
})
check('keyboard movement is off by default', start.keyboardMove === false, `keyboardMove=${start.keyboardMove}`)

// Click a point on the ground ahead of the player, in the lower middle of the
// screen where open ground reliably is.
await page.evaluate(() => {
  const canvas = document.querySelector('canvas')
  const r = canvas.getBoundingClientRect()
  const x = r.left + r.width * 0.5
  const y = r.top + r.height * 0.66
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }
  canvas.dispatchEvent(new MouseEvent('mousemove', { ...opts, button: 0, buttons: 0 }))
  canvas.dispatchEvent(new MouseEvent('mousedown', opts))
  canvas.dispatchEvent(new MouseEvent('mouseup', opts))
})
await wait(4000)
const moved = await page.evaluate(() => {
  const p = window.__wally.player.position
  return { x: p.x, z: p.z }
})
const dist = Math.hypot(moved.x - start.x, moved.z - start.z)
check('the player walked towards the click', dist > 0.5,
  `moved ${dist.toFixed(2)} units, (${start.x.toFixed(1)}, ${start.z.toFixed(1)}) -> (${moved.x.toFixed(1)}, ${moved.z.toFixed(1)})`)

await page.screenshot({ path: '/tmp/mouse-check.png' })
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failed`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
