/* UPS 2027 Preview 0: turns the public reads into the model the two screens draw.
   Only an allowlist of fields is copied from each source. Nothing else the worker sends (extension previews,
   salary-adjustment rows, taxi history) is kept in memory or shown. */
(function (root, factory) {
  var api = factory(typeof require === "function" ? require("./format.js") : root.UPS2027.format);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.model = api; }
})(typeof self !== "undefined" ? self : this, function (F) {
  "use strict";

  function asArray(v) { return Array.isArray(v) ? v : v == null || v === "" ? [] : [v]; }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; }
  // Number(null), Number("") and Number("  ") are all 0, which would draw a missing value as $0: those stay unknown (null).
  function num(v) {
    if (v == null || typeof v === "boolean" || (typeof v === "string" && v.trim() === "")) return null;
    var n = Number(v); return isFinite(n) ? n : null;
  }
  function pad4(v) { var d = String(v == null ? "" : v).replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; }

  var STATUS = { ROSTER: "active", TAXI_SQUAD: "taxi", INJURED_RESERVE: "ir" };

  // MFL weeklyResults: { weeklyResults: { week, matchup: [ { franchise: [ { id, player: [ { id, status } ] } ] } ] } }.
  // Returns { fid: [player ids who are starters] }, or null if the answer does not have that shape.
  function startersByFranchise(weekly) {
    var wr = weekly && weekly.weeklyResults;
    if (!wr) return null;
    var out = {}, seen = 0;
    asArray(wr.matchup).forEach(function (m) {
      asArray(m && m.franchise).forEach(function (f) {
        var fid = pad4(f && f.id);
        if (!fid) return;
        seen++;
        out[fid] = asArray(f.player).filter(function (p) { return p && p.status === "starter"; }).map(function (p) { return String(p.id); });
      });
    });
    return seen ? out : null;
  }

  function limitsFrom(league) {
    var l = (league && league.league) || {};
    return { roster: int(l.rosterSize), ir: int(l.injuredReserve), taxi: int(l.taxiSquad), starters: int(l.starters && l.starters.count) };
  }

  // rw: the /roster-workbench payload. league and weekly may be null when their read failed.
  function build(rw, league, weekly, week, season) {
    var limits = limitsFrom(league);
    var starters = startersByFranchise(weekly);
    var byId = {};
    var teams = asArray(rw && rw.teams).map(function (t) {
      var fid = pad4(t.franchise_id);
      var startSet = starters && starters[fid] ? starters[fid] : null;
      var startIds = {};
      (startSet || []).forEach(function (id) { startIds[id] = true; });
      var players = asArray(t.players).map(function (p) {
        var status = STATUS[p.status] || "active";
        var out = {
          id: String(p.id),
          rawName: F.str(p.name),
          name: F.flipName(p.name),
          rawPos: F.str(p.position),
          pos: F.posGroup(p.position),
          nflTeam: F.str(p.nfl_team),
          // The Front Office read sends salary 0 with salary_unresolved: true when MFL left the salary blank. That is
          // "unknown", never $0: the flag is kept, and the number is dropped.
          salary: p.salary_unresolved === true ? null : num(p.salary),
          salaryUnresolved: p.salary_unresolved === true,
          years: int(p.years) || 0,
          type: F.str(p.type),
          special: F.str(p.special),
          aav: num(p.aav),
          acquisition: F.str(p.acquisition_text),
          status: status,
          bye: int(p.bye),
          espnId: /^\d+$/.test(F.str(p.espn_id)) ? F.str(p.espn_id) : "",
          points: num(p.points),
          order: int(p.order),
          franchiseId: fid,
          franchiseName: F.str(t.franchise_name),
          starter: status === "active" && !!startIds[String(p.id)],
          taxi: { used: int(p.taxi_callups_used), max: int(p.taxi_callups_max), eligible: p.taxi_eligible === true, text: F.str(p.taxi_status && p.taxi_status.text) }
        };
        byId[out.id] = out;
        return out;
      });
      var counts = { active: 0, taxi: 0, ir: 0 };
      players.forEach(function (p) { counts[p.status]++; });
      return {
        id: fid, name: F.str(t.franchise_name), abbrev: F.str(t.franchise_abbrev), icon: F.str(t.icon_url),
        players: players, counts: counts, lineup: startSet ? { state: "ok", count: startSet.length, ids: startSet.slice() } : { state: "unavailable" }
      };
    });
    return { season: season, week: week, asOf: F.str(rw && rw.generated_at), limits: limits, teams: teams, byId: byId };
  }

  // Bench groups for one team: active players who are not starters, by position group in the league's order.
  function benchGroups(team) {
    var groups = {};
    team.players.forEach(function (p) {
      if (p.status !== "active" || p.starter) return;
      (groups[p.pos] = groups[p.pos] || []).push(p);
    });
    var order = F.POS_ORDER.concat(Object.keys(groups).filter(function (k) { return F.POS_ORDER.indexOf(k) < 0; }));
    return order.filter(function (k) { return groups[k] && groups[k].length; }).map(function (k) {
      return { pos: k, players: groups[k].sort(byContract) };
    });
  }

  function byContract(a, b) {
    var sa = a.salary == null ? -1 : a.salary, sb = b.salary == null ? -1 : b.salary;
    return (sb - sa) || a.name.localeCompare(b.name);
  }

  function starters(team) { return team.players.filter(function (p) { return p.starter; }).sort(function (a, b) { return (F.POS_ORDER.indexOf(a.pos) - F.POS_ORDER.indexOf(b.pos)) || byContract(a, b); }); }
  function reserve(team, status) { return team.players.filter(function (p) { return p.status === status; }).sort(byContract); }

  return { build: build, startersByFranchise: startersByFranchise, benchGroups: benchGroups, starters: starters, reserve: reserve, pad4: pad4 };
});
