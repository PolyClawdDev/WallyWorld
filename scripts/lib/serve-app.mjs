/* ------------------------------------------------------------------ *
 * Two ways to serve the built game, so a verification run can tell them
 * apart.
 *
 * `serveWithApi` is a deployment that puts the game and the API on one
 * origin: static files, with `/api` and `/ws` forwarded to the real
 * server. That is what a correct deployment looks like, and it is also
 * what the Vite dev server does — but unlike the dev server it does not
 * push an HMR reload into the middle of a run when another agent saves a
 * file, which is the failure mode `serve-dist.mjs` already exists to
 * avoid.
 *
 * `serveStaticOnly` is the deployment the player actually hit: a static
 * host with no API behind it, answering every unknown path with its own
 * 404. The body it returns here is the one from the bug report, verbatim,
 * so the check is against the real thing rather than a paraphrase of it.
 *
 * Build the tree these serve with:
 *   NODE_ENV=development npx vite build --mode development --outDir dist-dev
 * ------------------------------------------------------------------ */

import { createServer } from 'node:http'
import { connect } from 'node:net'
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** Vercel's 404, as the player saw it. `arn1` is its Stockholm edge region. */
export const VERCEL_404 = 'The page could not be found\n\nNOT_FOUND\narn1::tqjl2-1790629403827-3352f6ac7317'

async function sendFile(root, pathname, response) {
  const file = join(root, normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, ''))
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    response.end(body)
    return true
  } catch {
    return false
  }
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/** Static files, with `/api` and `/ws` forwarded to the real API. */
export function serveWithApi(apiTarget, root = 'dist-dev') {
  const upstream = new URL(apiTarget)
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x')
    if (pathname.startsWith('/api/')) return proxy(req, res, upstream)
    if (await sendFile(root, pathname, res)) return
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.on('upgrade', (req, socket, head) => tunnel(req, socket, head, upstream))
  return listen(server)
}

/** Static files only. Everything else gets a static host's 404, like Vercel's. */
export function serveStaticOnly(root = 'dist-dev') {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x')
    if (!pathname.startsWith('/api/') && (await sendFile(root, pathname, res))) return
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(VERCEL_404)
  })
  return listen(server)
}

function proxy(req, res, upstream) {
  const forwarded = request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: upstream.host },
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  forwarded.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'upstream_unreachable' }))
  })
  req.pipe(forwarded)
}

/** Raw socket tunnel, which is all a WebSocket upgrade needs. */
function tunnel(req, socket, head, upstream) {
  const target = connect(Number(upstream.port), upstream.hostname, () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n')
    target.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head?.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
  target.on('error', () => socket.destroy())
  socket.on('error', () => target.destroy())
}
