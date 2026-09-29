/* ------------------------------------------------------------------ *
 * Whether this client is pointed at a working Voxels API and the right
 * chain — and nothing else.
 *
 * This file used to be the Phantom store: provider detection, connect,
 * disconnect, `accountChanged`, the sign-in session, balances and the
 * per-wallet character save. Phantom is gone, so all of that is gone with
 * it. What is left is the part that was never about a wallet at all: three
 * facts the wallet panel has to be able to state before it shows anything
 * else, and which are expensive enough to want checking once per page
 * rather than once per mount.
 *
 *   1. Is the RPC configuration usable at all (`configError`)?
 *   2. Is the origin this client addresses actually serving this project's
 *      API (`apiError`)?
 *   3. Does the chain behind that API serve the cluster this build names
 *      (`clusterCheck`)?
 *
 * A module singleton rather than component state because the pouch panel
 * mounts and unmounts as the player opens and closes it, and the probe
 * must not be re-run on every open.
 *
 * There is no key material here and no signing capability of any kind.
 * The browser-held keypair lives in `embeddedWallet.ts`, signs UTF-8
 * challenges only, and is deliberately not reachable from this module.
 * ------------------------------------------------------------------ */

import { useEffect, useSyncExternalStore } from 'react'
import { RPC } from './cluster'
import { probeApi } from './api'
import { verifyCluster, type ClusterCheck } from './rpc'

export type ClientStatus = {
  clusterCheck: ClusterCheck | null
  /** Set when the RPC itself is misconfigured, e.g. mainnet without a provider URL. */
  configError: string | null
  /**
   * Set when the origin the client addresses is not serving the Voxels API at
   * all. Distinct from `configError`, which is about the RPC settings: this one
   * means the request never reached this project.
   */
  apiError: string | null
}

const initial: ClientStatus = {
  clusterCheck: null,
  configError: RPC.ok ? null : RPC.problem,
  apiError: null,
}

let state = initial
const listeners = new Set<() => void>()

function set(patch: Partial<ClientStatus>) {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}

const getState = () => state

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Subscribes a component to the status, and starts the probe on first use.
 *
 * Bootstrapping from here rather than from `main.tsx` means the panel gets a
 * live answer without the game shell having to remember to initialise
 * anything.
 */
export function useClientStatus(): ClientStatus {
  const snapshot = useSyncExternalStore(subscribe, getState, getState)
  useEffect(() => {
    void initClientStatus()
  }, [])
  return snapshot
}

let initialised = false

/**
 * Identify the API before any chain read is attempted.
 *
 * A page served from a static host answers `/api/rpc` with its own 404 page,
 * and web3.js would surface that as a bare `404 : …` that reads like a wallet
 * fault. Naming the URL that was tried is the difference between a dead end and
 * a fix.
 */
export async function initClientStatus(): Promise<void> {
  if (initialised) return
  initialised = true
  if (!RPC.ok) return

  const probe = await probeApi()
  if (!probe.ok) {
    set({ apiError: probe.detail })
    return
  }
  set({ clusterCheck: await verifyCluster() })
}
