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
