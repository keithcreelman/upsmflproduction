// Clinching letters, Phase 2 (Keith 2026-10-27): Z clinched bye, E eliminated from every path, locked seeds 1-6, on top of
// Phase 1's X (spot) and Y (division). site/shared/standings_clinch.js promises: a letter is shown only when it holds in
// EVERY possible finish (never from a forecast percentage), ties are unresolved, so a letter can be late but not wrong.
// 1. Named situations in the real 12-team format (4 divisions of 3, 4 division winners + 2 wild cards, 2 byes).
// 2. A brute-force oracle (tests/fixtures/clinch_oracle.mjs) plays out EVERY remaining finish, ties included, on small
//    leagues; no letter may ever be contradicted, and nothing is published that the oracle would not also publish.
// 3. Cost: a wide-open early-season state stays inside the walk budget.
//   node scripts/safe_tests/run.mjs --only standings_clinch
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { rng, emptyRecords, playWeek, reachable, toInput, OUT } from "./fixtures/clinch_oracle.mjs";

const require = createRequire(import.meta.url);
const { analyze } = require("../site/shared/standings_clinch.js");

// ── the real format: teams 1..12, divisions A(1,5,9) B(2,6,10) C(3,7,11) D(4,8,12) ──
const DIV = (i) => "ABCD"[(i - 1) % 4];
// 14 regular weeks, 2 H2H games a week (28), 13 weeks played; All-Play: 11 results a week.
function league(over = {}) {
  const teams = [];
  for (let i = 1; i <= 12; i++) {
    const o = over[i] || {};
    teams.push({ fid: String(i).padStart(4, "0"), division: DIV(i), h2h: o.h2h || { w: 13, l: 13, t: 0 }, ap: o.ap || { w: 70, l: 73, t: 0 } });
  }
  return { teams, h2hGames: Object.fromEntries(teams.map((x) => [x.fid, 28])), apGamesLeft: over.apLeft == null ? 11 : over.apLeft, byes: 2, wildCards: 2, ...(over.input || {}) };
}
const f = (i) => String(i).padStart(4, "0");
const lab = (r, i) => r.byFid[f(i)].label;
// All-Play wins spaced wider than one week can move them (a week is worth up to 11), so the order is settled.
const spaced = (i) => ({ w: 132 - 12 * (i - 1), l: 143 - (132 - 12 * (i - 1)), t: 0 });

test("a settled league: every division won, every seed locked, the rest out", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: spaced(i), h2h: i <= 4 ? { w: 24, l: 2, t: 0 } : { w: 6, l: 20, t: 0 } };
  const r = analyze(league(over));
  t.equal(r.status, "ok"); t.ok(r.walk.complete);
  for (let i = 1; i <= 6; i++) { t.equal(r.byFid[f(i)].lock, i, "seed " + i); t.equal(lab(r, i), String(i)); t.ok(r.byFid[f(i)].x); }
  for (let i = 7; i <= 12; i++) { t.ok(r.byFid[f(i)].e, "team " + i + " eliminated"); t.equal(lab(r, i), "E"); t.equal(r.byFid[f(i)].lock, null); }
  t.ok(r.byFid[f(1)].z && r.byFid[f(2)].z && !r.byFid[f(3)].z, "only the two best winners hold byes");
  t.deepEqual(r.disagreements, []);
});

test("Y does not imply a bye: a clinched division with three other divisions in range is only Y", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: { w: 66 + (i % 4), l: 77 - (i % 4), t: 0 } };
  over[1].h2h = { w: 22, l: 4, t: 0 };          // division A: clears its mates (13 + 2 games left = 15 max)
  over[5].h2h = { w: 10, l: 16, t: 0 }; over[9].h2h = { w: 10, l: 16, t: 0 };
  const r = analyze(league(over));
  t.ok(r.byFid[f(1)].y && r.byFid[f(1)].x, "division clinched");
  t.ok(!r.byFid[f(1)].z, "a bye is not clinched: other winners can still finish ahead");
  t.equal(lab(r, 1), "Y");
});

test("Z needs at most one other division winner able to finish at or above it", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: { w: 60, l: 83, t: 0 }, h2h: { w: 13, l: 13, t: 0 } };
  over[1] = { ap: { w: 130, l: 13, t: 0 }, h2h: { w: 24, l: 2, t: 0 } };       // far ahead of everyone
  over[2] = { ap: { w: 118, l: 25, t: 0 }, h2h: { w: 24, l: 2, t: 0 } };       // division B leader, second
  over[3] = { ap: { w: 115, l: 28, t: 0 }, h2h: { w: 13, l: 13, t: 0 } };       // division C: open, but its winner can still pass team 2
  const r = analyze(league(over));
  t.ok(r.byFid[f(1)].z, "no other winner can reach team 1: bye");
  t.ok(r.byFid[f(2)].y && !r.byFid[f(2)].z, "team 2 can be passed by team 1 AND by the division C winner: two winners ahead means no bye");
  over[3].ap = { w: 100, l: 43, t: 0 };                                          // now only team 1 can finish ahead of team 2
  t.ok(analyze(league(over)).byFid[f(2)].z, "one winner ahead is still a bye");
});

test("a tie is never a clinch: equal All-Play ranges do not lock or clinch a bye", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: { w: 40, l: 103, t: 0 }, h2h: { w: 13, l: 13, t: 0 } };
  over[1] = { ap: { w: 121, l: 22, t: 0 }, h2h: { w: 24, l: 2, t: 0 } };
  over[2] = { ap: { w: 110, l: 33, t: 0 }, h2h: { w: 24, l: 2, t: 0 } };      // team 2 can reach 110 + 11 = 121: level with team 1 at best
  over[3] = { ap: { w: 110, l: 33, t: 0 }, h2h: { w: 24, l: 2, t: 0 } };      // so can team 3: two winners at or above team 1
  const r = analyze(league(over));
  t.ok(!r.byFid[f(1)].z, "teams 2 and 3 can finish level with team 1; a tie is decided by points that are not yet known");
  over[3].ap = { w: 109, l: 34, t: 0 };
  t.ok(analyze(league(over)).byFid[f(1)].z, "one All-Play win further back, team 3 can no longer reach it: only team 2 can be ahead");
});

test("a tie on H2H win % never decides a division: no Y while a rival can still tie", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: { w: 60 + i, l: 83 - i, t: 0 } };
  over[1].h2h = { w: 14, l: 12, t: 0 };               // division A: team 5 (12-14) with two games left can reach 14 - a tie
  over[5].h2h = { w: 12, l: 14, t: 0 };
  over[9].h2h = { w: 4, l: 22, t: 0 };
  const r = analyze(league(over));
  t.ok(!r.byFid[f(1)].y);
  over[1].h2h = { w: 15, l: 11, t: 0 };
  t.ok(analyze(league(over)).byFid[f(1)].y, "one more win and no rival can reach it");
});

test("E needs BOTH: no division title possible and two non-winners already surely ahead", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: spaced(i), h2h: i <= 4 ? { w: 24, l: 2, t: 0 } : { w: 6, l: 20, t: 0 } };
  over[12].h2h = { w: 6, l: 20, t: 0 };
  // team 9 is far behind on All-Play but its division race is still open: it can still win the division, so not E
  over[1] = { ap: spaced(1), h2h: { w: 10, l: 16, t: 0 } };       // division A leader fell back: team 9 (6-20 + 2 left = 8) still behind
  over[9].h2h = { w: 11, l: 15, t: 0 };                           // now team 9 can reach 13 - a division title is possible
  const r = analyze(league(over));
  t.ok(!r.byFid[f(9)].e, "can still win its division: never E, however low its All-Play");
});

test("a division winner can be the 6th seed; wild cards cannot take byes", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: spaced(i), h2h: { w: 13, l: 13, t: 0 } };
  // winners are the BEST H2H in each division: make teams 1, 2, 7 and 12 (spread over A, B, C, D) the clinched winners
  const winners = { 1: 1, 2: 2, 11: 3, 12: 4 };  // division winners by H2H: A:1, B:2, C:11 (low All-Play), D:12 (lowest All-Play)
  for (const w of Object.keys(winners)) over[w].h2h = { w: 24, l: 2, t: 0 };
  const r = analyze(league(over));
  t.ok(r.walk.complete);
  t.equal(r.byFid[f(1)].lock, 1); t.equal(r.byFid[f(2)].lock, 2);
  // seeds 3-6: team 3 and 4 are the wild cards? no - the next-best NON-winners are teams 3 and 4 (All-Play), winners 11 and 12 follow
  t.equal(r.byFid[f(3)].lock, 3); t.equal(r.byFid[f(4)].lock, 4);
  t.equal(r.byFid[f(11)].lock, 5); t.equal(r.byFid[f(12)].lock, 6, "the lowest-All-Play division winner is the 6th seed");
  for (const i of [5, 6, 7, 8, 9, 10]) t.ok(r.byFid[f(i)].e, "non-winner " + i + " is behind two non-winners: out");
});

test("an open race gives a lock only where the seed is the same in every outcome", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: spaced(i), h2h: i <= 3 ? { w: 24, l: 2, t: 0 } : { w: 6, l: 20, t: 0 } };
  over[4].h2h = { w: 13, l: 13, t: 0 }; over[8].h2h = { w: 13, l: 13, t: 0 }; over[12].h2h = { w: 5, l: 21, t: 0 };   // division D: 4 v 8 still open
  const r = analyze(league(over));
  t.ok(r.walk.complete);
  for (const i of [1, 2, 3, 4, 5]) t.equal(r.byFid[f(i)].lock, i, "seed " + i + " is the same whichever of teams 4 and 8 wins D");
  t.equal(r.byFid[f(6)].lock, null, "team 6 is 6th if team 4 wins the division and out if team 8 does");
  t.ok(!r.byFid[f(6)].x && !r.byFid[f(6)].e);
});

test("without a schedule no division claim is made (no Y, no Z, no E), and nothing is guessed", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: spaced(i), h2h: i <= 4 ? { w: 24, l: 2, t: 0 } : { w: 6, l: 20, t: 0 } };
  const r = analyze({ ...league(over), h2hGames: null });
  for (let i = 1; i <= 12; i++) { const d = r.byFid[f(i)]; t.ok(!d.y && !d.z && !d.e && d.lock == null, "team " + i); }
});

test("unreadable input answers 'unavailable', never a letter", () => {
  t.equal(analyze(null).status, "unavailable");
  t.equal(analyze({ teams: [] }).status, "unavailable");
  const bad = league(); bad.teams[0].ap = { w: "x", l: 1, t: 0 };
  t.equal(analyze(bad).status, "unavailable");
  const noGames = league(); delete noGames.apGamesLeft;
  t.equal(analyze(noGames).status, "unavailable");
});

test("display hierarchy: locked seed over Z over Y over X; E alone", () => {
  const over = {};
  for (let i = 1; i <= 12; i++) over[i] = { ap: { w: 60 + (i % 3), l: 83 - (i % 3), t: 0 } };
  over[1].h2h = { w: 22, l: 4, t: 0 };
  const open = analyze(league(over));
  t.equal(lab(open, 1), "Y");
  t.equal(lab(open, 2), null, "nothing decided for the rest");
});

test("cost: a wide-open early-season state stays inside the walk budget", () => {
  const over = { apLeft: 11 * 12 };
  for (let i = 1; i <= 12; i++) over[i] = { h2h: { w: 1, l: 1, t: 0 }, ap: { w: 11, l: 11, t: 0 } };
  const t0 = process.hrtime.bigint();
  const r = analyze(league(over));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.ok(r.walk.visits <= 100001, "visits " + r.walk.visits);
  t.ok(ms < 1500, "took " + ms.toFixed(0) + " ms");
  for (let i = 1; i <= 12; i++) t.equal(r.byFid[f(i)].label, null);
});

// ── the oracle ──
function schedule(F, R) {
  const games = [];
  for (const d of F.divisions) for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) if (R() < 0.8) games.push([d[i], d[j]]);
  const cnt = new Array(F.n).fill(0); games.forEach((g) => { cnt[g[0]]++; cnt[g[1]]++; });
  for (let i = 0; i < F.n; i++) if (!cnt[i]) { let j; do { j = Math.floor(R() * F.n); } while (j === i); games.push([i, j]); cnt[i]++; cnt[j]++; }
  return games;
}
const FORMATS = {
  "6 teams, 2 divisions of 3, 1 bye, 1 wild card": { n: 6, divisions: [[0, 1, 2], [3, 4, 5]], byes: 1, wildCards: 1 },
  "6 teams, 3 divisions of 2, 1 bye, 1 wild card": { n: 6, divisions: [[0, 1], [2, 3], [4, 5]], byes: 1, wildCards: 1 },
  "6 teams, 2 divisions of 3, 1 bye, 2 wild cards": { n: 6, divisions: [[0, 1, 2], [3, 4, 5]], byes: 1, wildCards: 2 },
};
function fuzz(F, seed, trials, weeksLeftN, levels) {
  const R = rng(seed);
  const tally = { states: 0, contradicted: 0, disagreements: 0, truth: { x: 0, y: 0, z: 0, e: 0, lock: 0 }, got: { x: 0, y: 0, z: 0, e: 0, lock: 0 } };
  for (let s = 0; s < trials; s++) {
    const past = 3 + Math.floor(R() * 8);
    const weeks = []; for (let w = 0; w < past + weeksLeftN; w++) weeks.push({ games: schedule(F, R) });
    const recs = emptyRecords(F.n);
    for (let w = 0; w < past; w++) playWeek(recs, Array.from({ length: F.n }, () => Math.floor(R() * 5)), weeks[w].games);   // small scores: ties happen
    const left = weeks.slice(past);
    const res = analyze(toInput(recs, F, left, weeks.flatMap((w) => w.games)));
    const reach = reachable(recs, F, left, levels);
    tally.states++; tally.disagreements += res.disagreements.length;
    for (let tm = 0; tm < F.n; tm++) {
      const r = res.byFid[String(tm)], seeds = [...reach[tm].seeds];
      const truth = { x: !reach[tm].seeds.has(OUT), y: reach[tm].dw.size === 1 && reach[tm].dw.has(true),
        z: !reach[tm].seeds.has(OUT) && seeds.every((v) => v >= 1 && v <= F.byes), e: seeds.length === 1 && seeds[0] === OUT,
        lock: seeds.length === 1 && seeds[0] !== OUT ? seeds[0] : null };
      for (const k of ["x", "y", "z", "e"]) { if (truth[k]) tally.truth[k]++; if (r[k]) tally.got[k]++; if (r[k] && !truth[k]) tally.contradicted++; }
      if (truth.lock) tally.truth.lock++;
      if (r.lock) { tally.got.lock++; if (r.lock !== truth.lock) tally.contradicted++; }
    }
  }
  return tally;
}
let n = 0;
for (const [name, F] of Object.entries(FORMATS)) {
  test("oracle, one week left (every score order incl. ties): " + name, () => {
    const r = fuzz(F, 100 + ++n, 25, 1, F.n);
    t.equal(r.contradicted, 0, JSON.stringify(r));
    t.equal(r.disagreements, 0, "the closed forms and the walk agree");
    t.ok(r.got.x > 0 && r.got.y > 0 && r.got.e > 0 && r.got.z > 0 && r.got.lock > 0, "the run exercised every letter: " + JSON.stringify(r.got));
    for (const k of ["x", "y", "z", "e", "lock"]) t.ok(r.got[k] <= r.truth[k], k + " published " + r.got[k] + " of " + r.truth[k] + " possible");
  });
}
test("oracle, two weeks left (three score levels): 6 teams, 3 divisions of 2", () => {
  const r = fuzz(FORMATS["6 teams, 3 divisions of 2, 1 bye, 1 wild card"], 777, 4, 2, 3);
  t.equal(r.contradicted, 0, JSON.stringify(r));
});

await run("standings_clinch");
