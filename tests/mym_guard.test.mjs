// §C3 MYM guards — the 4-per-season cap and the 14-day window.
//   node tests/mym_guard.test.mjs
//
// These existed only in a client that says it is "best-effort", so a direct
// POST to /offer-mym bypassed both. Built 2026-08-17 on Keith's call.
//
// The asymmetry that shapes every assertion below: an owner wrongly LOCKED OUT
// of a contract window they are entitled to is a worse failure than one extra
// MYM the commish can unwind. So an unreadable input must always resolve to
// allowed, with a stated reason — never to a block.
import {
  checkMymSeasonCap, checkMymWindow, checkMymEligibility,
  MYM_MAX_PER_SEASON, MYM_WINDOW_DAYS,
} from '../worker/src/mym_guard.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

const DAY = 86400;
const NOW = 1789491600;
// Minimal D1 stand-in. `count` = MYMs used; `add` = the acquisition row.
const envWith = ({ count = 0, add = null, throwOn = null }) => ({
  UPS_MFL_DB: {
    prepare: (sql) => ({
      bind: () => ({
        first: async () => {
          if (throwOn && sql.includes(throwOn)) throw new Error('D1 down');
          if (sql.includes('ups_mym_submissions')) return { n: count };
          if (sql.includes('ups_add_events')) return add;
          return null;
        },
      }),
    }),
  },
});
const args = { season: '2026', leagueId: '74598', fid: '0008', playerId: '13142', nowUnix: NOW };

console.log('\n-- the 4-per-season cap (§C3) --');
t('max is 4', MYM_MAX_PER_SEASON, 4);
t('0 used -> allowed', (await checkMymSeasonCap(envWith({ count: 0 }), args)).allowed, true);
t('3 used -> allowed', (await checkMymSeasonCap(envWith({ count: 3 }), args)).allowed, true);
t('4 used -> BLOCKED', (await checkMymSeasonCap(envWith({ count: 4 }), args)).allowed, false);
t('5 used -> blocked', (await checkMymSeasonCap(envWith({ count: 5 }), args)).allowed, false);
t('blocked reason', (await checkMymSeasonCap(envWith({ count: 4 }), args)).reason, 'mym_season_cap');
t('message names the count', /already used 4 of 4/.test((await checkMymSeasonCap(envWith({ count: 4 }), args)).detail), true);

console.log('\n-- the 14-day window (§C3) --');
t('window is 14 days', MYM_WINDOW_DAYS, 14);
t('day 1 -> allowed',  (await checkMymWindow(envWith({ add: { acquired_at_unix: NOW - 1 * DAY, source: 'bbid' } }), args)).allowed, true);
t('day 13 -> allowed', (await checkMymWindow(envWith({ add: { acquired_at_unix: NOW - 13 * DAY, source: 'bbid' } }), args)).allowed, true);
// Exactly 14 days is the last legal instant, not the first illegal one.
t('exactly 14 days -> allowed', (await checkMymWindow(envWith({ add: { acquired_at_unix: NOW - 14 * DAY, source: 'bbid' } }), args)).allowed, true);
t('one second past 14 days -> BLOCKED', (await checkMymWindow(envWith({ add: { acquired_at_unix: NOW - 14 * DAY - 1, source: 'fcfs' } }), args)).allowed, false);
t('blocked reason', (await checkMymWindow(envWith({ add: { acquired_at_unix: NOW - 20 * DAY, source: 'bbid' } }), args)).reason, 'mym_window_closed');
// Canon: the clock does NOT reset on trade. That falls out of the source —
// ups_add_events records the ORIGINAL bbid/fcfs add, and a trade writes none.
t('no add event -> a different window governs, not a block',
  (await checkMymWindow(envWith({ add: null }), args)).allowed, true);
t('reason names it', (await checkMymWindow(envWith({ add: null }), args)).reason, 'no_in_season_add');

console.log('\n-- unreadable inputs NEVER block a legal submission --');
t('no db -> allowed', (await checkMymWindow({}, args)).allowed, true);
t('count query throws -> allowed', (await checkMymSeasonCap(envWith({ throwOn: 'ups_mym_submissions' }), args)).allowed, true);
t('and says why', (await checkMymSeasonCap(envWith({ throwOn: 'ups_mym_submissions' }), args)).reason, 'mym_count_unreadable');
t('add query throws -> allowed', (await checkMymWindow(envWith({ throwOn: 'ups_add_events' }), args)).allowed, true);

console.log('\n-- combined: first blocking reason wins, one clear message --');
const capped = await checkMymEligibility(envWith({ count: 4, add: { acquired_at_unix: NOW - 1 * DAY } }), args);
t('cap blocks even with an open window', [capped.allowed, capped.reason], [false, 'mym_season_cap']);
const expired = await checkMymEligibility(envWith({ count: 0, add: { acquired_at_unix: NOW - 30 * DAY } }), args);
t('window blocks even with slots left', [expired.allowed, expired.reason], [false, 'mym_window_closed']);
t('both clean -> allowed', (await checkMymEligibility(envWith({ count: 1, add: { acquired_at_unix: NOW - 2 * DAY } }), args)).allowed, true);

console.log('\n-- the commish can always push one through, and it is RECORDED --');
const ov = await checkMymEligibility(envWith({ count: 4 }), { ...args, isCommishOverride: true });
t('override allows', ov.allowed, true);
t('override is flagged, not silent', ov.overridden, true);
t('and keeps the reason it bypassed', ov.reason, 'mym_season_cap');

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
