// UPS 2027 beta (PR A): the frozen reviewed list of 31 cut-penalty names (Keith's display ruling 2026-11-22, recorded on #1502).
//   node tests/mobile2027_reviewed_names.test.mjs
// WHAT THIS TEST ESTABLISHES, AND WHAT IT DOES NOT. The bundle (lib/reviewed_names.js) is compared row for row with a second copy of the reviewed table
// (reviewed_names_31.json, taken from the #1502 inventory). Both copies come from the same verified table, so this checks TRANSCRIPTION and CONSISTENCY and the
// matching rules; it is NOT an independent check that a token names that player. That identity evidence is the separate MFL verification (transactions,
// players and salary-adjustment exports, 31 of 31) kept in docs/evidence/bl_m01_mfl_verification_2026-11-22.md and on issue #1502; it needs live MFL data and
// cannot run offline. A reviewed mapping is kept apart from direct resolution: items carry nameSource "direct" or "reviewed_mapping".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const F = require(path.join(SRC, "lib/format.js")), R = require(path.join(SRC, "lib/reviewed_names.js")), A = require(path.join(SRC, "lib/adjust.js")), M = require(path.join(SRC, "lib/model.js")), V = require(path.join(SRC, "lib/views.js"));
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/reviewed_names_31.json"), "utf8"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const FXP = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const asObjects = () => R.rows().map(([token, team, season, amount, playerId, name, cutDate]) => ({ token, team, season, amount, playerId, name, cutDate }));
const byToken = (a, b) => (a.token < b.token ? -1 : 1);

test("transcription and consistency: the bundle equals the second copy of the reviewed table row for row (31 rows; identity is verified separately against MFL)", () => {
  t.equal(R.COUNT, 31); t.equal(FIX.rows.length, 31); t.equal(new Set(FIX.rows.map((r) => r.token)).size, 31, "31 distinct tokens");
  t.deepEqual(asObjects().sort(byToken), FIX.rows.slice().sort(byToken));
  FIX.rows.forEach((r) => t.deepEqual(R.lookup(r.token, r.team, r.season, r.amount), { id: r.playerId, name: r.name, cutDate: r.cutDate }, r.token));
});

test("cut dates: every one of the 31 rows carries an Eastern Time date that equals the second copy (transcription; the date's identity with MFL's drop is the separate verification) and is a real calendar date", () => {
  t.equal(FIX.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.cutDate)).length, 31);
  FIX.rows.forEach((r) => { t.equal(R.lookup(r.token, r.team, r.season, r.amount).cutDate, r.cutDate, r.token); t.match(F.dateLabel(r.cutDate), /^[A-Z][a-z]{2} \d{1,2}, 2025$/, r.token + " is a 2025 date"); });
  t.equal(R.lookup("adddrop2025_298.2", "0010", 2026, 1000).cutDate, "2025-10-04", "Helm: the example the owner saw, 'Cut Oct 4, 2025'");
  const doc = fs.readFileSync(path.join(HERE, "..", "docs", "evidence", "bl_m01_mfl_verification_2026-11-22.md"), "utf8");
  FIX.rows.forEach((r) => t.ok(doc.indexOf("| `" + r.token + "` | " + r.team + " | " + r.name + " | " + r.cutDate + " |") >= 0, "the evidence file lists the date of " + r.token));
  t.match(doc, /## Cut dates/); t.match(doc, /31 of 31/); t.match(doc, /10 of 10/); t.match(doc, /9:00 AM ET/);
});

test("all four parts must match: another team, season or amount, or an unknown token, never inherits a name", () => {
  FIX.rows.forEach((r) => {
    const other = r.team === "0001" ? "0002" : "0001";
    t.equal(R.lookup(r.token, other, r.season, r.amount), null, r.token + " on another team");
    t.equal(R.lookup(r.token, r.team, r.season + 1, r.amount), null, r.token + " in another season");
    t.equal(R.lookup(r.token, r.team, r.season - 1, r.amount), null, r.token + " in another season");
    t.equal(R.lookup(r.token, r.team, r.season, r.amount + 1), null, r.token + " with another amount");
  });
  ["adddrop2025_999.1", "adddrop2026_114.1", "adddrop2025_114.2", "", null, undefined, "__proto__", "constructor"].forEach((k) => t.equal(R.lookup(k, "0010", 2026, 1000), null, String(k)));
});

test("team 0010: the pair where a mix-up would put the wrong name on an amount (Chism $1,000, Thibodeaux $2,000) and the other two rows (guards a transcription swap between the bundle, the second copy and these assertions; identity is the separate MFL verification)", () => {
  t.deepEqual(R.lookup("adddrop2025_426.2", "0010", 2026, 1000), { id: "17269", name: "Chism, Efton", cutDate: "2025-10-25" });
  t.deepEqual(R.lookup("adddrop2025_427.2", "0010", 2026, 2000), { id: "15806", name: "Thibodeaux, Kayvon", cutDate: "2025-10-25" });
  t.equal(R.lookup("adddrop2025_426.2", "0010", 2026, 2000), null, "Chism's token with Thibodeaux's amount is nobody");
  t.equal(R.lookup("adddrop2025_427.2", "0010", 2026, 1000), null, "Thibodeaux's token with Chism's amount is nobody");
  t.deepEqual(R.lookup("adddrop2025_114.1", "0010", 2026, 1000), { id: "13713", name: "Fitzpatrick, Minkah", cutDate: "2025-08-13" });
  t.deepEqual(R.lookup("adddrop2025_298.2", "0010", 2026, 1000), { id: "17105", name: "Helm, Gunnar", cutDate: "2025-10-04" });
  const rows = FX.teams.find((x) => x.franchise_id === "0010").summary.salary_adjustment_raw_rows;
  const r = A.parseTeamRows(rows, { fid: "0010", season: 2026, total: -27000 }).items.filter((i) => i.category === "Cut Penalty");
  const pairs = r.map((i) => i.playerName + " $" + i.amount).sort();
  t.deepEqual(pairs, ["Chism, Efton $1000", "Fitzpatrick, Minkah $1000", "Helm, Gunnar $1000", "Thibodeaux, Kayvon $2000"]);
});

test("on the recorded read: 4 direct + 31 reviewed mapping = 35 named, 6 stay Player Unknown (their player is on no roster and they are not on the list); sources stay apart", () => {
  const model = M.build(FXP.roster_workbench, FXP.league, FXP.weekly_results, 11, 2026), resolve = A.nameResolver(model, null);
  const items = []; FX.teams.forEach((tm) => A.parseTeamRows(tm.summary.salary_adjustment_raw_rows, { fid: tm.franchise_id, season: 2026, total: tm.summary.salary_adjustment_total_dollars, resolveName: resolve }).items.forEach((i) => { if (i.category === "Cut Penalty") items.push(i); }));
  t.equal(items.length, 41);
  const by = (s) => items.filter((i) => i.nameSource === s).length;
  t.equal(by("direct"), 4); t.equal(by("reviewed_mapping"), 31); t.equal(items.filter((i) => i.playerName).length, 35); t.equal(items.filter((i) => !i.playerName).length, 6);
  t.ok(items.filter((i) => i.nameSource === "reviewed_mapping").every((i) => FIX.rows.some((r) => r.playerId === i.playerId && r.name === i.playerName)), "a mapped name's player id and name are a row of the list (the four-part key is covered by the lookup tests)");
  t.ok(items.filter((i) => !i.playerName).every((i) => i.nameSource === null && /^\d+$/.test(i.playerId)), "no source, no name from these two sources (the player id is kept for the complete player list)");
  t.equal(A.parseTeamRows(FX.teams[0].summary.salary_adjustment_raw_rows, { fid: FX.teams[0].franchise_id, season: 2026, total: 0 }).items.filter((i) => i.category !== "Cut Penalty" && i.playerName).length, 0, "the list is never applied to another category");
  // a new charge (a token not on the list) and a row whose text names someone: Player Unknown
  const row = (explanation) => [{ amount: 1000, franchise_id: "0010", explanation }];
  t.equal(A.parseTeamRows(row("UPS drop penalty Someone Famous 1000 id:adddrop2025_9999.1"), { fid: "0010", season: 2026, total: 1000 }).items[0].playerName, null);
  t.equal(A.parseTeamRows(row("UPS drop penalty Chism, Efton 1000 id:adddrop2025_9999.1"), { fid: "0010", season: 2026, total: 1000 }).items[0].playerName, null, "a name in the text is never used");
  t.equal(A.parseTeamRows(row("UPS drop penalty Chism, Efton 1000 id:adddrop2025_426.2"), { fid: "0010", season: 2027, total: 1000 }).items[0].playerName, null, "another season");
});

test("the provenance and evidence are kept with the bundle", () => {
  const p = R.PROVENANCE;
  t.match(p.list, /#1502/); t.match(p.approved, /Keith 2026-11-22/); t.equal(p.verifiedOn, "2026-11-22"); t.equal(p.checks.length, 4);
  t.match(p.checks.join(" "), /E1/); t.match(p.checks.join(" "), /E2/); t.match(p.checks.join(" "), /E3/); t.match(p.checks.join(" "), /never identity/); t.match(p.key, /token \+ team \+ season \+ posted amount/); t.match(p.limits, /0010/);
  t.match(p.dates, /Eastern Time/); t.match(p.dates, /9:00 AM ET/); t.match(p.datesVerified, /31 of 31/); t.match(p.datesVerified, /10 of 10/);
});

const rosterRead = () => ({ ok: true, generated_at: "2026-11-21T14:00:00Z", teams: FX.teams.map((tm) => ({ franchise_id: tm.franchise_id, franchise_name: "Team " + tm.franchise_id, summary: JSON.parse(JSON.stringify(tm.summary)),
  players: tm.players.map((p) => ({ id: p.id, name: "Player, " + p.id, position: "WR", nfl_team: "KCC", salary: p.salary_unresolved ? 0 : p.salary, salary_unresolved: p.salary_unresolved === true, years: p.years, type: "Veteran", special: p.special, status: p.status })) })) });
const state = (team) => ({ model: M.build(rosterRead(), null, null, 10, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: team, tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {} }, ct: { f: "all", s: "end", open: {}, bd: true, cat: { "y26Cut Penalty": true }, ns: false },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 } });

test("on screen: team 0010's four cut penalties show their reviewed names with the right amounts; no token reaches the page", () => {
  const tx = text(V.app(state("0010")));
  ["Fitzpatrick, Minkah · 2026 +$1,000", "Helm, Gunnar · 2026 +$1,000", "Chism, Efton · 2026 +$1,000", "Thibodeaux, Kayvon · 2026 +$2,000"].forEach((s) => t.match(tx, new RegExp(s.replace(/[$+]/g, "\\$&")), s));
  t.doesNotMatch(tx, /Player Unknown/, "all four are named");
  t.doesNotMatch(V.app(state("0010")), /adddrop|id:/, "the source token is never drawn");
  const other = text(V.app(state("0009"))); t.match(other, /Player Unknown|Chark, D\.J\./, "another team renders its own rows");
});

test("the separate MFL verification is kept in the repository and names every token; the provenance points to it and states the limit of this test", () => {
  const doc = fs.readFileSync(path.join(HERE, "..", "docs", "evidence", "bl_m01_mfl_verification_2026-11-22.md"), "utf8");
  FIX.rows.forEach((r) => t.ok(doc.indexOf("`" + r.token + "`") >= 0, "evidence lists " + r.token));
  t.match(doc, /transcription and consistency/); t.match(doc, /NOT\*\* an independent check|not\*\* an independent check|It is \*\*not\*\*/); t.match(doc, /31 of 31 consistent/); t.match(doc, /12\*\* tokens the same team made another drop|For \*\*12\*\* tokens/);
  t.match(R.PROVENANCE.evidence, /docs\/evidence\/bl_m01_mfl_verification_2026-11-22\.md/); t.match(R.PROVENANCE.testNote, /transcription and consistency, not identity/);
});

test("the id that is looked up is the id that was validated, and nothing is coerced", () => {
  const row = (explanation) => [{ amount: 1000, franchise_id: "0010", explanation }];
  const two = A.parseTeamRows(row("UPS drop penalty Foo id:adddrop2025_426.2 1000 id:adddrop2025_999.1"), { fid: "0010", season: 2026, total: 1000 }).items[0];
  t.equal(two.playerName, null, "the validated id (the last one, 999.1) is not on the list; an earlier ' id:' in the text is never used to look anyone up");
  const ok = A.parseTeamRows(row("UPS drop penalty Foo 1000 id:adddrop2025_426.2"), { fid: "0010", season: 2026, total: 1000 }).items[0];
  t.equal(ok.playerName, "Chism, Efton"); t.equal(ok.nameSource, "reviewed_mapping");
  [["adddrop2025_426.2", "0010", "2026", 1000], ["adddrop2025_426.2", "0010", 2026, "1000"], ["adddrop2025_426.2", "0010", 2026, [1000]], [["adddrop2025_426.2"], "0010", 2026, 1000], ["adddrop2025_426.2", 10, 2026, 1000], ["adddrop2025_426.2", ["0010"], 2026, 1000]].forEach((a) => t.equal(R.lookup.apply(null, a), null, JSON.stringify(a)));
  const dup = A.parseTeamRows([{ amount: 1000, franchise_id: "0010", explanation: "UPS drop penalty Foo 1000 id:adddrop2025_426.2" }, { amount: 1000, franchise_id: "0010", explanation: "UPS drop penalty Bar id:adddrop2025_5.1 1000 id:adddrop2025_426.2" }], { fid: "0010", season: 2026, total: 1000 });
  t.equal(dup.items.length, 1); t.equal(dup.duplicates, 1, "de-duplicated on the validated id");
});

run("mobile2027_reviewed_names");
