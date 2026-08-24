// A rookie WON IN THE FA AUCTION can take a multi-year auction contract.
//   node tests/rookie_faa_myac_eligibility.test.mjs
//
// Canon line 394: Auction (a.k.a. Veteran) | 1, 2, or 3 years | FA Auction or
// Expired Rookie Auction. Origin as a rookie does not change that.
//
// Reported 2026-08-23 by an owner about Cyrus Allen: "only showing to extend and
// not give a deal as auction player". The fresh-FAA test excluded any status
// containing "rookie" — which caught **Rookie-FAA**, an auction win. Eight
// players across five teams were affected. The status-vocabulary fix that began
// writing Rookie-FAA instead of Vet-FAA is what walked them into the clause.
import fs from 'fs';
import assert from 'assert';

const FILES = {
  'desktop FO v2': 'site/rosters/v2/front_office.js',
  'mobile FO actions': 'site/m/front_office_actions.js',
};
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

function freshFaaClause(src) {
  const i = src.indexOf('var isFreshFaaStatus =');
  assert.ok(i > 0, 'isFreshFaaStatus not found');
  return src.slice(i, src.indexOf(';', i));
}

console.log('every surface offers MYAC to an auction-won rookie');
for (const [label, path] of Object.entries(FILES)) {
  const clause = freshFaaClause(fs.readFileSync(path, 'utf8'));
  check(label + ': does NOT exclude on the word "rookie"', () => {
    assert.ok(!/rookieLikeContractStatus/.test(clause),
      'excluding any "rookie" status also excludes Rookie-FAA, which IS an auction win');
  });
  check(label + ': still defers to the rookie OPTION path', () => {
    assert.ok(/!rookieOptionActionEligible\(/.test(clause),
      'a player whose path is the rookie option must not be offered MYAC');
  });
  check(label + ': still requires an auction contract', () => {
    assert.ok(/indexOf\("-faa"\)/.test(clause), 'must still be an FAA contract');
  });
  check(label + ': still excludes tags', () => {
    assert.ok(/indexOf\("tag"\)/.test(clause));
  });
  check(label + ': still requires the 1-year default', () => {
    assert.ok(/oneYearDefault|parseContractLengthValue/.test(clause),
      'an already-converted CL 2/3 deal is past this ladder');
  });
}

console.log('\nthe rule it encodes');
check('rookieLikeContractStatus really does match Rookie-FAA', () => {
  // the helper is `s.indexOf("rookie") !== -1` — this is why the bug existed
  const s = 'rookie-faa';
  assert.ok(s.indexOf('rookie') !== -1, 'Rookie-FAA matches the old exclusion');
});
check('Rookie-Draft never reaches this clause anyway', () => {
  assert.ok('rookie-draft'.indexOf('-faa') === -1,
    'a drafted rookie is not an FAA contract, so the old guard protected nothing here');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
