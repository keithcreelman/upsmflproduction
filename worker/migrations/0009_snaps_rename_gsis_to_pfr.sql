-- 0009_snaps_rename_gsis_to_pfr.sql
-- nflverse `load_snap_counts()` keys on `pfr_player_id`, not gsis_id —
-- my Phase 2 fetcher accidentally loaded PFR IDs into a column named
-- `gsis_id` in nfl_player_snaps. Rename to the correct label so the
-- Worker can JOIN via crosswalk.pfr_id. No data reload needed —
-- existing values (e.g. "PurdBr00") are already correct PFR IDs.
--
-- Also drops + recreates the old index with the new column name.

DROP INDEX IF EXISTS idx_nflsnaps_player;

ALTER TABLE nfl_player_snaps RENAME COLUMN gsis_id TO pfr_id;

CREATE INDEX IF NOT EXISTS idx_nflsnaps_player ON nfl_player_snaps (pfr_id, season);
