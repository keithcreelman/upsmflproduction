// contract_classification.js — classifies a contract's "loaded" modifier (front-loaded /
// back-loaded / flat) for the Trade War Room's loaded-contract limit gate (canon §2.G /
// §6.G: "Loaded contracts on roster ≤ 5 at all times (front + back combined)"; "Loaded...
// can never attach to a 1-year deal, a MYM, or a taxi contract").
//
// RULING (2026-09-28, revised): a blank/absent contractStatus is NOT, by itself, proof of
// a flat contract. Loaded/flat is resolved with this priority, matching the SAME
// precedence the contract-history builder already uses elsewhere in this codebase
// (worker/src/index.js ~13073-13230, structureOf/yearsFromContract/canonType — "Keith: a
// restructure... makes it FL even when MFL still stores Vet-FAA"):
//   1. An authoritative, PARSEABLE year-by-year salary schedule (Y-token "Y1-21 Y2-38" or
//      bracket "[14K, 14K, 15K]" format inside contractInfo) is the most trustworthy
//      signal there is — a real, priced schedule, not a guess. Equal every year -> flat,
//      PROVEN. Strictly increasing -> BL. Strictly decreasing -> FL. This OVERRIDES a
//      stale stored suffix, the same way index.js's structureOf() already does.
//   2. A contract whose TOTAL length (CL, parsed from contractInfo's "CL <n>" prefix) is
//      exactly 1 year is flat BY DEFINITION (canon: loaded can never attach to a 1-year
//      deal) — this is independent of contractStatus and never ambiguous.
//   3. A present, non-blank contractStatus with a recognized -FL/-BL suffix (or legacy
//      bare FL/BL) is loaded; any other present, non-blank, recognized-family status
//      (Vet-FAA, Rookie-Draft, Vet-WW, Vet-ERA, MYM, Tag, a plain Vet-Ext with no
//      suffix, ...) is flat.
//   4. Anything left — contractStatus is BLANK/absent AND the contract's total length is
//      2+ years (or unknown) AND no parseable schedule could establish flat/loaded — is
//      genuinely UNRESOLVED. The caller (trade_cap_authority.js) must treat this as
//      `loaded_contracts: unavailable` for the WHOLE loaded-contract block (never guessed
//      either way), while leaving cap/roster/lineup completely unaffected — an unreadable
//      loaded classification must never erase an otherwise-valid cap total.
//
// This is intentionally NOT a full port of index.js's parser: it implements exactly the
// two most reliable, directly-in-contractInfo schedule formats (Y-token, bracket) plus
// the CL/TCV prefix already present in the same string (real example seen in production:
// "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K|GTD: 1K"). It deliberately does NOT implement index.js's
// lower-confidence methods (the AAV comma-tier-list fallback, year_values_json, or the
// even-split GUESS derived purely from TCV/CL with no real per-year evidence) — the
// even-split method in particular is explicitly a LOW-confidence GUESS in index.js's own
// comments, and guessing can never satisfy "provably flat" or "authoritative". A contract
// this module can't resolve via a real schedule, the 1-year rule, or a present status is
// correctly reported unresolved rather than silently guessed at either extreme.
//
// Pure functions only -- no fetch, no DOM, no D1.

const s = (v) => String(v == null ? "" : v).trim();

const LOADED_SUFFIX_RE = /-(FL|BL)$/i;
const LOADED_BARE_RE = /^(FL|BL)$/i;

/** contractStatus alone -> "FL" | "BL" | "" | null (null = blank/unreadable, distinct from
 * "" = present and recognizably flat). Priority 3 in the module header. */
function classifyStatusOnly(contractStatus) {
  const status = s(contractStatus);
  if (!status) return null;
  const suffixMatch = LOADED_SUFFIX_RE.exec(status);
  if (suffixMatch) return suffixMatch[1].toUpperCase();
  if (LOADED_BARE_RE.test(status)) return status.toUpperCase();
  return "";
}

/** contractInfo's "CL <n>" prefix -> integer total contract length, or null if absent/unparseable. */
export function parseContractLength(contractInfo) {
  const info = s(contractInfo);
  const m = /CL\s*(\d+)/i.exec(info);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** contractInfo's "TCV <n>K" prefix -> integer total contract value in dollars, or null. */
export function parseTCV(contractInfo) {
  const info = s(contractInfo);
  const m = /TCV\s*([0-9.]+)\s*K?/i.exec(info);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]) * 1000);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * An authoritative, PARSEABLE per-year salary schedule from contractInfo text.
 * @returns number[] (length >= 2) when a real schedule was found, or null.
 */
export function parseYearSchedule(contractInfo) {
  const info = s(contractInfo);
  if (!info) return null;
  // 1. Y-token format: "Y1-21K Y2-38K Y3-38K" (also accepts "Y1-2K, Y2-2K" with commas).
  const re = /Y(\d+)\s*-\s*([0-9.]+)\s*K?/gi;
  let m; const map = {};
  while ((m = re.exec(info))) map[parseInt(m[1], 10)] = Math.round(parseFloat(m[2]) * 1000);
  const fromTokens = Object.keys(map).map(Number).sort((a, b) => a - b).map((k) => map[k]);
  if (fromTokens.length >= 2) return fromTokens;
  // 2. Bracket format: "[14K, 14K, 15K]".
  const bm = info.match(/\[([^\]]+)\]/);
  if (bm) {
    const arr = bm[1].split(",").map((t) => {
      const n = parseFloat(String(t).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
    });
    if (arr.length >= 2 && arr.every(Number.isFinite)) return arr;
  }
  return null;
}

/**
 * Canon's ACTUAL rule (not a monotonicity heuristic): "Front-loaded = Year 1 salary >
 * AAV; Back-loaded = Year 1 salary < AAV" (AAV = TCV / contract length). Comparing Y1 to
 * the contract's own AAV is robust to a schedule that plateaus after year 1 (e.g. an
 * extension priced [4K, 26K, 26K] -- clearly back-loaded by canon's own Y1-vs-AAV test,
 * even though it is not STRICTLY monotonic every single year, which a naive "every
 * consecutive pair must move the same direction" check would wrongly call unclassifiable).
 * Equal-every-year is still checked directly first (unambiguous, needs no AAV at all).
 *
 * @param years  the parsed per-year schedule (length >= 2).
 * @param tcv    the contract's total value in dollars, or null if unknown.
 * @param cl     the contract's total length in years, or null if unknown (defaults to
 *               years.length when the schedule itself covers the full contract).
 * @returns "FLAT" | "FL" | "BL" | ""  ("" only when Y1 can't be compared to any AAV at all)
 */
export function structureOf(years, tcv, cl) {
  if (!years || years.length < 2) return "";
  if (years.every((v) => v === years[0])) return "FLAT";
  const length = cl || years.length;
  const aav = tcv ? tcv / length : years.reduce((a, b) => a + b, 0) / years.length;
  if (!Number.isFinite(aav) || aav <= 0) return "";
  const y1 = years[0];
  if (y1 > aav) return "FL";
  if (y1 < aav) return "BL";
  return "FLAT";
}

/**
 * @param contractStatus  raw MFL contractStatus (may be blank/null).
 * @param contractInfo    raw MFL contractInfo (may be blank/null) -- read for a parseable
 *                        year-by-year schedule and the "CL <n>" total-length prefix.
 * @returns { loaded: "FL"|"BL"|"", resolved: boolean }
 *   resolved:false means genuinely UNRESOLVED -- the caller must treat the WHOLE
 *   loaded-contract block as unavailable, never guess `loaded` either way in that case
 *   (the `loaded` field is meaningless / "" when resolved is false — never read it then).
 */
export function resolveLoadedStatus(contractStatus, contractInfo) {
  const cl = parseContractLength(contractInfo);
  const tcv = parseTCV(contractInfo);
  // Priority 1: a real, parsed schedule overrides everything, including a stale status --
  // classified by canon's own Y1-vs-AAV rule (see structureOf), not a monotonicity guess.
  const schedule = parseYearSchedule(contractInfo);
  if (schedule) {
    const struct = structureOf(schedule, tcv, cl);
    if (struct === "FLAT") return { loaded: "", resolved: true };
    if (struct === "FL" || struct === "BL") return { loaded: struct, resolved: true };
    // Y1 couldn't be compared to any AAV at all (no TCV and an unusual schedule shape) --
    // fall through to the next priority rather than guess from data this thin.
  }
  // Priority 2: a 1-year contract is flat by canon, independent of contractStatus.
  if (cl === 1) return { loaded: "", resolved: true };
  // Priority 3: a present, non-blank contractStatus is a real signal.
  const fromStatus = classifyStatusOnly(contractStatus);
  if (fromStatus !== null) return { loaded: fromStatus, resolved: true };
  // Priority 4: blank status, no schedule, and either a multi-year or unknown-length
  // contract -- genuinely unresolved. (A blank status with a KNOWN 1-year length was
  // already resolved as flat above, by the canon rule, before we ever get here.)
  return { loaded: "", resolved: false };
}

/** Convenience: true only when resolved AND loaded (never true for an unresolved contract). */
export function isLoaded(contractStatus, contractInfo) {
  const r = resolveLoadedStatus(contractStatus, contractInfo);
  return r.resolved && r.loaded !== "";
}

/**
 * A pre-trade EXTENSION's loaded status, derived from its own priced terms -- DISTINCT
 * from resolveLoadedStatus(). An extension's contractInfo/preview string always carries
 * Year 1 at the player's CURRENT (pre-extension) salary, "never repriced" -- that is a
 * structural fact about how extensions are built, unrelated to whether the NEW money is
 * front- or back-loaded. Comparing Y1 to the whole-contract AAV (as resolveLoadedStatus
 * does for an ordinary roster contract) would misclassify almost every extension, since
 * Y1 differs from the future AAV for a reason that has nothing to do with load shape.
 * The correct comparison excludes the frozen Y1 and looks only at the FUTURE portion
 * (Y2 onward) against the future AAV (new_aav_future when given, else TCV/CL of just the
 * future years). A single future year (a 2-year extension: Y1 frozen + one new year) has
 * no shape to compare and is flat, the same "no shape with < 2 points" rule
 * resolveLoadedStatus applies to a genuine 1-year contract.
 *
 * @param previewContractInfoString  the extension's own priced terms (e.g. from
 *                                   e.preview_contract_info_string).
 * @param newAavFuture               the extension's own future-years AAV, when already
 *                                   known (e.g. e.new_aav_future) -- preferred over
 *                                   re-deriving it from TCV/CL, which would include the
 *                                   frozen Y1 in the average and skew it.
 * @returns { loaded: "FL"|"BL"|"", resolved: boolean }
 */
export function resolveExtensionLoadedStatus(previewContractInfoString, newAavFuture) {
  const schedule = parseYearSchedule(previewContractInfoString);
  if (!schedule) return { loaded: "", resolved: false };
  const future = schedule.slice(1);   // exclude Y1 -- frozen at the pre-extension salary
  if (future.length < 1) return { loaded: "", resolved: false };   // no future years parsed at all
  if (future.length === 1) return { loaded: "", resolved: true };  // a single future year has no shape
  if (future.every((v) => v === future[0])) return { loaded: "", resolved: true };
  const aavFuture = Number.isFinite(newAavFuture) && newAavFuture > 0
    ? newAavFuture
    : future.reduce((a, b) => a + b, 0) / future.length;
  if (!Number.isFinite(aavFuture) || aavFuture <= 0) return { loaded: "", resolved: false };
  const y2 = future[0];
  if (y2 > aavFuture) return { loaded: "FL", resolved: true };
  if (y2 < aavFuture) return { loaded: "BL", resolved: true };
  return { loaded: "", resolved: true };
}

// Kept for any external caller that only has a contractStatus string and no contractInfo
// (e.g. a quick display-only check) -- NOT used by the loaded-contract gate itself, which
// always calls resolveLoadedStatus() with both fields so it can fail closed correctly.
export function classifyLoaded(contractStatus) {
  const v = classifyStatusOnly(contractStatus);
  return v === null ? "" : v;
}
