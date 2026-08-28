// The processed_waivers scrape must be pinned to the RUN'S OWN timestamp via
// &PERIOD=<unix>, not left to "whatever MFL currently shows as most recent".
//   node tests/waiver_misses_period_pin.test.mjs
//
// Discovered 2026-08-28 from a real MFL URL: PERIOD is not arbitrary — it is
// exactly the run's own processing timestamp, and it EXACTLY matched
// acquired_at_unix already stored in ups_add_events for two different real
// runs (2026-08-20 and 2026-08-27), verified against prod D1. So this was
// always available; nothing had to be reverse-engineered live.
//
// Without it, the scrape only ever saw "whatever MFL currently calls most
// recent" — which happened to work for a live cron firing minutes after its
// own run, but made replaying ANY past day impossible once a later run
// occurred, and left the live case dependent on timing rather than provably
// correct.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

const fnStart = SRC.indexOf('async function _waiverMissesForRun(');
const fnEnd = SRC.indexOf('\n}\n', fnStart);
const fn = fnStart > 0 && fnEnd > fnStart ? SRC.slice(fnStart, fnEnd) : '';

console.log('anchors hold');
check('_waiverMissesForRun is locatable and substantial', () => {
  assert.ok(fn.length > 200, `slice is ${fn.length} chars`);
});

console.log('\nthe scraper accepts and forwards a period');
check('function signature takes a 5th periodUnix param', () => {
  assert.ok(/function _waiverMissesForRun\(env, season, leagueId, addedNames, periodUnix\)/.test(fn));
});
check('a positive period is appended as &PERIOD=<unix>', () => {
  assert.ok(/&PERIOD=\$\{safeInt\(periodUnix, 0\)\}/.test(fn),
    'without this the fetch always requests whatever MFL currently calls "most recent"');
});
check('a zero/absent period sends no PERIOD param (never PERIOD=0)', () => {
  assert.ok(/safeInt\(periodUnix, 0\) > 0 \? `&PERIOD=/.test(fn),
    'PERIOD=0 is not "no period" to MFL — it is an argument, and an unintended one');
});

console.log('\nthe caller passes the RUN\'S OWN timestamp, not "now" and not omitted');
const callStart = SRC.indexOf('let missRes = { misses: null, reason: "" };');
const callEnd = SRC.indexOf('if (apShape === "report" && apReportTeams.length) {', callStart);
const callSite = callStart > 0 && callEnd > callStart ? SRC.slice(callStart, callEnd) : '';
check('call site slice is locatable', () => {
  assert.ok(callSite.length > 200, `slice is ${callSite.length} chars`);
});
check('apMissPeriodUnix is derived from apReportTeams, not Date.now()', () => {
  assert.ok(/apReportTeams\.reduce\(/.test(callSite) && /first_acquired_unix/.test(callSite),
    'the period must come from a REAL recorded run timestamp, not the current moment');
  assert.ok(!/Date\.now\(\)/.test(callSite), 'must not use the current time as the period');
});
check('_waiverMissesForRun is called with apMissPeriodUnix as the 5th argument', () => {
  assert.ok(/_waiverMissesForRun\(\s*env,\s*apSeason,\s*apLeagueId,[\s\S]{0,300}?apMissPeriodUnix\s*\)/.test(callSite),
    'the period is computed but never passed to the scraper');
});

console.log('\nthe overlap safety net is untouched');
check('the granted-name overlap check still exists (defense in depth)', () => {
  assert.ok(/no granted player overlaps this one/.test(SRC),
    'PERIOD makes the common case exact but does not replace this check — a mixed-period day is still possible');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
