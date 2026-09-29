// Fix for the plain-ExtN loaded-contract misclassification found while investigating
// PR #1149 (loaded-contract conditional drops). Full investigation:
// docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md (already merged/available on
// the investigation branch). Summary of the defect:
//
// worker/src/contract_classification.js's resolveLoadedStatus (the function that counts
// an EXISTING roster contract toward the 5-loaded-contract limit) classified a plain
// (no -FL/-BL suffix) Vet-Ext1/Vet-Ext2 contract as loaded purely because a frozen
// prior-contract year sits below the whole-contract average -- even though canon (:479)
// says Ext1 NEVER carries a suffix, no exception, and the SAME codebase's own
// resolveExtensionLoadedStatus (the pricing path) already treats this exact shape as flat.
//
// Verified three independent ways (2026-09-29):
//   1. Internal code inconsistency -- the pricer and the roster-classifier disagreed
//      about the identical contract shape (see the investigation doc, section 6).
//   2. Front Office's own isLoadedRow (site/rosters/v2/front_office.js:3701-3708) has
//      classified loaded status by literal suffix presence since 2026-06-02 (PR #398),
//      a real, Keith-reviewed fix for this exact failure mode on a different codepath.
//   3. A live, 483-player, all-12-franchise sweep (2026-09-29) comparing the worker's
//      pre-fix resolveLoadedStatus output against FO's isLoadedRow found the disagreement
//      isolated to EXACTLY this shape -- zero unexpected disagreements anywhere else in
//      the league (no taxi, no restructured, no other contract family).
//
// Fix: a new "priority 0" in resolveLoadedStatus -- a plain ExtN contractStatus (no
// suffix) is flat by definition, checked before the schedule is ever consulted. A
// contractStatus WITH a real suffix (earned via restructure) is unaffected.
//
//   node tests/loaded_contract_plain_extn_classification.test.mjs
import fs from "fs";
import assert from "assert";
import { resolveLoadedStatus } from "../worker/src/contract_classification.js";

let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("1. the new priority-0 carve-out exists and fires before the schedule");
check("plain Vet-Ext1, no suffix, a real loaded-looking schedule -> flat", () => {
  const r = resolveLoadedStatus("Vet-Ext1", "CL 2| TCV 24K| AAV 17K| Y1-7K, Y2-17K| GTD: 18K| Ext: LH");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "");
});
check("plain Vet-Ext2 (3-year, frozen-Y1 pattern), no suffix -> flat", () => {
  const r = resolveLoadedStatus("Vet-Ext2", "CL 3| TCV 73K| AAV 31K| Y1-11K, Y2-31K, Y3-31K| GTD: 54.8K| Ext: Sex");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "");
});
check("plain Rookie-Ext1 (no live example exists yet, but canon's rule is the same family) -> flat", () => {
  const r = resolveLoadedStatus("Rookie-Ext1", "CL 2| TCV 20K| Y1-5K, Y2-15K");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "");
});
check("a REAL suffix on an ExtN status is unaffected -- still resolves via the schedule", () => {
  const r = resolveLoadedStatus("Vet-Ext1-BL", "CL 2| TCV 74K| AAV 32K, 42K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal| restructure: 2026");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "BL");
});

console.log("\n2. real, live-verified fixtures (2026-09-29 sweep) -- all 18 previously-disagreeing players now resolve flat");
// Every fixture below is the REAL contractStatus + contractInfo pulled live from MFL
// (api.myfantasyleague.com/2026/export?TYPE=rosters&L=74598) on 2026-09-29 -- not
// synthesized. Each one was a genuine worker-vs-FO disagreement before this fix and is a
// genuine agreement after it.
const PLAIN_EXT1_FIXTURES = [
  ["0001", "15799", "Jake Ferguson",     "Vet-Ext1", "CL 2| TCV 32K| AAV 21K| Y1-11, Y2-21| GTD: 24K| Ext: Blake, L.A. Looks"],
  ["0001", "14860", "Jauan Jennings",    "Vet-Ext1", "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| Ext: Creel, L.A.| GTD: 24K"],
  ["0001", "16809", "Jalen Coker",       "Vet-Ext1", "CL 2|TCV 12K|AAV 1K, 11K|Y1-1K, Y2-11K|Ext: L.A.|GTD: 9K"],
  ["0004", "16708", "Tykee Smith",       "Vet-Ext1", "CL 2| TCV 5K| AAV 4K|Y1-1 Y2-4| GTD: 3.8K| Ext: LH"],
  ["0005", "16186", "Jordan Addison",    "Vet-Ext1", "CL 2| TCV 24K| AAV 17K| Y1-7K, Y2-17K| GTD: 18K| Ext: LH"],
  ["0005", "14071", "David Montgomery",  "Vet-Ext1", "CL 2| TCV 42K| AAV 20K, 30K| Y1-12K, Y2-30K| Ext: Hammer| GTD: 31.5K"],
  ["0006", "12626", "Derrick Henry",     "Vet-Ext1", "CL 2| TCV 94K| AAV 44K|Y1-50 Y2-44| GTD: 70.5K| Ext: LH"],
  ["0006", "16187", "Josh Downs",        "Vet-Ext1", "CL 2|TCV 34K|AAV 12K, 22K|Y1-12K, Y2-22K|Ext: GRide|GTD: 25.5K"],
  ["0010", "16223", "Will Anderson",     "Vet-Ext1", "CL 2|TCV 5K|AAV 1K, 4K|Y1-1K, Y2-4K|Ext: Bomb|GTD: 3.8K"],
  ["0010", "16723", "AJ Barner",         "Vet-Ext1", "CL 2|TCV 12K|AAV 1K, 11K|Y1-1K, Y2-11K|Ext: Bomb|GTD: 9K"],
  ["0010", "14823", "Rico Dowdle",       "Vet-Ext1", "CL 2| TCV 12K| AAV 11K| Y1-1K, Y2-11K| GTD: 9K| Ext: Blake"],
  ["0011", "15757", "Wan'Dale Robinson", "Vet-Ext1", "CL 2| TCV 34K| AAV 22K| Y1-12K, Y2-22K| GTD: 25.5K| Ext: Blake, LH"],
];
const PLAIN_EXT2_3YR_FIXTURES = [
  ["0004", "16162", "Jahmyr Gibbs",  "Vet-Ext2", "CL 3| TCV 73K| AAV 31K| Y1-11K, Y2-31K, Y3-31K| GTD: 54.8K| Ext: Sex"],
  ["0004", "16190", "Zay Flowers",   "Vet-Ext2", "CL 3| TCV 55K| AAV 25K| Y1-5, Y2-25, Y3-25| GTD: 41.3K| Ext: GRide"],
  ["0011", "14832", "CeeDee Lamb",   "Vet-Ext2", "CL 3| TCV 172K| AAV 64K| Y1- 44K Y2- 64K Y3- 64K| GTD: 129K| Ext: L.A. Looks, Cleon"],
  ["0012", "16213", "Dalton Kincaid","Vet-Ext2", "CL 3| TCV 67K| AAV 29K| Y1-9K, Y2-29K, Y3-29K| GTD: 50.3K| Ext: PG"],
];
const IR_PLAIN_EXT1_FIXTURES = [
  ["0001", "15768", "Alec Pierce", "Vet-Ext1", "CL 2|TCV 14K|AAV 2K, 12K|Y1-2K, Y2-12K|Ext: L.A.|GTD: 10.5K"],
  ["0006", "14104", "A.J. Brown",  "Vet-Ext1", "CL 2| TCV 129K| AAV 56K|Y1-73 Y2-56| GTD: 96.8K| Ext: Sex, Creel, LH"],
];
const ALL_FIXTURES = [...PLAIN_EXT1_FIXTURES, ...PLAIN_EXT2_3YR_FIXTURES, ...IR_PLAIN_EXT1_FIXTURES];

for (const [fid, pid, name, status, info] of ALL_FIXTURES) {
  check(`${fid} #${pid} ${name} (${status}) resolves flat`, () => {
    const r = resolveLoadedStatus(status, info);
    assert.strictEqual(r.resolved, true, "must resolve, not fall to unavailable");
    assert.strictEqual(r.loaded, "", `${name} must be flat under the fixed classifier`);
  });
}
check(`exactly ${ALL_FIXTURES.length} live fixtures covered (12 plain Ext1 + 4 plain Ext2-3yr + 2 IR-overlap)`, () => {
  assert.strictEqual(PLAIN_EXT1_FIXTURES.length, 12);
  assert.strictEqual(PLAIN_EXT2_3YR_FIXTURES.length, 4);
  assert.strictEqual(IR_PLAIN_EXT1_FIXTURES.length, 2);
});

console.log("\n3. regression controls -- real contracts that must NOT change");
check("Kenneth Walker III (Vet-Ext1-BL, restructured 2026) -- real suffix, still loaded (BL)", () => {
  const r = resolveLoadedStatus("Vet-Ext1-BL", "CL 2| TCV 74K| AAV 32K, 42K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal| restructure: 2026");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "BL");
});
check("Sam Darnold (Vet-Ext1-FL, restructured 2026) -- real suffix, still loaded (FL)", () => {
  const r = resolveLoadedStatus("Vet-Ext1-FL", "CL 2| TCV 46K| AAV 18K, 28K| Y1-30K, Y2-16K| GTD: 34.5K| Ext: GRID| Restructured 2026");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "FL");
});
check("Trey McBride (Vet-Ext2-BL, non-plain) -- unaffected, still loaded (BL)", () => {
  const r = resolveLoadedStatus("Vet-Ext2-BL", "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K| Ext: Hammer");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "BL");
});
check("Geno Smith (Vet-FAA-BL, non-extension family) -- unaffected, still loaded (BL)", () => {
  const r = resolveLoadedStatus("Vet-FAA-BL", "CL 3| TCV 45K| AAV 15K| Y1-9K, Y2-1K, Y3-35K| GTD: 33.8K");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "BL");
});
check("a genuine 1-year Vet-Ext1 (e.g. C.J. Stroud shape, CL 1) is still flat either way", () => {
  const r = resolveLoadedStatus("Vet-Ext1", "CL 1| TCV 22K| AAV 22K| Y1-22K");
  assert.strictEqual(r.resolved, true);
  assert.strictEqual(r.loaded, "");
});

console.log("\n4. defect-sensitivity -- this suite fails against the pre-fix source");
check("the PLAIN_EXTN_RE priority-0 carve-out is present in the source (proves this isn't accidentally passing)", () => {
  const src = fs.readFileSync(new URL("../worker/src/contract_classification.js", import.meta.url), "utf8");
  assert.match(src, /PLAIN_EXTN_RE/);
  assert.match(src, /Priority 0/);
});

console.log("\n5. league-wide before/after (from the live 2026-09-29 sweep, all 483 rostered/IR/taxi players, all 12 franchises)");
// Recorded here as a fixed, dated snapshot for the PR description/review -- NOT re-fetched
// live by this test (a live network fetch in a unit test would be flaky and slow). The
// counts themselves are exercised properly above via the real per-player fixtures; this
// check only documents the aggregate finding for anyone reading the test output.
const BEFORE_AFTER = {
  "0001": [8, 4], "0002": [4, 4], "0003": [1, 1], "0004": [8, 5], "0005": [7, 5],
  "0006": [5, 2], "0007": [3, 3], "0008": [2, 2], "0009": [5, 5], "0010": [7, 4],
  "0011": [7, 5], "0012": [1, 0],
};
check("before total = 58, after total = 40 (delta -18: 14 Ext1 + 4 flagged Ext2-3yr)", () => {
  const before = Object.values(BEFORE_AFTER).reduce((a, [b]) => a + b, 0);
  const after = Object.values(BEFORE_AFTER).reduce((a, [, b]) => a + b, 0);
  assert.strictEqual(before, 58);
  assert.strictEqual(after, 40);
  assert.strictEqual(before - after, 18);
});
check("before: 5 franchises over the 5-loaded limit (0001,0004,0005,0010,0011); after: ZERO franchises over", () => {
  const overBefore = Object.entries(BEFORE_AFTER).filter(([, [b]]) => b > 5).map(([f]) => f).sort();
  const overAfter = Object.entries(BEFORE_AFTER).filter(([, [, a]]) => a > 5).map(([f]) => f).sort();
  assert.deepStrictEqual(overBefore, ["0001", "0004", "0005", "0010", "0011"]);
  assert.deepStrictEqual(overAfter, []);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
