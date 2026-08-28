// CTEs a phase never projects are gated to EMPTY, not merely joined and ignored.
//   node tests/leaderboard_phase_dead_ctes.test.mjs
//
// The projection has been phase-conditional since 2026-06-20; the CTEs behind it
// were not. pos=idp still built and joined four team_* aggregates no idp column
// reads, and every phase built the redzone rollup inside agg.
//
// They are gated with a constant-false predicate rather than removed, so the
// LEFT JOINs all survive and output identity is structural: an empty right side
// cannot add or drop an outer row, it only makes columns NULL — columns this
// phase does not select. SQLite elides the scan (prod: 35,445 rows -> 1).
//
// The subtle one: season_adv_agg (sv) IS used by COL_IDP. Only "special" may
// drop it. A gate keyed on `=== "offense"` there would blank every idp
// advanced-stat column while every test that only checks row counts still passed.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

const grab = (n) => {
  const i = SRC.indexOf('const ' + n + ' = `');
  return i < 0 ? '' : SRC.slice(i + ('const ' + n + ' = `').length, SRC.indexOf('`;', i));
};
const stripSql = (t) => t.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

console.log('the gates exist and key off the right phase');
for (const [name, expr] of [
  ['_gTeamShare', '_useTeamShare ? "1=1" : "1=0"'],
  ['_gTeamSitu',  '_useTeamSitu  ? "1=1" : "1=0"'],
  ['_gSeasonAdv', '_useSeasonAdv ? "1=1" : "1=0"'],
  ['_gRedzone',   '_useRedzone   ? "1=1" : "1=0"'],
]) {
  check(`${name} is defined`, () => {
    // Whitespace-insensitive: these declarations are column-aligned for
    // readability, and a test that breaks when someone re-aligns them is a
    // test that gets deleted rather than fixed.
    const norm = (t) => t.replace(/\s+/g, ' ');
    assert.ok(norm(SRC).includes(norm(`const ${name} = ${expr};`)),
      `expected (modulo whitespace): const ${name} = ${expr};`);
  });
}
check('_useSeasonAdv is NOT offense-only — idp projects sv', () => {
  assert.ok(/const _useSeasonAdv = \(_phase !== "special"\);/.test(SRC),
    'COL_IDP references sv, so gating season_adv_agg on _phase === "offense" would blank every ' +
    'idp advanced-stat column while row counts stayed correct');
});

console.log('\nevery gated alias really is unused by the phases that drop it');
const cols = { shared: stripSql(grab('COL_SHARED')), offense: stripSql(grab('COL_OFFENSE')),
               idp: stripSql(grab('COL_IDP')), special: stripSql(grab('COL_SPECIAL')) };
const uses = (body, alias) => new RegExp(`\\b${alias}\\.[a-z_]`).test(body);
check('COL_SHARED uses none of ta/tr/trpa/tsa/sv (so gating by phase is sound at all)', () => {
  for (const a of ['ta','tr','trpa','tsa','sv']) {
    assert.ok(!uses(cols.shared, a), `${a} is in COL_SHARED — it cannot be gated by phase`);
  }
});
for (const [alias, allowed] of [['ta',['offense']], ['tr',['offense']], ['trpa',['offense']],
                                ['tsa',['special']], ['sv',['offense','idp']]]) {
  check(`${alias} is projected only by: ${allowed.join(', ')}`, () => {
    for (const ph of ['offense','idp','special']) {
      assert.strictEqual(uses(cols[ph], alias), allowed.includes(ph),
        `${alias} usage in COL_${ph.toUpperCase()} does not match the gate`);
    }
  });
}

console.log('\nthe redzone columns of agg are offense-only');
check('no rz-fed column appears outside COL_OFFENSE', () => {
  const agg = SRC.slice(SRC.indexOf('agg AS ('), SRC.indexOf('snap_agg AS ('));
  const rzCols = [...agg.matchAll(/SUM\(COALESCE\(rz\.[a-z_0-9]+,\s*0\)\)\s+AS\s+([a-z_0-9]+)/g)].map((m) => m[1]);
  assert.ok(rzCols.length >= 5, `only found ${rzCols.length} rz-fed columns — the anchor has drifted`);
  for (const ph of ['shared','idp','special']) {
    const hit = rzCols.filter((c) => new RegExp(`\\b${c}\\b`).test(cols[ph]));
    assert.deepStrictEqual(hit, [], `COL_${ph.toUpperCase()} reads rz-fed column(s) ${hit.join(', ')}`);
  }
});

console.log('\nthe gates are actually applied in the SQL');
const region = (a, b) => SRC.slice(SRC.indexOf(a), SRC.indexOf(b, SRC.indexOf(a)));
for (const [cte, next, gate] of [
  ['team_agg AS (',              'team_situational_agg AS (',  '_gTeamShare'],
  ['team_situational_agg AS (',  'team_rz_agg AS (',           '_gTeamSitu'],
  ['team_rz_agg AS (',           'team_rz_player_active AS (', '_gTeamShare'],
  ['team_rz_player_active AS (', 'season_adv_agg AS (',        '_gTeamShare'],
  ['season_adv_agg AS (',        'SELECT ${projection}',       '_gSeasonAdv'],
]) {
  check(`${cte.split(' ')[0]} gates every WHERE with ${gate}`, () => {
    const body = region(cte, next);
    assert.ok(body.length > 50, `region for ${cte} is ${body.length} chars — anchor drifted`);
    const wheres = (body.match(/\n\s*WHERE /g) || []).length;
    const gated = (body.match(new RegExp(`WHERE \\$\\{${gate}\\} AND `, 'g')) || []).length;
    assert.ok(wheres > 0, 'no WHERE clause found');
    assert.strictEqual(gated, wheres,
      `${gated} of ${wheres} WHERE clauses gated — an ungated one still scans`);
  });
}
check('the agg redzone join is gated', () => {
  assert.ok(/LEFT JOIN nfl_player_redzone rz\s*\n\s*ON \$\{_gRedzone\}/.test(SRC),
    'the rz join must be gated or every phase pays for the redzone rollup');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
