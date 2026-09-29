/* ------------------------------------------------------------------ *
 * Small shared pieces of the chat client.
 *
 * Its own file only to keep `store.ts` and `commands.ts` from importing
 * each other.
 * ------------------------------------------------------------------ */

import type { ChatMessage } from '../shared/pvp'

export { DEFAULT_CHANNEL } from './commands'

let counter = 0

/**
 * A line this client wrote for itself.
 *
 * The id is prefixed `l_` so it cannot collide with a server id, which is
 * `m_` — the two streams share one log and a duplicated React key would
 * drop a line.
 */
export function newLocalLine(code: string, text: string): ChatMessage {
  counter += 1
  return {
    id: `l_${counter}`,
    channel: 'system',
    fromId: null,
    fromName: 'Voxels',
    text,
    atMs: Date.now(),
    code,
  }
}

/** The prefix shown in front of a line, per channel. */
export function channelLabel(msg: ChatMessage, mine: boolean): string {
  switch (msg.channel) {
    case 'all':
      return '[all]'
    case 'say':
      return '[say]'
    case 'whisper':
      return mine ? `[to ${msg.toName ?? '?'}]` : '[whisper]'
    default:
      return ''
  }
}
