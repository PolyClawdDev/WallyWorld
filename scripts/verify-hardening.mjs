/* ------------------------------------------------------------------ *
 * Exercises the public-deployment guards against a running server.
 *
 * Everything here is a claim that would otherwise only be checked by
 * reading the code: that a strange origin is turned away at the socket
 * upgrade, that two tabs cannot drive one character, that a teleport is
 * clamped rather than believed, that a dropped socket comes back, and
 * that nothing financial rides along in a broadcast.
 *
 *   API=http://127.0.0.1:8801 node scripts/verify-hardening.mjs
 * ------------------------------------------------------------------ */

import { WebSocket } from 'ws'

const API = process.env.API ?? 'http://127.0.0.1:8801'
const WS = API.replace(/^http/, 'ws')
const ORIGIN = process.env.ORIGIN ?? 'http://127.0.0.1:5201'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Polls rather than sleeping a guessed interval. */
async function until(predicate, timeoutMs = 15_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

async function devSession(label) {
  const res = await fetch(`${API}/api/dev/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(`dev session ${label} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/** A connected presence client that records everything the server sent. */
function connect(token, { origin = ORIGIN } = {}) {
  const socket = new WebSocket(`${WS}/ws/pvp?token=${encodeURIComponent(token)}`, { origin })
  const received = []
  const state = { open: false, closed: false, closeCode: null, received }
  socket.on('open', () => {
    state.open = true
    socket.send(JSON.stringify({
      t: 'hello',
      protocol: 1,
      displayName: 'Tester',
      loadout: { character: 'ember', style: {}, level: 1, ranks: { Q: 0, W: 0, E: 0, R: 0 } },
    }))
  })
  socket.on('message', raw => {
    try {
      received.push(JSON.parse(String(raw)))
    } catch {
      /* ignore junk */
    }
  })
  socket.on('close', code => {
    state.closed = true
    state.closeCode = code
  })
  socket.on('error', () => { /* close reports the outcome */ })
  state.socket = socket
  state.last = type => [...received].reverse().find(msg => msg.t === type) ?? null
  state.has = type => received.some(msg => msg.t === type)
  state.send = msg => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)) }
  return state
}

async function main() {
  console.log(`Voxels · public-hardening checks against ${API}\n`)

  /* ---- health and readiness ------------------------------------------ */
  const live = await fetch(`${API}/api/live`).then(r => r.json())
  check('/api/live reports live', live.status === 'live')

  const ready = await fetch(`${API}/api/ready`)
  const readyBody = await ready.json()
  check('/api/ready is 200 while the database is reachable', ready.status === 200 && readyBody.status === 'ready')
  check('/api/ready names the database in its checks', readyBody.checks.some(c => c.name.startsWith('database:')),
    readyBody.checks.map(c => `${c.name}=${c.ok}`).join(' '))

  /* ---- origin rejection at the socket upgrade ------------------------- */
  const stranger = await devSession('origin')
  const refused = connect(stranger.token, { origin: 'https://evil.example.com' })
  await until(() => refused.closed || refused.open, 5_000)
  check('socket upgrade refuses a foreign origin', refused.closed && !refused.open)

  /* ---- two sessions in one world -------------------------------------- */
  const alpha = await devSession('alpha')
  const beta = await devSession('beta')
  const a = connect(alpha.token)
  const b = connect(beta.token)

  const aWelcome = await until(() => a.last('welcome'))
  const bWelcome = await until(() => b.last('welcome'))
  check('session A joined', Boolean(aWelcome), aWelcome?.playerId)
  check('session B joined', Boolean(bWelcome), bWelcome?.playerId)
  check('the two are different characters', aWelcome?.playerId !== bWelcome?.playerId)

  const seesOther = await until(() => {
    const presence = b.last('presence') ?? b.last('welcome')
    const list = presence?.others ?? []
    return list.some(p => p.playerId === aWelcome.playerId) ? list : null
  })
  check('B sees A in presence', Boolean(seesOther))

  /* ---- no financial values in a broadcast ----------------------------- */
  const presenceMessages = a.received.filter(msg => msg.t === 'presence')
  const financialWords = /gold|balance|available|reserved|stake|pot|lamport|payout|escrow/i
  const leak = presenceMessages.find(msg => financialWords.test(JSON.stringify(msg)))
  check('presence broadcasts carry nothing financial', !leak, leak ? JSON.stringify(leak).slice(0, 160) : `${presenceMessages.length} broadcasts scanned`)

  /* ---- server-authoritative movement ---------------------------------- */
  // Walk a legitimate distance first, so the connection is past its one
  // trusted seed pose and every later claim is measured against the budget.
  a.send({ t: 'pose', x: 10, z: 10, facing: 0, anim: 'walk', sprinting: false })
  await sleep(300)
  a.send({ t: 'pose', x: 12, z: 10, facing: 0, anim: 'walk', sprinting: false })
  await sleep(300)

  const beforeTeleport = a.last('you')?.self ?? { x: 12, z: 10 }
  a.send({ t: 'pose', x: 90, z: -90, facing: 0, anim: 'run', sprinting: true })
  await sleep(500)
  const afterTeleport = (await until(() => {
    const self = a.last('you')?.self
    return self && Math.hypot(self.x - beforeTeleport.x, self.z - beforeTeleport.z) >= 0 ? self : null
  })) ?? beforeTeleport
  const travelled = Math.hypot(afterTeleport.x - beforeTeleport.x, afterTeleport.z - beforeTeleport.z)
  check('a teleport claim is clamped, not believed', travelled < 30 && Math.hypot(afterTeleport.x - 90, afterTeleport.z + 90) > 30,
    `server put A at ${afterTeleport.x.toFixed(1)},${afterTeleport.z.toFixed(1)} after claiming 90,-90`)

  // Honest movement inside the budget is accepted unchanged.
  const honestFrom = afterTeleport
  a.send({ t: 'pose', x: honestFrom.x + 1.5, z: honestFrom.z, facing: 0, anim: 'walk', sprinting: false })
  const honest = await until(() => {
    const self = a.last('you')?.self
    return self && Math.abs(self.x - (honestFrom.x + 1.5)) < 0.01 ? self : null
  }, 5_000)
  check('honest movement inside the budget is accepted as sent', Boolean(honest),
    honest ? `${honest.x.toFixed(2)},${honest.z.toFixed(2)}` : 'server did not accept a 1.5m step')

  /* ---- one tab per character ------------------------------------------ */
  const secondTab = connect(alpha.token)
  const superseded = await until(() => (a.has('superseded') ? a.last('superseded') : null), 10_000)
  check('the first tab is told it was superseded', Boolean(superseded), superseded?.detail)
  await until(() => a.closed, 5_000)
  check('the first tab is then closed', a.closed, `close code ${a.closeCode}`)

  const secondWelcome = await until(() => secondTab.last('welcome'))
  check('the second tab drives the same character', secondWelcome?.playerId === aWelcome.playerId)

  // The displaced socket must not still be able to move the wizard.
  const beforeGhost = secondTab.last('you')?.self ?? secondTab.last('welcome')?.self
  a.send({ t: 'pose', x: -50, z: -50, facing: 0, anim: 'run', sprinting: true })
  await sleep(600)
  const afterGhost = secondTab.last('you')?.self ?? beforeGhost
  check('the displaced tab can no longer move the character',
    Math.hypot(afterGhost.x + 50, afterGhost.z + 50) > 20,
    `character is at ${afterGhost.x.toFixed(1)},${afterGhost.z.toFixed(1)}`)

  /* ---- reconnect restores control -------------------------------------- */
  const posBeforeDrop = secondTab.last('you')?.self ?? secondTab.last('welcome')?.self
  secondTab.socket.terminate()
  await until(() => secondTab.closed, 5_000)
  await sleep(400)

  const rejoined = connect(alpha.token)
  const rejoinWelcome = await until(() => rejoined.last('welcome'), 15_000)
  check('a dropped session can reconnect', Boolean(rejoinWelcome))
  check('reconnect resumes the same character', rejoinWelcome?.playerId === aWelcome.playerId)
  const resumedAt = rejoinWelcome?.self
  check('reconnect resumes the remembered position rather than respawning',
    resumedAt && Math.hypot(resumedAt.x - posBeforeDrop.x, resumedAt.z - posBeforeDrop.z) < 2,
    `was ${posBeforeDrop.x.toFixed(1)},${posBeforeDrop.z.toFixed(1)} · now ${resumedAt?.x.toFixed(1)},${resumedAt?.z.toFixed(1)}`)

  rejoined.send({ t: 'pose', x: resumedAt.x + 2, z: resumedAt.z, facing: 0, anim: 'walk', sprinting: false })
  const movedAfterReconnect = await until(() => {
    const self = rejoined.last('you')?.self
    return self && Math.abs(self.x - (resumedAt.x + 2)) < 0.5 ? self : null
  }, 8_000)
  check('control works again after reconnect', Boolean(movedAfterReconnect))

  /* ---- socket upgrade rate limit --------------------------------------- */
  // The budget is 30 handshakes per minute per address, and the checks above
  // have already spent some of it.
  let refusedCount = 0
  for (let i = 0; i < 40; i++) {
    const probe = connect(alpha.token)
    await until(() => probe.open || probe.closed, 2_000)
    if (probe.closed && !probe.open) refusedCount += 1
    probe.socket.terminate()
  }
  check('the socket upgrade budget eventually refuses', refusedCount > 0, `${refusedCount}/40 handshakes refused`)

  for (const client of [a, b, secondTab, rejoined, refused]) client.socket.terminate()

  console.log()
  if (failures.length) {
    console.error(`${failures.length} failed: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('All public-hardening checks passed.')
  process.exit(0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
