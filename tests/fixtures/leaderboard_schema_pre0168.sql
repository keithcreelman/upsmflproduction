-- Schema-only fixture: production DDL (ups-mfl-db, read 2026-10-10) for the tables the
-- /api/advanced-stats-leaderboard query reads — BEFORE migration 0168. No data.
-- Tests apply worker/migrations/0168_*.sql on top, exactly as production will.
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
CREATE TABLE nfl_player_weekly_ext (
  season  INTEGER NOT NULL,
  week    INTEGER NOT NULL,
  gsis_id TEXT    NOT NULL,

  -- ── The missing THIRD tackle credit ────────────────────────────────────
  -- The NFL gamebook records three DISJOINT tackle credits; nflverse parses
  -- each into its own column (verified at PBP level: across all 702
  -- tackle_with_assist plays in 2025 the twa player appears as solo_tackle_N
  -- zero times and as assist_tackle_N zero times — no overlap either way):
  --
  --   "(A)"               → A    = def_tackles_solo         unassisted tackle
  --   "(A, B)"  comma     → A    = def_tackles_with_assist  A MADE it, w/ help
  --                         B    = def_tackle_assists
  --   "(A; B)"  semicolon → both = def_tackle_assists
  --
  -- For UPS scoring:
  --   MFL TK = nfl_player_weekly.def_tackles_solo + THIS COLUMN
  --   MFL AS = nfl_player_weekly.def_tackles_ast  (nflverse def_tackle_assists)
  --   official combined (== PFR `comb`) = all three summed
  --
  -- Corroborated four independent ways: MFL's own detailed? report (54/54
  -- player-weeks exact on both tackles and assists), PFR combined-tackle parity
  -- (residual 0.0-1.0% every season 2018-2025), src_weekly UPS points
  -- reconstruction, and raw PBP tackle notation. Bobby Wagner 2023: PFR 183 =
  -- 77 solo + 19 twa + 87 assists, exactly.
  --
  -- THE BUG THIS REPAIRS: fetch_nflverse_weekly.py bound def_tackles_ast to
  -- `def_tackles_with_assist` (a TACKLE count) while the real assist column
  -- `def_tackle_assists` was absent from the alias list entirely, so pick()
  -- could never reach it. 2025 stored 702 assists instead of 17,056. The two
  -- errors cancelled in the derived total (solo+ast == solo+twa == correct TK),
  -- which is why the table looked plausible for two years — and why fixing the
  -- alias ALONE would have been strictly WORSE than the bug (2025 IDP MAE
  -- 0.81 → 1.63, league IDP points +36.2%).
  def_tackles_with_assist INTEGER,

  -- ── First downs — UPS `FD 1-999 = *0.2`, ALL positions ─────────────────
  -- Continuous in MFL since 2011 (the 2021 `1C`→`FD` rename was cosmetic; only
  -- the range widened). No first-down column has ever existed in D1, so UPS
  -- scoring could not be reproduced for ANY offensive player. Adding these
  -- takes offensive reconstruction MAE from 2.234 → 0.264 pts/player-week.
  --
  -- UPS credits the QB for PASSING first downs too — not ball-carrier-only.
  -- Drake Maye 2025 = 238 passing + 50 rushing FD = 57.6 pts/season that were
  -- previously invisible to the scoring engine.
  --
  -- THREE SEPARATE COLUMNS ON PURPOSE. UPS `FD` scoring sums all of them, but
  -- FDPRR (receiving first downs per route run) is a receiving-only route
  -- efficiency metric and must NEVER include rushing first downs.
  pass_first_downs INTEGER,
  rush_first_downs INTEGER,
  rec_first_downs  INTEGER,

  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, kickoff_returns      INTEGER, kickoff_return_yards INTEGER, punt_returns         INTEGER, punt_return_yards    INTEGER, punt_return_tds      INTEGER, special_teams_tds    INTEGER, pass_tds_50plus     INTEGER, rush_tds_50plus     INTEGER, rec_tds_50plus      INTEGER, punt_ret_tds_50plus INTEGER, kick_ret_tds        INTEGER, kick_ret_tds_50plus INTEGER, def_ret_tds_50plus  INTEGER, rush_2pt INTEGER, rec_2pt  INTEGER,
  PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX idx_nflweekly_ext_player
  ON nfl_player_weekly_ext (gsis_id, season);
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
  pass_att_ez    INTEGER,   -- QB attempts with target in end zone

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
CREATE TABLE nfl_team_weekly (
  season              INTEGER NOT NULL,
  week                INTEGER NOT NULL,
  team                TEXT    NOT NULL,
  fourth_down_total   INTEGER,  -- 4th-down plays of any type (run/pass/punt/fg)
  fourth_down_go      INTEGER,  -- 4th-down plays where play_type IN (run,pass)
  fourth_down_punt    INTEGER,  -- play_type = punt
  fourth_down_fg      INTEGER,  -- play_type = field_goal
  stall_punts         INTEGER,  -- punts with yardline_100 BETWEEN 40 AND 50
  team_punts          INTEGER,  -- total punts (denominator for stall rate)
  PRIMARY KEY (season, week, team)
);
CREATE INDEX idx_team_weekly_team ON nfl_team_weekly (team, season);
CREATE TABLE nfl_team_pace (
  season           INTEGER NOT NULL,
  team             TEXT    NOT NULL,
  games            INTEGER,
  off_plays_pg     REAL,   -- offensive plays per game (run+pass; the team's pace)
  def_plays_pg     REAL,   -- plays the defense faces per game
  pace_sos         REAL,   -- avg opponent off_plays_pg over the schedule (schedule-adjusted)
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, team)
);
CREATE TABLE nfl_team_vegas_weekly (
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  team           TEXT    NOT NULL,
  opponent       TEXT,
  is_home        INTEGER,        -- 1 if team is home, else 0
  spread         REAL,           -- this team's spread (negative = favored)
  total_line     REAL,           -- game total
  implied_total  REAL,           -- this team's implied points
  actual_score   INTEGER,        -- NULL for unplayed games
  PRIMARY KEY (season, week, team)
);
CREATE INDEX idx_vegas_team_season ON nfl_team_vegas_weekly (team, season);
CREATE TABLE nfl_player_names (
  gsis_id      TEXT PRIMARY KEY,
  display_name TEXT,
  position     TEXT,
  last_season  INTEGER,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
, display_name_lower TEXT GENERATED ALWAYS AS (LOWER(display_name)) VIRTUAL);
CREATE INDEX idx_nfl_player_names_display_lower
  ON nfl_player_names (display_name_lower);
CREATE TABLE nfl_player_advstats_season (
  season  INTEGER NOT NULL,
  gsis_id TEXT    NOT NULL,
  pfr_id  TEXT,

  -- Receiving (advstats_season_rec.csv)
  rec_adot       REAL,     -- avg depth of target
  rec_ybc        INTEGER,  -- total yards before catch
  rec_ybc_per_r  REAL,     -- YBC per reception
  rec_yac        INTEGER,  -- total yards after catch (receiver-side)
  rec_yac_per_r  REAL,     -- YAC per reception
  rec_brk_tkl    INTEGER,
  rec_per_br     REAL,     -- receptions per broken tackle
  rec_drops      INTEGER,
  rec_drop_pct   REAL,
  rec_int        INTEGER,
  rec_rat        REAL,     -- QB rating when targeted

  -- Rushing (advstats_season_rush.csv)
  rush_ybc         INTEGER,
  rush_ybc_per_a   REAL,
  rush_yac         INTEGER,
  rush_yac_per_a   REAL,
  rush_brk_tkl     INTEGER,
  rush_att_per_br  REAL,

  -- Passing (advstats_season_pass.csv)
  pass_iay            INTEGER,  -- intended air yards
  pass_iay_per_att    REAL,     -- QB ADOT (IAY / PA)
  pass_cay            INTEGER,  -- completed air yards
  pass_cay_per_cmp    REAL,
  pass_yac            INTEGER,  -- QB-side YAC
  pass_yac_per_cmp    REAL,
  pass_bad_throws     INTEGER,
  pass_bad_throw_pct  REAL,
  pass_on_tgt         INTEGER,
  pass_on_tgt_pct     REAL,
  pass_drops          INTEGER,  -- receiver drops against this QB
  pass_drop_pct       REAL,
  pass_pressures      INTEGER,
  pass_pressure_pct   REAL,
  pass_times_blitzed  INTEGER,
  pass_times_hurried  INTEGER,
  pass_times_hit      INTEGER,
  pass_times_sacked   INTEGER,
  pass_pocket_time    REAL,

  -- Defense (advstats_season_def.csv)
  def_adot                 REAL,     -- avg depth of target against (dadot)
  def_air_yards_completed  INTEGER,
  def_yac                  INTEGER,
  def_targets              INTEGER,
  def_completions_allowed  INTEGER,
  def_cmp_pct              REAL,
  def_yards_allowed        INTEGER,
  def_yards_per_cmp        REAL,
  def_yards_per_tgt        REAL,
  def_tds_allowed          INTEGER,
  def_ints                 INTEGER,
  def_rating_allowed       REAL,
  def_blitz                INTEGER,
  def_hurries              INTEGER,
  def_qb_knockdowns        INTEGER,
  def_sacks                REAL,
  def_pressures            INTEGER,
  def_combined_tackles     INTEGER,
  def_missed_tackles       INTEGER,
  def_missed_tackle_pct    REAL,

  PRIMARY KEY (season, gsis_id)
);
CREATE INDEX idx_advseason_pfr_id ON nfl_player_advstats_season (pfr_id);
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
CREATE TABLE ff_player_ids (
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
, yahoo_id TEXT);
CREATE INDEX idx_ff_player_ids_gsis    ON ff_player_ids(gsis_id);
CREATE INDEX idx_ff_player_ids_sleeper ON ff_player_ids(sleeper_id);
CREATE INDEX idx_ff_player_ids_ktc     ON ff_player_ids(ktc_id);
CREATE INDEX idx_ff_player_ids_yahoo
  ON ff_player_ids(yahoo_id);
CREATE TABLE src_weekly (
  season                 INTEGER NOT NULL,
  week                   INTEGER NOT NULL,
  player_id              TEXT NOT NULL,
  pos_group              TEXT,
  status                 TEXT,
  score                  REAL,
  is_reg                 INTEGER,
  roster_franchise_id    TEXT,
  roster_franchise_name  TEXT,
  pos_rank               INTEGER,
  overall_rank           INTEGER, win_chunks REAL,
  PRIMARY KEY (season, week, player_id)
);
CREATE INDEX idx_src_weekly_player ON src_weekly (player_id, season DESC, week DESC);
CREATE INDEX idx_src_weekly_season ON src_weekly (season, week);
CREATE TABLE src_contracts (
  season          INTEGER NOT NULL,
  player_id       TEXT NOT NULL,
  franchise_id    TEXT,
  team_name       TEXT,
  salary          INTEGER,
  contract_year   INTEGER,
  contract_length INTEGER,
  contract_status TEXT,
  contract_info   TEXT,
  tcv             INTEGER,
  aav             INTEGER,
  extension_flag  INTEGER,
  year_values_json TEXT,
  source_detail   TEXT,
  generated_at_utc TEXT,
  PRIMARY KEY (season, player_id)
);
CREATE INDEX idx_src_contracts_player ON src_contracts (player_id);
CREATE INDEX idx_src_contracts_franchise ON src_contracts (season, franchise_id);
CREATE TABLE src_players (
  season           INTEGER NOT NULL,
  player_id        TEXT    NOT NULL,
  name             TEXT,                 -- "Last, First" per MFL convention
  position         TEXT,
  nfl_team         TEXT,
  status           TEXT,
  raw_json         TEXT,                 -- full MFL row for any field
                                         -- not promoted to a column
  updated_at_utc   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season, player_id)
);
CREATE INDEX idx_src_players_name
  ON src_players(name);
CREATE INDEX idx_src_players_player_id
  ON src_players(player_id);
CREATE INDEX idx_src_players_season_pos
  ON src_players(season, position);
CREATE TABLE nfl_leaderboard_precompute (
  season       INTEGER NOT NULL,
  pos_alias    TEXT    NOT NULL,   -- qb | skill | idp | kicker | punter
  rank         INTEGER NOT NULL,   -- position within the ORDER BY the query used
  gsis_id      TEXT,
  games        INTEGER NOT NULL DEFAULT 0,  -- so min_games filters without parsing JSON
  punts        INTEGER NOT NULL DEFAULT 0,  -- so the punter filter does too
  franchise_id TEXT,                        -- so the team filter does too
  row_json     TEXT    NOT NULL,
  built_at_utc TEXT    NOT NULL,
  PRIMARY KEY (season, pos_alias, rank)
);
CREATE INDEX idx_lbpre_season_pos_games
  ON nfl_leaderboard_precompute (season, pos_alias, games);
CREATE TABLE nfl_leaderboard_precompute_meta (
  season       INTEGER NOT NULL,
  pos_alias    TEXT    NOT NULL,
  row_count    INTEGER NOT NULL,
  source_sha   TEXT,
  built_at_utc TEXT    NOT NULL, data_max_week INTEGER, data_row_count INTEGER, teams_reported INTEGER, teams_expected INTEGER, week_complete INTEGER, mfl_scores_fingerprint TEXT,
  PRIMARY KEY (season, pos_alias)
);
CREATE TABLE nfl_player_epa (
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
