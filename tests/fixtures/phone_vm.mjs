// A fake phone for tests: the REAL site/m/app.js (and optionally the REAL site/m/report_bug.js) run under node:vm, with ONE
// global object that is both `window` and the script global (as in a browser, so `fetch(...)` in app.js is `window.fetch`),
// a small fake DOM, and a stub worker. Nothing leaves the process: every fetch is answered here, and any request to a host
// other than the stub worker or the stub Pages origin is recorded as `stray` so a test can fail on it.
//
// The stub worker answers the app's own GETs from a small table and the owner bug-report routes from the REAL
// handleBugReportRequest with the in-memory store (the same wiring as the private preview).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { handleBugReportRequest, makeMemoryStore } from "../../worker/src/bug_reports.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
export const WORKER_ORIGIN = "https://upsmflproduction.keith-creelman.workers.dev";   // app.js WORKER_BASE_DEFAULT
export const PAGES_ORIGIN = "https://ups.test";
export const T0 = Date.parse("2026-11-19T15:00:00Z");
export const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Routes the app registers (app.js and views/*.js). The vm has no views, so each gets a one-line stub view.
export const TOP_ROUTES = ["events", "home", "league", "market", "more", "myteam", "players", "scores", "stats"];
const STUB_VIEWS = TOP_ROUTES.filter((r) => r !== "more");   // "more" is app.js's own view (it carries the Report a problem row)

// ---------------------------------------------------------------- fake DOM
function makeDom() {
  const registry = {};
  const stubsOf = new Map();   // host element -> ids it scanned out of its innerHTML
  function el(tag) {
    const listeners = {};
    const e = {
      tagName: String(tag || "div").toUpperCase(), id: "", _kids: [], _attrs: {}, style: {}, className: "", disabled: false, value: "", parent: null,
      _text: "", _html: "", _scan: false, activeElement: null,
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
      dispatch(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(ev || {})); },
      click() { this.dispatch("click", { preventDefault() {}, stopPropagation() {}, target: this }); },
      appendChild(c) { e._kids.push(c); c.parent = e; if (c.id) registry[c.id] = c; return c; },
      insertBefore(c) { return e.appendChild(c); },
      insertAdjacentHTML() {},
      remove() { if (e.parent) e.parent._kids = e.parent._kids.filter((x) => x !== e); e.parent = null; if (e.id && registry[e.id] === e) delete registry[e.id]; },
      setAttribute(k, v) { e._attrs[k] = String(v); if (k === "id") { e.id = String(v); registry[e.id] = e; } },
      getAttribute(k) { return k in e._attrs ? e._attrs[k] : null; },
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus() {}, select() {}, blur() {},
    };
    Object.defineProperty(e, "textContent", { get: () => e._text, set(v) { e._text = String(v); if (e._onText) e._onText(e._text); } });
    Object.defineProperty(e, "innerHTML", {
      get: () => e._html,
      set(v) {
        e._html = String(v);
        if (!e._scan) return;
        // The app reads buttons back by id after writing innerHTML; give each id in the markup a stub that holds listeners.
        (stubsOf.get(e) || []).forEach((id) => { if (registry[id] && registry[id]._stub) delete registry[id]; });
        const ids = [];
        e._html.replace(/\bid="([^"]+)"/g, (m, id) => { ids.push(id); const s = el("button"); s.id = id; s._stub = true; registry[id] = s; return m; });
        stubsOf.set(e, ids);
      },
    });
    return e;
  }
  const document = {
    head: el("head"), body: el("body"), activeElement: null, cookie: "", visibilityState: "visible",
    createElement: (tag) => el(tag), getElementById: (id) => registry[id] || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  };
  const main = el("main"); main.id = "ups-m-main"; main._scan = true; registry["ups-m-main"] = main;
  for (const id of ["ups-m-header-title", "ups-m-header-meta", "ups-m-toast", "ups-m-ptr"]) { const x = el("div"); x.id = id; registry[id] = x; }
  document.body.appendChild(main);
  return { document, registry, el, main };
}

// ---------------------------------------------------------------- stub worker
// failure rules: { path, type?, method?, mode } where mode is "500" | "503" | "401" | "403" | "404" | "network" | "abort"
function ruleMatches(r, u, init) {
  if (r.path && u.pathname !== r.path) return false;
  if (r.type && u.searchParams.get("TYPE") !== r.type) return false;
  if (r.method && String((init && init.method) || "GET").toUpperCase() !== r.method) return false;
  return true;
}

function appAnswer(u) {
  const p = u.pathname, q = u.searchParams;
  const json = (status, body) => ({ status, body });
  switch (p) {
    case "/api/active-season": return json(200, { ok: true, season: "2026", source: "test" });
    case "/api/me": return json(200, { tokA: { configured: true, franchise_id: "0008", franchise_name: "Team Eight" } }[q.get("MFL_USER_ID")] || { configured: false });
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
    case "/api/taxi-callups": return json(200, { ok: true, players: { "123": { used: 1, max: 3 } } });
    case "/api/cap-penalty/preview": return json(200, { ok: true, players: { "123": { penalty: 0 } } });
    case "/api/advanced-stats-leaderboard": return json(200, { rows: [], next_offset: null });
    case "/api/trade-bait-notes": return json(200, { ok: true, notes: [] });
    case "/api/trades/proposals": return json(200, { ok: true, incoming: [], outgoing: [] });
    default: return json(404, { error: "no route" });
  }
}

export function makeWorker() {
  const store = makeMemoryStore();
  // Identity for the real bug-report handler: tokA is team 0008; tokB is team 0005; tokC is the commissioner.
  const detectFranchise = async (token) => ({ tokA: { franchise_id: "0008" }, tokB: { franchise_id: "0005" }, tokC: { franchise_id: "0000" } }[token] || { error: "HTTP 401" });
  async function bugReports(url, init) {
    const request = new Request(url, { method: init && init.method, headers: init && init.headers, body: init && init.body });
    const u = new URL(url);
    const res = await handleBugReportRequest({
      request, url: u, path: u.pathname, env: {}, corsHeaders: {},
      deps: { isEnabled: () => true, detectFranchise, commishFids: () => ["0000"], store: () => store },
      defaultLeagueId: "74598", defaultSeason: "2026",
    });
    return res;
  }
  return { store, bugReports };
}

// ---------------------------------------------------------------- the phone
/**
 * @param o.appSrc     app.js source (default: the real file)
 * @param o.script     true -> load site/m/report_bug.js BEFORE app.js and install({observe:true}) (the preview's order)
 * @param o.scriptSrc  override the report_bug.js source
 * @param o.stored     localStorage at open
 * @param o.hash       route opened
 * @param o.rules      initial fault rules
 */
export async function makePhone(o = {}) {
  const appSrc = o.appSrc != null ? o.appSrc : read("site/m/app.js");
  const dom = makeDom();
  const worker = o.worker || makeWorker();
  const calls = [], stray = [], toasts = [], posts = [], rules = (o.rules || []).slice();
  const clock = { now: T0 };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }
  const store = Object.assign({}, o.stored || {});
  const listeners = {};
  const win = {
    document: dom.document, innerWidth: 375, innerHeight: 812, scrollY: 0, confirm: () => true,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { onLine: true },
    location: { search: o.search || "", hash: o.hash || "", href: PAGES_ORIGIN + "/upsmflproduction/m/index.html" + (o.hash || "") },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; },
    URL, URLSearchParams, Response, Request, Promise, Date: FakeDate, console, AbortController,
    Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, x) { this.type = type; this.detail = x && x.detail; } },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; }, clearTimeout,
  };
  win.window = win; win.self = win; win.globalThis = win;
  win.crypto = { randomUUID: () => "00000000-0000-4000-8000-" + String(++win.__uuid).padStart(12, "0") }; win.__uuid = 0;
  // Toasts: remember every text the app wrote to the toast element.
  dom.registry["ups-m-toast"]._onText = (t) => toasts.push(t);

  const baseFetch = async function (input, init) {
    const url = new URL(typeof input === "string" ? input : String(input && input.url ? input.url : input), PAGES_ORIGIN + "/upsmflproduction/m/");
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const entry = { method, host: url.origin, path: url.pathname, query: url.search };
    calls.push(entry);
    if (method === "POST" && init && typeof init.body === "string") posts.push({ path: url.pathname, query: url.search, body: init.body });
    if (url.origin !== WORKER_ORIGIN && url.origin !== PAGES_ORIGIN) { stray.push(entry); throw new TypeError("blocked: not the stub worker"); }
    const rule = rules.find((r) => ruleMatches(r, url, init));
    if (rule) {
      entry.fault = rule.mode;
      if (rule.mode === "hold") return new Promise((resolve, reject) => { (rule.pending = rule.pending || []).push({ resolve, reject }); });
      if (rule.mode === "network") throw new TypeError(rule.message || "Failed to fetch");
      if (rule.mode === "abort") { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }
      return new Response(JSON.stringify({ ok: false, error: "induced " + rule.mode }), { status: Number(rule.mode), headers: { "content-type": "application/json" } });
    }
    if (url.origin === WORKER_ORIGIN && url.pathname.startsWith("/api/bug-reports")) return worker.bugReports(url.href, init);
    // Static Pages data files the app reads (site/ccc, site/rookies, site/rosters, site/reports): present and empty.
    if (url.origin === PAGES_ORIGIN) return new Response(url.pathname.endsWith(".json") ? JSON.stringify({ rows: [] }) : "{}", { status: url.pathname.endsWith(".json") ? 200 : 404, headers: { "content-type": "application/json" } });
    const a = appAnswer(url);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  win.fetch = baseFetch;
  win.__origFetch = baseFetch;

  const ctx = vm.createContext(win);
  if (o.script === true) {
    vm.runInContext(o.scriptSrc != null ? o.scriptSrc : read("site/m/report_bug.js"), ctx);
    win.UPSReportBug.install({ build: "test", observe: true });
  }
  vm.runInContext(read("site/shared/taxi_rule.js"), ctx);
  vm.runInContext(appSrc, ctx);
  const M = win.UPS_MOBILE;
  const seen = [];
  STUB_VIEWS.forEach((name) => M.route.registerView(name, (main, parts) => {
    seen.push(name + (parts && parts.length ? "/" + parts.join("/") : ""));
    if (o.viewThrows && o.viewThrows === name) throw new TypeError("view exploded");
    main.innerHTML = "VIEW:" + name + (parts && parts.length ? "/" + parts.join("/") : "");
  }));
  M.boot();
  await settle();
  if (o.script === "late") {   // the WRONG order: the sheet script after the app has booted
    vm.runInContext(read("site/m/report_bug.js"), ctx);
    win.UPSReportBug.install({ build: "test", observe: true });
  }

  const p = {
    win, M, dom, worker, rules, calls, stray, toasts, posts, seen, clock, store,
    R: () => win.UPSReportBug,
    main: () => dom.main.innerHTML,
    loadErrors: () => (M.state.loadErrors || []).slice(),
    workerCalls: () => calls.filter((c) => c.host === WORKER_ORIGIN),
    go: async (hash) => {
      win.location.hash = hash; win.location.href = PAGES_ORIGIN + "/upsmflproduction/m/index.html" + hash;
      win.dispatchEvent({ type: "hashchange" });
      M.route.renderRoute();
      await settle();
    },
    fail: (rule) => { rules.push(rule); return rule; },
    // Finish a held request: the rule is removed first, so anything the app retries afterwards succeeds.
    release: (rule, mode) => {
      const i = rules.indexOf(rule); if (i >= 0) rules.splice(i, 1);
      (rule.pending || []).splice(0).forEach(({ resolve, reject }) => {
        if (mode === "network") reject(new TypeError("Failed to fetch"));
        else resolve(new Response(JSON.stringify({ ok: false }), { status: Number(mode), headers: { "content-type": "application/json" } }));
      });
    },
    clearFaults: () => { rules.length = 0; },
    chip: () => dom.document.body._kids.find((k) => k.className === "ups-rb-chip") || null,
    tapChip: (which) => { const c = p.chip(); if (!c) throw new Error("no chip"); c.dispatch("click", { target: { closest: () => ({ getAttribute: () => which }) } }); },
    tapMore: () => { const b = dom.registry["ups-m-report-bug"]; if (!b) throw new Error("no Report a problem row"); b.click(); },
    sheet: () => { const back = dom.document.body._kids.filter((k) => k.className === "ups-rb-back").pop(); return back ? back._kids[0] : null; },
    type: (id, value) => { const s = p.sheet(); s.dispatch("input", { target: { id, value } }); },
    choose: (i) => { p.sheet().dispatch("change", { target: { id: "ups-rb-pick", value: String(i) } }); },
    press: (act) => { p.sheet().dispatch("click", { target: { closest: () => ({ getAttribute: () => act, disabled: false }) } }); },
  };
  return p;
}
