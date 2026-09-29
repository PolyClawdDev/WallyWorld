/* ------------------------------------------------------------------ *
 * The browser-held wallet, in a real browser.
 *
 * Five claims, none of which a unit test can make on its own:
 *
 *   1. a fresh Chrome profile that walks into the world comes out with a
 *      real Solana address;
 *   2. reloading the page keeps the same one;
 *   3. the export dialog reveals a key that imports, in a *different*
 *      browser profile, back to that same address;
 *   4. the secret key appears in nothing that leaves the page — no
 *      request URL, header or body, no WebSocket frame, no beacon, no
 *      console line;
 *   5. the wallet panel reaches the RPC, with no 404 and no Vercel
 *      NOT_FOUND page anywhere on it.
 *
 * Claim 4 is the important one, so it is not measured by reading the
 * source. Everything the page sends is recorded from before the first
 * script runs — `fetch`, `XMLHttpRequest`, `WebSocket.send`,
 * `navigator.sendBeacon`, plus Chrome's own view of every request — and
 * the recording is searched afterwards for the key in all three forms it
 * could plausibly be encoded in.
 *
 * The key itself is never printed by this script.
 *
 *   UI_TARGET=http://127.0.0.1:5173 node scripts/verify-embedded-wallet.mjs
 * ------------------------------------------------------------------ */

import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'
import { serveStaticOnly, serveWithApi } from './lib/serve-app.mjs'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * A static build rather than the dev server, because the dev server is shared
 * with whoever else is working in this repo and their saves push an HMR reload
 * into the middle of a run. Rebuild it with:
 *   NODE_ENV=development npx vite build --mode development --outDir dist-dev
 */
const site = await serveWithApi(API)
const UI = site.origin

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Software WebGL runs at a few frames a second; every wait is a poll. */
async function until(fn, timeoutMs = 60_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

async function launch(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 300_000,
    userDataDir: profileDir,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,900'],
  })
}

const clickText = async (page, text) => {
  const hit = await page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(t))
    if (el && !el.disabled) {
      el.click()
      return true
    }
    return false
  }, text)
  await sleep(600)
  return hit
}

/* ------------------------------------------------------------------ *
 * Everything the page emits, collected from before page scripts run.
 * ------------------------------------------------------------------ */

function recorder() {
  return { outbound: [], console: [], pageErrors: [], httpErrors: [] }
}

async function record(page, sink) {
  await page.evaluateOnNewDocument(() => {
    const log = []
    Object.defineProperty(window, '__outbound', { get: () => log, configurable: true })
    const push = (channel, url, body, extra) => {
      try {
        log.push({ channel, url: String(url ?? ''), body: typeof body === 'string' ? body : describe(body), extra: extra ?? '' })
      } catch {
        log.push({ channel, url: 'unserialisable', body: '', extra: '' })
      }
    }
    const describe = value => {
      if (value == null) return ''
      if (typeof value === 'string') return value
      if (value instanceof URLSearchParams) return value.toString()
      if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value)).join(',')
      if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).join(',')
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }

    const nativeFetch = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      const headers = init?.headers ? describe(init.headers) : ''
      push('fetch', url, init?.body, headers)
      return nativeFetch.apply(this, arguments)
    }

    const open = XMLHttpRequest.prototype.open
    const sendXhr = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__url = url
      return open.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function (body) {
      push('xhr', this.__url, body)
      return sendXhr.apply(this, arguments)
    }

    const wsSend = WebSocket.prototype.send
    WebSocket.prototype.send = function (data) {
      push('ws', this.url, data)
      return wsSend.apply(this, arguments)
    }

    if (navigator.sendBeacon) {
      const beacon = navigator.sendBeacon.bind(navigator)
      navigator.sendBeacon = (url, data) => {
        push('beacon', url, data)
        return beacon(url, data)
      }
    }
  })

  // Chrome's own view, which does not depend on the page keeping our patches.
  page.on('request', request => {
    sink.outbound.push({ channel: 'cdp', url: request.url(), body: request.postData() ?? '', extra: JSON.stringify(request.headers()) })
  })
  page.on('console', message => sink.console.push(`${message.type()} ${message.text()}`))
  page.on('pageerror', error => sink.pageErrors.push(String(error.message)))
  page.on('response', response => {
    if (/\/api\//.test(response.url()) && response.status() >= 400) sink.httpErrors.push(`${response.status()} ${response.url()}`)
  })
}

/** Drains the in-page log into the node-side sink, before a reload loses it. */
async function drain(page, sink) {
  const entries = await page.evaluate(() => (window.__outbound ?? []).slice()).catch(() => [])
  sink.outbound.push(...entries)
}

async function enterWorld(page, name) {
  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1200)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  await page.evaluate(value => {
    const input = document.querySelector('#wayfinder-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, name)
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.wallet', { timeout: 180_000 })
}

const walletState = page => page.evaluate(() => window.__wally.wallet())

async function openWalletPanel(page) {
  await clickText(page, 'Wallet')
  return until(() => page.$('.sol-panel'), 30_000)
}

const panelText = page => page.evaluate(() => document.querySelector('.sol-panel')?.textContent ?? '')

/** The wallet section on its own, scrolled to, rather than a shot of the town. */
async function shoot(page, path) {
  try {
    await page.evaluate(() => document.querySelector('.sol-panel')?.scrollIntoView({ block: 'start' }))
    await sleep(400)
    const element = await page.$('.sol-panel')
    if (element) await element.screenshot({ path })
  } catch {
    /* a screenshot is documentation, not a check; never fail the run for one */
  }
}

/* ------------------------------------------------------------------ run */

const profiles = []
async function profile(label) {
  const dir = await mkdtemp(join(tmpdir(), `voxels-${label}-`))
  profiles.push(dir)
  return dir
}

let exported = null
let firstAddress = null
const sink = recorder()

const browserOne = await launch(await profile('wallet-a'))
try {
  const page = await browserOne.newPage()
  await record(page, sink)

  console.log('\n— a fresh browser profile enters the world —')
  await enterWorld(page, 'Keyholder')

  const first = await until(async () => {
    const state = await walletState(page)
    return state?.address ? state : null
  }, 60_000)
  check('a fresh profile is given a wallet on entering the world', Boolean(first?.address), first?.address ?? 'none')
  firstAddress = first?.address ?? null
  check(
    'the address is a valid 32-byte Ed25519 public key',
    Boolean(firstAddress) && bs58.decode(firstAddress).length === 32,
  )

  const linked = await until(async () => {
    const state = await walletState(page)
    return state?.claim?.phase === 'linked' ? state.claim : null
  }, 60_000)
  check('and it is linked to one server-side account by a signed challenge', Boolean(linked), linked ? `account ${linked.accountId}` : 'never linked')

  console.log('\n— reloading the page —')
  await drain(page, sink)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1000)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.wallet', { timeout: 180_000 })
  const afterReload = await until(async () => {
    const state = await walletState(page)
    return state?.address ? state.address : null
  }, 60_000)
  check('the same wallet comes back after a reload', afterReload === firstAddress, afterReload ?? 'none')

  console.log('\n— the wallet panel —')
  const panel = await openWalletPanel(page)
  check('the wallet panel opens', Boolean(panel))
  const text = await panelText(page)
  check('it does not show a 404', !/\b404\b/.test(text), text.match(/.{0,60}404.{0,60}/)?.[0] ?? '')
  check('it does not show a foreign NOT_FOUND page', !/NOT_FOUND|could not be found/i.test(text))
  check('it names the cluster the key is on', /DEVNET|TESTNET|MAINNET/.test(text))
  check('it states the storage tradeoff without being asked', /can read it/i.test(text) && /savings/i.test(text))
  check('it does not offer a seed phrase it cannot honour', !/seed phrase/i.test(text) || /never ask|no seed phrase|There is no seed phrase/i.test(text))

  const rpcOk = await until(
    () => page.evaluate(() => {
      const panel = document.querySelector('.sol-panel')
      if (!panel) return null
      const errors = [...panel.querySelectorAll('.sol-error')].map(node => node.textContent ?? '')
      return { errors }
    }),
    20_000,
  )
  const apiErrors = (rpcOk?.errors ?? []).filter(line => /API is not where|RPC unreachable|Cluster mismatch/i.test(line))
  check('no RPC or API error is shown', apiErrors.length === 0, apiErrors.join(' | ').slice(0, 160))

  console.log('\n— exporting —')
  await clickText(page, 'Export secret key')
  const warned = await page.evaluate(() => document.querySelector('.emb-export')?.textContent ?? '')
  check('export warns before revealing anything', /Anyone who sees it owns this wallet/i.test(warned))
  check('and says plainly that there is no seed phrase for this key', /no seed phrase for this wallet/i.test(warned))
  const hiddenYet = await page.evaluate(() => document.querySelectorAll('.emb-secret').length)
  check('the key is not on screen until the second, deliberate click', hiddenYet === 0)

  await clickText(page, 'I understand')
  exported = await until(() => page.evaluate(() => document.querySelector('.emb-secret')?.value || null), 15_000)
  check('the key is revealed only after that click', Boolean(exported))
  if (exported) {
    let derived = null
    try {
      derived = Keypair.fromSecretKey(bs58.decode(exported)).publicKey.toBase58()
    } catch (error) {
      check('the exported base58 is a valid Solana secret key', false, String(error.message))
    }
    check('the exported key belongs to the address on screen', derived === firstAddress, derived ?? 'undecodable')
  }

  await clickText(page, 'Hide and close')
  await shoot(page, 'screenshots/solana/embedded-wallet.png')
  await clickText(page, 'Export secret key')
  await clickText(page, 'I understand')
  await clickText(page, 'JSON array')
  const jsonForm = await page.evaluate(() => document.querySelector('.emb-secret')?.value || null)
  let jsonDerived = null
  try {
    jsonDerived = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(jsonForm))).publicKey.toBase58()
  } catch {
    /* reported by the check below */
  }
  check('the JSON array form is the same key', jsonDerived === firstAddress)

  await drain(page, sink)
  await page.close()
} finally {
  await browserOne.close()
}

/* ------------------------------------------- the key, in a second browser */

const browserTwo = await launch(await profile('wallet-b'))
try {
  const page = await browserTwo.newPage()
  const sinkTwo = recorder()
  await record(page, sinkTwo)

  console.log('\n— a second, separate browser profile —')
  await enterWorld(page, 'Traveller')
  const own = await until(async () => (await walletState(page))?.address ?? null, 60_000)
  check('it gets its own, different wallet', Boolean(own) && own !== firstAddress, own ?? 'none')

  await openWalletPanel(page)
  await clickText(page, 'Import a key')

  // Rejected first, so the validation is exercised in the real UI rather than
  // only in the unit suite.
  await page.evaluate(() => {
    const field = document.querySelector('.emb-secret')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, 'this is not a key')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await clickText(page, 'Import this key')
  const rejection = await page.evaluate(() => [...document.querySelectorAll('.sol-error')].map(n => n.textContent ?? '').join(' '))
  check('a bad key is refused with a reason', /valid base58/i.test(rejection), rejection.slice(0, 90))
  const unchanged = await walletState(page)
  check('and the wallet is unchanged', unchanged?.address === own)

  await page.evaluate(key => {
    const field = document.querySelector('.emb-secret')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, key)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }, exported ?? '')
  await clickText(page, 'Import this key')
  const moved = await until(async () => {
    const state = await walletState(page)
    return state?.address === firstAddress ? state.address : null
  }, 20_000)
  check('the exported key imports to the same address in another browser', moved === firstAddress, moved ?? 'not imported')

  // That wallet already belongs to the first browser's account, so the server
  // must refuse to attach it to this one and must not pick a resolution. This
  // is the designed 409, and the UI has to put the choice in front of the
  // player rather than silently merging two accounts.
  const conflict = await until(async () => {
    const state = await walletState(page)
    return state?.claim?.phase === 'conflict' ? state.claim : null
  }, 30_000)
  check('the server refuses to move a wallet between accounts on its own', Boolean(conflict), conflict?.detail?.slice(0, 80) ?? 'no conflict reported')
  const conflictText = await panelText(page)
  check('and the player is told it is their decision', /already belongs to another Voxels account/i.test(conflictText))
  check('with nothing changed in the meantime', /Nothing has been changed/i.test(conflictText))

  await drain(page, sinkTwo)
  sink.outbound.push(...sinkTwo.outbound)
  sink.console.push(...sinkTwo.console)
  sink.pageErrors.push(...sinkTwo.pageErrors)
  sink.httpErrors.push(...sinkTwo.httpErrors)
  await page.close()
} finally {
  await browserTwo.close()
}

/* ------------------------------------------------- did the key ever leave */

console.log('\n— what left the page —')
if (!exported) {
  check('the exfiltration check could run', false, 'no key was exported, so there was nothing to search for')
} else {
  const raw = bs58.decode(exported)
  // Every encoding the key could plausibly be smuggled in.
  const needles = [
    ['base58 secret key', exported],
    ['hex secret key', Buffer.from(raw).toString('hex')],
    ['base64 secret key', Buffer.from(raw).toString('base64')],
    ['byte-array secret key', Array.from(raw).join(',')],
    ['base58 seed', bs58.encode(raw.slice(0, 32))],
    ['hex seed', Buffer.from(raw.slice(0, 32)).toString('hex')],
  ]

  const corpus = [
    ...sink.outbound.map(entry => `${entry.url} ${entry.extra} ${entry.body}`),
    ...sink.console,
    ...sink.pageErrors,
  ]
  const haystack = corpus.join('\n')

  console.log(`  searched ${sink.outbound.length} outbound messages and ${sink.console.length} console lines`)
  for (const [label, needle] of needles) {
    const hit = corpus.find(entry => entry.includes(needle))
    check(`the ${label} is in nothing the page sent or logged`, !hit, hit ? `found in: ${hit.slice(0, 80)}…` : '')
  }

  // The address is expected to leave: it is what the account link is for. This
  // asserts the recorder was actually recording, so a clean result above cannot
  // be a silently empty search.
  check(
    'the recorder did capture the traffic (the public address is in it, as it should be)',
    haystack.includes(firstAddress),
  )
  const channels = new Set(sink.outbound.map(entry => entry.channel))
  check('it covered fetch and the socket', channels.has('fetch') && (channels.has('ws') || channels.has('cdp')), [...channels].join(','))
}

// The one expected non-2xx: `claim/verify` answering 409 when the second
// browser imported a wallet the first browser's account already owns. Every
// other 4xx or 5xx on /api is a real failure.
const EXPECTED_409 = /409 .*\/api\/account\/claim\/verify$/
const unexpected = sink.httpErrors.filter(line => !EXPECTED_409.test(line))
check('the only non-2xx on /api is the designed link conflict', unexpected.length === 0, unexpected.slice(0, 4).join(' | '))
check('and that conflict really was returned', sink.httpErrors.some(line => EXPECTED_409.test(line)))
check('no uncaught page error', sink.pageErrors.length === 0, sink.pageErrors.slice(0, 2).join(' | '))

/* ------------------------------------------------------------------ *
 * The original bug, reproduced: the same build, served by a host with no
 * API behind it. What must NOT come back is a bare 404 quoted out of
 * web3.js.
 * ------------------------------------------------------------------ */

console.log('\n— the same build on a static host with no API —')
const staticSite = await serveStaticOnly()
const browserThree = await launch(await profile('wallet-c'))
try {
  const page = await browserThree.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.goto(staticSite.origin, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1200)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  await page.evaluate(() => {
    const input = document.querySelector('#wayfinder-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'Stranded')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.wallet', { timeout: 180_000 })
  await openWalletPanel(page)

  const shown = await until(async () => {
    const text = await panelText(page)
    return /API is not where this page is looking/i.test(text) ? text : null
  }, 30_000)
  check('the misconfiguration is named, not left as a 404', Boolean(shown))
  if (shown) {
    check('the message says which URL was tried', shown.includes(`${staticSite.origin}/api/rpc`))
    check('it calls it a configuration problem', /configuration problem/i.test(shown))
    check('it names the setting that fixes it', /VITE_API_BASE_URL/.test(shown))
    check('it explains that this origin serves the game but not the API', /serving the game files but not the API/i.test(shown))
    check('the raw "404 : NOT_FOUND" from web3.js is not what the player sees', !/404\s*:/.test(shown))
  }
  check('a wallet is still created even with no server to link it to', Boolean((await walletState(page))?.address))
  await shoot(page, 'screenshots/solana/api-misconfigured.png')
  await page.close()
} finally {
  await browserThree.close()
  await staticSite.close()
}

await site.close()
for (const dir of profiles) await rm(dir, { recursive: true, force: true }).catch(() => {})

console.log('')
if (failures.length) {
  console.log(`embedded wallet: FAILED (${failures.length})`)
  for (const failure of failures) console.log(`   ✗ ${failure}`)
  process.exit(1)
}
console.log('embedded wallet: all checks passed')
process.exit(0)
