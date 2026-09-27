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
  const url = message.location().url ?? ''
  if (url.includes('favicon')) return
  // the Solana agent's API server allowlists the dev-server origin, so a static
  // test origin is refused; that refusal is not this UI's behaviour
  if (url.includes(':8787') || message.text().includes(':8787')) return
  errors.push(`console: ${message.text()}`)
})
page.on('response', response => {
  if (response.status() < 400) return
  // favicon is missing in this build, and the Solana agent's API allowlists the
  // dev-server origin so it refuses this static test origin
  if (response.url().includes('favicon') || response.url().includes(':8787')) return
  errors.push(`http ${response.status()} ${response.url()}`)
})

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
// The world pauses while a panel is open, so the aim point is found with the
// pouch shut and the camera settled, then the pouch is reopened in place.
await dragBanner(-260, 40)
const parked = await rect()
await key('Escape')
check('Escape still closes the pouch', (await page.$('.popup')) === null)

/** A townsperson the app itself can resolve at their own screen position,
 *  clear of where the pouch will reopen. NPCs walk, so this is read live. */
const aimNow = frame => page.evaluate(panel => {
  const camera = window.__wally.camera
  const Vector3 = camera.position.constructor
  let best = null
  window.__wallyBridge.handle().scene.traverse(object => {
    if (!object.userData?.npc || !object.visible) return
    const world = object.getWorldPosition(new Vector3())
    const projected = world.clone().add(new Vector3(0, 1.2, 0)).project(camera)
    if (projected.z <= -1 || projected.z >= 1) return
    const x = (projected.x * 0.5 + 0.5) * window.innerWidth
    const y = (-projected.y * 0.5 + 0.5) * window.innerHeight
    if (x < 30 || y < 30 || x > window.innerWidth - 30 || y > window.innerHeight - 30) return
    if (x > panel.x - 16 && x < panel.x + panel.w + 16 && y > panel.y - 16 && y < panel.y + panel.h + 16) return
    // the drop path is npcAtScreen, so only trust a point it resolves itself
    if (window.__wallyBridge.npcAtScreen(x, y) !== object.userData.npc) return
    const distance = camera.position.distanceTo(world)
    if (!best || distance < best.distance) best = { x, y, distance, name: object.userData.npc }
  })
  return best
}, frame)

const placements = [[18, 0, 26], [22, 0, 30], [14, 0, 22], [26, 0, 36], [12, 0, 18], [0, 0, 12]]
let aim = null
for (const spot of placements) {
  await page.evaluate(p => window.__wally.player.position.set(...p), spot)
  await settle()
  await wait(250)
  await wait(600)
  aim = await aimNow(parked)
  if (aim) break
}
check('a townsperson is on screen clear of the pouch', aim !== null, aim ? `${aim.name} at ${Math.round(aim.x)},${Math.round(aim.y)}` : 'none resolvable')

const camBefore = await page.evaluate(() => window.__wally.camera.position.toArray().map(n => n.toFixed(2)).join(','))
await key('k')
const reopened = await rect()
check('the pouch reopens where it was left', reopened.x === parked.x && reopened.y === parked.y, `${reopened.x},${reopened.y}`)
void camBefore
/** Drags one stack out of the pouch onto a townsperson and reports what happened.
 *  The chase camera keeps easing while a panel is open, so the townsperson is
 *  followed with the stack in hand and released the moment the pouch reports a
 *  target: the drop resolves again on release, and a stale point misses. */
const giveOnce = async (label, { screenshot } = {}) => {
  const slot = await page.evaluate(text => {
    const found = [...document.querySelectorAll('.pouch-slot')].find(s => (s.getAttribute('aria-label') || '').includes(text))
    if (!found) return null
    const box = found.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, label)
  if (!slot) return { hint: `no ${label} stack`, moved: null }
  const first = await aimNow(parked)
  await page.mouse.move(slot.x, slot.y)
  await page.mouse.down()
  await page.mouse.move(slot.x + 30, slot.y - 30, { steps: 4 })
  if (first) await page.mouse.move(first.x, first.y, { steps: 6 })
  let hint = ''
  let moved = null
  for (let pass = 0; pass < 14; pass += 1) {
    const live = await aimNow(parked)
    if (live) {
      await page.mouse.move(live.x, live.y, { steps: 2 })
      hint = await page.$eval('.pouch-hint', element => element.textContent)
      if (/GIVE TO /.test(hint)) {
        moved = await rect()
        if (screenshot) await page.screenshot({ path: `${shots}/04-stack-drag.png` })
        break
      }
    }
    await wait(90)
  }
  await page.mouse.up()
  await wait(450)
  const after = await page.evaluate(() => ({ toast: (document.querySelector('.toast') || {}).textContent ?? '', gifts: [...document.querySelectorAll('.pouch-gift')].map(g => g.textContent) }))
  return { hint, moved, ...after }
}

// the screenshot pass holds the stack over a townsperson, which costs enough
// time for the easing camera to slide out from under the drop
const shown = await giveOnce('SOL Coin', { screenshot: true })
check('dragging a stack does not move the window', shown.moved !== null && shown.moved.x === parked.x && shown.moved.y === parked.y, `${shown.moved ? `${shown.moved.x},${shown.moved.y}` : 'never targeted'} vs ${parked.x},${parked.y}`)
check('the drag names the townsperson under the cursor', /GIVE TO /.test(shown.hint), shown.hint.trim())
const gave = /accepted/.test(shown.toast) ? shown : await giveOnce('Wally Shard')
check('the stack drag still reaches the NPC', /accepted/.test(gave.toast), gave.toast.trim())
check('the gift is logged in the pouch', gave.gifts.length > 0, gave.gifts.join(' | '))
await page.screenshot({ path: `${shots}/05-after-give.png` })

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
