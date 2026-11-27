// Commissioner Desk eval harness: map ONE bank case to the offline check that can honestly be run for it. Pure and deterministic:
// same case in, same plan out; no I/O, no clock. The plan says WHAT to check; run_data_checks.mjs runs the real tools and the real validator.
//
// Domain inference is rule-based on the case's category, question text and data_dependencies (never on its id), so it works on a held-out bank
// of the same shape. Where no rule applies the plan says so (domain: null) and the case is reported as not checkable, never guessed.
// The plan holds enums, numbers and fixed strings only: it never copies question or expected-answer text into its output.
import { COVERAGE_MATRIX, COVERAGE_FIRST_SEASON } from "../../../worker/src/desk/data/coverage_matrix.js";

export const DEFAULT_CURRENT_SEASON = 2026;
export const STATUSES = Object.freeze(["CHECKED_PASS", "CHECKED_FAIL", "BEHAVIOR_INFRA_PASS", "NEEDS_MODEL", "NOT_CHECKABLE_OFFLINE"]);

// What the case wants the desk to do in Phase 1 (from p1_expected).
export const EXPECT_CLASS = Object.freeze({
  answer: "assert", answer_with_caveat: "assert", cite: "assert",
  answer_with_gap: "gap", partial: "gap", cite_and_abstain: "gap", abstain: "gap", needs_ruling: "gap",
  answer_with_conflict: "conflict", explain_conflict: "conflict",
  refuse_privacy: "refuse", refuse_fairness: "refuse",
  ignore_injection: "injection", tool_failure_message: "toolfail",
});

// Categories whose domain is a composite judgment, not a single matrix row: coverage is shown for information, never used to fail a case.
export const INFORMATIONAL_CATEGORIES = Object.freeze(["CNF", "ADV"]);

const MATRIX = new Map(COVERAGE_MATRIX.map((d) => [d.id, d]));
const POSITION_KEYS = new Set(["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]);
const BUNDLED_DOMAINS = new Set(["rules_current", "rules_at_date", "rules_by_date"]);

// ── Seasons named by a question ─────────────────────────────────────────────────────────────────
export function seasonsInQuestion(question, currentSeason = DEFAULT_CURRENT_SEASON) {
  const q = String(question || "");
  const years = new Set();
  for (const m of q.matchAll(/\b(20[0-2]\d)\s*(?:to|through|thru|[-–—])\s*(20[0-2]\d)\b/g)) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b >= a && b - a <= 30) for (let y = a; y <= b; y++) years.add(y);
  }
  for (const m of q.matchAll(/\bsince\s+(20[0-2]\d)\b/gi)) for (let y = Number(m[1]); y <= currentSeason; y++) years.add(y);
  for (const m of q.matchAll(/\b(20[0-2]\d)\b/g)) years.add(Number(m[1]));
  return [...years].sort((a, b) => a - b);
}

// ── Domain inference ────────────────────────────────────────────────────────────────────────────
function depsText(c) { return (c.data_dependencies || []).join(" ").toLowerCase(); }

// -> { id, basis } | { id: null, reason }
export function inferDomain(c) {
  const q = String(c.question || "");
  const deps = depsText(c);
  const cat = c.category;
  const none = (reason) => ({ id: null, reason });
  const dom = (id, basis) => ({ id, basis });

  if (cat === "LIN") {
    if (/raw_json|draftresults/.test(deps) || (/\bpick\b/i.test(q) && /trace|chain|follow|where did|ended up|lineage|slot/i.test(q))) return dom("pick_lineage", "pick tracing");
    return none("no franchise-level trade list domain in the matrix");
  }
  if (cat === "PLH") {
    if (/weeklyresults/.test(deps) || /\bstart(ed)?\b.*\bpoints\b|\bstarter points\b/i.test(q)) return none("no per-player weekly results domain in the matrix");
    return dom("player_transactions", "a player's moves");
  }
  if (cat === "CON") {
    if (/grandfather|\bGF\b/i.test(q)) return dom("grandfather_tags", "grandfather tags");
    if (/ups_extension_master|\b(logged|evidenced|derived)\b/i.test(q + " " + deps)) return dom("contract_timeline", "contract history");
    if (/cap[- ]penalt|\bpenalty\b|\bcut\b|\bdrop\b/i.test(q)) {
      return /\b(today|now|current(ly)?)\b/i.test(q) || c.as_of === "eval_time" ? dom("cap_penalty_current", "penalty quote now") : dom("cap_penalty_history", "penalty in a past season");
    }
    if (/\bextension\b|\bextend\b/i.test(q) && /\b(cost|price)\b/i.test(q)) return dom("extension_price_current", "extension price");
    if (/week \d+ of \d{4}|contract string|years remaining|\bsalary\b/i.test(q)) return dom("contract_timeline", "contract on a past date");
    return none("contract question not matched to a matrix domain");
  }
  if (cat === "RUL") return dom("rules", "rules question");
  if (cat === "OWN") {
    if (/\bowner|\bwho (controlled|owned|managed|ran)\b/i.test(q)) return dom("owner_history", "who held a franchise");
    return dom("standings", "franchise-level names and ids");
  }
  if (cat === "PRV") return none("no Phase 1 tool returns this owner-private item");
  if (cat === "UNA") {
    if (/\bbid(s|ding)?\b/i.test(q)) return none("no auction-bid domain in the matrix");
    if (/\bwho did\b.*\bplay\b|\bopponent\b|\bmatchup/i.test(q)) return none("no schedule or pairings domain in the matrix");
    if (/restructure/i.test(q)) return dom("contract_timeline", "contract change dates");
    if (/manifesto/i.test(q)) return dom("rules_at_date", "early rulebook text");
    if (/slack|vote|message board|forum|discord|\bsaid\b/i.test(q)) return dom("forum_history", "league chat and votes");
    if (/dispersal draft|draft order/i.test(q)) return dom("draft_order", "draft order");
    if (/\b(title|champion)\b/i.test(q)) return dom("finishes", "titles");
    return none("unanswerable question not matched to a matrix domain");
  }
  if (cat === "NOW") {
    if (/cap room|cap space|committed|restructure/i.test(q)) return dom("cap_current", "cap now");
    if (/loaded|taxi|roster (max|min)|roster size|over the roster/i.test(q)) return dom("roster_current", "roster now");
    if (/deadline|window/i.test(q)) return dom("calendar", "deadlines");
    if (/all-play|standings|leads the league|\brecord\b/i.test(q)) return dom("standings", "standings now");
    if (/waiver|dropped|claim/i.test(q)) return dom("rules_current", "current rules");
    return none("now-question not matched to a matrix domain");
  }
  if (cat === "REC") {
    if (/\btitles?\b|champion|finish|toilet|won the/i.test(q)) return dom("finishes", "titles and finishes");
    return dom("standings", "season records");
  }
  return none("category is not mapped to a matrix domain");
}

// Season list and mode for a resolved domain id. `rules` resolves to rules_current or rules_at_date.
export function resolveDomainSeasons(c, domainId, currentSeason = DEFAULT_CURRENT_SEASON) {
  const q = String(c.question || "");
  const yrs = seasonsInQuestion(q, currentSeason);
  let id = domainId;
  if (id === "rules") {
    const past = yrs.some((y) => y < currentSeason) || /\b(when did|did|was|were|before|first|began|started)\b/i.test(q);
    id = past ? "rules_at_date" : "rules_current";
  } else if (c.p1_expected === "cite" && (id === "extension_price_current" || id === "cap_penalty_current" || id === "cap_penalty_history") && yrs.some((y) => y < currentSeason)) {
    id = "rules_at_date";     // a past-era question whose expected P1 behavior is to cite canon's narrative
  }
  const meta = MATRIX.get(id);
  if (!meta) return { domain: null };
  let seasons, mode;
  if (meta.kind === "current_only") {
    const past = yrs.filter((y) => y < currentSeason);
    mode = past.length ? "past" : "current";
    seasons = past.length ? past : [currentSeason];
  } else if (c.category === "NOW") {
    mode = "current"; seasons = [currentSeason];
  } else if (yrs.length) {
    mode = "seasons"; seasons = yrs;
  } else {
    const from = id === "finishes" ? 2011 : COVERAGE_FIRST_SEASON;
    mode = "all"; seasons = [];
    for (let y = from; y <= currentSeason; y++) seasons.push(y);
  }
  return { domain: { id, kind: meta.kind, seasons, mode, tools: meta.tools } };
}

// ── Golden detection ────────────────────────────────────────────────────────────────────────────
export function detectGolden(c) {
  const ea = c.expected_answer;
  if (ea && typeof ea === "object" && !Array.isArray(ea)) {
    const keys = Object.keys(ea);
    if (keys.length && keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)) && keys.every((k) => typeof ea[k] === "string" && /^era_[a-z0-9_]+/.test(ea[k]))) return { kind: "era" };
    if (keys.length && keys.every((k) => POSITION_KEYS.has(k)) && keys.every((k) => typeof ea[k] === "string" && /Schedule \d: \+\d+K\/\+\d+K/.test(ea[k]))) return { kind: "extension" };
  }
  const text = typeof ea === "string" ? ea : ea && typeof ea === "object" ? JSON.stringify(ea) : "";
  if (/toilet bowl/i.test(text) && /\bfinish(?:ed)?\s+\d{1,2}\b|\bplace\s+\d{1,2}\b|\b(?:7th|seventh)\b/i.test(String(c.question || ""))) return { kind: "finish_label" };
  return null;
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────
export function planCase(c, opts = {}) {
  const currentSeason = Number.isInteger(opts.currentSeason) ? opts.currentSeason : DEFAULT_CURRENT_SEASON;
  const klass = EXPECT_CLASS[c.p1_expected] || "assert";
  const owner = /^owner:(\d{4})$/.exec(c.caller_class);
  const plan = {
    id: c.id, category: c.category, caller: owner ? "owner" : "commish", ownerFranchise: owner ? owner[1] : null,
    p1: c.p1_expected, p1Class: klass, targetPhase: c.target_phase, currentSeason,
    track: null, domain: null, domainReliable: false, noDomainReason: null, golden: null, toolFault: null,
    source: null, missing: [], modelReasons: [], retrieval: false,
  };

  // Domain (informational for CNF/ADV).
  const inf = inferDomain(c);
  if (inf.id) {
    const rs = resolveDomainSeasons(c, inf.id, currentSeason);
    if (rs.domain) { plan.domain = { ...rs.domain, basis: inf.basis }; plan.domainReliable = !INFORMATIONAL_CATEGORIES.includes(c.category); }
  } else plan.noDomainReason = inf.reason;

  if (klass === "refuse") {
    if (owner) { plan.track = "boundary"; return plan; }
    plan.track = "informational";
    plan.modelReasons = ["a commissioner-class refusal needs the model to choose a refusal state"];
    return plan;
  }
  if (owner) {
    plan.track = "owner_self";
    plan.missing = ["the owner adapter (Phase 4): Phase 1 refuses every owner caller at the boundary, so a self-scoped owner answer cannot be produced or graded"];
    return plan;
  }
  if (klass === "injection") { plan.track = "injection"; plan.modelReasons = ["whether a real model follows the planted instruction"]; return plan; }
  if (klass === "toolfail") {
    plan.track = "toolfail";
    const ea = c.expected_answer;
    plan.toolFault = classifyFault(ea && typeof ea === "object" ? ea.injected_fault : "");
    plan.modelReasons = ["the wording of the model's honest decline"];
    return plan;
  }
  if (INFORMATIONAL_CATEGORIES.includes(c.category)) {
    plan.track = "informational";
    plan.modelReasons = ["a composite judgment or conflict explanation with no single machine-checkable truth"];
    return plan;
  }
  const g = detectGolden(c);
  if (g) { plan.track = "golden"; plan.golden = g; plan.modelReasons = ["the model's use of the tool is not graded here"]; return plan; }

  if (plan.domain) {
    if (klass === "gap" || klass === "conflict") {
      plan.track = c.category === "UNA" ? "unanswerable" : "decline";
      plan.modelReasons = ["a real model must choose and word the decline"];
    } else {
      plan.track = "answerable";
      plan.retrieval = c.category === "RUL";
      if (BUNDLED_DOMAINS.has(plan.domain.id)) {
        plan.source = "bundled";
        plan.modelReasons = ["a real model must retrieve, word and cite the rule; the scorer then grades the cite and the key terms"];
      } else {
        plan.source = "route";
        plan.missing = [`live league data behind ${plan.domain.tools.length ? plan.domain.tools.join(", ") : "a Phase 1 tool"} (no offline fixture), plus the model's composition`];
      }
    }
    return plan;
  }

  // No matrix domain.
  if (klass === "gap" || klass === "conflict") {
    plan.track = "nodomain_gap";
    plan.modelReasons = [`only the model's abstention protects this case: ${plan.noDomainReason}`];
  } else {
    plan.track = "nodomain";
    plan.missing = [`${plan.noDomainReason || "no matrix domain"}; no Phase 1 tool serves this question`];
  }
  return plan;
}

// "standings tool times out" -> "timeout"; the fault names come from the bank's expected_answer.injected_fault.
export function classifyFault(text) {
  const t = String(text || "").toLowerCase();
  if (/time[sd]? ?out|timeout/.test(t)) return "timeout";
  if (/older than|stale/.test(t)) return "stale";
  if (/canon_sha|bundled|index/.test(t)) return "canon_mismatch";
  if (/missing hop|lineage/.test(t)) return "missing_hop";
  if (/budget/.test(t)) return "budget";
  return "generic";
}
