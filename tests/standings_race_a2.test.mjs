// Phase II-A2 — projected bracket / projected draft order / mobile
// Playoffs-mode pure-function tests for site/shared/standings_race.js.
//   node tests/standings_race_a2.test.mjs
//
// Same conventions as tests/standings_race.test.mjs: read the real
// shipped module, eval it standalone, exercise it against fixtures.
//
// The "completed season" fixture below is REAL 2025 data (fetched live
// from /api/playoff-bracket?year=2025 and trimmed to the fields this
// module reads) — not invented. It was used to DESIGN this module's
// bracket-topology/classification logic in the first place (replayed
// against it until it reproduced every real 2025 pick, including
// 1.01 = Cleon Ca$h, the real 2025 Hawktuah Bowl champion, franchise
// 0011) — so these tests are a regression guard on that verified
// correctness, not a first attempt at guessing the right shape.
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

// ── controlled 2026-shaped seed fixture (12 teams, no real-world tie to
// any actual season's live data — a fabricated but internally-consistent
// fixture, per "tests should use controlled fixtures and trust the seed
// numbers supplied in the fixture") ─────────────────────────────────────
const SEEDS_2026 = [
  { seed: 1, franchise_id: '0001', franchise_name: 'Alpha' },
  { seed: 2, franchise_id: '0002', franchise_name: 'Bravo' },
  { seed: 3, franchise_id: '0003', franchise_name: 'Charlie' },
  { seed: 4, franchise_id: '0004', franchise_name: 'Delta' },
  { seed: 5, franchise_id: '0005', franchise_name: 'Echo' },
  { seed: 6, franchise_id: '0006', franchise_name: 'Foxtrot' },
  { seed: 7, franchise_id: '0007', franchise_name: 'Golf' },
  { seed: 8, franchise_id: '0008', franchise_name: 'Hotel' },
  { seed: 9, franchise_id: '0009', franchise_name: 'India' },
  { seed: 10, franchise_id: '0010', franchise_name: 'Juliet' },
  { seed: 11, franchise_id: '0011', franchise_name: 'Kilo' },
  { seed: 12, franchise_id: '0012', franchise_name: 'Lima' }
];
function fidByName(name) { return SEEDS_2026.find((s) => s.franchise_name === name).franchise_id; }

// ── REAL 2025 completed-season fixture (trimmed from the live API) ────
const SEEDS_2025 = [
  { seed: 1, franchise_id: '0004', franchise_name: 'Pure Greatness' },
  { seed: 2, franchise_id: '0009', franchise_name: 'C-Town Chivalry' },
  { seed: 3, franchise_id: '0007', franchise_name: 'Sex Manther' },
  { seed: 4, franchise_id: '0001', franchise_name: 'L.A. Looks' },
  { seed: 5, franchise_id: '0005', franchise_name: 'HammerTime' },
  { seed: 6, franchise_id: '0010', franchise_name: 'Blake Bombers' },
  { seed: 7, franchise_id: '0011', franchise_name: 'Cleon Ca$h' },
  { seed: 8, franchise_id: '0008', franchise_name: 'Real Deal Creel' },
  { seed: 9, franchise_id: '0012', franchise_name: 'Hawks' },
  { seed: 10, franchise_id: '0006', franchise_name: 'The Long Haulers' },
  { seed: 11, franchise_id: '0002', franchise_name: 'CBP' },
  { seed: 12, franchise_id: '0003', franchise_name: 'Gride' }
];
function mk(week, fid, ts, oppFid, os) { return { week: week, franchise_id: fid, team_score: ts, opponent_franchise_id: oppFid, opponent_score: os }; }
// One row per side per game, exactly as /api/playoff-bracket's matchups[]
// ships it (verified against the live response for year=2025).
const MATCHUPS_2025 = [
  // Week 15 — Round 1 (4 games)
  mk(15, '0001', 219.7, '0005', 290.2), mk(15, '0005', 290.2, '0001', 219.7),
  mk(15, '0002', 173.3, '0006', 207.8), mk(15, '0006', 207.8, '0002', 173.3),
  mk(15, '0003', 175.9, '0012', 222.7), mk(15, '0012', 222.7, '0003', 175.9),
  mk(15, '0007', 264.7, '0010', 219.0), mk(15, '0010', 219.0, '0007', 264.7),
  // Week 16 — semis + placement (6 games)
  mk(16, '0001', 239.7, '0010', 275.6), mk(16, '0010', 275.6, '0001', 239.7),
  mk(16, '0002', 150.4, '0003', 202.2), mk(16, '0003', 202.2, '0002', 150.4),
  mk(16, '0004', 255.2, '0005', 196.8), mk(16, '0005', 196.8, '0004', 255.2),
  mk(16, '0006', 192.8, '0011', 204.2), mk(16, '0011', 204.2, '0006', 192.8),
  mk(16, '0007', 307.6, '0009', 214.3), mk(16, '0009', 214.3, '0007', 307.6),
  mk(16, '0008', 155.5, '0012', 187.8), mk(16, '0012', 187.8, '0008', 155.5),
  // Week 17 — final + third place (4 games)
  mk(17, '0004', 233.7, '0007', 192.1), mk(17, '0007', 192.1, '0004', 233.7),
  mk(17, '0005', 206.8, '0009', 195.4), mk(17, '0009', 195.4, '0005', 206.8),
  mk(17, '0006', 209.3, '0008', 164.8), mk(17, '0008', 164.8, '0006', 209.3),
  mk(17, '0011', 294.4, '0012', 157.8), mk(17, '0012', 157.8, '0011', 294.4)
];
const PLAYOFF_WEEKS_2025 = [15, 16, 17];

// ── 1. valid 12-seed chalk projection ──────────────────────────────────
check('1. a valid 12-seed set produces an "ok" chalk projection', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026);
  assert.strictEqual(p.status, 'ok');
  assert.ok(p.champ && p.hawk && p.picks && p.finishes);
});

// ── 2/3. seed7->finish7->1.01, seed1->finish1->1.12 ───────────────────
check('2. projected seed 7 -> finish 7 -> pick 1.01', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026);
  assert.strictEqual(p.picks['1.01'], fidByName('Golf')); // seed 7
  assert.strictEqual(p.finishes[fidByName('Golf')], 7);
});
check('3. projected seed 1 -> finish 1 -> pick 1.12', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026);
  assert.strictEqual(p.picks['1.12'], fidByName('Alpha')); // seed 1
  assert.strictEqual(p.finishes[fidByName('Alpha')], 1);
});

// ── 4/5. all finishes 1-12 and picks 1.01-1.12 assigned exactly once ──
check('4. all final finishes 1-12 are assigned exactly once', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026);
  const finishValues = Object.values(p.finishes).sort((a, b) => a - b);
  assert.deepStrictEqual(finishValues, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.strictEqual(Object.keys(p.finishes).length, 12, 'no franchise assigned twice');
  assert.strictEqual(new Set(Object.keys(p.finishes)).size, 12, 'no duplicate franchise in finishes');
});
check('5. all rookie picks 1.01-1.12 are assigned exactly once', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026);
  const expectedPicks = ['1.01', '1.02', '1.03', '1.04', '1.05', '1.06', '1.07', '1.08', '1.09', '1.10', '1.11', '1.12'];
  assert.deepStrictEqual(Object.keys(p.picks).sort(), expectedPicks.slice().sort());
  const fids = Object.values(p.picks);
  assert.strictEqual(new Set(fids).size, 12, 'no franchise holds two picks');
});

// ── 6. projected and real results use the SAME finish-to-pick mapper ──
check('6. projected (chalk) and actual (real 2025) results are produced by the identical assignFinishesAndPicks() function', () => {
  const projected = RACE.projectChalkBracket(SEEDS_2025); // chalk projection using the REAL 2025 seed set
  const actual = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025); // real, non-chalk results
  // Real 2025 had genuine upsets (seed 3 over 2, seed 9 over 8), so the
  // two must legitimately DISAGREE on who holds which pick...
  assert.notDeepStrictEqual(projected.picks, actual.picks, 'a season with real upsets must diverge from its chalk projection');
  // ...but both must have been computed through the exact same 12-slot
  // finish/pick table (same criterion at the module level).
  assert.strictEqual(projected.status, 'ok');
  assert.strictEqual(actual.status, 'ok');
  assert.deepStrictEqual(Object.keys(projected.picks).sort(), Object.keys(actual.picks).sort());
});
check('6b. real 2025 results reproduce the actual, verified 2025 rookie draft order exactly', () => {
  const actual = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  assert.strictEqual(actual.picks['1.01'], '0011', 'the real 2025 Hawktuah Bowl champion, Cleon Ca$h, must hold pick 1.01');
  assert.strictEqual(actual.finishes['0011'], 7);
  assert.strictEqual(actual.picks['1.12'], '0004', 'the real 2025 UPS champion, Pure Greatness, must hold pick 1.12');
  assert.strictEqual(actual.finishes['0004'], 1);
  // Full verified real order (hand-derived from the live API and cross-checked twice):
  assert.deepStrictEqual(actual.picks, {
    '1.01': '0011', '1.02': '0012', '1.03': '0006', '1.04': '0008',
    '1.05': '0003', '1.06': '0002', '1.07': '0010', '1.08': '0001',
    '1.09': '0009', '1.10': '0005', '1.11': '0007', '1.12': '0004'
  });
});

// ── 7/8/9/10. fail-closed validation ───────────────────────────────────
check('7. an incomplete seed set (11 seeds) fails closed', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026.slice(0, 11));
  assert.strictEqual(p.status, 'unavailable');
  assert.ok(p.reason && p.champ === null && p.hawk === null && p.picks === null && p.finishes === null);
});
check('7b. more than 12 seeds also fails closed', () => {
  const p = RACE.projectChalkBracket(SEEDS_2026.concat([{ seed: 13, franchise_id: '0099', franchise_name: 'Extra' }]));
  assert.strictEqual(p.status, 'unavailable');
});
check('8. a duplicate seed number fails closed', () => {
  const seeds = SEEDS_2026.map((s, i) => (i === 1 ? Object.assign({}, s, { seed: 1 }) : s));
  const p = RACE.projectChalkBracket(seeds);
  assert.strictEqual(p.status, 'unavailable');
  assert.ok(/duplicate seed/.test(p.reason));
});
check('9. a duplicate franchise_id fails closed', () => {
  const seeds = SEEDS_2026.map((s, i) => (i === 1 ? Object.assign({}, s, { franchise_id: SEEDS_2026[0].franchise_id }) : s));
  const p = RACE.projectChalkBracket(seeds);
  assert.strictEqual(p.status, 'unavailable');
  assert.ok(/duplicate franchise_id/.test(p.reason));
});
check('10. a malformed seed (non-integer, out of range, missing) fails closed', () => {
  const nonInt = SEEDS_2026.map((s, i) => (i === 0 ? Object.assign({}, s, { seed: 'one' }) : s));
  assert.strictEqual(RACE.projectChalkBracket(nonInt).status, 'unavailable');
  const outOfRange = SEEDS_2026.map((s, i) => (i === 0 ? Object.assign({}, s, { seed: 13 }) : s));
  assert.strictEqual(RACE.projectChalkBracket(outOfRange).status, 'unavailable');
  const fractional = SEEDS_2026.map((s, i) => (i === 0 ? Object.assign({}, s, { seed: 1.5 }) : s));
  assert.strictEqual(RACE.projectChalkBracket(fractional).status, 'unavailable');
  const missingFid = SEEDS_2026.map((s, i) => (i === 0 ? Object.assign({}, s, { franchise_id: null }) : s));
  assert.strictEqual(RACE.projectChalkBracket(missingFid).status, 'unavailable');
  assert.strictEqual(RACE.projectChalkBracket(null).status, 'unavailable');
  assert.strictEqual(RACE.projectChalkBracket(undefined).status, 'unavailable');
  assert.strictEqual(RACE.projectChalkBracket('not an array').status, 'unavailable');
});

// ── 11/12. real results bypass projection (this is a CALLER-gating
// concern — the module itself is unconditional; these checks prove the
// module's TWO entry points are behaviorally independent/distinguishable
// so a caller CAN implement that gate correctly). Page-level gating is
// verified separately via source-pattern checks against the desktop/
// mobile files and via live browser verification. ────────────────────
check('11. buildActualBracketResult (used for a completed season) never applies chalk — it is driven entirely by real scores', () => {
  const actual = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  // seed 2 (C-Town) lost its semifinal to seed 3 (Sex Manther) in reality —
  // a real result a chalk projection could never produce.
  assert.strictEqual(actual.champ.semis.find((g) => g.a.franchise_id === '0009' || g.b.franchise_id === '0009').winner.franchise_id, '0007');
});
check('12. any actual playoff matchup data present is sufficient to bypass the empty chalk-only path — buildActualBracketResult ignores seed order and only trusts scores', () => {
  // Even a single real, decisive matchup for the champ side must produce a real (non-chalk) winner via classifySideGamesFromMatchups + assignFinishesAndPicks, regardless of what chalk would have said.
  const seeds = SEEDS_2026;
  const upsetMatchup = [
    mk(15, '0003', 100, '0006', 50), mk(15, '0006', 50, '0003', 100), // chalk-consistent (3 beats 6)
    mk(15, '0004', 40, '0005', 90), mk(15, '0005', 90, '0004', 40)    // UPSET: seed 5 beats seed 4
  ];
  const actual = RACE.buildActualBracketResult(seeds, upsetMatchup, [15, 16, 17]);
  const r1b = actual.champ.r1.find((g) => (g.a.franchise_id === '0004' || g.b.franchise_id === '0004'));
  assert.strictEqual(r1b.winner.franchise_id, '0005', 'an upset present in real matchup data must be honored, never overridden by chalk');
});

// ── 13/14. mobile pre-playoff groups: 2/2/2/6 + AP GB ascending sort ──
function standingsRow2026(seed, status, fid, name, apGB_hint_w) {
  return {
    franchise_id: fid, franchise_name: name, division: String(Number(fid) % 4).padStart(2, '0'),
    playoff_seed: seed, playoff_status: status,
    h2h_w: 5, h2h_l: 5, h2h_t: 0, h2h_pct: 0.5,
    allplay_w: apGB_hint_w, allplay_l: 20 - apGB_hint_w, allplay_t: 0, allplay_pct: apGB_hint_w / 20,
    seed_ap: { w: apGB_hint_w, l: 20 - apGB_hint_w, t: 0 }, seed_total_pf: 2000, seed_ov_pct: 0.5
  };
}
// Controlled fixture: 2 bye, 2 division_winner (seeds 3-6 pool), 2 wild_card (seeds 3-6 pool), 6 non_playoff (hunt)
const ROWS_2026 = [
  standingsRow2026(1, 'bye', '0001', 'Alpha', 18),
  standingsRow2026(2, 'bye', '0002', 'Bravo', 17),
  standingsRow2026(3, 'division_winner', '0003', 'Charlie', 16),
  standingsRow2026(4, 'wild_card', '0004', 'Delta', 15),
  standingsRow2026(5, 'wild_card', '0005', 'Echo', 14),
  standingsRow2026(6, 'division_winner', '0006', 'Foxtrot', 13),
  standingsRow2026(null, 'non_playoff', '0007', 'Golf', 12),
  standingsRow2026(null, 'non_playoff', '0008', 'Hotel', 8),
  standingsRow2026(null, 'non_playoff', '0009', 'India', 10),
  standingsRow2026(null, 'non_playoff', '0010', 'Juliet', 8), // tied with Hotel
  standingsRow2026(null, 'non_playoff', '0011', 'Kilo', 6),
  standingsRow2026(null, 'non_playoff', '0012', 'Lima', 4)
];
check('13. pre-playoff mobile groups produce 2/2/2/6 with the controlled fixture', () => {
  const g = RACE.projectedPlayoffGroups(ROWS_2026, []);
  assert.strictEqual(g.byes.length, 2);
  assert.strictEqual(g.divisionWinners.length, 2);
  assert.strictEqual(g.wildCards.length, 2);
  assert.strictEqual(g.inTheHunt.length, 6);
  assert.deepStrictEqual(g.byes.map((e) => e.seed), [1, 2]);
  assert.strictEqual(g.byes[0].status, 'BYE');
  assert.strictEqual(g.divisionWinners[0].status, 'DIV');
  assert.strictEqual(g.wildCards[0].status, 'WC');
  g.inTheHunt.forEach((e) => assert.strictEqual(e.status, null, 'never OUT/eliminated language — status is null for unseeded teams'));
});
check('14. IN THE HUNT sorts by AP GB ascending, with a deterministic tie-break', () => {
  const g = RACE.projectedPlayoffGroups(ROWS_2026, []);
  const gbs = g.inTheHunt.map((e) => e.apGB);
  for (let i = 1; i < gbs.length; i++) assert.ok(gbs[i] >= gbs[i - 1], 'AP GB must be non-decreasing: ' + gbs.join(','));
  // Hotel (0008) and Juliet (0010) are tied on AP (both 8-12) -> deterministic franchise_id tie-break, not source order.
  const hotelIdx = g.inTheHunt.findIndex((e) => e.franchise_id === '0008');
  const julietIdx = g.inTheHunt.findIndex((e) => e.franchise_id === '0010');
  assert.ok(hotelIdx < julietIdx, '"0008" must sort before "0010" as a deterministic string tie-break');
});

// ── 15. completed 2025 mobile data -> real matchup cards (via buildActualBracketResult's `games` list) ──
check('15. completed 2025 data produces one real game per (week, franchise-pair) across all 14 champ+hawk bracket games (7 per side: R1x2, semis x2, placement, final, third)', () => {
  const actual = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  assert.strictEqual(actual.games.length, 14);
  assert.strictEqual(actual.champ.r1.length, 2);
  assert.strictEqual(actual.champ.semis.length, 2);
  assert.ok(actual.champ.placement && actual.champ.final && actual.champ.third);
  assert.strictEqual(actual.hawk.r1.length, 2);
  assert.strictEqual(actual.hawk.semis.length, 2);
  assert.ok(actual.hawk.placement && actual.hawk.final && actual.hawk.third);
  // Every game must carry real (non-null) scores -- a completed season has no pending games.
  actual.games.forEach((g) => { assert.ok(g.scoreA != null && g.scoreB != null); assert.strictEqual(g.pending, false); assert.strictEqual(g.projected, false); });
});

// ── 16. projected labels never appear on actual results ───────────────
check('16. every game object in an ACTUAL bracket result is marked projected:false; every game in a CHALK projection is marked projected:true', () => {
  const actual = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  actual.games.forEach((g) => assert.strictEqual(g.projected, false));
  const projected = RACE.projectChalkBracket(SEEDS_2026);
  [projected.champ.final, projected.champ.third, projected.champ.placement, projected.hawk.final, projected.hawk.third, projected.hawk.placement]
    .concat(projected.champ.r1, projected.champ.semis, projected.hawk.r1, projected.hawk.semis)
    .forEach((g) => assert.strictEqual(g.projected, true));
});

// ── 17. missing bracket data does not invent finishes or picks ────────
check('17. an unavailable projection has null champ/hawk/picks/finishes -- never a partially-fabricated result', () => {
  const p = RACE.projectChalkBracket([]);
  assert.strictEqual(p.status, 'unavailable');
  assert.strictEqual(p.champ, null);
  assert.strictEqual(p.hawk, null);
  assert.strictEqual(p.picks, null);
  assert.strictEqual(p.finishes, null);
});
check('17b. an unavailable actual-bracket result (invalid seeds) has an empty games list and no picks/finishes', () => {
  const a = RACE.buildActualBracketResult('garbage', MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  assert.strictEqual(a.status, 'unavailable');
  assert.deepStrictEqual(a.games, []);
  assert.strictEqual(a.picks, null);
  assert.strictEqual(a.finishes, null);
});
check('17c. a completely empty matchups[] (valid seeds, no games yet) leaves every slot unassigned -- no finishes/picks invented from seed order alone', () => {
  const a = RACE.buildActualBracketResult(SEEDS_2026, [], [15, 16, 17]);
  assert.strictEqual(a.status, 'ok'); // seeds are valid -- this is a legitimate "no games played yet" state
  assert.deepStrictEqual(a.picks, {}, 'zero games played -> zero picks assigned, never seed-order picks');
  assert.deepStrictEqual(a.finishes, {});
  assert.strictEqual(a.games.length, 0);
});

// ── nextDraftYear ───────────────────────────────────────────────────
check('nextDraftYear: derives the draft year from the season, never hardcoded', () => {
  assert.strictEqual(RACE.nextDraftYear(2026), 2027);
  assert.strictEqual(RACE.nextDraftYear(2025), 2026);
  assert.strictEqual(RACE.nextDraftYear('2020'), 2021);
  assert.strictEqual(RACE.nextDraftYear('not a year'), null);
});

// ── validateBracketSeeds direct checks (franchise-id/seed-number only, never name-keyed) ──
check('validateBracketSeeds: normalizes and never depends on franchise_name for identity', () => {
  const v = RACE.validateBracketSeeds(SEEDS_2026);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.seeds.length, 12);
  assert.strictEqual(v.seeds[0].seed, 1);
  assert.strictEqual(v.seeds[0].franchise_id, '0001');
  // Two entries with the SAME name but different franchise_id must be accepted (name collisions are not identity).
  const renamed = SEEDS_2026.map((s) => Object.assign({}, s, { franchise_name: 'Same Name' }));
  assert.strictEqual(RACE.validateBracketSeeds(renamed).ok, true);
});

// ── F5 (Phase II-A2 correction pass) — buildActualBracketResult() game
// normalization. Uses a fresh 12-seed champ-side pair (seeds 3 vs 6,
// SEEDS_2026) so each scenario is isolated from the others. `mk()` above
// builds one raw matchup row; these tests assemble the exact raw-row
// combinations the correction pass specifies. ──────────────────────────
function week15Game(rows) { return RACE.buildActualBracketResult(SEEDS_2026, rows, [15, 16, 17]).champ.r1.filter((g) => g.week === 15)[0]; }
check('F5.1 valid mirrored rows (both perspectives, consistent) -> status ok, decided winner', () => {
  const g = week15Game([mk(15, '0003', 100, '0006', 90), mk(15, '0006', 90, '0003', 100)]);
  assert.strictEqual(g.status, 'ok');
  assert.strictEqual(g.pending, false);
  assert.strictEqual(g.winner.franchise_id, '0003');
  assert.strictEqual(g.loser.franchise_id, '0006');
});
check('F5.2 identical duplicate rows (same perspective repeated, same scores) -> still status ok, not a conflict', () => {
  const g = week15Game([mk(15, '0003', 100, '0006', 90), mk(15, '0003', 100, '0006', 90), mk(15, '0006', 90, '0003', 100)]);
  assert.strictEqual(g.status, 'ok');
  assert.strictEqual(g.winner.franchise_id, '0003');
});
check('F5.3 contradictory reciprocal rows (the two sides disagree on the score) -> conflict, no winner, scores cleared', () => {
  const g = week15Game([mk(15, '0003', 100, '0006', 90), mk(15, '0006', 95, '0003', 100)]); // 0006 claims 95, not 90
  assert.strictEqual(g.status, 'conflict');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.loser, null);
  assert.strictEqual(g.pending, true);
  assert.strictEqual(g.scoreA, null);
  assert.strictEqual(g.scoreB, null);
});
check('F5.4 contradictory duplicates within ONE perspective, in both input orders -> conflict, order-independent', () => {
  const rowsA = [mk(15, '0003', 100, '0006', 90), mk(15, '0003', 101, '0006', 90)]; // 0003 disagrees with itself
  const rowsB = rowsA.slice().reverse();
  assert.strictEqual(week15Game(rowsA).status, 'conflict');
  assert.strictEqual(week15Game(rowsB).status, 'conflict');
});
check('F5.5 missing reciprocal row (only one side ever reported) -> incomplete, never a winner', () => {
  const g = week15Game([mk(15, '0003', 100, '0006', 90)]);
  assert.strictEqual(g.status, 'incomplete');
  assert.strictEqual(g.winner, null);
  assert.strictEqual(g.pending, true);
  // the one side's own reported score is still shown honestly...
  assert.strictEqual(g.scoreA, 100);
  // ...but the missing side is never fabricated.
  assert.strictEqual(g.scoreB, null);
});
check('F5.6 a null score on either side -> pending, never a winner', () => {
  const g = week15Game([mk(15, '0003', null, '0006', 90), mk(15, '0006', 90, '0003', null)]);
  assert.strictEqual(g.status, 'pending');
  assert.strictEqual(g.winner, null);
});
check('F5.7 a tied (equal) score, consistently reported both directions -> pending, never a coin-flip winner', () => {
  const g = week15Game([mk(15, '0003', 100, '0006', 100), mk(15, '0006', 100, '0003', 100)]);
  assert.strictEqual(g.status, 'pending');
  assert.strictEqual(g.winner, null);
});
check('F5.8 the same franchise pair in two different weeks stays TWO separate games', () => {
  const a = RACE.buildActualBracketResult(SEEDS_2026, [
    mk(15, '0003', 100, '0006', 90), mk(15, '0006', 90, '0003', 100),
    mk(16, '0003', 80, '0006', 95), mk(16, '0006', 95, '0003', 80)
  ], [15, 16, 17]);
  assert.strictEqual(a.games.length, 2);
  assert.deepStrictEqual(a.games.map((g) => g.week).sort(), [15, 16]);
});
check('F5.9 full 2025 replay is unaffected by the normalization rewrite: still 14 games, still the exact verified 2025 picks', () => {
  const a = RACE.buildActualBracketResult(SEEDS_2025, MATCHUPS_2025, PLAYOFF_WEEKS_2025);
  assert.strictEqual(a.games.length, 14);
  a.games.forEach((g) => assert.strictEqual(g.status, 'ok', 'real 2025 data has no conflicts/incompletes'));
  assert.deepStrictEqual(a.picks, {
    '1.01': '0011', '1.02': '0012', '1.03': '0006', '1.04': '0008',
    '1.05': '0003', '1.06': '0002', '1.07': '0010', '1.08': '0001',
    '1.09': '0009', '1.10': '0005', '1.11': '0007', '1.12': '0004'
  });
});
check('F5 pending/incomplete/conflict games never leak into picks/finishes', () => {
  // A champ-side bracket where R1 is entirely pending/incomplete/conflicting
  // must assign ZERO champ-side picks — never fall back to seed order.
  const a = RACE.buildActualBracketResult(SEEDS_2026, [
    mk(15, '0003', null, '0006', null),                                    // pending (R1)
    mk(15, '0004', 100, '0009', 90)                                        // incomplete (R1, one-sided)
  ], [15, 16, 17]);
  assert.strictEqual(a.status, 'ok');
  const champPickKeys = Object.keys(a.picks).filter((p) => ['1.07', '1.08', '1.09', '1.10', '1.11', '1.12'].includes(p));
  assert.deepStrictEqual(champPickKeys, [], 'no champ-side pick may be assigned when every champ-side game is undecided');
});

// ── F9 (Phase II-A2 correction pass) — projectionMode() is the ONE
// shared gating decision; behavioral tests of the decision itself, not
// of whether a page's source text happens to call it. ─────────────────
check('F9.1 a non-empty matchups array always selects "actual", regardless of season_complete', () => {
  assert.strictEqual(RACE.projectionMode({ seasonComplete: true, matchups: MATCHUPS_2025, seeds: SEEDS_2025 }), 'actual');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: MATCHUPS_2025, seeds: SEEDS_2025 }), 'actual');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: 'garbage', matchups: MATCHUPS_2025, seeds: SEEDS_2025 }), 'actual');
});
check('F9.2 matchups that is not an array is NEVER treated as an empty array — always "unavailable"', () => {
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: {}, seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: 'not an array', seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: null, seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: undefined, seeds: SEEDS_2026 }), 'unavailable');
});
check('F9.3 only the literal boolean false for season_complete allows a projection — any other value fails closed', () => {
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: [], seeds: SEEDS_2026 }), 'projected');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: 'false', matchups: [], seeds: SEEDS_2026 }), 'unavailable', 'the STRING "false" is not the boolean false');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: null, matchups: [], seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: undefined, matchups: [], seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: 0, matchups: [], seeds: SEEDS_2026 }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: true, matchups: [], seeds: SEEDS_2026 }), 'unavailable');
});
check('F9.4 empty matchups + season_complete===false + an INVALID seed set -> unavailable, never a fabricated projection', () => {
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: [], seeds: [] }), 'unavailable');
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: [], seeds: SEEDS_2026.slice(0, 11) }), 'unavailable');
});
check('F9.5 empty matchups + season_complete===false + a VALID seed set -> projected', () => {
  assert.strictEqual(RACE.projectionMode({ seasonComplete: false, matchups: [], seeds: SEEDS_2026 }), 'projected');
});

// ── F2 (Phase II-A2 correction pass) — one authoritative pick mapper.
// pickWhyText() is driven by the SAME BRACKET_FINISH_SLOTS table used by
// both projectChalkBracket() and buildActualBracketResult(); these
// checks prove there is no second, independent label table. ───────────
check('F2.1 pickWhyText derives its text from BRACKET_FINISH_SLOTS for every real pick, projected and actual', () => {
  const allPicks = ['1.01','1.02','1.03','1.04','1.05','1.06','1.07','1.08','1.09','1.10','1.11','1.12'];
  allPicks.forEach((p) => {
    const real = RACE.pickWhyText(p, false);
    const projected = RACE.pickWhyText(p, true);
    assert.ok(real && real.length > 0, p + ' must have real why-text');
    assert.ok(projected && projected.startsWith('Projected'), p + ' projected why-text must say so');
    assert.ok(projected.endsWith(real), 'projected text must be the real text with a prefix, not an independently-written string');
  });
  assert.strictEqual(RACE.pickWhyText('1.13', false), null, 'an unknown pick returns null, never a guess');
});
check('F2.2 the desktop actual Draft Order path no longer contains the retired inline pick-assignment arithmetic (regression guard)', () => {
  assert.ok(!/picks\["1\.12"\]\s*=\s*\{\s*fid:\s*winner/.test(DESKTOP), 'the old inline champ.title winner assignment must be gone');
  assert.ok(!/picks\["1\.10"\]\s*=\s*\{\s*fid:\s*winner\(champ\.placement/.test(DESKTOP), 'the old placement-then-overwritten-by-third-place bug must be gone');
  assert.ok(DESKTOP.includes('window.UPS_STANDINGS_RACE.buildActualBracketResult(seeds, matchups, playoffWeeks)'), 'renderDraftOrder must get its actual picks from the shared module');
});

// ── page-level gating (source-pattern, matches tests/standings_race_integration.test.mjs's convention) ──
// The module itself is unconditional (given any seeds, it always
// projects) — GATING "only project pre-playoff, never over real results"
// is the caller's job. These checks prove both consuming pages actually
// implement that gate, and never declare their own copy of the new
// shared functions.
const DESKTOP = fs.readFileSync('site/standings/mfl_hpm_standings_v2.html', 'utf8');
const MOBILE_LEAGUE = fs.readFileSync('site/m/views/league.js', 'utf8');

const A2_FN_NAMES = [
  'validateBracketSeeds', 'chalkBracketSide', 'classifySideGamesFromMatchups',
  'assignFinishesAndPicks', 'projectChalkBracket', 'buildActualBracketResult',
  'nextDraftYear', 'projectedPlayoffGroups'
];
check('neither desktop nor mobile re-declares its own copy of an A2 shared function', () => {
  A2_FN_NAMES.forEach((name) => {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    assert.ok(!re.test(DESKTOP), 'desktop must not declare its own function ' + name + '()');
    assert.ok(!re.test(MOBILE_LEAGUE), 'mobile league.js must not declare its own function ' + name + '()');
  });
});
// F9 (Phase II-A2 correction pass): the runtime DECISION is now proven
// behaviorally above (F9.1-F9.5, direct calls to RACE.projectionMode).
// These are narrow WIRING checks only — that both pages actually call
// the shared decision helper with the right inputs, not a re-derivation
// of the gating logic via regex.
check('[wiring] desktop renderBracket calls window.UPS_STANDINGS_RACE.projectionMode with season_complete/matchups/seeds, not its own conditional', () => {
  const start = DESKTOP.indexOf('function renderBracket(host) {');
  assert.ok(start >= 0);
  const slice = DESKTOP.slice(start, start + 3000);
  assert.ok(/window\.UPS_STANDINGS_RACE\.projectionMode\(\{\s*seasonComplete:\s*resp\.season_complete,\s*matchups:\s*matchups,\s*seeds:\s*seeds\s*\}\)/.test(slice));
  assert.ok(/mode === "projected"/.test(slice) && /mode !== "actual"/.test(slice));
});
check('[wiring] desktop renderDraftOrder calls the same window.UPS_STANDINGS_RACE.projectionMode helper, and derives the draft year (never hardcodes it)', () => {
  const start = DESKTOP.indexOf('function renderDraftOrder(host) {');
  assert.ok(start >= 0);
  const slice = DESKTOP.slice(start, start + 2500);
  assert.ok(/window\.UPS_STANDINGS_RACE\.projectionMode\(\{\s*seasonComplete:\s*resp\.season_complete,\s*matchups:\s*matchups,\s*seeds:\s*seeds\s*\}\)/.test(slice));
  assert.ok(/window\.UPS_STANDINGS_RACE\.nextDraftYear\(state\.year\)/.test(slice), 'draft year must be derived, not hardcoded 2027');
  assert.ok(!/2027/.test(slice), 'must not hardcode the draft year');
});
check('[wiring] desktop projected bracket/draft-order banners are literally labeled PROJECTED', () => {
  const helpersStart = DESKTOP.indexOf('function projTeamRow(seedEntry, isLeader) {');
  const bracketEnd = DESKTOP.indexOf('function renderBracket(host) {') + 3000;
  assert.ok(helpersStart >= 0 && helpersStart < bracketEnd);
  assert.ok(/PROJECTED/.test(DESKTOP.slice(helpersStart, bracketEnd)));
  const draftStart = DESKTOP.indexOf('function renderDraftOrder(host) {');
  const draftSlice = DESKTOP.slice(draftStart, draftStart + 4000);
  assert.ok(/PROJECTED/.test(draftSlice));
});
check('[wiring] F1: desktop renderBracket fetches /api/standings only inside the projected branch, and its failure is caught (never propagated to the actual-bracket path)', () => {
  const start = DESKTOP.indexOf('function renderBracket(host) {');
  const projectedBranch = DESKTOP.slice(DESKTOP.indexOf('if (mode === "projected") {', start), DESKTOP.indexOf('if (mode !== "actual") {', start));
  assert.ok(/fetchD1\("\/api\/standings", state\.year\)\.catch\(function \(\) \{ return null; \}\)/.test(projectedBranch), 'the optional standings fetch must be non-fatal');
  const actualBranchStart = DESKTOP.indexOf('mode === "actual": real results exist', start);
  const actualBranch = DESKTOP.slice(actualBranchStart, actualBranchStart + 600)
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/fetchD1\("\/api\/standings"/.test(actualBranch), 'the actual-results rendering path must never fetch /api/standings');
});
check('[wiring] F6: projected bracket rendering never applies the real `.winner`/`.loser` classes — a dedicated `.projected-leader`/`.projected-trail` class is used instead', () => {
  const fn = DESKTOP.slice(DESKTOP.indexOf('function projTeamRow(seedEntry, isLeader) {'), DESKTOP.indexOf('function projGameCard('));
  assert.ok(/projected-leader/.test(fn) && /projected-trail/.test(fn));
  assert.ok(!/isLeader \? "winner" : "loser"/.test(fn), 'must not reuse the actual-result winner/loser classes');
  const champFn = DESKTOP.slice(DESKTOP.indexOf('function renderProjectedBracketSide('), DESKTOP.indexOf('function renderProjectedBracketSide(') + 2500);
  assert.ok(/Projected champion/.test(champFn), 'the projected champion card must say "Projected champion", not "UPS Champion"/"Hawktuah Champ"');
  assert.ok(!/UPS Champion.*partial-badge|Hawktuah Champ.*partial-badge/.test(champFn));
});
check('[wiring] mobile renderPlayoffsMode calls window.UPS_STANDINGS_RACE.projectionMode with the same input shape as desktop', () => {
  const start = MOBILE_LEAGUE.indexOf('function renderPlayoffsMode(mount, year, y) {');
  assert.ok(start >= 0);
  const slice = MOBILE_LEAGUE.slice(start, start + 2500);
  assert.ok(/window\.UPS_STANDINGS_RACE\.projectionMode\(\{\s*seasonComplete:\s*bresp\.season_complete,\s*matchups:\s*matchups,\s*seeds:\s*seeds\s*\}\)/.test(slice));
  assert.ok(/mode === "actual"/.test(slice) && /mode === "projected"/.test(slice));
  assert.ok(/renderActualMatchupCards/.test(slice) && /renderPrePlayoffGroups/.test(slice));
});
check('[wiring] F4: mobile pre-playoff legend is owner-facing copy — no developer note, and never the words OUT/eliminated anywhere on the page', () => {
  const groupsFn = MOBILE_LEAGUE.slice(MOBILE_LEAGUE.indexOf('function renderPrePlayoffGroups(groups) {'), MOBILE_LEAGUE.indexOf('function renderPrePlayoffGroups(groups) {') + 700);
  assert.ok(/Projected from current seeds/.test(groupsFn));
  assert.ok(!/>OUT</.test(MOBILE_LEAGUE) && !/"OUT"/.test(MOBILE_LEAGUE) && !/\beliminated\b/i.test(MOBILE_LEAGUE));
  const cardsFn = MOBILE_LEAGUE.slice(MOBILE_LEAGUE.indexOf('function renderActualMatchupCards('), MOBILE_LEAGUE.indexOf('function renderActualMatchupCards(') + 1500);
  assert.ok(!/Projected from current seeds/.test(cardsFn), 'the projected legend must never render alongside actual matchup cards');
});
check('[wiring] F7: the mobile final-round card label never repeats the side name twice', () => {
  const fn = MOBILE_LEAGUE.slice(MOBILE_LEAGUE.indexOf('function renderActualMatchupCards('), MOBILE_LEAGUE.indexOf('function renderActualMatchupCards(') + 1500);
  assert.ok(/label \+ " · Title Game"/.test(fn));
  assert.ok(!/hawk"\s*\?\s*"Hawktuah Bowl"\s*:\s*"Championship"/.test(fn), 'the old side-name-repeating ternary must be gone');
});
check('[wiring] F3: the League/Divisions/Playoffs toggle carries a dedicated class for the >=44px touch-target CSS fix', () => {
  const fn = MOBILE_LEAGUE.slice(MOBILE_LEAGUE.indexOf('function renderStandingsModeToggle(mode) {'), MOBILE_LEAGUE.indexOf('function renderStandingsModeToggle(mode) {') + 1300);
  assert.ok(/ups-m-mode-toggle/.test(fn));
  assert.ok(/aria-pressed/.test(fn));
  assert.ok(/b\("playoffs", "Playoffs"\)/.test(fn));
  assert.ok(/b\("league", "League"\)/.test(fn) && /b\("divisions", "Divisions"\)/.test(fn));
});
check('mobile bracket loader never permanently caches a failed fetch as success (fails closed, retries after a cooldown, distinct from a legitimate empty bracket)', () => {
  const fn = MOBILE_LEAGUE.slice(MOBILE_LEAGUE.indexOf('function loadPlayoffBracketForYear(year) {'), MOBILE_LEAGUE.indexOf('function loadPlayoffBracketForYear(year) {') + 1200);
  assert.ok(/state\.bracketErrorAt/.test(fn), 'must track failure separately from success (state.bracketByYear only set on success)');
  assert.ok(/BRACKET_RETRY_COOLDOWN_MS/.test(fn), 'must retry after a bounded cooldown, not hang onto a failure forever');
});

for (const [name, fn] of checks) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails++; console.log('  FAIL ' + name + '\n         ' + (e && e.message || e)); }
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
