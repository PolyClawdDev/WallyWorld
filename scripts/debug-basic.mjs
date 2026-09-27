import puppeteer from 'puppeteer'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
await page.evaluateOnNewDocument(() => {
  if (globalThis.Buffer) return
  const enc = new TextEncoder()
  class B extends Uint8Array {
    static from(v) { return typeof v === 'string' ? new B(enc.encode(v)) : new B(v) }
    static alloc(n) { return new B(n) }
    static isBuffer(v) { return v instanceof B }
    static concat(list) { const t = list.reduce((s, i) => s + i.length, 0); const o = new B(t); let a = 0; for (const i of list) { o.set(i, a); a += i.length } return o }
    toString() { return new TextDecoder().decode(this) }
  }
  globalThis.Buffer = B
})
page.on('pageerror', e => console.log('PAGEERROR', String(e)))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.removeItem('wally.progression.v1'))
await page.reload({ waitUntil: 'networkidle0' })
const click = t => page.evaluate(x => { const e = [...document.querySelectorAll('button')].find(b => b.textContent.includes(x)); e && e.click() }, t)
await click('Enter the world'); await sleep(300)
await page.evaluate(() => { for (let i = 0; i < 2; i++) document.querySelector('[aria-label="Next character"]').click() })
await sleep(200)
await click('Continue with'); await sleep(300)
await click('Enter Wally World')
await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 30000 })
await sleep(1500)

const out = await page.evaluate(async () => {
  const w = window.__wally
  const animal = w.wildlife.animals.find(a => a.species.id === 'REINDEER' && a.state !== 'dead')
  w.player.position.set(animal.group.position.x + 7, 0, animal.group.position.z)
  w.vitals.hp = w.vitals.maxHp
  await new Promise(r => setTimeout(r, 400))
  const log = []
  w.battle.secondaryClick(null, animal)
  const start = performance.now()
  while (performance.now() - start < 8000) {
    log.push({
      t: Math.round(performance.now() - start),
      order: w.battle.currentOrder(),
      tgt: w.battle.attackOrderTarget()?.species.id ?? null,
      d: +animal.group.position.distanceTo(w.player.position).toFixed(2),
      hp: animal.hp,
      st: animal.state,
      res: Math.round(w.battle.resourceValue()),
      dbg: w.battle.debug ? w.battle.debug() : null,
    })
    await new Promise(r => setTimeout(r, 400))
  }
  return {
    kit: { range: w.battle.kit.basic.range, rate: w.battle.kit.basic.rate, kind: w.battle.kit.basic.kind, windup: w.battle.kit.basic.windup },
    log,
  }
})
console.log(JSON.stringify(out.kit))
for (const r of out.log) console.log(JSON.stringify(r))
await browser.close()
