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
  // LEGACY — no longer used for any number an owner sees (2026-11-08, Keith: every screen shows what the worker and canon say).
  // Canonical rule (league_context_v1.md §D1, effective 2026-05-08) is PER-WEEK pro-rated earning from MFL's completed-week count, which
  // only the worker has. dropPenaltyEstimateRaw now quotes this file's own figure only BEFORE Sep 1 of the season (nothing of the season
  // is earned yet, so this function returns 0) and says "not priced yet" from Sep 1 on. Kept so the mirror still diffs against desktop.
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
  function isUnpricedCapRow(c) {
    return !!c && (c.penalty == null || c.basis === "week_authority_unresolved" || c.basis === "contract_unstamped_needs_review");
  }
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
    // app.js reads the batch when a screen that shows a penalty opens, once per
    // app load (ensureCapPenaltyPreview — one shared request). Ask it rather
    // than starting a second, identical read of our own.
    var data = window.UPS_MOBILE && window.UPS_MOBILE.data;
    if (data && data.ensureCapPenaltyPreview) { data.ensureCapPenaltyPreview(); return; }
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

  // The "$1K Per Yr" class (canon §A5 / §D1, Keith's 2026-09-26 ruling — worker/src/fcfs_contract.js `classifyFullYearRule`): a contract that pays exactly
  // $1,000 in EVERY contract year. TCV under $5K alone is NOT the class (a $4K one-year waiver deal is not "$1K a year").
  function isOneKPerYearPlayer(player) {
    var cl = contractLengthForPlayer(player), t = totalContractValueForPlayer(player);
    return safeInt(player && player.salary, 0) === 1000 && cl > 0 && cl <= 4 && t === 1000 * cl;
  }
  // Full-year rule: a "$1K Per Yr" contract has no weekly / cumulative earned amount, even in the pre-batch local estimate.
  function dropPenaltyEstimate(player, season) {
    var r = dropPenaltyEstimateRaw(player, season);
    // Only the PRE-BATCH local estimate is ever adjusted here: once the worker's authoritative row is loaded IT decides (a taxi $1K-per-year rookie keeps
    // its numeric earned there, and so it must here).
    if (r && !r.authoritative && !r.earnedRule && isOneKPerYearPlayer(player) && !(player && player.isTaxi)) {
      r = Object.assign({}, r, { earned: 0, priorEarned: 0, accrued: 0, earnedRule: "full_year", note: "Full-year rule: a $1K-per-year contract has no weekly or cumulative earned amount." });
    }
    return r;
  }
  function dropPenaltyEstimateRaw(player, season) {
    // SSOT: prefer the worker's authoritative penalty (cached batch).
    var __mPid = safeStr(player && player.id).replace(/\D/g, "");
    var __mAuth = authoritativeCapRow(__mPid);
    if (__mAuth) {
      var __mc = __mAuth;
      // UNPRICED: the worker could not price this drop yet (an MFL read failed, or the contract is unstamped) and sent
      // penalty null. That is NOT a $0 penalty: amount stays null with unpriced: true, and every screen says
      // "under review" and sorts it last — never "no penalty", never cap room computed as if it cost nothing.
      if (isUnpricedCapRow(__mc)) {
        return {
          amount: null, unpriced: true, authoritative: true,
          note: safeStr(__mc.review_reason) || "The worker could not price this drop yet. It is not $0.",
          tcv: safeInt(__mc.tcv, 0), guaranteed: null,
          currentYearSalary: safeInt(player && player.salary, 0),
          priorEarned: null, accrued: 0, earned: null
        };
      }
      if (__mc.earned_rule === "full_year_sub_5k") {
        // "$1K Per Yr" contract: dedicated full-year rule (canon §D1 + Keith's ruling) — no weekly / cumulative earned amount.
        return {
          amount: safeInt(__mc.penalty, 0),
          note: (__mc.exempt ? (__mc.exempt_reason || "Cap-free cut.") : "Flat $1K (multi-year sub-$5K).") + " Sub-$5K contract: the dedicated full-year rule applies — no weekly or cumulative earnings.",
          tcv: safeInt(__mc.tcv, 0), guaranteed: safeInt(__mc.guaranteed, 0),
          currentYearSalary: safeInt(player && player.salary, 0),
          priorEarned: 0, accrued: 0, earned: 0, earnedRule: "full_year", authoritative: true
        };
      }
      if (__mc.earned_rule === "ww_earned_na") {
        // canon §C3 "WW under $4K — earned n/a": the worker priced it cap-free and says earned is NOT APPLICABLE (not a weekly fraction, not $0).
        return {
          amount: safeInt(__mc.penalty, 0),
          note: (__mc.exempt_reason || "Cap-free cut.") + " Earned salary is not applicable to a WW pickup of $4K or less.",
          tcv: safeInt(__mc.tcv, 0), guaranteed: safeInt(__mc.guaranteed, 0),
          currentYearSalary: safeInt(player && player.salary, 0),
          priorEarned: 0, accrued: 0, earned: 0, earnedRule: "ww_na", authoritative: true
        };
      }
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
    // Cap-free cut protection follows TAXI ELIGIBILITY (the one taxi rule, site/shared/taxi_rule.js), not the roster
    // slot (Keith 2026-10-21, canon T5.2 / §D2): eligible immediately before the cut → $0 on taxi, active or mid
    // call-up; unknown → unpriced (never a guessed $0 or charge). The worker's priced row, once loaded, decides.
    var taxiData = window.UPS_MOBILE && window.UPS_MOBILE.data;
    var taxiVerdict = taxiData && taxiData.taxiStatusFor
      ? taxiData.taxiStatusFor(player && player.id, player && player.type, player && player.isTaxi, false) : null;
    if (taxiVerdict && taxiVerdict.eligible === null && /^rookie(-draft)?$/i.test(safeStr(player && player.type))) {
      return {
        amount: null, unpriced: true,
        note: "Taxi eligibility couldn't be confirmed, so this cut isn't priced here yet.",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    if (taxiVerdict ? taxiVerdict.eligible === true : (player && player.isTaxi)) {
      return {
        amount: 0,
        note: "Taxi-eligible: a cut is cap-free wherever the player sits (§D2 / T5.2), and the release ends taxi eligibility.",
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
    // Canon §D2 (worker rule 2): a WW pickup at $4,000 or less in its FINAL year is cap-free, whatever its total. (A multi-year WW with more than
    // one year left is priced by the sub-$5K rule below when its total is $4,000 or less, otherwise by guarantee minus earned.)
    if (/(^|-)WW($|-)/.test(type) && safeInt(player && player.salary, 0) <= 4000 && years <= 1) {
      return {
        amount: 0,
        note: "WW pickup of $4,000 or less in its final year: cap-free (canon §D2).",
        tcv: totalContractValue, guaranteed: guaranteed,
        currentYearSalary: currentYearSalary, priorEarned: priorEarned,
        accrued: accrued, earned: earned
      };
    }
    // Canon §D1 "Sub-$5K TCV rule" (Keith 2026-05-22): a contract with TCV of $4,000 or less is NOT priced by guarantee minus earned.
    // It is a FLAT $1,000 while more than one year remains, and cap-free in its final year (a 1-year deal is cap-free above). The worker
    // (_computeDropPenaltyRaw, isSubFiveKMultiYearFlat) charges exactly this, every week of the season. Without it this fallback ran the
    // per-week earned arithmetic and drifted: a CL 3, $1K-a-year deal read $1,000 in September, $750 in late October, $500 in November,
    // while the worker said $1,000 (the conditional-drop picker showed $500 until the worker's batch landed).
    if (totalContractValue > 0 && totalContractValue <= 4000 && contractLength > 1) {
      var subFiveKFlat = years > 1 ? 1000 : 0;
      return {
        amount: subFiveKFlat,
        note: subFiveKFlat > 0
          ? "Flat $1,000 (canon §D1): a multi-year contract with a total of $4,000 or less costs a fixed $1,000 while more than one year remains."
          : "Sub-$5K contract in its final year: cap-free (canon §D1).",
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
    // Guarantee minus earned depends on this season's COMPLETED-WEEK count (canon §D1, true per-week pro-rating), which only the worker has
    // (MFL's live scoring). From Sep 1 of the season on, this file therefore quotes NO number of its own: it says "not priced yet" until the
    // worker's number lands. It used to apply the legacy 2019-era calendar-quarter curve here, which differed from what the worker charges by
    // $1-3K (a $10K final-year contract read $0 on Nov 8 against the worker's $294). Before Sep 1 nothing of this season is earned yet, so the
    // figure below is exact: 75% of the total (rounded down, as the worker does) minus the years already played.
    if (now >= new Date(seasonNum, 8, 1)) {
      return {
        amount: null, unpriced: true,
        note: "Not priced yet: the drop penalty needs MFL's completed-week count, which comes from the league's calculation. It is not estimated here.",
        tcv: totalContractValue, guaranteed: null,
        currentYearSalary: currentYearSalary, priorEarned: null,
        accrued: 0, earned: null
      };
    }
    var guaranteedExact = Math.floor(totalContractValue * 0.75);
    var penalty = Math.max(0, guaranteedExact - priorEarned);
    var guaranteeLabel = "75% of TCV";

    return {
      amount: penalty,
      tcv: totalContractValue, guaranteed: guaranteedExact,
      currentYearSalary: currentYearSalary, priorEarned: priorEarned,
      accrued: 0, earned: priorEarned,
      note: penalty === 0
        ? "Current-rule guarantee has already been fully earned."
        : "Projected current-rule penalty: " + guaranteeLabel + " is " + money(guaranteedExact) + "; earned to date is " + money(priorEarned) + "."
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
