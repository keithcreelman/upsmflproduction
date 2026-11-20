// Commissioner Desk: the bounded tool loop. The model asks for tools; CODE runs them through registry.runTool (the only way a
// tool runs) with the proven caller and a call sequence number. Tool results go back to the model as DATA: delimited, JSON,
// size-bounded, and scanned for instruction-like text (flag only).
//
// Limits: at most 6 tool rounds and 12 tool calls. A model that still wants tools after that gets `limit`, and the pipeline
// answers with a code-built tool_failure card. A tool_use for an unknown tool, or with extra arguments, is answered with an
// error tool_result (the registry refuses it) and counted against the 12.

import { runTool, envelope, toolSpecsForModel, toolIdFromModelName } from "./registry.js";
import { formatFact, assertCommishCaller } from "./contract.js";
import { MODELS, getPrompt, promptHash } from "./prompts.js";
import { scanForInjection, wrapAsData } from "./injection.js";
import { selectToolIds } from "./tool_select.js";
import { classifyResponse } from "./request_contract.js";

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

// Prompt caching (cost only; it changes nothing the model is told). Two breakpoints: the system block (the cache covers tools, then system, so the
// definitions and the prompt are written once and read on every later round) and the LAST block of the newest message (each round reads everything
// before it). The API allows 4 breakpoints at most, so older markers are never kept: the view below is rebuilt each round with a marker on the
// final block only, and the stored history carries none.
const EPHEMERAL = Object.freeze({ type: "ephemeral" });
export function cachedSystem(text) { return [{ type: "text", text, cache_control: { ...EPHEMERAL } }]; }
export function withLastMarker(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return messages;
  const content = last.content.map((b, i) => (i === last.content.length - 1 && b && typeof b === "object" ? { ...b, cache_control: { ...EPHEMERAL } } : b));
  return [...messages.slice(0, -1), { ...last, content }];
}

// The model's assistant turn is sent back to it on the next round, so it must stay a VALID turn (found by the second live run, R2, question 3: a round that
// had many parallel tool calls and a long reply was answered with HTTP 400 invalid_request_error on the next round). Before, every block that was not a
// tool_use became a text block, so a "thinking" block turned into an EMPTY text block, which the API rejects, and the thinking itself was lost. Now:
//   tool_use           rebuilt from its three fields (as before)
//   text               kept only when it has text (an empty text block is never sent)
//   thinking           returned exactly as received (type, thinking, signature): the API checks that a replayed thinking block is unchanged
//   redacted_thinking  returned exactly as received (type, data)
//   anything else      dropped
// Thinking text is the model's own and goes only back to the same model; it is never shown on a card or read by any code.
export function cleanBlock(b) {
  if (!b || typeof b !== "object") return null;
  // A tool call with no usable id or name can never be paired with a result, so it is dropped rather than replayed (a request carrying it would be refused).
  if (b.type === "tool_use") return typeof b.id === "string" && b.id && typeof b.name === "string" && b.name ? { type: "tool_use", id: b.id, name: b.name, input: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {} } : null;
  if (b.type === "text") return typeof b.text === "string" && b.text.trim() !== "" ? { type: "text", text: b.text } : null;
  if (b.type === "thinking") return typeof b.thinking === "string" && typeof b.signature === "string" ? { type: "thinking", thinking: b.thinking, signature: b.signature } : null;
  if (b.type === "redacted_thinking") return typeof b.data === "string" ? { type: "redacted_thinking", data: b.data } : null;
  return null;
}

// ctx: { caller, question, asOf, route, call, deps }  (call = the pipeline's metered model caller)
export async function runLoop({ caller, question, asOf, forbidCurrent = false, range = null, route, call, deps }) {
  assertCommishCaller(caller);
  const allSpecs = toolSpecsForModel();
  // Only the definitions this question can plausibly need (see tool_select.js). Authorization is unchanged: runTool checks every call.
  const selection = selectToolIds({ route, question, allIds: allSpecs.map((s) => toolIdFromModelName(s.name)) });
  const chosen = new Set(selection.ids);
  let specs = allSpecs.filter((s) => chosen.has(toolIdFromModelName(s.name)));
  let offered = new Set(specs.map((s) => s.name));
  const system = getPrompt("loop").text;
  const hash = await promptHash("loop");
  let toolIds = specs.map((s) => toolIdFromModelName(s.name));
  const pinned = asOf && asOf !== "current" ? `Pinned as_of for this question: ${asOf}` : "as_of for this question: current unless the question names a past date";
  const rangeText = range ? ` It covers a range (${range.last_n ? `the last ${range.last_n} ${range.unit}` : `from ${range.from}${range.to ? ` to ${range.to}` : " to now"}`}): check each season in it with its own dated call.` : "";
  const compare = forbidCurrent ? `\nThis question compares several dates.${rangeText} Pass an explicit date (YYYY-MM-DD) as as_of on every call, one call per date. A call with as_of current is refused.` : "";
  const first = `${wrapAsData("question", question, { id: "q" })}\n${pinned}${compare}\nRoute: ${route ? route.intent : "unknown"} (${route ? route.domains.join(", ") : ""})`;
  const messages = [{ role: "user", content: [{ type: "text", text: first }] }];

  const envelopes = [];
  const calls = [];            // [{id, call_id, status, ms}]
  const injectionSources = []; // call ids whose results looked instruction-like
  const overrides = [];        // [{call_id, tool, sent, forced}]: calls whose as_of the model sent and code replaced
  const pinnedDate = typeof asOf === "string" && asOf !== "current" ? asOf : null;
  let rounds = 0, callSeq = 0, truncatedAny = false;
  const done = (outcome, extra = {}) => ({ outcome, selection, envelopes, calls, rounds, toolCalls: callSeq, injection: { suspicious: injectionSources.length > 0, sources: injectionSources }, overrides, truncated: truncatedAny, ...extra });

  for (;;) {
    const res = await call({ step: "loop", model: MODELS.loop, system: cachedSystem(system), messages: withLastMarker(messages), tools: specs, max_tokens: LOOP_LIMITS.maxTokens, promptHash: hash, toolIds });
    if (!res.ok) return done("blocked", { blocked: res });
    // A reply cut off by max_tokens may hold a half-written tool call (more likely when the model thinks and calls many tools at once), a refusal has nothing to
    // run, and a malformed reply cannot be trusted: all three fail closed and run nothing from the reply (one classifier, request_contract.classifyResponse).
    const cls = classifyResponse(res.response);
    if (cls.truncated) return done("limit", { limit: "max_tokens" });
    if (cls.refusal) return done("limit", { limit: "refusal" });
    if (cls.malformed) return done("limit", { limit: "bad_response" });
    // Clean the turn, then drop a tool call whose id repeats an earlier one in the same turn (the second could not be answered separately).
    const seenIds = new Set();
    const content = ((res.response && res.response.content) || []).map(cleanBlock).filter(Boolean).filter((b) => {
      if (b.type !== "tool_use") return true;
      if (seenIds.has(b.id)) return false;
      seenIds.add(b.id);
      return true;
    });
    const uses = content.filter((b) => b.type === "tool_use");
    if (!uses.length) {
      // Safety valve for a narrowed set: a first reply that used NO tool at all may mean the router sent the question to the wrong domain, so the
      // loop widens ONCE to every definition and asks again (one more model call, only in this rare case). Never after any tool has run.
      if (selection.reason === "domains" && callSeq === 0 && rounds === 0 && specs.length < allSpecs.length) {
        specs = allSpecs; offered = new Set(specs.map((s) => s.name)); toolIds = specs.map((s) => toolIdFromModelName(s.name));
        selection.widened = true; selection.offered = specs.length; selection.ids = toolIds;
        continue;
      }
      return done("complete");
    }
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
      // When the question is about a past date, the date is CODE's decision: whatever as_of the model sent is replaced, so a
      // current-only tool can never be asked for (and answer with) today's data. When the as_of is "current" the model may still
      // pass a past date itself (a history question).
      let input = u.input;
      if (pinnedDate && input && typeof input === "object" && !Array.isArray(input)) {
        if (input.as_of !== pinnedDate) overrides.push({ call_id: `c${callSeq}`, tool: toolId, sent: typeof input.as_of === "string" ? input.as_of.slice(0, 20) : null, forced: pinnedDate });
        input = { ...input, as_of: pinnedDate };
      }
      let env;
      if (forbidCurrent && !pinnedDate && !(input && typeof input === "object" && typeof input.as_of === "string" && input.as_of !== "current" && input.as_of !== "")) {
        // A multi-date comparison: "current" (or no as_of) is refused by code; nothing runs. The call is counted.
        env = envelope({ tool: toolId, call_id: `c${callSeq}`, status: "error", error: { code: "as_of_required", message: "this question compares several dates; pass an explicit date (YYYY-MM-DD) as as_of, never current" }, coverage: { supported: false, gaps: [] } });
      } else env = await runTool({ caller, callSeq }, toolId, input, deps);
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
