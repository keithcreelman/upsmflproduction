-- Per (season, gsis_id, bucket) game-script / home-road opportunity splits
-- from nflfastR PBP. Two independent bucket families share the table:
--   script : 'lead' (margin > +7) / 'neutral' (-7..+7) / 'trail' (< -7),
--            margin = posteam_score - defteam_score at the snap (offense POV)
--   venue  : 'home' / 'road' (posteam vs home_team)
-- Every opportunity lands in exactly one bucket of EACH family, so
-- home+road totals == lead+neutral+trail totals for the same player.
-- Opportunities: target (receiver_player_id on pass plays), carry
-- (rusher_player_id on run plays), dropback (passer_player_id on
-- qb_dropback). Stored as SUMS so the worker can re-aggregate exactly
-- across any multi-season window; `games` = distinct game_ids with >=1
-- opportunity in the bucket (per-game rates). REG season only.
CREATE TABLE IF NOT EXISTS nfl_player_splits (
  season     INTEGER NOT NULL,
  gsis_id    TEXT    NOT NULL,
  bucket     TEXT    NOT NULL,          -- 'lead'|'neutral'|'trail'|'home'|'road'
  games      INTEGER,
  plays      INTEGER,                   -- his opportunities in the bucket
  targets    INTEGER,
  rec_yds    INTEGER,
  rush_att   INTEGER,
  rush_yds   INTEGER,
  pass_att   INTEGER,
  pass_yds   INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, gsis_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_nfl_player_splits_gsis ON nfl_player_splits (gsis_id);
