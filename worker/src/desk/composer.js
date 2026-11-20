// Commissioner Desk: the composer. One call with a single forced tool, `emit_card`, whose input is the card the validator
// checks. The composer never sees raw tool JSON: it sees fact ids with display strings, gaps, refusals and retrieved rule text,
// all wrapped as data. The SERVER builds the card the page renders (buildServerCard); the model's text is only the prose in it.
// Cards for budget, tool failure, stale data and out-of-scope are built by CODE (codeCard) with no model-written text.

import { formatFact, MODEL_CARD_STATES, GAP_REASONS } from "./contract.js";
import { MODELS, getPrompt, promptHash, toolChoiceFor } from "./prompts.js";
import { classifyResponse } from "./request_contract.js";
import { scanForInjection, wrapAsData, INJECTION_NOTE } from "./injection.js";
import { buildFactIndex, collectToolGaps, anchorSet, MAX_CARD_GAPS, LIMITS } from "./validator.js";

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
  return (env.status === "forbidden" && code === "unknown_tool") || (env.status === "error" && (code === "bad_arguments" || code === "as_of_required"));
}

// Rules RETURNED in this run: any object with a string `anchor` inside the data of an OK rules.search or rules.get result.
// This is the only source for cite binding (validator ctx.retrievedAnchors) and for the excerpt the server shows beside a cite.
// `children` and `suggestions` are pointers, not retrieved text, so they are not walked.
export const RULE_TOOLS = Object.freeze(["rules.search", "rules.get"]);
const EXCERPT_CHARS = 400;           // what the card displays beside a cite
export const BODY_CHARS = 1500;      // what the composer is shown per rule (its reading material, never displayed)
export const MAX_RULES_WITH_TEXT = 4;
export const MAX_RULE_TITLES = 4;    // further retrieved rules are listed by title only
const MAX_GLOSSARY_ENTRIES = 4;
const GLOSSARY_DEF_CHARS = 700;
const GLOSSARY_CAVEAT_CHARS = 300;
export function retrievedRules(envelopes, max = 200) {
  const out = new Map();
  let toolId = "";
  const walk = (v, canon, depth) => {
    if (!v || typeof v !== "object" || depth > 6 || out.size >= max) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, canon, depth + 1); return; }
    const sha = typeof v.canon_sha === "string" ? v.canon_sha : canon;
    if (typeof v.anchor === "string" && !out.has(v.anchor)) {
      const full = String(v.text || v.snippet || v.summary || v.excerpt || "");
      out.set(v.anchor, {
        anchor: v.anchor, canon_sha: sha ? String(sha).slice(0, 7) : "", tool: toolId,
        title: String(v.title || "").slice(0, 160), path: String(v.path || v.section || "").slice(0, 200),
        text: full.slice(0, EXCERPT_CHARS), body: full.slice(0, BODY_CHARS),
      });
    }
    for (const k of Object.keys(v)) if (k !== "children" && k !== "suggestions" && v[k] && typeof v[k] === "object") walk(v[k], sha, depth + 1);
  };
  for (const e of envelopes || []) if (e && e.status === "ok" && RULE_TOOLS.includes(e.tool)) { toolId = e.tool; walk(e.data, null, 0); }
  // A successful glossary.lookup returns the canon anchors its entries are tied to; those anchors were returned in this run, so they
  // may be cited, and the excerpt is the glossary definition (labeled as such), taken from the tool data like any other.
  for (const e of envelopes || []) {
    if (!e || e.status !== "ok" || e.tool !== "glossary.lookup") continue;
    for (const g of glossaryEntries(e)) {
      for (const a of g.anchors) {
        if (out.has(a) || out.size >= max) continue;
        out.set(a, { anchor: a, canon_sha: "", tool: "glossary.lookup", title: `Glossary: ${g.term}`.slice(0, 160), path: "League glossary", text: g.definition.slice(0, EXCERPT_CHARS), body: g.definition.slice(0, BODY_CHARS) });
      }
    }
  }
  return out;
}
export function collectRules(envelopes) { return [...retrievedRules(envelopes, 8).values()]; }

// Entries of one ok glossary.lookup result: term, definition, caveat, the canon anchors and source files behind it.
export function glossaryEntries(env) {
  const out = [];
  const list = env && env.data && Array.isArray(env.data.entries) ? env.data.entries : [];
  for (const e of list) {
    if (!e || typeof e !== "object" || typeof e.term !== "string") continue;
    const sources = Array.isArray(e.sources) ? e.sources : [];
    out.push({
      term: e.term.slice(0, 80), kind: String(e.kind || "").slice(0, 30), aliases: (Array.isArray(e.aliases) ? e.aliases : []).filter((a) => typeof a === "string").map((a) => a.slice(0, 40)).slice(0, 8), definition: String(e.definition || "").slice(0, GLOSSARY_DEF_CHARS),
      caveat: String(e.caveat || "").slice(0, GLOSSARY_CAVEAT_CHARS), canonSilent: !!e.canon_silent,
      anchors: [...new Set(sources.map((s) => (s && typeof s.anchor === "string" ? s.anchor : "")).filter(Boolean))].slice(0, 6),
      files: [...new Set(sources.map((s) => (s && typeof s.file === "string" ? s.file : "")).filter(Boolean))].slice(0, 3),
    });
    if (out.length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return out;
}

// League terms (and their aliases) the glossary returned this run: the validator lets the card write them as spelled.
export function glossaryTerms(envelopes) {
  const out = [];
  for (const e of envelopes || []) {
    if (!e || e.status !== "ok" || e.tool !== "glossary.lookup") continue;
    for (const g of glossaryEntries(e)) out.push(g.term, ...g.aliases);
  }
  return [...new Set(out)];
}

// opts: { canonSha } the 7 character canon version to print beside glossary anchors; { rulesIndex } to list only citable glossary anchors.
export function summarizeEvidence(envelopes, opts = {}) {
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
  lines.push("RULES RETRIEVED (cite by anchor and canon_sha only; the text is the rule's own words, there to read, not to copy digits from):");
  const all = [...retrievedRules(real).values()].filter((r) => r.tool !== "glossary.lookup");
  // rules.get text first (the full rule), then search hits; the first few with text, the next few by title only.
  const ranked = [...all.filter((r) => r.tool === "rules.get"), ...all.filter((r) => r.tool !== "rules.get")];
  ranked.slice(0, MAX_RULES_WITH_TEXT).forEach((r) => lines.push(`- anchor=${r.anchor} canon_sha=${r.canon_sha} | ${r.title} | ${r.path}\n  text: ${r.body}`));
  ranked.slice(MAX_RULES_WITH_TEXT, MAX_RULES_WITH_TEXT + MAX_RULE_TITLES).forEach((r) => lines.push(`- anchor=${r.anchor} canon_sha=${r.canon_sha} | ${r.title} (title only)`));
  if (!ranked.length) lines.push("- (none)");
  lines.push("GLOSSARY (league terms; write a term exactly as spelled here, even with a digit in it; a definition is not a number source; cite its canon anchor with canon_sha, never a file):");
  const idx = opts.rulesIndex ? anchorSet(opts.rulesIndex) : null;
  let nGloss = 0;
  for (const e of real) {
    if (e.status !== "ok" || e.tool !== "glossary.lookup") continue;
    for (const g of glossaryEntries(e)) {
      nGloss += 1;
      const anchors = g.anchors.filter((a) => !idx || idx.has(a));
      const cite = anchors.length ? `canon anchors (cite with canon_sha ${opts.canonSha || "from RULES"}): ${anchors.join(", ")}` : "no citable canon anchor";
      lines.push(`- ${g.term} (${g.kind})${g.canonSilent ? " [canon is silent on this term]" : ""} | ${g.definition}${g.caveat ? ` | caveat: ${g.caveat}` : ""} | ${cite}${g.files.length ? ` | code source: ${g.files.join(", ")}` : ""}`);
    }
  }
  if (!nGloss) lines.push("- (none)");
  return lines.join("\n");
}

// errors: the previous attempt's validator errors, as codes and paths only.
export function composerMessages({ question, asOf, evidenceText, suspicious, errors }) {
  let text = `${wrapAsData("question", question, { id: "q" })}\nas_of: ${asOf}\n${wrapAsData("evidence", evidenceText, { id: "e" }, suspicious)}\nCompose the card now by calling emit_card.`;
  if (errors && errors.length) {
    const lines = errors.slice(0, 20).map((e) => `- ${e.code} at ${String(e.path || "").replace(/[^\w.\[\]-]/g, "").slice(0, 80)}: ${String(e.message || "").slice(0, 140)}`);
    text += `\nYour previous card was rejected. Fix every problem and emit a corrected card:\n${lines.join("\n")}`;
    // A text-only reply (no emit_card call) is possible because the tool choice is "auto" on Sonnet 5.5: say plainly what is required.
    if (errors.some((e) => e && e.code === "NO_CARD")) text += "\nYour previous reply did not call emit_card. Reply ONLY by calling emit_card, with no text before or after the call.";
  }
  return [{ role: "user", content: [{ type: "text", text }] }];
}

// Calls the model once. Returns { ok:true, card, suspicious } | { ok:false, blocked } | { ok:false, noCard:true }.
export async function composeCard({ question, asOf, envelopes, call, errors, extraSuspicious, canonSha, rulesIndex }) {
  const evidenceText = summarizeEvidence(envelopes, { canonSha: canonSha ? String(canonSha).slice(0, 7) : "", rulesIndex });
  const scan = scanForInjection(evidenceText);
  const suspicious = scan.suspicious || !!extraSuspicious;
  const res = await call({
    step: errors && errors.length ? "retry" : "composer", model: MODELS.composer, system: getPrompt("composer").text,
    messages: composerMessages({ question, asOf, evidenceText, suspicious, errors }),
    tools: [EMIT_CARD_TOOL], tool_choice: toolChoiceFor(MODELS.composer, EMIT_CARD_TOOL.name), max_tokens: 2500, promptHash: await promptHash("composer"),
  });
  if (!res.ok) return { ok: false, blocked: res };
  // A truncated, refused or malformed reply never yields a card, even if it holds a tool call (a cut-off card is not a card): same classifier as the loop.
  if (!classifyResponse(res.response).ok) return { ok: false, noCard: true, suspicious: scan.suspicious };
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
  abstain: "The question refers to a past time without naming a date, so it cannot be checked. Name the date and ask again.",
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

// A card whose text is written by code alone. state: budget_exceeded | tool_failure | out_of_scope | stale_data | abstain.
export function codeCard(state, o) {
  if (!CODE_TEXT[state]) throw new Error(`no code-built card for state ${state}`);
  return {
    ...baseCard({ state, ...o, requestId: o.requestId }),
    lead_md: CODE_TEXT[state], blocks: [], facts_used: [], facts: {}, cites: [], gaps: (o.gaps || []).map((g) => ({ ...g })), conflicts: [], ruling_question: "", follow_ups: [],
    tool_gaps: [], refusals: [], reason_code: o.reasonCode || state,
  };
}

// The card for a run whose only evidence is "the desk has no record" (decline.js decides when). Every word is written by code: a closed sentence, an optional
// one-line note from the coverage matrix (code-sourced, no model text), and the tool's own gaps verbatim (what is missing, why, which League Record slice would
// close it). State abstain; no facts, no cites, no model call.
export const NO_RECORD_TEXT = "The desk has no record for what this question asks about. The gaps below say what is missing and which source would have to supply it. If the question has other parts, ask them separately. No answer is guessed.";
export function noRecordCard({ gaps, toolGaps, note, ...rest }) {
  return {
    ...baseCard({ state: "abstain", ...rest }),
    lead_md: note ? `${NO_RECORD_TEXT} ${note}` : NO_RECORD_TEXT, blocks: [], facts_used: [], facts: {}, cites: [], gaps: (gaps || []).map((g) => ({ ...g })), conflicts: [],
    ruling_question: "", follow_ups: [], tool_gaps: (toolGaps || []).map((g) => ({ ...g })), refusals: [], reason_code: "no_record",
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

// A title list the code completes (Phase 1 closeout, R4 DEV-REC-01: a card named two of a franchise's three title seasons). When the card uses a franchise's title count or its
// list of title seasons, the server attaches ONE complete table for the whole tool result (every franchise with a title, its count, and every season behind it), built from the
// tool's own facts and shown through tokens like any other table. The model still writes the lead; it can no longer leave a season out of what the page shows. Skipped when the
// model's own blocks already carry every season list of that call.
const TITLE_KINDS = Object.freeze([
  { count: "titles", years: "title_years", title: "Championships by franchise, with every season" },
  { count: "toilet_titles", years: "toilet_years", title: "Toilet Bowl titles by franchise, with every season" },
]);
export function completeTitleBlocks({ index, factsUsed, blocks, lead }) {
  const used = new Set(factsUsed || []);
  // What the page SHOWS and RESOLVES: fact tokens in the lead and in the ROW cells of the model's own blocks. A block's fact_ids list is bookkeeping, and a block title or a
  // column label is printed without resolving tokens (site/commish/desk/desk_render.js titleHtml), so neither counts (R15 and R16 reviews).
  const shown = new Set();
  const addTokens = (c) => { if (typeof c === "string") for (const m of c.matchAll(/\{\{f\.([^}]+)\}\}/g)) shown.add(m[1]); };
  addTokens(lead);
  for (const b of blocks || []) {
    if (!b || typeof b !== "object" || !Array.isArray(b.rows) || !["table", "comparison"].includes(b.type)) continue;      // timeline, chart and branch rows are not printed as plain cells (R17 review)
    for (const r of b.rows) for (const c of Array.isArray(r) ? r : []) addTokens(c);
  }
  const inBlocks = shown;
  const calls = new Set();
  for (const id of used) { const m = /^(c\d{1,3})\.(?:titles|title_years|toilet_titles|toilet_years)_f\d{4}$/.exec(id); if (m) calls.add(m[1]); }
  const out = []; const factIds = [];
  for (const call of [...calls].sort()) {
    for (const k of TITLE_KINDS) {
      const years = [...index.keys()].filter((id) => new RegExp(`^${call}\\.${k.years}_f\\d{4}$`).test(id));
      if (!years.length) continue;
      const touched = years.some((id) => used.has(id)) || years.some((id) => used.has(id.replace(k.years, k.count)));
      if (!touched) continue;
      if (years.every((id) => inBlocks.has(id))) continue;
      const rows = years.map((yid) => {
        const fid = /_f(\d{4})$/.exec(yid)[1];
        const cnt = `${call}.${k.count}_f${fid}`;
        const last = String(index.get(yid).value).split(", ").map(Number).filter(Number.isFinite).sort((a, b) => b - a)[0];
        const team = `${call}.s${last}_f${fid}_team`;
        return { fid, yid, cnt, team: index.has(team) ? team : null, n: Number(index.get(cnt) && index.get(cnt).value) || 0 };
      }).filter((r) => index.has(r.cnt)).sort((a, b) => b.n - a.n || a.fid.localeCompare(b.fid));
      if (!rows.length) continue;
      const ids = rows.flatMap((r) => [r.team, r.cnt, r.yid].filter(Boolean));
      out.push({ type: "table", title: k.title, columns: ["Franchise", "Titles", "Seasons"], rows: rows.map((r) => [r.team ? `{{f.${r.team}}}` : `Franchise ${r.fid}`, `{{f.${r.cnt}}}`, `{{f.${r.yid}}}`]), fact_ids: ids, tool_call_ids: [call] });
      factIds.push(...ids);
    }
  }
  return { blocks: out, factIds: [...new Set(factIds)] };
}

// The card the page renders, from a CLEANED (validated) model card plus this run's envelopes. Raw tool data never goes in.
export function buildServerCard({ cleaned, envelopes, calls, asOf, canonSha, requestId, costUsd, modelCalls, notes }) {
  const index = buildFactIndex(envelopes);
  const facts = {};
  const added = completeTitleBlocks({ index, factsUsed: cleaned.facts_used, blocks: cleaned.blocks, lead: cleaned.lead_md });
  const factsUsed = [...new Set([...cleaned.facts_used, ...added.factIds])].sort();
  for (const id of factsUsed) {
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
    lead_md: cleaned.lead_md, blocks: [...cleaned.blocks, ...added.blocks], facts_used: factsUsed, facts, cites: attachRuleText(cleaned.cites, envelopes), gaps: codeBuiltGaps(cleaned.gaps, envelopes),
    conflicts: cleaned.conflicts, ruling_question: cleaned.ruling_question, follow_ups: cleaned.follow_ups, tool_gaps: toolGaps, refusals,
  };
}

export { newRequestId, INJECTION_NOTE };
