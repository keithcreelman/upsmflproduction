// nflverse stats refresh — widened schedule (2026-09-28, revised same day for
// provisional weekly data).
//   node tests/nflverse_refresh_schedule.test.mjs
//
// THE ORIGINAL DEFECT: a single Wednesday-11:00-UTC cron meant Monday-morning
// site visitors saw the prior week's numbers even in weeks nflverse had
// already published by Tuesday.
//
// REVISED SAME DAY: Keith's follow-up made explicit that "wait for all 32
// teams" only ever governed calling a week FINALIZED, not loading it at all —
// Sunday's games should show up Sunday night/Monday morning as PROVISIONAL,
// not wait for Monday Night Football. So the schedule grew two more runs:
// a Sunday-night pickup and a post-Monday-Night-Football run that's normally
// what actually finalizes the week. All six runs share the SAME idempotent
// refresh + exit-code-3 "not published yet" handling (unchanged by this
// pass), and the downstream leaderboard rebuild is itself idempotent (skips
// when source coverage hasn't changed — see the no_change guard in
// /admin/leaderboard-precompute/build), so an early run is always safe.
import fs from "fs";
import assert from "assert";

const SRC = fs.readFileSync(".github/workflows/nflverse-stats-refresh.yml", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("schedule");
check("YAML parses", () => {
  // No YAML lib dependency assumed present — a plain structural sanity check
  // (balanced `on:`/`jobs:` blocks, no tab characters, which YAML forbids)
  // catches the class of mistake a hand-edit is likely to introduce. The full
  // workflow-syntax validation happens in CI (actions/checkout + GitHub's own
  // parser on push); this just fails fast, locally, before that round-trip.
  assert.ok(!/\t/.test(SRC), "YAML must not contain tab characters");
  assert.match(SRC, /^on:\s*$/m);
  assert.match(SRC, /^jobs:\s*$/m);
});
check("Sunday-night provisional pickup exists (Monday 05:00 UTC ~1am ET)", () => {
  assert.match(SRC, /cron:\s*"0 5 \* \* 1"/);
});
check("Monday-morning catch-up exists (13:00 UTC ~9am ET)", () => {
  assert.match(SRC, /cron:\s*"0 13 \* \* 1"/);
});
check("post-Monday-Night-Football run exists (Tuesday 05:00 UTC ~1am ET) — normally what finalizes the week", () => {
  assert.match(SRC, /cron:\s*"0 5 \* \* 2"/);
});
check("both original Tuesday correction checks are UNCHANGED (nflverse's typical publish window)", () => {
  assert.match(SRC, /cron:\s*"0 12 \* \* 2"/);
  assert.match(SRC, /cron:\s*"0 20 \* \* 2"/);
});
check("Wednesday backstop is preserved (was the ONLY run before the first widening)", () => {
  assert.match(SRC, /cron:\s*"0 11 \* \* 3"/);
});
check("exactly 6 scheduled runs/week — widen deliberately, not by accident, and not hourly", () => {
  const crons = [...SRC.matchAll(/- cron:/g)];
  assert.strictEqual(crons.length, 6, `found ${crons.length} cron entries`);
});

console.log("\nsafety: every added run must be a genuine no-op when data isn't ready");
check("the not-published exit code (3) is still treated as ok, not a failure", () => {
  assert.match(SRC, /elif \[ "\$\{rc\}" = "3" \]; then echo "\$\{src\}: not published yet"; stamp "\$\{src\}" not_published/);
});
check("a not-published source does not set FAILED=1 (so the job still exits 0 and the leaderboard rebuild can still fire for the OTHER sources that did land)", () => {
  const i = SRC.indexOf('elif [ "${rc}" = "3" ]');
  const line = SRC.slice(i, SRC.indexOf("\n", i));
  assert.ok(!/FAILED=1/.test(line));
});
check("concurrency group still serializes overlapping runs (widening the schedule must not let two runs race)", () => {
  assert.match(SRC, /concurrency:\s*\n\s*group: nflverse-stats-refresh/);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
