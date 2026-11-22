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
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
// PR A: next season's ledger as the Worker returns it (the shape is read from worker/src/index.js, GET /api/cap-adjustments/next-season)
const NEXT_LEDGER = { ok: true, season: "2026", next_season: 2027, league_id: "74598", by_fid: { "0010": { total: 4000 } }, held_unpriced: [], needs_review: [], rows: [
  { player_id: "12801", player: "Name In Text", franchise_id: "0010", amount: 1000, applies_to_season: 2027, dropped_at_iso: "2026-09-01T00:00:00Z", kind: "Drop (next season)", in_mfl: false },
  { player_id: null, player: "Missed nomination", franchise_id: "0010", amount: 3000, applies_to_season: 2027, dropped_at_iso: "2026-07-28", kind: "RULE 2 fine (next season)", in_mfl: false }] };

function boot({ hash = "", stored = {}, failRoster = 0, failPenalty = 0, hold = false, holdPen = false, failStatus = 0, failWeek10 = 0, clock = null, holdIntel = false, r3 = false, failScores = 0, failNext = 0, lmEdit = null, sched11 = null } = {}) {
  const calls = [];
  let releasePen = () => {}; const penGate = holdPen ? new Promise((r) => { releasePen = r; }) : null;
  let release = () => {}; const gate = hold ? new Promise((r) => { release = r; }) : null; // holds the roster read open until release()
  const state = { failRoster, failPenalty, failStatus, failWeek10, failScores, failNext };
  let releaseIntel = () => {}; const intelGate = holdIntel ? new Promise((r) => { releaseIntel = r; }) : null; // holds the Team › Roster adds open until releaseIntel()
  const body = (u) => {
    if (u.pathname === "/roster-workbench") return FX.roster_workbench;
    if (u.pathname === "/api/current-lineup-week") return FX.current_lineup_week;
    if (u.pathname === "/api/cap-penalty/preview") return FX.cap_penalty;
    if (u.pathname === "/api/cap-adjustments/next-season") return NEXT_LEDGER;
    if (u.pathname === "/api/player-status") return FX2.player_status;
    if (u.pathname === "/api/lineup-matchups") { const b = Object.assign({}, r3 ? FX3.lineup_matchups_w11 : FX2.lineup_matchups_w11, r3 ? FX4.hist : {}, { week: Number(u.searchParams.get("W")) }); return lmEdit ? lmEdit(b) : b; }
    if (u.searchParams.get("TYPE") === "league") return FX.league;
    // PR B: the whole-league reads the Performance screen needs (weekly scores Weeks 1 to 10, positions, the NFL schedules of Weeks 10 and 11)
    if (u.searchParams.get("TYPE") === "players") return { players: { player: FX4.players } };
    if (u.searchParams.get("TYPE") === "nflSchedule") return u.searchParams.get("W") === "10" ? FX4.schedule10 : u.searchParams.get("W") === "11" ? (sched11 || FX4.schedule11) : { nflSchedule: { matchup: [] } };
    if (u.searchParams.get("TYPE") === "playerScores") { const w = u.searchParams.get("W"); return { playerScores: { playerScore: (r3 ? FX4.scores[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) : FX3.scores[w]) || [] } }; }
    return u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
  };
  const fetchFake = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url, path: u.pathname, type: u.searchParams.get("TYPE"), opts });
    if (gate && u.pathname === "/roster-workbench") await gate;
    if (penGate && u.pathname === "/api/cap-penalty/preview") await penGate;
    if (u.pathname === "/roster-workbench" && state.failRoster > 0) { state.failRoster--; return { ok: false, status: 503, text: async () => "down" }; }
    if (u.pathname === "/api/cap-penalty/preview" && state.failPenalty > 0) { state.failPenalty--; return { ok: false, status: 500, text: async () => "x" }; }
    if (u.pathname === "/api/cap-adjustments/next-season" && state.failNext > 0) { state.failNext--; return { ok: false, status: 500, text: async () => "x" }; }
    if (intelGate && (u.pathname === "/api/player-status" || u.pathname === "/api/lineup-matchups")) await intelGate;
    if (u.pathname === "/api/player-status" && state.failStatus > 0) { state.failStatus--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "playerScores" && state.failScores > 0) { state.failScores--; return { ok: false, status: 502, text: async () => "x" }; }
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "weeklyResults" && u.searchParams.get("W") === "10" && state.failWeek10 > 0) { state.failWeek10--; return { ok: false, status: 502, text: async () => "x" }; }
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
  for (const f of ["config.js", "lib/format.js", "lib/contract.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/data.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/tabviews.js", "lib/views.js", "app.js"]) vm.runInContext(read(f), ctx, { filename: f });
  const click = async (attrs) => {
    const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } }));
    await tick();
  };
  return { setFailScores: (n) => { state.failScores = n; }, appEl, calls, storage, pushes, replaces, docAttrs, history, location, click, winL, listeners, release: () => release(), releasePen: () => releasePen(), releaseIntel: () => releaseIntel(), html: () => appEl.innerHTML };
}

test("boot: loads the roster, shows the first team with starters above the bench, and every request is a bare GET", async () => {
  const a = boot();
  t.match(a.html(), /aria-busy="true"/, "a loading state is drawn first");
  await tick(30);
  t.match(a.html(), /Week 11 starters/); t.match(a.html(), /Blake Bombers/); t.match(a.html(), /Data as of/);
  // the four core reads, then the two Team › Roster adds (injury status and this week's NFL games), each once
  t.deepEqual(a.calls.map((c) => c.path).sort(), ["/api/current-lineup-week", "/api/lineup-matchups", "/api/mfl-export", "/api/mfl-export", "/api/player-status", "/roster-workbench"]);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.equal(c.opts.headers, undefined); });
  t.equal(a.docAttrs["data-skin"], "light"); t.equal(a.docAttrs["data-vib"], "1");
});

test("taps: expand and collapse all, open Team › Contracts, open the placeholder tabs, come back", async () => {
  const a = boot(); await tick(30);
  const before = (a.html().match(/data-act="card"/g) || []).length;
  await a.click({ "data-act": "expall" });
  t.ok((a.html().match(/data-act="card"/g) || []).length > before, "groups opened");
  await a.click({ "data-act": "expall" });
  t.equal((a.html().match(/data-act="card"/g) || []).length, before, "groups closed again");
  await a.click({ "data-act": "grp", "data-g": "bWR" });
  t.match(a.html(), /data-g="bWR" aria-expanded="true"/);
  await a.click({ "data-act": "sub", "data-v": "contracts" });
  t.match(a.html(), /Recorded salary, not cap space/); t.match(a.html(), /yrs? left/);
  await a.click({ "data-act": "sub", "data-v": "cap" }); t.match(a.html(), /Cap space is left out on purpose/);
  await a.click({ "data-act": "nav", "data-v": "market" }); t.match(a.html(), /not in Preview 0/i); t.doesNotMatch(a.html(), /Week 11 starters/);
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
  t.match(a.html(), /Couldn’t read the league data/); t.match(a.html(), /HTTP 503/); t.doesNotMatch(a.html(), /Week 11 starters/);
  await a.click({ "data-act": "retry" }); await tick(30);
  t.match(a.html(), /Week 11 starters/);
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
  t.match(a.html(), /Nothing here is real, and nothing is sent\./); t.doesNotMatch(a.html(), /Week 11 starters/);
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
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Preview: view only/); t.match(a.html(), /Week 11 starters/);
  // it is never remembered: a fresh page starts with it off
  const b = boot(); await tick(30); t.doesNotMatch(b.html(), /Sample data/); t.match(b.html(), /Preview: view only/);
});

test("Sample mode switched on while the first read is out, or with a profile open: nothing late is drawn, nothing is left stuck, and off reads again", async () => {
  const a = boot({ hold: true }); await tick(10);
  t.match(a.html(), /aria-busy="true"/, "the first read is still out");
  await a.click({ "data-act": "about" }); await a.click({ "data-act": "sample" });
  const atOn = a.calls.length; a.release(); await tick(30);
  t.equal(a.calls.length, atOn, "no request left the page after Sample mode went on, not even the rest of the load");
  t.match(a.html(), /Sample data · nothing is real and nothing is sent/); t.doesNotMatch(a.html(), /Week 11 starters/, "the late answer was dropped, not drawn");
  t.doesNotMatch(a.html(), /Reload the data/, "Reload is paused while Sample mode is on");
  await a.click({ "data-act": "sample" }); await tick(40);
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Week 11 starters/, "turning it off read the league again instead of leaving a spinner or an error");
  // a profile that is open when Sample mode goes on is closed, and is not left stuck on the way back
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "close" }); t.doesNotMatch(a.html(), /role="dialog"/, "the About sheet is closed");
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(20); t.match(a.html(), /role="dialog"/);
  await a.click({ "data-act": "sample" }); t.doesNotMatch(a.html(), /role="dialog"/, "no profile is drawn in Sample mode"); t.match(a.html(), /Nothing here is real/);
  await a.click({ "data-act": "sample" }); await tick(20); t.doesNotMatch(a.html(), /role="dialog"/); t.match(a.html(), /Week 11 starters/);
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
  t.deepEqual(asked(a).sort(), ["current-lineup-week", "lineup-matchups#11", "mfl-export", "mfl-export#11", "player-status", "roster-workbench"].sort(), "boot: the four core reads, injury status and this week's games");
  const n0 = a.calls.length;
  await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await tick(10);
  t.equal(a.calls.length, n0, "going back and forth between the two views asks nothing");
  await a.click({ "data-act": "pickteam", "data-fid": "0009" }); await a.click({ "data-act": "pickteam", "data-fid": "0010" }); await tick(10);
  t.equal(a.calls.length, n0, "changing teams asks nothing (the reads cover the whole league)");
  // a past week: its lineup and its games, once; the week before is already in memory
  await a.click({ "data-act": "weeks" }); t.match(a.html(), /aria-label="Choose a week"/);
  await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(40);
  t.deepEqual(asked(a).slice(n0), ["mfl-export#10"], "Week 10's lineups and scores: one request, and a past week asks for no NFL games (MAT-1)");
  t.match(a.html(), /Week 10 · played/); t.doesNotMatch(a.html(), /Bench · /);
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "9" }); await tick(40);
  t.deepEqual(asked(a).slice(n0 + 1), ["mfl-export#9"], "Week 9, first visit: one request (its lineups and scores)");
  await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(10);
  await a.click({ "data-act": "view", "data-v": "byes" }); await a.click({ "data-act": "view", "data-v": "lineup" }); await a.click({ "data-act": "weeks" }); await a.click({ "data-act": "pickweek", "data-v": "10" }); await tick(10);
  t.equal(a.calls.length, n0 + 2, "revisiting past weeks asks nothing");
  await a.click({ "data-act": "pickweek", "data-v": "11" }); await tick(10);
  t.match(a.html(), /Week 11 starters/); t.equal(a.calls.length, n0 + 2, "back to the current week: nothing");
  await a.click({ "data-act": "pickweek", "data-v": "12" }); t.doesNotMatch(a.html(), /Week 12 starters/, "a later week cannot be chosen"); t.equal(a.calls.length, n0 + 2);
  const keys = asked(a); t.equal(new Set(keys).size, keys.length, "no address was asked twice in the whole visit");
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
  t.match(a.html(), /Week 11 starters/, "the roster still shows");
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
  t.doesNotMatch(a.html(), /Sample data/); t.match(a.html(), /Week 11 starters/);
  t.match(a.html(), /▲ Questionable/, "the answers that arrived while Sample mode was on were kept in memory (not drawn then), so they show now");
  t.deepEqual(asked(a).slice(before).filter((k) => !/mfl-export#(8|9|10|11)/.test(k)), [], "and the held reads were not asked again; only Team › Performance, which the owner chose meanwhile, needs the four weeks of scores");
  // a read that never finished is asked for again, not waited for
  const b = boot({ holdIntel: true }); await tick(30); const nb = b.calls.length;
  await b.click({ "data-act": "sample" }); await b.click({ "data-act": "sample" }); await tick(10);
  t.deepEqual(asked(b).slice(nb).sort(), ["lineup-matchups#11", "player-status"], "never finished: asked for again when Sample mode ends");
  b.releaseIntel(); await tick(40); t.match(b.html(), /▲ Questionable/);
});

test("R2: the About sheet carries the bench-group setting, which is kept on the phone and changes what opens by default", async () => {
  const a = boot(); await tick(40);
  t.match(a.html(), /data-g="bRB" aria-expanded="false"/);
  await a.click({ "data-act": "about" }); t.match(a.html(), /Bench groups/); await a.click({ "data-act": "gdef", "data-v": "all" });
  t.equal(a.storage["ups2027-p0-gdef"], "all"); await a.click({ "data-act": "close" });
  t.match(a.html(), /data-g="bRB" aria-expanded="true"/);
  const b = boot({ stored: { "ups2027-p0-gdef": "all" } }); await tick(40); t.match(b.html(), /data-g="bRB" aria-expanded="true"/, "a fresh page remembers it");
  await a.click({ "data-act": "grp", "data-g": "bRB" }); t.match(a.html(), /data-g="bRB" aria-expanded="false"/, "an owner's own tap still wins over the default");
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
  t.match(a.html(), /Week 11 starters/); t.doesNotMatch(a.html(), /class="wsel past"/);
  await a.click({ "data-act": "view", "data-v": "lineup" }); t.match(a.html(), /Week 11 starters/);
  t.equal(a.calls.length, n); a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

// ───────────────────────── stage R3: Team › Contracts, Team › Performance and the profile game log ─────────────────────────
const scoreReads = (a) => a.calls.filter((c) => c.type === "playerScores").map((c) => Number(c.url.match(/[?&]W=(\d+)/)[1]));

test("R3: Team › Contracts paints the table first and says Loading… for the guarantee column; the answer then fills it; nothing is $0 while it is out", async () => {
  const a = boot({ holdPen: true }); await tick(40); const n = a.calls.length;
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(5);
  t.match(a.html(), /Recorded salary, not cap space/); t.match(a.html(), /Guarantee left/); t.match(a.html(), /Loading…/, "the guarantee column says Loading");
  t.doesNotMatch(a.html(), /\$0 fully earned|Not tracked/); t.doesNotMatch(a.html(), /<b>\$0<\/b>/);
  t.deepEqual(a.calls.slice(n).map((c) => c.path), ["/api/cap-penalty/preview"], "the one extra read is the guarantee calculation, asked after the table was drawn");
  a.releasePen(); await tick(30);
  t.doesNotMatch(a.html(), /Loading…/); t.match(a.html(), /\$\d[\d,]* fully earned|\$[\d,]+<\/b>|Not tracked|Under review|Unavailable/, "the column now holds guarantee values");
  await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(10);
  t.equal(a.calls.filter((c) => c.path === "/api/cap-penalty/preview").length, 1, "coming back asks nothing more");
});

test("R3: a failed guarantee read says Unavailable (never $0), offers Try again, and recovers", async () => {
  const a = boot({ failPenalty: 1 }); await tick(40);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(30);
  t.match(a.html(), /Unavailable/); t.match(a.html(), /data-act="retrypen"/); t.doesNotMatch(a.html(), /\$0 fully earned/); t.doesNotMatch(a.html(), /<b>\$0<\/b>/);
  await a.click({ "data-act": "retrypen" }); await tick(30);
  t.doesNotMatch(a.html(), /data-act="retrypen"/); t.match(a.html(), /\$[\d,]+<\/b>|\$\d[\d,]* fully earned|Not tracked/);
});

test("PR B: Team › Performance asks for the two NFL schedules, the players and the weekly scores (Weeks 1 to 10 for the season, Week 11 for the live chip), once each; going back and forth asks nothing more", async () => {
  const a = boot({ r3: true }); await tick(40); const n = a.calls.length;
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(40);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "every week of the season through the last all-final week (10), and the live Week 11");
  t.equal(a.calls.slice(n).filter((c) => c.type === "nflSchedule").length, 2, "the schedules of Week 10 (the cutoff) and Week 11 (the lineup week)"); t.equal(a.calls.slice(n).filter((c) => c.type === "players").length, 1);
  t.equal(a.calls.length - n, 14, "nothing else was asked (the injury and matchup reads were already in memory)");
  a.calls.slice(n).forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.ok(["playerScores", "nflSchedule", "players"].includes(c.type)); });
  t.match(a.html(), /Comparison through Week 10/); t.match(a.html(), /Season through Week 10 · completed games/); t.match(a.html(), /QB 2 of 35–54/); t.match(a.html(), /WR 63–66 of 169–209/);
  await a.click({ "data-act": "sub", "data-v": "roster" }); await a.click({ "data-act": "sub", "data-v": "performance" }); await a.click({ "data-act": "pff", "data-v": "starters" }); await a.click({ "data-act": "pfs", "data-v": "diff" }); await tick(10);
  t.equal(a.calls.length - n, 14, "tabs, filters and sorts ask nothing");
});

test("R3 ruling 2: the profile game log shows the latest four weeks, then 'Show earlier weeks' loads the rest on demand, once each, and reuses what is in memory", async () => {
  const a = boot({ r3: true }); await tick(40);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(40);
  const rowsOf = () => (a.html().split('<div class="card tbl">')[1] || "").split("</table>")[0].split("<tr>").length - 2;
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "opening the log asked for the season through Week 10 and the live Week 11, once each");
  t.equal(rowsOf(), 4, "the latest four weeks"); t.match(a.html(), /data-act="logmore">Show earlier weeks</); t.match(a.html(), /The latest four weeks/);
  const n0 = a.calls.length;
  await a.click({ "data-act": "logmore" }); await tick(60);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "every week was already read for the season figures: nothing more is asked");
  t.equal(a.calls.length - n0, 0, "no more reads, none repeated");
  t.equal(rowsOf(), 10, "the full season through Week 10"); t.match(a.html(), /Showing Weeks 1 to 10/); t.match(a.html(), /The full season, newest first/);
  const weeks = [...(a.html().split('<div class="card tbl">')[1].split("</table>")[0]).matchAll(/<tr><td>(\d+)<\/td>/g)].map((m) => +m[1]);
  t.deepEqual(weeks, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], "newest first");
  await a.click({ "data-act": "logless" }); await a.click({ "data-act": "logmore" }); await tick(30);
  t.equal(a.calls.length - n0, 0, "showing fewer and more again asks nothing");
  t.doesNotMatch(a.html(), /<th[^>]*>(Opponent|Snaps|Lineup)/);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

test("R3 ruling 2: an earlier week that cannot be read shows n/a with a retry; the weeks that loaded stay", async () => {
  const a = boot({ r3: true, failScores: 1 }); await tick(40); // the first score read (Week 1) fails; the season figures are withheld, never a partial sum
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(40);
  await a.click({ "data-act": "logmore" }); await tick(60);
  t.match(a.html(), /could not be read and show n\/a/); t.match(a.html(), /data-act="retrylog"/);
  await a.click({ "data-act": "retrylog" }); await tick(60);
  t.doesNotMatch(a.html(), /could not be read/); t.match(a.html(), /Showing Weeks 1 to 10/);
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
  t.match(a.html(), /Some weeks of scores could not be read/); t.match(a.html(), /data-act="retryperf"/); t.doesNotMatch(a.html(), /<span>Season points<\/span><b>\d/, "no season figure is drawn from a partial set of weeks");
  await a.click({ "data-act": "retryperf" }); await tick(40);
  t.doesNotMatch(a.html(), /could not be read/); t.match(a.html(), /<span>Season points<\/span><b>\d/); t.equal(scoreReads(a).length, 12, "only the failed week was asked again");
});

test("R3: the profile's Performance tab shows the game log from the same reads (Week and Points; BYE only where the club is known)", async () => {
  const a = boot({ r3: true }); await tick(40);
  const pid = FX.roster_workbench.teams.find((x) => x.franchise_id === "0010").players[0].id;
  await a.click({ "data-act": "card", "data-pid": pid }); await tick(10);
  const n = scoreReads(a).length; t.equal(n, 0, "opening a profile asks for no scores until its Performance tab is used");
  await a.click({ "data-act": "ptab", "data-v": "perf" }); await tick(40);
  t.deepEqual(scoreReads(a).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  t.match(a.html(), /Game log/); t.match(a.html(), /<th>Wk<\/th><th class="n">Pts<\/th>/); t.doesNotMatch(a.html(), /<th[^>]*>(Opponent|Snaps|Lineup)/, "no opponent, snaps or lineup column");
  t.match(a.html(), /Opponents, snaps and lineup status are not in this preview/);
});

test("PR A: Contracts reads nothing for next season until the next-season row is opened; then one bare GET, reused; a failure offers Retry and a disabled Report bug", async () => {
  const ns = (a) => a.calls.filter((c) => c.path === "/api/cap-adjustments/next-season");
  const a = boot(); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "contracts" }); await tick(15);
  t.equal(ns(a).length, 0, "opening Contracts makes no next-season read");
  await a.click({ "data-act": "nsx" }); await tick(20);
  t.equal(ns(a).length, 1); t.equal(ns(a)[0].opts.method, "GET"); t.equal(ns(a)[0].opts.credentials, "omit"); t.equal(ns(a)[0].opts.headers, undefined);
  t.deepEqual([...new URL(ns(a)[0].url).searchParams.keys()].sort(), ["L", "YEAR"]);
  t.match(a.html(), /Recorded in the UPS ledger, not yet on MFL/); t.match(a.html(), /adjustments \+\$4,000/);
  await a.click({ "data-act": "ctcat", "data-v": "y27Cut Penalty" }); t.match(a.html(), /Player Unknown/); t.doesNotMatch(a.html(), /Name In Text|Missed nomination/);
  await a.click({ "data-act": "nsx" }); await a.click({ "data-act": "nsx" }); await tick(10);
  t.equal(ns(a).length, 1, "closing and reopening the row reuses the answer");
  const b = boot({ failNext: 1 }); await tick(30);
  await b.click({ "data-act": "sub", "data-v": "contracts" }); await b.click({ "data-act": "nsx" }); await tick(20);
  t.match(b.html(), /Couldn’t load this/); t.match(b.html(), /data-act="retryns"/); t.match(b.html(), /<button class="btn" disabled aria-disabled="true">Report bug<\/button>/);
  t.doesNotMatch(b.html(), /adjustments \+\$/, "a failed read shows no amount");
  await b.click({ "data-act": "retryns" }); await tick(20);
  t.equal(ns(b).length, 2); t.match(b.html(), /adjustments \+\$4,000/); t.doesNotMatch(b.html(), /Couldn’t load this/);
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
  t.match(a.html(), /adjustments \+\$4,000/); t.doesNotMatch(a.html(), /Loading…/);
});

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
  t.match(a.html(), /Season through Week 10 · completed games/); t.doesNotMatch(a.html(), /Checking which games are final/);
});

test("PR B review: Sample mode switched on and off while the Performance reads are in flight: the reads are asked again and the screen draws", async () => {
  const a = boot({ r3: true }); await tick(30);
  const opened = a.click({ "data-act": "sub", "data-v": "performance" });
  await a.click({ "data-act": "sample" }); await a.click({ "data-act": "sample" }); await opened; await tick(120);
  t.match(a.html(), /Season through Week 10 · completed games/); t.doesNotMatch(a.html(), /Checking which games are final|Loading ranks/);
});

test("PR B review: Retry asks the matchup, schedule and score reads of the lineup week again, not only the ones that failed", async () => {
  const a = boot({ r3: true }); await tick(30);
  await a.click({ "data-act": "sub", "data-v": "performance" }); await tick(80);
  const n = () => [wkCalls(a, isLm), wkCalls(a, isSch(11)), wkCalls(a, isSc(11))], before = n();
  await a.click({ "data-act": "retryperf" }); await tick(60);
  t.deepEqual(n(), before.map((x) => x + 1), "one more of each");
  t.match(a.html(), /Season through Week 10 · completed games/);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); });
});

run("mobile2027_controller");
