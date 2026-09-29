// Source-specific freshness for FTN charting / game-script splits (2026-09-29):
// these are separate ETL jobs from the core box-score pipeline (nflverse_weekly),
// each with its own etl_runs row and no week-level granularity of their own
// (both tables store one SEASON-TO-DATE rollup per player -- confirmed against
// the live D1 schema). The box-score freshness line above the table must never
// be read as certifying these two.
//
// Also covers the INSUFFICIENT-SAMPLE distinction: Script Δ needs >=3 games
// trailing by 7+ AND >=3 leading by 7+ (6 total) -- a mathematical floor,
// independent of whether the source itself is healthy. A perfectly healthy
// splits pipeline three weeks into the season is EXPECTED to show nothing for
// this column; that must never be worded like a data-availability problem.
//   node tests/stats_workbench_source_freshness.test.mjs
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

function extractFn(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found");
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}
function extractVar(name) {
  const re = new RegExp("var " + name + "\\s*=");
  const m = re.exec(SRC);
  if (!m) throw new Error(name + " not found");
  let i = m.index + m[0].length;
  while (/\s/.test(SRC[i])) i++;
  if (SRC[i] === "{") {
    let depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === "{") depth++;
      else if (SRC[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
  } else {
    i = SRC.indexOf(";", i) + 1;
  }
  return SRC.slice(m.index, i);
}

console.log("anchors hold (else everything below is vacuous)");
let srcFreshFn, deadReasonFn, colSourceVar, sourceLabelsVar, minGamesVar, getValSrc, srcRelTimeFn, renderNoteFn;
check("sourceFreshnessFor extracts", () => { srcFreshFn = extractFn("sourceFreshnessFor"); assert.ok(srcFreshFn.length > 100); });
check("deadReason extracts", () => { deadReasonFn = extractFn("deadReason"); assert.ok(deadReasonFn.length > 100); });
check("COL_SOURCE / SOURCE_LABELS / MIN_GAMES_REQUIRED extract", () => {
  const populateLine = /Object\.keys\(SOURCE_COLS\)\.forEach\([^\n]*\);/.exec(SRC);
  if (!populateLine) throw new Error("COL_SOURCE population statement not found");
  colSourceVar = extractVar("SOURCE_COLS") + "\n" + extractVar("COL_SOURCE") + "\n" + populateLine[0];
  sourceLabelsVar = extractVar("SOURCE_LABELS");
  minGamesVar = extractVar("MIN_GAMES_REQUIRED");
  assert.ok(colSourceVar.length > 20 && sourceLabelsVar.length > 10 && minGamesVar.length > 10);
});
check("getVal / srcRelTime extract", () => {
  getValSrc = extractFn("getVal");
  srcRelTimeFn = extractFn("srcRelTime");
});
check("renderSourceFreshnessNote extracts", () => { renderNoteFn = extractFn("renderSourceFreshnessNote"); assert.ok(renderNoteFn.length > 200); });

// Minimal DOM stub: only what renderSourceFreshnessNote touches.
function makeDocStub() {
  const els = {};
  return {
    getElementById(id) {
      if (!els[id]) els[id] = { innerHTML: "" };
      return els[id];
    },
    _els: els,
  };
}
function harness(fixtures) {
  const doc = makeDocStub();
  const src = `
    var COLS = { ftn_pa: {label:"PA%"}, ftn_screen:{label:"Scrn%"}, ftn_blitz:{label:"Blitz%"}, split_script:{label:"Script Δ"} };
    ${colSourceVar}
    ${sourceLabelsVar}
    ${minGamesVar}
    var COVERAGE_MIN_SAMPLE = 10;
    var COVERAGE_EARLY_SEASON_WEEKS = 3;
    var DEAD_COLS_BY_TAB = {};
    var state = ${JSON.stringify(fixtures.state || {})};
    ${srcRelTimeFn}
    ${srcFreshFn}
    ${getValSrc}
    function escapeHtml(s){ return String(s); }
    ${deadReasonFn}
    ${renderNoteFn}
    this.sourceFreshnessFor = sourceFreshnessFor;
    this.deadReason = deadReason;
    this.renderSourceFreshnessNote = renderSourceFreshnessNote;
    this.document = arguments[0];
  `;
  const fn = new Function("document", src);
  const ctx = {};
  fn.call(ctx, doc);
  return { ctx, doc };
}

console.log("\n1. sourceFreshnessFor: current / stale / failed / unavailable / never_run");
check("status ok, ran AFTER the box-score refresh -> current, cites the box-score week", () => {
  const { ctx } = harness({ state: {
    sourceFreshness: { etl: [
      { source: "nflverse_ftn", status: "ok", last_run_utc: "2026-09-29T18:00:00Z" },
      { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T17:55:00Z" },
    ], weeklyCoverage: { season: 2026, week: 3 } } } });
  const r = ctx.sourceFreshnessFor("nflverse_ftn");
  assert.strictEqual(r.state, "current");
  assert.strictEqual(r.through_week, 3);
});
check("status ok, ran BEFORE the box-score refresh -> stale, does NOT claim a through_week", () => {
  const { ctx } = harness({ state: {
    sourceFreshness: { etl: [
      { source: "nflverse_ftn", status: "ok", last_run_utc: "2026-09-29T10:00:00Z" },
      { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T17:55:00Z" },
    ], weeklyCoverage: { season: 2026, week: 3 } } } });
  const r = ctx.sourceFreshnessFor("nflverse_ftn");
  assert.strictEqual(r.state, "stale");
  assert.strictEqual(r.through_week, null, "a stale source must never claim to reflect a specific week");
  assert.strictEqual(r.box_score_week, 3, "still reports the box-score week as context, not as a claim about the source");
});
check("status error -> failed", () => {
  const { ctx } = harness({ state: { sourceFreshness: { etl: [
    { source: "nflverse_splits", status: "error", last_run_utc: "2026-09-29T05:00:00Z", detail: "boom" },
  ] } } });
  const r = ctx.sourceFreshnessFor("nflverse_splits");
  assert.strictEqual(r.state, "failed");
});
check("status not_published -> unavailable", () => {
  const { ctx } = harness({ state: { sourceFreshness: { etl: [
    { source: "nflverse_splits", status: "not_published", last_run_utc: "2026-09-29T05:00:00Z" },
  ] } } });
  assert.strictEqual(ctx.sourceFreshnessFor("nflverse_splits").state, "unavailable");
});
check("no etl_runs row at all -> never_run", () => {
  const { ctx } = harness({ state: { sourceFreshness: { etl: [] } } });
  assert.strictEqual(ctx.sourceFreshnessFor("nflverse_splits").state, "never_run");
});
check("freshness payload not loaded yet -> unknown, never guessed as current", () => {
  const { ctx } = harness({ state: { sourceFreshness: null } });
  assert.strictEqual(ctx.sourceFreshnessFor("nflverse_splits").state, "unknown");
});

console.log("\n2. deadReason: insufficient-sample beats the generic source check, and is worded distinctly");
check("Script Δ before 6 games played -> insufficient_sample, regardless of source health", () => {
  const { ctx } = harness({ state: { lastBuiltForWeek: 3, sourceFreshness: { etl: [
    { source: "nflverse_splits", status: "ok", last_run_utc: "2026-09-29T18:00:00Z" },
    { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T17:55:00Z" },
  ], weeklyCoverage: { week: 3 } } } });
  const r = ctx.deadReason("split_script", "qb", { split_script: { total: 49, nonNull: 0 } });
  assert.strictEqual(r.kind, "insufficient_sample");
  assert.match(r.why, /6 total/);
  assert.match(r.why, /3 week/);
});
check("Script Δ after 6+ games, source healthy, still empty -> generic wording, NOT insufficient-sample, NOT blamed on the source", () => {
  const { ctx } = harness({ state: { lastBuiltForWeek: 8, sourceFreshness: { etl: [
    { source: "nflverse_splits", status: "ok", last_run_utc: "2026-09-29T18:00:00Z" },
    { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T17:55:00Z" },
  ], weeklyCoverage: { week: 8 } } } });
  const r = ctx.deadReason("split_script", "qb", { split_script: { total: 49, nonNull: 0 } });
  assert.strictEqual(r.kind, "broken");
  assert.ok(!/insufficient/i.test(r.why));
});
check("an FTN column, source genuinely FAILED -> broken, cites the failure explicitly (not a generic guess)", () => {
  const { ctx } = harness({ state: { lastBuiltForWeek: 8, sourceFreshness: { etl: [
    { source: "nflverse_ftn", status: "error", last_run_utc: "2026-09-29T05:00:00Z" },
  ] } } });
  const r = ctx.deadReason("ftn_pa", "qb", { ftn_pa: { total: 49, nonNull: 0 } });
  assert.strictEqual(r.kind, "broken");
  assert.match(r.why, /last refresh failed/i);
});
check("an FTN column, source current/healthy but this column still empty -> generic wording, not a false failure claim", () => {
  const { ctx } = harness({ state: { lastBuiltForWeek: 8, sourceFreshness: { etl: [
    { source: "nflverse_ftn", status: "ok", last_run_utc: "2026-09-29T18:00:00Z" },
    { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T17:55:00Z" },
  ] } } });
  const r = ctx.deadReason("ftn_pa", "qb", { ftn_pa: { total: 49, nonNull: 0 } });
  assert.strictEqual(r.kind, "broken");
  assert.ok(!/failed|never successfully/i.test(r.why), "the source IS healthy here -- must not claim otherwise");
});

console.log("\n3. renderSourceFreshnessNote: visible only when a tracked column is on screen, worded per state");
check("no FTN/splits columns visible -> the slot is empty (silent, like renderDataNote)", () => {
  const { ctx, doc } = harness({ state: { sourceFreshness: { etl: [] } } });
  ctx.renderSourceFreshnessNote(["mfl_points", "games"]);
  assert.strictEqual(doc._els["asw-source-freshness-slot"].innerHTML, "");
});
check("current state renders the source label + relative time + week, and the non-certification disclaimer", () => {
  const { ctx, doc } = harness({ state: { sourceFreshness: { etl: [
    { source: "nflverse_ftn", status: "ok", last_run_utc: new Date().toISOString() },
    { source: "nflverse_weekly", status: "ok", last_run_utc: new Date(Date.now() - 60000).toISOString() },
  ], weeklyCoverage: { week: 3 } } } });
  ctx.renderSourceFreshnessNote(["ftn_pa"]);
  const html = doc._els["asw-source-freshness-slot"].innerHTML;
  assert.match(html, /FTN Charting/);
  assert.match(html, /current/);
  assert.match(html, /Week 3/);
  assert.match(html, /does not certify/i);
});
check("stale state warns the value may be behind, without claiming a specific week for the source", () => {
  const { ctx, doc } = harness({ state: { sourceFreshness: { etl: [
    { source: "nflverse_splits", status: "ok", last_run_utc: "2026-09-29T05:00:00Z" },
    { source: "nflverse_weekly", status: "ok", last_run_utc: "2026-09-29T18:00:00Z" },
  ], weeklyCoverage: { week: 3 } } } });
  ctx.renderSourceFreshnessNote(["split_script"]);
  const html = doc._els["asw-source-freshness-slot"].innerHTML;
  assert.match(html, /may be behind/i);
});
check("failed state renders plainly, not silently, and not as if data is current", () => {
  const { ctx, doc } = harness({ state: { sourceFreshness: { etl: [
    { source: "nflverse_ftn", status: "error", last_run_utc: "2026-09-29T05:00:00Z" },
  ] } } });
  ctx.renderSourceFreshnessNote(["ftn_pa"]);
  const html = doc._els["asw-source-freshness-slot"].innerHTML;
  assert.match(html, /FAILED/);
});

console.log("\n4. no additional ETL dispatch was needed -- this reuses the existing /api/data-freshness payload");
check("sourceFreshnessPromise fetches /api/data-freshness, not a new endpoint", () => {
  assert.match(SRC, /fetch\(API_BASE \+ "\/api\/data-freshness"\)/);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
