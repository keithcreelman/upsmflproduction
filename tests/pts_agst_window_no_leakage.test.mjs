// The Pts Agst window backtest must never let the target game reach a predictor or a "usual".
// Runs pipelines/analysis/pts_agst_window/leak_test_synthetic.py (synthetic league, no data or
// network needed): every target's predictors are rebuilt after the target week and all later
// weeks are replaced with huge scores — nothing may move — and a deliberately leaky "usual"
// (one that can see week T) must be caught, or the check itself is broken.
//   node tests/pts_agst_window_no_leakage.test.mjs
import { spawnSync } from "node:child_process";
import assert from "node:assert";
const r = spawnSync("python3", ["pipelines/analysis/pts_agst_window/leak_test_synthetic.py"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };
check("python3 ran the synthetic leakage test", () => assert.strictEqual(r.error, undefined, String(r.error)));
check("no target-game information reaches any predictor, league average or usual", () => {
  assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.match(r.stdout, /leaks found: 0;/);
});
check("a deliberately leaky usual (sees the target week) is caught, so the check really bites", () => {
  assert.match(r.stdout, /deliberate leak caught on [1-9]\d* targets/);
  assert.match(r.stdout, /\nPASS\n?$/);
});
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
