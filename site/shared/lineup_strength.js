/* Lineup strength vs the league — one table, four views (#1338). Pure: no fetch, no DOM.

   ONE INPUT POPULATION. Every number comes from the trade-fit model
   (site/shared/trade_fit.js buildLeague): for each of the 12 teams, its best
   LEGAL 18-slot lineup this week (QB, 2 RB, 2 WR, TE, 2 Flex, SuperFlex, K, P,
   2 DL, 2 LB, 2 DB, D-Flex) from available rostered players (active roster,
   not ruled out), each valued at season points per MFL-scored week. A slot no
   rostered player can fill takes a replacement free agent (the 3rd best at
   QB/RB/WR/TE, 6th at K/P, 12th at IDP), at that free agent's PPG.

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

  // model = UPS_TRADE_FIT.buildLeague(...). Returns the table every view reads.
  function build(model) {
    var order = (model && model.order) || [];
    var teams = {};
    order.forEach(function (fid) {
      var tm = model.teams[fid];
      var row = {};
      ROWS.forEach(function (r) { row[r] = { ppg: 0, above: 0, starters: 0, replacementStarters: 0 }; });
      (tm.best.starters || []).forEach(function (s) {
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
    return { rows: ROWS.slice(), labels: LABELS, order: order.slice(), teams: teams, league: league,
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

  var api = { ROWS: ROWS, POSITIONS: POSITIONS, LABELS: LABELS, VIEWS: VIEWS, build: build, cell: cell, ordinal: ordinal, mean: mean, median: median };
  if (typeof window !== "undefined") window.UPS_LINEUP_STRENGTH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
