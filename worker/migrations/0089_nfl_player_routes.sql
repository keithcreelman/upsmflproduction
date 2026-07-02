-- Per (season, gsis_id) route-participation aggregates from nflverse
-- participation data (FTN/NGS on-field players, 2016+) joined to nflfastR PBP.
-- Stored as SUMS ONLY (no rates) so /api/player-routes can re-aggregate
-- exactly across an arbitrary multi-season query window:
--   TPRR   = SUM(routes_tgt)     / SUM(routes)
--   YPRR   = SUM(routes_rec_yds) / SUM(routes)
--   Route% = SUM(routes)         / SUM(team_dropbacks)
--
--   routes         : REG-season QB-dropback plays (pbp qb_dropback==1) where
--                    the player appears in participation `offense_players`.
--                    This is the standard "pass-snap routes" proxy — it
--                    slightly overcounts true routes (a WR/TE kept in to
--                    pass-block is counted), which is the accepted tradeoff.
--                    Route-running positions only (WR/TE/RB/FB by modal
--                    participation position) — QB/OL pass-block snaps are
--                    excluded, so every row is a fantasy-relevant player.
--   team_dropbacks : GAME-ALIGNED denominator — sum of his team's dropbacks
--                    in the games he appeared in (handles mid-season trades
--                    and missed games correctly for Route%).
--   routes_tgt     : his targets (pbp receiver_player_id) on those plays.
--   routes_rec_yds : receiving yards on those plays.
-- REG season only, all weeks stored as-is (fantasy wk 1-17 filtering, if any,
-- happens at query time elsewhere) — same convention as nfl_player_epa.
CREATE TABLE IF NOT EXISTS nfl_player_routes (
  season          INTEGER NOT NULL,
  gsis_id         TEXT    NOT NULL,
  routes          INTEGER,
  team_dropbacks  INTEGER,
  routes_tgt      INTEGER,
  routes_rec_yds  INTEGER,
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nfl_player_routes_gsis ON nfl_player_routes (gsis_id);
