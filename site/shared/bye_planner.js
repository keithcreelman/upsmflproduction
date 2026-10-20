/* Bye planner — week by week, can this roster fill the league's 18 starting
   slots, and what do byes cost it? Pure: no fetch, no DOM (#1338).

   For each week it builds the best LEGAL lineup (site/m/front_office_lineup.js,
   the released 18-slot engine) from the players who can play that week and
   compares it with the full-strength lineup (everyone available, no byes):
     empty    slots no eligible player can fill: a real lineup shortage
     cost     points a week lost to byes and absences (player values are the
              caller's, the Front Office passes season PPG per MFL-scored week)
     out      who is unavailable that week and why (bye / injury / IR / taxi)
   Availability: taxi and IR players never start (§B2/§B3, until a call-up or
   activation); roster designations that last (IR, PUP, NFI, SUSP, HOLD, RET)
   hold every week; a game designation (OUT) holds only for the current week,
   because next week's report doesn't exist yet. A team on a bye has no game.
   Free-agent options for a short week are listed only as options (players with
   a game that week, by the same value), never as recommendations.
*/
(function (root) {
  "use strict";

  var LASTING = { IR: 1, PUP: 1, NFI: 1, SUSP: 1, HOLD: 1, RET: 1 };
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? "" : String(v).trim(); }

  function lineupApi(opts) {
    var L = (opts && opts.lineup) || (typeof window !== "undefined" && window.UPS_FRONT_OFFICE_LINEUP);
    if (!L || typeof L.autoFillSlots !== "function") throw new Error("bye_planner: UPS_FRONT_OFFICE_LINEUP is required");
    return L;
  }

  // Why a rostered player can't start in week w, or "" when he can.
  function unavailableReason(p, w, byes, currentWeek) {
    var st = str(p.status || "ROSTER").toUpperCase();
    if (st === "TAXI_SQUAD") return "taxi";
    if (st === "INJURED_RESERVE") return "ir";
    var chip = str(p.chip).toUpperCase();
    if (LASTING[chip]) return "injury";
    if (chip === "OUT" && w === currentWeek) return "injury";
    var team = str(p.nflTeam).toUpperCase();
    if (!team || team === "FA" || team === "FA*") return "no_team";
    if (byes[team] && byes[team] === w) return "bye";
    return "";
  }

  function fill(L, rows) {
    var slots = L.autoFillSlots(rows, function (r) { return r.v || 0; });
    var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
    var total = 0, empty = [];
    L.LINEUP_SLOTS.forEach(function (s) {
      var pid = slots[s.id];
      if (pid) total += byId[pid].v || 0; else empty.push(s.id);
    });
    return { slots: slots, total: total, empty: empty };
  }

  function plan(input) {
    var L = lineupApi(input);
    var values = input.values || {};
    var byes = input.byeWeekByTeam || {};
    var from = parseInt(input.fromWeek, 10) || 1, to = parseInt(input.toWeek, 10) || from;
    var current = parseInt(input.currentWeek, 10) || from;
    var players = (input.players || []).filter(function (p) { return L.posGroup(p.pos) !== "OTH"; });
    var slotById = {}; L.LINEUP_SLOTS.forEach(function (s) { slotById[s.id] = s; });
    var rowOf = function (p) { return { id: p.pid, pos: p.pos, v: num(values[p.pid]) || 0 }; };

    // Full strength: everyone who isn't on taxi/IR or out for a lasting reason, no byes.
    var fullRows = players.filter(function (p) {
      var r = unavailableReason(p, -1, {}, -2);
      return r === "" ;
    }).map(rowOf);
    var full = fill(L, fullRows);
    var fullStarters = {}; Object.keys(full.slots).forEach(function (sid) { if (full.slots[sid]) fullStarters[full.slots[sid]] = sid; });

    var faByGroup = {};
    (input.freeAgents || []).forEach(function (fa) {
      var g = L.posGroup(fa.pos);
      if (g === "OTH") return;
      (faByGroup[g] = faByGroup[g] || []).push({ pid: fa.pid, pos: fa.pos, nflTeam: str(fa.nflTeam).toUpperCase(), name: fa.name || "", v: num(values[fa.pid]) || 0 });
    });
    Object.keys(faByGroup).forEach(function (g) { faByGroup[g].sort(function (a, b) { return b.v - a.v; }); });

    var weeks = [];
    for (var w = from; w <= to; w++) {
      var out = [], rows = [];
      players.forEach(function (p) {
        var why = unavailableReason(p, w, byes, current);
        if (why) out.push({ pid: p.pid, reason: why, starter: !!fullStarters[p.pid] });
        else rows.push(rowOf(p));
      });
      var res = fill(L, rows);
      var emptyGroups = {};
      res.empty.forEach(function (sid) { var lbl = slotById[sid].label; emptyGroups[lbl] = (emptyGroups[lbl] || 0) + 1; });
      var options = {};
      res.empty.forEach(function (sid) {
        slotById[sid].accepts.forEach(function (g) {
          if (options[g]) return;
          options[g] = (faByGroup[g] || []).filter(function (fa) {
            return fa.nflTeam && fa.nflTeam !== "FA" && byes[fa.nflTeam] !== w;
          }).slice(0, 3);
        });
      });
      weeks.push({
        week: w, total: res.total, cost: Math.max(0, full.total - res.total), slots: res.slots,
        empty: res.empty, emptyGroups: emptyGroups, out: out,
        startersOut: out.filter(function (o) { return o.starter && o.reason === "bye"; }).map(function (o) { return o.pid; }),
        options: options
      });
    }
    var worst = weeks.slice().sort(function (a, b) { return (b.empty.length - a.empty.length) || (b.cost - a.cost); });
    return { full: full, fullStarters: fullStarters, weeks: weeks,
      shortWeeks: weeks.filter(function (x) { return x.empty.length > 0; }).map(function (x) { return x.week; }),
      worst: worst[0] || null };
  }

  // MFL's nflByeWeeks export → { TEAM: week }.
  function byesFromMfl(json) {
    var out = {};
    var list = json && json.nflByeWeeks && json.nflByeWeeks.team;
    (Array.isArray(list) ? list : (list ? [list] : [])).forEach(function (t) {
      var id = str(t && t.id).toUpperCase(), w = parseInt(t && t.bye_week, 10) || 0;
      if (id && w > 0) out[id] = w;
    });
    return out;
  }

  var api = { plan: plan, unavailableReason: unavailableReason, byesFromMfl: byesFromMfl };
  root.UPS_BYE_PLANNER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
