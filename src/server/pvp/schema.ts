/* ------------------------------------------------------------------ *
 * PvP tables.
 *
 * The DDL that used to live here now lives in the migration list
 * (`store/migrations.ts`, core migrations 002 and 003) so there is one
 * place that describes the schema and one place that applies it. This file
 * is the handle the PvP modules already import, kept so their imports did
 * not all have to change.
 *
 * Gold is deliberately absent. It used to be here — `game_gold` and
 * `game_gold_ledger`, in the same file as `profiles` — and it now lives in
 * the financial database behind `money/ledger.ts`. Core migration 005
 * retires the old tables.
 * ------------------------------------------------------------------ */

import { db } from '../db'

export { db }
