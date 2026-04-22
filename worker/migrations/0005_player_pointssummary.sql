-- 0005_player_pointssummary.sql
-- Season-level aggregates from pipelines/etl (`player_pointssummary`).
-- Minimal column subset — UI currently uses games_played, ppg,
-- pos_rank (by total points), pos_ppg_rank, overall_rank, overall_ppg_rank.
-- Load plan mirrors the local SQLite schema column order; loader will
-- select exactly this list from `mfl_database.db`.

CREATE TABLE IF NOT EXISTS src_pointssummary (
  season INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  positional_grouping TEXT,
  games_played INTEGER,
  points_total REAL,
  ppg REAL,
  reg_games INTEGER,
  reg_points REAL,
  reg_ppg REAL,
  post_games INTEGER,
  post_points REAL,
  post_ppg REAL,
  started_games INTEGER,
  started_points REAL,
  started_ppg REAL,
  overall_rank INTEGER,
  pos_rank INTEGER,
  overall_ppg_rank INTEGER,
  pos_ppg_rank INTEGER,
  PRIMARY KEY (season, player_id)
);

CREATE INDEX IF NOT EXISTS idx_pointssummary_player
  ON src_pointssummary (player_id, season);
CREATE INDEX IF NOT EXISTS idx_pointssummary_season_pos
  ON src_pointssummary (season, positional_grouping);
