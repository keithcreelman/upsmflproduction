// PARITY: THREE surfaces -- the Trade War Room's classifier
// (worker/src/contract_classification.js), Front Office's shared copy
// (site/shared/loaded_contract_classification.js), AND Roster Workbench's own wrapper
// (site/rosters/roster_workbench.js's isLoadedContractStatus, loaded exactly as a browser
// would load it, via tests/fixtures/roster_workbench_harness.mjs) -- must agree on every
// contract shape, always. This is the test Keith asked for after finding the surfaces had no
// guarantee of ever staying in sync (2026-09-29, round 1): "Implement the approved canon
// interpretation consistently on both surfaces and the worker's enforcement path, with a
// parity test using real contract shapes. Do not make Trade War Room display one count while
// Front Office displays another." (Round 2, after Roster Workbench's own two edge-case bugs
// were found, added Front Office v2 -- site/rosters/v2/front_office.js -- as a REQUIRED
// fourth surface: see tests/front_office_v2_loaded_classification.test.mjs, which runs the
// identical real-shapes fixture against front_office.js's isLoadedRow directly, since that
// file's data shape (single-player calls) doesn't fit this test's resolveLoadedStatus-shaped
// assertions as cleanly as the other three.)
//
// Two fixture sets:
//   1. Every DISTINCT (contractStatus, contractInfo) pair seen on a live 2026 roster across
//      all 12 franchises (207 shapes, snapshotted 2026-09-29) -- real data, not invented.
//   2. A synthetic battery covering every contract family and edge case this module
//      documents handling specially (plain/suffixed Ext1/Ext2, restructured extensions,
//      MYM, tag, WW, rookie option, malformed schedules, blank fields) -- so a shape this
//      season's live rosters don't happen to contain is still covered.
//
// Run: node tests/loaded_contract_classification_parity.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { loadRosterWorkbench } from "./fixtures/roster_workbench_harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = await import(path.join(ROOT, "worker/src/contract_classification.js"));

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "site/shared/loaded_contract_classification.js"), "utf8"),
  ctx
);
const FO = ctx.window.UPS_LOADED_CONTRACT_CLASSIFICATION;

const { hooks: RWB } = loadRosterWorkbench({ UPS_LOADED_CONTRACT_CLASSIFICATION: FO });

// Objects returned from inside the vm sandbox belong to a DIFFERENT realm (their own
// Object.prototype) than objects built in this module -- assert's STRICT deepEqual (which
// `t.deepEqual` is, imported from node:assert/strict) fails on that alone even when every
// own-enumerable property matches. A JSON round-trip rebuilds a plain object in THIS
// realm, comparing values only, exactly the pattern already used elsewhere in this repo's
// tests for the same cross-realm comparison (see extension_pricing_surfaces.test.mjs's
// `num()` helper).
const plain = (o) => JSON.parse(JSON.stringify(o));

test("SETUP: the shared classifier actually loaded and exposed its window global", () => {
  t.ok(FO, "site/shared/loaded_contract_classification.js must set window.UPS_LOADED_CONTRACT_CLASSIFICATION");
  t.equal(typeof FO.resolveLoadedStatus, "function");
  t.equal(typeof FO.isLoaded, "function");
  t.equal(typeof RWB.isLoadedContractStatus, "function", "Roster Workbench's own wrapper must have loaded too");
});

const REAL_SHAPES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests/fixtures/real_contract_shapes_2026_09_29.json"), "utf8")
);

test(`PARITY (real data): all ${REAL_SHAPES.length} distinct contractStatus/contractInfo pairs seen on a live 2026 roster (2026-09-29 snapshot, all 12 franchises) classify identically on all three surfaces`, () => {
  let checked = 0;
  for (const shape of REAL_SHAPES) {
    const w = WORKER.resolveLoadedStatus(shape.contractStatus, shape.contractInfo);
    const f = FO.resolveLoadedStatus(shape.contractStatus, shape.contractInfo);
    t.deepEqual(
      plain(f),
      plain(w),
      `status="${shape.contractStatus}" info="${shape.contractInfo}": worker=${JSON.stringify(w)} FO=${JSON.stringify(f)}`
    );
    // Roster Workbench's isLoadedContractStatus is tri-state (true/false/null), not the
    // {loaded, resolved} shape -- compare against the equivalent collapse of the worker's
    // own result so a real disagreement (not just a different return shape) fails loudly.
    const rwbExpected = w.resolved ? w.loaded !== "" : null;
    const rwb = RWB.isLoadedContractStatus(shape.contractStatus, shape.contractInfo);
    t.equal(rwb, rwbExpected, `Roster Workbench parity: status="${shape.contractStatus}" info="${shape.contractInfo}": worker=${JSON.stringify(w)} RWB=${rwb}`);
    checked += 1;
  }
  t.ok(checked === REAL_SHAPES.length, `checked all ${REAL_SHAPES.length} real shapes`);
});

// Synthetic edge-case battery -- every documented special case, so parity holds even for a
// shape this season's live rosters don't happen to contain.
const SYNTHETIC_SHAPES = [
  // Plain (unsuffixed) Ext1 -- must be flat on both, per the 2026-09-29 ruling.
  ["Vet-Ext1", "CL 2| TCV 42K| AAV 20K, 30K| Y1-12K, Y2-30K| Ext: Hammer| GTD: 31.5K"],
  ["Rookie-Ext1", "CL 2|TCV 12K|AAV 1K, 11K|Y1-1K, Y2-11K|GTD: 9K"],
  // Plain Ext2 with genuinely flat extension years -- must be flat on both.
  ["Vet-Ext2", "CL 3| TCV 73K| AAV 31K| Y1-11K, Y2-31K, Y3-31K| GTD: 54.8K| Ext: Sex"],
  // Plain Ext2 with genuinely UNEVEN extension years -- must STILL classify loaded on both
  // (proves this is a real structural test, not a suffix shortcut that would hide it).
  ["Vet-Ext2", "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-10K, Y3-40K| GTD: 45K"],
  ["Vet-Ext2", "CL 3| TCV 60K| AAV 20K| Y1-10K, Y2-40K, Y3-10K| GTD: 45K"],
  // Suffixed Ext1 from a later restructure (the Hurts reference fixture) -- must STILL
  // classify loaded (BL) on both; the suffix carve-out never applies here.
  ["Vet-Ext1-BL", "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|GTD: 89.3K|Restructured 2026"],
  // Native (non-restructured) suffixed Ext2.
  ["Vet-Ext2-FL", "CL 2| TCV 44K| AAV 22K| Y1-32K, Y2-12K| GTD: 33K| Ext: L.A.| Restructured 2026"],
  // An Ext1 already down to its LAST year (frozen year already played, no longer listed) --
  // must resolve flat on both, not unresolved.
  ["Vet-Ext1", "CL 1|TCV 15K|AAV 15K|Y1-15K|Ext: Bomb|GTD: 11.3K"],
  // Non-extension loaded contracts, unaffected by any of the above.
  ["Vet-FAA-BL", "CL 3| TCV 45K| AAV 15K| Y1-9K, Y2-1K, Y3-35K| GTD: 33.8K"],
  ["Vet-WW-FL", "CL 3|TCV 21K|AAV 7K|Y1-12K, Y2-1K, Y3-8K|GTD: 15.8K"],
  // MYM -- can never be loaded, regardless of any suffix (an anomaly, unresolved).
  ["Vet-MYM", "CL 2|TCV 20K|AAV 10K|Y1-10K, Y2-10K"],
  ["Vet-WW-MYM", ""],
  // Rookie draft, tag, plain veteran -- flat, unaffected.
  ["Rookie-Draft", "CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K"],
  ["Tag", "CL 1|TCV 30K|AAV 30K|Y1-30K"],
  ["Veteran", ""],
  // Malformed / incomplete schedules -- unresolved on both, never guessed.
  ["Vet-FAA", "CL 3|TCV 6K|Y1-2K, Y3-4K"],
  ["Vet-Ext2", "CL 3|TCV 6K|Y1-2K, Y3-4K"],
  ["", ""],
  [null, null],
];

test(`PARITY (synthetic edge cases): ${SYNTHETIC_SHAPES.length} hand-picked shapes covering every documented special case classify identically on all three surfaces`, () => {
  for (const [status, info] of SYNTHETIC_SHAPES) {
    const w = WORKER.resolveLoadedStatus(status, info);
    const f = FO.resolveLoadedStatus(status, info);
    t.deepEqual(plain(f), plain(w), `status="${status}" info="${info}": worker=${JSON.stringify(w)} FO=${JSON.stringify(f)}`);
    t.equal(FO.isLoaded(status, info), WORKER.isLoaded(status, info), `isLoaded() parity: status="${status}" info="${info}"`);
    const rwbExpected = w.resolved ? w.loaded !== "" : null;
    t.equal(RWB.isLoadedContractStatus(status, info), rwbExpected, `Roster Workbench parity: status="${status}" info="${info}"`);
  }
});

await run("loaded_contract_classification_parity");
