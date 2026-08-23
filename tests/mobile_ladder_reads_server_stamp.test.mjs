// Mobile's ladder rung must be READ from the server, not recomputed.
//   node tests/mobile_ladder_reads_server_stamp.test.mjs
//
// Desktop front_office.js carries a second implementation of this same boundary,
// its own header calling it a port of mobile's. Two copies of a rule drift —
// that is what dropped `Ext:` from nine contracts on 2026-08-22, where one of
// three writers never received a fix.
import fs from 'fs';
import assert from 'assert';

const FOA = fs.readFileSync('site/m/front_office_actions.js', 'utf8');
const APP = fs.readFileSync('site/m/app.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const stageFn = (() => {
  const i = FOA.indexOf('function contractLadderStageFO() {');
  assert.ok(i > 0, 'contractLadderStageFO not found');
  return FOA.slice(i, FOA.indexOf('\n  }', i));
})();

console.log('the rung comes from the server');
check('reads state.contractLadder.server', () => {
  assert.ok(/contractLadder\s*&&\s*s\.contractLadder\.server/.test(stageFn),
    'must read the stamped rung out of state');
});
check('no client-side instant comparison remains', () => {
  assert.ok(!/now\s*<=?|Date\.now\(\)/.test(stageFn),
    'the open/closed decision must not be recomputed on the client');
});
check('app.js carries contract_ladder into state', () => {
  assert.ok(/out\.server\s*=\s*data\.contract_ladder\s*\|\|\s*null/.test(APP),
    'fetchContractCalendar must stash the server rung');
});
check('emptyContractLadder defaults server to null', () => {
  assert.ok(/server:\s*null/.test(APP), 'default must be null, not an assumed rung');
});

console.log('\nreturn shape is unchanged for existing consumers');
for (const key of ['stage', 'date', 'endMs']) {
  check(`still returns ${key}`, () => {
    assert.ok(new RegExp(key + '\\s*:').test(stageFn), `${key} missing from the return shape`);
  });
}
check('player_sheet.js still reads ladderStage', () => {
  assert.ok(/ladderStage/.test(fs.readFileSync('site/m/player_sheet.js','utf8')));
});
check('views/contracts.js still calls contractLadderDates()', () => {
  assert.ok(/contractLadderDates\(\)/.test(fs.readFileSync('site/m/views/contracts.js','utf8')));
});

console.log('\nfail-closed');
check('absent stamp -> unresolved', () => {
  assert.ok(/if \(!stage \|\| stage === "unresolved"\) return UNRESOLVED;/.test(stageFn),
    'missing/unresolved must short-circuit to unresolved');
});
check('an unknown stage falls through to unresolved', () => {
  assert.ok(/return UNRESOLVED;\s*\n\s*\}/.test(stageFn + '\n  }'),
    'the function must end by refusing, not by guessing a rung');
});
check('every mapped rung is one the server can emit', () => {
  const mapped = [...stageFn.matchAll(/stage === "([a-z]+)"/g)].map(m => m[1]);
  const emitted = ['unresolved','myac','mym','extension','closed'];
  for (const m of mapped) assert.ok(emitted.includes(m), `client maps "${m}" which the server never emits`);
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
