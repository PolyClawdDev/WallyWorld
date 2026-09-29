/* ------------------------------------------------------------------ *
 * Proves the SERVER decides the name, against a real running server.
 *
 * Run with: npm run verify:names
 *
 * `test:names` exercises the modules. This exercises the product: it boots
 * the actual API process on its own database and behaves like an attacker
 * who has closed the browser and is talking to the HTTP and WebSocket
 * endpoints directly. Nothing here goes near the UI, because the point being
 * checked is that the UI is irrelevant.
 *
 * What it asserts
 *   1. PUT /api/profile with a blocked name is refused, and the refusal does
 *      not quote the name back or say what tripped.
 *   2. The refused name is not in the record afterwards.
 *   3. An innocent name that contains a blocked substring is accepted.
 *   4. Rapid name changes run out of budget and get a 429.
 *   5. Over the presence socket, a `hello` frame carrying a blocked name does
 *      not change the broadcast name — the frame is not rejected, the name is
 *      simply not the client's decision.
 *   6. A name written straight into the database by hand — the shape of the
 *      account that already exists in production — is not broadcast either.
 *
 * It prints no name that failed.
 * ------------------------------------------------------------------ */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocket } from 'ws'

const PORT = 4783
const BASE = `http://127.0.0.1:${PORT}`
const dbFile = resolve('data/name-api-test.db')
const financeFile = resolve('data/name-api-test-finance.db')

mkdirSync(resolve('data'), { recursive: true })
for (const base of [dbFile, financeFile]) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${base}${suffix}`) } catch { /* nothing to remove */ }
  }
}

let passed = 0
const failures: string[] = []
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed++; console.log(`  ok       ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL     ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** A blocked spelling assembled from the list at runtime, never typed here. */
async function blockedSpelling() {
  const { ALWAYS_TERMS } = await import('../src/server/moderation/blocklist')
  const term = ALWAYS_TERMS.find(t => t.length >= 6 && /^[a-z]+$/.test(t))!
  const leet: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5' }
  return [...term].map(ch => leet[ch] ?? ch).join('').toUpperCase()
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

async function waitForServer(deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/live`)
      if (res.ok) return true
    } catch { /* not up yet */ }
    await sleep(250)
  }
  return false
}

async function main() {
  const attempt = await blockedSpelling()
  console.log('Voxels · display-name enforcement against a live server')
  console.log(`  server      ${BASE}`)
  console.log(`  attempt     sha256:${createHash('sha256').update(attempt).digest('hex').slice(0, 12)} (not printed)`)
  console.log('')

  const server = spawn('npx', ['tsx', 'src/server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WALLY_DB_PATH: dbFile,
      WALLY_FINANCE_DB_PATH: financeFile,
      WALLY_DEV_SESSIONS: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log: string[] = []
  server.stdout.on('data', chunk => log.push(String(chunk)))
  server.stderr.on('data', chunk => log.push(String(chunk)))

  const stop = () => { try { server.kill('SIGKILL') } catch { /* already gone */ } }

  try {
    if (!(await waitForServer())) {
      console.log(log.join(''))
      throw new Error('the server never became ready')
    }

    const session = await fetch(`${BASE}/api/dev/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'nameapi' }),
    }).then(res => res.json() as Promise<{ token: string; playerId: string }>)
    check('a dev session was minted', Boolean(session.token))

    const profile = (playerName: string) => ({
      character: 'MOTH',
      style: { hat: 'crooked', robe: 'midnight', familiar: 'moth', accessory: 'lantern' },
      playerName,
      gold: 0,
    })
    const put = (playerName: string) =>
      fetch(`${BASE}/api/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ profile: profile(playerName) }),
      })

    /* ---- 1 & 2. the HTTP boundary ------------------------------------ */

    const refused = await put(attempt)
    const refusedBody = (await refused.json()) as { error?: string; detail?: string }
    check('a blocked name is refused by PUT /api/profile', refused.status === 422, `status ${refused.status}`)
    const detail = refusedBody.detail ?? ''
    check('the refusal does not quote the name back', !detail.toLowerCase().includes(attempt.toLowerCase()))
    check('the refusal does not say which rule fired', !/tier|blocklist|substring|token|slur/i.test(detail), detail)
    check('the refusal is a usable message for an honest player', /different name/i.test(detail), detail)

    const afterRefusal = await fetch(`${BASE}/api/profile`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then(res => res.json() as Promise<{ profile: { playerName: string } | null }>)
    check('the refused name was not stored', afterRefusal.profile?.playerName !== attempt)

    /* ---- 3. the Scunthorpe case, end to end -------------------------- */

    const innocent = await put('Scunthorpe Analyst')
    check('an innocent name containing a blocked substring is accepted', innocent.status === 200, `status ${innocent.status}`)
    const stored = (await innocent.json()) as { profile: { playerName: string } }
    check('the innocent name is stored verbatim', stored.profile.playerName === 'Scunthorpe Analyst', stored.profile.playerName)

    /* ---- 4. the budget ---------------------------------------------- */

    let limited = 0
    let accepted = 0
    for (let i = 0; i < 12; i++) {
      const res = await put(`Warden ${i}`)
      if (res.status === 429) limited += 1
      else if (res.status === 200) accepted += 1
    }
    check('rapid name changes are rate limited', limited > 0, `${accepted} accepted, ${limited} limited`)
    console.log(`           (${accepted} accepted then ${limited} refused with 429)`)

    /* ---- 5. the presence socket ------------------------------------- */

    const socketName = await new Promise<string | null>(done => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/pvp?token=${session.token}`)
      const timer = setTimeout(() => { ws.close(); done(null) }, 15_000)
      let sent = false
      ws.on('message', raw => {
        const msg = JSON.parse(String(raw)) as { t: string; self?: { displayName: string } }
        if (!sent) {
          sent = true
          ws.send(JSON.stringify({
            t: 'hello',
            protocol: 1,
            displayName: attempt,
            loadout: { character: 'MOTH', style: profile('x').style, level: 1, ranks: { Q: 0, W: 0, E: 0, R: 0 } },
          }))
          return
        }
        if ((msg.t === 'welcome' || msg.t === 'you') && msg.self) {
          clearTimeout(timer)
          ws.close()
          done(msg.self.displayName)
        }
      })
      ws.on('error', () => { clearTimeout(timer); done(null) })
    })
    check('the presence socket answered', socketName !== null)
    check('a blocked name sent over the socket is not the broadcast name', socketName !== attempt, 'the socket broadcast the attempted name')
    console.log(`           (the socket broadcast "${socketName}")`)

    /* ---- 6. a row written by hand ----------------------------------- */

    // Exactly the shape of the account that already exists in production: the
    // slur is in the table, not in a request. Written with the server running,
    // through a second handle, then read back over the API.
    const Database = (await import('better-sqlite3')).default
    const direct = new Database(dbFile)
    direct.prepare('update pvp_accounts set display_name = ? where player_id = ?').run(attempt, session.playerId)
    direct.close()

    const card = await fetch(`${BASE}/api/pvp/player/${session.playerId}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    }).then(res => res.json() as Promise<{ card?: { displayName: string } }>)
    check('a blocked name already in the database is not served', card.card?.displayName !== undefined && card.card.displayName !== attempt,
      `served ${JSON.stringify(card.card?.displayName)}`)
    console.log(`           (the API served "${card.card?.displayName}")`)

    /* ---- 7. the logs ------------------------------------------------ */

    const output = log.join('')
    check('the server never printed the attempted name', !output.toLowerCase().includes(attempt.toLowerCase()))
    check('the server logged a fingerprint instead', /display name refused \(/.test(output))
  } finally {
    stop()
  }

  console.log('')
  console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} checks passed, ${failures.length} failed`)
  for (const failure of failures) console.log(`  × ${failure}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
