-- 0124_model_player_preseason_features.sql
-- Claude 2026-08-05 — season-grain preseason feature store.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A SECOND FEATURE STORE
-- ═══════════════════════════════════════════════════════════════════════════
-- model_player_week_features cannot answer a week-1 question. 48 of its 71
-- columns are trailing in-season windows (routes_l3, targets_l1, route_pct_std,
-- ...) and every one of them is NULL before a snap has been played. Feeding it
-- week 1 of an unplayed season yields a row of nulls, not a projection.
--
-- Predicting week 1 is therefore a DIFFERENT problem with a different feature
-- basis: what a player did in PRIOR seasons, plus the handful of things that are
-- published before kickoff (depth chart, salary, age). One row per player-season.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE PRIOR-PPG COLUMNS ARE THE LEAGUE'S OWN RULE, NOT A NEW INVENTION
-- ═══════════════════════════════════════════════════════════════════════════
-- Keith's data-layer rule (2026-07-12) is prior-3-season weighted PPG plus
-- multi-source ADP. It is already implemented in
-- pipelines/etl/scripts/projection.py and MUST be reused rather than
-- re-derived — the builder imports its constants so there is one definition:
--
--   RECENCY_WEIGHTS    = (0.50, 0.30, 0.20)   seasons S-1, S-2, S-3
--   GAMES_FULL_SEASON  = 17
--   MIN_GAMES_RELIABLE = 4      a season below this is too noisy to weight
--   final_weight       = recency_weight * min(games / 17, 1.0)
--   AGE_CURVES         per position, incl. the RB cliff at 32
--
-- `games_played` follows the canon's own definition from yoy_signals.py:
-- WEEKS WITH score > 0. That matters — src_weekly carries a row for every
-- rostered player every week, and 2,691 of 16,791 rows in 2025 score exactly
-- zero. Counting those as games played would dilute PPG and quietly change what
-- MIN_GAMES_RELIABLE means.
--
-- The canon's own substrate (pipelines/etl/data/yoy_signals.db) is GITIGNORED
-- and absent from every checkout, so projection.py currently returns None for
-- everything and cannot run in CI at all. These columns reproduce its maths
-- against D1 instead, which is the single source of truth and does run in CI.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LEAKAGE
-- ═══════════════════════════════════════════════════════════════════════════
-- Every prior_* / ppg_N / games_N / routes_pg_1 value for season S is computed
-- from seasons STRICTLY BEFORE S. The pregame block (depth_rank, mfl_salary,
-- age_at_season, years_exp, team_changed) describes season S but is published
-- before week 1, so it is legal — the same WEEK_PREGAME logic the weekly store
-- uses for Vegas lines.
--
-- ⚠️ mfl_salary IS NOT TRUSTWORTHY PRE-2020. Roster snapshots before 2020 are
-- END-OF-SEASON stamped (see docs §1.C10), so a 2018 "salary" reflects where the
-- contract finished, not where it started, and would leak. The builder writes it
-- only from 2020 on and leaves it NULL earlier — NULL meaning "the source cannot
-- answer this as-of", not "no contract".
--
-- ups_*_actual are the TRAINING TARGET, not features. They are NULL for a season
-- that has not been played, which is exactly the state of the 2026 row.
CREATE TABLE IF NOT EXISTS model_player_preseason_features (
  season              INTEGER NOT NULL,
  gsis_id             TEXT    NOT NULL,
  mfl_player_id       TEXT,
  player_name         TEXT,
  mfl_pos             TEXT,
  nfl_team            TEXT,

  -- canon prior-PPG rule (projection.py)
  prior_ppg_w         REAL,      -- 50/30/20, game-fraction adjusted, renormalised
  prior_ppg_w_aged    REAL,      -- prior_ppg_w * age_multiplier  (the baseline)
  age_multiplier      REAL,
  seasons_of_history  INTEGER,   -- how many of S-1..S-3 actually contributed

  ppg_1               REAL,      -- season S-1
  ppg_2               REAL,
  ppg_3               REAL,
  games_1             INTEGER,   -- weeks with score > 0
  games_2             INTEGER,
  games_3             INTEGER,

  -- prior-season opportunity (role signal that survives a season boundary)
  routes_pg_1         REAL,
  targets_pg_1        REAL,

  -- identity / career, all immutable or known pre-kickoff
  age_at_season       REAL,      -- age on Sept 1 of season S, from birth_date
  years_exp           INTEGER,
  is_rookie           INTEGER,   -- 1 when no prior season contributed
  team_changed        INTEGER,   -- nfl_team differs from S-1 (NULL if unknown)

  -- pregame, season S
  depth_rank          INTEGER,   -- week-1 depth chart
  mfl_salary          INTEGER,   -- NULL before 2020, see above

  -- TRAINING TARGET — never a feature
  ups_games_actual    INTEGER,
  ups_ppg_actual      REAL,
  ups_total_actual    REAL,

  feature_version     TEXT,
  built_at            TEXT,
  PRIMARY KEY (season, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_preseason_season_pos
  ON model_player_preseason_features(season, mfl_pos);
