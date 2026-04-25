-- 0019_metric_stickiness.sql
-- Phase 1 of the YoY stickiness + regression plan (Keith 2026-04-25).
--
-- One row per (position, metric, min_games) summarizing how predictive a
-- player's metric value in season N is of the same metric in season N+1.
-- Computed by pipelines/etl/scripts/build_stickiness_report.py from
-- nfl_player_weekly. Phase 1 scope is QB only; later phases extend
-- to other positions.

CREATE TABLE IF NOT EXISTS metric_stickiness (
  position      TEXT    NOT NULL,
  metric        TEXT    NOT NULL,
  min_games     INTEGER NOT NULL,
  n_pairs       INTEGER NOT NULL,    -- (player, season-pair) observations
  n_players     INTEGER NOT NULL,    -- distinct players contributing
  corr_pearson  REAL,                -- NULL when zero variance (e.g., unpopulated column)
  corr_spearman REAL,
  season_min    INTEGER,
  season_max    INTEGER,
  computed_at   TEXT    NOT NULL,
  PRIMARY KEY (position, metric, min_games)
);
