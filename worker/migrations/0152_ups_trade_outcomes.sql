-- 0152_ups_trade_outcomes.sql
--
-- Archive of real 2-way trade outcomes -- one row per (trade_group_id,
-- franchise_id), i.e. one row per SIDE of a 2-way trade, computed from
-- src_trades (who gave/got what) joined against src_weekly (what those
-- players actually scored afterward).
--
-- WHY THIS EXISTS (Keith 2026-09-14): the /therapy bot's ammo so far is
-- ups_bad_beats (bench-vs-start) and ups_roast_owner_ammo (hand-curated
-- dossier bits). Both miss the single most common thing an owner vents
-- about: a specific trade. Keith vented that Hammer (0005) "violated him"
-- via a McBride trade -- the real src_trades record (trade2023_75,
-- 2023-08-20) shows the OPPOSITE of what he remembered: Keith (0008) GAVE
-- Trey McBride away to Hammer for Richie James + Jayson Oweh + cap. His own
-- words: "yes that's what makes therapy important... keep it real but find
-- the positive." This table exists to give the bot REAL trade facts -- gave
-- vs. got, and what those specific players actually scored the following
-- season -- to ground that framing instead of ever inventing it.
--
-- Mirrors pipelines/etl/wire/wire_data.py's src_trades + src_weekly reads,
-- same reason ups_bad_beats mirrors bench_burns(): the Cloudflare Worker
-- cannot query src_trades/src_weekly directly at request time.
--
-- Populated by pipelines/etl/scripts/sync_trade_outcomes_to_d1.py, run by
-- hand (same "Keith runs it after data changes" pattern as
-- sync_bad_beats_to_d1.py / sync_owner_ammo_to_d1.py -- no cron here).
--
-- SCOPE (v1): only trade_group_ids with EXACTLY 2 distinct franchise_id
-- values are synced. A 3+-way trade has no single "other side" to frame a
-- gave/got pair against, so it is skipped entirely -- see the sync script's
-- own skip log for counts.
--
-- next_season is always trade season + 1 -- the outcome window is strictly
-- "what these players did the very next season", not "ever since". A more
-- dramatic later vindication/regret (e.g. a player who broke out two
-- seasons later) will NOT show up here by design; that is a real limit of
-- this table, not a bug.
--
-- DESIGN CONSTRAINT: this table stores ONLY real, directly-computed numbers
-- and PROVEN positional-rank superlatives (see sync script for the rank
-- query). It never encodes a winner, grade, or verdict -- no spin column of
-- any kind. The Discord bot's LLM prompt does the "keep it real but find
-- the positive" framing at generation time, grounded in these real numbers;
-- that wiring is a separate concern, not this table's job.

CREATE TABLE IF NOT EXISTS ups_trade_outcomes (
  trade_group_id        TEXT NOT NULL,
  season                 INTEGER NOT NULL,   -- the season the trade happened
  datetime_et            TEXT,                -- when the trade was made
  franchise_id            TEXT NOT NULL,      -- whose side this row describes, zero-padded 4-digit fid
  other_franchise_id      TEXT NOT NULL,      -- the counterparty, zero-padded 4-digit fid
  gave_players_json      TEXT,                -- JSON array of {player_id, player_name, pos} RELINQUISHED by franchise_id
  got_players_json       TEXT,                -- JSON array of {player_id, player_name, pos} ACQUIRED by franchise_id
  gave_extra             TEXT,                -- free text noting non-player assets given (picks/cap), NULL if none
  got_extra              TEXT,                -- free text noting non-player assets acquired (picks/cap), NULL if none
  next_season             INTEGER NOT NULL,   -- season + 1; the outcome window
  gave_next_season_pts   REAL,                -- SUM(src_weekly.score) for gave_players_json, in next_season, any roster
  got_next_season_pts    REAL,                -- SUM(src_weekly.score) for got_players_json, in next_season, any roster
  notable_json            TEXT,               -- JSON array of PROVEN positional-rank superlative strings for next_season, [] if none
  synced_at_utc           TEXT NOT NULL,
  PRIMARY KEY (trade_group_id, franchise_id)
);

CREATE INDEX IF NOT EXISTS idx_ups_trade_outcomes_franchise ON ups_trade_outcomes(franchise_id);
CREATE INDEX IF NOT EXISTS idx_ups_trade_outcomes_season ON ups_trade_outcomes(season);
