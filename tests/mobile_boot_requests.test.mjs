// Phone app boot requests (2026-10-20). The signed-out Sign-in card reads nothing but the active season; a signed-in
// boot reads no stats leaderboards, drop-penalty batch or taxi call-up counts; the screens that show those ask for
// them, once per app load, sharing a read already in flight, with a refresh rule and a bounded retry after a failure.
// Before this, every cold boot (the Sign-in card included), every pull-to-refresh and every move made 16
// /api/advanced-stats-leaderboard calls plus /api/cap-penalty/preview and /api/taxi-callups.
//
// Runs the REAL site/m/app.js (the whole file, under node:vm, with a fake DOM and a counting fetch: nothing leaves this
// process), the REAL site/m/front_office_penalty.js and the REAL site/m/views/stats.js. Then the MUTATION CHECKS cut
// each guard out of the source text and require the scenario it protects to FAIL, so no test here passes vacuously.
//   node tests/mobile_boot_requests.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP = read("site/m/app.js");
const PENALTY = read("site/m/front_office_penalty.js");
const STATS = read("site/m/views/stats.js");
const TAXI_RULE = read("site/shared/taxi_rule.js");   // the one taxi-eligibility rule app.js asks (#1364)
const T0 = Date.parse("2026-10-20T23:00:00Z");
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

// Worker routes that read D1 on a normal request (worker/src/index.js; the PR's inventory has the queries).
const D1_ROUTES = ["/api/advanced-stats-leaderboard", "/api/taxi-callups", "/api/cap-penalty/preview", "/api/league-events",
  "/api/waivers/state", "/api/trade-bait-notes", "/api/trades/proposals"];
const LB = "/api/advanced-stats-leaderboard", CAP = "/api/cap-penalty/preview", TAXI = "/api/taxi-callups";
const SIGNED_IN = { ups_mfl_user_id: "tokA" };

// ── A tiny worker: enough answers for app.js to boot, sign in and render ──
function answer(u, failures) {
  const p = u.pathname, q = u.searchParams;
  const json = (status, body) => ({ status, body });
  if (failures[p] > 0) { failures[p]--; return json(500, { ok: false, error: "induced" }); }
  switch (p) {
    case "/api/active-season": return json(200, { ok: true, season: "2026", source: "test" });
    case "/api/me": return json(200, { tokA: { configured: true, franchise_id: "0008" } }[q.get("MFL_USER_ID")] || { configured: false });
    case "/api/mfl-export": {
      const T = q.get("TYPE");
      if (T === "league") return json(200, { league: { salaryCapAmount: "300000", franchises: { franchise: [{ id: "0008", name: "Team Eight" }, { id: "0005", name: "Team Five" }] } } });
      if (T === "rosters") return json(200, { rosters: { franchise: [{ id: "0008", player: [{ id: "123", status: "ROSTER" }] }, { id: "0005", player: [] }] } });
      if (T === "players") return json(200, { players: { player: [{ id: "123", name: "Player, Test", position: "WR", team: "DAL" }] } });
      if (T === "injuries") return json(200, { injuries: { injury: [] } });
      if (T === "transactions") return json(200, { transactions: { transaction: [] } });
      if (T === "draftResults") return json(200, { draftResults: { draftUnit: { draftPick: [] } } });
      return json(200, {});
    }
    case "/api/league-events": return json(200, { ok: true, events: [] });
    case "/api/waivers/state": return json(200, { ok: true, window: {} });
    case "/api/waivers/availability": return json(200, { ok: true });
    case "/api/current-lineup-week": return json(200, { ok: true, week: 6 });
    case TAXI: return json(200, { ok: true, players: { "123": { used: 1, max: 3 } } });
    case CAP: return json(200, { ok: true, players: { "123": { penalty: 0 } } });
    case LB: return json(200, { rows: [{ mfl_pid: Number(q.get("season")), pos_group: "QB", mfl_ppg: 10 }], next_offset: null });
    case "/api/trade-bait-notes": return json(200, { ok: true, notes: [] });
    case "/api/trades/proposals": return json(200, { ok: true, incoming: [], outgoing: [] });
    default: return json(404, { error: "no route" });
  }
}

function makeEl(id) {
  const listeners = {};
  return { id, innerHTML: "", textContent: "", value: "", style: {}, className: "", disabled: false, firstChild: null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, removeEventListener() {},
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, target: this })); },
    appendChild(c) { return c; }, insertBefore(c) { return c; }, insertAdjacentHTML() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] };
}

// A fake phone running the given app.js (+ front_office_penalty.js) source. stored = localStorage at open; hash = the
// route opened. p.failures[path] = n makes the next n answers on that path HTTP 500.
async function phone(appSrc, { stored = {}, hash = "", penaltySrc = PENALTY } = {}) {
  const clock = { now: T0 };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  const calls = [], failures = {};
  const store = Object.assign({}, stored);
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const els = {};
  const KNOWN = ["ups-m-main", "ups-m-header-title", "ups-m-header-meta", "ups-m-toast", "ups-m-ptr", "ups-m-sign-out", "ups-m-refresh-data"];
  const document = {
    getElementById: (id) => (KNOWN.includes(id) ? (els[id] = els[id] || makeEl(id)) : null),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => makeEl(""), body: makeEl("body"),
    addEventListener() {}, cookie: "", visibilityState: "visible",
  };
  const listeners = {};
  const window = {
    localStorage, history: { replaceState() {} }, navigator: {}, scrollY: 0, confirm: () => true,
    location: { search: "", hash, href: "https://ups.test/upsmflproduction/m/index.html" + hash },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  const fetch = async (input) => {
    const u = new URL(String(input), "https://ups.test/upsmflproduction/m/");
    calls.push({ path: u.pathname, query: u.search, worker: /workers\.dev$/.test(u.hostname) });
    const a = answer(u, failures);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  const ctx = vm.createContext({ window, document, navigator: window.navigator, fetch, URL, URLSearchParams, Response,
    Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; }, clearTimeout, Promise, Date: FakeDate, console });
  ctx.window.window = ctx.window;
  vm.runInContext(TAXI_RULE, ctx);
  vm.runInContext(appSrc, ctx);
  vm.runInContext(penaltySrc, ctx);
  const M = window.UPS_MOBILE;
  const seen = [];
  ["home", "league", "myteam"].forEach((name) => M.route.registerView(name, (main, parts) => { seen.push(name); main.innerHTML = "VIEW:" + name; }));
  M.boot();
  await settle();
  const worker = () => calls.filter((c) => c.worker);
  const p = {
    M, D: M.data, win: window, clock, store, seen, failures, listeners,
    main: () => els["ups-m-main"].innerHTML,
    worker, count: (route) => worker().filter((c) => c.path === route).length,
    since: (n) => worker().slice(n),
    go: async (h) => { window.location.hash = h; M.route.renderRoute(); await settle(); },
    on: (type, fn) => window.addEventListener(type, fn),
    // More → Sign out, through the button's own handler (signOut is not exported)
    signOut: async () => { await p.go("#more"); els["ups-m-sign-out"].click(); await settle(); },
    readAll: async () => { await Promise.all([M.data.ensureAdvancedStats(), M.data.ensureCapPenaltyPreview(), M.data.ensureTaxiCallups()]); await settle(); },
  };
  return p;
}

// ── Scenarios: each returns the expectations it found broken ([] = all good) ──
const S = {
  async signedOutBoot(src) {
    const p = await phone(src);
    const bad = [], paths = p.worker().map((c) => c.path);
    if (paths.join() !== "/api/active-season") bad.push("signed-out boot made worker calls " + JSON.stringify(paths));
    if (paths.some((x) => D1_ROUTES.includes(x))) bad.push("signed-out boot called a D1 route");
    if (!/Sign in with MFL/.test(p.main())) bad.push("signed-out boot did not show the Sign-in card");
    return bad;
  },
  async signedInBoot(src) {
    const bad = [];
    for (const hash of ["", "#league/standings"]) {
      const p = await phone(src, { stored: SIGNED_IN, hash });
      const where = hash || "#home";
      if (!p.seen.length) bad.push(where + ": nothing rendered");
      for (const r of [LB, CAP, TAXI]) if (p.count(r)) bad.push(where + " cold boot called " + r + " ×" + p.count(r));
      if (p.count("/api/me") !== 1) bad.push(where + ": /api/me ×" + p.count("/api/me"));
      const draftNow = p.worker().filter((c) => /TYPE=draftResults/.test(c.query) && /YEAR=2026/.test(c.query)).length;
      if (draftNow !== 1) bad.push(where + ": this season's draftResults read ×" + draftNow + " (one shared read expected)");
    }
    return bad;
  },
  async lazyOnOpen(src) {
    const p = await phone(src, { stored: SIGNED_IN });
    const bad = [];
    let ready = 0;
    p.on("ups-advanced-stats-ready", () => ready++);
    p.M.state.historicalDraftByPid = { "123": { year: 2025, round: 3, pick: 1 } };   // a taxi-window rookie
    if (p.D.advancedStatsKnown()) bad.push("leaderboards reported as read before any screen asked");
    if (p.D.isTaxiEligibleFor("123", "Rookie-Draft")) bad.push("taxi eligibility said yes while the call-up counts are unknown");
    await p.D.ensureAdvancedStats(); await settle();
    if (p.count(LB) !== 16) bad.push("the screen that shows leaderboards got " + p.count(LB) + " reads (the 16-board window expected)");
    if (!ready) bad.push("no ups-advanced-stats-ready for the screen to repaint on");
    if (!p.D.getAdvancedStatsFor(2025, 2025)) bad.push("leaderboard rows not in state after the read");
    await p.D.ensureTaxiCallups(); await p.D.ensureCapPenaltyPreview(); await settle();
    if (p.count(TAXI) !== 1 || p.count(CAP) !== 1) bad.push("taxi / penalty reads on open: " + p.count(TAXI) + " / " + p.count(CAP));
    if (!p.D.taxiCallupsKnown() || !p.D.capPenaltyFor("123")) bad.push("taxi / penalty answers not in state");
    if (!p.D.isTaxiEligibleFor("123", "Rookie-Draft")) bad.push("taxi eligibility still no after the counts landed");
    return bad;
  },
  async sharedInFlight(src, penaltySrc) {
    const p = await phone(src, { stored: SIGNED_IN, penaltySrc });
    const bad = [];
    const D = p.D, FO = p.win.UPS_FRONT_OFFICE;
    await Promise.all([D.ensureAdvancedStats(), D.ensureAdvancedStats(), D.ensureCapPenaltyPreview(),
      // the penalty module's own self-heal asking while the app's read is in flight (a Drop label drawing)
      Promise.resolve(FO.dropPenaltyFor({ id: "999", salary: "1000", years: "1" }, "2026")),
      D.ensureCapPenaltyPreview(), D.ensureTaxiCallups(), D.ensureTaxiCallups()]);
    await settle();
    if (p.count(LB) !== 16) bad.push("two screens asking at once made " + p.count(LB) + " leaderboard reads (16 expected)");
    if (p.count(CAP) !== 1) bad.push("penalty batch read ×" + p.count(CAP) + " while one was in flight");
    if (p.count(TAXI) !== 1) bad.push("taxi counts read ×" + p.count(TAXI) + " while one was in flight");
    return bad;
  },
  async keptForTheLoad(src) {
    const p = await phone(src, { stored: SIGNED_IN });
    await p.readAll();
    const n = p.worker().length;
    for (const h of ["#league/standings", "#home", "#myteam", "#league/stats", "#home"]) await p.go(h);
    await p.readAll();
    const again = p.since(n).map((c) => c.path);
    return again.length ? ["switching screens re-asked: " + JSON.stringify(again)] : [];
  },
  async refreshRule(src) {
    const bad = [];
    const p = await phone(src, { stored: SIGNED_IN });
    await p.readAll();
    // a move's reload: the penalty batch and taxi counts are read again at once (this load had read them); the
    // leaderboards are kept
    let n = p.worker().length;
    await p.M.actions.reloadData(); await settle();
    await p.D.ensureAdvancedStats(); await settle();
    let after = p.since(n);
    if (after.filter((c) => c.path === CAP).length !== 1) bad.push("after a move the penalty batch was not read again (once)");
    if (after.filter((c) => c.path === TAXI).length !== 1) bad.push("after a move the taxi counts were not read again (once)");
    if (after.filter((c) => c.path === LB).length) bad.push("a move re-read the leaderboards");
    // an owner refresh: the leaderboards go too, and the next screen asks again
    const g = p.D.refreshGen();
    n = p.worker().length;
    await p.M.actions.reloadData({ refresh: true }); await settle();
    await p.D.ensureAdvancedStats(); await settle();
    after = p.since(n);
    if (after.filter((c) => c.path === LB).length !== 16) bad.push("pull-to-refresh did not drop the leaderboards");
    if (p.D.refreshGen() === g) bad.push("pull-to-refresh did not move refreshGen (the views drop their own copies on it)");
    // another season is its own read, never the 2026 copy: its window is 2025–2022, and only the boards this load
    // hasn't got (2022's four) are asked for — 2023–2025 are the identical requests already answered
    n = p.worker().length;
    p.M.state.ctx.year = "2025";
    await p.D.ensureAdvancedStats(); await settle();
    const seasons = p.since(n).filter((c) => c.path === LB).map((c) => new URLSearchParams(c.query).get("season"));
    if (seasons.join() !== "2022,2022,2022,2022") bad.push("season 2025's window asked for " + JSON.stringify(seasons) + " (2022 ×4 expected)");
    if (p.D.getAdvancedStatsLatestYear() !== 2025) bad.push("season 2025's window was not the one in state");
    return bad;
  },
  async signOutDropsEverything(src) {
    const bad = [];
    const p = await phone(src, { stored: SIGNED_IN });
    await p.readAll();
    p.M.state.tradeOffers = { incoming: [{ id: "owner-A-offer" }], outgoing: [], status: "ok" };
    p.M.state.tradeBaitNotes = { "123": "owner A's note" };
    p.M.state.isCommish = true;
    const g = p.D.refreshGen();
    await p.signOut();
    if (p.M.state.tradeOffers || p.M.state.tradeBaitNotes) bad.push("owner A's trade offers / notes survived sign-out");
    if (p.M.state.isCommish) bad.push("the commish flag survived sign-out");
    if (p.store.ups_mfl_user_id || p.store.rdh_my_fid) bad.push("the saved session survived sign-out");
    if (p.D.refreshGen() === g) bad.push("sign-out did not move refreshGen");
    const n = p.worker().length;
    await p.readAll();
    const after = p.since(n).map((c) => c.path);
    for (const r of [LB, CAP, TAXI]) if (!after.includes(r)) bad.push("after sign-out " + r + " was served from owner A's session");
    return bad;
  },
  async boundedRetry(src) {
    const bad = [];
    const p = await phone(src, { stored: SIGNED_IN });
    p.failures[LB] = 2; p.failures[CAP] = 1;
    await p.D.ensureAdvancedStats(); await p.D.ensureCapPenaltyPreview(); await settle();
    if (p.count(LB) !== 16 || p.count(CAP) !== 1) bad.push("first read: " + p.count(LB) + " boards / " + p.count(CAP) + " batches");
    let n = p.worker().length;
    for (let i = 0; i < 3; i++) { await p.D.ensureAdvancedStats(); await p.D.ensureCapPenaltyPreview(); }   // screens repainting
    p.clock.now += 29000;
    await p.D.ensureAdvancedStats(); await p.D.ensureCapPenaltyPreview(); await settle();
    if (p.since(n).length) bad.push("re-asked within 30 s of a failure: " + JSON.stringify(p.since(n).map((c) => c.path)));
    p.clock.now += 2000;
    n = p.worker().length;
    await p.D.ensureAdvancedStats(); await p.D.ensureCapPenaltyPreview(); await settle();
    const retry = p.since(n);
    if (retry.filter((c) => c.path === LB).length !== 2) bad.push("the retry asked for " + retry.filter((c) => c.path === LB).length + " boards (only the 2 that failed expected)");
    if (retry.filter((c) => c.path === CAP).length !== 1) bad.push("the retry asked for the penalty batch ×" + retry.filter((c) => c.path === CAP).length);
    if (!(p.M.state.capPenaltyMeta && p.M.state.capPenaltyMeta.status === "ok")) bad.push("the retry's answer did not land");
    n = p.worker().length;
    await p.D.ensureAdvancedStats(); await p.D.ensureCapPenaltyPreview(); await settle();
    if (p.since(n).length) bad.push("after a good retry the answer was not kept");
    return bad;
  },
};

// ── Stats → Players (views/stats.js keeps its own boards, keyed by group and season) ──
const util = ["safeStr", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");
function statsView(statsSrc) {
  const clock = { now: T0 }, calls = [], failures = {}, gen = { v: 0 };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  const views = {};
  const M = {
    state: { ctx: { leagueId: "74598", year: "2026" }, rosters: null, franchises: [] },
    data: { playerById: () => null, getAdvancedStatsLatestYear: () => 2026, refreshGen: () => gen.v },
    api: { workerUrl: (p) => "https://w.test" + p },
    route: { registerView: (name, fn) => (views[name] = fn), renderRoute: () => views.stats(mount), currentRoute: () => "league/stats" },
  };
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (failures[u.pathname] > 0) { failures[u.pathname]--; return { ok: false, status: 500, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => (u.pathname === LB ? { rows: [], next_offset: null } : { ok: true, players: {}, by_gsis: {} }) };
  };
  const ctx = vm.createContext({ window: { UPS_MOBILE: M }, document: { getElementById: () => null }, fetch, console, setTimeout, clearTimeout, Promise, URL, Date: FakeDate });
  vm.runInContext(util + "window.UPS_MOBILE.util = { safeStr, pad4, escapeHtml, asArray };", ctx);
  vm.runInContext(statsSrc, ctx);
  return { render: () => views.stats(mount), boards: () => calls.filter((x) => x === LB).length, clock, failures, gen };
}
const SS = {
  async statsShared(src) {
    const v = statsView(src);
    v.render(); v.render(); v.render();   // three renders before the first board answers (a tab tap, an app event…)
    await settle();
    return v.boards() === 1 ? [] : ["three renders read the QB board " + v.boards() + " times"];
  },
  async statsRetryAndRefresh(src) {
    const bad = [];
    const v = statsView(src);
    v.failures[LB] = 1;
    v.render(); await settle();
    if (v.boards() !== 1) bad.push("first render read " + v.boards() + " boards");
    v.render(); await settle();
    if (v.boards() !== 1) bad.push("a render right after a failed read asked again");
    v.clock.now += 31000;
    v.render(); await settle();
    if (v.boards() !== 2) bad.push("the failed board was not asked again after 30 s (it used to be kept as empty for the session)");
    v.render(); await settle();
    if (v.boards() !== 2) bad.push("a good board was not kept");
    v.gen.v += 1;   // pull-to-refresh / Refresh data / sign-out
    v.render(); await settle();
    if (v.boards() !== 3) bad.push("an owner refresh did not drop the board");
    return bad;
  },
};

// ── Who asks: the screens that show each read ask for it, and nothing else in app.js reads it ──
function slice(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("no " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
}
test("the screens that show them ask: sheet (penalty + taxi on open, leaderboards on its Stats tab), My Team (taxi), Players (penalty; last season's board before scores post), Stats (leaderboards for a stored season)", () => {
  const SHEET = read("site/m/player_sheet.js"), CONTRACTS = read("site/m/views/contracts.js"), PLAYERS = read("site/m/views/players.js");
  const open = slice(SHEET, "function open(pid, opts)");
  t.match(open, /DATA\.ensureCapPenaltyPreview\(\)/, "sheet open asks for the penalty batch");
  t.match(open, /DATA\.ensureTaxiCallups\(\)/, "sheet open asks for the taxi counts");
  t.doesNotMatch(open, /ensureAdvancedStats/, "sheet open does not read leaderboards (its Stats tab does)");
  t.match(slice(SHEET, "function renderTabBody()").split('activeTab === "news"')[0], /DATA\.ensureAdvancedStats\(\)/, "the sheet's Stats tab asks for leaderboards");
  t.match(slice(CONTRACTS, "function render(mount, subParts)"), /DATA\.ensureTaxiCallups\(\)/, "My Team asks for the taxi counts");
  t.match(slice(PLAYERS, "function render(mount, parts)"), /DATA\.ensureCapPenaltyPreview\(\)/, "Players asks for the penalty batch");
  t.match(slice(PLAYERS, "function pointsBasis()"), /DATA\.ensureAdvancedStats\(\)/, "Players asks for last season's board when no score is posted");
  t.match(slice(STATS, "function render(mount)"), /D\(\)\.ensureAdvancedStats\(\)/, "Stats asks when its season isn't known yet");
  for (const [sig, owner] of [["fetchAdvancedStatsLeaderboard(state.ctx.year)", "ensureAdvancedStats"], ["fetchCapPenaltyPreview()", "ensureCapPenaltyPreview"], ['workerUrl("/api/taxi-callups")', "ensureTaxiCallups"]]) {
    const calls = APP.split(sig).length - 1 - APP.split("function " + sig).length + 1;   // calls, not the definition
    t.equal(calls, 1, sig + " is called from one place");
    t.ok(slice(APP, "function " + owner + "()").includes(sig), sig + " is called only from " + owner);
  }
});

// ── The tests: the scenarios hold on the real source ──
for (const [name, fn] of Object.entries(S)) test("app.js " + name, async () => { const bad = await fn(APP, PENALTY); t.deepEqual(bad, [], bad.join("; ")); });
for (const [name, fn] of Object.entries(SS)) test("stats.js " + name, async () => { const bad = await fn(STATS); t.deepEqual(bad, [], bad.join("; ")); });

// ── Mutation checks: remove one guard, the scenario it protects must break ──
// file: "app" | "penalty" | "stats"; find must occur exactly once (all: true replaces every occurrence).
const MUTATIONS = [
  { guard: "boot gate: no identity → the Sign-in card without loading", scenario: "signedOutBoot", file: "app",
    find: "      if (!UNGATED[top] && !hasIdentityHint()) { renderSignedOut(main); return; }\n", replace: "" },
  { guard: "leaderboards are not read at boot", scenario: "signedInBoot", file: "app",
    find: "      // them; the screens that do ask (ensureAdvancedStats).\n      null,", replace: "      fetchAdvancedStatsLeaderboard(state.ctx.year)," },
  { guard: "taxi counts are not read at boot", scenario: "signedInBoot", file: "app",
    find: "      // (ensureTaxiCallups).\n      null,", replace: "      fetch(workerUrl(\"/api/taxi-callups\")).then(function (r) { return r.json(); })," },
  { guard: "the penalty batch is not read at boot", scenario: "signedInBoot", file: "app",
    find: "      // always tell the owner what window they're in.\n      null,", replace: "      fetchCapPenaltyPreview()," },
  { guard: "this season's draftResults is one shared read", scenario: "signedInBoot", file: "app",
    find: "fetchHistoricalDraftIndex(state.ctx.year, draftNow)", replace: "fetchHistoricalDraftIndex(state.ctx.year)" },
  { guard: "taxi eligibility is unknown (no) until the counts are read (fail closed)", scenario: "lazyOnOpen", file: "app",   // "not read yet" read as "read, never promoted"
    find: "        var countsKnown = !!state.taxiCallupsByPid && state.taxiCallupsOk !== false;", replace: "        var countsKnown = state.taxiCallupsOk !== false;" },
  { guard: "a read in flight is shared", scenario: "sharedInFlight", file: "app",
    find: "      if (e.promise) return e.promise;\n", replace: "" },
  { guard: "the penalty module defers to the app's read", scenario: "sharedInFlight", file: "penalty",
    find: "    if (data && data.ensureCapPenaltyPreview) { data.ensureCapPenaltyPreview(); return; }\n", replace: "" },
  { guard: "an answer is kept for the app load", scenario: "keptForTheLoad", file: "app",
    find: "      if (e.ok || Date.now() - e.failedAt < LAZY_RETRY_MS) return Promise.resolve(e.ok);",
    replace: "      if (!e.ok && Date.now() - e.failedAt < LAZY_RETRY_MS) return Promise.resolve(e.ok);" },
  { guard: "a move drops (and re-reads) the penalty batch and taxi counts", scenario: "refreshRule", file: "app",
    find: "    var had = dropLazyReads(ownerRefresh ? null : [\"capPenalty\", \"taxiCallups\"]);", replace: "    var had = ownerRefresh ? dropLazyReads(null) : [];" },
  { guard: "an owner refresh drops the leaderboards", scenario: "refreshRule", file: "app",
    find: "    var had = dropLazyReads(ownerRefresh ? null : [\"capPenalty\", \"taxiCallups\"]);", replace: "    var had = dropLazyReads([\"capPenalty\", \"taxiCallups\"]);" },
  { guard: "a copy is keyed by league and season", scenario: "refreshRule", file: "app",
    find: "  function lazyKey(name) { return name + \"|\" + state.ctx.leagueId + \"|\" + state.ctx.year; }", replace: "  function lazyKey(name) { return name; }" },
  { guard: "sign-out drops every copy", scenario: "signOutDropsEverything", file: "app",
    find: "    dropLazyReads();\n    refreshGen += 1;\n    renderRoute();", replace: "    renderRoute();" },
  { guard: "sign-out clears the owner's own reads", scenario: "signOutDropsEverything", file: "app",
    find: "    state.tradeOffers = null;\n    state.tradeBaitNotes = null;\n", replace: "" },
  { guard: "a failure is not re-asked for 30 s", scenario: "boundedRetry", file: "app",
    find: "      if (e.ok || Date.now() - e.failedAt < LAZY_RETRY_MS) return Promise.resolve(e.ok);", replace: "      if (e.ok) return Promise.resolve(e.ok);" },
  { guard: "a retry asks only for the boards that failed", scenario: "boundedRetry", file: "app",
    find: "      if (lbBoards[url]) return Promise.resolve(lbBoards[url]);\n", replace: "" },
  { guard: "Stats shares a board read in flight", scenario: "statsShared", file: "stats",
    find: "    if (inflight[key]) return inflight[key];\n", replace: "" },
  { guard: "Stats does not keep a failed board as empty, retries after 30 s", scenario: "statsRetryAndRefresh", file: "stats",
    find: "    if (failedAt[key] && Date.now() - failedAt[key] < LOAD_RETRY_MS) return Promise.resolve([]);\n", replace: "" },
  { guard: "Stats drops its boards on an owner refresh", scenario: "statsRetryAndRefresh", file: "stats",
    find: "    dropIfRefreshed();\n", replace: "", all: true },
];
for (const m of MUTATIONS) {
  test("mutation: without \"" + m.guard + "\", " + m.scenario + " fails", async () => {
    const src = { app: APP, penalty: PENALTY, stats: STATS }[m.file];
    const hits = src.split(m.find).length - 1;
    t.ok(m.all ? hits >= 1 : hits === 1, "the guard's text is in " + m.file + " (" + hits + " matches) — update this mutation with the code");
    const mutated = m.all ? src.split(m.find).join(m.replace) : src.replace(m.find, m.replace);
    const fn = S[m.scenario] || SS[m.scenario];
    let bad;
    try {
      bad = m.file === "stats" ? await fn(mutated) : m.file === "penalty" ? await fn(APP, mutated) : await fn(mutated, PENALTY);
    } catch (e) { bad = ["threw: " + (e && e.message)]; }   // a scenario that breaks by throwing has broken too
    t.ok(bad.length > 0, "the scenario still passed with the guard removed");
  });
}

await run("mobile_boot_requests");
