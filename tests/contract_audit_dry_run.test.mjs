// A contract-route DRY RUN is recorded as a dry run, and a mislabeled one is never evidence of a contract change (2026-10-08).
//   node tests/contract_audit_dry_run.test.mjs
//
// The bug: /commish-contract-update, /offer-mym and /offer-restructure wrote their salary_change_log audit row with dry_run
// HARD-CODED to 0 and `landed` taken from the dry run's SIMULATED success. So every dry run read as a landed change:
// dry_run=0, landed=1, notes "import_ok_log_dispatched", import_status 0 (no MFL request) and AFTER = a copy of BEFORE.
// Production holds 27 such rows (ids 1233–1876; 1876 is the 2026-10-07 auth-check probe). The FCFS add-event closure
// (path B: worker route close_fcfs_add_event and scripts/fcfs_contract_backfill.mjs, both through
// planFcfsAddEventClosure) trusted `landed=1 AND dry_run=0` as proof of a stamp or an owner conversion.
//
// Real worker route + stateful fake MFL; the FCFS rules are run on the EXACT production rows
// (tests/fixtures/salary_change_log_mislabeled_dry_runs_2026.json — IP / user agent redacted). Nothing touches the network.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import * as FC from "../worker/src/fcfs_contract.js";
import { QUERIES } from "../scripts/fcfs_contract_backfill.mjs";

const restoreConsole = quiet();
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/salary_change_log_mislabeled_dry_runs_2026.json", import.meta.url), "utf8"));
const MISLABELED = FIX.rows.filter((r) => r.id !== 1865 && r.id !== 1875);
const REAL = { 1865: FIX.rows.find((r) => r.id === 1865), 1875: FIX.rows.find((r) => r.id === 1875) };
const MISLABELED_IDS = [1233, 1234, 1235, 1236, 1237, 1238, 1240, 1243, 1246, 1248, 1250, 1253, 1256, 1259, 1262, 1264, 1265, 1266, 1267, 1269, 1271, 1698, 1699, 1700, 1704, 1705, 1876];

// ─────────────────────────────── 1. the writer (real worker route) ───────────────────────────────
const ORIG = { id: "15000", salary: "30000", contractYear: "2", contractStatus: "Vet-FAA", contractInfo: "CL 2| TCV 60K| AAV 30K| Y1-30K, Y2-30K| GTD: 45K" };
function fresh() {
  const env = makeWorkerEnv({ YEAR: "2026", LEAGUE_ID: "74598" });
  const mfl = makeMfl();
  mfl.st.rosters = { "0003": [{ id: "15000", salary: 30000, status: "ROSTER", contractYear: 2, contractStatus: ORIG.contractStatus, contractInfo: ORIG.contractInfo }] };
  mfl.st.salaries = [{ ...ORIG }];
  mfl.install();
  return { env, mfl };
}
const update = (env, query, extra) => callWorker(env, "POST", `/commish-contract-update?L=74598&YEAR=2026${query}`, { body: {
  type: "MANUAL_CONTRACT_UPDATE", submission_kind: "manual", L: "74598", YEAR: "2026",
  player_id: "15000", player_name: "Test", franchise_id: "0003", franchise_name: "Gride", position: "WR",
  salary: 1000, contract_year: 1, contract_status: "Vet-FAA", contract_info: "CL 1| TCV 1K| AAV 1K", ...(extra || {}),
} });
const auditRows = (env) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM salary_change_log ORDER BY id").all();

for (const [label, query] of [["the owner's own proven session", "&MFL_USER_ID=tok-O"], ["the commissioner key", `&APIKEY=${ADMIN_KEY}`]]) {
  test(`WRITER: a dry run (${label}) is logged dry_run=1, landed=0, 'no MFL request' — and MFL receives nothing`, async () => {
    const { env, mfl } = fresh();
    const r = await update(env, query, { dry_run: 1 });
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.details.dry_run, true);
    t.equal(mfl.writes("salaries").length, 0, "no salaries import reached MFL"); t.equal(JSON.stringify(mfl.st.salaries), JSON.stringify([ORIG]));
    const rows = auditRows(env); t.equal(rows.length, 1);
    const a = rows[0];
    t.equal(a.dry_run, 1); t.equal(a.landed, 0); t.equal(a.import_status, 0);
    t.match(a.notes, /^dry_run_no_mfl_request \(simulated import_ok_log_dispatched\)$/);
    t.equal(FC.isMflConfirmedWrite(a), false, "and it is never evidence of a contract change");
  });
}

test("WRITER: a real write is unchanged — dry_run=0, landed=1, MFL's own status, and it IS evidence", async () => {
  const { env, mfl } = fresh();
  const r = await update(env, "&MFL_USER_ID=tok-O");
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.writes("salaries").length, 1);
  const a = auditRows(env)[0];
  t.equal(a.dry_run, 0); t.equal(a.landed, 1); t.equal(a.import_status, 200); t.equal(a.notes, "import_ok_log_dispatched");
  t.equal(a.before_contract_status, "Vet-FAA"); t.equal(a.after_contract_info, "CL 1| TCV 1K| AAV 1K");
  t.equal(FC.isMflConfirmedWrite(a), true);
});

test("WRITER: the contract-activity log (Front Office timeline) gets test_flag=1 for a dry run — its existing DRY badge — and 0 for a real write", async () => {
  const seen = [];
  for (const dry of [1, 0]) {
    const { env } = fresh();
    env.GITHUB_PAT = "test-pat";
    const mflFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const u = new URL(typeof input === "string" ? input : input.url);
      if (u.hostname === "api.github.com" && /\/dispatches$/.test(u.pathname)) { seen.push({ dry, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
      return mflFetch(input, init);
    };
    try { const r = await update(env, "&MFL_USER_ID=tok-O", dry ? { dry_run: 1 } : {}); t.equal(r.status, 200, r.text.slice(0, 200)); }
    finally { globalThis.fetch = mflFetch; }
  }
  const activity = (dry) => seen.filter((x) => x.dry === dry && x.body.event_type === "log-contract-activity").map((x) => x.body.client_payload.payload);
  t.equal(activity(1).length, 1); t.equal(activity(1)[0].test_flag, 1, "the dry run is badged DRY on the timeline");
  t.equal(activity(0).length, 1); t.equal(activity(0)[0].test_flag, 0, "a real write is not");
  const fo = fs.readFileSync(new URL("../site/rosters/v2/front_office.js", import.meta.url), "utf8");
  t.match(fo, /safeInt\(r\.test_flag, 0\) \? ' <span class="fo-test-badge" title="Dry-run \/ test submission">DRY<\/span>'/, "the timeline's own DRY badge reads test_flag");
});

test("WRITER: the audit write reads the request's own dry-run flag (source guard — no hard-coded dry_run: false on this route)", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const isDryRunAudit = dryRunFlag === 1;"), src.indexOf("} catch (_) { /* never fail the request on audit errors */ }", src.indexOf("const isDryRunAudit = dryRunFlag === 1;")));
  t.ok(block.length > 100, "the audit block was found");
  t.match(block, /dry_run: isDryRunAudit,/); t.match(block, /!isDryRunAudit &&/); t.doesNotMatch(block, /dry_run: false/);
});

// ─────────────────────── 2. the exact production rows: none of the 27 is evidence ───────────────────────
test("EXACT ROWS: all 27 mislabeled production rows are refused as evidence; the two real rows behind add event 52 are accepted", () => {
  t.deepEqual(MISLABELED.map((r) => r.id), MISLABELED_IDS, "the fixture is exactly the 27 rows");
  for (const r of MISLABELED) {
    t.deepEqual([r.dry_run, r.landed, r.import_status], [0, 1, 0], `row ${r.id} carries the false label (as stored)`);
    t.equal(FC.isMflConfirmedWrite(r), false, `row ${r.id}`);
  }
  t.equal(FC.isMflConfirmedWrite(REAL[1865]), true, "1865: the canonical stamp (import-salaries, 200)");
  t.equal(FC.isMflConfirmedWrite(REAL[1875]), true, "1875: the owner's MYM (offer-mym, 200) — salary stayed $1,000 while status, years and info changed");
  // the fixed writer's own dry-run shape is refused too, and so is any 'dry_run…' note
  t.equal(FC.isMflConfirmedWrite({ ...REAL[1875], dry_run: 1 }), false); t.equal(FC.isMflConfirmedWrite({ ...REAL[1875], landed: 0 }), false);
  t.equal(FC.isMflConfirmedWrite({ ...REAL[1875], notes: "dry_run_no_mfl_request (simulated import_ok_log_dispatched)" }), false);
  for (const st of [0, null, undefined, "", 302, 500, "abc"]) t.equal(FC.isMflConfirmedWrite({ ...REAL[1875], import_status: st }), false, `import_status ${String(st)}`);
});

// ─────────────── 3. path B (planFcfsAddEventClosure — used by the worker route AND the backfill tool) ───────────────
const ADD_52 = { id: 52, season: "2026", player_id: "13113", franchise_id: "0004", acquired_at_unix: 1789305850, source: "fcfs", contract_annotated: 3, notes: "refused" };
const close = (changeLog) => FC.planFcfsAddEventClosure({ addEvent: ADD_52, dropRow: null, auditRows: [], changeLog });
// what the bug wrote, with this player's canonical contract: a dry run of a stamp (AFTER = BEFORE, import_status 0, landed 1, dry_run 0)
const asMislabeledDryRun = (over) => ({ ...MISLABELED.find((r) => r.id === 1698), ...over });

test("PATH B: add event 52's real chain (1865 → 1875) still closes as 2, exactly as it did on 2026-09-27; the 27 rows beside it change nothing", () => {
  const ok = close([REAL[1865], REAL[1875]]);
  t.equal(ok.ok, true); t.equal(ok.path, "owner_conversion"); t.equal(ok.after.notes, FC.ADD_EVENT_SUPERSEDED_NOTE(1865, 1875, "/offer-mym", "Vet-MYM"));
  const withAll = close([...MISLABELED, REAL[1865], REAL[1875]]);
  t.deepEqual(withAll.after, ok.after); t.deepEqual(withAll.evidence, ok.evidence);
});

test("PATH B: a mislabeled dry run can no longer stand in for the STAMP (before the fix it closed the event)", () => {
  const fakeStamp = asMislabeledDryRun({ id: 1866, created_ts: REAL[1865].created_ts, player_id: "13113",
    before_salary: "1000", before_contract_status: "Vet-WW", before_contract_year: "1", before_contract_info: "CL 1| TCV 1K| AAV 1K",
    after_salary: "1000", after_contract_status: "Vet-WW", after_contract_year: "1", after_contract_info: "CL 1| TCV 1K| AAV 1K" });
  t.equal(fakeStamp.import_status, 0); t.equal(fakeStamp.landed, 1); t.equal(fakeStamp.dry_run, 0); t.equal(fakeStamp.notes, "import_ok_log_dispatched");
  const r = close([fakeStamp, REAL[1875]]);
  t.equal(r.ok, false); t.equal(r.result, "no_drop_of_this_acquisition");
  // the old filter (landed=1 AND dry_run≠1) WOULD have accepted it — proves this test sees the bug
  const oldFilter = (x) => Number(x.landed) === 1 && !(Number(x.dry_run) === 1);
  t.equal(oldFilter(fakeStamp), true);
});

test("PATH B: a mislabeled dry run can't stand in for the CONVERSION either (before = after, import_status 0)", () => {
  const fakeConv = asMislabeledDryRun({ id: 1874, created_ts: REAL[1875].created_ts, endpoint: "/offer-mym", player_id: "13113",
    before_salary: "1000", before_contract_status: "Vet-WW", before_contract_year: "1", before_contract_info: "CL 1| TCV 1K| AAV 1K",
    after_salary: "1000", after_contract_status: "Vet-MYM", after_contract_year: "3", after_contract_info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K" });
  t.equal(close([REAL[1865], fakeConv]).ok, false, "even with an MYM-looking AFTER, a row MFL never answered is not a conversion");
});

// ─────────────── 4. the two SQL reads, run on the exact rows (production schema) ───────────────
function dbWithRows() {
  const db = new DatabaseSync(":memory:");
  db.exec(FIX.schema);
  db.exec("CREATE TABLE ups_add_events (id INTEGER PRIMARY KEY, season TEXT, player_id TEXT, source TEXT, contract_annotated INTEGER)");
  const cols = Object.keys(FIX.rows[0]);
  const ins = db.prepare(`INSERT INTO salary_change_log (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of FIX.rows) ins.run(...cols.map((c) => r[c] == null ? null : r[c]));
  // worst case: EVERY player in the fixture has an open 2026 FCFS add event
  const pids = [...new Set(FIX.rows.map((r) => r.player_id))];
  pids.forEach((p, i) => db.prepare("INSERT INTO ups_add_events VALUES (?, '2026', ?, 'fcfs', 3)").run(i + 1, p));
  return { db, pids };
}
test("SQL: the backfill tool's changeLog2026 read returns ONLY the MFL-confirmed rows (1865, 1875) — none of the 27", () => {
  const { db } = dbWithRows();
  const got = db.prepare(QUERIES.changeLog2026).all().map((r) => r.id);
  t.deepEqual(got, [1865, 1875]);
  t.ok(/import_status/.test(QUERIES.changeLog2026) && /notes/.test(QUERIES.changeLog2026), "the rule's inputs are selected");
});
test("SQL: the worker route's path-B read returns ONLY MFL-confirmed rows, for every fixture player", () => {
  const { db, pids } = dbWithRows();
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const m = src.match(/(SELECT id, created_ts, player_id, endpoint, dry_run, landed, import_status, notes, [^`]*?FROM salary_change_log WHERE season = \? AND league_id = \? [^`]*?ORDER BY id)`/);
  t.ok(m, "the path-B SELECT was found in worker/src/index.js");
  const all = [];
  for (const p of pids) all.push(...db.prepare(m[1]).all("2026", "74598", p).map((r) => r.id));
  t.deepEqual(all.sort((a, b) => a - b), [1865, 1875]);
});

await run("contract_audit_dry_run");
restoreConsole();
