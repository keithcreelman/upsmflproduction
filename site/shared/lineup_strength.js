/* Lineup strength vs the league — one table, four views (#1338). Pure: no fetch, no DOM.

   ONE INPUT POPULATION: THE OWNED ROSTER (Keith 2026-10-21). For each of the
   12 teams, its best LEGAL 18-slot lineup this week (QB, 2 RB, 2 WR, TE, 2
   Flex, SuperFlex, K, P, 2 DL, 2 LB, 2 DB, D-Flex) built from ITS OWN
   available rostered players (active roster, not ruled out), each valued at
   season points per MFL-scored week. A replacement free agent (the 3rd best
   at QB/RB/WR/TE, 6th at K/P, 12th at IDP, at that free agent's PPG) fills a
   slot ONLY when no available rostered player can play it, and every such
   slot is listed. (The trade-fit model, used by the Trade finder, instead lets
   a replacement start wherever it outscores the roster: population "model",
   kept for comparison.)

   ROWS. A position row holds the starters whose position is that group,
   wherever they start (Flex, SuperFlex and D-Flex count for the player's own
   position). OVERALL is all 18 slots, every required starter, so positions
   weigh by the points they actually score (not an average of the rows).

   VIEWS, all per row, all over the same 12 lineups:
     above     starters' PPG above replacement (Σ PPG − the replacement PPG for
               each starter) MINUS the league median of that — the original
               chart, unchanged (trade_fit strength / vsMedian).
     ppg       starters' points per week (Σ PPG).
     index     ppg ÷ the 12-team mean ppg × 100 (100 = league average).
     rank      1–12 by ppg (ties share the better rank).
*/
(function () {
  "use strict";

  var POSITIONS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  var ROWS = ["ALL"].concat(POSITIONS);
  var LABELS = { ALL: "Overall", QB: "QB", RB: "RB", WR: "WR", TE: "TE", DL: "DL", LB: "LB", DB: "DB", PK: "K", PN: "P" };
  var VIEWS = ["above", "ppg", "index", "rank"];

  function median(list) {
    var a = list.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mean(list) {
    var a = list.filter(function (x) { return x != null && isFinite(x); });
    return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null;
  }
  function ordinal(n) {
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function availableNow(p) {
    var TF = typeof window !== "undefined" ? window.UPS_TRADE_FIT : null;
    if (TF && TF.availableNow) return TF.availableNow(p);
    var st = String((p && p.status) || "ROSTER").toUpperCase();
    return st === "ROSTER" && !/^(IR|PUP|NFI|SUSP|HOLD|RET|OUT)$/.test(String((p && p.chip) || "").toUpperCase());
  }
  // The owned-roster lineup: fill every slot the team's own available players can (the released engine, fixed slots
  // first), then put a replacement body only in a slot still empty — the best unused one the slot accepts.
  function ownedLineup(model, team, extraRows, avail) {
    var L = model.lineup, values = model.values || {};
    var rows = [];
    (team.players || []).forEach(function (p) {
      if (!avail(p) || L.posGroup(p.pos) === "OTH") return;
      var v = Number(values[p.pid]); rows.push({ id: p.pid, pos: p.pos, v: isFinite(v) ? v : 0 });
    });
    (extraRows || []).forEach(function (r) { rows.push(r); });
    var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
    var slots = L.autoFillSlots(rows, function (r) { return r.v || 0; });
    var used = {}, total = 0, starters = [];
    L.LINEUP_SLOTS.forEach(function (sl) {
      var pid = slots[sl.id];
      if (pid) {
        var r = byId[pid]; total += r.v || 0;
        starters.push({ slot: sl.id, pid: r.hyp ? "" : pid, hyp: !!r.hyp, group: L.posGroup(r.pos), v: r.v || 0, rep: false });
        return;
      }
      var best = null;
      sl.accepts.forEach(function (g) {
        (model.repl[g] || []).forEach(function (v, i) {
          var id = "REP:" + g + ":" + i;
          if (!used[id] && (!best || v > best.v)) best = { id: id, group: g, v: v };
        });
      });
      if (best) { used[best.id] = 1; total += best.v; starters.push({ slot: sl.id, pid: "", group: best.group, v: best.v, rep: true }); }
      else starters.push({ slot: sl.id, pid: "", group: "", v: 0, rep: false, empty: true });
    });
    return { total: total, starters: starters };
  }

  // model = UPS_TRADE_FIT.buildLeague(...). opts.population: "owned" (default) or "model" (the trade-fit model's
  // replacement-filled lineups, for comparison). Returns the table every view reads.
  function build(model, opts) {
    opts = opts || {};
    var population = opts.population === "model" ? "model" : "owned";
    var avail = opts.availableNow || availableNow;
    var order = (model && model.order) || [];
    var teams = {}, lineups = {};
    order.forEach(function (fid) {
      lineups[fid] = population === "model" ? model.teams[fid].best : ownedLineup(model, model.teams[fid].team, null, avail);
    });
    order.forEach(function (fid) {
      var lu = lineups[fid];
      var row = {};
      ROWS.forEach(function (r) { row[r] = { ppg: 0, above: 0, starters: 0, replacementStarters: 0 }; });
      row.replacementSlots = [];
      (lu.starters || []).forEach(function (s) {
        if (s.rep) row.replacementSlots.push({ slot: s.slot, group: s.group, v: s.v });
        var g = s.group;
        var base = g && model.repl[g] ? (model.repl[g][0] || 0) : 0;
        row.ALL.ppg += s.v || 0;
        row.ALL.starters += 1;
        if (s.rep) row.ALL.replacementStarters += 1;
        if (!g || !row[g]) return;               // an empty slot: counted in Overall at 0, in no position row
        row[g].ppg += s.v || 0;
        row[g].above += (s.v || 0) - base;
        row[g].starters += 1;
        if (s.rep) row[g].replacementStarters += 1;
        row.ALL.above += (s.v || 0) - base;
      });
      teams[fid] = row;
    });
    // Need: points a week the team's lineup gains by adding the league's typical (median) owned starter at a position.
    var typical = {};
    POSITIONS.forEach(function (g) {
      var vals = [];
      order.forEach(function (fid) { (lineups[fid].starters || []).forEach(function (s) { if (s.group === g && !s.rep && s.pid) vals.push(s.v); }); });
      typical[g] = median(vals);
    });
    order.forEach(function (fid) {
      var need = {};
      POSITIONS.forEach(function (g) {
        if (typical[g] == null) { need[g] = 0; return; }
        var hyp = { id: "HYP:" + g, pos: g, v: typical[g], hyp: true };
        var withHyp = population === "model" ? null : ownedLineup(model, model.teams[fid].team, [hyp], avail).total;
        need[g] = withHyp == null ? (model.teams[fid].need ? model.teams[fid].need[g] : 0) : Math.max(0, Math.round((withHyp - lineups[fid].total) * 10) / 10);
      });
      teams[fid].need = need;
      teams[fid].biggestNeed = POSITIONS.filter(function (g) { return g !== "PK" && g !== "PN" && need[g] >= 1; })
        .sort(function (a, b) { return need[b] - need[a]; })[0] || "";
    });
    var league = {};
    ROWS.forEach(function (r) {
      var ppgs = order.map(function (fid) { return teams[fid][r].ppg; });
      var aboves = order.map(function (fid) { return teams[fid][r].above; });
      league[r] = { meanPpg: mean(ppgs), medianAbove: median(aboves), n: order.length };
    });
    order.forEach(function (fid) {
      ROWS.forEach(function (r) {
        var c = teams[fid][r], L = league[r];
        c.vsMedian = c.above - (L.medianAbove || 0);
        c.index = L.meanPpg ? c.ppg / L.meanPpg * 100 : null;
        c.rank = 1 + order.filter(function (o) { return teams[o][r].ppg > c.ppg + 1e-9; }).length;
      });
    });
    // Each view's league-wide spread per row, so a bar shows where a team sits among the 12 in THAT row.
    ROWS.forEach(function (r) {
      var L = league[r];
      L.maxAbsVsMedian = Math.max.apply(null, order.map(function (fid) { return Math.abs(teams[fid][r].vsMedian); }).concat([1e-9]));
      L.maxAbsIndexDev = Math.max.apply(null, order.map(function (fid) { var x = teams[fid][r].index; return x == null ? 0 : Math.abs(x - 100); }).concat([1e-9]));
    });
    return { population: population, rows: ROWS.slice(), labels: LABELS, order: order.slice(), teams: teams, league: league, typical: typical,
      slots: (model && model.lineup && model.lineup.LINEUP_SLOTS ? model.lineup.LINEUP_SLOTS.length : null) };
  }

  // One row of one team in one view → { text, frac (−1…1 for the bar), title }.
  function cell(table, fid, r, view) {
    var c = table.teams[fid] && table.teams[fid][r], L = table.league[r];
    if (!c) return null;
    var n = table.order.length;
    var avg = L.meanPpg != null ? (Math.round(L.meanPpg * 10) / 10).toFixed(1) : "—";
    if (view === "ppg") {
      var dev = L.meanPpg ? (c.ppg - L.meanPpg) / L.meanPpg * 100 : 0;
      return { text: (Math.round(c.ppg * 10) / 10).toFixed(1), frac: clamp(dev / L.maxAbsIndexDev),
        title: "Starters’ points a week; league average " + avg };
    }
    if (view === "index") {
      return { text: c.index == null ? "—" : String(Math.round(c.index)), frac: c.index == null ? 0 : clamp((c.index - 100) / L.maxAbsIndexDev),
        title: "100 = league average (" + avg + " pts a week)" };
    }
    if (view === "rank") {
      var mid = (n + 1) / 2;
      return { text: ordinal(c.rank), frac: n > 1 ? clamp((mid - c.rank) / (mid - 1)) : 0, title: ordinal(c.rank) + " of " + n + " by starters’ points a week" };
    }
    var v = Math.round(c.vsMedian * 10) / 10;
    return { text: (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1), frac: clamp(c.vsMedian / L.maxAbsVsMedian),
      title: "Points a week above replacement, minus the league median" };
  }
  function clamp(x) { return !isFinite(x) ? 0 : Math.max(-1, Math.min(1, x)); }

  var api = { ROWS: ROWS, POSITIONS: POSITIONS, LABELS: LABELS, VIEWS: VIEWS, build: build, cell: cell, ownedLineup: ownedLineup, ordinal: ordinal, mean: mean, median: median };
  if (typeof window !== "undefined") window.UPS_LINEUP_STRENGTH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
