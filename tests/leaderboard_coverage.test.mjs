// Provisional vs finalized weekly coverage for the current-season leaderboard
// precompute (2026-09-28).
//   node tests/leaderboard_coverage.test.mjs
//
// THE RULE (Keith, 2026-09-28): "wait for all 32 teams" governs calling a
// week FINALIZED, never whether to load/show it. Sunday's games should show
// up Sunday night as PROVISIONAL ("Week 3 provisional — 30/32 teams
// reported") without waiting for Monday Night Football, and Week 2 stays the
// last FINALIZED week until Monday's game is final, all 32 teams are in, AND
// the authoritative completed week actually reaches 3.
//
// Real fixture: 2026-09-28, nflverse's live player_stats for season 2026
// (read via `python3 -c "import nflreadpy as nfl; ..."`) showed week 3 at
// 30 of 32 teams — CHI and PHI (that night's Monday Night Football matchup)
// were the two missing. nfl_team_vegas_weekly already had all 32 teams
// scheduled for week 3 (the NFL schedule is known before kickoff), so
// teams_expected=32 is real, not assumed.
import assert from "assert";
import { computeWeekComplete, computeFinalizedThroughWeek, shouldSkipRebuild } from "../worker/src/leaderboard_coverage.js";

let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("computeWeekComplete");
check("30 of 32 (the live 2026-09-28 Week 3 fixture, CHI/PHI still to play) is NOT complete", () => {
  assert.strictEqual(computeWeekComplete(30, 32), false);
});
check("32 of 32 is complete", () => {
  assert.strictEqual(computeWeekComplete(32, 32), true);
});
check("a bye week (e.g. 30 of 30 scheduled) is complete WITHOUT a hardcoded 32", () => {
  assert.strictEqual(computeWeekComplete(30, 30), true);
});
check("more reported than expected (a data anomaly) still reads complete, not a crash", () => {
  assert.strictEqual(computeWeekComplete(32, 30), true);
});
check("0 of 0 is UNKNOWN, never complete — the exact 0/0-is-not-100% trap", () => {
  assert.strictEqual(computeWeekComplete(0, 0), null);
});
check("missing teams_expected (schedule not loaded yet) is unknown, never complete", () => {
  assert.strictEqual(computeWeekComplete(30, null), null);
});
check("missing teams_reported is unknown, never complete", () => {
  assert.strictEqual(computeWeekComplete(null, 32), null);
});

console.log("\ncomputeFinalizedThroughWeek");
check("THE LIVE 2026-09-28 CASE: built week 3, 30/32 reported (incomplete), authoritative still week 2 -> finalized through week 2, NOT 3", () => {
  const weekComplete = computeWeekComplete(30, 32);
  const r = computeFinalizedThroughWeek({ builtWeek: 3, weekComplete, authoritativeWeek: 2 });
  assert.strictEqual(r, 2, "must never advertise week 3 as finalized while CHI/PHI haven't played");
});
check("after Monday Night Football: built week 3, 32/32 reported, authoritative now week 3 -> finalized through week 3", () => {
  const weekComplete = computeWeekComplete(32, 32);
  const r = computeFinalizedThroughWeek({ builtWeek: 3, weekComplete, authoritativeWeek: 3 });
  assert.strictEqual(r, 3);
});
check("all 32 reported but the schedule/live-scoring clock hasn't caught up yet (authoritative still 2) -> stays at 2, not 3", () => {
  // Guards the OTHER direction: source-complete is not enough by itself if
  // the real-world clock disagrees about which week that even is.
  const weekComplete = computeWeekComplete(32, 32);
  const r = computeFinalizedThroughWeek({ builtWeek: 3, weekComplete, authoritativeWeek: 2 });
  assert.strictEqual(r, 2);
});
check("authoritative week AHEAD of what's complete (e.g. week 4 already underway, week 3 still 30/32) -> capped at builtWeek-1, not authoritativeWeek", () => {
  const weekComplete = computeWeekComplete(30, 32);
  const r = computeFinalizedThroughWeek({ builtWeek: 3, weekComplete, authoritativeWeek: 4 });
  assert.strictEqual(r, 2, "must not report a week ahead of what the board actually has data for");
});
check("builtWeek unresolved -> null, never a guess", () => {
  assert.strictEqual(computeFinalizedThroughWeek({ builtWeek: null, weekComplete: true, authoritativeWeek: 2 }), null);
});
check("authoritativeWeek unresolved -> null, never a guess", () => {
  assert.strictEqual(computeFinalizedThroughWeek({ builtWeek: 3, weekComplete: true, authoritativeWeek: null }), null);
});
check("week 1 provisional, nothing finalized yet -> 0, not negative", () => {
  const weekComplete = computeWeekComplete(20, 32);
  const r = computeFinalizedThroughWeek({ builtWeek: 1, weekComplete, authoritativeWeek: 0 });
  assert.strictEqual(r, 0);
});

console.log("\nshouldSkipRebuild (idempotency)");
check("identical coverage to what's already stored -> skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3274, teams_reported: 30 };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3274, teamsReported: 30 }), true);
});
check("teams_reported advanced (28 -> 30, more teams reported since last build) -> do NOT skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3100, teams_reported: 28 };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3274, teamsReported: 30 }), false);
});
check("MNF lands (week_complete flips, teams_reported 30 -> 32) -> do NOT skip, even if row count is identical by coincidence", () => {
  const existing = { data_max_week: 3, data_row_count: 3274, teams_reported: 30 };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3274, teamsReported: 32 }), false);
});
check("never built before (no existing meta row) -> do NOT skip", () => {
  assert.strictEqual(shouldSkipRebuild(null, { covWeek: 3, covRows: 3274, teamsReported: 30 }), false);
});
check("stored teams_reported is NULL (pre-migration row) and current is a real number -> do NOT skip (never treat unknown as matching)", () => {
  const existing = { data_max_week: 3, data_row_count: 3274, teams_reported: null };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3274, teamsReported: 30 }), false);
});
check("week advanced (3 -> 4) even with the same row count by coincidence -> do NOT skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3274, teams_reported: 32 };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 4, covRows: 3274, teamsReported: 5 }), false);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
