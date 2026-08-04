-- 0114_tackle_semantics_and_first_downs.sql
-- Claude 2026-08-04 — Phase 0 data remediation for the UPS predictive model.
-- See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.3 / §1.4.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — the migration tracker is ~47
--    entries behind and applying it corrupts contract data.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A COMPANION TABLE INSTEAD OF ALTER TABLE
-- ═══════════════════════════════════════════════════════════════════════════
-- nfl_player_weekly is at EXACTLY 100 columns — D1's hard per-table cap. An
-- ALTER TABLE ADD COLUMN on it now fails with:
--     too many columns on sqlite_altertab_nfl_player_weekly: SQLITE_ERROR
--
-- Six of its columns are 100% NULL across all 269,933 rows (rush_long,
-- rec_long, pass_long, routes_run, fg_att_50plus, fg_made_50plus), but only
-- the three *_long columns are safe to reclaim — routes_run and the
-- fg_*_50plus pair are still read by worker/src/index.js and by
-- site/rosters/roster_workbench.js, site/shared/player_profile_master.js and
-- site/rookies/rookie_draft_hub.js. Dropping three would still leave us one
-- short of the four needed here, and the audit identifies at least six MORE
-- columns that must land later (return yards, return TDs, safeties, sack
-- fumbles, receiving YAC, native FG made-distance).
--
-- So: nfl_player_weekly is FROZEN at the cap. Every new weekly box-score
-- column goes in nfl_player_weekly_ext, keyed identically so it joins 1:1.

CREATE TABLE IF NOT EXISTS nfl_player_weekly_ext (
  season  INTEGER NOT NULL,
  week    INTEGER NOT NULL,
  gsis_id TEXT    NOT NULL,

  -- ── The missing THIRD tackle credit ────────────────────────────────────
  -- The NFL gamebook records three DISJOINT tackle credits; nflverse parses
  -- each into its own column (verified at PBP level: across all 702
  -- tackle_with_assist plays in 2025 the twa player appears as solo_tackle_N
  -- zero times and as assist_tackle_N zero times — no overlap either way):
  --
  --   "(A)"               → A    = def_tackles_solo         unassisted tackle
  --   "(A, B)"  comma     → A    = def_tackles_with_assist  A MADE it, w/ help
  --                         B    = def_tackle_assists
  --   "(A; B)"  semicolon → both = def_tackle_assists
  --
  -- For UPS scoring:
  --   MFL TK = nfl_player_weekly.def_tackles_solo + THIS COLUMN
  --   MFL AS = nfl_player_weekly.def_tackles_ast  (nflverse def_tackle_assists)
  --   official combined (== PFR `comb`) = all three summed
  --
  -- Corroborated four independent ways: MFL's own detailed? report (54/54
  -- player-weeks exact on both tackles and assists), PFR combined-tackle parity
  -- (residual 0.0-1.0% every season 2018-2025), src_weekly UPS points
  -- reconstruction, and raw PBP tackle notation. Bobby Wagner 2023: PFR 183 =
  -- 77 solo + 19 twa + 87 assists, exactly.
  --
  -- THE BUG THIS REPAIRS: fetch_nflverse_weekly.py bound def_tackles_ast to
  -- `def_tackles_with_assist` (a TACKLE count) while the real assist column
  -- `def_tackle_assists` was absent from the alias list entirely, so pick()
  -- could never reach it. 2025 stored 702 assists instead of 17,056. The two
  -- errors cancelled in the derived total (solo+ast == solo+twa == correct TK),
  -- which is why the table looked plausible for two years — and why fixing the
  -- alias ALONE would have been strictly WORSE than the bug (2025 IDP MAE
  -- 0.81 → 1.63, league IDP points +36.2%).
  def_tackles_with_assist INTEGER,

  -- ── First downs — UPS `FD 1-999 = *0.2`, ALL positions ─────────────────
  -- Continuous in MFL since 2011 (the 2021 `1C`→`FD` rename was cosmetic; only
  -- the range widened). No first-down column has ever existed in D1, so UPS
  -- scoring could not be reproduced for ANY offensive player. Adding these
  -- takes offensive reconstruction MAE from 2.234 → 0.264 pts/player-week.
  --
  -- UPS credits the QB for PASSING first downs too — not ball-carrier-only.
  -- Drake Maye 2025 = 238 passing + 50 rushing FD = 57.6 pts/season that were
  -- previously invisible to the scoring engine.
  --
  -- THREE SEPARATE COLUMNS ON PURPOSE. UPS `FD` scoring sums all of them, but
  -- FDPRR (receiving first downs per route run) is a receiving-only route
  -- efficiency metric and must NEVER include rushing first downs.
  pass_first_downs INTEGER,
  rush_first_downs INTEGER,
  rec_first_downs  INTEGER,

  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nflweekly_ext_player
  ON nfl_player_weekly_ext (gsis_id, season);
