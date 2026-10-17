// Tale of the Tape (site/shared/standings_race.js matchupTape / ownerSeries) on REAL data: the real /api/standings
// route on the recorded 2026 season after Week 5, MFL's own leagueStandings offensive-player / IDP points, and the
// recorded head-to-head history (site/standings/h2h_history.json). Every expected number below was computed
// independently from MFL's weeklyResults exports for Weeks 1-5 (not from this module).
//   node scripts/safe_tests/run.mjs --only standings_matchup_tape
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const LS = JSON.parse(fs.readFileSync(new URL("./fixtures/mfl_2026_wk5_league_standings.json", import.meta.url), "utf8"));
const HIST = JSON.parse(fs.readFileSync(new URL("../site/standings/h2h_history.json", import.meta.url), "utf8"));
const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w);
const R = w.UPS_STANDINGS_RACE;
const opdp = (rows) => Object.fromEntries(rows.map((f) => [f.id, { op: f.op, dp: f.dp }]));
let RESP = null;
async function resp() {
  if (!RESP) RESP = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  return JSON.parse(JSON.stringify(RESP));
}

test("HammerTime (3) vs Pure Greatness (6): quick edges, with ranks among all 12", async () => {
  const m = R.matchupTape(await resp(), "0005", "0004", { offenseIdp: opdp(LS.leagueStandings.franchise) });
  t.equal(m.status, "ok");
  t.deepEqual(m.weeks.regular, [1, 2, 3, 4, 5]); t.deepEqual(m.weeks.last3, [3, 4, 5]);
  t.deepEqual([m.a.record.w, m.a.record.l, m.b.record.w, m.b.record.l], [9, 4, 6, 7], "H2H records");
  t.deepEqual([m.a.ap.w, m.a.ap.l, m.b.ap.w, m.b.ap.l], [37, 18, 31, 24], "All-Play records");
  t.deepEqual([m.a.avg.value, m.a.avg.rank, m.b.avg.value, m.b.avg.rank], [237.44, 3, 230.2, 4]);
  t.deepEqual([m.a.last3.avg, m.a.last3.rank, m.b.last3.avg, m.b.last3.rank], [221.9, 6, 230.97, 4]);
  t.deepEqual([m.a.last3.ap.w, m.a.last3.ap.l, m.b.last3.ap.w, m.b.last3.ap.l], [19, 14, 17, 16]);
  t.deepEqual([m.a.apPerWeek.value, m.a.apPerWeek.rank, m.b.apPerWeek.value, m.b.apPerWeek.rank], [7.4, 3, 6.2, 6]);
  t.deepEqual([m.a.consistency.spread, m.a.consistency.rank, m.b.consistency.spread, m.b.consistency.rank], [42.46, 11, 27.72, 6], "1st = steadiest");
  t.deepEqual(m.edges, { avg: "a", last3: "b", last3ap: "a", apPerWeek: "a", consistency: "b", high: "a", top3: "a", median: "a", bottom3: "a", low: "b", offense: "b", idp: "a" });
  t.deepEqual(m.quickEdges, { a: 3, b: 2, even: 0 });
});
test("Ceiling / Typical / Floor, Offense and IDP per week, points faced per H2H game", async () => {
  const m = R.matchupTape(await resp(), "0005", "0004", { offenseIdp: opdp(LS.leagueStandings.franchise) });
  const c = (s) => [s.ceiling.high.value, s.ceiling.high.rank, s.ceiling.top3.value, s.ceiling.top3.rank, s.ceiling.median.value, s.ceiling.median.rank, s.ceiling.bottom3.value, s.ceiling.bottom3.rank, s.ceiling.low.value, s.ceiling.low.rank];
  t.deepEqual(c(m.a), [312.8, 1, 262.6, 3, 224.8, 3, 208.07, 5, 190.7, 4]);
  t.deepEqual(c(m.b), [268.4, 6, 246.6, 4, 212.9, 8, 208.03, 6, 199.6, 3]);
  t.equal(m.a.ceiling.high.week, 1);
  t.equal(m.offenseIdpStatus, "ok");
  t.deepEqual([m.a.offense.perWeek, m.a.offense.rank, m.a.idp.perWeek, m.a.idp.rank], [175.6, 4, 61.84, 3]);
  t.deepEqual([m.b.offense.perWeek, m.b.offense.rank, m.b.idp.perWeek, m.b.idp.rank], [183.66, 2, 46.54, 10]);
  t.deepEqual([m.a.faced.perGame, m.a.faced.rank, m.b.faced.perGame, m.b.faced.rank], [218.38, 6, 225.52, 2], "1st = faced the most");
  t.deepEqual(m.meetings.map((g) => [g.week, g.aScore, g.bScore, g.result]), [[1, 312.8, 258.5, "W"], [4, 250.2, 211.6, "W"]], "they met in Weeks 1 and 4");
});
test("Offense / IDP split fails closed: missing or not adding up to Points For → null, never a guess", async () => {
  const rows = LS.leagueStandings.franchise.map((f) => ({ ...f }));
  const bad = rows.map((f) => (f.id === "0011" ? { ...f, op: String(Number(f.op) + 5) } : f));
  const m1 = R.matchupTape(await resp(), "0005", "0004", { offenseIdp: opdp(bad) });
  t.equal(m1.offenseIdpStatus, "mismatch"); t.equal(m1.a.offense, null); t.equal(m1.b.idp, null); t.equal(m1.edges.offense, null);
  const m2 = R.matchupTape(await resp(), "0005", "0004", { offenseIdp: opdp(rows.filter((f) => f.id !== "0007")) });
  t.equal(m2.offenseIdpStatus, "missing"); t.equal(m2.a.offense, null);
  const m3 = R.matchupTape(await resp(), "0005", "0004", null);
  t.equal(m3.offenseIdpStatus, "missing");
  t.equal(m3.a.avg.value, 237.44, "the rest of the tape still shows");
});
test("bad input never produces numbers: unknown team, same team, a malformed playoff flag, a failed weekly query", async () => {
  t.equal(R.matchupTape(await resp(), "0005", "0099").status, "unavailable");
  t.equal(R.matchupTape(await resp(), "0005", "0005").status, "unavailable");
  const j = await resp(); j.weeklyScores[3].po = "x";
  const m = R.matchupTape(j, "0005", "0004"); t.equal(m.status, "incomplete"); t.equal(m.a, null);
  const k = await resp(); k.weekly = null;
  t.equal(R.matchupTape(k, "0005", "0004").status, "unavailable");
});
test("owner head-to-head follows the person: owner of record per season, exact names, the live season added", async () => {
  const s = R.ownerSeries(HIST, "Eric Martel", "Brian Cutting", { current: { season: 2026, games: [{ week: 1, aScore: 312.8, bScore: 258.5 }, { week: 4, aScore: 250.2, bScore: 211.6 }] } });
  t.equal(s.status, "ok");
  t.deepEqual(s.regular, { w: 9, l: 2, t: 0 }, "2023-2025 7-2 plus two 2026 wins");
  t.deepEqual(s.playoff, { w: 0, l: 1, t: 0 });
  t.deepEqual(s.seasonsTogether, [2023, 2024, 2025, 2026], "Eric Martel's games start 2023: the 0005 games of earlier owners are not his");
  const k = R.ownerSeries(HIST, "Keith Creelman", "Brian Cutting");
  t.deepEqual([k.regular, k.playoff], [{ w: 9, l: 10, t: 0 }, { w: 1, l: 1, t: 0 }]);
  t.ok(k.seasonsTogether[0] === 2010, "2010 counts for the person (Keith was 0007 that year)");
  t.deepEqual(k.pairingSeasons, [2012, 2020, 2021, 2022, 2023, 2024, 2025], "regular-season games exist only for these seasons");
  const c = R.ownerSeries(HIST, "Brian Cross", "Josh Martel");
  t.deepEqual([c.regular, c.seasonsTogether], [{ w: 0, l: 3, t: 0 }, [2025]], "Cross starts 2025: 2024 0006 is Josh Lima's (owner of record)");
  t.equal(R.ownerSeries(HIST, "Keith", "Brian Cutting").games.length, 0, "no partial-name matching");
  t.equal(R.ownerSeries(null, "a", "b").status, "unavailable");
});

await run("standings_matchup_tape");
mfl.restore();
restore();
