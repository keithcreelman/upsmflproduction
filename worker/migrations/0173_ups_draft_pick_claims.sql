-- 0173: rookie-draft pick claims (ups_draft_pick_claims).
--
-- One row per pick slot (and one per commissioner rehearsal of a slot), written BEFORE the worker calls MFL or posts to
-- Discord, so each slot is submitted and announced at most once. See worker/src/draft_pick_claim.js for the states.
--
-- The worker also creates this table on demand (CREATE TABLE IF NOT EXISTS, exactly this DDL), so it does NOT depend on
-- this migration being applied first; shipping it keeps the migration tracker and the schema in step. Additive; safe to
-- apply before or after the worker deploys. Expected volume: about one row per draft pick per season.
--
--   cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote

CREATE TABLE IF NOT EXISTS ups_draft_pick_claims (
  league_id       TEXT NOT NULL,
  season          TEXT NOT NULL,
  claim_key       TEXT NOT NULL,
  mode            TEXT NOT NULL,
  round           INTEGER NOT NULL,
  pick            INTEGER NOT NULL,
  franchise_id    TEXT NOT NULL,
  player_id       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  state           TEXT NOT NULL,
  lock_token      TEXT NOT NULL,
  detail          TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  PRIMARY KEY (league_id, season, claim_key)
);
