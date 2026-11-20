// Tool 1: rules.search. Keyword search over the member-facing canon (site/m/data/rules.json, built from
// docs/league_context_v1.md). Current canon text only. A past as_of answers "unsupported_as_of" and returns the
// current text clearly labeled as such, never as the rule in force on that date.
import { defineTool } from "../registry.js";
import { searchRules, staleIndexRefusal, MAX_SEARCH_HITS } from "../knowledge.js";

const todayIso = (now) => (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
const dateOnly = (s) => (typeof s === "string" ? s.slice(0, 10) : null);

export default defineTool({
  id: "rules.search",
  version: "1.0.0",
  description: "Search the league's current rulebook (canon) by keyword and get the matching rule anchors, section paths and short snippets, each with the canon version. Answers which rule applies, today. It cannot say what the rule was on a past date: for a past as_of it returns the current text labeled as current only. Use rules.get with an anchor to read a rule in full.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200, description: "Keywords or a short question, for example 'cap penalty formula' or 'taxi call-up weeks'." },
      limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_HITS, description: "How many rules to return (default 5)." },
    },
    required: ["query"],
  },
  asOf: { supports: "any" },
  allowlist: { routes: [], modules: ["knowledge.js"], tables: [] },
  output: {
    allow: [
      "query", "canon_sha", "canon_date", "scope", "current_text_only", "as_of_label", "total_matches",
      "hits[].anchor", "hits[].id", "hits[].ref", "hits[].title", "hits[].path", "hits[].snippet", "hits[].score", "hits[].canon_sha",
    ],
  },
  async run({ args, asOf, now, knowledge }) {
    if (!knowledge || !knowledge.rules || !knowledge.rulesMeta) {
      return { status: "error", error: { code: "knowledge_missing", message: "the rules index is not loaded" }, coverage: { supported: false, gaps: [] } };
    }
    const stale = staleIndexRefusal(knowledge);
    if (stale) return stale;
    const meta = knowledge.rulesMeta;
    const r = searchRules(knowledge, args.query, { limit: args.limit || 5 });
    const past = asOf !== "current" && asOf !== todayIso(now);
    const base = {
      query: args.query, canon_sha: meta.canon_sha, canon_date: meta.canon_date, scope: "current canon text only",
      total_matches: r.total, hits: r.hits,
    };
    const provenance = { module: "knowledge.js", source: "site/m/data/rules.json", canon_sha: meta.canon_sha, canon_date: meta.canon_date };
    const freshness = { canon_date: meta.canon_date, canon_sha: meta.canon_sha };

    if (past) {
      return {
        status: "unsupported_as_of",
        data: { ...base, current_text_only: true, as_of_label: `This is the CURRENT canon text. It is not the rule in force on ${asOf}.` },
        coverage: { supported: false, gaps: [{ what: `the rule text in force on ${asOf}`, why: "unsupported_as_of", source_needed: "a dated rule-version table (League Record slice S4)" }] },
        provenance, freshness,
      };
    }
    if (!r.hits.length) {
      return {
        status: "no_record",
        data: base,
        coverage: { supported: false, gaps: [{ what: `a rule matching "${String(args.query).slice(0, 80)}"`, why: "NO_RECORD", source_needed: "canon (docs/league_context_v1.md) does not mention it" }] },
        provenance, freshness,
      };
    }
    return {
      status: "ok",
      data: base,
      facts: [
        { key: "canon_sha", label: "Canon version (commit)", value: meta.canon_sha, unit: "text", as_of: "current", source: "site/m/data/rules.json", grade: "B" },
        { key: "canon_date", label: "Canon last changed", value: dateOnly(meta.canon_date), unit: "date", as_of: "current", source: "site/m/data/rules.json", grade: "B" },
        { key: "match_count", label: "Rules matching the search", value: r.total, unit: "count", as_of: "current", source: "rules.search", grade: "C" },
      ].filter((f) => f.value != null && f.value !== ""),
      coverage: { supported: true, gaps: [] },
      provenance, freshness,
    };
  },
});
