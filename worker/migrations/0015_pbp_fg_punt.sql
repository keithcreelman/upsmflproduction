-- 0015_pbp_fg_punt.sql
-- Keith 2026-04-23: Populate FG distance buckets + punter totals from
-- play-by-play. The nflverse weekly payload (load_player_stats) doesn't
-- include punters, and its FG distance buckets come through empty. PBP
-- has every kick with kicker_player_id + kick_distance + field_goal_result,
-- and every punt with punter_player_id + kick_distance + touchback.
--
-- New FG distance buckets refine the old 50+ to 50-59 + 60+. The old
-- columns (fg_att_50plus / fg_made_50plus) stay for backwards compat
-- but stop being populated — the fetcher writes to the new ones.
--
-- Punter columns (punts, punt_yds, punt_inside20, punt_long, punt_net_avg)
-- already exist on nfl_player_weekly — PBP fetcher fills them directly.
-- Adding only punt_tb (touchbacks) here since we didn't have it.

ALTER TABLE nfl_player_weekly ADD COLUMN fg_att_50_59  INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN fg_made_50_59 INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN fg_att_60plus INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN fg_made_60plus INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN punt_tb       INTEGER;
