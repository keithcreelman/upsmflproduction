// The drop scanner prices the contract that was DROPPED, not the one in a
// stale snapshot. Runs the REAL /admin/drops/scan-and-record route (dry run).
//   node tests/drop_scan_same_day_contract.test.mjs
//   WORKER_JS=<pre-fix copy> … to watch the 3-years-left drop price as an exempt 1-year deal
//
// Colbie Young (Gride, MFL 17542), the real case:
//   - The 2026-09-06 R2 roster snapshot (stored 09:05Z) shows a 1-year $1K
//     Rookie-FAA deal. Real roster entry, below.
//   - Gride MYAC'd him to 3 years × $1K at 2026-09-06T22:28:34Z
//     (ups_extension_submissions id 727, real row).
//   - He was dropped at 2026-09-07T11:51:50Z (real MFL FREE_AGENT transaction).
//   - No 2026-09-07 snapshot exists, so the scanner read 09-06 and stored an
//     exempt 1-year deal — a $1K, 3-years-left drop. Keith 2026-10-06: "lets
//     make it so it doesnt happen again".
// Every network edge is faked (MFL, R2). The scan is a dry run: nothing is written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = (await import(process.env.WORKER_JS ? path.resolve(process.env.WORKER_JS) : "../worker/src/index.js")).default;

const DROP_TS = 1788781910;                        // 2026-09-07T11:51:50Z
const SNAP_0906 = { rosters: { franchise: [{ id: "0003", player: [
  { contractInfo: "CL 1| TCV 1K| AAV 1K", salary: "1000", status: "ROSTER", drafted: "Auction $1,000", contractYear: "1", id: "17542", contractStatus: "Rookie-FAA" },
] }] } };
const MYAC_727 = { id: 727, league_id: "74598", season: "2026", franchise_id: "0003", player_id: "17542",
  new_contract_status: "Rookie-FAA", new_salary: 1000, new_contract_year: 3,
  new_contract_info: "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K", submitted_at_utc: "2026-09-06T22:28:34.235Z", dry_run: 0 };

const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE");
  if (type === "transactions" && u.searchParams.get("TRANS_TYPE") === "FREE_AGENT") {
    return json({ transactions: { transaction: [{ type: "FREE_AGENT", franchise: "0003", timestamp: String(DROP_TS), transaction: "|17542,", by_commish: "1" }] } });
  }
  if (type === "transactions") return json({ transactions: { transaction: [] } });
  if (type === "nflSchedule") {          // 2026 Week 1 opener (Thu Sep 10, 8:20 PM ET)
    return json({ nflSchedule: { week: u.searchParams.get("W") || "1", matchup: [{ kickoff: String(Math.floor(Date.parse("2026-09-10T20:20:00-04:00") / 1000)), team: [{ id: "DAL" }, { id: "PHI" }] }] } });
  }
  if (type === "players") return json({ players: { player: [{ id: "17542", name: "Young, Colbie", position: "WR", team: "CIN" }] } });
  if (type === "league") return json({ league: { franchises: { franchise: [{ id: "0003", name: "Gride" }] } } });
  return json({ error: "test: no such call" }, 503);
};

function makeEnv({ submissions = [MYAC_727], snapshotUploaded = "2026-09-06T09:05:12.000Z", brokenSubmissions = false } = {}) {
  const db = makeD1({});
  db.raw.exec(`CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT, player_id TEXT, player_name TEXT, position TEXT, nfl_team TEXT,
    franchise_id TEXT, franchise_name TEXT, dropped_at_unix INTEGER, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER,
    pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER, pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER,
    earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER, penalty_exempt_reason TEXT, ledger_key TEXT UNIQUE,
    posted_to_mfl INTEGER DEFAULT 0, source TEXT, detected_at_utc TEXT, raw_transaction_json TEXT, snapshot_source TEXT, discord_posted INTEGER DEFAULT 0, notes TEXT,
    UNIQUE (season, league_id, player_id, dropped_at_unix))`);
  const cols = "id INTEGER, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, new_contract_status TEXT, new_salary INTEGER, new_contract_year INTEGER, new_contract_info TEXT, submitted_at_utc TEXT, dry_run INTEGER";
  if (!brokenSubmissions) db.raw.exec(`CREATE TABLE ups_extension_submissions (${cols})`);
  db.raw.exec(`CREATE TABLE ups_mym_submissions (${cols})`);
  db.raw.exec(`CREATE TABLE ups_restructure_submissions (${cols}, voided_at_utc TEXT)`);
  for (const r of brokenSubmissions ? [] : submissions) {
    db.raw.prepare("INSERT INTO ups_extension_submissions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(r.id, r.league_id, r.season, r.franchise_id, r.player_id,
      r.new_contract_status, r.new_salary, r.new_contract_year, r.new_contract_info, r.submitted_at_utc, r.dry_run);
  }
  const r2 = { async get(key) {
    if (key !== "snapshots/2026-09-06/rosters.json") return null;        // no 2026-09-07 snapshot — as in production
    return { async text() { return JSON.stringify(SNAP_0906); }, uploaded: snapshotUploaded ? new Date(snapshotUploaded) : undefined };
  } };
  return { UPS_MFL_DB: db, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k", FA_AUCTION_START_AT: "1784995200" };
}
// The scan runs at the moment production ran it: 2026-09-08T00:00:37Z (before Week 1).
const SCAN_AT = Date.parse("2026-09-08T00:00:37Z");
async function scan(env) {
  const realNow = Date.now;
  Date.now = () => SCAN_AT;
  try { return await scanAt(env); } finally { Date.now = realNow; }
}
async function scanAt(env) {
  const req = new Request("https://w.test/admin/drops/scan-and-record?L=74598&YEAR=2026&APIKEY=admin", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ season: "2026", league_id: "74598", days: 40, dry_run: true }),
  });
  const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  const body = await res.json();
  return { status: res.status, body, db: env.UPS_MFL_DB };
}
const colbie = (b) => (b.written || []).find((w) => String(w.pid) === "17542");
const skippedColbie = (b) => (b.skipped || []).find((w) => String(w.pid) === "17542");

test("the MYAC submitted after the 09-06 snapshot and before the drop IS the dropped contract → $1K, 3 years left", async () => {
  const { status, body } = await scan(makeEnv());
  t.equal(status, 200, JSON.stringify(body).slice(0, 300));
  const w = colbie(body);
  t.ok(w, "Colbie's drop is priced: " + JSON.stringify(body.skipped || []).slice(0, 300));
  t.equal(w.pre_drop.contract_info, MYAC_727.new_contract_info);
  t.equal(w.pre_drop.contract_year, 3);
  t.equal(w.pre_drop.snapshot_source, "ups_extension_submissions:727", "the source of the contract is recorded");
  t.equal(w.pre_drop.superseded_snapshot, "2026-09-06");
  t.equal(w.penalty.penalty, 1000); t.equal(w.penalty.exempt, false);
  t.equal(w.penalty.cl, 3); t.equal(w.penalty.yearsRemaining, 3); t.equal(w.penalty.tcv, 3000);
});

test("without a later submission the snapshot stands (the pre-fix behavior, unchanged)", async () => {
  const { body } = await scan(makeEnv({ submissions: [] }));
  const w = colbie(body);
  t.equal(w.pre_drop.snapshot_source, "2026-09-06");
  t.equal(w.pre_drop.contract_info, "CL 1| TCV 1K| AAV 1K");
  t.equal(w.penalty.penalty, 0); t.equal(w.penalty.exempt, true, "a real 1-year $1K deal is cap-free");
});

test("only a submission strictly AFTER the snapshot counts; one the snapshot already holds changes nothing", async () => {
  const before = { ...MYAC_727, id: 700, submitted_at_utc: "2026-09-06T08:00:00.000Z" };   // before the 09:05Z snapshot
  const { body } = await scan(makeEnv({ submissions: [before] }));
  t.equal(colbie(body).pre_drop.snapshot_source, "2026-09-06");
  const dryOnly = { ...MYAC_727, id: 701, dry_run: 1 };
  t.equal(colbie((await scan(makeEnv({ submissions: [dryOnly] }))).body).pre_drop.snapshot_source, "2026-09-06", "a dry-run submission never counts");
  const afterDrop = { ...MYAC_727, id: 702, submitted_at_utc: "2026-09-07T12:00:00.000Z" };
  t.equal(colbie((await scan(makeEnv({ submissions: [afterDrop] }))).body).pre_drop.snapshot_source, "2026-09-06", "nor one after the drop");
  const otherTeam = { ...MYAC_727, id: 703, franchise_id: "0005" };
  t.equal(colbie((await scan(makeEnv({ submissions: [otherTeam] }))).body).pre_drop.snapshot_source, "2026-09-06", "nor another franchise's");
});

test("snapshot time unknown → the start of its day: an evening MYAC still wins", async () => {
  const { body } = await scan(makeEnv({ snapshotUploaded: null }));
  t.equal(colbie(body).pre_drop.snapshot_source, "ups_extension_submissions:727");
});

test("fail closed: a submission source that can't be read leaves the drop unpriced for the next scan", async () => {
  const { body } = await scan(makeEnv({ brokenSubmissions: true }));
  t.ok(!colbie(body), "not priced from a snapshot that may be stale");
  const s = skippedColbie(body);
  t.ok(s, JSON.stringify(body.skipped || []));
  t.equal(s.reason, "contract_submission_check_failed");
});

test("dry run wrote nothing", async () => {
  const { db } = await scan(makeEnv());
  t.ok(!db.log.some((x) => /^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql)), db.log.filter((x) => /^\s*(INSERT|UPDATE|DELETE)/i.test(x.sql)).map((x) => x.sql.slice(0, 60)).join(" | "));
});

await run("drop_scan_same_day_contract");
