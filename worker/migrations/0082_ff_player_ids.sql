-- ff_player_ids — all-eras cross-source player ID crosswalk (ffverse / DynastyProcess db_playerids).
--
-- The existing player_id_crosswalk is built from MFL's CURRENT player pool, so
-- retired players (e.g. 2012 Jason Witten) have no row → their MFL fantasy
-- scores can't join to a gsis_id and the leaderboard shows blank "MFL PTS"
-- for historical seasons (only 3% of 2012's MFL players mapped). This table is
-- the all-eras map: one row per MFL player_id ever, carrying gsis_id (for the
-- nflverse stat join) plus sleeper_id / ktc_id / fantasypros_id / pfr_id (for
-- cross-source ADP joining). 100% coverage of src_weekly 2012 AND 2025.
--
-- Source : https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv
-- Loader : pipelines/etl/scripts/fetch_ff_playerids.py (fetch CSV → dual-write local + D1)
-- Used by: /api/advanced-stats-leaderboard (mfl_scoring_agg join) + the player-weekly drawer.

CREATE TABLE IF NOT EXISTS ff_player_ids (
  mfl_id          TEXT PRIMARY KEY,   -- MFL player_id (matches src_weekly.player_id)
  gsis_id         TEXT,               -- nflverse gsis_id (00-00xxxxx) — the stat join key
  sleeper_id      TEXT,
  ktc_id          TEXT,
  fantasypros_id  TEXT,
  pfr_id          TEXT,               -- pro-football-reference id (snap join)
  espn_id         TEXT,
  name            TEXT,
  merge_name      TEXT,               -- normalized name for fuzzy cross-source join
  position        TEXT,
  team            TEXT,
  birthdate       TEXT,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_gsis    ON ff_player_ids(gsis_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_sleeper ON ff_player_ids(sleeper_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_ktc     ON ff_player_ids(ktc_id);
