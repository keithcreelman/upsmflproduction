// A roast must never present a PROJECTED PPG as production.
//   node tests/roast_ppg_provenance.test.mjs
//
// 2026-08-23, owner report: "the bot gave up on my trade roast after quoting ppg
// for a player that hasn't played a single game."
//
// expected_ppg is never observed production — it is a trade-value model, a
// rollover estimate, or a forward projection. `ppg_basis` records which. When
// the projection overlay set the number, the basis stayed EMPTY and the line
// rendered a bare "(proj)", which reads as production to an owner.
import fs from 'fs';
import assert from 'assert';

const BOT = fs.readFileSync('pipelines/etl/scripts/trade_roast_bot.py', 'utf8');
const PROMPT = fs.readFileSync('pipelines/etl/scripts/trade_grader_prompt.py', 'utf8');
// Decision 3 (#1343, 2026-10-20): every PPG and its basis text come from the
// valuation snapshot, so the basis rules live in its generator and runtime.
const GEN = fs.readFileSync('pipelines/etl/scripts/build_valuation_snapshot.py', 'utf8');
const SNAPSHOT = fs.readFileSync('pipelines/etl/scripts/valuation_snapshot.py', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

console.log('the rendered line states provenance');
check('an empty basis no longer renders as a bare "proj"', () => {
  assert.ok(!/ppg_basis or 'proj'/.test(BOT),
    'a bare "(proj)" reads as production; the fallback must say so in words');
});
check('the fallback says it is not games played', () => {
  assert.ok(/PROJECTED — not games played/.test(BOT));
});
check('a real basis is still passed through unchanged', () => {
  assert.ok(/p\.ppg_basis or ""/.test(BOT), 'must prefer the recorded basis when there is one');
});
check('no PPG is rendered at all when there is no number', () => {
  assert.ok(/if p\.expected_ppg else ""/.test(BOT));
});

console.log('\nthe prompt forbids dressing a projection as production');
check('prompt explains the basis is not games played', () => {
  assert.ok(/NEVER a record of games\s*\n?\s*played unless the basis literally says "seasons played"/.test(PROMPT.replace(/\s+/g,' ').replace(/ /g,' ')) ||
            /NEVER a record of games/.test(PROMPT));
});
check('prompt bans "scored/averaged/put up" for projected figures', () => {
  for (const w of ['scored', 'averaged', 'put up']) {
    assert.ok(new RegExp('"' + w + '"').test(PROMPT), `must ban "${w}"`);
  }
});
check('prompt supplies the replacement phrasing', () => {
  assert.ok(/projects to/.test(PROMPT));
});

console.log('\nthe upstream rules it depends on still hold');
check('grader still refuses a punitive 0 for a player who has not played', () => {
  // No games: the PPG his position rank implies, or no PPG at all, and a
  // traded player with no PPG gets NO GRADE, never 0.
  assert.ok(/"basis": "adp_implied"/.test(GEN),
    'a rookie must not be valued at 0 PPG just because he has no seasons');
  assert.ok(/no projected PPG in the snapshot/.test(SNAPSHOT),
    'a traded player with no PPG must stop the grade, not count as 0');
});
check('grader still labels the ADP-implied basis explicitly', () => {
  assert.ok(/no NFL games: FantasyCalc ranks him/.test(GEN));
});
check('grader still labels real production with the seasons and games behind it', () => {
  assert.ok(/"weighted " if qualifying else "thin data \(under 4 games\): "/.test(GEN));
  assert.ok(/\(\{g\}g\)/.test(GEN), 'each season shows its games played');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
