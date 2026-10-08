// CAP BLOCK + ROSTER WARNING in the CLIENTS — the shared renderer, the REAL mobile view (site/m/views/trade.js) and the REAL desktop
// War Room accept review (site/trades/trade_workbench.js), each run in Node against a small fake DOM, with fetch() going to the REAL worker
// (real SQLite, MFL stubbed at the edge).
//   node tests/trade_cap_clients.test.mjs
//
// The rules under test (ruling 2026-09-25):
//   • the salary-cap verdict is the SERVER's; a blocked or unverifiable cap can never reach an Accept button, and no ACCEPT is ever posted
//   • the roster warning appears BEFORE the final confirmation and is worded as a heads-up, never a legality ruling
//   • an unavailable roster count is shown as unavailable, never as compliant
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, workerFetch, quiet } from "./fixtures/worker_harness.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const restore = quiet();
const Q = "L=74598&YEAR=2026";

// ───────────────────────────────── server-shaped compliance objects ─────────────────────────────────
const capRow = (fid, name, after, over) => ({ franchise_id: fid, franchise_name: name, used_before: after, used_after: after, cap_dollars: 300000, room_after: 300000 - after, over_by: over || 0 });
const OK = { participants: ["0001", "0002"], cap: { status: "ok", reason: "", cap_dollars: 300000, rows: [capRow("0001", "L.A. Looks", 250000), capRow("0002", "CBP", 280000)], violations: [], message: "Every team stays under the salary cap." },
  roster: { status: "ok", advisory: true, rows: [{ franchise_id: "0001", franchise_name: "L.A. Looks", active_before: 30, active_after: 30, min: 27, max: 35, status: "within" }], warnings: [], message: "Every team stays within its roster limits." } };
const BLOCKED = { ...OK, cap: { status: "blocked", reason: "over_cap", cap_dollars: 300000, rows: [capRow("0001", "L.A. Looks", 310000, 10000), capRow("0002", "CBP", 250000)], violations: [{ franchise_id: "0001", amount_over: 10000 }], message: "L.A. Looks would be $10,000 over the $300,000 salary cap after this trade (projected $310,000)." } };
const UNAVAIL = { participants: [], cap: { status: "unavailable", reason: "x", cap_dollars: null, rows: [], violations: [], message: "We couldn't verify the salary cap for this trade right now." }, roster: { status: "unavailable", advisory: true, rows: [], warnings: [], message: "We couldn't check the roster counts for this trade right now." } };
// Over the roster MAXIMUM is a hard gate since 2026-10-07 (compliance.roster_limit); the 27 minimum stays a heads-up.
const OVER_ROW = { franchise_id: "0002", franchise_name: "CBP", active_before: 35, active_after: 36, active_after_taxi: 36, taxi_moves: [], taxi_not_credited: [], min: 27, max: 35, status: "above_max", moves_needed: 1 };
const WARN = { ...OK, roster: { status: "ok", advisory: true, rows: [OVER_ROW], warnings: [], message: "Every team stays at or above the roster minimum." },
  roster_limit: { status: "blocked", max: 35, rows: [OVER_ROW], executable: false, violations: [{ ...OVER_ROW, message: "CBP would have 36 active players right after this trade — the maximum is 35. CBP needs 1 more roster spot: make 1 legal roster move first (for example, move an eligible injured player to IR), or revise the offer." }],
    message: "CBP would have 36 active players right after this trade — the maximum is 35. CBP needs 1 more roster spot: make 1 legal roster move first (for example, move an eligible injured player to IR), or revise the offer." } };
const MIN_ROW = { franchise_id: "0002", franchise_name: "CBP", active_before: 27, active_after: 26, active_after_taxi: 26, taxi_moves: [], taxi_not_credited: [], min: 27, max: 35, status: "below_min", moves_needed: 0 };
const MINWARN = { ...OK, roster: { status: "warn", advisory: true, rows: [MIN_ROW], warnings: [{ ...MIN_ROW }], message: "CBP would have 26 active players after this trade (minimum 27), so an add may be needed afterward. The minimum is a heads-up, not a block." },
  roster_limit: { status: "ok", max: 35, rows: [MIN_ROW], violations: [], executable: true, message: "Every team stays at or under the roster maximum." } };
const view = (c, res) => T.renderAcceptReview(T.interpretPreview(res || { ok: true, status: 200, body: { ok: true, compliance: c } }));
const has = (h, act) => h.includes(`data-t3w-act="${act}"`);

// ───────────────────────────────── shared renderer ─────────────────────────────────
test("SHARED: cap ok → the Accept button is offered; cap BLOCKED or UNAVAILABLE → it is not, and the teams and amounts are named", () => {
  const ok = view(OK); t.ok(has(ok, "accept-confirm")); t.match(ok, /Salary cap — every team stays under/);
  const bad = view(BLOCKED);
  t.ok(!has(bad, "accept-confirm"), "no Accept button when the cap is blocked"); t.ok(has(bad, "accept-close"));
  t.match(bad, /Over the salary cap — needs acknowledgment/); t.match(bad, /L\.A\. Looks would be \$10,000 over the \$300,000 salary cap/); t.match(bad, /over by \$10,000/);
  const un = view(UNAVAIL);
  t.ok(!has(un, "accept-confirm"), "no Accept button when the cap can't be verified"); t.match(un, /couldn(&#39;|')t verify the salary cap/); t.match(un, /can(&#39;|')t be accepted until we can/);
  t.doesNotMatch(un, /under the salary cap|within limits/i, "unavailable never reads as compliant");
});
test("SHARED: over the roster MAXIMUM can't be accepted (both counts shown, the move named); under the 27 minimum is only a heads-up", () => {
  const h = view(WARN);
  t.ok(!has(h, "accept-confirm"), "an over-maximum roster removes Accept"); t.match(h, /Can't be accepted — roster maximum/); t.match(h, /CBP would have 36 active players right after this trade — the maximum is 35/);
  t.match(h, /35 → 36 active/); t.match(h, /CBP needs 1 more roster spot: make 1 legal roster move first/);
  const m = view(MINWARN);
  t.ok(has(m, "accept-confirm"), "the 27 minimum never blocks"); t.match(m, /Roster counts — heads-up/); t.match(m, /minimum is a heads-up/);
  const un = view({ ...OK, roster: UNAVAIL.roster });
  t.match(un, /Roster counts — couldn't be checked/); t.doesNotMatch(un, /Roster counts — within limits/); t.ok(has(un, "accept-confirm"), "the cap is fine, so accepting is still possible");
});
test("SHARED: preview failures — 503 cap_check_unavailable is retryable and never acceptable; a conflict is a refusal; a network error is retryable", () => {
  const a = T.interpretPreview({ ok: false, status: 503, body: { ok: false, code: "cap_check_unavailable", compliance: UNAVAIL } });
  t.equal(a.canAccept, false); t.equal(a.retryable, true);
  const b = T.interpretPreview({ ok: false, status: 409, body: { ok: false, code: "offer_not_pending", message: "That offer isn't pending anymore." } });
  t.equal(b.kind, "refused"); t.equal(b.canAccept, false); t.match(b.message, /isn't pending/);
  const c = T.interpretPreview({ networkError: true });
  t.equal(c.canAccept, false); t.equal(c.retryable, true); t.doesNotMatch(c.message, /Failed to fetch|undefined/);
  const d = T.interpretPreview({ ok: false, status: 500, body: null });
  t.equal(d.canAccept, false); t.doesNotMatch(d.message, /500|stack|undefined/);
  t.equal(T.interpretPreview({ ok: true, status: 200, body: { ok: true } }).canAccept, false, "a 200 without a verdict is not an approval");
  t.equal(T.interpretPreview({ ok: true, status: 200, body: { ok: true, compliance: BLOCKED } }).canAccept, false);
  t.ok(has(T.renderAcceptReview(null), "accept-confirm") === false, "while loading there is nothing to confirm");
});
test("SHARED: every server string reaches the DOM escaped", () => {
  const evil = { ...BLOCKED, cap: { ...BLOCKED.cap, message: '<img src=x onerror=alert(1)> would be $1 over', rows: [capRow("0001", '<b>x</b>', 310000, 10000)] } };
  const h = view(evil); t.doesNotMatch(h, /<img|<b>x/); t.match(h, /&lt;img/);
});
test("SHARED: a live 3-way's detail carries the same picture (cap + roster) and a terminal one does not", () => {
  const trade = { id: "abcdefgh12", version: "v", state_view: { code: "collecting", label: "Waiting" }, permissions: {}, sides: [], participants: [], compliance: BLOCKED, terminal: false };
  t.match(T.renderDetail(trade), /Over the salary cap — needs acknowledgment/);
  t.doesNotMatch(T.renderDetail({ ...trade, terminal: true, state_view: { code: "completed", label: "Done" } }), /salary cap/);
});

// ───────────────────────────────── a tiny app shell for the real client code ─────────────────────────────────
function world(o) {
  o = o || {};
  const env = makeWorkerEnv(); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  // A resolvable, flat, non-loaded contract for every generated player (real and filler) --
  // previously blank, which used to be silently read as flat but is now correctly
  // UNAVAILABLE for loaded_contracts (2026-09-28 review) and would refuse every preview/
  // accept in this file before it ever reaches what these tests actually check.
  const bulk = (start, n) => Array.from({ length: n }, (_, i) => ({ id: String(start + i), salary: 100, contractYear: 3, contractStatus: "Vet-FAA" }));
  mfl.st.rosters["0001"] = [{ id: "14056", salary: o.s1 == null ? 5000 : o.s1, contractYear: 3, contractStatus: "Vet-FAA" }, { id: "90001", salary: o.fill1 || 100000, contractYear: 3, contractStatus: "Vet-FAA" }, ...(o.extra1 || [])];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: o.s2 == null ? 5000 : o.s2, contractYear: 3, contractStatus: "Vet-FAA" }, { id: "90002", salary: o.fill2 || 100000, contractYear: 3, contractStatus: "Vet-FAA" }, ...(o.extra2 || [])];
  if (o.league) mfl.st.league = o.league;
  return { env, mfl, bulk };
}
const P = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
async function sendOffer(env, mfl, give, recv) {
  const payload = { schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [{ role: "left", franchise_id: "0001", selected_assets: give.map(P), traded_salary_adjustment_k: 0 }, { role: "right", franchise_id: "0002", selected_assets: recv.map(P), traded_salary_adjustment_k: 0 }],
    extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } };
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload } });
  t.ok(r.status < 300, `sent ${r.status}`);
  return mfl.st.pending[mfl.st.pending.length - 1].trade_id;
}
const actionsOf = (log) => log.filter((c) => /\/proposals\/action$|\/trade-offers\/action$/.test(c.path)).map((c) => String((c.body && c.body.action) || "").toUpperCase());

// ───────────────────────────────── MOBILE (the real trade.js) ─────────────────────────────────
function loadMobile(env, tradeId) {
  const log = [];
  const toasts = [];
  const registry = {};
  const reg = (id, el) => { registry[id] = el; return el; };
  const app = makeEl("ups-m-app");
  app.insertAdjacentHTML = (pos, html) => {
    for (const m of html.matchAll(/id="(ups-m-accept-overlay|ups-m-accept-body)"/g)) {
      const el = makeEl(m[1]); el.remove = () => { delete registry[m[1]]; if (m[1] === "ups-m-accept-overlay") delete registry["ups-m-accept-body"]; };
      reg(m[1], el);
    }
    // the overlay owns the sheet: the body's html is painted into the overlay so clicks on ANY button in it reach the bound handlers
    if (registry["ups-m-accept-overlay"]) { registry["ups-m-accept-overlay"].innerHTML = html; registry["ups-m-accept-body"] = registry["ups-m-accept-overlay"]; }
  };
  const mount = makeEl("ups-m-main");
  const buttons = [];
  mount.querySelector = () => null;
  mount.querySelectorAll = (sel) => (/\.btn-act\[data-act\]/.test(sel) ? buttons : []);
  const U = {
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: { reloadData: async () => {} },
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => "tok-C" },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: "0002", franchises: [], tradeOffers: { incoming: [{ trade_id: tradeId, offered_by: "0001", will_give_up: "14056", will_receive: "13100" }], outgoing: [] } },
    ui: { showToast: (m, tone) => toasts.push([m, tone]) },
    route: { renderRoute: () => M.tradeView.render(mount, []), navigate() {} },
  };
  const doc = { getElementById: (id) => (id === "ups-m-app" ? app : registry[id] || null), body: { style: {} } };
  const sandbox = { fetch: workerFetch(env, log), console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document: doc };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.UPS_TRADE_3WAY = T;
  sandbox.confirm = () => { throw new Error("no native confirm for an accept — the review sheet is the confirmation"); };
  vm.createContext(sandbox);
  vm.runInContext(MOBILE_SRC, sandbox, { filename: "site/m/views/trade.js" });
  return { M, mount, toasts, log, app, registry, buttons, click: async (act) => { const b = buttons.find((x) => x.getAttribute("data-act") === act); if (!b) throw new Error("no " + act + " button"); b.handlers.forEach((fn) => fn.call(b)); await settle(30); }, sheet: () => registry["ups-m-accept-overlay"], doc, sandbox };
}
// The mount's querySelectorAll is asked for the buttons AFTER innerHTML is set, so give it a live parser.
function liveMobile(env, tradeId) {
  const h = loadMobile(env, tradeId);
  const attach = () => {
    h.buttons.length = 0;
    for (const m of h.mount.innerHTML.matchAll(/<button[^>]*data-act="([a-z]+)"[^>]*data-trade-id="([^"]+)"[^>]*>/g)) {
      const attrs = { "data-act": m[1], "data-trade-id": m[2] };
      h.buttons.push({ getAttribute: (a) => attrs[a] || null, handlers: [], addEventListener(type, fn) { this.handlers.push(fn); } });
    }
  };
  h.mount.querySelectorAll = (sel) => { if (/\.btn-act\[data-act\]/.test(sel)) { attach(); return h.buttons; } return []; };
  h.M.tradeView.render(h.mount, []);
  return h;
}

test("MOBILE: Accept opens a REVIEW first — one read-only preview, no ACCEPT posted until the owner confirms", async () => {
  const { env, mfl } = world({ fill1: 100000, fill2: 100000 });
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  const app = liveMobile(env, id);
  await app.click("accept");
  t.ok(app.sheet(), "the review sheet is open"); const html = app.sheet().innerHTML;
  t.match(html, /Salary cap — every team stays under/); t.ok(has(html, "accept-confirm"), "cap ok → Accept offered");
  t.deepEqual(actionsOf(app.log), ["PREVIEW"], "only the read-only preview so far"); t.equal(mfl.st.done.length, 0);
  app.sheet().click("accept-confirm"); await settle(60);
  t.deepEqual(actionsOf(app.log), ["PREVIEW", "ACCEPT"]); t.equal(mfl.st.done.length, 1); t.equal(app.sheet(), undefined, "sheet closed");
});
test("MOBILE: a cap block is shown BEFORE anything is accepted — the teams and amounts, no Accept button, and no ACCEPT is ever posted", async () => {
  const { env, mfl } = world({ s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });          // 0002 (the accepting owner, tok-C) → 310000
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  const app = liveMobile(env, id);
  await app.click("accept");
  const html = app.sheet().innerHTML;
  t.match(html, /Over the salary cap — needs acknowledgment/); t.match(html, /CBP would be \$10,000 over the \$300,000 salary cap/);
  t.ok(!has(html, "accept-confirm")); t.ok(has(html, "accept-close"));
  app.sheet().click("accept-close"); await settle();
  t.deepEqual(actionsOf(app.log), ["PREVIEW"], "no accept was ever posted"); t.equal(mfl.st.done.length, 0); t.equal(mfl.writes("tradeResponse").length, 0);
});
test("MOBILE: cap data unavailable → the sheet says so, offers Try again, never Accept; the retry uses a fresh preview", async () => {
  const { env, mfl } = world({ fill1: 100000, fill2: 100000 });
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const app = liveMobile(env, id);
  await app.click("accept");
  let html = app.sheet().innerHTML;
  t.match(html, /couldn&#39;t verify the salary cap/); t.ok(!has(html, "accept-confirm")); t.ok(has(html, "accept-retry"));
  t.doesNotMatch(html, /HTTP 503|cap_check_unavailable|Failed to fetch/);
  mfl.st.exportFail = null;
  app.sheet().click("accept-retry"); await settle(40);
  html = app.sheet().innerHTML; t.ok(has(html, "accept-confirm"), "after the outage the same sheet can proceed"); t.deepEqual(actionsOf(app.log), ["PREVIEW", "PREVIEW"]);
});
test("MOBILE: over the roster maximum shows BEFORE the final confirmation, and the owner can't accept until that team has made its move", async () => {
  const w = world({ fill1: 100000, fill2: 100000, league: { rosterSize: "35" } });
  const bulk = w.bulk;
  w.mfl.st.rosters["0001"].push(...bulk(100, 28)); w.mfl.st.rosters["0002"].push(...bulk(500, 33));    // 0002: 13100 + 90002 + 33 = 35 active
  const id = await sendOffer(w.env, w.mfl, ["14056", "90001"], ["13100"]);                              // 0002 receives 2, sends 1 → 36
  const app = liveMobile(w.env, id);
  await app.click("accept");
  const html = app.sheet().innerHTML;
  t.match(html, /Can't be accepted — roster maximum/); t.match(html, /CBP would have 36 active players right after this trade — the maximum is 35/);
  t.ok(!has(html, "accept-confirm"), "no Accept while CBP is over");
  t.deepEqual(actionsOf(app.log), ["PREVIEW"], "nothing was sent: only the review ran");
});
test("MOBILE: roster-count authority missing is shown as unavailable, not as compliant", async () => {
  const w = world({ fill1: 100000, fill2: 100000, league: { rosterSize: "" } });
  const id = await sendOffer(w.env, w.mfl, ["14056"], ["13100"]);
  const app = liveMobile(w.env, id);
  await app.click("accept");
  const html = app.sheet().innerHTML;
  t.match(html, /Roster counts — couldn't be checked/); t.doesNotMatch(html, /Roster counts — within limits/);
});
test("MOBILE: if the offer moved on (no longer pending) the sheet says why and offers no Accept", async () => {
  const { env, mfl } = world({});
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  mfl.st.pending = [];                                                                                  // it was accepted / withdrawn elsewhere
  const app = liveMobile(env, id);
  await app.click("accept");
  const html = app.sheet().innerHTML;
  t.match(html, /Can't review this trade/); t.match(html, /isn&#39;t pending/); t.ok(!has(html, "accept-confirm"));
});

// ───────────────────────────────── DESKTOP (the real accept review) ─────────────────────────────────
function loadDesktop(env) {
  const start = DESK_SRC.indexOf("  // ── Accept review: salary cap (HARD rule)");
  const end = DESK_SRC.indexOf("  async function performOfferAction(action, meta) {");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the desktop accept review in trade_workbench.js");
  const code = DESK_SRC.slice(start, end);
  const log = [];
  const dlg = makeEl("twbAcceptReview");
  dlg.className = ""; dlg.attrs = {}; dlg.setAttribute = (k, v) => { dlg.attrs[k] = v; }; dlg.removeAttribute = (k) => { delete dlg.attrs[k]; }; dlg.hasAttribute = (k) => k in dlg.attrs;
  dlg.showModal = () => { dlg.attrs.open = "open"; }; dlg.close = () => { delete dlg.attrs.open; };
  let created = false;
  const document = { getElementById: (id) => (id === "twbAcceptReview" ? (created ? dlg : null) : id === "twbAcceptReviewBody" ? dlg : null),
    createElement: () => dlg, body: { appendChild: () => { created = true; } } };
  const win = { UPS_TRADE_3WAY: T };
  const factory = new Function("window", "document", "fetch", code + "\nreturn { reviewBeforeAccept };");
  const api = factory(win, document, workerFetch(env, log));
  return { api, dlg, log, url: `https://worker.test/trade-offers/action?${Q}&MFL_USER_ID=tok-C` };
}
const previewBody = (id) => ({ league_id: "74598", season: "2026", trade_id: id, action: "PREVIEW", acting_franchise_id: "0002", offer_id: id });

test("DESKTOP: the review opens before any accept; with a healthy cap the owner can confirm (resolves true) or back out (resolves false)", async () => {
  const { env, mfl } = world({});
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  const d = loadDesktop(env);
  const p = d.api.reviewBeforeAccept(d.url, previewBody(id)); await settle(40);
  t.ok(d.dlg.hasAttribute("open"), "dialog is open"); t.match(d.dlg.innerHTML, /Salary cap — every team stays under/); t.ok(d.dlg.has("accept-confirm"));
  t.deepEqual(actionsOf(d.log), ["PREVIEW"]);
  d.dlg.click("accept-confirm"); t.equal(await p, true); t.ok(!d.dlg.hasAttribute("open"));
  const p2 = d.api.reviewBeforeAccept(d.url, previewBody(id)); await settle(40);
  d.dlg.click("accept-close"); t.equal(await p2, false);
  t.equal(mfl.st.done.length, 0, "the review itself never accepts");
});
test("DESKTOP: a cap block shows the franchise and amount, offers no Accept, and resolves false (so no ACCEPT is posted)", async () => {
  const { env, mfl } = world({ s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });          // 0002 (the accepting owner, tok-C) → 310000
  const id = await sendOffer(env, mfl, ["14056"], ["13100"]);
  const d = loadDesktop(env);
  const p = d.api.reviewBeforeAccept(d.url, previewBody(id)); await settle(40);
  t.match(d.dlg.innerHTML, /CBP would be \$10,000 over the \$300,000 salary cap/); t.ok(!d.dlg.has("accept-confirm")); t.ok(d.dlg.has("accept-close"));
  d.dlg.click("accept-close"); t.equal(await p, false); t.equal(mfl.writes("tradeResponse").length, 0);
});
test("DESKTOP: unavailable cap → says so with Try again; over the roster maximum is shown before confirmation and can't be accepted", async () => {
  { const { env, mfl } = world({ fill1: 100000, fill2: 100000 });
    const id = await sendOffer(env, mfl, ["14056"], ["13100"]); mfl.st.exportFail = { league: 503 };
    const d = loadDesktop(env);
    const p = d.api.reviewBeforeAccept(d.url, previewBody(id)); await settle(40);
    t.match(d.dlg.innerHTML, /couldn&#39;t verify the salary cap/); t.ok(!d.dlg.has("accept-confirm")); t.ok(d.dlg.has("accept-retry"));
    d.dlg.click("accept-close"); t.equal(await p, false); }
  { const w = world({ fill1: 100000, fill2: 100000, league: { rosterSize: "35" } });
    w.mfl.st.rosters["0001"].push(...w.bulk(100, 28)); w.mfl.st.rosters["0002"].push(...w.bulk(500, 33));
    const id = await sendOffer(w.env, w.mfl, ["14056", "90001"], ["13100"]);
    const d = loadDesktop(w.env);
    const p = d.api.reviewBeforeAccept(d.url, previewBody(id)); await settle(40);
    t.match(d.dlg.innerHTML, /Can&#39;t be accepted — roster maximum|Can't be accepted — roster maximum/); t.match(d.dlg.innerHTML, /CBP would have 36 active players right after this trade/);
    t.ok(!d.dlg.has("accept-confirm")); t.deepEqual(actionsOf(d.log), ["PREVIEW"]);
    d.dlg.click("accept-close"); await p; }
});
test("DESKTOP: performOfferAction reviews BEFORE it accepts, and stops when the review is declined (source-level guarantee)", () => {
  const i = DESK_SRC.indexOf("async function performOfferAction(action, meta) {");
  const body = DESK_SRC.slice(i, DESK_SRC.indexOf("  function renderBannerOfferList", i));
  const rev = body.indexOf("reviewBeforeAccept("), busy = body.indexOf("state.offers.actionBusy = true"), post = body.indexOf('method: "POST"');
  t.ok(rev > 0 && rev < busy && busy < post, "review → busy → POST");
  t.match(body.slice(rev, rev + 400), /if \(!proceed\) return;/);
  t.match(body, /if \(normalizedAction === "ACCEPT"\) \{\s*var proceed = await reviewBeforeAccept/);
});
test("MOBILE + DESKTOP: neither client computes a cap number of its own for the review (the verdict is the server's)", () => {
  for (const src of [MOBILE_SRC.slice(MOBILE_SRC.indexOf("function previewAccept"), MOBILE_SRC.indexOf("function handleAction")), DESK_SRC.slice(DESK_SRC.indexOf("// ── Accept review"), DESK_SRC.indexOf("async function performOfferAction"))]) {
    t.doesNotMatch(src, /300000|salary_cap|capSpace|used_after\s*[-+]|room_after\s*[-+]/, "no cap arithmetic in the review code");
  }
});

await run("trade_cap_clients");
restore();
