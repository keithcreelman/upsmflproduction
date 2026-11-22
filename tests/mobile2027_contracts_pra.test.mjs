// UPS 2027 beta (PR A): the Contracts screen: cap charge headline and Breakdown, itemized detail, cap commitments by year, the 2027 states, the
// Help control, the failure pattern, and owner-facing wording.
//   node tests/mobile2027_contracts_pra.test.mjs
// Recorded data: tests/fixtures/mobile2027/adjust_2026_wk10.json (Week 10 roster read, 12 teams, player names in adjustment text replaced).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib");
const require = createRequire(import.meta.url);
const A = require(path.join(SRC, "adjust.js")), M = require(path.join(SRC, "model.js")), V = require(path.join(SRC, "views.js")), TV = require(path.join(SRC, "tabviews.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/adjust_2026_wk10.json"), "utf8"));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const rosterRead = (edit) => { const r = { ok: true, generated_at: "2026-11-21T14:00:00Z", teams: FX.teams.map((tm) => ({ franchise_id: tm.franchise_id, franchise_name: "Team " + tm.franchise_id, summary: JSON.parse(JSON.stringify(tm.summary)),
  players: tm.players.map((p) => ({ id: p.id, name: "Player, " + p.id, position: "WR", nfl_team: "KCC", salary: p.salary_unresolved ? 0 : p.salary, salary_unresolved: p.salary_unresolved === true, years: p.years, type: "Veteran", special: p.special, status: p.status })) })) }; if (edit) edit(r); return r; };
const state = (over, edit) => ({ model: M.build(rosterRead(edit), null, null, 10, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup", open: {}, flags: {},
  profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {} }, ct: { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: false },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const money = (n) => "$" + Math.abs(n).toLocaleString("en-US");
const LEDGER = { ok: true, by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [
  { player_id: "99999", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-09-01", kind: "Drop (next season)", in_mfl: false },
  { player_id: null, franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28", kind: "RULE 2 fine (next season)", in_mfl: false }] };
const withNext = (s, ledger) => { const season = s.model.season + 1; const by = {}; let bad = false; s.model.teams.forEach((tm) => { const p = A.parseNextSeason(ledger, { fid: tm.id, season, resolveName: A.nameResolver(s.model, null) }); if (p.state !== "ok") bad = true; else by[tm.id] = p; }); s.ns = bad ? { state: "error", why: "unexpected" } : { state: "ok", by }; return s; };

test("cap charge: the headline is the roster read's cap total plus adjustments, labeled 'Not cap room', with a Breakdown that starts closed", () => {
  const s = state(), tx = text(V.app(s)), blake = s.model.teams.find((x) => x.id === "0010");
  t.match(tx, /Cap charge · 2026 season/); t.match(tx, /\$298,000/); t.match(tx, /Counts against the cap\. Not cap room\./); t.match(tx, /Breakdown ▸/); t.doesNotMatch(tx, /Recorded salaries, \d+ players/);
  t.equal(blake.cap.capTotal + blake.cap.adjTotal, 298000);
});

test("Breakdown: salary lines add to the cap hits, the five categories show only when they have rows, and everything adds to the headline", () => {
  const s = state({ ct: { f: "all", s: "end", open: {}, bd: true, cat: {}, ns: false } }), tx = text(V.app(s));
  t.match(tx, /Breakdown ▾/); t.match(tx, /Recorded salaries, 38 players \$347,000/); t.match(tx, /Taxi squad, 5 players −\$15,000/); t.match(tx, /Injured reserve, 3 players \(half counts\) −\$7,000/);
  t.match(tx, /Cap hits \$325,000/); t.match(tx, /Cut Penalty ▸ \+\$5,000/); t.match(tx, /Traded Salary ▸ −\$32,000/); t.match(tx, /Cap charge \$298,000/);
  t.doesNotMatch(tx, /FA Auction Fine|Rounding|Other ▸/, "a category with no rows is not shown");
  // every recorded team: the lines on screen add up to the headline, and a category appears exactly when it has rows
  s.model.teams.forEach((tm) => { const b = A.capBreakdown(tm, tm.cap), cats = Object.keys(tm.adjust.byCategory).filter((c) => tm.adjust.items.some((i) => i.category === c));
    t.ok(b.ok && tm.adjust.reconciled, tm.id); t.equal(b.capHits + tm.adjust.total, b.capCharge); const h = text(V.app({ ...s, teamId: tm.id })); cats.forEach((c) => t.match(h, new RegExp(c + " ▸"))); });
  const five = s.model.teams.find((x) => x.adjust.items.some((i) => i.category === "FA Auction Fine")), h5 = text(V.app({ ...s, teamId: five.id }));
  t.match(h5, /FA Auction Fine ▸ \+\$3,000/); t.match(h5, /Rounding ▸/);
});

test("itemized detail: player (only for cut penalties), season, signed amount; Player Unknown without an authoritative id; no source text, ids or dates", () => {
  const cat = { y26: 1 }; const s = state({ ct: { f: "all", s: "end", open: {}, bd: true, cat: { "y26Cut Penalty": true, "y26Traded Salary": true }, ns: false } }), html = V.app(s), tx = text(html);
  t.equal((tx.match(/Player Unknown · 2026/g) || []).length, 4, "Blake's four cut penalties carry an add/drop id, not a player id");
  t.match(tx, /Traded Salary ▾ −\$32,000/); t.match(tx, /— · 2026 −\$5,000/); t.match(tx, /— · 2026 \+\$12,000/, "a credit and a charge in the same category keep their signs");
  ["UPS drop penalty", "settlement", "adddrop", "trade_2026", "3-way", "id:", "explanation", "timestamp"].forEach((w) => t.doesNotMatch(html, new RegExp(w, "i"), w));
});

test("a Breakdown that does not tie hides its lines and keeps the headline; an unverified record is said, not guessed", () => {
  const broken = text(V.app(state({ ct: { f: "all", s: "end", open: {}, bd: true, cat: {}, ns: false } }, (r) => { r.teams.find((x) => x.franchise_id === "0010").summary.cap_total_dollars += 1000; })));
  t.match(broken, /\$299,000|\$298,000/); t.match(broken, /The salary lines don’t add up to the cap total, so only the total is shown\./); t.doesNotMatch(broken, /Recorded salaries, \d+ players/);
  const bad = text(V.app(state({ ct: { f: "all", s: "end", open: {}, bd: true, cat: {}, ns: false } }, (r) => { r.teams.find((x) => x.franchise_id === "0010").summary.salary_adjustment_raw_rows[0].amount = "abc"; })));
  t.match(bad, /Detail unavailable: 1 record could not be verified/); t.doesNotMatch(bad, /Cut Penalty ▸/); t.match(bad, /Cap hits \$325,000/);
  const none = text(V.app(state({}, (r) => { delete r.teams.find((x) => x.franchise_id === "0010").summary; })));
  t.match(none, /Unavailable: this roster read did not include the team’s cap total\./); t.doesNotMatch(none, /\$298,000/);
});

test("cap commitments by year: 2026 from the roster read; 2027 and 2028 count injured reserve in full and taxi at $0; adjustments are never $0 when unknown", () => {
  const s = state(), tx = text(V.app(s));
  t.match(tx, /Cap commitments by year/); t.match(tx, /2026 \$298,000 Cap hits \$325,000 · adjustments −\$27,000/);
  t.match(tx, /2027 — Cap hits \$199,000 · adjustments not loaded/); t.match(tx, /2028 — Cap hits \$40,000 · adjustments not recorded/);
  t.match(tx, /taxi players stay on taxi \(\$0\) and injured reserve counts at full salary/);
  const ok = withNext(state({ ct: { f: "all", s: "end", open: {}, bd: false, cat: { "y27Cut Penalty": true }, ns: true } }), LEDGER), h = text(V.app(ok));
  t.match(h, /2027 \$203,000 Cap hits \$199,000 · adjustments \+\$4,000/); t.match(h, /Recorded in the UPS ledger, not yet on MFL\./); t.match(h, /Player Unknown · 2027 \+\$1,000/); t.match(h, /FA Auction Fine ▸ \+\$3,000/);
  t.match(h, /2028 — /, "2028 stays unknown");
});

test("2027 states: loading, failed (Couldn't load this, Retry, disabled Report bug), none recorded, waiting for a price, not counted", () => {
  const open = { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: true };
  t.match(text(V.app(state({ ct: open, ns: { state: "loading" } }))), /Loading…/);
  const err = V.app(state({ ct: open, ns: { state: "error", why: "read" } })), e = text(err);
  t.match(e, /Couldn’t load this/); t.match(err, /data-act="retryns"/); t.match(err, /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/); t.match(e, /2027 — Cap hits \$199,000 · adjustments couldn’t load/); t.doesNotMatch(e, /2027 \$/);
  const empty = text(V.app(withNext(state({ ct: open }), { ok: true, rows: [], by_fid: {}, held_unpriced: [], needs_review: [] })));
  t.match(empty, /No 2027 adjustments recorded yet\./); t.match(empty, /2027 \$199,000 Cap hits \$199,000 · adjustments \+?\$?0|2027 \$199,000/);
  const held = text(V.app(withNext(state({ ct: open }), { ...LEDGER, held_unpriced: [{ franchise_id: "0010", player_id: "9" }], needs_review: [{ franchise_id: "0010" }] })));
  t.match(held, /1 cut is waiting for a price and not counted\./); t.match(held, /1 cut needs review and not counted\./); t.match(held, /adjustments incomplete/); t.doesNotMatch(held, /2027 \$20\d,000/);
});

test("2027 gap: Help names three separate statements (completeness, reconciliation, calculation) and never says an amount is wrong", () => {
  const h = text(V.app(state({ sheet: "help" })));
  t.match(h, /Source completeness is not confirmed/); t.match(h, /Reconciliation: the listed amounts add up to the ledger’s own team total/); t.match(h, /Calculation: each amount is UPS’s cut-charge calculation/); t.match(h, /Nothing here says an amount is wrong/);
  t.doesNotMatch(h, /incorrect|may be wrong|unreliable/i);
});

test("one Help control per Team screen, with text for the tab; taxi eligibility and the assumptions live there", () => {
  ["roster", "contracts", "performance"].forEach((sub) => { const html = V.app(state({ sub })); t.equal((html.match(/data-act="help"/g) || []).length, 1, sub + ": exactly one help control"); t.match(html, /aria-label="Help for this screen"/); });
  const h = text(V.app(state({ sheet: "help" })));
  t.match(h, /Planning assumption for later years/); t.match(h, /No injury relief is projected/); t.match(h, /taxi-eligible player can be released with a \$0 cut charge/); t.match(h, /“Player Unknown” means no authoritative player ID/);
  const r = text(V.app(state({ sheet: "help", sub: "roster" }))); t.match(r, /Can’t check/); t.match(r, /Recorded starters/); t.match(r, /Doubtful/);
});

test("copy: owner-facing text never says worker, contract text or caching, on any Contracts state, the profile, Help or About", () => {
  const states = [state(), state({ ct: { f: "all", s: "end", open: {}, bd: true, cat: { "y26Cut Penalty": true }, ns: true } }), state({ ns: { state: "error" }, ct: { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: true } }),
    state({ penalty: { state: "error", error: "HTTP 500" } }), state({ sheet: "help" }), state({ sheet: "help", sub: "roster" }), state({ sheet: "about" }),
    state({ tab: "team", sub: "contracts", profile: { pid: FX.teams[9].players[0].id, tab: "contract" }, penalty: { state: "error", error: "HTTP 500" }, flags: { rules: true, earned: true, cut: true, raw: true } })];
  states.forEach((s, i) => { const tx = text(V.app(s)); t.doesNotMatch(tx, /worker|contract text|cache|cached|caching/i, "state " + i); t.doesNotMatch(tx, /HTTP \d{3}/, "no error code reaches an owner: state " + i); });
  t.doesNotMatch(text(V.app(states[7])), /Recorded contract text/);
});

test("taxi wording: 'Taxi-eligible · $0 cut charge' once per player, only when both facts are known; the sentence is in Help", () => {
  const s = state({ ct: { f: "all", s: "end", open: {}, bd: false, cat: {}, ns: false } }), blake = s.model.teams.find((x) => x.id === "0010"), tp = blake.players.find((p) => p.status === "taxi");
  tp.taxi = { used: 0, max: 3, eligible: true, text: "" }; s.ct.open[tp.id] = true; s.penalty = { state: "ok", data: { [tp.id]: { penalty: 0, guaranteed: 2000, earned: 0, basis: "taxi_exempt", exempt_reason: "taxi" } }, meta: {} };
  const tx = text(V.app(s)); t.equal((tx.match(/Taxi-eligible · \$0 cut charge/g) || []).length, 1); t.match(tx, /Recorded guarantee/); t.match(tx, /Remaining guarantee/);
  s.penalty = { state: "idle" }; const tx2 = text(V.app(s)); t.match(tx2, /Taxi-eligible/); t.doesNotMatch(tx2, /\$0 cut charge/, "no cut-charge claim until the calculation loads");
});

run("mobile2027_contracts_pra");
