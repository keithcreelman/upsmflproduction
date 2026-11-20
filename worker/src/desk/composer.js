// Commissioner Desk: the composer. One call with a single forced tool, `emit_card`, whose input is the card the validator
// checks. The composer never sees raw tool JSON: it sees fact ids with display strings, gaps, refusals and retrieved rule text,
// all wrapped as data. The SERVER builds the card the page renders (buildServerCard); the model's text is only the prose in it.
// Cards for budget, tool failure, stale data and out-of-scope are built by CODE (codeCard) with no model-written text.

import { formatFact, MODEL_CARD_STATES, GAP_REASONS } from "./contract.js";
import { MODELS, getPrompt, promptHash } from "./prompts.js";
import { scanForInjection, wrapAsData, INJECTION_NOTE } from "./injection.js";
import { buildFactIndex, collectToolGaps, MAX_CARD_GAPS, LIMITS } from "./validator.js";

const STR = (max) => ({ type: "string", maxLength: max });
export const EMIT_CARD_TOOL = Object.freeze({
  name: "emit_card",
  description: "Emit the answer card. Call exactly once. Numbers only as {{f.ID}} tokens.",
  input_schema: {
    type: "object",
    properties: {
      state: { type: "string", enum: MODEL_CARD_STATES },
      lead_md: STR(LIMITS.lead_md),
      blocks: {
        type: "array", maxItems: LIMITS.blocks,
        items: {
          type: "object", additionalProperties: false, required: ["type"],
          properties: {
            type: { type: "string", enum: ["table", "timeline", "chart", "branch", "comparison"] }, title: STR(LIMITS.block_title),
            columns: { type: "array", maxItems: LIMITS.columns, items: STR(LIMITS.column_label) },
            rows: { type: "array", maxItems: LIMITS.rows, items: { type: "array", maxItems: LIMITS.cells, items: STR(LIMITS.cell) } },
            fact_ids: { type: "array", maxItems: LIMITS.block_fact_ids, items: STR(70) },
            tool_call_ids: { type: "array", maxItems: LIMITS.block_tool_call_ids, items: STR(8) },
          },
        },
      },
      facts_used: { type: "array", maxItems: LIMITS.facts_used, items: STR(70) },
      cites: { type: "array", maxItems: LIMITS.cites, items: { type: "object", additionalProperties: false, required: ["anchor", "canon_sha"], properties: { anchor: STR(LIMITS.anchor), canon_sha: STR(40), claim: STR(LIMITS.claim) } } },
      gaps: { type: "array", maxItems: LIMITS.gaps, items: { type: "object", additionalProperties: false, required: ["what", "why"], properties: { what: STR(LIMITS.gap_what), why: { type: "string", enum: GAP_REASONS }, source_needed: STR(LIMITS.gap_source) } } },
      conflicts: { type: "array", maxItems: LIMITS.conflicts, items: { type: "object", additionalProperties: false, required: ["fact_a", "fact_b"], properties: { fact_a: STR(70), fact_b: STR(70), note: STR(LIMITS.conflict_note) } } },
      ruling_question: STR(LIMITS.ruling_question),
      follow_ups: { type: "array", maxItems: LIMITS.follow_ups, items: STR(LIMITS.follow_up) },
    },
    required: ["state", "lead_md"],
    additionalProperties: false,
  },
});

// ── Evidence summary ──────────────────────────────────────────────────────────────────────────────
function isNoise(env) {
  const code = env && env.error && env.error.code;
  return (env.status === "forbidden" && code === "unknown_tool") || (env.status === "error" && code === "bad_arguments");
}

// Rules RETURNED in this run: any object with a string `anchor` inside the data of an OK rules.search or rules.get result.
// This is the only source for cite binding (validator ctx.retrievedAnchors) and for the excerpt the server shows beside a cite.
// `children` and `suggestions` are pointers, not retrieved text, so they are not walked.
export const RULE_TOOLS = Object.freeze(["rules.search", "rules.get"]);
const EXCERPT_CHARS = 400;
export function retrievedRules(envelopes, max = 200) {
  const out = new Map();
  const walk = (v, canon, depth) => {
    if (!v || typeof v !== "object" || depth > 6 || out.size >= max) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, canon, depth + 1); return; }
    const sha = typeof v.canon_sha === "string" ? v.canon_sha : canon;
    if (typeof v.anchor === "string" && !out.has(v.anchor)) {
      out.set(v.anchor, {
        anchor: v.anchor, canon_sha: sha ? String(sha).slice(0, 7) : "",
        title: String(v.title || "").slice(0, 160), path: String(v.path || v.section || "").slice(0, 200),
        text: String(v.text || v.snippet || v.summary || v.excerpt || "").slice(0, EXCERPT_CHARS),
      });
    }
    for (const k of Object.keys(v)) if (k !== "children" && k !== "suggestions" && v[k] && typeof v[k] === "object") walk(v[k], sha, depth + 1);
  };
  for (const e of envelopes || []) if (e && e.status === "ok" && RULE_TOOLS.includes(e.tool)) walk(e.data, null, 0);
  return out;
}
export function collectRules(envelopes) { return [...retrievedRules(envelopes, 8).values()]; }

export function summarizeEvidence(envelopes) {
  const real = (envelopes || []).filter((e) => !isNoise(e));
  const lines = ["TOOLS RUN:"];
  for (const e of real) lines.push(`- ${e.call_id} ${e.tool}: ${e.status}`);
  lines.push("FACTS (use these ids in {{f.ID}} tokens; display shows how the page will print it):");
  let nFacts = 0;
  for (const e of real) for (const f of e.facts || []) { nFacts += 1; lines.push(`- id=${f.id} | ${f.label} | display=${formatFact(f)} | grade ${f.grade} | as_of ${f.as_of}`); }
  if (!nFacts) lines.push("- (none)");
  lines.push("GAPS (the desk adds every one of these to the card itself, word for word; do not rewrite or repeat them):");
  let nGaps = 0;
  for (const e of real) for (const g of (e.coverage && e.coverage.gaps) || []) { nGaps += 1; lines.push(`- ${e.call_id} why=${g.why} | ${String(g.what || "").slice(0, 160)} | source_needed: ${String(g.source_needed || "").slice(0, 120)}`); }
  if (!nGaps) lines.push("- (none)");
  lines.push("REFUSALS AND FAILURES (a decline, never a guess):");
  let nRef = 0;
  for (const e of real) {
    if (e.status === "ok") continue;
    nRef += 1;
    const why = e.refusal ? `${e.refusal.code}: ${String(e.refusal.reason || "").slice(0, 160)}` : e.error ? `${e.error.code}: ${String(e.error.message || "").slice(0, 120)}` : "";
    lines.push(`- ${e.call_id} ${e.tool}: ${e.status}${why ? " | " + why : ""}`);
  }
  if (!nRef) lines.push("- (none)");
  lines.push("RULES RETRIEVED (cite by anchor and canon_sha only):");
  const rules = collectRules(real);
  for (const r of rules) lines.push(`- anchor=${r.anchor} canon_sha=${r.canon_sha} | ${r.title} | ${r.text}`);
  if (!rules.length) lines.push("- (none)");
  return lines.join("\n");
}

// errors: the previous attempt's validator errors, as codes and paths only.
export function composerMessages({ question, asOf, evidenceText, suspicious, errors }) {
  let text = `${wrapAsData("question", question, { id: "q" })}\nas_of: ${asOf}\n${wrapAsData("evidence", evidenceText, { id: "e" }, suspicious)}\nCompose the card now by calling emit_card.`;
  if (errors && errors.length) {
    const lines = errors.slice(0, 20).map((e) => `- ${e.code} at ${String(e.path || "").replace(/[^\w.\[\]-]/g, "").slice(0, 80)}: ${String(e.message || "").slice(0, 140)}`);
    text += `\nYour previous card was rejected. Fix every problem and emit a corrected card:\n${lines.join("\n")}`;
  }
  return [{ role: "user", content: [{ type: "text", text }] }];
}

// Calls the model once. Returns { ok:true, card, suspicious } | { ok:false, blocked } | { ok:false, noCard:true }.
export async function composeCard({ question, asOf, envelopes, call, errors, extraSuspicious }) {
  const evidenceText = summarizeEvidence(envelopes);
  const scan = scanForInjection(evidenceText);
  const suspicious = scan.suspicious || !!extraSuspicious;
  const res = await call({
    step: errors && errors.length ? "retry" : "composer", model: MODELS.composer, system: getPrompt("composer").text,
    messages: composerMessages({ question, asOf, evidenceText, suspicious, errors }),
    tools: [EMIT_CARD_TOOL], tool_choice: { type: "tool", name: EMIT_CARD_TOOL.name }, max_tokens: 2500, promptHash: await promptHash("composer"),
  });
  if (!res.ok) return { ok: false, blocked: res };
  const block = ((res.response && res.response.content) || []).find((b) => b && b.type === "tool_use" && b.name === EMIT_CARD_TOOL.name);
  if (!block || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) return { ok: false, noCard: true, suspicious: scan.suspicious };
  return { ok: true, card: block.input, suspicious: scan.suspicious };
}

// ── Server-built cards ────────────────────────────────────────────────────────────────────────────
const CODE_TEXT = Object.freeze({
  budget_exceeded: "Paused: the AI budget for this period has been reached. Nothing was sent to the model.",
  tool_failure: "Could not verify this right now. No answer is shown and no numbers are filled in.",
  out_of_scope: "The desk answers read-only questions about UPS league records and rules. It cannot post, send, change or accept anything.",
  stale_data: "A source needed for this answer is older than its freshness limit, so the answer is withheld.",
});

function newRequestId(deps) {
  if (deps && typeof deps.requestId === "function") return String(deps.requestId());
  return `req_${globalThis.crypto.randomUUID()}`;
}
function round6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }

function baseCard({ state, asOf, canonSha, requestId, calls, costUsd, modelCalls, notes }) {
  return {
    request_id: requestId, state,
    header: { ai_generated: true, as_of: asOf, canon_sha: canonSha ? String(canonSha).slice(0, 7) : "", phase: "P1" },
    footer: { tools: (calls || []).map((c) => ({ id: c.id, status: c.status, ms: c.ms })), cost_usd: round6(costUsd), model_calls: modelCalls || 0 },
    notes: [...(notes || [])],
  };
}

// A card whose text is written by code alone. state: budget_exceeded | tool_failure | out_of_scope | stale_data.
export function codeCard(state, o) {
  if (!CODE_TEXT[state]) throw new Error(`no code-built card for state ${state}`);
  return {
    ...baseCard({ state, ...o, requestId: o.requestId }),
    lead_md: CODE_TEXT[state], blocks: [], facts_used: [], facts: {}, cites: [], gaps: [], conflicts: [], ruling_question: "", follow_ups: [],
    tool_gaps: [], refusals: [], reason_code: o.reasonCode || state,
  };
}

// Gap entries are built in code: every tool gap verbatim (digits in them are code-sourced), then the model's own extra gaps,
// which the validator already held to the no-digits rule. An exact model copy of a tool gap was dropped by the validator.
export function codeBuiltGaps(modelGaps, envelopes) {
  const fromTools = collectToolGaps(envelopes).map(({ what, why, source_needed }) => ({ what, why, source_needed }));
  return [...fromTools, ...(modelGaps || [])].slice(0, MAX_CARD_GAPS);
}

// Each accepted cite gets the rule's own title, path and an excerpt of its text from the retrieved tool data, never from the model.
// (Code cannot prove a rule supports the claim; showing the quoted text next to it lets the commissioner judge.)
export function attachRuleText(cites, envelopes) {
  const rules = retrievedRules(envelopes);
  return (cites || []).map((c) => {
    const r = rules.get(c.anchor);
    return { ...c, rule: r ? { title: r.title, path: r.path, excerpt: r.text, canon_sha: r.canon_sha } : null };
  });
}

// The card the page renders, from a CLEANED (validated) model card plus this run's envelopes. Raw tool data never goes in.
export function buildServerCard({ cleaned, envelopes, calls, asOf, canonSha, requestId, costUsd, modelCalls, notes }) {
  const index = buildFactIndex(envelopes);
  const facts = {};
  for (const id of cleaned.facts_used) {
    const f = index.get(id);
    if (!f) continue; // the validator guarantees presence; never invent
    facts[id] = { value: f.value, unit: f.unit, display: formatFact(f), grade: f.grade, source: f.source, as_of: f.as_of, tool: f.tool, call_id: f.call_id, label: f.label };
  }
  const real = (envelopes || []).filter((e) => !isNoise(e));
  const toolGaps = [];
  const refusals = [];
  for (const e of real) {
    for (const g of (e.coverage && e.coverage.gaps) || []) toolGaps.push({ tool: e.tool, call_id: e.call_id, what: String(g.what || "").slice(0, 200), why: g.why, source_needed: String(g.source_needed || "").slice(0, 200) });
    if (e.status !== "ok") refusals.push({ tool: e.tool, call_id: e.call_id, status: e.status, code: (e.refusal && e.refusal.code) || (e.error && e.error.code) || null });
  }
  return {
    ...baseCard({ state: cleaned.state, asOf, canonSha, requestId, calls, costUsd, modelCalls, notes }),
    lead_md: cleaned.lead_md, blocks: cleaned.blocks, facts_used: cleaned.facts_used, facts, cites: attachRuleText(cleaned.cites, envelopes), gaps: codeBuiltGaps(cleaned.gaps, envelopes),
    conflicts: cleaned.conflicts, ruling_question: cleaned.ruling_question, follow_ups: cleaned.follow_ups, tool_gaps: toolGaps, refusals,
  };
}

export { newRequestId, INJECTION_NOTE };
