-- 0060_extension_master_historical_2012_2017.sql
-- Historical backfill of ups_extension_master from ups_extension_history.
--
-- Source: ups_extension_history (85 rows, posted_year 2012-2017) was
-- mined from Forumotion threads at https://upsdynastycap.forumotion.com
-- in May 2026 (created_at_utc='2026-05-10'). Every row has a forum_thread_url
-- as hard provenance. The `parse_confidence` field on the source describes
-- how cleanly the duration/salary were extracted from the OP body, not
-- whether the extension itself happened.
--
-- Mapping to master:
--   evidence_grade  = 'evidenced'  (forum thread URL is the evidence;
--                                   parse quality doesn't change that
--                                   the extension happened)
--   evidence_source = 'forum:<url> parse_confidence=<high|medium|low>'
--   source          = 'forum-mining:ups_extension_history'
--
-- Field derivations:
--   new_contract_status = 'EXT1' if duration_years=1, 'EXT2' if =2, else NULL
--   new_salary           = stated_salary_usd (often NULL pre-2018; that's OK)
--   extension_term_years = duration_years
--   new_tcv / new_aav / new_gtd left NULL when we can't compute from
--                                source data (don't fake values per
--                                feedback_no_fake_amounts_in_blind_fields)
--
-- Re-runnable: ON CONFLICT(league_id, season, player_id) DO UPDATE
-- so re-running won't duplicate. Cross-season UNIQUE key means each
-- player can have one master row per season; the latest insert wins.

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
SELECT
  '74598' AS league_id,
  CAST(posted_year AS TEXT) AS season,
  COALESCE(franchise_id, '') AS franchise_id,
  player_id,
  player_name_raw AS player_name,
  '' AS position,
  CASE
    WHEN duration_years = 1 THEN 'EXT1'
    WHEN duration_years = 2 THEN 'EXT2'
    ELSE NULL
  END AS new_contract_status,
  stated_salary_usd AS new_salary,
  duration_years AS new_contract_year, -- best-effort; for 1yr ext, cy after extension = 1; for 2yr, cy=2
  NULL AS new_contract_info,
  duration_years AS extension_term_years,
  NULL AS new_tcv,                    -- don't derive; forum often lacks AAV detail
  stated_salary_usd AS new_aav,       -- best-effort; flat assumption pre-2018
  NULL AS new_gtd,
  NULL AS ext_token,
  'forum-mining:ups_extension_history' AS source,
  COALESCE(op_post_date_iso, datetime('now')) AS extended_at_utc,
  datetime('now') AS updated_at_utc,
  'evidenced' AS evidence_grade,
  'forum:' || forum_thread_url || ' parse_confidence=' || COALESCE(parse_confidence, 'unknown') AS evidence_source
FROM ups_extension_history
WHERE player_id IS NOT NULL
  AND player_id != ''
  AND franchise_id IS NOT NULL
  AND franchise_id != ''
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;
