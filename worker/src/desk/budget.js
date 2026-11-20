// Commissioner Desk: the budget gate. EVERY model call the desk makes goes through guardedCall(), and guardedCall fails CLOSED:
// a missing setting, an unreadable ledger, an unknown model, an oversized request or an exhausted cap all mean "no call".
//
// Defaults (nothing configured): every cap is 0, the live switch is off, there is no desk key. So a fresh deployment cannot spend a cent.
//
// Order of checks in guardedCall:
//   1. assertCommishCaller (throws DeskAuthError; no model, no ledger touch)
//   2. request shape, price known, ceilings            -> blocked bad_request | unknown_model
//   3. live client only: switch + key + desk flag      -> blocked live_calls_disabled | no_key | desk_disabled
//   4. worst-case estimate vs each cap                 -> blocked budget_per_question | budget_per_run | budget_monthly | budget_total
//   5. ATOMIC reserve in ai_call_log (one INSERT ... SELECT ... WHERE caps still hold), BEFORE the call.
//      Unreadable/missing ledger -> blocked ledger_unreadable (nothing is logged, nothing is called).
//   6. client.complete(request). Success: the row is finalized with real usage and cost. Failure: the row is finalized with an error code
//      (cost 0, except a timeout, which may have been billed and is kept at the reservation) -> blocked model_error.
// Fake and live spend live in separate lanes of the same ledger (the `mode` column) but obey the SAME limits and the SAME code, so tests
// and demos exercise exactly the production path. Reservations count at their est_cost_usd until finalized, so concurrent calls cannot overshoot.
// A worker that dies mid-call leaves its reservation unfinalized: it keeps counting at the worst-case estimate (safe side) until a human clears it.
//
// What is stored: ids, the prompt HASH, token counts, cost, latency, error code. Never prompt text, question text, tool results or keys.

import { assertCommishCaller } from "./contract.js";
import { createStore, StoreError } from "./store.js";
import { desiredKeyName, DeskModelError } from "./anthropic_client.js";
import { costUsd, estimateTokens, estimateWorstCaseUsd, isPricedModel, DeskPriceError } from "./prices.js";

export const MAX_TOKENS_CEILING = 4000;      // hard ceiling on max_tokens for any single call
export const MAX_REQUEST_CHARS = 300000;     // hard ceiling on the serialized request (about 100k estimated tokens)
export const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const STEP_RE = /^[a-z_]{1,20}$/;
const HASH_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const TOOLS_RE = /^[a-z0-9_.,]{0,400}$/;
const MODES = ["live", "fake"];

// ── limits ──────────────────────────────────────────────────────────────────────────────────────
const NUM_RE = /^\d+(\.\d+)?$/;
function capFrom(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v !== "string") return 0;
  const s = v.trim();
  if (!NUM_RE.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A missing, blank, non-numeric, negative or NaN setting is 0, and a cap of 0 blocks every call.
export function getLimits(env) {
  const e = env || {};
  return {
    perQuestionUsd: capFrom(e.DESK_BUDGET_PER_QUESTION_USD),
    perRunUsd: capFrom(e.DESK_BUDGET_PER_RUN_USD),
    monthlyUsd: capFrom(e.DESK_BUDGET_MONTHLY_USD),
    totalUsd: capFrom(e.DESK_BUDGET_TOTAL_USD),
  };
}

// ── live-call switch ────────────────────────────────────────────────────────────────────────────
// deskEnabled is the desk's own feature flag, computed by the handler (this file does not import the flag module).
// Only the boolean true counts. Reasons are returned in the order switch, key, flag.
export function liveCallsAllowed(env, deskEnabled) {
  const e = env || {};
  const reasons = [];
  if (e.DESK_LIVE_MODEL_ENABLED !== "1") reasons.push("live_calls_disabled");
  const k = e[desiredKeyName];
  if (typeof k !== "string" || !k.trim()) reasons.push("no_key");
  if (deskEnabled !== true) reasons.push("desk_disabled");
  return { allowed: reasons.length === 0, reasons };
}

// ── request checks ──────────────────────────────────────────────────────────────────────────────
function checkRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return { reason: "bad_request" };
  if (!isPricedModel(request.model)) return { reason: "unknown_model" };
  const mt = request.max_tokens;
  if (!Number.isInteger(mt) || mt < 1 || mt > MAX_TOKENS_CEILING) return { reason: "bad_request" };
  if (!Array.isArray(request.messages) || request.messages.length < 1) return { reason: "bad_request" };
  for (const m of request.messages) {
    if (!m || typeof m !== "object" || !["user", "assistant"].includes(m.role) || !(typeof m.content === "string" || Array.isArray(m.content))) return { reason: "bad_request" };
  }
  if (request.system != null && typeof request.system !== "string" && !Array.isArray(request.system)) return { reason: "bad_request" };
  if (request.tools != null && !Array.isArray(request.tools)) return { reason: "bad_request" };
  let json;
  try { json = JSON.stringify(request); } catch (_) { return { reason: "bad_request" }; }
  if (typeof json !== "string" || json.length > MAX_REQUEST_CHARS) return { reason: "bad_request" };
  return { chars: json.length, usesCache: json.includes('"cache_control"') };
}

function cleanMeta(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const out = { feature: "commish_desk", step: "loop", runId: null, questionId: null, promptHash: null, canonSha: null, tools: null };
  if (m.feature != null) { if (!/^[a-z_]{1,40}$/.test(String(m.feature))) return null; out.feature = String(m.feature); }
  if (m.step != null) { if (!STEP_RE.test(String(m.step))) return null; out.step = String(m.step); }
  if (m.runId != null) { if (!ID_RE.test(String(m.runId))) return null; out.runId = String(m.runId); }
  if (m.questionId != null) { if (!ID_RE.test(String(m.questionId))) return null; out.questionId = String(m.questionId); }
  if (m.promptHash != null) { if (!HASH_RE.test(String(m.promptHash))) return null; out.promptHash = String(m.promptHash); }
  if (m.canonSha != null) { if (!/^[A-Za-z0-9]{1,64}$/.test(String(m.canonSha))) return null; out.canonSha = String(m.canonSha); }
  if (m.tools != null) {
    const t = Array.isArray(m.tools) ? m.tools.join(",") : String(m.tools);
    if (!TOOLS_RE.test(t)) return null;
    out.tools = t || null;
  }
  return out;
}

function monthStartSec(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

const blocked = (reason, extra) => ({ ok: false, blocked: true, reason, ...(extra || {}) });

// ── the gate ────────────────────────────────────────────────────────────────────────────────────
// opts.nowMs: a clock for tests. Returns { ok:true, response, usage, costUsd, callId, mode } or { ok:false, blocked:true, reason }.
// Throws only DeskAuthError (a caller that is not the proven commissioner).
export async function guardedCall({ env, db, caller, client, meta, request, deskEnabled, nowMs } = {}) {
  assertCommishCaller(caller);
  const clock = typeof nowMs === "number" ? () => nowMs : () => Date.now();
  const store = (() => { try { return createStore(db); } catch (_) { return null; } })();
  const m = cleanMeta(meta);
  const entryBase = { ...(m || { feature: "commish_desk", step: "unknown" }), model: request && typeof request.model === "string" ? request.model : "unknown", nowMs: clock() };

  // Refuse, and (best effort) leave a trace row with the reason. A ledger that cannot be written is simply not logged.
  async function refuse(reason, extra) {
    if (store) { try { await store.logBlocked(caller, entryBase, reason); } catch (_) { /* ledger unwritable: nothing more to do */ } }
    return blocked(reason, extra);
  }

  if (!m) return refuse("bad_request");
  if (!client || typeof client.complete !== "function" || !MODES.includes(client.mode)) return refuse("no_client");
  if (!store) return blocked("ledger_unreadable");

  const rq = checkRequest(request);
  if (rq.reason) return refuse(rq.reason);

  if (client.mode === "live") {
    const gate = liveCallsAllowed(env, deskEnabled);
    if (!gate.allowed) return refuse(gate.reasons[0], { reasons: gate.reasons });
  }

  let est;
  try {
    est = estimateWorstCaseUsd({ model: request.model, inputTokensEstimate: estimateTokens(rq.chars), maxOutputTokens: request.max_tokens, usesCache: rq.usesCache });
  } catch (e) { return refuse(e instanceof DeskPriceError ? e.code : "bad_request"); }
  if (!Number.isFinite(est) || est <= 0) return refuse("bad_request");

  const lim = getLimits(env);
  // Cheap pre-check with no ledger access: a cap of 0 (the default), or a single call that cannot fit under a cap on its own, ends here.
  if (!(lim.perQuestionUsd > 0 && est <= lim.perQuestionUsd)) return refuse("budget_per_question");
  if (!(lim.perRunUsd > 0 && est <= lim.perRunUsd)) return refuse("budget_per_run");
  if (!(lim.monthlyUsd > 0 && est <= lim.monthlyUsd)) return refuse("budget_monthly");
  if (!(lim.totalUsd > 0 && est <= lim.totalUsd)) return refuse("budget_total");

  const t0 = clock();
  const monthStart = monthStartSec(t0);
  const entry = { ...entryBase, mode: client.mode, nowMs: t0 };
  const caps = { question: lim.perQuestionUsd, run: lim.perRunUsd, month: lim.monthlyUsd, total: lim.totalUsd };

  // Atomic reserve BEFORE the call.
  let rsv;
  try { rsv = await store.reserveCall(caller, { entry, est, caps, monthStart }); }
  catch (e) { return blocked("ledger_unreadable", { detail: e instanceof StoreError ? e.code : "error" }); }  // detail: not_ready (tables missing) or ledger_unreadable

  if (!rsv.reserved) {
    // Some cap would be exceeded by reserved + spent + estimate. Read the sums only to name which one (the decision was already made atomically).
    let reason = "budget_contended";
    try {
      const s = await store.readLedgerSums(caller, { mode: client.mode, runId: m.runId, questionId: m.questionId, monthStart });
      const EPS = 1e-9;
      if (s.question + est > caps.question + EPS) reason = "budget_per_question";
      else if (s.run + est > caps.run + EPS) reason = "budget_per_run";
      else if (s.month + est > caps.month + EPS) reason = "budget_monthly";
      else if (s.total + est > caps.total + EPS) reason = "budget_total";
    } catch (_) { reason = "ledger_unreadable"; }
    return refuse(reason);
  }
  const callId = rsv.id;

  // The call. This is the only place a model is contacted.
  let response;
  try {
    response = await client.complete(request);
  } catch (e) {
    const code = e instanceof DeskModelError ? e.code : "client_error";
    // A timeout may have been billed by the provider and we cannot tell: keep the worst-case reservation as the cost. Other failures cost nothing.
    const cost = code === "timeout" ? est : 0;
    try { await store.finalizeCall(caller, callId, { costUsd: cost, latencyMs: clock() - t0, errorCode: code }); } catch (_) { /* reservation stays at its estimate */ }
    return blocked("model_error", { detail: code, callId });
  }

  const latency = clock() - t0;
  let cost = est, errorCode = null;
  const usage = response && response.usage;
  try { cost = costUsd(request.model, usage); } catch (_) { errorCode = "usage_missing"; /* unknown usage: charge the worst case */ }
  const tok = (k) => (usage && Number.isFinite(Number(usage[k])) ? Number(usage[k]) : null);
  let ledgerWarning = null;
  try {
    await store.finalizeCall(caller, callId, {
      inputTokens: tok("input_tokens"), outputTokens: tok("output_tokens"), cacheReadTokens: tok("cache_read_input_tokens"), cacheWriteTokens: tok("cache_creation_input_tokens"),
      costUsd: cost, latencyMs: latency, errorCode,
    });
  } catch (_) { ledgerWarning = "finalize_failed"; /* the paid response is kept; the unfinalized reservation keeps counting at the worst case */ }

  return { ok: true, response, usage, costUsd: cost, callId, mode: client.mode, ...(ledgerWarning ? { ledgerWarning } : {}) };
}
