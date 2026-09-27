/**
 * Does handing a stack to a townsperson ask first? Confirms the question
 * appears on drop, that declining keeps the item, and that confirming is what
 * actually moves it.
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
page.on('pageerror', e => console.log('  !! page error:', e.message.split('\n')[0]))

await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 60000 })
await wait(2500)
// The bottom nav only exists once the world screen is up, and unlike the dev
// probe it is present in a production build too.
const inWorld = () => page.evaluate(() => !!document.querySelector('.bottom-nav'))
for (let step = 0; step < 10; step++) {
  if (await inWorld()) break
  await page.evaluate(() => {
    const input = document.querySelector('#wayfinder-name') ?? document.querySelector('input[type="text"]')
    if (input && !input.value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'TESTER')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    const hit = [...document.querySelectorAll('button')].filter(b => !b.disabled)
      .find(b => /enter|begin|start|world|continue|confirm/i.test(b.textContent ?? ''))
    hit?.click()
  })
  await wait(2500)
}
for (let i = 0; i < 40 && !(await inWorld()); i++) await wait(1500)
// Let the town finish building, so the raycast has NPCs to hit.
await wait(6000)

// Open the pouch.
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('.bottom-nav button')].find(b => /wallet/i.test(b.textContent ?? ''))
  hit?.click()
})
await wait(2000)
const slots = await page.evaluate(() => document.querySelectorAll('.pouch-slot:not(.empty)').length)
check('the pouch opened with stacks in it', slots > 0, `${slots} filled slots`)

/** Drag the first filled slot onto the middle of the world behind the panel. */
async function dropOnWorld() {
  const box = await page.evaluate(() => {
    const slot = document.querySelector('.pouch-slot:not(.empty)')
    if (!slot) return null
    const r = slot.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!box) return false
  // Aim well clear of the panel: a point inside it is a slot swap, not a gift.
  const drop = await page.evaluate(() => {
    const r = document.querySelector('.popup').getBoundingClientRect()
    return { x: Math.max(60, r.left / 2), y: window.innerHeight * 0.55 }
  })
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x - 60, box.y + 20, { steps: 8 })
  await page.mouse.move(drop.x, drop.y, { steps: 18 })
  const mid = await page.evaluate(() => ({
    ghost: !!document.querySelector('.pouch-ghost'),
    hint: document.querySelector('.pouch-hint')?.textContent ?? null,
  }))
  console.log(`       mid-drag: ghost=${mid.ghost} hint=${mid.hint}`)
  await page.mouse.up()
  // Poll fast: if the dialog mounts and is then withdrawn, a single late look
  // would miss it entirely.
  let seen = false
  for (let i = 0; i < 25; i++) {
    if (await page.evaluate(() => !!document.querySelector('.give-ask'))) { seen = true; break }
    await wait(50)
  }
  console.log(`       dialog seen within 1.25s of drop: ${seen}`)
  await wait(900)
  return true
}

console.log('\nDropping a stack')
await dropOnWorld()
const asked = await page.evaluate(() => {
  const el = document.querySelector('.give-ask')
  return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 200) : null
})
check('a confirmation appeared before anything moved', !!asked)
if (asked) console.log(`       "${asked}"`)
else {
  const why = await page.evaluate(() => ({
    toast: document.querySelector('.toast')?.textContent ?? null,
    pouchOpen: !!document.querySelector('.pouch-grid'),
    popupOpen: !!document.querySelector('.popup'),
    backdrop: !!document.querySelector('.give-ask-backdrop'),
    gifts: document.querySelectorAll('.pouch-gift').length,
  }))
  console.log(`       toast=${why.toast} pouchOpen=${why.pouchOpen} popupOpen=${why.popupOpen} askBackdrop=${why.backdrop} gifts=${why.gifts}`)
}
await page.screenshot({ path: '/tmp/give-ask.png' })

console.log('\nDeclining')
const before = await page.evaluate(() => document.querySelectorAll('.pouch-slot:not(.empty)').length)
await page.evaluate(() => [...document.querySelectorAll('.give-ask-no')][0]?.click())
await wait(900)
const afterNo = await page.evaluate(() => ({
  open: !!document.querySelector('.give-ask'),
  filled: document.querySelectorAll('.pouch-slot:not(.empty)').length,
}))
check('the question closed', !afterNo.open)
check('"Keep it" kept the stack', afterNo.filled === before, `${before} -> ${afterNo.filled} filled slots`)

console.log('\nConfirming')
await dropOnWorld()
const reopened = await page.evaluate(() => !!document.querySelector('.give-ask'))
check('the question appeared again', reopened)
await page.evaluate(() => [...document.querySelectorAll('.give-ask-yes')][0]?.click())
await wait(1200)
const afterYes = await page.evaluate(() => ({
  open: !!document.querySelector('.give-ask'),
  filled: document.querySelectorAll('.pouch-slot:not(.empty)').length,
  logged: document.querySelectorAll('.pouch-gift').length,
}))
check('the question closed', !afterYes.open)
check('confirming actually handed it over', afterYes.filled === before - 1, `${before} -> ${afterYes.filled} filled slots`)
check('the gift log recorded it', afterYes.logged > 0, `${afterYes.logged} entries`)

console.log('\nControl hint removed')
const hint = await page.evaluate(() => !!document.querySelector('.controls'))
check('the WASD hint strip is gone', !hint)

await page.screenshot({ path: '/tmp/give-done.png' })
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failed`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
