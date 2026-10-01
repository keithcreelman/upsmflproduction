// LOADED-CONTRACT DROP PICKER in the CLIENTS — the shared renderer plus the REAL desktop Trade
// War Room builder (site/trades/trade_workbench.js) and the REAL mobile builder
// (site/m/views/trade.js), each run in Node against a small fake DOM, with fetch() going to the
// REAL worker (real SQLite, MFL stubbed at the edge).
//   node tests/trade_loaded_contract_clients.test.mjs
//
// Root cause under test (Keith, 2026-09-29): building/reviewing an offer as the SENDER showed no
// loaded-contract warning at all — the check (PR #1135) only ever ran at the RECIPIENT's accept.
// This file proves the shipped CLIENT code (not just the worker) now surfaces the requirement and
// lets the owner pick drops BEFORE Send Offer, using the real 409 the real worker returns.
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

// A resolvable, flat filler for every generated player, plus 5 explicit loaded fillers on 0001
// so a receive pushes it 5 -> 6, exactly the Hammer Times shape.
const loadedFillers = (from, count) => Array.from({ length: count }, (_, i) => ({ id: String(from + i), salary: 1000, contractYear: 3, contractStatus: "Vet-Ext2-BL" }));
function world() {
  const env = makeWorkerEnv();
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, ...loadedFillers(90000, 5)];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA-FL" }];
  return { env, mfl };
}
function offerBody() {
  return {
    league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "",
    payload: { schema_version: 1, source: "test", league_id: "74598", season: "2026",
      teams: [
        { role: "left", franchise_id: "0001", selected_assets: [{ asset_id: "P_14056", type: "PLAYER", player_id: "14056", player_name: "P14056", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
        { role: "right", franchise_id: "0002", selected_assets: [{ asset_id: "P_13100", type: "PLAYER", player_id: "13100", player_name: "P13100", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
      ],
      extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } },
  };
}
function trackListeners(el) {
  el.__listeners = {};
  el.addEventListener = (type, fn) => { (el.__listeners[type] = el.__listeners[type] || []).push(fn); };
  return el;
}

// ───────────────────────────────── DESKTOP (the real submitTradeCreateWithGates + its dialog) ─────────────────────────────────
// Desktop delegates every click through ONE handler on the dialog body (body.onclick = fn) —
// this drives that exactly, dispatching a synthetic event built from the dialog's own rendered
// HTML, the same technique fixtures/fake_dom.mjs's own el.click() uses for its narrower case.
function dialogClick(dlg, attr, val) {
  const re = new RegExp(`<button[^>]*${attr}="${val}"[^>]*>`);
  if (!re.test(dlg.innerHTML)) throw new Error(`no [${attr}="${val}"] button is rendered`);
  const btn = { getAttribute: (a) => (a === attr ? val : null) };
  const ev = { target: { closest: (sel) => (sel.indexOf(attr) !== -1 ? btn : null) }, preventDefault() {} };
  (dlg.__listeners.click || []).forEach((fn) => fn(ev));
}
function dialogCheck(dlg, pid, checked) {
  const re = new RegExp(`<input[^>]*data-t3w-drop-pid="${pid}"[^>]*>`);
  if (!re.test(dlg.innerHTML)) throw new Error(`no checkbox for candidate ${pid} is rendered`);
  const box = { checked, closest: (sel) => (sel.indexOf("data-t3w-drop-pid") !== -1 ? box : null), getAttribute: (a) => (a === "data-t3w-drop-pid" ? pid : null) };
  const ev = { target: box };
  (dlg.__listeners.click || []).forEach((fn) => fn(ev));
}
function loadDesktop(env) {
  const start = DESK_SRC.indexOf("  async function fetchJsonRequest(url, options) {");
  const end = DESK_SRC.indexOf("  function getAssetById(teamId, assetId) {");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the desktop drop-gate helpers in trade_workbench.js");
  const code = DESK_SRC.slice(start, end);
  const log = [];
  const dlg = trackListeners(makeEl("twbDropsDialog"));
  dlg.attrs = {}; dlg.setAttribute = (k, v) => { dlg.attrs[k] = v; }; dlg.removeAttribute = (k) => { delete dlg.attrs[k]; }; dlg.hasAttribute = (k) => k in dlg.attrs;
  dlg.showModal = () => { dlg.attrs.open = "open"; }; dlg.close = () => { delete dlg.attrs.open; };
  Object.defineProperty(dlg, "onclick", { set(fn) { dlg.__listeners.click = [fn]; }, get() { return (dlg.__listeners.click || [])[0]; } });
  let created = false;
  const document = {
    getElementById: (id) => (id === "twbDropsDialog" ? (created ? dlg : null) : id === "twbDropsDialogBody" ? dlg : null),
    createElement: () => dlg, body: { appendChild: () => { created = true; } },
  };
  const win = { UPS_TRADE_3WAY: T };
  // The real getTeamById reads a module-level `state` (not a parameter) — a tiny local
  // stand-in with exactly one franchise's assets is enough for buildPlayerNamesFor's own
  // real, unmodified lookup logic to resolve candidate names.
  const stateCode = `function safeStr(v) { return v == null ? "" : String(v).trim(); }\n` +
    `var state = { data: { teams: [ { franchise_id: "0001", assets: [` +
    loadedFillers(90000, 5).map((p, i) => `{ player_id: "${p.id}", player_name: "Filler ${i}", position: "WR" }`).join(",") +
    `] } ] } };\n  function getTeamById(teamId) { var teams = (state.data && state.data.teams) || []; for (var i = 0; i < teams.length; i++) { if (teams[i].franchise_id === teamId) return teams[i]; } return null; }\n`;
  const factory = new Function("window", "document", "fetch",
    stateCode + code + "\n  return { showLoadedContractBlock, submitTradeCreateWithGates, confirmOfferCapOverage };");
  const api = factory(win, document, workerFetch(env, log));
  return { api, dlg, log };
}

test("DESKTOP: a 5->6 create is refused BEFORE anything is sent, the dialog shows the REAL server message/team/count with NO picker, and the promise always rejects -- there is no in-trade fix (Keith's ruling, 2026-10-01, REPLACING the conditional-drop-picker ruling of 2026-09-29)", async () => {
  const { env, mfl } = world();
  const d = loadDesktop(env);
  const apiUrl = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const p = d.api.submitTradeCreateWithGates(apiUrl, offerBody(), "0001");
  await settle(40);
  t.ok(d.dlg.hasAttribute("open"), "the block dialog opened BEFORE anything was sent");
  t.match(d.dlg.innerHTML, /L\.A\. Looks would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the REAL server message, not a client guess");
  t.match(d.dlg.innerHTML, /Revise the offer, or make a separate roster move first/);
  // No picker-enabling markup of any kind -- no checkboxes, no candidate list, no "Confirm and send".
  t.doesNotMatch(d.dlg.innerHTML, /data-t3w-drop-pid/, "no checkboxes -- there is nothing to pick");
  t.doesNotMatch(d.dlg.innerHTML, /Confirm and send/, "no retry affordance");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes while the dialog is open");

  let threw = null;
  dialogClick(d.dlg, "data-drops-act", "close");   // the dialog's only button
  try { await p; } catch (e) { threw = e; }
  t.ok(threw, "the promise rejects -- Close always re-throws the original refusal");
  t.equal(threw.status, 409);
  t.equal(threw.data.code, "loaded_contract_limit_exceeded");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes -- the offer was never sent");
});

// ───────────────────────────────── MOBILE (the real submitTradeCreateWithGatesMobile + its sheet) ─────────────────────────────────
// Mobile attaches a FRESH addEventListener("click") directly to each button element (by id) on
// every redraw, unlike desktop's single delegated handler — this simulates that per-element model.
function loadMobile(env) {
  const log = [];
  const registry = {};
  const app = trackListeners(makeEl("ups-m-app"));
  const bodyChangeTarget = trackListeners(makeEl("ups-m-drops-body"));
  app.insertAdjacentHTML = (pos, html) => {
    const overlay = trackListeners(makeEl("ups-m-drops-overlay"));
    Object.defineProperty(overlay, "outerHTML", { set(v) { overlay.innerHTML = v; }, get() { return overlay.innerHTML; } });
    overlay.innerHTML = html;
    overlay.remove = () => { delete registry["ups-m-drops-overlay"]; };
    registry["ups-m-drops-overlay"] = overlay;
  };
  function freshButton(id) { const btn = trackListeners(makeEl(id)); registry[id] = btn; return btn; }
  const doc = {
    getElementById: (id) => {
      if (id === "ups-m-app") return app;
      if (id === "ups-m-drops-overlay") return registry["ups-m-drops-overlay"] || null;
      if (id === "ups-m-drops-close" || id === "ups-m-drops-close-ok") return freshButton(id);
      return null;
    },
    querySelector: (sel) => (sel === "#ups-m-drops-overlay .ups-m-drop-body" ? bodyChangeTarget : null),
    body: { style: {} },
  };
  const U = {
    pad4: (v) => { const dg = String(v || "").replace(/\D/g, ""); return dg ? dg.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()),
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  };
  const builderState = { inv: { "0001": { players: [
    { player_id: "90000", display: "Filler 0", position: "WR" }, { player_id: "90001", display: "Filler 1", position: "WR" },
    { player_id: "90002", display: "Filler 2", position: "WR" }, { player_id: "90003", display: "Filler 3", position: "WR" },
    { player_id: "90004", display: "Filler 4", position: "WR" },
  ] } } };
  const start = MOBILE_SRC.indexOf("  function showLoadedContractBlockSheet(errData) {");
  const end = MOBILE_SRC.indexOf("  function submitOffer() {");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the mobile drop-gate helpers in views/trade.js");
  const code = MOBILE_SRC.slice(start, end);
  const win = { UPS_TRADE_3WAY: T };
  const openCreateCapAckStub = "function openCreateCapAckSheet() { throw new Error('cap-ack path not exercised in this test'); }\n";
  const factory = new Function("window", "document", "fetch", "U", "builderState", "T",
    openCreateCapAckStub + code + "\n  return { showLoadedContractBlockSheet, submitTradeCreateWithGatesMobile };");
  const api = factory(win, doc, workerFetch(env, log), U, builderState, T);
  return { api, app, registry, log, bodyChangeTarget, sheet: () => registry["ups-m-drops-overlay"] };
}
function mobileClick(m, id) {
  const btn = m.registry[id];
  if (!btn) throw new Error(`no #${id} is rendered`);
  (btn.__listeners.click || []).forEach((fn) => fn({}));
}

test("MOBILE: a 5->6 create is refused BEFORE anything is sent, the sheet shows the REAL server message/team/count with NO picker, and the final result is always the original 409 -- there is no in-trade fix (Keith's ruling, 2026-10-01, REPLACING the conditional-drop-picker ruling of 2026-09-29)", async () => {
  const { env, mfl } = world();
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B`;
  const p = m.api.submitTradeCreateWithGatesMobile(url, offerBody(), "0001");
  await settle(40);
  t.ok(m.sheet(), "the block sheet opened BEFORE anything was sent");
  const html1 = m.sheet().innerHTML;
  t.match(html1, /L\.A\. Looks would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the REAL server message");
  t.match(html1, /Revise the offer, or make a separate roster move first/);
  t.doesNotMatch(html1, /data-t3w-drop-pid/, "no checkboxes -- there is nothing to pick");
  t.doesNotMatch(html1, /Confirm and send/, "no retry affordance");
  t.equal(mfl.st.pending.length, 0);

  mobileClick(m, "ups-m-drops-close-ok");
  const res = await p;
  t.ok(res, "the original 409 response is returned, not null -- submitOffer's own error handling renders it");
  t.equal(res.status, 409);
  t.equal(res.body.code, "loaded_contract_limit_exceeded");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes -- the offer was never sent");
});

// ───────── CREATE-TIME: the RECIPIENT (not the sender) is over the limit -- Keith's exact
// Hammer Times / Chig Okonkwo scenario ─────────
// "If Hammer has 5 loaded contracts... and I offer him Chig Okonkwo as a sixth, show me before
// Send" (Keith, 2026-09-30). Nothing for the SENDER to pick here (only Hammer can pick his own
// drop, at his own review) -- no interactive picker opens, but the sender must still see the
// exact warning before anything is sent, on BOTH platforms, identically.
function hammerOfferBody() {
  return {
    league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0005", message: "",
    payload: { schema_version: 1, source: "test", league_id: "74598", season: "2026",
      teams: [
        { role: "left", franchise_id: "0001", selected_assets: [{ asset_id: "P_14056", type: "PLAYER", player_id: "14056", player_name: "Chig Okonkwo", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
        { role: "right", franchise_id: "0005", selected_assets: [{ asset_id: "P_13100", type: "PLAYER", player_id: "13100", player_name: "P13100", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
      ],
      extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0005" }, validation: { status: "ready" } },
  };
}
function hammerWorld() {
  const { env, mfl } = world();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-Ext2-BL" }]; // "Chig Okonkwo" -- a loaded contract
  mfl.st.rosters["0005"] = [{ id: "13100", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, ...loadedFillers(90000, 4), { id: "90004", salary: 1000, contractYear: 3, contractStatus: "Vet-Ext2-BL", status: "INJURED_RESERVE" }];
  return { env, mfl };
}

test("DESKTOP CREATE — HAMMER TIMES / CHIG OKONKWO: the RECIPIENT (not the sender) would go over the limit -- the SAME hard-block dialog opens (no picker, just the warning), naming HammerTime, and nothing is sent", async () => {
  const { env, mfl } = hammerWorld();
  const d = loadDesktop(env);
  const apiUrl = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const p = d.api.submitTradeCreateWithGates(apiUrl, hammerOfferBody(), "0001");
  await settle(40);
  t.ok(d.dlg.hasAttribute("open"), "the block dialog opens even though it's the RECIPIENT's own requirement -- the sender still needs to see it");
  t.match(d.dlg.innerHTML, /HammerTime would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the sender sees the exact warning, naming HammerTime, before anything is sent");
  t.doesNotMatch(d.dlg.innerHTML, /data-t3w-drop-pid/, "no picker -- nothing for the sender to pick on HammerTime's behalf");
  t.equal(mfl.st.pending.length, 0, "no native MFL offer was sent while the dialog is open");
  let threw = null;
  dialogClick(d.dlg, "data-drops-act", "close");
  try { await p; } catch (e) { threw = e; }
  t.ok(threw, "the send is still refused");
  t.equal(threw.status, 409);
  t.equal(mfl.st.pending.length, 0, "no native MFL offer was ever sent");
});

test("MOBILE CREATE — HAMMER TIMES / CHIG OKONKWO: the SAME scenario surfaces the SAME hard-block sheet to the sender, naming HammerTime, and nothing is sent", async () => {
  const { env, mfl } = hammerWorld();
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const p = m.api.submitTradeCreateWithGatesMobile(url, hammerOfferBody(), "0001");
  await settle(40);
  t.ok(m.sheet(), "the block sheet opens even though it's the RECIPIENT's own requirement");
  t.match(m.sheet().innerHTML, /HammerTime would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the SAME exact warning as desktop, naming HammerTime");
  t.doesNotMatch(m.sheet().innerHTML, /data-t3w-drop-pid/, "no picker on mobile either");
  mobileClick(m, "ups-m-drops-close-ok");
  const resp = await p;
  t.ok(resp, "the original 409 response is returned");
  t.equal(resp.status, 409);
  t.equal(mfl.st.pending.length, 0, "no native MFL offer was ever sent");
});

// ───────────────────────────────── ACCEPT REVIEW (the RECIPIENT's own requirement) ─────────────────────────────────
// "Each affected franchise owner must select and confirm their own loaded-contract players to
// drop ... The receiving owner chooses their drops before accepting" (Keith's ruling, 2026-09-29).
// This proves the REAL reviewBeforeAccept (desktop) and openAcceptReview (mobile) — not the
// create-time picker above — let the RECIPIENT pick and confirm their own drops, against a REAL
// worker, before Accept becomes available.
function loadDesktopAccept(env) {
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
const previewBody2 = (id) => ({ league_id: "74598", season: "2026", trade_id: id, action: "PREVIEW", acting_franchise_id: "0002", offer_id: id });

test("DESKTOP ACCEPT: the RECIPIENT's own 5->6 is a hard block on review -- Accept is withheld, no picker is offered, and the owner's only path is Not now (Keith's ruling, 2026-10-01, REPLACING the conditional-drop-picker ruling of 2026-09-29)", async () => {
  const { env, mfl } = world();
  // Flip the direction: 0002 is now the one who will RECEIVE a loaded player. At 4 loaded
  // (under the limit), creation succeeds -- the create-time gate also checks the RECIPIENT's own
  // side, but 0002's roster changes AFTER this offer is created and BEFORE they review it --
  // exactly the "recalculate immediately before completion" principle -- so the block must still
  // appear at accept, from a live re-check, never trusted from create time.
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, ...loadedFillers(90000, 4)];
  const createRes = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: offerBody() });
  t.equal(createRes.status, 201, createRes.text.slice(0, 300));
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  mfl.st.rosters["0002"].push(...loadedFillers(90004, 1)); // a 5th loaded contract lands on 0002 between create and accept

  const d = loadDesktopAccept(env);
  const p = d.api.reviewBeforeAccept(d.url, previewBody2(id));
  await settle(40);
  t.match(d.dlg.innerHTML, /CBP would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the REAL server message for the RECIPIENT's own franchise");
  t.match(d.dlg.innerHTML, /Revise the offer, or make a separate roster move first/);
  t.ok(!d.dlg.has("accept-confirm"), "Accept is withheld -- there is no in-trade fix to satisfy it with");
  t.doesNotMatch(d.dlg.innerHTML, /data-t3w-drop-pid/, "no picker is offered");
  t.equal(mfl.st.done.length, 0, "zero MFL writes while the review is open");

  // With no accept-confirm button rendered, the owner's only path is Not now -- the review
  // resolves false, exactly like any other un-acceptable state.
  d.dlg.click("accept-close");
  t.equal(await p, false);
  t.equal(mfl.st.done.length, 0, "zero MFL writes across the entire review");
});

// The real openAcceptReview() is module-internal (not on M.tradeView's public surface) --
// reached the same way an owner reaches it: render the offer list, click "accept" on the row.
// Mirrors tests/trade_cap_clients.test.mjs's loadMobile/liveMobile harness exactly.
function loadMobileForAccept(env, tradeId) {
  const log = [];
  const registry = {};
  const app = makeEl("ups-m-app");
  app.insertAdjacentHTML = (pos, html) => {
    for (const m of html.matchAll(/id="(ups-m-accept-overlay|ups-m-accept-body)"/g)) {
      const el = makeEl(m[1]); el.remove = () => { delete registry[m[1]]; if (m[1] === "ups-m-accept-overlay") delete registry["ups-m-accept-body"]; };
      registry[m[1]] = el;
    }
    if (registry["ups-m-accept-overlay"]) { registry["ups-m-accept-overlay"].innerHTML = html; registry["ups-m-accept-body"] = registry["ups-m-accept-overlay"]; }
  };
  const mount = makeEl("ups-m-main");
  const buttons = [];
  mount.querySelector = () => null;
  mount.querySelectorAll = (sel) => (/\.btn-act\[data-act\]/.test(sel) ? buttons : []);
  const U = {
    pad4: (v) => { const dd = String(v || "").replace(/\D/g, ""); return dd ? dd.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, dft) => { const n = parseInt(v, 10); return isFinite(n) ? n : (dft == null ? 0 : dft); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (n) => "$" + n,
  };
  const M = {
    util: U, data: {}, actions: { reloadData: async () => {} },
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => "tok-C" },
    state: { ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: "0002", franchises: [], tradeOffers: { incoming: [{ trade_id: tradeId, offered_by: "0001", will_give_up: "14056", will_receive: "13100" }], outgoing: [] } },
    ui: { showToast: () => {} },
    route: { renderRoute: () => M.tradeView.render(mount, []), navigate() {} },
  };
  const doc = { getElementById: (elId) => (elId === "ups-m-app" ? app : registry[elId] || null), body: { style: {} } };
  const sandbox = { fetch: workerFetch(env, log), console, setTimeout, Promise, URL, encodeURIComponent, decodeURIComponent, isFinite, parseInt, String, Number, JSON, Object, Array, Date, Math, document: doc };
  sandbox.window = sandbox; sandbox.UPS_MOBILE = M; sandbox.UPS_TRADE_3WAY = T;
  vm.createContext(sandbox);
  vm.runInContext(MOBILE_SRC, sandbox, { filename: "site/m/views/trade.js" });
  const attach = () => {
    buttons.length = 0;
    for (const m of mount.innerHTML.matchAll(/<button[^>]*data-act="([a-z]+)"[^>]*data-trade-id="([^"]+)"[^>]*>/g)) {
      const attrs = { "data-act": m[1], "data-trade-id": m[2] };
      buttons.push({ getAttribute: (a) => attrs[a] || null, handlers: [], addEventListener(type, fn) { this.handlers.push(fn); } });
    }
  };
  mount.querySelectorAll = (sel) => { if (/\.btn-act\[data-act\]/.test(sel)) { attach(); return buttons; } return []; };
  M.tradeView.render(mount, []);
  return { M, mount, registry, log, sheet: () => registry["ups-m-accept-overlay"], click: async (act) => { const b = buttons.find((x) => x.getAttribute("data-act") === act); if (!b) throw new Error("no " + act + " button"); b.handlers.forEach((fn) => fn.call(b)); await settle(30); } };
}

test("MOBILE ACCEPT: the RECIPIENT's own 5->6 is a hard block on review -- Accept is withheld, no picker is offered (Keith's ruling, 2026-10-01, REPLACING the conditional-drop-picker ruling of 2026-09-29)", async () => {
  const { env, mfl } = world();
  // Same setup as the DESKTOP ACCEPT test above: 0002 is under the limit at create time, and
  // gains its 5th loaded contract AFTER creation, before this review -- proving the accept-time
  // re-check is live, not trusted from create time.
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, ...loadedFillers(90000, 4)];
  const createRes = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: offerBody() });
  t.equal(createRes.status, 201, createRes.text.slice(0, 300));
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  mfl.st.rosters["0002"].push(...loadedFillers(90004, 1));

  const app = loadMobileForAccept(env, id);
  await app.click("accept");
  const sheet = app.sheet;
  t.ok(sheet(), "the review sheet opened");
  t.match(sheet().innerHTML, /CBP would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the REAL server message");
  t.match(sheet().innerHTML, /Revise the offer, or make a separate roster move first/);
  t.ok(!sheet().has("accept-confirm"), "Accept is withheld -- there is no in-trade fix to satisfy it with");
  t.doesNotMatch(sheet().innerHTML, /data-t3w-drop-pid/, "no picker is offered");
  t.equal(mfl.st.done.length, 0);
});

await run("trade_loaded_contract_clients");
restore();
