-- 0131_fantasy_rosters_and_scoring.sql
-- Multi-platform fantasy ingestion: weekly rosters, per-player weekly stats and
-- points, team weekly scores, matchups, standings snapshots.
-- Fifth of six (0127-0132). Apply AFTER 0130.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- WHY WEEKLY ROSTERS ARE THE MOST VALUABLE TABLE HERE. Bench points, optimal-
-- versus-actual lineup efficiency, "did this manager start the right guy", and
-- games-started-after-acquisition all reduce to: who was in the lineup, in which
-- slot, in which week. None of it is recoverable later — the provider serves one
-- roster at a time and has no bulk or date-ranged form, so this is captured
-- week by week or not at all.
--
-- STATS ARE A TALL TABLE, DELIBERATELY. One row per (player, week, stat_id)
-- rather than a column per stat. Three reasons, in order of severity:
--   1. D1 enforces a HARD 100-column-per-table cap. nfl_player_weekly hit it
--      exactly and is now frozen — ALTER TABLE fails permanently with
--      SQLITE_ERROR, and dropping columns was evaluated and rejected. A wide
--      stat table would hit the same wall and could never be widened again.
--   2. The stat set differs by season and by platform. A tall table absorbs a
--      new stat_id with no migration; CBS and ESPN slot in the same way.
--   3. It joins directly to fantasy_scoring_rules on stat_id, which is what
--      makes points reconstruction checkable instead of assumed.

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_roster_snapshots — who was on which roster, in which slot, per week.
--
-- ⚠️ is_started IS DERIVED, NOT READ. Yahoo has no is_started field anywhere.
-- Starter status is computed from selected_position against THIS league's own
-- slot definitions in fantasy_roster_positions (0128) — never from a hardcoded
-- {'BN','IR'} set, because leagues define IR+, IR-R, NA and other bench-like
-- slots that a hardcoded set would silently count as starters.
--
-- ⚠️ acquisition_type / acquisition_date are DERIVED from the transaction log
-- where derivable, and NULL where not. They are not provider fields on a roster
-- response. is_derived_acquisition marks which is which.
--
-- game_started_before_lock answers "was this player's NFL game already underway
-- when the roster was observed", which matters for judging a lineup decision.
-- It is NULL when it cannot be established rather than guessed at.
CREATE TABLE IF NOT EXISTS fantasy_roster_snapshots (
  platform              TEXT    NOT NULL,
  league_key            TEXT    NOT NULL,
  season                INTEGER NOT NULL,
  week                  INTEGER NOT NULL,
  team_key              TEXT    NOT NULL,
  player_uid            TEXT    NOT NULL,
  selected_position     TEXT,               -- the lineup slot, VERBATIM ('QB','W/R/T','BN','IR')
  is_starter            INTEGER,            -- DERIVED from fantasy_roster_positions; NULL if slots unknown
  is_bench              INTEGER,
  is_injury_slot        INTEGER,
  is_flex_slot          INTEGER,
  eligible_positions    TEXT,               -- JSON array, as of this week
  player_position       TEXT,
  nfl_team_abbr         TEXT,
  injury_status         TEXT,               -- VERBATIM
  acquisition_type      TEXT,               -- DERIVED from transactions; NULL when underivable
  acquisition_date      TEXT,               -- DERIVED; NULL when underivable
  is_derived_acquisition INTEGER NOT NULL DEFAULT 0,
  game_started_before_lock INTEGER,         -- NULL = could not be established
  roster_observed_at_utc TEXT   NOT NULL DEFAULT (datetime('now')),
  is_editable_at_capture INTEGER,           -- provider flag: was the lineup still changeable
  raw_player_json       TEXT,
  unmapped_fields       TEXT,
  source_run_id         TEXT,
  PRIMARY KEY (platform, league_key, season, week, team_key, player_uid)
);

-- "This team's week-N lineup" — the core roster read.
CREATE INDEX IF NOT EXISTS idx_fantasy_roster_snapshots_team_week
  ON fantasy_roster_snapshots(platform, league_key, season, week, team_key);

-- "Every week this player was rostered / started" — usage and bench analysis.
CREATE INDEX IF NOT EXISTS idx_fantasy_roster_snapshots_player
  ON fantasy_roster_snapshots(platform, player_uid, season, week);

-- Starter-count-by-position and bench-allocation queries.
CREATE INDEX IF NOT EXISTS idx_fantasy_roster_snapshots_starters
  ON fantasy_roster_snapshots(platform, league_key, season, week, is_starter);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_week_stats — one row per player per week per stat.
--
-- stat_value is REAL and nullable. NULL means the provider returned no value
-- for that stat; 0 means it returned zero. Those are different claims and the
-- ingester never converts one into the other.
--
-- league_key is part of the key because fantasy points are league-relative and
-- the provider only populates them in a league context — the same raw stat line
-- yields different points in different leagues. Keeping the stats league-scoped
-- keeps stats and points joinable on one key.
CREATE TABLE IF NOT EXISTS fantasy_player_week_stats (
  platform        TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  player_uid      TEXT    NOT NULL,
  stat_id         TEXT    NOT NULL,
  stat_value      REAL,               -- NULL = not reported; 0 = reported zero
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, week, player_uid, stat_id)
);

-- "Every stat this player put up this week" — the points-reconciliation join.
CREATE INDEX IF NOT EXISTS idx_fantasy_player_week_stats_player
  ON fantasy_player_week_stats(platform, player_uid, season, week);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_week_points — the provider's own fantasy points, per week.
--
-- points_provider is what the platform reported. points_recomputed is what THIS
-- league's scoring rules produce from fantasy_player_week_stats. They are stored
-- side by side on purpose: when both are present and disagree, the scoring
-- model is wrong or the stat capture is incomplete, and points_reconciled
-- records the verdict. That check is a data-quality requirement, not a nicety —
-- it is the only way to know the scoring table was parsed correctly.
--
-- ⚠️ projected_points is captured only where the provider actually exposes it.
-- There is no documented per-player projection resource and historical
-- projections are definitively unavailable, so this column is NULL for every
-- backfilled week and that is correct rather than missing.
CREATE TABLE IF NOT EXISTS fantasy_player_week_points (
  platform            TEXT    NOT NULL,
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  week                INTEGER NOT NULL,
  player_uid          TEXT    NOT NULL,
  points_provider     REAL,               -- as reported; NULL = not reported
  points_recomputed   REAL,               -- from this league's scoring rules
  points_reconciled   INTEGER,            -- 1 = agree within tolerance, 0 = disagree, NULL = not checked
  reconcile_delta     REAL,
  projected_points    REAL,               -- only where exposed; NULL for all backfilled weeks
  source_run_id       TEXT,
  updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, week, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_player_week_points_player
  ON fantasy_player_week_points(platform, player_uid, season, week);

-- "Which weeks failed to reconcile" — a data-quality read.
CREATE INDEX IF NOT EXISTS idx_fantasy_player_week_points_reconcile
  ON fantasy_player_week_points(platform, league_key, season, points_reconciled);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_team_week_scores — one row per team per week.
--
-- points_from_starters is recomputed from the roster + player points and is
-- compared against the provider's team total. A disagreement means the roster
-- capture is incomplete or the starter derivation is wrong; that is exactly the
-- 'team scores disagree with matchup scores' validation, and it needs both
-- numbers stored to be checkable at all.
CREATE TABLE IF NOT EXISTS fantasy_team_week_scores (
  platform              TEXT    NOT NULL,
  league_key            TEXT    NOT NULL,
  season                INTEGER NOT NULL,
  week                  INTEGER NOT NULL,
  team_key              TEXT    NOT NULL,
  points_provider       REAL,             -- the provider's team total
  points_from_starters  REAL,             -- recomputed from roster + player points
  points_bench          REAL,             -- recomputed; the bench-points metric
  points_optimal        REAL,             -- best legal lineup under this league's slots
  lineup_efficiency     REAL,             -- points_from_starters / points_optimal
  projected_points      REAL,             -- only where exposed
  scores_reconciled     INTEGER,          -- 1 = provider and recomputed agree
  reconcile_delta       REAL,
  is_derived            INTEGER NOT NULL DEFAULT 0,
  source_run_id         TEXT,
  updated_at_utc        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, week, team_key)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_team_week_scores_team
  ON fantasy_team_week_scores(platform, team_key, season, week);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_matchups — one row per head-to-head pairing per week.
--
-- KEY CHOICE. The provider gives matchups no id of their own, so matchup_key is
-- SYNTHESIZED as the two team keys sorted lexically and joined with '|'. Sorting
-- is what makes it deterministic: without it, the same matchup ingested from
-- team A's perspective and from the league scoreboard would produce two rows.
-- This mirrors the existing repo idiom of a synthesized natural key with a
-- UNIQUE constraint (ups_transactions.mfl_txn_id, ups_drop_events.ledger_key)
-- rather than a content hash.
--
-- team_a_key/team_b_key are stored in that same sorted order so the pairing is
-- canonical; winner_team_key says who actually won and is_tied covers the rest.
CREATE TABLE IF NOT EXISTS fantasy_matchups (
  platform              TEXT    NOT NULL,
  league_key            TEXT    NOT NULL,
  season                INTEGER NOT NULL,
  week                  INTEGER NOT NULL,
  matchup_key           TEXT    NOT NULL,   -- '<lesser_team_key>|<greater_team_key>', sorted
  team_a_key            TEXT    NOT NULL,
  team_b_key            TEXT    NOT NULL,
  team_a_points         REAL,
  team_b_points         REAL,
  team_a_projected      REAL,
  team_b_projected      REAL,
  team_a_grade          TEXT,               -- provider matchup grade where exposed
  team_b_grade          TEXT,
  team_a_win_probability REAL,
  team_b_win_probability REAL,
  winner_team_key       TEXT,               -- NULL when tied or not yet decided
  is_tied               INTEGER,
  status                TEXT,               -- 'preevent'|'midevent'|'postevent', VERBATIM
  is_playoffs           INTEGER,
  is_consolation        INTEGER,
  is_division_matchup   INTEGER,
  tiebreaker_note       TEXT,
  recap_url             TEXT,
  recap_title           TEXT,
  raw_matchup_json      TEXT,
  unmapped_fields       TEXT,
  source_run_id         TEXT,
  updated_at_utc        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, week, matchup_key)
);

-- The weekly scoreboard read.
CREATE INDEX IF NOT EXISTS idx_fantasy_matchups_week
  ON fantasy_matchups(platform, league_key, season, week);

-- "Every matchup this team played" — records, streaks, all-play.
CREATE INDEX IF NOT EXISTS idx_fantasy_matchups_team_a
  ON fantasy_matchups(platform, team_a_key, season, week);

CREATE INDEX IF NOT EXISTS idx_fantasy_matchups_team_b
  ON fantasy_matchups(platform, team_b_key, season, week);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_standings_snapshots — standings as of a point in time.
--
-- ⚠️ MOST ROWS HERE ARE INFERRED, AND THE COLUMN SAYS SO. The provider returns
-- exactly ONE standings state per league: final for a completed season, current
-- for a live one. There is no standings;week=N and no historical snapshot
-- endpoint. Week-by-week standings therefore have to be accumulated from the
-- scoreboard, respecting playoff_start_week and the is_playoffs/is_consolation
-- flags so postseason results do not pollute regular-season records.
--
-- as_of_week distinguishes the two kinds: a row carrying the provider's actual
-- response uses as_of_week = the league's final/current week with is_inferred=0;
-- every reconstructed week carries is_inferred=1. A reconstructed rank must
-- never be presented as a source value, which is why the flag is NOT NULL and
-- has no default that could hide an unset value.
CREATE TABLE IF NOT EXISTS fantasy_standings_snapshots (
  platform            TEXT    NOT NULL,
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  as_of_week          INTEGER NOT NULL,
  team_key            TEXT    NOT NULL,
  rank                INTEGER,
  playoff_seed        INTEGER,
  wins                INTEGER,
  losses              INTEGER,
  ties                INTEGER,
  win_percentage      REAL,
  points_for          REAL,
  points_against      REAL,
  games_back          REAL,
  streak_type         TEXT,               -- 'win'|'loss', VERBATIM
  streak_value        INTEGER,
  division_id         TEXT,
  division_rank       INTEGER,
  clinched_playoffs   INTEGER,
  is_final            INTEGER NOT NULL DEFAULT 0,   -- 1 = end-of-season standings
  is_inferred         INTEGER NOT NULL,             -- 1 = RECONSTRUCTED by us, not read
  inference_basis     TEXT,                         -- how it was reconstructed
  raw_standings_json  TEXT,
  source_run_id       TEXT,
  updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, as_of_week, team_key)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_standings_snapshots_team
  ON fantasy_standings_snapshots(platform, team_key, season, as_of_week);

-- "Final standings for every season" — the league-history read.
CREATE INDEX IF NOT EXISTS idx_fantasy_standings_snapshots_final
  ON fantasy_standings_snapshots(platform, league_key, season, is_final);
