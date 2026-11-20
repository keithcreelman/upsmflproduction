// Trade fit model (site/shared/trade_fit.js): strength, need, surplus and 1-for-1 fits in points a week of the
// league's real 18-slot lineup. Synthetic leagues pin the rules; the 2026 Week-6 fixture (MFL's own data) pins
// the behavior on a real league.
//   node tests/trade_fit_model.test.mjs
//   TRADE_FIT_JS=<path> node tests/trade_fit_model.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({}); ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/m/front_office_lineup.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(process.env.TRADE_FIT_JS || path.join(ROOT, "site/shared/trade_fit.js"), "utf8"), ctx);
const TF = ctx.UPS_TRADE_FIT;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));

// A full, healthy 18 plus a bench, with values chosen so every slot is obvious.
function base(fid, over = {}) {
  const P = (pid, pos, v, extra) => Object.assign({ pid, pos, status: "ROSTER", chip: "", salary: 1000 }, extra || {}, { _v: v });
  const players = [
    P(fid + "qb1", "QB", 20), P(fid + "qb2", "QB", 15),
    P(fid + "rb1", "RB", 14), P(fid + "rb2", "RB", 12), P(fid + "rb3", "RB", 9),
    P(fid + "wr1", "WR", 14), P(fid + "wr2", "WR", 12), P(fid + "wr3", "WR", 9),
    P(fid + "te1", "TE", 10), P(fid + "k", "PK", 9), P(fid + "p", "PN", 8),
    P(fid + "dl1", "DE", 8), P(fid + "dl2", "DT", 7), P(fid + "lb1", "LB", 8), P(fid + "lb2", "LB", 7),
    P(fid + "db1", "CB", 9), P(fid + "db2", "S", 8), P(fid + "db3", "S", 7.5),
  ];
  return { fid, name: "Team " + fid, players: (over.players || players) };
}
function league(teams, faValue = 1) {
  const values = {}, freeAgents = [];
  teams.forEach((tm) => tm.players.forEach((p) => { values[p.pid] = p._v; }));
  for (const pos of ["QB", "RB", "WR", "TE", "PK", "PN", "DE", "LB", "CB"]) {
    for (let i = 0; i < 14; i++) { const pid = "fa" + pos + i; freeAgents.push({ pid, pos }); values[pid] = faValue; }
  }
  return { teams, values, freeAgents, lineup: ctx.UPS_FRONT_OFFICE_LINEUP };
}

test("lineup: 18 legal slots; the second QB starts at SuperFlex; flex takes the best RB/WR/TE left", () => {
  const m = TF.buildLeague(league([base("A")]));
  const s = m.teams.A.best.slots;
  t.equal(Object.values(s).filter(Boolean).length, 18, "18 filled");
  t.equal(s.SF1, "Aqb2", "QB2 in SuperFlex");
  t.deepEqual([s.OF1, s.OF2].sort(), ["Arb3", "Awr3"].sort(), "the two flex spots go to the 3rd RB and 3rd WR");
  t.equal(s.DF1, "Adb3", "the D-Flex takes the best remaining defender");
  t.equal(Math.round(m.teams.A.total * 10) / 10, 20 + 15 + 14 + 12 + 9 + 14 + 12 + 9 + 10 + 9 + 8 + 8 + 7 + 8 + 7 + 9 + 8 + 7.5);
});

test("replacement: an empty slot is filled at the waiver-wire level (3rd best FA at QB/RB/WR/TE, 6th at K/P, 12th at IDP)", () => {
  const L = league([base("A")], 0);
  // Ranked free agents so the Nth best is identifiable.
  for (const pos of ["QB", "RB", "WR", "TE", "PK", "PN", "DE", "LB", "CB"]) for (let i = 0; i < 14; i++) L.values["fa" + pos + i] = 30 - i;
  const repl = TF.replacementLevels(L.freeAgents, L.values, ctx.UPS_FRONT_OFFICE_LINEUP);
  t.equal(repl.QB[0], 28, "QB: 3rd best"); t.equal(repl.WR[0], 28, "WR: 3rd best");
  t.equal(repl.PK[0], 25, "K: 6th best"); t.equal(repl.PN[0], 25, "P: 6th best");
  t.equal(repl.DL[0], 19, "DL: 12th best"); t.equal(repl.DB[0], 19, "DB: 12th best");
  t.equal(repl.RB.length, 5, "enough RB bodies for RB1-2, two Flex, SuperFlex");
  const noTe = base("B"); noTe.players = noTe.players.filter((p) => p.pos !== "TE");
  const m = TF.buildLeague(league([base("A"), noTe], 3));
  t.equal(m.teams.B.replacementStarts, 1, "B starts one replacement body (at TE)");
  t.ok(m.teams.B.need.TE > 0, "and needs a TE");
});

test("availability: IR, taxi and players ruled Out never start; Questionable does", () => {
  const tm = base("A");
  tm.players.find((p) => p.pid === "Aqb1").status = "INJURED_RESERVE";
  tm.players.find((p) => p.pid === "Arb1").chip = "OUT";
  tm.players.find((p) => p.pid === "Awr1").status = "TAXI_SQUAD";
  tm.players.find((p) => p.pid === "Ate1").chip = "Q";
  const m = TF.buildLeague(league([tm]));
  const starters = Object.values(m.teams.A.best.slots);
  for (const pid of ["Aqb1", "Arb1", "Awr1"]) t.ok(!starters.includes(pid), pid + " does not start");
  t.ok(starters.includes("Ate1"), "the Questionable TE starts");
});

test("need: the gain from adding the league's median starter, with flex and superflex handled", () => {
  const thinQb = base("B"); thinQb.players = thinQb.players.filter((p) => p.pid !== "Bqb2");
  const m = TF.buildLeague(league([base("A"), thinQb, base("C")]));
  t.ok(m.teams.B.need.QB > m.teams.A.need.QB, "the one-QB team needs a QB more (its SuperFlex falls to a RB/WR or the wire)");
  t.ok(m.teams.B.need.QB >= 5, "a real gap: " + m.teams.B.need.QB + " pts/wk");
  t.equal(m.teams.A.need.PK, 0, "no need where the starter already beats the median");
});

test("surplus and fits: a bench QB on a 3-QB team helps the 1-QB team; both lineups must gain", () => {
  const rich = base("A"); rich.players.push(Object.assign({ pid: "Aqb3", pos: "QB", status: "ROSTER", chip: "", salary: 4000, _v: 14 }));
  const poor = base("B"); poor.players = poor.players.filter((p) => p.pid !== "Bqb2");
  poor.players.push(Object.assign({ pid: "Bwr4", pos: "WR", status: "ROSTER", chip: "", salary: 2000, _v: 11 }));
  rich.players.find((p) => p.pid === "Awr3")._v = 5;
  const m = TF.buildLeague(league([rich, poor]));
  const sur = m.teams.A.surplus.find((x) => x.pid === "Aqb3");
  t.ok(sur && sur.best.fid === "B" && sur.best.gain > 0, "A's QB3 is surplus that B would start");
  const fits = TF.pairFits(m, "A", "B", { capRoom: { A: 10000, B: 1000 } });
  t.ok(fits.length > 0, "at least one fit");
  for (const f of fits) t.ok(f.gainA > 0 && f.gainB > 0, "both gain: " + JSON.stringify(f));
  const top = fits.find((f) => f.give === "Aqb3" && f.get === "Bwr4");
  t.ok(top, "A's bench QB for B's WR4 (which beats A's weak WR3) is listed");
  t.equal(top.gainA, 6, "A: WR4 11 replaces WR3 5 in a flex spot");
  t.equal(top.gainB, 3, "B: QB3 14 replaces a 9 at SuperFlex, loses WR4 11 for a 9 at flex");
  t.ok(fits.every((f, i) => i === 0 || fits[i - 1].mutual >= f.mutual), "sorted by the smaller gain");
  t.equal(top.capAfterA, 10000 - (2000 - 4000)); t.equal(top.capAfterB, 1000 - (4000 - 2000));
  t.equal(top.overCap, true, "B would be $1,000 over the cap → flagged");
  for (const f of fits) t.ok(!/^(PK|PN)$/.test(f.giveGroup) && !/^(PK|PN)$/.test(f.getGroup), "kickers/punters never drive a fit");
});

test("kickers and punters are shown but never a surplus or a fit", () => {
  const a = base("A"); a.players.push(Object.assign({ pid: "Ak2", pos: "PK", status: "ROSTER", chip: "", salary: 1000, _v: 14 }));
  a.players.find((p) => p.pid === "Awr3")._v = 4;
  const b = base("B"); b.players.find((p) => p.pid === "Bk")._v = 2;
  b.players.push(Object.assign({ pid: "Bwr4", pos: "WR", status: "ROSTER", chip: "", salary: 1000, _v: 8 }));
  const m = TF.buildLeague(league([a, b]));
  t.ok(m.teams.B.need.PK > 0, "B's weak kicker shows as a need on the matrix");
  t.ok(!m.teams.A.surplus.some((x) => x.pid === "Ak2"), "A's spare kicker is not listed as surplus");
  t.ok(!TF.pairFits(m, "A", "B", { limit: 5000 }).some((f) => f.give === "Ak2" || f.get === "Bk"), "no kicker swap is offered");
});

test("sensitivity: a fit says whether it holds on the other values (last 4 weeks)", () => {
  const rich = base("A"); rich.players.push(Object.assign({ pid: "Aqb3", pos: "QB", status: "ROSTER", chip: "", salary: 1000, _v: 14 }));
  const poor = base("B"); poor.players = poor.players.filter((p) => p.pid !== "Bqb2");
  poor.players.push(Object.assign({ pid: "Bwr4", pos: "WR", status: "ROSTER", chip: "", salary: 1000, _v: 11 }));
  rich.players.find((p) => p.pid === "Awr3")._v = 5;
  const L = league([rich, poor]);
  const m = TF.buildLeague(L);
  const altSame = TF.buildLeague(L);
  const altCold = TF.buildLeague(Object.assign({}, L, { values: Object.assign({}, L.values, { Aqb3: 2 }) }));
  t.ok(TF.pairFits(m, "A", "B", { alt: altSame }).every((f) => f.holdsOnAlt === true), "same values → every fit holds");
  t.equal(TF.pairFits(m, "A", "B", { alt: altCold }).find((f) => f.give === "Aqb3").holdsOnAlt, false, "QB3 cold lately → doesn't hold");
});

test("real league, 2026 after Week 6: every team builds, results are stable and plain", () => {
  const t0 = Date.now();
  const m = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  const ms = Date.now() - t0;
  t.ok(ms < 3000, "whole league in " + ms + " ms");
  t.equal(m.order.length, 12, "12 teams");
  for (const fid of m.order) t.equal(Object.values(m.teams[fid].best.slots).filter(Boolean).length, 18, fid + ": 18 slots filled (wire fills holes)");
  // Real Deal Creel (0008): biggest need is RB; Pure Greatness (0004) has Bucky Irving as surplus that 0008 starts.
  const s8 = TF.teamSummary(m, "0008");
  t.equal(s8.needs[0], "RB", "0008's biggest need is RB (" + m.teams["0008"].need.RB + " pts/wk)");
  const bucky = m.teams["0004"].surplus.find((x) => x.pid === "16598");
  t.ok(bucky && bucky.best.fid === "0008", "Bucky Irving (0004 bench) would start for 0008");
  const fits = TF.pairFits(m, "0008", "0004", { capRoom: FX.capRoom, limit: 20 });
  t.ok(fits.length >= 3, fits.length + " fits");
  const all = TF.pairFits(m, "0008", "0004", { capRoom: FX.capRoom, limit: 5000 });
  t.ok(all.length >= fits.length, all.length + " fits in all");
  t.ok(all.every((f) => f.gainA > 0 && f.gainB > 0), "every listed swap improves BOTH lineups (none one-sided)");
  const m2 = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, lineup: ctx.UPS_FRONT_OFFICE_LINEUP });
  t.equal(JSON.stringify(TF.pairFits(m2, "0008", "0004", { capRoom: FX.capRoom, limit: 20 })), JSON.stringify(fits), "deterministic");
});

await run("trade_fit_model");
