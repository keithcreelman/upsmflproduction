-- 0125_drop_events_cap_season.sql
--
-- WHICH CAP YEAR a drop penalty belongs to.
--
-- ups_drop_events has always answered "how much" (penalty_amount) and never
-- "which season". Canon §6 "Penalty timing" (docs/league_context_v1.md ~line
-- 531, rule of thumb ~line 1265) defines three buckets around the FA Auction:
--
--   drop BEFORE the FA Auction start  -> CURRENT season's cap   (buckets 1 / 3)
--   drop FROM auction start through end of season -> FOLLOWING season's cap (bucket 2)
--
-- Without this column every penalty landed on the season it was computed in.
-- That is how The Long Haulers (fid 0006) were charged $2,000 on the 2026 cap
-- for Konata Mumpfield and KeAndre Lambert-Smith, both dropped 2026-08-08 —
-- two weeks after the 2026 FA Auction opened, so both belong to 2027.
--
-- The next-season rows are LEDGER-ONLY: they show in reporting immediately and
-- must NOT reach MFL until the rollover. This is exactly the treatment §F
-- RULE 2's next-season fine already gets (ups_faa_nom_penalties.applies_to_season,
-- migration 0097; canon ~line 898 — "store the 3K on the ledger for 2027...
-- never pass to MFL until we roll forward next year").
--
-- ⚠️ HAND-APPLY ONLY:
--     wrangler d1 execute UPS_MFL_DB --remote --file=worker/migrations/0125_drop_events_cap_season.sql
--   NEVER `wrangler d1 migrations apply` — the tracker is ~47 migrations behind
--   and re-running applied migrations corrupts contracts.
--
-- SAFE TO APPLY LATE. The cap-year gate in POST /admin/drops/post-mfl derives
-- the bucket from dropped_at_unix + the league calendar on every run and never
-- reads these columns, so the money decision is correct with or without them.
-- These columns make the decision VISIBLE and auditable; the writers stamp them
-- only when a PRAGMA table_info check confirms they exist.

ALTER TABLE ups_drop_events ADD COLUMN applies_to_season INTEGER;
ALTER TABLE ups_drop_events ADD COLUMN cap_season_source TEXT;
ALTER TABLE ups_drop_events ADD COLUMN cap_season_resolved_at_utc TEXT;
ALTER TABLE ups_drop_events ADD COLUMN cap_season_needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_drop_events ADD COLUMN cap_season_review_reason TEXT;

-- Pending next-season ledger lookups (the rollover reader) and the
-- mis-filed-on-MFL audit both key on this triple.
CREATE INDEX IF NOT EXISTS idx_drop_events_cap_season
  ON ups_drop_events (season, league_id, applies_to_season, posted_to_mfl);

-- NO BACKFILL HERE, DELIBERATELY.
--
-- Backfilling applies_to_season needs the FA Auction start for each season,
-- which lives in ups_settings 'auction_calendar' (worker-side), not in SQL.
-- A hardcoded date in a migration is exactly the "don't pin 2026-07-25 as a
-- constant" trap. The worker stamps every row it touches on the next
-- scan-and-record / post-mfl run; run
--   GET /admin/drops/cap-season-preview?L=74598&YEAR=2026&APIKEY=...
-- first to see the derived buckets before anything is written.
