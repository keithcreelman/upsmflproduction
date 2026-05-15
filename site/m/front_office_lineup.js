/* site/m/front_office_lineup.js
 *
 * VERBATIM MIRROR of the lineup builder logic in
 * site/team_operations/team_operations.js (LINEUP_GROUPS,
 * lineupGroupForPos, lineupEligibleRow, lineupValidate).
 *
 * DO NOT EDIT the constants or function bodies. If team_operations.js
 * changes (e.g. a new position group, a different max, a new
 * eligibility rule), copy the updated values here verbatim. Source-of-
 * truth lines:
 *   LINEUP_GROUPS          (829-841)
 *   lineupGroupForPos      (842-848)
 *   lineupEligibleRow      (856-861)
 *   lineupValidate         (862-883)
 */
(function () {
  "use strict";

  // ── BEGIN verbatim mirror from team_operations.js ─────────────────────

  var LINEUP_GROUPS = [
    { key: "QB", label: "QB",   min: 1, max: 1, positions: ["QB"] },
    { key: "RB", label: "RB",   min: 1, max: 3, positions: ["RB"] },
    { key: "WR", label: "WR",   min: 2, max: 4, positions: ["WR"] },
    { key: "TE", label: "TE",   min: 1, max: 3, positions: ["TE"] },
    { key: "PK", label: "PK",   min: 1, max: 1, positions: ["PK"] },
    { key: "PN", label: "PN",   min: 1, max: 1, positions: ["PN"] },
    { key: "DL", label: "DT/DE",min: 1, max: 3, positions: ["DT", "DE"] },
    { key: "LB", label: "LB",   min: 1, max: 3, positions: ["LB"] },
    { key: "DB", label: "CB/S", min: 1, max: 3, positions: ["CB", "S"] },
    // Catch-all bucket — anything else that ended up on roster.
    { key: "OTH", label: "Other", min: 0, max: 0, positions: [] }
  ];

  function safeStr(v) { return v == null ? "" : String(v).trim(); }

  function lineupGroupForPos(pos) {
    var p = safeStr(pos).toUpperCase();
    for (var i = 0; i < LINEUP_GROUPS.length - 1; i += 1) {
      if (LINEUP_GROUPS[i].positions.indexOf(p) !== -1) return LINEUP_GROUPS[i];
    }
    return LINEUP_GROUPS[LINEUP_GROUPS.length - 1];
  }

  // Lineup builder helpers.
  // - lineupEligibleRow(r): row is a valid candidate for "start" (not
  //   taxi, not IR, not expired-contract, has a known position group).
  // - lineupValidate(draftSet, rowsByPid): aggregate per-group counts vs
  //   LINEUP_GROUPS min/max + total = 14. Returns { ok, total, byGroup,
  //   errors[] }.
  function lineupEligibleRow(r) {
    if (!r) return false;
    if (r.isTaxi || r.isIr || r.isExpired) return false;
    if (!r.group || !r.group.positions || !r.group.positions.length) return false;
    return true;
  }
  function lineupValidate(draftSet, rowsByPid) {
    var byGroup = {};
    LINEUP_GROUPS.forEach(function (g) { byGroup[g.key] = { count: 0, min: g.min, max: g.max, label: g.label }; });
    var total = 0;
    var ineligibleCount = 0;
    draftSet.forEach(function (pid) {
      var r = rowsByPid[pid];
      if (!r || !lineupEligibleRow(r)) { ineligibleCount += 1; return; }
      byGroup[r.group.key].count += 1;
      total += 1;
    });
    var errors = [];
    Object.keys(byGroup).forEach(function (k) {
      var g = byGroup[k];
      if (!g.max && !g.min) return;
      if (g.count < g.min) errors.push(g.label + " needs " + (g.min - g.count) + " more");
      else if (g.count > g.max) errors.push(g.label + " over by " + (g.count - g.max));
    });
    if (ineligibleCount) errors.push(ineligibleCount + " ineligible (taxi/IR/expired) selected");
    if (total !== 14) errors.push(total < 14 ? "Need " + (14 - total) + " more starter(s)" : (total - 14) + " over 14");
    return { ok: errors.length === 0, total: total, byGroup: byGroup, errors: errors };
  }

  // ── END verbatim mirror ──────────────────────────────────────────────

  window.UPS_FRONT_OFFICE_LINEUP = {
    LINEUP_GROUPS: LINEUP_GROUPS,
    TOTAL_STARTERS: 14,
    lineupGroupForPos: lineupGroupForPos,
    lineupEligibleRow: lineupEligibleRow,
    lineupValidate: lineupValidate
  };
})();
