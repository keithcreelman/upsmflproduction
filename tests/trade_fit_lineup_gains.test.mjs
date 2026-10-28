// Trade finder → Lineup gains (site/shared/trade_fit.js lineupGains, Keith 2026-10-28): players on other teams whose
// addition alone would raise MY modeled lineup, and my available players whose addition alone would raise another
// team's. Same lineup, values and replacement levels as the strength table; gain = lineup with − lineup without; only
// gains of at least GAIN_MIN (1.0 pt a week). Synthetic leagues pin the rules; the 2026 Week-6 fixture (MFL's own
// data) pins completeness on a real league.
//   node tests/trade_fit_lineup_gains.test.mjs
//   TRADE_FIT_JS=<path> node tests/trade_fit_lineup_gains.test.mjs   (defect check against another copy)
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
const L = ctx.UPS_FRONT_OFFICE_LINEUP;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
const STARTERS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/mfl_league_starters_74598_2026.json"), "utf8")).starters;
const r1 = (x) => Math.round(x * 10) / 10;

// A full, healthy 18 (the trade_fit_model test's team) plus `extra` bench players.
function team(fid, extra = []) {
  const P = (pid, pos, v, more) => Object.assign({ pid: fid + pid, pos, status: "ROSTER", chip: "", salary: 1000 }, more || {}, { _v: v });
  const players = [
    P("qb1", "QB", 20), P("qb2", "QB", 15), P("rb1", "RB", 14), P("rb2", "RB", 12), P("rb3", "RB", 9),
    P("wr1", "WR", 14), P("wr2", "WR", 12), P("wr3", "WR", 9), P("te1", "TE", 10), P("k", "PK", 9), P("p", "PN", 8),
    P("dl1", "DE", 8), P("dl2", "DT", 7), P("lb1", "LB", 8), P("lb2", "LB", 7), P("db1", "CB", 9), P("db2", "S", 8), P("db3", "S", 7.5),
  ].concat(extra.map((x) => P(x[0], x[1], x[2], x[3])));
  return { fid, name: "Team " + fid, players };
}
function league(teams) {
  const values = {}, freeAgents = [];
  teams.forEach((tm) => tm.players.forEach((p) => { values[p.pid] = p._v; }));
  for (const pos of ["QB", "RB", "WR", "TE", "PK", "PN", "DE", "LB", "CB"]) for (let i = 0; i < 14; i++) { const pid = "fa" + pos + i; freeAgents.push({ pid, pos }); values[pid] = 1; }
  return { teams, values, freeAgents, lineup: L };
}
// The league with player `pid` actually moved from his team onto `toFid`'s roster, rebuilt from scratch: an
// independent lineup(with) (no addGain involved).
function movedTotal(input, pid, toFid) {
  const teams = input.teams.map((tm) => ({ ...tm, players: tm.players.filter((p) => p.pid !== pid) }));
  const p = input.teams.flatMap((tm) => tm.players).find((x) => x.pid === pid);
  teams.find((tm) => tm.fid === toFid).players.push(p);
  return TF.buildLeague({ ...input, teams }).teams[toFid].total;
}

// A = me. B carries clear improvers, a near-miss (+0.6), a non-improver, a kicker; A carries injured bench players.
const IN = league([
  team("A", [["wr4", "WR", 25, { chip: "OUT" }], ["wr5", "WR", 25, { status: "INJURED_RESERVE" }], ["wr6", "WR", 24, { status: "TAXI_SQUAD" }], ["te2", "TE", 16]]),
  team("B", [["wr4", "WR", 30], ["wr5", "WR", 9.6], ["wr9", "WR", 2], ["k2", "PK", 30], ["rb4", "RB", 20, { chip: "IR" }]]),
  team("C"),
]);
const M = TF.buildLeague(IN);
const G = TF.lineupGains(M, "A");

test("the minimum is explicit: 1.0 pt a week by default, overridable", () => {
  t.equal(TF.GAIN_MIN, 1.0);
  t.equal(G.minGain, 1.0);
  t.equal(TF.lineupGains(M, "A", { minGain: 0.5 }).minGain, 0.5);
  t.equal(TF.lineupGains(M, "nobody"), null, "an unknown team → null, never an empty claim");
});

test("players who would improve my lineup: improvers listed, a player who does not improve it never appears", () => {
  const ids = G.forMe.map((x) => x.pid);
  t.ok(ids.includes("Bwr4"), "B's 30-PPG bench WR is listed");
  t.equal(G.forMe.find((x) => x.pid === "Bwr4").fid, "B", "with his team");
  t.equal(G.forMe.find((x) => x.pid === "Bwr4").v, 30, "and the basis (season PPG = the model's value)");
  t.ok(!ids.includes("Bwr9"), "a 2-PPG WR (gain 0) is not listed");
  t.ok(!ids.includes("Bdb3") && !ids.includes("Cdb3"), "a DB equal to my D-Flex starter (gain 0) is not listed");
  for (const f of ["B", "C"]) for (const p of M.teams[f].team.players) {
    if (ids.includes(p.pid)) continue;
    const g = TF.addGain(M, "A", p);
    t.ok(g < 1.0 || !TF.availableNow(p) || /^(PK|PN)$/.test(L.posGroup(p.pos)), p.pid + ": left out only below the minimum, unavailable, or K/P (gain " + r1(g) + ")");
  }
  for (let i = 1; i < G.forMe.length; i++) t.ok(G.forMe[i - 1].gain >= G.forMe[i].gain, "largest gain first");
});

test("gain = lineup(with) − lineup(without), recomputed by actually moving the player and rebuilding the league", () => {
  for (const x of G.forMe) t.equal(x.gain, r1(movedTotal(IN, x.pid, "A") - M.teams.A.total), x.pid + " → A");
  for (const x of G.fromMe) for (const g of x.gains) t.equal(g.gain, r1(movedTotal(IN, x.pid, g.fid) - M.teams[g.fid].total), x.pid + " → " + g.fid);
  const wr4 = G.forMe.find((x) => x.pid === "Bwr4");
  t.equal(wr4.gain, 30 - 9, "Bwr4 takes a Flex spot from a 9-PPG starter: +21.0");
});

test("threshold respected: nothing under the minimum; the +0.6 near-miss appears only when the minimum is lowered", () => {
  for (const x of G.forMe) t.ok(x.gain >= 1.0, x.pid + " ≥ 1.0");
  for (const x of G.fromMe) for (const g of x.gains) t.ok(g.gain >= 1.0, x.pid + " → " + g.fid + " ≥ 1.0");
  t.ok(!G.forMe.some((x) => x.pid === "Bwr5"), "+0.6 (9.6 over a 9) is left out at 1.0");
  const low = TF.lineupGains(M, "A", { minGain: 0.5 });
  t.equal(low.forMe.find((x) => x.pid === "Bwr5").gain, 0.6, "and listed at 0.5");
  const high = TF.lineupGains(M, "A", { minGain: 5 });
  t.ok(high.forMe.length > 0 && high.forMe.every((x) => x.gain >= 5), "a higher minimum keeps only gains at or above it");
});

test("my players who would improve theirs: healthy only (IR, Out, taxi excluded); K/P never listed on either side", () => {
  const mine = G.fromMe.map((x) => x.pid);
  t.ok(mine.includes("Ate2"), "my healthy 16-PPG bench TE helps B and C");
  t.equal(G.fromMe.find((x) => x.pid === "Ate2").gains.map((g) => g.fid).sort().join(","), "B,C", "each team he'd raise, with its gain");
  t.equal(G.fromMe.find((x) => x.pid === "Ate2").starter, true, "marked as in my modeled lineup (he starts in my Flex)");
  for (const x of G.fromMe) t.equal(x.starter, !!M.teams.A.starterIds[x.pid], x.pid + ": the in-my-lineup mark is the model's");
  for (const pid of ["Awr4", "Awr5", "Awr6"]) t.ok(!mine.includes(pid), pid + " (Out / IR / taxi) is not listed, though his PPG would help");
  t.ok(!G.forMe.some((x) => x.pid === "Brb4"), "another team's IR player is not listed for me either");
  t.ok(!G.forMe.some((x) => x.pid === "Bk2"), "a 30-PPG kicker is not listed (K/P are never a reason, as in surplus)");
  t.ok([...G.forMe, ...G.fromMe].every((x) => !/^(PK|PN)$/.test(x.group)), "no K or P anywhere");
  t.ok(!G.fromMe.some((x) => x.gains.some((g) => g.fid === "A")) && !G.forMe.some((x) => x.fid === "A"), "my own team never appears as the other side");
});

test("real league (2026 Week 6, Real Deal Creel): complete, exact, every listed gain ≥ 1.0", () => {
  const m = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: TF.deriveSlots(STARTERS) });
  for (const me of ["0008", "0001"]) {
    const g = TF.lineupGains(m, me);
    let expect = 0;
    for (const f of m.order) if (f !== me) for (const p of m.teams[f].team.players) {
      const grp = L.posGroup(p.pos);
      if (!TF.availableNow(p) || /^(PK|PN|OTH)$/.test(grp)) continue;
      const gain = TF.addGain(m, me, p);
      if (gain >= 1.0 - 1e-9) {
        expect += 1;
        const row = g.forMe.find((x) => x.pid === p.pid);
        t.ok(row && row.fid === f && row.gain === r1(gain), me + ": " + p.pid + " listed with " + r1(gain));
      }
    }
    t.equal(g.forMe.length, expect, me + ": exactly the improvers, nobody else");
    t.ok(g.forMe.length > 0 && g.fromMe.length > 0, me + ": both lists have players");
    for (const x of g.fromMe) {
      const p = m.teams[me].team.players.find((q) => q.pid === x.pid);
      t.ok(TF.availableNow(p), me + ": " + x.pid + " is available now");
      for (const y of x.gains) t.ok(y.gain >= 1.0 && y.gain === r1(TF.addGain(m, y.fid, p)), me + ": " + x.pid + " → " + y.fid);
    }
  }
});

await run("trade_fit_lineup_gains");
