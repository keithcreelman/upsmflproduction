/* Actual starter mix — which positions each team really starts, from the lineups
   it submitted in completed weeks (#1338, Keith 2026-10-21). Pure: no fetch, no DOM.

   NOT THE STRENGTH MODEL. Lineup strength (trade_fit + lineup_strength) is a
   modeled best lineup on season PPG. This is what owners actually started:
   MFL's weeklyResults (W=YTD, one read), each franchise's `starters` list per
   week, completed weeks only (the season-scoring completed week).

   NATURAL POSITION. Each starter counts at his MFL position's lineup group
   (QB, RB, WR, TE, DL, LB, DB, K, P). Average per week = starts at that
   position ÷ valid weeks, so a team that started 3 RBs in 2 of 5 weeks and 2
   in the rest shows 2.4.

   FLEX AND SUPERFLEX: ONLY WHAT MFL'S RECORD PROVES (Keith 2026-10-21). MFL
   records who started, not which slot each starter filled, and this never
   uses game results to assign one. A position's starters beyond its fixed
   slots ("extras") are attributed to a Flex row only when exactly one kind
   of Flex slot accepts that position: a second QB can only be Superflex
   (ordinary Flex doesn't take a QB), an extra DL/LB/DB can only be IDP Flex.
   An extra RB, WR or TE could be in Flex or Superflex, so those are counted
   together as FLEXIBLE ("Flexible slots": the Flex slots plus Superflex when
   it isn't a QB). Superflex shows its QB share; the rest of its starts are
   inside Flexible slots. A slot assignment by points would be modeled, and
   is never shown as actual.

   INVALID OR INCOMPLETE WEEKS ARE NAMED, NEVER AVERAGED IN SILENTLY. A week
   counts only when its starters fill every required slot exactly (e.g. 18 of
   18, each position inside MFL's range). Otherwise the week is listed with
   the reason ("17 of 18 starters", "3 QB — more than the lineup allows",
   "no lineup", "position unknown") and left out of the averages, and the card
   says "N of M weeks".
*/
(function () {
  "use strict";

  var GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];

  function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  // MFL weeklyResults JSON (W=YTD → allWeeklyResults.weeklyResults[], one week → weeklyResults) → {week: {fid: {starters[]}}}.
  // A franchise appears once per game that week; every copy is the same submitted lineup (a disagreement is flagged).
  function lineupsByWeek(json) {
    var weeks = json && json.allWeeklyResults ? asArray(json.allWeeklyResults.weeklyResults) : asArray(json && json.weeklyResults);
    var out = {};
    weeks.forEach(function (w) {
      var wk = parseInt(w && w.week, 10);
      if (!wk) return;
      var fr = [];
      asArray(w.matchup).forEach(function (m) { fr = fr.concat(asArray(m.franchise)); });
      fr = fr.concat(asArray(w.franchise));
      var byFid = out[wk] = out[wk] || {};
      fr.forEach(function (f) {
        if (!f || !f.id) return;
        var starters = String(f.starters || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        var key = starters.slice().sort().join(",");
        if (byFid[f.id]) { if (byFid[f.id].key !== key) byFid[f.id].conflict = true; return; }
        byFid[f.id] = { starters: starters, key: key };   // who started; points are never used here
      });
    });
    return out;
  }

  // One week's starters → counts by natural position and whether they fill the league's slots exactly.
  // slots = trade_fit deriveSlots(...). groupOf(pid) → lineup group or "". The fit check places players in any order
  // (fixed slots first, then Flex narrowest first — exact for MFL's nested ranges); no score is used and the
  // placement itself is never reported.
  function placeWeek(entry, slots, groupOf) {
    var res = { counts: {}, issues: [] };
    GROUPS.forEach(function (g) { res.counts[g] = 0; });
    if (!entry || !entry.starters.length) { res.issues.push("no lineup"); return res; }
    if (entry.conflict) res.issues.push("MFL lists two different lineups");
    var byGroup = {}, unknown = 0;
    entry.starters.forEach(function (pid) {
      var g = groupOf(pid);
      if (GROUPS.indexOf(g) === -1) { unknown += 1; return; }
      res.counts[g] += 1;
      (byGroup[g] = byGroup[g] || []).push(pid);
    });
    if (unknown) res.issues.push(unknown + " starter" + (unknown === 1 ? "" : "s") + " with an unknown position");
    var used = {}, placed = 0, empty = 0;
    function take(accepts) {
      for (var i = 0; i < accepts.length; i++) {
        var list = byGroup[accepts[i]] || [];
        for (var j = 0; j < list.length; j++) if (!used[list[j]]) { used[list[j]] = 1; return true; }
      }
      return false;
    }
    slots.forEach(function (s) { if (!s.flex) { if (take(s.accepts)) placed += 1; else empty += 1; } });
    slots.forEach(function (s) { if (s.flex) { if (take(s.accepts)) placed += 1; else empty += 1; } });
    var known = entry.starters.length - unknown;
    if (placed < known) {
      // Starters left over: more at a position than the lineup allows.
      var left = {};
      Object.keys(byGroup).forEach(function (g) { byGroup[g].forEach(function (pid) { if (!used[pid]) left[g] = (left[g] || 0) + 1; }); });
      Object.keys(left).forEach(function (g) { res.issues.push(res.counts[g] + " " + label(g) + " — more than the lineup allows"); });
    }
    if (empty && entry.starters.length < slots.length) res.issues.push(entry.starters.length + " of " + slots.length + " starters");
    else if (empty && !res.issues.length) res.issues.push(placed + " of " + slots.length + " slots filled");
    return res;
  }
  function label(g) { return g === "PK" ? "K" : g === "PN" ? "P" : g; }

  // opts: {weeklyResults (MFL JSON), completedWeek, slots, groupOf, fids?}. Returns
  // { weeks: [1..completedWeek], slotsPerWeek, teams: {fid: {...}}, league: {...} }.
  function build(opts) {
    var slots = opts.slots || [];
    var completed = parseInt(opts.completedWeek, 10) || 0;
    var weeks = [];
    for (var w = 1; w <= completed; w++) weeks.push(w);
    var byWeek = lineupsByWeek(opts.weeklyResults);
    var fids = opts.fids || Object.keys(weeks.reduce(function (acc, wk) { Object.keys(byWeek[wk] || {}).forEach(function (f) { acc[f] = 1; }); return acc; }, {})).sort();
    // Per flex row: how many slots. Per group: its fixed slots, and the flex rows that accept it — one row → its extras
    // are provably in that row; more than one → FLEXIBLE.
    var flexRows = {}, fixedN = {}, rowsFor = {};
    slots.forEach(function (s) {
      if (!s.flex) { fixedN[s.row] = (fixedN[s.row] || 0) + 1; return; }
      flexRows[s.row] = (flexRows[s.row] || 0) + 1;
      s.accepts.forEach(function (g) { var l = rowsFor[g] = rowsFor[g] || []; if (l.indexOf(s.row) === -1) l.push(s.row); });
    });
    var ambiguousRows = {};
    Object.keys(rowsFor).forEach(function (g) { if (rowsFor[g].length > 1) rowsFor[g].forEach(function (r) { ambiguousRows[r] = 1; }); });
    var teams = {};
    function blankMix() {
      var mix = { FLEXIBLE: { total: 0, by: {}, rows: Object.keys(ambiguousRows) } };
      Object.keys(flexRows).forEach(function (r) { mix[r] = { total: 0, by: {}, slots: flexRows[r] }; });
      return mix;
    }
    var leagueTotals = {}, leagueMix = blankMix(), leagueWeeks = 0;
    GROUPS.forEach(function (g) { leagueTotals[g] = 0; });
    fids.forEach(function (fid) {
      var tot = {}, mix = blankMix(), valid = [], issues = [];
      GROUPS.forEach(function (g) { tot[g] = 0; });
      weeks.forEach(function (wk) {
        var placed = placeWeek((byWeek[wk] || {})[fid], slots, opts.groupOf);
        if (placed.issues.length) { issues.push({ week: wk, text: placed.issues.join("; ") }); return; }
        valid.push(wk);
        GROUPS.forEach(function (g) { tot[g] += placed.counts[g]; leagueTotals[g] += placed.counts[g]; });
        [mix, leagueMix].forEach(function (m) {
          Object.keys(flexRows).forEach(function (r) { m[r].total += flexRows[r]; });
          Object.keys(rowsFor).forEach(function (g) {
            var extra = placed.counts[g] - (fixedN[g] || 0);
            if (extra <= 0) return;
            var into = rowsFor[g].length === 1 ? m[rowsFor[g][0]] : m.FLEXIBLE;
            into.by[g] = (into.by[g] || 0) + extra;
            if (into === m.FLEXIBLE) into.total += extra;
          });
        });
      });
      leagueWeeks += valid.length;
      var avg = {};
      GROUPS.forEach(function (g) { avg[g] = valid.length ? tot[g] / valid.length : null; });
      teams[fid] = { fid: fid, weeks: weeks.length, validWeeks: valid, issues: issues, totals: tot, avg: avg, mix: mix };
    });
    var lavg = {};
    GROUPS.forEach(function (g) { lavg[g] = leagueWeeks ? leagueTotals[g] / leagueWeeks : null; });
    return { weeks: weeks, slotsPerWeek: slots.length, flexRows: Object.keys(flexRows), ambiguousRows: Object.keys(ambiguousRows), rowsFor: rowsFor, teams: teams,
      league: { teamWeeks: leagueWeeks, avg: lavg, mix: leagueMix } };
  }

  // A row's mix as [{g, n, pct, whole}] (largest first), over the row's total starts (a Superflex row's QB share is
  // QB starts ÷ Superflex starts; its other starts are inside FLEXIBLE) — "Flex: 60% WR · 30% RB · 10% TE". `whole` = pct in whole
  // numbers that add up to exactly 100 (largest remainder), so a shown mix never reads 99% or 101%.
  function mixList(mixRow) {
    if (!mixRow || !mixRow.total) return [];
    var rest = mixRow.total - Object.keys(mixRow.by).reduce(function (a, g) { return a + mixRow.by[g]; }, 0);
    var list = Object.keys(mixRow.by).map(function (g) { return { g: g, n: mixRow.by[g], pct: mixRow.by[g] / mixRow.total * 100 }; })
      .sort(function (a, b) { return b.n - a.n || (a.g < b.g ? -1 : 1); });
    if (rest > 0) list.push({ g: "", n: rest, pct: rest / mixRow.total * 100 });   // g "" = not attributable here
    var left = 100;
    list.forEach(function (x) { x.whole = Math.floor(x.pct); left -= x.whole; });
    list.slice().sort(function (a, b) { return Math.round((b.pct - b.whole) * 1e6) - Math.round((a.pct - a.whole) * 1e6) || b.n - a.n; })
      .slice(0, left).forEach(function (x) { x.whole += 1; });
    return list;
  }

  var api = { GROUPS: GROUPS, lineupsByWeek: lineupsByWeek, placeWeek: placeWeek, build: build, mixList: mixList, label: label };
  if (typeof window !== "undefined") window.UPS_STARTER_MIX = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
