// Replaces the stale, hand-maintained DEAD_COLS "broken columns" literal
// (last audited 2026-08-05, empty ever since -- which is exactly how PFR
// season advanced stats, FTN charting and route/split feeds went unflagged
// all season) with a payload-derived availability check.
//   node tests/stats_workbench_dead_column_audit.test.mjs
//
// Extracts computeColumnAvailability / deadReason / getVal straight out of
// stats_workbench.html and evaluates them with `new Function` (this repo's
// existing convention for testing logic embedded in a giant page script --
// see tests/leaderboard_current_season_precompute.test.mjs for the worker-
// side equivalent), so this is the REAL implementation, not a re-write of it.
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("0. DEAD_COLS is gone -- the hand-maintained list this replaces");
check("no DEAD_COLS literal remains (only the explanatory comment may mention it)", () => {
  assert.ok(!/\bvar DEAD_COLS\s*=/.test(SRC), "a live DEAD_COLS declaration means the old static list is still in play");
});
check("DEAD_COLS_BY_TAB (structural, not a freshness fact) is untouched", () => {
  assert.match(SRC, /var DEAD_COLS_BY_TAB\s*=\s*\{/, "position-structural na (kicker/punter, etc.) should be kept, not replaced");
});

function extractFn(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found");
  let depth = 0, i = SRC.indexOf("{", start);
  const bodyStart = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

console.log("\nanchors hold (else everything below is vacuous)");
let availabilityFn, deadReasonFn, getValSrc;
check("computeColumnAvailability extracts", () => {
  availabilityFn = extractFn("computeColumnAvailability");
  assert.ok(availabilityFn.length > 100);
});
check("deadReason extracts", () => {
  deadReasonFn = extractFn("deadReason");
  assert.ok(deadReasonFn.length > 100);
});
check("getVal extracts (deadReason's data source)", () => {
  getValSrc = extractFn("getVal");
  assert.ok(getValSrc.length > 20);
});

// Minimal harness: COLS with a couple of plain fields + one `compute` column
// (mirrors the real manifest's shape), DEAD_COLS_BY_TAB with one structural
// entry, and a `state` object deadReason reads for the early-season wording.
// SOURCE_COLS/COL_SOURCE/SOURCE_LABELS/MIN_GAMES_REQUIRED/sourceFreshnessFor
// (added 2026-09-29, see tests/stats_workbench_source_freshness.test.mjs for
// their own dedicated coverage) are real deadReason dependencies now, so
// they're included here too -- empty, since none of THIS file's fixture
// columns are source-tracked or sample-gated; that combination is exercised
// in the dedicated test instead of duplicated here.
const harness = `
  var COLS = {
    always_present: {},
    never_present: {},
    computed_ratio: { compute: function(r){ return r.num != null && r.den ? r.num / r.den : null; } },
    structural_na: {},
  };
  var DEAD_COLS_BY_TAB = { structural_na: ["kicker"] };
  var COVERAGE_MIN_SAMPLE = 10;
  var COVERAGE_EARLY_SEASON_WEEKS = 3;
  var SOURCE_COLS = {};
  var COL_SOURCE = {};
  var SOURCE_LABELS = {};
  var MIN_GAMES_REQUIRED = {};
  var state = { lastBuiltForWeek: null, sourceFreshness: null };
  function srcRelTime(){ return ""; }
  function sourceFreshnessFor(){ return { state: "unknown" }; }
  ${getValSrc}
  ${availabilityFn}
  ${deadReasonFn}
  this.computeColumnAvailability = computeColumnAvailability;
  this.deadReason = deadReason;
  this.setBuiltWeek = function(w){ state.lastBuiltForWeek = w; };
`;
const ctx = {};
new Function(harness).call(ctx);

function rowsOf(n, field, valueFn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ [field]: valueFn(i) });
  return out;
}

console.log("\n1. structural (position-doesn't-do-this) still wins, unconditionally");
check("a DEAD_COLS_BY_TAB entry returns 'na' even with zero rows to sample", () => {
  const r = ctx.deadReason("structural_na", "kicker", {});
  assert.strictEqual(r && r.kind, "na");
});
check("the same column is NOT na on a tab it isn't listed for", () => {
  const r = ctx.deadReason("structural_na", "qb", { structural_na: { total: 20, nonNull: 0 } });
  assert.strictEqual(r && r.kind, "broken", "off its excluded tab, a genuinely empty column must still be caught");
});

console.log("\n2. computed availability: exactly-zero over a real sample is 'broken'");
check("a column with a real value on every row -> not flagged", () => {
  const rows = rowsOf(20, "always_present", () => 5);
  const avail = ctx.computeColumnAvailability(rows, ["always_present"]);
  assert.strictEqual(ctx.deadReason("always_present", "qb", avail), null);
});
check("a column null on every row, sample >= MIN -> flagged broken", () => {
  const rows = rowsOf(20, "never_present", () => null);
  const avail = ctx.computeColumnAvailability(rows, ["never_present"]);
  const r = ctx.deadReason("never_present", "qb", avail);
  assert.strictEqual(r && r.kind, "broken");
});
check("a `compute`-derived column is evaluated via getVal, not read as a raw field", () => {
  const rows = rowsOf(20, "num", (i) => i); // den is undefined -> compute() returns null for every row
  const avail = ctx.computeColumnAvailability(rows, ["computed_ratio"]);
  assert.strictEqual(avail.computed_ratio.nonNull, 0, "compute() must actually run, not fall through to row.computed_ratio (undefined key)");
});

console.log("\n3. legitimate sparse stats are NOT the same claim as 'broken'");
check("a column with even ONE real value among many is never flagged, however rare", () => {
  const rows = rowsOf(50, "never_present", (i) => (i === 49 ? 62 : null)); // 1 of 50 -- a real rare event
  const avail = ctx.computeColumnAvailability(rows, ["never_present"]);
  assert.strictEqual(ctx.deadReason("never_present", "qb", avail), null,
    "one real hit in 50 rows means the source is alive -- a threshold-based check would still flag this as 'mostly empty', which is the wrong claim");
});
check("a thin sample proves nothing either way -- stays silent below COVERAGE_MIN_SAMPLE", () => {
  const rows = rowsOf(3, "never_present", () => null);
  const avail = ctx.computeColumnAvailability(rows, ["never_present"]);
  assert.strictEqual(ctx.deadReason("never_present", "qb", avail), null,
    "3 rows cannot distinguish 'hasn't happened yet' from 'broken' -- must not guess");
});

console.log("\n4. provisional/early-season weeks get honest wording, not silence and not false confidence");
check("early season (built week 1, below the threshold) -> softer 'may simply be early' wording", () => {
  ctx.setBuiltWeek(1);
  const rows = rowsOf(20, "never_present", () => null);
  const avail = ctx.computeColumnAvailability(rows, ["never_present"]);
  const r = ctx.deadReason("never_present", "qb", avail);
  assert.strictEqual(r.kind, "broken", "still surfaced -- a real bug in week 1 deserves to be caught too, not hidden");
  assert.match(r.why, /may simply be early/i);
});
check("later in the season (built week 5) -> the stronger 'check whether the source has published it' wording", () => {
  ctx.setBuiltWeek(5);
  const rows = rowsOf(20, "never_present", () => null);
  const avail = ctx.computeColumnAvailability(rows, ["never_present"]);
  const r = ctx.deadReason("never_present", "qb", avail);
  assert.match(r.why, /source has published it/i);
  assert.ok(!/may simply be early/i.test(r.why));
});

console.log("\n5. wording precision (Keith 2026-09-29): a data-availability signal, never a claim the stat is obsolete");
check("neither the early-season nor the later-season message claims the statistic itself is invalid/obsolete/dead", () => {
  ctx.setBuiltWeek(1);
  const early = ctx.deadReason("never_present", "qb", ctx.computeColumnAvailability(rowsOf(20, "never_present", () => null), ["never_present"]));
  ctx.setBuiltWeek(5);
  const later = ctx.deadReason("never_present", "qb", ctx.computeColumnAvailability(rowsOf(20, "never_present", () => null), ["never_present"]));
  for (const r of [early, later]) {
    assert.ok(!/obsolete|invalid|discontinued|retired|removed/i.test(r.why),
      `wording must describe data availability, not the statistic's validity -- got: "${r.why}"`);
  }
});
check("the SOURCE FILE'S own header comment states the data-availability framing explicitly", () => {
  assert.match(SRC, /a column that reads all-zero or\s*\n?\s*\/\/\s*all-null in the current view is a DATA-AVAILABILITY signal/,
    "the design comment above computeColumnAvailability should say this in so many words, not leave it implicit");
  assert.match(SRC, /never proof that the statistic itself is obsolete/i);
});
check("the top-of-page banner states the same framing to the USER, not just in a code comment", () => {
  assert.match(SRC, /This is a data-availability signal, not proof the statistic is obsolete/);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
