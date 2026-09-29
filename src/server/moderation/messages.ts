/* ------------------------------------------------------------------ *
 * Chat message screening. SERVER ONLY.
 *
 * There is ONE matcher in this codebase and it lives in `names.ts`. This
 * module does not contain a second one, does not read `blocklist.ts`, and
 * does not know a single term. All it decides is the GRANULARITY the
 * existing matcher is applied at, and what happens when it fires.
 *
 * WHY GRANULARITY IS THE WHOLE PROBLEM
 *   `screenDisplayName` deletes separators before it matches, which is
 *   exactly right for a name: `n.i.g.g.e.r` is one word wearing punctuation,
 *   and a name is one word-ish thing. Run the same function over a SENTENCE
 *   and the spaces between unrelated words vanish too, so the input grows a
 *   substring nobody wrote. "each inkling" becomes "eachinkling", which
 *   contains a slur. "much inkling" does too. There are more of these than
 *   anyone can enumerate, which is the point: the failure is structural, not
 *   a missing allowlist entry.
 *
 *   So a message is screened WORD BY WORD. Each whitespace-delimited chunk
 *   goes through the unmodified name screener, which still strips the
 *   punctuation inside that chunk — `f.u.c.k` is one chunk and still fails —
 *   while the gaps between chunks are boundaries no match may cross.
 *
 *   That leaves one evasion: spacing a word out, `n i g g e r`. Those are
 *   separate chunks and individually inert. They are caught by a second
 *   pass over RUNS of three or more consecutive chunks that are each at most
 *   two characters long, joined and screened. Ordinary English almost never
 *   strings three one-and-two-letter words together, and when it does the
 *   join is harmless ("as it is" folds to `asitis`). Note this is the same
 *   reasoning as `looksSpacedOut` in `names.ts`, applied to a window inside
 *   a sentence rather than to a whole name.
 *
 * WHY A HIT IS A REFUSAL AND NOT A SUBSTITUTION
 *   A blocked NAME is neutralised: the player keeps playing under
 *   "Wayfinder" and a false positive costs them a label. A blocked MESSAGE
 *   has no equivalent — there is nothing to substitute for a sentence, and
 *   the Scunthorpe problem is far more likely here because a sentence offers
 *   far more places for an accident to happen.
 *
 *   The two alternatives are both worse than refusing:
 *     silently dropping  the sender watches their own line appear (or not)
 *                        and has no idea nobody heard it. A player who
 *                        thinks they are being ignored says it again, louder.
 *     masking the word   publishes the rest of a sentence the sender did not
 *                        agree to send, and tells them exactly which token
 *                        to respell.
 *   So: refused, nothing delivered to anyone, and the SENDER — only the
 *   sender — is told, in wording that does not name the trigger.
 *
 * LOGGING
 *   Nothing here takes, returns, hashes or emits the message text. Not even
 *   a fingerprint: `names.ts` returns one because an operator triaging a
 *   name incident needs to correlate two attempts by the same person, and no
 *   such need exists for a sentence that was never published. `counters` is
 *   the only thing that leaves this module, and it counts.
 * ------------------------------------------------------------------ */

import { normaliseForMatch, screenDisplayName } from './names'

/**
 * A run of this many consecutive very-short chunks is treated as one word
 * that has been spaced out. Two would catch "a b" and every "I am" that
 * follows; three is where deliberate spacing starts and ordinary prose stops.
 */
const SPACED_RUN_MIN = 3

/** A chunk this short carries no word on its own, so it is a candidate fragment. */
const FRAGMENT_MAX = 2

/**
 * Metrics only. Deliberately the whole of this module's observable output
 * besides the verdict: a count is enough to notice a spike, and a spike is
 * the only thing anyone needs to notice.
 */
export const messageCounters = { screened: 0, refused: 0 }

export type MessageVerdict = { ok: true } | { ok: false }

const REFUSED: MessageVerdict = { ok: false }
const ALLOWED: MessageVerdict = { ok: true }

/** The folded length of a chunk, so `f-u` counts as two characters and not three. */
const fragmentLength = (chunk: string) => normaliseForMatch(chunk).tight.length

/**
 * Whether this sentence may be published.
 *
 * `ok: false` means it reaches nobody — not the room, not the target, and
 * not the sender's own log as a delivered line.
 */
export function screenMessage(raw: unknown): MessageVerdict {
  if (typeof raw !== 'string' || !raw.trim()) return ALLOWED
  messageCounters.screened += 1

  const chunks = raw.split(/\s+/).filter(Boolean)

  // Deduplicated because a flood is usually the same token repeated, and
  // screening it once is the difference between a cheap check and a way to
  // spend the server's CPU 240 characters at a time.
  for (const chunk of new Set(chunks)) {
    if (!screenDisplayName(chunk).ok) {
      messageCounters.refused += 1
      return REFUSED
    }
  }

  /*
   * Second pass: each maximal run of fragments, joined and screened ONCE.
   *
   * Once, not at every window inside the run, because the tier that catches
   * a spaced-out slur is the substring tier — `x n i g g e r` joins to
   * `xnigger`, which still contains the term. Sliding a window would only
   * add anchored WORD-tier hits on a decorated spelling, and `blocklist.ts`
   * already states that catching those means rejecting "Scunthorpe". So the
   * gap is deliberate and the cost stays linear in the length of the message
   * rather than quadratic, which on one small instance is the difference
   * between a check and a denial of service.
   */
  let run: string[] = []
  const runRefused = (): boolean => run.length >= SPACED_RUN_MIN && !screenDisplayName(run.join('')).ok

  for (const chunk of chunks) {
    const length = fragmentLength(chunk)
    if (length > 0 && length <= FRAGMENT_MAX) {
      run.push(chunk)
      continue
    }
    if (runRefused()) {
      messageCounters.refused += 1
      return REFUSED
    }
    run = []
  }
  if (runRefused()) {
    messageCounters.refused += 1
    return REFUSED
  }

  return ALLOWED
}
