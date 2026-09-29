// Roster Workbench (site/rosters/roster_workbench.js) loaded-contract classification --
// defect-sensitive tests for the two edge paths Keith flagged, 2026-09-29 review round 2:
//
// "Also fix two Roster Workbench edge paths before calling parity complete: contractBucket()
// checks 'rookie' before the new loaded classifier, which can hide a genuinely loaded
// Rookie-Ext2 or restructured Rookie-Ext1; and if the shared classifier fails to load, the
// fallback silently returns to suffix-only counting. A missing classifier should display an
// honest unavailable state, not a potentially different count. Add defect-sensitive tests
// for both."
//
// These tests load the REAL, unmodified roster_workbench.js via
// tests/fixtures/roster_workbench_harness.mjs (a vm sandbox with a minimal window/document
// stub -- no real DOM, no network) and call its actual, shipped functions -- not a
// reimplementation. Cross-surface parity (this file's isLoadedContractStatus vs the worker
// vs Front Office) is covered separately by
// tests/loaded_contract_classification_parity.test.mjs; this file is specifically the two
// edge-path regressions.
//
// Run: node tests/roster_workbench_loaded_classification.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadRosterWorkbench } from "./fixtures/roster_workbench_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const clsCtx = { window: {} };
vm.createContext(clsCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/loaded_contract_classification.js"), "utf8"), clsCtx);
const SHARED_CLASSIFIER = clsCtx.window.UPS_LOADED_CONTRACT_CLASSIFICATION;

const withClassifier = () => loadRosterWorkbench({ UPS_LOADED_CONTRACT_CLASSIFICATION: SHARED_CLASSIFIER });
const withoutClassifier = () => loadRosterWorkbench({});

// ═══════════════════════ Bug 1: rookie checked before loaded ═══════════════════════

test("BUG FIX (rookie-before-loaded): a restructured Rookie-Ext1 (Rookie-Ext1-BL) buckets as 'loaded', not 'rookie' -- and therefore correctly counts toward the 5-loaded limit", () => {
  const { hooks } = withClassifier();
  const bucket = hooks.contractBucket("Rookie-Ext1-BL", "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|GTD: 89.3K|Restructured 2026");
  t.equal(bucket, "loaded");
  t.equal(hooks.isLoadedContractPlayer({ type: "Rookie-Ext1-BL", special: "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|GTD: 89.3K|Restructured 2026" }), true);
});

test("BUG FIX (rookie-before-loaded): a genuinely uneven, UNSUFFIXED Rookie-Ext2 buckets as 'loaded', not 'rookie'", () => {
  const { hooks } = withClassifier();
  const bucket = hooks.contractBucket("Rookie-Ext2", "CL 3|TCV 60K|AAV 20K|Y1-10K, Y2-10K, Y3-40K|GTD: 45K");
  t.equal(bucket, "loaded");
});

test("REGRESSION CONTROL (rookie-before-loaded): a genuinely flat plain Rookie-Ext2 still buckets 'rookie' (falls through to the rookie check once loaded is definitively false)", () => {
  const { hooks } = withClassifier();
  const bucket = hooks.contractBucket("Rookie-Ext2", "CL 3|TCV 51K|AAV 17K|Y1-11K, Y2-20K, Y3-20K|GTD: 38.3K");
  t.equal(bucket, "rookie");
});

test("REGRESSION CONTROL (rookie-before-loaded): an ordinary Rookie-Draft contract still buckets 'rookie' and typeTone still reads is-rookie", () => {
  const { hooks } = withClassifier();
  t.equal(hooks.contractBucket("Rookie-Draft", "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K"), "rookie");
  t.equal(hooks.typeTone("Rookie-Draft", "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K"), "is-rookie");
});

test("REGRESSION CONTROL: TAG is still checked first and unaffected (a tag can never be loaded -- canon's 1-year rule -- so this ordering was always safe)", () => {
  const { hooks } = withClassifier();
  t.equal(hooks.contractBucket("Tag", "CL 1|TCV 30K|AAV 30K|Y1-30K"), "tag");
});

// ═══════════════════════ Bug 2: silent suffix-only fallback ═══════════════════════

test("BUG FIX (no silent fallback): with NO shared classifier loaded, isLoadedContractStatus returns null for a real loaded contract -- never a guessed true/false", () => {
  const { hooks } = withoutClassifier();
  const r = hooks.isLoadedContractStatus("Vet-Ext2-BL", "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K");
  t.equal(r, null);
});

test("BUG FIX (no silent fallback): with NO shared classifier loaded, contractBucket returns 'unavailable' (a distinct bucket), never silently 'other' or a guessed 'loaded'/'rookie'", () => {
  const { hooks } = withoutClassifier();
  t.equal(hooks.contractBucket("Vet-Ext2-BL", "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K"), "unavailable");
  t.equal(hooks.contractBucket("Rookie-Ext1", "CL 2| TCV 24K| AAV 17K| Y1-7K, Y2-17K| GTD: 18K"), "unavailable");
});

test("BUG FIX (no silent fallback): with NO shared classifier loaded, typeTone reads is-unavailable, never falling back to is-veteran/is-rookie as if it knew the answer", () => {
  const { hooks } = withoutClassifier();
  t.equal(hooks.typeTone("Vet-Ext2-BL", "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K"), "is-unavailable");
});

test("BUG FIX (no silent fallback): TAG still resolves correctly even with no classifier loaded (structurally safe, no schedule dependency)", () => {
  const { hooks } = withoutClassifier();
  t.equal(hooks.contractBucket("Tag", "CL 1|TCV 30K|AAV 30K|Y1-30K"), "tag");
});

test("BUG FIX (no silent fallback): loadedContractTally reports an honest 'unavailable' count and does not silently fold those players into 'loaded' -- INCLUDING a tag contract, since isLoadedContractPlayer/loadedContractTally intentionally call the classifier directly (never contractBucket's separate, hardcoded 'tag is structurally safe' shortcut), so the count is never quietly right for the wrong reason", () => {
  const { hooks } = withoutClassifier();
  const players = [
    { type: "Vet-Ext2-BL", special: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K" },
    { type: "Rookie-Draft", special: "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K" },
    { type: "Tag", special: "CL 1|TCV 30K|AAV 30K|Y1-30K" },
  ];
  const tally = JSON.parse(JSON.stringify(hooks.loadedContractTally(players)));
  t.deepEqual(tally, { loaded: 0, unavailable: 3 });
});

test("REGRESSION CONTROL: WITH the classifier loaded, loadedContractTally correctly tallies a mixed real roster (loaded + flat + unavailable-due-to-malformed-data)", () => {
  const { hooks } = withClassifier();
  const players = [
    { type: "Vet-Ext2-BL", special: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K" }, // loaded
    { type: "Vet-Ext1", special: "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| GTD: 24K" }, // flat (this fix)
    { type: "Vet-FAA", special: "CL 3|TCV 6K|Y1-2K, Y3-4K" }, // malformed (Y2 missing) -> unresolved
  ];
  const tally = JSON.parse(JSON.stringify(hooks.loadedContractTally(players)));
  t.deepEqual(tally, { loaded: 1, unavailable: 1 });
});

await run("roster_workbench_loaded_classification");
