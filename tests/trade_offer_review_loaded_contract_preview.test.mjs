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
function loadDesktopOfferReview(env, { token, fid }) {
  const bridge = bridgeFetch(env);
  const s1 = DESK_SRC.indexOf("  function offerComplianceSignature(payload) {");
  const e1 = DESK_SRC.indexOf("  function formatSignedK(v) {");
  if (s1 < 0 || e1 < 0) throw new Error("desktop: could not locate offerComplianceSignature..offerStatusLabel -- source may have moved");
  const s2 = DESK_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e2 = DESK_SRC.indexOf('  var tw2s = { listStatus: "idle"');
  if (s2 < 0 || e2 < 0) throw new Error("desktop: could not locate tw2sAssetToken/tw2sMovementsFromPayload -- source may have moved");
  const s3 = DESK_SRC.indexOf("  function renderOfferAlerts(payload) {");
  const e3 = DESK_SRC.indexOf("  function renderSubmitArea(payload) {");
  if (s3 < 0 || e3 < 0) throw new Error("desktop: could not locate renderOfferAlerts -- source may have moved");
  const code = DESK_SRC.slice(s1, e1) + "\n" + DESK_SRC.slice(s2, e2) + "\n" + DESK_SRC.slice(s3, e3);

  const state = { counterMode: false, offerCompliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 } };
  let renders = 0;
  const renderSummary = () => { renders += 1; };
  const document = { createElement: () => ({ className: "", textContent: "" }) };
  const els = { offerAlerts: { innerHTML: "", children: [], appendChild(n) { this.children.push(n); } } };
  const getLeagueContext = () => ({ leagueId: "74598", season: "2026" });
  const resolveCompliancePreviewApiUrl = () => `https://worker.test/api/trades/compliance-preview?${Q}&MFL_USER_ID=${token}`;
  const tw2sFetch = makeTw2sFetch(bridge);

  const factory = new Function("state", "safeStr", "safeInt", "pad4", "getLeagueContext", "resolveCompliancePreviewApiUrl", "tw2sFetch", "renderSummary", "document", "els",
    code + "\nreturn { offerComplianceSignature, refreshOfferComplianceIfNeeded, offerIsReady, offerStatusLabel, renderOfferAlerts, tw2sAssetToken, tw2sMovementsFromPayload };");
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

// The payload shape both buildTradePayload() (desktop) and buildOfferPayload() (mobile) produce
// -- {teams:[{franchise_id, selected_assets, traded_salary_adjustment_k}, ...], extension_requests,
// validation}. Player/pick asset shapes match tw2sAssetToken's own PLAYER/PICK branches.
function payloadOf(from, to, giveAssets, getAssets) {
  return {
    teams: [
      { franchise_id: from, selected_assets: giveAssets, traded_salary_adjustment_k: 0 },
      { franchise_id: to, selected_assets: getAssets, traded_salary_adjustment_k: 0 },
    ],
    extension_requests: [],
    validation: { status: "ready", issues: [] },
  };
}
const chigAsset = { type: "PLAYER", player_id: CHIG.id };
const pickAsset = { type: "PICK", pick_key: "FP_0005_2027_1" }; // HammerTime's 2027 1st, the same token tests/fixtures/trade_3way_fixture.mjs uses for it

// ═══════════════════════════════════ DESKTOP: blocked ═══════════════════════════════════
test("DESKTOP: Real Deal Creel -> HammerTime, Chig Okonkwo (Vet-FAA-FL) for a 2027 1st -- HammerTime at 5 loaded (incl. IR) projects to 6, the live check blocks, exact wording, Not Ready, fails closed while loading", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = hammerRosterFiveLoadedOneIR();
  const { api, state, els, renders } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshOfferComplianceIfNeeded(payload);
  t.equal(state.offerCompliance.status, "loading", "fires synchronously into loading, never silently stays idle/ok before the network round-trip resolves");
  t.equal(api.offerIsReady(payload), false, "fails closed while loading -- never reads as sendable mid-check");
  t.equal(api.offerStatusLabel(payload).text, "Checking…");

  await settle();
  t.equal(state.offerCompliance.status, "blocked");
  t.equal(api.offerIsReady(payload), false, "Send must be disabled -- this is the exact bug Keith reported (panel said Ready)");
  t.equal(api.offerStatusLabel(payload).text, "Not Ready", "the overall offer pill -- Keith's exact wording");
  t.equal(renders(), 1, "the async result triggers exactly one re-render");

  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children.length, 1);
  t.equal(els.offerAlerts.children[0].textContent, "HammerTime: 6 loaded contracts; maximum 5. Revise the trade or make a separate roster move first.", "Keith's exact quoted wording, built from the server's own violations[] -- not the server's own differently-worded message string");
  t.equal(els.offerAlerts.children[0].className, "twb-offer-alert twb-offer-alert-bad");

  t.equal(mfl.st.pending.length, 0, "a preview never creates a native MFL offer");
  t.equal(mfl.st.imports.length, 0, "a preview never writes to MFL at all");
});

// ═══════════════════════════════════ DESKTOP: compliant ═══════════════════════════════════
test("DESKTOP: the SAME offer shape but HammerTime starts at only 4 loaded -- receiving Chig lands exactly at the 5 limit, not over: Ready, Send enabled, no alert rendered", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters[SENDER] = [CHIG];
  mfl.st.rosters[HAMMER] = [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...loadedIds(9000, 4)]; // 4 loaded, no IR
  const { api, state, els } = loadDesktopOfferReview(env, { token: "tok-A", fid: SENDER });
  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);

  api.refreshOfferComplianceIfNeeded(payload);
  await settle();
  t.equal(state.offerCompliance.status, "ok");
  t.equal(api.offerIsReady(payload), true);
  t.equal(api.offerStatusLabel(payload).text, "Ready");

  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children.length, 0, "no loaded-contract alert when the projected count is within the limit");
});

// ═══════════════════════════════════ DESKTOP: fail closed on network failure ═══════════════════════════════════
test("DESKTOP: a network/worker failure never reads as Ready -- shows 'Cannot verify loaded-contract limit', Not Ready, Send disabled", async () => {
  const state = { counterMode: false, offerCompliance: { signature: "", status: "idle", loadedContracts: null, seq: 0 } };
  const document = { createElement: () => ({ className: "", textContent: "" }) };
  const els = { offerAlerts: { innerHTML: "", children: [], appendChild(n) { this.children.push(n); } } };
  let renders = 0;
  const renderSummary = () => { renders += 1; };
  const getLeagueContext = () => ({ leagueId: "74598", season: "2026" });
  const resolveCompliancePreviewApiUrl = () => "https://worker.test/api/trades/compliance-preview";
  const tw2sFetch = () => Promise.reject(new Error("network down")); // the real tw2sFetch's own .catch(() => ({networkError:true})) isn't present here on purpose -- refreshOfferComplianceIfNeeded has its OWN try/catch around the call, proven below

  const s1 = DESK_SRC.indexOf("  function offerComplianceSignature(payload) {");
  const e1 = DESK_SRC.indexOf("  function formatSignedK(v) {");
  const s3 = DESK_SRC.indexOf("  function renderOfferAlerts(payload) {");
  const e3 = DESK_SRC.indexOf("  function renderSubmitArea(payload) {");
  const s2 = DESK_SRC.indexOf("  function tw2sAssetToken(a) {");
  const e2 = DESK_SRC.indexOf('  var tw2s = { listStatus: "idle"');
  const code = DESK_SRC.slice(s1, e1) + "\n" + DESK_SRC.slice(s2, e2) + "\n" + DESK_SRC.slice(s3, e3);
  const factory = new Function("state", "safeStr", "safeInt", "pad4", "getLeagueContext", "resolveCompliancePreviewApiUrl", "tw2sFetch", "renderSummary", "document", "els",
    code + "\nreturn { offerComplianceSignature, refreshOfferComplianceIfNeeded, offerIsReady, offerStatusLabel, renderOfferAlerts };");
  const api = factory(state, safeStr, safeInt, pad4, getLeagueContext, resolveCompliancePreviewApiUrl, tw2sFetch, renderSummary, document, els);

  const payload = payloadOf(SENDER, HAMMER, [chigAsset], [pickAsset]);
  api.refreshOfferComplianceIfNeeded(payload);
  await settle();
  t.equal(state.offerCompliance.status, "unavailable");
  t.equal(api.offerIsReady(payload), false, "fails closed -- an unreadable compliance check must never read as sendable");
  t.equal(api.offerStatusLabel(payload).text, "Not Ready");
  api.renderOfferAlerts(payload);
  t.equal(els.offerAlerts.children[0].textContent, "Cannot verify loaded-contract limit. Try again in a moment.", "Keith's exact fail-closed wording");
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
