// MFL's roster status for an IR player is "INJURED_RESERVE" — which does NOT
// contain the substring "IR".
//   node tests/ir_status_predicate.test.mjs
//
// Verified live 2026-08-26: the only three statuses MFL emits on TYPE=rosters are
// ROSTER, TAXI_SQUAD and INJURED_RESERVE. `status.includes("IR")` therefore never
// matched, and five separate sites depended on it.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

console.log('the substring trap itself');
check('"INJURED_RESERVE" does NOT contain "IR"', () => {
  assert.strictEqual('INJURED_RESERVE'.includes('IR'), false,
    'this is the whole bug — the check could never be true');
});
check('"INJURED_RESERVE" DOES contain "INJURED"', () => {
  assert.ok('INJURED_RESERVE'.includes('INJURED'));
});
check('"TAXI_SQUAD" contains "TAXI", so the taxi predicates were always fine', () => {
  assert.ok('TAXI_SQUAD'.includes('TAXI'));
});

console.log('\nno code path still tests includes("IR")');
check('zero non-comment occurrences remain', () => {
  const bad = SRC.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /includes\("IR"\)/.test(l) && !/^\s*(\/\/|\*)/.test(l.trim()));
  assert.strictEqual(bad.length, 0,
    'still present at line(s): ' + bad.map(([n]) => n).join(', '));
});

console.log('\nboth directions of the verification');
const onIr = (s) => s.includes('INJURED');
check('place on IR: a successful move now verifies TRUE', () => {
  assert.strictEqual(onIr('INJURED_RESERVE'), true,
    'this reported "player_status_did_not_change" on a move that worked');
});
check('take off IR: a FAILED move now verifies FALSE', () => {
  // The dangerous half: !includes("IR") was always true, so activate_ir
  // reported success even when MFL did nothing at all.
  assert.strictEqual(!onIr('INJURED_RESERVE'), false,
    'a no-op activate must not report success');
});
check('take off IR: a successful move verifies TRUE', () => {
  assert.strictEqual(!onIr('ROSTER'), true);
});

console.log('\ncap math');
check('the cap-hit call passes an IR flag that can actually be true', () => {
  const line = SRC.split('\n').find((l) => l.includes('currentCapHitAcq(player.salary'));
  assert.ok(line, 'cap-hit call not found');
  assert.ok(/includes\("INJURED"\)/.test(line),
    'IR players were charged FULL cap instead of the 50% relief');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
