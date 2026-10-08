// The prepared relabel of the 27 mislabeled dry-run rows (docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/),
// executed here — and ONLY here — against the exact production rows in SQLite. Production runs it only on Keith's approval.
//   node tests/salary_change_log_relabel_plan.test.mjs
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as FC from "../worker/src/fcfs_contract.js";
import { QUERIES } from "../scripts/fcfs_contract_backfill.mjs";

const DIR = new URL("../docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/", import.meta.url);
const sql = (f) => fs.readFileSync(new URL(f, DIR), "utf8");
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/salary_change_log_mislabeled_dry_runs_2026.json", import.meta.url), "utf8"));
const CLS = JSON.parse(sql("classification.json"));
const IDS = FIX.rows.map((r) => r.id).filter((id) => id !== 1865 && id !== 1875);
const TIER_B = [1238, 1264, 1265, 1266, 1267];
const APPEND = " | relabeled 2026-10-08: DRY RUN, no MFL request (import_status 0); originally logged dry_run=0 landed=1 by the contract-route audit-writer bug; original row + evidence in ups_contract_gate_audit field salary_change_log_dry_run_relabel";

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec(FIX.schema);
  db.exec("CREATE TABLE ups_contract_gate_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, season TEXT, field TEXT NOT NULL, before_val TEXT, after_val TEXT, actor TEXT, note TEXT)");
  db.exec("CREATE TABLE ups_add_events (id INTEGER PRIMARY KEY, season TEXT, player_id TEXT, source TEXT, contract_annotated INTEGER)");
  const cols = Object.keys(FIX.rows[0]);
  const ins = db.prepare(`INSERT INTO salary_change_log (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of FIX.rows) ins.run(...cols.map((c) => (r[c] == null ? null : r[c])));
  [...new Set(FIX.rows.map((r) => r.player_id))].forEach((p, i) => db.prepare("INSERT INTO ups_add_events VALUES (?, '2026', ?, 'fcfs', 3)").run(i + 1, p));
  // an unrelated, pre-existing audit row of another kind must be left alone
  db.prepare("INSERT INTO ups_contract_gate_audit (at_utc, season, field, note) VALUES ('2026-09-27T15:15:03.139Z', '2026', 'fcfs_add_event_closed_by_owner_conversion', 'stamp_log=1865 change_log=1875')").run();
  return db;
}
const table = (db) => db.prepare("SELECT * FROM salary_change_log ORDER BY id").all();
const all = (db, file) => db.prepare(file).all();
// 04_verify_after.sql, statement by statement
const after = (db) => sql("04_verify_after.sql").split(/;\s*\n/).map((s) => s.trim()).filter((s) => /\bSELECT\b/i.test(s)).map((s) => db.prepare(s.replace(/^(--.*\n)+/m, "")).all());

test("PLAN: classification covers exactly the 27 rows, 22 in Tier A (a direct record of the request's own mode) and 5 in Tier B", () => {
  t.deepEqual(CLS.map((c) => c.id), IDS);
  t.deepEqual(CLS.filter((c) => c.tier === "B").map((c) => c.id), TIER_B);
  for (const c of CLS) {
    t.equal(c.E2_all_13_checks_hold, true, `${c.id}: the code-path proof`); t.equal(c.E3_import_status, 0); t.equal(c.E3_all_4_fields_before_eq_after, true);
    if (c.tier === "A") t.ok(c.E1_same_request_dry_run_record || /identical REAL request|auth-check probe/.test(c.evidence.join(" ")), `${c.id}: Tier A names its request-mode record`);
  }
  for (const f of ["02_apply_tier_a.sql", "03_apply_tier_b.sql"]) t.doesNotMatch(sql(f), /\bDELETE\b/i, `${f} deletes nothing`);
  t.equal((sql("02_apply_tier_a.sql").match(/^UPDATE salary_change_log SET dry_run = 1, landed = 0/gm) || []).length, 22);
  t.equal((sql("03_apply_tier_b.sql").match(/^UPDATE salary_change_log SET dry_run = 1, landed = 0/gm) || []).length, 5);
});

test("VERIFY BEFORE: all 27 are found in their exact original state, with no audit record; nothing else carries the label", () => {
  const db = world();
  const [rows, whole] = sql("01_verify_before.sql").split(/;\s*\n/).map((s) => s.trim()).filter((s) => /SELECT/i.test(s)).map((s) => db.prepare(s.replace(/^(--.*\n)+/m, "")).all());
  t.equal(rows.length, 27); t.ok(rows.every((r) => r.in_original_state === 1 && r.audit_records === 0));
  t.equal(whole[0].n, 27); t.equal(whole[0].ids.split(",").map(Number).join(","), IDS.join(","));
});

test("APPLY (A then B): exactly dry_run / landed / notes change on exactly the 27 rows; one audit record each holds the full original; every check in 04 passes", () => {
  const db = world(); const before = table(db);
  db.exec(sql("02_apply_tier_a.sql")); db.exec(sql("03_apply_tier_b.sql"));
  const now = table(db);
  for (let i = 0; i < before.length; i += 1) {
    const b = before[i], a = now[i];
    const changed = Object.keys(b).filter((k) => b[k] !== a[k]);
    if (IDS.includes(b.id)) { t.deepEqual([...changed].sort(), ["dry_run", "landed", "notes"], `row ${b.id}: only the three columns`); t.equal(a.dry_run, 1); t.equal(a.landed, 0); t.equal(a.notes, b.notes + APPEND); }
    else t.deepEqual(changed, [], `row ${b.id} untouched`);
  }
  const audit = db.prepare("SELECT * FROM ups_contract_gate_audit WHERE field = 'salary_change_log_dry_run_relabel' ORDER BY id").all();
  t.equal(audit.length, 27);
  for (const a of audit) {
    const id = Number(/^change_log_id=(\d+) /.exec(a.note)[1]);
    t.deepEqual(JSON.parse(a.before_val), { ...before.find((r) => r.id === id) }, `audit for ${id} preserves the complete original row`);
    t.match(a.note, new RegExp(`^change_log_id=${id} tier=${TIER_B.includes(id) ? "B" : "A"} evidence: code: `));
  }
  const [rows, counts, drift, left, fcfs] = after(db);
  t.equal(rows.length, 27); t.ok(rows.every((r) => r.dry_run === 1 && r.landed === 0 && r.import_status === 0 && r.note_prefix === "import_ok_log_dispatched"));
  t.deepEqual({ ...counts[0] }, { n: 27, dupes: 0 }); t.deepEqual(drift, [], "no other column moved"); t.equal(left[0].n, 0, "no false label left");
  t.deepEqual(fcfs.map((r) => [r.id, r.dry_run, r.landed, r.import_status]), [[1865, 0, 1, 200], [1875, 0, 1, 200]]);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'fcfs_add_event_closed_by_owner_conversion'").get().n, 1, "the unrelated audit row is untouched");
  for (const r of now.filter((x) => IDS.includes(x.id))) t.equal(FC.isMflConfirmedWrite(r), false);
  t.deepEqual(db.prepare(QUERIES.changeLog2026).all().map((r) => r.id), [1865, 1875], "the FCFS read is unchanged");
});

test("PARTIAL + IDEMPOTENT: Tier A alone leaves exactly the 5 Tier B rows; re-running either file changes nothing", () => {
  const db = world();
  db.exec(sql("02_apply_tier_a.sql"));
  t.equal(after(db)[3][0].n, 5, "Tier B still carries the label until approved separately");
  t.deepEqual(db.prepare("SELECT id FROM salary_change_log WHERE landed = 1 AND COALESCE(import_status,0) = 0 ORDER BY id").all().map((r) => r.id), TIER_B);
  db.exec(sql("03_apply_tier_b.sql"));
  const snap = JSON.stringify([table(db), db.prepare("SELECT * FROM ups_contract_gate_audit").all()]);
  db.exec(sql("02_apply_tier_a.sql")); db.exec(sql("03_apply_tier_b.sql"));
  t.equal(JSON.stringify([table(db), db.prepare("SELECT * FROM ups_contract_gate_audit").all()]), snap, "second run: zero changes, no second audit record");
});

test("GUARD: a row that is no longer in its exact original state is skipped — no audit record, no update", () => {
  const db = world();
  db.prepare("UPDATE salary_change_log SET import_status = 200 WHERE id = 1269").run();          // changed since the plan was made
  db.prepare("UPDATE salary_change_log SET after_salary = '1' WHERE id = 1238").run();           // after ≠ before: not the dry-run shape
  db.exec(sql("02_apply_tier_a.sql")); db.exec(sql("03_apply_tier_b.sql"));
  for (const id of [1269, 1238]) {
    const r = db.prepare("SELECT dry_run, landed FROM salary_change_log WHERE id = ?").get(id);
    t.deepEqual([r.dry_run, r.landed], [0, 1], `${id} left alone`);
    t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE note LIKE ?").get(`change_log_id=${id} %`).n, 0);
  }
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'salary_change_log_dry_run_relabel'").get().n, 25);
});

test("ROLLBACK: restores every relabeled row to its exact original values; the audit records are kept, marked rolled back", () => {
  const db = world(); const original = table(db);
  db.exec(sql("02_apply_tier_a.sql")); db.exec(sql("03_apply_tier_b.sql"));
  db.exec(sql("05_rollback.sql"));
  t.deepEqual(table(db), original, "byte-identical to before the relabel");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'salary_change_log_dry_run_relabel_rolled_back'").get().n, 27);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'fcfs_add_event_closed_by_owner_conversion'").get().n, 1);
});

await run("salary_change_log_relabel_plan");
