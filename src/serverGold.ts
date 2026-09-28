/* ------------------------------------------------------------------ *
 * The browser's connection to the one authoritative gold balance.
 *
 * Before this existed, hunt gold was a number that only the browser knew,
 * and PvP gold was a different number that only the server knew. This
 * module retires the first of those: when a session can be established,
 * the server's balance is the balance, and the local counter in
 * `rewards.ts` becomes an optimistic display that converges to it.
 *
 * HOW A REWARD BECOMES REAL
 *   1. The server opens a hunt and mints a roster of single-use tokens,
 *      one per animal, each already priced by the server.
 *   2. The browser kills something and spends the matching token.
 *   3. The server credits that token's amount, once, with
 *      `hunt_verified` provenance.
 *
 * WHAT THAT DOES AND DOES NOT PROVE
 *   It proves the amount, the species and the count: a client cannot
 *   invent a reward, name its own price, or claim the same animal twice,
 *   and a session can never pay out more than its roster. It does not
 *   prove a fight happened — combat still runs in the browser. Closing
 *   that gap means simulating wildlife server-side, which is a much
 *   larger change than this one.
 *
 * WHEN THERE IS NO SERVER
 *   Everything still works and nothing is credited. The game is
 *   playable offline; the balance is then local and is labelled as
 *   unverified, because that is what it is.
 * ------------------------------------------------------------------ */

import { API_BASE_URL } from './solana/cluster'
import { resolvePresenceAuth } from './pvp/guest'
import { applyServerGold, markServerUnavailable } from './rewards'

type Token = { tokenId: string; species: string; rewardGold: string }

type Session = {
  huntId: string
  token: string
  /** Unspent tokens, grouped by species, so a kill can find its own price. */
  bySpecies: Map<string, Token[]>
  expiresAtMs: number
  minClaimGapMs: number
}

let session: Session | null = null
let opening: Promise<Session | null> | null = null
let lastClaimAt = 0

const json = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` })

async function post(path: string, token: string, body: unknown): Promise<unknown | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify(body),
    })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

async function readBalance(token: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/gold`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) return
    const body = (await response.json()) as { available?: string; total?: string; redeemable?: string }
    if (typeof body.total === 'string' && typeof body.redeemable === 'string') {
      applyServerGold({ total: Number(body.total), redeemable: Number(body.redeemable) })
    }
  } catch {
    /* leave the last known figure alone rather than showing a zero */
  }
}

/**
 * Opens a hunt, or gives up quietly.
 *
 * Deduplicated through `opening` because the first few kills of a session can
 * arrive before the first request has come back, and two rosters would mean two
 * sets of tokens for one hunt.
 */
export function attachHuntSession(region: string, level: number): Promise<Session | null> {
  if (session && session.expiresAtMs > Date.now() + 30_000) return Promise.resolve(session)
  if (opening) return opening

  opening = (async () => {
    const auth = await resolvePresenceAuth()
    if (!auth) {
      markServerUnavailable('no session')
      return null
    }
    const opened = (await post('/api/hunt/session', auth.token, { region, level })) as
      | { huntId?: string; tokens?: Token[]; expiresAtMs?: number; minClaimGapMs?: number }
      | null
    if (!opened || typeof opened.huntId !== 'string' || !Array.isArray(opened.tokens)) {
      markServerUnavailable('the server did not open a hunt')
      return null
    }
    const bySpecies = new Map<string, Token[]>()
    for (const token of opened.tokens) {
      const list = bySpecies.get(token.species) ?? []
      list.push(token)
      bySpecies.set(token.species, list)
    }
    session = {
      huntId: opened.huntId,
      token: auth.token,
      bySpecies,
      expiresAtMs: opened.expiresAtMs ?? Date.now() + 60 * 60 * 1000,
      minClaimGapMs: opened.minClaimGapMs ?? 400,
    }
    await readBalance(auth.token)
    return session
  })().finally(() => { opening = null })

  return opening
}

/**
 * Spends one token for a killed animal.
 *
 * Fire-and-forget by design: the world has already dropped its coins and the
 * player is already moving. What comes back is the server's balance, which
 * replaces the optimistic one in the HUD.
 *
 * The server rate-limits claims within a hunt, so claims are spaced out here
 * rather than being thrown at it and rejected.
 */
export async function claimKillOnServer(species: string): Promise<void> {
  const live = session ?? (await attachHuntSession('wildwood', 1))
  if (!live) return

  const available = live.bySpecies.get(species)
  const token = available?.pop()
  // No token left for this species means the session has already been paid for
  // every animal of it the server issued. The kill still happened in the world;
  // it simply is not worth anything, and that ceiling is the point.
  if (!token) return

  const wait = live.minClaimGapMs - (Date.now() - lastClaimAt)
  if (wait > 0) await new Promise(resolve => window.setTimeout(resolve, wait + 20))
  lastClaimAt = Date.now()

  const claimed = (await post('/api/hunt/claim', live.token, { huntId: live.huntId, tokenId: token.tokenId })) as
    | { credited?: string; balance?: string }
    | null
  if (!claimed) {
    // Put it back: an unanswered claim may not have been applied, and the token
    // is single-use at the server, so retrying it later is safe.
    available?.push(token)
    return
  }
  await readBalance(live.token)
}

/** Reports a death so the server applies its own forfeit to its own balance. */
export async function reportDeathOnServer(): Promise<void> {
  if (!session) return
  const ref = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  await post('/api/hunt/death', session.token, { huntId: session.huntId, clientRef: ref })
  await readBalance(session.token)
}

/** True when the figures on screen came from the server rather than from here. */
export const serverGoldAttached = () => session !== null
