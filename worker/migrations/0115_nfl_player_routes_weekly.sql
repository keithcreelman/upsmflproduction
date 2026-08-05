-- 0115_nfl_player_routes_weekly.sql
-- Claude 2026-08-04 — Phase 0 data remediation (B1/B2) for the UPS predictive
-- model. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.1.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — the migration tracker is ~47
--    entries behind and applying it corrupts contract data.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS — A LEAKAGE FIX, NOT A CONVENIENCE
-- ═══════════════════════════════════════════════════════════════════════════
-- nfl_player_routes is keyed (season, gsis_id) — ONE ROW PER PLAYER-SEASON,
-- holding completed full-season totals (max ~718 routes, i.e. a full year for
-- an every-down WR). It is NOT weekly and NOT a cumulative as-of-week snapshot.
--
-- Reading it while generating a historical Week 5 prediction hands the model
-- route totals that INCLUDE Weeks 6-18. For a breakout-detection system that is
-- the most damaging leak available: the model would be told, at Week 5, the
-- season-end route volume of exactly the players whose roles were about to
-- expand. Backtested lead-time metrics would be fabricated.
--
-- The only other weekly route path, nfl_player_weekly.routes_run (migration
-- 0008), is 100% NULL across all 15 seasons — the PFR fetcher it was waiting on
-- never shipped. So before this table there was ZERO usable weekly route data.
--
-- RULES FOR THE FEATURE STORE:
--   * nfl_player_routes (season grain) — permitted ONLY as a
--     `season <= target_season - 1` prior. Banned as a same-season feature at
--     any week. Same rule applies to nfl_player_epa / _ngs / _ftn / _splits,
--     which share the season grain.
--   * nfl_player_routes_weekly (this table) — the only route source allowed
--     for same-season as-of-week features.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SEMANTICS — identical to nfl_player_routes, just split by week
-- ═══════════════════════════════════════════════════════════════════════════
-- Stored as SUMS ONLY (no rates) so any window — week, month, season,
-- multi-season — re-aggregates exactly:
--     TPRR   = SUM(routes_tgt)     / SUM(routes)
--     YPRR   = SUM(routes_rec_yds) / SUM(routes)
--     Route% = SUM(routes)         / SUM(team_dropbacks)
--     FDPRR  = SUM(ext.rec_first_downs) / SUM(routes)
--              ^ join nfl_player_weekly_ext on (season, week, gsis_id).
--                RECEIVING first downs only — never add rushing first downs to
--                a per-route metric. (UPS `FD` scoring is a separate thing and
--                does sum all three.)
--
--   routes         : REG-season QB-dropback plays (pbp qb_dropback == 1) where
--                    the player appears in participation `offense_players`.
--                    The standard open-data "pass-snap routes" proxy — it
--                    slightly overcounts true routes (a WR/TE kept in to
--                    pass-block counts), which is the accepted tradeoff.
--                    Route-running positions only (WR/TE/RB/FB by modal
--                    participation position).
--   team_dropbacks : his team's dropbacks in THAT game — the Route%
--                    denominator. Summing weekly rows reproduces the
--                    game-aligned season denominator exactly, which is why the
--                    season table is now derived from this one rather than
--                    computed separately.
--   routes_tgt     : his targets (pbp receiver_player_id) on those plays.
--   routes_rec_yds : receiving yards on those plays.
--
-- COVERAGE: the nflverse participation feed starts in 2016 — weekly routes
-- cannot predate it. That still covers the whole proposed 2022-2025
-- walk-forward window, with 2016-2021 available for priors. REG season only.

CREATE TABLE IF NOT EXISTS nfl_player_routes_weekly (
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  gsis_id         TEXT    NOT NULL,
  team            TEXT,
  routes          INTEGER,
  team_dropbacks  INTEGER,
  routes_tgt      INTEGER,
  routes_rec_yds  INTEGER,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nfl_routes_weekly_gsis
  ON nfl_player_routes_weekly (gsis_id, season);
CREATE INDEX IF NOT EXISTS idx_nfl_routes_weekly_sw
  ON nfl_player_routes_weekly (season, week);
