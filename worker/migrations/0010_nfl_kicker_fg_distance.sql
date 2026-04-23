-- 0010_nfl_kicker_fg_distance.sql
-- Keith 2026-04-22: Avg FG distance should come from play-by-play, not
-- from the 0-39 / 40-49 / 50+ bucket midpoints we were approximating.
-- nflverse load_pbp() exposes `kick_distance` per FG attempt — sum +
-- count give us true mean distance.
--
-- Lives in nfl_player_weekly (per-player-week, keyed by gsis_id):
--   fg_distance_sum_made     sum of kick_distance for made FGs
--   fg_made_pbp              count of those made FGs (PBP-derived,
--                            used to compute avg = sum / count)
--
-- The PBP fetcher attributes plays to kicker_player_id (gsis_id format).

ALTER TABLE nfl_player_weekly ADD COLUMN fg_distance_sum_made INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN fg_made_pbp INTEGER;
