# Wally World

An atmospheric, single-player fantasy town where your wallet has a world.

## Run locally

```bash
npm install
npm run dev
```

The optional demo API runs in a second terminal:

```bash
npm run server
```

## Included in this build

- Entry scene and four original archetypes: MOTH, BRAMBLE, CINDER, and ORBIT.
- Procedural Three.js town district with square, bridge, stream, five landmarks, lanterns, trees, water, lighting, fog, and NPCs.
- Third-person movement with a free mouse cursor, first-person toggle (`V`), run (`Shift`), and interaction proximity.
- Wildlife and hunting: chickens, reindeer, and bears wandering six green regions outside town, each with its own silhouette, threat level, and gold value. One attack ability per archetype, player health with out-of-combat regen and a safe town zone, and a gold forfeit on death.
- Responsive HUD, minimap, map, journal, wallet, settings, and mobile-friendly service panels.
- Archivist demo task with quote, explicit approval, deterministic queued/running/delivered states, local receipt persistence, and “Demo — no real funds” labels.
- A small typed HTTP demo task API at `src/server/index.ts`.

## Truthful integration boundary

This repository does not implement custody, live payments, Solana trading, x402, AP2, Zcash, or live AI providers. Hunting gold is a local demo counter: kills and pickups are written to an in-memory ledger in `src/rewards.ts`, and the 30-minute “pending conversion” window shown in the hunt log is a simulated queue that never pays out. There is no Solana SDK, RPC endpoint, token mint, or payout path in this build, and gold cannot be converted to anything. The demo wallet is simulated and stored locally in the browser. No seed phrase or live deposit is requested. Any production adapter must enforce spend policies outside the model, use integer base units, authenticate ownership, reserve budgets transactionally, and reconcile unknown payment states before retrying.

## Architecture notes

The current visual foundation is intentionally self-contained: `src/main.tsx` contains the playable client and procedural asset kit, while `src/server/index.ts` is a restart-safe-in-process demo boundary for task status. Hunting lives in its own modules — `src/wildlife.ts` (zoning derived from `src/townData.ts`, species, sprites, AI), `src/wildscape.ts` (woodland scenery and trail), `src/combat.ts` (abilities and player vitals), `src/rewards.ts` (demo ledger), and `src/huntHud.tsx` — and is checked by `node scripts/verify-hunt.mjs` against a running dev server. A production migration should move task/payment records to a persistent database and share validated schemas between client and server.

No external art assets are included. Fonts are loaded from Google Fonts for development convenience; bundle a licensed local font before shipping.
