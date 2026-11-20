// Commissioner Desk: the question pipeline. route -> loop -> compose -> validate -> server card.
//
//   answerQuestion({ caller, question, asOf, requestId?, deps }) -> { card, trace }
//
// deps = { callModel, fetchSelf, now, nowMs, knowledge, audit?, requestId? }   (callModel is the budget gate's metered client)
//
// Guarantees:
//  - A caller that is not the proven commissioner throws DeskAuthError before any model call (the handler turns it into a 403).
//  - A bad question (empty, over 600 characters, bad as_of) throws DeskInputError (the handler turns it into a 400).
//  - Code chooses budget_exceeded, tool_failure, stale_data and out_of_scope; those cards carry no model-written text.
//  - A card the validator rejects gets ONE retry of the composer with the error codes; a second failure is a code-built
//    tool_failure. Raw tool JSON and stack traces never enter a card or the trace.

import { assertCommishCaller, isAsOf } from "./contract.js";
import { promptHash } from "./prompts.js";
import { routeQuestion } from "./router.js";
import { runLoop } from "./loop.js";
import { composeCard, buildServerCard, codeCard, newRequestId, retrievedRules } from "./composer.js";
import { validateCard, errorCodes } from "./validator.js";
import { INJECTION_NOTE } from "./injection.js";

export const MAX_QUESTION_CHARS = 600;
const MAX_RAW_CHARS = 20000;

export class DeskInputError extends Error {
  constructor(code, message) { super(message); this.name = "DeskInputError"; this.code = code; this.status = 400; }
}

// Control, bidi and zero-width characters are removed; tabs and newlines become spaces; whitespace collapses.
export function sanitizeQuestion(q) {
  return String(q).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function isBudgetBlock(res) {
  const r = String((res && res.reason) || "");
  return r.startsWith("budget_") || r.startsWith("live_calls_disabled");
}
function isStaleWithhold(env) {
  if (!env) return false;
  if (env.refusal && env.refusal.code === "stale_data") return true;
  const f = env.freshness;
  return !!(f && f.stale === true && (f.policy === "withhold" || f.withhold === true));
}

export async function answerQuestion({ caller, question, asOf, requestId: givenRequestId, deps }) {
  assertCommishCaller(caller); // before anything else: no model call happens for a non-commissioner

  if (typeof question !== "string") throw new DeskInputError("BAD_QUESTION", "the question must be text");
  if (question.length > MAX_RAW_CHARS) throw new DeskInputError("QUESTION_TOO_LONG", `the question is longer than ${MAX_QUESTION_CHARS} characters`);
  const q = sanitizeQuestion(question);
  if (!q) throw new DeskInputError("EMPTY_QUESTION", "the question is empty");
  if (q.length > MAX_QUESTION_CHARS) throw new DeskInputError("QUESTION_TOO_LONG", `the question is longer than ${MAX_QUESTION_CHARS} characters`);
  const requestedAsOf = asOf == null || asOf === "" ? "current" : asOf;
  if (!isAsOf(requestedAsOf)) throw new DeskInputError("BAD_AS_OF", "as_of must be 'current' or YYYY-MM-DD");

  const t0 = deps.nowMs();
  const requestId = typeof givenRequestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(givenRequestId) ? givenRequestId : newRequestId(deps);
  const rules = deps.knowledge && deps.knowledge.rules;
  const canonSha = (rules && rules.canon_sha) || (deps.knowledge && deps.knowledge.rulesMeta && (deps.knowledge.rulesMeta.canon_sha7 || deps.knowledge.rulesMeta.canon_sha)) || "";
  const today = deps.now().toISOString().slice(0, 10);
  const trace = { request_id: requestId, as_of: requestedAsOf, route: null, steps: [], rounds: 0, tool_calls: 0, attempts: [], injection: { suspicious: false, sources: [] }, outcome: null, prompts: {}, cost_usd: 0, model_calls: 0, ms: 0 };
  const acc = { costUsd: 0, modelCalls: 0 };
  let calls = [];

  // The only door to the model: metered (the budget gate is behind deps.callModel) and never throws.
  const call = async (request) => {
    const s0 = deps.nowMs();
    let res;
    try { res = await deps.callModel(request); }
    catch (_) { res = { ok: false, blocked: true, reason: "model_call_threw" }; }
    const ok = !!(res && res.ok === true && res.response);
    trace.steps.push({ step: request.step, model: request.model, ok, ms: Math.max(0, deps.nowMs() - s0), ...(ok ? {} : { reason: String((res && res.reason) || "blocked").slice(0, 80) }) });
    if (ok) { acc.modelCalls += 1; acc.costUsd += Number(res.costUsd) || 0; return res; }
    return { ok: false, blocked: true, reason: String((res && res.reason) || "blocked") };
  };

  const finish = (card, outcome) => {
    trace.outcome = outcome; trace.cost_usd = card.footer.cost_usd; trace.model_calls = acc.modelCalls; trace.ms = Math.max(0, deps.nowMs() - t0);
    return { card, trace };
  };
  const meta = (extra) => ({ asOf: requestedAsOf, canonSha, requestId, calls, costUsd: acc.costUsd, modelCalls: acc.modelCalls, ...extra });
  const blockedCard = (res, where) => (isBudgetBlock(res)
    ? finish(codeCard("budget_exceeded", meta({ reasonCode: String(res.reason).slice(0, 60) })), `budget_exceeded:${where}`)
    : finish(codeCard("tool_failure", meta({ reasonCode: `model_unavailable:${where}` })), `tool_failure:${where}`));

  for (const id of ["router", "loop", "composer"]) trace.prompts[id] = await promptHash(id);

  // 1. Route (action verbs are caught in code before any model call).
  const routed = await routeQuestion({ question: q, asOf: requestedAsOf, call });
  if (!routed.ok) return blockedCard(routed.blocked, "router");
  const route = routed.route;
  trace.route = { intent: route.intent, domains: route.domains, needs_as_of: route.needs_as_of, out_of_scope: route.out_of_scope, by: route.by };
  if (route.out_of_scope) return finish(codeCard("out_of_scope", meta({ reasonCode: route.by === "code" ? "action_request" : "out_of_scope" })), "out_of_scope");

  // The as_of the whole run is judged against: the caller's date, else the date the router read from the question, else "current".
  // A date is binding: the loop replaces every tool call's as_of with it. (A router date in the future is honored too; the tools
  // answer unsupported_as_of for it, which fails closed instead of quietly answering with today's data.)
  const effAsOf = requestedAsOf !== "current" ? requestedAsOf : (route.needs_as_of || "current");
  trace.as_of = effAsOf;
  trace.as_of_source = requestedAsOf !== "current" ? "user" : (route.needs_as_of ? "router" : "default");

  // 2. Tool loop.
  const loop = await runLoop({ caller, question: q, asOf: effAsOf, route, call, deps });
  calls = loop.calls; trace.rounds = loop.rounds; trace.tool_calls = loop.toolCalls; trace.injection = loop.injection; trace.as_of_overrides = loop.overrides;
  if (loop.outcome === "blocked") return blockedCard(loop.blocked, "loop");
  if (loop.outcome === "limit") return finish(codeCard("tool_failure", meta({ asOf: effAsOf, reasonCode: `tool_limit:${loop.limit}` })), "tool_failure:limit");
  const envelopes = loop.envelopes;

  // 3. Stale data the policy says to withhold: code decides, no model text.
  if (envelopes.some(isStaleWithhold)) return finish(codeCard("stale_data", meta({ asOf: effAsOf, reasonCode: "stale_withheld" })), "stale_data");

  // 4. Compose, validate, retry once.
  const vctx = { envelopes, knowledge: deps.knowledge, ceiling: caller.ceiling, asOf: effAsOf, today, retrievedAnchors: retrievedRules(envelopes) };
  let errors = null;
  let suspicious = loop.injection.suspicious;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const comp = await composeCard({ question: q, asOf: effAsOf, envelopes, call, errors, extraSuspicious: loop.injection.suspicious });
    if (!comp.ok && comp.blocked) return blockedCard(comp.blocked, attempt === 1 ? "composer" : "retry");
    if (comp.suspicious) suspicious = true;
    let verdict;
    if (!comp.ok) verdict = { ok: false, errors: [{ code: "NO_CARD", path: "", message: "the composer did not return a card through emit_card" }] };
    else verdict = validateCard(comp.card, vctx);
    trace.attempts.push({ attempt, ok: verdict.ok, codes: verdict.ok ? [] : errorCodes(verdict.errors) });
    if (verdict.ok) {
      const notes = suspicious ? [INJECTION_NOTE] : [];
      trace.injection = { suspicious, sources: loop.injection.sources };
      const card = buildServerCard({ cleaned: verdict.cleaned, envelopes, calls, asOf: effAsOf, canonSha, requestId, costUsd: acc.costUsd, modelCalls: acc.modelCalls, notes });
      return finish(card, `card:${card.state}`);
    }
    errors = verdict.errors;
  }
  trace.injection = { suspicious, sources: loop.injection.sources };
  return finish(codeCard("tool_failure", meta({ asOf: effAsOf, reasonCode: "validation_failed", notes: suspicious ? [INJECTION_NOTE] : [] })), "tool_failure:validation");
}
