/* cap_math.js — UPS league cap-math source of truth.

   Issue #244 (Audit Phase 2B). Same calc — parsing MFL contractInfo
   Y-tokens, summing earned-to-date, computing the (TCV * 75%) - earned
   cap penalty — used to live as four separate copies (team_operations,
   player_profile_master, mobile contracts view, plus the Front Office
   workbench). They drifted, which is how the Coleman bug shipped: the
   Master modal showed $11K cap penalty while Front Office showed
   $1,250, because two copies had the wrong Y-token regex (Y1=... /
   Y1:... instead of UPS's actual Y1-...).

   This module is the canonical implementation for the team_operations
   Overview legacy modal, the player_profile_master modal, and the
   mobile My Team view. Front Office (roster_workbench.js) has a
   richer version that also handles taxi/waiver/pre-auction-tag/era
   logic against its internal player.special object; it does NOT
   delegate here yet. If FO behavior diverges in the future, port it
   in.

   Inputs come from the MFL salaries export row:
     { contractInfo, contractYear, salary }
   where contractYear is YEARS REMAINING (cy=1 = last year, cy=0
   expired). Output values are in DOLLARS (matching MFL's
   thousand-of-dollars convention; "10K" -> 10000).

   Loaded via window.UPS_CAP_MATH global, ahead of the team_operations
   + player_profile_master scripts (see mfl_hpm_embed_loader.js).
*/
(function (global) {
  'use strict';

  function parseContractMoneyToken(token) {
    var s = String(token || '').trim().toUpperCase();
    if (!s) return 0;
    s = s.replace(/[$,]/g, '');
    var mult = 1;
    if (/K$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/M$/.test(s)) { mult = 1000000; s = s.slice(0, -1); }
    var n = Number(s);
    return Number.isFinite(n) ? Math.round(n * mult) : 0;
  }

  // Parses an MFL contractInfo string into structured fields.
  // Returns { tcv, length, yearVals, aav, gtd } where yearVals is
  // a sparse map { 1: 5000, 2: 10000, ... } keyed by 1-based year
  // index. Empty/missing tokens become 0 / {}.
  //
  // Y-token format is "Y1-5K, Y2-10K" (DASH, not "=" or ":"). The
  // wrong regex variant is what caused PR #240/#241.
  function parseContractInfo(info) {
    var s = String(info || '');
    var out = { tcv: 0, length: 0, yearVals: {}, aav: 0, gtd: 0 };
    if (!s) return out;
    var m;
    if ((m = s.match(/(?:^|\|)\s*TCV\s+([^|]+)/i))) out.tcv = parseContractMoneyToken(m[1]);
    if ((m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i))) out.length = parseInt(m[1], 10) || 0;
    if ((m = s.match(/(?:^|\|)\s*AAV\s+([^|]+)/i))) out.aav = parseContractMoneyToken(m[1]);
    if ((m = s.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i))) out.gtd = parseContractMoneyToken(m[1]);
    var yearRe = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)/gi;
    while ((m = yearRe.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (idx > 0) out.yearVals[idx] = parseContractMoneyToken(m[2]);
    }
    return out;
  }

  // Sum of salaries already earned in prior contract years.
  // Canon §D1: prior-year salaries are 100% earned post-rollover.
  // Three paths:
  //   1. Explicit Y-tokens present -> sum Y[1..played]
  //   2. Final year, no Y-tokens -> TCV minus current-year salary
  //   3. Mid-contract, no Y-tokens -> assume even split (TCV / length)
  function earnedToDate(sal, info) {
    info = info || parseContractInfo(sal && sal.contractInfo);
    var len = info.length || 0;
    var cy = parseInt(sal && sal.contractYear, 10) || 0; // years remaining
    if (len <= 0 || cy <= 0) return 0;

    var played = Math.max(0, len - cy);
    var earned = 0;
    var hasYearVals = false;
    for (var i = 1; i <= played; i++) {
      if (info.yearVals[i] > 0) {
        earned += info.yearVals[i];
        hasYearVals = true;
      }
    }
    if (hasYearVals) return earned;

    if (cy === 1 && info.tcv > 0) {
      var currentSal = Math.max(0, parseInt(sal && sal.salary, 10) || 0);
      return Math.max(0, info.tcv - currentSal);
    }
    if (info.tcv > 0 && played > 0) {
      var perYear = Math.round(info.tcv / len);
      return perYear * played;
    }
    return 0;
  }

  // Modern UPS cap-penalty formula (2019+): (TCV * 75%) - Earned. Floor 0.
  // Pre-2019 era has materially smaller cap hits with no fully codified
  // formula — when opts.suppressPreEra2019 is true we return null so the
  // UI can render "—" rather than a wrong number.
  function dropPenalty(sal, opts) {
    opts = opts || {};
    var info = parseContractInfo(sal && sal.contractInfo);
    var tcv = info.tcv;
    if (!tcv) return opts.suppressPreEra2019 ? null : 0;
    if (opts.suppressPreEra2019) {
      var seasonNum = Number(opts.season) || (new Date().getFullYear());
      if (seasonNum < 2019) return null;
    }
    var earned = earnedToDate(sal, info);
    return Math.max(0, Math.round(tcv * 0.75) - earned);
  }

  global.UPS_CAP_MATH = {
    parseContractMoneyToken: parseContractMoneyToken,
    parseContractInfo: parseContractInfo,
    earnedToDate: earnedToDate,
    dropPenalty: dropPenalty
  };
})(typeof window !== 'undefined' ? window : this);
