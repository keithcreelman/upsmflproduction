-- 0071_extension_master_2022_xlsx_backfill.sql
-- 2022 extension backfill sourced from the undated Contract_Transaction_Log.xlsx
-- (Keith confirmed 2026-05-24: "This has 2022 in excel file").
-- Same canonical math as 0063 (post-extension AAV = pre + bump,
-- TCV = pre_carry + new_aav * term).

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '13772',
   'Dalton Schultz', 'TE',
   'EXT1', 7000, 1, NULL,
   1, 20000, 13000, 15000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '11150',
   'Geno Smith', 'QB',
   'EXT1', 5000, 1, NULL,
   1, 16000, 11000, 12000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14800',
   'J.K. Dobbins', 'RB',
   'EXT1', 13000, 1, NULL,
   1, 36000, 23000, 27000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '13589',
   'Josh Allen', 'QB',
   'EXT2', 8000, 2, NULL,
   2, 48000, 20000, 36000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '13671',
   'Mark Andrews', 'TE',
   'EXT1', 3000, 1, NULL,
   1, 12000, 9000, 9000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14225',
   'Maxx Crosby', 'DE',
   'EXT1', 1000, 1, NULL,
   1, 5000, 4000, 3750, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14079',
   'Miles Sanders', 'RB',
   'EXT1', 22000, 1, NULL,
   1, 54000, 32000, 40500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0001', '14085',
   'Tony Pollard', 'RB',
   'EXT1', 12000, 1, NULL,
   1, 34000, 22000, 25500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0003', '13128',
   'Dalvin Cook', 'RB',
   'EXT1', 40000, 1, NULL,
   1, 90000, 50000, 67500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '13132',
   'Alvin Kamara', 'RB',
   'EXT2', 45000, 2, NULL,
   2, 175000, 65000, 131250, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14102',
   'DK Metcalf', 'WR',
   'EXT2', 25000, 2, NULL,
   2, 115000, 45000, 86250, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14075',
   'Damien Harris', 'RB',
   'EXT1', 15000, 1, NULL,
   1, 40000, 25000, 30000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14080',
   'Devin Singletary', 'RB',
   'EXT1', 5000, 1, NULL,
   1, 20000, 15000, 15000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14208',
   'Diontae Johnson', 'WR',
   'EXT2', 25000, 2, NULL,
   2, 50000, 25000, 37500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14147',
   'Nick Bosa', 'DE',
   'EXT2', 7000, 2, NULL,
   2, 14000, 7000, 10500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '13604',
   'Saquon Barkley', 'RB',
   'EXT1', 35000, 1, NULL,
   1, 80000, 45000, 60000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '14138',
   'T.J. Hockenson', 'TE',
   'EXT2', 20000, 2, NULL,
   2, 40000, 20000, 30000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0004', '11247',
   'Zach Ertz', 'TE',
   'EXT2', 11000, 2, NULL,
   2, 57000, 23000, 42750, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0006', '14797',
   'D''Andre Swift', 'RB',
   'EXT1', 21000, 1, NULL,
   1, 21000, 21000, 15750, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0006', '14109',
   'Terry McLaurin', 'WR',
   'EXT2', 22000, 2, NULL,
   2, 44000, 22000, 33000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '14104',
   'A.J. Brown', 'WR',
   'EXT2', 26000, 2, NULL,
   2, 52000, 26000, 39000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '15850',
   'Jalen Pitre', 'S',
   'EXT1', 1000, 1, NULL,
   1, 5000, 4000, 3750, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '14813',
   'James Robinson', 'RB',
   'EXT1', 4000, 1, NULL,
   1, 18000, 14000, 13500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '14836',
   'Justin Jefferson', 'WR',
   'EXT2', 8000, 2, NULL,
   2, 64000, 28000, 48000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0007', '14842',
   'Michael Pittman', 'WR',
   'EXT1', 5000, 1, NULL,
   1, 20000, 15000, 15000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '14867',
   'Cole Kmet', 'TE',
   'EXT1', 2000, 1, NULL,
   1, 10000, 8000, 7500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0008', '13593',
   'Lamar Jackson', 'QB',
   'EXT2', 17000, 2, NULL,
   2, 75000, 29000, 56250, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '13635',
   'D.J. Moore', 'WR',
   'EXT2', 29000, 2, NULL,
   2, 127000, 49000, 95250, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '13610',
   'Nick Chubb', 'RB',
   'EXT2', 27000, 2, NULL,
   2, 121000, 47000, 90750, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0009', '11244',
   'Travis Kelce', 'TE',
   'EXT2', 26000, 2, NULL,
   2, 102000, 38000, 76500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0010', '14123',
   'Hunter Renfrow', 'WR',
   'EXT2', 2000, 2, NULL,
   2, 46000, 22000, 34500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0010', '13154',
   'Mike Williams', 'WR',
   'EXT1', 6000, 1, NULL,
   1, 22000, 16000, 16500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '14071',
   'David Montgomery', 'RB',
   'EXT2', 24000, 2, NULL,
   2, 112000, 44000, 84000, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2022', '0012', '14081',
   'Myles Gaskin', 'RB',
   'EXT2', 2000, 2, NULL,
   2, 46000, 22000, 34500, NULL,
   'contract-transaction-log-xlsx', '2022-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:Contract_Transaction_Log.xlsx')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  new_contract_status  = excluded.new_contract_status,
  new_salary           = COALESCE(excluded.new_salary, ups_extension_master.new_salary),
  new_contract_year    = excluded.new_contract_year,
  extension_term_years = excluded.extension_term_years,
  new_tcv              = COALESCE(excluded.new_tcv, ups_extension_master.new_tcv),
  new_aav              = COALESCE(excluded.new_aav, ups_extension_master.new_aav),
  new_gtd              = COALESCE(excluded.new_gtd, ups_extension_master.new_gtd),
  source               = excluded.source,
  updated_at_utc       = excluded.updated_at_utc,
  evidence_grade       = excluded.evidence_grade,
  evidence_source      = excluded.evidence_source;
