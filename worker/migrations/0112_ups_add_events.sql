-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0112_ups_add_events
--
-- ⚠️ APPLY WITH:  wrangler d1 execute UPS_MFL_DB --remote --file=worker/migrations/0112_ups_add_events.sql
--    NEVER `wrangler d1 migrations apply`. The migration tracker on this D1 is
--    ~47 files behind reality (0057-0103 read as "pending" but ARE applied);
--    letting the tracker replay them re-runs contract writes and corrupts live
--    contracts. Every migration in this repo since 0057 is hand-applied.
--
-- D1 ledger of every player ADD observed in MFL — the mirror image of
-- ups_drop_events (0056), which owns the dropped side. Two sources:
--
--   'bbid' — TRANS_TYPE=BBID_WAIVER. MFL's transaction string is
--            `added_pids,|bid|dropped_pids,` e.g. "16759,|4000|15890,"
--            (added 16759 for $4,000, dropped 15890). The bid is RAW DOLLARS.
--            Verified against 941 real transactions, 2026-07-30.
--   'fcfs' — TRANS_TYPE=FREE_AGENT. Format is `added,|dropped,` (2 fields, no
--            bid). We record ONLY the added side here; the dropped side already
--            flows through /admin/drops/scan-and-record into ups_drop_events.
--            Double-recording a drop would double-post its cap penalty.
--
-- CONTRACT NOTE (this is why there is no salary column to "fix"):
-- MFL's league default salary row (export?TYPE=salaries player id `0000`) is
-- ALREADY the canonical UPS waiver-wire contract — salary 1000 /
-- contractStatus "WW" / contractInfo "CL 1|" / contractYear 1. An FCFS $1K add
-- therefore needs zero contract work, and a BBID award gets salary = winning
-- bid natively from MFL. The ONLY gap is cosmetic: contractInfo carries no
-- TCV/AAV tokens. That absence is verified NOT to affect penalty math (the
-- engine falls back to salary as TCV — see _parseContractData in worker/src/
-- index.js). So contract_annotated below tracks a PRESENTATION-only backfill,
-- never a money write.
--
-- contract_annotated:
--   0 = pending          (add recorded, contractInfo not looked at yet)
--   1 = written          (we appended "TCV {n}K| AAV {n}K" to the default line)
--   2 = skipped_not_default (contractInfo was something else — an owner
--                            converted via MYM/extension, or a commish
--                            hand-edit. NEVER revert those.)
--   3 = needs_review     (lookup/verify failed; a human should look)

CREATE TABLE IF NOT EXISTS ups_add_events (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  season                    TEXT NOT NULL,
  league_id                 TEXT NOT NULL,
  player_id                 TEXT NOT NULL,
  player_name               TEXT,
  position                  TEXT,
  nfl_team                  TEXT,
  franchise_id              TEXT NOT NULL,            -- franchise that acquired (padded)
  franchise_name            TEXT,
  acquired_at_unix          INTEGER NOT NULL,
  acquired_at_iso           TEXT NOT NULL,
  source                    TEXT NOT NULL             -- 'bbid' | 'fcfs'
                              CHECK (source IN ('bbid','fcfs')),
  bid_dollars               INTEGER,                  -- RAW dollars; NULL/1000 for FCFS
  acquisition_week          INTEGER,                  -- _nflWeekForUnix(); 0 = preseason
  -- Cosmetic contractInfo annotation state (never touches salary)
  contract_annotated        INTEGER NOT NULL DEFAULT 0,
  annotated_at_utc          TEXT,
  pre_annotate_contract_info TEXT,                    -- exactly what MFL had before we appended
  -- Discord announcement state
  discord_posted            INTEGER NOT NULL DEFAULT 0,
  discord_channel_id        TEXT,
  discord_message_id        TEXT,
  -- Source / detection
  raw_transaction_json      TEXT,                     -- the raw MFL tx row
  detected_at_utc           TEXT NOT NULL,
  notes                     TEXT,
  UNIQUE (season, league_id, player_id, franchise_id, acquired_at_unix)
);

CREATE INDEX IF NOT EXISTS idx_add_events_season_league
  ON ups_add_events (season, league_id);

CREATE INDEX IF NOT EXISTS idx_add_events_franchise
  ON ups_add_events (season, league_id, franchise_id);

-- The two work queues the */5 cron drains.
CREATE INDEX IF NOT EXISTS idx_add_events_unannotated
  ON ups_add_events (season, league_id, contract_annotated);

CREATE INDEX IF NOT EXISTS idx_add_events_unposted
  ON ups_add_events (season, league_id, discord_posted);

CREATE INDEX IF NOT EXISTS idx_add_events_player
  ON ups_add_events (season, league_id, player_id);
