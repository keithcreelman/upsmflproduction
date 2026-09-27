/* pretrade_extension.js — UPS league PRE-TRADE EXTENSION source of truth.

   Canon: docs/league_context_v1.md §C4. The "synthetic extension" a trading-
   away franchise may apply to a final-year (or expired-rookie) player as its
   LAST act before a trade: the 1YR/2YR raise table, the eligibility gate
   (PLAYER only; NOT already extended by this franchise per Keith 2026-05-24;
   no tag; years-remaining == 1, or rookie with <= 0 remaining), and the option
   builder that produces preview_contract_info_string + the new TCV/AAV/length.
   The worker RE-DERIVES and RE-VALIDATES the salary-by-year from
   preview_contract_info_string on submit/accept, so consumers only have to
   produce the same extension_requests row shape.

   This is the CANONICAL implementation. The MOBILE trade builder
   (site/m/views/trade.js) consumes it. The DESKTOP Trade War Room
   (site/trades/trade_workbench.js) currently keeps its own VERBATIM copy of
   these functions and does NOT delegate here yet — the same posture
   site/shared/cap_math.js documents toward Front Office. Keep the two
   byte-identical; if canon changes, change BOTH (or refactor the desktop to
   consume this module). Extracted from trade_workbench.js, Keith 2026-06-11.

   Pure: every function operates on a passed asset/value — no DOM, no page
   state. Self-contained helpers so it has no host dependency.
*/
(function (global) {
  "use strict";

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }
  function parseBool(v, fallback) {
    if (typeof v === "boolean") return v;
    var s = safeStr(v).toLowerCase();
    if (!s) return !!fallback;
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
    return !!fallback;
  }

  var PRETRADE_EXTENSION_RAISES = {
    QB: { 1: 10000, 2: 20000 },
    RB: { 1: 10000, 2: 20000 },
    WR: { 1: 10000, 2: 20000 },
    TE: { 1: 10000, 2: 20000 },
    DL: { 1: 3000, 2: 5000 },
    DB: { 1: 3000, 2: 5000 },
    LB: { 1: 3000, 2: 5000 },
    PK: { 1: 3000, 2: 5000 },
    PN: { 1: 3000, 2: 5000 },
    OTHER: { 1: 3000, 2: 5000 }
  };

  function parseContractMoneyTokenToDollars(token) {
    var raw = safeStr(token);
    if (!raw) return null;
    var hasK = /k/i.test(raw);
    var cleaned = raw.replace(/[^0-9.-]/gi, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    var n = Number(cleaned);
    if (!isFinite(n)) return null;
    if (hasK || Math.abs(n) < 1000) return Math.round(n * 1000);
    return Math.round(n);
  }

  function parseContractMoneyListToDollars(text) {
    var src = safeStr(text);
    if (!src) return [];
    var out = [];
    var re = /-?\d+(?:\.\d+)?\s*K?/ig;
    var m;
    while ((m = re.exec(src)) !== null) {
      var val = parseContractMoneyTokenToDollars(m[0]);
      if (val != null) out.push(val);
    }
    return out;
  }

  function parseContractInfoSummary(contractInfo) {
    var text = safeStr(contractInfo);
    var summary = {
      contract_length: null,
      aav_values_dollars: [],
      aav_current_dollars: null,
      y_by_year_dollars: {}
    };
    if (!text) return summary;

    var clMatch = text.match(/(?:^|\|)\s*CL\s*(\d+)/i);
    if (clMatch) {
      var cl = parseInt(clMatch[1], 10);
      if (isFinite(cl) && cl > 0) summary.contract_length = cl;
    }

    var aavMatch = text.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (aavMatch) {
      summary.aav_values_dollars = parseContractMoneyListToDollars(aavMatch[1]);
      if (summary.aav_values_dollars.length) {
        summary.aav_current_dollars = summary.aav_values_dollars[0];
      }
    }

    var yRe = /Y\s*(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?\s*K?)/ig;
    var ym;
    while ((ym = yRe.exec(text)) !== null) {
      var yearNum = parseInt(ym[1], 10);
      var sal = parseContractMoneyTokenToDollars(ym[2]);
      if (isFinite(yearNum) && yearNum > 0 && sal != null) {
        summary.y_by_year_dollars[String(yearNum)] = sal;
      }
    }
    return summary;
  }

  function roundToNearestK(v) {
    return Math.round(safeInt(v, 0) / 1000) * 1000;
  }

  function formatContractKToken(amount) {
    var dollars = Math.round(safeInt(amount, 0));
    if (dollars <= 0) return "0K";
    var k = dollars / 1000;
    var text = Math.round(k * 10) / 10;
    return (String(text).replace(/\.0$/, "")) + "K";
  }

  function tradePositionGroupKey(pos) {
    var p = safeStr(pos).toUpperCase();
    if (!p) return "OTHER";
    if (p === "DE" || p === "DT" || p === "DL" || p === "NT" || p === "EDGE" || p === "ED") return "DL";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    if (p === "K" || p === "PK") return "PK";
    if (p === "P" || p === "PN") return "PN";
    if (p === "QB" || p === "RB" || p === "WR" || p === "TE" || p === "LB") return p;
    return "OTHER";
  }

  function rookieLikeTradeContractStatus(value) {
    var status = safeStr(value).toLowerCase();
    return status === "r" || status.indexOf("r-") === 0 || status.indexOf("rookie") !== -1;
  }

  function tradeExtensionRaiseForAsset(asset, yearsToAdd) {
    var years = safeInt(yearsToAdd, 0);
    if (years !== 1 && years !== 2) return 0;
    var group = tradePositionGroupKey(asset && asset.position);
    var rec = PRETRADE_EXTENSION_RAISES[group] || PRETRADE_EXTENSION_RAISES.OTHER;
    return safeInt(rec && rec[years], 0);
  }

  function resolveAssetDisplayContractMetrics(asset) {
    var info = parseContractInfoSummary(asset && asset.contract_info);
    var contractLength = safeInt(asset && asset.contract_length, 0);
    if (!contractLength && info.contract_length) contractLength = safeInt(info.contract_length, 0);

    var contractYear = safeInt(asset && asset.contract_year, 0);
    if (contractYear <= 0) contractYear = 0;

    var yearsRemaining = asset && asset.years != null ? safeInt(asset.years, 0) : null;
    if (contractLength > 0) {
      if (contractYear > 0 && contractYear <= contractLength) {
        yearsRemaining = Math.max(contractLength - contractYear, 0);
      }
    }

    var currentAav = asset && asset.aav_current != null ? safeInt(asset.aav_current, 0) : null;
    if (currentAav == null && info.aav_current_dollars != null) {
      currentAav = safeInt(info.aav_current_dollars, 0);
    }
    if (currentAav == null && asset && safeInt(asset.salary, 0) > 0) {
      currentAav = safeInt(asset.salary, 0);
    }
    var futureAav = null;
    if (Array.isArray(info.aav_values_dollars) && info.aav_values_dollars.length > 1) {
      futureAav = safeInt(info.aav_values_dollars[info.aav_values_dollars.length - 1], 0);
      if (futureAav <= 0 || futureAav === currentAav) futureAav = null;
    }

    return {
      years_remaining: yearsRemaining,
      current_aav_dollars: currentAav,
      future_aav_dollars: futureAav,
      contract_type: safeStr(asset && asset.contract_type) || "—"
    };
  }

  function assetAllowsSyntheticExtension(asset, metrics) {
    if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") return false;
    // Per Keith 2026-05-24: once a franchise extends a player, THEY cannot
    // offer a pre-trade extension on that player again — even if canon §C4
    // would otherwise allow it. Stamped server-side (already_extended_by_this_
    // franchise) from ups_extension_master. Closes the Stroud + McBride class.
    if (parseBool(asset.already_extended_by_this_franchise, false)) return false;
    var type = safeStr(asset.contract_type).toLowerCase();
    var info = safeStr(asset.contract_info).toLowerCase();
    var yearsRemaining = metrics && metrics.years_remaining != null
      ? safeInt(metrics.years_remaining, 0)
      : safeInt(asset.years, 0);
    // Vet-ERA winners are blocked from the pre-trade extension while their MYAC
    // window is open (canon §A3 ~line 204: contractStatus=="Vet-ERA" AND now <
    // FA_Auction.contract_deadline — MYAC owns 1/2/3-yr length there). The
    // deadline isn't on the client, so block Vet-ERA outright: correct through
    // the Sept deadline, conservative after (worker re-validates on submit).
    if (type.indexOf("vet-era") !== -1) return false;
    // Same rule, the case canon's written gate missed: a Vet-FAA is MYAC-
    // eligible too. Canon §A2 — a fresh FA-auction win lands as a 1-year
    // default and "owners still convert to 2/3-year via the existing MYAC path
    // by the Sept contract deadline". So while that window is open, MYAC owns
    // the length decision on a Vet-FAA exactly as it does on a Vet-ERA, and a
    // pre-trade extension would double up the same authority (Keith 2026-08-06:
    // "guys that are MYAC eligible are not pre-trade-extension eligible until
    // after the contract deadline").
    //
    // Gate on the UNCONVERTED 1-year default (CL 1), not on the contract type.
    // A Vet-FAA that is already CL 2 or CL 3 has spent its MYAC — it is a normal
    // multi-year deal and stays extendable in its final year. Live counts
    // 2026-08-06: 158 CL-1 contracts sit in the window (149 Vet-FAA + 9
    // Vet-ERA); only the 9 were blocked, so 149 — Josh Allen and DeVonta Smith
    // among them — were being offered an extension they aren't entitled to.
    // The 24 CL-2/CL-3 Vet-FAAs in a final year keep working.
    if (type.indexOf("vet-faa") !== -1 && /(?:^|\|)\s*CL\s*:?\s*1\b/i.test(safeStr(asset.contract_info))) {
      return false;
    }
    if (type.indexOf("tag") !== -1) return false;
    if (info.indexOf("no further extensions") !== -1 || info.indexOf("not eligible for tag or extension") !== -1) {
      return false;
    }
    // A taxi-squad player is never an "expired rookie" for this purpose: a taxi
    // rookie whose years read <= 0 (e.g. an unrepaired draft-slot taxi on the
    // desktop) must NOT fall into the fresh-contract branch. A taxi player
    // heading into its FINAL year (years_remaining === 1) is still extendable
    // via the first branch, exactly like any other player (Keith 2026-06-12).
    return yearsRemaining === 1 || (rookieLikeTradeContractStatus(type) && yearsRemaining <= 0 && !parseBool(asset.taxi, false));
  }

  function buildSyntheticExtensionOptions(asset) {
    // THE BROWSER'S PREVIEW OF THE PRICE — for display only. The worker (worker/src/extension_pricing.js) prices every extension itself from the
    // player's CURRENT contract, refuses to store an offer whose terms differ (`extension_terms_stale`), and imports ITS price, never this one.
    // This function therefore mirrors the canonical rule exactly (canon §C4 / §C5.1), and offers nothing the worker would refuse:
    //   • a FINAL-YEAR contract only (years remaining = 1). Expired rookies are not priced (their base salary needs the draft-slot schedule);
    //   • the current year is NOT repriced: Y1 = the live current-year salary;
    //   • the escalator applies to the AAV of the extension years: future AAV = CURRENT AAV + raise (Schedule 1 QB/RB/WR/TE +10K/+20K,
    //     Schedule 2 DL/LB/DB/PK/PN +3K/+5K), rounded to $1K, never below $1K;
    //   • the current AAV is the contract's AAV TOKEN — its current (first) tier, verbatim (canon §C5.1: never recompute it, never average
    //     TCV ÷ CL when the token exists). No token: TCV ÷ CL. Neither: nothing is offered (fail closed, like the worker);
    //   • TCV = current salary + future AAV × years (forward-looking only); CL = 1 + years.
    if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") return [];
    var metrics = resolveAssetDisplayContractMetrics(asset);
    if (!assetAllowsSyntheticExtension(asset, metrics)) return [];

    var currentYears = Math.max(0, safeInt(metrics && metrics.years_remaining, 0));
    if (currentYears !== 1) return [];
    if (tradePositionGroupKey(asset && asset.position) === "OTHER") return [];
    var currentSalary = Math.max(1000, roundToNearestK(asset.salary));
    if (safeInt(asset.salary, 0) <= 0) return [];

    var extSummary = parseContractInfoSummary(asset && asset.contract_info);
    var aavBase = 0;
    if (extSummary.aav_values_dollars && extSummary.aav_values_dollars.length) {
      aavBase = roundToNearestK(extSummary.aav_values_dollars[0]);
    } else {
      var extCl = safeInt(asset && asset.contract_length, 0) || safeInt(extSummary.contract_length, 0);
      var extTcv = 0;
      var extYByYear = extSummary.y_by_year_dollars || {};
      for (var _yk in extYByYear) {
        if (Object.prototype.hasOwnProperty.call(extYByYear, _yk)) extTcv += safeInt(extYByYear[_yk], 0);
      }
      if (extCl > 0 && extTcv > 0) aavBase = roundToNearestK(extTcv / extCl);
    }
    if (!(aavBase > 0)) return [];

    var out = [];
    for (var yearsToAdd = 1; yearsToAdd <= 2; yearsToAdd += 1) {
      var futureSalary = Math.max(1000, roundToNearestK(aavBase + tradeExtensionRaiseForAsset(asset, yearsToAdd)));
      var totalLength = 1 + yearsToAdd;
      var yearParts = ["Y1-" + formatContractKToken(currentSalary)];
      for (var yearIdx = 2; yearIdx <= totalLength; yearIdx += 1) yearParts.push("Y" + yearIdx + "-" + formatContractKToken(futureSalary));
      var tcv = currentSalary + futureSalary * yearsToAdd;
      var previewInfo = [
        "CL " + totalLength,
        "TCV " + formatContractKToken(tcv),
        "AAV " + formatContractKToken(aavBase) + ", " + formatContractKToken(futureSalary),
        yearParts.join(", ")
      ].join("| ");
      out.push({
        option_key: String(yearsToAdd) + "YR|NONE",
        extension_term: String(yearsToAdd) + "YR",
        loaded_indicator: "NONE",
        preview_id: null,
        preview_contract_info_string: previewInfo,
        new_contract_status: yearsToAdd === 1 ? "EXT1" : "EXT2",
        new_contract_length: totalLength,
        new_TCV: tcv,
        new_aav_current: aavBase,
        new_aav_future: futureSalary,
        synthesized: true
      });
    }
    return out;
  }

  global.UPS_PRETRADE_EXT = {
    PRETRADE_EXTENSION_RAISES: PRETRADE_EXTENSION_RAISES,
    parseContractMoneyTokenToDollars: parseContractMoneyTokenToDollars,
    parseContractMoneyListToDollars: parseContractMoneyListToDollars,
    parseContractInfoSummary: parseContractInfoSummary,
    roundToNearestK: roundToNearestK,
    formatContractKToken: formatContractKToken,
    tradePositionGroupKey: tradePositionGroupKey,
    rookieLikeTradeContractStatus: rookieLikeTradeContractStatus,
    tradeExtensionRaiseForAsset: tradeExtensionRaiseForAsset,
    resolveAssetDisplayContractMetrics: resolveAssetDisplayContractMetrics,
    assetAllowsSyntheticExtension: assetAllowsSyntheticExtension,
    buildSyntheticExtensionOptions: buildSyntheticExtensionOptions
  };
})(typeof window !== "undefined" ? window : this);
