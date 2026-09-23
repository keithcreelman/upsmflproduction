// 2026-09-23 correction pass: the current-season leaderboard's `stale` flag
// only ever compared the precompute to nfl_player_weekly — both agreed on
// week 1 while the nflverse ETL cron ran late, so `stale:false` was reported
// a real week behind. This adds an AUTHORITATIVE check against the same
// resolver /api/current-lineup-week already uses (resolveCurrentLineupWeek),
// via a new pure helper (deriveCompletedWeekFromLineupResolution) that is
// unit-tested here directly, plus source-slice guards proving the read-path
// wiring fails closed rather than claiming freshness on a maybe.
//   node tests/leaderboard_authoritative_week.test.mjs
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// ── Extract the PURE helper and eval it standalone — real behavioral
// testing of the actual shipped code, not a reimplementation mirror. It has
// no I/O (no fetch/env/db), so this is safe. ──────────────────────────────
const fnStart = SRC.indexOf('function deriveCompletedWeekFromLineupResolution(resolved) {');
const fnEnd = SRC.indexOf('\n}\n', fnStart) + 3;
console.log('anchors hold (else everything below is vacuous)');
check('deriveCompletedWeekFromLineupResolution slice found and substantial', () => {
  assert.ok(fnStart >= 0, 'function not found — anchor drifted');
  assert.ok(fnEnd > fnStart && (fnEnd - fnStart) > 200, `slice is ${fnEnd - fnStart} chars`);
});
const fnSrc = fnStart >= 0 ? SRC.slice(fnStart, fnEnd) : '';
const deriveCompletedWeek = fnSrc
  ? new Function(fnSrc + '\nreturn deriveCompletedWeekFromLineupResolution;')()
  : () => { throw new Error('extraction failed'); };

console.log('\n1. successful/complete resolutions derive week-1');
check('live_scoring_week_complete, week=3 -> completed week 2', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 3, source: 'live_scoring_week_complete' }), 2);
});
check('live_scoring (still in grace period), week=2 -> completed week 1', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 2, source: 'live_scoring' }), 1);
});
check('live_scoring_week_complete, week=1 (boundary: zero completed weeks) -> 0, not null', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 1, source: 'live_scoring_week_complete' }), 0);
});
check('live_scoring, week=1 (preseason/week-1-in-progress boundary) -> 0, not null', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 1, source: 'live_scoring' }), 0);
});

console.log('\n2. low-confidence and unresolved sources fail closed to null, never a guess');
check('projected_scores_fallback is documented as rolling over TOO EARLY -> null, not week-1', () => {
  // This is the exact bug class PR #1050/#1051 fixed elsewhere in this file
  // for projectedScores.week -- trusting it here would silently reintroduce it.
  assert.strictEqual(deriveCompletedWeek({ week: 5, source: 'projected_scores_fallback' }), null);
});
check('unresolved -> null', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 0, source: 'unresolved' }), null);
});
check('null/undefined input -> null (never throws)', () => {
  assert.strictEqual(deriveCompletedWeek(null), null);
  assert.strictEqual(deriveCompletedWeek(undefined), null);
});
check('a non-finite week on an otherwise-trusted source -> null, not NaN/negative', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 'not-a-number', source: 'live_scoring' }), null);
});
check('an unrecognized/typo source string is never trusted', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 4, source: 'live_scoring_complete_typo' }), null);
});

console.log('\n3. preseason boundary (liveScoring not yet meaningful)');
check('week=0 with any source string still resolves to null, never -1', () => {
  assert.strictEqual(deriveCompletedWeek({ week: 0, source: 'live_scoring' }), null);
  assert.strictEqual(deriveCompletedWeek({ week: 0, source: 'live_scoring_week_complete' }), null);
});

// ── Wiring: the read-path calls the resolver and fails closed. Source-slice
// only (this repo's convention for the parts that need a live D1/MFL/HTTP
// harness this test suite does not have) — the DECISION LOGIC itself is
// proven behaviorally above, not by these regexes. ────────────────────────
const gateStart = SRC.indexOf('let lbPreStale = false;');
const gateEnd = SRC.indexOf('// `AND games >= ?` is OMITTED', gateStart);
const gate = gateStart >= 0 && gateEnd > gateStart ? SRC.slice(gateStart, gateEnd) : '';
check('stale-check gate slice found and substantial', () => {
  assert.ok(gate.length > 400, `gate slice is ${gate.length} chars`);
});

console.log('\n4. the authoritative check can only ADD staleness, never clear it');
check('the authoritative check is skipped once the D1 check already found it stale', () => {
  assert.ok(/if \(!lbPreStale\) \{[\s\S]*?resolveAuthoritativeCompletedWeek/.test(gate),
    'the authoritative fetch must be nested inside "not already stale" — otherwise a fresh D1 check could be OVERWRITTEN back to false by it, which the code never does, but the nesting is what proves it structurally');
});
check('resolveAuthoritativeCompletedWeek is actually called, with the current season and env.LEAGUE_ID', () => {
  assert.ok(/resolveAuthoritativeCompletedWeek\(lbPreSeason, String\(env\.LEAGUE_ID \|\| "74598"\)\)/.test(gate));
});
check('a null (unresolved) authoritative week forces stale, rather than being treated as "no news"', () => {
  assert.ok(/lbPreAuthWeek === null \|\| lbPreAuthWeek > builtWeek\) lbPreStale = true/.test(gate));
});
check('an error/rejection from the authoritative fetch ALSO fails closed to stale, never silently ignored', () => {
  assert.ok(/catch \(_\) \{\s*lbPreStale = true;\s*\}/.test(gate),
    'no fail-open guards (rule_no_fail_open_guards) — an exception here must not leave stale at its prior value unexamined');
});
check('the authoritative week is capped at 17, matching the window this stored board covers', () => {
  assert.ok(/Math\.min\(authWeekRaw, 17\)/.test(gate),
    'the D1 freshness query above is scoped to week <= 17 for the same reason — an uncapped comparison would false-positive once real NFL weeks run past the board\'s own window');
});

console.log('\n5. the authoritative week is exposed on the response, not just used internally');
const respStart = SRC.indexOf('const preResponse = jsonOut(200, {');
const respSlice = respStart >= 0 ? SRC.slice(respStart, respStart + 700) : '';
check('authoritative_week appears in the current-season response payload', () => {
  assert.ok(/authoritative_week:\s*lbPreAuthWeek/.test(respSlice));
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
