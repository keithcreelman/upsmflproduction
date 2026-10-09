// "Per Wk" is THIS contract's salary over THIS contract's own earning window (Keith 2026-10-09: "His $11K should be allocated over the
// payable weeks remaining after acquisition … not divided across the full season").
//   node tests/front_office_per_week_window.test.mjs
//
// Canon §D1: a contract earns over Weeks W through 17 inclusive — 17 weeks from the auction / Week 1, 18 − W for a Week-W waiver
// pickup; the acquisition week is the first eligible week; a trade never re-windows. The Front Office used salary / 17 for everyone.
// Real 2026 cases (MFL transactions export, read 2026-10-09):
//   Will Shipley 16601 — $1K blind bid by 0010 Thu 2026-09-24 09:00 ET (Week 3), dropped by 0010 Fri 09-25, then an $11K blind bid by
//                        0008 Thu 2026-10-08 09:00 ET (Week 5): 18 − 5 = 13 weeks, $11,000 / 13 = $846 a week (shown as $647).
//   Dohnte Meyers 17752 — $6K blind bid by 0003, same run: $6,000 / 13 = $462 a week (shown as $353).
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const ET = (iso) => String(Math.floor(Date.parse(iso) / 1000));
// MFL transactions, as the export serves them (2026, real timestamps for the two real players)
const TXS = [
  { type: "FREE_AGENT", franchise: "0007", timestamp: ET("2026-08-10T19:41:22-04:00"), transaction: "|16601," },
  { type: "AUCTION_WON", franchise: "0003", timestamp: ET("2026-08-01T12:00:00-04:00"), transaction: "16696,|8000|" },
  { type: "BBID_WAIVER", franchise: "0010", timestamp: ET("2026-09-24T09:00:00-04:00"), transaction: "16601,|1000|" },
  { type: "BBID_WAIVER", franchise: "0010", timestamp: ET("2026-09-25T09:00:00-04:00"), transaction: "17207,|1000|16601," },
  { type: "BBID_WAIVER", franchise: "0001", timestamp: ET("2026-09-24T09:00:00-04:00"), transaction: "15000,|8000|" },        // Week-3 pickup…
  { type: "TRADE", franchise: "0001", franchise2: "0008", timestamp: ET("2026-10-01T12:00:00-04:00"), franchise1_gave_up: "15000,", franchise2_gave_up: "13100," }, // …traded in Week 4
  { type: "BBID_WAIVER", franchise: "0008", timestamp: ET("2026-10-08T09:00:00-04:00"), transaction: "16601,|11000|" },
  { type: "BBID_WAIVER", franchise: "0003", timestamp: ET("2026-10-08T09:00:00-04:00"), transaction: "17752,|6000|15238," },
];
const ROSTERS = {
  "0008": [{ id: "16601", salary: 11000, contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 11K| AAV 11K", contractYear: 1 },
           { id: "15000", salary: 8000, contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 8K| AAV 8K", contractYear: 1 }],
  "0003": [{ id: "17752", salary: 6000, contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 6K| AAV 6K", contractYear: 1 },
           { id: "16696", salary: 8000, contractStatus: "Vet-FAA", contractInfo: "CL 1| TCV 8K| AAV 8K", contractYear: 1 },
           { id: "14000", salary: 9000, contractStatus: "Vet-WW", contractInfo: "CL 2| TCV 18K| AAV 9K| Y1-9K, Y2-9K", contractYear: 1 }], // year 2 of a WW deal from 2025
};
const AFTER_WEEK5 = "2026-10-20T16:00:00Z";    // a Tuesday after Week 5 is complete (the authority counts a week once the next one kicks off)
// MFL's nflSchedule export (the completed-week authority reads it): 2026 opened Wed Sep 9 (8:20 PM ET), then Thursday 8:15 PM ET
// openers; a Sunday 1 PM slate; Monday 8:15 PM ET closers.
function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(Date.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [
    { kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}

async function preview({ failTransactions = false, dropDate = AFTER_WEEK5 } = {}) {
  const env = makeWorkerEnv({});
  const mfl = makeMfl();
  mfl.st.rosters = ROSTERS;
  mfl.st.transactions = TXS;
  mfl.install();
  const stub = globalThis.fetch;
  const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = (u, init) => {
    const url = String(u);
    if (/TYPE=nflSchedule/.test(url)) return json(nflSchedule(Number(new URL(url).searchParams.get("W"))));
    if (failTransactions && /TYPE=transactions/.test(url)) return json({ error: "MFL boom" }, 500);
    return stub(u, init);
  };
  try {
    const r = await callWorker(env, "GET", `/api/cap-penalty/preview?L=74598&YEAR=2026&drop_date=${encodeURIComponent(dropDate)}`);
    t.equal(r.status, 200, r.text.slice(0, 300));
    return r.json;
  } finally { globalThis.fetch = stub; mfl.restore(); }
}

test("WORKER: each row carries its own window — Week-5 blind bids 13 weeks, the auction contract 17, a traded Week-3 pickup 15, a later contract year 17", async () => {
  const j = await preview();
  t.equal(j.acquisition_week_source, "transactions");
  const p = j.players;
  t.equal(p["16601"].acquisition_week, 5, "Shipley's CURRENT contract is the Week-5 bid, not 0010's Week-3 one");
  t.equal(p["16601"].eligible_weeks, 13); t.equal(p["16601"].current_year_salary, 11000);
  t.equal(p["17752"].eligible_weeks, 13); t.equal(p["17752"].current_year_salary, 6000);
  t.equal(p["16696"].eligible_weeks, 17, "auction: Weeks 1-17");
  t.equal(p["15000"].eligible_weeks, 15, "a trade does NOT re-window: 18 − 3");
  t.equal(p["14000"].eligible_weeks, 17, "year 2 of a 2025 WW deal began in Week 1 of 2026");
  // the earning these windows drive: one share per completed week from the acquisition week on, rounded ONCE
  const done = j.earned_through_week;
  t.ok(done >= 5, "the what-if date is after Week 5: " + done);
  t.equal(p["16601"].current_year_earned, Math.round(((done - 4) / 13) * 11000));
  t.equal(p["17752"].current_year_earned, Math.round(((done - 4) / 13) * 6000));
});

test("WORKER FAIL-CLOSED: transactions unreadable in-season → first-year waiver/MYM rows are UNPRICED (no window, no earned, no penalty); other rows still price", async () => {
  const j = await preview({ failTransactions: true });
  t.equal(j.acquisition_week_source, "unresolved"); t.match(j.acquisition_week_error, /transactions export/);
  for (const pid of ["16601", "17752", "15000"]) {
    const r = j.players[pid];
    t.equal(r.eligible_weeks, null, pid + ": window unknown, not 17");
    t.equal(r.penalty, null, pid + ": unpriced, not a guessed charge"); t.equal(r.earned, null);
    t.equal(r.basis, "week_authority_unresolved"); t.equal(r.needs_review, true); t.match(r.review_reason, /acquisition week could not be resolved/);
  }
  t.equal(j.players["16696"].eligible_weeks, 17, "the auction contract's window does not depend on the transactions");
  t.ok(Number.isFinite(j.players["16696"].penalty), "…and it still prices");
  t.equal(j.players["14000"].eligible_weeks, 17, "a later contract year began in Week 1"); t.ok(Number.isFinite(j.players["14000"].penalty));
});

test("WORKER: the drop recorder and the recompute price a drop on the contract it ENDED — 0010's Sep-25 drop of Shipley was his Week-3 contract", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const grab = (a, b) => { const i = src.indexOf(a); return src.slice(i, src.indexOf(b, i) + b.length); };
  const prelude = `const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=(y)=>Number(y)===2026?"2026-09-09":"";
const _nflWeekForUnix=(u,y)=>{const w=_nflWeek1Iso(y);if(!w||!u)return 0;const s=new Date(w+"T00:00:00Z").getTime()/1000;if(u<s)return 0;const k=Math.floor((u-s)/(7*86400))+1;return (k>=1&&k<=17)?k:0;};\n`;
  const code = prelude + grab("const _acquisitionWeekMapFromTxs =", "  return map;\n};") + "\n" + grab("const _acquisitionWeekAsOf =", "  return best ? best.wk : undefined;\n};")
    + "\nresult = { map: _acquisitionWeekMapFromTxs(TXS, 2026), drop0010: _acquisitionWeekAsOf(TXS, 2026, '16601', " + ET("2026-09-25T09:00:00-04:00") + "),"
    + " now: _acquisitionWeekAsOf(TXS, 2026, '16601', 9e12), beforeAny: _acquisitionWeekAsOf(TXS, 2026, '16601', " + ET("2026-09-01T00:00:00-04:00") + "),"
    + " traded: _acquisitionWeekAsOf(TXS, 2026, '15000', 9e12), auction: _acquisitionWeekAsOf(TXS, 2026, '16696', 9e12) };";
  const ctx = { TXS, result: null }; vm.createContext(ctx); vm.runInContext(code, ctx);
  const r = ctx.result;
  t.equal(r.drop0010, 3, "0010's drop ended the Week-3 contract (window 15), not the Week-5 one that came later");
  t.equal(r.now, 5); t.equal(r.now, r.map["16601"], "as of now, the same answer as the preview's map");
  t.equal(r.beforeAny, undefined, "nothing in-season yet → a continuing (17-week) window");
  t.equal(r.traded, 3, "trades never start a contract"); t.equal(r.auction, undefined, "auction → 17");
  for (const pid of Object.keys(r.map)) t.equal(vm.runInContext(`_acquisitionWeekAsOf(TXS, 2026, '${pid}', 9e12)`, ctx), r.map[pid], "parity for " + pid);
  // both real-charge paths use it, and fail closed on an unreadable export
  const scan = grab('if (path === "/admin/drops/scan-and-record"', "const capYear = _dropPenaltyCapSeason(");
  t.match(scan, /acquisitionWeek: _acquisitionWeekAsOf\(acqTxs, targetSeason, drop\.pid, drop\.ts\)/);
  t.match(scan, /acquisitionWeekUnresolved: acqWeekUnresolved/);
  t.doesNotMatch(scan, /acqWeekMap = _acquisitionWeekMapFromTxs[\s\S]{0,40}\} catch \(_\) \{\}/, "the swallowed read is gone");
  const rc = grab("const recomputeWeek1Iso = recompute", 'if (rc.basis === "week_authority_unresolved")');
  t.match(rc, /acquisitionWeek: _acquisitionWeekAsOf\(recomputeTxs, targetSeason, r\.player_id, Number\(r\.dropped_at_unix\) \|\| 0\)/, "the recompute now passes the acquisition week");
  t.match(rc, /acquisitionWeekUnresolved: recomputeAcqUnresolved/);
});

// ── the Front Office cell ────────────────────────────────────────────
const FO = fs.readFileSync(new URL("../site/rosters/v2/front_office.js", import.meta.url), "utf8");
function foCtx(feed, byPid) {
  const i = FO.indexOf("function isOneKPerYearPlayer(player) {"), j = FO.indexOf("  // Per-Week Earning = current-year salary");
  const k = FO.indexOf("function isWwEarnedNaPlayer(player) {"), l = FO.indexOf("function perWeekEarningValue");
  const ctx = { STATE: { capPenaltyFeed: feed, capPenaltyByPid: byPid }, safeStr: (v) => String(v == null ? "" : v), safeInt: (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); },
    totalContractValueForPlayer: (p) => p.tcv, contractLengthForPlayer: (p) => p.cl, guaranteedContractValueForPlayer: () => 0, money: (n) => "$" + n,
    fmtUSD: (n) => (Number.isFinite(n) ? "$" + n.toLocaleString("en-US") : "—"), result: null };
  vm.createContext(ctx); vm.runInContext(FO.slice(i, j) + "\n" + FO.slice(k, l), ctx);
  return (p) => vm.runInContext(`perWeekEarningInfo(${JSON.stringify(p)})`, ctx);
}
const SHIPLEY = { id: "16601", type: "Vet-WW", tcv: 11000, cl: 1, salary: 11000, years: 1 };
const MEYERS = { id: "17752", type: "Vet-WW", tcv: 6000, cl: 1, salary: 6000, years: 1 };
const AUCTION = { id: "16696", type: "Vet-FAA", tcv: 8000, cl: 1, salary: 8000, years: 1 };

test("FRONT OFFICE: Per Wk = salary ÷ the worker's window — Shipley $846 (not $647), Meyers $462 (not $353), an auction $8K deal $471", async () => {
  const j = await preview();
  const pw = foCtx("ok", j.players);
  t.equal(pw(SHIPLEY).label, "$846"); t.equal(pw(SHIPLEY).sort, 846);
  t.equal(pw(MEYERS).label, "$462");
  t.equal(pw(AUCTION).label, "$471", "17 weeks: $8,000 / 17");
  t.equal(pw({ id: "15000", type: "Vet-WW", tcv: 8000, cl: 1, salary: 8000, years: 1 }).label, "$533", "traded Week-3 pickup: $8,000 / 15");
  t.equal(Math.round(11000 / 17), 647, "(what the column showed)");
});

test("FRONT OFFICE FAIL-CLOSED: no window → no number. Loading shows the loading mark; an unpriced row or a failed batch shows —", async () => {
  t.match(foCtx("pending", null)(SHIPLEY).label, /…<\/span>$/, "before the batch lands: loading, not $647");
  t.match(foCtx("error", null)(SHIPLEY).label, /—<\/span>$/, "batch failed");
  const j = await preview({ failTransactions: true });
  const pw = foCtx("ok", j.players);
  t.match(pw(SHIPLEY).label, /could not be resolved[^<]*">—<\/span>$/, "the worker could not resolve his window");
  t.equal(pw(SHIPLEY).sort, -1);
  t.equal(pw(AUCTION).label, "$471", "an auction row still shows its rate");
  t.match(foCtx("ok", {})(SHIPLEY).label, /—<\/span>$/, "a player missing from the batch");
  // the class labels never needed a window
  t.equal(foCtx("pending", null)({ id: "1", type: "Vet-WW", tcv: 1000, cl: 1, salary: 1000, years: 1 }).label, "1K Per Yr");
  t.equal(foCtx("pending", null)({ id: "3", type: "Vet-WW", tcv: 3000, cl: 1, salary: 3000, years: 1 }).label, "3K Per Yr");
  t.ok(!/Math\.round\(sal \/ 17\)/.test(FO), "no assumed 17-week divisor is left");
});

await run("front_office_per_week_window");
restore();
