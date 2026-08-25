// The leaderboard precompute must never turn a missing build into "nobody played".
//   node tests/leaderboard_precompute.test.mjs
//
// Built 2026-08-25 for D1 free-tier enforcement (2026-09-01). The live query
// reads 2.0-3.7 MILLION rows per run against a 5-MILLION-per-day limit; 100% of
// measured reads were COMPLETED seasons, whose answers are frozen forever.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
const MIG = fs.readFileSync('worker/migrations/0140_leaderboard_precompute.sql', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const readPath = SRC.slice(SRC.indexOf('const lbPreSeason'), SRC.indexOf('// Map pos alias'));
const buildRoute = SRC.slice(SRC.indexOf('if (path === "/admin/leaderboard-precompute/build"'),
                             SRC.indexOf('if (path === "/api/advanced-stats-leaderboard"'));

console.log('the read path');
check('only serves a COMPLETED season', () => {
  assert.ok(/lbPreSeason < \(safeInt\(YEAR, 0\)/.test(readPath),
    'the live season must never be served from a frozen snapshot');
});
check('only serves an unfiltered week window', () => {
  assert.ok(/!weeksParam && !weekMinParam && !weekMaxParam/.test(readPath));
});
check('requires a meta row with a POSITIVE row_count', () => {
  assert.ok(/row_count, 0\) > 0/.test(readPath),
    'a zero-row build must not be treated as a valid precompute');
});
check('MISSING precompute falls through to the live query', () => {
  assert.ok(/falling through/.test(readPath) || /catch \(err\)/.test(readPath),
    'a read failure must fall through, never return empty');
});
check('an empty precompute result falls through too', () => {
  assert.ok(/if \(preRows\.length\)/.test(readPath),
    'zero rows must NOT be returned as a leaderboard — that reports nobody played');
});
check('applies the same post-SQL filters as the live path', () => {
  for (const f of ['punter', 'FA', 'padded']) assert.ok(new RegExp(f).test(readPath), 'missing filter: ' + f);
});
check('min_games and limit are applied in SQL, not after', () => {
  assert.ok(/games >= \?/.test(readPath) && /LIMIT \?/.test(readPath),
    'filtering after the read would defeat the point — read only what is returned');
});

console.log('\nthe build route');
check('gated on sessionByApiKey, the gate other admin routes use', () => {
  assert.ok(/if \(!sessionByApiKey\)/.test(buildRoute));
});
check('no invented identifier (commishOk) in code', () => {
  const code = buildRoute.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/commishOk/.test(code), 'commishOk exists nowhere — it would ReferenceError');
});
check('REFUSES to freeze the current season', () => {
  assert.ok(/season >= currentSeason/.test(buildRoute));
});
check('does NOT store a zero-row result', () => {
  assert.ok(/if \(!rows\.length\)/.test(buildRoute) && /not stored/.test(buildRoute),
    'storing zero rows would make the read path serve an empty leaderboard');
});
check('reuses the live endpoint via env.SELF, not a second copy of the SQL', () => {
  assert.ok(/env\.SELF\.fetch/.test(buildRoute),
    'the public workers.dev URL 404s silently from inside a Worker');
  assert.ok(/advanced-stats-leaderboard/.test(buildRoute));
});
check('batches writes rather than one giant batch', () => {
  assert.ok(/i \+= 50/.test(buildRoute), 'D1 caps statements per batch');
});

console.log('\nthe migration');
check('one row PER PLAYER, not per position group', () => {
  assert.ok(/PRIMARY KEY \(season, pos_alias, rank\)/.test(MIG),
    'per-group JSON hits 724 KB against a 1 MB row ceiling');
});
check('carries the filter columns so reads do not parse JSON', () => {
  for (const c of ['games', 'punts', 'franchise_id']) {
    assert.ok(new RegExp(c + '\\s+(INTEGER|TEXT)').test(MIG), 'missing column: ' + c);
  }
});
check('warns against wrangler d1 migrations apply', () => {
  assert.ok(/NEVER `wrangler d1 migrations apply`/.test(MIG));
});
check('has a meta table so "absent" is distinguishable from "empty"', () => {
  assert.ok(/nfl_leaderboard_precompute_meta/.test(MIG));
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
