// Commissioner Desk: the read-only knowledge object the handler injects into every tool run.
//
// PURE: no I/O, no env, no network, no clock. The handler loads site/m/data/rules.json (and, optionally, the canon
// markdown) and passes the parsed values in; everything below is deterministic. The result is deep-frozen, so no tool
// can change what another tool, or a later question, sees.
//
//   buildKnowledge({ rulesJson, canonText, leagueId, currentSeason, calendar, canonShaBundled, canonDigestBundled })
//     -> { rules, rulesMeta, glossary, coverage, leagueId, currentSeason, calendar, canonShaBundled }
//
// The rules index covers the member-facing canon only: rules and sections marked `internal` in rules.json, internal
// list items inside a public rule, and the divisional co-tenancy appendix (owner personal names) are never indexed, so
// no tool can return them. Search is plain keyword BM25 with a small synonym list: same input, same output, no model,
// no vector store.

import { freezeDeep } from "./contract.js";
import { GLOSSARY_ENTRIES, normalizeGlossaryKey, compactGlossaryKey, CODE_RECOGNIZED_STATUS_TOKENS } from "./data/glossary.js";
import {
  COVERAGE_MATRIX, COVERAGE_FIRST_SEASON, COVERAGE_LAST_SEASON,
} from "./data/coverage_matrix.js";

// ── Bounds (every tool output is bounded by these) ──────────────────────────────────────────────────
export const MAX_SEARCH_HITS = 8;
export const MAX_SNIPPET_CHARS = 380;       // < 400 including the ellipses
export const RULE_PART_CHARS = 1900;        // rules.get text per part. Under 6000, and under the registry's 2000-character string cap (a longer string is cut silently)
export const MAX_RULE_PARTS = 40;
const PATH_PART_MAX = 120;

// Appendix sections that name owners. They are public in the repo, but the desk never repeats owner personal names.
const EXCLUDED_SECTION_IDS = new Set(["sa-divisional-co-tena"]);

// ── Pure SHA-256 (hex), used only to check that the rules index was built from the canon text we were handed ─────
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000), false);
  dv.setUint32(padded.length - 4, (len * 8) >>> 0, false);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// ── HTML to plain text (rules.json blocks are small, trusted HTML) ───────────────────────────────────
const ENTITIES = Object.assign(Object.create(null), { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" });
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
const BLOCK_TAGS = new Set(["p", "li", "tr", "div", "ul", "ol", "table", "thead", "tbody", "blockquote", "br", "h1", "h2", "h3", "h4", "h5", "h6"]);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
// Returns { text, hadInternal }. Any element carrying the ups-m-rb-int class (with everything nested in it) is dropped.
export function htmlToText(html) {
  const src = String(html || "");
  let out = "";
  let last = 0;
  let skipTag = null, skipDepth = 0, hadInternal = false;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    const [whole, closing, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (!skipTag) out += decodeEntities(src.slice(last, m.index));
    last = m.index + whole.length;
    if (skipTag) {
      if (name === skipTag) { skipDepth += closing ? -1 : 1; if (skipDepth === 0) { skipTag = null; } }
      continue;
    }
    if (!closing && /class\s*=\s*"[^"]*ups-m-rb-int[^"]*"/.test(attrs)) {
      if (!/\/\s*$/.test(attrs)) { skipTag = name; skipDepth = 1; }
      hadInternal = true;
      continue;
    }
    if (closing && (name === "td" || name === "th")) out += " | ";
    else if (BLOCK_TAGS.has(name)) out += "\n";
  }
  if (!skipTag) out += decodeEntities(src.slice(last));
  const text = out.replace(/[ \t ]+/g, " ").split("\n").map((l) => l.replace(/^[\s|]+/, "").replace(/[\s|]+$/, "")).filter(Boolean).join("\n");
  return { text, hadInternal };
}

// ── Tokenizing and ranking ──────────────────────────────────────────────────────────────────────────
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "by", "with", "as", "at", "it", "its", "this", "that", "from", "what", "which", "who", "how", "do", "does", "did", "can", "i", "my", "me", "our", "we", "you", "your", "if", "than", "then", "there", "up"]);
const SYNONYMS = Object.assign(Object.create(null), {
  cut: ["release", "drop"], drop: ["cut", "release"], release: ["cut", "drop"], dropped: ["cut", "drop", "release"], cutting: ["cut", "release"],
  penalty: ["penalt"], dead: ["penalty"],
  extend: ["extension"], extension: ["extend"], extended: ["extension", "extend"],
  waiver: ["blind", "bid"], waivers: ["blind", "bid"], pickup: ["waiver", "fcfs"],
  callup: ["call-up", "call"], promote: ["promotion"], demote: ["taxi"],
  lineup: ["starting"], tagged: ["tag"], restructured: ["restructure"], loaded: ["front-loaded", "back-loaded"],
  floor: ["cap-floor"], retired: ["retire", "retirement"], retirement: ["retired"],
});
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}
export function tokenize(text) {
  const s = String(text || "").toLowerCase().replace(/['’`]/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const out = [];
  for (const raw of s.match(/[a-z0-9]+(?:[-/][a-z0-9]+)*/g) || []) {
    if (raw.includes("-") || raw.includes("/")) {
      out.push(stem(raw));
      for (const part of raw.split(/[-/]/)) if (part && !STOP.has(part)) out.push(stem(part));
    } else if (!STOP.has(raw)) out.push(stem(raw));
  }
  return out;
}

function pushWeighted(tokens, n, into) { for (let i = 0; i < n; i++) for (const t of tokens) into.push(t); }

function buildRulesIndex(entries) {
  const postings = Object.create(null);
  const dl = [];
  entries.forEach((e, idx) => {
    const toks = [];
    pushWeighted(tokenize(e.title), 3, toks);
    pushWeighted(tokenize(`${e.id || ""} ${e.tags.join(" ")}`), 2, toks);
    pushWeighted(tokenize(e.path.join(" ")), 1, toks);
    for (const t of tokenize(e.text)) toks.push(t);
    dl.push(toks.length);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) (postings[t] || (postings[t] = [])).push([idx, c]);
  });
  const N = entries.length;
  const avgdl = N ? dl.reduce((a, b) => a + b, 0) / N : 0;
  return { N, avgdl, dl, postings, k1: 1.2, b: 0.75 };
}

function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ── Rules index ─────────────────────────────────────────────────────────────────────────────────────
function buildRules(rulesJson) {
  if (!rulesJson || typeof rulesJson !== "object" || !Array.isArray(rulesJson.sections)) throw new Error("buildKnowledge: rulesJson has no sections");
  const canonSha = rulesJson.canon_sha;
  if (typeof canonSha !== "string" || !canonSha) throw new Error("buildKnowledge: rulesJson.canon_sha is missing");

  const entries = [];
  const seen = new Set();
  const excluded = { internal: 0, owner_names: 0, internal_items_stripped: 0 };

  const walk = (rule, sec, group, parentPath, parent) => {
    const anchor = String(rule.anchor || "");
    if (!anchor || seen.has(anchor)) return;
    seen.add(anchor);
    if (rule.internal === true || sec.internal === true) { excluded.internal += 1 + countDescendants(rule); return; }
    const blocks = (rule.blocks || []).filter((b) => b && !b.internal);
    const texts = [];
    for (const b of blocks) {
      const r = htmlToText(b.html);
      if (r.hadInternal) excluded.internal_items_stripped += 1;
      if (r.text) texts.push(r.text);
    }
    const path = [...parentPath, clip(rule.title, PATH_PART_MAX)];
    const kids = (rule.children || []).filter((c) => c && c.internal !== true);
    const entry = {
      anchor,
      id: rule.id || null,
      ref: rule.id && sec.num ? `${sec.num}.${rule.id}` : null,
      title: clip(rule.title, 200),
      path,
      section_id: sec.id,
      parent_anchor: parent ? parent.anchor : null,
      children: kids.map((c) => c.anchor),
      tags: Array.isArray(rule.tags) ? rule.tags.map(String) : [],
      statuses: Array.isArray(rule.statuses) ? rule.statuses.map(String) : [],
      updated: rule.updated || rule.changed || null,
      text: texts.join("\n"),
      canon_sha: canonSha,
    };
    entries.push(entry);
    for (const c of rule.children || []) walk(c, sec, group, path, entry);
  };
  const countDescendants = (r) => (r.children || []).reduce((n, c) => n + 1 + countDescendants(c), 0);

  for (const sec of rulesJson.sections) {
    if (EXCLUDED_SECTION_IDS.has(sec.id)) {
      for (const g of sec.groups || []) for (const r of g.rules || []) excluded.owner_names += 1 + countDescendants(r);
      continue;
    }
    for (const g of sec.groups || []) {
      const base = [clip(sec.title, PATH_PART_MAX)];
      if (g.title && !/^(rules?|group)?\s*$/i.test(g.title)) base.push(clip(g.title, PATH_PART_MAX));
      for (const r of g.rules || []) walk(r, sec, g, base, null);
    }
  }

  const order = entries.map((e) => e.anchor);
  const byAnchor = Object.create(null);
  const anchorIndex = Object.create(null);
  entries.forEach((e, i) => { byAnchor[e.anchor] = e; anchorIndex[e.anchor] = i; });
  const byId = Object.create(null);
  for (const e of entries) if (e.id) (byId[e.id.toLowerCase()] || (byId[e.id.toLowerCase()] = [])).push(e.anchor);

  return {
    canon_sha: canonSha,
    order, byAnchor, anchorIndex, byId,
    index: buildRulesIndex(entries),
    lcTitle: entries.map((e) => e.title.toLowerCase()),
    lcText: entries.map((e) => e.text.toLowerCase()),
    excluded,
  };
}

// ── Glossary index ──────────────────────────────────────────────────────────────────────────────────
function buildGlossary() {
  const byKey = Object.create(null);
  const byCompact = Object.create(null);
  GLOSSARY_ENTRIES.forEach((e, i) => {
    for (const label of [e.term, ...e.aliases]) {
      const k = normalizeGlossaryKey(label), c = compactGlossaryKey(label);
      if (k && byKey[k] === undefined) byKey[k] = i;
      if (c && byCompact[c] === undefined) byCompact[c] = i;
    }
  });
  return { entries: GLOSSARY_ENTRIES, byKey, byCompact, codeTokens: [...CODE_RECOGNIZED_STATUS_TOKENS] };
}

// ── Public builder ──────────────────────────────────────────────────────────────────────────────────
export function buildKnowledge({ rulesJson, canonText, leagueId, currentSeason, calendar, canonShaBundled, canonDigestBundled } = {}) {
  const rules = buildRules(rulesJson);
  const season = Number(currentSeason);
  if (!Number.isInteger(season) || season < 2010 || season > 2100) throw new Error("buildKnowledge: currentSeason must be a season year");
  const canonDigest = typeof rulesJson.canon_digest === "string" ? rulesJson.canon_digest : null;
  // The index must have been built from the canon text that ships with this Worker. Check it from the text itself when the
  // handler passes it, or from a digest of that text computed elsewhere (canonDigestBundled, 12 hex chars).
  let textDigest = null, digestOk = null;
  if (typeof canonText === "string" && canonText) {
    textDigest = sha256Hex(canonText).slice(0, 12);
    digestOk = canonDigest ? textDigest === canonDigest : null;
  } else if (typeof canonDigestBundled === "string" && canonDigestBundled) {
    textDigest = canonDigestBundled.toLowerCase().slice(0, 12);
    digestOk = canonDigest ? textDigest === canonDigest : null;
  }
  const shaBundled = typeof canonShaBundled === "string" && canonShaBundled ? canonShaBundled : null;
  const rulesMeta = {
    canon_sha: rules.canon_sha,
    canon_sha7: rules.canon_sha.slice(0, 7),
    canon_date: rulesJson.canon_date || null,
    canon_digest: canonDigest,
    canon_text_digest: textDigest,
    canon_text_digest_ok: digestOk,           // null = nothing to compare with; false = the index was built from different text
    stale: digestOk === false || (shaBundled !== null && shaBundled !== rules.canon_sha),
    version: rulesJson.version || null,
    last_changed: rulesJson.last_changed || null,
    section_count: rulesJson.sections.length,
    rule_count: rules.order.length,
    excluded_internal: rules.excluded.internal,
    excluded_owner_names: rules.excluded.owner_names,
  };
  const { excluded: _x, ...rulesPublicBase } = rules;
  // `anchors`: every citable anchor, public rules only (the validator checks a card's cites against this list).
  const rulesPublic = { ...rulesPublicBase, anchors: [...rules.order] };
  const coverage = {
    first_season: COVERAGE_FIRST_SEASON, last_season: COVERAGE_LAST_SEASON,
    domains: COVERAGE_MATRIX.map((d) => ({ id: d.id, label: d.label, kind: d.kind, tools: d.tools })),
    matrix: COVERAGE_MATRIX,
  };
  const cal = calendar == null ? null : JSON.parse(JSON.stringify(calendar));
  return freezeDeep({
    rules: rulesPublic,
    rulesMeta,
    glossary: buildGlossary(),
    coverage,
    leagueId: String(leagueId == null ? "" : leagueId),
    currentSeason: season,
    calendar: cal,
    canonShaBundled: shaBundled,
  });
}

// ── Search ──────────────────────────────────────────────────────────────────────────────────────────
function queryTerms(query) {
  const base = [...new Set(tokenize(query))];
  const weights = new Map(base.map((t) => [t, 1]));
  for (const t of base) for (const s of SYNONYMS[t] || []) for (const st of tokenize(s)) if (!weights.has(st)) weights.set(st, 0.5);
  return { base, weights };
}

function snippetFor(text, query) {
  const flat = text.replace(/\s+/g, " ");
  const lc = flat.toLowerCase();
  const words = (String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((w) => !STOP.has(w));
  let at = -1;
  for (const w of words) { const i = lc.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) at = 0;
  let start = Math.max(0, at - 70);
  if (start > 0) { const sp = flat.indexOf(" ", start); if (sp >= 0 && sp < at) start = sp + 1; }
  const end = Math.min(flat.length, start + 300);
  let s = flat.slice(start, end).trim();
  if (end < flat.length) { const sp = s.lastIndexOf(" "); if (sp > 200) s = s.slice(0, sp); }
  return `${start > 0 ? "…" : ""}${s}${end < flat.length ? "…" : ""}`.slice(0, MAX_SNIPPET_CHARS);
}

// -> { hits: [{anchor,id,ref,title,path,snippet,score,canon_sha}], total }
export function searchRules(knowledge, query, { limit = 5 } = {}) {
  const rules = knowledge.rules;
  const q = String(query || "").slice(0, 200);
  const { base, weights } = queryTerms(q);
  const lq = q.toLowerCase().trim();
  const idx = rules.index;
  const scores = new Map();
  const add = (i, v) => scores.set(i, (scores.get(i) || 0) + v);
  for (const [term, wt] of weights) {
    const posts = idx.postings[term];
    if (!posts) continue;
    const df = posts.length;
    const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
    for (const [i, tf] of posts) {
      const norm = tf + idx.k1 * (1 - idx.b + idx.b * (idx.dl[i] / (idx.avgdl || 1)));
      add(i, wt * idf * ((tf * (idx.k1 + 1)) / norm));
    }
  }
  if (!scores.size) return { hits: [], total: 0 };
  // Exact anchor mention, rule-id mention and phrase matches rank above bag-of-words noise.
  for (const m of lq.match(/[a-z0-9][a-z0-9-]{1,62}/g) || []) {
    if (rules.anchorIndex[m] !== undefined) add(rules.anchorIndex[m], 50);
  }
  for (const tok of lq.match(/[a-z]\d+[a-z]?(?:\.\d+)?/g) || []) for (const a of rules.byId[tok] || []) add(rules.anchorIndex[a], 4);
  const words = lq.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  for (const i of [...scores.keys()]) {
    // Title coverage: a rule whose title holds the query's content words is the better answer than one that merely mentions them.
    if (base.length) {
      const tt = new Set(tokenize(rules.byAnchor[rules.order[i]].title));
      add(i, (base.filter((t) => tt.has(t)).length / base.length) * 4);
    }
    if (words.length >= 2) {
      const phrase = words.join(" ");
      if (rules.lcTitle[i].includes(phrase)) add(i, 3);
      else if (rules.lcText[i].includes(phrase)) add(i, 1.5);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
  const hits = ranked.slice(0, Math.max(1, Math.min(MAX_SEARCH_HITS, Number(limit) || 5))).map(([i, score]) => {
    const e = rules.byAnchor[rules.order[i]];
    return {
      anchor: e.anchor, id: e.id, ref: e.ref, title: e.title, path: e.path,
      snippet: snippetFor(e.text || e.title, q), score: Math.round(score * 1000) / 1000, canon_sha: e.canon_sha,
    };
  });
  return { hits, total: ranked.length, terms: base };
}

function splitParts(text, size) {
  const parts = [];
  let cur = "";
  const flush = () => { if (cur) { parts.push(cur); cur = ""; } };
  for (const line of text.split("\n")) {
    let l = line;
    while (l.length > size) {
      let cut = l.lastIndexOf(" ", size);
      if (cut < size * 0.5) cut = size;
      flush();
      parts.push(l.slice(0, cut));
      l = l.slice(cut).trimStart();
    }
    if (cur && cur.length + 1 + l.length > size) flush();
    cur = cur ? `${cur}\n${l}` : l;
  }
  flush();
  return parts.length ? parts : [""];
}

// -> { found, entry, part, parts_total, text } | { found:false, suggestions:[anchors] }
export function getRule(knowledge, anchor, part = 1) {
  const rules = knowledge.rules;
  const key = String(anchor || "").trim().toLowerCase();
  const e = rules.byAnchor[key];
  if (!e) {
    const suggestions = [];
    for (const a of rules.byId[key] || []) suggestions.push(a);
    if (!suggestions.length && key.length >= 3) for (const a of rules.order) { if (a.startsWith(key) || key.startsWith(a)) suggestions.push(a); if (suggestions.length >= 5) break; }
    return { found: false, suggestions: suggestions.slice(0, 5) };
  }
  const parts = splitParts(e.text, RULE_PART_CHARS);
  const p = Math.min(Math.max(1, Math.floor(Number(part) || 1)), Math.min(parts.length, MAX_RULE_PARTS));
  return { found: true, entry: e, part: p, parts_total: Math.min(parts.length, MAX_RULE_PARTS), parts_truncated: parts.length > MAX_RULE_PARTS, text: parts[p - 1] };
}

// ── Glossary lookup ─────────────────────────────────────────────────────────────────────────────────
// -> { kind: "exact" | "composed" | "candidates" | "none", entries[], composed?, status_like? }
export function lookupGlossary(knowledge, term) {
  const g = knowledge.glossary;
  const n = normalizeGlossaryKey(term), c = compactGlossaryKey(term);
  if (!n) return { kind: "none", entries: [] };
  let i = g.byKey[n];
  if (i === undefined) i = g.byCompact[c];
  if (i !== undefined) return { kind: "exact", entries: [g.entries[i]] };
  const m = /^(.+?)[\s-]+(fl|bl)$/.exec(n);
  if (m) {
    let bi = g.byKey[m[1]];
    if (bi === undefined) bi = g.byCompact[compactGlossaryKey(m[1])];
    const si = g.byKey[m[2]];
    if (bi !== undefined && si !== undefined) return { kind: "composed", entries: [g.entries[bi], g.entries[si]], composed: { base: m[1], suffix: m[2] } };
  }
  const words = [...new Set(n.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const scored = [];
  g.entries.forEach((e, idx) => {
    const hay = normalizeGlossaryKey([e.term, ...e.aliases].join(" "));
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits) scored.push([hits, idx]);
  });
  scored.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
  const statusLike = /^(vet|rookie)-[a-z0-9-]+$/.test(n);
  if (scored.length) return { kind: "candidates", entries: scored.slice(0, 3).map(([, idx]) => g.entries[idx]), status_like: statusLike };
  return { kind: "none", entries: [], status_like: statusLike };
}

// ── Coverage ────────────────────────────────────────────────────────────────────────────────────────
// -> { domain, label, kind, tools, season, level, reason, phase_needed, lr_id, gap_ids, note } | null (unknown domain)
export function resolveCoverage(knowledge, domainId, season, asOf = "current") {
  const d = knowledge.coverage.matrix.find((x) => x.id === domainId);
  if (!d) return null;
  const cur = knowledge.currentSeason;
  const out = (c, over = {}) => ({ domain: d.id, label: d.label, kind: d.kind, tools: d.tools, season, level: c.level, reason: c.reason, phase_needed: c.phase_needed, lr_id: c.lr_id, gap_ids: c.gap_ids, note: c.note, ...over });
  const none = (reason, phase, note) => out({ level: "none", reason, phase_needed: phase, lr_id: null, gap_ids: [], note });
  if (season < COVERAGE_FIRST_SEASON) return none("NO_RECORD", "X", "That is before the league's first season on record.");
  if (cur && season > cur) return none("unsupported_as_of", "X", "That season has not happened yet.");
  if (season > COVERAGE_LAST_SEASON) return none("stale", "P1", "The coverage matrix was written before this season and has not been regenerated, so it cannot vouch for it.");
  if (d.kind === "current_only") {
    const past = asOf !== "current" || season !== cur;
    return out(past ? d.past : d.current);
  }
  const sp = d.spans.find((s) => season >= s.from && season <= s.to);
  return sp ? out(sp) : none("NO_RECORD", "X", "No coverage is recorded for that season.");
}
