#!/usr/bin/env python3
"""Generate the guarded relabel SQL for the 27 mislabeled salary_change_log dry-run rows.

    python3 docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/build_sql.py

Reads classification.json (this folder) and writes:
  01_verify_before.sql   read-only: every row still in its exact original (mislabeled) state
  02_apply_tier_a.sql    the 22 rows with a direct record of the request's own mode
  03_apply_tier_b.sql    the 5 rows proven by the code path + MFL's later reads (no surviving request-mode record)
  04_verify_after.sql    read-only: relabeled, nothing else changed, one audit record each
  05_rollback.sql        restores the exact original values from the audit records

Each row is corrected by TWO guarded statements:
  1. an INSERT into ups_contract_gate_audit (field salary_change_log_dry_run_relabel) holding the COMPLETE original row
     as JSON, the new values, and the evidence — only while the row is still in its exact original state and has no
     audit record yet;
  2. an UPDATE of ONLY dry_run, landed and notes (the original note is kept; text is appended) — only while the row is
     still in its exact original state AND its audit record exists.
Re-running is a no-op; a partial run is safe; nothing is ever deleted. Executed by Keith's approval only.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIELD = "salary_change_log_dry_run_relabel"
COLS = ["id", "created_ts", "endpoint", "league_id", "season", "dry_run", "actor_ip", "actor_ua", "actor_had_api_key", "player_id",
        "before_salary", "before_contract_status", "before_contract_year", "before_contract_info",
        "after_salary", "after_contract_status", "after_contract_year", "after_contract_info",
        "intended_salary", "intended_contract_status", "intended_contract_year", "intended_contract_info",
        "landed", "import_status", "notes"]
UNCHANGED = [c for c in COLS if c not in ("dry_run", "landed", "notes")]
APPEND = (" | relabeled 2026-10-08: DRY RUN, no MFL request (import_status 0); originally logged dry_run=0 landed=1 by the "
          "contract-route audit-writer bug; original row + evidence in ups_contract_gate_audit field " + FIELD)

q = lambda s: "'" + str(s).replace("'", "''") + "'"
ORIGINAL = ("dry_run = 0 AND landed = 1 AND COALESCE(import_status, 0) = 0 AND notes = 'import_ok_log_dispatched'"
            " AND COALESCE(before_salary,'') = COALESCE(after_salary,'') AND COALESCE(before_contract_status,'') = COALESCE(after_contract_status,'')"
            " AND COALESCE(before_contract_year,'') = COALESCE(after_contract_year,'') AND COALESCE(before_contract_info,'') = COALESCE(after_contract_info,'')")
AUDIT_OF = lambda rid: f"SELECT 1 FROM ups_contract_gate_audit WHERE field = '{FIELD}' AND note LIKE 'change_log_id={rid} %'"


def apply_sql(rows, tier):
    out = [f"-- Tier {tier}: {len(rows)} rows. Guarded, idempotent; see build_sql.py. Run 01_verify_before.sql first, 04_verify_after.sql after.\n"]
    for r in rows:
        rid = r["id"]
        evidence = " || ".join(r["evidence"])
        note = f"change_log_id={rid} tier={tier} evidence: {evidence}"
        out.append(f"-- row {rid}: {r['endpoint']} player {r['player_id']} at {r['ts']}")
        out.append(
            "INSERT INTO ups_contract_gate_audit (at_utc, season, field, before_val, after_val, actor, note)\n"
            f"  SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now'), season, '{FIELD}',\n"
            f"         json_object({', '.join(f'{q(c)}, {c}' for c in COLS)}),\n"
            f"         json_object('dry_run', 1, 'landed', 0, 'notes', notes || {q(APPEND)}),\n"
            f"         'commissioner-approved relabel (plan 2026-10-08)', {q(note)}\n"
            f"  FROM salary_change_log WHERE id = {rid} AND {ORIGINAL}\n"
            f"    AND NOT EXISTS ({AUDIT_OF(rid)});")
        out.append(
            f"UPDATE salary_change_log SET dry_run = 1, landed = 0, notes = notes || {q(APPEND)}\n"
            f"  WHERE id = {rid} AND {ORIGINAL}\n"
            f"    AND EXISTS ({AUDIT_OF(rid)});\n")
    return "\n".join(out)


def main():
    cls = json.load(open(os.path.join(HERE, "classification.json")))
    ids = [r["id"] for r in cls]
    id_list = ", ".join(str(i) for i in ids)
    tier = {t: [r for r in cls if r["tier"] == t] for t in "AB"}

    open(os.path.join(HERE, "01_verify_before.sql"), "w").write(
        "-- READ-ONLY. Expect exactly %d rows back, every one with in_original_state = 1.\n" % len(ids)
        + f"SELECT id, endpoint, player_id, created_ts, dry_run, landed, import_status, notes,\n"
        + f"       CASE WHEN {ORIGINAL} THEN 1 ELSE 0 END AS in_original_state,\n"
        + f"       (SELECT COUNT(*) FROM ups_contract_gate_audit a WHERE a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || s.id || ' %') AS audit_records\n"
        + f"FROM salary_change_log s WHERE id IN ({id_list}) ORDER BY id;\n"
        + "-- and the whole table holds no OTHER row with this label (expect the same %d ids):\n" % len(ids)
        + "SELECT GROUP_CONCAT(id) AS ids, COUNT(*) AS n FROM salary_change_log WHERE landed = 1 AND COALESCE(import_status, 0) = 0;\n")

    open(os.path.join(HERE, "02_apply_tier_a.sql"), "w").write(apply_sql(tier["A"], "A"))
    open(os.path.join(HERE, "03_apply_tier_b.sql"), "w").write(apply_sql(tier["B"], "B"))

    same = " AND ".join(f"json_extract(a.before_val, '$.{c}') IS s.{c}" for c in UNCHANGED)
    open(os.path.join(HERE, "04_verify_after.sql"), "w").write(
        "-- READ-ONLY.\n"
        "-- (1) every corrected row: dry_run=1, landed=0, original note kept as the prefix (expect one row per corrected id)\n"
        f"SELECT id, dry_run, landed, import_status, substr(notes, 1, 24) AS note_prefix FROM salary_change_log WHERE id IN ({id_list}) ORDER BY id;\n"
        "-- (2) exactly one audit record per corrected row (expect n = rows corrected, dupes = 0)\n"
        f"SELECT COUNT(*) AS n, COUNT(*) - COUNT(DISTINCT note) AS dupes FROM ups_contract_gate_audit WHERE field = '{FIELD}';\n"
        "-- (3) NO other column changed: every unchanged column equals the original in its audit record (expect 0 rows)\n"
        f"SELECT s.id FROM salary_change_log s JOIN ups_contract_gate_audit a ON a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || s.id || ' %'\n"
        f"  WHERE NOT ({same}) OR json_extract(a.before_val, '$.dry_run') <> 0 OR json_extract(a.before_val, '$.landed') <> 1\n"
        f"     OR s.notes <> json_extract(a.before_val, '$.notes') || {q(APPEND)};\n"
        "-- (4) nothing left with the false label (expect n = 0 once both tiers are applied; = the Tier B count if only Tier A is)\n"
        "SELECT COUNT(*) AS n FROM salary_change_log WHERE landed = 1 AND COALESCE(import_status, 0) = 0;\n"
        "-- (5) the FCFS evidence rule is unaffected: the MFL-confirmed rows behind add event 52 are untouched (expect 1865, 1875 with dry_run 0, landed 1, 200)\n"
        "SELECT id, dry_run, landed, import_status FROM salary_change_log WHERE id IN (1865, 1875) ORDER BY id;\n")

    open(os.path.join(HERE, "05_rollback.sql"), "w").write(
        "-- Restores the EXACT original dry_run / landed / notes of every relabeled row from its audit record, then marks the\n"
        "-- audit record rolled back (it is kept). Guarded: touches only rows still carrying the relabel note.\n"
        f"UPDATE salary_change_log SET\n"
        f"    dry_run = (SELECT json_extract(a.before_val, '$.dry_run') FROM ups_contract_gate_audit a WHERE a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %'),\n"
        f"    landed  = (SELECT json_extract(a.before_val, '$.landed')  FROM ups_contract_gate_audit a WHERE a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %'),\n"
        f"    notes   = (SELECT json_extract(a.before_val, '$.notes')   FROM ups_contract_gate_audit a WHERE a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %')\n"
        f"  WHERE id IN ({id_list}) AND notes LIKE '%' || {q(APPEND)}\n"
        f"    AND EXISTS (SELECT 1 FROM ups_contract_gate_audit a WHERE a.field = '{FIELD}' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %');\n"
        f"UPDATE ups_contract_gate_audit SET field = '{FIELD}_rolled_back' WHERE field = '{FIELD}';\n")
    print("wrote 01-05 for", len(ids), "rows:", {t: len(v) for t, v in tier.items()})


if __name__ == "__main__":
    main()
