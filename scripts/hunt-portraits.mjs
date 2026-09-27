import puppeteer from 'puppeteer'

/* Close-up portraits of each species and each ability, shot in the open
 * wildwood clearing so nothing hides behind a pine. Writes /tmp/hunt-p-*.png. */

const URL = 'http://127.0.0.1:5173/'
const WIZARDS = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

async function enter(page, wizardIndex) {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'networkidle0' })
  const click = text =>
    page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)
  await click('Enter the world')
  await sleep(200)
  for (let i = 0; i < wizardIndex; i++) {
    await page.evaluate(() => document.querySelector('[aria-label="Next character"]').click())
    await sleep(60)
  }
  await click('Continue with')
  await sleep(250)
  await click('Enter Wally World')
  await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 25000 })
  await sleep(700)
  return errors
}

/** Crop around a world point. */
async function shot(page, path, focus, size = [660, 430], lift = 1.2) {
  const clip = await page.evaluate(
    ([f, s, l]) => {
      const w = window.__wally
      const point = w.player.position.clone()
      point.set(f.x, l, f.z)
      const ndc = point.project(w.camera)
      const canvas = document.querySelector('.world-canvas canvas')
      const rect = canvas.getBoundingClientRect()
      const cx = ((ndc.x + 1) / 2) * rect.width
      const cy = ((1 - ndc.y) / 2) * rect.height
      return {
        x: Math.max(0, Math.min(rect.width - s[0], cx - s[0] / 2)),
        y: Math.max(0, Math.min(rect.height - s[1], cy - s[1] / 2)),
        width: s[0],
        height: s[1],
      }
    },
    [focus, size, lift],
  )
  await page.screenshot({ path, clip })
}

/** Stage an animal in the clearing with the camera looking at it. */
async function stage(page, speciesId, offset) {
  return page.evaluate(
    ([id, gap]) => {
      const w = window.__wally
      const region = w.wildlife.animals.find(a => a.region.id === 'wildwood').region
      const animal = w.wildlife.animals.find(a => a.species.id === id)
      animal.group.position.set(region.x, 0, region.z)
      animal.home.set(region.x, 0, region.z)
      animal.destination.set(region.x, 0, region.z)
      animal.group.rotation.y = -0.9
      animal.state = 'graze'
      animal.stateUntil = performance.now() + 20000
      // Hold still for the photograph; a skittish chicken never stays in frame.
      animal.species = { ...animal.species, noticeRadius: 0 }
      w.player.position.set(region.x + gap, 0, region.z + gap * 0.6)
      return { x: region.x, z: region.z, height: animal.species.height, label: animal.species.label }
    },
    [speciesId, offset],
  )
}

const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await enter(page, 0)

// Discoverability: what the player sees at spawn, and on the trail itself.
await sleep(1200)
await page.screenshot({ path: '/tmp/hunt-p-spawn.png' })
await page.evaluate(() => window.__wally.player.position.set(-16, 0, -9))
await sleep(1600)
await page.screenshot({ path: '/tmp/hunt-p-trailhead.png' })
await page.evaluate(() => window.__wally.player.position.set(-38, 0, -34))
await sleep(1600)
await page.screenshot({ path: '/tmp/hunt-p-trail.png' })

for (const [species, gap] of [['CHICKEN', 3.2], ['REINDEER', 5.5], ['BEAR', 5.5]]) {
  const at = await stage(page, species, gap)
  await sleep(1800)
  await shot(page, `/tmp/hunt-p-${species}.png`, at, species === 'CHICKEN' ? [420, 300] : [560, 400], at.height * 0.55)
  console.log(`portrait ${species} at ${at.x.toFixed(1)},${at.z.toFixed(1)}`)
}

// All three together, to compare silhouettes at one scale.
const trio = await page.evaluate(() => {
  const w = window.__wally
  const region = w.wildlife.animals.find(a => a.region.id === 'wildwood').region
  const line = ['CHICKEN', 'REINDEER', 'BEAR']
  line.forEach((id, index) => {
    const animal = w.wildlife.animals.find(a => a.species.id === id)
    animal.group.position.set(region.x - 4 + index * 4, 0, region.z)
    animal.home.copy(animal.group.position)
    animal.destination.copy(animal.group.position)
    animal.group.rotation.y = -1.4
    animal.state = 'graze'
    animal.stateUntil = performance.now() + 30000
    animal.species = { ...animal.species, noticeRadius: 0 }
  })
  w.player.position.set(region.x + 1, 0, region.z + 7)
  return { x: region.x, z: region.z }
})
await sleep(2200)
await shot(page, '/tmp/hunt-p-trio.png', trio, [900, 420], 1.2)
console.log('trio written')
await page.close()

for (let i = 0; i < WIZARDS.length; i++) {
  const p = await browser.newPage()
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await enter(p, i)
  const ability = await p.evaluate(() => document.querySelector('.ability-head strong').textContent)
  const at = await p.evaluate(() => {
    const w = window.__wally
    const region = w.wildlife.animals.find(a => a.region.id === 'wildwood').region
    const deer = w.wildlife.animals.find(a => a.species.id === 'REINDEER')
    deer.group.position.set(region.x, 0, region.z)
    deer.home.copy(deer.group.position)
    deer.destination.copy(deer.group.position)
    deer.state = 'graze'
    deer.stateUntil = performance.now() + 30000
    const reach = Math.min(w.combat.spec.range * 0.6, 11)
    w.player.position.set(region.x + reach, 0, region.z + reach * 0.4)
    return { x: region.x, z: region.z, reach }
  })
  await sleep(1900)

  // Fire through the real cursor and hold the mouse there.
  const point = await p.evaluate(() => {
    const w = window.__wally
    const deer = w.wildlife.animals.find(a => a.species.id === 'REINDEER')
    const ndc = deer.group.position.clone().setY(1.3).project(w.camera)
    const rect = document.querySelector('.world-canvas canvas').getBoundingClientRect()
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height }
  })
  await p.mouse.move(point.x, point.y)
  await sleep(140)
  const plate = await p.evaluate(() => document.querySelector('.target-plate strong')?.textContent ?? null)
  await p.mouse.down({ button: 'left' })
  await p.mouse.up({ button: 'left' })

  // Three frames across the effect's life: launch, travel, impact.
  const frames = [90, 260, 520]
  for (const delay of frames) {
    await sleep(delay - (frames[frames.indexOf(delay) - 1] ?? 0))
    const mid = await p.evaluate(() => {
      const w = window.__wally
      const deer = w.wildlife.animals.find(a => a.species.id === 'REINDEER')
      return {
        x: (deer.group.position.x + w.player.position.x) / 2,
        z: (deer.group.position.z + w.player.position.z) / 2,
      }
    })
    await shot(p, `/tmp/hunt-p-${WIZARDS[i]}-${delay}.png`, mid, [760, 440], 1.4)
  }
  console.log(`${WIZARDS[i]} ${ability} · plate=${plate} · reach ${at.reach.toFixed(1)}m`)
  await p.close()
}

await browser.close()
