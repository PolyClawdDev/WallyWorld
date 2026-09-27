import puppeteer from 'puppeteer'

const URL = 'http://127.0.0.1:5173/'
const pass = []
const fail = []
const check = (ok, label, detail = '') => {
  ;(ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text())
})

const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

await page.goto(URL, { waitUntil: 'networkidle0' })
await click('Enter world')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
  { timeout: 20000 },
)
await click('Continue with')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Enter Voxels')),
  { timeout: 20000 },
)
await click('Enter Voxels')
await page.waitForFunction('!!window.__wally && window.__wally.wildlife && window.__wally.wildlife.animals.length > 0', {
  timeout: 40000,
})
await page.waitForFunction('typeof window.__wally.killXp === "function"', { timeout: 15000 })

const report = await page.evaluate(() => {
  const w = window.__wally
  const hard = w.wildlife.animals.filter(a => a.species.id === 'WOLF' || a.species.id === 'BOAR')
  const starter = new Set(['eastmeadow', 'southfields', 'westoutskirts'])
  const progress = w.progress()
  progress.level = 10
  progress.xp = 0
  return {
    gold: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.goldBaseUnits])),
    hp: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.maxHp])),
    dmg: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.attackDamage])),
    rec: Object.fromEntries(Object.values(w.speciesSpecs).map(s => [s.id, s.recommendedLevel])),
    hard: hard.map(a => ({
      id: a.species.id,
      region: a.region.id,
      x: a.group.position.x,
      z: a.group.position.z,
      town: w.isInTown(a.group.position.x, a.group.position.z),
    })),
    hardInStarter: hard.some(a => starter.has(a.region.id)),
    wolfCount: hard.filter(a => a.species.id === 'WOLF').length,
    boarCount: hard.filter(a => a.species.id === 'BOAR').length,
    level: w.progress().level,
    chickenXp: w.killXp('CHICKEN', 10),
    wolfXp: w.killXp('WOLF', 10),
    boarXp: w.killXp('BOAR', 10),
    dest: w.compassHuntRegion(w.progress().level),
    high: { id: w.highHuntArea.id, x: w.highHuntArea.x, z: w.highHuntArea.z, label: w.highHuntArea.label },
  }
})

await page.waitForFunction(
  () => window.__wally.huntState.compassLabel === 'THE BRASSWOOD' && window.__wally.progress().level >= 10,
  { timeout: 8000 },
)
const compass = await page.evaluate(() => ({
  label: window.__wally.huntState.compassLabel,
  distance: window.__wally.huntState.compassDistance,
}))

await page.keyboard.press('m')
await page.waitForFunction(() => document.body.innerText.includes('THE BRASSWOOD'), { timeout: 8000 })
const mapHasBrasswood = await page.evaluate(() => document.body.innerText.includes('THE BRASSWOOD'))

check(report.wolfCount >= 1 && report.boarCount >= 1, 'wolves and boars spawned', `${report.wolfCount} wolves, ${report.boarCount} boars`)
check(report.hard.every(a => a.region === 'brasswood'), 'hard animals only in the Brasswood')
check(report.hard.every(a => !a.town), 'hard animals never in town')
check(!report.hardInStarter, 'hard animals never in starter meadows')
check(report.gold.WOLF > 45 && report.gold.BOAR > 45, 'new animals drop more gold than a bear', `wolf ${report.gold.WOLF} boar ${report.gold.BOAR} bear ${report.gold.BEAR}`)
check(report.level >= 10, 'progress store reached level 10', `level ${report.level}`)
check(report.chickenXp < 10, 'level 10 chicken XP is a sliver', String(report.chickenXp))
check(report.wolfXp > 400 && report.boarXp > report.wolfXp, 'level 10 Brasswood XP is meaningful', `wolf ${report.wolfXp} boar ${report.boarXp}`)
check(report.dest.id === 'brasswood' && compass.label === 'THE BRASSWOOD', 'compass points at the Brasswood at level 10', compass.label)
check(mapHasBrasswood, 'world map lists THE BRASSWOOD')
check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '))

console.log(JSON.stringify({ report, compass }, null, 2))
await browser.close()
if (fail.length) {
  console.error(`\n${fail.length} failed, ${pass.length} passed`)
  process.exit(1)
}
console.log(`\n${pass.length} passed`)
