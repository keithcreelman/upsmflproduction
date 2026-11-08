// The drop-penalty FALLBACK estimate follows canon §D1's sub-$5K rule, so it never quotes a number the worker would not charge.
//   node tests/drop_penalty_sub_5k_fallback.test.mjs
//
// 2026-11-08: the mobile claim sheet's conditional drop read "Jack Strand · $500 penalty". His contract is Rookie-WW, CL 3, TCV $3K,
// $1K a year, 3 years left. Canon §D1 ("Sub-$5K TCV rule"): TCV of $4,000 or less costs a FLAT $1,000 while more than one year remains,
// and nothing in its final year. The worker said $1,000 (basis full_year_1k_contract). The phone showed its own fallback estimate
// (the worker's batch had not landed yet), which ran guarantee minus per-week earned and drifted with the calendar: $1,000 in September,
// $750 in late October, $500 in November. The sheet also never repainted when the batch arrived, so the wrong number stayed.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadRosterWorkbench } from "./fixtures/roster_workbench_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PENALTY_SRC = read("site/m/front_office_penalty.js");

// A mobile roster row. Strand: Rookie-WW, 3 years left, $1K a year.
const STRAND = { id: "17743", contractYear: "3", salary: "1000", contractInfo: "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K", contractStatus: "Rookie-WW", status: "ROSTER" };

function mobile(nowIso, batch) {
  const RealDate = Date, at = RealDate.parse(nowIso);
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(at); } static now() { return at; } }
  const w = { UPS_MOBILE: { state: { ctx: { leagueId: "74598" }, capPenaltyByPid: batch || null }, data: {} }, fetch: () => new Promise(() => {}), dispatchEvent() {}, Event: class {}, console };
  w.window = w; w.Date = FakeDate;
  vm.createContext(w); vm.runInContext(PENALTY_SRC, w);
  return (row) => w.UPS_FRONT_OFFICE.dropPenaltyFor(row, "2026");
}
const CLOCKS = ["2026-09-20T12:00:00Z", "2026-10-20T12:00:00Z", "2026-11-08T12:00:00Z", "2026-12-20T12:00:00Z", "2027-03-10T12:00:00Z"];

test("mobile fallback: a 3-year $1K-a-year deal is a flat $1,000 on every date (it read $500 on 2026-11-08)", () => {
  for (const iso of CLOCKS) {
    const r = mobile(iso)(STRAND);
    t.equal(r.amount, 1000, `${iso.slice(0, 10)}: ${r.note}`);
  }
});

test("mobile fallback: the rule's other cases (canon §D1) — 2 years left is $1,000, the final year and a 1-year deal are cap-free", () => {
  const est = mobile("2026-11-08T12:00:00Z");
  t.equal(est({ ...STRAND, contractYear: "2" }).amount, 1000, "CL 3 with 2 years left: still more than one year remains");
  t.equal(est({ ...STRAND, contractYear: "1" }).amount, 0, "CL 3 in its final year: cap-free");
  t.equal(est({ ...STRAND, contractYear: "1", contractInfo: "CL 1|TCV 1K|AAV 1K|Y1-1K|GTD: 1K" }).amount, 0, "a 1-year deal: cap-free");
  const two = { id: "9", contractYear: "2", salary: "2000", contractInfo: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K|GTD: 1K", contractStatus: "Vet-FAA", status: "ROSTER" };
  t.equal(est(two).amount, 1000, "a 2-year $2K-a-year deal (TCV $4K, the top of the rule): $1,000");
  t.match(est(two).note, /Flat \$1,000/, "and says why (the $1K-a-year class keeps its own full-year note)");
  t.match(est({ ...two, contractYear: "1" }).note, /final year/);
});

test("mobile fallback: a contract OVER $4K — exact before Sep 1 (75% rounded down, minus years played), 'not priced' from Sep 1 (needs the worker's completed weeks)", () => {
  const big = { id: "11", contractYear: "2", salary: "5000", contractInfo: "CL 2|TCV 10K|AAV 5K|Y1-5K, Y2-5K|GTD: 7.5K", contractStatus: "Vet-FAA", status: "ROSTER" };
  t.equal(mobile("2026-08-15T12:00:00Z")(big).amount, 7500, "$10K total, nothing earned yet: 75% = $7,500");
  const inSeason = mobile("2026-09-20T12:00:00Z")(big);
  t.equal(inSeason.amount, null, "in season: no number of its own"); t.equal(inSeason.unpriced, true);
});

test("mobile: once the worker's batch is loaded, ITS number is shown (the fallback is only for before it lands)", () => {
  const batch = { "17743": { penalty: 1000, guaranteed: 1000, earned: null, tcv: 3000, basis: "full_year_1k_contract", earned_rule: "full_year_sub_5k", exempt: false } };
  const r = mobile("2026-11-08T12:00:00Z", batch)(STRAND);
  t.equal(r.amount, 1000); t.equal(r.authoritative, true);
});

test("desktop Roster Workbench fallback: the same flat $1,000 / final-year $0", () => {
  const { hooks } = loadRosterWorkbench(undefined, { hooks: ["dropPenaltyEstimate"] });
  const p = (years, info) => ({ id: "17743", fid: "0008", name: "Strand", salary: 1000, years, type: "Rookie-WW", special: info, positionGroup: "TE" });
  const info = "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K";
  t.equal(hooks.dropPenaltyEstimate(p(3, info)).amount, 1000);
  t.equal(hooks.dropPenaltyEstimate(p(2, info)).amount, 1000);
  t.equal(hooks.dropPenaltyEstimate(p(1, info)).amount, 0, "final year: cap-free");
  const two = { id: "9", fid: "0008", name: "Two", salary: 2000, years: 2, type: "Vet-FAA", special: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K|GTD: 1K", positionGroup: "WR" };
  t.equal(hooks.dropPenaltyEstimate(two).amount, 1000); t.match(hooks.dropPenaltyEstimate(two).note, /Flat \$1,000/);
});

// ── the claim sheet repaints in place when the worker's numbers arrive ──
function slice(src, sig) {
  const at = src.indexOf(sig); if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
}
test("claim sheet: when the batch lands, the cap-room line and the conditional-drop label are updated in place (no rebuild)", () => {
  const PLAYERS = read("site/m/views/players.js");
  const fn = slice(PLAYERS, "function refreshBidSheetPenalty()");
  const nodes = { "ups-m-bid-advisory-wrap": { innerHTML: "OLD cap room" } };
  const pick = { textContent: "Jack Strand · $500 penalty" };
  let penalty = 500, rebuilt = 0;
  const ctx = vm.createContext({
    bidView: { dropPid: "17743" },
    bidAdvisoryHtml: () => "cap room with $" + penalty,
    nameForPid: () => "Jack Strand",
    dropPenaltyShortText: () => "$" + penalty + " penalty",
    renderBidSheet: () => { rebuilt++; },
    document: { getElementById: (id) => (id === "ups-m-bid-overlay" ? {} : nodes[id] || null), querySelector: () => pick },
  });
  vm.runInContext(fn + "\nthis.refresh = refreshBidSheetPenalty;", ctx);
  penalty = 1000; ctx.refresh();
  t.equal(pick.textContent, "Jack Strand · $1000 penalty", "the label now carries the worker's number");
  t.equal(nodes["ups-m-bid-advisory-wrap"].innerHTML, "cap room with $1000", "and so does the cap-room line");
  t.equal(rebuilt, 0, "the sheet itself is not rebuilt (a bid being typed keeps its focus)");
  // no sheet open → nothing happens
  ctx.document.getElementById = () => null; penalty = 7; ctx.refresh();
  t.equal(pick.textContent, "Jack Strand · $1000 penalty", "closed sheet: untouched");
  // and the batch event is wired to it
  const lis = PLAYERS.slice(PLAYERS.indexOf('addEventListener("ups-cap-penalty-ready"'));
  t.match(lis.slice(0, lis.indexOf("});") + 3), /refreshBidSheetPenalty\(\);/, "the ups-cap-penalty-ready listener calls it");
});

await run("drop_penalty_sub_5k_fallback");
