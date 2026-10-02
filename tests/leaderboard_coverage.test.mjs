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
import { computeWeekComplete, computeFinalizedThroughWeek, shouldSkipRebuild, computeMflScoresFingerprint } from "../worker/src/leaderboard_coverage.js";

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
// (migration 0002), through a D1-shaped adapter — a skip rule is only as good
// as the value it compares.
console.log("\ncomputeMflScoresFingerprint (real SQLite, exact SHA-256 content fingerprint)");
{
  const { DatabaseSync } = await import("node:sqlite");
  const fs = await import("node:fs");
  const mig = fs.readFileSync("worker/migrations/0002_mfl_source_tables.sql", "utf8");
  const ddl = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS src_weekly"), mig.indexOf("CREATE TABLE IF NOT EXISTS src_draft_picks"));
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  const d1 = { prepare: (sql) => ({ bind: (...a) => ({ all: async () => ({ results: db.prepare(sql).all(...a) }) }) }) };
  const checkA = async (n, fn) => { try { await fn(); console.log("  ok   " + n); }
    catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };
  // Real 2026 rows (MFL league 74598, captured 2026-10-01): Fred Warner (13743),
  // Darren Waller (12263), Andy Dalton (10313, a -2.0 week), Tyler Higbee
  // (12678, a 0.0 week), a rostered player MFL posted nothing for (NULL), a
  // week-18 row outside the board's window, and pid 3770 — 13743 - 9973, the
  // pair that shares a weight in the old v1 sums.
  const rows = [
    [1, "13743", 11.5], [2, "13743", 7.0], [3, "13743", 14.0],
    [1, "12263", 6.2], [2, "12263", 20.4], [3, "12263", 13.2],
    [3, "10313", -2.0], [1, "12678", 2.2], [2, "12678", 0.0], [3, "12678", 25.4],
    [3, "14057", null], [3, "3770", 8.0], [18, "13743", 9.0],
  ];
  const ins = db.prepare("INSERT INTO src_weekly (season, week, player_id, score) VALUES (2026, ?, ?, ?)");
  for (const r of rows) ins.run(...r);
  const set = (wk, pid, score) => db.prepare("UPDATE src_weekly SET score = ? WHERE season = 2026 AND week = ? AND player_id = ?").run(score, wk, pid);
  const fp = () => computeMflScoresFingerprint(d1, 2026);
  // The v1 draft of this fix (two integer sums), kept HERE only as the
  // reference that proves the collisions below are real.
  const v1 = () => db.prepare(`SELECT COUNT(*) AS n, SUM(score IS NOT NULL) AS s, MAX(week) AS w,
      SUM(CAST(ROUND(COALESCE(score,0)*10) AS INTEGER)) AS p,
      SUM(CAST(ROUND(COALESCE(score,0)*10) AS INTEGER) * ((CAST(player_id AS INTEGER) % 9973) + 1) * (week + 1)) AS x
      FROM src_weekly WHERE season = 2026 AND week <= 17`).get();
  const base = await fp();
  const baseV1 = JSON.stringify(v1());

  await checkA("a well-formed fingerprint: version, row count in the week<=17 window, SHA-256", async () => {
    assert.match(base, /^v2:12:[0-9a-f]{64}$/);
  });
  await checkA("recomputed with nothing changed -> identical (so an unchanged board still skips)", async () => {
    assert.strictEqual(await fp(), base);
  });
  await checkA("SCORING CORRECTION: Warner Wk 3 14.0 -> 13.5 (the real 2026-10-01 Elias change) -> different", async () => {
    set(3, "13743", 13.5);
    assert.notStrictEqual(await fp(), base);
    set(3, "13743", 14.0);
    assert.strictEqual(await fp(), base, "reverting restores the original value");
  });
  await checkA("MULTIPLE OFFSETTING CORRECTIONS that the old sums could not see (equal-weight pair) -> different", async () => {
    // 13743 and 3770 carry the same v1 weight in the same week: +0.5 / -0.5
    // leaves both v1 sums exactly where they were.
    set(3, "13743", 14.5); set(3, "3770", 7.5);
    assert.strictEqual(JSON.stringify(v1()), baseV1, "the v1 sums really are unchanged (the collision is real)");
    assert.notStrictEqual(await fp(), base, "the content fingerprint is not fooled");
    set(3, "13743", 14.0); set(3, "3770", 8.0);
    assert.strictEqual(await fp(), base);
  });
  await checkA("MULTIPLE OFFSETTING CORRECTIONS across three players and weeks (a(b-c), b(c-a), c(a-b)) -> different", async () => {
    // v1 weights w = (pid % 9973 + 1) * (week + 1); deltas in tenths chosen so
    // both v1 sums cancel: sum(d) = 0 and sum(d * w) = 0.
    const W = (pid, wk) => ((Number(pid) % 9973) + 1) * (wk + 1);
    const a = W("13743", 1), b = W("12263", 2), c = W("12678", 3);
    const g = (x, y) => (y ? g(y, x % y) : Math.abs(x));
    const k = g(g(b - c, c - a), a - b);
    const d = [(b - c) / k, (c - a) / k, (a - b) / k];       // smallest integer solution, in tenths
    const before = { w1: 11.5, w2: 20.4, w3: 25.4 };
    set(1, "13743", Math.round((before.w1 * 10 + d[0])) / 10);
    set(2, "12263", Math.round((before.w2 * 10 + d[1])) / 10);
    set(3, "12678", Math.round((before.w3 * 10 + d[2])) / 10);
    assert.strictEqual(JSON.stringify(v1()), baseV1, "the v1 sums really are unchanged (the collision is real)");
    assert.notStrictEqual(await fp(), base, "the content fingerprint is not fooled");
    set(1, "13743", before.w1); set(2, "12263", before.w2); set(3, "12678", before.w3);
    assert.strictEqual(await fp(), base);
  });
  await checkA("a swap of two players' scores in one week -> different", async () => {
    set(1, "13743", 6.2); set(1, "12263", 11.5);
    assert.notStrictEqual(await fp(), base);
    set(1, "13743", 11.5); set(1, "12263", 6.2);
    assert.strictEqual(await fp(), base);
  });
  await checkA("a score blanked to NULL, a 0.0 week, and a negative week each count as content", async () => {
    set(2, "12678", null);
    assert.notStrictEqual(await fp(), base, "0.0 -> NULL");
    set(2, "12678", 0.0);
    set(3, "10313", -1.0);
    assert.notStrictEqual(await fp(), base, "-2.0 -> -1.0");
    set(3, "10313", -2.0);
    assert.strictEqual(await fp(), base);
  });
  await checkA("the 2026-10-01 restore shape (free-agent rows ADDED to a clobbered table) -> different", async () => {
    ins.run(3, "14717", 13.0);
    assert.notStrictEqual(await fp(), base);
    db.prepare("DELETE FROM src_weekly WHERE season = 2026 AND week = 3 AND player_id = '14717'").run();
    assert.strictEqual(await fp(), base);
  });
  await checkA("a week-18 (playoff) change does NOT — the stored board is weeks 1-17 only", async () => {
    set(18, "13743", 30.0);
    assert.strictEqual(await fp(), base);
  });
  await checkA("an empty season is a real, known value; a failed read is null (unknown)", async () => {
    assert.match(await computeMflScoresFingerprint(d1, 2031), /^v2:0:[0-9a-f]{64}$/);
    const broken = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1_ERROR"); } }) }) };
    assert.strictEqual(await computeMflScoresFingerprint(broken, 2026), null);
    const odd = { prepare: (sql) => ({ bind: () => ({ all: async () => (/DISTINCT/.test(sql) ? { results: [{ week: 1 }] } : {}) }) }) };
    assert.strictEqual(await computeMflScoresFingerprint(odd, 2026), null, "a malformed result is unknown, not empty");
  });
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
