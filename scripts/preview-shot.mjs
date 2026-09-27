import puppeteer from 'puppeteer'

/* Screenshots the character preview stage to check the shine reads well. */

const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 })
page.on('pageerror', e => console.log('PAGE ERROR:', e.message))
const click = text =>
  page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))?.click(), text)

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle0' })
await click('Enter the world')
await sleep(6000)
await page.screenshot({ path: '/tmp/preview-shine.png' })
console.log('captured')
await browser.close()
