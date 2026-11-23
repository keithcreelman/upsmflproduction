-- 0182: Team PROE sums per team-week, and play-by-play player-week columns for
-- the 2027 Performance screens (QB Usage, K misses, P inside-20 bands, longest
-- plays, receiving YAC). Additive only: one new table, new nullable columns.
-- Writers: pipelines/etl/scripts/fetch_nflverse_pbp.py (via
-- pipelines/etl/lib/pbp_derived.py) and fetch_nflverse_weekly.py (rec_yac).
-- REVIEW DRAFT (R6, 2026-11-23). Not applied anywhere.
--
-- ════════════════════════════════════════════════════════════════════════════
-- 1. nfl_team_proe_weekly: additive sums, one row per (season, filter, week, team)
-- ════════════════════════════════════════════════════════════════════════════
-- PROE (pass rate over expected) = 100 * (dropbacks - SUM(xpass)) / plays
--                                = SUM(pass_oe) / plays            [pp]
-- Play-weighted over any week range: sum the rows, then divide. Never average
-- weekly PROE values (that is a different, game-weighted number).
--
-- Which filter the app shows is Keith's decision; the rows for every named
-- filter are stored so the choice (or a change of mind) needs no PBP re-read.
-- Definitions live in pbp_derived.PROE_FILTERS:
--   all        every qualifying play: play_type pass/run, no two-point tries,
--              xpass and pass_oe present. EXCLUDES no_play (penalty-nullified
--              snaps), kneels, spikes and all special-teams plays.
--   neutral_a  all + win probability 0.20-0.80, downs 1-3, > 120 s left in the half
--   neutral_b  neutral_a, downs 1-2 only
--   neutral_c  all + wp 0.20-0.80, downs 1-2, quarters 1-3, |score margin| <= 8
-- team is the offense on that play (nflverse posteam), so a QB traded midseason
-- is shown his team in each game, not his current team.
--
-- Key order puts `filter` second so the rank query for one filter reads only
-- that filter's rows: WHERE season = ? AND filter = ? AND week <= ? is a PK
-- range scan of about 32 x weeks rows (320 at Week 10), no extra index.
-- Writes per weekly run: about 4 x 28-32 rows for the new week (+1 PK-index
-- entry each); already-final weeks re-send identical rounded sums, which the
-- changed-only upsert (pipelines/etl/lib/d1_io.py) skips.
CREATE TABLE IF NOT EXISTS nfl_team_proe_weekly (
  season       INTEGER NOT NULL,
  filter       TEXT    NOT NULL,
  week         INTEGER NOT NULL,
  team         TEXT    NOT NULL,
  plays        INTEGER NOT NULL,   -- qualifying plays under this filter
  dropbacks    INTEGER NOT NULL,   -- SUM(pass): pass attempts + sacks + scrambles
  xpass_sum    REAL    NOT NULL,   -- SUM(xpass), rounded to 6 dp
  pass_oe_sum  REAL    NOT NULL,   -- SUM(pass_oe), rounded to 4 dp; = 100*(dropbacks - xpass_sum)
  proe_def     INTEGER NOT NULL,   -- pbp_derived.PROE_DEF_VERSION; never add rows of different versions
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, filter, week, team)
);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. nfl_player_weekly_ext: PBP-owned player-week columns
-- ════════════════════════════════════════════════════════════════════════════
-- nfl_player_weekly is at D1's 100-column cap (0114), so these join 1:1 here.
--
-- COVERAGE CONTRACT (differs from 0114/0118 on purpose): each column below is
-- written for every player-week where it APPLIES and is NULL otherwise. NULL
-- means "not applicable or not measured", never zero. Do NOT COALESCE these to
-- 0. A future prune like 0118 must list these columns, or it would delete rows
-- that hold only them.
--
-- Longest plays. The nfl_player_weekly *_long columns are 100% NULL (nflverse
-- stopped publishing them) and the weekly fetcher would overwrite them, so the
-- PBP values live here under a _pbp suffix.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rush_long_pbp     INTEGER; -- max rushing_yards on his carries (kneels and scrambles included; may be negative)
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rec_long_pbp      INTEGER; -- max receiving_yards on his receptions (yards after a lateral TO him are not his reception)
ALTER TABLE nfl_player_weekly_ext ADD COLUMN pass_long_pbp     INTEGER; -- max passing_yards on his completions
-- Sack fumbles: set for every passer sacked at least once that week (0 = measured).
ALTER TABLE nfl_player_weekly_ext ADD COLUMN sack_fumbles      INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN sack_fumbles_lost INTEGER; -- recovered by the defense; add to rush/rec fumbles lost for QB fumbles lost
-- Missed / blocked FG distances (UPS MG): ';'-joined yards, '' = none; set for
-- every kicker-week with an FG attempt. NULL also when any miss lacked a distance.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN fg_missed_dists   TEXT;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN fg_blocked_dists  TEXT;
-- Punter: blocked punts (UPS HBP) and mutually exclusive inside-20 bands by the
-- end spot (yardline_100 - kick_distance + return_yards, from the receiving
-- team's goal line): lt5 = (0,5), 5to10 = [5,10), 10to20 = [10,20). Set for
-- every punter-week; the three bands are NULL for a punter-week whose bands do
-- not sum to its nflverse punt_inside_twenty count (fail closed).
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punts_blocked     INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_i20_lt5      INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_i20_5to10    INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_i20_10to20   INTEGER;
-- Receiving yards after catch, verbatim from nflverse weekly
-- receiving_yards_after_catch (written by fetch_nflverse_weekly.py, 0118 contract).
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rec_yac           INTEGER;
