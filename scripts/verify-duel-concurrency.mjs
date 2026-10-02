/* ------------------------------------------------------------------ *
 * Two duels at once, four real players, and nothing crossing between them.
 *
 * The brief's §7 asks for "two simultaneous matches remaining isolated".
 * The mechanism for it has existed since the arena was instanced —
 * `ARENA_SLOTS`, a slot allocator, an origin per slot — and until this
 * script ran it had only ever been argued from the source. An argument
 * from source cannot find a leak: every bug this file looks for is a bug
 * the code already says cannot happen.
 *
 * FOUR CHROME PROFILES, NOT FOUR TABS. Tabs share localStorage, so they
 * share the presence session, so they are one character being evicted
 * three times — which is the opposite of the claim. Each player here has
 * its own `userDataDir` and is as separate as two people on two laptops.
 *
 * WHAT IS MEASURED RATHER THAN LOOKED AT
 *   isolation      slot numbers, instance origins, the distance between
 *                  them, and every fighter's HP read off the snapshots
 *                  before and after the other match swings.
 *   who sees whom  the count of remote wizards in each client's scene, by
 *                  playerId. "Exactly one, and it is my opponent."
 *   no crossfire   the hit-cue tally taken where the labels are THROWN,
 *                  not where the socket receives them. Counting at the
 *                  socket would re-prove the half that was never broken.
 *   accumulation   live window intervals, live event listeners, effect
 *                  pool children, arena roots in the scene and the
 *                  renderer's own GPU resource counts, sampled in town
 *                  between three consecutive duels by the same pair.
 *   reconnect      a genuine network drop inside the grace window, via
 *                  CDP offline emulation rather than a mocked socket.
 *
 * Self-contained: builds a DEV bundle, starts its own API on its own
 * database, serves the two on one origin. A production bundle has no
 * `window.__wally`, which is why the build is not optional.
 *
 *   node scripts/verify-duel-concurrency.mjs
 * ------------------------------------------------------------------ */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'
import { serveWithApi } from './lib/serve-app.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOTS = process.env.SHOT_DIR ?? 'screenshots'
// Gitignored, so it is absent in a fresh checkout. The duel scripts once died
// on their first capture — after the duel, reporting nothing.
mkdirSync(SHOTS, { recursive: true })

const API_PORT = Number(process.env.CONCURRENCY_API_PORT ?? 8833)
const DB_DIR = 'data/concurrency-verify'
const DB_PATH = `${DB_DIR}/wally.db`
const LOCK = join(tmpdir(), 'wally-verify-duel-concurrency.pid')

/* Mirrors of the constants under test. Deliberately duplicated rather than
 * imported: if one of them moves, this run should start failing and say so,
 * not quietly follow it. */
const ARENA_SLOTS = 16
const ARENA_STRIP_X = 512
const PLATFORM_RADIUS = 20
const ARENA_PITCH = PLATFORM_RADIUS * 4
const BOUNDARY_RADIUS = 19
const SPAWN_RADIUS = 12
const LONGEST_REACH = 22
const TOWN_EDGE = 96
const GRACE_MS = 15_000
const CHALLENGE_RANGE = 18

/**
 * What `visibleTownObjects` should read inside an arena.
 *
 * The probe counts every visible scene child that is not the local player,
 * the floor or the vfx pool — and the opponent's wizard is none of those, so
 * the honest count during a duel is ONE. Asserting zero is what let an
 * invisible-opponent bug ship: the stage's entry sweep hid the other fighter,
 * the count read 0, and the number that was supposed to mean "the town is
 * gone" was really reporting that neither player could see the other. Same
 * constant and same reasoning as `verify-duel-arena.mjs`.
 */
const OPPONENT_ONLY = 1

/** Where each pair stands to open its duel. Both points of both pairs are outside town. */
const PAIRS = [
  { name: 'A', at: [{ x: 88, z: 28 }, { x: 88, z: 33 }], stake: 10 },
  { name: 'B', at: [{ x: 88, z: -28 }, { x: 88, z: -33 }], stake: 25 },
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const note = text => console.log(`      ${text}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (n, places = 2) => Number.isFinite(n) ? Number(n.toFixed(places)) : n

async function until(fn, timeoutMs = 60_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = await fn()
    if (last) return last
    await sleep(stepMs)
  }
  return null
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(' ')} failed:\n${out.slice(-2000)}`))))
  })
}

async function buildDevBundle() {
  if (process.env.ARENA_REUSE_BUNDLE && existsSync('dist-dev/index.html')) return 'reused dist-dev'
  await run('npx', ['vite', 'build', '--outDir', 'dist-dev'], { NODE_ENV: 'development' })
  return 'built dist-dev'
}

/** One run at a time: four browsers and an API are more than a port's worth of contention. */
function takeRunLock() {
  if (existsSync(LOCK)) {
    const held = Number(readFileSync(LOCK, 'utf8').trim())
    let alive = false
    try { process.kill(held, 0); alive = true } catch { alive = false }
    if (alive) throw new Error(`another run is in progress (pid ${held}); wait for it or remove ${LOCK}`)
  }
  writeFileSync(LOCK, String(process.pid))
  return () => rmSync(LOCK, { force: true })
}

/** `pkill` and `xargs -r` are not available here; explicit pids are. */
function killPortHolders() {
  const found = spawnSync('lsof', ['-nP', `-iTCP:${API_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  const pids = (found.stdout ?? '').split('\n').map(line => Number(line.trim())).filter(Boolean)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* it exited between the two calls */ }
  }
  return pids
}

async function startApi() {
  const stale = killPortHolders()
  if (stale.length) note(`killed ${stale.length} stale listener(s) on ${API_PORT}`)
  rmSync(DB_DIR, { recursive: true, force: true })
  mkdirSync(DB_DIR, { recursive: true })
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development', PORT: String(API_PORT), WALLY_DB_PATH: DB_PATH, WALLY_BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  const origin = `http://127.0.0.1:${API_PORT}`
  const up = await until(async () => {
    try {
      const res = await fetch(`${origin}/api/health`)
      return res.ok ? true : null
    } catch { return null }
  }, 60_000, 400)
  if (!up) {
    child.kill('SIGKILL')
    throw new Error(`API never came up on ${API_PORT}:\n${log.join('').slice(-2000)}`)
  }
  return { origin, stop: () => { child.kill('SIGKILL'); killPortHolders() } }
}

async function launch(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 420_000,
    userDataDir: profileDir,
    // The real GL backend, deliberately. SwiftShader runs this world at about
    // 3fps and the world tick clamps dt, so frame rate becomes movement speed
    // — and a screenshot taken under it is worthless for judging the art.
    args: ['--no-sandbox', '--window-size=1440,900'],
  })
}

/* ------------------------------------------------------------------ *
 * Accumulation probes, installed before any of the app's own code runs.
 *
 * Counted in the page rather than read back over CDP because the question
 * is "did the app forget to take something down", and the pairing is the
 * part that leaks. `DOMDebugger.getEventListeners` sees what is attached
 * right now and nothing about what was meant to come off.
 *
 * `setTimeout` is not tracked: a timeout that has fired is gone whether or
 * not anybody cleared it, so counting them would measure traffic rather
 * than leakage. A live `setInterval` is the thing that accumulates, and it
 * is the thing the duel HUD now owns one of.
 * ------------------------------------------------------------------ */
const INSTRUMENT = () => {
  const intervals = new Set()
  const rawSetInterval = window.setInterval.bind(window)
  const rawClearInterval = window.clearInterval.bind(window)
  window.setInterval = (...args) => {
    const id = rawSetInterval(...args)
    intervals.add(id)
    return id
  }
  window.clearInterval = id => {
    intervals.delete(id)
    return rawClearInterval(id)
  }

  const listeners = new Map()
  const rawAdd = EventTarget.prototype.addEventListener
  const rawRemove = EventTarget.prototype.removeEventListener
  const label = target => {
    if (target === window) return 'window'
    if (target === document) return 'document'
    return target && target.nodeName ? String(target.nodeName).toLowerCase() : 'object'
  }
  const bump = (target, type, by) => {
    const key = `${label(target)}:${type}`
    // Clamped: a `removeEventListener` for something never added is legal and
    // common, and must not drive a count below zero and hide a real leak.
    listeners.set(key, Math.max(0, (listeners.get(key) ?? 0) + by))
  }
  EventTarget.prototype.addEventListener = function (type, fn, options) {
    bump(this, type, 1)
    return rawAdd.call(this, type, fn, options)
  }
  EventTarget.prototype.removeEventListener = function (type, fn, options) {
    bump(this, type, -1)
    return rawRemove.call(this, type, fn, options)
  }

  window.__probe = {
    intervals: () => intervals.size,
    listeners: () => {
      const out = { total: 0, window: 0, document: 0, canvas: 0 }
      for (const [key, n] of listeners) {
        out.total += n
        const target = key.slice(0, key.indexOf(':'))
        if (target in out) out[target] += n
      }
      return out
    },
  }
}

/**
 * Everything that could pile up across arena visits, in one reading.
 *
 * The scene is reached through `player.parent` rather than through a probe of
 * its own, so this needs nothing added to the app to run.
 */
const COUNTS = () => {
  const w = window.__wally
  const scene = w.player.parent
  const pool = scene.getObjectByName('combat-vfx')
  const poolKids = pool ? pool.children : []
  let sprites = 0
  let meshes = 0
  for (const child of poolKids) {
    if (child.isSprite) sprites++
    else meshes++
  }
  const info = w.renderer.info
  return {
    sceneChildren: scene.children.length,
    arenaRoots: scene.children.filter(child => child.name === 'arena').length,
    vfxRoots: scene.children.filter(child => child.name === 'combat-vfx').length,
    poolChildren: poolKids.length,
    poolSprites: sprites,
    poolMeshes: meshes,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs ? info.programs.length : 0,
    intervals: window.__probe ? window.__probe.intervals() : null,
    listeners: window.__probe ? window.__probe.listeners() : null,
  }
}

const clickText = async (page, text) => {
  const hit = await page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(t))
    if (el && !el.disabled) { el.click(); return true }
    return false
  }, text)
  await sleep(400)
  return hit
}

async function enterWorld(page, name, ui) {
  const notes = []
  page.on('pageerror', e => notes.push(`pageerror ${e.message}`))
  page.on('response', r => { if (r.status() >= 400) notes.push(`http ${r.status()} ${new URL(r.url()).pathname}`) })
  page.on('console', m => {
    if (m.type() !== 'error') return
    if (/Failed to load resource/.test(m.text())) return
    notes.push(`console ${m.text()}`)
  })
  page.__notes = notes
  await page.evaluateOnNewDocument(INSTRUMENT)
  await page.goto(ui, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1200)
  await clickText(page, 'Enter')
  await page.waitForSelector('#wayfinder-name', { timeout: 60_000 })
  // The React value setter, because assigning `.value` does not notify React
  // and the typed name would be thrown away on the next render.
  await page.evaluate(value => {
    const input = document.querySelector('#wayfinder-name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, name)
  await clickText(page, 'Continue with')
  await clickText(page, 'Enter Voxels')
  await page.waitForFunction('!!window.__wally && !!window.__wally.arena', { timeout: 240_000 })
  const joined = await until(() => page.evaluate('window.__wally.pvpUi().connected === true ? window.__wally.pvpUi().playerId : null'), 120_000)
  if (!joined) throw new Error(`${name} never connected at ${ui}\n  ${notes.slice(-8).join('\n  ') || 'no browser errors'}`)
  return joined
}

const uiOf = page => page.evaluate('window.__wally.pvpUi()')
const arenaOf = page => page.evaluate('window.__wally.arena()')
const feedbackOf = page => page.evaluate('window.__wally.duelFeedback()')
const countsOf = page => page.evaluate(COUNTS)
const send = (page, msg) => page.evaluate(m => window.__wally.pvpSend(m), msg)
const seedGold = (playerId, amount) =>
  run(process.execPath, ['--import', 'tsx', 'scripts/seed-gold.ts', playerId, String(amount)], { WALLY_DB_PATH: DB_PATH })

/**
 * Every remote wizard in this client's scene, and whether it would RENDER.
 *
 * `arena().remotes` answers a different and weaker question: it lists the
 * records this client holds, at the coordinates the server gave them. A
 * wizard can be in that list, at exactly the right place, and still be
 * invisible — which is what the arena shipped as, because the stage hides
 * whatever is visible on the frame the floor goes up and the opponent had
 * been standing in the town a second earlier. Every numeric probe passed and
 * each fighter was alone on the floor. So visibility is walked up the whole
 * parent chain here: a visible mesh under a hidden group draws nothing.
 */
const drawnFoes = page => page.evaluate(() => {
  const scene = window.__wally.player.parent
  const out = []
  scene.traverse(node => {
    if (!node.userData || !node.userData.remotePlayer) return
    let visible = node.visible
    let parent = node.parent
    while (parent) { visible = visible && parent.visible; parent = parent.parent }
    out.push({ id: node.userData.pvpId, drawn: visible, x: node.position.x, z: node.position.z })
  })
  return out
})

const pose = page => page.evaluate(() => ({
  x: window.__wally.player.position.x,
  z: window.__wally.player.position.z,
  facing: window.__wally.player.rotation.y,
}))

/** This client's own fighter, as the simulation sees it. */
const mine = async page => {
  const state = await uiOf(page)
  if (!state.duel) return null
  return state.duel.a.playerId === state.playerId ? state.duel.a : state.duel.b
}
const theirs = async page => {
  const state = await uiOf(page)
  if (!state.duel) return null
  return state.duel.a.playerId === state.playerId ? state.duel.b : state.duel.a
}

/** Walks somewhere the server will agree to, one sub-snap hop at a time. */
async function standAt(page, x, z) {
  for (let attempt = 0; attempt < 140; attempt++) {
    const self = await page.evaluate('window.__wally.pvp().self')
    if (!self) { await sleep(250); continue }
    const gap = Math.hypot(self.x - x, self.z - z)
    if (gap < 2) return self
    const step = Math.min(8, gap)
    await page.evaluate((gx, gz) => {
      window.__wally.player.position.set(gx, window.__wally.player.position.y, gz)
    }, self.x + ((x - self.x) / gap) * step, self.z + ((z - self.z) / gap) * step)
    await sleep(320)
  }
  return page.evaluate('window.__wally.pvp().self')
}

let seq = 5000
const swing = async (page, duelId, n = 1) => {
  for (let i = 0; i < n; i++) await send(page, { t: 'input', duelId, seq: seq++, kind: 'attack' })
}

/** Opens one duel and returns the snapshot the challenger's client holds. */
async function openArena(challenger, target, targetId, stake) {
  await send(challenger, { t: 'challenge', playerId: targetId, stake })
  const invite = await until(async () => (await uiOf(target)).invite, 30_000)
  if (!invite) throw new Error(`no invite: ${(await uiOf(challenger)).error ?? 'no reason given'}`)
  await send(target, { t: 'accept', challengeId: invite.challengeId })
  const duel = await until(async () => (await uiOf(challenger)).duel, 30_000)
  if (!duel) throw new Error(`no duel opened: ${(await uiOf(challenger)).error ?? 'no reason given'}`)
  return duel
}

/** Fights until somebody wins, then forces the defined ending if nobody does. */
async function fightToResult(pages, duelId, swings = 70) {
  for (let i = 0; i < swings; i++) {
    await swing(pages[0], duelId, 1)
    await swing(pages[1], duelId, 1)
    if ((await uiOf(pages[0])).result?.duelId === duelId) break
    await sleep(380)
  }
  let result = await until(async () => {
    const r = (await uiOf(pages[0])).result
    return r?.duelId === duelId ? r : null
  }, 20_000)
  if (!result) {
    // A stalemate is not what is under test; end it the defined way.
    await send(pages[1], { t: 'surrender', duelId })
    result = await until(async () => {
      const r = (await uiOf(pages[0])).result
      return r?.duelId === duelId ? r : null
    }, 30_000)
  }
  return result
}

/** Waits for the instance to be gone from this client's scene. */
const outOfArena = page => until(async () => {
  const a = await arenaOf(page)
  return a.view === null || a.view.phase === 'closed' ? a : null
}, 40_000, 400)

async function main() {
  console.log(`Voxels · two duels at once, four Chrome profiles · pid ${process.pid}\n`)
  const releaseLock = takeRunLock()
  process.on('exit', releaseLock)
  note(await buildDevBundle())
  const api = await startApi()
  const host = await serveWithApi(api.origin, 'dist-dev')
  const UI = host.origin
  note(`api ${api.origin} · game ${UI}`)

  const root = await mkdtemp(join(tmpdir(), 'wally-concurrency-'))
  const browsers = []
  for (const slot of ['a', 'b', 'c', 'd']) browsers.push(await launch(join(root, slot)))

  /*
   * Closing a browser twice is what this has to be proof against. Two of the
   * four are let go halfway through to give the rest of the run some machine
   * back, and the teardown below then asked the same dead CDP connection to
   * close again — which never answers. The run printed all its results and
   * then hung for ever, with no exit code, which is worse than a failure.
   */
  const closed = new Set()
  const shut = async browser => {
    if (closed.has(browser)) return
    closed.add(browser)
    try { await browser.close() } catch { /* it went away on its own */ }
  }

  try {
    const pages = []
    for (const browser of browsers) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900 })
      pages.push(page)
    }
    const [pageA, pageB, pageC, pageD] = pages
    const names = ['Ash', 'Birch', 'Cedar', 'Dorn']
    const ids = []
    for (const [i, page] of pages.entries()) ids.push(await enterWorld(page, names[i], UI))
    const [idA, idB, idC, idD] = ids

    /* ---- 1. four separate players ------------------------------------ */
    check('four profiles are four different players', new Set(ids).size === 4, ids.join(' / '))
    check('each of the four sees the other three in the town', Boolean(await until(async () => {
      const seen = []
      for (const page of pages) seen.push((await uiOf(page)).others)
      return seen.every(n => n >= 3) ? seen : null
    }, 90_000)))

    const SEED = 500
    const opening = []
    for (const page of pages) opening.push((await uiOf(page)).gold?.available ?? 0)
    for (const id of ids) await seedGold(id, SEED)
    const funded = await until(async () => {
      const now = []
      for (const page of pages) now.push((await uiOf(page)).gold?.available ?? 0)
      return now.every((v, i) => v >= opening[i] + SEED) ? now : null
    }, 40_000, 400)
    check('all four are funded before anything is staked', Boolean(funded), (funded ?? []).join(' / '))

    /* ---- 2. two pairs, far enough apart to be two pairs -------------- */
    const pairs = [
      { ...PAIRS[0], pages: [pageA, pageB], ids: [idA, idB] },
      { ...PAIRS[1], pages: [pageC, pageD], ids: [idC, idD] },
    ]
    for (const pair of pairs) {
      for (const [i, page] of pair.pages.entries()) await standAt(page, pair.at[i].x, pair.at[i].z)
    }
    const townPoses = []
    for (const page of pages) townPoses.push(await pose(page))
    note(`town poses · ${townPoses.map((p, i) => `${names[i]} ${round(p.x, 1)},${round(p.z, 1)}`).join(' · ')}`)
    const outsideTown = await until(async () => {
      const flags = []
      for (const page of pages) flags.push((await page.evaluate('window.__wally.pvp().self'))?.inTown)
      return flags.every(f => f === false) ? flags : null
    }, 30_000)
    check('all four are standing on open ground, where a challenge is legal', Boolean(outsideTown))
    const crossGap = Math.hypot(townPoses[0].x - townPoses[2].x, townPoses[0].z - townPoses[2].z)
    check('the two pairs are out of challenge range of each other', crossGap > CHALLENGE_RANGE,
      `${round(crossGap, 1)}m apart, challenges reach ${CHALLENGE_RANGE}m`)

    /* ---- 3. both duels open, and overlap ----------------------------- */
    // Different stakes on purpose: a pot is then a number that identifies which
    // match it belongs to, so "each match's pot is its own" is arithmetic.
    const duel1 = await openArena(pageA, pageB, idB, pairs[0].stake)
    const duel2 = await openArena(pageC, pageD, idD, pairs[1].stake)
    check('two duels are open at the same time', duel1.duelId !== duel2.duelId,
      `${duel1.duelId} · ${duel2.duelId}`)

    const bothFighting = await until(async () => {
      const [a, c] = [await arenaOf(pageA), await arenaOf(pageC)]
      return a.view?.phase === 'fighting' && c.view?.phase === 'fighting' ? { a: a.view, c: c.view } : null
    }, 120_000, 150)
    check('both matches reach combat, and are in it simultaneously', Boolean(bothFighting),
      bothFighting ? `${bothFighting.a.id} and ${bothFighting.c.id}` : 'never overlapped')

    /* ---- 4. different slots, different ground ------------------------ */
    const views = []
    for (const page of pages) views.push((await arenaOf(page)).view)
    const [vA, vB, vC, vD] = views
    check('the two fighters in a match share one instance', vA.id === vB.id && vC.id === vD.id,
      `${vA.id} / ${vB.id} · ${vC.id} / ${vD.id}`)
    check('the two matches are in different instances', vA.id !== vC.id, `${vA.id} vs ${vC.id}`)
    const originGap = Math.hypot(vA.originX - vC.originX, vA.originZ - vC.originZ)
    note(`match A origin ${vA.originX},${vA.originZ} · match B origin ${vC.originX},${vC.originZ} · ${round(originGap, 1)}m apart`)
    check('both instances stand on the arena strip, well outside the town',
      vA.originX === ARENA_STRIP_X && vC.originX === ARENA_STRIP_X && Math.abs(vA.originX) > TOWN_EDGE,
      `x=${vA.originX} and ${vC.originX}, town ends at ${TOWN_EDGE}`)
    check('they are on different slots of that strip', vA.originZ !== vC.originZ,
      `z=${vA.originZ} and ${vC.originZ}`)
    // The slot each instance holds, recovered from its origin: the allocator is
    // server-side and this is the only handle a client has on its number.
    const slotOf = view => Math.round((view.originZ / ARENA_PITCH) + ((ARENA_SLOTS - 1) / 2))
    const slots = [slotOf(vA), slotOf(vC)]
    check('each match holds a slot inside the declared bound',
      slots.every(s => Number.isInteger(s) && s >= 0 && s < ARENA_SLOTS) && slots[0] !== slots[1],
      `slots ${slots.join(' and ')} of 0..${ARENA_SLOTS - 1}`)
    check('the instances are a full pitch apart', Math.abs(originGap - ARENA_PITCH) < 0.5,
      `${round(originGap, 1)}m, pitch ${ARENA_PITCH}m`)
    // The claim that actually matters: not merely that they are apart, but that
    // the gap is wider than anything in the game can throw.
    const edgeGap = originGap - 2 * BOUNDARY_RADIUS
    check('the gap between the two floors is wider than the longest reach in any kit',
      edgeGap > LONGEST_REACH, `${round(edgeGap, 1)}m of empty space, longest reach ${LONGEST_REACH}m`)

    /* ---- 5. each fighter sees exactly one other person --------------- */
    const inside = []
    for (const page of pages) inside.push(await arenaOf(page))
    const expectOpponent = [idB, idA, idD, idC]
    for (const [i, report] of inside.entries()) {
      check(`${names[i]} sees exactly one other player, and it is their own opponent`,
        report.remotes.length === 1 && report.remotes[0].playerId === expectOpponent[i],
        `${report.remotes.length} remote(s): ${report.remotes.map(r => r.playerId).join(',') || 'none'}`)
    }
    /* And is actually DRAWN. The list above says the record exists at the
     * right coordinates; this says the wizard renders. */
    for (const [i, page] of pages.entries()) {
      const drawn = await drawnFoes(page)
      const own = views[i]
      check(`${names[i]} can SEE their opponent, drawn on the floor in front of them`,
        drawn.length === 1 && drawn[0].drawn === true && drawn[0].id === expectOpponent[i] &&
        Math.hypot(drawn[0].x - own.originX, drawn[0].z - own.originZ) < BOUNDARY_RADIUS,
        drawn.map(f => `${f.id.slice(0, 8)} ${f.drawn ? 'drawn' : 'NOT DRAWN'} at ${round(f.x, 1)},${round(f.z, 1)}`).join(' · ') || 'no wizard in the scene at all')
    }
    check('nobody has any of the town drawn behind them, and everybody still has their opponent',
      inside.every(report => report.visibleTownObjects === OPPONENT_ONLY),
      `${inside.map(r => r.visibleTownObjects).join('/')} (expected ${OPPONENT_ONLY} each)`)
    check('every client built its own floor',
      inside.every((report, i) => report.stage.arenaId === views[i].id && report.stage.failure === null),
      inside.map(r => r.stage.failure ?? 'ok').join(' · '))

    /* Positions, which is where a leak would actually show: a fighter from one
     * match standing inside the other match's boundary. */
    const fighters = []
    for (const page of pages) fighters.push(await mine(page))
    for (const [i, fighter] of fighters.entries()) {
      const own = views[i]
      const other = i < 2 ? vC : vA
      const rOwn = Math.hypot(fighter.x - own.originX, fighter.z - own.originZ)
      const rOther = Math.hypot(fighter.x - other.originX, fighter.z - other.originZ)
      check(`${names[i]} stands on their own floor and nowhere near the other one`,
        Math.abs(rOwn - SPAWN_RADIUS) < 3 && rOther > BOUNDARY_RADIUS + LONGEST_REACH,
        `${round(rOwn)}m from own centre, ${round(rOther)}m from the other match's centre`)
    }

    /* ---- 6. each match counts its own clock -------------------------- */
    // Sampled as a set rather than once: the two instances started seconds
    // apart, so their round clocks must differ, and the two clients inside one
    // instance must not.
    const clockSamples = []
    for (let i = 0; i < 12; i++) {
      const [uA, uB, uC, uD] = [await uiOf(pageA), await uiOf(pageB), await uiOf(pageC), await uiOf(pageD)]
      clockSamples.push({
        a: uA.duel?.roundStartedAtMs ?? null,
        b: uB.duel?.roundStartedAtMs ?? null,
        c: uC.duel?.roundStartedAtMs ?? null,
        d: uD.duel?.roundStartedAtMs ?? null,
        textA: await pageA.evaluate(() => document.querySelector('.pvp-duel-clock')?.textContent ?? null),
        textB: await pageB.evaluate(() => document.querySelector('.pvp-duel-clock')?.textContent ?? null),
      })
      await sleep(250)
    }
    const usable = clockSamples.filter(s => s.a !== null && s.b !== null && s.c !== null && s.d !== null)
    check('the round timer is driven off a server timestamp, not a client clock',
      usable.length >= 8 && usable.every(s => Number.isFinite(s.a) && s.a > 0),
      `${usable.length} samples · match A started at ${usable[0]?.a}`)
    check('both fighters in a match were given the SAME round start',
      usable.length > 0 && usable.every(s => s.a === s.b) && usable.every(s => s.c === s.d),
      `A/B ${usable[0]?.a === usable[0]?.b ? 'agree' : 'differ'} · C/D ${usable[0]?.c === usable[0]?.d ? 'agree' : 'differ'}`)
    check('the two matches have round starts of their own',
      usable.length > 0 && usable.every(s => s.a !== s.c),
      `${usable[0]?.a} vs ${usable[0]?.c} · ${Math.abs((usable[0]?.a ?? 0) - (usable[0]?.c ?? 0))}ms apart`)
    const bothText = clockSamples.filter(s => s.textA && s.textB)
    const parseClock = text => {
      const [m, s] = text.split(':').map(Number)
      return m * 60 + s
    }
    // Read one after the other, tens of milliseconds apart, so a sample that
    // straddles a second honestly disagrees by one. More than that is drift.
    const clockApart = bothText.filter(s => Math.abs(parseClock(s.textA) - parseClock(s.textB)) > 1)
    check('and the clock on the two screens agrees as it runs',
      bothText.length >= 6 && clockApart.length === 0,
      `${bothText.length} comparable samples, ${clockApart.length} further apart than a second · showing ${bothText[bothText.length - 1]?.textA}`)
    check("each match's pot is its own",
      duel1.pot === pairs[0].stake * 2 && duel2.pot === pairs[1].stake * 2 && duel1.pot !== duel2.pot,
      `A pot ${duel1.pot} · B pot ${duel2.pot}`)
    check('and the session score in each is its own, starting from nothing',
      [vA, vB, vC, vD].every(v => v.series.aWins === 0 && v.series.bWins === 0 && v.series.draws === 0) &&
      vA.matchNumber === 1 && vC.matchNumber === 1,
      `A match ${vA.matchNumber} · B match ${vC.matchNumber}`)

    /* ---- 7. damage in one match never lands in the other ------------- */
    /* Counted where the labels are THROWN — `duelFeedback().drawn` — and not at
     * the socket. An earlier pass counted at the socket, which would have
     * re-proved the half of this that was never broken: the question is not
     * whether the far match's frames arrive, it is whether anything from the
     * near match is ever drawn in the far one. */
    const quietBefore = { c: await feedbackOf(pageC), d: await feedbackOf(pageD) }
    const hpBefore = { c: await mine(pageC), d: await mine(pageD) }
    for (let i = 0; i < 14; i++) {
      await swing(pageA, duel1.duelId, 1)
      await swing(pageB, duel1.duelId, 1)
      await sleep(260)
    }
    const hpAfter = { c: await mine(pageC), d: await mine(pageD) }
    const quietAfter = { c: await feedbackOf(pageC), d: await feedbackOf(pageD) }
    const selfA = await mine(pageA)
    const foeA = await theirs(pageA)
    check('match A really did trade blows', selfA.hp < selfA.maxHp || foeA.hp < foeA.maxHp,
      `Ash ${selfA.hp}/${selfA.maxHp} · Birch ${foeA.hp}/${foeA.maxHp}`)
    check('and not one point of it landed on anybody in match B',
      hpAfter.c.hp === hpBefore.c.hp && hpAfter.d.hp === hpBefore.d.hp && hpAfter.c.hp === hpAfter.c.maxHp,
      `Cedar ${hpBefore.c.hp}->${hpAfter.c.hp} · Dorn ${hpBefore.d.hp}->${hpAfter.d.hp}`)
    check('no projectile, spark or damage number was produced in match B either',
      quietAfter.c.drawn.damage === quietBefore.c.drawn.damage &&
      quietAfter.d.drawn.damage === quietBefore.d.drawn.damage &&
      quietAfter.c.drawn.cast === quietBefore.c.drawn.cast &&
      quietAfter.c.drawn.boundary === quietBefore.c.drawn.boundary,
      `Cedar has produced ${quietAfter.c.drawn.damage} damage / ${quietAfter.c.drawn.cast} cast cues in total`)
    const cStill = await arenaOf(pageC)
    check('and match B still cannot see anybody from match A',
      cStill.remotes.length === 1 && cStill.remotes[0].playerId === idD)

    /* The other direction, because an isolation bug has a side.
     *
     * Match A's two fighters are called off first. A basic attack is a
     * STANDING order — `attacking` stays true until something clears it — so a
     * pair left mid-exchange goes on hitting each other, and "nothing changed
     * in match A" would then be false for a reason that has nothing to do with
     * match B. The sleep is for a blow already in flight. */
    await send(pageA, { t: 'input', duelId: duel1.duelId, seq: seq++, kind: 'stop' })
    await send(pageB, { t: 'input', duelId: duel1.duelId, seq: seq++, kind: 'stop' })
    await sleep(2000)
    const hpBeforeA = { a: await mine(pageA), b: await mine(pageB) }
    const quietBeforeA = { a: await feedbackOf(pageA), b: await feedbackOf(pageB) }
    for (let i = 0; i < 14; i++) {
      await swing(pageC, duel2.duelId, 1)
      await swing(pageD, duel2.duelId, 1)
      await sleep(260)
    }
    const selfC = await mine(pageC)
    const foeC = await theirs(pageC)
    check('match B trades blows of its own', selfC.hp < selfC.maxHp || foeC.hp < foeC.maxHp,
      `Cedar ${selfC.hp}/${selfC.maxHp} · Dorn ${foeC.hp}/${foeC.maxHp}`)
    const hpAfterA = { a: await mine(pageA), b: await mine(pageB) }
    const quietAfterA = { a: await feedbackOf(pageA), b: await feedbackOf(pageB) }
    check('and none of it reached match A, whose fighters were standing idle',
      hpAfterA.a.hp === hpBeforeA.a.hp && hpAfterA.b.hp === hpBeforeA.b.hp,
      `Ash ${hpBeforeA.a.hp}->${hpAfterA.a.hp} · Birch ${hpBeforeA.b.hp}->${hpAfterA.b.hp}`)
    check("nor produced a single cue on either of match A's screens",
      quietAfterA.a.drawn.damage === quietBeforeA.a.drawn.damage &&
      quietAfterA.b.drawn.damage === quietBeforeA.b.drawn.damage,
      `Ash ${quietBeforeA.a.drawn.damage}->${quietAfterA.a.drawn.damage} labels`)

    /* ---- 8. both settle, each on its own terms ----------------------- */
    const goldBefore = []
    for (const page of pages) goldBefore.push((await uiOf(page)).gold?.available ?? 0)
    const result1 = await fightToResult([pageA, pageB], duel1.duelId)
    const result2 = await fightToResult([pageC, pageD], duel2.duelId)
    const result1B = await until(async () => {
      const r = (await uiOf(pageB)).result
      return r?.duelId === duel1.duelId ? r : null
    }, 30_000)
    const result2B = await until(async () => {
      const r = (await uiOf(pageD)).result
      return r?.duelId === duel2.duelId ? r : null
    }, 30_000)
    check('both matches settle', Boolean(result1 && result2),
      `A ${result1?.kind} · B ${result2?.kind}`)
    check('each result belongs to its own match', result1?.duelId === duel1.duelId && result2?.duelId === duel2.duelId &&
      result1?.arenaId !== result2?.arenaId, `${result1?.arenaId} vs ${result2?.arenaId}`)
    check('each result names the right opponent',
      result1?.opponentId === idB && result2?.opponentId === idD,
      `A vs ${result1?.opponentName} · B vs ${result2?.opponentName}`)
    check('each result carries its own stake and pot',
      result1?.stake === pairs[0].stake && result2?.stake === pairs[1].stake,
      `${result1?.stake} and ${result2?.stake}`)
    check('each match reports a session score of exactly one match',
      (result1?.series.yours + result1?.series.theirs + result1?.series.draws) === 1 &&
      (result2?.series.yours + result2?.series.theirs + result2?.series.draws) === 1)
    check('the two sides of each match agree who won',
      result1?.winnerId === result1B?.winnerId && result2?.winnerId === result2B?.winnerId,
      `A ${result1?.winnerId} · B ${result2?.winnerId}`)
    /* The round duration §5 asked for, and the reason it is a server number:
     * both panels have to show the same one. */
    check('the results panel is given a round duration measured on the server',
      result1?.roundMs > 0 && result2?.roundMs > 0, `A ${result1?.roundMs}ms · B ${result2?.roundMs}ms`)
    check('and both fighters in a match are told the same duration',
      result1?.roundMs === result1B?.roundMs && result2?.roundMs === result2B?.roundMs,
      `A ${result1?.roundMs}/${result1B?.roundMs} · B ${result2?.roundMs}/${result2B?.roundMs}`)
    check('the two matches lasted different lengths, each its own',
      result1?.roundMs !== result2?.roundMs, `${result1?.roundMs} vs ${result2?.roundMs}`)
    const panelStats = await pageA.evaluate(() => {
      const out = {}
      for (const cell of document.querySelectorAll('.pvp-result .pvp-stats div')) {
        out[cell.querySelector('dt')?.textContent ?? '?'] = cell.querySelector('dd')?.textContent ?? ''
      }
      return out
    })
    check('the panel shows the round duration and the opponent name the spec asked for',
      Boolean(panelStats.Round) && panelStats.Opponent === result1?.opponentName,
      `Round "${panelStats.Round}" · Opponent "${panelStats.Opponent}"`)
    check("the gold that moved in each match is that match's stake and no other",
      (Math.abs(result1.yourDelta) === pairs[0].stake || result1.refunded) &&
      (Math.abs(result2.yourDelta) === pairs[1].stake || result2.refunded),
      `A ${result1?.yourDelta} on a ${pairs[0].stake} stake · B ${result2?.yourDelta} on a ${pairs[1].stake} stake`)

    /* ---- 9. four players, four town positions ------------------------ */
    await clickText(pageA, 'Leave arena')
    await clickText(pageC, 'Leave arena')
    for (const [i, page] of pages.entries()) check(`${names[i]} is let out of the arena`, Boolean(await outOfArena(page)))
    const home = []
    for (const page of pages) home.push(await pose(page))
    for (const [i, back] of home.entries()) {
      const drift = Math.hypot(back.x - townPoses[i].x, back.z - townPoses[i].z)
      check(`${names[i]} is back on their own saved town spot`, drift < 1.5,
        `${round(townPoses[i].x, 1)},${round(townPoses[i].z, 1)} -> ${round(back.x, 1)},${round(back.z, 1)} (${round(drift)}m)`)
    }
    check('and the four of them are in two separate places, as they were',
      Math.abs(home[0].z - home[2].z) > 40 && Math.abs(home[1].z - home[3].z) > 40,
      `pair A at z≈${round(home[0].z, 1)} · pair B at z≈${round(home[2].z, 1)}`)
    for (const [i, page] of pages.entries()) {
      check(`${names[i]} has the town drawn again`, (await arenaOf(page)).visibleTownObjects > 10)
    }
    const reserved = []
    const goldAfter = []
    for (const page of pages) {
      const gold = (await uiOf(page)).gold
      reserved.push(gold?.reserved ?? -1)
      goldAfter.push(gold?.available ?? -1)
    }
    check('no gold is left escrowed anywhere', reserved.every(r => r === 0), reserved.join('/'))
    note(`gold · ${names.map((n, i) => `${n} ${goldBefore[i]}->${goldAfter[i]}`).join(' · ')}`)

    /* Two of the four are no longer needed, and four browsers plus an API is a
     * lot of machine. Closing them here gives the rest of the run headroom. */
    await shut(browsers[2])
    await shut(browsers[3])
    note('closed Cedar and Dorn; the rest of the run is the original pair')

    /* ---- 10. three visits in a row, counted -------------------------- */
    /*
     * §7's "repeated arena visits without duplicated controls, effects, or
     * listeners". Sampled in the TOWN between visits, with no arena up and the
     * cues given time to expire, so what is compared is the resting state of
     * the client rather than the middle of a fight.
     */
    const visits = []
    const baseline = await countsOf(pageA)
    note(`resting counts before any repeat · intervals ${baseline.intervals} · listeners ${baseline.listeners.total} (window ${baseline.listeners.window}, document ${baseline.listeners.document}, canvas ${baseline.listeners.canvas}) · scene ${baseline.sceneChildren} · vfx pool ${baseline.poolChildren} · geometries ${baseline.geometries} · textures ${baseline.textures}`)

    for (let visit = 1; visit <= 3; visit++) {
      await standAt(pageA, PAIRS[0].at[0].x, PAIRS[0].at[0].z)
      await standAt(pageB, PAIRS[0].at[1].x, PAIRS[0].at[1].z)
      await pageA.evaluate(() => window.__wally.pvpClearError())
      await pageB.evaluate(() => window.__wally.pvpClearError())
      const duel = await openArena(pageA, pageB, idB, PAIRS[0].stake)

      /* ---- the screenshots §7 asks for, on the first repeat ---------- */
      if (visit === 1) {
        const mid = await until(async () => {
          const digit = await pageA.evaluate(() => document.querySelector('.pvp-count')?.textContent ?? null)
          return digit && digit !== 'FIGHT' ? digit : null
        }, 60_000, 60)
        if (mid) await pageA.screenshot({ path: `${SHOTS}/duel-countdown.png` })
        check('the countdown was caught mid-count and photographed', Boolean(mid), `showing ${mid}`)
      }

      const fighting = await until(async () => (await arenaOf(pageA)).view?.phase === 'fighting', 90_000)
      check(`visit ${visit} reaches combat`, Boolean(fighting))

      if (visit === 1) {
        // A fighting vantage: the camera is already where a player's is, and
        // both fighters are on their marks with the clock running.
        await sleep(900)
        await pageA.screenshot({ path: `${SHOTS}/duel-arena-floor.png` })
        await swing(pageA, duel.duelId, 2)
        await swing(pageB, duel.duelId, 2)
        await sleep(500)
        const clock = await pageA.evaluate(() => document.querySelector('.pvp-duel-clock')?.textContent ?? null)
        const bars = await pageA.evaluate(() => document.querySelector('.pvp-duel-bar')?.textContent ?? null)
        await pageA.screenshot({ path: `${SHOTS}/duel-round-timer.png` })
        check('the active round shows both health bars and the new round timer',
          Boolean(clock) && /\d+\/\d+/.test(bars ?? ''), `clock "${clock}" · bar "${bars}"`)
      }

      const result = await fightToResult([pageA, pageB], duel.duelId)
      check(`visit ${visit} settles`, Boolean(result), `${result?.kind} · ${result?.reason}`)
      if (visit === 1) {
        await sleep(600)
        await pageA.screenshot({ path: `${SHOTS}/duel-results-panel.png` })
      }
      await clickText(pageA, 'Leave arena')
      await outOfArena(pageA)
      await outOfArena(pageB)
      // Back in town and settled: a float label lives 850ms, so this is long
      // enough that what is counted next is a resting client and not a fight
      // still fading out.
      await sleep(2500)
      if (visit === 1) {
        check('the town is drawn again after the first repeat', (await arenaOf(pageA)).visibleTownObjects > 10)
        await pageA.screenshot({ path: `${SHOTS}/duel-town-return.png` })
      }
      visits.push({ visit, a: await countsOf(pageA), b: await countsOf(pageB) })
      const last = visits[visit - 1].a
      note(`after visit ${visit} · intervals ${last.intervals} · listeners ${last.listeners.total} · scene ${last.sceneChildren} · arena roots ${last.arenaRoots} · vfx roots ${last.vfxRoots} · pool ${last.poolChildren} (${last.poolSprites} sprites) · geometries ${last.geometries} · textures ${last.textures} · programs ${last.programs}`)
    }

    check('three duels in a row all happened', visits.length === 3)
    const first = visits[0]
    const third = visits[2]
    check('no arena root is left in the scene after an arena visit',
      visits.every(v => v.a.arenaRoots === 0 && v.b.arenaRoots === 0),
      visits.map(v => v.a.arenaRoots).join('/'))
    check('there is still exactly one effect pool, not one per visit',
      visits.every(v => v.a.vfxRoots === 1 && v.b.vfxRoots === 1),
      visits.map(v => v.a.vfxRoots).join('/'))
    check('the scene has the same number of children after every visit',
      first.a.sceneChildren === third.a.sceneChildren && first.b.sceneChildren === third.b.sceneChildren,
      `${baseline.sceneChildren} resting -> ${visits.map(v => v.a.sceneChildren).join(' -> ')}`)
    check('no timer accumulates across visits',
      first.a.intervals === third.a.intervals && first.b.intervals === third.b.intervals,
      `A ${baseline.intervals} resting -> ${visits.map(v => v.a.intervals).join(' -> ')} · B ${visits.map(v => v.b.intervals).join(' -> ')}`)
    check('no event listener accumulates across visits',
      first.a.listeners.total === third.a.listeners.total && first.a.listeners.window === third.a.listeners.window &&
      first.a.listeners.document === third.a.listeners.document && first.a.listeners.canvas === third.a.listeners.canvas,
      `A total ${visits.map(v => v.a.listeners.total).join(' -> ')} · window ${visits.map(v => v.a.listeners.window).join(' -> ')} · canvas ${visits.map(v => v.a.listeners.canvas).join(' -> ')}`)
    /* The effect pool recycles its slots, so it reaches a ceiling and stays
     * there. What must not happen is a third visit adding as much as the first
     * did, which is what an un-recycled projectile or label would look like. */
    check('the effect and projectile pool plateaus rather than growing per visit',
      third.a.poolChildren <= Math.max(first.a.poolChildren, visits[1].a.poolChildren) &&
      third.a.poolSprites === first.a.poolSprites,
      `pool ${visits.map(v => v.a.poolChildren).join(' -> ')} · sprites ${visits.map(v => v.a.poolSprites).join(' -> ')}`)
    check('the arena gives its GPU resources back each time it is taken down',
      third.a.geometries <= first.a.geometries && third.a.textures <= first.a.textures,
      `geometries ${visits.map(v => v.a.geometries).join(' -> ')} · textures ${visits.map(v => v.a.textures).join(' -> ')}`)

    /* ---- 11. a reconnect INSIDE the grace window --------------------- */
    /*
     * Only grace EXPIRY has ever been tested — closing a browser and watching
     * the forfeit. Coming back is the half that matters more, because the
     * server has to un-reap a fighter it had already started counting out.
     *
     * The drop is a real one: CDP takes the whole page offline, so Chrome
     * closes the WebSocket and the client's own backoff is what brings it
     * back. Nothing here reaches into the socket, which is the only way to
     * exercise the path a player's tunnel dropping takes.
     */
    await standAt(pageA, PAIRS[0].at[0].x, PAIRS[0].at[0].z)
    await standAt(pageB, PAIRS[0].at[1].x, PAIRS[0].at[1].z)
    await pageA.evaluate(() => window.__wally.pvpClearError())
    const graceDuel = await openArena(pageA, pageB, idB, PAIRS[0].stake)
    check('a duel opens for the reconnect test', Boolean(await until(async () =>
      (await arenaOf(pageA)).view?.phase === 'fighting', 90_000)))
    const hpAtDrop = { a: (await mine(pageA)).hp, b: (await mine(pageB)).hp }
    const arenaAtDrop = (await arenaOf(pageA)).view.id

    const netB = await pageB.createCDPSession()
    await netB.send('Network.enable')
    await netB.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    })
    const droppedAt = Date.now()
    /*
     * Taking a page offline does not send a FIN. The established socket
     * becomes a black hole in both directions, so the drop is found by the
     * same stale sweep that finds a closed laptop — `STALE_CONNECTION_MS`, run
     * on the heartbeat timer — rather than by a close handler. That is why the
     * window opens twenty-odd seconds after the network goes, and it is why
     * the thing the reconnect has to fit inside is the WINDOW and not the
     * outage: the grace clock starts when the server notices, which is the
     * only moment either player is told anything.
     */
    const graceSeen = await until(async () => (await uiOf(pageA)).duel?.reconnectUntilMs ?? null, 60_000, 150)
    const graceOpenedAt = Date.now()
    check('the opponent still in the arena is told a reconnect window is open', Boolean(graceSeen),
      graceSeen ? `${Math.round((graceSeen - graceOpenedAt) / 1000)}s left of ${GRACE_MS / 1000}s` : 'never opened')
    note(`the server noticed the drop ${((graceOpenedAt - droppedAt) / 1000).toFixed(1)}s after the network went, through its own stale sweep`)
    const midGrace = await arenaOf(pageA)
    check('and the match is NOT settled while the window is open',
      !(await uiOf(pageA)).result && midGrace.view?.phase === 'fighting',
      `phase ${midGrace.view?.phase}`)

    /*
     * A few seconds down INSIDE the window, and not more. The client's
     * reconnect backoff doubles from 500 ms with full jitter, so a long outage
     * leaves a scheduled wait that can itself outlast the fifteen seconds —
     * which would make this a test of the backoff rather than of the recovery.
     */
    await sleep(3000)
    const stillOpen = await arenaOf(pageA)
    check('three seconds into the window it is still a window and not a forfeit',
      stillOpen.view?.phase === 'fighting' && !(await uiOf(pageA)).result,
      `phase ${stillOpen.view?.phase}`)
    await netB.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
    const rejoined = await until(async () => {
      const u = await uiOf(pageB)
      return u.connected && u.duel?.duelId === graceDuel.duelId ? u : null
    }, 30_000, 200)
    const backAfter = Date.now() - graceOpenedAt
    check('the dropped fighter reconnects inside the grace window and is still in the match',
      Boolean(rejoined) && backAfter < GRACE_MS,
      `back ${(backAfter / 1000).toFixed(1)}s into a ${GRACE_MS / 1000}s window`)
    const backInside = await arenaOf(pageB)
    check('they come back into the SAME arena instance, not a new one',
      backInside.view?.id === arenaAtDrop, `${arenaAtDrop} -> ${backInside.view?.id}`)
    const cleared = await until(async () => ((await uiOf(pageA)).duel?.reconnectUntilMs ?? null) === null, 25_000, 200)
    check('the survivor is told the window has closed again', Boolean(cleared))
    const afterA = await uiOf(pageA)
    const afterB = await uiOf(pageB)
    check('nobody was awarded a forfeit for a drop that was recovered',
      !afterA.result && !afterB.result, `${afterA.result?.kind ?? 'no result'} on the survivor's screen`)
    const stillFighting = await arenaOf(pageA)
    const hpNow = { a: (await mine(pageA)).hp, b: (await mine(pageB)).hp }
    check('the match is still being fought, with health carried through the drop',
      stillFighting.view?.phase === 'fighting' && hpNow.a <= hpAtDrop.a && hpNow.b <= hpAtDrop.b,
      `Ash ${hpAtDrop.a}->${hpNow.a} · Birch ${hpAtDrop.b}->${hpNow.b}`)
    check('the reconnected client still has its arena floor and nothing of the town',
      backInside.visibleTownObjects === OPPONENT_ONLY && backInside.stage.arenaId === arenaAtDrop,
      `${backInside.visibleTownObjects} visible scene objects, expected ${OPPONENT_ONLY}`)
    const drawnAfterReconnect = await drawnFoes(pageB)
    check('and can see their opponent again, drawn and not merely listed',
      backInside.remotes.length === 1 && backInside.remotes[0].playerId === idA &&
      drawnAfterReconnect.length === 1 && drawnAfterReconnect[0].drawn === true,
      `${backInside.remotes.length} remote(s) · ${drawnAfterReconnect.map(f => f.drawn ? 'drawn' : 'NOT DRAWN').join(',')}`)
    await pageB.screenshot({ path: `${SHOTS}/duel-reconnected.png` })

    // And it finishes normally afterwards, because a recovered drop must not
    // leave the match in a state only a timeout can end.
    const graceResult = await fightToResult([pageA, pageB], graceDuel.duelId)
    check('a match that survived a reconnect still settles normally', Boolean(graceResult),
      `${graceResult?.kind} · ${graceResult?.reason}`)
    await clickText(pageA, 'Leave arena')
    check('both are let out afterwards', Boolean(await outOfArena(pageA)) && Boolean(await outOfArena(pageB)))
    const finalPose = await pose(pageA)
    check('and Ash is back in the town where they were standing',
      Math.abs(finalPose.x) < TOWN_EDGE && Math.hypot(finalPose.x - PAIRS[0].at[0].x, finalPose.z - PAIRS[0].at[0].z) < 4,
      `${round(finalPose.x, 1)},${round(finalPose.z, 1)}`)
    await netB.detach()

    // The offline window is deliberate, so the network errors it caused are
    // not findings. Everything else is.
    const browserErrors = [pageA, pageB].flatMap(page => page.__notes ?? [])
      .filter(n => !/favicon|websocket|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|NetworkError|net::ERR/i.test(n))
    check('no browser errors along the way', browserErrors.length === 0,
      [...new Set(browserErrors)].slice(0, 5).join(' · ') || 'clean')

    console.log('\nScreenshots:')
    for (const name of ['duel-arena-floor', 'duel-countdown', 'duel-round-timer', 'duel-results-panel', 'duel-town-return', 'duel-reconnected']) {
      console.log(`      ${SHOTS}/${name}.png`)
    }
  } finally {
    /*
     * Time-boxed, because the one thing a caller reads is the exit code and a
     * socket left half-open by a browser that has already gone can keep
     * `server.close()` waiting indefinitely. The API is killed by pid either
     * way, so nothing is left holding the port.
     */
    const teardown = (async () => {
      for (const browser of browsers) await shut(browser)
      await host.close()
    })()
    const tidy = await Promise.race([teardown.then(() => true), sleep(25_000).then(() => false)])
    api.stop()
    if (!tidy) note('teardown did not finish inside 25s; the API and the browsers were killed by pid')
  }

  console.log(
    failures.length === 0
      ? '\nTwo duels ran side by side, neither one touched the other, and all four players walked home.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
