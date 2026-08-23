// A dropped request must not tell the league waivers are switched off.
//   node tests/waiver_state_resilience.test.mjs
//
// 2026-08-22, live waiver night: one failed /api/waivers/state fetch left
// state.waiverState null. Every waiver surface reads null as read-only, so the
// app said "In-app waiver moves are switched off — use MFL's own add/drop page"
// while the server had write_enabled:true and WAIVERS_INAPP_ENABLED="1". The
// only recovery was force-quitting the app. Owners will not do that.
//
// The WRITE GATE stays strict (no state -> no submit button; the only thing it
// could produce is a 503). What changes is that we RETRY, and that we stop
// calling a failed load a kill switch.
import fs from 'fs';
import assert from 'assert';

const APP = fs.readFileSync('site/m/app.js', 'utf8');
const PLAYERS = fs.readFileSync('site/m/views/players.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const fetchFn = APP.slice(APP.indexOf('function fetchWaiverState('), APP.indexOf('\n  }', APP.indexOf('function fetchWaiverState(')));

console.log('a transient failure retries');
check('fetchWaiverState retries rather than giving up', () => {
  assert.ok(/attempt\(n \+ 1\)/.test(fetchFn), 'no retry path found');
});
check('retries on a non-ok response, not just a thrown error', () => {
  const okBranch = fetchFn.slice(fetchFn.indexOf('if (j && j.ok) return j;'));
  assert.ok(/attempt\(n \+ 1\)/.test(okBranch.slice(0, 300)),
    'a non-ok/!ok body must retry too — that is the common failure, not a throw');
});
check('retry is bounded', () => {
  assert.ok(/n < 2/.test(fetchFn), 'must stop retrying; an unbounded loop is worse than failing');
});
check('a failed load does NOT poison the cache timestamp', () => {
  assert.ok(/if \(j && j\.ok\) \{[\s\S]{0,120}waiverStateAt = Date\.now\(\)/.test(fetchFn),
    'waiverStateAt must only advance on success, or the TTL suppresses the next try');
});

console.log('\nthe write gate stays strict');
check('write still requires an explicit true', () => {
  assert.ok(/write_enabled === true/.test(APP),
    'the submit button must never appear on a guess');
});

console.log('\n"off" and "could not load" are different sentences');
check('waiverStateKnown exists and keys off a loaded state', () => {
  assert.ok(/function waiverStateKnown\(\)[\s\S]{0,200}state\.waiverState && state\.waiverState\.ok/.test(APP));
});
check('the banner branches on it', () => {
  assert.ok(/out\.detail \+= waiverStateKnown\(\)/.test(APP), 'banner must branch');
  assert.ok(/Couldn't reach the waiver service/.test(APP), 'must have the could-not-load wording');
});
check('the banner still says "switched off" when it really is', () => {
  assert.ok(/In-app waiver moves are switched off/.test(APP));
});
check('players.js branches too, through the exported helper', () => {
  assert.ok(/M\.waivers\.stateKnown/.test(PLAYERS), 'players.js must consult stateKnown');
  assert.ok(/Couldn't reach the waiver service/.test(PLAYERS));
});
check('stateKnown is exported on the same surface as writeEnabled', () => {
  const ns = APP.slice(APP.indexOf('    waivers: {'), APP.indexOf('    waivers: {') + 900);
  assert.ok(/writeEnabled:/.test(ns), 'sanity: found the waivers namespace');
  assert.ok(/stateKnown:/.test(ns), 'stateKnown must sit beside writeEnabled or views cannot reach it');
});
check('players.js defaults to the OLD wording if the helper is absent', () => {
  assert.ok(/!\(M\.waivers && M\.waivers\.stateKnown\) \|\|/.test(PLAYERS),
    'a missing helper must not crash or silently claim "could not load"');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
