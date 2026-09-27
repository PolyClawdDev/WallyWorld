/* ------------------------------------------------------------------ *
 * Cluster facts shared by the browser and the server.
 *
 * No provider URL or API key appears here. The only endpoints named are
 * the public Solana-operated ones, which are appropriate for devnet and
 * testnet and explicitly not for mainnet application traffic.
 *
 * The genesis hashes were read from the live clusters and are used to
 * detect a cluster/RPC mismatch, so a mainnet endpoint configured behind
 * a devnet label cannot masquerade as test funds.
 * ------------------------------------------------------------------ */

export type Cluster = 'devnet' | 'testnet' | 'mainnet-beta'

export const CLUSTERS: readonly Cluster[] = ['devnet', 'testnet', 'mainnet-beta']

export const PUBLIC_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
}

export const GENESIS_HASH: Record<Cluster, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
}

/**
 * Devnet unless a valid cluster is named. `mainnet` is accepted as a shorthand
 * for `mainnet-beta` so that an operator who believes they opted into mainnet
 * is never silently dropped onto devnet — and vice versa, an unrecognised value
 * lands on devnet rather than on real funds.
 */
export function normaliseCluster(raw: string | undefined | null): Cluster {
  const value = (raw ?? '').trim()
  if (!value) return 'devnet'
  const candidate = value === 'mainnet' ? 'mainnet-beta' : value
  return (CLUSTERS as readonly string[]).includes(candidate) ? (candidate as Cluster) : 'devnet'
}

/** CAIP-2 style chain id, as used by the Sign-In With Solana convention. */
export const chainIdFor = (cluster: Cluster) => `solana:${cluster === 'mainnet-beta' ? 'mainnet' : cluster}`
