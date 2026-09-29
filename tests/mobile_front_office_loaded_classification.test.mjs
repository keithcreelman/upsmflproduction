// Mobile Front Office (site/m/front_office_myac_submit.js + site/m/player_sheet.js's gates)
// loaded-contract classification -- defect-sensitive tests, 2026-09-29 review round 6 (Keith):
//
// "It is in scope: I asked for the loaded-contract rule to work consistently in Front Office
// and the Trade War Room on both desktop and mobile. Please update
// site/m/front_office_myac_submit.js and its player_sheet.js gate to use the same
// classification and fail closed when classification is unavailable. Add defect-sensitive
// tests for plain Ext1/Ext2, a genuinely loaded rookie or restructured contract, and
// classifier unavailability."
//
// front_office_myac_submit.js exports via window.UPS_M_FO_MYAC (no hook-injection needed,
// unlike roster_workbench.js/front_office.js's un-exported IIFEs) -- loaded here exactly as
// a browser would load it, via a minimal vm sandbox.
//
// player_sheet.js's three gate call sites (handleExtensionLoadedPick, handleMyacLoadedPick,
// the loaded-MYAC submit recheck) are covered indirectly: they all call
// MY.loadedContractCount(roster), whose { count, unavailable } contract is tested directly
// here -- the exact shape those gates now branch on to fail closed.
//
// Run: node tests/mobile_front_office_loaded_classification.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadMobileMyac } from "./fixtures/mobile_myac_harness.mjs";
import * as WORKER from "../worker/src/contract_classification.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const clsCtx = { window: {} };
vm.createContext(clsCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/loaded_contract_classification.js"), "utf8"), clsCtx);
const SHARED_CLASSIFIER = clsCtx.window.UPS_LOADED_CONTRACT_CLASSIFICATION;

const withClassifier = () => loadMobileMyac({ UPS_LOADED_CONTRACT_CLASSIFICATION: SHARED_CLASSIFIER });
const withoutClassifier = () => loadMobileMyac({});

// ═══════════════════════ Plain Ext1/Ext2 (the round-1/2 ruling) ═══════════════════════

test("PLAIN EXT1 (real data, Montgomery): a mobile rosterRow with a plain, unsuffixed Vet-Ext1 classifies flat, not loaded", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 42K| AAV 20K, 30K| Y1-12K, Y2-30K| Ext: Hammer| GTD: 31.5K", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), false);
});

test("PLAIN EXT2 (real data, Gibbs): a mobile rosterRow with a plain, unsuffixed, genuinely-flat Vet-Ext2 classifies flat", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Vet-Ext2", contractInfo: "CL 3| TCV 73K| AAV 31K| Y1-11K, Y2-31K, Y3-31K| GTD: 54.8K| Ext: Sex", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), false);
});

test("REGRESSION CONTROL: a plain Ext2 whose two extension years are genuinely UNEVEN still classifies loaded -- proves this isn't a suffix shortcut on mobile either", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Vet-Ext2", contractInfo: "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-10K, Y3-40K| GTD: 45K", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), true);
});

// ═══════════════════════ A genuinely loaded rookie / restructured contract ═══════════════════════

test("GENUINELY LOADED ROOKIE: a restructured Rookie-Ext1 (Rookie-Ext1-BL) classifies loaded on mobile -- canon confirms this shape can only come from a later restructure", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Rookie-Ext1-BL", contractInfo: "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|GTD: 89.3K|Restructured 2026", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), true);
});

test("GENUINELY LOADED ROOKIE: a plain, unsuffixed but genuinely uneven Rookie-Ext2 classifies loaded", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Rookie-Ext2", contractInfo: "CL 3|TCV 60K|AAV 20K|Y1-10K, Y2-10K, Y3-40K|GTD: 45K", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), true);
});

test("REGRESSION CONTROL: an ordinary, flat Rookie-Draft contract classifies flat", () => {
  const MY = withClassifier();
  const row = { contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), false);
});

// ═══════════════════════ Classifier unavailability -- fail closed ═══════════════════════

test("CLASSIFIER UNAVAILABLE: with no shared classifier loaded at all, isLoadedRow returns null (honest unavailable) even for a contract a naive suffix check would get right", () => {
  const MY = withoutClassifier();
  const row = { contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K", status: "ROSTER" };
  t.equal(MY.isLoadedRow(row), null);
});

test("CLASSIFIER UNAVAILABLE: with no shared classifier loaded, loadedContractCount reports unavailable:true and does not silently guess the count", () => {
  const MY = withoutClassifier();
  const roster = [
    { contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K", status: "ROSTER" },
    { contractStatus: "Vet-FAA", contractInfo: "", status: "ROSTER" },
    { contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| GTD: 24K", status: "TAXI" }, // taxi -- excluded either way
  ];
  const result = MY.loadedContractCount(roster);
  t.equal(result.unavailable, true, "any unresolvable non-taxi player must mark the whole roster's count unavailable");
});

test("HARD GATE FAILS CLOSED (fully resolvable roster): loadedContractCount returns the correct count and unavailable:false", () => {
  const MY = withClassifier();
  const roster = [
    { contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K", status: "ROSTER" }, // loaded
    { contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| GTD: 24K", status: "ROSTER" }, // flat (this fix)
    { contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K", status: "TAXI" }, // taxi, excluded
  ];
  const result = MY.loadedContractCount(roster);
  // JSON round-trip: the sandbox realm's object literal has a different Object.prototype
  // than this realm's, which fails assert's STRICT deepEqual on identity alone.
  t.deepEqual(JSON.parse(JSON.stringify(result)), { count: 1, unavailable: false });
});

test("HARD GATE FAILS CLOSED: one unresolvable non-taxi contract on an otherwise-clean roster marks the whole count unavailable", () => {
  const MY = withClassifier();
  const roster = [
    { contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K", status: "ROSTER" },
    { contractStatus: "Vet-Something-Unrecognized-Weird", contractInfo: "totally not a schedule", status: "ROSTER" },
  ];
  const result = MY.loadedContractCount(roster);
  t.equal(result.unavailable, true);
});

// ═══════════════════════ Parity: mobile agrees with the worker on the same real shapes ═══════════════════════

const REAL_SHAPES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/real_contract_shapes_2026_09_29.json"), "utf8"));

test(`PARITY (real data): mobile's isLoadedRow agrees with the worker's resolveLoadedStatus on all ${REAL_SHAPES.length} distinct real 2026 contract shapes`, () => {
  const MY = withClassifier();
  let checked = 0;
  for (const shape of REAL_SHAPES) {
    const w = WORKER.resolveLoadedStatus(shape.contractStatus, shape.contractInfo);
    const expected = w.resolved ? (w.loaded !== "") : null;
    const mobile = MY.isLoadedRow({ contractStatus: shape.contractStatus, contractInfo: shape.contractInfo, status: "ROSTER" });
    t.equal(mobile, expected, `status="${shape.contractStatus}" info="${shape.contractInfo}": worker=${JSON.stringify(w)} mobile=${mobile}`);
    checked += 1;
  }
  t.ok(checked === REAL_SHAPES.length, `checked all ${REAL_SHAPES.length} real shapes`);
});

await run("mobile_front_office_loaded_classification");
