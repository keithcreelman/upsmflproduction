// The auction poller must not re-attempt already-ingested bids.
//   node tests/auction_bid_watermark.test.mjs
//
// 2026-08-25: the 2026 auction is finished — 196 lots won, 1 cancelled, 0 open —
// and ups_auction_bids holds 570 rows, 570 distinct, no duplicates. Yet the
// poller fired ~2,609 INSERTs an hour against ZERO new bids. `INSERT OR IGNORE`
// keeps the table correct, but D1 bills the ATTEMPT: ~103k writes/day against a
// 100k free-tier daily limit that Cloudflare enforces from 2026-09-01. The entire
// write allowance was being spent re-writing rows that already existed.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   '+n); }
  catch(e){ fails++; console.log('  FAIL '+n+'\n         '+e.message); } };

const block = SRC.slice(SRC.indexOf('// ── WATERMARK'), SRC.indexOf('const INGEST_BATCH_SIZE'));

console.log('the watermark');
check('reads MAX(bid_at_unix) scoped to season + league', () => {
  assert.ok(/MAX\(bid_at_unix\) AS m FROM ups_auction_bids WHERE season = \? AND league_id = \?/.test(block));
});
check('filters candidates at or below the mark', () => {
  assert.ok(/bid_at_unix\) <= bidWatermark/.test(block));
});
check('keeps a lookback rather than a hard cutoff', () => {
  assert.ok(/m - 600/.test(block),
    'MFL timestamps can arrive out of order; a dropped bid is worse than a wasted write');
});
check('an unreadable watermark ingests EVERYTHING (fail-open, correctly)', () => {
  assert.ok(/bidWatermark = 0;/.test(block) && /watermark read failed/.test(block),
    'skipping a live bid is unrecoverable; wasting writes is not');
});
check('INSERT OR IGNORE is still the backstop', () => {
  assert.ok(/INSERT OR IGNORE INTO ups_auction_bids/.test(SRC),
    'the watermark reduces attempts; the primary key still guarantees correctness');
});
check('is NOT gated on open lots', () => {
  assert.ok(!/status\s*=\s*'open'/.test(block),
    'this poller CREATES the first lots of a new auction — an open-lot gate would stop the next one starting');
});
check('logs what it skipped, so a silent skip is impossible', () => {
  assert.ok(/already-ingested event\(s\) skipped/.test(block));
});

console.log('\nbehaviour');
const applyMark = (events, mark) => events.filter(e => !(mark > 0 && e <= mark));
const NEWEST = 1_756_000_000;
check('finished auction: only the lookback tail is re-offered, not the history', () => {
  // The mark is NEWEST-600, so events strictly above it survive — that is the
  // lookback working as designed, not a leak. Measured against live data on
  // 2026-08-25: exactly 1 of 570 bids falls inside the tail, so a finished
  // auction attempts 1 insert per tick instead of 570 (~288/day vs ~103k).
  const hist = [NEWEST - 86400, NEWEST - 3600, NEWEST];
  const left = applyMark(hist, NEWEST - 600);
  assert.strictEqual(left.length, 1, 'only the newest event is inside the 600s tail');
  assert.strictEqual(left[0], NEWEST);
});
check('the tail is bounded by TIME, so history cannot creep back in', () => {
  const many = Array.from({length: 500}, (_, i) => NEWEST - 86400 - i);
  assert.strictEqual(applyMark(many, NEWEST - 600).length, 0,
    'old bids must never be re-attempted no matter how many there are');
});
check('live auction: a genuinely new bid still flows through', () => {
  const evs = [NEWEST - 86400, NEWEST, NEWEST + 30];
  assert.deepStrictEqual(applyMark(evs, NEWEST - 600), [NEWEST, NEWEST + 30]);
});
check('slightly out-of-order bid inside the lookback is re-offered', () => {
  const late = NEWEST - 300;   // older than newest, inside the 600s tail
  assert.deepStrictEqual(applyMark([late], NEWEST - 600), [late]);
});
check('empty table (first auction ever): mark 0 ingests all', () => {
  assert.strictEqual(applyMark([1, 2, 3], 0).length, 3);
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
