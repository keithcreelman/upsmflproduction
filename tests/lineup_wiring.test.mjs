// §H wiring — the "no eligible replacement" exception stays REMOVED.
//   node tests/lineup_wiring.test.mjs
//
// Keith 2026-09-19 reversed his 2026-08-17 ruling: "it doesn't matter if there's
// nobody eligible it would be a violation" (canon §G3, docs/league_context_v1.md:
// "No eligible replacement on your roster | Violation"). That removed
// evaluateStarter's two advisory-downgrade branches and deleted
// replacementAvailable() from worker/src/lineup_wiring.js as dead code. This file
// used to test that resolver; it now guards that nothing brings the exception back
// through the wiring. The verdicts themselves are pinned in
// tests/lineup_compliance.test.mjs §9a.
import fs from 'fs';
import * as wiring from '../worker/src/lineup_wiring.js';

const WIRING = fs.readFileSync('worker/src/lineup_wiring.js', 'utf8');
const COMPLIANCE = fs.readFileSync('worker/src/lineup_compliance.js', 'utf8');
const CANON = fs.readFileSync('docs/league_context_v1.md', 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

console.log('\n-- the resolver is gone and nothing computes a replacement --');
t('lineup_wiring.js exports no replacementAvailable', typeof wiring.replacementAvailable, 'undefined');
t('the wiring never computes or passes a replacement flag', /replacementAvailable/.test(code(WIRING)), false);
t('evaluateStarter has no no_replacement advisory branch', /no_replacement/.test(code(COMPLIANCE)), false);

console.log('\n-- canon states the rule the code follows --');
t('§G3: no eligible replacement is a violation (Keith 2026-09-19)',
  /\*\*No eligible replacement\*\* on your roster \| \*\*Violation\*\*/.test(CANON), true);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
