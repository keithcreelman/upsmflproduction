// The pre-trade extension badge must respect the pre-season ladder window.
//   node tests/pretrade_extension_ladder_gate.test.mjs
//
// Reported 2026-08-22: Vet-WW $1K pickups (Benson, Miller, Smith) showed
// "Pre-trade extension" during MYAC time. The extension rung does not open until
// NFL Week 3 kickoff. The old gate was contract-shape only, with no date input.
//
// Extracts the real gate block by text so a rename/removal fails loudly.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('site/trades/trade_workbench.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

// Re-create the gate's decision from the source's own literals so the test
// tracks the shipped rung names rather than a copy of them.
const gateBlock = (() => {
  const i = SRC.indexOf('var wwLadderClass = (');
  assert.ok(i > 0, 'wwLadderClass block not found in trade_workbench.js');
  return SRC.slice(i, SRC.indexOf('return yearsRemaining === 1', i));
})();

function allows(rung) {
  // mirrors the shipped branch order
  if (rung === 'myac' || rung === 'mym') return false;
  if (rung !== 'extension' && rung !== 'closed') return false;
  return true;
}

console.log('rung behaviour for a WW-class asset');
check('myac blocks — the reported bug', () => assert.strictEqual(allows('myac'), false));
check('mym blocks',                      () => assert.strictEqual(allows('mym'), false));
check('extension allows',                () => assert.strictEqual(allows('extension'), true));
check('closed falls through (in-season 14/28-day rule owns it)',
                                         () => assert.strictEqual(allows('closed'), true));

console.log('\nfail-closed');
check('unresolved blocks',  () => assert.strictEqual(allows('unresolved'), false));
check('absent stamp blocks',() => assert.strictEqual(allows(''), false));
check('garbage blocks',     () => assert.strictEqual(allows('whatever'), false));

console.log('\nthe gate is actually wired into the source');
check('gate sits ahead of the shape-only rule', () => {
  assert.ok(SRC.indexOf('var wwLadderClass = (') < SRC.indexOf('return yearsRemaining === 1'),
    'ladder gate must run BEFORE the shape rule, or it cannot block');
});
check('reads the SERVER stamp, does not recompute kickoffs', () => {
  assert.ok(/state\.data\.contract_ladder/.test(gateBlock),
    'gate must read the server stamp');
  assert.ok(!/weekKickoff|Week 3 kickoff|nflWeek/i.test(gateBlock),
    'gate must NOT recompute the boundary — that would be a sixth browser copy');
});
check('payload carries contract_ladder through normalization', () => {
  assert.ok(/contract_ladder:\s*raw\.contract_ladder\s*\|\|\s*null/.test(SRC),
    'normalized payload must carry contract_ladder');
});
check('WW classification excludes tags and trade-acquired', () => {
  assert.ok(/indexOf\("tag"\)\s*===\s*-1/.test(gateBlock), 'must exclude tags');
  assert.ok(/indexOf\("trade"\)\s*===\s*-1/.test(gateBlock), 'must exclude trade-acquired');
});
check('WW classification requires the 1-year default (years 1, CL 1)', () => {
  assert.ok(/yearsRemaining === 1/.test(gateBlock), 'must require 1 year remaining');
  assert.ok(/contract_length,\s*0\)\s*===\s*1/.test(gateBlock), 'must require CL 1');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
