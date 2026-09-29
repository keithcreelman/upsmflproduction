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
//
// FIRST FIX'S OWN BUG, caught by live verification AFTER that fix deployed
// (still 2026-09-29): the first fix keyed "played" off
// `scoreJobs[wi].playerScores.playerScore.length > 0` -- but MFL's
// TYPE=playerScores export does NOT return an empty array for an unplayed
// week. Confirmed live, W=10 (unplayed): a single placeholder record,
// [{id:"", score:"", week:"10", isAvailable:"1"}] -- length 1, so the fix
// silently did nothing; the live numbers were unchanged after deploying it.
// Now keys off whether any row actually has a parseable score
// (!isNaN(parseFloat(s.score))), the exact same predicate the scoring loop
// below already applies, so a week only counts as played here if it would
// also contribute a real point value there.
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
  assert.match(route, /weekHasScores\s*=\s*weeks\.map\(\(w,\s*wi\)\s*=>\s*arr\(scoreJobs\[wi\]\?\.playerScores\?\.playerScore\)\.some\(/);
});
check("a bare .length > 0 check on playerScore is NOT used (defeated by MFL's own placeholder record)", () => {
  assert.ok(!/arr\(scoreJobs\[wi\]\?\.playerScores\?\.playerScore\)\.length\s*>\s*0/.test(route),
    "MFL's playerScores export returns a length-1 PLACEHOLDER record ({id:\"\",score:\"\"}) for an unplayed week, " +
    "not a truly empty array -- a bare .length check reads every future week as scored too");
});
check("weekHasScores requires an actually-parseable score, matching the scoring loop's own predicate", () => {
  assert.match(route, /weekHasScores\s*=\s*weeks\.map\(\(w,\s*wi\)\s*=>\s*arr\(scoreJobs\[wi\]\?\.playerScores\?\.playerScore\)\.some\(\(s\)\s*=>\s*!isNaN\(parseFloat\(s\.score\)\)\)\)/);
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

console.log("\n2. the exact live MFL placeholder shape that defeated the first fix");
// Mirrors the real predicate: arr(...).some((s) => !isNaN(parseFloat(s.score)))
function weekHasRealScore(playerScoreArr) {
  return playerScoreArr.some((s) => !isNaN(parseFloat(s.score)));
}
check("MFL's actual unplayed-week response ([{id:\"\",score:\"\",isAvailable:\"1\"}]) reads as NOT played", () => {
  assert.strictEqual(weekHasRealScore([{ id: "", score: "", week: "10", isAvailable: "1" }]), false,
    "this exact shape, live from MFL for an unplayed week, is what silently defeated the length>0 version of this fix");
});
check("a real played week's response (a real id + numeric score string) reads as played", () => {
  assert.strictEqual(weekHasRealScore([{ id: "15698", score: "43.3", week: "3", isAvailable: "0" }]), true);
});
check("a genuinely empty array (belt-and-braces, in case MFL ever does return one) still reads as NOT played", () => {
  assert.strictEqual(weekHasRealScore([]), false);
});

console.log("\n3. truth-table over the intended semantics (mirrors the real aggregation, without live network)");
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
