// A game score that disagrees with its week's team scores fails ONLY the views covering that week (#1329 decision 2,
// item 1: "fail only the affected Week 17 data"), and every screen says so in the same plain words.
// Real data: the 2025 /api/standings response (tests/fixtures/standings_2025_recorded.json, the #1330 worker on the
// read-only D1 snapshot of 2026-10-17 14:45 UTC). In it, three 2025 Week 17 games disagree between src_schedule and
// src_franchise_weekly_score (0004 v 0007: 233.7 vs 233.2 · 0005 v 0009: 195.4 vs 196.4 · 0011 v 0012: 157.8 vs
// 158.3); Weeks 1-16 match, game by game and side by side. Plus a regular-week mismatch on the 2026 Week 5 route.
//   node scripts/safe_tests/run.mjs --only standings_week_scoped_problems
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const S2025 = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2025_recorded.json", import.meta.url), "utf8"));
const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w);
const R = w.UPS_STANDINGS_RACE;
const clone = (x) => JSON.parse(JSON.stringify(x));
const SENTENCE_17 = "Week 17: 3 game scores don’t match the teams’ final weekly scores.";

test("2025: the three Week 17 mismatches fail Week 17 only; Weeks 1-16 and the regular-season views stand", () => {
  const p = clone(S2025);
  for (const wk of [1, 8, 14, 15, 16]) t.equal(R.weekTable(p, wk).status, "ok", "Week " + wk);
  const w17 = R.weekTable(p, 17);
  t.equal(w17.status, "incomplete"); t.equal(w17.rows, null, "never a ranked Week 17");
  t.deepEqual(R.describeProblems(w17.problems), [SENTENCE_17], "one sentence: the week and the count of games, not 6 rows");
  t.equal(R.scoredFaced(p).status, "ok", "Scored / Opponent cover the regular season (Weeks 1-14)");
  t.equal(R.seasonWeeklyLeaders(p, { weeks: "all" }).status, "ok", "weekly scores only");
  t.equal(R.completedWeeks(p).status, "ok");
});
test("2025 Team by week: 16 weeks shown, Week 17 listed as unavailable with the reason, nothing invented", () => {
  const h = R.teamWeeklyHistory(clone(S2025), "0009");
  t.equal(h.status, "ok");
  t.equal(h.weeks.length, 17);
  t.deepEqual(h.weeks.filter((x) => x.unavailable).map((x) => x.week), [17]);
  const w17 = h.weeks[16];
  t.deepEqual([w17.score, w17.rank, w17.ap, w17.games, w17.cumulativeAp], [null, null, null, null, null]);
  t.deepEqual(h.unavailableWeeks.map((u) => [u.week, R.describeProblems(u.problems)]), [[17, [SENTENCE_17]]]);
  t.ok(h.weeks.slice(0, 14).every((x) => x.cumulativeAp && x.score != null), "regular weeks keep their running All-Play");
});
let RESP = null;
async function resp2026() {
  if (!RESP) RESP = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  return clone(RESP);
}
test("A regular-week mismatch (2026 Week 3) fails Week 3 and every view that counts it, never Weeks 1-2", async () => {
  const p = await resp2026();
  const g = p.weekly.find((m) => m.w === 3 && m.po === 0);
  const back = p.weekly.find((m) => m.w === 3 && m.fid === g.opp && m.opp === g.fid);
  // Both copies of one game move together (a stat correction that reached the game table, not the weekly scores).
  g.ts = Math.round((g.ts + 0.5) * 10) / 10; back.os = g.ts;
  t.equal(R.weekTable(p, 2).status, "ok");
  const w3 = R.weekTable(p, 3);
  t.equal(w3.status, "incomplete");
  t.deepEqual(R.describeProblems(w3.problems), ["Week 3: 1 game score doesn’t match the teams’ final weekly scores."]);
  t.equal(R.weekTable(p, 5).status, "incomplete", "Week 5's season All-Play rank counts Week 3");
  t.equal(R.scoredFaced(p).status, "incomplete");
  const h = R.teamWeeklyHistory(p, g.fid);
  t.equal(h.status, "ok");
  t.deepEqual(h.weeks.map((x) => x.unavailable), [false, false, true, false, false]);
  t.ok(h.weeks[1].cumulativeAp, "Week 2's running All-Play stands");
  t.deepEqual([h.weeks[3].cumulativeAp, h.weeks[3].seasonApRank, h.weeks[4].cumulativeAp], [null, null, null], "the running All-Play stops at the first unverified regular week");
  t.ok(h.weeks[3].score != null, "Week 4 itself still shows");
});
test("Season-wide problems still fail every view (a malformed playoff flag, an unreadable row, two copies of a game that disagree)", async () => {
  const p = await resp2026();
  p.weekly[0].po = "x";
  t.equal(R.weekTable(p, 1).status, "incomplete");
  t.equal(R.teamWeeklyHistory(p, "0008").status, "incomplete");
  const q = await resp2026();
  q.weeklyScores.push({ w: 2, ts: 100 }); // no fid
  t.equal(R.teamWeeklyHistory(q, "0008").status, "incomplete");
  const c = await resp2026();
  const g = c.weekly.find((m) => m.w === 3 && m.po === 0);
  g.ts += 1; // only one side's copy: the game's two rows now disagree with each other
  t.equal(R.weekTable(c, 1).status, "incomplete", "a game whose two copies disagree can't be placed in any week's truth");
});
test("describeProblems: grouped by kind and week, games counted once, other kinds in words", () => {
  t.deepEqual(R.describeProblems([
    { code: "partial_week", week: 6, missing: ["0001", "0002"] },
    { code: "missing_games", week: 6, franchise_ids: ["0003"] },
    { code: "game_score_mismatch", week: 6, franchise_id: "0004", opponent_franchise_id: "0005" },
    { code: "game_score_mismatch", week: 6, franchise_id: "0005", opponent_franchise_id: "0004" },
    { code: "conflicting_game", week: 2 },
  ]), ["Week 6 is missing scores for 2 teams.", "Week 6 has no game for 1 team.", "Week 6: 1 game score doesn’t match the teams’ final weekly scores.", "Conflicting game (Week 2)."]);
  t.deepEqual(R.describeProblems(null), []);
});

await run();
restore();
