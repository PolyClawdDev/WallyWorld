# Voxels

An atmospheric, single-player fantasy town where your wallet has a world.

Storage, env, and debug probe keys still use the historical `wally` prefix (`wally.progression.v1`, `wally-receipt`, `wally-session-v1`, `WALLY_DB_PATH`, `window.__wally`, and similar) so existing saves and verification scripts keep working.

## Run locally

```bash
npm install
cp .env.example .env     # every value is optional; defaults are safe
npm run dev
```

The API runs in a second terminal. It is required for signing in, for saving a
character to a wallet, and — unless you set `VITE_SOLANA_RPC_URL` — for reading
the chain at all, because the client sends RPC through it:

```bash
npm run server
```

The game itself plays without either the API or a wallet. Everything to do with
Solana is additive: with no `.env` at all you get devnet, a public RPC endpoint,
and "DEMO · NO REAL FUNDS" labelling throughout.

## Included in this build

- Entry scene and four original archetypes: MOTH, BRAMBLE, CINDER, and ORBIT.
- Procedural Three.js town district with square, bridge, stream, five landmarks, lanterns, trees, water, lighting, fog, and NPCs.
- Third-person movement with a free mouse cursor, first-person toggle (`V`), run (`Shift`), and interaction proximity.
- Wildlife and hunting: chickens, reindeer, and bears wandering six green regions outside town, each with its own silhouette, threat level, and gold value. One attack ability per archetype, player health with out-of-combat regen and a safe town zone, and a gold forfeit on death.
- Responsive HUD, minimap, map, journal, wallet, settings, and mobile-friendly service panels.
- Archivist demo task with quote, explicit approval, deterministic queued/running/delivered states, local receipt persistence, and “Demo — no real funds” labels.
- A typed HTTP API at `src/server/index.ts` with SQLite persistence, sign-in by wallet signature, per-wallet character saves, payment receipts, and a method-allowlisted Solana RPC proxy.
- Non-custodial Phantom wallet integration: connect, live balances, Sign-In With Solana, and user-signed payments to NPCs. See below.

## Solana wallet integration

Real, non-custodial, Phantom only. Everything lives in `src/solana/` (client),
`src/server/` (API), and `src/shared/` (types and the sign-in message format
used by both sides).

**The app never handles a private key or a seed phrase.** It does not generate
one, store one, transmit one, display one, or ask for one — not on any screen,
and there is no code path that could. Phantom holds the key and performs every
signature. `src/server/` contains no keypair either: the server verifies
signatures and reads the chain, and cannot move anyone's funds. If you ever see
Voxels ask you for a seed phrase, it is not Voxels.

What is implemented:

- **Connect.** Phantom detection via `window.phantom.solana`, falling back to
  `window.solana.isPhantom`, with a download link when it is absent. Handles
  connect, disconnect, and `accountChanged`, and drops the session when the
  account changes.
- **Balances.** SOL and whatever SPL tokens the wallet actually holds, read from
  the chain across both the Token and Token-2022 programs. Balances are held as
  `bigint` base units and formatted only at render — there is no floating-point
  arithmetic on a balance anywhere, and the raw integer lamport figure is shown
  next to the formatted one.
- **Sign-In With Solana.** The server issues a single-use nonce bound to the
  domain, the cluster, and the wallet, with a five-minute expiry. The client
  rebuilds the message text itself from a shared template and refuses to show
  anything that does not match, so a malicious server cannot get a surprising
  payload signed. The signature is verified server-side with `@noble/curves`,
  and the nonce is consumed by a single conditional `UPDATE` so a replay loses
  the race. No passwords.
- **Persistence.** SQLite via `better-sqlite3`. Character, wardrobe, name, and
  gold are stored per wallet. Every endpoint takes the wallet from the session
  token, never from the request body, so one wallet cannot read or write
  another's row. Lamport figures are stored as text to survive a round trip
  exactly.
- **NPC payments.** A Phantom-signed SOL transfer. Recipient, amount, network,
  and the fee quoted from the chain are all shown before anything is signed.
  After submitting, confirmation is polled and resolves to one of five honest
  outcomes — confirmed, failed, expired, timeout, or unknown — and `unknown` is
  never quietly treated as success. Receipts are keyed by transaction signature
  and are idempotent. The server verifies a claimed payment from the
  transaction's own pre/post balance deltas rather than trusting the client.

### Networks, and not confusing the two

The cluster comes from `VITE_SOLANA_CLUSTER` (client) and `SOLANA_CLUSTER`
(server), **defaulting to devnet**. `mainnet-beta` is an explicit opt-in.

Labelling is deliberately asymmetric, because the two mistakes are not equally
bad. "Real funds" depends only on the configured cluster, so a mainnet build is
loud before a wallet is even connected: a red `MAINNET · REAL FUNDS` chip on
every screen plus a banner across the top of the world. Devnet shows
`DEMO · NO REAL FUNDS` until a wallet connects and `DEVNET · TEST FUNDS`
afterwards. A demo build cannot display the live styling, and a mainnet build
cannot display the demo styling.

The server independently reads the RPC genesis hash at boot and reports it on
`/api/health`, so an endpoint that disagrees with the configured cluster is
caught and printed as a warning rather than silently pointing a "devnet" run at
mainnet.

### The RPC proxy, and why the endpoint is a credential

Public mainnet RPC is rate-limited and not usable for an application, so mainnet
needs a provider — QuickNode, Helius, Triton, or your own validator. **Those
endpoint URLs are credentials.** The access token is embedded in the URL itself,
so anyone who obtains it can spend your quota.

That rules out the obvious approach. Anything in a `VITE_*` variable is compiled
into the JavaScript bundle and is public to every visitor, so the endpoint
cannot be given to the browser. Instead the server proxies it:

- `POST /api/rpc` forwards JSON-RPC upstream using the server-side
  `SOLANA_RPC_URL` (or the cluster-scoped `SOLANA_RPC_URL_<CLUSTER>`, which is
  preferred — it stops a devnet run from spending a mainnet quota).
- **Methods are allowlisted.** Balance and account reads, token accounts,
  blockhash, fee quotes, transaction submission, and confirmation status. This
  is not an open relay; an open proxy to a paid endpoint gets found and drained.
  `requestAirdrop` is permitted on test clusters and refused on mainnet. A batch
  containing any forbidden method is rejected whole, so a single bad entry
  cannot smuggle work through alongside good ones.
- Rate-limited per session where there is one and per IP otherwise, on a budget
  separate from the rest of the API. CORS stays restricted to an origin
  allowlist. No client headers are forwarded upstream.
- **The URL is never logged, never returned, and never in a health payload.**
  Startup logs name the variable it came from, not its value. Because `fetch`
  and `@solana/web3.js` both like to quote the endpoint in error messages, every
  JSON response and every log line passes through a scrubber in
  `src/server/redact.ts` that redacts the URL and its parts, so an upstream
  failure cannot surface it in a message or a stack trace.

`VITE_SOLANA_RPC_URL` still works as an escape hatch for devnet and local
validators, and is documented in `.env.example` as public. The client refuses to
use it when the cluster is `mainnet-beta`; mainnet always goes through the proxy.

`npm run audit:bundle` reads the real endpoint out of your environment and
searches every byte of `dist/` for the URL, its host, and each path segment long
enough to be a token. Run it after building if you have touched any of this.

### Gold payouts: not implemented, and not a switch

Converting hunting gold into a Solana token is **not implemented**. The button
in the wallet panel is permanently disabled and labelled unavailable. There is
no configuration value that enables it; it is hardcoded off in
`src/server/config.ts`, and `POST /api/payouts/*` answers `501`.

This is a deliberate refusal, not an unfinished feature. Paying users *out* of a
treasury is a different proposition from letting them pay *in*.

What *used* to be the first reason on this list — "the gold counter is
client-asserted" — no longer is, and saying so would be out of date. Balances
now live in `src/server/money/ledger.ts` as append-only double-entry records in
integer base units, hunt rewards are priced by the server and issued as
single-use per-animal tokens (`src/server/hunt/rewards.ts`), and only the
`hunt_verified` provenance is redeemable at all (`src/server/money/provenance.ts`).
Gifts, duel winnings and gold imported from the old browser-side demo never are.

What is genuinely still missing:

- **Combat is still simulated in the browser.** This is the honest limit of the
  current design and the reason the rest of the list matters. The server proves
  the reward amount, the species, that each animal pays at most once, and a
  bounded per-session ceiling — it does **not** prove a fight happened, because
  it does not run the fight. Closing that gap means moving wildlife and
  abilities to server-authoritative simulation. The header of
  `src/server/hunt/rewards.ts` states this in the same terms; no user-facing
  copy may claim more than it does.
- **There is no treasury signer.** `TREASURY_SIGNER.available` is `false` and
  this process holds no key and no code that could use one, so
  `submitWithdrawal` returns `no_signer`. That is a custody decision, not a
  configuration gap.
- **Withdrawal configuration does not exist.** Five values in
  `src/server/treasury/config.ts` — reward rate, minimum, per-player limit,
  campaign budget, fee reserve — have no values and deliberately no defaults,
  so `POST /api/withdrawals/quote` answers `409 missing_configuration` naming
  each one. A rate of zero would be an invented exchange rate too.
- **A treasury needs custody.** Paying out requires a key that can move funds,
  which means key management, hardware or KMS signing, spend limits enforced
  outside the application, and monitoring. This repository deliberately holds no
  key, and that property is worth more than the feature.
- **Payouts must reconcile.** Every payout needs an idempotency key, a durable
  record written before submission, and reconciliation against on-chain
  confirmation, so a timeout or an unknown status cannot become a double
  payment.
- **It is probably a regulated activity.** Paying people money for playing needs
  legal review, jurisdiction rules, and likely KYC. That is not an engineering
  decision.
- **There is no WALLY token.** No mint exists. No mint address has been invented
  or placed anywhere in this repository, and none should be.

`src/rewards.ts` keeps its demo ledger and its existing labelling; the wallet
panel says the same thing, so the two cannot drift into disagreeing.

## What has been verified, and what has not

Verified end to end, by scripts in this repository:

| Command | Covers | Result |
| --- | --- | --- |
| `npm run verify:solana` | Nonce issuance, ed25519 verification, replay and tampering rejection, session handling, per-wallet isolation, persistence round-trip, input validation, devnet balance reads, transaction building, fee quoting, confirmation polling | 98 passed, 0 failed, 3 skipped |
| `npm run verify:proxy` | Allowlisted methods, twelve forbidden methods refused, airdrop gated by cluster, batch handling, oversized bodies, CORS, and a leak scan over every client-visible byte | 53/53 on devnet, 53/53 against a real QuickNode mainnet endpoint |
| `npm run verify:ui` | The UI in real Chrome: funds labelling on every screen, connect, balance display, sign-in, character save, payout staying disabled, and no key or seed input anywhere | 27/27 devnet, 22/22 mainnet |
| `npm run audit:bundle` | The built client contains no provider URL, host, or token | PASS |

All four need `npm run server` running, and `verify:ui` also needs a client to
point at — either `npm run dev` or a `vite preview` of a build. Run the suites a
minute apart: the RPC proxy's own rate limit is 240 requests per minute per IP,
and two suites back to back will trip it and report failures that are really
just `429`s.

`verify:ui` cannot install the Phantom extension in headless Chrome, so it mocks
the provider. The mock is not a stub: its `signMessage` returns a genuine
ed25519 signature from a throwaway fixture key, and the real server has to
accept it for the test to pass. So the client's sign-in path, the message
format, the verification, and the session are all genuinely exercised — but
against a mock, not against Phantom.

**Not verified, and not claimed:**

- **The real Phantom extension.** Its approval dialogs, its own RPC handling,
  and its behaviour when the user switches network inside the extension. A mock
  cannot prove the real extension agrees with it. This needs a human with
  Phantom installed, on devnet first.
- **A self-submitted on-chain transfer.** The devnet faucet is rate-limited and
  would not fund the fixture, so the code path that submits a transfer and
  confirms it was exercised against already-confirmed on-chain transactions
  rather than one this repository created. Building, signing, fee quoting, and
  the polling state machine are all covered; the submission itself is not.
- **Expired-nonce rejection**, which needs `WALLY_NONCE_TTL_MS` set low. The
  expiry is enforced in the same SQL predicate that consumes the nonce, and
  replay of a *consumed* nonce is covered.

The throwaway keys under `scripts/.fixtures/` are test doubles for a
counterparty, used only by the verification scripts. They are gitignored, they
are never a user wallet, and no application code reads them.

## Truthful integration boundary

This repository does not implement custody, treasury payouts, Solana trading,
x402, AP2, Zcash, or live AI providers. It holds no private key.

Hunting gold remains a local demo counter written to an in-memory ledger in
`src/rewards.ts`, and the "pending conversion" window in the hunt log is a
simulated queue that never pays out. Gold cannot be converted to anything.

What *is* real, when you configure it: Phantom connect, on-chain balance reads,
sign-in by signature, per-wallet persistence, and user-signed SOL transfers to
an NPC payee address that you supply. Those are genuine chain interactions and
on mainnet they move real money. The wallet pouch grid and its item stacks are
still simulated and have no mint behind them.

No seed phrase or deposit is ever requested. Any production adapter must enforce
spend policies outside the model, use integer base units, authenticate
ownership, reserve budgets transactionally, and reconcile unknown payment states
before retrying.

## Architecture notes

The current visual foundation is intentionally self-contained: `src/main.tsx` contains the playable client and procedural asset kit. `src/server/index.ts` is now a real API backed by SQLite rather than an in-process demo. Hunting lives in its own modules — `src/wildlife.ts` (zoning derived from `src/townData.ts`, species, sprites, AI), `src/wildscape.ts` (woodland scenery and trail), `src/combat.ts` (abilities and player vitals), `src/rewards.ts` (demo ledger), and `src/huntHud.tsx` — and is checked by `node scripts/verify-hunt.mjs` against a running dev server.

The Solana layer is kept in new files so it stays separable: `src/solana/` for
the client, `src/server/` for the API, and `src/shared/` for the handful of
types and the sign-in message template that both sides must agree on exactly.
`src/main.tsx` touches it in five places only — the funds badge on three
screens, the wallet panel inside the pouch popup, and one registration that lets
the panel read and restore the live character.

`@solana/web3.js` is written against Node and reaches for the `Buffer` global,
which browsers do not have, so `src/solana/bufferPolyfill.ts` supplies one from
the `buffer` package and is imported first in `main.tsx`. Without it the page
renders blank — and note that this failure does not show up in `tsc` or in
`vite build`, only in a browser.

No external art assets are included. Fonts are loaded from Google Fonts for development convenience; bundle a licensed local font before shipping.
