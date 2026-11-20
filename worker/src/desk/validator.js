// Commissioner Desk: the card validator. Pure and deterministic: no I/O, no clock unless ctx.today is absent.
//
// validateCard(card, ctx) -> { ok, errors: [{code, path, message}], cleaned? }
//
// It implements the eight rules of docs/ai_desk/DESK_CONTRACT.md ("Validator rules"):
//   1 every {{f.cN.key}} token resolves to a fact returned in THIS run
//   2 prose has no digits and no spelled quantities outside tokens
//   3 every cited anchor exists in the rules index, the cited canon_sha equals the index's, AND the anchor was RETURNED in this run
//     by a successful rules.search / rules.get (ctx.retrievedAnchors; otherwise UNRETRIEVED_ANCHOR, even for a real anchor).
//     Limit, stated plainly: code cannot prove that a cited rule SUPPORTS the claim next to it. That is judged by people in the eval.
//     The code-level controls are retrieval binding (the model can only cite a rule it was shown this run) and the server attaching
//     the rule's own title, path and an excerpt taken from the retrieved tool data (never from the model) to every accepted cite,
//     so the commissioner reads what the rule says beside the claim.
//   4 no fact above the caller's data-class ceiling
//   5 tool gaps or a non-ok tool status force a non-"answer" state and a non-empty gaps list that covers them
//   6 a past as_of with an unsupported_as_of tool result cannot be "answer"; a fact whose as_of is "current" never answers a
//     past-date question (CURRENT_FACT_FOR_PAST_DATE). ctx.asOf is the EFFECTIVE as_of of the run (the pipeline's), not the model's.
//   7 a refused / no_record / error tool cannot back a fact or an answer
//   8 states that carry no facts have none
// plus: the model may only choose MODEL_CARD_STATES, unknown keys are rejected, every field has a size limit, and
// table rows carry facts by token only (never a typed number).
//
// ctx = {
//   envelopes: [registry envelopes of THIS run],           // status, coverage.gaps, facts, data_class, call_id
//   facts?: Map|object id -> fact {id,value,unit,grade,data_class,call_id,tool,status}  // default: buildFactIndex(envelopes)
//   knowledge: { rules },                                   // rules index (see anchorSet)
//   ceiling: "P2",                                          // the caller's data-class ceiling
//   allowedTerms: league terms a glossary.lookup returned this run (written as spelled, digits allowed: "Ext1")
//   retrievedAnchors: Set|Array|Map|object of rule anchors returned this run by rules.search / rules.get (absent = none retrieved)
//   asOf: "current" | "YYYY-MM-DD",           // the run's effective as_of
//   today?: "YYYY-MM-DD",                                   // for "is the as_of in the past"; default: the clock
// }

import { MODEL_CARD_STATES, CARD_STATES, NO_FACT_STATES, GAP_REASONS, classAllowed, isFactId } from "./contract.js";

// ── Error codes ───────────────────────────────────────────────────────────────────────────────────
export const CODES = Object.freeze({
  BAD_SHAPE: "BAD_SHAPE", UNKNOWN_KEY: "UNKNOWN_KEY", MISSING_FIELD: "MISSING_FIELD", OVERSIZE: "OVERSIZE",
  STATE_NOT_ALLOWED: "STATE_NOT_ALLOWED", UNKNOWN_FACT: "UNKNOWN_FACT", MALFORMED_TOKEN: "MALFORMED_TOKEN",
  TOKEN_NOT_ALLOWED_HERE: "TOKEN_NOT_ALLOWED_HERE", DIGIT_IN_PROSE: "DIGIT_IN_PROSE", SPELLED_QUANTITY: "SPELLED_QUANTITY",
  UNSAFE_MARKUP: "UNSAFE_MARKUP", FAKE_ANCHOR: "FAKE_ANCHOR", UNRETRIEVED_ANCHOR: "UNRETRIEVED_ANCHOR", CURRENT_FACT_FOR_PAST_DATE: "CURRENT_FACT_FOR_PAST_DATE", WRONG_CANON_SHA: "WRONG_CANON_SHA", OVER_CLASS_FACT: "OVER_CLASS_FACT",
  MISSING_GAP: "MISSING_GAP", GAPS_ON_PLAIN_ANSWER: "GAPS_ON_PLAIN_ANSWER", AS_OF_UNSUPPORTED_ANSWER: "AS_OF_UNSUPPORTED_ANSWER",
  FACT_FROM_REFUSED_TOOL: "FACT_FROM_REFUSED_TOOL", FACTS_IN_NO_FACT_STATE: "FACTS_IN_NO_FACT_STATE", NO_OK_TOOL: "NO_OK_TOOL",
  UNKNOWN_TOOL_CALL: "UNKNOWN_TOOL_CALL", ROW_CELL: "ROW_CELL", STATE_NEEDS_FIELD: "STATE_NEEDS_FIELD", NO_CANON_INDEX: "NO_CANON_INDEX",
});

export const LIMITS = Object.freeze({
  lead_md: 1200, blocks: 6, block_title: 120, columns: 12, column_label: 40, rows: 40, cells: 12, cell: 80,
  block_fact_ids: 40, block_tool_call_ids: 12, facts_used: 60, cites: 8, claim: 240, anchor: 160, gaps: 10, gap_what: 200,
  gap_source: 200, conflicts: 5, conflict_note: 240, ruling_question: 400, follow_ups: 4, follow_up: 120,
});

export const ASSERTING_STATES = Object.freeze(["answer", "answer_with_caveat", "answer_with_gap", "partial", "answer_with_conflict"]);
const BLOCK_TYPES = ["table", "timeline", "chart", "branch", "comparison"];
const TOP_KEYS = ["state", "lead_md", "blocks", "facts_used", "cites", "gaps", "conflicts", "ruling_question", "follow_ups"];
const BLOCK_KEYS = ["type", "title", "columns", "rows", "fact_ids", "tool_call_ids"];
const CITE_KEYS = ["anchor", "canon_sha", "claim"];
const GAP_KEYS = ["what", "why", "source_needed"];
const CONFLICT_KEYS = ["fact_a", "fact_b", "note"];
const CALL_ID_RE = /^c\d{1,3}$/;
const TOKEN_RE = /\{\{f\.(c\d{1,3}\.[a-z][a-z0-9_]{0,63})\}\}/g;
const ANCHOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
// States that must carry a particular field to mean what they say.
const STATE_NEEDS = { answer_with_gap: "gaps", partial: "gaps", answer_with_conflict: "conflicts", needs_ruling: "ruling_question", cite_and_abstain: "cites" };

// ── Spelled-quantity detector ─────────────────────────────────────────────────────────────────────
// Always a quantity: zero..twenty, the tens, hundred, thousand, million, billion, trillion (and plurals), dozen, half, twice,
// thrice, "nought/naught", plus ordinals above third (fourth..ninetieth, hundredth, thousandth, millionth).
const NUMBER_WORDS = new Set(("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
  "eighteen nineteen twenty thirty forty fourty fifty sixty seventy eighty ninety hundred hundreds thousand thousands million millions " +
  "billion billions trillion trillions dozen dozens half halves twice thrice tens nought naught").split(" "));
const BIG_ORDINALS = new Set(("fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth " +
  "eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth millionth").split(" "));
// first / second / third are allowed as plain sequencing words ("the first trade in the chain") but are a quantity when they
// name a numbered slot: "first round", "second overall", "third seed", "first season". Next word decides.
const SMALL_ORDINALS = new Set(["first", "second", "third"]);
const SLOT_NOUNS = new Set(["round", "rounds", "pick", "picks", "overall", "place", "seed", "seeds", "finish", "position", "rank", "slot", "string",
  "season", "seasons", "year", "years", "week", "weeks", "day", "days", "month", "months", "quarter", "down", "downs", "half", "choice", "selection"]);
// Documented exceptions for "one" (every other "one" is a quantity):
//   "one of" and "one another" (next word); "no one", "any one", "this one", "that one", "which one", "each one", "every one", "another one"
//   (previous word); "the one who/that/which/whom" (a pronoun). "someone", "everyone", "anyone", "noone" and "one's" are different words and pass.
const ONE_NEXT_OK = new Set(["of", "another"]);
const ONE_PREV_OK = new Set(["no", "any", "this", "that", "which", "each", "every", "another"]);
const ONE_THE_NEXT_OK = new Set(["who", "that", "which", "whom"]);
// Proper nouns that contain digits and cannot smuggle a number.
const DIGIT_PROPER_NOUNS = /\b(49ers|76ers)\b/gi;
// Not flagged on purpose (documented known limits): "once", "double", "triple", "couple", "several", Roman numerals.

function wordList(text) {
  const out = [];
  const re = /\p{L}[\p{L}'\u2019]*/gu;
  let m, prevEnd = -1;
  while ((m = re.exec(text))) {
    out.push({ w: m[0].toLowerCase().replace(/\u2019/g, "'"), adj: prevEnd >= 0 && /^[\s\-\u2010-\u2015]*$/.test(text.slice(prevEnd, m.index)) });
    prevEnd = m.index + m[0].length;
  }
  return out;
}

export function findSpelledQuantities(text) {
  const ws = wordList(String(text || ""));
  const hits = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i].w;
    const prev = ws[i].adj && i > 0 ? ws[i - 1].w : null;
    const next = i + 1 < ws.length && ws[i + 1].adj ? ws[i + 1].w : null;
    if (w === "one") {
      const ok = (next && ONE_NEXT_OK.has(next)) || (prev && ONE_PREV_OK.has(prev)) || (prev === "the" && next && ONE_THE_NEXT_OK.has(next));
      if (!ok) hits.push(w);
    } else if (NUMBER_WORDS.has(w) || BIG_ORDINALS.has(w)) hits.push(w);
    else if (SMALL_ORDINALS.has(w) && next && SLOT_NOUNS.has(next)) hits.push(`${w} ${next}`);
  }
  return hits;
}

// ── Prose check ───────────────────────────────────────────────────────────────────────────────────
// Returns { tokens: [factId...] }. Pushes errors for digits, spelled quantities, markup, malformed or disallowed tokens, length.
function checkProseBase(text, path, opts, errors) {
  const o = { allowTokens: true, max: 400, ...opts };
  if (typeof text !== "string") { errors.push({ code: CODES.BAD_SHAPE, path, message: "must be a string" }); return { tokens: [] }; }
  if (text.length > o.max) errors.push({ code: CODES.OVERSIZE, path, message: `longer than ${o.max} characters` });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/.test(text)) errors.push({ code: CODES.UNSAFE_MARKUP, path, message: "control or invisible characters" });
  const tokens = [];
  let rest = text.replace(TOKEN_RE, (_, id) => { tokens.push(id); return " "; });
  if (/\{\{|\}\}/.test(rest)) errors.push({ code: CODES.MALFORMED_TOKEN, path, message: "a {{ }} that is not a well-formed {{f.cN.key}} token" });
  if (tokens.length && !o.allowTokens) errors.push({ code: CODES.TOKEN_NOT_ALLOWED_HERE, path, message: "fact tokens are not allowed in this field" });
  if (/<\/?[a-zA-Z!][^>]*>|https?:\/\/|\bdata:[a-z]+\/|\bjavascript:|\]\(\s*[a-z]+:/i.test(rest)) errors.push({ code: CODES.UNSAFE_MARKUP, path, message: "HTML, links and URLs are not allowed" });
  rest = rest.replace(DIGIT_PROPER_NOUNS, " ");
  // League terms a tool returned in this run (glossary.lookup entries) may be written as spelled, even with a digit ("Ext1").
  if (o.termRe) rest = rest.replace(o.termRe, " ");
  if (/\p{N}/u.test(rest)) errors.push({ code: CODES.DIGIT_IN_PROSE, path, message: "a digit outside a fact token" });
  const spelled = findSpelledQuantities(rest);
  if (spelled.length) errors.push({ code: CODES.SPELLED_QUANTITY, path, message: `a spelled quantity outside a fact token (${spelled.slice(0, 3).join(", ")})` });
  return { tokens };
}

// ── Fact index and rules index helpers ────────────────────────────────────────────────────────────
// id -> { id, label, value, unit, grade, as_of, source, data_class, tool, call_id, status }
export function buildFactIndex(envelopes) {
  const m = new Map();
  for (const e of envelopes || []) {
    for (const f of (e && e.facts) || []) {
      m.set(f.id, { ...f, data_class: e.data_class, tool: e.tool, call_id: e.call_id, status: e.status });
    }
  }
  return m;
}
function factLookup(ctx) {
  const src = ctx.facts || buildFactIndex(ctx.envelopes);
  return (id) => (src instanceof Map ? src.get(id) : (src && Object.prototype.hasOwnProperty.call(src, id) ? src[id] : undefined));
}

// ── Tool gaps ─────────────────────────────────────────────────────────────────────────────────────
// Gap entries on the final card are built by CODE from the tool envelopes' coverage gaps (what / why / source_needed verbatim,
// so digits in them are code-sourced and allowed). A model-authored gap is accepted without the prose rules only when it equals a
// tool gap exactly; any other model gap stays under the no-digits rule. The model never needs to rewrite a tool gap.
export const MAX_CARD_GAPS = 30;
const gapStr = (v) => (typeof v === "string" ? v.trim() : "");
export function gapKey(g) { return JSON.stringify([gapStr(g && g.what), g && g.why, gapStr(g && g.source_needed)]); }
export function collectToolGaps(envelopes) {
  const out = []; const seen = new Set();
  for (const e of envelopes || []) {
    if (!e || isNoise(e)) continue;
    for (const g of (e.coverage && e.coverage.gaps) || []) {
      if (!g || !GAP_REASONS.includes(g.why)) continue;
      const k = gapKey(g);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ what: gapStr(g.what).slice(0, 400), why: g.why, source_needed: gapStr(g.source_needed).slice(0, 400), tool: e.tool, call_id: e.call_id });
    }
  }
  return out;
}

const ANCHOR_CACHE = new WeakMap();
// Accepts the CI-built rules.json shape ({canon_sha, sections[].groups[].rules[].anchor, groups ids, topics[].cites[].anchor})
// or a prepared index ({canon_sha, anchors: Set|Array|Object|Map}).
export function anchorSet(rules) {
  if (!rules || typeof rules !== "object") return null;
  if (ANCHOR_CACHE.has(rules)) return ANCHOR_CACHE.get(rules);
  const set = new Set();
  const a = rules.anchors;
  if (a instanceof Set || Array.isArray(a)) for (const x of a) set.add(String(x));
  else if (a instanceof Map) for (const k of a.keys()) set.add(String(k));
  else if (a && typeof a === "object") for (const k of Object.keys(a)) set.add(k);
  for (const s of rules.sections || []) {
    if (s && s.id) set.add(String(s.id));
    for (const g of (s && s.groups) || []) {
      if (g && g.id) set.add(String(g.id));
      for (const r of (g && g.rules) || []) if (r && r.anchor) set.add(String(r.anchor));
    }
  }
  ANCHOR_CACHE.set(rules, set);
  return set;
}
// The cite's sha equals the index's sha. A 7 to 40 character prefix of the index sha counts (the card shows 7 characters).
export function canonShaMatches(citeSha, indexSha) {
  return typeof citeSha === "string" && typeof indexSha === "string" && SHA_RE.test(citeSha) && indexSha.toLowerCase().startsWith(citeSha.toLowerCase());
}

// ── Structure helpers ─────────────────────────────────────────────────────────────────────────────
function keySet(v) {
  if (v instanceof Set) return v;
  if (v instanceof Map) return new Set(v.keys());
  if (Array.isArray(v)) return new Set(v.map(String));
  if (v && typeof v === "object") return new Set(Object.keys(v));
  return new Set();
}
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function checkKeys(obj, allowed, path, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push({ code: CODES.UNKNOWN_KEY, path: `${path}${path ? "." : ""}${k}`, message: "unknown key" });
}
function arrayOf(v, path, max, errors) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push({ code: CODES.BAD_SHAPE, path, message: "must be an array" }); return []; }
  if (v.length > max) { errors.push({ code: CODES.OVERSIZE, path, message: `more than ${max} items` }); return v.slice(0, max); }
  return v;
}
function isNoise(env) {
  // The model's own malformed attempts (unknown tool, bad arguments) are counted by the loop but do not make the DATA incomplete.
  const code = env && env.error && env.error.code;
  return (env.status === "forbidden" && code === "unknown_tool") || (env.status === "error" && (code === "bad_arguments" || code === "as_of_required"));
}
function isPastAsOf(asOf, today) {
  if (!asOf || asOf === "current") return false;
  const t = today || new Date().toISOString().slice(0, 10);
  return String(asOf) < t;
}

// ── validateCard ──────────────────────────────────────────────────────────────────────────────────
// Terms a glossary.lookup returned (code data): letters required, bounded, regex-safe. Exact spelling, whole word.
// Case-insensitive on purpose: the glossary lists an alias as "ext1" while owners (and the canon) write "Ext1". Matching is still whole-word and only for terms the
// glossary returned this run, so the only digits it can let through are the ones inside those terms themselves.
export function termRegex(terms) {
  const list = [...new Set((terms || []).filter((x) => typeof x === "string" && x.length >= 2 && x.length <= 40 && /\p{L}/u.test(x)))].sort((a, b) => b.length - a.length).slice(0, 60);
  if (!list.length) return null;
  const esc = list.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

export function validateCard(card, ctx) {
  const errors = [];
  const c = ctx || {};
  const termRe = termRegex(c.allowedTerms);
  const checkProse = (text, path, opts, errs) => checkProseBase(text, path, { ...opts, termRe }, errs);
  const envelopes = Array.isArray(c.envelopes) ? c.envelopes : [];
  const getFact = factLookup(c);
  const ceiling = c.ceiling || "P0";
  const byCall = new Map(envelopes.map((e) => [e.call_id, e]));
  const pastRun = isPastAsOf(c.asOf, c.today);
  const real = envelopes.filter((e) => !isNoise(e));
  const toolGaps = collectToolGaps(envelopes);
  const toolGapKeys = new Set(toolGaps.map(gapKey));

  if (!isObj(card)) return { ok: false, errors: [{ code: CODES.BAD_SHAPE, path: "", message: "the card must be an object" }] };
  checkKeys(card, TOP_KEYS, "", errors);

  // State (rule: model-chosen state must be in MODEL_CARD_STATES)
  const state = card.state;
  if (typeof state !== "string") errors.push({ code: CODES.MISSING_FIELD, path: "state", message: "state is required" });
  else if (!MODEL_CARD_STATES.includes(state)) {
    errors.push({ code: CODES.STATE_NOT_ALLOWED, path: "state", message: CARD_STATES.includes(state) ? "that state is chosen by code, never by the model" : "unknown state" });
  }
  const noFact = typeof state === "string" && NO_FACT_STATES.includes(state);

  const used = new Set();            // fact ids referenced anywhere
  const note = (ids) => { for (const id of ids) used.add(id); };

  // lead_md
  if (typeof card.lead_md !== "string" || !card.lead_md.trim()) errors.push({ code: CODES.MISSING_FIELD, path: "lead_md", message: "lead_md is required" });
  else note(checkProse(card.lead_md, "lead_md", { max: LIMITS.lead_md }, errors).tokens);

  // blocks
  const blocks = arrayOf(card.blocks, "blocks", LIMITS.blocks, errors);
  const cleanBlocks = [];
  blocks.forEach((b, i) => {
    const p = `blocks[${i}]`;
    if (!isObj(b)) { errors.push({ code: CODES.BAD_SHAPE, path: p, message: "a block must be an object" }); return; }
    checkKeys(b, BLOCK_KEYS, p, errors);
    if (!BLOCK_TYPES.includes(b.type)) errors.push({ code: CODES.BAD_SHAPE, path: `${p}.type`, message: `type must be one of ${BLOCK_TYPES.join("|")}` });
    if (b.title !== undefined) note(checkProse(b.title, `${p}.title`, { max: LIMITS.block_title }, errors).tokens);
    const columns = arrayOf(b.columns, `${p}.columns`, LIMITS.columns, errors);
    columns.forEach((col, j) => checkProse(col, `${p}.columns[${j}]`, { max: LIMITS.column_label, allowTokens: false }, errors));
    const rows = arrayOf(b.rows, `${p}.rows`, LIMITS.rows, errors);
    rows.forEach((row, r) => {
      if (!Array.isArray(row)) { errors.push({ code: CODES.ROW_CELL, path: `${p}.rows[${r}]`, message: "a row must be an array of strings" }); return; }
      if (row.length > LIMITS.cells) errors.push({ code: CODES.OVERSIZE, path: `${p}.rows[${r}]`, message: `more than ${LIMITS.cells} cells` });
      row.slice(0, LIMITS.cells).forEach((cell, k) => {
        const cp = `${p}.rows[${r}][${k}]`;
        // Tables carry facts by token, never typed numbers: a cell is a string, either a token or a short label (no digits).
        if (typeof cell !== "string") { errors.push({ code: CODES.ROW_CELL, path: cp, message: "a cell must be a string (a fact token or a short label), never a typed value" }); return; }
        note(checkProse(cell, cp, { max: LIMITS.cell }, errors).tokens);
      });
    });
    const factIds = arrayOf(b.fact_ids, `${p}.fact_ids`, LIMITS.block_fact_ids, errors);
    factIds.forEach((id, j) => {
      if (typeof id !== "string" || !isFactId(id)) errors.push({ code: CODES.UNKNOWN_FACT, path: `${p}.fact_ids[${j}]`, message: "not a fact id" });
      else note([id]);
    });
    const callIds = arrayOf(b.tool_call_ids, `${p}.tool_call_ids`, LIMITS.block_tool_call_ids, errors);
    callIds.forEach((id, j) => {
      if (typeof id !== "string" || !CALL_ID_RE.test(id) || !byCall.has(id)) errors.push({ code: CODES.UNKNOWN_TOOL_CALL, path: `${p}.tool_call_ids[${j}]`, message: "no such tool call in this run" });
    });
    cleanBlocks.push({ type: b.type, title: typeof b.title === "string" ? b.title.trim() : "", columns: columns.filter((x) => typeof x === "string"),
      rows: rows.filter(Array.isArray).map((r) => r.filter((x) => typeof x === "string")), fact_ids: factIds.filter((x) => typeof x === "string"), tool_call_ids: callIds.filter((x) => typeof x === "string") });
  });

  // facts_used
  const declared = arrayOf(card.facts_used, "facts_used", LIMITS.facts_used, errors);
  declared.forEach((id, j) => {
    if (typeof id !== "string" || !isFactId(id)) errors.push({ code: CODES.UNKNOWN_FACT, path: `facts_used[${j}]`, message: "not a fact id (write c1.key, without braces or f.)" });
    else note([id]);
  });

  // cites (rule 3)
  const cites = arrayOf(card.cites, "cites", LIMITS.cites, errors);
  const rules = c.knowledge && c.knowledge.rules;
  const anchors = anchorSet(rules);
  const retrieved = keySet(c.retrievedAnchors);
  cites.forEach((ct, i) => {
    const p = `cites[${i}]`;
    if (!isObj(ct)) { errors.push({ code: CODES.BAD_SHAPE, path: p, message: "a cite must be an object" }); return; }
    checkKeys(ct, CITE_KEYS, p, errors);
    if (typeof ct.anchor !== "string" || !ANCHOR_RE.test(ct.anchor)) errors.push({ code: CODES.FAKE_ANCHOR, path: `${p}.anchor`, message: "not a well-formed anchor" });
    if (typeof ct.anchor === "string" && ANCHOR_RE.test(ct.anchor) && anchors && !anchors.has(ct.anchor)) errors.push({ code: CODES.FAKE_ANCHOR, path: `${p}.anchor`, message: "anchor is not in the rules index" });
    else if (typeof ct.anchor === "string" && ANCHOR_RE.test(ct.anchor) && !retrieved.has(ct.anchor)) errors.push({ code: CODES.UNRETRIEVED_ANCHOR, path: `${p}.anchor`, message: "this rule was not retrieved for this question; call rules.search or rules.get first" });
    if (!anchors || !rules || !rules.canon_sha) errors.push({ code: CODES.NO_CANON_INDEX, path: p, message: "the rules index is not available to check this cite" });
    else {
      if (!canonShaMatches(ct.canon_sha, rules.canon_sha)) errors.push({ code: CODES.WRONG_CANON_SHA, path: `${p}.canon_sha`, message: "canon_sha does not match the rules index" });
    }
    if (ct.claim !== undefined) note(checkProse(ct.claim, `${p}.claim`, { max: LIMITS.claim }, errors).tokens);
  });

  // gaps
  const gaps = arrayOf(card.gaps, "gaps", LIMITS.gaps, errors);
  gaps.forEach((g, i) => {
    const p = `gaps[${i}]`;
    if (!isObj(g)) { errors.push({ code: CODES.BAD_SHAPE, path: p, message: "a gap must be an object" }); return; }
    checkKeys(g, GAP_KEYS, p, errors);
    if (!GAP_REASONS.includes(g.why)) errors.push({ code: CODES.BAD_SHAPE, path: `${p}.why`, message: `why must be one of ${GAP_REASONS.join("|")}` });
    if (toolGapKeys.has(gapKey(g))) return; // an exact copy of a tool gap: code-sourced text, replaced by the code-built entry
    note(checkProse(g.what, `${p}.what`, { max: LIMITS.gap_what }, errors).tokens);
    if (g.source_needed !== undefined) checkProse(g.source_needed, `${p}.source_needed`, { max: LIMITS.gap_source, allowTokens: false }, errors);
  });

  // conflicts
  const conflicts = arrayOf(card.conflicts, "conflicts", LIMITS.conflicts, errors);
  conflicts.forEach((cf, i) => {
    const p = `conflicts[${i}]`;
    if (!isObj(cf)) { errors.push({ code: CODES.BAD_SHAPE, path: p, message: "a conflict must be an object" }); return; }
    checkKeys(cf, CONFLICT_KEYS, p, errors);
    for (const k of ["fact_a", "fact_b"]) {
      if (typeof cf[k] !== "string" || !isFactId(cf[k])) errors.push({ code: CODES.UNKNOWN_FACT, path: `${p}.${k}`, message: "not a fact id" });
      else note([cf[k]]);
    }
    if (cf.note !== undefined) note(checkProse(cf.note, `${p}.note`, { max: LIMITS.conflict_note }, errors).tokens);
  });

  // ruling_question, follow_ups
  if (card.ruling_question !== undefined && card.ruling_question !== "") note(checkProse(card.ruling_question, "ruling_question", { max: LIMITS.ruling_question }, errors).tokens);
  const followUps = arrayOf(card.follow_ups, "follow_ups", LIMITS.follow_ups, errors);
  followUps.forEach((f, i) => checkProse(f, `follow_ups[${i}]`, { max: LIMITS.follow_up, allowTokens: false }, errors));

  // ── Rules 1, 4, 7: every referenced fact ───────────────────────────────────────────────────────
  for (const id of used) {
    if (!isFactId(id)) continue; // already reported
    const f = getFact(id);
    const callId = id.split(".")[0];
    const env = byCall.get(callId);
    if (!f) {
      if (env && env.status !== "ok") errors.push({ code: CODES.FACT_FROM_REFUSED_TOOL, path: id, message: `tool call ${callId} returned ${env.status}; it cannot back a fact` });
      else errors.push({ code: CODES.UNKNOWN_FACT, path: id, message: "not a fact returned in this run" });
      continue;
    }
    if ((f.status && f.status !== "ok") || (env && env.status !== "ok")) { errors.push({ code: CODES.FACT_FROM_REFUSED_TOOL, path: id, message: "the tool did not return an ok result" }); continue; }
    if (!classAllowed(ceiling, f.data_class)) errors.push({ code: CODES.OVER_CLASS_FACT, path: id, message: "fact is above the caller's data class" });
    if ((pastRun || c.forbidCurrent) && f.as_of === "current") errors.push({ code: CODES.CURRENT_FACT_FOR_PAST_DATE, path: id, message: "this fact is today's value; the question is about a past date or compares dates" });
  }

  // ── Rule 8: states that carry no facts ─────────────────────────────────────────────────────────
  if (noFact && used.size) errors.push({ code: CODES.FACTS_IN_NO_FACT_STATE, path: "state", message: `state ${state} carries no facts, tokens or fact ids` });

  // ── Rules 5, 6, 7: tool results against the state ──────────────────────────────────────────────
  const nonOk = real.filter((e) => e.status !== "ok");
  const unsupported = real.filter((e) => e.status === "unsupported_as_of" || (e.coverage && (e.coverage.gaps || []).some((g) => g && g.why === "unsupported_as_of")));
  const hasProblem = nonOk.length > 0 || toolGaps.length > 0 || real.some((e) => e.coverage && e.coverage.supported === false);

  if (state === "answer" && hasProblem) errors.push({ code: CODES.STATE_NOT_ALLOWED, path: "state", message: "a tool reported gaps or a non-ok status, so the state cannot be plain answer" });
  // Tool gaps are added to the card by code. A non-ok tool that reported no gap of its own still needs the model to say what is missing.
  if (hasProblem && !toolGaps.length && !gaps.length) errors.push({ code: CODES.MISSING_GAP, path: "gaps", message: "a tool returned a non-ok status without a gap; say in gaps what could not be checked" });
  if (!hasProblem && state === "answer" && gaps.length) {
    errors.push({ code: CODES.GAPS_ON_PLAIN_ANSWER, path: "gaps", message: "plain answer lists no gaps; use answer_with_gap" });
  }
  if (state === "answer" && unsupported.length && pastRun) {
    errors.push({ code: CODES.AS_OF_UNSUPPORTED_ANSWER, path: "state", message: "the as_of is in the past and a tool could not honor it" });
  }
  if (ASSERTING_STATES.includes(state) && !real.some((e) => e.status === "ok")) {
    errors.push({ code: CODES.NO_OK_TOOL, path: "state", message: "an answer needs at least one ok tool result in this run" });
  }
  if (typeof state === "string" && STATE_NEEDS[state]) {
    const need = STATE_NEEDS[state];
    const v = need === "gaps" ? [...gaps, ...toolGaps] : need === "conflicts" ? conflicts : need === "cites" ? cites : card.ruling_question;
    if (!(Array.isArray(v) ? v.length : typeof v === "string" && v.trim())) errors.push({ code: CODES.STATE_NEEDS_FIELD, path: need, message: `state ${state} needs ${need}` });
  }

  if (errors.length) return { ok: false, errors };

  const factsUsed = [...used].sort();
  const cleaned = {
    state, lead_md: card.lead_md.trim(), blocks: cleanBlocks, facts_used: factsUsed,
    cites: cites.map((x) => ({ anchor: x.anchor, canon_sha: x.canon_sha, claim: typeof x.claim === "string" ? x.claim.trim() : "" })),
    // Model gaps that equal a tool gap are dropped here: the server card carries the tool's own entry (see composer.buildServerCard).
    gaps: gaps.filter((g) => !toolGapKeys.has(gapKey(g))).map((g) => ({ what: g.what.trim(), why: g.why, source_needed: typeof g.source_needed === "string" ? g.source_needed.trim() : "" })),
    conflicts: conflicts.map((x) => ({ fact_a: x.fact_a, fact_b: x.fact_b, note: typeof x.note === "string" ? x.note.trim() : "" })),
    ruling_question: typeof card.ruling_question === "string" ? card.ruling_question.trim() : "",
    follow_ups: followUps.map((x) => x.trim()),
  };
  return { ok: true, errors: [], cleaned };
}

export function errorCodes(errors) { return [...new Set((errors || []).map((e) => e.code))]; }
