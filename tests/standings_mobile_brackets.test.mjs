// Mobile Playoffs (#1329 review): vertical brackets for the UPS Playoffs and the Hawk Tuah Bowl, every game opening a
// Tale of the Tape. Runs the REAL mobile view (site/m/views/league.js) and sheet (site/m/standings_sheets.js) on the
// REAL /api/standings and /api/playoff-bracket routes for the recorded 2026 season after Week 5 (projected), and on
// the real 2025 bracket as /api/playoff-bracket served it (actual results).
//   node scripts/safe_tests/run.mjs --only standings_mobile_brackets
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const LS = JSON.parse(fs.readFileSync(new URL("./fixtures/mfl_2026_wk5_league_standings.json", import.meta.url), "utf8"));
const HIST = fs.readFileSync(new URL("../site/standings/h2h_history.json", import.meta.url), "utf8");
const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const utilSrc = ["safeStr", "safeInt", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");

// The real 2025 bracket as /api/playoff-bracket served it (D1 scores; MFL's three Week 17 stat corrections differ by < 1).
const mk = (week, fid, ts, opp, os) => ({ week, franchise_id: fid, team_score: ts, opponent_franchise_id: opp, opponent_score: os });
const B2025 = { ok: true, year: 2025, season_complete: true, playoff_weeks: [15, 16, 17], seeds: [
  ["0004", "Pure Greatness"], ["0009", "C-Town Chivalry"], ["0007", "Sex Manther"], ["0001", "L.A. Looks"], ["0005", "HammerTime"], ["0010", "Blake Bombers"],
  ["0011", "Cleon Ca$h"], ["0008", "Real Deal Creel"], ["0012", "Hawks"], ["0006", "The Long Haulers"], ["0002", "CBP"], ["0003", "Gride"]].map(([f, n], i) => ({ seed: i + 1, franchise_id: f, franchise_name: n })),
  matchups: [[15, "0001", 219.7, "0005", 290.2], [15, "0002", 173.3, "0006", 207.8], [15, "0003", 175.9, "0012", 222.7], [15, "0007", 264.7, "0010", 219.0],
    [16, "0001", 239.7, "0010", 275.6], [16, "0002", 150.4, "0003", 202.2], [16, "0004", 255.2, "0005", 196.8], [16, "0006", 192.8, "0011", 204.2], [16, "0007", 307.6, "0009", 214.3], [16, "0008", 155.5, "0012", 187.8],
    [17, "0004", 233.7, "0007", 192.1], [17, "0005", 206.8, "0009", 195.4], [17, "0006", 209.3, "0008", 164.8], [17, "0011", 294.4, "0012", 157.8]]
    .flatMap(([w, a, sa, b, sb]) => [mk(w, a, sa, b, sb), mk(w, b, sb, a, sa)]) };
const S2025 = { ok: true, year: 2025, standings_basis: "recorded_final_standings", season_complete: true, preseason: false, weekly: [], weeklyScores: [],
  rows: B2025.seeds.map((s) => ({ franchise_id: s.franchise_id, franchise_name: s.franchise_name, owner_name: "" })) };

async function boot() {
  const env = loadSeason(makeWorkerEnv({}), recorded2026(REC));
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = { state: { ctx: { year: 2026 }, viewerFranchiseId: "0008", franchises: [] }, api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} } };
  const fetched = [];
  const json = (j, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => j });
  const fetch = async (url) => {
    const u = new URL(url, "https://keithcreelman.github.io");
    fetched.push(u.pathname + u.search);
    if (u.pathname === "/upsmflproduction/standings/h2h_history.json") return json(JSON.parse(HIST));
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "leagueStandings") return json(u.searchParams.get("YEAR") === "2026" ? LS : { error: "x" });
    if (u.searchParams.get("year") === "2025") return json(u.pathname === "/api/playoff-bracket" ? B2025 : S2025);
    if (u.pathname === "/api/standings" || u.pathname === "/api/playoff-bracket") return json((await callWorker(env, "GET", u.pathname + u.search)).json);
    return json(null, 404);
  };
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", firstChild: null, classList: { _on: false, add() { this._on = true; }, remove() { this._on = false; }, contains() { return this._on; } }, addEventListener() {}, focus() {} });
  const sheetMount = el("ups-m-info-sheet-mount");
  Object.defineProperty(sheetMount, "innerHTML", { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ""; } });
  const document = { getElementById: (id) => (id === "ups-m-team-sheet-mount" ? null : el(id)), addEventListener() {}, body: { style: {} }, activeElement: null };
  const ctx = { window: { UPS_MOBILE: M }, document, fetch, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, safeInt, pad4, escapeHtml, asArray, fmtUsd: function (n) { return '$' + n; } };", ctx);
  vm.runInContext(RACE_SRC.replace("(typeof window !== 'undefined' ? window : this)", "(window)"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/standings_sheets.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8"), ctx);
  const show = async (o) => { M.leagueView.setStandingsView(o); views.league(mount, ["standings"]); await settle(); M.route.renderRoute(); await settle(); M.route.renderRoute(); await settle(); return mount.innerHTML; };
  const sheet = () => plain(els["ups-m-info-sheet-body"] ? els["ups-m-info-sheet-body"].innerHTML : "");
  return { M, ctx, show, sheet, fetched, els };
}
const order = (html, parts) => { let at = -1; for (const p of parts) { const i = html.indexOf(p, at + 1); if (i < 0) return "missing: " + p; at = i; } return "ok"; };

test("UPS Playoffs, projected: rounds stacked top to bottom, byes, seeds, advancement, every game labeled Projected with a Tale of the Tape", async () => {
  const b = await boot();
  const html = await b.show({ mode: "playoffs", side: "champ", year: 2026 });
  const p = plain(html);
  t.match(p, /UPS Playoffs Hawk Tuah Bowl Seeds/, "the side switch: UPS Playoffs, Hawk Tuah Bowl, Seeds");
  t.match(p, /If the season ended today\. Projection: the higher seed wins every game\./);
  t.equal(order(p, ["Round 1 Week 15", "↓ winners advance", "Semifinals Week 16", "↓ winners advance", "Championship Week 17"]), "ok", "one column, rounds downward");
  t.match(p, /Round 1 Projected 3 HammerTime 🔨 ⏰ advances \(proj\.\) 6 Pure Greatness/);
  t.match(p, /Round 1 Projected 4 Real Deal Creel advances \(proj\.\) 5 CBP/);
  t.match(p, /First-round byes: 1 C-Town Chivalry · 2 Blake Bombers/);
  t.match(p, /Semifinal Projected 1 C-Town Chivalry advances \(proj\.\) 4 Real Deal Creel winner of 4 v 5 \(projected\)/);
  t.match(p, /5th-place game · Round 1 losers Projected 5 CBP advances \(proj\.\) 6 Pure Greatness Winner 5th \(pick 1\.07\) · loser 6th \(pick 1\.08\)/);
  t.match(p, /Championship Projected 1 C-Town Chivalry advances \(proj\.\) 2 Blake Bombers Winner 1st \(pick 1\.12\) · loser 2nd \(pick 1\.11\)/);
  t.match(p, /3rd-place game · semifinal losers Projected .* Winner 3rd \(pick 1\.10\) · loser 4th \(pick 1\.09\)/);
  const games = [...html.matchAll(/<div class="ups-m-bk-game[^"]*"([^>]*)>/g)];
  t.equal(games.length, 7, "R1 ×2, semis ×2, 5th-place, final, 3rd-place");
  t.ok(games.every((g) => /data-tape-a="\d{4}" data-tape-b="\d{4}"/.test(g[1]) && /data-tape-kind="projected"/.test(g[1])), "every game opens a projected Tale of the Tape");
  t.equal((html.match(/>Tale of the Tape<\/button>/g) || []).length, 7, "a visible Tale of the Tape button on every game");
  t.ok(!/✓ won|ups-m-bk-tag final/.test(html), "no result is claimed for a projected game");
});
test("Hawk Tuah Bowl, projected: H1-H6 seeds with the order and tiebreak, byes, and what each game decides", async () => {
  const b = await boot();
  const p = plain(await b.show({ mode: "playoffs", side: "hawk", year: 2026 }));
  t.match(p, /Hawk Tuah Bowl · the toilet bowl The six teams outside the playoff field, seeded H1–H6 \(7th–12th\) in standings order: All-Play %, then H2H record, then Points For\. H1 and H2 get a first-round bye\. The winner finishes 7th and picks 1\.01 in the 2027 rookie draft\./);
  t.match(p, /H1 Hawks 29-26 AP H2 Cleon Ca\$h 23-32 AP H3 L\.A\. Looks 20-35 AP H4 Gride 16-39 AP H5 The Long Haulers 14-41 AP H6 Sex Manther 11-44 AP/);
  t.match(p, /If the season ended today\./);
  t.match(p, /Round 1 Projected H3 L\.A\. Looks advances \(proj\.\) H6 Sex Manther/);
  t.match(p, /Round 1 Projected H4 Gride advances \(proj\.\) H5 The Long Haulers/);
  t.match(p, /First-round byes: H1 Hawks · H2 Cleon Ca\$h/);
  t.match(p, /Hawk Tuah Bowl final Projected H1 Hawks advances \(proj\.\) H2 Cleon Ca\$h Winner 7th \(pick 1\.01\) · loser 8th \(pick 1\.02\)/);
  t.match(p, /5th-place game · Round 1 losers Projected .* Winner 11th \(pick 1\.05\) · loser 12th \(pick 1\.06\)/);
  t.match(p, /3rd-place game · semifinal losers Projected .* Winner 9th \(pick 1\.03\) · loser 10th \(pick 1\.04\)/);
  t.ok(!/Hawktuah/.test(p), "the owner-facing name is Hawk Tuah Bowl");
});
test("a finished season (2025): real results, Final tags, winners checked, nothing projected", async () => {
  const b = await boot();
  const champ = plain(await b.show({ mode: "playoffs", side: "champ", year: 2025 }));
  t.match(champ, /Final results\./);
  t.ok(!/Projected|If the season ended today|advances \(proj\.\)/.test(champ), "no projection over real results");
  t.match(champ, /Championship Final 1 Pure Greatness 233\.7 ✓ won 3 Sex Manther 192\.1 Winner 1st \(pick 1\.12\)/);
  t.match(champ, /Round 1 Final 3 Sex Manther 264\.7 ✓ won 6 Blake Bombers 219\.0/);
  const hawk = plain(await b.show({ mode: "playoffs", side: "hawk", year: 2025 }));
  t.match(hawk, /The recorded Hawk Tuah Bowl seeds\./);
  t.match(hawk, /Hawk Tuah Bowl final Final H1 Cleon Ca\$h 294\.4 ✓ won H3 Hawks 157\.8 Winner 7th \(pick 1\.01\)/);
});
test("Seeds option: 1-12 in order, each with the worker's seed explanation, and the playoff line", async () => {
  const b = await boot();
  const p = plain(await b.show({ mode: "playoffs", side: "seeds", year: 2026 }));
  t.match(p, /Seeds and why 1 C-Town Chivalry Seed 1: .* 4 Real Deal Creel Seed 4: behind HammerTime 🔨 ⏰ on All-Play %\. Ahead of CBP on H2H record \(same All-Play %\)\./);
  t.match(p, /6 Pure Greatness .* Playoff line · H1–H6 play the Hawk Tuah Bowl H1 Hawks/);
});
test("Tale of the Tape: header, Quick edge, Ceiling / Typical / Floor, Full comparison — ranks, edges, no prediction", async () => {
  const b = await boot();
  await b.show({ mode: "playoffs", side: "champ", year: 2026 });
  // open the 3 v 6 game the way a tap does
  b.ctx.window.UPS_MOBILE.leagueView.setStandingsView({});
  const tapeOpen = b.ctx.window.UPS_MOBILE.standingsSheet;
  t.ok(tapeOpen && typeof tapeOpen.tapeHtml === "function");
  const R = b.ctx.window.UPS_STANDINGS_RACE;
  const resp = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  const opdp = Object.fromEntries(LS.leagueStandings.franchise.map((f) => [f.id, { op: f.op, dp: f.dp }]));
  const tape = R.matchupTape(resp, "0005", "0004", { offenseIdp: opdp });
  const series = R.ownerSeries(JSON.parse(HIST), "Eric Martel", "Brian Cutting", { current: { season: 2026, games: tape.meetings } });
  const p = plain(tapeOpen.tapeHtml(tape, { kind: "projected", roundLabel: "Round 1 · Week 15", aSeed: "3", bSeed: "6", aOwner: "Eric Martel", bOwner: "Brian Cutting", series }));
  t.match(p, /Projected matchup — if the season ended today · Round 1 · Week 15 3 HammerTime 🔨 ⏰ Eric Martel H2H 9-4 · All-Play 37-18 vs 6 Pure Greatness Brian Cutting H2H 6-7 · All-Play 31-24/);
  t.match(p, /This season: Week 1 — HammerTime 🔨 ⏰ won, 312\.8–258\.5 · Week 4 — HammerTime 🔨 ⏰ won, 250\.2–211\.6/);
  t.equal(order(p, ["1 · Quick edge", "2 · Ceiling / Typical / Floor", "3 · Full comparison"]), "ok", "the three sections, in Keith's order");
  t.match(p, /Edges: HammerTime 🔨 ⏰ 3, Pure Greatness 2 \(of 5\)\. What has happened so far, not a prediction\./);
  t.match(p, /▲ 237\.4 3rd Season scoring average regular season, per week 230\.2 4th/);
  t.match(p, /221\.9 6th Last 3 weeks average Weeks 3–5 ▲ 231\.0 4th/);
  t.match(p, /▲ 19-14 Last 3 weeks All-Play 17-16/);
  t.match(p, /▲ 7\.4 3rd All-Play wins per week of 11 6\.2 6th/);
  t.match(p, /11th ±42\.5 Consistency 1st = steadiest week to week ▲ 6th ±27\.7/);
  t.match(p, /▲ 312\.8 1st Wk 1 Highest week 268\.4 6th Wk 2/);
  t.match(p, /▲ 224\.8 3rd Median week 212\.9 8th/);
  t.match(p, /190\.7 4th Wk 2 Lowest week ▲ 199\.6 3rd/);
  t.match(p, /175\.6 4th Offense points per week offensive players ▲ 183\.7 2nd/);
  t.match(p, /▲ 61\.8 3rd IDP points per week defensive players 46\.5 10th/);
  t.match(p, /218\.4 6th most Points faced per H2H game schedule experience, not skill 225\.5 2nd most/);
  t.match(p, /H2H history · Eric Martel vs Brian Cutting Regular season 9-2 · Playoffs 0-1/);
  t.match(p, /Seasons both were owner of record: 2023–2026\./);
  t.ok(!/defen[cs]e/i.test(p.replace(/defensive players/g, "")), "points faced are never 'defense'");
  t.ok(!/will win|favorite|predicted winner|projected winner/i.test(p), "no predicted winner");
});

await run("standings_mobile_brackets");
mfl.restore();
restore();
