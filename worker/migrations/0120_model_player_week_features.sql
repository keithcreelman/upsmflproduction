-- 0120_model_player_week_features.sql
-- Claude 2026-08-04 — Phase 1 of the UPS predictive projection system.
-- See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §4.3, §4.4.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE AS-OF CONTRACT — the whole point of this table
-- ═══════════════════════════════════════════════════════════════════════════
-- Every row keyed (season, week, gsis_id) contains ONLY facts knowable BEFORE
-- kickoff of that game. Nothing here is derived from the game being predicted,
-- and nothing is derived from any later game.
--
--   WEEK-grain sources   -> season < S, or (season = S and week < W)
--   SEASON-grain sources -> season <= S-1  (PRIOR SEASONS ONLY)
--
-- Enforced structurally by pipelines/etl/lib/asof.py: a source cannot be
-- queried without the predicate being applied, and an undeclared table raises
-- rather than defaulting to permissive. Verified empirically by
-- test_asof_leakage.py, which rebuilds a week with and without the future
-- present and asserts byte-identical output.
--
-- Why that machinery rather than convention: FIVE tables in this database carry
-- season grain while looking weekly at the API layer (nfl_player_routes,
-- _epa, _ngs, _ftn, _splits). Reading nfl_player_routes at Week 5 hands the
-- model route totals that include Weeks 6-18 — i.e. it reveals the season-end
-- usage of exactly the players whose roles were about to expand, which is the
-- one signal a breakout detector must never be given. Convention already failed
-- once here.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WINDOW SEMANTICS
-- ═══════════════════════════════════════════════════════════════════════════
--   _l1   the single most recent completed week (W-1)
--   _l3   weeks W-3 .. W-1
--   _l4   weeks W-4 .. W-1
--   _std  season-to-date, weeks 1 .. W-1
-- All windows are SAME-SEASON and strictly before W. A player who missed games
-- simply contributes fewer weeks; the denominators are built from the rows that
-- exist, never from an assumed game count.
--
-- Rate columns (TPRR / YPRR / FDPRR) are stored RAW here, unshrunk. Shrinkage
-- toward a position prior belongs in the model layer, where the prior can be
-- refit per training fold — baking it into the feature store would leak the
-- fold's own distribution into its inputs. `routes_std` is carried so the model
-- can apply the audit's sample bands (<100 heavy shrink / 100-199 preliminary /
-- 200+ established).
--
-- MFL POSITION, NOT NFLVERSE POSITION. mfl_pos comes from src_weekly /
-- ff_player_ids. nflverse classifies edge rushers as LB where MFL says DE, and
-- UPS pays DL tackles 1.5 vs LB 1.0 — see Appendix C item C1.

CREATE TABLE IF NOT EXISTS model_player_week_features (
  -- ── identity / keys ─────────────────────────────────────────────────────
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  gsis_id         TEXT    NOT NULL,
  as_of_ts        TEXT    NOT NULL,  -- information cutoff, ISO-8601 UTC
  mfl_player_id   INTEGER,
  player_name     TEXT,
  nfl_team        TEXT,
  opponent        TEXT,
  mfl_pos         TEXT,              -- MFL's position (authoritative for scoring)
  ups_lineup_group TEXT,             -- QB/RB/WR/TE/PK/PN/DL/LB/DB
  feature_version TEXT,

  -- ── availability / sample size ──────────────────────────────────────────
  weeks_played_std INTEGER,          -- weeks with a stat line, 1..W-1
  weeks_since_last INTEGER,          -- gap since his last active week

  -- ── opportunity: routes ─────────────────────────────────────────────────
  routes_l1       INTEGER,
  routes_l3       INTEGER,
  routes_l4       INTEGER,
  routes_std      INTEGER,
  route_pct_l3    REAL,              -- routes / team dropbacks
  route_pct_l4    REAL,
  route_pct_std   REAL,

  -- ── opportunity: targets ────────────────────────────────────────────────
  targets_l1      INTEGER,
  targets_l3      INTEGER,
  targets_l4      INTEGER,
  targets_std     INTEGER,
  tgt_share_l3    REAL,              -- his targets / his team's targets
  tgt_share_l4    REAL,
  tgt_share_std   REAL,

  -- ── opportunity: snaps + ground game ────────────────────────────────────
  off_snaps_l3    INTEGER,
  off_snap_pct_l3 REAL,
  off_snap_pct_l4 REAL,
  carries_l3      INTEGER,
  carries_l4      INTEGER,
  touches_l4      INTEGER,

  -- ── opportunity: red zone / goal line ───────────────────────────────────
  rz_tgt_l4       INTEGER,           -- targets inside the 20
  rz_tgt_std      INTEGER,
  ez_tgt_l4       INTEGER,           -- end-zone targets
  gl_rush_l4      INTEGER,           -- carries inside the 5
  gl_rush_std     INTEGER,

  -- ── efficiency (RAW, unshrunk — see note above) ─────────────────────────
  tprr_l4         REAL,              -- targets per route run
  tprr_std        REAL,
  yprr_l4         REAL,              -- receiving yards per route run
  yprr_std        REAL,
  fdprr_l4        REAL,              -- RECEIVING first downs per route run
  fdprr_std       REAL,              --   (never includes rushing first downs)
  catch_rate_std  REAL,
  ypt_std         REAL,              -- yards per target
  ypc_std         REAL,              -- yards per carry

  -- ── realized UPS production (lagged — target-derived, as-of safe) ───────
  ups_ppg_l3      REAL,
  ups_ppg_l4      REAL,
  ups_ppg_std     REAL,
  ups_last        REAL,

  -- ── role-change deltas: the pre-breakout signal ─────────────────────────
  -- Recent window MINUS the window before it. A rising route share with flat
  -- production is the exact shape the system exists to catch, so these are
  -- first-class columns rather than something the model re-derives.
  d_route_pct_l3  REAL,              -- route% L3 minus the prior L3
  d_tgt_share_l3  REAL,
  d_routes_l3     REAL,
  d_snap_pct_l3   REAL,

  -- ── team context (opponent-independent; matchup joins at model time) ────
  team_dropbacks_l4 INTEGER,
  team_targets_l4   INTEGER,
  team_plays_l4     INTEGER,

  -- ── pregame market context (NEVER actual_score) ─────────────────────────
  vegas_spread    REAL,
  vegas_total     REAL,
  vegas_implied   REAL,

  built_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_mpwf_player  ON model_player_week_features (gsis_id, season, week);
CREATE INDEX IF NOT EXISTS idx_mpwf_sw      ON model_player_week_features (season, week);
CREATE INDEX IF NOT EXISTS idx_mpwf_pos     ON model_player_week_features (season, week, ups_lineup_group);
