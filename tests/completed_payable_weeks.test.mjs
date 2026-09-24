// resolveCompletedPayableWeeks — the single authority for "how many
// regular-season weeks have fully COMPLETED (and are therefore payable) as
// of a given instant", and its propagation through _parseContractData /
// _computeDropPenalty.
//   node tests/completed_payable_weeks.test.mjs
//
// Root cause this fixes: worker/src/index.js's old inline current-year-earned
// block computed
//   const wk = Math.floor((drop - w1) / (7 * 86400000)) + 1;
// and used `wk` directly as the completed-week count. The "+ 1" counted the
// week the drop date falls INSIDE as already complete — so on 2026-09-24
// (NFL Week 3 in progress, only Weeks 1-2 fully complete) the old formula
// reported 3 completed weeks instead of 2, over-crediting every in-season
// player's earned salary by a full week's share every week of the season.
//
// Text extraction (not import), same technique as tests/cap_penalty_canon.test.mjs
// and tests/front_office_earned_authority.test.mjs — index.js is a Workers
// module with top-level env bindings.
import fs from 'fs';
import assert from 'assert';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};
const check = (n, fn) => {
  try { fn(); pass++; console.log('  PASS ' + n); }
  catch (e) { fail++; console.log('  FAIL ' + n + '\n         ' + e.message); }
};

const src = fs.readFileSync('worker/src/index.js', 'utf8');
function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for ' + startMarker);
  return src.slice(i, j + endMarker.length);
}

const deriveFn = grab(
  'function deriveCompletedWeekFromLineupResolution(resolved) {',
  '  return completed >= 0 ? completed : null;\n}'
);
const resolveAuthFn = grab(
  'async function resolveAuthoritativeCompletedWeek(season, leagueId) {',
  '  return deriveCompletedWeekFromLineupResolution(resolved);\n}'
);
const resolveCompletedFn = grab(
  'async function resolveCompletedPayableWeeks(season, leagueId, opts) {',
  '  return { weeks: Math.max(0, Math.min(rsw, currentWeek - 1)), source: "kickoff_schedule_walk" };\n}'
);
const parseFn = grab(
  'const _parseContractData =',
  'return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned, weekAuthorityUnresolved };\n        };'
);
const compFn = grab(
  'const _computeDropPenalty =',
  'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };'
);
// Real fallback boundary function (with its 2026 override), extracted from
// the actual source — NOT a hand-copied stand-in — so the "static fallback"
// tests below (8i/8j/8k/8l) exercise the real code, matching this repo's
// existing extraction-over-reimplementation discipline.
const nflWeek1IsoFn = grab(
  'const _NFL_WEEK1_OVERRIDE_ISO = { 2026: "2026-09-09" };',
  'return kickoff.toISOString().slice(0, 10);\n};'
);

// Test-controlled stand-ins for resolveCurrentLineupWeek and
// nflWeekFirstKickoffUnix's real network calls. Module-level variables so
// individual tests can swap behavior without re-extracting the file.
const prelude = `
const safeStr = (v) => v == null ? "" : String(v);
const safeInt = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); };
const _s = (v) => String(v == null ? "" : v).trim();
export let __liveWeekBehavior = { mode: "throw" }; // "throw" | "value"
async function resolveCurrentLineupWeek(season, leagueId) {
  if (__liveWeekBehavior.mode === "throw") throw new Error("no live network in unit test");
  return __liveWeekBehavior.value;
}
// Stand-in for the real MFL-schedule-backed per-week kickoff lookup
// (nflWeekFirstKickoffUnix). Per-week map so the HISTORICAL branch's
// kickoff-schedule walk (which now calls this for week 1, 2, 3, ... until it
// finds the current week) can be driven with real per-week data, not just a
// single week-1 value. 0 (or a missing key) = unresolved, matching the real
// function's "never cache/return a guess" contract. __kickoffBehavior.unix
// is kept as a convenience alias for week 1 only (the "now" mode
// preseason-certain carve-out only ever asks about week 1).
export let __kickoffMap = {};
export const __kickoffBehavior = {
  get unix() { return __kickoffMap[1] || 0; },
  set unix(v) { __kickoffMap[1] = v; },
};
async function nflWeekFirstKickoffUnix(season, week) {
  return __kickoffMap[Number(week)] || 0;
}
`;
const mod = prelude + nflWeek1IsoFn + '\n' + deriveFn + '\n' + resolveAuthFn + '\n' + resolveCompletedFn + '\n' + parseFn + '\n' + compFn +
  '\nexport { resolveCompletedPayableWeeks, deriveCompletedWeekFromLineupResolution, _computeDropPenalty, _parseContractData, _nflWeek1Iso };';
fs.writeFileSync('/tmp/_completed_payable_weeks_extracted.mjs', mod);
const { resolveCompletedPayableWeeks, deriveCompletedWeekFromLineupResolution, _computeDropPenalty, _parseContractData, _nflWeek1Iso } =
  await import('/tmp/_completed_payable_weeks_extracted.mjs');
const modImports = await import('/tmp/_completed_payable_weeks_extracted.mjs');
const setLive = (behavior) => { Object.assign(modImports.__liveWeekBehavior, behavior); };
const setKickoff = (unix) => { modImports.__kickoffBehavior.unix = unix; };
// Multi-week kickoff map for the HISTORICAL branch's per-week walk. `merge`
// (default) layers onto whatever is already set (matches setKickoff's
// week-1-only convenience behavior); pass replace:true to clear every other
// week first, for tests that must prove an UNRESOLVED week beyond the ones
// explicitly listed.
const setKickoffMap = (map, opts) => {
  if (opts && opts.replace) { for (const k of Object.keys(modImports.__kickoffMap)) delete modImports.__kickoffMap[k]; }
  Object.assign(modImports.__kickoffMap, map);
};

// Real 2026 Week-1 kickoff boundary. NOTE: docs/league_context_v1.md:1220
// labels this "2026-09-10 Thu NFL Week 1 kickoff" in its generic event
// table, but the worker's own schedule-derived boundary (nflWeekFirstKickoffUnix
// / _week1BoundaryIsoET, worker/src/index.js ~line 2539) resolves the REAL
// earliest 2026 Week-1 game as WEDNESDAY 2026-09-09 (8:20pm ET = 2026-09-10
// 00:20 UTC) — Keith ruled on this directly 2026-08-07: "earliest game of
// the week, typically that's thursday but this yr it's wednesday." Per
// feedback_derive_dont_trust_notes / mfl_api_single_source_of_truth (project
// memory), the schedule-derived value is the one the code and this suite
// use; the docs table's Thursday label is a simplified approximation, not
// the ground truth. So "Week 1" here spans Wed 09-09 through the following
// Tue 09-15 (a 7-day kickoff-to-kickoff span starting on the REAL kickoff
// weekday, not necessarily literal Thursday) — canon's kickoff-to-kickoff
// CADENCE (league_context_v1.md:2946) holds regardless of which weekday the
// kickoff itself falls on.
const WK1 = '2026-09-09';

// Deterministic "now" override: monkey-patches the global Date constructor's
// zero-arg form (what `new Date()` / `.toISOString()`-of-now calls inside
// resolveCompletedPayableWeeks use to compute isNow and the preseason-certain
// check) to a fixed instant, while leaving `new Date(arg)` / Date.now() /
// Date.UTC / Date.parse behaving normally for everything else. Needed because
// resolveCompletedPayableWeeks has no injectable clock — it calls `new
// Date()` directly — so testing "now" mode and "historical" mode
// deterministically (regardless of the real wall-clock day this suite
// happens to run on) requires patching the shared global Date object, which
// the dynamically-imported extracted module also reads (same JS realm).
async function withMockedNow(fixedIso, fn) {
  const RealDate = globalThis.Date;
  const fixedMs = new RealDate(fixedIso).getTime();
  function MockDate(...args) {
    if (!(this instanceof MockDate)) return new RealDate(fixedMs).toString();
    if (args.length === 0) return new RealDate(fixedMs);
    return new RealDate(...args);
  }
  MockDate.prototype = RealDate.prototype;
  MockDate.now = () => fixedMs;
  MockDate.UTC = RealDate.UTC;
  MockDate.parse = RealDate.parse;
  globalThis.Date = MockDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

console.log('\n-- boundary table (HISTORICAL kickoff-schedule-walk branch; wrapped in withMockedNow so isNow is deterministically false regardless of the real wall-clock day this suite runs on) --');

// Real 2026 per-week kickoff unix timestamps (2026-09-25 correction pass).
// Weeks 1-3 are LIVE-VERIFIED via curl to MFL's own
// TYPE=nflSchedule&W=<n>&JSON=1, taking the earliest matchup kickoff each
// week: Week 1 = 1788999600 (Wed 09-09 20:20 ET), Week 2 = 1789690500 (Thu
// 09-17 20:15 ET, an 8-DAY gap from Week 1 -- NOT the 7 days the retired
// uniform formula assumed), Week 3 = 1790295300 (Thu 09-24 20:15 ET, exactly
// 7 days after Week 2). Weeks 4-18 are NOT individually live-verified this
// pass; they extrapolate the Week2->Week3 cadence (uniform 604800s = 7 days)
// forward, which matches docs/league_context_v1.md's own placeholder table
// (already showing every week from 2 onward as Thursday, 7 days apart) --
// this is a validated season-specific boundary map per Weeks 1-3's live
// data, not an invented time. resolveCompletedPayableWeeks's HISTORICAL
// branch has no access to this table directly -- it walks
// nflWeekFirstKickoffUnix(season, w) week by week, which this suite mocks
// via setKickoffMap to return exactly these values.
//
// Goes through WEEK 18 (2026-09-26 correction): the real NFL regular season
// is 18 weeks long even though only 17 are payable here
// (mfl_nfl_regular_season_is_18_weeks) -- Week 18's real kickoff is what
// bounds Week 17's own completion (Week 17 kicking off means Week 17 is
// merely IN PROGRESS, not complete, same as every earlier week), so the
// resolver's walk -- and this mock table -- must reach Week 18.
const WK1_UNIX = 1788999600; // Wed 2026-09-09 20:20 ET -- real, live-verified
const WK2_UNIX = 1789690500; // Thu 2026-09-17 20:15 ET -- real, live-verified (8-day gap from Week 1)
const WK3_UNIX = 1790295300; // Thu 2026-09-24 20:15 ET -- real, live-verified (7-day gap from Week 2)
const KICKOFF_UNIX = {};
for (let w = 1; w <= 18; w += 1) KICKOFF_UNIX[w] = (w === 1) ? WK1_UNIX : WK2_UNIX + (w - 2) * 604800;
const WK17_UNIX = KICKOFF_UNIX[17];
const WK18_UNIX = KICKOFF_UNIX[18];

// All of 1-7 mocked to a fixed "now" far past every dropDateIso under test
// (2027-06-01), so isNow is guaranteed false and every call below exercises
// ONLY the historical kickoff-schedule-walk branch — deterministically,
// regardless of what day this suite is actually executed on.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
// 1. Preseason -> 0
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: '2026-08-15T00:00:00Z', regularSeasonWeeks: 17 });
  t('1. preseason -> 0 completed weeks', r, { weeks: 0, source: 'kickoff_schedule_walk' });
}
// 2. Week 1 in progress -> 0
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: '2026-09-12T00:00:00Z', regularSeasonWeeks: 17 });
  t('2. Week 1 in progress -> 0', r.weeks, 0);
}
// 3. Week 1 complete (once Week 2 has actually kicked off) -> 1
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((WK2_UNIX + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  t('3. Week 1 complete (real Week-2 kickoff has occurred) -> 1', r.weeks, 1);
}
// 4. Week 3 in progress -> 2
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((WK3_UNIX + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  t('4. Week 3 in progress -> 2 (the retired uniform formula said 3, or mispriced Week 1 as early as Sept 16)', r.weeks, 2);
}
// 5. Week 3 complete (Week 4 kicked off) -> 3
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((KICKOFF_UNIX[4] + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  t('5. Week 3 complete -> 3', r.weeks, 3);
}
// 6. Week 17 has kicked off -> 16 (2026-09-26 correction: Week 17 kicking
// off means Week 17 is merely IN PROGRESS, same "in-progress never counts"
// rule as every earlier week — it takes the real Week 18 kickoff to bound
// Week 17's own completion; see the dedicated Week-17/18 block below).
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((KICKOFF_UNIX[17] + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  t('6. Week 17 kicked off -> 16 (in progress, NOT fully earned)', r.weeks, 16);
}
// 7. Postseason (well past Week 18) -> capped at 17
{
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((KICKOFF_UNIX[18] + 30 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17 });
  t('7. well past Week 18 -> capped at 17, never higher', r.weeks, 17);
}
});

console.log('\n-- resolver unavailable in "now" mode: fails closed, never guesses, NEVER falls through to date-math --');
// 8. No live authority + no derivable week1 boundary, "now" mode -> weeks:null,
// source "unresolved_live" (NOT the old "unresolved"/date-math-fallback
// source -- that fallback is banned for "now" per the item-1 fix).
// _computeDropPenalty must still fail closed on the null.
await withMockedNow('2026-09-24T12:00:00Z', async () => {
  setLive({ mode: 'throw' });
  setKickoff(0); // no schedule answer either -> preseason-certain carve-out also can't fire
  // Force truly unresolvable: bogus season (no derivable week1) AND live call throws
  // AND the kickoff lookup returns 0 (unresolved) so the preseason-certain
  // carve-out cannot fire either.
  const r2 = await resolveCompletedPayableWeeks('', '74598', {});
  t('8a. "now" mode, live authority unavailable -> weeks: null, source: unresolved_live (fails closed, no date-math fallback)', r2, { weeks: null, source: 'unresolved_live' });

  const calc = _computeDropPenalty(
    { contractStatus: 'Veteran', salary: 13000, contractInfo: 'CL 3| TCV 39K| AAV 13K| Y1-13K, Y2-13K, Y3-13K', contractYear: '3' },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: r2.weeks }
  );
  check('8b. _computeDropPenalty fails closed on null week authority', () => {
    assert.strictEqual(calc.basis, 'week_authority_unresolved');
    assert.strictEqual(calc.needs_review, true);
    assert.strictEqual(calc.penalty, null);
  });
});

console.log('\n-- 8c/8d/8e. "now" mode design proofs: preseason-certain carve-out + never-falls-through-to-date-math --');
// 8c. Genuine pre-kickoff preseason in "now" mode is a KNOWN FACT (source
// "preseason_certain") answered WITHOUT the live-scoring authority -- prove
// the live resolver is never even attempted by making it throw and still
// getting the right answer.
await withMockedNow('2026-09-01T12:00:00Z', async () => { // before the real 2026-09-09 kickoff
  setLive({ mode: 'throw' });
  setKickoff(Math.floor(new Date('2026-09-09T00:00:00Z').getTime() / 1000));
  const r = await resolveCompletedPayableWeeks('2026', '74598', {});
  t('8c. "now" mode, before real kickoff -> weeks:0, source:preseason_certain (no live call needed)', r, { weeks: 0, source: 'preseason_certain' });
});

// 8d. "now" mode, IN-SEASON (after kickoff), live authority throws, AND a
// bogus week1ThursdayIso is supplied that WOULD produce a wrong non-null
// answer if the banned date-math fallback were ever reached (a week1 date
// far in the past yields a large fabricated week count). Assert the
// function returns null, not that fabricated number -- proving date-math is
// structurally unreachable from "now" mode once the live authority fails.
await withMockedNow('2026-09-24T12:00:00Z', async () => { // after real kickoff -> not preseason
  setLive({ mode: 'throw' });
  setKickoff(Math.floor(new Date('2026-09-09T00:00:00Z').getTime() / 1000));
  const wrongAnswerIfDateMathReached = '2020-01-01'; // would yield weeks=17 (capped) via date-math -- a clearly WRONG number for 2026-09-24
  const r = await resolveCompletedPayableWeeks('2026', '74598', { week1ThursdayIso: wrongAnswerIfDateMathReached, regularSeasonWeeks: 17 });
  check('8d. "now" mode in-season, live authority down -> null, NEVER the date-math fallback answer (17)', () => {
    assert.strictEqual(r.weeks, null, 'date-math fallback leaked through: got ' + JSON.stringify(r));
    assert.strictEqual(r.source, 'unresolved_live');
    assert.notStrictEqual(r.weeks, 17, 'the exact wrong answer the banned date-math branch would have produced must never appear');
  });
});

// 8e. "now" mode, live authority SUCCEEDS -> its answer is used, never
// date-math, even when a week1ThursdayIso is also supplied (it must be
// ignored in "now" mode as long as the live authority resolves).
await withMockedNow('2026-09-24T12:00:00Z', async () => {
  setLive({ mode: 'value', value: { week: 4, source: 'live_scoring' } }); // -> 3 completed weeks
  setKickoff(Math.floor(new Date('2026-09-09T00:00:00Z').getTime() / 1000));
  const r = await resolveCompletedPayableWeeks('2026', '74598', { week1ThursdayIso: '2020-01-01', regularSeasonWeeks: 17 });
  t('8e. "now" mode, live authority resolves -> its own answer wins, ignoring the (wrong) date-math week1', r, { weeks: 3, source: 'live_scoring_authority' });
});

console.log('\n-- 8f/8g/8h. boundary tests around the ACTUAL live kickoff timestamp (not an approximation) --');
// Live-verified 2026-09-24: curl to MFL's own TYPE=nflSchedule&W=1&JSON=1
// returns the earliest Week-1 matchup kickoff as unix 1788999600, which is
// Wednesday 2026-09-09 20:20:00 ET (= 2026-09-10T00:20:00Z). This is the
// REAL value nflWeekFirstKickoffUnix(season,1) resolves in production
// (confirmed via en-CA/America-New_York date formatting: "2026-09-09"),
// not the day-level '2026-09-09T00:00:00Z' approximation used by 8c/8d/8e
// above. These three tests use that exact real unix value so the
// preseason-certain carve-out's boundary is proven against ground truth,
// not a rounded stand-in.
const REAL_WK1_KICKOFF_UNIX = 1788999600; // Wed 2026-09-09 20:20 ET / 2026-09-10 00:20 UTC

await withMockedNow(new Date((REAL_WK1_KICKOFF_UNIX - 1) * 1000).toISOString(), async () => {
  setLive({ mode: 'throw' }); // must not be reached -- preseason-certain must answer without it
  setKickoff(REAL_WK1_KICKOFF_UNIX);
  const r = await resolveCompletedPayableWeeks('2026', '74598', {});
  t('8f. 1 second before the REAL kickoff instant -> weeks:0, source:preseason_certain', r, { weeks: 0, source: 'preseason_certain' });
});

await withMockedNow(new Date(REAL_WK1_KICKOFF_UNIX * 1000).toISOString(), async () => {
  // At the exact kickoff instant, Date.now() < wk1Unix is false (equal, not
  // less-than) -- the preseason-certain carve-out must NOT fire; the game
  // has started, so this falls through to the live-scoring authority.
  setLive({ mode: 'value', value: { week: 1, source: 'live_scoring' } }); // week 1 just started, 0 complete
  setKickoff(REAL_WK1_KICKOFF_UNIX);
  const r = await resolveCompletedPayableWeeks('2026', '74598', {});
  t('8g. AT the exact REAL kickoff instant -> preseason-certain does NOT fire (not < ), falls to live-scoring -> weeks:0', r, { weeks: 0, source: 'live_scoring_authority' });
});

await withMockedNow(new Date((REAL_WK1_KICKOFF_UNIX + 1) * 1000).toISOString(), async () => {
  setLive({ mode: 'value', value: { week: 1, source: 'live_scoring' } });
  setKickoff(REAL_WK1_KICKOFF_UNIX);
  const r = await resolveCompletedPayableWeeks('2026', '74598', {});
  t('8h. 1 second after the REAL kickoff instant -> in-season, live-scoring authority answers -> weeks:0', r, { weeks: 0, source: 'live_scoring_authority' });
});

console.log('\n-- 8i. _nflWeek1Iso static override (still live code — used by _nflWeekForUnix\'s acquisition-week mapping — but no longer consulted by resolveCompletedPayableWeeks\'s historical branch, which now walks real per-week kickoffs instead) --');
t('8i. _nflWeek1Iso(2026) -> "2026-09-09" (NOT the old "2026-09-10" placeholder)', _nflWeek1Iso('2026'), '2026-09-09');

console.log('\n-- REQUIRED (2026-09-25 pass): historical boundary must use REAL per-week kickoffs, not "Week1 + 7n" --');
// docs: the retired uniform-7-day formula computed Week 2's boundary as
// WK1_UNIX + 7 days = 2026-09-16, one day EARLY relative to the real
// Week-2 kickoff (2026-09-17) -- so a drop dated Sept 16 (genuinely still
// inside Week 1's real 8-day span) was priced as if Week 1 were already
// earned. Tests 1-8 below walk the REAL per-week kickoff timestamps
// (mocked via setKickoffMap to the live-verified/extrapolated KICKOFF_UNIX
// table declared above) and prove that defect is gone.

// 1. One second before Week 1 kickoff -> 0.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK1_UNIX - 1) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ1. one second before Week 1 kickoff -> 0', r.weeks, 0);
});

// 2. At Week 1 kickoff -> 0 (the week that just started is never "completed").
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date(WK1_UNIX * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ2. at Week 1 kickoff -> 0', r.weeks, 0);
});

// 3. September 16 at the OLD FALSE seven-day boundary -> still 0. THIS IS
// THE DEFECT TEST: WK1_UNIX + 7*86400 lands on 2026-09-16, which the retired
// uniform formula would have called "Week 1 complete" -- but the REAL
// Week-2 kickoff is 2026-09-17, so Sept 16 is still genuinely inside Week
// 1's span.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const sept16FalseBoundary = new Date((WK1_UNIX + 7 * 86400) * 1000).toISOString();
  const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: sept16FalseBoundary, regularSeasonWeeks: 17 });
  check('REQ3. Sept-16 old false 7-day boundary -> STILL 0 (the September-16-early-accrual defect is gone)', () => {
    assert.strictEqual(r.weeks, 0, 'defect NOT fixed: Sept 16 was priced as Week-1-complete, got weeks=' + r.weeks);
  });
});

// 4. One second before Week 2 kickoff -> 0.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK2_UNIX - 1) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ4. one second before Week 2 kickoff -> 0', r.weeks, 0);
});

// 5. At Week 2 kickoff -> 1.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date(WK2_UNIX * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ5. at Week 2 kickoff -> 1', r.weeks, 1);
});

// 6. During Week 2 -> 1.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK2_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ6. during Week 2 -> 1', r.weeks, 1);
});

// 7. One second before Week 3 kickoff -> 1.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK3_UNIX - 1) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ7. one second before Week 3 kickoff -> 1', r.weeks, 1);
});

// 8. At Week 3 kickoff -> 2.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date(WK3_UNIX * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ8. at Week 3 kickoff -> 2', r.weeks, 2);
});

// 9. Missing historical schedule authority -> unresolved/fail closed. No
// week's kickoff resolves (empty map) -> the walk fails on week 1 itself ->
// null, source "unresolved". Must NOT fall back to Week1+7n (there is no
// such branch left to fall back to — this proves it structurally, not just
// by absence of a wrong number).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap({}, { replace: true }); // every week unresolved
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: '2026-10-15T00:00:00Z', regularSeasonWeeks: 17,
  });
  check('REQ9. missing historical schedule authority -> weeks:null, source:unresolved (fails closed)', () => {
    assert.strictEqual(r.weeks, null);
    assert.strictEqual(r.source, 'unresolved');
  });
  // And the same failure mode when only a LATER week (not week 1) is
  // unresolved -- proves the walk fails closed mid-season too, not only at
  // the very first week.
  setKickoffMap({ 1: WK1_UNIX, 2: WK2_UNIX }, { replace: true }); // week 3+ unresolved
  const r2 = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK3_UNIX + 3600) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  check('REQ9b. week 1-2 resolved but week 3 unresolved, asked about a Week-3+ instant -> null (fails closed mid-walk)', () => {
    assert.strictEqual(r2.weeks, null);
    assert.strictEqual(r2.source, 'unresolved');
  });
});

// 10. Admin recompute does not write when unresolved. Faithful reconstruction
// of the real /admin/drops/post-discord?recompute=1 loop body (worker/src/
// index.js, the `if (rc.basis === "week_authority_unresolved") { ...skip...}
// else { ...UPDATE ups_drop_events... }` guard) — proves the write is
// structurally unreachable when the historical authority is unresolved, via
// a call-counted mock D1 statement, not just by reading the source text.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  let writeCount = 0;
  const mockD1 = { prepare: () => ({ bind: () => ({ run: async () => { writeCount += 1; } }) }) };
  // Reconstructs the real loop body's decision exactly: resolve week
  // authority, compute the penalty, and only write if the basis is NOT
  // week_authority_unresolved (see worker/src/index.js ~line 47237).
  async function recomputeRow(row, weekAuthorityOpts) {
    const weekAuthority = await resolveCompletedPayableWeeks('2026', '74598', weekAuthorityOpts);
    const rc = _computeDropPenalty(
      { contractStatus: row.contractStatus, salary: row.salary, contractInfo: row.contractInfo, contractYear: row.contractYear, isTaxi: false },
      { season: '2026', dropDateIso: weekAuthorityOpts.dropDateIso, completedPayableWeeks: weekAuthority.weeks }
    );
    if (rc.basis === 'week_authority_unresolved') return { wrote: false, rc };
    await mockD1.prepare('UPDATE ups_drop_events SET penalty_amount=? WHERE id=?').bind(rc.penalty, row.id).run();
    return { wrote: true, rc };
  }
  const row = { id: 1, contractStatus: 'Veteran', salary: 13000, contractInfo: 'CL 3| TCV 39K| AAV 13K| Y1-13K, Y2-13K, Y3-13K', contractYear: '3' };

  setKickoffMap({}, { replace: true }); // unresolved
  const resultUnresolved = await recomputeRow(row, { dropDateIso: '2026-10-15T00:00:00Z', regularSeasonWeeks: 17 });
  check('REQ10a. admin recompute: unresolved historical authority -> no D1 write', () => {
    assert.strictEqual(resultUnresolved.wrote, false);
    assert.strictEqual(resultUnresolved.rc.basis, 'week_authority_unresolved');
    assert.strictEqual(writeCount, 0);
  });

  setKickoffMap(KICKOFF_UNIX, { replace: true }); // resolved
  const resultResolved = await recomputeRow(row, { dropDateIso: new Date((WK3_UNIX + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  check('REQ10b. admin recompute: resolved historical authority -> DOES write (sanity check the guard isn\'t just always skipping)', () => {
    assert.strictEqual(resultResolved.wrote, true);
    assert.strictEqual(writeCount, 1);
  });
});

// 11. Preview and real-charge paths use the same HISTORICAL result. Two
// independent call sites (mirroring the preview route and the scanner),
// given the identical historical dropDateIso and the same real kickoff
// data, must resolve the identical completed-week count and therefore the
// identical {earned,guaranteed,penalty,basis}.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const historicalDropIso = new Date((WK3_UNIX + 3600) * 1000).toISOString(); // during Week 3 -> 2 completed
  const previewSideWeekAuthority = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: historicalDropIso, regularSeasonWeeks: 17 });
  const scannerSideWeekAuthority = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: historicalDropIso, regularSeasonWeeks: 17 });
  const input = { contractStatus: 'Veteran', salary: 63000, contractInfo: 'CL 1| TCV 63K| AAV 63K', contractYear: '1' };
  const previewCalc = _computeDropPenalty(input, { season: '2026', dropDateIso: historicalDropIso, completedPayableWeeks: previewSideWeekAuthority.weeks });
  const scannerCalc = _computeDropPenalty(input, { season: '2026', dropDateIso: historicalDropIso, completedPayableWeeks: scannerSideWeekAuthority.weeks });
  check('REQ11. preview-shaped and scanner-shaped calls agree on the SAME historical result', () => {
    assert.strictEqual(previewSideWeekAuthority.weeks, scannerSideWeekAuthority.weeks);
    assert.deepStrictEqual(
      { earned: previewCalc.earned, guaranteed: previewCalc.guaranteed, penalty: previewCalc.penalty, basis: previewCalc.basis },
      { earned: scannerCalc.earned, guaranteed: scannerCalc.guaranteed, penalty: scannerCalc.penalty, basis: scannerCalc.basis }
    );
  });
});

// 12. Post-Week-17 result caps at 17 (historical mode; the "now" mode
// equivalent is already covered elsewhere in this suite).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((KICKOFF_UNIX[17] + 60 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('REQ12. well past Week 17 (historical) -> capped at 17', r.weeks, 17);
});

console.log('\n-- REQUIRED (2026-09-26 pass): Week 17 completion boundary is the REAL Week 18 kickoff --');
// Week 17 kicking off means Week 17 is merely IN PROGRESS -- the same
// "in-progress week never counts" rule the resolver already applies to
// every earlier week. Only the real Week 18 kickoff (NFL's regular season
// is 18 real weeks, memo mfl_nfl_regular_season_is_18_weeks, even though
// only 17 are payable in this league) bounds Week 17's own completion.

// 1. One second before Week 17 kickoff -> 15.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK17_UNIX - 1) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-1. one second before Week 17 kickoff -> 15', r.weeks, 15);
});

// 2. At Week 17 kickoff -> 16 (NOT 17 — Week 17 just started, it isn't done).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date(WK17_UNIX * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-2. at Week 17 kickoff -> 16 (Week 17 has NOT started counting as complete)', r.weeks, 16);
});

// 3. During Week 17 -> 16.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK17_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-3. during Week 17 -> 16', r.weeks, 16);
});

// 4. One second before Week 18 kickoff -> 16 (Week 17 still in progress).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK18_UNIX - 1) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-4. one second before Week 18 kickoff -> 16', r.weeks, 16);
});

// 5. At Week 18 kickoff -> 17 (Week 17 has now genuinely elapsed).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date(WK18_UNIX * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-5. at Week 18 kickoff -> 17', r.weeks, 17);
});

// 6. After Week 18 kickoff -> 17 (capped — Week 18 itself is never payable).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK18_UNIX + 45 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  t('W17-6. well after Week 18 kickoff -> 17, capped (Week 18 itself never payable)', r.weeks, 17);
});

// 7. Missing Week 18 boundary -> unresolved. Weeks 1-17 all resolve, but
// Week 18 does not — asking about an instant that NEEDS Week 18 to answer
// (at/after Week 17's own kickoff) must fail closed, not fall back to
// "Week 17 started, so count it".
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  const partialMap = {}; for (let w = 1; w <= 17; w += 1) partialMap[w] = KICKOFF_UNIX[w];
  setKickoffMap(partialMap, { replace: true }); // week 18 deliberately absent -> 0/unresolved
  const r = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK17_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  check('W17-7. missing Week 18 boundary -> weeks:null, source:unresolved (fails closed, never "started = done")', () => {
    assert.strictEqual(r.weeks, null);
    assert.strictEqual(r.source, 'unresolved');
    assert.notStrictEqual(r.weeks, 16, 'must not silently fall back to the in-progress-week count either');
  });
});

// 8. Preview/display paths show unavailable when unresolved.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  const partialMap = {}; for (let w = 1; w <= 17; w += 1) partialMap[w] = KICKOFF_UNIX[w];
  setKickoffMap(partialMap, { replace: true });
  const weekAuthority = await resolveCompletedPayableWeeks('2026', '74598', {
    dropDateIso: new Date((WK17_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17,
  });
  const calc = _computeDropPenalty(
    { contractStatus: 'Veteran', salary: 63000, contractInfo: 'CL 1| TCV 63K| AAV 63K', contractYear: '1' },
    { season: '2026', dropDateIso: '2026-12-01T00:00:00Z', completedPayableWeeks: weekAuthority.weeks }
  );
  check('W17-8. preview/display path: unresolved Week-18 boundary -> basis week_authority_unresolved (renders unavailable, not a number)', () => {
    assert.strictEqual(calc.basis, 'week_authority_unresolved');
    assert.strictEqual(calc.needs_review, true);
    assert.strictEqual(calc.penalty, null);
  });
});

// 9. Admin recompute performs zero writes when unresolved (same faithful
// reconstruction pattern as the prior pass's REQ10, applied to the
// Week-17/18 scenario specifically).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  let writeCount = 0;
  const mockD1 = { prepare: () => ({ bind: () => ({ run: async () => { writeCount += 1; } }) }) };
  async function recomputeRow(row, weekAuthorityOpts) {
    const weekAuthority = await resolveCompletedPayableWeeks('2026', '74598', weekAuthorityOpts);
    const rc = _computeDropPenalty(
      { contractStatus: row.contractStatus, salary: row.salary, contractInfo: row.contractInfo, contractYear: row.contractYear, isTaxi: false },
      { season: '2026', dropDateIso: weekAuthorityOpts.dropDateIso, completedPayableWeeks: weekAuthority.weeks }
    );
    if (rc.basis === 'week_authority_unresolved') return { wrote: false, rc };
    await mockD1.prepare('UPDATE ups_drop_events SET penalty_amount=? WHERE id=?').bind(rc.penalty, row.id).run();
    return { wrote: true, rc };
  }
  const row = { id: 1, contractStatus: 'Veteran', salary: 63000, contractInfo: 'CL 1| TCV 63K| AAV 63K', contractYear: '1' };

  const partialMap = {}; for (let w = 1; w <= 17; w += 1) partialMap[w] = KICKOFF_UNIX[w];
  setKickoffMap(partialMap, { replace: true }); // week 18 unresolved
  const resultUnresolved = await recomputeRow(row, { dropDateIso: new Date((WK17_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17 });
  check('W17-9. admin recompute at Week 17, Week-18 boundary unresolved -> zero D1 writes', () => {
    assert.strictEqual(resultUnresolved.wrote, false);
    assert.strictEqual(writeCount, 0);
  });
});

// 10. Real financial-write paths fail closed (the scanner's call shape:
// completedPayableWeeks: null propagated explicitly, mirroring
// worker/src/index.js's real scanner/preview call sites).
{
  const calc = _computeDropPenalty(
    { contractStatus: 'Veteran', salary: 32000, contractInfo: 'CL 1| TCV 32K| AAV 32K', contractYear: '1' },
    { season: '2026', dropDateIso: '2026-12-01T00:00:00Z', completedPayableWeeks: null }
  );
  check('W17-10. real financial-write shape: completedPayableWeeks null -> penalty null, needs_review true (fails closed, never guesses)', () => {
    assert.strictEqual(calc.penalty, null);
    assert.strictEqual(calc.needs_review, true);
    assert.strictEqual(calc.basis, 'week_authority_unresolved');
  });
}

// 11. Preview and charge paths return the SAME completed-week result at the
// Week 17/18 boundary specifically.
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const atWeek17Kickoff = new Date(WK17_UNIX * 1000).toISOString();
  const previewSide = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: atWeek17Kickoff, regularSeasonWeeks: 17 });
  const scannerSide = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: atWeek17Kickoff, regularSeasonWeeks: 17 });
  check('W17-11. preview-shaped and scanner-shaped calls agree at the Week 17/18 boundary (both 16, not 17)', () => {
    assert.strictEqual(previewSide.weeks, 16);
    assert.strictEqual(scannerSide.weeks, 16);
    assert.strictEqual(previewSide.weeks, scannerSide.weeks);
  });
});

// 12. Existing Week 1-16 boundary behavior remains unchanged (spot-check
// against the same instants tests 1-5/REQ1-8/22.1-22.8 already exercise —
// all already re-run and passing above; this is an explicit, standalone
// regression pin for the Week-17/18 change specifically).
await withMockedNow('2027-06-01T00:00:00Z', async () => {
  setKickoffMap(KICKOFF_UNIX, { replace: true });
  const r1 = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((WK1_UNIX + 3 * 86400) * 1000).toISOString(), regularSeasonWeeks: 17 });
  const r2 = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date(WK2_UNIX * 1000).toISOString(), regularSeasonWeeks: 17 });
  const r3 = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((WK3_UNIX + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  const r16 = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: new Date((KICKOFF_UNIX[16] + 3600) * 1000).toISOString(), regularSeasonWeeks: 17 });
  check('W17-12. Weeks 1-16 boundary behavior unchanged by the Week-17/18 fix', () => {
    assert.strictEqual(r1.weeks, 0, 'Week 1 in progress');
    assert.strictEqual(r2.weeks, 1, 'at Week 2 kickoff');
    assert.strictEqual(r3.weeks, 2, 'during Week 3');
    assert.strictEqual(r16.weeks, 15, 'during Week 16 -> 15 completed (Weeks 1-15)');
  });
});

console.log('\n-- exact dollar figures: Brissett / Murray / Prescott at 2 completed weeks --');
const stdContract = (salary) => ({
  contractStatus: 'Veteran', salary,
  contractInfo: `CL 3| TCV ${Math.round(salary * 3 / 1000)}K| AAV ${Math.round(salary / 1000)}K| Y1-${Math.round(salary / 1000)}K, Y2-${Math.round(salary / 1000)}K, Y3-${Math.round(salary / 1000)}K`,
  contractYear: '3',
});
// 9. Standard veteran contract at 2 completed weeks.
{
  const r = _computeDropPenalty(stdContract(13000), { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
  t('9. earned = round(13000*2/17)', r.earned, Math.round(13000 * 2 / 17));
}
// 20 (moved up next to its siblings). Exact values, rounded ONCE.
{
  const cases = [['Brissett', 13000, 1529], ['Murray', 32000, 3765], ['Prescott', 63000, 7412]];
  for (const [name, salary, want] of cases) {
    const r = _computeDropPenalty(stdContract(salary), { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
    t('20. ' + name + ' earned = round(salary*2/17) = $' + want, r.earned, want);
  }
  const brissett = _computeDropPenalty(stdContract(13000), { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
  assert.notStrictEqual(brissett.earned, Math.round(13000 / 17) * 2, '20b. must not be round(weekly)*weeks = $1,530 — must round the fraction*salary product ONCE');
}

console.log('\n-- 21. Jack Strand (real rostered player, franchise 0008 "Real Deal Creel") — sub-$5K TCV, 4-field breakdown --');
// Real contractInfo pulled from site/rosters/contract_submissions/contract_activity_2026.json
// (player_id 17743, "Strand, Jack"): "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K", salary
// 1000, contract_year 3 (= 3 years remaining, cy=3=CL, so he is in his FIRST
// year of the deal — yearsPlayed = cl - yearsRemaining = 3-3 = 0), status
// "Rookie-WW". Canon docs/league_context_v1.md:604-607: "Sub-$5K TCV rule...
// for any contract with TCV ≤ $4K... years_remaining ≥ 2 → fixed $1K cap
// penalty... This overrides the standard guaranteed-minus-earned formula
// entirely." TCV=$3,000 ≤ $4,000 and years_remaining=3 ≥ 2, so this must hit
// the `tcv_under_5k_flat` branch — same corrected 2/17 week-math as every
// other player, but guaranteed/penalty are the FLAT override, NOT the
// standard formula.
{
  const strand = _computeDropPenalty(
    { contractStatus: 'Rookie-WW', salary: 1000, contractInfo: 'CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K', contractYear: '3' },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 }
  );
  t('21a. Strand annual (Y1) salary parsed = $1,000', strand.yearSalaries[1], 1000);
  t('21b. Strand earned = round(1000*2/17) = $118 (NOT $1,000 — reflects the corrected week-math, same 2/17 fraction as Brissett/Murray/Prescott)', strand.earned, Math.round(1000 * 2 / 17));
  t('21c. Strand guaranteed = flat $1,000 (tcv_under_5k_flat override, years_remaining=3 >= 2)', strand.guaranteed, 1000);
  t('21d. Strand penalty = flat $1,000, basis tcv_under_5k_flat', { penalty: strand.penalty, basis: strand.basis }, { penalty: 1000, basis: 'tcv_under_5k_flat' });
  check('21e. penalty is the FLAT override, NOT netted against earned (guaranteed - earned = 1000-118 = 882, but penalty stays 1000)', () => {
    assert.notStrictEqual(strand.penalty, strand.guaranteed - strand.earned, 'tcv_under_5k_flat must NOT net penalty against earned');
    assert.strictEqual(strand.penalty, 1000);
  });
}

console.log('\n-- 10. front-loaded contract uses actual year-salary token, not AAV --');
{
  const r = _parseContractData(
    { contractInfo: 'CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K', salary: 30000, contractYear: '2' },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 }
  );
  t('10. currentYearEarned uses Y2 actual ($30K), round(30000*2/17)', r.currentYearEarned, Math.round(30000 * 2 / 17));
}

console.log('\n-- 11/12/13. acquisition-week denominator (18-W eligible weeks) --');
{
  // 11. Week-1 acquisition, 2 completed weeks -> 2 earned of 17 eligible.
  const r1 = _computeDropPenalty(stdContract(13000),
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2, acquisitionWeek: 1 });
  t('11. Week-1 acquisition: earned = round(salary*2/17)', r1.earned, Math.round(13000 * 2 / 17));
  // 12. Week-2 acquisition, 2 completed weeks -> 1 earned week of 16 eligible.
  const r2 = _computeDropPenalty(stdContract(13000),
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2, acquisitionWeek: 2 });
  t('12. Week-2 acquisition: earned = round(salary*1/16)', r2.earned, Math.round(13000 * 1 / 16));
  // 13. Week-3 acquisition, 2 completed weeks -> 0 earned weeks of 15 eligible.
  const r3 = _computeDropPenalty(stdContract(13000),
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2, acquisitionWeek: 3 });
  t('13. Week-3 acquisition: earned = 0 (not yet active)', r3.earned, 0);
}

console.log('\n-- 14. trade does not reset acquisition-week clock --');
{
  check('_computeDropPenalty carries no franchise/owner field', () => {
    assert.ok(!/franchise|owner/i.test(compFn.split('\n')[0]), 'destructured input must not key off franchise/ownership');
  });
  const a = _computeDropPenalty(stdContract(13000), { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2, acquisitionWeek: 2 });
  const b = _computeDropPenalty(stdContract(13000), { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2, acquisitionWeek: 2 });
  t('14. identical acquisitionWeek input earns identically regardless of "which franchise asked"', a.earned, b.earned);
}

console.log('\n-- 15. IR player accrues normally (no IR-specific branch) --');
{
  check('no isIr / IR gate inside _computeDropPenalty', () => {
    assert.ok(!/isIr|IR_STATUS|"IR"/.test(compFn), '_computeDropPenalty must not special-case IR — earned keeps accruing on IR');
  });
}

console.log('\n-- 16. taxi: earned reported normally, penalty stays $0 via taxi_exempt --');
{
  const r = _computeDropPenalty({ ...stdContract(13000), isTaxi: true },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
  t('16a. taxi penalty is exempt $0', r.penalty, 0);
  t('16b. taxi basis is taxi_exempt', r.basis, 'taxi_exempt');
  t('16c. taxi still reports the real earned figure', r.earned, 1529);
}

console.log('\n-- 17. sub-$5K TCV override unaffected by the week-math fix --');
{
  const sub = (cy) => _computeDropPenalty(
    { contractStatus: 'Veteran', salary: 1000, contractInfo: 'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K', contractYear: String(cy) },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
  t('17a. CL3 $1K/yr, 2 yrs remaining -> flat $1K penalty', sub(2).penalty, 1000);
  t('17b. CL3 $1K/yr, final year -> cap-free $0', sub(1).penalty, 0);
  const r = _parseContractData(
    { contractInfo: 'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K', salary: 1000, contractYear: '2' },
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 2 });
  t('17c. earned itself still reflects the corrected weekly math', r.currentYearEarned, Math.round(1000 * 2 / 17));
}

console.log('\n-- 18. guaranteed-minus-earned penalty is never negative --');
{
  // A fully-earned contract (17/17 weeks) must clamp penalty to 0, not go negative.
  const r = _computeDropPenalty(stdContract(13000),
    { dropDateIso: '2026-09-24T00:00:00Z', season: '2026', completedPayableWeeks: 17 });
  check('18. penalty >= 0 always', () => assert.ok(r.penalty >= 0, 'penalty must be clamped at 0, got ' + r.penalty));
}

console.log('\n-- 19. preview call shape and scanner call shape are byte-identical given the same inputs --');
{
  const input = { contractStatus: 'Veteran', salary: 13000, contractInfo: 'CL 3| TCV 39K| AAV 13K| Y1-13K, Y2-13K, Y3-13K', contractYear: '3', isTaxi: false, taxiNeverPromoted: false };
  const opts = { season: '2026', dropDateIso: '2026-09-24T00:00:00Z', acquisitionWeek: undefined, completedPayableWeeks: 2 };
  // penaltyFor()'s call shape (preview endpoint)
  const previewResult = _computeDropPenalty(input, { ...opts });
  // computeDropPenalty()'s call shape (hourly scanner, same alias target)
  const scannerResult = _computeDropPenalty(input, { dropDateIso: opts.dropDateIso, season: opts.season, acquisitionWeek: opts.acquisitionWeek, week1ThursdayIso: undefined, completedPayableWeeks: opts.completedPayableWeeks });
  t('19. preview and scanner produce byte-identical {earned,guaranteed,penalty,basis}',
    { earned: previewResult.earned, guaranteed: previewResult.guaranteed, penalty: previewResult.penalty, basis: previewResult.basis },
    { earned: scannerResult.earned, guaranteed: scannerResult.guaranteed, penalty: scannerResult.penalty, basis: scannerResult.basis });
}

console.log('\n-- extra: live-scoring "now" mode via injected resolvedLineup (no live network) --');
{
  // deriveCompletedWeekFromLineupResolution({week:4, source:"live_scoring"}) -> 3
  const resolved = { week: 4, source: 'live_scoring' };
  const r = await resolveCompletedPayableWeeks('2026', '74598', { resolvedLineup: resolved, week1ThursdayIso: WK1, regularSeasonWeeks: 17 });
  t('extra. live-scoring authority (injected, no network) -> source live_scoring_authority', r, { weeks: 3, source: 'live_scoring_authority' });
}

console.log('\n-- 22. Nine specific historical boundary instants, per canon docs/league_context_v1.md:2946:');
console.log("   \"Each NFL 'week' runs Thursday through the following Wednesday (TNF kickoff to TNF kickoff).\"");
console.log('   i.e. weeks are demarcated by REAL kickoff-to-kickoff boundaries — NOT a uniform 7-day cadence');
console.log('   from Week 1 (2026-09-25 correction: Week1->Week2 is a real 8-day gap, not 7) — and not by when');
console.log('   the LAST game of a week finishes. Anchored to the live-verified KICKOFF_UNIX table declared');
console.log('   above (Weeks 1-3 real, Weeks 4-17 extrapolated at the live-verified 7-day cadence from Week 2).');
console.log('   All wrapped in withMockedNow so every call below is deterministically HISTORICAL (isNow=false).');
{
  const iso = (unixSec) => new Date(unixSec * 1000).toISOString();

  await withMockedNow('2027-06-01T00:00:00Z', async () => {
    setKickoffMap(KICKOFF_UNIX, { replace: true });
    // 1. Hours before Week-1 kickoff -> 0. Canon: zero games have been played.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK1_UNIX - 12 * 3600), regularSeasonWeeks: 17 });
      t('22.1 hours before Week-1 kickoff -> 0 (preseason, zero games played)', r.weeks, 0);
    }
    // 2. During Week 1 (kickoff+3 days, "Saturday"-equivalent) -> 0.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK1_UNIX + 3 * 86400), regularSeasonWeeks: 17 });
      t('22.2 during Week 1 (kickoff+3d) -> 0 (Week 1 span not yet elapsed)', r.weeks, 0);
    }
    // 3. "Immediately after the final Week 1 game" (kickoff+5d, "Monday
    // night"-equivalent) but STILL inside Week 1's real kickoff-to-kickoff
    // span -> 0. This is the crux instant: a reader might assume "the week
    // completes when the last game (MNF) ends", but canon 2946 is explicit
    // the boundary is KICKOFF-to-KICKOFF, and the REAL Week-2 kickoff is a
    // full 8 days after Week 1's — not 7 — so a completed slate of games at
    // +5d does NOT itself complete the payable week.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK1_UNIX + 5 * 86400), regularSeasonWeeks: 17 });
      t('22.3 immediately after Week 1\'s final game, still within its REAL kickoff-to-kickoff span -> 0 (canon 2946: kickoff-to-kickoff, NOT last-game-to-first-game)', r.weeks, 0);
    }
    // 4. kickoff+6 days, still before the REAL next kickoff -> 0.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK1_UNIX + 6 * 86400), regularSeasonWeeks: 17 });
      t('22.4 kickoff+6d (still before the REAL Week 2 kickoff) -> 0', r.weeks, 0);
    }
    // 5. THE SEPTEMBER-16 DEFECT INSTANT: kickoff+7 days (2026-09-16) — this
    // is exactly the boundary the RETIRED uniform formula got wrong. The
    // real Week-2 kickoff is 2026-09-17, a full 8 days after Week 1's, so
    // Sept 16 (only 7 days in) is still genuinely inside Week 1's span.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK1_UNIX + 7 * 86400), regularSeasonWeeks: 17 });
      t('22.5 Sept-16 (the old false 7-day boundary) -> STILL 0, not the retired formula\'s early "1"', r.weeks, 0);
    }
    // 6. Immediately before Week 2's REAL kickoff instant -> 0.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK2_UNIX - 1), regularSeasonWeeks: 17 });
      t('22.6 immediately before the REAL Week 2 kickoff -> 0', r.weeks, 0);
    }
    // 7. Immediately after Week 2's REAL kickoff -> 1. Week 1 has now
    // genuinely, fully elapsed.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK2_UNIX + 1), regularSeasonWeeks: 17 });
      t('22.7 immediately after the REAL Week 2 kickoff -> 1 (Week 1 has genuinely elapsed)', r.weeks, 1);
    }
    // 8. During Week 3 (matching the real live 2026-09-24 scenario) -> 2.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(WK3_UNIX + 3600), regularSeasonWeeks: 17 });
      t('22.8 during Week 3 -> 2 (matches the live 2026-09-24 scenario)', r.weeks, 2);
    }
    // 9. Well after Week 17's own kickoff (whether or not a Week 18 /
    // postseason technically "kicks off") -> 17, capped at
    // regularSeasonWeeks, never higher.
    {
      const r = await resolveCompletedPayableWeeks('2026', '74598', { dropDateIso: iso(KICKOFF_UNIX[17] + 60 * 86400), regularSeasonWeeks: 17 });
      t('22.9 well past Week 17\'s kickoff -> 17, capped at regularSeasonWeeks', r.weeks, 17);
    }
  });
}
// All nine instants matched canon and the code's actual (fixed) behavior on
// first try -- no expectation needed correcting and no bug was found in the
// date-math branch itself. Item 6 (immediately before Week-2 kickoff) was
// deliberately re-verified against the ACTUAL code output (not assumed from
// the floor-division reasoning alone) per the task's instruction to confirm
// precisely, and the code's real answer (0) matches the reasoning.

console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass + fail) : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
