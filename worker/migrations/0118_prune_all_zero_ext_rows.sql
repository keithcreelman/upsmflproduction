-- 0118_prune_all_zero_ext_rows.sql
-- Claude 2026-08-04 — housekeeping for nfl_player_weekly_ext.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- 2,300 rows (all in 2025) carry a payload that is zero in EVERY column. They
-- were written by one interrupted run of fetch_nflverse_weekly.py before its
-- ext-row filter was tightened: it tested `is not None`, but nflverse returns 0
-- rather than NULL for "no first downs / no returns / no assisted tackles", so
-- the test admitted every player-week in the league. The filter now tests
-- truthiness, matching backfill_tackle_semantics.py.
--
-- These rows are harmless to READ — a consumer doing COALESCE(col, 0) gets 0
-- whether the row is absent or present-and-zero. They are removed because they
-- contradict the coverage contract documented in backfill_tackle_semantics.py:
--
--     "a row is written only when at least one payload value is NONZERO, so for
--      a processed season an ABSENT row means the player recorded none of these
--      events — LEFT JOIN ... COALESCE(x, 0) is correct."
--
-- Leaving present-and-all-zero rows alongside absent ones makes that contract
-- ambiguous, which is the kind of drift that turns into a fail-open later.
--
-- The predicate is written positively over every payload column rather than as
-- a NOT(...) — SQLite three-valued logic makes NOT(NULL OR NULL) evaluate to
-- NULL, which would silently match nothing. (That exact trap produced a false
-- "0 unmapped" reading earlier in this session.)
DELETE FROM nfl_player_weekly_ext
 WHERE COALESCE(def_tackles_with_assist, 0) = 0
   AND COALESCE(pass_first_downs,        0) = 0
   AND COALESCE(rush_first_downs,        0) = 0
   AND COALESCE(rec_first_downs,         0) = 0
   AND COALESCE(kickoff_returns,         0) = 0
   AND COALESCE(kickoff_return_yards,    0) = 0
   AND COALESCE(punt_returns,            0) = 0
   AND COALESCE(punt_return_yards,       0) = 0
   AND COALESCE(punt_return_tds,         0) = 0
   AND COALESCE(special_teams_tds,       0) = 0;
