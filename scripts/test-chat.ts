/*
 * Chat, proved with THREE live sockets against a real hub.
 *
 * Three and not two, because the interesting assertions are all negative —
 * "and nobody else heard it" — and with two clients "nobody else" is the
 * empty set. The third player stands 85 m away and outside every channel
 * except `/all`, so every leak has somewhere to show up.
 *
 * Run with: npm run test:chat
 */
import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const dbFile = resolve('data/chat-test.db')
const financeFile = resolve('data/chat-test-finance.db')
mkdirSync(resolve('data'), { recursive: true })
for (const base of [dbFile, financeFile]) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(`${base}${suffix}`) } catch { /* nothing to remove */ }
  }
}
process.env.WALLY_DB_PATH = dbFile
process.env.WALLY_FINANCE_DB_PATH = financeFile
process.env.WALLY_DEV_SESSIONS = '1'

/* ------------------------------------------------------------------ *
 * Recording everything the server prints.
 *
 * Installed before a single server module is imported, so the startup
 * banners are captured too. It TEES rather than swallows: the run is still
 * readable, and the recording is what the "no message content in the logs"
 * assertion is checked against at the end.
 *
 * Nothing this script prints ever contains a message body, so the
 * recording cannot be poisoned by the test's own output.
 * ------------------------------------------------------------------ */
let recorded = ''
for (const stream of [process.stdout, process.stderr] as const) {
  const original = stream.write.bind(stream)
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    recorded += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof stream.write
}

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = '') {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * Unique tokens that stand in for message bodies.
 *
 * Every assertion about "did this arrive" and "did this get logged" is made
 * on one of these rather than on a realistic sentence, so a match is never a
 * coincidence and the log scan at the end cannot be fooled by a substring of
 * ordinary prose.
 */
const canary = (label: string) => `CANARY7${label}7QX`

type Client = {
  send: (msg: object) => void
  inbox: Array<Record<string, unknown>>
  chat: () => Array<Record<string, unknown>>
  close: () => void
}

async function main() {
  const { createSession } = await import('../src/server/auth')
  const { ensureAccount, saveLoadout, accountByPlayer } = await import('../src/server/pvp/ids')
  const { setBlock } = await import('../src/server/pvp/challenges')
  const { livePose } = await import('../src/server/pvp/hub')
  const { attachPvpUpgrade } = await import('../src/server/pvp')
  const { CHAT_MAX_LEN, CHAT_RATE, CHAT_SAY_RADIUS } = await import('../src/shared/pvp')
  const { parseInput, DEFAULT_CHANNEL } = await import('../src/chat/commands')
  const { sanitiseMessage, vetChat } = await import('../src/server/chat/chat')
  const { screenMessage } = await import('../src/server/moderation/messages')
  const { ALWAYS_TERMS } = await import('../src/server/moderation/blocklist')

  const loadout = { character: 'MOTH' as const, style: { hat: 'crooked' as const, robe: 'midnight' as const, familiar: 'moth' as const, accessory: 'lantern' as const }, level: 8, ranks: { Q: 2, W: 2, E: 1, R: 1 } }

  const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  attachPvpUpgrade(server)
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
  const port = (server.address() as { port: number }).port

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** Gives the hub time to fan a message out, then reads what landed. */
  const settle = () => sleep(220)

  async function client(wallet: string, name: string, at: { x: number; z: number }) {
    const account = ensureAccount(wallet)
    saveLoadout(account.player_id, name, loadout)
    const session = createSession(wallet)
    const inbox: Array<Record<string, unknown>> = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pvp?token=${encodeURIComponent(session.token)}`)
    await new Promise<void>((open, reject) => {
      ws.addEventListener('open', () => open())
      ws.addEventListener('error', () => reject(new Error(`ws did not open for ${name}`)))
    })
    ws.addEventListener('message', ev => inbox.push(JSON.parse(String(ev.data))))
    const api: Client = {
      send: (msg: object) => ws.send(JSON.stringify(msg)),
      inbox,
      chat: () => inbox.filter(m => m.t === 'chat').map(m => m.msg as Record<string, unknown>),
      close: () => ws.close(),
    }
    api.send({ t: 'hello', protocol: 1, displayName: name, loadout })
    // The first pose of a connection with no remembered position is trusted
    // absolutely, which is the only way to stand somebody 85 m out without
    // walking them there.
    api.send({ t: 'pose', ...at, facing: 0, anim: 'idle', sprinting: false })
    for (let i = 0; i < 60; i++) {
      const pose = livePose(account.player_id)
      if (Math.hypot(pose.x - at.x, pose.z - at.z) < 0.01) break
      await sleep(25)
    }
    return { ...api, account }
  }

  /*
   * Five sockets, and the extras exist for one reason: the rate limit is
   * real and applies to this test too.
   *
   * The budget is per player, so a single sender would run out of it halfway
   * through and every later assertion would be measuring the rate limiter
   * instead of the thing under test. Splitting the phases across senders
   * keeps each one well inside its budget, and lets the rate-limit phase
   * have a completely fresh one — which is what makes "exactly the budget
   * got through" an assertion worth making rather than a coincidence.
   */
  const ash = await client('ChatWalletA11111111111111111111111', 'Ash', { x: 0, z: 0 })
  const birch = await client('ChatWalletB22222222222222222222222', 'Birch', { x: 12, z: 0 })
  const cedar = await client('ChatWalletC33333333333333333333333', 'Cedar', { x: -30, z: -80 })
  const dale = await client('ChatWalletD44444444444444444444444', 'Dale', { x: 4, z: 4 })
  const elm = await client('ChatWalletE55555555555555555555555', 'Elm', { x: -4, z: 4 })

  const gap = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)
  const poseA = livePose(ash.account.player_id)
  const poseB = livePose(birch.account.player_id)
  const poseC = livePose(cedar.account.player_id)
  check('Birch is inside say range of Ash', gap(poseA, poseB) < CHAT_SAY_RADIUS, `${gap(poseA, poseB).toFixed(1)} m`)
  check('Cedar is outside say range of Ash', gap(poseA, poseC) > CHAT_SAY_RADIUS, `${gap(poseA, poseC).toFixed(1)} m`)

  const everyone = [ash, birch, cedar, dale, elm]
  const clear = () => { for (const c of everyone) c.inbox.length = 0 }
  const heard = (c: { chat: () => Array<Record<string, unknown>> }, text: string) =>
    c.chat().filter(m => m.text === text)

  /**
   * Everything every client except these ones has received, as one string.
   *
   * The negative assertions are checked against the RAW socket traffic and
   * not against parsed chat frames, because "it did not arrive as a chat
   * message" is a weaker claim than "it does not appear anywhere in anything
   * this connection was sent".
   */
  const bystanderTraffic = (...except: Array<{ account: { player_id: string } }>) => {
    const skip = new Set(except.map(c => c.account.player_id))
    return JSON.stringify(everyone.filter(c => !skip.has(c.account.player_id)).map(c => c.inbox))
  }

  try {
    /* ---- 1. /all reaches everyone ----------------------------------- */
    clear()
    const allText = canary('ALL')
    ash.send({ t: 'chat', channel: 'all', text: allText })
    await settle()
    eq('/all reaches the sender', heard(ash, allText).length, 1)
    eq('/all reaches the nearby player', heard(birch, allText).length, 1)
    eq('/all reaches the player 85 m away', heard(cedar, allText).length, 1)
    eq('/all is labelled as the all channel', heard(birch, allText)[0]?.channel, 'all')

    /* ---- 2. /say is local ------------------------------------------- */
    clear()
    const sayText = canary('SAY')
    ash.send({ t: 'chat', channel: 'say', text: sayText })
    await settle()
    eq('/say reaches the sender', heard(ash, sayText).length, 1)
    eq('/say reaches the nearby player', heard(birch, sayText).length, 1)
    eq('/say does NOT reach the distant player', heard(cedar, sayText).length, 0)

    /* ---- 3. /w reaches the target and nobody else -------------------- */
    clear()
    const whisperText = canary('WHISPER')
    ash.send({ t: 'chat', channel: 'whisper', to: 'Birch', text: whisperText })
    await settle()
    eq('a whisper reaches its target', heard(birch, whisperText).length, 1)
    eq('the sender gets one echo of their own whisper', heard(ash, whisperText).length, 1)
    eq('the echo names who it went to', heard(ash, whisperText)[0]?.toName, 'Birch')
    eq('the recipient is not told their own name back', heard(birch, whisperText)[0]?.toName, undefined)
    eq('a whisper does NOT reach a third player', heard(cedar, whisperText).length, 0)
    check('nor any of the other three bystanders', heard(dale, whisperText).length + heard(elm, whisperText).length === 0)
    check('and the whisper text appears nowhere in any bystander\'s socket traffic',
      !bystanderTraffic(ash, birch).includes(whisperText))

    /* ---- 4. a whisper to nobody says so, and says no more ----------- */
    clear()
    const ghostText = canary('GHOST')
    ash.send({ t: 'chat', channel: 'whisper', to: 'Nobody Here At All', text: ghostText })
    await settle()
    const ghostRefusal = ash.chat().find(m => m.code === 'no_target')
    check('a whisper to an unknown name is refused to the sender', Boolean(ghostRefusal))
    check('and the refusal does not repeat the attempted name',
      !String(ghostRefusal?.text ?? '').includes('Nobody Here At All'), String(ghostRefusal?.text ?? ''))
    check('a failed whisper reaches nobody at all', !bystanderTraffic(ash).includes(ghostText))

    /* ---- 5. a block silences words, not just challenges ------------- */
    clear()
    setBlock(birch.account.player_id, dale.account.player_id, true)
    const blockedText = canary('BLOCKED')
    dale.send({ t: 'chat', channel: 'all', text: blockedText })
    await settle()
    eq('a blocked sender does not reach the blocker', heard(birch, blockedText).length, 0)
    eq('but still reaches everyone who did not block them', heard(cedar, blockedText).length, 1)
    eq('and still sees their own line', heard(dale, blockedText).length, 1)

    clear()
    const blockedWhisper = canary('BLOCKEDW')
    dale.send({ t: 'chat', channel: 'whisper', to: 'Birch', text: blockedWhisper })
    await settle()
    eq('a blocked whisper is not delivered', heard(birch, blockedWhisper).length, 0)
    // Deliberate: the sender's echo looks like success, because telling them
    // otherwise would out the person who blocked them.
    eq('and the sender is not told a block exists', heard(dale, blockedWhisper).length, 1)

    setBlock(birch.account.player_id, dale.account.player_id, false)
    clear()
    const unblockedText = canary('UNBLOCKED')
    dale.send({ t: 'chat', channel: 'all', text: unblockedText })
    await settle()
    eq('unblocking restores delivery', heard(birch, unblockedText).length, 1)

    /* ---- 6. the length cap refuses, and does not truncate ----------- */
    clear()
    const longText = `${canary('LONG')}${'x'.repeat(CHAT_MAX_LEN)}`
    dale.send({ t: 'chat', channel: 'all', text: longText })
    await settle()
    const tooLong = dale.chat().find(m => m.code === 'too_long')
    check('an over-long message is refused', Boolean(tooLong))
    eq('an over-long message reaches nobody', heard(birch, longText).length, 0)
    check('and no truncated version of it is published',
      !birch.chat().some(m => String(m.text ?? '').startsWith(canary('LONG'))),
      JSON.stringify(birch.chat().map(m => String(m.text).slice(0, 40))))
    // Exactly at the cap is fine, so the boundary is where it says it is.
    clear()
    const atCap = `${canary('CAP')}${'y'.repeat(CHAT_MAX_LEN - canary('CAP').length)}`
    eq('the boundary case is exactly at the cap', atCap.length, CHAT_MAX_LEN)
    dale.send({ t: 'chat', channel: 'all', text: atCap })
    await settle()
    eq('a message exactly at the cap is delivered whole', heard(birch, atCap).length, 1)

    /* ---- 7. the rate limit refuses ---------------------------------- */
    // Elm has sent nothing, so the whole budget is intact and the arithmetic
    // below is exact rather than approximate.
    clear()
    const burst = CHAT_RATE.max + 6
    for (let i = 0; i < burst; i++) elm.send({ t: 'chat', channel: 'all', text: `${canary('RATE')}${i}` })
    await settle()
    const limited = elm.chat().filter(m => m.code === 'rate_limited')
    const delivered = birch.chat().filter(m => String(m.text ?? '').startsWith(canary('RATE')))
    eq('exactly the budget gets through and the rest are refused', delivered.length, CHAT_RATE.max)
    eq('every message past the budget is refused', limited.length, burst - CHAT_RATE.max)
    check('and a refusal is a message to the sender, not a silent drop',
      limited.length > 0 && limited.every(m => String(m.text ?? '').length > 0))
    check('fewer messages are published than were sent', delivered.length < burst,
      `${delivered.length} published of ${burst} sent`)
    // Everything that was refused stayed refused: nothing arrived late.
    await sleep(400)
    check('a refused message does not arrive late',
      birch.chat().filter(m => String(m.text ?? '').startsWith(canary('RATE'))).length === delivered.length)

    /* ---- 8. markup arrives as literal text -------------------------- */
    clear()
    const markup = `<b>${canary('MARKUP')}</b> <script>alert(1)</script> & "q" 'q' <img src=x onerror=y>`
    check('the markup probe is within the cap', markup.length <= CHAT_MAX_LEN, `${markup.length}`)
    ash.send({ t: 'chat', channel: 'all', text: markup })
    await settle()
    const got = heard(birch, markup)[0]
    check('markup arrives byte-for-byte as it was sent', Boolean(got),
      JSON.stringify(birch.chat().map(m => m.text)))
    eq('no entity encoding, no stripping, no rewriting', got?.text, markup)

    /* ---- 9. the name is the server's, whatever the client claims ----- */
    clear()
    const spoofText = canary('SPOOF')
    // Extra fields on the frame, which is the only place a client could try to
    // put a name — the protocol has no name field on `chat` to begin with.
    ash.send({ t: 'chat', channel: 'all', text: spoofText, displayName: 'Overlord', fromName: 'Overlord', fromId: birch.account.player_id })
    await settle()
    const asSeen = heard(birch, spoofText)[0]
    eq('the broadcast name is the server\'s name', asSeen?.fromName, 'Ash')
    eq('and it matches what the accounts table says', asSeen?.fromName, accountByPlayer(ash.account.player_id)?.display_name)
    eq('the sender id is the connection\'s, not the one the frame claimed', asSeen?.fromId, ash.account.player_id)
    check('the claimed name appears nowhere in what anyone received',
      !bystanderTraffic().includes('Overlord'))

    /* ---- 10. moderation refuses to the sender only ------------------ */
    clear()
    // Taken from the existing blocklist at runtime so no slur is written into
    // this file, and so the test cannot drift from the list it is testing.
    const term = ALWAYS_TERMS[0]
    dale.send({ t: 'chat', channel: 'all', text: `${canary('MOD')} ${term}` })
    await settle()
    const refused = dale.chat().find(m => m.code === 'refused')
    check('a message that trips the filter is refused', Boolean(refused))
    check('the sender is told, rather than the message being silently dropped',
      String(refused?.text ?? '').length > 20)
    check('the refusal does not name the trigger', !String(refused?.text ?? '').includes(term))
    eq('a refused message reaches nobody else', heard(birch, `${canary('MOD')} ${term}`).length, 0)
    check('and no part of it is published to anyone', !bystanderTraffic(dale).includes(term))

    /* ---- 11. it is still possible to speak English ------------------- */
    clear()
    const innocent = [
      'I live in Scunthorpe and my sister is a therapist',
      'each inkling of class was analysed by the assassin',
      'Cockburn passed the grapes to Hancock at the cocktail bar',
      'as it is on the map, go up to the hill',
    ]
    for (const sentence of innocent) {
      eq(`an innocent sentence is not refused: "${sentence.slice(0, 26)}…"`, screenMessage(sentence).ok, true)
    }
  } finally {
    for (const c of everyone) c.close()
    await sleep(120)
    server.close()
  }

  /* ---- 12. pure units: the parser and the sanitiser ---------------- */
  eq('the default channel is the local one', DEFAULT_CHANNEL, 'say')
  eq('a plain line goes to the default channel', parseInput('hello there').kind === 'send' && (parseInput('hello there') as { channel: string }).channel, 'say')
  eq('/all addresses everyone', (parseInput('/all hi') as { channel: string }).channel, 'all')
  eq('/w parses a target', JSON.stringify(parseInput('/w Birch hi there')), JSON.stringify({ kind: 'send', channel: 'whisper', text: 'hi there', to: 'Birch' }))
  eq('/w handles a quoted name with a space', (parseInput('/w "Ana L" hi') as { to: string }).to, 'Ana L')
  eq('/help is answered locally', parseInput('/help').kind, 'local')
  // The classic chat bug: a mistyped /whisper escaping as a public line.
  const typo = parseInput('/wisper Birch a secret')
  eq('an unknown command is not sent', typo.kind, 'local')
  check('and the unknown command is not echoed back as public text',
    typo.kind === 'local' && !typo.text.includes('a secret'), JSON.stringify(typo))
  eq('// sends a literal slash', (parseInput('//slash') as { text: string }).text, '/slash')
  eq('a newline cannot forge a second line', sanitiseMessage('one\ntwo'), 'one two')
  eq('zero-width padding is stripped', sanitiseMessage('a\u200b\u200b\u200bb'), 'ab')
  // Length is measured before sanitisation, or a megabyte of invisibles would
  // pass a cap it never respected.
  const invisibleFlood = 'a'.repeat(4) + '\u200b'.repeat(CHAT_MAX_LEN * 4)
  const flooded = vetChat({ playerId: 'p_lengthprobe', channel: 'all', text: invisibleFlood, to: null })
  check('the cap is measured on the frame as sent, not on what survives sanitising',
    !flooded.ok && flooded.code === 'too_long', JSON.stringify(flooded))

  /* ---- 13. nothing said in this test was ever printed -------------- */
  const labels = ['ALL', 'SAY', 'WHISPER', 'GHOST', 'BLOCKED', 'BLOCKEDW', 'UNBLOCKED', 'LONG', 'CAP', 'RATE', 'MARKUP', 'SPOOF', 'MOD']
  const leaked = labels.filter(label => recorded.includes(canary(label)))
  eq('no message body reached stdout or stderr', leaked, [])
  check('and no blocklist term was printed either', !recorded.includes(ALWAYS_TERMS[0]))

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const fail of failures) console.error(`  ✗ ${fail}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
