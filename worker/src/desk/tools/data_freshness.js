// Tool 14: data.freshness. How fresh each data source is: the ETL stamps behind /api/data-freshness (etl_runs, one row
// per source) compared with a per-source limit, plus whether the desk's own rules index matches the canon it was built from.
//
// Honest limits: most scheduled jobs do not write etl_runs, so a source missing here is "not tracked", not "fresh".
// Per-source limits are not published anywhere; every source gets the default below, and the output says so.
import { defineTool } from "../registry.js";

// The nflverse refresh workflow runs weekly in season (Mon to Wed UTC). A week plus a day of slack.
export const ETL_DEFAULT_MAX_AGE_HOURS = 192;
// Per-source overrides. Empty on purpose: no source publishes its own cadence. Add an entry only with a source for it.
export const ETL_SOURCE_MAX_AGE_HOURS = Object.freeze({});
export const MAX_SOURCES_REPORTED = 40;
const MAX_STALE_GAPS = 10;
const LIMIT_BASIS = "default for every source (weekly refresh plus a day of slack); per-source limits are not published";

const short = (s) => String(s || "").slice(0, 8);

function judgeSources(rows, nowMs) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : []).slice(0, MAX_SOURCES_REPORTED)) {
    if (!r || typeof r.source !== "string") continue;
    const ts = Date.parse(r.last_run_utc);
    const limit = Object.prototype.hasOwnProperty.call(ETL_SOURCE_MAX_AGE_HOURS, r.source) ? ETL_SOURCE_MAX_AGE_HOURS[r.source] : ETL_DEFAULT_MAX_AGE_HOURS;
    const status = typeof r.status === "string" ? r.status.slice(0, 40) : null;
    let age = null, stale = false, reason = null;
    if (!Number.isFinite(ts)) { stale = true; reason = "no usable last-run time"; }
    else {
      age = Math.max(0, Math.round(((nowMs - ts) / 3600000) * 10) / 10);
      if (age > limit) { stale = true; reason = `older than the ${limit} hour limit`; }
    }
    if (!stale && status === "error") { stale = true; reason = "the last run failed"; }
    out.push({ source: r.source.slice(0, 60), last_run_utc: Number.isFinite(ts) ? r.last_run_utc : null, status, age_hours: age, limit_hours: limit, stale, reason });
  }
  return out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

function judgeRulesIndex(knowledge) {
  const meta = knowledge && knowledge.rulesMeta;
  if (!meta) return { status: "unverified", canon_sha: null, canon_date: null, bundled_sha: null, canon_text_digest_ok: null, reason: "the rules index is not loaded" };
  const bundled = knowledge.canonShaBundled || null;
  const base = { canon_sha: meta.canon_sha, canon_date: meta.canon_date, bundled_sha: bundled, canon_text_digest_ok: meta.canon_text_digest_ok };
  if (bundled && bundled !== meta.canon_sha) return { ...base, status: "stale", reason: `the rules index was built from canon ${short(meta.canon_sha)}, but the bundled canon is ${short(bundled)}` };
  if (meta.canon_text_digest_ok === false) return { ...base, status: "stale", reason: "the rules index does not match the canon text bundled with the Worker" };
  if (bundled || meta.canon_text_digest_ok === true) return { ...base, status: "current", reason: null };
  return { ...base, status: "unverified", reason: "no bundled canon version was supplied to compare with" };
}

export default defineTool({
  id: "data.freshness",
  version: "1.0.0",
  description: "Report how fresh the desk's data sources are: the last run of each tracked data job (nflverse stats, Discord reconciliation and others that record a run), whether any is older than its limit or failed, and whether the desk's rulebook index matches the canon version bundled with it. Call it before relying on stats or rules for a recent question. Most scheduled jobs do not record a run, so a source that is not listed is untracked, not fresh. Current state only.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, required: [] },
  asOf: { supports: "current" },
  allowlist: { routes: [{ path: "/api/data-freshness", params: ["L"] }], modules: ["knowledge.js"], tables: [] },
  output: {
    allow: [
      "overall", "limit_basis",
      "etl.available", "etl.route_error", "etl.generated_at", "etl.source_count", "etl.stale_count",
      "etl.weekly_coverage.season", "etl.weekly_coverage.week",
      "etl.sources[].source", "etl.sources[].last_run_utc", "etl.sources[].status", "etl.sources[].age_hours",
      "etl.sources[].limit_hours", "etl.sources[].stale", "etl.sources[].reason",
      "rules_index.status", "rules_index.canon_sha", "rules_index.canon_date", "rules_index.bundled_sha", "rules_index.canon_text_digest_ok", "rules_index.reason",
    ],
  },
  async run({ now, routeGet, knowledge }) {
    const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
    const gaps = [];
    const rules = judgeRulesIndex(knowledge);
    if (rules.status === "stale") gaps.push({ what: "the desk's rulebook index", why: "stale", source_needed: "rebuild site/m/data/rules.json from canon (scripts/build_rulebook_data.py)" });

    // The route takes no parameters today; L is sent because every desk route call carries the league id, and the route ignores it.
    let etl = { available: false, route_error: null, source_count: 0, stale_count: 0, sources: [] };
    try {
      const params = knowledge && knowledge.leagueId ? { L: knowledge.leagueId } : {};
      const res = await routeGet("/api/data-freshness", params);
      if (res.ok && res.json && res.json.ok === true && Array.isArray(res.json.etl)) {
        const sources = judgeSources(res.json.etl, nowMs);
        const wc = res.json.weeklyCoverage && typeof res.json.weeklyCoverage === "object" ? { season: res.json.weeklyCoverage.season ?? null, week: res.json.weeklyCoverage.week ?? null } : null;
        etl = {
          available: true, route_error: null, generated_at: typeof res.json.generated_at === "string" ? res.json.generated_at : null,
          source_count: sources.length, stale_count: sources.filter((s) => s.stale).length, sources, ...(wc ? { weekly_coverage: wc } : {}),
        };
        // The registry allows at most 20 gaps per result, so name the first few stale sources and summarize the rest.
        const staleSources = sources.filter((x) => x.stale);
        for (const s of staleSources.slice(0, MAX_STALE_GAPS)) gaps.push({ what: `data source ${s.source}`, why: "stale", source_needed: s.reason });
        if (staleSources.length > MAX_STALE_GAPS) gaps.push({ what: `${staleSources.length - MAX_STALE_GAPS} more data sources`, why: "stale", source_needed: "see etl.sources for each one" });
      } else {
        etl.route_error = `route answered ${res.status}`;
      }
    } catch (e) {
      etl.route_error = (e && e.deskCode) || "route_failed";
    }
    if (!etl.available) gaps.push({ what: "ETL freshness stamps", why: "stale", source_needed: "/api/data-freshness did not answer, so source ages are unknown" });

    const anyStale = etl.stale_count > 0 || rules.status === "stale" || !etl.available;
    const overall = anyStale ? "stale" : rules.status === "unverified" ? "partial" : "fresh";
    const oldest = etl.sources.reduce((m, s) => (s.age_hours != null && s.age_hours > m ? s.age_hours : m), 0);
    const src = "/api/data-freshness (etl_runs) and the desk rules index";
    const facts = [
      { key: "overall_freshness", label: "Overall data freshness", value: overall, unit: "text", as_of: "current", source: src, grade: "C" },
      { key: "rules_index_status", label: "Rulebook index status", value: rules.status, unit: "text", as_of: "current", source: "desk rules index", grade: "C" },
    ];
    if (etl.available) {
      facts.push({ key: "sources_tracked", label: "Data sources tracked", value: etl.source_count, unit: "count", as_of: "current", source: src, grade: "C" });
      facts.push({ key: "sources_stale", label: "Data sources past their limit or failed", value: etl.stale_count, unit: "count", as_of: "current", source: src, grade: "C" });
      facts.push({ key: "oldest_source_hours", label: "Oldest tracked source (hours)", value: Math.round(oldest), unit: "count", as_of: "current", source: src, grade: "C" });
    }
    if (rules.canon_sha) facts.push({ key: "rules_canon_sha", label: "Rulebook index canon version", value: rules.canon_sha, unit: "text", as_of: "current", source: "desk rules index", grade: "B" });

    return {
      status: "ok",
      data: { overall, limit_basis: LIMIT_BASIS, etl, rules_index: rules },
      facts,
      coverage: { supported: gaps.length === 0, gaps },
      provenance: { route: "/api/data-freshness", module: "knowledge.js", limit_default_hours: ETL_DEFAULT_MAX_AGE_HOURS },
      freshness: { checked_at: new Date(nowMs).toISOString(), etl_generated_at: etl.generated_at || null },
    };
  },
});
