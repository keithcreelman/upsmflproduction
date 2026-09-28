// contract_classification.js — classifies a contract's "loaded" modifier (front-loaded /
// back-loaded / flat) from MFL's own contractStatus string, for the Trade War Room's
// loaded-contract limit gate (canon §2.G / §6.G: "Loaded contracts on roster ≤ 5 at all
// times (front + back combined)").
//
// This is deliberately a SEPARATE, standalone module rather than a refactor of the
// contract-history builder already inline in worker/src/index.js (~13073-13230,
// structureOf/yearsFromContract/canonType) — that logic re-derives structure from the
// year-by-year salary breakdown (and can override a stale stored suffix after an
// off-path restructure), and porting its full multi-format parser (Y-tokens, bracket
// format, AAV-tier lists, year_values_json) correctly is a larger, separate undertaking
// than this gate needs. This module instead reads the STORED contractStatus suffix
// directly off the SAME salaries-export overlay the cap gate already fetches — the
// exact field the rest of the app treats as ground truth (project memory:
// mfl_contract_status_vocabulary_changed_2026.md: a compound suffix like "Vet-Ext2-BL"
// since the 2026-08-05 vocabulary change; a bare "FL"/"BL" pre-2026). KNOWN LIMITATION,
// stated plainly rather than silently assumed away: a contract whose true structure
// changed via an off-path restructure but whose stored contractStatus suffix has not
// yet been re-stamped to match will be classified by its (stale) stored suffix here,
// the same way every other consumer of contractStatus in this codebase already is,
// until the two implementations are unified -- tracked as a follow-up, not a hidden gap.
//
// Unlike salary (a real dollar amount that can be genuinely UNKNOWN when blank), the
// loaded/flat determination is a deterministic suffix match: a contractStatus string
// either ends in -FL/-BL or it doesn't. A blank/absent contractStatus is treated as flat
// ("silence is not loaded"), the same "blank ≠ a hidden truth we failed to read" posture
// cap_math.js already takes for a wholly-blank contract's `unknown` years handling — it
// is NOT the same class of ambiguity a blank SALARY is (see trade_cap_authority.js's
// `roster_salary_unresolved` fail-closed check, which this module does not duplicate or
// weaken). The export-level fetch/parse failure modes that genuinely warrant failing the
// whole calculation closed (a missing/malformed rosters or salaries export outright) are
// already handled upstream by readRosters()/readSalaryOverlay() before this is ever
// called; there is no separate "malformed contract status" ambiguity to fail closed on
// at the per-player level for THIS specific field.
//
// Pure functions only -- no fetch, no DOM, no D1.

const s = (v) => String(v == null ? "" : v).trim();

// "" = flat / not loaded. "FL" | "BL" = loaded, either direction -- both count toward the
// 5-contract cap identically (canon: "combined front-loaded + back-loaded").
const LOADED_SUFFIX_RE = /-(FL|BL)$/i;
const LOADED_BARE_RE = /^(FL|BL)$/i;

/**
 * @param contractStatus  the raw MFL contractStatus string for one player (may be null/blank).
 * @returns "FL" | "BL" | ""  ("" covers both a genuinely flat contract and a blank/unreadable
 *          status -- see the module header for why blank is not treated as a separate
 *          "malformed" case for this specific field).
 */
export function classifyLoaded(contractStatus) {
  const status = s(contractStatus);
  if (!status) return "";
  const suffixMatch = LOADED_SUFFIX_RE.exec(status);
  if (suffixMatch) return suffixMatch[1].toUpperCase();
  if (LOADED_BARE_RE.test(status)) return status.toUpperCase();
  // Any other non-blank, recognized-family status (Vet-FAA, Rookie-Draft, Vet-WW, Vet-ERA,
  // MYM, Tag, a plain Vet-Ext with no -FL/-BL suffix, ...) is legitimately flat. Rookie-
  // Draft rookie contracts in particular never carry an FL/BL suffix in MFL's vocabulary
  // (canon: loaded "attaches to Auction, Extension, and MYAC deals" -- a rookie draft-
  // slot contract's pay schedule isn't a loaded/flat choice), so they correctly fall
  // through here as flat without any special-casing.
  return "";
}

/** true for either direction -- the two count identically toward the 5-contract cap. */
export function isLoaded(contractStatus) {
  return classifyLoaded(contractStatus) !== "";
}
