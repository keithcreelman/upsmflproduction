-- Production DDL (sqlite_master of ups-mfl-db, read 2026-10-22) for the tables /api/player-weekly-box
-- reads: same columns, primary keys and indexes, no data. Used by tests/player_weekly_box_cost.test.mjs
-- to check which index D1's planner picks for the route's SQL.

CREATE TABLE nfl_player_weekly (
  season      INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  gsis_id     TEXT    NOT NULL,
  team        TEXT,
  opponent    TEXT,
  position    TEXT,
  pos_group   TEXT,     -- offensive pos_group (QB/RB/WR/TE) or defensive (DL/LB/DB) or PK

  -- Rushing (any position that carries the ball)
  rush_att    INTEGER,
  rush_yds    INTEGER,
  rush_tds    INTEGER,
  rush_long   INTEGER,
  rush_fumbles INTEGER,
  rush_fumbles_lost INTEGER,

  -- Receiving
  targets     INTEGER,
  receptions  INTEGER,
  rec_yds     INTEGER,
  rec_tds     INTEGER,
  rec_long    INTEGER,
  rec_fumbles INTEGER,
  rec_fumbles_lost INTEGER,

  -- Passing (QB mostly)
  pass_att    INTEGER,
  pass_cmp    INTEGER,
  pass_yds    INTEGER,
  pass_tds    INTEGER,
  pass_ints   INTEGER,
  pass_sacks  INTEGER,
  pass_sack_yds INTEGER,
  pass_long   INTEGER,
  pass_2pt    INTEGER,

  -- IDP (defensive)
  def_tackles_solo INTEGER,
  def_tackles_ast  INTEGER,
  def_tackles_total INTEGER,
  def_tfl     INTEGER,
  def_qb_hits INTEGER,
  def_sacks   REAL,          -- half-sacks are real values
  def_sack_yds INTEGER,
  def_ff      INTEGER,
  def_fr      INTEGER,
  def_ints    INTEGER,
  def_pass_def INTEGER,
  def_tds     INTEGER,

  -- Kicking (PK)
  fg_att      INTEGER,
  fg_made     INTEGER,
  fg_long     INTEGER,
  fg_att_0_39 INTEGER,
  fg_made_0_39 INTEGER,
  fg_att_40_49 INTEGER,
  fg_made_40_49 INTEGER,
  fg_att_50plus INTEGER,
  fg_made_50plus INTEGER,
  xp_att      INTEGER,
  xp_made     INTEGER,

  -- Punting
  punts       INTEGER,
  punt_yds    INTEGER,
  punt_long   INTEGER,
  punt_inside20 INTEGER,
  punt_net_avg REAL,

  -- Status flags
  starter_nfl INTEGER,        -- 1 = started that game for NFL team
  source      TEXT DEFAULT 'nflverse', routes_run INTEGER, fg_distance_sum_made INTEGER, fg_made_pbp INTEGER, receiving_drops INTEGER, receiving_broken_tackles INTEGER, rushing_broken_tackles INTEGER, passing_drops INTEGER, rushing_yards_before_contact INTEGER, rushing_yards_after_contact INTEGER, receiving_rat REAL, receiving_int INTEGER, receiving_drop_pct REAL, receiving_adot REAL, receiving_air_yards INTEGER, passing_bad_throws INTEGER, passing_bad_throw_pct REAL, passing_times_pressured INTEGER, passing_pressure_pct REAL, passing_hurries INTEGER, passing_hits INTEGER, passing_air_yards INTEGER, passing_adot REAL, passing_yards_after_catch INTEGER, def_missed_tackles INTEGER, def_missed_tackle_pct REAL, def_completions_allowed INTEGER, def_passer_rating_allowed REAL, def_yards_allowed INTEGER, def_pressures INTEGER, fg_att_50_59  INTEGER, fg_made_50_59 INTEGER, fg_att_60plus INTEGER, fg_made_60plus INTEGER, punt_tb       INTEGER, punt_spot_sum   INTEGER, punt_spot_count INTEGER, punt_net_yds_sum INTEGER, punt_inside5     INTEGER, punt_inside10    INTEGER, punt_inside15    INTEGER, punt_inside20_pbp INTEGER,

  PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX idx_nflweekly_player ON nfl_player_weekly (gsis_id, season);
CREATE INDEX idx_nflweekly_seasonpos ON nfl_player_weekly (season, pos_group);

CREATE TABLE nfl_player_redzone (
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  gsis_id        TEXT    NOT NULL,

  -- Rushing by yardline (distance to opponent goal line at snap)
  rush_att_i20   INTEGER,   -- Red Zone: yardline ≤ 20
  rush_att_i10   INTEGER,   -- yardline ≤ 10
  rush_att_i5    INTEGER,   -- Goal Line: yardline ≤ 5
  rush_yds_i20   INTEGER,
  rush_tds_i20   INTEGER,

  -- Receiving targets by yardline
  targets_i20    INTEGER,   -- Red Zone targets
  targets_i10    INTEGER,
  targets_i5     INTEGER,
  targets_ez     INTEGER,   -- End Zone: air_yards ≥ yardline_100 (pass targeted into the end zone)
  rec_i20        INTEGER,
  rec_tds_i20    INTEGER,

  -- Passing (QB) context by yardline — for QB popup completeness
  pass_att_i20   INTEGER,
  pass_tds_i20   INTEGER,
  pass_att_ez    INTEGER, pass_cmp_i20 INTEGER, sacks_i20    INTEGER,   -- QB attempts with target in end zone

  PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX idx_redzone_player ON nfl_player_redzone (gsis_id, season);

CREATE TABLE nfl_player_snaps (
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  pfr_id         TEXT    NOT NULL,
  team            TEXT,
  off_snaps       INTEGER,
  off_snaps_team  INTEGER,
  off_snap_pct    REAL,          -- 0.0 - 1.0
  def_snaps       INTEGER,
  def_snaps_team  INTEGER,
  def_snap_pct    REAL,
  st_snaps        INTEGER,
  st_snaps_team   INTEGER,
  st_snap_pct     REAL,
  PRIMARY KEY (season, week, pfr_id)
);
CREATE INDEX idx_nflsnaps_player ON nfl_player_snaps (pfr_id, season);

CREATE TABLE player_id_map (
  mfl_id     TEXT PRIMARY KEY,      
  gsis_id    TEXT,                  
  pfr_id     TEXT,                  
  espn_id    TEXT,                  
  mfl_position TEXT,                
                                    
                                    
  status     TEXT NOT NULL,         
                                    
  accepted   INTEGER NOT NULL DEFAULT 0,
  routes     TEXT,                  
  checks     TEXT,                  
  note       TEXT,
  built_at   TEXT
);
CREATE INDEX idx_player_id_map_gsis ON player_id_map (gsis_id);
CREATE INDEX idx_player_id_map_pfr  ON player_id_map (pfr_id);

CREATE TABLE player_id_crosswalk (
  mfl_player_id INTEGER PRIMARY KEY,
  gsis_id       TEXT,
  pfr_id        TEXT,
  sleeper_id    TEXT,
  espn_id       TEXT,
  full_name     TEXT,
  position      TEXT,
  birth_date    TEXT,
  confidence    TEXT,     -- 'exact' | 'fuzzy_auto' | 'manual' | 'unmapped'
  match_score   REAL,     -- jaro-winkler score for fuzzy matches (nullable)
  source        TEXT,     -- 'nflreadpy_ff_playerids' | 'nflreadpy_players' | 'manual'
  updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_crosswalk_gsis ON player_id_crosswalk (gsis_id);
CREATE INDEX idx_crosswalk_pfr  ON player_id_crosswalk (pfr_id);

-- worker/migrations/0084_etl_runs.sql
CREATE TABLE IF NOT EXISTS etl_runs (source TEXT PRIMARY KEY, last_run_utc TEXT, status TEXT, detail TEXT);
