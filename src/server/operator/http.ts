/* ------------------------------------------------------------------ *
 * Owner-only HTTP surface for the readiness console.
 *
 * Shaped like `handlePvpHttp` in `src/server/pvp/index.ts` — it takes the
 * already-parsed path and method plus the caller's `send`/`fail` writers, and
 * returns whether it handled the request. That keeps the whole feature in new
 * files: mounting it is one line in the router, and the existing response
 * scrubbing in `send()` still applies to everything this returns.
 *
 * Access is deliberately restrictive. The console names every variable an
 * integration wants and quotes provider errors verbatim, which is exactly the
 * sort of thing that should not be readable by an anonymous caller, so the
 * route requires an owner allowlist and returns 404 — not 403 — when it is
 * unset, so an unconfigured deployment does not advertise the endpoint.
 * ------------------------------------------------------------------ */

import { collectReadiness, provePopulatedEnvCannotGoGreen, readinessJson } from './readiness'

type Json = Record<string, unknown> | Array<unknown>
type Send = (status: number, body: Json) => void
type Fail = (status: number, error: string, detail?: string) => void

/**
 * Accounts allowed to read the console, from `WALLY_OPERATOR_ACCOUNTS`.
 *
 * Read on every call rather than cached at import, so revoking an operator does
 * not need a restart.
 */
const operatorAccounts = (): string[] =>
  (process.env.WALLY_OPERATOR_ACCOUNTS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)

export const isOperator = (account: string | null): boolean => {
  const allowed = operatorAccounts()
  return allowed.length > 0 && account !== null && allowed.includes(account)
}

/**
 * Handles the operator routes. Returns false when the path is not ours.
 *
 * `account` must come from the caller's verified session, in the same way
 * `requireWallet()` already does — never from a request body, and never from a
 * query parameter.
 */
export async function handleOperatorHttp(input: {
  path: string
  method: string
  account: string | null
  send: Send
  fail: Fail
}): Promise<boolean> {
  const { path, method, account, send, fail } = input
  if (!path.startsWith('/api/operator/')) return false

  if (method !== 'GET') {
    fail(405, 'method_not_allowed', 'The operator console is read-only.')
    return true
  }
  if (!operatorAccounts().length) {
    // No allowlist configured means the console is not deployed, so it should
    // look absent rather than forbidden.
    fail(404, 'not_found')
    return true
  }
  if (!isOperator(account)) {
    fail(403, 'forbidden', 'This view is owner-only.')
    return true
  }

  if (path === '/api/operator/readiness') {
    const snapshot = await collectReadiness()
    send(200, readinessJson(snapshot) as unknown as Json)
    return true
  }

  if (path === '/api/operator/readiness/env-proof') {
    // The demonstration, exposed so it can be checked from a deployment rather
    // than only from the command line.
    const snapshot = await collectReadiness()
    const proofs = provePopulatedEnvCannotGoGreen(snapshot.rows)
    send(200, {
      allUnchanged: proofs.every(proof => proof.unchanged),
      proofs,
      note:
        'Each row is re-derived with configuration evidence for every variable it wants, plus a mocked ' +
        'confirmed execution. A row whose state moved would be a bug in the derivation.',
    })
    return true
  }

  fail(404, 'not_found')
  return true
}
