/* ------------------------------------------------------------------ *
 * Guest presence identity.
 *
 * A browser that has not signed in with a wallet still needs a stable
 * account so it can stand in the shared town. The client holds a random
 * secret in localStorage; this module hashes it and issues a normal
 * session. The hash is not a Solana address and is never shown as one.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { createSession } from '../auth'
import { ensureAccount } from './ids'

const GUEST_KEY = /^[0-9a-f]{32,128}$/i

export function accountIdFromGuestKey(guestKey: string) {
  return `gst_${createHash('sha256').update(guestKey.toLowerCase(), 'utf8').digest('hex').slice(0, 40)}`
}

export function issueGuestSession(guestKey: unknown, now = Date.now()) {
  if (typeof guestKey !== 'string' || !GUEST_KEY.test(guestKey)) return null
  const accountId = accountIdFromGuestKey(guestKey)
  const session = createSession(accountId, now)
  const account = ensureAccount(accountId, now)
  return {
    token: session.token,
    expiresAtMs: session.expiresAtMs,
    playerId: account.player_id,
    guest: true as const,
    notice: 'Guest identity for the shared town. Not a wallet. Not Solana.',
  }
}
