/* ------------------------------------------------------------------ *
 * How long a dropped player keeps standing in the road.
 *
 * Two failures look nothing alike from the server's side and this
 * measures both.
 *
 *   A clean close — tab closed, page navigated away — arrives as a close
 *   frame and the player is gone at once. `pagehide` in `src/pvp/net.ts`
 *   is what makes a closing browser take this path instead of the other
 *   one.
 *
 *   A hard drop — closed laptop, dead wifi — sends nothing. The socket
 *   stays OPEN as far as this process knows and only the heartbeat sweep
 *   can tell. That is the case `HEARTBEAT_INTERVAL_MS` and
 *   `STALE_CONNECTION_MS` are tuned for, and the case this script times.
 *
 * A hard drop cannot be faked by closing a socket, because closing one is
 * the other case. So the victim connects through a TCP proxy that can be
 * told to stop forwarding in both directions while holding both
 * connections open — which is what a router forgetting a NAT entry
 * actually looks like.
 *
 * The other half is that tightening the window must not cost anything.
 * Two rules stand to break, and both are checked here: a blip inside the
 * window still gets the player their character back where they left it,
 * and one character is still driven by exactly one connection.
 *
 *   node scripts/verify-heartbeat.mjs
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { WebSocket } from 'ws'

import { HEARTBEAT_INTERVAL_MS, STALE_CONNECTION_MS } from '../src/shared/pvp.ts'

const PORT = Number(process.env.PORT ?? 8811)
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8812)
const API = `http://127.0.0.1:${PORT}`
const ORIGIN = API
const ENV_FILE = '/tmp/voxels-heartbeat.env'

/** Worst case the tuning promises: silence has to pass, then a sweep has to run. */
const WORST_CASE_MS = STALE_CONNECTION_MS + HEARTBEAT_INTERVAL_MS

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const secs = ms => `${(ms / 1000).toFixed(1)}s`

async function until(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

/* ---------------------------------------------------------- the server */

let child = null

function startServer() {
  mkdirSync('data/heartbeat', { recursive: true })
  writeFileSync(
    ENV_FILE,
    [
      `PORT=${PORT}`,
      'WALLY_DB_PATH=data/heartbeat/wally.db',
      `WALLY_ALLOWED_ORIGINS=${ORIGIN}`,
      'WALLY_DEV_SESSIONS=1',
      'SOLANA_CLUSTER=devnet',
      '',
    ].join('\n'),
  )
  child = spawn('npx', ['tsx', `--env-file=${ENV_FILE}`, 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  child.log = log
}

const alive = async () => {
  try {
    return (await fetch(`${API}/api/live`)).ok
  } catch {
    return false
  }
}

/* ----------------------------------------------------------- the proxy */

/**
 * A TCP pipe with a kill switch.
 *
 * `silence()` stops copying bytes in both directions but leaves both
 * sockets open and unclosed, so neither end learns anything. The server
 * keeps writing pings into a void and no pong ever comes back, which is
 * exactly the state a vanished network leaves behind.
 */
function startProxy() {
  let silent = false
  const pairs = []
  const server = createServer(inbound => {
    const outbound = createConnection({ host: '127.0.0.1', port: PORT })
    pairs.push(inbound, outbound)
    inbound.on('data', d => { if (!silent) outbound.write(d) })
    outbound.on('data', d => { if (!silent) inbound.write(d) })
    const drop = () => { if (!silent) { inbound.destroy(); outbound.destroy() } }
    inbound.on('error', drop)
    outbound.on('error', drop)
    inbound.on('close', drop)
    outbound.on('close', drop)
  })
  return new Promise(resolve => {
    server.listen(PROXY_PORT, '127.0.0.1', () =>
      resolve({
        silence: () => { silent = true },
        close: () => { for (const s of pairs) s.destroy(); server.close() },
      }),
    )
  })
}

/* ---------------------------------------------------------- ws clients */

function connect(token, port = PORT, name = 'player') {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/pvp?token=${encodeURIComponent(token)}`, {
    origin: ORIGIN,
  })
  const received = []
  const state = { name, received, closed: false, closeCode: null, socket }
  socket.on('open', () =>
    socket.send(
      JSON.stringify({
        t: 'hello',
        protocol: 1,
        displayName: name,
        loadout: { character: 'ember', style: {}, level: 1, ranks: { Q: 0, W: 0, E: 0, R: 0 } },
      }),
    ),
  )
  socket.on('message', raw => {
    try {
      received.push({ ...JSON.parse(String(raw)), atMs: Date.now() })
    } catch {
      /* ignore */
    }
  })
  socket.on('close', code => {
    state.closed = true
    state.closeCode = code
  })
  socket.on('error', () => {})
  state.last = t => [...received].reverse().find(m => m.t === t) ?? null
  state.send = m => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m))
  }
  /** The newest presence frame at or after `sinceMs`, so old ones cannot answer. */
  state.presenceSince = sinceMs =>
    [...received].reverse().find(m => m.t === 'presence' && m.atMs >= sinceMs) ?? null
  return state
}

const session = async label =>
  fetch(`${API}/api/dev/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ label }),
  }).then(r => r.json())

/** Waits for the observer to stop listing `playerId`, and returns how long that took. */
async function timeToVanish(observer, playerId, from, timeoutMs) {
  const gone = await until(() => {
    const frame = observer.presenceSince(from)
    if (!frame) return null
    return frame.others.some(o => o.playerId === playerId) ? null : frame
  }, timeoutMs, 50)
  return gone ? gone.atMs - from : null
}

/* ------------------------------------------------------------------ run */

async function main() {
  console.log(`Voxels · connection-drop timing against ${API}`)
  console.log(`tuning: heartbeat ${secs(HEARTBEAT_INTERVAL_MS)} · stale ${secs(STALE_CONNECTION_MS)} · worst case ${secs(WORST_CASE_MS)}\n`)

  startServer()
  if (!(await until(alive, 60_000, 200))) {
    console.log(child.log.join(''))
    throw new Error('the server never came up')
  }
  const proxy = await startProxy()

  const watcher = await session('watch')
  const observer = connect(watcher.token, PORT, 'Observer')
  if (!(await until(() => observer.last('welcome'), 20_000))) throw new Error('the observer never joined')

  /* ---- 1. a clean close is immediate ------------------------------- */
  const quitter = await session('quit')
  const quitterSocket = connect(quitter.token, PORT, 'Quitter')
  if (!(await until(() => quitterSocket.last('welcome'), 20_000))) throw new Error('the quitter never joined')
  const sawQuitter = await until(
    () => observer.received.some(m => m.t === 'presence' && m.others.some(o => o.playerId === quitter.playerId)),
    20_000,
  )
  check('a second player shows up in presence', Boolean(sawQuitter))

  const cleanFrom = Date.now()
  quitterSocket.socket.close(1000, 'pagehide')
  const cleanMs = await timeToVanish(observer, quitter.playerId, cleanFrom, 15_000)
  check(
    'a clean close removes the player at once, with no sweep involved',
    cleanMs !== null && cleanMs < 1_000,
    cleanMs === null ? 'never vanished' : `measured ${secs(cleanMs)}`,
  )

  /* ---- 2. a hard drop is reaped inside the new window --------------- */
  const ghost = await session('ghost')
  const ghostSocket = connect(ghost.token, PROXY_PORT, 'Ghost')
  if (!(await until(() => ghostSocket.last('welcome'), 20_000))) throw new Error('the ghost never joined')
  ghostSocket.send({ t: 'pose', x: 40, z: 40, facing: 0, anim: 'run', sprinting: false })
  await until(
    () => observer.received.some(m => m.t === 'presence' && m.others.some(o => o.playerId === ghost.playerId)),
    20_000,
  )

  const dropFrom = Date.now()
  proxy.silence()
  console.log('    … network cut, holding the socket open; waiting for the sweep')
  const reapMs = await timeToVanish(observer, ghost.playerId, dropFrom, WORST_CASE_MS + 20_000)
  check(
    'a hard drop is reaped without the far end saying anything',
    reapMs !== null,
    reapMs === null ? 'still listed' : `measured ${secs(reapMs)}`,
  )
  check(
    'and not before the silence threshold, so a healthy connection is safe',
    reapMs !== null && reapMs >= STALE_CONNECTION_MS - 1_000,
    reapMs === null ? '' : `${secs(reapMs)} against a ${secs(STALE_CONNECTION_MS)} threshold`,
  )
  check(
    `and inside the ${secs(WORST_CASE_MS)} the tuning promises`,
    reapMs !== null && reapMs <= WORST_CASE_MS + 2_000,
    reapMs === null ? '' : `measured ${secs(reapMs)}`,
  )

  /* ---- 3. a blip inside the window keeps the character -------------- */
  // A fresh proxy, because the last one is deliberately wedged.
  const proxy2 = await (async () => {
    proxy.close()
    await sleep(200)
    return startProxy()
  })()

  const blipper = await session('blip')
  const first = connect(blipper.token, PROXY_PORT, 'Blipper')
  if (!(await until(() => first.last('welcome'), 20_000))) throw new Error('the blipper never joined')
  const WHERE = { x: -35, z: 55 }
  const settled = await until(async () => {
    first.send({ t: 'pose', x: WHERE.x, z: WHERE.z, facing: 0, anim: 'run', sprinting: false })
    await sleep(120)
    const you = first.last('you')
    return you && Math.hypot(you.self.x - WHERE.x, you.self.z - WHERE.z) < 3 ? you.self : null
  }, 60_000, 100)
  check('the blipper walked somewhere memorable', Boolean(settled), settled ? `${settled.x.toFixed(1)},${settled.z.toFixed(1)}` : 'never arrived')

  const blipFrom = Date.now()
  proxy2.silence()
  const RECONNECT_AFTER_MS = 8_000
  await sleep(RECONNECT_AFTER_MS)
  const second = connect(blipper.token, PORT, 'Blipper')
  const back = await until(() => second.last('welcome'), 20_000)
  check(
    `a blip reconnects inside the ${secs(STALE_CONNECTION_MS)} window`,
    Boolean(back),
    back ? `back after ${secs(Date.now() - blipFrom)}` : 'never got back in',
  )
  check('and it is the same character, not a new one', back?.playerId === blipper.playerId, back?.playerId ?? '')
  check(
    'and it resumes where the player was standing, so a drop is not a teleport',
    Boolean(back) && Math.hypot(back.self.x - WHERE.x, back.self.z - WHERE.z) < 3,
    back ? `${back.self.x.toFixed(1)},${back.self.z.toFixed(1)} against ${WHERE.x},${WHERE.z}` : '',
  )
  check('the gold came back with it', Boolean(back) && typeof back.gold?.available === 'number', `${back?.gold?.available}`)

  // The old socket is still hanging off the dead proxy. Sit past the point
  // where it gets reaped and make sure the reaping takes the ghost and not
  // the tab the player is actually looking at.
  const waitOut = Math.max(0, blipFrom + WORST_CASE_MS + 4_000 - Date.now())
  console.log(`    … waiting ${secs(waitOut)} for the abandoned socket to be reaped`)
  await sleep(waitOut)
  check(
    'reaping the abandoned socket does not evict the reconnected one',
    !second.closed && Boolean(second.last('welcome')),
    second.closed ? `closed with ${second.closeCode}` : 'still connected',
  )
  check('and the reconnected player was never told they were superseded', !second.last('superseded'))
  const stillThere = observer.presenceSince(Date.now() - 2_000)
  check(
    'and is still visible to everyone else',
    Boolean(stillThere?.others.some(o => o.playerId === blipper.playerId)),
  )

  /* ---- 4. one character, one connection ----------------------------- */
  const third = connect(blipper.token, PORT, 'Blipper')
  const evicted = await until(() => second.last('superseded'), 20_000)
  check('opening the character again still supersedes the older tab', Boolean(evicted), evicted?.detail ?? '')
  const thirdIn = await until(() => third.last('welcome'), 20_000)
  check('and the newest tab holds the character', thirdIn?.playerId === blipper.playerId)

  for (const s of [observer, second, third]) s.socket.close()
  proxy2.close()
  child.kill('SIGTERM')
  await until(async () => !(await alive()), 30_000)

  console.log(
    failures.length === 0
      ? `\nMeasured: a dead connection leaves in ${secs(reapMs)} and a clean close in ${secs(cleanMs)}.` +
        `\nBy the same arithmetic the previous 20s/60s tuning bounded this at 80s; that figure is not measured here.` +
        '\nReconnect and one-tab-per-character are unchanged.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  if (child) child.kill('SIGKILL')
  process.exit(1)
})
