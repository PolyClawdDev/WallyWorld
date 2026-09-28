/* ------------------------------------------------------------------ *
 * Live read-only provider probes.
 *
 *   npm run probe:providers
 *
 * Every request here is a read or a dry run. Nothing is signed, no deposit
 * address is requested, and no funds move. The HTTP status of each call is
 * printed because the status *is* the finding — particularly for the 1Click
 * recipient validator, where a 200 and a 400 are the whole experiment.
 *
 * The central probe is the shielded-ZEC trap. 1Click's documentation says Zcash
 * is transparent-only; a prior audit found its quote endpoint nonetheless prices
 * shielded-only unified addresses. This script re-runs that test against the
 * official ZIP-316 vectors and reports the disagreement, so the finding is a
 * fresh observation rather than a remembered one.
 * ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
  ApiError,
} from '@defuse-protocol/one-click-sdk-typescript'
import { quoteSolToUsdc } from '../src/server/providers/jupiter'
import {
  ZEC_DOCUMENTED_SUPPORT,
  ZEC_NATIVE_ASSET_ID,
  classifyZecDelivery,
  configureOneClickAuth,
  discoverZecAsset,
} from '../src/server/providers/oneclick'
import { parseZcashAddress } from '../src/server/providers/zcashAddress'

const here = dirname(fileURLToPath(import.meta.url))
const vectorCache = join(here, '.fixtures', 'zip316-unified-address-vectors.json')

type Row = [string | null, string | null, string | null, string | null, number | null, string | null, string, string, number, number]

function vectors(): Row[] {
  return (JSON.parse(readFileSync(vectorCache, 'utf8')) as unknown[]).slice(2) as Row[]
}

/** A real mainnet t-address, derived from a vector's own key hash. */
function transparentAddress(rows: Row[]): string {
  const keyHash = rows.find(row => row[0])?.[0]
  if (!keyHash) throw new Error('no p2pkh vector available')
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.from(keyHash, 'hex')])
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4)
  return bs58.encode(Buffer.concat([payload, checksum]))
}

/* ------------------------------------------------------------------ *
 * A raw dry quote, so the HTTP status is visible on rejection too.
 * ------------------------------------------------------------------ */

interface QuoteProbe {
  readonly label: string
  readonly recipient: string
  readonly status: number | null
  readonly accepted: boolean
  readonly amountOut: string | null
  readonly error: string | null
}

async function dryQuoteProbe(input: {
  label: string
  originAsset: string
  recipient: string
  refundTo: string
  amount: string
}): Promise<QuoteProbe> {
  try {
    const response = await OneClickService.getQuote({
      dry: true,
      swapType: QuoteRequest.swapType.EXACT_INPUT,
      slippageTolerance: 100,
      originAsset: input.originAsset,
      depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
      destinationAsset: ZEC_NATIVE_ASSET_ID,
      amount: input.amount,
      refundTo: input.refundTo,
      refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
      recipient: input.recipient,
      recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    })
    if (response.quote.depositAddress) {
      throw new Error('a dry quote returned a deposit address — aborting')
    }
    return {
      label: input.label,
      recipient: input.recipient,
      status: 200,
      accepted: true,
      amountOut: response.quote.amountOut,
      error: null,
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? {})
      return {
        label: input.label,
        recipient: input.recipient,
        status: error.status,
        accepted: false,
        amountOut: null,
        error: body.slice(0, 160),
      }
    }
    return {
      label: input.label,
      recipient: input.recipient,
      status: null,
      accepted: false,
      amountOut: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const short = (address: string) => `${address.slice(0, 14)}…${address.slice(-6)}`

/**
 * A format-valid Solana address used as the `refundTo` placeholder.
 *
 * It must be format-valid or 1Click rejects the request on `refundTo` and never
 * reaches the recipient validator — which is the thing being tested, so a
 * rejection there would look like a result and be nothing of the kind. Derived
 * from a fixed string so it is reproducible, and it is 32 bytes of hash output,
 * so no key for it exists. No funds are involved: every quote here is dry.
 */
const REFUND_PLACEHOLDER = bs58.encode(
  createHash('sha256').update('voxels/dry-quote/refund-placeholder').digest(),
)

async function main() {
  console.log('Voxels · live read-only provider probes')
  console.log(`  started     ${new Date().toISOString()}`)
  console.log('  nothing here is signed, funded, or executed')
  console.log('')

  /* ---- Jupiter ---------------------------------------------------------- */

  console.log('── Jupiter Swap API v2 (keyless tier)')
  const jupiter = await quoteSolToUsdc({ lamports: 100_000_000n, slippageBps: 50 })
  if (jupiter.ok) {
    console.log(`  HTTP ${jupiter.quote.httpStatus}  GET /swap/v2/order`)
    console.log(`    in           ${jupiter.quote.inAmountBaseUnits} lamports (0.1 SOL)`)
    console.log(`    out          ${jupiter.quote.outAmountBaseUnits} USDC base units`)
    console.log(`    router       ${jupiter.quote.router}`)
    console.log('    signed?      no — no taker was supplied, so no transaction was assembled')
  } else {
    console.log(`  FAILED  ${jupiter.reason}: ${jupiter.detail}`)
  }
  console.log('  test network   none. Jupiter publishes no devnet or testnet swap endpoint.')
  console.log('')

  /* ---- 1Click discovery ------------------------------------------------- */

  console.log('── NEAR Intents 1Click asset discovery')
  const auth = configureOneClickAuth()
  console.log(`  base         ${OpenAPI.BASE}`)
  console.log(`  auth         ${auth.authenticated ? 'partner JWT present' : 'unauthenticated (documented to work, 0.2% surcharge)'}`)

  const discovery = await discoverZecAsset()
  if (!discovery.ok) {
    console.log(`  FAILED  ${discovery.reason}: ${discovery.detail}`)
    process.exit(1)
  }
  const finding = discovery.finding
  console.log(`  HTTP ${finding.httpStatus}  GET /v0/tokens`)
  console.log(`    assets       ${finding.totalAssets}`)
  console.log(
    finding.native
      ? `    native ZEC   ${finding.native.assetId}  blockchain="${finding.native.blockchain}"  ${finding.native.decimals} decimals`
      : '    native ZEC   ABSENT from the token list',
  )
  console.log(`    wrapped ZEC  ${finding.wrappedElsewhere.map(a => a.blockchain).join(', ') || 'none'} (not the Zcash chain)`)
  console.log(`  documented   "${ZEC_DOCUMENTED_SUPPORT}"`)
  console.log('')

  /* ---- the shielded-ZEC trap ------------------------------------------- */

  console.log('── The shielded-ZEC trap, re-verified (dry quotes only)')

  const rows = vectors()
  const taddr = transparentAddress(rows)

  // Classify vectors by the receiver set they were generated from.
  const shieldedOnly: string[] = []
  const withTransparent: string[] = []
  for (const row of rows) {
    const [p2pkh, p2sh, sapling, orchard] = row
    const shielded = Boolean(sapling || orchard)
    const transparent = Boolean(p2pkh || p2sh)
    if (shielded && !transparent && shieldedOnly.length < 5) shieldedOnly.push(row[6])
    if (shielded && transparent && withTransparent.length < 2) withTransparent.push(row[6])
  }

  // A Solana-side origin asset, chosen from the live list rather than hardcoded.
  const tokens = await OneClickService.getTokens()
  const solAsset = tokens.find(token => String(token.blockchain) === 'sol' && token.symbol.toUpperCase() === 'SOL')
  if (!solAsset) {
    console.log('  no native SOL asset in the live token list; cannot probe the SOL to ZEC pair')
    process.exit(1)
  }
  console.log(`  origin       ${solAsset.assetId} (SOL on Solana, ${solAsset.decimals} decimals)`)
  console.log(`  refundTo     ${REFUND_PLACEHOLDER} (derived placeholder, no key exists; dry quotes only)`)
  console.log('')

  const probes: QuoteProbe[] = []
  probes.push(
    await dryQuoteProbe({
      label: 'transparent t1 (documented as supported)',
      originAsset: solAsset.assetId,
      recipient: taddr,
      refundTo: REFUND_PLACEHOLDER,
      amount: '100000000',
    }),
  )
  for (const [index, address] of shieldedOnly.entries()) {
    probes.push(
      await dryQuoteProbe({
        label: `shielded-only UA #${index + 1} (ZIP-316 vector, no transparent receiver)`,
        originAsset: solAsset.assetId,
        recipient: address,
        refundTo: REFUND_PLACEHOLDER,
        amount: '100000000',
      }),
    )
  }
  for (const [index, address] of withTransparent.entries()) {
    probes.push(
      await dryQuoteProbe({
        label: `UA with transparent receiver #${index + 1}`,
        originAsset: solAsset.assetId,
        recipient: address,
        refundTo: REFUND_PLACEHOLDER,
        amount: '100000000',
      }),
    )
  }
  probes.push(
    await dryQuoteProbe({
      label: 'malformed unified address',
      originAsset: solAsset.assetId,
      recipient: 'u1thisisnotavalidunifiedaddressatall',
      refundTo: REFUND_PLACEHOLDER,
      amount: '100000000',
    }),
  )

  for (const result of probes) {
    const status = result.status === null ? 'no response' : `HTTP ${result.status}`
    console.log(`  ${result.accepted ? 'ACCEPTED' : 'rejected'}  ${status.padEnd(9)}  ${result.label}`)
    console.log(`            recipient ${short(result.recipient)}`)
    if (result.amountOut) console.log(`            amountOut ${result.amountOut} zatoshis`)
    if (result.error) console.log(`            body      ${result.error}`)
  }
  console.log('')

  /* ---- the verdict ----------------------------------------------------- */

  const shieldedProbes = probes.filter(probe => probe.label.startsWith('shielded-only'))
  const shieldedAccepted = shieldedProbes.filter(probe => probe.accepted)

  const firstShielded = shieldedOnly[0]
  const parsed = firstShielded ? await parseZcashAddress(firstShielded, 'main') : null
  const assessment = classifyZecDelivery({
    recipient: firstShielded ?? '',
    parsedReceivers: parsed?.ok ? parsed.parsed.receivers : [],
    quoteAccepted: shieldedAccepted.length > 0,
    quoteHttpStatus: shieldedProbes[0]?.status ?? null,
  })

  console.log('── Verdict')
  console.log(`  shielded-only UAs priced       ${shieldedAccepted.length}/${shieldedProbes.length}`)
  console.log(`  parsed receivers of first      [${assessment.parsedReceivers.join(', ')}]`)
  console.log(`  documented support             "${assessment.documentedSupport}"`)
  console.log(`  adapter verdict                ${assessment.verdict}`)
  console.log(`  delivered receiver             ${assessment.deliveredReceiver}`)
  console.log('')
  console.log(`  ${assessment.explanation}`)
  console.log('')
  console.log('  No deposit address was requested. No funds moved. Every quote used dry: true.')
}

main().catch(error => {
  console.error(`FAILED — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
