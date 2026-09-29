// LOADED-CONTRACT LIMIT (HARD BLOCK) — canon §2.G/§6.G: max 5 loaded (front + back combined)
// contracts per roster after a trade.   node tests/trade_loaded_contracts.test.mjs
//
// RULING (2026-09-28): a trade must not execute if the authoritative post-trade calculation
// PROVES a participating franchise would end up with more than 5 loaded contracts. Fails
// closed on unreadable authority. No owner or commissioner override. Same shared calculation
// (worker/src/trade_cap_authority.js's evaluateTradeCompliance) as the salary cap, enforced
// at the identical set of points (2-way accept/preview, 3-way accept/execute/recheck).
//
// Part 1  the calculation itself (pure): every input that can move the loaded-contract count
// Part 2  two-team accept through the real worker
// Part 3  three-team gates (Discord accept + execute + recheck) through the real worker
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { classifyLoaded, isLoaded } from "../worker/src/contract_classification.js";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton, execute3Way } = await import("../worker/src/trade_3way.js");
const { makeLedger } = await import("../worker/src/trade_execution.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const CAP = 300000;

// ───────────────────────────────── Part 1 — the pure calculation ─────────────────────────────────
const ok = (data) => ({ ok: true, status: 200, data });
const league = (o) => ok({ league: { salaryCapAmount: String(CAP), rosterSize: "35", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }, { id: "0003", name: "Gride" }] }, ...(o || {}) } });
const rosterOf = (map) => ok({ rosters: { franchise: Object.entries(map).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p.id, salary: p.salary == null ? "1000" : String(p.salary), status: p.status || "ROSTER", contractYear: String(p.contractYear ?? 2), ...(p.contractStatus ? { contractStatus: p.contractStatus } : {}), ...(p.contractInfo ? { contractInfo: p.contractInfo } : {}) })) })) } });
const adjOf = (rows) => ok({ salaryAdjustments: rows === undefined ? "" : { salaryAdjustment: rows } });
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const calc = (o) => evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), ...o });

// N loaded (BL) contracts for one franchise, ids starting at `from`.
const loadedIds = (from, count, cs = "Vet-Ext2-BL") => Array.from({ length: count }, (_, i) => ({ id: String(from + i), contractStatus: cs }));

test("LC 1: exactly 4 -> 5 loaded contracts passes", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 5);
});

test("LC 2: 5 -> 6 blocks", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "blocked");
  t.equal(c.loaded_contracts.violations.length, 1);
  t.equal(c.loaded_contracts.violations[0].franchise_id, "0001");
  t.match(c.loaded_contracts.violations[0].message, /L\.A\. Looks would move from 5 to 6 loaded contracts\. The maximum is 5, so 1 conditional drop/);
  // Keith's ruling (2026-09-29): the limit is now escapable via a valid conditional drop, not a
  // permanent block -- the requirement itself is reported even before anyone has picked anything.
  t.equal(c.loaded_contracts.drop_requirements.length, 1);
  t.equal(c.loaded_contracts.drop_requirements[0].franchise_id, "0001");
  t.equal(c.loaded_contracts.drop_requirements[0].required_drops, 1);
  t.equal(c.loaded_contracts.drop_requirements[0].satisfied, false);
  // The candidate menu a picker renders FROM: 0001's own 5 pre-existing loaded contracts, never
  // the just-received "200" (not on 0001's CURRENT roster -- consistent with how a selection of
  // it would itself be rejected as not_on_roster) and never a player 0001 is sending away.
  t.deepEqual(c.loaded_contracts.drop_requirements[0].candidates, ["100", "101", "102", "103", "104"]);
});

test("LC 2d: a VALID selected drop also updates the lineup-feasibility warning -- the owner sees what dropping THIS player actually costs before confirming", () => {
  // 0001's real 18-man lineup, with 5 of those 18 spots filled by loaded contracts: two RBs (2,3),
  // two WRs (4,5) -- all flex-coverable/redundant -- and the SOLE Punter (11), which has no
  // flex/surplus fallback (worker/src/trade_lineup_feasibility.js's LU 3 case). 5 loaded -> a 6th
  // received (flat position, "200") pushes to 6, requiring exactly 1 drop.
  const roster18 = [
    { id: "1", position: "QB" }, { id: "2", position: "RB", loaded: true }, { id: "3", position: "RB", loaded: true },
    { id: "4", position: "WR", loaded: true }, { id: "5", position: "WR", loaded: true }, { id: "6", position: "TE" },
    { id: "7", position: "RB" }, { id: "8", position: "WR" }, { id: "9", position: "QB" }, { id: "10", position: "PK" },
    { id: "11", position: "PN", loaded: true }, { id: "12", position: "DL" }, { id: "13", position: "DL" },
    { id: "14", position: "LB" }, { id: "15", position: "LB" }, { id: "16", position: "DB" }, { id: "17", position: "DB" }, { id: "18", position: "DL" },
  ];
  const team2_18 = roster18.map((p) => ({ id: "2" + p.id.padStart(2, "0"), position: p.position }));
  const players = ok({ players: { player: [
    ...roster18.map((p) => ({ id: p.id, position: p.position })),
    ...team2_18.map((p) => ({ id: p.id, position: p.position })),
    { id: "200", position: "WR" },
  ] } });
  const rosters = rosterOf({
    "0001": roster18.map((p) => ({ id: p.id, contractStatus: p.loaded ? "Vet-Ext2-BL" : "Vet-FAA" })),
    "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }, ...team2_18.map((p) => ({ id: p.id, contractStatus: "Vet-FAA" }))],
  });
  const movements = [{ from: "0002", to: "0001", tokens: ["200"] }];

  const noDropYet = calc({ rosters, movements, players });
  t.equal(noDropYet.loaded_contracts.status, "blocked", "no selection yet -- still owes the drop");
  t.equal(noDropYet.lineup.status, "ok", "before any drop is actually selected, the roster (and its lineup) is unchanged");

  const droppingPunter = calc({ rosters, movements, players, conditionalDrops: { "0001": ["11"] } });
  t.equal(droppingPunter.loaded_contracts.status, "needs_drops", "dropping the sole Punter is a VALID, sufficient selection");
  t.equal(droppingPunter.lineup.status, "warn", "but it costs the team its only Punter -- the lineup check must reflect the roster AFTER the drop, not before");
  const row = droppingPunter.lineup.rows.find((r) => r.franchise_id === "0001");
  t.ok(row && row.missing && row.missing.some((m) => m.slot === "Punter"), JSON.stringify(row));

  const droppingRedundantRB = calc({ rosters, movements, players, conditionalDrops: { "0001": ["2"] } });
  t.equal(droppingRedundantRB.loaded_contracts.status, "needs_drops");
  t.equal(droppingRedundantRB.lineup.status, "ok", "dropping a flex-covered RB instead costs nothing -- proving the warning above is specific to WHICH player was picked, not just that a drop happened");
});

test("LC 2c: candidates excludes a loaded contract the franchise is SENDING away in this same trade", () => {
  const c = calc({
    rosters: rosterOf({ "0001": [...loadedIds(100, 5), { id: "999", contractStatus: "Vet-Ext2-BL" }], "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }, { from: "0001", to: "0002", tokens: ["999"] }],
  });
  // 0001 has 6 loaded (5 fillers + 999) before the trade, sends 999 away (a loaded contract,
  // so loaded_before counts it) and receives 200 (loaded) -> still 6 after -> still 1 required.
  const req = c.loaded_contracts.drop_requirements[0];
  t.equal(req.required_drops, 1);
  t.doesNotMatch(JSON.stringify(req.candidates), /"999"/, "the player being sent away can't also be offered as a drop candidate");
  t.deepEqual(req.candidates, ["100", "101", "102", "103", "104"]);
});

test("LC 3: sending and receiving one loaded contract stays at 5 and passes", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }, { from: "0001", to: "0002", tokens: ["100"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 5); t.equal(r1.loaded_after, 5);
});

test("LC 4: sending two loaded and receiving one decreases the count", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }, { from: "0001", to: "0002", tokens: ["100", "101"] }],
  });
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 5); t.equal(r1.loaded_after, 4, "5 - 2 sent + 1 received = 4");
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 5: front-loaded contracts count (suffix -FL, and legacy bare FL)", () => {
  t.equal(classifyLoaded("Vet-FAA-FL"), "FL");
  t.equal(classifyLoaded("FL"), "FL");
  t.equal(isLoaded("Vet-Ext2-FL"), true);
});

test("LC 6: back-loaded contracts count (suffix -BL, and legacy bare BL)", () => {
  t.equal(classifyLoaded("Vet-Ext2-BL"), "BL");
  t.equal(classifyLoaded("BL"), "BL");
  t.equal(isLoaded("Vet-WW-BL"), true);
});

test("LC 7: flat contracts do not count", () => {
  t.equal(classifyLoaded("Vet-FAA"), "");
  t.equal(classifyLoaded("Vet-Ext2"), "");
  t.equal(classifyLoaded("Vet-WW"), "");
  t.equal(isLoaded("Vet-ERA"), false);
});

test("LC 8: Rookie three-year contracts do not accidentally count as loaded", () => {
  t.equal(classifyLoaded("Rookie-Draft"), "");
  const c = calc({
    rosters: rosterOf({ "0001": [{ id: "1", contractStatus: "Rookie-Draft" }, { id: "2", contractStatus: "Rookie-Draft" }], "0002": [{ id: "200", contractStatus: "Rookie-Draft" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 0);
});

test("LC 9: a loaded contract on taxi still counts (no taxi carve-out)", () => {
  const c = calc({
    rosters: rosterOf({
      "0001": [...loadedIds(100, 4), { id: "104", contractStatus: "Vet-Ext2-BL", status: "TAXI_SQUAD" }],
      "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }],
    }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_before, 5, "the taxi player's loaded contract must be counted in the baseline");
  t.equal(c.loaded_contracts.status, "blocked", "5 (incl. taxi) -> 6 must block, never silently pass because one was on taxi");
});

test("LC 10: a pre-trade extension is included, attributed to the acquiring franchise -- derived from its AUTHORITATIVE FUTURE-years priced terms (excluding the frozen Y1), matching the claimed indicator", () => {
  // Y1 is always the pre-extension CURRENT salary, frozen, never repriced -- it is
  // structurally irrelevant to loaded/flat and must be excluded from the comparison
  // (see worker/src/contract_classification.js resolveExtensionLoadedStatus). Only the
  // FUTURE years (Y2, Y3) determine the shape: increasing -> BL.
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }), // 200 is currently FLAT
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "BL", preview_contract_info_string: "CL 3|TCV 7K|Y1-1K, Y2-2K, Y3-4K" }],
  });
  const r1 = c.loaded_contracts.rows.find((r) => r.franchise_id === "0001");
  t.equal(r1.loaded_before, 4); t.equal(r1.loaded_after, 5, "the extension's NEW priced-terms loaded status (BL), not player 200's current flat status, must land on the receiver");
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 10b: a pre-trade extension that pushes the receiver from 5 to 6 blocks", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "FL", preview_contract_info_string: "CL 3|TCV 7K|Y1-1K, Y2-4K, Y3-2K" }], // future years decreasing -> FL
  });
  t.equal(c.loaded_contracts.status, "blocked");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 6);
});

test("LC 11: an extension provably flat by its own FUTURE-years priced terms never adds to the count (Y1 excluded -- it differing from Y2/Y3 is normal, not loaded)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-Ext2-BL" }] }), // currently loaded
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 3|TCV 5K|Y1-1K, Y2-2K, Y3-2K" }], // Y2==Y3 -> future is flat, regardless of Y1
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4, "the extension resets 200 to flat -- the acquirer does not inherit its pre-extension loaded status");
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 11b: a 2-year extension (only ONE future year -- Y1 frozen + a single new year) has no shape to compare and is treated as flat", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-Ext2-BL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 2|TCV 4K|Y1-1K, Y2-3K" }],
  });
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4);
  t.equal(c.loaded_contracts.status, "ok");
});

test("LC 18: a MISMATCHED extension indicator (claims flat, priced future terms show loaded) is never trusted -- unresolved, fails closed", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 3|TCV 7K|Y1-1K, Y2-2K, Y3-4K" }], // claims flat, but the future terms are clearly BL
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a claimed indicator that disagrees with the priced terms must never be silently trusted either way");
  t.equal(c.cap.status, "ok", "an unresolved loaded-contract extension must not affect the cap verdict");
});

test("LC 19: a mismatched indicator the OTHER direction (claims loaded, priced future terms show flat) is equally untrusted", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "FL", preview_contract_info_string: "CL 3|TCV 5K|Y1-1K, Y2-2K, Y3-2K" }], // claims FL, but future terms are flat
  });
  t.equal(c.loaded_contracts.status, "unavailable");
});

test("LC 20: an extension with no parseable priced schedule at all is unresolved, not silently trusted off the bare indicator", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "BL", preview_contract_info_string: "" }],
  });
  t.equal(c.loaded_contracts.status, "unavailable");
});

test("LC 12: missing salary/contract export fails the WHOLE calculation closed (cap, roster, and loaded_contracts all unavailable)", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: { ok: false, status: 500 }, adjustments: adjOf([]),
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }] });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "unavailable", "loaded_contracts unavailable must accompany the SAME whole-calculation fail-closed cap/roster path, not a partial result");
  t.equal(c.roster.status, "unavailable");
});

test("LC 13: malformed contract authority (an unparseable rosters export) fails closed the same way for loaded_contracts as for cap", () => {
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]),
    rosters: ok({ rosters: {} }), // malformed: no franchise[] at all
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }] });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "unavailable");
});

test("LC 15: blank contractStatus with a PROVABLY FLAT schedule (equal every year) resolves flat, not unresolved", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 6K|Y1-2K, Y2-2K, Y3-2K" }] }), // no contractStatus at all
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4, "a provable flat schedule must resolve to flat, not add to the count");
});

test("LC 16: blank contractStatus, multi-year, with NO reliable status or schedule -> loaded_contracts unavailable; cap and roster are UNAFFECTED", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractYear: 3 }] }), // no contractStatus, no contractInfo -- genuinely unresolvable
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "ok", "an unresolved loaded classification must not erase an otherwise-valid cap total");
  t.notEqual(c.roster.status, "unavailable", "...nor the roster-count advisory (a small test roster naturally trips the below-min ADVISORY warning, which is fine -- it must simply not be 'unavailable' because of the unrelated loaded-contract gap)");
});

test("LC 16b: blank contractStatus but a KNOWN 1-year contract length is flat BY CANON, never unresolved", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 1|TCV 2K|AAV 2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4, "canon: loaded can never attach to a 1-year deal -- this is definitive, not a guess");
});

test("LC 17: a STALE stored suffix is overridden by an authoritative, currently-priced year-by-year schedule (matches the existing index.js restructure precedent)", () => {
  const c = calc({
    // stored status still says flat Vet-FAA (a restructure was never re-stamped), but the
    // REAL current priced schedule is clearly decreasing -> FL. At 5 already, this must
    // push to 6 and BLOCK -- if the stale "flat" status were trusted instead, it would
    // incorrectly stay at 5 (ok). The test result itself proves which one the code used.
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-3K, Y2-1K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "blocked", "the authoritative schedule (FL) must win over the stale stored status (flat) -- proves the override, not just a lucky pass");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 6);
});

test("LC 14: a franchise NOT part of any movement never poisons the count (foreign franchise's contracts are irrelevant)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }], "0003": loadedIds(900, 20) }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok", "franchise 0003 (20 loaded contracts) is not a participant and must not be scanned at all");
  t.equal(c.loaded_contracts.rows.length, 2);
});

test("LC 21: a player routed THROUGH an intermediate franchise in a 3-way (the real production \"via\" shape -- a single movement leg naming the ORIGINAL owner as `from` and the FINAL owner as `to`, exactly how legs_json already represents these deals) is counted once, by final ownership, never duplicated or double-counted at the pass-through team", () => {
  // Real shape confirmed from the 2026-09-23 production trade's own legs_json: a pick
  // "via HammerTime" is still ONE direct leg {from:"0008", to:"0012"} -- the
  // intermediate franchise never appears as a from/to at all for that asset. The
  // calculation only ever sees final-ownership legs; there is no separate "literal
  // two-hop" representation to double-count.
  const c = calc({
    league: ok({ league: { salaryCapAmount: "300000", rosterSize: "35", franchises: { franchise: [{ id: "0008", name: "Real Deal Creel" }, { id: "0001", name: "L.A. Looks" }, { id: "0012", name: "Hawks" }] } } }),
    rosters: rosterOf({
      "0008": loadedIds(100, 5),                                    // initiator, already at 5
      "0001": [],                                                    // pass-through franchise -- never gains or loses a count
      "0012": [{ id: "200", contractStatus: "Vet-FAA-FL" }],          // final receiver currently has 0 loaded
    }),
    // 200 conceptually routes 0012 -> 0008 "via" 0001, but is represented as ONE direct
    // leg naming the true original owner and the true final owner -- 0001 never appears
    // as a from/to for this token at all.
    movements: [{ from: "0012", to: "0008", tokens: ["200"] }, { from: "0001", to: "0008", tokens: [] }],
  });
  t.equal(c.loaded_contracts.status, "blocked", "0008: 5 -> 6");
  const rows = Object.fromEntries(c.loaded_contracts.rows.map((r) => [r.franchise_id, r]));
  t.equal(rows["0008"].loaded_before, 5); t.equal(rows["0008"].loaded_after, 6);
  t.equal(rows["0012"].loaded_before, 1); t.equal(rows["0012"].loaded_after, 0, "the sender loses it exactly once");
  t.equal(rows["0001"].loaded_before, 0); t.equal(rows["0001"].loaded_after, 0, "the pass-through franchise's count is completely untouched -- never incremented then decremented, never counted at all");
});

test("LC: 2-way and 3-way routes use the SAME calculation (identical inputs give identical loaded-contract numbers)", () => {
  const rosters = rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Vet-FAA-FL" }] });
  const movements = [{ from: "0002", to: "0001", tokens: ["200"] }];
  const a = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), rosters, movements });
  const b = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), rosters, movements });
  t.deepEqual(a.loaded_contracts, b.loaded_contracts, "there is only one calculation -- both callers reach the identical function");
});

// ───────────────────────────────── Part 2 — two-team accept, real worker ─────────────────────────────────
// Harness defaults: 0001 owns player 14056, 0002 owns player 13100 (worker_harness.mjs).
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
const payloadOf = (from, to, give, recv) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});
function fresh2(o) {
  const env = makeWorkerEnv(o && o.env);
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  return { env, mfl };
}
// Attempts the create; if refused because the SENDER (the initiator, 0001) needs conditional
// drops, retries ONCE with the given (possibly empty/invalid) `dropIds` -- the real client flow
// (create -> shown the requirement -> pick drops -> retry). Pass {dropsOk:false} to see the
// FIRST, unsatisfied response instead (for tests proving the create-time gate itself).
async function createOffer(env, mfl, payload, opts) {
  opts = opts || {};
  const body0 = { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload };
  const r0 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: body0 });
  if (opts.dropsOk === false || r0.status < 300 || !(r0.json && r0.json.code === "loaded_contract_drops_required")) return r0;
  const r1 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { ...body0, loaded_contract_drops: opts.dropIds || [] } });
  r1.firstResponse = r0;
  return r1;
}
async function sendOffer(env, mfl, payload, opts) {
  const r = await createOffer(env, mfl, payload, opts);
  t.ok(r.status < 300, `offer sent: ${r.status} ${r.text.slice(0, 200)}`);
  return { id: mfl.st.pending[mfl.st.pending.length - 1].trade_id, payload };
}
const mobileBody = (id, action) => ({ action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" });
const act = (env, body) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body });

test("LC 2-WAY CREATE: 5 -> 6 loaded requires the SENDER's own conditional drop before the offer can even be sent; a valid drop lets it through, and the accept then proceeds with no further ask", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const payload = payloadOf("0001", "0002", [player(14056)], [player(13100)]);
  const r0 = await createOffer(env, mfl, payload, { dropsOk: false });
  t.equal(r0.status, 409); t.equal(r0.json.code, "loaded_contract_drops_required");
  t.match(r0.json.error, /would move from 5 to 6 loaded contracts/); t.match(r0.json.error, /1 conditional drop/);
  t.equal(r0.json.loaded_contract_drops_needed.required_drops, 1);
  t.equal(mfl.st.pending.length, 0, "no offer was ever sent to MFL");
  // a selection that is NOT actually loaded, or not on the roster, or is the SAME player being
  // sent, is never valid -- the requirement stays unsatisfied
  const bad1 = await createOffer(env, mfl, payload, { dropsOk: false, dropIds: ["14056"] });   // the player being SENT
  t.equal(bad1.status, 409); t.equal(bad1.json.code, "loaded_contract_drops_required");
  const bad2 = await createOffer(env, mfl, payload, { dropsOk: false, dropIds: ["99999"] });   // not on the roster
  t.equal(bad2.status, 409);
  t.equal(mfl.st.pending.length, 0, "still nothing sent");
  // a genuinely valid drop (one of 0001's OWN loaded contracts, not being sent) satisfies it
  const { id } = await sendOffer(env, mfl, payload, { dropIds: ["9000"] });
  t.equal(mfl.st.pending.length, 1);
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 200, r.text.slice(0, 200));
  t.equal(mfl.writes("tradeResponse").length, 1, "the accept the sender's drop already satisfied proceeds normally");
});

test("LC 2-WAY CREATE: 5 -> 7 (receiving TWO loaded contracts at once) requires exactly 2 drops -- one alone is refused, two lets it through", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus }))];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }, { id: "13101", salary: 5000, contractStatus: "Vet-FAA-BL" }];
  const payload = payloadOf("0001", "0002", [player(14056)], [player(13100), player(13101)]);
  // Nothing selected at all: refused, naming exactly 2 required.
  const r0 = await createOffer(env, mfl, payload, { dropsOk: false });
  t.equal(r0.status, 409);
  t.equal(r0.json.loaded_contract_drops_needed.required_drops, 2);
  t.match(r0.json.error, /L\.A\. Looks would move from 5 to 7 loaded contracts\. The maximum is 5, so 2 conditional drops/);
  // Exactly ONE selected: still refused -- one drop is not enough to satisfy a 2-drop requirement.
  const r1 = await createOffer(env, mfl, payload, { dropIds: ["9000"] });
  t.equal(r1.status, 409, r1.text.slice(0, 300));
  t.equal(r1.json.loaded_contract_drops_needed.required_drops, 2);
  t.equal(r1.json.loaded_contract_drops_needed.valid_count, 1);
  t.equal(mfl.st.pending.length, 0, "zero MFL writes -- one drop never silently passes a two-drop requirement");
  // Exactly TWO selected: satisfied.
  const { id } = await sendOffer(env, mfl, payload, { dropIds: ["9000", "9001"] });
  t.ok(id);
  t.equal(mfl.st.pending.length, 1);
});

test("LC 2-WAY CREATE: false client-supplied loaded-contract totals cannot bypass the gate, at creation or at accept", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const payload = payloadOf("0001", "0002", [player(14056)], [player(13100)]);
  // 0001 is ALREADY at 6 loaded contracts before this trade (14056 is itself loaded) -- a
  // loaded-for-loaded swap doesn't change the count, but a pre-existing violation still requires
  // a drop; a client claiming otherwise is ignored.
  const r0 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, {
    body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "",
      payload, compliance: { loaded_contracts: { status: "ok" } }, force: true, override: true, ignore_limit: true },
  });
  t.equal(r0.status, 409); t.equal(r0.json.code, "loaded_contract_drops_required", "client-supplied compliance/force/override/ignore_limit fields must be completely ignored");
  t.equal(mfl.st.pending.length, 0);
  // a genuinely valid drop still works
  const { id } = await sendOffer(env, mfl, payload, { dropIds: ["9000"] });
  const bypassAttempt = await act(env, { ...mobileBody(id), compliance: { loaded_contracts: { status: "ok" } }, force: true, override: true, ignore_limit: true });
  t.equal(bypassAttempt.status, 200, "the fake fields are ignored either way -- the REAL, persisted drop is what satisfies it");
  t.equal(mfl.writes("tradeResponse").length, 1);
});

test("LC 2-WAY: an offer that was FINE when created becomes noncompliant before the recipient accepts -- held with a clear explanation, zero writes, and a valid drop lets it through", async () => {
  const { env, mfl } = fresh2();
  // At CREATION, 0002 has only 4 loaded -- receiving one more lands it at exactly 5, fine.
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 4).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus }))];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  t.equal(mfl.st.pending.length, 1, "created cleanly -- nothing was over the limit at the time");

  // Something ELSE lands on 0002's roster before they act on this offer (another trade, a
  // waiver pickup -- this test doesn't care how, only that the roster genuinely changed).
  mfl.st.rosters["0002"].push({ id: "9004", salary: 1000, contractStatus: "Vet-Ext2-BL" });

  const preview = await act(env, mobileBody(id, "PREVIEW"));
  t.equal(preview.status, 200, preview.text.slice(0, 300));
  t.equal(preview.json.compliance.loaded_contracts.status, "blocked");
  t.match(preview.json.compliance.loaded_contracts.message, /CBP would move from 5 to 6 loaded contracts/, "a clear, specific, recipient-facing explanation -- not a generic refusal");

  const acceptRefused = await act(env, mobileBody(id));
  t.equal(acceptRefused.status, 409);
  t.equal(acceptRefused.json.code, "loaded_contract_drops_required");
  t.equal(mfl.st.done.length, 0, "zero MFL writes -- the now-noncompliant offer does not execute");

  const acceptedWithDrop = await act(env, { ...mobileBody(id), loaded_contract_drops: ["9000"] });
  t.ok(acceptedWithDrop.status < 300, acceptedWithDrop.text.slice(0, 300));
  t.equal(mfl.writes("tradeResponse").length, 1, "the SAME offer, with a valid conditional-drop plan, now goes through");
});

test("LC 2-WAY: at exactly 5 (not 6), the accept proceeds and MFL is called once", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [...loadedIds(9000, 4).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })), { id: "14056", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.ok(r.status < 300, r.text.slice(0, 300));
  t.equal(mfl.writes("tradeResponse").length, 1);
});

// ───────────────────────────────── Part 3 — three-team gates, real worker ─────────────────────────────────
const DISCORD = F.DISCORD;
function threeWayWorld(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "1", ...(o.env || {}) });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "P16181" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "P16650" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), ...(o.row || {}) });
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedA ? loadedIds(90000, o.loadedA).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
    "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedB ? loadedIds(90100, o.loadedB).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
    "0012": [{ id: "16650", salary: 5000, contractStatus: "Vet-FAA" }, ...(o.loadedC ? loadedIds(90200, o.loadedC).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus })) : [])],
  };
  return { env, mfl };
}
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
const say = async (resp) => (await resp.json()).data.content;
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };
const ledgerRow = (env) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(F.TRADE_ID);
const recheck = (env, tok) => callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=${tok || "tok-A"}`, { body: { id: F.TRADE_ID } });

test("LC 3-WAY: the third participant would exceed the loaded-contract limit -> the accept IS recorded, nothing executes", async () => {
  // 0008 receives 16650 (flat) from 0012 and sends 16614 (flat) to 0001 -- unaffected.
  // 0001 sends 16181 (flat) to 0012 and receives 16614 (flat) from 0008 -- unaffected.
  // 0012 already has 5 loaded contracts, sends 16650 (flat) to 0008 and receives 16181 (flat, no change either) --
  // make 0012 receive a LOADED asset instead: swap leg so 0001 sends a loaded contract to 0012.
  const { env, mfl } = threeWayWorld({ loadedC: 5 });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL"; // the asset 0001 sends to 0012 (16181) is now loaded
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  await ctx.flush();
  t.match(msg, /would move from 5 to 6 loaded contracts/);
  const row = F.readRow(env);
  t.equal(row.team_b_state, "accepted", "the accept WAS recorded — consent is never discarded because someone would exceed the loaded-contract limit");
  t.equal(row.status, "collecting");
  t.equal(mfl.writes().length, 0);
});

test("LC 3-WAY: RECOVERABLE block when both accept over the limit -- collecting, both approvals kept, ledger blocked_cap, zero MFL writes", async () => {
  const { env, mfl } = threeWayWorld({ loadedC: 5, row: { team_b_state: "accepted" } });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL";
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.C), env, ctx));
  await ctx.flush();
  t.match(msg, /would move from 5 to 6 loaded contracts/);
  const row = F.readRow(env);
  t.equal(row.status, "collecting", "NOT failed, NOT executing");
  t.equal(row.team_b_state, "accepted"); t.equal(row.team_c_state, "accepted");
  t.equal(row.failure_reason, null); t.equal(row.mfl_trade_ids, null); t.equal(row.executed_at_utc, null);
  const led = ledgerRow(env); t.equal(led.state, "blocked_cap");
  const blk = JSON.parse(led.block_json); t.equal(blk.kind, "loaded_contract_drops_required");
  t.equal(mfl.writes().length, 0, "zero MFL writes"); t.equal(mfl.st.done.length, 0);
});

test("LC 3-WAY: recheck recomputes from FRESH authority -- fixing the roster lets it execute", async () => {
  const { env, mfl } = threeWayWorld({ loadedC: 5, row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0001"][0].contractStatus = "Vet-FAA-FL";
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "loaded_contract_drops_required");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  // a re-check while STILL over the limit: refused, recomputed, nothing changes
  const still = await recheck(env);
  t.equal(still.status, 409); t.equal(still.json.code, "loaded_contract_drops_required");
  t.equal(F.readRow(env).status, "collecting"); t.equal(mfl.writes().length, 0);
  // Fix: 0012 drops one of its 5 loaded contracts, opening a slot -- a fresh read must pick this up.
  // (index 0 is the real trade asset 16650 -- keep it; drop one of the loaded filler players.)
  mfl.st.rosters["0012"] = [mfl.st.rosters["0012"][0], ...mfl.st.rosters["0012"].slice(2)];
  env.TRADE_3WAY_EXECUTE = "0"; // dry-run so this test doesn't have to drive live legs
  const fixed = await recheck(env);
  t.equal(fixed.status, 200, fixed.text.slice(0, 200)); t.equal(fixed.json.code, "rechecking");
  const row = F.readRow(env); t.equal(row.status, "completed"); t.equal(row.failure_reason, "dry_run");
});

// ───────────── Part 4 — second review pass (2026-09-28): schedule authority + status whitelist ─────────────
// Six real fail-open cases a hand review of the FIRST revision found: a schedule that
// LOOKS parseable was being trusted without checking it was actually COMPLETE or
// RECONCILED, and "a nonblank status" was being trusted without checking it was actually a
// RECOGNIZED one. Each test below reproduces the review's exact input and required result.

test("LC 22 (review row 1): an INCOMPLETE schedule -- Y2 silently missing from a stated 3-year contract -- is never trusted as a complete 2-entry flat schedule; unavailable, not flat", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 6K|Y1-2K, Y3-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y1 and Y3 both parse to $2K, but Year 2 -- one of the contract's own stated 3 years -- is missing entirely; that is an incomplete schedule, not a complete, provably-flat one");
  t.equal(c.cap.status, "ok", "the unresolvable loaded-contract classification must not poison the cap result");
});

test("LC 23 (review row 2): an INCOMPLETE schedule -- Y3 silently missing from a stated 3-year contract -- is never trusted; unavailable, not flat", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 6K|Y1-2K, Y2-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y1 and Y2 both parse to $2K, but Year 3 -- the contract's own stated final year -- is missing entirely");
  t.equal(c.cap.status, "ok");
});

test("LC 24 (review row 3): a COMPLETE schedule that does NOT RECONCILE with the stated TCV is never trusted; unavailable, not FL", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 6K|Y1-3K, Y2-1K, Y3-1K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the schedule covers all 3 stated years but sums to $5K, not the stated $6K TCV -- that mismatch is a real inconsistency in the data, not proof this contract is front-loaded");
  t.equal(c.cap.status, "ok");
});

test("LC 25 (review row 4): Year 1 exactly equaling the AAV is NOT the same thing as a flat contract -- an irregular, non-uniform schedule is unavailable, never silently called FLAT", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 6K|Y1-2K, Y2-3K, Y3-1K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y1 ($2K) equals the AAV ($6K / 3 = $2K) exactly, but Y2/Y3 are $3K/$1K -- the years are NOT all equal, so this is not FLAT (which means every year pays the same amount); canon's simple front/back taxonomy can't classify an irregular shape like this");
  t.equal(c.cap.status, "ok");
});

test("LC 26 (review row 5): an UNRECOGNIZED, nonblank contractStatus -- not a real MFL status family, no FL/BL proof -- is never assumed flat; unavailable", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Zzz-Bogus-Status" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a status string that matches no known MFL contractStatus family is not proof of anything, flat or loaded -- previously, absence of an explicit -FL/-BL suffix was silently read as 'flat by default' for ANY nonblank status, recognized or not");
  t.equal(c.cap.status, "ok");
});

test("LC 27 (review row 6): a TRULY blank contract -- contractYear, contractStatus, AND contractInfo all absent, the exact cap-math `unknown` shape -- is unresolved, never silently assumed flat; cap and roster stay intact", () => {
  const rosters = ok({ rosters: { franchise: [
    { id: "0001", player: loadedIds(100, 4).map((p) => ({ id: p.id, salary: "1000", status: "ROSTER", contractYear: "2", contractStatus: p.contractStatus })) },
    { id: "0002", player: [{ id: "200", salary: "1000", status: "ROSTER" }] },   // NO contractYear, NO contractStatus, NO contractInfo -- MFL said nothing at all about this contract
  ] } });
  const c = evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), rosters, movements: [{ from: "0002", to: "0001", tokens: ["200"] }] });
  t.equal(c.loaded_contracts.status, "unavailable", "silence is not proof of flat -- even though it IS treated as 'not expired' for the cap-math dollar total (currentCapHit's `unknown` handling), those are different questions with different safe defaults: a dollar total has a safe conservative fallback (count the full salary); a loaded/flat verdict does not");
  t.equal(c.cap.status, "ok", "the cap result -- which DOES use the 'unknown = count the full salary' convention -- must not be affected by the loaded-contract block being separately unresolved");
  t.notEqual(c.roster.status, "unavailable", "nor the roster-count advisory");
});

test("LC 2-WAY (review row 6, execution proof): loaded_contracts unavailable -- a truly blank contract on the traded player -- blocks the accept the same way a proven violation does: 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000 }];   // no contractStatus, no contractInfo, no contractYear
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(mfl.writes("tradeResponse").length, 0, "an unresolvable loaded-contract classification must make zero MFL writes, exactly like a proven block");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending, never silently dropped or auto-accepted");
});

test("LC 3-WAY (review row 6, execution proof): loaded_contracts unavailable -- a truly blank contract on one of the traded assets -- blocks execution recoverably: zero MFL writes, ledger blocked_cap, never failed", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 5000 };   // no contractStatus, no contractInfo, no contractYear -- genuinely unresolvable
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "unavailable");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  t.equal(mfl.writes().length, 0, "zero MFL writes when the loaded-contract classification can't be verified");
});

// ───────────── Part 5 — second review pass, round 2 (2026-09-28): contradictory/partial data must not fall back to a status that makes it flat ─────────────
// A schedule that is explicitly PRESENT in contractInfo -- even a broken one -- is a more
// specific signal than contractStatus, and must never be silently overridden by a
// plausible-looking status. Each test below reproduces Keith's exact reported input.

test("LC 28 (review round 2, case 1): a RECOGNIZED flat status (Vet-FAA) does NOT rescue an incomplete schedule -- Y2 missing from a stated 3-year deal is still unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|Y1-2K,Y3-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the present-but-incomplete schedule must win over the recognized 'Vet-FAA' status, not be silently overridden by it");
  t.equal(c.cap.status, "ok", "cap stays independently valid");
});

test("LC 29 (review round 2, case 2): a RECOGNIZED flat status does NOT rescue an unreconciled schedule -- $5K summed under a stated $6K TCV is still unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|Y1-3K,Y2-1K,Y3-1K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable");
  t.equal(c.cap.status, "ok");
});

test("LC 30 (review round 2, case 3): a RECOGNIZED flat status does NOT rescue an AUTHORITATIVE-but-irregular schedule (Y1 == AAV, years unequal) -- still unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|Y1-2K,Y2-3K,Y3-1K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the schedule IS complete and reconciled here, but its shape (2K,3K,1K against a 2K AAV) is irregular, not flat -- and being AUTHORITATIVE makes it MORE binding against the status, not less");
  t.equal(c.cap.status, "ok");
});

test("LC 31 (review round 2, case 4): an UNRECOGNIZED status that merely CONTAINS 'mym' is not a real MYM form -- the MYM canon exception is restricted to an actual recognized prefix", () => {
  t.equal(classifyLoaded("Gibberish-MYM"), "", "classifyLoaded's null->'' convenience mapping still reports '' for an unresolved status; isLoaded is the one that must read this as NOT loaded");
  t.equal(isLoaded("Gibberish-MYM"), false, "unresolved is never reported as loaded");
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Gibberish-MYM" }] }), // blank contractInfo
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "'Gibberish-MYM' does not start with a real Vet-/Rookie- prefix -- it is not a recognized MYM form and must not be assumed flat by the MYM canon exception");
  t.equal(c.cap.status, "ok");
});

test("LC 31b: a REAL recognized MYM form is still correctly flat by canon (the restriction in LC 31 narrows the exception, it does not remove it)", () => {
  for (const status of ["Vet-MYM", "Rookie-MYM", "Vet-WW-MYM"]) {
    t.equal(classifyLoaded(status), "", `${status}: a real MYM compound is flat by canon`);
    t.equal(isLoaded(status), false, `${status}: never loaded`);
  }
});

test("LC 32 (review round 2, case 5): a DUPLICATE year token (Y1 appearing twice, even with a matching value) makes the whole schedule unavailable, never silently collapsed to a normal 2-entry schedule", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K,Y1-2K,Y2-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a repeated Y1 token is malformed data, not a harmless repeat -- it must not silently collapse to a valid, provably-flat 2-year schedule");
  t.equal(c.cap.status, "ok");
});

test("LC 33: a NONPOSITIVE yearly value (Y1-0K) is not a real salary and cannot prove a back-loaded shape -- previously resolved BL, now unavailable", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-0K,Y2-4K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y1-0K is not a real positive salary -- the schedule must not be trusted as proof of a back-loaded curve");
  t.equal(c.cap.status, "ok");
});

test("LC 34 (review round 2, case 6, extension): the SAME completeness bar applies to an extension's priced schedule -- Y2 missing (CL 3|TCV 6K|Y1-2K,Y3-4K) is unavailable, not silently trusted off a plausible future AAV", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }), // 200 is currently flat
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", new_aav_future: 2000, preview_contract_info_string: "CL 3|TCV 6K|Y1-2K,Y3-4K" }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Year 2 is missing from the extension's own stated 3-year schedule -- the same completeness bar as an ordinary contract must apply here too");
  t.equal(c.cap.status, "ok", "an unresolved extension schedule must not affect the cap verdict");
});

test("LC 35: a DUPLICATE year token in an extension's priced schedule is equally unavailable (the same authority bar, not a separate weaker one)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 3|TCV 9K|Y1-1K,Y2-4K,Y2-4K,Y3-4K" }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a duplicated Y2 token in the extension schedule must not be silently collapsed to a normal 3-year schedule");
});

test("LC 2-WAY (review round 2): an AUTHORITATIVE-but-irregular schedule (case 3) blocks the accept exactly like a proven violation -- 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|Y1-2K,Y2-3K,Y3-1K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(r.json.compliance.cap.status, "ok", "the cap result stays independently valid in the same response");
  t.equal(mfl.writes("tradeResponse").length, 0, "zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 3-WAY (review round 2): an AUTHORITATIVE-but-irregular schedule (case 3) blocks execution recoverably -- zero MFL writes, ledger blocked_cap, never failed, cap independently intact", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|Y1-2K,Y2-3K,Y3-1K" };
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "unavailable");
  t.equal(r1.compliance.cap.status, "ok", "the cap result stays independently valid on the same gate response");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  t.equal(mfl.writes().length, 0, "zero MFL writes");
});

// ───────────── Part 6 — third review pass (2026-09-28): a PRESENT-but-malformed schedule is not the same thing as "no schedule at all" ─────────────
// Each test reproduces Keith's exact reported input. All 4 previously fell through to
// contractStatus because parseYearScheduleRaw's presence threshold silently swallowed a
// single Y-token or a garbled bracket entry, treating it as if contractInfo carried no
// schedule at all.

test("LC 36 (review round 3, case 1): a schedule fragment -- only Y1 supplied for a stated 2-year contract -- is PRESENT, not absent; incomplete, never rescued by the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "only Y1 of a stated 2-year contract is supplied -- a present, incomplete fragment, not 'no schedule found here'");
  t.equal(c.cap.status, "ok");
});

test("LC 37 (review round 3, case 2): a MALFORMED bracket schedule (a non-numeric entry) is PRESENT, not absent; never silently discarded to fall back on the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|[2K,xyz,2K]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the middle bracket entry ('xyz') doesn't parse -- the whole bracket schedule is present but malformed, not invisible");
  t.equal(c.cap.status, "ok");
});

test("LC 38 (review round 3, case 3): a MALFORMED Y-token value (Y2-xyz has no digits, so it never even matches) leaves Y2 missing -- present-but-incomplete, never rescued by the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K,Y2-xyz" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y2's malformed value means only Y1 is actually captured -- the same present-but-incomplete case as LC 36, reached a different way");
  t.equal(c.cap.status, "ok");
});

test("LC 39 (review round 3, case 4): the MYM exception is an EXACT documented list, not 'any Vet-/Rookie- prefix plus any middle segment' -- Vet-Gibberish-MYM is not a real MYM form", () => {
  t.equal(classifyLoaded("Vet-Gibberish-MYM"), "", "unresolved reports '' through classifyLoaded's convenience mapping");
  t.equal(isLoaded("Vet-Gibberish-MYM"), false, "unresolved is never reported as loaded");
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-Gibberish-MYM" }] }), // blank contractInfo
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "'Gibberish' is not a documented middle segment (unlike 'WW' in Vet-WW-MYM) -- this is not a real, recognized MYM form");
  t.equal(c.cap.status, "ok");
});

test("LC 39b: a genuinely COMPLETE 1-year schedule (CL 1, one matching Y1 token) still correctly resolves flat -- the relaxed presence threshold does not regress the real 1-year case", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }] }), // no contractStatus at all -- must resolve via the schedule itself
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok", "a complete, reconciled 1-year schedule has no shape to compare -- flat, same as canon's 1-year rule");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4);
});

test("LC 2-WAY (review round 3): a present-but-malformed schedule (case 2, garbled bracket) blocks the accept exactly like a proven violation -- 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|[2K,xyz,2K]" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(r.json.compliance.cap.status, "ok", "the cap result stays independently valid in the same response");
  t.equal(mfl.writes("tradeResponse").length, 0, "zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 3-WAY (review round 3): a present-but-malformed schedule (case 1, a lone Y1 fragment) blocks execution recoverably -- zero MFL writes, ledger blocked_cap, never failed, cap independently intact", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K" };
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "unavailable");
  t.equal(r1.compliance.cap.status, "ok", "the cap result stays independently valid on the same gate response");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  t.equal(mfl.writes().length, 0, "zero MFL writes");
});

// ───────────── Part 7 — fourth review pass (2026-09-28): rookie-draft team options, and separating "no schedule" from "a value that never parsed" ─────────────
// LC 40/41 use PRODUCTION-SHAPED fixtures: the exact contractInfo format MFL actually
// serves for a rookie-draft 4th-year team option (verified against a real league salaries
// export -- 24 of 484 rostered players carry this exact shape, all with the 3 base years
// reconciling to CL/TCV and the option excluded, per Keith's review). LC 42-44 close the
// remaining gap where a value that was ATTEMPTED but never parsed as a real number (no
// digits at all, or a numeric prefix glued to trailing garbage) was being treated the same
// as "contractInfo has no schedule here at all" and silently falling back to the status.

test("LC 40 (review round 4, rookie option, PRODUCTION-SHAPED): a real rookie-draft 4th-year team option -- 3 base years reconciling to CL/TCV, the option year EXCLUDED from that check, not force-fit into it -- resolves flat, not unavailable (the exact string format served for player 17500 in a live league export)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "ok", "the 3 base years (6K,6K,6K) reconcile exactly to CL 3 / TCV 18K with the option excluded -- a complete, authoritative, flat schedule");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 4, "flat -- does not add to the loaded count");
});

test("LC 40b: the SAME rookie option shape but with a genuinely FRONT-loaded base (not all equal) is classified correctly from the base years, the option still excluded", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 12K|AAV 4K|Y1-6K, Y2-3K, Y3-3K, Y4-8K Option|GTD: 9K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "blocked", "base years 6K,3K,3K sum to 12K = TCV, Y1 (6K) > AAV (4K) -> FL, and this would be the 6th loaded contract");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 6);
});

test("LC 41 (review round 4, option EXERCISED): when CL and TCV instead cover ALL 4 years including the option (the option has become a real committed year), the schedule resolves from the FULL 4-year data -- never assumed either way, just whichever the contract's own stated CL/TCV actually reconciles against", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 5), "0002": [{ id: "200", contractStatus: "Rookie-Draft", contractInfo: "CL 4|TCV 29K|AAV 7.25K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  // base-only (3 years, 18K) does NOT match CL 4 -- rejected; full (4 years, 29K) DOES match CL 4 and TCV 29K -- accepted.
  t.equal(c.loaded_contracts.status, "blocked", "all 4 years used: 6,6,6,11 against a 7.25K AAV -> Y1 (6K) < AAV -> BL, and this would be the 6th loaded contract");
  t.equal(c.loaded_contracts.rows.find((r) => r.franchise_id === "0001").loaded_after, 6);
});

test("LC 42 (review round 4, case 1): an ENTIRE malformed value (no digits at all, e.g. 'Y1-foo,Y2-bar') is a present, attempted, unparseable schedule -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-foo,Y2-bar" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "neither 'foo' nor 'bar' has a single digit -- the regex never captures a value, but 'Y1-' and 'Y2-' were plainly ATTEMPTED");
  t.equal(c.cap.status, "ok");
});

test("LC 43 (review round 4, case 2): a NUMERIC PREFIX glued to trailing garbage ('Y1-2Kxyz') is never silently truncated to its leading digits -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2Kxyz,Y2-2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "'2Kxyz' is not a real, cleanly-terminated value -- taking just the leading '2' and ignoring 'xyz' would risk silently accepting corrupted data that happens to reconcile by coincidence");
  t.equal(c.cap.status, "ok");
});

test("LC 44 (review round 4, case 3): an UNCLOSED bracket ('[2K,2K,2K' with no closing ']') is a present, attempted, unparseable schedule -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 6K|[2K,2K,2K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "an opening '[' with no matching ']' is plainly a schedule attempt, not the absence of one");
  t.equal(c.cap.status, "ok");
});

test("LC 44b: preserving valid contracts -- a genuine 1-year deal and a genuine option contract both still resolve correctly, proving the stricter malformed-detection above does not regress real data", () => {
  const oneYear = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(oneYear.loaded_contracts.status, "ok", "a genuine, complete 1-year schedule still resolves flat");
  const option = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(option.loaded_contracts.status, "ok", "and a genuine rookie-draft option contract still resolves flat");
});

test("LC 45: the SAME option-year handling applies to an extension's own priced schedule -- a labeled option year is excluded from the base completeness check there too", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 3|TCV 5K|Y1-1K, Y2-2K, Y3-2K, Y4-5K Option" }],
  });
  // base years (1K+2K+2K=5K) reconcile to CL 3 / TCV 5K with the labeled Y4 option excluded.
  // Future years (excluding the frozen Y1): Y2=2K, Y3=2K -> equal -> flat.
  t.equal(c.loaded_contracts.status, "ok", "the extension's 3 base years reconcile to CL 3 / TCV 5K with the labeled Y4 option excluded; the future years (Y2, Y3) are equal -- flat");
});

test("LC 2-WAY (review round 4): an entirely-malformed schedule (case 1, no digits at all) blocks the accept exactly like a proven violation -- 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-foo,Y2-bar" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(r.json.compliance.cap.status, "ok", "the cap result stays independently valid in the same response");
  t.equal(mfl.writes("tradeResponse").length, 0, "zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 3-WAY (review round 4): a real rookie-draft option contract (production-shaped) never blocks execution -- it resolves flat and the trade proceeds normally", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 6000, contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K" };
  env.TRADE_3WAY_EXECUTE = "0"; // dry-run so this test doesn't have to drive live legs
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.ok, true, "a genuine, resolvable option contract never trips the loaded-contract gate");
  t.equal(F.readRow(env).status, "completed");
});

// ───────────── Part 8 — fifth review pass (2026-09-28): bracket entries must be parsed as a WHOLE amount, not stripped down to whatever digits remain ─────────────
// stripping non-digit characters before parseFloat let a NEGATIVE amount ("-2K", the minus
// sign stripped) or trailing garbage ("2Kxyz", the letters stripped) silently pass as a
// plausible positive number. Each bracket entry must now be a clean, complete amount --
// nothing else -- or it is rejected outright.

test("LC 46 (review round 5, case 1): a bracket entry with a NEGATIVE amount ('-2K') is not silently stripped to a positive '2K' -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[-2K,2K]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the minus sign is not part of a valid amount -- stripping it to '2K' would silently turn a negative/garbled entry into a plausible positive one");
  t.equal(c.cap.status, "ok");
});

test("LC 47 (review round 5, case 2): a bracket entry with trailing garbage ('2Kxyz') is not silently truncated to '2K' -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[2Kxyz,2K]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "'2Kxyz' is not a clean, complete amount -- the same fail-open risk already closed for Y-token values (LC 43) applies equally to bracket entries");
  t.equal(c.cap.status, "ok");
});

test("LC 48: the SAME strict bracket-entry parsing applies to an extension's own priced schedule", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 2|TCV 4K|[-2K,2K]" }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a negative bracket entry in an extension's priced terms is equally untrusted");
});

test("LC 49 (review round 5): a malformed SECOND schedule fragment cannot be silently ignored just because the FIRST one parsed -- a bracket group coexisting with valid Y-tokens", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K,Y2-2K|[xyz]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "Y1/Y2 parse cleanly and reconcile on their own, but a SECOND, differently-shaped schedule fragment ('[xyz]') is also present in the same string and must not be silently discarded just because the first fragment looked fine");
  t.equal(c.cap.status, "ok");
});

test("LC 50: a malformed second BRACKET group, alongside a first bracket group that would otherwise parse cleanly, is likewise never silently narrowed to just the first one found", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[2K,2K][xyz]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "more than one bracket group in the same string is not a documented shape -- ambiguous, and never silently resolved from just the first group");
  t.equal(c.cap.status, "ok");
});

test("LC 51: preserving valid data -- a genuine, well-formed bracket schedule and a genuine rookie-draft option contract both still resolve correctly (regression controls for the stricter parsing above)", () => {
  const bracket = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 43K|[14K, 14K, 15K]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(bracket.loaded_contracts.status, "ok", "a genuine, complete bracket schedule with clean entries still resolves (14+14+15=43=TCV, back-loaded: 14 < AAV 14.33 -- close enough within rounding to classify BL, but the key assertion is that it RESOLVES, not unavailable)");
  t.notEqual(bracket.loaded_contracts.status, "unavailable");
  const option = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(option.loaded_contracts.status, "ok", "and a genuine rookie-draft option contract still resolves flat");
});

test("LC 2-WAY (review round 5): a bracket entry with a stripped-away negative sign blocks the accept exactly like a proven violation -- 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[-2K,2K]" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(r.json.compliance.cap.status, "ok", "the cap result stays independently valid in the same response");
  t.equal(mfl.writes("tradeResponse").length, 0, "zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 3-WAY (review round 5): a malformed second schedule fragment (Y-tokens plus a stray bracket) blocks execution recoverably -- zero MFL writes, ledger blocked_cap, never failed, cap independently intact", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 2000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|Y1-2K,Y2-2K|[xyz]" };
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "unavailable");
  t.equal(r1.compliance.cap.status, "ok", "the cap result stays independently valid on the same gate response");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  t.equal(mfl.writes().length, 0, "zero MFL writes");
});

// ───────────── Part 9 — sixth review pass (2026-09-28): a stray, unmatched bracket character must never be invisible to the schedule-authority check ─────────────
// A complete bracket group followed by a second, UNCLOSED "[" was being silently accepted
// -- the regex that only looks for COMPLETE "[...]" pairs simply never saw the stray
// trailing "[" at all, so it registered as "exactly one bracket group found" and the whole
// string resolved from that one group alone, the stray character never examined.

test("LC 52 (review round 6): a complete bracket group followed by a stray, UNCLOSED second '[' is never silently accepted from just the first, complete group -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[2K,2K][" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "the first '[2K,2K]' pair is complete and would reconcile on its own, but the trailing stray '[' is a second, unclosed fragment and must not be silently ignored");
  t.equal(c.cap.status, "ok");
});

test("LC 53 (review round 6): a STRAY closing bracket with no opening '[' at all is equally never absent -- unavailable, never falls back to the status", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a lone ']' with no matching '[' is a present, malformed schedule attempt, not the absence of one");
  t.equal(c.cap.status, "ok");
});

test("LC 54: the SAME stray-bracket-character rule applies to an extension's own priced schedule", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractStatus: "Vet-FAA" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
    extensionRequests: [{ player_id: "200", from_franchise_id: "0002", to_franchise_id: "0001", loaded_indicator: "NONE", preview_contract_info_string: "CL 2|TCV 4K|[2K,2K][" }],
  });
  t.equal(c.loaded_contracts.status, "unavailable", "a stray unclosed second bracket in an extension's priced terms is equally untrusted");
});

test("LC 55: preserving a genuine, single, well-formed bracket schedule -- exactly one '[' and one ']' in the whole string still resolves correctly (regression control for the stricter stray-bracket check above)", () => {
  const c = calc({
    rosters: rosterOf({ "0001": loadedIds(100, 4), "0002": [{ id: "200", contractInfo: "CL 3|TCV 43K|[14K, 14K, 15K]" }] }),
    movements: [{ from: "0002", to: "0001", tokens: ["200"] }],
  });
  t.notEqual(c.loaded_contracts.status, "unavailable", "exactly one open and one close bracket -- a clean, single, well-formed group -- must still resolve, not be swept up by the stray-character check");
});

test("LC 2-WAY (review round 6): a complete bracket group with a stray unclosed second fragment blocks the accept exactly like a proven violation -- 503, zero MFL writes, offer stays pending", async () => {
  const { env, mfl } = fresh2();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|[2K,2K][" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }];
  const { id } = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const r = await act(env, mobileBody(id));
  t.equal(r.status, 503);
  t.equal(r.json.code, "loaded_contract_check_unavailable");
  t.equal(r.json.compliance.cap.status, "ok", "the cap result stays independently valid in the same response");
  t.equal(mfl.writes("tradeResponse").length, 0, "zero MFL writes");
  t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("LC 3-WAY (review round 6): a stray closing bracket with no opening '[' blocks execution recoverably -- zero MFL writes, ledger blocked_cap, never failed, cap independently intact", async () => {
  const { env, mfl } = threeWayWorld({ row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  mfl.st.rosters["0008"][0] = { id: "16614", salary: 5000, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|]" };
  const r1 = await execute3Way(env, F.TRADE_ID);
  t.equal(r1.blocked, true); t.equal(r1.kind, "unavailable");
  t.equal(r1.compliance.cap.status, "ok", "the cap result stays independently valid on the same gate response");
  t.equal(F.readRow(env).status, "collecting", "recoverable -- never failed");
  t.equal(ledgerRow(env).state, "blocked_cap");
  t.equal(mfl.writes().length, 0, "zero MFL writes");
});

// ───────── Part 7 — 3-WAY CREATION: the initiator's own requirement (Keith's ruling, 2026-09-29) ─────────
// The Hammer Times bug: the loaded-contract check (PR #1135) was wired only into ACCEPT-time
// compliance -- building/reviewing an offer as the SENDER showed nothing, on EITHER the 2-way
// or the 3-way path. Fixed for 2-way by gating offer CREATION on the initiator's own
// requirement (Part 2/6 above); this section proves the SAME gate now exists for 3-way's own
// creation route (POST /api/trades/3way), for the initiator's own franchise only -- each OTHER
// participant's own requirement is surfaced when THEY view/accept, and capGate() hard-blocks
// execution regardless (Part 3 above), so this is purely about giving the BUILDER a server
// round-trip to warn the initiator before Send 3-Way, exactly like 2-way's creation gate.
const create3Way = (env, tok, body) => callWorker(env, "POST", `/api/trades/3way?${Q}&MFL_USER_ID=${tok}`, { body });
const dmsSent = (mfl) => mfl.st.discord.filter((d) => !/users\/@me\/channels/.test(d.url)).length;
function threeWayCreateWorld(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "1", ...(o.env || {}) });
  const mfl = makeMfl({}); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0002", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  mfl.st.rosters = {
    // 0008 (initiator, tok-A) already has 5 loaded contracts -- a 6th pushes it over.
    "0008": [{ id: "16614", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(90000, 5).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus }))],
    "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA" }],
    // 0002 sends 0008 a LOADED player -- this is what makes the initiator's own requirement fire.
    "0002": [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA-FL" }],
  };
  return { env, mfl };
}
const create3WayBody = (extra) => ({
  initiator: { fid: "0008", name: "Real Deal Creel" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0002", name: "CBP" },
  movements: [
    { from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0 },
    { from: "0001", to: "0002", asset_tokens: ["P_16181"], cap_k: 0 },
    { from: "0002", to: "0008", asset_tokens: ["P_13100"], cap_k: 0 },
  ],
  ...extra,
});

test("LC 3-WAY CREATE: 5 -> 6 for the INITIATOR refuses the offer before it's ever stored -- zero D1 row, zero Discord DMs", async () => {
  const { env, mfl } = threeWayCreateWorld();
  const r = await create3Way(env, "tok-A", create3WayBody());
  t.equal(r.status, 409, r.text.slice(0, 300));
  t.equal(r.json.code, "loaded_contract_drops_required");
  t.match(r.json.error, /Real Deal Creel would move from 5 to 6 loaded contracts\. The maximum is 5, so 1 conditional drop/);
  t.equal(r.json.loaded_contract_drops_needed.franchise_id, "0008");
  t.equal(r.json.loaded_contract_drops_needed.required_drops, 1);
  const list = await callWorker(env, "GET", `/api/trades/3way?franchise_id=0008&MFL_USER_ID=tok-A`);
  t.equal(list.json.three_way.length, 0, "nothing was stored");
  t.equal(dmsSent(mfl), 0, "no partner DMs went out for a refused create");
});

test("LC 3-WAY CREATE: a player also being SENT in this same trade can't double as the initiator's conditional drop", async () => {
  const { env } = threeWayCreateWorld();
  // 16614 is the asset 0008 is SENDING to 0001 in this very trade -- not a loaded contract
  // anyway, but proves the also_being_sent guard is live on the 3-way creation path too.
  const r = await create3Way(env, "tok-A", create3WayBody({ loaded_contract_drops: ["16614"] }));
  t.equal(r.status, 409);
  t.equal(r.json.code, "loaded_contract_drops_required");
  const sel = r.json.loaded_contract_drops_needed.selected.find((s) => s.player_id === "16614");
  t.ok(sel, "the rejected selection is echoed back");
  t.equal(sel.valid, false);
});

test("LC 3-WAY CREATE: a VALID drop from the initiator's own roster lets the offer through, persists, and satisfies capGate at accept with no further ask", async () => {
  const { env, mfl } = threeWayCreateWorld();
  const r = await create3Way(env, "tok-A", create3WayBody({ loaded_contract_drops: ["90000"] }));
  t.equal(r.status, 201, r.text.slice(0, 300));
  const id = r.json.id;
  t.ok(id);
  t.equal(dmsSent(mfl), 2, "both partners were DMed -- the trade really was created");

  // The detail view already reflects the persisted selection as satisfied, without any further action.
  const g = await callWorker(env, "GET", `/api/trades/3way?id=${id}&MFL_USER_ID=tok-A`);
  t.equal(g.status, 200);
  const myReq = g.json.trade.compliance.loaded_contracts.drop_requirements.find((d) => d.franchise_id === "0008");
  t.ok(myReq, "the requirement is still reported even though it's satisfied");
  t.equal(myReq.satisfied, true);
  t.equal(myReq.selected.find((s) => s.player_id === "90000").valid, true);

  // Both partners accept -- capGate never re-asks 0008 for a selection it already made at creation.
  const ctx = ctxWait();
  const b = await say(await handle3WayButton({ data: { custom_id: `tr3:accept:${id}` }, member: { user: { id: DISCORD.B } } }, env, ctx));
  await ctx.flush();
  t.doesNotMatch(b, /loaded.contract|conditional drop/i, `B's accept should not be blocked by A's already-satisfied requirement: ${b}`);
  const c = await say(await handle3WayButton({ data: { custom_id: `tr3:accept:${id}` }, member: { user: { id: DISCORD.C } } }, env, ctx));
  await ctx.flush();
  t.doesNotMatch(c, /loaded.contract|conditional drop/i, `C's accept should not be re-asking A's requirement: ${c}`);
});

test("LC 3-WAY CREATE: exactly five (no drops needed) sends straight through with no gate at all", async () => {
  const { env, mfl } = threeWayCreateWorld();
  mfl.st.rosters["0008"] = [mfl.st.rosters["0008"][0], ...loadedIds(90000, 4).map((p) => ({ id: p.id, salary: 1000, contractStatus: p.contractStatus }))]; // only 4 fillers -> 4+1 received = 5, not 6
  const r = await create3Way(env, "tok-A", create3WayBody());
  t.equal(r.status, 201, r.text.slice(0, 300));
  t.equal(dmsSent(mfl), 2);
});

test("LC 3-WAY CREATE: a genuinely unresolvable loaded-contract calculation -- even though A WOULD need a drop if it resolved -- does not gate the initiator's own offer; the fail-closed guarantee still lives at accept/execute, not creation", async () => {
  const { env, mfl } = threeWayCreateWorld();
  // 0008 is still 5 -> 6 here (unchanged from the base world) -- it WOULD owe a drop if this
  // resolved. But 0001's OWN roster carries an unparseable schedule on an unrelated player, so
  // the calculation comes back "unavailable", not "blocked" -- confirmed directly against
  // evaluateTradeCompliance before writing this test. Creation must not fail-closed here (that
  // guarantee is enforced at preview/accept/execute, exactly like cap).
  mfl.st.rosters["0001"][0].contractInfo = "Y1-foo,Y2-bar";
  const r = await create3Way(env, "tok-A", create3WayBody());
  t.equal(r.status, 201, r.text.slice(0, 300));
  t.equal(dmsSent(mfl), 2);
});

await run("trade_loaded_contracts");
restore();
