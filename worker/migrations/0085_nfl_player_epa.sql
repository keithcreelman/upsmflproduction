-- Per (season, gsis_id) EPA / efficiency aggregates from nflfastR PBP.
-- Stored as SUMS + counts (not means) so the worker can re-aggregate exactly
-- across an arbitrary multi-season query window (mean = sum / count).
--   pass_* : QB dropback pass plays (passer_player_id)   — incl CPOE
--   rush_* : run plays (rusher_player_id)
--   rec_*  : pass targets (receiver_player_id)            — epa credited to target
-- success = nflfastR `success` (1 if play EPA > 0). REG season only.
CREATE TABLE IF NOT EXISTS nfl_player_epa (
  season         INTEGER NOT NULL,
  gsis_id        TEXT    NOT NULL,
  pass_plays     INTEGER,
  pass_epa_sum   REAL,
  pass_cpoe_sum  REAL,
  pass_cpoe_n    INTEGER,
  pass_succ_sum  REAL,
  rush_plays     INTEGER,
  rush_epa_sum   REAL,
  rush_succ_sum  REAL,
  rec_tgt        INTEGER,
  rec_epa_sum    REAL,
  rec_succ_sum   REAL,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, gsis_id)
);
