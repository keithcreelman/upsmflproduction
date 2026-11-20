// Tool 4: coverage.check. "Does data exist to answer this?" from the static coverage matrix, before any number is composed.
// It is the main defense against a confident wrong answer built on data that does not exist.
import { defineTool } from "../registry.js";
import { resolveCoverage } from "../knowledge.js";
import { COVERAGE_DOMAIN_IDS } from "../data/coverage_matrix.js";

const PHASE_SOURCE = {
  P1: "a Phase 1 tool or a data fix for this domain",
  S1: "League Record slice S1 (trades and picks)",
  S2: "League Record slice S2 (contract timeline)",
  S3: "League Record slice S3 (owner registry)",
  S4: "League Record slice S4 (rules by date)",
  F: "a later private store for forum and chat history",
  X: "not available to the desk by policy, or not applicable",
};

export default defineTool({
  id: "coverage.check",
  version: "1.0.0",
  description: "Check whether the desk has data to answer a question about a domain (for example pick_lineage, cap_adjustments, finishes, contract_timeline, rules_by_date) in a given season: full, partial or none, why, and which later phase would close the gap. Use it first for any history question. 'all' lists every domain for the season. It reports what data exists; it does not fetch any league data.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", enum: [...COVERAGE_DOMAIN_IDS, "all"], description: "A data domain, or 'all'." },
      season: { type: "integer", minimum: 1990, maximum: 2100, description: "Season year. Defaults to the year of as_of (the current season for 'current')." },
    },
    required: ["domain"],
  },
  asOf: { supports: "any" },
  allowlist: { routes: [], modules: ["knowledge.js", "data/coverage_matrix.js"], tables: [] },
  output: {
    allow: [
      "domain", "label", "kind", "season", "level", "reason", "phase_needed", "lr_id", "gap_ids", "note", "tools", "season_source",
      "domains[].domain", "domains[].label", "domains[].level", "domains[].reason", "domains[].phase_needed", "domains[].lr_id",
    ],
  },
  async run({ args, asOf, knowledge }) {
    if (!knowledge || !knowledge.coverage) {
      return { status: "error", error: { code: "knowledge_missing", message: "the coverage matrix is not loaded" }, coverage: { supported: false, gaps: [] } };
    }
    const asOfYear = asOf === "current" ? knowledge.currentSeason : Number(String(asOf).slice(0, 4));
    const season = args.season != null ? args.season : asOfYear;
    const season_source = args.season != null ? (args.season !== asOfYear ? "season argument (overrides the year of as_of)" : "season argument") : (asOf === "current" ? "current season" : "year of as_of");
    const provenance = { module: "knowledge.js", source: "worker/src/desk/data/coverage_matrix.js", matrix_last_season: knowledge.coverage.last_season };

    if (args.domain === "all") {
      const rows = knowledge.coverage.domains.map((d) => {
        const c = resolveCoverage(knowledge, d.id, season, asOf);
        return { domain: d.id, label: d.label, level: c.level, reason: c.reason, phase_needed: c.phase_needed, lr_id: c.lr_id };
      });
      return { status: "ok", data: { season, season_source, domains: rows }, facts: [], coverage: { supported: true, gaps: [] }, provenance };
    }

    const c = resolveCoverage(knowledge, args.domain, season, asOf);
    if (!c) return { status: "no_record", data: { domain: args.domain }, coverage: { supported: false, gaps: [{ what: `a coverage entry for ${args.domain}`, why: "NO_RECORD", source_needed: "none" }] }, provenance };
    const src = "coverage matrix (docs/ai_desk/TOOL_CATALOG.md, LEAGUE_RECORD_BACKLOG.md)";
    const facts = [
      { key: "coverage_level", label: `Data coverage: ${c.label}`, value: c.level, unit: "text", as_of: asOf, source: src, grade: "C" },
      { key: "season_checked", label: "Season checked", value: season, unit: "season", as_of: asOf, source: src, grade: "C" },
      { key: "phase_needed", label: "Phase that closes the gap", value: c.phase_needed, unit: "text", as_of: asOf, source: src, grade: "C" },
    ];
    if (c.reason) facts.push({ key: "gap_reason", label: "Why coverage is short", value: c.reason, unit: "text", as_of: asOf, source: src, grade: "C" });
    if (c.lr_id) facts.push({ key: "backlog_id", label: "League Record backlog item", value: c.lr_id, unit: "id", as_of: asOf, source: src, grade: "C" });
    return {
      status: "ok",
      data: { domain: c.domain, label: c.label, kind: c.kind, season, season_source, level: c.level, reason: c.reason, phase_needed: c.phase_needed, lr_id: c.lr_id, gap_ids: c.gap_ids, note: c.note, tools: c.tools },
      facts,
      coverage: {
        supported: c.level === "full",
        gaps: c.level === "full" ? [] : [{ what: `${c.label} for ${season}${c.level === "partial" ? " (partial)" : ""}`, why: c.reason, source_needed: PHASE_SOURCE[c.phase_needed] || c.phase_needed }],
      },
      provenance,
    };
  },
});
