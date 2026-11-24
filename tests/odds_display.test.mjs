// One display policy for forecast probabilities (Keith 2026-11-24, #1503): site/shared/odds_display.js.
// 100% / 0% only for an outcome the clinch rules VERIFY; otherwise >99% and <1% at the ends, and ordinary rounding never
// reaches 100% or 0%. Playoffs, division title and first-round bye are verified separately.
//   node scripts/safe_tests/run.mjs --only odds_display
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";

const require = createRequire(import.meta.url);
const P = require("../site/shared/odds_display.js");
const { analyze } = require("../site/shared/standings_clinch.js");

test("boundaries with no verdict: above 99% is >99%, below 1% is <1%, exactly 99% / 1% stay; never 100% or 0%", () => {
  const cases = [
    [1, ">99%"], [0.99999, ">99%"], [0.9999, ">99%"], [0.995, ">99%"], [0.9949, ">99%"], [0.9901, ">99%"], [0.99, "99%"],
    [0.9899, "99%"], [0.5, "50%"], [0.015, "2%"], [0.0149, "1%"], [0.0101, "1%"], [0.01, "1%"],
    [0.0099, "<1%"], [0.005, "<1%"], [0.0049, "<1%"], [0.0001, "<1%"], [0, "<1%"],
  ];
  for (const [p, want] of cases) t.equal(P.pct(p, null), want, String(p));
  for (const [p, want] of cases) t.equal(P.compact(p, null), want.replace("%", ""), "compact " + p);
  t.equal(P.compact(0.3, "clinched"), "100"); t.equal(P.compact(0.3, "impossible"), "0"); t.equal(P.compact(null, null), "—");
  for (let i = 0; i <= 100000; i++) {
    const s = P.pct(i / 100000, null);
    if (s === "100%" || s === "0%") { t.ok(false, "p=" + i / 100000 + " showed " + s); break; }
  }
});

test("a verdict decides certainty, whatever the simulation returned", () => {
  for (const p of [1, 0.9999, 0.62, 0, null]) {
    t.equal(P.pct(p, "clinched"), "100%", "clinched, p=" + p);
    t.equal(P.pct(p, "impossible"), "0%", "impossible, p=" + p);
  }
  // an unclinched team whose simulation returns 1.000, and a non-eliminated one whose simulation returns 0.000
  t.equal(P.pct(1, null), ">99%");
  t.equal(P.pct(0, null), "<1%");
  t.equal(P.pct(1, "anything else"), ">99%", "only the two verdict words count");
});

test("unavailable or invalid forecasts show — (never 0%)", () => {
  for (const p of [null, undefined, "", NaN, "x", Infinity, -0.2, 1.3]) t.equal(P.pct(p, null), "—", String(p));
  t.equal(P.pct(1 + 1e-12, null), ">99%", "float noise above 1 is still a probability");
  t.equal(P.pct(-1e-12, null), "<1%");
});

test("describe keeps the raw value beside the text and flags a verdict the simulation contradicts", () => {
  t.deepEqual(P.describe(0.99987, null), { text: ">99%", raw: 0.99987, verdict: null, conflict: false });
  t.deepEqual(P.describe(1, "clinched"), { text: "100%", raw: 1, verdict: "clinched", conflict: false });
  t.equal(P.describe(0.98, "clinched").conflict, true, "clinched but the simulation misses it sometimes");
  t.equal(P.describe(0.01, "impossible").conflict, true);
  t.equal(P.describe(null, "clinched").conflict, false, "no forecast, nothing to contradict");
});

test("each outcome is verified separately", () => {
  const V = P.verdicts;
  t.deepEqual(V(null), { playoffs: null, division: null, bye: null }, "no clinch result: nothing certain");
  t.deepEqual(V({}), { playoffs: null, division: null, bye: null });
  t.deepEqual(V({ x: true }), { playoffs: "clinched", division: null, bye: null }, "a playoff clinch says nothing about the division or the bye");
  t.deepEqual(V({ x: true, y: true }), { playoffs: "clinched", division: "clinched", bye: null }, "a division title is not a bye");
  t.deepEqual(V({ x: true, y: true, z: true }), { playoffs: "clinched", division: "clinched", bye: "clinched" });
  t.deepEqual(V({ lock: 1 }), { playoffs: "clinched", division: "clinched", bye: "clinched" }, "seeds 1-2 are division winners with byes");
  t.deepEqual(V({ lock: 4 }), { playoffs: "clinched", division: null, bye: "impossible" }, "seed 4: in, no bye, division open");
  t.deepEqual(V({ e: true }), { playoffs: "impossible", division: "impossible", bye: "impossible" });
  t.deepEqual(V({ divOut: true }), { playoffs: null, division: "impossible", bye: "impossible" }, "out of the division race, still alive for a wild card");
  t.deepEqual(V({ byeOut: true }), { playoffs: null, division: null, bye: "impossible" });
  t.deepEqual(V({ x: true, byeOut: true }), { playoffs: "clinched", division: null, bye: "impossible" });
});

// ── the real engine: a team out of the wild-card race but alive for its division is never 0% ──
const DIV = (i) => "ABCD"[(i - 1) % 4];
const f = (i) => String(i).padStart(4, "0");
const spaced = (i) => ({ w: 132 - 12 * (i - 1), l: 143 - (132 - 12 * (i - 1)), t: 0 });
function league(over) {
  const teams = [];
  for (let i = 1; i <= 12; i++) teams.push({ fid: f(i), division: DIV(i), h2h: (over[i] || {}).h2h || { w: 13, l: 13, t: 0 }, ap: (over[i] || {}).ap || spaced(i) });
  return { teams, h2hGames: Object.fromEntries(teams.map((x) => [x.fid, 28])), apGamesLeft: 11, byes: 2, wildCards: 2 };
}
test("engine → policy: last on All-Play with its division still open shows <1%, not 0%; a closed path shows 0%", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { h2h: i <= 4 ? { w: 24, l: 2, t: 0 } : { w: 6, l: 20, t: 0 } };
  over[1] = { h2h: { w: 10, l: 16, t: 0 } };   // division A's leader fell back ...
  over[9] = { h2h: { w: 11, l: 15, t: 0 } };   // ... so team 9 (far behind on All-Play) can still win division A
  const r = analyze(league(over));
  const v9 = P.verdicts(r.byFid[f(9)]);
  t.ok(!r.byFid[f(9)].e && !r.byFid[f(9)].divOut, "team 9 is alive through its division");
  t.equal(v9.playoffs, null); t.equal(v9.division, null);
  t.equal(P.pct(0, v9.playoffs), "<1%", "a simulated 0.000 is <1% while the division path is open");
  const v10 = P.verdicts(r.byFid[f(10)]);   // division B: team 2 is 24-2, team 10 can't catch it, and two non-winners are surely ahead
  t.ok(r.byFid[f(10)].e, "team 10 is eliminated from every path");
  t.equal(P.pct(0.0001, v10.playoffs), "0%"); t.equal(P.pct(0, v10.division), "0%"); t.equal(P.pct(0, v10.bye), "0%");
});

await run("odds_display");
