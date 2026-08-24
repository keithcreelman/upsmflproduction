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
