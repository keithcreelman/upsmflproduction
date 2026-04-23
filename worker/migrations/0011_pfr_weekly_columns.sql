-- 0011_pfr_weekly_columns.sql
-- Keith 2026-04-23: add the PFR receiving-advanced fields that are
-- already present in nflverse's load_pfr_advstats(stat_type="rec")
-- weekly feed — drops, broken tackles, and (for QB context) drops
-- by their receivers.
--
-- nflverse returns these columns in the rec advstats payload:
--   receiving_drop              (count)
--   receiving_drop_pct          (rate, already 0-100)
--   receiving_broken_tackles    (count)
--   rushing_broken_tackles      (count)
--   passing_drops               (count of drops by QB's receivers)
--   passing_drop_pct            (rate, already 0-100)
--   receiving_rat               (QB passer rating when targeting WR)
--
-- Store the 5 count columns in nfl_player_weekly so the Worker season
-- aggregate can SUM them. Rates (_pct) are derivable from the counts
-- at season level; skip them.

ALTER TABLE nfl_player_weekly ADD COLUMN receiving_drops INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_broken_tackles INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN rushing_broken_tackles INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_drops INTEGER;
