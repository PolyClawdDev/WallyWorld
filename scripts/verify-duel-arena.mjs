/* ------------------------------------------------------------------ *
 * The instanced duel arena, with two real players in it.
 *
 * Two separate Chrome profiles, so these are two genuinely different
 * players and not one session in two windows — a single client cannot
 * show that a countdown is synchronised, that combat enables together, or
 * that a result agrees on both screens, and those are the claims.
 *
 * Everything here is measured rather than looked at: spawn marks are
 * distances, "no town is visible" is a count of scene children, the
 * countdown is compared as a server timestamp AND as the digit on each
 * screen, and the camera framing is the two fighters projected through the
 * live camera. Screenshots are taken, but nothing is asserted from one.
 *
 * Self-contained: it builds a DEV bundle if there isn't one, starts its
 * own API on its own database, and serves the two together on one origin.
 * A production bundle has no `window.__wally`, which is why the build is
 * not optional.
 *
 *   node scripts/verify-duel-arena.mjs
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
// `screenshots/` is gitignored, so it is absent in a fresh checkout and the
// run would otherwise die on its first capture, mid-duel, reporting nothing.
mkdirSync(SHOTS, { recursive: true })

const API_PORT = Number(process.env.ARENA_API_PORT ?? 8831)
const DB_DIR = 'data/arena-verify'
const DB_PATH = `${DB_DIR}/wally.db`
const LOCK = join(tmpdir(), 'wally-verify-duel-arena.pid')

/* Mirrors of the constants under test. Deliberately duplicated rather than
 * imported: if one of them moves, this run should start failing and say so,
 * not quietly follow it. */
const SPAWN_RADIUS = 12
const BOUNDARY_RADIUS = 19
const TOWN_EDGE = 96
const GRACE_MS = 15_000
const CHALLENGE_TTL_MS = 30_000

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

/*
 * A DEV bundle, because `window.__wally` is stripped from a production one
 * and every probe below goes through it. `--mode development` alone is not
 * enough — NODE_ENV is what decides.
 */
async function buildDevBundle() {
  // Built every run by default, because a claim about this source tree made
  // against a bundle from an earlier one is not a claim about anything.
  if (process.env.ARENA_REUSE_BUNDLE && existsSync('dist-dev/index.html')) return 'reused dist-dev'
  await run('npx', ['vite', 'build', '--outDir', 'dist-dev'], { NODE_ENV: 'development' })
  return 'built dist-dev'
}

/**
 * One run at a time, because two of them share more than a port.
 *
 * Two concurrent runs each killed the other's API and truncated the other's
 * log, and the result was a report with seven failures in the body and one in
 * the summary — worse than a crash, because it looks like data. The lock is a
 * pid file, checked for liveness so a killed run does not block the next one.
 */
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

/**
 * Anything still listening on the run's port, gone before it starts.
 *
 * A previous run leaving its API up is not a harmless collision: the health
 * probe below would find the zombie, pass, and then every balance in the run
 * would be read from a database the zombie has open and this one has just
 * deleted. That failed as "no account for player …", a long way from the
 * cause.
 */
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
  // A database of its own, emptied first: seeded gold and a previous run's
  // duels would otherwise make the balance arithmetic here unreadable.
  rmSync(DB_DIR, { recursive: true, force: true })
  mkdirSync(DB_DIR, { recursive: true })
  // `node --import tsx` rather than `npx tsx`, so the API is this process's own
  // child and `stop()` actually stops it. Killing npx leaves the server it
  // spawned running, holding the port for the next run.
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
  return {
    origin,
    stop: () => {
      child.kill('SIGKILL')
      killPortHolders()
    },
  }
}

async function launch(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 300_000,
    userDataDir: profileDir,
    // The real GL backend, deliberately. SwiftShader runs this world at
    // about 3fps and the world tick clamps dt, so frame rate becomes
    // movement speed — and the arena's frame cost, measured below, would be
    // a measurement of the software rasteriser instead of the arena.
    args: ['--no-sandbox', '--window-size=1280,800'],
  })
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
const hasButton = (page, text) => page.evaluate(
  t => [...document.querySelectorAll('button')].some(b => (b.textContent ?? '').includes(t)), text,
)

async function enterWorld(page, name, ui) {
  const notes = []
  page.on('pageerror', e => notes.push(`pageerror ${e.message}`))
  // A console error whose whole text is "404 (Not Found)" names nothing, so the
  // URL is taken from the response instead — a missing icon and a missing API
  // route are not the same finding.
  page.on('response', r => { if (r.status() >= 400) notes.push(`http ${r.status()} ${new URL(r.url()).pathname}`) })
  page.on('console', m => {
    if (m.type() !== 'error') return
    if (/Failed to load resource/.test(m.text())) return
    notes.push(`console ${m.text()}`)
  })
  page.__notes = notes
  await page.goto(ui, { waitUntil: 'domcontentloaded', timeout: 90_000 })
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
  await page.waitForFunction('!!window.__wally && !!window.__wally.arena', { timeout: 180_000 })
  const joined = await until(() => page.evaluate('window.__wally.pvpUi().connected === true ? window.__wally.pvpUi().playerId : null'), 90_000)
  if (!joined) throw new Error(`${name} never connected at ${ui}\n  ${notes.slice(-8).join('\n  ') || 'no browser errors'}`)
  return joined
}

const uiOf = page => page.evaluate('window.__wally.pvpUi()')
const arenaOf = page => page.evaluate('window.__wally.arena()')
const send = (page, msg) => page.evaluate(m => window.__wally.pvpSend(m), msg)
const seedGold = (playerId, amount) =>
  run(process.execPath, ['--import', 'tsx', 'scripts/seed-gold.ts', playerId, String(amount)], { WALLY_DB_PATH: DB_PATH })

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

/** Where the player is standing, and which way they are facing. */
const pose = page => page.evaluate(() => ({
  x: window.__wally.player.position.x,
  z: window.__wally.player.position.z,
  facing: window.__wally.player.rotation.y,
}))

/** Walks somewhere the server will agree to, one sub-snap hop at a time. */
async function standAt(page, x, z) {
  for (let attempt = 0; attempt < 120; attempt++) {
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

/** Measured rAF rate, which is this client's real frame rate. */
const fps = page => page.evaluate(() => new Promise(resolve => {
  let frames = 0
  const started = performance.now()
  const step = () => {
    frames++
    if (performance.now() - started < 1000) requestAnimationFrame(step)
    else resolve(Math.round((frames * 1000) / (performance.now() - started)))
  }
  requestAnimationFrame(step)
}))

async function canMove(page) {
  const start = await pose(page)
  await page.evaluate(() => {
    const p = window.__wally.player.position
    p.set(p.x + 6, p.y, p.z)
  })
  await sleep(800)
  const end = await pose(page)
  const self = await page.evaluate('window.__wally.pvp().self')
  return {
    moved: Math.hypot(end.x - start.x, end.z - start.z) > 1,
    accepted: Boolean(self) && Math.hypot(self.x - end.x, self.z - end.z) < 4,
    state: self?.state ?? null,
  }
}

/** Swing. Real duel input on the real socket, which is what a click sends. */
let seq = 1000
const swing = async (page, duelId, n = 1) => {
  for (let i = 0; i < n; i++) await send(page, { t: 'input', duelId, seq: seq++, kind: 'attack' })
}

async function openArena(pageA, pageB, idA, idB, stake) {
  await send(pageA, { t: 'challenge', playerId: idB, stake })
  const invite = await until(async () => (await uiOf(pageB)).invite, 30_000)
  if (!invite) throw new Error(`no invite: ${(await uiOf(pageA)).error ?? 'no reason given'}`)
  await send(pageB, { t: 'accept', challengeId: invite.challengeId })
  const duel = await until(async () => (await uiOf(pageA)).duel, 30_000)
  if (!duel) throw new Error(`no duel opened: ${(await uiOf(pageA)).error ?? 'no reason given'}`)
  return duel
}

async function main() {
  console.log(`Voxels · the instanced duel arena, two Chrome profiles · pid ${process.pid}\n`)
  const releaseLock = takeRunLock()
  process.on('exit', releaseLock)
  note(await buildDevBundle())
  const api = await startApi()
  const host = await serveWithApi(api.origin, 'dist-dev')
  const UI = host.origin
  note(`api ${api.origin} · game ${UI}`)

  const root = await mkdtemp(join(tmpdir(), 'wally-arena-'))
  const browserA = await launch(join(root, 'a'))
  let browserB = await launch(join(root, 'b'))

  try {
    const pageA = await browserA.newPage()
    let pageB = await browserB.newPage()
    await pageA.setViewport({ width: 1280, height: 800 })
    await pageB.setViewport({ width: 1280, height: 800 })
    const idA = await enterWorld(pageA, 'Ash', UI)
    const idB = await enterWorld(pageB, 'Birch', UI)
    check('two profiles are two different players', Boolean(idA && idB) && idA !== idB, `${idA} / ${idB}`)
    check('each browser sees the other in presence', Boolean(await until(async () => {
      const [a, b] = [await uiOf(pageA), await uiOf(pageB)]
      return a.others > 0 && b.others > 0
    }, 60_000)))

    const SEED = 400
    const openingA = (await uiOf(pageA)).gold?.available ?? 0
    const openingB = (await uiOf(pageB)).gold?.available ?? 0
    for (const id of [idA, idB]) await seedGold(id, SEED)
    const funded = await until(async () => {
      const a = (await uiOf(pageA)).gold?.available ?? 0
      const b = (await uiOf(pageB)).gold?.available ?? 0
      return a >= openingA + SEED && b >= openingB + SEED ? { a, b } : null
    }, 30_000, 400)
    check('both fighters are funded before anything is staked', Boolean(funded), `A=${funded?.a} B=${funded?.b}`)

    /* ---- 0. the invitation expires on its own ------------------------- */
    // Out of town first: a challenge from inside the gates is refused for a
    // different reason, and that would prove nothing about the timer.
    await standAt(pageA, 88, 28)
    await standAt(pageB, 88, 33)
    await send(pageA, { t: 'challenge', playerId: idB, stake: 10 })
    const doomed = await until(async () => (await uiOf(pageB)).invite, 20_000)
    check('an invitation arrives', Boolean(doomed), (await uiOf(pageA)).error ?? '')
    const expiryStart = Date.now()
    const expired = await until(async () => (await uiOf(pageB)).invite === null, CHALLENGE_TTL_MS + 20_000, 500)
    const expiredAfter = Date.now() - expiryStart
    check('an unanswered invitation expires without being answered', Boolean(expired),
      `gone after ${(expiredAfter / 1000).toFixed(1)}s, ttl ${CHALLENGE_TTL_MS / 1000}s`)
    check('and it expires on the stated timer, not some other one',
      expiredAfter > CHALLENGE_TTL_MS * 0.6 && expiredAfter < CHALLENGE_TTL_MS * 2.2, `${(expiredAfter / 1000).toFixed(1)}s`)
    check('nobody was put in an arena by an expired invitation',
      (await arenaOf(pageA)).view === null && (await arenaOf(pageB)).view === null)
    // Declining is the other answer, and it must also leave nothing behind.
    await send(pageA, { t: 'challenge', playerId: idB, stake: 10 })
    const toDecline = await until(async () => (await uiOf(pageB)).invite, 20_000)
    if (toDecline) await send(pageB, { t: 'decline', challengeId: toDecline.challengeId })
    check('a declined invitation opens no arena', Boolean(await until(async () =>
      (await uiOf(pageB)).invite === null && (await arenaOf(pageA)).view === null, 15_000)))

    /* ---- 1. the town pose that has to come back ---------------------- */
    const townA = await pose(pageA)
    const townB = await pose(pageB)
    const townObjectsA = (await arenaOf(pageA)).visibleTownObjects
    note(`town pose A ${round(townA.x, 1)},${round(townA.z, 1)} facing ${round(townA.facing, 3)} · B ${round(townB.x, 1)},${round(townB.z, 1)} facing ${round(townB.facing, 3)}`)
    check('the town is drawing something to begin with', townObjectsA > 10, `${townObjectsA} visible town objects`)

    const STAKE = 10

    /* ---- 2. the both-ready gate, with one client held down ------------ */
    /*
     * B's page is frozen in the debugger between the challenge and the accept,
     * so B cannot tell the server its floor is up. A must then sit in
     * `loading` — not counting down, and unable to hurt anybody — until B is
     * let go. Freezing one client is the only way to see the gate: unpaused,
     * both answer it within a frame and the whole phase is over in 30ms.
     *
     * B issues the challenge and A accepts, because the accept is what builds
     * the arena and it has to come from the client that is still running.
     */
    const cdpB = await pageB.createCDPSession()
    await cdpB.send('Debugger.enable')
    await send(pageB, { t: 'challenge', playerId: idA, stake: STAKE })
    const invite1 = await until(async () => (await uiOf(pageA)).invite, 30_000)
    check('B can open a challenge of their own', Boolean(invite1), (await uiOf(pageB)).error ?? '')
    await cdpB.send('Debugger.pause')
    await send(pageA, { t: 'accept', challengeId: invite1.challengeId })

    const heldStart = Date.now()
    let heldSamples = 0
    let heldPhases = new Set()
    let selfReadyWhileWaiting = false
    let hurtWhileLoading = null
    while (Date.now() - heldStart < 4000) {
      const a = await arenaOf(pageA)
      if (a.view) {
        heldSamples++
        heldPhases.add(a.view.phase)
        if (a.stage.ready && a.view.phase === 'loading') selfReadyWhileWaiting = true
      }
      const duelId = (await uiOf(pageA)).duel?.duelId
      if (duelId) {
        await swing(pageA, duelId, 2)
        const f = await theirs(pageA)
        if (f && f.hp < f.maxHp) hurtWhileLoading = `B on ${f.hp}/${f.maxHp}`
      }
      await sleep(150)
    }
    const heldOnly = [...heldPhases]
    check('a client that has not answered the gate holds the match in loading',
      heldSamples > 5 && heldOnly.length === 1 && heldOnly[0] === 'loading',
      `${heldSamples} samples over 4s, phases seen: ${heldOnly.join(',') || 'none'}`)
    check('the waiting client has its own floor up while it waits', selfReadyWhileWaiting)
    check('and cannot land a hit on the opponent who is still loading', hurtWhileLoading === null,
      hurtWhileLoading ?? 'opponent still on full health')
    await pageA.screenshot({ path: `${SHOTS}/arena-a-loading.png` })
    await cdpB.send('Debugger.resume')
    await cdpB.detach()

    // Waited for on both sides: the client that was frozen has a queue of
    // snapshots to work through before it knows it is in a match at all.
    const duel1 = await until(async () => (await uiOf(pageA)).duel, 30_000)
    const duelOnB = await until(async () => (await uiOf(pageB)).duel, 30_000)
    check('releasing the held client starts the match for both', Boolean(duel1 && duelOnB),
      `phase ${duel1?.phase}`)

    /* ---- 3. the countdown, with damage suppressed --------------------- */
    // Both fighters swing from the first frame they are able to. Nothing may
    // land until the countdown is over, and that is the assertion.
    let sawLoading = heldOnly.includes('loading')
    let sawCountdown = false
    let hurtEarly = null
    const countdownSamples = []
    const watchStart = Date.now()
    while (Date.now() - watchStart < 60_000) {
      const [a, b] = [await arenaOf(pageA), await arenaOf(pageB)]
      const phase = a.view?.phase ?? 'closed'
      if (phase === 'loading') sawLoading = true
      if (phase === 'countdown') {
        sawCountdown = true
        const digitA = await pageA.evaluate(() => document.querySelector('.pvp-count')?.textContent ?? null)
        const digitB = await pageB.evaluate(() => document.querySelector('.pvp-count')?.textContent ?? null)
        const [uA, uB] = [await uiOf(pageA), await uiOf(pageB)]
        countdownSamples.push({
          digitA, digitB,
          endsA: uA.duel?.countdownEndsAtMs ?? null,
          endsB: uB.duel?.countdownEndsAtMs ?? null,
          // Both floors are up before anybody counts. That is what the gate is
          // for, and it is the reason the countdown is not a loading screen.
          floors: a.stage.arenaId === a.view?.id && b.stage.arenaId === b.view?.id,
        })
      }
      if (phase === 'loading' || phase === 'countdown') {
        await swing(pageA, duel1.duelId, 2)
        await swing(pageB, duel1.duelId, 2)
        const [fa, fb] = [await mine(pageA), await mine(pageB)]
        if (fa && fa.hp < fa.maxHp) hurtEarly = `A on ${fa.hp}/${fa.maxHp} during ${phase}`
        if (fb && fb.hp < fb.maxHp) hurtEarly = `B on ${fb.hp}/${fb.maxHp} during ${phase}`
      }
      if (phase === 'fighting') break
      await sleep(120)
    }
    check('the client passes through a loading phase', sawLoading)
    check('and through a visible countdown', sawCountdown, `${countdownSamples.length} samples`)
    check('both floors are already built when the countdown runs',
      countdownSamples.length > 0 && countdownSamples.every(s => s.floors))
    check('no damage lands during loading or the countdown', hurtEarly === null, hurtEarly ?? 'both still on full health')

    // Samples are only evidence once both sides have something to compare. The
    // client that was held in the debugger is a few frames behind when it is
    // let go, and "one side has not been told yet" is not a disagreement.
    const bothEnds = countdownSamples.filter(s => s.endsA !== null && s.endsB !== null)
    const endsApart = bothEnds.filter(s => s.endsA !== s.endsB)
    check('both clients count from the same server deadline',
      bothEnds.length >= 5 && endsApart.length === 0,
      `${bothEnds.length} comparable samples, ${endsApart.length} disagreed · deadline ${bothEnds[0]?.endsA}`)

    /* The two screens are read one after the other, tens of milliseconds apart,
     * so a sample that straddles a tick honestly sees 3 on one and 2 on the
     * other. A gap of more than one step is the two of them counting apart. */
    const digit = text => (text === 'FIGHT' ? 0 : Number(text))
    const bothDigits = countdownSamples.filter(s => s.digitA && s.digitB)
    const stepApart = bothDigits.filter(s => Math.abs(digit(s.digitA) - digit(s.digitB)) > 1)
    check('and show the same number on screen while doing it',
      bothDigits.length >= 5 && stepApart.length === 0,
      `${bothDigits.length} comparable samples, ${bothDigits.filter(s => s.digitA !== s.digitB).length} caught mid-tick, ${stepApart.length} further apart than one step · saw ${[...new Set(countdownSamples.map(s => s.digitA))].join(' ')}`)

    /* ---- 4. combat opens together ------------------------------------ */
    const openedA = await until(async () => (await arenaOf(pageA)).view?.phase === 'fighting' ? Date.now() : null, 20_000, 60)
    const openedB = await until(async () => (await arenaOf(pageB)).view?.phase === 'fighting' ? Date.now() : null, 20_000, 60)
    check('combat enables on both clients', Boolean(openedA && openedB))
    check('and within one polling interval of each other', Math.abs(openedA - openedB) < 1500,
      `${Math.abs(openedA - openedB)}ms apart as observed over CDP`)

    /* ---- 5. where they are standing ---------------------------------- */
    const view = (await arenaOf(pageA)).view
    const fA = await mine(pageA)
    const fB = await mine(pageB)
    const poseA = await pose(pageA)
    const poseB = await pose(pageB)
    const radiusA = Math.hypot(fA.x - view.originX, fA.z - view.originZ)
    const radiusB = Math.hypot(fB.x - view.originX, fB.z - view.originZ)
    const separation = Math.hypot(fA.x - fB.x, fA.z - fB.z)
    const dot = ((fA.x - view.originX) * (fB.x - view.originX)) + ((fA.z - view.originZ) * (fB.z - view.originZ))
    note(`arena ${view.id} at ${view.originX},${view.originZ} · A r=${round(radiusA)} B r=${round(radiusB)} · apart ${round(separation)}m`)
    check('both fighters stand on a spawn mark', Math.abs(radiusA - SPAWN_RADIUS) < 1.5 && Math.abs(radiusB - SPAWN_RADIUS) < 1.5,
      `${round(radiusA)}m and ${round(radiusB)}m from the middle, marks at ${SPAWN_RADIUS}m`)
    check('the marks are opposite each other', dot < 0 && Math.abs(separation - SPAWN_RADIUS * 2) < 1.5,
      `${round(separation)}m apart, dot ${round(dot)}`)
    check('each fighter faces the middle', Math.abs(Math.hypot(
      (fA.x + Math.sin(fA.facing) * SPAWN_RADIUS) - view.originX,
      (fA.z + Math.cos(fA.facing) * SPAWN_RADIUS) - view.originZ,
    )) < 2, `A facing ${round(fA.facing, 3)}`)
    check('neither of them is in the town any more',
      Math.abs(fA.x) > TOWN_EDGE && Math.abs(fB.x) > TOWN_EDGE && Math.abs(poseA.x) > TOWN_EDGE && Math.abs(poseB.x) > TOWN_EDGE,
      `A x=${round(poseA.x, 1)} B x=${round(poseB.x, 1)} · town ends at ${TOWN_EDGE}`)
    check('each client draws its own wizard where the server says it is',
      Math.hypot(poseA.x - fA.x, poseA.z - fA.z) < 1.5 && Math.hypot(poseB.x - fB.x, poseB.z - fB.z) < 1.5,
      `A off by ${round(Math.hypot(poseA.x - fA.x, poseA.z - fA.z))}m`)

    /* ---- 6. nothing of the town, and nobody else --------------------- */
    const insideA = await arenaOf(pageA)
    const insideB = await arenaOf(pageB)
    check('no town geometry is left visible',
      insideA.visibleTownObjects === 0 && insideB.visibleTownObjects === 0,
      `A ${insideA.visibleTownObjects} B ${insideB.visibleTownObjects} (was ${townObjectsA} in town)`)
    check('the only other player in the scene is the opponent',
      insideA.remotes.length === 1 && insideA.remotes[0].playerId === idB && insideB.remotes.length === 1 && insideB.remotes[0].playerId === idA,
      `A sees ${insideA.remotes.length}, B sees ${insideB.remotes.length}`)
    check('the arena floor actually built', insideA.stage.arenaId === view.id && insideA.stage.failure === null,
      `${insideA.stage.stats?.triangles ?? '?'} triangles, ${insideA.stage.hidden} town objects hidden${insideA.stage.failure ? ` · ${insideA.stage.failure}` : ''}`)

    /* ---- 7. the camera can see both of them -------------------------- */
    const seeA = await pageA.evaluate((x, z) => window.__wally.onScreen(x, 1.2, z), fB.x, fB.z)
    const seeSelf = await pageA.evaluate((x, z) => window.__wally.onScreen(x, 1.2, z), fA.x, fA.z)
    check('the arena camera frames both fighters at the spawn marks',
      seeA.inView && seeSelf.inView,
      `self (${round(seeSelf.x)},${round(seeSelf.y)}) opponent (${round(seeA.x)},${round(seeA.y)}) in clip space`)
    note(`camera zoom ${round(insideA.camera.zoom, 1)} pitch ${round(insideA.camera.pitch, 3)}`)

    /* ---- 8. what the frame costs ------------------------------------- */
    const fpsA = await fps(pageA)
    note(`arena cost · ${insideA.cost.calls} draw calls · ${insideA.cost.triangles} triangles · ${fpsA} fps with two fighters`)
    check('the arena renders at a playable frame rate', fpsA >= 30, `${fpsA} fps`)

    await pageA.screenshot({ path: `${SHOTS}/arena-a-fighting.png` })
    await pageB.screenshot({ path: `${SHOTS}/arena-b-fighting.png` })

    /* ---- 9. the boundary holds ---------------------------------------- */
    // Ordered 200m out, which is both off the floor and out of the world. The
    // server owns containment, so the answer has to come back as a position on
    // the floor rather than as a client-side correction.
    await send(pageA, { t: 'input', duelId: duel1.duelId, seq: seq++, kind: 'move', x: view.originX + 200, z: view.originZ })
    // Long enough to cross the floor at a walk, so a fighter who stops short is
    // stopping at something rather than simply still on the way.
    await sleep(7000)
    const shoved = await mine(pageA)
    const shovedPose = await pose(pageA)
    const shovedRadius = Math.hypot(shoved.x - view.originX, shoved.z - view.originZ)
    check('an order to run off the floor is clamped to the boundary',
      shovedRadius <= BOUNDARY_RADIUS, `${round(shovedRadius)}m from the middle, boundary at ${BOUNDARY_RADIUS}m`)
    check('and they really did run into it rather than stopping short', shovedRadius > 15,
      `${round(shovedRadius)}m of a possible ${BOUNDARY_RADIUS}m`)
    check('and the client agrees with where the server put them',
      Math.hypot(shovedPose.x - shoved.x, shovedPose.z - shoved.z) < 1.5,
      `off by ${round(Math.hypot(shovedPose.x - shoved.x, shovedPose.z - shoved.z))}m`)
    check('the match is still running after being held in', (await arenaOf(pageA)).view?.phase === 'fighting')

    /* ---- 10. forfeit asks first --------------------------------------- */
    const beforeAsk = await mine(pageA)
    check('Forfeit is offered during a fight', await clickText(pageA, 'Forfeit'))
    check('and it asks before it acts', await hasButton(pageA, 'Forfeit · lose'))
    await sleep(900)
    const afterAsk = await uiOf(pageA)
    check('asking does not forfeit', Boolean(afterAsk.duel) && !afterAsk.result && afterAsk.duel.phase === 'active',
      `phase ${afterAsk.duel?.phase}, hp ${(await mine(pageA))?.hp}/${beforeAsk.maxHp}`)
    check('and it can be taken back', await clickText(pageA, 'Keep fighting'))
    check('taking it back leaves the fight running', (await arenaOf(pageA)).view?.phase === 'fighting')

    /* ---- 11. fight it out -------------------------------------------- */
    for (let i = 0; i < 60; i++) {
      await swing(pageA, duel1.duelId, 1)
      await swing(pageB, duel1.duelId, 1)
      if ((await uiOf(pageA)).result) break
      await sleep(400)
    }
    let resultA = await until(async () => (await uiOf(pageA)).result, 20_000)
    if (!resultA) {
      // A stalemate is not what is under test; end it the defined way.
      await send(pageB, { t: 'surrender', duelId: duel1.duelId })
      resultA = await until(async () => (await uiOf(pageA)).result, 30_000)
    }
    const resultB = await until(async () => (await uiOf(pageB)).result, 30_000)
    check('the match settles for both fighters', Boolean(resultA && resultB),
      resultA ? `${resultA.kind} / ${resultB?.kind} · ${resultA.reason}` : '')
    check('the two sides agree who won', resultA?.winnerId === resultB?.winnerId && resultA?.kind !== resultB?.kind,
      `winner ${resultA?.winnerId} · A sees ${resultA?.kind}, B sees ${resultB?.kind}`)
    check('the session score counts the match', resultA?.matchNumber === 1 &&
      (resultA.series.yours + resultA.series.theirs + resultA.series.draws) === 1,
      `match ${resultA?.matchNumber} · A ${resultA?.series.yours}-${resultA?.series.theirs}`)

    /* ---- 12. results are shown IN the arena -------------------------- */
    const restingA = await arenaOf(pageA)
    const restingB = await arenaOf(pageB)
    check('both fighters stay in the arena for the result',
      restingA.view?.phase === 'results' && restingB.view?.phase === 'results',
      `A ${restingA.view?.phase} B ${restingB.view?.phase}`)
    check('and the town is still not drawn behind them',
      restingA.visibleTownObjects === 0 && restingB.visibleTownObjects === 0)
    check('the result panel is on screen', await pageA.evaluate(() => Boolean(document.querySelector('.pvp-result'))))
    check('the results phase has a deadline of its own', typeof restingA.view?.resultsEndsAtMs === 'number',
      `${Math.round(((restingA.view?.resultsEndsAtMs ?? 0) - Date.now()) / 1000)}s left`)
    await pageA.screenshot({ path: `${SHOTS}/arena-a-result.png` })

    /* ---- 13. a rematch is mutual, and reuses this arena -------------- */
    const arenaId = restingA.view.id
    check('A offers a rematch', await clickText(pageA, 'Rematch'))
    await sleep(1200)
    const halfway = await arenaOf(pageA)
    check('one offer is not enough to restart', halfway.view?.phase === 'results' && halfway.view.matchNumber === 1,
      `match ${halfway.view?.matchNumber}, offers a=${halfway.view?.rematch.a} b=${halfway.view?.rematch.b}`)
    check('the offer is shown as standing', halfway.view.rematch.a !== halfway.view.rematch.b,
      `a=${halfway.view.rematch.a} b=${halfway.view.rematch.b}`)
    check('B accepts the rematch', await clickText(pageB, 'Rematch'))
    const second = await until(async () => {
      const a = await arenaOf(pageA)
      return a.view && a.view.matchNumber === 2 ? a.view : null
    }, 30_000)
    check('a mutual rematch starts a second match', Boolean(second), `match ${second?.matchNumber}`)
    check('and it is fought in the SAME arena instance', second?.id === arenaId, `${arenaId} -> ${second?.id}`)
    check('the session score carried over',
      (second?.series.aWins ?? 0) + (second?.series.bWins ?? 0) + (second?.series.draws ?? 0) === 1,
      `${second?.series.aWins}-${second?.series.bWins}-${second?.series.draws}`)
    const duel2 = (await uiOf(pageA)).duel
    check('the rematch is a new match with its own id', duel2 && duel2.duelId !== duel1.duelId,
      `${duel1.duelId} -> ${duel2?.duelId}`)
    check('nobody left the arena to do it', (await arenaOf(pageA)).visibleTownObjects === 0 &&
      Math.abs((await pose(pageA)).x) > TOWN_EDGE)

    const fighting2 = await until(async () => (await arenaOf(pageA)).view?.phase === 'fighting', 45_000)
    check('the second match reaches combat', Boolean(fighting2))
    for (let i = 0; i < 60; i++) {
      await swing(pageA, duel2.duelId, 1)
      await swing(pageB, duel2.duelId, 1)
      if ((await uiOf(pageA)).result?.duelId === duel2.duelId) break
      await sleep(400)
    }
    let second2A = await until(async () => {
      const r = (await uiOf(pageA)).result
      return r?.duelId === duel2.duelId ? r : null
    }, 20_000)
    if (!second2A) {
      await send(pageB, { t: 'surrender', duelId: duel2.duelId })
      second2A = await until(async () => {
        const r = (await uiOf(pageA)).result
        return r?.duelId === duel2.duelId ? r : null
      }, 30_000)
    }
    check('the second match settles too', Boolean(second2A), `${second2A?.kind} · ${second2A?.reason}`)
    check('and the session score is now two matches deep',
      (second2A?.series.yours + second2A?.series.theirs + second2A?.series.draws) === 2 && second2A?.matchNumber === 2,
      `match ${second2A?.matchNumber} · ${second2A?.series.yours}-${second2A?.series.theirs}-${second2A?.series.draws}`)

    /* ---- 14. one of them leaves; the other must not be trapped ------- */
    check('A can leave the arena alone', await clickText(pageA, 'Leave arena'))
    const outA = await until(async () => {
      const a = await arenaOf(pageA)
      return a.view === null || a.view.phase === 'closed' ? a : null
    }, 20_000)
    check('A is taken out of the arena', Boolean(outA), outA?.view ? outA.view.phase : 'no arena')
    const outB = await until(async () => {
      const b = await arenaOf(pageB)
      return b.view === null || b.view.phase === 'closed' ? b : null
    }, 20_000)
    check('B is released as well, not left waiting in an empty arena', Boolean(outB))
    check('the town is drawn again for both',
      (await arenaOf(pageA)).visibleTownObjects > 10 && (await arenaOf(pageB)).visibleTownObjects > 10,
      `A ${(await arenaOf(pageA)).visibleTownObjects} B ${(await arenaOf(pageB)).visibleTownObjects}`)

    /* ---- 15. back where they were standing --------------------------- */
    const backA = await pose(pageA)
    const backB = await pose(pageB)
    const driftA = Math.hypot(backA.x - townA.x, backA.z - townA.z)
    const driftB = Math.hypot(backB.x - townB.x, backB.z - townB.z)
    check('A is returned to the exact spot they left from', driftA < 1.5,
      `${round(townA.x, 1)},${round(townA.z, 1)} -> ${round(backA.x, 1)},${round(backA.z, 1)} (${round(driftA)}m)`)
    check('B is returned to the exact spot they left from', driftB < 1.5,
      `${round(townB.x, 1)},${round(townB.z, 1)} -> ${round(backB.x, 1)},${round(backB.z, 1)} (${round(driftB)}m)`)
    check('and facing the way they were facing',
      Math.abs(Math.atan2(Math.sin(backA.facing - townA.facing), Math.cos(backA.facing - townA.facing))) < 0.05,
      `${round(townA.facing, 3)} -> ${round(backA.facing, 3)}`)
    const moveA = await canMove(pageA)
    const moveB = await canMove(pageB)
    check('A can walk again', moveA.moved && moveA.accepted, `server calls them ${moveA.state}`)
    check('B can walk again', moveB.moved && moveB.accepted, `server calls them ${moveB.state}`)
    await pageA.screenshot({ path: `${SHOTS}/arena-a-back-in-town.png` })

    /* ---- 16. an opponent who vanishes -------------------------------- */
    await standAt(pageA, 88, 28)
    await standAt(pageB, 88, 33)
    await pageA.evaluate(() => window.__wally.pvpClearError())
    const duel3 = await openArena(pageA, pageB, idA, idB, STAKE)
    check('a fresh arena opens after the first one closed', Boolean(duel3) &&
      (await arenaOf(pageA)).view?.id !== arenaId, `${arenaId} -> ${(await arenaOf(pageA)).view?.id}`)
    check('the third match reaches combat', Boolean(await until(async () =>
      (await arenaOf(pageA)).view?.phase === 'fighting', 45_000)))

    const goldMidFight = (await uiOf(pageA)).gold?.available ?? 0
    await browserB.close()
    const graceOpened = Date.now()
    check('the survivor is told a reconnect window is open', Boolean(await until(async () =>
      (await uiOf(pageA)).duel?.reconnectUntilMs ? true : null, 20_000)))
    const resolved = await until(async () => (await uiOf(pageA)).result, GRACE_MS + 25_000, 400)
    const resolvedAfter = Date.now() - graceOpened
    check('the match resolves itself when the window runs out', Boolean(resolved),
      resolved ? `${resolved.kind} after ${(resolvedAfter / 1000).toFixed(1)}s (grace ${GRACE_MS / 1000}s)` : 'nothing arrived')
    check('within the grace period plus a settlement, not indefinitely',
      resolvedAfter < GRACE_MS + 15_000, `${(resolvedAfter / 1000).toFixed(1)}s`)
    check('the survivor is awarded the win rather than left standing',
      resolved?.kind === 'victory' && resolved?.winnerId === idA, resolved?.kind)
    const survivorGold = (await uiOf(pageA)).gold
    check('the pot is paid and nothing is still escrowed',
      (survivorGold?.available ?? 0) === goldMidFight + STAKE * 2 && (survivorGold?.reserved ?? -1) === 0,
      `${goldMidFight} -> ${survivorGold?.available}, reserved ${survivorGold?.reserved}`)

    // A results panel with nobody to rematch is a trap, so the sweep must
    // close the instance rather than wait out the 90 seconds.
    const survivorOut = await until(async () => {
      const a = await arenaOf(pageA)
      return a.view === null || a.view.phase === 'closed' ? a : null
    }, 40_000, 500)
    check('the survivor is let out of the arena without pressing anything', Boolean(survivorOut))
    const survivorPose = await pose(pageA)
    check('and is back in the town where they were', Math.abs(survivorPose.x) < TOWN_EDGE &&
      Math.hypot(survivorPose.x - 88, survivorPose.z - 28) < 4,
      `${round(survivorPose.x, 1)},${round(survivorPose.z, 1)}`)
    const survivorMove = await canMove(pageA)
    check('the survivor can walk away', survivorMove.moved && survivorMove.accepted, `state ${survivorMove.state}`)
    await pageA.screenshot({ path: `${SHOTS}/arena-a-opponent-vanished.png` })

    /* ---- 17. and the one who dropped is not stuck on return ---------- */
    browserB = await launch(join(root, 'b'))
    pageB = await browserB.newPage()
    await pageB.setViewport({ width: 1280, height: 800 })
    await enterWorld(pageB, 'Birch', UI)
    const returned = await arenaOf(pageB)
    check('the player who dropped comes back to the town, not a dead arena',
      returned.view === null && returned.visibleTownObjects > 10,
      returned.view ? `arena ${returned.view.phase}` : `${returned.visibleTownObjects} town objects`)
    const returnedMove = await canMove(pageB)
    check('and can move', returnedMove.moved && returnedMove.accepted, `state ${returnedMove.state}`)

    const errorsA = (pageA.__notes ?? []).filter(n => !/favicon|WebSocket is closed|websocket/i.test(n))
    check('no browser errors along the way', errorsA.length === 0,
      [...new Set(errorsA)].slice(0, 5).join(' · ') || 'clean')
  } finally {
    await browserA.close()
    try { await browserB.close() } catch { /* the run closes this one itself */ }
    await host.close()
    api.stop()
  }

  console.log(
    failures.length === 0
      ? '\nTwo players fought in an instanced arena and both walked back into the town.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
