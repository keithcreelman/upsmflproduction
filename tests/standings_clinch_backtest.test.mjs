// Backtest of the clinching letters (site/shared/standings_clinch.js) on the real seasons 2021-2025 (Keith 2026-10-27:
// "no historical designation would have been contradicted by the final standings"). For every season and every week
// 1-14 the letters are computed from ONLY the results up to that week (records, All-Play, the season's schedule for
// the games still to play), then held against how the season actually ended:
//   X in the field | Y won the division | Z a first-round bye (seed 1-2) | E missed every path | a number = that exact seed.
// The actual finish is rebuilt from the results by the league's rules (division winner by MFL's standingsSort PCT,
// DIVPCT, H2H, PTS, ALL_PLAY_PCT; seeds by All-Play, Overall, Points For, H2H), and that rebuild is itself checked
// against the week-15 playoff games MFL scheduled (seeds 3-6 are exactly the four teams in the two UPS round-1 games).
// Phase 1's X and Y (standings_race.magicNumbers) are also held against the new module, week by week.
// Fixture: tests/fixtures/clinch_backtest_2021_2025.json (MFL public exports). No network, no D1.
//   node scripts/safe_tests/run.mjs --only standings_clinch_backtest
import fs from "node:fs";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";

const require = createRequire(import.meta.url);
const { analyze } = require("../site/shared/standings_clinch.js");
const RACE = (() => { const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w); return w.UPS_STANDINGS_RACE; })();
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/clinch_backtest_2021_2025.json", import.meta.url), "utf8"));
const LAST = 14;

function season(y) {
  const S = FX.seasons[y];
  const fids = S.teams.map((x) => x[0]), divOf = Object.fromEntries(S.teams), n = fids.length;
  const total = Object.fromEntries(fids.map((f) => [f, 0]));
  const score = {};
  for (let w = 1; w <= LAST; w++) { score[w] = {}; for (const [a, b, sa, sb] of S.weeks[w]) { total[a]++; total[b]++; score[w][a] = sa; score[w][b] = sb; } }
  function stateAt(k) {
    const R = Object.fromEntries(fids.map((f) => [f, { h: { w: 0, l: 0, t: 0 }, ap: { w: 0, l: 0, t: 0 }, pf: 0, vs: {} }]));
    for (let w = 1; w <= k; w++) {
      for (const f of fids) { R[f].pf += score[w][f]; for (const o of fids) if (o !== f) { const d = score[w][f] - score[w][o]; R[f].ap[d > 0 ? "w" : d < 0 ? "l" : "t"]++; } }
      for (const [a, b, sa, sb] of S.weeks[w]) {
        const d = sa - sb; (R[a].vs[b] ||= { w: 0, l: 0, t: 0 }); (R[b].vs[a] ||= { w: 0, l: 0, t: 0 });
        R[a].h[d > 0 ? "w" : d < 0 ? "l" : "t"]++; R[b].h[d > 0 ? "l" : d < 0 ? "w" : "t"]++;
        R[a].vs[b][d > 0 ? "w" : d < 0 ? "l" : "t"]++; R[b].vs[a][d > 0 ? "l" : d < 0 ? "w" : "t"]++;
      }
    }
    return R;
  }
  const fin = stateAt(LAST);
  const pct = (f) => (fin[f].h.w + fin[f].h.t / 2) / total[f];
  const apw = (f) => fin[f].ap.w + fin[f].ap.t / 2;
  const divPct = (f) => { let w = 0, g = 0; for (const [o, r] of Object.entries(fin[f].vs)) if (divOf[o] === divOf[f]) { w += r.w + r.t / 2; g += r.w + r.l + r.t; } return g ? w / g : 0; };
  const h2hAmong = (f, set) => { let w = 0, g = 0; for (const o of set) if (o !== f && fin[f].vs[o]) { const r = fin[f].vs[o]; w += r.w + r.t / 2; g += r.w + r.l + r.t; } return g ? w / g : 0.5; };
  const dw = new Set(), unresolved = [];
  for (const d of new Set(Object.values(divOf))) {
    let c = fids.filter((f) => divOf[f] === d);
    for (const crit of [pct, divPct, (f) => h2hAmong(f, c), (f) => fin[f].pf, apw]) {
      const best = Math.max(...c.map(crit)); const nx = c.filter((f) => Math.abs(crit(f) - best) < 1e-9); if (nx.length < c.length) c = nx; if (c.length === 1) break;
    }
    if (c.length > 1) unresolved.push(c); dw.add(c[0]);
  }
  const ladder = (a, b) => (apw(b) - apw(a)) || (pct(b) - pct(a)) || (fin[b].pf - fin[a].pf) || (h2hAmong(b, [a]) - h2hAmong(a, [b]));
  const dws = fids.filter((f) => dw.has(f)).sort(ladder), rest = fids.filter((f) => !dw.has(f)).sort(ladder);
  const seed = {};
  dws.slice(0, 2).forEach((f, i) => { seed[f] = i + 1; });
  dws.slice(2).concat(rest.slice(0, 2)).sort(ladder).forEach((f, i) => { seed[f] = i + 3; });
  return { S, fids, divOf, n, total, stateAt, dw, seed, unresolved, ladder };
}

const SEASONS = [2021, 2022, 2023, 2024, 2025].map((y) => [y, season(y)]);
const seen = { x: 0, y: 0, z: 0, e: 0, lock: 0 };
let maxMs = 0;

for (const [y, s] of SEASONS) {
  test(y + ": the rebuilt final seeding matches MFL's week-15 playoff games", () => {
    t.deepEqual(s.unresolved, [], "no division was left to a tie this model cannot break");
    t.equal(Object.keys(s.seed).length, 6);
    const field36 = new Set(Object.keys(s.seed).filter((f) => s.seed[f] >= 3));
    const roundOne = new Set(s.S.playoffWeek15.flat().filter((f) => s.seed[f]));
    t.deepEqual([...roundOne].sort(), [...field36].sort(), "seeds 3-6 are exactly the UPS round-1 teams");
    t.equal(Object.keys(s.seed).filter((f) => s.seed[f] <= 2 && roundOne.has(f)).length, 0, "seeds 1-2 had the bye");
  });
  test(y + ": no letter at any of the 14 weeks is contradicted by how the season ended; Phase 1's X and Y are identical", () => {
    const names = {};
    for (let k = 1; k <= LAST; k++) {
      const st = s.stateAt(k);
      const input = { teams: s.fids.map((f) => ({ fid: f, division: s.divOf[f], h2h: st[f].h, ap: st[f].ap })), h2hGames: s.total, apGamesLeft: (s.n - 1) * (LAST - k), byes: 2, wildCards: 2 };
      const t0 = process.hrtime.bigint();
      const r = analyze(input);
      maxMs = Math.max(maxMs, Number(process.hrtime.bigint() - t0) / 1e6);
      t.equal(r.status, "ok"); t.deepEqual(r.disagreements, [], "fast and walk agree, week " + k);
      for (const f of s.fids) {
        const d = r.byFid[f], tag = y + " wk" + k + " " + f;
        if (d.x) { seen.x++; t.ok(s.seed[f], tag + ": X but missed the field"); }
        if (d.y) { seen.y++; t.ok(s.dw.has(f), tag + ": Y but lost the division"); }
        if (d.z) { seen.z++; t.ok(s.seed[f] >= 1 && s.seed[f] <= 2, tag + ": Z but seed " + s.seed[f]); }
        if (d.e) { seen.e++; t.ok(!s.seed[f], tag + ": E but made the field"); }
        if (d.lock) { seen.lock++; t.equal(d.lock, s.seed[f], tag + ": locked seed"); }
        names[f] = d;
      }
      if (k < LAST) {   // while games remain, Phase 1's letters are the same as the new module's
        const ap2 = (f) => st[f].ap.w + st[f].ap.t / 2, pc2 = (f) => (st[f].h.w + st[f].h.t / 2) / s.total[f];
        const lad = (a, b) => (ap2(b) - ap2(a)) || (pc2(b) - pc2(a)) || (st[b].pf - st[a].pf);
        const leaders = new Set();
        for (const dv of new Set(Object.values(s.divOf))) leaders.add(s.fids.filter((f) => s.divOf[f] === dv).sort((a, b) => (pc2(b) - pc2(a)) || lad(a, b))[0]);
        const lws = s.fids.filter((f) => leaders.has(f)).sort(lad), lrs = s.fids.filter((f) => !leaders.has(f)).sort(lad);
        const ps = {}; lws.slice(0, 2).forEach((f, i) => { ps[f] = i + 1; }); lws.slice(2).concat(lrs.slice(0, 2)).sort(lad).forEach((f, i) => { ps[f] = i + 3; });
        const payload = { standings_basis: "regular_season_ladder", regular_season: { status: "ok", through_week: k, last_regular_season_week: LAST, complete: false, next_out: lrs[2] },
          rows: s.fids.map((f) => ({ franchise_id: f, division: s.divOf[f], is_division_leader: leaders.has(f),
            division_rank: s.fids.filter((g) => s.divOf[g] === s.divOf[f]).sort((a, b) => (pc2(b) - pc2(a)) || lad(a, b)).indexOf(f) + 1,
            playoff_seed: ps[f] || null, playoff_status: ps[f] ? (leaders.has(f) ? (ps[f] <= 2 ? "bye" : "division_winner") : "wild_card") : null,
            regular_season: { record: st[f].h, all_play: st[f].ap, games: st[f].h.w + st[f].h.l + st[f].h.t } })) };
        const mfl = { schedule: { weeklySchedule: Array.from({ length: 17 }, (_, i) => i + 1).filter((w) => s.S.weeks[w]).map((w) => ({ week: String(w),
          matchup: s.S.weeks[w].map(([a, b]) => ({ franchise: [{ id: a }, { id: b }] })) })) } };
        const p1 = RACE.magicNumbers(payload, mfl);
        t.equal(p1.status, "ok", y + " wk" + k + " Phase 1 reads the state");
        for (const f of s.fids) {
          const o = p1.byFid[f];
          if (o) { t.equal(!!o.clinchedSpot, r.byFid[f].x, y + " wk" + k + " " + f + " X same as Phase 1"); t.equal(!!o.clinchedDivision, r.byFid[f].y, y + " wk" + k + " " + f + " Y same as Phase 1"); }
          else { t.ok(!r.byFid[f].x && !r.byFid[f].y, y + " wk" + k + " " + f + ": outside today's six seeds, so no X or Y in either"); }
        }
      }
    }
  });
}
test("the backtest exercised every letter and stayed fast", () => {
  for (const k of ["x", "y", "z", "e", "lock"]) t.ok(seen[k] > 0, k + " fired " + seen[k] + " times");
  t.ok(maxMs < 1500, "slowest analyze " + maxMs.toFixed(0) + " ms");
});

await run("standings_clinch_backtest");
