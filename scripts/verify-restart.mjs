/* ------------------------------------------------------------------ *
 * Restarts the API underneath a connected player and checks that the
 * restart is survivable: the socket is told the server is going away
 * rather than just vanishing, the drain returns duel stakes, and the
 * same bearer token still names the same account afterwards.
 *
 * The server must be started by this script, because it needs to send
 * it a signal and then bring it back.
 *
 *   node scripts/verify-restart.mjs
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const PORT = Number(process.env.PORT ?? 8803)
const API = `http://127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`
const ENV_FILE = process.env.ENV_FILE ?? '/tmp/voxels-restart.env'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate, timeoutMs = 30_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

let child = null

function startServer() {
  child = spawn('npx', ['tsx', `--env-file=${ENV_FILE}`, 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  child.stdout.on('data', d => log.push(String(d)))
  child.stderr.on('data', d => log.push(String(d)))
  child.log = log
  return child
}

const alive = async () => {
  try {
    const res = await fetch(`${API}/api/live`)
    return res.ok
  } catch {
    return false
  }
}

function connect(token) {
  const socket = new WebSocket(`${API.replace('http', 'ws')}/ws/pvp?token=${encodeURIComponent(token)}`, {
    origin: ORIGIN,
  })
  const received = []
  const state = { received, closed: false, closeCode: null }
  socket.on('open', () =>
    socket.send(
      JSON.stringify({
        t: 'hello',
        protocol: 1,
        displayName: 'Restarter',
        loadout: { character: 'ember', style: {}, level: 1, ranks: { Q: 0, W: 0, E: 0, R: 0 } },
      }),
    ),
  )
  socket.on('message', raw => {
    try {
      received.push(JSON.parse(String(raw)))
    } catch {
      /* ignore */
    }
  })
  socket.on('close', code => {
    state.closed = true
    state.closeCode = code
  })
  socket.on('error', () => {})
  state.socket = socket
  state.last = t => [...received].reverse().find(m => m.t === t) ?? null
  state.send = m => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m))
  }
  return state
}

async function main() {
  console.log(`Voxels · restart survival against ${API}\n`)

  startServer()
  const up = await until(alive, 40_000)
  check('the server came up', Boolean(up))
  if (!up) {
    console.log(child.log.join(''))
    process.exit(1)
  }

  /* ---- an account, a socket, a position ------------------------------ */
  const session = await fetch(`${API}/api/dev/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ label: 'restart' }),
  }).then(r => r.json())

  const before = await fetch(`${API}/api/auth/me`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(r => r.json())
  check('the session names an account before the restart', Boolean(before?.wallet), JSON.stringify(before).slice(0, 120))

  const player = connect(session.token)
  const joined = await until(() => player.last('you'))
  check('the player joined', Boolean(joined), joined?.id)

  player.send({ t: 'pose', x: 11, z: 9, facing: 0.5, anim: 'run' })
  await sleep(300)

  /* ---- SIGTERM, the way a platform does it --------------------------- */
  child.kill('SIGTERM')

  const warned = await until(() => player.last('serverClosing'), 30_000)
  check(
    'the connected player is told the server is closing',
    Boolean(warned),
    warned ? `reconnect after ${warned.reconnectAfterMs}ms — ${warned.detail}` : 'no serverClosing frame',
  )

  const shut = await until(() => player.closed, 30_000)
  check('the socket is closed by the drain rather than left hanging', Boolean(shut), `close code ${player.closeCode}`)

  const gone = await until(async () => !(await alive()), 30_000)
  check('the process exited on SIGTERM', Boolean(gone))

  const log = child.log.join('')
  check('the drain is reported on the way out', /draining|shutting down|drain/i.test(log), log.trim().split('\n').slice(-3).join(' · '))

  /* ---- and back again ------------------------------------------------ */
  startServer()
  const back = await until(alive, 40_000)
  check('the server came back', Boolean(back))

  const after = await fetch(`${API}/api/auth/me`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(r => r.json())
  check(
    'the same bearer token still names the same account after the restart',
    JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify(after).slice(0, 120),
  )

  const rejoined = connect(session.token)
  const rejoin = await until(() => rejoined.last('you'))
  check('the player can rejoin with the same token', Boolean(rejoin), rejoin?.id)
  check('and is the same character', rejoin?.id === joined?.id)

  rejoined.socket.close()
  child.kill('SIGTERM')
  await until(async () => !(await alive()), 30_000)

  console.log(
    failures.length === 0
      ? '\nRestart survives: the player is warned, the stakes are returned, the account persists.'
      : `\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  if (child) child.kill('SIGKILL')
  process.exit(1)
})
