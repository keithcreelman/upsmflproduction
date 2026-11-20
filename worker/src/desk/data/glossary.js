// Commissioner Desk: league glossary and contract-status tokens (tool 3, glossary.lookup).
// Pure data. Every entry cites a canon anchor (site/m/data/rules.json, built from docs/league_context_v1.md) or a repo
// source file. Nothing here is invented: where canon is silent the entry says so (canon_silent: true) and the
// definition describes only what the code does. tests/ai_desk_tools_knowledge.test.mjs checks that every cited anchor
// exists in the rules index and every cited file exists, and that every status token the code recognizes has an
// entry here (or is listed in INTENTIONALLY_UNDEFINED_TOKENS with a reason).
//
// Numbers in a definition are kept to a minimum on purpose: the composer may state a number only as a fact, so the
// few numbers that matter live in `numbers` (turned into grade-B facts by the tool), not in the prose.

const C = (anchor, note) => ({ type: "canon", anchor, ...(note ? { note } : {}) });
const F = (file, note) => ({ type: "code", file, ...(note ? { note } : {}) });
const D = (file, note) => ({ type: "doc", file, ...(note ? { note } : {}) });
const N = (key, label, value, unit, anchor) => ({ key, label, value, unit, anchor });

// Anchors used more than once.
const A_GF = "s4-2019-cap-penalty-system-overhaul-confirmed-2026-05-08-via-se";
const A_BOWL = "s3-nfl-week-kickoffs-decoded-from-ups-options-widget-schedule-2";
const CLASSIFY = "worker/src/contract_classification.js";
const TAXI = "worker/src/taxi_rule.js";

// ── Status tokens the CODE recognizes ──────────────────────────────────────────────────────────────
// Lower-cased. Source of truth is worker/src/contract_classification.js (KNOWN_STATUS_FAMILY_RE, MYM_FAMILY_RE,
// PLAIN_EXT_RE) plus worker/src/taxi_rule.js. The test parses that source and fails if the code gains a token
// that this list (and therefore the glossary) does not know about.
export const CODE_RECOGNIZED_STATUS_TOKENS = Object.freeze([
  "vet-faa", "rookie-faa", "rookie-draft", "rookie-ww", "vet-ww", "ww",
  "vet-ext", "vet-ext1", "vet-ext2", "rookie-ext1", "rookie-ext2",
  "vet-era", "veteran", "rookie", "rookie/veteran", "tag", "franchise tag",
  "vet-mym", "rookie-mym", "vet-ww-mym", "fl", "bl",
]);

// Tokens the code recognizes that the glossary deliberately does not define, with the reason. Everything else in
// CODE_RECOGNIZED_STATUS_TOKENS must resolve to a glossary entry.
export const INTENTIONALLY_UNDEFINED_TOKENS = Object.freeze({
  "rookie/veteran": "Recognized by the loaded-contract classifier for legacy rows. Canon never defines it, and no source says what produced it, so the desk does not explain it.",
});

// ── Entries ────────────────────────────────────────────────────────────────────────────────────────
// { id, term, aliases[], kind: "status_token" | "term", definition, canon_silent, sources[], caveat?, numbers?[] }
export const GLOSSARY_ENTRIES = [
  // ---- contract-status tokens -------------------------------------------------------------------
  { id: "st_rookie_draft", term: "Rookie-Draft", aliases: ["rookie draft status", "rookie-draft contract"], kind: "status_token",
    definition: "Contract status of a player taken in the UPS Rookie Draft, still on his original rookie deal. Taxi-cut logic treats exactly this status (or the older spelling Rookie) as never released, because a release wipes the status and a re-acquisition writes a new one.",
    canon_silent: false, sources: [C("s1-b2"), F(TAXI, "taxiCutVerdict")] },
  { id: "st_rookie", term: "Rookie", aliases: ["rookie status", "rookie contract status"], kind: "status_token",
    definition: "Older spelling of the rookie contract status (taxi code calls it the pre-2026 spelling of Rookie-Draft). Canon also uses plain Rookie for an expired rookie deal after the rollover, and for an in-season rookie pickup that the commissioner converts from WW at year end.",
    canon_silent: false, sources: [C("s1-a3"), C("s1-a4"), F(TAXI, "taxiCutVerdict")] },
  { id: "st_veteran", term: "Veteran", aliases: ["plain veteran", "veteran status"], kind: "status_token",
    definition: "The older generic veteran status. The 2026 scheme writes compound statuses instead (Vet-FAA, Vet-ERA, Vet-WW, Vet-Ext...), and canon says Vet-FAA and Vet-ERA are deliberately distinct from plain Veteran.",
    canon_silent: false, sources: [C("s1-a2"), C("s1-a3"), F(CLASSIFY, "KNOWN_STATUS_FAMILY_RE")] },
  { id: "st_vet_faa", term: "Vet-FAA", aliases: ["faa contract", "free agent auction contract"], kind: "status_token",
    definition: "Status written for a Free Agent Auction win: a single-season veteran contract written automatically at the win, parallel to Vet-ERA. Its length can then be changed by a MYAC.",
    canon_silent: false, sources: [C("s1-a2"), C("s2-t1-2"), C("s1-c2")] },
  { id: "st_vet_era", term: "Vet-ERA", aliases: ["era contract", "expired rookie auction contract"], kind: "status_token",
    definition: "Status written for an Expired Rookie Auction win: a single-season contract at the winning bid, distinct from Veteran and Rookie. A MYAC is how its length is chosen, and a pre-trade extension is blocked while that MYAC window is open.",
    canon_silent: false, sources: [C("s1-a3")] },
  { id: "st_rookie_faa", term: "Rookie-FAA", aliases: [], kind: "status_token",
    definition: "Canon does not define Rookie-FAA. The loaded-contract classifier recognizes it as a status family next to Vet-FAA; nothing in canon says when it is written.",
    canon_silent: true, sources: [F(CLASSIFY, "KNOWN_STATUS_FAMILY_RE")] },
  { id: "st_vet_ww", term: "Vet-WW", aliases: ["vet ww", "veteran waiver contract"], kind: "status_token",
    definition: "Contract of a veteran picked up in season by blind bid or first-come, first-serve. Every FCFS add is one single-season contract at a flat low salary with no bid.",
    canon_silent: false, sources: [C("s1-a4"), C("s1-a5"), C("s2-t1-6")],
    numbers: [N("fcfs_salary", "FCFS flat salary", 1000, "usd", "s1-a5")] },
  { id: "st_rookie_ww", term: "Rookie-WW", aliases: ["rookie ww"], kind: "status_token",
    definition: "Same as Vet-WW, for an NFL rookie picked up in season. The player stays WW through the season, and the commissioner converts him to Rookie at year end so he enters the Expired Rookie Auction path.",
    canon_silent: false, sources: [C("s1-a4"), C("s1-a5")] },
  { id: "st_ww", term: "WW", aliases: ["waiver wire contract", "ww contract"], kind: "status_token",
    definition: "The in-season waiver contract type, for every blind-bid or FCFS pickup whatever the player's NFL status. The winning bid becomes his salary for the current season.",
    canon_silent: false, sources: [C("s1-a4"), C("s1-a5")] },
  { id: "st_ext1", term: "Vet-Ext1", aliases: ["ext1", "rookie-ext1", "ext 1", "one-year extension"], kind: "status_token",
    definition: "Status token of a contract extended for a single year. Ext1 is also the contract_type value of a one-year extension in canon's extension rule. It takes no FL or BL suffix from the extension itself (one year has no salary curve), so a plain Ext1 is always flat. A later restructure can append a suffix.",
    canon_silent: false, sources: [C("s1-c4"), C("s1-c2"), C("s1-c5-1")] },
  { id: "st_ext2", term: "Vet-Ext2", aliases: ["ext2", "rookie-ext2", "ext 2", "two-year extension"], kind: "status_token",
    definition: "Status token of a contract extended for two years. Ext2 is also the contract_type value of a two-year extension in canon's extension rule. Equal years stay plain Ext2; a higher first year posts as Ext2-FL and a lower first year as Ext2-BL.",
    canon_silent: false, sources: [C("s1-c4"), C("s1-c2")] },
  { id: "st_vet_ext_bare", term: "Vet-Ext", aliases: ["ext"], kind: "status_token",
    definition: "Canon names the extension types Ext1 and Ext2 only. The code also accepts a bare Vet-Ext; canon does not say when that form is written.",
    canon_silent: true, sources: [F(CLASSIFY, "KNOWN_STATUS_FAMILY_RE"), C("s1-c4")] },
  { id: "st_vet_mym", term: "Vet-MYM", aliases: ["veteran-mym", "veteran mym"], kind: "status_token",
    definition: "Veteran contract converted by a Mid-Year Multi: the same salary over a longer length, and it can never be loaded. Canon calls this origin sub-type Veteran-MYM; the stored string follows the code's exact list.",
    canon_silent: false, sources: [C("s1-c3"), F(CLASSIFY, "MYM_FAMILY_RE")],
    caveat: "The code accepts only an exact list of MYM strings; a string like Vet-Gibberish-MYM is not recognized." },
  { id: "st_rookie_mym", term: "Rookie-MYM", aliases: ["mym-rookie", "rookie mym"], kind: "status_token",
    definition: "Mid-Year Multi applied to an in-season pickup who is an NFL rookie. It keeps his Expired Rookie Auction eligibility when the contract expires. Canon calls this sub-type MYM-Rookie.",
    canon_silent: false, sources: [C("s1-c3"), F(CLASSIFY, "MYM_FAMILY_RE")] },
  { id: "st_vet_ww_mym", term: "Vet-WW-MYM", aliases: ["ww-mym", "ww mym"], kind: "status_token",
    definition: "Mid-Year Multi applied to an in-season waiver or FCFS pickup who is not an NFL rookie. Canon calls this sub-type WW-MYM.",
    canon_silent: false, sources: [C("s1-c3"), F(CLASSIFY, "MYM_FAMILY_RE")] },
  { id: "st_fl_bl", term: "FL / BL suffix", aliases: ["fl", "bl", "-fl", "-bl", "fl suffix", "bl suffix"], kind: "status_token",
    definition: "A trailing suffix marking a loaded contract: FL (front-loaded) when the first year pays more than the contract's average, BL (back-loaded) when it pays less. It is set at signing, extension or restructure. The label can persist after the contract's shape changes, so the year-by-year schedule outranks it.",
    canon_silent: false, sources: [C("s1-c2"), C("s1-c4"), C("s1-c5-1"), F(CLASSIFY, "resolveLoadedStatus")],
    caveat: "Archive labels can disagree with salaries (LR-08 in docs/ai_desk/LEAGUE_RECORD_BACKLOG.md); the desk does not reclassify history." },
  { id: "st_tag", term: "Tag", aliases: ["tagged", "franchise tag", "tag status"], kind: "status_token",
    definition: "A tag keeps an expiring player. Each team gets one offense tag and one defense or special-teams tag per year; the old Franchise and Transition naming is gone. An early lock-in is final and tradable.",
    canon_silent: false, sources: [C("s1-c8"), F(CLASSIFY, "KNOWN_STATUS_FAMILY_RE")] },

  // ---- league terms -----------------------------------------------------------------------------
  { id: "t_mym", term: "MYM (Mid-Year Multi)", aliases: ["mym", "mid-year multi", "mid year multi"], kind: "term",
    definition: "Converts an existing single-season contract into a multi-year deal at the same salary, with no raise. It can never be loaded. In-season pickups have a short window from acquisition, and the clock does not reset on a trade.",
    canon_silent: false, sources: [C("s1-c3"), C("s2-t3-2")],
    numbers: [N("mym_max_per_season", "Maximum MYMs per team per season", 4, "count", "s1-c3")] },
  { id: "t_myac", term: "MYAC (Multi-Year Auction Contract)", aliases: ["myac", "multi-year auction contract"], kind: "term",
    definition: "A submission after an auction win or pre-deadline waiver pickup that converts the single-season default into a longer veteran or loaded contract, due by the September contract deadline.",
    canon_silent: false, sources: [C("s1-c2"), C("s2-t3-1")] },
  { id: "t_era", term: "ERA (Expired Rookie Auction)", aliases: ["era", "expired rookie auction"], kind: "term",
    definition: "The auction for a rookie whose contract expired and was not extended by the rookie extension deadline. It overlaps Rookie Draft weekend, and the winner gets a Vet-ERA contract.",
    canon_silent: false, sources: [C("s1-a3"), C("s1-d4")],
    numbers: [N("era_start_bid", "ERA starting bid", 1000, "usd", "s1-a3")] },
  { id: "t_faa", term: "FA Auction (FAA)", aliases: ["faa", "fa auction", "free agent auction"], kind: "term",
    definition: "The free-agent auction held the last weekend of July: proxy bidding with a lock window, and a minimum and maximum number of nominations per window. A win writes a Vet-FAA contract.",
    canon_silent: false, sources: [C("s1-a2"), C("s2-t1-2")] },
  { id: "t_fcfs", term: "FCFS (first-come, first-serve)", aliases: ["fcfs", "first come first serve", "first-come first-serve"], kind: "term",
    definition: "Free agency that opens after the Sunday morning waiver run until each player's NFL kickoff. Every FCFS add is one flat-salary single-season WW contract with no bid.",
    canon_silent: false, sources: [C("s1-a5"), C("s2-t1-6")],
    numbers: [N("fcfs_salary", "FCFS flat salary", 1000, "usd", "s1-a5")] },
  { id: "t_blind_bid", term: "Blind bid waivers", aliases: ["blind bid", "waivers", "bbid", "waiver run"], kind: "term",
    definition: "The in-season waiver process: conditional blind bidding, where the bid becomes the player's salary for the current season and the highest bid in a group wins.",
    canon_silent: false, sources: [C("s1-a4")] },
  { id: "t_extension", term: "Extension", aliases: ["extend", "extensions", "ext1/ext2", "extension contract", "contract extension"], kind: "term",
    definition: "The contract family for a player in the final year of his contract: a one-year (Ext1) or two-year (Ext2) extension. Ext1 and Ext2 are the contract_type values in canon; the contract string then carries the related status token Vet-Ext1 or Vet-Ext2. Only the extension years are repriced forward, and the new TCV is the sum of the remaining year salaries.",
    canon_silent: false, sources: [C("s1-c4"), C("s2-t3-3")],
    caveat: "Canon's contract-type table says Ext1 and Ext2 are not separate contract types, which conflicts with its extension rule. The commissioner ruled that Extension is the family and Ext1 and Ext2 are its contract_type values; the correction is proposed in docs/ai_desk/EXT1_CANON_PROPOSAL.md." },
  { id: "t_restructure", term: "Restructure", aliases: ["restructures"], kind: "term",
    definition: "Re-slots the remaining year salaries (front-load or back-load) without extending. It runs from the offseason until the September contract deadline, is banned mid-season, and counts toward the loaded-contract cap. It keeps AAV verbatim and re-bases TCV and GTD to the remaining years.",
    canon_silent: false, sources: [C("s1-c5"), C("s1-c5-1"), C("s2-t3-4")],
    numbers: [N("restructure_max_per_season", "Maximum restructures per team per season", 3, "count", "s1-c5")] },
  { id: "t_loaded", term: "Loaded contract", aliases: ["loaded", "front-loaded", "back-loaded", "front loaded", "back loaded", "loaded contracts"], kind: "term",
    definition: "A contract whose years are not equal: front-loaded (first year above the average) or back-loaded (first year below it, with a minimum share of the total in year one). Total value is preserved. A roster may hold only a limited number, and a taxi or one-year contract is never loaded.",
    canon_silent: false, sources: [C("s1-c2"), C("s1-c4"), C("s1-c5")],
    numbers: [N("loaded_cap", "Maximum loaded contracts per roster", 5, "count", "s1-c2")] },
  { id: "t_tcv", term: "TCV (total contract value)", aliases: ["tcv", "total contract value"], kind: "term",
    definition: "The total contract value token in contractInfo. It is fixed when the contract is created or extended; it is the sum of the year salaries, not the average times the years. A restructure re-bases it to the remaining years.",
    canon_silent: false, sources: [C("s6-c1"), C("s1-c4"), C("s1-c5-1"), F(CLASSIFY, "parseTCV")] },
  { id: "t_aav", term: "AAV (average annual value)", aliases: ["aav", "average annual value"], kind: "term",
    definition: "The AAV token in contractInfo. Never recompute it as TCV divided by length: a restructure carries it over verbatim (it can hold two values), and it changes only at an extension.",
    canon_silent: false, sources: [C("s1-c5-1"), D("AGENTS.md", "contract rules")] },
  { id: "t_cl", term: "CL (contract length)", aliases: ["cl", "contract length"], kind: "term",
    definition: "The contract length token in contractInfo: the total length of the contract in years. Contract year (years remaining) in MFL is a different field and counts down.",
    canon_silent: true, sources: [F(CLASSIFY, "parseContractLength"), D("AGENTS.md", "MFL contractYear is years remaining")] },
  { id: "t_gtd", term: "GTD", aliases: ["gtd", "guaranteed", "guaranteed money"], kind: "term",
    definition: "A guaranteed-amount token in contractInfo. Canon shows it in a worked record and says a restructure recomputes it as a share of the new TCV; canon gives no standalone definition.",
    canon_silent: true, sources: [C("s1-c5-1"), F(CLASSIFY, "header example of a contractInfo string with a GTD token; the classifier never reads it")] },
  { id: "t_cap_penalty", term: "Cap penalty (drop penalty)", aliases: ["cap penalty", "drop penalty", "dead cap", "cut penalty", "release penalty"], kind: "term",
    definition: "The cap charge for cutting a player: a share of the contract's total value minus the salary already earned, earned per completed NFL week. Some cuts are cap-free. The charged calculator in the worker is the only authority.",
    canon_silent: false, sources: [C("s1-d1"), C("s6-c1"), C("s6-c3"), D("docs/ai_desk/TOOL_CATALOG.md", "charged calculator is the authority")],
    numbers: [N("penalty_share", "Share of TCV in the penalty formula", 75, "pct", "s1-d1")] },
  { id: "t_cap_free_cut", term: "Cap-free cut", aliases: ["cap free cut", "cap-free", "free cut"], kind: "term",
    definition: "A cut with no penalty: certain categories such as small single-season deals, a player still taxi-eligible just before the cut, and a genuine retirement during the FA Auction. The categories are listed in canon.",
    canon_silent: false, sources: [C("s1-d2"), C("s6-c2")] },
  { id: "t_amari_cooper", term: "Amari Cooper Rule", aliases: ["amari cooper rule", "retired player cut"], kind: "term",
    definition: "A retired player may be cut cap-free during the FA Auction and the freed salary is available to bid at once. Retirement must be genuine and commissioner-verified; injury does not qualify.",
    canon_silent: false, sources: [C("s1-d2")] },
  { id: "t_calvin_johnson", term: "Calvin Johnson Rule", aliases: ["calvin johnson rule", "comp pick"], kind: "term",
    definition: "A commissioner-awarded compensation draft pick when a top-tier player retires. It is added on top of existing picks, and cannot be traded until the following season.",
    canon_silent: false, sources: [C("s2-t1-10"), C("s1-d2")] },
  { id: "t_taxi", term: "Taxi squad", aliases: ["taxi", "taxi squad", "taxi eligible", "taxi-eligible"], kind: "term",
    definition: "Holding squad for rookies picked in Round 2 or later, for their first league years. Taxi salary does not count against the cap. Eligibility ends at a permanent promotion, a release, or after the eligibility window.",
    canon_silent: false, sources: [C("s1-b2"), F(TAXI, "taxiEligibility")],
    numbers: [N("taxi_max_size", "Maximum taxi squad size", 10, "count", "s1-b2")] },
  { id: "t_callup", term: "Taxi call-up", aliases: ["call-up", "call up", "callup", "temporary call-up", "taxi callup"], kind: "term",
    definition: "A temporary one-week promotion from taxi. Each player has a limited number of call-up weeks across his whole window, counted across seasons and trades; the next one is a permanent promotion that ends eligibility.",
    canon_silent: false, sources: [C("s1-b2"), F(TAXI, "TAXI_CALLUPS_MAX")],
    numbers: [N("callups_allowed", "Temporary call-up weeks allowed per player", 3, "count", "s1-b2")] },
  { id: "t_ir", term: "Injured reserve (IR)", aliases: ["ir", "injured reserve"], kind: "term",
    definition: "Roster slot for NFL IR designations (and a few legacy categories). IR players do not count against the active roster maximum or the roster minimum, and carry partial cap relief.",
    canon_silent: false, sources: [C("s1-b3")] },
  { id: "t_roll_forward", term: "Annual roll-forward", aliases: ["rollover", "roll forward", "roll-forward", "contract rollover"], kind: "term",
    definition: "In the March window every contract loses one year remaining and salaries advance to the next year's value. The prior year's salary becomes fully earned.",
    canon_silent: false, sources: [C("s1-c7")] },
  { id: "t_contract_deadline", term: "Contract deadline", aliases: ["september deadline", "contract deadline", "ups contract deadline"], kind: "term",
    definition: "The September deadline for contract choices (MYAC, restructure, standard extensions): the last Sunday before NFL Week 1. Use calendar.events for the exact date of a given season.",
    canon_silent: false, sources: [C("s1-c2"), C("s1-c4")] },
  { id: "t_rookie_option", term: "First-round rookie option", aliases: ["rookie option", "option year", "1st round option"], kind: "term",
    definition: "From the 2025 draft class, a first-round pick has a fourth option year at his original final-year salary plus a fixed amount. It must be decided by the September deadline of his final original season.",
    canon_silent: false, sources: [C("s1-c6"), C("s1-a1")],
    numbers: [N("option_salary_add", "Option-year add-on to the original final-year salary", 5000, "usd", "s1-c6")] },
  { id: "t_dispersal", term: "Dispersal draft", aliases: ["dispersal", "dispersal draft"], kind: "term",
    definition: "When a new owner replaces an outgoing one, the league may opt in to pool the outgoing roster and picks and redraft them. Players keep their existing contracts.",
    canon_silent: false, sources: [C("s1-a7")] },
  { id: "t_gf", term: "GF (grandfathered) tag", aliases: ["gf", "grandfathered", "grandfather clause", "gf tag"], kind: "term",
    definition: "Per canon, contracts active at the end of 2018 with enough years remaining were grandfathered into the old flat penalty rule and tagged GF in contractInfo until the contract was touched.",
    canon_silent: false, sources: [C(A_GF), D("docs/ai_desk/LEAGUE_RECORD_BACKLOG.md", "LR-02, LR-03")],
    caveat: "The archive shows GF tags on contracts created in 2019, which conflicts with canon's definition. Never assert GF status from the tag alone; show the conflict." },
  { id: "t_toilet_bowl", term: "Toilet Bowl (Hawktuah Bowl)", aliases: ["toilet bowl", "hawk tuah bowl", "hawktuah bowl", "toilet"], kind: "term",
    definition: "The consolation bracket. Canon says its winner picks first in the next rookie draft (the draft order is inverse to the playoff bracket) and names the bowl the Hawktuah Bowl.",
    canon_silent: false, sources: [C("s1-a1"), C(A_BOWL)] },
  { id: "t_final_finish", term: "Final finish label", aliases: ["final finish", "final_finish", "finish 7", "seventh place"], kind: "term",
    definition: "In the final-standings data a finish of seven means Toilet Bowl champion, never seventh place; the finishes after it are the rest of the Toilet bracket. Canon does not define the numbering; the desk's label map does.",
    canon_silent: true, sources: [D("docs/ai_desk/DESK_CONTRACT.md", "finish label map"), D("docs/ai_desk/LEAGUE_RECORD_BACKLOG.md", "LR-04")] },
  { id: "t_cap_floor", term: "Cap floor", aliases: ["salary floor", "cap floor", "auction sleeping"], kind: "term",
    definition: "A minimum payroll that must be met by the end of the auction or by roster cut-down day. It applies only to the auction and preseason period. A shortfall is charged as an immediate cap hit.",
    canon_silent: false, sources: [C("s6-a2")],
    numbers: [N("cap_floor", "Cap floor", 260000, "usd", "s6-a2")] },
];

// ── Normalization shared by the index builder and the tool ─────────────────────────────────────────
export function normalizeGlossaryKey(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[_\s]+/g, " ").trim();
}
export function compactGlossaryKey(s) { return normalizeGlossaryKey(s).replace(/[^a-z0-9]/g, ""); }
