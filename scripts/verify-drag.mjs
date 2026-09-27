import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'
import { serveDist } from './serve-dist.mjs'

/**
 * Checks the two things the shared popup shell now promises: panels are small
 * enough to sit beside the world, and they can be moved by their banner without
 * breaking the pouch's own item drag or escaping the viewport.
 */
const shots = process.env.SHOTS ?? '/tmp/wally-drag'
mkdirSync(shots, { recursive: true })
const site = process.env.BASE ? { base: process.env.BASE, close: async () => {} } : await serveDist()

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => {
  if (message.type() !== 'error') return
  if ((message.location().url ?? '').includes('favicon')) return
  errors.push(`console: ${message.text()}`)
})
page.on('response', response => { if (response.status() >= 400 && !response.url().includes('favicon')) errors.push(`http ${response.status()} ${response.url()}`) })

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`) }
const clickText = async text => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)), text)
  await handle.asElement().click()
  await wait(350)
}
const key = async k => { await page.keyboard.press(k); await wait(380) }
const rect = () => page.$eval('.popup', el => {
  const box = el.getBoundingClientRect()
  return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }
})
const banner = () => page.$eval('.popup-banner', el => {
  const box = el.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
})
/** Drags the banner by a delta and returns the frame rect afterwards. */
const dragBanner = async (dx, dy) => {
  const from = await banner()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 })
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 })
  await page.mouse.up()
  await wait(140)
  return rect()
}
const inside = box => box.x >= 0 && box.y >= 0 && box.x + box.w <= 1440 && box.y + box.h <= 900
/** The chase camera lerps; screen coordinates only mean anything once it stops. */
const settle = () => page.waitForFunction(() => {
  const { x, z } = window.__wally.camera.position
  const last = window.__settle
  window.__settle = { x, z }
  return last && Math.abs(last.x - x) < 0.004 && Math.abs(last.z - z) < 0.004
}, { polling: 100, timeout: 8000 })

await page.evaluateOnNewDocument(() => localStorage.clear())
await page.goto(`${site.base}/`, { waitUntil: 'networkidle0' })
await clickText('Enter the world')
await clickText('Continue with')
await clickText('Enter Wally World')
await page.waitForFunction('!!window.__wally', { timeout: 20000 })
await wait(1200)

/* ---- the pouch is pocket sized ---------------------------------------- */
await key('k')
const opened = await rect()
const slot = await page.$eval('.pouch-slot', el => Math.round(el.getBoundingClientRect().width))
check('pouch frame is small', opened.w <= 400 && opened.h <= 720, `${opened.w}×${opened.h}`)
check('pouch covers little of the screen', (opened.w * opened.h) / (1440 * 900) < 0.22, `${Math.round((opened.w * opened.h) / (1440 * 900) * 100)}% of viewport`)
check('slots stay comfortably clickable', slot >= 44, `${slot}px slots`)
check('grid still has 20 slots', (await page.$$('.pouch-slot')).length === 20)
check('backdrop is a light veil, not a blackout', await page.$eval('.popup-backdrop', el => {
  const alpha = Number((getComputedStyle(el).backgroundColor.match(/[\d.]+\)$/) || ['1)'])[0].slice(0, -1))
  return alpha <= 0.35
}))
await page.screenshot({ path: `${shots}/01-pouch-small.png` })

/* ---- dragging the banner moves the frame ------------------------------ */
const moved = await dragBanner(-420, -80)
check('banner drag moves the pouch', Math.abs(moved.x - (opened.x - 420)) <= 2 && Math.abs(moved.y - (opened.y - 80)) <= 2, `${moved.x},${moved.y} from ${opened.x},${opened.y}`)
check('dragging selects no text', await page.evaluate(() => String(window.getSelection()) === ''))
check('grab cursor advertises the handle', await page.$eval('.popup-banner', el => getComputedStyle(el).cursor === 'grab'))
await page.screenshot({ path: `${shots}/02-pouch-moved.png` })

/* ---- it cannot be thrown off the screen ------------------------------- */
const upLeft = await dragBanner(-3000, -3000)
check('clamped at the top left corner', inside(upLeft), `${upLeft.x},${upLeft.y}`)
const downRight = await dragBanner(4000, 4000)
check('clamped at the bottom right corner', inside(downRight), `${downRight.x},${downRight.y} ${downRight.w}×${downRight.h}`)
await page.screenshot({ path: `${shots}/03-pouch-clamped.png` })

/* ---- a drag that ends outside the window still lets go ---------------- */
const before = await rect()
const handle = await banner()
await page.mouse.move(handle.x, handle.y)
await page.mouse.down()
await page.mouse.move(handle.x - 200, handle.y - 60, { steps: 5 })
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })))
await page.mouse.move(handle.x - 600, handle.y - 300, { steps: 5 })
await page.mouse.up()
const afterCancel = await rect()
check('a lost pointer releases the panel', afterCancel.x === before.x - 200, `${afterCancel.x},${afterCancel.y} from ${before.x},${before.y}`)

/* ---- item drag still works and does not move the window --------------- */
await dragBanner(-260, 40)
const parked = await rect()
const placements = [[18, 0, 26], [22, 0, 30], [14, 0, 22], [26, 0, 36], [12, 0, 18]]
let aim = null
for (const spot of placements) {
  await page.evaluate(p => window.__wally.player.position.set(...p), spot)
  await settle()
  aim = await page.evaluate(() => {
    const camera = window.__wally.camera
    const Vector3 = camera.position.constructor
    const point = new Vector3(3.5, 1.2, 5.2).project(camera)
    const x = (point.x * 0.5 + 0.5) * window.innerWidth
    const y = (-point.y * 0.5 + 0.5) * window.innerHeight
    const frame = document.querySelector('.popup').getBoundingClientRect()
    const overFrame = x > frame.left - 8 && x < frame.right + 8 && y > frame.top - 8 && y < frame.bottom + 8
    return { x, y, overFrame, onScreen: x > 4 && y > 4 && x < window.innerWidth - 4 && y < window.innerHeight - 4 && point.z < 1 }
  })
  if (aim.onScreen && !aim.overFrame) break
}
check('MIRA is on screen clear of the moved pouch', aim.onScreen && !aim.overFrame, `x=${Math.round(aim.x)} y=${Math.round(aim.y)}`)
/** Where MIRA projects on screen right now. */
const aimNow = () => page.evaluate(() => {
  const camera = window.__wally.camera
  const Vector3 = camera.position.constructor
  const point = new Vector3(3.5, 1.2, 5.2).project(camera)
  return { x: (point.x * 0.5 + 0.5) * window.innerWidth, y: (-point.y * 0.5 + 0.5) * window.innerHeight }
})
const stack = await page.evaluate(() => {
  const found = [...document.querySelectorAll('.pouch-slot')].find(s => (s.getAttribute('aria-label') || '').includes('SOL Coin'))
  const box = found.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
})
await page.mouse.move(stack.x, stack.y)
await page.mouse.down()
await page.mouse.move((stack.x + aim.x) / 2, (stack.y + aim.y) / 2, { steps: 6 })
for (let pass = 0; pass < 3; pass += 1) {
  const live = await aimNow()
  await page.mouse.move(live.x, live.y, { steps: 4 })
  await wait(120)
}
const midDrag = await rect()
check('dragging a stack does not move the window', midDrag.x === parked.x && midDrag.y === parked.y, `${midDrag.x},${midDrag.y} vs ${parked.x},${parked.y}`)
const hint = await page.$eval('.pouch-hint', el => el.textContent)
await page.screenshot({ path: `${shots}/04-stack-drag.png` })
await page.mouse.up()
await wait(500)
const gave = await page.evaluate(() => ({ toast: (document.querySelector('.toast') || {}).textContent ?? '', gifts: [...document.querySelectorAll('.pouch-gift')].map(g => g.textContent) }))
check('the stack drag still reaches the NPC', /GIVE TO MIRA/.test(hint) && /MIRA accepted/.test(gave.toast), `${hint.trim()} · ${gave.toast.trim()}`)
check('the gift is logged in the pouch', gave.gifts.some(g => /MIRA/.test(g)), gave.gifts.join(' | '))
await page.screenshot({ path: `${shots}/05-after-give.png` })

/* ---- position is remembered for the session --------------------------- */
await key('Escape')
check('Escape still closes the pouch', (await page.$('.popup')) === null)
await key('k')
const reopened = await rect()
check('the pouch reopens where it was left', reopened.x === parked.x && reopened.y === parked.y, `${reopened.x},${reopened.y}`)

/* ---- a smaller window pulls panels back in ---------------------------- */
await dragBanner(600, 260)
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 })
await wait(400)
const shrunk = await page.$eval('.popup', el => {
  const box = el.getBoundingClientRect()
  return { ok: box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight, x: Math.round(box.left), y: Math.round(box.top) }
})
check('resizing pulls the panel back on screen', shrunk.ok, `${shrunk.x},${shrunk.y} in 900×700`)
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await wait(400)
await key('Escape')

/* ---- every panel drags the same way ----------------------------------- */
for (const [name, shortcut] of [['map', 'm'], ['journal', 'j'], ['settings', 'o']]) {
  await key(shortcut)
  const start = await rect()
  const dx = -Math.min(150, start.x - 12)
  const dy = -Math.min(110, start.y - 12)
  const shifted = await dragBanner(dx, dy)
  check(`${name} drags by its banner`, Math.abs(shifted.x - (start.x + dx)) <= 2 && Math.abs(shifted.y - (start.y + dy)) <= 2, `${shifted.x},${shifted.y} moved ${dx},${dy} (${shifted.w}×${shifted.h})`)
  const body = await page.evaluate(() => {
    const frame = document.querySelector('.popup').getBoundingClientRect()
    return { x: frame.left + frame.width / 2, y: frame.bottom - 24 }
  })
  await page.mouse.move(body.x, body.y)
  await page.mouse.down()
  await page.mouse.move(body.x + 120, body.y - 80, { steps: 6 })
  await page.mouse.up()
  const stillThere = await rect()
  check(`${name} body is not a drag handle`, stillThere.x === shifted.x && stillThere.y === shifted.y, `${stillThere.x},${stillThere.y}`)
  await page.screenshot({ path: `${shots}/06-${name}-moved.png` })
  await key('Escape')
}

/* ---- the bottom nav still opens and closes ---------------------------- */
await clickText('Wallet')
check('bottom nav opens the pouch', (await page.$('.popup-pouch')) !== null)
await clickText('Wallet')
check('bottom nav closes the pouch', (await page.$('.popup')) === null)

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '))
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
await browser.close()
await site.close()
process.exit(failed.length ? 1 : 0)
