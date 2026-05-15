-- Phase 3 migration 0028: Franchise-level fantasy results.
--
-- Adds the four `src_*` tables that hold per-franchise weekly scoring,
-- head-to-head matchups (with scores + winner), divisional matchup flag,
-- pre-computed all-play wins/losses, and season-aggregate standings.
--
-- Populated from the local mfl_database.db (`schedule`, `weeklyresults_summary`,
-- `standings`, `franchises`) via scripts/load_local_to_d1.py.
--
-- Bye-week semantics: a (season, week, franchise_id) with no row in
-- src_schedule means no H2H matchup that week — but src_weekly_franchise_summary
-- still has a row with the franchise's weekly score so all-play continues to count.
--
-- Multi-opponent weeks: this league routinely has 2- and 3-opponent weeks
-- in the regular season. src_schedule's 4-col PK accommodates that natively.
-- Playoffs are always single-matchup (is_playoff=1).

CREATE TABLE IF NOT EXISTS src_franchises (
  season         INTEGER NOT NULL,
  franchise_id   TEXT    NOT NULL,
  owner_name     TEXT,
  team_name      TEXT,
  division       TEXT,
  logo           TEXT,
  PRIMARY KEY (season, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_franchises_season_division ON src_franchises (season, division);
CREATE INDEX IF NOT EXISTS idx_src_franchises_owner ON src_franchises (owner_name, season);

CREATE TABLE IF NOT EXISTS src_schedule (
  season                  INTEGER NOT NULL,
  week                    INTEGER NOT NULL,
  franchise_id            TEXT    NOT NULL,
  opponent_franchise_id   TEXT    NOT NULL,
  franchise_name          TEXT,
  opponent_franchise_name TEXT,
  franchise_owner         TEXT,
  opponent_owner          TEXT,
  is_home                 INTEGER,
  result                  TEXT,
  team_score              REAL,
  opponent_score          REAL,
  is_divisional           INTEGER,
  is_playoff              INTEGER,
  PRIMARY KEY (season, week, franchise_id, opponent_franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_schedule_franchise ON src_schedule (franchise_id, season DESC, week DESC);
CREATE INDEX IF NOT EXISTS idx_src_schedule_season_week ON src_schedule (season, week);
CREATE INDEX IF NOT EXISTS idx_src_schedule_divisional ON src_schedule (season, is_divisional);

CREATE TABLE IF NOT EXISTS src_weekly_franchise_summary (
  season               INTEGER NOT NULL,
  week                 INTEGER NOT NULL,
  franchise_id         TEXT    NOT NULL,
  franchise_name       TEXT,
  owner_name           TEXT,
  h2h_team_score       REAL,
  h2h_opponent1_id     TEXT,
  h2h_opponent1_name   TEXT,
  h2h_opponent1_owner  TEXT,
  h2h_opponent1_score  REAL,
  h2h_opponent2_id     TEXT,
  h2h_opponent2_name   TEXT,
  h2h_opponent2_owner  TEXT,
  h2h_opponent2_score  REAL,
  h2h_opponent3_id     TEXT,
  h2h_opponent3_name   TEXT,
  h2h_opponent3_owner  TEXT,
  h2h_opponent3_score  REAL,
  h2h_result           TEXT,
  h2h_wins             INTEGER,
  h2h_losses           INTEGER,
  h2h_ties             INTEGER,
  h2h_games            INTEGER,
  allplay_wins         INTEGER NOT NULL,
  allplay_losses       INTEGER NOT NULL,
  allplay_ties         INTEGER NOT NULL,
  allplay_games        INTEGER NOT NULL,
  off_points           REAL,
  def_points           REAL,
  allplay_off_wins     INTEGER,
  allplay_off_losses   INTEGER,
  allplay_off_ties     INTEGER,
  allplay_def_wins     INTEGER,
  allplay_def_losses   INTEGER,
  allplay_def_ties     INTEGER,
  PRIMARY KEY (season, week, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_wfs_franchise ON src_weekly_franchise_summary (franchise_id, season DESC, week DESC);
CREATE INDEX IF NOT EXISTS idx_src_wfs_season_week ON src_weekly_franchise_summary (season, week);

CREATE TABLE IF NOT EXISTS src_standings (
  season         INTEGER NOT NULL,
  franchise_id   TEXT    NOT NULL,
  franchise_name TEXT,
  owner_name     TEXT,
  division       TEXT,
  div_w          INTEGER,
  div_l          INTEGER,
  div_pct        REAL,
  h2h_w          INTEGER,
  h2h_l          INTEGER,
  h2h_t          INTEGER,
  h2h_pct        REAL,
  allplay_w      INTEGER,
  allplay_l      INTEGER,
  allplay_t      INTEGER,
  allplay_pct    REAL,
  pf             REAL,
  pp             REAL,
  pwr            REAL,
  eff            REAL,
  salary         TEXT,
  PRIMARY KEY (season, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_standings_owner ON src_standings (owner_name, season DESC);
CREATE INDEX IF NOT EXISTS idx_src_standings_division ON src_standings (season, division);
