/* site/m/front_office_penalty.js
 *
 * VERBATIM MIRROR of the drop-penalty calculation used by the Front Office
 * tab in site/rosters/roster_workbench.js. The functions below are the
 * EXACT logic that produces the projected-drop-penalty number a UPS owner
 * sees on their Roster Workbench Contracts view today.
 *
 * DO NOT EDIT the helper bodies. If the desktop calc changes, copy the
 * updated functions here verbatim. Source-of-truth lives in
 * site/rosters/roster_workbench.js, lines:
 *   safeStr (201) · safeNum (220) · safeInt (226) · money (331)
 *   parseContractMoneyToken (346) · formatContractK (361)
 *   parseContractAavValues (369) · parseContractTcvValue (384)
 *   parseContractGuaranteeValue (392) · parseContractLengthValue (400)
 *   currentAavForContractInfo (483) · parseContractYearValues (1604)
 *   contractLengthForPlayer (1618) · contractYearIndexForPlayer (1631)
 *   currentContractYearValue (1638) · contractYearFallbackValue (1662)
 *   contractYearValueMapForPlayer (1680) · totalContractValueForPlayer (1693)
 *   guaranteedContractValueForPlayer (1711) · earnedBeforeCurrentContractYear (1726)
 *   earnedToDateBreakdownForPlayer (1748) · seasonEndEstimateDate (1771)
 *   proratedEarnedForDrop (1777) · acquisitionTextForPlayer (1795)
 *   isLikelyWaiverPickup (1807) · isTagCutPreAuctionAssumption (1820)
 *   dropPenaltyEstimate (1830)
 *
 * The only mobile-specific glue is at the bottom (`adaptRosterRow` and the
 * `window.UPS_FRONT_OFFICE` export). The functions otherwise match desktop.
 *
 * INTENTIONAL DIVERGENCE (2026-07-30, in-app waivers):
 *   dropPenaltyEstimate no longer carries the flat 35%-of-salary WW branch.
 *   That rule was retired by league_context_v1.md §D1.4 on 2026-05-08 and the
 *   worker has never used it. Everything an owner actually sees now comes from
 *   /api/cap-penalty/preview (state.capPenaltyByPid) anyway; this local math is
 *   an OFFLINE FALLBACK only, and it should not quote a number the worker would
 *   never charge. Desktop roster_workbench.js still has the 35% branch in its
 *   own fallback — see memory project_ww_penalty_prorate_migration.md — so if
 *   you are syncing this file from desktop, do NOT copy that branch back.
 */
(function () {
  "use strict";

  // ── BEGIN verbatim mirror from roster_workbench.js ──────────────────────

  function safeStr(v) {
    return v == null ? "" : String(v).trim();
  }
  function safeNum(v, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function safeInt(v, fallback) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return fallback == null ? 0 : fallback;
    return n;
  }
  function money(n) {
    var v = Math.round(safeNum(n, 0));
    var sign = v < 0 ? "-" : "";
    var abs = Math.abs(v);
    try {
      return sign + "$" + abs.toLocaleString("en-US");
    } catch (e) {
      return sign + "$" + String(abs);
    }
  }
  function parseContractMoneyToken(token) {
    var raw = safeStr(token).toUpperCase().replace(/\$/g, "");
    if (!raw) return 0;
    var cleaned = raw.replace(/[^0-9K.\-]/g, "");
    if (!cleaned) return 0;
    var mult = cleaned.indexOf("K") !== -1 ? 1000 : 1;
    cleaned = cleaned.replace(/K/g, "");
    if (!cleaned) return 0;
    var num = Number(cleaned);
    if (!isFinite(num)) return 0;
    var amount = Math.round(num * mult);
    if (mult === 1 && amount > 0 && amount < 1000) amount *= 1000;
    return amount;
  }
  function parseContractAavValues(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return [];
    var match = info.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return [];
    var segment = safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "");
    return segment
      .split(/[\/,]/)
      .map(function (token) {
        var moneyMatch = safeStr(token).match(/-?\d+(?:\.\d+)?K?/i);
        return parseContractMoneyToken(moneyMatch ? moneyMatch[0] : "");
      })
      .filter(function (amount) { return amount > 0; });
  }
  function parseContractTcvValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*TCV\s+([^|]+)/i);
    if (!match || !safeStr(match[1])) return 0;
    return parseContractMoneyToken(match[1]);
  }
  function parseContractGuaranteeValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i);
    if (!match || !safeStr(match[1])) return 0;
    return parseContractMoneyToken(match[1]);
  }
  function parseContractLengthValue(contractInfo) {
    var info = safeStr(contractInfo);
    if (!info) return 0;
    var match = info.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
    return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
  }
  function currentAavForContractInfo(contractInfo) {
    var values = parseContractAavValues(contractInfo);
    return values.length ? safeInt(values[0], 0) : 0;
  }
  function parseContractYearValues(contractInfo) {
    var info = safeStr(contractInfo);
    var out = Object.create(null);
    if (!info) return out;
    var re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)(?=\s*(?:,|\||Y\d+\s*-|$))/ig;
    var match;
    while ((match = re.exec(info))) {
      var idx = safeInt(match[1], 0);
      var amount = parseContractMoneyToken(match[2]);
      if (idx > 0 && amount > 0) out[idx] = amount;
    }
    return out;
  }
  function contractLengthForPlayer(player) {
    var values = parseContractYearValues(player && player.special);
    var keys = Object.keys(values);
    var explicitLength = parseContractLengthValue(player && player.special);
    var parsedLength = 0;
    if (keys.length) {
      parsedLength = keys.reduce(function (max, key) {
        return Math.max(max, safeInt(key, 0));
      }, 0);
    }
    return Math.max(parsedLength, explicitLength, Math.max(0, safeInt(player && player.years, 0)));
  }
  function contractYearIndexForPlayer(player) {
    var length = contractLengthForPlayer(player);
    var years = Math.max(0, safeInt(player && player.years, 0));
    if (length <= 0 || years <= 0) return 0;
    return Math.max(1, length - years + 1);
  }
  function currentContractYearValue(player) {
    var yearValues = parseContractYearValues(player && player.special);
    var idx = contractYearIndexForPlayer(player);
    if (idx > 0 && yearValues[idx] > 0) return safeInt(yearValues[idx], 0);
    return Math.max(0, safeInt(player && player.salary, 0));
  }
  function contractYearFallbackValue(player, yearIndex) {
    var idx = Math.max(1, safeInt(yearIndex, 1));
    var currentIdx = Math.max(1, contractYearIndexForPlayer(player));
    var length = Math.max(0, contractLengthForPlayer(player));
    var salary = Math.max(0, safeInt(player && player.salary, 0));
    var aavValues = parseContractAavValues(player && player.special);
    var aav = Math.max(0, safeInt(player && player.aav, 0) || currentAavForContractInfo(player && player.special));
    if (idx === currentIdx && salary > 0) return salary;
    if (aavValues[idx - 1] > 0) return safeInt(aavValues[idx - 1], 0);
    if (aavValues.length > 1 && aavValues[aavValues.length - 1] > 0) {
      return safeInt(aavValues[aavValues.length - 1], 0);
    }
    if (aav > 0) return aav;
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0 && length > 0) return Math.round(explicitTcv / Math.max(1, length));
    return salary;
  }
  function contractYearValueMapForPlayer(player) {
    var out = parseContractYearValues(player && player.special);
    var keys = Object.keys(out);
    if (keys.length) return out;

    var length = Math.max(0, contractLengthForPlayer(player));
    for (var i = 1; i <= length; i += 1) {
      var amount = contractYearFallbackValue(player, i);
      if (amount > 0) out[i] = amount;
    }
    return out;
  }
  function totalContractValueForPlayer(player) {
    var explicitTcv = parseContractTcvValue(player && player.special);
    if (explicitTcv > 0) return explicitTcv;

    var yearValues = contractYearValueMapForPlayer(player);
    var keys = Object.keys(yearValues);
    if (keys.length) {
      var total = 0;
      for (var i = 0; i < keys.length; i += 1) {
        total += safeInt(yearValues[keys[i]], 0);
      }
      if (total > 0) return total;
    }

    var length = Math.max(0, contractLengthForPlayer(player));
    return contractYearFallbackValue(player, 1) * length;
  }
  function guaranteedContractValueForPlayer(player) {
    var explicitGuarantee = parseContractGuaranteeValue(player && player.special);
    if (explicitGuarantee > 0) return explicitGuarantee;

    var total = totalContractValueForPlayer(player);
    if (total <= 0) return 0;

    if (total <= 4000) {
      var firstYear = safeInt(contractYearValueMapForPlayer(player)[1], contractYearFallbackValue(player, 1));
      return Math.max(0, total - Math.max(0, firstYear));
    }

    return Math.round(total * 0.75);
  }
  function earnedBeforeCurrentContractYear(player) {
    var idx = contractYearIndexForPlayer(player);
    if (idx <= 1) return 0;

    var explicitYearValues = parseContractYearValues(player && player.special);
    if (!Object.keys(explicitYearValues).length) {
      var length = contractLengthForPlayer(player);
      var total = totalContractValueForPlayer(player);
      var currentYearSalary = currentContractYearValue(player);
      if (length > 1 && idx >= length && total > currentYearSalary) {
        return Math.max(0, total - Math.max(0, currentYearSalary));
      }
    }

    var earned = 0;
    var yearValues = contractYearValueMapForPlayer(player);
    for (var i = 1; i < idx; i += 1) {
      earned += safeInt(yearValues[i], contractYearFallbackValue(player, i));
    }
    return earned;
  }
  function seasonEndEstimateDate(season) {
    var yr = safeInt(season, 0);
    if (yr <= 0) return null;
    return new Date(yr, 11, 31, 23, 59, 59, 999);
  }
  // !!! TABLED CROSS-CODEBASE MIGRATION — DO NOT FIX IN MOBILE-ONLY PATCH !!!
  // Canonical rule (league_context_v1.md §6B, effective 2026-05-08) is
  // PER-WEEK pro-rated earning: earned = (completed_eligible_weeks /
  // total_eligible_weeks) × year's salary, with the denominator anchored
  // to the acquisition week (17 for auction, 18-W for week-W pickups).
  // This function uses LEGACY 2019-era calendar-quarter milestones,
  // matching the same legacy code in roster_workbench.js:1777 verbatim.
  //
  // The worker DOES use per-week math (worker/src/lib/cap_penalty.js
  // earnedPerWeek) for actual cap charges. So this function's output is
  // a CLIENT-SIDE PREVIEW that drifts from what the worker will charge
  // by roughly $1-3K depending on drop week.
  //
  // Audit (2026-05-16) confirmed: drift is in BOTH desktop + mobile,
  // tabled by Keith via memory project_ww_penalty_prorate_migration.md.
  // Mobile must NOT diverge from desktop on this — fix cross-codebase or
  // not at all. See worker/src/lib/cap_penalty.js for the canonical model.
  function proratedEarnedForDrop(season, amount, dropDate) {
    var yr = safeInt(season, 0);
    var salary = Math.max(0, safeInt(amount, 0));
    if (yr <= 0 || salary <= 0 || !(dropDate instanceof Date) || isNaN(dropDate.getTime())) return 0;
    var milestones = [
      new Date(yr, 8, 30, 23, 59, 59, 999),
      new Date(yr, 9, 31, 23, 59, 59, 999),
      new Date(yr, 10, 30, 23, 59, 59, 999),
      seasonEndEstimateDate(yr)
    ];
    var earnedSteps = 0;
    for (var i = 0; i < milestones.length; i += 1) {
      if (milestones[i] && dropDate >= milestones[i]) earnedSteps += 1;
    }
    earnedSteps = Math.max(0, Math.min(earnedSteps, 4));
    return Math.round((salary / 4) * earnedSteps);
  }
  function earnedToDateBreakdownForPlayer(player, season, now) {
    var years = Math.max(0, safeInt(player && player.years, 0));
    var total = totalContractValueForPlayer(player);
    if (years <= 0) {
      return {
        currentYearSalary: 0,
        priorEarned: total,
        accrued: 0,
        earned: total
      };
    }

    var currentYearSalary = currentContractYearValue(player);
    var priorEarned = earnedBeforeCurrentContractYear(player);
    var accrued = proratedEarnedForDrop(season, currentYearSalary, now);
    return {
      currentYearSalary: currentYearSalary,
      priorEarned: priorEarned,
      accrued: accrued,
      earned: priorEarned + accrued
    };
  }
  function acquisitionTextForPlayer(player) {
    return safeStr(
      player && (
        player.acquisitionText ||
        player.acquisition_text ||
        player.notes ||
        player.acquired ||
        player.acquiredText
      )
    ).toUpperCase();
  }
  function isLikelyWaiverPickup(player) {
    var type = safeStr(player && player.type).toUpperCase();
    var acquisition = acquisitionTextForPlayer(player);
    return !!(
      type.indexOf("WW") !== -1 ||
      acquisition.indexOf("BBID_WAIVER") !== -1 ||
      acquisition.indexOf("WAIVER") !== -1 ||
      acquisition.indexOf(" BB ") !== -1 ||
      acquisition.indexOf("BB $") !== -1 ||
      acquisition.indexOf("BB$") !== -1
    );
  }
  function isTagCutPreAuctionAssumption(player, season, now) {
    var type = safeStr(player && player.type).toUpperCase();
    if (type !== "TAG") return false;
    var yr = safeInt(season, 0);
    if (yr <= 0 || !(now instanceof Date) || isNaN(now.getTime())) return false;
    if (now.getFullYear() < yr) return true;
    if (now.getFullYear() > yr) return false;
    return now < new Date(yr, 7, 1, 0, 0, 0, 0);
  }
  // ── Cap-penalty SSOT (mirrors desktop roster_workbench.js) ────────────────
  // The ONLY authoritative penalty is the worker's /api/cap-penalty/preview —
  // the SAME _computeDropPenalty the hourly cron uses to post real charges
  // (canon §6/§D2: 75% guarantee minus per-week pro-rated earnings; WW ≤ $4K,
  // taxi, and 1-yr-under-$5K are exempt). app.js fetches the BATCH once per
  // load into state.capPenaltyByPid; we read it synchronously here so every
  // mobile surface (drop picker, player-sheet Drop label, waiver conditional
  // drops) shows the number the owner will actually be charged.
  //
  // __mCapCache is a self-heal for the case where this file is used without
  // app.js having populated state yet; it dispatches "ups-cap-penalty-ready"
  // so the router repaints once the real numbers land.
  var __mCapCache = null, __mCapKey = "", __mCapLoading = false;
  function mobileCtx() {
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    return (s && s.ctx) || null;
  }
  // Authoritative batch, app-owned first, then this file's own fetch.
  function authoritativeCapRow(pid) {
    if (!pid) return null;
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    if (s && s.capPenaltyByPid && s.capPenaltyByPid[pid]) return s.capPenaltyByPid[pid];
    if (__mCapCache && __mCapCache[pid]) return __mCapCache[pid];
    return null;
  }
  function loadMobileCapCache(season) {
    var seasonStr = String(season || "").replace(/\D/g, "");
    if (!seasonStr || __mCapLoading) return;
    if (__mCapCache && __mCapKey === seasonStr) return;
    // If app.js already owns the batch for this season there's nothing to do.
    var s = window.UPS_MOBILE && window.UPS_MOBILE.state;
    if (s && s.capPenaltyByPid) return;
    __mCapLoading = true;
    // League id comes from the live app context — hardcoding 74598 broke the
    // preview for any other league (test league L=25625 included).
    var ctx = mobileCtx();
    var leagueId = String((ctx && ctx.leagueId) || "74598").replace(/\D/g, "") || "74598";
    var url = "https://upsmflproduction.keith-creelman.workers.dev/api/cap-penalty/preview?L=" +
      encodeURIComponent(leagueId) + "&YEAR=" + encodeURIComponent(seasonStr);
    fetch(url, { credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (payload && payload.ok && payload.players) {
          __mCapCache = payload.players; __mCapKey = seasonStr;
          try { window.dispatchEvent(new Event("ups-cap-penalty-ready")); } catch (_) {}
        }
      })
      .catch(function () {})
      .then(function () { __mCapLoading = false; });
  }

  function dropPenaltyEstimate(player, season) {
    // SSOT: prefer the worker's authoritative penalty (cached batch).
    var __mPid = safeStr(player && player.id).replace(/\D/g, "");
    var __mAuth = authoritativeCapRow(__mPid);
    if (__mAuth) {
      var __mc = __mAuth;
      var __me = safeInt(__mc.earned, 0);
      return {
        amount: safeInt(__mc.penalty, 0),
        note: __mc.exempt ? (__mc.exempt_reason || "Cap-free cut.")
          : ("75% guarantee (" + money(safeInt(__mc.guaranteed, 0)) + ") minus earned (" + money(__me) + ")."),
        tcv: safeInt(__mc.tcv, 0), guaranteed: safeInt(__mc.guaranteed, 0),
        currentYearSalary: safeInt(player && player.salary, 0),
        priorEarned: __me, accrued: 0, earned: __me, authoritative: true
      };
    }
    loadMobileCapCache(season);
    var years = Math.max(0, safeInt(player && player.years, 0));
    var seasonNum = safeInt(season, new Date().getFullYear());
    var now = new Date();
    var totalContractValue = totalContractValueForPlayer(player);
    var earnedBreakdown = earnedToDateBreakdownForPlayer(player, seasonNum, now);
    var currentYearSalary = earnedBreakdown.currentYearSalary;
    var priorEarned = earnedBreakdown.priorEarned;
    var accrued = earnedBreakdown.accrued;
    var earned = earnedBreakdown.earned;
    var contractLength = Math.max(0, contractLengthForPlayer(player));
    var explicitGuarantee = parseContractGuaranteeValue(player && player.special);
    var guaranteed = guaranteedContractValueForPlayer(player);

    if (years <= 0) {
      return {
        amount: 0,
        note: "Expired contracts do not carry a projected cap penalty.",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    if (player && player.isTaxi) {
      return {
        amount: 0,
        note: "Taxi players are shown with salary but do not project a current cap penalty.",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    if (isTagCutPreAuctionAssumption(player, seasonNum, now)) {
      return {
        amount: 0,
        note: "Pre-auction tag cut assumption: projected cap penalty is $0. Once auction opens, standard earned-salary rules apply.",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    var type = safeStr(player && player.type).toUpperCase();
    if (contractLength === 1 && currentYearSalary < 5000 && (/^VET/.test(type) || type.indexOf("WW") !== -1)) {
      return {
        amount: 0,
        note: "One-year veteran/waiver contracts under $5,000 are cap-free cuts under the current rule.",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    // The flat 35%-of-salary WW short-circuit that used to live here has been
    // REMOVED (2026-07-30, in-app waivers). league_context_v1.md §D1.4
    // (effective 2026-05-08) retired that rule: a WW pickup at $5K+ earns the
    // same treatment as any other contract — 75% × TCV minus per-week
    // pro-rated earnings — which is exactly what `guaranteed - earned` below
    // computes, and exactly what the worker's _computeDropPenalty (and the
    // cron that posts the real charge) does. Keeping 35% here meant an owner
    // could be quoted $3,500 on a $10K waiver claim and then be charged
    // $7,500. The cheap-WW exemption is unaffected — it is handled by the
    // 1-yr-under-$5K branch above (canon: a WW deal ≤ $4K is a cap-free cut).
    // isLikelyWaiverPickup() is deliberately left in place: this file is a
    // verbatim mirror of roster_workbench.js and dropping the helper would
    // make the next diff against desktop harder to read. It is now unused.
    var penalty = Math.max(0, guaranteed - earned);
    var guaranteeLabel = explicitGuarantee > 0
      ? "contract guarantee"
      : (totalContractValue <= 4000 ? "TCV minus year 1 salary" : "75% of TCV");
    return {
      amount: penalty,
      tcv: totalContractValue, guaranteed: guaranteed,
      currentYearSalary: currentYearSalary, priorEarned: priorEarned,
      accrued: accrued, earned: earned,
      note: penalty === 0
        ? "Current-rule guarantee has already been fully earned."
        : "Projected current-rule penalty: " + guaranteeLabel + " is " + money(guaranteed) + "; earned to date is " + money(earned) + "."
    };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // Mobile-specific adapter: mobile state stores roster rows with MFL field
  // names (contractYear, contractInfo, contractStatus, status). Desktop's
  // calc expects (years, special, type, isTaxi). This translates.
  function adaptRosterRow(rosterRow, fid) {
    if (!rosterRow) return null;
    return {
      id: rosterRow.id,
      years: rosterRow.contractYear,                       // → player.years
      salary: rosterRow.salary,                            // → player.salary
      special: rosterRow.contractInfo,                     // → player.special
      type: rosterRow.contractStatus,                      // → player.type
      isTaxi: /taxi/i.test(String(rosterRow.status || "")),// → player.isTaxi
      isIr: /ir|injured/i.test(String(rosterRow.status || "")),
      // fid is REQUIRED by extensionBlockedByCurrentOwner so it can
      // resolve the current owning franchise via findFranchiseById.
      // Caller must pass viewerFranchiseId (or row.franchise_id when
      // browsing another team's roster) — adapter doesn't infer it
      // because rosterRow itself doesn't carry the owning fid.
      fid: fid || rosterRow.fid || rosterRow.franchise_id || ""
    };
  }

  // Public API for mobile consumers. dropPenaltyFor takes a mobile rosterRow
  // (not a desktop player object) for convenience.
  window.UPS_FRONT_OFFICE = {
    adaptRosterRow: adaptRosterRow,
    dropPenaltyEstimate: dropPenaltyEstimate,
    dropPenaltyFor: function (rosterRow, season) {
      return dropPenaltyEstimate(adaptRosterRow(rosterRow), season);
    }
  };
})();
