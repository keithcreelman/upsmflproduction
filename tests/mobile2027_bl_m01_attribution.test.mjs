// UPS 2027 beta (PR A), BL-M01: which recorded cut penalties name a player, and why the rest read "Player Unknown".
//   node tests/mobile2027_bl_m01_attribution.test.mjs
//
// Owner rulings: (2026-11-21) show a player's name only when an authoritative player ID resolves, otherwise exactly "Player Unknown"; add no owner-interface
// read solely to retrieve names; never infer an identity from description text. (2026-11-22) display the 31 names from the reviewed list; keep "Player
// Unknown" for everything outside it. The sources are kept apart here:
//   direct source    the row itself carries a player id AND that id resolves to a name in the roster read (nameSource "direct");
//   reviewed mapping the frozen, approved list of 31 add/drop charges (nameSource "reviewed_mapping"; its own test is mobile2027_reviewed_names);
//   description text never used.
// PR A revision (Keith, 2026-11-22): a row's player id is also looked up in MFL's complete player list (by id, never by roster membership), so the 6 that no roster
// names are named on screen once that list loads; this file covers the parsing (what an item carries), mobile2027_contracts_pra covers the screen.
// Recorded data: the 2026 Week 10 roster read of all 12 teams (the 41 cut penalties of the 67 adjustment rows).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "model.js")), A = require(path.join(SRC, "adjust.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const AD = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const model = M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
const rows = [];
AD.teams.forEach((tm) => tm.summary.salary_adjustment_raw_rows.forEach((r) => rows.push({ fid: tm.franchise_id, row: r })));
const cutRows = rows.filter((x) => A.classify(x.row.explanation) && A.classify(x.row.explanation).category === "Cut Penalty");
const parse = (resolveName) => { const out = []; AD.teams.forEach((tm) => A.parseTeamRows(tm.summary.salary_adjustment_raw_rows, { fid: tm.franchise_id, season: 2026, total: tm.summary.salary_adjustment_total_dollars, resolveName: resolveName }).items.forEach((it) => { if (it.category === "Cut Penalty") out.push(it); })); return out; };

test("the recorded read has 41 cut penalties: 10 whose row carries a player id and 31 whose row carries only an add/drop id", () => {
  t.equal(rows.length, 67); t.equal(cutRows.length, 41);
  const forms = {}; cutRows.forEach((x) => { const f = A.classify(x.row.explanation).idForm; forms[f] = (forms[f] || 0) + 1; });
  t.deepEqual(forms, { player: 10, adddrop: 31 }, "the same 31 add/drop rows that the BL-M01 inventory lists, and the 10 that carry a player id");
});

test("35 of 41 are named by the roster read and the reviewed list: 4 by direct source (the row's id is on a roster in the read) and 31 by the reviewed list; the other 6 are named by id from MFL's complete player list (mobile2027_contracts_pra)", () => {
  const items = parse(A.nameResolver(model, null));
  t.equal(items.length, 41);
  const direct = items.filter((i) => i.nameSource === "direct"), mapped = items.filter((i) => i.nameSource === "reviewed_mapping"), unknown = items.filter((i) => !i.playerName);
  t.equal(direct.length, 4, "direct: the row's id resolves in the roster read"); t.equal(mapped.length, 31, "reviewed list"); t.equal(unknown.length, 6);
  t.ok(direct.every((i) => i.playerId && model.byId[i.playerId] && i.playerName === model.byId[i.playerId].name), "a direct name always comes from the row's own id, through the roster read");
  const idBearing = cutRows.filter((x) => A.classify(x.row.explanation).idForm === "player").length;
  t.equal(idBearing - direct.length, 6, "the 6: the row has a player id, the cut player is on no roster in this read, and no extra read is made to find him");
  // PR A revision: the row's player id is always kept, so the screen can name these 6 from MFL's complete player list (by id, whatever roster he is on)
  t.ok(unknown.every((i) => i.nameSource === null && /^\d+$/.test(i.playerId)), "no name from the roster; the id is kept so the screen can look it up in the complete player list");
  t.ok(items.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.cutDate)), "every cut penalty has a verified cut date: the key's drop time (10) or the reviewed list (31)");
});

test("the reviewed list works without any roster read, and the 6 stay unknown: nothing else names a player, description text included", () => {
  const items = parse(undefined);
  t.equal(items.filter((i) => i.nameSource === "reviewed_mapping").length, 31); t.equal(items.filter((i) => i.nameSource === "direct").length, 0); t.equal(items.filter((i) => !i.playerName).length, 10);
  const txt = JSON.stringify(items); t.doesNotMatch(txt, /adddrop20\d\d_/, "no add/drop id is kept in what the app holds");
  t.equal(A.UNKNOWN_PLAYER, "Player Unknown");
});

run("mobile2027_bl_m01_attribution");
