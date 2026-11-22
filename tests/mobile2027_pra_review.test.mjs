// UPS 2027 beta (PR A): fixes from the independent code review of 83f4e5d5 (each finding was checked against the code first).
//   node tests/mobile2027_pra_review.test.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const A = require(path.join(SRC, "lib/adjust.js")), M = require(path.join(SRC, "lib/model.js")), V = require(path.join(SRC, "lib/views.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("a cut penalty needs one of the two known id forms: a rounding row with a damaged id, an unknown id form and a 9-digit time are not Cut Penalty", () => {
  t.equal(A.classify("UPS drop penalty rounding Team -100 id:ups_drop_rounding_0011_20"), null, "a damaged rounding id is not a cut penalty");
  t.equal(A.classify("UPS drop penalty Some Player 1000 id:whatever"), null, "an unknown id form");
  t.equal(A.classify("UPS drop penalty Some Player 1000 id:12345_177945927"), null, "9 digits is not the machine-written time");
  t.equal(A.classify("UPS drop penalty Some Player 1000 id:12345_17794592711"), null, "11 digits is not either");
  t.deepEqual(A.classify("UPS drop penalty Some Player 1000 id:12345_1779459271"), { category: "Cut Penalty", idForm: "player", playerId: "12345" });
  t.deepEqual(A.classify("UPS drop penalty Some Player 1000 id:adddrop2025_114.1"), { category: "Cut Penalty", idForm: "adddrop", playerId: null });
  t.equal(A.classify("UPS drop penalty rounding Team -100 id:ups_drop_rounding_0011_2026").category, "Rounding", "a real rounding row is still Rounding");
  const r = A.parseTeamRows([{ amount: 1000, franchise_id: "0010", explanation: "UPS drop penalty Some Player 1000 id:whatever" }], { fid: "0010", season: 2026, total: 1000 });
  t.equal(r.items[0].category, "Other", "it falls to Other, never guessed as a cut penalty");
  t.equal(A.parseTeamRows(FX.teams[0].summary.salary_adjustment_raw_rows, { fid: FX.teams[0].franchise_id, season: 2026, total: FX.teams[0].summary.salary_adjustment_total_dollars }).reconciled, true, "the recorded rows still all classify and reconcile");
});

test("a team id is 1 to 4 digits: '10001' and 'A0001' are not team 0001", () => {
  const row = (fid) => ({ amount: 1000, franchise_id: fid, explanation: "UPS drop penalty Some Player 1000 id:adddrop2025_1.1" });
  ["10001", "A0001", "", null, "00 1"].forEach((f) => t.equal(A.parseTeamRows([row(f)], { fid: "0001", season: 2026, total: 1000 }).unverified, 1, String(f)));
  ["0001", "1", 1, " 0001 "].forEach((f) => t.equal(A.parseTeamRows([row(f)], { fid: "0001", season: 2026, total: 1000 }).unverified, 0, String(f)));
});

test("a player with no contract years recorded makes every year incomplete; a contract that really ended is not unknown", () => {
  const team = { players: [{ status: "active", salary: 4000, years: 0, special: "" }, { status: "active", salary: 2000, years: 1, special: "CL 1| TCV 2K| AAV 2K" }] };
  const ys = A.commitments(team, 2026, { known: true, total: 0, state: "ok" }, null, 3);
  t.deepEqual(ys.map((y) => y.hitsIncomplete), [true, true, true], "no years recorded: amounts unknown in every year");
  t.deepEqual(ys.map((y) => y.unknownCount), [1, 1, 1]); t.deepEqual(ys.map((y) => y.total), [null, null, null]);
  const ok = A.commitments({ players: [team.players[1]] }, 2026, { known: true, total: 0, state: "ok" }, null, 3);
  t.deepEqual(ok.map((y) => y.hitsIncomplete), [false, false, false], "a one-year contract is complete: it ended, it is not unknown");
  t.deepEqual(ok.map((y) => y.hits), [2000, 0, 0]);
});

const rosterRead = () => ({ ok: true, generated_at: "2026-11-21T14:00:00Z", teams: FX.teams.map((tm) => ({ franchise_id: tm.franchise_id, franchise_name: "Team " + tm.franchise_id, summary: JSON.parse(JSON.stringify(tm.summary)),
  players: tm.players.map((p) => ({ id: p.id, name: "Player, " + p.id, position: "WR", nfl_team: "KCC", salary: p.salary_unresolved ? 0 : p.salary, salary_unresolved: p.salary_unresolved === true, years: p.years, type: "Veteran", special: p.special, status: p.status })) })) });
const state = (over) => ({ model: M.build(rosterRead(), null, null, 10, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {} }, ct: { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: true },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const withNext = (s, ledger) => { const by = {}; s.model.teams.forEach((tm) => { by[tm.id] = A.parseNextSeason(ledger, { fid: tm.id, season: s.model.season + 1, resolveName: A.nameResolver(s.model, null) }); }); s.ns = { state: "ok", at: 1, by }; return s; };

test("2027 detail: figures only when the items add up to the ledger's own total; 'already on MFL' is not 'could not be verified'", () => {
  const row = (amount, over) => ({ player_id: "99999", franchise_id: "0010", amount, applies_to_season: 2027, dropped_at_iso: "2026-09-01", kind: "Drop (next season)", in_mfl: false, ...(over || {}) });
  const bad = text(V.app(withNext(state(), { ok: true, by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [row(3000)] })));
  t.doesNotMatch(bad, /Cut Penalty/, "no category line"); t.doesNotMatch(bad, /Total \+\$/, "no total"); t.match(bad, /Detail unavailable: the items do not add up/);
  const none = text(V.app(withNext(state(), { ok: true, by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [] })));
  t.doesNotMatch(none, /No 2027 adjustments recorded yet/, "a ledger total of 4,000 with no rows is not 'none recorded'");
  const good = text(V.app(withNext(state(), { ok: true, by_fid: { "0010": { total: 1000 } }, held_unpriced: [], needs_review: [], rows: [row(1000)] })));
  t.match(good, /Cut Penalty ▸ \+\$1,000/); t.match(good, /Total \+\$1,000/);
  const onMfl = text(V.app(withNext(state(), { ok: true, by_fid: { "0010": { total: 1000 } }, held_unpriced: [], needs_review: [], rows: [row(1000), row(2000, { in_mfl: true, dropped_at_iso: "2026-08-01" })] })));
  t.match(onMfl, /1 record is already on MFL and not counted here\./); t.doesNotMatch(onMfl, /could not be verified/, "a record on MFL is not unverified");
});

test("the 2026 commitments row shows no total when the roster read has no cap total", () => {
  const s = state({ ct: { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: false } }), tm = s.model.teams.find((x) => x.id === "0010"); tm.cap = { capTotal: null, adjTotal: null, unresolved: true };
  const tx = text(V.app(s)); t.match(tx, /Unavailable: this roster read did not include the team’s cap total/); t.match(tx, /2026 — Cap hits/); t.doesNotMatch(tx, /2026 \$\d/, "no dollar total on the 2026 row");
});

test("a disabled button looks disabled", () => {
  t.match(CSS, /\.btn:disabled,\.btn\[aria-disabled="true"\]\{[^}]*opacity:\.5[^}]*cursor:not-allowed/);
});

run("mobile2027_pra_review");
