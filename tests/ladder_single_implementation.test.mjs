// There must be exactly ONE implementation of the pre-season ladder boundary.
//   node tests/ladder_single_implementation.test.mjs
//
// Two browser copies existed (desktop front_office.js, mobile
// front_office_actions.js), the desktop one describing itself as a port of the
// other. Copies of a rule drift: that is what dropped `Ext:` from nine contracts
// on 2026-08-22, where one of three writers never received a fix. Both browser
// copies now READ the rung the worker resolves.
import fs from 'fs';
import assert from 'assert';

const FILES = {
  'desktop front_office.js':      'site/rosters/v2/front_office.js',
  'mobile front_office_actions.js':'site/m/front_office_actions.js',
};
const SERVER = fs.readFileSync('worker/src/league_events_ladder.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

function rungFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' not found');
  return src.slice(i, src.indexOf('\n  }', i));
}

console.log('the server owns the decision');
check('worker still implements contractLadderStage', () => {
  assert.ok(/export function contractLadderStage\(/.test(SERVER));
});

console.log('\nneither browser copy recomputes it');
for (const [label, path, fn] of [
  ['desktop', FILES['desktop front_office.js'], 'contractLadderStageFO_desktop'],
  ['mobile',  FILES['mobile front_office_actions.js'], 'contractLadderStageFO'],
]) {
  const body = rungFn(fs.readFileSync(path, 'utf8'), fn);
  check(label + ': no instant comparison remains', () => {
    assert.ok(!/now\s*<=?\s|Date\.now\(\)/.test(body),
      'the open/closed decision must not be recomputed on the client');
  });
  check(label + ': reads the server stamp', () => {
    assert.ok(/contractLadderServer|contractLadder\.server/.test(body),
      'must read the stamped rung');
  });
  check(label + ': fails closed on an absent/unresolved stamp', () => {
    assert.ok(/if \(!stage \|\| stage === "unresolved"\) return UNRESOLVED;/.test(body));
  });
  check(label + ': preserves the {stage,date,endMs} shape', () => {
    for (const k of ['stage', 'date', 'endMs']) {
      assert.ok(new RegExp(k + '\\s*:').test(body), k + ' missing from the return shape');
    }
  });
  check(label + ': only maps rungs the server can emit', () => {
    const mapped = [...body.matchAll(/stage === "([a-z]+)"/g)].map(m => m[1]);
    for (const m of mapped) {
      assert.ok(['unresolved','myac','mym','extension','closed'].includes(m),
        `maps "${m}" which the server never emits`);
    }
  });
}

console.log('\nthe boundary constants live in ONE place');
check('no browser file hardcodes the week-3/week-5 rung boundary in its rung fn', () => {
  for (const [label, path, fn] of [
    ['desktop', FILES['desktop front_office.js'], 'contractLadderStageFO_desktop'],
    ['mobile',  FILES['mobile front_office_actions.js'], 'contractLadderStageFO'],
  ]) {
    const body = rungFn(fs.readFileSync(path, 'utf8'), fn);
    assert.ok(!/weekKickoffs\s*\[\s*[35]\s*\]/.test(body),
      label + ' still reaches for a kickoff boundary inside the rung function');
  }
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
