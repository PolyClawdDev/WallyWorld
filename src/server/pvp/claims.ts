/* ------------------------------------------------------------------ *
 * One tab per character.
 *
 * A session token lives in localStorage, and localStorage is shared by
 * every tab in a browser profile. Open the game twice and, without this,
 * both tabs hold a live socket for the same wizard: two streams of pose
 * updates fighting over one position, two `hello` messages rewriting one
 * loadout, and — the part that actually matters — two clients able to
 * accept two duels for one escrow balance.
 *
 * The fix is a claim. A character has at most one holder, identified by
 * an epoch that increases every time the claim changes hands. A later
 * connection wins: the newest tab is almost always the one the player is
 * looking at, and the alternative ("first tab wins") strands somebody
 * behind a tab they have already forgotten about, with no way back in
 * short of waiting out a timeout.
 *
 * Takeover is explicit, not silent. The displaced connection is told it
 * was superseded before it is closed, so its client can say so and stop
 * reconnecting. That distinction is the whole design: a socket that
 * dropped should reconnect hard, and a socket that was taken over must
 * not, or the two tabs sit in a reconnect war, each kicking the other out
 * forever.
 * ------------------------------------------------------------------ */

import type { PlayerId } from '../../shared/pvp'

export type ClaimHolder = {
  /** Monotonic per character. A holder whose epoch is stale has been replaced. */
  epoch: number
  claimedAtMs: number
}

export type ClaimResult<T> = {
  epoch: number
  /** The holder that was just displaced, for the caller to notify and close. */
  displaced: T | null
}

/**
 * Claims are keyed by character, not by connection, and the value is
 * whatever the caller wants to hang off them — here, the live session.
 */
export class CharacterClaims<T> {
  private readonly held = new Map<PlayerId, { epoch: number; value: T; claimedAtMs: number }>()
  private nextEpoch = 1

  /** Takes the claim for `playerId`, returning whoever held it before. */
  take(playerId: PlayerId, value: T, now = Date.now()): ClaimResult<T> {
    const previous = this.held.get(playerId)
    const epoch = this.nextEpoch++
    this.held.set(playerId, { epoch, value, claimedAtMs: now })
    return { epoch, displaced: previous ? previous.value : null }
  }

  /**
   * Releases the claim, but only if `epoch` still holds it.
   *
   * The guard is what makes a displaced connection's close handler safe:
   * it fires after the new tab has already claimed the character, and
   * without the check it would tear down the new tab's claim on its way
   * out.
   */
  release(playerId: PlayerId, epoch: number): boolean {
    const current = this.held.get(playerId)
    if (!current || current.epoch !== epoch) return false
    this.held.delete(playerId)
    return true
  }

  /** True when this epoch is still the authoritative holder. */
  holds(playerId: PlayerId, epoch: number): boolean {
    return this.held.get(playerId)?.epoch === epoch
  }

  current(playerId: PlayerId): T | null {
    return this.held.get(playerId)?.value ?? null
  }

  get size(): number {
    return this.held.size
  }

  entries(): Array<{ playerId: PlayerId; epoch: number; value: T; claimedAtMs: number }> {
    return [...this.held.entries()].map(([playerId, entry]) => ({ playerId, ...entry }))
  }

  clear() {
    this.held.clear()
  }
}
