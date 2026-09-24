// Front Office EARNED / Drop Penalty — single-authority fix.
//   node tests/front_office_earned_authority.test.mjs
//
// Desktop Front Office (site/rosters/v2/front_office.js) used to reproduce
// the earned-salary / drop-penalty formula locally (proratedEarnedForDrop /
// earnedBeforeCurrentContractYear / earnedToDateBreakdownForPlayer — a
// calendar-milestone approximation) instead of calling the worker's
// authoritative /api/cap-penalty/preview (worker/src/index.js
// _computeDropPenalty). This file has two halves:
//   1. WORKER FORMULA — extracted verbatim (text extraction, not import,
//      same technique as tests/cap_penalty_canon.test.mjs) and exercised
//      against the exact screenshot-player numbers from the audit.
//   2. DESKTOP WIRING — static source checks on site/rosters/v2/front_office.js
//      confirming the single-request batch, player-id join, fail-closed
//      behavior, and zero-vs-unavailable render split actually landed.
//
// UPDATED (completed-payable-week correction pass): _parseContractData no
// longer does its own inline Week-1-boundary date math — it now requires a
// precomputed opts.completedPayableWeeks (see tests/completed_payable_weeks
// .test.mjs for the resolver itself, resolveCompletedPayableWeeks, and its
// boundary table). Every call below that used to pass only
// {dropDateIso, week1ThursdayIso} now also passes completedPayableWeeks
// explicitly. Section 2 (DESKTOP WIRING) is also updated: the prior pass's
// separate /api/current-lineup-week fetch inside loadCapPenaltyPreview() is
// GONE — the "Through Week N" label and the dollar figures now come off the
// SAME /api/cap-penalty/preview response (payload.earned_through_week).
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

// ── Extract the worker's authoritative functions (verbatim text extraction) ──
const src = fs.readFileSync('worker/src/index.js', 'utf8');
function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for ' + startMarker);
  return src.slice(i, j + endMarker.length);
}
const parseFn = grab('const _parseContractData =', 'return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned, weekAuthorityUnresolved };\n        };');
const compFn = grab('const _computeDropPenalty =', 'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };');
const prelude = `
const safeStr=(v)=>v==null?"":String(v);
const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);};
const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=(year)=>{const y=Number(year)||0;if(!y)return "";const sept1=new Date(Date.UTC(y,8,1));const firstMonday=1+((8-sept1.getUTCDay())%7);const kickoff=new Date(Date.UTC(y,8,firstMonday+3));return kickoff.toISOString().slice(0,10);};
`;
fs.writeFileSync('/tmp/_fo_earned_extracted.mjs', prelude + parseFn + '\n' + compFn + '\nexport {_computeDropPenalty, _parseContractData};');
const { _computeDropPenalty, _parseContractData } = await import('/tmp/_fo_earned_extracted.mjs');

// 2026 real Week-1 boundary (verified live: 2026 opens Wednesday Sep 9) and a
// drop instant inside Week 3 (2026-09-24, "today" for this correction pass) —
// resolveCompletedPayableWeeks resolves that instant to exactly 2 completed
// weeks (see tests/completed_payable_weeks.test.mjs's boundary-table tests
// 4/5 for the resolver itself). completedPayableWeeks is passed directly
// here since _parseContractData no longer derives it inline.
const WK1 = '2026-09-09';
const WEEK3_INPROGRESS = '2026-09-24T00:00:00Z';
const PRESEASON = '2026-08-15T00:00:00Z';
const TWO_COMPLETED_WEEKS = 2;

const stdContract = (salary) => ({
  contractStatus: 'Veteran', salary,
  contractInfo: `CL 3| TCV ${Math.round(salary * 3 / 1000)}K| AAV ${Math.round(salary / 1000)}K| Y1-${Math.round(salary / 1000)}K, Y2-${Math.round(salary / 1000)}K, Y3-${Math.round(salary / 1000)}K`,
  contractYear: '3',
});

console.log('\n-- 1. preseason = $0 (completedPayableWeeks not needed pre-kickoff) --');
{
  const r = _computeDropPenalty(stdContract(13000), { dropDateIso: PRESEASON, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: 0 });
  t('Brissett, before Week 1 kickoff, earned=$0', r.earned, 0);
}

console.log('\n-- 2. Week 3 in progress = two completed weeks (not three) --');
{
  const r = _computeDropPenalty(stdContract(13000), { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  // Exact = 13000*2/17 = 1529.41 -> rounds to 1529, confirming 2 completed
  // weeks are used, not the in-progress week's own partial credit (the old
  // bug's "+1" would have used 3 and produced 2294).
  t('earned at 2 completed weeks, not 3 (pre-fix bug value)', r.earned, 1529);
  assert.notStrictEqual(r.earned, Math.round(13000 * 3 / 17), 'must not reproduce the old +1 bug (round(salary*3/17)=2294)');
}

console.log('\n-- 3/4/5. screenshot players: exact calc, rounded ONCE at the end --');
{
  const cases = [['Brissett', 13000, 1529], ['Murray', 32000, 3765], ['Prescott', 63000, 7412]];
  for (const [name, salary, want] of cases) {
    const r = _computeDropPenalty(stdContract(salary), { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
    t(name + ' earned = round(salary*2/17)', r.earned, want);
  }
  // Guard against the wrong "round-then-multiply" shortcut: Brissett is the
  // case where round(salary/17)*2 ($765*2=$1,530) diverges from the correct
  // round(salary*2/17) ($1,529).
  const brissett = _computeDropPenalty(stdContract(13000), { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  assert.notStrictEqual(brissett.earned, Math.round(13000 / 17) * 2, 'Brissett must not be (round(weekly) * weeks) = $1,530');
}

console.log('\n-- 6. sub-$5K contract: flat $1K/$0, never a drifting fraction --');
{
  const sub = (cy) => _computeDropPenalty({ contractStatus: 'Veteran', salary: 1000,
    contractInfo: 'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K', contractYear: String(cy) },
    { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  t('CL3 $1K/yr, 2 yrs remaining -> flat $1K penalty', sub(2).penalty, 1000);
  t('CL3 $1K/yr, final year -> cap-free $0', sub(1).penalty, 0);
}

console.log('\n-- 7. waiver acquisition denominator (18-W, not 17) --');
{
  // Picked up Week 5, 2 completed weeks so far — but he wasn't active until
  // Week 5, so his own numerator is capped at 0 completed-eligible weeks.
  // Isolate the denominator with a later drop instant instead: 6 completed
  // weeks total, Week-5 acquisition -> completedEligible = 6-(5-1) = 2 of 13.
  const salary = 13000;
  const r5 = _computeDropPenalty(stdContract(salary),
    { dropDateIso: '2026-10-22T00:00:00Z', week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: 6, acquisitionWeek: 5 });
  t('Week-5 pickup: eligible = 18-5 = 13, earned = round(salary*2/13)', r5.earned, Math.round(salary * 2 / 13));
  // A continuing/auction player (acquisitionWeek=1) at the same 6 completed
  // weeks uses the full 17-week denominator instead.
  const r1 = _computeDropPenalty(stdContract(salary),
    { dropDateIso: '2026-10-22T00:00:00Z', week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: 6, acquisitionWeek: 1 });
  t('continuing player: eligible = 17, earned = round(salary*6/17)', r1.earned, Math.round(salary * 6 / 17));
  // Compare PER completed week (numerators differ: 2 vs 6), not the raw
  // totals — the shrunken 13-week denominator earns MORE per completed week
  // than the continuing player's 17-week one.
  assert.ok((r5.earned / 2) > (r1.earned / 6), 'the Week-5 pickup\'s shrunken 13-week denominator earns MORE per completed week than the continuing player\'s 17-week one');
}

console.log('\n-- 8. multi-year prior earnings (completed contract years count in full) --');
{
  // Year 2 of a 3-year deal, front-loaded 40/30/20 (mirrors the canon worked
  // example already asserted in cap_penalty_canon.test.mjs): prior earned =
  // Y1 = 40000 in full, regardless of in-season current-year fraction.
  const r = _computeDropPenalty({ contractStatus: 'Veteran', salary: 30000,
    contractInfo: 'CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K', contractYear: '2' },
    { dropDateIso: PRESEASON, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: 0 });
  t('prior year (Y1) counted in full before any current-year accrual', r.priorEarned, 40000);
}

console.log('\n-- 9. loaded/front-loaded contract uses CURRENT YEAR salary, not AAV --');
{
  const r = _parseContractData({ contractInfo: 'CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K', salary: 30000, contractYear: '2' },
    { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  // In year 2, current-year salary should be Y2's actual $30K, not AAV ($30K
  // here coincidentally equal — assert against the DISTINCT front-loaded Y1
  // figure to prove it isn't reading Y1/AAV by accident).
  t('currentYearEarned uses Y2 ($30K), round(30000*2/17)', r.currentYearEarned, Math.round(30000 * 2 / 17));
}

console.log('\n-- 10. trade does not reset accrual (formula has no ownership/franchise input) --');
{
  check('_computeDropPenalty signature carries no franchise/owner field', () => {
    assert.ok(!/franchise|owner/i.test(compFn.split('\n')[0]), 'destructured input must not key off franchise/ownership');
  });
  // Same contract computed twice (simulating pre- and post-trade calls) must
  // be byte-identical — accrual depends only on contractInfo/salary/date.
  const a = _computeDropPenalty(stdContract(13000), { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  const b = _computeDropPenalty(stdContract(13000), { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  t('identical contract earns identically regardless of "which franchise asked"', a.earned, b.earned);
}

console.log('\n-- 11. IR continues accrual (no IR-specific branch in the formula) --');
{
  check('no isIr / IR gate inside _computeDropPenalty', () => {
    assert.ok(!/isIr|IR_STATUS|"IR"/.test(compFn), '_computeDropPenalty must not special-case IR — earned keeps accruing on IR');
  });
}

console.log('\n-- 12. taxi: earned still reported, but penalty is exempt $0 --');
{
  const r = _computeDropPenalty({ ...stdContract(13000), isTaxi: true }, { dropDateIso: WEEK3_INPROGRESS, week1ThursdayIso: WK1, season: '2026', completedPayableWeeks: TWO_COMPLETED_WEEKS });
  t('taxi penalty is exempt $0', r.penalty, 0);
  t('taxi basis is taxi_exempt', r.basis, 'taxi_exempt');
  t('taxi still reports a real earned figure (not suppressed to 0)', r.earned, 1529);
}

console.log('\n-- 12b. week authority unresolved fails closed inside _computeDropPenalty --');
{
  const r = _computeDropPenalty(stdContract(13000), { dropDateIso: WEEK3_INPROGRESS, season: '2026' }); // no completedPayableWeeks supplied
  t('missing completedPayableWeeks -> basis week_authority_unresolved', r.basis, 'week_authority_unresolved');
  t('missing completedPayableWeeks -> needs_review true', r.needs_review, true);
  t('missing completedPayableWeeks -> penalty null, NOT a guessed $0', r.penalty, null);
}

console.log('\n-- 13/14. unresolved authority fails closed; API failure never falls back to the retired formula --');
{
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  const dpeFn = (() => {
    const i = foSrc.indexOf('function dropPenaltyEstimate(player) {');
    assert.ok(i > 0, 'dropPenaltyEstimate not found');
    // Grab up to the matching closing brace at column 2 (`  }`), same
    // technique as the desktop file's own well-formed function bodies.
    const j = foSrc.indexOf('\n  }', i);
    return foSrc.slice(i, j);
  })();
  check('dropPenaltyEstimate reads STATE.capPenaltyByPid, not a local formula', () => {
    assert.ok(/STATE\.capPenaltyByPid/.test(dpeFn), 'must read the authoritative cache');
  });
  check('error/pending states return NaN, never a computed guess', () => {
    assert.ok(/earnedState:\s*"unavailable"/.test(dpeFn), 'must have an explicit unavailable state');
    assert.ok(/amount:\s*NaN,\s*earned:\s*NaN/.test(dpeFn), 'unavailable/pending must not synthesize a number');
  });
  check('no call to the retired local calc functions inside dropPenaltyEstimate', () => {
    assert.ok(!/earnedToDateBreakdownForPlayer\(/.test(dpeFn), 'must not fall back to the calendar-milestone formula');
    assert.ok(!/proratedEarnedForDrop\(/.test(dpeFn), 'must not fall back to the calendar-milestone formula');
  });
  check('a week_authority_unresolved row renders unavailable, not $0', () => {
    assert.ok(/week_authority_unresolved/.test(dpeFn), 'dropPenaltyEstimate must recognize the unresolved-authority basis and treat it as unavailable');
  });
}

console.log('\n-- 15. legitimate zero differs from unavailable in the render --');
{
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  check('earned cell branches on earnedState, not `earned > 0`', () => {
    assert.ok(!/drop\.earned > 0 \? fmtUSD\(drop\.earned\) : "—"/.test(foSrc),
      'the old zero/unavailable-conflating condition must be gone');
    assert.ok(/drop\.earnedState === "ok" \? fmtUSD\(drop\.earned\)/.test(foSrc),
      'earned cell must render off earnedState');
  });
}

console.log('\n-- 16. one batched request, not per-player, and NO separate current-lineup-week fetch --');
{
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  check('loadCapPenaltyPreview fetches once with no player_id (BATCH mode)', () => {
    assert.ok(/loadCapPenaltyPreview/.test(foSrc), 'loader must exist');
    const fnStart = foSrc.indexOf('async function loadCapPenaltyPreview()');
    const fnBody = foSrc.slice(fnStart, foSrc.indexOf('\n  }', fnStart));
    assert.ok(/cap-penalty\/preview/.test(fnBody), 'must call the preview endpoint');
    assert.ok(!/player_id/.test(fnBody), 'BATCH call must omit player_id — one request for the whole roster');
    // The prior pass's separate /api/current-lineup-week fetch is now GONE —
    // earned_through_week / current_lineup_week come off the SAME preview
    // response (payload.earned_through_week / payload.current_lineup_week).
    assert.ok(!/fetchJSON\(apiUrl\("\/api\/current-lineup-week"\)/.test(fnBody), 'loadCapPenaltyPreview must no longer fetch /api/current-lineup-week separately — one response now carries both the dollars and the week');
    assert.ok(/earned_through_week/.test(fnBody), 'must read payload.earned_through_week from the single preview response');
  });
  check('init() calls loadCapPenaltyPreview exactly once per page load', () => {
    const m = foSrc.match(/(?<!async function )loadCapPenaltyPreview\(\)/g) || [];
    assert.strictEqual(m.length, 1, 'expected exactly one call site (excluding the definition), got ' + m.length);
  });
  check('renderEarnedThroughWeekLabel reads STATE.earnedThroughWeek, not STATE.currentLineupWeek - 1', () => {
    const fnStart = foSrc.indexOf('function renderEarnedThroughWeekLabel()');
    const fnBody = foSrc.slice(fnStart, foSrc.indexOf('\n  }', fnStart));
    assert.ok(/STATE\.earnedThroughWeek/.test(fnBody), 'label must read the single-source earnedThroughWeek field');
  });
}

console.log('\n-- 17. player-ID mapping, never name-based --');
{
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  const fnStart = foSrc.indexOf('function dropPenaltyEstimate(player) {');
  const fnBody = foSrc.slice(fnStart, foSrc.indexOf('\n  }', fnStart));
  check('joins the cap-penalty cache by player.id, not player.name', () => {
    assert.ok(/player && player\.id/.test(fnBody), 'must read player.id');
    assert.ok(!/player\.name/.test(fnBody), 'must not key the join off player.name');
  });
}

console.log('\n-- 18. desktop displayed penalty equals the worker preview response shape --');
{
  // The worker's batch payload shape (players[pid] = {penalty, guaranteed,
  // earned, ...}) must be exactly what dropPenaltyEstimate consumes field
  // for field, so "desktop shows X" and "worker returned X" can never drift
  // by a renamed/misread key.
  const workerRoute = grab('if (path === "/api/cap-penalty/preview" && request.method === "GET") {',
    'return jsonOut(200, { ok: true, season: pvSeason, league_id: pvLeague,\n            current_lineup_week: pvCurrentLineupWeek, earned_through_week: pvWeekAuthority.weeks,\n            week_authority_source: pvWeekAuthority.source, calculated_at: new Date().toISOString(),\n            count: Object.keys(players).length, players });');
  for (const field of ['penalty', 'guaranteed', 'earned', 'tcv', 'exempt', 'exempt_reason', 'basis']) {
    check('worker batch response includes field "' + field + '"', () => {
      assert.ok(new RegExp(field + ':').test(workerRoute), 'penaltyFor() must return ' + field);
    });
  }
  check('worker batch response top-level carries earned_through_week / current_lineup_week / week_authority_source', () => {
    assert.ok(/earned_through_week: pvWeekAuthority\.weeks/.test(workerRoute), 'must expose earned_through_week');
    assert.ok(/current_lineup_week: pvCurrentLineupWeek/.test(workerRoute), 'must expose current_lineup_week');
    assert.ok(/week_authority_source: pvWeekAuthority\.source/.test(workerRoute), 'must expose week_authority_source');
  });
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  const fnStart = foSrc.indexOf('function dropPenaltyEstimate(player) {');
  const fnBody = foSrc.slice(fnStart, foSrc.indexOf('\n  }', fnStart));
  for (const field of ['cap.penalty', 'cap.guaranteed', 'cap.earned', 'cap.exempt']) {
    check('desktop reads worker field ' + field, () => {
      assert.ok(fnBody.includes(field), 'dropPenaltyEstimate must read ' + field);
    });
  }
}

console.log('\n-- 19. sorting/rerendering does not refetch or lose values --');
{
  const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
  check('applySort reads dropPenaltyEstimate() (sync, cache-backed) not a fetch', () => {
    const i = foSrc.indexOf('function applySort(rows) {');
    const body = foSrc.slice(i, foSrc.indexOf('\n  }', i));
    assert.ok(/dropPenaltyEstimate\(/.test(body), 'sort key must read the same sync estimate');
    assert.ok(!/fetch\(/.test(body), 'sorting must never trigger a network request');
  });
  check('unavailable (NaN) earned/drop_pen values always sort last', () => {
    const i = foSrc.indexOf('function applySort(rows) {');
    const body = foSrc.slice(i, foSrc.indexOf('\n  }', i));
    assert.ok(/aBad && bBad/.test(body) && /return 1;/.test(body), 'must special-case NaN to sort last both directions');
  });
  check('GTD sort key now reads the authoritative dropPenaltyEstimate().guaranteed, not a local re-parse', () => {
    const i = foSrc.indexOf('function applySort(rows) {');
    const body = foSrc.slice(i, foSrc.indexOf('\n  }', i));
    assert.ok(/key === "gtd".*dropPenaltyEstimate\(a\)\.guaranteed/.test(body), 'gtd sort must use dropPenaltyEstimate(...).guaranteed');
  });
}

console.log('\n-- 20. existing Front Office behavior intact (syntax + baseline suite) --');
{
  check('front_office.js is still syntactically valid', () => {
    // node --check is run separately by the harness; here we just confirm
    // the file parses as a function body via the Function constructor,
    // catching an unbalanced brace introduced by this patch.
    const foSrc = fs.readFileSync('site/rosters/v2/front_office.js', 'utf8');
    new Function(foSrc); // throws SyntaxError on malformed JS
  });
}

console.log('\n' + (fail ? 'FAILURES: ' + fail + ' / ' + (pass + fail) : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
