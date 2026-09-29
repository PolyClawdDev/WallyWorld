/* ------------------------------------------------------------------ *
 * The display-name blocklist. SERVER ONLY.
 *
 * Nothing here may be imported from `src/shared`, `src/pvp` or any other
 * module the client bundle can reach. A slur list shipped to the browser
 * would be both useless — the client is the attacker — and a liability.
 * `scripts/test-names.ts` decodes this file and greps the built bundle for
 * every entry, so an accidental import is a failing gate rather than a
 * discovery in production.
 *
 * WHY BASE64
 *   The words themselves are the payload of a moderation control, not
 *   prose anyone needs to read in passing. Encoding them keeps them out of
 *   code review diffs, editor search results, `grep` output and the repo's
 *   own plaintext, which is worth more than the small cost of decoding at
 *   import. It is not a security measure and is not pretending to be one.
 *
 * MAINTENANCE
 *   To read the list:
 *     node -e "console.log(Buffer.from(<base64>,'base64').toString())"
 *   To add a term: decode, edit, re-encode with
 *     node -e "console.log(Buffer.from(require('fs').readFileSync(0,'utf8').trim(),'utf8').toString('base64'))"
 *   Each list is ONE unbroken string literal so that a round trip through
 *   those two commands is lossless. Do not wrap it across concatenated
 *   literals: `+` is a base64 character and the blob stops being decodable.
 *   Keep each list sorted and lowercase. Terms are folded through the same
 *   normaliser as the input (see `names.ts`), so write them in plain
 *   spelling — no leet, no separators, no repeats.
 *
 * TWO TIERS, because one matching rule cannot serve both halves.
 *
 *   ALWAYS  Terms that no innocent word contains — every racial, ethnic,
 *           homophobic and transphobic slur lives here regardless of length,
 *           because those are the ones that caused the incident and a
 *           decorated spelling like "xXtermXx" has to fail too. Matched as a
 *           SUBSTRING of the whole name with separators removed, so
 *           "n i g g e r" and "n.i.g.g.e.r" are the same string by the time
 *           the check runs. Short terms in this tier lean on the allowlist
 *           below: "spic" is here, and so are Spicer, spices, despicable and
 *           suspicious.
 *
 *   WORD    Terms that are ordinary substrings of innocent English and
 *           cannot be allowlisted out one word at a time — the Scunthorpe
 *           family. Matched only as a WHOLE TOKEN, so "Assassin", "Analyst",
 *           "Cockburn", "Uranus" and "Cumming" all pass while the term
 *           standing alone does not. The cost is real and is stated in the
 *           report: a decorated spelling of a term in THIS tier is not
 *           caught, because catching it means rejecting "Scunthorpe".
 *           Plurals are listed explicitly rather than derived with a suffix
 *           rule, because a suffix rule turns "spic" into "spices".
 *
 * COVERAGE
 *   Racial and ethnic slurs, homophobic and transphobic slurs, and sexual
 *   content — the categories that caused the incident this exists for. It
 *   is NOT exhaustive and cannot be: it is a hand-written list of 144
 *   terms, English-only, with no coverage of other languages. It stops the
 *   obvious and the obviously-evaded, not a determined adversary with time.
 * ------------------------------------------------------------------ */

const decode = (b64: string): readonly string[] => Buffer.from(b64, 'base64').toString('utf8').split('\n')

/** Substring tier. 115 terms. sha256:f67e8314c345 */
export const ALWAYS_TERMS: readonly string[] = decode(
  'YWJibwphcnNlaG9sZQphc3NmdWNrCmFzc2hhdAphc3Nob2xlCmFzc3JhcGUKYmFzdGFyZApiYXR0eWJveQpiZWFuZXIKYmVzdGlhbGl0eQpiaXRjaApibG93am9iCmJ1a2tha2UKYnV0dGZ1Y2sKYnV0dGhvbGUKYnV0dHBpcmF0ZQpjYXJwZXRtdW5jaGVyCmNoaWxkcG9ybgpjaGluYW1hbgpjaGluawpjbGl0b3Jpcwpjb2Nrc3Vja2VyCmNvb24KY3JlYW1waWUKY3VtZHVtcApjdW1zaG90CmN1bXNsdXQKY3VubmlsaW5ndXMKY3VudApkYWdvCmRlZXB0aHJvYXQKZGlja2ZhY2UKZGlja2hlYWQKZWphY3VsYXQKZmFnCmZhZ2JveQpmYWdnZXQKZmFnZ2l0CmZhZ2dvdApmZWxjaGluZwpmZWxsYXRpbwpmdWNrCmZ1ZGdlcGFja2VyCmdhbmdiYW5nCmdhc3RoZWpld3MKZ29vawpneXBwbwpoYWxmYnJlZWQKaGFuZGpvYgpoZWViCmhlaWxoaXRsZXIKaGl0bGVyCmhvbG9ob2F4CmluY2VzdAppbmp1bgpqZXJrb2ZmCmpld2JveQpqaWdhYm9vCmppenoKanVuZ2xlYnVubnkKa2FmZmlyCmtpa2UKa2trCmtyYXV0CmxhZHlib3kKbWFzdHVyYmF0Cm1pbGYKbW9sZXN0ZXIKbW9uZ29sb2lkCm1vdGhlcmZ1Y2sKbmVjcm9waGlsCm5lZ3JvCm5lZ3JvaWQKbmlnZ2EKbmlnZ2VyCm5pZ2xldApueW1waG8KcGFlZG9waGlsZQpwYWtpCnBlZG8KcGVkb3BoaWxlCnBlbmlzCnBpa2V5CnBvb2Z0ZXIKcG9yY2htb25rZXkKcHJvc3RpdHV0ZQpwdXNzeQpwdXNzeWxpY2sKcmFwaXN0CnJlZHNraW4KcmV0YXJkCnJpbWpvYgpzYW5kbW9ua2V5CnNoZW1hbGUKc2thbmsKc2x1dApzcGFzdGljCnNwZWFyY2h1Y2tlcgpzcGljCnNxdWF3CnRhcmJhYnkKdGl0ZnVjawp0aXR0aWVzCnRvd2VsaGVhZAp0cmFubmllCnRyYW5ueQp0d2F0CnZhZ2luYQp3YW5rCndldGJhY2sKd2hvcmUKd29wCnlpZAp6aXBwZXJoZWFkCnpvb3BoaWw=',
)

/** Whole-token tier. 29 terms. sha256:61a714a66bf5 */
export const WORD_TERMS: readonly string[] = decode(
  'YW5hbAphbnVzCmFyc2UKYXNzCmFzc2VzCmJvb2JzCmNvY2sKY29ja3MKY3VtCmN1bXMKZnVrCmhvbW8KaG9tb3MKbmF6aQpuYXppcwpwaXNzCnB1YmUKcHViZXMKcmFwZQpyYXBlZApyYXBlcwpzZXgKc2V4ZXMKc2V4eQpzaGl0CnNoaXRzCnRpdAp0aXRzCnRpdHR5',
)

/* ------------------------------------------------------------------ *
 * The allowlist, deliberately in plain text.
 *
 * These are innocent words that contain, or collapse onto, a blocked term.
 * Each occurrence is masked out of the comparison form before the ALWAYS
 * tier runs, so "Scunthorpe" no longer contains anything and "Therapist"
 * stops being an accusation. Masking uses a separator character rather
 * than deletion, so removing a word cannot splice two halves into a new
 * match, and a name that pads an allowlisted word with a real slur still
 * fails.
 *
 * Readable on purpose: this is the list a false-positive report gets added
 * to, and it needs to be easy to find and easy to extend.
 * ------------------------------------------------------------------ */
export const INNOCENT_TERMS: readonly string[] = [
  // place names
  'scunthorpe', 'penistone', 'clitheroe', 'lightwater', 'cockermouth', 'cockfosters',
  'sussex', 'essex', 'middlesex', 'wessex', 'nigeria', 'nigerian', 'niger', 'pakistan',
  'pakistani', 'slutsk', 'titicaca', 'montenegro', 'peninsula',
  // surnames and given names
  'cockburn', 'cocker', 'woodcock', 'hancock', 'babcock', 'hitchcock', 'peacock',
  'glasscock', 'cumming', 'cummings', 'dickens', 'dickinson', 'nigel', 'nigar',
  'titus', 'tito', 'titania', 'fagotti', 'fagotto', 'fagan', 'fagin', 'sexton',
  'cooney', 'dyke', 'dykstra', 'assange', 'cassandra', 'cassidy', 'nazir', 'nazim',
  'nazia', 'wankel', 'abbot', 'abbott',
  // ordinary vocabulary
  'assassin', 'assassinat', 'assam', 'assay', 'assembl', 'assert', 'assess', 'asset',
  'assign', 'assimilat', 'assist', 'associat', 'assort', 'assum', 'assur', 'embassy',
  'class', 'glass', 'grass', 'brass', 'passa', 'compass', 'bass', 'harass', 'morass',
  'analog', 'analys', 'analyt', 'canal', 'banal', 'cucumber', 'circumstan',
  'circumferen', 'accumulat', 'documen', 'cockatiel', 'cockatoo', 'cocktail',
  'cockney', 'cockpit', 'shuttlecock', 'stopcock', 'cockroach', 'therap', 'grape',
  'drape', 'trapez', 'raccoon', 'racoon', 'cocoon', 'tycoon', 'lagoon', 'gobbledygook',
  'sauerkraut', 'shiitake', 'titan', 'title', 'titl', 'constitut', 'institut',
  'attitude', 'entities', 'identities', 'quantities', 'competit', 'petition',
  'repetit', 'appetit', 'homogen', 'homograph', 'homage', 'thomas', 'sextant',
  'sextet', 'suspici', 'spice', 'spicy', 'spicer', 'spick', 'despicable', 'benedict',
  'predict', 'verdict', 'torpedo', 'pedometer', 'pedestri', 'pedigree', 'speedo',
  'spasm', 'squawk', 'swop', 'swoop', 'yiddish', 'negroni', 'retardant', 'pussycat',
  'pussyfoot', 'pussywillow', 'spici', 'spicu', 'milford', 'milfoil',
]
