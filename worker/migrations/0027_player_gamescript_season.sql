-- 0027_player_gamescript_season.sql
-- Per-(season, gsis_id, role) plays + yards split by game-script category.
-- Source: nflreadpy.load_pbp() filtered by score_differential.
-- Owned by pipelines/etl/scripts/fetch_nflverse_gamescript.py.
--
-- Game-script buckets:
--   leading  : team's posteam_score - defteam_score >= +7
--   neutral  : -7 < score_differential < +7
--   trailing : score_differential <= -7
--
-- Rushing scope = play_type='run' AND qb_dropback=0 (matches breakaway).
-- Receiving scope = play_type='pass' AND complete_pass=1 (catches only).

CREATE TABLE IF NOT EXISTS nfl_player_gamescript_season (
  season              INTEGER NOT NULL,
  gsis_id             TEXT    NOT NULL,
  role                TEXT    NOT NULL,        -- 'rusher' | 'receiver'
  plays_leading       INTEGER,
  plays_neutral       INTEGER,
  plays_trailing      INTEGER,
  yards_leading       INTEGER,
  yards_neutral       INTEGER,
  yards_trailing      INTEGER,
  PRIMARY KEY (season, gsis_id, role)
);
CREATE INDEX IF NOT EXISTS idx_gamescript_player_season
  ON nfl_player_gamescript_season (gsis_id, season);
