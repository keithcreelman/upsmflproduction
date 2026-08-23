// Restructure cap — 3 per team per season.
//   node tests/restructure_cap.test.mjs
//
// Canon line 40: "Restructure limit = 3". Suspended 2026-07-31, reinstated
// 2026-08-23 after CBP reached 4 — three of them on Nico Collins, the last
// exactly undoing their own previous restructure.
import assert from 'assert';
import { checkRestructureCap, RESTRUCTURE_MAX_PER_SEASON } from '../worker/src/restructure_cap.js';

const envWith = (n) => ({ UPS_MFL_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ n }) }) }) } });
const envThrows = () => ({ UPS_MFL_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) } });
const base = { season: '2026', leagueId: '74598', fid: '0002' };

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

console.log('the cap');
await check('max is 3', () => assert.strictEqual(RESTRUCTURE_MAX_PER_SEASON, 3));
for (const used of [0, 1, 2]) {
  await check(`${used} used -> allowed`, async () => {
    const r = await checkRestructureCap(envWith(used), base);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.cap.used, used);
  });
}
await check('3 used -> BLOCKED (the CBP case)', async () => {
  const r = await checkRestructureCap(envWith(3), base);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'cap_reached');
  assert.match(r.detail, /all 3 restructures/);
});
await check('already over (4) -> still blocked', async () => {
  assert.strictEqual((await checkRestructureCap(envWith(4), base)).allowed, false);
});

console.log('\ncommish override');
await check('commish may exceed, and it is flagged', async () => {
  const r = await checkRestructureCap(envWith(3), { ...base, isCommishOverride: true });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.overridden, true);
});
await check('override does not fabricate headroom below the cap', async () => {
  const r = await checkRestructureCap(envWith(1), { ...base, isCommishOverride: true });
  assert.strictEqual(r.allowed, true);
  assert.ok(!r.overridden, 'under the cap is not an override');
});

console.log('\nfail-closed — an unreadable count is NOT zero');
await check('D1 throws -> blocked, not allowed', async () => {
  const r = await checkRestructureCap(envThrows(), base);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'cap_unreadable');
  assert.strictEqual(r.cap.used, null);
});
await check('non-numeric count -> blocked', async () => {
  const r = await checkRestructureCap(envWith('banana'), base);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'cap_unreadable');
});
await check('missing franchise -> blocked', async () => {
  const r = await checkRestructureCap(envWith(0), { ...base, fid: '' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'cap_indeterminate');
});
await check('missing season -> blocked', async () => {
  const r = await checkRestructureCap(envWith(0), { ...base, season: '' });
  assert.strictEqual(r.allowed, false);
});
await check('an unreadable count is not overridable by a non-commish', async () => {
  assert.strictEqual((await checkRestructureCap(envThrows(), base)).allowed, false);
});

console.log('\nthe query excludes what it must');
await check('counts only non-dry-run, non-voided rows', async () => {
  let sql = '';
  const env = { UPS_MFL_DB: { prepare: (q) => { sql = q; return { bind: () => ({ first: async () => ({ n: 0 }) }) }; } } };
  await checkRestructureCap(env, base);
  assert.match(sql, /COALESCE\(dry_run, 0\) = 0/, 'dry runs must not count');
  assert.match(sql, /voided_at_utc IS NULL/, 'a reversed restructure must not count');
  assert.match(sql, /season = \? AND franchise_id = \?/, 'scoped per team per season');
  assert.ok(!/player_id/.test(sql), 'cap is per TEAM, not per player');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
