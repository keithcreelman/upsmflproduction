# Fantasy Football Ingestion Schema — export for external review

Generated 2026-08-12 from the live migrations in this repo. Everything below the
horizontal rule is the **verbatim contents** of the actual `.sql` migration
files that define and document this schema — nothing has been paraphrased or
retyped, so it is safe to treat as ground truth. Table/column comments in the
SQL explain *why* each design choice was made, not just what the column is.

## What this is

A read-only ingestion pipeline that pulls fantasy football league data (teams,
rosters, matchups, scoring, drafts, transactions, standings) from third-party
fantasy platforms into a **platform-neutral** D1 (SQLite) schema, so the same
tables and analytical views work no matter which platform a league lives on.

- Every table's primary key starts with a `platform TEXT` discriminator
  (`'yahoo'`, `'espn'`, and — not yet built — `'cbs'`). Adding a new platform
  requires zero schema changes; this was proven empirically when the ESPN
  adapter was built entirely on top of the schema Yahoo's adapter had already
  landed.
- Ingestion is done by a `FantasyProvider` interface (14 methods:
  `discoverLeagues`, `fetchLeagueMetadata`, `fetchLeagueSettings`,
  `fetchTeams`, `fetchManagers`, `fetchDraftResults`, `fetchTransactions`,
  `fetchStandings`, `fetchScoreboard`, `fetchRosters`, `fetchPlayerStats`,
  `fetchPlayers`, `syncSeason`, `backfillSeason`) implemented once per
  platform in Python (`pipelines/fantasy/providers/<platform>/`).
- A raw-payload preservation layer (`raw_yahoo_api_responses`) exists so the
  original provider JSON survives even if a parser bug is later found — this
  is Yahoo-only in the current pass; ESPN does not yet have an equivalent
  archival layer.
- A `fantasy_player_crosswalk` table (plus a `yahoo_id` column added to the
  pre-existing NFL player-identity table `ff_player_ids`) links platform
  player IDs back to this repo's own NFL player identities.
- 11 read-only analytical SQL views sit on top of the base tables (draft
  value, roster construction, bench points, waiver value, trade ledger,
  all-play record, etc.) so downstream consumers don't have to re-derive
  things like "which points number to use when the provider's and our own
  disagree" or "starter status is a derived flag, not a string compare on the
  roster slot."

## Current data population state (as of 2026-08-12)

| Platform | League | Seasons loaded | Status |
|---|---|---|---|
| ESPN | league `176898` ("15th Annual Pigskin Classic") | 2025 (full: 17/17 weeks, all matchups + roster snapshots) | Live in production D1 |
| ESPN | league `176898` | 2023, 2024 | Blocked — same league ID returns HTTP 401 for those seasons even though 2025 and the stored cookies both work; ESPN league IDs can change across a league's history, so this is most likely the wrong ID for those years, not an auth problem |
| Yahoo | league `576919` | none | Pipeline fully built and tested; blocked on Yahoo's OAuth app-access approval (application submitted, pending) |
| CBS | — | none | Not built yet — the adapter interface was designed with CBS in mind but no CBS provider exists |

Scope note: the ESPN adapter is an intentionally **lighter pass** than Yahoo's
— it covers league/team/manager metadata, standings, and weekly
rosters+matchups+points, but does **not** yet cover ESPN drafts,
transactions, or full player-universe pagination (those exist for Yahoo).

## Migration files included below, in apply order

1. `0127_fantasy_control_and_raw.sql` — run/audit/error tracking, league
   discovery ledger, raw Yahoo payload archive, OAuth token storage
2. `0128_fantasy_leagues_and_settings.sql` — league identity, settings,
   scoring rules, roster position config, divisions, schedule periods
3. `0129_fantasy_teams_managers_players.sql` — teams, managers, player
   identity/eligibility/status
4. `0130_fantasy_drafts_and_transactions.sql` — draft results, transactions
   (trades/waivers/free-agency), waiver-priority/FAAB state
5. `0131_fantasy_rosters_and_scoring.sql` — weekly roster snapshots, player
   stats/points, team week scores, matchups, standings snapshots
6. `0132_fantasy_player_crosswalk.sql` — links to this repo's own NFL player
   identity table
7. `manual/2026-08-11_fantasy_analytical_views.sql` — 11 read-only views over
   all of the above

---


## `worker/migrations/0127_fantasy_control_and_raw.sql`

```sql
-- 0127_fantasy_control_and_raw.sql
-- Multi-platform fantasy ingestion: control plane, provenance, raw payload
-- index, and OAuth token storage. First of six (0127-0132).
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- ⚠️ UNAPPLIED as of writing. Apply 0127→0132 in order; each is additive-only
--    and every statement is IF NOT EXISTS, so re-running is a safe no-op.
--
-- WHY A NEW PREFIX. The existing prefixes are all single-provider by
-- construction: `src_` = a verbatim mirror of an MFL export, `ups_` = league
-- state MFL cannot model, `nfl_` = external NFL stats, `model_` = derived
-- features. None of them can hold a second fantasy PLATFORM without lying about
-- what the prefix means. `fantasy_` is the platform-neutral canonical model:
-- one row shape that Yahoo, CBS and ESPN all normalize INTO. `raw_yahoo_` is
-- the verbatim provider payload index, and stays provider-specific on purpose
-- because raw payload shapes are not portable.
--
-- ⚠️ SEPARATION IS THE POINT. Nothing in the fantasy_* family may read or write
-- ups_* / src_* / mfl_* / nfl_* rows. The UPS league lives on MyFantasyLeague
-- and its contract and cap ledgers are authoritative; this family is a second,
-- unrelated league on a second platform that happens to share a database. The
-- only sanctioned crossing point is the read-only NFL player-identity crosswalk
-- in 0132, and it resolves identity ONLY — never scoring, never contracts.
--
-- PLATFORM IS IN EVERY PRIMARY KEY. `platform` is the first column of every
-- composite key in this family, not a tag bolted on afterwards, so adding
-- platform='cbs' or platform='espn' later needs no schema change and cannot
-- collide with platform='yahoo' rows. Values are lowercase and closed:
-- 'yahoo' | 'cbs' | 'espn'.
--
-- SEASON IS INTEGER, DELIBERATELY. The ups_* family is split — TEXT in
-- ups_extension_submissions et al., INTEGER in ups_player_projections — and a
-- silent TEXT/INTEGER mismatch in SQLite returns ZERO ROWS with no error. That
-- exact failure already bit the cross-season contract_status joins. This family
-- commits to INTEGER everywhere and casts at every boundary.
--
-- NO FOREIGN KEYS. Only 8 REFERENCES clauses exist across all 126 prior
-- migrations, all in the discord/hall cluster, and D1 does not enforce FKs by
-- default anyway. Joining by convention on (platform, league_key, season, ...)
-- matches the other 98 tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_sync_runs — one row per invocation of backfill / sync / discovery.
--
-- This is the run ledger the whole pipeline reports into. It is NOT etl_runs:
-- etl_runs holds exactly one overwritten row per source ("when did this last
-- run"), which cannot answer "what did the 2019 backfill actually do". Both get
-- written — etl_runs so GET /api/data-freshness keeps working unchanged, this
-- table so a run is auditable after the fact.
--
-- rows_unchanged is tracked separately from rows_updated because an UPSERT that
-- rewrites a row with identical values is not evidence the sync worked; a run
-- that reports 4,000 unchanged and 0 inserted on a fresh season is a red flag,
-- not a success.
CREATE TABLE IF NOT EXISTS fantasy_sync_runs (
  run_id              TEXT    NOT NULL PRIMARY KEY,  -- caller-generated, unique per invocation
  platform            TEXT    NOT NULL,
  mode                TEXT    NOT NULL,              -- 'discover' | 'backfill' | 'sync' | 'auth' | 'quality'
  league_key          TEXT,                          -- NULL for discovery runs (no league yet)
  season              INTEGER,                       -- NULL when the run spans seasons
  week                INTEGER,                       -- NULL when the run spans weeks
  requested_scope     TEXT,                          -- JSON: the exact arguments the run was asked for
  started_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at_utc     TEXT,                          -- NULL while running; NULL after a crash, which is itself the signal
  status              TEXT    NOT NULL DEFAULT 'running',  -- 'running'|'ok'|'partial'|'failed'
  rows_inserted       INTEGER NOT NULL DEFAULT 0,
  rows_updated        INTEGER NOT NULL DEFAULT 0,
  rows_unchanged      INTEGER NOT NULL DEFAULT 0,
  api_calls           INTEGER NOT NULL DEFAULT 0,
  api_retries         INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  completeness_status TEXT,                          -- rollup of fantasy_data_completeness for this run's scope
  parser_version      TEXT    NOT NULL,              -- so a reparse can find every row a given parser wrote
  runner_host         TEXT,                          -- 'github-actions' | local hostname
  notes               TEXT
);

-- "What has this league done lately", newest first — the run-history view.
CREATE INDEX IF NOT EXISTS idx_fantasy_sync_runs_league
  ON fantasy_sync_runs(platform, league_key, started_at_utc DESC);

-- "Show me every failed or half-finished run" — the operational alarm query.
CREATE INDEX IF NOT EXISTS idx_fantasy_sync_runs_status
  ON fantasy_sync_runs(status, started_at_utc DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_data_completeness — one row per (league-season, resource).
--
-- The classification vocabulary is closed and each value means something
-- different that a human would otherwise have to guess at:
--   complete       — the platform exposes it and we captured all of it
--   partial        — the platform exposes it and we captured some of it
--   not_exposed    — the API does not offer this; the website may show it
--   access_denied  — the API offers it but this token cannot see it
--   not_applicable — the concept does not exist for this league (e.g. FAAB in a
--                    waiver-priority league); NOT the same as missing
--   failed         — we tried, the attempt errored, and it is retryable
--   inferred       — the value was RECONSTRUCTED by us, not read from the API
--
-- `inferred` earns its place: Yahoo exposes exactly one standings state per
-- league (final for a closed season, current for a live one) and has no
-- standings;week=N. Weekly standings therefore have to be accumulated from the
-- scoreboard, and a reconstructed rank must never be presented as a source
-- value. Never fabricate — an unavailable field stays NULL and lands here as
-- not_exposed.
CREATE TABLE IF NOT EXISTS fantasy_data_completeness (
  platform        TEXT    NOT NULL,
  league_key      TEXT    NOT NULL,
  season          INTEGER NOT NULL,
  resource        TEXT    NOT NULL,   -- 'settings'|'teams'|'draft'|'transactions'|'rosters'|'matchups'|'standings'|'players'|'player_week_stats'|'player_week_points'
  status          TEXT    NOT NULL,   -- see vocabulary above
  expected_units  INTEGER,            -- e.g. weeks expected for a weekly resource
  observed_units  INTEGER,            -- e.g. weeks actually captured
  row_count       INTEGER,
  first_week      INTEGER,
  last_week       INTEGER,
  is_inferred     INTEGER NOT NULL DEFAULT 0,  -- 1 = values were reconstructed, not read
  missing_notes   TEXT,               -- prose: WHAT is missing and WHY
  last_run_id     TEXT,
  checked_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, resource)
);

-- The completeness report's own access path: one league, every season+resource.
CREATE INDEX IF NOT EXISTS idx_fantasy_data_completeness_league
  ON fantasy_data_completeness(platform, league_key, season);

-- "Everything that is not complete" — drives the gap list.
CREATE INDEX IF NOT EXISTS idx_fantasy_data_completeness_status
  ON fantasy_data_completeness(status, platform, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_api_errors — append-only error ledger.
--
-- WHY THIS IS A TABLE AND NOT A LOG LINE. Yahoo's throttle manifests as HTTP
-- 999 with a non-XML, non-JSON body (an HTML 'Request denied' page). A client
-- that parses before checking status turns that into a parse exception, and a
-- client that catches broadly turns it into an empty collection — which would
-- silently write "this league had no transactions in 2021". Every non-2xx and
-- every unparseable body lands here as evidence, and the run is marked partial
-- or failed. An unreadable response is never an empty one.
--
-- `message` is REDACTED before insert. Access tokens, refresh tokens,
-- authorization codes and the client secret must never reach this table.
CREATE TABLE IF NOT EXISTS fantasy_api_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  platform        TEXT    NOT NULL,
  resource        TEXT,
  endpoint_path   TEXT,               -- redacted: query-string secrets stripped
  league_key      TEXT,
  season          INTEGER,
  week            INTEGER,
  http_status     INTEGER,            -- NULL for transport-level failures
  error_kind      TEXT    NOT NULL,   -- 'rate_limited'|'auth'|'not_found'|'unparseable'|'transport'|'server'|'unknown'
  attempt         INTEGER NOT NULL DEFAULT 1,
  is_retryable    INTEGER NOT NULL DEFAULT 0,
  message         TEXT,               -- REDACTED; never carries token material
  occurred_at_utc TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fantasy_api_errors_run
  ON fantasy_api_errors(run_id, occurred_at_utc);

-- "Are we being throttled right now" — the backoff decision query.
CREATE INDEX IF NOT EXISTS idx_fantasy_api_errors_kind
  ON fantasy_api_errors(platform, error_kind, occurred_at_utc DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_league_seasons — the league registry AND the manual-override table.
--
-- WHY THE NUMERIC LEAGUE ID IS NOT ENOUGH. A Yahoo league key is
-- {game_key}.l.{league_id} — '461.l.576919' — and the game_key changes EVERY
-- SEASON (2019=390, 2020=399, 2025=461). The same league in a different season
-- is a different key. Worse: if you send the season-independent code form
-- ('nfl.l.576919') Yahoo silently rewrites it to the numeric game_id in every
-- key it returns, so keying off the code form produces phantom duplicates.
-- Everything here stores the CANONICAL numeric game_id form.
--
-- WHY IT IS ALSO A CONFIG TABLE. Yahoo's own linkage between seasons can be
-- incomplete — the login-user chain only reaches seasons that account played,
-- and private leagues are readable only by members. When automatic discovery
-- cannot connect a historical season to this league, a row is INSERTed here by
-- hand with discovery_source='manual' and the backfill picks it up unchanged.
-- That is the documented path for adding league keys later.
--
-- renew_key / renewed_key hold Yahoo's own cross-season links, canonicalized
-- from its native '{game_id}_{league_id}' form to full league-key form. Walking
-- renew_key backwards chains a league across seasons and catches seasons the
-- user-login query misses.
CREATE TABLE IF NOT EXISTS fantasy_league_seasons (
  platform          TEXT    NOT NULL,
  league_key        TEXT    NOT NULL,   -- canonical: '{numeric_game_id}.l.{league_id}'
  league_uid        TEXT,               -- groups this season with the same league's other seasons (see fantasy_leagues, 0128)
  season            INTEGER NOT NULL,
  game_key          TEXT    NOT NULL,   -- numeric game_id as TEXT, e.g. '461'
  game_code         TEXT,               -- 'nfl' — season-independent, never a key
  league_id         TEXT    NOT NULL,   -- '576919'
  league_name       TEXT,
  league_url        TEXT,
  num_teams         INTEGER,
  draft_type        TEXT,               -- 'live'|'offline'|'auction'... platform vocabulary, VERBATIM
  is_auction_draft  INTEGER,            -- 1/0/NULL — NULL means the platform did not say
  scoring_type      TEXT,               -- 'head'|'point'... VERBATIM
  league_type       TEXT,               -- 'private'|'public'
  start_week        INTEGER,
  end_week          INTEGER,
  current_week      INTEGER,
  renew_key         TEXT,               -- previous season's league_key, canonicalized
  renewed_key       TEXT,               -- next season's league_key, canonicalized
  my_team_key       TEXT,               -- the authenticating user's team in this league-season
  discovery_source  TEXT    NOT NULL,   -- 'users_games_leagues'|'renew_chain'|'manual'|'seed'
  is_accessible     INTEGER,            -- 1 = this token can read it; 0 = access denied; NULL = untested
  backfill_status   TEXT    NOT NULL DEFAULT 'pending',  -- 'pending'|'in_progress'|'complete'|'partial'|'failed'|'inaccessible'
  notes             TEXT,
  added_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key)
);

-- The season-discovery report's ordering.
CREATE INDEX IF NOT EXISTS idx_fantasy_league_seasons_season
  ON fantasy_league_seasons(platform, season);

-- "Which league-seasons still need backfilling" — the work queue.
CREATE INDEX IF NOT EXISTS idx_fantasy_league_seasons_backfill
  ON fantasy_league_seasons(backfill_status, platform, season);

-- Walking the renewal chain backwards from the current season.
CREATE INDEX IF NOT EXISTS idx_fantasy_league_seasons_renew
  ON fantasy_league_seasons(platform, renew_key);

-- "Every season of this one league" — the cross-season continuity access path.
CREATE INDEX IF NOT EXISTS idx_fantasy_league_seasons_uid
  ON fantasy_league_seasons(platform, league_uid, season);

-- ─────────────────────────────────────────────────────────────────────────────
-- raw_yahoo_api_responses — the verbatim payload INDEX.
--
-- WHY IT EXISTS. Every parser improvement otherwise means re-requesting fifteen
-- seasons from a rate-limited API that answers throttling with HTTP 999. The
-- raw layer makes a reparse a local operation.
--
-- WHY THE PAYLOAD IS OFTEN NOT IN THIS TABLE. D1 caps a single SQL statement at
-- ~100KB and escaping roughly doubles a wide statement — a build already died
-- here with 'statement too long: SQLITE_TOOBIG' and landed ZERO rows. A single
-- week of all-team rosters with stats is comfortably past that, and a full
-- backfill is ~180MB. So the payload goes to a SINK and this row is the index:
--   payload_sink='d1'   → payload column holds it inline (small responses only)
--   payload_sink='r2'   → payload_ref is the R2 key in the existing bucket
--   payload_sink='file' → payload_ref is a path under the local raw archive
--   payload_sink='none' → retention pruned the body; the index row survives
-- The index row is ALWAYS written regardless of sink, so provenance never
-- depends on the payload still being around.
--
-- IDEMPOTENCY. UNIQUE(request_key, response_hash): re-fetching a resource whose
-- content has not changed is a no-op, while a genuinely changed response
-- creates a new row and the history is preserved. request_key is
-- sha256(resource || canonicalized params) so it is stable across runs.
--
-- unmapped_fields is NOT decoration. Yahoo adds fields without notice and a
-- parser that silently drops them looks identical to one that handled them.
-- The parser records every field path it SAW but did not map, so an unexpected
-- new field surfaces as data instead of vanishing.
CREATE TABLE IF NOT EXISTS raw_yahoo_api_responses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT    NOT NULL DEFAULT 'yahoo',
  request_key     TEXT    NOT NULL,   -- sha256(resource || canonical params); stable across runs
  resource        TEXT    NOT NULL,   -- logical name, e.g. 'league.settings', 'team.roster'
  endpoint_path   TEXT    NOT NULL,   -- the request URI, secrets stripped
  request_params  TEXT,               -- JSON, canonicalized (sorted keys)
  league_key      TEXT,
  team_key        TEXT,
  player_key      TEXT,
  season          INTEGER,
  week            INTEGER,
  retrieved_at_utc TEXT   NOT NULL DEFAULT (datetime('now')),
  http_status     INTEGER NOT NULL,
  content_type    TEXT,
  payload         TEXT,               -- inline body, small responses only; NULL otherwise
  payload_bytes   INTEGER NOT NULL,
  payload_sink    TEXT    NOT NULL,   -- 'd1'|'r2'|'file'|'none'
  payload_ref     TEXT,               -- R2 key or archive path when not inline
  response_hash   TEXT    NOT NULL,   -- sha256 hex of the raw body
  parser_version  TEXT    NOT NULL,
  unmapped_fields TEXT,               -- JSON array of field paths seen but not mapped
  run_id          TEXT
);

-- The idempotency contract: same request + same content = one row, forever.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raw_yahoo_request_hash
  ON raw_yahoo_api_responses(request_key, response_hash);

-- "Give me every payload for this league-season" — the reparse access path.
CREATE INDEX IF NOT EXISTS idx_raw_yahoo_league_season
  ON raw_yahoo_api_responses(league_key, season, resource);

-- Retention sweeps and "what did this run fetch".
CREATE INDEX IF NOT EXISTS idx_raw_yahoo_retrieved
  ON raw_yahoo_api_responses(retrieved_at_utc);

CREATE INDEX IF NOT EXISTS idx_raw_yahoo_run
  ON raw_yahoo_api_responses(run_id);

-- "Which payloads has this parser version never touched" — reparse targeting.
CREATE INDEX IF NOT EXISTS idx_raw_yahoo_parser_version
  ON raw_yahoo_api_responses(parser_version, resource);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_oauth_tokens — encrypted refresh-token storage.
--
-- ⚠️ THIS IS THE ONLY TABLE IN THE DATABASE THAT HOLDS CREDENTIAL MATERIAL.
--
-- WHY IT IS IN D1 AT ALL. A Cloudflare Worker cannot rotate its own secrets —
-- there is no runtime `wrangler secret put` — and Yahoo may return a NEW refresh
-- token on any refresh, which the client must then persist or lose access
-- permanently. There is no KV binding in this project. D1 is therefore the only
-- durable store available, which makes encryption mandatory rather than nice:
-- the whole database is snapshotted to R2 hourly and is reachable from
-- commish-gated diagnostic paths.
--
-- WHAT IS STORED. refresh_token_ciphertext is AES-256-GCM, key held ONLY in the
-- YAHOO_TOKEN_ENCRYPTION_KEY Worker secret, never in this table and never in
-- git. token_iv is the per-record 96-bit nonce (base64). The ACCESS token is
-- deliberately NOT persisted — it lives one hour and is cheap to re-mint, so
-- storing it would add exposure for no benefit.
--
-- WHAT IS NEVER STORED, ANYWHERE: Yahoo passwords, verification/MFA codes,
-- browser cookies, or the account email address.
CREATE TABLE IF NOT EXISTS fantasy_oauth_tokens (
  platform                  TEXT    NOT NULL,
  account_key               TEXT    NOT NULL,   -- opaque local label, e.g. 'primary'; NOT an email
  refresh_token_ciphertext  TEXT    NOT NULL,   -- base64 AES-256-GCM ciphertext+tag
  token_iv                  TEXT    NOT NULL,   -- base64 96-bit nonce, unique per write
  key_version               INTEGER NOT NULL DEFAULT 1,  -- lets the encryption key rotate without a migration
  scope                     TEXT,               -- granted scope, e.g. 'fspt-r'
  yahoo_guid                TEXT,               -- stable account id; NOT an email
  obtained_at_utc           TEXT    NOT NULL DEFAULT (datetime('now')),
  last_refreshed_at_utc     TEXT,
  last_refresh_status       TEXT,               -- 'ok'|'invalid_grant'|'error' — surfaces a dead token before a sync fails
  refresh_failure_count     INTEGER NOT NULL DEFAULT 0,
  revoked_at_utc            TEXT,               -- set on invalid_grant; a revoked row is kept, not deleted
  PRIMARY KEY (platform, account_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_oauth_states — short-lived CSRF state for the authorization redirect.
--
-- Rows are single-use and expire. The callback REFUSES any state it cannot find
-- or that has already been consumed; it does not fall back to "no state
-- supplied, probably fine".
CREATE TABLE IF NOT EXISTS fantasy_oauth_states (
  state           TEXT    NOT NULL PRIMARY KEY,  -- 256 bits of CSPRNG, base64url
  platform        TEXT    NOT NULL,
  account_key     TEXT    NOT NULL,
  nonce           TEXT,
  redirect_uri    TEXT    NOT NULL,   -- echoed back at token exchange; Yahoo byte-matches it
  created_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at_unix INTEGER NOT NULL,
  consumed_at_utc TEXT                -- non-NULL = already used; replay is refused
);

-- Expiry sweep.
CREATE INDEX IF NOT EXISTS idx_fantasy_oauth_states_expiry
  ON fantasy_oauth_states(expires_at_unix);
```


## `worker/migrations/0128_fantasy_leagues_and_settings.sql`

```sql
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

-- Added by migration 0134 (2026-08-23), after CBS ingestion showed that a
-- bonus is not always a threshold. TWO SHAPES SHARE THIS TABLE:
--   open milestone : target_max NULL, is_stacking 1  (+3 at 100/200/300 yds,
--                    cumulative — 300 yards pays +9)
--   closed band    : target_max set,  is_stacking 0  (TD distance 10-39 /
--                    40-69 / 70-100 — exactly ONE fires)
-- ⚠️ Querying `target_value <= value` alone is WRONG for the second shape: a
-- 45-yard touchdown satisfies both the 10-39 row and the 40-69 row and collects
-- two bonuses. Filter on target_max too, or on is_stacking.
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN target_max REAL;    -- NULL = open-ended
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN is_stacking INTEGER; -- NULL = provider did not say
-- Needed because the SAME stat carries a different bonus scale by position:
-- a receiving TD is 1/3/5 for a WR and 2/6/10 for a running back.
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN applies_to_positions TEXT;

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
```


## `worker/migrations/0129_fantasy_teams_managers_players.sql`

```sql
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
```


## `worker/migrations/0130_fantasy_drafts_and_transactions.sql`

```sql
-- 0130_fantasy_drafts_and_transactions.sql
-- Multi-platform fantasy ingestion: drafts, draft events, transactions and
-- their asset legs. Fourth of six (0127-0132). Apply AFTER 0129.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- TWO RULES THIS FILE EXISTS TO ENFORCE.
--
-- (1) A NULL AUCTION PRICE IS NOT ZERO. In an auction league a $0 keeper is a
--     real, meaningful price; a missing price means the provider did not say.
--     Coercing NULL→0 makes "average auction spend by position" wrong in a way
--     nobody notices, and makes free keepers indistinguishable from unpriced
--     picks. auction_cost is nullable REAL and the ingester NEVER defaults it.
--     In a snake league the field is meaningless rather than zero, which is why
--     draft_kind is recorded on the parent draft row — read that first.
--
-- (2) A MULTI-ASSET TRANSACTION IS NOT ONE ROW. A three-player trade is one
--     transaction with six legs (three leaving each side); an add/drop is one
--     transaction with two. Collapsing either into a single player row destroys
--     the counterparty structure that every trade and waiver question depends
--     on. Parent lives in fantasy_transactions, legs in
--     fantasy_transaction_assets, and a parent with an implausible leg count is
--     a data-quality failure the validators look for.

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_drafts — one row per league-season draft.
--
-- draft_kind is derived ONCE here from the league settings ('auction' vs
-- 'snake'), so downstream code never has to re-derive whether auction_cost is
-- meaningful. is_price_bearing makes that explicit rather than implied.
CREATE TABLE IF NOT EXISTS fantasy_drafts (
  platform            TEXT    NOT NULL,
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  draft_kind          TEXT,               -- 'auction'|'snake'|'unknown'
  is_price_bearing    INTEGER NOT NULL DEFAULT 0,  -- 1 = auction_cost carries meaning
  draft_type          TEXT,               -- provider vocabulary, verbatim
  draft_status        TEXT,               -- 'predraft'|'drafted'|'postdraft'
  draft_time_unix     INTEGER,
  pick_time_sec       INTEGER,
  num_rounds          INTEGER,
  num_picks           INTEGER,            -- observed count, not an assumption
  has_keepers         INTEGER,            -- NULL when the provider does not expose keeper status
  raw_draft_json      TEXT,
  unmapped_fields     TEXT,
  source_run_id       TEXT,
  fetched_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_draft_events — one row per pick (or per nomination+winning bid).
--
-- KEY CHOICE. (platform, league_key, season, pick_number) is the natural key:
-- pick_number is unique within a draft in both snake and auction formats, and
-- keying on it makes re-ingesting a draft idempotent. A duplicate pick_number
-- is exactly the corruption the validators check for, so it must be the key
-- rather than a surrogate id that would hide it.
--
-- is_keeper IS USUALLY NULL AND THAT IS HONEST. There is no documented or
-- community-confirmed per-pick keeper flag in Yahoo's draftresults — the only
-- keeper surface is a players-collection filter showing who is CURRENTLY
-- designated, which is a point-in-time flag rather than a historical per-pick
-- attribute. Where keeper status is later inferred (player was on the roster at
-- the end of season N-1 AND was drafted at an anomalous round in season N), the
-- inference lands in keeper_inferred with keeper_inference_basis explaining it,
-- and is_keeper stays NULL. A derived value must never occupy the column that
-- means "the provider said so".
--
-- player_position_at_draft / nfl_team_at_draft are reconstructed from the
-- season's own player records where possible, because a player's position and
-- team today tell you nothing about a 2016 draft.
CREATE TABLE IF NOT EXISTS fantasy_draft_events (
  platform                TEXT    NOT NULL,
  league_key              TEXT    NOT NULL,
  season                  INTEGER NOT NULL,
  pick_number             INTEGER NOT NULL,   -- overall pick / nomination order
  round_number            INTEGER,
  pick_in_round           INTEGER,
  team_key                TEXT,
  player_uid              TEXT,               -- season-independent player key
  player_key_at_draft     TEXT,               -- the season-scoped key as returned
  provider_player_id      TEXT,
  auction_cost            REAL,               -- ⚠️ NULL = not stated. 0 = genuinely free. NEVER coerced.
  is_keeper               INTEGER,            -- provider-stated only; NULL when not exposed
  keeper_inferred         INTEGER,            -- 1 = WE inferred it; read with keeper_inference_basis
  keeper_inference_basis  TEXT,               -- prose explanation of the inference
  is_auto_pick            INTEGER,            -- NULL when not exposed
  picked_at_unix          INTEGER,            -- NULL when not exposed
  player_position_at_draft TEXT,
  nfl_team_at_draft       TEXT,
  raw_pick_json           TEXT,
  unmapped_fields         TEXT,
  source_run_id           TEXT,
  updated_at_utc          TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, league_key, season, pick_number)
);

-- "This team's whole draft" — draft-capital-by-team analysis.
CREATE INDEX IF NOT EXISTS idx_fantasy_draft_events_team
  ON fantasy_draft_events(platform, league_key, season, team_key);

-- "Every time this player was drafted, ever" — keeper and ROI history.
CREATE INDEX IF NOT EXISTS idx_fantasy_draft_events_player
  ON fantasy_draft_events(platform, player_uid, season);

-- Duplicate-pick detection reads this directly.
CREATE INDEX IF NOT EXISTS idx_fantasy_draft_events_round
  ON fantasy_draft_events(platform, league_key, season, round_number, pick_in_round);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_draft_player_metadata — pre-draft market context, per player-season.
--
-- This is the provider's PLATFORM-WIDE draft analysis (average pick, average
-- round, average cost, percent drafted) — it is NOT this league's ADP, and the
-- column names say so. It is captured because draft-price-vs-market is a real
-- question, but presenting it as league ADP would be wrong.
--
-- ⚠️ HISTORICITY IS UNVERIFIED. Whether querying a historical game key returns
-- that season's frozen values or today's is undocumented. captured_for_season
-- records which season we ASKED for and captured_at_utc when — so if it turns
-- out the provider serves current values for historical keys, the affected rows
-- are identifiable rather than silently wrong. Snapshot each preseason going
-- forward rather than assuming a backfill is possible.
CREATE TABLE IF NOT EXISTS fantasy_draft_player_metadata (
  platform              TEXT    NOT NULL,
  player_uid            TEXT    NOT NULL,
  captured_for_season   INTEGER NOT NULL,
  platform_average_pick REAL,
  platform_average_round REAL,
  platform_average_cost REAL,             -- platform-wide auction value, NOT league-specific
  platform_percent_drafted REAL,
  preseason_average_pick REAL,
  preseason_average_cost REAL,
  preseason_percent_drafted REAL,
  historicity_verified  INTEGER NOT NULL DEFAULT 0,  -- 0 = may be current-season values
  raw_analysis_json     TEXT,
  source_run_id         TEXT,
  captured_at_utc       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, player_uid, captured_for_season)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_transactions — the parent row.
--
-- transaction_key is the provider's own key and is unique per league; it comes
-- in several shapes (completed / waiver-claim / pending-trade) which is why it
-- is stored as opaque TEXT rather than parsed into parts.
--
-- ⚠️ WHAT CANNOT BE HERE, EVER. Losing waiver claims are not exposed by the API
-- at all: once waivers process, competing claims vanish, so who else bid and
-- how much is permanently unrecoverable. Pending transactions are visible only
-- to the team that owns them. Rejected/vetoed trades are undocumented and
-- assumed unrecoverable. This table is therefore "accepted/completed
-- transactions, plus whatever pending items this token can see" — recorded in
-- fantasy_data_completeness as not_exposed rather than left to be discovered by
-- someone who wonders why the waiver market looks uncontested.
--
-- faab_bid is nullable and NULL means not exposed. In a FAAB league a winning
-- bid of 0 is legal and distinct from an unexposed bid.
CREATE TABLE IF NOT EXISTS fantasy_transactions (
  platform            TEXT    NOT NULL,
  transaction_key     TEXT    NOT NULL,   -- provider key, opaque
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  transaction_id      TEXT,
  transaction_type    TEXT    NOT NULL,   -- 'add'|'drop'|'add/drop'|'trade'|'commish'|'waiver'|'pending_trade' — VERBATIM
  status              TEXT,               -- 'successful'|'pending'|'proposed' — VERBATIM
  timestamp_unix      INTEGER,            -- provider timestamp, unix seconds
  processed_date      TEXT,               -- 'YYYY-MM-DD' where the provider gives one
  week                INTEGER,            -- derived from timestamp + schedule periods; NULL if underivable
  faab_bid            INTEGER,            -- ⚠️ NULL = not exposed. 0 = a real zero bid.
  waiver_priority_at_processing INTEGER,  -- NULL when not exposed (it usually is)
  is_commissioner_action INTEGER,
  trade_note          TEXT,               -- rarely exposed on completed trades
  asset_count         INTEGER,            -- observed leg count; validators check it against type
  raw_transaction_json TEXT,
  unmapped_fields     TEXT,
  source_run_id       TEXT,
  fetched_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, transaction_key)
);

-- The transaction log, chronologically — the primary read path.
CREATE INDEX IF NOT EXISTS idx_fantasy_transactions_league_ts
  ON fantasy_transactions(platform, league_key, season, timestamp_unix);

CREATE INDEX IF NOT EXISTS idx_fantasy_transactions_type
  ON fantasy_transactions(platform, league_key, season, transaction_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_transaction_assets — one row per asset movement leg.
--
-- leg_index makes the key total and stable: a single transaction can move the
-- same player twice in principle, and two legs of a trade can otherwise be
-- identical in every other column. It is the provider's ordering where one
-- exists, else the parse order, and it is what makes re-ingesting idempotent.
--
-- source_type / destination_type carry the provider's own vocabulary
-- ('waivers'|'freeagents'|'team'). An add from waivers has source_type
-- 'waivers' and NO source_team_key — absent, not empty-string, because the
-- concept does not apply. That distinction is what lets waiver analysis
-- separate a waiver claim from a free-agent pickup.
--
-- asset_kind exists because draft picks are tradeable in many leagues and are
-- not players. A pick leg carries pick_season/pick_round and a NULL player_uid.
CREATE TABLE IF NOT EXISTS fantasy_transaction_assets (
  platform            TEXT    NOT NULL,
  transaction_key     TEXT    NOT NULL,
  leg_index           INTEGER NOT NULL,   -- 0-based; makes the key total
  league_key          TEXT    NOT NULL,
  season              INTEGER NOT NULL,
  asset_kind          TEXT    NOT NULL DEFAULT 'player',  -- 'player'|'draft_pick'|'faab'
  movement_type       TEXT,               -- 'add'|'drop' — VERBATIM
  player_uid          TEXT,               -- NULL for non-player assets
  player_key_at_txn   TEXT,               -- season-scoped key as returned
  player_name_at_txn  TEXT,               -- as returned; players get renamed
  player_position_at_txn TEXT,
  nfl_team_at_txn     TEXT,
  source_type         TEXT,               -- 'waivers'|'freeagents'|'team'
  source_team_key     TEXT,               -- absent (NULL) unless source_type='team'
  source_team_name    TEXT,
  destination_type    TEXT,               -- 'team'|'waivers'|'freeagents'
  destination_team_key TEXT,              -- absent (NULL) unless destination_type='team'
  destination_team_name TEXT,
  pick_season         INTEGER,            -- draft-pick assets only
  pick_round          INTEGER,
  faab_amount         INTEGER,            -- faab-as-trade-asset only
  raw_asset_json      TEXT,
  source_run_id       TEXT,
  updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, transaction_key, leg_index)
);

-- "Every move this player was ever part of" — before/after production analysis.
CREATE INDEX IF NOT EXISTS idx_fantasy_transaction_assets_player
  ON fantasy_transaction_assets(platform, player_uid, season);

-- "Everything this team acquired / gave up" — trade and waiver ledgers.
CREATE INDEX IF NOT EXISTS idx_fantasy_transaction_assets_dest
  ON fantasy_transaction_assets(platform, league_key, season, destination_team_key);

CREATE INDEX IF NOT EXISTS idx_fantasy_transaction_assets_src
  ON fantasy_transaction_assets(platform, league_key, season, source_team_key);

-- Orphan-leg detection joins on this.
CREATE INDEX IF NOT EXISTS idx_fantasy_transaction_assets_txn
  ON fantasy_transaction_assets(platform, transaction_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_waiver_state_snapshots — waiver order / FAAB budgets as observed.
--
-- The provider exposes only CURRENT waiver priority and (maybe) current FAAB
-- balance, with no history. Capturing a snapshot on every sync is the only way
-- to build a time series, and every row is explicitly an observation rather
-- than an authoritative historical record. observed_at_utc is part of the key
-- because two syncs in one week are two legitimate observations.
CREATE TABLE IF NOT EXISTS fantasy_waiver_state_snapshots (
  platform          TEXT    NOT NULL,
  league_key        TEXT    NOT NULL,
  season            INTEGER NOT NULL,
  team_key          TEXT    NOT NULL,
  observed_at_utc   TEXT    NOT NULL,
  week              INTEGER,
  waiver_priority   INTEGER,
  faab_balance      INTEGER,          -- NULL = not exposed, NOT zero
  faab_spent_todate INTEGER,          -- derived from transactions; NULL if bids unavailable
  is_derived        INTEGER NOT NULL DEFAULT 0,
  source_run_id     TEXT,
  PRIMARY KEY (platform, league_key, season, team_key, observed_at_utc)
);

CREATE INDEX IF NOT EXISTS idx_fantasy_waiver_state_team
  ON fantasy_waiver_state_snapshots(platform, team_key, observed_at_utc);
```


## `worker/migrations/0131_fantasy_rosters_and_scoring.sql`

```sql
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
```


## `worker/migrations/0132_fantasy_player_crosswalk.sql`

```sql
-- 0132_fantasy_player_crosswalk.sql
-- Multi-platform fantasy ingestion: the NFL player-identity crosswalk.
-- Sixth and last of six (0127-0132). Apply AFTER 0131.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- ⚠️ THIS IS THE ONLY FILE IN 0127-0132 THAT TOUCHES AN EXISTING TABLE, AND IT
--    ONLY ADDS A COLUMN. `ALTER TABLE ff_player_ids ADD COLUMN yahoo_id TEXT`
--    is purely additive: no existing column is read, written, renamed or
--    dropped, and no existing row's values change. SQLite has no
--    `ADD COLUMN IF NOT EXISTS`, so RE-RUNNING THIS FILE WILL ERROR with
--    "duplicate column name: yahoo_id". That error is expected and harmless —
--    it is the same accepted behaviour as migration 0036. Everything else here
--    is IF NOT EXISTS.
--
-- WHY EXTEND ff_player_ids RATHER THAN BUILD A PARALLEL TABLE. ff_player_ids is
-- already the canonical all-eras identity table (12,468 rows, 100% coverage of
-- src_weekly in both 2012 and 2025) and its upstream source — DynastyProcess
-- db_playerids.csv — already carries a yahoo_id column that the existing
-- fetcher simply does not select. Landing it is one COLS entry plus this
-- column. Inventing a second crosswalk would create a competing authority for
-- the same fact, which is precisely what DATA_AUTHORITY_MAP.md exists to stop.
--
-- ⚠️ THE 'NA' TRAP — READ BEFORE WRITING ANY JOIN AGAINST yahoo_id.
-- ff_player_ids stores missing external ids as the LITERAL STRING 'NA' (R's
-- missing idiom, serialized to text) — 4,740 of 12,468 rows carry it in at
-- least one column. 'NA' passes both `IS NOT NULL` and `!= ''`, so an unguarded
-- join reports 100% coverage while matching garbage. Every predicate on
-- yahoo_id MUST be guarded:
--     COALESCE(f.yahoo_id, '') NOT IN ('', 'NA')
-- and gsis_id likewise with `COALESCE(f.gsis_id,'') LIKE '00-%'`. This is a
-- direct instance of the repo's no-fail-open rule: an unusable id is not a
-- match, and it is not an absence either — it is a refusal.
--
-- ⚠️ ff_player_ids.gsis_id IS NOT UNIQUE. Several MFL ids can share one gsis_id,
-- so any yahoo→gsis→mfl path fans out result rows unless it uses the aggregate
-- subquery form already used at worker/src/index.js:10320-10337
-- (`SELECT MAX(CAST(ff.mfl_id AS INTEGER)) ... WHERE ff.gsis_id = ...`).
-- The yahoo_id→mfl_id direction is safe because mfl_id is the primary key.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extend the existing crosswalk with the provider's player id.
--
-- The value stored is the BARE NUMERIC id (the tail of a Yahoo player key:
-- '461.p.30121' → '30121'), because that is the form DynastyProcess publishes
-- and the form that is stable across seasons. The full season-scoped key lives
-- in fantasy_player_identifiers (0129), which is where per-season keys belong.
ALTER TABLE ff_player_ids ADD COLUMN yahoo_id TEXT;

-- The resolution access path: provider id → mfl_id → everything else.
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_yahoo
  ON ff_player_ids(yahoo_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_player_crosswalk — the resolved mapping, with its evidence.
--
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON fantasy_players. Two reasons.
-- First, a mapping is a CLAIM with a confidence and a method, not an attribute
-- of the player — "this Yahoo player is that GSIS player, matched on name and
-- team, score 0.93, never reviewed" is a different kind of fact from the
-- player's uniform number. Second, ff_player_ids is refreshed weekly by an
-- unrelated job; keeping our resolutions out of it means that refresh can never
-- overwrite a manual decision.
--
-- RESOLUTION ORDER, strictly. Each step only runs if the previous found nothing:
--   1. provider_id  — ff_player_ids.yahoo_id, guarded NOT IN ('','NA')
--   2. gsis_id      — where the provider supplies one directly
--   3. name+team+position — normalized name AND NFL team AND position must all
--                     agree. A name match ALONE is never sufficient and never
--                     writes a mapping: two different players legitimately share
--                     a normalized name, and merging them silently corrupts
--                     every downstream career total.
--   4. manual       — a human decision, recorded here, never overwritten
--
-- The confidence vocabulary is reused VERBATIM from the existing
-- player_id_crosswalk (0006) — 'exact'|'fuzzy_auto'|'fuzzy_review'|'manual'|
-- 'unmapped' — rather than inventing a parallel set of labels for the same idea.
--
-- ⚠️ AN UNRESOLVED PLAYER IS A ROW, NOT AN ABSENCE. Players that resolve to
-- nothing are written with confidence='unmapped' and mfl_id NULL. Dropping them
-- would make the unresolved report impossible to produce and would quietly
-- shrink the player universe. Team defenses, kickers and pre-2015 players are
-- the expected tail — DynastyProcess is skill-position biased.
CREATE TABLE IF NOT EXISTS fantasy_player_crosswalk (
  platform            TEXT    NOT NULL,
  player_uid          TEXT    NOT NULL,   -- season-independent provider key
  provider_player_id  TEXT,               -- bare numeric provider id
  provider_name       TEXT,               -- name as the provider gave it, for review
  provider_position   TEXT,
  provider_team_abbr  TEXT,
  mfl_id              TEXT,               -- ff_player_ids.mfl_id; NULL when unresolved
  gsis_id             TEXT,               -- guarded LIKE '00-%' at every use
  pfr_id              TEXT,               -- for the snaps join, which is keyed on pfr not gsis
  sleeper_id          TEXT,
  match_method        TEXT,               -- 'provider_id'|'gsis_id'|'name_team_position'|'manual'|'none'
  confidence          TEXT    NOT NULL,   -- 'exact'|'fuzzy_auto'|'fuzzy_review'|'manual'|'unmapped'
  match_score         REAL,               -- 0-1; NULL for exact-id matches
  review_status       TEXT    NOT NULL DEFAULT 'none',  -- 'none'|'needed'|'approved'|'rejected'
  resolved_by         TEXT,               -- the resolver name, or a human for manual
  resolved_at_utc     TEXT    NOT NULL DEFAULT (datetime('now')),
  notes               TEXT,
  source_run_id       TEXT,
  PRIMARY KEY (platform, player_uid)
);

-- The forward join: provider player → UPS/NFL identity.
CREATE INDEX IF NOT EXISTS idx_fantasy_player_crosswalk_mfl
  ON fantasy_player_crosswalk(mfl_id);

CREATE INDEX IF NOT EXISTS idx_fantasy_player_crosswalk_gsis
  ON fantasy_player_crosswalk(gsis_id);

-- The unresolved-player report and the manual review queue read this.
CREATE INDEX IF NOT EXISTS idx_fantasy_player_crosswalk_confidence
  ON fantasy_player_crosswalk(platform, confidence, review_status);
```


## `worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql`

```sql
-- 2026-08-11_fantasy_analytical_views.sql
-- Read-only convenience + analytical views over the fantasy_* model (0127-0132).
--
--   npx wrangler@4 d1 execute ups-mfl-db --local  --file=worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
--   npx wrangler@4 d1 execute ups-mfl-db --remote --file=worker/migrations/manual/2026-08-11_fantasy_analytical_views.sql
--
-- ⚠️ NEVER `wrangler d1 migrations apply` — the tracker is ~47 entries behind
--    reality (0057-0103 report pending but ARE applied) and running it corrupts
--    contract data. Hand-apply with `d1 execute --file`, exactly as above.
--
-- ⚠️ WHY THIS IS IN manual/ AND NOT A NUMBERED MIGRATION.
-- There are ZERO CREATE VIEW statements in all 132 prior migrations. Views are
-- simply not part of this repo's migration convention: the numbered files carry
-- tables, indexes, and one-way data repairs, and the migration tracker is
-- already untrustworthy enough that adding a new statement CLASS to it is a bad
-- trade. manual/ is the established home for hand-applied SQL (YYYY-MM-DD_slug),
-- it is applied deliberately by a human who has read the file, and a view that
-- is dropped and recreated does not need a tracker entry to stay correct.
-- Nothing here creates, alters, or writes a single row of any table.
--
-- WHY THESE VIEWS EXIST AT ALL.
-- 0127-0132 land the tables. Every consumer after them — the Worker's API
-- routes, a notebook, a one-off SQL question — otherwise has to re-derive the
-- same four things by hand, and history says one of them will get it wrong:
--   1. Which points number to use when the provider's and ours disagree.
--   2. That starter status is a DERIVED flag, not a string compare on the slot.
--   3. That platform + league_key + season all have to be in the predicate.
--   4. That NULL is not zero.
-- That failure mode is not hypothetical in this repo. The War Room cap-space
-- panel was wrong for all 12 teams because ONE surface re-derived cap usage and
-- forgot the `+ salaryAdjustments` half of the formula (PR #814, 2026-08). The
-- fix was a single shared derivation. These views are that shared derivation for
-- the fantasy_* family: the join and the null-handling live in ONE place, and
-- the caveats live in a comment attached to the thing that has them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIVE RULES EVERY VIEW IN THIS FILE OBEYS
--
-- (1) PLATFORM + LEAGUE_KEY + SEASON, ALWAYS.
--     Every join predicate carries all three where the joined table has them,
--     and all three are the FIRST projected columns of every view. A view that
--     silently aggregates two platforms or two leagues into one number is a bug,
--     not a feature. A view cannot force a WHERE clause onto its caller — what
--     it can do is put league_key and season in front of them so the omission is
--     visible. The yahoo_* views additionally pin `platform = 'yahoo'`; the
--     fantasy_v_* views GROUP BY platform so they stay correct the day
--     platform='cbs' rows land, with no rewrite.
--
--     The one join that is deliberately identity-only is to fantasy_players
--     (PK: platform, player_uid). That table is the player UNIVERSE and has no
--     league or season by design — it resolves a name, never a fact about a
--     league-season. Anything league-relative comes from a league-scoped table.
--
-- (2) POINTS COME FROM THIS LEAGUE'S OWN SCORING, AND ARE NEVER RECOMPUTED HERE.
--     fantasy_player_week_points already holds both numbers: points_provider
--     (what the platform reported) and points_recomputed (what THIS league's
--     fantasy_scoring_rules produce from the captured stat lines). Views read
--     those columns. They do NOT re-derive scoring from fantasy_player_week_stats
--     — a second scoring implementation is a second thing to get wrong — and
--     they contain no scoring constant of any kind.
--
--     ⚠️ NOT ONE NUMBER IN THIS FILE COMES FROM UPS SCORING. The MFL league's
--     PPR-by-position rules (TE 1.5 / WR 1.0 / RB 0.8, first-down 0.2, sack-yard
--     -0.1) are a different league on a different platform. No view here reads
--     any ups_* / src_* / mfl_* / nfl_* table. Grep this file for those prefixes:
--     there are none outside this comment.
--
--     THE PREFERENCE ORDER, defined once and used identically everywhere:
--         points_effective = COALESCE(points_provider, points_recomputed)
--     This is a preference between two STATED values, not a NULL→0 coercion.
--     When both are NULL the result stays NULL and the week contributes nothing
--     to any SUM — which is why every aggregate view also emits a count of the
--     rows whose points were unknown. A total built on silence is reported as a
--     total plus the size of the silence.
--
--     Views that project a points figure also project points_source ('provider'
--     | 'recomputed' | NULL) so a mixed-source total is detectable rather than
--     assumed away.
--
-- (3) STARTER STATUS COMES FROM is_starter. NEVER FROM A SLOT STRING.
--     fantasy_roster_snapshots.is_starter is derived at ingest from THIS league's
--     own fantasy_roster_positions slot list. There is no `selected_position IN
--     ('BN','IR')` anywhere in this file, because leagues define IR+, IR-R and NA
--     and a hardcoded pair would silently promote those players to starters.
--
--     is_starter is NULLABLE and NULL means "this league's slot definitions were
--     not available when the roster was ingested" — it does NOT mean bench.
--     Every count in this file is therefore three-way: is_starter = 1, = 0, and
--     IS NULL each get their own column. Folding the third into the second is
--     exactly the fail-open the repo's NO-FAIL-OPEN rule forbids.
--
--     yahoo_weekly_rosters additionally joins fantasy_roster_positions and
--     projects starter_flag_disagrees_with_slot, so a stale derivation is
--     visible as data rather than found six months later.
--
-- (4) NULL SURVIVES. Most sharply for auction_cost.
--     A $0 keeper and an unpriced pick are DIFFERENT FACTS (0130, rule 1). There
--     is no COALESCE on auction_cost anywhere in this file. SUM(auction_cost)
--     over a set where every price is NULL returns NULL, not 0 — that is the
--     correct answer to "what did they spend" when nobody said. Alongside every
--     such SUM, the view emits picks_with_price and picks_without_price so a NULL
--     total is diagnosable in the same row.
--
--     Ratios are guarded the same way: points_per_dollar is NULL when the price
--     is NULL (unknown) AND when the price is 0 (a free keeper has undefined
--     points-per-dollar, which is not the same as zero value). The same holds for
--     faab_bid, where 0 is a legal winning bid and NULL means "not exposed".
--
-- (5) INFERRED VALUES CARRY THEIR FLAG THROUGH.
--     Weekly standings are RECONSTRUCTED — the provider serves exactly one
--     standings state per league and has no standings;week=N (0131). Anything
--     downstream of fantasy_standings_snapshots therefore projects is_inferred
--     and inference_basis, never the rank alone. Same for
--     fantasy_team_week_scores.is_derived and
--     fantasy_roster_snapshots.is_derived_acquisition.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
--   * No materialization. These are views, not tables. They are recomputed on
--     every read. This league is 12 teams x ~17 weeks x ~15 seasons; the row
--     counts are thousands, not millions, and every correlated subquery below
--     lands on an index created in 0127-0132. If a view ever becomes hot enough
--     to need caching, cache it in the Worker — do not snapshot it into a table
--     and create a second version of the truth.
--
--   * No optimal-lineup solver. "Best legal lineup under this league's slots" is
--     a bin-packing problem over per-player slot eligibility and it does not
--     belong in a view. fantasy_v_bench_points SURFACES the ingester's
--     points_optimal and refuses to invent one when it is NULL. A NULL optimal
--     means the ingester could not compute it, and the efficiency ratio is
--     correctly NULL rather than 1.0.
--
--   * No cross-platform and no cross-league totals. There is no "career" view
--     here spanning leagues, because manager identity across leagues is a
--     separate claim (fantasy_managers.manager_uid) that deserves its own
--     deliberate treatment rather than an accidental GROUP BY.
--
--   * No writes, no triggers, no DROP. Nothing in this file can lose data.
--
--   * No re-scoring from raw stat lines. See rule 2.
--
-- ⚠️ RE-RUNNING THIS FILE IS A NO-OP, WHICH IS ALSO THE GOTCHA.
-- Every statement is CREATE VIEW IF NOT EXISTS, so applying it twice changes
-- nothing and errors nothing. But IF NOT EXISTS also means EDITING A VIEW BODY
-- HERE AND RE-APPLYING DOES NOTHING — SQLite keeps the old definition. To change
-- a view you must `DROP VIEW <name>` first, then re-apply this file. That is
-- stated here rather than automated with an unconditional DROP, because a DROP
-- at the top of a hand-applied file is a footgun the first time somebody runs it
-- against production while a route is mid-query.
--
-- VERIFIED 2026-08-11, in three passes, all local (--local, never --remote):
--   1. Applied to the working local D1. 11 views created.
--   2. Applied to a PRISTINE database built from 0127-0131 in an isolated
--      --persist-to dir, to prove a clean-slate apply lands all 11 in one shot
--      rather than depending on an earlier partial run. All 11 created; each
--      returned cleanly from `SELECT * FROM <view> LIMIT 1` with 0 rows. 0 rows
--      on an empty database is the correct result; a SQL error would not be.
--   3. Loaded a throwaway fixture into a scratch SQLite copy of the same schema,
--      because an empty database never exercises a join or a NULL guard. The
--      fixture deliberately included: auction_cost of 25.0, 0.0 and NULL on
--      three picks; faab_bid of NULL and 0; is_starter of 1, 0 and NULL (via a
--      slot with no definition in the league's own slot table); points that were
--      provider-only, recomputed-only, and both-NULL; a transaction parent with
--      zero legs; a team-week with points_optimal NULL; a team-week with NULL
--      points; a trade carrying one player and one draft pick; a SECOND LEAGUE;
--      and a platform='cbs' row reusing the SAME league_key, season and team_key
--      as a yahoo row.
--
--      Confirmed on that fixture: no yahoo_* view returned a single non-yahoo
--      row despite the colliding keys; the cbs row stayed its own row in
--      fantasy_v_draft_value rather than merging; 25.0 / 0.0 / NULL stayed three
--      distinct facts with points_per_dollar NULL for both the free keeper and
--      the unpriced pick; the undefined slot read 'unknown' and NOT 'bench', and
--      its points landed in unknown_starter_state_points rather than in the
--      bench total; points_optimal NULL yielded NULL efficiency rather than a
--      fabricated 1.0, and points_optimal = 0 yielded NULL rather than a
--      division error; the legless parent survived with orphan_parent_no_legs=1;
--      the traded draft pick reported NULL production rather than 0; the
--      other-league team reported final_standings_missing=1 with every standings
--      column NULL rather than inheriting the neighbouring league's; and the
--      week with an unknown score produced a 0-0-0 all-play record with a
--      non-zero skip count and a NULL win pct — "we could not tell", not "they
--      lost to everyone".


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — YAHOO CONVENIENCE VIEWS
--
-- Platform-pinned flattenings of the normalized model. These answer "show me the
-- thing" rather than "compute the metric": they do the joins and the null
-- handling, and add no arithmetic beyond the points preference order.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_draft_results
--
-- QUESTION IT ANSWERS: "show me a draft" — every pick of every Yahoo
-- league-season, with the player and team resolved to names, and the auction
-- price intact.
--
-- CAVEATS:
--   * auction_cost is projected RAW. NULL = the provider did not state a price;
--     0 = it stated zero (a free keeper). Read draft_kind / is_price_bearing
--     FIRST: in a snake draft the column is meaningless rather than empty.
--   * The player and team joins are LEFT, on purpose. 0130 calls a pick whose
--     player is missing from fantasy_players a DATA-QUALITY FAILURE — an INNER
--     JOIN would delete the evidence of exactly that failure. player_row_missing
--     and team_row_missing surface it instead, and player_unresolved separates
--     "the pick has no player_uid at all" from "it has one we never ingested".
--   * player_position_at_draft is the position AS OF the draft where it was
--     reconstructable and NULL where it was not. player_position_latest is
--     today's position and is NOT a substitute — a 2016 pick's current position
--     tells you nothing about that draft. Both are projected; neither is folded
--     into the other here.
--   * is_keeper is the PROVIDER's flag and is usually NULL, which is honest:
--     Yahoo has no per-pick keeper attribute. keeper_inferred is OUR inference
--     and lives in its own column with its basis. Never read one as the other.
CREATE VIEW IF NOT EXISTS yahoo_draft_results AS
SELECT
  de.platform,
  de.league_key,
  de.season,
  de.pick_number,
  de.round_number,
  de.pick_in_round,
  de.team_key,
  t.team_name,
  de.player_uid,
  de.player_key_at_draft,
  de.provider_player_id,
  p.full_name                                            AS player_name,
  de.player_position_at_draft,
  p.display_position                                     AS player_position_latest,
  de.nfl_team_at_draft,
  de.auction_cost,                                        -- ⚠️ NULL stays NULL. Never coalesced.
  d.draft_kind,
  d.is_price_bearing,
  d.draft_status,
  d.num_rounds                                           AS draft_num_rounds,
  d.num_picks                                            AS draft_num_picks_observed,
  de.is_keeper,                                           -- provider-stated only
  de.keeper_inferred,                                     -- OUR inference; read with the basis
  de.keeper_inference_basis,
  de.is_auto_pick,
  de.picked_at_unix,
  CASE WHEN de.player_uid IS NULL THEN 1 ELSE 0 END      AS player_unresolved,
  CASE WHEN de.player_uid IS NOT NULL AND p.player_uid IS NULL THEN 1 ELSE 0 END
                                                         AS player_row_missing,
  CASE WHEN de.team_key IS NOT NULL AND t.team_key IS NULL THEN 1 ELSE 0 END
                                                         AS team_row_missing,
  de.source_run_id
FROM fantasy_draft_events de
LEFT JOIN fantasy_drafts d
       ON d.platform   = de.platform
      AND d.league_key = de.league_key
      AND d.season     = de.season
LEFT JOIN fantasy_teams t
       ON t.platform   = de.platform
      AND t.team_key   = de.team_key
      AND t.league_key = de.league_key
      AND t.season     = de.season
LEFT JOIN fantasy_players p
       ON p.platform   = de.platform
      AND p.player_uid = de.player_uid
WHERE de.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_transactions
--
-- QUESTION IT ANSWERS: "what moved, when, and between whom" — the transaction
-- log flattened to ONE ROW PER ASSET LEG, with both counterparties resolved.
--
-- GRAIN: one row per (transaction_key, leg_index). A three-player trade is six
-- rows; an add/drop is two. Counting rows in this view is counting LEGS, not
-- transactions — COUNT(DISTINCT transaction_key) is the transaction count.
--
-- CAVEATS:
--   * The parent→leg join is LEFT. A parent with no legs still appears, with a
--     NULL leg_index and orphan_parent_no_legs = 1. That is the orphan-detection
--     signal 0130 asks for; an INNER JOIN would hide the corruption it exists to
--     find. legs_observed (a direct count off the child table) can be compared
--     against the parent's own asset_count for the same reason.
--   * source_team_name_at_txn is what the provider called the team THAT DAY;
--     source_team_name_current is what fantasy_teams calls it now. Teams get
--     renamed mid-season and both facts are real, so both are projected and
--     neither overwrites the other.
--   * faab_bid lives on the PARENT and is repeated on every leg of that
--     transaction. SUMming faab_bid across this view double-counts any
--     multi-leg transaction. Sum it per DISTINCT transaction_key, or use
--     fantasy_v_waiver_value which restricts to acquisition legs and counts the
--     ambiguity explicitly.
--   * faab_bid NULL = the provider did not expose the bid. 0 = a real zero bid,
--     which is legal. transaction_type and status are VERBATIM provider
--     vocabulary and are not normalized here — filter on what you observe, not
--     on what you assume the vocabulary is.
--   * ⚠️ WHAT IS STRUCTURALLY ABSENT: losing waiver claims. Once waivers
--     process, Yahoo discards competing claims, so this log shows an uncontested
--     market that was not uncontested. That is recorded as not_exposed in
--     fantasy_data_completeness and is not something this view can repair.
--   * The leg join also matches league_key and season. If a leg's league/season
--     ever disagreed with its parent's, the leg would vanish and
--     orphan_parent_no_legs would fire — a loud wrong answer instead of a quiet
--     one.
CREATE VIEW IF NOT EXISTS yahoo_transactions AS
SELECT
  tx.platform,
  tx.league_key,
  tx.season,
  tx.transaction_key,
  tx.transaction_id,
  tx.transaction_type,                                    -- VERBATIM
  tx.status,                                              -- VERBATIM
  tx.timestamp_unix,
  tx.processed_date,
  tx.week,                                                -- derived; NULL when underivable
  tx.faab_bid,                                            -- ⚠️ parent-level. NULL = not exposed, 0 = real zero
  tx.waiver_priority_at_processing,
  tx.is_commissioner_action,
  tx.trade_note,
  tx.asset_count                                         AS asset_count_claimed,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets x
    WHERE x.platform        = tx.platform
      AND x.transaction_key = tx.transaction_key)        AS legs_observed,
  a.leg_index,
  a.asset_kind,
  a.movement_type,
  a.player_uid,
  a.player_key_at_txn,
  a.player_name_at_txn,
  pl.full_name                                           AS player_name_latest,
  a.player_position_at_txn,
  a.nfl_team_at_txn,
  a.source_type,
  a.source_team_key,
  a.source_team_name                                     AS source_team_name_at_txn,
  st.team_name                                           AS source_team_name_current,
  a.destination_type,
  a.destination_team_key,
  a.destination_team_name                                AS destination_team_name_at_txn,
  dt.team_name                                           AS destination_team_name_current,
  a.pick_season,
  a.pick_round,
  a.faab_amount,                                          -- faab-as-a-traded-asset, not the bid
  CASE WHEN a.leg_index IS NULL THEN 1 ELSE 0 END        AS orphan_parent_no_legs,
  tx.source_run_id
FROM fantasy_transactions tx
LEFT JOIN fantasy_transaction_assets a
       ON a.platform        = tx.platform
      AND a.transaction_key = tx.transaction_key
      AND a.league_key      = tx.league_key
      AND a.season          = tx.season
LEFT JOIN fantasy_teams st
       ON st.platform   = tx.platform
      AND st.team_key   = a.source_team_key
      AND st.league_key = tx.league_key
      AND st.season     = tx.season
LEFT JOIN fantasy_teams dt
       ON dt.platform   = tx.platform
      AND dt.team_key   = a.destination_team_key
      AND dt.league_key = tx.league_key
      AND dt.season     = tx.season
LEFT JOIN fantasy_players pl
       ON pl.platform   = tx.platform
      AND pl.player_uid = a.player_uid
WHERE tx.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_weekly_rosters
--
-- QUESTION IT ANSWERS: "who was on this roster in week N, in which slot, and
-- what did they score" — the single most valuable read in the whole family,
-- because none of it is recoverable after the fact (0131).
--
-- GRAIN: one row per (league, season, week, team, player).
--
-- CAVEATS:
--   * starter_state is derived ONLY from rs.is_starter, which was itself derived
--     at ingest from this league's fantasy_roster_positions. There is no string
--     comparison against 'BN' or 'IR' here or anywhere in this file.
--     is_starter IS NULL yields starter_state = 'unknown', NOT 'bench' — NULL
--     means the slot definitions were unavailable at ingest, and calling that
--     bench would quietly invent a lineup decision the manager never made.
--   * slot_definition_missing = 1 means this week's selected_position has no
--     matching row in fantasy_roster_positions for this league-season. That is
--     the condition under which is_starter goes NULL, and it is projected so the
--     cause is visible next to the effect.
--   * starter_flag_disagrees_with_slot = 1 means the stored is_starter and the
--     league's own slot definition contradict each other — a stale derivation
--     after a mid-season settings change, or a re-parse that never re-ran. It is
--     0 when either side is NULL, because unknown is not disagreement.
--   * points are joined per rule 2 and may be NULL for a player who was rostered
--     but never scored a captured line. NULL is not 0 here: a bench player with
--     no points row and a bench player who scored 0.0 are different facts.
--   * acquisition_type / acquisition_date are DERIVED from the transaction log
--     where derivable. is_derived_acquisition says which rows those are. They
--     are not provider fields.
CREATE VIEW IF NOT EXISTS yahoo_weekly_rosters AS
SELECT
  rs.platform,
  rs.league_key,
  rs.season,
  rs.week,
  rs.team_key,
  t.team_name,
  rs.player_uid,
  p.full_name                                            AS player_name,
  rs.player_position,
  rs.nfl_team_abbr,
  rs.eligible_positions,
  rs.injury_status,
  rs.selected_position,                                   -- VERBATIM slot label
  rs.is_starter,                                          -- DERIVED at ingest; NULL = slots unknown
  rs.is_bench,
  rs.is_injury_slot,
  rs.is_flex_slot,
  CASE WHEN rs.is_starter = 1 THEN 'starter'
       WHEN rs.is_starter = 0 THEN 'bench'
       ELSE 'unknown'
  END                                                    AS starter_state,
  rp.is_starting_slot                                    AS slot_is_starting_slot,
  rp.is_bench_slot                                       AS slot_is_bench_slot,
  rp.is_injury_slot                                      AS slot_is_injury_slot,
  rp.is_flex_slot                                        AS slot_is_flex_slot,
  rp.flex_positions                                      AS slot_flex_positions,
  CASE WHEN rs.selected_position IS NOT NULL AND rp.position IS NULL THEN 1 ELSE 0 END
                                                         AS slot_definition_missing,
  CASE WHEN rs.is_starter IS NOT NULL
             AND rp.is_starting_slot IS NOT NULL
             AND rs.is_starter <> rp.is_starting_slot
       THEN 1 ELSE 0
  END                                                    AS starter_flag_disagrees_with_slot,
  rs.acquisition_type,
  rs.acquisition_date,
  rs.is_derived_acquisition,                              -- 1 = WE derived it from the txn log
  rs.game_started_before_lock,
  rs.is_editable_at_capture,
  rs.roster_observed_at_utc,
  pw.points_provider,
  pw.points_recomputed,
  COALESCE(pw.points_provider, pw.points_recomputed)     AS points_effective,
  CASE WHEN pw.points_provider   IS NOT NULL THEN 'provider'
       WHEN pw.points_recomputed IS NOT NULL THEN 'recomputed'
       ELSE NULL
  END                                                    AS points_source,
  pw.points_reconciled,
  pw.reconcile_delta,
  pw.projected_points,
  rs.source_run_id
FROM fantasy_roster_snapshots rs
LEFT JOIN fantasy_teams t
       ON t.platform   = rs.platform
      AND t.team_key   = rs.team_key
      AND t.league_key = rs.league_key
      AND t.season     = rs.season
LEFT JOIN fantasy_players p
       ON p.platform   = rs.platform
      AND p.player_uid = rs.player_uid
LEFT JOIN fantasy_roster_positions rp
       ON rp.platform   = rs.platform
      AND rp.league_key = rs.league_key
      AND rp.season     = rs.season
      AND rp.position   = rs.selected_position
LEFT JOIN fantasy_player_week_points pw
       ON pw.platform   = rs.platform
      AND pw.league_key = rs.league_key
      AND pw.season     = rs.season
      AND pw.week       = rs.week
      AND pw.player_uid = rs.player_uid
WHERE rs.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_player_week_points
--
-- QUESTION IT ANSWERS: "what did this player score in this league in week N, and
-- do we BELIEVE it" — points with the reconciliation verdict attached.
--
-- WHY THE VERDICT MATTERS MORE THAN THE POINTS. points_provider is what Yahoo
-- said. points_recomputed is what this league's fantasy_scoring_rules produce
-- from the captured stat lines. When they disagree, either the scoring table was
-- parsed wrong or the stat capture is incomplete — and every downstream metric
-- built on those points inherits the error silently. reconciliation_verdict
-- makes it a column you have to look at.
--
--   'agree'       points_reconciled = 1, within tolerance
--   'disagree'    points_reconciled = 0 — DO NOT trust derived metrics for
--                 these rows until the cause is found
--   'not_checked' points_reconciled IS NULL — no verdict was ever recorded. This
--                 is NOT a pass. It usually means one side was missing.
--
-- SUPPORTING EVIDENCE, projected so a verdict is explicable in the same row:
--   league_scoring_rules_loaded  — rows in fantasy_scoring_rules for THIS
--                                  league-season. 0 means recomputation was
--                                  impossible, so points_recomputed is
--                                  necessarily NULL and 'not_checked' is
--                                  expected rather than suspicious.
--   stat_lines_captured          — rows in fantasy_player_week_stats for this
--                                  player-week. 0 with a non-NULL
--                                  points_provider means we have the answer but
--                                  not the working.
--
-- CAVEATS:
--   * projected_points is NULL for every backfilled week and that is correct,
--     not missing — historical projections are not retrievable (0131).
--   * The roster join is LEFT and resolves who rostered the player that week. In
--     a sane league that is at most one team, and the table's PK permits two only
--     if the data is corrupt — in which case this view FANS OUT to two rows for
--     that player-week. That fan-out is the corruption signal, deliberately not
--     suppressed with a LIMIT that would hide it.
--   * A player with points but no roster row was a free agent that week. That is
--     a real and useful state, which is why the join is LEFT.
CREATE VIEW IF NOT EXISTS yahoo_player_week_points AS
SELECT
  pw.platform,
  pw.league_key,
  pw.season,
  pw.week,
  pw.player_uid,
  p.full_name                                            AS player_name,
  p.display_position,
  p.position_type,
  p.editorial_team_abbr,
  pw.points_provider,
  pw.points_recomputed,
  COALESCE(pw.points_provider, pw.points_recomputed)     AS points_effective,
  CASE WHEN pw.points_provider   IS NOT NULL THEN 'provider'
       WHEN pw.points_recomputed IS NOT NULL THEN 'recomputed'
       ELSE NULL
  END                                                    AS points_source,
  pw.points_reconciled,
  pw.reconcile_delta,
  CASE pw.points_reconciled
       WHEN 1 THEN 'agree'
       WHEN 0 THEN 'disagree'
       ELSE 'not_checked'
  END                                                    AS reconciliation_verdict,
  pw.projected_points,
  (SELECT COUNT(*)
     FROM fantasy_scoring_rules sr
    WHERE sr.platform   = pw.platform
      AND sr.league_key = pw.league_key
      AND sr.season     = pw.season)                     AS league_scoring_rules_loaded,
  (SELECT COUNT(*)
     FROM fantasy_player_week_stats ws
    WHERE ws.platform   = pw.platform
      AND ws.league_key = pw.league_key
      AND ws.season     = pw.season
      AND ws.week       = pw.week
      AND ws.player_uid = pw.player_uid)                 AS stat_lines_captured,
  rs.team_key                                            AS rostered_by_team_key,
  rt.team_name                                           AS rostered_by_team_name,
  rs.selected_position,
  rs.is_starter,
  CASE WHEN rs.is_starter = 1 THEN 'starter'
       WHEN rs.is_starter = 0 THEN 'bench'
       WHEN rs.team_key IS NULL THEN 'not_rostered'
       ELSE 'unknown'
  END                                                    AS starter_state,
  pw.updated_at_utc
FROM fantasy_player_week_points pw
LEFT JOIN fantasy_players p
       ON p.platform   = pw.platform
      AND p.player_uid = pw.player_uid
LEFT JOIN fantasy_roster_snapshots rs
       ON rs.platform   = pw.platform
      AND rs.league_key = pw.league_key
      AND rs.season     = pw.season
      AND rs.week       = pw.week
      AND rs.player_uid = pw.player_uid
LEFT JOIN fantasy_teams rt
       ON rt.platform   = pw.platform
      AND rt.team_key   = rs.team_key
      AND rt.league_key = pw.league_key
      AND rt.season     = pw.season
WHERE pw.platform = 'yahoo';


-- ─────────────────────────────────────────────────────────────────────────────
-- yahoo_team_seasons
--
-- QUESTION IT ANSWERS: "one row per team per season" — final placement, record,
-- points for/against, draft grade, and activity counts. The league-history read.
--
-- ⚠️ THE STANDINGS HALF OF THIS VIEW MAY BE INFERRED, AND SAYS SO.
-- standings_is_inferred comes straight through from
-- fantasy_standings_snapshots.is_inferred. 1 means the row was RECONSTRUCTED
-- from the weekly scoreboard, not read from the provider — the provider serves
-- exactly one standings state per league and has no historical form (0131).
-- standings_inference_basis explains how. A reconstructed rank must never be
-- reported as a source value, so both columns travel with it.
--
-- HOW THE STANDINGS ROW IS CHOSEN: strictly the is_final = 1 snapshot at the
-- greatest as_of_week. If there is no final snapshot at all, every standings
-- column is NULL and final_standings_missing = 1 — this view does NOT fall back
-- to the latest mid-season snapshot, because presenting a week-9 record as a
-- final record is precisely the kind of silent wrong answer the no-fail-open
-- rule exists to prevent. latest_standings_week_captured is projected so a NULL
-- final is diagnosable ("we have week 12 and nothing after").
--
-- CROSS-CHECKS, not substitutes:
--   points_for                         the standings value (source or inferred)
--   points_for_recomputed_from_weeks   summed from fantasy_team_week_scores
--   weeks_scored                       how many weeks that sum covers
-- A large gap between the two PF numbers means missing weeks, not a tie-break
-- subtlety. Both are projected; neither is silently preferred.
--
--   number_of_moves / number_of_trades         the provider's own counters
--   assets_acquired_observed / assets_given_up_observed / trade_transactions_observed
--                                              counted from the transaction log
-- These measure related but not identical things (the provider's "moves" bundles
-- adds and drops its own way), so they are projected side by side rather than
-- reconciled into one number that would be wrong in both directions.
--
-- CAVEATS:
--   * manager_names is a display convenience built from
--     COALESCE(display_name, nickname_at_time, manager_uid) and joined with
--     ' + ' for co-managed teams. ⚠️ '--hidden--' IS A LEGAL VALUE Yahoo returns
--     for managers who never made their nickname public, and several distinct
--     managers can carry it at once. NEVER group or join on manager_names.
--     manager_uids (the stable account GUIDs) is the key, and it is projected
--     right beside it for exactly that reason.
--   * faab_balance NULL = not exposed, NOT zero remaining (0129).
--   * draft_auction_spend is NULL when no pick in that team's draft carried a
--     price — read it with draft_picks_with_price / draft_picks_without_price.
CREATE VIEW IF NOT EXISTS yahoo_team_seasons AS
SELECT
  t.platform,
  t.league_key,
  t.season,
  t.team_key,
  t.team_id,
  t.team_name,
  t.division_id,
  ls.league_name,
  ls.num_teams,
  ls.playoff_start_week,
  ls.num_playoff_teams,
  ls.is_finished                                         AS league_is_finished,
  (SELECT group_concat(COALESCE(m.display_name, tm.nickname_at_time, tm.manager_uid), ' + ')
     FROM fantasy_team_managers tm
     LEFT JOIN fantasy_managers m
            ON m.platform    = tm.platform
           AND m.manager_uid = tm.manager_uid
    WHERE tm.platform   = t.platform
      AND tm.team_key   = t.team_key
      AND tm.league_key = t.league_key
      AND tm.season     = t.season)                      AS manager_names,
  (SELECT group_concat(tm.manager_uid, ' + ')
     FROM fantasy_team_managers tm
    WHERE tm.platform   = t.platform
      AND tm.team_key   = t.team_key
      AND tm.league_key = t.league_key
      AND tm.season     = t.season)                      AS manager_uids,
  fs."rank"                                              AS final_rank,
  fs.playoff_seed,
  fs.wins,
  fs.losses,
  fs.ties,
  fs.win_percentage,
  fs.points_for,
  fs.points_against,
  fs.games_back,
  fs.streak_type,
  fs.streak_value,
  fs.division_rank,
  fs.clinched_playoffs,
  fs.is_final                                            AS standings_is_final,
  fs.is_inferred                                         AS standings_is_inferred,
  fs.inference_basis                                     AS standings_inference_basis,
  CASE WHEN fs.team_key IS NULL THEN 1 ELSE 0 END        AS final_standings_missing,
  (SELECT MAX(s3.as_of_week)
     FROM fantasy_standings_snapshots s3
    WHERE s3.platform   = t.platform
      AND s3.league_key = t.league_key
      AND s3.season     = t.season
      AND s3.team_key   = t.team_key)                    AS latest_standings_week_captured,
  st.draft_position,
  st.draft_grade,
  st.has_draft_grade,
  st.draft_recap_url,
  st.number_of_moves,
  st.number_of_trades,
  st.waiver_priority,
  st.faab_balance,                                        -- ⚠️ NULL = not exposed, not zero
  (SELECT COUNT(*)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_picks_made,
  (SELECT SUM(de.auction_cost)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_auction_spend,
  (SELECT COUNT(de.auction_cost)
     FROM fantasy_draft_events de
    WHERE de.platform   = t.platform
      AND de.league_key = t.league_key
      AND de.season     = t.season
      AND de.team_key   = t.team_key)                    AS draft_picks_with_price,
  (SELECT COUNT(*)
     FROM fantasy_draft_events de
    WHERE de.platform     = t.platform
      AND de.league_key   = t.league_key
      AND de.season       = t.season
      AND de.team_key     = t.team_key
      AND de.auction_cost IS NULL)                       AS draft_picks_without_price,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets a
    WHERE a.platform             = t.platform
      AND a.league_key           = t.league_key
      AND a.season               = t.season
      AND a.destination_team_key = t.team_key)           AS assets_acquired_observed,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets a
    WHERE a.platform        = t.platform
      AND a.league_key      = t.league_key
      AND a.season          = t.season
      AND a.source_team_key = t.team_key)                AS assets_given_up_observed,
  (SELECT COUNT(DISTINCT a.transaction_key)
     FROM fantasy_transaction_assets a
     JOIN fantasy_transactions tx2
       ON tx2.platform        = a.platform
      AND tx2.transaction_key = a.transaction_key
    WHERE a.platform   = t.platform
      AND a.league_key = t.league_key
      AND a.season     = t.season
      AND LOWER(tx2.transaction_type) LIKE '%trade%'
      AND (a.destination_team_key = t.team_key
        OR a.source_team_key      = t.team_key))         AS trade_transactions_observed,
  (SELECT COUNT(*)
     FROM fantasy_team_week_scores ws
    WHERE ws.platform   = t.platform
      AND ws.league_key = t.league_key
      AND ws.season     = t.season
      AND ws.team_key   = t.team_key)                    AS weeks_scored,
  (SELECT SUM(COALESCE(ws.points_provider, ws.points_from_starters))
     FROM fantasy_team_week_scores ws
    WHERE ws.platform   = t.platform
      AND ws.league_key = t.league_key
      AND ws.season     = t.season
      AND ws.team_key   = t.team_key)                    AS points_for_recomputed_from_weeks
FROM fantasy_teams t
LEFT JOIN fantasy_league_settings ls
       ON ls.platform   = t.platform
      AND ls.league_key = t.league_key
      AND ls.season     = t.season
LEFT JOIN fantasy_team_season_state st
       ON st.platform   = t.platform
      AND st.team_key   = t.team_key
      AND st.league_key = t.league_key
      AND st.season     = t.season
LEFT JOIN fantasy_standings_snapshots fs
       ON fs.platform   = t.platform
      AND fs.league_key = t.league_key
      AND fs.season     = t.season
      AND fs.team_key   = t.team_key
      AND fs.is_final   = 1
      AND fs.as_of_week = (SELECT MAX(s2.as_of_week)
                             FROM fantasy_standings_snapshots s2
                            WHERE s2.platform   = t.platform
                              AND s2.league_key = t.league_key
                              AND s2.season     = t.season
                              AND s2.team_key   = t.team_key
                              AND s2.is_final   = 1)
WHERE t.platform = 'yahoo';


-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — ANALYTICAL VIEWS
--
-- These are THE FOUNDATION, NOT THE FINAL MODEL. They compute the primitives
-- every fantasy question is built from — spend vs production, lineup efficiency,
-- acquisition value, all-play — at the lowest grain that is still meaningful, so
-- a caller can roll them up their own way. They do not rank managers, do not
-- grade drafts, and do not compute "luck" — those are judgements, and a judgement
-- baked into a view is a judgement nobody can see to argue with.
--
-- All of them GROUP BY or key on platform + league_key + season. None is pinned
-- to a platform, so the day platform='cbs' rows land they keep being correct.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_draft_value
--
-- QUESTION IT ANSWERS: "what did each pick cost, and what did it return" — draft
-- price against season production, per pick, with team and position on the row
-- so it rolls up either way.
--
-- GRAIN: one row per draft pick (platform, league_key, season, pick_number).
--
-- ⚠️ THE PRICE COLUMN IS RAW. auction_cost is NULL when the provider stated no
-- price and 0 when it stated zero. Nothing here coalesces it, and
-- points_per_dollar is NULL for BOTH cases — a free keeper's return per dollar
-- is undefined, not infinite and not zero. is_price_bearing tells you whether
-- the column means anything at all in this draft: in a snake league it does not.
--
-- WHAT "SEASON POINTS" MEANS HERE. season_points is the player's WHOLE-SEASON
-- points in THIS league (rule 2 preference order), regardless of who rostered
-- him after the draft. That is the standard read of draft value — the pick's
-- return does not stop counting because the drafter traded him — but it is not
-- the only one, so the roster-scoped figures are projected next to it:
--   points_while_rostered_by_drafting_team  points in weeks he was on their roster
--   points_started_for_drafting_team        points in weeks they actually STARTED him
-- The last one is the only figure that ever hit the drafting team's scoreboard.
--
-- COUNT DEFINITIONS, stated because "games played" is not self-evident in
-- fantasy:
--   games_played   weeks with a non-NULL points value for this player in this
--                  league-season. A week reported as 0.0 counts as played,
--                  because the source SAID zero. A week with no row at all does
--                  not, and lands in weeks_points_unknown instead.
--   games_started  weeks the player occupied a starting slot on ANY team in this
--                  league (is_starter = 1). games_started_for_drafting_team
--                  narrows it to the team that drafted him.
--   Weeks where is_starter IS NULL are counted in weeks_starter_state_unknown and
--   are NOT folded into either the started or the benched count.
--
-- CAVEATS:
--   * points_per_game divides by games_played and is NULL when that is 0. It is
--     not a projection and says nothing about weeks he was hurt.
--   * position falls back to the player's LATEST display_position when the draft
--     row did not state one; position_is_latest_not_at_draft = 1 flags those
--     rows. A 2016 pick attributed to a 2026 position is a real hazard when the
--     fallback fires, so it is marked rather than hidden.
--   * Every per-player aggregate is guarded by `player_uid IS NULL` → NULL. An
--     unresolvable pick reports UNKNOWN production, never zero production.
CREATE VIEW IF NOT EXISTS fantasy_v_draft_value AS
WITH picks AS (
  SELECT
    de.platform,
    de.league_key,
    de.season,
    de.team_key,
    t.team_name,
    de.pick_number,
    de.round_number,
    de.pick_in_round,
    de.player_uid,
    p.full_name                                          AS player_name,
    COALESCE(de.player_position_at_draft, p.display_position)
                                                         AS position,
    CASE WHEN de.player_position_at_draft IS NULL
               AND p.display_position IS NOT NULL
         THEN 1 ELSE 0
    END                                                  AS position_is_latest_not_at_draft,
    de.auction_cost,                                      -- ⚠️ raw. NULL != 0.
    d.draft_kind,
    d.is_price_bearing,
    de.is_keeper,
    de.keeper_inferred,

    -- Whole-season production in THIS league (rule 2 preference order).
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid) END           AS season_points,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid) END           AS games_played,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = de.platform
         AND pw.league_key = de.league_key
         AND pw.season     = de.season
         AND pw.player_uid = de.player_uid
         AND pw.points_provider IS NULL
         AND pw.points_recomputed IS NULL) END            AS weeks_points_unknown,

    -- Fantasy usage, league-wide.
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.is_starter = 1) END                       AS games_started,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid) END           AS weeks_rostered,
    CASE WHEN de.player_uid IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.is_starter IS NULL) END                   AS weeks_starter_state_unknown,

    -- Usage and production for the DRAFTING team specifically.
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key) END             AS weeks_rostered_by_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key
         AND rs.is_starter = 1) END                       AS games_started_for_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key) END             AS points_while_rostered_by_drafting_team,
    CASE WHEN de.player_uid IS NULL OR de.team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = de.platform
         AND rs.league_key = de.league_key
         AND rs.season     = de.season
         AND rs.player_uid = de.player_uid
         AND rs.team_key   = de.team_key
         AND rs.is_starter = 1) END                       AS points_started_for_drafting_team
  FROM fantasy_draft_events de
  LEFT JOIN fantasy_drafts d
         ON d.platform   = de.platform
        AND d.league_key = de.league_key
        AND d.season     = de.season
  LEFT JOIN fantasy_teams t
         ON t.platform   = de.platform
        AND t.team_key   = de.team_key
        AND t.league_key = de.league_key
        AND t.season     = de.season
  LEFT JOIN fantasy_players p
         ON p.platform   = de.platform
        AND p.player_uid = de.player_uid
)
SELECT
  picks.*,
  CASE WHEN games_played IS NULL OR games_played = 0
       THEN NULL
       ELSE season_points / games_played
  END                                                    AS points_per_game,
  -- ⚠️ NULL for an unpriced pick AND for a genuinely free one. Undefined, not zero.
  CASE WHEN auction_cost IS NULL OR auction_cost <= 0
       THEN NULL
       ELSE season_points / auction_cost
  END                                                    AS points_per_dollar
FROM picks;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_roster_construction
--
-- QUESTION IT ANSWERS: "how did this team allocate — money, roster spots, and
-- lineup slots — across positions" — the shape of a roster rather than its
-- result.
--
-- GRAIN: one row per (platform, league_key, season, team_key, position_group).
--
-- HOW THE ROW SET IS BUILT. Three independent aggregates are unioned on their
-- keys, not inner-joined:
--   roster_agg  what was actually rostered week to week
--   draft_agg   what was drafted, and for what price
--   faab_agg    what was picked up off waivers/free agency, and for what bid
-- A position a team drafted but never rostered still gets a row (with NULL
-- roster counts), and vice versa. An INNER JOIN between these would silently
-- delete a busted pick that never made a lineup — which is exactly the case
-- anyone asking about roster construction most wants to see.
--
-- The union spine joins on `position_group IS position_group` (SQLite's
-- null-safe equality), so a genuinely unknown position groups with itself
-- instead of vanishing from the join.
--
-- POSITION RESOLUTION. position_group is the source's own at-the-time position
-- where it stated one, else the player's latest display_position. That fallback
-- is a documented display convenience, and it is why this view is a foundation
-- rather than a final answer: a player who changed positions between the draft
-- and week 12 can appear under two groups.
--
-- COLUMN MEANINGS:
--   players_rostered              distinct players at this position, all season
--   roster_player_weeks           player-weeks — 3 players for 6 weeks = 18
--   starter_player_weeks          is_starter = 1
--   bench_player_weeks            is_starter = 0. ⚠️ INCLUDES injury slots by
--                                 construction, because an IR slot is not a
--                                 starting slot. Subtract injury_slot_player_weeks
--                                 if you want bench-excluding-IR.
--   unknown_starter_player_weeks  is_starter IS NULL — slot definitions were
--                                 missing at ingest. NOT bench.
--   injury_slot_player_weeks      IR usage in player-weeks
--   players_ever_on_injury_slot   distinct players who spent any week on IR
--   avg_starters_per_week         starter_player_weeks / team_weeks_observed,
--                                 i.e. how many of this position the team
--                                 typically started. Divides by the weeks the
--                                 TEAM was observed at all, not the weeks this
--                                 position appeared, so a position that was
--                                 benched all year reads as a low average rather
--                                 than an undefined one.
--
-- SPEND CAVEATS:
--   * auction_spend is NULL when NO pick at this position carried a price. Read
--     it with picks_with_price / picks_without_price. Never coalesced.
--   * faab_spend sums the PARENT transaction's faab_bid once per acquisition
--     leg. add_legs_sharing_one_bid counts the legs whose parent had more than
--     one add — those double-count in this sum and the column exists so that is
--     detectable rather than invisible. NULL bid = not exposed; 0 = a real zero
--     bid, which is legal and is not the same thing.
--   * faab_agg counts only acquisitions whose source_type is 'waivers' or
--     'freeagents'. Trade acquisitions are structurally excluded here — they
--     belong to fantasy_v_trade_ledger — using the SOURCE TYPE rather than the
--     transaction_type vocabulary, which is verbatim provider text and not
--     something to pattern-match on for a money figure.
CREATE VIEW IF NOT EXISTS fantasy_v_roster_construction AS
WITH roster_pos AS (
  SELECT
    rs.platform,
    rs.league_key,
    rs.season,
    rs.team_key,
    COALESCE(rs.player_position, p.display_position)     AS position_group,
    rs.week,
    rs.player_uid,
    rs.is_starter,
    rs.is_injury_slot,
    rs.is_flex_slot
  FROM fantasy_roster_snapshots rs
  LEFT JOIN fantasy_players p
         ON p.platform   = rs.platform
        AND p.player_uid = rs.player_uid
),
roster_agg AS (
  SELECT
    platform,
    league_key,
    season,
    team_key,
    position_group,
    COUNT(DISTINCT player_uid)                           AS players_rostered,
    COUNT(*)                                             AS roster_player_weeks,
    COUNT(DISTINCT week)                                 AS weeks_position_present,
    SUM(CASE WHEN is_starter = 1    THEN 1 ELSE 0 END)   AS starter_player_weeks,
    SUM(CASE WHEN is_starter = 0    THEN 1 ELSE 0 END)   AS bench_player_weeks,
    SUM(CASE WHEN is_starter IS NULL THEN 1 ELSE 0 END)  AS unknown_starter_player_weeks,
    SUM(CASE WHEN is_injury_slot = 1 THEN 1 ELSE 0 END)  AS injury_slot_player_weeks,
    SUM(CASE WHEN is_flex_slot   = 1 THEN 1 ELSE 0 END)  AS flex_slot_player_weeks,
    COUNT(DISTINCT CASE WHEN is_injury_slot = 1 THEN player_uid END)
                                                         AS players_ever_on_injury_slot
  FROM roster_pos
  GROUP BY platform, league_key, season, team_key, position_group
),
draft_agg AS (
  SELECT
    de.platform,
    de.league_key,
    de.season,
    de.team_key,
    COALESCE(de.player_position_at_draft, p.display_position)
                                                         AS position_group,
    COUNT(*)                                             AS picks_used,
    SUM(de.auction_cost)                                 AS auction_spend,
    COUNT(de.auction_cost)                               AS picks_with_price,
    SUM(CASE WHEN de.auction_cost IS NULL THEN 1 ELSE 0 END)
                                                         AS picks_without_price,
    MIN(de.round_number)                                 AS earliest_round_used,
    MIN(de.pick_number)                                  AS earliest_pick_used
  FROM fantasy_draft_events de
  LEFT JOIN fantasy_players p
         ON p.platform   = de.platform
        AND p.player_uid = de.player_uid
  WHERE de.team_key IS NOT NULL
  GROUP BY de.platform, de.league_key, de.season, de.team_key,
           COALESCE(de.player_position_at_draft, p.display_position)
),
faab_agg AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.destination_team_key                               AS team_key,
    COALESCE(a.player_position_at_txn, p.display_position)
                                                         AS position_group,
    COUNT(*)                                             AS acquisitions,
    SUM(tx.faab_bid)                                     AS faab_spend,
    COUNT(tx.faab_bid)                                   AS acquisitions_with_bid,
    SUM(CASE WHEN tx.faab_bid IS NULL THEN 1 ELSE 0 END) AS acquisitions_without_bid,
    SUM(CASE WHEN (SELECT COUNT(*)
                     FROM fantasy_transaction_assets x
                    WHERE x.platform        = a.platform
                      AND x.transaction_key = a.transaction_key
                      AND x.movement_type   = 'add') > 1
              THEN 1 ELSE 0 END)                         AS add_legs_sharing_one_bid
  FROM fantasy_transaction_assets a
  JOIN fantasy_transactions tx
    ON tx.platform        = a.platform
   AND tx.transaction_key = a.transaction_key
   AND tx.league_key      = a.league_key
   AND tx.season          = a.season
  LEFT JOIN fantasy_players p
         ON p.platform   = a.platform
        AND p.player_uid = a.player_uid
  WHERE a.movement_type        = 'add'
    AND a.destination_type     = 'team'
    AND a.destination_team_key IS NOT NULL
    AND a.source_type IN ('waivers', 'freeagents')
  GROUP BY a.platform, a.league_key, a.season, a.destination_team_key,
           COALESCE(a.player_position_at_txn, p.display_position)
),
spine AS (
  SELECT platform, league_key, season, team_key, position_group FROM roster_agg
  UNION
  SELECT platform, league_key, season, team_key, position_group FROM draft_agg
  UNION
  SELECT platform, league_key, season, team_key, position_group FROM faab_agg
)
SELECT
  k.platform,
  k.league_key,
  k.season,
  k.team_key,
  t.team_name,
  k.position_group,
  r.players_rostered,
  r.roster_player_weeks,
  r.weeks_position_present,
  r.starter_player_weeks,
  r.bench_player_weeks,
  r.unknown_starter_player_weeks,
  r.injury_slot_player_weeks,
  r.players_ever_on_injury_slot,
  r.flex_slot_player_weeks,
  d.picks_used,
  d.auction_spend,                                        -- ⚠️ NULL when no pick had a price
  d.picks_with_price,
  d.picks_without_price,
  d.earliest_round_used,
  d.earliest_pick_used,
  f.acquisitions,
  f.faab_spend,                                           -- ⚠️ NULL when no bid was exposed
  f.acquisitions_with_bid,
  f.acquisitions_without_bid,
  f.add_legs_sharing_one_bid,
  (SELECT COUNT(DISTINCT rs2.week)
     FROM fantasy_roster_snapshots rs2
    WHERE rs2.platform   = k.platform
      AND rs2.league_key = k.league_key
      AND rs2.season     = k.season
      AND rs2.team_key   = k.team_key)                   AS team_weeks_observed,
  CASE WHEN (SELECT COUNT(DISTINCT rs3.week)
               FROM fantasy_roster_snapshots rs3
              WHERE rs3.platform   = k.platform
                AND rs3.league_key = k.league_key
                AND rs3.season     = k.season
                AND rs3.team_key   = k.team_key) > 0
       THEN r.starter_player_weeks * 1.0 /
            (SELECT COUNT(DISTINCT rs4.week)
               FROM fantasy_roster_snapshots rs4
              WHERE rs4.platform   = k.platform
                AND rs4.league_key = k.league_key
                AND rs4.season     = k.season
                AND rs4.team_key   = k.team_key)
       ELSE NULL
  END                                                    AS avg_starters_per_week
FROM spine k
LEFT JOIN roster_agg r
       ON r.platform       = k.platform
      AND r.league_key     = k.league_key
      AND r.season         = k.season
      AND r.team_key       = k.team_key
      AND r.position_group IS k.position_group
LEFT JOIN draft_agg d
       ON d.platform       = k.platform
      AND d.league_key     = k.league_key
      AND d.season         = k.season
      AND d.team_key       = k.team_key
      AND d.position_group IS k.position_group
LEFT JOIN faab_agg f
       ON f.platform       = k.platform
      AND f.league_key     = k.league_key
      AND f.season         = k.season
      AND f.team_key       = k.team_key
      AND f.position_group IS k.position_group
LEFT JOIN fantasy_teams t
       ON t.platform   = k.platform
      AND t.team_key   = k.team_key
      AND t.league_key = k.league_key
      AND t.season     = k.season;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_bench_points
--
-- QUESTION IT ANSWERS: "how much did this manager leave on the bench, and how
-- close was the lineup to the best legal one" — actual vs optimal per team-week.
--
-- GRAIN: one row per (platform, league_key, season, week, team_key).
--
-- ⚠️ THIS VIEW DOES NOT SOLVE THE OPTIMAL LINEUP. Finding the best legal lineup
-- is bin-packing over per-player slot eligibility against this league's own slot
-- table, and it belongs in the ingester (which writes
-- fantasy_team_week_scores.points_optimal), not in SQL. This view SURFACES that
-- value and REFUSES to invent one: when points_optimal is NULL, both
-- points_left_on_bench and lineup_efficiency_recomputed are NULL. An efficiency
-- of 1.0 for a team whose optimal was never computed would be a fabricated
-- compliment.
--
-- WHAT IS RECOMPUTED HERE, and why. starter_points_from_rosters and
-- bench_points_from_rosters are summed independently from the roster snapshots
-- joined to weekly points, using is_starter (never a slot string). They exist to
-- be COMPARED against the stored points_from_starters / points_bench: a
-- disagreement means the roster capture is incomplete or the starter derivation
-- is stale, and 0131 explicitly calls that out as the check both numbers are
-- stored for. Both are projected. Neither is silently preferred.
--
-- THREE-WAY STARTER ACCOUNTING, per rule 3:
--   starter_points_from_rosters        is_starter = 1
--   bench_points_from_rosters          is_starter = 0 (⚠️ includes injury slots)
--   injury_slot_points                 is_injury_slot = 1, broken out so bench
--                                      can be read either way
--   unknown_starter_state_points       is_starter IS NULL — points belonging to
--                                      players whose slot could not be
--                                      classified. NOT counted as bench.
-- The matching *_counted and *_missing_points columns say how many players are
-- behind each sum and how many of them had no points row at all, so a small
-- bench total is distinguishable from a missing one.
--
-- league_starting_slots_defined is the number of starting slots
-- fantasy_roster_positions defines for this league-season. 0 means the slot
-- table was never loaded — in which case every is_starter is NULL, every sum
-- above is NULL, and that is the correct output rather than a zero.
--
-- THE ROW SET is a UNION of team-weeks seen in fantasy_team_week_scores and
-- team-weeks seen in fantasy_roster_snapshots. A team-week with a roster but no
-- score row still appears (team_week_score_row_missing = 1) and vice versa —
-- driving off either table alone would hide exactly the gap worth finding.
CREATE VIEW IF NOT EXISTS fantasy_v_bench_points AS
WITH roster_pts AS (
  SELECT
    rs.platform,
    rs.league_key,
    rs.season,
    rs.week,
    rs.team_key,
    rs.is_starter,
    rs.is_injury_slot,
    COALESCE(pw.points_provider, pw.points_recomputed)   AS pts
  FROM fantasy_roster_snapshots rs
  LEFT JOIN fantasy_player_week_points pw
         ON pw.platform   = rs.platform
        AND pw.league_key = rs.league_key
        AND pw.season     = rs.season
        AND pw.week       = rs.week
        AND pw.player_uid = rs.player_uid
),
roster_agg AS (
  SELECT
    platform,
    league_key,
    season,
    week,
    team_key,
    SUM(CASE WHEN is_starter = 1     THEN pts END)       AS starter_points_from_rosters,
    SUM(CASE WHEN is_starter = 0     THEN pts END)       AS bench_points_from_rosters,
    SUM(CASE WHEN is_injury_slot = 1 THEN pts END)       AS injury_slot_points,
    SUM(CASE WHEN is_starter IS NULL THEN pts END)       AS unknown_starter_state_points,
    SUM(CASE WHEN is_starter = 1     THEN 1 ELSE 0 END)  AS starters_counted,
    SUM(CASE WHEN is_starter = 0     THEN 1 ELSE 0 END)  AS bench_counted,
    SUM(CASE WHEN is_starter IS NULL THEN 1 ELSE 0 END)  AS unknown_starter_state_counted,
    SUM(CASE WHEN is_starter = 1 AND pts IS NULL THEN 1 ELSE 0 END)
                                                         AS starters_missing_points,
    SUM(CASE WHEN is_starter = 0 AND pts IS NULL THEN 1 ELSE 0 END)
                                                         AS bench_missing_points,
    COUNT(*)                                             AS roster_slots_observed
  FROM roster_pts
  GROUP BY platform, league_key, season, week, team_key
),
spine AS (
  SELECT platform, league_key, season, week, team_key FROM fantasy_team_week_scores
  UNION
  SELECT platform, league_key, season, week, team_key FROM fantasy_roster_snapshots
)
SELECT
  k.platform,
  k.league_key,
  k.season,
  k.week,
  k.team_key,
  t.team_name,
  s.points_provider,
  s.points_from_starters,
  s.points_bench,
  s.points_optimal,                                       -- ⚠️ NULL = never computed. Not zero.
  s.lineup_efficiency,
  s.projected_points,
  s.scores_reconciled,
  s.reconcile_delta,
  s.is_derived                                           AS team_week_score_is_derived,
  r.starter_points_from_rosters,
  r.bench_points_from_rosters,                            -- ⚠️ includes injury slots
  r.injury_slot_points,
  r.unknown_starter_state_points,
  r.starters_counted,
  r.bench_counted,
  r.unknown_starter_state_counted,
  r.starters_missing_points,
  r.bench_missing_points,
  r.roster_slots_observed,
  CASE WHEN s.points_optimal IS NULL OR s.points_from_starters IS NULL
       THEN NULL
       ELSE s.points_optimal - s.points_from_starters
  END                                                    AS points_left_on_bench,
  CASE WHEN s.points_optimal IS NULL
             OR s.points_optimal = 0
             OR s.points_from_starters IS NULL
       THEN NULL
       ELSE s.points_from_starters / s.points_optimal
  END                                                    AS lineup_efficiency_recomputed,
  CASE WHEN s.points_from_starters IS NULL
             OR r.starter_points_from_rosters IS NULL
       THEN NULL
       ELSE s.points_from_starters - r.starter_points_from_rosters
  END                                                    AS starter_points_disagreement,
  (SELECT COUNT(*)
     FROM fantasy_roster_positions rp
    WHERE rp.platform         = k.platform
      AND rp.league_key       = k.league_key
      AND rp.season           = k.season
      AND rp.is_starting_slot = 1)                       AS league_starting_slots_defined,
  CASE WHEN s.team_key IS NULL THEN 1 ELSE 0 END         AS team_week_score_row_missing,
  CASE WHEN r.team_key IS NULL THEN 1 ELSE 0 END         AS roster_snapshot_rows_missing,
  sp.is_playoff,
  sp.is_consolation,
  sp.is_championship
FROM spine k
LEFT JOIN fantasy_team_week_scores s
       ON s.platform   = k.platform
      AND s.league_key = k.league_key
      AND s.season     = k.season
      AND s.week       = k.week
      AND s.team_key   = k.team_key
LEFT JOIN roster_agg r
       ON r.platform   = k.platform
      AND r.league_key = k.league_key
      AND r.season     = k.season
      AND r.week       = k.week
      AND r.team_key   = k.team_key
LEFT JOIN fantasy_teams t
       ON t.platform   = k.platform
      AND t.team_key   = k.team_key
      AND t.league_key = k.league_key
      AND t.season     = k.season
LEFT JOIN fantasy_schedule_periods sp
       ON sp.platform   = k.platform
      AND sp.league_key = k.league_key
      AND sp.season     = k.season
      AND sp.week       = k.week;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_waiver_value
--
-- QUESTION IT ANSWERS: "what did we pay for pickups, and what did they give
-- back" — FAAB spend against production before and after the acquisition, with
-- how often the player actually STARTED for the team that paid.
--
-- GRAIN: one row per acquisition leg — a transaction asset with
-- movement_type = 'add', destination_type = 'team', and source_type in
-- ('waivers','freeagents'). Trade acquisitions are excluded structurally, by
-- source type rather than by pattern-matching the verbatim transaction_type.
-- Roll up by team_key for "FAAB spent by team", by position for "by position".
--
-- ⚠️ BID SEMANTICS. faab_bid lives on the PARENT transaction. NULL means the
-- provider did not expose the bid — it does NOT mean the pickup was free. 0
-- means a real zero-dollar winning bid, which is legal in a FAAB league. Nothing
-- here coalesces it, and points_per_faab_dollar is NULL for both cases because
-- return-per-dollar on a zero-dollar claim is undefined, not infinite.
-- add_legs_in_transaction > 1 means this parent's single bid is shared across
-- several add legs, so summing faab_bid over those rows double-counts. The
-- column is projected so a rollup can detect and handle it.
--
-- ⚠️ THE BEFORE/AFTER SPLIT DEPENDS ON acquisition_week, WHICH CAN BE NULL.
-- fantasy_transactions.week is derived from the timestamp against the schedule
-- periods and is NULL when it could not be derived. When it is NULL, every
-- before/after figure in this row is NULL — not 0, and not "the whole season".
-- A window with no boundary produces no answer.
--
-- COLUMNS:
--   points_before_acquisition          league points in weeks < acquisition_week
--   points_from_acquisition_onward     league points in weeks >= acquisition_week
--                                      (whole league, regardless of who rostered
--                                      him afterwards)
--   points_rostered_by_acquirer_after  points in weeks he was actually on the
--                                      acquiring team's roster
--   points_started_for_acquirer_after  points in weeks the acquiring team STARTED
--                                      him — the only figure that ever reached
--                                      their scoreboard
--   weeks_started_for_acquirer_after   is_starter = 1 for that team, after
--   weeks_rostered_by_acquirer_after   any slot for that team, after
--
-- CAVEATS:
--   * A player picked up, dropped, and picked up again produces TWO rows whose
--     after-windows OVERLAP. Summing naively double-counts his production. Take
--     the latest acquisition per (team, player) if you need disjoint windows.
--   * Losing bids are structurally unavailable (0130), so the market this view
--     describes always looks less contested than it was.
--   * Every per-player aggregate is guarded on player_uid IS NULL, so a leg with
--     no resolvable player reports UNKNOWN rather than zero production.
CREATE VIEW IF NOT EXISTS fantasy_v_waiver_value AS
WITH acq AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.transaction_key,
    a.leg_index,
    tx.transaction_type,                                  -- VERBATIM
    tx.status,                                            -- VERBATIM
    tx.timestamp_unix,
    tx.processed_date,
    tx.week                                              AS acquisition_week,
    tx.faab_bid,                                          -- ⚠️ NULL = not exposed, 0 = real zero bid
    tx.waiver_priority_at_processing,
    a.source_type,
    a.destination_team_key                               AS team_key,
    a.player_uid,
    a.player_name_at_txn,
    COALESCE(a.player_position_at_txn, p.display_position)
                                                         AS position,
    (SELECT COUNT(*)
       FROM fantasy_transaction_assets x
      WHERE x.platform        = a.platform
        AND x.transaction_key = a.transaction_key
        AND x.movement_type   = 'add')                   AS add_legs_in_transaction,

    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       < tx.week) END                 AS points_before_acquisition,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       >= tx.week) END                AS points_from_acquisition_onward,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
      SELECT COUNT(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_player_week_points pw
       WHERE pw.platform   = a.platform
         AND pw.league_key = a.league_key
         AND pw.season     = a.season
         AND pw.player_uid = a.player_uid
         AND pw.week       >= tx.week) END                AS weeks_with_points_after,

    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week) END                AS weeks_rostered_by_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT COUNT(*)
        FROM fantasy_roster_snapshots rs
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week
         AND rs.is_starter = 1) END                       AS weeks_started_for_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week) END                AS points_rostered_by_acquirer_after,
    CASE WHEN a.player_uid IS NULL OR tx.week IS NULL OR a.destination_team_key IS NULL THEN NULL ELSE (
      SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
        FROM fantasy_roster_snapshots rs
        JOIN fantasy_player_week_points pw
          ON pw.platform   = rs.platform
         AND pw.league_key = rs.league_key
         AND pw.season     = rs.season
         AND pw.week       = rs.week
         AND pw.player_uid = rs.player_uid
       WHERE rs.platform   = a.platform
         AND rs.league_key = a.league_key
         AND rs.season     = a.season
         AND rs.player_uid = a.player_uid
         AND rs.team_key   = a.destination_team_key
         AND rs.week       >= tx.week
         AND rs.is_starter = 1) END                       AS points_started_for_acquirer_after
  FROM fantasy_transaction_assets a
  JOIN fantasy_transactions tx
    ON tx.platform        = a.platform
   AND tx.transaction_key = a.transaction_key
   AND tx.league_key      = a.league_key
   AND tx.season          = a.season
  LEFT JOIN fantasy_players p
         ON p.platform   = a.platform
        AND p.player_uid = a.player_uid
  WHERE a.movement_type        = 'add'
    AND a.destination_type     = 'team'
    AND a.destination_team_key IS NOT NULL
    AND a.source_type IN ('waivers', 'freeagents')
)
SELECT
  acq.*,
  t.team_name,
  -- ⚠️ NULL for an unexposed bid AND for a real zero bid. Undefined, not zero.
  CASE WHEN faab_bid IS NULL OR faab_bid <= 0
       THEN NULL
       ELSE points_started_for_acquirer_after / faab_bid
  END                                                    AS started_points_per_faab_dollar
FROM acq
LEFT JOIN fantasy_teams t
       ON t.platform   = acq.platform
      AND t.team_key   = acq.team_key
      AND t.league_key = acq.league_key
      AND t.season     = acq.season;


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_trade_ledger
--
-- QUESTION IT ANSWERS: "who traded what, and how did it play out" — every asset
-- that changed hands in a trade, with rest-of-season production attached to the
-- side that received it.
--
-- GRAIN: one row per trade leg. A 2-for-1 is three rows. Each row names the team
-- that gave the asset up and the team that received it, so summing
-- rest_of_season_points GROUP BY to_team_key gives each side's haul, and the
-- same sum GROUP BY from_team_key gives what each side surrendered. That is what
-- "for each side" means here — the sides are derived from the legs, not from a
-- guess about which team is "team 1".
--
-- WHICH TRANSACTIONS COUNT: LOWER(transaction_type) LIKE '%trade%'. That is a
-- deliberately loose match over VERBATIM provider vocabulary, catching 'trade'
-- and 'pending_trade' without hardcoding an exhaustive list that a vocabulary
-- change would silently empty. ⚠️ IT THEREFORE INCLUDES PROPOSED AND PENDING
-- TRADES. status is projected and YOU MUST FILTER ON IT — a proposed trade that
-- never executed is in this view, and counting it as a completed one would
-- invent a transaction that never happened. The structural columns
-- (source_type / destination_type) are projected too, so a caller can confirm a
-- leg really is a team-to-team movement.
--
-- ASSET KINDS. asset_kind is 'player', 'draft_pick', or 'faab'. Draft picks and
-- FAAB have no weekly points by definition, so every production column is NULL
-- for them — NULL meaning "the concept does not apply", never zero. pick_season /
-- pick_round carry what a pick leg actually is.
--
-- PRODUCTION COLUMNS (players only, and only when trade_week is derivable):
--   points_before_trade                league points in weeks < trade_week
--   rest_of_season_points              league points in weeks >= trade_week,
--                                      regardless of later moves
--   ros_points_rostered_by_receiver    points in weeks he was on the receiving
--                                      team's roster
--   ros_points_started_by_receiver     points in weeks the receiving team STARTED
--                                      him — what actually hit their scoreboard
--   ros_weeks_started_by_receiver      count of those weeks
--
-- CAVEATS:
--   * trade_week is fantasy_transactions.week, derived from the timestamp. When
--     it is NULL every before/after figure is NULL. A window with no boundary
--     produces no answer, not a full-season one.
--   * A player traded twice produces overlapping after-windows across two rows.
--   * Rest-of-season points are a DESCRIPTION, not a verdict. They ignore
--     opportunity cost, roster context, and the games the receiving team had
--     already won or lost. This is the foundation for a trade evaluation, not
--     one.
CREATE VIEW IF NOT EXISTS fantasy_v_trade_ledger AS
SELECT
  a.platform,
  a.league_key,
  a.season,
  a.transaction_key,
  a.leg_index,
  tx.transaction_type,                                    -- VERBATIM
  tx.status,                                              -- ⚠️ FILTER ON THIS
  tx.timestamp_unix,
  tx.processed_date,
  tx.week                                                AS trade_week,
  tx.trade_note,
  (SELECT COUNT(*)
     FROM fantasy_transaction_assets x
    WHERE x.platform        = a.platform
      AND x.transaction_key = a.transaction_key)         AS legs_in_trade,
  a.asset_kind,
  a.movement_type,
  a.source_type,
  a.destination_type,
  a.source_team_key                                      AS from_team_key,
  a.source_team_name                                     AS from_team_name_at_txn,
  ft.team_name                                           AS from_team_name_current,
  a.destination_team_key                                 AS to_team_key,
  a.destination_team_name                                AS to_team_name_at_txn,
  tt.team_name                                           AS to_team_name_current,
  a.player_uid,
  a.player_name_at_txn,
  COALESCE(a.player_position_at_txn, p.display_position) AS position,
  a.nfl_team_at_txn,
  a.pick_season,
  a.pick_round,
  a.faab_amount,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_player_week_points pw
     WHERE pw.platform   = a.platform
       AND pw.league_key = a.league_key
       AND pw.season     = a.season
       AND pw.player_uid = a.player_uid
       AND pw.week       < tx.week) END                   AS points_before_trade,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_player_week_points pw
     WHERE pw.platform   = a.platform
       AND pw.league_key = a.league_key
       AND pw.season     = a.season
       AND pw.player_uid = a.player_uid
       AND pw.week       >= tx.week) END                  AS rest_of_season_points,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_roster_snapshots rs
      JOIN fantasy_player_week_points pw
        ON pw.platform   = rs.platform
       AND pw.league_key = rs.league_key
       AND pw.season     = rs.season
       AND pw.week       = rs.week
       AND pw.player_uid = rs.player_uid
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week) END                  AS ros_points_rostered_by_receiver,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT SUM(COALESCE(pw.points_provider, pw.points_recomputed))
      FROM fantasy_roster_snapshots rs
      JOIN fantasy_player_week_points pw
        ON pw.platform   = rs.platform
       AND pw.league_key = rs.league_key
       AND pw.season     = rs.season
       AND pw.week       = rs.week
       AND pw.player_uid = rs.player_uid
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week
       AND rs.is_starter = 1) END                         AS ros_points_started_by_receiver,
  CASE WHEN a.asset_kind <> 'player' OR a.player_uid IS NULL OR tx.week IS NULL
            OR a.destination_team_key IS NULL THEN NULL ELSE (
    SELECT COUNT(*)
      FROM fantasy_roster_snapshots rs
     WHERE rs.platform   = a.platform
       AND rs.league_key = a.league_key
       AND rs.season     = a.season
       AND rs.player_uid = a.player_uid
       AND rs.team_key   = a.destination_team_key
       AND rs.week       >= tx.week
       AND rs.is_starter = 1) END                         AS ros_weeks_started_by_receiver
FROM fantasy_transaction_assets a
JOIN fantasy_transactions tx
  ON tx.platform        = a.platform
 AND tx.transaction_key = a.transaction_key
 AND tx.league_key      = a.league_key
 AND tx.season          = a.season
LEFT JOIN fantasy_players p
       ON p.platform   = a.platform
      AND p.player_uid = a.player_uid
LEFT JOIN fantasy_teams ft
       ON ft.platform   = a.platform
      AND ft.team_key   = a.source_team_key
      AND ft.league_key = a.league_key
      AND ft.season     = a.season
LEFT JOIN fantasy_teams tt
       ON tt.platform   = a.platform
      AND tt.team_key   = a.destination_team_key
      AND tt.league_key = a.league_key
      AND tt.season     = a.season
WHERE LOWER(tx.transaction_type) LIKE '%trade%';


-- ─────────────────────────────────────────────────────────────────────────────
-- fantasy_v_all_play
--
-- QUESTION IT ANSWERS: "if this team had played EVERY other team this week, what
-- would its record be" — the schedule-independent measure of a week, and the
-- basis for any later luck analysis.
--
-- GRAIN: one row per (platform, league_key, season, week, team_key).
--
-- HOW IT IS COMPUTED. A self-join of team-week scores within the SAME
-- (platform, league_key, season, week), excluding the team itself. Every
-- comparison is inside one league-week by construction — there is no path by
-- which a 2019 score is compared to a 2024 one, or one league's to another's.
--
-- TEAM POINTS come from COALESCE(points_provider, points_from_starters), the
-- same stated-value preference used everywhere else, with team_points_source
-- naming which one was used. It is a preference between two stated numbers, not
-- a NULL→0 fill.
--
-- ⚠️ AN UNKNOWN SCORE IS NOT A LOSS. A team-week with NULL points still gets a
-- row (dropping it would make a team silently vanish from a week), but it wins
-- and loses nothing: every comparison involving a NULL on either side is counted
-- in comparisons_skipped_unknown_points instead, and all_play_win_pct is NULL
-- when nothing was comparable. A 0-0-0 all-play record with a non-zero skip
-- count means "we could not tell", not "they lost to everyone".
--
-- COLUMNS:
--   all_play_wins / losses / ties      versus every other team in that week
--   all_play_win_pct                   (wins + 0.5*ties) / comparable games;
--                                      NULL when nothing was comparable
--   opponents_in_week                  how many other teams had a row at all
--   head_to_head_result                what ACTUALLY happened that week, from
--                                      fantasy_matchups ('win'|'loss'|'tie', or
--                                      NULL when undecided/not captured). The
--                                      gap between this and all_play_win_pct is
--                                      where a luck metric would come from — this
--                                      view deliberately stops short of computing
--                                      one.
--   is_playoff / is_consolation / is_championship
--                                      from fantasy_schedule_periods, so
--                                      postseason weeks can be excluded. All-play
--                                      over a 4-team playoff bracket is not a
--                                      comparable number and this view does not
--                                      pretend otherwise — it hands you the flag.
--
-- CAVEATS:
--   * team_week_score_is_derived comes through from fantasy_team_week_scores. A
--     derived team score feeding an all-play record makes the all-play record
--     derived too.
--   * Ties are half a win here. That is a convention, stated so it can be
--     disagreed with — the raw counts are projected so any other convention can
--     be computed from this view without modifying it.
CREATE VIEW IF NOT EXISTS fantasy_v_all_play AS
WITH tw AS (
  SELECT
    s.platform,
    s.league_key,
    s.season,
    s.week,
    s.team_key,
    COALESCE(s.points_provider, s.points_from_starters)  AS team_points,
    CASE WHEN s.points_provider      IS NOT NULL THEN 'provider'
         WHEN s.points_from_starters IS NOT NULL THEN 'recomputed_from_starters'
         ELSE NULL
    END                                                  AS team_points_source,
    s.is_derived,
    s.scores_reconciled
  FROM fantasy_team_week_scores s
),
cmp AS (
  SELECT
    a.platform,
    a.league_key,
    a.season,
    a.week,
    a.team_key,
    a.team_points,
    a.team_points_source,
    a.is_derived                                         AS team_week_score_is_derived,
    a.scores_reconciled,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points > b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_wins,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points < b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_losses,
    SUM(CASE WHEN a.team_points IS NOT NULL AND b.team_points IS NOT NULL
                  AND a.team_points = b.team_points THEN 1 ELSE 0 END)
                                                         AS all_play_ties,
    SUM(CASE WHEN b.team_key IS NOT NULL
                  AND (a.team_points IS NULL OR b.team_points IS NULL)
             THEN 1 ELSE 0 END)                          AS comparisons_skipped_unknown_points,
    COUNT(b.team_key)                                    AS opponents_in_week
  FROM tw a
  LEFT JOIN tw b
         ON b.platform   = a.platform
        AND b.league_key = a.league_key
        AND b.season     = a.season
        AND b.week       = a.week
        AND b.team_key  <> a.team_key
  GROUP BY a.platform, a.league_key, a.season, a.week, a.team_key,
           a.team_points, a.team_points_source, a.is_derived, a.scores_reconciled
)
SELECT
  cmp.platform,
  cmp.league_key,
  cmp.season,
  cmp.week,
  cmp.team_key,
  t.team_name,
  cmp.team_points,
  cmp.team_points_source,
  cmp.team_week_score_is_derived,
  cmp.scores_reconciled,
  cmp.all_play_wins,
  cmp.all_play_losses,
  cmp.all_play_ties,
  cmp.comparisons_skipped_unknown_points,
  cmp.opponents_in_week,
  CASE WHEN (cmp.all_play_wins + cmp.all_play_losses + cmp.all_play_ties) = 0
       THEN NULL
       ELSE (cmp.all_play_wins + 0.5 * cmp.all_play_ties) * 1.0
            / (cmp.all_play_wins + cmp.all_play_losses + cmp.all_play_ties)
  END                                                    AS all_play_win_pct,
  (SELECT CASE WHEN m.is_tied = 1                     THEN 'tie'
               WHEN m.winner_team_key IS NULL         THEN NULL
               WHEN m.winner_team_key = cmp.team_key  THEN 'win'
               ELSE 'loss'
          END
     FROM fantasy_matchups m
    WHERE m.platform   = cmp.platform
      AND m.league_key = cmp.league_key
      AND m.season     = cmp.season
      AND m.week       = cmp.week
      AND (m.team_a_key = cmp.team_key OR m.team_b_key = cmp.team_key)
    LIMIT 1)                                             AS head_to_head_result,
  sp.is_playoff,
  sp.is_consolation,
  sp.is_championship
FROM cmp
LEFT JOIN fantasy_teams t
       ON t.platform   = cmp.platform
      AND t.team_key   = cmp.team_key
      AND t.league_key = cmp.league_key
      AND t.season     = cmp.season
LEFT JOIN fantasy_schedule_periods sp
       ON sp.platform   = cmp.platform
      AND sp.league_key = cmp.league_key
      AND sp.season     = cmp.season
      AND sp.week       = cmp.week;


-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (run each after applying; 0 rows is the correct result on an empty DB,
-- a SQL error is not):
--
--   SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name
--   SELECT * FROM yahoo_draft_results            LIMIT 1
--   SELECT * FROM yahoo_transactions             LIMIT 1
--   SELECT * FROM yahoo_weekly_rosters           LIMIT 1
--   SELECT * FROM yahoo_player_week_points       LIMIT 1
--   SELECT * FROM yahoo_team_seasons             LIMIT 1
--   SELECT * FROM fantasy_v_draft_value          LIMIT 1
--   SELECT * FROM fantasy_v_roster_construction  LIMIT 1
--   SELECT * FROM fantasy_v_bench_points         LIMIT 1
--   SELECT * FROM fantasy_v_waiver_value         LIMIT 1
--   SELECT * FROM fantasy_v_trade_ledger         LIMIT 1
--   SELECT * FROM fantasy_v_all_play             LIMIT 1
```

