-- 0006_advanced_stats_schema.sql
-- Phase 0 + Phase 2 of the Advanced Stats Workbench rollout.
--   Keith decided 2026-04-22:
--     - No PFF (Phase 5 dropped)
--     - One Stats tab with Basic/Advanced toggle, not a separate tab
--     - Historical depth to 2011 where data exists
--     - Read IDP scoring weights live from MFL (not mirrored here)
--
-- Three tables:
--   1. player_id_crosswalk — MFL pid ↔ nflverse gsis_id ↔ PFR id.
--      The gating identity blocker for every join downstream.
--   2. nfl_player_weekly   — all-position box score weekly from
--      nflverse `load_player_stats()`. One row per (season, week,
--      gsis_id). Covers skill (rush/rec/pass), IDP, kicking,
--      punting in a single wide row. Nullable fields for stats that
--      don't apply to that position.
--   3. nfl_player_snaps    — offensive + defensive snap counts and
--      share from `load_snap_counts()`. Keyed the same way.
--
-- Note: Phase 3 tables (nfl_player_redzone / nfl_player_usage /
-- nfl_team_context for yardline bands + WOPR + pace) are NOT in
-- this migration — they ship later once box score is loaded and UI
-- is confirmed working.

-- ---------------------------------------------------------------
-- 1. player_id_crosswalk
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_id_crosswalk (
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

CREATE INDEX IF NOT EXISTS idx_crosswalk_gsis ON player_id_crosswalk (gsis_id);
CREATE INDEX IF NOT EXISTS idx_crosswalk_pfr  ON player_id_crosswalk (pfr_id);

-- ---------------------------------------------------------------
-- 2. nfl_player_weekly (box score, all positions)
-- ---------------------------------------------------------------
-- One wide row per player-week. Positions that don't participate
-- in a given stat simply have NULL / 0 for that column. Makes the
-- query layer dead simple (no per-position unions) and storage
-- cost is negligible — 2500 players × ~300 weeks × sparse row ≈ a
-- few MB total.
CREATE TABLE IF NOT EXISTS nfl_player_weekly (
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
  source      TEXT DEFAULT 'nflverse',

  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nflweekly_player ON nfl_player_weekly (gsis_id, season);
CREATE INDEX IF NOT EXISTS idx_nflweekly_seasonpos ON nfl_player_weekly (season, pos_group);

-- ---------------------------------------------------------------
-- 3. nfl_player_snaps
-- ---------------------------------------------------------------
-- Snap participation per player per game. Source: nflverse
-- `load_snap_counts()` (available 2012+; pre-2012 will have no
-- data — Advanced view renders "—" for those years).
CREATE TABLE IF NOT EXISTS nfl_player_snaps (
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  gsis_id         TEXT    NOT NULL,
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
  PRIMARY KEY (season, week, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nflsnaps_player ON nfl_player_snaps (gsis_id, season);
