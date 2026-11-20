// Tool 3: glossary.lookup. League terms and contract-status tokens, each tied to a canon anchor or a repo source file.
// Where canon is silent the entry says so. It explains a token; it never reclassifies a contract.
import { defineTool } from "../registry.js";
import { lookupGlossary } from "../knowledge.js";
import { normalizeGlossaryKey } from "../data/glossary.js";

const sourceLabel = (n) => `canon ${n.anchor}`;

function recognizedByCode(knowledge, lookup) {
  const codes = new Set(knowledge.glossary.codeTokens);
  const names = (e) => [e.term, ...e.aliases].map(normalizeGlossaryKey);
  if (lookup.kind === "composed") {
    const base = lookup.entries[0];
    return names(base).some((n) => codes.has(n));
  }
  if (lookup.kind !== "exact") return false;
  return lookup.entries.some((e) => e.kind === "status_token" && names(e).some((n) => codes.has(n)));
}

function numberFacts(entries) {
  const facts = [];
  const seen = new Map();
  for (const e of entries) {
    for (const n of e.numbers || []) {
      if (seen.has(n.key)) continue;   // the same number can sit on two entries (FCFS salary); a fact id may appear once
      seen.set(n.key, n.value);
      facts.push({ key: n.key, label: n.label, value: n.value, unit: n.unit, as_of: "current", source: sourceLabel(n), grade: "B" });
    }
  }
  return facts;
}

export default defineTool({
  id: "glossary.lookup",
  version: "1.0.0",
  description: "Explain a league term or contract-status token (for example MYM, Vet-ERA, Ext2, FL/BL, taxi call-up, cap floor), with the canon anchor or source file behind it. If canon does not define a token the entry says canon is silent. A status with an FL or BL suffix is explained as its base plus the suffix. It explains vocabulary only: it cannot say what a specific player's contract is, and it does not reclassify old contracts.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { term: { type: "string", maxLength: 80, description: "A league term or a raw contractStatus value, for example 'Vet-FAA-BL'." } },
    required: ["term"],
  },
  asOf: { supports: "current" },
  allowlist: { routes: [], modules: ["knowledge.js", "data/glossary.js"], tables: [] },
  output: {
    allow: [
      "term", "match_kind", "composed.base", "composed.suffix", "recognized_by_code", "status_like", "note",
      "entries[].id", "entries[].term", "entries[].kind", "entries[].definition", "entries[].aliases", "entries[].canon_silent", "entries[].caveat",
      "entries[].sources[].type", "entries[].sources[].anchor", "entries[].sources[].file", "entries[].sources[].note",
      "did_you_mean[].id", "did_you_mean[].term",
    ],
  },
  async run({ args, knowledge }) {
    if (!knowledge || !knowledge.glossary) {
      return { status: "error", error: { code: "knowledge_missing", message: "the glossary is not loaded" }, coverage: { supported: false, gaps: [] } };
    }
    const lk = lookupGlossary(knowledge, args.term);
    const provenance = { module: "knowledge.js", source: "worker/src/desk/data/glossary.js", entries: knowledge.glossary.entries.length };
    const slim = (e) => ({ id: e.id, term: e.term, kind: e.kind, definition: e.definition, aliases: e.aliases, canon_silent: !!e.canon_silent, caveat: e.caveat || undefined, sources: e.sources });

    if (lk.kind === "exact" || lk.kind === "composed") {
      const entries = lk.entries;
      const silent = entries.every((e) => e.canon_silent);
      return {
        status: "ok",
        data: {
          term: args.term, match_kind: lk.kind, composed: lk.composed, recognized_by_code: recognizedByCode(knowledge, lk),
          entries: entries.map(slim),
          note: silent ? "Canon does not define this term. The entry says only what the code does." : undefined,
        },
        facts: numberFacts(entries),
        coverage: {
          supported: true,
          gaps: silent ? [{ what: `a canon definition of "${String(args.term).slice(0, 60)}"`, why: "NO_RECORD", source_needed: "canon is silent; a commissioner ruling would define it" }] : [],
        },
        provenance,
      };
    }
    const dym = lk.entries.map((e) => ({ id: e.id, term: e.term }));
    return {
      status: "no_record",
      data: {
        term: args.term, match_kind: lk.kind, recognized_by_code: false, status_like: !!lk.status_like, did_you_mean: dym,
        note: lk.status_like ? "This looks like a contract-status token, but it is not one the code recognizes, and canon does not define it." : "No glossary entry for this term.",
      },
      coverage: { supported: false, gaps: [{ what: `a glossary entry for "${String(args.term).slice(0, 60)}"`, why: "NO_RECORD", source_needed: "canon or code that defines the term" }] },
      provenance,
    };
  },
});
