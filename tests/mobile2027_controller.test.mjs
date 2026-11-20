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
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function boot({ hash = "", stored = {}, failRoster = 0, failPenalty = 0 } = {}) {
  const calls = [];
  const state = { failRoster, failPenalty };
  const body = (u) => {
    if (u.pathname === "/roster-workbench") return FX.roster_workbench;
    if (u.pathname === "/api/current-lineup-week") return FX.current_lineup_week;
    if (u.pathname === "/api/cap-penalty/preview") return FX.cap_penalty;
    return u.searchParams.get("TYPE") === "league" ? FX.league : FX.weekly_results;
  };
  const fetchFake = async (url, opts) => {
    const u = new URL(url);
    calls.push({ url, path: u.pathname, type: u.searchParams.get("TYPE"), opts });
    if (u.pathname === "/roster-workbench" && state.failRoster > 0) { state.failRoster--; return { ok: false, status: 503, text: async () => "down" }; }
    if (u.pathname === "/api/cap-penalty/preview" && state.failPenalty > 0) { state.failPenalty--; return { ok: false, status: 500, text: async () => "x" }; }
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
    console, setTimeout, clearTimeout, URL, URLSearchParams, Intl, JSON, Date, Math, Promise, Array, Object, String, Number, isFinite, parseInt, parseFloat, encodeURIComponent,
    AbortController: undefined, // not needed by the stub; the loader runs without a timer
    document: { getElementById: (id) => (id === "app" ? appEl : null), documentElement: { setAttribute(k, v) { docAttrs[k] = v; } }, activeElement: null, title: "" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    history, location,
  });
  ctx.window = ctx;
  ctx.fetch = fetchFake;
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.addEventListener = (type, fn) => { winL[type] = fn; };
  for (const f of ["config.js", "lib/format.js", "lib/contract.js", "lib/model.js", "lib/data.js", "lib/photo.js", "lib/views.js", "app.js"]) vm.runInContext(read(f), ctx, { filename: f });
  const click = async (attrs) => {
    const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } }));
    await tick();
  };
  return { appEl, calls, storage, pushes, replaces, docAttrs, history, location, click, winL, listeners, html: () => appEl.innerHTML };
}

test("boot: loads the roster, shows the first team with starters above the bench, and every request is a bare GET", async () => {
  const a = boot();
  t.match(a.html(), /aria-busy="true"/, "a loading state is drawn first");
  await tick(30);
  t.match(a.html(), /Week 11 starters/); t.match(a.html(), /Blake Bombers/); t.match(a.html(), /Data as of/);
  t.deepEqual(a.calls.map((c) => c.path).sort(), ["/api/current-lineup-week", "/api/mfl-export", "/api/mfl-export", "/roster-workbench"]);
  a.calls.forEach((c) => { t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit"); t.equal(c.opts.headers, undefined); });
  t.equal(a.docAttrs["data-skin"], "light"); t.equal(a.docAttrs["data-vib"], "1");
});

test("taps: expand and collapse all, switch to the Contracts view, open the placeholder tabs, come back", async () => {
  const a = boot(); await tick(30);
  const before = (a.html().match(/data-act="card"/g) || []).length;
  await a.click({ "data-act": "expall" });
  t.ok((a.html().match(/data-act="card"/g) || []).length > before, "groups opened");
  await a.click({ "data-act": "expall" });
  t.equal((a.html().match(/data-act="card"/g) || []).length, before, "groups closed again");
  await a.click({ "data-act": "grp", "data-g": "bWR" });
  t.match(a.html(), /data-g="bWR" aria-expanded="true"/);
  await a.click({ "data-act": "view", "data-v": "contracts" });
  t.match(a.html(), /yrs left|Final year/);
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
  t.match(b.html(), /Not available/); t.match(b.html(), /data-act="retrypen"/); t.match(b.html(), /HTTP 500/);
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

await run("mobile2027_controller");
