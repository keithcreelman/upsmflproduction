// player_acquisition_cycles — FCFS acquisition fields ($1,000, 1 year) through the ETL's own path.
//   node tests/fcfs_cycles_etl.test.mjs
//   • the GENERATION rule (`cycle_to_row`): a future pair run never emits a NULL-salary FCFS cycle
//   • the SCOPED REGENERATION (pipelines/etl/scripts/backfill_cycles_pass2.py --fcfs-acquisition-fields): UPDATE-only, two columns, FCFS rows with transaction
//     evidence only, distinct re-acquisitions preserved, later replacement contracts (drop-time columns) untouched, nothing invented, twice = identical
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "pipelines/etl/scripts/backfill_cycles_pass2.py");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fcfs-etl-"));
const py = (code) => { const r = spawnSync("python3", ["-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, "pipelines/etl/lib"))})\nsys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT))})\n${code}`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }); if (r.status !== 0) throw new Error(r.stderr || "python failed"); return JSON.parse(r.stdout); };
const cli = (args) => { const r = spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }); return { status: r.status, out: r.stdout, err: r.stderr }; };
const unix = (iso) => Math.floor(Date.parse(iso + "Z") / 1000);

// the fixture: what production looks like in miniature
const cyc = (o) => ({ cycle_id: 0, player_id: "100", franchise_id: "0001", season: 2023, acquisition_path: "fcfs", acquisition_date: "2023-09-10 16:38:10", salary_at_acquisition_usd: null, contract_years_at_acquisition: null, source: "backfill_pass3_2026_05_09", notes: "pass3_complete", status: "closed", drop_date: "2023-09-21 13:00:00", updated_at_utc: "2026-05-09T00:00:00Z", ...o });
const CYCLES = [
  cyc({ cycle_id: 1 }),                                                                                                                                                  // plain
  cyc({ cycle_id: 2, player_id: "101", franchise_id: "0002", acquisition_date: "2023-09-10 10:00:00" }),                                                                 // reacquisition #1
  cyc({ cycle_id: 3, player_id: "101", franchise_id: "0002", acquisition_date: "2023-09-22 10:00:00" }),                                                                 // reacquisition #2 (a DISTINCT period)
  cyc({ cycle_id: 4, player_id: "102", franchise_id: "0003" }),                                                                                                          // no transaction evidence
  cyc({ cycle_id: 5, player_id: "103", franchise_id: "0004", salary_at_acquisition_usd: 1000, contract_years_at_acquisition: 1 }),                                       // already canonical
  cyc({ cycle_id: 6, player_id: "104", franchise_id: "0005", salary_at_acquisition_usd: 5000 }),                                                                         // a different salary is stored
  cyc({ cycle_id: 7, player_id: "105", franchise_id: "0006", contract_years_at_acquisition: 3 }),                                                                        // different years stored
  cyc({ cycle_id: 8, player_id: "106", franchise_id: "0007", season: 2011, acquisition_date: "2011-09-18 09:00:00", source: "backfill_pass2_2026_05_09", notes: "needs_pass3_enrichment" }),   // 2011: BOTH ledgers know it
  { ...cyc({ cycle_id: 9, player_id: "100", franchise_id: "0001", acquisition_path: "auction", acquisition_date: "2023-08-01 09:00:00", salary_at_acquisition_usd: 22000 }) },   // NOT fcfs
];
const ADDDROP = [
  { season: 2023, player_id: "100", franchise_id: "0001", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-10T16:38:10") },
  { season: 2023, player_id: "101", franchise_id: "0002", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-10T10:00:00") },
  { season: 2023, player_id: "101", franchise_id: "0002", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-22T10:00:00") },
  { season: 2023, player_id: "103", franchise_id: "0004", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-10T16:38:10") },
  { season: 2023, player_id: "104", franchise_id: "0005", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-10T16:38:10") },
  { season: 2023, player_id: "105", franchise_id: "0006", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2023-09-10T16:38:10") },
  { season: 2011, player_id: "106", franchise_id: "0007", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2011-09-18T09:00:00") },
  { season: 2025, player_id: "200", franchise_id: "0008", move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix("2025-10-05T12:00:00") },       // an FCFS period with NO cycle (2025 is outside the ETL's seasons)
  { season: 2023, player_id: "100", franchise_id: "0001", move_type: "ADD", method: "BBID", salary: 7000, unix_timestamp: unix("2023-10-01T09:00:00") },                  // a waiver add — not FCFS evidence
  { season: 2023, player_id: "100", franchise_id: "0001", move_type: "DROP", method: "FREE_AGENT", salary: null, unix_timestamp: unix("2023-09-21T13:00:00") },          // a drop — not evidence
];
const HIST = [{ season: 2011, player_in_id: "106", franchise_id: "0007", type: "FREE_AGENT", salary: 1000, ts_unix: unix("2011-09-18T09:00:00") }];          // the same 2011 add, second ledger
const dirWith = (over) => { const d = tmp(); const data = { cycles: CYCLES.filter((c) => c.acquisition_path === "fcfs"), adddrop: ADDDROP, hist: HIST, ...(over || {}) }; for (const [k, v] of Object.entries(data)) fs.writeFileSync(path.join(d, `${k}.json`), JSON.stringify(v)); return d; };

test("GENERATION (cycle_to_row): an FCFS cycle carries $1,000 and 1 year — future pair runs never emit a NULL-salary FCFS row; other paths are unchanged", () => {
  const r = py(`
import backfill_cycles_pass2 as p
base = {"player_id":"1","franchise_id":"0001","season":2023,"ts_iso":"2023-09-10 16:38:10","acquisition_date":"2023-09-10 16:38:10","status":"open"}
out = {}
for name, path, sal in [("fcfs", "fcfs", None), ("fcfs_1k", "fcfs", 1000), ("fcfs_diff", "fcfs", 2000), ("ww", "ww", None), ("ww_bid", "ww", 5000), ("auction", "auction", 22000)]:
    row = p.cycle_to_row({**base, "acquisition_path": path, "salary_at_acquisition_usd": sal})
    out[name] = [row["salary_at_acquisition_usd"], row["contract_years_at_acquisition"], row["notes"]]
print(json.dumps(out))`);
  t.equal(r.fcfs[0], 1000); t.equal(r.fcfs[1], 1); t.match(String(r.fcfs[2]), /needs_pass3_enrichment/, "the acquisition salary is set, but every DROP-side financial column is still NULL — enrichment is still owed");
  t.deepEqual(r.fcfs_1k.slice(0, 2), [1000, 1]);
  t.equal(r.fcfs_diff[0], 2000, "a DIFFERENT salary on the transaction is kept, never overwritten"); t.match(r.fcfs_diff[2], /fcfs_salary_not_canonical/, "…and flagged");
  t.deepEqual(r.ww.slice(0, 2), [null, null]); t.match(r.ww[2], /needs_pass3_enrichment/, "a WW cycle with no salary is unchanged (only FCFS has a fixed price)"); t.deepEqual(r.ww_bid.slice(0, 2), [5000, null]); t.deepEqual(r.auction.slice(0, 2), [22000, null]);
});
test("PLAN: FCFS cycles with transaction evidence are updated — two columns; distinct re-acquisitions stay distinct; conflicts and cycles without evidence are NOT touched; nothing is invented", () => {
  const r = py(`
import fcfs_cycles as f
cycles = json.loads(${JSON.stringify(JSON.stringify(CYCLES))})
ev = f.evidence_from_rows(json.loads(${JSON.stringify(JSON.stringify(ADDDROP))}), json.loads(${JSON.stringify(JSON.stringify(HIST))}))
plan = f.plan_fcfs_cycle_updates(cycles, ev, "2026-09-26T00:00:00Z")
print(json.dumps({"ev": ev, "rows": [[x["cycle_id"], x["disposition"]] for x in plan["rows"]], "updates": [u["cycle_id"] for u in plan["updates"]], "no_cycle": plan["periods_without_cycle"], "summary": plan["summary"]}))`);
  t.equal(r.ev.filter((e) => e.pid === "106").length, 1, "the 2011 add known to BOTH ledgers is ONE period"); t.deepEqual(r.ev.find((e) => e.pid === "106").sources.sort(), ["mfl_historical_transactions", "src_adddrop"]);
  t.equal(r.ev.length, 8, "eight FCFS periods — the BBID add and the drop are not evidence");
  t.deepEqual(Object.fromEntries(r.rows), { 1: "updated", 2: "updated", 3: "updated", 4: "skipped_no_evidence", 5: "unchanged", 6: "manual_review_salary_conflict", 7: "manual_review_years_conflict", 8: "updated" });
  t.deepEqual(r.updates, [1, 2, 3, 8], "the auction cycle (9) is not even considered; conflicts / no-evidence / already-canonical are not updated");
  t.equal(r.rows.some(([id]) => id === 9), false, "a non-FCFS cycle is never a row of the plan");
  t.deepEqual(r.no_cycle.map((e) => `${e.season}:${e.pid}`), ["2025:200"], "an FCFS period without a cycle is REPORTED, never created");
  t.equal(r.summary.updated, 4); t.equal(r.summary.skipped_no_evidence, 1); t.equal(r.summary.periods_without_cycle, 1); t.deepEqual(Object.keys(r.summary.source_limits), ["2010", "2011", "2012", "2013", "2014", "2015", "2016"], "the stated 2011–2016 source limitations travel with every plan");
  // two cycles for one player/franchise/season: each maps to ITS OWN transaction
  t.deepEqual(r.rows.filter(([id]) => id === 2 || id === 3).map(([, d]) => d), ["updated", "updated"]);
});
test("SQL: the generated UPDATEs set exactly two columns (+ the timestamp) on FCFS rows, never DELETE/INSERT — applied to a real table they leave every other column, every drop-time / replacement column and every non-FCFS row untouched; applying twice changes nothing", () => {
  const d = dirWith(); const o = tmp();
  const r = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T00:00:00Z", "--simulate"]); t.equal(r.status, 0, r.err);
  const sql = fs.readFileSync(path.join(o, "updates.sql"), "utf8").trim().split("\n"); t.equal(sql.length, 4);
  for (const s of sql) { t.match(s, /^UPDATE player_acquisition_cycles SET salary_at_acquisition_usd = 1000, contract_years_at_acquisition = 1, updated_at_utc = '2026-09-26T00:00:00Z' WHERE cycle_id = \d+ AND acquisition_path = 'fcfs' AND /); t.doesNotMatch(s, /DELETE|INSERT|DROP|salary_at_drop|tcv_at_drop|source\s*=/i); }
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE player_acquisition_cycles (cycle_id INTEGER PRIMARY KEY, player_id TEXT, franchise_id TEXT, season INTEGER, acquisition_path TEXT, acquisition_date TEXT, salary_at_acquisition_usd INTEGER, contract_years_at_acquisition INTEGER, salary_at_drop_usd INTEGER, tcv_at_drop_usd INTEGER, earned_per_week_usd INTEGER, source TEXT, notes TEXT, status TEXT, drop_date TEXT, updated_at_utc TEXT)");
  for (const c of CYCLES) db.prepare("INSERT INTO player_acquisition_cycles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(c.cycle_id, c.player_id, c.franchise_id, c.season, c.acquisition_path, c.acquisition_date, c.salary_at_acquisition_usd, c.contract_years_at_acquisition, 40000, 40000, 143, c.source, c.notes, c.status, c.drop_date, c.updated_at_utc);   // 40000: a LATER replacement contract at drop time
  const before = db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all();
  const changes = sql.map((s) => Number(db.prepare(s).run().changes)); t.deepEqual(changes, [1, 1, 1, 1]);
  const after = db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all();
  for (const b of before) { const a = after.find((x) => x.cycle_id === b.cycle_id); const diff = Object.keys(b).filter((k) => b[k] !== a[k]).sort();
    if ([1, 2, 3, 8].includes(b.cycle_id)) t.deepEqual(diff, ["contract_years_at_acquisition", "salary_at_acquisition_usd", "updated_at_utc"], `cycle ${b.cycle_id}`); else t.deepEqual(diff, [], `cycle ${b.cycle_id} untouched`); }
  t.equal(after.find((x) => x.cycle_id === 1).salary_at_drop_usd, 40000, "the later replacement contract (drop-time salary) is preserved"); t.equal(after.find((x) => x.cycle_id === 9).salary_at_acquisition_usd, 22000, "the auction cycle is untouched"); t.equal(after.find((x) => x.cycle_id === 6).salary_at_acquisition_usd, 5000, "a conflicting stored salary is NOT overwritten");
  t.deepEqual(sql.map((s) => Number(db.prepare(s).run().changes)), [0, 0, 0, 0], "applying the same UPDATEs again changes nothing (guarded in SQL too)");
  t.equal(JSON.stringify(db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all()), JSON.stringify(after), "identical");
});
test("TWICE = IDENTICAL: --simulate applies the plan to the exported cycles and re-plans — zero updates, identical table; before/after are exported; --apply refuses without --yes", () => {
  const d = dirWith(), o = tmp();
  const r = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T00:00:00Z", "--simulate"]); t.equal(r.status, 0, r.err);
  const s = JSON.parse(fs.readFileSync(path.join(o, "summary.json"), "utf8")); t.equal(s.updates, 4); t.deepEqual(s.second_run, { updates: 0, identical: true });
  for (const f of ["cycles_before.json", "cycles_after.json", "plan_rows.json", "periods_without_cycle.json", "updates.sql", "second_run_summary.json"]) t.ok(fs.existsSync(path.join(o, f)), f);
  const before = JSON.parse(fs.readFileSync(path.join(o, "cycles_before.json"), "utf8")), after = JSON.parse(fs.readFileSync(path.join(o, "cycles_after.json"), "utf8"));
  t.equal(after.filter((c) => c.salary_at_acquisition_usd === 1000 && c.contract_years_at_acquisition === 1).length, 5, "four updated + one already canonical"); t.equal(before.filter((c) => c.salary_at_acquisition_usd === null).length, 6, "six FCFS cycles had no salary (two of them — no evidence, a stored conflict — stay that way)");
  // re-run the ETL on ITS OWN OUTPUT: nothing to do, and the file it would write is byte-identical
  const d2 = tmp(); for (const k of ["adddrop", "hist"]) fs.copyFileSync(path.join(d, `${k}.json`), path.join(d2, `${k}.json`)); fs.copyFileSync(path.join(o, "cycles_after.json"), path.join(d2, "cycles.json"));
  const o2 = tmp(); const r2 = cli(["--fcfs-acquisition-fields", "--input-dir", d2, "--out", o2, "--stamp", "2026-09-27T00:00:00Z", "--simulate"]); t.equal(r2.status, 0, r2.err);
  t.equal(JSON.parse(fs.readFileSync(path.join(o2, "summary.json"), "utf8")).updates, 0, "second ETL run: zero updates"); t.equal(fs.readFileSync(path.join(o2, "updates.sql"), "utf8"), "", "an empty SQL file");
  t.equal(fs.readFileSync(path.join(o2, "cycles_after.json"), "utf8"), fs.readFileSync(path.join(d2, "cycles.json"), "utf8"), "the second result is IDENTICAL to the first");
  const refused = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", tmp(), "--apply"]); t.equal(refused.status, 2); t.match(refused.err, /--apply needs --yes/);
});
test("MATCHING: same SEASON, player and franchise — an evidence row never attaches to a cycle of another season; a distinct re-acquisition inside the window keeps its own row", () => {
  const r = py(`
import fcfs_cycles as f
def cyc(i, season, date, pid="1", fid="0001", **k):
    return {"cycle_id": i, "player_id": pid, "franchise_id": fid, "season": season, "acquisition_path": "fcfs", "acquisition_date": date, "salary_at_acquisition_usd": None, "contract_years_at_acquisition": None, "source": "x", "updated_at_utc": "2026-05-09T00:00:00Z", **k}
ev = f.evidence_from_rows([
  {"season": 2023, "player_id": "1", "franchise_id": "0001", "move_type": "ADD", "method": "FREE_AGENT", "salary": 1000, "unix_timestamp": f._epoch("2023-12-31 23:00:00")},
  {"season": 2024, "player_id": "1", "franchise_id": "0001", "move_type": "ADD", "method": "FREE_AGENT", "salary": 1000, "unix_timestamp": f._epoch("2024-01-01 01:00:00")},
], [])
plan = f.plan_fcfs_cycle_updates([cyc(1, 2023, "2023-12-31 23:00:00"), cyc(2, 2024, "2024-01-01 01:00:00"), cyc(3, 2024, "2024-01-01 02:00:00", pid="2")], ev, "2026-09-26T00:00:00Z")
print(json.dumps({"rows": {x["cycle_id"]: x["disposition"] for x in plan["rows"]}, "no_cycle": len(plan["periods_without_cycle"])}))`);
  t.deepEqual(r.rows, { 1: "updated", 2: "updated", 3: "skipped_no_evidence" }, "each season's cycle takes ITS OWN transaction (they are two hours apart across New Year)"); t.equal(r.no_cycle, 0);
});
test("ROLLBACK + GUARDS: rollback.sql is the exact reverse (reviewed, never run by the tool); --apply refuses an offline snapshot and a missing --yes; the stamp is UTC; a failed second-run proof exits non-zero", () => {
  const d = dirWith(), o = tmp();
  const r = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T00:00:00Z", "--simulate"]); t.equal(r.status, 0, r.err);
  const rb = fs.readFileSync(path.join(o, "rollback.sql"), "utf8").trim().split("\n"); t.equal(rb.length, 4);
  for (const s of rb) { t.match(s, /^UPDATE player_acquisition_cycles SET salary_at_acquisition_usd = NULL, contract_years_at_acquisition = NULL, updated_at_utc = '2026-05-09T00:00:00Z' WHERE cycle_id = \d+ AND acquisition_path = 'fcfs' AND salary_at_acquisition_usd = 1000 AND contract_years_at_acquisition = 1;$/); }
  const refused = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", tmp(), "--apply", "--yes"]); t.equal(refused.status, 2); t.match(refused.err, /cannot be combined with --input-dir/);
  const src = fs.readFileSync(SCRIPT, "utf8"); t.match(src, /datetime\.now\(timezone\.utc\)\.strftime\("%Y-%m-%dT%H:%M:%SZ"\)/, "UTC, not local time labelled Z"); t.match(src, /FAILED: the second run is not a no-op/);
});
test("REVIEWED PLAN ONLY: --apply is bound to the reviewed updates.sql — a fresh plan that differs (a row added or removed) is refused; the run's own timestamp never counts as drift", () => {
  const d = dirWith(), o1 = tmp(), o2 = tmp();
  t.equal(cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o1, "--stamp", "2026-09-26T01:00:00Z", "--simulate"]).status, 0);
  t.equal(cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o2, "--stamp", "2026-09-27T09:30:00Z", "--simulate"]).status, 0);
  const reviewed = fs.readFileSync(path.join(o1, "updates.sql"), "utf8"), fresh = fs.readFileSync(path.join(o2, "updates.sql"), "utf8");
  t.notEqual(reviewed, fresh, "the two runs carry different stamps");
  const r = py(`
import fcfs_cycles as f
def upd(text): return [{"sql": ln} for ln in text.splitlines() if ln.strip()]
rev = ${JSON.stringify(reviewed)}
fresh = ${JSON.stringify(fresh)}
lines = [ln for ln in rev.splitlines() if ln.strip()]
print(json.dumps({"same": f.plan_drift(upd(fresh), rev), "added": f.plan_drift(upd(fresh) + [{"sql": "UPDATE player_acquisition_cycles SET salary_at_acquisition_usd = 1000 WHERE cycle_id = 999999;"}], rev), "removed": f.plan_drift(upd("\\n".join(lines[1:])), rev), "empty": f.plan_drift([], "")}))`);
  t.deepEqual(r.same, { ok: true, added: 0, removed: 0 }, "identical modulo the timestamp"); t.deepEqual(r.added, { ok: false, added: 1, removed: 0 }); t.deepEqual(r.removed, { ok: false, added: 0, removed: 1 }); t.deepEqual(r.empty, { ok: true, added: 0, removed: 0 });
  const src = fs.readFileSync(SCRIPT, "utf8"); t.match(src, /--apply needs \{flag\} <the \{own_file\} from the dry run you reviewed>/); t.match(src, /"updates\.sql", "--reviewed-updates"/); t.match(src, /REFUSED: the plan changed since it was reviewed/);
  const help = cli(["--help"]); t.match(help.out, /--reviewed-updates/);
});
test("the D1 read channel of the ETL refuses anything but SELECT; the SELECTs name real production columns", () => {
  const r = py(`
import backfill_cycles_pass2 as p
errs = []
for bad in ["UPDATE player_acquisition_cycles SET season = 1", "DELETE FROM player_acquisition_cycles"]:
    try:
        p._d1_select(bad); errs.append("no error")
    except ValueError as e:
        errs.append(str(e))
print(json.dumps({"errs": errs, "queries": p.FCFS_SQL}))`);
  for (const e of r.errs) t.match(e, /read-only helper/);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE player_acquisition_cycles (cycle_id INTEGER, player_id TEXT, franchise_id TEXT, season INTEGER, acquisition_path TEXT, acquisition_date TEXT, salary_at_acquisition_usd INTEGER, contract_years_at_acquisition INTEGER, source TEXT, notes TEXT, status TEXT, drop_date TEXT, updated_at_utc TEXT); CREATE TABLE src_adddrop (season INTEGER, player_id TEXT, franchise_id TEXT, move_type TEXT, method TEXT, salary INTEGER, unix_timestamp INTEGER); CREATE TABLE mfl_historical_transactions (season INTEGER, player_in_id TEXT, franchise_id TEXT, type TEXT, salary INTEGER, ts_unix INTEGER)");
  for (const [k, q] of Object.entries(r.queries)) t.ok(Array.isArray(db.prepare(q).all()), k);
});

// ═════════════════════════════ the key-level RECONCILIATION and the INSERT-ONLY creation of the missing cycles ═════════════════════════════
const CY = (id, pid, fid, season, date, over) => cyc({ cycle_id: id, player_id: pid, franchise_id: fid, season, acquisition_date: date, ...(over || {}) });
const AD = (season, pid, fid, iso, extra) => ({ season, player_id: pid, franchise_id: fid, move_type: "ADD", method: "FREE_AGENT", salary: 1000, unix_timestamp: unix(iso), ...(extra || {}) });
const DR = (season, pid, fid, iso, method = "FREE_AGENT") => ({ season, player_id: pid, franchise_id: fid, move_type: "DROP", method, unix_timestamp: unix(iso) });
const RC_CYCLES = [
  CY(1, "300", "0001", 2024, "2024-09-10 10:00:00", { salary_at_acquisition_usd: 1000, contract_years_at_acquisition: 1 }),   // exactly-one match
  CY(2, "301", "0002", 2024, "2024-09-11 10:00:00"),                                                                              // exactly-one match
  CY(3, "302", "0003", 2024, "2024-09-12 10:00:00"),                                                                              // ORPHAN: no evidence in either ledger
  CY(4, "303", "0004", 2024, "2024-09-13 10:00:00"),                                                                              // proven ONLY by the second ledger
  CY(5, "304", "0005", 2024, "2024-09-14 10:00:00"),                                                                              // one of TWO cycles for ONE period …
  CY(6, "304", "0005", 2024, "2024-09-14 10:00:30"),                                                                              // … the duplicate-cycle extra
  CY(7, "305", "0006", 2024, "2024-09-15 10:00:00"), CY(8, "305", "0006", 2024, "2024-09-25 10:00:00"),                            // two periods, two cycles (a distinct re-acquisition)
  { ...CY(9, "300", "0001", 2024, "2024-08-01 09:00:00"), acquisition_path: "auction" },                                            // not FCFS: never a bucket
];
const RC_ADDDROP = [
  AD(2024, "300", "0001", "2024-09-10T10:00:00"), AD(2024, "301", "0002", "2024-09-11T10:00:00"), AD(2024, "304", "0005", "2024-09-14T10:00:00"), AD(2024, "305", "0006", "2024-09-15T10:00:00"), AD(2024, "305", "0006", "2024-09-25T10:00:00"),
  AD(2025, "400", "0007", "2025-09-20T10:00:00"),                            // A: a later same-season DROP by the SAME franchise ends it
  AD(2025, "401", "0008", "2025-09-21T10:00:00"),                            // B: another franchise's drop does not end it
  AD(2025, "402", "0009", "2025-09-22T10:00:00"),                            // C: a NEXT-SEASON drop does not end it
  AD(2025, "403", "0010", "2025-09-10T10:00:00"), AD(2025, "403", "0010", "2025-09-30T10:00:00"),   // D1 / D2: a drop between them ends D1, the later one ends D2
  AD(2025, "404", "0011", "2025-09-10T10:00:00"), AD(2025, "404", "0011", "2025-09-30T10:00:00"),   // E1 / E2: no drop between — the one drop after E2 ends E2 ONLY (never both)
  AD(2025, "405", "0012", "2025-09-23T10:00:00", { salary: 5000 }),         // F: the transaction carries $5,000 — a conflict, never invented over
  AD(2025, "406", "0013", "2025-09-24T10:00:00"),                            // G: nothing ever ends it
  AD(2026, "500", "0014", "2026-09-13T10:00:00"),                            // beyond the scope (the live season) — reported, never created here
];
const RC_HIST = [{ season: 2024, player_in_id: "303", franchise_id: "0004", type: "FREE_AGENT", salary: 1000, ts_unix: unix("2024-09-13T10:00:00") },     // the second ledger proves cycle 4
  { season: 2025, player_in_id: "407", franchise_id: "0015", type: "FREE_AGENT", salary: 1000, ts_unix: unix("2025-09-25T10:00:00") }];                // H: a 2025 period ONLY the second ledger proves
const RC_MOVES = [DR(2025, "400", "0007", "2025-10-12T10:00:00"), DR(2025, "401", "0011", "2025-09-30T10:00:00"), DR(2026, "402", "0009", "2026-01-05T10:00:00"),
  DR(2025, "403", "0010", "2025-09-20T10:00:00"), DR(2025, "403", "0010", "2025-10-10T10:00:00"), DR(2025, "404", "0011", "2025-10-10T10:00:00", "BBID")];
const RC_TX2026 = [{ season: "2026", mfl_txn_id: "x", unix_timestamp: unix("2026-09-13T10:00:00"), franchise_id: "0014", added_players: "500," }, { season: "2026", mfl_txn_id: "y", unix_timestamp: unix("2026-09-20T10:00:00"), franchise_id: "0004", added_players: "16619," }];
const rcDir = (over) => { const d = tmp(); const data = { cycles: RC_CYCLES.filter((c) => c.acquisition_path === "fcfs"), adddrop: RC_ADDDROP, hist: RC_HIST, moves: RC_MOVES, tx2026: RC_TX2026, ...(over || {}) }; for (const [k, v] of Object.entries(data)) fs.writeFileSync(path.join(d, `${k}.json`), JSON.stringify(v)); return d; };
const PYJ = (v) => JSON.stringify(JSON.stringify(v));

test("RECONCILE: every period and every cycle lands in exactly ONE bucket, both identities are proven, the earlier 'N periods / M cycles / K missing' figures are bridged — and an ambiguity makes the plan NOT approvable", () => {
  const r = py(`
import fcfs_cycles as f
cycles = json.loads(${PYJ(RC_CYCLES)}); ev = f.evidence_from_rows(json.loads(${PYJ(RC_ADDDROP)}), json.loads(${PYJ(RC_HIST)}))
oos = [{"season": 2026, "pid": "500", "fid": "0014", "ts": 1, "salary": None, "sources": ["ups_transactions"]}, {"season": 2026, "pid": "16619", "fid": "0004", "ts": 2, "salary": None, "sources": ["ups_transactions"]}]
print(json.dumps(f.reconcile(cycles, ev, out_of_scope=oos)))`);
  t.equal(r.unique_periods, 16, "2024: 6 (five src_adddrop + one only the second ledger) · 2025: 10 — the 2026 add is beyond the scope"); t.equal(r.exactly_one_match, 6); t.equal(r.matched_proven_only_by_mfl_historical_transactions, 1);
  t.equal(r.periods_without_cycle.total, 10); t.deepEqual(r.periods_without_cycle.by_season, { 2025: 10 }); t.equal(r.cycles_total, 8, "the auction cycle is not FCFS");
  t.equal(r.orphan_cycles.total, 2); t.equal(r.orphan_cycles.no_evidence_in_either_ledger, 1); t.equal(r.orphan_cycles.duplicate_cycle_extra, 1, "a period exists but a sibling cycle already took it");
  t.deepEqual(r.duplicate_periods.detail.map((d) => [d.key, d.periods, d.cycles, d.matched]), [["2024:305:0006", 2, 2, 2], ["2025:403:0010", 2, 0, 0], ["2025:404:0011", 2, 0, 0]]);
  t.deepEqual(r.duplicate_cycles.detail.map((d) => [d.key, d.cycles, d.periods, d.matched]), [["2024:304:0005", 2, 1, 1], ["2024:305:0006", 2, 2, 2]]);
  t.equal(r.identity["periods = matched + periods_without_cycle"].holds, true); t.deepEqual([r.identity["periods = matched + periods_without_cycle"].left, r.identity["periods = matched + periods_without_cycle"].right], [16, 16]);
  t.equal(r.identity["cycles = matched + orphan_cycles"].holds, true); t.deepEqual([r.identity["cycles = matched + orphan_cycles"].left, r.identity["cycles = matched + orphan_cycles"].right], [8, 8]); t.equal(r.balanced, true);
  t.equal(r.ambiguous.periods.length, 1, "period 2024:304 has TWO candidate cycles within the window — the matcher had to choose"); t.equal(r.updates_approvable, false, "balanced but ambiguous ⇒ not approvable"); t.match(r.not_approvable_reason, /ambiguous/);
  // the bridge: what the earlier report counted, and why it never added up
  t.deepEqual(r.src_adddrop_only_basis, { periods: 14, matched: 5, periods_without_cycle: 9, orphan_cycles: 3 });
  t.deepEqual({ p: r.bridge.earlier_report.periods, c: r.bridge.earlier_report.cycles, m: r.bridge.earlier_report.missing, sum: r.bridge.earlier_report.cycles_plus_missing, diff: r.bridge.earlier_report.difference }, { p: 16, c: 8, m: 9, sum: 17, diff: 1 });
  t.equal(r.bridge.holds, true, "difference = orphan cycles (src_adddrop-only basis) − out-of-scope periods = 3 − 2"); t.match(r.bridge.difference_is, /3 orphan cycles .* − 2 out-of-scope periods = 1/);
  t.equal(r.out_of_scope_periods.length, 2, "the 2026 add both the ledger and ups_transactions know is ONE period (deduped by key) + the other one");
  // without the duplicate cycle there is nothing ambiguous and the update plan IS approvable
  const clean = py(`
import fcfs_cycles as f
cycles = [c for c in json.loads(${PYJ(RC_CYCLES)}) if c["cycle_id"] != 6]; ev = f.evidence_from_rows(json.loads(${PYJ(RC_ADDDROP)}), json.loads(${PYJ(RC_HIST)}))
r = f.reconcile(cycles, ev); print(json.dumps({"bal": r["balanced"], "amb": r["ambiguous"]["total"], "appr": r["updates_approvable"], "orph": r["orphan_cycles"]["total"], "match": r["exactly_one_match"]}))`);
  t.deepEqual(clean, { bal: true, amb: 0, appr: true, orph: 1, match: 6 });
});
test("RECONCILE (reports): --fcfs-acquisition-fields writes reconciliation.json / .md / .csv; the markdown states the identities; --apply is gated on `updates_approvable`", () => {
  const d = rcDir(), o = tmp();
  const r = cli(["--fcfs-acquisition-fields", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T00:00:00Z", "--simulate"]); t.equal(r.status, 0, r.err);
  for (const f of ["reconciliation.json", "reconciliation.md", "reconciliation.csv"]) t.ok(fs.existsSync(path.join(o, f)), f);
  const md = fs.readFileSync(path.join(o, "reconciliation.md"), "utf8"); t.match(md, /\| unique FCFS periods \(season, player, franchise, stamp\) \| 16 \|/); t.match(md, /periods = matched \+ periods_without_cycle: 16 = 16 → HOLDS/); t.match(md, /cycles = matched \+ orphan_cycles: 8 = 8 → HOLDS/); t.match(md, /updates approvable:\*\* False \(ambiguous matches exist\)/);
  t.match(fs.readFileSync(path.join(o, "reconciliation.csv"), "utf8"), /^"bucket","key","season","detail"\n"period_without_cycle","2025:403:0010",/);
  const s = JSON.parse(fs.readFileSync(path.join(o, "summary.json"), "utf8")); t.equal(s.reconciliation.balanced, true); t.equal(s.reconciliation.updates_approvable, false); t.equal(s.reconciliation.bridge_holds, true);
  const src = fs.readFileSync(SCRIPT, "utf8"); t.match(src, /if not rec\["updates_approvable"\]:\n\s+print\(f"REFUSED: the cycle counts do not balance/, "the 652-cycle UPDATE plan cannot be applied until the counts balance");
});

test("RECONCILE (basis discipline — regression for the 709/671/56 off-by-one): a period proven only by the second ledger is COUNTED and MATCHED on the union basis; the identity holds on EITHER basis, but only when periods and orphans are read from the SAME basis — mixing them reproduces the exact 671+56=727\u2260709 mismatch Keith caught", () => {
  const CYCLES4 = [
    CY(1, "300", "0001", 2024, "2024-09-10 10:00:00", { salary_at_acquisition_usd: 1000, contract_years_at_acquisition: 1 }),
    CY(2, "301", "0002", 2024, "2024-09-11 10:00:00"),
    CY(3, "302", "0003", 2024, "2024-09-12 10:00:00"),      // no evidence in either ledger \u2014 a real orphan
    CY(4, "303", "0004", 2024, "2024-09-13 10:00:00"),      // proven ONLY by the second ledger
  ];
  const ADDDROP4 = [AD(2024, "300", "0001", "2024-09-10T10:00:00"), AD(2024, "301", "0002", "2024-09-11T10:00:00"), AD(2026, "500", "0014", "2026-09-13T10:00:00")];
  const HIST4 = [{ season: 2024, player_in_id: "303", franchise_id: "0004", type: "FREE_AGENT", salary: 1000, ts_unix: unix("2024-09-13T10:00:00") }];
  const r = py(`
import fcfs_cycles as f
cycles = json.loads(${PYJ(CYCLES4)})
ev = f.evidence_from_rows(json.loads(${PYJ(ADDDROP4)}), json.loads(${PYJ(HIST4)}))
oos = [{"season": 2026, "pid": "500", "fid": "0014", "ts": 1, "salary": None, "sources": ["ups_transactions"]}]
print(json.dumps(f.reconcile(cycles, ev, out_of_scope=oos)))`);
  // the hist-only period is counted (never silently dropped) and its cycle is MATCHED \u2014 the exact fix that turned production's "705" into "708"
  t.equal(r.matched_proven_only_by_mfl_historical_transactions, 1);
  t.equal(r.unique_periods, 3, "2 src_adddrop periods + 1 the second ledger alone proves; the 2026 add is beyond the scope");
  t.equal(r.src_adddrop_only_basis.periods, 2, "without the second ledger the hist-only period does not exist at all in that basis's period set");
  t.equal(r.orphan_cycles.total, 1, "on the union basis only cycle 3 (no evidence anywhere) is an orphan");
  t.equal(r.src_adddrop_only_basis.orphan_cycles, 2, "on the src_adddrop-only basis cycle 4 loses its only proof and becomes an orphan too \u2014 the same mechanism that separated production's 19 orphans from the earlier basis's 22");
  // EITHER basis balances to the SAME total when read consistently \u2014 a period only ever moves between "counted" and "orphan", it never vanishes
  const unionTotal = r.unique_periods + r.orphan_cycles.total;
  const srcTotal = r.src_adddrop_only_basis.periods + r.src_adddrop_only_basis.orphan_cycles;
  t.equal(unionTotal, r.cycles_total + r.periods_without_cycle.total, "union basis: periods + orphans = cycles + missing");
  t.equal(srcTotal, r.cycles_total + r.src_adddrop_only_basis.periods_without_cycle, "src_adddrop-only basis: the same identity, computed on its own numbers");
  t.equal(unionTotal, srcTotal, "both bases land on the SAME total \u2014 exactly as production's 708+19 and 705+22 both equal 727");
  // THE BUG, reproduced: quoting one basis's periods next to the OTHER basis's orphans is exactly the shape of the earlier mismatched "709 periods / 671 cycles / 56 missing" report
  const mismatched = r.src_adddrop_only_basis.periods + r.orphan_cycles.total;   // src-only periods + UNION orphans \u2014 two different bases' numbers, quoted together
  t.notEqual(mismatched, r.cycles_total + r.periods_without_cycle.total, "mixing bases silently breaks the identity \u2014 the earlier report's exact failure mode; this assertion fails again if that off-by-one returns");
  t.equal(r.bridge.holds, true, "the report itself always states which basis it bridges from, and proves the bridge");
});
test("CREATE: a proven period with no cycle gets ONE INSERT through cycle_to_row — canonical $1,000 / 1 year, its own source tag; the end is set ONLY from a later same-season DROP by the same franchise; nothing is invented", () => {
  const d = rcDir(), o = tmp();
  const r = cli(["--fcfs-create-missing", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T20:00:00Z"]); t.equal(r.status, 0, r.err);
  const s = JSON.parse(fs.readFileSync(path.join(o, "summary.json"), "utf8"));
  t.deepEqual({ w: s.summary.periods_without_cycle, i: s.summary.planned_inserts, c: s.summary.closed_by_drop, o: s.summary.left_open, k: s.summary.skipped, oos: s.summary.out_of_scope_periods }, { w: 10, i: 9, c: 4, o: 5, k: 1, oos: 2 }); t.deepEqual(s.summary.by_season, { 2025: { insert: 9, manual_review_salary_conflict: 1 } });
  const rows = JSON.parse(fs.readFileSync(path.join(o, "insert_rows.json"), "utf8")); const ins = rows.filter((x) => x.disposition === "insert"); const by = (pid, iso) => ins.find((x) => x.player_id === pid && (!iso || x.acquisition_date === iso.replace("T", " ")));
  for (const x of ins) { t.equal(x.row.salary_at_acquisition_usd, 1000); t.equal(x.row.contract_years_at_acquisition, 1); t.equal(x.row.acquisition_path, "fcfs"); t.equal(x.row.source, "fcfs_narrow_create_2026_09_26"); t.equal(x.row.created_at_utc, "2026-09-26T20:00:00Z", "the run's UTC stamp"); t.match(x.row.notes, /created_by_fcfs_narrow_pass/); t.equal(x.row.season, 2025); t.equal(x.row.salary_at_drop_usd, null, "every drop-side financial column stays NULL — enrichment is still owed"); }
  // A: closed by a same-franchise same-season drop; the drop date is the ledger's; a week is derived from the NFL calendar
  t.equal(by("400").row.status, "closed"); t.equal(by("400").row.drop_date, "2025-10-12 10:00:00"); t.equal(by("400").row.drop_reason, "cut"); t.equal(by("400").row.acquisition_date, "2025-09-20 10:00:00"); t.equal(by("400").row.acquisition_week, 3);
  // B / C: not ended by another franchise's drop / a next-season drop → open, and it SAYS the end is unproven
  for (const pid of ["401", "402", "406", "407"]) { t.equal(by(pid).row.status, "open", pid); t.equal(by(pid).row.drop_date, null); t.match(by(pid).row.notes, /end_not_proven_by_ledger/); }
  // a distinct re-acquisition is its OWN cycle; one drop is never used twice
  t.equal(ins.filter((x) => x.player_id === "403").length, 2); t.equal(by("403", "2025-09-10T10:00:00").row.drop_date, "2025-09-20 10:00:00"); t.equal(by("403", "2025-09-30T10:00:00").row.drop_date, "2025-10-10 10:00:00");
  t.equal(by("404", "2025-09-10T10:00:00").row.status, "open", "E1: the only drop comes AFTER the next period began — it ends E2, not E1"); t.equal(by("404", "2025-09-30T10:00:00").row.drop_date, "2025-10-10 10:00:00");
  // the conflict is reported, never written; the 2026 add is out of scope; the hist-only period IS created
  const f = rows.find((x) => x.player_id === "405"); t.equal(f.disposition, "manual_review_salary_conflict"); t.match(f.reason, /\$5000, not the canonical \$1,000/);
  t.equal(rows.some((x) => x.player_id === "500"), false, "2026 is never created here"); t.deepEqual(by("407").evidence, ["mfl_historical_transactions"], "proven by the second ledger alone");
  const sql = fs.readFileSync(path.join(o, "inserts.sql"), "utf8").trim().split("\n"); t.equal(sql.length, 9);
  for (const line of sql) { t.match(line, /^INSERT INTO player_acquisition_cycles \(.*\) SELECT .* WHERE NOT EXISTS \(SELECT 1 FROM player_acquisition_cycles WHERE season = 2025 AND player_id = '\d+' AND franchise_id = '\d+' AND acquisition_path = 'fcfs' AND acquisition_date = '[\d: -]+'\);$/); t.doesNotMatch(line, /\bUPDATE\b|\bDELETE\b|\bDROP\b/i, "INSERT-only"); }
  t.equal(new Set(sql).size, 9, "no duplicate statement");
});
test("CREATE (SQL): applied to a real table the INSERTs add exactly the planned rows and leave every existing row BYTE-IDENTICAL; applying twice adds nothing; a key that already exists is never re-created; rollback.sql removes exactly what was added", () => {
  const d = rcDir(), o = tmp();
  t.equal(cli(["--fcfs-create-missing", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T20:00:00Z"]).status, 0);
  const inserts = fs.readFileSync(path.join(o, "inserts.sql"), "utf8").trim().split("\n"), rollback = fs.readFileSync(path.join(o, "rollback.sql"), "utf8").trim().split("\n");
  const cols = JSON.parse(fs.readFileSync(path.join(o, "insert_rows.json"), "utf8")).find((x) => x.row).row; const colNames = Object.keys(cols);
  const db = new DatabaseSync(":memory:"); db.exec(`CREATE TABLE player_acquisition_cycles (cycle_id INTEGER PRIMARY KEY AUTOINCREMENT, ${colNames.join(", ")})`);   // (untyped columns: node:sqlite binds a JS number as REAL, and the guard compares numerically)
  const seed = (c) => { const row = { ...Object.fromEntries(colNames.map((k) => [k, null])), ...Object.fromEntries(Object.entries(c).filter(([k]) => colNames.includes(k))), source: c.source || "backfill_pass3_2026_05_09" }; db.prepare(`INSERT INTO player_acquisition_cycles (cycle_id, ${colNames.join(", ")}) VALUES (?, ${colNames.map(() => "?").join(", ")})`).run(c.cycle_id, ...colNames.map((k) => row[k])); };
  for (const c of RC_CYCLES) seed({ ...c, salary_at_drop_usd: 40000 });                                     // a later replacement contract lives in a drop-time column
  seed({ cycle_id: 50, player_id: "406", franchise_id: "0013", season: 2025, acquisition_path: "fcfs", acquisition_date: "2025-09-24 10:00:00", source: "someone_else" });    // G ALREADY exists (another source) — the guard must skip it
  const snap = () => JSON.stringify(db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all()); const before = snap(), beforeRows = db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all();
  const changes = inserts.map((s) => Number(db.prepare(s).run().changes)); t.equal(changes.filter((n) => n === 1).length, 8, "eight rows added"); t.equal(changes.filter((n) => n === 0).length, 1, "the ninth (G) already existed: the NOT EXISTS guard inserted nothing");
  const after = db.prepare("SELECT * FROM player_acquisition_cycles ORDER BY cycle_id").all(); t.equal(after.length, beforeRows.length + 8);
  for (const b of beforeRows) t.deepEqual(after.find((a) => a.cycle_id === b.cycle_id), b, `existing cycle ${b.cycle_id} is byte-identical`);
  t.equal(after.find((a) => a.cycle_id === 1).salary_at_drop_usd, 40000, "the later replacement contract is preserved");
  t.equal(after.filter((a) => a.source === "fcfs_narrow_create_2026_09_26").length, 8);
  const afterSnap = snap(); t.deepEqual(inserts.map((s) => Number(db.prepare(s).run().changes)), Array(9).fill(0), "applying the same INSERTs again adds nothing"); t.equal(snap(), afterSnap, "identical");
  // rollback: only rows carrying THIS pass's source tag AND the exact natural key
  t.equal(rollback.length, 9); for (const s of rollback) { t.match(s, /^DELETE FROM player_acquisition_cycles WHERE season = 2025 AND player_id = '\d+' AND franchise_id = '\d+' AND acquisition_path = 'fcfs' AND acquisition_date = '[\d: -]+' AND source = 'fcfs_narrow_create_2026_09_26';$/); }
  t.deepEqual(rollback.map((s) => Number(db.prepare(s).run().changes)).filter((n) => n === 1).length, 8, "eight deleted — the pre-existing (other-source) row for G is NOT touched");
  t.equal(snap(), before, "rollback restores the before-state exactly"); t.deepEqual(rollback.map((s) => Number(db.prepare(s).run().changes)), Array(9).fill(0), "a second rollback is a no-op");
});
test("CREATE (second run · exports · reviewed plan): before/after exports, the second run plans ZERO inserts on the state the first run leaves, the scope excludes 2026, and --apply is bound to the reviewed inserts.sql", () => {
  const d = rcDir(), o = tmp();
  const r = cli(["--fcfs-create-missing", "--input-dir", d, "--out", o, "--stamp", "2026-09-26T20:00:00Z"]); t.equal(r.status, 0, r.err);
  const s = JSON.parse(fs.readFileSync(path.join(o, "summary.json"), "utf8")); t.equal(s.existing_rows_untouched, true); t.deepEqual(s.second_run, { inserts: 0, identical: true, periods_without_cycle_after: 1 }, "the ONE period left without a cycle is the salary conflict — reported, never invented over"); t.equal(s.reconciliation_balanced, true);
  for (const f of ["cycles_before.json", "cycles_after.json", "insert_rows.json", "inserts.sql", "rollback.sql", "reconciliation.json", "reconciliation.md"]) t.ok(fs.existsSync(path.join(o, f)), f);
  const before = JSON.parse(fs.readFileSync(path.join(o, "cycles_before.json"), "utf8")), after = JSON.parse(fs.readFileSync(path.join(o, "cycles_after.json"), "utf8")); t.equal(after.length, before.length + 9);
  // re-run the ETL on ITS OWN OUTPUT: nothing to insert
  const d2 = rcDir({ cycles: after }); const o2 = tmp(); const r2 = cli(["--fcfs-create-missing", "--input-dir", d2, "--out", o2, "--stamp", "2026-09-27T09:00:00Z"]); t.equal(r2.status, 0, r2.err);
  t.equal(JSON.parse(fs.readFileSync(path.join(o2, "summary.json"), "utf8")).summary.planned_inserts, 0, "second ETL run: zero inserts"); t.equal(fs.readFileSync(path.join(o2, "inserts.sql"), "utf8"), "");
  // a different stamp is not drift; a row added or removed IS
  const o3 = tmp(); t.equal(cli(["--fcfs-create-missing", "--input-dir", d, "--out", o3, "--stamp", "2026-09-27T12:34:56Z"]).status, 0);
  const reviewed = fs.readFileSync(path.join(o, "inserts.sql"), "utf8"), fresh = fs.readFileSync(path.join(o3, "inserts.sql"), "utf8"); t.notEqual(reviewed, fresh, "the two runs carry different stamps");
  const drift = py(`
import fcfs_cycles as f
def ins(text): return [{"sql": ln} for ln in text.splitlines() if ln.strip()]
reviewed = ${JSON.stringify(reviewed)}; fresh = ${JSON.stringify(fresh)}
print(json.dumps({"same": f.plan_inserts_drift(ins(fresh), reviewed), "added": f.plan_inserts_drift(ins(fresh) + [{"sql": "INSERT INTO x VALUES (1);"}], reviewed), "removed": f.plan_inserts_drift(ins(fresh)[1:], reviewed)}))`);
  t.deepEqual(drift.same, { ok: true, added: 0, removed: 0 }, "the run's own timestamp never counts as drift"); t.equal(drift.added.ok, false); t.equal(drift.added.added, 1); t.equal(drift.removed.ok, false); t.equal(drift.removed.removed, 1);
  // write mode is never implicit
  const refused = cli(["--fcfs-create-missing", "--input-dir", d, "--out", tmp(), "--apply"]); t.equal(refused.status, 2); t.match(refused.err, /--apply needs --yes/);
  const offline = cli(["--fcfs-create-missing", "--input-dir", d, "--out", tmp(), "--apply", "--yes"]); t.equal(offline.status, 2); t.match(offline.err, /cannot be combined with --input-dir/);
  const src = fs.readFileSync(SCRIPT, "utf8"); t.match(src, /"inserts\.sql", "--reviewed-inserts"/); t.match(src, /FAILED: the plan touches an existing row, or the second run is not a no-op/); t.match(src, /INCLUDED_SEASONS = list\(range\(2011, 2025\)\)/, "the FULL pair path is untouched (it still DELETEs backfill_pass2% — never use it)");
  const lib = fs.readFileSync(path.join(ROOT, "pipelines/etl/lib/fcfs_cycles.py"), "utf8"); t.match(lib, /CREATE_SCOPE = \(2011, 2025\)/); t.match(lib, /CREATE_SOURCE = "fcfs_narrow_create_2026_09_26"/); t.doesNotMatch(lib.slice(lib.indexOf("def insert_sql")), /"UPDATE |'UPDATE |DELETE FROM player_acquisition_cycles WHERE season = \{/, "the creation code never builds an UPDATE, and its DELETE (rollback) is keyed and source-guarded");
});
test("CREATE (inputs): the two extra read-only SELECTs (`moves`, `tx2026`) run over the production column names; `cycle_to_row` takes a source and a stamp and writes real UTC", () => {
  const r = py(`
import backfill_cycles_pass2 as p
row = p.cycle_to_row({"player_id":"1","franchise_id":"0001","season":2025,"acquisition_path":"fcfs","ts_iso":"2025-09-07 14:28:02","acquisition_date":"2025-09-07 14:28:02","status":"open"}, source="fcfs_narrow_create_2026_09_26", stamp="2026-09-26T20:00:00Z")
default = p.cycle_to_row({"player_id":"1","franchise_id":"0001","season":2024,"acquisition_path":"ww","ts_iso":"2024-09-07 14:28:02","acquisition_date":"2024-09-07 14:28:02","status":"open"})
print(json.dumps({"queries": p.FCFS_SQL_OPTIONAL, "row": [row["source"], row["created_at_utc"], row["updated_at_utc"], row["acquisition_week"], row["total_eligible_weeks"], row["salary_at_acquisition_usd"]], "default_source": default["source"], "default_stamp_shape": default["created_at_utc"][-1]}))`);
  t.deepEqual(r.row, ["fcfs_narrow_create_2026_09_26", "2026-09-26T20:00:00Z", "2026-09-26T20:00:00Z", 1, 17, 1000]); t.equal(r.default_source, "backfill_pass2_2026_05_09", "the full generation path keeps its own source tag"); t.equal(r.default_stamp_shape, "Z");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE src_adddrop (season INTEGER, player_id TEXT, franchise_id TEXT, move_type TEXT, method TEXT, salary INTEGER, unix_timestamp INTEGER); CREATE TABLE ups_transactions (season TEXT, mfl_txn_id TEXT, unix_timestamp INTEGER, franchise_id TEXT, added_players TEXT, type TEXT)");
  for (const [k, q] of Object.entries(r.queries)) { t.match(q, /^SELECT /, k + " is read-only"); t.ok(Array.isArray(db.prepare(q).all()), k); }
});

test("REVIEW FIXES (ETL apply gating): every data-free refusal comes BEFORE any read or write; the reviewed plan is read before the run writes anything (a reused --out cannot fake it); stray flags and the destructive full pair path are refused", () => {
  const d = rcDir();
  // the refusals fire before ANY output is written: a NEW --out stays EMPTY
  for (const mode of ["--fcfs-acquisition-fields", "--fcfs-create-missing"]) { const o = tmp(); const r = cli([mode, "--input-dir", d, "--out", o, "--apply"]); t.equal(r.status, 2, mode); t.match(r.err, /--apply needs --yes/); t.deepEqual(fs.readdirSync(o), [], mode + ": nothing was written before the refusal"); }
  { const o = tmp(); const r = cli(["--fcfs-create-missing", "--out", o, "--apply", "--yes", "--reviewed-inserts", path.join(o, "inserts.sql")]); t.equal(r.status, 2); t.match(r.err, /(does not exist|OWN output)/, "a reviewed plan that is missing / is this run's own output is refused BEFORE any D1 read"); }
  // the reviewed plan IS the output file of a previous run in the SAME directory: refused (the fresh plan would have overwritten it)
  const r1 = py(`
import backfill_cycles_pass2 as p, pathlib, tempfile, sys, io
out = pathlib.Path(tempfile.mkdtemp()); other = pathlib.Path(tempfile.mkdtemp()) / "reviewed.sql"; other.write_text("INSERT reviewed;\\n"); (out / "inserts.sql").write_text("fresh")
res = {}
for name, args in {"own": (True, True, None, str(out / "inserts.sql"), out, "inserts.sql", "--reviewed-inserts"), "ok": (True, True, None, str(other), out, "inserts.sql", "--reviewed-inserts"),
                   "noyes": (True, False, None, str(other), out, "inserts.sql", "--reviewed-inserts"), "input": (True, True, "somedir", str(other), out, "inserts.sql", "--reviewed-inserts"), "noreviewed": (True, True, None, None, out, "inserts.sql", "--reviewed-inserts"),
                   "dry": (False, False, None, None, out, "inserts.sql", "--reviewed-inserts")}.items():
    try: res[name] = p._preflight_apply(*args)
    except SystemExit as e: res[name] = {"exit": e.code}
print(json.dumps(res))`);
  t.deepEqual(r1.own, { exit: 2 }, "the reviewed plan is this run's own output: refused"); t.equal(r1.ok, "INSERT reviewed;\n", "a separate reviewed file is read and returned (BEFORE anything is written)"); t.deepEqual(r1.noyes, { exit: 2 }); t.deepEqual(r1.input, { exit: 2 }); t.deepEqual(r1.noreviewed, { exit: 2 }); t.equal(r1.dry, null, "a dry run has no gate");
  // stray flags are refused, never silently ignored; the destructive full pair --apply needs its own explicit flag
  for (const [args, msg] of [[["--yes"], /only apply to --fcfs-acquisition-fields or --fcfs-create-missing/], [["--reviewed-inserts", "x.sql"], /only apply to/], [["--input-dir", "/tmp"], /only apply to/], [["--simulate"], /only apply to/], [["--fcfs-acquisition-fields", "--fcfs-create-missing"], /choose ONE of/]]) { const r = cli(args); t.equal(r.status, 2, args.join(" ")); t.match(r.err, msg); }
  const full = cli(["--pair", "--apply"]); t.equal(full.status, 2); t.match(full.err, /FULL pair path: it DELETEs every backfill_pass2% cycle/); t.match(full.err, /--full-pair-delete-and-reinsert/);
  const src = fs.readFileSync(SCRIPT, "utf8"); t.match(src, /if not rec\["updates_approvable"\]:/); t.match(src, /if not plan\["summary"\]\["approvable"\]:/, "the creation apply is gated on an approvable plan too"); t.match(src, /reviewed_text = _preflight_apply\(/);
  t.doesNotMatch(src.slice(src.indexOf("def cmd_fcfs_create_missing")), /Path\(reviewed_inserts\)\.read_text\(\)/, "the reviewed file is never re-read after this run wrote its outputs");
});
test("REVIEW FIXES (ETL evidence): the two ledgers fold ONE-TO-ONE within the window (a stamp a second apart is the same acquisition); unproven periods and possible duplicates are diverted, never inserted; a period ends only when the NEXT move is a drop; an ambiguity makes the creation plan NOT approvable", () => {
  const ad = (season, pid, fid, iso, salary = 1000) => ({ season, player_id: pid, franchise_id: fid, move_type: "ADD", method: "FREE_AGENT", salary, unix_timestamp: unix(iso) });
  const r = py(`
import fcfs_cycles as f
src = [${JSON.stringify(ad(2025, "700", "0001", "2025-09-20T10:00:00"))}, ${JSON.stringify(ad(2025, "701", "0002", "2025-09-21T10:00:00"))}]
hist = [{"season": 2025, "player_in_id": "700", "franchise_id": "0001", "type": "FREE_AGENT", "salary": 1000, "ts_unix": ${unix("2025-09-20T10:00:01")}},          # the SAME acquisition, stamped a second later
        {"season": 2025, "player_in_id": "701", "franchise_id": "0002", "type": "FREE_AGENT", "salary": 1000, "ts_unix": ${unix("2025-09-21T10:00:00")}},
        {"season": 2025, "player_in_id": "701", "franchise_id": "0002", "type": "FREE_AGENT", "salary": 1000, "ts_unix": ${unix("2025-09-21T10:00:00")}}]    # an identical duplicate
ev = f.evidence_from_rows(src, hist)
print(json.dumps({"n": len(ev), "sources": [sorted(e["sources"]) for e in ev]}))`);
  t.equal(r.n, 2, "two acquisitions, not four"); t.deepEqual(r.sources, [["mfl_historical_transactions", "src_adddrop"], ["mfl_historical_transactions", "src_adddrop"]]);
  // creation plan: diverted dispositions
  const plan = py(`
import fcfs_cycles as f, backfill_cycles_pass2 as p
cyc = lambda i, pid, fid, date: {"cycle_id": i, "player_id": pid, "franchise_id": fid, "season": 2025, "acquisition_path": "fcfs", "acquisition_date": date, "salary_at_acquisition_usd": None, "contract_years_at_acquisition": None, "source": "x", "updated_at_utc": "x"}
cycles = [cyc(1, "801", "0002", "2025-09-17 10:00:00"), cyc(2, "803", "0004", "2025-09-20 10:00:00")]                 # 801: a cycle THREE days before the period below; 803: matched
ev = [{"season": 2025, "pid": "800", "fid": "0001", "ts": 0, "salary": 1000, "sources": ["src_adddrop"]},          # NO usable stamp
      {"season": 2025, "pid": "", "fid": "0001", "ts": ${unix("2025-09-20T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]},                                                                        # no player
      {"season": 2025, "pid": "801", "fid": "0002", "ts": ${unix("2025-09-20T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]},                                                                      # a cycle 3 days earlier, same key
      {"season": 2025, "pid": "802", "fid": "0003", "ts": ${unix("2025-09-22T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]},                                                                      # plain: created
      {"season": 2025, "pid": "803", "fid": "0004", "ts": ${unix("2025-09-20T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]}]                                                                      # matched
moves = [{"season": 2025, "player_id": "802", "franchise_id": "0003", "move_type": "ADD", "method": "BBID", "unix_timestamp": ${unix("2025-09-25T10:00:00")}},                       # the SAME franchise re-acquires him (a BBID add) …
         {"season": 2025, "player_id": "802", "franchise_id": "0003", "move_type": "DROP", "method": "BBID", "unix_timestamp": ${unix("2025-10-05T10:00:00")}}]                       # … and THAT stint is what the drop ends
res = f.plan_fcfs_cycle_inserts(cycles, ev, moves, lambda cy: p.cycle_to_row(cy, source=f.CREATE_SOURCE, stamp="2026-09-26T20:00:00Z"), p.COL_ORDER, "2026-09-26T20:00:00Z")
print(json.dumps({"rows": [[x["player_id"], x["disposition"], x.get("closed_by_drop")] for x in res["rows"]], "inserts": len(res["inserts"]), "approvable": res["summary"]["approvable"]}))`);
  t.deepEqual(plan.rows, [["800", "manual_review_unusable_evidence", null], ["", "manual_review_unusable_evidence", null], ["801", "manual_review_possible_duplicate", null], ["802", "insert", false]], "no epoch cycle, no NULL key, no duplicate; 802's drop belongs to the LATER BBID stint, so it stays open");
  t.equal(plan.inserts, 1); t.equal(plan.approvable, true);
  // an ambiguity (one cycle, two candidate periods) makes the creation plan NOT approvable, and the reports say so
  const amb = py(`
import fcfs_cycles as f, backfill_cycles_pass2 as p
cycles = [{"cycle_id": 1, "player_id": "900", "franchise_id": "0001", "season": 2025, "acquisition_path": "fcfs", "acquisition_date": "2025-09-20 10:00:00", "salary_at_acquisition_usd": None, "contract_years_at_acquisition": None, "source": "x", "updated_at_utc": "x"}]
ev = [{"season": 2025, "pid": "900", "fid": "0001", "ts": ${unix("2025-09-20T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]}, {"season": 2025, "pid": "900", "fid": "0001", "ts": ${unix("2025-09-20T10:00:30")}, "salary": 1000, "sources": ["src_adddrop"]}]
res = f.plan_fcfs_cycle_inserts(cycles, ev, [], lambda cy: p.cycle_to_row(cy), p.COL_ORDER, "s")
rec = res["reconciliation"]
print(json.dumps({"approvable": res["summary"]["approvable"], "reason": res["summary"]["not_approvable_reason"], "amb": rec["ambiguous"], "md": f.reconciliation_markdown(rec), "csv": f.reconciliation_csv(rec), "rows": [x["disposition"] for x in res["rows"]]}))`);
  t.equal(amb.approvable, false); t.match(amb.reason, /ambiguous/); t.equal(amb.amb.cycles.length, 1, "the CYCLE has two candidate periods"); t.match(amb.md, /## Ambiguous choices/); t.match(amb.md, /cycle 1: 2 candidate periods/); t.match(amb.csv, /"ambiguous_cycle","cycle_id=1"/);
  t.deepEqual(amb.rows, ["manual_review_possible_duplicate"], "the unmatched sibling period sits within a week of an existing cycle: diverted, not inserted");
  // the identities are not tautologies any more: a duplicated cycle id (or an identical duplicated period) is reported as a failure of the balance
  const bad = py(`
import fcfs_cycles as f
c = {"cycle_id": 7, "player_id": "1", "franchise_id": "0001", "season": 2024, "acquisition_path": "fcfs", "acquisition_date": "2024-09-10 10:00:00", "salary_at_acquisition_usd": None, "contract_years_at_acquisition": None, "source": "x", "updated_at_utc": "x"}
ev = [{"season": 2024, "pid": "1", "fid": "0001", "ts": ${unix("2024-09-10T10:00:00")}, "salary": 1000, "sources": ["src_adddrop"]}]
r1 = f.reconcile([c, dict(c)], ev)                # the SAME cycle id twice
r2 = f.reconcile([c], ev + ev)                    # the SAME period twice
print(json.dumps({"dupcyc": [r1["balanced"], r1["updates_approvable"], r1["identity"]["every cycle id is distinct"]["holds"]], "dupper": [r2["balanced"], r2["identity"]["every period (season, player, franchise, stamp) is distinct"]["holds"]]}))`);
  t.deepEqual(bad.dupcyc, [false, false, false]); t.deepEqual(bad.dupper, [false, false]);
});

await run("fcfs_cycles_etl");
