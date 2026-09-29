/* ------------------------------------------------------------------ *
 * The chat log the HUD renders.
 *
 * Same shape as `pvp/store.ts` — a mutable object plus a subscribe/ping
 * pair — because this mounts inside the same overlay and a second state
 * library for one panel would be a worse cost than the repetition.
 *
 * Nothing here is persisted. The log lives for as long as the tab does:
 * chat is not written to `localStorage`, not sent anywhere, and not
 * recovered on reload. A player who reloads has said goodbye to the
 * backlog, which is the correct amount of message retention for a client
 * that was told not to keep message content anywhere.
 * ------------------------------------------------------------------ */

import { CHAT_LOG_LIMIT, type ChatMessage, type ChatTarget } from '../shared/pvp'
import { DEFAULT_CHANNEL, newLocalLine } from './lines'

export type ChatUi = {
  log: ChatMessage[]
  /** Where a plain, unprefixed line goes. Changed by `/all` and `/say`. */
  channel: Exclude<ChatTarget, 'whisper'>
  /** True while the input has focus. The world stops taking keys when it does. */
  focused: boolean
  /** Pointer is over the box. Enough to wake it without clicking into it. */
  hovered: boolean
  /** When the last line landed, for the idle fade. */
  lastLineAtMs: number
  /** Lines that arrived while the box was faded. Cleared on engagement. */
  unread: number
}

export const chatState: ChatUi = {
  log: [],
  channel: DEFAULT_CHANNEL,
  focused: false,
  hovered: false,
  lastLineAtMs: 0,
  unread: 0,
}

const listeners = new Set<() => void>()

export function subscribeChat(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function pingChat() {
  listeners.forEach(fn => fn())
}

/** True when the player is typing, so world keybinds must stand down. */
export function isChatFocused() {
  return chatState.focused
}

/**
 * Adds a line and trims the log.
 *
 * The cap is a fixed number of lines rather than a time window because the
 * cost being bounded is React reconciling the list, and that scales with
 * length and not with age.
 */
export function pushChatLine(msg: ChatMessage) {
  chatState.log.push(msg)
  if (chatState.log.length > CHAT_LOG_LIMIT) chatState.log.splice(0, chatState.log.length - CHAT_LOG_LIMIT)
  chatState.lastLineAtMs = msg.atMs
  if (!chatState.focused && !chatState.hovered) chatState.unread += 1
  pingChat()
}

/**
 * A line the client wrote for itself — `/help`, or a refusal of a command
 * that was never sent.
 *
 * It is marked `system` and given no `fromId`, exactly like a line from the
 * server, so the renderer has one path. That is safe in the one direction
 * that matters: a local line can never be mistaken for a player's words,
 * because a player's words always arrive with a `fromId` the server set.
 */
export function pushLocalLine(code: string, text: string) {
  pushChatLine(newLocalLine(code, text))
}

export function setChatChannel(channel: ChatUi['channel']) {
  chatState.channel = channel
  pingChat()
}
