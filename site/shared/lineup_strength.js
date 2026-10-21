/* Lineup strength vs the league — two breakdowns of one lineup, four measures (#1338). Pure: no fetch, no DOM.

   ONE CALCULATION, SHARED WITH THE TRADE FINDER (Keith 2026-10-21). The table
   reads the lineups site/shared/trade_fit.js builds — the same model object
   the Trade finder reads — so the two screens show the same values. Those
   lineups are each team's best LEGAL 18-slot lineup this week (QB, 2 RB, 2 WR,
   TE, 2 Flex, SuperFlex, K, P, 2 DL, 2 LB, 2 DB, D-Flex) from ITS OWN
   available rostered players (active roster, not ruled out), each valued at
   season points per MFL-scored week. A replacement free agent (the 3rd best
   at QB/RB/WR/TE, 6th at K/P, 12th at IDP, at that free agent's PPG) fills a
   slot ONLY when no available rostered player can play it, and every such
   slot is listed. (A model built with lineupRule "replacement" — the old
   rule, where a replacement competes for every slot — gives the before/after
   comparison; no screen uses it.)

   TWO BREAKDOWNS of that one lineup (Keith 2026-10-21):
     position  (By Position, the default) a row holds the starters whose
               natural position is that group, wherever they start: a TE in
               Flex counts under TE. These are the Trade finder's numbers.
     slot      (By Lineup Slot) the same starters by the slot they fill in
               MFL's lineup settings (trade_fit deriveSlots): QB, RB, WR, TE,
               Flex, Superflex, DL, LB, DB, IDP Flex, K, P. A second TE who
               starts is in Flex; a second QB is in Superflex. It never builds
               another lineup: it reads trade_fit's own slot assignment.
   Every starter is in exactly one row of each breakdown, and OVERALL is all the
   required slots, so a breakdown's rows add up to Overall (PPG, and points
   above replacement). Overall PPG, Rank and Index are the same in both.

   MEASURES, all per row, all over the same 12 lineups:
     ppg       (PPG, the default) starters' points per week (Σ PPG).
     rank      1st–12th by ppg (ties share the better rank).
     above     (Above Replacement) starters' PPG above the applicable
               replacement baseline, MINUS the league median of that (0 = the
               middle team; trade_fit strength / vsMedian). By Position the
               baseline is the starter's own position's replacement free
               agent. By Lineup Slot it is the slot's: the best replacement-level
               free agent the slot accepts (Flex from RB/WR/TE, Superflex from
               QB/RB/WR/TE; trade_fit slotBaseline). So Overall above
               replacement can differ between the breakdowns when a Flex or
               Superflex starter's slot baseline differs from his position's.
     index     ppg ÷ the 12-team mean ppg × 100 (100 = league average).
   NEED and the league's typical starter are trade_fit's own (model.teams[].need,
   model.typical) and always by natural position: that is the trade to make.
*/
(function () {
  "use strict";

  var POSITIONS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  var ROWS = ["ALL"].concat(POSITIONS);
  var SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "SFLEX", "DL", "LB", "DB", "DFLEX", "PK", "PN"];
  var LABELS = { ALL: "Overall", QB: "QB", RB: "RB", WR: "WR", TE: "TE", DL: "DL", LB: "LB", DB: "DB", PK: "K", PN: "P",
    FLEX: "Flex", SFLEX: "Superflex", DFLEX: "IDP Flex" };
  var VIEWS = ["ppg", "rank", "above", "index"];
  var BREAKDOWNS = ["position", "slot"];

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

  // The rows of the slot breakdown: the slot rows MFL's settings have, in display order.
  function slotRows(model) {
    var have = {};
    ((model && model.slots) || []).forEach(function (s) { if (s.row) have[s.row] = 1; });
    return ["ALL"].concat(SLOT_ORDER.filter(function (r) { return have[r]; }));
  }

  // model = UPS_TRADE_FIT.buildLeague(...); opts.by = "position" (default) | "slot". Returns the table every measure
  // reads; population = the model's lineup rule.
  function build(model, opts) {
    var by = opts && opts.by === "slot" ? "slot" : "position";
    var order = (model && model.order) || [];
    var rows = by === "slot" ? slotRows(model) : ROWS.slice();
    var slotById = {};
    ((model && model.slots) || []).forEach(function (s) { slotById[s.id] = s; });
    var teams = {};
    order.forEach(function (fid) {
      var tm = model.teams[fid], lu = tm.best;
      var row = {};
      rows.forEach(function (r) { row[r] = { ppg: 0, above: 0, starters: 0, replacementStarters: 0 }; });
      row.replacementSlots = [];
      (lu.starters || []).forEach(function (s) {
        if (s.rep) row.replacementSlots.push({ slot: s.slot, group: s.group, slotRow: s.slotRow || "", v: s.v });
        var g = s.group, slot = slotById[s.slot];
        var key = by === "slot" ? (slot && slot.row) : g;
        var base = by === "slot" ? ((model.slotBase || {})[s.slot] || 0) : (g && model.repl[g] ? (model.repl[g][0] || 0) : 0);
        row.ALL.ppg += s.v || 0;
        row.ALL.starters += 1;
        if (s.rep) row.ALL.replacementStarters += 1;
        if (!g || !key || !row[key]) return;     // an empty slot: counted in Overall at 0, in no other row
        row[key].ppg += s.v || 0;
        row[key].above += (s.v || 0) - base;
        row[key].starters += 1;
        if (s.rep) row[key].replacementStarters += 1;
        row.ALL.above += (s.v || 0) - base;
      });
      row.need = {};
      POSITIONS.forEach(function (g) { row.need[g] = tm.need && tm.need[g] != null ? tm.need[g] : 0; });
      row.biggestNeed = POSITIONS.filter(function (g) { return g !== "PK" && g !== "PN" && row.need[g] >= 1; })
        .sort(function (a, b) { return row.need[b] - row.need[a]; })[0] || "";
      teams[fid] = row;
    });
    var league = {};
    rows.forEach(function (r) {
      var ppgs = order.map(function (fid) { return teams[fid][r].ppg; });
      var aboves = order.map(function (fid) { return teams[fid][r].above; });
      league[r] = { meanPpg: mean(ppgs), medianAbove: median(aboves), n: order.length };
    });
    order.forEach(function (fid) {
      rows.forEach(function (r) {
        var c = teams[fid][r], L = league[r];
        c.vsMedian = c.above - (L.medianAbove || 0);
        c.index = L.meanPpg ? c.ppg / L.meanPpg * 100 : null;
        c.rank = 1 + order.filter(function (o) { return teams[o][r].ppg > c.ppg + 1e-9; }).length;
      });
    });
    // Each view's league-wide spread per row, so a bar shows where a team sits among the 12 in THAT row.
    rows.forEach(function (r) {
      var L = league[r];
      L.maxAbsVsMedian = Math.max.apply(null, order.map(function (fid) { return Math.abs(teams[fid][r].vsMedian); }).concat([1e-9]));
      L.maxAbsIndexDev = Math.max.apply(null, order.map(function (fid) { var x = teams[fid][r].index; return x == null ? 0 : Math.abs(x - 100); }).concat([1e-9]));
    });
    return { population: (model && model.lineupRule) || "owned", by: by, rows: rows, labels: LABELS, order: order.slice(), teams: teams, league: league,
      typical: (model && model.typical) || {}, slots: (model && model.slots ? model.slots.length : null), slotSource: (model && model.slotSource) || null };
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
      title: (table.by === "slot" ? "Points a week above the slot’s replacement free agent" : "Points a week above replacement") + ", minus the league median (0 = the middle team)" };
  }
  function clamp(x) { return !isFinite(x) ? 0 : Math.max(-1, Math.min(1, x)); }

  var api = { ROWS: ROWS, POSITIONS: POSITIONS, SLOT_ORDER: SLOT_ORDER, LABELS: LABELS, VIEWS: VIEWS, BREAKDOWNS: BREAKDOWNS, build: build, slotRows: slotRows, cell: cell, ordinal: ordinal, mean: mean, median: median };
  if (typeof window !== "undefined") window.UPS_LINEUP_STRENGTH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
