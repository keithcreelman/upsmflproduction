// Integration-level coverage for the /api/cap-penalty/preview route and the
// /admin/drops/scan-and-record hourly scanner: proves the actual ASYNC
// WIRING around resolveCompletedPayableWeeks / _computeDropPenalty, not just
// the pure formulas (tests/completed_payable_weeks.test.mjs and
// tests/cap_penalty_canon.test.mjs already cover those in isolation).
//
//   node tests/cap_penalty_preview_integration.test.mjs
//
// This repo has no wrangler-dev-backed route-boot harness (checked:
// `grep -rn "wrangler dev" tests/` returns nothing, and worker/package.json's
// "dev" script just runs `wrangler dev` interactively — not usable
// non-interactively in this sandbox). So this file uses the SAME
// text-extraction discipline as tests/completed_payable_weeks.test.mjs and
// tests/cap_penalty_canon.test.mjs, in two parts:
//
//   PART A (static/literal): greps the REAL worker/src/index.js source for
//   the batch-preview route's literal span and proves, from the actual
//   source text (not a reconstruction), that resolveCompletedPayableWeeks(
//   is called exactly ONCE outside the per-player loop -- i.e. the "one
//   call per batch, not per player" property is a structural guarantee of
//   the real file, not just of a test double.
//
//   PART B (executable): extracts the REAL resolveCompletedPayableWeeks +
//   _computeDropPenalty (identical extraction to completed_payable_weeks.
//   test.mjs) and wires them through a small harness that reproduces the
//   preview route's and scanner's ACTUAL call shape (resolve once, then
//   loop calling _computeDropPenalty per player with the shared
//   completedPayableWeeks) with mocked roster/env data, to prove the
//   end-to-end async behavior: await ordering, top-level response fields,
//   uniform failure across all rows, preview/scanner parity, and the
//   "omitted completedPayableWeeks" defense.
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

console.log('\n-- PART A: static proof, from the real source text --');
{
  // The batch preview route's literal span: from where pvWeek1Iso is
  // resolved through the BATCH response's jsonOut call.
  const startMarker = 'const pvWeek1Iso = await _week1BoundaryIsoET(pvSeason);';
  const endMarker = 'count: Object.keys(players).length, players });';
  const i = src.indexOf(startMarker);
  const j = src.indexOf(endMarker, i);
  check('A1. preview route span found in worker/src/index.js', () => {
    assert.ok(i >= 0, 'start marker not found');
    assert.ok(j >= 0, 'end marker not found');
  });
  const span = src.slice(i, j + endMarker.length);

  check('A2. resolveCompletedPayableWeeks( appears exactly ONCE in the preview route span (resolved before the loop, not per-player)', () => {
    const count = (span.match(/resolveCompletedPayableWeeks\(/g) || []).length;
    assert.strictEqual(count, 1, 'expected exactly 1 call, found ' + count);
  });

  check('A3. the per-player loop body calls penaltyFor(pl), not resolveCompletedPayableWeeks, per player', () => {
    const loopStart = span.indexOf('for (const f of frs) {', span.indexOf('const players = {};'));
    assert.ok(loopStart >= 0, 'batch loop not found');
    const loopBody = span.slice(loopStart);
    assert.ok(/penaltyFor\(pl\)/.test(loopBody), 'expected penaltyFor(pl) inside the batch loop');
    assert.ok(!/resolveCompletedPayableWeeks\(/.test(loopBody), 'resolveCompletedPayableWeeks must not be called inside the per-player loop');
  });

  check('A4. top-level response object carries earned_through_week / current_lineup_week / week_authority_source', () => {
    assert.ok(/earned_through_week:\s*pvWeekAuthority\.weeks/.test(span), 'earned_through_week missing from batch response');
    assert.ok(/current_lineup_week:\s*pvCurrentLineupWeek/.test(span), 'current_lineup_week missing from batch response');
    assert.ok(/week_authority_source:\s*pvWeekAuthority\.source/.test(span), 'week_authority_source missing from batch response');
  });

  check('A5. pvWeekAuthority is awaited BEFORE the batch loop builds any player row (real await ordering, not fire-and-forget)', () => {
    const resolveIdx = span.indexOf('await resolveCompletedPayableWeeks(');
    const loopIdx = span.indexOf('const players = {};');
    assert.ok(resolveIdx >= 0 && loopIdx >= 0 && resolveIdx < loopIdx, 'resolve must precede the batch loop in source order');
  });

  // Same static proof for the hourly scanner (/admin/drops/scan-and-record).
  const scanStart = 'const scanWeekAuthority = await resolveCompletedPayableWeeks(targetSeason, leagueId, {';
  const scanLoopMarker = 'for (const drop of drops) {';
  const si = src.indexOf(scanStart);
  const sLoop = src.indexOf(scanLoopMarker, si);
  check('A6. scanner also resolves week authority ONCE, before its per-drop loop', () => {
    assert.ok(si >= 0 && sLoop >= 0 && si < sLoop, 'scanner resolve must precede its per-drop loop');
    const between = src.slice(si, sLoop);
    const count = (between.match(/resolveCompletedPayableWeeks\(/g) || []).length;
    assert.strictEqual(count, 1, 'expected exactly 1 scanner-side call, found ' + count);
  });
}

console.log('\n-- PART B: executable proof, driving the real extracted formula functions through a faithful reconstruction of the route/scanner call shape --');
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
const prelude = `
const safeStr = (v) => v == null ? "" : String(v);
const safeInt = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : (d || 0); };
const _s = (v) => String(v == null ? "" : v).trim();
export let __liveWeekBehavior = { mode: "throw" };
export let __resolveCallCount = { n: 0 };
async function resolveCurrentLineupWeek(season, leagueId) {
  if (__liveWeekBehavior.mode === "throw") throw new Error("no live network in unit test");
  return __liveWeekBehavior.value;
}
async function nflWeekFirstKickoffUnix(season, week) { return 0; }
`;
const mod = prelude + deriveFn + '\n' + resolveAuthFn + '\n' + resolveCompletedFn + '\n' + parseFn + '\n' + compFn +
  '\nexport { resolveCompletedPayableWeeks, _computeDropPenalty };';
fs.writeFileSync('/tmp/_cap_penalty_integration_extracted.mjs', mod);
const { resolveCompletedPayableWeeks, _computeDropPenalty } = await import('/tmp/_cap_penalty_integration_extracted.mjs');
const modImports = await import('/tmp/_cap_penalty_integration_extracted.mjs');
const setLive = (behavior) => { Object.assign(modImports.__liveWeekBehavior, behavior); };

// Wraps resolveCompletedPayableWeeks with a call-counter, mirroring the real
// route/scanner shape: called ONCE per batch/tick, never per player.
function countedResolver() {
  let n = 0;
  return {
    resolve: async (...args) => { n += 1; return resolveCompletedPayableWeeks(...args); },
    count: () => n,
  };
}

// Mock roster: 4 players spanning standard / sub-5K / taxi / a contract
// missing completedPayableWeeks entirely (the "broken caller" case).
const ROSTER = [
  { id: '1', contractStatus: 'Veteran', salary: 13000, contractInfo: 'CL 3| TCV 39K| AAV 13K| Y1-13K, Y2-13K, Y3-13K', contractYear: '3' }, // Brissett-like
  { id: '2', contractStatus: 'Rookie-WW', salary: 1000, contractInfo: 'CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K|GTD: 1K', contractYear: '3' }, // Strand-like
  { id: '3', contractStatus: 'Veteran', salary: 5000, contractInfo: 'CL 2| TCV 10K| AAV 5K| Y1-5K, Y2-5K', contractYear: '2', isTaxi: true },
];

// Faithful reconstruction of the PREVIEW route's batch shape (worker/src/
// index.js ~line 50995-51101): resolve week authority ONCE, build pvOpts
// with completedPayableWeeks, then loop calling _computeDropPenalty per
// player through that shared opts object — never re-resolving per player.
async function runPreviewBatch(roster, { liveBehavior, dropDateIso }) {
  // Mirrors the real route: `const pvDropIso = url.searchParams.get("drop_date")
  // || new Date().toISOString();` -- dropDateIso is NEVER undefined in the
  // real preview handler, so this harness must not pass undefined either
  // (doing so used to skip _parseContractData's in-season earned branch
  // entirely, a harness bug -- fixed here, not a bug in the real code).
  const effectiveDropIso = dropDateIso || new Date().toISOString();
  setLive(liveBehavior);
  const counted = countedResolver();
  const weekAuthority = await counted.resolve('2026', '74598', {
    dropDateIso: effectiveDropIso, week1ThursdayIso: undefined, regularSeasonWeeks: 17,
  });
  const opts = { season: '2026', dropDateIso: effectiveDropIso, completedPayableWeeks: weekAuthority.weeks };
  const players = {};
  for (const p of roster) {
    players[p.id] = _computeDropPenalty(
      { contractStatus: p.contractStatus, salary: p.salary, contractInfo: p.contractInfo, contractYear: p.contractYear, isTaxi: !!p.isTaxi },
      { ...opts }
    );
  }
  return {
    ok: true, earned_through_week: weekAuthority.weeks, week_authority_source: weekAuthority.source,
    players, resolverCallCount: counted.count(),
  };
}

// Same shape for the scanner (worker/src/index.js ~line 50031-50071).
async function runScannerTick(roster, { liveBehavior, dropDateIso }) {
  setLive(liveBehavior);
  const counted = countedResolver();
  const weekAuthority = await counted.resolve('2026', '74598', {
    week1ThursdayIso: undefined, regularSeasonWeeks: 17,
  });
  const results = {};
  for (const p of roster) {
    results[p.id] = _computeDropPenalty(
      { contractStatus: p.contractStatus, salary: p.salary, contractInfo: p.contractInfo, contractYear: p.contractYear, isTaxi: !!p.isTaxi },
      { season: '2026', dropDateIso, acquisitionWeek: undefined, completedPayableWeeks: weekAuthority.weeks }
    );
  }
  return { weekAuthority, results, resolverCallCount: counted.count() };
}

console.log('\n-- B1. resolveCompletedPayableWeeks is awaited before building any row; one call per batch --');
{
  const batch = await runPreviewBatch(ROSTER, { liveBehavior: { mode: 'value', value: { week: 4, source: 'live_scoring' } }, dropDateIso: undefined });
  t('B1a. resolver called exactly once for a 3-player batch', batch.resolverCallCount, 1);
  t('B1b. earned_through_week reaches the top-level response', batch.earned_through_week, 3);
  t('B1c. week_authority_source reaches the top-level response', batch.week_authority_source, 'live_scoring_authority');
  check('B1d. every player row was built using the SAME resolved week count (not independently re-resolved)', () => {
    assert.strictEqual(batch.players['1'].currentYearEarned, Math.round(13000 * 3 / 17));
    assert.strictEqual(batch.players['2'].currentYearEarned, Math.round(1000 * 3 / 17));
  });
}

console.log('\n-- B2. live resolver fails -> every row NOT already exempt on an earlier basis shows week_authority_unresolved, uniformly --');
{
  const batch = await runPreviewBatch(ROSTER, { liveBehavior: { mode: 'throw' }, dropDateIso: undefined });
  // pid 3 is isTaxi: true -- _computeDropPenalty's taxi_exempt check runs
  // BEFORE the week_authority_unresolved check (worker/src/index.js, "1.6
  // Week-authority could not be resolved..." comment: "Placed AFTER
  // taxi/unstamped-contract checks (those are legitimate $0/exempt outcomes
  // that don't depend on earned salary)"), so a taxi player legitimately
  // stays taxi_exempt regardless of week-authority resolution -- this is
  // documented, intentional priority ordering, not a partial-mix bug. Only
  // pids 1/2 (non-exempt, in-season-dependent) must show the unresolved
  // basis uniformly.
  check('B2. every non-exempt row uniformly unresolved (no non-exempt row silently priced)', () => {
    for (const pid of ['1', '2']) {
      assert.strictEqual(batch.players[pid].basis, 'week_authority_unresolved', `pid ${pid} basis=${batch.players[pid].basis}`);
      assert.strictEqual(batch.players[pid].needs_review, true, `pid ${pid} needs_review not true`);
      assert.strictEqual(batch.players[pid].penalty, null, `pid ${pid} penalty not null`);
    }
  });
  t('B2b. the taxi row correctly stays taxi_exempt (pre-existing, documented priority — not affected by the unresolved authority)', batch.players['3'].basis, 'taxi_exempt');
  t('B2c. top-level earned_through_week is null too (fails closed at the batch level, not just per-row)', batch.earned_through_week, null);
}

console.log('\n-- B3. preview and scanner produce IDENTICAL {earned,guaranteed,penalty,basis} given the same inputs --');
{
  const liveBehavior = { mode: 'value', value: { week: 4, source: 'live_scoring' } };
  const preview = await runPreviewBatch(ROSTER, { liveBehavior, dropDateIso: undefined });
  const scanner = await runScannerTick(ROSTER, { liveBehavior, dropDateIso: '2026-09-24T12:00:00Z' });
  for (const pid of ['1', '2', '3']) {
    t('B3. pid ' + pid + ' preview vs scanner {earned,guaranteed,penalty,basis}',
      { earned: preview.players[pid].earned, guaranteed: preview.players[pid].guaranteed, penalty: preview.players[pid].penalty, basis: preview.players[pid].basis },
      { earned: scanner.results[pid].earned, guaranteed: scanner.results[pid].guaranteed, penalty: scanner.results[pid].penalty, basis: scanner.results[pid].basis });
  }
}

console.log('\n-- B4. a caller that forgets to pass completedPayableWeeks through can never silently produce a wrong number --');
{
  // Simulates a "deliberately broken" caller: dropDateIso set (in-season
  // pricing requested) but completedPayableWeeks OMITTED entirely -- the
  // exact bug shape this pass's fail-closed design exists to make
  // structurally impossible.
  const broken = _computeDropPenalty(
    { contractStatus: 'Veteran', salary: 13000, contractInfo: 'CL 3| TCV 39K| AAV 13K| Y1-13K, Y2-13K, Y3-13K', contractYear: '3' },
    { season: '2026', dropDateIso: '2026-09-24T00:00:00Z' } // completedPayableWeeks NOT passed
  );
  check('B4. omitted completedPayableWeeks -> week_authority_unresolved, never a guessed earned/penalty number', () => {
    assert.strictEqual(broken.basis, 'week_authority_unresolved');
    assert.strictEqual(broken.needs_review, true);
    assert.strictEqual(broken.penalty, null);
    assert.strictEqual(broken.guaranteed, null);
  });
}

console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass + fail) : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
