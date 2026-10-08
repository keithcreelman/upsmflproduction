-- READ-ONLY. Expect exactly 27 rows back, every one with in_original_state = 1.
SELECT id, endpoint, player_id, created_ts, dry_run, landed, import_status, notes,
       CASE WHEN dry_run = 0 AND landed = 1 AND COALESCE(import_status, 0) = 0 AND notes = 'import_ok_log_dispatched' AND COALESCE(before_salary,'') = COALESCE(after_salary,'') AND COALESCE(before_contract_status,'') = COALESCE(after_contract_status,'') AND COALESCE(before_contract_year,'') = COALESCE(after_contract_year,'') AND COALESCE(before_contract_info,'') = COALESCE(after_contract_info,'') THEN 1 ELSE 0 END AS in_original_state,
       (SELECT COUNT(*) FROM ups_contract_gate_audit a WHERE a.field = 'salary_change_log_dry_run_relabel' AND a.note LIKE 'change_log_id=' || s.id || ' %') AS audit_records
FROM salary_change_log s WHERE id IN (1233, 1234, 1235, 1236, 1237, 1238, 1240, 1243, 1246, 1248, 1250, 1253, 1256, 1259, 1262, 1264, 1265, 1266, 1267, 1269, 1271, 1698, 1699, 1700, 1704, 1705, 1876) ORDER BY id;
-- and the whole table holds no OTHER row with this label (expect the same 27 ids):
SELECT GROUP_CONCAT(id) AS ids, COUNT(*) AS n FROM salary_change_log WHERE landed = 1 AND COALESCE(import_status, 0) = 0;
