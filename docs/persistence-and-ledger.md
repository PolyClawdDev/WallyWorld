# Persistence, identity and the gold ledger

What is stored, where, and — the part that matters — exactly which guarantees are
tested and which are not. Nothing in this document describes a payout, because
there is no payout.

## Two databases, on purpose

| | file | holds |
|---|---|---|
| core | `WALLY_DB_PATH` (default `data/wally.db`) | accounts, wallets, sessions, characters, hunts, duels |
| finance | `WALLY_FINANCE_DB_PATH` (default `<core>-finance.db`) | the ledger, reservations, jobs, receipts, withdrawals |

The split is structural rather than stylistic. SQLite cannot express a foreign key
into another database file, so no financial row can be made to depend on a game
row even by mistake. `scripts/test-migrations.ts` asserts that neither database
contains the other's tables.

The cost of the split is that a change spanning both cannot be one transaction.
Where that happens the boundary is bridged with idempotency keys and the ordering
is chosen so a crash loses a reward rather than paying one twice. Claiming a kill
is the example: the token is consumed in the core database first, then the credit
is posted to the finance database, and the credit is itself idempotent on the
token id, so a retry after a dropped response completes the pair instead of
duplicating it.

## Migrations

Forward-only and numbered, in `src/server/store/migrations.ts` — the only module
in the codebase that contains raw SQL. `runMigrations` records each migration's id
and a checksum of its statements in `schema_version`. Re-running applies nothing.
Editing a migration that has already been applied fails at startup rather than
running a database whose shape no longer matches the code.

```
core     001 core_baseline · 002 pvp_baseline · 003 identity
         004 hunt_kill_tokens · 005 retire_game_gold_tables
finance  001 ledger · 002 authorization_model · 003 job_queue
         004 payments_and_receipts · 005 withdrawals
```

Portability, since a Postgres driver is expected later: money is TEXT, arithmetic
happens in JavaScript `bigint`, booleans are integer 0/1, upserts use
`on conflict … do nothing`, and there is no `AUTOINCREMENT`, no `WITHOUT ROWID`
and no `PRAGMA` outside `store/sqlite.ts`. The one genuinely dialect-specific
part — the triggers that enforce append-only — is isolated under
`dialectSql.sqlite`.

## One account per player

A *principal* is something that identifies a session: a wallet address, a
`gst_…` guest key hash, or a `dev…` label. Every principal resolves to exactly one
`user_id`, and the `user_id` is what owns the character, the balance, the jobs and
the receipts. Linking a wallet adds a principal; it never creates an account and
never touches progression or balance.

Claiming a guest account requires an ed25519 signature over a server-issued
challenge bound to the application domain, the wallet, **the session**, a 32-byte
nonce and an expiry. Connecting a wallet proves nothing on its own. The link
statement differs from the sign-in statement and from the withdrawal-destination
statement, so none of the three signatures can be replayed as another.

If the wallet already belongs to a different account, nothing is guessed. The
challenge is marked `pending_choice` and a second authenticated call must name
either:

- **switch** — continue as the account the wallet already owns. Nothing moves. The
  wallet deliberately does not change hands, because taking it off its existing
  account would leave that account unable to sign in.
- **merge** — the wallet's account absorbs this one. Gold moves as one balanced
  transfer; the source account is marked `merged` and its principals repoint.

Both read the account and the wallet from the stored challenge row, never from the
request. There is no input to either path that names an account.

## The ledger

Append-only, double-entry, integer base units stored as TEXT.

- Every transfer's legs sum to zero, checked before anything is written.
- Gold is created by moving it **out of** `system:gold:mint`, whose negative
  balance is therefore the exact amount of gold in existence. Retired gold goes to
  `system:gold:sink`. The mint is the only account permitted to be negative.
- `ledger_entries` and `ledger_transfers` have `before update` and `before delete`
  triggers that `raise(abort, …)`. Append-only is enforced by the database.
- Balances are materialised in `ledger_balances` and written with a conditional
  UPDATE matching both the current `version` **and** the previous amount — the
  same technique `db.ts` already uses to consume a sign-in nonce. The bigint check
  makes the rule correct; the conditional UPDATE makes it correct under contention.
- Idempotency is `(scope, key)`. A repeat changes no rows and returns the original
  transfer id.

"The ledger balances" is a query, not an aspiration: `conservationReport()` sums
every balance, sums every transfer, and compares each account's balance against
the sum of its own entries. It is exposed at `GET /api/ledger/conservation` and is
the body of the `ledger.audit` job.

## Provenance and redemption eligibility

Every credit records where it came from. Eligibility is derived from one allowlist
that defaults to "no", so a new credit source cannot accidentally become cashable.

| provenance | redeemable | what it is |
|---|---|---|
| `hunt_verified` | **yes** | credited against a server-issued single-use kill token |
| `pvp_winnings` | no | taken off another player; transferred, not earned |
| `gift` | no | granted by the world, including the 250 starting gold |
| `test_credit` | no | created by a test or a dev tool |
| `legacy_demo` | no | imported from the old browser-side balance; client-asserted |
| `escrow` / `withdrawal` / `system` | no | internal movements, not origins |

```
redeemable = min(accrued redeemable credits − consumed, available balance)
```

The `available balance` term is what makes this behave correctly: spend hunt gold
in the game and the redeemable figure falls with it, so the same gold cannot be
both spent and redeemed. Winning a duel cannot raise it, because duel gold is not
in the allowlist. Eligibility does not survive a merge — the destination's
redeemable total is its own hunt history.

None of this means anything is redeemable today. See below.

## Hunt rewards: what the server actually proves

The browser runs combat. The server decides money. Opening a hunt mints a roster
of single-use tokens — the region's own population from `wildRegions`, times
`HUNT_ROSTER_ROUNDS` — each already priced from the server's copy of
`speciesSpecs`. A kill spends one token; the server credits that token's amount,
once, with `hunt_verified` provenance.

**This proves** the amount, the species and the count. A client cannot invent a
reward, name its own price, claim the same animal twice, or be paid more in a
session than the roster allows.

**This does not prove** that a fight happened. Closing that gap means simulating
wildlife server-side, which is a much larger change. The limitation is stated in
the module header, in the API response, and here.

## Jobs

Leased, not locked: a worker claims a job by writing its id and a lease expiry.
The lease is the recovery mechanism — a worker that dies leaves a lease that
expires, and `recoverExpiredLeases` (run by both the worker and the API) sorts out
what happens next. What happens next depends entirely on `retry_safety`:

- `safe_read` goes back on the queue with exponential backoff, and fails
  terminally when out of attempts.
- `financial` goes to `needs_reconcile` and is **never** retried automatically.

That distinction exists because a timeout is not evidence. The only way out of
`needs_reconcile` is `reconciled()`, which refuses a `payment_state` of `unknown`
and requires a recorded `reconcile` step carrying evidence. Each of the five state
machines (delivery, payment, conversion, shielding, transfer) keeps `unknown` as a
non-terminal state for the same reason.

`npm run worker` runs the queue alongside the other background jobs.
`npm run worker:queue` runs the queue alone.

## Withdrawals: a state machine with nothing behind it

The full machine exists — quote, authenticated destination confirmation, atomic
reservation of the player's gold and the campaign budget together, settlement,
reconciliation, cancellation — and it cannot pay anybody.

Two separate reasons, and they are not the same kind of gap:

1. **Configuration.** Five numbers are absent and have no defaults:
   `WALLY_REWARD_RATE_LAMPORTS_PER_GOLD`, `WALLY_WITHDRAWAL_MINIMUM_GOLD`,
   `WALLY_WITHDRAWAL_PER_PLAYER_LIMIT_GOLD`, `WALLY_CAMPAIGN_BUDGET_LAMPORTS`,
   `WALLY_WITHDRAWAL_FEE_RESERVE_LAMPORTS`. There is no partial success: a quote
   with four of the five would be a quote with a hole in it. `POST
   /api/withdrawals/quote` returns 409 `missing_configuration` naming each one.
   This server will not invent a reward rate.
2. **Custody.** There is no treasury signer. Not an unset variable — the process
   holds no private key and has no signing capability. `submitWithdrawal` always
   returns `no_signer`. Adding one is a custody decision.

`settled` has no outgoing transitions, which is how "cancelling does not reverse a
settled payment" is enforced rather than merely intended.

## Tested guarantees

Run with `npm run test:money`. Each of these is an assertion in a script, not a
claim in prose.

| suite | proves |
|---|---|
| `test:migrations` | applies from empty; re-runs as a no-op; append-only and quote immutability are enforced by the database; no money column is numeric |
| `test:ledger` | conservation; overspend refused; idempotent credits; eligibility capped by balance; legacy gold not redeemable; PvP escrow and settlement; hunt tokens paid once; server table agrees with the world |
| `test:concurrency` | 8 **separate processes** spend against a balance funding 7 — exactly one loses and the balance lands on zero; 8 processes replaying one key move money once |
| `test:identity` | guest→wallet claim keeps the account, character and balance; forged, cross-session and cross-statement signatures refused; switch and merge both exercised; session tokens are scrubbed from logs |
| `test:queue` | lease exclusivity; safe reads retry, financial work does not; an inconclusive reconcile leaves the job blocked; owner-only reads |
| `test:withdrawals` | the unconfigured path; only redeemable gold quotes; atomic reservation including the unfunded case; submission refuses; settlement and cancellation are idempotent |
| `test:persistence` | a second and third process read back what the first wrote, including a held reservation, and apply no migrations |
| `smoke:http` | the same surface over real HTTP, including 401 without a session and 404 for another account's job |

## Not done

- Combat is still client-side; see the hunt section above.
- The ledger is synchronous `better-sqlite3`, because the world tick reads gold
  synchronously. The async driver seam in `src/server/sql/` is not wired to it.
  All raw SQL is in one module, so the conversion is mechanical when needed.
- Level-15 progression is still browser-local. Only the character, style and name
  are server-side.
- No payout of any kind exists.
