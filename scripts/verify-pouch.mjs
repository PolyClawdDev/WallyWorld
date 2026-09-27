import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

/**
 * Drives the running dev server through the pouch and the map popup so both can
 * be checked rather than assumed: grid slots, hunted gold reaching a slot, a
 * pointer drag from a slot resolving to an NPC in the 3D scene, and the map's
 * live player marker.
 */
const shots = process.env.SHOTS ?? '/tmp/wally-shots'
mkdirSync(shots, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('response', response => { if (response.status() >= 400) errors.push(`http ${response.status()} ${response.url()}`) })

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`) }
const clickText = async text => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)), text)
  const element = handle.asElement()
  if (!element) throw new Error(`button not found: ${text}`)
  await element.click()
  await wait(350)
}
const key = async k => { await page.keyboard.press(k); await wait(400) }
/** The chase camera lerps, so screen coordinates only mean anything once it stops.
 * Only x/z are compared: the idle bob keeps y moving forever. */
const settle = () => page.waitForFunction(() => {
  const { x, z } = window.__wally.camera.position
  const last = window.__settle
  window.__settle = { x, z }
  return !!last && Math.abs(last.x - x) < 0.01 && Math.abs(last.z - z) < 0.01
}, { polling: 250, timeout: 10000 })

await page.evaluateOnNewDocument(() => localStorage.clear())
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await clickText('Enter the world')
await clickText('Continue with')
await clickText('Enter Wally World')
await page.waitForFunction('!!window.__wally', { timeout: 20000 })
await wait(1200)
await page.screenshot({ path: `${shots}/00-world.png` })

/* ---- hunted gold reaches a pouch slot --------------------------------- */
// Uses the wildlife module's own kill and loot path: stand on an animal, land a
// killing blow, and let the world's drop pickup credit the gold.
const hunted = await page.evaluate(async () => {
  const { wildlife, player } = window.__wally
  const target = wildlife.animals.find(animal => animal.state !== 'dead')
  if (!target) return { ok: false, why: 'no live animals' }
  player.position.set(target.group.position.x, 0, target.group.position.z + 1.2)
  await new Promise(resolve => setTimeout(resolve, 260))
  wildlife.damageIn(player.position, 6, 400, performance.now())
  await new Promise(resolve => setTimeout(resolve, 1400))
  return { ok: true, species: target.species.id }
})
const goldChip = await page.$eval('.gold-chip', el => el.textContent)
check('a hunted animal credits gold', /[1-9]\d* GOLD/.test(goldChip), `${hunted.species ?? hunted.why} · ${goldChip.trim()}`)

/* ---- pouch popup ------------------------------------------------------ */
await key('k')
const pouch = await page.evaluate(() => {
  const popup = document.querySelector('.popup')
  const slots = [...document.querySelectorAll('.pouch-slot')]
  return {
    popup: !!popup,
    centered: popup ? Math.abs((popup.getBoundingClientRect().left + popup.getBoundingClientRect().right) / 2 - window.innerWidth / 2) < 3 : false,
    slots: slots.length,
    filled: slots.filter(s => s.querySelector('svg')).length,
    labels: slots.filter(s => s.querySelector('svg')).map(s => s.getAttribute('aria-label')),
    balances: [...document.querySelectorAll('.pouch-bal')].map(b => b.textContent),
    demo: (document.querySelector('.pouch-demo') || {}).textContent,
    emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.querySelector('.popup-body').textContent),
  }
})
check('K opens a centered popup', pouch.popup && pouch.centered)
check('grid has 20 slots', pouch.slots === 20, `${pouch.slots} slots`)
check('gold landed in a slot', pouch.labels.some(l => l.includes('Town Gold')), pouch.labels.join(' | '))
check('demo SOL and token stacks present', pouch.filled === 4, pouch.labels.join(' | '))
check('balances header shows demo amounts', pouch.balances.length === 4, pouch.balances.join(' | '))
check('demo label present', /DEMO — NO REAL FUNDS/.test(pouch.demo ?? ''))
check('no emoji in the pouch', !pouch.emoji)
await page.screenshot({ path: `${shots}/01-pouch.png` })

/* ---- drag a stack onto an NPC in the 3D scene ------------------------- */
// MIRA stands at (3.5, 5.2). Park the player so she projects clear of the grid.
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
    const grid = document.querySelector('.pouch-grid').getBoundingClientRect()
    const insideGrid = x > grid.left - 8 && x < grid.right + 8 && y > grid.top - 8 && y < grid.bottom + 8
    return { x, y, insideGrid, onScreen: x > 4 && y > 4 && x < window.innerWidth - 4 && y < window.innerHeight - 4 && point.z < 1 }
  })
  if (aim.onScreen && !aim.insideGrid) break
}
check('MIRA is on screen and clear of the grid', aim.onScreen && !aim.insideGrid, `x=${Math.round(aim.x)} y=${Math.round(aim.y)}`)

const goldSlot = await page.evaluate(() => {
  const slot = [...document.querySelectorAll('.pouch-slot')].find(s => (s.getAttribute('aria-label') || '').includes('Town Gold'))
  const box = slot.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
})
await page.mouse.move(goldSlot.x, goldSlot.y)
await page.mouse.down()
await page.mouse.move((goldSlot.x + aim.x) / 2, (goldSlot.y + aim.y) / 2, { steps: 6 })
await page.mouse.move(aim.x, aim.y, { steps: 8 })
await wait(160)
await page.screenshot({ path: `${shots}/02-dragging.png` })
const hint = await page.evaluate(() => (document.querySelector('.pouch-hint') || {}).textContent ?? '')
check('drag hint names the NPC under the cursor', /GIVE TO MIRA/.test(hint), hint)
await page.mouse.up()
await wait(500)
const afterGive = await page.evaluate(() => ({
  toast: (document.querySelector('.toast') || {}).textContent ?? '',
  gifts: [...document.querySelectorAll('.pouch-gift strong')].map(g => g.textContent),
  gold: document.querySelector('.gold-chip').textContent,
  labels: [...document.querySelectorAll('.pouch-slot')].filter(s => s.querySelector('svg')).map(s => s.getAttribute('aria-label')),
  stillOpen: !!document.querySelector('.popup'),
}))
check('give produced a toast naming MIRA', /MIRA accepted 1 GOLD/.test(afterGive.toast), afterGive.toast)
check('gift log records the simulated gift', afterGive.gifts.some(g => /1 GOLD → MIRA/.test(g)), afterGive.gifts.join(' | '))
check('item left the pouch', !afterGive.labels.some(l => l.includes('Town Gold')), afterGive.labels.join(' | '))
check('HUD gold counter dropped to 0', /0 GOLD/.test(afterGive.gold), afterGive.gold.trim())
check('popup stayed open through the drop', afterGive.stillOpen)
await page.screenshot({ path: `${shots}/03-after-give.png` })

/* ---- failure case: drop on empty ground with nobody nearby ------------ */
await page.evaluate(() => window.__wally.player.position.set(-90, 0, -90))
await settle()
const tokenSlot = await page.evaluate(() => {
  const slot = [...document.querySelectorAll('.pouch-slot')].find(s => (s.getAttribute('aria-label') || '').includes('Ember'))
  const box = slot.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
})
await page.mouse.move(tokenSlot.x, tokenSlot.y)
await page.mouse.down()
await page.mouse.move(120, 760, { steps: 8 })
await page.mouse.up()
await wait(400)
const miss = await page.evaluate(() => ({
  toast: (document.querySelector('.toast') || {}).textContent ?? '',
  kept: [...document.querySelectorAll('.pouch-slot')].some(s => (s.getAttribute('aria-label') || '').includes('Ember')),
}))
check('dropping on nobody explains itself', /No one under the cursor/.test(miss.toast), miss.toast)
check('missed drop keeps the item', miss.kept)
await key('Escape')
check('Escape closes the pouch', await page.evaluate(() => !document.querySelector('.popup')))

/* ---- map popup -------------------------------------------------------- */
await page.evaluate(() => window.__wally.player.position.set(0, 0, 8))
await wait(500)
await key('m')
const map = await page.evaluate(() => {
  const popup = document.querySelector('.popup')
  const box = popup?.getBoundingClientRect()
  return {
    popup: !!popup,
    wide: popup?.classList.contains('popup-wide'),
    centered: box ? Math.abs((box.left + box.right) / 2 - window.innerWidth / 2) < 3 : false,
    sidePanel: !!document.querySelector('.side-panel'),
    buildings: document.querySelectorAll('.mp-label').length,
    npcs: [...document.querySelectorAll('.mp-npc')].map(t => t.textContent),
    residents: document.querySelectorAll('.mp-stage rect[fill="#849394"]').length,
    player: (document.querySelector('.mp-player') || {}).getAttribute?.('transform'),
    readout: (document.querySelector('.mp-readout') || {}).textContent ?? '',
    legend: document.querySelectorAll('.mp-legend li').length,
    places: [...document.querySelectorAll('.mp-places li')].length,
    emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(document.querySelector('.popup-body').textContent),
  }
})
check('M opens a wide centered popup, not a sidebar', map.popup && map.wide && map.centered && !map.sidePanel)
check('all 17 buildings are labelled', map.buildings === 17, `${map.buildings} labels`)
check('8 service NPCs are labelled', map.npcs.length === 8, map.npcs.join(', '))
check('10 residents are marked', map.residents === 10, `${map.residents} markers`)
check('legend and place lists render', map.legend === 9 && map.places === 25, `legend ${map.legend}, places ${map.places}`)
check('player readout is live', /LIVE/.test(map.readout), map.readout.replace(/\s+/g, ' ').slice(0, 90))
check('no emoji on the map', !map.emoji)
await page.screenshot({ path: `${shots}/04-map.png` })

/* ---- the marker follows the player ----------------------------------- */
await page.evaluate(() => { window.__wally.player.position.set(-52, 0, 40); window.__wally.player.rotation.y = Math.PI / 2 })
await wait(400)
const moved = await page.evaluate(() => ({
  transform: document.querySelector('.mp-player').getAttribute('transform'),
  readout: document.querySelector('.mp-readout').textContent,
}))
check('marker transform tracks the player', /translate\(-52/.test(moved.transform) && /rotate\(-90/.test(moved.transform), moved.transform)
check('readout follows position and facing', /52m/.test(moved.readout) && /FACING E/.test(moved.readout), moved.readout.replace(/\s+/g, ' ').slice(0, 90))
await page.screenshot({ path: `${shots}/05-map-moved.png` })

const followBox = await page.evaluate(() => {
  const button = [...document.querySelectorAll('.mp-zoom button')].find(b => b.textContent.includes('FOLLOW'))
  button.click()
  return new Promise(resolve => setTimeout(() => resolve(document.querySelector('.mp-stage svg').getAttribute('viewBox')), 300))
})
check('FOLLOW ME reframes on the player', followBox.startsWith('-94'), followBox)
await page.screenshot({ path: `${shots}/06-map-follow.png` })
await key('Escape')
check('Escape closes the map', await page.evaluate(() => !document.querySelector('.popup')))

/* ---- walking, then reopening the map -------------------------------- */
const before = await page.evaluate(() => ({ x: window.__wally.player.position.x, z: window.__wally.player.position.z }))
await page.keyboard.down('w')
await wait(900)
await page.keyboard.up('w')
await wait(200)
const after = await page.evaluate(() => ({ x: window.__wally.player.position.x, z: window.__wally.player.position.z }))
const walked = Math.hypot(after.x - before.x, after.z - before.z)
check('walking moves the player (owned by another agent)', walked > 0.5, `moved ${walked.toFixed(2)}m`)
await key('m')
const reopened = await page.evaluate(() => {
  const [, x, z] = document.querySelector('.mp-player').getAttribute('transform').match(/translate\((-?[\d.]+) (-?[\d.]+)\)/)
  const player = window.__wally.player.position
  return { drift: Math.hypot(Number(x) - player.x, Number(z) - player.z), transform: `${x} ${z}` }
})
check('reopened map plots the walked-to position', reopened.drift < 0.5, `${reopened.transform} · drift ${reopened.drift.toFixed(2)}m`)
await page.screenshot({ path: `${shots}/07-map-after-walk.png` })

/* ---- bottom-nav entry points ---------------------------------------- */
await key('Escape')
await page.evaluate(() => [...document.querySelectorAll('.bottom-nav button')].find(b => b.textContent.includes('Wallet')).click())
await wait(300)
check('bottom-nav Wallet opens the pouch popup', await page.evaluate(() => !!document.querySelector('.pouch-grid')))
await key('Escape')
await page.evaluate(() => [...document.querySelectorAll('.bottom-nav button')].find(b => b.textContent.includes('Map')).click())
await wait(300)
check('bottom-nav Map opens the map popup', await page.evaluate(() => !!document.querySelector('.mp-stage')))

// The dev server has no favicon; that 404 predates this work.
const real = errors.filter(error => !error.includes('favicon') && !/status of 404/.test(error))
check('no page errors', real.length === 0, real.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${shots}`)
process.exit(failed.length ? 1 : 0)
