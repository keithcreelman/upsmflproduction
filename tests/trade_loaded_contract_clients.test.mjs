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
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, workerFetch, quiet } from "./fixtures/worker_harness.mjs";
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
    stateCode + code + "\n  return { confirmOfferLoadedContractDrops, submitTradeCreateWithGates, confirmOfferCapOverage };");
  const api = factory(win, document, workerFetch(env, log));
  return { api, dlg, log };
}

test("DESKTOP: a 5->6 create is refused BEFORE anything is sent, the picker shows the right franchise/count/candidates from the REAL 409, and a valid pick lets the SAME request go through", async () => {
  const { env, mfl } = world();
  const d = loadDesktop(env);
  const apiUrl = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const p = d.api.submitTradeCreateWithGates(apiUrl, offerBody(), "0001");
  await settle(40);
  t.ok(d.dlg.hasAttribute("open"), "the picker dialog opened BEFORE anything was sent");
  t.match(d.dlg.innerHTML, /L\.A\. Looks would move from 5 to 6 loaded contracts/, "the REAL server message, not a client guess");
  t.match(d.dlg.innerHTML, /1 drop.{0,3}required/);
  for (const pid of ["90000", "90001", "90002", "90003", "90004"]) t.match(d.dlg.innerHTML, new RegExp(`data-t3w-drop-pid="${pid}"`), `candidate ${pid} is offered`);
  t.match(d.dlg.innerHTML, /Filler 0/, "the desktop picker resolves candidate NAMES from the builder's own already-loaded roster data, not the worker");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes while the picker is open");

  dialogClick(d.dlg, "data-drops-act", "confirm");
  await settle(20);
  t.match(d.dlg.innerHTML, /Select 1 player/, "confirming with nothing checked is refused client-side too, before any retry");
  t.equal(mfl.st.pending.length, 0);

  dialogCheck(d.dlg, "90000", true);
  dialogClick(d.dlg, "data-drops-act", "confirm");
  const res = await p;
  t.ok(res && res.ok !== false, "the retried create succeeded once a valid drop was picked");
  t.equal(mfl.st.pending.length, 1, "the offer really was sent to MFL after the picker resolved");
});

test("DESKTOP: cancelling the picker throws the ORIGINAL 409 back to the caller — nothing is sent", async () => {
  const { env, mfl } = world();
  const d = loadDesktop(env);
  const apiUrl = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const p = d.api.submitTradeCreateWithGates(apiUrl, offerBody(), "0001");
  await settle(40);
  dialogClick(d.dlg, "data-drops-act", "cancel");
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  t.ok(threw, "the promise rejects rather than silently resolving");
  t.equal(threw.status, 409); t.equal(threw.data.code, "loaded_contract_drops_required");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes when the owner cancels");
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
      if (id === "ups-m-drops-close" || id === "ups-m-drops-cancel" || id === "ups-m-drops-go") return freshButton(id);
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
  const start = MOBILE_SRC.indexOf("  function buildPlayerNamesForFid(fid, playerIds) {");
  const end = MOBILE_SRC.indexOf("  function submitOffer() {");
  if (start < 0 || end < 0 || end < start) throw new Error("could not locate the mobile drop-gate helpers in views/trade.js");
  const code = MOBILE_SRC.slice(start, end);
  const win = { UPS_TRADE_3WAY: T };
  const openCreateCapAckStub = "function openCreateCapAckSheet() { throw new Error('cap-ack path not exercised in this test'); }\n";
  const factory = new Function("window", "document", "fetch", "U", "builderState", "T",
    openCreateCapAckStub + code + "\n  return { openCreateLoadedContractDropsSheet, submitTradeCreateWithGatesMobile };");
  const api = factory(win, doc, workerFetch(env, log), U, builderState, T);
  return { api, app, registry, log, bodyChangeTarget, sheet: () => registry["ups-m-drops-overlay"] };
}
function mobileClick(m, id) {
  const btn = m.registry[id];
  if (!btn) throw new Error(`no #${id} is rendered`);
  (btn.__listeners.click || []).forEach((fn) => fn({}));
}
function mobileCheck(m, pid, checked) {
  const box = { checked, matches: (sel) => sel.indexOf("data-t3w-drop-pid") !== -1, getAttribute: (a) => (a === "data-t3w-drop-pid" ? pid : null) };
  (m.bodyChangeTarget.__listeners.change || []).forEach((fn) => fn({ target: box }));
}

test("MOBILE: a 5->6 create is refused BEFORE anything is sent, the picker shows the right franchise/count/candidates from the REAL 409, and a valid pick lets the SAME request go through", async () => {
  const { env, mfl } = world();
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B`;
  const p = m.api.submitTradeCreateWithGatesMobile(url, offerBody(), "0001");
  await settle(40);
  t.ok(m.sheet(), "the picker sheet opened BEFORE anything was sent");
  const html1 = m.sheet().innerHTML;
  t.match(html1, /L\.A\. Looks would move from 5 to 6 loaded contracts/, "the REAL server message");
  for (const pid of ["90000", "90001", "90002", "90003", "90004"]) t.match(html1, new RegExp(`data-t3w-drop-pid="${pid}"`), `candidate ${pid} is offered`);
  t.match(html1, /Filler 2/, "the mobile picker resolves candidate names from builderState.inv, not the worker");
  t.equal(mfl.st.pending.length, 0);

  mobileClick(m, "ups-m-drops-go");
  await settle(20);
  t.match(m.sheet().innerHTML, /Select 1 player/, "confirming with nothing checked is refused client-side too");
  t.equal(mfl.st.pending.length, 0);

  mobileCheck(m, "90002", true);
  mobileClick(m, "ups-m-drops-go");
  const res = await p;
  t.ok(res && res.ok, "the retried create succeeded once a valid drop was picked");
  t.equal(mfl.st.pending.length, 1, "the offer really was sent to MFL after the picker resolved");
});

test("MOBILE: closing the picker resolves null -- submitTradeCreateWithGatesMobile returns null, matching the existing 'declined' no-op convention", async () => {
  const { env, mfl } = world();
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B`;
  const p = m.api.submitTradeCreateWithGatesMobile(url, offerBody(), "0001");
  await settle(40);
  mobileClick(m, "ups-m-drops-cancel");
  const res = await p;
  t.equal(res, null);
  t.equal(mfl.st.pending.length, 0, "zero MFL writes when the owner cancels");
});

await run("trade_loaded_contract_clients");
restore();
