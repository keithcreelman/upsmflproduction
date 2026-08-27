// The leaderboard precompute may now serve the CURRENT season.
//   node tests/leaderboard_current_season_precompute.test.mjs
//
// A completed season is frozen, so 0140 needed no freshness concept. The live
// season changes every time the ETL lands a week, which introduces three ways
// to be wrong that did not exist before:
//   1. the builder self-fetches through env.SELF and would be served its OWN
//      stored rows (NO_CACHE gates the edge cache only), freezing the board;
//   2. a precompute hit set a 30-DAY Cache-Control, which for a mutable season
//      hides every rebuild behind the edge;
//   3. an unknown freshness stamp read as "fresh" would freeze it silently.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
const MIG = fs.readFileSync('worker/migrations/0143_leaderboard_precompute_current_season.sql', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// Slice the READ gate. Asserted non-empty: a drifted anchor would otherwise
// make every check below pass vacuously against an empty string.
const rStart = SRC.indexOf('const lbPreSeason = seasons.length === 1');
const rEnd = SRC.indexOf('[leaderboard precompute] read failed', rStart);
const readGate = rStart > 0 && rEnd > rStart ? SRC.slice(rStart, rEnd) : '';

// Slice the BUILD route.
const bStart = SRC.indexOf('if (path === "/admin/leaderboard-precompute/build"');
const bEnd = SRC.indexOf('if (path === "/admin/discord/post"', bStart);
const buildRoute = bStart > 0 && bEnd > bStart ? SRC.slice(bStart, bEnd) : '';

console.log('anchors hold (else everything below is vacuous)');
check('read gate slice is substantial', () => {
  assert.ok(readGate.length > 800, `read gate slice is ${readGate.length} chars`);
});
check('build route slice is substantial', () => {
  assert.ok(buildRoute.length > 800, `build route slice is ${buildRoute.length} chars`);
});

console.log('\n1. the builder cannot be served its own output');
check('the self-fetch sends NO_PRECOMPUTE=1', () => {
  assert.ok(/NO_PRECOMPUTE=1/.test(buildRoute),
    'NO_CACHE=1 gates caches.default only — without this the builder re-stores the rows it is overwriting');
});
check('NO_PRECOMPUTE disables the D1 gate', () => {
  assert.ok(/!lbNoPre/.test(readGate), 'lbPreEligible must consult lbNoPre');
});
check('NO_PRECOMPUTE also bypasses the EDGE read', () => {
  assert.ok(/if \(!lbNoCache && !lbNoPre\) \{/.test(SRC),
    'lbCacheKey has no NO_PRECOMPUTE component, so a cached precompute body would be returned before the D1 gate');
});
check('the builder refuses a response marked source:"precompute"', () => {
  assert.ok(/j\.source === "precompute"/.test(buildRoute),
    'belt-and-braces: if NO_PRECOMPUTE ever stops working this must fail loudly, not write a successful-looking no-op');
});

console.log('\n2. a mutable season is not cached like a frozen one');
check('current season gets 300s, completed keeps 30 days', () => {
  assert.ok(/max-age=\$\{lbPreIsCurrent \? 300 : 2592000\}/.test(SRC),
    'a 30-day edge TTL on the live season would hide every rebuild');
});

console.log('\n3. unknown freshness is never "fresh"');
check('the current season is eligible at all', () => {
  assert.ok(/lbPreSeason <= lbCurSeason/.test(readGate),
    'the gate was `< lbCurSeason`, which excluded the current season entirely');
});
check('NULL data_max_week is treated as unprovable, not as week 0', () => {
  assert.ok(/data_max_week === null \|\| meta\.data_max_week === undefined\)\s*\?\s*-1/.test(readGate),
    'every row written by 0140 predates this column; coercing NULL to 0 would read as "matches" the moment live week is 0');
});
check('freshness is scoped to week <= 17, matching the stored board', () => {
  assert.ok(/MAX\(week\) AS mw FROM nfl_player_weekly WHERE season = \? AND week <= 17/.test(readGate),
    'an unscoped MAX(week) climbs to 18 then 22 in the playoffs and reports a final board as stale');
});
check('there is no wall-clock TTL', () => {
  assert.ok(!/built_at_utc/.test(readGate),
    'the builder re-stamps built_at_utc on every run, so a wall-clock TTL resets on each frozen re-store — tightening the cron would make a freeze MORE permanent');
});

console.log('\n4. the stamp is written AND updated');
check('data_max_week appears in the DO UPDATE list, not just the INSERT', () => {
  const m = buildRoute.match(/ON CONFLICT \(season, pos_alias\) DO UPDATE SET[\s\S]{0,400}?`/);
  assert.ok(m, 'meta upsert not found');
  assert.ok(/data_max_week\s*=\s*excluded\.data_max_week/.test(m[0]),
    'source_sha (0140) is the precedent: declared, never written, silently always NULL. ' +
    'Insert-without-update would pin week 1 forever and the gate would report stale for the rest of the season');
});
check('the builder fails closed when coverage cannot be read', () => {
  assert.ok(/refusing to build against an unknown stamp/.test(buildRoute),
    'an unreadable coverage read must not be treated as week 0');
});
check('a future season is still refused', () => {
  assert.ok(/season > currentSeason/.test(buildRoute), 'only the FUTURE should be refused now');
});

console.log('\n5. the read no longer pays 5x for a predicate that filters nothing');
check('games >= is omitted when min_games cannot filter', () => {
  assert.ok(/minGames > 1 \? ` AND games >= \$\{minGames\}` : ``/.test(SRC),
    'measured on prod: LIMIT 200 with `games >= 1` reads 1000 rows, without it 200');
});

console.log('\n6. migration 0143 adds no index');
check('no CREATE INDEX (the PK already leads with season, week)', () => {
  assert.ok(!/CREATE\s+INDEX/i.test(MIG),
    'an index on (season, week) would write ~270k rows — ~270% of the daily write cap — for a query already answered in 1 row read');
});
check('both columns are added', () => {
  assert.ok(/ADD COLUMN data_max_week/.test(MIG) && /ADD COLUMN data_row_count/.test(MIG));
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
