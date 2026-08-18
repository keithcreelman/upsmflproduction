-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0121_injury_depth_matchup_roleevents.sql
-- Claude 2026-08-05 — availability, role competition, matchup, and the
-- role-event layer. Spec §6 (role competition and availability), §7 (structured
-- role events), and audit blocker B6.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. WEEKLY INJURY REPORTS — closes audit blocker B6
-- ═══════════════════════════════════════════════════════════════════════════
-- The audit found injury data existed only as nfl_player_injuries_season, which
-- AGGREGATES A COMPLETED SEASON (weeks_out, weeks_questionable) and therefore
-- cannot inform an in-season prediction at all. This is the weekly report:
-- practice participation Wed/Thu/Fri plus the official game-day designation.
--
-- GRAIN IS week_pregame, NOT week. The report for week W is published BEFORE
-- week W's game, so `week = W` is legal here — that is the entire point, the
-- same as a Vegas line. Verified against 2024 rather than assumed: median
-- date_modified is 42.6 HOURS BEFORE THE PLAYER'S OWN KICKOFF (Friday
-- designation, Sunday game), and only 8 of 6,215 rows (0.13%) postdate their
-- own kickoff.
--
-- ⚠️ Comparing against the WEEK'S FIRST game instead of the player's own gives
-- a wildly misleading answer — 82% would look "post-game", because most teams
-- play Sunday and the Thursday nighter anchors the week. The team-specific
-- kickoff is the only correct comparison.
CREATE TABLE IF NOT EXISTS nfl_player_injuries_weekly (
  season           INTEGER NOT NULL,
  week             INTEGER NOT NULL,
  gsis_id          TEXT    NOT NULL,
  team             TEXT,
  position         TEXT,
  report_status    TEXT,   -- Out | Doubtful | Questionable | NULL (= not listed)
  practice_status  TEXT,   -- Did Not Participate | Limited | Full | NULL
  report_injury    TEXT,   -- body part on the game-status report
  practice_injury  TEXT,   -- body part on the practice report
  date_modified    TEXT,   -- preserved so as-of claims stay auditable
  PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_inj_weekly_player ON nfl_player_injuries_weekly (gsis_id, season);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. WEEKLY DEPTH CHARTS — role competition, and the promotion signal
-- ═══════════════════════════════════════════════════════════════════════════
-- depth_rank is nflverse `depth_team`: 1 = starter, 2 = backup, 3 = third.
--
-- The CHANGE in this number is a first-class pre-breakout signal — spec §2
-- lists "depth-chart promotion" among the role events the system exists to
-- catch, and unlike route share it moves BEFORE the snaps do. A player promoted
-- to DC1 who has not yet played starter snaps is precisely the pre-breakout
-- case, so the derived delta is stored in the feature store rather than being
-- left for the model to rediscover.
--
-- Also week_pregame: the depth chart for week W is published before week W.
CREATE TABLE IF NOT EXISTS nfl_player_depth_weekly (
  season         INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  gsis_id        TEXT    NOT NULL,
  team           TEXT,
  depth_position TEXT,    -- the slot he is listed at (may differ from position)
  depth_rank     INTEGER, -- 1 = starter
  formation      TEXT,    -- Offense | Defense | Special Teams
  PRIMARY KEY (season, week, gsis_id, depth_position)
);
CREATE INDEX IF NOT EXISTS idx_depth_weekly_player ON nfl_player_depth_weekly (gsis_id, season);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. OPPONENT-ADJUSTED DEFENSE VS POSITION — matchup difficulty
-- ═══════════════════════════════════════════════════════════════════════════
-- UPS points each defense allowed to each position group, per game.
--
-- OPPONENT-ADJUSTED, per Keith's existing convention in /api/lineup-matchups:
-- raw points-allowed rewards a defense for having faced weak offences. The
-- adjustment divides by what those specific opponents averaged elsewhere, so
-- `adj_ratio` > 1 means "more generous than the schedule alone explains".
--
-- Grain is week (strictly before), NOT week_pregame: this is built from
-- REALIZED results, so week W's own outcome must never be included. The
-- distinction from the two tables above is exactly the leakage boundary — an
-- injury report is published pregame, a points-allowed figure is not.
CREATE TABLE IF NOT EXISTS model_team_def_vs_pos_weekly (
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,  -- as-of: built from weeks < this
  team          TEXT    NOT NULL,  -- the DEFENSE
  pos_group     TEXT    NOT NULL,
  games         INTEGER,
  pts_allowed_pg REAL,             -- raw UPS points allowed per game
  adj_ratio     REAL,              -- opponent-adjusted; >1 = generous
  rank_of_32    INTEGER,           -- 1 = most generous = best matchup
  PRIMARY KEY (season, week, team, pos_group)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ROLE EVENTS — the structured layer for camp / practice / transaction news
-- ═══════════════════════════════════════════════════════════════════════════
-- Spec §7, implemented as specified. This is the ONLY sanctioned route for
-- narrative information to reach a projection:
--
--     "Camp news should enter the model through this structured event layer.
--      Do not allow an LLM-generated narrative to directly overwrite
--      projections without storing the event, source, evidence grade and
--      expected impact."
--
-- Hence every row carries a source_url, an evidence_grade and an explicit
-- expected impact — a projection change must always be traceable to a claim
-- someone can go and check.
--
-- ⚠️ SHIPPED EMPTY, AND THAT IS DELIBERATE. Unlike injuries and depth charts,
-- there is NO structured historical source for camp reports. Two consequences:
--   (a) population requires either manual entry or a news pipeline that does
--       not exist yet, and
--   (b) it can never be BACKTESTED, because no dated archive of past camp
--       reports exists to replay — the same problem as external projections
--       (audit blocker B5). Any historical role event entered today would be
--       written with hindsight and would leak.
-- So this layer can improve LIVE projections going forward. It cannot
-- contribute to the walk-forward evaluation, and must not be allowed to look
-- as though it does.
CREATE TABLE IF NOT EXISTS model_player_role_events (
  event_id        TEXT PRIMARY KEY,
  gsis_id         TEXT,
  mfl_player_id   INTEGER,
  player_name     TEXT,
  season          INTEGER,
  event_date      TEXT NOT NULL,     -- when the news broke (ISO-8601)
  effective_week  INTEGER,           -- first week the role change applies to
  event_type      TEXT NOT NULL,     -- injury_vacancy | depth_promotion |
                                     -- first_team_reps | green_dot | two_minute |
                                     -- goal_line | slot | box | trade | signing |
                                     -- release | suspension | coaching_change |
                                     -- scheme_change | position_change |
                                     -- return_role | kicking_job
  old_role        TEXT,
  new_role        TEXT,
  exp_snap_delta  REAL,              -- expected change in snap share
  exp_route_delta REAL,
  exp_touch_delta REAL,
  prob_real       REAL,              -- P(the reported role is the actual role)
  evidence_grade  TEXT NOT NULL,     -- A official/named-starter/repeatedly confirmed
                                     -- B repeated first-team usage, multiple sources
                                     -- C isolated practice usage or one report
                                     -- D generic praise / highlight / speculation
  source_url      TEXT,
  source_type     TEXT,
  players_helped  TEXT,              -- CSV gsis_ids gaining opportunity
  players_hurt    TEXT,              -- CSV gsis_ids losing it
  notes           TEXT,
  expires_at      TEXT,              -- decay/reassessment date
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_role_events_player ON model_player_role_events (gsis_id, season);
CREATE INDEX IF NOT EXISTS idx_role_events_week ON model_player_role_events (season, effective_week);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. FEATURE-STORE COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE model_player_week_features ADD COLUMN inj_report_status   TEXT;
ALTER TABLE model_player_week_features ADD COLUMN inj_practice_status TEXT;
ALTER TABLE model_player_week_features ADD COLUMN inj_weeks_listed_l4 INTEGER;
ALTER TABLE model_player_week_features ADD COLUMN depth_rank          INTEGER;
ALTER TABLE model_player_week_features ADD COLUMN depth_rank_prev     INTEGER;
ALTER TABLE model_player_week_features ADD COLUMN d_depth_rank        INTEGER;
ALTER TABLE model_player_week_features ADD COLUMN opp_def_adj_ratio   REAL;
ALTER TABLE model_player_week_features ADD COLUMN opp_def_rank        INTEGER;
