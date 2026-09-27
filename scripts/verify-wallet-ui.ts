/* ------------------------------------------------------------------ *
 * Browser verification of the wallet UI and the funds labelling.
 *
 * A real Phantom extension cannot be installed in headless Chrome, so the
 * provider is mocked: `window.phantom.solana` is replaced with an object
 * exposing the same surface the app uses (connect, disconnect,
 * signMessage, accountChanged). The signature it returns is genuine —
 * `signMessage` calls back into Node, which signs with the throwaway
 * fixture keypair — so the sign-in path is exercised end to end through
 * the real client code and the real server, and the server's ed25519
 * verification has to pass for the screenshots to show a session.
 *
 * What this cannot prove: that the real Phantom extension behaves as
 * mocked here. Its approval dialogs and its own RPC handling need a human
 * with the extension installed.
 *
 * Usage:  npm run verify:ui            (devnet dev server on 5173)
 *         UI_TARGET=http://127.0.0.1:5174 UI_EXPECT=live npm run verify:ui
 * ------------------------------------------------------------------ */

import puppeteer, { type Page } from 'puppeteer'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { mkdirSync } from 'node:fs'
import { fixtureKeypair } from './fixture-keys'

const TARGET = process.env.UI_TARGET ?? 'http://127.0.0.1:5173'
/** Expected funds mode once a wallet is connected: 'test' on devnet, 'live' on mainnet. */
const EXPECT_CONNECTED = (process.env.UI_EXPECT ?? 'test') as 'test' | 'live'
/** Mainnet is loud before connecting too, so the disconnected expectation differs. */
const EXPECT_DISCONNECTED = EXPECT_CONNECTED === 'live' ? 'live' : 'demo'
const LABEL = process.env.UI_LABEL ?? (EXPECT_CONNECTED === 'live' ? 'mainnet' : 'devnet')
const SHOTS = 'screenshots/solana'

/**
 * Fragments of the configured RPC endpoint that must never reach the browser.
 * Read from the environment rather than written down, so this file stays
 * publishable even though its job is to hunt for a credential.
 */
function secretFragments(): string[] {
  const fragments = new Set<string>(['quiknode', 'quicknode'])
  for (const key of ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_MAINNET_BETA', 'SOLANA_RPC_URL_DEVNET']) {
    const raw = process.env[key]
    if (!raw) continue
    try {
      const url = new URL(raw)
      // Public endpoints carry no credential, so asserting on them is noise.
      if (url.hostname.endsWith('.solana.com')) continue
      fragments.add(url.hostname)
      for (const segment of url.pathname.split('/')) if (segment.length >= 8) fragments.add(segment)
    } catch {
      fragments.add(raw)
    }
  }
  return [...fragments].filter(Boolean)
}

const SECRETS = secretFragments()

let passed = 0
let failed = 0

function check(name: string, condition: unknown, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const clickText = (page: Page, text: string) =>
  page.evaluate(t => {
    const target = [...document.querySelectorAll('button, a')].find(el => el.textContent?.includes(t)) as HTMLElement | undefined
    target?.click()
    return !!target
  }, text)

/** Waits for a control to exist rather than guessing how long a state takes. */
async function waitForText(page: Page, text: string, timeout = 10_000) {
  try {
    await page.waitForFunction(
      t => [...document.querySelectorAll('button, a')].some(el => el.textContent?.includes(t)),
      { timeout },
      text,
    )
    return true
  } catch {
    return false
  }
}

async function waitForBody(page: Page, text: string, timeout = 15_000) {
  try {
    await page.waitForFunction(t => document.body.innerText.includes(t), { timeout }, text)
    return true
  } catch {
    return false
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const fixture = fixtureKeypair('test-payer')
  const address = fixture.publicKey.toBase58()

  console.log('Wally World · wallet UI verification')
  console.log(`  target   ${TARGET}`)
  console.log(`  expect   disconnected=${EXPECT_DISCONNECTED}  connected=${EXPECT_CONNECTED}`)
  console.log(`  mock     Phantom provider for ${address}`)

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    // Software WebGL renders the town slowly enough that the default 30s
    // protocol timeout can expire mid-screenshot.
    protocolTimeout: 120_000,
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  page.on('pageerror', error => console.log(`  [page error] ${String(error).slice(0, 300)}`))
  page.on('console', message => {
    if (message.type() === 'error') console.log(`  [console] ${message.text().slice(0, 300)}`)
  })

  // The real signature. The page never sees the key; it asks Node for a
  // signature over the exact bytes, which is what Phantom does over IPC.
  await page.exposeFunction('__fixtureSign', (base64Message: string) => {
    const message = Buffer.from(base64Message, 'base64')
    return bs58.encode(ed25519.sign(new Uint8Array(message), fixture.secretKey.slice(0, 32)))
  })

  // Injected as a source string on purpose. tsx compiles this file with
  // esbuild, and esbuild rewrites named object methods to `__name(...)` calls
  // for stack-trace fidelity. That helper does not exist in the page, so a
  // transpiled function passed here dies with `__name is not defined` and the
  // app quite correctly reports that Phantom is missing. A string is handed to
  // the page verbatim.
  await page.evaluateOnNewDocument(`(() => {
    const ADDRESS = ${JSON.stringify(address)};
    const listeners = {};
    const publicKey = { toBase58: () => ADDRESS, toString: () => ADDRESS };
    const emit = (event, payload) => (listeners[event] || []).forEach(fn => fn(payload));
    const provider = {
      isPhantom: true,
      publicKey: null,
      isConnected: false,
      connect: async options => {
        // Mirrors Phantom: onlyIfTrusted rejects for a site never approved.
        if (options && options.onlyIfTrusted) throw new Error('not trusted');
        provider.publicKey = publicKey;
        provider.isConnected = true;
        emit('connect', publicKey);
        return { publicKey };
      },
      disconnect: async () => {
        provider.publicKey = null;
        provider.isConnected = false;
        emit('disconnect');
      },
      signMessage: async message => {
        let binary = '';
        for (const byte of message) binary += String.fromCharCode(byte);
        const signatureBase58 = await window.__fixtureSign(btoa(binary));
        // Phantom hands back raw bytes, so decode before returning.
        const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let num = 0n;
        for (const char of signatureBase58) num = num * 58n + BigInt(alphabet.indexOf(char));
        const bytes = [];
        while (num > 0n) { bytes.unshift(Number(num % 256n)); num = num / 256n; }
        for (const char of signatureBase58) { if (char !== '1') break; bytes.unshift(0); }
        return { signature: Uint8Array.from(bytes), publicKey };
      },
      signAndSendTransaction: async () => { throw new Error('mock provider does not submit transactions'); },
      on: (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); },
      off: (event, handler) => { listeners[event] = (listeners[event] || []).filter(fn => fn !== handler); },
    };
    window.phantom = { solana: provider };
    window.solana = provider;
  })()`)

  const fundsMode = () => page.evaluate(() => document.querySelector('[data-funds-mode]')?.getAttribute('data-funds-mode') ?? null)
  const badgeText = () => page.evaluate(() => document.querySelector('[data-funds-mode]')?.textContent?.trim() ?? null)

  /* ------------------------------------------------------------- entry */
  console.log('\nEntry screen')
  await page.goto(TARGET, { waitUntil: 'networkidle0' })
  await sleep(600)
  check(`entry badge reads ${EXPECT_DISCONNECTED}`, (await fundsMode()) === EXPECT_DISCONNECTED, String(await badgeText()))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-1-entry.png` })

  /* ------------------------------------------------- character select */
  console.log('\nCharacter select')
  await clickText(page, 'Enter the world')
  await sleep(500)
  check(`select badge reads ${EXPECT_DISCONNECTED}`, (await fundsMode()) === EXPECT_DISCONNECTED, String(await badgeText()))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-2-select.png` })

  /* -------------------------------------------------------- the world */
  console.log('\nIn the world')
  await clickText(page, 'Continue with')
  await sleep(500)
  await clickText(page, 'Enter Wally World')
  await sleep(4000)

  const bannerVisible = await page.evaluate(() => !!document.querySelector('.mainnet-banner'))
  check(
    EXPECT_DISCONNECTED === 'live' ? 'mainnet banner is shown in the world' : 'no mainnet banner on a test cluster',
    EXPECT_DISCONNECTED === 'live' ? bannerVisible : !bannerVisible,
  )
  await page.screenshot({ path: `${SHOTS}/${LABEL}-3-world.png` })

  /* ------------------------------------------------------ wallet panel */
  console.log('\nWallet panel · disconnected')
  await page.keyboard.press('k')
  await page.waitForSelector('.sol-panel', { timeout: 10_000 }).catch(() => null)
  const panelOpen = await page.evaluate(() => !!document.querySelector('.sol-panel'))
  check('the Solana panel is mounted in the pouch popup', panelOpen)
  if (process.env.UI_DUMP) {
    const dump = await page.evaluate(() => {
      const panel = document.querySelector('.sol-panel')
      return {
        text: panel instanceof HTMLElement ? panel.innerText : null,
        buttons: [...(panel?.querySelectorAll('button') ?? [])].map(b => b.textContent?.trim()),
      }
    })
    console.log('  [dump] panel text:', JSON.stringify(dump.text))
    console.log('  [dump] buttons:', JSON.stringify(dump.buttons))
  }
  // Provider detection is asynchronous, so wait for the control rather than
  // photographing the transient "looking for Phantom" state.
  check('a connect button is offered', await waitForText(page, 'Connect Phantom'))
  check(
    'the panel is reachable by scrolling inside the popup',
    await page.evaluate(() => {
      const panel = document.querySelector('.sol-panel')
      if (!panel) return false
      panel.scrollIntoView({ block: 'center' })
      const box = panel.getBoundingClientRect()
      return box.height > 0 && box.top < window.innerHeight && box.bottom > 0
    }),
  )
  check(
    'no seed phrase or private key input exists anywhere in the panel',
    await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase()
      const inputs = [...document.querySelectorAll('input, textarea')]
      const suspicious = inputs.some(el => /seed|mnemonic|private|secret/i.test(el.outerHTML))
      return !suspicious && !text.includes('enter your seed') && !text.includes('reveal private')
    }),
  )
  await page.screenshot({ path: `${SHOTS}/${LABEL}-4-panel-disconnected.png` })

  /* --------------------------------------------------------- connect */
  console.log('\nWallet panel · connected')
  await clickText(page, 'Connect Phantom')
  await page
    .waitForFunction(
      m => document.querySelector('[data-funds-mode]')?.getAttribute('data-funds-mode') === m,
      { timeout: 15_000 },
      EXPECT_CONNECTED,
    )
    .catch(() => null)
  check(`badge switches to ${EXPECT_CONNECTED} once connected`, (await fundsMode()) === EXPECT_CONNECTED, String(await badgeText()))
  const shownAddress = await page.evaluate(() => document.querySelector('.sol-address code')?.textContent ?? null)
  check('the truncated address is displayed', !!shownAddress && shownAddress.includes('…'), String(shownAddress))
  check('the full address is never rendered in full', await page.evaluate(a => !document.body.innerText.includes(a), address))

  await page
    .waitForFunction(() => {
      const value = document.querySelector('.sol-balance-main strong')?.textContent
      return !!value && value !== '—'
    }, { timeout: 20_000 })
    .catch(() => null)
  const balanceText = await page.evaluate(() => document.querySelector('.sol-balance-main strong')?.textContent ?? null)
  check('a SOL balance was read through the proxy', balanceText !== null && balanceText !== '—', String(balanceText))
  const lamportLine = await page.evaluate(() => [...document.querySelectorAll('.sol-fine')].map(el => el.textContent).find(t => t?.includes('lamports')) ?? null)
  check('the integer lamport figure is shown alongside it', !!lamportLine, String(lamportLine))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-5-panel-connected.png` })

  /* --------------------------------------------------------- sign in */
  // Only meaningful when the client and the API agree on the cluster: the
  // client refuses a challenge issued for a different chain, which is itself
  // correct behaviour but not what we are photographing here.
  if (EXPECT_CONNECTED === 'test') {
    console.log('\nWallet panel · signed in')
    check('a sign-in button is offered', await waitForText(page, 'Sign in with Solana'))
    await clickText(page, 'Sign in with Solana')
    check('the server accepted the signature and issued a session', await waitForBody(page, 'SIGNED IN'))
    check('the character save block appears', await waitForBody(page, 'SAVED TO THIS WALLET'))
    await page.screenshot({ path: `${SHOTS}/${LABEL}-6-panel-signed-in.png` })

    check('a save button is offered', await waitForText(page, 'Save to wallet'))
    await clickText(page, 'Save to wallet')
    check('the save was acknowledged', await waitForBody(page, 'Saved to this wallet'))
    await page.screenshot({ path: `${SHOTS}/${LABEL}-7-panel-saved.png` })
  }

  /* ---------------------------------------------------------- payout */
  console.log('\nPayout stays disabled')
  const payout = await page.evaluate(() => {
    const panel = document.querySelector('.sol-panel')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find(b => b.textContent?.includes('Convert gold to tokens')) as HTMLButtonElement | undefined
    return {
      text: panel instanceof HTMLElement ? panel.innerText : '',
      hasButton: !!button,
      disabled: !!button?.disabled,
      mentionsMint: /WALLY.{0,40}mint|mint address/i.test(panel instanceof HTMLElement ? panel.innerText : ''),
    }
  })
  check('the payout block is present', payout.text.includes('GOLD → TOKEN REWARDS'))
  check('it is labelled unavailable', payout.text.includes('UNAVAILABLE'))
  check('the payout button exists and is disabled', payout.hasButton && payout.disabled)
  check('it states plainly that no WALLY mint exists', payout.text.includes('No WALLY token mint exists'))

  /* ------------------------------------------------- credential check */
  console.log('\nNo credential in the page')
  const pageAudit = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script')].map(s => s.src || s.textContent || '').join('\n')
    return { text: document.body.innerText, html: document.documentElement.outerHTML, scripts }
  })
  for (const [name, blob] of Object.entries(pageAudit)) {
    const lower = blob.toLowerCase()
    // Fragments are numbered, never printed: the log is not a place for a secret.
    SECRETS.forEach((fragment, i) => {
      check(`no credential fragment #${i + 1} in page ${name}`, !lower.includes(fragment.toLowerCase()))
    })
  }

  await browser.close()
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
  console.log(`screenshots in ${SHOTS}/`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('\nverification crashed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
