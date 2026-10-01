import type { CombatEvent, DuelSnapshot, PlayerId } from '../shared/pvp'

/* ------------------------------------------------------------------ *
 * Turning the server's combat events into something you can see.
 *
 * The server has always sent a `CombatEvent[]` with every `combat` frame
 * and the client has always thrown it away, so a duel had no damage
 * numbers, no hit flash and no announcement of what ended it. Two players
 * fought by watching a pair of HP counters in the HUD.
 *
 * The events are queued here rather than drawn where they arrive, because
 * the socket is not in the render loop and the thing that draws them — the
 * float-label pool in `src/battle/vfx.ts` — belongs to the frame. Positions
 * are resolved on the way in, from the snapshot the events came with: by
 * the time a frame runs, the fighters have moved, and a damage number
 * belongs where the blow landed.
 *
 * No Three.js here on purpose. This module is between the socket and the
 * renderer and needs neither.
 * ------------------------------------------------------------------ */

export type DuelCue =
  | { kind: 'damage'; amount: number; label: string; x: number; z: number; onMe: boolean; byMe: boolean }
  | { kind: 'cast'; name: string; x: number; z: number; byMe: boolean }
  | { kind: 'announce'; text: string }
  | { kind: 'boundary'; x: number; z: number; onMe: boolean }

/**
 * How many cues may be waiting to be drawn.
 *
 * A frame drains all of them, so in play this never fills. What it is for is
 * the case where nothing is draining: a backgrounded tab still receives
 * twenty frames a second of a fight it is not rendering, and an unbounded
 * queue there is a leak that grows for as long as the duel lasts.
 */
const QUEUE_CAP = 96

let queue: DuelCue[] = []

function fighterAt(snapshot: DuelSnapshot, id: PlayerId) {
  if (snapshot.a.playerId === id) return snapshot.a
  if (snapshot.b.playerId === id) return snapshot.b
  return null
}

/** Called for every `combat` frame. Silently ignores event kinds it has no picture for. */
export function queueDuelCues(snapshot: DuelSnapshot, events: CombatEvent[]) {
  const you = snapshot.you
  for (const event of events) {
    switch (event.kind) {
      case 'hit': {
        const target = fighterAt(snapshot, event.target)
        if (!target) break
        queue.push({
          kind: 'damage',
          amount: event.amount,
          label: event.label,
          x: target.x,
          z: target.z,
          onMe: event.target === you,
          byMe: event.source === you,
        })
        break
      }
      case 'cast': {
        const source = fighterAt(snapshot, event.source)
        if (!source) break
        queue.push({ kind: 'cast', name: event.name, x: source.x, z: source.z, byMe: event.source === you })
        break
      }
      case 'announce':
        queue.push({ kind: 'announce', text: event.text })
        break
      case 'boundary': {
        const target = fighterAt(snapshot, event.target)
        // Only your own wall. Your opponent scraping along the far side of the
        // boundary is not news, and at twenty frames a second it is a strobe.
        if (!target || event.target !== you) break
        queue.push({ kind: 'boundary', x: target.x, z: target.z, onMe: true })
        break
      }
    }
  }
  if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP)
}

/** Takes everything waiting. The caller draws it; nothing is drawn twice. */
export function drainDuelCues(): DuelCue[] {
  if (!queue.length) return []
  const out = queue
  queue = []
  return out
}

/** Drops anything undrawn. For leaving a duel, so the next one starts clean. */
export function clearDuelCues() {
  queue = []
}
