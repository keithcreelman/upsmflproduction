// Found investigating a Stats Workbench report that "L4W Δ" shows "No data
// reported" for every QB (2026-09-29). Two distinct findings:
//
// 1. MISCLASSIFICATION (frontend): l4w_delta's own compute() requires
//    c.weeks.length >= 5 before returning a value -- with 4 or fewer total
//    weeks, "last 4 weeks" IS the whole season, so the delta against season
//    PPG would be trivially 0, not a real signal. That gate is correctly
//    designed but was reported as a generic "DATA UNAVAILABLE" (implying a
//    pipeline problem) instead of what it actually is: an INSUFFICIENT
//    SAMPLE, exactly like Script Δ (see #1150). Fixed by adding it to the
//    same MIN_GAMES_REQUIRED map #1150 shipped -- extends that mechanism,
//    does not modify #1150's own code or tests.
//
// 2. REAL DEFECT (worker), found while tracing WHY c.weeks.length was even
//    lower than expected: /api/player-consistency filtered `sw.score > 0`,
//    the exact same conflation #1141 already fixed once in the leaderboard's
//    PPG denominator -- a real, played, scored game at exactly 0 or a
//    negative net was silently dropped. Verified live: Kyler Murray (2026)
//    has a real -0.2 week (the SAME fixture #1141 used) that this query
//    dropped entirely -- gp:1, weeks:[12], ppg:12 instead of the correct
//    gp:2, weeks:[-0.2,12], ppg:5.9 (matching #1141's corrected PPG for the
//    same player exactly). This affects every consumer of the endpoint:
//    Floor, Ceil, Consistency, Boom%, Bust%, the Trend sparkline, and the
//    game count L4W Δ's own gate reads.
//   node tests/player_consistency_score_filter_and_l4w_delta.test.mjs
import fs from "fs";
import assert from "assert";

const WORKER_SRC = fs.readFileSync("worker/src/index.js", "utf8");
const SITE_SRC = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

const rStart = WORKER_SRC.indexOf('if (path === "/api/player-consistency"');
const rEnd = WORKER_SRC.indexOf('if (path === "/api/player-epa"', rStart);
const route = rStart > 0 && rEnd > rStart ? WORKER_SRC.slice(rStart, rEnd) : "";

console.log("anchors hold (else everything below is vacuous)");
check("route slice is substantial", () => {
  assert.ok(route.length > 800, `slice is ${route.length} chars`);
});

console.log("\n1. /api/player-consistency counts a real scored game (incl. 0/negative), not just positive ones");
check("the query now tests sw.score IS NOT NULL, not sw.score > 0", () => {
  assert.match(route, /AND sw\.score IS NOT NULL AND f\.gsis_id IS NOT NULL/);
  assert.ok(!/AND sw\.score > 0 AND f\.gsis_id IS NOT NULL/.test(route),
    "the old value-testing predicate must be gone, not just supplemented");
});

console.log("\n2. truth-table over the intended semantics (mirrors #1141's own fixture)");
// Mirrors the route's own aggregation: only rows with a non-null score
// reach `scores`; a missing src_weekly row (bye) never reaches the query at
// all, so it needs no separate handling here.
function computeConsistency(scores) {
  const n = scores.length;
  if (!n) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  let mn = scores[0], mx = scores[0];
  for (const v of scores) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return { gp: n, ppg: Math.round(mean * 10) / 10, floor: Math.round(mn * 10) / 10, ceil: Math.round(mx * 10) / 10 };
}
check("a zero-score week counts as a played, scored game", () => {
  const r = computeConsistency([0, 12]);
  assert.strictEqual(r.gp, 2);
});
check("a negative-score week counts as a played, scored game", () => {
  const r = computeConsistency([-0.2, 12]);
  assert.strictEqual(r.gp, 2);
  assert.strictEqual(r.floor, -0.2, "a real bad week must lower the floor, not be excluded from it");
});
check("live-verified regression: Kyler Murray's real weeks reproduce #1141's corrected PPG exactly", () => {
  // #1141 found Kyler Murray's corrected 2026 season-to-date PPG was 5.9
  // (11.8 total points / 2 real scored games: -0.2 and a ~12-point week).
  // /api/player-consistency, unfixed, instead reported gp:1, weeks:[12],
  // ppg:12 -- the OLD buggy leaderboard value for the same player.
  const r = computeConsistency([-0.2, 12]);
  assert.strictEqual(r.ppg, 5.9);
  assert.notStrictEqual(r.ppg, 12, "12 is the buggy pre-fix value this defect produced live");
});

console.log("\n3. L4W Δ: insufficient-sample, not a data-availability claim");
check("MIN_GAMES_REQUIRED now includes l4w_delta (min 5), added alongside (not replacing) split_script (min 6)", () => {
  const minGamesVar = extractVar("MIN_GAMES_REQUIRED");
  assert.match(minGamesVar, /split_script:\s*\{\s*min:\s*6/);
  assert.match(minGamesVar, /l4w_delta:\s*\{\s*min:\s*5/);
});
check("each entry carries its OWN why-description, not a shared/hardcoded one (the actual bug found here)", () => {
  const minGamesVar = extractVar("MIN_GAMES_REQUIRED");
  // l4w_delta's own description must NOT mention Script Δ's game-script
  // language -- that was the exact defect: one hardcoded "why" reused for
  // every entry in this map regardless of which column it described.
  const l4wEntry = /l4w_delta:\s*\{[^}]*\}/.exec(minGamesVar);
  assert.ok(l4wEntry, "l4w_delta entry not found in MIN_GAMES_REQUIRED");
  assert.ok(!/trailing by 7\+/.test(l4wEntry[0]),
    "l4w_delta's own why-text must not describe Script Δ's trailing/leading requirement");
  assert.match(l4wEntry[0], /5 weeks played/i);
});
check("l4w_delta's own compute() still requires >= 5 weeks (the fix doesn't touch the formula itself)", () => {
  assert.match(SITE_SRC, /l4w_delta:\s*\{[^]*?c\.weeks\.length < 5/,
    "the underlying 5-week gate in the column's own compute() must be untouched -- only its LABEL changes");
});

function extractFn(name) {
  const start = SITE_SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found");
  let depth = 0, i = SITE_SRC.indexOf("{", start);
  for (; i < SITE_SRC.length; i++) {
    if (SITE_SRC[i] === "{") depth++;
    else if (SITE_SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  return SITE_SRC.slice(start, i + 1);
}
function extractVar(name) {
  const re = new RegExp("var " + name + "\\s*=");
  const m = re.exec(SITE_SRC);
  if (!m) throw new Error(name + " not found");
  let i = m.index + m[0].length;
  while (/\s/.test(SITE_SRC[i])) i++;
  if (SITE_SRC[i] === "{") {
    let depth = 0;
    for (; i < SITE_SRC.length; i++) {
      if (SITE_SRC[i] === "{") depth++;
      else if (SITE_SRC[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
  } else {
    i = SITE_SRC.indexOf(";", i) + 1;
  }
  return SITE_SRC.slice(m.index, i);
}

console.log("\n4. deadReason classifies l4w_delta as insufficient_sample today (Week 3), same mechanism as Script Δ");
check("with the real harness: l4w_delta at Week 3 (< 5) is insufficient_sample, not broken", () => {
  const populateLine = /Object\.keys\(SOURCE_COLS\)\.forEach\([^\n]*\);/.exec(SITE_SRC)[0];
  const harness = `
    var COLS = { l4w_delta: {} };
    var DEAD_COLS_BY_TAB = {};
    var COVERAGE_MIN_SAMPLE = 10;
    var COVERAGE_EARLY_SEASON_WEEKS = 3;
    ${extractVar("SOURCE_COLS")}
    ${extractVar("COL_SOURCE")}
    ${populateLine}
    ${extractVar("SOURCE_LABELS")}
    ${extractVar("MIN_GAMES_REQUIRED")}
    var state = { lastBuiltForWeek: 3, sourceFreshness: null };
    function srcRelTime(){ return ""; }
    ${extractFn("sourceFreshnessFor")}
    ${extractFn("getVal")}
    ${extractFn("deadReason")}
    this.deadReason = deadReason;
  `;
  const ctx = {};
  new Function(harness).call(ctx);
  const r = ctx.deadReason("l4w_delta", "qb", { l4w_delta: { total: 49, nonNull: 0 } });
  assert.strictEqual(r.kind, "insufficient_sample");
  assert.match(r.why, /5/);
});

console.log("\n5. banner grouping bug (found by adding a SECOND insufficient-sample column, 2026-09-29)");
check("with BOTH Script Δ and L4W Δ flagged, the banner cites each column's OWN reason, not the first one's for both", () => {
  // Only reachable once two insufficient-sample columns with DIFFERENT
  // thresholds coexist -- exactly what this PR introduces. #1150 shipped
  // this bucket with only Script Δ ever able to occupy it, so the bug
  // (reusing thin[0]'s reason for the whole bucket) was invisible until now.
  const populateLine = /Object\.keys\(SOURCE_COLS\)\.forEach\([^\n]*\);/.exec(SITE_SRC)[0];
  const els = {};
  const doc = { getElementById(id) { if (!els[id]) els[id] = { innerHTML: "" }; return els[id]; } };
  const harness = `
    var COLS = { l4w_delta: { label: "L4W Δ" }, split_script: { label: "Script Δ" } };
    var DEAD_COLS_BY_TAB = {};
    var COVERAGE_MIN_SAMPLE = 10;
    var COVERAGE_EARLY_SEASON_WEEKS = 3;
    ${extractVar("SOURCE_COLS")}
    ${extractVar("COL_SOURCE")}
    ${populateLine}
    ${extractVar("SOURCE_LABELS")}
    ${extractVar("MIN_GAMES_REQUIRED")}
    var state = { lastBuiltForWeek: 3, sourceFreshness: null, activeTab: "qb" };
    function srcRelTime(){ return ""; }
    function escapeHtml(s){ return String(s); }
    ${extractFn("sourceFreshnessFor")}
    ${extractFn("getVal")}
    ${extractFn("deadReason")}
    ${extractFn("renderDataNote")}
    this.renderDataNote = renderDataNote;
  `;
  const ctx = {};
  new Function("document", harness).call(ctx, doc);
  const avail = { l4w_delta: { total: 49, nonNull: 0 }, split_script: { total: 49, nonNull: 0 } };
  ctx.renderDataNote(["l4w_delta", "split_script"], 49, avail);
  const html = els["asw-datanote-slot"].innerHTML;
  assert.ok(!/trailing by 7\+ AND[^<]*5 total/.test(html),
    "L4W Δ must never be described with Script Δ's trailing/leading wording");
  assert.match(html, /see each column's tooltip/i,
    "two DIFFERENT reasons in one bucket must defer to each column's own tooltip, not print one reason for both");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
