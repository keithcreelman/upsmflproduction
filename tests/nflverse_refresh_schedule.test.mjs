// nflverse stats refresh — widened schedule (2026-09-28).
//   node tests/nflverse_refresh_schedule.test.mjs
//
// THE DEFECT: a single Wednesday-11:00-UTC cron meant Monday-morning site
// visitors saw the prior week's numbers even in weeks nflverse had already
// published by Tuesday. Widened to Monday/Tuesday/Wednesday checks, relying
// on the EXISTING idempotent/exit-code-3 "not published yet" handling in the
// same job (unchanged by this pass) so an early run is always safe.
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
check("Monday check exists (early — most weeks too soon, and that's fine, see exit-code-3 handling)", () => {
  assert.match(SRC, /cron:\s*"0 15 \* \* 1"/);
});
check("two Tuesday checks exist (nflverse's typical publish window)", () => {
  assert.match(SRC, /cron:\s*"0 12 \* \* 2"/);
  assert.match(SRC, /cron:\s*"0 20 \* \* 2"/);
});
check("Wednesday backstop is preserved (was the ONLY run before this pass)", () => {
  assert.match(SRC, /cron:\s*"0 11 \* \* 3"/);
});
check("no more than 4 scheduled runs/week — checking often is fine, checking hourly would not be", () => {
  const crons = [...SRC.matchAll(/- cron:/g)];
  assert.ok(crons.length <= 4, `found ${crons.length} cron entries — widen deliberately, not by accident`);
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
