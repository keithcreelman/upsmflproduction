// Front Office v2 (site/rosters/v2/front_office.js) loaded-contract classification --
// defect-sensitive tests, 2026-09-29 review round 2 (Keith):
//
// "I checked the PR diff and found that it updates site/rosters/roster_workbench.js, while
// the actual desktop Front Office (site/rosters/v2/front_office.js) still computes loaded
// status independently from the suffix. My requirement was parity with Front Office as well
// as Roster Workbench and Trade War Room... Also fix two Roster Workbench edge paths...
// contractBucket() checks 'rookie' before the new loaded classifier, which can hide a
// genuinely loaded Rookie-Ext2 or restructured Rookie-Ext1; and if the shared classifier
// fails to load, the fallback silently returns to suffix-only counting. A missing classifier
// should display an honest unavailable state, not a potentially different count. Add
// defect-sensitive tests for both."
//
// These tests load the REAL, unmodified front_office.js via
// tests/fixtures/front_office_v2_harness.mjs (a vm sandbox with a minimal window/document
// stub -- no real DOM, no network) and call its actual, shipped functions -- not a
// reimplementation.
//
// Run: node tests/front_office_v2_loaded_classification.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadFrontOfficeV2 } from "./fixtures/front_office_v2_harness.mjs";
import * as WORKER from "../worker/src/contract_classification.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The real shared classifier, loaded exactly as the browser would.
const clsCtx = { window: {} };
vm.createContext(clsCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/loaded_contract_classification.js"), "utf8"), clsCtx);
const SHARED_CLASSIFIER = clsCtx.window.UPS_LOADED_CONTRACT_CLASSIFICATION;

const withClassifier = () => loadFrontOfficeV2({ UPS_LOADED_CONTRACT_CLASSIFICATION: SHARED_CLASSIFIER });
const withoutClassifier = () => loadFrontOfficeV2({}); // no UPS_LOADED_CONTRACT_CLASSIFICATION at all

// ═══════════════════════ Bug 1: rookie checked before loaded (Keith, round 2) ═══════════════════════

test("BUG FIX (rookie-before-loaded): a restructured Rookie-Ext1 (Rookie-Ext1-BL) -- genuinely loaded, per canon's own restructure rule -- classifies loaded, not swallowed into the rookie bucket", () => {
  const { hooks } = withClassifier();
  const r = hooks.isLoadedRow({ type: "Rookie-Ext1-BL", special: "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|GTD: 89.3K|Restructured 2026" });
  t.equal(r, true, "a restructured Rookie-Ext1 must classify loaded, not rookie-and-therefore-not-loaded");
});

test("BUG FIX (rookie-before-loaded): a genuinely uneven, UNSUFFIXED Rookie-Ext2 -- real structural evidence of loading, missing its suffix -- still classifies loaded, proving this isn't a suffix shortcut for rookie contracts either", () => {
  const { hooks } = withClassifier();
  const r = hooks.isLoadedRow({ type: "Rookie-Ext2", special: "CL 3|TCV 60K|AAV 20K|Y1-10K, Y2-10K, Y3-40K|GTD: 45K" });
  t.equal(r, true);
});

test("REGRESSION CONTROL (rookie-before-loaded): a genuinely flat plain Rookie-Ext2 still classifies flat (not loaded) -- the fix doesn't over-correct into calling every rookie extension loaded", () => {
  const { hooks } = withClassifier();
  const r = hooks.isLoadedRow({ type: "Rookie-Ext2", special: "CL 3|TCV 51K|AAV 17K|Y1-11K, Y2-20K, Y3-20K|GTD: 38.3K" });
  t.equal(r, false);
});

test("REGRESSION CONTROL (rookie-before-loaded): a plain Rookie-Draft (non-extension, non-loaded) still classifies flat -- ordinary rookie contracts are unaffected", () => {
  const { hooks } = withClassifier();
  const r = hooks.isLoadedRow({ type: "Rookie-Draft", special: "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K" });
  t.equal(r, false);
});

// ═══════════════════════ Bug 2: silent suffix-only fallback (Keith, round 2) ═══════════════════════

test("BUG FIX (no silent fallback): with NO shared classifier loaded at all, isLoadedRow returns null (honest unavailable) for a real loaded contract -- NEVER silently falls back to a suffix-only guess", () => {
  const { hooks } = withoutClassifier();
  // A contract that a naive suffix check WOULD get right (has -BL) -- proving the fix isn't
  // "only fails open when the naive check would also be wrong", it refuses to guess at all.
  const r = hooks.isLoadedRow({ type: "Vet-Ext2-BL", special: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K" });
  t.equal(r, null, "no classifier present must be an explicit null, never true/false from a fallback guess");
});

test("BUG FIX (no silent fallback): with NO shared classifier loaded, isLoadedRow returns null even for an unsuffixed plain Ext1 (where the OLD suffix-only rule would have quietly and confidently said false)", () => {
  const { hooks } = withoutClassifier();
  const r = hooks.isLoadedRow({ type: "Vet-Ext1", special: "CL 2| TCV 42K| AAV 20K, 30K| Y1-12K, Y2-30K| GTD: 31.5K" });
  t.equal(r, null);
});

test("BUG FIX (no silent fallback): with no shared classifier, the per-player tri-state loadedContractCountForTeam's tally is built from is null (unavailable), never a guessed true/false -- the STATE-driven team-total path is covered by the fail-closed gate tests below", () => {
  const { hooks } = withoutClassifier();
  const r1 = hooks.isLoadedRow({ type: "Vet-Ext2-BL", special: "CL 2|TCV 44K|AAV 22K|Y1-9K, Y2-35K|GTD: 33K" });
  t.equal(r1, null);
});

// ═══════════════════════ Fail-closed hard gate (Keith: "trace every hard gate") ═══════════════════════

test("HARD GATE FAILS CLOSED: loadedContractCountForTeam reports unavailable, not a possibly-understated count, for a team where one contract can't be classified", () => {
  const { hooks } = withClassifier();
  hooks.STATE.teams = [
    {
      fid: "0005",
      players: [
        { id: "1", type: "Vet-Ext2-BL", special: "CL 2|TCV 44K|AAV 22K|Y1-9K, Y2-35K|GTD: 33K" }, // loaded=true
        { id: "2", type: "Vet-FAA", special: "" }, // flat=false
        { id: "3", type: "Vet-Something-Unrecognized-Weird", special: "totally not a schedule" }, // unresolved
      ],
    },
  ];
  const result = hooks.loadedContractCountForTeam("0005");
  t.equal(result.unavailable, true, "one unresolvable player must mark the whole team's count unavailable");
});

test("HARD GATE FAILS CLOSED: a fully-resolvable team (0 unavailable) reports the correct count and unavailable:false", () => {
  const { hooks } = withClassifier();
  hooks.STATE.teams = [
    {
      fid: "0001",
      players: [
        { id: "1", type: "Vet-Ext2-BL", special: "CL 2|TCV 44K|AAV 22K|Y1-9K, Y2-35K|GTD: 33K" }, // loaded
        { id: "2", type: "Vet-Ext1", special: "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| GTD: 24K" }, // flat (this fix)
        { id: "3", type: "Rookie-Draft", special: "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K" }, // flat
      ],
    },
  ];
  const result = hooks.loadedContractCountForTeam("0001");
  // JSON round-trip: the sandbox realm's object literal has a different Object.prototype
  // than this realm's, which fails assert's STRICT deepEqual on identity alone even when
  // every value matches (same pattern as the worker/FO parity test's `plain()` helper).
  t.deepEqual(JSON.parse(JSON.stringify(result)), { count: 1, unavailable: false });
});

// ═══════════════════════ Parity: front_office.js agrees with the worker/shared classifier ═══════════════════════

const REAL_SHAPES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/real_contract_shapes_2026_09_29.json"), "utf8"));

test(`PARITY (real data): front_office.js's isLoadedRow agrees with the worker's resolveLoadedStatus on all ${REAL_SHAPES.length} distinct real 2026 contract shapes`, () => {
  const { hooks } = withClassifier();
  let checked = 0;
  for (const shape of REAL_SHAPES) {
    const w = WORKER.resolveLoadedStatus(shape.contractStatus, shape.contractInfo);
    const expected = w.resolved ? (w.loaded !== "") : null;
    const fo = hooks.isLoadedRow({ type: shape.contractStatus, special: shape.contractInfo });
    t.equal(fo, expected, `status="${shape.contractStatus}" info="${shape.contractInfo}": worker=${JSON.stringify(w)} FO=${fo}`);
    checked += 1;
  }
  t.ok(checked === REAL_SHAPES.length, `checked all ${REAL_SHAPES.length} shapes`);
});

// ═══════════════════════ Regression: the June 2026 "LH" bug (PR #398) does not reappear ═══════════════════════

test("REGRESSION (PR #398, 2026-06-02): a 'default-escalated' plain-extension shape -- the ORIGINAL bug this file's isLoadedRow was written to fix -- still classifies flat under the new schedule-verifying rule, not just under the old suffix-only one", () => {
  const { hooks } = withClassifier();
  // Shape of the historical bug: a frozen prior year below a freshly-escalated extension
  // year, no suffix -- exactly what the 2026-09-29 fix's frozen-year exclusion targets.
  const r = hooks.isLoadedRow({ type: "Vet-Ext1", special: "CL 2| TCV 52K| AAV 26K| Y1-17K, Y2-35K| GTD: 39K" });
  t.equal(r, false, "the real per-year verification must resolve this flat, matching PR #398's intended fix, via real structure instead of trusting the suffix");
});

await run("front_office_v2_loaded_classification");
