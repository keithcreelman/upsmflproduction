// contract_classification.js — classifies a contract's "loaded" modifier (front-loaded /
// back-loaded / flat) for the Trade War Room's loaded-contract limit gate (canon §2.G /
// §6.G: "Loaded contracts on roster ≤ 5 at all times (front + back combined)"; "Loaded...
// can never attach to a 1-year deal, a MYM, or a taxi contract").
//
// RULING (2026-09-28, revised again after a second review pass found 6 real fail-open
// cases in the FIRST revision of this file -- a schedule that LOOKS parseable is not
// automatically authoritative, and "a nonblank status" is not automatically a RECOGNIZED
// one). Loaded/flat is resolved with this priority:
//   1. An authoritative, PARSEABLE year-by-year salary schedule (Y-token "Y1-21 Y2-38" or
//      bracket "[14K, 14K, 15K]" format inside contractInfo) is the most trustworthy
//      signal there is -- but ONLY when it is actually authoritative:
//        a. COMPLETE: it must cover the contract's own stated length (the "CL <n>" prefix)
//           exactly once per year, 1..CL. A schedule with a year silently missing (e.g.
//           "Y1-2K, Y3-2K" for a 3-year deal -- Y2 is missing, not "equal to Y1 and Y3") is
//           NOT a valid 2-entry schedule; it is an INCOMPLETE 3-entry one and proves
//           nothing. Without a known CL at all, completeness can't be verified, so no
//           schedule is trusted -- this is deliberately stricter than "trust whatever
//           tokens happen to parse".
//        b. RECONCILED: its total must equal the contract's own stated TCV (the "TCV <n>K"
//           prefix), within $1 of rounding slack. A schedule that sums to something else
//           is not proof of THIS contract's shape -- it's evidence something else is wrong
//           with the data, and this module refuses to guess which.
//      A schedule that clears both bars is classified by canon's Y1-vs-AAV rule (equal
//      every year -> FLAT, proven; Y1 above the contract's own AAV -> FL; Y1 below -> BL).
//      This OVERRIDES a stale stored suffix, the same way index.js's structureOf() already
//      does for the contract-history builder. A schedule where Y1 exactly EQUALS the AAV
//      but the years are NOT all identical (e.g. [2K, 3K, 1K] against a 2K AAV) is a real,
//      irregular shape canon's simple front/back taxonomy cannot classify -- it is NOT the
//      same thing as "FLAT" (which means every year pays the same amount), so this falls
//      through rather than being silently called flat.
//   2. A contract whose TOTAL length (CL) is exactly 1 year is flat BY DEFINITION (canon:
//      loaded can never attach to a 1-year deal) -- independent of contractStatus, never
//      ambiguous.
//   3. A present, non-blank contractStatus is a real signal ONLY when it is a RECOGNIZED
//      status family (the documented 2025 legacy tokens -- Rookie, Veteran, WW, Tag, bare
//      FL/BL -- and the 2026 compound Vet-/Rookie- scheme -- Vet-FAA, Rookie-Draft,
//      Vet-Ext<n>, Vet-ERA, Vet-WW, any *-MYM compound, etc. -- with or without a trailing
//      -FL/-BL suffix). A status that matches NONE of these known families is NOT treated
//      as proof of anything, flat or loaded -- we cannot even confirm the string is a real
//      MFL status token, let alone what it means. (Previously: any nonblank status without
//      an explicit -FL/-BL suffix was assumed flat by default. That silently trusted
//      garbled, unexpected, or future-vocabulary values this module has never seen.)
//   4. Anything left -- contractStatus is blank/unrecognized AND no authoritative schedule
//      AND the contract's length isn't provably 1 year -- is genuinely UNRESOLVED. The
//      caller (trade_cap_authority.js) must treat this as `loaded_contracts: unavailable`
//      for the WHOLE loaded-contract block (never guessed either way), while leaving
//      cap/roster/lineup completely unaffected. This explicitly includes a contract whose
//      status, length, AND schedule are ALL blank -- MFL's own "silence isn't proof of
//      expiry" cap-math convention does NOT extend to "silence is proof of flat"; a fully
//      silent contract is unresolved here, full stop, unless some OTHER authoritative
//      source (a schedule, a length) resolves it via priorities 1-2 above.
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

/** contractStatus alone -> "FL" | "BL" | "" | null (null = blank, unreadable, OR simply not
 * a status family this module recognizes -- none of those are proof of anything. "" =
 * present, recognized, and flat). Priority 3 in the module header. */
function classifyStatusOnly(contractStatus) {
  const status = s(contractStatus);
  if (!status) return null;
  // Canon: a MYM contract can never be loaded, true regardless of which Vet-/Rookie- prefix
  // precedes "-MYM" in the 2026 compound scheme (Vet-MYM, Rookie-MYM, Vet-WW-MYM, ...) --
  // checked directly so every MYM compound doesn't need separate enumeration below. A
  // status that pairs "MYM" with an FL/BL suffix (which canon says should never happen)
  // still goes through the normal recognized-family check instead of this shortcut, since
  // that combination is itself a data anomaly worth surfacing rather than silently trusting.
  if (/mym/i.test(status) && !LOADED_SUFFIX_RE.test(status)) return "";
  const suffixMatch = LOADED_SUFFIX_RE.exec(status);
  const base = suffixMatch ? status.slice(0, status.length - suffixMatch[0].length).trim() : status;
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
 * which year-numbers were actually found -- needed to tell a real, complete schedule apart
 * from one with a year silently missing (see scheduleIsAuthoritative). NOT exported: a
 * caller that only wants the values (no completeness/reconciliation check) should use
 * parseYearSchedule below.
 * @returns { years: number[], values: number[] } (years sorted ascending, values in the
 *          SAME order -- index i is year `years[i]`, not necessarily "Year i+1" until
 *          completeness is separately confirmed) or null when nothing parseable was found.
 */
function parseYearScheduleRaw(contractInfo) {
  const info = s(contractInfo);
  if (!info) return null;
  // 1. Y-token format: "Y1-21K Y2-38K Y3-38K" (also accepts "Y1-2K, Y2-2K" with commas).
  const re = /Y(\d+)\s*-\s*([0-9.]+)\s*K?/gi;
  let m; const map = {};
  while ((m = re.exec(info))) map[parseInt(m[1], 10)] = Math.round(parseFloat(m[2]) * 1000);
  const years = Object.keys(map).map(Number).sort((a, b) => a - b);
  if (years.length >= 2) return { years, values: years.map((y) => map[y]) };
  // 2. Bracket format: "[14K, 14K, 15K]" -- position IS the year (1-indexed); no year can
  //    be "missing" from a bracket list the way a Y-token can be, so it is complete by
  //    construction relative to its own length.
  const bm = info.match(/\[([^\]]+)\]/);
  if (bm) {
    const arr = bm[1].split(",").map((t) => {
      const n = parseFloat(String(t).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
    });
    if (arr.length >= 2 && arr.every(Number.isFinite)) return { years: arr.map((_, i) => i + 1), values: arr };
  }
  return null;
}

/**
 * Kept for any external caller that only wants the parsed VALUES with no
 * completeness/reconciliation check (e.g. resolveExtensionLoadedStatus below, which has its
 * own, separately-justified handling of a partial schedule -- see its own doc comment).
 * NOT used by resolveLoadedStatus's authoritative-schedule path -- that calls
 * parseYearScheduleRaw + scheduleIsAuthoritative instead, specifically because this
 * values-only shape can't distinguish a complete schedule from one with a gap in it.
 * @returns number[] (length >= 2) when a real schedule was found, or null.
 */
export function parseYearSchedule(contractInfo) {
  const raw = parseYearScheduleRaw(contractInfo);
  return raw ? raw.values : null;
}

/**
 * Is this parsed schedule AUTHORITATIVE evidence of the contract's true shape? A schedule
 * only proves flat/FL/BL when it (a) covers every year of the contract's own stated length
 * EXACTLY once -- no gaps, no extras -- and (b) its total reconciles with the contract's
 * own stated TCV. A partial schedule (a year silently missing) or one that doesn't add up
 * to the stated TCV is NOT proof of anything -- exactly the fail-open risk the 2026-09-28
 * review flagged: a Y1/Y3 schedule with Y2 missing was being silently read as a complete,
 * flat 2-year contract; a schedule summing to $5K under a stated $6K TCV was silently
 * trusted as-is. A $1 tolerance absorbs K-string rounding, never a real mismatch. Neither
 * CL nor TCV being known is treated as "not authoritative" -- without both, there is
 * nothing to verify the schedule AGAINST, so it is never blindly trusted on its own say-so.
 */
function scheduleIsAuthoritative(years, values, cl, tcv) {
  if (!years || years.length < 2) return false;
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
  // Priority 1: a real, AUTHORITATIVE schedule (complete against CL, reconciled against
  // TCV -- see scheduleIsAuthoritative) overrides everything, including a stale status --
  // classified by canon's own Y1-vs-AAV rule (see structureOf), not a monotonicity guess.
  // An incomplete, unreconciled, or otherwise-unverifiable schedule is never trusted; it
  // simply falls through to the next priority rather than being guessed at.
  const raw = parseYearScheduleRaw(contractInfo);
  if (raw && scheduleIsAuthoritative(raw.years, raw.values, cl, tcv)) {
    const struct = structureOf(raw.values, tcv, cl);
    if (struct === "FLAT") return { loaded: "", resolved: true };
    if (struct === "FL" || struct === "BL") return { loaded: struct, resolved: true };
    // Y1 exactly equals the AAV but the schedule isn't uniform -- an irregular shape this
    // module can't classify as FL/BL/FLAT; fall through rather than guess.
  }
  // Priority 2: a 1-year contract is flat by canon, independent of contractStatus.
  if (cl === 1) return { loaded: "", resolved: true };
  // Priority 3: a present, RECOGNIZED contractStatus is a real signal (see
  // classifyStatusOnly -- an unrecognized nonblank status is treated the same as blank).
  const fromStatus = classifyStatusOnly(contractStatus);
  if (fromStatus !== null) return { loaded: fromStatus, resolved: true };
  // Priority 4: blank/unrecognized status, no authoritative schedule, and the contract's
  // length isn't provably 1 year -- genuinely unresolved. This is the correct outcome even
  // when contractStatus, contractInfo, AND the parsed length/schedule are ALL blank --
  // silence is not proof of flat, the same way it is not proof of expiry in cap math, but
  // that "don't guess" principle points the OPPOSITE direction here: cap math's silence
  // rule falls back to counting the FULL salary (the safe, conservative default for a cap
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
