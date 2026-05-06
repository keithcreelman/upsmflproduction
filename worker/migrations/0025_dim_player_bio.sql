-- 0025_dim_player_bio.sql
-- Player biographical reference data sourced from nflreadpy.load_players().
-- Owned exclusively by pipelines/etl/scripts/fetch_nflverse_player_bio.py.
-- One row per gsis_id; updated via UPSERT.

CREATE TABLE IF NOT EXISTS dim_player_bio (
  gsis_id          TEXT PRIMARY KEY,
  display_name     TEXT,
  position         TEXT,
  position_group   TEXT,
  birth_date       TEXT,            -- ISO YYYY-MM-DD
  height_in        INTEGER,         -- inches
  weight_lb        INTEGER,
  college          TEXT,
  rookie_season    INTEGER,
  last_season      INTEGER,
  draft_year       INTEGER,
  draft_round      INTEGER,
  draft_pick       INTEGER,
  draft_team       TEXT,
  pfr_id           TEXT,
  espn_id          TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_dim_player_bio_pfr ON dim_player_bio (pfr_id);
CREATE INDEX IF NOT EXISTS idx_dim_player_bio_pos ON dim_player_bio (position);
