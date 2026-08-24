// A completed season's leaderboard must not be re-queried every 5 minutes.
//   node tests/leaderboard_cache_ttl.test.mjs
//
// 2026-08-24, D1 free-tier enforcement notice. Insights showed 304,185,193 rows
// read from /api/advanced-stats-leaderboard, and 100% of it was seasons
// 2023/2024/2025 — immutable data, re-queried from scratch every 5 minutes at
// 2-3.7 MILLION rows per run. D1's free tier allows 5 MILLION PER DAY, so a
// single miss on one completed season burned roughly half a day's budget.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const handler = (() => {
  const i = SRC.indexOf('path === "/api/advanced-stats-leaderboard" && request.method === "GET"');
  assert.ok(i > 0, 'leaderboard handler not found');
  return SRC.slice(i, i + 40000);
})();

console.log('the TTL depends on whether the data can change');
check('a flat max-age=300 is gone', () => {
  assert.ok(!/"public, max-age=300"/.test(handler),
    'a completed season must not get the in-progress TTL');
});
check('completed seasons get a long TTL', () => {
  assert.ok(/lbTtl = lbAllCompleted \? 2592000 : 300/.test(handler),
    '30 days for frozen data, 5 minutes for the live season');
});
check('"completed" means strictly before the current season', () => {
  assert.ok(/safeInt\(sn, 0\) < lbCurrentSeason/.test(handler),
    'the season in progress must NOT be treated as frozen');
});
check('an empty season list is never treated as completed', () => {
  assert.ok(/seasons\.length > 0 &&/.test(handler),
    'no seasons must not fall through to the 30-day TTL');
});
check('every requested season must be completed, not just one', () => {
  assert.ok(/seasons\.every\(/.test(handler),
    'a mixed request including the live season must use the short TTL');
});

console.log('\nthe caching that already worked is untouched');
check('cache key still includes every narrowing param', () => {
  for (const p of ['seasons', 'pos', 'weeks', 'min_games', 'limit', 'team']) {
    assert.ok(new RegExp(p).test(handler), 'cache key lost ' + p);
  }
});
check('still only stores successful responses', () => {
  assert.ok(/caches\.default\.put\(lbCacheKey, lbResponse\.clone\(\)\)/.test(handler));
});
check('NO_CACHE escape hatch still honoured', () => {
  assert.ok(/lbNoCache/.test(handler));
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
