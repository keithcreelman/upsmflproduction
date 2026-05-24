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
  ('74598', '2017', '0001', '10261',
   'Green, A.J.', 'WR',
   'STANDARD', 60000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Ebner 14, 15 Blake 16 CBP 17 [50K, 60K]')
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
  ('74598', '2018', '0005', '10261',
   'Green, A.J.', 'WR',
   'TAGGED', 70000, NULL, NULL,
   0, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. Ebner 14, 15 Blake 16 CBP 17 F-Tag UW 18')
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
  ('74598', '2018', '0008', '10271',
   'Jones, Julio', 'WR',
   'FL', 49000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. RB 14 TCBOO 15 CBP 16, 17 C-Town 18 (Restructured)')
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
  ('74598', '2017', '0006', '10276',
   'Ingram, Mark', 'RB',
   'EXT1', 33000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. UW 17, Gordon 18 [33K, 17K]  Avg 20/30')
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
  ('74598', '2018', '0002', '10276',
   'Ingram, Mark', 'RB',
   'FL', 17000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. UW 17, Gordon 18 [33K, 17K]  AAV ($30K)')
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
  ('74598', '2017', '0005', '10369',
   'Powell, Bilal', 'RB',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext 18 Son [1K, 11K]')
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
  ('74598', '2018', '0005', '10369',
   'Powell, Bilal', 'RB',
   'VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext 18 Son [1K, 11K]')
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
  ('74598', '2017', '0001', '10527',
   'Baldwin, Doug', 'WR',
   'EXT1', 29000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. CTown 17, 18 [29K,15K] Avg. Annual $22')
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
  ('74598', '2018', '0001', '10527',
   'Baldwin, Doug', 'WR',
   'FL', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. CTown 17, 18 [29K,15K] (AAV $22K)')
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
  ('74598', '2020', '0012', '10723',
   'Sanu, Mohamed', 'WR',
   'VETERAN', 16000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Hawks 20 [6K, 16K] TCV 22K')
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
  ('74598', '2017', '0012', '10753',
   'Jones, Chandler', 'DE',
   'STANDARD', 10000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. WP 16, 17 [10K, 10K]')
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
  ('74598', '2023', '0001', '11150',
   'Smith, Geno', 'QB',
   'VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 20K| AAV 5K|  Y1-5 Y2-15| Ext: UW')
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
  ('74598', '2019', '0010', '11232',
   'Hopkins, DeAndre', 'WR',
   'BL', 54000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Ext. CBP 16, 17 Blake 18 Hood 19 & 20 [54K, 64K] TCV 11')
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
  ('74598', '2020', '0009', '11232',
   'Hopkins, DeAndre', 'WR',
   'BL', 64000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. CBP 16, 17 Blake 18 Hood 19 & 20 [54K, 64K] TCV 11')
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
  ('74598', '2023', '0005', '11244',
   'Kelce, Travis', 'TE',
   'BL', 52000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 128K| AAV 64KK| Y1-52, Y2-76| Ext: Chivalry')
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
  ('74598', '2024', '0005', '11244',
   'Kelce, Travis', 'TE',
   'BL', 76000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 128K| AAV 64K| Y1-52, Y2-76| Ext: Chivalry')
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
  ('74598', '2023', '0009', '11247',
   'Ertz, Zach', 'TE',
   'VETERAN', 23000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 3| TCV 57K| AAV 23K|  Y1-11 Y2-23 Y3-23| Ext: Hawks, PG')
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
  ('74598', '2017', '0002', '11248',
   'Reed, Jordan', 'TE',
   'EXT1', 32000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Blake 16, CBP 17, 18 [12K, 32K, 32K]')
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
  ('74598', '2017', '0012', '11293',
   'Ogletree, Alec', 'LB',
   'STANDARD', 8000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. WP 16, 17 [8K, 8K]')
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
  ('74598', '2020', '0005', '11317',
   'Poyer, Jordan', 'S',
   'VETERAN GF', 9000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. CMC 20 [6K, 9K]')
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
  ('74598', '2017', '0004', '11390',
   'Murray, Latavius', 'RB',
   'FRONTLOADED', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. CBP 16 & 17 [29K, 15K] Avg. 22K')
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
  ('74598', '2017', '0002', '11644',
   'Carr, Derek', 'QB',
   'EXT1', 14000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. WP 17, 18 [14K,14K]')
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
  ('74598', '2018', '0002', '11644',
   'Carr, Derek', 'QB',
   'VETERAN', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. WP 17, 18 [14K,14K]')
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
  ('74598', '2018', '0001', '11660',
   'Freeman, Devonta', 'RB',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. UW 17, 18')
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
  ('74598', '2017', '0008', '11668',
   'Crowell, Isaiah', 'RB',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. 17, 18 Gordon')
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
  ('74598', '2017', '0010', '11671',
   'Evans, Mike', 'WR',
   'EXT1', 34000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Gordon 17 & 18')
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
  ('74598', '2020', '0008', '11671',
   'Evans, Mike', 'WR',
   'VETERAN', 54000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Gordon 17 & 18 CTown 19  GRide 20  TCV 98K')
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
  ('74598', '2017', '0009', '11672',
   'Lee, Marqise', 'WR',
   'STANDARD', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Ctown 17')
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
  ('74598', '2017', '0003', '11673',
   'Benjamin, Kelvin', 'TE',
   'EXT1', 25000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. RB 17,18')
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
  ('74598', '2017', '0010', '11674',
   'Cooks, Brandin', 'WR',
   'EXT1', 29000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Blake 17 & 18')
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
  ('74598', '2020', '0002', '11674',
   'Cooks, Brandin', 'WR',
   'BL', 43000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Blake 17 & 18 Bash 19 UW 20  TCV 78K AAV 49K')
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
  ('74598', '2019', '0005', '11678',
   'Robinson, Allen', 'WR',
   'VETERAN GF', 38000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Ext. Mather 17 & 18 GRide 19 & 20 Restructured [38K,39K]')
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
  ('74598', '2019', '0007', '11679',
   'Beckham, Odell', 'WR',
   'VETERAN GF', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Ext. UW 17, 18 Manther 19 & 20 [28K,48K,48K]')
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
  ('74598', '2017', '0012', '11706',
   'Clowney, Jadeveon', 'DE',
   'EXT1', 10000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. WP 17, 18 [10K,10K]')
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
  ('74598', '2018', '0012', '11706',
   'Clowney, Jadeveon', 'DE',
   'VETERAN', 10000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. WP 17, 18 [10K,10K]')
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
  ('74598', '2017', '0007', '11757',
   'Donald, Aaron', 'DT',
   'STANDARD', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. Manther 17')
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
  ('74598', '2018', '0007', '11757',
   'Donald, Aaron', 'DT',
   'TAGGED', 7000, NULL, NULL,
   0, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Ext. Manther 17 Tag Manther 18')
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
  ('74598', '2018', '0011', '12159',
   'Allen, Javorius', 'RB',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=Restructure Ext. Blake 18 [17K, 7K] (AAV 17K)')
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
  ('74598', '2020', '0010', '12221',
   'Hunter, Danielle', 'DE',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Blake 20 TCV 11K [4K, 7K]')
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
  ('74598', '2024', '0002', '12611',
   'Goff, Jared', 'QB',
   'BL', 26000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 56K| AAV 35K| Y1-26, Y2-30K| Ext: Sex')
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
  ('74598', '2025', '0002', '12611',
   'Goff, Jared', 'QB',
   'BL', 30000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 56K| AAV 35K| Y1-26, Y2-30K| Ext: Sex')
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
  ('74598', '2020', '0007', '12630',
   'Drake, Kenyan', 'RB',
   'VETERAN', 31000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Manther 20 [21K, 31K] TCV 52K')
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
  ('74598', '2019', '0005', '12634',
   'Howard, Jordan', 'RB',
   'VETERAN GF', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Ext. Son 19 [5K, 25K,25K]')
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
  ('74598', '2019', '0007', '12686',
   'Bosa, Joey', 'DE',
   'VETERAN GF', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Ext. Manther [7K, 7K]')
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
  ('74598', '2019', '0002', '12801',
   'Hill, Tyreek', 'WR',
   'VETERAN GF', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=Restructure Ext. Manther 19 - 20 [14K,15K]  AAV 21K')
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
  ('74598', '2023', '0006', '13128',
   'Cook, Dalvin', 'RB',
   'FL', 30000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 90K| AAV 50K|  Y1-60 Y2-30| Ext: Sex, GRide')
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
  ('74598', '2024', '0008', '13130',
   'McCaffrey, Christian', 'RB',
   'FL', 65000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 109K| AAV 65K| Y1-44 Y2-65| Ext: Creel, Hood, Hamm')
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
  ('74598', '2023', '0003', '13132',
   'Kamara, Alvin', 'RB',
   'VETERAN', 45000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 3| TCV 115K| AAV 45K| Y1-25 Y2-45 Y3-45| Ext: Chivalry, B')
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
  ('74598', '2020', '0004', '13154',
   'Williams, Mike', 'WR',
   'VETERAN GF', 22000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Hawks 20 [12K, 22K]')
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
  ('74598', '2023', '0011', '13164',
   'Kupp, Cooper', 'WR',
   'VETERAN', 42000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 3| TCV 106K |AAV 42K| Y1-22 Y2-42 Y3-42| Ext: Bash, Sex')
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
  ('74598', '2020', '0011', '13192',
   'Njoku, David', 'TE',
   'VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Manther 20')
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
  ('74598', '2018', '0001', '13232',
   'King, Desmond', 'CB',
   'EXT2-FL', 10000, NULL, NULL,
   2, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2018' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2018:; ci=FL Restructured Ext. Bash 19 & 20 [10K,7K,2K] (AAV 3K, 8K,')
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
  ('74598', '2019', '0005', '13232',
   'King, Desmond', 'CB',
   'FL GF', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2019' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2019:; ci=FL Restructured Ext. Bash 19 & 20 [7K,2K] AAV 8K Overpay 7')
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
  ('74598', '2024', '0003', '13299',
   'Kittle, George', 'TE',
   'FL', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 49K| AAV 32K| Y1-17 Y2-32| Ext: PG, Sex, GRide')
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
  ('74598', '2020', '0008', '13304',
   'Brown, Jayon', 'LB',
   'VETERAN', 4000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. BLM 20 [1K, 4K] TCV 5K')
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
  ('74598', '2020', '0008', '13378',
   'Breida, Matt', 'RB',
   'VETERAN', 22000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. Blake 19 BLM 20 TCV 29K')
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
  ('74598', '2020', '0005', '13470',
   'Moore, Kenny', 'CB',
   'VETERAN', 6000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2020' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2020:; ci=Ext. CMC 20 [3K, 6K] TCV 9K')
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
  ('74598', '2023', '0006', '13590',
   'Mayfield, Baker', 'QB',
   'EXT1', 5000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 20K| AAV 5K, 15K|Y1-5 Y2-15|Ext: Blake')
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
  ('74598', '2024', '0010', '13590',
   'Mayfield, Baker', 'QB',
   'VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 20K| AAV 15K|Y1-5 Y2-15|Ext: Blake')
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
  ('74598', '2024', '0011', '13604',
   'Barkley, Saquon', 'RB',
   'VETERAN', 55000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 90K| AAV 55K| Y1-45 Y2-55| Ext: Sex, PG, Creel')
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
  ('74598', '2023', '0010', '13610',
   'Chubb, Nick', 'RB',
   'VETERAN', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 96K| AAV 47K| Ext: PG, Chivalry')
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
  ('74598', '2024', '0010', '13610',
   'Chubb, Nick', 'RB',
   'VETERAN', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 96K| AAV 47K| Ext: PG, Chivalry')
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
  ('74598', '2025', '0012', '13629',
   'Ridley, Calvin', 'WR',
   'VETERAN', 28000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 46K| AAV 28K| Y1-24 Y2-28| Ext: Sex')
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
  ('74598', '2023', '0010', '13635',
   'Moore, D.J.', 'WR',
   'FL', 61000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 101K| AAV 49K |Y1-61 Y2-40| Ext: UW, Chivalry')
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
  ('74598', '2024', '0010', '13635',
   'Moore, D.J.', 'WR',
   'FL', 40000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 101K| AAV 49K |Y1-61 Y2-40| Ext: UW, Chivalry')
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
  ('74598', '2024', '0002', '13671',
   'Andrews, Mark', 'TE',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 3| TCV 63K| AAV 27K| Y1-9K, Y2-27K, Y3-27K| Ext: BB, UW')
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
  ('74598', '2025', '0002', '13671',
   'Andrews, Mark', 'TE',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 63K| AAV 27K| Y1-9K, Y2-27K, Y3-27K| Ext: Blake, U')
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
  ('74598', '2023', '0011', '13772',
   'Schultz, Dalton', 'TE',
   'VETERAN', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 20K| AAV 13K|  Y1-7 Y2-13| Ext: Creel')
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
  ('74598', '2023', '0006', '13850',
   'Edwards, Gus', 'RB',
   'EXT1', 4000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2 TCV 14K| AAV 4K, 14K| Y1-4K, Y2-14K| Ext.: UW')
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
  ('74598', '2024', '0001', '13850',
   'Edwards, Gus', 'RB',
   'VETERAN', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2 TCV 14K| AAV 14K| Y1-4K, Y2-14K| Ext: UW')
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
  ('74598', '2024', '0007', '14073',
   'Jacobs, Josh', 'RB',
   'FL', 45000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 80K| AAV 35K |Y1-35 Y2-45| Ext: Hood, Sex')
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
  ('74598', '2023', '0012', '14075',
   'Harris, Damien', 'RB',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 40K| AAV 25K| Y1-15 Y2-25| Ext: Hawks')
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
  ('74598', '2023', '0001', '14079',
   'Sanders, Miles', 'RB',
   'VETERAN', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 54K| AAV 32K| Y1-22K Y2-32K| Ext: Gride, UW')
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
  ('74598', '2023', '0001', '14085',
   'Pollard, Tony', 'RB',
   'BL', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 34K| AAV 22K| Y1-7 Y2-27| Ext: Chivalry, UW')
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
  ('74598', '2023', '0004', '14102',
   'Metcalf, DK', 'WR',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 50K| AAV 25K| Ext: Creel')
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
  ('74598', '2024', '0005', '14104',
   'Brown, A.J.', 'WR',
   'BL', 19000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 92K| AAV 46K|Y1-19 Y2-73 | Ext: Sex, Creel')
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
  ('74598', '2024', '0008', '14109',
   'McLaurin, Terry', 'WR',
   'VETERAN', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 54K| AAV 32K| Ext: Mafia')
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
  ('74598', '2024', '0010', '14136',
   'Samuel, Deebo', 'WR',
   'VETERAN', 35000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 60K| AAV 35K| Ext: Chivalry, Sex')
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
  ('74598', '2024', '0010', '14138',
   'Hockenson, T.J.', 'TE',
   'BL', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 64K| AAV 32K| Y1-13K, Y2-51K| Ext: PG, Sex')
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
  ('74598', '2023', '0001', '14147',
   'Bosa, Nick', 'DE',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 14K| AAV 7K| Ext: PG')
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
  ('74598', '2024', '0003', '14208',
   'Johnson, Diontae', 'WR',
   'VETERAN', 48000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 60K| AAV 35K| Y1-12 Y2-48| Ext: PG')
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
  ('74598', '2023', '0001', '14225',
   'Crosby, Maxx', 'DE',
   'VETERAN', 4000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 5K| AAV 4K|  Y1-1 Y2-4| Ext: UW')
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
  ('74598', '2025', '0009', '14778',
   'Tagovailoa, Tua', 'QB',
   'FL', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 116K| AAV 49K| Y1-86 Y2-15 Y3-15| Ext: C-Town')
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
  ('74598', '2025', '0002', '14782',
   'Love, Jordan', 'QB',
   'VETERAN', 21000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 43K| AAV 21K| Y1-1, Y2-21, Y3-21| Ext: PG')
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
  ('74598', '2025', '0005', '14783',
   'Hurts, Jalen', 'QB',
   'BL', 17000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 84K| AAV 42K| Y1-17K, Y2-67K| Ext: Gride, Hammer')
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
  ('74598', '2023', '0003', '14797',
   'Swift, D''Andre', 'RB',
   'VETERAN', 21000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 32K| AAV 21K| Y1-11 Y2-21| Ext: Hood')
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
  ('74598', '2023', '0011', '14800',
   'Dobbins, J.K.', 'RB',
   'VETERAN', 13000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 36K| AAV 23K| Y1-13 Y2-23| Ext: UW')
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
  ('74598', '2024', '0002', '14802',
   'Taylor, Jonathan', 'RB',
   'VETERAN', 24000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 68K| AAV 34K| Y1-44 Y2-24 Ext: CBP')
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
  ('74598', '2025', '0008', '14823',
   'Dowdle, Rico', 'RB',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 12K| AAV 1K, 11K| Ext: Blake')
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
  ('74598', '2025', '0011', '14832',
   'Lamb, CeeDee', 'WR',
   'VETERAN', 64000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 172K| AAV 64K| Y1- 44K Y2- 64K Y3- 64K| Ext: UW, C')
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
  ('74598', '2025', '0008', '14836',
   'Jefferson, Justin', 'WR',
   'BL', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 96K| AAV 48K| Y1-25K, Y2-71K| Ext:  Sex, Hammer')
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
  ('74598', '2024', '0002', '14840',
   'Aiyuk, Brandon', 'WR',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 40K| AAV 25K |Y1-15 Y2-25| Ext: CBP')
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
  ('74598', '2025', '0003', '14842',
   'Pittman, Michael', 'WR',
   'VETERAN', 45000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 115K| AAV 45K| Y1-25K Y2-45K Y3-45K| Ext: PG')
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
  ('74598', '2024', '0011', '14860',
   'Jennings, Jauan', 'WR',
   'EXT1', 1000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 12K| AAV 1K| Y1-1 Y2-11| Ext: Creel')
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
  ('74598', '2025', '0008', '14860',
   'Jennings, Jauan', 'WR',
   'VETERAN', 11000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 12K| AAV 11K| Y1-1 Y2-11| Ext: Creel')
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
  ('74598', '2023', '0001', '14867',
   'Kmet, Cole', 'TE',
   'VETERAN', 8000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 2| TCV 10K| AAV 8K|  Y1-2 Y2-8| Ext: Creel')
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
  ('74598', '2024', '0006', '14974',
   'Mooney, Darnell', 'WR',
   'EXT1', 2000, NULL, NULL,
   1, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 14K| AAV 2K/12K |Y1-2 Y2-12| Ext: CBD')
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
  ('74598', '2025', '0002', '14974',
   'Mooney, Darnell', 'WR',
   'VETERAN', 12000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 14K| AAV 12K |Y1-2 Y2-12| Ext: CBP')
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
  ('74598', '2025', '0006', '15238',
   'Fields, Justin', 'QB',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 50K| Ext: PG')
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
  ('74598', '2024', '0002', '15254',
   'Harris, Najee', 'RB',
   'VETERAN', 23000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 36K| AAV 23K| Ext: Cleon')
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
  ('74598', '2025', '0005', '15256',
   'Williams, Javonte', 'RB',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 54K| Ext: Hammer')
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
  ('74598', '2025', '0011', '15259',
   'Stevenson, Rhamondre', 'RB',
   'BL', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 40K| AAV 25K| Y1-8K, Y2-32K| Ext: Mafia, Hammer')
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
  ('74598', '2024', '0003', '15281',
   'Chase, Ja''Marr', 'WR',
   'BL', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 2| TCV 68K| AAV 34K| Y1-14K Y2- 54K| Ext: Creel')
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
  ('74598', '2025', '0002', '15282',
   'Smith, DeVonta', 'WR',
   'VETERAN', 26000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 42K| AAV 26K|Y1-16 Y2-26|Ext: GRide, CBP')
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
  ('74598', '2025', '0011', '15284',
   'Waddle, Jaylen', 'WR',
   'VETERAN', 30000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 60K| AAV 30K| Ext: Cleon')
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
  ('74598', '2025', '0001', '15287',
   'St. Brown, Amon-Ra', 'WR',
   'VETERAN', 25000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 50K| AAV 25K| Ext: UW')
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
  ('74598', '2024', '0008', '15329',
   'Pitts, Kyle', 'TE',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 3| TCV 69K| AAV 27K| Y1-15 Y2- 27 Y3- 27| Ext: Gride')
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
  ('74598', '2025', '0006', '15329',
   'Pitts, Kyle', 'TE',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 69K| AAV 27K| Y1-15 Y2- 27 Y3- 27| Ext: Gride')
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
  ('74598', '2023', '0006', '15350',
   'Parsons, Micah', 'DE',
   'ROOKIE|VETERAN', 2000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2023' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2023:; ci=CL 3| TCV 16K| AAV 2K, 7K| Ext: Mafia')
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
  ('74598', '2024', '0001', '15350',
   'Parsons, Micah', 'DE',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2024' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2024:; ci=CL 3| TCV 16K| AAV 7K| Ext: Mafia')
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
  ('74598', '2025', '0001', '15350',
   'Parsons, Micah', 'DE',
   'VETERAN', 7000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 16K| AAV 7K| Ext: Mafia')
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
  ('74598', '2025', '0009', '15711',
   'Walker III, Kenneth', 'RB',
   'VETERAN', 32000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 76K| AAV 32K| Y1-12, Y2-32, Y3-32| Ext: PG')
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
  ('74598', '2025', '0009', '15715',
   'Cook, James', 'RB',
   'VETERAN', 27000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 3| TCV 61K| AAV 27K| Y1-7, Y2-27, Y3-27| Ext: CBP')
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
  ('74598', '2025', '0001', '15749',
   'Pacheco, Isiah', 'RB',
   'VETERAN', 15000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 20K| AAV 5K/15K| Y1- 5K Y2- 15K| Ext: PG')
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
  ('74598', '2025', '0009', '15751',
   'London, Drake', 'WR',
   'BL', 14000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 66K| AAV 33K| Y1-14, Y2-52| Ext: PG')
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
  ('74598', '2025', '0004', '15754',
   'Olave, Chris', 'WR',
   'FL', 51000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 62K| AAV 31K| Y1-51, Y2-11| Ext: Blake')
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
  ('74598', '2025', '0004', '15805',
   'Hutchinson, Aidan', 'DE',
   'VETERAN', 5000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 7K| AAV 5K| Y1-2K, Y2-5K| Ext: Cleon')
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
  ('74598', '2025', '0004', '16342',
   'Douglas, Demario', 'WR',
   'VETERAN', 12000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2025' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2025:; ci=CL 2| TCV 14K| AAV 12K |Y1-2 Y2-12| Ext: Blake')
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
  ('74598', '2017', '0002', '9101',
   'Stewart, Jonathan', 'RB',
   'STANDARD', 23000, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL,
   'reconcile-derived', '2017' || '-01-01T00:00:00Z', datetime('now'),
   'derived', 'src_contracts:2017:; ci=Ext. BTNH 16 CBP 17 [13K, 23K]')
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

