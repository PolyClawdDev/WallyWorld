/*
 * Plates of the wood, plus an honest frame rate.
 *
 * Two things this does that `shot-art.mjs` does not:
 *
 *   1. IT RUNS CHROME ON THE REAL GL BACKEND. No `--use-angle=swiftshader`.
 *      SwiftShader renders this world at about 3fps headless and the default
 *      backend reaches the real GPU at about 60, so a SwiftShader number says
 *      nothing at all about how the game runs.
 *   2. IT REFUSES A PLATE WHOSE LENS IS INSIDE A TREE. The wildscape publishes
 *      `userData.canopy.inWood`, so every camera position and look point is
 *      checked against the real voxels before the shutter opens, and a plate
 *      that would render a wall of leaf cubes is reported as SKIPPED instead of
 *      being written out and listed as evidence.
 *
 * Usage:
 *   npx vite build --mode development --outDir dist-dev
 *   node scripts/shot-wood.mjs dist-dev screenshots/wood [nameFilter]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

const DIST = process.argv[2] ?? 'dist-dev'
const OUT = process.argv[3] ?? 'screenshots/wood'
const FILTER = process.argv[4] ?? ''
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/* Camera positions are world metres. The eye-height ones come out of
 * `scripts/tmp-vantage.ts`, which searches for positions that are legal standing
 * ground, clear of foliage up to 4m, and have the most wood around them. */
const PLATES = [
  // --- a wood at a player's eye height ------------------------------------
  { name: 'eye-wildwood', pos: [-57, 1.7, -59], look: [-44, 7, -45], fov: 70 },
  { name: 'eye-wildwood-west', pos: [-60, 1.7, -61], look: [-74, 6, -50], fov: 70 },
  /* The Brasswood is a small region under very large trees, so an eye-height lens
   * inside it has a crown three metres in front of it whichever way it faces.
   * This one looks back out along the trail instead, which is the only framing in
   * there that reads. */
  { name: 'eye-brasswood-trail', pos: [65, 1.7, -72], look: [50, 6, -62], fov: 70 },

  // --- open ground with trees on it ---------------------------------------
  { name: 'country-scatter', pos: [-4, 38, 94], look: [-54, 2, 36], fov: 58, noFog: true },
  { name: 'country-avenue', pos: [-48, 2, 4], look: [-48, 7, 58], fov: 70 },
  { name: 'country-town-edge', pos: [-40, 1.8, 30], look: [-58, 5, 60], fov: 72 },
  { name: 'country-south', pos: [8, 14, -30], look: [-16, 4, -58], fov: 62 },

  // --- the whole map, for "a bit of everywhere" ---------------------------
  { name: 'world-over', pos: [0, 168, 52], look: [0, 0, -8], fov: 62, noFog: true },
  // --- the same framing a previous pass used, for a before/after pair -----
  { name: 'green-wildwood-ne', pos: [-14, 18, -12], look: [-50, 14, -56], fov: 58 },
]

/*
 * Walk-throughs, shot through the LIVE game camera rather than an offscreen one.
 *
 * The wayfinder is put down at a real standing position, the render loop is left
 * to settle, and the page canvas is captured — so what comes out is the third
 * person orbit doing its own job, canopy pull-in included, and the reported
 * camera position is where the rig actually chose to sit.
 */
const WALKS = [
  { name: 'walk-wildwood-deep', at: [-57, -59], zoomOut: 5 },
  /* Asking for maximum zoom from inside the wildwood: the boom shortens because
   * there is genuinely nowhere out there that is not canopy. */
  { name: 'walk-wildwood-maxzoom', at: [-57, -59], zoomOut: 22 },
  /* The same maximum zoom on open ground, where nothing shortens it. */
  { name: 'walk-country-maxzoom', at: [91.3, -11.5], zoomOut: 22 },
  { name: 'walk-lone-elder', at: [91.3, -11.5], zoomOut: 7, yawLeft: 14 },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await fs.mkdir(OUT, { recursive: true })
const { base: url, close } = await serveDist(DIST)
console.log(`serving ${DIST} at ${url}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Deliberately NO --use-angle=swiftshader. See the header.
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error' && !/favicon|Failed to load resource|WebSocket|websocket/i.test(m.text())) errors.push(m.text())
})

const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

await page.goto(url, { waitUntil: 'domcontentloaded' })
await click('Enter world')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
  { timeout: 60_000 },
)
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
  timeout: 240_000,
})
await page.waitForFunction('!!window.__wally.player && window.__wally.player.parent', { timeout: 60_000 })
await sleep(3000)

const gl = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  const info = context.getExtension('WEBGL_debug_renderer_info')
  return info ? `${context.getParameter(info.UNMASKED_VENDOR_WEBGL)} / ${context.getParameter(info.UNMASKED_RENDERER_WEBGL)}` : 'unknown'
})
console.log(`GL backend: ${gl}`)

/* Frame rate off the live loop: count real animation frames over a wall-clock
 * window, twice, so a first slow window from shader compilation is visible. */
const measureFps = () =>
  page.evaluate(
    () =>
      new Promise(resolve => {
        let frames = 0
        const started = performance.now()
        const tick = () => {
          frames += 1
          if (performance.now() - started < 4000) requestAnimationFrame(tick)
          else resolve({ frames, ms: performance.now() - started })
        }
        requestAnimationFrame(tick)
      }),
  )
const warm = await measureFps()
const run = await measureFps()
const fps = (run.frames / run.ms) * 1000
console.log(`fps: warm-up ${((warm.frames / warm.ms) * 1000).toFixed(1)}, measured ${fps.toFixed(1)} over ${run.frames} frames`)

const live = await page.evaluate(() => {
  const info = window.__wally.renderer.info
  const scene = window.__wally.player.parent
  const wildscape = scene.getObjectByName('wildscape')
  const stats = wildscape ? wildscape.userData.stats : null
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : null,
    trees: stats ? stats.trees : null,
    country: stats ? stats.country : null,
    obstacles: stats ? stats.obstacles : null,
    crowns: wildscape && wildscape.userData.canopy ? wildscape.userData.canopy.crowns.length : null,
  }
})
console.log('live renderer:', JSON.stringify(live))

await page.evaluate(() => {
  const liveRenderer = window.__wally.renderer
  const Renderer = liveRenderer.constructor
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  const renderer = new Renderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(1280, 800, false)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = liveRenderer.shadowMap.type
  const camera = window.__wally.camera.clone()
  camera.far = 620
  camera.near = 0.1
  const scene = window.__wally.player.parent
  const wildscape = scene.getObjectByName('wildscape')
  const canopy = wildscape ? wildscape.userData.canopy : null
  window.__plate = {
    /**
     * Is this lens inside a trunk or a canopy, or close enough to one that the
     * near field is a wall of leaf? Asked of the real voxels. The samples along
     * the view direction are the point: a lens 40cm off a crown renders one flat
     * dark polygon, which is as useless a plate as being inside it.
     */
    check(pos, look) {
      if (!canopy) return 'no canopy data published'
      if (canopy.inWood(pos[0], pos[1], pos[2])) return 'LENS INSIDE WOOD'
      const dx = look[0] - pos[0]
      const dy = look[1] - pos[1]
      const dz = look[2] - pos[2]
      const span = Math.hypot(dx, dy, dz) || 1
      for (const ahead of [0.8, 1.6, 2.4, 3.2, 4]) {
        const t = ahead / span
        if (canopy.inWood(pos[0] + dx * t, pos[1] + dy * t, pos[2] + dz * t)) return `WOOD ${ahead}m IN FRONT OF THE LENS`
      }
      return ''
    },
    shoot(pos, look, fov, noFog) {
      camera.fov = fov
      camera.aspect = 1280 / 800
      camera.updateProjectionMatrix()
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      // An overhead plate is entirely inside the scene's distance fog, which
      // renders a flat grey rectangle. Lifted for the shot and put straight back.
      const fog = scene.fog
      if (noFog) scene.fog = null
      renderer.render(scene, camera)
      scene.fog = fog
      return { url: canvas.toDataURL('image/png'), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
    },
  }
})

const report = []
for (const plate of PLATES) {
  if (FILTER && !plate.name.includes(FILTER)) continue
  const complaint = await page.evaluate((pos, look) => window.__plate.check(pos, look), plate.pos, plate.look)
  if (complaint) {
    console.log(`${plate.name.padEnd(22)} SKIPPED — ${complaint}`)
    report.push({ name: plate.name, skipped: complaint })
    continue
  }
  const shot = await page.evaluate(
    (pos, look, fov, noFog) => window.__plate.shoot(pos, look, fov, noFog),
    plate.pos,
    plate.look,
    plate.fov,
    !!plate.noFog,
  )
  const file = path.join(OUT, `${plate.name}.png`)
  await fs.writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'))
  report.push({ name: plate.name, calls: shot.calls, triangles: shot.triangles, file })
  console.log(`${plate.name.padEnd(22)} ${String(shot.calls).padStart(5)} calls ${String(shot.triangles).padStart(9)} tris  ${file}`)
}

/* --- the live walk-throughs ------------------------------------------- */
for (const walk of WALKS) {
  if (FILTER && !walk.name.includes(FILTER)) continue
  await page.evaluate(at => {
    window.__wally.player.position.set(at[0], 0, at[1])
  }, walk.at)
  // Recentre the orbit behind the wayfinder, then zoom with the real keyboard.
  await page.focus('canvas')
  await page.keyboard.press('Space')
  for (let i = 0; i < (walk.zoomIn ?? 0); i++) await page.keyboard.press('ArrowUp')
  for (let i = 0; i < (walk.zoomOut ?? 0); i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < (walk.yawLeft ?? 0); i++) await page.keyboard.press('ArrowLeft')
  // Long enough for the ease on zoom, yaw and position to finish.
  await sleep(2200)
  /* There is no world server behind this harness, so the client's "could not
   * reach the shared world" notice sits over the middle of every plate. Hidden
   * for the shot; it is an artefact of running the build offline, not of the
   * change under test. */
  await page.evaluate(() => {
    const matches = [...document.querySelectorAll('div, section, aside')].filter(
      element => /Could not reach the shared world/.test(element.textContent ?? '') && !element.querySelector('canvas'),
    )
    // The innermost match only: an ancestor filter would take the whole HUD with it.
    const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)))
    for (const element of innermost) element.style.visibility = 'hidden'
  })
  const state = await page.evaluate(() => {
    const camera = window.__wally.camera
    const player = window.__wally.player
    const wildscape = window.__wally.player.parent.getObjectByName('wildscape')
    const canopy = wildscape ? wildscape.userData.canopy : null
    return {
      camera: [camera.position.x, camera.position.y, camera.position.z].map(v => Number(v.toFixed(2))),
      player: [player.position.x, player.position.z].map(v => Number(v.toFixed(2))),
      boom: Number(camera.position.distanceTo(player.position).toFixed(2)),
      lensInWood: canopy ? canopy.inWood(camera.position.x, camera.position.y, camera.position.z) : null,
      eyeInWood: canopy ? canopy.inWood(player.position.x, 1.9, player.position.z) : null,
    }
  })
  const file = path.join(OUT, `${walk.name}.png`)
  await page.screenshot({ path: file })
  report.push({ name: walk.name, live: true, file, ...state })
  console.log(
    `${walk.name.padEnd(26)} player ${JSON.stringify(state.player)} lens ${JSON.stringify(state.camera)} boom ${state.boom}m` +
    `  lensInWood=${state.lensInWood} eyeInWood=${state.eyeInWood}  ${file}`,
  )
}

await fs.writeFile(
  path.join(OUT, 'wood.json'),
  JSON.stringify({ gl, fps, warmupFps: (warm.frames / warm.ms) * 1000, live, plates: report, errors }, null, 2),
)
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '))
await browser.close()
await close()
