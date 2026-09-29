/*
 * Trade emblem plates: is the art actually on the wall, and can you read it.
 *
 * Framed off the numbers src/npcs.ts mounts from, not by eye, so a plate that
 * comes back empty means the mount is wrong rather than the camera. Every
 * board sits with its foot at 3.2m on the wall that faces its NPC, so each
 * `*-board` plate stands where a player would and looks at that wall.
 *
 * Same GL policy as shot-town.mjs: no `--use-angle=swiftshader`, because
 * Chrome's default backend reaches a real renderer headlessly and SwiftShader
 * renders this town at about three frames a second.
 *
 * Served from a static dev-mode build by default rather than the shared dev
 * server, because three other agents are saving into this tree and their HMR
 * reloads tore down the world mid-run. Point UI at a dev server to override.
 *
 * Usage:
 *   npx vite build --mode development --outDir dist-dev
 *   node scripts/shot-emblems.mjs screenshots/emblems [filter]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

const UI = process.env.UI
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/emblems'
const FILTER = process.argv[3] ?? ''

/* Positions are world metres. Board centres are computed from townData:
 * foot 3.2m, on the wall that faces the NPC. */
const PLATES = [
  /* SABLE. Potion Shop (50, -16), 12x9x17. She stands at (43, -9), behind the
   * shop, so her board is on the +z wall at z = -11.5 — the side she and the
   * street are on.
   *
   * Board 5.44 x 4.27, centred (50, 5.34); the Zcash mark is 2.2 across centred
   * on (48.89, 5.65) and standing 0.33 off the wall; trade badge (51.46, 6.06);
   * status strip 4.92 wide across (50, 3.94). All of it out of the layout in
   * src/npcs.ts, so an empty plate means the mount moved, not the camera. */
  { name: 'sable-board', pos: [50, 5.34, -4.4], look: [50, 5.34, -11.5], fov: 40 },
  { name: 'sable-board-close', pos: [49.4, 5.5, -6.6], look: [49.4, 5.5, -11.5], fov: 46 },
  // Tight on the mark: the plate that has to show two rings and a struck glyph.
  { name: 'sable-zcash-mark', pos: [48.89, 5.65, -6.6], look: [48.89, 5.65, -11.5], fov: 30 },
  { name: 'sable-zcash-rings', pos: [48.89, 5.65, -4.9], look: [48.89, 5.65, -11.5], fov: 24 },
  { name: 'sable-status-strip', pos: [50, 3.94, -7.2], look: [50, 3.94, -11.5], fov: 40 },
  // A player's eye, walking in off the east high street.
  { name: 'sable-eye-approach', pos: [46, 1.7, 2], look: [49.4, 5.2, -11.5], fov: 66 },
  { name: 'sable-eye-standing', pos: [44.5, 1.7, -4.5], look: [49.2, 5.34, -11.5], fov: 62 },
  // Oblique, which is the plate that catches a board sunk into its own wall.
  { name: 'sable-oblique-west', pos: [39, 6.4, -4.6], look: [50, 5.2, -11.5], fov: 52 },
  { name: 'sable-oblique-east', pos: [61, 6.4, -4.6], look: [50, 5.2, -11.5], fov: 52 },
  { name: 'sable-standard', pos: [40.2, 2.5, -3.4], look: [40.2, 2.6, -9], fov: 42 },
  { name: 'sable-whole', pos: [36, 9, 6], look: [50, 8, -16], fov: 60 },

  /* Handedness probes, straight on to one badge, because a mirrored emblem is
   * invisible unless you know which way the authored grid runs. The mortar's
   * pestle leans up to the RIGHT and the tankard's handle is on the RIGHT;
   * either one flipped means Batch.plate() is being fed unreversed rows. */
  { name: 'probe-mortar', pos: [51.31, 5.96, -8.0], look: [51.31, 5.96, -11.5], fov: 30 },
  { name: 'probe-tankard', pos: [-17, 4.97, 8.0], look: [-17, 4.97, 11.5], fov: 30 },

  /* The other trades. All on the door wall, foot at 3.2m. */
  { name: 'bronze-board', pos: [50, 4.6, 4.6], look: [50, 4.6, 13], fov: 42 },
  { name: 'bronze-eye', pos: [45, 1.7, 3], look: [49.6, 4.4, 13], fov: 64 },
  // Straight out from the Post Office door there is a wildscape pine, so this
  // one is framed from where Pip actually stands instead.
  { name: 'pip-board', pos: [44.5, 4.6, 38.5], look: [49.6, 4.6, 45.5], fov: 52 },
  { name: 'pip-eye', pos: [43, 1.7, 41], look: [49.4, 4.4, 45.5], fov: 64 },
  { name: 'nell-board', pos: [-17, 4.6, 3.1], look: [-17, 4.6, 11.5], fov: 42 },
  { name: 'nell-eye', pos: [-12, 1.7, 2], look: [-16.6, 4.4, 11.5], fov: 64 },
  { name: 'lyra-board', pos: [-59, 4.6, 29.1], look: [-59, 4.6, 37.5], fov: 42 },
  { name: 'vellum-board', pos: [72, 4.6, -14.4], look: [72, 4.6, -6], fov: 42 },
  { name: 'astra-board', pos: [-72, 4.6, 55.6], look: [-72, 4.6, 64], fov: 42 },

  /* Standards beside the people, which are the close read at walking height. */
  // Off to the side: the player spawns at (0, 8), square between a head-on
  // camera and Mira's standard.
  { name: 'mira-standard', pos: [5.5, 2.8, 9.5], look: [0.7, 2.6, 5.2], fov: 52 },
  { name: 'nell-standard', pos: [-7.2, 2.5, 4.4], look: [-7.2, 2.6, 10], fov: 42 },
  { name: 'plaza-eye', pos: [0, 1.7, 13], look: [2, 6, -8], fov: 70 },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await fs.mkdir(OUT, { recursive: true })
const served = UI ? null : await serveDist(process.env.DIST ?? 'dist-dev')
const base = UI ?? served.base

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

/* The entry is gated by three screens and a controlled name input. */
const enter = async () => {
  await click('Enter world')
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
    { timeout: 60_000 },
  )
  // Through React's own setter, or the controlled input ignores the value.
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
  await page.waitForFunction('!!window.__wally && !!window.__wally.player && !!window.__wally.player.parent', {
    timeout: 120_000,
  })
  await sleep(2500)
}

await page.goto(base, { waitUntil: 'domcontentloaded' })
await enter()

const gl = await page.evaluate(() => {
  const context = window.__wally.renderer.getContext()
  const debug = context.getExtension('WEBGL_debug_renderer_info')
  return debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown'
})
console.log('gl:', gl)

/* What the emblem group actually built, asked of the live scene rather than
 * inferred from the source. A group that is missing, empty, or holding a
 * texture per sign is all visible from here. */
const audit = await page.evaluate(() => {
  const scene = window.__wally.player.parent
  let group = null
  scene.traverse(node => {
    if (node.name === 'service-emblems') group = node
  })
  if (!group) return { found: false }
  let meshes = 0
  let texts = 0
  let triangles = 0
  group.traverse(node => {
    if (!node.isMesh) return
    meshes += 1
    if (node.name === 'sign-text') texts += 1
    const index = node.geometry.index
    triangles += index ? index.count / 3 : node.geometry.attributes.position.count / 3
  })
  return {
    found: true,
    boxes: group.userData.boxes,
    weldedMeshes: meshes - texts,
    signTexts: texts,
    triangles,
    hasDispose: typeof group.userData.dispose === 'function',
  }
})
console.log('emblem group:', JSON.stringify(audit))

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
  const shot = await page.evaluate(
    (pos, look, fov) => window.__plate.shoot(pos, look, fov),
    plate.pos,
    plate.look,
    plate.fov,
  )
  const file = path.join(OUT, `${plate.name}.png`)
  await fs.writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'))
  report.push({ name: plate.name, calls: shot.calls, triangles: shot.triangles })
  console.log(`${plate.name.padEnd(22)} ${String(shot.calls).padStart(5)} calls ${String(shot.triangles).padStart(8)} tris  ${file}`)
}

await page.evaluate(() => window.__plate.dispose())

/* The chart. Same question as the boards, asked of the map: can you tell which
 * of these people is the Zcash one, and what any of the others do.
 *
 * Three plates. The whole panel, to judge whether the extra labels have made a
 * chart that already carries buildings, districts, regions and trees
 * unreadable. The chart alone, zoomed onto SABLE's quarter — the viewBox is
 * overridden by hand, which holds because the panel's animation frame only
 * rewrites it while FOLLOW ME is on. And the townsfolk list, which is where the
 * trade names and the boxed external mark live. */
// Wider than the 3D plates: the panel is broader than a 1440 viewport, and at
// 1440 the element shots come back with the right-hand column sliced off, which
// is no way to judge whether a legend entry reads.
await page.setViewport({ width: 1800, height: 1000, deviceScaleFactor: 1 })
await click('Map')
await page.waitForFunction(() => !!document.querySelector('.mp-folk'), { timeout: 60_000 })
await sleep(400)

const mapShots = []
const shootElement = async (name, selector) => {
  const element = await page.$(selector)
  if (!element) { mapShots.push({ name, missing: selector }); return }
  const file = path.join(OUT, `${name}.png`)
  await element.screenshot({ path: file })
  const box = await element.boundingBox()
  mapShots.push({ name, width: Math.round(box.width), height: Math.round(box.height) })
  console.log(`${name.padEnd(22)} ${Math.round(box.width)}x${Math.round(box.height)}  ${file}`)
}

await shootElement('map-whole', '.popup')
// SABLE (43, -9) with her neighbours either side, so crowding shows up.
const framed = await page.evaluate(() => {
  const svg = document.querySelector('.popup svg')
  if (!svg) return null
  svg.setAttribute('viewBox', '18 -34 64 50')
  return svg.getAttribute('viewBox')
})
await sleep(200)
await shootElement('map-sable-zoom', '.popup svg')
await page.evaluate(() => document.querySelector('.popup svg')?.setAttribute('viewBox', '-104 -104 208 208'))
await shootElement('map-townsfolk', '.mp-places:last-of-type')
await shootElement('map-legend', '.mp-legend')
console.log('map viewBox override:', framed)
await click('Map')
await sleep(300)

/* Dispose, because this project has shipped three leaks of exactly this kind.
 * Last, because it takes the group apart.
 *
 * renderer.info.memory is the wrong witness on its own: it only counts what
 * has been uploaded to the GPU, so a frustum-culled board looks like a freed
 * one. So every geometry, material and texture the group owns is subscribed to
 * its own dispose event first, and then the group is merely REMOVED from the
 * scene — removal alone has to be enough, because that is the only teardown
 * signal the module gets. Held is what did not fire. */
const leak = await page.evaluate(async () => {
  const scene = window.__wally.player.parent
  let group = null
  scene.traverse(node => {
    if (node.name === 'service-emblems') group = node
  })
  if (!group) return { ok: false, why: 'no group' }
  const owned = { geometries: 0, materials: 0, textures: 0 }
  const freed = { geometries: 0, materials: 0, textures: 0 }
  const watch = (kind, resource) => {
    owned[kind] += 1
    resource.addEventListener('dispose', () => {
      freed[kind] += 1
    })
  }
  group.traverse(node => {
    if (!node.isMesh) return
    watch('geometries', node.geometry)
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      watch('materials', material)
      for (const value of Object.values(material)) {
        if (value && value.isTexture) watch('textures', value)
      }
    }
  })
  group.parent.remove(group)
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  return {
    ok: true,
    owned,
    freed,
    held: {
      geometries: owned.geometries - freed.geometries,
      materials: owned.materials - freed.materials,
      textures: owned.textures - freed.textures,
    },
    gpu: { ...window.__wally.renderer.info.memory },
  }
})
console.log('dispose on removal:', JSON.stringify(leak))

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ gl, audit, leak, plates: report, map: mapShots, errors }, null, 2))
if (errors.length) console.log('page errors:', errors.slice(0, 6).join(' | '))
await browser.close()
await served?.close()
