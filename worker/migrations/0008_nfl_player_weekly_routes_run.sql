-- 0008_nfl_player_weekly_routes_run.sql
-- Add routes_run column to nfl_player_weekly for Yards-per-Route-Run (YPRR)
-- and Routes-Run columns in the Raw Stats view per Keith 2026-04-22.
--
-- Source: nflverse `load_pfr_advstats(stat_type="rec")` (Pro Football
-- Reference advanced receiving stats) — 2018+ coverage. Until a
-- dedicated PFR fetcher ships, column stays NULL and the popup shows
-- "—" for Routes and YPRR.

ALTER TABLE nfl_player_weekly ADD COLUMN routes_run INTEGER;
