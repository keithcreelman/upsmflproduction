// site/shared/standings_race.js v3 — the weekly views (completedWeeks, weekTable, seasonWeeklyLeaders,
// teamWeeklyHistory, scoredFaced) and the PART 1 review fixes, on the REAL /api/standings route response for the
// recorded 2026 season after Week 5 (tests/fixtures/standings_2026_wk5.json, worker harness + node:sqlite D1).
// Every expected number is recomputed here, independently, from the raw fixture rows — never from the module.
// Each PART 1 fix is also proven to be load-bearing: the bug is reintroduced into a copy of the module source and
// the same check must fail on it.
//   node scripts/safe_tests/run.mjs --only standings_race_weekly
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const load = (src) => { const w = {}; new Function("window", src)(w); return w.UPS_STANDINGS_RACE; };
const RACE = load(SRC);
// A copy of the module with ONE known fix reverted (the anchor must exist exactly once).
function mutant(find, replace, ...more) {
  let src = SRC;
  const pairs = [[find, replace]];
  for (let i = 0; i < more.length; i += 2) pairs.push([more[i], more[i + 1]]);
  for (const [f, r] of pairs) {
    const n = src.split(f).length - 1;
    if (n !== 1) throw new Error("mutation anchor found " + n + " times: " + f);
    src = src.replace(f, () => r);
  }
  return load(src);
}
// The check passes on the shipped module and FAILS (an assertion, not a crash) on the reintroduced bug.
function catches(label, find, replace, check) {
  check(RACE);
  const M = mutant(find, replace);
  t.throws(() => check(M), (e) => e && e.code === "ERR_ASSERTION", label + ": the reintroduced bug must fail this check");
}

// ── the real route response (built once) ──
const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const route = async (over) => {
  const s = recorded2026(REC);
  const r = await callWorker(loadSeason(makeWorkerEnv({}), { ...s, ...(over ? over(s) : {}) }), "GET", "/api/standings?year=2026");
  if (r.status !== 200) throw new Error("route " + r.status + " " + r.text.slice(0, 200));
  return r.json;
};
const RESP = await route();
// lastRegularSeasonWeek 5 and no playoff games: the regular season is complete, the season is not.
const RESP_REG_DONE = await route(() => ({ lastRegularSeasonWeek: 5 }));
// A malformed playoff flag in D1 (games row 7): the worker seeds nobody (standings_basis "unavailable").
const RESP_BAD_FLAG = await route((s) => ({ games: s.games.map((g, i) => (i === 7 ? { ...g, is_playoff: "x" } : g)) }));
mfl.restore();
restore();
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── independent expectations from the raw fixture rows ──
const FIDS = REC.franchises.map((f) => f.franchise_id);
const WEEKS = [...new Set(REC.weekly_scores.map((r) => r.week))].sort((a, b) => a - b);
const NAME = Object.fromEntries(RESP.rows.map((r) => [r.franchise_id, r.franchise_name]));
const ROW_ORDER = RESP.rows.map((r) => r.franchise_id);
const score = (w, f) => REC.weekly_scores.find((r) => r.week === w && r.franchise_id === f).team_score;
const rankOf = (w, f) => 1 + FIDS.filter((o) => score(w, o) > score(w, f)).length;
const bottomRankOf = (w, f) => 1 + FIDS.filter((o) => score(w, o) < score(w, f)).length;
const apOf = (w, f) => {
  const r = { w: 0, l: 0, t: 0 };
  for (const o of FIDS) if (o !== f) r[score(w, f) > score(w, o) ? "w" : score(w, f) < score(w, o) ? "l" : "t"]++;
  return r;
};
const res = (a, b) => (a > b ? "W" : a < b ? "L" : "T");
const gamesOf = (w, f) => REC.games.filter((g) => g.week === w && g.franchise_id === f)
  .map((g) => ({ opp: g.opponent_franchise_id, opp_name: NAME[g.opponent_franchise_id], ts: g.team_score, os: g.opponent_score, result: res(g.team_score, g.opponent_score) }))
  .sort((a, b) => a.opp.localeCompare(b.opp));
const recOf = (games) => { const r = { w: 0, l: 0, t: 0 }; for (const g of games) r[g.result.toLowerCase()]++; return r; };
const cumAp = (k, f) => WEEKS.filter((w) => w <= k).reduce((a, w) => { const x = apOf(w, f); return { w: a.w + x.w, l: a.l + x.l, t: a.t + x.t }; }, { w: 0, l: 0, t: 0 });
// every team has the same number of All-Play comparisons, so 2w + t orders the All-Play %
const seasonApRankOf = (k, f) => { if (k < 1) return null; const v = (x) => 2 * x.w + x.t; return 1 + FIDS.filter((o) => v(cumAp(k, o)) > v(cumAp(k, f))).length; };
const pct = (r) => (r.w + 0.5 * r.t) / (r.w + r.l + r.t);
const r2 = (n) => Math.round(n * 100) / 100;
// exact: points as integer hundredths, one division, halves up (JS Math.round) — the convention the site uses
const c100 = (x) => Math.round(x * 100);
const half2 = (num, den) => Math.round((num * 100) / den) / 100;
const bySortOpp = (games) => games.slice().sort((a, b) => a.opp.localeCompare(b.opp));

// ════════ the real route response: shape ════════
test("route: the recorded Week 5 response is the current-season ladder (the fixture this file depends on)", () => {
  t.equal(RESP.standings_basis, "regular_season_ladder");
  t.equal(RESP.regular_season.through_week, 5);
  t.deepEqual(WEEKS, [1, 2, 3, 4, 5]);
  t.equal(FIDS.length, 12);
  t.ok(REC.weekly_scores.every((r) => r.is_playoff === 0) && REC.games.every((g) => g.is_playoff === 0));
  t.equal(REC.games.length, 156, "13 games each through Week 5 — weeks of two and three games");
});

// ════════ a. completedWeeks ════════
test("completedWeeks: Weeks 1-5 regular, no playoff weeks", () => {
  const c = RACE.completedWeeks(RESP);
  t.equal(c.status, "ok"); t.deepEqual(c.regular, [1, 2, 3, 4, 5]); t.deepEqual(c.playoff, []); t.deepEqual(c.problems, []);
  const pre = RACE.completedWeeks({ ...clone(RESP), weekly: [], weeklyScores: [] });
  t.equal(pre.status, "preseason"); t.deepEqual([pre.regular, pre.playoff], [[], []]);
  const short = clone(RESP); short.weeklyScores = short.weeklyScores.filter((r) => !(r.w === 3 && r.fid === "0007"));
  const s = RACE.completedWeeks(short);
  t.equal(s.status, "incomplete"); t.equal(s.regular, null);
  t.ok(s.problems.some((p) => p.code === "partial_week" && p.week === 3 && p.missing.includes("0007")));
  t.equal(RACE.completedWeeks({ ...clone(RESP), weekly: null }).status, "ok", "reads weeklyScores only — a failed games query doesn't hide which weeks are scored");
});

// ════════ b. weekTable ════════
test("weekTable(5): C-Town Chivalry tops Week 5 with 280.5, 8.0 over Real Deal Creel; every row matches the raw rows", () => {
  const wt = RACE.weekTable(RESP, 5);
  t.equal(wt.status, "ok"); t.equal(wt.week, 5); t.equal(wt.isPlayoff, false);
  t.deepEqual(wt.top, { franchise_ids: ["0009"], score: 280.5, margin_over_second: 8, second_franchise_id: "0008", second_franchise_ids: ["0008"] });
  const lowScore = Math.min(...FIDS.map((f) => score(5, f)));
  t.deepEqual(wt.low, { franchise_ids: FIDS.filter((f) => score(5, f) === lowScore), score: lowScore });
  t.deepEqual(wt.low.franchise_ids, ["0003"]);
  const expectOrder = FIDS.slice().sort((a, b) => score(5, b) - score(5, a) || ROW_ORDER.indexOf(a) - ROW_ORDER.indexOf(b));
  t.deepEqual(wt.rows.map((r) => r.franchise_id), expectOrder);
  for (const r of wt.rows) {
    const f = r.franchise_id;
    t.equal(r.name, NAME[f]); t.equal(r.score, score(5, f)); t.equal(r.rank, rankOf(5, f));
    t.deepEqual(r.ap, apOf(5, f));
    t.deepEqual(bySortOpp(r.games), gamesOf(5, f));
    t.deepEqual(r.record, recOf(gamesOf(5, f)));
    t.equal(r.seasonApRank, seasonApRankOf(5, f)); t.equal(r.seasonApRankBefore, seasonApRankOf(4, f));
    t.equal(r.apRankChange, seasonApRankOf(4, f) - seasonApRankOf(5, f));
  }
  t.equal(wt.rows.reduce((n, r) => n + r.games.length, 0), REC.games.filter((g) => g.week === 5).length, "three games each in Week 5");
});
test("weekTable(1): HammerTime 312.8, 54.3 over Pure Greatness; no season rank before Week 1", () => {
  const wt = RACE.weekTable(RESP, 1);
  t.equal(wt.status, "ok");
  t.deepEqual([wt.top.franchise_ids, wt.top.score, wt.top.margin_over_second, wt.top.second_franchise_id], [["0005"], 312.8, 54.3, "0004"]);
  t.ok(wt.rows.every((r) => r.seasonApRankBefore === null && r.apRankChange === null));
  t.ok(wt.rows.every((r) => r.seasonApRank === r.rank), "after one week the All-Play order is the score order");
});
test("weekTable: the season All-Play rank is descriptive — through Week 5 it agrees with the worker's regular-season All-Play records, and is not the seed", () => {
  const wt = RACE.weekTable(RESP, 5);
  for (const row of RESP.rows) {
    const c = cumAp(5, row.franchise_id);
    t.deepEqual([row.regular_season.all_play.w, row.regular_season.all_play.l, row.regular_season.all_play.t], [c.w, c.l, c.t], "worker vs raw rows " + row.franchise_id);
  }
  const creel = wt.rows.find((r) => r.franchise_id === "0008"), cbp = wt.rows.find((r) => r.franchise_id === "0002");
  t.equal(creel.seasonApRank, cbp.seasonApRank, "Creel and CBP share an All-Play rank (32-23 each)…");
  t.deepEqual([RESP.rows.find((r) => r.franchise_id === "0008").playoff_seed, RESP.rows.find((r) => r.franchise_id === "0002").playoff_seed], [4, 5], "…while the worker seeds them 4 and 5");
});
test("weekTable: an unplayed week, a bad week argument, and preseason", () => {
  const w9 = RACE.weekTable(RESP, 9);
  t.equal(w9.status, "unavailable"); t.equal(w9.rows, null); t.ok(w9.problems.some((p) => p.code === "week_not_scored"));
  for (const bad of [0, -1, 2.5, "x", null, undefined]) t.equal(RACE.weekTable(RESP, bad).status, "unavailable", String(bad));
  t.equal(RACE.weekTable(RESP, "5").status, "ok", "a numeric string week is a week");
  const pre = RACE.weekTable({ ...clone(RESP), weekly: [], weeklyScores: [] }, 1);
  t.equal(pre.status, "preseason"); t.equal(pre.rows, null);
});

// ════════ c. seasonWeeklyLeaders ════════
test("seasonWeeklyLeaders: 2026 Weeks 1-5 top scores — HammerTime 1, Blake Bombers 1, C-Town Chivalry 2, Cleon Ca$h 1", () => {
  const L = RACE.seasonWeeklyLeaders(RESP, { weeks: "regular" });
  t.equal(L.status, "ok");
  t.deepEqual(L.weeks.map((w) => [w.week, w.top_franchise_ids, w.score, w.isPlayoff]),
    [[1, ["0005"], 312.8, false], [2, ["0010"], 303.4, false], [3, ["0009"], 254.8, false], [4, ["0011"], 294.7, false], [5, ["0009"], 280.5, false]]);
  t.deepEqual(L.weeks.map((w) => w.margin_over_second), [54.3, 21.6, 8.9, 4.8, 8]);
  const tops = Object.fromEntries(Object.entries(L.byFranchise).filter(([, v]) => v.topWeeks).map(([f, v]) => [f, v.topWeeks]));
  t.deepEqual(tops, { "0005": 1, "0009": 2, "0010": 1, "0011": 1 });
  for (const f of FIDS) {
    const b = L.byFranchise[f], ranks = WEEKS.map((w) => rankOf(w, f)), scores = WEEKS.map((w) => score(w, f));
    t.equal(b.top3, ranks.filter((r) => r <= 3).length, f + " top3");
    t.equal(b.bottom3, WEEKS.filter((w) => bottomRankOf(w, f) <= 3).length, f + " bottom3");
    t.equal(b.avgRank, half2(ranks.reduce((a, x) => a + x, 0), ranks.length));
    t.deepEqual([b.bestRank, b.worstRank], [Math.min(...ranks), Math.max(...ranks)]);
    const hi = Math.max(...scores), lo = Math.min(...scores);
    t.deepEqual(b.highScore, { week: WEEKS[scores.indexOf(hi)], score: hi });
    t.deepEqual(b.lowScore, { week: WEEKS[scores.indexOf(lo)], score: lo });
  }
  t.deepEqual(RACE.seasonWeeklyLeaders(RESP), L, "regular is the default");
  t.deepEqual(RACE.seasonWeeklyLeaders(RESP, { weeks: "all" }).weeks, L.weeks, "no playoff weeks yet: all = regular");
  t.equal(RACE.seasonWeeklyLeaders(RESP, { weeks: "playoffs" }).status, "unavailable", "an unknown option is refused, not guessed");
});
test("seasonWeeklyLeaders: 'all' adds playoff weeks (the weekly high-score prize covers all 17); 'regular' leaves them out", () => {
  const p = clone(RESP);
  p.regular_season.last_regular_season_week = 5;
  for (const f of FIDS) p.weeklyScores.push({ w: 6, fid: f, ts: f === "0007" ? 333.3 : 100 + Number(f), opt: 0, po: 1 });
  const all = RACE.seasonWeeklyLeaders(p, { weeks: "all" }), reg = RACE.seasonWeeklyLeaders(p, { weeks: "regular" });
  t.equal(all.status, "ok"); t.equal(reg.status, "ok");
  t.deepEqual(all.weeks[5], { week: 6, isPlayoff: true, top_franchise_ids: ["0007"], score: 333.3, margin_over_second: r2(333.3 - 112) });
  t.equal(all.byFranchise["0007"].topWeeks, 1); t.equal(reg.byFranchise["0007"].topWeeks, 0);
  t.equal(reg.weeks.length, 5);
});

// ════════ d. teamWeeklyHistory ════════
test("teamWeeklyHistory(0008): every week from the raw rows, and the worker's seed after each week", () => {
  const h = RACE.teamWeeklyHistory(RESP, "0008");
  t.equal(h.status, "ok");
  t.deepEqual(h.weeks.map((w) => w.week), WEEKS);
  for (const w of h.weeks) {
    t.equal(w.isPlayoff, false); t.equal(w.score, score(w.week, "0008")); t.equal(w.rank, rankOf(w.week, "0008"));
    t.deepEqual(w.ap, apOf(w.week, "0008")); t.deepEqual(bySortOpp(w.games), gamesOf(w.week, "0008"));
    const c = cumAp(w.week, "0008");
    t.deepEqual(w.cumulativeAp, { ...c, pct: pct(c) }); t.equal(w.seasonApRank, seasonApRankOf(w.week, "0008"));
  }
  t.deepEqual(h.weeks[4].cumulativeAp, { w: 32, l: 23, t: 0, pct: 32 / 55 });
  // seed_by_week straight from the worker: after Weeks 1-5 Real Deal Creel was 4th, 6th, 5th, 6th, 4th in its order
  t.deepEqual(h.seedByWeek, [
    { week: 1, orderIndex: 3, seed: 4, inField: true }, { week: 2, orderIndex: 5, seed: 6, inField: true },
    { week: 3, orderIndex: 4, seed: 5, inField: true }, { week: 4, orderIndex: 5, seed: 6, inField: true },
    { week: 5, orderIndex: 3, seed: 4, inField: true }]);
  for (const s of h.seedByWeek) t.equal(RESP.regular_season.seed_by_week[s.week][s.orderIndex], "0008");
  const hawks = RACE.teamWeeklyHistory(RESP, "0012").seedByWeek;
  t.deepEqual(hawks[3], { week: 4, orderIndex: 4, seed: 5, inField: true });
  t.deepEqual(hawks[4], { week: 5, orderIndex: 6, seed: null, inField: false }, "7th in the order: outside the field");
  t.equal(RACE.teamWeeklyHistory(RESP, 8).status, "ok", "an unpadded id is the same franchise");
  t.equal(RACE.teamWeeklyHistory(RESP, "0099").status, "unavailable");
  t.deepEqual(RACE.teamWeeklyHistory({ ...clone(RESP), regular_season: null }, "0008").seedByWeek, [], "no seed_by_week → []");
});

// ════════ e. scoredFaced ════════
test("scoredFaced: Points For (one score a week), Points Against per game, and the derived figures — all from the raw rows", () => {
  const sf = RACE.scoredFaced(RESP);
  t.equal(sf.status, "ok");
  const pfOf = (f) => WEEKS.reduce((a, w) => a + score(w, f), 0);
  const gamesAll = (f) => WEEKS.flatMap((w) => gamesOf(w, f).map((g) => ({ ...g, week: w })));
  const paPg = (f) => { const g = gamesAll(f); return g.reduce((a, x) => a + x.os, 0) / g.length; };
  const paPgCents = (f) => { const g = gamesAll(f); return r2(r2(g.reduce((a, x) => a + x.os, 0)) / g.length); };   // the worker's rounding: total to cents, then per game
  for (const f of FIDS) {
    const s = sf.byFranchise[f], g = gamesAll(f), wr = RESP.rows.find((r) => r.franchise_id === f).regular_season;
    t.equal(s.scored.pf, r2(pfOf(f))); t.equal(s.scored.pf, wr.points_for, "agrees with the worker's points_for " + f);
    t.equal(s.scored.pfPerWeek, wr.pf_per_week);
    t.equal(s.scored.pfRank, 1 + FIDS.filter((o) => Math.round(pfOf(o) * 100) > Math.round(pfOf(f) * 100)).length);
    t.equal(s.scored.avgWeeklyRank, half2(WEEKS.reduce((a, w) => a + rankOf(w, f), 0), 5));
    const sc = WEEKS.map((w) => score(w, f));
    t.deepEqual(s.scored.highWeek, { week: WEEKS[sc.indexOf(Math.max(...sc))], score: Math.max(...sc) });
    t.deepEqual(s.scored.lowWeek, { week: WEEKS[sc.indexOf(Math.min(...sc))], score: Math.min(...sc) });
    const l3 = [3, 4, 5].reduce((a, w) => { const x = apOf(w, f); return { w: a.w + x.w, l: a.l + x.l, t: a.t + x.t }; }, { w: 0, l: 0, t: 0 });
    t.deepEqual(s.scored.last3, { weeks: [3, 4, 5], avgRank: half2(rankOf(3, f) + rankOf(4, f) + rankOf(5, f), 3), ap: { ...l3, pct: pct(l3) } });
    t.equal(g.length, 13);
    t.equal(s.faced.paPerGame, paPgCents(f)); t.equal(s.faced.paPerGame, wr.pa_per_game, "agrees with the worker's pa_per_game " + f);
    t.equal(s.faced.paRank, 1 + FIDS.filter((o) => paPg(o) > paPg(f) + 1e-9).length);
    // sum over games of (opp score x 4 − opp's other four weeks), in hundredths, over 4 x 13
    const otherWeeks = (o, w) => WEEKS.filter((x) => x !== w).reduce((a, x) => a + c100(score(x, o)), 0);
    t.equal(s.faced.oppVsUsual, Math.round(g.reduce((a, x) => a + c100(x.os) * 4 - otherWeeks(x.opp, x.week), 0) / (4 * g.length)) / 100);
    t.deepEqual(s.faced.closeGames, recOf(g.filter((x) => Math.abs(x.ts - x.os) < 10 - 1e-9)));
    const rec = recOf(g);
    t.deepEqual(s.overall.record, { ...rec, pct: pct(rec) });
    t.deepEqual([s.overall.record.w, s.overall.record.l, s.overall.record.t], [wr.record.w, wr.record.l, wr.record.t]);
    t.deepEqual(s.overall.ap, { ...cumAp(5, f), pct: pct(cumAp(5, f)) });
    const ew2 = g.reduce((a, x) => { const ap = apOf(x.week, f); return a + 2 * ap.w + ap.t; }, 0);   // expected wins x 22
    t.equal(s.overall.expectedWins, half2(ew2, 22)); t.equal(s.overall.luck, half2((2 * rec.w + rec.t) * 11 - ew2, 22));
    t.equal(s.overall.pf, s.scored.pf); t.equal(s.overall.paPerGame, s.faced.paPerGame);
  }
  t.equal(sf.byFranchise["0009"].scored.pfRank, 1, "C-Town Chivalry leads the league in Points For (1297.3)");
  t.deepEqual(sf.byFranchise["0008"].overall.record, { w: 9, l: 4, t: 0, pct: 9 / 13 });
  t.equal(sf.byFranchise["0002"].faced.oppVsUsual, -1.57, "CBP's opponents: exactly −63/40 = −1.575 below their usual, rounded half up — not left to float summation order");
});

// ════════ F3 for every weekly view ════════
const VIEWS = {
  completedWeeks: { run: (p) => RACE.completedWeeks(p), value: (r) => r.regular, readsGames: false, empty: [] },
  weekTable: { run: (p) => RACE.weekTable(p, 1), value: (r) => r.rows, readsGames: true, empty: null },
  seasonWeeklyLeaders: { run: (p) => RACE.seasonWeeklyLeaders(p, { weeks: "all" }), value: (r) => r.weeks, readsGames: false, empty: [] },
  teamWeeklyHistory: { run: (p) => RACE.teamWeeklyHistory(p, "0008"), value: (r) => r.weeks, readsGames: true, empty: [] },
  scoredFaced: { run: (p) => RACE.scoredFaced(p), value: (r) => r.byFranchise, readsGames: true, empty: {} },
};
const MALFORMED_FLAGS = [["null", null], ["undefined", undefined], ['"x"', "x"], ["2", 2], ['"00"', "00"], ["true-ish 'yes'", "yes"]];
for (const [name, V] of Object.entries(VIEWS)) {
  test(`F3 ${name}: ok on the real rows; a malformed playoff flag on one relevant row → incomplete with no values (every malformed value, either input)`, () => {
    t.equal(V.run(RESP).status, "ok");
    for (const [label, po] of MALFORMED_FLAGS) {
      const a = clone(RESP); a.weeklyScores[7].po = po; if (po === undefined) delete a.weeklyScores[7].po;
      const ra = V.run(a);
      t.equal(ra.status, "incomplete", "weeklyScores po=" + label); t.equal(V.value(ra), null);
      t.ok(ra.problems.some((p) => p.code === "malformed_playoff_flag"));
      if (V.readsGames) {
        const b = clone(RESP); b.weekly[11].po = po;
        const rb = V.run(b);
        t.equal(rb.status, "incomplete", "weekly po=" + label); t.equal(V.value(rb), null);
      }
    }
  });
  test(`F3 ${name}: valid flags 0 / "0" / false and 1 / "1" / true read alike`, () => {
    const base = V.run(RESP);
    for (const po of ["0", false]) {
      const p = clone(RESP); p.weeklyScores.forEach((r) => (r.po = po)); p.weekly.forEach((m) => (m.po = po));
      t.deepEqual(V.run(p), base, "po=" + JSON.stringify(po));
    }
    // the same extra playoff week spelled three ways gives one result
    const withPo = (po) => {
      const p = clone(RESP); p.regular_season.last_regular_season_week = 5;
      for (const f of FIDS) p.weeklyScores.push({ w: 6, fid: f, ts: 150 + Number(f), opt: 0, po });
      return V.run(p);
    };
    const one = withPo(1);
    t.equal(one.status, "ok"); t.deepEqual(withPo("1"), one); t.deepEqual(withPo(true), one);
  });
  test(`F3 ${name}: only playoff rows is NOT preseason — incomplete`, () => {
    const p = clone(RESP); p.weeklyScores.forEach((r) => (r.po = 1)); p.weekly.forEach((m) => (m.po = 1));
    const r = V.run(p);
    t.equal(r.status, "incomplete"); t.notEqual(r.status, "preseason"); t.equal(V.value(r), null);
  });
  test(`F3 ${name}: a FAILED query (null) is unavailable, never preseason; a genuinely empty season is preseason`, () => {
    const s = V.run({ ...clone(RESP), weeklyScores: null });
    t.equal(s.status, "unavailable"); t.equal(V.value(s), null);
    const g = V.run({ ...clone(RESP), weekly: null });
    if (V.readsGames) { t.equal(g.status, "unavailable"); t.equal(V.value(g), null); }
    else t.equal(g.status, "ok", "does not read the games");
    const pre = V.run({ ...clone(RESP), weekly: [], weeklyScores: [] });
    t.equal(pre.status, "preseason"); t.deepEqual(V.value(pre), V.empty);
  });
  test(`F3 ${name}: rows of a franchise NOT on rows[] — even with a malformed flag — are ignored and change nothing`, () => {
    const p = clone(RESP);
    p.weeklyScores.push({ w: 1, fid: "0099", ts: 999, opt: 0, po: "x" }, { w: 2, fid: "0098", ts: 5, opt: 0, po: 0 });
    p.weekly.push({ w: 1, fid: "0099", ts: 999, opp: "0098", os: 1, div: 0, po: null }, { w: 1, fid: "0098", ts: 1, opp: "0099", os: 999, div: 0, po: 0 });
    t.deepEqual(V.run(p), V.run(RESP));
    const onlyForeign = V.run({ ...clone(RESP), weeklyScores: [{ w: 1, fid: "0099", ts: 1, po: "x" }], weekly: [{ w: 1, fid: "0099", opp: "0098", ts: 1, os: 2, po: "x" }] });
    t.equal(onlyForeign.status, "preseason", "the RELEVANT input is genuinely empty");
  });
  test(`F3 ${name}: a garbage row (null, a string, a row with no fid) can't be shown to be foreign → incomplete, never dropped`, () => {
    for (const junk of [null, "garbage", 7, [], { w: 1, ts: 100, po: 0 }, { w: 1, fid: "", ts: 100, po: 0 }]) {
      const a = clone(RESP); a.weeklyScores.splice(3, 0, junk);
      t.equal(V.run(a).status, "incomplete", "weeklyScores + " + JSON.stringify(junk));
      t.equal(V.run({ ...clone(RESP), weeklyScores: [junk], weekly: [] }).status, "incomplete", "only " + JSON.stringify(junk) + " is not preseason");
      if (V.readsGames) {
        const b = clone(RESP); b.weekly.splice(5, 0, junk);
        t.equal(V.run(b).status, "incomplete", "weekly + " + JSON.stringify(junk));
      }
    }
    if (V.readsGames) {
      const noOpp = clone(RESP); delete noOpp.weekly[0].opp;
      t.equal(V.run(noOpp).status, "incomplete", "a game row with no opponent");
    }
  });
  test(`F3 ${name}: a short or contradictory week is incomplete`, () => {
    const missing = clone(RESP); missing.weeklyScores = missing.weeklyScores.filter((r) => !(r.w === 1 && r.fid === "0004"));
    t.equal(V.run(missing).status, "incomplete", "a franchise missing from Week 1");
    const conflict = clone(RESP); conflict.weeklyScores.push({ ...conflict.weeklyScores.find((r) => r.w === 1), ts: 1 });
    t.equal(V.run(conflict).status, "incomplete", "two different Week 1 scores for one team");
    const dupe = clone(RESP); dupe.weeklyScores.push({ ...dupe.weeklyScores.find((r) => r.w === 1) });
    t.deepEqual(V.run(dupe), V.run(RESP), "an identical duplicate is the same row");
    if (V.readsGames) {
      const noRecip = clone(RESP); noRecip.weekly.splice(noRecip.weekly.findIndex((m) => m.w === 1 && m.fid === "0002"), 1);
      t.equal(V.run(noRecip).status, "incomplete", "one side of a Week 1 game missing");
      const mismatch = clone(RESP); mismatch.weekly.find((m) => m.w === 1).ts += 1;
      t.equal(V.run(mismatch).status, "incomplete", "a game score that disagrees with the weekly score");
    }
  });
}

// ════════ PART 1 — each fix, and the reintroduced bug failing the same check ════════
test("PART 1 #1 rule vii: [null], ['garbage'] or a row with no fid is malformed → incomplete, not preseason (both tables, and race())", () => {
  const E = ["0001", "0002"];
  const apCheck = (R) => {
    for (const junk of [[null], ["garbage"], [{ w: 1, ts: 100, po: 0 }], [{ w: 1, fid: null, ts: 100, po: 0 }]]) {
      t.deepEqual(R.deriveRegSeasonApTable(junk, E), { status: "incomplete", byFid: null }, JSON.stringify(junk));
    }
  };
  catches("AP table guard", "if (!isRowObject(r) || !hasId(r.fid)) { sawMalformedRow = true; return; }", "if (!r) return;", apCheck);
  const ovCheck = (R) => {
    for (const junk of [[null], ["garbage"], [{ w: 1, ts: 100, opp: "0001", os: 90, po: 0 }], [{ w: 1, fid: "0001", ts: 100, os: 90, po: 0 }]]) {
      t.deepEqual(R.deriveRegSeasonOverallTable(junk, E), { status: "incomplete", byFid: null }, JSON.stringify(junk));
    }
  };
  catches("Overall table guard", "if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) { sawMalformedRow = true; return; }", "if (!m) return;", ovCheck);
  // through race(): a garbage row is not "nobody has played" — luck is unavailable, not a preseason 0
  const raceCheck = (R) => {
    const rows = E.map((f) => ({ franchise_id: f, franchise_name: f, playoff_seed: null, playoff_status: "non_playoff" }));
    const out = R.race({ rows, weekly: [null], weeklyScores: ["garbage"] });
    t.equal(out.byFranchise["0001"].luck, null); t.equal(out.byFranchise["0001"].expectedWins, null);
  };
  raceCheck(RACE);
  const both = mutant("if (!isRowObject(r) || !hasId(r.fid)) { sawMalformedRow = true; return; }", "if (!r) return;",
    "if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) { sawMalformedRow = true; return; }", "if (!m) return;");
  t.throws(() => raceCheck(both), (e) => e && e.code === "ERR_ASSERTION", "both guards reverted: race() reads preseason zeros again");
});
test("PART 1 #2 the weekly AP-rank strip uses normalizePo: '0' is a regular week, an unrecognized flag makes the strip unavailable (null)", () => {
  const ws = (po) => [{ w: 1, fid: "0001", ts: 120, po }, { w: 1, fid: "0002", ts: 100, po }];
  const check = (R) => {
    t.equal(R.weeklyApRank(ws("0"), ["0001", "0002"]).byFranchise["0001"][1].playoff, false, '"0" is NOT a playoff week');
    t.equal(R.weeklyApRank(ws("1"), ["0001", "0002"]).byFranchise["0001"][1].playoff, true);
    t.equal(R.weeklyApRank(ws(null), ["0001", "0002"]), null, "a null flag is not guessed as regular season");
    t.equal(R.weeklyApRank(ws("x"), ["0001", "0002"]), null);
  };
  catches("weeklyApRank flag", "var rankPo = normalizePo(r.po);", "var rankPo = !!r.po;", check);
  // race(): the strip is null when unavailable; foreign rows are ignored
  const rows = ["0001", "0002"].map((f) => ({ franchise_id: f, franchise_name: f }));
  t.equal(RACE.race({ rows, weekly: [], weeklyScores: ws(null) }).byFranchise["0001"].weeklyRank, null);
  const ok = RACE.race({ rows, weekly: [], weeklyScores: ws(0).concat([{ w: 1, fid: "0099", ts: 999, po: "x" }]) }).byFranchise["0001"].weeklyRank;
  t.deepEqual(ok, { maxWeek: 1, weeks: { 1: { rank: 1, playoff: false } } }, "the foreign 999 neither ranks nor poisons the strip");
});
test("PART 1 #2 the game log uses normalizePo: '0' is regular season, an unrecognized flag makes the log unavailable (null)", () => {
  const rows = [{ franchise_id: "0001", franchise_name: "Me" }, { franchise_id: "0002", franchise_name: "Rival" }];
  const wk = (po) => [{ w: 1, fid: "0001", ts: 120, opp: "0002", os: 100, po }, { w: 1, fid: "0002", ts: 100, opp: "0001", os: 120, po }];
  const check = (R) => {
    t.equal(R.gameLogForFranchise(wk("0"), rows, "0001")[0].is_playoff, false, '"0" is NOT a playoff game');
    t.equal(R.gameLogForFranchise(wk(1), rows, "0001")[0].is_playoff, true);
    t.equal(R.gameLogForFranchise(wk(null), rows, "0001"), null, "a null flag is not guessed as regular season");
    t.equal(R.gameLogForFranchise(wk("x"), rows, "0001"), null);
  };
  catches("game log flag", "var logPo = normalizePo(m.po);", "var logPo = !!m.po;", check);
  t.equal(RACE.gameLogForFranchise([null], rows, "0001"), null, "a garbage row can't be shown to be someone else's game");
  t.deepEqual(RACE.formForFranchise(wk(null), "0001"), { last5: null, last3: null }, "form: same rule");
  t.deepEqual(RACE.formForFranchise(wk("0"), "0001"), { last5: ["W"], last3: ["W"] });
});
test("PART 1 #3 In the hunt keeps the worker's order and shows the worker's ap_back (real Week 5 response)", () => {
  const OUTSIDE = RESP.rows.filter((r) => r.playoff_seed == null).map((r) => r.franchise_id);
  t.deepEqual(OUTSIDE, ["0012", "0011", "0001", "0003", "0006", "0007"]);
  const check = (R) => {
    const g = R.projectedPlayoffGroups(RESP.rows, RESP.weeklyScores);
    t.deepEqual(g.inTheHunt.map((e) => e.franchise_id), OUTSIDE);
    t.deepEqual(g.inTheHunt.map((e) => e.apGB), RESP.rows.filter((r) => r.playoff_seed == null).map((r) => r.ap_back));
    // a worker order that disagrees with games back is still the order shown
    const rows = clone(RESP.rows); const a = rows.findIndex((r) => r.franchise_id === "0012"), b = rows.findIndex((r) => r.franchise_id === "0007");
    [rows[a], rows[b]] = [rows[b], rows[a]];
    t.deepEqual(R.projectedPlayoffGroups(rows, RESP.weeklyScores).inTheHunt.map((e) => e.franchise_id), ["0007", "0011", "0001", "0003", "0006", "0012"]);
  };
  catches("In the hunt re-sort", "    // Teams outside the field stay in the WORKER's order (its ladder) — no re-sort by games back or anything else.\n",
    "    inTheHunt.sort(function (a, b) { var ag = a.apGB == null ? Infinity : a.apGB, bg = b.apGB == null ? Infinity : b.apGB; return (ag - bg) || (a.order - b.order); });\n", check);
  t.deepEqual(RESP.rows.filter((r) => r.playoff_seed == null).map((r) => r.ap_back), [2, 8, 11, 15, 17, 20]);
  // the worker's figure is used even when the client's weekly scores are missing; without it the module's own math runs
  // rows with the worker's ap_back but not its All-Play records: only ap_back can supply the figure without weekly scores
  const apOnly = RESP.rows.map((r) => { const c = clone(r); delete c.regular_season; return c; });
  const prefer = (R) => {
    t.deepEqual(R.projectedPlayoffGroups(apOnly, null).inTheHunt.map((e) => e.apGB), [2, 8, 11, 15, 17, 20]);
    t.ok(R.projectedPlayoffGroups(apOnly, null).wildCards.every((e) => e.apGB === 0));
  };
  catches("ap_back preferred", "var allWorker = list.length > 0 &&", "var allWorker = false &&", prefer);
  const noWorker = RESP.rows.map((r) => { const c = clone(r); delete c.ap_back; delete c.regular_season; return c; });
  t.deepEqual(RACE.projectedPlayoffGroups(noWorker, RESP.weeklyScores).inTheHunt.map((e) => e.apGB), [2, 8, 11, 15, 17, 20], "fallback math on the same rows agrees");
  t.deepEqual(RACE.projectedPlayoffGroups(noWorker, null).inTheHunt.map((e) => e.apGB), [null, null, null, null, null, null], "and is unavailable — never 0 — without weekly scores");
  t.equal(RACE.race(RESP).byFranchise["0001"].apGB, 11);
});
test("PART 1 #3 the division race keeps the worker's division order (MFL standingsSort) — never re-sorted by All-Play games back", () => {
  const check = (R) => {
    const dr = R.divisionRace(RESP.rows, "03", RESP.weeklyScores);
    // C-Town Chivalry 11-2 leads; Cleon Ca$h (6-7, 4-0 in the division) is 2nd on DIVPCT over Hawks (6-7, 0-4)
    t.deepEqual(dr.map((d) => d.franchise_id), ["0009", "0011", "0012"]);
    t.deepEqual(dr.map((d) => d.division_rank), [1, 2, 3]);
    t.deepEqual(dr.map((d) => d.games_back), [0, 5, 5], "the worker's division_games_back");
    t.deepEqual(dr.map((d) => d.ap_gb), [0, 45 - 23, 45 - 29], "All-Play wins behind the leader — shown, not sorted on");
    t.deepEqual(dr.map((d) => [d.overall.w, d.overall.l]), [[11, 2], [6, 7], [6, 7]]);
  };
  catches("division race re-sort", "    return entries; // the worker's order — no sort here",
    "    return entries.sort(function (a, b) { return (a.ap_gb == null ? 99 : a.ap_gb) - (b.ap_gb == null ? 99 : b.ap_gb); });", check);
  t.deepEqual(RESP.rows.filter((r) => r.division === "03").map((r) => r.franchise_id), ["0009", "0012", "0011"], "(the rows themselves are in seed order — the division order is the worker's division_rank)");
});
test("PART 1 #4 whySeed: the worker's vs_above explains why a team is BELOW its neighbor; recorded and unavailable say so", () => {
  const check = (R) => {
    const why = (fid) => R.race(RESP).byFranchise[fid].whySeed;
    t.equal(why("0002").text, "Seed 5: behind Real Deal Creel on Overall record (same All-Play %).");
    t.equal(why("0002").decidingCriterion, "overall");
    t.deepEqual(why("0002").vsAbove, { franchise_id: "0008", name: "Real Deal Creel", step: "overall" });
    t.equal(why("0005").text, "Seed 3: behind Blake Bombers on All-Play %.");
    t.equal(why("0012").text, "Outside the top six — 2 AP wins back; behind Pure Greatness (the last wild card) on All-Play %.");
    t.equal(why("0011").text, "Outside the top six — 8 AP wins back; behind Pure Greatness (the last wild card) on All-Play %. Directly behind Hawks on All-Play %.");
  };
  catches("vs_above wording", "var above = (reason.vs_above && typeof reason.vs_above === 'object' && hasId(reason.vs_above.franchise_id)) ? reason.vs_above : null;", "var above = null;", check);
  t.equal(RACE.race(RESP).byFranchise["0009"].whySeed.text, "Seed 1: in the bye pool (the two best division winners); ranked ahead of Blake Bombers on All-Play %.", "nobody above seed 1: the worker's seed_reason rival");
  // the steps worded, and the structural ones
  const base = clone(RESP.rows.find((r) => r.franchise_id === "0002"));
  const withAbove = (step, seed) => ({ ...base, playoff_seed: seed == null ? 5 : seed, seed_reason: { ...base.seed_reason, vs_above: { franchise_id: "0008", name: "Real Deal Creel", step } } });
  const txt = (row) => RACE.whySeedForRow(row, RESP.rows, RESP.weeklyScores).text;
  t.equal(txt(withAbove("points_for")), "Seed 5: behind Real Deal Creel on season Points For (same All-Play % and Overall record).");
  t.equal(txt(withAbove("head_to_head")), "Seed 5: behind Real Deal Creel on head-to-head (same All-Play %, Overall record and season Points For).");
  t.equal(txt(withAbove("bye_requires_division_title", 3)), "Seed 3: behind Real Deal Creel. A first-round bye needs a division title.");
  t.ok(/not a league rule/.test(txt(withAbove("name"))));
  const out = clone(RESP.rows.find((r) => r.franchise_id === "0012"));
  out.seed_reason.vs_above = { franchise_id: "0010", name: "Blake Bombers", step: "division_winner_in_field" };
  t.equal(txt(out), "Outside the top six — 2 AP wins back; behind Pure Greatness (the last wild card) on All-Play %. Blake Bombers is in the field as a division winner.");
  // recorded: never a step
  const rec = { ...base, seed_reason: { basis: "recorded_final_standings" }, playoff_seed: 3 };
  t.deepEqual([RACE.whySeedForRow(rec, []).text, RACE.whySeedForRow(rec, []).decidingCriterion], ["Seed 3 — from the recorded final standings.", null]);
  // unavailable: the worker's first problem, in words
  const unavailable = (R) => {
    t.equal(RESP_BAD_FLAG.standings_basis, "unavailable");
    const p0 = RESP_BAD_FLAG.regular_season.problems[0];
    t.equal(p0.code, "malformed_playoff_flag");
    const w = R.race(RESP_BAD_FLAG).byFranchise["0002"].whySeed;
    t.equal(w.blocked, true);
    t.equal(w.text, "Seeds unavailable: a Week " + p0.week + " result has a playoff flag that is neither regular season nor playoff.");
    t.equal(w.reason, w.text);
  };
  catches("Seeds unavailable", "if ((reason && reason.basis === 'unavailable') || ctxBasis === 'unavailable') {", "if (false) {", unavailable);
});
test("PART 1 #5 seeds are final once the regular season is complete (seedsFinal); the bracket only once the season is (bracketFinal); projected = !seedsFinal", () => {
  const check = (R) => {
    const wk5 = R.race(RESP);
    t.deepEqual([wk5.seedsFinal, wk5.bracketFinal, wk5.projected], [false, false, true], "Week 5 of 14");
    t.deepEqual([RESP_REG_DONE.regular_season.complete, RESP_REG_DONE.season_complete], [true, false]);
    const done = R.race(RESP_REG_DONE);
    t.deepEqual([done.seedsFinal, done.bracketFinal, done.projected], [true, false, false], "regular season over, playoffs to come");
  };
  catches("seedsFinal", "if (rs && typeof rs === 'object') return rs.complete === true;", "if (rs && typeof rs === 'object') return payload.season_complete === true;", check);
  const recorded = RACE.race({ rows: [], standings_basis: "recorded_final_standings", season_complete: true });
  t.deepEqual([recorded.seedsFinal, recorded.bracketFinal, recorded.projected], [true, true, false]);
  const bad = RACE.race(RESP_BAD_FLAG);
  t.deepEqual([bad.seedsFinal, bad.standingsBasis], [false, "unavailable"]);
  // a caller that passes only part of the response (no standings_basis / regular_season): season_complete, as before
  t.equal(RACE.race({ rows: [], season_complete: true }).projected, false);
  t.equal(RACE.race({ rows: [], season_complete: false }).projected, true);
  t.equal(RACE.race({ rows: RESP.rows, weekly: RESP.weekly, weeklyScores: RESP.weeklyScores, season_complete: false }).projected, true);
});
test("never throws on bad input", () => {
  for (const p of [undefined, null, 0, "x", [], {}, { rows: "x" }, { rows: [null] }, { rows: RESP.rows, weekly: "x", weeklyScores: {} }]) {
    for (const fn of [(x) => RACE.completedWeeks(x), (x) => RACE.weekTable(x, 1), (x) => RACE.seasonWeeklyLeaders(x), (x) => RACE.seasonWeeklyLeaders(x, null), (x) => RACE.teamWeeklyHistory(x, "0001"), (x) => RACE.scoredFaced(x)]) {
      const r = fn(p);
      t.ok(r && ["unavailable", "incomplete"].includes(r.status), JSON.stringify(p) + " → " + (r && r.status));
    }
  }
});

await run("standings_race_weekly");
