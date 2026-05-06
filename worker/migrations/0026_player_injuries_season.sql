-- 0026_player_injuries_season.sql
-- Per-(season, gsis_id) injury-report rollup.
-- Source: nflreadpy.load_injuries() (NFL official injury reports).
-- Owned by pipelines/etl/scripts/fetch_nflverse_injuries.py.
--
-- weeks_out         = count of game weeks where report_status='Out'
-- weeks_doubtful    = count where report_status='Doubtful'
-- weeks_questionable= count where report_status='Questionable'
-- weeks_designated  = count of any non-null report_status (any flag)
-- distinct_body_parts = count of unique report_primary_injury values
--                       across the season (proxy for breadth of injury history)

CREATE TABLE IF NOT EXISTS nfl_player_injuries_season (
  season              INTEGER NOT NULL,
  gsis_id             TEXT    NOT NULL,
  weeks_out           INTEGER,
  weeks_doubtful      INTEGER,
  weeks_questionable  INTEGER,
  weeks_designated    INTEGER,
  distinct_body_parts INTEGER,
  PRIMARY KEY (season, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_injuries_player_season ON nfl_player_injuries_season (gsis_id, season);
