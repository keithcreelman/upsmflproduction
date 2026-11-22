// UPS 2027 beta (PR A), BL-M01: which recorded cut penalties name a player, and why the rest read "Player Unknown".
//   node tests/mobile2027_bl_m01_attribution.test.mjs
//
// Owner ruling (2026-11-21): show a player's name only when an authoritative player ID resolves; otherwise exactly "Player Unknown"; add no owner-interface
// read solely to retrieve names; never infer an identity from description text. A reviewed mapping from add/drop ids to players is NOT part of this build
// (BL-M01 is awaiting Keith; bundling one is not approved). Three kinds of source are kept apart here:
//   direct source   the row itself carries a player id AND that id resolves to a name in the data this screen already holds (the roster read);
//   reviewed mapping an id derived offline (add/drop id to player id) and shipped in the build: not present, not approved;
//   description text never used.
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
const cutRows = rows.filter((x) => A.classify(x.row.explanation).category === "Cut Penalty");
const parse = (resolveName) => { const out = []; AD.teams.forEach((tm) => A.parseTeamRows(tm.summary.salary_adjustment_raw_rows, { fid: tm.franchise_id, season: 2026, total: tm.summary.salary_adjustment_total_dollars, resolveName: resolveName }).items.forEach((it) => { if (it.category === "Cut Penalty") out.push(it); })); return out; };

test("the recorded read has 41 cut penalties: 10 whose row carries a player id and 31 whose row carries only an add/drop id", () => {
  t.equal(rows.length, 67); t.equal(cutRows.length, 41);
  const forms = {}; cutRows.forEach((x) => { const f = A.classify(x.row.explanation).idForm; forms[f] = (forms[f] || 0) + 1; });
  t.deepEqual(forms, { player: 10, adddrop: 31 }, "the same 31 add/drop rows that the BL-M01 inventory lists, and the 10 that carry a player id");
});

test("direct source only: 4 of the 10 id-bearing rows name a player because that player is on a roster in the read; the other 6 and all 31 add/drop rows read Player Unknown", () => {
  const items = parse(A.nameResolver(model, null));
  t.equal(items.length, 41);
  const idBearing = cutRows.filter((x) => A.classify(x.row.explanation).idForm === "player").length, addDrop = cutRows.filter((x) => A.classify(x.row.explanation).idForm === "adddrop").length;
  const named = items.filter((i) => i.playerName), unknown = items.filter((i) => !i.playerName);
  t.equal(idBearing, 10); t.equal(addDrop, 31); t.equal(named.length, 4, "named: the row's id resolves in the roster read"); t.equal(unknown.length, 37);
  t.ok(named.every((i) => i.playerId && model.byId[i.playerId] && i.playerName === model.byId[i.playerId].name), "a name always comes from the id, through the roster read");
  t.equal(idBearing - named.length, 6, "id present, but the cut player is not on a roster in this read, and no extra read is made to find him");
  t.equal(unknown.length - (idBearing - named.length), 31, "no player id in the row at all: add/drop ids only");
  t.ok(unknown.every((i) => i.playerName === null && !i.playerId), "an unresolved id is not carried either; every one of them has a null name, which the views draw as Player Unknown");
});

test("no reviewed mapping is consulted: with the default resolver an add/drop id never produces a name, and neither does description text", () => {
  const items = parse(A.nameResolver(model, null)), noResolver = parse(undefined);
  t.equal(noResolver.filter((i) => i.playerName).length, 0, "without any name source nothing is named");
  t.equal(items.filter((i) => i.playerName).length, 4);
  const txt = JSON.stringify(items); t.doesNotMatch(txt, /adddrop20\d\d_/, "no add/drop id is kept in what the app holds");
  t.equal(A.UNKNOWN_PLAYER, "Player Unknown");
});

run("mobile2027_bl_m01_attribution");
