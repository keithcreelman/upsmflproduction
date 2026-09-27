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
    // Y-tokens are MFL's $K convention: "Y1-15K" AND bare "Y1-11" both mean
    // thousands. Always ×1000 (the worker's _parseContractData does the same) —
    // do NOT route through parseContractMoneyToken, which reads bare "11" as $11.
    var yearRe = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?)\s*K?/gi;
    while ((m = yearRe.exec(s))) {
      var idx = parseInt(m[1], 10);
      if (idx > 0) out.yearVals[idx] = Math.round((parseFloat(m[2]) || 0) * 1000);
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

  // The "$1K Per Yr" class (worker/src/fcfs_contract.js `classifyFullYearRule`; Keith's ruling): a contract that pays exactly $1,000 in EVERY contract
  // year has no weekly and no cumulative earned salary. TCV under $5K alone is NOT the class. `sal` is the MFL salaries row (salary + contractInfo).
  function isOneKPerYear(sal, info) {
    var raw = String((sal && sal.contractInfo) || '');
    info = info || parseContractInfo(raw);
    var len = info.length || 0;
    var salary = parseInt(sal && sal.salary, 10) || 0;
    if (len < 1 || len > 4 || salary !== 1000 || info.tcv !== 1000 * len) return false;
    var m = raw.match(/(?:^|\|)\s*AAV\s+([^|]+)/i);
    if (m) { var tiers = m[1].split(','); for (var i = 0; i < tiers.length; i++) if (parseContractMoneyToken(tiers[i]) !== 1000) return false; }
    var n = 0;
    for (var k in info.yearVals) { n += 1; if (info.yearVals[k] !== 1000) return false; }
    return !n || n === len;
  }

  // canon §C3 "WW under $4K — earned n/a" (worker/src/fcfs_contract.js `classifyWwEarnedNa`): a ONE-YEAR ORIGINAL pure-WW contract (WW / Vet-WW / Rookie-WW — not a
  // WW-MYM) of $4,000 or less, TCV = salary, in its final year, not taxi. A $1,000-a-year deal is the full-year class, which wins. Unknown years remaining (a blank
  // contractYear) is UNKNOWN, never "final year": a claim MFL has not made is not shown.
  function isWwEarnedNa(sal, info) {
    if (!sal || isOneKPerYear(sal, info)) return false;
    if (sal.isTaxi || /taxi/i.test(String(sal.status || ''))) return false;
    if (!/^(Vet-|Rookie-)?WW$/i.test(String(sal.contractStatus || sal.type || '').trim())) return false;
    info = info || parseContractInfo(String(sal.contractInfo || ''));
    var salary = parseInt(sal.salary, 10) || 0;
    var cyRaw = String(sal.contractYear == null ? '' : sal.contractYear).trim();
    return salary > 0 && salary <= 4000 && info.length === 1 && info.tcv === salary && cyRaw !== '' && parseInt(cyRaw, 10) === 1;
  }

  // Authoritative cap penalty = the worker's /api/cap-penalty/preview (the SAME
  // _computeDropPenalty the cron charges with — taxi/WW/sub-$5K exemptions +
  // in-season per-week earning this client can't derive). Batch-fetched once per
  // season + cached; dropPenalty() returns the cached value by player id, firing
  // "ups-cap-penalty-ready" on arrival so consumers can repaint.
  var WORKER_BASE = 'https://upsmflproduction.keith-creelman.workers.dev';
  var __capBatch = null, __capBatchKey = '', __capBatchLoading = false;
  function loadCapBatch(season) {
    var y = String(season || (new Date().getFullYear())).replace(/\D/g, '');
    if (!y || __capBatchLoading || (__capBatch && __capBatchKey === y)) return;
    __capBatchLoading = true;
    try {
      fetch(WORKER_BASE + '/api/cap-penalty/preview?L=74598&YEAR=' + y, { credentials: 'omit', cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (p) {
          if (p && p.ok && p.players) {
            __capBatch = p.players; __capBatchKey = y;
            try { global.dispatchEvent(new Event('ups-cap-penalty-ready')); } catch (_) {}
          }
        })
        .catch(function () {})
        .then(function () { __capBatchLoading = false; });
    } catch (_) { __capBatchLoading = false; }
  }
  function workerPenalty(sal, season) {
    var pid = String((sal && sal.id) || '').replace(/\D/g, '');
    if (__capBatch && pid && __capBatch[pid]) return __capBatch[pid].penalty;
    loadCapBatch(season);
    return null;
  }

  // Cap-penalty (2019+): (TCV × 75%) − Earned, floor 0, with canon §D2 exemptions.
  // Prefers the authoritative worker value; the local fallback (used until the
  // batch loads, and for historical/off-roster players) mirrors the worker's
  // exemptions so it's correct offseason. Pre-2019 → null so the UI renders "—".
  function dropPenalty(sal, opts) {
    opts = opts || {};
    var wp = workerPenalty(sal, opts.season);
    if (wp != null) return wp;
    var info = parseContractInfo(sal && sal.contractInfo);
    var tcv = info.tcv;
    if (!tcv) return opts.suppressPreEra2019 ? null : 0;
    if (opts.suppressPreEra2019) {
      var seasonNum = Number(opts.season) || (new Date().getFullYear());
      if (seasonNum < 2019) return null;
    }
    var salary = Math.max(0, parseInt(sal && sal.salary, 10) || 0);
    var status = String((sal && (sal.contractStatus || sal.type)) || '');
    var cl = info.length || 0;
    var cy = parseInt(sal && sal.contractYear, 10) || 0; // years remaining
    var isTaxi = !!(sal && (sal.isTaxi || /taxi/i.test(String(sal.status || ''))));
    if (isTaxi) return 0;                                              // §D2 taxi
    if (/(^|-)WW($|-)/i.test(status) && salary <= 4000 && cy <= 1) return 0;      // §D2 WW ≤ $4K in its final year (a multi-year WW falls through to the flat sub-$5K rule, exactly like the worker)
    if (cl === 1 && tcv <= 4000) return 0;                            // §D2 1-yr orig < $5K
    if (tcv <= 4000) return (cy >= 2 ? 1000 : 0);                     // §D2 sub-$5K override
    var earned = earnedToDate(sal, info);
    return Math.max(0, Math.round(tcv * 0.75) - earned);
  }

  global.UPS_CAP_MATH = {
    parseContractMoneyToken: parseContractMoneyToken,
    parseContractInfo: parseContractInfo,
    earnedToDate: earnedToDate,
    isOneKPerYear: isOneKPerYear,
    isWwEarnedNa: isWwEarnedNa,
    dropPenalty: dropPenalty
  };
})(typeof window !== 'undefined' ? window : this);
