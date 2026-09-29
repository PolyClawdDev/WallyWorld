/*
 * Where the browser decides to send its API and RPC calls, and what it says
 * when that turns out to be the wrong place.
 *
 * This is the regression suite for the 404 a player actually hit:
 *
 *   RPC unreachable. 404 : The page could not be found NOT_FOUND arn1::…
 *
 * `arn1` is a Vercel edge region and that body is Vercel's own 404 page, so
 * the JSON-RPC POST had gone to a host that serves the built game files and no
 * API. The two failures that produced it are both covered below: the client
 * silently addressing whatever origin the page came from, and @solana/web3.js
 * quoting a foreign error page back at the player as if the chain had answered.
 *
 * Each scenario re-imports `src/solana/cluster.ts` with a cache-busting query,
 * because the module resolves the base URL once at import time — exactly as it
 * does in a browser, where that happens once per page load.
 *
 * Run with: npm run test:client-config
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { check, equal, finish, section } from './lib/harness'

type FakeWindow = { location: { hostname: string; origin: string; protocol: string; host: string } }

function pageServedFrom(origin: string) {
  const url = new URL(origin)
  ;(globalThis as { window?: FakeWindow }).window = {
    location: { hostname: url.hostname, origin: url.origin, protocol: url.protocol, host: url.host },
  }
}

function noBrowser() {
  delete (globalThis as { window?: FakeWindow }).window
}

let scenario = 0
async function loadCluster(configured: string | undefined) {
  scenario += 1
  if (configured === undefined) delete process.env.VITE_API_BASE_URL
  else process.env.VITE_API_BASE_URL = configured
  return import(`../src/solana/cluster?scenario=${scenario}`) as Promise<typeof import('../src/solana/cluster')>
}

/**
 * The probe takes its URLs as an argument precisely so several deployment
 * shapes can be checked in one process: `src/solana/api.ts` imports
 * `./cluster` by a plain specifier, which ES modules cache once, so a
 * cache-busted cluster would not reach it.
 */
async function loadApi() {
  return import('../src/solana/api') as Promise<typeof import('../src/solana/api')>
}

const targetFor = (origin: string, configured?: string) => ({
  base: configured ?? origin,
  origin: configured ?? origin,
  sameOrigin: configured === undefined,
  rpcUrl: `${configured ?? origin}/api/rpc`,
})

/* ------------------------------------------------------- where it points */

section('the page origin is the default, and a loopback override never escapes this machine')

{
  // The exact shape of the bug report: a static deployment, no API beside it.
  pageServedFrom('https://voxels.vercel.app')
  const c = await loadCluster(undefined)
  equal('a Vercel-hosted page addresses its own origin', c.API_BASE_URL, '')
  equal('which resolves absolutely for web3.js', c.API_ORIGIN, 'https://voxels.vercel.app')
  equal('so the RPC POST went here', c.RPC_PROXY_URL, 'https://voxels.vercel.app/api/rpc')
  check('and the client knows it is assuming, not configured', c.API_IS_SAME_ORIGIN)
}

{
  // The old behaviour: with the repo's own .env baked in, the browser used to
  // call 127.0.0.1:8787 directly, bypassing the dev server's /api proxy.
  pageServedFrom('http://127.0.0.1:5173')
  const c = await loadCluster('http://127.0.0.1:8787')
  equal('a loopback override is ignored in favour of the same origin', c.API_BASE_URL, '')
  equal('so dev traffic goes through the Vite proxy', c.RPC_PROXY_URL, 'http://127.0.0.1:5173/api/rpc')
}

{
  pageServedFrom('http://192.168.1.24:5173')
  const c = await loadCluster('http://127.0.0.1:8787')
  equal('a friend on the LAN is never sent to their own loopback', c.API_ORIGIN, 'http://192.168.1.24:5173')
  equal('the websocket follows the page too', c.wsBaseUrl(), 'ws://192.168.1.24:5173')
}

{
  pageServedFrom('https://play.voxels.example')
  const c = await loadCluster('https://voxels-api.example.com')
  equal('an explicit non-loopback base wins, for a real deployment', c.API_BASE_URL, 'https://voxels-api.example.com')
  equal('and that is where the RPC goes', c.RPC_PROXY_URL, 'https://voxels-api.example.com/api/rpc')
  check('which the client knows is configured rather than assumed', !c.API_IS_SAME_ORIGIN)
  equal('the websocket is derived from it', c.wsBaseUrl(), 'wss://voxels-api.example.com')
}

{
  pageServedFrom('https://play.voxels.example')
  const c = await loadCluster('not a url at all')
  equal('an unparseable override falls back to the page rather than crashing', c.API_BASE_URL, '')
}

{
  noBrowser()
  const c = await loadCluster('http://127.0.0.1:8787')
  equal('outside a browser the configured value is used as-is', c.API_BASE_URL, 'http://127.0.0.1:8787')
}

/* ---------------------------------------------------- what it says when wrong */

section('a host that is not the Voxels API is named as a configuration problem')

/** Answers like a static host: HTML-ish 404 for anything under /api. */
function staticHost(): Promise<{ origin: string; close: () => Promise<void> }> {
  return listen((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('The page could not be found\n\nNOT_FOUND\narn1::tqjl2-1790629403827-3352f6ac7317')
  })
}

/** Answers like this project's own server. */
function voxelsHost(): Promise<{ origin: string; close: () => Promise<void> }> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, cluster: 'devnet', chainId: 'solana:devnet' }))
  })
}

/** Answers 200 with a single-page app's index.html, which is the sneakier case. */
function spaHost(): Promise<{ origin: string; close: () => Promise<void> }> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><head><title>Voxels</title></head><body><div id="root"></div></body></html>')
  })
}

function listen(handler: Parameters<typeof createServer>[0]) {
  const server: Server = createServer(handler)
  return new Promise<{ origin: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      })
    })
  })
}

const api = await loadApi()

{
  const host = await staticHost()
  const probe = await api.probeApi(targetFor(host.origin))
  check('a static host is reported as not the API', !probe.ok && probe.kind === 'not_the_api')
  if (!probe.ok) {
    check('the message names the URL that was tried', probe.detail.includes(`${host.origin}/api/rpc`), probe.detail.slice(0, 90))
    check('it quotes what came back instead', probe.detail.includes('NOT_FOUND'))
    check('it says this is configuration, not a wallet fault', probe.detail.includes('configuration problem'))
    check('and it names the variable that fixes it', probe.detail.includes('VITE_API_BASE_URL'))
    check('it does not blame the chain', !probe.detail.toLowerCase().includes('rpc unreachable'))
  }
  await host.close()
}

{
  // Vercel and friends often serve index.html for an unknown path, so a 200 is
  // not on its own evidence that the API is there.
  const host = await spaHost()
  const probe = await api.probeApi(targetFor(host.origin))
  check('a 200 that is not JSON is still not the API', !probe.ok && probe.kind === 'not_the_api')
  await host.close()
}

{
  const host = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, message: 'hello from some other service' }))
  })
  const probe = await api.probeApi(targetFor(host.origin))
  check('JSON from a different service is not the API either', !probe.ok && probe.kind === 'not_the_api')
  await host.close()
}

{
  const host = await voxelsHost()
  const probe = await api.probeApi(targetFor(host.origin))
  check('the real health record is accepted', probe.ok, probe.ok ? probe.cluster : probe.detail)
  if (probe.ok) equal('and reports the cluster it is serving', probe.cluster, 'devnet')
  await host.close()
}

{
  // A port with nothing on it: the request never completes, which is a
  // different problem from reaching the wrong server and must read differently.
  const dead = await listen((_req, res) => res.end())
  const origin = dead.origin
  await dead.close()
  const probe = await api.probeApi(targetFor(origin))
  check('nothing listening is reported as unreachable, not as the wrong host', !probe.ok && probe.kind === 'unreachable')
  if (!probe.ok) check('and still names where it tried', probe.detail.includes(origin), probe.detail.slice(0, 90))
}

{
  // A configured API that does not resolve must not be described as if the page
  // origin were at fault. `.invalid` is reserved and never resolves (RFC 2606).
  const probe = await api.probeApi(targetFor('https://play.voxels.example', 'https://voxels-api.invalid'))
  check('a configured-but-absent API is unreachable', !probe.ok && probe.kind === 'unreachable')
  if (!probe.ok) check('and blames the configured host, not the page', probe.detail.includes('voxels-api.invalid'))
}

finish('client-config')
