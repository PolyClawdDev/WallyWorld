/* ------------------------------------------------------------------ *
 * Can a player actually use Sable's desk?
 *
 *   npm run verify:shielded-desk
 *
 * Walks a real browser from the entry screen to the Zcash house, opens the
 * Journal, and works the desk with addresses built from the official ZIP-316
 * vectors. Nothing is stubbed: the page talks to a running API, the API talks
 * to the live 1Click endpoint, and the numbers on screen are the numbers that
 * came back.
 *
 * Three things are checked that nothing else can check:
 *
 *   1. **Both halves of the privacy statement are on screen.** `courier.ts`
 *      holds `PRIVACY_STATEMENT` as a constant so the unflattering half cannot
 *      be dropped by a caller that only wanted the headline, and the unit tests
 *      assert it survives the server. This is the end of that chain: the text
 *      is read back out of the rendered DOM and compared to the constant, and
 *      the two halves are compared to each other for rendered size, because a
 *      half shown in six-point grey is dropped in every way that matters.
 *   2. **A refusal is specific.** The transparent-bearing unified address is
 *      the one nearly every wallet hands out, so its refusal is the one that
 *      decides whether this feature is usable. It has to name that case and
 *      say what to ask for instead.
 *   3. **Nothing on screen offers a payout.** No deposit address, no pay
 *      button, no gold. Asserted against the whole rendered panel rather than
 *      against the fields this script happens to know about.
 * ------------------------------------------------------------------ */

import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'
import { serveWithApi } from './lib/serve-app.mjs'
import { loadVectors, vectorWithReceivers, transparentAddressFrom } from './lib/zec-vectors.ts'

const SHOTS = process.env.SHOTS ?? 'screenshots/shielded-desk'
mkdirSync(SHOTS, { recursive: true })

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ---- the addresses, built from the canonical vectors ------------------- */

const { rows } = await loadVectors()
const ua = want => vectorWithReceivers(rows, want)[6]
const ORCHARD_ONLY = ua(['orchard'])
const TRANSPARENT_ORCHARD = ua(['p2pkh', 'orchard'])
const SAPLING_ONLY = ua(['sapling'])
const TRANSPARENT_ONLY = transparentAddressFrom(vectorWithReceivers(rows, ['p2pkh', 'sapling'])[0])

/*
 * The built app is served with `/api` forwarded to a real API, not from a
 * plain static root. The client resolves its API base to the page's own origin
 * (`cluster.ts` ignores a loopback `VITE_API_BASE_URL`), so a static host gives
 * the desk a 404 for `/api/courier` and the panel has nothing to show — which
 * is how the first run of this check failed, with the walk working and the
 * desk never arriving.
 */
const API = process.env.API ?? 'http://127.0.0.1:8787'
const site = await serveWithApi(API)

/*
 * No `--use-angle=swiftshader`. Software rasterising drops this world to a few
 * frames a second, and because `tick` clamps dt the frame rate becomes the
 * walking speed — a player who cannot cross the town cannot reach the desk, so
 * the check would be measuring the renderer rather than the feature.
 */
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

const errors = []
page.on('pageerror', error => errors.push(String(error)))
/*
 * Console errors are read through the responses that caused them. Chrome logs
 * a failed fetch as "Failed to load resource: …404" with no URL attached, and
 * this run deliberately provokes four refusals, which the desk answers with
 * 422 — so a console-only check either passes by ignoring every load failure
 * or fails on its own test fixtures. Listening to responses instead means the
 * exclusions can name the exact request they forgive.
 */
page.on('console', message => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`)
})
page.on('response', response => {
  if (response.status() < 400) return
  const url = response.url()
  // A refused address is the feature working. The request this script makes
  // four times on purpose cannot also be the thing that fails it.
  if (response.status() === 422 && url.endsWith('/api/courier/address')) return
  if (url.endsWith('/favicon.ico')) return
  errors.push(`http ${response.status()} ${url}`)
})

const clickText = async (label, tag = 'button') => {
  const handle = await page.evaluateHandle(([text, selector]) =>
    [...document.querySelectorAll(selector)].find(node => (node.textContent ?? '').includes(text)), [label, tag])
  const element = handle.asElement()
  if (!element) throw new Error(`not found: ${label}`)
  await element.click()
  await wait(400)
}

/* ---- 1. into the world -------------------------------------------------- */

await page.evaluateOnNewDocument(() => localStorage.clear())
await page.goto(`${site.origin}/`, { waitUntil: 'networkidle0' })
await clickText('Enter world')
// React tracks the field's value, so a plain `type` into it is discarded on the
// next render. Writing through the prototype setter and dispatching `input` is
// what the component actually listens to.
await page.evaluate(() => {
  const field = document.querySelector('#wayfinder-name')
  if (!field) return
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, 'Desk Tester')
  field.dispatchEvent(new Event('input', { bubbles: true }))
})
await clickText('Continue with')
await clickText('Enter Voxels')
await page.waitForFunction('!!window.__wally', { timeout: 30000 })
await wait(1500)

const fps = await page.evaluate(() => new Promise(resolve => {
  let frames = 0
  const started = performance.now()
  const count = () => { frames += 1; if (performance.now() - started < 1000) requestAnimationFrame(count); else resolve(frames) }
  requestAnimationFrame(count)
}))
check('the world runs fast enough to walk across', fps > 20, `${fps} fps`)

/* ---- 2. walk to Sable --------------------------------------------------- */

/**
 * The walk, as a route rather than a straight line.
 *
 * Sable stands at (43, -9), on the far side of the canal — which runs north to
 * south at x = 34 and is crossed in exactly two places, `townLayout.bridges`.
 * A player walking east from the fountain meets the water and follows the bank
 * to the southern crossing, and so does this: aiming straight at the shop just
 * presses a wayfinder against the canal wall, which is what the first run of
 * this check did.
 */
const ROUTE = [
  { x: 20, z: -30 },
  { x: 34, z: -34 },
  { x: 44, z: -28 },
  { x: 43, z: -9 },
]

const where = () => page.evaluate(() => {
  const p = window.__wally.player.position
  return { x: p.x, z: p.z }
})

const distanceTo = (from, to) => Math.hypot(from.x - to.x, from.z - to.z)

/**
 * Right-clicks a ground point on the way to `to`.
 *
 * The chase camera does not turn on its own, so a point far to one side
 * projects off screen. Walking there in fractions and taking the furthest
 * fraction still in view is how a player gets there too: you click as far as
 * you can see, and then you can see further.
 */
const stepToward = async to => {
  const from = await where()
  for (const fraction of [1, 0.8, 0.6, 0.4, 0.25, 0.15]) {
    const target = { x: from.x + (to.x - from.x) * fraction, z: from.z + (to.z - from.z) * fraction }
    const spot = await page.evaluate(([x, z]) => {
      const camera = window.__wally.camera
      const Vector3 = camera.position.constructor
      const point = new Vector3(x, 0.1, z).project(camera)
      return {
        x: (point.x * 0.5 + 0.5) * window.innerWidth,
        y: (-point.y * 0.5 + 0.5) * window.innerHeight,
        on: point.z > -1 && point.z < 1 && Math.abs(point.x) < 0.88 && Math.abs(point.y) < 0.8,
      }
    }, [target.x, target.z])
    if (!spot.on) continue
    await page.mouse.move(spot.x, spot.y)
    await wait(60)
    await page.mouse.click(spot.x, spot.y, { button: 'right' })
    await wait(900)
    return true
  }
  // Nothing on the way is in view, so turn the camera the way a player would.
  await page.mouse.move(720, 450)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(540, 450, { steps: 10 })
  await page.mouse.up({ button: 'right' })
  await wait(350)
  return false
}

const promptNow = () => page.evaluate(() =>
  document.querySelector('.interact')?.textContent?.replace(/^F\s*Talk to\s*/, '') ?? null)

let talkable = null
for (const leg of ROUTE) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    talkable = await promptNow()
    if (talkable === 'SABLE · ALCHEMIST') break
    if (distanceTo(await where(), leg) < 4) break
    await stepToward(leg)
  }
  if (talkable === 'SABLE · ALCHEMIST') break
}
const standing = await where()
check('a player can walk to Sable', talkable === 'SABLE · ALCHEMIST',
  `standing at (${standing.x.toFixed(1)}, ${standing.z.toFixed(1)}) · prompt "${talkable ?? 'none'}"`)
await page.screenshot({ path: `${SHOTS}/01-at-sable.png` })

/* ---- 3. open the desk --------------------------------------------------- */

await clickText('Talk to')
await page.waitForSelector('.jr-shield', { timeout: 15000 })
await page.waitForFunction(() => document.querySelectorAll('.jr-shield-half').length === 3, { timeout: 15000 })

const card = await page.evaluate(() => {
  const shield = document.querySelector('.jr-shield')
  return {
    state: shield.querySelector('.task-head b')?.textContent ?? '',
    title: shield.querySelector('h4')?.textContent ?? '',
    does: shield.querySelector('.jr-shield-split > div:not(.jr-shield-not) span')?.textContent ?? '',
    cannot: shield.querySelector('.jr-shield-split > div.jr-shield-not span')?.textContent ?? '',
  }
})
check('the desk is open rather than shut', card.title === 'Shielded courier desk', `"${card.title}" · ${card.state}`)
check('and it still says it cannot send', /signer/i.test(card.cannot), card.cannot.slice(0, 90))
check('while saying what it does do', /ZIP-316/.test(card.does), card.does.slice(0, 90))

/* ---- 4. both halves of the statement, on screen ------------------------- */

const halves = await page.evaluate(() => [...document.querySelectorAll('.jr-shield-half')].map(node => {
  const style = getComputedStyle(node)
  const box = node.getBoundingClientRect()
  return {
    label: node.querySelector('b')?.textContent ?? '',
    text: node.textContent.replace(node.querySelector('b')?.textContent ?? '', '').trim(),
    fontSize: style.fontSize,
    opacity: style.opacity,
    color: style.color,
    background: style.backgroundColor,
    height: box.height,
    visible: box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
  }
}))

const delivers = halves.find(half => half.label === 'DELIVERS')
const doesNotHide = halves.find(half => half.label === 'DOES NOT HIDE')
const cannotProve = halves.find(half => half.label === 'CANNOT PROVE')

check('all three halves of the statement are rendered', halves.length === 3 && halves.every(half => half.visible))
check('the unflattering half is there in full, not truncated',
  doesNotHide?.text.startsWith('Buying in is public and stays public') &&
  doesNotHide?.text.endsWith('Nothing here deletes any of that.'),
  `${doesNotHide?.text.length ?? 0} characters on screen`)
check('it says the funding payment is public and permanent', /anyone can read, permanently/.test(doesNotHide?.text ?? ''))
check('it says the provider sees the amount and both addresses',
  /the conversion provider sees the amount, the deposit address and the Zcash address/.test(doesNotHide?.text ?? ''))
check('it says only the player can prove delivery', /viewing key/.test(cannotProve?.text ?? ''))
// Equal prominence is a rendered property, not an intention. All three are
// compared rather than only the two the brief names, because a half made
// quieter is dropped whichever half it is.
const sameInk = half => half?.fontSize === delivers?.fontSize && half?.color === delivers?.color && half?.opacity === delivers?.opacity
check('the unflattering half is drawn at the same weight as the flattering one',
  sameInk(doesNotHide) && sameInk(cannotProve),
  `${delivers?.fontSize}/${delivers?.color} vs ${doesNotHide?.fontSize}/${doesNotHide?.color} vs ${cannotProve?.fontSize}/${cannotProve?.color}`)
check('and is given at least as much room on the page',
  (doesNotHide?.height ?? 0) >= (delivers?.height ?? 0),
  `${delivers?.height}px vs ${doesNotHide?.height}px`)
/*
 * Equal ink is not enough on its own: all three halves were once equally
 * illegible, dark brown on a near-black well, because `.jr-card p` outranked
 * the rule written for them. Comparing the halves to each other could never
 * see that, so the contrast each one is actually drawn at is measured.
 */
const contrast = half => {
  const channel = text => [...text.matchAll(/[\d.]+/g)].slice(0, 3).map(match => {
    const value = Number(match[0]) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = rgb => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  const [ink, paper] = [luminance(channel(half.color)), luminance(channel(half.background))]
  return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05)
}
check('and is legible where it is drawn, not just equal to the other halves',
  halves.every(half => contrast(half) >= 4.5),
  halves.map(half => `${half.label} ${contrast(half).toFixed(1)}:1`).join(' · '))
// The journal opens at the top of a long list of services, so the desk has to
// be brought into frame for the picture the way a player scrolls to it.
await page.evaluate(() => document.querySelector('.jr-shield')?.scrollIntoView({ block: 'start' }))
await wait(400)
await page.screenshot({ path: `${SHOTS}/02-desk.png` })

/* ---- 5. the refusals ---------------------------------------------------- */

const paste = async (selector, value) => page.evaluate(([css, text]) => {
  const field = [...document.querySelectorAll(css)][0]
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}, [selector, value])

const refusalFor = async address => {
  await paste('.jr-shield-field input', address)
  await clickText('Check this address')
  await page.waitForFunction(
    () => document.querySelector('.jr-shield-refusal') || document.querySelector('.jr-shield-ok'),
    { timeout: 20000 },
  )
  return page.evaluate(() => {
    const node = document.querySelector('.jr-shield-refusal')
    if (!node) return null
    return {
      code: node.querySelector('.jr-ledger-head b')?.textContent ?? '',
      headline: node.querySelector('h5')?.textContent ?? '',
      says: node.querySelectorAll('p')[0]?.textContent ?? '',
      doThis: node.querySelector('.jr-shield-do')?.textContent ?? '',
    }
  })
}

const common = await refusalFor(TRANSPARENT_ORCHARD)
check('a transparent-bearing unified address is refused for that reason',
  common?.code === 'transparent-receiver-present', common?.code ?? 'it was accepted')
check('the refusal names the case rather than saying "invalid address"',
  /TRANSPARENT RECEIVER/.test(common?.headline ?? ''), common?.headline ?? '')
check('and tells the player what to ask their wallet for',
  /shielded-only/.test(common?.doThis ?? '') && /Orchard/.test(common?.doThis ?? ''))
check('and says this is not their wallet being broken',
  /not a fault with your wallet/.test(common?.doThis ?? ''))
await page.evaluate(() => document.querySelector('.jr-shield-refusal')?.scrollIntoView({ block: 'center' }))
await wait(400)
await page.screenshot({ path: `${SHOTS}/03-refused-transparent-receiver.png` })

const sapling = await refusalFor(SAPLING_ONLY)
check('a Sapling-only address gets a different refusal',
  sapling?.code === 'sapling-without-orchard' && sapling.doThis !== common?.doThis, sapling?.code ?? '')

const transparent = await refusalFor(TRANSPARENT_ONLY)
check('a transparent-only address gets a third', transparent?.code === 'no-shielded-receiver', transparent?.code ?? '')

const nonsense = await refusalFor('not-an-address-at-all')
check('a string that is not an address gets a fourth', nonsense?.code === 'unparseable', nonsense?.code ?? '')
check('all four refusals differ in what they tell the player to do',
  new Set([common, sapling, transparent, nonsense].map(r => r?.doThis)).size === 4)

/* ---- 6. a real quote ---------------------------------------------------- */

await paste('.jr-shield-field input', ORCHARD_ONLY)
await clickText('Check this address')
await page.waitForSelector('.jr-shield-ok', { timeout: 20000 })
const acceptedAs = await page.evaluate(() => document.querySelector('.jr-shield-ok .jr-ledger-head b')?.textContent ?? '')
check('a shielded-only Orchard address is accepted', acceptedAs === 'ORCHARD', acceptedAs)

await clickText('Price this run')
await page.waitForSelector('.jr-shield-quote', { timeout: 40000 })
const quote = await page.evaluate(() => {
  const node = document.querySelector('.jr-shield-quote')
  return {
    headline: node.querySelector('strong')?.textContent ?? '',
    rows: [...node.querySelectorAll('.jr-shield-rows > div')].map(row => row.textContent),
    worstCase: node.querySelectorAll('p')[0]?.textContent ?? '',
    meta: node.querySelector('.jr-meta')?.textContent ?? '',
    intent: node.querySelector('.jr-shield-ok')?.textContent ?? '',
    badge: node.querySelector('.jr-ledger-head')?.textContent ?? '',
  }
})
check('a priced quote comes back from the live endpoint', /ZEC for .* SOL/.test(quote.headline), quote.headline)
check('it shows the minimum as well as the expected amount', /least/.test(quote.worstCase), quote.rows.join(' | '))
check('the verdict is the substantiated one', /orchard-substantiated/.test(quote.meta), quote.meta)
check('the quote is marked dry, with no deposit address', /NO DEPOSIT ADDRESS/.test(quote.badge), quote.badge)
check('the intent record says it is going nowhere',
  /nothing is queued/i.test(quote.intent) && /cr_/.test(quote.intent), quote.intent.slice(0, 120))
await page.screenshot({ path: `${SHOTS}/04-priced.png` })

/* ---- 7. nothing here offers a payout ------------------------------------ */

const panel = await page.evaluate(() => {
  const body = document.querySelector('.jr-shield')
  return {
    text: body.textContent,
    buttons: [...body.querySelectorAll('button')].map(button => button.textContent.trim()),
    stops: document.querySelector('.jr-shield-stop')?.textContent ?? '',
  }
})
check('no button at this desk pays, sends or withdraws',
  !panel.buttons.some(label => /\b(pay|send|withdraw|buy|deposit)\b/i.test(label)), panel.buttons.join(' | '))
check('no gold price appears anywhere on the desk', !/\d+\s*GOLD/i.test(panel.text))
// A Zcash deposit address would be a `u1…`/`t1…` the player did not type, and a
// Solana one base58. Neither may appear: the only address on this panel is the
// one in the field, which the player put there.
const typed = ORCHARD_ONLY
check('no address the player did not type is shown',
  ![...panel.text.matchAll(/\b(u1[a-z0-9]{40,}|t[13][1-9A-HJ-NP-Za-km-z]{30,})\b/g)].some(match => match[1] !== typed),
  'only the pasted address appears')
check('the desk states where it stops and why', /custody decision/.test(panel.stops), panel.stops.slice(0, 80))
check('it names the settings that would still not be enough', /WALLY_COURIER_TREASURY_ADDRESS/.test(panel.stops))
await page.evaluate(() => document.querySelector('.jr-shield-stop')?.scrollIntoView({ block: 'center' }))
await wait(400)
await page.screenshot({ path: `${SHOTS}/05-where-it-stops.png`, fullPage: false })

/* ---- 8. the desk does not contradict itself ----------------------------- */

/*
 * A priced quote is on screen. Refusing the next address has to take it down:
 * a price and a refusal displayed together would both be about whatever is in
 * the field, and only one of them could be true of it.
 */
await paste('.jr-shield-field input', TRANSPARENT_ORCHARD)
await clickText('Check this address')
await page.waitForSelector('.jr-shield-refusal', { timeout: 20000 })
const lingering = await page.evaluate(() => ({
  quote: !!document.querySelector('.jr-shield-quote'),
  accepted: !!document.querySelector('.jr-shield-ok'),
}))
check('a refusal clears the quote that was priced for a different address',
  !lingering.quote && !lingering.accepted, `quote ${lingering.quote} · accepted ${lingering.accepted}`)

check('the page raised no errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
await site.close()

const failed = results.filter(result => !result.pass)
console.log('')
console.log(`${results.length - failed.length} passed, ${failed.length} failed · screenshots in ${SHOTS}`)
if (failed.length) {
  for (const result of failed) console.log(`  FAIL ${result.name}`)
  process.exit(1)
}
