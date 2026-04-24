-- 0016_pbp_punt_spot_team_4thdown.sql
-- Keith 2026-04-24 backlog items:
--   * Punter "Avg Punt Spot" — own-yardline at LoS when punting. Sum +
--     count per player-week (avg = sum/count computed at query time).
--   * Team 4th-down Go-For-It Rate + Stall-Punt Frequency. Team-level
--     situational rates that give context to punter / kicker volume.
--
-- All aggregated from PBP by pipelines/etl/scripts/fetch_nflverse_pbp.py
-- in the same single-pass scan that already handles redzone/FG/punts.

-- Punter columns on nfl_player_weekly (keyed by punter gsis_id)
ALTER TABLE nfl_player_weekly ADD COLUMN punt_spot_sum   INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN punt_spot_count INTEGER;

-- New table — team-level 4th-down behavior + stall-punt counts per week.
-- Stall-punt = punt when LoS is in the ambiguous zone between midfield
-- and the opponent's 40 (yardline_100 BETWEEN 40 AND 50 — kick would
-- be 57–67 yards, often too long, often punt-or-go decision).
CREATE TABLE IF NOT EXISTS nfl_team_weekly (
  season              INTEGER NOT NULL,
  week                INTEGER NOT NULL,
  team                TEXT    NOT NULL,
  fourth_down_total   INTEGER,  -- 4th-down plays of any type (run/pass/punt/fg)
  fourth_down_go      INTEGER,  -- 4th-down plays where play_type IN (run,pass)
  fourth_down_punt    INTEGER,  -- play_type = punt
  fourth_down_fg      INTEGER,  -- play_type = field_goal
  stall_punts         INTEGER,  -- punts with yardline_100 BETWEEN 40 AND 50
  team_punts          INTEGER,  -- total punts (denominator for stall rate)
  PRIMARY KEY (season, week, team)
);

CREATE INDEX IF NOT EXISTS idx_team_weekly_team ON nfl_team_weekly (team, season);
