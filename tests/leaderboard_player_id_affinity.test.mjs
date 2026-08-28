// The leaderboard's two player joins must compare TEXT to TEXT.
//   node tests/leaderboard_player_id_affinity.test.mjs
//
// src_players.player_id and src_contracts.player_id are TEXT; the crosswalk's
// mfl_player_id is INTEGER. Comparing them with `=` makes SQLite apply NUMERIC
// affinity to the TEXT side, and a TEXT B-tree cannot be seeked with a
// numerically-coerced key — so both CTEs silently lose their primary key, get
// flattened into the outer loop, and rescan the whole season slice ONCE PER
// OUTPUT ROW. That was ~3.3M of the idp query's ~5M row reads.
//
// Nothing about the query looked wrong. The only visible symptom was the cost,
// and the in-file comments attributed it to a different (already-fixed) cause.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// Slice just the two join lines. Asserted non-empty so a drifted anchor fails
// loudly instead of passing vacuously against an empty string.
const jStart = SRC.indexOf('LEFT JOIN latest_contract lc');
const jEnd = SRC.indexOf('WHERE a.games >= ?', jStart);
const joins = jStart > 0 && jEnd > jStart ? SRC.slice(jStart, jEnd) : '';

console.log('anchors hold');
check('the join block is locatable and substantial', () => {
  assert.ok(jStart > 0 && jEnd > jStart, 'join anchors not found');
  assert.ok(joins.length > 100, `slice is ${joins.length} chars`);
});

console.log('\nneither join compares TEXT to INTEGER');
for (const alias of ['lc', 'ctm']) {
  check(`${alias} does not use the bare numeric equality`, () => {
    const re = new RegExp(`${alias}\\.player_id\\s*=\\s*c\\.mfl_player_id`);
    assert.ok(!re.test(joins),
      `${alias}.player_id = c.mfl_player_id forces numeric affinity and loses the PK seek`);
  });
  check(`${alias} compares against a TEXT rendering of the id`, () => {
    const re = new RegExp(`${alias}\\.player_id\\s+IN \\(printf\\('%04d', c\\.mfl_player_id\\),`);
    assert.ok(re.test(joins), `${alias} must match on printf('%04d', ...) so the TEXT index is seekable`);
  });
}

console.log('\nthe NULL guard is present on both');
check('both joins guard c.mfl_player_id IS NOT NULL', () => {
  const n = (joins.match(/c\.mfl_player_id IS NOT NULL/g) || []).length;
  assert.strictEqual(n, 2,
    "printf('%04d', NULL) returns the STRING '0000', not NULL — without the guard a player " +
    "missing from the crosswalk would match any player_id='0000' row, where the numeric compare matched nothing");
});

console.log('\nthe printf width matches the stored format');
check("padding is %04d, matching MFL's 4-digit ids", () => {
  assert.ok(!/printf\('%0[^4]d'/.test(joins),
    'src_players stores 384 zero-padded 4-char ids; a different width would silently under-match');
});

// ── the window gate ────────────────────────────────────────────────────────
const gStart = SRC.indexOf('const lbHasWeekRange');
const gEnd = SRC.indexOf('if (lbPreEligible) {', gStart);
const gate = gStart > 0 && gEnd > gStart ? SRC.slice(gStart, gEnd) : '';

console.log('\nthe precompute gate admits exactly the stored window');
check('gate slice is locatable', () => {
  assert.ok(gate.length > 200, `gate slice is ${gate.length} chars`);
});
check('include_post is consulted', () => {
  assert.ok(/!includePost/.test(gate),
    'include_post=1 with no week params runs 1=1 live (22 weeks) but was served the 17-week board');
});
check('an explicit 1..17 window is accepted', () => {
    assert.ok(/lbLo === 1 && lbHi === 17/.test(gate),
      'stats_workbench sends week_min/week_max on every request; its default scope IS the stored window');
});
check('the old "no week params at all" test is gone', () => {
  assert.ok(!/!weeksParam && !weekMinParam && !weekMaxParam/.test(SRC),
    'that test was both too permissive (ignored include_post) and too strict (refused the workbench)');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
