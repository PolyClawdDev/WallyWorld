import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Where the dev/preview server forwards `/api` and `/ws`.
 *
 * Read from the environment rather than hardcoded so a second world can
 * be brought up alongside an existing one — which is what verification
 * needs, and what a hardcoded port makes impossible. Production does not
 * use any of this: the built bundle is static files, and the API lives
 * wherever `VITE_API_BASE_URL` says.
 */
const API_TARGET = process.env.WALLY_API_TARGET || 'http://127.0.0.1:8787'
const UI_PORT = Number(process.env.WALLY_UI_PORT || 5173)

const apiProxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/ws': { target: API_TARGET, ws: true },
} as const

export default defineConfig({
  plugins: [react()],
  // Bind every interface and proxy /api + /ws so a browser that opened
  // http://192.168.x.x:5173 talks to THIS world's API, not its own localhost.
  server: { host: true, port: UI_PORT, strictPort: true, proxy: { ...apiProxy } },
  preview: { host: true, port: UI_PORT, strictPort: true, proxy: { ...apiProxy } },
  // @solana/web3.js imports `buffer` by name. In a production build Rollup
  // resolves that to the npm package, but the dev server externalises it and
  // the app dies on load, so pin it to the userland implementation in both.
  resolve: { alias: { buffer: 'buffer/' } },
  // The Solana packages are only reached when the wallet panel first opens. Left
  // to discover them lazily, the dev server re-optimises and forces a full page
  // reload at that moment, throwing away wherever the player was standing.
  // Naming them here gets it over with at startup.
  // `@noble/curves/ed25519` (no extension) is deliberately not listed: the
  // root install is v2, whose export map only has `./ed25519.js`, so naming
  // the extensionless specifier stops the dev server booting at all. The
  // explicit `.js` form below is the one v2 publishes, and the embedded
  // wallet signs with it.
  optimizeDeps: {
    include: ['buffer', '@solana/web3.js', '@solana/spl-token', 'bs58', '@noble/curves/ed25519.js'],
  },
})
