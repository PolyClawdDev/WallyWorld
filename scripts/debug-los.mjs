import puppeteer from 'puppeteer'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', protocolTimeout: 240000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 600 })
await page.evaluateOnNewDocument(() => {
  if (globalThis.Buffer) return
  const enc = new TextEncoder()
  class B extends Uint8Array {
    static from(v) { return typeof v === 'string' ? new B(enc.encode(v)) : new B(v) }
    static alloc(n) { return new B(n) }
    static isBuffer(v) { return v instanceof B }
    static concat(l) { const t = l.reduce((s, i) => s + i.length, 0); const o = new B(t); let a = 0; for (const i of l) { o.set(i, a); a += i.length } return o }
    toString() { return new TextDecoder().decode(this) }
  }
  globalThis.Buffer = B
})
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
const click = t => page.evaluate(x => { const e = [...document.querySelectorAll('button')].find(b => b.textContent.includes(x)); e && e.click() }, t)
await click('Enter the world'); await sleep(300)
await click('Continue with'); await sleep(300)
await click('Enter Wally World')
await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 30000 })
await sleep(1200)
console.log(JSON.stringify(await page.evaluate(() => {
  const w = window.__wally
  const out = []
  for (const a of w.wildlife.animals.slice(0, 14)) {
    const p = a.group.position
    w.player.position.set(p.x + 7, 0, p.z)
    const sees = w.nav.lineOfSight(w.player.position.x, w.player.position.z, p.x, p.z, 0.1)
    const blockers = w.nav.obstacles
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => Math.hypot(o.x - p.x, o.z - p.z) < 12)
      .slice(0, 4)
    out.push({ species: a.species.id, at: [+p.x.toFixed(1), +p.z.toFixed(1)], sees, playerBlocked: w.nav.blocked(p.x + 7, p.z), near: blockers.map(b => b.o.kind === 'circle' ? `c${b.o.r.toFixed(1)}@${b.o.x.toFixed(0)},${b.o.z.toFixed(0)}` : `r${b.o.halfW.toFixed(0)}x${b.o.halfD.toFixed(0)}@${b.o.x.toFixed(0)},${b.o.z.toFixed(0)}`) })
  }
  return { count: w.nav.obstacles.length, out }
}), null, 1))
await browser.close()
