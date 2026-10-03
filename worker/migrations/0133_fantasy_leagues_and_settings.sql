-- 0128_fantasy_leagues_and_settings.sql
-- Multi-platform fantasy ingestion: league continuity, per-season settings,
-- scoring rules, bonuses, roster slots, divisions, schedule periods.
-- Second of six (0127-0132). Apply AFTER 0127.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- WHY SCORING IS ITS OWN TABLE AND NOT A JSON BLOB. Every analytical question
-- worth asking of this data — points above replacement, draft price vs. season
-- points, optimal-vs-actual lineup efficiency — depends on THIS league's exact
-- scoring, not on an assumed standard. A blob cannot be joined, cannot be
-- diffed across seasons, and cannot answer "when did the TE premium change".
-- Scoring is stored one row per stat per season so a rule change is visible as
-- data rather than buried in a payload.
--
-- ⚠️ NEVER IMPORT UPS SCORING. The UPS league's PPR-by-position thresholds
-- (TE 1.5 / WR 1.0 / RB 0.8, first-down 0.2, sack-yard -0.1) are MFL-league
-- rules and have nothing to do with this league. Every points calculation over
-- fantasy_* rows must read fantasy_scoring_rules for the matching
-- (platform, league_key, season) and must fail rather than fall back to a
-- default if the rules are missing.
--
-- STAT IDS ARE PRESERVED ALONGSIDE NAMES. The platform's own numeric stat_id is
-- the join key; the human name is carried for readability. Yahoo's stat_id set
-- changes between game keys, so the pair is stored per season rather than in a
-- single global dictionary.

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_leagues — the league as a CONTINUITY, across every season it ran.
--
-- fantasy_league_seasons (0127) holds one row per season instance, keyed by the
-- platform's season-scoped league key. This table holds the thing a human means
-- by "my league": the chain of those instances. league_uid is a LOCAL stable
-- identifier we mint once and never change, precisely because the platform's
-- own key cannot serve that role — Yahoo's league key embeds the game_key and
-- therefore differs every single season.
CREATE TABLE IF NOT EXISTS fantasy_leagues (
  platform          TEXT    NOT NULL,
  league_uid        TEXT    NOT NULL,   -- locally minted, stable forever
  display_name      TEXT,               -- most recent season's league name
  first_season      INTEGER,
  last_season       INTEGER,
  season_count      INTEGER,
  seed_league_key   TEXT,               -- the key the chain was discovered from
  provider_account  TEXT,               -- which fantasy_oauth_tokens.account_key can read it
  notes             TEXT,
  created_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_uid)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_league_settings — one row per league-season.
--
-- Deliberately wide but well under D1's hard 100-column-per-table cap (this is
-- ~40). nfl_player_weekly already hit that cap and is now FROZEN — ALTER TABLE
-- fails permanently with SQLITE_ERROR once you reach it, and dropping columns
-- was rejected as a fix. Anything further goes in a 1:1 `_ext` companion.
--
-- VALUES ARE STORED VERBATIM. draft_type, waiver_type, waiver_rule,
-- post_draft_players, trade_ratify_type and player_pool keep the platform's own
-- vocabulary with no normalization. Cross-season vocabulary drift is a known
-- silent-failure class in this repo (the 2025→2026 contract_status change made
-- cross-season joins quietly return nothing), so the ingester prints the
-- vocabulary it observed each run instead of coercing it.
--
-- NULL MEANS "THE PLATFORM DID NOT SAY". It does not mean zero, and it does not
-- mean false. uses_faab IS NULL is a different fact from uses_faab = 0.
CREATE TABLE IF NOT EXISTS fantasy_league_settings (
  platform                     TEXT    NOT NULL,
  league_key                   TEXT    NOT NULL,
  season                       INTEGER NOT NULL,

  -- identity / presentation
  league_name                  TEXT,
  league_url                   TEXT,
  logo_url                     TEXT,
  league_type                  TEXT,      -- 'private'|'public'
  num_teams                    INTEGER,
  max_teams                    INTEGER,

  -- calendar
  start_week                   INTEGER,
  end_week                     INTEGER,
  current_week                 INTEGER,
  start_date                   TEXT,      -- 'YYYY-MM-DD' as given; no timezone is documented
  end_date                     TEXT,
  is_finished                  INTEGER,
  weekly_deadline              TEXT,      -- roster-lock behaviour, verbatim
  league_update_timestamp_unix INTEGER,

  -- draft
  draft_status                 TEXT,      -- 'predraft'|'drafted'|'postdraft'
  draft_type                   TEXT,      -- verbatim
  is_auction_draft             INTEGER,
  draft_time_unix              INTEGER,
  draft_pick_time_sec          INTEGER,
  post_draft_players           TEXT,      -- verbatim, e.g. 'W' (waivers)

  -- scoring / transactions
  scoring_type                 TEXT,      -- 'head'|'point'
  uses_fractional_points       INTEGER,
  uses_negative_points         INTEGER,
  waiver_type                  TEXT,      -- verbatim
  waiver_rule                  TEXT,      -- verbatim, e.g. 'gametime'
  waiver_time_days             INTEGER,
  uses_faab                    INTEGER,
  faab_budget                  INTEGER,   -- NULL when the platform does not expose it
  trade_end_date               TEXT,
  trade_ratify_type            TEXT,      -- 'vote'|'commish'|'none'
  trade_reject_time_days       INTEGER,
  max_acquisitions             INTEGER,   -- season cap, NULL when uncapped/unexposed
  max_weekly_acquisitions      INTEGER,
  max_trades                   INTEGER,
  player_pool                  TEXT,      -- verbatim, e.g. 'ALL'
  cant_cut_list                TEXT,      -- verbatim, e.g. 'yahoo'

  -- playoffs
  uses_playoff                 INTEGER,
  playoff_start_week           INTEGER,
  num_playoff_teams            INTEGER,
  num_playoff_consolation_teams INTEGER,
  has_playoff_consolation_games INTEGER,
  uses_playoff_reseeding       INTEGER,
  uses_lock_eliminated_teams   INTEGER,
  has_multiweek_championship   INTEGER,

  -- keepers / divisions
  uses_keepers                 INTEGER,   -- NULL when not exposed; see 0130 note on keeper inference
  num_keepers                  INTEGER,
  uses_divisions               INTEGER,
  num_divisions                INTEGER,

  -- provenance
  raw_settings_json            TEXT,      -- full provider settings object, verbatim
  unmapped_fields              TEXT,      -- JSON array of field paths seen but not mapped
  source_run_id                TEXT,
  fetched_at_utc               TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc               TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_league_settings_season
  ON fantasy_league_settings(platform, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_scoring_rules — one row per scoring stat per league-season.
--
-- `modifier` is the points-per-unit value. It is REAL and nullable: NULL means
-- the stat is tracked/displayed but carries no scoring value, which is a
-- different claim from a modifier of 0.0 (scored, worth nothing). Collapsing
-- those two would make "does this league score first downs" unanswerable.
--
-- position_type / applies_to_positions capture position-specific scoring, which
-- is the whole reason a generic points model cannot be assumed.
CREATE TABLE IF NOT EXISTS fantasy_scoring_rules (
  platform              TEXT    NOT NULL,
  league_key            TEXT    NOT NULL,
  season                INTEGER NOT NULL,
  stat_id               TEXT    NOT NULL,   -- the platform's own numeric id, as TEXT
  stat_name             TEXT,
  stat_display_name     TEXT,
  stat_abbr             TEXT,
  stat_group            TEXT,               -- provider grouping, verbatim
  position_type         TEXT,               -- 'O'|'K'|'DT'|'DP' etc., verbatim
  applies_to_positions  TEXT,               -- JSON array of positions, or NULL for all
  modifier              REAL,               -- points per unit; NULL = not scored
  is_enabled            INTEGER,
  is_display_only       INTEGER,            -- tracked for display, never scored
  sort_order            INTEGER,
  raw_stat_json         TEXT,
  source_run_id         TEXT,
  updated_at_utc        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, stat_id)
);

-- "Give me this league-season's whole scoring table" — every points calc starts here.
CREATE INDEX IF NOT EXISTS idx_fantasy_scoring_rules_lookup
  ON fantasy_scoring_rules(platform, league_key, season, is_enabled);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_scoring_bonuses — threshold bonuses, kept separate from linear scoring.
--
-- A bonus is not a modifier: it fires once when a stat crosses a target
-- (e.g. +3 at 100 rushing yards) rather than accruing per unit. Modelling it as
-- a scoring rule would make every points reconstruction wrong at the threshold.
CREATE TABLE IF NOT EXISTS fantasy_scoring_bonuses (
  platform        TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  bonus_id        TEXT    NOT NULL,   -- provider id, or a deterministic '<stat_id>:<target>' when it has none
  stat_id         TEXT,
  stat_name       TEXT,
  target_value    REAL,               -- the threshold that must be reached
  bonus_points    REAL,
  position_type   TEXT,
  raw_bonus_json  TEXT,
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, bonus_id)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_scoring_bonuses_lookup
  ON fantasy_scoring_bonuses(platform, league_key, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_roster_positions — the starting-lineup requirement, per season.
--
-- WHY THIS IS LOAD-BEARING. Yahoo has NO `is_started` field — starter status is
-- derived from whether a player's selected lineup slot is a bench-like slot, and
-- the set of bench-like slots is LEAGUE-DEFINED (BN, IR, IR+, IR-R, NA, and
-- whatever else a commissioner configures). Hardcoding {'BN','IR'} would
-- silently count IR+ players as starters. `is_starting_slot` is computed once
-- here, from this league's own slot list, and every starter/bench query reads it
-- rather than pattern-matching a position string.
CREATE TABLE IF NOT EXISTS fantasy_roster_positions (
  platform          TEXT    NOT NULL,
  league_key        TEXT    NOT NULL,
  season            INTEGER NOT NULL,
  position          TEXT    NOT NULL,   -- 'QB','RB','W/R/T','BN','IR' — verbatim
  position_type     TEXT,               -- 'O'|'K'|'DT'|'DP' etc.
  slot_count        INTEGER NOT NULL,
  is_starting_slot  INTEGER NOT NULL,   -- 1 = counts toward the active lineup
  is_bench_slot     INTEGER NOT NULL DEFAULT 0,
  is_injury_slot    INTEGER NOT NULL DEFAULT 0,
  is_flex_slot      INTEGER NOT NULL DEFAULT 0,
  flex_positions    TEXT,               -- JSON array of eligible positions for a flex slot
  sort_order        INTEGER,
  raw_position_json TEXT,
  source_run_id     TEXT,
  updated_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, position)
);

-- The lineup-requirement lookup used by optimal-lineup and bench-points math.
CREATE INDEX IF NOT EXISTS idx_fantasy_roster_positions_lookup
  ON fantasy_roster_positions(platform, league_key, season, is_starting_slot);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_divisions — present only in divisioned leagues.
--
-- Absence of rows here means "this league-season had no divisions", which is
-- recorded as not_applicable in fantasy_data_completeness rather than as a gap.
CREATE TABLE IF NOT EXISTS fantasy_divisions (
  platform        TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  division_id     TEXT    NOT NULL,
  division_name   TEXT,
  raw_division_json TEXT,
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, division_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_schedule_periods — one row per scoring week.
--
-- WHY NOT JUST ASSUME 17. Season length changed (the NFL moved to 18 weeks in
-- 2021), playoff start weeks vary by league-season, and a backfill loop bounded
-- by a hardcoded constant would silently skip real weeks in some seasons and
-- request non-existent ones in others. The week list comes from the provider's
-- own game-weeks resource plus the league's start_week/end_week, so the loop is
-- bounded by data instead of by assumption.
--
-- is_playoff / is_consolation are what keep playoff results out of
-- regular-season records when standings are reconstructed.
CREATE TABLE IF NOT EXISTS fantasy_schedule_periods (
  platform        TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  week_start      TEXT,               -- 'YYYY-MM-DD' as given
  week_end        TEXT,
  is_playoff      INTEGER NOT NULL DEFAULT 0,
  is_consolation  INTEGER NOT NULL DEFAULT 0,
  is_championship INTEGER NOT NULL DEFAULT 0,
  status          TEXT,               -- 'preevent'|'midevent'|'postevent', verbatim
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, week)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_schedule_periods_lookup
  ON fantasy_schedule_periods(platform, league_key, season, week);
