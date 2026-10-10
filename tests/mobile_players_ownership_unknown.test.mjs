// Mobile Players tab, player sheet, global search and the waiver Bid / Add controls: who owns a player comes from
// LIVE MFL rosters (state.rosters, the TYPE=rosters read loadAllData makes at boot and on every refresh), and a player
// on NO roster is a free agent ONLY when that read is CONFIRMED COMPLETE: every franchise in the league export present,
// with players. On 2026-10-09 the read failed (fetchJson → null) and the Players tab listed EVERY player as a free
// agent, Jeremiyah Love (Cleon Ca$h's) included; his sheet said "Free agent — no contract on file" and offered a Bid.
// Same rule as the Stats tab (#1203, tests/mobile_stats_live_ownership.test.mjs).
//
// Drives the REAL site/m code under Node: app.js's loadAllData / reloadData / fetchJson / parseLeague and its ownership
// helpers (sliced out, not re-typed), plus views/players.js, player_sheet.js and player_search.js (whole files), against
// that day's live rosters (12 franchises, 485 players) served by a fake fetch. Nothing here can write: the write paths
// are stubs that record and reject, and every test asserts no POST was made.
//   node tests/mobile_players_ownership_unknown.test.mjs
// Prove-it-fails: APP_JS / PLAYERS_JS / SHEET_JS / SEARCH_JS can point at other copies (e.g. origin/main's).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const FX = JSON.parse(read("tests/fixtures/mobile_stats_ownership_2026_10_09.json"));
const APP = read(process.env.APP_JS || "site/m/app.js");
const PLAYERS_SRC = read(process.env.PLAYERS_JS || "site/m/views/players.js");
const SHEET_SRC = read(process.env.SHEET_JS || "site/m/player_sheet.js");
const SEARCH_SRC = read(process.env.SEARCH_JS || "site/m/player_search.js");

function sliceFn(src, sig, optional) {
  const at = src.indexOf(sig);
  if (at < 0) { if (optional) return ""; throw new Error("app.js: no " + sig); }
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
const REQUIRED = ["safeStr", "safeInt", "pad4", "escapeHtml", "fmtUsd", "asArray", "fetchJson", "mflExportUrl",
  "mflExportUrlForYear", "loadAllData", "reloadData", "parseLeague", "findFranchiseById", "getAllRosteredPids", "playerById"];
const OPTIONAL = ["rosterOwnership", "ownerOfPid"];   // the shared ownership rule (absent before this fix)
const APP_SRC = REQUIRED.map((n) => sliceFn(APP, "function " + n + "(")).join("\n") + "\n" +
  OPTIONAL.map((n) => sliceFn(APP, "function " + n + "(", true)).join("\n");
// loadAllData's other sources (tag tracking, injuries, waiver state, …) answer null — this test is about rosters.
const fetchers = [...new Set([...APP_SRC.matchAll(/\b(fetch[A-Z]\w*)\s*\(/g)].map((m) => m[1]))]
  .filter((n) => n !== "fetchJson" && !new RegExp("function " + n + "\\(").test(APP_SRC));
const LOADER_STUBS = fetchers.map((n) => "function " + n + "() { return Promise.resolve(null); }").join("\n") + `
function workerUrl(p) { return "https://w.test" + p; }
function repairTaxiContractsInPlace() {}
function emptyContractLadder() { return { contractDeadline: "" }; }
function resolveViewerFranchise() {}
function reconcileWaiverPlanAfterRun() {}
function tradeOffersUnavailable(status, message) { return { incoming: [], outgoing: [], status: status, message: message }; }`;

const NAME = Object.fromEntries(FX.mfl_franchises.map((f) => [f.id, f.name]));
const LOVE = "17472", HENRY = "12626", BROOKS = "16387";   // Cleon Ca$h's (0011) · Blake Bombers' (0010) · a free agent
const copy = (x) => JSON.parse(JSON.stringify(x));
const rostersWith = (edit) => { const r = copy(FX.mfl_rosters); edit(r.rosters); return r; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeEl(id) {
  const cls = new Set(), kids = {};
  return {
    id, innerHTML: "", value: "", textContent: "", disabled: false, style: {}, listeners: {}, parentNode: null, scrollTop: 0,
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c), toggle: (c, on) => ((on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c)) },
    get firstChild() { return this.innerHTML ? {} : null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {}, setAttribute() {}, getAttribute: () => null, focus() {}, setSelectionRange() {},
    querySelector(sel) { return (kids[sel] = kids[sel] || fakeEl(sel)); },
    querySelectorAll: () => [],
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn.call(this, { target: this })); },
  };
}

// Boots the app the way a cold start does (loadAllData), then hands back the surfaces.
async function boot({ rosters = FX.mfl_rosters, league = "ok", mode = "bbid" } = {}) {
  const mfl = { rosters, league };          // what MFL answers on the NEXT read; "fail" = HTTP 500
  const rec = { toasts: [], writes: [], calls: [] };
  const fetch = (url, opts) => {
    const u = new URL(url);
    rec.calls.push({ path: u.pathname, type: u.searchParams.get("TYPE") || "", method: (opts && opts.method) || "GET" });
    const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(copy(body)) });
    const fail = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    if (u.pathname !== "/api/mfl-export") return fail();
    const type = u.searchParams.get("TYPE");
    if (type === "rosters") return mfl.rosters === "fail" ? fail() : ok(mfl.rosters);
    if (type === "league") return mfl.league === "fail" ? fail()
      : ok({ league: { salaryCapAmount: "300000", franchises: { franchise: FX.mfl_franchises } } });
    if (type === "players") return ok({ players: { player: FX.mfl_players } });
    return ok({});
  };
  const state = { ctx: { year: "2026", leagueId: "74598", embed: false }, franchises: [], rosters: null, players: null,
    viewerFranchiseId: "0008", loadErrors: [], loadingPromise: null, optimisticTagSubmissions: null, lineupWeek: 5 };
  const views = {}, controls = {};
  const mount = fakeEl("ups-m-main");
  mount.querySelectorAll = (sel) => {       // the note's Refresh button(s), rebuilt from what was rendered
    if (!/reload-rosters/.test(sel)) return [];
    return (mount.reloadBtns = [...mount.innerHTML.matchAll(/<button[^>]*data-act="reload-rosters"[^>]*>/g)].map(() => fakeEl("reload")));
  };
  const SHEET_IDS = ["ups-m-sheet-mount", "ups-m-sheet-overlay", "ups-m-sheet-close", "ups-m-sheet-head", "ups-m-sheet-tabs",
    "ups-m-sheet-body", "ups-m-sheet-foot"];
  const els = {};
  const created = [];
  const document = {
    body: { style: {}, appendChild(e) { e.parentNode = this; }, removeChild(e) { e.parentNode = null; } },
    activeElement: null, readyState: "complete", addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    getElementById(id) {
      // each render re-creates the toolbar, so each lookup gets a fresh control (the latest one is the live one)
      if (["ups-m-players-filter", "ups-m-players-sort", "ups-m-players-search"].includes(id)) return (controls[id] = fakeEl(id));
      if (SHEET_IDS.includes(id)) return (els[id] = els[id] || fakeEl(id));
      return null;
    },
    createElement(tag) { const e = fakeEl(tag); created.push(e); return e; },
  };
  const nowrite = (what) => () => { rec.writes.push(what); return Promise.reject(new Error("no writes in tests")); };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, fetch, document, state });
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  vm.runInContext(APP_SRC + "\n" + LOADER_STUBS, ctx);
  const M = {
    util: { safeStr: ctx.safeStr, safeInt: ctx.safeInt, pad4: ctx.pad4, escapeHtml: ctx.escapeHtml, fmtUsd: ctx.fmtUsd, asArray: ctx.asArray },
    state,
    api: { workerUrl: ctx.workerUrl, workerBase: () => "https://w.test", mflExportUrl: ctx.mflExportUrl, fetchJson: ctx.fetchJson, loadAllData: ctx.loadAllData },
    data: {
      playerById: ctx.playerById, findFranchiseById: ctx.findFranchiseById, getAllRosteredPids: ctx.getAllRosteredPids,
      ...(ctx.rosterOwnership ? { rosterOwnership: ctx.rosterOwnership } : {}),
      ...(ctx.ownerOfPid ? { ownerOfPid: ctx.ownerOfPid } : {}),
      getSeasonScoring: () => null, getAdvancedStatsMap: () => ({}), getAdvancedStatsLatestYear: () => 2026, getAdvancedStatsFor: () => null,
      getYtdScoresMap: () => ({}), getRosterFor: () => [], computeCap: () => null, rosterCapMax: () => 30, dropPenaltyFor: () => null,
      getMyTradeBaitIds: () => new Set(), getMyTradeBaitNoteFor: () => "",
    },
    actions: { reloadData: ctx.reloadData, submitDrop: nowrite("submitDrop"), submitOTBToggle: nowrite("submitOTBToggle") },
    waivers: {
      mode: () => ({ mode, label: mode, detail: "", writeEnabled: true, nativeLink: "" }), writeEnabled: () => true,
      stateKnown: () => true, nativeLink: () => "", limits: () => ({ min: 1000, step: 1000, maxRounds: 8, conditional: true, conditionalKnown: true }),
      getPlan: () => [], setPlan: () => rec.writes.push("setPlan"), pickCount: () => 0, clearCount: () => 0, isDirty: () => false,
      getPending: () => ({ known: true, rounds: [] }), fetchPending: () => Promise.resolve({ known: true, rounds: [] }),
      fetchState: () => Promise.resolve(null), adoptVerified: () => false, lastRun: () => ({ known: false }), targetRun: () => null,
      submitPlan: nowrite("submitPlan"), submitFcfs: nowrite("submitFcfs"), when: () => "", countdown: () => "",
    },
    ui: { showToast: (m) => rec.toasts.push(String(m)) },
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.players(mount, []), currentRoute: () => "players", navigate() {} },
    hotCold: { get: () => null, isLoading: () => false, fetch: () => Promise.resolve() },
    lineupIntel: { load() {}, projLoaded: () => false, projFor: () => null, fmtProj: (v) => String(v), matchupFor: () => null,
      priorSeason: () => false, rankCls: () => "", weeksAvailable: () => 0, muData: () => null,
      kickoffs: { load() {}, loaded: () => true, kickedOff: () => false, kickoffFor: () => null } },
    isCommishOverride: () => false,
  };
  ctx.UPS_MOBILE = M;
  vm.runInContext(PLAYERS_SRC, ctx);
  vm.runInContext(SHEET_SRC, ctx);
  vm.runInContext(SEARCH_SRC, ctx);
  await ctx.loadAllData();                  // cold boot
  const render = () => { views.players(mount, []); return mount.innerHTML; };
  // the real Free Agents / All Players / team filter: render, then change the select it bound
  const scope = (v) => { render(); const f = controls["ups-m-players-filter"]; f.value = v; f.fire("change"); return mount.innerHTML; };
  const sheet = (pid) => { M.sheet.open(pid); return { body: els["ups-m-sheet-body"].innerHTML, foot: els["ups-m-sheet-foot"].innerHTML }; };
  const search = (q) => {
    M.playerSearch.openWith(q);
    const html = created[created.length - 1].querySelector(".ups-m-psr-list").innerHTML;
    M.playerSearch.close();
    return searchOwners(html);
  };
  // The note's Refresh button → the app's own reload (reloadData → loadAllData), then the re-render it triggers.
  const tapRefresh = async () => {
    mount.reloadBtns = [];
    views.players(mount, []);               // bind() wires its click listener onto the button it asks for
    const btn = mount.reloadBtns[0];
    if (!btn || !(btn.listeners.click || []).length) throw new Error("no Refresh button rendered");
    btn.listeners.click.forEach((fn) => fn.call(btn, { stopPropagation() {} }));
    await settle();
    return mount.innerHTML;
  };
  const reload = async () => { await M.actions.reloadData(); await settle(); };
  return { M, state, mfl, rec, render, scope, sheet, search, tapRefresh, reload };
}

// { pid: { owner, bid, add, trade } } for every Players row rendered
function rows(html) {
  const out = {};
  for (const chunk of html.split('<div class="ups-m-fa-row').slice(1)) {
    const pid = (/data-pid="(\d+)"/.exec(chunk) || [])[1];
    const owner = (/<span class="owned[^"]*">([^<]*)<\/span>/.exec(chunk) || [])[1] || "";
    out[pid] = { owner: owner.replace(/&amp;/g, "&"), bid: /data-act="waiver-bid"/.test(chunk), add: /data-act="waiver-add"/.test(chunk),
      trade: /data-act="propose-trade"/.test(chunk) };
  }
  return out;
}
// { pid: "ARI · owner unknown" } for every search result rendered
function searchOwners(html) {
  const out = {};
  for (const m of html.matchAll(/data-pid="(\d+)">[\s\S]*?<span class="sub">([\s\S]*?)<\/span><\/span><span class="num">/g)) {
    out[m[1]] = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  }
  return out;
}
const ACQUIRE = /data-act="waiver-(bid|add)"/;
const noPost = (app) => t.ok(app.rec.calls.every((c) => c.method === "GET") && !app.rec.writes.length, "no writes: " + JSON.stringify(app.rec.writes));

// Everything a player whose ownership is UNKNOWN must look like, on every surface.
async function expectUnknown(app, { readable }) {
  const fa = app.scope("fa");
  t.deepEqual(Object.keys(rows(fa)), [], "Free Agents: nobody listed as a free agent");
  t.match(fa, readable ? /Couldn.t read all of MFL.s rosters/ : /Couldn.t read MFL.s rosters/);
  t.match(fa, /free agents can.t be confirmed right now/);
  t.match(fa, /data-act="reload-rosters"/, "…with a Refresh");
  t.doesNotMatch(fa, ACQUIRE, "no Bid / Add anywhere on the list");
  const all = rows(app.scope("all"));
  t.deepEqual(all[LOVE], { owner: "Owner unknown", bid: false, add: false, trade: false }, "All players: Love is 'Owner unknown', no Bid/Add");
  t.deepEqual(all[BROOKS], { owner: "Owner unknown", bid: false, add: false, trade: false }, "not even a real free agent is offered on a guess");
  app.scope("fa");
  const s = app.sheet(LOVE);
  t.match(s.body, /Ownership unknown/, "Love's sheet: ownership unknown");
  t.doesNotMatch(s.body, /Free agent/, "…never 'Free agent — no contract on file'");
  t.doesNotMatch(s.foot, ACQUIRE, "…and no Bid / Add");
  t.match(s.foot, /Ownership unknown/);
  t.equal(app.search("love")[LOVE], "ARI · owner unknown", "search: Love is not 'FA'");
  t.equal(app.search("brooks")[BROOKS], "GBP · owner unknown");
  // a Bid / Add reaching the entry points anyway (a button drawn before the read, another surface) is refused
  const toasts = app.rec.toasts.length;
  app.M.waiverUI.openBid(LOVE);
  app.M.waiverUI.startFcfs(LOVE);
  t.equal(app.rec.toasts.length - toasts, 2, "both entry points refuse");
  t.match(app.rec.toasts[toasts], /Couldn.t confirm Jeremiyah Love is a free agent/);
  noPost(app);
}

test("the fixture's rosters are COMPLETE (12 franchises, 485 players): Love is Cleon Ca$h's, Henry Blake Bombers', Brooks on none", () => {
  const fr = FX.mfl_rosters.rosters.franchise;
  t.deepEqual(fr.map((f) => f.id).sort(), FX.mfl_franchises.map((f) => f.id).sort());
  t.ok(fr.every((f) => f.player.length > 0)); t.equal(fr.reduce((n, f) => n + f.player.length, 0), 485);
  const live = {}; fr.forEach((f) => f.player.forEach((p) => (live[p.id] = f.id)));
  t.deepEqual([live[LOVE], live[HENRY], live[BROOKS]], ["0011", "0010", undefined]);
  t.deepEqual([NAME["0011"], NAME["0010"], NAME["0004"]], ["Cleon Ca$h", "Blake Bombers", "Pure Greatness"]);
});

test("control — rosters read COMPLETE: free agents listed with a Bid; Love is Cleon Ca$h's everywhere", async () => {
  const app = await boot();
  const fa = rows(app.scope("fa"));
  t.deepEqual(Object.keys(fa).sort(), ["11679", "15787", BROOKS].sort(), "the day's three free agents in the fixture");
  t.ok(fa[BROOKS].bid, "Brooks: Bid");
  const all = rows(app.scope("all"));
  t.deepEqual(all[LOVE], { owner: "Cleon Ca$h", bid: false, add: false, trade: true });
  app.scope("fa");
  const s = app.sheet(BROOKS);
  t.match(s.body, /Free agent — no contract on file/); t.match(s.foot, /data-act="waiver-bid"/);
  t.equal(app.search("love")[LOVE], "ARI · Cleon Ca$h"); t.equal(app.search("brooks")[BROOKS], "GBP · FA");
  noPost(app);
});

test("(a) rosters read FAILED (fetchJson → null): no free-agent list, Love's sheet says ownership unknown, no add/bid/FCFS, search never 'FA'", async () => {
  for (const mode of ["bbid", "fcfs"]) {
    const app = await boot({ rosters: "fail", mode });
    t.equal(app.state.rosters, null, "the boot read really failed");
    t.ok(app.state.loadErrors.some((e) => /^rosters: HTTP 500/.test(e)), "…and the load banner knows");
    await expectUnknown(app, { readable: false });
  }
});

test("(b) EMPTY rosters response — {rosters:{}} and {rosters:{franchise:[]}}: ownership unknown, never FA", async () => {
  for (const rosters of [{ rosters: {} }, { rosters: { franchise: [] } }]) {
    const app = await boot({ rosters });
    t.ok(app.state.rosters && app.state.loadErrors.length === 0, "MFL answered 200: " + JSON.stringify(rosters));
    await expectUnknown(app, { readable: true });
  }
});

test("(c) PARTIAL — Cleon Ca$h's roster missing, or listed with player:[]: Love unknown (not FA); Henry still Blake Bombers'", async () => {
  for (const [label, edit] of [
    ["0011 missing", (r) => { r.franchise = r.franchise.filter((f) => f.id !== "0011"); }],
    ["0011 player:[]", (r) => { r.franchise.find((f) => f.id === "0011").player = []; }],
  ]) {
    const app = await boot({ rosters: rostersWith(edit) });
    await expectUnknown(app, { readable: true });
    const henry = rows(app.scope("all"))[HENRY];
    t.deepEqual(henry, { owner: "Blake Bombers", bid: false, add: false, trade: true }, label + ": found on a roster = still his owner's");
    app.scope("fa");
    const s = app.sheet(HENRY);
    t.match(s.body, /<h4>Contract<\/h4>/, "Henry's sheet: his roster row, not 'unknown'");
    t.doesNotMatch(s.body + s.foot, /Ownership unknown|Free agent/);
    t.equal(app.search("henry")[HENRY], "BAL · Blake Bombers");
  }
  // a team filter on the missing franchise says it couldn't be read, not "No matching players"
  const app = await boot({ rosters: rostersWith((r) => { r.franchise = r.franchise.filter((f) => f.id !== "0011"); }) });
  app.scope("team:0011");
  t.match(app.render(), /Couldn.t read Cleon Ca\$h.s roster from MFL/);
  noPost(app);
});

test("the league export unreadable at boot (no franchise list) → completeness can't be confirmed → nobody is FA", async () => {
  const app = await boot({ league: "fail" });
  t.equal(app.state.franchises.length, 0);
  t.deepEqual(Object.keys(rows(app.scope("fa"))), []);
  t.match(app.render(), /Couldn.t read all of MFL.s rosters/);
  const all = rows(app.scope("all"));
  t.equal(all[BROOKS].owner, "Owner unknown");
  t.ok(all[LOVE].owner && all[LOVE].owner !== "Owner unknown" && !all[LOVE].bid, "Love is still on a roster (name unavailable), never biddable");
  app.scope("fa");
  t.doesNotMatch(app.sheet(BROOKS).foot, ACQUIRE);
  noPost(app);
});

test("(d) RECOVERED: a failed read, then Refresh (reloadData → loadAllData) reads them complete → free agents are back, with a Bid", async () => {
  const app = await boot({ rosters: "fail" });
  t.deepEqual(Object.keys(rows(app.scope("fa"))), []);
  app.mfl.rosters = FX.mfl_rosters;          // MFL answers on the next read
  const html = await app.tapRefresh();
  t.equal(app.rec.calls.filter((c) => c.type === "rosters").length, 2, "the Refresh re-read MFL's rosters");
  t.equal(app.state.loadErrors.length, 0, "the reload's errors are its own (none)");
  const fa = rows(html);
  t.deepEqual(Object.keys(fa).sort(), ["11679", "15787", BROOKS].sort(), "free agents listed again; Love is not one");
  t.ok(fa[BROOKS].bid, "Brooks: Bid offered again");
  t.doesNotMatch(html, /Couldn.t read/);
  const s = app.sheet(BROOKS);
  t.match(s.body, /Free agent — no contract on file/); t.match(s.foot, /data-act="waiver-bid"/);
  t.equal(app.search("brooks")[BROOKS], "GBP · FA");
  t.equal(rows(app.scope("all"))[LOVE].owner, "Cleon Ca$h");
  noPost(app);
});

test("(e) a roster change between reads (a trade, then a claim) shows the NEW owner on every surface — no app restart", async () => {
  const app = await boot();
  t.equal(app.search("love")[LOVE], "ARI · Cleon Ca$h");
  // a trade: Love moves Cleon Ca$h → Blake Bombers (roster counts unchanged)
  app.mfl.rosters = rostersWith((r) => {
    const cleon = r.franchise.find((f) => f.id === "0011"), bombers = r.franchise.find((f) => f.id === "0010");
    cleon.player = cleon.player.filter((p) => p.id !== LOVE); bombers.player.push({ id: LOVE, status: "ROSTER" });
  });
  await app.reload();
  t.equal(rows(app.scope("all"))[LOVE].owner, "Blake Bombers", "Players list");
  t.equal(app.search("love")[LOVE], "ARI · Blake Bombers", "search (its index used to be keyed on roster COUNTS)");
  // a claim: Brooks lands on Pure Greatness — and a render DURING the reload can't pin the old rosters
  app.mfl.rosters = rostersWith((r) => {
    r.franchise.find((f) => f.id === "0004").player.push({ id: BROOKS, status: "ROSTER" });
    const cleon = r.franchise.find((f) => f.id === "0011"), bombers = r.franchise.find((f) => f.id === "0010");
    cleon.player = cleon.player.filter((p) => p.id !== LOVE); bombers.player.push({ id: LOVE, status: "ROSTER" });
  });
  app.scope("fa");
  const pending = app.M.actions.reloadData();
  app.render(); app.M.data.getAllRosteredPids();   // mid-reload reads see the old rosters…
  await pending; await settle();
  t.ok(!(BROOKS in rows(app.render())), "…but after it lands Brooks is off the free-agent list");
  t.ok(app.M.data.getAllRosteredPids().has(BROOKS));
  t.deepEqual(rows(app.scope("all"))[BROOKS], { owner: "Pure Greatness", bid: false, add: false, trade: true });
  app.scope("fa");
  const s = app.sheet(BROOKS);
  t.doesNotMatch(s.body + s.foot, /Free agent|Ownership unknown/); t.doesNotMatch(s.foot, ACQUIRE);
  t.equal(app.search("brooks")[BROOKS], "GBP · Pure Greatness");
  // a reload that comes back PARTIAL degrades to unknown; the next complete one restores the confirmed answer
  const good = app.mfl.rosters;
  app.mfl.rosters = { rosters: { franchise: good.rosters.franchise.filter((f) => f.id !== "0001") } };
  await app.reload();
  t.deepEqual(Object.keys(rows(app.scope("fa"))), []);
  t.equal(app.search("beckham")["11679"], "MIN · owner unknown");
  app.mfl.rosters = good;
  await app.reload();
  t.deepEqual(Object.keys(rows(app.scope("fa"))).sort(), ["11679", "15787"]);
  t.equal(app.search("beckham")["11679"], "MIN · FA");
  noPost(app);
});

await run("mobile_players_ownership_unknown");
