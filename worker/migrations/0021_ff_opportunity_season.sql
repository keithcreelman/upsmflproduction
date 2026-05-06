-- 0021_ff_opportunity_season.sql
-- Advanced ETL deliverable #2 (Keith 2026-04-26 — handoff plan
-- ~/.claude/plans/advanced_data_etl_handoff.md).
--
-- Per-(season, gsis_id) FPOE = total_fp - total_xfp from
-- nflreadpy.load_ff_opportunity (full PPR scoring per nflverse default).
-- Populated by pipelines/etl/scripts/fetch_nflverse_ff_opportunity.py.
-- This is a NEW table — no overlap with nfl_player_weekly. Keeps the
-- "one fetcher per column" rule from data_quality_findings_20260425.md.

CREATE TABLE IF NOT EXISTS nfl_player_ff_opportunity_season (
  season       INTEGER NOT NULL,
  gsis_id      TEXT    NOT NULL,
  position     TEXT,
  games        INTEGER,
  total_fp     REAL,           -- actual fantasy points (full PPR)
  total_xfp    REAL,           -- expected fantasy points
  fpoe         REAL,           -- total_fp - total_xfp
  fpoe_per_g   REAL,
  rec_xfp      REAL,
  rec_fpoe     REAL,
  rush_xfp     REAL,
  rush_fpoe    REAL,
  pass_xfp     REAL,
  pass_fpoe    REAL,
  PRIMARY KEY (season, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_ffopp_player_season ON nfl_player_ff_opportunity_season (gsis_id, season);
