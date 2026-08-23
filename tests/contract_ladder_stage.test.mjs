// Server-side pre-season contract ladder.
//   node tests/contract_ladder_stage.test.mjs
//
// Fail-closed is the point: a missing or out-of-order boundary must return
// "unresolved" so callers offer nothing, never a guessed rung.
import assert from 'assert';
import { contractLadderStage } from '../worker/src/league_events_ladder.js';

// Real 2026 instants (unix seconds).
const CD  = Math.floor(new Date('2026-09-06T23:59:59-04:00').getTime()/1000); // contract deadline
const WK3 = Math.floor(new Date('2026-09-24T20:15:00-04:00').getTime()/1000); // Week 3 kickoff
const WK5 = Math.floor(new Date('2026-10-08T20:15:00-04:00').getTime()/1000); // Week 5 kickoff
const at = (iso) => Math.floor(new Date(iso).getTime()/1000);
const stage = (nowIso, over={}) => contractLadderStage({
  contractDeadlineUnix: CD, week3KickoffUnix: WK3, week5KickoffUnix: WK5,
  nowUnix: at(nowIso), ...over });

let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

console.log('rungs');
check('today (2026-08-22) is MYAC — NOT extension', () => {
  const r = stage('2026-08-22T18:00:00-04:00');
  assert.strictEqual(r.stage, 'myac');
});
check('deadline day itself is still MYAC (<=)', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:CD}).stage,'myac');
});
check('one second past the deadline is MYM', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:CD+1}).stage,'mym');
});
check('just before Week 3 kickoff is still MYM (<)', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:WK3-1}).stage,'mym');
});
check('AT Week 3 kickoff the extension window opens', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:WK3}).stage,'extension');
});
check('just before Week 5 kickoff is still extension', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:WK5-1}).stage,'extension');
});
check('AT Week 5 kickoff everything is closed', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,nowUnix:WK5}).stage,'closed');
});
check('end_unix names the rung boundary', () => {
  assert.strictEqual(stage('2026-08-22T18:00:00-04:00').end_unix, CD);
  assert.strictEqual(stage('2026-09-10T12:00:00-04:00').end_unix, WK3);
  assert.strictEqual(stage('2026-09-30T12:00:00-04:00').end_unix, WK5);
});

console.log('\nfail-closed');
for (const [name, over] of [
  ['missing contract deadline', {contractDeadlineUnix:null}],
  ['missing Week 3 kickoff',    {week3KickoffUnix:null}],
  ['missing Week 5 kickoff',    {week5KickoffUnix:null}],
  ['missing now',               {nowUnix:null}],
  ['zero treated as missing',   {week3KickoffUnix:0}],
  ['garbage treated as missing',{week3KickoffUnix:'not-a-date'}],
]) {
  check(name+' -> unresolved', () => {
    // pick a `now` that would otherwise need the omitted boundary
    const r = contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK3,week5KickoffUnix:WK5,
      nowUnix: at('2026-09-30T12:00:00-04:00'), ...over});
    assert.strictEqual(r.stage,'unresolved');
    assert.strictEqual(r.end_unix,null);
  });
}
check('no arguments at all -> unresolved', () => {
  assert.strictEqual(contractLadderStage().stage,'unresolved');
});
check('Week 3 not after the deadline -> unresolved', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:WK3,week3KickoffUnix:CD,week5KickoffUnix:WK5,nowUnix:at('2026-08-22T00:00:00-04:00')}).stage,'unresolved');
});
check('Week 5 not after Week 3 -> unresolved', () => {
  assert.strictEqual(contractLadderStage({contractDeadlineUnix:CD,week3KickoffUnix:WK5,week5KickoffUnix:WK3,nowUnix:at('2026-08-22T00:00:00-04:00')}).stage,'unresolved');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
