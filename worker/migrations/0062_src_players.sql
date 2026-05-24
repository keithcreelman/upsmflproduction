-- 0062_src_players.sql
-- Mirror of MFL's TYPE=players export — canonical player roster covering
-- ALL players who have ever existed in MFL's player ID space, including:
--   • Retired (Drew Brees, Todd Gurley, T.Y. Hilton, …)
--   • Defensive players (LB/DB/DE/DT/S that may never score in our scoring)
--   • Team defenses (TMDL position)
--   • Practice-squad / never-rostered
--
-- Why we need this (Keith 2026-05-24): player_points_history.json is
-- scorers-only and won't resolve any of the above. The player_id_crosswalk
-- (via nfl-data-py sleeper match) only covers ~2.8K modern fantasy
-- players. Backfill scripts, audit queries, and any future reconciliation
-- against MFL's canonical player ID space need a comprehensive table.
--
-- Source: local mfl_database.db `players` table (sourced from MFL
-- TYPE=players per-season exports). ~42K rows across 16 seasons
-- (2010-2025), ~8.6K distinct player_ids.
--
-- Keyed (season, player_id) — matches MFL's per-season export and lets
-- us track NFL team changes year-over-year (e.g. "what team was Will
-- Fuller on in 2019" vs "what team was he on in 2021").
--
-- Loaded by scripts/load_local_to_d1.py (table "src_players"). Should
-- be refreshed nightly by sync_d1.sh — new rookies / FA pickups land
-- here before they can be resolved by any audit or backfill.

CREATE TABLE IF NOT EXISTS src_players (
  season           INTEGER NOT NULL,
  player_id        TEXT    NOT NULL,
  name             TEXT,                 -- "Last, First" per MFL convention
  position         TEXT,
  nfl_team         TEXT,
  status           TEXT,
  raw_json         TEXT,                 -- full MFL row for any field
                                         -- not promoted to a column
  updated_at_utc   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season, player_id)
);

-- Lookup by name (most common use: "Brees, Drew" → 4925).
CREATE INDEX IF NOT EXISTS idx_src_players_name
  ON src_players(name);

-- Lookup by player_id across seasons (e.g. "show me every season Hilton
-- appears in"). Already covered by PK ordering but explicit index helps
-- when scanning by player_id alone.
CREATE INDEX IF NOT EXISTS idx_src_players_player_id
  ON src_players(player_id);

-- Position+season for roster composition queries.
CREATE INDEX IF NOT EXISTS idx_src_players_season_pos
  ON src_players(season, position);
