// SIGNED-OUT vs TRUE-EMPTY vs FAILED trade inbox, on MOBILE and DESKTOP (Keith 2026-09-25).
//   node tests/trade_inbox_states.test.mjs
//
//   authenticated request that returns an empty list  → "0 offers"            (a true empty inbox)
//   missing / invalid / expired authentication        → "Sign in to view trades" (NOT "0 offers")
//   API / network failure / malformed answer          → an explicit load error with Try again (NOT "0 offers")
//
// The REAL current client code runs against the REAL worker (real SQLite; MFL stubbed at the edge):
//   - mobile: fetchTradeOffers() sliced verbatim out of site/m/app.js + the real site/m/views/trade.js
//   - desktop: the real, whole site/trades/trade_workbench.js
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, workerFetch, quiet } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";

const restore = quiet();
const require = createRequire(import.meta.url);
const SHARED_VIEW = require("../site/shared/trade_3way_view.js");
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const APP_SRC = read("site/m/app.js"), TRADE_SRC = read("site/m/views/trade.js"), DESK_SRC = read("site/trades/trade_workbench.js");
const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";

function world() {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  return { env, mfl, log: [] };
}
// a fetch the client can be given whose worker answers can be overridden per test
function clientFetch(w, override) {
  const real = workerFetch(w.env, w.log);
  return async (u, i) => {
    if (override) { const o = await override(String(u), i); if (o) return o; }
    return real(u, i);
  };
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => (typeof body === "string" ? JSON.parse(body) : body) });

// ═══════════ mobile: fetchTradeOffers, verbatim from app.js ═══════════
function mobileFetchTradeOffers({ token, fetchImpl, ctx }) {
  const start = APP_SRC.indexOf("  function tradeOffersUnavailable(");
  const end = APP_SRC.indexOf("  function loadAllData()");
  if (start < 0 || end < start) throw new Error("could not locate fetchTradeOffers in site/m/app.js");
  const factory = new Function("workerUrl", "state", "getStoredMflUserId", "fetch", APP_SRC.slice(start, end) + "\nreturn { fetchTradeOffers, tradeOffersUnavailable };");
  return factory((p) => WORKER + p, { ctx: ctx || { leagueId: "74598", year: "2026" } }, () => token, fetchImpl).fetchTradeOffers;
}

// ═══════════ mobile: the real trade view ═══════════
function mountEl() {
  const listeners = {};
  const el = {
    innerHTML: "", textContent: "", style: {},
    querySelector(sel) { return /^#/.test(sel) && el.innerHTML.includes(`id="${sel.slice(1)}"`) ? { addEventListener: (_, fn) => { listeners[sel.slice(1)] = fn; } } : null; },
    querySelectorAll: () => [],
    addEventListener() {},                       // the shared 3-way view delegates clicks from the mount
    clickId(id) { if (!listeners[id]) throw new Error(`no #${id} rendered`); listeners[id](); },
  };
  return el;
}
function loadTradeView({ token, fid, tradeOffers, fetchImpl, reloadData }) {
  const toasts = []; const m = mountEl();
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])), fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: reloadData ? { reloadData } : {},
    api: { workerUrl: (p) => WORKER + p, getStoredMflUserId: () => token },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: fid, tradeOffers, franchises: [] },
    ui: { showToast: (msg, tone) => toasts.push([tone, msg]) },
    route: { renderRoute: () => M.tradeView.render(m, []) },
  };
  const sb = { fetch: fetchImpl, console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document: { getElementById: () => null, body: { style: {} } } };
  sb.window = sb; sb.UPS_MOBILE = M; sb.UPS_TRADE_3WAY = SHARED_VIEW;
  vm.createContext(sb); vm.runInContext(TRADE_SRC, sb, { filename: "site/m/views/trade.js" });
  return { M, m, toasts, show: async () => { M.route.renderRoute(); await settle(30); M.route.renderRoute(); await settle(4); } };
}
const has = (m, re) => re.test(m.innerHTML);
const showsZeroOffers = (m) => /Incoming · 0|Outgoing · 0|No incoming offers|No outgoing offers/.test(m.innerHTML);
const signInCard = (m) => /Sign in to view trades/.test(m.innerHTML) && /data-inbox-state="signed_out"/.test(m.innerHTML);
const errorCard = (m) => /Couldn(&#39;|')t load your trades/.test(m.innerHTML) && /data-inbox-state="error"/.test(m.innerHTML) && /ups-m-trade-retry/.test(m.innerHTML);

test("MOBILE: an authenticated request that returns an empty list IS '0 offers' (status ok)", async () => {
  const w = world(); const f = clientFetch(w);
  const offers = await mobileFetchTradeOffers({ token: "tok-B", fetchImpl: f })("0001");
  t.equal(offers.status, "ok"); t.deepEqual(offers.incoming, []); t.deepEqual(offers.outgoing, []);
  const c = loadTradeView({ token: "tok-B", fid: "0001", tradeOffers: offers, fetchImpl: f });
  await c.show();
  t.match(c.m.innerHTML, /Incoming · 0/); t.match(c.m.innerHTML, /Outgoing · 0/);
  t.equal(signInCard(c.m), false); t.equal(errorCard(c.m), false);
});

test("MOBILE: no session at all → 'Sign in to view trades' — no request is even made, and it is never '0 offers'", async () => {
  const w = world(); const f = clientFetch(w);
  const offers = await mobileFetchTradeOffers({ token: "", fetchImpl: f })("0001");
  t.equal(offers.status, "signed_out"); t.equal(w.log.length, 0);
  const c = loadTradeView({ token: "", fid: "0001", tradeOffers: offers, fetchImpl: f });
  await c.show();
  t.ok(signInCard(c.m)); t.equal(showsZeroOffers(c.m), false); t.doesNotMatch(c.m.innerHTML, /Build offer|Build 3-way/);
});

test("MOBILE: an invalid / expired session (worker 401) → 'Sign in to view trades', not '0 offers'", async () => {
  const w = world(); const f = clientFetch(w);
  const offers = await mobileFetchTradeOffers({ token: "tok-expired", fetchImpl: f })("0001");
  t.equal(w.log[0].status, 401); t.equal(offers.status, "signed_out");
  const c = loadTradeView({ token: "tok-expired", fid: "0001", tradeOffers: offers, fetchImpl: f });
  await c.show();
  t.ok(signInCard(c.m)); t.equal(showsZeroOffers(c.m), false);
});

test("MOBILE: a signed-in user whose session is for a DIFFERENT league (403) is also 'sign in', not empty", async () => {
  const w = world(); const f = clientFetch(w);
  const offers = await mobileFetchTradeOffers({ token: "tok-x", fetchImpl: f })("0001");
  t.equal(offers.status, "signed_out");
});

test("MOBILE: an ok:false body naming the missing owner session is 'sign in'; any other ok:false is a load error", async () => {
  const w = world();
  const a = await mobileFetchTradeOffers({ token: "tok-B", fetchImpl: clientFetch(w, async () => resp(200, { ok: false, reason: "missing_owner_session_mfl_user_id" })) })("0001");
  t.equal(a.status, "signed_out");
  const b = await mobileFetchTradeOffers({ token: "tok-B", fetchImpl: clientFetch(w, async () => resp(200, { ok: false, error: "boom" })) })("0001");
  t.equal(b.status, "error");
});

test("MOBILE: a worker 5xx / network failure / malformed answer → an explicit load error with Try again — never '0 offers'", async () => {
  const w = world();
  for (const [name, override] of [
    ["500", async () => resp(500, "<html>upstream error</html>")],
    ["502 json", async () => resp(502, { ok: false })],
    ["network down", async () => { throw new TypeError("Failed to fetch"); }],
    ["empty object", async () => resp(200, {})],
    ["ok but no lists", async () => resp(200, { ok: true })],
    ["lists not arrays", async () => resp(200, { incoming: null, outgoing: "x" })],
    ["not json", async () => resp(200, "definitely not json")],
  ]) {
    const f = clientFetch(w, override);
    const offers = await mobileFetchTradeOffers({ token: "tok-B", fetchImpl: f })("0001");
    t.equal(offers.status, "error", name); t.ok(offers.error, name);
    const c = loadTradeView({ token: "tok-B", fid: "0001", tradeOffers: offers, fetchImpl: f });
    await c.show();
    t.ok(errorCard(c.m), name); t.equal(showsZeroOffers(c.m), false, name); t.equal(signInCard(c.m), false, name);
  }
});

test("MOBILE: 'Try again' reloads and then shows the truth (a real empty inbox is then '0 offers')", async () => {
  const w = world(); let down = true;
  const f = clientFetch(w, async (u) => (down && /\/api\/trades\/proposals/.test(u) ? resp(503, { ok: false }) : null));
  const load = mobileFetchTradeOffers({ token: "tok-B", fetchImpl: f });
  const c = loadTradeView({ token: "tok-B", fid: "0001", tradeOffers: await load("0001"), fetchImpl: f,
    reloadData: async () => { down = false; c.M.state.tradeOffers = await load("0001"); } });
  await c.show();
  t.ok(errorCard(c.m));
  c.m.clickId("ups-m-trade-retry"); await settle(30);
  t.match(c.m.innerHTML, /Incoming · 0/); t.equal(errorCard(c.m), false);
});

test("MOBILE: an owner with real offers sees them (ok, non-empty); the states never hide real data", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const f = clientFetch(w);
  const offers = await mobileFetchTradeOffers({ token: "tok-B", fetchImpl: f })("0001");
  t.equal(offers.status, "ok"); t.equal(offers.outgoing.length, 1);
  const c = loadTradeView({ token: "tok-B", fid: "0001", tradeOffers: offers, fetchImpl: f });
  await c.show();
  t.match(c.m.innerHTML, /Outgoing · 1/); t.equal(signInCard(c.m), false);
});

test("MOBILE: the view's own loader (no preloaded copy) reaches the same three states", async () => {
  const w = world();
  for (const [token, fid, override, expect] of [
    ["", "0001", null, "signed_out"], ["tok-expired", "0001", null, "signed_out"], ["tok-B", "0001", async () => resp(500, "x"), "error"], ["tok-B", "", null, "error"],
  ]) {
    const c = loadTradeView({ token, fid, tradeOffers: null, fetchImpl: clientFetch(w, override) });
    await c.show();
    t.equal(showsZeroOffers(c.m), false, `${token || "none"}/${fid || "nofid"}`);
    t.ok(expect === "signed_out" ? signInCard(c.m) : errorCard(c.m), `${token || "none"}/${fid || "nofid"}`);
  }
  const ok = loadTradeView({ token: "tok-B", fid: "0001", tradeOffers: null, fetchImpl: clientFetch(w) });
  await ok.show(); t.match(ok.m.innerHTML, /Incoming · 0/);
});

// ═══════════ desktop: the real, whole War Room ═══════════
function simpleEl() {
  const target = { children: [], attrs: {}, textContent: "", style: {}, disabled: false, hidden: false, className: "", classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { target.children.push(c); return c; }, setAttribute(k, v) { target.attrs[k] = v; }, getAttribute: (k) => (k in target.attrs ? target.attrs[k] : null),
    addEventListener(ev, fn) { (target.__l = target.__l || {})[ev] = fn; }, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    set innerHTML(v) { target.__h = v; if (v === "") target.children.length = 0; }, get innerHTML() { return target.__h || ""; } };
  const dummy = () => new Proxy(function () {}, { get: (_, k) => (k === "length" ? 0 : k === "style" ? {} : k === "value" ? "" : k === Symbol.toPrimitive ? () => "" : dummy()), apply: () => dummy(), set: () => true });
  return new Proxy(target, { get: (o, k) => (k in o ? o[k] : dummy()), set: (o, k, v) => { o[k] = v; return true; } });
}
async function bootDesktop(w, { token, fid, override }) {
  const loc = new URL(`https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html?embed=1&L=74598&YEAR=2026&FRANCHISE_ID=${fid}${token ? "&MFL_USER_ID=" + token : ""}&api=` + encodeURIComponent(WORKER + "/trade-workbench"));
  const base = clientFetch(w, override);
  const fetchImpl = async (u, i) => (new URL(String(u)).hostname === "keithcreelman.github.io" ? resp(404, "") : base(u, i));
  const els = {};
  const getEl = (id) => (els[id] = els[id] || simpleEl());
  const doc = { readyState: "complete", cookie: "", getElementById: getEl, querySelector: () => simpleEl(), querySelectorAll: () => [], createElement: () => simpleEl(), addEventListener() {}, body: simpleEl(), documentElement: simpleEl(), head: simpleEl() };
  const win = { location: { href: loc.href, search: loc.search, origin: loc.origin, pathname: loc.pathname, hash: "" }, addEventListener() {}, removeEventListener() {}, parent: { postMessage() {} }, postMessage() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, requestAnimationFrame: (f) => setTimeout(f, 0), setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, history: { replaceState() {} }, innerWidth: 1280, scrollTo() {}, UPS_TRADE_3WAY: SHARED_VIEW };
  const sb = { window: win, document: doc, fetch: fetchImpl, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, encodeURIComponent, decodeURIComponent, isFinite, isNaN, parseInt, parseFloat, Map, Set, Symbol, navigator: { clipboard: {} }, requestAnimationFrame: (f) => setTimeout(f, 0), ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} }, Intl, TextEncoder, atob, btoa, structuredClone, localStorage: win.localStorage, sessionStorage: win.sessionStorage, location: win.location, UPS_TRADE_3WAY: SHARED_VIEW };
  win.fetch = fetchImpl; sb.self = win; vm.createContext(sb);
  vm.runInContext(DESK_SRC, sb, { filename: "site/trades/trade_workbench.js" });
  await settle(90);
  const text = (id) => els[id] && els[id].textContent;
  const listText = (id) => (els[id] ? els[id].children.map((c) => `${c.textContent}`).join(" | ") : "");
  return { api: win.upsTradeWorkbench, els, offeredCount: () => text("twbOfferedCount"), receivedCount: () => text("twbReceivedCount"), offeredList: () => listText("twbOfferedList"), offeredKinds: () => (els.twbOfferedList ? els.twbOfferedList.children.map((c) => c.attrs["data-inbox-state"] || c.attrs["data-action"] || "").join(",") : ""), refresh: async () => { await win.upsTradeWorkbench.refreshBannerOffers(true); await settle(30); } };
}

test("DESKTOP: an authenticated owner with an empty inbox → counts 0 and 'No pending trades'", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  t.ok(d.api, "War Room booted");
  t.equal(d.offeredCount(), "0"); t.equal(d.receivedCount(), "0");
  t.match(d.offeredList(), /No pending trades/);
  t.equal(d.api.state.offers.error, "");
});

test("DESKTOP: signed out → 'Sign in to view trades'; the counts show a dash, never 0; not 'No pending trades'", async () => {
  const w = world();
  const d = await bootDesktop(w, { token: "", fid: "0001" });
  t.equal(d.api.state.offers.errorKind, "signed_out");
  t.equal(d.offeredCount(), "–"); t.equal(d.receivedCount(), "–");
  t.match(d.offeredList(), /Sign in to view trades/); t.doesNotMatch(d.offeredList(), /No pending trades/);
  t.equal(d.offeredKinds(), "signed_out");
});

test("DESKTOP: an expired / invalid / wrong-league session (401/403) is 'sign in', not empty", async () => {
  for (const token of ["tok-expired", "tok-x"]) {
    const d = await bootDesktop(world(), { token, fid: "0001" });
    t.equal(d.api.state.offers.errorKind, "signed_out", token);
    t.equal(d.offeredCount(), "–", token); t.doesNotMatch(d.offeredList(), /No pending trades/, token);
  }
});

test("DESKTOP: a worker failure or a malformed answer → an explicit load error with Try again, never 'No pending trades'", async () => {
  for (const [name, override] of [
    ["500", async (u) => (/\/trade-offers/.test(u) ? resp(500, "<html>boom</html>") : null)],
    ["network", async (u) => { if (/\/trade-offers/.test(u)) throw new TypeError("Failed to fetch"); return null; }],
    ["no lists", async (u) => (/\/trade-offers/.test(u) ? resp(200, { ok: true }) : null)],
    ["lists not arrays", async (u) => (/\/trade-offers/.test(u) ? resp(200, { incoming: {}, outgoing: null }) : null)],
  ]) {
    const d = await bootDesktop(world(), { token: "tok-B", fid: "0001", override });
    t.equal(d.api.state.offers.errorKind, "error", name);
    t.equal(d.offeredCount(), "–", name); t.doesNotMatch(d.offeredList(), /No pending trades/, name);
    t.match(d.offeredKinds(), /error,retry-offers/, name);
    t.doesNotMatch(d.offeredList(), /HTTP \d|[{<]|boom|Failed to fetch/i, `${name}: no raw server text reaches the owner`);
  }
});

test("DESKTOP: Try again re-fetches, and a real empty inbox then reads 0 / 'No pending trades'", async () => {
  const w = world(); let down = true;
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u) => (down && /\/trade-offers/.test(u) ? resp(503, { ok: false }) : null) });
  t.equal(d.offeredCount(), "–");
  const retry = d.els.twbOfferedList.children.find((c) => c.attrs["data-action"] === "retry-offers");
  t.ok(retry, "a Try again button is rendered");
  down = false; retry.__l.click(); await settle(60);
  t.equal(d.offeredCount(), "0"); t.match(d.offeredList(), /No pending trades/); t.equal(d.api.state.offers.error, "");
});

test("DESKTOP: an owner with real offers sees the real counts (the states never hide data)", async () => {
  const w = world(); w.mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  t.equal(d.offeredCount(), "1"); t.equal(d.receivedCount(), "0"); t.equal(d.api.state.offers.error, "");
});

await run("trade_inbox_states");
restore();
