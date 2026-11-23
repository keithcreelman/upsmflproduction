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
  t.match(html, /<div class="thead g4"><span>Remaining guarantee<\/span><span>2026<\/span><span>2027<\/span><span>2028<\/span><\/div>/, "this season's and the future annual salary columns");
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
  t.match(h, /Earlier years of this contract are not recorded\./); t.match(h, /Contract Not recorded Years remaining/);
});

test("recorded league: every current contract's full schedule is supported (486 of 486: 171 one-year, 315 with every year token); 162 have completed years, all recorded; none partial, none unsupported", () => {
  const n = { full: 0, partial: 0, none: 0 }; let past = 0, pastFull = 0, oneYr = 0;
  MODEL.teams.forEach((tm) => tm.players.forEach((p) => {
    const h = C.history(p, 2026);
    if (h.complete) n.full++; else if (h.earlier === "unknown" || !h.rows.length) n.none++; else n.partial++;
    if (h.length === 1) oneYr++;
    if (h.rows.some((r) => r.phase === "done")) { past++; if (h.rows.filter((r) => r.phase === "done").every((r) => r.amount != null)) pastFull++; }
  }));
  t.deepEqual(n, { full: 486, partial: 0, none: 0 }); t.equal(oneYr, 171); t.equal(past, 162); t.equal(pastFull, 162);
});

test("Details: the schedule, contract length, years remaining, then guarantee and cut cost kept apart; '$0' remaining guarantee says 'Guaranteed portion fully earned'; a rule-exempt contract says 'Weekly guarantee: Not applicable' with its reason; no section codes", () => {
  const tm = MODEL.teams.find((x) => x.id === "0012"), open = {}; tm.players.forEach((p) => { open[p.id] = true; });
  const html = body(V.app(state({ teamId: "0012", ct: { ...CT0(), open } })));
  const rowOf = (name) => text(html.split('aria-label="Open ' + name + ' profile"')[1].split('<div class="rw">')[0]);
  const kw = rowOf("Kyren Williams");
  t.match(kw, /Salary schedule 2025 Completed \$22,000 2026 This season \$22,000 Contract 2 years, 2025–2026 Years remaining 1 \(through 2026\)/);
  t.match(kw, /Remaining guarantee \$0 Guaranteed portion fully earned/); t.match(kw, /If cut now \$0/);
  const jb = rowOf("Javon Bullard");
  t.match(jb, /Salary schedule 2024 Completed \$1,000 2025 Completed \$1,000 2026 This season \$1,000 Contract 3 years, 2024–2026/);
  t.match(jb, /Weekly guarantee Not applicable A contract with a total value under \$5K, in its final year or a one-year deal, has no weekly guarantee\./);
  t.doesNotMatch(text(html), /§/, "no rulebook section code on the screen");
  const order = ["Salary schedule", "Contract ", "Years remaining", "Recorded guarantee", "Remaining guarantee", "If cut now"].map((w) => kw.indexOf(w)); t.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), "salary, then guarantee, then cut cost, each on its own line");
});

run("mobile2027_r6_contracts");
