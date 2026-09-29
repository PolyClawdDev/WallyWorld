/*
 * Plates of the spring arm, shot through the LIVE game camera.
 *
 * Nothing here uses an offscreen camera: the wayfinder is put down on real
 * standing ground, the render loop is left to settle, and the page canvas is
 * captured — so every plate is the third-person rig doing its own job, spring
 * arm included, and the reported lens position is where the arm actually chose
 * to sit. Alongside each plate it prints the boom, whether the lens is in wood
 * according to the real voxels, and how the lens height compares to the top of
 * the canopy over the wayfinder, so a plate that is "above the treetops" says so
 * in numbers as well as in pixels.
 *
 * The walk plate also measures the damping IN THE ENGINE rather than in a Node
 * model: the wayfinder is driven across the wood's edge one animation frame at a
 * time and the largest single-frame movement of the lens is recorded.
 *
 * Runs Chrome on the real GL backend — no --use-angle=swiftshader, which
 * renders this world at about 3fps and would make the frame rate meaningless.
 *
 * Usage:
 *   NODE_ENV=development npx vite build --mode development --outDir dist-dev
 *   node scripts/shot-springarm.mjs dist-dev screenshots/springarm [nameFilter]
 *
 * NODE_ENV matters and is not optional: `--mode development` on its own leaves
 * vite's isProduction true here, which strips `import.meta.env.DEV` blocks and
 * with them `window.__wally` — the build succeeds and every wait below then
 * times out after four minutes against a world that is running perfectly well.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

const DIST = process.argv[2] ?? 'dist-dev'
const OUT = process.argv[3] ?? 'screenshots/springarm'
const FILTER = process.argv[4] ?? ''
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/*
 * `zoomOut`/`zoomIn` are presses of the real zoom keys, `yawLeft` of the real
 * orbit keys, so the rig is driven the way a player drives it.
 */
const PLATES = [
  /* 1. Maximum zoom deep inside the wildwood. The case that used to give an
   *    11.1m boom where open ground gives 35.8m. */
  { name: 'wildwood-maxzoom', at: [-57, -59], zoomOut: 22 },
  { name: 'wildwood-maxzoom-yawed', at: [-57, -59], zoomOut: 22, yawLeft: 10 },
  /* 2. Beside the biggest trunk in the world with the orbit yawed into it: the
   *    2.1m collapse. The trunk is at 69.6,-77.7 and this is the closest the
   *    navigation grid lets the wayfinder stand to it. */
  { name: 'titanpine-yawed', at: [73.1, -75.7], zoomIn: 8, yawLeft: 8 },
  { name: 'titanpine-yawed-more', at: [73.1, -75.7], zoomIn: 8, yawLeft: 16 },
  { name: 'titanpine-midzoom', at: [73.1, -75.7], zoomOut: 4, yawLeft: 12 },
  /* 3. Open ground, to prove nothing regressed where there is no wood. Every
   *    plate starts from the zoom's near stop, so a plate with no `zoomOut` is
   *    minimum zoom, not the zoom the game opens on. */
  { name: 'open-maxzoom', at: [91.3, -11.5], zoomOut: 22 },
  { name: 'open-midzoom', at: [91.3, -11.5], zoomOut: 6 },
  { name: 'open-minzoom', at: [91.3, -11.5] },
]

/*
 * The wood/open-ground boundary, walked. `from` is open ground, `to` is inside
 * the wildwood; the wayfinder is moved along the line one frame at a time at a
 * walking 3.2m/s and the lens is sampled every frame.
 */
const WALKS = [
  { name: 'edge-walk-default', from: [-30, -34], to: [-52, -56] },
  { name: 'edge-walk-maxzoom', from: [-30, -34], to: [-52, -56], zoomOut: 22 },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await fs.mkdir(OUT, { recursive: true })
const { base: url, close } = await serveDist(DIST)
console.log(`serving ${DIST} at ${url}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  /* The world takes a while to build headlessly and puppeteer's default
   * 180s protocol timeout kills the wait for it before the wait's own. */
  protocolTimeout: 600_000,
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

/* The plates are all inside the wood, where the arm does the most work, so the
 * frame rate is measured there rather than on the plaza. */
await page.evaluate(() => window.__wally.player.position.set(-57, 0, -59))
await sleep(1500)
const warm = await measureFps()
const run = await measureFps()
const fps = (run.frames / run.ms) * 1000
console.log(`fps in the wildwood: warm-up ${((warm.frames / warm.ms) * 1000).toFixed(1)}, measured ${fps.toFixed(1)} over ${run.frames} frames`)

const live = await page.evaluate(() => {
  const info = window.__wally.renderer.info
  const scene = window.__wally.player.parent
  const wildscape = scene.getObjectByName('wildscape')
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    crowns: wildscape && wildscape.userData.canopy ? wildscape.userData.canopy.crowns.length : null,
  }
})
console.log('live renderer:', JSON.stringify(live))

/* Two panels that are artefacts of the harness rather than of the rig: the
 * offline notice, because there is no world server behind a static build, and
 * the death panel, because the wildlife keeps killing a level-1 wayfinder who
 * is standing still in a hunting region. Both sit over the middle of the frame,
 * which is where the wayfinder is. */
/* Hidden by an observer rather than once, because React re-renders the panel
 * and a re-render restores the inline style — which is how an earlier pass
 * produced plates with "BEAR killed you" across the middle of them. */
const hideNotices = () =>
  page.evaluate(() => {
    const hide = () => {
      const matches = [...document.querySelectorAll('div, section, aside')].filter(
        element =>
          /Could not reach the shared world|YOU WENT DOWN|killed you/.test(element.textContent ?? '') &&
          !element.querySelector('canvas'),
      )
      const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)))
      /* Hidden with !important rather than removed. Removing it takes a node
       * React owns out from under it, which unmounts the world and takes
       * window.__wally with it — the harness then fails on the next plate. */
      for (const element of innermost) {
        if (element.dataset.plateHidden === '1') continue
        element.dataset.plateHidden = '1'
        element.style.setProperty('visibility', 'hidden', 'important')
        element.style.setProperty('opacity', '0', 'important')
      }
    }
    hide()
    if (window.__plateHider) return
    /* childList only, and each element hidden once. Observing attributes as
     * well meant the hide mutated what it was observing, and the feedback loop
     * left the panel on screen anyway. */
    window.__plateHider = new MutationObserver(hide)
    window.__plateHider.observe(document.body, { childList: true, subtree: true })
    setInterval(hide, 120)
  })

const lensState = () =>
  page.evaluate(() => {
    const camera = window.__wally.camera
    const player = window.__wally.player
    const wildscape = player.parent.getObjectByName('wildscape')
    const canopy = wildscape ? wildscape.userData.canopy : null
    /* The canopy over the WAYFINDER's own square metre is nearly always zero —
     * they are standing in a gap between crowns, that is what standing is — so
     * what says whether the lens is over the treetops is the tallest crown
     * anywhere near the lens. */
    let nearby = 0
    if (canopy) {
      for (const crown of canopy.crowns) {
        if (Math.hypot(crown.x - camera.position.x, crown.z - camera.position.z) > 12) continue
        nearby = Math.max(nearby, crown.top)
      }
    }
    return {
      camera: [camera.position.x, camera.position.y, camera.position.z].map(v => Number(v.toFixed(2))),
      player: [player.position.x, player.position.z].map(v => Number(v.toFixed(2))),
      boom: Number(camera.position.distanceTo(player.position).toFixed(2)),
      lensInWood: canopy ? canopy.inWood(camera.position.x, camera.position.y, camera.position.z) : null,
      crownTopWithin12m: Number(nearby.toFixed(1)),
      overTheTreetops: nearby > 0 && camera.position.y > nearby,
    }
  })

/* Zoom and orbit are live state that outlives a plate, so every plate starts by
 * winding the zoom back to its stop and recentring the orbit. Without this the
 * "default zoom" plate inherits whatever the previous plate asked for.
 *
 * The position is set twice, before and after the ease, because the wildlife in
 * these regions will kill a level-1 wayfinder and the respawn puts them back on
 * the plaza — which is how an earlier pass produced three titan-pine plates
 * taken in the middle of town. Whatever the second set produces is what the
 * plate reports, so the framing cannot lie about where it was taken. */
const stand = async plate => {
  await page.evaluate(at => window.__wally.player.position.set(at[0], 0, at[1]), plate.at)
  await page.focus('canvas')
  await page.keyboard.press('Space')
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp')
  for (let i = 0; i < (plate.zoomIn ?? 0); i++) await page.keyboard.press('ArrowUp')
  for (let i = 0; i < (plate.zoomOut ?? 0); i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < (plate.yawLeft ?? 0); i++) await page.keyboard.press('ArrowLeft')
  await sleep(1800)
  /* Up to four goes at being in the right place when the shutter opens. A bear
   * can kill a level-1 wayfinder inside a second and the respawn is on the
   * plaza, so a plate that reports the plaza is a plate of the plaza. */
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.evaluate(at => window.__wally.player.position.set(at[0], 0, at[1]), plate.at)
    await sleep(700)
    const drift = await page.evaluate(
      at => Math.hypot(window.__wally.player.position.x - at[0], window.__wally.player.position.z - at[1]),
      plate.at,
    )
    if (drift < 2) return
  }
  console.log(`  (${plate.name ?? 'walk'}: the wayfinder would not stay put)`)
}

const report = []
for (const plate of PLATES) {
  if (FILTER && !plate.name.includes(FILTER)) continue
  await stand(plate)
  await hideNotices()
  const state = await lensState()
  const file = path.join(OUT, `${plate.name}.png`)
  await page.screenshot({ path: file })
  report.push({ name: plate.name, file, ...state })
  console.log(
    `${plate.name.padEnd(24)} player ${JSON.stringify(state.player)} lens ${JSON.stringify(state.camera)} ` +
    `boom ${String(state.boom).padStart(6)}m  inWood=${state.lensInWood} crownTop<12m=${state.crownTopWithin12m}m overTheTreetops=${state.overTheTreetops}`,
  )
}

/* --- the boundary walk, frame by frame -------------------------------- */
for (const walk of WALKS) {
  if (FILTER && !walk.name.includes(FILTER)) continue
  await stand({ at: walk.from, zoomOut: walk.zoomOut })
  const walked = await page.evaluate(
    (from, to) =>
      new Promise(resolve => {
        const wally = window.__wally
        const player = wally.player
        const camera = wally.camera
        const wildscape = player.parent.getObjectByName('wildscape')
        const canopy = wildscape ? wildscape.userData.canopy : null
        const span = Math.hypot(to[0] - from[0], to[1] - from[1])
        const seconds = span / 3.2
        const started = performance.now()
        let last = null
        let biggest = 0
        let over = 0
        let insideWood = 0
        let frames = 0
        let lowest = Infinity
        const tick = () => {
          const t = Math.min(1, (performance.now() - started) / (seconds * 1000))
          player.position.x = from[0] + (to[0] - from[0]) * t
          player.position.z = from[1] + (to[1] - from[1]) * t
          const at = camera.position.clone()
          if (last) {
            const jump = at.distanceTo(last)
            biggest = Math.max(biggest, jump)
            if (jump > 0.5) over += 1
            frames += 1
            lowest = Math.min(lowest, at.distanceTo(player.position))
            if (canopy && canopy.inWood(at.x, at.y, at.z)) insideWood += 1
          }
          last = at
          if (t < 1) requestAnimationFrame(tick)
          else resolve({ frames, biggest, over, insideWood, shortestBoom: lowest, seconds })
        }
        requestAnimationFrame(tick)
      }),
    walk.from,
    walk.to,
  )
  await sleep(400)
  await hideNotices()
  const state = await lensState()
  const file = path.join(OUT, `${walk.name}.png`)
  await page.screenshot({ path: file })
  report.push({ name: walk.name, file, walked, ...state })
  console.log(
    `${walk.name.padEnd(24)} ${walked.frames} frames over ${walked.seconds.toFixed(1)}s: ` +
    `biggest single-frame lens move ${walked.biggest.toFixed(2)}m, ${walked.over} frames over 0.5m, ` +
    `shortest boom ${walked.shortestBoom.toFixed(2)}m, frames with the lens in wood ${walked.insideWood}`,
  )
}

await fs.writeFile(
  path.join(OUT, 'springarm.json'),
  JSON.stringify({ gl, fps, warmupFps: (warm.frames / warm.ms) * 1000, live, plates: report, errors }, null, 2),
)
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '))
await browser.close()
await close()
