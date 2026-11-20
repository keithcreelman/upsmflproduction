// Commissioner Desk: the bounded tool loop. The model asks for tools; CODE runs them through registry.runTool (the only way a
// tool runs) with the proven caller and a call sequence number. Tool results go back to the model as DATA: delimited, JSON,
// size-bounded, and scanned for instruction-like text (flag only).
//
// Limits: at most 6 tool rounds and 12 tool calls. A model that still wants tools after that gets `limit`, and the pipeline
// answers with a code-built tool_failure card. A tool_use for an unknown tool, or with extra arguments, is answered with an
// error tool_result (the registry refuses it) and counted against the 12.

import { runTool, toolSpecsForModel, toolIdFromModelName } from "./registry.js";
import { formatFact, assertCommishCaller } from "./contract.js";
import { MODELS, getPrompt, promptHash } from "./prompts.js";
import { scanForInjection, wrapAsData } from "./injection.js";

export const LOOP_LIMITS = Object.freeze({ rounds: 6, calls: 12, resultChars: 12000, maxTokens: 1500 });

// What the model sees of one envelope: facts with display strings, gaps, refusal, bounded data. Never allowlists or internals.
export function envelopeForModel(env) {
  const out = {
    tool: env.tool, call_id: env.call_id, status: env.status,
    facts: (env.facts || []).map((f) => ({ id: f.id, label: f.label, value: f.value, display: formatFact(f), unit: f.unit, grade: f.grade, as_of: f.as_of })),
    gaps: ((env.coverage && env.coverage.gaps) || []).slice(0, 10),
    refusal: env.refusal || null,
    error: env.error ? { code: env.error.code, message: String(env.error.message || "").slice(0, 160) } : null,
    freshness: env.freshness || null,
    data: env.data == null ? null : env.data,
  };
  let text = JSON.stringify(out);
  let truncated = false;
  if (text.length > LOOP_LIMITS.resultChars) {
    truncated = true;
    const room = Math.max(1000, LOOP_LIMITS.resultChars - JSON.stringify({ ...out, data: null }).length - 80);
    out.data = { truncated: true, preview: JSON.stringify(env.data).slice(0, room) };
    text = JSON.stringify(out);
  }
  return { text, truncated };
}

function cleanBlock(b) {
  if (b && b.type === "tool_use") return { type: "tool_use", id: String(b.id || ""), name: String(b.name || ""), input: b.input && typeof b.input === "object" ? b.input : {} };
  return { type: "text", text: b && typeof b.text === "string" ? b.text : "" };
}

// ctx: { caller, question, asOf, route, call, deps }  (call = the pipeline's metered model caller)
export async function runLoop({ caller, question, asOf, route, call, deps }) {
  assertCommishCaller(caller);
  const specs = toolSpecsForModel();
  const offered = new Set(specs.map((s) => s.name));
  const system = getPrompt("loop").text;
  const hash = await promptHash("loop");
  const toolIds = specs.map((s) => toolIdFromModelName(s.name));
  const pinned = asOf && asOf !== "current" ? `Pinned as_of for this question: ${asOf}` : "as_of for this question: current unless the question names a past date";
  const first = `${wrapAsData("question", question, { id: "q" })}\n${pinned}\nRoute: ${route ? route.intent : "unknown"} (${route ? route.domains.join(", ") : ""})`;
  const messages = [{ role: "user", content: [{ type: "text", text: first }] }];

  const envelopes = [];
  const calls = [];            // [{id, call_id, status, ms}]
  const injectionSources = []; // call ids whose results looked instruction-like
  let rounds = 0, callSeq = 0, truncatedAny = false;
  const done = (outcome, extra = {}) => ({ outcome, envelopes, calls, rounds, toolCalls: callSeq, injection: { suspicious: injectionSources.length > 0, sources: injectionSources }, truncated: truncatedAny, ...extra });

  for (;;) {
    const res = await call({ step: "loop", model: MODELS.loop, system, messages, tools: specs, max_tokens: LOOP_LIMITS.maxTokens, promptHash: hash, toolIds });
    if (!res.ok) return done("blocked", { blocked: res });
    const content = ((res.response && res.response.content) || []).map(cleanBlock);
    const uses = content.filter((b) => b.type === "tool_use");
    if (!uses.length) return done("complete");
    if (rounds >= LOOP_LIMITS.rounds) return done("limit", { limit: "rounds" });
    if (callSeq + uses.length > LOOP_LIMITS.calls) return done("limit", { limit: "calls" });
    rounds += 1;
    messages.push({ role: "assistant", content });

    const results = [];
    for (const u of uses) {
      callSeq += 1;
      // A name that was not offered never reaches a real tool, even if it spells a registered id with dots.
      const toolId = offered.has(u.name) ? toolIdFromModelName(u.name) : `x.${String(u.name).replace(/[^a-z0-9_.]/gi, "").slice(0, 40) || "unnamed"}`;
      const t0 = deps.nowMs();
      const env = await runTool({ caller, callSeq }, toolId, u.input, deps);
      calls.push({ id: toolId, call_id: env.call_id, status: env.status, ms: Math.max(0, deps.nowMs() - t0) });
      envelopes.push(env);
      const view = envelopeForModel(env);
      if (view.truncated) truncatedAny = true;
      const scan = scanForInjection({ data: env.data, facts: (env.facts || []).map((f) => f.label), gaps: env.coverage && env.coverage.gaps, refusal: env.refusal });
      if (scan.suspicious) injectionSources.push(env.call_id);
      results.push({
        type: "tool_result", tool_use_id: u.id,
        content: [{ type: "text", text: wrapAsData("tool_result", view.text, { tool: env.tool, call: env.call_id }, scan.suspicious) }],
        ...(env.status === "ok" ? {} : { is_error: env.status === "error" || env.status === "forbidden" }),
      });
    }
    messages.push({ role: "user", content: results });
  }
}
