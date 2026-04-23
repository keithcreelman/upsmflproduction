-- 0012_pfr_rush_advstats.sql
-- Keith 2026-04-23: Rico Dowdle 2025 shows BrTkl=3 in the popup but PFR
-- says 34 forced missed tackles. Root cause: nflverse
-- load_pfr_advstats(stat_type="rec") only populates
-- receiving_broken_tackles; the rushing_broken_tackles column in that
-- payload is always NULL. Real rushing broken tackles come from
-- load_pfr_advstats(stat_type="rush"), which also exposes yards before
-- contact (YBC) + yards after contact (YAC) — both are classic RB
-- profiling stats worth capturing.
--
-- Add two new columns for YBC / YAC. rushing_broken_tackles already
-- exists (migration 0011) — we just need the fetcher to fill it via
-- the rush payload.

ALTER TABLE nfl_player_weekly ADD COLUMN rushing_yards_before_contact INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN rushing_yards_after_contact INTEGER;
