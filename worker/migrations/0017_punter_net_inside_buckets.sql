-- 0017_punter_net_inside_buckets.sql
-- Keith 2026-04-25: Punter analytics depth — net yards + inside-N
-- buckets, all PBP-derived.
--
-- Net Avg fix: nflverse weekly payload doesn't include punter data at
-- all (we already populate gross stats from PBP). Net yards isn't in
-- the basic punt aggregator either — adding sum + count here so the
-- client can compute Net Avg = punt_net_yds_sum / punts. Net yards =
-- gross kick_distance - return_yards (PBP's return_yards field).
--
-- Inside-N buckets (Keith's reliability question): nflverse PBP carries
-- punt_inside_twenty as a 0/1 flag plus end-of-play yardline. We can
-- bucket by where the ball ended up (offense's net yardline_100 after
-- the play). For the 4 official ranges:
--   inside_5  = end yardline_100 ∈ (0, 5]
--   inside_10 = end yardline_100 ∈ (0, 10]
--   inside_15 = end yardline_100 ∈ (0, 15]
--   inside_20 = end yardline_100 ∈ (0, 20]   (already populated, kept
--                                              for cross-check vs
--                                              MFL's official I20)
--
-- nfl_player_redzone is unrelated — the redzone table is keyed by
-- the receiver/rusher's gsis_id, not the punter. These cols stay
-- on nfl_player_weekly alongside the existing punt fields.

ALTER TABLE nfl_player_weekly ADD COLUMN punt_net_yds_sum INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside5     INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside10    INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside15    INTEGER;
-- punt_inside20 already exists (migration 0001-ish); we'll re-derive
-- it from PBP in the same fetcher pass for cross-check parity.
