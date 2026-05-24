-- 0064_extension_master_derived_only_backfill.sql
-- Backfills ups_extension_master with extension events derived from
-- src_contracts year-over-year analysis. Source mining (forum, xlsx,
-- runtime worker UPSERTs) didn't catch these — they're inferred from
-- MFL salary chain signals (contractStatus = EXT*, extension_flag=1,
-- contract_info "Ext:" / year-list tokens).
--
-- Coverage: primarily 2018, 2022-2025 (the seasons without xlsx or
-- forum mining), plus a tail of 2017+2019+2020+2021 events that the
-- xlsx files missed.
--
-- evidence_grade  = 'derived'
-- evidence_source = 'src_contracts:<season>:<signals>; ci=<excerpt>'
-- source          = 'reconcile-derived'
--
-- extension_term_years is NULL where the year-over-year chain didn't
-- give a confident inference (e.g. mid-multi-year-deal extensions like
-- the Blake/Henry trade-and-extend case). Those rows need manual term
-- assignment from contract_info parsing or owner confirmation.
--
-- Re-runnable: ON CONFLICT(league_id, season, player_id) DO UPDATE
-- preserves evidenced rows by NOT overwriting them when grade differs.

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0007', '10738',
   'Jones, Marvin', 'WR',
   'VETERAN', 16000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_ext_token; ci=Ext Manther 19 (restructured) [16K,15K] (AAV 11,21)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0008', '10738',
   'Jones, Marvin', 'WR',
   'VETERAN GF', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_ext_token; ci=Ext Manther 19 (restructured) AAV 21K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0010', '11192',
   'Bell, Le''Veon', 'RB',
   'EXT1', 48000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. CTown 16 & 17  UW 18 BB 19/20 Restructure (AAV 41,')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0012', '11192',
   'Bell, Le''Veon', 'RB',
   'VETERAN GF', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_year_list; ci=Ext. CTown 16 & 17  UW 18 BB 19/20 Restructure AAV 61K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0012', '11192',
   'Bell, Le''Veon', 'RB',
   'VETERAN GF', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. CTown 16 & 17  UW 18 BB 19/20  AAV 61K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0002', '11192',
   'Bell, Le''Veon', 'RB',
   'VETERAN', 1000, NULL, NULL,
   0, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 1|')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0003', '11222',
   'Allen, Keenan', 'WR',
   'EXT1', 35000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. PG 16 & 17, BB 18 Manther 19/20 [35K,55K, 55K] (AA')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0001', '11222',
   'Allen, Keenan', 'WR',
   'VETERAN GF', 55000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_year_list; ci=Ext. PG 16 & 17, BB 18 Manther 19/20')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0001', '11222',
   'Allen, Keenan', 'WR',
   'VETERAN GF', 55000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. PG 16 & 17, BB 18 Manther 19/20')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0010', '11228',
   'Woods, Robert', 'WR',
   'EXT1', 3000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext Blake 18 [3K, 13K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0009', '11228',
   'Woods, Robert', 'WR',
   'VETERAN', 18000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_ext_token; ci=Ext Blake 18 C-Town 19 Restructure [18K, 18K] (AAV 13K, 23')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0009', '11228',
   'Woods, Robert', 'WR',
   'VETERAN GF', 18000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_ext_token; ci=Ext Blake 18 C-Town 19  AAV 23K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0006', '11232',
   'Hopkins, DeAndre', 'WR',
   'EXT1', 39000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. CBP 16, 17 Blake 18 Hood 19 & 20 [39K, 59K, 59K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0003', '11239',
   'Goodwin, Marquise', 'WR',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. GRide 19 Restructured [7K, 6K] AAV (3,13)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '11244',
   'Kelce, Travis', 'TE',
   'EXT1', 26000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 154K| AAV 52K/64K|  Y1-26 Y2-28 Y3-100')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0001', '11247',
   'Ertz, Zach', 'TE',
   'EXT2', 30000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_year_list; ci=Tag UW 18 Ext 19/20 C-Town [30K, 42K,42K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0009', '11247',
   'Ertz, Zach', 'TE',
   'VETERAN GF', 42000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_year_list; ci=Tag UW 18 Ext 19/20 C-Town [30K, 42K,42K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0009', '11247',
   'Ertz, Zach', 'TE',
   'VETERAN GF', 42000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Tag UW 18 Ext 19/20 C-Town [30K, 42K,42K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '11247',
   'Ertz, Zach', 'TE',
   'EXT1', 11000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 57K| AAV 11K/23K|  Y1-11 Y2-23 Y3-23')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0007', '11644',
   'Carr, Derek', 'QB',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2|')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0004', '11657',
   'Hyde, Carlos', 'RB',
   'STANDARD', 20000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext PG 17')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0009', '11657',
   'Hyde, Carlos', 'RB',
   'VETERAN', 1000, NULL, NULL,
   0, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 1|')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0008', '11670',
   'Watkins, Sammy', 'WR',
   'EXT1', 35000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext by Hood 17 & 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0008', '11670',
   'Watkins, Sammy', 'WR',
   'VETERAN', 35000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext by Hood 17 & 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0009', '11671',
   'Evans, Mike', 'WR',
   'VETERAN', 34000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Gordon 17 & 18 CTown 19 [34K,44K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0001', '11674',
   'Cooks, Brandin', 'WR',
   'VETERAN', 39000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Blake 17 & 18 Bash 19 Restructure [39K, 29K] (AAV 29')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0002', '11675',
   'Adams, Davante', 'WR',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext PG 17, 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0006', '11675',
   'Adams, Davante', 'WR',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_ext_token; ci=Ext PG 17, 18 Hood 19 & 20 [25K, 45K, 45K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0009', '11675',
   'Adams, Davante', 'WR',
   'VETERAN GF', 45000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_ext_token; ci=Ext PG 17, 18 Hood 19 & 20 [25K, 45K, 45K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0003', '11678',
   'Robinson, Allen', 'WR',
   'EXT2', 38000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Mather 17 & 18 GRide 19 & 20 Restructured [38K,38K,')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0001', '11678',
   'Robinson, Allen', 'WR',
   'VETERAN GF', 39000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Manther 17/18 GRide 19/20 AAV 45K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0001', '11679',
   'Beckham, Odell', 'WR',
   'EXT2', 28000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. UW 17, 18 Manther 19 & 20 [28K,48K,48K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0008', '11680',
   'Landry, Jarvis', 'WR',
   'EXT1', 22000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=ext Baster 17 & 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0009', '11680',
   'Landry, Jarvis', 'WR',
   'EXT1', 53000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Cleon 17 & 18  CTown 19 &20  Restructured [53K,37K,')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0011', '11681',
   'Richardson, Paul', 'WR',
   'VETERAN', 12000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext UW 17 Ext. CC 18 (Restructured) [22K, 12K] (AAV $22K)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0012', '11706',
   'Clowney, Jadeveon', 'DE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag; ci=TCV 3K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0010', '11721',
   'Mack, Khalil', 'DE',
   'EXT2', 1000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext BB 17 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0004', '11721',
   'Mack, Khalil', 'DE',
   'VETERAN', 6000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext BB 17 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0002', '11721',
   'Mack, Khalil', 'DE',
   'VETERAN GF', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_ext_token; ci=Ext BB 18 19/Bash 20 & 21 [6K,11K,11K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0001', '11769',
   'Lawrence, Demarcus', 'DE',
   'EXT1', 3000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext UW 18 [3K,6K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0001', '11769',
   'Lawrence, Demarcus', 'DE',
   'VETERAN', 6000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext UW 18 [3K,6K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0004', '11783',
   'Brown, John', 'WR',
   'VETERAN', 4000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag; ci=TCV 8K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0008', '12141',
   'Mariota, Marcus', 'QB',
   'EXT1', 11000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Manther 19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0007', '12150',
   'Gurley, Todd', 'RB',
   'EXT2', 35000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. Manther 19/20 [35K, 35K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0005', '12150',
   'Gurley, Todd', 'RB',
   'VETERAN', 40000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Manther 18/19 Blake 20 TCV 80K AAV 45K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0010', '12151',
   'Gordon, Melvin', 'RB',
   'EXT2', 34000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. Blake 18/19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0010', '12151',
   'Gordon, Melvin', 'RB',
   'VETERAN GF', 34000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_year_list; ci=Ext. Blake 18/19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0002', '12152',
   'Coleman, Tevin', 'RB',
   'VETERAN', 16000, NULL, NULL,
   3, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. UW 18 Bash 19/20 [16K,36K,36K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0005', '12152',
   'Coleman, Tevin', 'RB',
   'VETERAN GF', 36000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:ci_year_list; ci=Ext. UW 18 Bash 19/20 [16K,36K,36K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0009', '12154',
   'Ajayi, Jay', 'RB',
   'EXT2-FL', 33000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. C-Town 18/19 [33K,17K] (AAV $25K)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0012', '12157',
   'Johnson, Duke', 'RB',
   'FL', 6000, NULL, NULL,
   3, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=[6K, 4K,2K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0004', '12157',
   'Johnson, Duke', 'RB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag; ci=TCV 2K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0009', '12171',
   'Johnson, David', 'RB',
   'EXT1', 18000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. C-Town 18/19 [18K,32K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0005', '12171',
   'Johnson, David', 'RB',
   'BL/VETERAN', 35000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. C-Town 18/19  Blake 20 TCV 67K AAV 35K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0008', '12175',
   'Cooper, Amari', 'WR',
   'EXT2', 33000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. Blake 18/19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0004', '12175',
   'Cooper, Amari', 'WR',
   'FL GF', 49000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Blake 18/19 PG 20/21 Restructure [49K,20K] AAV 53K/5')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '12175',
   'Cooper, Amari', 'WR',
   'FL', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 51K| AAV 15K/37K |Y1-14 Y2-37')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0003', '12175',
   'Cooper, Amari', 'WR',
   'FL', 20000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 84K| AAV 37K/47K |Y1-20 Y2-64| Ext: Hammer, GRide')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0003', '12176',
   'Parker, DeVante', 'WR',
   'EXT1', 21000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Gride 18')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0010', '12186',
   'Diggs, Stefon', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. Greatness 18/19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0003', '12186',
   'Diggs, Stefon', 'WR',
   'VETERAN GF', 42000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Greatness 18/19, Blake 20, 21 [22K, 42K,42K]  TCV 10')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0002', '12187',
   'Lockett, Tyler', 'WR',
   'EXT1', 12000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. 18 Bash')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0001', '12205',
   'Funchess, Devin', 'TE',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. UW 18, 19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0006', '12233',
   'Alexander, Kwon', 'LB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Hood 19 [1K, 4K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0011', '12261',
   'Montgomery, Ty', 'RB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag,ci_year_list; ci=Ext. Cleon 18/19')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0006', '12263',
   'Waller, Darren', 'TE',
   'EXT1', 10000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 42K| AAV 6K/18K| (10,16,16)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '12263',
   'Waller, Darren', 'TE',
   'VETERAN', 16000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 40K| AAV 16K/24K| Y1- 16 Y2-24| Ext: Hood, Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0005', '12391',
   'Williams, Tyrell', 'WR',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag; ci=TCV 3K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '12611',
   'Goff, Jared', 'QB',
   'EXT1', 29000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 85K| AAV 15K, 35K|Y1-29K, Y2-12K, Y3-44K| Ext: Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0006', '12625',
   'Elliott, Ezekiel', 'RB',
   'EXT1', 15000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Extended GRide 19 20')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '12626',
   'Henry, Derrick', 'RB',
   'BL', 50000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 94K| AAV 34K, 44K |Y1-50 Y2-44| Ext: LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0005', '12634',
   'Howard, Jordan', 'RB',
   'EXT1', 5000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Son 19 [5K, 25K,25K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0009', '12650',
   'Boyd, Tyler', 'WR',
   'VETERAN', 24000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. BLM 20/21 - TCV 52K [4K, 24K, 24K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0006', '12650',
   'Boyd, Tyler', 'WR',
   'VETERAN', 21000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 52K| AAV 21K, 31K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0003', '12652',
   'Thomas, Michael', 'WR',
   'EXT1', 10000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Extended by Hood 19 & 20')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0007', '12652',
   'Thomas, Michael', 'WR',
   'EXT1', 30000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag,ci_year_list; ci=TCV 130K [30K, 50K, 50K] Ext. Hood 19 & 20 Manther 21/22')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0005', '12658',
   'Shepard, Sterling', 'WR',
   'EXT1', 11000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Son 19 [11K, 31K,31K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0007', '12686',
   'Bosa, Joey', 'DE',
   'EXT1', 2000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Manther [2K, 7K, 7K] (AAV 2K/7K/7K)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0007', '12801',
   'Hill, Tyreek', 'WR',
   'EXT1', 14000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Restructure Ext. Manther 18 - 20 [14K, 14K,15K]  (AAV 1K)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0008', '13113',
   'Watson, Deshaun', 'QB',
   'VETERAN GF', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Rico 20/21')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0010', '13113',
   'Watson, Deshaun', 'QB',
   'FL', 16000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 60K |AAV 34K, 44K| Y1-16 Y2-44| No Further Extensi')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0007', '13116',
   'Mahomes, Patrick', 'QB',
   'VETERAN GF', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Mather 20/21 [2K,14K, 14K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0009', '13116',
   'Mahomes, Patrick', 'QB',
   'EXT1', 78000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 82K| AAV 14K/34K| (78,2,2)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '13116',
   'Mahomes, Patrick', 'QB',
   'FL', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 110K| AAV 34K, 54K| Y1-2K,| Y2-54K, Y3-54K| No Fur')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0009', '13128',
   'Cook, Dalvin', 'RB',
   'VETERAN GF', 30000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. By Mather 20/21 [10K, 30K, 30K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0003', '13128',
   'Cook, Dalvin', 'RB',
   'FL', 60000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 90K| AAV 40K/50K|  Y1-60 Y2-30')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0003', '13130',
   'McCaffrey, Christian', 'RB',
   'FL', 55000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Gordon 20/21 TCV 70K AAV 35K [55K, 15K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0005', '13130',
   'McCaffrey, Christian', 'RB',
   'FL', 44000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 109K| AAV 55K, 65K| Y1-44 Y2-65| Ext: Creel, Hood,')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0002', '13131',
   'Mixon, Joe', 'RB',
   'VETERAN', 33000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. GRide 20/21 TCV 79K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0010', '13132',
   'Kamara, Alvin', 'RB',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. CTown 20/21 TCV 55K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0010', '13154',
   'Williams, Mike', 'WR',
   'VETERAN', 6000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 22K| AAV 6K/16K|  Y1-6 Y2-16')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0002', '13164',
   'Kupp, Cooper', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag,ci_year_list; ci=TCV 44K ext. Manther 20/21')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0012', '13168',
   'Reynolds, Josh', 'WR',
   'VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:extension_flag; ci=TCV 4K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0008', '13189',
   'Engram, Evan', 'TE',
   'VETERAN GF', 19000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. Cleon 20/21 [7K,19K, 19K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0009', '13193',
   'Smith, Jonnu', 'TE',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 27K| AAV 1K/13K| (25,1,1)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0002', '13230',
   'Adams, Jamal', 'LB',
   'VETERAN GF', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. CMC 20/21 [7K, 7K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '13230',
   'Adams, Jamal', 'LB',
   'VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 4K| AAV 2K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0008', '13251',
   'Baker, Budda', 'S',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext Gordon 18 [1K, 4K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0008', '13251',
   'Baker, Budda', 'S',
   'VETERAN', 4000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext Gordon 18 [1K, 4K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0005', '13277',
   'Golladay, Kenny', 'WR',
   'EXT1', 18000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 54K| AAV 18K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '13299',
   'Kittle, George', 'TE',
   'FL', 17000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 49K| AAV 26K, 32K| Y1-17 Y2-32| Ext: PG, Sex, GRid')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0008', '13364',
   'Carson, Chris', 'RB',
   'FL', 31000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_year_list; ci=Ext. BLM 20/21 - TCV 43K AAV 21K [1K, 31K, 11K]')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0010', '13378',
   'Breida, Matt', 'RB',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=Ext. Blake 19 Restructured [7K,7K] AAV (2,12)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '13589',
   'Allen, Josh', 'QB',
   'VETERAN', 8000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 48K| AAV 8K/28K| Y1-8 Y2-28 Y3-28')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '13593',
   'Jackson, Lamar', 'QB',
   'EXT1', 17000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 91K| AAV 17K/37K| Y1-17 Y2-37 Y3-37')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '13604',
   'Barkley, Saquon', 'RB',
   'VETERAN', 35000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 80K| AAV 35K/45K| Y1-35 Y2-45')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '13604',
   'Barkley, Saquon', 'RB',
   'VETERAN', 45000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 90K| AAV 45K, 55K| Y1-45 Y2-55| Ext: Sex, PG, Cree')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '13610',
   'Chubb, Nick', 'RB',
   'BL', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 121K| AAV 27K/47K| Y1-25 Y2-16 Y3-80')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0012', '13629',
   'Ridley, Calvin', 'WR',
   'VETERAN', 24000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 46K| AAV 18K/28K| Y1-24 Y2-28| Ext: Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0001', '13630',
   'Sutton, Courtland', 'WR',
   'VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 30K| AAV 10K, 20K| Y1-15K, Y2-15K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0005', '13633',
   'Kirk, Christian', 'WR',
   'VETERAN', 9000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 28K| AAV 9K, 19K| Y1-9K Y2-19K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '13635',
   'Moore, D.J.', 'WR',
   'EXT1', 26000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 127K| AAV 29K/49K| Y1-26 Y2-25 Y3-76')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0001', '13639',
   'Miller, Anthony', 'WR',
   'EXT1', 3000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:extension_flag; ci=TCV 9K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0003', '13668',
   'Chark, D.J.', 'WR',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 3K| AAV 1K|')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '13671',
   'Andrews, Mark', 'TE',
   'VETERAN', 9000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 18K| AAV 9K/15K|  Y1-9 Y2-9')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '13671',
   'Andrews, Mark', 'TE',
   'EXT1', 9000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 63K| AAV 9K, 27K| Y1-9K, Y2-27K, Y3-27K| Ext: BB, ')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0009', '13672',
   'Gesicki, Mike', 'TE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:extension_flag; ci=TCV 3K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0005', '13743',
   'Warner, Fred', 'LB',
   'EXT1', 4000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 12K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0011', '13772',
   'Schultz, Dalton', 'TE',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 20K| AAV 7K/13K|  Y1-7 Y2-13')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '14056',
   'Murray, Kyler', 'QB',
   'VETERAN', 23000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 115K| AAV 25K/45K |Y1-23 Y2-46 Y3-46| No Further E')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2021', '0004', '14059',
   'Jones, Daniel', 'QB',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2021' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2021:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0010', '14059',
   'Jones, Daniel', 'QB',
   'EXT1', 31000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 73K| AAV 16K, 36K| Y1-31 Y2-21 Y3-21')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '14071',
   'Montgomery, David', 'RB',
   'EXT1', 24000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 112K| AAV 24K/44K| Y1-24 Y2-44 Y3-44')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '14073',
   'Jacobs, Josh', 'RB',
   'FL', 35000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 80K| AAV 35K |Y1-35 Y2-45| Ext: Hood, Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14075',
   'Harris, Damien', 'RB',
   'EXT2', 15000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 40K| AAV 15K/25K| Y1-15 Y2-25')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '14079',
   'Sanders, Miles', 'RB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 54K| AAV 22K/32K| Y1-22K Y2-32K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14080',
   'Singletary, Devin', 'RB',
   'EXT1', 15000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 1| TCV 15K| AAV 15K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '14081',
   'Gaskin, Myles', 'RB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 44K| AAV 22K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14085',
   'Pollard, Tony', 'RB',
   'BL', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 34K| AAV 12K/22K| Y1-7 Y2-27')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0009', '14085',
   'Pollard, Tony', 'RB',
   'BL', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 54K| AAV 17K, 17K| Y1-27, Y2-27| Ext: C-Town')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14102',
   'Metcalf, DK', 'WR',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 50K| AAV 25K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '14104',
   'Brown, A.J.', 'WR',
   'EXT2', 26000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 52K| AAV 26K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '14104',
   'Brown, A.J.', 'WR',
   'EXT1', 26000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 118K| AAV 26K, 46K|Y1-26 Y2-46 Y3-46| Ext: Sex, Cr')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '14104',
   'Brown, A.J.', 'WR',
   'BL', 73000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 129K| AAV 46K, 56K|Y1-73 Y2-56 | Ext: Sex, Creel, ')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0006', '14109',
   'McLaurin, Terry', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 44K| AAV 22K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0001', '14109',
   'McLaurin, Terry', 'WR',
   'VETERAN', 22000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 54K| AAV 22K, 32K| Ext: Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0010', '14123',
   'Renfrow, Hunter', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 44K| AAV 22K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0010', '14136',
   'Samuel, Deebo', 'WR',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 60K| AAV 25K, 35K| Ext: Chivalry, Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14138',
   'Hockenson, T.J.', 'TE',
   'EXT2', 20000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 40K| AAV 20K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '14138',
   'Hockenson, T.J.', 'TE',
   'EXT1', 20000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 84K| AAV 20K, 32K| Y1-20K, Y2-32K, Y3-32K| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14147',
   'Bosa, Nick', 'DE',
   'EXT2', 7000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 14K| AAV 7K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '14208',
   'Johnson, Diontae', 'WR',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 50K| AAV 25K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '14208',
   'Johnson, Diontae', 'WR',
   'VETERAN', 12000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 60K| AAV 25K/35K| Y1-12 Y2-48| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14225',
   'Crosby, Maxx', 'DE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 5K| AAV 1K/4K|  Y1-1 Y2-4')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0001', '14777',
   'Burrow, Joe', 'QB',
   'EXT2-BL', 15000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 50K| AAV 25K| Y1-15K, Y2-35K| No Further Extension')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0009', '14778',
   'Tagovailoa, Tua', 'QB',
   'FL', 86000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 116K| AAV 29K, 49K| Y1-86 Y2-15 Y3-15| Ext: C-Town')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0006', '14779',
   'Herbert, Justin', 'QB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 44K| AAV 22K| No Further Extension Allowed')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '14782',
   'Love, Jordan', 'QB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 43K| AAV 1K/21K| Y1-1, Y2-21, Y3-21| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '14783',
   'Hurts, Jalen', 'QB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 44K| AAV 22K|Ext: Gride')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0005', '14783',
   'Hurts, Jalen', 'QB',
   'EXT1', 22000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 106K| AAV 22K/42K| Y1-22K, Y2-42K, Y3-42K| Ext: Gr')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0003', '14797',
   'Swift, D''Andre', 'RB',
   'ROOKIE/VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 32K| AAV 11K/21K| Y1-11 Y2-21')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0012', '14799',
   'Akers, Cam', 'RB',
   'EXT2', 26000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 52K| AAV 26K| Ext: Hawks')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14800',
   'Dobbins, J.K.', 'RB',
   'ROOKIE/VETERAN', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 36K| AAV 13K/23K| Y1-13 Y2-23')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '14802',
   'Taylor, Jonathan', 'RB',
   'EXT2', 44000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 68K| AAV 34K| Y1-44 Y2-24 Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '14805',
   'Dillon, AJ', 'RB',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 50K| AAV 25K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0001', '14832',
   'Lamb, CeeDee', 'WR',
   'EXT2', 20000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 64K| AAV 32K| Y1- 20K Y2- 44K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0001', '14832',
   'Lamb, CeeDee', 'WR',
   'EXT1', 44000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 172K| AAV 44K| Y1- 44K Y2- 64K Y3- 64K| Ext: UW, C')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0001', '14833',
   'Jeudy, Jerry', 'WR',
   'EXT1', 20000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 1| TCV 20K| AAV 20K|Ext: GRide')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0006', '14835',
   'Higgins, Tee', 'WR',
   'EXT2', 27000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 54K| AAV 27K| Ext: Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0006', '14835',
   'Higgins, Tee', 'WR',
   'FL', 63000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 64K| AAV 27K/37K| Y1-63, Y2-1| Ext: Mafia, LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0009', '14835',
   'Higgins, Tee', 'WR',
   'VETERAN', 24000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 48K| AAV 37K, 47K| Y1-24, Y2-24| Ext: Mafia, LH, C')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '14836',
   'Jefferson, Justin', 'WR',
   'EXT2', 28000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 56K| AAV 28K| Ext:  Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0005', '14836',
   'Jefferson, Justin', 'WR',
   'EXT1', 48000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 124K| AAV 28K/48K| Y1-28K, Y2-48K, Y3-48K| Ext:  S')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '14840',
   'Aiyuk, Brandon', 'WR',
   'EXT2', 15000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 40K| AAV 15K |Y1-15 Y2-25| Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '14842',
   'Pittman, Michael', 'WR',
   'ROOKIE/VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 20K| AAV 5K/15K| Y1-5K Y2-15K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0010', '14842',
   'Pittman, Michael', 'WR',
   'VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 40K| AAV 15K, 25K| Y1-15K Y2-25K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '14842',
   'Pittman, Michael', 'WR',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 115K| AAV 25K/45K| Y1-25K Y2-45K Y3-45K| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0011', '14845',
   'Davis, Gabriel', 'WR',
   'EXT1', 12000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 1| TCV 12K| AAV 12K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0012', '14857',
   'Peoples-Jones, Donovan', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 44K| AAV 22K| Ext: Hawks')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '14867',
   'Kmet, Cole', 'TE',
   'ROOKIE/VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 10K| AAV 2K/8K|  Y1-2 Y2-8')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0006', '14877',
   'Young, Chase', 'DE',
   'VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 2| TCV 4K| AAV 2K|')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0012', '14892',
   'Brooks, Jordyn', 'LB',
   'EXT2', 6000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 12K| AAV 6K| Ext: Hawks')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0009', '15237',
   'Lawrence, Trevor', 'QB',
   'EXT2', 47000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 58K| AAV 29K| Y1-47, Y2-11| No Further Extension A')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '15238',
   'Fields, Justin', 'QB',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 50K| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0007', '15240',
   'Lance, Trey', 'QB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '15241',
   'Jones, Mac', 'QB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 2K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0011', '15253',
   'Etienne, Travis', 'RB',
   'EXT1', 22000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 1| TCV 22K| AAV 22K| Ext: Cleon')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '15254',
   'Harris, Najee', 'RB',
   'ROOKIE|VETERAN', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 36K| AAV 13K, 23K| Ext: Cleon')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0005', '15256',
   'Williams, Javonte', 'RB',
   'EXT2', 27000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 54K| Ext: Hammer')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0005', '15259',
   'Stevenson, Rhamondre', 'RB',
   'ROOKIE|VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 20K| AAV 5K, 15K| Y1-5K, Y2-15K| Ext: Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0005', '15259',
   'Stevenson, Rhamondre', 'RB',
   'VETERAN', 8000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 40K| AAV 15K/25K| Y1-8K, Y2-32K| Ext: Mafia, Hamme')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0002', '15271',
   'Herbert, Khalil', 'RB',
   'ROOKIE/VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 14K| AAV 2K, 12K| Y1-2 Y2- 12| Ext: Hammer')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '15281',
   'Chase, Ja''Marr', 'WR',
   'ROOKIE/VETERAN', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 82K| AAV 14K, 34K| Y1-14K Y2- 34K Y3-34K| Ext. Cre')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0005', '15281',
   'Chase, Ja''Marr', 'WR',
   'EXT1', 33000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 162K| AAV 34K, AAV 54K| Y1-33K, Y2-64K, Y3-65K| Ex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '15282',
   'Smith, DeVonta', 'WR',
   'ROOKIE/VETERAN', 6000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 22K| AAV 6K, 16K|Y1-6 Y2-16|Ext: GRide')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0002', '15282',
   'Smith, DeVonta', 'WR',
   'VETERAN', 16000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 42K| AAV 16K|Y1-16 Y2-26|Ext: GRide, CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0011', '15284',
   'Waddle, Jaylen', 'WR',
   'EXT2', 30000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 60K| AAV 30K| Ext: Cleon')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0001', '15287',
   'St. Brown, Amon-Ra', 'WR',
   'EXT2', 25000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 50K| AAV 25K| Ext: UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '15289',
   'Toney, Kadarius', 'WR',
   'ROOKIE/VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 20K| AAV 5K, 15K| Y1-5K Y2-15K| Ext: BB')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0002', '15290',
   'Collins, Nico', 'WR',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 44K| Ext: C-Town')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0002', '15290',
   'Collins, Nico', 'WR',
   'EXT1', 16000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 110K| AAV 22K, 42K |Y1-16K, Y2-47K, Y3-47K|  Ext: ')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0010', '15293',
   'Bateman, Rashod', 'WR',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0006', '15319',
   'Palmer, Joshua', 'WR',
   'EXT2-FL', 33000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 44K| AAV 22K| Y1- 33K, Y2-11K Ext: Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0008', '15329',
   'Pitts, Kyle', 'TE',
   'ROOKIE/VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 69K| AAV 15K, 27K| Y1-15 Y2- 27 Y3- 27| Ext: Gride')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0005', '15331',
   'Freiermuth, Pat', 'TE',
   'EXT1', 12000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 1| TCV 12K| Ext: Hammer')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0006', '15337',
   'Gray, Noah', 'TE',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 3K| AAV 1K| Y1-1, Y2-1, Y3-1')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0003', '15355',
   'Bolton, Nick', 'LB',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0008', '15708',
   'Hall, Breece', 'RB',
   'EXT2', 35000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 70K| AAV 35K, 35K| Y1-35K, Y2-35K| Ext: Blake')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0012', '15710',
   'Williams, Kyren', 'RB',
   'EXT2', 22000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 44K| AAV 22K, 22K| Y1-22K, Y2-22K| Ext: Hawks')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '15711',
   'Walker III, Kenneth', 'RB',
   'ROOKIE/VETERAN', 12000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 76K| AAV 12K/32K| Y1-12, Y2-32, Y3-32| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0011', '15712',
   'Allgeier, Tyler', 'RB',
   'EXT1', 15000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 15K| AAV 15K| Y1-15K| Ext: Blake')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0009', '15715',
   'Cook, James', 'RB',
   'ROOKIE/VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 61K| AAV 7K/27K| Y1-7, Y2-27, Y3-27| Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '15716',
   'Robinson, Brian', 'RB',
   'EXT1', 15000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 15K| AAV 15K| Y1-15K| Ext: C-Town')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0002', '15742',
   'Warren, Jaylen', 'RB',
   'EXT1', 14000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 14K| AAV 14K| Y1-14K| Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '15749',
   'Pacheco, Isiah', 'RB',
   'ROOKIE/VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 20K| AAV 5K/15K| Y1- 5K Y2- 15K| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0004', '15751',
   'London, Drake', 'WR',
   'ROOKIE/VETERAN', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 79K| AAV 13K/33K| Y1-13, Y2-33, Y3-33| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0002', '15753',
   'Wilson, Garrett', 'WR',
   'EXT2-BL', 24000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 68K| AAV 34K| Y1-24, Y2-44| Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0010', '15754',
   'Olave, Chris', 'WR',
   'ROOKIE/VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 73K| AAV 11K/31K| Y1-11, Y2-31, Y3-31| Ext: BB')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0007', '15756',
   'Williams, Jameson', 'WR',
   'EXT1', 20000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 20K| AAV 20K| Y1-20K| Ext: Sex')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '15757',
   'Robinson, Wan''Dale', 'WR',
   'EXT2', 12000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 34K| AAV 12K, 22K| Y1-12K, Y2-22K| Ext: Blake, LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0009', '15762',
   'Pickens, George', 'WR',
   'EXT1', 19000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 19K| AAV 19K| Y1-19K| Ext: C-Town')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0005', '15794',
   'McBride, Trey', 'TE',
   'EXT2-BL', 9000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 44K| AAV 22K, 22K| Y1-9K, Y2-35K| Ext: Hammer')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0002', '15798',
   'Likely, Isaiah', 'TE',
   'EXT1', 12000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 12K| AAV 12K| Y1-12K| Ext: CBP')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0010', '15799',
   'Ferguson, Jake', 'TE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 12K| AAV 1K/ 11K| Y1-1, Y2-11| Ext: Blake')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0008', '15799',
   'Ferguson, Jake', 'TE',
   'VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 32K| AAV 11K, 21K| Y1-11, Y2-21| Ext: Blake, UW')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0008', '15805',
   'Hutchinson, Aidan', 'DE',
   'ROOKIE/VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 7K| AAV 2K/5K| Y1-2K, Y2-5K| Ext: Cleon')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0005', '15834',
   'Hamilton, Kyle', 'S',
   'EXT1', 5000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 1| TCV 5K| AAV 5K| Y1-5K| Ext: Hammer')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2023', '0012', '15894',
   'Woolen, Tariq', 'CB',
   'EXT1', 6000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:extension_flag; ci=CL 2| TCV 12K| AAV 6K| Ext: Hawks')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '15972',
   'Mason, Jordan', 'RB',
   'EXT1', 14000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 52K| AAV 4K, 24K| Y1-14, Y2-14, Y3-24| Ext: LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0004', '16162',
   'Gibbs, Jahmyr', 'RB',
   'VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 73K| AAV 11K, 31K| Y1-11K, Y2-31K, Y3-31K| Ext: Se')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0003', '16167',
   'Achane, De''Von', 'RB',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 55K| AAV 5K, 25K| Ext: Gride')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0006', '16178',
   'Mitchell, Keaton', 'RB',
   'VETERAN', 18000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 1| TCV 18K| AAV 18K| Ext: Mafia')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0009', '16185',
   'Smith-Njigba, Jaxon', 'WR',
   'FL', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 70K| AAV 10K, 30K| Y1-14K, Y2-1K, Y3-55K| Ext: C-T')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0005', '16186',
   'Addison, Jordan', 'WR',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 24K| AAV 7K, 17K| Ext: LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0003', '16187',
   'Downs, Josh', 'WR',
   'VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 2| TCV 14K| AAV 2K, 14K| Y1-2 Y2-12| Ext: GRide')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0004', '16190',
   'Flowers, Zay', 'WR',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 55K| AAV 5K, 25K| Y1-5, Y2-25, Y3-25| Ext: GRide')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0006', '16194',
   'Rice, Rashee', 'WR',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 55K| AAV 5K, 25K| Y1-5 Y2-25, Y3-25| Ext: LH')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0007', '16204',
   'Dell, Tank', 'WR',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0010', '16206',
   'Wilson, Michael', 'WR',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 15K| AAV 5K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0004', '16213',
   'Kincaid, Dalton', 'TE',
   'VETERAN', 9000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 67K| AAV 9K, 29K| Ext: PG')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0006', '16223',
   'Anderson, Will', 'DE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0007', '16239',
   'Campbell, Jack', 'LB',
   'VETERAN', 3000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 3| TCV 9K| AAV 3K| Y1-3, Y2-3, Y3-3')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2024', '0010', '16342',
   'Douglas, Demario', 'WR',
   'ROOKIE/VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:extension_flag; ci=CL 2| TCV 14K| AAV 2K/12K |Y1-2 Y2-12| Ext: Blake')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2025', '0003', '16643',
   'Sanders, Ja''Tavion', 'TE',
   'VETERAN', 1000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:extension_flag; ci=CL 3| TCV 3K| AAV 1K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2020', '0005', '4925',
   'Brees, Drew', 'QB',
   'VETERAN GF', 24000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:ci_ext_token; ci=Ext CMC 20')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0012', '5848',
   'Brady, Tom', 'QB',
   'VETERAN', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Restructured Ext WP 17 & 18 [31K, 31K, 32K] (AAV 42K)')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0010', '7236',
   'Gates, Antonio', 'TE',
   'VETERAN', 1000, NULL, NULL,
   0, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:extension_flag; ci=')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2017', '0012', '8687',
   'Olsen, Greg', 'TE',
   'EXT2', 26000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:ci_ext_token; ci=Ext. BTNH 15 UW 16 , UW Tag 17, Ext WP 18, 19 [26K, 38K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2018', '0012', '8687',
   'Olsen, Greg', 'TE',
   'VETERAN', 38000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:ci_ext_token; ci=Ext. BTNH 15 UW 16 , UW Tag 17, Ext WP 18, 19 [38K, 38K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0008', '9431',
   'Stafford, Matthew', 'QB',
   'EXT1', 3000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:extension_flag; ci=TCV 9K')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '9431',
   'Stafford, Matthew', 'QB',
   'EXT1', 14000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2022' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2022:extension_flag; ci=CL 3| TCV 67K| AAV 15K/22K| Y1-14 Y2-26 Y3-27')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

