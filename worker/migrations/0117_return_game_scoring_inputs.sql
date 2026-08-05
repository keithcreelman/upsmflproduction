-- 0117_return_game_scoring_inputs.sql
-- Claude 2026-08-04 — Phase 0 task 0.3 (Appendix C item C9).
-- See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.3.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- Columns land in nfl_player_weekly_ext because nfl_player_weekly is at D1's
-- hard 100-column cap (see migration 0114).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY — the return game is currently INVISIBLE to the scoring engine
-- ═══════════════════════════════════════════════════════════════════════════
-- UPS pays the return game on four codes, none of which have ever had a data
-- source in D1:
--     KY  -50-999  *.025   kick return yards
--     UY  -50-999  *.05    punt return yards
--     KO  0-49 = 6, 50-110 = 7   kickoff return TD
--     PR  0-49 = 6, 50-110 = 7   punt return TD
--
-- The consequence is not subtle. A pure return specialist scores a full fantasy
-- week out of thin air as far as the database is concerned — 2025 examples with
-- ZERO offensive stats in nfl_player_weekly: Charlie Jones 12.1 UPS points
-- (wk9), Gunner Olszewski 9.5 (wk12), Myles Price 6.3 (wk11), Jaylin Noel 5.4
-- (wk2). This is the entire unexplained intercept in the §1.3 WR reconstruction
-- (~1.24 pts on zero-reception weeks) and the dominant remaining DB residual —
-- the one cohort still missing the IDP acceptance gate (2018 DB, 0.119).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS AND IS NOT DERIVABLE HERE
-- ═══════════════════════════════════════════════════════════════════════════
-- Stored VERBATIM from nflverse load_player_stats, no pre-summing, so the
-- scoring layer applies the UPS rates itself:
--   kickoff_returns / kickoff_return_yards  → KY  (2025: 2,171 / 56,231)
--   punt_returns    / punt_return_yards     → UY  (2025:   861 /  8,714)
--   punt_return_tds                         → PR  (2025: 15)
--
-- ⚠️ special_teams_tds IS A MIXED BUCKET — do not read it as "return TDs".
-- 2025 totals by position: WR 16, RB 4, CB 3, DE 3, DT 1, SAF 1 (28 total).
-- The DE/DT/CB/SAF entries are blocked-kick and muffed-punt recoveries, which
-- UPS scores under different codes entirely (BLF/BLP/FR), not KO/PR. It is
-- stored for completeness and reconciliation, NOT as a scoring input.
--
-- There is no kickoff_return_tds column in nflverse at all. Kickoff return TDs
-- must therefore come from PBP, together with the return-TD DISTANCE needed to
-- choose between the 6-point and 7-point tier (a kickoff return TD is ~always
-- 50+ yards, so defaulting to 6 would systematically underpay). Both are
-- Appendix C item C10 and require the play-by-play feed.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN kickoff_returns      INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN kickoff_return_yards INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_returns         INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_return_yards    INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_return_tds      INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN special_teams_tds    INTEGER;
