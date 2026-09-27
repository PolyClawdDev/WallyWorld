import puppeteer from 'puppeteer'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
page.on('pageerror', e => console.log('pageerror', String(e)))
const wait = ms => new Promise(r => setTimeout(r, ms))
const clickText = async text => {
  const h = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)), text)
  await h.asElement().click()
  await wait(350)
}
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await clickText('Enter the world')
await clickText('Continue with')
await clickText('Enter Voxels')
await page.waitForFunction('!!window.__wally && !!window.__wallyBridge')
await page.evaluate(() => window.__wally.player.position.set(18, 0, 26))
await wait(1200)
console.log(await page.evaluate(() => {
  const camera = window.__wally.camera
  const scene = window.__wally.player.parent
  const Vector3 = camera.position.constructor
  const candidates = scene.children.filter(c => typeof c.userData.npc === 'string' && c.userData.npc)
  const probe = (x, y, z) => {
    const p = new Vector3(x, y, z).project(camera)
    return { sx: Math.round((p.x * 0.5 + 0.5) * innerWidth), sy: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: p.z.toFixed(3) }
  }
  const canvas = document.querySelector('.world-canvas canvas')
  const rect = canvas.getBoundingClientRect()
  const mira = candidates.find(c => c.userData.npc.startsWith('MIRA'))
  const heights = [0.4, 1.2, 2, 2.6, 3.2, 3.9]
  const hits = {}
  for (const h of heights) {
    const { sx, sy } = probe(3.5, h, 5.2)
    hits[h] = { sx, sy, pick: window.__wallyBridge.npcAtScreen(sx, sy) }
  }
  return {
    canvas: { w: rect.width, h: rect.height, top: rect.top, left: rect.left },
    candidates: candidates.map(c => c.userData.npc),
    miraChildren: mira ? mira.children.map(c => `${c.type}:${c.visible}`) : null,
    miraPos: mira ? [mira.position.x, mira.position.y, mira.position.z] : null,
    hits,
    handle: !!window.__wallyBridge.handle(),
  }
}))
await browser.close()
