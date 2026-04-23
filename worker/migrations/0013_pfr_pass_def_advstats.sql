-- 0013_pfr_pass_def_advstats.sql
-- Keith 2026-04-23 stat expansion: pull PFR's pass + def advanced
-- weekly stats on top of the rec + rush pulls we already have.
-- Also captures a few rec columns we were skipping (passer rating
-- when targeted, receiving int attempts, drop rate).

-- Receiving (additional from stat_type="rec")
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_rat REAL;           -- QB rating when targeted (PFR)
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_int INTEGER;        -- INTs while this player was targeted
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_drop_pct REAL;      -- drop %, 0-100 (PFR)
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_adot REAL;          -- avg depth of target (PFR) if available
ALTER TABLE nfl_player_weekly ADD COLUMN receiving_air_yards INTEGER;  -- total air yards on targets

-- Passing (stat_type="pass") — QB advanced
ALTER TABLE nfl_player_weekly ADD COLUMN passing_bad_throws INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_bad_throw_pct REAL;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_times_pressured INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_pressure_pct REAL;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_hurries INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_hits INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_air_yards INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_adot REAL;
ALTER TABLE nfl_player_weekly ADD COLUMN passing_yards_after_catch INTEGER;

-- Defense (stat_type="def") — IDP advanced
ALTER TABLE nfl_player_weekly ADD COLUMN def_missed_tackles INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN def_missed_tackle_pct REAL;
ALTER TABLE nfl_player_weekly ADD COLUMN def_completions_allowed INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN def_passer_rating_allowed REAL;
ALTER TABLE nfl_player_weekly ADD COLUMN def_yards_allowed INTEGER;
ALTER TABLE nfl_player_weekly ADD COLUMN def_pressures INTEGER;        -- PFR-charted pressures (pass-rushers)
