// A miss card (row_id: null) posting inside a report must not be treated as
// an unrecorded real row.
//   node tests/waiver_miss_card_null_row_id.test.mjs
//
// Confirmed LIVE 2026-08-28: replaying the real 2026-08-20 Najee Harris run
// (5 real claims + 1 embedded miss) returned posted_count=6, failed_count=-1.
// The miss card's null row_id was falling into the "recorded on
// ups_add_events" branch, where `UPDATE ... WHERE id = ?` bound to NULL
// matches ZERO rows in SQLite — so `recorded` was unconditionally false for
// EVERY miss card, marking the whole report ok:false and firing the
// "POSTED-BUT-NOT-RECORDED... will be reposted every 5 minutes" alarm on
// every run with a genuine denial. That would have fired on the very first
// real one, in production, to the commish.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

const loopStart = SRC.indexOf('for (const mm of entry.plan.move_messages) {');
const loopEnd = SRC.indexOf('if (result.unrecorded_row_ids.length) {', loopStart);
const loop = loopStart > 0 && loopEnd > loopStart ? SRC.slice(loopStart, loopEnd) : '';

console.log('anchors hold');
check('the posting loop is locatable and substantial', () => {
  assert.ok(loop.length > 500, `slice is ${loop.length} chars`);
});

console.log('\na null row_id is branched BEFORE the D1-recording logic, not after');
check('the first branch explicitly checks mm.row_id == null', () => {
  assert.ok(/if \(moveRes\?\.ok && moveMsgId && mm\.row_id == null\)/.test(loop),
    'without this the null id falls into the branch that assumes every message has a real row');
});
check('the null-row_id branch never touches posted_row_ids or unrecorded_row_ids', () => {
  const nullBranch = loop.slice(
    loop.indexOf('if (moveRes?.ok && moveMsgId && mm.row_id == null)'),
    loop.indexOf('} else if (moveRes?.ok && moveMsgId)')
  );
  assert.ok(nullBranch.length > 50, 'null-id branch not found');
  assert.ok(!/posted_row_ids\.push/.test(nullBranch), 'pushing a null id into posted_row_ids reintroduces the count bug');
  assert.ok(!/unrecorded_row_ids\.push/.test(nullBranch), 'pushing a null id into unrecorded_row_ids reintroduces the false alarm');
  assert.ok(!/result\.ok = false/.test(nullBranch), 'a successfully-posted miss card must not fail the whole report');
});
check('the null-row_id branch still records the message as ok:true', () => {
  const nullBranch = loop.slice(
    loop.indexOf('if (moveRes?.ok && moveMsgId && mm.row_id == null)'),
    loop.indexOf('} else if (moveRes?.ok && moveMsgId)')
  );
  assert.ok(/ok: true, is_miss: true/.test(nullBranch), 'success must still be visible, just not as a "recorded row"');
});

console.log('\nthe real-row path is unchanged for actual claims');
check('a real row_id still goes through the D1 record/unrecord logic', () => {
  assert.ok(/UPDATE\s+ups_add_events/.test(loop) && /result\.posted_row_ids\.push\(mm\.row_id\)/.test(loop),
    'the fix must not remove the real bookkeeping path — only add a null-safe one before it');
});
check('a genuinely FAILED Discord post (any row_id) still fails the report', () => {
  const finalElse = loop.slice(loop.lastIndexOf('} else {'));
  assert.ok(/result\.ok = false/.test(finalElse), 'a real post failure must still surface as ok:false');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
