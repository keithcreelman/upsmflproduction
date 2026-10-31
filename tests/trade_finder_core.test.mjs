// Trade finder core (site/shared/trade_finder_core.js, Keith 2026-10-28 review): my team's strengths and needs from
// the lineup-strength table, the drilldown between my team and one other team (the same numbers as
// trade_fit.lineupGains), and the ticked players → an UNSENT Trade builder draft. The 2026 Week-6 fixture (MFL's own
// data) pins the behavior on the real league.
//   node tests/trade_finder_core.test.mjs
//   TRADE_FINDER_CORE_JS=<path> node tests/trade_finder_core.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ctx = vm.createContext({}); ctx.window = ctx;
for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/lineup_strength.js"]) vm.runInContext(read(f), ctx);
vm.runInContext(process.env.TRADE_FINDER_CORE_JS ? fs.readFileSync(process.env.TRADE_FINDER_CORE_JS, "utf8") : read("site/shared/trade_finder_core.js"), ctx);
const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH, C = ctx.UPS_TRADE_FINDER;
const FX = JSON.parse(read("tests/fixtures/trade_fit_2026_wk6.json"));
const STARTERS = JSON.parse(read("tests/fixtures/mfl_league_starters_74598_2026.json")).starters;
const M = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, slots: TF.deriveSlots(STARTERS) });
const TB = LS.build(M, { by: "position" });
const ME = "0008", LH = "0006"; // Real Deal Creel; The Long Haulers
const G = TF.lineupGains(M, ME);
const player = (pid) => FX.teams.flatMap((x) => x.players).find((p) => p.pid === pid);

test("standing: every position's PPG, league average, gap and rank are the lineup-strength table's", () => {
  const s = C.standing(TB, ME, { forMe: G.forMe });
  t.equal(s.rows.map((r) => r.g).join(","), "QB,RB,WR,TE,DL,LB,DB,PK,PN");
  for (const r of s.rows) {
    t.equal(r.ppg, TB.teams[ME][r.g].ppg, r.g + " PPG"); t.equal(r.rank, TB.teams[ME][r.g].rank, r.g + " rank");
    t.equal(r.avg, TB.league[r.g].meanPpg, r.g + " league average"); t.ok(Math.abs(r.gap - (r.ppg - r.avg)) < 1e-9, r.g + " gap");
  }
  t.equal(C.standing(TB, "9999"), null, "an unknown team → null");
});

test("strengths = Top 3 by PPG, needs = Bottom 3; K and P are shown but never tagged", () => {
  for (const fid of M.order) {
    const s = C.standing(TB, fid);
    for (const r of s.rows) {
      const want = /^(PK|PN)$/.test(r.g) ? "" : r.rank <= 3 ? "strong" : r.rank > 12 - 3 ? "short" : "";
      t.equal(r.tag, want, fid + " " + r.g + " (rank " + r.rank + ")");
    }
    t.equal(s.strong.join(","), [...s.rows].filter((r) => r.tag === "strong").sort((a, b) => a.rank - b.rank).map((r) => r.g).join(","), fid + ": strong, best rank first");
    t.equal(s.short.join(","), [...s.rows].filter((r) => r.tag === "short").sort((a, b) => b.rank - a.rank).map((r) => r.g).join(","), fid + ": short, worst rank first");
  }
});

test("best available at each position = the largest real lineup gain one player on another team would give me", () => {
  const s = C.standing(TB, ME, { forMe: G.forMe });
  for (const r of s.rows) {
    const cands = G.forMe.filter((x) => x.group === r.g);
    if (r.excluded || !cands.length) { t.equal(r.best, null, r.g + ": none"); continue; }
    const top = Math.max(...cands.map((x) => x.gain));
    t.equal(r.best.gain, top, r.g + ": +" + top);
    t.ok(r.best.fid !== ME && M.teams[r.best.fid].team.players.some((p) => p.pid === r.best.pid), r.g + ": a real player on another team");
    t.equal(r.best.gain, Math.round(TF.addGain(M, ME, player(r.best.pid)) * 10) / 10, r.g + ": the gain recomputes");
  }
  t.ok(C.standing(TB, ME).rows.every((r) => r.best === null), "no gains passed → no best-available claims");
});

test("pair drilldown (Real Deal Creel × The Long Haulers): their players → my gain, my players → their gain, the same numbers as the lists", () => {
  const P = C.pairGains(G, LH);
  t.equal(P.me, ME); t.equal(P.other, LH); t.equal(P.minGain, 1.0);
  t.deepEqual(P.theirs.map((x) => x.pid), G.forMe.filter((x) => x.fid === LH).map((x) => x.pid), "theirs = every Long Haulers player in my list, same order");
  for (const x of P.theirs) {
    t.ok(x.gain >= 1.0 && x.gain === Math.round(TF.addGain(M, ME, player(x.pid)) * 10) / 10, x.pid + " → my lineup +" + x.gain);
    t.ok(M.teams[LH].team.players.some((p) => p.pid === x.pid), x.pid + " is theirs");
  }
  t.ok(P.theirs.length > 0 && P.mine.length > 0, "both sides have players");
  for (const x of P.mine) {
    const p = player(x.pid);
    t.ok(M.teams[ME].team.players.includes(p) && TF.availableNow(p), x.pid + " is mine and available");
    t.ok(x.gain >= 1.0 && x.gain === Math.round(TF.addGain(M, LH, p) * 10) / 10, x.pid + " → their lineup +" + x.gain);
  }
  for (let i = 1; i < P.mine.length; i++) t.ok(P.mine[i - 1].gain >= P.mine[i].gain, "largest gain first");
  const nacua = P.mine.find((x) => x.pid === "16211");
  t.ok(nacua && nacua.group === "WR" && nacua.v === FX.values["16211"], "Puka Nacua (mine) is listed for The Long Haulers with his season PPG");
  const want = G.fromMe.filter((x) => x.gains.some((g) => g.fid === LH)).length;
  t.equal(P.mine.length, want, "exactly my players whose gain to them is ≥ 1.0");
  t.equal(C.pairGains(G, ME), null, "my own team is not a pair");
});

test("selection → draft: the builder's openDraft shape (#1419), my players to them and theirs to me, no picks or cap", () => {
  const d = C.selectionToDraft({ me: ME, other: LH, mine: ["16211"], theirs: ["111", "222"] });
  t.equal(JSON.stringify(d), JSON.stringify({ source: "Trade finder", movements: [
    { from: ME, to: LH, tokens: ["P_16211"] },
    { from: LH, to: ME, tokens: ["P_111", "P_222"] },
  ] }), "source + one movement per direction, P_ tokens");
  t.ok(!("cap_k" in d.movements[0]) && d.movements.every((m) => m.tokens.every((x) => /^P_\d+$/.test(x))), "players only: no cap money, no picks");
  t.equal(JSON.stringify(C.selectionToDraft({ me: ME, other: LH, mine: ["1"] }).movements), JSON.stringify([{ from: ME, to: LH, tokens: ["P_1"] }]), "one side only → one movement (edited in the builder)");
  t.equal(C.selectionToDraft({ me: ME, other: LH, mine: [], theirs: [] }), null, "nothing ticked → no draft");
  t.equal(C.selectionToDraft({ me: ME, other: ME, mine: ["1"] }), null, "one team → no draft");
  t.equal(C.selectionToDraft({ me: ME, other: LH, mine: ["1"], theirs: ["1"] }), null, "a player twice → no draft");
  t.equal(C.selectionToDraft(null), null);
  t.ok(!/fetch\(|XMLHttpRequest|"POST"/.test(read("site/shared/trade_finder_core.js")), "pure: no network");
});

await run("trade_finder_core");
