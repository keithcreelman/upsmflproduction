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
//   5. ATOMIC reserve (one D1 batch, store.reserveCall): a guarded INSERT of the ai_call_log row that only happens if the caps hold, using the
//      maintained ai_budget_totals rows for total and month plus the run's and the question's own ledger rows, then the totals are raised in
//      the same batch. This happens BEFORE the call. Unreadable/missing ledger or totals -> blocked ledger_unreadable (nothing is called).
//   6. client.complete(request). Success: the row and the totals are finalized with real usage and cost. If the usage block is missing or
//      malformed the call WAS billed but its price is unknown: the reservation is kept as the cost, the answer is still returned, and the
//      result carries ledgerWarning "usage_unverified". Failure: only a 4xx refusal that cannot have been processed (not 408, 409 or 429) is
//      recorded at cost 0; a timeout, network error, 408/409/429, 5xx or anything unknown keeps the reservation as its cost, because a
//      connection that failed after the provider processed the request must not look free. -> blocked model_error.
// The input-token estimate is a hard upper bound (UTF-8 bytes of the request body + fixed overhead, see prices.js), so the reservation can
// only be too high, never too low.
// Fake and live spend live in separate lanes of the same ledger (the `mode` column) but obey the SAME limits and the SAME code, so tests
// and demos exercise exactly the production path. Reservations count at their est_cost_usd until finalized, so concurrent calls cannot overshoot.
// A worker that dies mid-call leaves its reservation unfinalized: it keeps counting at the worst-case estimate (safe side) until a human clears it.
//
// What is stored: ids, the prompt HASH, token counts, cost, latency, error code. Never prompt text, question text, tool results or keys.

import { assertCommishCaller } from "./contract.js";
import { createStore, StoreError } from "./store.js";
import { desiredKeyName, DeskModelError, buildBody } from "./anthropic_client.js";
import { costUsd, estimateInputTokensFromBytes, estimateWorstCaseUsd, isPricedModel, utf8Bytes, DeskPriceError } from "./prices.js";

export const MAX_TOKENS_CEILING = 4000;      // hard ceiling on max_tokens for any single call
export const MAX_REQUEST_BYTES = 300000;     // hard ceiling on the serialized request body, in UTF-8 bytes (the estimate counts one token per byte)
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
  // Exactly the body the client would send (whitelisted fields only), measured in UTF-8 bytes.
  let json;
  try { json = JSON.stringify(buildBody(request)); } catch (_) { return { reason: "bad_request" }; }
  if (typeof json !== "string") return { reason: "bad_request" };
  const bytes = utf8Bytes(json);
  if (bytes > MAX_REQUEST_BYTES) return { reason: "bad_request" };
  return { bytes, usesCache: json.includes('"cache_control"') };
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

// True only when the provider definitely refused the request before processing it: an HTTP 4xx other than 408 (timeout), 409 (conflict)
// and 429 (rate limit). Those are the only failures that may be recorded at cost 0.
function definitelyNotBilled(e) {
  return e instanceof DeskModelError && e.code === "http_error" && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status);
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
    est = estimateWorstCaseUsd({ model: request.model, inputTokensEstimate: estimateInputTokensFromBytes(rq.bytes), maxOutputTokens: request.max_tokens, usesCache: rq.usesCache });
  } catch (e) { return refuse(e instanceof DeskPriceError ? e.code : "bad_request"); }
  if (!Number.isFinite(est) || est <= 0) return refuse("bad_request");

  const lim = getLimits(env);
  // Cheap pre-check with no ledger access: a cap of 0 (the default), or a single call that cannot fit under a cap on its own, ends here.
  if (!(lim.perQuestionUsd > 0 && est <= lim.perQuestionUsd)) return refuse("budget_per_question");
  if (!(lim.perRunUsd > 0 && est <= lim.perRunUsd)) return refuse("budget_per_run");
  if (!(lim.monthlyUsd > 0 && est <= lim.monthlyUsd)) return refuse("budget_monthly");
  if (!(lim.totalUsd > 0 && est <= lim.totalUsd)) return refuse("budget_total");

  const t0 = clock();
  const entry = { ...entryBase, mode: client.mode, nowMs: t0 };
  const caps = { question: lim.perQuestionUsd, run: lim.perRunUsd, month: lim.monthlyUsd, total: lim.totalUsd };

  // Atomic reserve BEFORE the call.
  let rsv;
  try { rsv = await store.reserveCall(caller, { entry, est, caps }); }
  catch (e) { return blocked("ledger_unreadable", { detail: e instanceof StoreError ? e.code : "error" }); }  // detail: not_ready (tables missing) or ledger_unreadable

  if (!rsv.reserved) {
    // Some cap would be exceeded by reserved + spent + estimate. Read the sums only to name which one (the decision was already made atomically).
    let reason = "budget_contended";
    try {
      const s = await store.readLedgerSums(caller, { mode: client.mode, runId: m.runId, questionId: m.questionId, nowMs: t0 });
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
  let response, usageUnverified = false;
  try {
    response = await client.complete(request);
  } catch (e) {
    if (e instanceof DeskModelError && e.code === "bad_usage" && e.response) {
      // 2xx with an untrustworthy usage block: billed, price unknown. Keep the answer, charge the reservation.
      response = e.response; usageUnverified = true;
    } else {
      const code = e instanceof DeskModelError ? e.code : "client_error";
      // The ledger keeps the short, non-secret detail too (HTTP status and the provider's error TYPE, e.g. "http_error:400:invalid_request_error"),
      // so a failed call explains itself. Never the provider's message or body. The caller-facing `detail` stays the bare code.
      const ledgerCode = e instanceof DeskModelError ? [e.code, e.status || null, e.providerType || null, e.providerPath || null].filter((x) => x !== null).join(":") : code;
      const cost = definitelyNotBilled(e) ? 0 : est;
      try { await store.finalizeCall(caller, callId, { costUsd: cost, latencyMs: clock() - t0, errorCode: ledgerCode }); } catch (_) { /* reservation stays at its estimate */ }
      return blocked("model_error", { detail: code, callId });
    }
  }

  const latency = clock() - t0;
  const usage = response && response.usage;
  let cost = est;
  if (!usageUnverified) {
    try { cost = costUsd(request.model, usage); } catch (_) { usageUnverified = true; cost = est; /* missing, malformed or unpriceable usage: charge the worst case */ }
  }
  const tok = (k) => (!usageUnverified && usage && Number.isFinite(Number(usage[k])) ? Number(usage[k]) : null);
  const warnings = [];
  if (usageUnverified) warnings.push("usage_unverified");
  try {
    await store.finalizeCall(caller, callId, {
      inputTokens: tok("input_tokens"), outputTokens: tok("output_tokens"), cacheReadTokens: tok("cache_read_input_tokens"), cacheWriteTokens: tok("cache_creation_input_tokens"),
      costUsd: cost, latencyMs: latency, errorCode: usageUnverified ? "usage_unverified" : null,
    });
  } catch (_) { warnings.push("finalize_failed"); /* the paid response is kept; the unfinalized reservation keeps counting at the worst case */ }

  return { ok: true, response, usage, costUsd: cost, callId, mode: client.mode, ...(warnings.length ? { ledgerWarning: warnings[0], ledgerWarnings: warnings } : {}) };
}
