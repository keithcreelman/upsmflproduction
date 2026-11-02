// Projected ROS PPG, week by week (site/shared/trade_fit.js buildWeekly, "ROS availability A", Keith 2026-10-30, #1435):
// a best lineup for each remaining week, averaged. A hurt player counts from his return, a bye is a hole for that week,
// a taxi player counts only for a team receiving him. Synthetic leagues pin the rules; the 2026 Week-6 fixture pins
// that the weekly path agrees with the season path when every week is the same.
//   node tests/trade_fit_weekly.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({}); ctx.window = ctx;
for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/lineup_strength.js", "site/shared/trade_finder_core.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH, C = ctx.UPS_TRADE_FINDER;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
const STARTERS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/mfl_league_starters_74598_2026.json"), "utf8")).starters;
const slots = TF.deriveSlots(STARTERS);
const near = (a, b, msg) => t.ok(Math.abs(a - b) < 1e-9, (msg || "") + " " + a + " vs " + b);

function team(fid, extra = []) {
  const P = (pid, pos, v, more) => Object.assign({ pid: fid + pid, pos, status: "ROSTER", chip: "" }, more || {}, { _v: v });
  const players = [
    P("qb1", "QB", 20), P("qb2", "QB", 15), P("rb1", "RB", 14), P("rb2", "RB", 12), P("rb3", "RB", 9),
    P("wr1", "WR", 14), P("wr2", "WR", 12), P("wr3", "WR", 9), P("te1", "TE", 10), P("k", "PK", 9), P("p", "PN", 8),
    P("dl1", "DE", 8), P("dl2", "DT", 7), P("lb1", "LB", 8), P("lb2", "LB", 7), P("db1", "CB", 9), P("db2", "S", 8), P("db3", "S", 7.5),
  ].concat(extra.map((x) => P(x[0], x[1], x[2], x[3])));
  return { fid, name: "Team " + fid, players };
}
// weeks: an array of {pid: number to use that week, or null for no number}; everyone else keeps his own value.
function league(teams, weeks) {
  const base = {}, freeAgents = [];
  teams.forEach((tm) => tm.players.forEach((p) => { base[p.pid] = p._v; }));
  for (const pos of ["QB", "RB", "WR", "TE", "PK", "PN", "DE", "LB", "CB"]) for (let i = 0; i < 14; i++) { const pid = "fa" + pos + i; freeAgents.push({ pid, pos }); base[pid] = 1; }
  const list = weeks.map((w, i) => {
    const values = Object.assign({}, base);
    Object.keys(w).forEach((pid) => { if (w[pid] == null) delete values[pid]; else values[pid] = w[pid]; });
    return { week: 8 + i, values };
  });
  return TF.buildWeekly({ teams, weeks: list, values: base, freeAgents, slots });
}

test("every week the same = the season model when nobody is taxi or hurt: totals, tables, gains and costs", () => {
  const teams = FX.teams.map((tm) => ({ ...tm, players: tm.players.filter((p) => TF.availableNow(p) && p.pid in FX.values) }));
  const values = {};
  teams.forEach((tm) => tm.players.forEach((p) => { values[p.pid] = FX.values[p.pid]; }));
  FX.freeAgents.forEach((p) => { if (p.pid in FX.values) values[p.pid] = FX.values[p.pid]; });
  const S = TF.buildLeague({ teams, values, freeAgents: FX.freeAgents, slots });
  const W = TF.buildWeekly({ teams, weeks: [8, 9, 10].map((week) => ({ week, values })), values, freeAgents: FX.freeAgents, slots });
  const me = S.order[0];
  for (const f of S.order) near(S.teams[f].total, W.teams[f].total, f);
  for (const by of ["position", "slot"]) {
    const a = LS.build(S, { by }), b = LS.build(W, { by });
    for (const f of S.order) for (const r of a.rows) {
      near(a.teams[f][r].ppg, b.teams[f][r].ppg, f + r); near(a.teams[f][r].above, b.teams[f][r].above, f + r); t.equal(a.teams[f][r].rank, b.teams[f][r].rank);
    }
  }
  const a = TF.lineupGains(S, me), b = TF.lineupGains(W, me);
  t.equal(JSON.stringify(a), JSON.stringify(b), "the same gains in the same order");
  const x = a.forMe[0];
  near(TF.tradeLineup(S, x.fid, [x.pid], []).total, TF.tradeLineup(W, x.fid, [x.pid], []).total, "the same cost");
});

test("a hurt player counts from his return: his team's total and another team's gain are each week's, averaged", () => {
  const a = team("a", [["wr9", "WR", 30, { status: "INJURED_RESERVE", chip: "IR" }]]), b = team("b");
  const M = league([a, b], [{ awr9: null }, { awr9: null }, { awr9: 30 }, { awr9: 30 }]);
  const wk = (w) => TF.buildLeague({ teams: [a, b], values: M.weekly[w].values, freeAgents: [], slots, oneWeek: true });
  near(M.teams.a.total, M.weekly.reduce((s, X) => s + X.teams.a.total, 0) / 4, "average of the weeks");
  t.ok(M.weekly[2].teams.a.total > M.weekly[0].teams.a.total, "the weeks he's back are higher");
  t.equal(M.teams.a.starterIds.awr9, 2, "starts the two weeks he's back");
  const gain = TF.addGain(M, "b", { pid: "awr9", pos: "WR" });
  near(gain, (TF.addGain(M.weekly[2], "b", { pid: "awr9", pos: "WR" }) + TF.addGain(M.weekly[3], "b", { pid: "awr9", pos: "WR" })) / 4, "gain counts only his weeks, over all four");
  t.ok(gain > 0 && wk(0).teams.a.total === M.weekly[0].teams.a.total, "the same week rebuilt alone agrees");
  const list = TF.lineupGains(M, "b", { minGain: 0.1 }).forMe.filter((x) => x.pid === "awr9");
  t.equal(list.length, 1, "IR with a return is listed");
});

test("a week with no number is a hole: he can't fill a slot at 0 ahead of the bench or a replacement", () => {
  const a = team("a"), b = team("b");
  const M = league([a, b], [{ ak: null }, {}]);
  const s = M.weekly[0].teams.a.best.starters.find((x) => x.slot === "PK1");
  t.ok(s.rep && s.v === 1, "the bye week's kicker is a replacement, not the rostered kicker at 0");
  t.ok(!M.weekly[0].teams.a.starterIds.ak, "not in that week's lineup");
  const c = league([team("a", [["te2", "TE", 6]]), team("b")], [{ ate1: null }, {}]);
  t.equal(c.weekly[0].teams.a.best.starters.find((x) => x.slot === "TE1").pid, "ate2", "the bench fills a bye");
  t.equal(c.teams.a.starterIds.ate1, 1); t.equal(c.teams.a.starterIds.ate2, 1, "TE2 starts only the bye");
});

test("taxi: never in his own team's lineup, his team loses nothing, and he counts for a team receiving him", () => {
  const a = team("a", [["rb9", "RB", 40, { status: "TAXI_SQUAD" }]]), b = team("b");
  const M = league([a, b], [{}, {}]);
  t.ok(!M.teams.a.starterIds.arb9, "not in his own lineup");
  near(M.teams.a.total, TF.tradeLineup(M, "a", ["arb9"], []).total, "his team's lineup doesn't change without him");
  t.ok(TF.addGain(M, "b", { pid: "arb9", pos: "RB" }) > 10, "he counts for the team receiving him");
  const R = TF.tradeLineup(M, "b", [], [{ pid: "arb9", pos: "RB", status: "TAXI_SQUAD" }]);
  t.ok(R.total > M.teams.b.total); t.deepEqual(Array.from(R.notCounted), []);
  const O = C.positionOptions(M, LS.build(M), TF.lineupGains(M, "b"), "RB", TF);
  const x = O.surplus.find((r) => r.pid === "arb9");
  t.ok(x && x.bench && x.taxi && x.loss === 0, "Them 0, marked taxi");
});

test("no number in any week: no gain, never listed, named as not counted", () => {
  const a = team("a", [["wr9", "WR", 30, { status: "INJURED_RESERVE", chip: "IR" }]]), b = team("b");
  const M = league([a, b], [{ awr9: null }, { awr9: null }]);
  t.equal(TF.addGain(M, "b", { pid: "awr9", pos: "WR" }), 0);
  t.ok(!TF.lineupGains(M, "b", { minGain: 0 }).forMe.some((x) => x.pid === "awr9"), "not listed");
  t.deepEqual(Array.from(TF.tradeLineup(M, "b", [], [{ pid: "awr9", pos: "WR" }]).notCounted), ["awr9"]);
});

test("the table: each week's lineup averaged, rows add up to Overall, a Flex starter stays under his own position", () => {
  const M = league([team("a", [["te2", "TE", 13]]), team("b")], [{ ate2: null }, {}]);
  for (const by of ["position", "slot"]) {
    const T = LS.build(M, { by });
    for (const f of T.order) {
      near(T.teams[f].ALL.ppg, M.teams[f].total, by + " Overall = the model's total");
      const sum = T.rows.filter((r) => r !== "ALL").reduce((s, r) => s + T.teams[f][r].ppgShown, 0);
      t.ok(Math.abs(sum - T.teams[f].ALL.ppgShown) < 1e-6, by + " shown rows add up");
    }
  }
  const P = LS.build(M, { by: "position" }), one = LS.build(M.weekly[1], { by: "position" }), zero = LS.build(M.weekly[0], { by: "position" });
  near(P.teams.a.TE.ppg, (one.teams.a.TE.ppg + zero.teams.a.TE.ppg) / 2, "TE row");
  t.equal(P.teams.a.TE.rank, 1);
});

test("a replacement is marked only when he fills a slot in most weeks; the popup list says how many weeks each player starts", () => {
  const M = league([team("a"), team("b")], [{ ak: null }, {}, {}]);
  const T = LS.build(M, { by: "position" });
  t.equal(T.teams.a.PK.replacementStarters, 0, "one bye isn't a hole in the roster");
  const K = LS.modeledStarters(M, "a", "PK");
  t.deepEqual(Array.from(K, (s) => [s.pid, s.depth, s.rep]), [["ak", "2 of 3 wks", false], ["", "1 of 3 wks", true]]);
  near(K[0].v, 6, "his points per remaining week in the lineup"); t.equal(K[0].ppg, 9, "and his own number");
  const H = league([team("a"), team("b")], [{ ak: null }, { ak: null }, {}]);
  t.equal(LS.build(H, { by: "position" }).teams.a.PK.replacementStarters, 1, "two weeks of three is most");
});

test("surplus: healthy players starting under half the weeks who would help another team; a starter isn't one", () => {
  const a = team("a", [["rb4", "RB", 13]]), b = team("b");
  const M = league([a, b], [{ arb2: 0 }, {}, {}, {}]);
  t.equal(M.teams.a.surplus, null, "not built until read");
  const S = TF.surplusFor(M, "a");
  t.ok(!S.some((x) => x.pid === "arb1"), "a starter isn't surplus");
  t.equal(TF.surplusFor(M, "a"), S, "read once");
  t.ok(S.every((x) => (M.teams.a.starterIds[x.pid] || 0) < 2));
  const base = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots });
  t.equal(TF.surplusFor(base, base.order[0]), base.teams[base.order[0]].surplus, "a season model's list is its own");
});

test("the 1-for-1 and typical-starter math refuses a weekly model instead of answering on one week", () => {
  const M = league([team("a"), team("b")], [{}, {}]);
  for (const fn of [() => TF.pairFits(M, "a", "b"), () => TF.additionDetail(M, "a", "RB"), () => TF.teamSummary(M, "a"), () => TF.swapLineup(M, "a", "arb1", { pid: "brb1", pos: "RB" }), () => TF.swapGain(M, "a", "arb1", { pid: "brb1", pos: "RB" })]) {
    let threw = false;
    try { fn(); } catch (e) { threw = /weekly model/.test(e.message); }
    t.ok(threw);
  }
  t.equal(TF.buildWeekly({ teams: [], weeks: [] }), null, "no weeks, no model");
});

test("rosWeeks: a week with a game played is left out; each week holds only that week's numbers", () => {
  const f = { weeks: [8, 10], nWeeks: 3, playedExcluded: { 8: ["CAR", "GBP"] }, weekly: { 1: [5, null, 7], 2: [null, 3, 4], 3: [1, 1, 1] } };
  const W = C.rosWeeks(f, { 3: 1 });
  t.deepEqual(Array.from(W, (x) => x.week), [9, 10]);
  t.deepEqual(JSON.parse(JSON.stringify(W[0].values)), { 2: 3 }, "no number, no entry; a ruled-out player has none");
  t.deepEqual(JSON.parse(JSON.stringify(W[1].values)), { 1: 7, 2: 4 });
  t.deepEqual(Array.from(C.rosWeeks({ ...f, playedExcluded: {} }), (x) => x.week), [8, 9, 10], "nothing played, every week");
  t.deepEqual(Array.from(C.rosWeeks({ ...f, playedExcluded: { 8: [], 9: ["BUF"] } }), (x) => x.week), [8, 10], "an empty list isn't a played week");
});

test("rosRuledOut: MFL lists him out and the file has no reason why: no week counts until a build sees it", () => {
  const f = { avail: { 2: { k: "back", wk: 12 }, 7: { k: "back", wk: 9 } } };
  const teams = [{ players: [{ pid: "1", status: "ROSTER", chip: "OUT" }, { pid: "2", status: "INJURED_RESERVE", chip: "IR" }, { pid: "3", status: "ROSTER", chip: "Q" }, { pid: "4", status: "TAXI_SQUAD", chip: "" },
    { pid: "5", status: "TAXI_SQUAD", chip: "IR" }, { pid: "6", status: "INJURED_RESERVE", chip: "" }, { pid: "7", status: "TAXI_SQUAD", chip: "IR" }] }];
  t.deepEqual(JSON.parse(JSON.stringify(C.rosRuledOut(f, teams, TF.availableNow))), { 1: 1, 5: 1, 6: 1 });
});

test("rosTags: what each case says, and whether he adds anything", () => {
  const f = { avail: { 1: { k: "back", wk: 12 }, 2: { k: "back", wk: 12 }, 3: { k: "back", wk: null }, 4: { k: "none" } }, weekly: { 1: [1] } };
  const tags = (pid, status, out) => JSON.parse(JSON.stringify(C.rosTags(f, { pid, status }, out || {})));
  t.deepEqual(tags("1", "ROSTER"), [{ text: "Back Wk 12 (MFL)", counted: true }]);
  t.deepEqual(tags("2", "ROSTER"), [{ text: "Return listed, no projection", counted: false }]);
  t.deepEqual(tags("3", "ROSTER"), [{ text: "Return listed, no projection", counted: false }], "a return after the last week");
  t.deepEqual(tags("4", "ROSTER"), [{ text: "No return on file", counted: false }]);
  t.deepEqual(tags("5", "TAXI_SQUAD"), [{ text: "Taxi", counted: true }]);
  t.deepEqual(tags("1", "TAXI_SQUAD").map((x) => x.text), ["Back Wk 12 (MFL)", "Taxi"], "taxi and hurt");
  t.deepEqual(tags("6", "ROSTER"), [], "healthy");
  t.deepEqual(tags("6", "ROSTER", { 6: 1 }), [{ text: "Status changed: not counted", counted: false }]);
});

run();
