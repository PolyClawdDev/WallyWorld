import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

/** Shoots every UI surface over the running world, so the chrome can be judged
 *  against the town it is supposed to belong to. */
const shots = process.env.SHOTS ?? '/tmp/wally-ui'
mkdirSync(shots, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()) })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const clickText = async text => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)), text)
  await handle.asElement().click()
  await wait(400)
}
const key = async k => { await page.keyboard.press(k); await wait(500) }

await page.goto((process.env.BASE ?? 'http://127.0.0.1:5173') + '/', { waitUntil: 'networkidle0' })
await clickText('Enter the world')
await clickText('Continue with')
await clickText('Enter Wally World')
await page.waitForFunction('!!window.__wally', { timeout: 20000 })
await wait(1500)

// Stand in the plaza so the town, NPCs and lanterns are behind every panel.
await page.evaluate(() => { window.__wally.player.position.set(2, 0, 12) })
await wait(1200)
await page.screenshot({ path: `${shots}/10-hud.png` })

await key('k')
await page.screenshot({ path: `${shots}/11-pouch.png` })
await key('Escape')
await key('m')
await page.screenshot({ path: `${shots}/12-map.png` })
await key('Escape')
await key('j')
await page.screenshot({ path: `${shots}/13-journal.png` })
await key('Escape')
await key('o')
await page.screenshot({ path: `${shots}/14-settings.png` })
await key('Escape')

// Hunt HUD: walk the player into the wildwood, take damage, open the ledger.
await page.evaluate(() => {
  const { wildlife, player, vitals } = window.__wally
  player.position.set(-58, 0, -52)
  if (vitals && typeof vitals.damage === 'function') vitals.damage(38)
  const target = wildlife.animals.find(animal => animal.state !== 'dead')
  if (target) target.group.position.set(player.position.x + 4, 0, player.position.z - 2)
})
await wait(1400)
await page.screenshot({ path: `${shots}/15-hunt-hud.png` })
await key('h')
await page.screenshot({ path: `${shots}/16-hunt-ledger.png` })
await key('h')

console.log(errors.length ? `page errors: ${errors.slice(0, 4).join(' | ')}` : 'no page errors')
console.log(`screenshots in ${shots}`)
await browser.close()
