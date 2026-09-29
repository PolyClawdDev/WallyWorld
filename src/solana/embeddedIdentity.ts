/* ------------------------------------------------------------------ *
 * Turning the embedded wallet into one real server-side account.
 *
 * This is deliberately NOT a second authentication path. It drives the
 * claim flow that already exists — `POST /api/account/claim/challenge`
 * then `POST /api/account/claim/verify` — and the server's rules are
 * untouched by it: the challenge is server-issued,
 * single-use, expiring, bound to the domain, the wallet and the session
 * hash, and the bytes the server verifies are rebuilt from its own stored
 * row rather than from anything sent here.
 *
 * What the embedded wallet changes is *coverage*. Before, only a player
 * with a browser extension installed could produce a signature, so a guest
 * stayed a guest. Now every player has a key, so every player can prove
 * ownership of one address on first entry and the account they build is a
 * claimed one from the start. It is also the only signing path left: there
 * is no extension to connect to any more.
 *
 * Three things this does not do, on purpose:
 *
 *   - it does not resolve a conflict. If the address already belongs to
 *     another account the server offers "switch" or "merge" and this
 *     module stops and reports it, because picking one for the player
 *     would be picking which of their accounts to retire;
 *   - it does not sign anything it has not checked. The challenge fields
 *     are validated against the running page — host, origin, address,
 *     chain, and the link statement specifically — before the key is
 *     used;
 *   - it does not send the secret key. What crosses the network is a
 *     public address and a 64-byte signature.
 * ------------------------------------------------------------------ */

import bs58 from 'bs58'
import { buildSiwsMessage, checkSiwsFields, LINK_STATEMENT, type SiwsFields } from '../shared/siws'
import { API_BASE_URL, CHAIN_ID } from './cluster'
import { ensureEmbeddedWallet, signWithEmbeddedWallet } from './embeddedWallet'
import { resolvePresenceAuth } from '../pvp/guest'

export type ClaimState =
  | { phase: 'idle' }
  | { phase: 'working' }
  /** The wallet is attached to this browser's one account. */
  | { phase: 'linked'; address: string; accountId: string; alreadyLinked: boolean }
  /** The address belongs to another account. The player has to choose. */
  | { phase: 'conflict'; address: string; detail: string }
  | { phase: 'failed'; detail: string }

let state: ClaimState = { phase: 'idle' }
const listeners = new Set<() => void>()

function set(next: ClaimState) {
  state = next
  listeners.forEach(listener => listener())
}

export const embeddedClaimState = () => state

export function subscribeEmbeddedClaim(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

type AccountView = { accountId?: string; linkedWallets?: Array<{ wallet: string }> }

async function json(path: string, token: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined
      ? { Authorization: `Bearer ${token}` }
      : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: (parsed ?? {}) as Record<string, unknown> }
}

let running: Promise<ClaimState> | null = null

/**
 * Makes sure this browser's embedded wallet is linked to its account.
 *
 * Deduplicated, because the world mounts this alongside the presence socket and
 * two challenges for one session would leave an unconsumed nonce behind.
 */
export function claimAccountWithEmbeddedWallet(): Promise<ClaimState> {
  if (running) return running
  running = run().finally(() => {
    running = null
  })
  return running
}

async function run(): Promise<ClaimState> {
  set({ phase: 'working' })

  const wallet = ensureEmbeddedWallet()
  const auth = await resolvePresenceAuth()
  if (!auth) {
    set({ phase: 'failed', detail: 'No session with the Voxels server yet, so there is no account to attach this wallet to.' })
    return state
  }

  // Cheapest correct answer first: if the server already lists this address
  // against this account there is nothing to prove and no nonce to spend.
  try {
    const existing = await json('/api/account', auth.token)
    if (existing.status === 200) {
      const view = existing.body as AccountView
      const already = (view.linkedWallets ?? []).some(entry => entry.wallet === wallet.address)
      if (already && typeof view.accountId === 'string') {
        set({ phase: 'linked', address: wallet.address, accountId: view.accountId, alreadyLinked: true })
        return state
      }
    }
  } catch {
    /* fall through to the full claim; a failure here is not authoritative */
  }

  let challenge: SiwsFields
  try {
    const issued = await json('/api/account/claim/challenge', auth.token, { publicKey: wallet.address })
    if (issued.status !== 201) {
      set({ phase: 'failed', detail: describe(issued, 'The server would not issue a link challenge.') })
      return state
    }
    challenge = issued.body.challenge as SiwsFields
  } catch (error) {
    set({ phase: 'failed', detail: `Could not reach the Voxels server to ask for a link challenge (${message(error)}).` })
    return state
  }

  // Checked against the running page before the key is used. `statement` is
  // pinned to the link wording, so a sign-in challenge handed back here would
  // be refused rather than signed.
  const checked = checkSiwsFields(challenge, {
    domain: window.location.host,
    uri: window.location.origin,
    address: wallet.address,
    chainId: CHAIN_ID,
    statement: LINK_STATEMENT,
  })
  if (!checked.ok) {
    set({ phase: 'failed', detail: `Refused to sign the link challenge: ${checked.reason}` })
    return state
  }

  const signature = bs58.encode(signWithEmbeddedWallet(new TextEncoder().encode(buildSiwsMessage(checked.fields))))

  try {
    const verified = await json('/api/account/claim/verify', auth.token, {
      publicKey: wallet.address,
      nonce: checked.fields.nonce,
      signature,
    })
    if (verified.status === 409) {
      set({
        phase: 'conflict',
        address: wallet.address,
        detail:
          typeof verified.body.detail === 'string'
            ? verified.body.detail
            : 'This wallet already belongs to another Voxels account.',
      })
      return state
    }
    if (verified.status !== 200 || verified.body.linked !== true) {
      set({ phase: 'failed', detail: describe(verified, 'The server did not accept the link signature.') })
      return state
    }
    set({
      phase: 'linked',
      address: wallet.address,
      accountId: String(verified.body.accountId ?? ''),
      alreadyLinked: verified.body.alreadyLinked === true,
    })
    return state
  } catch (error) {
    set({ phase: 'failed', detail: `Could not reach the Voxels server to finish linking (${message(error)}).` })
    return state
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function describe(response: { status: number; body: Record<string, unknown> }, fallback: string): string {
  const detail = response.body.detail ?? response.body.error
  return typeof detail === 'string' ? `${fallback} (${response.status}: ${detail})` : `${fallback} (${response.status}).`
}
