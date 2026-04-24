-- 0014_pfr_season_advstats.sql
-- Keith 2026-04-23: PFR advanced stats that ONLY exist at SEASON granularity.
-- Weekly PFR payloads don't include ADOT, air yards, YBC/YAC-per-reception,
-- or bad-throw detail. Those are only in the season-level CSVs
-- (nflverse-data/releases/pfr_advstats/advstats_season_*.csv).
--
-- This table is keyed (season, gsis_id) — one row per player per season.
-- Populated by pipelines/etl/scripts/fetch_pfr_season_advstats.py.
-- The worker leaderboard LEFT JOINs this table when the filter covers a
-- full NFL season (the UPS default). Partial-season filters leave these
-- columns NULL (UI grays them with a "season-level metric" tooltip).

CREATE TABLE IF NOT EXISTS nfl_player_advstats_season (
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

CREATE INDEX IF NOT EXISTS idx_advseason_pfr_id ON nfl_player_advstats_season (pfr_id);
