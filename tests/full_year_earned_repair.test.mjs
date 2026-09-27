// The "$1K Per Yr" earned clean-up, end to end: scripts/full_year_earned_repair.mjs → the REAL worker route → real SQLite.
//   node tests/full_year_earned_repair.test.mjs
//   1. the row-level dry run: every candidate is classified with a PROOF; FCFS-origin is separate from other $1K-per-year contracts; contracts captured
//      only because their TCV is under $5K are HELD, never written
//   2. apply is explicit, current-season-only, keyed; it sends only proven rows; ONE column changes; penalty / dead money / cap charge / every other column identical
//   3. the second run plans nothing and changes nothing; verification (incl. the unchanged-columns proof against the before-state) passes
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/fcfs_worker_harness.mjs";
const E = await import("../scripts/full_year_earned_repair.mjs");
const restore = quiet();
const TS = 1789916862;
const DDL = `
CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, league_id TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT, franchise_id TEXT NOT NULL, franchise_name TEXT,
  dropped_at_unix INTEGER NOT NULL, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER, pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER,
  pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER DEFAULT 0, earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER DEFAULT 0,
  penalty_exempt_reason TEXT, posted_to_mfl INTEGER DEFAULT 0, posted_amount INTEGER, applies_to_season INTEGER, discord_posted INTEGER DEFAULT 0, notes TEXT);
CREATE TABLE ups_add_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT, player_id TEXT, franchise_id TEXT, acquired_at_unix INTEGER, source TEXT);
CREATE TABLE ups_contract_gate_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, season TEXT, field TEXT NOT NULL, before_val TEXT, after_val TEXT, actor TEXT, note TEXT);
`;
const INS = "INSERT INTO ups_drop_events (season, league_id, player_id, player_name, franchise_id, franchise_name, dropped_at_unix, dropped_at_iso, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_length, pre_drop_contract_info, pre_drop_tcv, pre_drop_aav, pre_drop_years_remaining, pre_drop_taxi, earned_to_date, guaranteed_amount, penalty_amount, penalty_basis, penalty_exempt, penalty_exempt_reason, posted_to_mfl, posted_amount, applies_to_season, discord_posted, notes) VALUES ('2026','74598',?,?,?,'Team',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const ROWS = {
  A: { pid: "1", status: "Vet-WW", salary: 1000, cy: 1, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, aav: 1000, yrs: 1, earned: 118, basis: "ww_under_5k_exempt", exempt: 1 },                                             // one-year $1K WW (FCFS shape), weekly earned
  B: { pid: "2", status: "Vet-FAA", salary: 1000, cy: 1, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, aav: 1000, yrs: 1, earned: 0, basis: "one_year_under_5k_exempt", exempt: 1 },                                    // another $1K contract type, earned $0 stored
  C: { pid: "3", status: "Vet-FAA", salary: 1000, cy: 2, cl: 3, info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", tcv: 3000, aav: 1000, yrs: 2, earned: 1118, penalty: 1000, basis: "tcv_under_5k_flat", posted: 1, postedAmount: 1000 },   // $1,118, a real $1K penalty posted to MFL
  D: { pid: "4", status: "Vet-MYM", salary: 1000, cy: 1, cl: 2, info: "CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-1K| GTD: 1K", tcv: 2000, aav: 1000, yrs: 1, earned: 1118, basis: "tcv_under_5k_final_year_exempt", exempt: 1 },
  E: { pid: "5", status: "Vet-WW", salary: 4000, cy: 1, cl: 1, info: "CL 1| TCV 4K| AAV 4K", tcv: 4000, aav: 4000, yrs: 1, earned: 471, basis: "ww_under_5k_exempt", exempt: 1 },                                              // TCV under $5K, pays $4K: canon §C3 table says earned n/a for WW <= $4K — HELD for Keith
  F: { pid: "6", status: "Vet-FAA", salary: 2000, cy: 1, cl: 1, info: "CL 1| TCV 2K| AAV 2K", tcv: 2000, aav: 2000, yrs: 1, earned: 235, basis: "one_year_under_5k_exempt", exempt: 1 },                                  // captured only by TCV, no canon "n/a"
  G: { pid: "7", status: "Vet-FAA", salary: 2000, cy: 1, cl: 2, info: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", tcv: 4000, aav: 2000, yrs: 1, earned: 2000, basis: "tcv_under_5k_final_year_exempt", exempt: 1 },   // multi-year $2K a year
  H: { pid: "8", status: "Rookie-Draft", salary: 1000, cy: 2, cl: 3, info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", tcv: 3000, aav: 1000, yrs: 2, taxi: 1, earned: 2118, basis: "taxi_exempt", exempt: 1 },                 // $1K a year but TAXI: its earned is read by the D2a settlement
  I: { pid: "9", status: "Vet-WW", salary: 1000, cy: 1, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, aav: 1000, yrs: 1, earned: null, basis: "ww_under_5k_exempt", exempt: 1 },                                              // already NULL
  J: { pid: "10", status: "Vet-WW", salary: 25000, cy: 1, cl: 1, info: "CL 1| TCV 25K| AAV 25K", tcv: 25000, aav: 25000, yrs: 1, earned: 4000, penalty: 11000, basis: "guarantee_minus_earned" },                        // not sub-$5K at all
};
function world() {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  const db = env.UPS_MFL_DB.raw; db.exec(DDL);
  const ids = {};
  for (const [k, o0] of Object.entries(ROWS)) {
    const o = { taxi: 0, guaranteed: null, penalty: 0, exempt: 0, exemptReason: "", posted: 0, postedAmount: null, applies: 2027, discord: 1, notes: "n", ...o0 };
    ids[k] = Number(db.prepare(INS).run(o.pid, "Player " + o.pid, "0004", TS, new Date(TS * 1000).toISOString(), o.status, o.salary, o.cy, o.cl, o.info, o.tcv, o.aav, o.yrs, o.taxi, o.earned, o.guaranteed, o.penalty, o.basis, o.exempt, o.exemptReason, o.posted, o.postedAmount, o.applies, o.discord, o.notes).lastInsertRowid);
  }
  // production-shaped io: reads hit the SAME database the real worker route writes
  const posts = [];
  const io = {
    async d1(sql) { if (!/^\s*SELECT\b/i.test(sql)) throw new Error("write attempted through the read channel"); return db.prepare(sql).all(); },
    async mfl() { return { salaryAdjustments: { salaryAdjustment: [{ franchise_id: "0004", amount: "1000", description: "UPS drop penalty Player 3 1000 id:x" }] } }; },
    async post(p, body, key) { posts.push({ p, body, key }); const r = await callWorker(env, "POST", `${p}&APIKEY=${key}`, { body }); return { status: r.status, body: r.json }; },
  };
  return { env, db, ids, io, posts };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fye-"));
const snap = (db) => db.prepare("SELECT * FROM ups_drop_events ORDER BY id").all();
const A = (env) => ({ UPS_COMMISH_API_KEY: ADMIN_KEY, ...(env || {}) });
// an --apply is ALWAYS bound to a reviewed dry run: run the dry run, hand its plan.json to --apply (the same io, so the same before-state)
const bound = async (io, out, opts) => {
  const d = tmp(); const o = opts || {};
  await E.run(["--out", d, ...(o.args || [])], { io, log: () => {}, approved: o.approved });
  return E.run(["--apply", "--yes", "--season", "2026", "--plan", path.join(d, "plan.json"), "--out", out || tmp(), ...(o.args || [])], { io, log: () => {}, env: o.env || A(), approved: o.approved });
};

test("DRY RUN: every candidate row is classified with a proof; class members are the $1K-per-year contracts; TCV-under-$5K-only rows are HELD; nothing is written", async () => {
  const { db, ids, io, posts } = world(); const before = JSON.stringify(snap(db)), auditBefore = db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n;
  const out = await E.run(["--out", tmp()], { io, log: () => {} });
  t.equal(out.report.mode, "dry_run"); t.equal(posts.length, 0, "no POST of any kind"); t.equal(JSON.stringify(snap(db)), before, "D1 unchanged"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, auditBefore);
  t.equal(out.rows.length, 8, "candidates: TCV <= $4K with a stored earned (A–H; the NULL row and the $25K row are not candidates)");
  const by = (k) => out.rows.find((r) => r.drop_event_id === ids[k]);
  for (const k of ["A", "B", "C", "D"]) { t.equal(by(k).in_full_year_class, true, k); t.equal(by(k).action, "clear_full_year_earned", k); t.deepEqual(by(k).changes, ["earned_to_date"]); t.equal(by(k).earned_proposed, null); t.equal(by(k).class_proof.tcv_equals_1k_times_cl, true); }
  t.equal(by("A").class, "one_year_1k_ww"); t.equal(by("B").class, "other_1k_per_year"); t.equal(by("C").class, "other_1k_per_year"); t.deepEqual(by("C").class_proof.years, [1000, 1000, 1000]);
  for (const k of ["E", "F", "G"]) { t.equal(by(k).in_full_year_class, false, k); t.equal(by(k).action, k === "E" ? "hold_not_approved" : "hold_for_ruling", "E proves into the WW class but is not on the approved list"); t.equal(by(k).hold_reason, k === "E" ? "ww_row_not_on_the_approved_list" : "not_1k_per_year"); t.equal(by(k).captured_only_by_tcv_under_5k, true); t.equal(by(k).earned_proposed, by(k).earned_now, "held rows keep their earned"); t.equal(by(k).changes.length, 0); }
  t.equal(by("E").canon_earned_na_for_ww_under_4k, true, "canon §C3: WW under $4K, earned n/a — flagged for Keith"); t.equal(by("F").canon_earned_na_for_ww_under_4k, false);
  t.equal(by("E").class, "sub_5k_one_year_above_1k"); t.equal(by("G").class, "sub_5k_multi_year_above_1k");
  t.equal(by("H").action, "hold_for_ruling"); t.equal(by("H").hold_reason, "taxi_or_non_dedicated_penalty_basis", "a taxi row's earned is read by the D2a settlement — never touched here");
  t.deepEqual({ candidates: out.summary.candidates, cls: out.summary.in_full_year_class, held: out.summary.held_for_ruling, planned: out.summary.planned_actions, fcfs: out.summary.fcfs_origin_rows, tcvOnly: out.summary.captured_only_by_tcv_under_5k }, { candidates: 8, cls: 4, held: 4, planned: 4, fcfs: 0, tcvOnly: 3 });
  t.equal(by("C").penalty_amount, 1000); t.equal(by("C").dead_money, 1000); t.equal(by("C").cap_adjustment_posted, 1000); t.equal(by("C").mfl_adjustment_rows_matching, 1, "the posted cap charge is found in MFL's salary adjustments");
  t.match(fs.readFileSync(path.join(out.dir, "earned_rows_dryrun.csv"), "utf8"), /^drop_event_id,player_id,player_name/); t.ok(fs.existsSync(path.join(out.dir, "dataset_before_state", "drops.json")), "before-state exported");
});
test("FCFS ORIGIN is a separate fact from the contract shape: a row is FCFS-origin only when an FCFS add event precedes its drop", async () => {
  const { db, ids, io } = world();
  db.prepare("INSERT INTO ups_add_events (season, league_id, player_id, franchise_id, acquired_at_unix, source) VALUES ('2026','74598','1','0004',?, 'fcfs')").run(TS - 100);
  const out = await E.run(["--out", tmp()], { io, log: () => {} });
  t.equal(out.rows.find((r) => r.drop_event_id === ids.A).fcfs_origin, true); t.equal(out.rows.find((r) => r.drop_event_id === ids.B).fcfs_origin, false); t.equal(out.summary.fcfs_origin_rows, 1);
});
test("APPLY is explicit (--apply --yes --season, current season only, a key); it sends ONLY proven rows; ONE column changes; penalty / dead money / cap charge / every other column identical", async () => {
  for (const argv of [["--apply"], ["--apply", "--yes"], ["--apply", "--season", "2026"]]) { let e = null; try { await E.run([...argv, "--out", tmp()], { io: world().io, log: () => {}, env: A() }); } catch (x) { e = x; } t.ok(e && /--apply needs --yes and an explicit --season/.test(e.message), argv.join(" ")); }
  { let e = null; try { await E.run(["--apply", "--yes", "--season", "2025", "--out", tmp()], { io: world().io, log: () => {}, env: A() }); } catch (x) { e = x; } t.ok(e && /only permitted for the current season/.test(e.message)); }
  { let e = null; try { await E.run(["--apply", "--yes", "--season", "2026", "--out", tmp()], { io: world().io, log: () => {}, env: A() }); } catch (x) { e = x; } t.ok(e && /--apply needs --plan/.test(e.message), "an apply with no reviewed plan is refused BEFORE anything is read or sent"); }
  { const w0 = world(); const d0 = tmp(); await E.run(["--out", d0], { io: w0.io, log: () => {} }); let e = null; try { await E.run(["--apply", "--yes", "--season", "2026", "--plan", path.join(d0, "plan.json"), "--out", tmp()], { io: w0.io, log: () => {}, env: {} }); } catch (x) { e = x; } t.ok(e && /UPS_COMMISH_API_KEY/.test(e.message), "no key, no write"); t.equal(w0.posts.length, 0); }
  const { db, ids, io, posts } = world(); const before = snap(db);
  const out = await bound(io);
  t.deepEqual(out.report.applied.map((a) => `${a.id === ids.A ? "A" : a.id === ids.B ? "B" : a.id === ids.C ? "C" : "D"}:${a.result}`), ["A:applied", "B:applied", "C:applied", "D:applied"]);
  t.equal(posts.length, 1, "one batch, four proven rows"); t.deepEqual(posts[0].body.actions.map((a) => a.id), [ids.A, ids.B, ids.C, ids.D], "only class members are sent"); t.equal(posts[0].body.dry_run, false);
  const after = snap(db);
  for (const b of before) { const a = after.find((x) => x.id === b.id); const member = [ids.A, ids.B, ids.C, ids.D].includes(b.id);
    const changed = Object.keys(b).filter((k) => b[k] !== a[k]);
    if (member && b.earned_to_date !== null) t.deepEqual(changed, ["earned_to_date"], `row ${b.id}: exactly one column`); else t.deepEqual(changed, [], `row ${b.id}: untouched`); }
  t.equal(after.find((r) => r.id === ids.C).penalty_amount, 1000); t.equal(after.find((r) => r.id === ids.C).posted_amount, 1000); t.equal(after.find((r) => r.id === ids.E).earned_to_date, 471, "the held $4K WW row keeps its earned");
  t.equal(after.find((r) => r.id === ids.H).earned_to_date, 2118, "the taxi row keeps its earned"); t.equal(after.find((r) => r.id === ids.J).earned_to_date, 4000);
  t.equal(out.report.unchanged_proof.ok, true, JSON.stringify(out.report.unchanged_proof.violations)); t.equal(out.report.unchanged_proof.rows_compared, 10);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'full_year_clear_earned'").get().n, 4, "one audit row per applied change");
});
test("SERVER DRY RUN: the WORKER re-proves every planned row from its own stored data (dry_run:true) — all would_apply, nothing written, held rows never sent", async () => {
  const { db, ids, io, posts } = world(); const before = JSON.stringify(snap(db));
  const out = await E.run(["--server-dry-run", "--season", "2026", "--out", tmp()], { io, log: () => {}, env: A() });
  t.equal(out.report.mode, "server_dry_run"); t.deepEqual(out.report.server_dry_run_summary, { would_apply: 4 }); t.equal(posts.length, 1); t.equal(posts[0].body.dry_run, true);
  t.deepEqual(posts[0].body.actions.map((a) => a.id), [ids.A, ids.B, ids.C, ids.D]); t.equal(JSON.stringify(snap(db)), before, "nothing written"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
});
test("SECOND RUN: nothing is planned, nothing changes, nothing is posted; verification (with the unchanged-columns proof against the before-state) passes", async () => {
  const { db, io, posts } = world(); const dir = tmp();
  const first = await bound(io, dir);
  const afterFirst = JSON.stringify(snap(db)), postsFirst = posts.length, auditFirst = db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n;
  const second = await bound(io);
  t.deepEqual(second.plan, [], "zero planned actions"); t.equal(posts.length, postsFirst, "no request is even sent for an empty plan"); t.equal(JSON.stringify(snap(db)), afterFirst, "zero changes"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, auditFirst);
  const ver = await E.run(["--verify", "--against", path.join(first.dir, "dataset_before_state", "drops.json"), "--out", tmp()], { io, log: () => {} });
  t.equal(ver.report.verify.ok, true, JSON.stringify(ver.report)); t.equal(ver.report.verify.remaining_actions, 0); t.equal(ver.report.unchanged_proof.ok, true);
  const fresh = await E.run(["--verify", "--out", tmp()], { io: world().io, log: () => {} }); t.equal(fresh.report.verify.ok, false, "verification FAILS while rows remain"); t.equal(fresh.report.verify.remaining_actions, 4);
});
test("VERIFY --against: an earned value that changed on a row the dry run never planned is a VIOLATION; after the Al-Shaair reprice the proof still passes (only its 13 columns may differ)", async () => {
  const { db, ids, io } = world(); const dir = tmp();
  const first = await bound(io, dir);
  const beforeFile = path.join(first.dir, "dataset_before_state", "drops.json");
  // an unplanned row (the held $4K WW deal E) has its earned altered behind our back
  db.prepare("UPDATE ups_drop_events SET earned_to_date = 999 WHERE id = ?").run(ids.E);
  const bad = await E.run(["--verify", "--against", beforeFile, "--out", tmp()], { io, log: () => {} });
  t.equal(bad.report.verify.ok, false); t.ok(bad.report.unchanged_proof.violations.some((v) => v.id === ids.E && v.column === "earned_to_date"), JSON.stringify(bad.report.unchanged_proof.violations));
  db.prepare("UPDATE ups_drop_events SET earned_to_date = 471 WHERE id = ?").run(ids.E);
  // a row that was contract_unstamped_needs_review is repriced (the Al-Shaair step) AFTER the before-state was taken: exactly REPRICE_COLUMNS may differ
  db.prepare("UPDATE ups_drop_events SET penalty_basis = 'contract_unstamped_needs_review', pre_drop_contract_status = NULL, pre_drop_salary = NULL, pre_drop_contract_year = NULL, pre_drop_contract_length = NULL, pre_drop_contract_info = NULL, pre_drop_tcv = NULL, pre_drop_aav = NULL, pre_drop_years_remaining = NULL, earned_to_date = NULL, penalty_exempt = 0, penalty_exempt_reason = '', applies_to_season = 2027 WHERE id = ?").run(ids.J);
  const beforeFile2 = path.join(tmp(), "drops.json"); fs.writeFileSync(beforeFile2, JSON.stringify(snap(db)));
  db.prepare("UPDATE ups_drop_events SET penalty_basis = 'ww_under_5k_exempt', pre_drop_contract_status = 'Vet-WW', pre_drop_salary = 1000, pre_drop_contract_year = 1, pre_drop_contract_length = 1, pre_drop_contract_info = 'CL 1| TCV 1K| AAV 1K', pre_drop_tcv = 1000, pre_drop_aav = 1000, pre_drop_years_remaining = 1, penalty_exempt = 1, penalty_exempt_reason = 'x' WHERE id = ?").run(ids.J);
  const ok = await E.run(["--verify", "--against", beforeFile2, "--out", tmp()], { io, log: () => {} });
  t.equal(ok.report.unchanged_proof.ok, true, JSON.stringify(ok.report.unchanged_proof.violations));
  db.prepare("UPDATE ups_drop_events SET penalty_amount = 5 WHERE id = ?").run(ids.J);
  const leak = await E.run(["--verify", "--against", beforeFile2, "--out", tmp()], { io, log: () => {} });
  t.equal(leak.report.unchanged_proof.ok, false, "a changed penalty is never allowed, not even on a repriced row"); t.ok(leak.report.unchanged_proof.violations.some((v) => v.column === "penalty_amount"));
});
test("PROOF HARDENING: a dual AAV tier, an incomplete year schedule and a missing contract length are HELD — missing evidence never proves the class", async () => {
  const { db, io } = world();
  const ins = (pid, info, tcv, cl) => db.prepare(INS).run(pid, "Player " + pid, "0004", TS, new Date(TS * 1000).toISOString(), "Vet-FAA", 1000, 2, cl, info, tcv, 1000, 1, 0, 118, null, 0, "tcv_under_5k_final_year_exempt", 1, "", 0, null, 2027, 1, "n");
  ins("71", "CL 2| TCV 2K| AAV 1K, 2K| Y1-1K, Y2-1K", 2000, 2);            // a second AAV tier of $2K
  ins("72", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K", 3000, 3);                 // a schedule that names 2 of 3 years
  ins("73", "TCV 2K| AAV 1K", 2000, null);                                   // no contract length at all
  ins("74", "CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-1K", 2000, 2);                 // the control: a genuine member
  const an = E.buildAnalysis(await E.loadDataset(io));
  const by = (pid) => an.rows.find((r) => r.player_id === pid);
  t.equal(by("74").in_full_year_class, true, "control");
  for (const [pid, why] of [["71", "aav_not_1000"], ["72", "year_schedule_incomplete"], ["73", "no_contract_length"]]) { t.equal(by(pid).in_full_year_class, false, pid); t.ok(by(pid).class_proof.reasons.includes(why), pid + " " + JSON.stringify(by(pid).class_proof)); t.equal(by(pid).action, "hold_for_ruling"); }
});
test("REVIEWED PLAN ONLY: --apply --plan refuses when the plan drifted since it was reviewed; rollback.sql is the exact reverse; a partial apply or a failed proof is a non-success", async () => {
  const w = world(); const dir = tmp();
  const dry = await E.run(["--out", dir], { io: w.io, log: () => {} });
  const rb = fs.readFileSync(path.join(dir, "rollback.sql"), "utf8").trim().split("\n"); t.equal(rb.length, 4);
  t.match(rb[0], new RegExp(`^UPDATE ups_drop_events SET earned_to_date = 118 WHERE id = ${w.ids.A} AND earned_to_date IS NULL;$`));
  t.equal(dry.report.success, true);
  // the row changes between the review and the apply
  w.db.prepare("UPDATE ups_drop_events SET earned_to_date = 119 WHERE id = ?").run(w.ids.A);
  let e = null; try { await E.run(["--apply", "--yes", "--season", "2026", "--plan", path.join(dir, "plan.json"), "--out", tmp()], { io: w.io, log: () => {}, env: A() }); } catch (x) { e = x; }
  t.ok(e && /the plan changed since it was reviewed/.test(e.message), "drift refused"); t.equal(w.posts.length, 0, "nothing was sent");
  t.equal(w.db.prepare("SELECT earned_to_date e FROM ups_drop_events WHERE id = ?").get(w.ids.A).e, 119, "untouched");
  // an unchanged plan applies
  w.db.prepare("UPDATE ups_drop_events SET earned_to_date = 118 WHERE id = ?").run(w.ids.A);
  const ok = await E.run(["--apply", "--yes", "--season", "2026", "--plan", path.join(dir, "plan.json"), "--out", tmp()], { io: w.io, log: () => {}, env: A() });
  t.equal(ok.report.success, true); t.equal(ok.report.plan_bound_to, path.join(dir, "plan.json"));
  // …and a bound apply whose route answers "precondition_failed" for a row is reported as a NON-success (the process would exit 1)
  const w2 = world(); const io2 = { ...w2.io, async post(p, body, key) { const r = await w2.io.post(p, body, key); if (body.dry_run === false) { r.body.results[0].result = "precondition_failed"; } return r; } };
  const bad = await bound(io2); t.equal(bad.report.success, false);
  t.equal(E.planDrift([{ id: 1, expect: { earned_to_date: 5 } }], [{ id: 1, expect: { earned_to_date: 5 } }]).ok, true); t.equal(E.planDrift([{ id: 1, expect: { earned_to_date: 5 } }], [{ id: 1, expect: { earned_to_date: 6 } }]).ok, false);
});
test("OUTPUT DIRECTORY: a reused --out never silently reuses an old before-state dataset; applyPlan is DRY by default; the tools run through a symlink", async () => {
  const w = world(); const dir = tmp();
  await E.run(["--out", dir], { io: w.io, log: () => {} });
  let e = null; try { await E.run(["--out", dir], { io: w.io, log: () => {} }); } catch (x) { e = x; } t.ok(e && /already holds a before-state dataset/.test(e.message));
  const again = await E.run(["--offline", "--out", dir], { io: w.io, log: () => {} }); t.equal(again.rows.length, 8, "--offline deliberately reuses it");
  const before = w.posts.length; await E.applyPlan([{ kind: "clear_full_year_earned", id: w.ids.A, expect: { earned_to_date: 118 } }], w.io, { key: ADMIN_KEY });   // no dryRun argument
  t.equal(w.posts[before].body.dry_run, true, "default = dry");
  const link = path.join(tmp(), "repair.mjs"); fs.symlinkSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/full_year_earned_repair.mjs"), link);
  const r = spawnSync("node", [link, "--apply"], { encoding: "utf8" }); t.equal(r.status, 2, "a symlinked run RUNS (and refuses --apply without --yes/--season) instead of silently doing nothing"); t.match(r.stderr, /--apply needs --yes/);
});
test("the unchanged-columns proof catches a violation (a changed penalty, a changed cap charge)", () => {
  const before = [{ id: 1, earned_to_date: 118, penalty_amount: 0, posted_amount: null, notes: "a" }, { id: 2, earned_to_date: 5, penalty_amount: 1000, posted_amount: 1000 }];
  t.equal(E.unchangedProof(before, [{ id: 1, earned_to_date: null, penalty_amount: 0, posted_amount: null, notes: "a" }, { id: 2, earned_to_date: null, penalty_amount: 1000, posted_amount: 1000 }]).ok, true);
  const bad = E.unchangedProof(before, [{ id: 1, earned_to_date: null, penalty_amount: 0, posted_amount: null, notes: "a" }, { id: 2, earned_to_date: null, penalty_amount: 0, posted_amount: 1000 }]);
  t.equal(bad.ok, false); t.deepEqual(bad.violations.map((v) => `${v.id}:${v.column}`), ["2:penalty_amount"]); t.equal(E.unchangedProof(before, [before[0]]).ok, false, "a missing row is a violation");
});
test("the tool's read channel refuses anything but SELECT", async () => {
  const B = await import("../scripts/fcfs_contract_backfill.mjs"); const prod = B.productionIo({ base: "http://127.0.0.1:1" });
  for (const sql of ["UPDATE ups_drop_events SET earned_to_date = NULL", "SELECT 1; DELETE FROM ups_drop_events", "DELETE FROM ups_drop_events"]) { let e = null; try { await prod.d1(sql); } catch (x) { e = x; } t.match(String(e && e.message), /read-only/, sql); }
  for (const [name, sql] of Object.entries(E.QUERIES)) t.ok(Array.isArray(world().db.prepare(sql).all()), name + " runs over the production column names");
});

// ═════════════════════════════════════ the three approved repairs: class · legacy guarantee rows · WW earned n/a ═════════════════════════════════════
// (Keith 2026-09-26: 97 proven $1K/year rows by class proof; rows 32/33/40 by name under the canonical $1K/year rule; the six WW rows under canon §C3; the rest held)
const addRow = (db, o) => {
  o = { taxi: 0, guaranteed: null, penalty: 0, exempt: 0, exemptReason: "", posted: 0, postedAmount: null, applies: 2027, discord: 1, notes: "n", fid: "0004", ...o };
  return Number(db.prepare(INS).run(o.pid, "Player " + o.pid, o.fid, TS, new Date(TS * 1000).toISOString(), o.status, o.salary, o.cy, o.cl, o.info, o.tcv, o.aav, o.yrs, o.taxi, o.earned, o.guaranteed, o.penalty, o.basis, o.exempt, o.exemptReason, o.posted, o.postedAmount, o.applies, o.discord, o.notes).lastInsertRowid);
};
const WWROW = (pid, status, sal, earned, over) => ({ pid, status, salary: sal, cy: 1, cl: 1, info: `CL 1| TCV ${sal / 1000}K| AAV ${sal / 1000}K`, tcv: sal, aav: sal, yrs: 1, earned, basis: "ww_under_5k_exempt", exempt: 1, ...(over || {}) });
const LEGROW = (pid, over) => ({ pid, status: "Vet-MYM", salary: 1000, cy: 2, cl: 3, info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", tcv: 3000, aav: 1000, yrs: 2, earned: 1000, guaranteed: 2000, penalty: 1000, basis: "tcv_under_5k_guarantee", exempt: 0, ...(over || {}) });
function worldPlus() {
  const w = world();
  const ww = [addRow(w.db, WWROW("116", "Vet-WW", 2000, 235)), addRow(w.db, WWROW("117", "Vet-WW", 3000, 353)), addRow(w.db, WWROW("131", "Rookie-WW", 4000, 250)), addRow(w.db, WWROW("140", "Vet-WW", 4000, 500))];
  const leg = [addRow(w.db, LEGROW("32", { posted: 1, postedAmount: 1000 })), addRow(w.db, LEGROW("33")), addRow(w.db, LEGROW("40", { cl: 4, yrs: 3, cy: 3, info: "CL 4| TCV 4K| AAV 1K| Y1-1K, Y2-1K, Y3-1K, Y4-1K", tcv: 4000, guaranteed: 3000, earned: 2000 }))];
  const legHeld = addRow(w.db, LEGROW("34", { cy: 1, yrs: 1 }));                 // final year: canonical $0 ≠ stored $1,000 → HELD, earned kept
  const legNotApproved = addRow(w.db, LEGROW("35"));                              // provable but not on the approved list
  const wwNotApproved = addRow(w.db, WWROW("150", "Vet-WW", 2000, 235));          // provable WW class, not approved
  return { ...w, ww, leg, legHeld, legNotApproved, wwNotApproved, approved: { legacy_guarantee_ids: leg, ww_earned_na_ids: ww } };
}
test("APPROVALS: a proven WW / legacy row is planned ONLY when it is on Keith's approved list; a proven-but-unlisted row is HELD; an approved row that does not reconcile is HELD with earned kept", async () => {
  const w = worldPlus();
  const out = await E.run(["--out", tmp()], { io: w.io, log: () => {}, approved: w.approved });
  const by = (id) => out.rows.find((r) => r.drop_event_id === id);
  for (const id of w.ww) { t.equal(by(id).action, "clear_ww_earned_na"); t.equal(by(id).repair_kind, "clear_ww_earned_na"); t.deepEqual(by(id).changes, ["earned_to_date", "penalty_basis"]); t.equal(by(id).penalty_basis_proposed, "ww_under_5k_earned_na"); t.equal(by(id).approved, true); }
  for (const id of w.leg) { t.equal(by(id).action, "reconcile_legacy_guarantee_basis"); t.deepEqual(by(id).changes, ["earned_to_date", "penalty_basis"]); t.equal(by(id).penalty_basis_proposed, "full_year_1k_contract"); t.equal(by(id).computed_penalty, 1000); }
  t.equal(by(w.legNotApproved).action, "hold_not_approved"); t.equal(by(w.legNotApproved).hold_reason, "legacy_row_not_on_the_approved_list"); t.equal(by(w.legNotApproved).approved, false); t.equal(by(w.legNotApproved).earned_proposed, 1000);
  t.equal(by(w.wwNotApproved).action, "hold_not_approved"); t.equal(by(w.wwNotApproved).hold_reason, "ww_row_not_on_the_approved_list"); t.equal(by(w.wwNotApproved).changes.length, 0);
  t.equal(by(w.legHeld).action, "hold_conflict"); t.equal(by(w.legHeld).hold_reason, "financials_would_change"); t.match(by(w.legHeld).hold_detail, /stored penalty 1000 vs computed 0/); t.equal(by(w.legHeld).earned_proposed, 1000, "earned NOT cleared");
  const ap = out.summary.approvals;
  t.deepEqual(ap.ww_earned_na.planned_but_not_approved, []); t.deepEqual(ap.ww_earned_na.approved_but_not_planned, []); t.deepEqual(ap.legacy_guarantee.planned_but_not_approved, []); t.deepEqual(ap.legacy_guarantee.approved_but_not_planned, []);
  t.equal(out.summary.planned_by_kind.clear_ww_earned_na, 4); t.equal(out.summary.planned_by_kind.reconcile_legacy_guarantee_basis, 3); t.equal(out.summary.planned_by_kind.clear_full_year_earned, 4, "A–D by class proof");
  // an approval that names a row that does NOT prove is reported, never silently planned
  const off = await E.run(["--out", tmp()], { io: w.io, log: () => {}, approved: { legacy_guarantee_ids: [w.legHeld], ww_earned_na_ids: [w.ids.F] } });
  t.deepEqual(off.summary.approvals.legacy_guarantee.approved_but_not_planned, [w.legHeld]); t.deepEqual(off.summary.approvals.ww_earned_na.approved_but_not_planned, [w.ids.F], "an approved id the class does not prove is not planned");
  // with the PRODUCTION approvals baked in (ids 32/33/40 and 116/117/122/131/136/140), none of these test rows is planned
  const prod = await E.run(["--out", tmp()], { io: w.io, log: () => {} });
  t.equal(prod.summary.planned_by_kind.clear_ww_earned_na, undefined); t.equal(prod.summary.by_action.hold_not_approved >= 1, true);
  t.deepEqual({ legacy: [...E.APPROVED.legacy_guarantee_ids], ww: [...E.APPROVED.ww_earned_na_ids] }, { legacy: [32, 33, 40], ww: [116, 117, 122, 131, 136, 140] });
});
test("FINANCIAL RECONCILIATION: for every planned repair penalty, dead money and the posted cap effect are identical before and after, the stored penalty equals the canonical computation, and no MFL financial write is proposed", async () => {
  const w = worldPlus();
  const out = await E.run(["--out", tmp()], { io: w.io, log: () => {}, approved: w.approved });
  const fr = out.summary.financial_reconciliation;
  t.deepEqual({ ...fr }, { planned_rows: 11, penalty_unchanged: true, dead_money_unchanged: true, posted_cap_unchanged: true, protected_columns_identical: true, every_stored_penalty_equals_the_canonical_computation: true, planned_with_penalty_gt_0: 4, planned_posted_to_mfl: 2, mfl_financial_writes_proposed: 0 });
  for (const r of out.rows.filter((x) => x.repair_kind)) { t.equal(r.financials.mfl_financial_write_proposed, false); t.equal(r.financials.penalty_before, r.financials.penalty_after); t.equal(r.derivation.computed_penalty, Number(r.penalty_amount), `row ${r.drop_event_id}: canonical == stored`); }
  // fail closed: a class row whose stored penalty / posted charge the canonical rule would NOT reproduce is HELD, never planned
  const bad1 = addRow(w.db, { ...ROWS.C, pid: "81", penalty: 700, basis: "tcv_under_5k_flat", posted: 0 });                                // stored $700 vs canonical $1,000
  const bad2 = addRow(w.db, { ...ROWS.C, pid: "82", basis: "tcv_under_5k_flat", posted: 1, postedAmount: 500 });                           // posted as $500 vs canonical $1,000
  const bad3 = addRow(w.db, { ...ROWS.B, pid: "83", exempt: 0 });                                                                         // canonical is cap-free, stored not exempt
  const bad4 = addRow(w.db, { ...ROWS.A, pid: "84", yrs: null, cy: null });                                                                // years remaining unknown → cannot evaluate
  const out2 = await E.run(["--out", tmp()], { io: w.io, log: () => {}, approved: w.approved });
  for (const id of [bad1, bad2, bad3, bad4]) { const r = out2.rows.find((x) => x.drop_event_id === id); t.equal(r.action, "hold_conflict", "row " + id); t.equal(r.hold_reason, "financials_would_change"); t.equal(r.repair_kind, null); t.equal(r.earned_proposed, r.earned_now); }
  t.match(out2.rows.find((x) => x.drop_event_id === bad1).hold_detail, /stored penalty 700 vs computed 1000/); t.match(out2.rows.find((x) => x.drop_event_id === bad2).hold_detail, /posted to MFL as 500 vs computed 1000/);
  t.deepEqual(out2.plan.map((a) => a.id).filter((id) => [bad1, bad2, bad3, bad4].includes(id)), [], "held rows are never sent");
  // the WORKER route agrees, independently (it re-runs the same plan and refuses the same rows)
  const res = await w.io.post("/admin/drops/full-year-repair?L=74598&YEAR=2026", { season: "2026", league_id: "74598", dry_run: true, actions: [bad1, bad2, bad3, bad4].map((id) => ({ kind: "clear_full_year_earned", id })) }, ADMIN_KEY);
  t.deepEqual(res.body.results.map((r) => r.result), ["conflict_financials_would_change", "conflict_financials_would_change", "conflict_financials_would_change", "conflict_financials_would_change"]);
});
test("APPLY (three kinds): the worker writes exactly the planned columns for each kind, the whole-table unchanged proof passes, the second run changes nothing, and rollback.sql restores the before-state EXACTLY", async () => {
  const w = worldPlus(); const before = snap(w.db); const dir = tmp();
  const sd = await E.run(["--server-dry-run", "--season", "2026", "--out", tmp()], { io: w.io, log: () => {}, env: A(), approved: w.approved });
  t.deepEqual(sd.report.server_dry_run_summary, { would_apply: 11 }, "the worker re-proves all eleven"); t.equal(JSON.stringify(snap(w.db)), JSON.stringify(before), "a server dry run writes nothing");
  const out = await bound(w.io, dir, { approved: w.approved });
  t.deepEqual(out.report.applied.map((a) => a.result), Array(11).fill("applied")); t.equal(out.report.success, true, JSON.stringify(out.report.unchanged_proof.violations));
  t.equal(out.report.unchanged_proof.ok, true); t.equal(out.report.unchanged_proof.rows_compared, before.length);
  const after = snap(w.db);
  for (const b of before) { const a = after.find((x) => x.id === b.id); const changed = Object.keys(b).filter((k) => b[k] !== a[k]).sort();
    if (w.ww.includes(b.id)) t.deepEqual(changed, ["earned_to_date", "penalty_basis"], `WW row ${b.id}`);
    else if (w.leg.includes(b.id)) t.deepEqual(changed, ["earned_to_date", "penalty_basis"], `legacy row ${b.id}`);
    else if ([w.ids.A, w.ids.B, w.ids.C, w.ids.D].includes(b.id)) t.deepEqual(changed, ["earned_to_date"], `class row ${b.id}`);
    else t.deepEqual(changed, [], `row ${b.id} untouched`); }
  for (const id of w.ww) t.equal(after.find((r) => r.id === id).penalty_basis, "ww_under_5k_earned_na"); for (const id of w.leg) t.equal(after.find((r) => r.id === id).penalty_basis, "full_year_1k_contract");
  t.equal(after.find((r) => r.id === w.legHeld).earned_to_date, 1000, "the held legacy row keeps its earned"); t.equal(after.find((r) => r.id === w.legNotApproved).earned_to_date, 1000); t.equal(after.find((r) => r.id === w.wwNotApproved).earned_to_date, 235);
  for (const k of ["penalty_amount", "guaranteed_amount", "penalty_exempt", "posted_to_mfl", "posted_amount", "applies_to_season"]) for (const b of before) t.equal(after.find((x) => x.id === b.id)[k], b[k], `${k} of row ${b.id} identical`);
  // second run: zero planned, zero changes
  const snap1 = JSON.stringify(after), posts1 = w.posts.length;
  const again = await bound(w.io, undefined, { approved: w.approved });
  t.deepEqual(again.plan, []); t.equal(w.posts.length, posts1); t.equal(JSON.stringify(snap(w.db)), snap1, "second run: zero changes");
  // verify --against the before-state passes with the per-kind allowed columns…
  const ver = await E.run(["--verify", "--against", path.join(out.dir, "dataset_before_state", "drops.json"), "--out", tmp()], { io: w.io, log: () => {}, approved: w.approved });
  t.equal(ver.report.verify.ok, true, JSON.stringify(ver.report.unchanged_proof)); t.equal(ver.report.unchanged_proof.ok, true);
  // …rollback.sql (guarded on the AFTER state) restores every row byte-for-byte
  const rb = fs.readFileSync(path.join(dir, "rollback.sql"), "utf8"); t.equal(rb.trim().split("\n").length, 11); t.match(rb, /SET earned_to_date = 235, penalty_basis = 'ww_under_5k_exempt' WHERE id = \d+ AND earned_to_date IS NULL AND penalty_basis = 'ww_under_5k_earned_na';/);
  t.match(rb, /SET earned_to_date = 1000, penalty_basis = 'tcv_under_5k_guarantee' WHERE id = \d+ AND earned_to_date IS NULL AND penalty_basis = 'full_year_1k_contract';/);
  w.db.exec(rb); t.equal(JSON.stringify(snap(w.db)), JSON.stringify(before), "rollback restores the before-state exactly");
  w.db.exec(rb); t.equal(JSON.stringify(snap(w.db)), JSON.stringify(before), "a second rollback is a no-op (guarded on the after state)");
});
test("unchangedProof (per-kind): a planned row may change ONLY its repair's columns and must end on them; the basis of an UNPLANNED row, or a wrong end value, is a violation", () => {
  const before = [{ id: 1, earned_to_date: 235, penalty_basis: "ww_under_5k_exempt", penalty_amount: 0 }, { id: 2, earned_to_date: 1000, penalty_basis: "tcv_under_5k_guarantee", penalty_amount: 1000 }, { id: 3, earned_to_date: 5, penalty_basis: "x", penalty_amount: 0 }];
  const good = [{ id: 1, earned_to_date: null, penalty_basis: "ww_under_5k_earned_na", penalty_amount: 0 }, { id: 2, earned_to_date: null, penalty_basis: "full_year_1k_contract", penalty_amount: 1000 }, { id: 3, earned_to_date: 5, penalty_basis: "x", penalty_amount: 0 }];
  const pa = { 1: { earned_to_date: null, penalty_basis: "ww_under_5k_earned_na" }, 2: { earned_to_date: null, penalty_basis: "full_year_1k_contract" } };
  t.equal(E.unchangedProof(before, good, { plannedIds: [1, 2], plannedAfter: pa }).ok, true);
  const wrongBasis = good.map((r) => (r.id === 1 ? { ...r, penalty_basis: "something_else" } : r)); t.deepEqual(E.unchangedProof(before, wrongBasis, { plannedIds: [1, 2], plannedAfter: pa }).violations.map((v) => `${v.id}:${v.column}`), ["1:penalty_basis"], "a planned row must end on the planned basis");
  const unplannedBasis = good.map((r) => (r.id === 3 ? { ...r, penalty_basis: "y" } : r)); t.deepEqual(E.unchangedProof(before, unplannedBasis, { plannedIds: [1, 2], plannedAfter: pa }).violations.map((v) => `${v.id}:${v.column}`), ["3:penalty_basis"]);
  const moved = good.map((r) => (r.id === 2 ? { ...r, penalty_amount: 0 } : r)); t.deepEqual(E.unchangedProof(before, moved, { plannedIds: [1, 2], plannedAfter: pa }).violations.map((v) => `${v.id}:${v.column}`), ["2:penalty_amount"], "a legacy row's dead money may never move");
  t.equal(E.unchangedProof(before, good, { plannedIds: [1, 2] }).ok, false, "without plannedAfter only earned may change — a basis change is not silently allowed");
});

test("REVIEW FIXES (tool): the plan is bound to KIND and AFTER-state too; a class row is a candidate whatever its stored pre_drop_tcv; the reviewer can EXCLUDE a row; NULL evidence is held; one mode at a time", async () => {
  // planDrift: a change of kind or of the after-state between the reviewed plan and the fresh plan is drift
  const a = { id: 1, kind: "clear_full_year_earned", expect: { earned_to_date: 5 }, after: { earned_to_date: null } };
  t.equal(E.planDrift([a], [a]).ok, true); t.equal(E.planDrift([{ ...a, kind: "clear_ww_earned_na" }], [a]).ok, false, "a different KIND is not the reviewed action");
  t.equal(E.planDrift([{ ...a, after: { earned_to_date: null, penalty_basis: "ww_under_5k_earned_na" } }], [a]).ok, false, "a different AFTER-state is not the reviewed action");
  // the candidate universe: a row whose contract TEXT proves the class is a candidate even when pre_drop_tcv is 0 / NULL / above $4K — never invisible
  { const w = world(); const mk = (pid, tcv) => addRow(w.db, { ...ROWS.A, pid, tcv, earned: 118 });
    const ids0 = [mk("501", 0), mk("502", null), mk("503", 9999)];
    const out = await E.run(["--out", tmp()], { io: w.io, log: () => {} });
    for (const id of ids0) { const r = out.rows.find((x) => x.drop_event_id === id); t.ok(r, "row " + id + " is a candidate"); t.equal(r.action, "clear_full_year_earned", "planned: the route re-proves it from the contract text"); }
    const ver = await E.run(["--verify", "--out", tmp()], { io: w.io, log: () => {} }); t.equal(ver.report.verify.ok, false, "verification is NOT vacuously green while such a row remains"); }
  // --exclude: the reviewer keeps a row out; it is held, never planned, never sent
  { const w = world(); const out = await E.run(["--out", tmp(), "--exclude", String(w.ids.A) + "," + String(w.ids.B)], { io: w.io, log: () => {} });
    for (const k of ["A", "B"]) { const r = out.rows.find((x) => x.drop_event_id === w.ids[k]); t.equal(r.action, "hold_excluded"); t.equal(r.hold_reason, "excluded_by_reviewer"); t.equal(r.repair_kind, null); t.equal(r.earned_proposed, r.earned_now); }
    t.deepEqual(out.plan.map((p) => p.id), [w.ids.C, w.ids.D], "only the rest is planned"); t.equal(out.summary.by_action.hold_excluded, 2);
    const ap = await bound(w.io, undefined, { args: ["--exclude", String(w.ids.A) + "," + String(w.ids.B)] }); t.deepEqual(ap.report.applied.map((x) => x.id), [w.ids.C, w.ids.D]); t.equal(w.db.prepare("SELECT earned_to_date e FROM ups_drop_events WHERE id = ?").get(w.ids.A).e, 118, "excluded row untouched"); }
  // NULL / unknown evidence is HELD by the plan (never $0, never 'final year')
  { const w = world(); const nullPen = addRow(w.db, { ...ROWS.A, pid: "511", earned: 118 }); w.db.prepare("UPDATE ups_drop_events SET penalty_amount = NULL WHERE id = ?").run(nullPen);
    const zeroYrs = addRow(w.db, { ...ROWS.A, pid: "512", earned: 118, yrs: 0, cy: 0 }); const nullTaxi = addRow(w.db, { ...ROWS.A, pid: "513", earned: 118 }); w.db.prepare("UPDATE ups_drop_events SET pre_drop_taxi = NULL WHERE id = ?").run(nullTaxi);
    const out = await E.run(["--out", tmp()], { io: w.io, log: () => {} });
    for (const id of [nullPen, zeroYrs, nullTaxi]) { const r = out.rows.find((x) => x.drop_event_id === id); t.equal(r.action, "hold_conflict", "row " + id); t.equal(r.repair_kind, null); t.equal(r.earned_proposed, r.earned_now); }
    t.match(out.rows.find((x) => x.drop_event_id === nullPen).hold_detail, /penalty_amount is not stored/); t.match(out.rows.find((x) => x.drop_event_id === nullTaxi).hold_detail, /pre_drop_taxi is not stored/); t.match(out.rows.find((x) => x.drop_event_id === zeroYrs).hold_detail, /years remaining is not stored/); }
  // the financial reconciliation is read from the SIMULATED after-state
  { const w = world(); const out = await E.run(["--out", tmp()], { io: w.io, log: () => {} }); const r = out.rows.find((x) => x.drop_event_id === w.ids.C);
    t.equal(r.financials.penalty_before, 1000); t.equal(r.financials.penalty_after, 1000); t.deepEqual(r.financials.posted_cap_before, r.financials.posted_cap_after); t.equal(r.financials.stored_penalty_equals_canonical, true); t.equal(out.summary.financial_reconciliation.protected_columns_identical, true); }
  // one mode at a time (a combined flag set used to write report.json with a mode that never ran)
  for (const argv of [["--apply", "--server-dry-run"], ["--verify", "--apply"], ["--server-dry-run", "--verify"]]) { let e = null; try { await E.run([...argv, "--yes", "--season", "2026", "--out", tmp()], { io: world().io, log: () => {}, env: A() }); } catch (x) { e = x; } t.ok(e && /choose ONE mode/.test(e.message), argv.join(" ")); }
});

restore();
await run("full_year_earned_repair");
