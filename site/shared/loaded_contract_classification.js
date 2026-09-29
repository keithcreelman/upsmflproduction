/* loaded_contract_classification.js — the Front Office roster workbench's copy of the
   Trade War Room's loaded-contract classifier.

   This is a FAITHFUL, BEHAVIOR-IDENTICAL port of worker/src/contract_classification.js's
   resolveLoadedStatus/resolveExtensionLoadedStatus (the classifier behind canon's "MAX 5
   LOADED CONTRACTS PER ROSTER" rule, §2.G/§6.G). It exists because Front Office
   (site/rosters/roster_workbench.js) is a plain browser script with no bundler and cannot
   `import` the worker's ES module directly -- the SAME reason site/shared/cap_math.js is
   its own file rather than an import of worker/src/cap_math.js (see that file's own
   header). Every other worker file that needs this logic imports worker/src/
   contract_classification.js directly; this file is ONLY for a browser context that can't.

   RULING (2026-09-29, Ext1/Ext2 classification investigation): before this file existed,
   Front Office computed "loaded" with a much simpler, independent rule -- does the raw
   contractStatus string end in -FL or -BL? -- while the Trade War Room ran the richer,
   schedule-verifying logic below. On every one of the league's 483 live 2026 contracts the
   two answers happened to agree (confirmed 2026-09-29) BUT nothing guaranteed that: a
   genuinely loaded contract that was ever mislabeled without its suffix would have been
   invisible to Front Office's old check while still correctly caught here. Front Office
   now calls this file instead of its own suffix-only check (see roster_workbench.js's
   contractBucket/isLoadedContractPlayer) specifically so the two surfaces can never again
   silently disagree. tests/loaded_contract_classification_parity.test.mjs runs this file
   and the worker's own module against the same real contract shapes and fails the build the
   moment they diverge -- update BOTH files together, never just one.

   Pure functions only -- no fetch, no DOM, no D1. ES5-style (var, function expressions) to
   match every other file in site/shared/.
*/
(function (global) {
  "use strict";

  function s(v) {
    return String(v == null ? "" : v).trim();
  }

  var LOADED_SUFFIX_RE = /-(FL|BL)$/i;
  var LOADED_BARE_RE = /^(FL|BL)$/i;

  // A contractStatus BASE (any trailing -FL/-BL already stripped) that is EXACTLY a 1- or
  // 2-year extension -- canon's only two currently-defined extension lengths
  // (docs/league_context_v1.md:465, 476-480; EXT3 is legacy data, "not a live option", and
  // is deliberately not matched here).
  var PLAIN_EXT_RE = /^(vet|rookie)-ext[12]$/i;

  // Contract-status "families" this league is documented to actually use -- both the 2025
  // legacy singular tokens and the 2026 compound Vet-/Rookie- scheme -- matched
  // case-insensitively against the status with any trailing -FL/-BL suffix already removed.
  var KNOWN_STATUS_FAMILY_RE = new RegExp(
    "^(" +
      [
        "vet-faa", "rookie-faa", "rookie-draft", "rookie-ww", "vet-ext\\d*", "vet-era",
        "rookie[/|]veteran", "veteran", "rookie", "vet-ww", "ww", "tag", "franchise tag"
      ].join("|") +
      ")$",
    "i"
  );

  // The EXACT, documented MYM status forms -- Vet-MYM and Rookie-MYM, plus Vet-WW-MYM (an
  // observed real value in this league's own history). An exact list, never a wildcard
  // "any prefix plus any middle segment plus -MYM" pattern.
  var MYM_FAMILY_RE = /^(vet-mym|rookie-mym|vet-ww-mym)$/i;

  /** contractStatus alone -> "FL" | "BL" | "" | null (null = blank, unreadable, or simply
   * not a status family this module recognizes -- none of those are proof of anything). */
  function classifyStatusOnly(contractStatus) {
    var status = s(contractStatus);
    if (!status) return null;
    var suffixMatch = LOADED_SUFFIX_RE.exec(status);
    var base = suffixMatch ? status.slice(0, status.length - suffixMatch[0].length).trim() : status;
    if (MYM_FAMILY_RE.test(base)) return suffixMatch ? null : "";
    var recognized = LOADED_BARE_RE.test(status) || (base !== "" && KNOWN_STATUS_FAMILY_RE.test(base));
    if (!recognized) return null;
    if (suffixMatch) return suffixMatch[1].toUpperCase();
    if (LOADED_BARE_RE.test(status)) return status.toUpperCase();
    return "";
  }

  /** contractInfo's "CL <n>" prefix -> integer total contract length, or null. */
  function parseContractLength(contractInfo) {
    var info = s(contractInfo);
    var m = /CL\s*(\d+)/i.exec(info);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  /** contractInfo's "TCV <n>K" prefix -> integer total contract value in dollars, or null. */
  function parseTCV(contractInfo) {
    var info = s(contractInfo);
    var m = /TCV\s*([0-9.]+)\s*K?/i.exec(info);
    if (!m) return null;
    var n = Math.round(parseFloat(m[1]) * 1000);
    return isFinite(n) && n > 0 ? n : null;
  }

  function malformedSchedule() {
    return { years: null, values: null, duplicate: false, optionYears: [], baseYears: null, baseValues: null, malformed: true };
  }

  /** A single bracket entry parsed STRICTLY -- the whole trimmed entry must be a positive
   * number optionally suffixed with "K", nothing else. Returns NaN otherwise. */
  function parseBracketEntry(t) {
    var m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*K?\s*$/i.exec(String(t));
    if (!m) return NaN;
    var n = parseFloat(m[1]);
    return isFinite(n) ? Math.round(n * 1000) : NaN;
  }

  /** An authoritative-CANDIDATE per-year salary schedule from contractInfo text. Mirrors
   * worker/src/contract_classification.js's parseYearScheduleRaw exactly -- see that file
   * for the full reasoning (duplicate/nonpositive/complete/reconciled checks, option-year
   * handling, malformed-vs-absent distinction). Returns null when nothing was attempted at
   * all, { malformed: true } when something was attempted but never produced usable
   * numbers, or { years, values, duplicate, optionYears, baseYears, baseValues }. */
  function parseYearScheduleRaw(contractInfo) {
    var info = s(contractInfo);
    if (!info) return null;
    var attempts = (info.match(/Y\d+\s*-/gi) || []).length;
    var re = /Y(\d+)\s*-\s*([0-9.]+)\s*K?(\s*Option)?(?=[\s,|]|$)/gi;
    var m; var map = {}; var optionYearSet = {}; var optionYearList = []; var rawCount = 0; var duplicate = false;
    while ((m = re.exec(info))) {
      rawCount++;
      var y = parseInt(m[1], 10);
      if (Object.prototype.hasOwnProperty.call(map, y)) duplicate = true;
      map[y] = Math.round(parseFloat(m[2]) * 1000);
      if (m[3] && !optionYearSet[y]) { optionYearSet[y] = true; optionYearList.push(y); }
    }
    if (attempts > rawCount) return malformedSchedule();
    var openCount = (info.match(/\[/g) || []).length;
    var closeCount = (info.match(/\]/g) || []).length;
    if (rawCount >= 1) {
      if (openCount > 0 || closeCount > 0) return malformedSchedule();
      var years = [];
      for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) years.push(Number(k)); }
      years.sort(function (a, b) { return a - b; });
      var values = years.map(function (yy) { return map[yy]; });
      optionYearList.sort(function (a, b) { return a - b; });
      var baseYears = years.filter(function (yy) { return !optionYearSet[yy]; });
      var baseValues = baseYears.map(function (yy) { return map[yy]; });
      return { years: years, values: values, duplicate: duplicate, optionYears: optionYearList, baseYears: baseYears, baseValues: baseValues };
    }
    if (openCount === 1 && closeCount === 1) {
      var bm = info.match(/\[([^\]]*)\]/);
      var arr = bm[1].split(",").map(parseBracketEntry);
      if (arr.length >= 1) {
        var idxYears = arr.map(function (_, i) { return i + 1; });
        return { years: idxYears, values: arr, duplicate: false, optionYears: [], baseYears: idxYears, baseValues: arr };
      }
    } else if (openCount > 0 || closeCount > 0) {
      return malformedSchedule();
    }
    return null;
  }

  /** @returns number[] (length >= 1) when a real schedule was found, else null. */
  function parseYearSchedule(contractInfo) {
    var raw = parseYearScheduleRaw(contractInfo);
    return raw ? raw.values : null;
  }

  /** Is this parsed schedule AUTHORITATIVE evidence of the contract's true shape? See
   * worker/src/contract_classification.js's scheduleIsAuthoritative for the full reasoning. */
  function scheduleIsAuthoritative(years, values, cl, tcv, duplicate) {
    if (duplicate) return false;
    if (!years || years.length < 1) return false;
    for (var i = 0; i < values.length; i++) { if (!(values[i] > 0)) return false; }
    if (!(isFinite(cl) && cl > 0)) return false;
    if (years.length !== cl) return false;
    for (var j = 0; j < cl; j++) { if (years[j] !== j + 1) return false; }
    if (!(isFinite(tcv) && tcv > 0)) return false;
    var total = 0;
    for (var k = 0; k < values.length; k++) total += values[k];
    if (Math.abs(total - tcv) > 1) return false;
    return true;
  }

  /** Canon's ACTUAL rule: Front-loaded = Year 1 salary > AAV; Back-loaded = Year 1 salary
   * < AAV (AAV = TCV / contract length). Equal-every-year is checked directly first and is
   * the ONLY way to get "FLAT". @returns "FLAT" | "FL" | "BL" | "" */
  function structureOf(years, tcv, cl) {
    if (!years || years.length < 2) return "";
    var allEqual = true;
    for (var i = 1; i < years.length; i++) { if (years[i] !== years[0]) { allEqual = false; break; } }
    if (allEqual) return "FLAT";
    var length = cl || years.length;
    var sum = 0;
    for (var j = 0; j < years.length; j++) sum += years[j];
    var aav = tcv ? tcv / length : sum / years.length;
    if (!isFinite(aav) || aav <= 0) return "";
    var y1 = years[0];
    if (y1 > aav) return "FL";
    if (y1 < aav) return "BL";
    return "";
  }

  /**
   * A pre-trade EXTENSION's loaded status, derived from its own priced terms -- excludes
   * the frozen, pre-extension Year 1 and looks only at the future portion. See
   * worker/src/contract_classification.js's resolveExtensionLoadedStatus for full reasoning.
   * @returns { loaded: "FL"|"BL"|"", resolved: boolean }
   */
  function resolveExtensionLoadedStatus(previewContractInfoString, newAavFuture) {
    var cl = parseContractLength(previewContractInfoString);
    var tcv = parseTCV(previewContractInfoString);
    var raw = parseYearScheduleRaw(previewContractInfoString);
    if (!raw) return { loaded: "", resolved: false };
    if (raw.malformed) return { loaded: "", resolved: false };
    var candidates = raw.optionYears.length
      ? [{ years: raw.baseYears, values: raw.baseValues }, { years: raw.years, values: raw.values }]
      : [{ years: raw.years, values: raw.values }];
    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      if (!scheduleIsAuthoritative(cand.years, cand.values, cl, tcv, raw.duplicate)) continue;
      var schedule = cand.values;
      var future = schedule.slice(1);
      if (future.length < 1) return { loaded: "", resolved: false };
      if (future.length === 1) return { loaded: "", resolved: true };
      var futureAllEqual = true;
      for (var j = 1; j < future.length; j++) { if (future[j] !== future[0]) { futureAllEqual = false; break; } }
      if (futureAllEqual) return { loaded: "", resolved: true };
      var futureSum = 0;
      for (var k = 0; k < future.length; k++) futureSum += future[k];
      var aavFuture = (isFinite(newAavFuture) && newAavFuture > 0) ? newAavFuture : futureSum / future.length;
      if (!isFinite(aavFuture) || aavFuture <= 0) return { loaded: "", resolved: false };
      var y2 = future[0];
      if (y2 > aavFuture) return { loaded: "FL", resolved: true };
      if (y2 < aavFuture) return { loaded: "BL", resolved: true };
      return { loaded: "", resolved: false };
    }
    return { loaded: "", resolved: false };
  }

  /**
   * @param contractStatus  raw MFL contractStatus (may be blank/null).
   * @param contractInfo    raw MFL contractInfo (may be blank/null).
   * @returns { loaded: "FL"|"BL"|"", resolved: boolean } -- resolved:false means genuinely
   *   UNRESOLVED; never read `loaded` in that case.
   */
  function resolveLoadedStatus(contractStatus, contractInfo) {
    var cl = parseContractLength(contractInfo);
    var tcv = parseTCV(contractInfo);
    var raw = parseYearScheduleRaw(contractInfo);
    if (raw) {
      if (raw.malformed) return { loaded: "", resolved: false };
      // RULING (2026-09-29): a PLAIN (no -FL/-BL suffix) Ext1/Ext2 status is classified by
      // comparing the extension's OWN new year(s) to each other, excluding the frozen,
      // pre-extension Year 1 -- never the whole-contract Y1-vs-AAV test below, which would
      // misread the frozen year as if it were freshly negotiated. See
      // worker/src/contract_classification.js's resolveLoadedStatus for the full canon
      // citation and reasoning; both files must stay in lockstep (parity test enforces it).
      // Requires >= 2 raw years: a contract already down to just its last year (frozen year
      // already played, no longer listed) has nothing to exclude and falls through to the
      // ordinary candidates loop below, which already resolves a genuine 1-year schedule flat.
      var suffixMatch = LOADED_SUFFIX_RE.exec(s(contractStatus));
      var statusBase = suffixMatch
        ? s(contractStatus).slice(0, s(contractStatus).length - suffixMatch[0].length).trim()
        : s(contractStatus);
      if (!suffixMatch && PLAIN_EXT_RE.test(statusBase) && raw.years.length >= 2) {
        return resolveExtensionLoadedStatus(contractInfo);
      }
      var candidates = raw.optionYears.length
        ? [{ years: raw.baseYears, values: raw.baseValues }, { years: raw.years, values: raw.values }]
        : [{ years: raw.years, values: raw.values }];
      for (var i = 0; i < candidates.length; i++) {
        var cand = candidates[i];
        if (!scheduleIsAuthoritative(cand.years, cand.values, cl, tcv, raw.duplicate)) continue;
        if (cand.values.length === 1) return { loaded: "", resolved: true };
        var struct = structureOf(cand.values, tcv, cl);
        if (struct === "FLAT") return { loaded: "", resolved: true };
        if (struct === "FL" || struct === "BL") return { loaded: struct, resolved: true };
        return { loaded: "", resolved: false };
      }
      return { loaded: "", resolved: false };
    }
    if (cl === 1) return { loaded: "", resolved: true };
    var fromStatus = classifyStatusOnly(contractStatus);
    if (fromStatus !== null) return { loaded: fromStatus, resolved: true };
    return { loaded: "", resolved: false };
  }

  /** Convenience: true only when resolved AND loaded. */
  function isLoaded(contractStatus, contractInfo) {
    var r = resolveLoadedStatus(contractStatus, contractInfo);
    return r.resolved && r.loaded !== "";
  }

  global.UPS_LOADED_CONTRACT_CLASSIFICATION = {
    resolveLoadedStatus: resolveLoadedStatus,
    resolveExtensionLoadedStatus: resolveExtensionLoadedStatus,
    isLoaded: isLoaded,
    parseContractLength: parseContractLength,
    parseTCV: parseTCV,
    parseYearSchedule: parseYearSchedule,
    structureOf: structureOf,
    classifyLoaded: function (contractStatus) {
      var v = classifyStatusOnly(contractStatus);
      return v === null ? "" : v;
    }
  };
})(typeof window !== "undefined" ? window : this);
