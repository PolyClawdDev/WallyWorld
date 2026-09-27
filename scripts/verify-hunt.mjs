import puppeteer from 'puppeteer'

/* Verifies the wildlife + combat feature end to end against the dev server:
 * spawn zoning, species, per-ability visuals, animal aggro, player health,
 * death penalty and gold payouts. Screenshots land in /tmp/hunt-*.png. */

const URL = 'http://127.0.0.1:5173/'
const WIZARDS = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']
const pass = []
const fail = []
const check = (ok, label, detail = '') => {
  ;(ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

async function clickText(page, text) {
  const handle = await page.evaluateHandle(t => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))
    if (el) el.click()
    return el ? el.textContent : null
  }, text)
  return handle.jsonValue()
}

async function enterWorld(page, wizardIndex = 0) {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  // A missing favicon is not a hunt bug.
  // A generic "failed to load resource" line carries no URL, so judge on the
  // response instead and ignore the missing favicon this repo has never had.
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text())
  })
  page.on('response', r => {
    if (r.status() >= 400 && !/favicon/i.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`)
  })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await clickText(page, 'Enter the world')
  await sleep(200)
  for (let i = 0; i < wizardIndex; i++) {
    await page.evaluate(() => document.querySelector('[aria-label="Next character"]').click())
    await sleep(60)
  }
  await clickText(page, 'Continue with')
  await sleep(250)
  await clickText(page, 'Enter Wally World')
  await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 25000 })
  await sleep(900)
  return errors
}

/** Real input path: move the free cursor onto an animal, then click. */
async function aimOnly(page, animalIndex) {
  const point = await page.evaluate(index => {
    const w = window.__wally
    const animal = w.wildlife.animals[index]
    const ndc = animal.group.position.clone().setY(animal.species.height * 0.55).project(w.camera)
    const canvas = document.querySelector('.world-canvas canvas')
    const rect = canvas.getBoundingClientRect()
    return {
      x: rect.left + ((ndc.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndc.y) / 2) * rect.height,
      hp: animal.hp,
      species: animal.species.id,
    }
  }, animalIndex)
  await page.mouse.move(point.x, point.y)
  await sleep(140)
  return point
}

async function aimAndFire(page, animalIndex, { useKey = false } = {}) {
  const point = await aimOnly(page, animalIndex)
  if (useKey) {
    await page.keyboard.press('f')
  } else {
    await page.mouse.down({ button: 'left' })
    await page.mouse.up({ button: 'left' })
  }
  return point
}

const put = (page, x, z) =>
  page.evaluate(([px, pz]) => window.__wally.player.position.set(px, 0, pz), [x, z])

const state = page =>
  page.evaluate(() => {
    const w = window.__wally
    return {
      hp: w.vitals.hp,
      gold: Number((document.querySelector('.gold-chip')?.textContent || '').replace(/[^\d]/g, '')),
      barWidth: document.querySelector('.vitals-fill')?.style.width,
      target: document.querySelector('.target-plate strong')?.textContent ?? null,
      ability: document.querySelector('.ability-head strong')?.textContent ?? null,
      death: document.querySelector('.death-banner h3')?.textContent ?? null,
      deathBody: document.querySelector('.death-banner p')?.textContent ?? null,
    }
  })

/** Crop tight on the player so effects and animals are actually legible. */
async function closeUp(page, path) {
  const clip = await page.evaluate(() => {
    const w = window.__wally
    const ndc = w.player.position.clone().setY(1.4).project(w.camera)
    const canvas = document.querySelector('.world-canvas canvas')
    const rect = canvas.getBoundingClientRect()
    const cx = ((ndc.x + 1) / 2) * rect.width
    const cy = ((1 - ndc.y) / 2) * rect.height
    const width = 620
    const height = 400
    return {
      x: Math.max(0, Math.min(rect.width - width, cx - width / 2)),
      y: Math.max(0, Math.min(rect.height - height, cy - height * 0.62)),
      width,
      height,
    }
  })
  await page.screenshot({ path, clip })
}

/* ---------------------------------------------------------------- 1 */
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
let errors = await enterWorld(page, 0)

const census = await page.evaluate(() => {
  const w = window.__wally
  const counts = {}
  const inTown = []
  for (const a of w.wildlife.animals) {
    counts[a.species.id] = (counts[a.species.id] || 0) + 1
    if (w.isInTown(a.group.position.x, a.group.position.z)) {
      inTown.push({ species: a.species.id, x: +a.group.position.x.toFixed(1), z: +a.group.position.z.toFixed(1) })
    }
  }
  return {
    counts,
    inTown,
    total: w.wildlife.animals.length,
    gold: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.goldBaseUnits])),
    hp: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.maxHp])),
  }
})
console.log('\ncensus:', JSON.stringify(census), '\n')
check(census.total >= 25, 'wildlife populated across the map', `${census.total} animals`)
check(!!census.counts.CHICKEN && !!census.counts.REINDEER && !!census.counts.BEAR, 'chickens, reindeer and bears all exist', JSON.stringify(census.counts))
check(census.inTown.length === 0, 'no animal spawns inside the town footprint', census.inTown.length ? JSON.stringify(census.inTown) : 'checked every animal against isInTown()')
check(
  census.gold.CHICKEN < census.gold.REINDEER && census.gold.REINDEER < census.gold.BEAR,
  'gold scales with animal size',
  `chicken ${census.gold.CHICKEN} < reindeer ${census.gold.REINDEER} < bear ${census.gold.BEAR}`,
)

/* ---------------------------------------------------------------- 1b */
// The compass needle has to point at the wildwood, not away from it.
const compass = await page.evaluate(async () => {
  const w = window.__wally
  const area = w.wildlife.animals.find(a => a.region.id === 'wildwood').region
  const read = async (x, z) => {
    w.player.position.set(x, 0, z)
    await new Promise(r => setTimeout(r, 700))
    const view = w.camera.getWorldDirection(new (w.player.position.constructor)())
    const right = { x: Math.cos(Math.atan2(-view.x, -view.z)), z: -Math.sin(Math.atan2(-view.x, -view.z)) }
    const to = { x: area.x - x, z: area.z - z }
    const length = Math.hypot(to.x, to.z)
    return {
      degrees: +w.huntState.compassDegrees.toFixed(1),
      // Positive when the wildwood really is off to the camera's right.
      rightness: +((to.x * right.x + to.z * right.z) / length).toFixed(3),
      metres: Math.round(w.huntState.compassDistance),
      trueMetres: Math.round(length),
    }
  }
  return { a: await read(area.x + 40, area.z), b: await read(area.x - 40, area.z), c: await read(area.x, area.z + 40) }
})
console.log('compass:', JSON.stringify(compass))
const bearingAgrees = s => Math.sign(Math.sin((s.degrees * Math.PI) / 180)) === Math.sign(s.rightness)
check(
  bearingAgrees(compass.a) && bearingAgrees(compass.b) && bearingAgrees(compass.c),
  'compass needle points toward the wildwood',
  `east ${compass.a.degrees}° west ${compass.b.degrees}° south ${compass.c.degrees}°`,
)
check(
  Math.abs(compass.a.metres - compass.a.trueMetres) <= 1,
  'compass distance is the real distance',
  `${compass.a.metres}m vs ${compass.a.trueMetres}m`,
)

/* ---------------------------------------------------------------- 2 */
// Stand in the wildwood clearing and photograph the game.
const arrival = await page.evaluate(() => {
  const w = window.__wally
  const area = w.wildlife.animals.find(a => a.species.id === 'BEAR')
  return { x: area.group.position.x, z: area.group.position.z }
})
await put(page, arrival.x, arrival.z + 12)
await sleep(1200)
await page.screenshot({ path: '/tmp/hunt-01-wildwood.png' })
await closeUp(page, '/tmp/hunt-01b-wildwood-close.png')

// Portraits: stand a fixed distance from each species and crop in.
for (const species of ['CHICKEN', 'REINDEER', 'BEAR']) {
  const found = await page.evaluate(id => {
    const w = window.__wally
    const a = w.wildlife.animals.find(x => x.species.id === id)
    if (!a) return false
    w.player.position.set(a.group.position.x + 5.5, 0, a.group.position.z + 5.5)
    return true
  }, species)
  if (!found) continue
  await sleep(900)
  await closeUp(page, `/tmp/hunt-00-${species}.png`)
}

const nearBear = await page.evaluate(() => {
  const w = window.__wally
  const bear = w.wildlife.animals.find(a => a.species.id === 'BEAR')
  const deer = w.wildlife.animals.find(a => a.species.id === 'REINDEER')
  return {
    bear: { x: bear.group.position.x, z: bear.group.position.z },
    deer: { x: deer.group.position.x, z: deer.group.position.z },
    apart: bear.group.position.distanceTo(deer.group.position).toFixed(1),
  }
})
console.log('bear/deer', JSON.stringify(nearBear))

/* ---------------------------------------------------------------- 3 */
// Chickens flee.
const flee = await page.evaluate(async () => {
  const w = window.__wally
  const chicken = w.wildlife.animals.find(a => a.species.id === 'CHICKEN')
  w.player.position.set(chicken.group.position.x + 4, 0, chicken.group.position.z)
  const before = chicken.group.position.clone()
  await new Promise(r => setTimeout(r, 1400))
  const after = chicken.group.position.clone()
  return {
    state: chicken.state,
    moved: +before.distanceTo(after).toFixed(2),
    distanceBefore: 4,
    distanceAfter: +after.distanceTo(w.player.position).toFixed(2),
  }
})
check(flee.state === 'flee' && flee.moved > 1, 'chickens flee when approached', `state=${flee.state}, moved ${flee.moved}m, gap 4m→${flee.distanceAfter}m`)

/* ---------------------------------------------------------------- 4 */
// MOTH lantern burst damages a reindeer through the real cursor + click path.
const deerIndex = await page.evaluate(() => window.__wally.wildlife.animals.findIndex(a => a.species.id === 'REINDEER'))
await page.evaluate(i => {
  const w = window.__wally
  const deer = w.wildlife.animals[i]
  w.player.position.set(deer.group.position.x + 2.6, 0, deer.group.position.z + 2.6)
}, deerIndex)
await sleep(700)
const beforeShot = await page.evaluate(i => window.__wally.wildlife.animals[i].hp, deerIndex)
await aimOnly(page, deerIndex)
const plate = await state(page)
check(plate.target === 'REINDEER', 'target plate shows the animal under the cursor', plate.target ?? 'missing')
check(plate.ability === 'LANTERN BURST', 'MOTH ability is the lantern burst', plate.ability ?? 'missing')
await page.mouse.down({ button: 'left' })
await page.mouse.up({ button: 'left' })
await sleep(150)
await page.screenshot({ path: '/tmp/hunt-02-ability-MOTH.png' })
await sleep(500)
const afterShot = await page.evaluate(i => window.__wally.wildlife.animals[i].hp, deerIndex)
check(afterShot < beforeShot, 'left click attack damages an animal', `reindeer hp ${beforeShot} → ${afterShot}`)
check(
  await page.evaluate(() => document.pointerLockElement === null),
  'attacking never grabs the pointer, the cursor stays free',
)

// The F key is the keyboard route to the same attack.
await sleep(700)
const beforeKey = await page.evaluate(i => window.__wally.wildlife.animals[i].hp, deerIndex)
await aimAndFire(page, deerIndex, { useKey: true })
await sleep(900)
const afterKey = await page.evaluate(i => window.__wally.wildlife.animals[i].hp, deerIndex)
check(afterKey < beforeKey, 'F key attacks as well as left click', `reindeer hp ${beforeKey} → ${afterKey}`)

/* ---------------------------------------------------------------- 5 */
// Kill it, then walk over the drops.
const killResult = await page.evaluate(async i => {
  const w = window.__wally
  const deer = w.wildlife.animals[i]
  const goldBefore = Number((document.querySelector('.gold-chip').textContent || '').replace(/[^\d]/g, ''))
  for (let shot = 0; shot < 30 && deer.state !== 'dead'; shot++) {
    w.wildlife.damageIn(deer.group.position, 2, 20, performance.now())
    await new Promise(r => setTimeout(r, 60))
  }
  await new Promise(r => setTimeout(r, 300))
  const drops = []
  w.player.position.set(deer.group.position.x, 0, deer.group.position.z)
  return { dead: deer.state === 'dead', goldBefore, drops: drops.length }
}, deerIndex)
await sleep(1600)
const afterPickup = await state(page)
check(killResult.dead, 'animals die when their health reaches zero')
check(afterPickup.gold > killResult.goldBefore, 'kill drops gold that the player picks up', `gold ${killResult.goldBefore} → ${afterPickup.gold}`)
await page.screenshot({ path: '/tmp/hunt-03-gold.png' })

const respawn = await page.evaluate(i => {
  const a = window.__wally.wildlife.animals[i]
  return { state: a.state, respawnInMs: Math.round(a.respawnAt - performance.now()) }
}, deerIndex)
check(respawn.respawnInMs > 0, 'dead animals are queued to respawn', `${respawn.species ?? 'reindeer'} in ${respawn.respawnInMs}ms`)

/* ---------------------------------------------------------------- 6 */
// A bear hits the player and the health bar moves.
const bearFight = await page.evaluate(async () => {
  const w = window.__wally
  const bear = w.wildlife.animals.find(a => a.species.id === 'BEAR')
  w.player.position.set(bear.group.position.x + 2.2, 0, bear.group.position.z)
  const hpBefore = w.vitals.hp
  const seen = new Set()
  const start = performance.now()
  // Out-of-combat regeneration also moves hp, so wait for a real drop.
  while (performance.now() - start < 12000 && w.vitals.hp > hpBefore - 5) {
    seen.add(bear.state)
    await new Promise(r => setTimeout(r, 50))
    w.player.position.set(bear.group.position.x + 2.2, 0, bear.group.position.z)
  }
  return {
    hpBefore: Math.round(hpBefore),
    hpAfter: Math.round(w.vitals.hp),
    states: [...seen],
    barWidth: document.querySelector('.vitals-fill').style.width,
  }
})
check(bearFight.hpAfter < bearFight.hpBefore, 'a bear damages the player', `hp ${bearFight.hpBefore} → ${bearFight.hpAfter}`)
check(bearFight.states.includes('windup'), 'bear attacks are telegraphed before they land', `states seen: ${bearFight.states.join(', ')}`)
check(parseFloat(bearFight.barWidth) < 100, 'health bar moves with damage', `fill ${bearFight.barWidth}`)
await page.screenshot({ path: '/tmp/hunt-04-bear-attack.png' })

/* ---------------------------------------------------------------- 7 */
// Death penalty: gold is deducted and dropped where you fell.
const death = await page.evaluate(async () => {
  const w = window.__wally
  const bear = w.wildlife.animals.find(a => a.species.id === 'BEAR')
  const goldBefore = Number((document.querySelector('.gold-chip').textContent || '').replace(/[^\d]/g, ''))
  const at = { x: bear.group.position.x + 2, z: bear.group.position.z }
  const deathsBefore = w.huntState.death
  w.player.position.set(at.x, 0, at.z)
  const start = performance.now()
  // Stand in reach until the death notice fires. Health resets on respawn, so
  // the notice is the only reliable signal that the player actually died.
  while (performance.now() - start < 40000 && w.huntState.death === deathsBefore) {
    await new Promise(r => setTimeout(r, 50))
    if (w.huntState.death === deathsBefore) w.player.position.set(at.x, 0, at.z)
  }
  const respawnedAt = { x: +w.player.position.x.toFixed(1), z: +w.player.position.z.toFixed(1) }
  const safe = w.isSafeZone(w.player.position.x, w.player.position.z)
  await new Promise(r => setTimeout(r, 400))
  return {
    goldBefore,
    goldAfter: Number((document.querySelector('.gold-chip').textContent || '').replace(/[^\d]/g, '')),
    dropped: w.huntState.death?.goldDroppedBaseUnits ?? null,
    respawnedAt,
    safe,
    banner: document.querySelector('.death-banner h3')?.textContent ?? null,
    body: document.querySelector('.death-banner p')?.textContent ?? null,
    hpAfter: Math.round(w.vitals.hp),
  }
})
console.log('death:', JSON.stringify(death))
check(!!death.banner, 'death is announced on screen', death.banner ?? 'no banner')
check(
  death.goldAfter === death.goldBefore - death.dropped && death.dropped > 0,
  'death deducts carried gold',
  `gold ${death.goldBefore} → ${death.goldAfter}, dropped ${death.dropped}`,
)
check(death.safe, 'player respawns in the safe town zone', `at ${death.respawnedAt.x},${death.respawnedAt.z}`)
check(death.hpAfter > 90, 'player respawns with health restored', `hp ${death.hpAfter}`)
await page.screenshot({ path: '/tmp/hunt-05-death.png' })

/* ---------------------------------------------------------------- 8 */
// Hunt ledger, and the honesty of its payout copy.
await page.keyboard.press('h')
await sleep(400)
const ledger = await page.evaluate(() => {
  const log = document.querySelector('.hunt-log')
  return { text: log?.innerText ?? null, rows: log?.querySelectorAll('tbody tr').length ?? 0 }
})
await page.screenshot({ path: '/tmp/hunt-06-ledger.png' })
check(!!ledger.text && ledger.rows > 0, 'hunt ledger records events', `${ledger.rows} rows`)
check(/Demo — no real funds/.test(ledger.text || ''), 'ledger carries the demo-mode label')
check(/No Solana or token conversion is implemented/.test(ledger.text || ''), 'ledger states no Solana payout exists')
check(/BLOCKED/.test(ledger.text || ''), 'conversion queue is shown as blocked')
await page.keyboard.press('h')

check(errors.length === 0, 'no page errors during the hunt', errors.join(' | ') || 'clean')
await page.close()

/* ---------------------------------------------------------------- 9 */
// One screenshot per character, mid-ability, next to the same species.
for (let i = 0; i < WIZARDS.length; i++) {
  const shot = await browser.newPage()
  await shot.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errs = await enterWorld(shot, i)
  const ability = await shot.evaluate(() => document.querySelector('.ability-head strong').textContent)
  const index = await shot.evaluate(() => {
    const w = window.__wally
    const idx = w.wildlife.animals.findIndex(a => a.species.id === 'REINDEER')
    const deer = w.wildlife.animals[idx]
    const spec = w.combat.spec
    const reach = Math.min(spec.range * 0.55, 9)
    w.player.position.set(deer.group.position.x + reach, 0, deer.group.position.z + reach * 0.5)
    return idx
  })
  await sleep(900)
  await aimOnly(shot, index)
  const acquired = await shot.evaluate(() => document.querySelector('.target-plate strong')?.textContent ?? null)
  check(acquired === 'REINDEER', `${WIZARDS[i]} acquires the reindeer under the free cursor`, acquired ?? 'no target plate')
  await shot.mouse.down({ button: 'left' })
  await shot.mouse.up({ button: 'left' })
  await sleep(spacingFor(ability))
  await closeUp(shot, `/tmp/hunt-07-${WIZARDS[i]}.png`)
  await shot.screenshot({ path: `/tmp/hunt-08-${WIZARDS[i]}-full.png` })
  await sleep(1200)
  const landed = await shot.evaluate(i => {
    const a = window.__wally.wildlife.animals[i]
    return { hp: a.hp, max: a.species.maxHp }
  }, index)
  check(landed.hp < landed.max, `${WIZARDS[i]} ability (${ability}) lands damage`, `reindeer hp ${landed.hp}/${landed.max}`)
  check(errs.length === 0, `${WIZARDS[i]} runs without page errors`, errs.slice(0, 2).join(' | ') || 'clean')
  await shot.close()
}

function spacingFor(ability) {
  // Catch each effect while it is still on screen: travel time differs by design.
  if (ability === 'LANTERN BURST') return 140
  if (ability === 'THORN LASH') return 230
  if (ability === 'EMBER BLAST') return 240
  return 520
}

console.log(`\n${pass.length} passed, ${fail.length} failed`)
if (fail.length) console.log('failures:\n - ' + fail.join('\n - '))
await browser.close()
process.exit(fail.length ? 1 : 0)
