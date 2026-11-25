// UPS 2027 Preview 0: the controller (apps/mobile2027/src/app.js) run against a stub page and a fake fetch.
//   node tests/mobile2027_controller.test.mjs
//
// Offline. The real app.js and the real libraries run in a vm; the page is a small stub (innerHTML capture, attribute
// storage, history, location, localStorage) and fetch is a fake that serves the recorded public reads. What is proven:
// loading, the screens after each tap, one profile read of the worker calculation, Back closing a profile, a deep link,
// the three things stored on the phone, a failed read and its retry, and that every request is a bare GET.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX2 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r2_reads.json"), "utf8")); // stage R2 reads
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8")); // stage R3: season figures, team history and weekly player scores (real public data)
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8")); // PR B: the whole league, Weeks 1 to 10 (real public data)
// The injury resolver the page loads is the beta's DERIVED copy, made from the reviewed copy of the classic file (tests never read site/shared/).
const BUILD = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const INJURY_PURE = BUILD.derivedBytes(BUILD.DERIVED[0], FIXSH).toString("utf8");
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const isCalCall = (c) => c.type === "nflByeWeeks" || (c.type === "nflSchedule" && new URL(c.url).searchParams.get("W") === "ALL");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
// PR A: next season's ledger as the Worker returns it (the shape is read from worker/src/index.js, GET /api/cap-adjustments/next-season)
const NEXT_LEDGER = { ok: true, season: "2026", next_season: 2027, league_id: "74598", by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [
  { player_id: "12801", player: "Name In Text", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-09-01T00:00:00Z", kind: "Drop (next season)", in_mfl: false },
  { player_id: null, player: "Missed nomination", franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28", kind: "RULE 2 fine (next season)", in_mfl: false }] };

// Week 11 as it reads once every game is over (the Thursday fixture has 1 of 13 final)
const week11Final = () => { const s = JSON.parse(JSON.stringify(FX4.schedule11)); s.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; }); return s; };
// PR A revision: MFL's complete player list (the ids these tests use; same shape as the export) and the league's salary cap, as the roster read reports it
const PLAYERS = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/players_subset.json"), "utf8"));
const ROSTER_READ = Object.assign({}, FX.roster_workbench, { salary_cap_dollars: 300000 });
// PR B: the whole league's positions (recorded public read); the real export always carries a name, so the stub gives each row one (the ranks never show it)
const PLAYERS_ALL = { players: { player: FX4.players.map((p) => Object.assign({ name: "Player, " + p.id }, p)) } };

function boot({ hash = "", stored = {}, failRoster = 0, failPenalty = 0, hold = false, holdPen = false, failStatus = 0, failWeek10 = 0, clock = null, holdIntel = false, r3 = false, failScores = 0, failNext = 0, failPlayers = 0, lmEdit = null, sched11 = null, sched10 = null, calEdit = null, failCal = 0 } = {}) {
  const calls = [];
  let releasePen = () => {}; const penGate = holdPen ? new Promise((r) => { releasePen = r; }) : null;
  let release = () => {}; const gate = hold ? new Promise((r) => { release = r; }) : null; // holds the roster read open until release()
  const state = { failRoster, failPenalty, failStatus, failWeek10, failScores, failNext, failPlayers, failCal, w11: false, fail11: 0 };   // w11: the league has since finished Week 11; fail11: how many Week 11 score reads fail
  let releaseIntel = () => {}; const intelGate = holdIntel ? new Promise((r) => { releaseIntel = r; }) : null; // holds the Team › Roster adds open until releaseIntel()
  const body = (u) => {
    if (u.pathname === "/roster-workbench") return ROSTER_READ;
    if (u.pathname === "/api/current-lineup-week") return FX.current_lineup_week;
    if (u.pathname === "/api/cap-penalty/preview") return FX.cap_penalty;
    if (u.pathname === "/api/cap-adjustments/next-season") return NEXT_LEDGER;
    if (u.pathname === "/api/player-status") return FX2.player_status;
    if (u.pathname === "/api/lineup-matchups") { let b = Object.assign({}, r3 ? FX3.lineup_matchups_w11 : FX2.lineup_matchups_w11, r3 ? FX4.hist : {}, { week: Number(u.searchParams.get("W")) });
      if (state.w11) { b = JSON.parse(JSON.stringify(b)); Object.keys(b.matchups).forEach((c) => { b.matchups[c].status = "final"; }); b.season.lastCompleteWeek = 11; }
      return lmEdit ? lmEdit(b) : b; }
    if (u.searchParams.get("TYPE") === "league") return FX.league;
    // R6: the game-stats read of one player (no weeks here: the Breakdown's own tests, mobile2027_r6_breakdown, use real captured answers)
    if (u.pathname === "/api/player-weekly-box") return { ok: true, season: 2026, mfl_id: u.searchParams.get("mfl_id"), gsis_id: "00-0000000", id_source: "test", box_through_week: 10, weeks: [] };
    // PR B: the whole-league reads the Performance screen needs (weekly scores Weeks 1 to 10, positions, the NFL schedules of Weeks 10 and 11)
    if (u.searchParams.get("TYPE") === "players") return r3 ? PLAYERS_ALL : PLAYERS;
    if (u.searchParams.get("TYPE") === "nflByeWeeks") return CAL.byes;
    if (u.searchParams.get("TYPE") === "nflSchedule" && u.searchParams.get("W") === "ALL") return calEdit ? calEdit(JSON.parse(JSON.stringify(CAL.full))) : CAL.full;
    if (u.searchParams.get("TYPE") === "nflSchedule") return u.searchParams.get("W") === "10" ? (sched10 || FX4.schedule10) : u.searchParams.get("W") === "11" ? (state.w11 ? week11Final() : (sched11 || FX4.schedule11)) : { nflSchedule: { matchup: [] } };
    if (u.searchParams.get("TYPE") === "playerScores") { const w = u.searchParams.get("W"); return { playerScores: { playerScore: (r3 ? FX4.scores[w] || (w === "11" ? (state.w11 ? [{ id: "1", score: "0" }, { id: "15698", score: "28.44" }] : [{ id: "1", score: "0" }]) : []) : FX3.scores[w]) || [] } }; }
    return u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
  };
  const fetchFake = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url, path: u.pathname, type: u.searchParams.get("TYPE"), opts });
    if (gate && u.pathname === "/roster-workbench") await gate;
    if (penGate && u.pathname === "/api/cap-penalty/preview") await penGate;
    if (u.pathname === "/roster-workbench" && state.failRoster > 0) { state.failRoster--; return { ok: false, status: 503, text: async () => "down" }; }
    if (u.pathname === "/api/cap-penalty/preview" && state.failPenalty > 0) { state.failPenalty--; return { ok: false, status: 500, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && (u.searchParams.get("TYPE") === "nflByeWeeks" || (u.searchParams.get("TYPE") === "nflSchedule" && u.searchParams.get("W") === "ALL")) && state.failCal > 0) { state.failCal--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/cap-adjustments/next-season" && state.failNext > 0) { state.failNext--; return { ok: false, status: 500, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "players" && state.failPlayers > 0) { state.failPlayers--; return { ok: false, status: 502, text: async () => "x" }; }
    if (intelGate && (u.pathname === "/api/player-status" || u.pathname === "/api/lineup-matchups")) await intelGate;
    if (u.pathname === "/api/player-status" && state.failStatus > 0) { state.failStatus--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "playerScores" && u.searchParams.get("W") === "11" && state.fail11 > 0) { state.fail11--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "playerScores" && state.failScores > 0) { state.failScores--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "weeklyResults" && u.searchParams.get("W") === "10" && state.failWeek10 > 0) { state.failWeek10--; return { ok: false, status: 502, text: async () => "x" }; }
    // R7: the two draft #1515 routes are not on the deployed Worker, which answers 404 ("absent": Not Available, never asked again in a loop)
    if (u.pathname === "/api/player-projections" || u.pathname === "/api/position-season-stats") return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body(u)) };
  };
  const listeners = {}, winL = {}, docAttrs = {}, storage = { ...stored }, pushes = [], replaces = [];
  const appEl = {
    innerHTML: "", addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    contains: () => true, querySelector: () => null, querySelectorAll: () => [],
  };
  const location = { hash, pathname: "/", search: "" };
  const history = {
    state: null,
    pushState(s, _t, u) { this.state = s; pushes.push(u); location.hash = u; },
    replaceState(s, _t, u) { this.state = s; replaces.push(u); location.hash = ""; },
    back() { this.state = null; location.hash = ""; (winL.popstate || (() => {}))(); },
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, URL, URLSearchParams, Intl, JSON, Date: clock ? clock.Date : Date, Math, Promise, Array, Object, String, Number, isFinite, parseInt, parseFloat, encodeURIComponent,
    AbortController: undefined, // not needed by the stub; the loader runs without a timer
    document: { getElementById: (id) => (id === "app" ? appEl : null), documentElement: { setAttribute(k, v) { docAttrs[k] = v; } }, activeElement: null, title: "" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    history, location,
  });
  ctx.window = ctx;
  ctx.fetch = fetchFake;
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.addEventListener = (type, fn) => { winL[type] = fn; };
  vm.runInContext(INJURY_PURE, ctx, { filename: "shared/injury_status.pure.js" });
  // These tests run the page in LIVE mode against their own fake fetch (the committed default is recorded-data mode, which is tested in mobile2027_recorded.test.mjs).
  for (const f of ["config.js", "lib/format.js", "lib/contract.js", "lib/reviewed_names.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/coverage.js", "lib/data.js", "lib/recorded.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/boxlog.js", "lib/statranks.js", "lib/tabviews.js", "lib/breakdown.js", "lib/views.js", "app.js"]) {
    vm.runInContext(read(f), ctx, { filename: f });
    if (f === "config.js") ctx.UPS2027_CONFIG.data = "live";
  }
  const click = async (attrs) => {
    const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } }));
    await tick();
  };
  return { setWeek11Final: (fail) => { state.w11 = true; state.fail11 = fail || 0; }, setFailScores: (n) => { state.failScores = n; }, appEl, calls, storage, pushes, replaces, docAttrs, history, location, click, winL, listeners, release: () => release(), releasePen: () => releasePen(), releaseIntel: () => releaseIntel(), html: () => appEl.innerHTML };
}

test("boot: loads the roster, shows the first team with starters above the bench, and every request is a bare GET", async () => {
  const a = boot();
  t.match(a.html(), /aria-busy="true"/, "a loading state is drawn first");
  await tick(30);
  t.match(a.html(), /Starting lineup · /); t.match(a.html(), /Blake Bombers/); t.match(a.html(), /Data as of/);
  // the four core reads, then the Team › Roster adds (injury status, this week's NFL games, and the one stored-projection read the Lineup view shows as "Proj."), each once
  t.deepEqual(a.calls.map((c) => c.path).sort(), ["/api/current-lineup-week", "/api/lineup-matchups", "/api/mfl-export", "/api/mfl-export", "/api/player-projections", "/api/player-status", "/roster-workbench"]);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.equal(c.opts.headers, undefined); });
  t.equal(a.docAttrs["data-skin"], "light"); t.equal(a.docAttrs["data-vib"], "1");
});

test("taps: expand and collapse all, open Team › Contracts, open the placeholder tabs, come back", async () => {
  const a = boot(); await tick(30);
  // R6: Bench, Injured reserve and Taxi squad are one card each, open by default (the full list); each heading collapses its card
  const before = (a.html().match(/data-act="card"/g) || []).length;
  t.match(a.html(), /data-g="bench" aria-expanded="true"/);
  await a.click({ "data-act": "grp", "data-g": "bench" });
  t.match(a.html(), /data-g="bench" aria-expanded="false"/); t.ok((a.html().match(/data-act="card"/g) || []).length < before, "the bench card closed");
  await a.click({ "data-act": "grp", "data-g": "bench" });
  t.equal((a.html().match(/data-act="card"/g) || []).length, before, "and opened again");
  await a.click({ "data-act": "expall" });
  t.ok((a.html().match(/data-act="card"/g) || []).length < before, "the (unused) expall handler still closes all three sections");
  await a.click({ "data-act": "expall" });
  t.equal((a.html().match(/data-act="card"/g) || []).length, before);
  await a.click({ "data-act": "sub", "data-v": "contracts" });
  t.match(a.html(), /Cap space · 2026 season/); t.match(a.html(), /Expires 20\d\d/);
  await a.click({ "data-act": "sub", "data-v": "cap" }); t.match(a.html(), /Cap space is left out on purpose/);
  await a.click({ "data-act": "nav", "data-v": "market" }); t.match(a.html(), /not in Preview 0/i); t.doesNotMatch(a.html(), /Starting lineup · /);
  await a.click({ "data-act": "nav", "data-v": "team" }); t.match(a.html(), /Cap space is left out on purpose/, "the Team tab keeps its sub-tab");
});

test("a profile: one read of the worker calculation, shared by every profile; Back closes it; the sections open and close", async () => {
  const a = boot(); await tick(30);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid });
  t.deepEqual(a.pushes, ["#p=" + pid]); t.match(a.html(), /role="dialog"/); t.match(a.html(), /Salary 2026/);
  await tick(20);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 1);
  t.match(a.html(), /Earned to date/); t.doesNotMatch(a.html(), /Loading…/);
  await a.click({ "data-act": "tog", "data-v": "cut" }); t.match(a.html(), /Nothing can be cut from here/);
  await a.click({ "data-act": "tog", "data-v": "cut" }); t.doesNotMatch(a.html(), /Nothing can be cut from here/);
  await a.click({ "data-act": "ptab", "data-v": "more" }); t.match(a.html(), /Roster spot/);
  await a.click({ "data-act": "ptab", "data-v": "sched" }); t.match(a.html(), /not in Preview 0/);
  await a.click({ "data-act": "close" });
  t.doesNotMatch(a.html(), /role="dialog"/, "Back (history.back) closed the profile"); t.equal(a.location.hash, "");
  const other = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[1].id;
  await a.click({ "data-act": "card", "data-pid": other }); await tick(20);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 1, "the calculation is not read again for the next player");
  t.deepEqual(a.pushes, ["#p=" + pid, "#p=" + other]);
});

test("a deep link opens the profile and its team without pushing history; closing clears the address", async () => {
  const sn = FX.roster_workbench.teams.find((x) => x.franchise_id === "0009").players.find((p) => /Smith-Njigba/.test(p.name));
  const a = boot({ hash: "#p=" + sn.id }); await tick(40);
  t.match(a.html(), /Jaxon Smith-Njigba/); t.match(a.html(), /role="dialog"/); t.deepEqual(a.pushes, []);
  await a.click({ "data-act": "close" });
  t.deepEqual(a.replaces, ["/"]); t.doesNotMatch(a.html(), /role="dialog"/);
  t.match(a.html(), /C-Town Chivalry/, "the team behind the profile is the team shown");
  const b = boot({ hash: "#t=0009" }); await tick(30); t.match(b.html(), /C-Town Chivalry/);
  const c = boot({ hash: "#p=99999999" }); await tick(30); t.match(c.html(), /Player not found/);
});

test("what is stored on the phone: skin, position colors and the last team, and nothing else", async () => {
  const a = boot(); await tick(30);
  await a.click({ "data-act": "about" }); t.match(a.html(), /About Preview 0/);
  await a.click({ "data-act": "skin", "data-v": "hc" }); t.equal(a.docAttrs["data-skin"], "hc");
  await a.click({ "data-act": "skin", "data-v": "dark" }); t.equal(a.docAttrs["data-skin"], "dark");
  await a.click({ "data-act": "vib", "data-v": "0" }); t.equal(a.docAttrs["data-vib"], "0");
  await a.click({ "data-act": "close" });
  await a.click({ "data-act": "teams" }); t.match(a.html(), /Choose a team/);
  await a.click({ "data-act": "pickteam", "data-fid": "0009" }); t.match(a.html(), /C-Town Chivalry/); t.doesNotMatch(a.html(), /Choose a team/);
  t.deepEqual(Object.keys(a.storage).sort(), ["ups2027-p0-skin", "ups2027-p0-team", "ups2027-p0-vib"]);
  t.deepEqual({ ...a.storage }, { "ups2027-p0-skin": "dark", "ups2027-p0-team": "0009", "ups2027-p0-vib": "0" });
  const b = boot({ stored: { "ups2027-p0-skin": "hc", "ups2027-p0-vib": "0", "ups2027-p0-team": "0009" } }); await tick(30);
  t.equal(b.docAttrs["data-skin"], "hc"); t.equal(b.docAttrs["data-vib"], "0"); t.match(b.html(), /C-Town Chivalry/);
  const c = boot({ stored: { "ups2027-p0-team": "7777" } }); await tick(30); t.match(c.html(), /Blake Bombers/, "an unknown remembered team falls back to the first");
});

test("a failed read shows a retry that works; a failed calculation shows 'Not available' and a retry that works", async () => {
  const a = boot({ failRoster: 1 }); await tick(30);
  t.match(a.html(), /Couldn’t read the league data/); t.match(a.html(), /HTTP 503/); t.doesNotMatch(a.html(), /Starting lineup · /);
  await a.click({ "data-act": "retry" }); await tick(30);
  t.match(a.html(), /Starting lineup · /);
  const b = boot({ failPenalty: 1 }); await tick(30);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await b.click({ "data-act": "card", "data-pid": pid }); await tick(20);
  t.match(b.html(), /Not available/); t.match(b.html(), /data-act="retrypen"/); t.match(b.html(), /Couldn’t load this/); t.match(b.html(), /Report bug/);
  await b.click({ "data-act": "retrypen" }); await tick(20);
  t.doesNotMatch(b.html(), /data-act="retrypen"/); t.equal(b.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 2);
});

test("popstate and Escape close the profile; a reload clears the calculation and reads the league again", async () => {
  const a = boot(); await tick(30);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20);
  a.location.hash = ""; a.winL.popstate(); await tick();
  t.doesNotMatch(a.html(), /role="dialog"/);
  a.location.hash = "#p=" + pid; a.winL.popstate(); await tick(); t.match(a.html(), /role="dialog"/);
  (a.listeners.keydown || []).forEach((fn) => fn({ key: "Escape" })); await tick();
  t.doesNotMatch(a.html(), /role="dialog"/);
  const roster = () => a.calls.filter((c) => c.path === "/roster-workbench").length;
  const before = roster();
  await a.click({ "data-act": "about" }); await a.click({ "data-act": "retry" }); await tick(30);
  t.equal(roster(), before + 1); t.doesNotMatch(a.html(), /About Preview 0/);
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 2, "the calculation is read again after a reload");
});

test("Sample mode: while it is on the page starts no new request (not a read, not a retry, not a profile's calculation, not a photo), and nothing about it is stored", async () => {
  const a = boot(); await tick(30);
  const before = a.calls.length; t.ok(before >= 4, "the normal load made its reads");
  t.match(a.html(), /<img[^>]*data-chain/, "the real Team screen draws headshots (so the no-image check below can fail)");
  await a.click({ "data-act": "about" }); t.match(a.html(), /Turn Sample mode on/);
  const loggedBefore = /<b>(\d+)<\/b> data requests/.exec(a.html())[1];
  await a.click({ "data-act": "sample" });
  t.match(a.html(), /Sample data · nothing is real and nothing is sent/); t.match(a.html(), /Turn Sample mode off/);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "close" });
  t.match(a.html(), /Nothing here is real, and nothing is sent\./); t.doesNotMatch(a.html(), /Starting lineup · /);
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20);
  await a.click({ "data-act": "retry" }); await a.click({ "data-act": "retrypen" }); await tick(20);
  await a.click({ "data-act": "nav", "data-v": "market" }); await a.click({ "data-act": "nav", "data-v": "team" }); await tick(20);
  t.equal(a.calls.length, before, "zero requests were made while Sample mode was on");
  // headshots are requests too (the browser fetches an <img> by itself): Sample mode never draws one, so none starts
  await a.click({ "data-act": "about" }); t.doesNotMatch(a.html(), /<img\b|data-chain|espncdn|player_photos/, "no image is drawn in Sample mode (About)"); await a.click({ "data-act": "close" });
  t.doesNotMatch(a.html(), /<img\b|data-chain|espncdn|player_photos/, "no image is drawn in Sample mode (screens)");
  await a.click({ "data-act": "about" }); t.match(a.html(), new RegExp("<b>" + loggedBefore + "</b> data requests"), "the loader was not even asked: its own log did not grow, so the page's two guards held without the fetch guard");
  await a.click({ "data-act": "close" });
  t.doesNotMatch(JSON.stringify(a.storage), /sample/i, "nothing about Sample mode is stored on the phone");
  // turning it off brings the real screens back
  await a.click({ "data-act": "sample" });
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Preview: view only/); t.match(a.html(), /Starting lineup · /);
  // it is never remembered: a fresh page starts with it off
  const b = boot(); await tick(30); t.doesNotMatch(b.html(), /Sample data/); t.match(b.html(), /Preview: view only/);
});

test("Sample mode switched on while the first read is out, or with a profile open: nothing late is drawn, nothing is left stuck, and off reads again", async () => {
  const a = boot({ hold: true }); await tick(10);
  t.match(a.html(), /aria-busy="true"/, "the first read is still out");
  await a.click({ "data-act": "about" }); await a.click({ "data-act": "sample" });
  const atOn = a.calls.length; a.release(); await tick(30);
  t.equal(a.calls.length, atOn, "no request left the page after Sample mode went on, not even the rest of the load");
  t.match(a.html(), /Sample data · nothing is real and nothing is sent/); t.doesNotMatch(a.html(), /Starting lineup · /, "the late answer was dropped, not drawn");
  t.doesNotMatch(a.html(), /Reload the data/, "Reload is paused while Sample mode is on");
  await a.click({ "data-act": "sample" }); await tick(40);
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Starting lineup · /, "turning it off read the league again instead of leaving a spinner or an error");
  // a profile that is open when Sample mode goes on is closed, and is not left stuck on the way back
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "close" }); t.doesNotMatch(a.html(), /role="dialog"/, "the About sheet is closed");
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20); t.match(a.html(), /role="dialog"/);
  await a.click({ "data-act": "sample" }); t.doesNotMatch(a.html(), /role="dialog"/, "no profile is drawn in Sample mode"); t.match(a.html(), /Nothing here is real/);
  await a.click({ "data-act": "sample" }); await tick(20); t.doesNotMatch(a.html(), /role="dialog"/); t.match(a.html(), /Starting lineup · /);
});

test("a calculation that finishes after Sample mode went on is dropped, and the profile reads it again afterward", async () => {
  const a = boot({ holdPen: true }); await tick(30);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(10);
  await a.click({ "data-act": "sample" }); a.releasePen(); await tick(30);
  await a.click({ "data-act": "sample" }); await tick(20);
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 2, "the late answer was not kept as if it were current");
});


// ───────────────────────── stage R2: Team › Roster reads and views ─────────────────────────
const asked = (a) => a.calls.map((c) => c.path.replace(/^\/(api\/)?/, "") + (c.url.match(/[?&]W=(\d+)/) ? "#" + c.url.match(/[?&]W=(\d+)/)[1] : ""));
const FakeClock = () => { const c = { t: Date.now() }; c.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(c.t); } static now() { return c.t; } }; return c; };

test("R2: switching views, weeks and teams never asks for a read again; each added address is asked for once", async () => {
  const a = boot(); await tick(40);
  t.deepEqual(asked(a).sort(), ["current-lineup-week", "lineup-matchups#11", "mfl-export", "mfl-export#11", "player-projections", "player-status", "roster-workbench"].sort(), "boot: the four core reads, injury status, this week's games and the one projection read for the Lineup view");
  const n0 = a.calls.length;
  await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await tick(10);
  t.equal(a.calls.length, n0, "going back and forth between the two views asks nothing");
  await a.click({ "data-act": "pickteam", "data-fid": "0009" }); await a.click({ "data-act": "pickteam", "data-fid": "0010" }); await tick(10);
  // R11: the Lineup view's one projection read is per team (its own ids): the first visit to another team asks for it once, and going back asks nothing
  const pj = a.calls.slice(n0); t.deepEqual(pj.map((c) => c.path), ["/api/player-projections"], "changing teams asks only for that team's one projection read (the other reads cover the whole league)");
  t.equal(new URL(pj[0].url).searchParams.get("week"), "11"); t.notEqual(pj[0].url, a.calls.find((c) => c.path === "/api/player-projections").url, "for the other team's ids");
  const n1 = a.calls.length;
  await a.click({ "data-act": "pickteam", "data-fid": "0009" }); await a.click({ "data-act": "pickteam", "data-fid": "0010" }); await tick(10);
  t.equal(a.calls.length, n1, "visiting teams again asks nothing");
  // a past week: its lineup and its games, once; the week before is already in memory
  await a.click({ "data-act": "weeks" }); t.match(a.html(), /aria-label="Choose a week"/);
  await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(40);
  t.deepEqual(asked(a).slice(n1), ["mfl-export#10"], "Week 10's lineups and scores: one request, and a past week asks for no NFL games (MAT-1) and no projection");
  t.match(a.html(), /Week 10 · played/); t.doesNotMatch(a.html(), /Bench · /);
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "9" }); await tick(40);
  t.deepEqual(asked(a).slice(n1 + 1), ["mfl-export#9"], "Week 9, first visit: one request (its lineups and scores)");
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(10);
  await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(10);
  t.equal(a.calls.length, n1 + 2, "revisiting past weeks asks nothing");
  await a.click({ "data-act": "pickweek", "data-v": "11" }); await tick(10);
  t.match(a.html(), /Starting lineup · /); t.equal(a.calls.length, n1 + 2, "back to the current week: nothing");
  await a.click({ "data-act": "pickweek", "data-v": "12" }); t.doesNotMatch(a.html(), /Week 12 starters/, "a later week cannot be chosen"); t.equal(a.calls.length, n1 + 2);
  const keys = a.calls.map((c) => c.url); t.equal(new Set(keys).size, keys.length, "no address was asked twice in the whole visit");
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
  t.doesNotMatch(JSON.stringify(a.storage), /wk|week|intel|status/i, "no week or read is stored on the phone");
});

test("R2: the injury read is asked again only when it has gone stale and the screen is used; an old read never shows chips", async () => {
  const clock = FakeClock(); const a = boot({ clock }); await tick(40);
  t.match(a.html(), /▲ Questionable/, "chips show while the read is fresh");
  const n0 = a.calls.length;
  clock.t += 4 * 60 * 1000; await a.click({ "data-act": "view", "data-v": "byes" }); await tick(20); t.equal(a.calls.length, n0, "4 minutes: not asked again");
  clock.t += 2 * 60 * 1000; await a.click({ "data-act": "view", "data-v": "lineup" }); await tick(30);
  t.deepEqual(asked(a).slice(n0).filter((k) => k === "player-status"), ["player-status"], "6 minutes: asked once more");
  t.match(a.html(), /▲ Questionable/, "and the chips are there again");
  t.equal(asked(a).filter((k) => k === "player-status").length, 2);
});

test("R2: a failed injury read says so, shows no guessed tags, and Try again recovers; a failed past week offers its own retry", async () => {
  const a = boot({ failStatus: 1, failWeek10: 1 }); await tick(40);
  t.match(a.html(), /Injury status couldn’t be loaded, so no injury tags are shown/); t.doesNotMatch(a.html(), /▲ Questionable/);
  t.match(a.html(), /Starting lineup · /, "the roster still shows");
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(30);
  t.match(a.html(), /That week’s lineup could not be read \(HTTP 502\)/); t.match(a.html(), /data-act="pickweek" data-v="10"/);
  await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(30);
  t.match(a.html(), /Recorded starters · Week 10/); t.doesNotMatch(a.html(), /could not be read/);
  await a.click({ "data-act": "pickweek", "data-v": "11" });
  await a.click({ "data-act": "retry" }); await tick(40);
  t.doesNotMatch(a.html(), /Injury status couldn’t be loaded/); t.match(a.html(), /▲ Questionable/, "Reload the data asks again and recovers");
});

test("R2: Sample mode starts no Team › Roster read either, drops one already out, and asks again for what is missing when it ends", async () => {
  const a = boot({ holdIntel: true }); await tick(30);
  t.deepEqual(asked(a).filter((k) => /player-status|lineup-matchups/.test(k)).sort(), ["lineup-matchups#11", "player-status"], "the two reads are out (held open)");
  const before = a.calls.length;
  await a.click({ "data-act": "sample" });
  a.releaseIntel(); await tick(30);
  t.equal(a.calls.length, before, "nothing new started, and the answers that arrived late were dropped");
  t.match(a.html(), /Sample data/); t.doesNotMatch(a.html(), /▲ Questionable|QB1/, "no late data is drawn");
  await a.click({ "data-act": "about" }); const logged = /<b>(\d+)<\/b> data requests/.exec(a.html())[1]; await a.click({ "data-act": "close" });
  await a.click({ "data-act": "nav", "data-v": "team" }); await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "sub", "data-v": "roster" }); await a.click({ "data-act": "weeks" });
  t.equal(a.calls.length, before, "tapping around in Sample mode starts nothing");
  await a.click({ "data-act": "about" }); t.match(a.html(), new RegExp("<b>" + logged + "</b> data requests"), "the loader was not even asked: its log did not grow, so the page's own guard held without the fetch guard"); await a.click({ "data-act": "close" });
  await a.click({ "data-act": "sample" }); await tick(40);
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Starting lineup · /);
  t.match(a.html(), /▲ Questionable/, "the answers that arrived while Sample mode was on were kept in memory (not drawn then), so they show now");
  t.deepEqual(asked(a).slice(before).filter((k) => !/mfl-export#(8|9|10|11)/.test(k)), [], "and the held reads were not asked again; only Team › Performance, which the owner chose meanwhile, needs the four weeks of scores");
  // a read that never finished is asked for again, not waited for
  const b = boot({ holdIntel: true }); await tick(30); const nb = b.calls.length;
  await b.click({ "data-act": "sample" }); await b.click({ "data-act": "sample" }); await tick(10);
  t.deepEqual(asked(b).slice(nb).sort(), ["lineup-matchups#11", "player-status"], "never finished: asked for again when Sample mode ends");
  b.releaseIntel(); await tick(40); t.match(b.html(), /▲ Questionable/);
});

// R6 (changed deliberately): the R2 "Bench groups" setting is retired. The three section cards are open by default, so there is no
// "only what needs you" default left to choose; a stored old choice changes nothing, and the owner's own tap is what collapses a card.
test("R6: the bench-group setting is retired; sections open by default; a stored old choice changes nothing; a tap collapses", async () => {
  const a = boot(); await tick(40);
  t.match(a.html(), /data-g="bench" aria-expanded="true"/);
  await a.click({ "data-act": "about" }); t.doesNotMatch(a.html(), /Bench groups|data-act="gdef"/); await a.click({ "data-act": "close" });
  const b = boot({ stored: { "ups2027-p0-gdef": "all" } }); await tick(40); t.equal(b.html().replace(/Build [^<]*/, ""), a.html().replace(/Build [^<]*/, ""), "an old stored choice draws the same page");
  await a.click({ "data-act": "grp", "data-g": "taxi" }); t.match(a.html(), /data-g="taxi" aria-expanded="false"/, "an owner's own tap collapses a card");
  t.equal(a.storage["ups2027-p0-gdef"], undefined, "nothing about it is stored");
});

// ───────────────────────── stage R2b: one week context, in the running page ─────────────────────────

test("R2b: a chosen past week is kept across Byes, which always shows today; going back finds the same week; nothing is asked", async () => {
  const a = boot(); await tick(40);
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(40);
  t.match(a.html(), /Recorded starters · Week 10/); t.match(a.html(), /class="wsel past"/);
  const n = a.calls.length;
  for (const round of [1, 2]) {
    for (const v of ["byes"]) {
      await a.click({ "data-act": "view", "data-v": v });
      t.match(a.html(), /As of now · Week 11/, v + " (round " + round + "): as of now"); t.doesNotMatch(a.html(), /class="wsel/, v + ": no week bar over today's data");
      t.doesNotMatch(a.html(), /Recorded starters · Week 10|Week 10 · played|Played · as MFL recorded it/, v + ": nothing labeled with the past week");
    }
    await a.click({ "data-act": "view", "data-v": "lineup" });
    t.match(a.html(), /Recorded starters · Week 10/, "Lineup: the week chosen before is still chosen"); t.match(a.html(), /class="wsel past"/); t.doesNotMatch(a.html(), /As of now/);
    await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" });
    t.match(a.html(), /Recorded starters · Week 10/, "through Byes and back: still Week 10");
  }
  t.equal(a.calls.length, n, "switching between the past and the present views asks for nothing");
  // choosing the current week again returns every view to the present
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "11" }); await tick(5);
  t.match(a.html(), /Starting lineup · /); t.doesNotMatch(a.html(), /class="wsel past"/);
  await a.click({ "data-act": "view", "data-v": "lineup" }); t.match(a.html(), /Starting lineup · /);
  t.equal(a.calls.length, n); a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

// ───────────────────────── stage R3: Team › Contracts, Team › Performance and the profile game log ─────────────────────────
const scoreReads = (a) => a.calls.filter((c) => c.type === "playerScores").map((c) => Number(c.url.match(/[?&]W=(\d+)/)[1]));

test("R3: Team › Contracts paints the table first and says Loading… for the guarantee column; the answer then fills it; nothing is $0 while it is out", async () => {
  const a = boot({ holdPen: true }); await tick(40); const n = a.calls.length;
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(5);
  t.match(a.html(), /Cap space · 2026 season/); t.match(a.html(), /<span>If cut now<\/span>/); t.match(a.html(), /Loading…/, "the If cut now column says Loading (R8: it replaced the guarantee column)");
  t.doesNotMatch(a.html(), /Fully earned|Not applicable|No guarantee|\$1K rule/); t.doesNotMatch(a.html(), /<b>\$0<\/b>/);
  t.deepEqual(a.calls.slice(n).map((c) => c.path + (c.type ? ":" + c.type : "")), ["/api/cap-penalty/preview", "/api/mfl-export:players"], "the extra reads are the guarantee calculation, asked after the table was drawn, and MFL's player list (PR A)");
  a.releasePen(); await tick(30);
  t.doesNotMatch(a.html(), /Loading…/); t.match(a.html(), /\$[\d,]+<\/b>|Fully earned|Not applicable|Under review|Unavailable/, "the column now holds guarantee values");
  await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(10);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 1, "coming back asks nothing more");
});

test("R3: a failed guarantee read says Unavailable (never $0), offers Try again, and recovers", async () => {
  const a = boot({ failPenalty: 1 }); await tick(40);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(30);
  t.match(a.html(), /Unavailable/); t.match(a.html(), /data-act="retrypen"/); t.doesNotMatch(a.html(), /Fully earned/); t.doesNotMatch(a.html(), /<b>\$0<\/b>/);
  await a.click({ "data-act": "retrypen" }); await tick(30);
  t.doesNotMatch(a.html(), /data-act="retrypen"/); t.match(a.html(), /\$[\d,]+<\/b>|Fully earned|Not applicable/);
});

test("PR B: Team › Performance asks for the two NFL schedules, the players and the weekly scores (Weeks 1 to 10 for the season, Week 11 for the live chip), once each; going back and forth asks nothing more", async () => {
  const a = boot({ r3: true }); await tick(40); const n = a.calls.length;
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(40);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "every week of the season through the last all-final week (10), and the live Week 11");
  t.equal(a.calls.slice(n).filter((c) => c.type === "nflSchedule" && new URL(c.url).searchParams.get("W") !== "ALL").length, 2, "the schedules of Week 10 (the cutoff) and Week 11 (the lineup week)"); t.equal(a.calls.slice(n).filter((c) => c.type === "players").length, 1);
  t.equal(a.calls.slice(n).filter(isCalCall).length, 2, "and MFL's club list with byes and the whole season's schedule, one read each");
  // R7/R11: ONE week-labeled projection read for this team (lineup week 11, at most 80 ids); the Lineup view asks for it on boot, so Performance asks for it no more
  const pj = a.calls.filter((c) => c.path === "/api/player-projections");
  t.equal(pj.length, 1, "one projection read for the team view, in all"); t.equal(a.calls.slice(n).filter((c) => c.path === "/api/player-projections").length, 0, "already in memory from the Lineup view: Performance asks for none"); t.equal(new URL(pj[0].url).searchParams.get("week"), "11"); t.ok(new URL(pj[0].url).searchParams.get("ids").split(",").length <= 80);
  t.equal(a.calls.length - n, 16, "nothing else was asked (the injury, matchup and projection reads were already in memory)");
  a.calls.slice(n).forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.ok(c.path === "/api/player-projections" || ["playerScores", "nflSchedule", "players", "nflByeWeeks"].includes(c.type)); });
  t.match(a.html(), settled(10)); t.match(a.html(), /<em aria-label="PPG rank QB2">QB2<\/em>/); t.match(a.html(), />WR63–66<\/em>/);   // R6: compact ranks on the card (the comparison and the "of N" pools left the main card)
  await a.click({ "data-act": "sub", "data-v": "roster" }); await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "pfs", "data-v": "tot" }); await a.click({ "data-act": "pfs", "data-v": "ppg" }); await tick(10);   // revised: the Starters / Bench filter is gone, so only the sorts are tapped
  t.equal(a.calls.length - n, 16, "tabs and sorts ask nothing");
});

test("revised: on Team › Performance the name opens the profile and the separate details control expands the breakdown; the filter is gone; no new Performance read (R6: only his one game-stats read for the Breakdown)", async () => {
  const a = boot({ r3: true }); await tick(40);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100); let n = a.calls.length;
  t.doesNotMatch(a.html(), /data-act="pff"/); t.match(a.html(), /data-act="pfx" data-v="15698" aria-expanded="false"/);
  await a.click({ "data-act": "pfx", "data-v": "15698" }); await tick(20);
  t.match(a.html(), /data-act="pfx" data-v="15698" aria-expanded="true"/, "the details control expands the breakdown"); t.doesNotMatch(a.html(), /Player profile<\/span>/, "and does not open the profile");
  // R6 integration: the Breakdown holds his game log, so expanding asks for his one game-stats read (a bare GET) and nothing else; reopening reuses it
  // R7: plus, once his game stats are in, the ONE position pool of his group through W* for the season stat ranks (never a competitor's read)
  t.deepEqual(a.calls.slice(n).map((c) => c.path), ["/api/player-weekly-box", "/api/position-season-stats"], "expanding asks only for his game-stats read and his group's pool");
  const ps = new URL(a.calls[a.calls.length - 1].url).searchParams; t.equal(ps.get("through"), "10"); t.equal(ps.get("season"), "2026");
  await a.click({ "data-act": "pfx", "data-v": "15698" }); t.match(a.html(), /data-act="pfx" data-v="15698" aria-expanded="false"/, "and collapses it");
  await a.click({ "data-act": "pfx", "data-v": "15698" }); await a.click({ "data-act": "pfx", "data-v": "15698" }); await tick(20);
  t.equal(a.calls.slice(n).length, 2, "reopening asks nothing more"); n = a.calls.length;
  await a.click({ "data-act": "card", "data-pid": "15698" }); await tick(30);
  t.match(a.html(), /Player profile/, "the name opens the profile"); t.doesNotMatch(a.html(), /data-act="pfx" data-v="15698" aria-expanded="true"/);
  t.deepEqual(a.calls.slice(n).map((c) => c.path + (c.type ? ":" + c.type : "")), ["/api/cap-penalty/preview"], "opening a profile makes its one read of the guarantee calculation and nothing else (no new Performance read)");
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("R6: the profile's Breakdown shows every settled week, newest first, from the reads Performance already made; one game-stats read per player, reused on reopening", async () => {
  const a = boot({ r3: true }); await tick(40);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(40);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "the season through Week 10 and the live Week 11, once each");
  // R8: the Breakdown opens on Season stats; the Game log is its other tab (no score or stats read of its own)
  t.match(a.html(), new RegExp('data-act="bdt" data-v="season" data-pid="' + pid + '" aria-pressed="true"')); t.doesNotMatch(a.html(), /data-act="bdg"/, "Season stats by default: the game log is not stacked under it");
  const nTab = a.calls.length; await a.click({ "data-act": "bdt", "data-v": "log", "data-pid": pid }); await tick(10);
  t.equal(a.calls.length, nTab, "switching to Game log makes no read"); t.match(a.html(), new RegExp('data-act="bdt" data-v="log" data-pid="' + pid + '" aria-pressed="true"'));
  // R8: a verified bye row (here his Week 8) is plain text with data-week, still in the log
  const weeks = () => [...a.html().matchAll(/(?:data-act="bdg" data-v|class="pinx" data-week)="(\d+)"/g)].map((m) => +m[1]).filter((w) => w <= 10);
  t.deepEqual(weeks(), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], "every settled week, newest first: there is no 'Show earlier weeks' step");
  const box = () => a.calls.filter((c) => c.path === "/api/player-weekly-box");
  t.equal(box().length, 1, "one game-stats read"); t.match(box()[0].url, new RegExp("/api/player-weekly-box\\?season=2026&mfl_id=" + pid + "&L=74598$"));
  const n0 = a.calls.length;
  await a.click({ "data-act": "bdg", "data-v": "10", "data-pid": pid }); t.match(a.html(), /<tr class="bdd">/, "a game opens its detail");
  await a.click({ "data-act": "bdg", "data-v": "10", "data-pid": pid }); t.doesNotMatch(a.html(), /<tr class="bdd">/, "and closes it");
  await a.click({ "data-act": "ptab", "data-v": "contract" }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(20);
  await a.click({ "data-act": "close" }); await a.click({ "data-act": "card", "data-pid": pid }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(30);
  t.equal(box().length, 1, "changing tabs and reopening the profile ask nothing again"); t.deepEqual(a.calls.slice(n0).filter((c) => c.type === "playerScores"), [], "and no score is asked again");
  t.doesNotMatch(a.html(), /data-act="logmore"/);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("R6: a week of scores that cannot be read shows n/a with a retry in the Breakdown; the weeks that loaded stay; nothing is 0.0", async () => {
  const a = boot({ r3: true, failScores: 1 }); await tick(40); // the first score read (Week 1) fails; the season figures are withheld, never a partial sum
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(60);
  t.match(a.html(), /could not be read and show n\/a/); t.match(a.html(), /data-act="retrylog"/); t.match(a.html(), /season points not shown/);
  await a.click({ "data-act": "retrylog" }); await tick(60);
  t.doesNotMatch(a.html(), /could not be read/); t.match(a.html(), /Through Week 10<\/b> · \d+\.\d pts · \d+ scored games?/);
});

test("R3 review MAT-1: opening Performance while the boot matchup read is still out still asks for the weekly scores once it arrives (and so does a profile's Performance tab)", async () => {
  const a = boot({ r3: true, holdIntel: true }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(10);
  t.deepEqual(scoreReads(a), [], "nothing can be asked yet: the matchup read is held");
  a.releaseIntel(); await tick(60);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "the two callers shared one read; the second still got its follow-up");
  t.doesNotMatch(a.html(), /Loading the latest weeks/);
  const b = boot({ r3: true, holdIntel: true }); await tick(30);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await b.click({ "data-act": "card", "data-pid": pid }); await b.click({ "data-act": "ptab", "data-v": "perf" }); await tick(10);
  b.releaseIntel(); await tick(60);
  t.deepEqual(scoreReads(b).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("R3 review: a failed guarantee read is asked again only on Try again, not on every return to Contracts", async () => {
  const a = boot({ failPenalty: 1 }); await tick(40);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(20);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 1, "returning to Contracts asks nothing");
  await a.click({ "data-act": "retrypen" }); await tick(30);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 2, "Try again asks once more");
});

test("R3: a failed weekly score read shows n/a in those cells and a retry; scores that did load stay; nothing is 0.0", async () => {
  const a = boot({ r3: true, failScores: 1 }); await tick(40);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(40);
  t.match(a.html(), /Some weeks of scores could not be read/); t.match(a.html(), /data-act="retryperf"/); t.doesNotMatch(a.html(), /<span>Tot\. Pts\.<\/span><b>\d/, "no season figure is drawn from a partial set of weeks");
  await a.click({ "data-act": "retryperf" }); await tick(40);
  t.doesNotMatch(a.html(), /could not be read/); t.match(a.html(), /<span>Tot\. Pts\.<\/span><b>\d/); t.equal(scoreReads(a).length, 12, "only the failed week was asked again");
});

test("R6: the profile's Performance tab is the Breakdown, drawn from the same reads as Team › Performance (weeks, points, the exact weekly rank, the result)", async () => {
  const a = boot({ r3: true }); await tick(40);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(10);
  const n = scoreReads(a).length; t.equal(n, 0, "opening a profile asks for no scores until its Performance tab is used");
  t.equal(a.calls.filter((c) => c.path === "/api/player-weekly-box").length, 0, "and no game stats either");
  await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(40);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await a.click({ "data-act": "bdt", "data-v": "log", "data-pid": pid }); await tick(10);   // R8: Season stats | Game log
  t.match(a.html(), /Breakdown/); t.match(a.html(), /Game log/); t.match(a.html(), /<th class="pin">Game<\/th><th class="n">Pts<\/th><th class="n"[^>]*>Rank<\/th><th>Result<\/th>/);
  // R11: the Lineup view behind the profile now shows each active player's stored "Proj." (the existing projection route); that is not a model value and not the profile's Performance tab, so those rows are set aside
  t.doesNotMatch(a.html().replace(/<div class="rt pjr">[\s\S]*?<\/div>/g, ""), /xFP|Projection|projected/i, "no expected-points or projection value");
});

test("PR A: Contracts reads nothing for next season until the next-season row is opened; then one bare GET, reused; a failure offers Retry and a disabled Report bug", async () => {
  const ns = (a) => a.calls.filter((c) => c.path === "/api/cap-adjustments/next-season");
  const a = boot(); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(15);
  t.equal(ns(a).length, 0, "opening Contracts makes no next-season read");
  await a.click({ "data-act": "nsx" }); await tick(20);
  t.equal(ns(a).length, 1); t.equal(ns(a)[0].opts.method, "GET"); t.equal(ns(a)[0].opts.credentials, "omit"); t.equal(ns(a)[0].opts.headers, undefined);
  t.deepEqual([...new URL(ns(a)[0].url).searchParams.keys()].sort(), ["L", "YEAR"]);
  t.match(a.html(), /Recorded by UPS; on MFL after the rollover/); t.match(a.html(), /Total adjustments<\/b><b>\+\$4,000/);
  await a.click({ "data-act": "ctcat", "data-v": "y27cut" }); t.match(a.html(), /Tyreek Hill/, "named by his id from MFL's complete player list"); t.match(a.html(), /Cut Aug 31, 2026/, "2026-09-01T00:00:00Z is 8:00 PM ET on Aug 31"); t.doesNotMatch(a.html(), /Player Unknown|Name In Text|Missed nomination/);
  await a.click({ "data-act": "nsx" }); await a.click({ "data-act": "nsx" }); await tick(10);
  t.equal(ns(a).length, 1, "closing and reopening the row reuses the answer");
  const b = boot({ failNext: 1 }); await tick(30);
  await b.click({ "data-act": "sub", "data-v": "contracts" }); await b.click({ "data-act": "nsx" }); await tick(20);
  t.match(b.html(), /Couldn’t load this/); t.match(b.html(), /data-act="retryns"/); t.match(b.html(), /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/);
  t.doesNotMatch(b.html(), /Total adjustments<\/b><b>\+\$/, "a failed read shows no amount");
  await b.click({ "data-act": "retryns" }); await tick(20);
  t.equal(ns(b).length, 2); t.match(b.html(), /Total adjustments<\/b><b>\+\$4,000/); t.doesNotMatch(b.html(), /Couldn’t load this/);
  b.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("PR A: the disabled Report bug placeholder does nothing: no request, no change, even if a tap reaches it", async () => {
  const a = boot({ failNext: 1 }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await a.click({ "data-act": "nsx" }); await tick(20);
  const before = a.calls.length, htmlBefore = a.html();
  await a.click({}); await tick(5); // a tap on an element with no data-act (the placeholder has none)
  t.equal(a.calls.length, before); t.equal(a.html(), htmlBefore);
  t.equal((a.html().match(/Report bug/g) || []).length, 1); t.doesNotMatch(a.html(), /data-act="report/);
});

await test("PR A review: an open next-season row is asked again after Sample mode drops its read; it never sits on Loading… with nothing in flight", async () => {
  const a = boot(); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(15);
  const opened = a.click({ "data-act": "nsx" }); // the read starts and is still in flight when Sample mode is switched on and off
  await a.click({ "data-act": "sample" }); await a.click({ "data-act": "sample" }); await opened; await tick(40);
  t.match(a.html(), /Total adjustments<\/b><b>\+\$4,000/); t.doesNotMatch(a.html(), /Loading…/);
});

// R6: the Performance header is one "Through Week N" (the old "Season through Week N · completed games"). The completed-games claim is now the header with
// no warning line under it (an unverified or not-final week adds a warning and the warnc class).
function settled(n) { return new RegExp('<div class="card pfh"><b>Through Week ' + n + "</b>(?!<div class=\"ex wn)"); }
// ---- PR B: fixes from the independent code review of 62bc56bd
const clone2 = (x) => JSON.parse(JSON.stringify(x));
const allFinalSched = () => { const s = clone2(FX4.schedule11); s.nflSchedule.matchup.forEach((m) => { m.gameSecondsRemaining = "0"; m.team[0].score = "21"; m.team[1].score = "14"; }); return s; };
const lastCompleteIsLineupWeek = (b) => { b.season = Object.assign({}, b.season, { lastCompleteWeek: 11 }); b.matchups = clone2(b.matchups); Object.keys(b.matchups).forEach((c, i) => { b.matchups[c].status = i === 0 ? "scheduled" : "final"; }); return b; };
const wkCalls = (a, pred) => a.calls.filter(pred).length;
const isLm = (c) => c.path === "/api/lineup-matchups" && new URL(c.url).searchParams.get("W") === "11";
const isSch = (w) => (c) => c.type === "nflSchedule" && new URL(c.url).searchParams.get("W") === String(w);
const isSc = (w) => (c) => c.type === "playerScores" && new URL(c.url).searchParams.get("W") === String(w);

test("PR B review: the Worker calls the lineup week complete and the schedule says every game is final, but one status disagrees: the cutoff steps back to Week 10 and the screen draws; it never waits on a read nobody asked for", async () => {
  const a = boot({ r3: true, sched11: allFinalSched(), lmEdit: lastCompleteIsLineupWeek }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(80);
  t.equal(wkCalls(a, isSch(10)) >= 1, true, "the Week 10 schedule was asked for");
  t.match(a.html(), settled(10)); t.doesNotMatch(a.html(), /Checking which games are final/);
});

test("PR B review: Sample mode switched on and off while the Performance reads are in flight: the reads are asked again and the screen draws", async () => {
  const a = boot({ r3: true }); await tick(30);
  const opened = a.click({ "data-act": "sub", "data-v": "performance" });
  await a.click({ "data-act": "sample" }); await a.click({ "data-act": "sample" }); await opened; await tick(120);
  t.match(a.html(), settled(10)); t.doesNotMatch(a.html(), /Checking which games are final|Loading ranks/);
});

test("PR B review: Retry asks the matchup, schedule and score reads of the lineup week again, not only the ones that failed", async () => {
  const a = boot({ r3: true }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(80);
  const n = () => [wkCalls(a, isLm), wkCalls(a, isSch(11)), wkCalls(a, isSc(11))], before = n();
  await a.click({ "data-act": "retryperf" }); await tick(60);
  t.deepEqual(n(), before.map((x) => x + 1), "one more of each");
  t.match(a.html(), settled(10));
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("PR B: a truncated NFL schedule is never presented as a complete week: the screen says games are missing and draws no season figure", async () => {
  const s10 = clone2(FX4.schedule10); s10.nflSchedule.matchup.shift(); // one game of Week 10 is missing from the answer
  const a = boot({ r3: true, sched10: s10 }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.match(a.html(), /does not account for every club/); t.doesNotMatch(a.html(), /Through Week/); t.match(a.html(), /data-act="retryperf"/);
});

test("PR B: only the schedules of the last two weeks are read; older weeks never block the cutoff", async () => {
  const a = boot({ r3: true }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(80);
  t.deepEqual(a.calls.filter((c) => c.type === "nflSchedule").map((c) => new URL(c.url).searchParams.get("W")).filter((w) => w !== "ALL").sort(), ["10", "11"], "per-week schedules: Week 10 (the last complete week) and Week 11 (the lineup week) only; every older week is confirmed from the one calendar read");
  t.match(a.html(), settled(10));
});

test("PR B round 4: the club list, byes and the whole season's schedule are read once each (bare GETs); every earlier week is confirmed, so the heading claims completed games", async () => {
  const a = boot({ r3: true }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.deepEqual(a.calls.filter(isCalCall).map((c) => c.type + ":" + (new URL(c.url).searchParams.get("W") || "")).sort(), ["nflByeWeeks:", "nflSchedule:ALL"], "one read of each");
  a.calls.filter(isCalCall).forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.deepEqual([...new URL(c.url).searchParams.keys()].sort(), c.type === "nflByeWeeks" ? ["JSON", "L", "TYPE", "YEAR"] : ["JSON", "L", "TYPE", "W", "YEAR"]); });
  t.match(a.html(), settled(10));
});
test("PR B round 4: an older game that is not final (Week 5) keeps the figures but removes the claim and names the week", async () => {
  const a = boot({ r3: true, calEdit: (l) => { l.fullNflSchedule.nflSchedule.find((e) => e.week === "5").matchup[0].gameSecondsRemaining = "900"; return l; } }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.match(a.html(), /Through Week 10<\/b>/); t.doesNotMatch(a.html(), settled(10)); t.match(a.html(), /class="card pfh warnc"/); t.match(a.html(), /Week 5 has a game that is not final/); t.match(a.html(), /<span>Tot\. Pts\.<\/span><b>\d/, "the figures still show");
});
test("PR B round 4: if the club list and schedule cannot be read, the figures show without the claim and with Try again; Try again confirms the weeks", async () => {
  const a = boot({ r3: true, failCal: 2 }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.doesNotMatch(a.html(), settled(10)); t.match(a.html(), /Game completion unverified/); t.match(a.html(), /could not be read, so weeks 1 to 9 were not checked/); t.match(a.html(), /data-act="retryperf"/);
  await a.click({ "data-act": "retryperf" }); await tick(100);
  t.match(a.html(), settled(10)); t.doesNotMatch(a.html(), /were not checked|Game completion unverified/);
});

// Stale lineup-week scores in the running app. Thursday: Week 11's scores are read mid-game (cutoff Week 10). Later the league finishes Week 11; Retry reads the new schedule, which shows
// it final, so the older scores are read again automatically, once. These tests drive that second read to a failure and to a success.
const flat = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
// R6: W* waits for team history, so the history here already runs through Week 11 (allowed one week past the all-final week, clamped to it on Thursday)
const histThrough11 = (b) => Object.assign(b, { teamHistoryThrough: 11 });
const thursday = async (clock) => { const a = boot({ r3: true, clock, lmEdit: histThrough11 }); await tick(30); await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100); return a; };
test("PR B stale scores: the automatic re-read fails; the figures stay withheld; no automatic request follows; Retry asks the failed read once and a good answer restores the figures", async () => {
  const clock = FakeClock(), a = await thursday(clock);
  t.match(a.html(), settled(10)); t.equal(wkCalls(a, isSc(11)), 1, "Thursday: the lineup week's scores were read once, mid-game");
  a.setWeek11Final(1); clock.t += 3 * 60 * 1000;
  await a.click({ "data-act": "retryperf" }); await tick(120);
  t.equal(wkCalls(a, isSc(11)), 2, "the new schedule shows Week 11 final, so the older scores are read again automatically: once, and it fails");
  t.doesNotMatch(a.html(), /<span>Tot\. Pts\.<\/span><b>\d/, "no figure is drawn from the stale scores or from a partial set of weeks");
  t.match(a.html(), /Some weeks of scores could not be read/); t.match(a.html(), /data-act="retryperf"/);
  const n = a.calls.length; await tick(200); clock.t += 60 * 1000; await tick(50);
  await a.click({ "data-act": "sub", "data-v": "cap" }); await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.equal(a.calls.length, n, "after the failure nothing is asked again on its own: not over time, not by leaving and returning to Performance");
  await a.click({ "data-act": "retryperf" }); await tick(100);
  t.equal(a.calls.length - n, 1, "Retry asked for exactly one thing"); t.ok(isSc(11)(a.calls[a.calls.length - 1]), "the failed Week 11 score read");
  t.match(a.html(), settled(11)); t.match(flat(a.html()), /Tot\. Pts\.\s+298\.4/, "the figures are back, with Week 11 included"); t.doesNotMatch(a.html(), /Some weeks of scores could not be read/);
  const m = a.calls.length; await tick(150); t.equal(a.calls.length, m, "and it stays quiet");
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});
test("PR B stale scores: when the automatic re-read succeeds it is one request, the figures include the finished week, and nothing repeats", async () => {
  const clock = FakeClock(), a = await thursday(clock);
  a.setWeek11Final(0); clock.t += 3 * 60 * 1000;
  await a.click({ "data-act": "retryperf" }); await tick(120);
  t.equal(wkCalls(a, isSc(11)), 2, "one automatic re-read");
  t.match(a.html(), settled(11)); t.match(flat(a.html()), /Tot\. Pts\.\s+298\.4/);
  const n = a.calls.length; await tick(200); await a.click({ "data-act": "sub", "data-v": "cap" }); await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(100);
  t.equal(a.calls.length, n, "no repeated automatic requests");
});

test("PR A revision: Contracts asks for MFL's complete player list once (a bare GET of the allowed export type), reuses it, and names a player by id; nothing else new is asked", async () => {
  const pl = (a) => a.calls.filter((c) => c.type === "players");
  const a = boot(); await tick(30); const n = a.calls.length;
  t.equal(pl(a).length, 0, "nothing asks for the list until Team › Contracts is opened");
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(30);
  t.equal(pl(a).length, 1); t.equal(pl(a)[0].opts.method, "GET"); t.equal(pl(a)[0].opts.credentials, "omit"); t.equal(pl(a)[0].opts.headers, undefined); t.equal(pl(a)[0].path, "/api/mfl-export");
  t.deepEqual([...new URL(pl(a)[0].url).searchParams.keys()].sort(), ["JSON", "L", "TYPE", "YEAR"]); t.equal(new URL(pl(a)[0].url).searchParams.get("TYPE"), "players");
  t.deepEqual(a.calls.slice(n).map((c) => c.path + (c.type ? ":" + c.type : "")).sort(), ["/api/cap-penalty/preview", "/api/mfl-export:players"], "the guarantee calculation and the player list: nothing else");
  await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "sub", "data-v": "contracts" }); await a.click({ "data-act": "nav", "data-v": "market" }); await a.click({ "data-act": "nav", "data-v": "team" }); await tick(20);
  await a.click({ "data-act": "cts", "data-v": "sal" }); await a.click({ "data-act": "cty", "data-v": "1" }); await a.click({ "data-act": "ctbd" }); await a.click({ "data-act": "nsx" }); await tick(30); await a.click({ "data-act": "ctcat", "data-v": "y27cut" });
  t.equal(pl(a).length, 1, "coming back, sorting and opening a row ask for the list no more");
  t.equal(a.calls.filter((c) => c.path === "/api/cap-adjustments/next-season").length, 1, "the 2027 row still makes its one read, when it is opened");
  t.match(a.html().replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), /Tyreek Hill Cut Aug 31, 2026/, "no tap needed to name him: the list was already in memory");
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("PR A revision: while the player list is out a name is a quiet '…'; if it fails the row says 'Name unavailable' (never Player Unknown), and the screen is not blocked", async () => {
  const a = boot({ failPlayers: 1 }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await a.click({ "data-act": "nsx" }); await tick(30); await a.click({ "data-act": "ctcat", "data-v": "y27cut" }); await tick(5);
  t.doesNotMatch(a.html(), /Player Unknown/);
  t.match(a.html().replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), /Name unavailable Cut Aug 31, 2026 \+\$1,000/);
  t.match(a.html(), /Cap space · 2026 season/, "the rest of the screen works");
  t.equal(a.calls.filter((c) => c.type === "players").length, 1, "a failed list is not asked again on every tap");
});

test("PR A revision: the sort segments work in the real app: Salary shows the year chips, tapping the active sort reverses it, Expiration reverses its groups; no request is made", async () => {
  const a = boot(); await tick(30); await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(30); const n = a.calls.length;
  const heads = () => [...a.html().matchAll(/Expires <b>(\d{4})<\/b>/g)].map((m) => +m[1]);
  t.doesNotMatch(a.html(), /data-act="cty"/); const asc = heads(); t.ok(asc.length >= 2);
  await a.click({ "data-act": "cts", "data-v": "exp" }); t.deepEqual(heads(), asc.slice().reverse(), "tapping the active Expiration reverses the groups"); t.match(a.html(), /aria-label="Sorted by contract expiration, latest first\. Tap to reverse\."/);
  await a.click({ "data-act": "cts", "data-v": "exp" }); t.deepEqual(heads(), asc, "and again");
  await a.click({ "data-act": "cts", "data-v": "sal" }); t.match(a.html(), /data-act="cty" data-v="0" aria-pressed="true"/); t.match(a.html(), /aria-label="Sorted by salary, highest first/); t.doesNotMatch(a.html(), /Expires <b>/);
  await a.click({ "data-act": "cty", "data-v": "1" }); t.match(a.html(), /data-act="cty" data-v="1" aria-pressed="true"/); t.match(a.html(), /data-act="cty" data-v="0" aria-pressed="false"/);
  await a.click({ "data-act": "cts", "data-v": "sal" }); t.match(a.html(), /aria-label="Sorted by salary, lowest first/); t.match(a.html(), /data-act="cty" data-v="1" aria-pressed="true"/, "reversing keeps the year");
  await a.click({ "data-act": "cts", "data-v": "name" }); t.doesNotMatch(a.html(), /data-act="cty"/, "the year chips leave with Salary"); t.match(a.html(), /Sorted by name, A to Z/);
  await a.click({ "data-act": "cts", "data-v": "sal" }); t.match(a.html(), /aria-label="Sorted by salary, highest first/, "coming back to Salary starts highest first");
  await a.click({ "data-act": "cty", "data-v": "7" }); t.match(a.html(), /data-act="cty" data-v="1" aria-pressed="true"/, "a year outside 2026 to 2028 is ignored");
  t.equal(a.calls.length, n, "sorting asks for nothing");
});

run("mobile2027_controller");
