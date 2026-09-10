-- 0129_fantasy_teams_managers_players.sql
-- Multi-platform fantasy ingestion: teams, managers, per-season team state,
-- and the player universe. Third of six (0127-0132). Apply AFTER 0128.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- THE CROSS-SEASON IDENTITY PROBLEM, TWICE OVER.
--
-- Managers: team names and manager nicknames change every single season, and
-- Yahoo returns other managers' nicknames as the literal string '--hidden--'
-- unless they made it public. What IS stable is the provider's account GUID.
-- Owners are therefore joined on manager_uid (the GUID), never on a display
-- name, or "who won the most titles" silently becomes "who kept the same team
-- name the longest".
--
-- Players: a Yahoo player_key is SEASON-SCOPED — the same player is
-- '390.p.30121' in 2019 and '461.p.30121' in 2025, because the game_key is
-- embedded. Every player payload also carries editorial_player_key
-- ('nfl.p.30121'), which is season-independent and is the actual contract. The
-- numeric tail happens to be equal across seasons today, but that is a property
-- of Yahoo's numbering, not a documented guarantee. player_uid holds the
-- season-independent key; the season-scoped keys are preserved in
-- fantasy_player_identifiers so nothing is lost.
--
-- ⚠️ PRIVACY. Manager email addresses are NOT stored, even though the provider
-- returns them for the authenticating user's own record. Nothing here needs
-- them and storing them would put personal data in an hourly R2 snapshot.

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_teams — one row per team per league-season.
--
-- team_key already encodes platform+game+league+team, so it alone is unique;
-- league_key and season are carried as columns because every analytical query
-- filters on them and a LIKE against a composite string is not an index.
--
-- name_history holds the team names seen across the season as a JSON array —
-- Yahoo exposes only the CURRENT name, so a rename mid-season is otherwise
-- invisible. The array is appended to, never replaced.
CREATE TABLE IF NOT EXISTS fantasy_teams (
  platform          TEXT    NOT NULL,
  team_key          TEXT    NOT NULL,   -- '{game_key}.l.{league_id}.t.{team_id}'
  league_key        TEXT    NOT NULL,
  season            INTEGER NOT NULL,
  team_id           TEXT    NOT NULL,   -- the within-league team number, as TEXT
  team_name         TEXT,
  team_url          TEXT,
  logo_url          TEXT,
  division_id       TEXT,
  is_owned_by_current_login INTEGER,    -- 1 = this is the authenticating user's team
  name_history      TEXT,               -- JSON array of every team_name observed
  raw_team_json     TEXT,
  unmapped_fields   TEXT,
  source_run_id     TEXT,
  first_seen_at_utc TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, team_key)
);

-- Every team in a league-season — the join every roster/matchup query makes.
CREATE INDEX IF NOT EXISTS idx_fantasy_teams_league_season
  ON fantasy_teams(platform, league_key, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_managers — one row per human, across every league and season.
--
-- manager_uid is the provider's stable account GUID. display_name is the most
-- recently observed nickname and is presentation only — it is explicitly NOT a
-- key, because '--hidden--' is a legal value the provider returns for managers
-- who have not made their nickname public, and several distinct managers can
-- carry it simultaneously.
CREATE TABLE IF NOT EXISTS fantasy_managers (
  platform          TEXT    NOT NULL,
  manager_uid       TEXT    NOT NULL,   -- provider account GUID; stable across seasons
  display_name      TEXT,               -- latest nickname; may legitimately be '--hidden--'
  name_history      TEXT,               -- JSON array of observed nicknames
  image_url         TEXT,
  first_season      INTEGER,
  last_season       INTEGER,
  raw_manager_json  TEXT,
  source_run_id     TEXT,
  created_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, manager_uid)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_team_managers — which humans ran which team, in which season.
--
-- A join table rather than a manager_uid column on fantasy_teams, because
-- co-managers exist: a team can legitimately have two managers at once, and
-- flattening that would silently drop one of them.
CREATE TABLE IF NOT EXISTS fantasy_team_managers (
  platform        TEXT    NOT NULL,
  team_key        TEXT    NOT NULL,
  manager_uid     TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  nickname_at_time TEXT,               -- what they were called THAT season
  is_commissioner INTEGER NOT NULL DEFAULT 0,
  is_comanager    INTEGER NOT NULL DEFAULT 0,
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, team_key, manager_uid)
);

-- "Every team this manager has ever run" — the manager-career access path.
CREATE INDEX IF NOT EXISTS idx_fantasy_team_managers_manager
  ON fantasy_team_managers(platform, manager_uid, season);

CREATE INDEX IF NOT EXISTS idx_fantasy_team_managers_league
  ON fantasy_team_managers(platform, league_key, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_team_season_state — the mutable per-team counters.
--
-- Separated from fantasy_teams because these values CHANGE during a season
-- while the team's identity does not. Captured on every sync, so the row
-- reflects the most recent observation and captured_at_utc says when.
--
-- ⚠️ faab_balance is nullable and stays NULL when the provider does not expose
-- it. Yahoo documents faab_bid only as a WRITE input; whether a remaining-budget
-- field comes back on a GET is unverified. A NULL here means "not exposed",
-- never "zero left" — the difference matters enormously for waiver analysis.
--
-- waiver_priority is likewise a point-in-time value: the provider exposes only
-- the CURRENT priority, never its history, so priority-over-time can only be
-- inferred from the transaction sequence and must be labelled inferred.
CREATE TABLE IF NOT EXISTS fantasy_team_season_state (
  platform            TEXT    NOT NULL,
  team_key            TEXT    NOT NULL,
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  waiver_priority     INTEGER,          -- current only; history is not exposed
  faab_balance        INTEGER,          -- NULL = not exposed, NOT zero
  number_of_moves     INTEGER,
  number_of_trades    INTEGER,
  roster_adds_week    INTEGER,
  roster_adds_value   INTEGER,
  draft_position      INTEGER,
  draft_grade         TEXT,             -- provider letter grade, e.g. 'B-'
  has_draft_grade     INTEGER,
  draft_recap_url     TEXT,
  clinched_playoffs   INTEGER,
  captured_at_utc     TEXT    NOT NULL DEFAULT (datetime('now')),
  source_run_id       TEXT,
  PRIMARY KEY (platform, team_key)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_team_season_state_league
  ON fantasy_team_season_state(platform, league_key, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_players — the player universe, keyed season-independently.
--
-- SCOPE: every player the pipeline has ever SEEN, not just current rosters —
-- drafted players, rostered players, players appearing in any transaction,
-- players on any historical weekly roster, and free agents/waiver players as
-- pagination allows. A draft pick whose player is missing from this table is a
-- data-quality failure, not an acceptable gap.
--
-- The season-varying facts (NFL team, bye week, position eligibility, injury
-- status) live in fantasy_player_eligibility and
-- fantasy_player_status_snapshots. What is here is the identity plus the most
-- recently observed descriptive values.
CREATE TABLE IF NOT EXISTS fantasy_players (
  platform              TEXT    NOT NULL,
  player_uid            TEXT    NOT NULL,   -- season-INDEPENDENT provider key, e.g. 'nfl.p.30121'
  provider_player_id    TEXT,               -- the bare numeric id, e.g. '30121'
  full_name             TEXT,
  first_name            TEXT,
  last_name             TEXT,
  ascii_first_name      TEXT,
  ascii_last_name       TEXT,
  normalized_name       TEXT,               -- lowercase, punctuation/suffix stripped; for FALLBACK matching only
  display_position      TEXT,               -- latest seen
  primary_position      TEXT,
  position_type         TEXT,               -- 'O'|'K'|'DT'|'DP' etc., verbatim
  uniform_number        TEXT,
  editorial_team_key    TEXT,               -- season-independent NFL team key
  editorial_team_abbr   TEXT,               -- latest seen
  editorial_team_full   TEXT,
  headshot_url          TEXT,
  image_url             TEXT,
  is_undroppable        INTEGER,
  first_season_seen     INTEGER,
  last_season_seen      INTEGER,
  raw_player_json       TEXT,
  unmapped_fields       TEXT,
  source_run_id         TEXT,
  created_at_utc        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, player_uid)
);

-- Name-based fallback resolution. NEVER sufficient alone — see 0132.
CREATE INDEX IF NOT EXISTS idx_fantasy_players_normalized_name
  ON fantasy_players(platform, normalized_name, display_position);

CREATE INDEX IF NOT EXISTS idx_fantasy_players_provider_id
  ON fantasy_players(platform, provider_player_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_identifiers — every id this player has carried, incl. per-season keys.
--
-- WHY A TALL TABLE. The set of identifier kinds is open-ended and differs by
-- platform: Yahoo has a season-scoped player_key per game, CBS and ESPN will
-- have their own, and external systems (GSIS, PFR, MFL, Sleeper) add more. A
-- column per id kind would need a migration every time one appears; a tall
-- table needs none, and platform='cbs' rows slot in with no schema change.
--
-- id_scope carries the season for season-scoped identifiers ('2025') and is the
-- empty string for season-independent ones. It is part of the key so the 2019
-- and 2025 player_keys for one player coexist rather than overwriting.
CREATE TABLE IF NOT EXISTS fantasy_player_identifiers (
  platform        TEXT    NOT NULL,
  player_uid      TEXT    NOT NULL,
  id_type         TEXT    NOT NULL,   -- 'player_key'|'player_id'|'gsis_id'|'mfl_id'|'pfr_id'|...
  id_scope        TEXT    NOT NULL DEFAULT '',  -- season as TEXT for season-scoped ids, else ''
  id_value        TEXT    NOT NULL,
  id_source       TEXT,               -- who asserted it: 'yahoo_api'|'ff_player_ids'|'manual'
  confidence      TEXT,               -- 'exact'|'fuzzy_auto'|'fuzzy_review'|'manual'|'unmapped'
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, player_uid, id_type, id_scope)
);

-- Reverse lookup: "which player is provider id X in season Y".
CREATE INDEX IF NOT EXISTS idx_fantasy_player_identifiers_value
  ON fantasy_player_identifiers(id_type, id_value);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_eligibility — which slots a player could fill, per season.
--
-- Season-scoped because eligibility genuinely changes: a player gains TE
-- eligibility, a RB picks up WR eligibility, and a league's flex rules interact
-- with it. Optimal-lineup reconstruction is wrong without the eligibility that
-- applied THAT season, so it is stored per season rather than latest-wins.
CREATE TABLE IF NOT EXISTS fantasy_player_eligibility (
  platform        TEXT    NOT NULL,
  player_uid      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  position        TEXT    NOT NULL,
  source_run_id   TEXT,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, player_uid, season, position)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_player_eligibility_season
  ON fantasy_player_eligibility(platform, season, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_status_snapshots — injury/status/ownership as observed.
--
-- Append-shaped but keyed so a re-sync of the same week is idempotent. Keyed by
-- league because ownership_type ('team'|'waivers'|'freeagents') is a
-- league-relative fact — the same player is rostered in one league and a free
-- agent in another.
--
-- week is NOT NULL and uses 0 for a preseason/undated observation, so the
-- primary key stays total. percent_owned is provider-wide, not league-relative.
CREATE TABLE IF NOT EXISTS fantasy_player_status_snapshots (
  platform          TEXT    NOT NULL,
  league_key        TEXT    NOT NULL,
  season            INTEGER NOT NULL,
  week              INTEGER NOT NULL,   -- 0 = undated/preseason observation
  player_uid        TEXT    NOT NULL,
  injury_status     TEXT,               -- verbatim provider vocabulary
  injury_note       TEXT,
  nfl_team_abbr     TEXT,               -- as of this observation
  bye_week          INTEGER,
  ownership_type    TEXT,               -- 'team'|'waivers'|'freeagents', verbatim
  owner_team_key    TEXT,
  waiver_date       TEXT,
  percent_owned     REAL,               -- provider-wide ownership %, NULL when not exposed
  percent_owned_delta REAL,
  observed_at_utc   TEXT    NOT NULL DEFAULT (datetime('now')),
  source_run_id     TEXT,
  PRIMARY KEY (platform, league_key, season, week, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_player_status_player
  ON fantasy_player_status_snapshots(platform, player_uid, season, week);

CREATE INDEX IF NOT EXISTS idx_fantasy_player_status_ownership
  ON fantasy_player_status_snapshots(platform, league_key, season, week, ownership_type);
