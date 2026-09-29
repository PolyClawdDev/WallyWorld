/*
 * Art plates: fixed camera angles on the running world, so a change to the
 * town, the trees or an NPC can be looked at instead of assumed.
 *
 * The live render loop owns the game camera, so this script does not fight it.
 * It renders the *same scene* through its own offscreen renderer and its own
 * camera, which is what makes a plate repeatable: the same viewpoint before and
 * after a change, whatever the player happened to be doing.
 *
 * Usage:
 *   node scripts/shot-art.mjs <outDir> [nameFilter]
 *   UI=http://127.0.0.1:5251 node scripts/shot-art.mjs screenshots/after
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI ?? 'http://127.0.0.1:5251'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/art'
const FILTER = process.argv[3] ?? ''

/* Every plate: where the lens sits, what it looks at, and how wide.
 * Positions are world metres, the same numbers townData.ts and wildlife.ts use. */
const PLATES = [
  // --- the town, from a few angles -----------------------------------------
  { name: 'town-north', pos: [0, 62, 96], look: [0, 4, 6], fov: 52 },
  { name: 'town-southeast', pos: [78, 54, -74], look: [10, 4, -8], fov: 55 },
  { name: 'town-plaza-street', pos: [-4, 6.5, 40], look: [0, 3.5, 6], fov: 60 },
  { name: 'town-canal', pos: [58, 18, 34], look: [34, 2, 4], fov: 58 },
  { name: 'town-star-quarter', pos: [-96, 34, 96], look: [-58, 5, 58], fov: 55 },

  // --- one plate per rebuilt building, three-quarter from the door side ----
  { name: 'b-hearth-inn', pos: [-28, 9, 2], look: [-17, 3, 16], fov: 45 },
  { name: 'b-town-hall', pos: [30, 10, 2], look: [17, 3, 16], fov: 45 },
  { name: 'b-bakery', pos: [-28, 8, -31], look: [-17, 3, -17], fov: 45 },
  { name: 'b-stable', pos: [29, 8, -31], look: [17, 3, -17], fov: 45 },
  { name: 'b-potion-shop', pos: [38, 9, -30], look: [50, 3, -16], fov: 45 },
  { name: 'b-workshop', pos: [38, 10, 4], look: [50, 3, 18], fov: 45 },
  { name: 'b-market-hall', pos: [86, 11, -14], look: [72, 3.5, 0], fov: 47 },
  { name: 'b-post-office', pos: [38, 9, 36], look: [50, 3, 50], fov: 45 },
  { name: 'b-archive', pos: [-72, 13, 29], look: [-59, 5, 43], fov: 47 },
  { name: 'b-observatory', pos: [-86, 13, 56], look: [-72, 4.5, 70], fov: 47 },
  { name: 'b-garden-house', pos: [-54, 8, 62], look: [-42, 3, 76], fov: 45 },
  { name: 'b-spell-tower', pos: [-94, 15, 38], look: [-82, 6, 52], fov: 50 },
  { name: 'b-conservatory', pos: [-28, 9, 60], look: [-15, 3.5, 74], fov: 46 },
  { name: 'b-weaver', pos: [62, 9, 58], look: [74, 3, 72], fov: 45 },
  { name: 'b-cartwright', pos: [71, 9, -68], look: [83, 3, -54], fov: 45 },
  { name: 'b-river-chapel', pos: [-12, 10, -82], look: [0, 4, -68], fov: 46 },
  { name: 'b-fisher-shed', pos: [41, 8, -83], look: [52, 2.5, -70], fov: 45 },

  // --- service NPCs, close enough to read an emblem -----------------------
  { name: 'npc-mira', pos: [3.5, 3.0, 12.4], look: [3.5, 2.3, 5.2], fov: 32 },
  { name: 'npc-lyra', pos: [-52, 3.0, 43.2], look: [-52, 2.2, 36], fov: 32 },
  { name: 'npc-vellum', pos: [65, 3.0, 0.2], look: [65, 2.3, -7], fov: 32 },
  { name: 'npc-sable', pos: [43, 3.0, -1.8], look: [43, 2.3, -9], fov: 32 },
  { name: 'npc-bronze', pos: [43, 3.2, 18.2], look: [43, 2.4, 11], fov: 32 },
  { name: 'npc-pip', pos: [43, 2.9, 50.2], look: [43, 2.1, 43], fov: 32 },
  { name: 'npc-astra', pos: [-68, 3.2, 68.2], look: [-68, 2.4, 61], fov: 32 },
  { name: 'npc-nell', pos: [-10, 2.9, 17.2], look: [-10, 2.1, 10], fov: 32 },

  // --- the green: trees, and animals on open ground ------------------------
  { name: 'wildwood-over', pos: [-58, 78, -14], look: [-58, 0, -58], fov: 60 },
  { name: 'brasswood-over', pos: [78, 74, -36], look: [78, 0, -80], fov: 60 },
  { name: 'brasswood-ground', pos: [56, 3.2, -60], look: [78, 14, -80], fov: 66 },
  /* `wildwood-ground`, `wildwood-canopy-up` and `brasswood-canopy-up` used to
   * sit here. All three put the lens inside a trunk or a canopy and rendered a
   * flat wall of leaf cubes, which is worse than no plate at all: the trees
   * grew tall enough that the positions chosen for them are now underground
   * foliage. The verified replacements are in the block below. */
  { name: 'meadow-lantern', pos: [28, 22, 104], look: [28, 2, 78], fov: 58 },

  /* --- the green, framed to answer the two things actually asked ----------
   * `wildwood-ground` and `*-canopy-up` above put the lens INSIDE a canopy,
   * which renders a wall of leaf cubes and shows nothing. These sit outside
   * the wood and look in, low enough that a 39m titan pine is read against
   * the ground rather than from above. Ground plane is 220m across (townData
   * `ground`), so a camera out at 108 still has world under it.
   * Tallest trees at the time of writing: 39.2m at (-36,-63), 33.5m at
   * (-34,-44), 32.9m at (-54,-43) and (-66,-38); ironbark 33.3m at (80,-85). */
  { name: 'green-wildwood-ne', pos: [-14, 18, -12], look: [-50, 14, -56], fov: 58 },
  { name: 'green-wildwood-south', pos: [-52, 11, -104], look: [-50, 17, -60], fov: 60 },
  { name: 'green-wildwood-west', pos: [-104, 9, -40], look: [-56, 18, -56], fov: 58 },
  { name: 'green-wildwood-sw', pos: [-96, 15, -94], look: [-56, 15, -56], fov: 58 },
  { name: 'green-brasswood-sw', pos: [38, 13, -104], look: [76, 16, -80], fov: 58 },
  { name: 'green-brasswood-ne', pos: [108, 12, -46], look: [78, 16, -80], fov: 58 },
  /* Inside the Wildwood's own clearing — `planting.wildwood.clearing` keeps 13m
   * around the heart unplanted — at eye height, which is where the animals are. */
  { name: 'green-wildwood-clearing', pos: [-44, 5, -50], look: [-62, 2.5, -66], fov: 64 },
  { name: 'trail-out-of-town', pos: [-14, 12, 4], look: [-46, 2, -40], fov: 62 },
  { name: 'world-over', pos: [0, 210, 40], look: [0, 0, -6], fov: 62 },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await fs.mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
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
// Software WebGL takes its time. Poll for the probe rather than sleeping blind.
await page.waitForFunction('!!window.__wally && !!window.__wally.wildlife && window.__wally.wildlife.animals.length > 0', {
  timeout: 180_000,
})
// Let the first frames settle so shadow maps and instanced colours are uploaded.
await page.waitForFunction('!!window.__wally.player && window.__wally.player.parent', { timeout: 60_000 })
await sleep(2500)

const stats = await page.evaluate(() => {
  const info = window.__wally.renderer.info
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : null,
  }
})
console.log('live renderer:', JSON.stringify(stats))

/* One offscreen renderer for the whole run: creating a WebGL context per plate
 * exhausts the browser's context pool after about sixteen of them. */
/* The page is a bundle, so `import('three')` has no bare specifier to resolve.
 * The classes are taken off the live objects instead, which is also a guarantee
 * they are the same Three.js the world is built with. */
await page.evaluate(() => {
  const live = window.__wally.renderer
  const Renderer = live.constructor
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 800
  const renderer = new Renderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(1280, 800, false)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = live.shadowMap.type
  const camera = window.__wally.camera.clone()
  camera.far = 620
  camera.near = 0.1
  window.__plate = {
    shoot(pos, look, fov) {
      const scene = window.__wally.player.parent
      camera.fov = fov
      camera.aspect = 1280 / 800
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
  const ms = Date.now() - started
  report.push({ name: plate.name, calls: shot.calls, triangles: shot.triangles, ms })
  console.log(`${plate.name.padEnd(22)} ${String(shot.calls).padStart(5)} calls ${String(shot.triangles).padStart(8)} tris ${ms}ms  ${file}`)
}

await fs.writeFile(path.join(OUT, 'plates.json'), JSON.stringify({ live: stats, plates: report, errors }, null, 2))
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '))
await browser.close()
