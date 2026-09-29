/* ------------------------------------------------------------------ *
 * The chat box.
 *
 * HOW A PLAYER MESSAGE IS RENDERED, and why it is the only thing in here
 * worth reading twice:
 *
 *     <span className="ch-text">{msg.text}</span>
 *
 * A string child of a JSX element becomes a DOM text node. Angle brackets
 * stay angle brackets, a `<script>` stays five visible characters, and a URL
 * stays a URL rather than becoming a link. There is no
 * `dangerouslySetInnerHTML` in this file, no markdown, no linkifier, and no
 * `innerHTML` anywhere in the chat client. A player message is untrusted
 * input and the only safe thing to do with it is show it.
 *
 * A message also cannot make anything happen. There is no handler that reads
 * `msg.text` and acts on it — no click-to-accept, no click-to-trade, no
 * command interpreted out of another player's line. Words from a player, an
 * NPC or a model are all the same kind of thing here: text on a panel.
 *
 * THE FADE, which is a requirement and not decoration:
 *   The box is present for a whole session and in the way for most of it, so
 *   it is at full opacity only while it is being used and recedes otherwise.
 *   "Being used" is three things, any of which is enough:
 *     focused   the player is typing into it;
 *     hovered   the pointer is over it, which is how you read the backlog
 *               without claiming the keyboard;
 *     recent    a line landed inside CHAT_FADE_MS, so someone talking to you
 *               brings it back without you doing anything.
 *   Faded it keeps pointer events, because a panel you cannot hover is a
 *   panel you cannot wake, and it keeps its text — dimmed, never hidden — so
 *   glancing at it still works.
 * ------------------------------------------------------------------ */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '../pvp/net'
import { pvpState } from '../pvp/store'
import { CHAT_FADE_MS, CHAT_MAX_LEN, type ChatMessage } from '../shared/pvp'
import { parseInput } from './commands'
import { channelLabel } from './lines'
import { chatState, pingChat, pushLocalLine, setChatChannel, subscribeChat } from './store'
import './chat.css'

/** Keys that open the box. Checked against what the world already claims. */
const FOCUS_KEYS = new Set(['enter', '/'])

function useChat() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeChat(() => setTick(n => n + 1)), [])
  return chatState
}

/**
 * Re-renders once when the recency window lapses.
 *
 * A timer rather than an interval: the only moment the fade state can change
 * on its own is exactly CHAT_FADE_MS after the last line, so that is the only
 * moment worth waking React for. An interval would re-render the HUD forever
 * to discover nothing had changed, on a machine that is also drawing a voxel
 * town at 60fps.
 */
function useFadeTimer(lastLineAtMs: number) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const remaining = lastLineAtMs + CHAT_FADE_MS - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setTick(n => n + 1), remaining + 30)
    return () => window.clearTimeout(timer)
  }, [lastLineAtMs])
}

export function ChatBox() {
  const s = useChat()
  const input = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  useFadeTimer(s.lastLineAtMs)

  const recent = Date.now() - s.lastLineAtMs < CHAT_FADE_MS
  const engaged = s.focused || s.hovered || recent

  const focus = useCallback(() => {
    input.current?.focus()
  }, [])

  /*
   * Enter and `/` open the box. Both were checked against what the world
   * already binds before being claimed here, because taking a key that
   * already does something is a bug that looks like a feature: W, A and S
   * cast and order (`main.tsx`), V toggles first person, M/J/K/O open panels,
   * H opens the hunt log, and Escape cancels an aim. Enter and `/` are
   * unclaimed, and are what a player who has played anything else will try.
   *
   * The listener stands down whenever the event came from a field — including
   * this one — which is the same `isTyping` guard the world's own handler
   * uses, so typing "wander" into chat does not cast a spell.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (!FOCUS_KEYS.has(key)) return
      event.preventDefault()
      if (key === '/') setDraft(current => (current ? current : '/'))
      focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus])

  // Newest line at the bottom, like every chat box ever made.
  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [s.log.length, engaged])

  const submit = () => {
    const parsed = parseInput(draft, s.channel)
    switch (parsed.kind) {
      case 'none':
        break
      case 'switch':
        setChatChannel(parsed.channel)
        pushLocalLine('switched', parsed.text)
        break
      case 'local':
        // Never reaches the socket. An unknown command is answered here so a
        // mistyped /w cannot escape as a public line.
        pushLocalLine(parsed.code, parsed.text)
        break
      case 'send':
        if (!pvpState.connected) {
          pushLocalLine('offline', 'Not connected to the shared world, so that was not sent.')
          break
        }
        // The cap is the server's; this is the same number so an over-long
        // line is refused before it costs rate budget. The server refuses it
        // again regardless — see `server/chat/chat.ts`.
        if (parsed.text.length > CHAT_MAX_LEN) {
          pushLocalLine('too_long', `That is ${parsed.text.length} characters and the limit is ${CHAT_MAX_LEN}. Nothing was sent.`)
          break
        }
        send({ t: 'chat', channel: parsed.channel, text: parsed.text, to: parsed.to })
        break
    }
    setDraft('')
  }

  // Rendered straight from the store, which already caps the log at
  // CHAT_LOG_LIMIT. A memo here would only have to be invalidated by hand on
  // every push, and getting that wrong loses a line.
  const lines = s.log

  return (
    <section
      className={`ch-box${engaged ? ' ch-engaged' : ''}`}
      aria-label="Chat"
      onMouseEnter={() => { chatState.hovered = true; chatState.unread = 0; pingChat() }}
      onMouseLeave={() => { chatState.hovered = false; pingChat() }}
    >
      <header className="ch-head">
        <span className="ch-etch">CHAT</span>
        <button
          type="button"
          className={`ch-tab${s.channel === 'say' ? ' on' : ''}`}
          onClick={() => { setChatChannel('say'); focus() }}
        >/say</button>
        <button
          type="button"
          className={`ch-tab${s.channel === 'all' ? ' on' : ''}`}
          onClick={() => { setChatChannel('all'); focus() }}
        >/all</button>
        {!engaged && s.unread > 0 && <span className="ch-unread">{s.unread > 99 ? '99+' : s.unread} new</span>}
      </header>

      <div className="ch-log" ref={scroller} role="log" aria-live="polite">
        {!lines.length && <p className="ch-empty">Nobody has said anything yet. Press Enter to talk, or /help for the commands.</p>}
        {lines.map(msg => <Line key={msg.id} msg={msg} />)}
      </div>

      <form
        className="ch-form"
        onSubmit={event => { event.preventDefault(); submit() }}
      >
        <span className="ch-prompt">{s.channel === 'all' ? '/all' : '/say'}</span>
        <input
          ref={input}
          className="ch-input"
          value={draft}
          maxLength={CHAT_MAX_LEN}
          placeholder="Say something — /all, /w name, /help"
          aria-label="Message"
          autoComplete="off"
          spellCheck={false}
          onChange={event => setDraft(event.target.value)}
          onFocus={() => { chatState.focused = true; chatState.unread = 0; pingChat() }}
          onBlur={() => { chatState.focused = false; pingChat() }}
          onKeyDown={event => {
            // Escape hands the keyboard back to the world. Stopped here so the
            // world's own Escape handler does not also cancel an order.
            if (event.key === 'Escape') { event.stopPropagation(); setDraft(''); input.current?.blur() }
          }}
        />
        <button type="submit" className="ch-send" disabled={!draft.trim()}>Send</button>
      </form>
    </section>
  )
}

/**
 * One line.
 *
 * `mine` is decided by comparing ids, never by anything in the message, so a
 * sender cannot dress their line up as the recipient's own.
 */
function Line({ msg }: { msg: ChatMessage }) {
  const mine = msg.fromId !== null && msg.fromId === pvpState.playerId
  const label = channelLabel(msg, mine)
  return (
    <p className={`ch-line ch-${msg.channel}${mine ? ' ch-mine' : ''}`}>
      {label && <span className="ch-chan">{label}</span>}
      {msg.channel !== 'system' && <span className="ch-name">{msg.fromName}</span>}
      {/* The whole point. A text node, and nothing else. */}
      <span className="ch-text">{msg.text}</span>
    </p>
  )
}
