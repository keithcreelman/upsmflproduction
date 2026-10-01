// MOBILE COUNTER + CUTOVER: the REAL mobile client function (site/m/views/trade.js's
// submitTradeCounterWithGatesMobile / submitCounterViaStagingFallbackMobile), run in Node
// against a small fake DOM, with fetch() going to the REAL worker (real SQLite D1, a stateful
// fake MFL) -- exactly the technique tests/trade_loaded_contract_clients.test.mjs and
// tests/trade_2way_staged_clients.test.mjs already established.
//
// Root cause under test (Keith, 2026-09-30): once TRADE_2WAY_CUTOVER_ENABLED is on, the legacy
// COUNTER action 409s with staging_required (tests/trade_2way_cutover_switch.test.mjs already
// proves the SERVER refuses it correctly and leaves the original offer untouched) -- but the
// mobile client's dedicated counter path did a raw fetch() with NO staging_required handling,
// so the owner just saw a bare 409 with no way to actually send their revised terms. "A bare
// 409 is not an acceptable release experience." This proves the fix: the real client function
// falls through to staging (same as CREATE already does), stages the counter's revised terms
// as a new offer, and NEVER touches the original native offer being countered.
//   node tests/trade_2way_counter_staging_fallback_clients.test.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, workerFetch, quiet } from "./fixtures/worker_harness.mjs";
import { makeEl, settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const require = createRequire(import.meta.url);
const T = require("../site/shared/trade_3way_view.js");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const restore = quiet();
const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function world(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_CUTOVER_ENABLED: "1", ...((over && over.env) || {}) });
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}

function trackListeners(el) {
  el.__listeners = {};
  el.addEventListener = (type, fn) => { (el.__listeners[type] = el.__listeners[type] || []).push(fn); };
  return el;
}

// Legacy COUNTER body shape -- 0001 (the recipient of a pending offer FROM 0002) countering
// back with its own revised terms, exactly mirroring tests/trade_2way_cutover_switch.test.mjs's
// "STALE CLIENT: the legacy COUNTER action is ALSO refused" recipe.
function counterBody(tid, { from = "0001", to = "0002", fromPid = 14056, toPid = 13100 } = {}) {
  return {
    action: "COUNTER", trade_id: tid, league_id: "74598", season: "2026", franchise_id: from, acting_franchise_id: from,
    counter_offer: {
      from_franchise_id: from, to_franchise_id: to, message: "",
      payload: {
        schema_version: 1, source: "test", league_id: "74598", season: "2026",
        teams: [
          { role: "left", franchise_id: from, selected_assets: [{ asset_id: "P_" + fromPid, type: "PLAYER", player_id: String(fromPid), player_name: "P" + fromPid, salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
          { role: "right", franchise_id: to, selected_assets: [{ asset_id: "P_" + toPid, type: "PLAYER", player_id: String(toPid), player_name: "P" + toPid, salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
        ],
        extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
      },
    },
  };
}

// ───────────────────────────────── the REAL mobile counter-gate functions ─────────────────────────────────
// Two discontiguous real slices of site/m/views/trade.js, concatenated: (1) the create-gate
// block (buildPlayerNamesForFid .. submitOffer, which now also carries
// submitTradeCounterWithGatesMobile / submitCounterViaStagingFallbackMobile, placed right
// before submitOffer in the real file) and (2) the pre-send-popup + movement-conversion block
// (tw2sFetch, and separately showPreSendLoadedContractSheet .. submitStagedOffer) -- so
// runPreSendPreview, tw2sMovementsFromPayload and friends are the REAL, unstubbed functions,
// not a re-implementation.
function loadMobile(env, { token = "tok-B" } = {}) {
  const log = [];
  const registry = {};
  const app = trackListeners(makeEl("ups-m-app"));
  app.insertAdjacentHTML = (pos, html) => {
    const overlay = trackListeners(makeEl("ups-m-presend-overlay"));
    Object.defineProperty(overlay, "outerHTML", { set(v) { overlay.innerHTML = v; }, get() { return overlay.innerHTML; } });
    overlay.innerHTML = html;
    overlay.remove = () => { delete registry["ups-m-presend-overlay"]; };
    registry["ups-m-presend-overlay"] = overlay;
  };
  function freshButton(id) { const btn = trackListeners(makeEl(id)); registry[id] = btn; return btn; }
  const bodyChangeTarget = trackListeners(makeEl("ups-m-presend-body"));
  const document = {
    getElementById: (id) => {
      if (id === "ups-m-app") return app;
      if (id === "ups-m-presend-overlay") return registry["ups-m-presend-overlay"] || null;
      if (id === "ups-m-presend-close" || id === "ups-m-presend-cancel" || id === "ups-m-presend-go") return freshButton(id);
      return null;
    },
    querySelector: (sel) => (sel === "#ups-m-presend-overlay .ups-m-drop-body" ? bodyChangeTarget : null),
    body: { style: {} },
  };
  const U = {
    pad4: (v) => { const dg = String(v || "").replace(/\D/g, ""); return dg ? dg.padStart(4, "0").slice(-4) : ""; },
    safeStr: (v) => (v == null ? "" : String(v).trim()),
    safeInt: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d == null ? 0 : d); },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  };
  const builderState = { inv: { "0001": { players: [] }, "0002": { players: [] } } };
  const NAMES = { "0001": "L.A. Looks", "0002": "Hammer Times" };
  const franchiseName = (fid) => NAMES[U.pad4(fid)] || ("Team " + fid);
  const M = {
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token },
    state: { ctx: { leagueId: "74598", year: "2026" } },
  };
  const start1 = MOBILE_SRC.indexOf("  function showLoadedContractBlockSheet(errData) {");
  const end1 = MOBILE_SRC.indexOf("  function submitOffer() {");
  if (start1 < 0 || end1 < 0 || end1 < start1) throw new Error("could not locate the mobile create/counter-gate block in trade.js");
  const start2a = MOBILE_SRC.indexOf("  function tw2sFetch(url, init) {");
  const end2a = MOBILE_SRC.indexOf("  function tw2sTone(trade) {");
  if (start2a < 0 || end2a < 0 || end2a < start2a) throw new Error("could not locate tw2sFetch in trade.js");
  const start2b = MOBILE_SRC.indexOf("  function showPreSendLoadedContractSheet(compliance) {");
  const end2b = MOBILE_SRC.indexOf("  function submitStagedOffer() {");
  if (start2b < 0 || end2b < 0 || end2b < start2b) throw new Error("could not locate the mobile pre-send-popup block in trade.js");
  const code = MOBILE_SRC.slice(start1, end1) + "\n" + MOBILE_SRC.slice(start2a, end2a) + "\n" + MOBILE_SRC.slice(start2b, end2b);
  const openCreateCapAckStub = "function openCreateCapAckSheet() { throw new Error('cap-ack path not exercised in this test'); }\n";
  const factory = new Function("window", "document", "fetch", "U", "builderState", "T", "M", "franchiseName",
    openCreateCapAckStub + code + "\n  return { submitTradeCounterWithGatesMobile, submitTradeCreateWithGatesMobile };");
  const win = { UPS_TRADE_3WAY: T };
  const api = factory(win, document, workerFetch(env, log), U, builderState, T, M, franchiseName);
  return { api, app, registry, log, sheet: () => registry["ups-m-presend-overlay"], bodyChangeTarget };
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

test("COUNTER + CUTOVER: a bare 409 is never shown -- the REAL mobile client falls through to staging, creates a new staged offer with the counter's revised terms, and the ORIGINAL native offer is left completely untouched", async () => {
  const { env, mfl } = world();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const tid = mfl.addPending({ offeringteam: "0002", offeredto: "0001", will_give_up: "13100,", will_receive: "14056," });
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`;
  const resp = await m.api.submitTradeCounterWithGatesMobile(url, counterBody(tid), "0001");
  await settle(40);

  t.ok(resp, "never resolves to nothing -- a real outcome, not a silent no-op");
  t.equal(resp.ok, true, "the fallback succeeds -- not a bare 409");
  t.equal(resp.body && resp.body.ok, true);
  t.equal(resp.body && resp.body.staged, true, "surfaces as a staged offer, same convention submitOffer's .then already checks for CREATE");
  t.equal(resp.body && resp.body.counter_staged, true, "flagged distinctly so the UI can tell the owner the original wasn't auto-declined");
  t.ok(resp.body && resp.body.id, "a real staged-trade id came back");

  // The original native offer: untouched. No MFL import (reject or otherwise) happened.
  t.equal(mfl.st.imports.length, 0, "zero MFL writes -- the original offer was never rejected as a side effect");
  const stillPending = mfl.st.pending.find((p) => p.trade_id === tid);
  t.ok(stillPending, "the original native offer is still pending, exactly as the server-side cutover test already proves");

  // A real row now exists in the staged-2way table with the COUNTER's revised terms (0001 -> 0002).
  const row = await env.UPS_MFL_DB.prepare("SELECT * FROM ups_2way_trades WHERE id=?").bind(resp.body.id).first();
  t.ok(row, "a real ups_2way_trades row was created");
  t.equal(row.from_fid, "0001"); t.equal(row.to_fid, "0002");
  const movements = JSON.parse(row.movements_json || "[]");
  t.ok(movements.some((mv) => (mv.asset_tokens || []).includes("P_14056")), "the counter's own revised terms made it into the staged offer, not the original offer's terms");
});

test("COUNTER + CUTOVER: no assets in the counter's revised terms refuses client-side, before any network call -- no MFL write, no staged row", async () => {
  const { env, mfl } = world();
  const tid = mfl.addPending({ offeringteam: "0002", offeredto: "0001", will_give_up: "13100,", will_receive: "14056," });
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`;
  const empty = counterBody(tid);
  empty.counter_offer.payload.teams[0].selected_assets = [];
  empty.counter_offer.payload.teams[1].selected_assets = [];
  const resp = await m.api.submitTradeCounterWithGatesMobile(url, empty, "0001");
  t.equal(resp.ok, false);
  t.equal(resp.body && resp.body.code, "no_assets");
  t.equal(mfl.st.imports.length, 0);
  t.equal((await env.UPS_MFL_DB.prepare("SELECT COUNT(*) AS n FROM ups_2way_trades").first()).n, 0, "no staged row was created");
});

test("COUNTER + CUTOVER: the REAL pre-send loaded-contract popup fires for the counter's revised terms too (real code, not a stub) -- declining it stages nothing and leaves the original offer untouched", async () => {
  const { env, mfl } = world();
  // 0001 already has 5 loaded contracts; the counter's revised terms would RECEIVE a 6th,
  // exactly the 5->6 shape tests/trade_loaded_contract_clients.test.mjs already covers for CREATE.
  const loadedFillers = Array.from({ length: 5 }, (_, i) => ({ id: String(90000 + i), salary: 1000, contractYear: 3, contractStatus: "Vet-Ext2-BL" }));
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA" }, ...loadedFillers];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "3", contractStatus: "Vet-Ext2-BL" }];
  const tid = mfl.addPending({ offeringteam: "0002", offeredto: "0001", will_give_up: "13100,", will_receive: "14056," });
  const m = loadMobile(env);
  const url = `https://worker.test/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`;
  const p = m.api.submitTradeCounterWithGatesMobile(url, counterBody(tid, { fromPid: 14056, toPid: 13100 }), "0001");
  await settle(40);

  t.ok(m.sheet(), "the REAL pre-send sheet opened for the counter's own revised terms, before anything was sent");
  const sheetHtml = m.sheet().innerHTML;
  t.match(sheetHtml, /L\.A\. Looks/, "the real compliance-preview franchise name, not a client guess");
  t.match(sheetHtml, /would have 6 loaded contracts \(including IR\) after this trade — the limit is 5/, "the real projected count from the server");
  t.match(sheetHtml, /Revise the offer, or make a separate roster move first/);
  t.doesNotMatch(sheetHtml, /data-t3w-drop-pid/, "no picker -- nothing to pick");
  t.equal(mfl.st.imports.length, 0, "zero MFL writes while the popup is open");

  mobileClick(m, "ups-m-presend-cancel");
  const resp = await p;
  t.equal(resp.ok, true); t.equal(resp.body.ok, false); t.equal(resp.body.code, "staging_declined_by_owner");
  t.equal(mfl.st.imports.length, 0, "still zero MFL writes");
  const stillPending = mfl.st.pending.find((x) => x.trade_id === tid);
  t.ok(stillPending, "the original native offer is untouched");
  t.equal((await env.UPS_MFL_DB.prepare("SELECT COUNT(*) AS n FROM ups_2way_trades").first()).n, 0, "declining the popup stages nothing");
});

await run("trade_2way_counter_staging_fallback_clients");
