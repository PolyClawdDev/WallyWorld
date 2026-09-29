/*
 * Town plates, cost and navigation, measured on the real GL backend.
 *
 * Why this exists next to `shot-art.mjs`: that script launches Chrome with
 * `--use-angle=swiftshader`, which renders the world on the CPU at about three
 * frames a second. That is fine for a still plate and useless for the one
 * question a taller town raises — does it still draw at speed. Chrome's own
 * default GL backend reaches a real renderer headlessly, so this script asks
 * for nothing but `--no-sandbox` and then measures the frame rate it gets.
 *
 * It also walks the navigation grid, because a skyline is only allowed if the
 * streets under it still path. Footprints are unchanged by this work, so these
 * probes are a regression check rather than a discovery: they must give the
 * same answers before and after.
 *
 * Usage:
 *   UI=http://127.0.0.1:5299 node scripts/shot-town.mjs screenshots/town-after [nameFilter]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI ?? 'http://127.0.0.1:5299'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/town'
const FILTER = process.argv[3] ?? ''

/* Plates. Positions are world metres, the numbers townData.ts uses.
 * Anything named `eye-*` sits at 1.7m, a standing player's eye height. */
const PLATES = [
  // The skyline, from outside town on each side.
  { name: 'skyline-north', pos: [6, 26, 168], look: [0, 30, 10], fov: 50 },
  { name: 'skyline-southeast', pos: [120, 30, -120], look: [20, 26, 0], fov: 52 },
  { name: 'skyline-west', pos: [-172, 34, 30], look: [-40, 32, 40], fov: 48 },
  { name: 'skyline-high-north', pos: [10, 96, 150], look: [0, 22, 8], fov: 52 },

  // The plaza, from a player's eye.
  { name: 'eye-plaza-north', pos: [0, 1.7, 14], look: [0, 22, -30], fov: 68 },
  { name: 'eye-plaza-fountain', pos: [-7, 1.7, 9], look: [14, 20, 26], fov: 70 },
  { name: 'eye-plaza-respawn', pos: [0, 1.7, 8], look: [-14, 18, 20], fov: 72 },
  { name: 'eye-street-south', pos: [0, 1.7, -6], look: [0, 24, -34], fov: 68 },

  // One plate per building, from the door side, framed on the whole silhouette.
  { name: 'b-inn', pos: [-40, 14, -8], look: [-17, 16, 16], fov: 46 },
  { name: 'b-hall', pos: [40, 18, -8], look: [17, 20, 16], fov: 46 },
  { name: 'b-bakery', pos: [-38, 10, -42], look: [-17, 12, -17], fov: 48 },
  { name: 'b-stable', pos: [38, 9, -42], look: [17, 9, -17], fov: 48 },
  { name: 'b-apothecary', pos: [26, 12, -44], look: [50, 15, -16], fov: 46 },
  { name: 'b-smithy', pos: [26, 13, -8], look: [50, 16, 18], fov: 46 },
  { name: 'b-market', pos: [98, 16, -30], look: [72, 18, 0], fov: 48 },
  { name: 'b-post', pos: [26, 12, 24], look: [50, 14, 50], fov: 46 },
  { name: 'b-archive', pos: [-84, 22, 16], look: [-59, 24, 43], fov: 46 },
  { name: 'b-observatory', pos: [-98, 24, 42], look: [-72, 26, 70], fov: 46 },
  { name: 'b-garden', pos: [-64, 10, 50], look: [-42, 10, 76], fov: 48 },
  { name: 'b-tower', pos: [-110, 30, 22], look: [-82, 34, 52], fov: 46 },
  { name: 'b-glasshouse', pos: [-38, 12, 46], look: [-15, 13, 74], fov: 48 },
  { name: 'b-weaver', pos: [52, 12, 46], look: [74, 13, 72], fov: 46 },
  { name: 'b-cartwright', pos: [60, 11, -80], look: [83, 11, -54], fov: 48 },
  { name: 'b-chapel', pos: [-24, 14, -94], look: [0, 16, -68], fov: 46 },
  { name: 'b-fishery', pos: [30, 9, -94], look: [52, 9, -70], fov: 48 },

  // Bridges between roofs, seen from under and from the side.
  { name: 'bridge-north-under', pos: [0, 1.7, 30], look: [0, 26, 16], fov: 74 },
  { name: 'bridge-north-side', pos: [0, 30, 54], look: [0, 25, 16], fov: 50 },
  { name: 'bridge-canal', pos: [26, 26, 1], look: [50, 22, 1], fov: 52 },

  // Service NPCs, close enough to read an emblem off the standard.
  { name: 'npc-sable', pos: [43, 2.6, -2.2], look: [43, 2.2, -9], fov: 34 },
  { name: 'npc-bronze', pos: [43, 2.6, 17.8], look: [43, 2.2, 11], fov: 34 },
  { name: 'npc-mira', pos: [3.5, 2.6, 12.0], look: [3.5, 2.2, 5.2], fov: 34 },
  { name: 'npc-vellum', pos: [65, 2.6, -0.2], look: [65, 2.2, -7], fov: 34 },
  { name: 'npc-lyra', pos: [-52, 2.6, 42.8], look: [-52, 2.2, 36], fov: 34 },
  { name: 'npc-nell', pos: [-10, 2.6, 16.8], look: [-10, 2.2, 10], fov: 34 },
  { name: 'npc-astra', pos: [-68, 2.6, 67.8], look: [-68, 2.2, 61], fov: 34 },
  { name: 'npc-pip', pos: [43, 2.6, 49.8], look: [43, 2.2, 43], fov: 34 },
]

/* Navigation probes. `STAND` points must be walkable, `PATHS` pairs must
 * connect. Plaza, respawn, streets, bridges, doorsteps and every duel ring. */
const STAND = [
  ['town respawn', 0, 8],
  ['plaza north of fountain', 0, 7],
  ['plaza east', 12, 0],
  ['plaza west', -12, 0],
  ['plaza south', 0, -12],
  ['north street', 0, 40],
  ['south street', 0, -40],
  ['east high street', 40, 0],
  ['west high street', -40, 0],
  ['star quarter street', -48, 60],
  ['upper terrace street', -20, 48],
  ['canal bridge south', 34, -34],
  ['canal bridge north', 34, 38],
  ['inn doorstep', -17, 9],
  ['hall doorstep', 17, 9],
  ['smithy doorstep', 50, 11],
  ['apothecary doorstep', 43, -9],
  ['market doorstep', 65, -7],
  ['archive doorstep', -52, 36],
  ['tower doorstep', -82, 44],
  ['duel ring east-heath', 88, 28],
  ['duel ring south-meadow', 28, -88],
  ['duel ring west-verge', -88, 8],
  ['duel ring north-copse', 28, 88],
]

const PATHS = [
  ['respawn to market hall', 0, 8, 65, -7],
  ['respawn to spell tower', 0, 8, -82, 44],
  ['respawn to fisher shed', 0, 8, 52, -64],
  ['respawn to observatory', 0, 8, -72, 62],
  ['inn door to smithy door', -17, 9, 50, 11],
  ['bakery door to post office', -17, -23, 50, 43],
  ['across the north bridge', 34, 26, 34, 50],
  ['plaza to east duel ring', 0, 8, 88, 28],
  ['plaza to north duel ring', 0, 8, 28, 88],
  ['plaza to west duel ring', 0, 8, -88, 8],
  ['plaza to south duel ring', 0, 8, 28, -88],
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await fs.mkdir(OUT, { recursive: true })

/* No `--use-angle=swiftshader`: Chrome's default backend gives a real GL
 * renderer here, and the frame rate below is only worth printing because of it. */
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--hide-scrollbars'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error' && !/favicon|Failed to load resource|WebSocket/i.test(m.text())) errors.push(m.text())
})

const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

await page.goto(UI, { waitUntil: 'domcontentloaded' })
await click('Enter world')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
  { timeout: 60_000 },
)
// Name the character through React's own setter, or the controlled input ignores it.
await page.evaluate(() => {
  const input = document.querySelector('#wayfinder-name')
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'PLATE')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await click('Continue with')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Enter Voxels')),
  { timeout: 60_000 },
)
await click('Enter Voxels')
await page.waitForFunction('!!window.__wally && !!window.__wally.wildlife && window.__wally.wildlife.animals.length > 0', {
  timeout: 120_000,
})
await page.waitForFunction('!!window.__wally.player && !!window.__wally.player.parent', { timeout: 60_000 })
await sleep(2500)

const gl = await page.evaluate(() => {
  const context = window.__wally.renderer.getContext()
  const debug = context.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
    vendor: debug ? context.getParameter(debug.UNMASKED_VENDOR_WEBGL) : 'unknown',
  }
})
console.log('gl:', JSON.stringify(gl))

/* Live cost: what the game's own camera draws, on the frame after this runs.
 * Sampled a few times because `info.render` is per-frame and a frame that
 * happened to cull differently is not the number worth quoting. */
const cost = await page.evaluate(async () => {
  const samples = []
  for (let i = 0; i < 12; i++) {
    await new Promise(requestAnimationFrame)
    const info = window.__wally.renderer.info
    samples.push({ calls: info.render.calls, triangles: info.render.triangles })
  }
  const info = window.__wally.renderer.info
  const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[samples.length >> 1]
  return {
    drawCalls: median('calls'),
    triangles: median('triangles'),
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : null,
  }
})
console.log('live cost:', JSON.stringify(cost))

/* Frame rate, over four seconds of the real render loop. */
const fps = await page.evaluate(
  () =>
    new Promise(resolve => {
      const frames = []
      let last = performance.now()
      const started = last
      const tick = now => {
        frames.push(now - last)
        last = now
        if (now - started < 4000) requestAnimationFrame(tick)
        else {
          const sorted = frames.slice(1).sort((a, b) => a - b)
          const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
          resolve({
            frames: sorted.length,
            fps: Number((1000 / mean).toFixed(1)),
            medianMs: Number(sorted[sorted.length >> 1].toFixed(2)),
            worstMs: Number(sorted[sorted.length - 1].toFixed(2)),
          })
        }
      }
      requestAnimationFrame(tick)
    }),
)
console.log('fps:', JSON.stringify(fps))

/* Navigation. Pathed, not eyeballed. */
const nav = await page.evaluate(
  (stand, paths) => {
    const { nav, player } = window.__wally
    const vec = (x, z) => player.position.clone().set(x, 0, z)
    return {
      stand: stand.map(([name, x, z]) => ({ name, x, z, blocked: nav.blocked(x, z) })),
      paths: paths.map(([name, ax, az, bx, bz]) => {
        const route = nav.findPath(vec(ax, az), vec(bx, bz))
        if (!route) return { name, ok: false, waypoints: 0, arrives: null }
        const end = route[route.length - 1]
        return {
          name,
          ok: true,
          waypoints: route.length,
          arrives: Number(Math.hypot(end.x - bx, end.z - bz).toFixed(2)),
        }
      }),
      obstacles: nav.obstacles.length,
    }
  },
  STAND,
  PATHS,
)
const stuck = nav.stand.filter(s => s.blocked)
const unreachable = nav.paths.filter(p => !p.ok)
console.log(`nav: ${nav.obstacles} obstacles, ${nav.stand.length - stuck.length}/${nav.stand.length} stand points open, ${nav.paths.length - unreachable.length}/${nav.paths.length} routes connect`)
for (const s of stuck) console.log(`  BLOCKED ${s.name} (${s.x}, ${s.z})`)
for (const p of unreachable) console.log(`  NO ROUTE ${p.name}`)

/* One offscreen renderer for the whole run: a WebGL context per plate
 * exhausts the browser's context pool after about sixteen of them. */
await page.evaluate(() => {
  const live = window.__wally.renderer
  const Renderer = live.constructor
  const canvas = document.createElement('canvas')
  canvas.width = 1440
  canvas.height = 900
  const renderer = new Renderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(1440, 900, false)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = live.shadowMap.type
  const camera = window.__wally.camera.clone()
  camera.far = 900
  camera.near = 0.1
  window.__plate = {
    shoot(pos, look, fov) {
      const scene = window.__wally.player.parent
      camera.fov = fov
      camera.aspect = 1440 / 900
      camera.updateProjectionMatrix()
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      renderer.render(scene, camera)
      return {
        url: canvas.toDataURL('image/png'),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      }
    },
    dispose() {
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
})

const report = []
for (const plate of PLATES) {
  if (FILTER && !plate.name.includes(FILTER)) continue
  const started = Date.now()
  const shot = await page.evaluate(
    (pos, look, fov) => window.__plate.shoot(pos, look, fov),
    plate.pos,
    plate.look,
    plate.fov,
  )
  const file = path.join(OUT, `${plate.name}.png`)
  await fs.writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'))
  report.push({ name: plate.name, calls: shot.calls, triangles: shot.triangles, ms: Date.now() - started })
  console.log(`${plate.name.padEnd(24)} ${String(shot.calls).padStart(5)} calls ${String(shot.triangles).padStart(8)} tris  ${file}`)
}

await page.evaluate(() => window.__plate.dispose())
await fs.writeFile(
  path.join(OUT, 'report.json'),
  JSON.stringify({ gl, cost, fps, nav, plates: report, errors }, null, 2),
)
if (errors.length) console.log('page errors:', errors.slice(0, 6).join(' | '))
await browser.close()
