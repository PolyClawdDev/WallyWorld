# Repository audit — 27 September 2026

Inventory of what actually exists in this repository today, mapped against the fourteen
sections of the implementation specification. Read-only: no source file was modified to
produce this.

Caveat on freshness: four other agents were editing this repository concurrently while
this audit was taken (combat system, character redesign, UI restyle, Solana wallet
integration). At the time of reading, `git status` showed uncommitted modifications to
`.gitignore`, `package.json`, `scripts/serve-dist.mjs`, `scripts/wardrobe.mjs`,
`src/characters.ts`, `src/combat.ts`, `src/combatHud.css`, and `src/huntHud.tsx`, plus
untracked `screenshots/`, `scripts/tmp-boot.mjs`, `scripts/verify-combat.mjs`, and
`scripts/verify-wallet-ui.ts`. Details in those files may have moved since.

---

## 1. Shape of the codebase

21,788 lines of TypeScript/TSX/CSS across `src/`, plus ~3,500 lines of verification
scripts in `scripts/`. Two commits on the branch: `8e20430` (voxel town, hunting, NPCs,
wallet pouch) and `f35fe54` (Phantom wallet, combat HUD, in-world UI pass, wildlife fixes).

### Frontend

| Area | Files | Notes |
| --- | --- | --- |
| Entry / world host | `src/main.tsx` (720) | React root, character select, `WorldCanvas`, panel routing, key handling. `INTERACT_RANGE = 5`, `TAP_MS = 200` disambiguating WASD movement from Q/W/E/R abilities. |
| Characters | `src/characters.ts` (1397) | Four archetypes MOTH, BRAMBLE, CINDER, ORBIT; voxel builder, wardrobe, `animateCharacter`. |
| Town data | `src/townData.ts` (96) | **Single source of truth for the town plan.** 17 `buildingSpecs`, 8 `serviceNpcs`, streets/plaza/canal/bridges, `perimeterTrees()`, `districts`. The decorative `ambientNpcs` crowd was removed: the town is populated by real players. |
| NPC models | `src/npcs.ts` (1109) | Voxel sprite builder plus 8 hand-authored `namedDesigns`, one per service NPC. An unnamed NPC is an error, not a generic resident. |
| Map | `src/WorldMap.tsx` (282) | SVG map drawn from `townData.ts` — a projection of the real world, 1 SVG unit = 1 metre. |
| Panels / HUD | `src/panels.tsx`, `src/Popup.tsx`, `src/huntHud.tsx`, `src/combatHud.tsx` (479) | Journal, settings, hunt log, combat HUD with ability book and tooltips. |
| Wallet pouch | `src/Wallet.tsx` (399) | Local demo inventory with **working drag-and-drop onto NPCs** via `npcAtScreen()` raycast. `demo = true` default. |
| Styles | `styles.css`, `worldUi.css` (824), `hunt.css` (409), `combatHud.css` (686), `solana/solana.css` | `worldUi.css` loads last on purpose so the UI kit wins on equal specificity. |

**Correction to the brief:** `serviceNpcs` is defined in `src/townData.ts`, not
`src/main.tsx`. `main.tsx` imports it (line 11) and spawns the models (line 328).
`WorldMap.tsx` consumes the same array (line 187), which is why the map and the world
cannot drift apart.

### Three.js world

Built in `main.tsx`'s `WorldCanvas`: scene with fog (`#5d7180`, 58–190), perspective
camera at 66°, `PCFSoftShadowMap`, hemisphere + directional "moon" light, procedural town
from `townData.ts`, third-person controls with first-person toggle (`V`), run (`Shift`),
click-to-move resolved against a nav grid. Supporting modules: `src/wildscape.ts` (390,
woodland scenery, registers obstacles), `src/wildlife.ts` (1366, six spawn regions,
species specs, sprites, AI), `src/battle/nav.ts` (420, nav grid from town + wildscape
obstacles), `src/battle/rig.ts`, `src/battle/vfx.ts` (676), `src/battle/audio.ts`.

### The eight service NPCs that exist today

From `src/townData.ts:31-40`, with models in `src/npcs.ts:352-620`:

| Name in code | Design key | Position (x, z) | Nearest building |
| --- | --- | --- | --- |
| `MIRA · GUIDE` | `MIRA` | 3.5, 5.2 | town plaza |
| `LYRA · ARCHIVIST` | `LYRA` | −52, 36 | The Archive (−59, 43) |
| `VELLUM · MERCHANT` | `VELLUM` | 65, −7 | Market Hall (72, 0) |
| `SABLE · ALCHEMIST` | `SABLE` | 43, −9 | Potion Shop (50, −16) |
| `BRONZE · BLACKSMITH` | `BRONZE` | 43, 11 | Workshop (50, 18) |
| `PIP · COURIER` | `PIP` | 43, 43 | Post Office (50, 50) |
| `ASTRA · ORRERY KEEPER` | `ASTRA` | −68, 61 | Observatory (−72, 70) |
| `NELL · INNKEEPER` | `NELL` | −10, 10 | Hearth Inn (−17, 16) |

Each has a distinct silhouette, height, accent colour, and a hand-built prop
(`guideProp`, `archivistProp`, `merchantProp`, `alchemistProp`, and so on), so §8's
"distinct model/silhouette" requirement is already largely satisfied in art terms.

**But the roster does not match the specification.** §8 names Courier, Archivist, Broker,
Watcher, Maker, Artificer, Steward, Guildmaster. Only **Courier** and **Archivist** exist
by role. The plausible mapping and the gaps:

| Spec NPC | Spec location | Existing candidate | Existing building | Gap |
| --- | --- | --- | --- | --- |
| Courier | Post Office | `PIP · COURIER` | Post Office ✅ | Role matches; no executor |
| Archivist | Archive | `LYRA · ARCHIVIST` | The Archive ✅ | Role matches; no executor |
| Broker | Exchange | `VELLUM · MERCHANT` | Market Hall (≈) | Rename + no "Exchange" building |
| Watcher | Watchtower | `ASTRA · ORRERY KEEPER` (≈) | Observatory (≈) | **No Watchtower** |
| Maker | Workshop | `BRONZE · BLACKSMITH` | Workshop ✅ | Rename; no executor |
| Artificer | Agent Forge | `SABLE · ALCHEMIST` (weak) | — | **No Agent Forge building** |
| Steward | Hearth | `NELL · INNKEEPER` | Hearth Inn ✅ | Rename; no executor |
| Guildmaster | Guild Hall | `MIRA · GUIDE` (weak) | — | **No Guild Hall building** |

A character-redesign agent is working concurrently, so this mapping may be in flux.

### Combat and progression

| File | Lines | Contents |
| --- | --- | --- |
| `src/combat.ts` | 80 | **Only player vitals now.** `PLAYER_MAX_HP = 100`, 6 s regen delay, 7 hp/s out of combat, 26 hp/s in the safe zone, 2.5 s respawn invulnerability, knockback impulse, death callback. The header records that abilities moved to `src/battle/`. |
| `src/battle/engine.ts` | 1897 | The battle system: targeting, casting, projectiles, damage application, XP award. |
| `src/battle/kits.ts` | 643 | Four elements, per-character `CharacterKit` with Q/W/E/R `AbilityDef`s, basic attack, passive, resource, rank scaling, `XP_PER_SPECIES`. |
| `src/battle/progression.ts` | 218 | **`MAX_LEVEL = 15`** as §1 requires. Normal ranks max 4 unlocking at levels 1/3/5/7; ultimate max 3 at 6/11/15. `applyXp`, `applyUpgrade`, `sanitise`, `localStorage` key `wally.progression.v1`. |
| `src/battle/store.ts`, `rules.ts`, `icons.tsx`, `nav.ts`, `vfx.ts`, `audio.ts` | 1,662 | State, rules, ability icons, navigation, effects, sound. |
| `src/combatHud.tsx` + `.css` | 1,165 | Portrait, ability slots, tooltips, ability book. |

Progression is persisted **only in `localStorage`**, not server-side.

### Backend — `src/server/` (1,180 lines across 6 files)

| File | Lines | What it does |
| --- | --- | --- |
| `index.ts` | 556 | Node `http` server, no framework. Routes: `/api/rpc`, `/api/health`, `/api/auth/{nonce,verify,me,logout}`, `/api/profile`, `/api/payments/{quote,receipt,recheck,receipts}`, `/api/payouts/status`, `/api/tasks`. Origin-allowlist CORS (never `*`), bearer tokens (so no CSRF surface), 32 KiB body cap with a 1 MiB drain ceiling so oversized bodies get a real 413, fixed-window rate limits (120/min general, 240/min RPC), periodic sweeps. Every response passes through `redact()`. |
| `config.ts` | 132 | Environment-only config. **Per-cluster RPC resolution**: `SOLANA_RPC_URL_<CLUSTER>` → `SOLANA_RPC_URL` → public endpoint (test clusters only). Mainnet without a provider URL throws at startup. `RPC_URL` treated as a credential; only `RPC_SOURCE_VAR` is ever printed. `PAYOUTS_ENABLED = false as const`. |
| `db.ts` | 348 | SQLite via `better-sqlite3`, WAL, `foreign_keys = ON`, `busy_timeout = 4000`. Tables: `profiles`, `nonces`, `sessions`, `receipts`, `demo_tasks`. Lamports stored as **TEXT decimal integers** so amounts round-trip as exact bigints. All statements prepared and parameterised. |
| `auth.ts` | 168 | Sign-In With Solana. 32-byte CSPRNG nonce bound to wallet + domain + chain, inside the signed bytes; ed25519 verification via `@noble/curves`; the verified message is **rebuilt server-side from the stored row**, never from the request body; single-use consumption via one conditional `UPDATE`; session tokens are opaque random bytes stored only as SHA-256. |
| `chain.ts` | 106 | `verifyClusterIdentity()` compares the RPC genesis hash against the expected cluster. `verifyTransfer()` re-derives payer, recipient and amount **from transaction metadata balance deltas**, not from client claims, and returns five distinct verdicts including a deliberately preserved `unknown`. |
| `rpcProxy.ts` | 175 | Not an open relay: a 17-method allowlist, `requestAirdrop` on test clusters only, no whole-block or full-history scans, batch cap 10, 15 s upstream timeout, 6 MiB response cap, no client headers forwarded, non-JSON upstream responses refused, upstream 401/403 remapped to 502. |
| `redact.ts` | 123 | Scrubs the RPC endpoint out of every response body, log line and error message, at the single `send()` choke point. |

### Solana integration — `src/solana/` (1,389 lines across 12 files)

> **Superseded after this audit was taken.** Phantom was removed from the wallet
> on the owner's instruction: the browser-held keypair covers every player, a
> second optional path only made the panel ambiguous, and the planned gold payout
> has the treasury sign and send. `phantom.ts`, `profileSync.ts` and
> `playerBridge.ts` were deleted; `wallet.ts` became `clientStatus.ts` and now
> holds only the RPC/API/cluster health the panel reports; `payments.ts` lost
> `signAndSend` and `checkAffordable`, so **no client path can sign or submit a
> transaction at all**; `FundsMode` dropped to two states, `demo` and `live`,
> decided by the cluster alone; and `PAYMENTS_ENABLED` is now hardcoded false so
> `/api/health` stops advertising a capability nothing can reach. The paragraph
> below describes the repository as it stood on 27 September 2026 and is kept for
> that reason.

`cluster.ts` (176) is the source of truth for whether real funds are in play: devnet
default, `mainnet-beta` an explicit opt-in, and a three-state `FundsMode`
(`demo` / `test` / `live`) whose asymmetry is deliberate — `live` depends only on the
configured cluster, so the mainnet warning is up *before* the first click. It **refuses
`VITE_SOLANA_RPC_URL` outright on mainnet**, because any `VITE_*` value is compiled into
the public bundle and a keyed provider URL is a credential. `rpc.ts` (132) points the
browser at the backend proxy by default. `phantom.ts` (99) and `wallet.ts` (359) handle
connection, account change, disconnect. `payments.ts` (185) plans a SOL transfer, quotes
the real fee via `getFeeForMessage`, checks affordability, hands the unsigned transaction
to Phantom, and then `awaitConfirmation()` reports **five** outcomes — `confirmed`,
`failed`, `expired`, `timeout`, `unknown` — deliberately not using
`connection.confirmTransaction`, which collapses several of these into a throw.
`api.ts` (168) is the typed API client; `WalletPanel.tsx` (559) is the panel;
`FundsBadge.tsx`, `units.ts`, `profileSync.ts`, `playerBridge.ts` complete it.
`src/shared/` holds `siws.ts`, `profile.ts`, `clusters.ts` — validated schemas genuinely
shared by client and server.

### Persistence

SQLite at `data/wally.db` (gitignored), plus `data/wally-mainnet-test.db` and
`data/wally-mismatch-test.db` from verification runs. Five tables (above). **No
migrations framework.** `localStorage` additionally holds the session token
(`wally-session-v1`), combat progression (`wally.progression.v1`), and the demo pouch.

### Rewards ledger — `src/rewards.ts` (136)

Module-level in-memory demo ledger. Integer base units end to end
(`GOLD_DECIMALS = 0`), 40-entry ring buffer, `KILL`/`PICKUP`/`DEATH` kinds,
`DEATH_LOSS_PERCENT = 40`, a 30-minute window that rolls forward on read and **never pays
out**, and `PAYOUT_STATUS = 'UNAVAILABLE · NO VERIFIED ADAPTER CONFIGURED'` with
`payoutImplemented: false` as a literal type. Not persisted; lost on reload. The server
mirrors this at `/api/payouts/status` and returns 501 for any `POST /api/payouts*`.

### `.env.example` — variable names and comments only

Client: `VITE_SOLANA_CLUSTER`, `VITE_SOLANA_RPC_URL`, `VITE_API_BASE_URL`.
Server: `PORT`, `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `WALLY_DB_PATH`,
`WALLY_ALLOWED_ORIGINS`, `WALLY_SIWS_DOMAINS`, `WALLY_NONCE_TTL_MS`,
`WALLY_SESSION_TTL_MS`. NPC payments: `NPC_PAYEE_ADDRESS`,
`NPC_SERVICE_PRICE_LAMPORTS`.

The file's own framing: "There is no private key or seed phrase in this configuration, and
none is needed"; "No secret belongs in any `VITE_*` value"; `NPC_PAYEE_ADDRESS` is "a
PUBLIC KEY only"; and a closing "not implemented" section stating gold payout "is
hardcoded off in `src/server/config.ts`" and "There is no WALLY token mint".

**Drift, partly resolved during this audit:** at the time of reading, `config.ts` supported
cluster-scoped `SOLANA_RPC_URL_MAINNET_BETA` (and equivalents) while `.env.example`
documented only the generic `SOLANA_RPC_URL`. A concurrent agent added
`SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_URL_TESTNET` and `SOLANA_RPC_URL_MAINNET_BETA` to the
template while this audit was in progress, so that gap is now closed. Still undocumented:
the script-only variables `VERIFY_API`, `APP_HOST`, `HARNESS_HOST`, `UI_*`, `SHOTS`, `DIST`.

`.env` exists on disk. It was **not opened and no value from it is reproduced anywhere**.

### Verification scripts

`verify-solana.ts` (543), `verify-combat.mjs` (778), `verify-hunt.mjs` (445),
`verify-rpc-proxy.ts` (280), `verify-pouch.mjs` (253), `verify-wallet-ui.ts` (252),
`verify-drag.mjs` (220), plus `test-combat.ts` (399) and Puppeteer screenshot helpers.
`package.json` scripts: `dev`, `build` (`tsc -b && vite build`), `preview`, `server`,
`verify:solana`, `verify:proxy`, `verify:ui`, `test:combat`, `verify:combat`.
Devnet wallet-panel screenshots exist under `screenshots/solana/`. (`verify-wallet-ui.ts`
was rewritten after this audit: it no longer mocks a provider, and instead injects a decoy
`window.phantom` and asserts nothing in the client ever touches it.)

### The decisive negative finding

```
grep -rn -i "x402|jupiter|jup.ag|near-intents|chaindefuser|zcash|zec" src/   → no matches
grep -rn -i "openai|anthropic|claude|gemini|replicate|stability|tavily|serper|perplexity" src/   → no matches
```

**There is no x402, Jupiter, NEAR Intents, Zcash, or language-model integration in this
repository at all — not even a stub.** `package.json` has seven runtime dependencies:
`@noble/curves`, `@solana/spl-token`, `@solana/web3.js`, `better-sqlite3`, `bs58`,
`react`/`react-dom`, `three`. The README states this boundary explicitly and accurately.

---

## 2. Section-by-section status

Legend: **Exists** · **Partial** · **Absent**

### §1 Product and scope

**Partial.** World, four archetypes, movement, combat, and progression to level 15 all
exist and are good. Eight service NPCs exist as models and map markers. What is absent is
the entire premise: no NPC executes a real task, there are no deliverables, no task
composer, no approval screen showing a full price, and no flagship SOL→shielded-ZEC job.
The one thing resembling a job is a scripted Archivist demo that advances
queued→running→delivered on `setTimeout` (`index.ts:489-502`) with a cost denominated in
demo credits.

Correctly satisfied already: "Combat level must never increase spending authority" — there
is no link whatsoever between `src/battle/progression.ts` and anything financial.

### §2 Inspect first and verify the integrations

**Now exists** — this audit plus `docs/integration-matrix.md`. Nothing existed before.

### §3 Wallet connection, account ownership, and funding

**Partial, and the strongest area in the repo.**

Exists: Phantom connection with account-change/disconnect handling; nonce-based SIWS bound
to domain, chain and expiry with single-use consumption; real balance reads through a
credential-preserving proxy; integer base units as `bigint` throughout; real fee quoting
via `getFeeForMessage` plus `checkAffordable`; a working drag of a pouch item onto an NPC
that spends nothing; a three-state funds label that cannot drift.

Absent: **multi-wallet support** (Phantom only, no wallet-standard adapter); SPL token
balance display resolved by mint (the proxy allowlists `getTokenAccountsByOwner` and
`getTokenAccountBalance`, so the plumbing is there, but no UI consumes it); a MAX control
with fee reservation; a real task composer behind the drag (it currently toasts); and any
SOL→USDC conversion for x402 funding.

> **Superseded.** Phantom connection, the balance view, the per-wallet character
> save and the NPC payment UI were all removed with the extension — see the note
> in §1. What remains, and what the panel is now: one browser-held keypair per
> player, account claim by signature over a server-issued single-use nonce,
> export/import/delete, and a payout that states why it is unavailable. Funding
> means sending SOL to that address from a wallet of your own; nothing in the app
> can spend it. "Multi-wallet support" is no longer an absence to close but a
> direction that was deliberately reversed.

### §4 Bounded agent authority and the execution model

**Absent.** No authorization record, no binding of owner/NPC/job/version, no
maximum-principal or maximum-total-debit fields, no expiry or revocation, no budget
reservations, no transactional concurrency control over a shared balance.

The *ground truth* is favourable, though: the server holds **no keys and cannot sign**, and
says so at `/api/health` (`custody: 'none — this server holds no keys and cannot sign'`).
Every handler derives the wallet from `requireWallet(req, res)` and never from a request
body, which is already the owner-scoped-access discipline §4 and §10 demand. This is the
right foundation; the authority model on top of it does not exist.

### §5 Implement x402 as a real payment flow

**Absent as x402.** What exists is a real, non-x402 Solana payment: server-decided price
and recipient at `/api/payments/quote`, user-signed transfer, receipt keyed idempotently on
the signature, and server-side verification against chain metadata with five verdicts.
`reconcile()` deliberately preserves `unknown` rather than guessing.

This is genuinely useful scaffolding — it is the payment-state-machine half of §5 — but
there is no `PAYMENT-REQUIRED` response, no `PAYMENT-SIGNATURE` header, no facilitator, no
`@x402/*` dependency, and only one hardcoded service (`archivist.town-history-brief`).
Per the matrix, labelling the existing SOL transfer "x402" would be a false claim; the code
does not do that.

### §6 The Courier's complete SOL-to-shielded-ZEC job

**Entirely absent.** No Zcash code, no conversion provider, no wallet service, no address
parser, no shielding, no quote persistence. See `docs/integration-matrix.md` §9 for why
this is also *blocked*, not merely unbuilt.

### §7 Accurate privacy and payment UX

**Partial, and unusually strong on the honesty requirements.** `fundsLabel()` gives three
non-overlapping states with plain-language long text. `ConfirmOutcome` and `TransferVerdict`
both refuse to collapse "we don't know" into success or failure. `PAYOUT_STATUS` and
`/api/payouts/status` state unavailability with a real reason. Nothing in the world
broadcasts addresses or balances. The README's "Truthful integration boundary" section is
accurate.

Absent: the plain-language job pipeline (Ready for approval → … → Refunding), per-stage
labelling of public vs shielded, the disclosure of who can see what, and the
shielded-payment evidence model (outgoing wallet records rather than a public explorer).

### §8 Implement all eight NPCs

**Partial — the art, not the agents.** Eight distinct models with props, locations, map
markers, accent colours, and a 5 m interaction radius. Zero tool permissions, task
composers, progress states, or completion artifacts. Six of the eight roles are absent
entirely, and two buildings (Guild Hall, Watchtower) and the Agent Forge do not exist. See
the mapping table above.

### §9 The real agent runtime and service economy

**Absent.** No language-model provider, no tool-calling, no schema validation for tool
calls, no service registry, no creator earnings, no platform fees, no reputation. Not one
credential or line of code toward it.

### §10 Persistence, workers, and recovery

**Partial.** Real transactional SQLite with WAL and prepared statements; exact-integer
amount storage as TEXT; idempotent receipt insertion via `on conflict do nothing`;
single-use nonce consumption via a conditional `UPDATE` that is safe under concurrency;
periodic sweeps; owner scoping on every row; append-only-ish receipts; redacted logs.

Absent: any durable job queue (the demo task uses `setTimeout(...).unref()`, which loses
work on restart — the row survives but the timer does not); migrations; the full entity
model §10 lists (services, quotes, authorizations, reservations, task steps, payment
attempts, conversion attempts, Zcash operations, ledger entries, monitors, artifacts);
independent state machines per concern; idempotency at anything other than receipt
insertion; webhook verification; and separation of game data from financial records
(`profiles.gold` sits in the same database as `receipts`).

### §11 Finish the in-world interactions

**Partial.** Proximity prompts at a shared 5 m radius for both prompt and action; compact
panels that keep the world visible; input pausing while panels are open;
`TAP_MS`-based disambiguation so Q/W/E/R are not stolen by WASD; working drag with a
`npcAtScreen()` raycast; mobile-friendly panels; a real map and minimap.

Absent: per-profession action menus, task-specific occupational animations, a job
notification system, a direct service directory reachable without crossing the map,
inventory scrolls with real open/download actions, and cross-refresh task persistence.
Worth noting §11's "Game death must not lose real funds" is currently satisfied only
because no real funds exist in gameplay — `debitDeath()` takes 40% of demo gold.

### §12 Configuration and operating environments

**Partial.** `.env.example` is careful, well-commented, secret-free, and explains *why*
each rule exists. Startup validation exists and is real: mainnet without a provider RPC
throws, `NPC_SERVICE_PRICE_LAMPORTS` must be a positive integer, and the genesis hash is
checked against the configured cluster with a loud `MISMATCH` on boot. `/api/health`
reports cluster, chain ID, RPC reachability, the *variable name* the endpoint came from
(never the URL), the allowlisted methods, persistence, auth mode, payments, payouts, and
custody.

Absent: an owner-only integration status screen with the five-state vocabulary
(Configured / Reachable / Read-only verified / Execution verified / Blocked) and evidence
timestamps; environment stamped onto every task and receipt (`receipts.cluster` exists,
which is a good start); and template coverage for the cluster-scoped RPC variables and the
script variables.

### §13 Tests that prove the system works

**Partial.** Real verification scripts exist and exercise real code paths, including a
mainnet-configuration build (`dist-mainnet/`) and a deliberate cluster-mismatch database.
There is no test framework, though — these are bespoke `tsx`/`node` scripts — and there is
no coverage of quote expiry, output minimums, policy enforcement, budget concurrency,
authorization replay, duplicate provider callbacks, refunds, or interrupted flows, because
none of those subsystems exist.

### §14 Implementation order and final handoff

**Partial.** Step 1 of §14's order ("repository audit and provider verification") is what
this document and the integration matrix complete. Step 2 ("authentication and real wallet
balances") is substantially done. Steps 3 onward are not started.

---

## 3. What this audit concludes

The repository is roughly **one-and-a-half of fourteen sections complete**, but the part
that exists is the part that is hardest to retrofit: honest state modelling, credential
hygiene, owner-scoped access, exact integer money handling, and a refusal to collapse
uncertainty into false certainty. `verifyTransfer`'s five verdicts, `awaitConfirmation`'s
five outcomes, the redaction choke point, the per-cluster RPC resolution, and the
mainnet-refusal of `VITE_SOLANA_RPC_URL` are all exactly the disciplines §4, §5, §7 and
§10 ask for, already in place.

What is missing is every provider integration and the entire agent/job/authority layer.
Notably, **none of the missing foundational work needs a credential** — see
`docs/implementation-plan.md`.
