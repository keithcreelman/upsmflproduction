-- 0144 — an indexed, case-normalized display_name for nfl_player_names
--
-- ⚠️ NEVER `wrangler d1 migrations apply` — the tracker is ~47 entries behind
-- and applying it corrupts contracts. Apply with:
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/0144_nfl_player_names_lower_index.sql
--
-- WHY
--   scripts/espn_solve_scoring.py (branch claude/yahoo-fantasy-football-pipeline,
--   PR #961) joins ESPN's fantasy_players to this table on
--     LOWER(n.display_name) = LOWER(f.full_name)
--   nfl_player_names has NO index on display_name at all — not case-sensitive,
--   not case-insensitive — so every run scans the whole table PER OUTER ROW.
--   Measured on prod 2026-08-28 (d1 insights, 6h): 3.5-4.5M rows read per run,
--   matching ~180 outer rows x 25,764 nfl_player_names rows almost exactly.
--   Three runs in six hours alone would be most of the 5,000,000/day free tier
--   — and this table is SHARED with the UPS/MFL leaderboard
--   (worker/src/index.js), on the SAME D1 instance and the SAME daily budget.
--
--   fantasy_players already has an indexed normalized_name column for exactly
--   this kind of fallback match (migration 0134) — but it is populated for 0
--   of 1,028 ESPN rows (checked live), so it was not available to use.
--
-- WHY A VIRTUAL GENERATED COLUMN, NOT A PLAIN BACKFILLED ONE
--   A plain `display_name_lower TEXT` column needs a one-time backfill AND a
--   loader change so every future INSERT also populates it — miss either step
--   and new rows silently go unindexed and unmatched, the exact "forgot to
--   populate the fallback" trap fantasy_players.normalized_name fell into.
--   A VIRTUAL generated column cannot go stale: SQLite computes it from
--   display_name on every read, for every row, old or new, with nothing for
--   any loader to remember. Confirmed empirically on prod (throwaway probe
--   table, dropped) 2026-08-28:
--     ALTER TABLE ... ADD COLUMN x GENERATED ALWAYS AS (...) STORED
--       -> REJECTED: "cannot add a STORED column" (SQLite cannot add a STORED
--          generated column to an existing table without a full rewrite)
--     ALTER TABLE ... ADD COLUMN x GENERATED ALWAYS AS (...) VIRTUAL
--       -> accepted, computes correctly, and IS indexable — EXPLAIN QUERY PLAN
--          on the probe showed a real index SEARCH, not a scan.
--
-- No backfill statement follows because none is needed or possible: a VIRTUAL
-- column has no stored value to backfill. Building the index below is the
-- only one-time cost, and it is bounded by the table's own size (~25,764
-- rows) rather than by how many times a caller re-runs an expensive join.
ALTER TABLE nfl_player_names
  ADD COLUMN display_name_lower TEXT GENERATED ALWAYS AS (LOWER(display_name)) VIRTUAL;

CREATE INDEX IF NOT EXISTS idx_nfl_player_names_display_lower
  ON nfl_player_names (display_name_lower);
