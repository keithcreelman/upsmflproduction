// §B1 QB caps — the two rules canon says "No code enforces" (verified
// 2026-08-16). Built as a REPORT on Keith's 2026-08-17 call.
//   node tests/qb_cap_check.test.mjs
//
// The two caps count DIFFERENT things and conflating them is the whole bug:
//   5-QB maximum   ACTIVE ROSTER only
//   4-starter cap  active + taxi COMBINED
//
// And starter status is an INPUT, never inferred: canon defines it as the
// FantasyPros No.1 QB with "unresolved camp battles commissioner-determined",
// and FantasyPros' depth chart is client-rendered. Missing input must report
// unknown, not zero — "0 starters, all clear" off no data is the fail-open
// this guards against, and its consequence is forced cuts.
import {
  splitQbs, checkFranchiseQbs, MAX_ACTIVE_QBS, MAX_STARTING_QBS,
} from '../worker/src/qb_cap_check.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

const players = {};
for (let i = 1; i <= 9; i++) players['Q' + i] = { position: 'QB', team: 'T' + i, name: 'QB ' + i };
players['R1'] = { position: 'RB', team: 'KC', name: 'A Back' };
const R = (id, status = '') => ({ id, status });

console.log('\n-- the caps count different things --');
t('active max is 5', MAX_ACTIVE_QBS, 5);
t('starter cap is 4', MAX_STARTING_QBS, 4);
const mixed = [R('Q1'), R('Q2'), R('Q3', 'TAXI_SQUAD'), R('Q4', 'INJURED_RESERVE'), R('R1')];
t('split by roster location', splitQbs(mixed, players), { active: ['Q1', 'Q2'], taxi: ['Q3'], ir: ['Q4'] });
t('non-QBs ignored', splitQbs([R('R1')], players), { active: [], taxi: [], ir: [] });

console.log('\n-- 5-QB ACTIVE maximum: active roster only --');
const five = [R('Q1'), R('Q2'), R('Q3'), R('Q4'), R('Q5')];
t('5 active -> compliant', checkFranchiseQbs(five, players).over_active_max, false);
t('6 active -> over by 1', checkFranchiseQbs([...five, R('Q6')], players).active_excess, 1);
// Taxi and IR QBs do NOT count toward the 5 — that is the active-roster cap.
t('taxi QBs do not count toward the 5',
  checkFranchiseQbs([...five, R('Q6', 'TAXI_SQUAD')], players).over_active_max, false);
t('IR QBs do not count toward the 5',
  checkFranchiseQbs([...five, R('Q6', 'INJURED_RESERVE')], players).over_active_max, false);

console.log('\n-- 4-STARTER cap: active + taxi combined --');
const starters = (...ids) => (id) => ids.includes(id);
t('4 starters -> compliant',
  checkFranchiseQbs(five, players, starters('Q1','Q2','Q3','Q4')).over_starter_cap, false);
t('5 starters -> over by 1',
  checkFranchiseQbs(five, players, starters('Q1','Q2','Q3','Q4','Q5')).starter_excess, 1);
// This is the case the two caps disagree on: 4 active + 1 taxi starter is
// legal on the 5-max and ILLEGAL on the starter cap.
const fourPlusTaxi = [R('Q1'), R('Q2'), R('Q3'), R('Q4'), R('Q5', 'TAXI_SQUAD')];
const v = checkFranchiseQbs(fourPlusTaxi, players, starters('Q1','Q2','Q3','Q4','Q5'));
t('taxi starter DOES count toward the 4', v.over_starter_cap, true);
t('...while the 5-max stays clean', v.over_active_max, false);
// An IR QB is on neither list for the starter cap.
t('IR QB excluded from the starter cap',
  checkFranchiseQbs([R('Q1'),R('Q2'),R('Q3'),R('Q4'),R('Q5','INJURED_RESERVE')], players,
    starters('Q1','Q2','Q3','Q4','Q5')).over_starter_cap, false);

console.log('\n-- missing starter data reports UNKNOWN, never "compliant" --');
const noInput = checkFranchiseQbs(five, players);
t('starters_known false', noInput.starters_known, false);
t('starting_qbs is null, not 0', noInput.starting_qbs, null);
t('over_starter_cap is null, not false', noInput.over_starter_cap, null);
t('and says what is needed', /commissioner-determined/.test(noInput.starter_detail), true);
// The deterministic half still works with no starter input at all.
t('5-max still reports exactly without starter data',
  checkFranchiseQbs([...five, R('Q6')], players).over_active_max, true);

console.log('\n-- the message names the consequence, since it is real cuts --');
const over = checkFranchiseQbs(five, players, starters('Q1','Q2','Q3','Q4','Q5'));
t('cites reverse-acquisition order', /reverse-acquisition order/.test(over.starter_detail), true);
t('cites next season\'s cap', /next season's cap/.test(over.starter_detail), true);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
