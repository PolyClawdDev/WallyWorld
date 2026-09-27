/* ------------------------------------------------------------------ *
 * Bridge between the game's React state and the wallet panel.
 *
 * Follows the same shape as `worldBridge.ts`: the owner of the state
 * registers a read/apply pair, and this module holds nothing else. It
 * exists so that persisting and restoring a character costs `main.tsx`
 * one registration call rather than a set of props threaded through the
 * popup, which matters while another change is in flight in that file.
 * ------------------------------------------------------------------ */

import type { MothStyle, WizardId } from '../characters'

export type PlayerSnapshot = {
  character: WizardId
  style: MothStyle
  playerName: string
  /** Integer gold. Client-side only, and not a balance anything may be paid against. */
  gold: number
}

type PlayerHandle = {
  read: () => PlayerSnapshot
  /** Applies a loaded save. The game owns how that lands in its own state. */
  apply: (snapshot: PlayerSnapshot) => void
}

let handle: PlayerHandle | null = null
const listeners = new Set<() => void>()

export function registerPlayer(next: PlayerHandle) {
  handle = next
  listeners.forEach(listener => listener())
  return () => {
    if (handle === next) {
      handle = null
      listeners.forEach(listener => listener())
    }
  }
}

/** Lets the panel re-render when the game mounts or unmounts. */
export function subscribePlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const isPlayerReady = () => handle !== null

export const readPlayer = (): PlayerSnapshot | null => (handle ? handle.read() : null)

export function applyPlayer(snapshot: PlayerSnapshot): boolean {
  if (!handle) return false
  handle.apply(snapshot)
  return true
}
