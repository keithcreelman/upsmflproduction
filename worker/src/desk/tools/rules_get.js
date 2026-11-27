// Tool 2: rules.get. Exact rule text by anchor, for citation. Current canon only; a past as_of labels the text as current.
import { defineTool } from "../registry.js";
import { getRule, staleIndexRefusal, MAX_RULE_PARTS, ruleHeadingYear } from "../knowledge.js";

const todayIso = (now) => (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
const dateOnly = (s) => (typeof s === "string" ? s.slice(0, 10) : null);

export default defineTool({
  id: "rules.get",
  version: "1.0.0",
  description: "Read one rule of the league's current canon by its anchor (for example s1-c4): the plain text, the section path, the canon version and the child rules. Long rules come in parts. Use it to quote or cite a rule found with rules.search. Internal commissioner notes are not included, and it cannot give a rule as it stood on a past date.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      anchor: { type: "string", maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$", description: "Rule anchor from rules.search, for example s1-d1." },
      part: { type: "integer", minimum: 1, maximum: MAX_RULE_PARTS, description: "Part number for a long rule (default 1)." },
    },
    required: ["anchor"],
  },
  asOf: { supports: "any" },
  allowlist: { routes: [], modules: ["knowledge.js"], tables: [] },
  output: {
    allow: [
      "anchor", "id", "ref", "title", "path", "section_id", "parent_anchor", "children", "tags", "statuses", "updated",
      "part", "parts_total", "text", "canon_sha", "canon_date", "current_text_only", "as_of_label", "suggestions",
    ],
  },
  async run({ args, asOf, now, knowledge }) {
    if (!knowledge || !knowledge.rules || !knowledge.rulesMeta) {
      return { status: "error", error: { code: "knowledge_missing", message: "the rules index is not loaded" }, coverage: { supported: false, gaps: [] } };
    }
    const stale = staleIndexRefusal(knowledge);
    if (stale) return stale;
    const meta = knowledge.rulesMeta;
    const provenance = { module: "knowledge.js", source: "site/m/data/rules.json", canon_sha: meta.canon_sha, canon_date: meta.canon_date };
    const freshness = { canon_date: meta.canon_date, canon_sha: meta.canon_sha };
    const got = getRule(knowledge, args.anchor, args.part || 1);
    if (!got.found) {
      return {
        status: "no_record",
        data: { anchor: String(args.anchor).slice(0, 160), canon_sha: meta.canon_sha, suggestions: got.suggestions },
        coverage: { supported: false, gaps: [{ what: `a public canon rule with anchor "${String(args.anchor).slice(0, 80)}"`, why: "NO_RECORD", source_needed: "use rules.search to find the right anchor" }] },
        provenance, freshness,
      };
    }
    const e = got.entry;
    const data = {
      anchor: e.anchor, id: e.id, ref: e.ref, title: e.title, path: e.path, section_id: e.section_id, parent_anchor: e.parent_anchor,
      children: e.children, tags: e.tags, statuses: e.statuses, updated: e.updated,
      part: got.part, parts_total: got.parts_total, text: got.text, canon_sha: e.canon_sha, canon_date: meta.canon_date,
    };
    if (asOf !== "current" && asOf !== todayIso(now)) {
      return {
        status: "unsupported_as_of",
        data: { ...data, current_text_only: true, as_of_label: `This is the CURRENT canon text. It is not the rule in force on ${asOf}.` },
        coverage: { supported: false, gaps: [{ what: `the rule text in force on ${asOf}`, why: "unsupported_as_of", source_needed: "a dated rule-version table (League Record slice S4)" }] },
        provenance, freshness,
      };
    }
    const SRC = "site/m/data/rules.json";
    const facts = [
      { key: "rule_anchor", label: "Rule anchor", value: e.anchor, unit: "id", as_of: "current", source: SRC, grade: "B" },
      { key: "canon_sha", label: "Canon version (commit)", value: e.canon_sha, unit: "text", as_of: "current", source: SRC, grade: "B" },
      // The rule's own heading, as the canon writes it. It may be printed only beside a cite to this same rule (validator RULE_FACT_UNCITED).
      { key: "rule_title", label: "Heading of this rule in the canon", value: String(e.title).slice(0, 200), unit: "text", as_of: "current", source: SRC, grade: "B" },
    ];
    // The year that heading names (only a "Rule changes by year" heading with exactly one year). It is the year in the heading, not a proved effective date: the gap below stays.
    const headingYear = ruleHeadingYear(e);
    if (headingYear != null) facts.push({ key: "rule_year", label: "Year in the heading of this rule", value: headingYear, unit: "season", as_of: "current", source: SRC, grade: "B" });
    const gaps = got.parts_total > got.part ? [{ what: `the rest of this rule (part ${got.part} of ${got.parts_total} shown)`, why: "partial_coverage", source_needed: "call rules.get again with the next part" }] : [];
    if (headingYear != null) gaps.push({ what: "The exact date this rule took effect: the heading names a year only", why: "NO_RECORD", source_needed: "League Record slice S4 (rules by date)" });
    return {
      status: "ok",
      data,
      facts,
      coverage: { supported: gaps.length === 0, gaps },
      provenance, freshness,
    };
  },
});
