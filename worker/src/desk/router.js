// Commissioner Desk: the router. One cheap call that classifies the question. It never answers.
// Action requests (post, send, change, accept, trade ...) are caught in CODE before any model call; the model's out_of_scope
// flag is a second net. Either way the card is `out_of_scope` and no tool and no further model call runs.

import { isAsOf } from "./contract.js";
import { MODELS, getPrompt, promptHash, toolChoiceFor } from "./prompts.js";
import { wrapAsData } from "./injection.js";

export const DOMAINS = ["rules", "cap", "contracts", "roster", "trades", "picks", "standings", "history", "calendar", "players", "glossary", "data_freshness", "other"];

export const ROUTE_TOOL = Object.freeze({
  name: "route_question",
  description: "Record how the question should be handled. Call exactly once.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", maxLength: 60, description: "short snake_case label" },
      domains: { type: "array", items: { type: "string", enum: DOMAINS }, maxItems: 6 },
      needs_as_of: { type: ["string", "null"], description: "ISO date YYYY-MM-DD for a past date, else null" },
      out_of_scope: { type: "boolean" },
      reason: { type: "string", maxLength: 200 },
    },
    required: ["intent", "domains", "needs_as_of", "out_of_scope", "reason"],
    additionalProperties: false,
  },
});

// ── Code-side action detection ────────────────────────────────────────────────────────────────────
// Clear action verbs (never a record lookup when they open a request).
const STRONG = "post|send|dm|email|e-mail|announce|publish|tweet|notify|accept|decline|reject|approve|execute|submit|delete|remove|propose|revoke|reinstate|overwrite|deactivate";
// Words that are also nouns in this league ("cut penalty", "tag price", "drop deadline", "trade deadline"): an action only when an object or determiner follows.
const AMBIGUOUS = "trade|drop|cut|sign|release|waive|extend|restructure|tag|add|move|set|change|update|edit|modify|cancel|commit|import|apply|override|counter|activate";
const OBJECT = "him|her|them|it|this|that|these|those|my|our|his|their|me|us|all|every|each|the|a|an";
const PREFIX = "(?:(?:please|kindly|just|now|go\\s+ahead\\s+and|and|then|can\\s+you|could\\s+you|would\\s+you|will\\s+you|i\\s+want\\s+you\\s+to|i\\s+need\\s+you\\s+to|i'd\\s+like\\s+you\\s+to|you\\s+should|you\\s+need\\s+to|let's|lets)\\s+)*";
const ACTION_RES = [
  new RegExp(`(?:^|[.!?;]\\s+)${PREFIX}(?:${STRONG})(?![\\w-])`, "i"),
  new RegExp(`(?:^|[.!?;]\\s+)${PREFIX}(?:${AMBIGUOUS})\\s+(?:${OBJECT})(?![\\w-])`, "i"),
  /\b(?:post|send|dm|announce|publish)\s+(?:this|it|that|these|those)(?![\w-])/i,
  /\b(?:post|send|publish)(?![\w-])[^.?!]{0,30}\bto\s+(?:discord|the\s+(?:league|owners|channel|group|everyone|thread))/i,
  /\bon\s+my\s+behalf\b|\bfor\s+me\s+(?:in|on)\s+(?:mfl|the\s+league)\b/i,
];
// A leading "can you post" style request is an action; a question ABOUT an action ("what happens if the trade is accepted") is not,
// because none of these patterns match mid-sentence verbs without a request prefix.
export function detectActionRequest(question) {
  const q = String(question || "").trim();
  for (const re of ACTION_RES) { const m = q.match(re); if (m) return { action: true, match: m[0].trim().slice(0, 40) }; }
  return { action: false };
}

// ── Router output validation ──────────────────────────────────────────────────────────────────────
export function normalizeRoute(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const intent = typeof input.intent === "string" ? input.intent.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60) : "";
  const domains = Array.isArray(input.domains) ? [...new Set(input.domains.filter((d) => DOMAINS.includes(d)))].slice(0, 6) : [];
  let needs = null;
  if (typeof input.needs_as_of === "string" && input.needs_as_of !== "current" && isAsOf(input.needs_as_of)) needs = input.needs_as_of;
  if (typeof input.out_of_scope !== "boolean") return null;
  return { intent: intent || "unknown", domains, needs_as_of: needs, out_of_scope: input.out_of_scope, reason: typeof input.reason === "string" ? input.reason.slice(0, 200) : "" };
}

// call(request) is the pipeline's metered model caller (budget gate behind it). Returns { ok:true, route } or { ok:false, blocked }.
export async function routeQuestion({ question, asOf, call }) {
  const action = detectActionRequest(question);
  if (action.action) return { ok: true, route: { intent: "action_request", domains: [], needs_as_of: null, out_of_scope: true, reason: "action request", by: "code" }, modelCalls: 0 };
  const hint = asOf && asOf !== "current" ? `Requested as_of: ${asOf}` : "Requested as_of: none";
  const res = await call({
    step: "router", model: MODELS.router, system: getPrompt("router").text,
    messages: [{ role: "user", content: [{ type: "text", text: `${wrapAsData("question", question, { id: "q" })}\n${hint}` }] }],
    tools: [ROUTE_TOOL], tool_choice: toolChoiceFor(MODELS.router, ROUTE_TOOL.name), max_tokens: 300, promptHash: await promptHash("router"),
  });
  if (!res.ok) return { ok: false, blocked: res };
  const block = ((res.response && res.response.content) || []).find((b) => b && b.type === "tool_use" && b.name === ROUTE_TOOL.name);
  const route = block ? normalizeRoute(block.input) : null;
  // A malformed router answer is not trusted and is not fatal: the loop still runs with a neutral route.
  return { ok: true, route: route ? { ...route, by: "model" } : { intent: "unknown", domains: [], needs_as_of: null, out_of_scope: false, reason: "router output unusable", by: "default" }, modelCalls: 1 };
}
