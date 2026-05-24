-- 0059_extension_master_2026_sweep.sql
-- 2026 offseason extension master sweep.
--
-- Step 1: Backfill `evidence_grade` + `evidence_source` on existing 2026
--         master rows that were UPSERTed via runtime worker code BEFORE
--         migration 0037 added the provenance columns. All 9 such rows
--         came in via owner-facing submitters (front-office / mobile)
--         which post through MFL salaries import → high confidence.
-- Step 2: Insert 2026 EXT-flavored players that exist in live MFL salaries
--         but have NO master row (extensions submitted via MFL UI directly
--         or by paths that bypass the worker UPSERT). Marked `derived`
--         because we have the post-extension contract state from MFL but
--         no audit trail of WHO submitted it or WHEN — needs human/source
--         review (forum / Discord / email) to upgrade to `evidenced`.
--
-- Sources discovered via reconciliation on 2026-05-24:
--   • 16187 (Tucker, fr=0006) — EXT1 cy=1 $12K, "Ext: GRide" token
--   • 16188 (         fr=0006) — EXT1 cy=1 $18K, "Ext: PG" token
--
-- Drift items intentionally NOT touched here (require commish review):
--   • 16594 fr=0008 — master says EXT1 but MFL salaries show Rookie;
--                     mobile submission UPSERTed master without MFL ever
--                     accepting the salaries import. Either re-submit or
--                     null the master row.
--   • 16803 fr=0008 — master says EXT2-BL but player was dropped post-
--                     extension; harmless (no roster row) but stale.
--
-- Re-runnable: Step 1 is idempotent (UPDATE only touches NULL grade rows);
-- Step 2 uses INSERT … ON CONFLICT DO UPDATE keyed on (league_id, season,
-- player_id) so re-running won't duplicate.

-- ── Step 1 ──────────────────────────────────────────────────────
-- Promote runtime-UPSERT rows from NULL grade to 'evidenced'. These
-- came through MFL's salary-import flow (front-office / mobile), so
-- the contract state was verified at MFL — high confidence.
UPDATE ups_extension_master
SET
  evidence_grade  = 'evidenced',
  evidence_source = COALESCE(source, 'worker-commish-contract-update'),
  updated_at_utc  = datetime('now')
WHERE season = '2026'
  AND evidence_grade IS NULL;

-- ── Step 2 ──────────────────────────────────────────────────────
-- Two EXT players in MFL salaries that have no master row. Pulled
-- from data/mfl-snapshots/2026-05-24/{salaries.json,rosters.json}.
-- Player names left empty here (the worker's reconcile script can
-- populate them; safe to leave blank).
INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2026', '0006', '16187', '', '',
   'EXT1', 12000, 1, 'CL 2|TCV 14K|AAV 12K|Y1-2 Y2-12|Ext: GRide',
   1, 14000, 12000, 10500, 'GRide',
   'derived-from-mfl-salaries', datetime('now'), datetime('now'),
   'derived', 'mfl-salaries-snapshot:2026-05-24'),
  ('74598', '2026', '0006', '16188', '', '',
   'EXT1', 18000, 1, 'CL 1| TCV 18K| AAV 18K| Y1-18K| Ext: PG| GTD: 13.5K',
   1, 18000, 18000, 13500, 'PG',
   'derived-from-mfl-salaries', datetime('now'), datetime('now'),
   'derived', 'mfl-salaries-snapshot:2026-05-24')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = excluded.new_salary,
  new_contract_year    = excluded.new_contract_year,
  new_contract_info    = excluded.new_contract_info,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = excluded.new_tcv,
  new_aav              = excluded.new_aav,
  new_gtd              = excluded.new_gtd,
  ext_token            = excluded.ext_token,
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;
