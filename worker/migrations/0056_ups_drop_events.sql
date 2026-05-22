-- 0056_ups_drop_events
-- D1 ledger of every FREE_AGENT transaction (player drop) observed in
-- MFL. Captures pre-drop contract state + canon-determined cap penalty
-- + posted-to-MFL status. Companion table to MFL's own salary_adjustments
-- (which is the source of truth for posted penalties; this table is the
-- comprehensive event log, including zero-penalty drops).
--
-- Per Keith 2026-05-22: build this first, review, then historical
-- backfill across 2026 and prior seasons.
--
-- Penalty formula (canon §6/§D2, ported from
-- pipelines/etl/scripts/build_salary_adjustments_report.py):
--   guaranteed = TCV × 0.75
--   penalty    = max(0, guaranteed - earned_to_date)
--   if TCV ≤ $4000 AND penalty > 0 → fix at $1000
--   if special_case (WW under $5K, taxi, retired, jail-bird) → 0
--
-- ledger_key = `${player_id}_${dropped_at_unix}`. Used to dedup against
-- MFL salary_adjustments rows whose explanation contains
-- `ups_drop_penalty:<ledger_key>`.

CREATE TABLE IF NOT EXISTS ups_drop_events (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  season                      TEXT NOT NULL,
  league_id                   TEXT NOT NULL,
  player_id                   TEXT NOT NULL,
  player_name                 TEXT,
  position                    TEXT,
  nfl_team                    TEXT,
  franchise_id                TEXT NOT NULL,            -- franchise that dropped
  franchise_name              TEXT,
  dropped_at_unix             INTEGER NOT NULL,
  dropped_at_iso              TEXT NOT NULL,
  -- Pre-drop contract state (from latest R2 snapshot before drop_ts)
  pre_drop_contract_status    TEXT,
  pre_drop_salary             INTEGER,                  -- raw dollars
  pre_drop_contract_year      INTEGER,                  -- years remaining (cy)
  pre_drop_contract_length    INTEGER,                  -- CL parsed from contractInfo
  pre_drop_contract_info      TEXT,
  pre_drop_tcv                INTEGER,                  -- raw dollars
  pre_drop_aav                INTEGER,
  pre_drop_years_remaining    INTEGER,
  pre_drop_taxi               INTEGER DEFAULT 0,        -- 1 if on TAXI_SQUAD at drop time
  -- Salary earned to date (sum of past year salaries from contractInfo Y1..YN)
  earned_to_date              INTEGER,
  -- Canon-determined penalty
  guaranteed_amount           INTEGER,                  -- TCV × 0.75
  penalty_amount              INTEGER,                  -- final amount applied
  penalty_basis               TEXT,                     -- 'guarantee_minus_earned' | 'tcv_under_5k_fixed_1k' | 'ww_under_5k_exempt' | 'taxi_exempt' | 'one_year_under_5k_exempt' | 'retired_exempt' | 'jail_bird_exempt' | 'no_penalty_zero'
  penalty_exempt              INTEGER DEFAULT 0,        -- 1 if explicit exemption applied
  penalty_exempt_reason       TEXT,
  -- MFL posting status (the ledger of record is MFL's own salary_adjustments)
  ledger_key                  TEXT UNIQUE,              -- "<player_id>_<dropped_at_unix>"
  posted_to_mfl               INTEGER DEFAULT 0,
  posted_at_utc               TEXT,
  posted_amount               INTEGER,                  -- what actually landed on MFL
  posted_explanation          TEXT,                     -- exactly what we wrote
  -- Discord announcement status
  discord_posted              INTEGER DEFAULT 0,
  discord_channel_id          TEXT,
  discord_message_id          TEXT,
  -- Source / detection
  source                      TEXT NOT NULL DEFAULT 'transactions_poll',
  detected_at_utc             TEXT NOT NULL,
  raw_transaction_json        TEXT,                     -- the raw MFL tx row
  snapshot_source             TEXT,                     -- which R2 snapshot date provided pre_drop_*
  notes                       TEXT,
  UNIQUE (season, league_id, player_id, dropped_at_unix)
);

CREATE INDEX IF NOT EXISTS idx_drop_events_season_league
  ON ups_drop_events (season, league_id);

CREATE INDEX IF NOT EXISTS idx_drop_events_franchise
  ON ups_drop_events (season, league_id, franchise_id);

CREATE INDEX IF NOT EXISTS idx_drop_events_pending
  ON ups_drop_events (posted_to_mfl, season, league_id);

CREATE INDEX IF NOT EXISTS idx_drop_events_ledger_key
  ON ups_drop_events (ledger_key);
