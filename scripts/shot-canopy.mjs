/*
 * Plates of a HIGH canopy, framed by measurement rather than by hand.
 *
 * The reason this exists next to `shot-wood.mjs`: a hand-typed camera position
 * in a wood is a coin toss, and a previous pass shipped five plates that turned
 * out to be the inside of a crown. So nothing here is authored except intent.
 * Every plate asks the real voxels for its own position and direction:
 *
 *   - EYE plates search for a legal standing position with the most trunks
 *     around it, then pick the compass direction with the longest clear
 *     sightline at 2.7m, and shoot level. If the best direction in the densest
 *     part of the wood is short, the plate says so instead of hiding it.
 *   - The ANIMAL plate finds a real animal inside a wooded hunting region, then
 *     finds a standing position 20-26m from it whose eye-to-flank sightline is
 *     clear, and shoots at the game's own field of view. No zoom.
 *   - The WOOD-FROM-OUTSIDE plates are pulled back and up so the canopy has to
 *     carry the picture.
 *
 * Usage:
 *   npx vite build --mode development --outDir dist-dev
 *   node scripts/shot-canopy.mjs dist-dev screenshots/canopy
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

const DIST = process.argv[2] ?? 'dist-dev'
const OUT = process.argv[3] ?? 'screenshots/canopy'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await fs.mkdir(OUT, { recursive: true })
const { base: url, close } = await serveDist(DIST)
console.log(`serving ${DIST} at ${url}`)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Deliberately NO --use-angle=swiftshader: it renders this world at 3fps.
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
await page.waitForFunction('!!window.__wally.player && !!window.__wally.player.parent', { timeout: 60_000 })
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
const warm = await measureFps()
const run = await measureFps()
const fps = (run.frames / run.ms) * 1000
console.log(`fps: warm-up ${((warm.frames / warm.ms) * 1000).toFixed(1)}, measured ${fps.toFixed(1)} over ${run.frames} frames`)

const live = await page.evaluate(() => {
  const info = window.__wally.renderer.info
  const wildscape = window.__wally.player.parent.getObjectByName('wildscape')
  const stats = wildscape ? wildscape.userData.stats : null
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : null,
    trees: stats ? stats.trees : null,
    corridor: stats ? stats.corridor : null,
    obstacles: stats ? stats.obstacles : null,
    fov: window.__wally.camera.fov,
  }
})
console.log('live renderer:', JSON.stringify(live))

/* --- the offscreen plate rig, plus the searches that frame it --------- */
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
  camera.near = 0.1
  camera.far = 620
  const scene = window.__wally.player.parent
  const wildscape = scene.getObjectByName('wildscape')
  const canopy = wildscape.userData.canopy
  const EYE = 2.7

  /* Deterministic sampler, so re-running this file gives the same plates. */
  let seed = 20260929
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  const clearRay = (x, y, z, dx, dy, dz, span, step = 0.25) => {
    const steps = Math.ceil(span / step)
    for (let i = 1; i <= steps; i++) {
      const t = (i * step) / span
      if (canopy.inWood(x + dx * span * t, y + dy * span * t, z + dz * span * t)) return (i - 1) * step
    }
    return span
  }
  /* A body can stand here: nothing in the column it occupies, at the centre or
   * on its own circumference. The same test verify-canopy.ts runs. */
  const canStand = (x, z) => {
    for (const y of [0.3, 0.9, 1.6, 1.9, 2.7]) {
      for (const offset of [[0, 0], [0.62, 0], [-0.62, 0], [0, 0.62], [0, -0.62]]) {
        if (canopy.inWood(x + offset[0], y, z + offset[1])) return false
      }
    }
    return true
  }

  window.__frame = {
    /**
     * The densest legal standing position within `radius` of a point, and the
     * direction from it with the longest level sightline at eye height.
     *
     * Density is trunks within 30m, because that is what makes a plate look like
     * a wood rather than like a lawn. The direction is chosen for LENGTH, which
     * is the claim being illustrated: this is a wood you can see through.
     */
    eyeShot(cx, cz, radius, minTrunk) {
      /* Sample around the THICKEST PART of the wood, not around the region's
       * nominal heart. Three regions touch the town, and a position picked for
       * trunk count near their edge frames a warehouse wall rather than a wood.
       * The densest crown within `radius` of the heart is, by construction, in
       * the trees. */
      let heart = { x: cx, z: cz, count: -1 }
      for (const crown of canopy.crowns) {
        if (Math.hypot(crown.x - cx, crown.z - cz) > radius) continue
        let count = 0
        for (const other of canopy.crowns) if (Math.hypot(other.x - crown.x, other.z - crown.z) < 18) count += 1
        if (count > heart.count) heart = { x: crown.x, z: crown.z, count }
      }
      let best = null
      for (let i = 0; i < 1400; i++) {
        const angle = rand() * Math.PI * 2
        const r = Math.sqrt(rand()) * 11
        const x = heart.x + Math.cos(angle) * r
        const z = heart.z + Math.sin(angle) * r
        if (!canStand(x, z)) continue
        let near = 0
        let closest = Infinity
        for (const crown of canopy.crowns) {
          const d = Math.hypot(crown.x - x, crown.z - z)
          if (d < 18) near += 1
          if (d < closest) closest = d
        }
        /* A plate composed with the lens against a bole is a plate of a bole.
         * The player stands where they like; a photograph has to be further off
         * than that to say anything about the wood. */
        if (closest < minTrunk) continue
        let reach = 0
        let yaw = 0
        for (let d = 0; d < 48; d++) {
          const a = (d / 48) * Math.PI * 2
          const got = clearRay(x, EYE, z, Math.sin(a), 0, Math.cos(a), 45)
          if (got > reach) {
            reach = got
            yaw = a
          }
        }
        if (reach < 25) continue
        const score = near * 100 + reach
        if (!best || score > best.score) best = { x, z, yaw, reach, near, closest, score }
      }
      return best
    },
    /**
     * An animal in one of the wooded hunting regions, and a standing position
     * 20-26m from it whose eye-to-flank sightline is clear. This is the plate
     * the whole change is for: something to kill, in view, without zooming.
     */
    animalShot(regions) {
      /* Reindeer first, then boar, then the bears. Not cherry-picking: a bear is
       * near-black and stands against near-black boles, so a plate of one says
       * more about this world's palette than about its sightlines. A reindeer is
       * the animal a player at hunting level is actually looking for. */
      const order = ['REINDEER', 'BOAR', 'WOLF', 'BEAR', 'CHICKEN']
      const animals = window.__wally.wildlife.animals
        .filter(animal => animal.hp > 0 && regions.includes(animal.region.id))
        .sort((a, b) => order.indexOf(a.species.id) - order.indexOf(b.species.id))
      for (const animal of animals) {
        const ax = animal.group.position.x
        const az = animal.group.position.z
        const flank = Math.max(0.6, animal.species.height * 0.55)
        for (let i = 0; i < 600; i++) {
          const angle = rand() * Math.PI * 2
          const range = 22 + rand() * 6
          const x = ax + Math.cos(angle) * range
          const z = az + Math.sin(angle) * range
          if (!canStand(x, z)) continue
          const dx = ax - x
          const dz = az - z
          const dy = flank - EYE
          const span = Math.hypot(dx, dy, dz)
          if (clearRay(x, EYE, z, dx / span, dy / span, dz / span, span - 0.6) < span - 0.6) continue
          let near = 0
          for (const crown of canopy.crowns) if (Math.hypot(crown.x - x, crown.z - z) < 30) near += 1
          return {
            x,
            z,
            ax,
            az,
            flank,
            range: Math.hypot(ax - x, az - z),
            species: animal.species ? animal.species.id : 'unknown',
            region: animal.region.id,
            near,
          }
        }
      }
      return null
    },
    shoot(pos, look, fov, noFog) {
      camera.fov = fov
      camera.aspect = 1280 / 800
      camera.updateProjectionMatrix()
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      const fog = scene.fog
      if (noFog) scene.fog = null
      renderer.render(scene, camera)
      scene.fog = fog
      return {
        url: canvas.toDataURL('image/png'),
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        lensInWood: canopy.inWood(pos[0], pos[1], pos[2]),
      }
    },
  }
})

const report = []
const write = async (name, shot, extra = {}) => {
  const file = path.join(OUT, `${name}.png`)
  await fs.writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'))
  report.push({ name, file, calls: shot.calls, triangles: shot.triangles, lensInWood: shot.lensInWood, ...extra })
  console.log(
    `${name.padEnd(26)} ${String(shot.calls).padStart(5)} calls ${String(shot.triangles).padStart(9)} tris  ` +
    `lensInWood=${shot.lensInWood}  ${JSON.stringify(extra)}`,
  )
}

/* --- 1. standing at eye height inside a wood, looking level ----------- */
const WOODS = [
  { name: 'eye-wildwood', at: [-58, -58], radius: 22, minTrunk: 5 },
  { name: 'eye-hollow', at: [-28, -76], radius: 10, minTrunk: 5 },
  { name: 'eye-brasswood', at: [74, -74], radius: 7, minTrunk: 4 },
  // Open country, framed the same way, so the two are comparable.
  { name: 'country-meadow', at: [28, 78], radius: 12, minTrunk: 5 },
  { name: 'country-fields', at: [18, -45], radius: 10, minTrunk: 5 },
]
for (const wood of WOODS) {
  const found = await page.evaluate(
    (at, radius, minTrunk) => window.__frame.eyeShot(at[0], at[1], radius, minTrunk),
    wood.at,
    wood.radius,
    wood.minTrunk,
  )
  if (!found) {
    console.log(`${wood.name.padEnd(26)} NO POSITION with a 25m level sightline — that is a finding, not a plate`)
    report.push({ name: wood.name, skipped: 'no standing position with a 25m level sightline' })
    continue
  }
  const shot = await page.evaluate(
    spot => window.__frame.shoot(
      [spot.x, 2.7, spot.z],
      [spot.x + Math.sin(spot.yaw) * 40, 2.7, spot.z + Math.cos(spot.yaw) * 40],
      70,
      false,
    ),
    found,
  )
  await write(wood.name, shot, {
    stand: [Number(found.x.toFixed(1)), 2.7, Number(found.z.toFixed(1))],
    clearSightline: Number(found.reach.toFixed(1)),
    nearestTrunk: Number(found.closest.toFixed(1)),
    trunksWithin18m: found.near,
  })
}

/* --- 2. the same wood from outside, where the canopy has to carry it -- */
const OUTSIDE = [
  { name: 'wood-from-above', pos: [-58, 62, 14], look: [-58, 14, -58], fov: 60, noFog: true },
  // Above the rooftops on the far side of the world, so the canopy mass has to
  // carry the picture on its own.
  { name: 'wood-from-distance', pos: [-92, 24, -18], look: [-58, 18, -58], fov: 56, noFog: true },
  // Under the roof, looking along it. This is the shape the change is for.
  { name: 'wood-under-canopy', pos: [-90, 10, -90], look: [-58, 17, -56], fov: 60, noFog: true },
  // Straight up from a standing eye, which is what canopy closure looks like.
  { name: 'wood-lookup', pos: [-59.1, 2.7, -66.2], look: [-53, 20, -60], fov: 76 },
]
for (const plate of OUTSIDE) {
  const shot = await page.evaluate(
    (pos, look, fov, noFog) => window.__frame.shoot(pos, look, fov, noFog),
    plate.pos,
    plate.look,
    plate.fov,
    plate.noFog,
  )
  await write(plate.name, shot, { pos: plate.pos, look: plate.look })
}

/* --- 3. an animal at hunting range, from a standing eye --------------- */
const WOODED = ['wildwood', 'hollow', 'brasswood']
const animal = await page.evaluate(regions => window.__frame.animalShot(regions), WOODED)
if (!animal) {
  console.log('animal-at-range            NO clear sightline to any animal in a wooded region')
  report.push({ name: 'animal-at-range', skipped: 'no clear sightline to any animal in a wooded region' })
} else {
  const shot = await page.evaluate(
    (spot, fov) => window.__frame.shoot([spot.x, 2.7, spot.z], [spot.ax, spot.flank, spot.az], fov, false),
    animal,
    live.fov,
  )
  await write('animal-at-range', shot, {
    species: animal.species,
    region: animal.region,
    range: Number(animal.range.toFixed(1)),
    fov: live.fov,
    trunksWithin30m: animal.near,
  })
  /* The same lens and the same position at 20 degrees, purely so a reviewer can
   * confirm that the shape in the middle of the plate above is the animal. Not
   * evidence of anything by itself: the claim is about the wide frame. */
  const crop = await page.evaluate(
    spot => window.__frame.shoot([spot.x, 2.7, spot.z], [spot.ax, spot.flank, spot.az], 20, false),
    animal,
  )
  await write('animal-at-range-crop', crop, { range: Number(animal.range.toFixed(1)), fov: 20 })
}

/* --- 4. open country, so the change is visible where there is no wood - */
const COUNTRY = [
  { name: 'country-avenue', pos: [-48, 2.7, 4], look: [-48, 2.7, 58], fov: 70 },
  { name: 'country-over', pos: [0, 168, 52], look: [0, 0, -8], fov: 62, noFog: true },
]
for (const plate of COUNTRY) {
  const shot = await page.evaluate(
    (pos, look, fov, noFog) => window.__frame.shoot(pos, look, fov, noFog),
    plate.pos,
    plate.look,
    plate.fov,
    !!plate.noFog,
  )
  await write(plate.name, shot, { pos: plate.pos, look: plate.look })
}

/* --- 5. the live third-person rig, untouched, inside the wildwood ----- */
for (const walk of [
  { name: 'walk-wildwood', at: [-58, -58], zoomOut: 5 },
  { name: 'walk-wildwood-maxzoom', at: [-58, -58], zoomOut: 22 },
]) {
  await page.evaluate(at => window.__wally.player.position.set(at[0], 0, at[1]), walk.at)
  await page.focus('canvas')
  await page.keyboard.press('Space')
  for (let i = 0; i < walk.zoomOut; i++) await page.keyboard.press('ArrowDown')
  await sleep(2200)
  await page.evaluate(() => {
    const matches = [...document.querySelectorAll('div, section, aside')].filter(
      element => /Could not reach the shared world/.test(element.textContent ?? '') && !element.querySelector('canvas'),
    )
    const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)))
    for (const element of innermost) element.style.visibility = 'hidden'
  })
  const state = await page.evaluate(() => {
    const camera = window.__wally.camera
    const player = window.__wally.player
    const canopy = player.parent.getObjectByName('wildscape').userData.canopy
    return {
      lens: [camera.position.x, camera.position.y, camera.position.z].map(v => Number(v.toFixed(2))),
      boom: Number(camera.position.distanceTo(player.position).toFixed(2)),
      lensInWood: canopy.inWood(camera.position.x, camera.position.y, camera.position.z),
    }
  })
  const file = path.join(OUT, `${walk.name}.png`)
  await page.screenshot({ path: file })
  report.push({ name: walk.name, live: true, file, ...state })
  console.log(`${walk.name.padEnd(26)} lens ${JSON.stringify(state.lens)} boom ${state.boom}m lensInWood=${state.lensInWood}  ${file}`)
}

await fs.writeFile(
  path.join(OUT, 'canopy.json'),
  JSON.stringify({ gl, fps, warmupFps: (warm.frames / warm.ms) * 1000, live, plates: report, errors }, null, 2),
)
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '))
await browser.close()
await close()
