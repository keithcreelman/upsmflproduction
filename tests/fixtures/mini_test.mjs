// Tiny counting test harness (the repo's tests are plain `node tests/x.test.mjs`
// scripts with no framework). Counts every assertion so a run can report exact
// test + assertion totals, and exits non-zero on any failure.
import assert from "node:assert/strict";

let tests = 0, passed = 0, failed = 0, assertions = 0;
const failures = [];
const out = console.log.bind(console); // captured at import so a test that mutes console still gets its report
const queue = [];

const counted = (fn) => (...args) => { assertions += 1; return fn(...args); };
export const t = {
  ok: counted(assert.ok), equal: counted(assert.equal), notEqual: counted(assert.notEqual),
  deepEqual: counted(assert.deepEqual), match: counted(assert.match), doesNotMatch: counted(assert.doesNotMatch),
  throws: counted(assert.throws),
};

export function test(name, fn) { queue.push({ name, fn }); }

export async function run(label) {
  for (const { name, fn } of queue) {
    tests += 1;
    const before = assertions;
    try { await fn(); passed += 1; out(`  ok   ${name}  (${assertions - before} assertions)`); }
    catch (e) { failed += 1; failures.push({ name, e }); out(`  FAIL ${name}\n         ${e && e.message ? e.message.split("\n")[0] : e}`); }
  }
  out(`\n${label}: ${passed}/${tests} tests passed, ${assertions} assertions${failed ? `, ${failed} FAILED` : ""}`);
  if (failed) { for (const f of failures) out(`\n--- ${f.name}\n${f.e && f.e.stack}`); process.exit(1); }
}
