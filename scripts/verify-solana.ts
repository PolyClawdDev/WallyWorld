/* ------------------------------------------------------------------ *
 * End-to-end verification of the Solana integration against devnet.
 *
 * Run with a server up:  npm run server   (then)  npm run verify:solana
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * It cannot prove the Phantom flow. A browser extension cannot be
 * installed in this environment, so the one thing standing in for Phantom
 * is a throwaway fixture keypair from scripts/.fixtures/ which produces
 * the same kind of ed25519 signature Phantom would. That fixture is a
 * test double, never a user wallet, and the application code has no path
 * that reads it.
 *
 * Everything else is exercised for real: the running HTTP server, real
 * SQLite writes, real devnet RPC, and — when an airdrop succeeds — a real
 * devnet transaction confirmed on chain.
 *
 * The client modules under src/solana/ are imported directly rather than
 * reimplemented, so what is tested is the code the browser runs.
 * ------------------------------------------------------------------ */

import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'
import { buildSiwsMessage, checkSiwsFields, SIWS_STATEMENT } from '../src/shared/siws'
import { validateProfile, type Profile } from '../src/shared/profile'
import { CHAIN_ID, CLUSTER, RPC, fundsLabel, truncateAddress } from '../src/solana/cluster'
import { fetchSolLamports, fetchTokenHoldings, getConnection, verifyCluster } from '../src/solana/rpc'
import { awaitConfirmation, planTransfer } from '../src/solana/payments'
import { verifyTransfer } from '../src/server/chain'
import { formatBaseUnits, formatSol, parseAmountToBaseUnits } from '../src/solana/units'
import { fixtureKeypair } from './fixture-keys'

const API = process.env.VERIFY_API ?? 'http://127.0.0.1:8787'
const ORIGIN = 'http://127.0.0.1:5173'

let passed = 0
let failed = 0
const skipped: string[] = []

function check(name: string, condition: unknown, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(name: string, why: string) {
  skipped.push(`${name}: ${why}`)
  console.log(`  skip  ${name} — ${why}`)
}

const section = (title: string) => console.log(`\n${title}`)

type Reply = { status: number; body: any }

async function api(path: string, options: { method?: string; body?: unknown; token?: string; origin?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  const origin = options.origin === undefined ? ORIGIN : options.origin
  if (origin) headers.Origin = origin
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const response = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body }
}

/** Signs the sign-in text exactly as Phantom's signMessage would. */
function signMessageAsWallet(keypair: Keypair, message: string): string {
  const signature = ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32))
  return bs58.encode(signature)
}

/** Full sign-in, returning the session token. */
async function signInAs(keypair: Keypair): Promise<{ token: string; profile: Profile }> {
  const address = keypair.publicKey.toBase58()
  const nonceReply = await api('/api/auth/nonce', { method: 'POST', body: { publicKey: address } })
  const checked = checkSiwsFields(nonceReply.body.challenge, {
    domain: '127.0.0.1:5173',
    uri: ORIGIN,
    address,
    chainId: CHAIN_ID,
  })
  if (!checked.ok) throw new Error(`challenge rejected: ${checked.reason}`)
  const signature = signMessageAsWallet(keypair, buildSiwsMessage(checked.fields))
  const verified = await api('/api/auth/verify', {
    method: 'POST',
    body: { publicKey: address, nonce: checked.fields.nonce, signature },
  })
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`)
  return { token: verified.body.token, profile: verified.body.profile }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type RealTransfer = { signature: string; payer: string; recipient: string; lamports: bigint; lastValidBlockHeight: number }

/**
 * Finds a transfer that is already confirmed on the cluster, so the
 * "confirmed" branches of both verifiers can be tested with real ledger data
 * even when the faucet will not fund the fixture.
 *
 * Walks back from the current slot looking for a transaction with exactly one
 * account whose balance rose and a fee payer whose balance fell, which is the
 * shape the server's balance-delta check is written against.
 */
async function findRealTransfer(): Promise<RealTransfer | null> {
  const connection = getConnection()
  const currentSlot = await connection.getSlot('confirmed')
  const blockHeight = await connection.getBlockHeight('confirmed')

  for (let offset = 0; offset < 40; offset++) {
    let block
    try {
      block = await connection.getParsedBlock(currentSlot - offset - 20, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
        transactionDetails: 'full',
        rewards: false,
      })
    } catch {
      continue
    }
    for (const entry of block?.transactions ?? []) {
      if (entry.meta?.err) continue
      const keys = entry.transaction.message.accountKeys
      const pre = entry.meta?.preBalances
      const post = entry.meta?.postBalances
      if (!pre || !post || pre.length !== keys.length) continue

      const risen = keys
        .map((key, index) => ({ address: key.pubkey.toBase58(), delta: BigInt(post[index]) - BigInt(pre[index]) }))
        .filter(item => item.delta > 0n)
      if (risen.length !== 1) continue

      const payer = keys[0]?.pubkey.toBase58()
      const recipient = risen[0].address
      if (!payer || payer === recipient) continue
      // Needs to be a plain lamport transfer between two distinct accounts.
      if (BigInt(post[0]) - BigInt(pre[0]) >= 0n) continue

      const signature = entry.transaction.signatures[0]
      if (typeof signature !== 'string') continue
      // A high deadline keeps the poller from short-circuiting into "expired".
      return { signature, payer, recipient, lamports: risen[0].delta, lastValidBlockHeight: blockHeight + 500 }
    }
  }
  return null
}

async function main() {
  const payer = fixtureKeypair('test-payer')
  const other = fixtureKeypair('test-other')
  const payerAddress = payer.publicKey.toBase58()

  console.log('Wally World · Solana verification')
  console.log(`  api      ${API}`)
  console.log(`  cluster  ${CLUSTER}`)
  console.log(`  rpc      ${RPC.ok ? RPC.endpoint : `MISCONFIGURED: ${RPC.problem}`}`)
  console.log(`  fixture  ${payerAddress}  (test double for Phantom — never a user wallet)`)

  /* ---------------------------------------------------------------- units */
  section('Integer base units (no floating point on any amount)')
  check('1 SOL formats from lamports', formatSol(1_000_000_000n) === '1', formatSol(1_000_000_000n))
  check('sub-lamport precision preserved', formatSol(1_000_000_001n) === '1.000000001', formatSol(1_000_000_001n))
  check('dust does not round away', formatSol(1n) === '0.000000001', formatSol(1n))
  check('grouping applied', formatBaseUnits(123456789012345678n, 9) === '123,456,789.012345678')
  const parsed = parseAmountToBaseUnits('0.1', 9)
  check('0.1 SOL parses to exact lamports', parsed.ok && parsed.baseUnits === 100_000_000n)
  // The classic float failure: 0.1 + 0.2 must stay exact through base units.
  const a = parseAmountToBaseUnits('0.1', 9)
  const b = parseAmountToBaseUnits('0.2', 9)
  check(
    '0.1 + 0.2 === 0.3 exactly in base units',
    a.ok && b.ok && a.baseUnits + b.baseUnits === 300_000_000n,
    a.ok && b.ok ? (a.baseUnits + b.baseUnits).toString() : 'parse failed',
  )
  check('too many decimals rejected', parseAmountToBaseUnits('0.0000000001', 9).ok === false)
  check('negative rejected', parseAmountToBaseUnits('-1', 9).ok === false)
  check('exponent notation rejected', parseAmountToBaseUnits('1e9', 9).ok === false)
  check('zero rejected', parseAmountToBaseUnits('0', 9).ok === false)

  /* ------------------------------------------------------------ labelling */
  section('Demo / test / live labelling')
  check('disconnected on devnet reads as demo', fundsLabel(false).mode === 'demo', fundsLabel(false).short)
  check('connected on devnet reads as test funds', fundsLabel(true).mode === 'test', fundsLabel(true).short)
  check('devnet never claims real funds', !fundsLabel(true).short.includes('REAL'))
  check('demo label says no real funds', fundsLabel(false).short.includes('NO REAL FUNDS'))
  check('address truncation keeps both ends', truncateAddress(payerAddress, 4, 4) === `${payerAddress.slice(0, 4)}…${payerAddress.slice(-4)}`)

  /* ----------------------------------------------------------------- rpc */
  section('Devnet RPC')
  const clusterCheck = await verifyCluster()
  check('genesis hash matches the configured cluster', clusterCheck.status === 'ok', JSON.stringify(clusterCheck))
  let lamports = 0n
  try {
    lamports = await fetchSolLamports(payerAddress)
    check('SOL balance read returns a bigint', typeof lamports === 'bigint', `${lamports} lamports`)
  } catch (error) {
    check('SOL balance read', false, String(error))
  }
  try {
    const holdings = await fetchTokenHoldings(payerAddress)
    check('SPL token holdings read', Array.isArray(holdings), `${holdings.length} non-zero token accounts`)
    check('every holding amount is a bigint', holdings.every(h => typeof h.amount === 'bigint'))
  } catch (error) {
    check('SPL token holdings read', false, String(error))
  }

  /* -------------------------------------------------------------- health */
  section('Server health and posture')
  const health = await api('/api/health')
  check('health responds 200', health.status === 200)
  check('reports the configured cluster', health.body?.cluster === CLUSTER, String(health.body?.cluster))
  check('persistence is sqlite, not memory', health.body?.persistence === 'sqlite')
  check('rpc reachable from the server', health.body?.rpcReachable === true, String(health.body?.rpcDetail))
  check('payouts reported disabled', health.body?.payoutsEnabled === false)
  check('declares no custody', /none/i.test(String(health.body?.custody)))

  /* ------------------------------------------------------------- sign-in */
  section('Sign-In With Solana')
  const nonceReply = await api('/api/auth/nonce', { method: 'POST', body: { publicKey: payerAddress } })
  check('nonce issued', nonceReply.status === 201)
  const challenge = nonceReply.body?.challenge
  const checked = checkSiwsFields(challenge, { domain: '127.0.0.1:5173', uri: ORIGIN, address: payerAddress, chainId: CHAIN_ID })
  check('challenge passes the client-side template check', checked.ok, checked.ok ? '' : checked.reason)
  check('statement is the fixed wording', challenge?.statement === SIWS_STATEMENT)
  check('nonce is 32 random bytes of hex', /^[0-9a-f]{64}$/.test(String(challenge?.nonce)))
  check('challenge is bound to this wallet', challenge?.address === payerAddress)
  check('challenge is bound to the domain', challenge?.domain === '127.0.0.1:5173')
  check('challenge carries an expiry', Date.parse(String(challenge?.expirationTime)) > Date.now())

  const secondNonce = await api('/api/auth/nonce', { method: 'POST', body: { publicKey: payerAddress } })
  check('each request gets a fresh nonce', secondNonce.body?.challenge?.nonce !== challenge?.nonce)

  check(
    'nonce request from a foreign origin is refused',
    (await api('/api/auth/nonce', { method: 'POST', body: { publicKey: payerAddress }, origin: 'https://evil.example' })).status === 403,
  )
  check(
    'malformed public key refused',
    (await api('/api/auth/nonce', { method: 'POST', body: { publicKey: 'not-an-address' } })).status === 400,
  )

  // A tampered challenge must be refused by the client before the user sees it.
  check(
    'client refuses a challenge for a different domain',
    checkSiwsFields({ ...challenge, domain: 'evil.example' }, { domain: '127.0.0.1:5173', uri: ORIGIN, address: payerAddress, chainId: CHAIN_ID }).ok === false,
  )
  check(
    'client refuses an altered statement',
    checkSiwsFields({ ...challenge, statement: 'Approve this transfer of 10 SOL' }, { domain: '127.0.0.1:5173', uri: ORIGIN, address: payerAddress, chainId: CHAIN_ID }).ok === false,
  )
  check(
    'client refuses a challenge for another wallet',
    checkSiwsFields({ ...challenge, address: other.publicKey.toBase58() }, { domain: '127.0.0.1:5173', uri: ORIGIN, address: payerAddress, chainId: CHAIN_ID }).ok === false,
  )

  const message = buildSiwsMessage(checked.ok ? checked.fields : challenge)
  const goodSignature = signMessageAsWallet(payer, message)

  check(
    'signature from the wrong key is rejected',
    (await api('/api/auth/verify', { method: 'POST', body: { publicKey: payerAddress, nonce: challenge.nonce, signature: signMessageAsWallet(other, message) } })).status === 401,
  )
  check(
    'signature over different text is rejected',
    (await api('/api/auth/verify', { method: 'POST', body: { publicKey: payerAddress, nonce: challenge.nonce, signature: signMessageAsWallet(payer, `${message} `) } })).status === 401,
  )
  check(
    'a nonce cannot be redeemed by a different wallet',
    (await api('/api/auth/verify', { method: 'POST', body: { publicKey: other.publicKey.toBase58(), nonce: challenge.nonce, signature: goodSignature } })).status === 401,
  )
  check(
    'unknown nonce is rejected',
    (await api('/api/auth/verify', { method: 'POST', body: { publicKey: payerAddress, nonce: 'f'.repeat(64), signature: goodSignature } })).status === 401,
  )

  const verified = await api('/api/auth/verify', { method: 'POST', body: { publicKey: payerAddress, nonce: challenge.nonce, signature: goodSignature } })
  check('valid signature is accepted', verified.status === 200, JSON.stringify(verified.body?.error ?? ''))
  check('a session token is issued', typeof verified.body?.token === 'string' && verified.body.token.length >= 32)
  check('session has an expiry', typeof verified.body?.expiresAtMs === 'number' && verified.body.expiresAtMs > Date.now())
  const token: string = verified.body.token

  /* --------------------------------------------------------------- replay */
  section('Replay protection')
  const replay = await api('/api/auth/verify', { method: 'POST', body: { publicKey: payerAddress, nonce: challenge.nonce, signature: goodSignature } })
  check('replaying the exact same nonce and signature fails', replay.status === 401, JSON.stringify(replay.body))
  check('the reason names the consumed challenge', /used|unknown|expired/i.test(String(replay.body?.detail)))

  const ttl = Number(process.env.WALLY_NONCE_TTL_MS ?? 0)
  if (ttl > 0 && ttl <= 5000) {
    const ageing = await api('/api/auth/nonce', { method: 'POST', body: { publicKey: payerAddress } })
    await sleep(ttl + 400)
    const stale = await api('/api/auth/verify', {
      method: 'POST',
      body: {
        publicKey: payerAddress,
        nonce: ageing.body.challenge.nonce,
        signature: signMessageAsWallet(payer, buildSiwsMessage(ageing.body.challenge)),
      },
    })
    check('an expired nonce is rejected', stale.status === 401, JSON.stringify(stale.body?.detail))
  } else {
    skip('expired nonce rejection', `needs WALLY_NONCE_TTL_MS <= 5000 (currently ${ttl || 'default 300000'})`)
  }

  /* ------------------------------------------------------------- sessions */
  section('Session handling')
  check('authenticated identity is the signing wallet', (await api('/api/auth/me', { token })).body?.wallet === payerAddress)
  check('no token is unauthenticated', (await api('/api/profile')).status === 401)
  check('a forged token is unauthenticated', (await api('/api/profile', { token: 'not-a-real-token' })).status === 401)
  check('a token-shaped forgery is unauthenticated', (await api('/api/profile', { token: Buffer.alloc(32, 9).toString('base64url') })).status === 401)

  /* ------------------------------------------------------------ profiles */
  section('Persistence round-trip')
  const profile: Profile = {
    character: 'ORBIT',
    style: { hat: 'starfold', robe: 'slate', familiar: 'orb', accessory: 'compass' },
    playerName: 'Verify Orbit',
    gold: 4242,
  }
  const saved = await api('/api/profile', { method: 'PUT', body: { profile }, token })
  check('profile saves', saved.status === 200, JSON.stringify(saved.body?.detail ?? ''))
  const reread = await api('/api/profile', { token })
  check('character round-trips', reread.body?.profile?.character === 'ORBIT')
  check('wardrobe round-trips', reread.body?.profile?.style?.hat === 'starfold' && reread.body?.profile?.style?.accessory === 'compass')
  check('player name round-trips', reread.body?.profile?.playerName === 'Verify Orbit')
  check('gold round-trips', reread.body?.profile?.gold === 4242)
  check('server restates that gold is client-asserted', reread.body?.goldIsClientAsserted === true)

  section('Input validation')
  const bad: Array<[string, unknown]> = [
    ['unknown character', { ...profile, character: 'WIZARD' }],
    ['unknown hat', { ...profile, style: { ...profile.style, hat: 'sombrero' } }],
    ['fractional gold', { ...profile, gold: 1.5 }],
    ['negative gold', { ...profile, gold: -1 }],
    ['absurd gold', { ...profile, gold: 10 ** 12 }],
    ['gold as a string', { ...profile, gold: '100' }],
    ['missing style', { ...profile, style: undefined }],
    ['style as array', { ...profile, style: [] }],
    ['empty name', { ...profile, playerName: '   ' }],
    ['profile as array', []],
  ]
  for (const [label, candidate] of bad) {
    const reply = await api('/api/profile', { method: 'PUT', body: { profile: candidate }, token })
    check(`rejects ${label}`, reply.status === 422, `status ${reply.status}`)
  }
  // Sanitisation rather than rejection: control characters are stripped and the
  // name is clamped, which the shared validator does for both sides.
  const messy = validateProfile({ ...profile, playerName: `  Ka\u0000rl\u001b  the\tvery\u200blong name that goes on  ` })
  check('name is sanitised and clamped', messy.ok && messy.profile.playerName.length <= 24 && !/[\u0000-\u001f]/.test(messy.profile.playerName), messy.ok ? JSON.stringify(messy.profile.playerName) : messy.reason)

  /* ----------------------------------------------------------- isolation */
  section('Cross-wallet isolation')
  const otherSession = await signInAs(other)
  await api('/api/profile', {
    method: 'PUT',
    token: otherSession.token,
    body: { profile: { character: 'CINDER', style: { hat: 'witch', robe: 'ember', familiar: 'bat', accessory: 'book' }, playerName: 'Someone Else', gold: 11 } },
  })
  const mine = await api('/api/profile', { token })
  const theirs = await api('/api/profile', { token: otherSession.token })
  check('each session sees only its own record', mine.body?.profile?.playerName === 'Verify Orbit' && theirs.body?.profile?.playerName === 'Someone Else')
  check('the other wallet cannot see my gold', theirs.body?.profile?.gold === 11)
  check('my record was not overwritten', mine.body?.profile?.gold === 4242)

  /* ------------------------------------------------------------- payments */
  section('Payment plan and fee quote')
  const quote = await api('/api/payments/quote', { token })
  let planLamports = 0n
  let recipient = ''
  if (quote.body?.available) {
    recipient = quote.body.recipient
    planLamports = BigInt(quote.body.lamports)
    check('server quotes a price and recipient', planLamports > 0n && recipient.length > 30, `${planLamports} lamports → ${truncateAddress(recipient, 6, 6)}`)
    check('quote names the cluster', quote.body.cluster === CLUSTER)

    const plan = await planTransfer(payerAddress, recipient, planLamports)
    check('transfer plan carries a live blockhash', typeof plan.blockhash === 'string' && plan.blockhash.length > 30)
    check('plan has a block height deadline', plan.lastValidBlockHeight > 0)
    check('fee is quoted by the cluster', plan.feeLamports !== null && plan.feeLamports > 0n, `${plan.feeLamports} lamports`)
    check('total is amount + fee, in integers', plan.totalLamports === planLamports + (plan.feeLamports ?? 0n))
    check('transaction is unsigned at this point', plan.transaction.signatures.every(s => s.signature === null))
    check('plan rejects paying yourself', await planTransfer(payerAddress, payerAddress, 1n).then(() => false, () => true))
    check('plan rejects a zero amount', await planTransfer(payerAddress, recipient, 0n).then(() => false, () => true))
  } else {
    skip('payment quote', `server reports payments unavailable: ${quote.body?.reason}`)
  }

  section('Confirmation polling states')
  // A well-formed signature that was never submitted. The honest answer is
  // "expired" or "unknown", never "confirmed".
  const neverSent = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 251))
  const height = await getConnection().getBlockHeight('confirmed')
  const outcome = await awaitConfirmation(neverSent, height - 1, { timeoutMs: 8000, intervalMs: 1000 })
  check('a never-submitted signature is not reported confirmed', outcome.status !== 'confirmed', outcome.status)
  check('it is reported as expired or unknown', ['expired', 'unknown', 'timeout'].includes(outcome.status), outcome.status)

  /* ------------------------------------------------ real confirmed tx */
  section('Confirmed-path verification against a real on-chain transfer')
  // The devnet faucet is frequently dry, so rather than leave the "confirmed"
  // branches untested, a genuine transfer that already exists on the cluster is
  // located and both verifiers are run against it. Real ledger data, no funds
  // required.
  const sample = await findRealTransfer()
  if (!sample) {
    skip('confirmed-path verification', 'no suitable SystemProgram transfer found in recent blocks')
  } else {
    console.log(`  ..    using ${sample.signature.slice(0, 20)}… (${sample.lamports} lamports)`)
    const poll = await awaitConfirmation(sample.signature, sample.lastValidBlockHeight, { timeoutMs: 20_000 })
    check('client poller reports a real transfer as confirmed', poll.status === 'confirmed', JSON.stringify(poll))

    const good = await verifyTransfer(sample.signature, { payer: sample.payer, recipient: sample.recipient, lamports: sample.lamports })
    check('server verifier confirms it from the chain', good.status === 'confirmed', JSON.stringify(good))

    const wrongPayer = await verifyTransfer(sample.signature, { payer: payerAddress, recipient: sample.recipient, lamports: sample.lamports })
    check('server rejects a wallet claiming someone else\u2019s payment', wrongPayer.status === 'mismatch', wrongPayer.status)

    const wrongRecipient = await verifyTransfer(sample.signature, { payer: sample.payer, recipient: other.publicKey.toBase58(), lamports: sample.lamports })
    check('server rejects a payment to a different recipient', wrongRecipient.status === 'mismatch', wrongRecipient.status)

    const underpaid = await verifyTransfer(sample.signature, { payer: sample.payer, recipient: sample.recipient, lamports: sample.lamports + 1_000_000_000n })
    check('server rejects an underpaid amount', underpaid.status === 'mismatch', underpaid.detail ?? underpaid.status)
  }

  section('On-chain payment submitted by this script')
  let balance = await fetchSolLamports(payerAddress)
  const needed = planLamports + 10_000n
  if (quote.body?.available && balance < needed) {
    // The public devnet faucet refuses most requests. Try a few sizes before
    // giving up; a skip here is honest, a fabricated pass would not be.
    for (const amount of [needed * 3n, 100_000_000n, 20_000_000n, needed + 20_000n]) {
      try {
        console.log(`  ..    requesting a devnet airdrop of ${amount} lamports`)
        const airdropSig = await getConnection().requestAirdrop(payer.publicKey, Number(amount))
        const airdropHeight = (await getConnection().getLatestBlockhash('confirmed')).lastValidBlockHeight
        await awaitConfirmation(airdropSig, airdropHeight, { timeoutMs: 45_000, intervalMs: 1500 })
        balance = await fetchSolLamports(payerAddress)
        if (balance >= needed) break
      } catch (error) {
        console.log(`  ..    refused: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`)
        await sleep(1500)
      }
    }
  }

  if (!quote.body?.available) {
    skip('on-chain transfer', 'payments are not configured on the server')
  } else if (balance < needed) {
    skip('on-chain transfer', `fixture has ${balance} lamports, needs ${needed}; devnet airdrop is rate-limited`)
    // Still prove the server refuses to confirm something that did not happen.
    const bogus = await api('/api/payments/receipt', { method: 'POST', token, body: { signature: neverSent } })
    check('a receipt for a never-sent signature is not confirmed', bogus.body?.receipt?.status !== 'confirmed', String(bogus.body?.receipt?.status))
  } else {
    const plan = await planTransfer(payerAddress, recipient, planLamports)
    // The fixture signs here in place of Phantom. In the app this step happens
    // inside the extension and no key is ever present in the page.
    plan.transaction.sign(payer)
    const signature = await getConnection().sendRawTransaction(plan.transaction.serialize())
    console.log(`  ..    submitted ${signature}`)

    const submitted = await api('/api/payments/receipt', { method: 'POST', token, body: { signature } })
    check('receipt recorded on submission', submitted.status === 201, JSON.stringify(submitted.body?.receipt?.status))

    const confirmOutcome = await awaitConfirmation(signature, plan.lastValidBlockHeight, { timeoutMs: 60_000 })
    check('client confirmation polling reports confirmed', confirmOutcome.status === 'confirmed', JSON.stringify(confirmOutcome))

    const rechecked = await api('/api/payments/recheck', { method: 'POST', token, body: { signature } })
    check('server verifies the transfer against the chain', rechecked.body?.receipt?.status === 'confirmed', String(rechecked.body?.receipt?.detail))
    check('receipt records the exact lamports', rechecked.body?.receipt?.lamports === planLamports.toString())

    const again = await api('/api/payments/receipt', { method: 'POST', token, body: { signature } })
    check('resubmitting the same signature is idempotent', again.body?.idempotent === true && again.status === 200)

    const stolen = await api('/api/payments/receipt', { method: 'POST', token: otherSession.token, body: { signature } })
    check('another wallet cannot claim the same signature', stolen.status === 409, `status ${stolen.status}`)

    const receipts = await api('/api/payments/receipts', { token })
    check('receipt appears in the wallet history', receipts.body?.receipts?.some((r: any) => r.signature === signature))
    const theirReceipts = await api('/api/payments/receipts', { token: otherSession.token })
    check('the receipt is not visible to another wallet', !theirReceipts.body?.receipts?.some((r: any) => r.signature === signature))
  }

  section('Malformed payment input')
  check('non-base58 signature refused', (await api('/api/payments/receipt', { method: 'POST', token, body: { signature: 'nope!' } })).status === 400)
  check('short signature refused', (await api('/api/payments/receipt', { method: 'POST', token, body: { signature: 'abc' } })).status === 400)
  check('recheck of an unknown signature is 404', (await api('/api/payments/recheck', { method: 'POST', token, body: { signature: bs58.encode(Uint8Array.from({ length: 64 }, () => 11)) } })).status === 404)
  check('payments require a session', (await api('/api/payments/quote')).status === 401)

  /* -------------------------------------------------------------- payouts */
  section('Gold payout stays disabled')
  const payout = await api('/api/payouts/status')
  check('payout status reports disabled', payout.body?.enabled === false)
  check('status string says unavailable', /UNAVAILABLE/.test(String(payout.body?.status)))
  check('reason names the forgeable client state', /client-asserted|browser/i.test(String(payout.body?.reason)))
  check('no mint is named', !/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(String(payout.body?.reason)))
  check('payout attempts are refused', (await api('/api/payouts/claim', { method: 'POST', token, body: {} })).status === 501)

  /* ------------------------------------------------------------ hardening */
  section('Request hardening')
  check('oversized body gets a clean 413', (await api('/api/profile', { method: 'PUT', token, body: { profile, pad: 'x'.repeat(40_000) } })).status === 413)
  check('non-JSON body refused', (await api('/api/auth/nonce', { method: 'POST', body: 'plain text' as unknown })).status === 400)
  check('unknown route is 404', (await api('/api/nope')).status === 404)
  check('legacy demo task endpoint still answers', (await api('/api/tasks', { method: 'POST' })).status === 201)

  section('Logout')
  check('logout succeeds', (await api('/api/auth/logout', { method: 'POST', token })).status === 200)
  check('the token is dead afterwards', (await api('/api/profile', { token })).status === 401)

  /* ---------------------------------------------------------------- done */
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed, ${skipped.length} skipped`)
  if (skipped.length) {
    console.log('\nSkipped (not verified here):')
    skipped.forEach(entry => console.log(`  - ${entry}`))
  }
  console.log('\nNot covered by this script, and not verifiable in this environment:')
  console.log('  - Phantom detection, connect/disconnect, and the accountChanged event')
  console.log('  - Phantom signMessage and signAndSendTransaction approval dialogs')
  console.log('  - Anything requiring the browser extension to be installed')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error('\nverification crashed:', error)
  process.exit(1)
})
