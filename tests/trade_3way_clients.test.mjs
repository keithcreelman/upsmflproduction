// 3-way trade CLIENTS: the shared view module, the REAL mobile view (site/m/views/trade.js)
// and the REAL desktop War Room 3-way block (site/trades/trade_workbench.js), each run in
// Node against a fake DOM with fetch() bridged to the real worker handler + real SQLite.
//   node tests/trade_3way_clients.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeEnv, seedTrade, readRow, installDiscordRecorder, quietConsole, TRADE_ID, PLAYERS } from "./fixtures/trade_3way_fixture.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";
const { makeBridge } = await import("./fixtures/http_bridge.mjs");

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const LEAGUE_SRC = fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8");
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const DESK_HTML = fs.readFileSync(new URL("../site/trades/trade_workbench.html", import.meta.url), "utf8");
const LOADER_SRC = fs.readFileSync(new URL("../site/trades/mfl_hpm_embed_loader.js", import.meta.url), "utf8");
const MOBILE_HTML = fs.readFileSync(new URL("../site/m/index.html", import.meta.url), "utf8");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const fresh = (over) => { const env = makeEnv(); seedTrade(env, over); discord.reset(); return env; };

// ══════════════════════ harness: the REAL mobile view ══════════════════════
function loadMobile(env, { token = "tok-A", fid = "0008", offline = false, override } = {}) {
  const bridge = makeBridge(env, { offline, override });
  const toasts = [];
  const mount = makeEl("ups-m-main");
  let parts = [];
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: {},
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: fid, franchises: [], tradeOffers: { incoming: [], outgoing: [] } },
    ui: { showToast: (m, tone) => toasts.push([m, tone]) },
    route: {
      renderRoute: () => M.tradeView.render(mount, parts),
      navigate: (hash) => { const m = /#league\/trade\/3w\/(.+)$/.exec(hash); parts = m ? ["3w", decodeURIComponent(m[1])] : []; M.route.renderRoute(); },
    },
  };
  const sandbox = { fetch: bridge.fetch, console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document: { getElementById: () => null, body: { style: {} } } };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.UPS_TRADE_3WAY = T;
  sandbox.confirm = () => { throw new Error("window.confirm must not gate 3-way actions"); };
  vm.createContext(sandbox);
  vm.runInContext(MOBILE_SRC, sandbox, { filename: "site/m/views/trade.js" });
  return { M, mount, toasts, calls: bridge.calls, go: async (hash) => { M.route.navigate(hash); await settle(); }, list: async () => { parts = []; M.route.renderRoute(); await settle(); } };
}

// ══════════════════════ harness: the REAL desktop 3-way block ══════════════════════
function loadDesktop(env, { token = "tok-A", fid = "0008", offline = false, override } = {}) {
  const bridge = makeBridge(env, { offline, override });
  const start = DESK_SRC.indexOf("  // ════════════ 3-WAY TRADES: outbox list + canonical detail + cancel ════════════");
  const end = DESK_SRC.indexOf("  function init3WayTrade() {");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the desktop 3-way block in trade_workbench.js");
  const code = DESK_SRC.slice(start, end);
  const registry = {};
  const get = (id) => (registry[id] = registry[id] || makeEl(id));
  const chrome = { main: makeEl("main"), toolbar: makeEl("toolbar") };
  const document = { getElementById: get, querySelector: (s) => (s === ".twb-main" ? chrome.main : s === ".twb-toolbar" ? chrome.toolbar : (/#twb3wDetailBody/.test(s) ? get("twb3wDetailBody") : null)) };
  const urlHistory = [];
  const win = { UPS_TRADE_3WAY: T, location: { href: "https://trade.test/trade_workbench.html?embed=1" }, history: { replaceState: (a, b, u) => urlHistory.push(u) }, scrollTo() {} };
  const els = { tw3List: get("twb3wList"), tw3Count: get("twb3wCount") };
  const resolve3WayApiUrl = () => `https://worker.test/api/trades/3way?MFL_USER_ID=${token}&L=74598&YEAR=2026`;
  const factory = new Function("window", "document", "fetch", "els", "getActiveFranchiseId", "resolve3WayApiUrl", "tw3Reflow",
    code + "\nreturn { twx, open3WayDetail, close3WayDetail, refresh3WayList, doCancel3Way };");
  const api = factory(win, document, bridge.fetch, els, () => fid, resolve3WayApiUrl, () => {});
  return { api, els, detail: () => get("twb3wDetailBody"), panel: () => get("twb3wDetailPanel"), chrome, urlHistory, calls: bridge.calls };
}

const plain = (h) => String(h).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sideOf = (html, fid) => { const i = html.indexOf(`data-t3w-fid="${fid}"`); if (i < 0) return ""; const j = html.indexOf('data-t3w-fid="', i + 10); return html.slice(i, j < 0 ? html.length : j); };
const colsOf = (sideHtml) => { const r = sideHtml.indexOf("<h5>Receives</h5>"); return { sends: sideHtml.slice(0, r), receives: sideHtml.slice(r) }; };
const sectionOf = (html) => { const i = html.indexOf('<section class="t3w"'); return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i) + 10); };

// ═════════════════════════════ shared module: response handling ═════════════════════════════
test("SHARED: a failed request is never reported as 'no trades'", () => {
  for (const res of [{ networkError: true }, { status: 500, ok: false, body: null }, { status: 401, ok: false, body: { code: "unauthenticated" } }, { status: 403, ok: false, body: {} }, { status: 503, ok: false, body: { code: "unavailable" } }, { status: 200, ok: true, body: { ok: false } }]) {
    const out = T.interpretList(res);
    t.notEqual(out.kind, "ok");
    t.equal(out.trades, undefined);
  }
  t.equal(T.interpretList({ status: 200, ok: true, body: { ok: true, trades: [] } }).kind, "ok");
});

test("SHARED: each failure has its own kind and an actionable message", () => {
  const kinds = { network: { networkError: true }, unauthenticated: { status: 401, ok: false, body: { code: "unauthenticated" } }, forbidden: { status: 403, ok: false, body: {} }, not_found: { status: 404, ok: false, body: {} }, unavailable: { status: 503, ok: false, body: {} }, error: { status: 418, ok: false, body: {} } };
  const seen = new Set();
  for (const [kind, res] of Object.entries(kinds)) {
    const out = T.interpretLoad(res);
    t.equal(out.kind, kind);
    t.ok(out.message.length > 10);
    t.doesNotMatch(out.message, /undefined|\[object|stack|D1_/);
    seen.add(out.message);
  }
  t.equal(seen.size, 6);
  t.equal(T.interpretLoad({ networkError: true }).retryable, true);
  t.equal(T.interpretLoad({ status: 403, ok: false, body: {} }).retryable, false);
  t.equal(T.interpretLoad({ status: 401, ok: false, body: { code: "session_expired", error: "Your MFL sign-in expired. Re-open this from MFL and try again." } }).kind, "unauthenticated");
});

test("SHARED: a 200 without a trade is a contract violation, never 'loaded'", () => {
  t.equal(T.interpretLoad({ status: 200, ok: true, body: { ok: true } }).kind, "error");
  t.equal(T.interpretLoad({ status: 200, ok: true, body: { ok: true, trade: {} } }).kind, "error");
});

test("SHARED: only a server-CONFIRMED cancellation is 'applied'; every failure leaves the UI unchanged", () => {
  const cancelled = { id: "x", status: "cancelled" };
  t.equal(T.interpretCancel({ status: 200, ok: true, body: { ok: true, code: "cancelled", trade: cancelled } }).applied, true);
  const again = T.interpretCancel({ status: 200, ok: true, body: { ok: true, already: true, trade: cancelled } });
  t.equal(again.applied, true); t.equal(again.kind, "already");
  const failures = [
    { networkError: true }, { status: 400, ok: false, body: { error: "bad" } }, { status: 401, ok: false, body: {} }, { status: 403, ok: false, body: { code: "only_initiator_can_cancel", error: "Only the initiator" } },
    { status: 404, ok: false, body: {} }, { status: 409, ok: false, body: { code: "cannot_cancel_executing", error: "processing", trade: { id: "x", status: "executing" } } }, { status: 500, ok: false, body: null },
    { status: 200, ok: true, body: { ok: true } },                                          // success with no confirming trade
    { status: 200, ok: true, body: { ok: true, trade: { id: "x", status: "collecting" } } }, // says ok but trade is NOT cancelled
    { status: 200, ok: false, body: { ok: false } },
  ];
  for (const res of failures) t.equal(T.interpretCancel(res).applied, false);
  t.equal(T.interpretCancel(failures[5]).trade.status, "executing");
  t.equal(T.interpretCancel(failures[7]).kind, "unconfirmed");
});

test("SHARED: internal error text never reaches the screen (5xx, proxy pages, the global guard)", () => {
  const leaky = [
    { status: 500, ok: false, body: { ok: false, error: "D1_ERROR: no such table ups_3way_trades at offset 27" } },
    { status: 500, ok: false, body: { ok: false, code: "server_error", error: "TypeError: cannot read properties of undefined" } },
    { status: 502, ok: false, body: { error: "upstream connect error" } },
    { status: 400, ok: false, body: { ok: false, isAdmin: false, reason: "Missing L param" } },
    { status: 503, ok: false, body: { code: "unavailable", error: "SQLITE_BUSY internal" } },
  ];
  for (const res of leaky) {
    for (const out of [T.interpretLoad(res), T.interpretList(res), T.interpretCancel(res)]) {
      t.doesNotMatch(out.message, /D1_ERROR|TypeError|upstream|SQLITE|Missing L|no such table/);
      t.ok(out.message.length > 10);
    }
  }
  t.equal(T.interpretCancel({ status: 403, ok: false, body: { code: "only_initiator_can_cancel", error: "Only the team that started this 3-way can call it off." } }).message, "Only the team that started this 3-way can call it off.");
});

test("RENDER: a closed trade says 'No response', never 'Waiting', for a partner who never answered", async () => {
  const cancelled = await canonical("tok-A", { status: "cancelled", failure_reason: "cancelled_by_initiator" });
  const html = T.renderDetail(cancelled);
  t.match(html, /No response/); t.doesNotMatch(html, />Waiting</);
  const open = T.renderDetail(await canonical("tok-A"));
  t.match(open, />Waiting</); t.doesNotMatch(open, /No response/);
  const declined = await canonical("tok-A", { status: "cancelled", failure_reason: "declined_by_0001", team_b_state: "declined" });
  t.match(T.renderDetail(declined), />Declined</);
});

test("RENDER: revealConfirm scrolls the confirmation into view and focuses the safe option", () => {
  const calls = [];
  const root = { querySelector: (s) => (s === ".t3w-confirm" ? { scrollIntoView: (o) => calls.push(["scroll", o.block]) } : s === '[data-t3w-act="keep"]' ? { focus: (o) => calls.push(["focus", o.preventScroll]) } : null) };
  T.revealConfirm(root);
  t.deepEqual(calls, [["scroll", "center"], ["focus", true]]);
  T.revealConfirm({ querySelector: () => null });
  T.revealConfirm(null);
});

test("SHARED: a stale copy can never override a newer one", () => {
  const v1 = { id: "a", version: "2026-09-23T20:21:41.139Z", status: "collecting" };
  const v2 = { id: "a", version: "2026-09-25T10:00:00.000Z", status: "cancelled" };
  t.equal(T.preferNewer(v2, v1), v2);
  t.equal(T.preferNewer(v1, v2), v2);
  t.equal(T.preferNewer(v2, v2).status, "cancelled");
  t.equal(T.preferNewer(null, v1), v1);
  t.equal(T.preferNewer(v1, null), v1);
  t.equal(T.preferNewer(v2, { id: "b", version: "2000" }).id, "b");
});

// ═════════════════════════════ shared module: rendering ═════════════════════════════
async function canonical(viewerTok = "tok-A", over) {
  const env = fresh(over);
  const b = makeBridge(env);
  const r = await b.fetch(`https://worker.test/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=${viewerTok}`);
  return JSON.parse(await r.text()).trade;
}

test("RENDER: all three franchises are identified and every asset sits under the correct side", async () => {
  const html = T.renderDetail(await canonical());
  for (const n of ["Real Deal Creel", "L.A. Looks", "Hawks"]) t.match(html, new RegExp(n.replace(".", "\\.")));
  const a = colsOf(sideOf(html, "0008")), b = colsOf(sideOf(html, "0001")), c = colsOf(sideOf(html, "0012"));
  for (const x of ["Marvin Harrison Jr.", "Kayshon Boutte", "2027 1st-round pick (via HammerTime)"]) { t.match(a.sends, new RegExp(x.replace(/[().]/g, "\\$&"))); t.match(c.receives, new RegExp(x.replace(/[().]/g, "\\$&"))); }
  t.match(b.sends, /Chase Brown/); t.match(a.receives, /Chase Brown/); t.match(b.sends, /\$16K cap money/); t.match(a.receives, /\$16K cap money/);
  t.match(b.sends, /Dallas Turner/); t.match(c.receives, /Dallas Turner/);
  t.match(c.sends, /2027 1st-round pick/); t.match(b.receives, /2027 1st-round pick/);
  t.doesNotMatch(a.sends, /Chase Brown|Dallas Turner/);
});

test("RENDER: participant order is fixed (initiator, B, C) for every viewer", async () => {
  const orders = [];
  for (const tok of ["tok-A", "tok-B", "tok-C", "tok-commish"]) {
    const html = T.renderDetail(await canonical(tok));
    orders.push([...html.matchAll(/data-t3w-fid="(\d{4})"/g)].map((m) => m[1]).join(","));
  }
  t.deepEqual(orders, ["0008,0001,0012", "0008,0001,0012", "0008,0001,0012", "0008,0001,0012"]);
});

test("RENDER: nothing from the data can inject markup", async () => {
  const tr = await canonical();
  tr.participants[0].name = '<img src=x onerror=alert(1)>';
  tr.sides[0].name = '<script>alert(1)</script>';
  tr.notes = '"><svg onload=alert(1)>';
  tr.movements[0].assets[0].label = "</span><b>x</b>";
  tr.state_view.label = "<u>hi</u>";
  const html = T.renderDetail(tr) + T.renderCard(tr);
  t.doesNotMatch(html, /<img src=x|<script>alert|<svg onload|<b>x<\/b>|<u>hi/);
  t.match(html, /&lt;img src=x onerror=alert\(1\)&gt;|&lt;script&gt;/);
});

test("RENDER: Cancel is offered ONLY when the server granted it; confirmation is a separate step", async () => {
  const owner = await canonical("tok-A"), partner = await canonical("tok-B");
  t.match(T.renderDetail(owner), /data-t3w-act="cancel"/);
  t.doesNotMatch(T.renderDetail(owner), /confirm-cancel|alertdialog/);
  t.doesNotMatch(T.renderDetail(partner), /data-t3w-act="cancel"|confirm-cancel/);
  t.match(plain(T.renderDetail(partner)), /Only the team that started this 3-way can call it off/);
  const confirming = T.renderDetail(owner, { cancel: { confirming: true } });
  t.match(confirming, /role="alertdialog"/); t.match(confirming, /data-t3w-act="keep"/); t.match(confirming, /data-t3w-act="confirm-cancel"/);
  t.doesNotMatch(confirming, /data-t3w-act="cancel"/);
  t.match(T.renderDetail(owner, { cancel: { confirming: true, busy: true } }), /disabled[^>]*>Cancelling…/);
});

test("RENDER: success and failure are announced in distinct live regions; terminal trades have no actions", async () => {
  const owner = await canonical("tok-A");
  t.match(T.renderDetail(owner, { cancel: { success: "3-way called off." } }), /role="status" aria-live="polite">3-way called off\./);
  t.match(T.renderDetail(owner, { cancel: { error: "Nope." } }), /t3w-status-bad" role="alert">Nope\./);
  const done = await canonical("tok-A", { status: "cancelled", failure_reason: "cancelled_by_initiator" });
  t.doesNotMatch(T.renderDetail(done), /data-t3w-act="cancel"|confirm-cancel/);
  t.match(T.renderDetail(done), /t3w-tone-off/);
});

test("RENDER: loading, empty, incomplete-data and error states are all visibly different", async () => {
  const tr = await canonical();
  tr.integrity = { ok: false, issues: ["unknown_asset:X"] };
  t.match(plain(T.renderDetail(tr)), /role="alert"><b>Some of this trade's data is incomplete or unavailable/);
  const net = T.renderProblem(T.interpretLoad({ networkError: true }));
  const nf = T.renderProblem(T.interpretLoad({ status: 404, ok: false, body: {} }));
  t.match(net, /Try again/); t.doesNotMatch(nf, /Try again/);
  t.notEqual(net, nf);
  t.match(net, /role="alert"/);
});

test("RENDER: bind() dispatches to the LATEST handlers on a reused container and ignores disabled buttons", () => {
  const el = makeEl("c"); const hit = [];
  T.bind(el, { cancel: () => hit.push("old-cancel") });
  T.bind(el, { cancel: () => hit.push("new-cancel"), keep: () => hit.push("keep") });
  el.innerHTML = '<button data-t3w-act="cancel">x</button><button data-t3w-act="keep" disabled>y</button>';
  el.click("cancel");
  t.deepEqual(hit, ["new-cancel"]);
  el.click("keep");
  t.deepEqual(hit, ["new-cancel"]);
});

test("RENDER: mobile and desktop share one renderer, one stylesheet and one module file", () => {
  t.match(MOBILE_SRC, /window\.UPS_TRADE_3WAY/); t.match(DESK_SRC, /window\.UPS_TRADE_3WAY/);
  t.match(MOBILE_HTML, /shared\/trade_3way_view\.js\?v=/); t.match(DESK_HTML, /shared\/trade_3way_view\.js\?v=/);
  t.ok(DESK_HTML.indexOf("trade_3way_view.js") < DESK_HTML.indexOf("trade_workbench.js?v="));
  t.ok(MOBILE_HTML.indexOf("trade_3way_view.js") < MOBILE_HTML.indexOf("views/trade.js"));
  for (const src of [MOBILE_SRC, DESK_SRC]) { t.match(src, /T3?\.interpretCancel/); t.match(src, /T3?\.interpretLoad/); t.match(src, /T3?\.interpretList/); t.match(src, /T3?\.preferNewer/); }
});

// ═════════════════════════════ the REAL mobile view, end to end ═════════════════════════════
test("MOBILE: the stuck offer appears in the list with all three teams and a Cancel for the initiator", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.list();
  t.match(m.mount.innerHTML, /3-Way Trades · 1/);
  for (const n of ["Real Deal Creel", "L.A. Looks", "Hawks"]) t.match(m.mount.innerHTML, new RegExp(n.replace(".", "\\.")));
  t.ok(m.mount.has("open")); t.ok(m.mount.has("open-cancel"));
  const req = m.calls.find((c) => c.path === "/api/trades/3way");
  t.equal(req.query.L, "74598"); t.equal(req.query.MFL_USER_ID, "tok-A");
});

test("MOBILE: a partner sees the trade but no Cancel button", async () => {
  const env = fresh(); const m = loadMobile(env, { token: "tok-B", fid: "0001" });
  await m.list();
  t.match(m.mount.innerHTML, /3-Way Trades · 1/);
  t.ok(m.mount.has("open")); t.equal(m.mount.has("open-cancel"), false);
});

test("MOBILE: tapping the card LOADS the trade (canonical detail, all three sides)", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.list(); m.mount.click("open"); await settle();
  const html = sectionOf(m.mount.innerHTML);
  t.match(html, /data-t3w-id="54a0306a/);
  t.match(colsOf(sideOf(html, "0012")).receives, /Marvin Harrison Jr\./);
  t.match(colsOf(sideOf(html, "0008")).receives, /Chase Brown/);
  t.ok(m.mount.has("cancel"));
  t.ok(m.calls.some((c) => c.query.id === TRADE_ID));
});

test("MOBILE: deep link + refresh load the same trade (a brand-new app instance)", async () => {
  const env = fresh();
  const first = loadMobile(env); await first.go("#league/trade/3w/" + TRADE_ID);
  const refreshed = loadMobile(env); await refreshed.go("#league/trade/3w/" + TRADE_ID);
  t.equal(sectionOf(refreshed.mount.innerHTML), sectionOf(first.mount.innerHTML));
  t.ok(sectionOf(first.mount.innerHTML).length > 500);
});

test("MOBILE: cancel = confirmation step, then ONE request with L, no body franchise authority, UI confirmed by the server", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.go("#league/trade/3w/" + TRADE_ID);
  m.mount.click("cancel"); await settle();
  t.ok(m.mount.has("confirm-cancel")); t.ok(m.mount.has("keep"));
  t.equal(m.calls.filter((c) => c.method === "POST").length, 0);
  t.equal(readRow(env).status, "collecting");
  m.mount.click("keep"); await settle();
  t.equal(m.mount.has("confirm-cancel"), false); t.equal(m.calls.filter((c) => c.method === "POST").length, 0);
  m.mount.click("cancel"); await settle(); m.mount.click("confirm-cancel"); await settle(12);
  const posts = m.calls.filter((c) => c.method === "POST");
  t.equal(posts.length, 1);
  t.equal(posts[0].path, "/api/trades/3way/cancel");
  t.equal(posts[0].query.L, "74598"); t.equal(posts[0].query.MFL_USER_ID, "tok-A");
  t.deepEqual(Object.keys(posts[0].body).sort(), ["acting_franchise_id", "id"]);
  t.equal(readRow(env).status, "cancelled");
  t.match(m.mount.innerHTML, /3-way called off\./); t.match(m.mount.innerHTML, /Called off/);
  t.equal(m.mount.has("cancel"), false);
  t.ok(m.toasts.some(([msg, tone]) => /called off/i.test(msg) && tone === "ok"));
  t.equal(discord.messages().length, 2);
});

test("MOBILE: after a cancel, back navigation and a refresh both show it cancelled — never resurrected", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.go("#league/trade/3w/" + TRADE_ID); m.mount.click("cancel"); await settle(); m.mount.click("confirm-cancel"); await settle(12);
  const before = m.calls.length;
  await m.go("#league/trade");
  t.ok(m.calls.length > before);
  t.doesNotMatch(m.mount.innerHTML, /3-Way Trades · 1/);
  await m.go("#league/trade/3w/" + TRADE_ID);
  t.match(m.mount.innerHTML, /Called off/); t.equal(m.mount.has("cancel"), false);
  const refreshed = loadMobile(env); await refreshed.go("#league/trade/3w/" + TRADE_ID);
  t.match(refreshed.mount.innerHTML, /Called off/);
});

test("MOBILE: a FAILED cancel (network down) never shows 'cancelled' and keeps Cancel available", async () => {
  const env = fresh();
  let down = false;
  const m = loadMobile(env, { override: (method) => { if (down && method === "POST") throw new TypeError("Failed to fetch"); return null; } });
  await m.go("#league/trade/3w/" + TRADE_ID); m.mount.click("cancel"); await settle();
  down = true; m.mount.click("confirm-cancel"); await settle(12);
  t.equal(readRow(env).status, "collecting");
  t.doesNotMatch(m.mount.innerHTML, /3-way called off|Called off/);
  t.match(plain(m.mount.innerHTML), /Can't reach the server/);
  t.ok(m.mount.has("cancel"));
  t.ok(m.toasts.some(([, tone]) => tone === "err"));
  down = false; m.mount.click("cancel"); await settle(); m.mount.click("confirm-cancel"); await settle(12);
  t.equal(readRow(env).status, "cancelled");
});

test("MOBILE: if the trade moved on before the confirm, the UI shows the server's truth, not 'cancelled'", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.go("#league/trade/3w/" + TRADE_ID); m.mount.click("cancel"); await settle();
  env.UPS_MFL_DB.raw.exec("UPDATE ups_3way_trades SET status='executing', updated_at_utc='2026-09-25T12:00:00.000Z'");
  m.mount.click("confirm-cancel"); await settle(12);
  t.equal(readRow(env).status, "executing");
  t.match(m.mount.innerHTML, /Processing/); t.match(m.mount.innerHTML, /being processed/);
  t.doesNotMatch(m.mount.innerHTML, /3-way called off/);
  t.equal(m.mount.has("cancel"), false);
});

test("MOBILE: signed-out or forbidden is a clear message, never 'no 3-way trades' or a blank screen", async () => {
  const env = fresh();
  const out = loadMobile(env, { token: "" });
  await out.list();
  t.match(plain(out.mount.innerHTML), /Couldn't load your 3-way trades/); t.match(out.mount.innerHTML, /Sign in to MFL/);
  t.doesNotMatch(out.mount.innerHTML, /3-Way Trades · \d/);
  const other = loadMobile(env, { token: "tok-O", fid: "0003" });
  await other.go("#league/trade/3w/" + TRADE_ID);
  t.match(plain(other.mount.innerHTML), /aren't part of this trade/); t.doesNotMatch(other.mount.innerHTML, /Loading trade/);
  const missing = loadMobile(env); await missing.go("#league/trade/3w/00000000-0000-0000-0000-000000000000");
  t.match(plain(missing.mount.innerHTML), /doesn't exist/); t.doesNotMatch(missing.mount.innerHTML, /Loading trade/);
  const netdown = loadMobile(env, { offline: true }); await netdown.go("#league/trade/3w/" + TRADE_ID);
  t.match(netdown.mount.innerHTML, /Try again/);
});

test("MOBILE: stale local state never overrides the server — reopening always shows the server's current truth", async () => {
  const env = fresh(); const m = loadMobile(env);
  await m.go("#league/trade/3w/" + TRADE_ID); m.mount.click("cancel"); await settle(); m.mount.click("confirm-cancel"); await settle(12);
  t.match(m.mount.innerHTML, /Called off/);
  // The server state is restored/edited to an OLDER, open state; the client's cached copy is newer.
  env.UPS_MFL_DB.raw.exec("UPDATE ups_3way_trades SET status='collecting', failure_reason=NULL, updated_at_utc='2026-09-23T20:21:41.139Z'");
  await m.go("#league/trade"); await m.go("#league/trade/3w/" + TRADE_ID);
  t.match(m.mount.innerHTML, /Waiting on/); t.doesNotMatch(m.mount.innerHTML, /Called off/);
  t.ok(m.mount.has("cancel"));
});

test("MOBILE: a cached pre-fix client's exact cancel request now works against the server", async () => {
  const env = fresh(); const b = makeBridge(env);
  const r = await b.fetch("https://worker.test/api/trades/3way/cancel?MFL_USER_ID=tok-A", { method: "POST", body: JSON.stringify({ id: TRADE_ID, franchise_id: "0008", league_id: "74598" }) });
  t.equal(r.status, 200);
  t.equal(readRow(env).status, "cancelled");
});

test("MOBILE: routing passes the sub-route to the trade view; the 2-way verbs are unchanged, and Accept now goes through the cap/roster REVIEW (tests/trade_cap_clients)", () => {
  t.match(LEAGUE_SRC, /M\.tradeView\.render\(mount, subParts\.slice\(1\)\)/);
  t.match(MOBILE_SRC, /\/api\/trades\/proposals\/action/);
  t.match(MOBILE_SRC, /if \(action === "cancel"\) return "revoke"/);
  t.match(MOBILE_SRC, /if \(action === "accept"\) \{ openAcceptReview\(tradeId\); return; \}/);
  t.match(MOBILE_SRC, /if \(!window\.confirm\("Cancel this outgoing offer\?"\)\) return;\s*runTradeAction\(action, tradeId, ""\)/);
  t.doesNotMatch(MOBILE_SRC, /Call off this 3-way trade\? The other two teams will be told/);
});

// ═════════════════════════════ the REAL desktop block, end to end ═════════════════════════════
test("DESKTOP: the 3-way outbox lists the stuck trade with a count, all teams, Details and Cancel", async () => {
  const env = fresh(); const d = loadDesktop(env);
  await d.api.refresh3WayList(); await settle();
  t.equal(d.els.tw3Count.textContent, "1");
  for (const n of ["Real Deal Creel", "L.A. Looks", "Hawks"]) t.match(d.els.tw3List.innerHTML, new RegExp(n.replace(".", "\\.")));
  t.ok(d.els.tw3List.has("open")); t.ok(d.els.tw3List.has("open-cancel"));
  const req = d.calls.find((c) => c.path === "/api/trades/3way");
  t.equal(req.query.L, "74598"); t.equal(req.query.franchise_id, "0008");
});

test("DESKTOP: opening a 3-way loads the canonical trade into the detail panel and updates the deep-link URL", async () => {
  const env = fresh(); const d = loadDesktop(env);
  await d.api.open3WayDetail(TRADE_ID);
  const html = sectionOf(d.detail().innerHTML);
  t.match(colsOf(sideOf(html, "0012")).receives, /Marvin Harrison Jr\./);
  t.match(colsOf(sideOf(html, "0008")).receives, /Chase Brown/);
  t.equal(d.panel().hidden, false); t.equal(d.chrome.main.style.display, "none");
  t.match(d.urlHistory.at(-1), /twb_3w=54a0306a/);
  t.ok(d.detail().has("cancel"));
});

test("DESKTOP: mobile and desktop render byte-identical trade markup for the same viewer", async () => {
  const env = fresh(); const d = loadDesktop(env); const m = loadMobile(env);
  await d.api.open3WayDetail(TRADE_ID); await m.go("#league/trade/3w/" + TRADE_ID);
  t.equal(sectionOf(d.detail().innerHTML), sectionOf(m.mount.innerHTML));
});

test("DESKTOP: cancel needs a confirmation, sends L and no body franchise authority, and only a server-confirmed result changes the UI", async () => {
  const env = fresh(); const d = loadDesktop(env);
  await d.api.open3WayDetail(TRADE_ID);
  d.detail().click("cancel"); await settle();
  t.ok(d.detail().has("confirm-cancel"));
  t.equal(d.calls.filter((c) => c.method === "POST").length, 0);
  d.detail().click("keep"); await settle();
  t.equal(d.detail().has("confirm-cancel"), false);
  d.detail().click("cancel"); await settle(); d.detail().click("confirm-cancel"); await settle(12);
  const posts = d.calls.filter((c) => c.method === "POST");
  t.equal(posts.length, 1); t.equal(posts[0].path, "/api/trades/3way/cancel"); t.equal(posts[0].query.L, "74598");
  t.deepEqual(Object.keys(posts[0].body).sort(), ["acting_franchise_id", "id"]);
  t.equal(readRow(env).status, "cancelled");
  t.match(d.detail().innerHTML, /3-way called off\./); t.equal(d.detail().has("cancel"), false);
  t.equal(d.els.tw3Count.textContent, "0");
  t.equal(discord.messages().length, 2);
});

test("DESKTOP: a failed cancel never shows 'cancelled'; reopening after a refresh shows the true server state", async () => {
  const env = fresh(); let down = true;
  const d = loadDesktop(env, { override: (method) => { if (down && method === "POST") throw new TypeError("Failed to fetch"); return null; } });
  await d.api.open3WayDetail(TRADE_ID); d.detail().click("cancel"); await settle(); d.detail().click("confirm-cancel"); await settle(12);
  t.doesNotMatch(d.detail().innerHTML, /3-way called off|Called off/);
  t.match(plain(d.detail().innerHTML), /Can't reach the server/); t.ok(d.detail().has("cancel"));
  t.equal(readRow(env).status, "collecting");
  down = false; env.UPS_MFL_DB.raw.exec("UPDATE ups_3way_trades SET status='cancelled', failure_reason='declined_by_0001', updated_at_utc='2026-09-25T12:00:00.000Z'");
  await d.api.open3WayDetail(TRADE_ID);
  t.match(d.detail().innerHTML, /Declined by L\.A\. Looks/); t.equal(d.detail().has("cancel"), false);
});

test("DESKTOP: signed-out and not-found are explicit messages; the list never claims 'no trades' on failure", async () => {
  const env = fresh();
  const out = loadDesktop(env, { token: "" });
  await out.api.refresh3WayList();
  t.match(plain(out.els.tw3List.innerHTML), /Couldn't load your 3-way trades/); t.doesNotMatch(out.els.tw3List.innerHTML, /No active 3-way trades/);
  // Regression 2026-09-28: the badge must say it doesn't know, not "0" ("0" means
  // the worker confirmed zero) — same rule as the offered/received badges.
  t.equal(out.els.tw3Count.textContent, "–");
  const nf = loadDesktop(env); await nf.api.open3WayDetail("00000000-0000-0000-0000-000000000000");
  t.match(plain(nf.detail().innerHTML), /doesn't exist/); t.doesNotMatch(nf.detail().innerHTML, /Loading trade/);
  const partner = loadDesktop(env, { token: "tok-B", fid: "0001" }); await partner.api.open3WayDetail(TRADE_ID);
  t.equal(partner.detail().has("cancel"), false); t.match(plain(partner.detail().innerHTML), /Only the team that started this 3-way/);
});

test("DESKTOP: a slow OLDER response can never overwrite a newer open of the same trade", async () => {
  const env = fresh();
  const realFetch = makeBridge(env).fetch;
  const staleText = await (await realFetch(`https://worker.test/api/trades/3way?id=${TRADE_ID}&MFL_USER_ID=tok-A`)).text();
  let release; const gate = new Promise((r) => { release = r; });
  let first = true;
  const d = loadDesktop(env, { override: (method, url) => {
    if (method === "GET" && url.searchParams.get("id") === TRADE_ID && first) { first = false; return gate.then(() => ({ ok: true, status: 200, text: async () => staleText })); }
    return null;
  } });
  const slow = d.api.open3WayDetail(TRADE_ID);                    // GET #1 is held back
  env.UPS_MFL_DB.raw.exec("UPDATE ups_3way_trades SET status='cancelled', failure_reason='cancelled_by_initiator', updated_at_utc='2026-09-25T12:00:00.000Z'");
  await d.api.open3WayDetail(TRADE_ID);                           // GET #2 sees the cancel
  t.match(d.detail().innerHTML, /Called off/);
  release(); await slow; await settle();                          // the stale (collecting) response finally lands
  t.match(d.detail().innerHTML, /Called off/);
  t.doesNotMatch(d.detail().innerHTML, /Waiting on/);
  t.equal(d.detail().has("cancel"), false);
});

test("DESKTOP: closing the detail restores the board and clears the deep link", async () => {
  const env = fresh(); const d = loadDesktop(env);
  await d.api.open3WayDetail(TRADE_ID); d.api.close3WayDetail(); await settle();
  t.equal(d.panel().hidden, true); t.equal(d.chrome.main.style.display, "");
  t.doesNotMatch(d.urlHistory.at(-1), /twb_3w/);
});

test("DESKTOP: a 3-way id in ?twb_load_offer is routed to the 3-way loader, not looked up as an MFL offer; the 2-way path is intact", () => {
  t.match(DESK_SRC, /if \(\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i\.test\(loadKey\)\) \{\s*await open3WayDetail\(loadKey\);\s*return;/);
  t.match(DESK_SRC, /var out = await fetchOfferById\(loadKey\);/);
  t.match(DESK_SRC, /Offer no longer available in MFL\./);
  t.match(DESK_SRC, /createOfferActionButton\("offer-revoke", "Revoke"/);
  t.match(LOADER_SRC, /"twb_3w",/);
  t.match(DESK_HTML, /id="twb3wDetailPanel"/); t.match(DESK_HTML, /id="twb3wDropdown"/); t.match(DESK_HTML, /id="twb3wList"/);
  t.match(DESK_SRC, /refresh3WayList\(\);   \/\/ 3-way outbox rides the same triggers/);
});

await run("trade_3way_clients");
restoreConsole();
discord.restore();
