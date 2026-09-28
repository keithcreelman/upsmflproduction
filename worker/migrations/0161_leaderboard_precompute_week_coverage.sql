-- 0161 — per-team coverage for the current season's LATEST built week, so the
-- precompute can be provisional (some teams reported, some haven't played
-- yet) without ever being read as "finalized."
--
-- ⚠️ NEVER `wrangler d1 migrations apply` — the tracker is behind and applying
-- it corrupts contracts (see 0143). Apply with:
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/0161_leaderboard_precompute_week_coverage.sql
--
-- ⚠️ NOT IDEMPOTENT for the same reason as 0143 — SQLite has no `ADD COLUMN IF
-- NOT EXISTS`. A "duplicate column name" error on re-run means it already
-- applied; that is not damage.
--
-- WHY
--   0143's own comment already named the gap this closes: "data_row_count
--   catches ... a partially-loaded week that has since completed" — but a row
--   count alone can't tell "30 of 32 teams, Monday's game hasn't been played"
--   from "32 of 32 teams, a stat got corrected." Both just look like "more
--   rows than last time." 2026-09-28: Keith explicitly wants partial weeks
--   published as PROVISIONAL as soon as some teams report (don't wait for
--   Monday Night Football to show Sunday's stats) while keeping "finalized"
--   meaning exactly what it always meant — every team in, the week over.
--   That needs an actual team count, not an inferred one from a row total.
--
--   teams_reported / teams_expected are for data_max_week specifically (the
--   latest week the precompute covers), not the whole season — the same grain
--   data_max_week/data_row_count already use. teams_expected comes from
--   nfl_team_vegas_weekly (the NFL schedule, known before kickoff — byes
--   already correctly reduce it below 32), never from a hardcoded 32, so this
--   keeps working correctly in bye weeks. week_complete is the one bit that
--   actually means "finalized": 1 only when teams_reported >= teams_expected
--   AND teams_expected > 0 (a 0/0 read is "unknown," never "complete").
--
--   All three are NULLable for the same reason data_max_week/data_row_count
--   are: every row written before this migration predates them, and NULL must
--   read as "unknown, cannot prove complete" — never as "0 of 0, so complete."
ALTER TABLE nfl_leaderboard_precompute_meta ADD COLUMN teams_reported INTEGER;
ALTER TABLE nfl_leaderboard_precompute_meta ADD COLUMN teams_expected INTEGER;
ALTER TABLE nfl_leaderboard_precompute_meta ADD COLUMN week_complete INTEGER;

-- nfl_team_vegas_weekly has never had a migration (pipelines/etl/scripts/
-- fetch_schedule_vegas.py's own header calls it a pre-existing orphan table
-- with "no writer anywhere in the repo" before that script resumed feeding
-- it). Pinning its live schema here now that a second consumer (the
-- teams_expected computation above) depends on its shape.
CREATE TABLE IF NOT EXISTS nfl_team_vegas_weekly (
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  team          TEXT    NOT NULL,
  opponent      TEXT,
  is_home       INTEGER,
  spread        REAL,
  total_line    REAL,
  implied_total REAL,
  actual_score  INTEGER,
  PRIMARY KEY (season, week, team)
);
