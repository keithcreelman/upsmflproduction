// §B3 IR eligibility — the WORKER's own inline predicate, run as-is.
//   node tests/ir_worker_predicate_parity.test.mjs
//
// Per Keith (2026-09-28): the worker's deactivate_ir gate (worker/src/index.js,
// inside the big route handler) is already correct and is NOT to be extracted
// into a new production module solely to make it testable. So this test
// extracts the LITERAL expression text out of the live file with a regex,
// `new Function`s it, and runs the REAL shipped text against the full
// designation vocabulary — not a hand-retyped mirror of it, which could pass
// while the real code silently diverged. It then diffs that same literal text
// (whitespace-normalized) against site/shared/contract_windows.js's
// irDesignationEligible body, which desktop/mobile/Roster Workbench all read
// through — so a future edit to either side that breaks the other fails loud
// here instead of shipping a client that offers what the worker will refuse.
import fs from "fs";
import assert from "assert";

const WORKER_SRC = fs.readFileSync("worker/src/index.js", "utf8");
const SHARED_SRC = fs.readFileSync("site/shared/contract_windows.js", "utf8");

let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

// Pull the exact `const eligible = ...;` expression out of the deactivate_ir
// handler. Anchored on the surrounding, load-bearing lines (the IR_ELIGIBILITY_UNKNOWN
// fail-closed response and the deactivate_ir action gate) so this fails loudly —
// not silently — if the handler is ever restructured out from under it.
console.log("extracting the worker's literal predicate");
let workerExprText;
check("deactivate_ir handler with the §B3 predicate is present", () => {
  assert.match(WORKER_SRC, /if \(action === "deactivate_ir"\)/);
  assert.match(WORKER_SRC, /code: "IR_ELIGIBILITY_UNKNOWN"/);
  const m = WORKER_SRC.match(/const eligible = (desig\.indexOf\("IR"\) === 0[\s\S]*?desig\.indexOf\("COVID"\) >= 0);/);
  assert.ok(m, "could not find the literal `const eligible = ...` expression — the predicate may have moved or changed shape");
  workerExprText = m[1];
});

console.log("\nrunning the ACTUAL worker text (not a mirror) against the full vocabulary");
const workerPredicate = new Function("desig", "return (" + workerExprText + ");");
const CASES = [
  ["IR", true], ["IR-PUP", true], ["IR-NFI", true], ["IR-R", true],
  ["Suspended", true], ["Holdout", true], ["COVID-19", true], ["Reserve/COVID-19", true],
  ["Out", false], ["Doubtful", false], ["Questionable", false], ["Retired", false],
  ["", false], ["Reserve", false], ["Physically Unable to Perform Reserve", false],
];
for (const [desig, expected] of CASES) {
  check(`worker literal: "${desig}" -> eligible=${expected}`, () => {
    // The live handler upper-cases before calling this (safeStr(...).toUpperCase()) —
    // reproduce that one step so the fixture matches the real call site exactly.
    assert.strictEqual(workerPredicate(String(desig).toUpperCase()), expected);
  });
}

console.log("\nclient/worker parity: site/shared/contract_windows.js must not silently diverge");
check("irDesignationEligible's body matches the worker's literal predicate (whitespace-normalized)", () => {
  const i = SHARED_SRC.indexOf("function irDesignationEligible(desig)");
  assert.ok(i > 0, "irDesignationEligible not found in site/shared/contract_windows.js");
  const body = SHARED_SRC.slice(SHARED_SRC.indexOf("return", i), SHARED_SRC.indexOf(";", SHARED_SRC.indexOf("COVID", i)) + 1);
  // Normalize whitespace/comments AND the one local variable name each side
  // happens to use (worker: `desig`, already upper-cased by its caller;
  // client: `s`, upper-cased inline) — same value, different identifier.
  const norm = (str) => str.replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").replace(/^return\s*/, "").trim()
    .replace(/;$/, "").replace(/^\(|\)$/g, "").replace(/\bdesig\b/g, "VAR").replace(/\bs\b/g, "VAR");
  const workerNorm = norm(workerExprText);
  const clientNorm = norm(body);
  assert.strictEqual(clientNorm, workerNorm,
    `client and worker predicates have diverged:\n  worker: ${workerNorm}\n  client: ${clientNorm}`);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
