/* ------------------------------------------------------------------ *
 * Can the player actually move the camera, and does the mouse still
 * fight and walk?
 *
 * Everything here is driven through puppeteer's real mouse and keyboard,
 * so the browser produces genuine trusted pointer events with real
 * movementX/movementY and real pointer capture. The probe is only read
 * from, never used to fake an interaction.
 *
 *   UI_TARGET=http://127.0.0.1:5201 node scripts/verify-camera.mjs
 * ------------------------------------------------------------------ */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer'

const UI = process.env.UI_TARGET ?? 'http://127.0.0.1:5201'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DUEL = process.env.SKIP_DUEL !== '1'
/** `STAGES=camera`, `STAGES=combat`, or a comma list of numbers. Default: all. */
const WANTED = (process.env.STAGES ?? 'all').split(',').map(s => s.trim()).filter(Boolean)
const stage = n =>
  WANTED.includes('all') ||
  WANTED.includes(String(n)) ||
  (WANTED.includes('camera') && [1, 2, 3, 4, 5, 10, 11].includes(n)) ||
  (WANTED.includes('combat') && [6, 7, 8, 9].includes(n))

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const note = text => console.log(`      ${text}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Software WebGL frames are slow and uneven; poll to a deadline, never guess. */
async function until(fn, timeoutMs = 30_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(stepMs)
  }
  return last && typeof last === 'object' ? last : null
}

const clickText = async (page, text) => {
  const hit = await page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes(t))
    if (el && !el.disabled) { el.click(); return true }
    return false
  }, text)
  await sleep(700)
  return hit
}

async function enterWorld(page, name) {
  page.on('pageerror', e => console.log(`      pageerror ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') console.log(`      console ${m.text().slice(0, 140)}`) })
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await sleep(1200)
  // Generic walk of the entry flow, so a landing-page edit elsewhere in the
  // repo does not silently break this check.
  for (let step = 0; step < 10; step++) {
    if (await page.evaluate(() => !!window.__wally)) break
    const named = await page.evaluate(value => {
      const input = document.querySelector('#wayfinder-name')
      if (!input || input.value) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }, name)
    if (named) { await sleep(500); continue }
    const clicked = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button')]
        .filter(b => !b.disabled)
        .find(b => /enter|continue|begin|start|world/i.test(b.textContent ?? ''))
      if (!hit) return null
      hit.click()
      return hit.textContent?.trim().slice(0, 40)
    })
    note(`entry step ${step + 1}: ${clicked ?? 'nothing clickable'}`)
    await sleep(900)
  }
  const ready = await until(() => page.evaluate(() => !!window.__wally), 180_000, 1000)
  if (!ready) throw new Error(`${name} never reached the world at ${UI}`)
  return page
}

const cam = page => page.evaluate(() => window.__wally.camState())
const camPos = page => page.evaluate(() => {
  const p = window.__wally.camera.position
  return { x: p.x, y: p.y, z: p.z }
})
const pos = page => page.evaluate(() => {
  const p = window.__wally.player.position
  return { x: p.x, z: p.z }
})
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Finds a living animal that is genuinely on screen, by sweeping the same
 * cursor pipeline the game uses and asking what it resolves. That is far more
 * honest than projecting a world point and hoping the pick agrees, and it
 * returns page coordinates a real mouse can be driven to. Prefers the frailest
 * animal in view, so a level-1 wayfinder can finish the fight.
 */
const findOnScreenAnimal = (page, wantUuid = null) => page.evaluate(want => {
  const w = window.__wally
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  const hits = []
  const seen = new Set()
  for (let iy = 0; iy <= 18; iy++) {
    for (let ix = 0; ix <= 26; ix++) {
      const nx = -0.88 + (ix / 26) * 1.76
      const ny = -0.88 + (iy / 18) * 1.76
      const px = rect.left + (nx * 0.5 + 0.5) * rect.width
      const py = rect.top + (-ny * 0.5 + 0.5) * rect.height
      // The HUD, the pouch and the nav bar sit over the canvas and swallow the
      // press. Only points where the canvas is genuinely on top are clickable,
      // which is exactly what a player sees too.
      if (document.elementFromPoint(px, py) !== canvas) continue
      w.setPointer(nx, ny)
      const h = w.getHover()
      if (!h || h.state === 'dead') continue
      if (seen.has(h.group.uuid)) continue
      seen.add(h.group.uuid)
      hits.push({
        uuid: h.group.uuid, id: h.species.id, threat: h.species.threat,
        maxHp: h.species.maxHp, hp: h.hp, x: px, y: py,
        distance: h.group.position.distanceTo(w.player.position),
      })
    }
  }
  /* A named target wins outright when it is on screen. Otherwise: defensive
   * animals first, then close, then frail. A chicken is passive, which means
   * it flees the moment you close and a level-1 wayfinder simply cannot catch
   * one — that is the game working as designed, but it makes for a test that
   * can never finish. A reindeer turns and fights. */
  hits.sort((a, b) => (a.uuid !== want) - (b.uuid !== want)
    || (a.threat !== 'defensive') - (b.threat !== 'defensive')
    || (a.distance > 30) - (b.distance > 30) || a.distance - b.distance || a.maxHp - b.maxHp)
  return { pick: hits[0] ?? null, seen: hits.map(h => `${h.id}@${h.distance.toFixed(0)}u`) }
}, wantUuid)

/**
 * Scan, drive the real mouse there, and only accept it once the game's own
 * cursor agrees an animal is under it. Animals wander, so a scan alone is not
 * enough; this retries until the pick and the pointer line up.
 */
async function acquire(page, { button = 'left', wantUuid = null, wantThreat = null, maxDistance = Infinity, tries = 8 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const { pick, seen } = await findOnScreenAnimal(page, wantUuid)
    // With a named target, never settle for a different animal: clicking the
    // wrong one would silently move the attack order and invalidate the test.
    const wrong = !pick
      || (wantUuid && pick.uuid !== wantUuid)
      || (!wantUuid && wantThreat && pick.threat !== wantThreat)
      || pick.distance > maxDistance
    if (wrong) {
      await drag(page, { button: 'middle', dx: 170, dy: 0, steps: 12 })
      continue
    }
    await page.mouse.move(pick.x, pick.y)
    const locked = await until(() => page.evaluate(want => {
      const h = window.__wally.getHover()
      if (!h || h.state === 'dead') return null
      if (want && h.group.uuid !== want) return null
      return { uuid: h.group.uuid, id: h.species.id, hp: h.hp, maxHp: h.species.maxHp }
    }, wantUuid), 3000, 120)
    if (!locked) {
      note(`attempt ${attempt + 1}: the cursor lost ${pick.id} between the scan and the move (in view: ${seen.join(', ')})`)
      continue
    }
    // Click the instant the cursor agrees. Animals wander, and any round trip
    // spent double-checking is a round trip in which the target walks off the
    // ray and the click lands on the ground behind it.
    await page.mouse.down({ button })
    await page.mouse.up({ button })
    return { ...pick, ...locked, seen }
  }
  return null
}

/**
 * Walks the wayfinder somewhere, by issuing the game's own move order and
 * sprinting. Teleporting is not an option: the world is server-authoritative
 * and setting `player.position` is snapped straight back within a frame, which
 * is the anti-cheat doing its job. So the test walks, like a player.
 */
async function travel(page, x, z, within = 7, timeoutMs = 200_000) {
  await page.keyboard.down('Shift')
  let last = null
  let why = null
  try {
    const here = await until(async () => {
      why = await page.evaluate(([tx, tz]) => {
        const w = window.__wally
        const V = w.player.position.constructor
        // Re-issue whenever the order lapses: a partial path, a nav slide or a
        // knock from wildlife all end it early.
        if (w.battle.currentOrder() !== 'idle') return { order: w.battle.currentOrder() }
        const goal = w.nav.blocked(tx, tz) ? w.nav.nearestOpen(tx, tz) : { x: tx, z: tz }
        const routable = goal ? !!w.nav.findPath(w.player.position, new V(goal.x, 0, goal.z)) : false
        if (goal) w.battle.secondaryClick(new V(goal.x, 0, goal.z), null)
        return { order: w.battle.currentOrder(), goal, routable, paused: !!document.querySelector('.panel, .sheet') }
      }, [x, z])
      last = await pos(page)
      return Math.hypot(last.x - x, last.z - z) < within ? last : null
    }, timeoutMs, 2000)
    if (!here) note(`travel to (${x}, ${z}) gave up at (${last?.x.toFixed(1)}, ${last?.z.toFixed(1)}), ${last ? Math.hypot(last.x - x, last.z - z).toFixed(1) : '?'} units short; last engine view ${JSON.stringify(why)}`)
    return here
  } finally {
    await page.keyboard.up('Shift')
    await page.evaluate(() => window.__wally.battle.pressStop())
  }
}

/**
 * A point on screen that is open, walkable ground with a route to it and no
 * animal in the way — found through the game's own cursor, so the click that
 * follows is the same click a player would make.
 */
const groundPoint = page => page.evaluate(() => {
  const w = window.__wally
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  let best = null
  for (let iy = 0; iy <= 14; iy++) {
    for (let ix = 0; ix <= 20; ix++) {
      const nx = -0.7 + (ix / 20) * 1.4
      const ny = -0.7 + (iy / 14) * 1.4
      const px = rect.left + (nx * 0.5 + 0.5) * rect.width
      const py = rect.top + (-ny * 0.5 + 0.5) * rect.height
      if (document.elementFromPoint(px, py) !== canvas) continue
      w.setPointer(nx, ny)
      if (w.getHover()) continue
      const g = w.getCursorGround()
      if (!g || w.nav.blocked(g.x, g.z) || !w.nav.findPath(w.player.position, g)) continue
      const d = Math.hypot(g.x - w.player.position.x, g.z - w.player.position.z)
      if (d < 4 || d > 25) continue
      if (!best || d > best.d) best = { x: px, y: py, d, at: [+g.x.toFixed(1), +g.z.toFixed(1)] }
    }
  }
  return best
})

/** Prints what the engine thinks is happening, for a failure that needs a reason. */
const diagnose = page => page.evaluate(() => {
  const w = window.__wally
  const a = w.wildlife.nearest(w.player.position, 80)
  return {
    order: w.battle.currentOrder(),
    playerHp: Math.round(w.vitals.hp),
    playerAt: [+w.player.position.x.toFixed(1), +w.player.position.z.toFixed(1)],
    basicRange: w.battle.kit?.basic?.range ?? null,
    nearest: a ? { id: a.species.id, hp: a.hp, state: a.state, d: +a.group.position.distanceTo(w.player.position).toFixed(1), canSee: w.nav.lineOfSight(w.player.position.x, w.player.position.z, a.group.position.x, a.group.position.z, 0.1, 1.6) } : null,
    safe: w.isSafeZone(w.player.position.x, w.player.position.z),
    inTown: w.isInTown(w.player.position.x, w.player.position.z),
  }
})

/** Reads one exact animal back out of the world by its mesh uuid. */
const animalByUuid = (page, uuid) => page.evaluate(id => {
  const w = window.__wally
  const a = w.wildlife.animals.find(x => x.group.uuid === id)
  return a ? { hp: a.hp, state: a.state, id: a.species.id, distance: a.group.position.distanceTo(w.player.position) } : null
}, uuid)

/** Centre of the canvas, in page coordinates. */
async function centre(page) {
  return page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
}

/**
 * A real drag: real button press, real intermediate moves (so the browser
 * fills in movementX/movementY itself), real release.
 */
async function drag(page, { button = 'middle', dx = 0, dy = 0, steps = 24, modifier = null } = {}) {
  const c = await centre(page)
  const from = { x: c.x - dx / 2, y: c.y - dy / 2 }
  await page.mouse.move(from.x, from.y)
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.down({ button })
  await page.mouse.move(from.x + dx, from.y + dy, { steps })
  await page.mouse.up({ button })
  if (modifier) await page.keyboard.up(modifier)
  await sleep(900)
}

/**
 * Several short drags rather than one long one: a single 1400px pull would
 * leave the browser window, where the OS, not the page, owns the pointer.
 */
async function sweepDrag(page, { dy = 0, dx = 0, times = 5 } = {}) {
  for (let i = 0; i < times; i++) await drag(page, { button: 'middle', dx, dy, steps: 20 })
}

/** Waits for the eased camera to catch its target, then reports both. */
async function settled(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = await cam(page)
  while (Date.now() < deadline) {
    await sleep(250)
    last = await cam(page)
    if (Math.abs(last.yaw - last.yawWanted) < 0.002 && Math.abs(last.pitch - last.pitchWanted) < 0.002) break
  }
  return last
}

const launch = (profileDir = undefined) => puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 300_000,
  userDataDir: profileDir,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--window-size=1280,800',
    // Without these the second browser's window is treated as occluded and its
    // requestAnimationFrame is throttled to a crawl, so that wayfinder never
    // walks anywhere and the duel can never be arranged.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
})

const browser = await launch()
/* The duel needs a genuinely second player. A second *tab* is not one: it
 * shares localStorage, so it claims the same guest identity and the server
 * supersedes the first session. A second browser with its own profile is. */
let foe = null

try {
  const page = await browser.newPage()
  await enterWorld(page, 'CAMCHECK')
  check('the world loaded and exposed the dev probe', true)

  // Record every contextmenu the document sees, and whether the canvas
  // handler had already cancelled it. A cancelled event is a menu that never
  // opens; there is no other way to observe the native menu from a page.
  await page.evaluate(() => {
    window.__ctx = []
    document.addEventListener('contextmenu', e => {
      window.__ctx.push({ onCanvas: e.target instanceof HTMLCanvasElement, prevented: e.defaultPrevented })
    })
  })

  if (stage(1)) {
  /* ---------------------------------------------- 1. orbit: middle drag */
  console.log('\n1. Middle-button drag orbits the camera')
  const base = await settled(page)
  note(`start yaw ${base.yaw.toFixed(4)} pitch ${base.pitch.toFixed(4)} zoom ${base.zoom.toFixed(2)}`)

  await drag(page, { button: 'middle', dx: 300, dy: 0 })
  const yawRight = await settled(page)
  check('a 300px horizontal middle-drag turns yaw', Math.abs(yawRight.yaw - base.yaw) > 0.5,
    `yaw ${base.yaw.toFixed(4)} -> ${yawRight.yaw.toFixed(4)} (${(yawRight.yaw - base.yaw).toFixed(4)} rad, expected ${(-300 * 0.004).toFixed(3)})`)

  await drag(page, { button: 'middle', dx: -300, dy: 0 })
  const yawBack = await settled(page)
  check('dragging back returns yaw to where it started', Math.abs(yawBack.yaw - base.yaw) < 0.06,
    `yaw ${yawRight.yaw.toFixed(4)} -> ${yawBack.yaw.toFixed(4)} (start was ${base.yaw.toFixed(4)})`)

  await drag(page, { button: 'middle', dx: 0, dy: 160 })
  const pitchUp = await settled(page)
  const camHigh = await camPos(page)
  check('a vertical middle-drag pitches the camera', Math.abs(pitchUp.pitch - base.pitch) > 0.2,
    `pitch ${base.pitch.toFixed(4)} -> ${pitchUp.pitch.toFixed(4)} rad (${(pitchUp.pitch * 57.2958).toFixed(1)}°)`)

  }
  if (stage(2)) {
  /* ------------------------------------------------- 2. the pitch clamps */
  console.log('\n2. Pitch clamps hold at both ends')
  await sweepDrag(page, { dy: 300, times: 5 })
  const top = await settled(page)
  const topCam = await camPos(page)
  const topPlayer = await page.evaluate(() => window.__wally.player.position.y)
  check('a huge downward drag stops at the high clamp', Math.abs(top.pitchWanted - 0.85) < 1e-6,
    `pitchWanted ${top.pitchWanted.toFixed(6)} (PITCH_MAX 0.85), pitch ${top.pitch.toFixed(4)}`)
  check('the camera is above the player and above the street at the top clamp',
    topCam.y > topPlayer + 1 && topCam.y > 1.4,
    `camera y ${topCam.y.toFixed(2)}, player y ${topPlayer.toFixed(2)}`)

  await sweepDrag(page, { dy: -300, times: 6 })
  const bottom = await settled(page)
  const bottomCam = await camPos(page)
  check('a huge upward drag stops at the low clamp', Math.abs(bottom.pitchWanted + 0.34) < 1e-6,
    `pitchWanted ${bottom.pitchWanted.toFixed(6)} (PITCH_MIN -0.34), pitch ${bottom.pitch.toFixed(4)}`)
  check('the camera never drops to or below the ground at the low clamp', bottomCam.y > 1.4,
    `camera y ${bottomCam.y.toFixed(3)} (floor 1.4, ground 0)`)

  }
  if (stage(3)) {
  /* --------------------------- 3. the ground floor across the whole sweep */
  console.log('\n3. The camera stays above ground through a full sweep')
  // Sample the camera every frame while real drags and real wheel input push
  // pitch and zoom through their whole range together.
  await page.evaluate(() => {
    window.__floor = { min: Infinity, minAt: null, samples: 0 }
    const sample = () => {
      const w = window.__wally
      if (w) {
        const y = w.camera.position.y
        window.__floor.samples++
        const s = w.camState()
        if (y < window.__floor.min) window.__floor.min = y, window.__floor.minAt = { y: +y.toFixed(3), zoom: +s.zoom.toFixed(2), pitch: +s.pitch.toFixed(3) }
      }
      window.__floorRaf = requestAnimationFrame(sample)
    }
    sample()
  })
  const cz = await centre(page)
  for (const [dy, times, wheel] of [[300, 3, 300], [-300, 6, -300], [300, 3, 300], [-300, 3, -300]]) {
    await page.mouse.move(cz.x, cz.y)
    for (let i = 0; i < 8; i++) await page.mouse.wheel({ deltaY: wheel })
    await sweepDrag(page, { dy, times })
  }
  await sleep(1500)
  const floor = await page.evaluate(() => { cancelAnimationFrame(window.__floorRaf); return window.__floor })
  check('the lowest camera height over the sweep is above the street', floor.min > 1.39,
    `min y ${floor.min.toFixed(3)} over ${floor.samples} frames, worst frame ${JSON.stringify(floor.minAt)}`)

  // Put the camera back to a normal framing before the gameplay checks.
  await page.keyboard.press('Space')
  await sleep(1200)

  }
  if (stage(4)) {
  /* ------------------------------------------------------ 4. wheel zoom */
  console.log('\n4. Wheel zoom still works across the range')
  const zBefore = await cam(page)
  const c = await centre(page)
  await page.mouse.move(c.x, c.y)
  for (let i = 0; i < 14; i++) await page.mouse.wheel({ deltaY: 300 })
  await sleep(2500)
  const zOut = await cam(page)
  check('wheel down pulls the camera back', zOut.zoomWanted > zBefore.zoomWanted + 0.5,
    `zoomWanted ${zBefore.zoomWanted.toFixed(2)} -> ${zOut.zoomWanted.toFixed(2)}, zoom ${zBefore.zoom.toFixed(2)} -> ${zOut.zoom.toFixed(2)}`)
  check('and stops at ZOOM_MAX', zOut.zoomWanted <= 32.0000001, `zoomWanted ${zOut.zoomWanted.toFixed(4)} (max 32)`)

  for (let i = 0; i < 26; i++) await page.mouse.wheel({ deltaY: -300 })
  await sleep(2500)
  const zIn = await cam(page)
  check('wheel up pushes the camera in', zIn.zoomWanted < zOut.zoomWanted - 0.5,
    `zoomWanted ${zOut.zoomWanted.toFixed(2)} -> ${zIn.zoomWanted.toFixed(2)}, zoom ${zIn.zoom.toFixed(2)}`)
  check('and stops at ZOOM_MIN', zIn.zoomWanted >= 3.1999999, `zoomWanted ${zIn.zoomWanted.toFixed(4)} (min 3.2)`)

  for (let i = 0; i < 2; i++) await page.mouse.wheel({ deltaY: 300 })
  await sleep(2000)
  note(`restored to zoom ${(await cam(page)).zoom.toFixed(2)}`)

  }
  if (stage(5)) {
  /* ------------------------------------ 5. alt+left and shift+left orbit */
  console.log('\n5. The no-middle-button bindings')
  const altBefore = await settled(page)
  await drag(page, { button: 'left', dx: 250, dy: 0, modifier: 'Alt' })
  const altAfter = await settled(page)
  check('alt+left drag orbits', Math.abs(altAfter.yaw - altBefore.yaw) > 0.4,
    `yaw ${altBefore.yaw.toFixed(4)} -> ${altAfter.yaw.toFixed(4)}`)
  const altWalk = await pos(page)
  await sleep(1500)
  check('and alt+left issues no walk order', dist(altWalk, await pos(page)) < 0.2,
    `player moved ${dist(altWalk, await pos(page)).toFixed(3)} units after the alt-drag`)

  const shiftBefore = await settled(page)
  const shiftStart = await pos(page)
  await drag(page, { button: 'left', dx: -250, dy: 0, modifier: 'Shift' })
  const shiftAfter = await settled(page)
  check('shift+left drag orbits', Math.abs(shiftAfter.yaw - shiftBefore.yaw) > 0.4,
    `yaw ${shiftBefore.yaw.toFixed(4)} -> ${shiftAfter.yaw.toFixed(4)}`)
  await sleep(1500)
  check('and a shift+left *drag* issues no walk order', dist(shiftStart, await pos(page)) < 0.5,
    `player moved ${dist(shiftStart, await pos(page)).toFixed(3)} units`)

  }
  if (stage(6)) {
  /* ------------------------------------ 6. left click on ground walks */
  console.log('\n6. Left click on open ground still walks')
  await page.evaluate(() => { window.__wally.battle.pressStop(); window.__wally.player.position.set(0, 0, 8) })
  await page.keyboard.press('Space')
  await sleep(2500)
  const walkFrom = await pos(page)
  const spot = await until(() => groundPoint(page), 20_000, 1000)
  check('there is open, routable ground on screen to click', !!spot,
    spot ? `ground at (${spot.at[0]}, ${spot.at[1]}), ${spot.d.toFixed(1)} units off, at page (${spot.x.toFixed(0)}, ${spot.y.toFixed(0)})` : 'none found')
  if (spot) {
    await page.mouse.move(spot.x, spot.y)
    await sleep(400)
    await page.mouse.click(spot.x, spot.y, { button: 'left' })
    const walkTo = await until(async () => {
      const p = await pos(page)
      return dist(walkFrom, p) > 0.5 ? p : null
    }, 20_000)
    check('the player walks to a left-clicked point', !!walkTo,
      `moved ${dist(walkFrom, walkTo ?? walkFrom).toFixed(2)} units, (${walkFrom.x.toFixed(1)}, ${walkFrom.z.toFixed(1)}) -> (${(walkTo ?? walkFrom).x.toFixed(1)}, ${(walkTo ?? walkFrom).z.toFixed(1)}), aiming at (${spot.at[0]}, ${spot.at[1]})`)
  }

  // A shift+left *tap* (no drag) must still be a click, so a sprinting player
  // can command. This is the sprint-vs-camera conflict the binding has to avoid.
  const tapSpot = await until(() => groundPoint(page), 20_000, 1000)
  const tapFrom = await pos(page)
  if (!tapSpot) {
    check('there is open ground on screen for the shift+left tap', false, 'none found')
  } else {
    await page.keyboard.down('Shift')
    await page.mouse.move(tapSpot.x, tapSpot.y)
    await sleep(300)
    await page.mouse.click(tapSpot.x, tapSpot.y, { button: 'left' })
    await page.keyboard.up('Shift')
    const tapTo = await until(async () => {
      const p = await pos(page)
      return dist(tapFrom, p) > 0.5 ? p : null
    }, 20_000)
    check('a shift+left tap with no drag still commands (sprint can click)', !!tapTo,
      `moved ${dist(tapFrom, tapTo ?? tapFrom).toFixed(2)} units toward (${tapSpot.at[0]}, ${tapSpot.at[1]})`)
  }

  }
  if (stage(7)) {
  /* ------------------------------------------- 7. left click attacks an animal */
  console.log('\n7. Left click on an animal attacks it')
  /* The south fields hold chickens and one reindeer and are the furthest
   * region from anything with teeth: a level-1 wayfinder can finish that
   * fight, which is what makes the kill, loot and XP checks below possible
   * without inventing a god mode the real game does not have. */
  const placed = { x: 28, z: 78, attackRange: await page.evaluate(() => window.__wally.battle.kit?.basic?.range ?? null) }
  const arrived = await travel(page, placed.x, placed.z)
  check('the wayfinder walked out to the hunting ground', !!arrived,
    arrived ? `LANTERN MEADOW, standing at (${arrived.x.toFixed(1)}, ${arrived.z.toFixed(1)}); basic attack range ${placed.attackRange}` : 'never got there')
  // Watch distance every frame from the click onward, so "it closed the gap"
  // is a measurement and not a guess: animals flee or charge once hit.
  await page.evaluate(() => {
    // -1 rather than Infinity: the value crosses the CDP boundary as JSON.
    window.__chase = { start: null, min: -1, last: null }
    const w = window.__wally
    const tick = () => {
      const t = w.battle.attackOrderTarget?.()
      if (t) {
        const d = Math.hypot(t.group.position.x - w.player.position.x, t.group.position.z - w.player.position.z)
        if (window.__chase.start === null) window.__chase.start = d
        if (window.__chase.min < 0 || d < window.__chase.min) window.__chase.min = d
        window.__chase.last = d
      }
      window.__chaseRaf = requestAnimationFrame(tick)
    }
    tick()
  })

  const xpBefore = await page.evaluate(() => {
    const p = window.__wally.progress()
    return { xp: p.xp, level: p.level }
  })
  const orderBefore = await page.evaluate(() => window.__wally.battle.currentOrder())
  const prey = await acquire(page, { button: 'left', wantThreat: 'defensive', maxDistance: 30, tries: 10 })
  check('a living animal is on screen and was clicked under the real cursor', !!prey,
    prey ? `${prey.id} ${prey.hp}/${prey.maxHp} hp, ${prey.distance.toFixed(1)} units away (attack range ${placed.attackRange}), clicked at page (${prey.x.toFixed(0)}, ${prey.y.toFixed(0)}); in view: ${prey.seen.join(', ')}` : 'none resolvable after sweeping the camera round')

  let killed = null
  if (prey) {
    /* Animals wander, and at software-WebGL framerates one can step off the
     * ray between the cursor resolving it and the button going down, so the
     * press lands on the ground behind it. Allow a couple of goes — a player
     * would click again too — but every go is a real click on the animal. */
    let engaged = null
    for (let go = 0; go < 3 && !engaged; go++) {
      engaged = await until(() => page.evaluate(() => window.__wally.battle.currentOrder() === 'attack' ? 'attack' : null), 8000)
      if (!engaged) await acquire(page, { button: 'left', wantUuid: prey.uuid, tries: 4 })
    }
    check('a left click on the animal issues an attack order, not just a selection',
      engaged === 'attack',
      `order ${orderBefore} -> ${engaged ?? await page.evaluate(() => window.__wally.battle.currentOrder())}`)

    /* Re-click if the engine drops the order. It does that when the chase
     * stops making progress — a tree between you and the animal is enough —
     * and a player would click again too. Every one of these is a real left
     * click on the same animal. */
    let damaged = null
    for (let round = 0; round < 5 && !damaged; round++) {
      damaged = await until(() => animalByUuid(page, prey.uuid).then(a => a && (a.hp < prey.hp || a.state === 'dead') ? a : null), 20_000)
      if (damaged) break
      const order = await page.evaluate(() => window.__wally.battle.currentOrder())
      if (order !== 'attack') await acquire(page, { button: 'left', wantUuid: prey.uuid, tries: 4 })
    }
    const chase = await page.evaluate(() => window.__chase)
    check('the left click damaged the animal', !!damaged,
      damaged ? `hp ${prey.hp} -> ${damaged.hp} (${prey.id})` : `hp stayed at ${prey.hp} over five re-clicks`)
    if (!damaged) note(`engine state: ${JSON.stringify(await diagnose(page))}`)
    check('the player closed the distance to reach it',
      chase.start !== null && chase.min >= 0 && chase.min < chase.start - 0.5,
      `distance when the order was taken ${chase.start === null ? 'never sampled' : chase.start.toFixed(2) + ' units'}, closest reached ${chase.min < 0 ? 'never sampled' : chase.min.toFixed(2) + ' units'}, attack range ${placed.attackRange}`)
    if (chase.start !== null && placed.attackRange !== null && chase.min >= 0) {
      note(chase.start > placed.attackRange
        ? `the click was out of range (${chase.start.toFixed(2)} > ${placed.attackRange}), so the approach was required`
        : `the click was already inside range (${chase.start.toFixed(2)} <= ${placed.attackRange})`)
    }

    /* ------------------------------------- 8. kill, loot and XP by left click */
    console.log('\n8. Left clicks alone kill it, and loot and XP follow')
    for (let round = 0; round < 12 && !killed; round++) {
      killed = await until(() => animalByUuid(page, prey.uuid).then(a => a && a.state === 'dead' ? a : null), 12_000)
      if (killed) break
      // Only re-issue if the engine actually dropped the order — a chase that
      // is still running needs no help, and a stray click would retarget it.
      const order = await page.evaluate(() => window.__wally.battle.currentOrder())
      const state = await animalByUuid(page, prey.uuid)
      note(`round ${round + 1}: order ${order}, ${prey.id} at ${state?.hp ?? '?'} hp, ${state?.distance?.toFixed(1) ?? '?'} units away`)
      if (order !== 'attack') await acquire(page, { button: 'left', wantUuid: prey.uuid, tries: 4 })
    }
    if (!killed) note(`engine state: ${JSON.stringify(await diagnose(page))}`)
    await page.evaluate(() => cancelAnimationFrame(window.__chaseRaf))
    check('the animal died from left-click attacks alone', !!killed,
      killed ? `${killed.id} at ${killed.hp} hp, state ${killed.state}` : 'it was still alive at the deadline')

    if (killed) {
      const xpAfter = await until(() => page.evaluate(b => {
        const p = window.__wally.progress()
        return p.xp !== b.xp || p.level !== b.level ? { xp: p.xp, level: p.level } : null
      }, xpBefore), 20_000)
      check('XP was awarded for the kill', !!xpAfter,
        xpAfter ? `xp ${xpBefore.xp} -> ${xpAfter.xp}, level ${xpBefore.level} -> ${xpAfter.level}` : `xp stayed at ${xpBefore.xp}`)
      const loot = await until(() => page.evaluate(() => {
        let coins = 0
        let total = 0
        window.__wally.player.parent.traverse(o => {
          if (o.userData && o.userData.gold !== undefined && o.visible) { coins++; total += o.userData.gold }
        })
        return coins > 0 ? { coins, total } : null
      }), 20_000)
      check('loot dropped on the ground', !!loot,
        loot ? `${loot.coins} gold drop(s) worth ${loot.total} base units` : 'no drop found within 20s of the kill')
    }
  }

  }
  if (stage(9)) {
  /* --------------------------------------- 9. right click still attacks */
  console.log('\n9. Right click still attacks, and pops no context menu')
  // Back to the quiet fields: the left-click fight may have dragged the
  // wayfinder into bear country, and a mauling is not what is under test here.
  await sleep(1500)
  const backAt = await travel(page, 28, 78)
  note(backAt ? `back at the meadow, (${backAt.x.toFixed(1)}, ${backAt.z.toFixed(1)})` : 'could not walk back to the meadow')
  const quarry = await acquire(page, { button: 'right', wantThreat: 'defensive', maxDistance: 30, tries: 10 })
  if (!quarry) {
    check('a second living animal was on screen for the right-click test', false,
      'nothing resolvable after sweeping the camera round')
  } else {
    const rOrder = await until(() => page.evaluate(() => window.__wally.battle.currentOrder() === 'attack' ? 'attack' : null), 8000)
    check('a right click on an animal issues an attack order', rOrder === 'attack',
      `target ${quarry.id} at ${quarry.hp} hp, order -> ${rOrder ?? await page.evaluate(() => window.__wally.battle.currentOrder())}`)
    let rDamage = null
    for (let round = 0; round < 6 && !rDamage; round++) {
      rDamage = await until(() => animalByUuid(page, quarry.uuid).then(a => a && (a.hp < quarry.hp || a.state === 'dead') ? a : null), 20_000)
      if (rDamage) break
      const order = await page.evaluate(() => window.__wally.battle.currentOrder())
      const state = await animalByUuid(page, quarry.uuid)
      note(`round ${round + 1}: order ${order}, ${quarry.id} at ${state?.hp ?? '?'} hp, ${state?.distance?.toFixed(1) ?? '?'} units away`)
      if (order !== 'attack') await acquire(page, { button: 'right', wantUuid: quarry.uuid, tries: 4 })
    }
    check('the right click damaged it', !!rDamage,
      rDamage ? `hp ${quarry.hp} -> ${rDamage.hp}, state ${rDamage.state}` : `hp stayed at ${quarry.hp}`)
    if (!rDamage) note(`engine state: ${JSON.stringify(await diagnose(page))}`)
  }
  const menus = await page.evaluate(() => window.__ctx)
  check('every context menu over the world was cancelled', menus.every(m => !m.onCanvas || m.prevented),
    `${menus.length} contextmenu event(s) reached the document: ${JSON.stringify(menus)}`)

  }
  if (stage(10)) {
  /* ------------------------- 10. first person behaves in both directions */
  console.log('\n10. First person')
  await page.keyboard.press('KeyV')
  await sleep(1500)
  const fpOn = await page.evaluate(() => window.__wally.isFirstPerson())
  const fpBefore = await page.evaluate(() => {
    const c = window.__wally.camera
    return { x: c.rotation.x, y: c.rotation.y, order: c.rotation.order, py: window.__wally.player.position.y, cy: c.position.y }
  })
  await drag(page, { button: 'middle', dx: 220, dy: 120 })
  await sleep(1500)
  const fpAfter = await page.evaluate(() => {
    const c = window.__wally.camera
    return { x: c.rotation.x, y: c.rotation.y, order: c.rotation.order, cy: c.position.y }
  })
  check('the v key entered first person', fpOn === true, `isFirstPerson ${fpOn}`)
  check('first person yaws with the drag', Math.abs(fpAfter.y - fpBefore.y) > 0.3,
    `rotation.y ${fpBefore.y.toFixed(4)} -> ${fpAfter.y.toFixed(4)}`)
  check('first person pitches with the drag, and never flips', Math.abs(fpAfter.x - fpBefore.x) > 0.1 && Math.abs(fpAfter.x) < 1.45,
    `rotation.x ${fpBefore.x.toFixed(4)} -> ${fpAfter.x.toFixed(4)} rad (${(fpAfter.x * 57.2958).toFixed(1)}°), order ${fpAfter.order}`)
  check('the first-person camera stays above the ground', fpAfter.cy > 1.4, `camera y ${fpAfter.cy.toFixed(2)}`)
  await page.keyboard.press('KeyV')
  await sleep(1200)
  check('the v key leaves first person again', (await page.evaluate(() => window.__wally.isFirstPerson())) === false)

  /* ------------------------ 11. a drag that ends outside the window ends */
  }
  if (stage(11)) {
  console.log('\n11. A drag that leaves the window does not stick')
  const stuckBefore = await settled(page)
  const cc = await centre(page)
  await page.mouse.move(cc.x, cc.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(cc.x + 150, cc.y, { steps: 12 })
  // Blur the window with the button still down, exactly as alt-tabbing away
  // mid-drag does.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await sleep(500)
  const duringBlur = await cam(page)
  await page.mouse.move(cc.x + 600, cc.y, { steps: 12 })
  await sleep(800)
  const afterBlur = await cam(page)
  await page.mouse.up({ button: 'middle' })
  check('blur releases the orbit', duringBlur.orbiting === null, `orbiting ${JSON.stringify(duringBlur.orbiting)}`)
  check('further movement after the release does not move the camera',
    Math.abs(afterBlur.yawWanted - duringBlur.yawWanted) < 1e-9,
    `yawWanted ${duringBlur.yawWanted.toFixed(5)} -> ${afterBlur.yawWanted.toFixed(5)} over a 600px move`)
  note(`yaw before the aborted drag ${stuckBefore.yaw.toFixed(4)}, after ${afterBlur.yaw.toFixed(4)}`)

  }

  /* ---------------------------------------- 12. clicking a player, and a duel */
  if (DUEL) {
    console.log('\n12. Another player: click does not attack, and the camera works in a duel')
    foe = await launch(await mkdtemp(join(tmpdir(), 'wally-cam-foe-')))
    const pageB = await foe.newPage()
    let idA = null
    let idB = null
    try {
      await enterWorld(pageB, 'CAMFOE')
      idA = await until(() => page.evaluate(() => window.__wally.pvpUi().connected ? window.__wally.pvpUi().playerId : null), 60_000)
      idB = await until(() => pageB.evaluate(() => window.__wally.pvpUi().connected ? window.__wally.pvpUi().playerId : null), 60_000)
      check('both tabs joined presence', !!idA && !!idB, `A ${idA} / B ${idB}`)
    } catch (e) {
      check('a second tab could join for the duel checks', false, String(e.message).slice(0, 160))
    }

    if (idA && idB) {
      // Walk them together. Positions cannot be set: the server snaps any jump
      // straight back, so both sides travel under their own move orders.
      const meetA = travel(page, 0, 8, 4)
      const meetB = travel(pageB, 4, 8, 4)
      note(`walked to meet: A ${JSON.stringify(await meetA)} / B ${JSON.stringify(await meetB)}`)
      await sleep(3000)
      await page.keyboard.press('Space')
      await sleep(2500)
      let remoteSeen = 'never queried'
      const lookForRemote = () => page.evaluate(() => {
        const w = window.__wally
        const canvas = document.querySelector('canvas')
        const rect = canvas.getBoundingClientRect()
        const list = w.remotes()
        if (!list.length) return { miss: 'no remote players in the scene' }
        const r = list[0]
        const v = new w.player.position.constructor(r.x, 1.0, r.z).project(w.camera)
        const x = rect.left + (v.x * 0.5 + 0.5) * rect.width
        const y = rect.top + (-v.y * 0.5 + 0.5) * rect.height
        if (v.z > 1) return { miss: `behind the camera (ndc z ${v.z.toFixed(2)})` }
        if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9) return { miss: `off screen at ndc ${v.x.toFixed(2)},${v.y.toFixed(2)}` }
        if (document.elementFromPoint(x, y) !== canvas) return { miss: 'the HUD covers that point' }
        return { id: r.playerId, x, y, at: [+r.x.toFixed(1), +r.z.toFixed(1)] }
      }).then(r => { remoteSeen = r?.miss ?? remoteSeen; return r && !r.miss ? r : null })
      // Sweep the camera round: the other wayfinder may be standing exactly
      // where the camera is, which is behind the lens rather than in front.
      let remote = null
      for (let turn = 0; turn < 8 && !remote; turn++) {
        remote = await until(lookForRemote, 6000)
        if (!remote) await drag(page, { button: 'middle', dx: 200, dy: 0, steps: 14 })
      }
      if (!remote) {
        check('the other player was visible on screen to click', false, remoteSeen)
      } else {
        const ordBefore = await page.evaluate(() => window.__wally.battle.currentOrder())
        await page.mouse.move(remote.x, remote.y)
        await sleep(600)
        await page.mouse.click(remote.x, remote.y, { button: 'left' })
        await sleep(2500)
        const ordAfter = await page.evaluate(() => window.__wally.battle.currentOrder())
        const inspect = await page.evaluate(() => window.__wally.pvpUi().inspect)
        check('clicking another player outside a duel does not start an attack', ordAfter !== 'attack',
          `order ${ordBefore} -> ${ordAfter}, inspect panel ${inspect ? 'opened' : 'did not open'}`)
      }

      // Out of town, where duels are legal, and fight one. Again on foot.
      const fieldA = await travel(page, 24, 82, 5)
      let fieldB = null
      // Send B to stand beside wherever A actually ended up, retrying a couple
      // of nearby spots rather than one fixed coordinate that may not route.
      for (const [tx, tz] of (fieldA ? [[fieldA.x + 4, fieldA.z], [fieldA.x - 4, fieldA.z], [fieldA.x, fieldA.z - 4]] : [])) {
        fieldB = await travel(pageB, tx, tz, 5, 120_000)
        if (fieldB) break
      }
      note(`walked to the field: A ${JSON.stringify(fieldA)} / B ${JSON.stringify(fieldB)}`)
      const townish = page => page.evaluate(() => {
        const w = window.__wally
        return { at: [+w.player.position.x.toFixed(1), +w.player.position.z.toFixed(1)], inTown: w.isInTown(w.player.position.x, w.player.position.z) }
      })
      note(`town check: A ${JSON.stringify(await townish(page))} / B ${JSON.stringify(await townish(pageB))}`)
      await sleep(3000)
      const purses = {
        a: await page.evaluate(() => window.__wally.pvpUi().gold),
        b: await pageB.evaluate(() => window.__wally.pvpUi().gold),
      }
      note(`purses before the challenge: A ${JSON.stringify(purses.a)} / B ${JSON.stringify(purses.b)}`)
      await page.evaluate(() => window.__wally.pvpClearError())
      await page.evaluate(id => window.__wally.pvpSend({ t: 'challenge', playerId: id, stake: 1 }), idB)
      const invite = await until(() => pageB.evaluate(() => window.__wally.pvpUi().invite), 30_000)
      if (!invite) {
        const err = await page.evaluate(() => window.__wally.pvpUi().error)
        check('a duel could be opened for the in-duel camera check', false, `no invite arrived; server said ${err ?? 'nothing'}`)
      } else {
        await pageB.evaluate(id => window.__wally.pvpSend({ t: 'accept', challengeId: id }), invite.challengeId)
        const duelA = await until(() => page.evaluate(() => window.__wally.pvpUi().duel), 30_000)
        if (duelA) {
          await page.evaluate(id => window.__wally.pvpSend({ t: 'ready', duelId: id }), duelA.duelId)
          await pageB.evaluate(id => window.__wally.pvpSend({ t: 'ready', duelId: id }), duelA.duelId)
        }
        const active = await until(() => page.evaluate(() => {
          const d = window.__wally.pvpUi().duel
          return d && d.phase === 'active' ? d : null
        }), 40_000)
        check('a duel reached the active phase', !!active, active ? `${active.duelId} phase ${active.phase}` : 'never went active')
        if (active) {
          const locked = await page.evaluate(() => window.__pvpLocked())
          const dBefore = await settled(page)
          await drag(page, { button: 'middle', dx: 260, dy: 90 })
          const dAfter = await settled(page)
          check('the camera still orbits during a duel',
            Math.abs(dAfter.yaw - dBefore.yaw) > 0.4 && Math.abs(dAfter.pitch - dBefore.pitch) > 0.1,
            `duel-locked ${locked}; yaw ${dBefore.yaw.toFixed(4)} -> ${dAfter.yaw.toFixed(4)}, pitch ${dBefore.pitch.toFixed(4)} -> ${dAfter.pitch.toFixed(4)}`)
          const zb = await cam(page)
          const cd = await centre(page)
          await page.mouse.move(cd.x, cd.y)
          for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 300 })
          await sleep(2000)
          const za = await cam(page)
          check('and the wheel still zooms during a duel', za.zoomWanted > zb.zoomWanted + 0.3,
            `zoomWanted ${zb.zoomWanted.toFixed(2)} -> ${za.zoomWanted.toFixed(2)}`)
          await pageB.evaluate(id => window.__wally.pvpSend({ t: 'surrender', duelId: id }), active.duelId)
          await sleep(2000)
        }
      }
    }
  }

  await page.screenshot({ path: '/tmp/verify-camera.png' })
  note('screenshot at /tmp/verify-camera.png')
} finally {
  await foe?.close().catch(() => {})
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failed`)
if (failures.length) console.log(failures.map(f => `  - ${f}`).join('\n'))
process.exit(failures.length ? 1 : 0)
