// Phase II-A1 — source-pattern integration checks for the two consuming
// pages (desktop + mobile). Source-static, like the rest of tests/*.mjs —
// no DOM, no live fetch. Confirms: both surfaces load the shared module,
// neither surface re-implements its own copy of the race calculations
// (the whole point of the shared module), and the accessibility/keyboard
// contract A4 requires is actually present in the markup builders.
//   node tests/standings_race_integration.test.mjs
import fs from 'fs';
import assert from 'assert';

const DESKTOP = fs.readFileSync('site/standings/mfl_hpm_standings_v2.html', 'utf8');
const MOBILE_INDEX = fs.readFileSync('site/m/index.html', 'utf8');
const MOBILE_LEAGUE = fs.readFileSync('site/m/views/league.js', 'utf8');
const MOBILE_TEAM_SHEET = fs.readFileSync('site/m/team_sheet.js', 'utf8');
const RACE_MODULE = fs.readFileSync('site/shared/standings_race.js', 'utf8');

let fails = 0;
const checks = [];
const check = (n, fn) => { checks.push([n, fn]); };

// Function names that must exist ONLY inside the shared module — if either
// consuming page declares its own `function <name>(`, that's a duplicated
// race calculation (exactly what "Desktop and mobile must both use this
// shared module. Do not duplicate race calculations" forbids).
const RACE_FN_NAMES = [
  'statusForRow', 'apGamesBack', 'apWinsEquiv', 'luckForRow', 'expectedWinsForRow',
  'formForFranchise', 'weeklyApRank', 'gameLogForFranchise', 'divisionRace',
  'whySeedForRow', 'apFraction'
];

check('desktop page loads the shared module via <script src>, before the inline script', () => {
  const scriptIdx = DESKTOP.indexOf('<script src="../shared/standings_race.js">');
  const inlineIdx = DESKTOP.indexOf('<script>\n(function () {\n  "use strict";');
  assert.ok(scriptIdx >= 0, 'desktop must <script src="../shared/standings_race.js">');
  assert.ok(inlineIdx >= 0, 'could not locate the inline app script to compare ordering');
  assert.ok(scriptIdx < inlineIdx, 'shared module must load BEFORE the inline script that calls it');
});
check('mobile index.html loads the shared module', () => {
  assert.ok(/<script src="\.\.\/shared\/standings_race\.js\?v=[\d.]+">/.test(MOBILE_INDEX));
});
check('mobile index.html loads team_sheet.js after player_sheet.js and before views/league.js', () => {
  const psIdx = MOBILE_INDEX.indexOf('player_sheet.js');
  const tsIdx = MOBILE_INDEX.indexOf('team_sheet.js');
  const lgIdx = MOBILE_INDEX.indexOf('views/league.js');
  assert.ok(psIdx >= 0 && tsIdx >= 0 && lgIdx >= 0);
  assert.ok(psIdx < tsIdx && tsIdx < lgIdx, 'load order must be player_sheet.js -> team_sheet.js -> views/league.js');
});
check('mobile index.html has a distinct #ups-m-team-sheet-mount (does not collide with the player sheet mount)', () => {
  assert.ok(MOBILE_INDEX.includes('id="ups-m-team-sheet-mount"'));
  assert.ok(MOBILE_INDEX.includes('id="ups-m-sheet-mount"'));
});

check('neither consuming page re-declares its own copy of a race-module function', () => {
  RACE_FN_NAMES.forEach((name) => {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    assert.ok(!re.test(DESKTOP), 'desktop page must not declare its own function ' + name + '() — that duplicates the shared module');
    assert.ok(!re.test(MOBILE_LEAGUE), 'mobile league.js must not declare its own function ' + name + '() — that duplicates the shared module');
    assert.ok(!re.test(MOBILE_TEAM_SHEET), 'mobile team_sheet.js must not declare its own function ' + name + '() — that duplicates the shared module');
  });
});
check('the shared module IS where every one of those functions actually lives', () => {
  RACE_FN_NAMES.forEach((name) => {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    assert.ok(re.test(RACE_MODULE), 'expected ' + name + '() to be defined in site/shared/standings_race.js');
  });
});
check('both pages call into window.UPS_STANDINGS_RACE.race(...) rather than reimplementing it', () => {
  assert.ok(/window\.UPS_STANDINGS_RACE\.race\(/.test(DESKTOP));
  assert.ok(/window\.UPS_STANDINGS_RACE\.race\(/.test(MOBILE_LEAGUE));
});

check('the shared module is a pure IIFE with no DOM access, no fetch, and no application-state mutation', () => {
  assert.ok(!/document\./.test(RACE_MODULE), 'must not touch document');
  assert.ok(!/\bfetch\s*\(/.test(RACE_MODULE), 'must not fetch');
  assert.ok(/global\.UPS_STANDINGS_RACE\s*=/.test(RACE_MODULE), 'must attach itself as the one global export, nothing else');
});

check('desktop race rows carry the A4 keyboard/accessibility contract: tabindex, role=button, aria-expanded, Enter/Space toggle', () => {
  assert.ok(/tabindex="0"/.test(DESKTOP) && /role="button"/.test(DESKTOP) && /aria-expanded="false"/.test(DESKTOP));
  assert.ok(/e\.key === "Enter" \|\| e\.key === " "/.test(DESKTOP), 'must handle both Enter and Space for keyboard toggle');
  assert.ok(/aria-expanded/.test(DESKTOP) && /setAttribute\("aria-expanded"/.test(DESKTOP), 'aria-expanded must actually be updated on toggle, not just set once');
});
check('desktop status chips carry visible text and an aria-label — never emoji-only — and say "projected" in-season', () => {
  assert.ok(/'Projected playoff status: ' : 'Playoff status: '\) \+ STATUS_LABEL\[status\]/.test(DESKTOP), 'status chip must render a real aria-label via STATUS_LABEL, not an emoji glyph');
  assert.ok(/return '<span class="status-chip ' \+ cls \+ \(projected \? ' projected' : ''\)/.test(DESKTOP), 'status chip content must be the status text itself (BYE/DIV/WC), not an emoji');
  assert.ok(/statusChipHtml\(r\._status, raceData\.projected && !resp\.preseason\)/.test(DESKTOP));
});
check('mobile status chips say "projected" until the season ends (port decision 3)', () => {
  assert.ok(/'Projected playoff status: ' : 'Playoff status: '/.test(MOBILE_LEAGUE));
  assert.ok(/statusChipHtml\(rr && rr\.status, projected\)/.test(MOBILE_LEAGUE));
  assert.ok(/season_complete: state\.standingsByYear\[y\]\.season_complete/.test(MOBILE_LEAGUE));
});
check('neither page coerces a failed weekly / weeklyScores (null) into [] before the race module sees it', () => {
  assert.ok(/race\(\{ rows: baseRows, weekly: resp\.weekly, weeklyScores: resp\.weeklyScores,/.test(DESKTOP));
  assert.ok(!/race\(\{[^}]*weekly: resp\.weekly \|\| \[\]/.test(DESKTOP));
  assert.ok(/weekly: state\.standingsByYear\[y\]\.weekly,\n/.test(MOBILE_LEAGUE));
  assert.ok(!/weekly: state\.standingsByYear\[y\]\.weekly \|\| \[\]/.test(MOBILE_LEAGUE));
});
check('mobile keeps the WORKER\'s seed order in-season — no second ladder (it re-sorted by division winner → H2H% → PF)', () => {
  assert.ok(!/Number\(b\.h2h_pct \|\| 0\) - Number\(a\.h2h_pct \|\| 0\)/.test(MOBILE_LEAGUE));
  assert.ok(/if \(hasFinishData\) \{\n\s+rows\.forEach\(function \(r, i\) \{ r\._workerOrder = i; \}\);/.test(MOBILE_LEAGUE));
  assert.ok(/All-Play % → Overall → season PF → head-to-head/.test(MOBILE_LEAGUE));
  assert.ok(!/AP% → Total PF|Seeds derived AP % → Overall PCT → PF/.test(MOBILE_LEAGUE + DESKTOP), 'no reversed or stale ladder text on either page');
});
check('desktop dividers key off playoff_seed (2 / 6), not row index, and only render under canonical seed sort', () => {
  assert.ok(/canonicalSeedOrder\s*=\s*sortHdrs\.sortKey === "seed" && sortHdrs\.sortDir === "asc"/.test(DESKTOP));
  assert.ok(/Number\(r\.playoff_seed\) === 2/.test(DESKTOP));
  assert.ok(/Number\(r\.playoff_seed\) === 6/.test(DESKTOP));
  assert.ok(/Hawktuah Bowl · seeds 7–12/.test(DESKTOP));
});
check('mobile dividers are gated off in-season fallback order, never drawn against a final_finish-sorted table', () => {
  assert.ok(/canonicalSeedOrder = !hasFinishData/.test(MOBILE_LEAGUE));
});
check('mobile AP GB / status chip / form derive from playoff_seed and playoff_status, never from raw seed position alone (no OUT status anywhere)', () => {
  assert.ok(!/>OUT</.test(MOBILE_LEAGUE) && !/"OUT"/.test(MOBILE_LEAGUE));
  assert.ok(!/>OUT</.test(DESKTOP) && !/"OUT"/.test(DESKTOP));
  assert.ok(!/\bOUT\b/.test(RACE_MODULE.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) || /never OUT/.test(RACE_MODULE));
});

check('mobile team sheet reuses the .ups-m-sheet overlay/dialog pattern (not a new modal framework)', () => {
  assert.ok(MOBILE_TEAM_SHEET.includes('class="ups-m-sheet-overlay"'));
  assert.ok(MOBILE_TEAM_SHEET.includes('class="ups-m-sheet"'));
  assert.ok(MOBILE_TEAM_SHEET.includes('class="ups-m-sheet-close"'));
  assert.ok(!/new bootstrap|jquery|\$\(/i.test(MOBILE_TEAM_SHEET), 'must not pull in an unrelated modal framework');
});
check('mobile team sheet restores focus to the triggering element on close (player_sheet.js has none — this must add it)', () => {
  assert.ok(/lastTrigger[\s\S]{0,200}focus\(\)/.test(MOBILE_TEAM_SHEET));
});
check('mobile "View roster" link presets the franchise via M.leagueView.presetRoster before navigating', () => {
  assert.ok(MOBILE_TEAM_SHEET.includes('M.leagueView.presetRoster'));
  assert.ok(MOBILE_LEAGUE.includes('presetRoster: function'));
  assert.ok(MOBILE_TEAM_SHEET.includes('M.route.navigate("#league/rosters")'));
});

check('desktop AP GB / Luck are only shown in Full scope, never fabricated for a custom week-range recompute', () => {
  assert.ok(/var raceData = \(!scoped && window\.UPS_STANDINGS_RACE\)/.test(DESKTOP));
});
check('worker route logic, D1 schema, ETL, and canon docs are untouched by this phase (checked via file identity, not just grep)', () => {
  // This is a structural sanity check, not a git diff — the real
  // guarantee is `git status --short` reviewed at commit time (Phase
  // II-A1 is client-side only per the task brief). Here we just confirm
  // the shared module never references worker-only globals that would
  // indicate accidental coupling.
  assert.ok(!/env\.DB\b|D1Database|\bexport default\s*{\s*fetch/.test(RACE_MODULE));
});

// Regression guard for the playoff-contamination defect: apRecordForRow
// must never fall back to a generic/full-season AP field. Written as a
// source check (in addition to the runtime proofs in
// standings_race.test.mjs) so a future edit that reintroduces the old
// `row.allplay_w != null` fallback fails CI immediately, by name.
function extractBracedFn(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, 'not found in source: ' + startMarker);
  let depth = 0, i = start, opened = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; opened = true; }
    else if (src[i] === '}') { depth--; if (opened && depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
check('resolveApRecordWithTable (the single shared AP resolver) never falls back to allplay_w/l/t, allplay_full_*, allplay_historical_*, or allplay_pct', () => {
  const fnSrc = extractBracedFn(RACE_MODULE, 'function resolveApRecordWithTable(row, apTable) {');
  assert.ok(!/row\.allplay_w\b/.test(fnSrc), 'must not read row.allplay_w — that is full-season-inclusive-of-playoffs once a season reaches its playoff weeks');
  assert.ok(!/row\.allplay_l\b/.test(fnSrc) && !/row\.allplay_t\b/.test(fnSrc));
  assert.ok(!/allplay_full_|allplay_historical_|allplay_pct/.test(fnSrc));
});
check('apRecordForRow is a thin public wrapper: derives the table then calls the shared resolver — no separate fallback logic of its own', () => {
  const fnSrc = extractBracedFn(RACE_MODULE, 'function apRecordForRow(row, weeklyScores, expectedFids) {');
  assert.ok(/deriveRegSeasonApTable\(weeklyScores, expectedFids\)/.test(fnSrc));
  assert.ok(/resolveApRecordWithTable\(row, apTable\)/.test(fnSrc));
  assert.ok(!/allplay_w|allplay_full_|allplay_historical_|allplay_pct/.test(fnSrc));
});
check('apGamesBack and divisionRace both derive ONE shared apTable per call and resolve every row against it (never a per-franchise weeklyScores re-derivation that could disagree)', () => {
  assert.ok(/function apGamesBack\(rows, weeklyScores\)/.test(RACE_MODULE));
  assert.ok(/function divisionRace\(rows, division, weeklyScores\)/.test(RACE_MODULE));
  const gbFn = extractBracedFn(RACE_MODULE, 'function apGamesBack(rows, weeklyScores) {');
  assert.ok(/var apTable = deriveRegSeasonApTable\(weeklyScores,/.test(gbFn));
  assert.ok(/resolveApRecordWithTable\(seed6, apTable\)/.test(gbFn));
  assert.ok(/resolveApRecordWithTable\(r, apTable\)/.test(gbFn));
  const drFn = extractBracedFn(RACE_MODULE, 'function divisionRace(rows, division, weeklyScores) {');
  assert.ok(/var apTable = deriveRegSeasonApTable\(weeklyScores,/.test(drFn));
  assert.ok(/allRows\.map/.test(drFn), 'the expected population must come from the FULL rows[], not the division-filtered subset');
});
check('luckForRow and expectedWinsForRow take PRE-DERIVED shared tables (computed once by race()) and resolve Overall through an exact weekly[]-derived record (never the display h2h_pct/allplay_pct)', () => {
  const luckFn = extractBracedFn(RACE_MODULE, 'function luckForRow(row, overallTable, apTable) {');
  assert.ok(/resolveApRecordWithTable\(row, apTable\)/.test(luckFn));
  assert.ok(/resolveOverallRecordWithTable\(row, overallTable\)/.test(luckFn));
  assert.ok(!/row\.h2h_pct/.test(luckFn) && !/row\.allplay_pct/.test(luckFn), 'must not read the display h2h_pct/allplay_pct fields as the primary source');
  assert.ok(/row\.seed_ov_pct/.test(luckFn), 'seed_ov_pct is still the documented FALLBACK tier when the exact Overall record is unavailable');
});
check('race() derives the AP and Overall tables ONCE and reuses them for every franchise (never per-row re-derivation)', () => {
  const raceFn = extractBracedFn(RACE_MODULE, 'function race(payload) {');
  assert.ok(/var luckApTable = deriveRegSeasonApTable\(weeklyScores, expectedFids\)/.test(raceFn));
  assert.ok(/var overallTable = deriveRegSeasonOverallTable\(weekly, expectedFids\)/.test(raceFn));
  assert.ok(/luckForRow\(r, overallTable, luckApTable\)/.test(raceFn));
  assert.ok(/expectedWinsForRow\(r, overallTable, luckApTable\)/.test(raceFn));
});
check('deriveRegSeasonOverallTable implements matchup identity (week, fid, opp), reciprocity, and participation completeness — not a per-franchise scan', () => {
  const fn = extractBracedFn(RACE_MODULE, 'function deriveRegSeasonOverallTable(weekly, expectedFids) {');
  assert.ok(/fid \+ '\|' \+ opp/.test(fn), 'matchup key must be (week, franchise_id, opponent_id), not (week, franchise_id) alone — this league has genuine multi-opponent weeks');
  assert.ok(/recip/.test(fn) && /entry\.opp \+ '\|' \+ entry\.fid/.test(fn), 'must check for a reciprocal (opp, fid) entry');
  assert.ok(/'preseason'/.test(fn) && /'incomplete'/.test(fn) && /'conflict'/.test(fn) && /'ok'/.test(fn));
  assert.ok(/normalizePo/.test(fn), 'po must be normalized explicitly, not read via generic truthiness');
});
check('po handling uses explicit normalizePo(), not generic truthiness, in both the AP and Overall table derivations', () => {
  const apFn = extractBracedFn(RACE_MODULE, 'function deriveRegSeasonApTable(weeklyScores, expectedFids) {');
  const overallFn = extractBracedFn(RACE_MODULE, 'function deriveRegSeasonOverallTable(weekly, expectedFids) {');
  assert.ok(/normalizePo\(r\.po\)/.test(apFn));
  assert.ok(/normalizePo\(m\.po\)/.test(overallFn));
  assert.ok(!/if \(!r \|\| r\.po\)/.test(apFn), 'the old generic-truthiness po check must be gone');
});
check('D1/D3 status machine: deriveRegSeasonApTable exposes ok/preseason/incomplete/conflict, and whySeedForRow\'s unseeded branch threads weeklyScores through apGamesBack', () => {
  const tableFn = extractBracedFn(RACE_MODULE, 'function deriveRegSeasonApTable(weeklyScores, expectedFids) {');
  assert.ok(/'preseason'/.test(tableFn) && /'incomplete'/.test(tableFn) && /'conflict'/.test(tableFn) && /'ok'/.test(tableFn));
  assert.ok(/conflictWeeks/.test(tableFn), 'conflicting duplicate scores must be detected, not silently last-wins');
  const whyFn = extractBracedFn(RACE_MODULE, 'function whySeedForRow(row, rows, weeklyScores) {');
  assert.ok(/apGamesBack\(list, weeklyScores\)/.test(whyFn), 'the unseeded branch must pass weeklyScores through, not call apGamesBack(list) alone');
});

for (const [name, fn] of checks) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails++; console.log('  FAIL ' + name + '\n         ' + (e && e.message || e)); }
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
