-- Per (season, gsis_id) FTN charting aggregates (manually charted play flags,
-- 2022+) joined to nflfastR PBP for player attribution. Stored as SUMS ONLY
-- (no rates) so the worker can re-aggregate exactly across an arbitrary
-- multi-season query window (rate = SUM(numerator) / SUM(denominator)):
--   QB (pbp passer_player_id, charted REG-season qb_dropback plays):
--     dropbacks       : charted dropbacks (denominator)
--     pa_dropbacks    : is_play_action
--     screen_att      : is_screen_pass
--     blitz_dropbacks : n_blitzers >= 1
--     oop_throws      : is_qb_out_of_pocket
--     throwaways      : is_throw_away
--   Receiver (pbp receiver_player_id, charted REG-season targets):
--     tgt_charted     : charted targets (denominator)
--     contested_tgt   : is_contested_ball
--     contested_rec   : is_contested_ball AND pbp complete_pass = 1
--     catchable_tgt   : is_catchable_ball
--     screen_tgt      : is_screen_pass
-- One row per player-season — a QB who also draws targets merges into one row.
-- REG season only, same convention as nfl_player_epa / nfl_player_routes.
CREATE TABLE IF NOT EXISTS nfl_player_ftn (
  season          INTEGER NOT NULL,
  gsis_id         TEXT    NOT NULL,
  dropbacks       INTEGER,
  pa_dropbacks    INTEGER,
  screen_att      INTEGER,
  blitz_dropbacks INTEGER,
  oop_throws      INTEGER,
  throwaways      INTEGER,
  tgt_charted     INTEGER,
  contested_tgt   INTEGER,
  contested_rec   INTEGER,
  catchable_tgt   INTEGER,
  screen_tgt      INTEGER,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nfl_player_ftn_gsis ON nfl_player_ftn (gsis_id);
