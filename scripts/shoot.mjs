import puppeteer from 'puppeteer'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const labels = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']

async function measure(fill, screenshotPath) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1320, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  const url = `http://127.0.0.1:5173/voxel-test.html${fill ? `?fill=${fill}` : ''}`
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction('window.__voxelTestReady === true', { timeout: 20000 })
  await new Promise(r => setTimeout(r, 600))
  if (screenshotPath) {
    await (await page.$('#solidity')).screenshot({ path: screenshotPath })
    for (const id of labels) {
      const box = await page.evaluate(name => {
        const heads = [...document.querySelectorAll('h2')]
        const start = heads.find(h => h.textContent.trim() === name)
        if (!start) return null
        const next = heads[heads.indexOf(start) + 1]
        const top = start.getBoundingClientRect().top + window.scrollY
        const bottom = next ? next.getBoundingClientRect().top + window.scrollY : document.body.scrollHeight
        return { x: 0, y: top, width: 1300, height: bottom - top }
      }, id)
      if (box) await page.screenshot({ path: `/tmp/wardrobe-${id}.png`, clip: box, captureBeyondViewport: true })
    }
  }

  const stats = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('#solidity canvas').forEach((canvas, index) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      ctx.canvas.width = canvas.width
      ctx.canvas.height = canvas.height
      ctx.drawImage(canvas, 0, 0)
      const { width, height } = ctx.canvas
      const data = ctx.getImageData(0, 0, width, height).data
      const bg = new Uint8Array(width * height)
      for (let p = 0; p < width * height; p++) {
        const i = p * 4
        bg[p] = data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200 ? 1 : 0
      }

      // Bounding box of the model.
      let minX = width, maxX = -1, minY = height, maxY = -1
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (bg[y * width + x]) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }

      // Flood fill background from the image border; anything unreached is a
      // genuinely enclosed hole in the mesh.
      const seen = new Uint8Array(width * height)
      const stack = []
      const push = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return
        const p = y * width + x
        if (seen[p] || !bg[p]) return
        seen[p] = 1
        stack.push(p)
      }
      for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1) }
      for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y) }
      while (stack.length) {
        const p = stack.pop()
        const x = p % width
        const y = (p / width) | 0
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
      }

      let enclosed = 0
      let bgInBox = 0
      let boxPixels = 0
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const p = y * width + x
          boxPixels++
          if (!bg[p]) continue
          bgInBox++
          if (!seen[p]) enclosed++
        }
      }
      let hx0 = width, hx1 = -1, hy0 = height, hy1 = -1
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x
          if (!bg[p] || seen[p]) continue
          if (x < hx0) hx0 = x
          if (x > hx1) hx1 = x
          if (y < hy0) hy0 = y
          if (y > hy1) hy1 = y
        }
      }

      // Paint the enclosed holes bright green so they can be located visually.
      if (enclosed) {
        const img = ctx.getImageData(0, 0, width, height)
        for (let p = 0; p < width * height; p++) {
          if (bg[p] && !seen[p]) {
            img.data[p * 4] = 0
            img.data[p * 4 + 1] = 255
            img.data[p * 4 + 2] = 0
          }
        }
        ctx.putImageData(img, 0, 0)
      }
      out.push({ index, enclosed, bgInBox, boxPixels, hole: [hx0, hy0, hx1, hy1], model: [minX, minY, maxX, maxY], overlay: enclosed ? ctx.canvas.toDataURL() : null })
    })
    return out
  })
  await page.close()
  return { stats, errors }
}

const solid = await measure(null, '/tmp/voxel-solidity.png')
const gapped = await measure(0.9, '/tmp/voxel-gapped.png')

console.log('Background pixels showing through, inside each model\'s bounding box:')
console.log('(control = the old cell*0.9 build, proving the measurement is sensitive)\n')
console.log('  character  view           solid(1.02)      control(0.9)   enclosed holes')
solid.stats.forEach((s, i) => {
  const g = gapped.stats[i]
  const view = i < 4 ? 'front' : 'three-quarter'
  const sPct = ((s.bgInBox / s.boxPixels) * 100).toFixed(2)
  const gPct = ((g.bgInBox / g.boxPixels) * 100).toFixed(2)
  console.log(
    `  ${labels[i % 4].padEnd(9)} ${view.padEnd(14)} ${sPct.padStart(6)}%          ${gPct.padStart(6)}%        ${String(s.enclosed).padStart(6)}   hole box ${JSON.stringify(s.hole)} within model ${JSON.stringify(s.model)}`,
  )
})

// Write a contact sheet locating every enclosed hole.
const overlays = solid.stats.filter(s => s.overlay)
if (overlays.length) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1320, height: 700, deviceScaleFactor: 1 })
  await page.setContent(
    `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(4,320px)">` +
      overlays
        .map(o => `<figure style="margin:0"><img src="${o.overlay}" width="320"><figcaption style="color:#0f0;font:11px monospace;text-align:center">${labels[o.index % 4]} ${o.index < 4 ? 'front' : '3/4'} · ${o.enclosed}px</figcaption></figure>`)
        .join(''),
  )
  await new Promise(r => setTimeout(r, 400))
  await page.screenshot({ path: '/tmp/voxel-holes.png', fullPage: true })
  await page.close()
  console.log('\nenclosed-hole map written to /tmp/voxel-holes.png')
}

const errs = [...solid.errors, ...gapped.errors]
console.log(errs.length ? '\nPAGE ERRORS:\n' + errs.join('\n') : '\nno page errors')
await browser.close()
