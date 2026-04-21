-- Phase 3 migration 0003: positional scoring baselines.
--
-- Per (season, pos_group), gives the 50th-percentile starter score and
-- the 50→80 percentile gap (delta_win_pos). Used at read time to
-- compute week-level z-scores and classify weeks as
-- Elite / Plus / Neutral / Dud, same convention as the old Python
-- bridge. Source: metadata_positionalwinprofile in mfl_database.db.

CREATE TABLE IF NOT EXISTS src_baselines (
  season               INTEGER NOT NULL,
  pos_group            TEXT NOT NULL,
  score_p50_pos        REAL,
  score_p80_pos        REAL,
  delta_win_pos        REAL,
  starter_sample_count INTEGER,
  PRIMARY KEY (season, pos_group)
);

CREATE INDEX IF NOT EXISTS idx_src_baselines_lookup ON src_baselines (season, pos_group);
