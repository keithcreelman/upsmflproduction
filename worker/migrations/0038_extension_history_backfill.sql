-- 0038_extension_history_backfill.sql
-- Seeds ups_extension_master with the offseason 2026 extensions we
-- have hard evidence for. Each row marked evidenced + sourced.
--
-- After this migration, query the parking lot to find rows that
-- need human review:
--
--   SELECT season, franchise_id, player_name, evidence_source
--   FROM ups_extension_master
--   WHERE evidence_grade IN ('derived', 'parking_lot')
--   ORDER BY season, franchise_id, player_name;
--
-- Use ON CONFLICT DO UPDATE so re-running the migration won't
-- duplicate rows; the latest evidence wins.

-- ── 2026 evidenced extensions ────────────────────────────────────
-- Source 1: site/rosters/contract_submissions/contract_activity_2026.json
--   (single backfilled entry, source="worker-offer-extension-manual-fix")
-- Source 2: GitHub Actions failed log-extension-submission runs
--   (run 23020021837 on 2026-03-12 → Stroud; same player as above)
-- Source 3: GitHub Actions failed log-extension-submission run
--   (run 24582421597 on 2026-04-17 → David Montgomery)

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2026', '0005', '16150', 'Stroud, C.J.', 'QB',
   'EXT1', 22000, 1, 'CL 1| TCV 22K| AAV 22K| Y1-22K| GTD: 16.5K| Ext: 🔨 ⏰',
   1, 22000, 22000, 16500, '🔨 ⏰',
   'worker-offer-extension-manual-fix', '2026-03-10T13:00:00Z', datetime('now'),
   'evidenced', 'contract_activity_2026.json + gh_actions_run:23020021837'),
  ('74598', '2026', '0005', '14071', 'David Montgomery', 'RB',
   'EXT1', 12000, 1, 'CL 2|TCV 42K 20K, 30K|Y1-12K Y2-30K 🔨 ⏰|GTD: 31.5K',
   2, 42000, 21000, 31500, NULL,
   'front-office-extension-submit', '2026-04-17T19:14:02Z', datetime('now'),
   'evidenced', 'gh_actions_run:24582421597')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = excluded.player_name,
  position             = excluded.position,
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
