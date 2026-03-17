-- Base views for the Reports Module salary adjustments report.
-- The initial live report uses accepted trade salary rows directly and
-- derives drop penalty candidates from add/drop transactions plus the
-- contract snapshot captured at the same transaction boundary.

DROP VIEW IF EXISTS report_salary_adjustments_trade_base_v1;

CREATE VIEW report_salary_adjustments_trade_base_v1 AS
SELECT
  t.season AS adjustment_season,
  COALESCE(t.franchise_id, "") AS franchise_id,
  COALESCE(NULLIF(t.franchise_name, ""), NULLIF(df.franchise_name, ""), "") AS franchise_name,
  'TRADED_SALARY' AS adjustment_type,
  'transactions_trades' AS source_table,
  COALESCE(NULLIF(t.transactionid, ""), NULLIF(t.trade_group_id, ""), "") AS source_id,
  t.season AS source_season,
  COALESCE(t.player_id, "") AS player_id,
  COALESCE(t.player_name, "") AS player_name,
  COALESCE(t.datetime_et, "") AS transaction_datetime_et,
  COALESCE(t.asset_capadjustment, 0) AS raw_amount,
  COALESCE(t.trade_group_id, "") AS source_group_id,
  COALESCE(t.comments, "") AS comments
FROM transactions_trades t
LEFT JOIN dim_franchise df
  ON df.franchise_id = t.franchise_id
WHERE COALESCE(t.salaryadjustment_ind, 0) = 1;


DROP VIEW IF EXISTS report_salary_adjustments_drop_base_v1;

CREATE VIEW report_salary_adjustments_drop_base_v1 AS
SELECT
  a.season AS adjustment_season,
  COALESCE(a.franchise_id, "") AS franchise_id,
  COALESCE(NULLIF(a.franchise_name, ""), NULLIF(s.team_name, ""), NULLIF(df.franchise_name, ""), "") AS franchise_name,
  'DROP_PENALTY_CANDIDATE' AS adjustment_type,
  'transactions_adddrop' AS source_table,
  COALESCE(CAST(a.transactionid AS TEXT), printf('%d:%06d', a.season, a.txn_index)) AS source_id,
  a.season AS source_season,
  COALESCE(a.player_id, "") AS player_id,
  COALESCE(NULLIF(a.player_name, ""), NULLIF(s.player_name, ""), NULLIF(dp.player_name, ""), "") AS player_name,
  COALESCE(a.datetime_et, TRIM(COALESCE(s.event_date, "") || ' ' || COALESCE(s.event_time, "")), "") AS transaction_datetime_et,
  COALESCE(NULLIF(s.event_source, ""), CASE WHEN COALESCE(a.method, "") <> "" THEN 'ADDDROP:' || a.method ELSE "" END, "") AS event_source,
  COALESCE(a.method, "") AS drop_method,
  COALESCE(NULLIF(s.prior_salary, 0), s.salary, 0) AS pre_drop_salary,
  COALESCE(NULLIF(s.prior_contract_length, 0), s.contract_length, 0) AS pre_drop_contract_length,
  COALESCE(NULLIF(s.prior_tcv, 0), s.tcv, 0) AS pre_drop_tcv,
  COALESCE(NULLIF(s.prior_contract_year, 0), s.contract_year, 0) AS pre_drop_contract_year,
  COALESCE(NULLIF(s.prior_contract_status, ""), s.contract_status, "") AS pre_drop_contract_status,
  COALESCE(
    NULLIF(s.prior_contract_info, ""),
    NULLIF(s.prior_inferred_contract_info, ""),
    NULLIF(s.contract_info, ""),
    NULLIF(s.inferred_contract_info, ""),
    ""
  ) AS pre_drop_contract_info,
  COALESCE(NULLIF(s.prior_year_values_json, ""), NULLIF(s.year_values_json, ""), "{}") AS pre_drop_year_values_json
FROM transactions_adddrop a
LEFT JOIN contract_history_transaction_snapshots s
  ON s.season = a.season
 AND s.player_id = a.player_id
 AND COALESCE(s.franchise_id, "") = COALESCE(a.franchise_id, "")
 AND s.event_type = 'DROP'
 AND s.event_source LIKE 'ADDDROP:%'
 AND (COALESCE(s.event_date, "") || ' ' || COALESCE(s.event_time, "00:00:00")) = COALESCE(a.datetime_et, "")
LEFT JOIN dim_franchise df
  ON df.franchise_id = a.franchise_id
LEFT JOIN dim_player dp
  ON dp.player_id = a.player_id
WHERE a.move_type = 'DROP';
