import puppeteer from 'puppeteer'
import { createHash } from 'node:crypto'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 820, deviceScaleFactor: 1 })

const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })

// A concurrent edit can trigger an HMR reload and destroy the execution
// context mid-run, so retry once through a reload.
const retry = async fn => {
  try {
    return await fn()
  } catch (e) {
    if (!String(e).includes('Execution context was destroyed')) throw e
    await new Promise(r => setTimeout(r, 1500))
    return fn()
  }
}

const click = async label => {
  await retry(() => page.evaluate(l => {
    const b = [...document.querySelectorAll('button')].find(
      x => ((x.getAttribute('aria-label') || '') + ' ' + x.textContent).toLowerCase().includes(l.toLowerCase()),
    )
    if (!b) throw new Error(`no button for "${l}"`)
    b.click()
  }, label))
}

await click('Enter the world')
await new Promise(r => setTimeout(r, 1200))

// The app's renderer has no preserveDrawingBuffer, so toDataURL on its canvas
// comes back blank. Screenshot the composited element instead.
const grab = async () => {
  const el = await page.$('.character-preview canvas')
  if (!el) return null
  return 'data:image/png;base64,' + (await el.screenshot({ encoding: 'base64' }))
}

const slots = ['hat', 'robe', 'familiar', 'accessory']
const characters = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']
const shots = []
const report = []
let failures = 0

for (const character of characters) {
  const label = await retry(() =>
    page.evaluate(() => document.querySelector('.character-choice strong')?.textContent?.trim() ?? '?'),
  )
  for (const slot of slots) {
    const seen = new Map()
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 700))
      const value = await retry(() => page.evaluate(s => {
        const row = [...document.querySelectorAll('.arrow-choice')].find(
          r => r.querySelector('label')?.textContent?.trim().toUpperCase() === s,
        )
        return row?.querySelector('strong')?.textContent?.trim() ?? '?'
      }, slot.toUpperCase()))
      const png = await grab()
      const hash = createHash('sha1').update(png ?? '').digest('hex').slice(0, 10)
      seen.set(`${i}:${value}`, hash)
      shots.push({ character: label, slot, value, png })
      await click(`Next ${slot}`)
    }
    const unique = new Set(seen.values()).size
    const ok = unique === 5
    if (!ok) failures++
    report.push(
      `  ${label.padEnd(8)} ${slot.padEnd(10)} ${unique}/5 distinct renders ${ok ? 'OK  ' : 'FAIL'}  ${[...seen.entries()].map(([v, h]) => `${v.split(':')[1]}=${h}`).join('  ')}`,
    )
  }
  await click('Next character')
  await new Promise(r => setTimeout(r, 700))
}

console.log('Rendered pixels per wardrobe option (identical hashes = selector did nothing):\n')
console.log(report.join('\n'))
console.log(failures ? `\n${failures} selector(s) FAILED` : '\nEvery selector changed the render on every character.')

// Contact sheet per character.
for (const character of characters) {
  const mine = shots.filter(s => s.character === character)
  const html =
    `<body style="margin:0;background:#0d141c;font:11px ui-monospace,monospace;color:#cfe">` +
    `<h2 style="color:#d5a64b;font:600 18px system-ui;margin:12px">${character}</h2>` +
    `<div style="display:grid;grid-template-columns:repeat(5,250px);gap:4px;margin:0 12px">` +
    mine
      .map(
        s =>
          `<figure style="margin:0"><img src="${s.png}" width="250" style="display:block;background:#152231"><figcaption style="padding:4px 2px"><b style="color:#d5a64b">${s.slot}</b> · ${s.value}</figcaption></figure>`,
      )
      .join('') +
    `</div></body>`
  const p = await browser.newPage()
  await p.setViewport({ width: 1300, height: 1200, deviceScaleFactor: 1 })
  await p.setContent(html)
  await new Promise(r => setTimeout(r, 500))
  await p.screenshot({ path: `/tmp/wardrobe-${character}.png`, fullPage: true })
  await p.close()
}
console.log('\ncontact sheets: /tmp/wardrobe-{MOTH,BRAMBLE,CINDER,ORBIT}.png')

console.log(errors.length ? '\nPAGE ERRORS:\n' + [...new Set(errors)].join('\n') : '\nno page errors')
await browser.close()
