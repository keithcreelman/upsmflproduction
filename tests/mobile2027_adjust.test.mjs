// UPS 2027 beta (PR A): cap adjustments: parsing, signed amounts, attribution, reconciliation, the 2027 ledger, the cap charge and the years ahead.
//   node tests/mobile2027_adjust.test.mjs
// Recorded data: tests/fixtures/mobile2027/adjust_2026_wk10.json (the Week 10 roster read, 12 teams, 67 adjustment rows; player names replaced).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib");
const require = createRequire(import.meta.url);
const A = require(path.join(SRC, "adjust.js")), M = require(path.join(SRC, "model.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const STATUS = { ROSTER: "active", TAXI_SQUAD: "taxi", INJURED_RESERVE: "ir" };
const rosterRead = () => ({ ok: true, generated_at: "2026-11-21T14:00:00Z", teams: FX.teams.map((tm) => ({ franchise_id: tm.franchise_id, franchise_name: "Team " + tm.franchise_id, summary: tm.summary,
  players: tm.players.map((p) => ({ id: p.id, name: "Player, " + p.id, position: "WR", nfl_team: "KCC", salary: p.salary_unresolved ? 0 : p.salary, salary_unresolved: p.salary_unresolved === true, years: p.years, type: "Veteran", special: p.special, status: p.status })) })) });
const model = () => M.build(rosterRead(), null, null, 10, 2026);
const row = (amount, text, fid = "0010") => ({ amount, franchise_id: fid, explanation: text });
const TRADE = "UPS traded salary settlement (trade_20261097): net -5K", ROUND = "UPS drop penalty rounding Team -100 id:ups_drop_rounding_0011_2026";
const FINE = "UPS RULE 2 missed nomination 2026-07-28 offense 1 id:ups_rule2_x", CUT_ADD = "UPS drop penalty Someone Else 1000 id:adddrop2025_298.2", CUT_PID = "UPS drop penalty Whoever 1000 id:12801_1784717601";

test("classify: only an exact, full pattern is evidence; keywords inside other text are not", () => {
  t.equal(A.classify(TRADE).category, "Traded Salary"); t.equal(A.classify("UPS traded salary settlement (3-way 72cea017): net -19K").category, "Traded Salary");
  t.equal(A.classify(ROUND).category, "Rounding"); t.equal(A.classify(FINE).category, "FA Auction Fine");
  t.equal(A.classify(CUT_ADD).category, "Cut Penalty"); t.equal(A.classify(CUT_PID).category, "Cut Penalty");
  ["Commissioner note: trade correction", "Dropped player cleanup", "waiver cut adjustment", "UPS traded salary settlement (x): net 5", "UPS drop penalty rounding", "", "   ", null, undefined, 42]
    .forEach((x) => t.equal(A.classify(x), null, "not evidence: " + String(x)));
});

test("recorded Week 10 read: 67 rows, 41 Cut Penalty, 17 Traded Salary, 8 Rounding, 1 FA Auction Fine, 0 Other; every team reconciles to its total", () => {
  const m = model(); const c = { n: 0 }; const by = {}; let neg = 0, tradeNeg = 0, roundNeg = 0;
  m.teams.forEach((tm) => {
    t.ok(tm.adjust.reconciled, tm.id + " reconciles (" + tm.adjust.mismatch + ")"); t.equal(tm.adjust.unverified, 0); t.equal(tm.adjust.duplicates, 0);
    t.equal(tm.adjust.total, tm.cap.adjTotal, tm.id + " items add up to the roster read's adjustment total");
    tm.adjust.items.forEach((it) => { c.n++; by[it.category] = (by[it.category] || 0) + 1; if (it.amount < 0) { neg++; if (it.category === "Traded Salary") tradeNeg++; if (it.category === "Rounding") roundNeg++; } t.equal(it.season, 2026); });
  });
  t.equal(c.n, 67); t.deepEqual(by, { "Cut Penalty": 41, "Traded Salary": 17, "Rounding": 8, "FA Auction Fine": 1 });
  t.equal(neg, 12); t.equal(tradeNeg, 9); t.equal(roundNeg, 3);
});

test("signed amounts: credits stay negative and subtract; a settlement and a rounding credit reduce the total", () => {
  const r = A.parseTeamRows([row(1000, CUT_ADD), row(-5000, TRADE), row("-100", ROUND), row(3000, FINE)], { fid: "0010", season: 2026, total: -1100 });
  t.equal(r.total, -1100); t.ok(r.reconciled); t.equal(r.byCategory["Traded Salary"], -5000); t.equal(r.byCategory.Rounding, -100); t.equal(r.byCategory["FA Auction Fine"], 3000);
  t.equal(A.amountOf("1,000"), null); t.equal(A.amountOf(""), null); t.equal(A.amountOf(null), null); t.equal(A.amountOf(true), null); t.equal(A.amountOf(NaN), null); t.equal(A.amountOf("12abc"), null);
});

test("malformed records are unverified: counted, out of every category and total, never zero, never Other; reconciliation fails", () => {
  const bad = [row(1000, CUT_ADD), row("", CUT_ADD + "x"), row("abc", TRADE), row(null, FINE), row(2000, ROUND, "0099"), { amount: 500, explanation: TRADE }];
  const r = A.parseTeamRows(bad, { fid: "0010", season: 2026, total: 1000 });
  t.equal(r.items.length, 1); t.equal(r.total, 1000); t.equal(r.unverified, 5); t.equal(r.byCategory.Other, 0);
  t.deepEqual(r.unverifiedWhy, { amount: 3, team: 2 }); t.equal(r.reconciled, false); t.match(r.mismatch, /5 records could not be verified/);
  const noSeason = A.parseTeamRows([row(1000, CUT_ADD)], { fid: "0010", season: NaN, total: 1000 }); t.equal(noSeason.unverified, 1); t.equal(noSeason.reconciled, false);
});

test("Other means a VERIFIED adjustment (valid amount, team and season) that matches no pattern; no reason is kept or shown", () => {
  const r = A.parseTeamRows([row(2500, "Commissioner adjustment, see forum"), row(700, "")], { fid: "0010", season: 2026, total: 3200 });
  t.equal(r.byCategory.Other, 3200); t.equal(r.items.every((i) => i.category === "Other" && i.playerName === null), true); t.ok(r.reconciled);
  t.doesNotMatch(JSON.stringify(r), /Commissioner|forum/);
});

test("season is the year of the read, never read from text: 2025 add/drop ids are 2026 charges", () => {
  const r = A.parseTeamRows([row(1000, CUT_ADD)], { fid: "0010", season: 2026, total: 1000 });
  t.equal(r.items[0].season, 2026); const r2 = A.parseTeamRows([row(1000, CUT_ADD)], { fid: "0010", season: 2027, total: 1000 }); t.equal(r2.items[0].season, 2027);
  t.ok(!("timestamp" in r.items[0]) && !("date" in r.items[0]));
});

test("duplicates versus distinct: the same id and amount is one record; different ids, or rows without an id, are separate", () => {
  const same = A.parseTeamRows([row(1000, CUT_ADD), row(1000, CUT_ADD)], { fid: "0010", season: 2026, total: 1000 });
  t.equal(same.items.length, 1); t.equal(same.duplicates, 1); t.ok(same.reconciled);
  const asWorker = A.parseTeamRows([row(1000, CUT_ADD), row(1000, CUT_ADD)], { fid: "0010", season: 2026, total: 2000 });
  t.equal(asWorker.reconciled, false, "if the total counted both, the lines are hidden rather than guessed");
  const distinct = A.parseTeamRows([row(1000, CUT_ADD), row(1000, "UPS drop penalty Someone Else 1000 id:adddrop2025_299.2")], { fid: "0010", season: 2026, total: 2000 });
  t.equal(distinct.items.length, 2); t.ok(distinct.reconciled);
  const noId = A.parseTeamRows([row(-5000, TRADE), row(-5000, TRADE)], { fid: "0010", season: 2026, total: -10000 }); t.equal(noId.items.length, 2); t.ok(noId.reconciled);
});

test("player identity: a name only when an authoritative player id resolves; otherwise Player Unknown; never from description text", () => {
  const names = { 12801: "Tyreek Hill" };
  const r = A.parseTeamRows([row(1000, CUT_PID), row(1000, "UPS drop penalty Someone Else 1000 id:adddrop2025_9999.1"), row(1000, "UPS drop penalty Tyreek Hill 1000 id:99999_1784717601")], { fid: "0010", season: 2026, total: 3000, resolveName: A.nameResolver(null, names) });
  t.equal(r.items[0].playerName, "Tyreek Hill"); t.equal(r.items[0].playerId, "12801");
  t.equal(r.items[1].playerName, null, "an add/drop id that is not on the reviewed list: no player id, no name"); t.equal(r.items[2].playerName, null, "the id does not resolve, and the name in the text is not used");
  t.equal(A.UNKNOWN_PLAYER, "Player Unknown");
  const none = A.parseTeamRows([row(1000, CUT_PID)], { fid: "0010", season: 2026, total: 1000 }); t.equal(none.items[0].playerName, null, "no resolver: Player Unknown");
  t.equal(A.nameResolver({ byId: { "7": { name: "Rostered Guy" } } }, null)("7"), "Rostered Guy"); t.equal(A.nameResolver({ byId: {} }, null)("7"), null);
  const rec = model(); let unknown = 0; rec.teams.forEach((tm) => tm.adjust.items.forEach((i) => { if (i.category === "Cut Penalty" && i.playerName === null) unknown++; }));
  t.equal(unknown, 4, "41 cut penalties: the 31 add/drop charges are on the reviewed list (named), and of the 10 that carry a player id only the players on a roster in this read resolve; 4 stay Player Unknown (BL-M50)");
});

test("nothing from a source string survives: no description, note, id, date or other team in any result or in the model", () => {
  const r = A.parseTeamRows([row(1000, CUT_ADD), row(-5000, TRADE), row(500, ROUND), row(3000, FINE)], { fid: "0010", season: 2026, total: -500 });
  const s = JSON.stringify(r); ["UPS", "settlement", "adddrop", "ups_rule2", "trade_2026", "ups_drop_rounding", "offense", "explanation", "description", "timestamp"].forEach((w) => t.doesNotMatch(s, new RegExp(w, "i"), w));
  r.items.forEach((i) => t.deepEqual(Object.keys(i).sort(), ["amount", "category", "cutDate", "nameSource", "playerId", "playerName", "season"]));   // cutDate: an Eastern Time calendar date or null, never a source string
  const ms = JSON.stringify(model()); t.doesNotMatch(ms, /UPS drop penalty|traded salary settlement|RULE 2|rawRows|explanation/);
});

test("empty versus failed: no rows read is unavailable, never 'no adjustments'; an empty list reconciles only to a zero total", () => {
  t.equal(A.parseTeamRows(null, { fid: "0010", season: 2026, total: 0 }).unavailable, true); t.equal(A.parseTeamRows(null, { fid: "0010", season: 2026, total: 0 }).reconciled, false);
  t.ok(A.parseTeamRows([], { fid: "0010", season: 2026, total: 0 }).reconciled);
  const miss = A.parseTeamRows([], { fid: "0010", season: 2026, total: 5000 }); t.equal(miss.reconciled, false); t.match(miss.mismatch, /do not add up/);
  t.equal(A.parseTeamRows([row(1000, CUT_ADD)], { fid: "0010", season: 2026, total: null }).reconciled, false);
  const m = M.build({ ok: true, teams: [{ franchise_id: "0001", franchise_name: "X", players: [] }] }, null, null, 10, 2026); t.equal(m.teams[0].cap, null); t.equal(m.teams[0].adjust, null, "a roster read with no summary draws no adjustment claim");
});

const LEDGER = (over) => ({ ok: true, season: "2026", next_season: 2027, by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [
  { player_id: "12801", player: "Name In Text", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-09-01T00:00:00Z", kind: "Drop (next season)", in_mfl: false },
  { player_id: null, player: "Missed nomination offense 1", franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28", kind: "RULE 2 fine (next season)", in_mfl: false },
  { player_id: "55", franchise_id: "0003", amount: 9999, applies_to_season: 2027, kind: "Drop (next season)", in_mfl: false }], ...(over || {}) });

test("2027 ledger: category from the row kind, player only from an id that resolves, other teams ignored, reconciled to the ledger's own team total", () => {
  const r = A.parseNextSeason(LEDGER(), { fid: "0010", season: 2027, resolveName: A.nameResolver(null, { 12801: "Tyreek Hill" }) });
  t.equal(r.state, "ok"); t.equal(r.items.length, 2); t.equal(r.total, 4000); t.ok(r.reconciled); t.ok(r.complete);
  t.equal(r.items[0].category, "Cut Penalty"); t.equal(r.items[0].playerName, "Tyreek Hill"); t.equal(r.items[1].category, "FA Auction Fine"); t.equal(r.items[1].playerName, null);
  t.doesNotMatch(JSON.stringify(r), /Name In Text|Missed nomination/);
  const r2 = A.parseNextSeason(LEDGER(), { fid: "0010", season: 2027 }); t.equal(r2.items[0].playerName, null, "no resolver: Player Unknown");
});

test("2027 ledger: failed or unresolved answers are errors; zero rows is 'none recorded'; held and review rows are counted and never priced", () => {
  [null, undefined, "x", { ok: false }, { ok: true }, { ok: true, rows: "no" }].forEach((x) => t.equal(A.parseNextSeason(x, { fid: "0010", season: 2027 }).state, "error"));
  t.equal(A.parseNextSeason({ ok: false, error: "auction_start_unresolved" }, { fid: "0010", season: 2027 }).why, "unresolved_start");
  const none = A.parseNextSeason({ ok: true, rows: [], by_fid: {}, held_unpriced: [], needs_review: [] }, { fid: "0010", season: 2027 }); t.equal(none.state, "ok"); t.equal(none.items.length, 0); t.ok(none.reconciled); t.ok(none.complete);
  const held = A.parseNextSeason(LEDGER({ held_unpriced: [{ franchise_id: "0010", player_id: "9", amount: null }, { franchise_id: "0004" }], needs_review: [{ franchise_id: "0010" }] }), { fid: "0010", season: 2027 });
  t.equal(held.waiting, 1); t.equal(held.review, 1); t.equal(held.complete, false); t.equal(held.total, 4000, "a held cut adds nothing: it has no price yet");
});

test("2027 ledger: a wrong year, a bad amount, a row already on MFL and an unknown kind are handled without guessing", () => {
  const j = LEDGER({ rows: [
    { player_id: "1", franchise_id: "0010", amount: 1000, applies_to_season: 2026, kind: "Drop (next season)", in_mfl: false },
    { player_id: "2", franchise_id: "0010", amount: "x", applies_to_season: 2027, kind: "Drop (next season)", in_mfl: false },
    { player_id: "3", franchise_id: "0010", amount: 700, applies_to_season: 2027, kind: "Drop (next season)", in_mfl: true },
    { player_id: "4", franchise_id: "0010", amount: 250, applies_to_season: 2027, kind: "Something new", in_mfl: false }], by_fid: { "0010": { total: 1950 } } });
  const r = A.parseNextSeason(j, { fid: "0010", season: 2027 });
  t.equal(r.unverified, 3); t.deepEqual(r.unverifiedWhy, { season: 1, amount: 1, already_on_mfl: 1 }); t.equal(r.inMfl, 1);
  t.equal(r.byCategory.Other, 250, "a verified row of an unknown kind is Other"); t.equal(r.reconciled, false); t.equal(r.complete, false);
});

test("2027 verification gap is three separate statements, none says an amount is wrong", () => {
  const g = A.NEXT_SEASON_GAP; t.deepEqual(Object.keys(g).sort(), ["calculation", "completeness", "reconciliation"]);
  t.match(g.completeness, /Source completeness/); t.match(g.reconciliation, /Reconciliation/); t.match(g.calculation, /Calculation/); t.match(g.calculation, /Nothing here says an amount is wrong/);
  Object.keys(g).forEach((k) => t.doesNotMatch(g[k], /worker|snapshot R2|wrong amount/i));
});

test("cap charge: recorded salary, taxi and injured reserve lines add exactly to the roster read's cap total for all 12 recorded teams", () => {
  const m = model(); let n = 0;
  m.teams.forEach((tm) => { const b = A.capBreakdown(tm, tm.cap); t.ok(b.ok, tm.id + " ties (" + b.capHits + " vs " + tm.cap.capTotal + ")"); t.equal(b.capCharge, tm.cap.capTotal + tm.cap.adjTotal); n++; });
  t.equal(n, 12);
  const blake = m.teams.find((x) => x.id === "0010"), b = A.capBreakdown(blake, blake.cap);
  t.equal(b.recorded, 347000); t.equal(b.taxi, 15000); t.equal(b.irRelief, 7000); t.equal(b.capHits, 325000); t.equal(blake.cap.capTotal, 325000); t.equal(blake.cap.adjTotal, -27000); t.equal(b.capCharge, 298000);
  t.equal(A.capBreakdown(blake, { capTotal: 326000, adjTotal: -27000, unresolved: false }).ok, false, "a total that does not tie hides the lines");
  t.equal(A.capBreakdown(blake, { capTotal: 325000, adjTotal: -27000, unresolved: true }).ok, false, "an unresolved cap total hides the lines");
  t.equal(A.capBreakdown(blake, { capTotal: 325000, adjTotal: -27000, unresolved: true }).capCharge, null, "and gives no cap charge");
  t.equal(A.capBreakdown(blake, null).ok, false); t.equal(A.capBreakdown(blake, null).capCharge, null);
});

test("years ahead: this season keeps half injured-reserve relief; later seasons count injured reserve in full and taxi at $0; unknown adjustments are not $0", () => {
  const blake = model().teams.find((x) => x.id === "0010");
  const adj0 = { known: true, total: -27000, state: "ok" }, none = { known: false, total: null, state: "unsupported" };
  const y = A.commitments(blake, 2026, adj0, none, 3);
  t.equal(y[0].hits, 325000); t.equal(y[0].total, 298000); t.equal(y[1].hits, 199000); t.equal(y[1].total, null, "no 2027 adjustment known: no total, not $0"); t.equal(y[2].hits, 40000); t.equal(y[2].adj, null);
  const y2 = A.commitments(blake, 2026, adj0, { known: true, total: 3000, state: "ok" }, 3); t.equal(y2[1].total, 202000); t.equal(y2[2].total, null, "2028 has no adjustment source");
  t.equal(y[0].hitsIncomplete, false);
  const gap = { id: "x", status: "active", salary: 5000, years: 2, special: "CL 2|Y1-5K" };
  t.equal(A.commitments({ players: [gap] }, 2026, adj0, none, 2)[1].hitsIncomplete, true, "a year with no recorded amount is incomplete, never $0");
});

// ───────────────────────── PR A revision: cut dates (Eastern Time) and the player id that is always kept ─────────────────────────
const F = require(path.join(SRC, "format.js"));

test("etDate: a Unix time becomes its Eastern Time calendar date; late evening UTC is still the previous day in New York; implausible values are null", () => {
  const sec = (iso) => Date.parse(iso) / 1000;
  t.equal(A.etDate(sec("2025-10-04T13:00:00Z")), "2025-10-04", "9:00 AM ET (EDT)");
  t.equal(A.etDate(sec("2025-10-05T02:30:00Z")), "2025-10-04", "10:30 PM EDT on Oct 4 is Oct 5 in UTC");
  t.equal(A.etDate(sec("2025-12-21T03:30:00Z")), "2025-12-20", "10:30 PM EST (winter) is the next UTC day");
  t.equal(A.etDate(sec("2025-12-21T05:00:00Z")), "2025-12-21", "midnight EST is the new ET day");
  t.equal(A.etDate(sec("2025-03-09T06:59:59Z")), "2025-03-09", "just before the spring change"); t.equal(A.etDate(sec("2025-11-02T05:30:00Z")), "2025-11-02", "the fall change day");
  t.equal(A.etDate(1779459271), "2026-05-22", "Dyami Brown's recorded drop time"); t.equal(A.etDate(1784717601), "2026-07-22");
  t.equal(A.etDate(1759626000000), "2025-10-04", "13 digits are milliseconds (9:00 PM EDT on Oct 4 is 01:00 UTC on Oct 5)");
  [1499999999, 2000000001, 0, -5, 17594.5, 1.7e9 + 0.5, NaN, Infinity, null, undefined, "abc", "", true, {}, [1759626000]].forEach((x) => t.equal(A.etDate(x), null, "not a plausible time: " + String(x)));
  t.equal(A.etDate("1759626000"), "2025-10-04", "a digit string of the right length is accepted"); t.equal(A.etDate("17596260001"), null, "an 11-digit string is neither seconds nor milliseconds");
});

test("etDateFromIso: only an ISO time WITH a time zone places a drop on a day; a bare date, a date without a zone and junk never do", () => {
  t.equal(A.etDateFromIso("2026-08-08T13:26:53.000Z"), "2026-08-08"); t.equal(A.etDateFromIso("2026-08-09T01:30:00.000Z"), "2026-08-08", "9:30 PM ET the evening before");
  t.equal(A.etDateFromIso("2026-08-08T21:30:00-04:00"), "2026-08-08"); t.equal(A.etDateFromIso("2026-09-01T00:00:00Z"), "2026-08-31");
  ["2026-09-01", "2026-09-01T10:00:00", "2026-09-01 10:00:00Z", "tomorrow", "", null, undefined, 1784717601, {}, "2026-13-45T10:00:00Z", "1999-01-01T00:00:00Z"].forEach((x) => t.equal(A.etDateFromIso(x), null, String(x)));
});

test("format.dateLabel writes an Eastern Time date as 'Oct 4, 2025' without shifting it, and refuses anything that is not a real date", () => {
  t.equal(F.dateLabel("2025-10-04"), "Oct 4, 2025"); t.equal(F.dateLabel("2025-12-31"), "Dec 31, 2025"); t.equal(F.dateLabel("2028-02-29"), "Feb 29, 2028"); t.equal(F.dateLabel("2026-01-01"), "Jan 1, 2026");
  ["2025-02-29", "2025-13-01", "2025-00-10", "2025-10-32", "2025-10-4", "10/04/2025", "", null, undefined, 20251004, "2025-10-04T10:00:00Z"].forEach((x) => t.equal(F.dateLabel(x), "", String(x)));
});

test("cut dates, 2026 rows: the player-id key carries the drop's Unix time; an add/drop row takes its date from the reviewed list; every other row has no date and no player", () => {
  const near = "UPS drop penalty Whoever 1000 id:12801_1784717601", late = "UPS drop penalty Whoever 1000 id:12801_" + Math.round(Date.parse("2026-07-23T02:15:00Z") / 1000), odd = "UPS drop penalty Whoever 1000 id:12801_1111111111";
  const r = A.parseTeamRows([row(1000, near), row(1000, late), row(1000, odd), row(1000, CUT_ADD), row(-5000, TRADE), row(-100, ROUND), row(3000, FINE)], { fid: "0010", season: 2026, total: 1000 + 1000 + 1000 + 1000 - 5000 - 100 + 3000 });
  t.equal(r.items[0].cutDate, "2026-07-22"); t.equal(r.items[1].cutDate, "2026-07-22", "10:15 PM ET on Jul 22 is Jul 23 in UTC"); t.equal(r.items[2].cutDate, null, "a 10-digit number that is not a plausible time is not a date");
  t.equal(r.items[3].cutDate, "2025-10-04", "adddrop2025_298.2 on team 0010 is Helm, dropped Oct 4, 2025 (ET)");
  r.items.slice(4).forEach((i) => { t.equal(i.cutDate, null); t.equal(i.playerId, null); t.equal(i.playerName, null); });
  t.equal(A.parseTeamRows([row(1000, "UPS drop penalty Whoever 1000 id:adddrop2025_9999.1")], { fid: "0010", season: 2026, total: 1000 }).items[0].cutDate, null, "an add/drop id that is not on the reviewed list: no date");
});

test("the player id is kept on a player-id row even when the roster does not resolve him; a roster-resolved name stays 'direct'; the reviewed mapping keeps its own source", () => {
  const none = A.parseTeamRows([row(1000, CUT_PID)], { fid: "0010", season: 2026, total: 1000, resolveName: A.nameResolver(null, {}) }).items[0];
  t.equal(none.playerId, "12801"); t.equal(none.playerName, null); t.equal(none.nameSource, null, "no name yet: nothing is claimed about a source"); t.equal(none.cutDate, "2026-07-22");
  const named = A.parseTeamRows([row(1000, CUT_PID)], { fid: "0010", season: 2026, total: 1000, resolveName: A.nameResolver(null, { 12801: "Hill, Tyreek" }) }).items[0];
  t.equal(named.playerName, "Hill, Tyreek"); t.equal(named.nameSource, "direct"); t.equal(named.playerId, "12801");
  const rv = A.parseTeamRows([row(1000, CUT_ADD)], { fid: "0010", season: 2026, total: 1000, resolveName: A.nameResolver(null, { 17105: "Someone Else, Entirely" }) }).items[0];
  t.equal(rv.nameSource, "reviewed_mapping"); t.equal(rv.playerName, "Helm, Gunnar", "the reviewed list wins for an add/drop token; it carries no player id to look up"); t.equal(rv.playerId, "17105");
  // on the recorded read every one of the 41 cut penalties has a date and a player id; the 6 the roster does not name keep their ids
  const m = model(); const cuts = []; m.teams.forEach((tm) => tm.adjust.items.forEach((i) => { if (i.category === "Cut Penalty") cuts.push(i); }));
  t.equal(cuts.length, 41); t.ok(cuts.every((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.cutDate) && /^\d+$/.test(i.playerId)), "41 of 41 have a cut date and a player id");
  t.equal(cuts.filter((i) => !i.playerName).length, 4); t.ok(cuts.filter((i) => !i.playerName).every((i) => i.nameSource === null));
});

test("cut dates, 2027 ledger: dropped_at_iso (UTC) becomes the Eastern Time date, only on a drop row; a fine has no player and no date; a row with no time is 'not recorded'", () => {
  const j = LEDGER({ by_fid: { "0010": { total: 6000 } }, rows: [
    { player_id: "12801", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-08-09T01:30:00.000Z", kind: "Drop (next season)", in_mfl: false },
    { player_id: "15292", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-08-08T13:26:53.000Z", kind: "Drop (next season)", in_mfl: false },
    { player_id: "13713", franchise_id: "0010", amount: 1000, applies_to_season: 2027, kind: "Drop (next season)", in_mfl: false },
    { player_id: "12", franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28T12:00:00.000Z", kind: "RULE 2 fine (next season)", in_mfl: false }] });
  const r = A.parseNextSeason(j, { fid: "0010", season: 2027, resolveName: A.nameResolver(null, { 12801: "Hill, Tyreek" }) });
  t.equal(r.state, "ok"); t.deepEqual(r.items.map((i) => i.cutDate), ["2026-08-08", "2026-08-08", null, null]);
  t.deepEqual(r.items.map((i) => i.playerId), ["12801", "15292", "13713", null], "ids kept on every drop; a fine has none even if the row sent one");
  t.deepEqual(r.items.map((i) => i.playerName), ["Hill, Tyreek", null, null, null]); t.equal(r.items[0].nameSource, "direct"); t.equal(r.items[1].nameSource, null);
  r.items.forEach((i) => t.deepEqual(Object.keys(i).sort(), ["amount", "category", "cutDate", "nameSource", "playerId", "playerName", "season"]));
});

run("mobile2027_adjust");
