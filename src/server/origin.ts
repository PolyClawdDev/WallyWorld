/* ------------------------------------------------------------------ *
 * The application domain a signed challenge is bound to.
 *
 * Taken from the request's own Origin header and checked against the
 * allowlist, never from the request body — so a caller cannot ask to be
 * issued a challenge bound to somebody else's site. Both the sign-in
 * challenge and the wallet-link challenge read the domain from here, so
 * there is one definition of "this application" rather than two that could
 * drift apart.
 * ------------------------------------------------------------------ */

import type { IncomingMessage } from 'node:http'
import { isAllowedDomain } from './auth'
import { isAllowedBrowserOrigin, isAllowedPageHost } from './config'

export type OriginContext = { domain: string; uri: string }

export function originContext(req: IncomingMessage): OriginContext | null {
  const origin = req.headers.origin?.replace(/\/+$/, '')
  if (!origin || !isAllowedBrowserOrigin(origin)) return null
  try {
    const url = new URL(origin)
    return isAllowedDomain(url.host) || isAllowedPageHost(url.host) ? { domain: url.host, uri: origin } : null
  } catch {
    return null
  }
}
