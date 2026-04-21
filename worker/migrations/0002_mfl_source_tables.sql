-- Phase 3 migration 0002: MFL source tables for Worker-native lookups.
--
-- Populated from the local mfl_database.db via scripts/load_local_to_d1.py.
-- The tables below hold the minimum column set /api/player-bundle (and
-- future endpoints) need to serve the full player-profile experience
-- without the laptop.
--
-- Naming convention: `src_*` = raw MFL-derived data. Corrections apply
-- at read-time via the `corrections` table from 0001 — never mutate
-- src_* rows in place, insert a correction instead.

CREATE TABLE IF NOT EXISTS src_contracts (
  season          INTEGER NOT NULL,
  player_id       TEXT NOT NULL,
  franchise_id    TEXT,
  team_name       TEXT,
  salary          INTEGER,
  contract_year   INTEGER,
  contract_length INTEGER,
  contract_status TEXT,
  contract_info   TEXT,
  tcv             INTEGER,
  aav             INTEGER,
  extension_flag  INTEGER,
  year_values_json TEXT,
  source_detail   TEXT,
  generated_at_utc TEXT,
  PRIMARY KEY (season, player_id)
);
CREATE INDEX IF NOT EXISTS idx_src_contracts_player ON src_contracts (player_id);
CREATE INDEX IF NOT EXISTS idx_src_contracts_franchise ON src_contracts (season, franchise_id);

CREATE TABLE IF NOT EXISTS src_adddrop (
  season          INTEGER NOT NULL,
  txn_index       INTEGER NOT NULL,
  player_id       TEXT NOT NULL,
  move_type       TEXT NOT NULL,
  franchise_id    TEXT,
  franchise_name  TEXT,
  method          TEXT,
  salary          INTEGER,
  unix_timestamp  INTEGER,
  datetime_et     TEXT,
  PRIMARY KEY (season, txn_index, player_id, move_type)
);
CREATE INDEX IF NOT EXISTS idx_src_adddrop_player ON src_adddrop (player_id, unix_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_src_adddrop_last_add ON src_adddrop (player_id, move_type, unix_timestamp DESC);

CREATE TABLE IF NOT EXISTS src_trades (
  row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transactionid   TEXT NOT NULL,
  season          INTEGER NOT NULL,
  txn_index       INTEGER NOT NULL,
  trade_group_id  TEXT,
  franchise_id    TEXT,
  franchise_name  TEXT,
  asset_role      TEXT,
  asset_type      TEXT,
  player_id       TEXT,
  player_name     TEXT,
  comments        TEXT,
  unix_timestamp  INTEGER,
  datetime_et     TEXT
);
CREATE INDEX IF NOT EXISTS idx_src_trades_txn ON src_trades (transactionid);
CREATE INDEX IF NOT EXISTS idx_src_trades_player ON src_trades (player_id, unix_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_src_trades_franchise ON src_trades (season, franchise_id);

CREATE TABLE IF NOT EXISTS src_weekly (
  season                 INTEGER NOT NULL,
  week                   INTEGER NOT NULL,
  player_id              TEXT NOT NULL,
  pos_group              TEXT,
  status                 TEXT,
  score                  REAL,
  is_reg                 INTEGER,
  roster_franchise_id    TEXT,
  roster_franchise_name  TEXT,
  pos_rank               INTEGER,
  overall_rank           INTEGER,
  PRIMARY KEY (season, week, player_id)
);
CREATE INDEX IF NOT EXISTS idx_src_weekly_player ON src_weekly (player_id, season DESC, week DESC);
CREATE INDEX IF NOT EXISTS idx_src_weekly_season ON src_weekly (season, week);

CREATE TABLE IF NOT EXISTS src_draft_picks (
  season                INTEGER NOT NULL,
  draftpick_round       INTEGER,
  draftpick_roundorder  INTEGER,
  draftpick_overall     INTEGER,
  franchise_id          TEXT,
  franchise_name        TEXT,
  player_id             TEXT,
  player_name           TEXT,
  unix_timestamp        INTEGER,
  datetime_et           TEXT,
  source                TEXT NOT NULL,
  PRIMARY KEY (season, draftpick_overall, source)
);
CREATE INDEX IF NOT EXISTS idx_src_draft_picks_player ON src_draft_picks (player_id);
CREATE INDEX IF NOT EXISTS idx_src_draft_picks_franchise ON src_draft_picks (season, franchise_id);

CREATE TABLE IF NOT EXISTS src_load_manifest (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at_utc    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  src_table     TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  source_sha    TEXT,
  source_host   TEXT,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_src_load_manifest_table ON src_load_manifest (src_table, ran_at_utc DESC);
