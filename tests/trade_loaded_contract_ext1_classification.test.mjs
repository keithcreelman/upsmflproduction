// PLAIN `Vet-Ext1` AND THE LOADED-CONTRACT COUNT — investigation tests, NOT a production change.
//   node tests/trade_loaded_contract_ext1_classification.test.mjs
//
// Keith's ruling (2026-09-29): "Before changing enforcement, investigate the one-year `Vet-Ext1`
// classification across the league... plus tests for both possible interpretations." Full
// investigation, canon citations, and recommendation: docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_
// INVESTIGATION.md. This file proves BOTH interpretations' exact behavior against the REAL
// contract strings found live on HammerTime (0005) and L.A. Looks (0001) on 2026-09-29, using
// the REAL, unmodified classifier for Interpretation A -- nothing in contract_classification.js
// is changed or monkey-patched. Interpretation B is a LOCAL, test-only re-derivation (defined
// entirely in this file), never applied to production code, existing purely to demonstrate what
// the alternate rule WOULD produce on the same real data, for comparison.
//
// Interpretation A (current shipped behavior): resolveLoadedStatus's generic Year-1-vs-TCV/CL
//   test, unconditionally, regardless of contractStatus.
// Interpretation B (the investigation's recommendation, NOT applied): a contractStatus matching
//   a plain ExtN pattern (Vet-Ext1, Vet-Ext2, Rookie-Ext1, etc.) with NO -FL/-BL suffix is always
//   treated as flat, regardless of its schedule -- mirroring resolveExtensionLoadedStatus's own
//   existing "a single new year has no shape to compare, and is flat" reasoning for the PRICING
//   path, extended here (as a test-only demonstration) to the ROSTER-classification path.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { resolveLoadedStatus } from "../worker/src/contract_classification.js";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";

const restore = () => {}; // no console suppression needed -- this file makes no network/D1 calls

// ───────────────────────────────── Interpretation B (test-only, never applied to production) ─────────────────────────────────
// A plain ExtN contract (no -FL/-BL suffix) is always flat. A SUFFIXED ExtN (post-restructure,
// canon :531-533) is NOT touched by this override -- it keeps whatever resolveLoadedStatus (the
// real, unmodified classifier) says, since a real, canon-sanctioned suffix is real evidence.
const PLAIN_EXTN_RE = /^(Vet|Rookie)-Ext\d+$/i;
function interpretationB(contractStatus, contractInfo) {
  const real = resolveLoadedStatus(contractStatus, contractInfo);
  if (PLAIN_EXTN_RE.test(String(contractStatus || "").trim())) {
    return { ...real, loaded: false, resolved: true, interpretationB_overridden: true };
  }
  return real;
}

// ───────────────────────────────── Real contract strings, fetched live 2026-09-29 ─────────────────────────────────
// Exact contractStatus/contractInfo pairs from HammerTime (0005) and L.A. Looks (0001)'s live
// 2026 rosters (docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md §2-3). Snapshotted here
// as literal test fixtures -- this file makes no live MFL call itself.
const HAMMER_ROSTER = [
  { name: "McBride", id: "15794", contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-9K, Y2-35K| GTD: 33K| Ext: Hammer" },
  { name: "G.Smith", id: "11150", contractStatus: "Vet-FAA-BL", contractInfo: "CL 3| TCV 45K| AAV 15K| Y1-9K, Y2-1K, Y3-35K| GTD: 33.8K" },
  { name: "Addison", id: "16186", contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 24K| AAV 17K| Y1-7K, Y2-17K| GTD: 18K| Ext: LH" },
  { name: "Chase", id: "15281", contractStatus: "Vet-Ext2-BL", contractInfo: "CL 2| TCV 129K| AAV 54K| Y1-26K, Y2-103K| GTD: 96.8K| Ext: Creel, Hammer| restructure: 2026" },
  { name: "Walker III", id: "15711", contractStatus: "Vet-Ext1-BL", contractInfo: "CL 2| TCV 74K| AAV 32K, 42K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal| restructure: 2026" },
  { name: "Montgomery", id: "14071", contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 42K| AAV 20K, 30K| Y1-12K, Y2-30K| Ext: Hammer| GTD: 31.5K" },
  { name: "Jacobs", id: "14073", contractStatus: "Vet-FAA-BL", contractInfo: "CL 3|TCV 90K|AAV 30K|Y1-18K, Y2-36K, Y3-36K|GTD: 67.5K", ir: true },
  { name: "Stroud", id: "16150", contractStatus: "Vet-Ext1", contractInfo: "CL 1| TCV 22K| AAV 22K| Y1-22K" },
];
const LOOKS_ROSTER = [
  { name: "C.Brown", id: "16181", contractStatus: "Vet-Ext2-FL", contractInfo: "CL 2| TCV 44K| AAV 22K| Y1-32K, Y2-12K| GTD: 33K| Ext: L.A.| Restructured 2026" },
  { name: "Ferguson", id: "15799", contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 32K| AAV 21K| Y1-11, Y2-21| GTD: 24K| Ext: Blake, L.A. Looks" },
  { name: "Jennings", id: "14860", contractStatus: "Vet-Ext1", contractInfo: "CL 2| TCV 32K| AAV 21K| Y1-11K, Y2-21K| Ext: Creel, L.A.| GTD: 24K" },
  { name: "Bond", id: "17076", contractStatus: "Vet-WW-BL", contractInfo: "CL 3| TCV 24K| AAV 8K| Y1-5, Y2-5, Y3-14| GTD: 18K" },
  { name: "Darnold", id: "13592", contractStatus: "Vet-Ext1-FL", contractInfo: "CL 2| TCV 46K| AAV 18K, 28K| Y1-30K, Y2-16K| GTD: 34.5K| Ext: GRID| Restructured 2026" },
  { name: "Coker", id: "16809", contractStatus: "Vet-Ext1", contractInfo: "CL 2|TCV 12K|AAV 1K, 11K|Y1-1K, Y2-11K|Ext: L.A.|GTD: 9K" },
  { name: "Likely", id: "15798", contractStatus: "Vet-FAA-FL", contractInfo: "CL 3|TCV 21K|AAV 7K|Y1-12K, Y2-1K, Y3-8K|GTD: 15.8K" },
  { name: "Pierce", id: "15768", contractStatus: "Vet-Ext1", contractInfo: "CL 2|TCV 14K|AAV 2K, 12K|Y1-2K, Y2-12K|Ext: L.A.|GTD: 10.5K", ir: true },
  { name: "Sutton", id: "13630", contractStatus: "Vet-Ext1", contractInfo: "CL 1| TCV 15K| AAV 15K| Y1-15K" },
];

// ───────────────────────────────── Interpretation A: proves TODAY's real, shipped behavior ─────────────────────────────────
test("EXT1 INTERPRETATION A (shipped today): Addison and Montgomery (HammerTime) classify back-loaded via the real, unmodified resolveLoadedStatus", () => {
  const addison = resolveLoadedStatus("Vet-Ext1", HAMMER_ROSTER.find((p) => p.name === "Addison").contractInfo);
  t.equal(addison.resolved, true); t.equal(addison.loaded, "BL");
  const montgomery = resolveLoadedStatus("Vet-Ext1", HAMMER_ROSTER.find((p) => p.name === "Montgomery").contractInfo);
  t.equal(montgomery.resolved, true); t.equal(montgomery.loaded, "BL");
});
test("EXT1 INTERPRETATION A (shipped today): all four plain Ext1s on L.A. Looks classify back-loaded", () => {
  for (const name of ["Ferguson", "Jennings", "Coker", "Pierce"]) {
    const p = LOOKS_ROSTER.find((x) => x.name === name);
    const r = resolveLoadedStatus(p.contractStatus, p.contractInfo);
    t.equal(r.resolved, true, name); t.equal(r.loaded, "BL", name);
  }
});
test("EXT1 INTERPRETATION A (shipped today): a RESTRUCTURED, genuinely-suffixed Ext1 (Walker III, Darnold) is unaffected by anything in this file -- real evidence, correctly counted", () => {
  const walker = resolveLoadedStatus("Vet-Ext1-BL", HAMMER_ROSTER.find((p) => p.name === "Walker III").contractInfo);
  t.equal(walker.loaded, "BL");
  const darnold = resolveLoadedStatus("Vet-Ext1-FL", LOOKS_ROSTER.find((p) => p.name === "Darnold").contractInfo);
  t.equal(darnold.loaded, "FL");
});
test("EXT1 INTERPRETATION A (shipped today): HammerTime totals 7 loaded, L.A. Looks totals 8, matching the live gate exactly", () => {
  const loadedCount = (roster) => roster.filter((p) => { const r = resolveLoadedStatus(p.contractStatus, p.contractInfo); return r.resolved && r.loaded; }).length;
  t.equal(loadedCount(HAMMER_ROSTER), 7);
  t.equal(loadedCount(LOOKS_ROSTER), 8);
});

// ───────────────────────────────── Interpretation B: test-only, demonstrates the alternate rule ─────────────────────────────────
test("EXT1 INTERPRETATION B (test-only, NOT applied to production): the same Addison/Montgomery contracts flip to flat", () => {
  const addison = interpretationB("Vet-Ext1", HAMMER_ROSTER.find((p) => p.name === "Addison").contractInfo);
  t.equal(addison.loaded, false);
  const montgomery = interpretationB("Vet-Ext1", HAMMER_ROSTER.find((p) => p.name === "Montgomery").contractInfo);
  t.equal(montgomery.loaded, false);
});
test("EXT1 INTERPRETATION B (test-only): a RESTRUCTURED, suffixed Ext1 is NOT overridden -- Interpretation B only touches the PLAIN (no-suffix) pattern, real suffix evidence stays real", () => {
  const walker = interpretationB("Vet-Ext1-BL", HAMMER_ROSTER.find((p) => p.name === "Walker III").contractInfo);
  t.equal(walker.loaded, "BL", "unaffected -- has a real suffix");
  const darnold = interpretationB("Vet-Ext1-FL", LOOKS_ROSTER.find((p) => p.name === "Darnold").contractInfo);
  t.equal(darnold.loaded, "FL", "unaffected -- has a real suffix");
});
test("EXT1 INTERPRETATION B (test-only): HammerTime totals drop from 7 to 5 (exactly at the limit); L.A. Looks drops from 8 to 4 (one UNDER the limit)", () => {
  const loadedCountB = (roster) => roster.filter((p) => interpretationB(p.contractStatus, p.contractInfo).loaded).length;
  t.equal(loadedCountB(HAMMER_ROSTER), 5, "7 - 2 plain Ext1s (Addison, Montgomery)");
  t.equal(loadedCountB(LOOKS_ROSTER), 4, "8 - 4 plain Ext1s (Ferguson, Jennings, Coker, Pierce)");
});
test("EXT1 INTERPRETATION B (test-only): a genuine 1-year (non-extension) Ext1 contract (Stroud, Sutton) is flat under EITHER interpretation -- B changes nothing for a contract that was already flat", () => {
  // resolveLoadedStatus's own flat sentinel is "" (empty string, falsy), not the boolean false --
  // matched here exactly, not re-guessed.
  const stroud = HAMMER_ROSTER.find((p) => p.name === "Stroud");
  t.equal(resolveLoadedStatus(stroud.contractStatus, stroud.contractInfo).loaded, "", "A: already flat");
  t.equal(interpretationB(stroud.contractStatus, stroud.contractInfo).loaded, false, "B: still flat (this file's own override sentinel)");
  const sutton = LOOKS_ROSTER.find((p) => p.name === "Sutton");
  t.equal(resolveLoadedStatus(sutton.contractStatus, sutton.contractInfo).loaded, "", "A: already flat");
  t.equal(interpretationB(sutton.contractStatus, sutton.contractInfo).loaded, false, "B: still flat (this file's own override sentinel)");
});

// ───────────────────────────────── End-to-end: the delta through the REAL trade-compliance gate ─────────────────────────────────
// Proves the SAME delta holds through evaluateTradeCompliance itself (not just the bare
// classifier), using conditionalDrops to simulate "what if these two specific plain-Ext1 players
// were excluded from the count" -- a legitimate, already-shipped mechanism (a valid, selected
// conditional drop already removes a player from the count, see trade_cap_authority.js), reused
// here purely as a test technique to demonstrate the SAME numeric delta end-to-end. This does
// NOT mean "drop Addison and Montgomery" is being proposed as the actual fix -- it's a test-only
// way to prove the same before/after counts through the real, full compliance calculation.
const ok = (data) => ({ ok: true, status: 200, data });
const league = (o) => ok({ league: { salaryCapAmount: "300000", rosterSize: "35", franchises: { franchise: [{ id: "0005", name: "HammerTime" }, { id: "0001", name: "L.A. Looks" }, { id: "0099", name: "Filler" }] } }, ...(o || {}) });
const rosterOf = (map) => ok({ rosters: { franchise: Object.entries(map).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p.id, salary: "1000", status: p.ir ? "INJURED_RESERVE" : "ROSTER", contractYear: "1", contractStatus: p.contractStatus, contractInfo: p.contractInfo })) })) } });
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const adjOf = () => ok({ salaryAdjustments: "" });
test("EXT1: through the REAL evaluateTradeCompliance (not just the bare classifier), HammerTime's projected count drops from 7 to 5 when its two plain-Ext1 players are excluded via the shipped conditionalDrops mechanism -- a test technique proving the same delta end-to-end, not a proposed fix", () => {
  const rosters = rosterOf({ "0005": HAMMER_ROSTER, "0001": [{ id: "90000", contractStatus: "Vet-FAA", ir: false }], "0099": [] });
  const movements = [{ from: "0005", to: "0099", tokens: [] }]; // HammerTime is a participant (so its own standing count is evaluated) but sends/receives nothing -- isolates its own pre-existing count
  const before = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf(), rosters, movements });
  const hammerBefore = before.loaded_contracts.rows.find((r) => r.franchise_id === "0005");
  t.equal(hammerBefore.loaded_before, 7);

  const after = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf(), rosters, movements, conditionalDrops: { "0005": ["16186", "14071"] } });
  const hammerAfter = after.loaded_contracts.drop_requirements.find((d) => d.franchise_id === "0005");
  t.ok(hammerAfter, "0005 was over the limit before exclusion, so a drop_requirements row exists");
  t.equal(hammerAfter.valid_count, 2, "both Addison and Montgomery are valid, real loaded contracts on 0005's own roster -- the exclusion mechanism itself is real, not simulated");
  t.equal(hammerAfter.projected - hammerAfter.valid_count, 5, "7 - 2 = 5, matching Interpretation B's bare-classifier result exactly");
});

await run("trade_loaded_contract_ext1_classification");
restore();
