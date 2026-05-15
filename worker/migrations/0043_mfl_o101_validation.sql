-- 0032_mfl_o101_validation.sql
-- Backup/validation store for MFL's authoritative All-Play Standings
-- (TYPE=options&O=101) numbers. Populated as a one-time historical
-- correction on 2026-05-09. Going forward, the primary AP-metric path
-- is `weeklyresults.team_score` → derived in `src_standings`. This
-- table is reference-only — re-scrape periodically and diff against
-- src_standings if you want to audit drift.
--
-- Each row is per (season, franchise_id, cutoff) where cutoff is one of
-- ('reg' = W=last_regular_season_week, 'full' = W=total_weeks).

CREATE TABLE IF NOT EXISTS src_mfl_o101_validation (
  season           INTEGER NOT NULL,
  franchise_id     TEXT    NOT NULL,
  cutoff_label     TEXT    NOT NULL,    -- 'reg' or 'full'
  cutoff_week      INTEGER NOT NULL,    -- the W= value used (e.g. 13 or 16)
  all_play_w       INTEGER,
  all_play_l       INTEGER,
  all_play_t       INTEGER,
  fetched_at_utc   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_url       TEXT,
  PRIMARY KEY (season, franchise_id, cutoff_label)
);
CREATE INDEX IF NOT EXISTS idx_o101_val_season ON src_mfl_o101_validation (season, cutoff_label);
