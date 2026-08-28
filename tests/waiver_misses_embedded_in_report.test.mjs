// Denied claims must be EMBEDDED in the league's one waiver-report thread, not
// posted as a second, separate thread.
//   node tests/waiver_misses_embedded_in_report.test.mjs
//
// buildWaiverReportPlan (waiver_run_post.js) has carried the embedding path
// since it was written: a "Not granted" field, a "N missed" tag per team, and
// buildMissMessage() appended to the SAME thread after granted claims. The
// call site in index.js never fed it `misses` — so the capability existed and
// was silently unused; every denial went out as its own "<day> Misses" thread
// instead. Reversed 2026-08-28 per Keith: fold it into the bottom of the
// report instead of a second post.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// Isolate the report-collapse block (the one that calls buildWaiverReportPlan)
// and the fallback block (the one that calls buildMissReportPlan standalone).
// Asserted non-empty so a drifted anchor fails loudly, not vacuously.
const repStart = SRC.indexOf('if (apShape === "report" && apReportTeams.length) {');
const repEnd = SRC.indexOf('// Fallback standalone miss post', repStart);
const reportBlock = repStart > 0 && repEnd > repStart ? SRC.slice(repStart, repEnd) : '';

const fbStart = SRC.indexOf('// Fallback standalone miss post');
const fbEnd = SRC.indexOf('if (apDryRun) {', fbStart);
const fallbackBlock = fbStart > 0 && fbEnd > fbStart ? SRC.slice(fbStart, fbEnd) : '';

console.log('anchors hold');
check('report-collapse block is locatable and substantial', () => {
  assert.ok(reportBlock.length > 400, `slice is ${reportBlock.length} chars`);
});
check('fallback block is locatable and substantial', () => {
  assert.ok(fallbackBlock.length > 400, `slice is ${fallbackBlock.length} chars`);
});

console.log('\nthe scrape runs BEFORE the report is built, not after');
check('_waiverMissesForRun is called before the report-collapse block starts', () => {
  const scrapeIdx = SRC.indexOf('missRes = await _waiverMissesForRun(');
  assert.ok(scrapeIdx > 0, '_waiverMissesForRun call not found');
  assert.ok(scrapeIdx < repStart,
    'the scrape must complete before buildWaiverReportPlan runs, or there is nothing to embed');
});

console.log('\nthe report embeds misses instead of a second post');
check('buildWaiverReportPlan is called with misses: missRes.misses', () => {
  assert.ok(/buildWaiverReportPlan\(\{[\s\S]{0,1500}?misses:\s*missRes\.misses/.test(reportBlock),
    'the report is built without misses — this is the exact bug being fixed');
});
check('a successful embed sets apMissesEmbedded = true', () => {
  assert.ok(/apMissesEmbedded = true;/.test(reportBlock),
    'without this the fallback block cannot tell embedding succeeded and would double-post');
});
check('only ONE apPlans entry is pushed for a same-day report run', () => {
  const pushes = (reportBlock.match(/apPlans\.push\(/g) || []).length;
  assert.strictEqual(pushes, 1,
    `found ${pushes} apPlans.push() calls in the report-collapse block — misses must ride in the ` +
    'same entry, not a second one');
});

console.log('\nthe fallback never fires when the embed succeeded');
check('the fallback condition excludes the embedded case', () => {
  assert.ok(/apShape === "misses" \|\| \(apShape === "report" && !apMissesEmbedded\)/.test(SRC),
    'without !apMissesEmbedded, a normal single-day report run would ALSO get a duplicate standalone misses post');
});

console.log('\nthe fallback still covers the cases embedding cannot reach');
check('shape:"misses" preview still builds a standalone report', () => {
  assert.ok(/buildMissReportPlan\(\{/.test(fallbackBlock), 'buildMissReportPlan not called in the fallback');
});
check('the fallback runs on the multi-day edge case too, not just shape:"misses"', () => {
  // apMissesEmbedded is declared false and only flips true inside the
  // single-day branch — the multi-day `else` branch never touches it, so a
  // multi-day report falls through to this block by construction.
  assert.ok(/let apMissesEmbedded = false;/.test(SRC));
});

console.log('\nsilence-is-not-zero survives the restructure');
check('missRes defaults to misses: null (not consulted), not []', () => {
  assert.ok(/let missRes = \{ misses: null, reason: "" \};/.test(SRC),
    'a default of [] would render "Not granted: 0" even for shapes that never scrape, misreporting an unverified state as a verified zero');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
