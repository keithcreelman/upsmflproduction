// UPS 2027 beta (PR A): the Contracts screen: one cap card (Available cap space, Total cap, Breakdown, later years), itemized adjustments (names from MFL's complete
// player list, cut dates in Eastern Time), the 2027 states, the sort control, name-opens-profile, the guarantee wording, the Help control, the failure pattern, and
// owner-facing wording.
//   node tests/mobile2027_contracts_pra.test.mjs
// Recorded data: tests/fixtures/mobile2027/adjust_2026_wk10.json (Week 10 roster read, 12 teams, player names in adjustment text replaced) and
// tests/fixtures/mobile2027/players_subset.json (the ids these tests use, taken from MFL's players export of 2026-11-22).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib");
const require = createRequire(import.meta.url);
const A = require(path.join(SRC, "adjust.js")), M = require(path.join(SRC, "model.js")), V = require(path.join(SRC, "views.js")), TV = require(path.join(SRC, "tabviews.js")), C = require(path.join(SRC, "contract.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const PLF = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/players_subset.json"), "utf8"));
const CSS = fs.readFileSync(path.join(SRC, "..", "styles.css"), "utf8");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
// the player list as the loader keeps it: { state, data: { byId: { id: { pos, club, name } } }, at }; `omit` leaves one id out
const listOf = (omit) => { const byId = {}; PLF.players.player.forEach((p) => { if (p.id !== omit) byId[p.id] = { pos: p.position, club: p.team, name: p.name }; }); return { state: "ok", data: { byId }, at: 1 }; };
const rosterRead = (edit) => { const r = { ok: true, generated_at: "2026-11-21T14:00:00Z", salary_cap_dollars: 300000, teams: FX.teams.map((tm) => ({ franchise_id: tm.franchise_id, franchise_name: "Team " + tm.franchise_id, summary: JSON.parse(JSON.stringify(tm.summary)),
  players: tm.players.map((p) => ({ id: p.id, name: "Player, " + p.id, position: "WR", nfl_team: "KCC", salary: p.salary_unresolved ? 0 : p.salary, salary_unresolved: p.salary_unresolved === true, years: p.years, type: "Veteran", special: p.special, status: p.status })) })) }; if (edit) edit(r); return r; };
const CT0 = () => ({ f: "all", s: "exp", y: 0, d: 1, open: {}, bd: false, cat: {}, ns: false });
const state = (over, edit) => ({ model: M.build(rosterRead(edit), null, null, 10, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup", open: {}, flags: {},
  profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {}, players: listOf() }, ct: CT0(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const money = (n) => "$" + Math.abs(n).toLocaleString("en-US");
const LEDGER = { ok: true, by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [
  { player_id: "99999", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-09-01", kind: "Drop (next season)", in_mfl: false },
  { player_id: null, franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28", kind: "RULE 2 fine (next season)", in_mfl: false }] };
const withNext = (s, ledger) => { const season = s.model.season + 1; const by = {}; let bad = false; s.model.teams.forEach((tm) => { const p = A.parseNextSeason(ledger, { fid: tm.id, season, resolveName: A.nameResolver(s.model, null) }); if (p.state !== "ok") bad = true; else by[tm.id] = p; }); s.ns = bad ? { state: "error", why: "unexpected" } : { state: "ok", by }; return s; };
const rowOf = (html, id) => html.split('data-act="ctx" data-v="' + id + '"')[1].split('<div class="rw">')[0];
const gcellOf = (html, id) => text(rowOf(html, id).match(/<span class="g">(.*?)<\/span><span/)[1]).trim();
const bd = (over, edit) => state({ ct: { ...CT0(), bd: true }, ...(over || {}) }, edit);

// ───────────────────────── the cap card ─────────────────────────
test("cap card: Available cap space is the large figure with Total cap beside it (Total cap minus Cap charge); the old explanation and the 'Cap hits' label are gone", () => {
  const s = state(), tx = text(V.app(s)), blake = s.model.teams.find((x) => x.id === "0010");
  t.equal(blake.cap.capTotal + blake.cap.adjTotal, 298000); t.equal(s.model.capLimit, 300000, "the limit is read from the roster read, not typed into the app");
  t.match(tx, /Cap space · 2026 season \$2,000 Available cap space \$300,000 Total cap Breakdown ▸/);
  t.match(V.app(s), /<div class="big">\$2,000<\/div>/, "the available figure is the big one");
  t.doesNotMatch(tx, /Counts against the cap|Not cap room|Cap hits|Cap commitments by year|Cap charge ·/); t.doesNotMatch(tx, /Salaries, \d+ players/, "the Breakdown starts closed");
});

test("cap limit: read from the roster read's salary_cap_dollars; a missing, zero, negative, text or blank value is 'unavailable', never a guess", () => {
  t.equal(M.build(rosterRead(), null, null, 10, 2026).capLimit, 300000);
  t.equal(M.build(rosterRead((r) => { r.salary_cap_dollars = 250000; }), null, null, 10, 2026).capLimit, 250000, "whatever the read says");
  t.equal(M.build(rosterRead((r) => { r.salary_cap_dollars = "275000"; }), null, null, 10, 2026).capLimit, 275000, "a numeric string is a number");
  [undefined, null, 0, -1, "abc", "", "  ", true, NaN, Infinity].forEach((v) => t.equal(M.build(rosterRead((r) => { r.salary_cap_dollars = v; }), null, null, 10, 2026).capLimit, null, "unavailable for " + String(v)));
  t.equal(M.build(rosterRead((r) => { delete r.salary_cap_dollars; }), null, null, 10, 2026).capLimit, null);
  const none = state({}, (r) => { delete r.salary_cap_dollars; }), tx = text(V.app(none));
  t.match(tx, /\$298,000 Cap charge Total cap unavailable/); t.doesNotMatch(tx, /Available cap space/, "no available figure without a total cap"); t.doesNotMatch(tx, /\$300,000/);
  const open = text(V.app({ ...none, ct: { ...CT0(), bd: true } })); t.match(open, /Total committed cap \$325,000/); t.match(open, /Cap charge \$298,000 Total cap unavailable/); t.doesNotMatch(open, /Available cap space/);
});

test("Available cap space math: positive, zero, and negative (a minus sign, the warning color, and the words 'Over the cap')", () => {
  const at = (cap) => { const s = state({}, (r) => { r.salary_cap_dollars = cap; }); return { s, html: V.app(s), tx: text(V.app(s)) }; };
  const p = at(300000); t.match(p.tx, /\$2,000 Available cap space/); t.doesNotMatch(p.tx, /Over the cap/); t.doesNotMatch(p.html, /class="big wn"/);
  const z = at(298000); t.match(z.tx, /\$0 Available cap space/); t.doesNotMatch(z.tx, /Over the cap/);
  const n = at(290000); t.match(n.tx, /−\$8,000 Available cap space · Over the cap/); t.match(n.html, /<div class="big wn">−\$8,000<\/div>/); t.match(n.html, /<b class="wn">Over the cap<\/b>/);
  const open = text(V.app({ ...n.s, ct: { ...CT0(), bd: true } })); t.match(open, /Cap charge \$298,000 Total cap \$290,000 Available cap space −\$8,000/);
});

test("Breakdown: salaries, then the two reliefs, then Total committed cap, then the adjustments, then Cap charge, then Total cap and Available cap space, in that order, and it adds up", () => {
  const s = bd(), tx = text(V.app(s));
  t.match(tx, /Breakdown ▾/);
  t.match(tx, /Salaries, 38 players \$347,000 Taxi relief, 5 players −\$15,000 Injured reserve \(50%\), 3 players −\$7,000 Total committed cap \$325,000 2026 adjustments Cut penalties ▸ \+\$5,000 Traded salary ▸ −\$32,000 Other \$0 Rounding \$0 Total adjustments −\$27,000 Cap charge \$298,000 Total cap \$300,000 Available cap space \$2,000/);
  t.doesNotMatch(tx, /half counts|Cap hits|Recorded salaries/); t.doesNotMatch(tx, /FA Auction Fine|Other [▸▾]|Rounding [▸▾]/, "an empty category is a plain $0 parent row with nothing to open");
  // every recorded team: salaries less the reliefs is Total committed cap; plus the signed adjustments is Cap charge; Total cap minus Cap charge is Available cap space
  s.model.teams.forEach((tm) => {
    const b = A.capBreakdown(tm, tm.cap), G = { "Cut penalties": ["Cut Penalty"], "Traded salary": ["Traded Salary"], "Other": ["FA Auction Fine", "Other"], "Rounding": ["Rounding"] };
    t.ok(b.ok && tm.adjust.reconciled, tm.id); t.equal(b.recorded - b.taxi - b.irRelief, b.capHits); t.equal(b.capHits + tm.adjust.total, b.capCharge);
    const h = text(V.app({ ...s, teamId: tm.id })), av = s.model.capLimit - b.capCharge;
    // the four parent rows in order, each with its signed total, then Total adjustments
    const sm = (n) => (n > 0 ? "\\+" : n < 0 ? "−" : "") + money(n).replace("$", "\\$");
    t.match(h, new RegExp(Object.keys(G).map((g) => { const rows = tm.adjust.items.filter((i) => G[g].includes(i.category)); return g + (g !== "Rounding" && rows.length ? " ▸" : "") + " " + sm(rows.reduce((a, i) => a + i.amount, 0)); }).join(" ") + " Total adjustments " + sm(tm.adjust.total) + " Cap charge"), tm.id);
    t.match(h, new RegExp("Total committed cap " + money(b.capHits).replace("$", "\\$") + " ")); t.match(h, new RegExp("Cap charge " + money(b.capCharge).replace("$", "\\$") + " Total cap \\$300,000 Available cap space " + (av < 0 ? "−" : "") + money(av).replace("$", "\\$")));
  });
});

test("Rounding is a plain line item with no dropdown; the fine and the other categories keep theirs", () => {
  const s = bd(), five = s.model.teams.find((x) => x.adjust.items.some((i) => i.category === "FA Auction Fine" || i.category === "Rounding") && x.adjust.items.some((i) => i.category === "Rounding"));
  t.ok(five, "a recorded team has a Rounding row"); const html = V.app({ ...s, teamId: five.id }), tx = text(html);
  t.match(tx, /Rounding (−|\+)?\$[\d,]+/); t.doesNotMatch(html, /data-v="y26round"/, "no control opens Rounding"); t.doesNotMatch(tx, /Rounding [▸▾]/);
  const fine = s.model.teams.find((x) => x.adjust.items.some((i) => i.category === "FA Auction Fine")); t.match(text(V.app({ ...s, teamId: fine.id })), /Other ▸ \+\$3,000/, "the FA auction fine is under Other");
  // the Rounding amount is the category total, signed, and the lines still add up to the Cap charge
  const b = A.capBreakdown(five, five.cap); t.equal(b.capHits + five.adjust.total, b.capCharge); t.match(tx, new RegExp("Rounding " + (five.adjust.byCategory.Rounding < 0 ? "−" : "\\+") + "\\$" + Math.abs(five.adjust.byCategory.Rounding).toLocaleString("en-US")));
});

test("R6 one card for this season and the later years: no recorded-salary card, no 'Cap commitments by year'; later rows show the year and Total committed cap only; 2027 opens, 2028 has no Details", () => {
  const s = state(), html = body(V.app(s)), tx = text(html);
  t.equal((html.match(/<h2>/g) || []).length, 1, "one card: the cap card (the recorded-salary card is gone)"); t.equal((html.match(/<h2>Cap space/g) || []).length, 1);
  t.doesNotMatch(tx, /Recorded salary, not cap space|players? shown|Cap commitments by year|Counts against the cap|Not cap room|adjustments not recorded|adjustments not loaded|Adjustments pending|adjustments unavailable|Later years assume/);
  t.doesNotMatch(tx, /2026 \$298,000|2026 —/, "this season is the one figure above");
  const card = html.split('<div class="lbl">Show')[0];
  t.match(text(card), /Total committed cap, later years 2027 Details ▸ \$199,000 2028 \$40,000 $/);
  t.equal((card.match(/data-act="nsx"/g) || []).length, 1, "only 2027 opens"); const nsx = card.match(/<button class="link blk fy" data-act="nsx"[^>]*>([^]*?)<\/button>/)[1]; t.match(text(nsx), /2027/); t.doesNotMatch(text(nsx), /2028/, "2028 is not inside the 2027 control");
  t.doesNotMatch(tx, /What is and isn’t verified yet is in Help|Recorded in the UPS ledger/);
});

test("itemized detail: a cut penalty shows the player, the full cut date and the charge season; a settlement shows its category and the season, never a player", () => {
  const s = bd({ ct: { ...CT0(), bd: true, cat: { "y26cut": true, "y26trade": true } } }), html = V.app(s), tx = text(html);
  ["Minkah Fitzpatrick Cut Aug 13, 2025 \\+\\$1,000", "Gunnar Helm Cut Oct 4, 2025 \\+\\$1,000", "Efton Chism Cut Oct 25, 2025 \\+\\$1,000", "Kayvon Thibodeaux Cut Oct 25, 2025 \\+\\$2,000"].forEach((x) => t.match(tx, new RegExp(x), x));
  t.match(tx, /Traded salary ▾ −\$32,000/); t.match(tx, /Trade Trade details not recorded −\$5,000/); t.match(tx, /Trade Trade details not recorded \+\$12,000/, "a credit and a charge in the same category keep their signs"); t.match(tx, /Three-team trade Trade details not recorded −\$19,000/);
  t.doesNotMatch(tx, /Trade with/, "R8: no counterparty without a linked trade transaction (the settlement text is not evidence)");
  t.match(tx, /2026 adjustments Cut penalties ▾/, "the season once, in the heading"); t.doesNotMatch(tx, /Charged to/);
  t.doesNotMatch(tx, /Player Unknown/); t.doesNotMatch(tx, /Trade Cut /, "a settlement has no cut date");
  ["UPS drop penalty", "settlement", "adddrop", "trade_2026", "3-way", "id:", "explanation", "timestamp"].forEach((w) => t.doesNotMatch(html, new RegExp(w, "i"), w));
  // the fine: its category and the season; never Player Unknown, never a name
  const fine = s.model.teams.find((x) => x.adjust.items.some((i) => i.category === "FA Auction Fine")), fs_ = { ...bd({ ct: { ...CT0(), bd: true, cat: { "y26other": true } } }), teamId: fine.id }, ft = text(V.app(fs_));
  t.match(ft, /Other ▾ \+\$3,000 FA auction fine Rule 2, missed nomination, Jul 28, 2026 \(1st offense\) \+\$3,000 Rounding/, "the particular fine is named in its row, under Other"); t.doesNotMatch(ft, /Player Unknown|Name unavailable|(^|\s)…(\s|$)/);
});

test("names: a player who is on no roster (Dyami Brown, id 15292, team 0009) is named from MFL's complete player list by id; the row also shows his cut date from the drop time in its key", () => {
  const open = { ...CT0(), bd: true, cat: { "y26cut": true } }, nine = (over) => state({ teamId: "0009", ct: open, ...(over || {}) });
  const tm = nine().model.teams.find((x) => x.id === "0009"), dy = tm.adjust.items.find((i) => i.playerId === "15292");
  t.ok(dy && dy.playerName === null && dy.nameSource === null, "no roster in this read holds him, so the roster read cannot name him"); t.equal(dy.cutDate, "2026-05-22");
  t.equal(nine().model.byId["15292"], undefined);
  t.match(text(V.app(nine())), /Dyami Brown Cut May 22, 2026 \+\$1,000/, "named by id from the list, whatever roster he is on");
  // while the list loads: a quiet placeholder; if it failed: 'Name unavailable'; never Player Unknown for a player the list has not been asked about yet
  const loading = text(V.app(nine({ intel: { mu: {}, wk: {}, scores: {}, players: { state: "loading" } } }))), never = text(V.app(nine({ intel: { mu: {}, wk: {}, scores: {} } })));
  [loading, never].forEach((x) => { t.match(x, /… Cut May 22, 2026 \+\$1,000/); t.doesNotMatch(x, /Dyami Brown/); t.doesNotMatch(x, /Player Unknown|Name unavailable/); });
  const failed = text(V.app(nine({ intel: { mu: {}, wk: {}, scores: {}, players: { state: "error", error: "x" } } })));
  t.match(failed, /Name unavailable Cut May 22, 2026 \+\$1,000/); t.doesNotMatch(failed, /Player Unknown/);
  // Player Unknown only when the list loaded and does not hold the id
  const lacks = text(V.app(nine({ intel: { mu: {}, wk: {}, scores: {}, players: listOf("15292") } })));
  t.match(lacks, /Player Unknown Cut May 22, 2026 \+\$1,000/); t.doesNotMatch(lacks, /Dyami Brown/);
  // the reviewed list still names an add/drop row by its own mapping, and a roster-resolved name is not replaced by the list
  t.match(text(V.app(nine())), /D\.J\. Chark Cut Aug 17, 2025 \+\$1,000/);
  const withRoster = state({ teamId: "0009", ct: open, intel: { mu: {}, wk: {}, scores: {}, players: listOf() } }); const pid = "15292";
  withRoster.model.teams.find((x) => x.id === "0009").adjust.items.forEach((i) => { if (i.playerId === pid) { i.playerName = "Roster Name"; i.nameSource = "direct"; } });
  t.match(text(V.app(withRoster)), /Roster Name Cut May 22, 2026/);
});

test("Player Unknown: a cut row with neither a player id nor a reviewed-list match, even when the list has loaded; a row with a time that is not a plausible drop time says 'Cut date not recorded'; no source text is shown", () => {
  const edit = (r) => { const sm = r.teams.find((x) => x.franchise_id === "0010").summary; sm.salary_adjustment_raw_rows.push({ franchise_id: "0010", amount: 1000, explanation: "UPS drop penalty Someone 1000 id:adddrop2025_9999.1" }, { franchise_id: "0010", amount: 500, explanation: "UPS drop penalty Whoever 500 id:15292_1111111111" }); sm.salary_adjustment_total_dollars += 1500; };
  const s = state({ ct: { ...CT0(), bd: true, cat: { "y26cut": true } } }, edit), html = V.app(s), tx = text(html);
  t.ok(s.model.teams.find((x) => x.id === "0010").adjust.reconciled, "the extra rows are verified rows");
  t.match(tx, /Player Unknown Cut date not recorded \+\$1,000/, "no id, no reviewed match: Player Unknown, and no date");
  t.match(tx, /Dyami Brown Cut date not recorded \+\$500/, "his id is in the list; the time in the key is not a plausible date, so none is shown");
  t.doesNotMatch(html, /1111111111|adddrop2025_9999/);
});

test("a charge that is not a cut penalty never shows a player: a settlement, a fine or an 'Other' adjustment never reads Player Unknown or a name, with the list loaded or not", () => {
  [state().intel, { mu: {}, wk: {}, scores: {}, players: { state: "loading" } }, { mu: {}, wk: {}, scores: {}, players: { state: "error" } }].forEach((intel, i) => {
    const s = state({ intel, ct: { ...CT0(), bd: true, cat: { "y26trade": true, "y26other": true } } }, (r) => { const sm = r.teams.find((x) => x.franchise_id === "0010").summary; sm.salary_adjustment_raw_rows.push({ franchise_id: "0010", amount: 700, explanation: "Commissioner adjustment, see forum" }); sm.salary_adjustment_total_dollars += 700; });
    const tx = text(V.app(s)); t.match(tx, /Other ▾ \+\$700 Other adjustment \+\$700/, "state " + i); t.match(tx, /Trade Trade details not recorded −\$5,000/); t.doesNotMatch(tx.split("Traded salary ▾")[1].split("Cap charge")[0], /Player Unknown|Name unavailable|(^|\s)…(\s|$)/, "state " + i);
  });
});

test("a Breakdown that does not tie hides its lines and keeps the headline; an unverified record is said, not guessed", () => {
  const broken = text(V.app(bd({}, (r) => { r.teams.find((x) => x.franchise_id === "0010").summary.cap_total_dollars += 1000; })));
  t.match(broken, /\$299,000|\$298,000|\$1,000 Available cap space|\$3,000 Available cap space/); t.match(broken, /The salary lines don’t add up to the cap total, so only the total is shown\./); t.doesNotMatch(broken, /Recorded salaries, \d+ players/);
  const bad = text(V.app(bd({}, (r) => { r.teams.find((x) => x.franchise_id === "0010").summary.salary_adjustment_raw_rows[0].amount = "abc"; })));
  t.match(bad, /Detail unavailable: 1 record could not be verified/); t.doesNotMatch(bad, /Cut penalties ▸/); t.match(bad, /Total committed cap \$325,000/);
  const none = text(V.app(state({}, (r) => { delete r.teams.find((x) => x.franchise_id === "0010").summary; })));
  t.match(none, /Unavailable: this roster read did not include the team’s cap total\./); t.doesNotMatch(none, /\$298,000|Available cap space/);
});

test("later years: 2027 and 2028 count injured reserve in full and taxi at $0; 2027's Details hold its ledger adjustments in the same order as this season; 2028 has none and no Details", () => {
  const s = state(), tx = text(V.app(s));
  t.match(tx, /2027 Details ▸ \$199,000 2028 \$40,000/);
  const ok = withNext(state({ ct: { ...CT0(), cat: { "y27cut": true }, ns: true } }), LEDGER), h = text(V.app(ok));
  t.match(h, /2027 Details ▾ \$199,000 Total committed cap \$199,000 2027 adjustments Cut penalties ▾ \+\$1,000 Player Unknown Cut date not recorded \+\$1,000 Traded salary \$0 Other ▸ \+\$3,000 Rounding \$0 Total adjustments \+\$4,000 Cap charge \$203,000/);
  t.match(h, /Recorded by UPS; on MFL after the rollover\./);
  t.match(h, /2028 \$40,000/); t.doesNotMatch(h, /2028 Details/, "2028 has no adjustment source");
  const fine = withNext(state({ ct: { ...CT0(), cat: { "y27other": true }, ns: true } }), LEDGER); t.match(text(V.app(fine)), /Other ▾ \+\$3,000 FA auction fine Rule 2 \+\$3,000/);
});

test("2027 states: loading, failed (Couldn't load this, Retry, disabled Report bug), none recorded, waiting for a price, not counted", () => {
  const open = { ...CT0(), ns: true };
  t.match(text(V.app(state({ ct: open, ns: { state: "loading" } }))), /Loading…/);
  const err = V.app(state({ ct: open, ns: { state: "error", why: "read" } })), e = text(err);
  t.match(e, /Couldn’t load this/); t.match(err, /data-act="retryns"/); t.match(err, /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/); t.match(e, /2027 Details ▾ \$199,000/); t.doesNotMatch(e, /Total adjustments|Cap charge \$2\d\d/);
  const empty = text(V.app(withNext(state({ ct: open }), { ok: true, rows: [], by_fid: {}, held_unpriced: [], needs_review: [] })));
  t.match(empty, /No 2027 adjustments recorded yet\./); t.match(empty, /2027 Details ▾ \$199,000/);
  const held = text(V.app(withNext(state({ ct: open }), { ...LEDGER, held_unpriced: [{ franchise_id: "0010", player_id: "9" }], needs_review: [{ franchise_id: "0010" }] })));
  t.match(held, /1 cut is waiting for a price and not counted\./); t.match(held, /1 cut needs review and not counted\./); t.doesNotMatch(held, /Cap charge \$20\d,000/, "an incomplete year draws no cap charge");
});

test("2027 cut dates: dropped_at_iso (UTC) is shown as the Eastern Time date, only on a drop; one name from the list, one id not in it", () => {
  const ledger = { ok: true, by_fid: { "0010": { total: 2000 } }, held_unpriced: [], needs_review: [], rows: [
    { player_id: "15292", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-08-09T01:30:00.000Z", kind: "Drop (next season)", in_mfl: false },
    { player_id: "99999", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-08-08T13:26:53.000Z", kind: "Drop (next season)", in_mfl: false }] };
  const h = text(V.app(withNext(state({ ct: { ...CT0(), cat: { "y27cut": true }, ns: true } }), ledger)));
  t.match(h, /Dyami Brown Cut Aug 8, 2026 \+\$1,000/, "01:30 UTC on Aug 9 is 9:30 PM ET on Aug 8; he is on no roster, so the list names him"); t.match(h, /Player Unknown Cut Aug 8, 2026 \+\$1,000/);
  const loading = text(V.app(withNext(state({ ct: { ...CT0(), cat: { "y27cut": true }, ns: true }, intel: { mu: {}, wk: {}, scores: {}, players: { state: "loading" } } }), ledger)));
  t.match(loading, /… Cut Aug 8, 2026 \+\$1,000/); t.doesNotMatch(loading, /Player Unknown|Dyami Brown/, "no 'Player Unknown' while the list is out (the placeholder is quiet), and no name until it arrives");
});

test("2027 gap: Help names three separate statements (completeness, reconciliation, calculation) and never says an amount is wrong", () => {
  const h = text(V.app(state({ sheet: "help" })));
  t.match(h, /Source completeness is not confirmed/); t.match(h, /Reconciliation: the listed amounts add up to the ledger’s own team total/); t.match(h, /Calculation: each amount is UPS’s cut-charge calculation/); t.match(h, /Nothing here says an amount is wrong/);
  t.doesNotMatch(h, /incorrect|may be wrong|unreliable/i);
  t.doesNotMatch(text(V.app(state({ ct: { ...CT0(), ns: true } }))), /Source completeness|Reconciliation:|Calculation: each/, "the three statements live in Help, not on the screen");
});

test("one Help control per Team screen, with text for the tab: the cap terms, names and cut dates, the guarantee terms and the assumptions live there", () => {
  ["roster", "contracts", "performance"].forEach((sub) => { const html = V.app(state({ sub })); t.equal((html.match(/data-act="help"/g) || []).length, 1, sub + ": exactly one help control"); t.match(html, /aria-label="Help for this screen"/); });
  const h = text(V.app(state({ sheet: "help" })));
  ["Available cap space Total cap minus Cap charge", "Total cap The salary cap for the season", "Total committed cap Salaries, less taxi relief", "Cap charge Total committed cap plus or minus the adjustments"].forEach((x) => t.match(h, new RegExp(x), x));
  t.match(h, /Planning assumption for later years/); t.match(h, /No injury relief is projected/); t.match(h, /taxi-eligible player can be released with a \$0 cut charge/);
  t.match(h, /A name comes from the player ID on the charge, looked up in MFL’s complete player list/); t.match(h, /UPS’s reviewed list/); t.match(h, /Otherwise it reads|If neither names him it reads “Player Unknown”/);
  t.match(h, /Dates are Eastern Time and shown only when verified/); t.match(h, /Cut date not recorded/); t.match(h, /Waiver drops process at 9:00 AM ET/); t.match(h, /charge season/i);
  t.match(h, /If cut now What cutting the player today would charge against the cap/); t.match(h, /No guarantee \(a one-year original contract under \$5K, or a waiver pickup of \$4K or less in its final year, is cut free\)/); t.match(h, /\$1K rule \(a contract worth under \$5K costs \$1K while two or more years remain and nothing in its final year\)/);
  t.match(h, /Contract Type and Source Contract Type is Veteran or Rookie/); t.match(h, /this preview has no trade records, so each says “Trade details not recorded”/);
  t.doesNotMatch(h, /Remaining guarantee|Weekly guarantee/, "R8: the Remaining guarantee entries are gone");
  const r = text(V.app(state({ sheet: "help", sub: "roster" }))); t.match(r, /Can’t check/); t.match(r, /Recorded starters/); t.match(r, /Doubtful/);
});

test("copy: owner-facing text never says worker, contract text or caching, on any Contracts state, the profile, Help or About", () => {
  const states = [state(), state({ ct: { ...CT0(), bd: true, cat: { "y26cut": true }, ns: true } }), state({ ns: { state: "error" }, ct: { ...CT0(), ns: true } }),
    state({ penalty: { state: "error", error: "HTTP 500" } }), state({ sheet: "help" }), state({ sheet: "help", sub: "roster" }), state({ sheet: "about" }),
    state({ tab: "team", sub: "contracts", profile: { pid: FX.teams[9].players[0].id, tab: "contract" }, penalty: { state: "error", error: "HTTP 500" }, flags: { rules: true, earned: true, cut: true, raw: true } }),
    state({ ct: { ...CT0(), bd: true, cat: { "y26cut": true } }, intel: { mu: {}, wk: {}, scores: {}, players: { state: "error", error: "HTTP 502" } } })];
  states.forEach((s, i) => { const tx = text(V.app(s)); t.doesNotMatch(tx, /worker|contract text|cache|cached|caching/i, "state " + i); t.doesNotMatch(tx, /HTTP \d{3}/, "no error code reaches an owner: state " + i); });
  t.doesNotMatch(text(V.app(states[7])), /Recorded contract text/);
});

test("taxi wording (R8): 'Taxi-eligible' once per player; the $0 is the If cut now line under the Taxi rule, not repeated; the sentence is in Help", () => {
  const s = state({ ct: CT0() }), blake = s.model.teams.find((x) => x.id === "0010"), tp = blake.players.find((p) => p.status === "taxi");
  tp.taxi = { used: 0, max: 3, eligible: true, text: "" }; s.ct.open[tp.id] = true; s.penalty = { state: "ok", data: { [tp.id]: { penalty: 0, guaranteed: 2000, earned: 0, basis: "taxi_exempt", exempt_reason: "taxi" } }, meta: {} };
  const tx = text(V.app(s)); t.equal((tx.match(/Taxi-eligible/g) || []).length, 1); t.match(tx, /If cut now \$0 Taxi rule: a taxi-eligible player is cut cap-free\./);
  t.doesNotMatch(tx, /\$0 cut charge|Recorded guarantee|Remaining guarantee|Guarantee \$2,000/, "no repeated charge, and no guarantee line under a non-guarantee rule");
  s.penalty = { state: "idle" }; const tx2 = text(V.app(s)); t.match(tx2, /Taxi-eligible/); t.doesNotMatch(tx2, /\$0/, "no cut-charge claim until the calculation loads");
});

// ───────────────────────── R8: If cut now, one amount under the Worker's rule ─────────────────────────
const SMALL = { penalty: 0, guaranteed: 0, earned: null, exempt_reason: "" };
// [key, worker row, the cell, the Details rule sentence]
const GROWS = [
  ["ww_na", { ...SMALL, basis: "ww_under_5k_earned_na", earned_rule: "ww_earned_na", exempt_reason: "WW pickup salary ≤ $4K, final year (§D2)." }, "$0 No guarantee", "No-guarantee rule: a waiver pickup of \\$4K or less in its final year is cut free\\."],
  ["ww_ex", { ...SMALL, basis: "ww_under_5k_exempt", earned_rule: "full_year_sub_5k", exempt_reason: "WW pickup salary ≤ $4K, final year (§D2)." }, "$0 No guarantee", "No-guarantee rule: a waiver pickup of \\$4K or less in its final year is cut free\\."],
  ["one_yr", { ...SMALL, basis: "one_year_under_5k_exempt", earned_rule: "full_year_sub_5k", exempt_reason: "1-year original contract under $5K (§D2)." }, "$0 No guarantee", "No-guarantee rule: a one-year original contract under \\$5K is cut free\\."],
  ["flat1k", { ...SMALL, basis: "full_year_1k_contract", earned_rule: "full_year_sub_5k", penalty: 1000 }, "$1,000 $1K rule", "\\$1K drop rule: a contract worth under \\$5K costs \\$1K to cut while two or more years remain, and nothing in its final year\\."],
  ["flat", { ...SMALL, basis: "tcv_under_5k_flat", penalty: 1000 }, "$1,000 $1K rule", "\\$1K drop rule"],
  ["tcv", { ...SMALL, basis: "tcv_under_5k_final_year_exempt", earned_rule: "full_year_sub_5k", exempt_reason: "Sub-5K TCV in its final year (or a 1-year deal) — cap-free (§D2)." }, "$0 $1K rule", "\\$1K drop rule: a contract worth under \\$5K costs \\$1K to cut while two or more years remain, and nothing in its final year\\."],
  ["new", { ...SMALL, basis: "a_rule_the_preview_has_never_seen", earned_rule: "full_year_sub_5k" }, "$0", "The cap calculation names a rule this preview does not know\\."],
  ["zero", { basis: "no_penalty_zero", guaranteed: 129000, earned: 145647, penalty: 0, exempt_reason: "Earned ≥ guaranteed (no penalty)." }, "$0 Fully earned", "Guarantee rule: the guaranteed amount is fully earned, so nothing is owed\\."],
  ["amt", { basis: "guarantee_minus_earned", guaranteed: 20000, earned: 5000, penalty: 15000 }, "$15,000", "Guarantee rule: the guaranteed amount not yet earned\\."],
  ["nofig", { basis: "guarantee_minus_earned", guaranteed: 20000, earned: 5000, penalty: null }, "Unavailable", "Unavailable No cut charge in the cap calculation for this contract\\."]
];

test("R8 If cut now: the column header; one amount per contract from the Worker's penalty under its own rule; Details name the rule without arithmetic; the guarantee line only under the guarantee rule", () => {
  const s0 = state(), ps = s0.model.teams.find((x) => x.id === "0010").players.slice(0, GROWS.length), data = {}, open = {};
  ps.forEach((p, i) => { data[p.id] = GROWS[i][1]; open[p.id] = true; });
  const s = state({ penalty: { state: "ok", data, meta: { calculatedAt: "x", earnedThroughWeek: 10 } }, ct: { ...CT0(), open } }), html = body(V.app(s));
  t.match(html, /<span>If cut now<\/span><span>2026<\/span>/); t.doesNotMatch(text(html), /Remaining guarantee|Recorded guarantee|Weekly guarantee|Guarantee left|Not tracked|minus earned/);
  ps.forEach((p, i) => {
    const [key, row, cell, words] = GROWS[i], r = text(rowOf(html, p.id));
    t.equal(gcellOf(html, p.id), cell, key + ": the cell");
    t.match(r, new RegExp("If cut now " + (row.penalty != null && key !== "nofig" ? "\\$[\\d,]+ " : "") + words), key + ": the rule sentence");
    const guar = key === "zero" || key === "amt";
    if (guar) t.match(r, key === "zero" ? /Guarantee \$129,000 \$145,647 earned through Week 10/ : /Guarantee \$20,000 \$5,000 earned through Week 10/, key + ": the original guarantee and earned through the week");
    else t.doesNotMatch(r, /Guarantee \$/, key + ": no guarantee line outside the guarantee rule");
  });
  // the amount is the Worker's penalty, never recomputed: a guarantee row whose penalty disagrees with guaranteed − earned still shows the penalty
  const odd = state({ penalty: { state: "ok", data: { [ps[0].id]: { basis: "guarantee_minus_earned", guaranteed: 20000, earned: 5000, penalty: 14999 } }, meta: {} }, ct: CT0() });
  t.equal(gcellOf(body(V.app(odd)), ps[0].id), "$14,999");
  // a failed or missing read is never $0 or 'Fully earned'
  const failed = body(V.app(state({ penalty: { state: "error", error: "x" }, ct: { ...CT0(), open } })));
  t.doesNotMatch(text(failed), /Fully earned|No guarantee|\$1K rule/); t.match(failed, /<span class="g"><span class="wn">Unavailable<\/span><\/span>/);
  t.match(body(V.app(state({ penalty: { state: "ok", data: { [ps[0].id]: { ...GROWS[8][1], needs_review: true, review_reason: "Held" } }, meta: {} }, ct: CT0() }))), /<span class="g"><span class="wn">Under review<\/span><\/span>/);
});

test("R8 cutRule: every basis in the recording maps to one of the four rules; an unknown basis is 'unknown' and names no rule", () => {
  const seen = { guarantee: ["guarantee_minus_earned", "no_penalty_zero"], none: ["one_year_under_5k_exempt", "ww_under_5k_exempt", "ww_under_5k_earned_na"], onek: ["full_year_1k_contract", "tcv_under_5k_flat", "tcv_under_5k_final_year_exempt"], taxi: ["taxi_exempt", "taxi_callup_exempt", "taxi_eligible_exempt"] };
  Object.keys(seen).forEach((rule) => seen[rule].forEach((b) => t.equal(C.cutRule({ basis: b, penalty: 0 }).rule, rule, b)));
  t.equal(C.cutRule({ basis: "guarantee_minus_earned", penalty: 0 }).tag, "Fully earned"); t.equal(C.cutRule({ basis: "guarantee_minus_earned", penalty: 5 }).tag, "");
  t.equal(C.cutRule({ basis: "zzz" }).rule, "unknown"); t.equal(C.cutRule(null).rule, "unknown"); t.equal(C.cutRule({ basis: "toString" }).rule, "unknown", "no prototype key is a rule");
});

// ───────────────────────── labels, the sort control and opening a profile ─────────────────────────
const idsOf = (html) => [...html.matchAll(/data-act="ctx" data-v="(\d+)"/g)].map((m) => m[1]);
const segOf = (html) => [...html.matchAll(/<button data-act="cts" data-v="(\w+)" aria-pressed="(true|false)" aria-label="([^"]*)">([^<]*)(?:<span[^>]*>([^<]*)<\/span>)?<\/button>/g)].map((m) => ({ v: m[1], on: m[2] === "true", label: m[3], text: m[4].trim(), arrow: m[5] || "" }));
const chipsOf = (html) => [...html.matchAll(/<button class="ch" data-act="cty" data-v="(\d)" aria-pressed="(true|false)" aria-label="([^"]*)">(\d{4})<\/button>/g)].map((m) => ({ y: +m[1], on: m[2] === "true", label: m[3], text: m[4] }));
const sorted = (s, ct) => body(V.app({ ...s, ct: { ...CT0(), ...ct } }));
const salOf = (p, k) => { const r = C.schedule(p, 2026).rows; return k < r.length ? r[k].amount || 0 : 0; };

test("labels: 'Expires 2026 · N players' replaces 'Ends after'; '2026 salary' (year first, from the season) replaces 'Salary 2026'", () => {
  const s = state(), html = body(V.app(s)), tx = text(html);
  t.match(tx, /Expires 2026 · \d+ players?/); t.match(tx, /\$[\d.]+K 2026 salary/, "the group total names its salary year"); t.doesNotMatch(tx, /Ends after|Salary 202\d|Guarantee left/);
  const heads = [...html.matchAll(/Expires <b>(\d{4})<\/b>/g)].map((m) => +m[1]); t.ok(heads.length >= 2); t.deepEqual(heads, heads.slice().sort((a, b) => a - b), "soonest first by default");
  const s27 = state({ model: M.build(rosterRead(), null, null, 10, 2027) }), h27 = body(V.app({ ...s27, ct: { ...CT0(), s: "sal" } })); t.deepEqual(chipsOf(h27).map((c) => c.text), ["2027", "2028", "2029"], "the years follow the season");
});

test("sort control: one three-segment control Salary | Expiration | Name; defaults Expiration ascending (▲), Salary descending (▼), Name ascending (▲); year chips only under Salary", () => {
  const s = state(), exp = sorted(s, {}), sal = sorted(s, { s: "sal", d: -1 }), nm = sorted(s, { s: "name" });
  [exp, sal, nm].forEach((h) => { t.deepEqual(segOf(h).map((x) => x.text), ["Salary", "Contract exp.", "Name"], "one control, three segments"); t.equal((h.match(/data-act="cts"/g) || []).length, 3); t.doesNotMatch(h, /data-v="end"|data-v="y[01]"/, "the old row of sort buttons is gone"); });
  t.deepEqual(segOf(exp).filter((x) => x.on).map((x) => [x.v, x.arrow]), [["exp", "▲"]]); t.equal(chipsOf(exp).length, 0, "no year chips unless Salary is the sort"); t.doesNotMatch(exp, /data-act="cty"/);
  t.deepEqual(segOf(sal).filter((x) => x.on).map((x) => [x.v, x.arrow]), [["sal", "▼"]]); t.deepEqual(chipsOf(sal).map((c) => c.text), ["2026", "2027", "2028"], "2026 | 2027 | 2028, from the season");
  t.deepEqual(segOf(nm).filter((x) => x.on).map((x) => [x.v, x.arrow]), [["name", "▲"]]); t.equal(chipsOf(nm).length, 0);
  t.match(segOf(exp).find((x) => x.on).label, /Sorted by contract expiration, soonest first\. Tap to reverse\./); t.match(segOf(sal).find((x) => x.on).label, /Sorted by salary, highest first\. Tap to reverse\./); t.match(segOf(nm).find((x) => x.on).label, /Sorted by name, A to Z\. Tap to reverse\./);
  t.equal(segOf(exp).find((x) => !x.on).arrow, "", "only the active segment shows a direction"); t.match(segOf(exp).find((x) => x.v === "sal").label, /^Sort by salary$/);
  t.equal(chipsOf(sal).filter((c) => c.on).length, 1); t.equal(chipsOf(sal).find((c) => c.on).y, 0, "this season is the default year"); t.match(chipsOf(sal)[1].label, /^2027 salary$/);
  // the old state values still draw a valid screen (Expiration ascending)
  t.deepEqual(segOf(sorted(s, { s: "end" })).filter((x) => x.on).map((x) => x.v), ["exp"]);
});

test("sort: tapping a different sort starts in its own direction; tapping the active sort reverses it, every time; the year chip picks the salary year", () => {
  const n = (ct, v) => TV.ctNextSort(ct, v);
  t.deepEqual(n({ s: "exp", d: 1 }, "sal"), { s: "sal", d: -1 }); t.deepEqual(n({ s: "sal", d: -1 }, "name"), { s: "name", d: 1 }); t.deepEqual(n({ s: "name", d: 1 }, "exp"), { s: "exp", d: 1 });
  t.deepEqual(n({ s: "sal", d: -1 }, "sal"), { s: "sal", d: 1 }); t.deepEqual(n({ s: "sal", d: 1 }, "sal"), { s: "sal", d: -1 });
  t.deepEqual(n({ s: "exp", d: 1 }, "exp"), { s: "exp", d: -1 }); t.deepEqual(n({ s: "name", d: -1 }, "name"), { s: "name", d: 1 });
  t.deepEqual(n({}, "exp"), { s: "exp", d: -1 }, "nothing stored means Expiration ascending, so tapping it reverses"); t.deepEqual(n(undefined, "sal"), { s: "sal", d: -1 });
  t.deepEqual(n({ s: "sal", d: -1 }, "__proto__"), { s: "sal", d: 1 }, "an unknown value is the active sort again");
  const s = state(), tm = s.model.teams.find((x) => x.id === "0010").players;
  [0, 1, 2].forEach((y) => {
    const down = idsOf(sorted(s, { s: "sal", y, d: -1 })), up = idsOf(sorted(s, { s: "sal", y, d: 1 }));
    t.equal(down.length, tm.length); t.deepEqual(up, down.slice().reverse(), "reversing is the exact reverse of the list (year " + y + ")");
    const sal = down.map((id) => salOf(tm.find((p) => p.id === id), y)); t.deepEqual(sal, sal.slice().sort((a, b) => b - a), "highest first for year index " + y);
    t.equal(chipsOf(sorted(s, { s: "sal", y, d: -1 })).find((c) => c.on).y, y);
  });
  t.ok(idsOf(sorted(s, { s: "sal", y: 0, d: -1 })).join() !== idsOf(sorted(s, { s: "sal", y: 1, d: -1 })).join(), "the year changes the order");
  const nameAsc = idsOf(sorted(s, { s: "name", d: 1 })), names = nameAsc.map((id) => tm.find((p) => p.id === id).name); t.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)), "A to Z");
  t.deepEqual(idsOf(sorted(s, { s: "name", d: -1 })), nameAsc.slice().reverse()); t.match(sorted(s, { s: "name", d: -1 }), /Sorted by name, Z to A/); t.deepEqual(segOf(sorted(s, { s: "name", d: -1 })).filter((x) => x.on).map((x) => x.arrow), ["▼"]);
  t.match(segOf(sorted(s, { s: "sal", d: 1 })).find((x) => x.on).label, /Sorted by salary, lowest first/); t.deepEqual(segOf(sorted(s, { s: "sal", d: 1 })).filter((x) => x.on).map((x) => x.arrow), ["▲"]);
});

test("Expiration keeps its grouped layout; reversing reverses the group order and the order inside each group", () => {
  const s = state(), asc = sorted(s, { s: "exp", d: 1 }), desc = sorted(s, { s: "exp", d: -1 }), tm = s.model.teams.find((x) => x.id === "0010").players;
  const heads = (h) => [...h.matchAll(/Expires <b>(\d{4})<\/b>/g)].map((m) => +m[1]);
  t.ok(heads(asc).length >= 2); t.deepEqual(heads(desc), heads(asc).slice().reverse(), "the groups run the other way");
  const withYears = (h) => idsOf(h).filter((id) => tm.find((p) => p.id === id).years > 0);
  t.deepEqual(withYears(desc), withYears(asc).slice().reverse(), "and so does every list inside them");
  t.equal(idsOf(asc).length, tm.length); t.equal(idsOf(desc).length, tm.length);
  t.equal((asc.match(/<div class="gh2">/g) || []).length, (desc.match(/<div class="gh2">/g) || []).length, "the same groups");
});

test("the player's name opens the profile and a separate, labeled control opens the details; both are real buttons at least 44 px tall", () => {
  const s = state(), open = sorted(s, { open: {} }), tm = s.model.teams.find((x) => x.id === "0010").players, p = tm[0];
  t.equal((open.match(/data-act="card"/g) || []).length, tm.length, "every row has a name control that opens a profile"); t.equal((open.match(/data-act="ctx"/g) || []).length, tm.length, "and a details control");
  const nm = open.match(new RegExp('<button class="nmb" data-act="card" data-pid="' + p.id + '" aria-label="Open ([^"]*) profile">([^]*?)</button>')), dt = open.match(new RegExp('<button class="rb dtl" data-act="ctx" data-v="' + p.id + '" aria-expanded="(true|false)" aria-label="([^"]*)">([^]*?)</button>'));
  t.ok(nm && dt, "both controls exist for the same player"); t.match(text(nm[2]), new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); t.doesNotMatch(nm[0], /data-act="ctx"/); t.doesNotMatch(dt[0], /data-act="card"/, "the details control does not open a profile");
  t.equal(dt[1], "false"); t.match(dt[2], /^Show contract details for /); t.match(text(dt[3]), /Details ▸/);
  const shown = sorted(s, { open: { [p.id]: true } }); t.match(shown, new RegExp('data-act="ctx" data-v="' + p.id + '" aria-expanded="true" aria-label="Hide contract details for ')); t.match(shown, /<div class="det">/);
  t.doesNotMatch(text(shown), /’s profile|Open .* profile/, "the link inside the details is gone: the name is one tap away");
  t.match(CSS, /\.nmb\{[^}]*min-height:44px/); t.match(CSS, /\.rb\{[^}]*min-height:44px/); t.match(CSS, /\.seg button\{[^}]*min-height:44px/); t.match(CSS, /\.ch\{[^}]*min-height:44px/);
  t.doesNotMatch(open, /<(div|span)[^>]*data-act="(card|ctx)"/, "real buttons, so they are keyboard reachable");
});

run("mobile2027_contracts_pra");
