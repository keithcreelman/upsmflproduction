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
    stateCode + code + "\n  return { confirmOfferLoadedContractDrops, submitTradeCreateWithGates, confirmOfferCapOverage };");
  const api = factory(win, document, workerFetch(env, log));
  return { api, dlg, log };
}

test("DESKTOP: a 5->6 create is refused BEFORE anything is sent, the picker shows the right franchise/count/candidates from the REAL 409, and even a fully VALID pick still HOLDS -- no conditional-drop executor exists (Keith's ruling, 2026-09-29)", async () => {
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

  // A genuinely valid, sufficient pick is retried against the REAL worker -- which refuses it
  // too, since satisfying a selection is not executing it. The dialog must show this as a
  // TERMINAL, honest notice (never loop back into the interactive picker, never imply the owner
  // can act their way past it), and the promise must still ultimately reject -- nothing was sent.
  dialogCheck(d.dlg, "90000", true);
  dialogClick(d.dlg, "data-drops-act", "confirm");
  await settle(40);
  t.match(d.dlg.innerHTML, /conditional-drop execution isn't built yet/i, "the dialog now shows the TERMINAL held notice, not the picker again");
  t.doesNotMatch(d.dlg.innerHTML, /data-t3w-drop-pid/, "no checkboxes -- nothing left for the owner to do here");
  t.doesNotMatch(d.dlg.innerHTML, /Confirm and send/, "no retry loop -- only a Close button");
  let threw = null;
  dialogClick(d.dlg, "data-drops-act", "cancel");   // the terminal notice's only button, labeled "Close"
  try { await p; } catch (e) { threw = e; }
  t.ok(threw, "the promise still rejects -- a satisfied-but-unexecutable selection never resolves as success");
  t.equal(threw.status, 409);
  t.equal(mfl.st.pending.length, 0, "zero MFL writes -- a fully valid, satisfied selection STILL never sends the offer");
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
      if (id === "ups-m-drops-close" || id === "ups-m-drops-cancel" || id === "ups-m-drops-go" || id === "ups-m-drops-close-terminal") return freshButton(id);
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

test("MOBILE: a 5->6 create is refused BEFORE anything is sent, the picker shows the right franchise/count/candidates from the REAL 409, and even a fully VALID pick still HOLDS -- no conditional-drop executor exists (Keith's ruling, 2026-09-29)", async () => {
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

  // A genuinely valid, sufficient pick is retried against the REAL worker -- which refuses it
  // too, since satisfying a selection is not executing it. The sheet must show a TERMINAL,
  // honest notice, never loop back into the picker, and the promise must still resolve null.
  mobileCheck(m, "90002", true);
  mobileClick(m, "ups-m-drops-go");
  await settle(40);
  t.match(m.sheet().innerHTML, /conditional-drop execution isn't built yet/i, "the sheet now shows the TERMINAL held notice, not the picker again");
  t.doesNotMatch(m.sheet().innerHTML, /data-t3w-drop-pid/, "no checkboxes -- nothing left for the owner to do here");
  t.doesNotMatch(m.sheet().innerHTML, /Confirm and send/, "no retry loop -- only a Close button");
  mobileClick(m, "ups-m-drops-close-terminal");
  const res = await p;
  t.equal(res, null, "a satisfied-but-unexecutable selection resolves null, matching the 'declined' convention -- never a success");
  t.equal(mfl.st.pending.length, 0, "zero MFL writes -- a fully valid, satisfied selection STILL never sends the offer");
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

test("DESKTOP CREATE — HAMMER TIMES / CHIG OKONKWO: the RECIPIENT (not the sender) would go over the limit -- no picker opens (nothing for the sender to pick), but the exact warning surfaces before anything is sent, and nothing is", async () => {
  const { env, mfl } = hammerWorld();
  const d = loadDesktop(env);
  const apiUrl = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  let threw = null;
  try { await d.api.submitTradeCreateWithGates(apiUrl, hammerOfferBody(), "0001"); } catch (e) { threw = e; }
  t.ok(threw, "the send must be refused");
  t.equal(threw.status, 409);
  t.match(threw.message, /HammerTime would move from 5 to 6 loaded contracts\. The maximum is 5, so 1 conditional drop/, "the sender sees the exact warning, naming HammerTime, before anything is sent");
  t.ok(!d.dlg.hasAttribute("open"), "no interactive picker opens -- this is HammerTime's own requirement, not the sender's to pick");
  t.equal(mfl.st.pending.length, 0, "no native MFL offer was ever sent");
});

test("MOBILE CREATE — HAMMER TIMES / CHIG OKONKWO: the SAME scenario surfaces the SAME warning to the sender, with the SAME zero-picker/zero-send behavior as desktop", async () => {
  const { env, mfl } = hammerWorld();
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`;
  const resp = await m.api.submitTradeCreateWithGatesMobile(url, hammerOfferBody(), "0001");
  t.ok(resp, "must NOT silently resolve as if the owner had simply declined a picker -- there was no picker to decline");
  t.equal(resp.status, 409);
  t.match(resp.body && resp.body.error, /HammerTime would move from 5 to 6 loaded contracts\. The maximum is 5, so 1 conditional drop/, "the SAME exact warning as desktop, naming HammerTime");
  t.ok(!m.sheet(), "no picker sheet opens on mobile either -- consistent with desktop");
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

test("DESKTOP ACCEPT: the RECIPIENT's own 5->6 shows the picker on review, Accept is withheld, and STAYS withheld even after a fully valid pick + Confirm selection -- satisfied is not executed, so Accept never becomes available (Keith's ruling, 2026-09-29)", async () => {
  const { env, mfl } = world();
  // Flip the direction: 0002 is now the one who will RECEIVE a loaded player. At 4 loaded
  // (under the limit), creation succeeds -- the create-time gate now also checks the
  // RECIPIENT's own side (Keith, 2026-09-30: "show me before Send" must never depend on the
  // recipient reviewing first, so a recipient ALREADY over the limit is refused right here too;
  // see the dedicated create-time test below). This test's own job is the case create-time
  // cannot catch: 0002's roster changes AFTER this offer is created but BEFORE they review it --
  // exactly the "recalculate immediately before completion" principle -- so the picker must
  // still appear at accept, from a live re-check, never trusted from create time.
  mfl.st.rosters["0001"] = [{ id: "14056", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA-FL" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: 5000, contractYear: 3, contractStatus: "Vet-FAA" }, ...loadedFillers(90000, 4)];
  const createRes = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: offerBody() });
  t.equal(createRes.status, 201, createRes.text.slice(0, 300));
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  mfl.st.rosters["0002"].push(...loadedFillers(90004, 1)); // a 5th loaded contract lands on 0002 between create and accept

  const d = loadDesktopAccept(env);
  const p = d.api.reviewBeforeAccept(d.url, previewBody2(id));
  await settle(40);
  t.match(d.dlg.innerHTML, /CBP would move from 5 to 6 loaded contracts/, "the REAL server message for the RECIPIENT's own franchise");
  t.ok(!d.dlg.has("accept-confirm"), "Accept is withheld until the requirement is satisfied");
  for (const pid of ["90000", "90001", "90002", "90003", "90004"]) t.match(d.dlg.innerHTML, new RegExp(`data-t3w-drop-pid="${pid}"`));
  t.equal(mfl.st.done.length, 0, "zero MFL writes while the review is open");

  d.dlg.check("90000", true);
  d.dlg.click("select-drops");
  await settle(40);
  // The selection IS recorded and reported as satisfied -- SELECT_DROPS itself never writes to
  // MFL, and satisfying a selection is real, useful progress -- but it is NOT the same thing as
  // an EXECUTED drop, and Accept must stay withheld regardless (no code anywhere drops a real
  // player yet -- docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md).
  t.ok(!d.dlg.has("accept-confirm"), "Accept is STILL withheld -- a satisfied selection never unblocks it while no executor exists");
  t.match(d.dlg.innerHTML, /Selected: Player 90000/, "the confirmed selection is shown back, by id (this dialog has no full roster data to resolve a name)");
  t.match(d.dlg.innerHTML, /isn't (built|available) yet/i, "the review honestly explains WHY it's still held");
  t.equal(mfl.st.done.length, 0, "SELECT_DROPS never itself writes to MFL");

  // With no accept-confirm button rendered, the owner's only path is Not now -- the review
  // resolves false, exactly like any other un-acceptable state.
  d.dlg.click("accept-close");
  t.equal(await p, false);
  t.equal(mfl.st.done.length, 0, "zero MFL writes across the entire review, satisfied selection included");
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

test("MOBILE ACCEPT: the RECIPIENT's own 5->6 shows the picker on review, Accept is withheld, and STAYS withheld even after a fully valid pick + Confirm selection -- satisfied is not executed, so Accept never becomes available (Keith's ruling, 2026-09-29)", async () => {
  const { env, mfl } = world();
  // Same setup as the DESKTOP ACCEPT test above: 0002 is under the limit at create time (the
  // create-time gate now also checks the recipient -- see the dedicated create-time test below),
  // and gains its 5th loaded contract AFTER creation, before this review -- proving the
  // accept-time re-check is live, not trusted from create time.
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
  t.match(sheet().innerHTML, /CBP would move from 5 to 6 loaded contracts/, "the REAL server message");
  t.ok(!sheet().has("accept-confirm"), "Accept is withheld until the requirement is satisfied");
  t.equal(mfl.st.done.length, 0);

  sheet().check("90001", true);
  sheet().click("select-drops");
  await settle(40);
  // Selected and reported satisfied (SELECT_DROPS itself never writes to MFL) -- but satisfying
  // a selection is not the same thing as an EXECUTED drop, so Accept must stay withheld
  // regardless (Keith's ruling, 2026-09-29; docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md).
  t.ok(!sheet().has("accept-confirm"), "Accept is STILL withheld -- a satisfied selection never unblocks it while no executor exists");
  t.match(sheet().innerHTML, /Selected: Player 90001/);
  t.match(sheet().innerHTML, /isn't (built|available) yet/i, "the review honestly explains WHY it's still held");
  t.equal(mfl.st.done.length, 0, "zero MFL writes across the entire review, satisfied selection included");
});

await run("trade_loaded_contract_clients");
restore();
