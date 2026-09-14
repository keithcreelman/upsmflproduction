-- 0151_ups_bad_beats.sql
--
-- Archive of real bench-vs-start "bad beat" stories -- one per (season, week,
-- franchise), computed from pipelines/etl/wire/wire_data.py's bench_burns()
-- (the Wire's already-audited comparison, verdict-classified process vs
-- variance so a genuine misplay is never confused with bad luck).
--
-- WHY THIS EXISTS (Keith 2026-09-14): the /therapy bot needed a way to mix
-- things up instead of reciting the same career-stat facts every time, and
-- to occasionally needle whoever's named in a vent ("shit on Hammer's
-- week..."). bench_burns() already has exactly this material, verified and
-- fair, but it lives in the Python ETL pipeline and reads src_weekly, which
-- the Cloudflare Worker cannot query directly at request time (same reason
-- ups_owner_career_stats and ups_roast_owner_ammo exist as D1 mirrors of
-- Python-computed facts). This table is that mirror for bad beats.
--
-- Populated by pipelines/etl/scripts/sync_bad_beats_to_d1.py, run by hand
-- (same "Keith runs it after data changes" pattern as sync_owner_ammo_to_d1
-- and rebuild_franchise_career_stats -- see also owner-career-stats.yml if
-- this ever needs a schedule).

CREATE TABLE IF NOT EXISTS ups_bad_beats (
  season             INTEGER NOT NULL,
  week               INTEGER NOT NULL,
  franchise_id       TEXT NOT NULL,   -- zero-padded 4-digit fid
  pos                TEXT,
  benched_name       TEXT,
  benched_id         TEXT,
  benched_score      REAL,
  started_name       TEXT,
  started_id         TEXT,
  started_score      REAL,
  diff               REAL NOT NULL,
  verdict            TEXT NOT NULL,   -- 'process' | 'variance' | 'unknown', see bench_burns()
  matchup_result     TEXT,            -- 'won' | 'lost' | 'tied' -- NULL for a multi-opponent week (15-17) or no data
  matchup_margin     REAL,            -- absolute point margin of that single game, NULL if unknown
  swing_flips_result INTEGER,         -- 1 if benched_score - started_score would have flipped a loss to a win, else 0/NULL
  synced_at_utc      TEXT NOT NULL,
  PRIMARY KEY (season, week, franchise_id)
);

CREATE INDEX IF NOT EXISTS idx_bad_beats_franchise ON ups_bad_beats(franchise_id);
CREATE INDEX IF NOT EXISTS idx_bad_beats_diff ON ups_bad_beats(diff);
