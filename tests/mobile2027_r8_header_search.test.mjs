// UPS 2027 R8 (Keith 2026-11-23): the compact scrolling header, the compact recorded-data marker, Byes collapsed with short copy, and
// Team › Performance "Search players".
//   node tests/mobile2027_r8_header_search.test.mjs
// Offline: the recorded public reads drawn through the real views. Sticky/scroll geometry is checked in headless Chrome (r8b notes), not here.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), V = require(path.join(SRC, "lib/views.js")), X = require(path.join(SRC, "lib/complete.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), SM = require(path.join(SRC, "lib/sample.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const TEAM = "0010";
async function intel() {
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, FX3.lineup_matchups_w11, FX4.hist, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: FX4.scores[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return ok({ players: { player: FX4.players } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(CAL.full);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({});
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });
  return out;
}
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: TEAM, tab: "team", sub: "roster", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: { s: "pos", open: {}, res: {}, q: "" },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const cards = (html) => [...html.matchAll(/data-act="card" data-pid="(\d+)" aria-label="Open ([^"]+) profile"/g)].map((m) => ({ id: m[1], name: m[2] }));

// ---------------- 3. compact scrolling header ----------------
test("header: the heading and freshness line scroll inside #scroll; the Team tabs stick; the body stays in #screen", () => {
  ["roster", "contracts", "performance", "cap"].forEach((sub) => {
    const h = V.app(state({ sub }));
    t.match(h, /^<div class="envbar[^"]*">[\s\S]*?<\/div><div id="scroll" class="scroll"><div class="hdw"><div class="hd"><h1>Team<\/h1><button class="ib" data-act="about"[^>]*>ⓘ<\/button><\/div><div class="asof">[^<]*<span class="ok">✓<\/span> Data as of [^<]+<\/div><\/div><div class="tabs tabs4 stk" role="tablist">/, sub + ": marker, then the scrolling area: heading, freshness, sticky tabs");
    t.match(h, /<\/button><\/div><div id="screen">/, sub + ": the tabs close before the body");
    t.equal((h.match(/id="scroll"/g) || []).length, 1); t.equal((h.match(/id="screen"/g) || []).length, 1);
    t.doesNotMatch(body(h).split("<nav")[0], /role="tablist"|class="hdw"/, sub + ": the body is the body only");
  });
  // the other tabs and Sample mode use the same scrolling area
  ["home", "market", "league"].forEach((tab) => t.match(V.app(state({ tab })), /<div id="scroll" class="scroll"><div class="hdw">[\s\S]*<div id="screen">/, tab));
  t.match(V.app(state({ sample: { on: true } })), /<div id="scroll" class="scroll"><div class="hdw">[\s\S]*<div id="screen"><div class="card hl">/);
  // CSS: one scrolling area, sticky opaque tabs over the rows, the Contracts table head sticks BELOW the tabs, focus scrolls clear of them
  t.match(css, /\.scroll\{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;[^}]*scroll-padding-top:52px\}/);
  t.match(css, /\.tabs\.stk\{position:sticky;top:0;z-index:4;background:var\(--bg\)\}/);
  t.match(css, /\.stk~#screen \.thead\{top:45px\}/);
  t.doesNotMatch(css.match(/#screen\{[^}]*\}/)[0], /overflow/, "#screen no longer scrolls itself");
  t.match(appJs, /getElementById\("scroll"\)[\s\S]*scr2\.scrollTop = scrTop/, "a redraw keeps the scroll position of #scroll");
});

test("marker: recorded mode reads 'Test · Recorded data' with Known issues; capture times live in About; one known-issues list", () => {
  t.equal(SM.envText(false, true), "Test · Recorded data"); t.equal(SM.envText(false, ""), "Preview: view only"); t.match(SM.envText(true, true), /^Sample data/);
  const rec = { label: "Sun Nov 22, 2026, 10:22 AM ET", later: "10:11–10:14 PM ET" };
  const h = V.app(state({ recorded: rec }));
  t.match(h, /^<div class="envbar rec"><span>Test · Recorded data<\/span> <button class="link" data-act="about">Known issues<\/button><\/div>/);
  t.doesNotMatch(h.split("</div>")[0], /10:22|10:11/);
  const about = V.app(state({ recorded: rec, sheet: "about" }));
  const ki = about.indexOf('id="known-issues"'), data = about.indexOf("<h2>Data</h2>");
  t.ok(ki > 0 && data > ki, "Known issues first, the Data card right after it");
  t.match(about.slice(data), /^<h2>Data<\/h2><div class="ex">This preview uses a recorded snapshot taken Sun Nov 22, 2026, 10:22 AM ET, not the live league\. The figures will not move\. Game stats, season totals and projections were recorded later that day, 10:11–10:14 PM ET\./, "both capture times");
  t.equal((about.match(/id="known-issues"/g) || []).length, 1);
  t.ok(!V.KNOWN_ISSUES.some((x) => /three lines|320-pixel/.test(x)), "the 320 px wrap entry is gone (the marker is one line at 320 px, measured in headless Chrome)");
  t.match(css, /\.envbar\.rec\{[^}]*white-space:nowrap/);
});

// ---------------- 4. Byes ----------------
test("Byes: every group starts collapsed, the long paragraph is gone, 'Week 11 lineup' names whose starters, rows say 'Week 11 starter'", async () => {
  const S = state({ view: "byes", intel: await intel() }), html = V.rosterBody(S), tx = text(html);
  const keys = [...html.matchAll(/data-g="(bw[^"]+)" aria-expanded="(true|false)"/g)];
  t.ok(keys.length >= 2); keys.forEach((k) => t.equal(k[2], "false", k[1] + " starts collapsed"));
  t.equal(V.isOpen(S, "bw13"), false); t.equal(V.isOpen(S, "bwnone"), false); t.equal(V.isOpen(S, "bench"), true, "Bench keeps its open default");
  t.doesNotMatch(tx, /Slots are today|later week is not set|may not fill the same slots/);
  t.match(tx, /Lineup coverage · /, "R9: the summary is the coverage line");
  t.doesNotMatch(tx, /Week 1[2-8] lineup|will start|projected/i, "no claim about a later week's lineup");
  const open = {}; for (let w = 1; w <= 18; w++) open["bw" + w] = true;
  const tx2 = text(V.rosterBody(state({ view: "byes", intel: S.intel, open })));
  t.match(tx2, / · Week 11 starter/); t.doesNotMatch(tx2, /slots from the Week 11 lineup/, "R9: no slot tags, so no slot provenance line");
});

// ---------------- 5. Performance search ----------------
test("search: case/accent-insensitive words, all must match; empty means no filter", () => {
  const m = TV.pfMatcher;
  t.equal(m(""), null); t.equal(m("   "), null);
  t.ok(m("ja ch")({ name: "Ja'Marr Chase" })); t.ok(m("JAMARR")({ name: "Ja'Marr Chase" })); t.ok(!m("ja xx")({ name: "Ja'Marr Chase" }));
  t.ok(m("jose")({ name: "José Ramírez" })); t.ok(m("ramirez")({ name: "José Ramírez" }));
});

test("search: narrows THIS team's Performance list by name, keeps the sort, says 'No players match', and escapes the typed text", async () => {
  const I = await intel(), S0 = state({ sub: "performance", intel: I });
  const all = cards(body(V.app(S0))), team = S0.model.teams.find((x) => x.id === TEAM), ids = new Set(team.players.map((p) => String(p.id)));
  t.ok(all.length > 10, "the full list (" + all.length + ")");
  const h0 = body(V.app(S0));
  t.match(h0, /<label class="lbl" for="pfq">Search players<\/label><input id="pfq" class="pfq" type="search" data-inp="pfq" value="" placeholder="Player name"/, "a labeled search box");
  t.ok(h0.indexOf('id="pfq"') < h0.indexOf('data-act="pfs"'), "above the sort");
  const who = all.find((c, i) => i >= 3 && /^[A-Za-z]{3}/.test(c.name)), frag = who.name.slice(0, 3);
  for (const s of ["pos", "tot", "ppg"]) {
    const S = state({ sub: "performance", intel: I, pf: { s, open: {}, res: {}, q: frag.toUpperCase() } }), got = cards(body(V.app(S)));
    t.ok(got.length >= 1 && got.length < all.length, s + ": '" + frag + "' leaves " + got.length);
    t.ok(got.some((c) => c.id === who.id), s + ": the player searched for is there");
    t.ok(got.every((c) => ids.has(c.id) && c.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(frag.toLowerCase().replace(/[^a-z0-9 ]/g, ""))), s + ": every card is this team's and matches");
    t.match(body(V.app(S)), new RegExp('value="' + frag.toUpperCase() + '"'), "the box keeps its text");
    t.ok(body(V.app(S)).includes('<div id="pflist" class="pflist">' + TV.performanceList(S) + "</div>"), s + ": the list app.js redraws alone is the same list");
  }
  const none = body(V.app(state({ sub: "performance", intel: I, pf: { s: "pos", open: {}, res: {}, q: "zzqx" } })));
  t.match(none, /No players match/); t.equal(cards(none).length, 0); t.match(none, /The search covers this team only/);
  const evil = body(V.app(state({ sub: "performance", intel: I, pf: { s: "pos", open: {}, res: {}, q: '"><b>x' } })));
  t.doesNotMatch(evil, /"><b>x/, "the typed text is escaped in the value and in the empty state"); t.match(evil, /value="&quot;&gt;&lt;b&gt;x"/);
  // a reserve player who matches is shown, not hidden in a closed group
  const ir = team.players.find((p) => p.status === "ir" || p.status === "taxi");
  if (ir) { const h = body(V.app(state({ sub: "performance", intel: I, pf: { s: "pos", open: {}, res: {}, q: ir.name } }))); t.ok(cards(h).some((c) => c.id === String(ir.id)), "reserve match shown: " + ir.name); }
});

test("search: phone rules (16px text, 44px target), no request, and app.js keeps focus and the cursor", () => {
  t.match(css, /\.pfq\{[^}]*min-height:44px[^}]*font:16px\/1\.2 var\(--fb\)/);
  t.match(appJs, /appEl\.addEventListener\("input", function \(ev\) \{[\s\S]*?el\.id !== "pfq"[\s\S]*?S\.pf\.q = String\(el\.value \|\| ""\)\.slice\(0, 40\)[\s\S]*?U\.tabviews\.performanceList\(S\)/, "typing redraws the list only");
  const handler = appJs.split('appEl.addEventListener("input"')[1].split("appEl.addEventListener(")[0];
  t.doesNotMatch(handler, /fetch|loader\.|ensure|load[A-Z]/, "typing starts no read");
  t.match(appJs, /function searchCaret\(\)[\s\S]*selectionStart[\s\S]*function restoreCaret\(c\)[\s\S]*setSelectionRange/, "a full redraw restores focus and the cursor");
  t.match(appJs, /pf: \{ s: "pos", open: \{\}, res: \{\}, q: "" \}/);
});

run("mobile2027_r8_header_search");
