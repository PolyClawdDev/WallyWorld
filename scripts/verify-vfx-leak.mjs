/**
 * Does a cast visual ever go away?
 *
 * Counts the live children of the `combat-vfx` group across repeated casts and
 * across a death, so a leaked effect shows up as a number that never comes back
 * down rather than as something that looks wrong in a screenshot.
 */
import puppeteer from 'puppeteer'

const TARGET = process.env.TARGET ?? 'http://127.0.0.1:5201'
const SHOTS = process.env.SHOTS ?? '/tmp/vfx'
const wait = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
page.on('pageerror', e => console.log('  page error:', e.message))

// The dev server keeps an HMR socket open, so `networkidle` never fires.
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })

/* ------------------------------------------------------------ entry flow */
await wait(2500)
for (let step = 0; step < 8; step++) {
  if (await page.evaluate(() => !!window.__wally)) break
  const what = await page.evaluate(() => {
    const input = document.querySelector('#wayfinder-name') ?? document.querySelector('input[type="text"]')
    if (input && !input.value) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'WICK')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'typed a name'
    }
    const hit = [...document.querySelectorAll('button')]
      .filter(b => !b.disabled)
      .find(b => /enter|begin|start|world|continue|confirm/i.test(b.textContent ?? ''))
    if (!hit) return 'nothing clickable'
    hit.click()
    return `clicked "${hit.textContent?.trim()}"`
  })
  console.log(`  entry step ${step + 1}: ${what}`)
  await wait(2500)
}
let ready = false
for (let i = 0; i < 40; i++) {
  await wait(1500)
  ready = await page.evaluate(() => !!window.__wally)
  if (ready) { console.log(`  __wally appeared after ~${((i + 1) * 1.5).toFixed(1)}s`); break }
}
check('the world loaded and exposed __wally', ready)
if (!ready) { await browser.close(); process.exit(1) }

/* ------------------------------------------------- probe helpers in-page */
/**
 * Everything is read fresh on each call. The world canvas remounts once the
 * saved profile lands, which swaps the whole scene; a helper that closed over
 * the old scene would report a torn-down one as a clean one.
 */
const snap = () => page.evaluate(() => {
  const w = window.__wally
  if (!w) return { gone: true }
  const scene = w.player.parent
  if (!scene.userData.probeId) scene.userData.probeId = Math.random().toString(36).slice(2, 8)
  const root = scene.children.find(c => c.name === 'combat-vfx')
  if (!root) return { gone: true, world: scene.userData.probeId }
  // A bolt is the only vfx group carrying a PointLight plus exactly two meshes;
  // the float-text pool is sprites and the rings carry no light.
  const isBolt = o => o.isGroup && o.children.some(c => c.isPointLight) && o.children.filter(c => c.isMesh).length === 2
  const bolts = root.children.filter(isBolt)
  const p = w.player.position
  return {
    world: scene.userData.probeId,
    total: root.children.length,
    bolts: bolts.length,
    // Loose meshes parented straight to the root are bolt ribbon trail pieces.
    ribbons: root.children.filter(o => o.isMesh).length,
    range: bolts.map(b => +Math.hypot(b.position.x - p.x, b.position.z - p.z).toFixed(2)),
    hp: +w.vitals.hp.toFixed(1),
    // Live GPU allocations. Anything built and then abandoned shows up here
    // even when it has already been taken out of the scene graph.
    geometries: w.renderer.info.memory.geometries,
    textures: w.renderer.info.memory.textures,
    coins: w.player.parent.children.filter(c => c.userData.goldDrop).length,
  }
})

/** Wait until the same world instance has survived two polls in a row. */
const settleWorld = async () => {
  let seen = null
  for (let i = 0; i < 40; i++) {
    const s = await snap()
    if (!s.gone && s.world === seen) return s
    seen = s.world
    await wait(2000)
  }
  throw new Error('the world never stopped remounting')
}
await settleWorld()
await page.evaluate(() => {
  const w = window.__wally
  w.battle.setQuickCast(true)
  // A fresh character has an unspent point and no ranks; Q must be learned
  // before it can be cast at all.
  if (w.progress().ranks.Q < 1) w.battle.upgrade('Q')
})
console.log('  Q rank:', await page.evaluate(() => window.__wally.progress().ranks.Q))

/** Cast Lantern Glaive (MOTH Q) at a point straight ahead. */
const castQ = () => page.evaluate(() => {
  const w = window.__wally
  w.battle.debugFill()
  const p = w.player.position
  const THREE_V = p.clone().set(p.x, 0, p.z + 12)
  w.battle.pressSlot('Q', { cursorGround: THREE_V, hover: null })
  // Q has a real cooldown; the harness only cares that the visual is born.
  return true
})

/** Poll until the bolt count drops to `want`, or give up after `ms`. */
const settle = async (want, ms) => {
  const deadline = Date.now() + ms
  let last = null
  while (Date.now() < deadline) {
    last = await snap()
    if (last.gone) return { ok: false, ...last }
    if (last.bolts <= want) return { ok: true, ...last }
    await wait(500)
  }
  return { ok: false, ...last }
}

/* ------------------------------------------------------------- baseline */
console.log('\nBaseline')
const base = await snap()
// Every later count is only meaningful against the same scene instance.
const WORLD = base.world
const sameWorld = s => s.world === WORLD
console.log(`  combat-vfx children=${base.total} bolts=${base.bolts} hp=${base.hp} world=${WORLD}`)
check('no bolt effects before casting', base.bolts === 0, `bolts=${base.bolts}`)

/* -------------------------------------------- cast once, wait for return */
console.log('\nOne Lantern Glaive (flies 13m out at 22m/s, then returns)')
await castQ()
await wait(800)
const mid = await snap()
console.log(`  mid-flight: bolts=${mid.bolts} range=${JSON.stringify(mid.range)}`)
check('the glaive exists while it flies', mid.bolts >= 1, `bolts=${mid.bolts}`)

/*
 * 26m of travel at 22m/s is ~1.2s of game time, but software WebGL renders at
 * a couple of frames a second and the loop clamps dt, so the world runs about
 * ten times slower than the wall clock. Hence a polled deadline rather than a
 * guessed sleep: the round trip really does take ~13s of real time here.
 */
const settled = await settle(0, 45000)
console.log(`  settled: bolts=${settled.bolts} range=${JSON.stringify(settled.range)} total=${settled.total}`)
check('the glaive is gone once it has had time to return', settled.ok && sameWorld(settled),
  `bolts=${settled.bolts}, parked ${JSON.stringify(settled.range)}m from the player`)

/* ------------------------------------------- repeated casts must not grow */
console.log('\nFour more casts, each polled back to the baseline')
let worst = 0
for (let i = 0; i < 4; i++) {
  await castQ()
  await wait(1500)
  const s = await settle(0, 45000)
  worst = Math.max(worst, s.total)
  console.log(`  cast ${i + 2}: settled bolts=${s.bolts} total=${s.total} range=${JSON.stringify(s.range)}`)
}
const afterCasts = await snap()
check('repeated casting leaves no residue in combat-vfx', afterCasts.total === base.total,
  `total=${afterCasts.total} vs baseline ${base.total}`)
await page.screenshot({ path: `${SHOTS}-casts.png` })
check('repeated casting returns to zero live bolts', afterCasts.bolts === 0 && sameWorld(afterCasts),
  `bolts=${afterCasts.bolts} total=${afterCasts.total} (baseline total=${base.total})`)

/* ------------------------------------------------------ death and respawn */
console.log('\nDeath mid-cast, then respawn')
await castQ()
// Confirm the glaive is genuinely airborne before the killing blow, so the
// test cannot pass by killing a player who had nothing in flight.
const inFlight = await (async () => {
  for (let i = 0; i < 20; i++) {
    const s = await snap()
    if (s.bolts >= 1) return s
    await wait(500)
  }
  return await snap()
})()
console.log(`  in flight at the moment of death: bolts=${inFlight.bolts} range=${JSON.stringify(inFlight.range)}`)
check('a glaive was airborne when the player died', inFlight.bolts >= 1, `bolts=${inFlight.bolts}`)
await page.evaluate(() => window.__wally.vitals.damage(99999, null, 'harness', performance.now()))
/*
 * A short deadline on purpose. The round trip takes ~13s here, so a pass
 * inside 6s can only mean death tore the glaive down — it cannot be explained
 * by the glaive simply finishing its flight.
 */
const afterDeath = await settle(0, 6000)
console.log(`  after death+respawn: bolts=${afterDeath.bolts} total=${afterDeath.total} range=${JSON.stringify(afterDeath.range)} hp=${afterDeath.hp}`)
await page.screenshot({ path: `${SHOTS}-death.png` })
check('death clears every live bolt', afterDeath.ok && sameWorld(afterDeath), `bolts=${afterDeath.bolts}`)
check('the player did respawn', afterDeath.hp > 0, `hp=${afterDeath.hp}`)

/* ------------------------------------------- loot drops free what they built */
/*
 * The same question for the other transient thing the world spawns. A kill is
 * used rather than a death because the death forfeit is a percentage of what
 * the player is carrying, and a harness that keeps dying soon has nothing left
 * to drop. Each coin builds its own geometry and material, so watching
 * dispose() reach them is the direct test — `renderer.info.memory` only counts
 * what has been rendered, and coins can fall out of view.
 */
console.log('\nGold drops free their own geometry and material when collected')
const killed = await page.evaluate(() => {
  const w = window.__wally
  const victim = w.wildlife.animals.find(a => a.state !== 'dead')
  if (!victim) return null
  // Stand clear, so the coins are not walked into before they are counted.
  w.player.position.set(victim.group.position.x + 14, 0, victim.group.position.z)
  w.wildlife.hurt(victim, 99999, performance.now())
  return victim.species.label
})
console.log(`  killed: ${killed}`)
let onGround = null
for (let i = 0; i < 20; i++) {
  await wait(1000)
  onGround = await snap()
  if (onGround.coins > 0) break
}
console.log(`  coins on the ground: ${onGround.coins}`)
check('a kill dropped coins to test with', onGround.coins > 0, `coins=${onGround.coins}`)
if (onGround.coins > 0) {
  await page.evaluate(() => {
    window.__freed = { geometries: 0, materials: 0, meshes: 0 }
    for (const coin of window.__wally.player.parent.children.filter(c => c.userData.goldDrop)) {
      coin.traverse(node => {
        if (!node.isMesh) return
        window.__freed.meshes++
        const geometryDispose = node.geometry.dispose.bind(node.geometry)
        const materialDispose = node.material.dispose.bind(node.material)
        node.geometry.dispose = () => { window.__freed.geometries++; geometryDispose() }
        node.material.dispose = () => { window.__freed.materials++; materialDispose() }
      })
    }
  })
  // Walk onto the pile and let the pickup radius do the work.
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => {
      const w = window.__wally
      const coin = w.player.parent.children.find(c => c.userData.goldDrop)
      if (coin) w.player.position.set(coin.position.x, 0, coin.position.z)
    })
    await wait(1000)
    if ((await snap()).coins === 0) break
  }
  const freed = await page.evaluate(() => window.__freed)
  const left = await snap()
  console.log(`  collected ${freed.meshes} coin meshes; dispose() ran on ${freed.geometries} geometries and ${freed.materials} materials`)
  check('every collected coin was picked up', left.coins === 0, `coins=${left.coins}`)
  check('every collected coin freed its geometry and material',
    freed.geometries === freed.meshes && freed.materials === freed.meshes,
    `${freed.geometries}/${freed.meshes} geometries, ${freed.materials}/${freed.meshes} materials`)
}

console.log(`\nscreenshots: ${SHOTS}-casts.png  ${SHOTS}-death.png`)
console.log(`${failed === 0 ? 'PASS' : 'FAIL'} — ${failed} failed`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
