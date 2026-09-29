/* ------------------------------------------------------------------ *
 * Read-only RPC access: connection, cluster identity check, and balances.
 *
 * Every amount leaves this module as a bigint of base units. The one
 * place a JS number crosses the boundary is `getBalance`, which the RPC
 * returns as a JSON number; lamport balances are exact integers well
 * below 2^53, so the conversion is lossless, and it happens immediately
 * so that no arithmetic is ever performed on the number form. SPL token
 * amounts arrive as decimal strings and go straight into BigInt, with
 * the float `uiAmount` field ignored entirely.
 *
 * What the running client actually calls is `verifyCluster`, from
 * `clientStatus.ts`, so the panel can say when the endpoint behind the
 * proxy serves a different chain from the one this build names. The
 * balance readers are reached only by `scripts/verify-solana.ts` now: the
 * on-screen balance view went with Phantom, and no block in the panel
 * displays an amount. They are kept because the proxy allowlists exactly
 * these calls and the script is what proves that end of it still works.
 * ------------------------------------------------------------------ */

import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { GENESIS_HASH } from '../shared/clusters'
import { CLUSTER, RPC } from './cluster'

let connection: Connection | null = null

/**
 * Throws when the RPC is misconfigured, so callers surface it instead of
 * half-working.
 *
 * `disableRetryOnRateLimit` is left at its default, but no websocket endpoint is
 * configured: the proxy speaks HTTP JSON-RPC only, and nothing in this app uses
 * subscriptions — confirmation is polled in `payments.ts` precisely so that no
 * websocket is needed and every call is one the proxy can allowlist.
 */
export function getConnection(): Connection {
  if (!RPC.ok) throw new Error(RPC.problem)
  if (!connection) connection = new Connection(RPC.endpoint, 'confirmed')
  return connection
}

export type ClusterCheck =
  | { status: 'ok' }
  | { status: 'mismatch'; expected: string; actual: string }
  | { status: 'unreachable'; detail: string }

let clusterCheck: Promise<ClusterCheck> | null = null

/** Cached for the page lifetime: the genesis hash of a cluster does not change. */
export function verifyCluster(): Promise<ClusterCheck> {
  if (!clusterCheck) {
    clusterCheck = (async (): Promise<ClusterCheck> => {
      try {
        const actual = await getConnection().getGenesisHash()
        const expected = GENESIS_HASH[CLUSTER]
        return actual === expected ? { status: 'ok' } : { status: 'mismatch', expected, actual }
      } catch (error) {
        return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
      }
    })()
  }
  return clusterCheck
}

/** Integer lamports. */
export async function fetchSolLamports(address: string): Promise<bigint> {
  const lamports = await getConnection().getBalance(new PublicKey(address), 'confirmed')
  if (!Number.isInteger(lamports)) throw new Error('RPC returned a non-integer lamport balance')
  return BigInt(lamports)
}

export type TokenHolding = {
  /** Mint address. Shown as-is: resolving a symbol needs a metadata source this build does not have. */
  mint: string
  /** Raw integer base units, parsed from the RPC's decimal string. */
  amount: bigint
  decimals: number
  /** Which token program the account belongs to, since wallets hold both. */
  program: 'token' | 'token-2022'
}

type ParsedTokenInfo = {
  mint?: unknown
  tokenAmount?: { amount?: unknown; decimals?: unknown }
}

/**
 * Reads the SPL token accounts the wallet actually holds, across both the
 * original token program and Token-2022. Zero balances are dropped, and
 * accounts whose parsed shape is not what we expect are skipped rather than
 * guessed at.
 */
export async function fetchTokenHoldings(address: string): Promise<TokenHolding[]> {
  const owner = new PublicKey(address)
  const conn = getConnection()
  const programs: ReadonlyArray<[TokenHolding['program'], PublicKey]> = [
    ['token', TOKEN_PROGRAM_ID],
    ['token-2022', TOKEN_2022_PROGRAM_ID],
  ]

  const results = await Promise.all(
    programs.map(async ([program, programId]) => {
      // A cluster without Token-2022 accounts simply returns an empty list, but a
      // provider that rejects the second call should not blank out the first.
      try {
        const { value } = await conn.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed')
        return value.flatMap<TokenHolding>(entry => {
          const info = (entry.account.data.parsed?.info ?? {}) as ParsedTokenInfo
          const mint = info.mint
          const raw = info.tokenAmount?.amount
          const decimals = info.tokenAmount?.decimals
          if (typeof mint !== 'string' || typeof raw !== 'string' || typeof decimals !== 'number') return []
          if (!/^\d+$/.test(raw)) return []
          const amount = BigInt(raw)
          if (amount === 0n) return []
          return [{ mint, amount, decimals, program }]
        })
      } catch {
        return []
      }
    }),
  )

  return results
    .flat()
    .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0))
}

/** Rejects malformed input before it reaches a transaction builder. */
export function isValidAddress(value: string): boolean {
  try {
    // PublicKey accepts any 32-byte base58 string; it is a format check, not proof
    // that an account exists on chain.
    new PublicKey(value)
    return true
  } catch {
    return false
  }
}
