/* ------------------------------------------------------------------ *
 * Sign-In With Solana message format, shared by client and server.
 *
 * Why this lives in one file imported by both sides: the client must be
 * able to rebuild, byte for byte, the message it is about to ask Phantom
 * to sign, and the server must rebuild the same bytes to verify it. If
 * the server simply handed the client a finished string to sign, a
 * compromised or spoofed server could put arbitrary text in front of the
 * user. Here the server only supplies *fields* (notably the nonce); the
 * client assembles the text itself and refuses anything that does not
 * match the template below.
 *
 * The layout follows the SIWS / EIP-4361 convention so the text reads as
 * a recognisable sign-in prompt inside Phantom. It is a plain UTF-8
 * message and is never a transaction: signing it can move no funds.
 * ------------------------------------------------------------------ */

/** Fixed wording. The server may not vary this, so the user always sees the same prompt. */
export const SIWS_STATEMENT =
  'Sign in to Voxels. This proves you control this wallet. It is not a transaction, it costs no fees, and it cannot move funds.'

/**
 * Fixed wording for the *account link* challenge, which is a different thing
 * from signing in and must therefore be different bytes: a sign-in signature
 * cannot be replayed as a link, nor a link signature as a sign-in.
 *
 * It lives here rather than in the server's `identity/claim.ts` because the
 * client has to rebuild the exact text it is about to sign — the same reason
 * the sign-in statement is here.
 */
export const LINK_STATEMENT =
  'Link this wallet to your Voxels account. This proves you control this wallet. It is not a transaction, it costs no fees, and it cannot move funds.'

export const SIWS_VERSION = '1'

/** Longest sign-in window the client will accept from the server. */
export const SIWS_MAX_TTL_MS = 10 * 60 * 1000

export type SiwsFields = {
  domain: string
  address: string
  uri: string
  statement: string
  version: string
  chainId: string
  nonce: string
  issuedAt: string
  expirationTime: string
}

/** Deterministic text for the given fields. Both sides must produce identical output. */
export function buildSiwsMessage(fields: SiwsFields): string {
  return [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.address,
    '',
    fields.statement,
    '',
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expirationTime}`,
  ].join('\n')
}

/** Base58 alphabet: no 0, O, I or l. Used to sanity-check addresses on both sides. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function looksLikeAddress(value: unknown): value is string {
  return typeof value === 'string' && BASE58_ADDRESS.test(value)
}

/** Nonces are hex from `randomBytes`, so the accepted shape is deliberately narrow. */
export function looksLikeNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,128}$/.test(value)
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export type SiwsCheck = { ok: true; fields: SiwsFields } | { ok: false; reason: string }

/**
 * Validates server-supplied fields against what this client expects *before*
 * anything is put in front of the user. `expected` comes from the running
 * page, never from the response being checked.
 */
export function checkSiwsFields(
  candidate: unknown,
  expected: { domain: string; uri: string; address: string; chainId: string; statement?: string },
  now = Date.now(),
): SiwsCheck {
  // Defaults to the sign-in wording, so an existing caller cannot be handed a
  // link challenge and sign it thinking it was a sign-in.
  const statement = expected.statement ?? SIWS_STATEMENT
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'malformed sign-in challenge' }
  const f = candidate as Record<string, unknown>

  if (f.domain !== expected.domain) return { ok: false, reason: `challenge domain "${String(f.domain)}" is not this site` }
  if (f.uri !== expected.uri) return { ok: false, reason: 'challenge URI is not this site' }
  if (f.address !== expected.address) return { ok: false, reason: 'challenge is for a different wallet address' }
  if (f.chainId !== expected.chainId) return { ok: false, reason: 'challenge is for a different Solana cluster' }
  if (f.statement !== statement) return { ok: false, reason: 'challenge statement was altered' }
  if (f.version !== SIWS_VERSION) return { ok: false, reason: 'unsupported challenge version' }
  if (!looksLikeNonce(f.nonce)) return { ok: false, reason: 'challenge nonce is malformed' }
  if (!looksLikeAddress(f.address)) return { ok: false, reason: 'challenge address is malformed' }
  if (!isIsoInstant(f.issuedAt) || !isIsoInstant(f.expirationTime)) return { ok: false, reason: 'challenge timestamps are malformed' }

  const expires = Date.parse(f.expirationTime as string)
  if (expires <= now) return { ok: false, reason: 'challenge already expired' }
  if (expires - now > SIWS_MAX_TTL_MS) return { ok: false, reason: 'challenge lifetime is longer than this client allows' }

  return {
    ok: true,
    fields: {
      domain: f.domain as string,
      address: f.address as string,
      uri: f.uri as string,
      statement: f.statement as string,
      version: f.version as string,
      chainId: f.chainId as string,
      nonce: f.nonce as string,
      issuedAt: f.issuedAt as string,
      expirationTime: f.expirationTime as string,
    },
  }
}
