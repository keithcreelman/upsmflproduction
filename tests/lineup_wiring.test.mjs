// §H wiring — the replacement resolver and the fail-closed reads.
//   node tests/lineup_wiring.test.mjs
//
// The resolver decides whether a bad starter is a violation AT ALL (Keith
// 2026-08-17: "if you don't have a player on your roster you can sub out" =
// no penalty), so its failure modes are asymmetric and worth stating:
//
//   too lenient -> excuses a real violation.        Bad.
//   too strict  -> FINES SOMEBODY FOR A MOVE THEY   Worse. This is the one
//                  COULD NOT MAKE.                  Keith explicitly ruled out.
//
// So every uncertain case must resolve to "no replacement", i.e. no penalty.
import { replacementAvailable } from '../worker/src/lineup_wiring.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

const players = {
  'K1': { position: 'PK', team: 'NE',  name: 'Starting K' },
  'K2': { position: 'PK', team: 'BUF', name: 'Backup K' },
  'K3': { position: 'PK', team: 'MIA', name: 'Bye K' },
  'K4': { position: 'PK', team: 'NYJ', name: 'Hurt K' },
  'W1': { position: 'WR', team: 'KC',  name: 'A Receiver' },
};
const base = (over) => ({
  roster: [{ id: 'K1', status: '' }, { id: 'W1', status: '' }],
  starting: new Set(['K1', 'W1']),
  players, byes: new Set(), injuryAt: () => null, ...over,
});

console.log('\n-- the case Keith ruled on: no kicker to sub in --');
t('only kicker is the one who is out', replacementAvailable('K1', base()), false);

console.log('\n-- a healthy backup at the same position IS a replacement --');
t('benched backup kicker', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K2', status: '' }] })), true);

console.log('\n-- but not one who is himself unstartable --');
t('backup on a bye does not count', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K3', status: '' }], byes: new Set(['MIA']) })), false);
t('backup who is also Out does not count', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K4', status: '' }], injuryAt: (id) => id === 'K4' ? 'OUT' : null })), false);
t('backup on IR does not count', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K4', status: '' }], injuryAt: (id) => id === 'K4' ? 'IR' : null })), false);

console.log('\n-- roster states that are not available to start --');
t('taxi-squad player is not a replacement', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K2', status: 'TAXI_SQUAD' }] })), false);
t('IR-listed player is not a replacement', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K2', status: 'INJURED_RESERVE' }] })), false);

console.log('\n-- already-starting players cannot cover for each other --');
t('a kicker already in the lineup is not a sub', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'K2', status: '' }], starting: new Set(['K1', 'K2']) })), false);
t('a player cannot replace himself', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }], starting: new Set() })), false);

console.log('\n-- position matters --');
t('a WR does not cover a kicker slot', replacementAvailable('K1', base({
  roster: [{ id: 'K1', status: '' }, { id: 'W1', status: '' }], starting: new Set(['K1']) })), false);

console.log('\n-- uncertainty resolves toward NO PENALTY --');
// An unknown position means we cannot prove a replacement existed, and an
// unprovable case must never become a fine.
t('unknown player -> no replacement', replacementAvailable('GHOST', base()), false);
t('player with no position -> no replacement', replacementAvailable('K1', base({
  players: { ...players, K1: { position: '', team: 'NE' } } })), false);
t('empty roster -> no replacement', replacementAvailable('K1', base({ roster: [] })), false);
t('null roster does not throw', replacementAvailable('K1', base({ roster: null })), false);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
