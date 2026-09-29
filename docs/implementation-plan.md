# Implementation plan

Companion to `docs/repository-audit.md` (what exists) and `docs/integration-matrix.md`
(what the providers actually do, verified 27 September 2026). This document is the
sequencing: what to build, in what order, and what each step needs from you.

The organising principle is **credential independence**. A large majority of the
specification — the durable job and ledger schema, the bounded-authorization model, state
machines, idempotency, budget reservations, owner-scoped access — can be built, tested, and
demonstrated with zero credentials and zero provider accounts. That work should start now,
because it is also the work that determines whether the provider integrations are safe when
they arrive.

---

## Phase 0 — Groundwork, no credentials needed

Everything in this phase is provider-independent and can begin immediately.

### 0.1 Migrations and the financial data model (§10)

The repository has real SQLite but no migrations framework, and five tables where §10 asks
for roughly sixteen entities. Add a forward-only numbered migration runner with a
`schema_version` table, then model:

`users` · `linked_wallets` · `services` · `quotes` (immutable) · `authorizations` ·
`budget_reservations` · `tasks` · `task_steps` · `payment_attempts` ·
`conversion_attempts` · `zcash_operations` · `ledger_entries` · `receipts` · `monitors` ·
`artifacts` · `idempotency_keys`

Two rules to carry over from the existing code because they are already right:

- **Amounts as TEXT decimal integers**, as `db.ts` does for lamports, so values round-trip
  as exact bigints with no float anywhere in the path.
- **Separate game data from financial records.** Today `profiles.gold` shares a database
  with `receipts`. Split them, at minimum into separate schemas with no foreign keys
  crossing the boundary.

`ledger_entries` should be append-only and double-entry, so "the ledger must balance" (§9)
is a query you can run, not an aspiration.

### 0.2 The bounded-authorization model, enforced outside the LLM (§4)

This is the single most valuable thing to build first, and it needs nothing external.

An `authorizations` row must bind every field §4 lists: owner, service, job ID,
authorization version; source network, asset, maximum principal, maximum total debit;
service fee, conversion cost, network fees, contingency; destination network and exact
recipient; approved refund destination; minimum net output, slippage limit, approved
providers, allowed action types; expiry, single-use nonce, cumulative budget, revocation
status.

Enforcement lives in a pure, deterministic module — call it the policy engine — that takes
an authorization and a proposed action and returns allow/deny with a reason. It must be:

- **Called before every signing or spending operation**, not once at approval time.
- **Unreachable from model output.** NPC dialogue, scraped pages, and creator-supplied
  prompts are data. The policy engine must not accept instructions from any of them.
- **Fully unit-testable with no network.** Every §13 policy case — quote expiry, output
  minimums, replay, out-of-bounds route change, revoked authorization — is a pure function
  test. Write these now.

The existing `requireWallet()` discipline in `src/server/index.ts` (wallet from the session,
never from the body) is the pattern to extend to every new route.

### 0.3 Budget reservations with real concurrency safety (§4)

Reservations must prevent two simultaneous jobs overspending one balance. SQLite can do
this correctly, and `db.ts` already demonstrates the technique: nonce consumption is a
single conditional `UPDATE` so that only one of two concurrent requests can win. Apply the
same shape to reservations — reserve inside a transaction with a conditional update against
available balance — and write a concurrency test that fires N parallel reservations against
a balance that can only fund N−1.

Distinguish clearly, in the schema and the UI: **cancelling an unspent reservation releases
budget; cancelling does not reverse a settled payment.** §4 and §8 (Steward) both insist on
this and it is a data-model decision, not a copy decision.

### 0.4 Durable job queue and workers (§10)

The current demo task uses `setTimeout(...).unref()`, so the row survives a restart but the
work does not. Replace with a database-backed queue providing locking, leases, retries,
backoff, and restart recovery. A `jobs` table with `lease_expires_at` and a claiming
`UPDATE … WHERE lease_expires_at < now` is sufficient and needs no Redis.

Build the worker as a separate process from the web server now, while it is cheap. §6
requires the Zcash signer to be isolated from both the NPC language model and the general
web server; that isolation is much easier to establish before there is a monolith.

### 0.5 Independent state machines (§10)

Five separate machines, never collapsed into one status field: payment settlement,
conversion, shielding, outgoing transfer, service delivery. A settled x402 payment must not
imply a completed Courier job.

Model each as an explicit state enum plus a transition table, and reuse the vocabulary the
repository already got right: `src/server/chain.ts`'s `TransferVerdict` and
`src/solana/payments.ts`'s `ConfirmOutcome` both preserve `unknown`/`timeout` as distinct
from failure. Every new machine needs that same non-terminal "we do not know yet" state,
and reconciliation must run before any retry of a financial operation.

### 0.6 Idempotency everywhere (§10)

Idempotency keys at task creation, authorization consumption, payment collection, provider
deposit, Zcash send, refunds, and creator payout. The `receipts` table's
`on conflict(signature) do nothing` is the existing model; generalise it into an
`idempotency_keys` table keyed on (scope, key) with a stored response.

Do not claim distributed exactly-once. Claim at-least-once delivery with idempotent effects,
which is what this actually gives you.

### 0.7 Owner-scoped access on everything (§10)

Every job, receipt, budget, monitor, artifact, and download must check ownership from the
session. Add the private-network URL restriction for web-fetch tools now, before the
Archivist exists, because that is when it is easy.

### 0.8 Local test harness (§13)

A test framework (the repo currently has bespoke `tsx` scripts, which are fine but not
sufficient), plus mocks for every provider. §12's rule matters: mocks may satisfy automated
failure tests and must **never** silently satisfy a live job. Enforce that with an
environment stamp on every task and receipt, checked at execution time.

### 0.9 Owner-only integration status screen (§12)

Build the screen before the integrations, with the five-state vocabulary: **Configured**,
**Reachable**, **Read-only verified**, **Execution verified**, **Blocked** — each with an
evidence timestamp and a precise reason. Wire it to real probes as each provider lands.
`/api/health` already does a genuine version of this for Solana (genesis-hash check,
variable name rather than URL); extend that pattern rather than inventing a new one.

### 0.10 NPC roster reconciliation (§8, §11)

Rename and relocate to match the spec: Broker (from `VELLUM · MERCHANT`), Maker (from
`BRONZE · BLACKSMITH`), Steward (from `NELL · INNKEEPER`), Watcher, Artificer, Guildmaster.
Add the three missing locations — Guild Hall, Watchtower, Agent Forge — to
`src/townData.ts`, which is the single source of truth the world and map both read, so both
update together. **Coordinate with the character-redesign agent before touching this.**

Also in this phase, needing no credentials: per-profession action menus, the task composer
behind the existing drag, the direct service directory, occupational animations driven by
verified backend state, and job notifications.

---

## Phase 1 — Devnet-testable payments

Needs: an x402 facilitator choice. The default testnet facilitator needs no account.

- Integrate `@x402/core` + `@x402/svm` + an HTTP server middleware, version-pinned at
  2.27.0, against `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet) using the
  public `x402.org` facilitator.
- Implement the real `PAYMENT-REQUIRED` response, client authorization,
  `PAYMENT-SIGNATURE`, verification, settlement, and payment evidence. Never accept a
  client-provided `paid=true`.
- Handle `settlement_pending` as **non-terminal**: reconcile the broadcast transaction hash
  on chain before retrying. This maps onto the `unknown` verdict already in `chain.ts`.
- Implement duplicate-settlement protection. The SVM packages ship a `SettlementCache`
  (120 s TTL) enabled by default via the standard registration helpers; if you ever settle
  directly, you must implement equivalent detection yourself.
- Keep the existing `/api/payments/*` SOL path, but **do not relabel it x402**. It is a
  plain SOL transfer and calling it x402 would be a false claim.

Fully testable on devnet. Real signatures, worthless SOL.

## Phase 2 — Jupiter, quote-only

Needs: nothing to start (keyless tier works). Optionally a free API key.

- SOL→USDC quoting via `GET https://api.jup.ag/swap/v2/order`. Verified live and keyless on
  27 Sep 2026: HTTP 200, `router: metis`.
- Broker read-only research and quoting: source/destination assets, quote expiry, minimum
  received, price impact where available, all costs.
- Resolve assets **by mint and authoritative decimals**, never by ticker text.

Quoting is free and unlimited in practice. **Execution is mainnet-only** — Jupiter has no
devnet swap endpoint — so swap execution stays behind an explicit bounded authorization with
a fee cap.

## Phase 3 — Zcash wallet on testnet

Needs: no credential. Needs a Rust toolchain and disk for a wallet, and a lightwallet
server endpoint.

This is the highest-value blocked-route work you can do without spending money, because §13
explicitly wants these stages reported separately from the full route.

- Stand up the wallet service as an isolated process. Start with **Zallet v0.1.0-beta.3**
  (GitHub release — *not* the `zallet` crate on crates.io, which is a 0.0.0 placeholder from
  Oct 2024). Verify each required RPC call exists in beta.3 before designing around it; the
  README states many `zcashd` methods are not yet ported.
- Use **zcash-devtool** as the testnet harness (`init … -n test`, `sync`,
  `restore-mnemonic`, `upgrade`). Its README says "DO NOT USE THIS IN PRODUCTION!!!" — treat
  that as binding, and use it only for the harness.
- Address parsing with `zcash_address` 0.13.0 / `zcash_keys` 0.16.1. For a Unified Address,
  **enumerate receivers and select an actually supported shielded one**; never infer privacy
  from a prefix and never silently downgrade to transparent.
- Demonstrate, on testnet, each stage separately: sync, transparent receipt detection,
  shielding, spendability under the confirmation policy, shielded send, confirmation
  tracking, and restart/rescan recovery.
- Adopt ZIP 315's numbers rather than inventing them: **10 confirmations for untrusted
  TXOs** (which is what a conversion payout is), 3 for trusted; one transparent receive
  address per job, shielded on its own, never batching multiple transparent addresses into
  one shielding transaction; 24-word BIP-39 seeds.
- Encrypt the seed at rest, keep keys out of browser bundles, logs, chat prompts, reports,
  and receipts, restrict RPC access, and implement backup and recovery. Then **document the
  remaining trust in the operator honestly** — a beta component passing a smoke test is not
  proof that live custody is ready.

## Phase 4 — Agent runtime

Needs: a language-model API key. Optionally search and image-generation keys.

- One shared runtime, per-NPC service definitions and tool allowlists, schema-validated tool
  calls, and **actual model IDs read from the provider's current documentation** at
  implementation time — do not hardcode a model name from memory.
- Enforce request limits, token/compute limits, deadlines, tool allowlists, and cost
  accounting **in code**, outside the model.
- Treat retrieved pages and creator instructions as untrusted content. They cannot modify
  authority (§4).
- Distinguish proposed actions from successful tool results in both the data model and the
  UI.
- Service registry: owner, NPC identity, capabilities, provider status, price policy, tool
  permissions, output schema, supported payment assets/networks, availability. A listed
  service must have a working executor and a validated sample output.

## Phase 5 — Mainnet conversion, bounded

Needs: a NEAR Intents partner JWT (optional but saves 0.2%), and real SOL.

- 1Click token discovery from the live `/v0/tokens` response — discover `assetId` and
  decimals, never hardcode them. The only native-Zcash-chain asset is
  `nep141:zec.omft.near`, 8 decimals.
- Quote → deposit → status polling, with quote-specific deposit addresses and any required
  memo persisted. **Never reuse an expired deposit route.** Map `PENDING_DEPOSIT`,
  `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`
  into internal states without discarding the evidence needed for recovery.
- **There is no testnet.** Dry quotes are free and should be used extensively; a dry quote
  is not a swap. The first real conversion is mainnet with real money.
- **Do not start a conversion while the shielding stage is known to be unavailable** (§6).
  Gate on a live wallet readiness check: sync status, signer availability, spendable balance
  for fees.

## Phase 6 — The flagship route

Needs everything above, plus an accepted custody decision.

Assemble §6's ten steps end-to-end. Read `docs/integration-matrix.md` §9 first: the route
requires operating custodial mainnet infrastructure on unreviewed components with no
end-to-end test path. That is a business decision, not an engineering one, and it should be
made explicitly before this phase opens.

## Phase 7 — Creator services, orchestration, full verification

Artificer create/edit/test/publish/hire/pause/unpublish with opaque credential references;
revenue splits with refund accounting; Guildmaster dependency handling, shared budget
reservations, partial success, combined receipts, and per-child scope checks against the
parent's remaining budget; then §13's interrupted-flow suite and the per-NPC evidence run.

---

## The eight NPCs

| NPC | Needs to function | Buildable now (no credentials) | Blocked on |
| --- | --- | --- | --- |
| **Courier** (Post Office) | Address/network validation with maintained parsers; conversion provider; Zcash wallet that shields and sends shielded; confirmation tracking; private receipt; reconciliation | Authorization binding; the five state machines; idempotency at every financial step; quote persistence and expiry; refund accounting; the whole plain-language pipeline UI; ordinary supported SOL transfers (this works today); receipt lookup; the rule that the destination cannot change after approval | **Shielded payout — no verified provider supports it.** Conversion is mainnet-only. Wallet stack is beta/unreviewed. See matrix §9. |
| **Archivist** (The Archive) | A real research/search integration; on-chain data tools; artifact persistence with owner-scoped download | Report schema; source/timestamp/uncertainty modelling; artifact storage and owner-scoped downloads; the saved-report-not-chat-response delivery model; private-network URL restrictions on the fetch tool; on-chain reads via the **existing RPC proxy** | Search provider key; LLM key. Both are cheap and unblocked by anything else. |
| **Broker** (Exchange) | Jupiter for Solana; cross-chain provider where applicable | Quote display with expiry, minimum received, price impact, costs; the read-only-never-trades separation; per-execution authorization matching; asset resolution by mint and decimals. **Jupiter quoting works keyless today** | Swap *execution* is mainnet-only. No devnet path exists. |
| **Watcher** (Watchtower) | Real provider data for addresses, price feeds, transfers, liquidity | The entire monitor subsystem: server-worker persistence surviving browser close, duration and cost limits, polling/webhook strategy, cursor/checkpoint, deduplicated triggers, pause control, in-app alerts with evidence and timestamps, and **honest coverage-gap reporting across outages**. Solana address monitoring can use the existing proxy | Price-feed provider (Jupiter Price API v3 works keyless at low rate); external notification channels need explicit recipient authorization. |
| **Maker** (Workshop) | Configured inference/generation services | Deliverable specification and cost bounds shown before work; artifact persistence; owner-scoped downloads; the rule that generated code is a downloadable artifact and is **never executed inside a money-holding service** | Image/text generation provider key. |
| **Artificer** (Agent Forge) | Service templates; provider connections; opaque credential storage | Everything except the child services' own providers: create/edit/private-test/publish/hire/pause/unpublish; credential storage **outside prompts** with opaque references; output contracts; the rule that creator instructions cannot grant new wallet permissions or host access; revenue splits and refund accounting; creator-service isolation | Whichever providers the published templates use. Also needs the **Agent Forge location**, which does not exist in `townData.ts`. |
| **Steward** (Hearth) | Nothing external at all | **All of it.** Balances (working today), active jobs, reserved vs available budgets, funds awaiting confirmation, receipts, creator earnings, configuration status, cancel-future-work, revoke-future-delegation, export-own-history, resume-recoverable-jobs, the cancellation-is-not-reversal distinction, and the requirement that it be **reachable directly without walking through the world** | **Nothing.** This is the best first NPC to complete — it is a read model over Phase 0 and needs no credential. Also needs no new building: the Hearth Inn exists. |
| **Guildmaster** (Guild Hall) | Child NPCs to orchestrate | Objective decomposition into a bounded job sequence; deliverable and total-maximum-price display before approval; dependency handling; shared budget reservations; partial success; combined receipt; per-child scope and remaining-budget checks; the rule that a failed research step must not launch an unrelated paid trade | Its children, and an LLM for planning. Also needs the **Guild Hall location**, which does not exist. |

**Recommended NPC order: Steward → Archivist → Broker → Watcher → Maker → Artificer → Guildmaster → Courier.** Steward needs nothing; Courier is blocked.

---

## Consolidated credential and account checklist

Work through this as a checklist. Marked **[have]** where the repository already covers it.

### Already configured — no action needed

| Variable | What it is for | Status |
| --- | --- | --- |
| `SOLANA_CLUSTER` / `VITE_SOLANA_CLUSTER` | Which cluster. `mainnet-beta` is an explicit opt-in | **[have]** in `.env.example` |
| `SOLANA_RPC_URL`, `SOLANA_RPC_URL_MAINNET_BETA`, `SOLANA_RPC_URL_DEVNET`, `SOLANA_RPC_URL_TESTNET` | Server-side Solana RPC, resolved per cluster. Treated as a credential: never logged, never returned, never sent to the browser | **[have]** — a mainnet RPC is already configured server-side. The cluster-scoped names were added to `.env.example` by a concurrent agent while this audit was running, so the template now matches `src/server/config.ts` |
| `VITE_API_BASE_URL`, `PORT`, `WALLY_DB_PATH`, `WALLY_ALLOWED_ORIGINS`, `WALLY_SIWS_DOMAINS`, `WALLY_NONCE_TTL_MS`, `WALLY_SESSION_TTL_MS` | API base, port, SQLite path, CORS allowlist, signed-domain allowlist, challenge and session lifetimes | **[have]** |
| `NPC_PAYEE_ADDRESS`, `NPC_SERVICE_PRICE_LAMPORTS` | Public payee address for NPC fees (public key only) and integer lamport price | **[have]**, and inert — payments are off on every deployment now, because the client has no transaction signer. Setting the address does not switch them on |

### Tier 1 — free, no account, unblocks the most work

| Variable | What it is for | Where to get it |
| --- | --- | --- |
| `X402_FACILITATOR_URL` | x402 facilitator endpoint. Use `https://x402.org/facilitator` for devnet. **Documented as testnet-only — must be changed for mainnet** | Free, no signup: [docs.x402.org](https://docs.x402.org/core-concepts/network-and-token-support) |
| `X402_NETWORK` | CAIP-2 network ID. Devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Same page |
| `X402_PAY_TO_ADDRESS` | Solana address that receives x402 service payments. **Public key only.** Can reuse `NPC_PAYEE_ADDRESS` | Your own wallet |
| `X402_ASSET_MINT` | USDC mint for the chosen network. Mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Both 6 decimals | Same page |
| `JUPITER_API_BASE_URL` | `https://api.jup.ag/swap/v2`. **Keyless access works at 0.5 RPS — verified live** | No account needed |
| `ZCASH_LIGHTWALLETD_URL` | Lightwallet server for testnet wallet sync | Public testnet lightwalletd, or self-host `zcash/lightwalletd` v0.5.4 |
| `ZCASH_NETWORK` | `test` or `main`. Keep on `test` for all of Phase 3 | — |

### Tier 2 — free accounts, low friction

| Variable | What it is for | Where to get it |
| --- | --- | --- |
| `JUPITER_API_KEY` | Raises Jupiter from 0.5 RPS keyless to 1 RPS free. Sent as `x-api-key`. Key format `jup_...` | Free tier at [developers.jup.ag/portal](https://developers.jup.ag/portal). Paid tiers: Developer $25/mo 10 RPS, Launch $100/mo 50 RPS, Pro $500/mo 150 RPS |
| `NEAR_INTENTS_JWT` | 1Click partner JWT. Sent as `X-API-Key` or `Authorization: Bearer`. **Optional** — without it swaps incur an extra 0.2% fee | Sign up at `partners.near-intents.org`, request access through the partner portal. The market-maker path additionally requires KYC/KYB; the distribution-channel path is what we need |
| `NEAR_INTENTS_BASE_URL` | `https://1click.chaindefuser.com/v0` | — |
| `LLM_API_KEY` + `LLM_MODEL_ID` | NPC conversation and planning (§9). **Read the model ID from the provider's current documentation at implementation time; do not hardcode one from memory** | Your chosen provider's console. Must stay server-side |
| `SEARCH_API_KEY` | Archivist's research integration | Your chosen search provider |
| `GENERATION_API_KEY` | Maker's image/text/code generation | Your chosen inference provider |
| `ARTIFACT_STORAGE_*` | Where generated artifacts live, with owner-scoped downloads. Local filesystem is fine to start | Object-storage provider, or none |

### Tier 3 — the custody decision, not just a variable

Everything here presupposes an accepted decision to hold customer funds. Read
`docs/integration-matrix.md` §9 before creating any of it.

| Variable | What it is for | Where to get it |
| --- | --- | --- |
| `ZCASH_WALLET_RPC_URL` + `ZCASH_WALLET_RPC_AUTH` | Zallet RPC endpoint and credentials for the isolated wallet service | Your own Zallet v0.1.0-beta.3 deployment ([GitHub releases](https://github.com/zcash/zallet/releases) — **not** the crates.io `zallet` 0.0.0 placeholder) |
| `ZCASH_NODE_RPC_URL` | Consensus node backing the wallet | Your own Zebra v6.4.2 deployment. **zcashd is archived and must not be used** |
| `ZCASH_WALLET_SEED_ENCRYPTION_KEY` | Encrypts the wallet seed at rest. **This is the most dangerous secret in the system.** Must never reach a browser bundle, a log, a chat prompt, a report, or a receipt | Generate yourself; hold in a secret manager, not `.env` |
| `ZCASH_SHIELDED_POOL` | Target pool for shielding (Orchard preferred, Sapling fallback) | Configuration choice |
| `ZCASH_CONFIRMATIONS_UNTRUSTED` / `_TRUSTED` | Confirmation policy. **ZIP 315 recommends 10 and 3.** Conversion payouts are untrusted | [ZIP 315](https://zips.z.cash/zip-0315) |
| `ZCASH_BACKUP_*` | Wallet backup and recovery target | Your own infrastructure |
| A production x402 facilitator | `x402.org` is testnet-only. Mainnet needs a production facilitator, a self-hosted one, or self-facilitation | Candidates with Solana coverage: Corbits, Dexter (free, no account), PayAI (no API keys), Solvador — from [the facilitators list](https://docs.x402.org/dev-tools/facilitators.md), which states it is not exhaustive. **None were exercised** |
| Real mainnet SOL | The only way to exercise the conversion leg or a Jupiter swap. Keep it small and bounded | Your own funds |

### Also needed, not a credential

- **Rust toolchain** for the Zcash wallet service, and disk for a Zebra chain and wallet DB.
- **A second process** for the worker, separate from the web server.
- **A decision on custody**, documented, before Phase 6 opens.

### Explicitly not needed

There is **no WALLY token mint** and none should be created — the `.env.example` already
says so. §8 also states the Artificer must not require minting a token or NFT. And no
private key or seed phrase is needed anywhere on the *Solana* side: each player's key is
generated in their own browser, never leaves it, and signs only the identity challenges the
server issues; the server verifies rather than signs. (Updated: that browser-held key is now
the only wallet — Phantom was removed — and it has no transaction signer, deliberately,
because it lives in `localStorage`. Any phase that assumes a player can sign a transfer has
to say where that signer comes from.) The Zcash side is the sole exception, and that is
precisely why it is the hard part.

---

## The three-way split

### Implementable now, with no credentials

- Migrations and the full financial data model (§10)
- The bounded-authorization record and the policy engine, enforced outside the LLM (§4)
- Budget reservations with tested concurrency safety (§4)
- Durable job queue, leases, retries, restart recovery, worker process (§10)
- Five independent state machines with preserved "unknown" states (§10)
- Idempotency keys at all seven financial boundaries (§10)
- Owner-scoped access on every resource; private-network URL restrictions (§10)
- Append-only double-entry ledger that balances (§9)
- **The Steward NPC, complete** (§8)
- NPC roster reconciliation; Guild Hall, Watchtower and Agent Forge locations (§8, §11)
- Task composer behind the existing drag; per-profession action menus; service directory; occupational animations; job notifications; cross-refresh task persistence (§11)
- The plain-language job pipeline and per-stage public-vs-shielded labelling (§7)
- The disclosure copy for who can see source, destination, amount, task details, receipts (§7)
- Owner-only integration status screen with the five-state vocabulary (§12)
- Test framework, provider mocks, environment stamping, the full §13 policy suite
- Jupiter quoting (keyless, verified live)
- Zcash address and Unified-Address receiver parsing (`zcash_address` 0.13.0)
- **Zcash testnet wallet: sync, receipt detection, shielding, spendability, shielded send, restart/rescan** — §13 wants these reported separately anyway
- x402 devnet payment flow end to end

That is the majority of the specification.

### Implementable once credentials arrive

- Archivist's sourced reports (search + LLM key)
- Maker's generated artifacts (generation key)
- Watcher's price-feed monitors (mostly keyless; notification channels need recipient authorization)
- Broker's swap **execution** (mainnet SOL — no devnet path exists)
- Agent runtime and service economy (LLM key)
- Artificer and Guildmaster (LLM key plus their children's providers)
- x402 mainnet settlement (production facilitator)
- SOL→ZEC conversion (mainnet SOL; JWT optional)

### Genuinely blocked regardless of credentials

- **Shielded-to-shielded ZEC delivery via any verified third-party provider.** No amount of
  credentials fixes this. NEAR Intents documents transparent-only; Maya documents
  transparent-only and has no Solana; nothing else was found with explicit documentation of
  shielded receiver support.
- **An end-to-end test of the flagship route.** The conversion leg has no test network, by
  the provider's own statement. Payment (devnet) and Zcash operation (testnet) are each
  testable in isolation; the whole route is not testable anywhere but mainnet with real
  money.
- **A production-ready, review-complete Zcash custody backend.** Every option carries its
  authors' own warning: librustzcash "have not been fully reviewed", Zallet "Beta release"
  with an incomplete RPC surface and possible wallet recreation between betas, zcash-devtool
  "DO NOT USE THIS IN PRODUCTION!!!", zcashd archived. This is not a credential problem and
  cannot be resolved by us.
- **Native SOL as the x402 payment asset.** Not in x402's documented Solana asset support,
  which is SPL / Token-2022 only. The workaround is a quoted Jupiter conversion inside the
  job's cost envelope, which is what §3 asks for anyway.
- **A claim that the whole journey is untraceable.** The conversion leg is public and the
  shielding transaction is permanently linked to the transparent address it spends from
  (ZIP 315). Only the final hop is shielded. §7 requires saying exactly that, so this is a
  copy constraint rather than a blocker — but it must not be worked around.

---

## What to do first

Build the Steward and the Phase 0 spine behind it. It needs no credential, it exercises the
authorization record, the reservation logic, the ledger, and the state machines all at once,
and it gives you a real screen showing real balances, real reserved-versus-available budget,
and real receipts. It is also the honest place to surface that the Courier's flagship route
is blocked, with `docs/integration-matrix.md` as the citable reason.
