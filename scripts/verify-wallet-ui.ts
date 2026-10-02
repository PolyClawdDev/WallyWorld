/* ------------------------------------------------------------------ *
 * Browser verification of the wallet panel and the funds labelling.
 *
 * There is no provider mock in this file any more, and that is the point.
 * Phantom was removed: there is nothing to connect, no second address, and
 * no code path in the client that can sign or submit a transaction. So the
 * things worth proving in a real browser changed shape.
 *
 * What this checks:
 *   - the network badge names the configured cluster on every screen, with
 *     no alarm strip and no `role="alert"`;
 *   - the panel contains no Phantom section, no connect control, and the
 *     word "Phantom" nowhere in what a player reads;
 *   - injecting a fake `window.phantom.solana` changes nothing, which is
 *     the check that no dormant provider path survived the removal;
 *   - the browser-held wallet is real and reaches LINKED against the
 *     running server, which exercises the account-claim flow end to end:
 *     server-issued nonce, ed25519 verification, single use;
 *   - export, import and delete all work, and a re-linked replacement
 *     wallet reaches LINKED too;
 *   - the gold-to-tokens block still states its true unavailable reason;
 *   - no RPC credential reaches the page.
 *
 * WHAT THE DISCLOSURE ADDED TO THIS FILE.
 *
 * The panel is read inside the pouch and most of it now sits behind one
 * button, so this file has to prove the split as well as the content. It
 * checks that collapsed the player can still see the funds label, the
 * address, the balance, whether the account is linked, and the line
 * saying the game cannot spend from the key; that the long prose, the
 * key controls and the payout block really are gone from the collapsed
 * panel rather than merely scrolled away; that the button opens them,
 * from the keyboard as well as the mouse; and that every warning asserted
 * below is still there once it is open. It also breaks the claim endpoint
 * on purpose at the end, to prove a real fault is shown while the
 * disclosure is shut — a fault behind a click is a fault nobody sees.
 *
 * The secret key is inspected only inside the page, by shape and length.
 * It is never returned to Node and never printed.
 *
 * Needs the API and the dev server up:
 *   npm run server   (and)   npm run dev   (then)   npm run verify:ui
 *
 * Usage:  npm run verify:ui            (devnet dev server on 5173)
 *         UI_TARGET=http://127.0.0.1:5174 UI_EXPECT=live npm run verify:ui
 * ------------------------------------------------------------------ */

import puppeteer, { type Page } from 'puppeteer'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { mkdirSync } from 'node:fs'

const TARGET = process.env.UI_TARGET ?? 'http://127.0.0.1:5173'
/** Expected funds mode: 'demo' on a test cluster, 'live' on a mainnet build. */
const EXPECT = (process.env.UI_EXPECT ?? 'demo') as 'demo' | 'live'
const LABEL = process.env.UI_LABEL ?? (EXPECT === 'live' ? 'mainnet' : 'devnet')
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

async function waitForBody(page: Page, text: string, timeout = 20_000) {
  try {
    await page.waitForFunction(t => document.body.innerText.includes(t), { timeout }, text)
    return true
  } catch {
    return false
  }
}

const panelText = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.sol-panel')
    return panel instanceof HTMLElement ? panel.innerText : ''
  })

/**
 * Nothing on the page asks for a key the player has to bring.
 *
 * Run collapsed as well as open, because the disclosure means there are now
 * two renderings of this panel and either could grow a field.
 */
const noSeedSolicited = (page: Page) =>
  page.evaluate(() => {
    const lower = document.body.innerText.toLowerCase()
    const inputs = [...document.querySelectorAll('input, textarea')]
    const suspicious = inputs.some(el => /seed|mnemonic/i.test(el.outerHTML))
    return !suspicious && !lower.includes('enter your seed') && !lower.includes('reveal private')
  })

/** The address the wallet block is currently showing, truncated as rendered. */
const shownAddress = (page: Page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sol-panel .sol-row')]
    const row = rows.find(r => r.querySelector('span')?.textContent?.trim() === 'Address')
    return row?.querySelector('code')?.textContent?.trim() ?? null
  })

async function main() {
  mkdirSync(SHOTS, { recursive: true })

  console.log('Voxels · wallet UI verification')
  console.log(`  target   ${TARGET}`)
  console.log(`  expect   funds mode ${EXPECT}`)
  console.log('  provider none — Phantom is removed; a decoy is injected to prove nothing uses it')

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    // Chrome's default GL backend reaches the real renderer even headlessly and
    // is an order of magnitude faster than SwiftShader here, which matters
    // because the world tick clamps dt and a slow frame rate is a slow world.
    args: ['--no-sandbox'],
    protocolTimeout: 120_000,
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  page.on('pageerror', error => console.log(`  [page error] ${String(error).slice(0, 300)}`))
  page.on('console', message => {
    if (message.type() === 'error') console.log(`  [console] ${message.text().slice(0, 300)}`)
  })

  /* ------------------------------------------------------------- decoy *
   * A provider that screams if anything touches it. Injected as a source
   * string because tsx compiles this file with esbuild, which rewrites named
   * object methods to `__name(...)` calls that do not exist in the page.
   *
   * Nothing in the client should look for `window.phantom` or `window.solana`
   * at all now. If some detection survived the removal, one of these getters
   * or methods fires and the flag below turns true.
   * ------------------------------------------------------------------ */
  await page.evaluateOnNewDocument(`(() => {
    window.__providerTouched = [];
    const note = what => { window.__providerTouched.push(what); };
    const provider = {
      isPhantom: true,
      isConnected: false,
      get publicKey() { note('publicKey'); return null; },
      connect: async () => { note('connect'); throw new Error('decoy'); },
      disconnect: async () => { note('disconnect'); },
      signMessage: async () => { note('signMessage'); throw new Error('decoy'); },
      signAndSendTransaction: async () => { note('signAndSendTransaction'); throw new Error('decoy'); },
      on: () => { note('on'); },
      off: () => { note('off'); },
    };
    Object.defineProperty(window, 'phantom', { get: () => { note('window.phantom'); return { solana: provider }; } });
    Object.defineProperty(window, 'solana', { get: () => { note('window.solana'); return provider; } });
  })()`)

  const fundsMode = () => page.evaluate(() => document.querySelector('[data-funds-mode]')?.getAttribute('data-funds-mode') ?? null)
  const badgeText = () => page.evaluate(() => document.querySelector('[data-funds-mode]')?.textContent?.trim() ?? null)

  /* ------------------------------------------------------------- entry */
  console.log('\nEntry screen')
  await page.goto(TARGET, { waitUntil: 'networkidle0' })
  await sleep(600)
  check(`entry badge reads ${EXPECT}`, (await fundsMode()) === EXPECT, String(await badgeText()))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-1-entry.png` })

  /* ------------------------------------------------- character select */
  console.log('\nCharacter select')
  check('the entry screen offers a way in', await clickText(page, 'Enter world'))
  check('the character select screen appears', await page.waitForSelector('#wayfinder-name', { timeout: 10_000 }).then(() => true, () => false))
  check(`select badge reads ${EXPECT}`, (await fundsMode()) === EXPECT, String(await badgeText()))

  // The name field is controlled by React, so the value has to go through the
  // value setter or React never sees it.
  await page.evaluate(() => {
    const input = document.querySelector('#wayfinder-name') as HTMLInputElement | null
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'Wallet Verify')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(300)
  await page.screenshot({ path: `${SHOTS}/${LABEL}-2-select.png` })

  /* -------------------------------------------------------- the world */
  console.log('\nIn the world')
  check('the name carries into the preview', await clickText(page, 'Continue with'))
  check('the preview screen appears', await waitForText(page, 'Enter Voxels'))
  await clickText(page, 'Enter Voxels')
  check('the world canvas mounts', await page.waitForSelector('.world-canvas', { timeout: 20_000 }).then(() => true, () => false))
  await sleep(4500)

  // The network is named by the badge alone. There is no full-width alarm strip
  // on any cluster: no code path in this build can move value at all, so the HUD
  // states the network and leaves it there.
  const alarm = await page.evaluate(() => ({
    banner: !!document.querySelector('.mainnet-banner'),
    siren: !!document.querySelector('.funds-siren'),
    alert: !!document.querySelector('.funds-badge[role="alert"]'),
  }))
  check('no full-width mainnet alarm strip in the world', !alarm.banner)
  check('the funds badge is not an alert and carries no siren', !alarm.siren && !alarm.alert)
  check(`world badge reads ${EXPECT}`, (await fundsMode()) === EXPECT, String(await badgeText()))
  if (EXPECT === 'live') {
    // The topbar is offset only when something sits above it; the banner's
    // removal must not leave that gap behind.
    const topbarTop = await page.evaluate(() => {
      const el = document.querySelector('.topbar')
      return el ? Math.round(el.getBoundingClientRect().top) : null
    })
    check('the topbar is not offset for a banner that no longer exists', topbarTop !== null && topbarTop < 40, `top=${topbarTop}px`)
  }
  await page.screenshot({ path: `${SHOTS}/${LABEL}-3-world.png` })

  /* ------------------------------------------------------ wallet panel */
  console.log('\nWallet panel')
  await page.keyboard.press('k')
  await page.waitForSelector('.sol-panel', { timeout: 10_000 }).catch(() => null)
  // The popup fades in. Photographing it mid-transition produces a translucent
  // screenshot that cannot be read, which is worse than no screenshot.
  await sleep(1200)
  check('the Solana panel is mounted in the pouch popup', await page.evaluate(() => !!document.querySelector('.sol-panel')))
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

  if (process.env.UI_DUMP) {
    const buttons = await page.evaluate(() => [...document.querySelectorAll('.sol-panel button')].map(b => b.textContent?.trim()))
    console.log('  [dump] collapsed panel text:', JSON.stringify(await panelText(page)))
    console.log('  [dump] buttons:', JSON.stringify(buttons))
  }

  /* ------------------------------------------- the collapsed summary *
   * What a player sees on opening the pouch, before touching anything.
   * The owner's complaint was that this was everything at once; the fix
   * is a summary, and the summary has to carry the facts that decide
   * where money is and whether anything is broken.
   * ------------------------------------------------------------------ */
  console.log('\nThe pouch summary, with nothing opened')
  check('the account reaches LINKED against the running server', await waitForBody(page, 'LINKED'))

  const banner = await page.evaluate(() => {
    const el = document.querySelector('.sol-panel > .sol-banner') as HTMLElement | null
    if (!el) return null
    const box = el.getBoundingClientRect()
    return { text: el.innerText, height: Math.round(box.height), inDetail: !!el.closest('.sol-detail') }
  })
  check('the funds label is a direct child of the panel, not inside the disclosure', !!banner && !banner.inDetail)
  check('and it is on screen with nothing opened', !!banner && banner.height > 0, `${banner?.height}px`)
  check(
    `it names the funds state (${EXPECT})`,
    !!banner && (EXPECT === 'live' ? /MAINNET/i.test(banner.text) : /DEMO/i.test(banner.text) && /NO REAL FUNDS/i.test(banner.text)),
    JSON.stringify(banner?.text.slice(0, 60)),
  )

  const first = await shownAddress(page)
  check('a truncated address is displayed', !!first && first.includes('…'), String(first))
  /*
   * The balance is read from the chain after mount, so the row is waited for
   * rather than sampled: it says "reading…" first. What is being checked is
   * the clause beside the figure, because a chain balance in a game's
   * inventory screen with nothing qualifying it is the thing that made this
   * readout misleading when it lived in the pouch.
   */
  const balanceRow = await page
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('.sol-panel .sol-row')]
        const row = rows.find(r => r.querySelector('span')?.textContent?.trim() === 'Balance')
        const note = row?.querySelector('small')?.textContent?.trim() ?? ''
        return note && note !== 'reading…' ? note : false
      },
      { timeout: 20_000 },
    )
    .then(handle => handle.jsonValue() as Promise<string>, () => '')
  check('the SOL balance is shown as the player\u2019s own', /yours, not the game/i.test(balanceRow), JSON.stringify(balanceRow))
  check(
    'the linked state is shown as a plate, not as "NOT LINKED"',
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sol-panel .sol-row')]
      const row = rows.find(r => r.querySelector('span')?.textContent?.trim() === 'Account')
      return row?.querySelector('.sol-plate')?.textContent?.trim() === 'LINKED'
    }),
  )

  // Sampled once everything above has settled, so the absences below are
  // absences from the finished summary and not from a half-mounted one.
  const collapsed = await panelText(page)
  check('the wallet block is present', collapsed.includes('THIS BROWSER’S WALLET') || collapsed.includes("THIS BROWSER'S WALLET"))
  check('it names the cluster next to the address', collapsed.toUpperCase().includes(EXPECT === 'live' ? 'MAINNET-BETA' : 'DEVNET'))

  // The single most important sentence in the panel. It is the reason the
  // balance beside it is not alarming, so it may never need a click.
  check(
    'the no-spend line is on screen with nothing opened',
    /The game cannot spend from this address/i.test(collapsed) && /no transaction signer anywhere in Voxels/i.test(collapsed),
  )

  // Proof the collapse is real rather than a scroll: these are the things
  // that made the pouch a wall of text, and none of them is rendered.
  const collapsedControls = await page.evaluate(() =>
    [...document.querySelectorAll('.sol-panel button')].map(el => el.textContent?.trim() ?? ''))
  check('the long storage prose is not in the collapsed panel', !/anything that can run scripts on this page/i.test(collapsed))
  check('nor the closing notes', !/One wallet, and you hold it/i.test(collapsed) && !/What that costs you/i.test(collapsed))
  check('the payout block is not in the collapsed panel', !/GOLD → TOKEN REWARDS/.test(collapsed))
  check(
    'no export, import or delete control is rendered until it is asked for',
    !collapsedControls.some(label => /export secret key|import a key|^delete$/i.test(label)),
    JSON.stringify(collapsedControls),
  )

  const toggle = await page.evaluate(() => {
    const el = document.querySelector('.sol-disclose') as HTMLElement | null
    if (!el) return null
    el.focus()
    return {
      tag: el.tagName,
      expanded: el.getAttribute('aria-expanded'),
      label: el.innerText.replace(/\s+/g, ' ').trim(),
      focused: document.activeElement === el,
      height: Math.round(el.getBoundingClientRect().height),
    }
  })
  check('a disclosure control is offered', !!toggle, JSON.stringify(toggle))
  check('it is a real button, not a clickable div', toggle?.tag === 'BUTTON')
  check('it reports itself collapsed', toggle?.expanded === 'false')
  check('it says what it opens', !!toggle && /KEYS/i.test(toggle.label) && /GOLD REWARDS/i.test(toggle.label), JSON.stringify(toggle?.label))
  check('it takes keyboard focus', toggle?.focused === true)

  const heightOf = (selector: string) =>
    page.evaluate(s => {
      const el = document.querySelector(s) as HTMLElement | null
      return el ? Math.round(el.getBoundingClientRect().height) : 0
    }, selector)
  check('no seed phrase or private key input exists in the collapsed panel', await noSeedSolicited(page))
  const collapsedHeight = await heightOf('.sol-panel')
  await page.evaluate(() => document.querySelector('.sol-panel')?.scrollIntoView({ block: 'start' }))
  await sleep(300)
  await page.screenshot({ path: `${SHOTS}/${LABEL}-4-collapsed.png` })

  /* --------------------------------------------------- opening it up *
   * Reached by Tab before it is clicked, because "it is a real button"
   * is half about the keyboard.
   *
   * It is not *activated* from the keyboard here, and that is a property
   * of the world rather than of this control: `chat/ChatBox.tsx` claims
   * Enter for the chat box and `main.tsx` claims Space to recentre the
   * camera, both with `preventDefault`, and both stand down only for a
   * field. So no button in the HUD — including the `.sol-why` control
   * this one copies — activates on Enter or Space while the world has
   * focus. Asserting otherwise here would be asserting a bug in two
   * files this panel does not own.
   * ------------------------------------------------------------------ */
  console.log('\nOpening the rest of it')
  const reachedByTab = await (async () => {
    await page.evaluate(() => {
      const copy = [...document.querySelectorAll('.sol-panel .sol-row button')].at(0) as HTMLElement | undefined
      copy?.focus()
    })
    for (let step = 0; step < 8; step++) {
      await page.keyboard.press('Tab')
      if (await page.evaluate(() => document.activeElement?.classList.contains('sol-disclose') === true)) return step + 1
    }
    return 0
  })()
  check('Tab reaches the disclosure from the address row', reachedByTab > 0, `${reachedByTab} presses`)

  // A real mouse click on the element, not a synthesised `.click()`.
  await page.click('.sol-disclose')
  await sleep(400)
  const opened = await page.evaluate(() => ({
    expanded: document.querySelector('.sol-disclose')?.getAttribute('aria-expanded') ?? null,
    detail: !!document.querySelector('.sol-detail'),
    // Nothing that states a fault, and not the funds label, may end up
    // inside the part that closes again.
    errorsInside: document.querySelectorAll('.sol-detail .sol-error').length,
    bannerInside: !!document.querySelector('.sol-detail .sol-banner'),
    summaryInside: !!document.querySelector('.sol-detail .sol-nospend'),
  }))
  check('clicking the button opens it', opened.expanded === 'true' && opened.detail, JSON.stringify(opened))
  check('the funds label did not move inside it', !opened.bannerInside)
  check('nor the summary\u2019s no-spend line', !opened.summaryInside)
  check('no error block is rendered inside the part that closes', opened.errorsInside === 0)
  const expandedHeight = await heightOf('.sol-panel')
  check(
    'the collapsed panel is a fraction of the open one',
    collapsedHeight > 0 && collapsedHeight < expandedHeight * 0.6,
    `${collapsedHeight}px collapsed vs ${expandedHeight}px open`,
  )

  const text = await panelText(page)

  /* ------------------------------------------------- Phantom is absent */
  console.log('\nNothing about Phantom is left')
  const bodyText = await page.evaluate(() => document.body.innerText)
  check('the word "Phantom" appears nowhere in the panel', !/phantom/i.test(text))
  check('nor anywhere else a player can read', !/phantom/i.test(bodyText))
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll('.sol-panel button, .sol-panel a')].map(el => el.textContent?.trim() ?? ''))
  check('no connect control is offered', !controls.some(label => /connect/i.test(label)), JSON.stringify(controls))
  check('no wallet download link is offered', !controls.some(label => /get phantom|install/i.test(label)))
  check('no extension-not-found status is shown', !/NOT FOUND|NOT CONNECTED/i.test(text))
  const touched = await page.evaluate(() => (window as unknown as { __providerTouched: string[] }).__providerTouched)
  check('the decoy provider was never touched, so no detection survived', touched.length === 0, JSON.stringify(touched))

  /* --------------------------------------------- the one real wallet */
  console.log('\nThe browser-held wallet, opened out')
  check('the key block is present', text.includes('THE KEY ITSELF'))
  check('it names the cluster beside the controls that act on the key', text.toUpperCase().includes(EXPECT === 'live' ? 'MAINNET-BETA' : 'DEVNET'))
  check('the address is still the one the summary showed', (await shownAddress(page)) === first, String(first))
  check('the panel states the storage ceiling', /anything that can run scripts on this page/i.test(text))
  check('and states that the game never spends from it', /the game never spends from it/i.test(text))
  check('the closing notes are reachable', /One wallet, and you hold it/i.test(text) && /What that costs you/i.test(text))
  check(
    'including that nobody can recover the key and Voxels will never ask for a seed phrase',
    /Nobody can recover the key for you/i.test(text) && /never ask you for a seed phrase/i.test(text),
  )

  // Two frames of the panel, because it is taller than the popup: the top,
  // with the wallet and its linked account, and the bottom, with the payout
  // notice and the footer. A single screenshot shows neither properly.
  await page.evaluate(() => document.querySelector('.sol-panel')?.scrollIntoView({ block: 'start' }))
  await sleep(400)
  await page.screenshot({ path: `${SHOTS}/${LABEL}-4-panel-top.png` })
  await page.evaluate(() => document.querySelector('.sol-footer')?.scrollIntoView({ block: 'end' }))
  await sleep(400)
  await page.screenshot({ path: `${SHOTS}/${LABEL}-4-panel-bottom.png` })
  await page.evaluate(() => document.querySelector('.sol-panel')?.scrollIntoView({ block: 'start' }))
  await sleep(300)

  /* ------------------------------------------------- no key solicited */
  check('no seed phrase or private key input exists anywhere in the open panel', await noSeedSolicited(page))

  /* ------------------------------------------------------------ export */
  console.log('\nExport')
  check('an export control is offered', await waitForText(page, 'Export secret key'))
  await clickText(page, 'Export secret key')
  await sleep(300)
  const warning = await panelText(page)
  check('it warns before revealing anything', /Anyone who sees it owns this wallet/i.test(warning))
  check('it says there is no seed phrase for this key', /There is no seed phrase for this wallet/i.test(warning))
  // The owner of this world pasted a mainnet key into a chat window because
  // the warning read as boilerplate. These two clauses are the ones that stop
  // that happening again, so they are asserted rather than trusted to survive
  // the next copy edit.
  check('it names the places a key must never be pasted', /never paste it/i.test(warning) && /chat/i.test(warning) && /screenshot/i.test(warning))
  check('it says nobody will ever ask for the key', /Nobody will ever ask you for this key/i.test(warning))
  check(
    'and names the developers and support as people who will not ask',
    /not the Voxels developers/i.test(warning) && /not support/i.test(warning),
  )
  check('nothing is revealed until the second click', await page.evaluate(() => {
    const box = document.querySelector('.emb-secret') as HTMLTextAreaElement | null
    return box === null || box.value.length === 0
  }))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-5-export-warning.png` })

  await clickText(page, 'I understand')
  await sleep(400)
  // Shape and length only. The value is never returned to Node and never logged.
  const exported = await page.evaluate(() => {
    const box = document.querySelector('.emb-secret') as HTMLTextAreaElement | null
    const value = box?.value ?? ''
    return { length: value.length, base58: /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(value) }
  })
  check('a base58 secret key of the right length is shown', exported.base58, `${exported.length} chars`)
  // Not decoration: the revealed key has to be legible as dangerous at a
  // glance, which is a thing the DOM can be asked about.
  check(
    'the revealed key is dressed as a hazard rather than an ordinary field',
    await page.evaluate(() => {
      const frame = document.querySelector('.emb-danger')
      const field = document.querySelector('.emb-secret')
      return !!frame && !!field && frame.contains(field) && /SECRET KEY ON SCREEN/i.test((frame as HTMLElement).innerText)
    }),
  )
  await clickText(page, 'JSON array')
  await sleep(250)
  const asJson = await page.evaluate(() => {
    const box = document.querySelector('.emb-secret') as HTMLTextAreaElement | null
    try {
      const parsed = JSON.parse(box?.value ?? '') as unknown
      return Array.isArray(parsed) && parsed.length === 64 && parsed.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255)
    } catch {
      return false
    }
  })
  check('the JSON form is the 64 bytes the Solana CLI writes', asJson)
  await clickText(page, 'Hide and close')
  await sleep(300)
  check('closing the dialog drops the revealed value', await page.evaluate(() => !document.querySelector('.emb-secret')))

  /* ------------------------------------------------------------ import */
  console.log('\nImport')
  // Generated here, used once, never printed. Not a fixture and not a user key.
  const incoming = Keypair.generate()
  check('an import control is offered', await waitForText(page, 'Import a key'))
  await clickText(page, 'Import a key')
  await sleep(300)
  await page.evaluate(secret => {
    const box = document.querySelector('.emb-secret') as HTMLTextAreaElement | null
    if (!box) return
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(box, secret)
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }, bs58.encode(incoming.secretKey))
  await sleep(200)
  await clickText(page, 'Import this key')
  const wantImported = `${incoming.publicKey.toBase58().slice(0, 6)}…${incoming.publicKey.toBase58().slice(-6)}`
  const importedShown = await page
    .waitForFunction(
      want => {
        const rows = [...document.querySelectorAll('.sol-panel .sol-row')]
        const row = rows.find(r => r.querySelector('span')?.textContent?.trim() === 'Address')
        return row?.querySelector('code')?.textContent?.trim() === want
      },
      { timeout: 10_000 },
      wantImported,
    )
    .then(() => true, () => false)
  check('the panel switches to the imported wallet', importedShown, `expected ${wantImported}, saw ${await shownAddress(page)}`)
  check('and says the key was imported rather than generated', /imported from a key you pasted in/i.test(await panelText(page)))
  check('the imported wallet links to the account too', await waitForBody(page, 'LINKED'))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-6-imported.png` })

  /* ------------------------------------------------------------ delete */
  console.log('\nDelete')
  check('a delete control is offered', await waitForText(page, 'Delete'))
  await clickText(page, 'Delete')
  await sleep(300)
  check('it says the key is gone for good', /gone for good unless you exported it first/i.test(await panelText(page)))
  await clickText(page, 'Delete and start a new one')
  const replaced = await page
    .waitForFunction(
      gone => {
        const rows = [...document.querySelectorAll('.sol-panel .sol-row')]
        const row = rows.find(r => r.querySelector('span')?.textContent?.trim() === 'Address')
        const shown = row?.querySelector('code')?.textContent?.trim()
        return !!shown && shown !== gone
      },
      { timeout: 10_000 },
      wantImported,
    )
    .then(() => true, () => false)
  check('a fresh wallet replaces it immediately', replaced, String(await shownAddress(page)))
  check('the replacement links to the account as well', await waitForBody(page, 'LINKED'))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-7-after-delete.png` })

  /* ---------------------------------------------------------- payout */
  console.log('\nPayout stays disabled')
  const payout = await page.evaluate(() => {
    const panel = document.querySelector('.sol-panel')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find(b => b.textContent?.includes('Convert gold to tokens')) as HTMLButtonElement | undefined
    return {
      text: panel instanceof HTMLElement ? panel.innerText : '',
      hasButton: !!button,
      disabled: !!button?.disabled,
    }
  })
  check('the payout block is present', payout.text.includes('GOLD → TOKEN REWARDS'))
  check('it is labelled unavailable', payout.text.includes('UNAVAILABLE'))
  check('the payout button exists and is disabled', payout.hasButton && payout.disabled)

  // The block now leads with a list of absences and keeps the full reason —
  // the server's, which wins over the client's fallback — one click below.
  // The summary is asserted where it is read, and the reason is asserted
  // after opening the disclosure, because none of it may quietly go missing.
  check('every blocker is named in the summary, with no room to read it as pending', [
    'TREASURY SIGNING KEY',
    'NONE',
    'WITHDRAWAL SETTINGS',
    'NO VALUES',
    'WALLY TOKEN MINT',
    'DOES NOT EXIST',
    'VERIFIED HUNTS ONLY',
  ].every(fragment => payout.text.toUpperCase().includes(fragment)))
  check(
    'the caveat that a hunt fight cannot be proved is on the face of the block',
    /PROOF A HUNT FIGHT HAPPENED/i.test(payout.text) && /NOT PROVEN/i.test(payout.text),
  )

  check('the reason is reachable without leaving the panel', await waitForText(page, 'Why this cannot be switched on'))
  await clickText(page, 'Why this cannot be switched on')
  await sleep(300)
  const why = await panelText(page)
  check('it states plainly that no WALLY mint exists', /no WALLY token mint exists/i.test(why))
  check('it still says there is no treasury signing key', /no treasury signing key/i.test(why))
  check('it still says the withdrawal settings have no values', /withdrawal settings have no values/i.test(why))
  check('it still says the server cannot prove a fight happened', /does not watch the fight/i.test(why) && /cannot prove one happened/i.test(why))
  check('and that this is not a switch anyone can flip', /not a setting anyone can switch on/i.test(why))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-8-payout-why.png` })

  /* ------------------------------------- a fault, with the panel shut *
   * The one thing the disclosure could get wrong that nothing above
   * would catch: a real fault that only shows when the player opens the
   * panel. So one is caused — the link challenge is cut off at the
   * network — and the panel is then closed on top of it.
   * ------------------------------------------------------------------ */
  console.log('\nA fault is shown with the panel closed')
  let breakClaim = true
  await page.setRequestInterception(true)
  // Rejections are swallowed because this handler outlives the interception
  // it serves: once it is switched off again, `continue` has nothing to
  // continue, and that is not a verification failure.
  const ignore = () => {}
  page.on('request', request => {
    if (breakClaim && request.url().includes('/api/account/claim/')) {
      request.abort('failed').catch(ignore)
      return
    }
    request.continue().catch(ignore)
  })

  // Deleting the wallet is what re-runs the claim, and the claim is what
  // now cannot finish. Nothing is signed and nothing is sent.
  await clickText(page, 'Delete')
  await sleep(300)
  await clickText(page, 'Delete and start a new one')
  const faulted = await waitForBody(page, 'NOT LINKED')
  check('cutting off the link challenge produces a visible fault', faulted)

  await page.click('.sol-disclose')
  await sleep(400)
  const shut = await page.evaluate(() => {
    const panel = document.querySelector('.sol-panel')
    const errors = [...document.querySelectorAll('.sol-panel .sol-error')].map(el => ({
      text: (el as HTMLElement).innerText.slice(0, 80),
      height: Math.round(el.getBoundingClientRect().height),
    }))
    return {
      expanded: document.querySelector('.sol-disclose')?.getAttribute('aria-expanded') ?? null,
      text: panel instanceof HTMLElement ? panel.innerText : '',
      errors,
    }
  })
  check('the panel is closed again', shut.expanded === 'false')
  check('the fault is still on screen', shut.errors.length > 0 && shut.errors.every(e => e.height > 0), JSON.stringify(shut.errors))
  check('it says what failed, in words', /link challenge/i.test(shut.text), JSON.stringify(shut.text.slice(-200)))
  check('and offers the way out without opening anything', await waitForText(page, 'Try linking again'))
  check('the funds label is still shown beside the fault', /MAINNET|DEMO/i.test(shut.text))
  await page.screenshot({ path: `${SHOTS}/${LABEL}-9-fault-collapsed.png` })

  // Put it back, so the run ends with a linked wallet and the interception
  // off: a verification that leaves the page broken teaches nothing.
  breakClaim = false
  await clickText(page, 'Try linking again')
  check('the fault clears when the server is reachable again', await waitForBody(page, 'LINKED'))
  await page.setRequestInterception(false)

  /* ------------------------------------------------- narrow viewport *
   * The pouch is read on phones, and the summary is the thing that has
   * to fit one. Both states are checked for overflow: a panel that is
   * wider than the popup hides its own right-hand column.
   * ------------------------------------------------------------------ */
  console.log('\nOn a phone-sized viewport')
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  await sleep(1000)
  await page.evaluate(() => document.querySelector('.sol-panel')?.scrollIntoView({ block: 'start' }))
  await sleep(300)
  const narrow = await page.evaluate(() => {
    const panel = document.querySelector('.sol-panel') as HTMLElement | null
    const toggle = document.querySelector('.sol-disclose') as HTMLElement | null
    const box = toggle?.getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      toggleOnScreen: !!box && box.width > 0 && box.right <= window.innerWidth + 1,
      text: panel?.innerText ?? '',
    }
  })
  check('nothing overflows the viewport sideways', narrow.overflow === 0, `${narrow.overflow}px`)
  check('the panel fits inside it', narrow.panelWidth > 0 && narrow.panelWidth <= 390, `${narrow.panelWidth}px`)
  check('the disclosure is reachable on a phone', narrow.toggleOnScreen)
  check(
    'the summary still carries the funds label, the address and the no-spend line',
    /MAINNET|DEMO/i.test(narrow.text) && /ADDRESS/i.test(narrow.text) && /The game cannot spend from this address/i.test(narrow.text),
  )
  await page.screenshot({ path: `${SHOTS}/${LABEL}-10-narrow-collapsed.png` })

  // Dispatched rather than clicked by coordinate: at this width the chat box
  // overlays the popup, and a coordinate click would land on the wrong thing.
  await page.evaluate(() => (document.querySelector('.sol-disclose') as HTMLButtonElement | null)?.click())
  await sleep(400)
  const narrowOpen = await page.evaluate(() => {
    const panel = document.querySelector('.sol-panel') as HTMLElement | null
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      text: panel?.innerText ?? '',
      controls: [...(panel?.querySelectorAll('button') ?? [])].map(b => b.textContent?.trim() ?? ''),
    }
  })
  check('nothing overflows sideways once it is open either', narrowOpen.overflow === 0, `${narrowOpen.overflow}px`)
  check(
    'and the key controls and the payout block are both reachable there',
    narrowOpen.controls.some(l => /Export secret key/i.test(l)) &&
      narrowOpen.controls.some(l => /Import a key/i.test(l)) &&
      narrowOpen.controls.some(l => /^Delete$/i.test(l)) &&
      narrowOpen.text.includes('GOLD → TOKEN REWARDS'),
    JSON.stringify(narrowOpen.controls),
  )
  await page.evaluate(() => document.querySelector('.sol-detail')?.scrollIntoView({ block: 'start' }))
  await sleep(300)
  await page.screenshot({ path: `${SHOTS}/${LABEL}-10-narrow-open.png` })
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await sleep(500)

  /* --------------------------------------------- the decoy, one last time *
   * Checked again at the end rather than only before the disclosure was
   * opened: half this panel had not been rendered at all at that point.
   * ---------------------------------------------------------------------- */
  const touchedAtEnd = await page.evaluate(() => (window as unknown as { __providerTouched: string[] }).__providerTouched)
  check('the decoy provider was never touched, in either state', touchedAtEnd.length === 0, JSON.stringify(touchedAtEnd))

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
