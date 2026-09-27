import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

/**
 * Serves a built copy of the app from inside the verification process.
 *
 * The dev server is shared with other agents working in this repo, and their
 * saves push HMR reloads that wipe a run half way through. A static build keeps
 * the page still for the length of a test. Build it in development mode so the
 * window.__wally probe the checks rely on is still compiled in:
 *
 *   NODE_ENV=development npx vite build --mode development --outDir dist-dev
 */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

export async function serveDist(root = process.env.DIST ?? 'dist-dev') {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
    const file = join(root, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}
