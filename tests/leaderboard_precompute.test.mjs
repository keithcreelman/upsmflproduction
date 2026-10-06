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

// Slice by the block's OWN boundaries, not by a neighbouring landmark. The first
// version sliced from `const lbPreSeason` to `// Map pos alias`, and when the
// block moved (it had to run AFTER `const db =`, not before) that range inverted
// and every check silently passed against an empty string.
const readPath = (() => {
  const a = SRC.indexOf('// ── PRECOMPUTE (migration 0140)');
  assert.ok(a > 0, 'precompute read block not found');
  const b = SRC.indexOf('\n        }', SRC.indexOf('falling through', a));
  assert.ok(b > a, 'could not bound the precompute read block');
  return SRC.slice(a, b);
})();
const buildRoute = (() => {
  const a = SRC.indexOf('if (path === "/admin/leaderboard-precompute/build"');
  assert.ok(a > 0, 'build route not found');
  const b = SRC.indexOf('\n      if (path === ', a + 50);
  assert.ok(b > a, 'could not bound the build route');
  return SRC.slice(a, b);
})();

console.log('the read path');
// PR #988 (2026-08-27) deliberately made the CURRENT season eligible too, gated on
// proof the stored board still matches the data (tests/leaderboard_current_season_
// precompute.test.mjs covers the behaviour). These checks pin the new rules; the old
// "completed season only" / "no week params at all" assertions described pre-#988 code.
check('serves completed seasons and the current one — never a future season', () => {
  assert.ok(/lbPreSeason <= lbCurSeason/.test(readPath), 'a season that has not started must never be served');
  assert.ok(/const lbPreIsCurrent = lbPreSeason > 0 && lbPreSeason === lbCurSeason/.test(readPath));
});
check('the CURRENT season is served only with proof the stored board is fresh', () => {
  assert.ok(/lbPreStale = builtWeek < 0 \|\| builtWeek !== lbPreLiveWeek/.test(readPath),
    'built week must equal the live data week; a NULL data_max_week (-1) can never prove fresh');
  assert.ok(/if \(lbPreAuthWeek === null \|\| lbPreAuthWeek > builtWeek\) lbPreStale = true/.test(readPath),
    "MFL's completed week moving past the build marks it stale");
});
check('only serves the window the stored board IS (weeks 1-17, no explicit week list)', () => {
  assert.ok(/lbWindowMatchesBoard =\s*!weeksParam && \(lbHasWeekRange \? \(lbLo === 1 && lbHi === 17\) : !includePost\)/.test(readPath),
    'include_post or any other range must run live; week_min=1&week_max=17 is the stored board');
  assert.ok(/lbPreEligible =[\s\S]*?lbWindowMatchesBoard;/.test(readPath));
});
check('requires a meta row with a POSITIVE row_count', () => {
  assert.ok(/_preNum\(meta\.row_count\) > 0/.test(readPath),
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
check('REFUSES a season that has not started, and the current one before it has data', () => {
  assert.ok(/if \(season > currentSeason\)/.test(buildRoute), 'a future season must never be built');
  assert.ok(/season === currentSeason && covWeek < 1/.test(buildRoute), 'no week of data yet → nothing to store');
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

// The bug that actually shipped: the route ran BEFORE `sessionByApiKey` was
// declared, so every call died with "Cannot access 'sessionByApiKey' before
// initialization". eslint no-undef does NOT catch a temporal dead zone — the
// identifier exists, it is just not initialized yet. Third TDZ bug in this file
// in two days, so this is asserted rather than remembered.
console.log('\nno safeInt in the leaderboard handler (temporal dead zone)');
check('the precompute read block does not call safeInt', () => {
  assert.ok(!/safeInt\(/.test(readPath),
    "safeInt is declared later in the module; calling it here throws 'Cannot access safeInt4 before initialization' and 500s the endpoint");
});

console.log('\nroute placement (temporal dead zone)');
check('build route is declared AFTER sessionByApiKey', () => {
  const decl = SRC.search(/\n\s*(const|let)\s+sessionByApiKey\s*=/);
  const route = SRC.indexOf('if (path === "/admin/leaderboard-precompute/build"');
  assert.ok(decl > 0 && route > decl,
    'the route must come after the declaration or it throws on every call');
});
check('read path is declared AFTER its `db`', () => {
  const h = SRC.indexOf('path === "/api/advanced-stats-leaderboard" && request.method === "GET"');
  const blk = SRC.slice(h, SRC.indexOf('\n      if (path === "', h + 100));   // the handler's own extent, not a fixed window
  const dbAt = blk.search(/\n\s*const db = /);
  const mine = blk.indexOf('const lbPreSeason');
  assert.ok(dbAt > 0 && mine > dbAt, 'the precompute read must come after `const db =`');
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
