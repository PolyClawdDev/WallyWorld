import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

/**
 * Geometry audit for the HUD and the panels. The chunky frames are wider and
 * taller than the flat ones they replaced, so this measures every anchored
 * surface at several viewport sizes and reports overlaps, off-screen edges and
 * clipped text instead of relying on eyeballing one screenshot.
 */
const site = process.env.BASE ? { base: process.env.BASE, close: async () => {} } : await serveDist()
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const clickText = async text => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)), text)
  await handle.asElement().click()
  await wait(400)
}

await page.setViewport({ width: 1440, height: 900 })
await page.goto(`${site.base}/`, { waitUntil: 'networkidle0' })
await clickText('Enter the world')
await clickText('Continue with')
await clickText('Enter Voxels')
await page.waitForFunction('!!window.__wally', { timeout: 20000 })
await wait(1200)

const audit = () => page.evaluate(() => {
  const selectors = [
    '.topbar', '.avatar-chip', '.gold-chip', '.demo-chip', '.fps-chip',
    '.minimap', '.map-ring', '.controls', '.bottom-nav', '.interact', '.toast',
    '.hunt-stack', '.ability', '.vitals', '.vitals-track', '.hunt-compass', '.hunt-log', '.target-plate',
    '.popup', '.popup-banner', '.popup-body', '.pouch-grid', '.mp-stage', '.mp-side',
  ]
  const seen = selectors
    .map(selector => ({ selector, el: document.querySelector(selector) }))
    .filter(entry => entry.el && entry.el.getBoundingClientRect().width > 0)
    .map(({ selector, el }) => {
      const box = el.getBoundingClientRect()
      return { selector, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height } }
    })
  const problems = []
  // overlap only matters between siblings that are meant to be separate plates
  const plates = seen.filter(entry => ['.hunt-stack', '.hunt-compass', '.hunt-log', '.target-plate', '.controls', '.bottom-nav', '.toast', '.minimap', '.topbar', '.interact'].includes(entry.selector))
  for (let i = 0; i < plates.length; i++) {
    for (let j = i + 1; j < plates.length; j++) {
      const a = plates[i].box
      const b = plates[j].box
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (overlapX > 1 && overlapY > 1) problems.push(`overlap ${plates[i].selector} × ${plates[j].selector} (${Math.round(overlapX)}×${Math.round(overlapY)}px)`)
    }
  }
  const anchored = new Set([...plates.map(entry => entry.selector), '.popup'])
  for (const { selector, box } of seen) {
    if (!anchored.has(selector)) continue
    if (box.left < -1 || box.top < -1 || box.right > window.innerWidth + 1 || box.bottom > window.innerHeight + 1) {
      problems.push(`off-screen ${selector} (${Math.round(box.left)},${Math.round(box.top)} → ${Math.round(box.right)},${Math.round(box.bottom)})`)
    }
  }
  // clipped text: any element whose content is wider or taller than its box
  document.querySelectorAll('.hunt-hud *, .hud *, .popup *').forEach(el => {
    if (!(el instanceof HTMLElement)) return
    const style = getComputedStyle(el)
    if (style.overflow === 'auto' || style.overflow === 'scroll' || style.position === 'fixed') return
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) problems.push(`clipped-x ${el.className || el.tagName} (${el.scrollWidth} in ${el.clientWidth})`)
    if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && el.childElementCount === 0) problems.push(`clipped-y ${el.className || el.tagName}`)
  })
  return { boxes: seen.map(entry => `${entry.selector} ${Math.round(entry.box.width)}×${Math.round(entry.box.height)} @ ${Math.round(entry.box.left)},${Math.round(entry.box.top)}`), problems: [...new Set(problems)] }
})

let failures = 0
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [860, 720]]) {
  await page.setViewport({ width, height })
  await wait(600)
  for (const [label, open] of [['world', null], ['pouch', 'k'], ['map', 'm'], ['journal', 'j'], ['settings', 'o']]) {
    if (open) { await page.keyboard.press(open); await wait(450) }
    const { problems } = await audit()
    if (problems.length) { failures += problems.length; console.log(`${width}×${height} ${label}: ${problems.join(' | ')}`) }
    if (open) { await page.keyboard.press('Escape'); await wait(300) }
  }
  // hunt HUD with a target acquired and the ledger open
  await page.evaluate(() => {
    const { wildlife, player } = window.__wally
    player.position.set(-58, 0, -52)
    const target = wildlife.animals.find(animal => animal.state !== 'dead')
    if (target) target.group.position.set(player.position.x + 3, 0, player.position.z - 2)
  })
  await wait(900)
  await page.keyboard.press('h')
  await wait(500)
  const hunt = await audit()
  if (hunt.problems.length) { failures += hunt.problems.length; console.log(`${width}×${height} hunt: ${hunt.problems.join(' | ')}`) }
  else console.log(`${width}×${height} hunt: clean`)
  if (width === 1440) console.log(hunt.boxes.join('\n'))
  await page.keyboard.press('h')
  await page.evaluate(() => window.__wally.player.position.set(2, 0, 12))
  await wait(700)
}
console.log(failures ? `\n${failures} layout problems` : '\nno layout problems')
await browser.close()
await site.close()
process.exit(failures ? 1 : 0)
