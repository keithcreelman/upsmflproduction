// Two independent /api/advanced-stats-leaderboard fixes (2026-09-29):
//   1. MFL PPG denominator counted a week as "scored" only when
//      COALESCE(sw.score,0) > 0 -- a real game scored at exactly 0 or negative
//      (sacks/turnovers outweighing production) was wrongly excluded from the
//      denominator, inflating PPG. A week with NO src_weekly row (true bye/DNP)
//      was, and remains, correctly excluded.
//   2. COL_IDP aggregated def_completions_allowed/def_yards_allowed in the SQL
//      but never selected them into the API response, so the "Cmp Allow" /
//      "Yds Allow" columns rendered as a permanent wall of "--".
//   node tests/stats_workbench_ppg_and_idp_fields.test.mjs
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync("worker/src/index.js", "utf8");
const FRONTEND = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

// Anchors, asserted non-empty first: a drifted anchor would otherwise make
// every check below pass vacuously against an empty string.
const csStart = SRC.indexOf("mfl_scoring_agg AS (");
// Search for the NEXT CTE starting past this CTE's own opening text --
// "agg AS (" is a substring of "mfl_scoring_agg AS (" itself, so searching
// from csStart would match inside the anchor and yield a near-empty slice.
const csSearchFrom = csStart > 0 ? csStart + "mfl_scoring_agg AS (".length : -1;
const csEnd = csSearchFrom > 0 ? SRC.indexOf("\n            agg AS (", csSearchFrom) : -1;
const scoringCte = csStart > 0 && csEnd > csStart ? SRC.slice(csStart, csEnd) : "";

const idpStart = SRC.indexOf("const COL_IDP = `");
const idpEnd = SRC.indexOf("`;", idpStart);
const colIdp = idpStart > 0 && idpEnd > idpStart ? SRC.slice(idpStart, idpEnd + 2) : "";

console.log("anchors hold (else everything below is vacuous)");
check("mfl_scoring_agg CTE slice is substantial", () => {
  assert.ok(scoringCte.length > 200, `slice is ${scoringCte.length} chars`);
});
check("COL_IDP slice is substantial", () => {
  assert.ok(colIdp.length > 200, `slice is ${colIdp.length} chars`);
});

console.log("\n1. mfl_games_scored: real score (incl. 0/negative) counts, DNP/absent does not");
check("mfl_games_scored tests score IS NOT NULL, not the score's value", () => {
  assert.match(scoringCte, /SUM\(CASE WHEN sw\.score IS NOT NULL THEN 1 ELSE 0 END\)\s*AS mfl_games_scored/,
    "must count on presence of a real score, never on whether that score is positive");
});
check("the old value-testing predicate is gone", () => {
  assert.ok(!/CASE WHEN COALESCE\(sw\.score,\s*0\)\s*>\s*0/.test(scoringCte),
    "a `> 0` test on the coalesced score reintroduces the bug: a real 0/negative game reads as unscored");
});
check("mfl_points itself is unchanged (still SUMs COALESCE(sw.score,0) over the window)", () => {
  assert.match(scoringCte, /SUM\(COALESCE\(sw\.score,\s*0\)\)\s*AS mfl_points/,
    "the fix is scoped to the denominator only -- total points for the window must not change");
});

// Truth-table over the intended semantics, independent of the SQL text above,
// so the fix is documented in data terms (Keith's spec: zero, negative, DNP,
// normal), not just as a regex on the query.
function scoredGamesCount(scores) { return scores.filter((s) => s !== null).length; }
function totalPoints(scores) { return scores.reduce((sum, s) => sum + (s === null ? 0 : s), 0); }
function ppg(scores) {
  const g = scoredGamesCount(scores);
  return g > 0 ? totalPoints(scores) / g : null;
}
// The exact live shape the fix targets (2026 src_weekly, verified 2026-09-29):
// a real 0, a real negative, a DNP (no row => never reaches this array at
// all -- represented here as a NULL score to model "row exists, unscored",
// the one case status alone cannot distinguish from a genuine zero), and a
// normal positive week.
const FIXTURE = [0, -0.7, null, 12.3];
check("zero score counts as a played, scored game", () => {
  assert.strictEqual(scoredGamesCount([0]), 1);
  assert.strictEqual(ppg([0]), 0, "a single real 0-point game is PPG 0, not unknown");
});
check("negative score counts as a played, scored game", () => {
  assert.strictEqual(scoredGamesCount([-0.7]), 1);
  assert.strictEqual(ppg([-0.7]), -0.7);
});
check("a null (DNP/unscored) entry does not count", () => {
  assert.strictEqual(scoredGamesCount([null]), 0);
  assert.strictEqual(ppg([null]), null, "no real scored game -> unknown, never 0/0 coerced to 0");
});
check("mixed zero + negative + DNP + normal -> denominator excludes only the DNP", () => {
  assert.strictEqual(scoredGamesCount(FIXTURE), 3);
  assert.strictEqual(Math.round(totalPoints(FIXTURE) * 10) / 10, 11.6);
  assert.strictEqual(Math.round(ppg(FIXTURE) * 100) / 100, 3.87);
});
check("the OLD (buggy) formula would have understated the denominator on this fixture", () => {
  // Demonstrates the regression this fix removes: >0 drops the zero AND the
  // DNP, so old PPG reads more than double the corrected value.
  const oldGamesScored = FIXTURE.filter((s) => (s === null ? 0 : s) > 0).length;
  const oldPpg = totalPoints(FIXTURE) / oldGamesScored;
  assert.strictEqual(oldGamesScored, 1, "old formula only counted the single positive week");
  assert.ok(oldPpg > ppg(FIXTURE) * 2.9, `old PPG ${oldPpg} should be inflated vs corrected ${ppg(FIXTURE)}`);
});

console.log("\n2. def_completions_allowed / def_yards_allowed reach the API response");
check("def_completions_allowed is selected in COL_IDP", () => {
  assert.match(colIdp, /a\.def_completions_allowed/, "aggregated in the agg CTE but never projected -- the actual bug");
});
check("def_yards_allowed is selected in COL_IDP", () => {
  assert.match(colIdp, /a\.def_yards_allowed/);
});
check("their sibling def_passer_rating_allowed (already working) is still present, for contrast", () => {
  assert.match(colIdp, /a\.def_passer_rating_allowed/);
});

console.log("\n3. frontend still expects both fields (no drift between worker and page)");
check("stats_workbench.html still defines a def_completions_allowed column", () => {
  assert.match(FRONTEND, /def_completions_allowed:\s*\{[^}]*label:"Cmp Allow"/);
});
check("stats_workbench.html still defines a def_yards_allowed column", () => {
  assert.match(FRONTEND, /def_yards_allowed:\s*\{[^}]*label:"Yds Allow"/);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
