// /api/mfl-export passes MFL's public leagueStandings through (the Standings matchup sheet reads each team's
// offensive-player and IDP points from it, #1329): keyless, read-only, MFL's body unchanged. Other types still 400.
//   node scripts/safe_tests/run.mjs --only standings_league_standings_export
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const BODY = { leagueStandings: { franchise: [{ id: "0009", pf: "1297.3", op: "1004.6", dp: "292.7" }] }, version: "1.0", encoding: "utf-8" };
mfl.st.exportBody = { leagueStandings: BODY };

test("leagueStandings is passed through unchanged, with no credentials sent to MFL", async () => {
  const r = await callWorker(makeWorkerEnv({}), "GET", "/api/mfl-export?TYPE=leagueStandings&L=74598&YEAR=2026&JSON=1");
  t.equal(r.status, 200);
  t.deepEqual(r.json, BODY);
  const ex = mfl.st.exports.filter((e) => e.type === "leagueStandings");
  t.equal(ex.length, 1, "one MFL read");
  t.equal(ex[0].cookie, "", "no cookie: a public export");
  t.ok(!ex[0].params.APIKEY, "no API key added");
});
test("a type outside the allowlist is still refused", async () => {
  const r = await callWorker(makeWorkerEnv({}), "GET", "/api/mfl-export?TYPE=leagueStandingsX&L=74598&YEAR=2026&JSON=1");
  t.equal(r.status, 400);
});

await run("standings_league_standings_export");
mfl.restore();
restore();
