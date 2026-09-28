/* ------------------------------------------------------------------ *
 * The WebSocket upgrade route.
 *
 * This is the only door into the live world, so it is also the only place
 * the world can be protected. Everything below happens before a socket
 * exists, because once the handshake completes the connection costs
 * memory, a claim and a slot in the room whether or not the client ever
 * says anything useful.
 *
 * Behind a TLS terminator the upgrade arrives as plain HTTP with the
 * original scheme in `X-Forwarded-Proto`. That is fine — the browser's
 * connection is `wss://` and the hop from the router to this process
 * never leaves the platform's network — but it does mean nothing here may
 * infer "insecure" from the socket it was handed.
 * ------------------------------------------------------------------ */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { ALLOWED_ORIGINS, IS_PRODUCTION, isAllowedBrowserOrigin } from '../config'
import { clientAddress, upgradeRateLimited } from '../net'
import { handlePvpHttp, type Fail, type Send } from './http'
import { attachLive, occupancy } from './hub'
import { acceptUpgrade, isUpgrade } from './socket'
import './schema'

export { handlePvpHttp }

/** Refuses the handshake with a real status line, so the client learns why. */
function refuse(socket: Duplex, status: number, reason: string) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    )
  } catch {
    /* the peer is already gone */
  }
  socket.destroy()
}

export function attachPvpUpgrade(server: Server) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (url.pathname.replace(/\/+$/, '') !== '/ws/pvp') {
      refuse(socket, 404, 'Not Found')
      return
    }
    if (!isUpgrade(req)) {
      refuse(socket, 400, 'Bad Request')
      return
    }

    // The handshake is the cheapest thing an attacker can repeat, and each one
    // that succeeds costs a socket. Budget it by address before anything else.
    if (upgradeRateLimited(req)) {
      refuse(socket, 429, 'Too Many Requests')
      return
    }

    const origin = (req.headers.origin ?? '').replace(/\/+$/, '')
    // A browser always sends Origin on an upgrade. In production its absence
    // means the caller is not a page, and the allowlist is the only thing
    // standing between this world and every script on the internet — a
    // WebSocket upgrade is not subject to the same-origin policy, so there is
    // no browser-side check to fall back on.
    if (IS_PRODUCTION && !origin) {
      refuse(socket, 403, 'Forbidden')
      return
    }
    if (origin && !isAllowedBrowserOrigin(origin)) {
      refuse(socket, 403, 'Forbidden')
      return
    }

    // Room capacity is not checked here. `attachLive` can tell a player
    // reconnecting to a character that is already in the room from a genuinely
    // new arrival, and only it can say so over the socket in a form the client
    // can show. Refusing the handshake would look identical to a network fault.
    const token = url.searchParams.get('token')
    const conn = acceptUpgrade(req, socket)
    if (!conn) {
      refuse(socket, 400, 'Bad Request')
      return
    }
    attachLive(token ? `Bearer ${token}` : req.headers.authorization, conn)
  })
}

/** Reported on /api/health so operators can see the policy that is live. */
export function upgradePolicy() {
  return {
    path: '/ws/pvp',
    allowedOrigins: ALLOWED_ORIGINS,
    originRequired: IS_PRODUCTION,
    ...occupancy(),
  }
}

export { clientAddress }
export type { Send, Fail }
