-- 0050_ups_draft_picks.sql
-- D1-cached mirror of MFL TYPE=draftResults for the UPS Rookie Draft.
-- Read by /roster-workbench at workbench load to derive the
-- `taxi_eligible` flag (canon §A1 R2-5 + 3yr window) WITHOUT per-load
-- MFL fetches.
--
-- Why this exists: PR #238 fetched UPS draftResults inline at every
-- workbench load and blew the Cloudflare Worker CPU budget (hotfix in
-- #243 reduced scope to current-year only — broke 2024/2025 rookie
-- chip display for 2026 viewing). This table is the proper fix:
-- populated by a manual sync endpoint (and eventually a nightly cron)
-- so the workbench reads from D1 in microseconds.
--
-- Schema mirrors MFL's draftPick payload but only the fields the worker
-- needs. Primary key (player_id, season) handles trades after the draft
-- (the franchise_id at pick time is what's stored; subsequent trades
-- don't change UPS draft history).
--
-- Tracker: issue #244 — Audit Phase 2 (canon-math + draft cache consolidation).

CREATE TABLE IF NOT EXISTS ups_draft_picks (
  player_id    TEXT    NOT NULL,
  season       INTEGER NOT NULL,
  round        INTEGER NOT NULL,
  pick         INTEGER NOT NULL,
  franchise_id TEXT,
  drafted_at   TEXT,
  source       TEXT,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_ups_draft_season_round    ON ups_draft_picks(season, round);
CREATE INDEX IF NOT EXISTS idx_ups_draft_franchise_year  ON ups_draft_picks(franchise_id, season);
CREATE INDEX IF NOT EXISTS idx_ups_draft_player          ON ups_draft_picks(player_id);
