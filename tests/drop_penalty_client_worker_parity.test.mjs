// Every screen that can show a drop penalty shows what the WORKER and CANON say — or says "not priced yet". Never a different number.
//   node tests/drop_penalty_client_worker_parity.test.mjs
//
// Keith 2026-11-08: "make sure that everything shows the same as the worker and canon across everything." The worker's
// _computeDropPenalty (worker/src/index.js) is the one implementation that charges a drop (it also backs /api/cap-penalty/preview). Each
// client keeps a LOCAL estimate for the moment before the worker's batch lands. This file runs the REAL worker function and every real client
// estimate over the same contracts on the same days and fails on any disagreement:
//   • mobile            site/m/front_office_penalty.js           dropPenaltyFor
//   • desktop Workbench site/rosters/roster_workbench.js         dropPenaltyEstimate
//   • shared cap_math   site/shared/cap_math.js                  UPS_CAP_MATH.dropPenalty  (Team Operations, player profile, mobile contracts)
//   • desktop Front Office v2 keeps NO local estimate (loading / unavailable until the batch lands) — asserted below.
// Rules the matrix enforces:
//   - a rule that needs no calendar (taxi / tag / cap-free classes, the flat $1,000 sub-$5K rule) must equal the worker on every day;
//   - guarantee minus earned needs MFL's completed-week count, which only the worker has: it must equal the worker before Sep 1 of the
//     season (nothing earned yet) and be "not priced" (null / NaN, never a number) from Sep 1 on.
// Before this file the clients ran a legacy calendar-quarter curve (a $10K final-year deal read $0 on Nov 8, the worker said $294), rounded the
// guarantee from a 0.1K token, missed the WW-final-year cap-free rule and quoted Jack Strand's flat $1,000 as $500.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadRosterWorkbench } from "./fixtures/roster_workbench_harness.mjs";
import { loadFrontOfficeV2 } from "./fixtures/front_office_v2_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── the REAL worker function, cut out of worker/src/index.js by text (same discipline as tests/cap_penalty_canon.test.mjs) ──
const src = read("worker/src/index.js");
const grab = (a, b) => { const i = src.indexOf(a); if (i < 0) throw new Error("not found: " + a); const j = src.indexOf(b, i); if (j < 0) throw new Error("end not found: " + a); return src.slice(i, j + b.length); };
const parseFn = grab("const _parseContractData =", "return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned, weekAuthorityUnresolved, eligibleWeeks, currentYearSalary };\n        };");
const compFn = grab("const _computeDropPenalty =", 'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };');
const href = (p) => pathToFileURL(path.join(ROOT, p)).href;
const prelude = `
import { applyFullYearRule, classifyWwEarnedNa, isSubFiveKMultiYearFlat, WW_EARNED_NA_BASIS } from "${href("worker/src/fcfs_contract.js")}";
import { taxiEligibility, taxiCutVerdict } from "${href("worker/src/taxi_rule.js")}";
const safeStr=(v)=>v==null?"":String(v);
const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);};
const _nflWeekForUnix=()=>0;
const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=(year)=>{const y=Number(year)||0;if(!y)return "";const sept1=new Date(Date.UTC(y,8,1));const firstMonday=1+((8-sept1.getUTCDay())%7);const kickoff=new Date(Date.UTC(y,8,firstMonday+3));return kickoff.toISOString().slice(0,10);};
`;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drop-parity-")), "worker_penalty.mjs");
fs.writeFileSync(tmp, prelude + parseFn + "\n" + compFn + "\nexport {_computeDropPenalty};");
const { _computeDropPenalty } = await import(pathToFileURL(tmp).href);

// ── clocks ──
const RealDate = Date, DAY = 86400000, WEEK1 = RealDate.parse("2026-09-09T00:00:00Z");
const fakeDate = (iso) => { const at = RealDate.parse(iso); return class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(at); } static now() { return at; } }; };
const completedWeeks = (iso) => Math.max(0, Math.floor((RealDate.parse(iso) - WEEK1) / (7 * DAY)));
function workerAt(iso, row) {   // the worker's own answer for that day (its `new Date()` pinned too: the tag rule reads the clock)
  globalThis.Date = fakeDate(iso);
  try {
    return _computeDropPenalty({ contractStatus: row.status, salary: row.salary, contractInfo: row.info, contractYear: String(row.cy), isTaxi: false },
      { season: "2026", dropDateIso: iso, week1ThursdayIso: "2026-09-09", completedPayableWeeks: completedWeeks(iso), acquisitionWeek: /WW/.test(row.status) && row.salary >= 5000 ? 5 : undefined });
  } finally { globalThis.Date = RealDate; }
}
const PRE_SEASON = ["2026-07-15T12:00:00Z", "2026-08-15T12:00:00Z", "2026-08-31T12:00:00Z"];   // before Sep 1: nothing of the season is earned
const IN_SEASON = ["2026-09-01T12:00:00Z", "2026-10-20T12:00:00Z", "2026-11-08T12:00:00Z", "2026-12-20T12:00:00Z"];

// ── contracts ──
const ci = (cl, ys) => { const tcv = ys.reduce((a, b) => a + b, 0); return `CL ${cl}|TCV ${tcv / 1000}K|AAV ${Math.round(tcv / cl / 1000)}K|${ys.map((y, i) => "Y" + (i + 1) + "-" + y / 1000 + "K").join(", ")}|GTD: ${Math.round(tcv * 0.75 / 100) / 10}K`; };
const ROWS = [
  ["Jack Strand: Rookie-WW CL3 $1K/yr, 3 left", "Rookie-WW", 1000, 3, ci(3, [1000, 1000, 1000])],
  ["Rookie-WW CL3 $1K/yr, 2 left", "Rookie-WW", 1000, 2, ci(3, [1000, 1000, 1000])],
  ["Rookie-WW CL3 $1K/yr, final year", "Rookie-WW", 1000, 1, ci(3, [1000, 1000, 1000])],
  ["Vet-WW CL1 $1K", "Vet-WW", 1000, 1, ci(1, [1000])],
  ["Vet-WW CL1 $3K", "Vet-WW", 3000, 1, ci(1, [3000])],
  ["Vet-FAA CL1 $4K", "Vet-FAA", 4000, 1, ci(1, [4000])],
  ["Vet-FAA CL2 $2K/yr (TCV $4K), 2 left", "Vet-FAA", 2000, 2, ci(2, [2000, 2000])],
  ["Vet-FAA CL2 $2K/yr (TCV $4K), final year", "Vet-FAA", 2000, 1, ci(2, [2000, 2000])],
  ["Vet-WW CL2 TCV $6K $3K/yr, final year (WW <= $4K)", "Vet-WW", 3000, 1, ci(2, [3000, 3000])],
  ["Vet-WW CL2 TCV $6K $3K/yr, 2 left", "Vet-WW", 3000, 2, ci(2, [3000, 3000])],
  ["Vet-FAA CL1 $10K", "Vet-FAA", 10000, 1, ci(1, [10000])],
  ["Vet-FAA CL2 $10K/yr, 2 left", "Vet-FAA", 10000, 2, ci(2, [10000, 10000])],
  ["Vet-FAA CL2 $10K/yr, final year", "Vet-FAA", 10000, 1, ci(2, [10000, 10000])],
  ["Vet-FAA CL3 $20K/yr, 2 left", "Vet-FAA", 20000, 2, ci(3, [20000, 20000, 20000])],
  ["Vet-WW CL1 $6K (WW above $4K)", "Vet-WW", 6000, 1, ci(1, [6000])],
  ["Vet-Ext1 CL2 $30K then $40K, final year", "Vet-Ext1", 40000, 1, "CL 2|TCV 70K|AAV 30K, 40K|Y1-30K, Y2-40K|GTD: 52.5K"],
  ["TAG $41K (GTD token rounded to 0.1K)", "TAG", 41000, 1, ci(1, [41000])],
];

// ── the clients, each on a pinned day ──
function mobileAt(iso) {
  const w = { UPS_MOBILE: { state: { ctx: { leagueId: "74598" }, capPenaltyByPid: null }, data: {} }, fetch: () => new Promise(() => {}), dispatchEvent() {}, Event: class {}, console };
  w.window = w; w.Date = fakeDate(iso); vm.createContext(w); vm.runInContext(read("site/m/front_office_penalty.js"), w);
  return (r) => { const e = w.UPS_FRONT_OFFICE.dropPenaltyFor({ id: "1", contractYear: String(r.cy), salary: String(r.salary), contractInfo: r.info, contractStatus: r.status, status: "ROSTER" }, "2026"); return e.unpriced ? null : e.amount; };
}
function desktopAt(iso) {
  const { hooks } = loadRosterWorkbench(undefined, { hooks: ["dropPenaltyEstimate"], nowIso: iso });
  return (r) => { const e = hooks.dropPenaltyEstimate({ id: "1", fid: "0008", name: "x", salary: r.salary, years: r.cy, type: r.status, special: r.info, positionGroup: "WR" }); return e.unpriced || Number.isNaN(e.amount) ? null : e.amount; };
}
function capMathAt(iso) {
  const w = { console, fetch: () => new Promise(() => {}) }; w.window = w; w.Date = fakeDate(iso); vm.createContext(w); vm.runInContext(read("site/shared/cap_math.js"), w);
  return (r) => { const p = w.UPS_CAP_MATH.dropPenalty({ id: "1", contractInfo: r.info, contractYear: String(r.cy), salary: String(r.salary), contractStatus: r.status }, { season: "2026" }); return p == null ? null : p; };
}
const CLIENTS = { mobile: mobileAt, "desktop Roster Workbench": desktopAt, "shared cap_math": capMathAt };
const weekly = (w) => w.basis === "guarantee_minus_earned" || w.basis === "no_penalty_zero";   // the worker needed the completed-week count

for (const [name, make] of Object.entries(CLIENTS)) {
  test(`${name}: equals the worker before Sep 1 (every contract); from Sep 1 equals it or says 'not priced' (never a different number)`, () => {
    let compared = 0;
    for (const iso of [...PRE_SEASON, ...IN_SEASON]) {
      const est = make(iso);
      for (const [label, status, salary, cy, info] of ROWS) {
        const row = { status, salary, cy, info };
        const w = workerAt(iso, row), c = est(row), day = iso.slice(0, 10), ctx = `${name} | ${day} | ${label} | worker ${w.penalty} (${w.basis}) | client ${c}`;
        if (PRE_SEASON.includes(iso) || !weekly(w)) t.equal(c, w.penalty, ctx);           // a calendar-free rule, or nothing earned yet: the same number
        else t.equal(c, null, ctx + " — needs the worker's completed-week count: must be 'not priced'");
        compared++;
      }
    }
    t.equal(compared, 7 * ROWS.length, "every day × contract was compared");
  });
}

test("desktop Front Office v2 keeps NO local estimate: loading / unavailable until the worker's number lands, never a figure of its own", () => {
  const { hooks } = loadFrontOfficeV2(undefined, { hooks: ["dropPenaltyEstimate"] });
  const strand = { id: "17743", name: "Strand", salary: 1000, years: 3, type: "Rookie-WW", special: ci(3, [1000, 1000, 1000]) };
  for (const feed of ["pending", "error"]) {
    hooks.STATE.capPenaltyFeed = feed; hooks.STATE.capPenaltyByPid = null;
    const e = hooks.dropPenaltyEstimate(strand);
    t.ok(Number.isNaN(e.amount), `${feed}: no number`); t.equal(e.earnedState, feed === "pending" ? "pending" : "unavailable");
  }
  hooks.STATE.capPenaltyFeed = "ok";
  hooks.STATE.capPenaltyByPid = { "17743": { penalty: 1000, guaranteed: 1000, earned: null, tcv: 3000, basis: "full_year_1k_contract", earned_rule: "full_year_sub_5k", exempt: false } };
  t.equal(hooks.dropPenaltyEstimate(strand).amount, 1000, "once loaded, the worker's $1,000");
});

test("the fixture matrix covers every worker class (so a new class can't slip past unchecked)", () => {
  const bases = new Set(); for (const iso of [...PRE_SEASON, ...IN_SEASON]) for (const [, status, salary, cy, info] of ROWS) bases.add(workerAt(iso, { status, salary, cy, info }).basis);
  for (const b of ["tcv_under_5k_flat", "tcv_under_5k_final_year_exempt", "one_year_under_5k_exempt", "guarantee_minus_earned", "tag_pre_auction_exempt"]) t.ok(bases.has(b) || [...bases].some((x) => x.includes(b.split("_")[0])), "covers " + b);
  t.ok([...bases].some((b) => /^(full_year_1k_contract|ww_under_5k)/.test(b)), "covers the WW / $1K-a-year classes");
});

await run("drop_penalty_client_worker_parity");
