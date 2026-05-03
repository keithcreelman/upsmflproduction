-- 0024_player_breakaway_season.sql
-- Per-(season, gsis_id, role) breakaway-play counts at three thresholds.
-- Sourced exclusively from nflreadpy.load_pbp via
-- pipelines/etl/scripts/fetch_nflverse_breakaway.py.
--
-- "role" splits rushing and receiving so a player who does both gets two
-- rows (Christian McCaffrey shows up as 'rusher' AND 'receiver').
--
-- Rushing scope: pure designed runs only (play_type='run' AND
-- qb_dropback=0). Scrambles/sacks are excluded — we want RB ability,
-- not QB mobility leaking into the signal.
--
-- Receiving scope: completed catches (play_type='pass' AND
-- complete_pass=1).
--
-- Columns owned exclusively by this fetcher per the
-- one-fetcher-per-column rule.

CREATE TABLE IF NOT EXISTS nfl_player_breakaway_season (
  season             INTEGER NOT NULL,
  gsis_id            TEXT    NOT NULL,
  role               TEXT    NOT NULL,    -- 'rusher' | 'receiver'
  position           TEXT,
  attempts           INTEGER,              -- designed carries OR receptions
  yards              INTEGER,              -- total yards on qualifying plays
  longest            INTEGER,              -- single longest play
  plays_15plus       INTEGER,
  yards_15plus       INTEGER,
  plays_20plus       INTEGER,
  yards_20plus       INTEGER,
  plays_40plus       INTEGER,
  yards_40plus       INTEGER,
  PRIMARY KEY (season, gsis_id, role)
);
CREATE INDEX IF NOT EXISTS idx_breakaway_player_season
  ON nfl_player_breakaway_season (gsis_id, season);
CREATE INDEX IF NOT EXISTS idx_breakaway_season_role
  ON nfl_player_breakaway_season (season, role);
