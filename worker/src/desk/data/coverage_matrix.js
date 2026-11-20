// Commissioner Desk: the static "what data exists" matrix (tool 4, coverage.check). Pure data.
// Built from docs/ai_desk/TOOL_CATALOG.md (sections 2 to 4) and docs/ai_desk/LEAGUE_RECORD_BACKLOG.md (LR-01 to LR-16).
// It answers "can the desk answer a question about domain X in season Y at all?" before any other tool runs, so a
// confident wrong answer is never composed from data that does not exist.
//
// A cell is { level: "full" | "partial" | "none", reason, phase_needed, lr_id, gap_ids, note }.
//   level         what Phase 1 can honestly answer. "full" = a Phase 1 tool answers it from a current record.
//   reason        one of contract.js GAP_REASONS, or null when level is "full".
//   phase_needed  P1 = available in Phase 1 (or the Phase 1 limit is the whole story), S1..S4 = a League Record slice
//                 (docs/ai_desk/LEAGUE_RECORD_BACKLOG.md), F = a later private store, X = excluded by policy.
//   lr_id         the League Record backlog item behind the gap, or null.
//   gap_ids       older gap-plan ids (GAP-xx) behind the cell.
//   note          one plain-English line. No numbers the model could repeat without a fact.
//
// Level "full" is never assigned to pick lineage, contract history before 2026, owner history, or rules by date.
// The test enforces that.

import { GAP_REASONS } from "../contract.js";

export const COVERAGE_FIRST_SEASON = 2010;   // the league's first season on record
export const COVERAGE_LAST_SEASON = 2026;    // the last season this matrix was written for; later seasons answer "stale"
export const COVERAGE_LEVELS = Object.freeze(["full", "partial", "none"]);
export const COVERAGE_PHASES = Object.freeze(["P1", "S1", "S2", "S3", "S4", "F", "X"]);

const cell = (level, reason, phase_needed, note, lr_id = null, gap_ids = []) => ({ level, reason, phase_needed, lr_id, gap_ids, note });
const span = (from, to, c) => ({ from, to, ...c });
const FULL = (note, extra = {}) => cell("full", null, "P1", note, extra.lr_id || null, extra.gap_ids || []);

// Domains are either "current_only" (the desk answers from the live state; any other season or date is a gap) or "seasonal"
// (spans of seasons). A current_only domain has `current` (the current season) and `past` (any other season).
export const COVERAGE_MATRIX_SOURCE = [
  { id: "rules_current", label: "Current rules", kind: "current_only", tools: ["rules.search", "rules.get"],
    current: FULL("Canon rules are searchable and citable at the current canon version."),
    past: cell("none", "unsupported_as_of", "S4", "Only today's canon text exists as a record. Rules in force on a past date need the rule-version table.", "LR-16") },

  { id: "rules_at_date", label: "Rules in force on a past date", kind: "seasonal", tools: ["rules.search"],
    spans: [
      span(2010, 2012, cell("none", "NO_RECORD", "S4", "The first rulebook and the early manifesto are not on file.", "LR-16")),
      span(2013, 2026, cell("partial", "partial_coverage", "S4", "Canon's history section narrates rule changes, some dated only to a year or two. It is not a dated rule table, so cite the narrative and never state what applied on an exact day.", "LR-16")),
    ] },

  { id: "rules_by_date", label: "Dated rule-version table", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "S4", "No rule-version table with effective dates exists yet.", "LR-16"))] },

  { id: "roster_current", label: "Current roster and contracts", kind: "current_only", tools: ["roster.current"],
    current: FULL("Live roster and contract strings from the Roster Workbench."),
    past: cell("none", "unsupported_as_of", "S2", "A roster on a past date is in the archive, but no Phase 1 tool reads it.", "LR-08") },

  { id: "cap_current", label: "Current cap position", kind: "current_only", tools: ["cap.position"],
    current: FULL("Cap used and room, this season and next, from live data and the cap math module."),
    past: cell("none", "unsupported_as_of", "S2", "A cap position on a past date needs the contract state on that date plus the adjustment ledger.", "LR-08") },

  { id: "cap_penalty_current", label: "Current drop-penalty quote", kind: "current_only", tools: ["cap.penalty_quote"],
    current: FULL("Quotes use the charged calculator under current rules. A quote is refused when the earned salary would be a guess or a tag cut sits near the auction."),
    past: cell("none", "unsupported_as_of", "S4", "A penalty under the rules of a past era needs one era-aware calculator; the unused library is not wired in.", "LR-16") },

  { id: "cap_penalty_history", label: "Cap penalties charged in past seasons", kind: "seasonal", tools: ["cap.adjustments"],
    spans: [
      span(2010, 2019, cell("none", "NO_RECORD", "S4", "Penalties before the ledger are derived, not recorded.", "LR-16")),
      span(2020, 2025, cell("partial", "partial_coverage", "S4", "Booked penalties appear in the adjustment ledger. What the rule of the day should have charged is not computed.", "LR-16")),
      span(2026, 2026, cell("partial", "partial_coverage", "S4", "This season's booked penalties are in the ledger. A recomputation under an earlier era is not available.", "LR-16")),
    ] },

  { id: "cap_adjustments", label: "Cap adjustments and penalties booked", kind: "seasonal", tools: ["cap.adjustments"],
    spans: [
      span(2010, 2016, cell("none", "NO_RECORD", "S2", "No adjustment ledger exists for these seasons.", "LR-08")),
      span(2017, 2019, cell("partial", "partial_coverage", "S2", "Adjustments here are derived or incomplete. The ledger proper starts later.", "LR-08")),
      span(2020, 2025, cell("partial", "partial_coverage", "S2", "A ledger exists but is partial; traded-cap rows are recorded only from the start of this range.", "LR-10")),
      span(2026, 2026, FULL("The ledger for this season is complete.")),
    ] },

  { id: "extension_price_current", label: "Extension price under current rules", kind: "current_only", tools: ["extension.price"],
    current: FULL("Priced by the extension pricing module, which matches canon."),
    past: cell("none", "unsupported_as_of", "S4", "Pricing under the rules of a past season needs the dated rule table.", "LR-16") },

  { id: "calendar", label: "Deadlines and windows", kind: "seasonal", tools: ["calendar.events"],
    spans: [
      span(2010, 2010, cell("none", "NO_RECORD", "P1", "The event calendar starts after the league's first season.")),
      span(2011, 2025, FULL("The event calendar covers this season.")),
      span(2026, 2026, cell("partial", "conflict_in_canon", "S4", "Canon contradicts itself on the Week 1 date, the trade-deadline wording, and which rookie round's taxi cuts are cap-free. The tool shows both versions and never picks one.", "LR-15")),
    ] },

  { id: "standings", label: "Standings and playoff brackets", kind: "seasonal", tools: ["standings.get"],
    spans: [
      span(2010, 2010, cell("partial", "partial_coverage", "P1", "The first season's standings are disputed in the source data.", null, ["GAP-03", "GAP-17"])),
      span(2011, 2011, cell("partial", "partial_coverage", "P1", "Standings are solid, but all-play totals fit neither convention and are unverified.", "LR-13")),
      span(2012, 2026, FULL("Standings and brackets are recorded for this season.")),
    ] },

  { id: "finishes", label: "Final finishes and titles", kind: "seasonal", tools: ["history.finishes"],
    spans: [
      span(2010, 2010, cell("partial", "partial_coverage", "P1", "Disputed season, and there was no Toilet Bowl title. Show the labeled finish and the dispute.", "LR-04", ["GAP-03", "GAP-17"])),
      span(2011, 2014, FULL("Final finishes are recorded. Use the label map: finish seven is the Toilet Bowl champion, not seventh place.", { lr_id: "LR-04" })),
      span(2015, 2015, cell("partial", "partial_coverage", "P1", "The final standings are defective: two franchises share one finish and another finish is missing. Flag it.", "LR-04")),
      span(2016, 2025, FULL("Final finishes are recorded. Use the label map: finish seven is the Toilet Bowl champion, not seventh place.", { lr_id: "LR-04" })),
      span(2026, 2026, cell("none", "NO_RECORD", "P1", "The season is in progress, so there are no final finishes yet.")),
    ] },

  { id: "player_transactions", label: "A player's trades, adds, drops, draft", kind: "seasonal", tools: ["player.transactions"],
    spans: [
      span(2010, 2017, cell("partial", "partial_coverage", "S2", "Waiver-type moves are missing, multi-player drops are incomplete, and picks appear as tokens that are not traced.", "LR-12", ["GAP-09", "GAP-15"])),
      span(2018, 2025, cell("partial", "partial_coverage", "S2", "Multi-player drops are incomplete and picks appear as tokens that are not traced. Trades between the deadline and the March rollover are outside the archive.", "LR-11", ["GAP-15"])),
      span(2026, 2026, cell("partial", "partial_coverage", "S2", "Multi-player drops are incomplete and picks appear as tokens that are not traced.", "LR-12", ["GAP-15"])),
    ] },

  { id: "pick_lineage", label: "Who held a draft pick, its slot, and the player taken", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "S1", "Pick slots are not stored, and deriving them from final standings matched only about one pick in ten. Name the round and the original franchise only, and say the slot is not on record.", "LR-01", ["GAP-15"]))] },

  { id: "draft_order", label: "Rookie draft order by season", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "S1", "The real order is not stored per season. Some seasons derive cleanly, but that is unverified and the desk does not rely on it.", "LR-07"))] },

  { id: "contract_timeline", label: "Every version of a contract and why it changed", kind: "seasonal", tools: ["roster.current"],
    spans: [
      span(2010, 2025, cell("none", "NO_RECORD", "S2", "Contract strings are sparse in the archive and extensions and restructures are mostly unrecorded or derived. Abstain and name the source needed.", "LR-02", ["GAP-09"])),
      span(2026, 2026, cell("partial", "partial_coverage", "S2", "Only the current contract is available, plus daily snapshots this season. There is no tool for the history of a contract.", "LR-08")),
    ] },

  { id: "grandfather_tags", label: "Grandfathered (GF) cap-penalty tags", kind: "seasonal", tools: ["glossary.lookup"],
    spans: [span(2010, 2026, cell("none", "conflict_in_canon", "S2", "GF tags exist in the status field of past contracts, some on contracts canon says could not qualify. The glossary explains the term; a tag alone never proves status.", "LR-03", []))] },

  { id: "owner_history", label: "Owner careers across franchises", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "S3", "There is no owner registry. Answer at franchise level only and show the franchise id beside any name.", "LR-14"))] },

  { id: "forum_history", label: "What the league said (forum, Discord, votes)", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "F", "Forum and chat history is not indexed. Only the narrative already written into canon can be cited."))] },

  { id: "owner_private_data", label: "Owner-private data, credentials, messages", kind: "seasonal", tools: [],
    spans: [span(2010, 2026, cell("none", "NO_RECORD", "X", "Never available to the desk, by design."))] },
];

// ── Build-time validation (cheap; runs at import so a bad edit fails every test that loads the module) ───────────
function assertCell(domainId, c) {
  if (!COVERAGE_LEVELS.includes(c.level)) throw new Error(`coverage_matrix: ${domainId} bad level ${c.level}`);
  if (!COVERAGE_PHASES.includes(c.phase_needed)) throw new Error(`coverage_matrix: ${domainId} bad phase ${c.phase_needed}`);
  if (c.level === "full" ? c.reason !== null : !GAP_REASONS.includes(c.reason)) throw new Error(`coverage_matrix: ${domainId} bad reason ${c.reason}`);
  if (typeof c.note !== "string" || !c.note || c.note.length > 400) throw new Error(`coverage_matrix: ${domainId} bad note`);
}
for (const d of COVERAGE_MATRIX_SOURCE) {
  if (d.kind === "current_only") { assertCell(d.id, d.current); assertCell(d.id, d.past); }
  else {
    let prev = COVERAGE_FIRST_SEASON - 1;
    for (const s of d.spans) {
      assertCell(d.id, s);
      if (s.from !== prev + 1 || s.to < s.from) throw new Error(`coverage_matrix: ${d.id} spans must be contiguous from ${COVERAGE_FIRST_SEASON} (at ${s.from})`);
      prev = s.to;
    }
    if (prev !== COVERAGE_LAST_SEASON) throw new Error(`coverage_matrix: ${d.id} spans must end at ${COVERAGE_LAST_SEASON}`);
  }
}

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; }
export const COVERAGE_MATRIX = deepFreeze(COVERAGE_MATRIX_SOURCE);
export const COVERAGE_DOMAIN_IDS = Object.freeze(COVERAGE_MATRIX.map((d) => d.id));
