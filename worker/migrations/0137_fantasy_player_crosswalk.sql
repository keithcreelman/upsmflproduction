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
