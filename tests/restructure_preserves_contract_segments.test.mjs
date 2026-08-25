// A restructure must not destroy contract history it does not own.
//   node tests/restructure_preserves_contract_segments.test.mjs
//
// FO v2's rebuild enumerated the segments it knew and dropped the rest. That lost
// AAV and the -FL/-BL suffix (Cook/London, 2026-07), then `Ext:` on nine contracts
// restructured in 2026 — backfilled 2026-08-22. `Ext:` records which franchises
// spent an extension, so losing it silently re-grants an extension already used.
//
// Extracts the real helper by text (not import) because front_office.js is a
// browser script with top-level bindings. A rename fails this file loudly, which
// is the intent.
import fs from 'fs';
import assert from 'assert';

const foPath = 'site/rosters/v2/front_office.js';
const src = fs.readFileSync(foPath, 'utf8');

function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for ' + startMarker);
  return src.slice(i, j + endMarker.length);
}

const ownedRe = grab('var RESTRUCTURE_OWNED_SEGMENT =', '/i;');
const helper  = grab('function preservedContractSegments(contractInfo) {', '\n  }');
const prelude = 'const safeStr=(v)=>v==null?"":String(v);\n';
const preserved = eval(`(() => { ${prelude}${ownedRe}\n${helper}\n return preservedContractSegments; })()`);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n         ' + e.message); }
};

console.log('preservedContractSegments — segments a restructure must carry through');

check('preserves Ext: (gates extension eligibility)', () => {
  assert.deepStrictEqual(
    preserved('CL 2|TCV 64K|AAV 27K, 37K|Y1-14K, Y2-50K|Ext: CBP|GTD: 48K|Restructured 2026'),
    ['Ext: CBP']);
});

check('preserves a multi-franchise Ext: verbatim', () => {
  assert.deepStrictEqual(
    preserved('CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|Ext: Gride, Hammer|GTD: 89.3K'),
    ['Ext: Gride, Hammer']);
});

check('preserves the full tag quartet', () => {
  assert.deepStrictEqual(
    preserved('CL 1| TCV 4K| AAV 4K| Tag| Tier 1| Formula: Avg Top 1-6 DB AAV'),
    ['Tag', 'Tier 1', 'Formula: Avg Top 1-6 DB AAV']);
});

check('preserves the 10% salary floor note', () => {
  assert.ok(preserved('CL 1|TCV 4K|AAV 4K|Tag|10% salary floor (rounded up)')
    .includes('10% salary floor (rounded up)'));
});

check('drops every segment the restructure recomputes', () => {
  assert.deepStrictEqual(
    preserved('CL 2|TCV 64K|AAV 27K|Y1-14K, Y2-50K|GTD: 48K|Restructured 2026'), []);
});

check('treats lowercase "restructure: 2026" as owned (no double stamp)', () => {
  assert.deepStrictEqual(preserved('CL 2|TCV 64K|AAV 27K|restructure: 2026'), []);
});

check('tolerates leading whitespace in segments', () => {
  assert.deepStrictEqual(
    preserved('CL 2| TCV 95K| AAV 33K, 43K| Y1-20K, Y2-75K| Ext: PG| GTD: 71.3K'),
    ['Ext: PG']);
});

check('empty / missing contractInfo yields no segments', () => {
  assert.deepStrictEqual(preserved(''), []);
  assert.deepStrictEqual(preserved(null), []);
});

// The nine contracts the 2026 bug actually hit.
console.log('\nthe nine 2026 casualties round-trip');
const NINE = [
  ['James Cook',      'CL 2|TCV 64K|AAV 27K, 37K|Y1-14K, Y2-50K|Ext: CBP|GTD: 48K',            'Ext: CBP'],
  ['Jalen Hurts',     'CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|Ext: Gride, Hammer|GTD: 89.3K','Ext: Gride, Hammer'],
  ['Jordan Love',     'CL 2|TCV 52K|AAV 21K, 31K|Y1-11K, Y2-41K|Ext: PG|GTD: 39K',              'Ext: PG'],
  ["De'Von Achane",   'CL 2| TCV 50K| AAV 25K| Y1-10K, Y2-40K|Ext: Gride| GTD: 37.5K',          'Ext: Gride'],
  ['Drake London',    'CL 2| TCV 95K| AAV 33K, 43K| Y1-20K, Y2-75K|Ext: PG| GTD: 71.3K',        'Ext: PG'],
  ['Nico Collins',    'CL 2|TCV 94K|AAV 42K|Y1-19K, Y2-75K|Ext: C-Town, CBP|GTD: 70.5K',        'Ext: C-Town, CBP'],
  ['Rashee Rice',     'CL 2| TCV 50K| AAV 25K| Y1-10K, Y2-40K|Ext: LH| GTD: 37.5K',             'Ext: LH'],
  ['Puka Nacua',      'CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K|Ext: Bomb| GTD: 33K',              'Ext: Bomb'],
  ['Bijan Robinson',  'CL 2|TCV 70K|AAV 35K|Y1-14K, Y2-56K|Ext: Cash|GTD: 52.5K',               'Ext: Cash'],
];
for (const [name, info, want] of NINE) {
  check(name, () => assert.deepStrictEqual(preserved(info), [want]));
}

// FO v2 was the ONLY writer missing Ext: handling. Guard all three so a fourth
// copy, or a regression in one, is caught here rather than in live contracts.
// All THREE writers must PRESERVE unowned segments, not extract one known token.
// #947 fixed only FO v2. The other two kept a single-token `Ext:.*$` extractor —
// greedy, anchored to end-of-string, assuming Ext: was last — and Drake London
// lost `Ext: PG` on 2026-08-24, two days later, through one of them.
console.log('\nall restructure writers PRESERVE unowned segments');
for (const [label, path, needle] of [
  ['FO v2',            foPath,                                     'preservedContractSegments(p.special)'],
  ['roster workbench', 'site/rosters/roster_workbench.js',         'preservedContractSegments('],
  ['mobile submitter', 'site/m/front_office_restructure_submit.js','preservedContractSegments('],
]) {
  check(label + ' carries the extension token', () => {
    const body = fs.readFileSync(path, 'utf8').replace(/\s+/g, ' ');
    assert.ok(body.includes(needle.replace(/\s+/g, ' ')),
      path + ' no longer PRESERVES unowned segments through a restructure');
  });
}

// Position independence — the failure that actually bit.
console.log('\nExt: is preserved wherever it sits, not only when last');
for (const [label, path] of [
  ['roster workbench', 'site/rosters/roster_workbench.js'],
  ['mobile submitter', 'site/m/front_office_restructure_submit.js'],
]) {
  const src = fs.readFileSync(path, 'utf8');
  check(label + ': no greedy end-anchored Ext: capture drives the rebuild', () => {
    const i = src.indexOf('preservedContractSegments(contractInfo)');
    assert.ok(i > 0, 'preservedContractSegments missing');
    const body = src.slice(i, src.indexOf('\n  }', i));
    assert.ok(!/Ext:\.\*\$/.test(body),
      'a greedy Ext:.*$ capture swallows GTD and Restructured when Ext: is mid-string');
  });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
