-- 0007_nfl_player_redzone.sql
-- Phase 3 partial — yardline-banded carries/targets from nflverse PBP.
--   Keith 2026-04-22: Raw Stats view needs Goal Line Carries (I5),
--   RZ Carries (I20), Red Zone Targets, End Zone Targets. All require
--   parsing nflverse load_pbp() since the box-score tables only track
--   totals, not positional context.
--
-- One row per (season, week, gsis_id). Same key-style as
-- nfl_player_weekly; LEFT JOIN from the Worker.

CREATE TABLE IF NOT EXISTS nfl_player_redzone (
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  gsis_id        TEXT    NOT NULL,

  -- Rushing by yardline (distance to opponent goal line at snap)
  rush_att_i20   INTEGER,   -- Red Zone: yardline ≤ 20
  rush_att_i10   INTEGER,   -- yardline ≤ 10
  rush_att_i5    INTEGER,   -- Goal Line: yardline ≤ 5
  rush_yds_i20   INTEGER,
  rush_tds_i20   INTEGER,

  -- Receiving targets by yardline
  targets_i20    INTEGER,   -- Red Zone targets
  targets_i10    INTEGER,
  targets_i5     INTEGER,
  targets_ez     INTEGER,   -- End Zone: air_yards ≥ yardline_100 (pass targeted into the end zone)
  rec_i20        INTEGER,
  rec_tds_i20    INTEGER,

  -- Passing (QB) context by yardline — for QB popup completeness
  pass_att_i20   INTEGER,
  pass_tds_i20   INTEGER,
  pass_att_ez    INTEGER,   -- QB attempts with target in end zone

  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_redzone_player ON nfl_player_redzone (gsis_id, season);
