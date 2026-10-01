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
import { computeWeekComplete, computeFinalizedThroughWeek, shouldSkipRebuild, MFL_SCORES_FINGERPRINT_SQL, mflScoresFingerprint } from "../worker/src/leaderboard_coverage.js";

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
const FP = "v1:3632:3632:3:123456:987654321";
check("identical coverage AND identical MFL scores to what's already stored -> skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3274, teams_reported: 30, mfl_scores_fingerprint: FP };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3274, teamsReported: 30, mflFingerprint: FP }), true);
});
check("THE 2026-10-01 CASE: same week / rows / teams, MFL scores changed (a Wk 3 correction) -> do NOT skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3376, teams_reported: 32, mfl_scores_fingerprint: FP };
  const corrected = "v1:3632:3632:3:123451:987650000";
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3376, teamsReported: 32, mflFingerprint: corrected }), false);
});
check("stored fingerprint NULL (a row from before migration 0165, or a build mid-write) -> do NOT skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3376, teams_reported: 32, mfl_scores_fingerprint: null };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3376, teamsReported: 32, mflFingerprint: FP }), false);
});
check("stored row has no fingerprint column at all (0165 not applied) -> do NOT skip", () => {
  const existing = { data_max_week: 3, data_row_count: 3376, teams_reported: 32 };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3376, teamsReported: 32, mflFingerprint: FP }), false);
});
check("current fingerprint unknown (its read failed) -> do NOT skip, never 'assume unchanged'", () => {
  const existing = { data_max_week: 3, data_row_count: 3376, teams_reported: 32, mfl_scores_fingerprint: FP };
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3376, teamsReported: 32, mflFingerprint: null }), false);
  assert.strictEqual(shouldSkipRebuild(existing, { covWeek: 3, covRows: 3376, teamsReported: 32 }), false);
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

// The fingerprint itself, on REAL SQLite with src_weekly's real schema
// (migration 0002) — a skip rule is only as good as the value it compares.
console.log("\nMFL_SCORES_FINGERPRINT_SQL / mflScoresFingerprint (real SQLite)");
{
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const mig = fs.readFileSync("worker/migrations/0002_mfl_source_tables.sql", "utf8");
  const ddl = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS src_weekly"), mig.indexOf("CREATE TABLE IF NOT EXISTS src_draft_picks"));
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  // Real 2026 rows (MFL league 74598, captured 2026-10-01): Fred Warner (13743),
  // Darren Waller (12263), Andy Dalton (10313, a -2.0 week), Tyler Higbee
  // (12678, a 0.0 week), and a rostered player MFL posted nothing for (NULL).
  const rows = [
    [1, "13743", 11.5], [2, "13743", 7.0], [3, "13743", 14.0],
    [1, "12263", 6.2], [2, "12263", 20.4], [3, "12263", 13.2],
    [3, "10313", -2.0], [1, "12678", 2.2], [2, "12678", 0.0], [3, "12678", 25.4],
    [3, "14057", null], [18, "13743", 9.0],
  ];
  const ins = db.prepare("INSERT INTO src_weekly (season, week, player_id, score) VALUES (2026, ?, ?, ?)");
  for (const r of rows) ins.run(...r);
  const fp = () => mflScoresFingerprint(db.prepare(MFL_SCORES_FINGERPRINT_SQL).get(2026));
  const base = fp();
  check("a well-formed, versioned fingerprint for the season", () => {
    assert.match(base, /^v1:\d+:\d+:\d+:-?\d+:-?\d+$/);
    assert.strictEqual(base.split(":")[1], "11", "rows counted inside the week<=17 window only");
    assert.strictEqual(base.split(":")[2], "10", "the NULL-score row is not a scored row");
  });
  check("recomputed with nothing changed -> identical (so an unchanged board still skips)", () => {
    assert.strictEqual(fp(), base);
  });
  check("SCORING CORRECTION: Warner Wk 3 14.0 -> 13.5 (the real 2026-10-01 Elias change) -> different, same row count and week", () => {
    db.prepare("UPDATE src_weekly SET score = 13.5 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
    const after = fp();
    assert.notStrictEqual(after, base);
    assert.deepStrictEqual(after.split(":").slice(1, 4), base.split(":").slice(1, 4), "rows / scored / max_week unchanged — only the scores moved");
    db.prepare("UPDATE src_weekly SET score = 14.0 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
    assert.strictEqual(fp(), base, "reverting restores the original value");
  });
  check("two corrections that CANCEL in the plain sum (+0.5 / -0.5) still change it", () => {
    db.prepare("UPDATE src_weekly SET score = score + 0.5 WHERE season = 2026 AND week = 2 AND player_id = '12263'").run();
    db.prepare("UPDATE src_weekly SET score = score - 0.5 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
    const after = fp();
    assert.strictEqual(after.split(":")[4], base.split(":")[4], "plain point sum is unchanged");
    assert.notStrictEqual(after, base, "the weighted term catches it");
    db.prepare("UPDATE src_weekly SET score = score - 0.5 WHERE season = 2026 AND week = 2 AND player_id = '12263'").run();
    db.prepare("UPDATE src_weekly SET score = score + 0.5 WHERE season = 2026 AND week = 3 AND player_id = '13743'").run();
    assert.strictEqual(fp(), base);
  });
  check("a score blanked to NULL, or a negative week corrected, changes it", () => {
    db.prepare("UPDATE src_weekly SET score = NULL WHERE season = 2026 AND week = 2 AND player_id = '12678'").run();
    assert.notStrictEqual(fp(), base, "0.0 -> NULL");
    db.prepare("UPDATE src_weekly SET score = 0.0 WHERE season = 2026 AND week = 2 AND player_id = '12678'").run();
    db.prepare("UPDATE src_weekly SET score = -1.0 WHERE season = 2026 AND week = 3 AND player_id = '10313'").run();
    assert.notStrictEqual(fp(), base, "-2.0 -> -1.0");
    db.prepare("UPDATE src_weekly SET score = -2.0 WHERE season = 2026 AND week = 3 AND player_id = '10313'").run();
    assert.strictEqual(fp(), base);
  });
  check("the 2026-10-01 restore shape (free-agent rows ADDED to a clobbered table) changes it", () => {
    db.prepare("INSERT INTO src_weekly (season, week, player_id, score) VALUES (2026, 3, '14717', 13.0)").run();
    assert.notStrictEqual(fp(), base);
    db.prepare("DELETE FROM src_weekly WHERE season = 2026 AND week = 3 AND player_id = '14717'").run();
    assert.strictEqual(fp(), base);
  });
  check("a week-18 (playoff) change does NOT — the stored board is weeks 1-17 only", () => {
    db.prepare("UPDATE src_weekly SET score = 30.0 WHERE season = 2026 AND week = 18").run();
    assert.strictEqual(fp(), base);
  });
  check("an empty season is a real, known value; a failed read is null (unknown)", () => {
    assert.strictEqual(mflScoresFingerprint(db.prepare(MFL_SCORES_FINGERPRINT_SQL).get(2031)), "v1:0:0:0:0:0");
    assert.strictEqual(mflScoresFingerprint(null), null);
    assert.strictEqual(mflScoresFingerprint({ rows_n: "x" }), null);
  });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
