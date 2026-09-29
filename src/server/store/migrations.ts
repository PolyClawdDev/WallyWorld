/* ------------------------------------------------------------------ *
 * Forward-only numbered migrations. All the raw SQL in the server lives
 * here (plus the prepared statements in the modules that read it back).
 *
 * Forward-only means there are no `down` scripts. A mistake is corrected
 * by a new numbered migration, never by editing an applied one: the
 * runner records a checksum and refuses to start if a migration that has
 * already run has changed underneath it, because at that point the
 * database and the code disagree about what the schema is and guessing
 * is worse than stopping.
 *
 * Two databases, and no foreign key crosses between them:
 *
 *   core     game and identity — characters, progression, sessions,
 *            wallets, guest sessions, PvP match state, hunt kill tokens.
 *   finance  money — the double-entry ledger, reservations, jobs,
 *            receipts, payment/conversion/Zcash attempts, withdrawals.
 *
 * The financial side stores `user_id` and `player_id` as opaque TEXT with
 * no foreign key, because the row they refer to lives in the other file.
 * Integrity across the seam is maintained by idempotency keys and by
 * owner checks at the API boundary, not by the engine — see
 * `docs/persistence-and-ledger.md` for exactly what that does and does
 * not guarantee.
 * ------------------------------------------------------------------ */

import type { Dialect, OpenedDatabase } from './sqlite'

export type DatabaseName = 'core' | 'finance'

export type Migration = {
  /** Strictly increasing within a database. Never renumbered. */
  id: number
  name: string
  /** Statements run in order, inside one transaction with the version bump. */
  sql?: readonly string[]
  /** Dialect-specific statements, skipped on any other dialect. */
  dialectSql?: Partial<Record<Dialect, readonly string[]>>
  /** Escape hatch for a step that needs to inspect the catalogue first. */
  run?: (db: OpenedDatabase) => void
}

/* ------------------------------------------------------------------ core */

/**
 * 001 is the schema this repository already shipped, restated verbatim as a
 * baseline. Every statement is `if not exists`, so an existing `data/wally.db`
 * adopts the migration framework without recreating or losing anything.
 */
const CORE_001_BASELINE: readonly string[] = [
  `create table if not exists profiles (
     wallet        text primary key,
     character     text not null,
     style_json    text not null,
     player_name   text not null,
     gold          integer not null,
     last_cluster  text not null,
     created_at_ms integer not null,
     updated_at_ms integer not null
   )`,
  `create table if not exists nonces (
     nonce          text primary key,
     wallet         text not null,
     domain         text not null,
     uri            text not null,
     chain_id       text not null,
     issued_at      text not null,
     expiration     text not null,
     expires_at_ms  integer not null,
     consumed_at_ms integer
   )`,
  `create index if not exists nonces_expiry on nonces(expires_at_ms)`,
  `create table if not exists sessions (
     token_sha256  text primary key,
     wallet        text not null,
     created_at_ms integer not null,
     expires_at_ms integer not null,
     last_seen_ms  integer not null
   )`,
  `create index if not exists sessions_wallet on sessions(wallet)`,
  `create index if not exists sessions_expiry on sessions(expires_at_ms)`,
  `create table if not exists demo_tasks (
     id            text primary key,
     status        text not null,
     cost          integer not null,
     created_at_ms integer not null,
     updated_at_ms integer not null
   )`,
]

/** The PvP match tables, likewise restated as a baseline. Gold is NOT here. */
const CORE_002_PVP: readonly string[] = [
  `create table if not exists pvp_accounts (
     player_id      text primary key,
     account_id     text not null unique,
     display_name   text not null,
     character      text not null,
     style_json     text not null,
     level          integer not null,
     ranks_json     text not null,
     incoming_off   integer not null default 0,
     created_at_ms  integer not null,
     updated_at_ms  integer not null
   )`,
  `create unique index if not exists pvp_accounts_account on pvp_accounts(account_id)`,
  `create table if not exists pvp_blocks (
     player_id      text not null,
     blocked_id     text not null,
     created_at_ms  integer not null,
     primary key (player_id, blocked_id)
   )`,
  `create table if not exists pvp_challenges (
     challenge_id   text primary key,
     from_id        text not null,
     to_id          text not null,
     stake          integer not null,
     ring_id        text,
     from_name      text not null,
     to_name        text not null,
     from_level     integer not null,
     to_level       integer not null,
     from_character text not null,
     to_character   text not null,
     from_available integer not null,
     to_available   integer not null,
     status         text not null,
     created_at_ms  integer not null,
     expires_at_ms  integer not null,
     resolved_at_ms integer
   )`,
  `create index if not exists pvp_challenges_from on pvp_challenges(from_id, status)`,
  `create index if not exists pvp_challenges_to on pvp_challenges(to_id, status)`,
  `create table if not exists pvp_escrow (
     duel_id        text primary key,
     challenge_id   text not null unique,
     a_id           text not null,
     b_id           text not null,
     stake          integer not null,
     pot            integer not null,
     status         text not null,
     created_at_ms  integer not null,
     settled_at_ms  integer,
     settlement_id  text unique
   )`,
  `create table if not exists pvp_duels (
     duel_id        text primary key,
     challenge_id   text not null unique,
     a_id           text not null,
     b_id           text not null,
     ring_id        text not null,
     stake          integer not null,
     phase          text not null,
     outcome        text,
     winner_id      text,
     reason         text,
     a_wizard       text not null,
     b_wizard       text not null,
     a_level        integer not null,
     b_level        integer not null,
     a_ranks        text not null,
     b_ranks        text not null,
     a_name         text not null,
     b_name         text not null,
     persist_json   text,
     created_at_ms  integer not null,
     countdown_at_ms integer,
     started_at_ms  integer,
     ended_at_ms    integer,
     settlement_id  text unique
   )`,
  `create table if not exists pvp_journal (
     id             text primary key,
     duel_id        text not null,
     player_id      text not null,
     opponent_id    text not null,
     opponent_name  text not null,
     kind           text not null,
     stake          integer not null,
     gold_delta     integer not null,
     reason         text not null,
     created_at_ms  integer not null
   )`,
  `create index if not exists pvp_journal_player on pvp_journal(player_id, created_at_ms desc)`,
]

/**
 * One canonical account per person.
 *
 * `users` is the account. `principals` is every credential that resolves to it —
 * a wallet address, a hashed guest key, a dev label — which is what makes
 * guest→wallet linking possible without creating a second player: the new
 * principal points at the user that already exists.
 *
 * `linked_wallets.wallet` is a primary key rather than merely indexed, so a
 * wallet belongs to exactly one account at the database level. That constraint is
 * what surfaces the "already linked elsewhere" case instead of silently
 * duplicating or silently stealing.
 */
const CORE_003_IDENTITY: readonly string[] = [
  `create table if not exists users (
     user_id        text primary key,
     status         text not null,
     origin         text not null,
     primary_wallet text,
     claimed_at_ms  integer,
     merged_into    text,
     created_at_ms  integer not null,
     updated_at_ms  integer not null
   )`,
  `create index if not exists users_primary_wallet on users(primary_wallet)`,
  `create table if not exists principals (
     principal_id  text primary key,
     user_id       text not null references users(user_id),
     kind          text not null,
     revoked_at_ms integer,
     created_at_ms integer not null
   )`,
  `create index if not exists principals_user on principals(user_id)`,
  `create table if not exists linked_wallets (
     wallet         text primary key,
     user_id        text not null references users(user_id),
     chain_id       text not null,
     is_primary     integer not null default 0,
     proof_nonce    text not null,
     proof_domain   text not null,
     verified_at_ms integer not null,
     created_at_ms  integer not null
   )`,
  `create index if not exists linked_wallets_user on linked_wallets(user_id)`,
  `create table if not exists guest_sessions (
     guest_sha256   text primary key,
     user_id        text not null references users(user_id),
     principal_id   text not null,
     claimed_at_ms  integer,
     claimed_wallet text,
     created_at_ms  integer not null,
     last_seen_ms   integer not null
   )`,
  `create index if not exists guest_sessions_user on guest_sessions(user_id)`,
  `create table if not exists link_challenges (
     nonce          text primary key,
     user_id        text not null references users(user_id),
     wallet         text not null,
     domain         text not null,
     uri            text not null,
     chain_id       text not null,
     session_sha256 text not null,
     intent         text not null,
     issued_at      text not null,
     expiration     text not null,
     expires_at_ms  integer not null,
     consumed_at_ms integer,
     outcome        text
   )`,
  `create index if not exists link_challenges_expiry on link_challenges(expires_at_ms)`,
  `create table if not exists account_links (
     id            text primary key,
     user_id       text not null,
     wallet        text not null,
     action        text not null,
     from_user_id  text,
     nonce         text not null,
     detail        text not null,
     created_at_ms integer not null
   )`,
  `create index if not exists account_links_user on account_links(user_id, created_at_ms desc)`,
  `create table if not exists pvp_records (
     player_id     text primary key,
     wins          integer not null default 0,
     losses        integer not null default 0,
     draws         integer not null default 0,
     updated_at_ms integer not null
   )`,
]

/**
 * Server-issued kill tokens.
 *
 * The wildlife simulation still runs in the browser, so the server cannot see a
 * fight happen. What it can do is decide, in advance and by itself, which animals
 * exist and what each is worth, hand out one single-use token per animal, and
 * refuse to pay twice for the same token. The reward amount is never read from
 * the request.
 */
const CORE_004_HUNT: readonly string[] = [
  `create table if not exists hunt_sessions (
     hunt_id        text primary key,
     user_id        text not null references users(user_id),
     player_id      text not null,
     region         text not null,
     level          integer not null,
     status         text not null,
     claimed_count  integer not null default 0,
     death_count    integer not null default 0,
     last_claim_ms  integer not null default 0,
     created_at_ms  integer not null,
     expires_at_ms  integer not null,
     closed_at_ms   integer
   )`,
  `create index if not exists hunt_sessions_user on hunt_sessions(user_id, created_at_ms desc)`,
  `create table if not exists hunt_kill_tokens (
     token_id       text primary key,
     hunt_id        text not null references hunt_sessions(hunt_id),
     user_id        text not null,
     species        text not null,
     reward_gold    text not null,
     issued_at_ms   integer not null,
     consumed_at_ms integer,
     transfer_id    text
   )`,
  `create index if not exists hunt_kill_tokens_hunt on hunt_kill_tokens(hunt_id, consumed_at_ms)`,
  `create table if not exists hunt_deaths (
     death_id       text primary key,
     hunt_id        text not null references hunt_sessions(hunt_id),
     user_id        text not null,
     client_ref     text not null,
     forfeit_gold   text not null,
     transfer_id    text,
     created_at_ms  integer not null
   )`,
  `create unique index if not exists hunt_deaths_ref on hunt_deaths(hunt_id, client_ref)`,
]

/**
 * The old PvP gold tables are retired here. Balances now live in the financial
 * database, which is the whole point of the split — `game_gold` sat in the same
 * file as `profiles`, one row away from character data.
 *
 * Retired by rename rather than by DROP: a local development database may hold a
 * balance somebody was mid-way through testing, and the import step in
 * `money/legacyImport.ts` reads these rows once and records them with
 * `legacy_demo` provenance so they can never become redeemable.
 */
const CORE_005_RETIRE_GAME_GOLD: Migration = {
  id: 5,
  name: 'retire_game_gold_tables',
  run: db => {
    for (const [from, to] of [
      ['game_gold', 'legacy_game_gold'],
      ['game_gold_ledger', 'legacy_game_gold_ledger'],
      ['receipts', 'legacy_core_receipts'],
    ] as const) {
      const exists = db.raw
        .prepare<[string], { name: string }>(`select name from sqlite_master where type = 'table' and name = ?`)
        .get(from)
      const already = db.raw
        .prepare<[string], { name: string }>(`select name from sqlite_master where type = 'table' and name = ?`)
        .get(to)
      if (exists && !already) db.raw.exec(`alter table ${from} rename to ${to}`)
      else if (exists) db.raw.exec(`drop table ${from}`)
    }
  },
}

export const CORE_MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'core_baseline', sql: CORE_001_BASELINE },
  { id: 2, name: 'pvp_baseline', sql: CORE_002_PVP },
  { id: 3, name: 'identity', sql: CORE_003_IDENTITY },
  { id: 4, name: 'hunt_kill_tokens', sql: CORE_004_HUNT },
  CORE_005_RETIRE_GAME_GOLD,
]

/* --------------------------------------------------------------- finance */

/**
 * The ledger.
 *
 * `ledger_entries` is append-only and double-entry. Every row is one leg of a
 * transfer; the legs of a transfer sum to zero, and the sum of every leg ever
 * written is zero, because gold is created by moving it out of a system account
 * that is allowed to go negative. "The ledger balances" is therefore a query,
 * and `money/ledger.ts` runs it in the conservation test.
 *
 * `ledger_balances` is a materialised total so a reservation does not have to
 * re-sum history, and it carries a `version` column. Every balance write is a
 * conditional UPDATE matching both the version and the prior amount — the same
 * shape `db.ts` already uses to consume a nonce — so two writers racing one
 * balance cannot both win.
 *
 * `reward_eligibility` is the redemption model. `accrued` only ever rises from a
 * credit whose provenance is redeemable; `consumed` rises when a withdrawal
 * reserves it. Redeemable gold is min(accrued − consumed, available balance), so
 * losing a wager reduces redeemable automatically and winning one cannot raise
 * it.
 */
const FIN_001_LEDGER: readonly string[] = [
  `create table if not exists ledger_accounts (
     account_id     text primary key,
     currency       text not null,
     kind           text not null,
     owner_user_id  text,
     allow_negative integer not null default 0,
     created_at_ms  integer not null
   )`,
  `create index if not exists ledger_accounts_owner on ledger_accounts(owner_user_id)`,
  `create table if not exists ledger_transfers (
     transfer_id   text primary key,
     kind          text not null,
     currency      text not null,
     idem_scope    text not null,
     idem_key      text not null,
     ref_type      text,
     ref_id        text,
     note          text not null,
     created_at_ms integer not null
   )`,
  `create unique index if not exists ledger_transfers_idem on ledger_transfers(idem_scope, idem_key)`,
  `create index if not exists ledger_transfers_ref on ledger_transfers(ref_type, ref_id)`,
  `create table if not exists ledger_entries (
     entry_id      text primary key,
     transfer_id   text not null references ledger_transfers(transfer_id),
     leg           integer not null,
     account_id    text not null references ledger_accounts(account_id),
     currency      text not null,
     amount        text not null,
     provenance    text not null,
     redeemable    integer not null default 0,
     owner_user_id text,
     note          text not null,
     created_at_ms integer not null
   )`,
  `create unique index if not exists ledger_entries_leg on ledger_entries(transfer_id, leg)`,
  `create index if not exists ledger_entries_account on ledger_entries(account_id, created_at_ms desc)`,
  `create index if not exists ledger_entries_owner on ledger_entries(owner_user_id, created_at_ms desc)`,
  `create table if not exists ledger_balances (
     account_id    text primary key references ledger_accounts(account_id),
     currency      text not null,
     amount        text not null,
     version       integer not null default 0,
     updated_at_ms integer not null
   )`,
  `create table if not exists reward_eligibility (
     user_id       text primary key,
     currency      text not null,
     accrued       text not null,
     consumed      text not null,
     version       integer not null default 0,
     updated_at_ms integer not null
   )`,
]

const FIN_001_TRIGGERS: readonly string[] = [
  `create trigger if not exists ledger_entries_append_only_update
     before update on ledger_entries
     begin select raise(abort, 'ledger_entries is append-only'); end`,
  `create trigger if not exists ledger_entries_append_only_delete
     before delete on ledger_entries
     begin select raise(abort, 'ledger_entries is append-only'); end`,
  `create trigger if not exists ledger_transfers_append_only_update
     before update on ledger_transfers
     begin select raise(abort, 'ledger_transfers is append-only'); end`,
  `create trigger if not exists ledger_transfers_append_only_delete
     before delete on ledger_transfers
     begin select raise(abort, 'ledger_transfers is append-only'); end`,
]

/**
 * Services, immutable quotes, bounded authorizations, budget reservations.
 *
 * `quotes` has no UPDATE path anywhere in the codebase and an append-only
 * trigger to keep it that way: a quote that can be edited after the fact is not
 * evidence of anything. A superseding quote is a new row.
 *
 * The authorization columns are the §4 list. The policy engine that reads them is
 * the sibling agent's module; this is the record it reads, and the column set is
 * deliberately complete so that agent does not have to migrate to add a field.
 */
const FIN_002_AUTHORIZATION: readonly string[] = [
  `create table if not exists services (
     service_id     text primary key,
     npc            text not null,
     label          text not null,
     status         text not null,
     owner_user_id  text,
     price_policy   text not null,
     output_schema  text,
     env_stamp      text not null,
     created_at_ms  integer not null,
     updated_at_ms  integer not null
   )`,
  `create table if not exists quotes (
     quote_id          text primary key,
     service_id        text not null references services(service_id),
     owner_user_id     text not null,
     source_network    text not null,
     source_asset      text not null,
     source_decimals   integer not null,
     dest_network      text,
     dest_asset        text,
     dest_decimals     integer,
     principal         text not null,
     service_fee       text not null,
     conversion_cost   text not null,
     network_fees      text not null,
     contingency       text not null,
     max_total_debit   text not null,
     min_net_output    text,
     slippage_bps      integer,
     provider          text not null,
     provider_ref      text,
     env_stamp         text not null,
     created_at_ms     integer not null,
     expires_at_ms     integer not null
   )`,
  `create index if not exists quotes_owner on quotes(owner_user_id, created_at_ms desc)`,
  `create table if not exists authorizations (
     authorization_id    text primary key,
     version             integer not null,
     owner_user_id       text not null,
     service_id          text not null,
     job_id              text,
     quote_id            text references quotes(quote_id),
     source_network      text not null,
     source_asset        text not null,
     max_principal       text not null,
     max_total_debit     text not null,
     service_fee         text not null,
     conversion_cost     text not null,
     network_fees        text not null,
     contingency         text not null,
     dest_network        text,
     dest_recipient      text,
     refund_destination  text,
     min_net_output      text,
     slippage_bps        integer,
     approved_providers  text not null,
     allowed_actions     text not null,
     cumulative_budget   text not null,
     cumulative_spent    text not null,
     single_use_nonce    text not null unique,
     nonce_consumed_at_ms integer,
     revoked_at_ms       integer,
     env_stamp           text not null,
     created_at_ms       integer not null,
     expires_at_ms       integer not null
   )`,
  `create index if not exists authorizations_owner on authorizations(owner_user_id, created_at_ms desc)`,
  `create table if not exists budget_reservations (
     reservation_id   text primary key,
     owner_user_id    text not null,
     authorization_id text references authorizations(authorization_id),
     job_id           text,
     purpose          text not null,
     currency         text not null,
     amount           text not null,
     status           text not null,
     transfer_id      text,
     release_transfer_id text,
     created_at_ms    integer not null,
     updated_at_ms    integer not null,
     expires_at_ms    integer,
     settled_at_ms    integer,
     released_at_ms   integer
   )`,
  `create index if not exists budget_reservations_owner on budget_reservations(owner_user_id, status)`,
  `create index if not exists budget_reservations_job on budget_reservations(job_id)`,
]

const FIN_002_TRIGGERS: readonly string[] = [
  `create trigger if not exists quotes_immutable_update
     before update on quotes
     begin select raise(abort, 'quotes are immutable'); end`,
  `create trigger if not exists quotes_immutable_delete
     before delete on quotes
     begin select raise(abort, 'quotes are immutable'); end`,
]

/**
 * The durable job queue.
 *
 * `lease_owner` / `lease_expires_at_ms` is the lock. A worker claims work with a
 * conditional UPDATE against an expired lease, so a worker that dies mid-job
 * releases it by timing out rather than by needing to be noticed.
 *
 * `retry_safety` is the important column. `safe_read` work is retried on a
 * backoff. `financial` work is not: when its lease expires or it errors, it goes
 * to `needs_reconcile` and stays there until a reconcile step writes evidence,
 * because a timeout tells you nothing about whether money moved.
 */
const FIN_003_JOBS: readonly string[] = [
  `create table if not exists jobs (
     job_id              text primary key,
     owner_user_id       text not null,
     kind                text not null,
     status              text not null,
     retry_safety        text not null,
     idempotency_key     text not null unique,
     request_json        text not null,
     result_json         text,
     delivery_state      text not null,
     payment_state       text not null,
     conversion_state    text not null,
     shielding_state     text not null,
     transfer_state      text not null,
     attempt             integer not null default 0,
     max_attempts        integer not null default 5,
     priority            integer not null default 0,
     run_after_ms        integer not null,
     lease_owner         text,
     lease_expires_at_ms integer,
     last_error          text,
     reconcile_reason    text,
     env_stamp           text not null,
     created_at_ms       integer not null,
     updated_at_ms       integer not null,
     terminal_at_ms      integer
   )`,
  `create index if not exists jobs_claimable on jobs(status, run_after_ms, priority)`,
  `create index if not exists jobs_owner on jobs(owner_user_id, created_at_ms desc)`,
  `create table if not exists job_steps (
     step_id       text primary key,
     job_id        text not null references jobs(job_id),
     seq           integer not null,
     name          text not null,
     status        text not null,
     attempt       integer not null default 0,
     detail        text,
     evidence_json text,
     started_at_ms integer not null,
     ended_at_ms   integer
   )`,
  `create unique index if not exists job_steps_seq on job_steps(job_id, seq)`,
  `create table if not exists artifacts (
     artifact_id   text primary key,
     job_id        text references jobs(job_id),
     owner_user_id text not null,
     kind          text not null,
     media_type    text not null,
     byte_length   integer not null,
     sha256        text not null,
     storage_ref   text not null,
     env_stamp     text not null,
     created_at_ms integer not null
   )`,
  `create index if not exists artifacts_owner on artifacts(owner_user_id, created_at_ms desc)`,
  `create table if not exists idempotency_keys (
     scope         text not null,
     idem_key      text not null,
     owner_user_id text not null,
     state         text not null,
     response_json text,
     created_at_ms integer not null,
     updated_at_ms integer not null,
     primary key (scope, idem_key)
   )`,
  `create table if not exists monitors (
     monitor_id     text primary key,
     owner_user_id  text not null,
     kind           text not null,
     target         text not null,
     status         text not null,
     cursor_json    text,
     interval_ms    integer not null,
     next_run_ms    integer not null,
     budget_amount  text not null,
     budget_spent   text not null,
     coverage_gaps  text not null,
     expires_at_ms  integer,
     env_stamp      text not null,
     created_at_ms  integer not null,
     updated_at_ms  integer not null
   )`,
  `create index if not exists monitors_due on monitors(status, next_run_ms)`,
]

/**
 * Receipts and the three attempt logs.
 *
 * `receipts` moves here from the game database. Each attempt table keeps its own
 * state column with a non-terminal `unknown`, matching `chain.ts`'s
 * `TransferVerdict`: a thing we have not heard back about is not a thing that
 * failed.
 */
const FIN_004_PAYMENTS: readonly string[] = [
  `create table if not exists receipts (
     receipt_id      text primary key,
     owner_user_id   text not null,
     job_id          text,
     kind            text not null,
     service         text not null,
     network         text not null,
     asset           text not null,
     amount          text not null,
     recipient       text not null,
     signature       text,
     status          text not null,
     detail          text,
     env_stamp       text not null,
     created_at_ms   integer not null,
     updated_at_ms   integer not null,
     confirmed_at_ms integer
   )`,
  `create unique index if not exists receipts_signature on receipts(signature)`,
  `create index if not exists receipts_owner on receipts(owner_user_id, created_at_ms desc)`,
  `create table if not exists payment_attempts (
     attempt_id       text primary key,
     job_id           text references jobs(job_id),
     owner_user_id    text not null,
     authorization_id text,
     idem_key         text not null unique,
     network          text not null,
     asset            text not null,
     amount           text not null,
     payer            text,
     recipient        text not null,
     state            text not null,
     provider         text not null,
     provider_ref     text,
     evidence_json    text,
     env_stamp        text not null,
     created_at_ms    integer not null,
     updated_at_ms    integer not null,
     reconciled_at_ms integer
   )`,
  `create index if not exists payment_attempts_state on payment_attempts(state, updated_at_ms)`,
  `create table if not exists conversion_attempts (
     attempt_id       text primary key,
     job_id           text references jobs(job_id),
     owner_user_id    text not null,
     quote_id         text references quotes(quote_id),
     idem_key         text not null unique,
     source_asset     text not null,
     dest_asset       text not null,
     amount_in        text not null,
     min_amount_out   text not null,
     amount_out       text,
     deposit_address  text,
     deposit_memo     text,
     provider         text not null,
     provider_ref     text,
     state            text not null,
     evidence_json    text,
     env_stamp        text not null,
     created_at_ms    integer not null,
     updated_at_ms    integer not null,
     reconciled_at_ms integer
   )`,
  `create table if not exists zcash_operations (
     operation_id     text primary key,
     job_id           text references jobs(job_id),
     owner_user_id    text not null,
     idem_key         text not null unique,
     op_kind          text not null,
     pool             text,
     amount           text not null,
     source_address   text,
     dest_address     text,
     dest_receiver    text,
     confirmations    integer not null default 0,
     required_confirmations integer not null,
     state            text not null,
     txid             text,
     evidence_json    text,
     env_stamp        text not null,
     created_at_ms    integer not null,
     updated_at_ms    integer not null,
     reconciled_at_ms integer
   )`,
]

/**
 * The withdrawal machine.
 *
 * There is no treasury key and no payout call, so `submitted` is reachable only
 * with an explicit configuration this repository does not ship. What exists and
 * is tested is everything before it: quoting, authenticated destination
 * confirmation, the atomic reservation of eligible rewards against treasury
 * funds, and the idempotent completion and reconcile paths.
 *
 * `withdrawal_events` is the audit trail of transitions, append-only, so a
 * withdrawal that ends in `reconcile_required` can be explained.
 */
const FIN_005_WITHDRAWALS: readonly string[] = [
  `create table if not exists withdrawals (
     withdrawal_id      text primary key,
     owner_user_id      text not null,
     state              text not null,
     currency           text not null,
     gold_amount        text not null,
     rate_lamports_per_gold text,
     gross_lamports     text,
     fee_lamports       text,
     net_lamports       text,
     dest_network       text,
     dest_address       text,
     dest_confirmed_at_ms integer,
     dest_proof_nonce   text,
     reservation_id     text,
     treasury_reservation_id text,
     config_fingerprint text,
     missing_config     text,
     signature          text,
     failure_reason     text,
     idem_key           text not null unique,
     env_stamp          text not null,
     created_at_ms      integer not null,
     updated_at_ms      integer not null,
     quoted_at_ms       integer,
     reserved_at_ms     integer,
     submitted_at_ms    integer,
     terminal_at_ms     integer
   )`,
  `create index if not exists withdrawals_owner on withdrawals(owner_user_id, created_at_ms desc)`,
  `create index if not exists withdrawals_state on withdrawals(state, updated_at_ms)`,
  `create table if not exists withdrawal_events (
     event_id      text primary key,
     withdrawal_id text not null references withdrawals(withdrawal_id),
     seq           integer not null,
     from_state    text not null,
     to_state      text not null,
     reason        text not null,
     evidence_json text,
     created_at_ms integer not null
   )`,
  `create unique index if not exists withdrawal_events_seq on withdrawal_events(withdrawal_id, seq)`,
  `create table if not exists treasury_reservations (
     reservation_id text primary key,
     withdrawal_id  text not null references withdrawals(withdrawal_id),
     currency       text not null,
     amount         text not null,
     fee_reserve    text not null,
     status         text not null,
     transfer_id    text,
     release_transfer_id text,
     created_at_ms  integer not null,
     updated_at_ms  integer not null,
     released_at_ms integer
   )`,
  `create index if not exists treasury_reservations_status on treasury_reservations(status)`,
]

/* ------------------------------------------------------------------ *
 * An NPC service purchase, paid for in game gold.
 *
 * One row per order, and the row is the receipt. It records the price the
 * server charged (never a price the client named), the two ledger transfers
 * that moved the gold, and the artifact that was handed over — so a receipt
 * can be re-derived from the gold ledger rather than asserted beside it.
 *
 * `state` is the whole safety story: an order is `reserved` (gold in escrow,
 * nothing delivered), `delivered` (gold spent, artifact readable) or
 * `refunded` (gold back, nothing delivered). The artifact is only ever
 * readable in `delivered`, and the charge only ever happens on the way into
 * it, so there is no state in which one exists without the other.
 *
 * `(owner_user_id, idempotency_key)` is unique, which is what stops two
 * concurrent clicks becoming two charges for one artifact.
 * ------------------------------------------------------------------ */
const FIN_006_SERVICE_ORDERS: readonly string[] = [
  `create table if not exists service_orders (
     order_id            text primary key,
     owner_user_id       text not null,
     service_id          text not null,
     price               text not null,
     state               text not null,
     idempotency_key     text not null,
     request_json        text not null,
     reserve_transfer_id text,
     settle_transfer_id  text,
     artifact_id         text,
     artifact_kind       text,
     artifact_title      text,
     artifact_text       text,
     artifact_sha256     text,
     failure             text,
     created_at_ms       integer not null,
     updated_at_ms       integer not null,
     delivered_at_ms     integer
   )`,
  `create unique index if not exists service_orders_idem on service_orders(owner_user_id, idempotency_key)`,
  `create index if not exists service_orders_owner on service_orders(owner_user_id, created_at_ms desc)`,
  `create index if not exists service_orders_state on service_orders(state, updated_at_ms)`,
]

export const FINANCE_MIGRATIONS: readonly Migration[] = [
  { id: 1, name: 'ledger', sql: FIN_001_LEDGER, dialectSql: { sqlite: FIN_001_TRIGGERS } },
  { id: 2, name: 'authorization_model', sql: FIN_002_AUTHORIZATION, dialectSql: { sqlite: FIN_002_TRIGGERS } },
  { id: 3, name: 'job_queue', sql: FIN_003_JOBS },
  { id: 4, name: 'payments_and_receipts', sql: FIN_004_PAYMENTS },
  { id: 5, name: 'withdrawals', sql: FIN_005_WITHDRAWALS },
  { id: 6, name: 'service_orders', sql: FIN_006_SERVICE_ORDERS },
]

export const MIGRATIONS: Record<DatabaseName, readonly Migration[]> = {
  core: CORE_MIGRATIONS,
  finance: FINANCE_MIGRATIONS,
}
