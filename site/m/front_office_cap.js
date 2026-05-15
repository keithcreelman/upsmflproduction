/* site/m/front_office_cap.js
 *
 * VERBATIM MIRROR of the cap math used by Team Operations / Front Office.
 * Includes:
 *   1. MFL salaryAdjustments feed (Team Ops convention)
 *   2. The salary_adjustments_<year>.json report ledger
 *      (Roster Workbench's mergeReportSalaryAdjustmentsIntoTeams).
 *
 * DO NOT EDIT logic. Source-of-truth:
 *   site/team_operations/team_operations.js
 *     safeStr (19) · pad4 (20) · asArray (39)
 *     getMyAdjustmentTotal (378-392)
 *     getMySalaries (394-423)
 *     renderCaps cap math (660-708) → computeCapMath
 *   site/rosters/roster_workbench.js
 *     reportSalaryAdjustmentBucket (4064) · reportSalaryAdjustmentImportEligible (4073)
 *     normalizeReportSalaryAdjustmentRow (4132)
 *     toReportSalaryAdjustmentSummary (4170)
 *     mergeReportSalaryAdjustmentsIntoTeams (4193)
 *     resolveSalaryAdjustmentLedgerUrl (~2410)
 *     loadSalaryAdjustmentLedgerRows (2429)
 */
(function () {
  "use strict";

  // ── BEGIN verbatim mirror from team_operations.js ─────────────────────

  function safeStr(v) { return v == null ? "" : String(v).trim(); }
  function pad4(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d ? d.padStart(4, "0").slice(-4) : "";
  }
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === "") return [];
    return [v];
  }

  // Sum of salaryAdjustments for a franchise from the LIVE MFL feed
  // (TYPE=salaryAdjustments). Signed integer — positive INCREASES cap
  // usage; negative is a credit. Verbatim from team_operations.js:378.
  function getAdjustmentTotalFor(salaryAdjustmentsExport, viewerFid) {
    var fid = pad4(viewerFid || "");
    if (!fid) return 0;
    var root = salaryAdjustmentsExport && salaryAdjustmentsExport.salaryAdjustments;
    if (!root) return 0;
    var rows = asArray(root.salaryAdjustment || root.adjustment);
    var total = 0;
    rows.forEach(function (row) {
      if (!row) return;
      var rowFid = pad4(row.franchise_id || row.franchise || row.id || "");
      if (rowFid !== fid) return;
      total += Number(row.amount || 0);
    });
    return total;
  }

  // ── salary_adjustments_<year>.json report helpers ──
  // Verbatim from roster_workbench.js — Front Office uses these to overlay
  // DROP_PENALTY_CANDIDATE + TRADED_SALARY rows on top of the live feed.

  function reportSalaryAdjustmentBucket(row) {
    var bucket = safeStr(row && row.bucket).toLowerCase();
    if (bucket === "traded_salary" || bucket === "cut_players" || bucket === "other") return bucket;
    var adjustmentType = safeStr(row && row.adjustment_type).toUpperCase();
    if (adjustmentType === "TRADED_SALARY") return "traded_salary";
    if (adjustmentType === "DROP_PENALTY_CANDIDATE") return "cut_players";
    return "other";
  }
  function reportSalaryAdjustmentImportEligible(row) {
    if (!row || typeof row !== "object") return false;
    if (row.import_eligible != null) {
      var raw = row.import_eligible;
      if (raw === true || raw === 1) return true;
      var text = safeStr(raw).toLowerCase();
      return text === "true" || text === "1" || text === "yes";
    }
    var status = safeStr(row.status).toLowerCase();
    var amount = Number(row.amount || 0);
    if (!amount) return false;
    if (status === "review_required") return false;
    return reportSalaryAdjustmentBucket(row) === "traded_salary" || reportSalaryAdjustmentBucket(row) === "cut_players";
  }

  // Sum of import-eligible adjustments for a franchise from the
  // salary_adjustments report ledger. Only rows whose import_target_season
  // matches the cap year count.
  function getReportAdjustmentTotalFor(reportLedger, viewerFid, season) {
    var fid = pad4(viewerFid || "");
    if (!fid) return 0;
    var rows = Array.isArray(reportLedger) ? reportLedger : (reportLedger && Array.isArray(reportLedger.rows) ? reportLedger.rows : []);
    var seasonInt = parseInt(season, 10) || 0;
    var total = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      if (pad4(row.franchise_id) !== fid) continue;
      if (!reportSalaryAdjustmentImportEligible(row)) continue;
      var target = parseInt((row.import_target_season != null ? row.import_target_season : row.adjustment_season), 10) || 0;
      if (seasonInt > 0 && target > 0 && target !== seasonInt) continue;
      var amount = Number(row.amount || 0);
      // TCV ≤ $4K override (verbatim from roster_workbench.js:4159-4165)
      var adjType = safeStr(row.adjustment_type).toUpperCase();
      var tcv = Number(row.pre_drop_tcv || 0);
      if (adjType === "DROP_PENALTY_CANDIDATE" && tcv > 0 && tcv <= 4000 && amount > 0) {
        amount = 1000;
      }
      total += amount;
    }
    return total;
  }

  // Combined adjustment total — matches desktop Front Office.
  //
  // Desktop merges category-by-category (roster_workbench.js:4209-4222):
  //   per category: prefer report value if non-zero, else MFL feed.
  // For the LH motivating case both sources carry the same +$3,500 drop
  // penalties and only MFL carries the −$20K trade settlement, so the
  // correct total (−$16,500) falls out of "MFL feed alone" without any
  // overlay. The MFL feed is the canonical record once import_eligible
  // rows are processed.
  //
  // Mobile takes the MFL-feed-alone path until/unless the report carries
  // a row the MFL feed doesn't have. The report fetch + helpers stay in
  // this file so they can be wired in if Keith wants the full merge.
  function getCombinedAdjustmentTotalFor(salaryAdjustmentsExport, reportLedger, viewerFid, season) {
    return getAdjustmentTotalFor(salaryAdjustmentsExport, viewerFid);
  }

  function getRosterRowsFor(rostersExport, viewerFid) {
    if (!rostersExport || !rostersExport.rosters) return [];
    var fr = asArray(rostersExport.rosters.franchise);
    var mine = fr.find(function (f) { return pad4(f.id) === pad4(viewerFid); });
    if (!mine) return [];
    return asArray(mine.player).map(function (p) {
      return {
        id: String(p.id),
        status: safeStr(p.status),
        salary: Number(p.salary || 0),
        contractYear: safeStr(p.contractYear),
        contractStatus: safeStr(p.contractStatus),
        contractInfo: safeStr(p.contractInfo)
      };
    });
  }

  function getSalariesFor(rostersExport, salariesExport, viewerFid) {
    // MFL's salaries export with unit=LEAGUE returns every player league-wide
    // with no franchise attribution (sample player has id+salary+contractInfo
    // only). The roster export, however, includes salary + contract fields
    // per franchise's player. Source cap math from roster; back-fill any
    // missing fields from the salaries export keyed by player id.
    var roster = getRosterRowsFor(rostersExport, viewerFid);
    if (!roster.length) return [];

    var salaryById = {};
    if (salariesExport && salariesExport.salaries) {
      var units = asArray(salariesExport.salaries.leagueUnit);
      units.forEach(function (u) {
        asArray(u.player).forEach(function (p) {
          if (p && p.id) salaryById[String(p.id)] = p;
        });
      });
    }

    return roster.map(function (r) {
      var sp = salaryById[r.id] || {};
      return {
        id: r.id,
        salary: Number(r.salary || sp.salary || 0),
        contractYear: r.contractYear || safeStr(sp.contractYear),
        contractInfo: r.contractInfo || safeStr(sp.contractInfo),
        contractStatus: r.contractStatus || safeStr(sp.contractStatus)
      };
    });
  }

  // Cap hit rules (must match Roster Workbench's currentCapHit):
  //   • Expired contract (contractYear <= 0): 0% — player is on roster
  //     awaiting Expired Rookie Auction / cut, but contract has lapsed
  //     so no cap charge.
  //   • Taxi: 0% — taxi salary is real money but DOES NOT count vs cap.
  //   • IR:   50% — half of salary counts toward cap.
  //   • All other roster states: 100%.
  //
  // Round each component to the nearest $1K, then derive Cap Total and
  // Cap Room from those rounded values so all four displayed numbers
  // add up consistently:
  //   displayed salary + displayed adj   = displayed cap total
  //   displayed cap     − displayed total = displayed cap room
  function computeCapMath(salaries, statusById, adjustmentTotal, capAmount) {
    var playerSalaryUsed = 0;    // active + IR×0.5
    var taxiSalary = 0;          // off-cap
    var irSalaryFull = 0;        // raw IR salary
    var expiredSalary = 0;       // raw cy<=0 salary (off-cap)
    salaries.forEach(function (s) {
      var amt = Number(s.salary || 0);
      var status = statusById[s.id] || "";
      var cy = parseInt(s.contractYear, 10);
      if (cy === 0) {
        expiredSalary += amt;
      } else if (/taxi/i.test(status)) {
        taxiSalary += amt;
      } else if (/ir|injured/i.test(status)) {
        irSalaryFull += amt;
        playerSalaryUsed += Math.round(amt * 0.5);
      } else {
        playerSalaryUsed += amt;
      }
    });
    var cap = Number(capAmount || 0);
    function roundToK(n) { return Math.round(Number(n || 0) / 1000) * 1000; }
    var playerSalaryUsedR = roundToK(playerSalaryUsed);
    var adjustmentTotalR  = roundToK(adjustmentTotal);
    var capTotalR         = playerSalaryUsedR + adjustmentTotalR;
    var remainR           = cap - capTotalR;
    var pct = cap > 0 ? Math.min(100, Math.round((capTotalR / cap) * 100)) : 0;
    return {
      capAmount: cap,
      playerSalaryUsed: playerSalaryUsedR,
      adjustmentTotal: adjustmentTotalR,
      capTotal: capTotalR,
      capRoom: remainR,
      pct: pct,
      taxiSalary: taxiSalary,
      irSalaryFull: irSalaryFull,
      expiredSalary: expiredSalary
    };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  // Mobile-facing convenience: takes the exports already on
  // window.UPS_MOBILE.state and returns the full cap breakdown for the
  // viewer franchise. Mirror-respecting wrapper — the math itself is
  // 100% computeCapMath().
  function computeCapFor(state, viewerFid) {
    var rostersExp = state.rosters;
    var salariesExp = state.salaries;
    var adjExp = state.salaryAdjustments;
    var ledger = state.salaryAdjustmentReport;
    var cap = state.capAmount;
    var season = state.ctx && state.ctx.year;

    var roster = getRosterRowsFor(rostersExp, viewerFid);
    var salaries = getSalariesFor(rostersExp, salariesExp, viewerFid);
    var statusById = {};
    roster.forEach(function (r) { statusById[r.id] = safeStr(r.status); });

    var adj = getCombinedAdjustmentTotalFor(adjExp, ledger, viewerFid, season);
    var math = computeCapMath(salaries, statusById, adj, cap);

    var rosterCount = roster.length;
    var irCount = roster.filter(function (p) { return /ir|injured/i.test(p.status); }).length;
    var taxiCount = roster.filter(function (p) { return /taxi/i.test(p.status); }).length;
    var activeCount = rosterCount - irCount - taxiCount;
    return Object.assign({}, math, {
      rosterCount: rosterCount,
      activeCount: activeCount,
      irCount: irCount,
      taxiCount: taxiCount
    });
  }

  window.UPS_FRONT_OFFICE_CAP = {
    getAdjustmentTotalFor: getAdjustmentTotalFor,
    getReportAdjustmentTotalFor: getReportAdjustmentTotalFor,
    getCombinedAdjustmentTotalFor: getCombinedAdjustmentTotalFor,
    getRosterRowsFor: getRosterRowsFor,
    getSalariesFor: getSalariesFor,
    computeCapMath: computeCapMath,
    computeCapFor: computeCapFor
  };
})();
