// The NORMAL Send flow's automatic staging fallback (worker/src/index.js's cutover gate +
// site/trades/trade_workbench.js's submitTradeCreateWithGates/submitViaStagingFallback,
// site/m/views/trade.js's submitTradeCreateWithGatesMobile/submitViaStagingFallbackMobile).
// Keith's ruling (2026-09-29): "the normal Send action must stage every new two-team offer...
// Show the compliance popup as part of that normal Send flow." This runs the REAL functions
// (extracted from the real files by exact, verified line anchors -- not reimplemented) against
// the REAL worker + real D1 + a stateful fake MFL: a legacy create that gets refused
// (staging_required) must fall through, automatically, to a REAL staged D1 row -- proven by
// then reading it back through /api/trades/2way -- with zero MFL writes for that specific
// request.
//   node tests/trade_cutover_send_fallback.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, ...((over && over.env) || {}) });
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl };
}

// Bridges the sandbox's own `fetch` param straight to the real worker -- exactly the
// technique tests/trade_2way_staged_clients.test.mjs already established.
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

function sliceByAnchors(lines, startText, startLine, endText, endLine) {
  if (!lines[startLine - 1].includes(startText)) throw new Error(`anchor drifted: line ${startLine} expected "${startText}", got: ${lines[startLine - 1]}`);
  if (!lines[endLine - 1].includes(endText)) throw new Error(`anchor drifted: line ${endLine} expected "${endText}", got: ${lines[endLine - 1]}`);
  return lines.slice(startLine - 1, endLine - 1).join("\n");
}

// ══════════════════════ harness: the REAL desktop cutover-fallback functions ══════════════════════
function loadDesktopFallback(env, { token, fid, previewResult } = {}) {
  const lines = DESK_SRC.split("\n");
  const fjr = sliceByAnchors(lines, "async function fetchJsonRequest(url, options)", 3940, "async function replayOutbox(criteria)", 3974);
  const gates = sliceByAnchors(lines, "async function submitTradeCreateWithGates(apiUrl, initialBody, fromFranchiseId)", 4291, "async function submitOfferToQueue()", 4364);
  const movs = sliceByAnchors(lines, "function tw2sAssetToken(a)", 8268, "var tw2s = { listStatus:", 8296);
  const code = fjr + "\n" + gates + "\n" + movs;
  const bridge = bridgeFetch(env);
  const resolveStaged2WayApiUrl = () => `https://worker.test/api/trades/2way?MFL_USER_ID=${token}&L=74598&YEAR=2026`;
  const pad4 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
  const safeStr = (v) => (v == null ? "" : String(v).trim());
  const safeInt = (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); };
  // Never actually exercised in these scenarios (no create-time 409 for loaded-contract/cap on
  // the legacy path in this test's fixtures) -- present only so the real gates code parses and
  // runs; their own correctness is covered by tests/trade_loaded_contract_clients.test.mjs.
  const confirmOfferLoadedContractDrops = async () => null;
  const confirmOfferCapOverage = async () => null;
  const previewCalls = [];
  const tw2sRunPreSendPreview = async (fromFid, movements, extReqs) => { previewCalls.push({ fromFid, movements, extReqs }); return previewResult || { proceed: true, drops: [] }; };
  const tw2sUrl = (suffix) => resolveStaged2WayApiUrl() + suffix;
  const tw2sFetch = (url, init) => bridge(url, init).then((r) => r.text().then((txt) => { let body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {} return { status: r.status, ok: r.ok, body }; })).catch(() => ({ networkError: true }));
  const factory = new Function("fetch", "pad4", "safeStr", "safeInt", "confirmOfferLoadedContractDrops", "confirmOfferCapOverage", "tw2sRunPreSendPreview", "tw2sUrl", "tw2sFetch",
    code + "\nreturn { submitTradeCreateWithGates, submitViaStagingFallback };");
  const api = factory(bridge, pad4, safeStr, safeInt, confirmOfferLoadedContractDrops, confirmOfferCapOverage, tw2sRunPreSendPreview, tw2sUrl, tw2sFetch);
  return { api, calls: bridge.calls, previewCalls };
}

// ══════════════════════ harness: the REAL mobile cutover-fallback functions ══════════════════════
function loadMobileFallback(env, { token, fid, previewResult } = {}) {
  const lines = MOBILE_SRC.split("\n");
  const gates = sliceByAnchors(lines, "function submitTradeCreateWithGatesMobile(url, initialBody, fromFranchiseId, attempt)", 916, "function submitOffer()", 987);
  const code = gates;
  const bridge = bridgeFetch(env);
  const U = { pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; }, safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); } };
  const M = { state: { ctx: { leagueId: "74598", year: "2026" } }, api: { workerUrl: (p) => "https://worker.test" + p, getStoredMflUserId: () => token } };
  const openCreateLoadedContractDropsSheet = async () => null;
  const openCreateCapAckSheet = async () => null;
  const previewCalls = [];
  const runPreSendPreview = async (fromFid, movements, extReqs) => { previewCalls.push({ fromFid, movements, extReqs }); return previewResult || { proceed: true, drops: [] }; };
  const tw2sFetch = (url, init) => bridge(url, init).then((r) => r.text().then((txt) => { let body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {} return { status: r.status, ok: r.ok, body }; })).catch(() => ({ networkError: true }));
  // tw2sMovementsFromPayload (mobile's own copy) needed by submitViaStagingFallbackMobile -- a
  // small, separately-defined mirror of desktop's; extract it too, same technique.
  const movStart = MOBILE_SRC.indexOf("  function tw2sAssetToken(a) {");
  const movEnd = MOBILE_SRC.indexOf("  function submitStagedOffer()");
  const movCode = MOBILE_SRC.slice(movStart, movEnd);
  const factory = new Function("fetch", "U", "M", "openCreateLoadedContractDropsSheet", "openCreateCapAckSheet", "runPreSendPreview", "tw2sFetch",
    movCode + "\n" + code + "\nreturn { submitTradeCreateWithGatesMobile };");
  const api = factory(bridge, U, M, openCreateLoadedContractDropsSheet, openCreateCapAckSheet, runPreSendPreview, tw2sFetch);
  return { api, calls: bridge.calls, previewCalls };
}

const payloadFor = (from, to, pidFrom, pidTo) => ({
  teams: [
    { role: "left", franchise_id: from, selected_assets: [{ asset_id: `player:${pidFrom}`, type: "PLAYER", player_id: String(pidFrom), player_name: "x", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: to, selected_assets: [{ asset_id: `player:${pidTo}`, type: "PLAYER", player_id: String(pidTo), player_name: "y", salary: 5000, taxi: false }], traded_salary_adjustment_k: 0 },
  ],
  extension_requests: [],
});

// ═════════════════════════════ DESKTOP ═════════════════════════════

test("DESKTOP: cutover OFF -- the normal Send flow proposes a real MFL trade exactly as before (no fallback triggered)", async () => {
  const { env, mfl } = fresh();
  const d = loadDesktopFallback(env, { token: "tok-B", fid: "0001" });
  const res = await d.api.submitTradeCreateWithGates("https://worker.test/trade-offers?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001");
  t.ok(res.ok !== false, JSON.stringify(res));
  t.equal(res.mode, "direct_mfl");
  t.ok(mfl.st.imports.some((i) => i.type === "tradeProposal"));
  t.equal(d.previewCalls.length, 0, "the fallback's own popup is never invoked when cutover is off -- the legacy path never triggers it");
});

test("DESKTOP: cutover ON -- the SAME normal Send call transparently falls through to a REAL staged D1 trade, running the compliance popup as part of that fall-through, with zero MFL writes", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const d = loadDesktopFallback(env, { token: "tok-B", fid: "0001" });
  const res = await d.api.submitTradeCreateWithGates("https://worker.test/trade-offers?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "L.A. Looks", to_franchise_name: "CBP", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001");
  t.ok(res && res.staged === true, JSON.stringify(res));
  t.ok(res.id);
  t.equal(d.previewCalls.length, 1, "the compliance preview ran as part of THIS SAME call, not a separate button's own flow");
  t.equal(mfl.st.imports.length, 0, "no MFL write of any kind for this request");

  // Prove it's a REAL row, not a fabricated success -- read it back through the real detail route.
  const detailRes = await bridgeFetch(env)(`https://worker.test/api/trades/2way?id=${res.id}&L=74598&YEAR=2026&MFL_USER_ID=tok-B`, {});
  const detail = JSON.parse(await detailRes.text());
  t.ok(detail.ok);
  t.equal(detail.trade.from_fid, "0001");
  t.equal(detail.trade.to_fid, "0002");
  t.equal(detail.trade.mfl_trade_id, null);
});

test("DESKTOP: the owner declining the fallback popup produces a calm 'not sent' outcome -- never an error, and nothing was created anywhere", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const d = loadDesktopFallback(env, { token: "tok-B", fid: "0001", previewResult: { proceed: false, drops: [] } }); // owner clicks "Don't send"
  let threw = null;
  try { await d.api.submitTradeCreateWithGates("https://worker.test/trade-offers?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001"); }
  catch (e) { threw = e; }
  t.ok(threw && threw.__declinedStaging, "the caller's existing catch handling must see __declinedStaging, not a generic failure");
  t.equal(mfl.st.imports.length, 0);
  t.equal(d.calls.filter((c) => c.method === "POST" && c.path === "/api/trades/2way").length, 0, "declining never even attempts to create the staged row");
});

// ═════════════════════════════ MOBILE ═════════════════════════════

test("MOBILE: cutover OFF -- the normal Send flow proposes a real MFL trade exactly as before", async () => {
  const { env, mfl } = fresh();
  const m = loadMobileFallback(env, { token: "tok-B", fid: "0001" });
  const res = await m.api.submitTradeCreateWithGatesMobile("https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001");
  t.equal(res.ok, true, JSON.stringify(res));
  t.equal(res.body.mode, "direct_mfl");
  t.ok(mfl.st.imports.some((i) => i.type === "tradeProposal"));
  t.equal(m.previewCalls.length, 0);
});

test("MOBILE: cutover ON -- the SAME normal Send call transparently falls through to a REAL staged D1 trade, zero MFL writes", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const m = loadMobileFallback(env, { token: "tok-B", fid: "0001" });
  const res = await m.api.submitTradeCreateWithGatesMobile("https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "L.A. Looks", to_franchise_name: "CBP", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001");
  t.equal(res.ok, true, JSON.stringify(res));
  t.ok(res.body.staged);
  t.ok(res.body.id);
  t.equal(m.previewCalls.length, 1);
  t.equal(mfl.st.imports.length, 0);
});

test("MOBILE: the owner declining the fallback popup resolves a distinct, non-error shape ({ok:true, status:0, body:{code:'staging_declined_by_owner'}}) -- submitOffer()'s own handler treats this as calm, not an error banner", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_CUTOVER_ENABLED: "1" } });
  const m = loadMobileFallback(env, { token: "tok-B", fid: "0001", previewResult: { proceed: false, drops: [] } });
  const res = await m.api.submitTradeCreateWithGatesMobile("https://worker.test/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B", { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", payload: { ...payloadFor("0001", "0002", 14056, 13100), validation: { status: "ready" }, league_id: "74598", season: "2026" } }, "0001");
  t.equal(res.body.code, "staging_declined_by_owner");
  t.equal(mfl.st.imports.length, 0);
});

await run("trade_cutover_send_fallback");
restoreConsole();
