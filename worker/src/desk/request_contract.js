// Commissioner Desk: the request/response CONTRACT check. Pure, deterministic, no network, no database, no clock.
//
// WHY: three paid runs (R1 to R3) each stopped on something the free offline tests could not see: a request the real API refuses (a forced tool choice on a model that
// rejects it; a replayed assistant turn that carried an empty text block), and a rule duplicated in two places. This module is the one place that states what a
// request must look like, and the budget gate (budget.js guardedCall) runs it on the ACTUAL request object every pipeline step produces, in tests, dry runs and live
// runs alike, before any reservation or call. A request that breaks an error rule is refused as `request_contract` and never sent.
//
// WHAT IT IS NOT: a guarantee that the provider accepts a request. It encodes the rules we know and have been bitten by or that the published API notes state
// plainly (see COVERED and NOT_COVERED below, and docs/ai_desk/PREFLIGHT_CONTRACT.md). A request that passes can still be refused; a model's reply can still surprise.
//
// Severity: "error" blocks the call; "warn" is reported (tests assert on it) but never blocks.

import { buildBody } from "./anthropic_client.js";
import { FORCED_TOOL_MODELS } from "./prompts.js";

export const MAX_CACHE_BREAKPOINTS = 4;                       // the API's limit per request
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;          // the API's rule for a tool name (so no dots: ours use "__")
const BLOCK_TYPES = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking"]);
const STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal", "pause_turn"]);
// Models that reject sampling parameters (per the published notes for Sonnet 5.5 and Opus 5.5).
const NO_SAMPLING_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5"]);

export const COVERED = Object.freeze([
  "forced tool_choice only on models known to accept it; a named tool must be offered",
  "message order: first message is the user's, last is the user's (no prefill), roles alternate (warning)",
  "block types, non-blank text blocks, tool_use shape (id, name, object input), unique tool_use ids",
  "tool_use/tool_result pairing: every call answered by id in the very next user message, no orphan result, results first in that message",
  "thinking and redacted_thinking blocks: assistant turns only, well-formed, before text and tool calls",
  "cache_control: at most 4 breakpoints, ephemeral only, never on a thinking block or an empty block",
  "tool definitions: names the API accepts, unique, object schema, description string",
  "system prompt shape; sampling parameters that the model rejects",
  "response classification: truncated (max_tokens), refusal, malformed content, unknown stop reason",
]);
export const NOT_COVERED = Object.freeze([
  "whether the provider accepts the request (limits, new rules, account settings, model availability are only known by sending it)",
  "semantic quality of any answer, or whether a cited rule supports a claim",
  "token counts, price, rate limits, latency, and whether a cache entry is created or read",
  "tool-result content beyond non-blank text (a result the provider dislikes for another reason)",
  "any behavior of a model that is not in the adversarial scenarios (docs/ai_desk/PREFLIGHT_CONTRACT.md lists them)",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const blankText = (v) => typeof v !== "string" || v.trim() === "";
const blocksOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);

// request: the same object guardedCall receives (model, system, messages, tools, tool_choice, max_tokens, ...). The wire body (buildBody) is what is judged.
// Returns { ok, errors: [{code, path}], warnings: [{code, path}] }. `ok` is true when there is no error.
export function checkRequestContract(request) {
  const errors = [], warnings = [];
  const err = (code, path) => errors.push({ code, path });
  const warn = (code, path) => warnings.push({ code, path });
  if (!isObj(request)) { err("REQUEST_SHAPE", ""); return { ok: false, errors, warnings }; }
  let body;
  try { body = buildBody(request); } catch (_) { err("REQUEST_SHAPE", ""); return { ok: false, errors, warnings }; }
  const model = typeof body.model === "string" ? body.model : "";
  let markers = 0;
  const marker = (b, path, { emptyOrThinking = false } = {}) => {
    if (!isObj(b) || !("cache_control" in b)) return;
    markers += 1;
    const cc = b.cache_control;
    if (!isObj(cc) || cc.type !== "ephemeral" || Object.keys(cc).some((k) => k !== "type" && k !== "ttl")) err("CACHE_CONTROL_SHAPE", `${path}.cache_control`);
    if (emptyOrThinking) err("CACHE_CONTROL_NOT_ALLOWED_HERE", `${path}.cache_control`);
  };

  // system
  if (body.system !== undefined) {
    if (typeof body.system === "string") { if (blankText(body.system)) err("SYSTEM_EMPTY", "system"); }
    else if (Array.isArray(body.system)) {
      if (!body.system.length) err("SYSTEM_EMPTY", "system");
      body.system.forEach((b, i) => {
        const p = `system[${i}]`;
        if (!isObj(b) || b.type !== "text" || blankText(b.text)) { err("SYSTEM_BLOCK", p); return; }
        marker(b, p);
      });
    } else err("SYSTEM_SHAPE", "system");
  }

  // tools
  const toolNames = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) err("TOOLS_SHAPE", "tools");
    else body.tools.forEach((tl, i) => {
      const p = `tools[${i}]`;
      if (!isObj(tl)) { err("TOOLS_SHAPE", p); return; }
      if (typeof tl.name !== "string" || !TOOL_NAME_RE.test(tl.name)) err("TOOL_NAME", `${p}.name`);
      else if (toolNames.has(tl.name)) err("TOOL_NAME_DUPLICATE", `${p}.name`);
      else toolNames.add(tl.name);
      if (!isObj(tl.input_schema) || tl.input_schema.type !== "object") err("TOOL_SCHEMA", `${p}.input_schema`);
      if (tl.description !== undefined && typeof tl.description !== "string") err("TOOL_DESCRIPTION", `${p}.description`);
      marker(tl, p);
    });
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (!isObj(tc) || !["auto", "any", "tool", "none"].includes(tc.type)) err("TOOL_CHOICE_SHAPE", "tool_choice");
    else {
      if ((tc.type === "tool" || tc.type === "any") && !FORCED_TOOL_MODELS.includes(model)) err("TOOL_CHOICE_FORCED_MODEL", "tool_choice");
      if (tc.type === "tool" && !toolNames.has(tc.name)) err("TOOL_CHOICE_UNKNOWN_TOOL", "tool_choice.name");
      if ((tc.type === "tool" || tc.type === "any") && !toolNames.size) err("TOOL_CHOICE_WITHOUT_TOOLS", "tool_choice");
    }
  }

  // model-specific parameters
  if (NO_SAMPLING_MODELS.has(model) && body.temperature !== undefined) err("SAMPLING_PARAM_REJECTED", "temperature");
  // (A `thinking` request parameter cannot be sent at all: buildBody's field whitelist drops it, so there is nothing to judge.)
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) err("MAX_TOKENS", "max_tokens");

  // messages
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) { err("MESSAGES_EMPTY", "messages"); return finish(); }
  if (!isObj(messages[0]) || messages[0].role !== "user") err("FIRST_NOT_USER", "messages[0]");
  const lastMsg = messages[messages.length - 1];
  if (!isObj(lastMsg) || lastMsg.role !== "user") err("LAST_NOT_USER", `messages[${messages.length - 1}]`);
  const seenUseIds = new Set();
  let pending = null;                                   // tool_use ids from the previous assistant message that still need a result
  messages.forEach((m, i) => {
    const mp = `messages[${i}]`;
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant")) { err("MESSAGE_SHAPE", mp); pending = null; return; }
    if (i > 0 && isObj(messages[i - 1]) && messages[i - 1].role === m.role) warn("ROLE_NOT_ALTERNATING", mp);
    if (!(typeof m.content === "string" || Array.isArray(m.content))) { err("CONTENT_SHAPE", `${mp}.content`); pending = null; return; }
    const blocks = blocksOf(m.content);
    if (!blocks.length) err("CONTENT_EMPTY", `${mp}.content`);
    if (typeof m.content === "string" && blankText(m.content)) err("TEXT_EMPTY", `${mp}.content`);

    const isAssistant = m.role === "assistant";
    const useIds = [];
    let sawNonResult = false, sawNonThinking = false;
    const answered = new Set();
    blocks.forEach((b, j) => {
      const bp = `${mp}.content[${j}]`;
      if (!isObj(b) || !BLOCK_TYPES.has(b.type)) { err("BLOCK_TYPE", bp); sawNonResult = true; return; }
      switch (b.type) {
        case "text":
          if (blankText(b.text)) err("TEXT_EMPTY", bp);
          marker(b, bp, { emptyOrThinking: blankText(b.text) });
          sawNonResult = true; sawNonThinking = true; break;
        case "tool_use":
          if (!isAssistant) err("TOOL_USE_IN_USER", bp);
          if (typeof b.id !== "string" || !b.id || typeof b.name !== "string" || !b.name || !isObj(b.input)) err("TOOL_USE_SHAPE", bp);
          else {
            if (seenUseIds.has(b.id)) err("TOOL_USE_DUPLICATE_ID", bp); seenUseIds.add(b.id);
            useIds.push(b.id);
            if (toolNames.size && !toolNames.has(b.name)) warn("TOOL_USE_UNKNOWN_TOOL", bp);
          }
          marker(b, bp);
          sawNonResult = true; sawNonThinking = true; break;
        case "tool_result":
          if (isAssistant) err("TOOL_RESULT_IN_ASSISTANT", bp);
          if (typeof b.tool_use_id !== "string" || !b.tool_use_id) err("TOOL_RESULT_SHAPE", bp);
          else {
            if (!pending || !pending.has(b.tool_use_id)) err("TOOL_RESULT_ORPHAN", bp);
            else if (answered.has(b.tool_use_id)) err("TOOL_RESULT_DUPLICATE", bp);
            else answered.add(b.tool_use_id);
          }
          if (sawNonResult) err("TOOL_RESULT_NOT_FIRST", bp);
          if (typeof b.content === "string" ? blankText(b.content) : Array.isArray(b.content) && b.content.some((x) => isObj(x) && x.type === "text" && blankText(x.text))) err("TOOL_RESULT_EMPTY_TEXT", `${bp}.content`);
          marker(b, bp);
          break;
        case "thinking":
          if (!isAssistant) err("THINKING_IN_USER", bp);
          if (typeof b.thinking !== "string" || typeof b.signature !== "string" || !b.signature) err("THINKING_SHAPE", bp);
          if (sawNonThinking) err("THINKING_ORDER", bp);
          if ("cache_control" in b) { marker(b, bp, { emptyOrThinking: true }); }
          sawNonResult = true; break;
        case "redacted_thinking":
          if (!isAssistant) err("THINKING_IN_USER", bp);
          if (typeof b.data !== "string" || !b.data) err("THINKING_SHAPE", bp);
          if (sawNonThinking) err("THINKING_ORDER", bp);
          if ("cache_control" in b) { marker(b, bp, { emptyOrThinking: true }); }
          sawNonResult = true; break;
        default: break;
      }
    });
    // pairing: the previous assistant message's calls must all be answered by THIS user message
    if (m.role === "user") {
      if (pending && pending.size) for (const id of pending) if (!answered.has(id)) err("TOOL_USE_UNANSWERED", `${mp}.content`);
      pending = null;
    } else {
      if (pending && pending.size) err("TOOL_USE_UNANSWERED", mp);       // an assistant turn followed another with calls still open
      pending = useIds.length ? new Set(useIds) : null;
    }
  });
  if (pending && pending.size) err("TOOL_USE_UNANSWERED", `messages[${messages.length - 1}]`);

  return finish();

  function finish() {
    if (markers > MAX_CACHE_BREAKPOINTS) err("CACHE_CONTROL_COUNT", "");
    return { ok: errors.length === 0, errors, warnings };
  }
}

// A content-free structural description of a request: block TYPES and counts only. Never text, names, ids, arguments, results or thinking.
// Safe to store in a results file or an audit line; it is what you need to find a malformed sequence.
export function describeRequest(request) {
  const out = { model: null, max_tokens: null, tool_choice: null, tools: 0, system_blocks: 0, cache_markers: 0, tool_use: 0, tool_result: 0, messages: [] };
  if (!isObj(request)) return out;
  let body = {};
  try { body = buildBody(request); } catch (_) { return out; }
  out.model = typeof body.model === "string" ? body.model.slice(0, 40) : null;
  out.max_tokens = Number.isInteger(body.max_tokens) ? body.max_tokens : null;
  out.tool_choice = isObj(body.tool_choice) && typeof body.tool_choice.type === "string" ? body.tool_choice.type.slice(0, 10) : null;
  out.tools = Array.isArray(body.tools) ? body.tools.length : 0;
  out.system_blocks = Array.isArray(body.system) ? body.system.length : typeof body.system === "string" ? 1 : 0;
  const count = (v) => { try { return (JSON.stringify(v).match(/"cache_control"/g) || []).length; } catch (_) { return 0; } };
  out.cache_markers = count(body.system) + count(body.tools) + count(body.messages);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const types = [];
    for (const b of blocksOf(isObj(m) ? m.content : null)) {
      const t = isObj(b) && BLOCK_TYPES.has(b.type) ? b.type : "other";
      if (t === "tool_use") out.tool_use += 1;
      if (t === "tool_result") out.tool_result += 1;
      const last = types[types.length - 1];
      if (last && last.t === t) last.n += 1; else types.push({ t, n: 1 });
    }
    out.messages.push({ role: isObj(m) && (m.role === "user" || m.role === "assistant") ? m.role : "other", blocks: types.map((x) => (x.n > 1 ? `${x.t}*${x.n}` : x.t)) });
  }
  return out;
}

// One line a person can read: "assistant[thinking,text,tool_use*9] > user[tool_result*9]".
export function shapeLine(shape) {
  return (shape && Array.isArray(shape.messages) ? shape.messages : []).map((m) => `${m.role}[${m.blocks.join(",")}]`).join(" > ").slice(0, 600);
}

// What came back, classified. Used by the tool loop and the composer so a truncated, refused or malformed reply is handled in ONE way (fail closed).
// response: { content, stop_reason }. Returns { ok, truncated, refusal, malformed, problems }.
export function classifyResponse(response) {
  const problems = [], notes = [];
  if (!isObj(response) || !Array.isArray(response.content)) return { ok: false, truncated: false, refusal: false, malformed: true, problems: ["CONTENT_NOT_ARRAY"], notes };
  const sr = response.stop_reason == null ? null : String(response.stop_reason);
  if (sr !== null && !STOP_REASONS.has(sr)) problems.push("STOP_REASON_UNKNOWN");
  for (const b of response.content) {
    if (!isObj(b) || typeof b.type !== "string") { problems.push("BLOCK_NOT_OBJECT"); continue; }
    // A tool call or text block with a bad field is NOTED, not fatal: the loop answers a bad tool call with an error result and goes on (an established, tested behavior),
    // and the composer treats a tool call without an object input as no card.
    if (b.type === "tool_use" && (typeof b.id !== "string" || !b.id || typeof b.name !== "string" || !isObj(b.input))) notes.push("TOOL_USE_MALFORMED");
    if (b.type === "text" && typeof b.text !== "string") notes.push("TEXT_MALFORMED");
  }
  const truncated = sr === "max_tokens";
  const refusal = sr === "refusal";
  const malformed = problems.length > 0;
  return { ok: !truncated && !refusal && !malformed, truncated, refusal, malformed, problems, notes };
}
