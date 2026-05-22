-- 0054_era_pool
-- Snapshot of the Expired Rookie Auction (ERA) eligible pool for a given
-- (season, league_id). Created when the deadline-night auto-drop fires
-- (or via manual /admin/auction/auto-drop-expired-rookies invocation).
-- Once written, the rows persist through the auction so the O=43 picker
-- and the Hub UI have a stable list — current-roster walks return zero
-- once players have been dropped to FA.
--
-- Per Keith 2026-05-22 (canon): "the ERA pool = the players we just cut
-- at the rookie-extension deadline. Picker should only allow nominations
-- from this list."
--
-- Origin sub-types (origin_label) mirror /api/auction/era-eligible:
--   "Rookie Draft" — UPS rookie draft slot (round.pick)
--   "MYM-Rookie"   — WW/FCFS rookie pickup later given MYM (§C3)
--   "WW"           — 1-year WW pickup that expired
--   "Rookie - FA Auction" — auction-acquired rookie
--   "Trade"        — trade-acquired (original origin lost)
--   "Other"        — unclassified

CREATE TABLE IF NOT EXISTS ups_era_pool (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  season                   TEXT NOT NULL,
  league_id                TEXT NOT NULL,
  player_id                TEXT NOT NULL,
  player_name              TEXT,
  position                 TEXT,
  nfl_team                 TEXT,
  prior_owner_fid          TEXT,
  prior_owner_name         TEXT,
  origin_label             TEXT,
  rookie_slot              TEXT,          -- e.g. "1.10 (2023)" from TYPE=draftResults
  rookie_slot_round        INTEGER,
  rookie_slot_pick         INTEGER,
  rookie_slot_year         INTEGER,
  y3_salary                INTEGER,       -- derived from §A1 salary schedule
  drafted_field_raw        TEXT,          -- as-stored MFL "Last Acquired" string
  contract_status_at_drop  TEXT,
  contract_year_at_drop    TEXT,
  source                   TEXT NOT NULL DEFAULT 'manual',
  snapshot_at_utc          TEXT NOT NULL,
  UNIQUE (season, league_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_era_pool_season_league
  ON ups_era_pool (season, league_id);

CREATE INDEX IF NOT EXISTS idx_era_pool_owner
  ON ups_era_pool (season, league_id, prior_owner_fid);
