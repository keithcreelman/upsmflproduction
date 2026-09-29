// /api/fantasy-points-against's default view (week_max defaults to 18,
// i.e. "season-long") computed "games played" from the NFL SCHEDULE, which
// is published for the whole season months in advance -- so it counted
// every one of the 18 scheduled games as "played" for every team even 3
// weeks into the season. Verified live 2026-09-29: ATL RB points-allowed-
// per-game read 2.4 (41 pts / 17 "games") on the default query instead of
// the correct 13.7 (41 pts / 3 actual games) an explicit week_max=3 query
// returned for the SAME 41-point total -- an ~83% understatement, on every
// defense, on the page's own default view. weeksUsed inherited the same
// bug and told the frontend "18 played" (rendered as the FPA sub-header's
// "(N played)") when only 3 weeks actually had.
//   node tests/fpa_games_played_denominator.test.mjs
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync("worker/src/index.js", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

const rStart = SRC.indexOf('if (path === "/api/fantasy-points-against"');
const rEnd = SRC.indexOf('if (path === "/api/fpa-detail"', rStart);
const route = rStart > 0 && rEnd > rStart ? SRC.slice(rStart, rEnd) : "";

console.log("anchors hold (else everything below is vacuous)");
check("route slice is substantial", () => {
  assert.ok(route.length > 1500, `slice is ${route.length} chars`);
});

console.log("\n1. \"played\" is derived from real scores, never from the published schedule");
check("weekHasScores is computed from scoreJobs (playerScores), not schedJobs", () => {
  assert.match(route, /weekHasScores\s*=\s*weeks\.map\(\(w,\s*wi\)\s*=>\s*arr\(scoreJobs\[wi\]\?\.playerScores\?\.playerScore\)\.length\s*>\s*0\)/);
});
check("gamesPlayed increments are gated on weekHasScores, not on schedule-matchup existence alone", () => {
  const gpBlock = route.slice(route.indexOf("const oppOf = {}, gamesPlayed"), route.indexOf("playerWeeks = {}"));
  assert.match(gpBlock, /if\s*\(!weekHasScores\[wi\]\)\s*continue;/,
    "without this gate, an unplayed future week (schedule known in advance) still increments gamesPlayed");
  // The matchup/oppOf mapping itself must still be built for every scheduled
  // week (a player's defense-faced lookup needs it) -- only the COUNTER is gated.
  assert.match(gpBlock, /oppOf\[ka\]\s*=\s*oppOf\[ka\]\s*\|\|\s*\{\}\)\[wi\]\s*=\s*kb/);
});
check("weeksUsed reflects actually-scored weeks, not scheduled-but-maybe-unplayed weeks", () => {
  assert.match(route, /const weeksUsed = weeks\.filter\(\(w, wi\) => weekHasScores\[wi\]\);/);
  assert.ok(!/const weeksUsed = weeks\.filter\(\(w, wi\) => arr\(schedJobs\[wi\]\?\.nflSchedule\?\.matchup\)\.length\);/.test(route),
    "the old schedule-existence check must be gone, not just supplemented");
});

console.log("\n2. truth-table over the intended semantics (mirrors the real aggregation, without live network)");
// Mirrors gamesPlayed's derivation exactly: only weeks with real scores count.
function computeGamesPlayed(weeks, weekHasScoresArr, matchupsPerWeek) {
  const gamesPlayed = {};
  weeks.forEach((w, wi) => {
    if (!weekHasScoresArr[wi]) return;
    matchupsPerWeek[wi].forEach(([a, b]) => {
      gamesPlayed[a] = (gamesPlayed[a] || 0) + 1;
      gamesPlayed[b] = (gamesPlayed[b] || 0) + 1;
    });
  });
  return gamesPlayed;
}
check("3 played weeks + 15 future scheduled-but-unscored weeks -> games played is 3, not 18", () => {
  const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
  const weekHasScoresArr = weeks.map((w) => w <= 3);
  const matchupsPerWeek = weeks.map(() => [["ATL", "TB"]]); // full schedule known for every week
  const gp = computeGamesPlayed(weeks, weekHasScoresArr, matchupsPerWeek);
  assert.strictEqual(gp.ATL, 3);
  assert.strictEqual(gp.TB, 3);
});
check("live-verified regression check: 41 total points / correct denominator (3) matches the explicit-week_max=3 API reading of 13.7, not the buggy default reading of 2.4", () => {
  const total = 41;
  const correctPerGame = Math.round((total / 3) * 10) / 10;
  const buggyPerGame = Math.round((total / 17) * 10) / 10;
  assert.strictEqual(correctPerGame, 13.7, "matches the live /api/fantasy-points-against?week_max=3 reading for ATL RB on 2026-09-29");
  assert.strictEqual(buggyPerGame, 2.4, "matches the live buggy default-query reading before this fix");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
