-- 0023_team_coaching_history.sql
-- Advanced ETL deliverable #4 (Keith 2026-04-26 — handoff plan
-- ~/.claude/plans/advanced_data_etl_handoff.md).
--
-- Per-(season, team) head coach history with year-with-team counter
-- and change flags. HC sourced from nflreadpy.load_schedules
-- (home_coach/away_coach cols, available 1999+, verified 100% coverage
-- 2011-2025). OC/DC kept in schema as nullable — no nflverse source
-- yet, populate via PFR scrape later if needed. Populated by
-- pipelines/etl/scripts/fetch_coaching_changes.py.

CREATE TABLE IF NOT EXISTS nfl_team_coaching_history (
  season              INTEGER NOT NULL,
  team                TEXT    NOT NULL,
  hc_name             TEXT,
  oc_name             TEXT,           -- NULL until OC source wired
  dc_name             TEXT,           -- NULL until DC source wired
  hc_year_with_team   INTEGER,        -- 1 = first year as HC of this team
  oc_year_with_team   INTEGER,
  dc_year_with_team   INTEGER,
  hc_change_flag      INTEGER,        -- 1 if HC differs from prior season
  oc_change_flag      INTEGER,
  dc_change_flag      INTEGER,
  PRIMARY KEY (season, team)
);
CREATE INDEX IF NOT EXISTS idx_coaching_team ON nfl_team_coaching_history (team, season);
