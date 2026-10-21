// A finished season's side is drawn as a bracket only when it IS that season's bracket (#1329 decision 2, item 2):
// verifyActualSide on the REAL /api/playoff-bracket responses for 2010-2016, 2019 and 2025
// (tests/fixtures/playoff_brackets_recorded.json, the #1330 worker on the read-only D1 snapshot of 2026-10-17). The
// recorded champions (1 = UPS champion; 7 = Hawk Tuah Bowl champion from 2011) are the seeds' final_finish; the
// expected outcome per side matches the offline audit in #1329 (comment 6298225934).
//   node scripts/safe_tests/run.mjs --only standings_actual_side_check
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/playoff_brackets_recorded.json", import.meta.url), "utf8")).brackets;
const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w);
const R = w.UPS_STANDINGS_RACE;
function check(y, side) {
  const b = FIX[y];
  const res = R.buildActualBracketResult(b.seeds, b.matchups, b.playoff_weeks);
  const c = R.verifyActualSide(res, side, b.seeds, { season: Number(y), hasConferences: b.has_conferences, matchups: b.matchups });
  return [c.draw, c.reason, c.recordedChampion, c.games.length];
}
test("UPS Championship side: drawn when the rounds fit and the champion is the recorded one", () => {
  t.deepEqual(check("2010", "champ"), [true, null, "0008", 5]);
  t.deepEqual(check("2011", "champ"), [false, "conference_format", "0010", 7], "conference bracket: by week");
  t.deepEqual(check("2012", "champ"), [false, "conference_format", "0003", 7]);
  t.deepEqual(check("2013", "champ"), [false, "seeds_unreadable", "0002", 7], "two teams at seed 7: by week, split by recorded finish");
  t.deepEqual(check("2014", "champ"), [true, null, "0001", 7]);
  t.deepEqual(check("2015", "champ"), [true, null, "0010", 7]);
  t.deepEqual(check("2016", "champ"), [true, null, "0009", 7], "today's Round 1 pairs: never a conference bracket");
  t.deepEqual(check("2019", "champ"), [true, null, "0007", 7]);
  t.deepEqual(check("2025", "champ"), [true, null, "0004", 7]);
});
test("Hawk Tuah Bowl side: every 2010-2015 side by week with the recorded champion; 2016 on drawn", () => {
  t.deepEqual(check("2010", "hawk"), [false, "no_title", null, 5], "2010's toilet bracket had the loser advance: no champion marked");
  t.deepEqual(check("2011", "hawk"), [false, "conference_format", "0003", 7]);
  t.deepEqual(check("2012", "hawk"), [false, "champion_mismatch", "0009", 7]);
  t.deepEqual(check("2013", "hawk"), [false, "seeds_unreadable", "0001", 7]);
  t.deepEqual(check("2014", "hawk"), [false, "champion_mismatch", "0004", 7]);
  t.deepEqual(check("2015", "hawk"), [false, "champion_mismatch", "0009", 7]);
  t.deepEqual(check("2016", "hawk"), [true, null, "0011", 7]);
  t.deepEqual(check("2019", "hawk"), [true, null, "0010", 7]);
  t.deepEqual(check("2025", "hawk"), [true, null, "0011", 7]);
});
test("2013 by recorded finish: games stay on their side, in week order, with scores and winners and no seed numbers", () => {
  const b = FIX["2013"];
  const c = R.verifyActualSide(R.buildActualBracketResult(b.seeds, b.matchups, b.playoff_weeks), "champ", b.seeds, { season: 2013, hasConferences: b.has_conferences, matchups: b.matchups });
  const fin = Object.fromEntries(b.seeds.map((s) => [s.franchise_id, s.final_finish]));
  t.ok(c.games.every((g) => fin[g.a.franchise_id] <= 6 && fin[g.b.franchise_id] <= 6));
  t.deepEqual(c.games.map((g) => g.week), [...c.games.map((g) => g.week)].sort((x, y) => x - y));
  t.ok(c.games.every((g) => g.a.seed === null && g.winner && (g.scoreA > g.scoreB ? g.winner === g.a : g.winner === g.b)));
  const last = c.games.filter((g) => g.week === 16).find((g) => [g.a.franchise_id, g.b.franchise_id].includes("0002"));
  t.equal(last.winner.franchise_id, "0002", "the recorded champion won its last game");
});
test("Fail-safe edges: no recorded finish draws as before; a drawn champion that isn't the recorded one never draws", () => {
  const b = JSON.parse(JSON.stringify(FIX["2019"]));
  const res = R.buildActualBracketResult(b.seeds, b.matchups, b.playoff_weeks);
  const none = b.seeds.map((s) => ({ ...s, final_finish: null }));
  t.deepEqual([R.verifyActualSide(res, "champ", none, { season: 2019 }).draw, R.verifyActualSide(res, "champ", none, { season: 2019 }).reason], [true, "unverified"]);
  const swapped = b.seeds.map((s) => ({ ...s, final_finish: s.final_finish === 1 ? 2 : s.final_finish === 2 ? 1 : s.final_finish }));
  t.deepEqual([R.verifyActualSide(res, "champ", swapped, { season: 2019 }).draw, R.verifyActualSide(res, "champ", swapped, { season: 2019 }).reason], [false, "champion_mismatch"]);
  t.equal(R.verifyActualSide({ status: "unavailable" }, "champ", [], { season: 2019 }).reason, "unavailable");
});

await run();
restore && restore();
function restore() {}
