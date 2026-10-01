// OFFER REVIEW: LIVE LOADED-CONTRACT COMPLIANCE (Keith's ruling, 2026-10-02): "The production
// Offer Review is still wrong... Real Deal Creel sends Chig Okonkwo (Vet-FAA-FL) to HammerTime
// for a 2027 first-round pick. The panel says 'Ready' and shows no loaded-contract warning...
// Show 'HammerTime: 6 loaded contracts; maximum 5. Revise the trade or make a separate roster
// move first,' mark the overall offer Not ready, and disable Send while this condition exists.
// If compliance cannot be calculated, show 'Cannot verify loaded-contract limit' and fail
// closed... Use the same authoritative classifier and current roster snapshot as the server's
// create/accept gate... prove the preview and final gate agree."
//
// Before this fix, buildValidationSummary()/payload.validation.status was a PURELY LOCAL,
// structural check (non-empty sides, salary within max, no ineligible assets) with zero
// awareness of cap/loaded-contract/lineup compliance -- the hard-block dialog from an earlier
// round only fired reactively on the CREATE POST's 409, after Send was already clicked. This
// file proves the NEW client-side functions (desktop: offerComplianceSignature/
// refreshOfferComplianceIfNeeded/offerIsReady/offerStatusLabel/renderOfferAlerts in
// trade_workbench.js; mobile: builderComplianceSignature/refreshBuilderComplianceIfNeeded/
// builderComplianceAlertHtml in views/trade.js) call the SAME /api/trades/compliance-preview
// endpoint -- running the SAME evaluateTradeCompliance() against the SAME live roster snapshot
// -- that worker/src/index.js's native /api/trades/proposals create gate uses, and that BOTH
// surfaces reach the IDENTICAL verdict for the IDENTICAL roster snapshot. No real trade is ever
// created, submitted, accepted, or dropped anywhere in this file (mfl.st.pending/imports are
// asserted empty throughout).
//
// Real franchise ids (tests/fixtures/worker_harness.mjs NAMES): 0008 = "Real Deal Creel"
// (Keith's own team), 0005 = "HammerTime" -- the exact two teams in Keith's report, not generic
// stand-ins.
//   node tests/trade_offer_review_loaded_contract_preview.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const worker = (await (async () => { await import("./fixtures/register_md_loader.mjs"); return import("../worker/src/index.js"); })()).default;

const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const SENDER = "0008", HAMMER = "0005"; // Real Deal Creel -> HammerTime, exactly as reported

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, ...((over && over.env) || {}) });
  bindSelf(env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}
const loadedIds = (from, count, cs = "Vet-Ext2-BL") => Array.from({ length: count }, (_, i) => ({ id: String(from + i), salary: 1000, contractStatus: cs }));
// HammerTime's starting 5 loaded contracts (one on IR), the SAME shape Keith's own prior
// end-to-end coverage (tests/trade_hammer_chig_end_to_end.test.mjs) and the native create-gate
// coverage (tests/trade_loaded_contracts.test.mjs) already use for this exact scenario.
function hammerRosterFiveLoadedOneIR() {
  return [
    { id: "13100", salary: 5000, contractStatus: "Vet-FAA" },
    ...loadedIds(9000, 4),
    { id: "9004", salary: 1000, contractStatus: "Vet-Ext2-BL", status: "INJURED_RESERVE" },
  ];
}
// Chig Okonkwo -- a loaded contract, status "Vet-FAA-FL" exactly as Keith quoted it (no explicit
// year schedule needed: resolveLoadedStatus falls back to the contractStatus -FL/-BL suffix when
// contractInfo carries no schedule -- see worker/src/contract_classification.js).
const CHIG = { id: "20001", salary: 5000, contractStatus: "Vet-FAA-FL" };

// ── a bridge that routes fetch() straight into the REAL worker (no network), reused from the
// established pattern in tests/trade_hammer_chig_end_to_end.test.mjs ──
function bridgeFetch(env) {
  const calls = [];
  const fn = async (input, init) => {
    init = init || {};
    const url = new URL(String(input));
    calls.push({ method: (init.method || "GET").toUpperCase(), path: url.pathname, body: init.body ? JSON.parse(init.body) : null });
    const request = new Request(url, { method: init.method || "GET", headers: { "Content-Type": "application/json" }, body: init.body });
    const waits = [];
    const resp = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.allSettled(waits);
    const text = await resp.text();
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}
// The real tw2sFetch's own logic (site/trades/trade_workbench.js / site/m/views/trade.js), just
// fed the bridge above instead of the global fetch -- proves the SAME parsing/fail-closed
// behavior, not a re-invented stand-in.
function makeTw2sFetch(bridge) {
  return (url, init) => bridge(url, init).then((r) => r.text().then((txt) => {
    let body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {}
    return { status: r.status, ok: r.ok, body: body };
  })).catch(() => ({ networkError: true }));
}
const safeStr = (v) => (v == null ? "" : String(v).trim());
const safeInt = (v, fb) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (fb == null ? 0 : fb); };
const pad4 = (v) => { const d = safeStr(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
const escapeHtml = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ═══════════════════════════════════ DESKTOP extraction ═══════════════════════════════════
// Extracts the REAL, un-modified offerComplianceSignature/refreshOfferComplianceIfNeeded/
// offerIsReady/offerStatusLabel/renderOfferAlerts functions from site/trades/trade_workbench.js
// (located by their own distinctive opening lines, not a hardcoded line number) and runs them
// against a real worker via the bridge above -- the SAME technique
// tests/trade_hammer_chig_end_to_end.test.mjs already established for this file.
function loadDesktopOfferReview(env, { token, fid, tw2sFetchOverride }) {
  const bridge = bridgeFetch(env);
  const s1 = DESK_SRC.indexOf("  function offerComplianceSignature(payload) {");
  const e1 = DESK_SRC.indexOf("  function formatSignedK(v) {");
  if (s1 < 0 || e1 < 0) throw new Error("desktop: could not locate offerComplianceSignature..offerStatusLabel -- source may have moved");
  const s2 = DESK_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e2 = DESK_SRC.indexOf('  var tw2s = { listStatus: "idle"');
  if (s2 < 0 || e2 < 0) throw new Error("desktop: could not locate tw2sAssetToken/tw2sMovementsFromPayload -- source may have moved");
  const s3 = DESK_SRC.indexOf("  function renderOfferAlerts(payload) {");
  const e3 = DESK_SRC.indexOf("  function renderSummary() {");
  if (s3 < 0 || e3 < 0) throw new Error("desktop: could not locate renderOfferAlerts..renderSubmitArea -- source may have moved");
  // getPrimarySubmitIntent/getSecondarySubmitActions -- renderSubmitArea's own dependencies,
  // extracted too so the test can inspect the REAL rendered Submit button (.disabled/
  // .textContent on a fake els.submitOfferBtn), not just the boolean offerIsReady() returns.
  const s4 = DESK_SRC.indexOf("  function getPrimarySubmitIntent(payload) {");
  const e4 = DESK_SRC.indexOf("  function moveToOfferReview() {");
  if (s4 < 0 || e4 < 0) throw new Error("desktop: could not locate getPrimarySubmitIntent/getSecondarySubmitActions -- source may have moved");
  const code = DESK_SRC.slice(s1, e1) + "\n" + DESK_SRC.slice(s2, e2) + "\n" + DESK_SRC.slice(s3, e3) + "\n" + DESK_SRC.slice(s4, e4);

  const state = {
    counterMode: false, rightTeamId: "0005", reviewContext: {},
    submit: { busy: false, message: "", tone: "", canRetry: false, acceptDebug: null },
    offers: { actionBusy: false },
    offerCompliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 },
  };
  let renders = 0;
  const renderSummary = () => { renders += 1; };
  const document = { createElement: () => ({ className: "", textContent: "" }) };
  const els = {
    // innerHTML = "" must clear children too -- renderOfferAlerts always resets innerHTML
    // first, exactly like a real DOM element's would, and several of these tests call it more
    // than once per test (to prove a stale alert clears when the composition changes).
    offerAlerts: {
      _html: "", children: [],
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
      appendChild(n) { this.children.push(n); },
    },
    submitOfferBtn: { disabled: false, textContent: "", setAttribute() {} },
    submitOfferStatus: { textContent: "", className: "" },
  };
  const getLeagueContext = () => ({ leagueId: "74598", season: "2026" });
  const resolveCompliancePreviewApiUrl = () => `https://worker.test/api/trades/compliance-preview?${Q}&MFL_USER_ID=${token}`;
  const tw2sFetch = tw2sFetchOverride || makeTw2sFetch(bridge);

  const factory = new Function("state", "safeStr", "safeInt", "pad4", "getLeagueContext", "resolveCompliancePreviewApiUrl", "tw2sFetch", "renderSummary", "document", "els",
    code + "\nreturn { offerComplianceSignature, refreshOfferComplianceIfNeeded, offerIsReady, offerStatusLabel, renderOfferAlerts, renderSubmitArea, getPrimarySubmitIntent, tw2sAssetToken, tw2sMovementsFromPayload };");
  const api = factory(state, safeStr, safeInt, pad4, getLeagueContext, resolveCompliancePreviewApiUrl, tw2sFetch, renderSummary, document, els);
  void fid;
  return { api, state, els, renders: () => renders, calls: bridge.calls };
}

// ═══════════════════════════════════ MOBILE extraction ═══════════════════════════════════
function loadMobileOfferReview(env, { token }) {
  const bridge = bridgeFetch(env);
  const s1 = MOBILE_SRC.indexOf("  function builderComplianceSignature(payload) {");
  const e1 = MOBILE_SRC.indexOf("  // The INITIATOR's own overage");
  if (s1 < 0 || e1 < 0) throw new Error("mobile: could not locate builderComplianceSignature..builderComplianceAlertHtml -- source may have moved");
  const s2 = MOBILE_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e2 = MOBILE_SRC.indexOf("  function submitStagedOffer() {");
  if (s2 < 0 || e2 < 0) throw new Error("mobile: could not locate tw2sAssetToken/tw2sMovementsFromPayload -- source may have moved");
  const code = MOBILE_SRC.slice(s1, e1) + "\n" + MOBILE_SRC.slice(s2, e2);

  const builderState = { compliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 } };
  const U = { pad4, safeStr, safeInt, escapeHtml };
  let renders = 0;
  const renderBuilder = () => { renders += 1; };
  const M = { state: { ctx: { leagueId: "74598", year: "2026" } }, api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token } };
  const tw2sFetch = makeTw2sFetch(bridge);

  const factory = new Function("builderState", "U", "M", "tw2sFetch", "renderBuilder",
    code + "\nreturn { builderComplianceSignature, refreshBuilderComplianceIfNeeded, builderComplianceAlertHtml, tw2sAssetToken, tw2sMovementsFromPayload };");
  const api = factory(builderState, U, M, tw2sFetch, renderBuilder);
  return { api, builderState, renders: () => renders, calls: bridge.calls };
}

// ═══════════════════════════════════ MOBILE: the REAL review step ═══════════════════════════════════
// Extracts renderStepReview itself (not just the compliance functions it calls), plus every
// dependency it needs to actually run: franchiseName, the inventory->selected-asset helpers,
// and buildOfferPayload. Proves the REAL rendered HTML -- the Submit button's own `disabled`
// attribute and the review step's own alert markup -- not a hand-computed proxy for it.
function loadMobileReviewStep(env, { token, myFid, theirFid, tw2sFetchOverride }) {
  const bridge = bridgeFetch(env);
  const s0 = MOBILE_SRC.indexOf("  function franchiseName(fid) {");
  const e0 = MOBILE_SRC.indexOf("  // The inbox is ALWAYS one of three honest states");
  if (s0 < 0 || e0 < 0) throw new Error("mobile: could not locate franchiseName -- source may have moved");
  const s1 = MOBILE_SRC.indexOf("  function playerToSelectedAsset(p) {");
  const e1 = MOBILE_SRC.indexOf("  // ── Overlay shell ──");
  if (s1 < 0 || e1 < 0) throw new Error("mobile: could not locate playerToSelectedAsset..maxCapKFor -- source may have moved");
  const s2 = MOBILE_SRC.indexOf("  function renderStepReview(body) {");
  const e2 = MOBILE_SRC.indexOf("  function openCreateCapAckSheet(errData) {");
  if (s2 < 0 || e2 < 0) throw new Error("mobile: could not locate renderStepReview..builderComplianceAlertHtml -- source may have moved");
  const s3 = MOBILE_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e3 = MOBILE_SRC.indexOf("  function submitStagedOffer() {");
  if (s3 < 0 || e3 < 0) throw new Error("mobile: could not locate tw2sAssetToken/tw2sMovementsFromPayload -- source may have moved");
  const code = MOBILE_SRC.slice(s0, e0) + "\n" + MOBILE_SRC.slice(s1, e1) + "\n" + MOBILE_SRC.slice(s2, e2) + "\n" + MOBILE_SRC.slice(s3, e3);

  const builderState = {
    counterpartyFid: theirFid, counterMode: false,
    inv: {}, giveIds: {}, getIds: {}, myCapK: 0, theirCapK: 0,
    comment: "", submitting: false, error: "", extensions: {},
    compliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 },
  };
  const U = { pad4, safeStr, safeInt, escapeHtml, fmtUsd: (v) => "$" + Math.round(Number(v) || 0).toLocaleString("en-US") };
  let renders = 0;
  const renderBuilder = () => { renders += 1; };
  const M = {
    state: {
      ctx: { leagueId: "74598", year: "2026" }, viewerFranchiseId: myFid,
      franchises: [{ id: "0008", name: "Real Deal Creel" }, { id: "0005", name: "HammerTime" }],
    },
    api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token },
  };
  const tw2sFetch = tw2sFetchOverride || makeTw2sFetch(bridge);
  let lastHtml = "";
  const body = { get innerHTML() { return lastHtml; }, set innerHTML(v) { lastHtml = v; }, querySelectorAll: () => [] };
  // Resolves ids against whatever is CURRENTLY in body.innerHTML -- renderStepReview calls
  // document.getElementById right after setting it, so this must reflect this render's output,
  // not a stale snapshot.
  const document = {
    getElementById(id) {
      const re = new RegExp('<[a-zA-Z0-9-]+[^>]*\\bid="' + id + '"[^>]*>', "i");
      const m = re.exec(lastHtml);
      if (!m) return null;
      return { addEventListener() {}, value: "" };
    },
  };
  const window = {}; // UPS_PRETRADE_EXT left undefined -- no pre-trade extension controls in these tests

  const factory = new Function("builderState", "U", "M", "tw2sFetch", "renderBuilder", "document", "window",
    code + "\nreturn { renderStepReview, buildOfferPayload, builderComplianceSignature, refreshBuilderComplianceIfNeeded, builderComplianceAlertHtml };");
  const api = factory(builderState, U, M, tw2sFetch, renderBuilder, document, window);
  return { api, builderState, body, html: () => lastHtml, renders: () => renders, calls: bridge.calls };
}
// Whether the element with this id, AS RENDERED in html, carries the disabled attribute --
// read straight off renderStepReview's own real output string, never a hand-computed proxy.
function isDisabledInHtml(html, id) {
  const re = new RegExp('<[a-zA-Z0-9-]+[^>]*\\bid="' + id + '"[^>]*>', "i");
  const m = re.exec(html);
  if (!m) throw new Error('no element with id="' + id + '" in rendered HTML');
  return /\sdisabled(\s|>)/.test(m[0]);
}

// The payload shape both buildTradePayload() (desktop) and buildOfferPayload() (mobile) produce
// -- {teams:[{franchise_id, selected_assets, traded_salary_adjustment_k}, ...], extension_requests,
// validation}. Player/pick asset shapes match tw2sAssetToken's own PLAYER/PICK branches.
function payloadOf(from, to, giveAssets, getAssets, validationOverride) {
  return {
    teams: [
      { franchise_id: from, selected_assets: giveAssets, traded_salary_adjustment_k: 0 },
      { franchise_id: to, selected_assets: getAssets, traded_salary_adjustment_k: 0 },
    ],
    extension_requests: [],
    validation: validationOverride || { status: "ready", issues: [] },
  };
}
// What buildValidationSummary() actually produces for a genuinely empty draft (both sides
// selected, nothing chosen on either one) -- used only by the empty-draft state-matrix tests
// below, which are testing the COMPLIANCE layer's reaction to this, not buildValidationSummary
// itself (already proven elsewhere).
const EMPTY_VALIDATION = { status: "draft", issues: ["Your side has no selected assets.", "Trade partner side has no selected assets."] };
const chigAsset = { type: "PLAYER", player_id: CHIG.id };
const pickAsset = { type: "PICK", pick_key: "FP_0005_2027_1" }; // HammerTime's 2027 1st, the same token tests/fixtures/trade_3way_fixture.mjs uses for it

// ═══════════════════════════════════ DESKTOP: blocked ═══════════════════════════════════
test("DESKTOP: Real Deal Creel -> HammerTime, Chig Okonkwo (Vet-FAA-FL) for a 2027 1st -- HammerTime at 5 loaded (incl. IR) projects to 6, the live check blocks, exact wording, Not Ready, fails closed while loading", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, state, els, renders, calls } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshOfferComplianceIfNeeded(payload);
  t.equal(calls.length, 1, "exactly one compliance-preview call for this composition");
  t.equal(state.offerCompliance.status, "loading", "fires synchronously into loading, never silently stays idle/ok before the network round-trip resolves");
  t.equal(api.offerIsReady(payload), false, "fails closed while loading -- never reads as sendable mid-check");
  t.equal(api.offerStatusLabel(payload).text, "Checking…");
  api.renderSubmitArea(payload);
  t.equal(els.submitOfferBtn.disabled, true, "the REAL rendered Submit button is disabled while loading");

  await settle();
  t.equal(calls.length, 1, "settling the in-flight request fires no additional call");
  t.equal(state.offerCompliance.status, "blocked");
  t.equal(api.offerIsReady(payload), false, "Send must be disabled -- this is the exact bug Keith reported (panel said Ready)");
  t.equal(api.offerStatusLabel(payload).text, "Not Ready", "the overall offer pill -- Keith's exact wording");
  t.equal(renders(), 1, "the async result triggers exactly one re-render");

  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children.length, 1);
  t.equal(els.offerAlerts.children[0].textContent, "HammerTime: 6 loaded contracts; maximum 5. Revise the trade or make a separate roster move first.", "Keith's exact quoted wording, built from the server's own violations[] -- not the server's own differently-worded message string");
  t.equal(els.offerAlerts.children[0].className, "twb-offer-alert twb-offer-alert-bad");
  api.renderSubmitArea(payload);
  t.equal(els.submitOfferBtn.disabled, true, "the REAL rendered Submit button stays disabled once blocked");

  t.equal(mfl.st.pending.length, 0, "a preview never creates a native MFL offer");
  t.equal(mfl.st.imports.length, 0, "a preview never writes to MFL at all");
});

// ═══════════════════════════════════ DESKTOP: compliant ═══════════════════════════════════
test("DESKTOP: the SAME offer shape but HammerTime starts at only 4 loaded -- receiving Chig lands exactly at the 5 limit, not over: Ready, Send enabled, no alert rendered", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 4)]; // 4 loaded, no IR
  const { api, state, els, calls } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshOfferComplianceIfNeeded(payload);
  await settle();
  t.equal(calls.length, 1, "exactly one compliance-preview call for this composition, the SAME one that just resolved ok");
  t.equal(state.offerCompliance.status, "ok");
  t.equal(api.offerIsReady(payload), true, "Submit is enabled only because THIS composition's own preview came back ok");
  t.equal(api.offerStatusLabel(payload).text, "Ready");

  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children.length, 0, "no loaded-contract alert when the projected count is within the limit");
  api.renderSubmitArea(payload);
  t.equal(els.submitOfferBtn.disabled, false, "the REAL rendered Submit button is enabled for a compliant offer");
});

// ═══════════════════════════════════ DESKTOP: fail closed on network failure ═══════════════════════════════════
test("DESKTOP: a network/worker failure never reads as Ready -- exactly one call attempted, shows 'Cannot verify loaded-contract limit', Not Ready, Send disabled", async () => {
  const { env } = fresh();
  let attempts = 0;
  // the real tw2sFetch's own .catch(() => ({networkError:true})) isn't present here on
  // purpose -- refreshOfferComplianceIfNeeded has its OWN try/catch around the call, proven below
  const tw2sFetchOverride = () => { attempts += 1; return Promise.reject(new Error("network down")); };
  const { api, state, els } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER, tw2sFetchOverride });

  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(payload);
  t.equal(attempts, 1, "exactly one compliance-preview attempt for this composition");
  await settle();
  t.equal(attempts, 1, "settling fires no retry on its own");
  t.equal(state.offerCompliance.status, "unavailable");
  t.equal(api.offerIsReady(payload), false, "fails closed -- an unreadable compliance check must never read as sendable");
  t.equal(api.offerStatusLabel(payload).text, "Not Ready");
  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children[0].textContent, "Cannot verify loaded-contract limit. Try again in a moment.", "Keith's exact fail-closed wording");
  api.renderSubmitArea(payload);
  t.equal(els.submitOfferBtn.disabled, true, "the REAL rendered Submit button is disabled when compliance can't be verified");
});

// ═══ DESKTOP STATE MATRIX: empty, and changed-composition/stale-discard ═══ (Keith's ruling,
// 2026-10-02, second pass): "before I add any assets, Offer Review shows a red 'Cannot verify
// loaded-contract limit' error on an empty draft... Do not call compliance-preview or show a
// network/compliance error before there is a meaningful offer... Clear stale warnings whenever
// assets change and recalculate for the new terms."
test("DESKTOP STATE MATRIX — empty draft: ZERO compliance-preview calls, neutral Draft, 'Add assets to build an offer.', Submit disabled", async () => {
  const { env, mfl } = fresh();
  const { api, state, els, calls } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [], [], EMPTY_VALIDATION);

  api.refreshOfferComplianceIfNeeded(payload);
  t.equal(calls.length, 0, "an empty draft must never call compliance-preview -- the exact bug Keith reported");
  t.equal(state.offerCompliance.status, "idle");
  t.equal(api.offerIsReady(payload), false);
  t.equal(api.offerStatusLabel(payload).text, "Draft", "neutral, not an error state");

  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children.length, 1);
  t.equal(els.offerAlerts.children[0].textContent, "Add assets to build an offer.", "Keith's exact wording -- never the compliance-unavailable message on a blank page");
  t.equal(els.offerAlerts.children[0].className, "twb-offer-alert", "neutral amber tone, never the red -bad alert for an empty draft");
  api.renderSubmitArea(payload);
  t.equal(els.submitOfferBtn.disabled, true, "the REAL rendered Submit button is disabled on an empty draft");

  t.equal(mfl.st.pending.length, 0);
  t.equal(mfl.st.imports.length, 0);
});

test("DESKTOP STATE MATRIX — changed composition: a NEW call fires, the stale blocked warning clears immediately (while the new one loads), and the final state reflects the NEW terms", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG, { id: "20002", salary: 1000, contractStatus: "Vet-FAA" }]; // Chig (loaded) + a flat, harmless second player
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, state, els, calls } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });

  const blockedPayload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(blockedPayload);
  await settle();
  t.equal(calls.length, 1);
  t.equal(state.offerCompliance.status, "blocked");
  api.renderOfferAlerts(blockedPayload);
  t.match(els.offerAlerts.children[0].textContent, /HammerTime: 6 loaded contracts/);

  // The owner swaps Chig for the OTHER, flat player -- a genuinely different composition.
  const changedPayload = payloadOf(SENDER, HAMMER, [{ type: "PLAYER", player_id: "20002" }], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(changedPayload);
  t.equal(calls.length, 2, "a changed composition fires a NEW compliance-preview call");
  t.equal(state.offerCompliance.status, "loading", "immediately leaves 'blocked' behind -- never shows a stale verdict for terms that no longer apply");
  api.renderOfferAlerts(changedPayload);
  t.equal(els.offerAlerts.children.length, 1);
  t.equal(els.offerAlerts.children[0].textContent, "Checking the loaded-contract limit…", "the stale HammerTime warning is gone the instant the terms change, not just once the new result lands");

  await settle();
  t.equal(calls.length, 2, "settling fires no extra call");
  t.equal(state.offerCompliance.status, "ok", "the flat player alone doesn't push HammerTime over the limit -- recalculated for the NEW terms, not the old ones");
  api.renderOfferAlerts(changedPayload);
  t.equal(els.offerAlerts.children.length, 0);
  api.renderSubmitArea(changedPayload);
  t.equal(els.submitOfferBtn.disabled, false, "Submit re-enables once the CURRENT (changed) composition's own preview succeeds");
});

test("DESKTOP STATE MATRIX — a STALE response never overrides a NEWER one: composition A (would block) answers AFTER composition B (ok) has already landed -- the final state is B's, not A's", async () => {
  const { env } = fresh();
  const resolvers = [];
  let attempts = 0;
  const tw2sFetchOverride = () => {
    attempts += 1;
    return new Promise((resolve) => { resolvers.push(resolve); });
  };
  const { api, state, calls } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER, tw2sFetchOverride });
  void calls; // the override bypasses the bridge entirely -- `attempts` is this test's own call count

  const payloadA = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(payloadA);
  t.equal(attempts, 1);
  const payloadB = payloadOf(SENDER, HAMMER, [{ type: "PLAYER", player_id: "20002" }], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(payloadB);
  t.equal(attempts, 2, "the composition change fires its own call without waiting for A");

  // B (the NEWER request) resolves first, as ok.
  resolvers[1]({ status: 200, ok: true, body: { ok: true, compliance: { loaded_contracts: { status: "ok", violations: [] } } } });
  await settle();
  t.equal(state.offerCompliance.status, "ok", "B's result is live");

  // A (the OLDER, now-superseded request) resolves last, as blocked -- it must be discarded.
  resolvers[0]({ status: 200, ok: true, body: { ok: true, compliance: { loaded_contracts: { status: "blocked", violations: [{ franchise_id: HAMMER, franchise_name: "HammerTime", projected: 6, max: 5 }] } } } });
  await settle();
  t.equal(state.offerCompliance.status, "ok", "the stale A response must NOT overwrite B's already-landed, newer result");
  t.equal(api.offerIsReady(payloadB), true, "Submit stays enabled for the current (B) composition despite the late-arriving stale A reply");
});

// ═══════════════════════════════════ MOBILE: blocked ═══════════════════════════════════
test("MOBILE: the SAME Hammer/Chig scenario through builderComplianceSignature/refreshBuilderComplianceIfNeeded/builderComplianceAlertHtml -- blocked, canSubmit false, exact wording", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, builderState } = loadMobileOfferReview(env, { token: "tok-A" });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshBuilderComplianceIfNeeded(payload);
  t.equal(builderState.compliance.status, "loading");
  await settle();
  t.equal(builderState.compliance.status, "blocked");

  // renderStepReview's own canSubmit: structurallyReady && cs.status === "ok" (site/m/views/trade.js) --
  // the exact expression reproduced here against the real, extracted compliance state.
  const structurallyReady = true; // give/get both non-empty, matching this payload
  const canSubmit = structurallyReady && builderState.compliance.status === "ok";
  t.equal(canSubmit, false, "the mobile Submit button must be disabled -- same bug Keith reported, on mobile");

  const html = api.builderComplianceAlertHtml(builderState.compliance);
  t.match(html, /HammerTime: 6 loaded contracts; maximum 5\. Revise the trade or make a separate roster move first\./, "identical wording to desktop -- one shared rule, not two independently-worded implementations");
  t.equal(mfl.st.pending.length, 0);
  t.equal(mfl.st.imports.length, 0);
});

// ═══════════════════════════════════ MOBILE: compliant ═══════════════════════════════════
test("MOBILE: HammerTime at 4 loaded -- receiving Chig lands at the 5 limit, ok, canSubmit true, no alert markup", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 4)];
  const { api, builderState } = loadMobileOfferReview(env, { token: "tok-A" });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshBuilderComplianceIfNeeded(payload);
  await settle();
  t.equal(builderState.compliance.status, "ok");
  const canSubmit = true && builderState.compliance.status === "ok";
  t.equal(canSubmit, true);
  t.equal(api.builderComplianceAlertHtml(builderState.compliance), "", "no markup at all when compliant -- nothing for renderStepReview to splice in");
});

// ═══════════════════════════════════ MOBILE: fail closed ═══════════════════════════════════
test("MOBILE: a network failure fails closed the same way as desktop -- 'Cannot verify loaded-contract limit', canSubmit false", async () => {
  const builderState = { compliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 } };
  const U = { pad4, safeStr, safeInt, escapeHtml };
  let renders = 0;
  const renderBuilder = () => { renders += 1; };
  const M = { state: { ctx: { leagueId: "74598", year: "2026" } }, api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => "tok-A" } };
  const tw2sFetch = () => Promise.reject(new Error("network down"));

  const s1 = MOBILE_SRC.indexOf("  function builderComplianceSignature(payload) {");
  const e1 = MOBILE_SRC.indexOf("  // The INITIATOR's own overage");
  const s2 = MOBILE_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e2 = MOBILE_SRC.indexOf("  function submitStagedOffer() {");
  const code = MOBILE_SRC.slice(s1, e1) + "\n" + MOBILE_SRC.slice(s2, e2);
  const factory = new Function("builderState", "U", "M", "tw2sFetch", "renderBuilder",
    code + "\nreturn { builderComplianceSignature, refreshBuilderComplianceIfNeeded, builderComplianceAlertHtml };");
  const api = factory(builderState, U, M, tw2sFetch, renderBuilder);

  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  api.refreshBuilderComplianceIfNeeded(payload);
  await settle();
  t.equal(builderState.compliance.status, "unavailable");
  t.equal(api.builderComplianceAlertHtml(builderState.compliance), '<div class="ups-m-rstr-err">Cannot verify loaded-contract limit. Try again in a moment.</div>');
});

// ═══ MOBILE STATE MATRIX: the SAME six states, through the REAL renderStepReview -- the real
// rendered HTML's Submit button disabled attribute, not a hand-computed canSubmit proxy ═══
function seedMobileChigInv(builderState) {
  builderState.inv[SENDER] = { players: [{ player_id: CHIG.id, display: "Chig Okonkwo", salary: CHIG.salary, contract_status: CHIG.contractStatus, position: "TE", nfl_team: "TEN" }], future_picks: [] };
  builderState.inv[HAMMER] = { players: [], future_picks: [{ original_fid: HAMMER, year: "2027", round: "1", display: "2027 1st Round Pick" }] };
}
function seedMobileAltInv(builderState) {
  // A second, harmless, non-loaded player on SENDER's roster -- the "changed composition" tests' swap target.
  builderState.inv[SENDER].players.push({ player_id: "20002", display: "P20002", salary: 1000, contract_status: "Vet-FAA" });
}
const FP_HAMMER_2027_1 = "FP_0005_2027_1";

test("MOBILE STATE MATRIX — empty draft: ZERO compliance-preview calls, 'Add assets to build an offer.', Submit disabled", async () => {
  const { env, mfl } = fresh();
  const { api, body, calls } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER });
  api.renderStepReview(body);
  t.equal(calls.length, 0, "an empty draft must never call compliance-preview -- the exact bug Keith reported, on mobile");
  t.match(body.innerHTML, /Add assets to build an offer\./, "Keith's exact wording");
  t.doesNotMatch(body.innerHTML, /Cannot verify loaded-contract limit/, "never a compliance error on a blank review step");
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), true, "the REAL rendered Submit button is disabled on an empty draft");
  t.equal(mfl.st.pending.length, 0);
  t.equal(mfl.st.imports.length, 0);
});

test("MOBILE STATE MATRIX — loading: exactly one compliance-preview call in flight, explains the state, Submit disabled", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, body, calls, builderState } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER });
  seedMobileChigInv(builderState);
  builderState.giveIds["P_" + CHIG.id] = true;
  builderState.getIds[FP_HAMMER_2027_1] = true;

  api.renderStepReview(body);
  t.equal(calls.length, 1, "exactly one compliance-preview call for this composition");
  t.match(body.innerHTML, /Checking the loaded-contract limit…/);
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), true, "the REAL rendered Submit button is disabled while loading");
  await settle();
});

test("MOBILE STATE MATRIX — failed/unavailable: one call attempted, explains the state, Submit disabled", async () => {
  const { env } = fresh();
  let attempts = 0;
  const tw2sFetchOverride = () => { attempts += 1; return Promise.reject(new Error("network down")); };
  const { api, body, builderState, renders } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER, tw2sFetchOverride });
  seedMobileChigInv(builderState);
  builderState.giveIds["P_" + CHIG.id] = true;
  builderState.getIds[FP_HAMMER_2027_1] = true;

  api.renderStepReview(body);
  t.equal(attempts, 1);
  await settle();
  t.equal(renders(), 1, "the async result triggers exactly one re-render request");
  api.renderStepReview(body); // the real renderBuilder() would re-invoke this; simulated here
  t.equal(attempts, 1, "settling and re-rendering fire no additional attempt");
  t.match(body.innerHTML, /Cannot verify loaded-contract limit\. Try again in a moment\./, "Keith's exact fail-closed wording");
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), true, "the REAL rendered Submit button is disabled when compliance can't be verified");
});

test("MOBILE STATE MATRIX — blocked: exactly one call, Keith's exact wording, Submit disabled", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, body, calls, builderState } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER });
  seedMobileChigInv(builderState);
  builderState.giveIds["P_" + CHIG.id] = true;
  builderState.getIds[FP_HAMMER_2027_1] = true;

  api.renderStepReview(body);
  await settle();
  api.renderStepReview(body);
  t.equal(calls.length, 1);
  t.match(body.innerHTML, /HammerTime: 6 loaded contracts; maximum 5\. Revise the trade or make a separate roster move first\./);
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), true, "the REAL rendered Submit button stays disabled once blocked");
});

test("MOBILE STATE MATRIX — compliant: Submit enabled only once THIS composition's own preview succeeds", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 4)]; // 4 loaded, not over
  const { api, body, calls, builderState } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER });
  seedMobileChigInv(builderState);
  builderState.giveIds["P_" + CHIG.id] = true;
  builderState.getIds[FP_HAMMER_2027_1] = true;

  api.renderStepReview(body);
  await settle();
  api.renderStepReview(body);
  t.equal(calls.length, 1);
  t.doesNotMatch(body.innerHTML, /loaded contracts|Cannot verify/, "no compliance alert markup for a compliant offer");
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), false, "the REAL rendered Submit button is enabled for a compliant offer");
});

test("MOBILE STATE MATRIX — changed composition: a NEW call fires, the stale blocked warning clears immediately, final state reflects the NEW terms", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG, { id: "20002", salary: 1000, contractStatus: "Vet-FAA" }];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, body, calls, builderState } = loadMobileReviewStep(env, { token: "tok-A", myFid: SENDER, theirFid: HAMMER });
  seedMobileChigInv(builderState);
  seedMobileAltInv(builderState);
  builderState.giveIds["P_" + CHIG.id] = true;
  builderState.getIds[FP_HAMMER_2027_1] = true;

  api.renderStepReview(body);
  await settle();
  api.renderStepReview(body);
  t.equal(calls.length, 1);
  t.match(body.innerHTML, /HammerTime: 6 loaded contracts/);

  // The owner swaps Chig for the OTHER, flat player.
  delete builderState.giveIds["P_" + CHIG.id];
  builderState.giveIds["P_20002"] = true;
  api.renderStepReview(body);
  t.equal(calls.length, 2, "a changed composition fires a NEW compliance-preview call");
  t.doesNotMatch(body.innerHTML, /HammerTime: 6 loaded contracts/, "the stale warning is gone the instant the terms change");
  t.match(body.innerHTML, /Checking the loaded-contract limit…/);
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), true);

  await settle();
  api.renderStepReview(body);
  t.equal(calls.length, 2, "settling fires no extra call");
  t.doesNotMatch(body.innerHTML, /loaded contracts|Cannot verify/, "recalculated clean for the new terms");
  t.equal(isDisabledInHtml(body.innerHTML, "ups-m-tb-submit"), false, "Submit re-enables once the CURRENT (changed) composition's own preview succeeds");
});

// ═══ PROVE THE PREVIEW AND THE FINAL CREATE GATE AGREE -- same live roster snapshot, two
// independent entry points, identical verdict. Keith: "Do not stop at proving that the final
// POST returns 409; I need the error visible while reviewing the offer... prove the preview and
// final gate agree." ═══
test("AGREEMENT: the compliance-preview endpoint (what the Offer Review panel now calls) and the native /api/trades/proposals create gate (the final Send) reach the IDENTICAL verdict against the IDENTICAL live roster snapshot", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();

  // 1) The Offer Review panel's own new call (the exact client function, against the exact
  // endpoint) -- proven directly against the real worker, not re-derived.
  const { api: desk, state } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  desk.refreshOfferComplianceIfNeeded(payload);
  await settle();
  t.equal(state.offerCompliance.status, "blocked");
  const previewViolation = (state.offerCompliance.loadedContracts.violations || []).find((v) => v.franchise_id === HAMMER);
  t.ok(previewViolation, "the preview names HammerTime");
  t.equal(previewViolation.projected, 6);
  t.equal(previewViolation.max, 5);

  // 2) The REAL final Send path -- the native create gate -- against the SAME env/mfl (same
  // live roster snapshot, nothing re-seeded in between).
  const player = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
  const pick = () => ({ asset_id: "FP_0005_2027_1", type: "PICK", pick_key: "FP_0005_2027_1", pick_label: "2027 1st" });
  const nativePayload = {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: SENDER, selected_assets: [player(CHIG.id)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: HAMMER, selected_assets: [pick()], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 0 },
    ],
    extension_requests: [], ui: { left_team_id: SENDER, right_team_id: HAMMER }, validation: { status: "ready" },
  };
  const body0 = { league_id: "74598", season: "2026", from_franchise_id: SENDER, to_franchise_id: HAMMER, from_franchise_name: "Real Deal Creel", to_franchise_name: "HammerTime", message: "", payload: nativePayload };
  const create = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-A`, { body: body0 });

  t.equal(create.status, 409, "the final gate refuses this exact trade, exactly as the preview warned");
  t.equal(create.json.code, "loaded_contract_limit_exceeded");
  t.equal(create.json.who, "recipient");
  t.equal(create.json.teams[0].franchise_id, HAMMER, "identifies HammerTime, matching the preview");
  t.equal(create.json.teams[0].projected, 6, "the SAME projected count the preview showed");

  t.equal(mfl.st.pending.length, 0, "the final gate's own refusal means no native MFL offer was ever created");
  t.equal(mfl.st.imports.length, 0, "and the preview itself never touched MFL either -- zero writes across both calls");
});

await run("trade_offer_review_loaded_contract_preview");
restoreConsole();
