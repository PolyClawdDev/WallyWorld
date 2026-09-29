/* ------------------------------------------------------------------ *
 * Wallet and session state for the whole app.
 *
 * A module singleton rather than component state, because the pouch panel
 * mounts and unmounts as the player opens and closes it, and a connection
 * must not drop when a popup closes. The network badge in the HUD reads
 * the same store, so the badge and the panel can never disagree about
 * whether real funds are in play.
 *
 * This module can ask Phantom to connect, to sign a sign-in message, and
 * to sign and send a transfer the user has approved. It holds no key
 * material and there is no code path here that could produce one.
 * ------------------------------------------------------------------ */

import { useEffect, useSyncExternalStore } from 'react'
import bs58 from 'bs58'
import { buildSiwsMessage, checkSiwsFields } from '../shared/siws'
import type { Profile } from '../shared/profile'
import { CHAIN_ID, CLUSTER, RPC } from './cluster'
import {
  ApiError,
  clearSession,
  fetchProfile,
  loadSession,
  logout,
  probeApi,
  requestChallenge,
  saveProfile as putProfile,
  saveSession,
  submitSignature,
} from './api'
import { describeWalletError, getPhantom, isUserRejection, onPhantomEvent, waitForPhantom, type PhantomProvider } from './phantom'
import { fetchSolLamports, fetchTokenHoldings, verifyCluster, type ClusterCheck, type TokenHolding } from './rpc'

export type PhantomAvailability = 'checking' | 'missing' | 'ready'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

export type WalletState = {
  phantom: PhantomAvailability
  status: ConnectionStatus
  address: string | null
  /** Integer lamports. Null until a balance has been read. */
  lamports: bigint | null
  tokens: TokenHolding[]
  balancesLoading: boolean
  balanceError: string | null
  clusterCheck: ClusterCheck | null
  /** Set when the RPC itself is misconfigured, e.g. mainnet without a provider URL. */
  configError: string | null
  /**
   * Set when the origin the client addresses is not serving the Voxels API at
   * all. Distinct from `configError`, which is about the RPC settings: this one
   * means the request never reached this project.
   */
  apiError: string | null
  /** Present only after a verified wallet signature. */
  session: { wallet: string; token: string } | null
  signingIn: boolean
  profile: Profile | null
  profileSyncing: boolean
  profileSavedAtMs: number | null
  error: string | null
}

const initial: WalletState = {
  phantom: 'checking',
  status: 'disconnected',
  address: null,
  lamports: null,
  tokens: [],
  balancesLoading: false,
  balanceError: null,
  clusterCheck: null,
  configError: RPC.ok ? null : RPC.problem,
  apiError: null,
  session: null,
  signingIn: false,
  profile: null,
  profileSyncing: false,
  profileSavedAtMs: null,
  error: null,
}

let state = initial
const listeners = new Set<() => void>()

function set(patch: Partial<WalletState>) {
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
 * Subscribes a component to wallet state, and starts detection on first use.
 *
 * Bootstrapping from here rather than from `main.tsx` means every consumer —
 * the HUD badge and the pouch panel alike — gets a live store without the game
 * shell having to remember to initialise anything.
 */
export function useWallet(): WalletState {
  const snapshot = useSyncExternalStore(subscribe, getState, getState)
  useEffect(() => {
    void initWallet()
  }, [])
  return snapshot
}

export const walletStore = { subscribe, getState }

/* ------------------------------------------------------------------ setup */

let provider: PhantomProvider | null = null
let detachEvents: Array<() => void> = []
let initialised = false

/**
 * Drops everything tied to a specific wallet. A session proves control of one
 * address, so switching or disconnecting accounts must invalidate it rather than
 * carry it over to the new one.
 */
function forgetWallet(patch: Partial<WalletState> = {}) {
  clearSession()
  set({
    status: 'disconnected',
    address: null,
    lamports: null,
    tokens: [],
    balanceError: null,
    session: null,
    profile: null,
    profileSavedAtMs: null,
    ...patch,
  })
}

function attachEvents(target: PhantomProvider) {
  detachEvents.forEach(off => off())
  detachEvents = [
    onPhantomEvent(target, 'connect', () => {
      const address = target.publicKey?.toBase58() ?? null
      if (address) {
        set({ status: 'connected', address, error: null })
        void refreshBalances()
      }
    }),
    onPhantomEvent(target, 'disconnect', () => {
      forgetWallet()
    }),
    onPhantomEvent(target, 'accountChanged', payload => {
      // Phantom passes the new public key, or nothing when the user switched to
      // an account that has not authorised this site.
      const next =
        payload && typeof payload === 'object' && 'toBase58' in payload
          ? (payload as { toBase58(): string }).toBase58()
          : (target.publicKey?.toBase58() ?? null)
      if (!next) {
        forgetWallet({ error: 'Phantom switched to an account that is not connected to this site.' })
        return
      }
      if (next === state.address) return
      // The old session belongs to the old address and is discarded, not reused.
      forgetWallet()
      set({ status: 'connected', address: next })
      void refreshBalances()
    }),
  ]
}

/**
 * Called once on import. Detects Phantom, checks the cluster the RPC really
 * serves, and reconnects silently if the user has already trusted this site.
 */
export async function initWallet(): Promise<void> {
  if (initialised) return
  initialised = true

  // Identify the API before any chain read is attempted. A page served from a
  // static host answers `/api/rpc` with its own 404 page, and web3.js would
  // surface that as a bare `404 : …` that reads like a wallet fault. Naming the
  // URL that was tried is the difference between a dead end and a fix.
  if (RPC.ok) {
    void probeApi().then(probe => {
      if (!probe.ok) {
        set({ apiError: probe.detail })
        return
      }
      void verifyCluster().then(clusterCheck => set({ clusterCheck }))
    })
  }

  const found = await waitForPhantom()
  if (!found) {
    set({ phantom: 'missing' })
    return
  }
  provider = found
  set({ phantom: 'ready' })
  attachEvents(found)

  // onlyIfTrusted reconnects without a prompt for a site the user already
  // approved, and does nothing otherwise. It never opens a dialog.
  try {
    const { publicKey } = await found.connect({ onlyIfTrusted: true })
    const address = publicKey?.toBase58() ?? null
    if (address) {
      set({ status: 'connected', address })
      await restoreSession(address)
      void refreshBalances()
    }
  } catch {
    /* not previously trusted: stay disconnected and wait for an explicit connect */
  }
}

/** Reuses a stored session only if it belongs to the wallet that is actually connected. */
async function restoreSession(address: string): Promise<void> {
  const stored = loadSession()
  if (!stored || stored.wallet !== address) {
    if (stored) clearSession()
    return
  }
  try {
    const { profile } = await fetchProfile(stored.token)
    set({ session: { wallet: stored.wallet, token: stored.token }, profile })
  } catch (error) {
    if (error instanceof ApiError && error.needsSignIn) clearSession()
    // A server that is simply not running must not wipe a valid session.
  }
}

/* --------------------------------------------------------------- actions */

export async function connect(): Promise<void> {
  const target = provider ?? getPhantom()
  if (!target) {
    set({ phantom: 'missing', error: 'Phantom was not detected in this browser.' })
    return
  }
  provider = target
  attachEvents(target)
  set({ status: 'connecting', error: null })
  try {
    const { publicKey } = await target.connect()
    const address = publicKey?.toBase58() ?? null
    if (!address) throw new Error('Phantom connected without returning an address.')
    set({ status: 'connected', address, error: null })
    await restoreSession(address)
    void refreshBalances()
  } catch (error) {
    set({ status: 'disconnected', error: describeWalletError(error) })
  }
}

export async function disconnect(): Promise<void> {
  const token = state.session?.token
  // Best effort: revoke server-side first so the token is dead even if the
  // extension call fails.
  if (token) {
    try {
      await logout(token)
    } catch {
      /* the session still expires on its own */
    }
  }
  try {
    await provider?.disconnect()
  } catch {
    /* Phantom may already consider the site disconnected */
  }
  forgetWallet()
}

export async function refreshBalances(): Promise<void> {
  const address = state.address
  if (!address || !RPC.ok) return
  set({ balancesLoading: true, balanceError: null })
  try {
    // One await pair so a token-account failure cannot blank the SOL balance.
    const [lamports, tokens] = await Promise.all([fetchSolLamports(address), fetchTokenHoldings(address)])
    set({ lamports, tokens, balancesLoading: false, balanceError: null })
  } catch (error) {
    set({ balancesLoading: false, balanceError: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Sign-In With Solana.
 *
 * The server issues a single-use, expiring nonce. This function rebuilds the
 * message text locally from those fields — after checking them against the
 * running page — and asks Phantom to sign that text. It is plain UTF-8, not a
 * transaction, so approving it cannot move anything.
 */
export async function signIn(): Promise<void> {
  const target = provider ?? getPhantom()
  const address = state.address
  if (!target || !address) {
    set({ error: 'Connect Phantom before signing in.' })
    return
  }
  set({ signingIn: true, error: null })
  try {
    const { challenge } = await requestChallenge(address)

    // Guard against a challenge that is not for this site, this wallet, or this
    // cluster before anything is put in front of the user to approve.
    const checked = checkSiwsFields(challenge, {
      domain: window.location.host,
      uri: window.location.origin,
      address,
      chainId: CHAIN_ID,
    })
    if (!checked.ok) throw new Error(`Refused to sign: ${checked.reason}`)

    const message = buildSiwsMessage(checked.fields)
    const { signature } = await target.signMessage(new TextEncoder().encode(message), 'utf8')

    // Phantom hands back raw bytes; the server expects base58, matching how
    // Solana signatures are represented everywhere else.
    const result = await submitSignature(address, checked.fields.nonce, bs58.encode(signature))

    saveSession({ token: result.token, wallet: result.wallet, expiresAtMs: result.expiresAtMs })
    set({
      session: { wallet: result.wallet, token: result.token },
      profile: result.profile,
      signingIn: false,
      error: null,
    })
  } catch (error) {
    const message = error instanceof ApiError ? error.message : describeWalletError(error)
    set({ signingIn: false, error: isUserRejection(error) ? 'Sign-in cancelled in Phantom.' : message })
  }
}

export async function signOut(): Promise<void> {
  const token = state.session?.token
  if (token) {
    try {
      await logout(token)
    } catch {
      /* it expires anyway */
    }
  }
  clearSession()
  set({ session: null, profile: null, profileSavedAtMs: null })
}

/** Persists the player record for the signed-in wallet. */
export async function persistProfile(profile: Profile): Promise<boolean> {
  const session = state.session
  if (!session) return false
  set({ profileSyncing: true, error: null })
  try {
    const result = await putProfile(session.token, profile)
    set({ profile: result.profile, profileSyncing: false, profileSavedAtMs: result.updatedAtMs })
    return true
  } catch (error) {
    if (error instanceof ApiError && error.needsSignIn) {
      clearSession()
      set({ session: null, profileSyncing: false, error: 'Session expired. Sign in again to keep saving.' })
      return false
    }
    set({ profileSyncing: false, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export const getProvider = () => provider
export const currentCluster = CLUSTER
