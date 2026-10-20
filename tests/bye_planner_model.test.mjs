// Bye planner model (site/shared/bye_planner.js): week-by-week 18-slot coverage, real holes, bye cost, options.
//   node tests/bye_planner_model.test.mjs
//   BYE_PLANNER_JS=<path> node tests/bye_planner_model.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({}); ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/m/front_office_lineup.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(process.env.BYE_PLANNER_JS || path.join(ROOT, "site/shared/bye_planner.js"), "utf8"), ctx);
const BP = ctx.UPS_BYE_PLANNER;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
const BYES = BP.byesFromMfl(JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/nfl_bye_weeks_2026.json"), "utf8")));

const P = (pid, pos, team, v, extra) => Object.assign({ pid, pos, nflTeam: team, status: "ROSTER", chip: "", _v: v }, extra || {});
function roster() {
  return [P("qb1", "QB", "BUF", 20), P("qb2", "QB", "DET", 15), P("rb1", "RB", "SFO", 14), P("rb2", "RB", "MIA", 12), P("rb3", "RB", "BUF", 9),
    P("wr1", "WR", "BUF", 14), P("wr2", "WR", "DAL", 12), P("wr3", "WR", "GBP", 9), P("te1", "TE", "BUF", 10), P("k", "PK", "BUF", 9), P("p", "PN", "NYG", 8),
    P("dl1", "DE", "PIT", 8), P("dl2", "DT", "CLE", 7), P("lb1", "LB", "SEA", 8), P("lb2", "LB", "KCC", 7), P("db1", "CB", "DAL", 9), P("db2", "S", "GBP", 8), P("db3", "S", "NOS", 7.5)];
}
const vals = (rows) => Object.fromEntries(rows.map((r) => [r.pid, r._v]));

test("a bye that leaves no eligible player is an empty slot; one with a backup is only a cost", () => {
  const rows = roster();
  const plan = BP.plan({ players: rows, values: vals(rows), byeWeekByTeam: { BUF: 7 }, fromWeek: 6, toWeek: 8, currentWeek: 6, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  const w7 = plan.weeks.find((w) => w.week === 7);
  t.equal(JSON.stringify([...w7.empty].sort()), JSON.stringify(["OF1", "OF2", "PK1", "SF1", "TE1"]),
    "Week 7 (BUF bye: QB1, RB3, WR1, TE, K): no TE or K, and nobody left for the two Flex spots or the SuperFlex");
  t.ok(w7.cost > 0, "and the lineup loses points: " + w7.cost);
  t.ok(!w7.empty.includes("QB1"), "QB2 covers the QB1 bye");
  t.equal(JSON.stringify(plan.shortWeeks), "[7]", "only Week 7 is short");
  t.equal(plan.weeks.find((w) => w.week === 6).cost, 0, "a week with no byes costs nothing");
  t.ok(w7.startersOut.length >= 4, "4+ likely starters on the Week-7 bye");
});

test("taxi and IR never start; a lasting designation holds every week; OUT only this week", () => {
  const rows = roster();
  rows.find((r) => r.pid === "te1").status = "TAXI_SQUAD";
  rows.find((r) => r.pid === "k").status = "INJURED_RESERVE";
  rows.find((r) => r.pid === "rb1").chip = "OUT";
  rows.find((r) => r.pid === "dl1").chip = "SUSP";
  const plan = BP.plan({ players: rows, values: vals(rows), byeWeekByTeam: {}, fromWeek: 6, toWeek: 7, currentWeek: 6, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  const [w6, w7] = plan.weeks;
  t.ok(w6.empty.includes("TE1") && w7.empty.includes("TE1"), "taxi TE: empty both weeks");
  t.ok(w6.empty.includes("PK1") && w7.empty.includes("PK1"), "IR K: empty both weeks");
  t.ok(w6.out.some((o) => o.pid === "rb1" && o.reason === "injury"), "OUT RB is out this week");
  t.ok(!w7.out.some((o) => o.pid === "rb1"), "…and not assumed out next week");
  t.ok(w7.out.some((o) => o.pid === "dl1" && o.reason === "injury"), "a suspension holds next week too");
});

test("options for a short week are free agents with a game that week, best first", () => {
  const rows = roster();
  const fas = [{ pid: "fa_te_buf", pos: "TE", nflTeam: "BUF" }, { pid: "fa_te_den", pos: "TE", nflTeam: "DEN" }, { pid: "fa_te_hou", pos: "TE", nflTeam: "HOU" }];
  const v = Object.assign(vals(rows), { fa_te_buf: 12, fa_te_den: 6, fa_te_hou: 8 });
  const plan = BP.plan({ players: rows, values: v, byeWeekByTeam: { BUF: 7 }, fromWeek: 7, toWeek: 7, currentWeek: 7, freeAgents: fas, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  t.equal(JSON.stringify(plan.weeks[0].options.TE.map((o) => o.pid)), JSON.stringify(["fa_te_hou", "fa_te_den"]), "the BUF TE is on the same bye; HOU before DEN by value");
});

test("real 2026 data: Real Deal Creel's only kicker (JAC) and one healthy DL (BUF) are on Week-7 byes", () => {
  const team = FX.teams.find((x) => x.fid === "0008");
  const plan = BP.plan({ players: team.players, values: FX.values, byeWeekByTeam: BYES, fromWeek: 7, toWeek: 9, currentWeek: 7, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  t.equal(BYES.JAC, 7); t.equal(BYES.BUF, 7); t.equal(BYES.TEN, 9);
  const w7 = plan.weeks.find((w) => w.week === 7), w9 = plan.weeks.find((w) => w.week === 9);
  t.ok(w7.empty.includes("PK1"), "Week 7: no kicker");
  t.equal(w7.emptyGroups.DL, 1, "Week 7: one DL slot empty (Rousseau BUF bye, Pearce IR, Young taxi)");
  t.ok(w9.empty.includes("PN1"), "Week 9: punter Townsend (TEN) on a bye");
});

await run("bye_planner_model");
