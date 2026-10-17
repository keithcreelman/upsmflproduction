// Phase II-A1 — site/shared/standings_race.js unit tests.
//   node tests/standings_race.test.mjs
//
// Loads the real shipped module (not a hand-copied stand-in) the same way
// tests/ups_seed_tiebreak.test.mjs extracts worker functions: read the
// source, eval it standalone, exercise it against inline fixture objects
// shaped exactly like a real /api/standings payload (per the field names
// verified against worker/src/index.js as of commit 009b6a3e).
//
// The seeding ORDER is the worker's (worker/src/seeding.js, tested in
// tests/ups_seeding_ladder.test.mjs and tests/standings_seed_reason.test.mjs);
// this module only words the worker's seed_reason, so nothing here can drift
// from it.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('site/shared/standings_race.js', 'utf8');
const sandbox = {};
new Function('window', SRC)(sandbox);
const RACE = sandbox.UPS_STANDINGS_RACE;
assert.ok(RACE, 'window.UPS_STANDINGS_RACE must be defined by the module');

let fails = 0;
const checks = [];
const check = (n, fn) => { checks.push([n, fn]); };

// ── fixture builders ─────────────────────────────────────────────────
function ap(w, l, t) { return { w: w, l: l, t: t || 0 }; }
function row(over) {
  return Object.assign({
    franchise_id: '0000',
    franchise_name: 'Team',
    division: '00',
    is_division_leader: false,
    playoff_seed: null,
    playoff_status: 'non_playoff',
    h2h_w: 0, h2h_l: 0, h2h_t: 0, h2h_pct: 0,
    allplay_w: 0, allplay_l: 0, allplay_t: 0, allplay_pct: 0,
    seed_ap: ap(0, 0, 0),
    seed_total_pf: 0,
    seed_ov_pct: 0
  }, over);
}

// A full, pool-consistent 12-team season: 2 bye (seeds 1-2), 4 in the
// seeds 3-6 pool (2 division winners + 2 wild cards — seed3/seed4 are the
// real 2020 #BLM/C-Town proof), 6 Hawktuah-side (non_playoff).
const SEASON_2020 = [
  row({ franchise_id: '0010', franchise_name: 'Blake Bombers', division: '02', is_division_leader: true,
        playoff_seed: 1, playoff_status: 'bye', h2h_w: 19, h2h_l: 7, h2h_t: 0, h2h_pct: 0.731,
        allplay_w: 117, allplay_l: 57, allplay_pct: 0.672, seed_ap: ap(100, 43), seed_total_pf: 2800, seed_ov_pct: 0.731 }),
  row({ franchise_id: '0007', franchise_name: 'Sex Manther', division: '00', is_division_leader: true,
        playoff_seed: 2, playoff_status: 'bye', h2h_w: 18, h2h_l: 8, h2h_t: 0, h2h_pct: 0.692,
        seed_ap: ap(96, 47), seed_total_pf: 2700, seed_ov_pct: 0.692 }),
  // seed 3/4 — real 2020 proof: exact 91-52-0 AP tie, PF decides (#BLM > C-Town)
  row({ franchise_id: '0008', franchise_name: '#BLM', division: '02', is_division_leader: false,
        playoff_seed: 3, playoff_status: 'wild_card', h2h_w: 17, h2h_l: 9, h2h_t: 0, h2h_pct: 0.654,
        allplay_w: 91, allplay_l: 52, allplay_pct: 0.636,
        seed_ap: ap(91, 52, 0), seed_total_pf: 2675.7, seed_ov_pct: 0.654 }),
  row({ franchise_id: '0009', franchise_name: 'C-Town Chivalry', division: '03', is_division_leader: true,
        playoff_seed: 4, playoff_status: 'division_winner', h2h_w: 22, h2h_l: 4, h2h_t: 0, h2h_pct: 0.846,
        allplay_w: 91, allplay_l: 52, allplay_pct: 0.636,
        seed_ap: ap(91, 52, 0), seed_total_pf: 2637.0, seed_ov_pct: 0.846 }),
  row({ franchise_id: '0006', franchise_name: 'Good in Da Hood', division: '01', is_division_leader: false,
        playoff_seed: 5, playoff_status: 'wild_card', h2h_w: 15, h2h_l: 11, h2h_t: 0, h2h_pct: 0.577,
        allplay_w: 85, allplay_l: 58, allplay_pct: 0.594, seed_ap: ap(85, 58), seed_total_pf: 2500, seed_ov_pct: 0.577 }),
  row({ franchise_id: '0001', franchise_name: 'Ulterior Warrior', division: '01', is_division_leader: true,
        playoff_seed: 6, playoff_status: 'division_winner', h2h_w: 14, h2h_l: 12, h2h_t: 0, h2h_pct: 0.538,
        allplay_w: 80, allplay_l: 63, allplay_pct: 0.559, seed_ap: ap(80, 63), seed_total_pf: 2400, seed_ov_pct: 0.538 }),
  row({ franchise_id: '0002', franchise_name: 'The Bash Bros', division: '01', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 10, h2h_l: 16, h2h_t: 0, h2h_pct: 0.385,
        allplay_w: 75, allplay_l: 68, allplay_pct: 0.524, seed_ap: ap(75, 68), seed_total_pf: 2300, seed_ov_pct: 0.385 }),
  row({ franchise_id: '0003', franchise_name: 'Gride', division: '00', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 9, h2h_l: 17, h2h_t: 0, h2h_pct: 0.346,
        allplay_w: 70, allplay_l: 73, allplay_pct: 0.490, seed_ap: ap(70, 73), seed_total_pf: 2200, seed_ov_pct: 0.346 }),
  row({ franchise_id: '0005', franchise_name: 'Run CMC', division: '00', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 8, h2h_l: 18, h2h_t: 0, h2h_pct: 0.308,
        allplay_w: 65, allplay_l: 78, allplay_pct: 0.455, seed_ap: ap(65, 78), seed_total_pf: 2100, seed_ov_pct: 0.308 }),
  row({ franchise_id: '0004', franchise_name: 'Pure Greatness', division: '03', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 7, h2h_l: 19, h2h_t: 0, h2h_pct: 0.269,
        allplay_w: 60, allplay_l: 83, allplay_pct: 0.420, seed_ap: ap(60, 83), seed_total_pf: 2000, seed_ov_pct: 0.269 }),
  row({ franchise_id: '0011', franchise_name: 'Cleon Ca$h', division: '03', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 6, h2h_l: 20, h2h_t: 0, h2h_pct: 0.231,
        allplay_w: 55, allplay_l: 88, allplay_pct: 0.385, seed_ap: ap(55, 88), seed_total_pf: 1900, seed_ov_pct: 0.231 }),
  row({ franchise_id: '0012', franchise_name: 'Hawks', division: '02', is_division_leader: false,
        playoff_seed: null, playoff_status: 'non_playoff', h2h_w: 5, h2h_l: 21, h2h_t: 0, h2h_pct: 0.192,
        allplay_w: 50, allplay_l: 93, allplay_pct: 0.350, seed_ap: ap(50, 93), seed_total_pf: 1800, seed_ov_pct: 0.192 })
];

function byFid(rows, fid) { return rows.find((r) => r.franchise_id === fid); }

// ── 1. Status mapping ────────────────────────────────────────────────
check('status: bye -> BYE, division_winner -> DIV, wild_card -> WC, non_playoff/missing -> null', () => {
  assert.strictEqual(RACE.statusForRow(row({ playoff_status: 'bye' })), 'BYE');
  assert.strictEqual(RACE.statusForRow(row({ playoff_status: 'division_winner' })), 'DIV');
  assert.strictEqual(RACE.statusForRow(row({ playoff_status: 'wild_card' })), 'WC');
  assert.strictEqual(RACE.statusForRow(row({ playoff_status: 'non_playoff' })), null);
  assert.strictEqual(RACE.statusForRow(row({ playoff_status: undefined })), null);
  assert.strictEqual(RACE.statusForRow(null), null);
  // never OUT, no matter what garbage playoff_status carries
  assert.notStrictEqual(RACE.statusForRow(row({ playoff_status: 'eliminated' })), 'OUT');
});

// ── 2. AP games back ─────────────────────────────────────────────────
check('AP GB: seeds 1-6 return 0', () => {
  const gb = RACE.apGamesBack(SEASON_2020);
  for (let s = 1; s <= 6; s++) {
    const r = SEASON_2020.find((x) => x.playoff_seed === s);
    assert.strictEqual(gb[r.franchise_id], 0, 'seed ' + s + ' must be 0 GB');
  }
});
check('AP GB: outside top six returns max(0, seed6Wins - myWins)', () => {
  const gb = RACE.apGamesBack(SEASON_2020);
  // seed 6 = Ulterior Warrior, 80-63-0 -> 80 wins-equivalent
  // Bash Bros 75-68-0 -> 75 -> 5.0 back
  assert.strictEqual(gb['0002'], 5);
  // Hawks 50-93-0 -> 50 -> 30.0 back
  assert.strictEqual(gb['0012'], 30);
});
check('AP GB: a team exactly tied with seed 6 correctly shows 0.0 GB (not clamped away or null)', () => {
  const rows = SEASON_2020.map((r) => Object.assign({}, r));
  const tied = byFid(rows, '0002');
  tied.seed_ap = ap(80, 63, 0); // same as seed 6 (Ulterior Warrior)
  const gb = RACE.apGamesBack(rows);
  assert.strictEqual(gb['0002'], 0);
});
check('AP GB: missing seed-6 row returns null for every franchise, never throws', () => {
  const noSeed6 = SEASON_2020.map((r) => {
    const c = Object.assign({}, r);
    if (c.playoff_seed === 6) { c.playoff_seed = null; c.playoff_status = 'non_playoff'; }
    return c;
  });
  const gb = RACE.apGamesBack(noSeed6);
  Object.keys(gb).forEach((fid) => assert.strictEqual(gb[fid], null));
});
check('AP GB: preseason payload (zero rows) does not throw', () => {
  assert.deepStrictEqual(RACE.apGamesBack([]), {});
  assert.deepStrictEqual(RACE.apGamesBack(undefined), {});
});
check('AP GB: uses the integer AP record, not rounded allplay_pct (near-identical % must not collapse a real gap)', () => {
  // seed 6 at 80-63 (.559964..) vs a team at 79-63 (.556... — rounds the
  // same to 3dp as a naive % compare would blur) must still show 1.0 GB,
  // not 0.
  const rows = SEASON_2020.map((r) => Object.assign({}, r));
  const near = byFid(rows, '0002');
  near.seed_ap = ap(79, 63, 0);
  const gb = RACE.apGamesBack(rows);
  assert.strictEqual(gb['0002'], 1);
});

// ── 3. Luck (D2 — regular-season-scope-consistent) ─────────────────────
// Luck = regular-season Overall% - regular-season AP%. Both sides are
// resolved exactly (never the display h2h_pct/allplay_pct, which are
// NOT playoff-filtered once a season reaches its playoff weeks).
function wkRow(w, fid, ts, opp, os, po) { return { w: w, fid: fid, ts: ts, opp: opp, os: os, po: po ? 1 : 0 }; }
function wsRowLuck(w, fid, ts, po) { return { w: w, fid: fid, ts: ts, opt: ts, po: po ? 1 : 0 }; }
// 4-team season: A(0001) vs B(0002), C(0003) vs D(0004) every week.
// Regular season (1-14): A always beats its scheduled opponent B
// (150>100) -> Overall 14-0-0 (1.000). All-play also compares A against
// C (200, A loses) and D (120, A wins) every week -> AP 28-14-0 (.6667).
// So Luck(A, reg season) = 1.000 - .6667 = +.3333 (NOT 0, proving AP and
// Overall genuinely diverge for this team, not a coincidental A==B).
// Playoff weeks (15-17): every score pattern is REVERSED (A collapses to
// 50, loses to everyone) — a mixed-scope bug would drag reg-season Luck
// down; the correct implementation must ignore these entirely.
function buildFourTeamSeason(includePlayoffs) {
  const weekly = [], weeklyScores = [];
  for (let w = 1; w <= 14; w++) {
    weekly.push(wkRow(w, '0001', 150, '0002', 100, false), wkRow(w, '0002', 100, '0001', 150, false));
    weekly.push(wkRow(w, '0003', 200, '0004', 120, false), wkRow(w, '0004', 120, '0003', 200, false));
    weeklyScores.push(wsRowLuck(w, '0001', 150, false), wsRowLuck(w, '0002', 100, false), wsRowLuck(w, '0003', 200, false), wsRowLuck(w, '0004', 120, false));
  }
  if (includePlayoffs) {
    for (let w = 15; w <= 17; w++) {
      weekly.push(wkRow(w, '0001', 50, '0002', 300, true), wkRow(w, '0002', 300, '0001', 50, true));
      weekly.push(wkRow(w, '0003', 60, '0004', 250, true), wkRow(w, '0004', 250, '0003', 60, true));
      weeklyScores.push(wsRowLuck(w, '0001', 50, true), wsRowLuck(w, '0002', 300, true), wsRowLuck(w, '0003', 60, true), wsRowLuck(w, '0004', 250, true));
    }
  }
  return { weekly, weeklyScores };
}
const FOUR_TEAM_FIDS = ['0001', '0002', '0003', '0004'];
function luckRowFixture(fid) { return row({ franchise_id: fid, seed_ap: undefined, seed_ov_pct: undefined }); }
// luckForRow/expectedWinsForRow now take PRE-DERIVED tables (computed once
// per race() call and reused) instead of raw weekly/weeklyScores/expectedFids
// — this helper mirrors exactly what race() does, for direct unit testing.
function luckTables(weekly, weeklyScores, fids) {
  return { overallTable: RACE.deriveRegSeasonOverallTable(weekly, fids), apTable: RACE.deriveRegSeasonApTable(weeklyScores, fids) };
}

check('Luck: numeric, regular-season Overall% - regular-season AP%, both positive and negative', () => {
  const { weekly, weeklyScores } = buildFourTeamSeason(false);
  const { overallTable, apTable } = luckTables(weekly, weeklyScores, FOUR_TEAM_FIDS);
  const luckA = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(luckA.toFixed(4), (1 - 28 / 42).toFixed(4)); // +.3333 (positive)
  // D: loses to C every week (Overall 0-14-0 = .000) but beats ONLY B in
  // all-play each week (120 beats B's 100, loses to A's 150 and C's 200)
  // -> AP 14-28-0 = .3333 -> Luck = .000 - .3333 = -.3333 (negative)
  const luckD = RACE.luckForRow(luckRowFixture('0004'), overallTable, apTable);
  assert.strictEqual(luckD, 0 - 14 / 42);
});
check('Luck: playoff weeks (15-17) cannot change regular-season Luck (mixed-scope contamination regression)', () => {
  const reg = buildFourTeamSeason(false);
  const full = buildFourTeamSeason(true);
  const regTables = luckTables(reg.weekly, reg.weeklyScores, FOUR_TEAM_FIDS);
  const fullTables = luckTables(full.weekly, full.weeklyScores, FOUR_TEAM_FIDS);
  const luckRegOnly = RACE.luckForRow(luckRowFixture('0001'), regTables.overallTable, regTables.apTable);
  const luckWithPlayoffs = RACE.luckForRow(luckRowFixture('0001'), fullTables.overallTable, fullTables.apTable);
  assert.strictEqual(luckWithPlayoffs, luckRegOnly, 'adding playoff weeks 15-17 must not move a regular-season Luck value');
});
check('Luck: exact AP tie and exact Overall tie (0.5 weighting) both handled correctly', () => {
  // 2 teams, week 1 ends in an exact tie both head-to-head and all-play.
  const weekly = [wkRow(1, '0001', 100, '0002', 100, false), wkRow(1, '0002', 100, '0001', 100, false)];
  const weeklyScores = [wsRowLuck(1, '0001', 100, false), wsRowLuck(1, '0002', 100, false)];
  const { overallTable, apTable } = luckTables(weekly, weeklyScores, ['0001', '0002']);
  const luck = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(luck, 0, 'a 0-0-1 Overall tie and a 0-0-1 AP tie both resolve to .5, so Luck = .5 - .5 = 0');
});
check('Luck: Overall record containing ties is weighted (wins + 0.5*ties) / games, not ties-ignored', () => {
  // A: week1 tie (100-100), week2 win (150-100) vs the same opponent B.
  const weekly = [
    wkRow(1, '0001', 100, '0002', 100, false), wkRow(1, '0002', 100, '0001', 100, false),
    wkRow(2, '0001', 150, '0002', 100, false), wkRow(2, '0002', 100, '0001', 150, false)
  ];
  const weeklyScores = [wsRowLuck(1, '0001', 100, false), wsRowLuck(1, '0002', 100, false), wsRowLuck(2, '0001', 150, false), wsRowLuck(2, '0002', 100, false)];
  const overallTable = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(overallTable.status, 'ok');
  assert.deepStrictEqual(overallTable.byFid['0001'], { w: 1, l: 0, t: 1 });
  // Overall% = (1 + 0.5*1) / 2 = .75; AP with only 2 franchises equals Overall exactly -> Luck = 0
  const apTable = RACE.deriveRegSeasonApTable(weeklyScores, ['0001', '0002']);
  const luck = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(luck, 0);
});
check('Luck: unavailable AP (incomplete weeklyScores) returns null, never a fabricated value', () => {
  // Week 1 is missing franchise 0003's score entirely -> incomplete -> AP unresolvable.
  const weekly = buildFourTeamSeason(false).weekly;
  const weeklyScores = [wsRowLuck(1, '0001', 100, false), wsRowLuck(1, '0002', 90, false)]; // 0003/0004 missing from week 1
  const { overallTable, apTable } = luckTables(weekly, weeklyScores, FOUR_TEAM_FIDS);
  const luck = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(luck, null);
});
check('Luck: unavailable Overall (franchise missing from weekly[]) returns null even when AP resolves, unless seed_ov_pct rescues it', () => {
  const { weeklyScores } = buildFourTeamSeason(false);
  const weeklyMissing0001 = buildFourTeamSeason(false).weekly.filter((m) => m.fid !== '0001' && m.opp !== '0001'); // 0001 has zero games in an otherwise-populated weekly[]
  const overallTable = RACE.deriveRegSeasonOverallTable(weeklyMissing0001, FOUR_TEAM_FIDS);
  assert.strictEqual(overallTable.status, 'incomplete', '0001 missing from a populated week must invalidate the table, not just that franchise');
  const apTable = RACE.deriveRegSeasonApTable(weeklyScores, FOUR_TEAM_FIDS);
  const noFallback = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(noFallback, null, 'no exact Overall record and no valid seed_ov_pct -> unavailable');
  const withFallback = RACE.luckForRow(row({ franchise_id: '0001', seed_ap: undefined, seed_ov_pct: 0.6 }), overallTable, apTable);
  assert.strictEqual(typeof withFallback, 'number', 'a valid authoritative seed_ov_pct may rescue the Overall% side when the exact record is unavailable');
});
check('Luck: expected wins uses regular-season AP% * regular-season Overall games; null (not calculated) when Luck is unavailable', () => {
  const { weekly, weeklyScores } = buildFourTeamSeason(false);
  const { overallTable, apTable } = luckTables(weekly, weeklyScores, FOUR_TEAM_FIDS);
  const ew = RACE.expectedWinsForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(ew, Math.round((28 / 42) * 14 * 10) / 10);
  const weeklyMissing0001 = weekly.filter((m) => m.fid !== '0001' && m.opp !== '0001');
  const incompleteOverall = RACE.deriveRegSeasonOverallTable(weeklyMissing0001, FOUR_TEAM_FIDS);
  const ewUnavailable = RACE.expectedWinsForRow(row({ franchise_id: '0001', seed_ap: undefined, seed_ov_pct: 0.6 }), incompleteOverall, apTable);
  assert.strictEqual(ewUnavailable, null, 'expectedWins needs the EXACT game count — the seed_ov_pct percentage fallback cannot supply one');
});
check('Luck: preseason (zero regular-season data anywhere) is a true 0 - 0 = 0, never null', () => {
  const { overallTable, apTable } = luckTables([], [], FOUR_TEAM_FIDS);
  assert.strictEqual(overallTable.status, 'preseason');
  assert.strictEqual(apTable.status, 'preseason');
  const luck = RACE.luckForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(luck, 0);
  const ew = RACE.expectedWinsForRow(luckRowFixture('0001'), overallTable, apTable);
  assert.strictEqual(ew, 0);
});

// ── F1/F2 — Overall matchup dedup/conflict/completeness (deriveRegSeasonOverallTable) ──
check('Overall: an IDENTICAL duplicate (week, fid, opp) matchup row is deduped safely', () => {
  const weekly = [wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0002', 90, '0001', 100, false)];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(t.status, 'ok');
  assert.deepStrictEqual(t.byFid['0001'], { w: 1, l: 0, t: 0 });
});
check('Overall: a CONFLICTING duplicate (same week/fid/opp, different score) invalidates the whole table, order-independent', () => {
  const wA = [wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0001', 999, '0002', 90, false), wkRow(1, '0002', 90, '0001', 100, false)];
  const wB = [wkRow(1, '0001', 999, '0002', 90, false), wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0002', 90, '0001', 100, false)];
  assert.strictEqual(RACE.deriveRegSeasonOverallTable(wA, ['0001', '0002']).status, 'conflict');
  assert.strictEqual(RACE.deriveRegSeasonOverallTable(wB, ['0001', '0002']).status, 'conflict', 'row order must not change the outcome');
});
check('Overall: one franchise missing from a populated week invalidates the table for EVERY franchise', () => {
  const weekly = [wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0002', 90, '0001', 100, false)]; // 0003 never appears
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002', '0003']);
  assert.strictEqual(t.status, 'incomplete');
  const rec2 = RACE.resolveOverallRecordWithTable(row({ franchise_id: '0002' }), t);
  assert.strictEqual(rec2, null, '0002 played its game fine but must still be unavailable — one shared table, one shared status');
});
check('Overall: one matchup missing during a multi-opponent week is detected via a missing reciprocal row', () => {
  // 0001 plays TWO opponents in week 1 (0002 and 0003) -- a genuine
  // multi-opponent week, matching the real UPS schedule shape. 0002's
  // reciprocal row for its game against 0001 is silently dropped.
  const weekly = [
    wkRow(1, '0001', 100, '0002', 90, false), // 0001 vs 0002 (0001's side)
    // wkRow(1, '0002', 90, '0001', 100, false),  <-- MISSING: 0002's own row for this same game
    wkRow(1, '0001', 100, '0003', 80, false), // 0001 vs 0003 (0001's side)
    wkRow(1, '0003', 80, '0001', 100, false)  // 0003's reciprocal IS present
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002', '0003']);
  assert.strictEqual(t.status, 'incomplete', 'a missing reciprocal for one of two matchups in a multi-opponent week must be caught even though 0001 itself "participated" via its other game');
});
check('Overall: reciprocal row present but DISAGREEING (different score than its counterpart implies) is a conflict, not silently accepted', () => {
  const weekly = [
    wkRow(1, '0001', 100, '0002', 90, false),  // 0001 says it beat 0002, 100-90
    wkRow(1, '0002', 50, '0001', 100, false)   // 0002's reciprocal disagrees on ITS OWN score (50, not 90)
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(t.status, 'conflict');
});
check('Overall: an invalid (unparseable) score is treated as absent, not zero -- causes incompleteness, not a false record', () => {
  const weekly = [
    { w: 1, fid: '0001', ts: 'NaN', opp: '0002', os: 90, po: 0 },
    wkRow(1, '0002', 90, '0001', 100, false)
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(t.status, 'incomplete');
});
check('Overall: ties count as 0.5 in the win percentage (verified via apPctFromRecord on a derived tie record)', () => {
  const weekly = [wkRow(1, '0001', 100, '0002', 100, false), wkRow(1, '0002', 100, '0001', 100, false)];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.deepStrictEqual(t.byFid['0001'], { w: 0, l: 0, t: 1 });
  assert.strictEqual(RACE.apPctFromRecord(t.byFid['0001']), 0.5);
});
check('Overall: playoff rows (po=true) are excluded entirely, never affecting the regular-season table', () => {
  const reg = [wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0002', 90, '0001', 100, false)];
  const withPlayoffs = reg.concat([wkRow(15, '0001', 20, '0002', 999, true), wkRow(15, '0002', 999, '0001', 20, true)]);
  const tReg = RACE.deriveRegSeasonOverallTable(reg, ['0001', '0002']);
  const tFull = RACE.deriveRegSeasonOverallTable(withPlayoffs, ['0001', '0002']);
  assert.deepStrictEqual(tFull, tReg);
});
check('Overall: numeric, string, and boolean po values are normalized consistently (normalizePo)', () => {
  assert.strictEqual(RACE.normalizePo(0), false);
  assert.strictEqual(RACE.normalizePo('0'), false);
  assert.strictEqual(RACE.normalizePo(false), false);
  assert.strictEqual(RACE.normalizePo(1), true);
  assert.strictEqual(RACE.normalizePo('1'), true);
  assert.strictEqual(RACE.normalizePo(true), true);
  assert.strictEqual(RACE.normalizePo(undefined), null);
  assert.strictEqual(RACE.normalizePo(null), null);
  // Exercised end-to-end: string "0"/"1" po values on real matchup rows.
  const weekly = [
    { w: 1, fid: '0001', ts: 100, opp: '0002', os: 90, po: '0' },
    { w: 1, fid: '0002', ts: 90, opp: '0001', os: 100, po: '0' },
    { w: 15, fid: '0001', ts: 20, opp: '0002', os: 999, po: '1' },
    { w: 15, fid: '0002', ts: 999, opp: '0001', os: 20, po: '1' }
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(t.status, 'ok');
  assert.deepStrictEqual(t.byFid['0001'], { w: 1, l: 0, t: 0 }, 'string po "1" week-15 game must be excluded as playoff');
});
check('Overall: an unrecognized/ambiguous po value on a RELEVANT row fails closed to incomplete — NOT preseason (F3)', () => {
  // Before F3 this incorrectly resolved to 'preseason' (the row was
  // silently dropped, leaving zero weeks, which the table conflated with
  // "nobody has played yet"). A relevant row with garbage `po` is a data
  // problem, not evidence of an empty season -- must fail closed.
  const weekly = [
    { w: 1, fid: '0001', ts: 100, opp: '0002', os: 90, po: 'maybe' },
    { w: 1, fid: '0002', ts: 90, opp: '0001', os: 100, po: 'maybe' }
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002']);
  assert.strictEqual(t.status, 'incomplete', 'an ambiguous po value on a relevant row must fail closed to incomplete, not be silently reinterpreted as preseason');
  assert.strictEqual(t.byFid, null);
});
check('Overall: a conflict affecting only ONE matchup pair invalidates the shared table for every franchise', () => {
  const weekly = [
    wkRow(1, '0001', 100, '0002', 90, false), wkRow(1, '0001', 999, '0002', 90, false), // conflict: 0001 vs 0002
    wkRow(1, '0002', 90, '0001', 100, false),
    wkRow(1, '0003', 80, '0004', 70, false), wkRow(1, '0004', 70, '0003', 80, false) // clean, unrelated pair
  ];
  const t = RACE.deriveRegSeasonOverallTable(weekly, ['0001', '0002', '0003', '0004']);
  assert.strictEqual(t.status, 'conflict');
  const rec3 = RACE.resolveOverallRecordWithTable(row({ franchise_id: '0003' }), t);
  assert.strictEqual(rec3, null, '0003/0004 had a perfectly clean, reciprocal, unconflicted matchup but must still be unavailable');
});

// ── 4. Recent form ───────────────────────────────────────────────────
check('form: last-5/last-3 regular-season-only W/L/T, chronological, excludes playoff rows', () => {
  const weekly = [
    { w: 1, fid: '0001', ts: 100, opp: '0002', os: 90, po: 0 },  // W
    { w: 2, fid: '0001', ts: 80, opp: '0003', os: 95, po: 0 },   // L
    { w: 3, fid: '0001', ts: 100, opp: '0004', os: 100, po: 0 }, // T
    { w: 4, fid: '0001', ts: 110, opp: '0002', os: 90, po: 0 },  // W
    { w: 5, fid: '0001', ts: 120, opp: '0003', os: 90, po: 0 },  // W
    { w: 6, fid: '0001', ts: 130, opp: '0004', os: 90, po: 0 },  // W
    { w: 15, fid: '0001', ts: 50, opp: '0002', os: 200, po: 1 }, // playoff — must NOT appear
  ];
  const f = RACE.formForFranchise(weekly, '0001');
  assert.deepStrictEqual(f.last5, ['L', 'T', 'W', 'W', 'W']);
  assert.deepStrictEqual(f.last3, ['W', 'W', 'W']);
});
check('form: multi-opponent week contributes one result per matchup (no de-dup by week)', () => {
  const weekly = [
    { w: 5, fid: '0001', ts: 100, opp: '0002', os: 90, po: 0 },  // W
    { w: 5, fid: '0001', ts: 80, opp: '0003', os: 95, po: 0 },   // L (same week, second opponent)
  ];
  const f = RACE.formForFranchise(weekly, '0001');
  assert.deepStrictEqual(f.last5, ['W', 'L']);
});
check('form: fewer than five games returns only what exists', () => {
  const weekly = [{ w: 1, fid: '0001', ts: 100, opp: '0002', os: 90, po: 0 }];
  assert.deepStrictEqual(RACE.formForFranchise(weekly, '0001').last5, ['W']);
});
check('form: an empty season is no games; a missing (failed) weekly is UNKNOWN — never an empty form', () => {
  assert.deepStrictEqual(RACE.formForFranchise([], '0001'), { last5: [], last3: [] });
  assert.deepStrictEqual(RACE.formForFranchise(undefined, '0001'), { last5: null, last3: null });
  assert.deepStrictEqual(RACE.formForFranchise(null, '0001'), { last5: null, last3: null });
});

// ── 5. Weekly AP rank ────────────────────────────────────────────────
check('weeklyApRank: rank 1 = highest score, ties share the better rank', () => {
  const ws = [
    { w: 1, fid: '0001', ts: 150, po: 0 },
    { w: 1, fid: '0002', ts: 150, po: 0 }, // tied for 1st
    { w: 1, fid: '0003', ts: 120, po: 0 }, // 3rd, not 2nd
  ];
  const r = RACE.weeklyApRank(ws);
  assert.strictEqual(r.byFranchise['0001'][1].rank, 1);
  assert.strictEqual(r.byFranchise['0002'][1].rank, 1);
  assert.strictEqual(r.byFranchise['0003'][1].rank, 3);
});
check('weeklyApRank: de-duplicates a (week, franchise) key that appears twice before ranking', () => {
  const ws = [
    { w: 1, fid: '0001', ts: 100, po: 0 },
    { w: 1, fid: '0001', ts: 140, po: 0 }, // duplicate row for the same week/franchise — last wins
    { w: 1, fid: '0002', ts: 130, po: 0 },
  ];
  const r = RACE.weeklyApRank(ws);
  // only one entry for 0001/week1 was used for ranking (140 beats 130 -> rank 1)
  assert.strictEqual(r.byFranchise['0001'][1].rank, 1);
  assert.strictEqual(r.byFranchise['0002'][1].rank, 2);
});
check('weeklyApRank: playoff weeks are flagged, unplayed weeks stay absent (empty)', () => {
  const ws = [
    { w: 1, fid: '0001', ts: 100, po: 0 },
    { w: 15, fid: '0001', ts: 100, po: 1 },
  ];
  const r = RACE.weeklyApRank(ws);
  assert.strictEqual(r.byFranchise['0001'][1].playoff, false);
  assert.strictEqual(r.byFranchise['0001'][15].playoff, true);
  assert.strictEqual(r.byFranchise['0001'][2], undefined); // week 2 never played -> absent, not a fabricated rank
  assert.strictEqual(r.maxWeek, 15);
});
check('weeklyApRank: empty weeklyScores does not throw', () => {
  assert.deepStrictEqual(RACE.weeklyApRank([]), { maxWeek: 0, byFranchise: {} });
});

// ── 6. Game log ──────────────────────────────────────────────────────
check('gameLog: resolves opponent name from rows[], includes W/L/T and regular/playoff designation', () => {
  const rowsForNames = [row({ franchise_id: '0001', franchise_name: 'Me' }), row({ franchise_id: '0002', franchise_name: 'Rival Co' })];
  const weekly = [
    { w: 1, fid: '0001', ts: 100, opp: '0002', os: 90, po: 0 },
    { w: 15, fid: '0001', ts: 80, opp: '0002', os: 95, po: 1 },
  ];
  const log = RACE.gameLogForFranchise(weekly, rowsForNames, '0001');
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].opponent_name, 'Rival Co');
  assert.strictEqual(log[0].result, 'W');
  assert.strictEqual(log[0].is_playoff, false);
  assert.strictEqual(log[1].result, 'L');
  assert.strictEqual(log[1].is_playoff, true);
});

// ── division grouping / division race ───────────────────────────────
check('divisionRace: groups by division without hardcoding team count, computes AP GB to the division leader', () => {
  const dr = RACE.divisionRace(SEASON_2020, '01'); // Good in Da Hood, Ulterior Warrior, The Bash Bros
  assert.strictEqual(dr.length, 3);
  const leader = dr.find((d) => d.is_division_leader);
  assert.strictEqual(leader.franchise_id, '0001'); // Ulterior Warrior, is_division_leader: true
  assert.strictEqual(leader.ap_gb, 0);
  const bash = dr.find((d) => d.franchise_id === '0002');
  assert.strictEqual(bash.ap_gb, 5); // 80 - 75
});

// ── 7. Seed explanations ─────────────────────────────────────────────
// Words only, from the WORKER's seed_reason (worker/src/seeding.js seedLadderSteps — canon §F.1: All-Play % → Overall
// → season Points For → head-to-head). The module has no comparator of its own (Keith 2026-10-09, port decision 1).
// SEASON_2020's seed_reasons are shaped exactly as /api/standings sends them for a CURRENT season; the fixture's real
// 2020 season is a recorded one, covered separately below.
function withReasons(rows) {
  const R = Object.fromEntries(rows.map((r) => [r.franchise_id, r]));
  const reason = (pool, step, position, rivalFid) => ({ basis: 'ladder', pool, step, position, rival_franchise_id: rivalFid,
    rival_name: R[rivalFid].franchise_name, rival_seed: R[rivalFid].playoff_seed });
  const set = {
    '0010': reason('bye', 'all_play', 'ahead', '0007'), '0007': reason('bye', 'all_play', 'behind', '0010'),
    '0008': reason('seeds3to6', 'overall', 'ahead', '0009'), '0009': reason('seeds3to6', 'all_play', 'ahead', '0006'),
    '0006': reason('seeds3to6', 'all_play', 'ahead', '0001'), '0001': reason('seeds3to6', 'all_play', 'behind', '0006'),
  };
  return rows.map((r) => Object.assign({}, r, { seed_reason: set[r.franchise_id] || reason('outside', 'all_play', 'behind', '0006') }));
}
const S20 = withReasons(SEASON_2020);
check('seed explanation: the module has NO comparator of its own — compareSeedPair and its ladder are gone', () => {
  assert.strictEqual(RACE.compareSeedPair, undefined);
  assert.ok(!/function\s+compareSeedPair\s*\(/.test(SRC) && !/CRITERION_LABEL/.test(SRC));
  assert.ok(!/AP% → Total PF|Total regular-season PF/.test(SRC), 'no trace of the reversed AP → PF → Overall order');
});
check('seed explanation: seeded rows say the WORKER\'s step, pool and neighbour — each step worded', () => {
  const why = (fid) => RACE.whySeedForRow(byFid(S20, fid), S20);
  assert.strictEqual(why('0010').text, 'Seed 1: in the bye pool (the two best division winners); ranked ahead of Sex Manther on All-Play %.');
  assert.strictEqual(why('0007').text, 'Seed 2: in the bye pool (the two best division winners); behind Blake Bombers on All-Play %.');
  assert.strictEqual(why('0008').text, 'Seed 3: in the seeds 3–6 pool; ranked ahead of C-Town Chivalry on Overall record.');
  assert.strictEqual(why('0008').decidingCriterion, 'overall');
  assert.strictEqual(why('0008').basis, 'ladder');
  for (const [step, words] of [['points_for', 'season Points For'], ['head_to_head', 'head-to-head'], ['overall', 'Overall record'], ['all_play', 'All-Play %']]) {
    const r = Object.assign({}, byFid(S20, '0006'), { seed_reason: Object.assign({}, byFid(S20, '0006').seed_reason, { step }) });
    assert.ok(RACE.whySeedForRow(r, S20).text.endsWith('on ' + words + '.'), step);
  }
});
check('seed explanation: the name/id fallback is disclaimed; a head-to-head tie without games says so', () => {
  const r = (step) => Object.assign({}, byFid(S20, '0006'), { seed_reason: Object.assign({}, byFid(S20, '0006').seed_reason, { step }) });
  assert.ok(/not a league rule/.test(RACE.whySeedForRow(r('name'), S20).text));
  assert.ok(/not a league rule/.test(RACE.whySeedForRow(r('franchise_id'), S20).text));
  assert.ok(/couldn’t be read/.test(RACE.whySeedForRow(r('head_to_head_unavailable'), S20).text));
});
check('seed explanation: outside the top six — AP games back, then the worker\'s step against the last wild card', () => {
  const why = RACE.whySeedForRow(byFid(S20, '0002'), S20); // The Bash Bros, 5.0 back
  assert.strictEqual(why.pool, 'outside');
  assert.strictEqual(why.text, 'Outside the top six — 5 AP wins back; behind Good in Da Hood (the last wild card) on All-Play %.');
});
check('seed explanation: AP unavailable for an outside team is said, never a zero', () => {
  const unseededRow = row({ franchise_id: '0099', franchise_name: 'NoAp', seed_ap: undefined, seed_reason: { basis: 'ladder', pool: 'outside', step: null } });
  const seed6Row = row({ franchise_id: '0098', franchise_name: 'Seed6', playoff_seed: 6, playoff_status: 'division_winner', seed_ap: undefined });
  const otherRow = row({ franchise_id: '0097', franchise_name: 'Other', seed_ap: undefined });
  const ws = [{ w: 1, fid: '0098', ts: 100, po: 0 }, { w: 1, fid: '0097', ts: 90, po: 0 }];   // week 1 missing 0099 → incomplete
  assert.strictEqual(RACE.whySeedForRow(unseededRow, [seed6Row, unseededRow, otherRow], ws).text, 'Outside the top six — AP games back unavailable.');
  assert.strictEqual(RACE.whySeedForRow(unseededRow, [seed6Row, unseededRow, otherRow], null).text, 'Outside the top six — AP games back unavailable.', 'a failed weeklyScores query (null)');
});
check('seed explanation: a season with RECORDED final standings is labelled so — no ladder step is claimed', () => {
  const rec = (r) => Object.assign({}, r, { seed_reason: { basis: 'recorded_final_standings' } });
  const why3 = RACE.whySeedForRow(rec(byFid(SEASON_2020, '0008')), SEASON_2020.map(rec));
  assert.strictEqual(why3.text, 'Seed 3 — from the recorded final standings.');
  assert.strictEqual(why3.decidingCriterion, null);
  assert.strictEqual(why3.basis, 'recorded_final_standings');
  assert.strictEqual(RACE.whySeedForRow(rec(byFid(SEASON_2020, '0002')), SEASON_2020.map(rec)).text, 'Outside the top six — from the recorded final standings.');
});
check('seed explanation: no seed_reason on the row (an older worker) → blocked, never guessed', () => {
  const why = RACE.whySeedForRow(byFid(SEASON_2020, '0008'), SEASON_2020);
  assert.strictEqual(why.blocked, true); assert.strictEqual(why.text, null);
  assert.ok(/no seed reason/.test(why.reason));
});

// ── missing/preseason whole-payload behavior ────────────────────────
check('race(): preseason/empty payload returns empty lookup, never throws', () => {
  const out = RACE.race({ rows: [], weekly: [], weeklyScores: [], preseason: true });
  assert.deepStrictEqual(out.byFranchise, {});
  assert.strictEqual(out.hasSeed6, false);
  assert.strictEqual(out.seed2FranchiseId, null);
  assert.strictEqual(out.preseason, true);
  assert.deepStrictEqual(RACE.race(undefined).byFranchise, {});
  assert.deepStrictEqual(RACE.race({}).byFranchise, {});
});
check('race(): end-to-end composition on the 2020 fixture — status / apGB / whySeed agree with the per-function checks', () => {
  const out = RACE.race({ rows: S20, weekly: [], weeklyScores: [] });
  assert.strictEqual(out.seed2FranchiseId, '0007');
  assert.strictEqual(out.seed6FranchiseId, '0001');
  assert.strictEqual(out.hasSeed6, true);
  const blm = out.byFranchise['0008'];
  assert.strictEqual(blm.status, 'WC');
  assert.strictEqual(blm.apGB, 0);
  assert.strictEqual(blm.whySeed.decidingCriterion, 'overall', 'straight from the worker\'s seed_reason');
  const hawks = out.byFranchise['0012'];
  assert.strictEqual(hawks.status, null);
  assert.strictEqual(hawks.apGB, 30);
});
check('race(): every seed and BYE/DIV/WC is PROJECTED until season_complete', () => {
  assert.strictEqual(RACE.race({ rows: S20, weekly: [], weeklyScores: [] }).projected, true);
  assert.strictEqual(RACE.race({ rows: S20, weekly: [], weeklyScores: [], season_complete: false }).projected, true);
  assert.strictEqual(RACE.race({ rows: S20, weekly: [], weeklyScores: [], season_complete: true }).projected, false);
});
check('race(): a FAILED weekly / weeklyScores query (null) is unavailable everywhere — never preseason zeros', () => {
  const four = ['0001', '0002', '0003', '0004'].map((fid, i) => row({ franchise_id: fid, franchise_name: 'T' + fid, seed_ap: undefined, seed_ov_pct: undefined,
    playoff_seed: i < 2 ? i + 1 : null, playoff_status: i < 2 ? 'bye' : 'non_playoff' }));
  for (const [weekly, weeklyScores] of [[null, []], [[], null], [null, null], [undefined, undefined]]) {
    const out = RACE.race({ rows: four, weekly, weeklyScores });
    assert.strictEqual(out.weeklyUnreadable, true);
    const r = out.byFranchise['0003'];
    if (weeklyScores == null) assert.strictEqual(r.apGB, null, 'AP GB unavailable, not a preseason 0');
    assert.strictEqual(r.luck, null, 'luck unavailable, not 0');
    assert.strictEqual(r.expectedWins, null);
    if (weekly == null) { assert.deepStrictEqual([r.form5, r.form3], [null, null]); assert.strictEqual(r.gameLog, null); }
  }
  // …while a genuinely empty season ([] / []) is a TRUE zero
  const pre = RACE.race({ rows: four, weekly: [], weeklyScores: [] });
  assert.strictEqual(pre.weeklyUnreadable, false);
  assert.strictEqual(pre.byFranchise['0003'].luck, 0);
  assert.deepStrictEqual(pre.byFranchise['0003'].form5, []);
});

// ── Playoff-contamination protection (regression, prompted by a review
// finding that apGamesBack/divisionRace were falling back to full-season
// allplay_w/l/t when seed_ap was missing — the exact 2022 Good in Da
// Hood/Pure Greatness contamination pattern: their full-season AP was an
// exact tie at 127-60, but their real regular-season-through-Week-14
// records were 114-40 and 109-45. That fallback has been removed; these
// tests prove weeklyScores-derived AP ignores playoff weeks entirely and
// that a generic/full-season AP field can never override it. ─────────
function wsRow(w, fid, ts, po) { return { w: w, fid: fid, ts: ts, opt: ts, po: po ? 1 : 0 }; }
// 3 franchises, weeks 1-14 regular season (0001 clearly better than 0002
// every week), weeks 15-17 playoff (score pattern REVERSED so a
// full-season tally would flip or tie the order — the 2022 pattern).
function buildContaminationWeeklyScores(includePlayoffs) {
  const ws = [];
  for (let w = 1; w <= 14; w++) {
    ws.push(wsRow(w, '0001', 200, false)); // 0001 wins every reg-season week
    ws.push(wsRow(w, '0002', 100, false));
    ws.push(wsRow(w, '0003', 150, false));
  }
  if (includePlayoffs) {
    for (let w = 15; w <= 17; w++) {
      ws.push(wsRow(w, '0001', 50, true));  // 0001 collapses in the playoffs
      ws.push(wsRow(w, '0002', 300, true)); // 0002 dominates the playoffs
      ws.push(wsRow(w, '0003', 150, true));
    }
  }
  return ws;
}
function contaminationRows() {
  // No seed_ap / allplay_regseason_* on purpose — forces tier-3
  // derivation from weeklyScores, which is exactly the path under test.
  return [
    row({ franchise_id: '0001', franchise_name: 'RegSeasonBetter', division: '00', playoff_seed: null, playoff_status: 'non_playoff', seed_ap: undefined,
          allplay_w: 3, allplay_l: 39, allplay_t: 0, allplay_pct: 0.071 }), // deliberately CONTAMINATED full-season-shaped field — must never be used
    row({ franchise_id: '0002', franchise_name: 'PlayoffOnlyBetter', division: '00', playoff_seed: null, playoff_status: 'non_playoff', seed_ap: undefined,
          allplay_w: 39, allplay_l: 3, allplay_t: 0, allplay_pct: 0.929 }), // same — must never be used
    row({ franchise_id: '0003', franchise_name: 'Seed6', division: '01', is_division_leader: true, playoff_seed: 6, playoff_status: 'division_winner', seed_ap: undefined })
  ];
}
check('contamination: AP GB uses only Weeks 1-14 — adding Weeks 15-17 playoff scores does not change it', () => {
  const rows = contaminationRows();
  const gbRegOnly = RACE.apGamesBack(rows, buildContaminationWeeklyScores(false));
  const gbWithPlayoffs = RACE.apGamesBack(rows, buildContaminationWeeklyScores(true));
  assert.deepStrictEqual(gbWithPlayoffs, gbRegOnly, 'apGB must be identical whether or not playoff weeks are present in weeklyScores');
  // 0001 beat 0002 and 0003 every regular-season week (14-0-0 vs seed6's
  // 3's 0-14-0-ish record) — 0001 must be AHEAD of, i.e. have LESS GB
  // than, 0002 despite 0002's fabricated full-season allplay_pct being
  // far higher.
  assert.ok(gbRegOnly['0001'] < gbRegOnly['0002'], '0001 (regular-season leader) must show fewer AP games back than 0002, despite 0002\'s higher full-season allplay_pct');
});
check('contamination: division-race AP uses only Weeks 1-14 — adding playoff weeks does not change it', () => {
  const rows = contaminationRows();
  const drRegOnly = RACE.divisionRace(rows, '00', buildContaminationWeeklyScores(false));
  const drWithPlayoffs = RACE.divisionRace(rows, '00', buildContaminationWeeklyScores(true));
  assert.deepStrictEqual(drWithPlayoffs, drRegOnly, 'division-race AP values must be identical whether or not playoff weeks are present');
  const r1 = drRegOnly.find((d) => d.franchise_id === '0001');
  const r2 = drRegOnly.find((d) => d.franchise_id === '0002');
  assert.strictEqual(r1.ap.w, 28, '0001 must show its true 28-0-0 regular-season AP record (14 weeks x 2 opponents), not a full-season-contaminated one');
  assert.strictEqual(r2.ap.w, 0, '0002 must show its true 0-28-0 regular-season AP record');
});
check('contamination: a generic/full-season allplay_w/l/t field cannot override the derived regular-season record', () => {
  const rows = contaminationRows();
  const rec1 = RACE.apRecordForRow(rows.find((r) => r.franchise_id === '0001'), buildContaminationWeeklyScores(true), rows.map((r) => r.franchise_id));
  // The fixture's own allplay_w/allplay_l on franchise 0001 is {w:3,l:39}
  // (fabricated, contaminated-looking) — the resolved record must NOT
  // match that; it must be the true derived regular-season 28-0-0.
  assert.notStrictEqual(rec1.w, 3);
  assert.deepStrictEqual(rec1, { w: 28, l: 0, t: 0 });
});

// ── Source priority ──────────────────────────────────────────────────
check('source priority: valid seed_ap wins over every fallback, even when weeklyScores would derive something different', () => {
  const r = row({ franchise_id: '0001', seed_ap: ap(20, 5, 0), allplay_regseason_w: 1, allplay_regseason_l: 1, allplay_regseason_t: 0 });
  const rec = RACE.apRecordForRow(r, [wsRow(1, '0001', 10), wsRow(1, '0002', 999)]);
  assert.deepStrictEqual(rec, { w: 20, l: 5, t: 0 });
});
check('source priority: allplay_regseason_* wins when seed_ap is missing', () => {
  const r = row({ franchise_id: '0001', seed_ap: undefined, allplay_regseason_w: 9, allplay_regseason_l: 4, allplay_regseason_t: 1 });
  const rec = RACE.apRecordForRow(r, [wsRow(1, '0001', 10), wsRow(1, '0002', 999)]);
  assert.deepStrictEqual(rec, { w: 9, l: 4, t: 1 });
});
check('source priority: weekly-score derivation is used when both seed_ap and allplay_regseason_* are absent', () => {
  const r = row({ franchise_id: '0001', seed_ap: undefined });
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(1, '0003', 110)];
  const rec = RACE.apRecordForRow(r, ws, ['0001', '0002', '0003']);
  assert.deepStrictEqual(rec, { w: 1, l: 1, t: 0 }); // beat 0002 (90), lost to 0003 (110)
});
check('source priority: generic/full-season AP (allplay_w/l/t, allplay_pct) is never used at any tier', () => {
  const r = row({ franchise_id: '0001', seed_ap: undefined, allplay_w: 999, allplay_l: 0, allplay_t: 0, allplay_pct: 1.0 });
  const rec = RACE.apRecordForRow(r, [], ['0001']); // empty weeklyScores -> preseason tier -> {0,0,0}, never {999,0,0}
  assert.deepStrictEqual(rec, { w: 0, l: 0, t: 0 });
  assert.notStrictEqual(rec.w, 999);
});

// ── D1 — weekly-data completeness (fail closed on partial data) ───────
check('D1: a franchise present in Week 1 but missing from an otherwise-COMPLETE Week 2 makes the WHOLE table unavailable, not just that franchise', () => {
  // 3-team expected population. Week 1 has all 3. Week 2 is missing 0001
  // even though 0002/0003 both played -- a real "partially loaded week".
  const ws = [
    wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(1, '0003', 80),
    wsRow(2, '0002', 95), wsRow(2, '0003', 85) // 0001 missing from week 2
  ];
  const expected = ['0001', '0002', '0003'];
  const table = RACE.deriveRegSeasonApTable(ws, expected);
  assert.strictEqual(table.status, 'incomplete');
  assert.strictEqual(table.byFid, null);
  // Every franchise is affected, not just 0001 -- 0002 and 0003 also get null.
  const r1 = RACE.apRecordForRow(row({ franchise_id: '0001', seed_ap: undefined }), ws, expected);
  const r2 = RACE.apRecordForRow(row({ franchise_id: '0002', seed_ap: undefined }), ws, expected);
  assert.strictEqual(r1, null);
  assert.strictEqual(r2, null, 'must not silently give 0002/0003 a confident partial record just because THEY were present every week');
});
check('D1: one partially-populated week (some but not all expected franchises) invalidates the whole table', () => {
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0002', 90)]; // week 1 only has 2 of 3 expected franchises
  const table = RACE.deriveRegSeasonApTable(ws, ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'incomplete');
});
check('D1: a franchise absent from EVERY populated week also resolves to unavailable (not a fabricated 0-0-0)', () => {
  // Weeks 1-2 are each fully complete for 0001/0002 -- but 0003 (an
  // expected franchise) never appears in either. All weeks are otherwise
  // complete relative to a 2-team expectation... but since 0003 IS
  // expected, every week is short one franchise -> incomplete for all.
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(2, '0001', 80), wsRow(2, '0002', 70)];
  const table = RACE.deriveRegSeasonApTable(ws, ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'incomplete');
  const rec = RACE.apRecordForRow(row({ franchise_id: '0003', seed_ap: undefined }), ws, ['0001', '0002', '0003']);
  assert.strictEqual(rec, null);
});
check('D1: an invalid (unparseable) score is treated as absent, not zero -- causes the same week to fail completeness', () => {
  const ws = [wsRow(1, '0001', 100), { w: 1, fid: '0002', ts: 'NaN', po: 0 }, wsRow(1, '0003', 80)];
  const table = RACE.deriveRegSeasonApTable(ws, ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'incomplete', 'an unparseable score for 0002 leaves week 1 with only 2 of 3 expected franchises');
});
check('D1: a genuinely empty preseason payload is valid 0-0-0 for every expected franchise', () => {
  const table = RACE.deriveRegSeasonApTable([], ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'preseason');
  const rec = RACE.apRecordForRow(row({ franchise_id: '0001', seed_ap: undefined }), [], ['0001', '0002', '0003']);
  assert.deepStrictEqual(rec, { w: 0, l: 0, t: 0 });
});
check('D1: every week complete produces the expected full record for every franchise', () => {
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(1, '0003', 80), wsRow(2, '0001', 100), wsRow(2, '0002', 90), wsRow(2, '0003', 80)];
  const table = RACE.deriveRegSeasonApTable(ws, ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'ok');
  assert.deepStrictEqual(table.byFid['0001'], { w: 4, l: 0, t: 0 });
  assert.deepStrictEqual(table.byFid['0003'], { w: 0, l: 4, t: 0 });
});
check('D1: Tier 1 (seed_ap) and Tier 2 (allplay_regseason_*) still bypass weekly derivation even when the underlying weekly data is incomplete', () => {
  const incompleteWs = [wsRow(1, '0001', 100), wsRow(1, '0002', 90)]; // missing 0003 -> would be 'incomplete'
  const expected = ['0001', '0002', '0003'];
  const tier1 = RACE.apRecordForRow(row({ franchise_id: '0001', seed_ap: ap(20, 5, 0) }), incompleteWs, expected);
  assert.deepStrictEqual(tier1, { w: 20, l: 5, t: 0 });
  const tier2 = RACE.apRecordForRow(row({ franchise_id: '0001', seed_ap: undefined, allplay_regseason_w: 9, allplay_regseason_l: 4, allplay_regseason_t: 0 }), incompleteWs, expected);
  assert.deepStrictEqual(tier2, { w: 9, l: 4, t: 0 });
});

// ── D3 — conflicting duplicate weekly scores ────────────────────────────
check('D3: an IDENTICAL duplicate (week, fid) row is deduped safely and does not affect the result', () => {
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(1, '0003', 80)];
  const table = RACE.deriveRegSeasonApTable(ws, ['0001', '0002', '0003']);
  assert.strictEqual(table.status, 'ok');
  assert.deepStrictEqual(table.byFid['0001'], { w: 2, l: 0, t: 0 });
});
check('D3: a CONFLICTING duplicate (week, fid) row with a DIFFERENT score invalidates the whole table, regardless of row order', () => {
  const wsAB = [wsRow(1, '0001', 100), wsRow(1, '0001', 999), wsRow(1, '0002', 90), wsRow(1, '0003', 80)];
  const wsBA = [wsRow(1, '0001', 999), wsRow(1, '0001', 100), wsRow(1, '0002', 90), wsRow(1, '0003', 80)]; // reversed order
  assert.strictEqual(RACE.deriveRegSeasonApTable(wsAB, ['0001', '0002', '0003']).status, 'conflict');
  assert.strictEqual(RACE.deriveRegSeasonApTable(wsBA, ['0001', '0002', '0003']).status, 'conflict', 'row order must not change the outcome');
});
check('D3: a conflict affecting only ONE team invalidates the shared derivation for every team, not just the conflicted one', () => {
  const ws = [wsRow(1, '0001', 100), wsRow(1, '0001', 999), wsRow(1, '0002', 90), wsRow(1, '0003', 80)];
  const rec2 = RACE.apRecordForRow(row({ franchise_id: '0002', seed_ap: undefined }), ws, ['0001', '0002', '0003']);
  const rec3 = RACE.apRecordForRow(row({ franchise_id: '0003', seed_ap: undefined }), ws, ['0001', '0002', '0003']);
  assert.strictEqual(rec2, null, '0002 was never part of the conflicting rows but must still be unavailable — one shared table, one shared status');
  assert.strictEqual(rec3, null);
});

// ── Deduplication (safe, non-conflicting) ───────────────────────────────
check('deduplication: an identical duplicated (week, franchise) weeklyScores entry is compared against each other franchise ONCE, not once per duplicate row', () => {
  const ws = [
    wsRow(1, '0001', 100), // 0001's real week-1 score
    wsRow(1, '0001', 100), // an identical duplicate row for the SAME (week, fid) -- safe, deduped
    wsRow(1, '0002', 90),
    wsRow(1, '0003', 110)
  ];
  const rec = RACE.apRecordForRow(row({ franchise_id: '0001', seed_ap: undefined }), ws, ['0001', '0002', '0003']);
  assert.strictEqual(rec.w + rec.l + rec.t, 2, 'exactly one comparison per OTHER franchise, not per duplicate row');
  assert.deepStrictEqual(rec, { w: 1, l: 1, t: 0 });
});

// ── Completed-season regression (2025-shaped) + 2020/2021 still regular-season-only ──
check('completed season: playoff weeks (15-17) never change AP GB versus the regular-season-only (1-14) figure', () => {
  const regRows = contaminationRows(); // reuse — franchise 0003 is already seed 6
  const gbReg = RACE.apGamesBack(regRows, buildContaminationWeeklyScores(false));
  const gbFull = RACE.apGamesBack(regRows, buildContaminationWeeklyScores(true));
  assert.deepStrictEqual(gbFull, gbReg);
});
check('2020/2021 historical proof rows still resolve via seed_ap (tier 1), unaffected by the weeklyScores-derivation fix', () => {
  const blm = byFid(SEASON_2020, '0008');
  const cTown = byFid(SEASON_2020, '0009');
  assert.deepStrictEqual(RACE.apRecordForRow(blm, []), { w: 91, l: 52, t: 0 });
  assert.deepStrictEqual(RACE.apRecordForRow(cTown, []), { w: 91, l: 52, t: 0 });
});

// ── F3 — preseason must mean genuinely empty, never "rows discarded" ──
// Both deriveRegSeasonApTable and deriveRegSeasonOverallTable get the
// identical 8-case treatment: a franchise-relevant row with an
// unrecognized `po` value (missing/null/"x"/2/"00") must fail closed to
// 'incomplete', never be silently reinterpreted as "nobody has played".
function f3Suite(label, deriveTable, buildRow) {
  // buildRow(fid, ts, po, opp) -> a row shaped for this table (AP:
  // {w,fid,ts,po}; Overall: {w,fid,ts,opp,os,po}) so the same 8 cases
  // exercise both tables with their own natural row shape.
  check(label + ': empty array -> preseason', () => {
    const t = deriveTable([], ['0001', '0002']);
    assert.strictEqual(t.status, 'preseason');
    assert.deepStrictEqual(t.byFid, {});
  });
  check(label + ': all rows missing po (undefined) -> incomplete', () => {
    const rows = [buildRow('0001', 100, undefined, '0002'), buildRow('0002', 90, undefined, '0001')];
    const t = deriveTable(rows, ['0001', '0002']);
    assert.strictEqual(t.status, 'incomplete');
    assert.strictEqual(t.byFid, null);
  });
  check(label + ': all rows with malformed po (null / "x" / 2 / "00") -> incomplete', () => {
    ['null', '"x"', '2', '"00"'].forEach((label2, i) => {
      const poVal = [null, 'x', 2, '00'][i];
      const rows = [buildRow('0001', 100, poVal, '0002'), buildRow('0002', 90, poVal, '0001')];
      const t = deriveTable(rows, ['0001', '0002']);
      assert.strictEqual(t.status, 'incomplete', 'po=' + label2 + ' must fail closed');
      assert.strictEqual(t.byFid, null, 'po=' + label2);
    });
  });
  check(label + ': valid regular-season rows mixed with ONE malformed relevant row -> incomplete (not rescued by participation)', () => {
    // Weeks 1-2 are perfectly complete and valid; week 3 has a malformed
    // po for one relevant franchise. Requirement 4: must fail closed even
    // though plenty of valid data exists, and must NOT rely on the
    // participation check (which wouldn't even flag week 3, since both
    // 0001 and 0002 DO have a row there -- just one with garbage po).
    const rows = [
      buildRow('0001', 100, false, '0002'), buildRow('0002', 90, false, '0001'),
      buildRow('0001', 110, false, '0002', 2), buildRow('0002', 95, false, '0001', 2),
      buildRow('0001', 120, 'garbage', '0002', 3), buildRow('0002', 100, false, '0001', 3)
    ];
    const t = deriveTable(rows, ['0001', '0002']);
    assert.strictEqual(t.status, 'incomplete');
    assert.strictEqual(t.byFid, null);
  });
  check(label + ': only valid playoff rows (relevant, non-empty) -> incomplete, NOT preseason', () => {
    const rows = [buildRow('0001', 100, true, '0002'), buildRow('0002', 90, true, '0001')];
    const t = deriveTable(rows, ['0001', '0002']);
    assert.strictEqual(t.status, 'incomplete', 'relevant playoff-only data is not "nobody has played" — must not be preseason');
    assert.notStrictEqual(t.status, 'preseason');
  });
  check(label + ': valid numeric/string/boolean regular-season po flags (0 / "0" / false) all produce the SAME record', () => {
    const results = [0, '0', false].map((poVal) => {
      const rows = [buildRow('0001', 100, poVal, '0002'), buildRow('0002', 90, poVal, '0001')];
      return deriveTable(rows, ['0001', '0002']);
    });
    results.forEach((t) => assert.strictEqual(t.status, 'ok'));
    assert.deepStrictEqual(results[0].byFid, results[1].byFid);
    assert.deepStrictEqual(results[1].byFid, results[2].byFid);
  });
  check(label + ': valid numeric/string/boolean playoff po flags (1 / "1" / true) all stay excluded identically', () => {
    const results = [1, '1', true].map((poVal) => {
      const rows = [buildRow('0001', 100, poVal, '0002'), buildRow('0002', 90, poVal, '0001')];
      return deriveTable(rows, ['0001', '0002']);
    });
    // Each is relevant-but-all-playoff -> 'incomplete' per the case above, identically for every flag spelling.
    results.forEach((t) => assert.strictEqual(t.status, 'incomplete'));
  });
  check(label + ': a malformed po on an UNRELATED foreign franchise does not invalidate otherwise-valid expected-franchise data', () => {
    const rows = [
      buildRow('0001', 100, false, '0002'), buildRow('0002', 90, false, '0001'), // valid, expected
      buildRow('9999', 100, 'garbage', '8888') // foreign franchise, garbage po -- 9999/8888 are NOT in expected
    ];
    const t = deriveTable(rows, ['0001', '0002']);
    assert.strictEqual(t.status, 'ok', 'a foreign-franchise row must never poison the expected population\'s table, even with a malformed po');
    assert.ok(t.byFid['0001'] && t.byFid['0002']);
    assert.ok(!t.byFid.hasOwnProperty('9999'));
  });
}
f3Suite(
  'F3 AP',
  (rows, fids) => RACE.deriveRegSeasonApTable(rows, fids),
  (fid, ts, po, _opp, wk) => ({ w: wk || 1, fid: fid, ts: ts, po: po })
);
f3Suite(
  'F3 Overall',
  (rows, fids) => RACE.deriveRegSeasonOverallTable(rows, fids),
  (fid, ts, po, opp, wk) => ({ w: wk || 1, fid: fid, ts: ts, opp: opp, os: fid === '0001' ? 90 : 100, po: po })
);

for (const [name, fn] of checks) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails++; console.log('  FAIL ' + name + '\n         ' + (e && e.message || e)); }
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
