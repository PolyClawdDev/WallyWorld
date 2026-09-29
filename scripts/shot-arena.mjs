/*
 * Look at the arena, and measure it, on the real GL backend.
 *
 * Deliberately NOT launched with `--use-angle=swiftshader`: that renders
 * on the CPU at about three frames a second, which makes any frame-rate
 * number meaningless. Chrome's default backend reaches a real renderer
 * headlessly, so this asks for nothing but a window size and then reports
 * whatever it gets.
 *
 * The harness at /arena.html has no wallet, no server and no town in it,
 * so anything visible in these plates was built by src/arena.
 *
 * Usage:
 *   UI=http://127.0.0.1:5311 node scripts/shot-arena.mjs screenshots/arena
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI ?? 'http://127.0.0.1:5311'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/arena'

const wait = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failed++
}

await fs.mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('  page error:', e.message))
page.on('console', m => {
  if (m.type() === 'error') console.log('  console error:', m.text())
})

await page.goto(`${UI}/arena.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })

let ready = false
for (let i = 0; i < 40; i++) {
  await wait(500)
  ready = await page.evaluate(() => !!window.__arena)
  if (ready) break
}
check('the harness came up', ready)
if (!ready) {
  await browser.close()
  process.exit(1)
}

/* ------------------------------------------------------------ the facts */
const facts = await page.evaluate(() => {
  const a = window.__arena.arena
  return {
    radius: a.radius,
    boundary: a.boundaryRadius,
    spawns: a.spawns.map(s => ({ id: s.id, x: s.position.x, z: s.position.z, facing: s.facing, color: s.color })),
    stats: a.stats,
  }
})
console.log()
console.log(`  platform    ${facts.radius * 2}m across, boundary at ${facts.boundary}m`)
console.log(`  spawns      ${facts.spawns.map(s => `${s.id}(${s.x},${s.z})`).join('  ')}`)
console.log(`  built       ${facts.stats.boxes} boxes -> ${facts.stats.meshes} meshes, ${facts.stats.triangles} triangles, ${facts.stats.lights} lights`)

/* ------------------------------------------------------------ the plates */
/*
 * Every plate names what it is meant to show, so a picture that does not
 * show it is a failed plate rather than a nice render.
 */
const PLATES = [
  {
    name: '01-establishing-wide',
    shows: 'the platform as an island with nothing around it',
    setup: h => { h.place(0, null); h.place(1, null); h.look([0, 38, 66], [0, 0, 0], 44) },
  },
  {
    name: '02-darkness-low',
    shows: 'the void at eye level: no horizon, no sky, no ground beyond the rim',
    setup: h => { h.look([0, 4.5, 74], [0, 2.5, 0], 40) },
  },
  {
    name: '03-gameplay-camera',
    shows: 'the whole floor from a playing angle, both duellists on their marks',
    setup: h => { h.atSpawns('MOTH', 'CINDER'); h.look([0, 21, 34], [0, 1, 0], 46) },
  },
  {
    name: '04-spawn-eye-across',
    shows: "the view from one spawn: the opponent, 24m away on the far mark",
    setup: h => {
      // The camera IS the near duellist, so only the far one is placed.
      h.place(0, null)
      const [a, b] = h.arena.spawns
      h.place(1, 'CINDER', [b.position.x, b.position.z], b.facing)
      h.look([a.position.x, 1.75, a.position.z], [b.position.x, 1.1, b.position.z], 60)
    },
  },
  {
    name: '04b-spawn-eye-behind',
    shows: 'the same gap over the near duellist\u2019s shoulder, both marks in frame',
    setup: h => {
      h.atSpawns('MOTH', 'CINDER')
      const [a, b] = h.arena.spawns
      h.look([1.6, 3.2, a.position.z + 4.5], [b.position.x, 1.1, b.position.z], 55)
    },
  },
  {
    name: '05-tile-seams',
    shows: 'flagstone seams and the trim rings, close enough to count them',
    setup: h => { h.place(0, null); h.place(1, null); h.look([2.5, 2.2, 9.5], [0.5, 0, 2.5], 58) },
  },
  {
    name: '06-perimeter-runes',
    shows: 'the lit runes in the perimeter band and the boundary behind them',
    setup: h => { h.look([1.5, 2.6, 12.5], [0, 0, 19], 56) },
  },
  {
    name: '07-boundary-held',
    shows: 'a duellist stopped by the boundary, standing at the containment limit',
    setup: h => {
      const stop = h.pushInto(Math.PI / 2, 400)
      h.place(0, 'ORBIT', [stop.x, stop.z], Math.atan2(-stop.x, -stop.z) + Math.PI)
      h.place(1, null)
      h.look([6, 3.4, 11], [stop.x, 1.1, stop.z], 50)
    },
  },
  {
    name: '08-boundary-along',
    shows: 'the low magical wall running around the rim, with its posts outside it',
    setup: h => { h.place(0, null); h.look([0, 2.4, 6], [13.4, 0.6, 13.4], 62) },
  },
  {
    name: '09-close-quarters',
    shows: 'two characters at melee range, readable against the dark floor',
    setup: h => {
      h.place(0, 'MOTH', [-1.8, 0], Math.PI / 2)
      h.place(1, 'CINDER', [1.8, 0], -Math.PI / 2)
      h.look([0, 4.2, 9], [0, 1.2, 0], 44)
    },
  },
  {
    name: '10-readability-overhead',
    shows: 'both characters from the height a match camera would use',
    setup: h => {
      h.atSpawns('BRAMBLE', 'CINDER')
      h.look([0, 26, 26], [0, 0, 0], 44)
    },
  },
]

for (const plate of PLATES) {
  await page.evaluate(source => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${source})`)()
    fn(window.__arena)
  }, plate.setup.toString())
  await wait(600)
  const file = path.join(OUT, `${plate.name}.png`)
  await page.screenshot({ path: file })
  console.log(`  ${plate.name.padEnd(24)} ${plate.shows}`)
}

/* --------------------------------------------------- cost and frame rate */
/*
 * Measured twice, because "draw calls" means two different things here.
 * The arena's own cost is what this task is accountable for; the second
 * number is what a real duel actually costs once two characters — which
 * are the shadow casters — are standing in it.
 */
await page.evaluate(() => {
  window.__arena.place(0, null)
  window.__arena.place(1, null)
  window.__arena.look([0, 21, 34], [0, 1, 0], 46)
})
await wait(500)
const bare = await page.evaluate(() => window.__arena.measure(2500))

await page.evaluate(() => {
  window.__arena.atSpawns('MOTH', 'CINDER')
  window.__arena.look([0, 21, 34], [0, 1, 0], 46)
})
await wait(500)
const perf = await page.evaluate(() => window.__arena.measure(3000))

console.log()
console.log(`  arena alone          ${bare.calls} draw calls, ${bare.triangles} triangles, ${bare.fps.toFixed(1)} fps`)
console.log(`  arena + 2 duellists  ${perf.calls} draw calls, ${perf.triangles} triangles, ${perf.fps.toFixed(1)} fps over ${perf.frames} frames`)
check('the arena itself is cheap to draw', bare.calls <= 40, `${bare.calls} calls`)
check('two characters in it stays cheap', perf.calls < 120, `${perf.calls} calls`)
check('it renders at speed on a real backend', perf.fps > 50, `${perf.fps.toFixed(1)} fps`)

/* -------------------------------------------------- containment, in situ */
console.log()
let escapes = 0
let worst = 0
for (let i = 0; i < 360; i++) {
  const angle = (i / 360) * Math.PI * 2
  const stop = await page.evaluate(
    ([a, m]) => window.__arena.pushInto(a, m),
    [angle, 1000],
  )
  if (!stop.contained) escapes++
  worst = Math.max(worst, stop.radius)
}
console.log(`  pushed 1000m in 360 directions from the centre`)
console.log(`  escapes ${escapes}, furthest the body reached ${worst.toFixed(6)}m (boundary ${facts.boundary}m)`)
check('the boundary holds in the live renderer too', escapes === 0 && worst < facts.boundary)

/* ------------------------------------------------- leak test, in browser */
console.log()
const recycled = await page.evaluate(() => window.__arena.recycle(30))
console.log(`  ${recycled.cycles} rebuilds in the live scene leaked ${recycled.geometries} geometries, ${recycled.materials} materials, ${recycled.textures} textures`)
check('rebuilding in a live renderer leaks nothing',
  recycled.geometries === 0 && recycled.materials === 0 && recycled.textures === 0)

const after = await page.evaluate(() => ({
  geometries: window.__arena.renderer.info.memory.geometries,
  textures: window.__arena.renderer.info.memory.textures,
}))
console.log(`  renderer.info.memory after rebuilds: ${after.geometries} geometries, ${after.textures} textures`)

console.log()
console.log(`  plates in ${OUT}`)
console.log(failed === 0 ? 'ARENA SHOTS: clean.' : `ARENA SHOTS: FAILED — ${failed}`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
