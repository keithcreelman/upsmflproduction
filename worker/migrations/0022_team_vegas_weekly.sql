-- 0022_team_vegas_weekly.sql
-- Advanced ETL deliverable #3 (Keith 2026-04-26 — handoff plan
-- ~/.claude/plans/advanced_data_etl_handoff.md).
--
-- Per-(season, week, team) implied team total derived from
-- nflreadpy.load_schedules `spread_line` + `total_line`. NEW table —
-- no overlap with nfl_team_weekly (which is owned by the PBP fetcher).
-- spread_line convention (verified 2026-04-26): home team's spread,
-- negative = home favored. So team_spread = -spread_line for home,
-- +spread_line for away. implied = total/2 ± spread_line/2.
-- Populated by pipelines/etl/scripts/fetch_vegas_team_totals.py.

CREATE TABLE IF NOT EXISTS nfl_team_vegas_weekly (
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  team           TEXT    NOT NULL,
  opponent       TEXT,
  is_home        INTEGER,        -- 1 if team is home, else 0
  spread         REAL,           -- this team's spread (negative = favored)
  total_line     REAL,           -- game total
  implied_total  REAL,           -- this team's implied points
  actual_score   INTEGER,        -- NULL for unplayed games
  PRIMARY KEY (season, week, team)
);
CREATE INDEX IF NOT EXISTS idx_vegas_team_season ON nfl_team_vegas_weekly (team, season);
