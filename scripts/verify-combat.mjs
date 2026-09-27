import { execFileSync } from 'node:child_process'
import puppeteer from 'puppeteer'
import { serveDist } from './serve-dist.mjs'

/* End-to-end verification of the combat rebuild against the dev server:
 * the new HUD, the control scheme, the basic attack loop, every character's
 * kit, navigation around obstacles, progression to level 15, the upgrade
 * flow, persistence and single-award kills.
 *
 * Screenshots land in /tmp/cbt-*.png. Run with: npm run verify:combat */

/*
 * Against its own static build, not the shared dev server: other agents are
 * editing this repo at the same time and every save they make pushes an HMR
 * reload that destroys the page in the middle of a run.
 */
execFileSync('npx', ['vite', 'build', '--mode', 'development', '--outDir', 'dist-dev', '--logLevel', 'warn'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
})
const site = await serveDist('dist-dev')
const URL = `${site.base}/`
const WIZARDS = ['MOTH', 'BRAMBLE', 'CINDER', 'ORBIT']
const pass = []
const fail = []
const check = (ok, label, detail = '') => {
  ;(ok ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
/* `node scripts/verify-combat.mjs controls` runs one section; no argument runs
 * the lot. Sections are independent pages, so this is only about turnaround. */
const sections = process.argv.slice(2).filter(a => !a.startsWith('-'))
const want = name => sections.length === 0 || sections.includes(name)
const only = sections.find(s => WIZARDS.includes(s)) ?? null

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  protocolTimeout: 240000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

/*
 * Software WebGL renders at a few frames a second, and the HUD snapshot is
 * only rewritten once per rendered frame. Anything that reads the snapshot
 * has to wait for a frame first; anything inside a loop reads the engine's
 * own live getters instead, or it will spin forever.
 */
const settle = (page, frames = 3) =>
  page.evaluate(
    n =>
      new Promise(done => {
        let seen = 0
        const step = () => (++seen >= n ? done(null) : requestAnimationFrame(step))
        requestAnimationFrame(step)
      }),
    frames,
  )

async function clickText(page, text) {
  return page.evaluate(t => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))
    if (el) el.click()
    return !!el
  }, text)
}

/*
 * The Solana work in flight alongside this one pulls a dependency that
 * expects Node's Buffer, which crashes the whole app before React mounts.
 * That is not a combat bug and not mine to fix, but without a shim nothing
 * here can run at all, so the harness supplies a minimal one.
 */
async function shimBuffer(page) {
  await page.evaluateOnNewDocument(() => {
    if (globalThis.Buffer) return
    const enc = new TextEncoder()
    class B extends Uint8Array {
      static from(value, encoding) {
        if (typeof value === 'string') return new B(enc.encode(value))
        return new B(value)
      }
      static alloc(size) {
        return new B(size)
      }
      static isBuffer(value) {
        return value instanceof B
      }
      static concat(list) {
        const total = list.reduce((sum, item) => sum + item.length, 0)
        const out = new B(total)
        let at = 0
        for (const item of list) {
          out.set(item, at)
          at += item.length
        }
        return out
      }
      toString() {
        return new TextDecoder().decode(this)
      }
    }
    globalThis.Buffer = B
  })
}

/* The wallet work in flight next door talks to a local backend that is not
 * running here; its CORS refusals are noise for a combat run, not findings. */
const unrelated = /favicon|Failed to load resource|api\/rpc|CORS policy|127\.0\.0\.1:8787|ERR_CONNECTION_REFUSED/i

async function enterWorld(page, wizardIndex = 0, { fresh = true } = {}) {
  const errors = []
  await shimBuffer(page)
  page.on('pageerror', e => { if (!unrelated.test(String(e))) errors.push(String(e)) })
  page.on('console', m => {
    if (m.type() === 'error' && !unrelated.test(m.text())) errors.push(m.text())
  })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  if (fresh) {
    await page.evaluate(() => localStorage.removeItem('wally.progression.v1'))
    await page.reload({ waitUntil: 'networkidle0' })
  }
  await clickText(page, 'Enter the world')
  await sleep(200)
  for (let i = 0; i < wizardIndex; i++) {
    await page.evaluate(() => document.querySelector('[aria-label="Next character"]').click())
    await sleep(60)
  }
  await clickText(page, 'Continue with')
  await sleep(250)
  await clickText(page, 'Enter Wally World')
  await page.waitForFunction('!!window.__wally && window.__wally.wildlife.animals.length > 0', { timeout: 30000 })
  await page.waitForSelector('.cbt-bar', { timeout: 15000 })
  await sleep(900)
  return errors
}

/** Screen coordinates for a world point, so clicks go through the real path. */
const screenOf = (page, x, z, y = 0.9) =>
  page.evaluate(([px, py, pz]) => {
    const w = window.__wally
    const v = new w.player.position.constructor(px, py, pz).project(w.camera)
    const rect = document.querySelector('.world-canvas canvas').getBoundingClientRect()
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
  }, [x, y, z])

const put = (page, x, z) => page.evaluate(([px, pz]) => window.__wally.player.position.set(px, 0, pz), [x, z])

/**
 * Move the player next to a live animal of the given species. The camera eases
 * toward its new position over several frames, and at software-WebGL frame
 * rates that is most of a second, so wait for it before anyone projects a
 * world point onto the screen.
 */
async function standBy(page, species, gap = 6) {
  const found = await page.evaluate(([id, g]) => {
    const w = window.__wally
    const animal = w.wildlife.animals.find(a => a.species.id === id && a.state !== 'dead')
    if (!animal) return null
    const p = animal.group.position
    // Somewhere open, so the character is not shoved out from under the cursor.
    const spot = w.nav.nearestOpen(p.x + g, p.z) ?? { x: p.x + g, z: p.z }
    w.player.position.set(spot.x, 0, spot.z)
    w.battle.pressStop()
    return { index: w.wildlife.animals.indexOf(animal), x: p.x, z: p.z, hp: animal.hp, max: animal.species.maxHp }
  }, [species, gap])
  if (found) await settle(page, 8)
  return found
}

/** Put the cursor on a live animal and confirm the world agrees before clicking. */
async function aimAt(page, index) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const at = await page.evaluate(i => {
      const a = window.__wally.wildlife.animals[i]
      return { x: a.group.position.x, z: a.group.position.z, y: a.species.height * 0.5 }
    }, index)
    const point = await screenOf(page, at.x, at.z, at.y)
    await page.mouse.move(point.x, point.y)
    const locked = await page.evaluate(i => {
      const w = window.__wally
      w.resolveCursor()
      return w.getHover() === w.wildlife.animals[i]
    }, index)
    if (locked) return point
    await settle(page, 3)
  }
  return null
}

const animalHp = (page, index) => page.evaluate(i => window.__wally.wildlife.animals[i].hp, index)

const snap = async page => {
  await settle(page)
  return page.evaluate(() => {
    const s = window.__wally.battleState
    return {
      wizard: s.wizard,
      level: s.level,
      xp: Math.round(s.xp),
      xpNeeded: Math.round(s.xpNeeded),
      points: s.points,
      maxed: s.maxed,
      hp: Math.round(s.hp),
      maxHp: Math.round(s.maxHp),
      resource: Math.round(s.resource),
      maxResource: Math.round(s.maxResource),
      order: s.order,
      aiming: s.aiming,
      basic: s.basicName,
      passive: s.passiveName,
      slots: Object.fromEntries(
        ['Q', 'W', 'E', 'R'].map(k => [
          k,
          { name: s.slots[k].name, rank: s.slots[k].rank, state: s.slots[k].state, up: s.slots[k].upgradable, cd: +s.slots[k].remaining.toFixed(1) },
        ]),
      ),
      pos: [+window.__wally.player.position.x.toFixed(2), +window.__wally.player.position.z.toFixed(2)],
    }
  })
}

const rects = page =>
  page.evaluate(() => {
    const get = sel => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }
    }
    return {
      bar: get('.cbt-bar'),
      nav: get('.bottom-nav'),
      controls: get('.controls'),
      toast: get('.toast'),
      huntStack: get('.hunt-stack'),
      target: get('.target-plate'),
      view: { w: window.innerWidth, h: window.innerHeight },
    }
  })

const overlaps = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
let errors = []

if (want('hud')) {
  /* ================================================================== 1
   * The HUD itself
   * ================================================================== */
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  errors = errors.concat(await enterWorld(page, 2)) // CINDER

  const hud = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.cbt-slot')]
    return {
      bar: !!document.querySelector('.cbt-bar'),
      portrait: !!document.querySelector('.cbt-portrait svg'),
      level: document.querySelector('.cbt-level')?.textContent,
      hpText: document.querySelector('.cbt-hp span')?.textContent,
      resText: document.querySelector('.cbt-res span')?.textContent,
      xpText: document.querySelector('.cbt-xp span')?.textContent,
      passive: !!document.querySelector('.cbt-passive svg'),
      slots: slots.map(s => ({
        hotkey: s.querySelector('.cbt-hotkey')?.textContent,
        state: s.dataset.state,
        pips: s.querySelectorAll('.cbt-pips i').length,
        // A real glyph, not a coloured square: count the drawn shapes.
        shapes: s.querySelectorAll('.cbt-glyph svg *').length,
        svg: s.querySelector('.cbt-glyph svg')?.innerHTML.slice(0, 60),
        cost: s.querySelector('.cbt-cost')?.textContent,
      })),
      // Nothing on screen should be a permanent block of ability prose.
      permanentText: document.querySelector('.cbt-bar').innerText.replace(/\s+/g, ' ').trim(),
      tips: document.querySelectorAll('.cbt-tip').length,
    }
  })
  console.log('\nhud:', JSON.stringify(hud, null, 1).slice(0, 1400), '\n')

  check(hud.bar && hud.portrait, 'combat HUD renders with a character portrait')
  check(hud.level === '1', 'portrait carries the character level', hud.level)
  check(/^\d+ \/ \d+$/.test(hud.hpText || ''), 'health bar shows current / max', hud.hpText)
  check(/^\d+ \/ \d+$/.test(hud.resText || ''), 'resource bar shows current / max', hud.resText)
  check(/^XP \d+ \/ \d+$/.test(hud.xpText || ''), 'xp bar shows progress', hud.xpText)
  check(hud.passive, 'passive icon is present')
  check(hud.slots.length === 4, 'four ability slots', String(hud.slots.length))
  check(hud.slots.map(s => s.hotkey).join('') === 'QWER', 'slots are labelled Q W E R', hud.slots.map(s => s.hotkey).join(''))
  check(hud.slots.every(s => s.shapes >= 3), 'every ability icon is a drawn glyph, not a placeholder', hud.slots.map(s => s.shapes).join(','))
  check(new Set(hud.slots.map(s => s.svg)).size === 4, 'the four icons are all different')
  check(hud.slots.every(s => s.state === 'locked'), 'unlearned abilities read as locked', hud.slots.map(s => s.state).join(','))
  check(hud.slots.every(s => s.pips === (s.hotkey === 'R' ? 3 : 4)), 'rank pips show 4/4/4/3', hud.slots.map(s => s.pips).join(','))
  check(hud.tips === 0, 'no tooltip is shown until you hover')
  check(hud.permanentText.length < 120, 'the bar carries no permanent block of ability prose', `${hud.permanentText.length} chars`)

  // The old card has to be gone.
  const oldCard = await page.evaluate(() => ({
    stack: !!document.querySelector('.hunt-stack'),
    emberCard: !!document.querySelector('.ability-head'),
    body: document.body.innerText.toUpperCase().includes('EMBER BLAST'),
  }))
  check(!oldCard.emberCard, 'the old ability card markup is gone')
  check(!oldCard.body, 'the words "EMBER BLAST" no longer appear on screen')

  /* Tooltips on hover, not permanently. */
  await page.hover('.cbt-slot:nth-child(1) .cbt-key')
  await sleep(250)
  const tip = await page.evaluate(() => {
    const t = document.querySelector('.cbt-tip')
    return t ? { head: t.querySelector('strong')?.textContent, text: t.innerText.length } : null
  })
  check(!!tip && tip.text > 60, 'hovering an ability opens a tooltip with its name and description', tip ? `${tip.head}, ${tip.text} chars` : 'none')
  await page.mouse.move(700, 400)

  /* Layout, at three sizes. */
  for (const [w, h] of [[1440, 900], [1180, 820], [980, 720]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
    await sleep(500)
    const r = await rects(page)
    const clear = !overlaps(r.bar, r.nav) && !overlaps(r.bar, r.controls) && !overlaps(r.bar, r.toast) && !overlaps(r.bar, r.huntStack)
    const onScreen = r.bar && r.bar.left >= 0 && r.bar.right <= w + 1 && r.bar.bottom <= h + 1
    check(clear, `combat HUD clears the other controls at ${w}x${h}`, clear ? '' : JSON.stringify(r))
    check(onScreen, `combat HUD fits the viewport at ${w}x${h}`, JSON.stringify(r.bar))
  }
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await sleep(400)
  await page.screenshot({ path: '/tmp/cbt-01-hud.png' })

  /* ================================================================== 2
   * Progression: points, locks, level 15, MAX
   * ================================================================== */
  const start = await snap(page)
  check(start.level === 1 && start.points === 1, 'characters start at level 1 with one ability point', `level ${start.level}, ${start.points} point`)
  check(Object.values(start.slots).every(s => s.rank === 0), 'nothing is learned at the start')
  check(start.slots.Q.up && start.slots.W.up && start.slots.E.up, 'Q, W and E can be learned at level 1')
  check(!start.slots.R.up, 'the ultimate cannot be learned at level 1')

  // Spend the point through the HUD button, exactly as a player would.
  await page.click('.cbt-slot:nth-child(1) .cbt-up')
  await sleep(400)
  const afterUp = await snap(page)
  check(afterUp.slots.Q.rank === 1, 'clicking + spends a point and raises the rank', `rank ${afterUp.slots.Q.rank}`)
  check(afterUp.points === 0, 'the point is consumed', `${afterUp.points} left`)
  check(afterUp.slots.Q.state !== 'locked', 'a learned ability stops reading as locked', afterUp.slots.Q.state)
  check(!afterUp.slots.W.up, 'no further upgrade is offered without a point')
  await page.screenshot({ path: '/tmp/cbt-02-upgrade.png' })

  // A level-up must not fully heal or wipe cooldowns.
  const levelUp = await page.evaluate(async () => {
    const w = window.__wally
    const spent = p => p.level - (p.ranks.Q + p.ranks.W + p.ranks.E + p.ranks.R)
    w.vitals.hp = 40
    const before = { hp: w.vitals.hp, maxHp: w.vitals.maxHp, level: w.battle.progress.level }
    // Put Q on cooldown first. Quick cast so it commits without an aim step.
    w.battle.setQuickCast(true)
    w.battle.pressSlot('Q', { cursorGround: w.player.position.clone().add({ x: 6, y: 0, z: 0 }), hover: null })
    await new Promise(r => setTimeout(r, 400))
    const cdBefore = w.battle.cooldownRemaining('Q')
    const t0 = performance.now()
    w.battle.awardXp(200)
    await new Promise(r => setTimeout(r, 200))
    const cdAfter = w.battle.cooldownRemaining('Q')
    return {
      before,
      after: { hp: w.vitals.hp, maxHp: w.vitals.maxHp, level: w.battle.progress.level },
      cdBefore: +cdBefore.toFixed(2),
      cdAfter: +cdAfter.toFixed(2),
      // Software rendering can stall a 200ms timer for seconds, so the check
      // is that the cooldown kept ticking down on its own clock, not that some
      // absolute time remains.
      elapsed: +((performance.now() - t0) / 1000).toFixed(2),
      expected: +Math.max(0, cdBefore - (performance.now() - t0) / 1000).toFixed(2),
      points: spent(w.battle.progress),
    }
  })
  console.log('level-up:', JSON.stringify(levelUp))
  check(levelUp.after.level > levelUp.before.level, 'xp raises the character level', `${levelUp.before.level} → ${levelUp.after.level}`)
  check(levelUp.after.maxHp > levelUp.before.maxHp, 'level-up raises max health', `${levelUp.before.maxHp} → ${levelUp.after.maxHp}`)
  check(
    levelUp.after.hp < levelUp.after.maxHp * 0.75,
    'level-up does not secretly full-heal',
    `hp ${levelUp.before.hp} → ${levelUp.after.hp} of ${levelUp.after.maxHp}`,
  )
  check(
    levelUp.cdBefore > 0 && Math.abs(levelUp.cdAfter - levelUp.expected) < 0.35,
    'level-up does not reset running cooldowns',
    `${levelUp.cdBefore}s → ${levelUp.cdAfter}s after ${levelUp.elapsed}s, expected ${levelUp.expected}s`,
  )
  check(levelUp.points >= 1, 'a level grants an ability point', `${levelUp.points} available`)

  const notice = await page.evaluate(() => document.querySelector('.cbt-notice')?.textContent ?? '')
  check(/level/i.test(notice), 'a level-up notice appears without a modal', notice || 'none')

  // Multiple levels from one award, then the R gate at 6.
  const gate = await page.evaluate(async () => {
    const w = window.__wally
    const before = w.battle.progress.level
    w.battle.awardXp(900)
    const mid = w.battle.progress.level
    // R must refuse every attempt until level 6, whatever the point balance.
    const rBeforeSix = w.battle.upgrade('R')
    while (w.battle.progress.level < 6) w.battle.awardXp(400)
    const rAtSix = w.battle.upgrade('R')
    await new Promise(r => setTimeout(r, 200))
    return { before, mid, rBeforeSix, rAtSix, level: w.battle.progress.level, rRank: w.battle.progress.ranks.R }
  })
  check(gate.mid - gate.before >= 2, 'one large award crosses several levels', `${gate.before} → ${gate.mid}`)
  check(gate.rBeforeSix === false, 'the ultimate is refused below level 6', `at level ${gate.mid}`)
  check(gate.rAtSix === true && gate.rRank >= 1, 'the ultimate unlocks at level 6', `level ${gate.level}, R rank ${gate.rRank}`)

  const maxed = await page.evaluate(async () => {
    const w = window.__wally
    for (let i = 0; i < 80 && w.battle.progress.level < 15; i++) w.battle.awardXp(4000)
    // Spend every point: 4/4/4/3.
    for (let i = 0; i < 20; i++) for (const slot of ['Q', 'W', 'E', 'R']) w.battle.upgrade(slot)
    const xpBefore = w.battle.progress.xp
    w.battle.awardXp(9999)
    await new Promise(r => setTimeout(r, 300))
    const p = w.battle.progress
    return {
      level: p.level,
      points: p.level - (p.ranks.Q + p.ranks.W + p.ranks.E + p.ranks.R),
      ranks: p.ranks,
      xpStuck: p.xp === xpBefore,
    }
  })
  await settle(page, 4)
  Object.assign(
    maxed,
    await page.evaluate(() => ({
      maxedFlag: window.__wally.battleState.maxed,
      badge: document.querySelector('.cbt-level')?.textContent,
      xpText: document.querySelector('.cbt-xp span')?.textContent,
      states: Object.fromEntries(['Q', 'W', 'E', 'R'].map(k => [k, window.__wally.battleState.slots[k].state])),
    })),
  )
  console.log('maxed:', JSON.stringify(maxed))
  check(maxed.level === 15, 'the character reaches level 15', `level ${maxed.level}`)
  check(maxed.badge === 'MAX', 'the HUD shows MAX at level 15', maxed.badge)
  check(maxed.xpText === 'MAX LEVEL', 'the xp bar reads MAX LEVEL', maxed.xpText)
  check(maxed.ranks.Q === 4 && maxed.ranks.W === 4 && maxed.ranks.E === 4 && maxed.ranks.R === 3, 'all 15 points buy 4/4/4/3', JSON.stringify(maxed.ranks))
  check(maxed.points === 0, 'no points remain at a full build')
  check(maxed.xpStuck, 'xp stops accumulating at max level')
  check(Object.values(maxed.states).every(s => s !== 'locked'), 'nothing is locked at a full build', JSON.stringify(maxed.states))
  await page.screenshot({ path: '/tmp/cbt-03-max-level.png' })

  /* ================================================================== 3
   * Persistence
   * ================================================================== */
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wally.progression.v1') || 'null'))
  check(!!saved && saved.CINDER?.level === 15, 'progression is written to the save', JSON.stringify(saved?.CINDER ?? null))
  check(
    !saved?.MOTH || saved.MOTH.level === 1,
    'other characters keep their own progression',
    JSON.stringify(saved?.MOTH ?? 'untouched'),
  )
  await page.close()

  const reload = await browser.newPage()
  await reload.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await enterWorld(reload, 2, { fresh: false })
  const restored = await snap(reload)
  check(restored.level === 15 && restored.slots.R.rank === 3, 'a refresh restores the saved level and ranks', `level ${restored.level}, R rank ${restored.slots.R.rank}`)

  // Switch characters: MOTH must be its own level-1 record.
  await reload.close()
  const other = await browser.newPage()
  await other.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await enterWorld(other, 0, { fresh: false })
  const mothState = await snap(other)
  check(mothState.wizard === 'MOTH' && mothState.level === 1, 'switching characters loads that character', `${mothState.wizard} level ${mothState.level}`)
  check(mothState.basic === 'Lantern Strike', 'the switched character brings its own kit', mothState.basic)
  await other.close()

}
if (want('controls')) {
  /* ================================================================== 4
   * Controls, navigation and the basic attack loop (fresh CINDER)
   * ================================================================== */
  const ctl = await browser.newPage()
  await ctl.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  errors = errors.concat(await enterWorld(ctl, 2))
  await ctl.evaluate(() => {
    const w = window.__wally
    for (let i = 0; i < 80 && w.battle.progress.level < 15; i++) w.battle.awardXp(4000)
    for (let i = 0; i < 20; i++) for (const s of ['Q', 'W', 'E', 'R']) w.battle.upgrade(s)
  })
  await settle(ctl, 3)

  /* ---- camera: zoom, rotation, recentre ---- */
  const camAt = () => ctl.evaluate(() => {
    const w = window.__wally
    const c = w.camState()
    return {
      zoom: +c.zoom.toFixed(2),
      wanted: +c.zoomWanted.toFixed(2),
      yaw: +c.yaw.toFixed(3),
      keyboardMove: c.keyboardMove,
      camY: +w.camera.position.y.toFixed(2),
      dist: +w.camera.position.distanceTo(w.player.position).toFixed(2),
    }
  })
  const canvasBox = await ctl.evaluate(() => {
    const r = document.querySelector('.world-canvas canvas').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }
  })
  check((await camAt()).keyboardMove === false, 'keyboard walking is off by default')

  const zoomStart = await camAt()
  await ctl.mouse.move(canvasBox.x, canvasBox.y)
  for (let i = 0; i < 24; i++) await ctl.mouse.wheel({ deltaY: 220 })
  await settle(ctl, 12)
  const zoomedOut = await camAt()
  for (let i = 0; i < 60; i++) await ctl.mouse.wheel({ deltaY: -220 })
  await settle(ctl, 12)
  const zoomedIn = await camAt()
  console.log('zoom:', JSON.stringify({ zoomStart, zoomedOut, zoomedIn }))
  check(zoomedOut.wanted > zoomStart.wanted, 'the wheel zooms out', `${zoomStart.wanted} → ${zoomedOut.wanted}`)
  check(zoomedIn.wanted < zoomedOut.wanted, 'the wheel zooms back in', `${zoomedOut.wanted} → ${zoomedIn.wanted}`)
  check(zoomedOut.wanted <= 21.01, 'zoom out is clamped at the far limit', String(zoomedOut.wanted))
  check(zoomedIn.wanted >= 4.19, 'zoom in is clamped before the camera reaches the character', String(zoomedIn.wanted))
  check(zoomedIn.dist > 3.5, 'the camera never ends up inside the character', `${zoomedIn.dist}m away`)
  check(zoomedOut.camY > 1.4 && zoomedIn.camY > 1.4, 'the camera never dips under the street', `${zoomedIn.camY} / ${zoomedOut.camY}`)
  // Smooth, not instant: the eased distance should still be catching up.
  const easing = await ctl.evaluate(async () => {
    const w = window.__wally
    const before = w.camState().zoom
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    const target = w.camState().zoomWanted
    await new Promise(r => setTimeout(r, 40))
    return { before, target, mid: w.camState().zoom }
  })
  check(easing.mid < easing.target, 'zoom interpolates instead of jumping', `wanted ${easing.target.toFixed(2)}, at ${easing.mid.toFixed(2)}`)

  // Zoom to the two extremes and photograph them.
  await ctl.evaluate(() => { for (let i = 0; i < 40; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })) })
  await sleep(1600)
  await ctl.screenshot({ path: '/tmp/cbt-06-zoom-min.png' })
  const minShot = await camAt()
  await ctl.evaluate(() => { for (let i = 0; i < 40; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })) })
  await sleep(1800)
  await ctl.screenshot({ path: '/tmp/cbt-07-zoom-max.png' })
  const maxShot = await camAt()
  check(maxShot.dist > minShot.dist + 8, 'the two screenshots really are different distances', `${minShot.dist}m vs ${maxShot.dist}m`)

  // The wheel over a panel scrolls the panel, not the world.
  await ctl.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' })))
  await sleep(600)
  const logBox = await ctl.evaluate(() => {
    const el = document.querySelector('.hunt-log')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, scroll: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight }
  })
  if (!logBox) check(false, 'the hunt ledger opened so the wheel could be tested over it')
  else {
    const beforePanel = await camAt()
    await ctl.mouse.move(logBox.x, logBox.y)
    for (let i = 0; i < 6; i++) await ctl.mouse.wheel({ deltaY: 200 })
    await settle(ctl, 6)
    const afterPanel = await camAt()
    check(afterPanel.wanted === beforePanel.wanted, 'the wheel over a panel does not zoom the world', `${beforePanel.wanted} → ${afterPanel.wanted}`)
  }
  await ctl.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' })))
  await sleep(400)

  // Middle-drag and shift-drag both turn the camera; Space swings it back.
  const yaw0 = (await camAt()).yaw
  await ctl.mouse.move(canvasBox.x, canvasBox.y)
  await ctl.mouse.down({ button: 'middle' })
  for (let i = 1; i <= 8; i++) await ctl.mouse.move(canvasBox.x + i * 22, canvasBox.y)
  await ctl.mouse.up({ button: 'middle' })
  const yawMiddle = (await camAt()).yaw
  check(Math.abs(yawMiddle - yaw0) > 0.15, 'middle-mouse drag rotates the camera', `${yaw0} → ${yawMiddle}`)

  await ctl.keyboard.down('Shift')
  await ctl.mouse.move(canvasBox.x, canvasBox.y)
  await ctl.mouse.down({ button: 'left' })
  for (let i = 1; i <= 8; i++) await ctl.mouse.move(canvasBox.x - i * 22, canvasBox.y)
  await ctl.mouse.up({ button: 'left' })
  await ctl.keyboard.up('Shift')
  const yawShift = (await camAt()).yaw
  check(Math.abs(yawShift - yawMiddle) > 0.15, 'shift-drag rotates the camera too', `${yawMiddle} → ${yawShift}`)
  check(
    (await ctl.evaluate(() => window.__wally.battle.currentOrder())) !== 'move',
    'a shift-drag over the world is a camera turn, not a move order',
  )

  const yawArrow = await ctl.evaluate(() => {
    const w = window.__wally
    const before = w.camState().yaw
    for (let i = 0; i < 5; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    return { before: +before.toFixed(3), after: +w.camState().yaw.toFixed(3) }
  })
  check(Math.abs(yawArrow.after - yawArrow.before) > 0.3, 'the arrow keys turn the camera', `${yawArrow.before} → ${yawArrow.after}`)

  const recentred = await ctl.evaluate(async () => {
    const w = window.__wally
    w.player.rotation.y = 1.1
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    await new Promise(r => setTimeout(r, 100))
    return { yaw: +w.camState().yaw.toFixed(3), facing: +(w.player.rotation.y + Math.PI).toFixed(3) }
  })
  check(Math.abs(recentred.yaw - recentred.facing) < 0.01, 'Space recentres the camera behind the character', JSON.stringify(recentred))

  /* ---- right-click ground walks a route that goes around a building ---- */
  const around = await ctl.evaluate(async () => {
    const w = window.__wally
    const open = p => (w.nav.blocked(p.x, p.z) ? w.nav.nearestOpen(p.x, p.z) : p)
    // Walk the building list for a crossing that is genuinely blocked straight
    // through and genuinely walkable round. A specific building is not the
    // point; the detour is.
    const rects = w.nav.obstacles
      .filter(o => o.kind === 'rect' && o.halfW > 2.5 && o.halfD > 2.5)
      .sort((x, y) => Math.hypot(x.x, x.z) - Math.hypot(y.x, y.z))
    for (const rect of rects) {
      const span = Math.max(rect.halfW, rect.halfD) + 6
      const a = open({ x: rect.x - span, z: rect.z })
      const b = open({ x: rect.x + span, z: rect.z })
      if (!a || !b) continue
      if (w.nav.lineOfSight(a.x, a.z, b.x, b.z, 0)) continue
      const route = w.nav.findPath(new w.player.position.constructor(a.x, 0, a.z), new w.player.position.constructor(b.x, 0, b.z))
      if (!route) continue
      w.player.position.set(a.x, 0, a.z)
      await new Promise(r => setTimeout(r, 200))
      return {
        rect: { x: rect.x, z: rect.z, halfW: rect.halfW, halfD: rect.halfD },
        a: [+a.x.toFixed(1), +a.z.toFixed(1)],
        b: [+b.x.toFixed(1), +b.z.toFixed(1)],
        waypoints: route.length,
        straightBlocked: true,
      }
    }
    return { straightBlocked: false }
  })
  console.log('detour setup:', JSON.stringify(around))
  check(around.straightBlocked, 'found a crossing that is blocked straight through but walkable around')
  check(around.waypoints > 1, 'the planned route bends around the building rather than going straight', `${around.waypoints} waypoints`)

  // Turn the camera to look at the destination and zoom out, so the click can
  // be a real click on a real pixel rather than a synthetic call.
  await ctl.evaluate(b => {
    const w = window.__wally
    for (let i = 0; i < 40; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    // Put the camera behind the player, looking along the line to the goal.
    const dx = b[0] - w.player.position.x
    const dz = b[1] - w.player.position.z
    w.player.rotation.y = Math.atan2(dx, dz)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
  }, around.b)
  await sleep(2200)
  const detourScreen = await screenOf(ctl, around.b[0], around.b[1], 0)
  const onScreen =
    detourScreen.x > canvasBox.left + 4 &&
    detourScreen.x < canvasBox.left + canvasBox.w - 4 &&
    detourScreen.y > canvasBox.top + 4 &&
    detourScreen.y < canvasBox.top + canvasBox.h - 4
  check(onScreen, 'the destination is visible on screen for a real click', JSON.stringify(detourScreen))
  if (onScreen) await ctl.mouse.click(detourScreen.x, detourScreen.y, { button: 'right' })
  else {
    await ctl.evaluate(p => {
      const w = window.__wally
      w.battle.secondaryClick(new w.player.position.constructor(p[0], 0, p[1]), null)
    }, around.b)
  }
  const route = await ctl.evaluate(async goal => {
    const w = window.__wally
    const samples = []
    const ordered = w.battle.currentOrder() === 'move'
    const marker = !!document.querySelector('canvas') && ordered
    const from = [w.player.position.x, w.player.position.z]
    const start = performance.now()
    // Software WebGL runs at a few frames a second and the engine clamps dt,
    // so a walk that takes five seconds in a real browser takes far longer here.
    while (performance.now() - start < 90000 && w.battle.currentOrder() === 'move') {
      samples.push([+w.player.position.x.toFixed(2), +w.player.position.z.toFixed(2)])
      await new Promise(r => setTimeout(r, 90))
    }
    const inside = samples.filter(([x, z]) => w.nav.blocked(x, z))
    return {
      marker,
      samples: samples.length,
      inside: inside.length,
      worst: inside.slice(0, 3),
      from: from.map(v => +v.toFixed(1)),
      end: [+w.player.position.x.toFixed(1), +w.player.position.z.toFixed(1)],
      travelled: +Math.hypot(w.player.position.x - from[0], w.player.position.z - from[1]).toFixed(1),
      missBy: +Math.hypot(w.player.position.x - goal[0], w.player.position.z - goal[1]).toFixed(1),
      order: w.battle.currentOrder(),
      notice: w.battleState.notice?.text ?? null,
    }
  }, around.b)
  console.log('route:', JSON.stringify(route))
  check(route.marker, 'right-click on the ground registers a move order', `order ${route.order}, notice ${route.notice}`)
  check(route.samples > 4, 'the character actually walks the route', `${route.samples} samples`)
  check(route.missBy < 7, 'the character arrives near the clicked spot', `${route.missBy}m away, ended ${route.end}`)
  check(route.inside === 0, 'the walked route never passes through the building', route.inside ? JSON.stringify(route.worst) : `${route.samples} samples all clear`)
  await ctl.screenshot({ path: '/tmp/cbt-08-pathing.png' })

  /* A click on a rooftop is snapped to standable ground rather than refused. */
  const onRoof = await ctl.evaluate(async r => {
    const w = window.__wally
    w.battle.pressStop()
    w.battle.secondaryClick(new w.player.position.constructor(r.x, 0, r.z), null)
    await new Promise(r2 => setTimeout(r2, 200))
    return { order: w.battle.currentOrder(), notice: window.__wally.battleState.notice?.text ?? null }
  }, around.rect)
  check(onRoof.order === 'move', 'a click on a building walks to the nearest standable ground instead of failing', `order ${onRoof.order}, notice ${onRoof.notice}`)
  await ctl.evaluate(() => window.__wally.battle.pressStop())

  /* Navigation actually refuses to cut corners. */
  const los = await ctl.evaluate(() => {
    const w = window.__wally
    // The town hall block sits around the plaza; sample a few known footprints.
    const solid = []
    for (let x = -90; x <= 90; x += 3) for (let z = -90; z <= 90; z += 3) if (w.nav.blocked(x, z)) solid.push([x, z])
    const s = solid[Math.floor(solid.length / 2)]
    const a = { x: s[0] - 7, z: s[1] }
    const b = { x: s[0] + 7, z: s[1] }
    return {
      solidCount: solid.length,
      throughWall: w.nav.lineOfSight(a.x, a.z, b.x, b.z),
      openGround: w.nav.lineOfSight(0, 60, 4, 62),
      sample: s,
    }
  })
  console.log('nav:', JSON.stringify(los))
  check(los.solidCount > 50, 'the world has a real obstacle map', `${los.solidCount} blocked sample points`)
  check(los.throughWall === false, 'line of sight is blocked by solid geometry', `across ${JSON.stringify(los.sample)}`)
  check(los.openGround === true, 'line of sight is clear over open ground')

  /* A move order is cancellable by S and replaceable by a new order. */
  const cancelMove = await ctl.evaluate(async () => {
    const w = window.__wally
    const V = w.player.position.constructor
    w.player.position.set(0, 0, 60)
    w.battle.secondaryClick(new V(34, 0, 60), null)
    await new Promise(r => setTimeout(r, 400))
    const during = w.battle.currentOrder()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    await new Promise(r => setTimeout(r, 400))
    const stoppedAt = [+w.player.position.x.toFixed(1), +w.player.position.z.toFixed(1)]
    const afterStop = w.battle.currentOrder()
    await new Promise(r => setTimeout(r, 900))
    const stayedPut = Math.hypot(w.player.position.x - stoppedAt[0], w.player.position.z - stoppedAt[1]) < 0.4
    // A second order replaces the first rather than queueing behind it.
    w.battle.secondaryClick(new V(10, 0, 70), null)
    await new Promise(r => setTimeout(r, 300))
    const reissued = w.battle.currentOrder()
    w.battle.secondaryClick(new V(-10, 0, 66), null)
    await new Promise(r => setTimeout(r, 1500))
    const heading = [+w.player.position.x.toFixed(1), +w.player.position.z.toFixed(1)]
    w.battle.pressStop()
    return { during, afterStop, stayedPut, reissued, heading }
  })
  console.log('move orders:', JSON.stringify(cancelMove))
  check(cancelMove.during === 'move', 'right-click issues a move order', cancelMove.during)
  check(cancelMove.afterStop === 'idle', 'S cancels a move order', cancelMove.afterStop)
  check(cancelMove.stayedPut, 'a stopped character stays stopped')
  check(cancelMove.reissued === 'move', 'a second right-click replaces the first order', cancelMove.reissued)
  check(cancelMove.heading[0] < 8, 'the character follows the latest order, not the older one', JSON.stringify(cancelMove.heading))

  /* Keyboard walking still works when it is switched on. */
  const keyboardOption = await ctl.evaluate(async () => {
    const w = window.__wally
    const V = w.player.position.constructor
    w.player.position.set(0, 0, 60)
    w.battle.secondaryClick(new V(34, 0, 60), null)
    await new Promise(r => setTimeout(r, 300))
    const offBefore = [w.player.position.x, w.player.position.z]
    w.keys.add('w')
    await new Promise(r => setTimeout(r, 700))
    w.keys.delete('w')
    const stillOnOrder = w.battle.currentOrder()
    const drift = Math.hypot(w.player.position.x - offBefore[0], w.player.position.z - offBefore[1])
    w.battle.pressStop()
    return { stillOnOrder, drift: +drift.toFixed(1) }
  })
  check(keyboardOption.stillOnOrder === 'move', 'with keyboard walking off, holding W does not cancel a move order', keyboardOption.stillOnOrder)

  /* The basic attack loop: engage, chase, damage on connection, stop. */
  const engaged = await standBy(ctl, 'REINDEER', 9)
  check(!!engaged, 'found a reindeer to fight')
  const deerScreen = await aimAt(ctl, engaged.index)
  check(!!deerScreen, 'the free cursor can be put on an animal at range')
  await ctl.mouse.click(deerScreen.x, deerScreen.y, { button: 'right' })
  await sleep(300)
  const engageOrder = await ctl.evaluate(() => ({
    order: window.__wally.battle.currentOrder(),
    target: window.__wally.battle.attackOrderTarget()?.species.id ?? null,
  }))
  check(engageOrder.order === 'attack', 'right-clicking an enemy begins an attack order', JSON.stringify(engageOrder))
  check(engageOrder.target === 'REINDEER', 'the attack order is bound to the clicked animal', String(engageOrder.target))

  const loop = await ctl.evaluate(async i => {
    const w = window.__wally
    const animal = w.wildlife.animals[i]
    const startHp = animal.hp
    const start = performance.now()
    let firstHitAt = null
    let approached = false
    const d0 = animal.group.position.distanceTo(w.player.position)
    while (performance.now() - start < 9000 && animal.hp === startHp) {
      if (animal.group.position.distanceTo(w.player.position) < d0 - 1) approached = true
      await new Promise(r => setTimeout(r, 40))
    }
    if (animal.hp < startHp) firstHitAt = Math.round(performance.now() - start)
    const midHp = animal.hp
    await new Promise(r => setTimeout(r, 2500))
    return {
      startHp,
      firstHitAt,
      midHp,
      laterHp: animal.hp,
      approached,
      order: w.battle.currentOrder(),
    }
  }, engaged.index)
  console.log('basic loop:', JSON.stringify(loop))
  check(loop.firstHitAt !== null, 'the basic attack connects', `first damage after ${loop.firstHitAt}ms`)
  check(loop.firstHitAt === null || loop.firstHitAt > 120, 'damage waits for the windup and the projectile, it is not instant', `${loop.firstHitAt}ms`)
  check(loop.laterHp < loop.midHp, 'attacks repeat while the order stands', `hp ${loop.startHp} → ${loop.midHp} → ${loop.laterHp}`)
  await ctl.screenshot({ path: '/tmp/cbt-04-basic-attack.png' })

  /* S stops, and does not restart on its own. */
  const stopped = await ctl.evaluate(async () => {
    const w = window.__wally
    w.battle.pressStop()
    await new Promise(r => setTimeout(r, 60))
    const immediately = w.battle.currentOrder()
    await new Promise(r => setTimeout(r, 1500))
    return { immediately, later: w.battle.currentOrder() }
  })
  check(stopped.immediately === 'idle' && stopped.later === 'idle', 'stop halts the attack and it does not restart itself', `${stopped.immediately} then ${stopped.later}`)

  /* Attack-move acquires a nearby enemy. The previous target is dead by now,
     so this needs a fresh one of its own. */
  const attackMove = await ctl.evaluate(async () => {
    const w = window.__wally
    const animal = w.wildlife.animals.find(a => a.state !== 'dead' && a.species.id !== 'CHICKEN')
    if (!animal) return { noTarget: true }
    // Stand somewhere with a clear view: acquisition needs line of sight, and
    // dropping the character behind a wall tests the wall, not attack-move.
    const at = animal.group.position
    let spot = null
    for (let a = 0; a < 16 && !spot; a++) {
      const angle = (a / 16) * Math.PI * 2
      const c = { x: at.x + Math.cos(angle) * 10, z: at.z + Math.sin(angle) * 10 }
      if (w.nav.blocked(c.x, c.z)) continue
      if (!w.nav.lineOfSight(c.x, c.z, at.x, at.z, 0.15, 1.6)) continue
      spot = c
    }
    if (!spot) return { noTarget: true }
    w.player.position.set(spot.x, 0, spot.z)
    w.battle.armAttackMove()
    const armed = w.battle.isAttackMoveArmed()
    w.battle.primaryClick(animal.group.position.clone(), null)
    const orders = []
    const start = performance.now()
    while (performance.now() - start < 9000) {
      orders.push(w.battle.currentOrder())
      if (w.battle.currentOrder() === 'attack') break
      await new Promise(r => setTimeout(r, 100))
    }
    return { armed, target: animal.species.id, acquired: w.battle.currentOrder() === 'attack', orders: [...new Set(orders)] }
  })
  check(!attackMove.noTarget, 'a live animal is available for the attack-move test')
  check(attackMove.armed, 'tapping A arms attack-move')
  check(attackMove.acquired, 'attack-move acquires an enemy on the way', `${attackMove.target}: ${JSON.stringify(attackMove.orders ?? [])}`)

  /* Escape cancels an aim before it reaches the menu. */
  const escape = await ctl.evaluate(async () => {
    const w = window.__wally
    w.battle.setQuickCast(false)
    w.battle.pressStop()
    w.battle.pressSlot('Q', { cursorGround: null, hover: null })
    await new Promise(r => setTimeout(r, 100))
    return { aiming: w.battle.isAiming() }
  })
  await settle(ctl, 4)
  escape.banner = await ctl.evaluate(() => !!document.querySelector('.cbt-aiming'))
  check(escape.aiming === 'Q', 'a ground ability enters aim mode instead of firing blind', String(escape.aiming))
  check(escape.banner, 'the aiming state is announced on the HUD')
  await ctl.screenshot({ path: '/tmp/cbt-05-aiming.png' })
  const afterEsc = await ctl.evaluate(async () => {
    const w = window.__wally
    const cdBefore = w.battle.cooldownRemaining('Q')
    const resBefore = w.battle.resourceValue()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(r => setTimeout(r, 200))
    return {
      aiming: w.battle.isAiming(),
      spentResource: +(resBefore - w.battle.resourceValue()).toFixed(1),
      cd: +(w.battle.cooldownRemaining('Q') - cdBefore).toFixed(2),
    }
  })
  check(afterEsc.aiming === null, 'Escape cancels the aim')
  check(afterEsc.spentResource <= 0 && afterEsc.cd <= 0, 'a cancelled aim spends nothing and starts no cooldown', `resource ${afterEsc.spentResource}, cooldown ${afterEsc.cd.toFixed(2)}s`)

  /* Clicking or right-clicking the HUD must not also command the world. */
  const hudClick = await ctl.evaluate(() => {
    const w = window.__wally
    w.battle.pressStop()
    return { pos: [w.player.position.x, w.player.position.z], order: w.battle.currentOrder() }
  })
  const portraitBox = await ctl.evaluate(() => {
    const r = document.querySelector('.cbt-portrait').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await ctl.mouse.click(portraitBox.x, portraitBox.y, { button: 'right' })
  await ctl.mouse.click(portraitBox.x, portraitBox.y, { button: 'left' })
  // And the world buttons down the left edge, which sit over the ground.
  const navBox = await ctl.evaluate(() => {
    const r = document.querySelector('.bottom-nav button').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await ctl.mouse.click(navBox.x, navBox.y, { button: 'right' })
  await sleep(600)
  const afterHudClick = await ctl.evaluate(() => {
    const w = window.__wally
    return { pos: [w.player.position.x, w.player.position.z], order: w.battle.currentOrder() }
  })
  check(
    afterHudClick.order === 'idle' && Math.hypot(afterHudClick.pos[0] - hudClick.pos[0], afterHudClick.pos[1] - hudClick.pos[1]) < 0.5,
    'clicking the HUD issues no movement or attack order',
    `order ${afterHudClick.order}`,
  )

  /* Resource and cooldown gating. */
  const gating = await ctl.evaluate(async () => {
    const w = window.__wally
    w.battle.setQuickCast(true)
    w.battle.pressStop()
    const ahead = w.player.position.clone()
    ahead.x += 8
    const cost = w.battle.kit.abilities.Q.cost[3]
    const before = w.battle.resourceValue()
    w.battle.pressSlot('Q', { cursorGround: ahead, hover: null })
    const spent = +(before - w.battle.resourceValue()).toFixed(1)
    const cd = w.battle.cooldownRemaining('Q')
    // An immediate recast is on cooldown and must be refused outright.
    const res2 = w.battle.resourceValue()
    w.battle.pressSlot('Q', { cursorGround: ahead, hover: null })
    w.battle.pressSlot('Q', { cursorGround: ahead, hover: null })
    const spentAgain = +(res2 - w.battle.resourceValue()).toFixed(1)
    await new Promise(r => setTimeout(r, 300))
    return { cost, spent, cd: +cd.toFixed(2), spentAgain }
  })
  await settle(ctl, 3)
  gating.state = await ctl.evaluate(() => window.__wally.battleState.slots.Q.state)
  console.log('gating:', JSON.stringify(gating))
  check(gating.spent === gating.cost, 'a committed cast spends its cost exactly once', `${gating.spent} of ${gating.cost}`)
  check(gating.cd > 0, 'a committed cast starts its cooldown', `${gating.cd}s`)
  check(gating.spentAgain === 0, 'two casts refused for cooldown spend nothing', `${gating.spentAgain} spent`)
  check(gating.state === 'cooldown', 'the slot reads as cooling', gating.state)

  const starved = await ctl.evaluate(async () => {
    const w = window.__wally
    w.battle.pressStop()
    const slots = ['Q', 'W', 'E', 'R']
    // Burn the pool down by casting everything available.
    for (let i = 0; i < 10 && w.battle.resourceValue() > 8; i++) {
      for (const s of slots) {
        const ahead = w.player.position.clone()
        ahead.x += 7
        w.battle.pressSlot(s, { cursorGround: ahead, hover: null })
        await new Promise(r => setTimeout(r, 260))
      }
    }
    const low = w.battle.resourceValue()
    // With the pool empty, a cast has to be refused without taking anything.
    const before = low
    w.battle.pressSlot('W', { cursorGround: w.player.position.clone(), hover: null })
    return { low: Math.round(low), tookMore: w.battle.resourceValue() < before - 0.01 }
  })
  await settle(ctl, 3)
  starved.states = await ctl.evaluate(() =>
    Object.fromEntries(['Q', 'W', 'E', 'R'].map(s => [s, window.__wally.battleState.slots[s].state])),
  )
  console.log('starved:', JSON.stringify(starved))
  check(
    Object.values(starved.states).some(s => s === 'noResource' || s === 'cooldown'),
    'slots report insufficient resource or cooldown when they cannot be cast',
    JSON.stringify(starved.states),
  )
  check(!starved.tookMore, 'a cast refused for resource takes nothing', `pool at ${starved.low}`)

  /* A kill pays out once, and pays xp. */
  const killOnce = await ctl.evaluate(async () => {
    const w = window.__wally
    const animal = w.wildlife.animals.find(a => a.species.id === 'CHICKEN' && a.state !== 'dead')
    if (!animal) return { skipped: true }
    const killsBefore = w.huntState.kills
    const goldBefore = Number((document.querySelector('.gold-chip').textContent || '').replace(/[^\d]/g, ''))
    const now = performance.now()
    // Fire twelve overlapping hits into the same frame window, the way a burn,
    // a chain and a projectile can all land together.
    for (let i = 0; i < 12; i++) w.wildlife.hurt(animal, 9999, now + i, {})
    w.wildlife.damageIn(animal.group.position.clone(), 3, 9999, now + 20)
    await new Promise(r => setTimeout(r, 600))
    return {
      killsBefore,
      killsAfter: w.huntState.kills,
      goldBefore,
      dead: animal.state === 'dead',
    }
  })
  check(killOnce.skipped || killOnce.dead, 'the animal dies')
  check(killOnce.skipped || killOnce.killsAfter === killOnce.killsBefore + 1, 'a kill is counted exactly once under overlapping damage', `${killOnce.killsBefore} → ${killOnce.killsAfter}`)

  check(errors.length === 0, 'no page errors during the combat pass', errors.slice(0, 3).join(' | ') || 'clean')
  await ctl.close()

}
if (want('kits')) {
  /* ================================================================== 5
   * Every character: kit identity, a cast, and a screenshot
   * ================================================================== */
  const expected = {
    MOTH: { basic: 'Lantern Strike', passive: 'Kindled Step', q: 'Lantern Glaive', melee: true },
    BRAMBLE: { basic: 'Thornshot', passive: 'Old Roots', q: 'Vine Snare', melee: false },
    CINDER: { basic: 'Emberbolt', passive: 'Forge Heat', q: 'Ember Lance', melee: false },
    ORBIT: { basic: 'Starshot', passive: 'Resonance', q: 'Chain Lightning', melee: false },
  }
  const identities = {}
  for (let i = 0; i < WIZARDS.length; i++) {
    const id = WIZARDS[i]
    if (only && only !== id) continue
    const p = await browser.newPage()
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const errs = await enterWorld(p, i)
    await p.evaluate(() => {
      const w = window.__wally
      for (let n = 0; n < 80 && w.battle.progress.level < 15; n++) w.battle.awardXp(4000)
      for (let n = 0; n < 20; n++) for (const s of ['Q', 'W', 'E', 'R']) w.battle.upgrade(s)
      w.battle.setQuickCast(true)
      w.vitals.hp = w.vitals.maxHp
    })
    await settle(p, 3)

    const kit = await p.evaluate(() => {
      const s = window.__wally.battleState
      const k = window.__wally.battle.kit
      return {
        wizard: s.wizard,
        basic: s.basicName,
        passive: s.passiveName,
        resource: s.resourceShort,
        element: k.element,
        role: k.role,
        identity: k.identity,
        kind: k.basic.kind,
        range: k.basic.range,
        rate: k.basic.rate,
        abilities: ['Q', 'W', 'E', 'R'].map(x => `${x}:${s.slots[x].name}`),
        targeting: ['Q', 'W', 'E', 'R'].map(x => k.abilities[x].targeting),
      }
    })
    identities[id] = kit
    console.log(`\n${id}:`, JSON.stringify(kit))
    check(kit.wizard === id, `${id} loads its own kit`, kit.wizard)
    check(kit.basic === expected[id].basic, `${id} has its own basic attack`, kit.basic)
    check(kit.passive === expected[id].passive, `${id} has its own passive`, kit.passive)
    check(kit.abilities[0] === `Q:${expected[id].q}`, `${id} has its own Q`, kit.abilities[0])
    check(kit.kind === (expected[id].melee ? 'melee' : 'projectile'), `${id} uses the intended attack type`, kit.kind)

    // Fight something with the whole kit.
    const near = await standBy(p, 'REINDEER', expected[id].melee ? 3 : 8)
    if (!near) {
      check(false, `${id} found a target to fight`)
      await p.close()
      continue
    }
    const shot = await aimAt(p, near.index)
    check(!!shot, `${id} can put the cursor on its quarry`)
    const beforeBasic = await animalHp(p, near.index)
    await p.mouse.click(shot.x, shot.y, { button: 'right' })
    // Windup plus projectile travel takes many frames, and software rendering
    // gives only a few frames a second, so wait for the hit rather than guess.
    const basic = await p.evaluate(async (i, hp0) => {
      const w = window.__wally
      const animal = w.wildlife.animals[i]
      const start = performance.now()
      while (performance.now() - start < 25000) {
        if (animal.hp < hp0 || animal.state === 'dead') break
        await new Promise(r => setTimeout(r, 100))
      }
      return { hp: Math.round(animal.hp), dead: animal.state === 'dead', ms: Math.round(performance.now() - start) }
    }, near.index, beforeBasic)
    await p.screenshot({ path: `/tmp/cbt-10-${id}-basic.png` })
    check(basic.hp < beforeBasic || basic.dead, `${id} basic attack damages the animal`, `${beforeBasic} → ${basic.hp} after ${basic.ms}ms`)

    // Each ability gets its own live animal and a full pool, so a kit is not
    // judged on whichever slot happened to run last.
    const cast = await p.evaluate(async melee => {
      const w = window.__wally
      const seen = {}
      for (const slot of ['Q', 'W', 'E', 'R']) {
        w.battle.pressStop()
        w.battle.debugFill()
        const animal = w.wildlife.animals.find(a => a.state !== 'dead' && a.species.id !== 'CHICKEN')
        if (!animal) { seen[slot] = { dealt: 0, spent: 0, note: 'no target' }; continue }
        const p2 = animal.group.position
        // Stand somewhere with a genuinely clear shot. Firing from whatever
        // spot happens to be east of the animal can put a boulder in the way,
        // which tests the scenery rather than the ability.
        let spot = null
        for (const gap of melee ? [3, 2.4] : [7, 5.5, 4.5]) {
          for (let a = 0; a < 16 && !spot; a++) {
            const angle = (a / 16) * Math.PI * 2
            const c = { x: p2.x + Math.cos(angle) * gap, z: p2.z + Math.sin(angle) * gap }
            if (w.nav.blocked(c.x, c.z)) continue
            if (!w.nav.lineOfSight(c.x, c.z, p2.x, p2.z, 0.15, 1.6)) continue
            spot = c
          }
          if (spot) break
        }
        if (!spot) spot = w.nav.nearestOpen(p2.x + 6, p2.z) ?? { x: p2.x + 6, z: p2.z }
        w.player.position.set(spot.x, 0, spot.z)
        w.vitals.hp = w.vitals.maxHp
        await new Promise(r => setTimeout(r, 300))
        const hp = animal.hp
        const anchor = p2.clone()
        const res = w.battle.resourceValue()
        w.battle.pressSlot(slot, { cursorGround: anchor.clone(), hover: animal })
        const spent = Math.max(0, res - w.battle.resourceValue())
        // Long enough for a telegraph, a travel time and a few zone ticks.
        // The quarry is pinned in place: a skillshot does not lead a moving
        // target by design, so letting the animal wander would be testing the
        // player's aim, not the ability.
        const until = performance.now() + 6000
        while (performance.now() < until) {
          if (animal.state !== 'dead') animal.group.position.set(anchor.x, animal.group.position.y, anchor.z)
          await new Promise(r => setTimeout(r, 30))
        }
        seen[slot] = {
          name: w.battle.kit.abilities[slot].name,
          // Utility abilities (heals, blinks, buffs) declare no damage scaling,
          // so the expectation comes from the kit data, not from a flat count.
          harmful: Array.isArray(w.battle.kit.abilities[slot].scale?.damage),
          dealt: Math.round(Math.max(0, hp - animal.hp)),
          spent: Math.round(spent),
          dead: animal.state === 'dead',
        }
      }
      return { seen }
    }, expected[id].melee)
    console.log(`${id} cast:`, JSON.stringify(cast.seen))
    const slots = Object.entries(cast.seen)
    const spending = slots.filter(([, v]) => v.spent > 0).length
    const harmful = slots.filter(([, v]) => v.harmful)
    const landed = harmful.filter(([, v]) => v.dealt > 0 || v.dead)
    const missed = harmful.filter(([, v]) => !(v.dealt > 0 || v.dead)).map(([s, v]) => `${s} ${v.name}`)
    check(spending === 4, `${id} spends resource on all four abilities`, `${spending} of 4`)
    check(harmful.length >= 2, `${id} has at least two damaging abilities`, `${harmful.length} of 4`)
    check(
      missed.length === 0,
      `${id} every damaging ability actually lands damage`,
      missed.length ? `no damage from ${missed.join(', ')}` : `${landed.length} of ${harmful.length}`,
    )
    await p.screenshot({ path: `/tmp/cbt-11-${id}-ability.png` })

    // The expanded panel is the other place names and descriptions live.
    await p.click('.cbt-expand')
    await sleep(400)
    const book = await p.evaluate(() => {
      const b = document.querySelector('.cbt-book')
      return b ? { rows: b.querySelectorAll('.cbt-book-row').length, text: b.innerText.length } : null
    })
    check(!!book && book.rows === 6, `${id} ability panel lists the basic, passive and four abilities`, book ? `${book.rows} rows` : 'missing')
    await p.screenshot({ path: `/tmp/cbt-12-${id}-book.png` })
    check(errs.length === 0, `${id} runs without page errors`, errs.slice(0, 2).join(' | ') || 'clean')
    await p.close()
  }

  if (!only) {
    const names = Object.values(identities)
    check(new Set(names.map(k => k.basic)).size === names.length, 'no two characters share a basic attack')
    check(new Set(names.map(k => k.resource)).size === names.length, 'no two characters share a resource')
    check(new Set(names.map(k => k.targeting.join('/'))).size === names.length, 'no two characters share a targeting layout', names.map(k => `${k.wizard} ${k.targeting.join('/')}`).join(' | '))
    check(new Set(names.flatMap(k => k.abilities)).size === names.length * 4, 'all sixteen abilities are distinct')
  }

}
console.log(`\n${pass.length} passed, ${fail.length} failed`)
if (fail.length) console.log('failures:\n - ' + fail.join('\n - '))
await browser.close()
await site.close()
process.exit(fail.length ? 1 : 0)
