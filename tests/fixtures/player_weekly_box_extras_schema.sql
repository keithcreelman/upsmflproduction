-- Tables the r6 additions read that tests/fixtures/player_weekly_box_schema.sql (a production
-- sqlite_master read, 2026-10-22) does not hold. Built FROM THE MIGRATIONS, not read from production:
--   nfl_player_weekly_ext = 0114 (table, PK, index) + 0117 + 0119 + 0169 (added columns)
--   ups_player_projections = 0123 (whose header says it matches production sqlite_master, 2026-08-05)
--   nfl_team_weekly = 0016 (table, PK, index) + 0169 (team red-zone columns)
-- Confirm against production sqlite_master before release.

CREATE TABLE nfl_team_weekly (
  season              INTEGER NOT NULL,
  week                INTEGER NOT NULL,
  team                TEXT    NOT NULL,
  fourth_down_total   INTEGER,
  fourth_down_go      INTEGER,
  fourth_down_punt    INTEGER,
  fourth_down_fg      INTEGER,
  stall_punts         INTEGER,
  team_punts          INTEGER,
  rz_pass_att INTEGER, rz_pass_cmp INTEGER, rz_sacks INTEGER, rz_carries INTEGER, rz_scrambles INTEGER,
  i5_carries INTEGER, rz_targets INTEGER, ez_targets INTEGER, ez_targets_i20 INTEGER, rz_rec INTEGER,
  PRIMARY KEY (season, week, team)
);
CREATE INDEX idx_team_weekly_team ON nfl_team_weekly (team, season);

CREATE TABLE nfl_player_weekly_ext (
  season  INTEGER NOT NULL,
  week    INTEGER NOT NULL,
  gsis_id TEXT    NOT NULL,
  def_tackles_with_assist INTEGER,
  pass_first_downs INTEGER,
  rush_first_downs INTEGER,
  rec_first_downs  INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  kickoff_returns INTEGER, kickoff_return_yards INTEGER, punt_returns INTEGER, punt_return_yards INTEGER,
  punt_return_tds INTEGER, special_teams_tds INTEGER,
  pass_tds_50plus INTEGER, rush_tds_50plus INTEGER, rec_tds_50plus INTEGER, punt_ret_tds_50plus INTEGER,
  kick_ret_tds INTEGER, kick_ret_tds_50plus INTEGER, def_ret_tds_50plus INTEGER, rush_2pt INTEGER, rec_2pt INTEGER,
  def_targets INTEGER,
  PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX idx_nflweekly_ext_player ON nfl_player_weekly_ext (gsis_id, season);

CREATE TABLE ups_player_projections (
  season             INTEGER NOT NULL,
  week               INTEGER NOT NULL,
  player_id          TEXT    NOT NULL,
  projected_score    REAL    NOT NULL,
  first_projected    REAL,
  first_captured_at  INTEGER,
  updated_at         INTEGER NOT NULL,
  capture_count      INTEGER DEFAULT 1,
  PRIMARY KEY (season, week, player_id)
);
CREATE INDEX idx_projections_season_week ON ups_player_projections(season, week);
CREATE INDEX idx_projections_player ON ups_player_projections(player_id, season, week);
