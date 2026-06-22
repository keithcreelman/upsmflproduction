-- nfl_player_names — gsis_id → display name for EVERY player (all eras).
--
-- The advanced-stats leaderboard keys on nflverse gsis_id but resolved the
-- display name from player_id_crosswalk, which only covers MFL's CURRENT
-- player pool — so any player no longer in that pool (e.g. a retired 2014
-- punter) rendered with a blank name. This table is the season-correct name
-- source for every gsis_id that can appear in nfl_player_weekly.
--
-- Source: nflreadpy.load_players() (~25k rows, 1999→present).
-- Populated by: pipelines/etl/scripts/fetch_nflverse_player_names.py
-- The Worker LEFT JOINs it and COALESCEs:
--   COALESCE(NULLIF(crosswalk.full_name, ''), nfl_player_names.display_name)

CREATE TABLE IF NOT EXISTS nfl_player_names (
  gsis_id      TEXT PRIMARY KEY,
  display_name TEXT,
  position     TEXT,
  last_season  INTEGER,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
