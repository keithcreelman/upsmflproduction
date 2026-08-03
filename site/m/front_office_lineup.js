/* site/m/front_office_lineup.js
 *
 * UPS lineup model — 18-starter slot lineup (2026 league config).
 *
 * MFL league 74598 enforces EXACTLY 18 starters per the live
 * export?TYPE=league `starters` node (verified 2026-06-20):
 *   Offense (11): QB 1-2, RB 2-5, WR 2-5, TE 1-4, PK 1, PN 1
 *   Defense (7):  DT+DE 2-3, LB 2-3, CB+S 2-3
 * Every real lineup fields 11 offense / 7 defense (always exactly 1 K + 1 P).
 *
 * We present that as fixed + flex slots (clearer than raw ranges):
 *   Offense: 1 QB, 2 RB, 2 WR, 1 TE, 2 O-Flex(RB/WR/TE),
 *            1 SuperFlex(QB/RB/WR/TE), 1 K, 1 P
 *   Defense: 2 DL, 2 LB, 2 DB, 1 D-Flex(DL/LB/DB)
 * Any lineup these slots produce satisfies MFL's per-position ranges and
 * totals exactly 18. The submission to MFL is the flat list of the 18
 * chosen player IDs — MFL slots them by position. These named slots are a
 * client-side aid that guarantees a valid, in-range 18.
 *
 * Desktop mirror lives in site/team_operations/team_operations.js — keep
 * the slot model in sync if it changes here.
 */
(function () {
  "use strict";

  function safeStr(v) { return v == null ? "" : String(v).trim(); }

  // Raw MFL/nflverse position → canonical lineup group.
  function posGroup(pos) {
    var p = safeStr(pos).toUpperCase();
    if (p === "QB") return "QB";
    if (p === "RB" || p === "FB" || p === "HB") return "RB";
    if (p === "WR") return "WR";
    if (p === "TE") return "TE";
    if (p === "PK" || p === "K") return "PK";
    if (p === "PN" || p === "P") return "PN";
    if (p === "DT" || p === "DE" || p === "NT" || p === "DL") return "DL";
    if (p === "LB" || p === "OLB" || p === "ILB" || p === "MLB") return "LB";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    return "OTH";
  }

  // The 18 starting slots, in display order. `accepts` = canonical groups a
  // player may fill the slot with. `flex` flags multi-position slots; `note`
  // is the eligibility hint shown under flex labels.
  var LINEUP_SLOTS = [
    { id: "QB1", label: "QB",        side: "O", accepts: ["QB"] },
    { id: "RB1", label: "RB",        side: "O", accepts: ["RB"] },
    { id: "RB2", label: "RB",        side: "O", accepts: ["RB"] },
    { id: "WR1", label: "WR",        side: "O", accepts: ["WR"] },
    { id: "WR2", label: "WR",        side: "O", accepts: ["WR"] },
    { id: "TE1", label: "TE",        side: "O", accepts: ["TE"] },
    { id: "OF1", label: "Flex",      side: "O", accepts: ["RB", "WR", "TE"],       flex: true, note: "RB/WR/TE" },
    { id: "OF2", label: "Flex",      side: "O", accepts: ["RB", "WR", "TE"],       flex: true, note: "RB/WR/TE" },
    { id: "SF1", label: "SuperFlex", side: "O", accepts: ["QB", "RB", "WR", "TE"], flex: true, note: "QB/RB/WR/TE" },
    { id: "PK1", label: "K",         side: "O", accepts: ["PK"] },
    { id: "PN1", label: "P",         side: "O", accepts: ["PN"] },
    { id: "DL1", label: "DL",        side: "D", accepts: ["DL"], note: "DT/DE" },
    { id: "DL2", label: "DL",        side: "D", accepts: ["DL"], note: "DT/DE" },
    { id: "LB1", label: "LB",        side: "D", accepts: ["LB"] },
    { id: "LB2", label: "LB",        side: "D", accepts: ["LB"] },
    { id: "DB1", label: "DB",        side: "D", accepts: ["DB"], note: "CB/S" },
    { id: "DB2", label: "DB",        side: "D", accepts: ["DB"], note: "CB/S" },
    { id: "DF1", label: "Flex",      side: "D", accepts: ["DL", "LB", "DB"],       flex: true, note: "DL/LB/DB" }
  ];

  var TOTAL_STARTERS = 18;
  var OFFENSE_STARTERS = 11;
  var DEFENSE_STARTERS = 7;

  function slotAccepts(slot, group) {
    return !!slot && slot.accepts.indexOf(group) !== -1;
  }

  // Candidate is startable: real position group + not taxi / IR / expired.
  function lineupEligibleRow(r) {
    if (!r) return false;
    if (r.isTaxi || r.isIr || r.isExpired) return false;
    return posGroup(r.pos) !== "OTH";
  }

  // Greedy seed — fill the fixed slots first (best by `scoreFn`), then the
  // flex slots from the best remaining eligible player. Returns { slotId: pid }.
  // scoreFn(row) ranks candidates (default: salary). Pass a projection-based
  // scoreFn for the "Optimal" lineup.
  function autoFillSlots(rows, scoreFn) {
    var score = (typeof scoreFn === "function") ? scoreFn : function (r) { return r.salary || 0; };
    var byGroup = {};
    rows.forEach(function (r) {
      if (!lineupEligibleRow(r)) return;
      var g = posGroup(r.pos);
      (byGroup[g] = byGroup[g] || []).push(r);
    });
    Object.keys(byGroup).forEach(function (g) {
      byGroup[g].sort(function (a, b) { return score(b) - score(a); });
    });
    var used = {}, draft = {};
    function take(accepts) {
      var best = null;
      accepts.forEach(function (g) {
        (byGroup[g] || []).forEach(function (r) {
          if (!used[r.id] && (!best || score(r) > score(best))) best = r;
        });
      });
      if (best) { used[best.id] = 1; return best.id; }
      return "";
    }
    // Fixed slots first so a flex slot doesn't grab a scarce fixed-position
    // player (e.g. the only TE) before the TE slot can claim it.
    LINEUP_SLOTS.forEach(function (s) { if (!s.flex) draft[s.id] = take(s.accepts); });
    LINEUP_SLOTS.forEach(function (s) { if (s.flex)  draft[s.id] = take(s.accepts); });
    return draft;
  }

  // Convert a flat starters[] (what MFL/our own ledger actually holds) BACK
  // into a slot draft ({ slotId: pid }). This is how a real submitted lineup
  // gets displayed — never confuse it with autoFillSlots above, which
  // invents a lineup rather than reads one back. Same fixed-slots-first order
  // as autoFillSlots so a flex slot never claims a player a fixed slot needs.
  // A pid not in `rows` (e.g. since traded/dropped) is silently skipped —
  // MFL's own copy is still the 18 that were actually submitted; this is only
  // a client-side rendering of it.
  function slotsFromStarters(rows, pids) {
    var byId = {};
    (rows || []).forEach(function (r) { byId[String(r.id)] = r; });
    var list = (pids || []).map(String).filter(function (p) { return byId[p]; });
    var out = {}, used = {};
    function fill(slotList) {
      slotList.forEach(function (s) {
        if (out[s.id]) return;
        for (var i = 0; i < list.length; i++) {
          var pid = list[i];
          if (used[pid]) continue;
          var r = byId[pid];
          if (r && slotAccepts(s, posGroup(r.pos))) { out[s.id] = pid; used[pid] = 1; return; }
        }
      });
    }
    fill(LINEUP_SLOTS.filter(function (s) { return !s.flex; }));
    fill(LINEUP_SLOTS.filter(function (s) { return s.flex; }));
    return out;
  }

  // Validate a slot draft ({ slotId: pid }). Returns
  // { ok, filled, total, bySide:{O,D}, errors[] }.
  function validateSlots(draft, rowsByPid) {
    draft = draft || {};
    rowsByPid = rowsByPid || {};
    var filled = 0, dupes = 0, ineligible = 0, mismatch = 0, seen = {};
    var bySide = { O: 0, D: 0 };
    LINEUP_SLOTS.forEach(function (s) {
      var pid = draft[s.id];
      if (!pid) return;
      filled += 1;
      bySide[s.side] += 1;
      if (seen[pid]) dupes += 1; else seen[pid] = 1;
      var r = rowsByPid[pid];
      if (!r || r.isTaxi || r.isIr || r.isExpired) { ineligible += 1; return; }
      if (!slotAccepts(s, posGroup(r.pos))) mismatch += 1;
    });
    var errors = [];
    if (filled < TOTAL_STARTERS) {
      var need = TOTAL_STARTERS - filled;
      errors.push("Fill " + need + " more slot" + (need === 1 ? "" : "s"));
    }
    if (dupes) errors.push(dupes + " player" + (dupes === 1 ? "" : "s") + " used in two slots");
    if (ineligible) errors.push(ineligible + " ineligible (taxi/IR/expired) selected");
    if (mismatch) errors.push(mismatch + " player" + (mismatch === 1 ? "" : "s") + " in the wrong slot");
    // `problems` = blocking issues (must fix before any save). An incomplete
    // lineup is NOT a problem — MFL accepts a valid partial save (bye/injury
    // weeks may leave a slot unfillable), so we allow it.
    var problems = dupes + ineligible + mismatch;
    return {
      ok: problems === 0 && filled === TOTAL_STARTERS,
      complete: filled === TOTAL_STARTERS,
      problems: problems,
      filled: filled, total: TOTAL_STARTERS, bySide: bySide, errors: errors
    };
  }

  window.UPS_FRONT_OFFICE_LINEUP = {
    LINEUP_SLOTS: LINEUP_SLOTS,
    TOTAL_STARTERS: TOTAL_STARTERS,
    OFFENSE_STARTERS: OFFENSE_STARTERS,
    DEFENSE_STARTERS: DEFENSE_STARTERS,
    posGroup: posGroup,
    slotAccepts: slotAccepts,
    lineupEligibleRow: lineupEligibleRow,
    autoFillSlots: autoFillSlots,
    slotsFromStarters: slotsFromStarters,
    validateSlots: validateSlots
  };
})();
