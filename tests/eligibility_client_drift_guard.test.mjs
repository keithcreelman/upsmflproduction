// §B3/§C4/§C5 client eligibility — drift guards across all three eligibility
// surfaces (front_office.js, roster_workbench.js, front_office_actions.js).
//   node tests/eligibility_client_drift_guard.test.mjs
//
// These files are giant page-bound IIFEs (DOM/fetch dependent) that can't be
// safely `require`d and executed whole in Node the way
// tests/contract_windows_shared.test.mjs runs the small shared module — so,
// matching the existing convention in tests/ir_status_predicate.test.mjs and
// tests/ladder_single_implementation.test.mjs, this asserts on the ACTUAL
// SOURCE TEXT: the exact bug pattern must be gone, and the fixed call site
// must be present. Run this against the pre-fix tree (git stash / git show
// HEAD~N) to see every one of these fail — that's the defect-sensitivity
// proof; see the PR description for the exact revert-and-rerun transcript.
import fs from "fs";
import assert from "assert";

const read = (p) => fs.readFileSync(p, "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

// ───────────────────────── Defect A: IR overcounting ─────────────────────────
console.log("Defect A — front_office.js IR alert (renderContractSummary)");
const FO = read("site/rosters/v2/front_office.js");
check("the broad text predicate (indexOf(\"out\")/===\"ir\"/indexOf(\"reserve\")) is GONE from the LIVE gate", () => {
  assert.match(FO, /irEligible\.push\(p\).*/, "irEligible.push(p) call site must still exist");
  const i = FO.indexOf("irEligible.push(p)");
  const before = FO.slice(Math.max(0, i - 300), i);
  // Scoped to the actual `if (...)` guarding this call, not the whole file —
  // the file's own explanatory comment ABOVE this (documenting the historical
  // bug for future readers) legitimately quotes this exact pattern, and a
  // whole-file scan would false-positive on that prose.
  assert.ok(!/indexOf\("out"\)\s*>=\s*0[\s\S]{0,80}indexOf\("reserve"\)/.test(before),
    "the overcounting predicate from front_office.js:3761 must not remain in the live if-guard");
  assert.match(before, /foIrDesignationEligible\(/,
    "the alert must gate on foIrDesignationEligible — the same predicate the worker and the Place-on-IR button already use");
});
check("foIrDesignationEligible (the correct predicate) still exists, unmodified in shape", () => {
  assert.match(FO, /function foIrDesignationEligible\(desig\)\s*\{/);
  const i = FO.indexOf("function foIrDesignationEligible(desig)");
  const body = FO.slice(i, FO.indexOf("\n  }", i));
  for (const needle of ['indexOf("IR") === 0', 'indexOf("SUSPEND") === 0', 'indexOf("HOLDOUT") === 0', 'indexOf("COVID") >= 0']) {
    assert.ok(body.includes(needle), `foIrDesignationEligible must still test ${needle}`);
  }
});

// ───────────────────── Defects C/D: restructure + extension windows ─────────────────────
console.log("\nDefect C — restructure window is now checked, not just contract shape");
const RWB = read("site/rosters/roster_workbench.js");
const MOB = read("site/m/front_office_actions.js");
for (const [label, src, fnName] of [
  ["desktop front_office.js", FO, "rosterContractEligibility"],
  ["Roster Workbench", RWB, "rosterContractEligibility"],
  ["mobile front_office_actions.js", MOB, "rosterContractEligibility"],
]) {
  check(`${label}: restructureEligible consults UPS_CONTRACT_WINDOWS (not shape alone)`, () => {
    const i = src.indexOf("function " + fnName + "(");
    assert.ok(i > 0, fnName + " not found in " + label);
    const fieldIdx = src.indexOf("restructureEligible:", i);
    assert.ok(fieldIdx > i, "restructureEligible field not found in " + fnName);
    // Look at a generous window AROUND the field (some surfaces wrap it across
    // lines, or compute the window check in a helper called just above it)
    // rather than parsing the exact line.
    const around = src.slice(fieldIdx - 400, fieldIdx + 200);
    assert.match(around, /UPS_CONTRACT_WINDOWS|restructureWindowOpen/i,
      `${label}'s restructureEligible must reference the shared window check`);
  });
}

console.log("\nDefect D — extension window is now checked for the off-ladder (plain held veteran) case");
check("desktop front_office.js: extensionDeadlineForPlayer delegates its off-ladder branch to the shared module", () => {
  const i = FO.indexOf("function extensionDeadlineForPlayer(p)");
  assert.ok(i > 0);
  const body = FO.slice(i, FO.indexOf("\n  }", FO.indexOf("standardExtensionWindow", i)));
  assert.match(body, /UPS_CONTRACT_WINDOWS/);
  assert.match(body, /standardExtensionWindow\(/);
});
check("Roster Workbench: extensionEligible is no longer pure contract shape — gates on the shared window (off-ladder) or the server-resolved ladder stage (pre-season WW/FCFS pickups)", () => {
  const i = RWB.indexOf("function rosterContractEligibility(player)");
  assert.ok(i > 0);
  const end = RWB.indexOf("\n  }", RWB.indexOf("restructureEligible:", i));
  const body = RWB.slice(i, end);
  assert.match(body, /UPS_CONTRACT_WINDOWS/,
    "Roster Workbench's extensionEligible used to be `years===1 || expiredRookie` with NO deadline check at all");
  assert.match(body, /standardExtensionWindow\(/);
  // 2026-09-28 review fix: a pre-season pickup must route through the ladder
  // stage, not the off-ladder days-15-28 clock — see
  // tests/roster_workbench_ladder_extension.test.mjs for the behavioral proof.
  assert.match(body, /isPreseasonWwPickupRW\(/);
  assert.match(body, /contractLadderStageRW\(\)/);
});
check('mobile: the off-ladder ("plain held veteran") branch now checks the shared window instead of skipping straight to true', () => {
  const i = MOB.indexOf("function rosterContractEligibility(player)");
  assert.ok(i > 0);
  const end = MOB.indexOf("\n  }", MOB.indexOf("restructureEligible:", i));
  const body = MOB.slice(i, end);
  // The historical bug: `if (ladder) extensionEligible = ... ladder.stage === "extension";`
  // with NOTHING for the else (non-ladder) case — extensionEligible stayed
  // whatever the shape-only value above computed. There must now be an
  // else branch that consults the shared module.
  assert.match(body, /if \(ladder\)/, "the ladder branch must still be present (server-resolved rung, untouched)");
  assert.match(body, /else if \(extensionEligible\)/, "an off-ladder branch must exist alongside the ladder branch");
  assert.match(body, /UPS_CONTRACT_WINDOWS/);
  assert.match(body, /standardExtensionWindow\(/);
});
check("mobile gained its own May rookie-extension deadline calculator (was previously entirely absent)", () => {
  assert.match(MOB, /function tagDeadlineDateFOMobile\(year\)/,
    "without this, standardExtensionWindow's rookie branch would fail closed for every expired-rookie contract on mobile");
});

// ───────────────────── Cross-surface: no independent shape-only bypass ─────────────────────
console.log("\nEvery UI consumer reads the fixed eligibility field — none re-derive shape independently");
check("mobile's eligibilityForRosterRow / extensionAvailableFor both route through rosterContractEligibility", () => {
  assert.match(MOB, /function eligibilityForRosterRow\(rosterRow, fid\)\s*\{[\s\S]{0,300}?rosterContractEligibility\(/);
});
check("Roster Workbench: restructure/extension buttons, filters and counts all read from one eligibility object (not re-derived per call site)", () => {
  const consumers = [...RWB.matchAll(/\.(restructureEligible|extensionEligible)\b/g)];
  assert.ok(consumers.length >= 3, "expected multiple UI call sites reading .restructureEligible/.extensionEligible");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
