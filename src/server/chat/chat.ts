/* ------------------------------------------------------------------ *
 * What a chat message is allowed to be. SERVER ONLY.
 *
 * Every rule a message has to pass lives here, in front of the hub, so the
 * hub is left with delivery — who hears it — and nothing else. Nothing in
 * this module can send, so nothing in it can accidentally publish.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING
 *   shape → length → rate → sanitise → moderation
 *
 *   Length is measured on the frame AS SENT, before anything is stripped, or
 *   a 100 kB message of zero-width spaces would sanitise down to nothing and
 *   pass a cap it never respected.
 *
 *   Rate is charged BEFORE moderation, and charged whether the message is
 *   published or refused. Charging only for accepted messages would make the
 *   blocklist free to probe — send, read the refusal, respell, repeat — which
 *   is the same reasoning as the name-change budget in `moderation/nameRate.ts`.
 *
 * WHAT THIS MODULE CANNOT DO
 *   There is no command here that changes state. A chat message is words: it
 *   cannot move gold, accept or decline a duel, set a block, or alter any
 *   permission. `/w` resolves a name to a socket and that is the entire
 *   extent of its authority. The hub calls this, reads a verdict, and either
 *   relays text or does not.
 *
 * LOGGING
 *   No function here logs, and none of them is given anything that logs.
 *   Message text never reaches stdout, the database, or a metric label —
 *   only `chatCounters`, which counts.
 * ------------------------------------------------------------------ */

import { randomBytes } from 'node:crypto'
import { CHAT_MAX_LEN, CHAT_RATE, type ChatMessage, type ChatTarget } from '../../shared/pvp'
import { screenMessage } from '../moderation/messages'
import { overBudget } from '../net'

/** Counts, never content. */
export const chatCounters = { accepted: 0, refused: 0 }

/**
 * Invisible characters, stripped for the same reason `names.ts` strips them:
 * they are separators that leave no trace on screen, so a message full of
 * them is a blank line with a payload.
 */
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g

/** C0 and C1 controls. A newline in a chat line is a way to forge a second line. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Stacked combining marks, capped rather than removed.
 *
 * Two is more than any real orthography needs on one base character and far
 * fewer than it takes to draw over the rest of the HUD. Removing them
 * outright would mangle ordinary accented text, which is why this is a cap.
 */
const MARK_PILE = /(\p{M}{2})\p{M}+/gu

/**
 * What a message may CONTAIN, as opposed to what it may say.
 *
 * Exactly parallel to `sanitisePlayerName`: this is the layer that makes the
 * string a single line of plain text, and it runs before the layer that
 * decides whether the line is publishable.
 */
export function sanitiseMessage(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(MARK_PILE, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export type ChatRefusal = { ok: false; code: string; detail: string }
export type ChatAccepted = { ok: true; channel: ChatTarget; text: string; to: string | null }
export type ChatVerdict = ChatAccepted | ChatRefusal

const CHANNELS: readonly ChatTarget[] = ['all', 'say', 'whisper']

/**
 * The decision, for one frame from one player.
 *
 * `playerId` is only ever used as a rate-limit key. It is not trusted for
 * anything and is not put in the result: the hub already knows who the
 * sender is, because it is holding their connection.
 */
export function vetChat(input: {
  playerId: string
  channel: unknown
  text: unknown
  to: unknown
  now?: number
}): ChatVerdict {
  const now = input.now ?? Date.now()

  if (typeof input.channel !== 'string' || !CHANNELS.includes(input.channel as ChatTarget)) {
    return { ok: false, code: 'bad_channel', detail: 'That is not a channel. Try /help.' }
  }
  const channel = input.channel as ChatTarget
  if (typeof input.text !== 'string') {
    return { ok: false, code: 'bad_message', detail: 'That message could not be read.' }
  }

  // Before sanitisation, on purpose. See the header.
  if (input.text.length > CHAT_MAX_LEN) {
    return {
      ok: false,
      code: 'too_long',
      detail: `That is ${input.text.length} characters and the limit is ${CHAT_MAX_LEN}. Nothing was sent — shorten it and send again.`,
    }
  }

  if (channel === 'whisper' && (typeof input.to !== 'string' || !input.to.trim())) {
    return { ok: false, code: 'no_target', detail: 'Whisper who? Use /w <name> <message>.' }
  }

  if (overBudget(`chat:${input.playerId}`, CHAT_RATE, now)) {
    chatCounters.refused += 1
    return {
      ok: false,
      code: 'rate_limited',
      detail: `Slow down — ${CHAT_RATE.max} messages every ${CHAT_RATE.windowMs / 1000} seconds. That one was not sent.`,
    }
  }

  const text = sanitiseMessage(input.text)
  if (!text) {
    return { ok: false, code: 'empty', detail: 'Nothing to say.' }
  }

  if (!screenMessage(text).ok) {
    chatCounters.refused += 1
    // Says that it was refused and not why. Naming the trigger would be
    // telling the sender which token to respell, and on a false positive the
    // player can rephrase from this much alone.
    return {
      ok: false,
      code: 'refused',
      detail: 'That message was not sent — it tripped the language filter. Nobody saw it. Try rewording it.',
    }
  }

  chatCounters.accepted += 1
  return { ok: true, channel, text, to: channel === 'whisper' ? String(input.to).trim() : null }
}

export function newChatId(): string {
  return `m_${randomBytes(8).toString('hex')}`
}

/**
 * A line from the server to one player.
 *
 * The only `ChatMessage` whose `text` this codebase wrote, and therefore the
 * only one where the wording means anything. It still renders through the
 * same text node as everything else.
 */
export function systemLine(code: string, detail: string, now = Date.now()): ChatMessage {
  return { id: newChatId(), channel: 'system', fromId: null, fromName: 'Voxels', text: detail, atMs: now, code }
}
