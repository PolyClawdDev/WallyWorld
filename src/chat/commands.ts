/* ------------------------------------------------------------------ *
 * The slash-command parser.
 *
 * A pure function from what the player typed to one of three outcomes, with
 * no imports from the network or the store, because it is the piece most
 * worth being able to reason about on its own.
 *
 * IT DOES NOT ENFORCE ANYTHING. Every rule that matters — length, rate,
 * language, who may hear what — is applied by the server, which does not
 * see this file and does not trust its output. Parsing here is a
 * convenience for the person typing, not a control.
 *
 * WHY /say IS THE DEFAULT AND NOT /all
 *   A bare line goes to the people standing near you. Two reasons, and the
 *   second is the one that decided it:
 *
 *   1. An unprefixed line is the one a player sends by accident — the
 *      reflex "type, Enter" before thinking about the audience. The default
 *      should therefore be the SMALLER audience, because a misdirected
 *      sentence heard by four people nearby is recoverable and the same
 *      sentence broadcast to all sixty-four is not.
 *   2. If everything were global by default, nothing would ever be local,
 *      and proximity chat — which is the thing that makes a town feel like
 *      a place rather than a chat room — would be dead on arrival.
 *
 *   This is also what World of Warcraft, Runescape and Final Fantasy XIV
 *   all do, so it is what a player arrives already expecting.
 * ------------------------------------------------------------------ */

import { CHAT_SAY_RADIUS, type ChatTarget } from '../shared/pvp'

export type ParsedInput =
  /** Hand to the server. */
  | { kind: 'send'; channel: ChatTarget; text: string; to?: string }
  /** `/all` with nothing after it: change where plain lines go. Sends nothing. */
  | { kind: 'switch'; channel: Exclude<ChatTarget, 'whisper'>; text: string }
  /** Answered locally — `/help`, or a command that does not exist. Never sent. */
  | { kind: 'local'; text: string; code: string }
  /** Nothing was typed. */
  | { kind: 'none' }

/** The default channel. See the header for why it is this one. */
export const DEFAULT_CHANNEL = 'say' satisfies ChatTarget

const ALIASES: Readonly<Record<string, ChatTarget>> = {
  all: 'all',
  a: 'all',
  world: 'all',
  shout: 'all',
  say: 'say',
  s: 'say',
  local: 'say',
  w: 'whisper',
  whisper: 'whisper',
  tell: 'whisper',
  t: 'whisper',
  msg: 'whisper',
  pm: 'whisper',
}

export const HELP_LINES = [
  '/all <message> — everyone in the world hears it.',
  `/say <message> — only players within ${CHAT_SAY_RADIUS} m. This is what a plain line does.`,
  '/w <name> <message> — private, to one player. Quote a name with spaces: /w "Ana L" hi.',
  '/help — this list.',
  'A line starting with // sends a literal slash.',
] as const

/**
 * Pulls the whisper target off the front.
 *
 * Quoted first, because display names may contain spaces and "Ana L" would
 * otherwise become a whisper to "Ana" beginning with the word "L".
 */
function splitTarget(rest: string): { to: string; text: string } {
  const quoted = /^"([^"]{1,64})"\s*([\s\S]*)$/.exec(rest)
  if (quoted) return { to: quoted[1].trim(), text: quoted[2].trim() }
  const space = rest.search(/\s/)
  if (space === -1) return { to: rest.trim(), text: '' }
  return { to: rest.slice(0, space).trim(), text: rest.slice(space + 1).trim() }
}

export function parseInput(raw: string, fallback: ChatTarget = DEFAULT_CHANNEL): ParsedInput {
  const input = raw.trim()
  if (!input) return { kind: 'none' }

  // `//` is the escape hatch for a line that genuinely starts with a slash.
  if (input.startsWith('//')) {
    const text = input.slice(1).trim()
    return text ? { kind: 'send', channel: fallback, text } : { kind: 'none' }
  }

  if (!input.startsWith('/')) return { kind: 'send', channel: fallback, text: input }

  const match = /^\/([a-z?]+)\s*([\s\S]*)$/i.exec(input)
  if (!match) {
    return { kind: 'local', code: 'unknown', text: 'That is not a command. Type /help to see the ones that are.' }
  }
  const word = match[1].toLowerCase()
  const rest = match[2].trim()

  if (word === 'help' || word === '?' || word === 'commands') {
    return { kind: 'local', code: 'help', text: HELP_LINES.join('\n') }
  }

  const channel = ALIASES[word]
  if (!channel) {
    /*
     * An unrecognised command is NOT sent as public text. Getting this wrong
     * is the classic chat bug: someone fat-fingers /wisper and their private
     * message goes to the whole world. So an unknown slash word never
     * reaches the socket, and the echo below does not repeat what was typed.
     */
    return {
      kind: 'local',
      code: 'unknown',
      text: `There is no /${word} command, so nothing was sent. Type /help for the list.`,
    }
  }

  if (channel === 'whisper') {
    const { to, text } = splitTarget(rest)
    if (!to) return { kind: 'local', code: 'usage', text: 'Whisper who? Use /w <name> <message>.' }
    if (!text) return { kind: 'local', code: 'usage', text: `Nothing to whisper to ${to}. Use /w <name> <message>.` }
    return { kind: 'send', channel, text, to }
  }

  // `/all` on its own switches the channel the next plain line uses, which is
  // how every game that has this expects to behave.
  if (!rest) return { kind: 'switch', channel, text: `Plain lines now go to /${channel}.` }
  return { kind: 'send', channel, text: rest }
}
