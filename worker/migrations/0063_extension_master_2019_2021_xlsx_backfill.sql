-- 0062_extension_master_2019_2021_xlsx_backfill.sql
-- 2019-2021 extension backfill sourced from Keith's Contract Transaction
-- Log spreadsheets (xlsx attached 2026-05-24). Evidence grade='evidenced'
-- because each row came from the canonical league-tracked Google Form
-- response sheet; evidence_source identifies the file.
--
-- Skipped:
--   • Contract_Transaction_Log.xlsx (undated) — Keith asked to skip; only
--     10/34 player overlap with 2021 file, salary cols 2020/2021/2022 are
--     ambiguous. Handle in a follow-up after scope is clear.
--   • Rows with unresolved player_id or franchise_id (logged in /tmp/
--     extensions_2019_2021_raw.csv for manual review).
--
-- Dedup: within-file last-wins by (season, player_id).
--

INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '2019', '0001', '11938',
   'Adam Thielen', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 20000, 10000, 15000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0001', '11674',
   'Brandin Cooks', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 39000, 10000, 29250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0001', '12611',
   'Jared Goff', 'QB',
   'EXT1', 6000, 1, NULL,
   1, 11000, 6000, 8250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0002', '12752',
   'Kevin Byard', 'S',
   'EXT1', 3000, 1, NULL,
   1, 10000, 3000, 7500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0002', '11721',
   'Khalil Mack', 'LB',
   'EXT2', 5000, 2, NULL,
   2, 16000, 5000, 12000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0003', '13131',
   'Joe Mixon', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 53000, 20000, 39750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0003', '11671',
   'Mike Evans', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 54000, 10000, 40500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0004', '12175',
   'Amari Cooper', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 73000, 20000, 54750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0004', '12626',
   'Derrick Henry', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 49000, 20000, 36750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0004', '12647',
   'Will Fuller', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 46000, 20000, 34500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '13113',
   'Deshaun Watson', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 26000, 12000, 19500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '4925',
   'Drew Brees', 'QB',
   'EXT1', 6000, 1, NULL,
   1, 19000, 6000, 14250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '13230',
   'Jamal Adams', 'S',
   'EXT2', 5000, 2, NULL,
   2, 12000, 5000, 9000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '11317',
   'Jordan Poyer', 'S',
   'EXT1', 3000, 1, NULL,
   1, 9000, 3000, 6750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '13470',
   'Kenny Moore', 'CB',
   'EXT1', 3000, 1, NULL,
   1, 6000, 3000, 4500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '10729',
   'T.Y. Hilton', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 56000, 10000, 42000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0005', '12391',
   'Tyrell Williams', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 15000, 10000, 11250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0007', '13157',
   'Curtis Samuel', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 15000, 10000, 11250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0007', '13128',
   'Dalvin Cook', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 50000, 20000, 37500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0007', '12630',
   'Kenyan Drake', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 31000, 10000, 23250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0007', '13116',
   'Patrick Mahomes', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 26000, 12000, 19500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0008', '13364',
   'Chris Carson', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 41000, 20000, 30750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0008', '13130',
   'Christian McCaffrey', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 55000, 20000, 41250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0008', '13304',
   'Jayon Brown', 'LB',
   'EXT1', 3000, 1, NULL,
   1, 4000, 3000, 3000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0008', '13378',
   'Matt Breida', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 17000, 10000, 12750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0008', '12650',
   'Tyler Boyd', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 44000, 20000, 33000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0009', '13132',
   'Alvin Kamara', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0009', '12676',
   'Hunter Henry', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 29000, 12000, 21750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0010', '12610',
   'Carson Wentz', 'QB',
   'EXT1', 6000, 1, NULL,
   1, 8000, 6000, 6000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0010', '12221',
   'Danielle Hunter', 'DE',
   'EXT1', 3000, 1, NULL,
   1, 7000, 3000, 5250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0010', '12171',
   'David Johnson', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 42000, 10000, 31500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0010', '12186',
   'Stefon Diggs', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 62000, 20000, 46500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0010', '12150',
   'Todd Gurley', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 45000, 10000, 33750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0011', '13192',
   'David Njoku', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 11000, 6000, 8250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0011', '13189',
   'Evan Engram', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 31000, 12000, 23250, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0012', '13163',
   'Chris Godwin', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0012', '9474',
   'Jared Cook', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 28000, 12000, 21000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0012', '13154',
   'Mike Williams', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 22000, 10000, 16500, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2019', '0012', '10723',
   'Mohamed Sanu', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 16000, 10000, 12000, NULL,
   'contract-transaction-log-xlsx', '2019-01-01T00:00:00Z', datetime('now'),
   'evidenced', 'contract_transaction_log:2019_Contract_Tansaction_Log.xlsx')
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
  ('74598', '2020', '0001', '13146',
   'James Conner', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 25000, 10000, 18750, NULL,
   'contract-transaction-log-xlsx', '2020-09-07T22:59:31.200000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0001', '13234',
   'Marlon Mack', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 15000, 10000, 11250, NULL,
   'contract-transaction-log-xlsx', '2020-05-15T20:21:36.576000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0002', '12176',
   'DeVante Parker', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 14000, 10000, 10500, NULL,
   'contract-transaction-log-xlsx', '2020-05-12T14:09:33.408000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0002', '11516',
   'Jack Doyle', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 10000, 6000, 7500, NULL,
   'contract-transaction-log-xlsx', '2020-05-12T14:08:12.192000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0002', '13198',
   'Myles Garrett', 'DE',
   'EXT2', 5000, 2, NULL,
   2, 15000, 5000, 11250, NULL,
   'contract-transaction-log-xlsx', '2020-05-12T14:10:37.344000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0002', '12801',
   'Tyreek Hill', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 55000, 20000, 41250, NULL,
   'contract-transaction-log-xlsx', '2020-05-16T09:25:31.008000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0003', '13680',
   'Hayden Hurst', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 8000, 6000, 6000, NULL,
   'contract-transaction-log-xlsx', '2020-06-23T19:55:37.920000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0003', '13290',
   'Tarik Cohen', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 12000, 10000, 9000, NULL,
   'contract-transaction-log-xlsx', '2020-05-08T15:35:25.440000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0004', '13319',
   'Aaron Jones', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 42000, 20000, 31500, NULL,
   'contract-transaction-log-xlsx', '2020-05-08T05:35:03.552000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0004', '13299',
   'George Kittle', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 26000, 12000, 19500, NULL,
   'contract-transaction-log-xlsx', '2020-05-08T05:35:48.480000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0004', '13129',
   'Leonard Fournette', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 51000, 20000, 38250, NULL,
   'contract-transaction-log-xlsx', '2020-05-08T05:36:54.144000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0004', '13610',
   'Nick Chubb', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 47000, 20000, 35250, NULL,
   'contract-transaction-log-xlsx', '2020-10-18T08:33:13.824000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0005', '12686',
   'Joey Bosa', 'DE',
   'EXT1', 3000, 1, NULL,
   1, 10000, 3000, 7500, NULL,
   'contract-transaction-log-xlsx', '2020-05-09T12:53:21.984000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0007', '13733',
   'Darius Leonard', 'LB',
   'EXT2', 5000, 2, NULL,
   2, 12000, 5000, 9000, NULL,
   'contract-transaction-log-xlsx', '2020-04-30T12:21:56.736000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0007', '12676',
   'Hunter Henry', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 41000, 12000, 30750, NULL,
   'contract-transaction-log-xlsx', '2020-05-10T14:39:05.472000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0007', '13604',
   'Saquon Barkley', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 55000, 20000, 41250, NULL,
   'contract-transaction-log-xlsx', '2020-10-19T19:21:19.008000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0008', '11675',
   'Davante Adams', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 55000, 10000, 41250, NULL,
   'contract-transaction-log-xlsx', '2020-09-07T08:30:41.760000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0008', '14265',
   'Travis Fulgham', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 20000, 10000, 15000, NULL,
   'contract-transaction-log-xlsx', '2020-11-08T10:22:48', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0009', '12625',
   'Ezekiel Elliott', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 75000, 20000, 56250, NULL,
   'contract-transaction-log-xlsx', '2020-08-30T11:44:26.880000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '11938',
   'Adam Thielen', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 20000, 10000, 15000, NULL,
   'contract-transaction-log-xlsx', '2020-09-07T21:25:02.496000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '12626',
   'Derrick Henry', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 69000, 20000, 51750, NULL,
   'contract-transaction-log-xlsx', '2020-09-17T08:06:05.184000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '13138',
   'Kareem Hunt', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 29000, 10000, 21750, NULL,
   'contract-transaction-log-xlsx', '2020-09-07T20:36:10.080000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '13246',
   'Mo AlieCox', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 9000, 6000, 6750, NULL,
   'contract-transaction-log-xlsx', '2020-10-06T19:22:49.728000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '11679',
   'Odell Beckham', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 58000, 10000, 43500, NULL,
   'contract-transaction-log-xlsx', '2020-06-05T09:44:37.536000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0010', '12930',
   'Robby Anderson', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 27000, 10000, 20250, NULL,
   'contract-transaction-log-xlsx', '2020-10-06T19:26:04.128000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0011', '13156',
   'JuJu Smith_Schuster', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2020-05-14T10:49:01.344000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0012', '13629',
   'Calvin Ridley', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 46000, 20000, 34500, NULL,
   'contract-transaction-log-xlsx', '2020-12-07T20:50:57.408000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2020', '0012', '12647',
   'Will Fuller', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 66000, 20000, 49500, NULL,
   'contract-transaction-log-xlsx', '2020-11-09T21:02:06.144000', datetime('now'),
   'evidenced', 'contract_transaction_log:2020 Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0001', '11225',
   'Cordarrelle Patterson', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 11000, 10000, 8250, NULL,
   'contract-transaction-log-xlsx', '2021-07-19T13:18:27.936000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0001', '13635',
   'D.J. Moore', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 49000, 20000, 36750, NULL,
   'contract-transaction-log-xlsx', '2021-05-30T18:16:34.464000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0001', '11675',
   'Davante Adams', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 60000, 10000, 45000, NULL,
   'contract-transaction-log-xlsx', '2021-06-01T04:58:35.040000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0001', '13696',
   'Roquan Smith', 'LB',
   'EXT1', 3000, 1, NULL,
   1, 8000, 3000, 6000, NULL,
   'contract-transaction-log-xlsx', '2021-05-30T18:17:15.936000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0002', '12175',
   'Amari Cooper', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 30000, 10000, 22500, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T09:48:57.600000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0002', '13164',
   'Cooper Kupp', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 62000, 20000, 46500, NULL,
   'contract-transaction-log-xlsx', '2021-05-29T18:01:52.320000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0002', '13230',
   'Jamal Adams', 'S',
   'EXT1', 3000, 1, NULL,
   1, 10000, 3000, 7500, NULL,
   'contract-transaction-log-xlsx', '2021-05-29T18:05:10.176000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0002', '13713',
   'Minkah Fitzpatrick', 'S',
   'EXT1', 3000, 1, NULL,
   1, 4000, 3000, 3000, NULL,
   'contract-transaction-log-xlsx', '2021-05-29T18:03:50.688000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0002', '12186',
   'Stefon Diggs', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 52000, 10000, 39000, NULL,
   'contract-transaction-log-xlsx', '2021-07-19T13:09:59.904000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0003', '13593',
   'Lamar Jackson', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 29000, 12000, 21750, NULL,
   'contract-transaction-log-xlsx', '2021-05-30T17:27:16.128000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0004', '13726',
   'Chase Edmonds', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 42000, 20000, 31500, NULL,
   'contract-transaction-log-xlsx', '2021-05-19T16:49:58.368000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0004', '13630',
   'Courtland Sutton', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2021-05-19T16:50:48.480000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0004', '12626',
   'Derrick Henry', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 59000, 10000, 44250, NULL,
   'contract-transaction-log-xlsx', '2021-06-04T16:50:19.968000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0004', '9431',
   'Matthew Stafford', 'QB',
   'EXT1', 6000, 1, NULL,
   1, 9000, 6000, 6750, NULL,
   'contract-transaction-log-xlsx', '2021-05-26T12:23:06.720000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0005', '13364',
   'Chris Carson', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 21000, 10000, 15750, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T15:57:02.304000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0005', '14056',
   'Kyler Murray', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 29000, 12000, 21750, NULL,
   'contract-transaction-log-xlsx', '2021-05-29T16:04:07.392000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0006', '13130',
   'Christian McCaffrey', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 55000, 20000, 41250, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T21:32:13.632000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0006', '14073',
   'Josh Jacobs', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 55000, 20000, 41250, NULL,
   'contract-transaction-log-xlsx', '2021-05-16T06:42:03.744000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0006', '14903',
   'Trevon Diggs', 'CB',
   'EXT1', 3000, 1, NULL,
   1, 4000, 3000, 3000, NULL,
   'contract-transaction-log-xlsx', '2021-07-19T13:07:05.376000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0007', '13319',
   'Aaron Jones', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 32000, 10000, 24000, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T21:50:26.592000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0007', '13299',
   'George Kittle', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 38000, 12000, 28500, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T23:01:08.832000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0007', '11244',
   'Travis Kelce', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 36000, 6000, 27000, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T21:45:54.432000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0008', '13772',
   'Dalton Schultz', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 7000, 6000, 5250, NULL,
   'contract-transaction-log-xlsx', '2021-07-21T11:02:43.872000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0008', '13113',
   'Deshaun Watson', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 38000, 12000, 28500, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T09:55:49.728000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0008', '13737',
   'Jessie Bates', 'S',
   'EXT1', 3000, 1, NULL,
   1, 4000, 3000, 3000, NULL,
   'contract-transaction-log-xlsx', '2021-05-16T22:19:28.416000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0008', '13672',
   'Mike Gesicki', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 25000, 12000, 18750, NULL,
   'contract-transaction-log-xlsx', '2021-08-05T14:25:37.632000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0008', '13622',
   'Nyheim Hines', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 15000, 10000, 11250, NULL,
   'contract-transaction-log-xlsx', '2021-05-28T14:25:34.176000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '13668',
   'D.J. Chark', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2021-05-20T20:10:47.712000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '13674',
   'Dallas Goedert', 'TE',
   'EXT2', 12000, 2, NULL,
   2, 29000, 12000, 21750, NULL,
   'contract-transaction-log-xlsx', '2021-05-20T20:12:17.568000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '13128',
   'Dalvin Cook', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 40000, 10000, 30000, NULL,
   'contract-transaction-log-xlsx', '2021-05-30T18:17:59.136000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '14136',
   'Deebo Samuel', 'WR',
   'EXT2', 20000, 2, NULL,
   2, 45000, 20000, 33750, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T05:40:47.424000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '14105',
   'Marquise Brown', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 20000, 10000, 15000, NULL,
   'contract-transaction-log-xlsx', '2021-06-20T15:21:13.536000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0009', '14085',
   'Tony Pollard', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 12000, 10000, 9000, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T08:07:40.224000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0010', '13132',
   'Alvin Kamara', 'RB',
   'EXT2', 20000, 2, NULL,
   2, 65000, 20000, 48750, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T19:16:39.936000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0010', '11647',
   'Logan Thomas', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 11000, 6000, 8250, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T20:14:37.536000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0010', '13671',
   'Mark Andrews', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 9000, 6000, 6750, NULL,
   'contract-transaction-log-xlsx', '2021-05-31T21:34:08.544000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0011', '13590',
   'Baker Mayfield', 'QB',
   'EXT2', 12000, 2, NULL,
   2, 26000, 12000, 19500, NULL,
   'contract-transaction-log-xlsx', '2021-05-29T18:29:38.976000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0011', '14137',
   'Noah Fant', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 8000, 6000, 6000, NULL,
   'contract-transaction-log-xlsx', '2021-08-05T14:26:42.432000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0012', '11938',
   'Adam Thielen', 'WR',
   'EXT1', 10000, 1, NULL,
   1, 35000, 10000, 26250, NULL,
   'contract-transaction-log-xlsx', '2021-08-04T06:06:47.808000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0012', '14071',
   'David Montgomery', 'RB',
   'EXT1', 10000, 1, NULL,
   1, 24000, 10000, 18000, NULL,
   'contract-transaction-log-xlsx', '2021-07-27T15:28:25.536000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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
  ('74598', '2021', '0012', '11247',
   'Zach Ertz', 'TE',
   'EXT1', 6000, 1, NULL,
   1, 11000, 6000, 8250, NULL,
   'contract-transaction-log-xlsx', '2021-08-05T13:58:29.856000', datetime('now'),
   'evidenced', 'contract_transaction_log:2021_Contract_Transaction_Log.xlsx')
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

