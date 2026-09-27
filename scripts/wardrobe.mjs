/*
 * Roster verification and contact sheets.
 *
 * Two passes, because they prove different things:
 *
 *   1. The harness at /voxel-test.html renders every character and every
 *      wardrobe option once, at a fixed yaw, into 2D canvases. Hashing those
 *      pixels is meaningful: an identical hash means an identical render, so a
 *      selector that only changed a label shows up as a duplicate. The live
 *      preview in the app rotates on a clock and can never be hashed this way.
 *
 *   2. The real selection screen is then clicked through, to prove the UI is
 *      actually wired to those options on all four characters.
 *
 * Outputs /tmp/roster-contact.png, /tmp/roster-silhouettes.png,
 * /tmp/roster-solid.png and /tmp/wardrobe-<NAME>.png.
 */
import puppeteer from 'puppeteer'
import { createHash } from 'node:crypto'

const HOST = process.env.HARNESS_HOST ?? 'http://127.0.0.1:5173'
// Pass 2 prefers a preview build: other agents are editing this repo live, and
// a Vite HMR update mid-run remounts the app and pulls the selector rows out
// from under the click. Falls back to the dev server.
const APP_HOST = process.env.APP_HOST ?? HOST
const hash = png => createHash('sha1').update(png ?? '').digest('hex').slice(0, 10)

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const errors = []
const watch = page => {
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
}

/* ---------------------------------------------------------------- *
 * Pass 1: the deterministic harness.
 * ---------------------------------------------------------------- */

const harness = await browser.newPage()
watch(harness)
await harness.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
await harness.goto(`${HOST}/voxel-test.html`, { waitUntil: 'domcontentloaded' })
// Software WebGL renders roughly a hundred tiles at a few frames a second.
await harness.waitForFunction('window.__voxelTestReady === true', { timeout: 600_000, polling: 1000 })
const tiles = await harness.evaluate(() => window.__roster)
console.log(`harness rendered ${tiles.length} tiles\n`)

const failures = []
const byGroup = group => tiles.filter(t => t.group === group)

/** Distinct renders inside one group, reported as n/expected. */
const distinct = (label, group, expected) => {
  const shots = byGroup(group)
  const unique = new Set(shots.map(t => hash(t.png))).size
  const ok = unique === expected
  if (!ok) failures.push(`${label}: only ${unique} distinct renders of ${expected}`)
  return `${label.padEnd(34)} ${unique}/${expected} distinct  ${ok ? 'OK' : 'FAIL'}   ${shots.map(t => `${t.label.split(' · ')[0]}=${hash(t.png)}`).join('  ')}`
}

console.log('Rendered pixels (identical hash = the change did nothing):\n')
console.log('  ' + distinct('four characters, same wardrobe', 'contact', 4))
console.log('  ' + distinct('four silhouettes, colour removed', 'silhouette', 4))

const characters = [...new Set(tiles.map(t => t.id))]
const names = Object.fromEntries(tiles.map(t => [t.id, t.name]))
for (const id of characters) {
  const slots = [...new Set(byGroup2(id).map(t => t.group))]
  for (const group of slots) {
    const slot = group.split(':')[2]
    console.log('  ' + distinct(`${names[id]} · ${slot}`, group, 5))
  }
}
function byGroup2(id) {
  return tiles.filter(t => t.group.startsWith(`wardrobe:${id}:`))
}

/* Silhouette spread is the whole point of the redesign, so measure it rather
 * than eyeballing it: coverage is the share of non-white pixels in the flat
 * black render, and the bounding box is the outline's width and height. */
const shape = await harness.evaluate(async () => {
  const measure = png =>
    new Promise(resolve => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const { data } = ctx.getImageData(0, 0, c.width, c.height)
        let filled = 0
        let minX = c.width
        let maxX = -1
        let minY = c.height
        let maxY = -1
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 120) continue
          const p = i / 4
          const x = p % c.width
          const y = Math.floor(p / c.width)
          filled++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        resolve({
          coverage: filled / (c.width * c.height),
          w: (maxX - minX + 1) / c.width,
          h: (maxY - minY + 1) / c.height,
        })
      }
      img.src = png
    })
  const out = []
  for (const tile of window.__roster.filter(t => t.group === 'bodyshape')) {
    out.push({ name: tile.name, ...(await measure(tile.png)) })
  }
  return out
})

console.log('  ' + distinct('four body plans, gear removed', 'bodyshape', 4))
console.log('\nBody-plan measurements from the flat-black renders (no gear, no companion):\n')
for (const s of shape) {
  console.log(`  ${s.name.padEnd(6)} outline ${(s.w * 100).toFixed(1)}% wide × ${(s.h * 100).toFixed(1)}% tall of frame   ink coverage ${(s.coverage * 100).toFixed(2)}%`)
}
const aspects = shape.map(s => s.w / s.h)
const spread = Math.max(...aspects) / Math.min(...aspects)
console.log(`\n  widest/narrowest outline aspect ratio: ${spread.toFixed(2)}×`)
if (spread < 1.8) failures.push(`silhouettes are too similar in proportion (only ${spread.toFixed(2)}× spread)`)

/* ---------------------------------------------------------------- *
 * Pass 2: the real selection screen.
 * ---------------------------------------------------------------- */

const app = await browser.newPage()
// The app currently fails to boot in a browser without a Buffer global:
// @solana/spl-token touches it at module scope. That is in-flight work in
// src/solana, so this stub is applied to the test page only — nothing in the
// repo is changed by it — purely so the selection screen can be driven here.
await app.evaluateOnNewDocument(() => {
  const mk = n => new Uint8Array(typeof n === 'number' ? n : 0)
  globalThis.Buffer = { from: () => mk(0), alloc: mk, allocUnsafe: mk, concat: () => mk(0), isBuffer: () => false, byteLength: () => 0 }
})
watch(app)
await app.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
await app.goto(`${APP_HOST}/`, { waitUntil: 'networkidle0' })

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
  await retry(() => app.evaluate(l => {
    const b = [...document.querySelectorAll('button')].find(
      x => ((x.getAttribute('aria-label') || '') + ' ' + x.textContent).toLowerCase().includes(l.toLowerCase()),
    )
    if (!b) throw new Error(`no button for "${l}"`)
    b.click()
  }, label))
}

/**
 * A Vite HMR update from another agent's edit remounts the app on the entry
 * screen mid-run, which leaves the selector rows missing. Re-enter instead of
 * dying on the next click.
 */
const ensureSelect = async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = await retry(() => app.evaluate(() => document.querySelectorAll('.arrow-choice').length))
    if (rows >= 5) return
    await click('Enter the world').catch(() => {})
    await new Promise(r => setTimeout(r, 1200))
  }
  throw new Error('selection screen never appeared')
}

await ensureSelect()

console.log('\nLive selection screen, clicking every selector on every character:\n')
let uiFailures = 0
for (let c = 0; c < 4; c++) {
  await ensureSelect()
  const shown = await retry(() => app.evaluate(() => ({
    name: document.querySelector('.character-choice strong')?.textContent?.trim() ?? '?',
    // The character row is first; the four wardrobe rows follow it.
    slots: [...document.querySelectorAll('.arrow-choice')].slice(1).map(r => ({
      label: r.querySelector('label')?.textContent?.trim() ?? '?',
      value: r.querySelector('strong')?.textContent?.trim() ?? '?',
    })),
  })))
  const seen = []
  for (const [index, slot] of shown.slots.entries()) {
    const values = new Set()
    for (let i = 0; i < 5; i++) {
      const value = await retry(() => app.evaluate(n => {
        const row = [...document.querySelectorAll('.arrow-choice')].slice(1)[n]
        return row?.querySelector('strong')?.textContent?.trim() ?? '?'
      }, index))
      values.add(value)
      // Retried rather than asserted: a remount can drop the row between the
      // read and the click, and that is the harness's problem, not the app's.
      for (let tries = 0; tries < 5; tries++) {
        await ensureSelect()
        const clicked = await retry(() => app.evaluate(n => {
          const row = [...document.querySelectorAll('.arrow-choice')].slice(1)[n]
          if (!row) return false
          row.querySelectorAll('button')[1].click()
          return true
        }, index))
        if (clicked) break
        await new Promise(r => setTimeout(r, 800))
      }
      await new Promise(r => setTimeout(r, 120))
    }
    const ok = values.size === 5
    if (!ok) uiFailures++
    seen.push(`${slot.label}:${values.size}/5${ok ? '' : ' FAIL'}`)
  }
  console.log(`  ${shown.name.padEnd(6)} ${seen.join('   ')}`)
  await click('Next character')
  await new Promise(r => setTimeout(r, 900))
}
if (uiFailures) failures.push(`${uiFailures} live selector row(s) did not offer five distinct options`)

const leaked = await app.evaluate(() => {
  const text = document.body.innerText
  return ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT'].filter(k => new RegExp(`\\b${k}\\b`).test(text))
})
console.log(`\n  old internal keys visible on the selection screen: ${leaked.length ? leaked.join(', ') + '  FAIL' : 'none  OK'}`)
if (leaked.length) failures.push(`old keys leaked into the UI: ${leaked.join(', ')}`)

/* ---------------------------------------------------------------- *
 * Sheets.
 * ---------------------------------------------------------------- */

const sheet = async (file, title, shots, columns, width, tileWidth, dark = true) => {
  const html =
    `<body style="margin:0;background:${dark ? '#0d141c' : '#f4f6f8'};font:11px ui-monospace,monospace;color:${dark ? '#cfe' : '#223'}">` +
    `<h2 style="color:#d5a64b;font:600 19px system-ui;margin:14px 12px 8px">${title}</h2>` +
    `<div style="display:grid;grid-template-columns:repeat(${columns},${tileWidth}px);gap:6px;margin:0 12px 14px">` +
    shots
      .map(
        s =>
          `<figure style="margin:0"><img src="${s.png}" width="${tileWidth}" style="display:block"><figcaption style="padding:5px 2px;line-height:1.35">${s.caption}</figcaption></figure>`,
      )
      .join('') +
    `</div></body>`
  const p = await browser.newPage()
  await p.setViewport({ width, height: 900, deviceScaleFactor: 1 })
  await p.setContent(html)
  await new Promise(r => setTimeout(r, 400))
  await p.screenshot({ path: file, fullPage: true })
  await p.close()
  console.log(`  ${file}`)
}

console.log('\nsheets:')
await sheet(
  '/tmp/roster-contact.png',
  'THE FOUR WAYFINDERS · same wardrobe slot on each · internal keys in brackets',
  byGroup('contact').map(t => ({ png: t.png, caption: `<b style="color:#d5a64b">${t.label}</b>` })),
  4,
  1360,
  320,
)
await sheet(
  '/tmp/roster-silhouettes.png',
  'SILHOUETTES · all colour removed',
  byGroup('silhouette').map(t => ({ png: t.png, caption: `<b>${t.label}</b>` })),
  4,
  1360,
  320,
  false,
)
await sheet(
  '/tmp/roster-bodyplans.png',
  'BODY PLANS · colour, gear and companion removed',
  byGroup('bodyshape').map(t => ({ png: t.png, caption: `<b>${t.label}</b>` })),
  4,
  1360,
  320,
  false,
)
await sheet(
  '/tmp/roster-solid.png',
  'SOLIDITY · magenta shows through any gap · front and three-quarter',
  byGroup('solid').map(t => ({ png: t.png, caption: t.label })),
  4,
  1360,
  320,
)
for (const id of characters) {
  await sheet(
    `/tmp/wardrobe-${names[id]}.png`,
    `${names[id]} WARDROBE · four slots × five options · internal key ${id}`,
    byGroup2(id).map(t => ({ png: t.png, caption: `<b style="color:#7bc9ce">${t.group.split(':')[2]}</b> · ${t.label}` })),
    5,
    1300,
    250,
  )
}

console.log(errors.length ? '\nPAGE ERRORS:\n' + [...new Set(errors)].join('\n') : '\nno page errors')
console.log(failures.length ? `\nFAILURES:\n${failures.map(f => '  ' + f).join('\n')}` : '\nAll checks passed.')
await browser.close()
process.exit(failures.length ? 1 : 0)
