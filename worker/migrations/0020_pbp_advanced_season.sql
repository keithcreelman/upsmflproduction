-- 0020_pbp_advanced_season.sql
-- Advanced ETL deliverable #1 (Keith 2026-04-26 — handoff plan
-- ~/.claude/plans/advanced_data_etl_handoff.md).
--
-- Two NEW tables sourced exclusively from nflreadpy.load_pbp via
-- pipelines/etl/scripts/fetch_nflverse_pbp_advanced.py. Per the
-- "Lurking Rule" in the handoff plan, these tables MUST NOT overlap
-- with nfl_player_weekly / nfl_player_advstats_season cols — every
-- field below is owned exclusively by the new fetcher.

-- Per-(season, gsis_id, role) — EPA/success per play with role split
-- so a QB also showing up as a rusher gets two rows (passer + rusher).
CREATE TABLE IF NOT EXISTS nfl_player_pbp_season (
  season         INTEGER NOT NULL,
  gsis_id        TEXT    NOT NULL,
  position       TEXT,
  role           TEXT    NOT NULL,    -- 'passer' | 'rusher' | 'receiver'
  n_plays        INTEGER,
  epa_per_play   REAL,
  cpoe           REAL,                -- only populated when role='passer'
  success_rate   REAL,
  PRIMARY KEY (season, gsis_id, role)
);
CREATE INDEX IF NOT EXISTS idx_pbp_player_season ON nfl_player_pbp_season (gsis_id, season);

-- Per-(season, team) — PROE, pace, and offense/defense EPA per play.
-- proe + neutral_pass_rate computed against neutral game-state filter
-- (Q1-Q3, score within 7); pace is league-wide play-clock seconds.
CREATE TABLE IF NOT EXISTS nfl_team_pbp_season (
  season              INTEGER NOT NULL,
  team                TEXT    NOT NULL,
  proe                REAL,            -- mean(pass - xpass) on neutral plays
  neutral_pass_rate   REAL,            -- pass_attempts / plays on neutral plays
  sec_per_play        REAL,            -- avg gap between plays (pace proxy)
  off_epa_per_play    REAL,            -- offense EPA per play (all situations)
  def_epa_per_play    REAL,            -- defense EPA per play allowed
  PRIMARY KEY (season, team)
);
CREATE INDEX IF NOT EXISTS idx_team_pbp_season ON nfl_team_pbp_season (team, season);
