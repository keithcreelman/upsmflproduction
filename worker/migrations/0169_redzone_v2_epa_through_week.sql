-- 0169: red-zone counts that mean what their labels say, team red-zone totals
-- per game, and the week an EPA row runs through. Additive only.
--
-- WHY (2026-10-10 audit, Players tab). Replaying fetch_nflverse_pbp.py on the
-- 2026 play-by-play showed:
--   * two-point tries were counted as red-zone plays (26 tries changed 40
--     players' counts) — they are tries from the 2 with no down;
--   * pass_att_i20 counted sacks (37) and two-point passes (21): 639 stored vs
--     581 real inside-20 attempts — so it is redefined as ATTEMPTS (completions,
--     incompletions, interceptions) and sacks get their own column;
--   * nothing stored a passer's inside-20 COMPLETIONS;
--   * team shares were divided by team totals summed from player rows only in
--     weeks the player had a box-score row, so a player who played without a
--     stat had that game dropped from his denominator (one WR read 33.3% of
--     his team's red-zone targets; the true figure is 4.3%). Team totals now
--     come straight from the play-by-play, per team per game;
--   * nfl_player_epa had no week column, so the app could not say which weeks
--     its EPA covered.
-- After applying: re-run fetch_nflverse_pbp.py and fetch_nflverse_epa.py for
-- the seasons shown, DELETING that season's nfl_player_redzone rows first (the
-- upsert would keep rows the new rules no longer produce, e.g. a player whose
-- only red-zone play was a two-point target), then rebuild the leaderboard
-- precompute.

ALTER TABLE nfl_player_redzone ADD COLUMN pass_cmp_i20 INTEGER;   -- completions on inside-20 attempts (passer)
ALTER TABLE nfl_player_redzone ADD COLUMN sacks_i20    INTEGER;   -- times sacked inside the 20 (passer); not attempts

ALTER TABLE nfl_team_weekly ADD COLUMN rz_pass_att    INTEGER;   -- team inside-20 pass attempts (no sacks, no 2-pt)
ALTER TABLE nfl_team_weekly ADD COLUMN rz_pass_cmp    INTEGER;
ALTER TABLE nfl_team_weekly ADD COLUMN rz_sacks       INTEGER;
ALTER TABLE nfl_team_weekly ADD COLUMN rz_carries     INTEGER;   -- inside-20 run plays (scrambles included, kneels not)
ALTER TABLE nfl_team_weekly ADD COLUMN rz_scrambles   INTEGER;
ALTER TABLE nfl_team_weekly ADD COLUMN i5_carries     INTEGER;
ALTER TABLE nfl_team_weekly ADD COLUMN rz_targets     INTEGER;   -- inside-20 passes with a targeted receiver
ALTER TABLE nfl_team_weekly ADD COLUMN ez_targets     INTEGER;   -- passes that reached the end zone, from anywhere
ALTER TABLE nfl_team_weekly ADD COLUMN ez_targets_i20 INTEGER;   -- …thrown from inside the 20
ALTER TABLE nfl_team_weekly ADD COLUMN rz_rec         INTEGER;

ALTER TABLE nfl_player_epa ADD COLUMN through_week INTEGER;       -- max REG week aggregated into the row

-- PFR coverage targets (Keith 2026-10-10: Coverage shows completions / targets,
-- sorted by targets). nfl_player_weekly is at D1's 100-column cap, so it lives
-- in the _ext table beside def_tackles_with_assist.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN def_targets INTEGER;
