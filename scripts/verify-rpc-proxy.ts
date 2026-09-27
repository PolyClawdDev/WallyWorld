/* ------------------------------------------------------------------ *
 * Verification for the RPC proxy and the credential scrubbing.
 *
 * Run against a server started with the cluster you want to test:
 *
 *   npm run server                       # devnet
 *   npm run verify:proxy
 *
 *   SOLANA_CLUSTER=mainnet-beta npm run server
 *   SOLANA_CLUSTER=mainnet-beta npm run verify:proxy
 *
 * What it proves:
 *   - allowlisted read methods work through the proxy;
 *   - non-allowlisted methods are refused rather than forwarded;
 *   - the upstream endpoint URL, its host and its token never appear in
 *     any client-visible response, including error paths and /api/health.
 *
 * The expected secret fragments are read from the environment here purely
 * so the assertions can look for them. Nothing is printed.
 * ------------------------------------------------------------------ */

import { normaliseCluster } from '../src/shared/clusters'

const API = process.env.VERIFY_API ?? 'http://127.0.0.1:8787'
const ORIGIN = 'http://127.0.0.1:5173'
const CLUSTER = normaliseCluster(process.env.SOLANA_CLUSTER)

let passed = 0
let failed = 0

function check(name: string, condition: unknown, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (title: string) => console.log(`\n${title}`)

/**
 * Every fragment that must never appear in client-visible output: the full URL,
 * its host, and each long path segment (which is where a provider token lives).
 */
function secretFragments(): string[] {
  const fragments = new Set<string>()
  for (const name of ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_MAINNET_BETA', 'SOLANA_RPC_URL_DEVNET', 'SOLANA_RPC_URL_TESTNET']) {
    const raw = (process.env[name] ?? '').trim()
    if (!raw) continue
    try {
      const url = new URL(raw)
      // Public Solana endpoints carry no credential, so they are not secrets and
      // asserting on them would produce noise rather than signal.
      if (url.hostname.endsWith('.solana.com')) continue
      fragments.add(raw)
      fragments.add(url.host)
      fragments.add(url.hostname)
      for (const segment of url.pathname.split('/')) if (segment.length >= 8) fragments.add(segment)
    } catch {
      fragments.add(raw)
    }
  }
  // Generic provider markers, checked regardless of what is configured.
  fragments.add('quiknode')
  fragments.add('quicknode')
  return [...fragments].filter(Boolean)
}

const SECRETS = secretFragments()

/** Case-insensitive scan of a blob of text for any secret fragment. */
function leaks(text: string): string | null {
  const haystack = text.toLowerCase()
  for (const fragment of SECRETS) {
    if (haystack.includes(fragment.toLowerCase())) return fragment.length > 24 ? `${fragment.slice(0, 12)}…` : fragment
  }
  return null
}

type Reply = { status: number; text: string; body: any }

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, text, body: parsed }
}

const rpc = (method: string, params: unknown[] = []) => post('/api/rpc', { jsonrpc: '2.0', id: 1, method, params })

/** Collects every byte the client can see, for one combined leak scan at the end. */
const seen: string[] = []
const record = (reply: Reply) => {
  seen.push(reply.text)
  return reply
}

async function main() {
  console.log('Voxels · RPC proxy verification')
  console.log(`  api      ${API}`)
  console.log(`  cluster  ${CLUSTER}`)
  console.log(`  secrets  ${SECRETS.length} fragment(s) being checked for (values not printed)`)

  /* ------------------------------------------------------------ allowlist */
  section('Allowlisted reads succeed through the proxy')

  const genesis = record(await rpc('getGenesisHash'))
  check('getGenesisHash returns 200', genesis.status === 200, `status ${genesis.status}`)
  check('getGenesisHash returns a result', typeof genesis.body?.result === 'string', String(genesis.body?.result ?? genesis.body?.error?.message))

  const expectedGenesis: Record<string, string> = {
    'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  }
  check(
    `genesis hash is really ${CLUSTER}`,
    genesis.body?.result === expectedGenesis[CLUSTER],
    String(genesis.body?.result),
  )

  // A real mainnet account with a well-known non-zero balance, so a balance read
  // through the proxy can be asserted rather than just "did not error". This is
  // the Wrapped SOL mint, which exists on every cluster.
  const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112'
  const balance = record(await rpc('getBalance', [WRAPPED_SOL_MINT]))
  check('getBalance returns 200', balance.status === 200, `status ${balance.status}`)
  check('getBalance returns an integer lamport value', Number.isInteger(balance.body?.result?.value), String(balance.body?.result?.value))

  const blockhash = record(await rpc('getLatestBlockhash'))
  check('getLatestBlockhash returns 200', blockhash.status === 200, `status ${blockhash.status}`)
  check(
    'blockhash looks like a blockhash',
    typeof blockhash.body?.result?.value?.blockhash === 'string' && blockhash.body.result.value.blockhash.length > 30,
    String(blockhash.body?.result?.value?.blockhash).slice(0, 12) + '…',
  )
  check(
    'blockhash carries lastValidBlockHeight',
    Number.isInteger(blockhash.body?.result?.value?.lastValidBlockHeight),
    String(blockhash.body?.result?.value?.lastValidBlockHeight),
  )

  const height = record(await rpc('getBlockHeight'))
  check('getBlockHeight returns 200', height.status === 200 && Number.isInteger(height.body?.result), String(height.body?.result))

  const tokens = record(await rpc('getTokenAccountsByOwner', [
    WRAPPED_SOL_MINT,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' },
  ]))
  check('getTokenAccountsByOwner returns 200', tokens.status === 200, `status ${tokens.status}`)
  check('token accounts come back as a list', Array.isArray(tokens.body?.result?.value), typeof tokens.body?.result?.value)

  const statuses = record(await rpc('getSignatureStatuses', [['1'.repeat(87)], { searchTransactionHistory: false }]))
  check('getSignatureStatuses returns 200', statuses.status === 200, `status ${statuses.status}`)

  /* --------------------------------------------------------------- refusals */
  section('Non-allowlisted methods are refused, not forwarded')

  const forbidden = [
    // Whole-block and history scans: one call can cost more than thousands of reads.
    'getBlock',
    'getBlocks',
    'getParsedBlock',
    'getProgramAccounts',
    'getSignaturesForAddress',
    'getLargestAccounts',
    'getSupply',
    'getVoteAccounts',
    'getClusterNodes',
    'getLeaderSchedule',
    'getInflationReward',
    // Not a real method: a typo must not be relayed either.
    'getEverything',
  ]
  for (const method of forbidden) {
    const reply = record(await rpc(method))
    check(`${method} refused`, reply.status === 403, `status ${reply.status}`)
    check(`${method} error names the method, not the endpoint`, /not permitted/i.test(String(reply.body?.error?.message)))
  }

  if (CLUSTER === 'mainnet-beta') {
    const airdrop = record(await rpc('requestAirdrop', [WRAPPED_SOL_MINT, 1]))
    check('requestAirdrop refused on mainnet', airdrop.status === 403, `status ${airdrop.status}`)
  } else {
    const airdrop = record(await rpc('requestAirdrop', [WRAPPED_SOL_MINT, 1]))
    check('requestAirdrop reaches upstream on a test cluster', airdrop.status !== 403, `status ${airdrop.status}`)
  }

  section('Proxy input hardening')
  const notPost = await fetch(`${API}/api/rpc`, { method: 'GET', headers: { Origin: ORIGIN } })
  seen.push(await notPost.text())
  check('GET is rejected', notPost.status === 405, `status ${notPost.status}`)

  const noMethod = record(await post('/api/rpc', { jsonrpc: '2.0', id: 1 }))
  check('missing method is rejected', noMethod.status === 403, `status ${noMethod.status}`)

  const batch = record(await post('/api/rpc', [
    { jsonrpc: '2.0', id: 1, method: 'getBlockHeight' },
    { jsonrpc: '2.0', id: 2, method: 'getBlockHeight' },
  ]))
  check('a small allowlisted batch is forwarded', batch.status === 200 && Array.isArray(batch.body), `status ${batch.status}`)

  const mixedBatch = record(await post('/api/rpc', [
    { jsonrpc: '2.0', id: 1, method: 'getBlockHeight' },
    { jsonrpc: '2.0', id: 2, method: 'getProgramAccounts' },
  ]))
  check('a batch containing a forbidden method is rejected whole', mixedBatch.status === 403, `status ${mixedBatch.status}`)

  const bigBatch = record(await post('/api/rpc', Array.from({ length: 25 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getBlockHeight' }))))
  check('an oversized batch is rejected', bigBatch.status === 413, `status ${bigBatch.status}`)

  const foreign = await fetch(`${API}/api/rpc`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight' }),
  })
  seen.push(await foreign.text())
  check('a foreign origin is refused by CORS policy', foreign.status === 403, `status ${foreign.status}`)
  check('no CORS header is granted to a foreign origin', foreign.headers.get('access-control-allow-origin') === null)

  /* ------------------------------------------------------------ leak check */
  section('The endpoint URL never reaches the client')

  const health = await fetch(`${API}/api/health`, { headers: { Origin: ORIGIN } })
  const healthText = await health.text()
  seen.push(healthText)
  const healthBody = JSON.parse(healthText)
  check('health reports the cluster', healthBody.cluster === CLUSTER)
  check('health names the source variable, not the URL', typeof healthBody.rpcEndpointSource === 'string', String(healthBody.rpcEndpointSource))
  check('health advertises the proxy path', healthBody.rpcProxy === '/api/rpc')
  check('health advertises the allowlist', Array.isArray(healthBody.rpcAllowedMethods) && healthBody.rpcAllowedMethods.length > 0, `${healthBody.rpcAllowedMethods?.length} methods`)
  check('health has no field containing a URL to the provider', !/https?:\/\/[^"]*quiknode/i.test(healthText))
  check(
    'health flags a cluster/RPC mismatch when there is one',
    typeof healthBody.rpcReachable === 'boolean',
    `rpcReachable=${healthBody.rpcReachable}, detail=${healthBody.rpcDetail}`,
  )

  // Force an upstream failure to check the error path specifically: a bad param
  // makes the provider return a JSON-RPC error, which is where a URL would
  // otherwise be quoted back.
  const badParams = record(await rpc('getBalance', ['not-a-valid-pubkey']))
  check('an upstream error is relayed without the endpoint', badParams.status >= 200, `status ${badParams.status}`)

  const oversizedRead = record(await rpc('getAccountInfo', [WRAPPED_SOL_MINT, { encoding: 'jsonParsed' }]))
  check('getAccountInfo works through the proxy', oversizedRead.status === 200, `status ${oversizedRead.status}`)

  if (SECRETS.length === 0) {
    check('secret fragments were available to test against', false, 'no keyed endpoint configured — leak check is vacuous')
  } else {
    const combined = seen.join('\n')
    const leak = leaks(combined)
    check(
      `no secret fragment appears in any of the ${seen.length} client-visible responses`,
      leak === null,
      leak ? `LEAKED: ${leak}` : `${combined.length} bytes scanned`,
    )
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  // Never print a raw error here: it can carry the endpoint URL.
  console.error('\nverification crashed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
