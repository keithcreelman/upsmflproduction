// FCFS CONTRACTS (PR A — worker + tooling) — a completed FCFS acquisition is never a blank contract (canon §A5: $1,000 · one-year · Vet-WW · CL 1 · TCV 1K · AAV 1K).
//   node tests/fcfs_contract.test.mjs
//
//   1. the rule (worker/src/fcfs_contract.js): the canonical contract, classification, the stamp decision, verification
//   2. the REAL worker stamper (/admin/adds/stamp-ww-contracts) on real SQLite, MFL stubbed at the network edge:
//      no-bid FCFS · failed write · failed verification · retry · duplicate retry · missing player/franchise · protected contracts
//   3. the dedicated sub-$5K "full-year" drop rule (no weekly / cumulative earned) — calculator, actual drop charge, cap parity
//   4. /admin/drops/full-year-repair (the ONE audited repair path): the $1K-per-year class proof, dry-run default, preconditions, penalty/dead-money/cap unchanged, idempotence
//   5. the backfill TOOL (scripts/fcfs_contract_backfill.mjs) against a SQLite copy of the production tables: inventory buckets, dry run writes
//      nothing, apply touches only intended records, second apply is a no-op, replacement/reacquired protection
//   6. the Discord poster — a NULL earned never prints a fake amount
//   Client rendering (Front Office · roster workbench · mobile · cap_math · Team Operations · the player profile) is PR B's
//   tests/fcfs_contract_display.test.mjs — this file ships worker-only, before any client display code lands.
//   (isolated hotfix branch: runs on a plain origin/main checkout — no Trade War Room code, fixtures or migrations)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/fcfs_worker_harness.mjs";
const FC = await import("../worker/src/fcfs_contract.js");
const TOOL_RAW = await import("../scripts/fcfs_contract_backfill.mjs");
const NOW = () => TS + 3 * 86400;      // "now" for every tool run: three days after the fixture's 2026 pickups (inside the cron's 7-day look-back)
const TOOL = { ...TOOL_RAW, run: (argv, opts) => TOOL_RAW.run(argv, { now: NOW(), ...(opts || {}) }), buildInventory: (ds, f, o) => TOOL_RAW.buildInventory(ds, f || {}, { now: NOW(), ...(o || {}) }) };

const restore = quiet();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const CANON = { salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K" };

// ═════════════════════════════════════ 1. the rule ═════════════════════════════════════
test("RULE: the canonical FCFS contract is $1,000 · one-year · Vet-WW (Rookie-WW for an NFL rookie) · CL 1| TCV 1K| AAV 1K — no bid involved", () => {
  t.deepEqual(FC.canonicalFcfsContract({}), CANON);
  t.deepEqual(FC.canonicalFcfsContract({ rookie: true }), { ...CANON, contractStatus: "Rookie-WW" });
  t.equal(FC.FCFS_SALARY, 1000);
});
test("RULE: every state a contract row can be in is classified — blank, zero, salary-only (MFL's award state), missing, correct, non-canonical", () => {
  const c = (row, season) => FC.classifyFcfsContract(row, { season });
  t.equal(c(null).state, "missing_row");
  t.equal(c({ salary: "", contractStatus: "", contractYear: "", contractInfo: "" }).state, "blank", "the Sep-20 defect");
  t.equal(c({ salary: "0", contractStatus: "", contractYear: "0", contractInfo: "" }).state, "zero");
  t.equal(c({ salary: "1000", contractStatus: "", contractYear: "", contractInfo: "" }).state, "award_salary_only");
  t.equal(c(CANON).state, "correct");
  t.equal(c({ ...CANON, contractStatus: "Rookie-WW" }).state, "correct");
  t.equal(c({ ...CANON, salary: "2000" }).state, "non_canonical");
  t.equal(c({ ...CANON, contractYear: "2" }).state, "non_canonical");
  t.equal(c({ ...CANON, contractInfo: "CL 1| TCV 2K| AAV 2K" }).state, "non_canonical");
  t.equal(c({ ...CANON, contractStatus: "Vet-MYM" }).state, "non_canonical");
  // before the 2026 token era the contract carried a blank info string and the bare status WW
  t.equal(c({ salary: "1000", contractStatus: "WW", contractYear: "1", contractInfo: "" }, 2023).state, "correct");
  t.equal(c({ salary: "1000", contractStatus: "WW", contractYear: "1", contractInfo: "" }, 2026).state, "non_canonical");
});
test("RULE: the stamp decision — a no-bid FCFS add is stamped by rule; a disagreement or a different holder is a human's call and writes nothing", () => {
  const award = { source: "fcfs", fid: "0004", ts: 1789916862, bid: null };
  const blank = { salary: "", contractStatus: "", contractYear: "", contractInfo: "" };
  let p = FC.planFcfsStamp({ award, holderFid: "0004", current: blank, rostered: true, rookie: false });
  t.equal(p.ok, true); t.deepEqual(p.write, CANON, "no bid, no negotiation: the canonical contract");
  p = FC.planFcfsStamp({ award, holderFid: "0004", current: blank, rostered: true, rookie: true }); t.equal(p.write.contractStatus, "Rookie-WW");
  p = FC.planFcfsStamp({ award, holderFid: "0004", current: { ...blank, salary: "1000" }, rostered: true }); t.deepEqual(p.write, CANON, "MFL set only the salary");
  p = FC.planFcfsStamp({ award, holderFid: "0004", current: { ...blank, salary: "5000" }, rostered: true });
  t.equal(p.ok, false); t.equal(p.outcome, "fcfs_contract_needs_review"); t.equal(p.reason, "fcfs_salary_not_canonical"); t.equal(p.write, undefined);
  p = FC.planFcfsStamp({ award, holderFid: "0009", current: blank, rostered: true });
  t.equal(p.ok, false); t.equal(p.reason, "award_franchise_differs_from_current_roster");
  p = FC.planFcfsStamp({ award, holderFid: "0004", current: { ...CANON, contractStatus: "Vet-MYM", contractYear: "2" }, rostered: true });
  t.equal(p.ok, false); t.equal(p.reason, "described_contract_not_canonical", "a described contract is never overwritten");
  p = FC.planFcfsStamp({ award, holderFid: "0004", current: CANON, rostered: true }); t.equal(p.write, null); t.equal(p.skip, "already_canonical");
  p = FC.planFcfsStamp({ award, holderFid: "", current: blank, rostered: false }); t.equal(p.write, null); t.equal(p.skip, "dropped_before_stamp", "MFL keeps no contract for a free agent; never a ghost stamp");
  p = FC.planFcfsStamp({ award: { ...award, fid: "" }, holderFid: "0004", current: blank, rostered: true }); t.equal(p.reason, "franchise_unresolved", "missing franchise");
  p = FC.planFcfsStamp({ award: { source: "bbid", fid: "0004" }, holderFid: "0004", current: blank, rostered: true }); t.equal(p.reason, "not_an_fcfs_award");
});
test("RULE: verification is by RE-READ — the exact four attributes, or the outcome is retryable (never 'verified')", () => {
  t.deepEqual(FC.verifyFcfsWrite(CANON, CANON), { ok: true, outcome: "fcfs_contract_verified", after: CANON });
  for (const bad of [{ ...CANON, salary: "" }, { ...CANON, contractStatus: "" }, { ...CANON, contractYear: "" }, { ...CANON, contractInfo: "CL 1|" }, null]) {
    const v = FC.verifyFcfsWrite(bad, CANON); t.equal(v.ok, false); t.equal(v.outcome, "fcfs_contract_retryable");
  }
  t.deepEqual(Object.values(FC.FCFS_OUTCOME).sort(), ["fcfs_contract_needs_review", "fcfs_contract_retryable", "fcfs_contract_verified"]);
});

// ═════════════════════════════════════ 2. the worker stamper ═════════════════════════════════════
const DDL = `
CREATE TABLE IF NOT EXISTS ups_add_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, league_id TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT, position TEXT, nfl_team TEXT,
  franchise_id TEXT NOT NULL, franchise_name TEXT, acquired_at_unix INTEGER NOT NULL, acquired_at_iso TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('bbid','fcfs')), bid_dollars INTEGER, acquisition_week INTEGER,
  contract_annotated INTEGER NOT NULL DEFAULT 0, annotated_at_utc TEXT, pre_annotate_contract_info TEXT, discord_posted INTEGER NOT NULL DEFAULT 0, discord_channel_id TEXT, discord_message_id TEXT,
  raw_transaction_json TEXT, detected_at_utc TEXT NOT NULL, notes TEXT, discord_parent_message_id TEXT, UNIQUE (season, league_id, player_id, franchise_id, acquired_at_unix));
CREATE TABLE IF NOT EXISTS ups_auction_contract_finalizations (player_id TEXT NOT NULL, season TEXT NOT NULL, league_id TEXT NOT NULL, winner_fid TEXT, source TEXT NOT NULL, won_bid_k INTEGER, salary INTEGER,
  contract_year TEXT, contract_status TEXT, contract_info TEXT, finalized_at_unix INTEGER, PRIMARY KEY (player_id, season, league_id, source));
CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, league_id TEXT NOT NULL, player_id TEXT NOT NULL, player_name TEXT, franchise_id TEXT NOT NULL, franchise_name TEXT,
  dropped_at_unix INTEGER NOT NULL, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER, pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER,
  pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER DEFAULT 0, earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER DEFAULT 0,
  penalty_exempt_reason TEXT, posted_to_mfl INTEGER DEFAULT 0, posted_amount INTEGER, applies_to_season INTEGER, discord_posted INTEGER DEFAULT 0, notes TEXT);
CREATE TABLE IF NOT EXISTS ups_contract_gate_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, season TEXT, field TEXT NOT NULL, before_val TEXT, after_val TEXT, actor TEXT, note TEXT);
`;
const TS = 1789916862;                 // 2026-09-20T15:07:42Z — the Franklin pickup
function fcfsWorld(over) {
  const env = makeWorkerEnv({ WW_CONTRACT_STAMP_ENABLED: "1", ...(over || {}) });
  env.UPS_MFL_DB.raw.exec(DDL);
  const mfl = makeMfl(); mfl.install();
  return { env, mfl, db: env.UPS_MFL_DB.raw };
}
function pickup(mfl, o) {
  o = { pid: "16619", fid: "0004", salary: "", status: "", year: "", info: "", rostered: true, salariesRow: true, tx: true, txFid: null, ...(o || {}) };
  mfl.st.rosters = o.rostered ? { [o.fid]: [{ id: o.pid, salary: o.salary === "" ? null : Number(o.salary) }] } : { [o.fid]: [] };
  mfl.st.salaries = o.salariesRow ? [{ id: o.pid, salary: o.salary, contractStatus: o.status, contractYear: o.year, contractInfo: o.info }] : [];
  mfl.st.transactions = o.tx ? [{ type: "FREE_AGENT", franchise: o.txFid == null ? o.fid : o.txFid, timestamp: String(TS), transaction: `${o.pid},|16639,` }] : [];
}
const seedAddEvent = (db, pid = "16619", fid = "0004", note = "fresh read had no salary/contractYear — refused to annotate (would write a $0 contract)") =>
  db.prepare("INSERT INTO ups_add_events (season, league_id, player_id, player_name, franchise_id, acquired_at_unix, acquired_at_iso, source, contract_annotated, detected_at_utc, notes) VALUES ('2026','74598',?,?,?,?,?, 'fcfs', 3, ?, ?)")
    .run(pid, "Test Player", fid, TS, new Date(TS * 1000).toISOString(), new Date().toISOString(), note);
const stamp = (env, body) => callWorker(env, "POST", `/admin/adds/stamp-ww-contracts?L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", days: 30, ...(body || {}) } });
const salRow = (mfl, pid = "16619") => { const r = mfl.st.salaries.find((x) => x.id === pid) || {}; return { salary: String(r.salary || ""), contractStatus: String(r.contractStatus || ""), contractYear: String(r.contractYear || ""), contractInfo: String(r.contractInfo || "") }; };

test("STAMPER: a new no-bid FCFS acquisition — dry run writes nothing; the real run writes the canonical contract, verifies it by re-read, records the audit and closes the add event", async () => {
  const { env, mfl, db } = fcfsWorld(); pickup(mfl); seedAddEvent(db);
  const dry = await stamp(env, { dry_run: true });
  t.equal(dry.status, 200); t.equal(dry.json.count, 1);
  t.equal(dry.json.rows[0].bid_dollars, 1000, "FCFS is priced by canon §A5, not by a bid"); t.equal(dry.json.rows[0].rule, "fcfs_canon_a5"); t.equal(dry.json.rows[0].source, "fcfs");
  t.equal(dry.json.fcfs_rule, FC.FCFS_RULE_VERSION, "the deployment discriminator is on every stamper response"); t.equal(FC.FCFS_RULE_VERSION, "canon_a5_2026-09-26");
  t.equal(mfl.writes("salaries").length, 0, "dry run: no import"); t.deepEqual(salRow(mfl), { salary: "", contractStatus: "", contractYear: "", contractInfo: "" }, "dry run: MFL untouched");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 0, "dry run: no ledger row");
  const r = await stamp(env);
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(r.json.verified_count, 1);
  t.deepEqual(r.json.fcfs_outcomes, [{ player_id: "16619", franchise_id: "0004", outcome: "fcfs_contract_verified", verified: true }]);
  t.deepEqual(salRow(mfl), CANON, "MFL now holds exactly the canonical contract");
  t.equal(mfl.writes("salaries").length, 1, "one import — the normal salary-import path (APPEND=1)"); t.equal(mfl.writes("salaries")[0].fields.APPEND, "1");
  const led = db.prepare("SELECT * FROM ups_auction_contract_finalizations").all();
  t.equal(led.length, 1); t.equal(led[0].source, "fcfs", "audited under the FCFS source, not the waiver one"); t.equal(led[0].salary, 1000); t.equal(led[0].contract_status, "Vet-WW"); t.equal(led[0].contract_info, "CL 1| TCV 1K| AAV 1K"); t.equal(led[0].winner_fid, "0004");
  const ev = db.prepare("SELECT contract_annotated, notes FROM ups_add_events").get();
  t.equal(ev.contract_annotated, 1, "complete only AFTER verification"); t.match(ev.notes, /fcfs_contract_verified/);
  // DUPLICATE RETRY: nothing is blank any more → nothing is written, nothing is duplicated
  const again = await stamp(env);
  t.equal(again.status, 200); t.equal(again.json.count, 0); t.equal(mfl.writes("salaries").length, 1, "no second import");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 1, "no duplicate ledger record");
});
test("STAMPER (reconcile): a refused / open FCFS add event is closed ONLY when MFL already holds exactly the canonical contract for the acquiring franchise — nothing is written to MFL, and anything else stays open", async () => {
  { const { env, mfl, db } = fcfsWorld(); pickup(mfl, { salary: "1000", status: "Vet-WW", year: "1", info: "CL 1| TCV 1K| AAV 1K" }); seedAddEvent(db);
    const r = await stamp(env); t.equal(r.status, 200); t.equal(r.json.fcfs_reconciled, 1, "closed with the contract we can SEE");
    t.equal(mfl.writes("salaries").length, 0, "reconcile never writes to MFL"); const ev = db.prepare("SELECT contract_annotated, notes FROM ups_add_events").get(); t.equal(ev.contract_annotated, 1); t.match(ev.notes, /fcfs_contract_verified/);
    t.equal((await stamp(env)).json.fcfs_reconciled, 0, "a closed event is not re-touched"); }
  { const { env, mfl, db } = fcfsWorld(); pickup(mfl, { salary: "2000", status: "Vet-WW", year: "1", info: "CL 1| TCV 2K| AAV 2K" }); seedAddEvent(db);
    const r = await stamp(env); t.equal(r.json.fcfs_reconciled, 0, "a contract that is not exactly canonical never closes the event"); t.equal(db.prepare("SELECT contract_annotated n FROM ups_add_events").get().n, 3); t.equal(mfl.writes("salaries").length, 0); }
  { const { env, mfl, db } = fcfsWorld(); pickup(mfl, { fid: "0009", salary: "1000", status: "Vet-WW", year: "1", info: "CL 1| TCV 1K| AAV 1K" }); seedAddEvent(db, "16619", "0004");
    const r = await stamp(env); t.equal(r.json.fcfs_reconciled, 0, "a different holder is not the acquirer"); t.equal(db.prepare("SELECT contract_annotated n FROM ups_add_events").get().n, 3); }
  { const { env, mfl, db } = fcfsWorld(); pickup(mfl, { salary: "1000", status: "Vet-WW", year: "1", info: "CL 1| TCV 1K| AAV 1K" }); seedAddEvent(db);
    const r = await stamp(env, { dry_run: true }); t.equal(r.json.fcfs_reconciled ?? 0, 0, "a dry run reconciles nothing"); t.equal(db.prepare("SELECT contract_annotated n FROM ups_add_events").get().n, 3); }
});
test("STAMPER: MFL's award state (salary set, everything else blank) is completed; a salary that is NOT $1,000 is a needs-review row — never silently 'fixed'", async () => {
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { salary: "1000" }); const r = await stamp(env); t.equal(r.json.verified_count, 1); t.deepEqual(salRow(mfl), CANON); }
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { salary: "5000" }); const r = await stamp(env);
    t.equal(mfl.writes("salaries").length, 0, "nothing written"); t.equal(r.json.needs_input[0].reason, "fcfs_salary_not_canonical");
    t.equal(r.json.needs_input[0].outcome, "fcfs_contract_needs_review"); t.equal(r.json.fcfs_outcomes[0].outcome, "fcfs_contract_needs_review"); }
});
test("STAMPER: a FAILED MFL write is retryable (nothing recorded); the retry succeeds; a duplicate retry is a no-op", async () => {
  const { env, mfl, db } = fcfsWorld(); pickup(mfl); seedAddEvent(db);
  mfl.st.failNext = { type: "salaries", status: 500 };
  const bad = await stamp(env);
  t.equal(bad.status, 502); t.deepEqual(bad.json.fcfs_outcomes, [{ player_id: "16619", franchise_id: "0004", outcome: "fcfs_contract_retryable", verified: false }]);
  t.deepEqual(salRow(mfl), { salary: "", contractStatus: "", contractYear: "", contractInfo: "" }, "MFL still blank");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 0, "no audit row for a write that did not land");
  t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events").get().c, 3, "the add event is NOT marked complete");
  const ok = await stamp(env);
  t.equal(ok.json.fcfs_outcomes[0].outcome, "fcfs_contract_verified"); t.deepEqual(salRow(mfl), CANON);
  const dup = await stamp(env); t.equal(dup.json.count, 0);
  t.equal(mfl.writes("salaries").length, 2, "exactly the failed attempt + the successful one"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 1);
});
test("STAMPER: a write MFL ACCEPTED BUT NEVER APPLIED fails verification — retryable, no audit row, add event not closed; the next tick lands it", async () => {
  const { env, mfl, db } = fcfsWorld(); pickup(mfl); seedAddEvent(db);
  mfl.st.salariesImportIgnored = true;
  const r = await stamp(env);
  t.equal(r.status, 200); t.equal(r.json.verified_count, 0); t.equal(r.json.fcfs_outcomes[0].outcome, "fcfs_contract_retryable"); t.equal(r.json.fcfs_outcomes[0].verified, false);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_auction_contract_finalizations").get().n, 0); t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events").get().c, 3);
  mfl.st.salariesImportIgnored = false;
  const r2 = await stamp(env); t.equal(r2.json.fcfs_outcomes[0].outcome, "fcfs_contract_verified"); t.deepEqual(salRow(mfl), CANON);
});
test("STAMPER: what it must NOT write — a missing salaries row, a released player, a different holder, a described contract, a missing franchise", async () => {
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { salariesRow: false }); const r = await stamp(env); t.equal(r.json.count, 0); t.equal(mfl.writes("salaries").length, 0, "no salaries row: not ours to invent one"); }
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { rostered: false }); const r = await stamp(env); t.equal(r.json.count, 0); t.equal(mfl.writes("salaries").length, 0, "released before the stamp: never a ghost stamp"); }
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { txFid: "0009" }); const r = await stamp(env);
    t.equal(mfl.writes("salaries").length, 0); t.equal(r.json.needs_input[0].reason, "award_franchise_differs_from_current_roster"); t.equal(r.json.needs_input[0].outcome, "fcfs_contract_needs_review"); }
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { status: "Vet-MYM", year: "2", info: "CL 2| TCV 2K| AAV 1K", salary: "1000" }); const r = await stamp(env);
    t.equal(r.json.count, 0); t.equal(mfl.writes("salaries").length, 0, "a described contract (an owner's MYM) is never overwritten"); t.deepEqual(salRow(mfl).contractStatus, "Vet-MYM"); }
  { const { env, mfl } = fcfsWorld(); pickup(mfl, { txFid: "" }); const r = await stamp(env);
    t.equal(mfl.writes("salaries").length, 0, "no resolvable acquiring franchise: nothing is written"); t.equal(r.json.needs_input[0].outcome, "fcfs_contract_needs_review", "…and a person is told"); }
});
test("STAMPER: the BBID path is unchanged — a bid is written as the bid, and a BBID with no bid and no salary is STILL needs-input (no default)", async () => {
  { const { env, mfl } = fcfsWorld(); mfl.st.rosters = { "0004": [{ id: "17049", salary: 5000 }] }; mfl.st.salaries = [{ id: "17049", salary: "5000", contractStatus: "", contractYear: "", contractInfo: "" }];
    mfl.st.transactions = [{ type: "BBID_WAIVER", franchise: "0004", timestamp: String(TS), transaction: "17049,|5000|16171," }];
    const r = await stamp(env); t.equal(r.json.verified_count, 1); t.deepEqual(salRow(mfl, "17049"), { salary: "5000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 5K| AAV 5K" }); }
  { const { env, mfl } = fcfsWorld(); mfl.st.rosters = { "0004": [{ id: "17049", salary: null }] }; mfl.st.salaries = [{ id: "17049", salary: "", contractStatus: "", contractYear: "", contractInfo: "" }];
    mfl.st.transactions = [{ type: "BBID_WAIVER", franchise: "0004", timestamp: String(TS), transaction: "17049,||16171," }];
    const r = await stamp(env); t.equal(mfl.writes("salaries").length, 0); t.equal(r.json.needs_input[0].reason, "no_bid_establishable"); }
});
test("STAMPER: a blank contract is never silent — the cron alerts on needs-review and on a retry that outlives two ticks (wiring)", () => {
  const src = read("worker/src/index.js");
  t.match(src, /dmCommishOncePerBatch\(env, "fcfs_contract_needs_review_alert"/);
  t.match(src, /fcfs_unresolved:\$\{String\(o\.player_id/); t.match(src, /FCFS contract still unresolved \(fcfs_contract_retryable\)/);
  t.doesNotMatch(src, /Never a DM and never a default — just a durable log line/, "the log-only handling that let three FCFS pickups sit blank is gone");
  t.match(src, /That is FALSE on this league: the default row is entirely blank|FALSE on this league/);
  t.match(src, /CORRECTED 2026-09-26/, "the annotator header no longer claims MFL defaults an FCFS add to $1K");
});

// ═════════════════════════════════════ 3. the sub-$5K "full-year" rule ═════════════════════════════════════
const src = read("worker/src/index.js");
function grab(a, b) { const i = src.indexOf(a); if (i < 0) throw new Error("not found: " + a); const j = src.indexOf(b, i); if (j < 0) throw new Error("end not found: " + a); return src.slice(i, j + b.length); }
const parseFn = grab("const _parseContractData =", "return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned, weekAuthorityUnresolved };\n        };");
const compFn = grab("const _computeDropPenalty =", 'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };');
const prelude = `import { applyFullYearRule, classifyWwEarnedNa, isSubFiveKMultiYearFlat, WW_EARNED_NA_BASIS } from "${new URL("../worker/src/fcfs_contract.js", import.meta.url).href}";
const safeStr=(v)=>v==null?"":String(v); const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);}; const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=()=>"2026-09-09";
`;
fs.writeFileSync(path.join(os.tmpdir(), "_fcfs_drop_extracted.mjs"), prelude + parseFn + "\n" + compFn + "\nexport { _computeDropPenalty, _parseContractData };");
const { _computeDropPenalty: drop, _parseContractData: parseW } = await import(path.join(os.tmpdir(), "_fcfs_drop_extracted.mjs"));
const FCFS_IN = { contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" };
const INSEASON = { season: "2026", dropDateIso: "2026-09-24T00:00:00Z", completedPayableWeeks: 2 };

test("DROP RULE: an FCFS $1K one-year contract is priced by the dedicated full-year rule — $0, and NO weekly / cumulative earned amount (was $118)", () => {
  const r = drop(FCFS_IN, INSEASON);
  t.equal(r.basis, "ww_under_5k_exempt"); t.equal(r.penalty, 0); t.equal(r.exempt, true);
  t.equal(r.earned, null, "no weekly fraction"); t.equal(r.priorEarned, null, "no cumulative amount"); t.equal(r.currentYearEarned, null); t.equal(r.earned_rule, "full_year_sub_5k");
  for (const wk of [0, 1, 2, 5, 17]) { const x = drop(FCFS_IN, { ...INSEASON, completedPayableWeeks: wk }); t.equal(x.earned, null, `week ${wk}: never a $59/$118 figure`); t.equal(x.penalty, 0); }
  t.equal(drop(FCFS_IN, { season: "2026" }).earned, null, "offseason / no drop date: still no earned");
});
test("DROP RULE: multi-year sub-$5K keeps its flat $1K but carries no earned ($1,118 = prior year + weekly is gone); a >$4K contract and a taxi player keep their arithmetic", () => {
  const multi = drop({ contractStatus: "Vet-FAA", salary: 1000, contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", contractYear: "2" }, INSEASON);
  t.equal(multi.basis, "full_year_1k_contract", "a $1K-a-year multi-year contract carries the explicit full-year basis"); t.equal(multi.penalty, 1000); t.equal(multi.earned, null); t.equal(multi.earned_rule, "full_year_sub_5k");
  const flat2k = drop({ contractStatus: "Vet-FAA", salary: 2000, contractInfo: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", contractYear: "2" }, INSEASON);
  t.equal(flat2k.basis, "tcv_under_5k_flat", "a $2K-a-year deal is not the class: it keeps the flat basis under its own name"); t.equal(flat2k.penalty, 1000); t.notEqual(flat2k.earned, null, "…and its earned figure"); t.equal(flat2k.earned_rule, undefined);
  const flatMulti2k = drop({ contractStatus: "Vet-FAA", salary: 1500, contractInfo: "CL 2| TCV 3K| AAV 1.5K", contractYear: "2" }, INSEASON);
  t.equal(flatMulti2k.basis, "tcv_under_5k_flat"); t.equal(flatMulti2k.penalty, 1000); t.notEqual(flatMulti2k.earned, null, "TCV under $5K alone is not the class");
  const final = drop({ contractStatus: "Vet-FAA", salary: 1000, contractInfo: "CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-1K", contractYear: "1" }, INSEASON);
  t.equal(final.basis, "tcv_under_5k_final_year_exempt"); t.equal(final.earned, null);
  const big = drop({ contractStatus: "Vet-FAA", salary: 25000, contractInfo: "CL 1| TCV 25K| AAV 25K", contractYear: "1" }, INSEASON);
  t.equal(big.basis, "guarantee_minus_earned"); t.equal(big.earned, Math.round(25000 * 2 / 17)); t.equal(big.earned_rule, undefined, "the rule is for sub-$5K only");
  const taxi = drop({ contractStatus: "Rookie-Draft", salary: 1000, contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", contractYear: "2", isTaxi: true }, INSEASON);
  t.equal(taxi.basis, "taxi_exempt"); t.notEqual(taxi.earned, null, "taxi D2a settlement still reads prior-year earned");
  const unresolved = drop(FCFS_IN, { season: "2026", dropDateIso: "2026-09-24T00:00:00Z", completedPayableWeeks: null });
  t.equal(unresolved.basis, "week_authority_unresolved"); t.equal(unresolved.penalty, null, "fail-closed stays fail-closed");
  const unstamped = drop({ contractStatus: "", salary: 0, contractInfo: "", contractYear: "" }, INSEASON); t.equal(unstamped.basis, "contract_unstamped_needs_review", "a BLANK contract is unpriced, not cap-free");
});
test("DROP RULE (cap parity): the penalty — the only thing that reaches the cap — is identical with or without the earned figure; the actual drop charge stores NULL earned", () => {
  for (const [tcvInfo, sal, yrs, want] of [["CL 1| TCV 1K| AAV 1K", 1000, "1", 0], ["CL 3| TCV 3K| AAV 1K", 1000, "3", 1000], ["CL 2| TCV 2K| AAV 1K", 1000, "1", 0], ["CL 3| TCV 3K| AAV 1K", 1000, "1", 0]]) {
    for (const wk of [0, 3, 12, 17]) t.equal(drop({ contractStatus: "Vet-WW", salary: sal, contractInfo: tcvInfo, contractYear: yrs }, { ...INSEASON, completedPayableWeeks: wk }).penalty, want, `${tcvInfo} y${yrs} wk${wk}`);
  }
  // the writers persist earned as NULL when the calculator says so (never `|| 0`)
  t.match(src, /earned: calc\.earned != null \? \(Number\(calc\.earned\) \|\| 0\) : null/);
  t.match(src, /penaltyInfo\.earned != null \? Number\(penaltyInfo\.earned\) : null/);
  t.match(src, /earned_rule: r\.earned_rule \|\| null/, "the preview payload carries the rule to every client");
});

// ═════════════════════════════════════ 3b. the "$1K Per Yr" class (proof, not a TCV proxy) ═════════════════════════════════════
const tok = (info, sal) => FC.parseContractTokens(info, sal);
const cls = (info, sal, status = "Vet-FAA") => { const k = tok(info, sal); const c = { salary: sal, tcv: k.tcv, cl: k.cl, aav: k.aav, aavTiers: k.aavTiers, yearSalaries: k.yearSalaries }; return { proof: FC.classifyFullYearRule(c), klass: FC.contractClass(c, status) }; };
test("CLASS: 'full-year' is the $1K-per-year class — every contract year exactly $1,000 — NOT 'TCV under $5K'", () => {
  const m = (info, sal, status) => cls(info, sal, status);
  t.equal(m("CL 1| TCV 1K| AAV 1K", 1000, "Vet-WW").proof.member, true, "the FCFS canonical contract"); t.equal(m("CL 1| TCV 1K| AAV 1K", 1000, "Vet-WW").klass, "one_year_1k_ww");
  t.equal(m("CL 1| TCV 1K| AAV 1K", 1000, "Vet-FAA").klass, "other_1k_per_year", "a $1K Vet-FAA is the same class, a different contract type");
  t.equal(m("CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", 1000).proof.member, true, "multi-year at $1K a year");
  t.equal(m("CL 3| TCV 3K| AAV 1K| Y1-1, Y2-1, Y3-1| GTD: 2K", 1000).proof.member, true, "bare-number year tokens read as $K, exactly as the drop calculator does");
  t.equal(m("CL 4| TCV 4K| AAV 1K", 1000).proof.member, true, "CL 4 (TCV $4K) is the largest member");
  t.deepEqual(m("CL 5| TCV 5K| AAV 1K", 1000).proof.reasons.sort(), ["tcv_over_4k"], "TCV $5K is out");
  // TCV under $5K but NOT $1K a year — captured only by a TCV proxy
  for (const [info, sal, why, klass] of [["CL 1| TCV 4K| AAV 4K", 4000, "salary_not_1000", "sub_5k_one_year_above_1k"], ["CL 1| TCV 2K| AAV 2K", 2000, "salary_not_1000", "sub_5k_one_year_above_1k"],
      ["CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", 2000, "salary_not_1000", "sub_5k_multi_year_above_1k"]]) {
    const r = m(info, sal); t.equal(r.proof.member, false, info); t.ok(r.proof.reasons.includes(why), info + " " + r.proof.reasons); t.equal(r.klass, klass);
  }
  t.equal(m("CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-1K", 1000).proof.member, true);
  t.equal(m("CL 2| TCV 3K| AAV 1K| Y1-2K, Y2-1K", 1000).proof.member, false, "a $2K year inside a $1K-current contract");
  t.equal(m("CL 2| TCV 2K| AAV 2K", 1000).proof.member, false, "AAV token disagrees");
  t.equal(m("", 1000).proof.member, false, "no contract length → unproven → not a member"); t.equal(m("TCV 1K| AAV 1K", 1000).proof.reasons.includes("no_contract_length"), true);
  t.equal(m("CL 1| TCV 3K| AAV 3K", 1000).proof.member, false, "inconsistent shape");
  t.deepEqual(m("CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-1K", 1000).proof.proof, { cl: 2, tcv: 2000, salary: 1000, aav: 1000, aav_tiers: [1000], years: [1000, 1000] }, "the proof is data, not a boolean");
});
test("CLASS: the drop calculator applies the full-year rule to class members ONLY — a $4K waiver deal and a $2K Vet-FAA keep their earned figure", () => {
  const g = { ...INSEASON, completedPayableWeeks: 2 };
  const member = drop({ contractStatus: "Vet-FAA", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" }, g);
  t.equal(member.earned, null); t.equal(member.earned_rule, "full_year_sub_5k");
  const ww4 = drop({ contractStatus: "Vet-WW", salary: 4000, contractInfo: "CL 1| TCV 4K| AAV 4K", contractYear: "1" }, g);
  t.equal(ww4.basis, "ww_under_5k_earned_na", "canon §C3: WW under $4K — earned n/a — gets its own basis"); t.equal(ww4.penalty, 0, "the same cap-free $0"); t.equal(ww4.exempt, true);
  t.equal(ww4.earned, null, "earned is NOT APPLICABLE, not a weekly fraction"); t.equal(ww4.earned_rule, "ww_earned_na");
  const faa2 = drop({ contractStatus: "Vet-FAA", salary: 2000, contractInfo: "CL 1| TCV 2K| AAV 2K", contractYear: "1" }, g);
  t.equal(faa2.basis, "one_year_under_5k_exempt"); t.equal(faa2.earned, Math.round(2000 * 2 / 17)); t.equal(faa2.earned_rule, undefined);
  const henley = drop({ contractStatus: "Vet-FAA", salary: 2000, contractInfo: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", contractYear: "1" }, g);
  t.equal(henley.basis, "tcv_under_5k_final_year_exempt"); t.notEqual(henley.earned, null); t.equal(henley.earned_rule, undefined);
  // and the penalty is identical whether or not earned is present — the rule, not the earned figure, decides it
  for (const wk of [0, 2, 9, 17]) { t.equal(drop({ contractStatus: "Vet-WW", salary: 4000, contractInfo: "CL 1| TCV 4K| AAV 4K", contractYear: "1" }, { ...INSEASON, completedPayableWeeks: wk }).penalty, 0); }
  t.equal(FC.applyFullYearRule({ basis: "taxi_exempt", tcv: 1000, cl: 1, aav: 1000, yearSalaries: { 1: 1000 }, earned: 5 }, { salary: 1000 }).earned, 5, "taxi is never in the rule (the D2a settlement reads its earned)");
  t.equal(FC.applyFullYearRule({ basis: "week_authority_unresolved", tcv: 1000, cl: 1, aav: 1000, yearSalaries: {}, earned: undefined }, { salary: 1000 }).earned_rule, undefined);
});
test("CLASS: the tool's token parser and the worker's `_parseContractData` agree on every contract shape the league stores", () => {
  const shapes = ["CL 1| TCV 1K| AAV 1K", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", "CL 3| TCV 3K| AAV 1K| Y1-1, Y2-1, Y3-1| GTD: 2K", "CL 2|TCV 2K|AAV 1K|Y1-1K, Y2-1K|GTD: 1K", "CL 3| TCV 116K| AAV 49K| Y1-86 Y2-15 Y3-15",
    "CL 2|TCV 119K|AAV 42K, 52K|Y1-67K, Y2-52K", "CL 1|TCV 1.5K| AAV 1.5K", "", "TCV 4K", "CL 1| TCV 4K| AAV 4K"];
  for (const info of shapes) for (const sal of [0, 1000, 4000]) {
    const w = parseW({ contractInfo: info, salary: sal, contractYear: 1 }, {}); const k = tok(info, sal);
    t.deepEqual({ tcv: k.tcv, cl: k.cl, aav: k.aav, y: k.yearSalaries }, { tcv: w.tcv, cl: w.cl, aav: w.aav, y: w.yearSalaries }, JSON.stringify(info) + " / " + sal);
  }
});

test("CLASS (hardened): missing evidence never proves membership — a dual AAV tier, a schedule naming fewer years than CL, a missing CL, a $2K year", () => {
  const m = (info, sal = 1000) => cls(info, sal).proof;
  t.equal(m("CL 2| TCV 2K| AAV 1K, 2K| Y1-1K, Y2-1K").member, false); t.ok(m("CL 2| TCV 2K| AAV 1K, 2K| Y1-1K, Y2-1K").reasons.includes("aav_not_1000"));
  t.deepEqual(tok("CL 2|TCV 119K|AAV 42K, 52K|Y1-67K, Y2-52K", 1000).aavTiers, [42000, 52000], "the parser reads EVERY tier");
  t.equal(m("CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K").member, false); t.ok(m("CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K").reasons.includes("year_schedule_incomplete"));
  t.equal(m("CL 3| TCV 3K| AAV 1K").member, true, "no Y tokens at all: TCV = 1K x CL and AAV 1K prove it");
  t.equal(m("TCV 2K| AAV 1K").member, false); t.equal(m("CL 2| TCV 2K| AAV 1K| Y1-1K, Y2-2K").member, false);
  // the calculator classifies from the CONTRACT TEXT it was given (one code path), so a dual-tier contract keeps its earned
  const g = { ...INSEASON, completedPayableWeeks: 2 };
  t.equal(drop({ contractStatus: "Vet-FAA", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K, 2K", contractYear: "1" }, g).earned_rule, undefined);
  t.equal(drop({ contractStatus: "Vet-FAA", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" }, g).earned_rule, "full_year_sub_5k");
});
const grab2 = (a, b) => grab(a, b);
const d2aFn = grab2("const _d2aSettlement = (row) => {", "          settlement: owedForService - paidToDate,   // + owes, − credit\n        };\n      };");
fs.writeFileSync(path.join(os.tmpdir(), "_fcfs_d2a_extracted.mjs"), `const safeStr=(v)=>v==null?"":String(v); const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);}; const _s=(v)=>String(v==null?"":v).trim(); const _nflWeek1Iso=()=>"2026-09-09";\n` + parseFn + "\n" + d2aFn + "\nexport { _d2aSettlement };");
const { _d2aSettlement: d2a } = await import(path.join(os.tmpdir(), "_fcfs_d2a_extracted.mjs"));
test("§D2a (retirement settlement): a full-year-rule row stores earned NULL — 'actually paid' is read from the stored schedule, so a $1K-a-year contract still settles at $0 automatically", () => {
  const row = (o) => ({ pre_drop_aav: 1000, pre_drop_contract_length: 3, pre_drop_contract_year: 2, pre_drop_contract_info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", pre_drop_salary: 1000, earned_to_date: 1118, ...(o || {}) });
  const old = d2a(row()); t.equal(old.known, true); t.equal(old.actually_paid, 1118, "unchanged behaviour when earned is stored");
  const nul = d2a(row({ earned_to_date: null }));
  t.equal(nul.known, true, "NULL earned no longer means 'unparsed'"); t.equal(nul.actually_paid, 1000, "the one completed year, from the schedule"); t.equal(nul.owed_for_service, 1000); t.equal(nul.settlement, 0, "an unloaded $1K-a-year contract owes nothing");
  t.equal(d2a(row({ earned_to_date: null, pre_drop_contract_year: 3 })).settlement, 0, "served 0 years");
  t.equal(d2a(row({ earned_to_date: null, pre_drop_contract_info: "" })).known, false, "an unreadable schedule is STILL unknown — never a $0");
});

// ═════════════════════════════════════ 4. /admin/drops/full-year-repair ═════════════════════════════════════
const repair = (env, actions, dry) => callWorker(env, "POST", `/admin/drops/full-year-repair?L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", actions, ...(dry === undefined ? {} : { dry_run: dry }) } });
const DROP_INS = "INSERT INTO ups_drop_events (season, league_id, player_id, player_name, franchise_id, franchise_name, dropped_at_unix, dropped_at_iso, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_length, pre_drop_contract_info, pre_drop_tcv, pre_drop_aav, pre_drop_years_remaining, pre_drop_taxi, earned_to_date, guaranteed_amount, penalty_amount, penalty_basis, penalty_exempt, penalty_exempt_reason, posted_to_mfl, posted_amount, applies_to_season, discord_posted, notes) VALUES ('2026','74598',?,?,?,'T',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
function seedDrop(db, o) {
  o = { pid: "14590", fid: "0004", status: null, salary: 0, cy: 0, cl: null, info: null, tcv: 0, aav: null, yrs: 0, taxi: 0, earned: 0, guaranteed: null, penalty: 0, basis: "contract_unstamped_needs_review", exempt: 0, exemptReason: "", posted: 0, postedAmount: null, applies: 2027, discord: 1, notes: "Already announced via the adds/waiver-run poster at claim time.", ...(o || {}) };
  return Number(db.prepare(DROP_INS).run(o.pid, "Test " + o.pid, o.fid, TS + 400000, new Date((TS + 400000) * 1000).toISOString(), o.status, o.salary, o.cy, o.cl, o.info, o.tcv, o.aav, o.yrs, o.taxi, o.earned, o.guaranteed, o.penalty, o.basis, o.exempt, o.exemptReason, o.posted, o.postedAmount, o.applies, o.discord, o.notes).lastInsertRowid);
}
const rowOf2 = (db, id) => db.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(id);
const changedCols = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).sort();
const EXP_UNSTAMPED = (penalty) => ({ penalty_basis: "contract_unstamped_needs_review", penalty_amount: penalty });
const EXP_EARNED = (r) => ({ earned_to_date: r.earned_to_date, penalty_amount: r.penalty_amount, penalty_basis: r.penalty_basis });
const MEMBER = { status: "Vet-FAA", salary: 1000, cy: 1, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, aav: 1000, yrs: 1, basis: "one_year_under_5k_exempt", exempt: 1 };
test("REPAIR (Al-Shaair): dry-run is the default and shows the EXACT column diff; the real call changes only the ruled columns — the penalty, dead money, cap charge, guarantee and posted state stay identical; a second call is a no-op", async () => {
  const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const id = seedDrop(db);
  const before = rowOf2(db, id);
  const dry = await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: { penalty_basis: "contract_unstamped_needs_review", penalty_amount: 0 } }]);
  t.equal(dry.status, 200); t.equal(dry.json.dry_run, true); const r0 = dry.json.results[0]; t.equal(r0.result, "would_apply");
  t.deepEqual(Object.keys(r0.after).sort(), ["earned_to_date", "notes", "penalty_basis", "penalty_exempt", "penalty_exempt_reason", "pre_drop_aav", "pre_drop_contract_info", "pre_drop_contract_length", "pre_drop_contract_status", "pre_drop_contract_year", "pre_drop_salary", "pre_drop_tcv", "pre_drop_years_remaining"].sort(), "every column that will change, and nothing else");
  t.deepEqual({ status: r0.after.pre_drop_contract_status, salary: r0.after.pre_drop_salary, cl: r0.after.pre_drop_contract_length, info: r0.after.pre_drop_contract_info, tcv: r0.after.pre_drop_tcv, aav: r0.after.pre_drop_aav, yrs: r0.after.pre_drop_years_remaining, earned: r0.after.earned_to_date, basis: r0.after.penalty_basis, exempt: r0.after.penalty_exempt },
    { status: "Vet-WW", salary: 1000, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, aav: 1000, yrs: 1, earned: null, basis: "ww_under_5k_exempt", exempt: 1 });
  t.deepEqual(r0.unchanged, { penalty_amount: 0, posted_to_mfl: 0, posted_amount: null, guaranteed_amount: null, applies_to_season: 2027 }, "what must NOT change is stated");
  t.deepEqual(rowOf2(db, id), before, "dry run wrote nothing"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
  const live = await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: { penalty_basis: "contract_unstamped_needs_review", penalty_amount: 0 } }], false);
  t.equal(live.json.results[0].result, "applied");
  const after = rowOf2(db, id);
  t.deepEqual(changedCols(before, after), ["earned_to_date", "notes", "penalty_basis", "penalty_exempt", "penalty_exempt_reason", "pre_drop_aav", "pre_drop_contract_info", "pre_drop_contract_length", "pre_drop_contract_status", "pre_drop_contract_year", "pre_drop_salary", "pre_drop_tcv", "pre_drop_years_remaining"]);
  for (const k of ["penalty_amount", "guaranteed_amount", "posted_to_mfl", "posted_amount", "applies_to_season", "discord_posted", "franchise_id", "dropped_at_unix", "player_id"]) t.equal(after[k], before[k], `${k} unchanged`);
  t.equal(after.earned_to_date, null, "full-year representation"); t.equal(after.penalty_amount, 0, "the already-correct penalty is still $0"); t.match(after.notes, /^Already announced via the adds\/waiver-run poster at claim time\. \| fcfs_repair:/, "the original note is kept");
  const audit = db.prepare("SELECT * FROM ups_contract_gate_audit").all(); t.equal(audit.length, 1); t.equal(audit[0].field, "fcfs_reprice_unstamped_drop"); t.equal(audit[0].actor, "full_year_repair:admin"); t.match(audit[0].note, /unchanged=/);
  const again = await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: EXP_UNSTAMPED(0) }], false);
  t.equal(again.json.results[0].result, "noop_already_repriced"); t.deepEqual(rowOf2(db, id), after, "second run: zero changes"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 1);
});
test("REPAIR (Al-Shaair): the tool's proposal, the pure plan and the worker route's dry run are the SAME exact before/after; the canonical drop constant equals the real calculator", async () => {
  const canon = drop({ contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1", isTaxi: false }, { season: "2026" });
  t.deepEqual({ basis: canon.basis, penalty: canon.penalty, exempt_reason: canon.exempt_reason, earned: canon.earned, rule: canon.earned_rule }, { basis: FC.CANONICAL_FCFS_DROP.basis, penalty: FC.CANONICAL_FCFS_DROP.penalty, exempt_reason: FC.CANONICAL_FCFS_DROP.exempt_reason, earned: null, rule: "full_year_sub_5k" });
  const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const id = seedDrop(db);
  const row = rowOf2(db, id);
  const plan = FC.planUnstampedFcfsDropRepair(row);
  t.equal(plan.ok, true);
  const dry = (await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: { penalty_basis: "contract_unstamped_needs_review", penalty_amount: 0 } }])).json.results[0];
  t.deepEqual(dry.before, plan.before, "the worker's before == the pure plan's"); t.deepEqual(dry.after, plan.after, "the worker's after == the pure plan's"); t.deepEqual(dry.unchanged, plan.unchanged);
  t.deepEqual(plan.before, { pre_drop_contract_status: null, pre_drop_salary: 0, pre_drop_contract_year: 0, pre_drop_contract_length: null, pre_drop_contract_info: null, pre_drop_tcv: 0, pre_drop_aav: null, pre_drop_years_remaining: 0, earned_to_date: 0, penalty_basis: "contract_unstamped_needs_review", penalty_exempt: 0, penalty_exempt_reason: "", notes: "Already announced via the adds/waiver-run poster at claim time." });
  t.deepEqual(Object.keys(plan.after).sort(), Object.keys(plan.before).sort()); t.equal(plan.after.earned_to_date, null); t.equal(plan.after.penalty_basis, "ww_under_5k_exempt");
  t.deepEqual(FC.planUnstampedFcfsDropRepair({ ...row, penalty_amount: 1000 }), { ok: false, result: "conflict_penalty_would_change", detail: "canonical ww_under_5k_exempt/0 vs stored contract_unstamped_needs_review/1000 posted=0/null" }, "the ruling: a changed penalty stops the repair");
  t.equal(FC.planUnstampedFcfsDropRepair({ ...row, penalty_basis: "ww_under_5k_exempt" }).result, "noop_already_repriced");
});
test("REPAIR (Al-Shaair): if the canonical calculation would CHANGE the stored penalty / dead money / cap charge, nothing is written — the conflict is reported", async () => {
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const id = seedDrop(db, { penalty: 1000 });          // a stored $1,000 penalty vs the canonical $0
    const r = (await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: EXP_UNSTAMPED(1000) }], false)).json.results[0]; t.equal(r.result, "conflict_penalty_would_change"); t.match(r.detail, /canonical ww_under_5k_exempt\/0 vs stored contract_unstamped_needs_review\/1000/);
    t.equal(rowOf2(db, id).penalty_basis, "contract_unstamped_needs_review", "untouched"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0); }
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const id = seedDrop(db, { posted: 1, postedAmount: 1000 });    // already posted to MFL as a $1,000 cap charge
    t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: EXP_UNSTAMPED(0) }], false)).json.results[0].result, "conflict_penalty_would_change"); }
  { const { env, db } = fcfsWorld(); const id = seedDrop(db); t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: EXP_UNSTAMPED(0) }], false)).json.results[0].result, "not_an_fcfs_period", "no FCFS add event → not ours"); }
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const id = seedDrop(db);
    t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id, expect: { penalty_basis: "contract_unstamped_needs_review", penalty_amount: 5 } }], false)).json.results[0].result, "precondition_failed", "the row is not what the dry run saw");
    t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id: 99999 }], false)).json.results[0].result, "not_found");
    t.equal((await repair(env, [{ kind: "nuke_everything", id }], false)).json.results[0].result, "unknown_kind");
    t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id }], undefined)).json.results[0].result, "would_apply", "no dry_run flag = dry run"); }
});
test("REPAIR (earned): a class member's weekly / cumulative earned becomes NULL — ONE column changes; penalty, dead money, cap charge and every other column are byte-identical; second run zero changes", async () => {
  const { env, db } = fcfsWorld();
  const a = seedDrop(db, { ...MEMBER, pid: "1", earned: 118 });                                                                                                         // one-year $1K, weekly earned
  const b = seedDrop(db, { ...MEMBER, pid: "2", earned: 0 });                                                                                                           // earned $0 stored
  const c = seedDrop(db, { pid: "3", status: "Vet-FAA", salary: 1000, cy: 2, cl: 3, info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", tcv: 3000, aav: 1000, yrs: 2, basis: "tcv_under_5k_flat", earned: 1118, penalty: 1000, posted: 1, postedAmount: 1000, exempt: 0 });   // $1,118 = prior year + weekly; a real $1K penalty posted to MFL
  const ids = [a, b, c], before = Object.fromEntries(ids.map((i) => [i, rowOf2(db, i)]));
  const dry = await repair(env, ids.map((id) => ({ kind: "clear_full_year_earned", id, expect: { earned_to_date: before[id].earned_to_date, penalty_amount: before[id].penalty_amount, penalty_basis: before[id].penalty_basis } })));
  t.deepEqual(dry.json.results.map((r) => r.result), ["would_apply", "would_apply", "would_apply"]); t.equal(dry.json.results[2].proof.member, true); t.deepEqual(dry.json.results[2].proof.proof.years, [1000, 1000, 1000]);
  for (const i of ids) t.deepEqual(rowOf2(db, i), before[i], "dry run wrote nothing");
  const live = await repair(env, ids.map((id) => ({ kind: "clear_full_year_earned", id, expect: { earned_to_date: before[id].earned_to_date, penalty_amount: before[id].penalty_amount, penalty_basis: before[id].penalty_basis } })), false);
  t.deepEqual(live.json.results.map((r) => r.result), ["applied", "applied", "applied"]);
  for (const i of ids) { const after = rowOf2(db, i); t.deepEqual(changedCols(before[i], after), ["earned_to_date"], `row ${i}: exactly one column changed`); t.equal(after.earned_to_date, null); }
  t.equal(rowOf2(db, c).penalty_amount, 1000, "the $1K dead money stays"); t.equal(rowOf2(db, c).posted_amount, 1000, "the posted cap charge stays"); t.equal(rowOf2(db, c).posted_to_mfl, 1);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 3); t.match(db.prepare("SELECT note FROM ups_contract_gate_audit WHERE field = 'full_year_clear_earned' LIMIT 1").get().note, /proof=/);
  const snap = JSON.stringify(ids.map((i) => rowOf2(db, i)));
  const again = await repair(env, ids.map((id) => ({ kind: "clear_full_year_earned", id })), false);
  t.deepEqual(again.json.results.map((r) => r.result), ["noop_already_clear", "noop_already_clear", "noop_already_clear"]); t.equal(JSON.stringify(ids.map((i) => rowOf2(db, i))), snap, "second run: zero changes"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 3);
});
test("REPAIR (earned): NOT in the class ⇒ refused — a $4K one-year WW, a $2K Vet-FAA, a multi-year $2K-a-year deal, a taxi row; a stale expectation is refused; nothing else is touched", async () => {
  const { env, db } = fcfsWorld();
  const ww4 = seedDrop(db, { pid: "10", status: "Vet-WW", salary: 4000, cy: 1, cl: 1, info: "CL 1| TCV 4K| AAV 4K", tcv: 4000, aav: 4000, yrs: 1, basis: "ww_under_5k_exempt", earned: 471, exempt: 1 });
  const faa2 = seedDrop(db, { pid: "11", status: "Vet-FAA", salary: 2000, cy: 1, cl: 1, info: "CL 1| TCV 2K| AAV 2K", tcv: 2000, aav: 2000, yrs: 1, basis: "one_year_under_5k_exempt", earned: 235, exempt: 1 });
  const henley = seedDrop(db, { pid: "12", status: "Vet-FAA", salary: 2000, cy: 1, cl: 2, info: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", tcv: 4000, aav: 2000, yrs: 1, basis: "tcv_under_5k_final_year_exempt", earned: 2000, exempt: 1 });
  const taxi = seedDrop(db, { ...MEMBER, pid: "13", taxi: 1, basis: "taxi_exempt", earned: 1000 });
  const stale = seedDrop(db, { ...MEMBER, pid: "14", earned: 118 });
  for (const id of [ww4, faa2, henley, taxi]) t.equal((await repair(env, [{ kind: "clear_full_year_earned", id, expect: EXP_EARNED(rowOf2(db, id)) }], false)).json.results[0].result, "not_in_full_year_class", `row ${id}`);
  t.equal((await repair(env, [{ kind: "clear_full_year_earned", id: stale, expect: { ...EXP_EARNED(rowOf2(db, stale)), earned_to_date: 999 } }], false)).json.results[0].result, "precondition_failed");
  t.equal((await repair(env, [{ kind: "clear_full_year_earned", id: stale, expect: { ...EXP_EARNED(rowOf2(db, stale)), penalty_amount: 7 } }], false)).json.results[0].result, "precondition_failed");
  for (const [id, e] of [[ww4, 471], [faa2, 235], [henley, 2000], [taxi, 1000], [stale, 118]]) t.equal(rowOf2(db, id).earned_to_date, e, `row ${id} untouched`);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
  // the route is closed without the commissioner key
  t.equal((await callWorker(env, "POST", "/admin/drops/full-year-repair?L=74598&YEAR=2026", { body: { season: "2026", actions: [{ kind: "clear_full_year_earned", id: stale }], dry_run: false } })).status, 403);
  t.equal(rowOf2(db, stale).earned_to_date, 118);
});

test("REPAIR (input + safety): strict ids, one action per row, at most 200, only a boolean false writes, a real write needs the dry-run's expectation, blank-only, latest-add-is-FCFS, rookie, atomic audit", async () => {
  const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004");
  const call = (body) => callWorker(env, "POST", `/admin/drops/full-year-repair?L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`, { body });
  const a = seedDrop(db, { ...MEMBER, pid: "31", earned: 118 });
  const B = (actions, extra) => ({ season: "2026", league_id: "74598", actions, ...(extra || {}) });
  // ids
  const r1 = (await call(B([{ kind: "clear_full_year_earned", id: "1abc" }, { kind: "clear_full_year_earned", id: 1.9 }, { kind: "clear_full_year_earned", id: 0 }, { kind: "clear_full_year_earned", id: -3 }, { kind: "clear_full_year_earned" }], { dry_run: false }))).json.results;
  t.deepEqual(r1.map((x) => x.result), ["bad_id", "bad_id", "bad_id", "bad_id", "bad_id"]);
  // duplicates in one request: the second is skipped
  const exp = EXP_EARNED(rowOf2(db, a));
  t.deepEqual((await call(B([{ kind: "clear_full_year_earned", id: a, expect: exp }, { kind: "clear_full_year_earned", id: a, expect: exp }]))).json.results.map((x) => x.result), ["would_apply", "duplicate_in_request"]);
  // > 200 → 400, malformed JSON → 400, no actions → 400
  t.equal((await call(B(Array.from({ length: 201 }, (_, i) => ({ kind: "clear_full_year_earned", id: i + 1 }))))).status, 400);
  t.equal((await callWorker(env, "POST", `/admin/drops/full-year-repair?L=74598&YEAR=2026&APIKEY=${ADMIN_KEY}`, { body: "{not json" })).status, 400);
  t.equal((await call(B([]))).status, 400);
  // only the boolean `false` writes
  for (const v of ["false", 0, null, "no", undefined]) { const r = (await call(B([{ kind: "clear_full_year_earned", id: a, expect: exp }], v === undefined ? {} : { dry_run: v }))).json; t.equal(r.dry_run, true, `dry_run=${JSON.stringify(v)} is still a dry run`); t.equal(rowOf2(db, a).earned_to_date, 118); }
  // a real write REQUIRES the expectation
  t.equal((await call(B([{ kind: "clear_full_year_earned", id: a }], { dry_run: false }))).json.results[0].result, "expectation_required"); t.equal(rowOf2(db, a).earned_to_date, 118);
  // atomic audit: two concurrent identical applies — exactly ONE change and ONE audit row
  const [x, y] = await Promise.all([call(B([{ kind: "clear_full_year_earned", id: a, expect: exp }], { dry_run: false })), call(B([{ kind: "clear_full_year_earned", id: a, expect: exp }], { dry_run: false }))]);
  const results = [x.json.results[0].result, y.json.results[0].result].sort();
  t.deepEqual(results, ["applied", "noop_changed_concurrently"], "the loser meets the guard: " + JSON.stringify(results)); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'full_year_clear_earned'").get().n, 1, "one audit row, exactly when the change landed");
  // reprice: blank-only
  const desc = seedDrop(db, { pid: "14590", status: "Vet-WW", salary: 1000, info: "CL 1| TCV 1K| AAV 1K", cy: 1, cl: 1, tcv: 1000 });          // a DESCRIBED stored contract on an "unstamped" row
  const rd = (await call(B([{ kind: "reprice_unstamped_fcfs_drop", id: desc, expect: EXP_UNSTAMPED(0) }], { dry_run: false }))).json.results[0]; t.equal(rd.result, "precondition_failed"); t.match(rd.detail, /not blank/); t.equal(rowOf2(db, desc).penalty_basis, "contract_unstamped_needs_review");
  // reprice: the LATEST add must be an FCFS add (a later BBID re-acquisition is another contract)
  db.prepare("INSERT INTO ups_add_events (season, league_id, player_id, franchise_id, acquired_at_unix, acquired_at_iso, source, detected_at_utc) VALUES ('2026','74598','14591','0004', ?, 'x', 'fcfs', 'x')").run(TS);
  db.prepare("INSERT INTO ups_add_events (season, league_id, player_id, franchise_id, acquired_at_unix, acquired_at_iso, source, detected_at_utc) VALUES ('2026','74598','14591','0004', ?, 'x', 'bbid', 'x')").run(TS + 100);
  const bb = seedDrop(db, { pid: "14591" }); t.equal((await call(B([{ kind: "reprice_unstamped_fcfs_drop", id: bb, expect: EXP_UNSTAMPED(0) }], { dry_run: false }))).json.results[0].result, "not_an_fcfs_period");
  // reprice: a rookie is Rookie-WW
  seedAddEvent(db, "14592", "0004"); const rk = seedDrop(db, { pid: "14592" });
  const rr = (await call(B([{ kind: "reprice_unstamped_fcfs_drop", id: rk, expect: EXP_UNSTAMPED(0), rookie: true }], { dry_run: false }))).json.results[0]; t.equal(rr.result, "applied"); t.equal(rowOf2(db, rk).pre_drop_contract_status, "Rookie-WW");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'fcfs_reprice_unstamped_drop'").get().n, 1, "one audit row per applied reprice");
});
test("REPAIR (defensive abort): an unexpected extra change is undone and audited — the row ends exactly as it was", async () => {
  const { env, db } = fcfsWorld(); const a = seedDrop(db, { ...MEMBER, pid: "41", earned: 118 });
  // a trigger that ALSO alters another column whenever earned_to_date is cleared — the write "succeeds" but violates the one-column promise
  db.exec("CREATE TRIGGER sabotage AFTER UPDATE OF earned_to_date ON ups_drop_events BEGIN UPDATE ups_drop_events SET penalty_amount = 999 WHERE id = NEW.id; END;");
  const before = rowOf2(db, a);
  const r = (await repair(env, [{ kind: "clear_full_year_earned", id: a, expect: EXP_EARNED(before) }], false)).json.results[0];
  t.equal(r.result, "aborted_unexpected_change"); t.match(r.detail, /penalty_amount/);
  db.exec("DROP TRIGGER sabotage");
  t.equal(rowOf2(db, a).earned_to_date, 118, "earned restored"); t.equal(rowOf2(db, a).penalty_amount, 999, "(the saboteur's own change is outside what the route restores — it restores EARNED and records the abort)");
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'full_year_clear_earned_ABORTED'").get().n, 1);
});

// ═════════════════════════════════════ 4b. canon §C3 "WW under $4K — earned n/a" and the legacy guarantee rows ═════════════════════════════════════
const WW_NA = (status, sal) => ({ status, salary: sal, cy: 1, cl: 1, info: `CL 1| TCV ${sal / 1000}K| AAV ${sal / 1000}K`, tcv: sal, aav: sal, yrs: 1, basis: "ww_under_5k_exempt", exempt: 1, penalty: 0 });
const LEGACY = { status: "Vet-MYM", salary: 1000, cy: 2, cl: 3, info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", tcv: 3000, aav: 1000, yrs: 2, basis: "tcv_under_5k_guarantee", earned: 1000, penalty: 1000, guaranteed: 2000, exempt: 0 };
const G2 = { season: "2026", dropDateIso: "2026-09-24T00:00:00Z", completedPayableWeeks: 2 };
test("CALC (canon §C3): a one-year pure-WW contract of $2K–$4K is priced on its OWN basis — $0, cap-free, earned NOT APPLICABLE; a $1K WW deal stays the full-year class; a WW-MYM and a multi-year WW are untouched", () => {
  for (const [status, sal] of [["Vet-WW", 2000], ["Vet-WW", 3000], ["Vet-WW", 4000], ["Rookie-WW", 2000], ["WW", 3000]]) {
    for (const wk of [0, 2, 9, 17]) {
      const r = drop({ contractStatus: status, salary: sal, contractInfo: `CL 1| TCV ${sal / 1000}K| AAV ${sal / 1000}K`, contractYear: "1" }, { ...G2, completedPayableWeeks: wk });
      t.equal(r.basis, "ww_under_5k_earned_na", `${status} $${sal} wk${wk}`); t.equal(r.penalty, 0); t.equal(r.exempt, true);
      t.equal(r.earned, null, "no weekly fraction"); t.equal(r.priorEarned, null); t.equal(r.currentYearEarned, null); t.equal(r.earned_rule, "ww_earned_na");
    }
    t.equal(drop({ contractStatus: status, salary: sal, contractInfo: `CL 1| TCV ${sal / 1000}K| AAV ${sal / 1000}K`, contractYear: "1" }, { season: "2026" }).basis, "ww_under_5k_earned_na", "offseason / no drop date: the same basis");
  }
  const oneK = drop({ contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" }, G2);
  t.equal(oneK.basis, "ww_under_5k_exempt", "$1,000 stays on the FCFS basis"); t.equal(oneK.earned_rule, "full_year_sub_5k", "…under the FULL-YEAR rule, not the WW-n/a rule");
  // untouched: WW-MYM, a multi-year WW in its last year, a $5K+ WW, taxi
  const mym = drop({ contractStatus: "Vet-WW-MYM", salary: 3000, contractInfo: "CL 1| TCV 3K| AAV 3K", contractYear: "1" }, G2);
  t.equal(mym.basis, "ww_under_5k_exempt", "a WW-MYM keeps its existing basis"); t.equal(mym.earned_rule, undefined); t.notEqual(mym.earned, null);
  const multiLast = drop({ contractStatus: "Vet-WW", salary: 2000, contractInfo: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", contractYear: "1" }, G2);
  t.equal(multiLast.basis, "ww_under_5k_exempt", "a multi-year WW in its last year is not the one-year class"); t.equal(multiLast.earned_rule, undefined);
  const multiFirst = drop({ contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", contractYear: "3" }, G2);
  t.equal(multiFirst.basis, "full_year_1k_contract", "a multi-year WW with years remaining is the flat multi-year rule — a $1K-a-year class member"); t.equal(multiFirst.penalty, 1000);
  const big = drop({ contractStatus: "Vet-WW", salary: 6000, contractInfo: "CL 1| TCV 6K| AAV 6K", contractYear: "1" }, G2);
  t.notEqual(big.basis, "ww_under_5k_earned_na");
  // the penalty is identical to the pre-change value everywhere: cap parity
  for (const sal of [2000, 3000, 4000]) t.equal(drop({ contractStatus: "Vet-WW", salary: sal, contractInfo: `CL 1| TCV ${sal / 1000}K| AAV ${sal / 1000}K`, contractYear: "1" }, G2).penalty, 0);
});
test("CLASS (canon §C3): classifyWwEarnedNa names every reason a contract is NOT in the WW earned-n/a class — status, taxi, salary, length, TCV, years remaining", () => {
  const ok = { status: "Vet-WW", salary: 2000, tcv: 2000, cl: 1, yearsRemaining: 1, taxi: false };
  t.deepEqual(FC.classifyWwEarnedNa(ok), { member: true, reasons: [] });
  for (const st of ["Rookie-WW", "WW"]) t.equal(FC.classifyWwEarnedNa({ ...ok, status: st }).member, true, st);
  const why = (o) => FC.classifyWwEarnedNa({ ...ok, ...o }).reasons;
  t.deepEqual(why({ status: "Vet-WW-MYM" }), ["status_not_ww"]); t.deepEqual(why({ status: "Vet-FAA" }), ["status_not_ww"]); t.deepEqual(why({ status: "" }), ["status_not_ww"]);
  t.deepEqual(why({ taxi: true }), ["taxi"]); t.deepEqual(why({ salary: 5000, tcv: 5000 }), ["salary_not_within_4k"]); t.deepEqual(why({ salary: 0, tcv: 0 }), ["salary_not_within_4k"]);
  t.deepEqual(why({ cl: 2 }), ["not_a_one_year_original_contract"]); t.deepEqual(why({ cl: 2, tcv: 4000 }), ["not_a_one_year_original_contract", "tcv_differs_from_salary"], "both reasons are reported"); t.deepEqual(why({ cl: null }), ["not_a_one_year_original_contract"]);
  t.deepEqual(why({ tcv: 3000 }), ["tcv_differs_from_salary"]); t.deepEqual(why({ yearsRemaining: 2 }), ["not_in_final_year"]);
  t.equal(FC.classifyWwEarnedNa({ ...ok, yearsRemaining: NaN }).member, false, "an unreadable years-remaining is unproven, never a member");
  // the shared flat rule (one implementation for the calculator and the repairs)
  t.equal(FC.isSubFiveKMultiYearFlat({ cl: 3, yearsRemaining: 2 }), true); t.equal(FC.isSubFiveKMultiYearFlat({ cl: 3, yearsRemaining: 1 }), false);
  t.equal(FC.isSubFiveKMultiYearFlat({ cl: 1, yearsRemaining: 1 }), false); t.equal(FC.subFiveKFlatPenalty({ cl: 4, yearsRemaining: 4 }), 1000); t.equal(FC.subFiveKFlatPenalty({ cl: 2, yearsRemaining: 1 }), 0);
  for (const b of ["full_year_1k_contract", "ww_under_5k_earned_na"]) t.equal(FC.SUB_FIVE_K_BASES.has(b), true, `${b} is a sub-$5K basis`);
  t.equal(FC.SUB_FIVE_K_BASES.has("ww_under_5k_exempt"), true);
});
test("REPAIR (canon §C3): the six WW rows — earned → NULL and basis → ww_under_5k_earned_na; EXACTLY those two columns change; penalty, dead money, cap effect are byte-identical; second run zero changes", async () => {
  const { env, db } = fcfsWorld();
  const ids = [seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "116", earned: 235 }), seedDrop(db, { ...WW_NA("Vet-WW", 3000), pid: "117", earned: 353 }), seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "122", earned: 118 }),
    seedDrop(db, { ...WW_NA("Vet-WW", 3000), pid: "131", earned: 176 }), seedDrop(db, { ...WW_NA("Rookie-WW", 2000), pid: "136", earned: 235 }), seedDrop(db, { ...WW_NA("Vet-WW", 4000), pid: "140", earned: 471 })];
  const before = Object.fromEntries(ids.map((i) => [i, rowOf2(db, i)]));
  const act = (id) => ({ kind: "clear_ww_earned_na", id, expect: EXP_EARNED(before[id]) });
  const dry = await repair(env, ids.map(act));
  t.deepEqual(dry.json.results.map((r) => r.result), Array(6).fill("would_apply"));
  for (const r of dry.json.results) {
    t.deepEqual(Object.keys(r.after).sort(), ["earned_to_date", "penalty_basis"], "the exact columns"); t.equal(r.after.earned_to_date, null); t.equal(r.after.penalty_basis, "ww_under_5k_earned_na"); t.equal(r.before.penalty_basis, "ww_under_5k_exempt");
    t.equal(r.derivation.penalty_before, r.derivation.penalty_after); t.equal(r.derivation.dead_money_before, r.derivation.dead_money_after); t.deepEqual(r.derivation.posted_cap_before, r.derivation.posted_cap_after); t.equal(r.derivation.mfl_financial_write_proposed, false);
    t.equal(r.proof.class, "ww_earned_na"); t.deepEqual(r.unchanged, { penalty_amount: 0, guaranteed_amount: null, penalty_exempt: 1, penalty_exempt_reason: "", posted_to_mfl: 0, posted_amount: null, applies_to_season: 2027 });
  }
  for (const i of ids) t.deepEqual(rowOf2(db, i), before[i], "dry run wrote nothing"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
  const live = await repair(env, ids.map(act), false);
  t.deepEqual(live.json.results.map((r) => r.result), Array(6).fill("applied"));
  for (const i of ids) {
    const after = rowOf2(db, i); t.deepEqual(changedCols(before[i], after), ["earned_to_date", "penalty_basis"], `row ${i}: exactly two columns`); t.equal(after.earned_to_date, null); t.equal(after.penalty_basis, "ww_under_5k_earned_na");
    for (const k of FC.PROTECTED_FINANCIAL_COLUMNS) t.equal(after[k], before[i][k], `${k} unchanged`);
  }
  const audit = db.prepare("SELECT * FROM ups_contract_gate_audit WHERE field = 'ww_earned_na_clear'").all(); t.equal(audit.length, 6); t.match(audit[0].note, /proof=.*unchanged=.*derivation=/); t.equal(audit[0].actor, "full_year_repair:admin");
  const snap = JSON.stringify(ids.map((i) => rowOf2(db, i)));
  const again = await repair(env, ids.map((id) => ({ kind: "clear_ww_earned_na", id })), false);
  t.deepEqual(again.json.results.map((r) => r.result), Array(6).fill("noop_already_clear")); t.equal(JSON.stringify(ids.map((i) => rowOf2(db, i))), snap, "second run: zero changes"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 6);
});
test("REPAIR (canon §C3): NOT in the class ⇒ refused — the $1K deal, a WW-MYM, a multi-year WW, a taxi row, a $5K WW, a non-WW; a stored penalty / posted charge the canonical calculation would change; a stale expectation; nothing is touched", async () => {
  const { env, db } = fcfsWorld();
  const oneK = seedDrop(db, { ...WW_NA("Vet-WW", 1000), pid: "201", earned: 118 });
  const mym = seedDrop(db, { ...WW_NA("Vet-WW-MYM", 3000), pid: "202", earned: 176 });
  const multi = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "203", cl: 2, info: "CL 2| TCV 4K| AAV 2K| Y1-2K, Y2-2K", tcv: 4000, earned: 2000 });
  const taxi = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "204", taxi: 1, earned: 235 });
  const big = seedDrop(db, { ...WW_NA("Vet-WW", 6000), pid: "205", earned: 700 });
  const faa = seedDrop(db, { ...WW_NA("Vet-FAA", 2000), pid: "206", basis: "one_year_under_5k_exempt", earned: 235 });
  const notFinal = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "207", yrs: 2, cy: 2, earned: 235 });
  const wrongBasis = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "208", basis: "contract_unstamped_needs_review", earned: 235 });
  const penalty = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "209", penalty: 1000, earned: 235 });                            // a stored $1,000 the cap-free rule would change
  const posted = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "210", posted: 1, postedAmount: 500, earned: 235 });               // posted to MFL as $500 vs computed $0
  const notExempt = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "211", exempt: 0, earned: 235 });
  const stale = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "212", earned: 235 });
  const want = { [oneK]: "not_in_ww_earned_na", [mym]: "not_in_ww_earned_na", [multi]: "not_in_ww_earned_na", [taxi]: "not_in_ww_earned_na", [big]: "not_in_ww_earned_na", [faa]: "not_in_ww_earned_na", [notFinal]: "not_in_ww_earned_na",
    [wrongBasis]: "not_in_ww_earned_na", [penalty]: "conflict_financials_would_change", [posted]: "conflict_financials_would_change", [notExempt]: "conflict_financials_would_change" };
  const snap = Object.fromEntries(Object.keys(want).concat([stale]).map((i) => [i, rowOf2(db, Number(i))]));
  for (const [id, res] of Object.entries(want)) t.equal((await repair(env, [{ kind: "clear_ww_earned_na", id: Number(id), expect: EXP_EARNED(rowOf2(db, Number(id))) }], false)).json.results[0].result, res, `row ${id}`);
  t.match((await repair(env, [{ kind: "clear_ww_earned_na", id: penalty, expect: EXP_EARNED(rowOf2(db, penalty)) }])).json.results[0].detail, /stored penalty 1000 vs computed 0/);
  t.match((await repair(env, [{ kind: "clear_ww_earned_na", id: posted, expect: EXP_EARNED(rowOf2(db, posted)) }])).json.results[0].detail, /posted to MFL as 500 vs computed 0/);
  t.equal((await repair(env, [{ kind: "clear_ww_earned_na", id: stale, expect: { ...EXP_EARNED(rowOf2(db, stale)), earned_to_date: 999 } }], false)).json.results[0].result, "precondition_failed");
  t.equal((await repair(env, [{ kind: "clear_ww_earned_na", id: stale }], false)).json.results[0].result, "expectation_required", "a real write needs the dry run's expectation");
  for (const [i, r] of Object.entries(snap)) t.deepEqual(rowOf2(db, Number(i)), r, `row ${i} untouched`);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
  // the $1K FCFS class row is NOT reachable through the WW route, and a WW-n/a row is NOT reachable through the class route
  t.equal((await repair(env, [{ kind: "clear_full_year_earned", id: stale, expect: EXP_EARNED(rowOf2(db, stale)) }], false)).json.results[0].result, "not_in_full_year_class");
});
test("REPAIR (legacy rows 32 / 33 / 40): a class row on `tcv_under_5k_guarantee` → earned NULL + `full_year_1k_contract`, ONLY because the canonical $1K/year rule gives EXACTLY the stored penalty; the full derivation is in the result and the audit", async () => {
  const { env, db } = fcfsWorld();
  const ids = [seedDrop(db, { ...LEGACY, pid: "32" }), seedDrop(db, { ...LEGACY, pid: "33", info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 2K", posted: 1, postedAmount: 1000 }), seedDrop(db, { ...LEGACY, pid: "40", cl: 4, yrs: 3, cy: 3, info: "CL 4| TCV 4K| AAV 1K| Y1-1K, Y2-1K, Y3-1K, Y4-1K| GTD: 3K", tcv: 4000, guaranteed: 3000, earned: 2000 })];
  const before = Object.fromEntries(ids.map((i) => [i, rowOf2(db, i)]));
  const act = (id) => ({ kind: "reconcile_legacy_guarantee_basis", id, expect: EXP_EARNED(before[id]) });
  const dry = await repair(env, ids.map(act));
  t.deepEqual(dry.json.results.map((r) => r.result), ["would_apply", "would_apply", "would_apply"]);
  for (const r of dry.json.results) {
    t.deepEqual(Object.keys(r.after).sort(), ["earned_to_date", "penalty_basis"]); t.equal(r.before.penalty_basis, "tcv_under_5k_guarantee"); t.equal(r.after.penalty_basis, "full_year_1k_contract"); t.equal(r.after.earned_to_date, null);
    t.equal(r.derivation.computed_penalty, 1000, "the canonical flat rule"); t.equal(r.derivation.penalty_before, 1000); t.equal(r.derivation.penalty_after, 1000); t.equal(r.derivation.dead_money_before, r.derivation.dead_money_after);
    t.deepEqual(r.derivation.posted_cap_before, r.derivation.posted_cap_after); t.equal(r.derivation.legacy_derivation.basis, "tcv_under_5k_guarantee"); t.equal(r.derivation.mfl_financial_write_proposed, false); t.equal(r.proof.class, "full_year_1k");
  }
  t.equal(dry.json.results[2].derivation.years_remaining, 3); t.equal(dry.json.results[2].derivation.legacy_derivation.earned_to_date, 2000);
  for (const i of ids) t.deepEqual(rowOf2(db, i), before[i], "dry run wrote nothing");
  const live = await repair(env, ids.map(act), false);
  t.deepEqual(live.json.results.map((r) => r.result), ["applied", "applied", "applied"]);
  for (const i of ids) {
    const after = rowOf2(db, i); t.deepEqual(changedCols(before[i], after), ["earned_to_date", "penalty_basis"]); t.equal(after.penalty_basis, "full_year_1k_contract"); t.equal(after.earned_to_date, null);
    for (const k of FC.PROTECTED_FINANCIAL_COLUMNS) t.equal(after[k], before[i][k], `${k} unchanged (dead money, guarantee, posted cap)`);
  }
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'legacy_guarantee_reconcile'").get().n, 3); t.match(db.prepare("SELECT note FROM ups_contract_gate_audit WHERE field = 'legacy_guarantee_reconcile' LIMIT 1").get().note, /derivation=.*legacy_derivation/);
  const snap = JSON.stringify(ids.map((i) => rowOf2(db, i)));
  t.deepEqual((await repair(env, ids.map((id) => ({ kind: "reconcile_legacy_guarantee_basis", id })), false)).json.results.map((r) => r.result), ["noop_already_clear", "noop_already_clear", "noop_already_clear"]);
  t.equal(JSON.stringify(ids.map((i) => rowOf2(db, i))), snap, "second run: zero changes");
});
test("REPAIR (legacy rows): HELD, earned NOT cleared, when the canonical rule would not reproduce the stored penalty / dead money / posted charge — or when the row is not in the class", async () => {
  const { env, db } = fcfsWorld();
  const finalYr = seedDrop(db, { ...LEGACY, pid: "301", cy: 1, yrs: 1, penalty: 1000 });                            // final year: the canonical rule is $0, the stored penalty is $1,000
  const postedDiff = seedDrop(db, { ...LEGACY, pid: "302", posted: 1, postedAmount: 500 });                          // posted to MFL as $500 vs canonical $1,000
  const penaltyDiff = seedDrop(db, { ...LEGACY, pid: "303", penalty: 700 });                                         // stored $700 vs canonical $1,000
  const exemptDiff = seedDrop(db, { ...LEGACY, pid: "304", exempt: 1 });                                             // flagged exempt but the canonical rule charges $1,000
  const notClass = seedDrop(db, { ...LEGACY, pid: "305", salary: 2000, info: "CL 3| TCV 6K| AAV 2K", tcv: 6000, aav: 2000 });
  const taxi = seedDrop(db, { ...LEGACY, pid: "306", taxi: 1 });
  const otherBasis = seedDrop(db, { ...LEGACY, pid: "307", basis: "tcv_under_5k_flat" });
  const all = { [finalYr]: "hold_conflict_penalty_would_change", [postedDiff]: "hold_conflict_penalty_would_change", [penaltyDiff]: "hold_conflict_penalty_would_change", [exemptDiff]: "hold_conflict_penalty_would_change",
    [notClass]: "not_in_full_year_class", [taxi]: "not_in_full_year_class", [otherBasis]: "not_a_legacy_guarantee_row" };
  const snap = Object.fromEntries(Object.keys(all).map((i) => [i, rowOf2(db, Number(i))]));
  for (const [id, res] of Object.entries(all)) t.equal((await repair(env, [{ kind: "reconcile_legacy_guarantee_basis", id: Number(id), expect: EXP_EARNED(rowOf2(db, Number(id))) }], false)).json.results[0].result, res, `row ${id}`);
  t.match((await repair(env, [{ kind: "reconcile_legacy_guarantee_basis", id: finalYr }])).json.results[0].detail, /stored penalty 1000 vs computed 0 — held; earned NOT cleared/);
  t.match((await repair(env, [{ kind: "reconcile_legacy_guarantee_basis", id: postedDiff }])).json.results[0].detail, /posted to MFL as 500 vs computed 1000/);
  for (const [i, r] of Object.entries(snap)) t.deepEqual(rowOf2(db, Number(i)), r, `row ${i}: nothing written, earned kept`);
  t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0);
  // the class route never touches a legacy guarantee row (its penalty was derived from earned)
  const ok = seedDrop(db, { ...LEGACY, pid: "308" });
  t.equal((await repair(env, [{ kind: "clear_full_year_earned", id: ok, expect: EXP_EARNED(rowOf2(db, ok)) }], false)).json.results[0].result, "not_in_full_year_class", "clear_full_year_earned refuses the legacy basis");
  t.equal(rowOf2(db, ok).earned_to_date, 1000);
});
test("PLAN (pure): the three earned repairs name exactly the columns they set, and the two new plans refuse without evidence — the route and the tool read the SAME plan", () => {
  t.deepEqual({ ...FC.EARNED_REPAIR_COLUMNS }, { clear_full_year_earned: ["earned_to_date"], reconcile_legacy_guarantee_basis: ["earned_to_date", "penalty_basis"], clear_ww_earned_na: ["earned_to_date", "penalty_basis"] });
  t.deepEqual([...FC.PROTECTED_FINANCIAL_COLUMNS], ["penalty_amount", "guaranteed_amount", "penalty_exempt", "penalty_exempt_reason", "posted_to_mfl", "posted_amount", "applies_to_season"]);
  const ww = { penalty_basis: "ww_under_5k_exempt", earned_to_date: 235, pre_drop_contract_status: "Vet-WW", pre_drop_salary: 2000, pre_drop_contract_info: "CL 1| TCV 2K| AAV 2K", pre_drop_contract_year: 1, pre_drop_years_remaining: 1, pre_drop_taxi: 0, penalty_amount: 0, penalty_exempt: 1, posted_to_mfl: 0, posted_amount: null, applies_to_season: 2027, guaranteed_amount: null, penalty_exempt_reason: "" };
  const p = FC.planWwEarnedNaRepair(ww); t.equal(p.ok, true); t.deepEqual(p.set, { earned_to_date: null, penalty_basis: "ww_under_5k_earned_na" });
  t.equal(FC.planWwEarnedNaRepair({ ...ww, pre_drop_contract_info: "" }).ok, false, "no contract text ⇒ no proof ⇒ no repair");
  t.equal(FC.planWwEarnedNaRepair({ ...ww, pre_drop_years_remaining: null, pre_drop_contract_year: null }).ok, false, "unknown years remaining ⇒ unproven");
  t.equal(FC.planWwEarnedNaRepair({ ...ww, penalty_basis: "ww_under_5k_earned_na", earned_to_date: null }).result, "noop_already_clear");
  const lg = { ...ww, penalty_basis: "tcv_under_5k_guarantee", pre_drop_contract_status: "Vet-MYM", pre_drop_salary: 1000, pre_drop_contract_info: LEGACY.info, pre_drop_contract_year: 2, pre_drop_years_remaining: 2, earned_to_date: 1000, penalty_amount: 1000, penalty_exempt: 0, guaranteed_amount: 2000 };
  const q = FC.planLegacyGuaranteeRepair(lg); t.equal(q.ok, true); t.deepEqual(q.set, { earned_to_date: null, penalty_basis: "full_year_1k_contract" }); t.equal(q.derivation.computed_penalty, 1000);
  t.equal(FC.planLegacyGuaranteeRepair({ ...lg, pre_drop_contract_info: "" }).ok, false, "no contract text ⇒ not proven in the class ⇒ held");
  t.equal(FC.planLegacyGuaranteeRepair({ ...lg, pre_drop_years_remaining: null, pre_drop_contract_year: null }).ok, false, "unknown years remaining ⇒ the canonical rule cannot be evaluated ⇒ held (never read as a final year)");
  t.equal(FC.classifyWwEarnedNa({ status: "Vet-WW", salary: 2000, tcv: 2000, cl: 1, yearsRemaining: null, taxi: false }).member, false, "a NULL years-remaining is unknown, not 0");
  t.equal(FC.planLegacyGuaranteeRepair({ ...lg, penalty_basis: "full_year_1k_contract", earned_to_date: null }).result, "noop_already_clear");
});

// ═════════════════════════════════════ 5. the backfill tool ═════════════════════════════════════
function buildDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE src_adddrop (season INTEGER, txn_index INTEGER, player_id TEXT, move_type TEXT, franchise_id TEXT, franchise_name TEXT, method TEXT, salary INTEGER, unix_timestamp INTEGER, datetime_et TEXT);
    CREATE TABLE src_trades (row_id INTEGER PRIMARY KEY AUTOINCREMENT, transactionid TEXT, season INTEGER, txn_index INTEGER, trade_group_id TEXT, franchise_id TEXT, franchise_name TEXT, asset_role TEXT, asset_type TEXT, player_id TEXT, player_name TEXT, comments TEXT, unix_timestamp INTEGER, datetime_et TEXT);
    CREATE TABLE src_contracts (season INTEGER, player_id TEXT, franchise_id TEXT, team_name TEXT, salary INTEGER, contract_year INTEGER, contract_length INTEGER, contract_status TEXT, contract_info TEXT);
    CREATE TABLE src_players (season INTEGER, player_id TEXT, name TEXT);
    CREATE TABLE src_franchises (season INTEGER, franchise_id TEXT, owner_name TEXT, team_name TEXT);
    CREATE TABLE ups_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, mfl_txn_id TEXT, league_id TEXT, season TEXT, type TEXT, unix_timestamp INTEGER, franchise_id TEXT, franchise_id2 TEXT, added_players TEXT, dropped_players TEXT, raw_json TEXT);
    CREATE TABLE ups_add_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, player_id TEXT, player_name TEXT, franchise_id TEXT, acquired_at_unix INTEGER, source TEXT, contract_annotated INTEGER, annotated_at_utc TEXT, notes TEXT);
    CREATE TABLE mfl_historical_transactions (season INTEGER, txn_uid TEXT, type TEXT, ts_unix INTEGER, ts_iso TEXT, franchise_id TEXT, player_in_id TEXT, player_out_id TEXT, salary INTEGER, source TEXT, raw_payload TEXT);
    CREATE TABLE ups_contract_gate_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, season TEXT, field TEXT NOT NULL, before_val TEXT, after_val TEXT, actor TEXT, note TEXT);
    CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT DEFAULT '74598', player_id TEXT, player_name TEXT, franchise_id TEXT, franchise_name TEXT, dropped_at_unix INTEGER, dropped_at_iso TEXT, pre_drop_contract_length INTEGER, pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER DEFAULT 0, penalty_exempt_reason TEXT, applies_to_season INTEGER, discord_posted INTEGER, notes TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER, earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER, posted_to_mfl INTEGER, posted_amount INTEGER);
    CREATE TABLE salary_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts TEXT, season TEXT, dry_run INTEGER, player_id TEXT, before_salary TEXT, before_contract_status TEXT, before_contract_year TEXT, before_contract_info TEXT, after_salary TEXT, after_contract_status TEXT, after_contract_year TEXT, after_contract_info TEXT, landed INTEGER, endpoint TEXT);
    CREATE TABLE ups_auction_contract_finalizations (player_id TEXT, season TEXT, winner_fid TEXT, source TEXT, salary INTEGER, contract_status TEXT, contract_info TEXT, finalized_at_unix INTEGER);
    CREATE TABLE player_acquisition_cycles (season INTEGER, player_id TEXT, franchise_id TEXT, acquisition_path TEXT, acquisition_date TEXT, salary_at_acquisition_usd INTEGER, contract_years_at_acquisition INTEGER, contract_type_at_acquisition TEXT);
  `);
  const H = 1700000000;   // 2023-11
  const add = (season, idx, pid, fid, method, ts, mt = "ADD") => db.prepare("INSERT INTO src_adddrop VALUES (?,?,?,?,?,?,?,?,?,?)").run(season, idx, pid, mt, fid, "T" + fid, method, mt === "ADD" ? 1000 : null, ts, "");
  const sc = (season, pid, sal, st, yr, info, fid = "0001") => db.prepare("INSERT INTO src_contracts VALUES (?,?,?,?,?,?,?,?,?)").run(season, pid, fid, "T", sal, yr, yr, st, info);
  // 2024 history
  add(2024, 1, "9001", "0001", "FREE_AGENT", H); sc(2024, "9001", 1000, "WW", 1, "");                           // A retained, correct for its era
  add(2024, 2, "9002", "0002", "FREE_AGENT", H); add(2024, 3, "9002", "0002", "FREE_AGENT", H + 86400, "DROP");    // B dropped
  add(2024, 4, "9003", "0003", "FREE_AGENT", H); db.prepare("INSERT INTO src_trades (season, transactionid, franchise_id, asset_role, asset_type, player_id, unix_timestamp) VALUES (2024,'t1','0003','RELINQUISH','PLAYER','9003',?)").run(H + 86400); sc(2024, "9003", 1000, "WW", 1, "", "0009"); // C traded, contract traveled
  add(2024, 5, "9004", "0004", "FREE_AGENT", H); add(2024, 6, "9004", "0004", "FREE_AGENT", H + 86400, "DROP"); add(2024, 7, "9004", "0006", "BBID", H + 2 * 86400); sc(2024, "9004", 5000, "WW", 1, "", "0006"); // D dropped, REACQUIRED via BBID
  add(2024, 8, "9005", "0005", "FREE_AGENT", H); add(2024, 9, "9005", "0007", "BBID", H + 86400); sc(2024, "9005", 9000, "WW", 1, "", "0007");                                          // E replaced by a later acquisition
  add(2024, 10, "9006", "0006", "FREE_AGENT", H); sc(2024, "9006", 0, "", 0, "");                                                                                                       // F retained, blank at season end
  add(2024, 11, "9007", "0007", "FREE_AGENT", H); add(2024, 12, "9007", "0007", "FREE_AGENT", H + 86400, "DROP"); add(2024, 13, "9007", "0007", "FREE_AGENT", H + 2 * 86400); sc(2024, "9007", 1000, "WW", 1, "", "0007"); // G two periods
  // zero-contract periods (an explicit $0 season-end row): dropped → transaction-proven · replaced → superseded · retained (dual evidence) → conflicting · retained in a D1-only season → insufficient · traded → conflicting
  add(2024, 20, "9008", "0008", "FREE_AGENT", H); add(2024, 21, "9008", "0008", "FREE_AGENT", H + 86400, "DROP"); sc(2024, "9008", 0, "", 0, "");                           // Z1 dropped
  add(2024, 22, "9009", "0009", "FREE_AGENT", H); add(2024, 23, "9009", "0003", "BBID", H + 86400); sc(2024, "9009", 0, "", 0, "");                                           // Z2 replaced by a later BBID
  add(2024, 24, "9014", "0004", "FREE_AGENT", H); db.prepare("INSERT INTO src_trades (season, transactionid, franchise_id, asset_role, asset_type, player_id, unix_timestamp) VALUES (2024,'t9','0004','RELINQUISH','PLAYER','9014',?)").run(H + 86400); sc(2024, "9014", 0, "", 0, "", "0005"); // Z4 traded
  add(2011, 1, "9010", "0002", "FREE_AGENT", 1320000000); sc(2011, "9010", 0, "", 0, "");                                                                                      // Z3 2011: MFL has no data for it
  // the second ledger: one add ONLY mfl_historical_transactions proves (its own period), one it merely corroborates (A / 9001 — no new period)
  const hx = (season, uid, ts, fid, pid) => db.prepare("INSERT INTO mfl_historical_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(season, uid, "FREE_AGENT", ts, "", fid, pid, null, null, "mfl", "{}");
  hx(2011, "h-only", 1320500000, "0005", "9020"); hx(2024, "h-corroborates", H + 3600, "0001", "9001");
  db.prepare("INSERT INTO mfl_historical_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(2011, "h-drop", "FREE_AGENT", 1320600000, "", "0005", "", "9020", null, "mfl", "{}");   // the DROP half: only this ledger records it
  sc(2011, "9020", 0, "", 0, "");                                                                                                                                               // its season-end contract row: reachable ONLY through the union
  hx(2011, "h-nostamp", null, "0006", "9021");                                                                                                                                  // an add with NO timestamp proves no period
  // closed-season anomalies (a season-end contract at another price): the Braverman shape (same franchise dropped him minutes before), the R. Jones shape (the row is another franchise's), one the ledger cannot explain
  add(2017, 1, "9011", "0004", "FREE_AGENT", H - 486, "DROP"); add(2017, 2, "9011", "0004", "FREE_AGENT", H); sc(2017, "9011", 2000, "ROOKIE", 2, "", "0004");                       // B1
  add(2018, 1, "9012", "0006", "FREE_AGENT", H - 900000, "DROP"); add(2018, 2, "9012", "0008", "FREE_AGENT", H); sc(2018, "9012", 4000, "Restructure", 2, "[$4K, $1K]", "0006"); sc(2019, "9012", 1000, "WW", 1, "", "0008"); // J1
  add(2018, 3, "9013", "0007", "FREE_AGENT", H); sc(2018, "9013", 3000, "Veteran", 1, "", "0007");                                                                              // U1 unexplained
  for (let f = 1; f <= 9; f += 1) db.prepare("INSERT INTO src_franchises VALUES (2024, ?, ?, ?)").run("000" + f, "Owner " + f, "Team " + f);
  // 2026 (the live season)
  const T = 1789916862;
  const tx = (type, ts, fid, added, dropped, raw) => db.prepare("INSERT INTO ups_transactions (mfl_txn_id, season, type, unix_timestamp, franchise_id, added_players, dropped_players, raw_json) VALUES (?,?,?,?,?,?,?,?)").run(`2026:${type}:${ts}:${fid}:${added}|${dropped}`, "2026", type, ts, fid, added, dropped, raw || null);
  tx("FREE_AGENT", T, "0004", "16001,", "");                 // P1 blank + rostered  → stamp
  tx("FREE_AGENT", T + 10, "0005", "16002,", "");            // P2 already stamped  → nothing
  tx("FREE_AGENT", T + 20, "0004", "16003,", "");            // P3 dropped before stamp, drop unpriced → reprice
  tx("BBID_WAIVER", T + 900000, "0004", "", "16003,");
  tx("FREE_AGENT", T + 30, "0006", "16004,", "");            // P4 a described MYM contract → never overwritten
  tx("FREE_AGENT", T + 40, "0007", "16005,", "");            // P5 traded away, blank → manual review
  tx("TRADE", T + 500000, "0007", "", "", JSON.stringify({ franchise: "0007", franchise2: "0008", franchise1_gave_up: "16005,", franchise2_gave_up: "FP_0008_2027_5," }));
  tx("FREE_AGENT", T + 50, "0009", "16006,", "");            // P6 dropped, priced properly, but a weekly earned was stored
  tx("FREE_AGENT", T + 700000, "0009", "", "16006,");
  tx("FREE_AGENT", T + 60, "0010", "16007,", "");            // P7 canonical on MFL, rostered by the acquirer, add event still refused → the stamper's reconcile step closes it
  tx("FREE_AGENT", T + 70, "0011", "16008,", "");            // P8 (Watson-shaped) the canonical contract was STAMPED, then its owner converted it (MYM) → the cron can never close it; the audited step closes it as 2
  const nm = (pid, n, fid = "0004", ts = T) => db.prepare("INSERT INTO ups_add_events (season, player_id, player_name, franchise_id, acquired_at_unix, source, contract_annotated) VALUES ('2026',?,?,?,?, 'fcfs', 3)").run(pid, n, fid, ts);
  nm("16001", "Blank Pickup"); nm("16002", "Stamped Pickup"); nm("16003", "Dropped Unstamped"); nm("16007", "Canonical Pickup", "0010", T + 60); nm("16008", "Converted Pickup", "0011", T + 70);
  db.prepare("INSERT INTO ups_drop_events (season, player_id, player_name, franchise_id, dropped_at_unix, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_info, pre_drop_tcv, earned_to_date, penalty_amount, penalty_basis, penalty_exempt, posted_to_mfl) VALUES ('2026','16003','Dropped Unstamped','0004',?,NULL,0,NULL,NULL,NULL,0,0,'contract_unstamped_needs_review',0,0)").run(T + 900000);
  db.prepare("INSERT INTO ups_drop_events (season, player_id, player_name, franchise_id, dropped_at_unix, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_info, pre_drop_tcv, earned_to_date, penalty_amount, penalty_basis, penalty_exempt, posted_to_mfl) VALUES ('2026','16006','P6','0009',?,'Vet-WW',1000,1,'CL 1| TCV 1K| AAV 1K',1000,118,0,'ww_under_5k_exempt',1,0)").run(T + 700000);
  db.prepare("INSERT INTO salary_change_log (created_ts, season, dry_run, player_id, after_salary, after_contract_status, after_contract_year, after_contract_info, landed, endpoint) VALUES (?, '2026', 0, '16002', '1000','Vet-WW','1','CL 1| TCV 1K| AAV 1K', 1, '/admin/import-salaries')").run(new Date((T + 100) * 1000).toISOString());
  db.prepare("INSERT INTO player_acquisition_cycles VALUES (2024, '9001', '0001', 'fcfs', ?, NULL, NULL, 'ww')").run(new Date(H * 1000).toISOString());
  const chg = (ts, before, after, ep) => db.prepare("INSERT INTO salary_change_log (created_ts, season, dry_run, player_id, before_salary, before_contract_status, before_contract_year, before_contract_info, after_salary, after_contract_status, after_contract_year, after_contract_info, landed, endpoint) VALUES (?, '2026', 0, '16008', ?,?,?,?, ?,?,?,?, 1, ?)")
    .run(new Date(ts * 1000).toISOString(), before && before[0], before && before[1], before && before[2], before && before[3], after[0], after[1], after[2], after[3], ep);
  chg(T + 200, null, ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], "/admin/import-salaries");                                                                        // the canonical stamp LANDED
  chg(T + 90000, ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], ["1000", "Vet-MYM", "3", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K"], "/offer-mym");           // …and the owner converted it
  return db;
}
function makeIo(db) {
  const mflState = {
    salaries: { 16001: { salary: "", contractStatus: "", contractYear: "", contractInfo: "" }, 16007: { ...CANON }, 16008: { salary: "1000", contractStatus: "Vet-MYM", contractYear: "3", contractInfo: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K" }, 16002: { ...CANON }, 16004: { salary: "1000", contractStatus: "Vet-MYM", contractYear: "2", contractInfo: "CL 2| TCV 2K| AAV 1K" }, 16005: { salary: "", contractStatus: "", contractYear: "", contractInfo: "" } },
    rosters: { "0004": ["16001"], "0005": ["16002"], "0006": ["16004"], "0008": ["16005"], "0010": ["16007"], "0011": ["16008"] },
  };
  const log = { posts: [], d1: [] };
  return {
    log, mflState,
    async d1(sql) { if (!/^\s*SELECT\b/i.test(sql)) throw new Error("write attempted through the read-only channel: " + sql.slice(0, 60)); log.d1.push(sql.slice(0, 40)); return db.prepare(sql).all(); },
    async mfl(year, type) {
      if (type === "salaries") return { salaries: { leagueUnit: { player: Object.entries(mflState.salaries).map(([id, v]) => ({ id, ...v })) } } };
      if (type === "rosters") return { rosters: { franchise: Object.entries(mflState.rosters).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p, status: "ROSTER" })) })) } };
      if (type === "transactions") return { transactions: { transaction: [] } };
      return {};
    },
    async post(p, body, key) {
      log.posts.push({ p, body, key });
      if (p.startsWith("/admin/import-salaries")) { for (const r of body.rows) mflState.salaries[r.id] = { salary: r.salary, contractStatus: r.contractStatus, contractYear: r.contractYear, contractInfo: r.contractInfo }; return { status: 200, body: { ok: true } }; }
      if (p.startsWith("/admin/drops/full-year-repair")) {
        const results = body.actions.map((a) => {
          if (a.kind === "close_fcfs_add_event") {
            const ev = db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(a.id);
            if (!ev) return { kind: a.kind, id: a.id, result: "not_found" };
            const dr = db.prepare("SELECT * FROM ups_drop_events WHERE season='2026' AND player_id = ? AND franchise_id = ? AND dropped_at_unix >= ? ORDER BY dropped_at_unix LIMIT 1").get(ev.player_id, ev.franchise_id, ev.acquired_at_unix) || null;
            const audits = dr ? db.prepare("SELECT id, note FROM ups_contract_gate_audit WHERE field = 'fcfs_reprice_unstamped_drop' AND note LIKE ?").all(`drop_event_id=${dr.id} %`) : [];
            const log = dr ? [] : db.prepare("SELECT * FROM salary_change_log WHERE season='2026' AND dry_run=0 AND landed=1 AND player_id = ? ORDER BY id").all(ev.player_id);
            const plan = FC.planFcfsAddEventClosure({ addEvent: { ...ev, season: "2026", source: "fcfs" }, dropRow: dr, auditRows: audits, changeLog: log });
            if (!plan.ok) return { kind: a.kind, id: a.id, result: plan.result };
            db.prepare("UPDATE ups_add_events SET contract_annotated = ?, annotated_at_utc = 'x', notes = ? WHERE id = ?").run(plan.after.contract_annotated, plan.after.notes, a.id); return { kind: a.kind, id: a.id, result: "applied" };
          }
          const row = db.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(a.id);
          if (a.kind === "reprice_unstamped_fcfs_drop") { if (row.penalty_basis !== "contract_unstamped_needs_review") return { kind: a.kind, id: a.id, result: "noop_already_repriced" }; db.prepare("UPDATE ups_drop_events SET pre_drop_contract_status='Vet-WW', pre_drop_salary=1000, pre_drop_contract_year=1, pre_drop_contract_info='CL 1| TCV 1K| AAV 1K', pre_drop_tcv=1000, earned_to_date=NULL, penalty_basis='ww_under_5k_exempt' WHERE id=?").run(a.id); db.prepare("INSERT INTO ups_contract_gate_audit (at_utc, season, field, before_val, after_val, actor, note) VALUES ('t','2026','fcfs_reprice_unstamped_drop','{}','{}','x',?)").run(`drop_event_id=${a.id} player=${row.player_id} unchanged={}`); return { kind: a.kind, id: a.id, result: "applied" }; }
          if (row.earned_to_date == null) return { kind: a.kind, id: a.id, result: "noop_already_clear" };
          db.prepare("UPDATE ups_drop_events SET earned_to_date=NULL WHERE id=?").run(a.id); return { kind: a.kind, id: a.id, result: "applied" };
        });
        return { status: 200, body: { ok: true, results } };
      }
      return { status: 404, body: null };
    },
  };
}
const snapshot = (db) => JSON.stringify(["src_adddrop", "src_contracts", "ups_drop_events", "ups_add_events", "salary_change_log", "ups_auction_contract_finalizations", "player_acquisition_cycles", "mfl_historical_transactions", "ups_contract_gate_audit"].map((n) => db.prepare(`SELECT * FROM ${n}`).all()));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fcfs-tool-"));

test("TOOL: the inventory — one row per FCFS acquisition period, bucketed active / dropped / traded / reacquired / replaced / multi-period, protected against replacement", async () => {
  const db = buildDb(), io = makeIo(db);
  const out = await TOOL.run(["--out", tmp()], { io, log: () => {} });
  const rows = out.rows; const pick = (season, pid, i = 0) => rows.filter((r) => r.season === season && r.player_id === pid)[i];
  t.equal(rows.filter((r) => r.season === 2024).length, 11, "A B C D E F + G twice + the zero-period fixtures Z1 Z2 Z4"); t.equal(rows.filter((r) => r.season === 2026).length, 8);
  t.equal(pick(2024, "9001").bucket, "retained"); t.equal(pick(2024, "9001").category, "historical_unchanged", "correct for its era");
  t.equal(pick(2024, "9002").bucket, "dropped_during_season"); t.equal(pick(2024, "9002").drop_date !== "", true);
  t.equal(pick(2024, "9003").bucket, "traded_under_fcfs_contract"); t.equal(pick(2024, "9003").category, "historical_unchanged", "the $1K contract traveled with the player");
  t.equal(pick(2024, "9004").bucket, "dropped_during_season+reacquired"); t.equal(pick(2024, "9004").reacquired_date !== "", true); t.equal(pick(2024, "9004").category, "historical_unchanged", "the later $5K BBID contract is NOT this period's");
  t.equal(pick(2024, "9005").bucket, "replaced_by_later_event"); t.equal(pick(2024, "9005").later_replacement.kind, "add_bbid"); t.equal(pick(2024, "9005").category, "historical_unchanged", "replacement contract is protected");
  t.equal(pick(2024, "9006").category, "manual_review"); t.equal(pick(2024, "9006").review_class, "closed_season_unverifiable"); t.equal(pick(2024, "9006").auto_correctable, false, "closed seasons are never auto-written");
  t.equal(pick(2024, "9007", 0).multi_period, true); t.equal(pick(2024, "9007", 1).bucket, "retained+reacquired"); t.equal(pick(2024, "9007", 0).bucket, "dropped_during_season+reacquired", "each acquisition period is its own row");
  t.equal(pick(2024, "9001").derived_regen_needed, true, "the acquisition-cycle ledger has no $1,000 / 1-year for this FCFS cycle");
  t.equal(pick(2024, "9001").owner, "Owner 1", "season-correct owner"); t.equal(pick(2024, "9001").team, "Team 1");
  // 2026
  t.equal(pick(2026, "16001").category, "mfl_correction"); t.equal(pick(2026, "16001").classification, "blank"); t.equal(pick(2026, "16001").auto_correctable, true);
  t.equal(pick(2026, "16002").category, "historical_unchanged"); t.equal(pick(2026, "16002").already_corrected, true, "already corrected — no second write"); t.equal(pick(2026, "16002").stamped_by.salary_change_log_id, 1);
  t.equal(pick(2026, "16003").category, "d1_correction"); t.equal(pick(2026, "16003").action, "reprice_unstamped_fcfs_drop"); t.equal(pick(2026, "16003").bucket, "dropped_during_season");
  t.equal(pick(2026, "16004").category, "historical_unchanged"); t.equal(pick(2026, "16004").bucket, "replaced_by_later_event"); t.match(pick(2026, "16004").reason, /never overwritten/, "an owner's MYM contract is a replacement contract — protected");
  t.equal(pick(2026, "16005").bucket, "traded_under_fcfs_contract"); t.equal(pick(2026, "16005").category, "manual_review");
  t.deepEqual(out.plan.map((a) => `${a.kind}:${a.player_id}`).sort(), ["close_fcfs_add_event:16003", "close_fcfs_add_event:16008", "mfl_stamp:16001", "reprice_unstamped_fcfs_drop:16003"], "exactly the four intended actions — no blanket update (the earned clean-up is scripts/full_year_earned_repair.mjs)");
  t.equal(out.summary.total, 24); t.equal(out.summary.blank, 3, "P1 (active), P3 (dropped) and P5 (traded) — only P1 is an active blank");
  t.equal(out.summary.active_affected, 1, "one active FCFS period needs a correction (the MYM one does not)"); t.equal(out.summary.correct >= 3, true);
});
test("TOOL: DRY RUN is the default — nothing is written anywhere (D1 or MFL), the before-state and the proposed after-state are exported", async () => {
  const db = buildDb(), io = makeIo(db), before = snapshot(db), mflBefore = JSON.stringify(io.mflState), dir = tmp();
  const out = await TOOL.run(["--out", dir], { io, log: () => {} });
  t.equal(out.report.mode, "dry_run"); t.equal(io.log.posts.length, 0, "no POST of any kind"); t.equal(snapshot(db), before, "D1 unchanged"); t.equal(JSON.stringify(io.mflState), mflBefore, "MFL unchanged");
  for (const f of ["inventory.json", "inventory.csv", "plan_proposed_after_state.json", "report.json"]) t.ok(fs.existsSync(path.join(dir, f)), f);
  t.ok(fs.existsSync(path.join(dir, "dataset_before_state", "histAdds.json")), "the before-state export");
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan_proposed_after_state.json"), "utf8")); t.equal(plan.find((a) => a.kind === "mfl_stamp").after.contractInfo, "CL 1| TCV 1K| AAV 1K");
  t.match(fs.readFileSync(path.join(dir, "inventory.csv"), "utf8"), /^season,transaction_id,acquired_at,player_id/);
});
// the reviewed dry run an --apply is bound to: run the dry run, keep its plan_proposed_after_state.json, hand it to --apply
const reviewedPlan = async (io) => { const d = tmp(); await TOOL.run(["--out", d], { io, log: () => {} }); return path.join(d, "plan_proposed_after_state.json"); };
test("TOOL: apply is EXPLICIT (--apply --yes --season, the current season only, a key in the environment); it touches only the intended records", async () => {
  for (const argv of [["--apply"], ["--apply", "--yes"], ["--apply", "--season", "2026"]]) { let e = null; try { await TOOL.run([...argv, "--out", tmp()], { io: makeIo(buildDb()), log: () => {}, env: {} }); } catch (x) { e = x; } t.ok(e && /--apply needs --yes and an explicit --season/.test(e.message), argv.join(" ")); }
  { let e = null; try { await TOOL.run(["--apply", "--yes", "--season", "2024", "--out", tmp()], { io: makeIo(buildDb()), log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } }); } catch (x) { e = x; } t.ok(e && /only permitted for the current season/.test(e.message), "a closed season is never written"); }
  { const io0 = makeIo(buildDb()); const plan0 = await reviewedPlan(io0); let e = null; try { await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", plan0, "--out", tmp()], { io: io0, log: () => {}, env: {} }); } catch (x) { e = x; } t.ok(e && /UPS_COMMISH_API_KEY/.test(e.message), "no key, no write"); t.equal(io0.log.posts.length, 0); }
  { let e = null; try { await TOOL.run(["--apply", "--yes", "--season", "2026", "--out", tmp()], { io: makeIo(buildDb()), log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } }); } catch (x) { e = x; } t.ok(e && /--apply needs --plan/.test(e.message), "an apply without a reviewed plan is refused"); }
  const db = buildDb(), io = makeIo(db), plan1 = await reviewedPlan(io);
  const out = await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", plan1, "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "test-key" } });
  t.equal(out.report.plan_bound_to, plan1);
  t.deepEqual(out.report.applied.map((a) => `${a.kind}:${a.player_id}:${a.result}`).sort(), ["close_fcfs_add_event:16003:applied", "close_fcfs_add_event:16008:applied", "mfl_stamp:16001:applied_verified", "reprice_unstamped_fcfs_drop:16003:applied"]);
  t.equal(io.log.posts.length, 4, "one MFL import + the drop repair + the two add-event closures — nothing else");
  t.deepEqual(io.log.posts.filter((p) => p.p.startsWith("/admin/import-salaries")).map((p) => p.body.rows.map((r) => r.id)), [["16001"]], "MFL: only the blank FCFS contract, through the existing commissioner import path");
  t.deepEqual(io.mflState.salaries[16001], CANON, "and it now reads canonical (verified by re-read)");
  t.deepEqual(io.mflState.salaries[16002], CANON, "Franklin-like (already stamped) untouched"); t.equal(io.mflState.salaries[16004].contractStatus, "Vet-MYM", "the owner's MYM contract untouched"); t.equal(io.mflState.salaries[16005].salary, "", "the traded blank is left for a human");
  t.equal(db.prepare("SELECT earned_to_date e FROM ups_drop_events WHERE player_id='16006'").get().e, 118, "this tool never clears earned — that is scripts/full_year_earned_repair.mjs, with its own class proof");
  t.equal(db.prepare("SELECT penalty_basis b FROM ups_drop_events WHERE player_id='16003'").get().b, "ww_under_5k_exempt");
  t.equal(db.prepare("SELECT COUNT(*) n FROM src_contracts").get().n, 15, "closed-season history untouched"); t.equal(db.prepare("SELECT COUNT(*) n FROM src_adddrop").get().n, 24, "…and its event log");
  for (const p of io.log.posts) t.equal(p.key, "test-key");
});
test("TOOL: --apply is BOUND to the reviewed plan — a plan that drifted since the review is refused before anything is sent; rollback.sql is the exact reverse of the D1 reprice", async () => {
  const db = buildDb(), io = makeIo(db); const dir = tmp();
  await TOOL.run(["--out", dir], { io, log: () => {} });
  const planFile = path.join(dir, "plan_proposed_after_state.json"), reviewed = JSON.parse(fs.readFileSync(planFile, "utf8"));
  // (a) the reviewed plan has one more action than the fresh one → refused, nothing sent
  fs.writeFileSync(planFile + ".x", JSON.stringify([...reviewed, { kind: "mfl_stamp", player_id: "99999", franchise_id: "0001", after: {} }]));
  let e = null; try { await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", planFile + ".x", "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } }); } catch (x) { e = x; }
  t.ok(e && /the plan changed since it was reviewed/.test(e.message), String(e && e.message)); t.equal(io.log.posts.length, 0, "nothing was sent");
  // (b) the row changed after the review (the fresh plan's expected before-state differs) → refused
  const reprice = reviewed.find((a) => a.kind === "reprice_unstamped_fcfs_drop");
  db.prepare("UPDATE ups_drop_events SET penalty_amount = 7 WHERE id = ?").run(reprice.id);
  e = null; try { await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", planFile, "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } }); } catch (x) { e = x; }
  t.ok(e && /the plan changed since it was reviewed/.test(e.message), "a changed penalty changes the plan"); t.equal(io.log.posts.length, 0);
  db.prepare("UPDATE ups_drop_events SET penalty_amount = 0 WHERE id = ?").run(reprice.id);
  t.deepEqual(TOOL.planDrift(reviewed, reviewed), { ok: true, added: 0, removed: 0 });
  // rollback.sql: apply, then run the reverse — the row is exactly what it was
  const before = db.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(reprice.id);
  const rb = fs.readFileSync(path.join(dir, "rollback.sql"), "utf8").trim().split("\n"); t.equal(rb.length, 3, "the drop reprice + the two add-event closures"); t.match(rb[0], /^UPDATE ups_drop_events SET pre_drop_contract_status = NULL, /); t.match(rb[1], /^UPDATE ups_add_events SET contract_annotated = 3, /); t.match(rb[0], /WHERE id = \d+ AND penalty_basis = 'ww_under_5k_exempt' AND pre_drop_contract_info = 'CL 1\| TCV 1K\| AAV 1K' AND earned_to_date IS NULL;$/, "guarded on the repair's OWN state");
  await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", planFile, "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } });
  t.equal(db.prepare("SELECT penalty_basis b FROM ups_drop_events WHERE id = ?").get(reprice.id).b, "ww_under_5k_exempt", "applied");
  db.exec(rb[0]);
  t.deepEqual(db.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(reprice.id), before, "the reverse restores every column of the row");
  db.exec(rb[1]); db.exec(rb[2]); t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events WHERE player_id = '16003'").get().c, 3, "…and the add event is back to its refused state");
  t.equal(TOOL.rollbackSql([]), "", "no reprice, no rollback statement"); t.equal(TOOL.rollbackSql([{ kind: "mfl_stamp", player_id: "1" }]), "", "an MFL stamp has no rollback by design");
});
test("TOOL: the SECOND run is a no-op — nothing planned, nothing posted, verification passes (idempotent)", async () => {
  const db = buildDb(), io = makeIo(db);
  const planA = await reviewedPlan(io);
  await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", planA, "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } });
  const posts = io.log.posts.length;
  const planB = await reviewedPlan(io); t.deepEqual(JSON.parse(fs.readFileSync(planB, "utf8")), [], "the reviewed plan is empty");
  const again = await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", planB, "--out", tmp()], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } });
  t.deepEqual(again.plan, [], "nothing left to do"); t.equal(io.log.posts.length, posts, "no further write of any kind");
  const ver = await TOOL.run(["--verify", "--out", tmp()], { io, log: () => {} });
  t.equal(ver.report.verify.ok, true, JSON.stringify(ver.report.verify.failures)); t.equal(ver.plan.length, 0);
  // and verification FAILS while something is still pending
  const fresh = await TOOL.run(["--verify", "--out", tmp()], { io: makeIo(buildDb()), log: () => {} }); t.equal(fresh.report.verify.ok, false); t.match(fresh.report.verify.failures.join(" "), /action\(s\) still pending/);
  // apply's precondition: the row changed since the dry run → not written
  const db2 = buildDb(), io2 = makeIo(db2); const plan = TOOL.buildPlan(TOOL.buildInventory(await TOOL.loadDataset(io2, { cacheDir: tmp() })));
  io2.mflState.rosters["0004"] = []; io2.mflState.rosters["0009"] = ["16001"];       // he changed hands after the dry run
  const res = await TOOL.applyPlan(plan.filter((a) => a.kind === "mfl_stamp"), io2, { key: "k", dryRun: false, season: 2026 });
  t.equal(res[0].result, "precondition_failed"); t.equal(io2.log.posts.length, 0, "no write when the precondition no longer holds");
});
test("TOOL: filters — season · player · franchise · transaction; the read channel refuses anything but SELECT", async () => {
  const db = buildDb(), io = makeIo(db);
  const f = async (a) => (await TOOL.run([...a, "--out", tmp()], { io, log: () => {} })).rows;
  t.equal((await f(["--season", "2026"])).length, 8); t.equal((await f(["--season", "2024"])).length, 11);
  t.deepEqual((await f(["--player", "16001"])).map((r) => r.player_id), ["16001"]); t.equal((await f(["--franchise", "0004"])).every((r) => r.franchise_id === "0004"), true);
  t.equal((await f(["--txn", "16003"])).length >= 1, true);
  const prod = TOOL.productionIo({ base: "http://127.0.0.1:1" }); let e = null; try { await prod.d1("UPDATE ups_drop_events SET penalty_amount = 0"); } catch (x) { e = x; } t.match(String(e && e.message), /read-only/);
  try { e = null; await prod.d1("SELECT 1; DELETE FROM ups_drop_events"); } catch (x) { e = x; } t.match(String(e && e.message), /read-only/);
});
test("TOOL: the production tables' SELECTs are valid SQL over the production column names (every query runs)", async () => {
  const db = buildDb();
  for (const [name, sql] of Object.entries(TOOL.QUERIES)) t.ok(Array.isArray(db.prepare(sql).all()), name);
});

// ═════════════════════════════════════ 5b. the reconciliation report (two ledgers · zero periods · anomalies · add-event closure) ═════════════════════════════════════
test("RULE (zero periods): every zero-contract period ends in exactly one of four classes — the class says what the evidence PROVES, never more", () => {
  const P = (o) => ({ season: 2024, endKind: "held_to_season_end", ...o });
  const dual = { sources: ["src_adddrop", "mfl_historical_transactions"] };
  t.equal(FC.classifyZeroPeriod(P({ endKind: "dropped" }), dual).zero_class, "transaction_proven_fcfs_acquisition");
  t.equal(FC.classifyZeroPeriod(P({ endKind: "replaced", replacementKind: "add_bbid", replacementTs: 5 }), dual).zero_class, "superseded_by_later_valid_contract"); t.match(FC.classifyZeroPeriod(P({ endKind: "replaced", replacementKind: "add_bbid", replacementTs: 5 }), dual).reason, /add_bbid/);
  t.equal(FC.classifyZeroPeriod(P({}), dual).zero_class, "conflicting_historical_evidence", "held at season end + an explicit $0 row: two sources disagree");
  t.equal(FC.classifyZeroPeriod(P({ endKind: "traded" }), dual).zero_class, "conflicting_historical_evidence");
  // no MFL data to corroborate (2011 / 2012), or an add only the second ledger proves → insufficient, never 'conflicting'
  t.equal(FC.classifyZeroPeriod(P({ season: 2011 }), dual).zero_class, "insufficient_source_evidence"); t.equal(FC.classifyZeroPeriod(P({ season: 2012, endKind: "traded" }), dual).zero_class, "insufficient_source_evidence");
  t.equal(FC.classifyZeroPeriod(P({}), { sources: ["mfl_historical_transactions"] }).zero_class, "insufficient_source_evidence");
  t.equal(FC.classifyZeroPeriod(P({ season: 2011, endKind: "dropped" }), dual).zero_class, "transaction_proven_fcfs_acquisition", "a drop the D1 ledger proves is proven whatever the grade");
  t.equal(FC.classifyZeroPeriod(P({ season: 2011, endKind: "dropped" }), dual).evidence_grade, "d1_ledger_only_not_corroborated_by_mfl"); t.equal(FC.classifyZeroPeriod(P({ endKind: "dropped" }), dual).evidence_grade, "d1_ledger");
  t.deepEqual([...FC.D1_ONLY_EVIDENCE_SEASONS], [2011, 2012]); t.deepEqual(Object.values(FC.ZERO_CLASS).length, 4);
});
test("RULE (anomalies): a season-end contract at another price is EXPLAINED only when the ledger can prove why — a same-franchise re-add, or a stale prior-holder row; anything else stays unexplained", () => {
  const ev = (kind, fid, ts) => ({ kind, fid, ts });
  const P = { season: 2017, fid: "0004", ts: 1000000 };
  const b = FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0004", salary: 2000, contract_status: "ROOKIE", contract_year: 2 }, events: [ev("drop", "0004", 1000000 - 486), ev("add_fcfs", "0004", 1000000)] });
  t.equal(b.explained, true); t.equal(b.explanation_class, "same_franchise_drop_and_readd"); t.equal(b.evidence.gap_seconds, 486); t.equal(b.evidence.season_end_status, "ROOKIE"); t.match(b.conclusion, /486s before/);
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0004" }, events: [ev("drop", "0004", 1000000 - 90000)] }).explained, false, "a drop a day earlier is not a re-add");
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0009", salary: 2000 }, events: [ev("drop", "0004", 1000000 - 60)] }).explanation_class, "unexplained", "a re-add needs the season-end row to be the acquirer's own");
  const j = FC.explainClosedSeasonAnomaly({ season: 2018, fid: "0008", ts: 2000000 }, { contractRow: { franchise_id: "0006", salary: 4000, contract_status: "Restructure" }, nextSeasonRow: { franchise_id: "0008", salary: 1000, contract_status: "WW", contract_year: 1 }, events: [ev("drop", "0006", 1900000), ev("add_fcfs", "0008", 2000000)] });
  t.equal(j.explained, true); t.equal(j.explanation_class, "season_end_row_belongs_to_prior_holder"); t.equal(j.evidence.season_end_row_franchise, "0006"); t.equal(j.evidence.prior_holder_exit_kind, "drop"); t.equal(j.evidence.next_season_names_acquirer, true);
  t.equal(FC.explainClosedSeasonAnomaly({ season: 2018, fid: "0008", ts: 2000000 }, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("add_fcfs", "0008", 2000000)] }).explained, false, "the row's franchise never left him in the ledger → unexplained");
  t.equal(FC.explainClosedSeasonAnomaly({ season: 2018, fid: "0008", ts: 2000000 }, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("trade_out", "0006", 1900000)] }).explanation_class, "season_end_row_belongs_to_prior_holder", "a trade-away counts as an exit too");
  t.equal(FC.explainClosedSeasonAnomaly({ season: 2018, fid: "0007", ts: 5 }, { contractRow: null, events: [] }).explained, false);
});
test("RULE (add-event closure): a dropped player's add event closes ONLY after the drop's own audited repair — canonical pre-drop contract AND its audit row — and it is never called a roster verification", () => {
  const ev = { id: 75, season: "2026", player_id: "14590", franchise_id: "0004", acquired_at_unix: 1000, source: "fcfs", contract_annotated: 3, notes: "refused" };
  const drop = { id: 141, player_id: "14590", franchise_id: "0004", dropped_at_unix: 2000, pre_drop_contract_status: "Vet-WW", pre_drop_salary: 1000, pre_drop_contract_year: 1, pre_drop_contract_info: "CL 1| TCV 1K| AAV 1K" };
  const audit = [{ id: 9, note: "drop_event_id=141 player=14590 unchanged={}" }];
  const ok = FC.planFcfsAddEventClosure({ addEvent: ev, dropRow: drop, auditRows: audit });
  t.equal(ok.ok, true); t.deepEqual(ok.before, { contract_annotated: 3, notes: "refused" }); t.equal(ok.after.contract_annotated, 1); t.equal(ok.after.notes, FC.ADD_EVENT_CLOSE_NOTE(141)); t.match(ok.after.notes, /NOT a roster-verified contract/); t.equal(ok.evidence.roster_verified, false); t.equal(ok.evidence.audit_row_id, 9);
  const refuse = (over, res) => t.equal(FC.planFcfsAddEventClosure({ addEvent: { ...ev, ...(over.ev || {}) }, dropRow: over.drop === null ? null : { ...drop, ...(over.drop || {}) }, auditRows: over.audit === undefined ? audit : over.audit }).result, res, JSON.stringify(over));
  refuse({ drop: null }, "no_drop_of_this_acquisition"); refuse({ audit: [] }, "no_audited_drop_repair"); refuse({ audit: [{ id: 3, note: "drop_event_id=1410 x" }] }, "no_audited_drop_repair");
  refuse({ drop: { pre_drop_contract_status: null, pre_drop_salary: 0, pre_drop_contract_year: null, pre_drop_contract_info: null } }, "drop_contract_not_canonical"); refuse({ drop: { pre_drop_salary: 2000, pre_drop_contract_info: "CL 1| TCV 2K| AAV 2K" } }, "drop_contract_not_canonical");
  refuse({ drop: { franchise_id: "0005" } }, "drop_not_of_this_acquisition"); refuse({ drop: { player_id: "1" } }, "drop_not_of_this_acquisition"); refuse({ drop: { dropped_at_unix: 999 } }, "drop_not_of_this_acquisition", "a drop BEFORE the acquisition");
  refuse({ ev: { contract_annotated: 1 } }, "noop_already_closed"); refuse({ ev: { contract_annotated: 2 } }, "not_open"); refuse({ ev: { source: "bbid" } }, "not_an_fcfs_add_event");
  t.equal(FC.planFcfsAddEventClosure({ addEvent: { ...ev, contract_annotated: 0 }, dropRow: drop, auditRows: audit }).ok, true, "a pending (0) event closes too");
});
test("REPAIR (close_fcfs_add_event): dry run by default; refused until the drop repair landed; then one audited write that changes only the add event — never MFL, never the drop", async () => {
  const { env, mfl, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004");
  const ev = db.prepare("SELECT * FROM ups_add_events").get(); const dropId = seedDrop(db, { pid: "14590", fid: "0004" });                                 // the drop is unstamped (Al-Shaair)
  const dropBefore = rowOf2(db, dropId);
  const close = (dry, expect) => repair(env, [{ kind: "close_fcfs_add_event", id: ev.id, ...(expect === null ? {} : { expect: expect || { contract_annotated: 3 } }) }], dry);
  t.equal((await close(undefined)).json.results[0].result, "drop_contract_not_canonical", "the drop's own contract is still blank: run the drop repair first");
  t.equal((await close(false)).json.results[0].result, "drop_contract_not_canonical", "…and a real call is refused too");
  // the drop repair lands (through the SAME audited route)
  t.equal((await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id: dropId, expect: EXP_UNSTAMPED(0) }], false)).json.results[0].result, "applied");
  const evBefore = db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id), dropAfterRepair = rowOf2(db, dropId), auditBefore = db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n;
  const dry = (await close(undefined)).json.results[0];
  t.equal(dry.result, "would_apply"); t.equal(dry.before.contract_annotated, 3); t.equal(dry.after.contract_annotated, 1); t.equal(dry.evidence.roster_verified, false); t.equal(dry.evidence.drop_event_id, dropId); t.match(dry.after.notes, /settled_by_drop_repair/);
  t.deepEqual(db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id), evBefore, "dry run wrote nothing");
  t.equal((await close(false, null)).json.results[0].result, "expectation_required", "a real write needs the dry run's expectation");
  t.equal((await close(false, { contract_annotated: 0 })).json.results[0].result, "precondition_failed", "a stale expectation is refused");
  const live = (await close(false)).json.results[0]; t.equal(live.result, "applied");
  const evAfter = db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id);
  t.deepEqual(changedCols(evBefore, evAfter), ["annotated_at_utc", "contract_annotated", "notes"], "the add event changes exactly these three columns"); t.equal(evAfter.contract_annotated, 1); t.match(evAfter.notes, /NOT a roster-verified contract/);
  t.deepEqual(rowOf2(db, dropId), dropAfterRepair, "the drop record is untouched by the closure"); t.equal(mfl.writes("salaries").length, 0, "nothing was written to MFL");
  const audit = db.prepare("SELECT * FROM ups_contract_gate_audit WHERE field = 'fcfs_add_event_closed_by_drop_repair'").all(); t.equal(audit.length, 1); t.match(audit[0].note, /add_event_id=\d+ drop_event_id=\d+ audit_row=\d+ player=14590 roster_verified=false/); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, auditBefore + 1);
  // idempotent
  const snap2 = JSON.stringify([db.prepare("SELECT * FROM ups_add_events").all(), db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get()]);
  t.equal((await close(false)).json.results[0].result, "noop_already_closed"); t.equal(JSON.stringify([db.prepare("SELECT * FROM ups_add_events").all(), db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get()]), snap2, "second run: zero changes");
});
test("REPAIR (close_fcfs_add_event): refused when the canonical contract did NOT arrive through the audited repair, for another franchise's drop, for a described (skipped) event, or a missing id — and two concurrent applies close it exactly once", async () => {
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const ev = db.prepare("SELECT id FROM ups_add_events").get();
    // canonical pre-drop contract on the drop row, but NO audit row (someone edited D1 by hand) → not closed
    seedDrop(db, { pid: "14590", fid: "0004", status: "Vet-WW", salary: 1000, cy: 1, cl: 1, info: "CL 1| TCV 1K| AAV 1K", tcv: 1000, basis: "ww_under_5k_exempt", exempt: 1 });
    const r = (await repair(env, [{ kind: "close_fcfs_add_event", id: ev.id, expect: { contract_annotated: 3 } }], false)).json.results[0]; t.equal(r.result, "no_audited_drop_repair"); t.match(r.detail, /did not arrive through the audited repair/); t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events").get().c, 3); }
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const ev = db.prepare("SELECT id FROM ups_add_events").get();
    seedDrop(db, { pid: "14590", fid: "0005" });                                                                                        // a DIFFERENT franchise's drop of the same player
    t.equal((await repair(env, [{ kind: "close_fcfs_add_event", id: ev.id, expect: { contract_annotated: 3 } }], false)).json.results[0].result, "no_drop_of_this_acquisition"); }
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); db.prepare("UPDATE ups_add_events SET contract_annotated = 2").run(); const ev = db.prepare("SELECT id FROM ups_add_events").get(); seedDrop(db, { pid: "14590", fid: "0004" });
    t.equal((await repair(env, [{ kind: "close_fcfs_add_event", id: ev.id, expect: { contract_annotated: 2 } }], false)).json.results[0].result, "not_open", "a described / converted contract is never reverted or re-closed");
    t.equal((await repair(env, [{ kind: "close_fcfs_add_event", id: 99999, expect: { contract_annotated: 3 } }], false)).json.results[0].result, "not_found"); }
  { const { env, db } = fcfsWorld(); seedAddEvent(db, "14590", "0004"); const ev = db.prepare("SELECT id FROM ups_add_events").get(); const dropId = seedDrop(db, { pid: "14590", fid: "0004" });
    await repair(env, [{ kind: "reprice_unstamped_fcfs_drop", id: dropId, expect: EXP_UNSTAMPED(0) }], false);
    const act = [{ kind: "close_fcfs_add_event", id: ev.id, expect: { contract_annotated: 3 } }];
    const [x, y] = await Promise.all([repair(env, act, false), repair(env, act, false)]); const results = [x.json.results[0].result, y.json.results[0].result].sort();
    t.deepEqual(results, ["applied", "noop_changed_concurrently"], "the loser meets the UPDATE guard — not a transaction collision"); t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field = 'fcfs_add_event_closed_by_drop_repair'").get().n, 1, "one audit row, exactly when the change landed"); }
});
test("RULE (add-event closure, path B): a canonical stamp that LANDED and was then converted by its owner closes the event as 2 — never a revert, never a roster verification; anything less is refused", () => {
  const ev = { id: 52, season: "2026", player_id: "13113", franchise_id: "0004", acquired_at_unix: 1789305850, source: "fcfs", contract_annotated: 3, notes: "refused" };
  const iso = (u) => new Date(u * 1000).toISOString();
  const CAN = ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], MYM = ["1000", "Vet-MYM", "3", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K"];
  const row = (id, ts, before, after, ep, over) => ({ id, created_ts: iso(ts), player_id: "13113", endpoint: ep, dry_run: 0, landed: 1, before_salary: before && before[0], before_contract_status: before && before[1], before_contract_year: before && before[2], before_contract_info: before && before[3], after_salary: after[0], after_contract_status: after[1], after_contract_year: after[2], after_contract_info: after[3], ...(over || {}) });
  const chain = [row(1865, 1789305850 + 200000, null, CAN, "/admin/import-salaries"), row(1875, 1789305850 + 900000, CAN, MYM, "/offer-mym")];
  const ok = FC.planFcfsAddEventClosure({ addEvent: ev, dropRow: null, auditRows: [], changeLog: chain });
  t.equal(ok.ok, true); t.equal(ok.path, "owner_conversion"); t.equal(ok.after.contract_annotated, 2); t.equal(ok.after.notes, FC.ADD_EVENT_SUPERSEDED_NOTE(1865, 1875, "/offer-mym", "Vet-MYM")); t.match(ok.after.notes, /never reverted/);
  t.deepEqual({ s: ok.evidence.stamp_log_id, c: ok.evidence.change_log_id, e: ok.evidence.change_endpoint, st: ok.evidence.converted_to.status, rv: ok.evidence.roster_verified }, { s: 1865, c: 1875, e: "/offer-mym", st: "Vet-MYM", rv: false });
  const no = (changeLog, why) => t.equal(FC.planFcfsAddEventClosure({ addEvent: ev, dropRow: null, auditRows: [], changeLog }).ok, false, why);
  no([], "no change log at all"); no([chain[0]], "stamped but never converted — the cron reconcile handles it (MFL still holds the canonical contract)"); no([chain[1]], "a conversion with no landed canonical stamp before it");
  no([row(1865, 1789305850 + 200000, null, CAN, "/admin/import-salaries", { landed: 0 }), chain[1]], "an un-landed stamp is not evidence"); no([row(1865, 1789305850 + 200000, null, CAN, "/admin/import-salaries", { dry_run: 1 }), chain[1]], "a dry run is not evidence");
  no([row(1865, 1789305850 - 86400, null, CAN, "/admin/import-salaries"), chain[1]], "a stamp from BEFORE this acquisition belongs to an earlier one");
  no([chain[0], row(1875, 1789305850 + 900000, ["1000", "Vet-FAA", "1", "CL 1| TCV 1K| AAV 1K"], MYM, "/offer-mym")], "the conversion's before-state is not the canonical contract");
  no([chain[0], row(1875, 1789305850 + 900000, CAN, ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], "/admin/import-salaries")], "a re-stamp of the SAME kind of contract is not a conversion");
  no([chain[0], row(1875, 1789305850 + 900000, CAN, ["", "", "", ""], "/x")], "a blank after-state is not a conversion");
  no([row(1865, 1789305850 + 200000, null, ["2000", "Vet-WW", "1", "CL 1| TCV 2K| AAV 2K"], "/admin/import-salaries"), chain[1]], "a non-canonical stamp is not the canonical contract");
  t.equal(FC.planFcfsAddEventClosure({ addEvent: { ...ev, contract_annotated: 2 }, dropRow: null, auditRows: [], changeLog: chain }).result, "not_open");
  t.equal(FC.planFcfsAddEventClosure({ addEvent: ev, dropRow: { id: 1, player_id: "13113", franchise_id: "0004", dropped_at_unix: 1789305850 + 5, pre_drop_contract_status: null, pre_drop_salary: 0 }, auditRows: [], changeLog: chain }).result, "drop_contract_not_canonical", "a DROPPED player takes path A only — the conversion chain is never a way around the drop repair");
});
test("REPAIR (close_fcfs_add_event, path B): the D1 chain (landed canonical stamp → the owner's landed conversion) closes it as 2 with its own audit row; one column set, MFL untouched, second call a no-op", async () => {
  const { env, mfl, db } = fcfsWorld(); seedAddEvent(db, "13113", "0004"); const ev = db.prepare("SELECT * FROM ups_add_events").get();
  db.exec("CREATE TABLE IF NOT EXISTS ups_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, mfl_txn_id TEXT, league_id TEXT, season TEXT, type TEXT, unix_timestamp INTEGER, franchise_id TEXT, added_players TEXT, dropped_players TEXT, raw_json TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS salary_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts TEXT, endpoint TEXT, season TEXT, league_id TEXT, dry_run INTEGER, player_id TEXT, before_salary TEXT, before_contract_status TEXT, before_contract_year TEXT, before_contract_info TEXT, after_salary TEXT, after_contract_status TEXT, after_contract_year TEXT, after_contract_info TEXT, landed INTEGER)");
  const put = (ts, b, a, ep, league = "74598") => db.prepare("INSERT INTO salary_change_log (created_ts, endpoint, season, league_id, dry_run, player_id, before_salary, before_contract_status, before_contract_year, before_contract_info, after_salary, after_contract_status, after_contract_year, after_contract_info, landed) VALUES (?,?, '2026', ?, 0, '13113', ?,?,?,?, ?,?,?,?, 1)")
    .run(new Date(ts * 1000).toISOString(), ep, league, b && b[0], b && b[1], b && b[2], b && b[3], a[0], a[1], a[2], a[3]);
  const CAN = ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"];
  const close = (dry, expect) => repair(env, [{ kind: "close_fcfs_add_event", id: ev.id, ...(expect === null ? {} : { expect: expect || { contract_annotated: 3 } }) }], dry);
  t.equal((await close(false)).json.results[0].result, "no_drop_of_this_acquisition", "no chain yet");
  put(TS + 200, null, CAN, "/admin/import-salaries");
  t.equal((await close(false)).json.results[0].result, "no_drop_of_this_acquisition", "stamped but not converted: the cron reconcile is the closer (MFL still holds the canonical contract)");
  put(TS + 90000, CAN, ["1000", "Vet-MYM", "3", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K"], "/offer-mym");
  const before = db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id);
  const dry = (await close(undefined)).json.results[0]; t.equal(dry.result, "would_apply"); t.equal(dry.path, "owner_conversion"); t.equal(dry.after.contract_annotated, 2); t.equal(dry.evidence.change_endpoint, "/offer-mym"); t.equal(dry.evidence.roster_verified, false);
  t.deepEqual(db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id), before, "dry run wrote nothing");
  t.equal((await close(false, null)).json.results[0].result, "expectation_required");
  const live = (await close(false)).json.results[0]; t.equal(live.result, "applied");
  const after = db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id); t.deepEqual(changedCols(before, after), ["annotated_at_utc", "contract_annotated", "notes"]); t.equal(after.contract_annotated, 2); t.match(after.notes, /superseded_by_later_owner_contract/);
  const audit = db.prepare("SELECT * FROM ups_contract_gate_audit WHERE field = 'fcfs_add_event_closed_by_owner_conversion'").all(); t.equal(audit.length, 1); t.match(audit[0].note, /stamp_log=\d+ change_log=\d+ endpoint=\/offer-mym player=13113 roster_verified=false/);
  t.equal(mfl.writes("salaries").length, 0, "nothing written to MFL");
  t.equal((await close(false)).json.results[0].result, "not_open", "second call: the event is closed (2) — never re-closed"); t.deepEqual(db.prepare("SELECT * FROM ups_add_events WHERE id = ?").get(ev.id), after, "zero changes");
});
test("REVIEW FIXES (rules): unknown years / NULL evidence is never 'final year' or $0; the $1,000-a-year contract is excluded by PROOF in the WW class; a legacy row with no earned is held; a re-based WW row can still have its earned cleared", () => {
  const base = { pre_drop_contract_status: "Vet-WW", pre_drop_salary: 2000, pre_drop_contract_year: 1, pre_drop_contract_length: 1, pre_drop_contract_info: "CL 1| TCV 2K| AAV 2K", pre_drop_tcv: 2000, pre_drop_years_remaining: 1, pre_drop_taxi: 0,
    earned_to_date: 235, penalty_amount: 0, penalty_basis: "ww_under_5k_exempt", penalty_exempt: 1, posted_to_mfl: 0, posted_amount: null, guaranteed_amount: null, applies_to_season: 2027 };
  t.equal(FC.planWwEarnedNaRepair(base).ok, true, "control");
  // a stored years-remaining of 0 is the scanner's coercion of a blank contractYear — UNKNOWN, never a final year
  for (const o of [{ pre_drop_years_remaining: 0, pre_drop_contract_year: 0 }, { pre_drop_years_remaining: 0, pre_drop_contract_year: null }, { pre_drop_years_remaining: null, pre_drop_contract_year: null }]) t.equal(FC.planWwEarnedNaRepair({ ...base, ...o }).ok, false, JSON.stringify(o));
  const cls = { ...base, pre_drop_salary: 1000, pre_drop_contract_length: 3, pre_drop_contract_year: 2, pre_drop_years_remaining: 2, pre_drop_contract_info: "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K", pre_drop_tcv: 3000, penalty_amount: 1000, penalty_basis: "tcv_under_5k_flat", penalty_exempt: 0, earned_to_date: 1118 };
  t.equal(FC.planFullYearClearRepair(cls).ok, true, "control"); t.equal(FC.planFullYearClearRepair({ ...cls, pre_drop_years_remaining: 0, pre_drop_contract_year: 0 }).result, "conflict_financials_would_change", "unknown years ⇒ the flat rule cannot be evaluated ⇒ held");
  // NULL evidence is not $0 / not 'not taxi'
  t.match(FC.planWwEarnedNaRepair({ ...base, penalty_amount: null }).detail, /penalty_amount is not stored/); t.match(FC.planWwEarnedNaRepair({ ...base, pre_drop_taxi: null }).detail, /pre_drop_taxi is not stored/);
  t.match(FC.planFullYearClearRepair({ ...cls, pre_drop_taxi: null }).detail, /pre_drop_taxi is not stored/); t.match(FC.planFullYearClearRepair({ ...cls, penalty_amount: null }).detail, /penalty_amount is not stored/);
  t.match(FC.planWwEarnedNaRepair({ ...base, posted_to_mfl: 1, posted_amount: null }).detail, /posted to MFL as null vs computed 0/, "a posted row with no posted amount is not a reconciled $0");
  // the class exclusion is decided by the PROOF: a $1,000 one-year WW deal with contradictory tokens is NOT in the full-year class, so it IS an earned-n/a WW deal — for the repair AND the calculator
  const odd = { ...base, pre_drop_salary: 1000, pre_drop_contract_info: "CL 1| TCV 1K| AAV 2K", pre_drop_tcv: 1000, earned_to_date: 59 };
  t.equal(FC.planWwEarnedNaRepair(odd).ok, true); t.deepEqual(FC.classifyWwEarnedNa({ status: "Vet-WW", salary: 1000, tcv: 1000, cl: 1, yearsRemaining: 1, taxi: false, contractInfo: "CL 1| TCV 1K| AAV 2K" }), { member: true, reasons: [] });
  t.deepEqual(FC.classifyWwEarnedNa({ status: "Vet-WW", salary: 1000, tcv: 1000, cl: 1, yearsRemaining: 1, taxi: false, contractInfo: "CL 1| TCV 1K| AAV 1K" }), { member: false, reasons: ["full_year_class"] }, "the genuine $1K deal is the OTHER class");
  t.equal(FC.planWwEarnedNaRepair({ ...base, pre_drop_salary: 1000, pre_drop_contract_info: "CL 1| TCV 1K| AAV 1K", pre_drop_tcv: 1000 }).result, "not_in_ww_earned_na");
  t.equal(drop({ contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 2K", contractYear: "1" }, G2).basis, "ww_under_5k_earned_na", "the calculator agrees with the repair");
  t.equal(drop({ contractStatus: "Vet-WW", salary: 1000, contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" }, G2).basis, "ww_under_5k_exempt");
  // a blank / 0 contractYear keeps the pre-existing cap-free $0 but is NOT labelled with the class (its final year is unknown)
  for (const cy of ["", "0", null, undefined, "x"]) { const r = drop({ contractStatus: "Vet-WW", salary: 3000, contractInfo: "CL 1| TCV 3K| AAV 3K", contractYear: cy }, G2); t.equal(r.penalty, 0, "cy=" + String(cy)); t.equal(r.basis, "ww_under_5k_exempt", "cy=" + String(cy) + ": not labelled earned-n/a"); t.equal(r.earned_rule, undefined); }
  // a legacy row with no earned to derive from is HELD, never a misreported no-op
  const legacy = { ...cls, penalty_basis: "tcv_under_5k_guarantee", guaranteed_amount: 2000, earned_to_date: 1000 };
  t.equal(FC.planLegacyGuaranteeRepair(legacy).ok, true); t.equal(FC.planLegacyGuaranteeRepair({ ...legacy, earned_to_date: null }).result, "hold_conflict_penalty_would_change");
  // a row already re-based to the earned-n/a basis whose earned was left populated: ONLY earned is cleared (the basis is not rewritten)
  const rebased = FC.planWwEarnedNaRepair({ ...base, penalty_basis: "ww_under_5k_earned_na" }); t.equal(rebased.ok, true); t.deepEqual(rebased.set, { earned_to_date: null }); t.deepEqual(rebased.before, { earned_to_date: 235 });
});
test("REVIEW FIXES (route): the UPDATE re-asserts every proven column — a concurrent change makes it write NOTHING and audit NOTHING; the abort restores only its own columns; a rebased WW row keeps its basis", async () => {
  for (const [kind, o] of [["clear_full_year_earned", { ...MEMBER, pid: "61", earned: 118 }], ["clear_ww_earned_na", { ...WW_NA("Vet-WW", 2000), pid: "62", earned: 235 }], ["reconcile_legacy_guarantee_basis", { ...LEGACY, pid: "63" }]]) {
    const { env, db } = fcfsWorld(); const id = seedDrop(db, o); const before = rowOf2(db, id);
    // another writer moves the penalty AFTER the plan read the row and BEFORE the write batch — the guard must see it
    const real = env.UPS_MFL_DB.batch.bind(env.UPS_MFL_DB); let injected = false;
    env.UPS_MFL_DB.batch = async (stmts) => { if (!injected) { injected = true; db.prepare("UPDATE ups_drop_events SET penalty_amount = 4321, posted_to_mfl = 1, posted_amount = 4321 WHERE id = ?").run(id); } return real(stmts); };
    const r = (await repair(env, [{ kind, id, expect: EXP_EARNED(before) }], false)).json.results[0];
    t.equal(r.result, "noop_changed_concurrently", kind); const after = rowOf2(db, id);
    t.equal(after.earned_to_date, before.earned_to_date, kind + ": earned NOT cleared"); t.equal(after.penalty_amount, 4321, kind + ": the other writer's penalty is untouched"); t.equal(after.penalty_basis, before.penalty_basis, kind + ": basis untouched");
    t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit").get().n, 0, kind + ": no audit row without a write");
  }
  // a row already on the earned-n/a basis with earned left populated: earned cleared, basis NOT rewritten (and not set to NULL)
  { const { env, db } = fcfsWorld(); const id = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "64", earned: 235, basis: "ww_under_5k_earned_na" }); const before = rowOf2(db, id);
    t.equal((await repair(env, [{ kind: "clear_ww_earned_na", id, expect: EXP_EARNED(before) }], false)).json.results[0].result, "applied"); const after = rowOf2(db, id);
    t.deepEqual(changedCols(before, after), ["earned_to_date"], "ONE column"); t.equal(after.penalty_basis, "ww_under_5k_earned_na"); }
  // NULL evidence in a stored row is refused by the route, not defaulted
  { const { env, db } = fcfsWorld(); const id = seedDrop(db, { ...WW_NA("Vet-WW", 2000), pid: "65", earned: 235 }); db.prepare("UPDATE ups_drop_events SET penalty_amount = NULL WHERE id = ?").run(id);
    const r = (await repair(env, [{ kind: "clear_ww_earned_na", id }], undefined)).json.results[0]; t.equal(r.result, "conflict_financials_would_change"); t.match(r.detail, /penalty_amount is not stored/); }
  // concurrent identical applies: exactly one lands, the loser meets the guard (every kind that writes)
  for (const [kind, o, expectOf] of [["clear_ww_earned_na", { ...WW_NA("Vet-WW", 2000), pid: "66", earned: 235 }, EXP_EARNED], ["reconcile_legacy_guarantee_basis", { ...LEGACY, pid: "67" }, EXP_EARNED]]) {
    const { env, db } = fcfsWorld(); const id = seedDrop(db, o); const act = [{ kind, id, expect: expectOf(rowOf2(db, id)) }];
    const [x, y] = await Promise.all([repair(env, act, false), repair(env, act, false)]); t.deepEqual([x.json.results[0].result, y.json.results[0].result].sort(), ["applied", "noop_changed_concurrently"], kind);
    t.equal(db.prepare("SELECT COUNT(*) n FROM ups_contract_gate_audit WHERE field <> 'x'").get().n, 1, kind + ": one audit row");
  }
});
test("REVIEW FIXES (path B attribution): the owner-conversion chain must be THIS acquisition's — this league's rows only, no later acquisition of the player, no trade of him, and readable history; anything less refuses", async () => {
  const CAN = ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], MYM = ["1000", "Vet-MYM", "3", "CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K| GTD: 1K"];
  const setup = (league = "74598", withTx = true) => {
    const w = fcfsWorld(); seedAddEvent(w.db, "13113", "0004"); w.ev = w.db.prepare("SELECT * FROM ups_add_events").get();
    if (withTx) w.db.exec("CREATE TABLE IF NOT EXISTS ups_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, mfl_txn_id TEXT, league_id TEXT, season TEXT, type TEXT, unix_timestamp INTEGER, franchise_id TEXT, added_players TEXT, dropped_players TEXT, raw_json TEXT)");
    w.db.exec("CREATE TABLE IF NOT EXISTS salary_change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts TEXT, endpoint TEXT, season TEXT, league_id TEXT, dry_run INTEGER, player_id TEXT, before_salary TEXT, before_contract_status TEXT, before_contract_year TEXT, before_contract_info TEXT, after_salary TEXT, after_contract_status TEXT, after_contract_year TEXT, after_contract_info TEXT, landed INTEGER)");
    const put = (ts, b, a, ep) => w.db.prepare("INSERT INTO salary_change_log (created_ts, endpoint, season, league_id, dry_run, player_id, before_salary, before_contract_status, before_contract_year, before_contract_info, after_salary, after_contract_status, after_contract_year, after_contract_info, landed) VALUES (?,?, '2026', ?, 0, '13113', ?,?,?,?, ?,?,?,?, 1)")
      .run(new Date(ts * 1000).toISOString(), ep, league, b && b[0], b && b[1], b && b[2], b && b[3], a[0], a[1], a[2], a[3]);
    put(TS + 200, null, CAN, "/admin/import-salaries"); put(TS + 90000, CAN, MYM, "/offer-mym"); return w;
  };
  const closeOf = (w) => repair(w.env, [{ kind: "close_fcfs_add_event", id: w.ev.id, expect: { contract_annotated: 3 } }], false).then((r) => r.json.results[0]);
  { const w = setup(); t.equal((await closeOf(w)).result, "applied", "control: this league, no later acquisition, no trade"); }
  { const w = setup("99999"); t.equal((await closeOf(w)).result, "no_drop_of_this_acquisition", "ANOTHER league's rows are not evidence"); t.equal(w.db.prepare("SELECT contract_annotated c FROM ups_add_events").get().c, 3); }
  { const w = setup(); w.db.prepare("INSERT INTO ups_add_events (season, league_id, player_id, franchise_id, acquired_at_unix, acquired_at_iso, source, detected_at_utc) VALUES ('2026','74598','13113','0009', ?, 'x', 'fcfs', 'x')").run(TS + 50000);
    const r = await closeOf(w); t.equal(r.result, "chain_may_belong_to_a_later_acquisition"); t.equal(w.db.prepare("SELECT contract_annotated c FROM ups_add_events WHERE id = ?").get(w.ev.id).c, 3); }
  { const w = setup(); w.db.prepare("INSERT INTO ups_transactions (mfl_txn_id, league_id, season, type, unix_timestamp, franchise_id, raw_json) VALUES ('t', '74598', '2026', 'TRADE', ?, '0004', ?)").run(TS + 40000, JSON.stringify({ franchise1_gave_up: "13113," }));
    t.equal((await closeOf(w)).result, "chain_may_belong_to_another_owner"); }
  { const w = setup("74598", false); t.equal((await closeOf(w)).result, "chain_not_attributable", "unreadable trade history ⇒ fail closed"); }
});
test("REVIEW FIXES (pure): an unknown-time event is never 'before the add'; a prior holder who CAME BACK owns the row; a chain whose conversion precedes its stamp is no chain; a NaN drop time is not 'at or after'", () => {
  const P = { season: 2018, fid: "0008", ts: 2000000 }; const ev = (kind, fid, ts) => ({ kind, fid, ts });
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("drop", "0006", undefined)] }).explained, false, "a drop with NO timestamp is unknown, not the epoch");
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("drop", "0006", 0)] }).explained, false);
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("drop", "0006", 1900000), ev("add_bbid", "0006", 2500000)] }).explained, false, "0006 re-acquired him AFTER the add: the row may be 0006's own");
  t.equal(FC.explainClosedSeasonAnomaly(P, { contractRow: { franchise_id: "0006", salary: 4000 }, events: [ev("drop", "0006", 1900000), ev("add_bbid", "0006", 1950000)] }).explained, true, "a return BEFORE the add does not change the story");
  const ev0 = { id: 52, season: "2026", player_id: "13113", franchise_id: "0004", acquired_at_unix: 1000, source: "fcfs", contract_annotated: 3 };
  const iso = (u) => new Date(u * 1000).toISOString(); const CAN = ["1000", "Vet-WW", "1", "CL 1| TCV 1K| AAV 1K"], MYM = ["1000", "Vet-MYM", "3", "CL 3| TCV 3K| AAV 1K"];
  const row = (id, ts, b, a) => ({ id, created_ts: iso(ts), player_id: "13113", endpoint: "x", dry_run: 0, landed: 1, before_salary: b && b[0], before_contract_status: b && b[1], before_contract_year: b && b[2], before_contract_info: b && b[3], after_salary: a[0], after_contract_status: a[1], after_contract_year: a[2], after_contract_info: a[3] });
  t.equal(FC.planFcfsAddEventClosure({ addEvent: ev0, dropRow: null, auditRows: [], changeLog: [row(1, 5000, null, CAN), row(2, 6000, CAN, MYM)] }).ok, true, "control");
  t.equal(FC.planFcfsAddEventClosure({ addEvent: ev0, dropRow: null, auditRows: [], changeLog: [row(1, 6000, null, CAN), row(2, 5000, CAN, MYM)] }).ok, false, "conversion timestamped BEFORE its stamp");
  const good = { id: 1, player_id: "13113", franchise_id: "0004", dropped_at_unix: 2000, pre_drop_contract_status: "Vet-WW", pre_drop_salary: 1000, pre_drop_contract_year: 1, pre_drop_contract_info: "CL 1| TCV 1K| AAV 1K" }; const au = [{ id: 9, note: "drop_event_id=1 x" }];
  t.equal(FC.planFcfsAddEventClosure({ addEvent: ev0, dropRow: good, auditRows: au }).ok, true, "control");
  for (const v of [undefined, null, "abc", NaN]) t.equal(FC.planFcfsAddEventClosure({ addEvent: ev0, dropRow: { ...good, dropped_at_unix: v }, auditRows: au }).result, "drop_not_of_this_acquisition", String(v));
  t.equal(FC.planFcfsAddEventClosure({ addEvent: { ...ev0, acquired_at_unix: undefined }, dropRow: good, auditRows: au }).result, "drop_not_of_this_acquisition");
  t.equal(FC.classifyZeroPeriod({ season: 2024, endKind: "held_to_season_end" }, { sources: ["mfl_historical_transactions"] }).evidence_grade, "single_ledger_mfl_historical_transactions_only");
  t.match(FC.classifyZeroPeriod({ season: 2024, endKind: "held_to_season_end" }, { sources: ["mfl_historical_transactions"] }).reason, /only ledger that proves this add is mfl_historical_transactions/);
});
test("REVIEW FIXES (backfill): the cron look-back is honoured; canonical wins over an old conversion chain; the second ledger merges one-to-one and its drops count; a 2026 zero row is not 'unclassified'; a salary-only award at another price is not stamped; a missing drop row never binds to a later period's; the reprice rollback is guarded", async () => {
  // ── the cron's 7-day look-back ──
  { const db = buildDb(), io = makeIo(db);
    const inside = await TOOL.run(["--out", tmp()], { io, log: () => {}, now: TS + 60 + 2 * 86400 }); const c1 = inside.rows.find((r) => r.player_id === "16007").add_event_closure; t.equal(c1.method, "stamper_reconcile_cron"); t.equal(c1.ready, true); t.match(c1.evidence, /next tick/);
    const outside = await TOOL.run(["--out", tmp()], { io, log: () => {}, now: TS + 60 + 9 * 86400 }); const c2 = outside.rows.find((r) => r.player_id === "16007").add_event_closure;
    t.equal(c2.method, "stamper_reconcile_manual", "9 days old: the cron will never see it"); t.equal(c2.ready, true); t.equal(c2.manual_call.body.days, 10); t.equal(c2.manual_call.route, "/admin/adds/stamp-ww-contracts"); t.match(c2.evidence, /OUTSIDE the cron's 7-day look-back/); t.doesNotMatch(c2.evidence, /next tick/);
    const v = TOOL.verifyRows(outside.rows, outside.plan); t.equal(v.ok, false); t.match(v.failures.join(" "), /add event \d+ \(16007\) is still open: stamper_reconcile_manual/, "--verify does not call an unclosable event 'nothing left to correct'");
    t.equal(TOOL.verifyRows(inside.rows, inside.plan).failures.some((f) => /16007/.test(f)), false, "a cron-closable one is not a failure — the next tick does it"); }
  // ── canonical NOW beats a historical conversion chain (never close as 'superseded' while MFL holds exactly the canonical contract again) ──
  { const db = buildDb(), io = makeIo(db); io.mflState.salaries[16008] = { ...CANON };
    const out = await TOOL.run(["--out", tmp()], { io, log: () => {} }); const c = out.rows.find((r) => r.player_id === "16008").add_event_closure;
    t.equal(c.method, "stamper_reconcile_cron"); t.equal(out.plan.some((a) => a.player_id === "16008"), false, "no owner-conversion closure is planned"); }
  // ── a DESCRIBED contract with no chain is a person's call, never 'stamp first' ──
  { const db = buildDb(), io = makeIo(db); db.prepare("DELETE FROM salary_change_log WHERE player_id = '16008'").run();
    const out = await TOOL.run(["--out", tmp()], { io, log: () => {} }); const c = out.rows.find((r) => r.player_id === "16008").add_event_closure; t.equal(c.method, "manual_review"); t.match(c.reason, /a person decides/);
    t.match(TOOL.verifyRows(out.rows, out.plan).failures.join(" "), /add event \d+ \(16008\) is still open: manual_review/); }
  // ── the second ledger: ONE-TO-ONE, exact-deduped, drops become events, unusable rows are reported ──
  { const src = (ts) => ({ season: 2024, txn_index: 1, player_id: "1", franchise_id: "0001", unix_timestamp: ts });
    const h = (ts, o) => ({ season: 2024, txn_uid: "h" + ts, ts_unix: ts, franchise_id: "0001", player_in_id: "1", player_out_id: "", ...(o || {}) });
    const mk = (hist, events) => TOOL.buildAddsAndEvents({ histAdds: [src(1000000)], histTx: hist, histEvents: events || [], histTrades: [], tx2026: [] });
    const two = mk([h(1000100), h(1000200)]); t.equal(two.adds.length, 2, "the first hist row corroborates the src add; the SECOND is its own acquisition (never swallowed)"); t.deepEqual(two.adds[0].sources, ["src_adddrop", "mfl_historical_transactions"]); t.deepEqual(two.adds[1].sources, ["mfl_historical_transactions"]);
    t.equal(mk([h(2000000), h(2000000)]).adds.length, 2, "two IDENTICAL hist-only rows are one period"); t.equal(mk([h(1000100), h(1000100)]).adds.length, 1, "…and an identical row that would corroborate the src add is the same row too");
    t.deepEqual(mk([h(null, { player_in_id: "2" })]).histUnusable.map((x) => x.reason), ["no_timestamp"]); t.deepEqual(mk([h(1500000, { franchise_id: "" })]).histUnusable.map((x) => x.reason), ["no_franchise"]); t.equal(mk([h(null, { player_in_id: "2" })]).adds.length, 1);
    const withDrop = mk([{ season: 2024, txn_uid: "d", ts_unix: 1500000, franchise_id: "0001", player_in_id: "", player_out_id: "1" }]); t.deepEqual(withDrop.events.filter((e) => e.kind === "drop").map((e) => [e.pid, e.fid, e.ts]), [["1", "0001", 1500000]], "the second ledger's drop half is an event");
    const dup = mk([{ season: 2024, txn_uid: "d", ts_unix: 1500000, franchise_id: "0001", player_in_id: "", player_out_id: "1" }], [{ season: 2024, player_id: "1", franchise_id: "0001", move_type: "DROP", method: "FREE_AGENT", unix_timestamp: 1500010, txn_index: 2 }]);
    t.equal(dup.events.filter((e) => e.kind === "drop").length, 1, "a drop src_adddrop already recorded is not duplicated"); }
  // ── the zero report covers CLOSED seasons; a 2026 zero row belongs to the live tool ──
  { const z = TOOL.zeroReport([{ classification: "zero", season: 2026, zero_classification: null }, { classification: "zero", season: 2024, bucket: "retained", category: "manual_review", zero_classification: { zero_class: "conflicting_historical_evidence", evidence_grade: "d1_ledger" } }]);
    t.equal(z.total, 1); t.equal(z.balances, true, "a live-season zero row does not flip the balance"); t.equal(z.current_season_zero_rows_not_classified, 1); }
  // ── apply-time precondition mirrors the plan rule: a salary-only award is stamped ONLY at exactly $1,000 ──
  { const db = buildDb(), io = makeIo(db); const act = { kind: "mfl_stamp", season: 2026, player_id: "16001", franchise_id: "0004", after: FC.canonicalFcfsContract({}) };
    io.mflState.salaries[16001] = { salary: "2000", contractStatus: "", contractYear: "", contractInfo: "" };
    const r1 = await TOOL.applyPlan([act], io, { key: "k", dryRun: false, season: 2026 }); t.equal(r1[0].result, "precondition_failed"); t.match(r1[0].detail, /not the canonical \$1000/); t.equal(io.log.posts.length, 0, "nothing sent");
    io.mflState.salaries[16001] = { salary: "1000", contractStatus: "", contractYear: "", contractInfo: "" };
    const r2 = await TOOL.applyPlan([act], io, { key: "k", dryRun: false, season: 2026 }); t.equal(r2[0].result, "applied_verified", "at exactly $1,000 it is stamped"); }
  // ── a missing drop row never binds a period to a LATER period's drop ──
  { const db = buildDb(), io = makeIo(db); db.prepare("DELETE FROM ups_drop_events WHERE player_id = '16006'").run();
    const tx = (type, ts, added, dropped) => db.prepare("INSERT INTO ups_transactions (mfl_txn_id, season, type, unix_timestamp, franchise_id, added_players, dropped_players) VALUES (?, '2026', ?, ?, '0009', ?, ?)").run(`x${ts}`, type, ts, added, dropped);
    tx("FREE_AGENT", TS + 800000, "16006,", ""); tx("FREE_AGENT", TS + 900000, "", "16006,");                                     // re-added, then dropped again
    const later = Number(db.prepare("INSERT INTO ups_drop_events (season, player_id, player_name, franchise_id, dropped_at_unix, pre_drop_contract_status, pre_drop_salary, pre_drop_contract_year, pre_drop_contract_info, pre_drop_tcv, earned_to_date, penalty_amount, penalty_basis, penalty_exempt, posted_to_mfl) VALUES ('2026','16006','P6','0009',?,'Vet-WW',1000,1,'CL 1| TCV 1K| AAV 1K',1000,0,0,'ww_under_5k_exempt',1,0)").run(TS + 900000).lastInsertRowid);
    const out = await TOOL.run(["--out", tmp()], { io, log: () => {} }); const ps = out.rows.filter((r) => r.player_id === "16006").sort((a, b) => a.acquired_ts - b.acquired_ts);
    t.equal(ps.length, 2); t.equal(ps[0].drop_event, null, "the FIRST period's drop row is missing — it is NOT bound to the later period's drop"); t.equal(ps[1].drop_event.id, later, "the second period owns its own drop"); }
  // ── the reprice rollback only fires on a row still in the repair's own state ──
  { const db = buildDb(), io = makeIo(db); const plan = await reviewedPlan(io); const dir = tmp(); const ap = await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", plan, "--out", dir], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } });
    const rb = fs.readFileSync(path.join(dir, "rollback.sql"), "utf8").trim().split("\n").filter((l) => /ups_drop_events/.test(l)); t.equal(rb.length, 1);
    db.prepare("UPDATE ups_drop_events SET pre_drop_contract_info = 'CL 2| TCV 2K| AAV 1K' WHERE penalty_basis = 'ww_under_5k_exempt' AND player_id = '16003'").run();     // a later writer changed the contract after the repair
    t.equal(Number(db.prepare(rb[0]).run().changes), 0, "the rollback does NOT undo a later change"); t.equal(ap.report.applied.length >= 1, true); }
});
test("TOOL (two ledgers): an FCFS add only mfl_historical_transactions proves is its OWN period; one it merely corroborates adds a source, never a period", async () => {
  const db = buildDb(), io = makeIo(db);
  const out = await TOOL.run(["--out", tmp()], { io, log: () => {} });
  const only = out.rows.filter((r) => r.player_id === "9020"); t.equal(only.length, 1, "the hist-only add is a period"); t.deepEqual(only[0].evidence_sources, ["mfl_historical_transactions"]); t.equal(only[0].season, 2011); t.match(only[0].transaction_id, /mfl_historical_transactions:h-only/);
  t.equal(only[0].classification, "zero", "its season-end row is found THROUGH THE UNION (without it this would be missing_row)"); t.equal(only[0].bucket, "dropped_during_season", "…and so is its DROP (recorded only by the second ledger)"); t.notEqual(only[0].drop_date, ""); t.equal(only[0].category, "historical_unchanged"); t.equal(only[0].zero_classification.zero_class, "transaction_proven_fcfs_acquisition");
  t.deepEqual(out.summary.hist_rows_unusable.map((x) => [x.player_id, x.reason]), [["9021", "no_timestamp"]], "an add with no stamp is REPORTED, never coerced to the epoch");
  const a = out.rows.filter((r) => r.player_id === "9001"); t.equal(a.length, 1, "the corroborating row created no new period"); t.deepEqual(a[0].evidence_sources, ["src_adddrop", "mfl_historical_transactions"]);
  t.deepEqual(out.summary.hist_only_periods.map((x) => x.player_id), ["9020"]); t.equal(out.summary.by_evidence_sources["mfl_historical_transactions"], 1);
  t.match(TOOL.QUERIES.histEvents, /UNION SELECT season, player_in_id FROM mfl_historical_transactions/, "the players a hist-only add proves get their events / contracts / names too");
  t.match(TOOL.QUERIES.histTx, /player_out_id/, "the second ledger's DROPS of an FCFS player are read too");
  // the second ledger's own row is never a second period of an add src_adddrop already holds, even when the stamps differ by hours
  const cc = await TOOL.crosscheck(io, await TOOL.loadDataset(io, { cacheDir: tmp() })); t.equal(cc.find((x) => x.season === 2011).d1_fcfs_adds, 2, "the crosscheck counts the union (Z3 + the hist-only add)");
});
test("TOOL (zero periods): EVERY zero-contract period is classified — the four classes add up to the zero total, nothing is left over", async () => {
  const db = buildDb(), io = makeIo(db);
  const out = await TOOL.run(["--out", tmp()], { io, log: () => {} });
  const z = out.summary.zero_periods, by = (pid) => out.rows.find((r) => r.player_id === pid);
  t.equal(z.balances, true); t.equal(z.unclassified, 0); t.equal(z.total, z.classified); t.equal(Object.values(z.by_class).reduce((a, b) => a + b, 0), z.total, "the four classes sum to the total");
  t.equal(by("9008").zero_classification.zero_class, "transaction_proven_fcfs_acquisition", "Z1 dropped"); t.equal(by("9008").category, "historical_unchanged");
  t.equal(by("9009").zero_classification.zero_class, "superseded_by_later_valid_contract", "Z2 replaced by a later BBID");
  t.equal(by("9006").zero_classification.zero_class, "conflicting_historical_evidence", "F: held at season end, explicit $0 row"); t.equal(by("9006").category, "manual_review", "…and it stays unchanged for review");
  t.equal(by("9014").zero_classification.zero_class, "conflicting_historical_evidence", "Z4 traded, $0 row"); t.equal(by("9010").zero_classification.zero_class, "insufficient_source_evidence", "Z3: 2011 has no MFL data"); t.equal(by("9010").zero_classification.evidence_grade, "d1_ledger_only_not_corroborated_by_mfl");
  t.deepEqual(z.by_class, { transaction_proven_fcfs_acquisition: 2, superseded_by_later_valid_contract: 1, conflicting_historical_evidence: 2, insufficient_source_evidence: 1 });
  for (const r of out.rows.filter((x) => x.classification === "zero")) t.ok(r.zero_classification && r.zero_classification.reason.length > 20, `${r.player_id} has a stated reason`);
  t.equal(out.rows.filter((r) => r.classification !== "zero").every((r) => r.zero_classification === null), true, "only zero periods are classified");
});
test("TOOL (anomalies): the three closed-season anomaly shapes are EXPLAINED individually from the ledger; one the ledger cannot explain stays in review; the unverifiable gaps are counted and unchanged", async () => {
  const db = buildDb(), io = makeIo(db);
  const before = snapshot(db);
  const out = await TOOL.run(["--out", tmp()], { io, log: () => {} });
  const by = (pid) => out.rows.find((r) => r.player_id === pid);
  t.equal(by("9011").anomaly_explanation.explanation_class, "same_franchise_drop_and_readd"); t.equal(by("9011").review_class, "closed_season_anomaly_explained"); t.equal(by("9011").category, "historical_unchanged"); t.equal(by("9011").correction_required, false); t.equal(by("9011").anomaly_explanation.evidence.gap_seconds, 486);
  t.equal(by("9012").anomaly_explanation.explanation_class, "season_end_row_belongs_to_prior_holder"); t.equal(by("9012").anomaly_explanation.evidence.next_season_names_acquirer, true, "the next season's row names the acquirer"); t.equal(by("9012").category, "historical_unchanged");
  t.equal(by("9013").anomaly_explanation, null); t.equal(by("9013").review_class, "closed_season_anomaly", "no ledger explanation → still a manual-review row"); t.equal(by("9013").category, "manual_review");
  t.deepEqual(out.summary.closed_season_anomalies.map((a) => a.player_id).sort(), ["9011", "9012"]); t.equal(out.summary.unexplained_closed_season_anomalies, 1);
  const gaps = out.summary.closed_season_unverifiable_gaps; t.equal(gaps.unchanged, true); t.equal(gaps.total, out.rows.filter((r) => r.review_class === "closed_season_unverifiable").length); t.equal(out.rows.filter((r) => r.review_class === "closed_season_unverifiable").every((r) => r.auto_correctable === false && r.action === "manual_review"), true, "not one of them is auto-written");
  t.equal(snapshot(db), before, "the report writes nothing");
});
test("TOOL (add-event closure): each open 2026 FCFS add event has a stated closure method — cron reconcile when MFL already holds the canonical contract, the audited closure step (after its drop repair) for a dropped player — and the plan is dependency-ordered", async () => {
  const db = buildDb(), io = makeIo(db);
  const out = await TOOL.run(["--out", tmp()], { io, log: () => {} });
  const by = (pid) => out.rows.find((r) => r.player_id === pid).add_event_closure;
  t.equal(by("16007").method, "stamper_reconcile_cron"); t.equal(by("16007").ready, true); t.match(by("16007").evidence, /canonical contract/); t.equal(out.plan.some((a) => a.player_id === "16007"), false, "the cron closes it — nothing for a person to run");
  t.equal(by("16001").method, "stamper_reconcile_cron"); t.equal(by("16001").ready, false, "the stamp comes first, then the reconcile");
  const d = by("16003"); t.equal(d.method, "close_fcfs_add_event"); t.equal(d.ready, false); t.equal(d.roster_verified, false, "a roster re-read cannot verify a dropped player"); t.deepEqual(d.depends_on, { kind: "reprice_unstamped_fcfs_drop", id: d.drop_event_id }); t.equal(d.blocked_by, "drop_contract_not_canonical");
  t.equal(out.rows.find((r) => r.player_id === "16002").add_event_closure, null, "an add event of another franchise is not this acquisition's");
  t.deepEqual(out.plan.map((a) => a.kind), ["mfl_stamp", "reprice_unstamped_fcfs_drop", "close_fcfs_add_event", "close_fcfs_add_event"], "the closures run AFTER the repair one of them depends on");
  const cl = out.plan.find((a) => a.kind === "close_fcfs_add_event" && a.player_id === "16003"); t.deepEqual(cl.expect, { contract_annotated: 3 }); t.equal(cl.after.contract_annotated, 1); t.match(cl.after.notes, /settled_by_drop_repair/); t.match(cl.applicable_after, /^reprice_unstamped_fcfs_drop:/);
  t.deepEqual(out.summary.add_event_closures.map((x) => `${x.player_id}:${x.method}:${x.ready}`).sort(), ["16001:stamper_reconcile_cron:false", "16003:close_fcfs_add_event:false", "16007:stamper_reconcile_cron:true", "16008:close_fcfs_add_event:true"]);
  const w = by("16008"); t.equal(w.variant, "owner_conversion"); t.equal(w.ready, true); t.equal(w.after.contract_annotated, 2, "a converted contract is closed as 2 — never reverted"); t.match(w.after.notes, /superseded_by_later_owner_contract/); t.equal(w.roster_verified, false); t.equal(w.depends_on, undefined);
  t.equal(w.evidence.change_endpoint, "/offer-mym"); t.equal(w.evidence.converted_to.status, "Vet-MYM"); t.equal(w.mfl_observed_now.status, "Vet-MYM", "corroborated by the live MFL read (not required by the route)");
  const wa = out.plan.find((x) => x.player_id === "16008"); t.equal(wa.variant, "owner_conversion"); t.equal(wa.applicable_after, undefined, "nothing has to happen first"); t.deepEqual(wa.expect, { contract_annotated: 3 });
  // a dependency that did not land is NEVER sent
  const calls = []; const io2 = { ...io, async post(p, body, key) { calls.push(body.actions ? body.actions[0].kind : "salaries"); if (body.actions && body.actions[0].kind === "reprice_unstamped_fcfs_drop") return { status: 200, body: { results: [{ kind: "reprice_unstamped_fcfs_drop", id: body.actions[0].id, result: "precondition_failed" }] } }; return io.post(p, body, key); } };
  const res = await TOOL.applyPlan(out.plan.filter((a) => a.kind !== "mfl_stamp" && a.player_id !== "16008"), io2, { key: "k", dryRun: false, season: 2026 });
  t.deepEqual(res.map((r) => `${r.kind}:${r.result}`), ["reprice_unstamped_fcfs_drop:precondition_failed", "close_fcfs_add_event:skipped_dependency_not_applied"]); t.deepEqual(calls, ["reprice_unstamped_fcfs_drop"], "the closure was never sent");
  // rollback.sql restores the refused state, guarded on the closed state AND the closure note
  const rb = TOOL.rollbackSql(out.plan).trim().split("\n"); t.equal(rb.length, 3); t.match(rb[1], /^UPDATE ups_add_events SET contract_annotated = 3, annotated_at_utc = NULL, notes = NULL WHERE id = \d+ AND contract_annotated = 1 AND notes = 'fcfs_contract_settled_by_drop_repair: /); t.match(rb[2], /AND contract_annotated = 2 AND notes = 'superseded_by_later_owner_contract: /);
  // …and the whole apply → second-run → rollback cycle, end to end against the fixture
  const plan1 = await reviewedPlan(io); const dir = tmp();
  const ap = await TOOL.run(["--apply", "--yes", "--season", "2026", "--plan", plan1, "--out", dir], { io, log: () => {}, env: { UPS_COMMISH_API_KEY: "k" } });
  t.deepEqual(ap.report.applied.map((a) => `${a.kind}:${a.result}`), ["mfl_stamp:applied_verified", "reprice_unstamped_fcfs_drop:applied", "close_fcfs_add_event:applied", "close_fcfs_add_event:applied"]);
  t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events WHERE player_id = '16008'").get().c, 2, "the converted one closed as 2");
  const closed = db.prepare("SELECT contract_annotated c, notes n FROM ups_add_events WHERE player_id = '16003'").get(); t.equal(closed.c, 1); t.match(closed.n, /NOT a roster-verified/);
  const again = await TOOL.run(["--out", tmp()], { io, log: () => {} }); t.deepEqual(again.plan, [], "second run: nothing planned"); t.equal(TOOL.verifyRows(again.rows, again.plan).ok, true);
  db.exec(TOOL.rollbackSql(out.plan).split("\n").filter((l) => /ups_add_events/.test(l)).join("\n"));
  t.deepEqual({ ...db.prepare("SELECT contract_annotated c, annotated_at_utc a, notes n FROM ups_add_events WHERE player_id = '16003'").get() }, { c: 3, a: null, n: null }, "the closure rolls back to its refused state");
  t.equal(db.prepare("SELECT contract_annotated c FROM ups_add_events WHERE player_id = '16008'").get().c, 3, "…and so does the owner-conversion closure");
});


// ═════════════════════════════════════ 6. the Discord poster (worker/src/lib/waiver_run_post.js — backend, not client rendering) ═════════════════════════════════════
test("DISPLAY (Discord): a NULL earned never prints a fake 'GTD − $0 Earned' — the poster falls back to the plain basis, and the recompute path keeps NULL", async () => {
  const { explainPenalty, humanizeDropBasis } = await import("../worker/src/lib/waiver_run_post.js");
  t.match(humanizeDropBasis("full_year_1k_contract"), /paying \$1K every year — flat \$1K \(full-year rule, no earned salary\)/); t.match(humanizeDropBasis("ww_under_5k_earned_na"), /earned salary not applicable \(cap-free\)/);
  t.equal(explainPenalty({ penalty: 0, basis: "ww_under_5k_earned_na", exempt: true, guaranteed: 0, earned: null }), null, "a $0 cap-free drop needs no further justification");
  t.equal(explainPenalty({ penalty: 1000, basis: "full_year_1k_contract", guaranteed: 1000, earned: null }), "Sub-$5K TCV, multi-year contract paying $1K every year — flat $1K (full-year rule, no earned salary)", "a NULL earned never prints '− $0 Earned'");
  t.equal(explainPenalty({ penalty: 1000, basis: "tcv_under_5k_flat", guaranteed: 1000, earned: null }), "Sub-$5K TCV, multi-year contract — flat $1K, no earned-salary arithmetic");
  t.equal(explainPenalty({ penalty: 1000, basis: "tcv_under_5k_flat", guaranteed: 1000, earned: 118 }), "$1K GTD − $118 Earned = $1K", "a stored earned still prints its arithmetic (unrepaired / non-class rows)");
  const src = read("worker/src/index.js");
  t.match(src, /const earned = r\.earned_to_date == null \? null : \(Number\(r\.earned_to_date\) \|\| 0\);/, "the drop poster keeps NULL");
  t.match(src, /\(rc\.earned_rule \|\| r\.earned_to_date == null\) \? null :/, "the recompute path keeps NULL");
});

restore();
await run("fcfs_contract");
