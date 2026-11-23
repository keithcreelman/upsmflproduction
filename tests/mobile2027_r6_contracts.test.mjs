// UPS 2027 R6 (Keith's Contracts decisions, 2026-11-22/23): the one cap card and its formula chain on all 12 recorded teams, the four-parent adjustment
// Breakdown, the later-year rows, the player list (badges, "Expires", a quiet Details control, no internal codes), and the full salary schedule of the
// CURRENT contract (completed years included, never borrowed from another contract, missing stays "Not recorded").
//   node tests/mobile2027_r6_contracts.test.mjs
// Data: the committed recorded bundle (apps/mobile2027/src/recorded_data.js, public league reads of 2026-11-22) and small hand-made players.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const C = require(path.join(SRC, "lib", "contract.js")), A = require(path.join(SRC, "lib", "adjust.js")), M = require(path.join(SRC, "lib", "model.js")), V = require(path.join(SRC, "lib", "views.js")), N = require(path.join(SRC, "lib", "reviewed_names.js"));
const box = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), box);
const ROUTES = box.window.UPS2027_RECORDED.routes;
const route = (frag) => ROUTES[Object.keys(ROUTES).find((k) => k.indexOf(frag) >= 0)];
const RW = route("/roster-workbench?"), PEN = route("/api/cap-penalty/preview?"), NS = route("/api/cap-adjustments/next-season?"), PL = route("TYPE=players&");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const money = (n) => "$" + Math.abs(n).toLocaleString("en-US");
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const MODEL = M.build(RW, null, null, 11, 2026);
const byId = {}; PL.players.player.forEach((p) => { byId[p.id] = { pos: p.position, club: p.team, name: p.name }; });
const nsBy = () => { const by = {}; MODEL.teams.forEach((tm) => { by[tm.id] = A.parseNextSeason(NS, { fid: tm.id, season: 2027, resolveName: A.nameResolver(MODEL, null) }); }); return { state: "ok", by }; };
const CT0 = () => ({ f: "all", s: "exp", y: 0, d: 1, open: {}, bd: false, cat: {}, ns: false });
const state = (over) => ({ model: MODEL, load: { core: "ok", coreNotes: [] }, penalty: { state: "ok", data: PEN.players, meta: { earnedThroughWeek: PEN.earned_through_week } }, ns: { state: "idle" }, teamId: "0010", tab: "team", sub: "contracts", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {}, players: { state: "ok", data: { byId }, at: 1 } }, ct: CT0(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });

// ───────────────────────── the formula chain, all 12 recorded teams ─────────────────────────
test("formula chain on all 12 recorded teams: Salaries − Taxi relief − IR relief = Total committed cap (= the roster read's cap total); ± adjustments = Cap charge; Total cap (salary_cap_dollars) − Cap charge = Available cap space", () => {
  t.equal(MODEL.teams.length, 12); t.equal(MODEL.capLimit, RW.salary_cap_dollars, "Total cap is the roster read's salary_cap_dollars"); t.equal(MODEL.capLimit, 300000);
  MODEL.teams.forEach((tm) => {
    const b = A.capBreakdown(tm, tm.cap), adj = tm.adjust;
    t.ok(b.ok, tm.id + " the salary lines tie to the read's cap total"); t.ok(adj.reconciled, tm.id + " the items tie to the adjustment total");
    t.equal(b.recorded - b.taxi - b.irRelief, b.capHits); t.equal(b.capHits, tm.cap.capTotal); t.equal(b.capHits + adj.total, b.capCharge);
    const avail = MODEL.capLimit - b.capCharge, h = text(body(V.app(state({ teamId: tm.id, ct: { ...CT0(), bd: true } }))));
    t.match(h, re("Cap space · 2026 season " + (avail < 0 ? "−" : "") + money(avail) + " Available cap space"), tm.id);
    t.match(h, re("Total committed cap " + money(b.capHits) + " 2026 adjustments Cut penalties"), tm.id);
    t.match(h, re("Cap charge " + money(b.capCharge) + " Total cap $300,000 Available cap space " + (avail < 0 ? "−" : "") + money(avail)), tm.id);
  });
});

test("the Breakdown is closed at first; it opens in place (no new page) with the four parents in order, signed totals on each, Rounding plain, Total adjustments", () => {
  const closed = text(body(V.app(state()))); t.match(closed, /Breakdown ▸/); t.doesNotMatch(closed, /Total committed cap \$|Cut penalties/);
  MODEL.teams.forEach((tm) => {
    const html = body(V.app(state({ teamId: tm.id, ct: { ...CT0(), bd: true } }))), h = text(html);
    const at = ["Cut penalties", "Traded salary", "Other", "Rounding", "Total adjustments"].map((w) => h.indexOf(w + " ", h.indexOf("2026 adjustments")));
    t.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), tm.id + ": the four parents in order, then Total adjustments");
    t.doesNotMatch(html, /data-v="y26round"/, "Rounding never opens"); t.doesNotMatch(h, /FA Auction Fine|Cut Penalty|Traded Salary/, "the internal category names are not shown");
  });
  // the one recorded fine (team 0012) is under Other and names itself
  const f = text(body(V.app(state({ teamId: "0012", ct: { ...CT0(), bd: true, cat: { y26other: true } } }))));
  t.match(f, /Other ▾ \+\$3,000 FA auction fine Rule 2, missed nomination, Jul 28, 2026 \(1st offense\) \+\$3,000 Rounding \+\$500/);
});

test("cut entries: name, amount and full cut date (ET), in cut-date order; the season only in the heading; exact-ID names from the complete MFL list; the 31 reviewed rows keep their mapping, cut dates and match conditions", () => {
  let reviewed = 0, direct = 0, byIdOnly = 0, unknown = 0;
  MODEL.teams.forEach((tm) => {
    tm.adjust.items.filter((i) => i.category === "Cut Penalty").forEach((i) => {
      if (i.nameSource === "reviewed_mapping") { reviewed++; const rv = N.rows().find((r) => r[4] === i.playerId && r[1] === tm.id && r[3] === i.amount); t.ok(rv, "a reviewed row matches"); t.equal(i.cutDate, rv[6], "its reviewed cut date"); }
      else if (i.nameSource === "direct") direct++;
      else if (i.playerId) byIdOnly++; else unknown++;
    });
    const h = text(body(V.app(state({ teamId: tm.id, ct: { ...CT0(), bd: true, cat: { y26cut: true } } }))));
    t.doesNotMatch(h, /Charged to|Full cut date|Additional charges appear/);
    const dates = [...h.matchAll(/Cut ([A-Z][a-z]{2} \d{1,2}, \d{4})/g)].map((m) => Date.parse(m[1])); t.deepEqual(dates, dates.slice().sort((a, b) => a - b), tm.id + ": earliest cut first");
  });
  t.equal(reviewed, 31, "all 31 reviewed charges are named through the reviewed mapping (kept apart from direct resolution)"); t.equal(N.COUNT, 31);
  t.equal(unknown, 0, "every recorded cut row has a player id or a reviewed match");
  // a charge that carries its own player id is named from MFL's complete list (on a roster or not)
  const idRows = []; MODEL.teams.forEach((tm) => tm.adjust.items.forEach((i) => { if (i.category === "Cut Penalty" && i.nameSource !== "reviewed_mapping") idRows.push([tm.id, i]); }));
  t.ok(idRows.length === direct + byIdOnly && idRows.length > 0);
  idRows.forEach(([fid, i]) => { const h = text(body(V.app(state({ teamId: fid, ct: { ...CT0(), bd: true, cat: { y26cut: true } } })))); const nm = i.playerName || (byId[i.playerId] && byId[i.playerId].name); const shown = !nm ? "Player Unknown" : nm.indexOf(",") > 0 ? nm.split(",")[1].trim() + " " + nm.split(",")[0].trim() : nm; t.ok(nm, fid + " " + i.playerId + " is in MFL's complete list"); t.match(h, re(shown), fid + " " + i.playerId); });
  t.doesNotMatch(V.app(state({ ct: { ...CT0(), bd: true, cat: { y26cut: true } } })), /adddrop|id:|\d{4,}_\d{10}/, "no token reaches the page");
});

// ───────────────────────── later years ─────────────────────────
test("later rows show only the year and Total committed cap; next season's Details keep its supported adjustments; the year after has no Details; no removed commentary", () => {
  const tm = MODEL.teams.find((x) => x.id === "0012"), ys = A.commitments(tm, 2026, null, null, 3);
  const closed = text(body(V.app(state({ teamId: "0012" }))));
  t.match(closed, re("Total committed cap, later years 2027 Details ▸ " + money(ys[1].hits) + " 2028 " + money(ys[2].hits) + " Show"));
  ["Adjustments pending", "adjustments unavailable", "adjustments not recorded", "adjustments not loaded", "Later years assume", "Counts against the cap", "Not cap room", "Recorded salary, not cap space", "players shown", "cap hit", "Cap hits"].forEach((w) => t.doesNotMatch(closed, new RegExp(w, "i"), w));
  const open = text(body(V.app(state({ teamId: "0012", ns: nsBy(), ct: { ...CT0(), ns: true, cat: { y27other: true } } }))));
  const p = nsBy().by["0012"]; t.ok(p.reconciled && p.complete);
  t.match(open, re("2027 Details ▾ " + money(ys[1].hits) + " Total committed cap " + money(ys[1].hits) + " 2027 adjustments Cut penalties ▸ +" + money(p.byCategory["Cut Penalty"])));
  t.match(open, /Other ▾ \+\$3,000 FA auction fine Rule 2 \+\$3,000 Rounding \$0 Total adjustments \+\$6,000/); t.match(open, re("Cap charge " + money(ys[1].hits + p.total)));
  t.doesNotMatch(open, /2028 Details/);
});

test("an unrecorded future salary is never a $0 or a complete figure: the row shows — and says how many are not recorded; the year's Details draw no cap charge", () => {
  const rw = JSON.parse(JSON.stringify(RW)), tmr = rw.teams.find((x) => x.franchise_id === "0012"), pl = tmr.players.find((p) => Number(p.years) >= 2 && /Y1-/.test(p.special));
  pl.special = pl.special.replace(/Y\d+-[\d.]+K?,?\s*/g, "");   // the year tokens are gone: later years of his contract are not recorded
  const m = M.build(rw, null, null, 11, 2026), s = state({ model: m, teamId: "0012", ns: nsBy(), ct: { ...CT0(), ns: true } }), h = text(body(V.app(s)));
  t.match(h, /2027 Details ▾ — 1 salary not recorded/); t.doesNotMatch(h.split("2027 Details")[1].split("2028")[0], /Cap charge/, "no 2027 cap charge from an incomplete total");
});

// ───────────────────────── the player list ─────────────────────────
test("player rows: a colored position badge, the name opens the profile, a separate quiet Details control, 'Expires <year>', the annual salary columns, and no internal contract code on the default row", () => {
  const html = body(V.app(state())), tm = MODEL.teams.find((x) => x.id === "0010");
  tm.players.forEach((p) => {
    const row = html.split('data-pid="' + p.id + '"')[0].split('<div class="rw">').pop() + html.split('data-pid="' + p.id + '"')[1].split('<div class="rw">')[0];
    t.match(row, /<span class="pc [A-Z]{1,2}">[A-Z]{1,2}<\/span>/, p.name + ": position badge");
    t.match(row, re('<button class="rb dtl" data-act="ctx" data-v="' + p.id + '" aria-expanded="false" aria-label="Show contract details for '), p.name + ": a separate Details control");
    t.match(text(row), re("Expires " + (2026 + p.years - 1)));
    t.doesNotMatch(text(row), /Vet-|Rookie-|\bTag\b|\bCL \d|TCV|AAV|GTD|yrs? left/, p.name + ": no internal contract code on the default row");
  });
  t.match(html, /<div class="thead g4"><span>If cut now<\/span><span>2026<\/span><span>2027<\/span><span>2028<\/span><\/div>/, "this season's and the future annual salary columns");
  t.match(text(html), /Expires 2026 · \d+ players/); t.doesNotMatch(text(html), /Expiration date/);
  t.match(html, /<button data-act="cts" data-v="sal" aria-pressed="false" aria-label="Sort by salary">Salary<\/button><button data-act="cts" data-v="exp" aria-pressed="true" aria-label="Sorted by contract expiration, soonest first\. Tap to reverse\.">Contract exp\. <span aria-hidden="true">▲<\/span><\/button><button data-act="cts" data-v="name" aria-pressed="false" aria-label="Sort by name">Name<\/button>/);
});

// ───────────────────────── Details: the full schedule of the current contract ─────────────────────────
const P = (special, years, salary, extra) => ({ id: "1", name: "Test, Player", pos: "WR", status: "active", salary, years, special, ...(extra || {}) });

test("history(): a 3-year contract ending 2026 lists 2024, 2025 and 2026 from its own year tokens; future years and an option year follow", () => {
  const h = C.history(P("CL 3| TCV 15K| AAV 5K| Y1-4K, Y2-5K, Y3-6K| GTD: 11.3K", 1, 6000), 2026);
  t.deepEqual(h.rows, [{ year: 2024, amount: 4000, phase: "done" }, { year: 2025, amount: 5000, phase: "done" }, { year: 2026, amount: 6000, phase: "now" }]);
  t.equal(h.length, 3); t.equal(h.start, 2024); t.equal(h.end, 2026); t.equal(h.earlier, "recorded"); t.ok(h.complete);
  const r = C.history(P("CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K", 2, 6000), 2026);
  t.deepEqual(r.rows.map((x) => [x.year, x.amount, x.phase]), [[2025, 6000, "done"], [2026, 6000, "now"], [2027, 6000, "left"]]); t.deepEqual(r.option, { year: 2028, amount: 11000 });
  const one = C.history(P("CL 1| TCV 88K| AAV 88K", 1, 88000), 2026); t.deepEqual(one.rows, [{ year: 2026, amount: 88000, phase: "now" }]); t.equal(one.earlier, "none"); t.ok(one.complete);
});

test("history(): missing terms stay missing: a missing completed-year token is null; no contract length means earlier years are unknown (none listed); a token that disagrees with this season's salary makes the completed years untrusted", () => {
  const gap = C.history(P("CL 3| Y2-5K, Y3-6K", 1, 6000), 2026); t.deepEqual(gap.rows.map((x) => x.amount), [null, 5000, 6000]); t.equal(gap.earlier, "partial"); t.equal(gap.complete, false); t.equal(gap.missing, 1);
  const nocl = C.history(P("TCV 15K| Y1-4K, Y2-5K, Y3-6K", 1, 6000), 2026); t.deepEqual(nocl.rows, [{ year: 2026, amount: 6000, phase: "now" }]); t.equal(nocl.earlier, "unknown"); t.equal(nocl.complete, false); t.equal(nocl.length, null);
  const short = C.history(P("CL 1| Y1-6K", 2, 6000), 2026); t.equal(short.earlier, "unknown", "a length shorter than the years remaining is not a usable length");
  const bad = C.history(P("CL 3| Y1-4K, Y2-5K, Y3-9K", 1, 6000), 2026); t.deepEqual(bad.rows.map((x) => x.amount), [null, null, 6000]); t.equal(bad.earlier, "conflict");
  const none = C.history(P("CL 3| Y1-4K", 0, 6000), 2026); t.deepEqual(none.rows, []); t.equal(none.complete, false);
  // the screen: Not recorded, never $0, and one plain note when the earlier years are unknown
  const s = state(), p = s.model.teams.find((x) => x.id === "0010").players[0], keep = p.special;
  p.special = "TCV 15K| Y1-4K"; const h = text(body(V.app({ ...s, ct: { ...CT0(), open: { [p.id]: true } } }))); p.special = keep;
  t.match(h, /Earlier years of this contract are not recorded\./); t.match(h, /Term Start not recorded, ends 2027 · 2 years left Contract Type/);
});

// R7 (restructure re-base, canon §C5.1): 10 restructured contracts whose recorded terms begin at the restructure no longer claim a start or a
// length, and McLaurin's auction year (2025) is listed as a completed, Not recorded year; the other 475 schedules are unchanged.
test("recorded league: 475 of 486 current contracts have a fully supported schedule (171 one-year); 1 partial (a restructured auction contract's pre-restructure year is Not recorded); 10 restructured with an unknown start; 163 have completed years, 162 all recorded", () => {
  const n = { full: 0, partial: 0, none: 0, restructured: 0 }; let past = 0, pastFull = 0, oneYr = 0;
  MODEL.teams.forEach((tm) => tm.players.forEach((p) => {
    const h = C.history(p, 2026);
    if (h.complete) n.full++; else if (h.earlier === "restructured") n.restructured++; else if (h.earlier === "unknown" || !h.rows.length) n.none++; else n.partial++;
    if (h.length === 1) oneYr++;
    if (h.rows.some((r) => r.phase === "done")) { past++; if (h.rows.filter((r) => r.phase === "done").every((r) => r.amount != null)) pastFull++; }
  }));
  t.deepEqual(n, { full: 475, partial: 1, none: 0, restructured: 10 }); t.equal(oneYr, 171); t.equal(past, 163); t.equal(pastFull, 162);
});

test("Details (R8): the schedule, then one Term line, Contract Type, Contract Source, Later changes, Salary structure, If cut now with its rule; the guarantee line only under the guarantee rule; no section codes, no internal codes", () => {
  const tm = MODEL.teams.find((x) => x.id === "0012"), open = {}; tm.players.forEach((p) => { open[p.id] = true; });
  const html = body(V.app(state({ teamId: "0012", ct: { ...CT0(), open } })));
  const rowOf = (name) => text(html.split('aria-label="Open ' + name + ' profile"')[1].split('<div class="rw">')[0]);
  const kw = rowOf("Kyren Williams");
  t.match(kw, /Salary schedule Extended by Hawks · 2025 2025 Completed \$22,000 2026 This season \$22,000 Term 2025–2026 \(2 years\) · Final year Contract Type Veteran Contract Source/);
  t.match(kw, /If cut now \$0 Guarantee rule: the guaranteed amount is fully earned, so nothing is owed\. Guarantee \$[\d,]+ \$[\d,]+ earned through Week 10/);
  const jb = rowOf("Javon Bullard");
  t.match(jb, /Salary schedule 2024 Completed \$1,000 2025 Completed \$1,000 2026 This season \$1,000 Term 2024–2026 \(3 years\) · Final year/);
  t.match(jb, /If cut now \$0 \$1K drop rule: a contract worth under \$5K costs \$1K to cut while two or more years remain, and nothing in its final year\./); t.doesNotMatch(jb, /Guarantee \$/);
  const tx = text(html);
  t.doesNotMatch(tx, /§/, "no rulebook section code on the screen"); t.doesNotMatch(tx, /Vet-|Rookie-(?:Draft|WW|MYM|FAA)|Remaining guarantee|Recorded guarantee|Weekly guarantee|Years remaining|minus earned|Contract Loaded/);
  const order = ["Salary schedule", "Term ", "Contract Type", "Contract Source", "Later changes", "Salary structure", "If cut now", "Guarantee $"].map((w) => kw.indexOf(w)); t.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), "the facts in order, the cut charge then the guarantee");
});

// ───────────────────────── R8: Contract Type / Source / later changes / structure ─────────────────────────
const D = (type, special, acq, years) => C.describe({ type, special: special || "", acquisition: acq || "", years: years || 1 });
test("R8 describe(): every token maps only to what it states; unknown is null (Not recorded)", () => {
  const cases = [
    ["Rookie-Draft", "CL 3| Y1-8K, Y2-8K, Y3-8K, Y4-13K Option", "1.05 (2024)", { type: "Rookie", source: "Rookie Draft", changes: [], structure: "Flat" }],
    ["Vet-FAA-FL", "CL 3| Y1-40K, Y2-22K, Y3-22K", "Trade (2025)", { type: "Veteran", source: "FA Auction", changes: [], structure: "Front-loaded" }],
    ["Vet-ERA-BL", "CL 2| Y1-8K, Y2-30K", "Trade", { type: "Veteran", source: "Expired Rookie Auction", changes: [], structure: "Back-loaded" }],
    ["Vet-WW", "CL 1| TCV 1K| AAV 1K", "FCFS", { type: "Veteran", source: "Waiver Wire (FCFS)", changes: [], structure: "Flat" }],
    ["Rookie-WW", "CL 1| TCV 3K", "BB $3,000", { type: "Rookie", source: "Waiver Wire", changes: [], structure: "Flat" }],
    ["Vet-MYM", "CL 2| Y1-1K, Y2-1K", "BB $1,000", { type: "Veteran", source: "Waiver Wire", changes: ["Mid-Year Multi"], structure: "Flat" }],
    ["Vet-MYM", "CL 2| Y1-26K, Y2-26K", "Auction $26,000", { type: "Veteran", source: "Auction", changes: ["Mid-Year Multi"], structure: "Flat" }],
    ["Vet-Ext1", "CL 2| Y1-1K, Y2-11K| Ext: Blake", "Trade (2025)", { type: "Veteran", source: null, sourceNote: "Acquired by trade", changes: ["Extended 1 year"], structure: "Flat" }],
    ["Vet-Ext2", "CL 3| Y1-9K, Y2-29K, Y3-29K| Ext: PG", "2.04 (2023)", { type: "Veteran", source: "Rookie Draft", changes: ["Extended 2 years"], structure: "Flat" }],
    ["Vet-Ext2", "CL 3| Y1-9K, Y2-20K, Y3-30K", "Trade", { type: "Veteran", source: null, changes: ["Extended 2 years"], structure: "Back-loaded" }],
    ["Vet-Ext2", "CL 3| Y1-9K", "Trade", { type: "Veteran", source: null, changes: ["Extended 2 years"], structure: null }],
    ["Vet-Ext1-BL", "CL 2|Y1-14K, Y2-50K|Ext: CBP|Restructured 2026", "Trade (2024)", { type: "Veteran", source: null, changes: ["Extended 1 year", "Restructured 2026"], structure: "Back-loaded" }],
    ["Tag", "CL 1| TCV 51K| AAV 51K| Tag| Tier 1", "Trade", { type: null, source: null, changes: ["Tag"], structure: "Flat" }],
    ["", "", "", { type: null, source: null, changes: [], structure: null }],
    ["Vet-FAA", "CL 3| Y1-5K, Y2-6K, Y3-6K", "Auction $5,000", { type: "Veteran", source: "FA Auction", changes: [], structure: null }]
  ];
  cases.forEach(([ty, sp, acq, want]) => { const d = D(ty, sp, acq); Object.keys(want).forEach((k) => t.deepEqual(d[k], want[k], ty + " / " + acq + ": " + k)); });
});

test("R8 recorded league: counts per cut rule and per Contract Type / Source / structure (the integrator's notes cite these)", () => {
  const rules = {}, types = {}, srcs = {}, structs = {}; let n = 0;
  const pen = PEN.players;
  MODEL.teams.forEach((tm) => tm.players.forEach((p) => {
    n++; const r = pen[p.id], d = C.describe(p);
    const k = r ? C.cutRule(r).rule : "no row"; rules[k] = (rules[k] || 0) + 1;
    types[d.type || "Not recorded"] = (types[d.type || "Not recorded"] || 0) + 1; srcs[d.source || "Not recorded"] = (srcs[d.source || "Not recorded"] || 0) + 1; structs[d.structure || "Not recorded"] = (structs[d.structure || "Not recorded"] || 0) + 1;
  }));
  t.equal(n, 486); t.equal(rules.unknown || 0, 0, "every recorded basis is a known rule"); t.equal(rules["no row"] || 0, 0);
  t.deepEqual(rules, { guarantee: 226, none: 124, onek: 41, taxi: 95 });
  t.equal(types["Not recorded"], 6, "only the six tags have no Veteran/Rookie prefix");
  t.equal(structs["Not recorded"] || 0, 0, "every recorded contract states or implies its structure");
  if (process.env.R8_COUNTS) console.log("R8COUNTS " + JSON.stringify({ rules, types, srcs, structs }));
});

test("R8 traded salary: every 2026 entry shows its signed amount and 'Trade details not recorded' (no read links a trade transaction); a linked entry would read 'Trade with <team>' over the full date", () => {
  const tm = MODEL.teams.find((x) => x.id === "0010"), html = body(V.app(state({ ct: { ...CT0(), bd: true, cat: { y26trade: true } } }))), tx = text(html);
  const trades = tm.adjust.items.filter((i) => i.category === "Traded Salary"); t.equal(trades.length, 4);
  t.equal((tx.match(/Trade details not recorded/g) || []).length, 4); t.doesNotMatch(tx, /Trade with/);
  ["Trade Trade details not recorded −\\$5,000", "Three-team trade Trade details not recorded −\\$19,000", "Trade Trade details not recorded \\+\\$12,000", "Trade Trade details not recorded −\\$20,000"].forEach((x) => t.match(tx, new RegExp(x), x));
  // the layout for a linked entry (no source supplies one yet): the opposing team(s), then the full trade date; the text is escaped
  const linked = { ...MODEL, teams: MODEL.teams.map((x) => x.id !== "0010" ? x : { ...x, adjust: { ...x.adjust, items: x.adjust.items.map((i, k) => i.category === "Traded Salary" && k === x.adjust.items.indexOf(trades[0]) ? { ...i, trade: { linked: true, teams: ["Hawks"], date: "2026-11-12" } } : i) } }) };
  const lt = text(body(V.app(state({ model: linked, ct: { ...CT0(), bd: true, cat: { y26trade: true } } }))));
  t.match(lt, /Trade with Hawks November 12, 2026 −\$5,000/); t.equal((lt.match(/Trade details not recorded/g) || []).length, 3);
  const half = { ...MODEL, teams: MODEL.teams.map((x) => x.id !== "0010" ? x : { ...x, adjust: { ...x.adjust, items: x.adjust.items.map((i) => i.category === "Traded Salary" ? { ...i, trade: { linked: true, teams: ["Hawks"], date: null } } : i) } }) };
  t.doesNotMatch(text(body(V.app(state({ model: half, ct: { ...CT0(), bd: true, cat: { y26trade: true } } })))), /Trade with/, "a link without a date is not used");
});

run("mobile2027_r6_contracts");
