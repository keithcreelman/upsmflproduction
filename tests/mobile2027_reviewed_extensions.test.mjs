// UPS 2027 R10 (Keith, 2026-11-23): the frozen reviewed list of extension attributions (lib/reviewed_extensions.js).
//   node tests/mobile2027_reviewed_extensions.test.mjs
// WHAT THIS TEST ESTABLISHES, AND WHAT IT DOES NOT. The bundle is compared row for row with a second copy of the reviewed table
// (tests/fixtures/mobile2027/reviewed_extensions.json). Both copies come from the same evidence check, so this checks TRANSCRIPTION, the EXACT-MATCH
// guard and how the screen uses a row; it is NOT an independent check of who extended whom. That evidence is the R10 original-record check (D1
// extension, restructure and three-way-trade rows by id; MFL rosters exports), kept privately; it cannot run offline.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const RX = require(path.join(SRC, "lib/reviewed_extensions.js")), C = require(path.join(SRC, "lib/contract.js")), M = require(path.join(SRC, "lib/model.js"));
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/reviewed_extensions.json"), "utf8"));
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), box);
const ROUTES = box.window.UPS2027_RECORDED.routes;
const RW = ROUTES[Object.keys(ROUTES).find((k) => k.indexOf("/roster-workbench?") >= 0)];
const TEAMS = M.build(RW, null, null, 11, 2026).teams;
const byId = (a, b) => (a.player_id < b.player_id ? -1 : 1);
const asObjects = () => RX.rows().map(([player_id, type, special, fid, season, name]) => ({ player_id, type, special, fid, season, name }));
const playerById = (id) => { for (const tm of TEAMS) { const p = tm.players.find((x) => x.id === id); if (p) return p; } return null; };

test("transcription: the bundle equals the second copy of the reviewed table row for row (10 rows, all status verified)", () => {
  t.equal(RX.COUNT, 10); t.equal(FIX.rows.length, 10); t.equal(new Set(FIX.rows.map((r) => r.player_id)).size, 10, "one row per player");
  t.ok(FIX.rows.every((r) => r.status === "verified"));
  t.deepEqual(asObjects().sort(byId), FIX.rows.slice().sort(byId).map((r) => ({ player_id: r.player_id, type: r.contract_match.type, special: r.contract_match.special, fid: r.extended_by_fid, season: Number(r.season), name: r.name })));
  FIX.rows.forEach((r) => t.deepEqual(RX.lookup(r.player_id, r.contract_match.type, r.contract_match.special), { fid: r.extended_by_fid, season: Number(r.season), name: r.name }, r.name));
});

test("each row is the player's CURRENT contract in the recording, and its team name is the fixture's", () => {
  FIX.rows.forEach((r) => {
    const p = playerById(r.player_id); t.ok(p, r.name + " is on a roster");
    t.equal(p.type, r.contract_match.type, r.name); t.equal(p.special, r.contract_match.special, r.name);
    t.equal(TEAMS.find((x) => x.id === r.extended_by_fid).name, r.extended_by_name, r.name);
    const e = C.extension(p, 2026, TEAMS); t.equal(e.reviewed, true, r.name); t.equal(e.by.id, r.extended_by_fid); t.equal(e.year, Number(r.season));
    t.equal(C.extensionLine(e), "Extended by " + r.extended_by_name + " · " + r.season);
  });
});

test("exact match only: another id, type or any change to the contract text never inherits a row; nothing is coerced", () => {
  FIX.rows.forEach((r) => {
    const { type, special } = r.contract_match;
    t.equal(RX.lookup(r.player_id, type, special + " "), null, r.name + ": trailing space");
    t.equal(RX.lookup(r.player_id, type, special.replace(/\|/, "| ")), null, r.name + ": spacing");
    t.equal(RX.lookup(r.player_id, type, special.replace(/Restructured 2026|restructure: 202\d/, "Restructured 2027")), null, r.name + ": a new restructure");
    t.equal(RX.lookup(r.player_id, type, special.replace(/Ext:\s*/, "Ext: Blake, ")), null, r.name + ": a new Ext: name");
    t.equal(RX.lookup(r.player_id, type.replace(/-(FL|BL)$/, "") + (/-(FL|BL)$/.test(type) ? "" : "-BL"), special), null, r.name + ": another type");
    t.equal(RX.lookup(String(Number(r.player_id) + 1), type, special), null, r.name + ": another player");
  });
  const r = FIX.rows[0];
  [[Number(r.player_id), r.contract_match.type, r.contract_match.special], [r.player_id, null, r.contract_match.special], [r.player_id, r.contract_match.type, [r.contract_match.special]], ["__proto__", "x", "y"], ["constructor", "x", "y"]].forEach((a) => t.equal(RX.lookup.apply(null, a), null, JSON.stringify(a).slice(0, 40)));
});

test("a changed contract falls back to the app's own rule (restructure-bound: 'extending team not verified'); a team that is not one of today's teams is never named", () => {
  const p = playerById("15751"), changed = { ...p, special: p.special.replace("GTD: 71.3K", "GTD: 71.4K") };
  const e = C.extension(changed, 2026, TEAMS); t.equal(e.reviewed, false); t.equal(C.extensionLine(e), "Extended · 2026 · extending team not verified");
  const noTeam = C.extension(p, 2026, TEAMS.filter((x) => x.id !== "0009")); t.equal(noTeam.reviewed, false, "the reviewed team is not in the read: the row is not applied");
  // a season that disagrees with the year the terms bind is not applied (guard): read as season 2027, Hurts's terms bind 2027, not the row's 2026
  const e27 = C.extension(playerById("14783"), 2027, TEAMS); t.equal(e27.year, 2027); t.equal(e27.reviewed, false);
});

test("the provenance is kept with the bundle: record ids, no owner message text; display only", () => {
  const p = RX.PROVENANCE, all = JSON.stringify(p);
  t.equal(p.verifiedOn, "2026-11-23"); t.match(p.requested, /Keith 2026-11-23/); t.match(p.key, /player id \+ contract type \+ full contract text/);
  ["665", "663", "664", "666", "669", "72cea017"].forEach((id) => t.match(all, new RegExp(id)));
  t.match(p.dataNote, /contract data .* is unchanged/); t.match(p.testNote, /not the attribution itself/);
  t.doesNotMatch(all, /discord|msg_id|message text:/i);
});

run("mobile2027_reviewed_extensions");
