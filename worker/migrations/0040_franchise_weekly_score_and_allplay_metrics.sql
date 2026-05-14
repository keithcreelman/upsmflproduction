-- 0030_franchise_weekly_score_and_allplay_metrics.sql
-- Per-week per-franchise score table (canonical source for all derived
-- all-play metrics) + season metadata table + 9 new columns on src_standings
-- breaking allplay into regseason / playoff / full so analytics can pivot
-- without touching weekly data.
--
-- Decision history (Keith 2026-05-09):
--   - Local DB's standings.allplay_w/l matches weeklyresults-derived AP
--     for 2011-2025 (180/192). 2010 differs across three data sources due
--     to historical lineup-submission inconsistency (no enforcement until
--     the weekly top-scorer prize was added).
--   - We adopt weeklyresults.team_score as the single source of truth.
--   - Three metrics (regseason / playoff / full) replace the old single
--     allplay_w/l on the analytics side. Old columns retained for backward
--     compat but flagged as legacy.

-- 1) Per-week per-franchise score (the foundation)
CREATE TABLE IF NOT EXISTS src_franchise_weekly_score (
  season           INTEGER NOT NULL,
  week             INTEGER NOT NULL,
  franchise_id     TEXT    NOT NULL,
  team_score       REAL,
  team_opt_pts     REAL,
  is_playoff       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, week, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_fws_season_week ON src_franchise_weekly_score (season, week);
CREATE INDEX IF NOT EXISTS idx_src_fws_franchise   ON src_franchise_weekly_score (franchise_id, season DESC, week DESC);

-- 2) Per-season metadata (drives "what counts as regular season" per year)
CREATE TABLE IF NOT EXISTS src_league_season_meta (
  season                       INTEGER PRIMARY KEY,
  league_id                    TEXT,
  mfl_server                   TEXT,
  last_regular_season_week     INTEGER,
  total_weeks                  INTEGER,
  reg_weeks                    INTEGER,
  playoff_weeks                INTEGER,
  notes                        TEXT
);

-- 3) Add three AP-metric triplets to src_standings
ALTER TABLE src_standings ADD COLUMN allplay_regseason_w INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_regseason_l INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_regseason_t INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_playoff_w   INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_playoff_l   INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_playoff_t   INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_full_w      INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_full_l      INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_full_t      INTEGER;
