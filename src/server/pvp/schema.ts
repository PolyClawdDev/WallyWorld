/* ------------------------------------------------------------------ *
 * PvP tables. Game gold lives here, not on the profile row (that gold
 * is client-asserted hunt loot) and not in receipts (those are SOL).
 * ------------------------------------------------------------------ */

import { db } from '../db'

db.exec(`
  create table if not exists pvp_accounts (
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
  );
  create unique index if not exists pvp_accounts_account on pvp_accounts(account_id);

  create table if not exists game_gold (
    player_id      text primary key,
    available      integer not null,
    reserved       integer not null,
    wins           integer not null default 0,
    losses         integer not null default 0,
    draws          integer not null default 0,
    updated_at_ms  integer not null,
    check (available >= 0),
    check (reserved >= 0)
  );

  create table if not exists game_gold_ledger (
    id             text primary key,
    player_id      text not null,
    kind           text not null,
    amount         integer not null,
    available_after integer not null,
    reserved_after  integer not null,
    ref_type       text,
    ref_id         text,
    note           text not null,
    created_at_ms  integer not null
  );
  create index if not exists game_gold_ledger_player on game_gold_ledger(player_id, created_at_ms desc);
  create unique index if not exists game_gold_ledger_idem on game_gold_ledger(player_id, kind, ref_id);

  create table if not exists pvp_blocks (
    player_id      text not null,
    blocked_id     text not null,
    created_at_ms  integer not null,
    primary key (player_id, blocked_id)
  );

  create table if not exists pvp_challenges (
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
  );
  create index if not exists pvp_challenges_from on pvp_challenges(from_id, status);
  create index if not exists pvp_challenges_to on pvp_challenges(to_id, status);

  create table if not exists pvp_escrow (
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
  );

  create table if not exists pvp_duels (
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
  );

  create table if not exists pvp_journal (
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
  );
  create index if not exists pvp_journal_player on pvp_journal(player_id, created_at_ms desc);
`)

export { db }
