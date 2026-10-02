/*
 * Plates of the Fomo House, on the real GL backend.
 *
 * Same method as scripts/shot-town.mjs, and for the same reason: Chrome's
 * default backend reaches a real renderer headlessly, so the frame rate below
 * is worth printing. `--use-angle=swiftshader` would render this on the CPU at
 * about three frames a second, and this world clamps dt — under swiftshader the
 * frame rate becomes the movement speed and a still of it says nothing about
 * how the building looks.
 *
 * The camera is a CLONE, rendered offscreen. The live loop owns the real one
 * and overwrites its pose every frame, so a plate taken through it is a race.
 *
 * Usage:
 *   node scripts/shot-fomo.mjs screenshots/fomo
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = process.argv[2] ?? 'screenshots/fomo'

/* The house: x −32, z 33, 12 x 9, base to 9m, eyes 13.0m to 22.2m.
 * Its door and its notice are on the −z face, like every door in town. */
const HOUSE = { x: -32, z: 33, front: 28.5, eyesY: 17.62 }

const PLATES = [
  /* 1. Down the street. A player standing on the north kerb of the main
   * east–west street at the house's own x, at eye height, looking up it. This
   * is the view the siting was chosen for. */
  { name: '1-down-the-street-eye', pos: [-32, 1.7, 8], look: [-32, 15, 33], fov: 70 },
  { name: '2-forecourt-eye', pos: [-32, 1.7, 18], look: [-32, 16, 33], fov: 74 },
  /* 3. Off-axis, from where the house actually first appears to somebody walking
   * out of the plaza. Not from the plaza itself: the Hearth Inn sits squarely on
   * that bearing and hides the whole building, eyes included, which is a fact
   * about the siting worth knowing rather than one worth hiding. This is the
   * first step past the inn's north corner. */
  { name: '3-past-the-inn', pos: [-2, 1.7, 22], look: [-32, 16, 33], fov: 58 },
  /* And the same bearing with the sway turned to its limit, which is the best
   * the flank ever gets. Taken with an explicit yaw rather than by catching the
   * animation mid-swing, so the two plates differ by one angle and nothing
   * else: a 13m slab 1.76m thick does not stop being a slab at 14°, and the
   * frame that shows that is worth keeping. */
  { name: '3b-past-the-inn-at-the-sway-limit', pos: [-2, 1.7, 22], look: [-32, 16, 33], fov: 58, yaw: (-14 * Math.PI) / 180 },

  /* 4-5. The eyes close, from the street side and from directly behind, at the
   * eyes' own height and the same distance. The mirror pair. */
  { name: '4-eyes-front', pos: [-32, 17.62, 33 - 26], look: [-32, 17.62, 33], fov: 40 },
  { name: '5-eyes-reverse', pos: [-32, 17.62, 33 + 26], look: [-32, 17.62, 33], fov: 40 },
  /* 6. And from the flank, which is what the sway shows: the slab's thickness
   * and the stepped edges. */
  { name: '6-eyes-flank', pos: [-32 - 26, 17.62, 33], look: [-32, 17.62, 33], fov: 40 },

  /* 7. The notice at door height, from where a player stands to read it. */
  { name: '7-notice-at-the-door', pos: [-32, 2.3, 22], look: [-32, 5.1, 28.5], fov: 54 },
  { name: '8-door-boarded', pos: [-32, 1.7, 23], look: [-32, 2.0, 28.5], fov: 52 },

  /* 9. The air gap, from the west kerb: nothing bridges it, and the trees on the
   * far side of the house show through underneath the artwork. */
  { name: '9-levitation-low', pos: [-44, 7, 20], look: [-32, 13, 33], fov: 55 },
  /* 10. The gap itself, at the height of the cornice it does not touch. The eyes
   * overhang the walls by half a metre each side, so there is nowhere on the
   * ground that is truly underneath them; this is the frame that has to show
   * daylight and treetops between the parapet and the artwork. */
  { name: '10-levitation-under', pos: [-30, 9, 18], look: [-32, 13.5, 33], fov: 45 },

  /* 11. The whole building, framed. */
  { name: '11-house-whole', pos: [-32, 12, 0], look: [-32, 13, 33], fov: 52 },
  { name: '12-house-three-quarter', pos: [-54, 14, 10], look: [-32, 13, 33], fov: 54 },

  /* 13. Both landmarks. They stand 96m apart on opposite shoulders of the town,
   * which is the point of the siting, so no eye-height frame holds them both —
   * the Hearth, the Hall and the Workshop are all in the way of one or the
   * other. This camera is on the perpendicular bisector of the line between
   * them, 89m from each and 34m up, which is above the canopy and below the
   * height at which the coin turns into a line. 65° apart in the frame: the eyes
   * over the dark quarter on the left, the coin over the orchard on the right. */
  { name: '13-both-landmarks', pos: [47, 34, 72], look: [9, 14, 8], fov: 72 },
  /* 14. The quarter from above the plaza. At eye level the Hearth Inn sits
   * exactly on this bearing; 26m up clears its ridge, which is the lowest a
   * camera over the plaza can be and still see the eyes at all. */
  { name: '14-over-the-plaza', pos: [-2, 26, 2], look: [-32, 17, 33], fov: 60 },
]

/* Matched pairs for the silhouette comparison, as coarse masks rather than
 * images: the question is whether the two sides are the same shape. */
const MASK_PAIRS = [
  { a: '4-eyes-front', b: '5-eyes-reverse' },
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
await fs.mkdir(OUT, { recursive: true })

const site = await serveDist()
console.log('serving', site.base)

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

await page.goto(site.base, { waitUntil: 'domcontentloaded' })
await click('Enter world')
await page.waitForFunction(
  () => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with')),
  { timeout: 60_000 },
)
// Through React's own setter, or the controlled input ignores the value.
await page.evaluate(() => {
  const input = document.querySelector('#wayfinder-name')
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
await page.waitForFunction('!!window.__wally && !!window.__wally.player && !!window.__wally.player.parent', { timeout: 120_000 })
await sleep(2500)

const gl = await page.evaluate(() => {
  const context = window.__wally.renderer.getContext()
  const debug = context.getExtension('WEBGL_debug_renderer_info')
  return debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown'
})
console.log('gl:', gl)

/* Move the PLAYER to the forecourt and let the game's own camera settle, so the
 * live frame rate below is measured with the house actually on screen. */
await page.evaluate(h => {
  window.__wally.player.position.set(h.x, window.__wally.player.position.y, h.front - 14)
}, HOUSE)
await sleep(1800)

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
          resolve({ frames: sorted.length, fps: Number((1000 / mean).toFixed(1)), worstMs: Number(sorted[sorted.length - 1].toFixed(2)) })
        }
      }
      requestAnimationFrame(tick)
    }),
)
console.log('fps standing in the forecourt:', JSON.stringify(fps))

/* And then out of shot. The frame rate had to be measured with a player in the
 * forecourt, but the plates are of a building, and a character standing between
 * the camera and the notice is the one thing that would make the notice
 * unreadable in the one plate whose whole job is to prove it can be read. */
await page.evaluate(() => {
  window.__wally.player.position.set(-32, window.__wally.player.position.y, 70)
})
await sleep(900)

/* The eyes, as the scene actually holds them: proof the group is where the
 * house is and that the art under it was built at the group's origin. */
const eyesReport = await page.evaluate(() => {
  const scene = window.__wally.player.parent
  const town = scene.children.find(child => child.userData && child.userData.fomoHouse)
  const house = town.userData.fomoHouse
  const eyes = house.getObjectByName('fomo-eyes')
  const samples = []
  for (let i = 0; i < 4; i++) samples.push({ y: eyes.position.y, yaw: eyes.rotation.y })
  return {
    group: { x: eyes.position.x, y: eyes.position.y, z: eyes.position.z },
    houseAt: { x: house.position.x, z: house.position.z },
    yaw: eyes.rotation.y,
    meshes: eyes.children.length,
    boxes: house.userData.boxes,
    triangles: house.userData.triangles,
    samples,
  }
})
console.log('eyes group:', JSON.stringify(eyesReport))

/* One offscreen renderer for the whole run: a WebGL context per plate exhausts
 * the browser's context pool after about sixteen of them. */
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
  const scene = () => window.__wally.player.parent
  const house = () => scene().children.find(c => c.userData && c.userData.fomoHouse).userData.fomoHouse
  window.__plate = {
    /* The eyes are frozen at rest for a plate, in the same synchronous block as
     * the render, so no animation frame can run between the two. A pair of
     * plates taken mid-sway is a pair taken at two different angles, which is
     * exactly the comparison the mirror check must not make. */
    freeze(on, yaw) {
      const eyes = house().getObjectByName('fomo-eyes')
      if (on) {
        eyes.rotation.y = yaw || 0
        eyes.position.y = house().userData.eyesRestY
        eyes.updateMatrixWorld(true)
      }
    },
    shoot(pos, look, fov, freeze, yaw) {
      camera.fov = fov
      camera.aspect = 1440 / 900
      camera.updateProjectionMatrix()
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      if (freeze) window.__plate.freeze(true, yaw)
      renderer.render(scene(), camera)
      return { url: canvas.toDataURL('image/png'), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
    },
    /* What the house alone costs: render with it, render without it, subtract. */
    houseCost(pos, look, fov) {
      camera.fov = fov
      camera.aspect = 1440 / 900
      camera.updateProjectionMatrix()
      camera.position.set(pos[0], pos[1], pos[2])
      camera.lookAt(look[0], look[1], look[2])
      const group = house()
      group.visible = true
      renderer.render(scene(), camera)
      const withIt = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
      group.visible = false
      renderer.render(scene(), camera)
      const without = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
      group.visible = true
      return { withIt, without, calls: withIt.calls - without.calls, triangles: withIt.triangles - without.triangles }
    },
    /* A coarse silhouette of the eyes, for comparing one side against the
     * other as numbers rather than as an impression. Thresholded on
     * brightness, because the base and the sky are both dark and the eyes are
     * the only bright thing in a plate framed on them. */
    mask(pos, look, fov, cols = 60) {
      window.__plate.shoot(pos, look, fov, true)
      const ctx = canvas.getContext('2d')
      void ctx
      const gl2 = renderer.getContext()
      const pixels = new Uint8Array(1440 * 900 * 4)
      gl2.readPixels(0, 0, 1440, 900, gl2.RGBA, gl2.UNSIGNED_BYTE, pixels)
      const rows = Math.round((cols * 900) / 1440)
      const sx = 1440 / cols
      const sy = 900 / rows
      const grid = []
      for (let gy = 0; gy < rows; gy++) {
        let line = ''
        for (let gx = 0; gx < cols; gx++) {
          let lit = 0
          let n = 0
          // readPixels is bottom-up, so the row index is flipped.
          for (let y = Math.floor(900 - (gy + 1) * sy); y < Math.floor(900 - gy * sy); y++) {
            for (let x = Math.floor(gx * sx); x < Math.floor((gx + 1) * sx); x++) {
              const i = (y * 1440 + x) * 4
              if ((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 120) lit++
              n++
            }
          }
          line += lit / n > 0.5 ? '#' : '.'
        }
        grid.push(line)
      }
      return grid
    },
    dispose() {
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
})

const cost = await page.evaluate(
  (pos, look, fov) => window.__plate.houseCost(pos, look, fov),
  PLATES[1].pos,
  PLATES[1].look,
  PLATES[1].fov,
)
console.log('the house alone, from the forecourt:', JSON.stringify(cost))

const report = []
for (const plate of PLATES) {
  const shot = await page.evaluate(
    (pos, look, fov, yaw) => window.__plate.shoot(pos, look, fov, true, yaw),
    plate.pos,
    plate.look,
    plate.fov,
    plate.yaw || 0,
  )
  const file = path.join(OUT, `${plate.name}.png`)
  await fs.writeFile(file, Buffer.from(shot.url.split(',')[1], 'base64'))
  report.push({ name: plate.name, calls: shot.calls, triangles: shot.triangles })
  console.log(`${plate.name.padEnd(28)} ${String(shot.calls).padStart(4)} calls ${String(shot.triangles).padStart(8)} tris  ${file}`)
}

/* The mirror question, as a number. */
const masks = {}
for (const plate of PLATES) {
  if (!MASK_PAIRS.some(pair => pair.a === plate.name || pair.b === plate.name)) continue
  masks[plate.name] = await page.evaluate(
    (pos, look, fov) => window.__plate.mask(pos, look, fov),
    plate.pos,
    plate.look,
    plate.fov,
  )
}
for (const pair of MASK_PAIRS) {
  const a = masks[pair.a]
  const b = masks[pair.b]
  if (!a || !b) continue
  const flipped = b.map(row => [...row].reverse().join(''))
  const count = (grid, test) => grid.reduce((sum, row) => sum + [...row].filter(test).length, 0)
  let same = 0
  let differ = 0
  let sameFlipped = 0
  let differFlipped = 0
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] === b[y][x]) same++
      else differ++
      if (a[y][x] === flipped[y][x]) sameFlipped++
      else differFlipped++
    }
  }
  console.log()
  console.log(`=== ${pair.a} vs ${pair.b} ===`)
  console.log(`lit cells: ${count(a, c => c === '#')} front, ${count(b, c => c === '#')} reverse`)
  console.log(`as taken:          ${((same / (same + differ)) * 100).toFixed(1)}% of cells agree`)
  console.log(`reverse flipped:   ${((sameFlipped / (sameFlipped + differFlipped)) * 100).toFixed(1)}% of cells agree`)
  console.log('front (what the forecourt sees):')
  for (const row of a) console.log('  ' + row)
  console.log('reverse, as taken:')
  for (const row of b) console.log('  ' + row)
}

await page.evaluate(() => window.__plate.dispose())
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ gl, fps, eyes: eyesReport, cost, plates: report, masks, errors }, null, 2))
if (errors.length) console.log('page errors:', errors.slice(0, 6).join(' | '))
await browser.close()
await site.close()
