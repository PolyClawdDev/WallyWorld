# Integration matrix

**Date checked: 27 September 2026.** Every row was verified against the provider's own
current documentation on that date, plus the real package registries and, where a
read-only call was possible, the live API. Nothing in this file is written from memory.

This document exists to satisfy section 2 of the implementation specification
("Inspect first and verify the integrations"). It is a research artifact. No code was
changed to produce it, no funds were moved, and no on-chain write was performed.

## How to read the verdicts

| Verdict | Meaning |
| --- | --- |
| **Available** | Documented, package exists and installs, and the capability we need is explicitly covered. |
| **Partially available** | Real and usable, but the specific capability the flagship route needs is not covered, or is covered only under conditions we cannot currently meet. |
| **Unavailable** | The capability does not exist in any form we could verify. |

A separate and important distinction runs through this document: **documented support**,
**API acceptance**, and **verified delivery** are three different things. An API that
accepts a value at quote time has not promised to deliver to it. We have documented
support and API acceptance evidence below. We have no verified-delivery evidence for
anything, because verifying delivery requires spending real money on mainnet.

---

## 1. x402 — HTTP-native payment protocol

| Column | Finding | Evidence |
| --- | --- | --- |
| Capability needed | Charge the user for an NPC service, and collect the Courier's conversion principal, over HTTP with a verifiable settlement receipt. | Spec §5 |
| Actual SDK / package | `@x402/core`, `@x402/svm`, `@x402/evm`, `@x402/express`, `@x402/fetch`, `@x402/axios`, `@x402/near` — all at **2.27.0**, last published 22 Sep 2026. Legacy unscoped `x402`, `x402-express`, `x402-fetch` exist at **1.2.0**. | `npm view` against the live registry, 27 Sep 2026 |
| Supported networks | CAIP-2 identifiers. Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, Solana devnet `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, any EVM `eip155:*`, plus TON, Algorand, Stellar, Aptos, Hedera, Keeta, NEAR, Concordium, XRPL, Cardano. | [Networks & Token Support](https://docs.x402.org/core-concepts/network-and-token-support) |
| Supported assets | Solana: "Any SPL or Token-2022 token", transferred by SPL Transfer. Default asset for dollar-string pricing on Solana mainnet is USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals). | Same page, "Token Support" and "Default Assets" tables |
| Accepted address types | Standard Solana base58 addresses (EOA). Smart wallets (Squads, Swig, SPL Governance) only if the facilitator enables `enableSmartWalletVerification`. | [exact scheme](https://docs.x402.org/schemes/exact), "SVM Smart Wallet Support" |
| Authentication | No API key for the protocol itself. The buyer signs a payment payload with its own key; the seller verifies. A production facilitator may impose its own auth. | [FAQ](https://docs.x402.org/faq), "Do I have to expose my private key to my backend?" |
| Custody model | Non-custodial with respect to the facilitator: "The facilitator does not hold funds or act as a custodian." The buyer's key signs; the facilitator relays and sponsors gas. | [Facilitator](https://docs.x402.org/core-concepts/facilitator) |
| Test environments | Yes. The default `https://x402.org/facilitator` supports Base Sepolia, **Solana devnet**, Stellar testnet, Aptos testnet, Hedera testnet, XRPL testnet. Explicitly "Testnet only". | Networks page, "Quick Reference" table |
| **Verdict** | **Available** for paying NPC service fees in USDC on Solana. | |

### The native-SOL problem (this is a real blocker for one design choice)

The specification (§3) asks for native SOL as a user-facing funding option. x402's
documented Solana asset support is **"Any SPL or Token-2022 token"** with transfer method
**"SPL Transfer"**. Native SOL is a lamport balance, not an SPL token, and it does not
appear anywhere in x402's supported-asset tables. Wrapped SOL is an SPL mint and would
therefore be mechanically eligible, but it is not listed as a supported or default asset
for Solana in the documentation, so it must be confirmed with whichever facilitator is
chosen rather than assumed.

Practical consequence: **an ordinary SystemProgram SOL transfer is not an x402 payment and
must never be labelled as one.** To take SOL from the user and pay via x402, the design
needs an explicit quoted SOL→USDC conversion (Jupiter) inside the job's cost envelope and
signature flow — exactly as §3 requires.

### Production facilitator is a required decision, not a default

The docs are emphatic: *"the public `x402.org` facilitator is intended for development and
testnet workflows. Do not assume it is the default path for production mainnet routes."*
Mainnet requires a production facilitator, a self-hosted facilitator, or self-facilitation.
The published list of production options that mention Solana coverage includes Corbits,
Dexter ("free public… no account required"), PayAI ("No API keys required") and Solvador.
Source: [Facilitators](https://docs.x402.org/dev-tools/facilitators.md). That page states
it "is not an exhaustive catalog", and none of these were exercised.

### Operational details worth capturing now

- `exact` is strict equality. Overpayment and underpayment both fail. ([FAQ, Troubleshooting](https://docs.x402.org/faq))
- `exact` is a push payment and irreversible; refunds must be application-level. (FAQ)
- Solana duplicate-settlement race is real and mitigated by a built-in `SettlementCache`
  (120 s TTL). If we settle directly without a facilitator we must implement equivalent
  duplicate detection ourselves. ([Facilitator](https://docs.x402.org/core-concepts/facilitator))
- `settlement_pending` is a **non-terminal** state carrying a broadcast transaction hash.
  It must be reconciled on chain, not retried blindly. This maps directly onto the
  `unknown` receipt state the repository already models in `src/server/chain.ts`.

---

## 2. Jupiter — Solana swap aggregation

| Column | Finding | Evidence |
| --- | --- | --- |
| Capability needed | SOL→USDC for x402 funding (§3), and the Broker's general Solana swaps (§8). | Spec §3, §8 |
| Actual SDK / package | No SDK is required; it is a REST API at `https://api.jup.ag/swap/v2`. The community client `@jup-ag/api` exists at **6.0.48** (published 3 Aug 2026) but targets the older surface; `@jup-ag/core` is **4.0.0-beta.21**. Recommend calling the REST API directly. | `npm view`, 27 Sep 2026 |
| Supported networks | Solana **mainnet only**. A search of the full Jupiter documentation index found no devnet or testnet swap endpoint; the single devnet reference in the whole index is an unrelated Jupiter **Lend** program address. | [Swap API overview](https://developers.jup.ag/docs/swap); `dev.jup.ag/docs/llms.txt` |
| Supported assets | Any SPL mint with routable liquidity, across Metis (on-chain), JupiterZ (RFQ), Dflow, OKX. | Swap API overview, "Routing engines" |
| Accepted address types | Solana base58 addresses; `taker` required, optional separate `payer`. | [Get Order spec](https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml) |
| Authentication | `x-api-key` header. **Keyless access exists at 0.5 RPS with no sign-up.** Free tier 1 RPS after sign-up at `developers.jup.ag/portal`; Developer $25/mo 10 RPS; Launch $100/mo 50 RPS; Pro $500/mo 150 RPS. | [Portal setup / rate limits](https://developers.jup.ag/docs/portal/rate-limits.md) |
| Custody model | Non-custodial. Jupiter returns an unsigned assembled transaction (Meta-Aggregator `/order`) or raw instructions (Router `/build`). The user's wallet signs. | Swap API overview, "Choosing a path" |
| Test environments | **None for swaps.** Mainnet only. | As above |
| **Verdict** | **Available** (mainnet-only, no credential strictly required to start). | |

**Live read-only verification performed.** A keyless `GET /swap/v2/order` for
0.1 SOL → USDC returned HTTP 200, `router: metis`, `inAmount: 100000000`,
`outAmount: 12210481`. This was a quote only: no transaction was signed, submitted, or
funded. It confirms the endpoint, the host, and the keyless tier are real.

Note for §12: because Jupiter has no test network, the SOL→USDC funding conversion cannot
be exercised end-to-end anywhere except mainnet with real SOL. Quoting, however, can be
exercised freely and for free.

---

## 3. NEAR Intents / 1Click — cross-chain conversion

| Column | Finding | Evidence |
| --- | --- | --- |
| Capability needed | Convert Solana-side value into ZEC and pay out to the user's Zcash address (§6). | Spec §6 |
| Actual SDK / package | REST API at `https://1click.chaindefuser.com/v0`. Official TypeScript client `@defuse-protocol/one-click-sdk-typescript` exists at **0.1.26**, published 22 Sep 2026. | `npm view`, 27 Sep 2026 |
| Supported networks | 41 deposit chains in the live OpenAPI `ChainDepositAddress` enum, including `sol` and `zec`. | [OpenAPI schema](https://1click.chaindefuser.com/docs/v0/openapi.yaml) |
| Supported assets | 198 assets in the live `/v0/tokens` response. Exactly one native-Zcash-chain asset: `nep141:zec.omft.near`, `blockchain: "zec"`, 8 decimals. (Four other "ZEC" entries are wrapped ZEC on Solana, Starknet, Aptos and NEAR — not the Zcash chain.) | Live `GET /v0/tokens`, 27 Sep 2026 |
| Accepted address types | **Zcash: transparent only.** The chain-support page states "⚠️ Partially supported - Transparent addresses only", listing `t1`/`t3` prefixes, and the token table says "ZEC (Zcash, transparent only)". | [Supported Chains](https://docs.near-intents.org/resources/chain-support) |
| Authentication | Partner JWT, sent as `X-API-Key` or `Authorization: Bearer`. Optional: unauthenticated requests work but incur an extra 0.2% fee. Obtain at `partners.near-intents.org`; the market-maker path requires KYC/KYB. | [API Keys](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication) |
| Custody model | Deposit-address custody. The user sends funds to a quote-specific `depositAddress` controlled by the protocol; solvers fill; the protocol withdraws to `recipient`. Funds are out of our control between deposit and settlement. Failure path is `REFUNDED` to `refundTo`. | [Making a Request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request) |
| Test environments | **None.** "There is no testnet version of NEAR Intents - use small amounts for test swaps." | [Quickstart introduction](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction) |
| **Verdict** | **Partially available.** SOL→ZEC conversion is real and quotable today. Payout to a Zcash **shielded** receiver is **not documented as supported**. | |

### Live read-only verification performed (dry quotes only)

All probes used `"dry": true`, which the documentation defines as "validate parameters and
get a quote without executing the swap". No deposit address was used, no funds were sent,
and no transaction was signed.

| Probe | Result |
| --- | --- |
| SOL → ZEC, recipient = format-valid mainnet `t1` transparent address | **Accepted.** Quote returned: 0.1 SOL in → 0.00734324 ZEC out, `withdrawFee: 32000`, `timeEstimate: 135`. Confirms the SOL→ZEC pair is live and transparent payout is real. |
| Same, recipient = a synthetic `u1…` placeholder | Rejected, HTTP 400, `"recipient is not valid"`. |
| Same, recipient = 5 genuinely valid mainnet unified addresses from the official ZIP-316 test vectors that contain **no transparent receiver** (Sapling+Orchard only) | **All five accepted.** Quotes returned. |
| Same, recipient = 5 valid unified addresses that **do** contain a transparent receiver | All five accepted. |
| Same, recipient = a valid UA containing an unknown/experimental typecode (65533) | Rejected, `"recipient is not valid"`. |

Unified addresses were taken from
[`zcash/zcash-test-vectors`](https://github.com/zcash/zcash-test-vectors/blob/master/test-vectors/json/unified_address.json),
the canonical ZIP-316 vectors, and classified by receiver set using the column order
declared in that repository's `unified_address.py` generator.

**This is the single most important finding in this document, and it is a trap.**

1Click's quote-time recipient validator parses unified addresses and **accepts
shielded-only unified addresses**. It rejects only malformed strings and UAs containing
receiver typecodes it does not recognise. Therefore:

- **Quote-time acceptance is not evidence of shielded payout.** The API will hand you a
  priced quote for a shielded-only UA even though the documentation says transparent only.
- The documented position — transparent only — is the only sourced statement about what
  actually gets delivered. The OpenAPI schema contains **no occurrence** of "shielded",
  "orchard", "sapling", or "unified address" anywhere in its 46,366 lines.
- Consequently, a naive implementation that trusts the API's acceptance would announce a
  shielded delivery it cannot substantiate, and would find out the truth only after real
  funds were already inside a deposit address. This is exactly the failure mode §6 step 1
  warns against ("Do not infer privacy from a prefix or silently downgrade").
- Resolving the contradiction requires an actual mainnet swap with real ZEC, then
  inspecting the delivered transaction. **That has not been done and cannot be done without
  spending live funds.**

### Confidential Intents is not Zcash shielded support

1Click offers a `confidentiality` parameter (`public` | `basic` | `advanced`) and
`CONFIDENTIAL_INTENTS` deposit/recipient types. The documentation describes this as
unlinkability *within the NEAR Intents layer*: "Confidential Intents: deposits and
withdrawals cannot be tracked to each other."
([Confidential Swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps))
It says nothing about Zcash pools and is not evidence of shielded receiver support. Per
§7, this must never be presented to a user as a shielded Zcash transaction.

---

## 4. Alternative conversion providers with claimed shielded payout

The brief asked specifically whether *any* verified provider pays out to a shielded
receiver. One genuine candidate surfaced, and it does not close the route.

### Maya Protocol

| Column | Finding | Evidence |
| --- | --- | --- |
| Capability needed | SOL → shielded ZEC in one hop. | Spec §6 |
| Supported networks | Bitcoin, Ethereum, Arbitrum, Dash, Kujira, THORChain, Radix, Zcash. **Solana is not a supported native chain.** | [Getting Started](https://docs.mayaprotocol.com/introduction/readme/getting-started) |
| Zcash address support (official docs) | "**Zcash (ZEC) - Native ZEC (Transparent addresses only)**" | Same page, verbatim |
| Zcash shielded support (claimed elsewhere) | A retroactive grant application claims "full end-to-end shielded" support with outbound sends to Unified, Sapling and Orchard receivers, merged Dec 2025. | [Zcash Community Forum thread](https://forum.zcashcommunity.com/t/maya-protocol-advanced-shielded-zec-support-retroactive-grant/54593); [grant issue](https://github.com/Financial-Privacy-Foundation/ZcashCoinholderGrantsProgram/issues/19) |
| **Verdict** | **Unavailable for this route.** | |

Two independent reasons this does not help:

1. **No Solana.** Maya cannot take SOL at all, so it cannot be the flagship route's
   conversion leg without inserting another cross-chain hop first.
2. **The official documentation contradicts the claim.** Maya's own docs say transparent
   only. A grant application is a funding request, not provider documentation, and the
   same forum thread contains a developer conceding that inbound "has to go through our
   transparent vault" and that full Orchard support would require adding FROST to their
   existing GG20 TSS. Per the brief's own rule, this is not sufficient evidence.

No other provider was found with explicit documentation of Zcash shielded receiver
support. Searches surfaced wallet-side work (for example an Unstoppable Wallet pull
request adding unified-address resolution for swap destinations) but wallet-side address
resolution is not provider-side shielded delivery.

---

## 5. Zcash wallet stack — the shielding and shielded-send leg

Because every verified conversion provider pays out transparent, the route requires us to
operate a Zcash wallet that receives transparent, shields, and then sends shielded. These
are the real options.

### 5a. librustzcash (Rust crates)

| Column | Finding | Evidence |
| --- | --- | --- |
| Actual packages and versions | `zcash_client_backend` **0.24.0**, `zcash_client_sqlite` **0.22.0**, `zcash_keys` **0.16.1**, `zcash_primitives` **0.30.1**, `zcash_address` **0.13.0**, `zcash_protocol` **0.10.6**, `zcash_transparent` **0.10.0**, `orchard` **0.15.5**, `sapling-crypto` **0.7.0**, `pczt` **0.9.3**, `zcash_pool_migration` **0.1.0** | crates.io API, 27 Sep 2026 |
| Maintenance status | **Actively maintained.** Last push 27 Sep 2026; 403 stars; 385 open issues; most crates updated Jul–Sep 2026. | [GitHub API](https://github.com/zcash/librustzcash) |
| Self-declared production readiness | "This repository contains a **(work-in-progress)** set of Rust crates". Security Warnings: "**These libraries are under development and have not been fully reviewed.**" | [README](https://github.com/zcash/librustzcash) |
| Required operations exposed | Yes, all of them, as libraries: chain scanning and wallet data storage (`zcash_client_backend`), SQLite persistence (`zcash_client_sqlite`), ZIP-32 key and Unified address derivation (`zcash_keys`), Sapling and Orchard note handling, transaction construction and proving (`zcash_primitives`, `zcash_proofs`), partially-constructed transactions for split signing (`pczt`), ZIP-321 payment URIs (`zip321`). | README "Crates" section |
| Custody / key-management burden | **Maximum.** These are libraries, not a wallet. We would hold spending keys, implement seed generation and encryption, run and checkpoint chain sync, implement a confirmation policy, handle reorgs, implement backup and restore, and expose the whole thing to a Rust↔Node boundary this repository does not currently have. | — |
| **Verdict** | **Partially available.** The primitives are all there and maintained; the wallet is not. | |

### 5b. Zallet (RPC wallet)

| Column | Finding | Evidence |
| --- | --- | --- |
| Actual package / version | GitHub releases only: **v0.1.0-beta.3**, 26 Aug 2026 (beta.1 12 Jul 2026, beta.2 28 Jul 2026). The `zallet` crate on crates.io is a **0.0.0 placeholder last touched 30 Oct 2024** — it is not the wallet and must not be depended on. | GitHub releases API; crates.io API, 27 Sep 2026 |
| Maintenance status | Actively maintained. Last push 25 Sep 2026; 40 stars; 239 open issues. | [GitHub API](https://github.com/zcash/zallet) |
| Self-declared production readiness | "**Current phase: Beta release.** Breaking changes may occur at any time, **requiring you to delete and recreate your Zallet wallet**. **Many JSON-RPC methods that will be ported from `zcashd` have not yet been implemented.** We will be rapidly making changes as we release new beta versions." Also: "These crates are under development and have not been fully reviewed." | [README](https://github.com/zcash/zallet) |
| Required operations exposed | A full-node JSON-RPC wallet, so the shape is right — but the README explicitly says the ported RPC surface is incomplete, so **each required call (sync status, receipt detection, shielding, shielded spend, rescan/restore) must be individually confirmed against beta.3 before it is relied on.** This was not done here; it needs a running node. | README |
| Custody / key-management burden | High but conventional: we hold the wallet and its keys, plus a full node. Mitigating feature: reproducible/deterministic builds via StageX. Aggravating feature: "delete and recreate your wallet" is a documented possibility between betas, which is a data-loss risk for a wallet holding customer funds mid-job. | README |
| **Verdict** | **Partially available.** Closest thing to a usable wallet service; explicitly beta, explicitly incomplete, explicitly not review-complete. | |

### 5c. zcash-devtool (CLI)

| Column | Finding | Evidence |
| --- | --- | --- |
| Actual package / version | **Not on crates.io** (`crate 'zcash-devtool' does not exist`). No GitHub releases. "No binary artifacts are provided for this crate; it is generally used via `cargo run`." | crates.io API; GitHub releases API; README |
| Maintenance status | Active: last push 31 Aug 2026; 25 stars. | [GitHub API](https://github.com/zcash/zcash-devtool) |
| Self-declared production readiness | "**DO NOT USE THIS IN PRODUCTION!!!**" … "This app has not been written with security in mind." … "should not be considered production-ready. The command-line API that this tool exposes can and will change at any time and without warning." | [README](https://github.com/zcash/zcash-devtool) |
| Required operations exposed | Yes, and usefully so for a **test harness**: `init` (testnet or mainnet), `sync`, `restore-mnemonic`, `upgrade` for migrations, age-encrypted mnemonic storage, configurable lightwallet server. | README |
| Custody / key-management burden | Not applicable — it disclaims production custody outright. | — |
| **Verdict** | **Available for testnet prototyping only. Unavailable as production custody**, by its own explicit instruction. | |

### 5d. zcashd — ruled out

`zcash/zcash` is **archived** on GitHub as of the 27 Sep 2026 check (last release v6.20.0,
3 Jun 2026, repository push 19 Jul 2026). Zallet's own README describes the zcashd wallet
as "deprecated". **zcashd is not an option for new work.**

### 5e. Zebra — a node, not a wallet

`ZcashFoundation/zebra` is actively maintained (**v6.4.2**, released 25 Sep 2026; last push
26 Sep 2026; 615 stars) and is the live consensus node. It does **not** provide wallet
functionality. `zcash/lightwalletd` (**v0.5.4**, 27 Aug 2026) is likewise a bandwidth-
efficient blockchain interface, not a wallet or a signer. Per §6, a blockchain data server
must not be mistaken for a wallet or a signer — both of these fall on the node side of that
line and must be paired with 5a or 5b.

---

## 6. Zcash privacy requirements we are bound by (draft ZIP 315)

Not an integration, but it constrains the design, so it is recorded here.

Source: [ZIP 315, Best Practices for Wallet Implementations](https://zips.z.cash/zip-0315).
**Status: Draft.** Owners: Daira-Emma Hopwood, Jack Grigg, Kris Nuttycombe.

- "It is RECOMMENDED that wallets only hold funds as shielded in the long term… it SHOULD
  auto-shield such funds by default."
- "Wallets SHOULD NOT auto-shield from multiple transparent addresses in the same
  transaction, and SHOULD NOT use opportunistic shielding." Shielding from several
  transparent addresses at once links those addresses to each other. For us this means
  **one transparent receive address per job**, shielded on its own.
- "A shielding transaction is always linked to the transparent addresses it spends from."
  This is the unavoidable privacy cost of a transparent-payout conversion leg, and §7
  requires we disclose it rather than paper over it.
- Recommended confirmation policy: **10 confirmations for untrusted TXOs, 3 for trusted**.
  Funds arriving from a conversion provider are untrusted. This sets the real latency floor
  for the shielding stage and must drive the Courier's state machine, not an invented number.
- "Wallets SHOULD NOT spend funds from a transparent address in a transaction with an
  external recipient, unless the user gives explicit consent."
- Seeds: a 24-word BIP-39 mnemonic is required to meet the ZIP-32 entropy requirement.
- Explicit warning: "The policies implemented by the legacy zcashd internal wallet are
  known to be in violation of this ZIP."

Background on the shielded/transparent distinction, for user-facing copy:
"Shielded Zcash addresses keep your financial information private. Transparent addresses
make that information public."
([z.cash](https://z.cash/learn/what-is-the-difference-between-shielded-and-transparent-zcash/))

---

## 7. Package existence check — complete results

Every package below was checked against the real registry on 27 September 2026. Nothing is
recommended that was not confirmed to exist.

### npm — confirmed present

| Package | Version |
| --- | --- |
| `@x402/core`, `@x402/fetch`, `@x402/axios`, `@x402/express`, `@x402/evm`, `@x402/svm`, `@x402/near`, `@x402/hono` | 2.27.0 |
| `x402`, `x402-express`, `x402-fetch` (legacy unscoped) | 1.2.0 |
| `@solana/web3.js` | 1.99.0 (already a dependency) |
| `@solana/kit` | 8.3.0 |
| `@solana/spl-token` | 0.4.15 (already a dependency) |
| `@defuse-protocol/one-click-sdk-typescript` | 0.1.26 |
| `@jup-ag/api` | 6.0.48 |
| `@jup-ag/core` | 4.0.0-beta.21 |
| `near-api-js` | 7.3.1 |
| `@near-js/client` | 2.5.1 |

### crates.io — confirmed present

`zcash_client_backend` 0.24.0 · `zcash_client_sqlite` 0.22.0 · `zcash_keys` 0.16.1 ·
`zcash_primitives` 0.30.1 · `zcash_address` 0.13.0 · `zcash_protocol` 0.10.6 ·
`zcash_transparent` 0.10.0 · `orchard` 0.15.5 · `sapling-crypto` 0.7.0 · `pczt` 0.9.3 ·
`zip32` 0.2.1 · `zcash_pool_migration` 0.1.0

### Things that do **not** exist as expected — stated plainly

| Expected | Reality |
| --- | --- |
| `zallet` as an installable crate | **Placeholder only.** crates.io shows 0.0.0, last updated 30 Oct 2024, 1044 downloads. The real artifact is the GitHub release `v0.1.0-beta.3`. Do not add `zallet` to a `Cargo.toml` expecting the wallet. |
| `zcash-devtool` on crates.io | **Does not exist.** `crate 'zcash-devtool' does not exist`. Use `cargo run` from a git checkout, as its README instructs. |
| A Jupiter devnet/testnet swap endpoint | **Does not exist.** No devnet or testnet swap endpoint appears anywhere in Jupiter's documentation index. |
| A NEAR Intents testnet | **Does not exist.** Stated outright in their own quickstart. |
| An x402 native-SOL asset path | **Not documented.** Solana support is SPL / Token-2022 only. |

### Documentation URLs — all reachable

All fifteen URLs named in the brief were fetched successfully on 27 September 2026, plus
the 1Click `/v0/tokens` endpoint, the Jupiter documentation index, the x402 facilitators
page, the three Zcash READMEs (via `raw.githubusercontent.com`), and the Maya Protocol
docs. **No URL failed to resolve, so nothing in this document is a guess about
unreachable content.**

One access note: `github.com` HTML pages returned only repository metadata through the
fetch tool, so the librustzcash, Zallet and zcash-devtool READMEs were retrieved from
`raw.githubusercontent.com/<repo>/main/README.md` instead, and repository state was read
from the GitHub REST API. The quoted text is from those raw files.

---

## 8. Summary grid

| Provider | Capability needed | Verdict | Test environment |
| --- | --- | --- | --- |
| x402 (`@x402/*` 2.27.0) | Paid NPC services, USDC on Solana | **Available** | Solana devnet, via x402.org facilitator |
| x402 | Native SOL as the payment asset | **Unavailable** as documented | — |
| Jupiter Swap API v2 | SOL→USDC funding; Broker swaps | **Available** (keyless tier works) | **None — mainnet only** |
| NEAR Intents 1Click 0.1.26 | SOL→ZEC conversion | **Available** | **None — no testnet** |
| NEAR Intents 1Click | Payout to Zcash **shielded** receiver | **Unavailable** as documented | — |
| Maya Protocol | SOL→shielded ZEC | **Unavailable** (no Solana; docs say transparent only) | — |
| librustzcash (11 crates) | Shield + shielded spend | **Partially available** (maintained, not review-complete, library-only) | Zcash testnet |
| Zallet v0.1.0-beta.3 | Wallet service: sync, receive, shield, spend | **Partially available** (beta; incomplete RPC surface) | Zcash testnet |
| zcash-devtool | Prototyping / test harness | **Available for testnet only**; production use disclaimed | Zcash testnet |
| zcashd | Wallet | **Unavailable** — repository archived, wallet deprecated | — |
| Zebra v6.4.2 / lightwalletd v0.5.4 | Consensus node / chain data | **Available**, but neither is a wallet or signer | Zcash testnet |
| **Complete SOL→shielded-ZEC route** | End-to-end | **Blocked** | **None — see below** |

---

## 9. The flagship route: feasibility finding

The four questions from the brief, answered directly.

### 9.1 Does any verified provider pay out to a Zcash shielded receiver?

**No provider was verified as doing so.**

- **NEAR Intents 1Click:** official chain-support documentation says Zcash is "Partially
  supported - Transparent addresses only", and the token table repeats "ZEC (Zcash,
  transparent only)". The OpenAPI schema never mentions shielded pools, Sapling, Orchard,
  or unified addresses. Its quote endpoint nonetheless *accepts* shielded-only unified
  addresses, which makes this actively dangerous rather than merely limited: the API's
  behaviour invites an assumption its documentation contradicts.
- **Maya Protocol:** official docs say "Transparent addresses only", and it has no Solana
  support regardless. The shielded claim exists only in a grant application, which the
  brief's own evidentiary standard excludes.
- **No other provider** was found with explicit documentation of shielded receiver support.

### 9.2 Realistic options for operating the shielding wallet

See §5 above for the full evidence. In short:

| Option | Maintained? | Self-declared production-ready? | Exposes sync / receipt / shield / shielded-spend / restart-recovery? | Custody burden |
| --- | --- | --- | --- | --- |
| **librustzcash** 0.24.0 et al. | Yes, very actively | **No** — "work-in-progress", "have not been fully reviewed" | Yes, as libraries — we must build the wallet around them | **Highest.** We hold keys, build sync, reorg handling, backup, restore, and a Rust↔Node boundary that does not exist in this repo today |
| **Zallet** v0.1.0-beta.3 | Yes | **No** — "Current phase: Beta release"; breaking changes may require deleting and recreating the wallet; "many JSON-RPC methods… have not yet been implemented" | Shape is right; the specific calls must be individually verified against beta.3 against a running node — not yet done | High but conventional: our node, our wallet, our keys, plus a documented risk of wallet recreation between betas |
| **zcash-devtool** | Yes | **No** — "DO NOT USE THIS IN PRODUCTION!!!" | Yes (`init`, `sync`, `restore-mnemonic`, `upgrade`) | N/A — production use disclaimed; excellent as a **testnet** harness |
| **zcashd + wallet** | **No — archived** | N/A | N/A | Ruled out |
| **Zebra + lightwalletd** | Yes (v6.4.2 / v0.5.4) | Yes, as a node | **No** — neither is a wallet or a signer | Must be paired with librustzcash or Zallet |

There is **no maintained, self-declared-production-ready Zcash wallet backend** among the
options in the brief. Every candidate carries an explicit warning from its own authors.
The honest ranking is: Zallet beta.3 for the service shape, librustzcash if we need control
Zallet's incomplete RPC surface cannot give us, zcash-devtool for the testnet harness only.

### 9.3 Is there a test environment for the complete route?

**No.**

- Zcash **testnet** exists, and `zcash-devtool` initialises testnet wallets directly
  (`init … -n test`), so **stages 6–9 of the Courier route — transparent receipt detection,
  shielding, spendability, shielded send, confirmation tracking, restart/rescan — are all
  testable for free.**
- The **conversion leg is mainnet-only.** NEAR Intents states it outright: "There is no
  testnet version of NEAR Intents." Jupiter has no devnet swap endpoint either.
- x402 has a Solana **devnet** facilitator, so the payment leg is testable.

Therefore: **the full route cannot be tested without real funds.** Payment (devnet) and
Zcash wallet operation (testnet) can each be fully tested in isolation. The conversion in
the middle can only ever be exercised on mainnet with real SOL and real ZEC. A dry quote is
not a swap, and the spec (§13) is right to demand these be reported as distinct results.

### 9.4 The exact blocking dependency, in one sentence

**No verified conversion provider delivers ZEC to a shielded receiver, so a genuine
shielded-to-shielded delivery requires us to operate our own custodial mainnet Zcash
wallet — built on components whose authors declare them beta, unreviewed, or explicitly
not for production — on a route whose conversion leg has no test network, meaning the
flagship feature cannot be completed or even end-to-end tested without holding customer
funds and spending real money.**

### 9.5 The unsentimental version

A genuine shielded delivery, as specified, requires operating custodial infrastructure on
mainnet with real money and no test path. That is the honest conclusion.

It decomposes into four costs that should be accepted or rejected explicitly, before any
code is written:

1. **Custody.** We become a custodian of customer ZEC between the conversion payout and the
   shielded send. §4 is clear that this cannot be called noncustodial merely because the
   user signed the original deposit.
2. **Unreviewed dependencies in the signing path.** Every available option carries its
   authors' own warning. "Not fully reviewed" is about cryptographic wallet code that will
   hold customer funds.
3. **A privacy claim that is narrower than it sounds.** The conversion leg is public and
   the shielding transaction is permanently linked to the transparent address it spends
   from (ZIP 315). Only the **final hop** is shielded. §7 requires we say exactly that.
4. **No end-to-end test path.** The first complete execution of the flagship route will be
   on mainnet with real money, by construction.

If those four are not acceptable, the correct move is not to build a worse version of the
flagship route. It is to build everything around it — which, per the plan in
`docs/implementation-plan.md`, is the large majority of the specification and needs no
credentials at all — and to render the Courier's shielded route as explicitly blocked, with
this document as the reason.
