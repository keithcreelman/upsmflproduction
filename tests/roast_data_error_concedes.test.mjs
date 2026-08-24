// A DATA_ERROR reply must be ANSWERED, not silently swallowed.
//   node tests/roast_data_error_concedes.test.mjs
//
// 2026-08-23: shawnblake challenged a PPG figure for Jonah Coleman, who has
// never played a regular-season game. The classifier agreed with him
// (DATA_ERROR) — and the bot said nothing, because the `clap_back_warranted`
// gate sat ABOVE the DATA_ERROR branch and returned first. From the owner's
// side a correct concession looked exactly like a crash: "think the bot gave up
// on my trade roast".
//
// The gate governs whether an ARGUMENT is worth having. It must not decide
// whether an owner gets an answer.
import fs from 'fs';
import assert from 'assert';

const PY = fs.readFileSync('pipelines/etl/scripts/trade_roast_bot.py', 'utf8');
const JS = fs.readFileSync('worker/src/discord_roast_reply.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const idx = (s, needle) => { const i = s.indexOf(needle); assert.ok(i > 0, 'not found: ' + needle); return i; };

console.log('the gate no longer outranks the acknowledgements');
check('DATA_ERROR branch runs BEFORE the clap-back gate', () => {
  assert.ok(idx(PY, 'category == "DATA_ERROR"') < idx(PY, 'clap_back_warranted", False'),
    'the gate must not be able to swallow the concession');
});
check('VALUE_SIGNAL branch also runs before the gate', () => {
  assert.ok(idx(PY, 'category == "VALUE_SIGNAL"') < idx(PY, 'clap_back_warranted", False'));
});
check('the gate still exists — COPE is still gated', () => {
  assert.ok(/clap_back_warranted", False\)/.test(PY),
    'declining a pointless argument is still correct behaviour');
});

console.log('\nit concedes rather than filing a receipt');
const CONCESSION = "Fair — that one's on us. Logged for a look at the source data.";
check('python bot uses the concession wording', () => {
  assert.ok(PY.includes(CONCESSION));
});
check('worker copy uses the SAME wording', () => {
  assert.ok(JS.includes(CONCESSION), 'both surfaces must sound the same to the league');
});
check('the old neutral wording is gone from both', () => {
  for (const [label, src] of [['python', PY], ['worker', JS]]) {
    assert.ok(!/Noted\. We'll verify against the source data\./.test(src), label + ' still uses the old line');
  }
});

console.log('\nno stray mentions');
check('python concession suppresses mentions', () => {
  const i = idx(PY, CONCESSION);
  assert.ok(/allowed_mentions=discord\.AllowedMentions\.none\(\)/.test(PY.slice(i, i + 260)),
    'a concession must not ping the channel');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
