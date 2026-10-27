// Overview → Cap ledgers (#1338): Player salaries and Salary adjustments regroup the Front Office's own cap
// numbers (currentCapHit, the canon §6 drop-penalty rounding, MFL's salaryAdjustments) and must add back to
// the cap card exactly: active + IR + taxi − relief = player salaries; penalties (rounded) + traded + misc =
// adjustments; the two = total allocated.
//   node tests/fo_cap_ledger.test.mjs
//   FO_CAP_LEDGER_JS=<path> node tests/fo_cap_ledger.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({}); ctx.window = ctx;
vm.runInContext(fs.readFileSync(process.env.FO_CAP_LEDGER_JS || path.join(ROOT, "site/rosters/v2/fo_cap_ledger.js"), "utf8"), ctx);
const CL = ctx.UPS_FO_CAP_LEDGER;
const FO_SRC = fs.readFileSync(path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");

// The rules currentCapHit applies (taxi $0, expired $0, IR half rounded per player); the real function is passed
// in production — this stand-in only feeds the grouping under test.
const capHit = (p) => (p.isTaxi ? 0 : (p.years <= 0 ? 0 : (p.isIr ? Math.round(p.salary * 0.5) : p.salary)));
const roundCut = (n) => Math.round(n / 1000) * 1000;
const team = {
  fid: "0008", name: "Real Deal Creel",
  players: [
    { id: "1", name: "Prescott, Dak", position: "QB", salary: 63000, years: 1 },
    { id: "2", name: "Barkley, Saquon", position: "RB", salary: 45000, years: 1 },
    { id: "3", name: "Shipley, Will", position: "RB", salary: 11000, years: 1, isIr: true },
    { id: "4", name: "Odd, Salary", position: "WR", salary: 2500, years: 2, isIr: true },
    { id: "5", name: "Taxi, Rookie", position: "WR", salary: 1000, years: 3, isTaxi: true },
    { id: "6", name: "Expired, Deal", position: "TE", salary: 4000, years: 0 }
  ],
  summary: { adj_cut: 9135, adj_trade: -7000, adj_other: 1000 }
};
const adj = { cut: 9135, trade: -7000, other: 1000, items: [
  { kind: "Drop", player: "Allen, Zach", amount: 5450, when: "2026-10-15" },
  { kind: "Drop", player: "Hooker, Amani", amount: 3685, when: "2026-10-09" },
  { kind: "Trade", player: "", amount: -12000, when: "2026-09-01" },
  { kind: "Trade", player: "", amount: 5000, when: "2026-09-20" },
  { kind: "Other", player: "", amount: 1000, when: "2026-08-01" }
] };

test("Player salaries: active + IR + taxi, minus relief, = the cap-counting total", () => {
  const led = CL.build(team, { capHit, roundCut, adj });
  const P = led.players;
  const g = Object.fromEntries(P.groups.map((x) => [x.key, x]));
  t.equal(g.active.salary, 63000 + 45000 + 4000); t.equal(g.ir.salary, 13500); t.equal(g.taxi.salary, 1000);
  t.equal(P.grossSalary, 126500);
  const r = Object.fromEntries(P.relief.map((x) => [x.key, x.amount]));
  t.equal(r.ir, -(13500 - 5500 - 1250), "IR: half of each salary, rounded per player (5,500 + 1,250 counted)");
  t.equal(r.taxi, -1000, "taxi off the cap");
  t.equal(r.expired, -4000, "an expired contract counts $0");
  t.equal(P.total, 108000 + 5500 + 1250);
  t.equal(P.grossSalary + P.reliefTotal, P.total, "the groups add back up");
  t.equal(P.total, team.players.reduce((s, p) => s + capHit(p), 0), "= the cap card's Σ currentCapHit");
  t.ok(P.reconciles);
});

test("Salary adjustments: penalties rounded to the nearest $1K (shown as its own line), traded salary ±, misc", () => {
  const led = CL.build(team, { capHit, roundCut, adj });
  const [pen, trd, misc] = led.adjustments.categories;
  t.equal(pen.exact, 9135); t.equal(pen.rounding, -135); t.equal(pen.total, 9000);
  t.equal(pen.itemsTotal, 9135, "the drops add to MFL's exact penalty total");
  t.equal(trd.total, -7000, "a negative traded salary frees cap"); t.equal(trd.itemsTotal, -7000);
  t.equal(misc.total, 1000);
  t.equal(led.adjustments.total, 9000 - 7000 + 1000);
  t.equal(led.allocated, led.players.total + led.adjustments.total, "player salaries + adjustments = total allocated");
  t.ok(led.adjustments.reconciles && led.adjustments.itemized);
});

test("a feed that didn't load is said, not shown as zero items; mismatched items are caught", () => {
  const noFeed = CL.build(team, { capHit, roundCut, adj: null });
  t.equal(noFeed.adjustments.itemized, false); t.equal(noFeed.adjustments.total, 3000, "totals still from the merged summary");
  const bad = CL.build(team, { capHit, roundCut, adj: { ...adj, items: adj.items.slice(1) } });
  t.equal(bad.adjustments.reconciles, false, "a missing item is flagged");
});

test("Front Office passes its own cap engine (no second copy of the math)", () => {
  t.ok(/L\.build\(team, \{ capHit: currentCapHit, roundCut: roundToK, adj: adj \}\)/.test(FO_SRC), "capLedger uses currentCapHit and roundToK");
  t.ok(/function capAdjDropPen\(s\) \{ return roundToK\(/.test(FO_SRC), "the cap card rounds penalties with the same roundToK");
  t.ok(/STATE\.adjFeedOk = !!mflAdj\.ok/.test(FO_SRC), "whether MFL's feed loaded is recorded");
});

await run("fo_cap_ledger");
