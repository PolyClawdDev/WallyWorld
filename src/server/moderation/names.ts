/* ------------------------------------------------------------------ *
 * Display-name screening. SERVER ONLY.
 *
 * THE PROPERTY THIS EXISTS TO HOLD
 *   The server decides the name other players see. A client may send
 *   anything; what is persisted and what is broadcast are this module's
 *   decision. Filtering in the browser would be theatre, because in this
 *   incident the browser is the attacker.
 *
 * WHERE IT IS ENFORCED — two layers, because a name can be set by more
 * than one route:
 *
 *   edge       `PUT /api/profile` rejects a blocked name with a generic
 *              422, and the PvP `hello` frame refuses to persist one.
 *   broadcast  every `AccountRow` leaving `server/pvp/ids.ts` has its
 *              `display_name` screened on the way out, so a row that
 *              predates this code — or that arrived by a route nobody
 *              thought of — is still never broadcast. That is the layer
 *              that actually stops the live abuse, and it stops it on
 *              restart without waiting for a database sweep.
 *
 * WHY NORMALISE INSTEAD OF LISTING SPELLINGS
 *   Anyone deliberately choosing a slur will try to smuggle it through, and
 *   the evasions are a small, known set: case, leetspeak, repeated letters,
 *   separators between letters, invisible characters, and Unicode
 *   confusables. Enumerating spellings is unbounded; folding the input into
 *   one comparison form is not. The player's ORIGINAL text is what gets
 *   stored and displayed when it passes — the folded form exists only to be
 *   compared against, and is never shown or saved.
 *
 * FALSE POSITIVES
 *   The Scunthorpe problem is the reason this is not one regex. Short terms
 *   are matched as whole tokens only, and an allowlist of innocent words is
 *   masked out of the comparison form first. See `blocklist.ts`.
 *
 * LOGGING
 *   Nothing here returns or logs the offending text. A rejection carries a
 *   truncated SHA-256 instead, which is enough to correlate two attempts
 *   from the same person in an incident and useless as a slur.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import { ALWAYS_TERMS, INNOCENT_TERMS, WORD_TERMS } from './blocklist'

/**
 * What a blocked name is replaced with at the broadcast layer.
 *
 * Deliberately the same neutral word the duel journal already falls back to
 * for a missing account, so a neutralised name looks like an ordinary
 * default rather than a scarlet letter — and so a player standing next to
 * an offender is not told that moderation happened.
 */
export const NEUTRAL_DISPLAY_NAME = 'Wayfinder'

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

/**
 * Characters that are not the Latin letter they look like.
 *
 * Only non-decomposing lookalikes are listed. Accented Latin (á, ï, ø) and
 * the full-width forms (ａ-ｚ, ０-９) are handled by NFKD plus combining-mark
 * removal, which is both shorter and more complete than any table.
 *
 * The digit and symbol entries are the leetspeak substitutions: they live in
 * the same table because to the matcher there is no difference between a
 * Cyrillic `е` and a `3` — both are a player writing `e` while hoping a
 * string comparison disagrees.
 *
 * The Cyrillic coverage deliberately goes beyond the lookalikes to the whole
 * basic alphabet. Not for the confusables — for the opposite reason. Anything
 * left unmapped is stripped when separators are removed, and stripping the
 * middle of a word splices its two halves together: "Екатерина" lost its `и`
 * and became a string containing `ph`, which then folded to `f`. A name in
 * another script must fold to something inert, not to debris.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  a: 'аӑӓяαª@4',
  b: 'ƅβвбъь8',
  c: 'сϲц¢(',
  d: 'дđԁð',
  e: 'еєэёϵε3€',
  f: 'фƒ',
  g: 'ɡցğ69',
  h: 'нһ',
  i: 'іїийыıι1!¡|',
  j: 'ј',
  k: 'кκ',
  l: 'лłӏ',
  m: 'мμ',
  n: 'пη',
  o: 'оοθøσ0',
  p: 'рρ',
  r: 'гř',
  s: 'ѕ$5',
  t: 'тτ7+',
  u: 'юυ',
  v: 'ν',
  w: 'шщω',
  x: 'х×χ',
  // Cyrillic `у` transliterates to `u` but is visually identical to Latin `y`,
  // and the attack this table exists for is visual. It folds to `y`.
  y: 'уүγ',
  z: 'зжʐ2',
}

const SINGLE = new Map<string, string>()
for (const [latin, lookalikes] of Object.entries(CONFUSABLES)) {
  for (const ch of lookalikes) SINGLE.set(ch, latin)
}

/**
 * Sequences, applied after the single-character pass so that `ph` is seen
 * even when it arrived as `рh` with a Cyrillic p.
 *
 * `ph`→`f` is what catches the `phuck` family. It is safe on real names:
 * Sophie, Stephen and Philip fold to Sofie, Stefen and Filip, none of which
 * is on any list.
 */
const SEQUENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/þ/g, 'th'],
  [/ph/g, 'f'],
  [/vv/g, 'w'],
]

/** Invisible characters: separators that leave no trace on screen. */
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufe00-\ufe0f\ufeff]/g

/** Per-character folding: case, accents, invisibles, confusables, leetspeak. */
function foldChars(raw: string): string {
  const text = raw.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(INVISIBLE, '')
  let out = ''
  for (const ch of text) out += SINGLE.get(ch) ?? ch
  return out
}

/**
 * Sequence folding, applied AFTER separators are gone.
 *
 * Order matters and getting it wrong is silent: `p.a.e.d.o.p.h.i.l.e` only
 * contains `ph` once the dots have been removed, so folding sequences before
 * stripping separators would leave the input and the term spelled differently
 * and the match would quietly never fire.
 */
function foldSequences(text: string): string {
  let out = text
  for (const [pattern, replacement] of SEQUENCES) out = out.replace(pattern, replacement)
  return out
}

/**
 * `i` and `l` are the same letter to this filter.
 *
 * They are the one pair a font cannot separate, which is why `1` is the
 * leetspeak substitute for BOTH of them — and a digit can only fold to one
 * letter, so guessing would leave the other half of the evasion working.
 * Every `l` becomes `i` on BOTH sides of the comparison, including the
 * allowlist, which is what keeps `Analyst` passing.
 *
 * The cost is that a name differing from a term only in an i/l is treated as
 * the term. That is the intended trade: the pair is indistinguishable on
 * screen, so such a name is indistinguishable from the slur to every player
 * who reads it.
 */
const foldConfusedLetters = (text: string) => text.replace(/l/g, 'i')

/** Terms are folded with the same pipeline as the input, so no fold can desynchronise the two sides. */
const foldTerm = (term: string) => foldConfusedLetters(foldSequences(foldChars(term).replace(/[^a-z0-9]+/g, '')))

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A term as a pattern that tolerates repeated characters: `nigger` becomes
 * `n+i+g+g+e+r+`, which matches `niiiigger` and `niggggerrr`.
 *
 * This replaces an earlier attempt that collapsed every run of repeats in the
 * input and in the term and compared those. Collapsing is seductive and wrong:
 * it shortens, so `kkk` collapses to `k` and matches every name containing a
 * `k` — "Dick Van Dyke" was rejected by it. `+` can only lengthen a run, never
 * shorten one, so it catches the padding without inventing a match. It also
 * means `Niger` is no longer mistaken for a term, because a missing letter is
 * not a repeated one.
 */
const repeatTolerant = (term: string) => [...term].map(ch => `${escapeRegExp(ch)}+`).join('')

const ALWAYS = ALWAYS_TERMS.map(foldTerm).filter(Boolean)
const ALWAYS_PATTERNS = ALWAYS.map(term => new RegExp(repeatTolerant(term)))

/** Longest first, so masking `assassin` happens before masking `ass` would. */
const INNOCENT = INNOCENT_TERMS.map(foldTerm).filter(Boolean).sort((a, b) => b.length - a.length)

/**
 * The whole-token tier: the same repeat tolerance, anchored at both ends.
 *
 * `ass` accepts `aass` and `asss` but never `as`, and never `assassin`. That
 * anchoring is the entire defence against the Scunthorpe problem for this
 * tier, and the reason the short terms that appear inside innocent English
 * live here rather than above.
 */
const WORD_PATTERNS = WORD_TERMS.map(foldTerm)
  .filter(Boolean)
  .map(term => new RegExp(`^${repeatTolerant(term)}$`))

/**
 * Masks allowlisted innocent words out of the comparison form.
 *
 * Replaced with a separator rather than removed: deleting `ass` from
 * `assassin` would leave `assin`, and deleting a word from between two
 * others could splice a match that was never written. A separator cannot
 * appear inside a term, so it ends any match that tries to cross it.
 */
function maskInnocent(tight: string): string {
  let out = tight
  for (const word of INNOCENT) {
    if (!out.includes(word)) continue
    out = out.split(word).join('*')
  }
  return out
}

export type NameShape = {
  /** Everything non-alphanumeric removed. Separator and invisible-character evasion dies here. */
  tight: string
  /** The same, split on the separators instead of having them deleted. */
  tokens: readonly string[]
}

/** Exported for the test suite, which asserts each evasion class lands on the same form. */
export function normaliseForMatch(raw: string): NameShape {
  const folded = foldChars(raw)
  const finish = (text: string) => foldConfusedLetters(foldSequences(text))
  return {
    tight: finish(folded.replace(/[^a-z0-9]+/g, '')),
    tokens: folded.split(/[^a-z0-9]+/).filter(Boolean).map(finish),
  }
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/**
 * Which tier fired. Reported to the operator, never to the player: telling
 * someone their name failed on a whole-token match is telling them how to
 * pass next time.
 */
export type BlockTier = 'always' | 'word'

export type NameVerdict =
  | { ok: true }
  | { ok: false; tier: BlockTier; fingerprint: string }

/**
 * A short, non-reversible tag for a name.
 *
 * The same shape `redact.ts` uses for credentials, and for the same reason:
 * an operator needs to be able to say "these two attempts were the same
 * string" without the string being written down anywhere.
 */
export function nameFingerprint(raw: string): string {
  return `sha256:${createHash('sha256').update(raw.normalize('NFC'), 'utf8').digest('hex').slice(0, 12)}`
}

/**
 * Whether the separators look like an attempt to break up a word rather than
 * ordinary spacing.
 *
 * `a.n.a.l` is one word wearing punctuation; `Ana L` is two names. The test
 * is that every token is at most two characters long, which is true of the
 * first and false of the second. Without this, the whole-name form of any
 * two-part name would be checked against the short-term tier and "Ana L"
 * would be rejected for something its owner did not write.
 */
const looksSpacedOut = (tokens: readonly string[]) => tokens.length > 1 && tokens.every(token => token.length <= 2)

/**
 * The decision. `ok: false` means this string must not be stored or
 * broadcast under any circumstances.
 */
export function screenDisplayName(raw: unknown): NameVerdict {
  if (typeof raw !== 'string' || !raw) return { ok: true }
  const { tight, tokens } = normaliseForMatch(raw)
  if (!tight) return { ok: true }

  const masked = maskInnocent(tight)
  for (const pattern of ALWAYS_PATTERNS) {
    if (pattern.test(masked)) return { ok: false, tier: 'always', fingerprint: nameFingerprint(raw) }
  }

  const candidates = looksSpacedOut(tokens) ? [...tokens, tight] : tokens
  for (const pattern of WORD_PATTERNS) {
    for (const candidate of candidates) {
      if (pattern.test(candidate)) return { ok: false, tier: 'word', fingerprint: nameFingerprint(raw) }
    }
  }

  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * The broadcast layer
 * ------------------------------------------------------------------ */

/**
 * Bounded memo, because this runs on every presence row of every broadcast
 * tick — with a full room that is a few hundred calls a second against a
 * few hundred patterns. Keyed on the raw stored string, so it is only ever
 * as large as the set of distinct names currently online.
 */
const verdictCache = new Map<string, boolean>()
const CACHE_MAX = 2048

/**
 * The name other players are allowed to see.
 *
 * Applied to every account row on its way out of the database, which is
 * what makes "the server decides the name" true of rows this code never
 * screened on the way in.
 */
export function publicDisplayName(stored: string): string {
  if (!stored) return NEUTRAL_DISPLAY_NAME
  let allowed = verdictCache.get(stored)
  if (allowed === undefined) {
    allowed = screenDisplayName(stored).ok
    if (verdictCache.size >= CACHE_MAX) verdictCache.clear()
    verdictCache.set(stored, allowed)
  }
  return allowed ? stored : NEUTRAL_DISPLAY_NAME
}

/** Test hook. The cache is keyed on stored text, so a sweep that rewrites rows must clear it. */
export function clearNameVerdictCache() {
  verdictCache.clear()
}

/** Counts, for the startup banner and the sweep script. Never the terms themselves. */
export const blocklistSize = { always: ALWAYS.length, word: WORD_PATTERNS.length, innocent: INNOCENT.length }
