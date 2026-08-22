// The tag floor annotation must be idempotent and spelled ONE way everywhere.
//   node tests/tag_floor_note_normalization.test.mjs
//
// The old code stripped "10% salary floor" but EMITTED "10% AAV floor", so the
// strip never matched its own output — re-tagging appended forever. Javonte
// Williams (15256) carried the note twice in live MFL data on 2026-08-22.
//
// §C8-A: the floor is 10% over the CONTRACT-DEADLINE AAV snapshot — AAV only,
// never salary — so "10% AAV floor" is accurate and "10% salary floor" is the
// stale salary-inclusive label that mobile was still writing.
import fs from 'fs';
import assert from 'assert';

const FILES = {
  'FO v2':            'site/rosters/v2/front_office.js',
  'roster workbench': 'site/rosters/roster_workbench.js',
  'mobile tag submit':'site/m/front_office_tag_submit.js',
};
const CANON = '10% AAV floor (rounded up to $1K)';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n         ' + e.message); }
};

console.log('all three writers agree on one spelling');
for (const [label, path] of Object.entries(FILES)) {
  const src = fs.readFileSync(path, 'utf8');
  check(label + ' declares the canonical note', () => {
    const m = src.match(/var TAG_FLOOR_NOTE = "([^"]+)"/);
    assert.ok(m, 'TAG_FLOOR_NOTE not declared in ' + path);
    assert.strictEqual(m[1], CANON);
  });
  check(label + ' emits no hardcoded floor literal', () => {
    const stray = src.match(/\+ "10% (?:salary|AAV) floor[^"]*"/g);
    assert.ok(!stray, 'hardcoded floor literal still present: ' + stray);
  });
}

// Exercise the real strip regex out of FO v2 — scoped to the tag-formula
// function, NOT the first .replace() in the file (that one strips non-digits and
// silently turned every fixture into "93110" when this test was first written).
const foSrc = fs.readFileSync(FILES['FO v2'], 'utf8');
const fnStart = foSrc.indexOf('function effectiveTagFormulaForRow(');
assert.ok(fnStart > 0, 'effectiveTagFormulaForRow not found in FO v2');
const fnBody = foSrc.slice(fnStart, foSrc.indexOf('\n  }', fnStart));
const m = fnBody.match(/\.replace\((\/.+?\/[a-z]*)\s*,\s*""\)/);
assert.ok(m, 'strip regex not found inside effectiveTagFormulaForRow');
const STRIP = eval(m[1]);
assert.ok(STRIP.flags.includes('g'), 'strip regex must be global to clear duplicates');
const strip = (s) => s.replace(STRIP, '');

console.log('\nstrip regex — must match EITHER wording, EVERY occurrence');

check('strips the stale salary-floor wording', () => {
  assert.strictEqual(strip('Avg Top 9-31 RB AAV | 10% salary floor (rounded up)'),
                     'Avg Top 9-31 RB AAV');
});

check('strips its OWN output (the asymmetry that caused the bug)', () => {
  assert.strictEqual(strip('Avg Top 9-31 RB AAV | ' + CANON), 'Avg Top 9-31 RB AAV');
});

check('collapses the live Javonte Williams duplicate', () => {
  assert.strictEqual(
    strip('Avg Top 9-31 RB AAV | 10% AAV floor (rounded up to $1K) | 10% AAV floor (rounded up to $1K)'),
    'Avg Top 9-31 RB AAV');
});

check('collapses mixed wordings', () => {
  assert.strictEqual(
    strip('Avg Top 1-6 DL AAV | 10% salary floor (rounded up) | ' + CANON),
    'Avg Top 1-6 DL AAV');
});

check('leaves a formula with no floor note untouched', () => {
  assert.strictEqual(strip('Avg Top 1-6 WR AAV'), 'Avg Top 1-6 WR AAV');
});

check('preserves the tier label itself', () => {
  assert.strictEqual(strip('Avg Top 6-15 QB AAV | 10% salary floor (rounded up)'),
                     'Avg Top 6-15 QB AAV');
});

console.log('\nfull round-trip is idempotent');
const rebuild = (formula) => {
  const f = strip(formula);
  return f + (f ? ' | ' : '') + CANON;
};
check('re-tagging twice yields ONE note, not two', () => {
  const once  = rebuild('Avg Top 9-31 RB AAV');
  const twice = rebuild(once);
  assert.strictEqual(once, twice);
  assert.strictEqual((twice.match(/10% AAV floor/g) || []).length, 1);
});
check('re-tagging a stale-wording contract converges on canon', () => {
  const out = rebuild('Avg Top 9-31 RB AAV | 10% salary floor (rounded up)');
  assert.strictEqual(out, 'Avg Top 9-31 RB AAV | ' + CANON);
  assert.strictEqual(rebuild(out), out);
});
check('re-tagging the Javonte duplicate converges on canon', () => {
  const out = rebuild('Avg Top 9-31 RB AAV | ' + CANON + ' | ' + CANON);
  assert.strictEqual(out, 'Avg Top 9-31 RB AAV | ' + CANON);
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
