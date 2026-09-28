// contract_classification.js — classifies a contract's "loaded" modifier (front-loaded /
// back-loaded / flat) for the Trade War Room's loaded-contract limit gate (canon §2.G /
// §6.G: "Loaded contracts on roster ≤ 5 at all times (front + back combined)"; "Loaded...
// can never attach to a 1-year deal, a MYM, or a taxi contract").
//
// RULING (2026-09-28, THIRD revision -- a second review pass on the first fix found 6 MORE
// fail-open cases, all of the same shape: an explicitly PRESENT schedule that is incomplete,
// duplicated, unreconciled, nonpositive, or irregular was falling through to a plausible-
// looking contractStatus and getting classified flat anyway, instead of being reported
// unresolved). Loaded/flat is resolved with this priority:
//   1. contractInfo actually contains a parseable year-by-year schedule (Y-token
//      "Y1-21 Y2-38" or bracket "[14K, 14K, 15K]" format): this is the MOST SPECIFIC signal
//      available, so once it is present at all, contractStatus is NEVER consulted --
//      either the schedule itself cleanly proves flat/FL/BL, or the whole result is
//      unresolved. A schedule only proves anything when it is AUTHORITATIVE:
//        a. NO DUPLICATE year tokens (e.g. "Y1-2K, Y1-2K, Y2-2K" -- a repeated Y1, even
//           with a matching value, is malformed data, not a harmless repeat).
//        b. EVERY year's amount is POSITIVE (a $0 or negative year, e.g. "Y1-0K, Y2-4K",
//           is not a real salary and proves nothing about load shape).
//        c. COMPLETE: the distinct years found must cover the contract's own stated length
//           (the "CL <n>" prefix) exactly once, 1..CL. A schedule with a year silently
//           missing (e.g. "Y1-2K, Y3-2K" for a 3-year deal -- Y2 is missing, not "equal to
//           Y1 and Y3") is NOT a valid 2-entry schedule; it is an INCOMPLETE 3-entry one.
//           Without a known CL at all, completeness can't be verified, so the schedule is
//           never trusted -- deliberately stricter than "trust whatever tokens parse".
//        d. RECONCILED: its total must equal the contract's own stated TCV (the "TCV <n>K"
//           prefix), within $1 of rounding slack. A schedule that sums to something else is
//           not proof of THIS contract's shape -- it's evidence something else is wrong
//           with the data, and this module refuses to guess which.
//      A schedule that clears all four bars is classified by canon's Y1-vs-AAV rule (equal
//      every year -> FLAT, proven; Y1 above the contract's own AAV -> FL; Y1 below -> BL).
//      A schedule where Y1 exactly EQUALS the AAV but the years are NOT all identical (e.g.
//      [2K, 3K, 1K] against a 2K AAV) is a real, irregular shape canon's simple front/back
//      taxonomy cannot classify -- it is NOT "FLAT" (which means every year pays the same
//      amount). EITHER an authoritative-but-irregular schedule OR a schedule that fails any
//      of (a)-(d) produces the SAME outcome: unresolved. It never falls back to step 3 --
//      a present but broken schedule is not the same thing as no schedule at all, and
//      silently trusting a plausible-looking contractStatus over it is exactly the
//      fail-open pattern this ruling exists to close.
//   2. NO schedule was found in contractInfo at all: a contract whose TOTAL length (CL) is
//      exactly 1 year is flat BY DEFINITION (canon: loaded can never attach to a 1-year
//      deal) -- independent of contractStatus, never ambiguous.
//   3. STILL no schedule, and not a known 1-year deal: a present, non-blank contractStatus
//      is a real signal ONLY when it is a RECOGNIZED status family (the documented 2025
//      legacy tokens -- Rookie, Veteran, WW, Tag, bare FL/BL -- and the 2026 compound
//      Vet-/Rookie- scheme -- Vet-FAA, Rookie-Draft, Vet-Ext<n>, Vet-ERA, Vet-WW -- with or
//      without a trailing -FL/-BL suffix). A RECOGNIZED MYM form specifically (Vet-MYM,
//      Rookie-MYM, Vet-WW-MYM, or any other <prefix>-MYM built from a real prefix) is flat
//      by canon (a MYM contract can never be loaded) -- but this recognition is restricted
//      to that actual shape; a status merely CONTAINING the substring "mym" inside an
//      otherwise-unrecognized string (e.g. "Gibberish-MYM") is NOT treated as a real MYM
//      form and is not proof of anything. A status that matches none of these known
//      families is likewise NOT treated as proof of anything, flat or loaded -- we cannot
//      even confirm the string is a real MFL status token, let alone what it means.
//   4. Anything left -- no schedule, contractStatus blank/unrecognized, and the contract's
//      length isn't provably 1 year -- is genuinely UNRESOLVED. The caller
//      (trade_cap_authority.js) must treat this as `loaded_contracts: unavailable` for the
//      WHOLE loaded-contract block (never guessed either way), while leaving
//      cap/roster/lineup completely unaffected. This explicitly includes a contract whose
//      status, length, AND schedule are ALL blank -- MFL's own "silence isn't proof of
//      expiry" cap-math convention does NOT extend to "silence is proof of flat"; a fully
//      silent contract is unresolved here, full stop, unless some OTHER authoritative
//      source (a schedule, a length) resolves it via priorities 1-2 above.
//
// The SAME schedule-authority bar (duplicate/nonpositive/complete/reconciled) applies to a
// pre-trade EXTENSION's priced terms too (resolveExtensionLoadedStatus) -- a partial or
// contradictory extension schedule must not fall back to being treated as flat either.
//
// This is intentionally NOT a full port of index.js's parser: it implements exactly the
// two most reliable, directly-in-contractInfo schedule formats (Y-token, bracket) plus the
// CL/TCV prefix already present in the same string (real example seen in production:
// "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K|GTD: 1K"). It deliberately does NOT implement index.js's
// lower-confidence methods (the AAV comma-tier-list fallback, year_values_json, or the
// even-split GUESS derived purely from TCV/CL with no real per-year evidence) -- the
// even-split method in particular is explicitly a LOW-confidence GUESS in index.js's own
// comments, and guessing can never satisfy "provably flat" or "authoritative". A contract
// this module can't resolve via a real, verified schedule, the 1-year rule, or a
// recognized status is correctly reported unresolved rather than silently guessed at
// either extreme.
//
// Pure functions only -- no fetch, no DOM, no D1.

const s = (v) => String(v == null ? "" : v).trim();

const LOADED_SUFFIX_RE = /-(FL|BL)$/i;
const LOADED_BARE_RE = /^(FL|BL)$/i;

// Contract-status "families" this league is documented to actually use (see the MFL
// contractStatus vocabulary memory notes -- both the 2025 legacy singular tokens and the
// 2026 compound Vet-/Rookie- scheme), matched case-insensitively against the status with
// any trailing -FL/-BL suffix already removed. Anything that matches none of these is NOT
// usable as proof either way (see priority 3 in the module header).
const KNOWN_STATUS_FAMILY_RE = new RegExp(
  "^(" +
    [
      "vet-faa", "rookie-faa", "rookie-draft", "rookie-ww", "vet-ext\\d*", "vet-era",
      "rookie[/|]veteran", "veteran", "rookie", "vet-ww", "ww", "tag", "franchise tag",
    ].join("|") +
    ")$",
  "i"
);

// A RECOGNIZED MYM form specifically: a real Vet-/Rookie- prefix (optionally with one or
// more known-shaped middle segments, e.g. "Vet-WW-MYM"), ending in "-MYM". Deliberately
// narrower than "the string contains mym anywhere" -- a status like "Gibberish-MYM" does
// NOT start with a real prefix and must NOT be treated as a recognized, canon-flat MYM
// contract (2026-09-28 review, second pass).
const MYM_FAMILY_RE = /^(vet|rookie)(-[a-z0-9]+)*-mym$/i;

/** contractStatus alone -> "FL" | "BL" | "" | null (null = blank, unreadable, OR simply not
 * a status family this module recognizes -- none of those are proof of anything. "" =
 * present, recognized, and flat). Priority 3 in the module header. */
function classifyStatusOnly(contractStatus) {
  const status = s(contractStatus);
  if (!status) return null;
  const suffixMatch = LOADED_SUFFIX_RE.exec(status);
  const base = suffixMatch ? status.slice(0, status.length - suffixMatch[0].length).trim() : status;
  // Canon: a MYM contract can never be loaded -- but only for an actually RECOGNIZED MYM
  // form (see MYM_FAMILY_RE), not any string that merely contains "mym". A MYM base paired
  // with an explicit -FL/-BL suffix is itself a data anomaly (canon says this combination
  // should never exist) and is surfaced as unresolved, never silently trusted as "loaded".
  if (MYM_FAMILY_RE.test(base)) return suffixMatch ? null : "";
  const recognized = LOADED_BARE_RE.test(status) || (base !== "" && KNOWN_STATUS_FAMILY_RE.test(base));
  if (!recognized) return null;   // present but not a status we recognize -- not proof
  if (suffixMatch) return suffixMatch[1].toUpperCase();
  if (LOADED_BARE_RE.test(status)) return status.toUpperCase();
  return "";   // a recognized family with no FL/BL suffix -- flat
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
 * An authoritative-CANDIDATE per-year salary schedule from contractInfo text, together with
 * which year-numbers were actually found and whether any year number was seen more than
 * once -- needed to tell a real, complete, well-formed schedule apart from one with a gap
 * or a duplicate (see scheduleIsAuthoritative). NOT exported: a caller that only wants the
 * values (no completeness/reconciliation check) should use parseYearSchedule below.
 * "Present" is judged on the RAW token count, not the distinct-year count, specifically so
 * a duplicated year token (which collapses to fewer distinct years) still registers as "a
 * schedule was found here" rather than silently vanishing below the presence threshold.
 * @returns { years: number[], values: number[], duplicate: boolean } (years sorted
 *          ascending, values in the SAME order -- index i is year `years[i]`, not
 *          necessarily "Year i+1" until completeness is separately confirmed) or null when
 *          nothing parseable was found at all.
 */
function parseYearScheduleRaw(contractInfo) {
  const info = s(contractInfo);
  if (!info) return null;
  // 1. Y-token format: "Y1-21K Y2-38K Y3-38K" (also accepts "Y1-2K, Y2-2K" with commas).
  const re = /Y(\d+)\s*-\s*([0-9.]+)\s*K?/gi;
  let m; const map = {}; let rawCount = 0; let duplicate = false;
  while ((m = re.exec(info))) {
    rawCount++;
    const y = parseInt(m[1], 10);
    if (Object.prototype.hasOwnProperty.call(map, y)) duplicate = true;
    map[y] = Math.round(parseFloat(m[2]) * 1000);
  }
  if (rawCount >= 2) {
    const years = Object.keys(map).map(Number).sort((a, b) => a - b);
    return { years, values: years.map((y) => map[y]), duplicate };
  }
  // 2. Bracket format: "[14K, 14K, 15K]" -- position IS the year (1-indexed); no year can
  //    be "missing" or "duplicated" the way a Y-token can be, so it is complete and
  //    duplicate-free by construction relative to its own length.
  const bm = info.match(/\[([^\]]+)\]/);
  if (bm) {
    const arr = bm[1].split(",").map((t) => {
      const n = parseFloat(String(t).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
    });
    if (arr.length >= 2 && arr.every(Number.isFinite)) return { years: arr.map((_, i) => i + 1), values: arr, duplicate: false };
  }
  return null;
}

/**
 * Kept for any external caller that only wants the parsed VALUES with no
 * completeness/reconciliation check. NOT used by resolveLoadedStatus's or
 * resolveExtensionLoadedStatus's authoritative-schedule path -- both call
 * parseYearScheduleRaw + scheduleIsAuthoritative instead, specifically because this
 * values-only shape can't distinguish a complete, well-formed schedule from one with a gap
 * or a duplicate in it.
 * @returns number[] (length >= 2) when a real schedule was found, or null.
 */
export function parseYearSchedule(contractInfo) {
  const raw = parseYearScheduleRaw(contractInfo);
  return raw ? raw.values : null;
}

/**
 * Is this parsed schedule AUTHORITATIVE evidence of the contract's true shape? A schedule
 * only proves flat/FL/BL when it has NO duplicate year token, every year's amount is
 * POSITIVE, it covers every year of the contract's own stated length EXACTLY once (no gaps,
 * no extras), and its total reconciles with the contract's own stated TCV. Any one of these
 * failing is NOT proof of anything -- exactly the fail-open risk the 2026-09-28 review (both
 * passes) flagged: a Y1/Y3 schedule with Y2 missing was being silently read as a complete,
 * flat 2-year contract; a schedule summing to $5K under a stated $6K TCV was silently
 * trusted as-is; a repeated "Y1-2K, Y1-2K, Y2-2K" token was silently collapsed to a normal
 * 2-year schedule; a $0 year ("Y1-0K, Y2-4K") was silently read as a real back-loaded salary
 * curve. A $1 tolerance on the TCV check absorbs K-string rounding, never a real mismatch.
 * Neither CL nor TCV being known is treated as "not authoritative" -- without both, there is
 * nothing to verify the schedule AGAINST, so it is never blindly trusted on its own say-so.
 */
function scheduleIsAuthoritative(years, values, cl, tcv, duplicate) {
  if (duplicate) return false;
  if (!years || years.length < 2) return false;
  if (values.some((v) => !(v > 0))) return false;   // every year must be a real positive salary
  if (!(Number.isFinite(cl) && cl > 0)) return false;
  if (years.length !== cl) return false;
  for (let i = 0; i < cl; i++) if (years[i] !== i + 1) return false;   // exactly {1..CL}, no gaps
  if (!(Number.isFinite(tcv) && tcv > 0)) return false;
  const total = values.reduce((a, b) => a + b, 0);
  if (Math.abs(total - tcv) > 1) return false;
  return true;
}

/**
 * Canon's ACTUAL rule (not a monotonicity heuristic): "Front-loaded = Year 1 salary >
 * AAV; Back-loaded = Year 1 salary < AAV" (AAV = TCV / contract length). Comparing Y1 to
 * the contract's own AAV is robust to a schedule that plateaus after year 1 (e.g. an
 * extension priced [4K, 26K, 26K] -- clearly back-loaded by canon's own Y1-vs-AAV test,
 * even though it is not STRICTLY monotonic every single year, which a naive "every
 * consecutive pair must move the same direction" check would wrongly call unclassifiable).
 * Equal-every-year is still checked directly first (unambiguous, needs no AAV at all) --
 * and ONLY that direct check may return "FLAT". A schedule where Y1 happens to equal the
 * AAV exactly, but the years are NOT all identical, is a genuinely irregular shape (e.g.
 * [2K, 3K, 1K] against a 2K AAV) that canon's simple front/back taxonomy cannot classify --
 * this must NOT be reported as "FLAT" (that word means every year pays the same amount),
 * so it returns "" (unclassifiable) like any other case this function can't resolve.
 *
 * @param years  the parsed per-year schedule (length >= 2).
 * @param tcv    the contract's total value in dollars, or null if unknown.
 * @param cl     the contract's total length in years, or null if unknown (defaults to
 *               years.length when the schedule itself covers the full contract).
 * @returns "FLAT" | "FL" | "BL" | ""  ("" when Y1 can't be compared to any AAV at all, OR
 *          when Y1 equals the AAV but the schedule isn't actually uniform)
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
  return "";   // y1 === aav but the years are NOT all equal -- irregular, not FLAT
}

/**
 * @param contractStatus  raw MFL contractStatus (may be blank/null).
 * @param contractInfo    raw MFL contractInfo (may be blank/null) -- read for an
 *                        authoritative year-by-year schedule and the "CL <n>"/"TCV <n>K"
 *                        prefixes used to verify it.
 * @returns { loaded: "FL"|"BL"|"", resolved: boolean }
 *   resolved:false means genuinely UNRESOLVED -- the caller must treat the WHOLE
 *   loaded-contract block as unavailable, never guess `loaded` either way in that case
 *   (the `loaded` field is meaningless / "" when resolved is false -- never read it then).
 */
export function resolveLoadedStatus(contractStatus, contractInfo) {
  const cl = parseContractLength(contractInfo);
  const tcv = parseTCV(contractInfo);
  const raw = parseYearScheduleRaw(contractInfo);
  if (raw) {
    // Priority 1: an EXPLICITLY PRESENT schedule is the most specific signal there is.
    // Once contractInfo actually contains a Y-token/bracket schedule, contractStatus is
    // NEVER consulted -- the schedule either cleanly proves flat/FL/BL, or the WHOLE
    // result is unresolved. A present but incomplete, duplicated, unreconciled,
    // nonpositive, or irregular schedule must NEVER fall through to trusting
    // contractStatus instead (2026-09-28 review, second pass): that schedule is itself
    // evidence something is wrong with this contract's data, and a plausible-looking
    // status is not permitted to override or paper over it.
    if (scheduleIsAuthoritative(raw.years, raw.values, cl, tcv, raw.duplicate)) {
      const struct = structureOf(raw.values, tcv, cl);
      if (struct === "FLAT") return { loaded: "", resolved: true };
      if (struct === "FL" || struct === "BL") return { loaded: struct, resolved: true };
      // struct === "" -- Y1 equals the AAV but the schedule isn't uniform: irregular,
      // unclassifiable. Falls through to the SAME unresolved return below.
    }
    return { loaded: "", resolved: false };
  }
  // Priority 2: no schedule at all -- a 1-year contract is flat by canon, independent of
  // contractStatus.
  if (cl === 1) return { loaded: "", resolved: true };
  // Priority 3: still no schedule -- a present, RECOGNIZED contractStatus is a real signal
  // (see classifyStatusOnly -- an unrecognized nonblank status is treated the same as blank).
  const fromStatus = classifyStatusOnly(contractStatus);
  if (fromStatus !== null) return { loaded: fromStatus, resolved: true };
  // Priority 4: blank/unrecognized status, no schedule at all, and the contract's length
  // isn't provably 1 year -- genuinely unresolved. This is the correct outcome even when
  // contractStatus, contractInfo, AND the parsed length/schedule are ALL blank -- silence
  // is not proof of flat, the same way it is not proof of expiry in cap math, but that
  // "don't guess" principle points the OPPOSITE direction here: cap math's silence rule
  // falls back to counting the FULL salary (the safe, conservative default for a cap
  // total), while a loaded-contract verdict has no safe default to fall back to -- so
  // silence here means unresolved, not flat.
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
 * Before any of that: the WHOLE priced schedule (frozen Y1 included) must clear the SAME
 * authority bar as an ordinary contract's schedule -- no duplicate year token, every year
 * positive, complete against the extension's own stated CL, and reconciled against its own
 * stated TCV (2026-09-28 review, second pass: "apply the same completeness check to
 * extension schedules"). A partial extension schedule (e.g. "CL 3|TCV 6K|Y1-2K, Y3-4K" --
 * Y2 silently missing) must never be treated as if it were a valid shorter schedule.
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
  const cl = parseContractLength(previewContractInfoString);
  const tcv = parseTCV(previewContractInfoString);
  const raw = parseYearScheduleRaw(previewContractInfoString);
  if (!raw) return { loaded: "", resolved: false };   // no schedule at all
  if (!scheduleIsAuthoritative(raw.years, raw.values, cl, tcv, raw.duplicate)) return { loaded: "", resolved: false };
  const schedule = raw.values;
  const future = schedule.slice(1);   // exclude Y1 -- frozen at the pre-extension salary
  if (future.length < 1) return { loaded: "", resolved: false };   // no future years at all
  if (future.length === 1) return { loaded: "", resolved: true };  // a single future year has no shape
  if (future.every((v) => v === future[0])) return { loaded: "", resolved: true };
  const aavFuture = Number.isFinite(newAavFuture) && newAavFuture > 0
    ? newAavFuture
    : future.reduce((a, b) => a + b, 0) / future.length;
  if (!Number.isFinite(aavFuture) || aavFuture <= 0) return { loaded: "", resolved: false };
  const y2 = future[0];
  if (y2 > aavFuture) return { loaded: "FL", resolved: true };
  if (y2 < aavFuture) return { loaded: "BL", resolved: true };
  // y2 === aavFuture but the future years are NOT all equal (already ruled out above):
  // the same irregular, unclassifiable shape as structureOf's final branch -- unresolved,
  // not silently flat.
  return { loaded: "", resolved: false };
}

// Kept for any external caller that only has a contractStatus string and no contractInfo
// (e.g. a quick display-only check) -- NOT used by the loaded-contract gate itself, which
// always calls resolveLoadedStatus() with both fields so it can fail closed correctly.
export function classifyLoaded(contractStatus) {
  const v = classifyStatusOnly(contractStatus);
  return v === null ? "" : v;
}
