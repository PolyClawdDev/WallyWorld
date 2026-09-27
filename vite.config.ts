import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
  '/ws': { target: 'http://127.0.0.1:8787', ws: true },
} as const

export default defineConfig({
  plugins: [react()],
  // Bind every interface and proxy /api + /ws so a browser that opened
  // http://192.168.x.x:5173 talks to THIS world's API, not its own localhost.
  server: { host: true, port: 5173, strictPort: true, proxy: { ...apiProxy } },
  preview: { host: true, port: 5173, strictPort: true, proxy: { ...apiProxy } },
  // @solana/web3.js imports `buffer` by name. In a production build Rollup
  // resolves that to the npm package, but the dev server externalises it and
  // the app dies on load, so pin it to the userland implementation in both.
  resolve: { alias: { buffer: 'buffer/' } },
  // The Solana packages are only reached when the wallet panel first opens. Left
  // to discover them lazily, the dev server re-optimises and forces a full page
  // reload at that moment, throwing away wherever the player was standing.
  // Naming them here gets it over with at startup.
  // `@noble/curves/ed25519` is deliberately not listed: the root install is
  // v2, which no longer exports that specifier, so naming it here stops the
  // dev server booting at all. The copy actually used is the v1 one nested
  // under @solana/web3.js, and Vite picks that up while optimising web3.js.
  optimizeDeps: {
    include: ['buffer', '@solana/web3.js', '@solana/spl-token', 'bs58'],
  },
})
