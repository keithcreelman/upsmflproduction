/* Trade finder core (#1338, Keith 2026-10-28). Pure: no fetch, no DOM. Exploration only — nothing here says a
   trade is fair or that an owner would accept one.

   standing(table, fid, opts): one team's positional strengths and needs from the lineup-strength table
     (site/shared/lineup_strength.js build(model, {by:"position"}), season PPG): each position's PPG, league average,
     gap and rank; "strong" = Top 3 by PPG, "short" = Bottom 3 (the team view's rule). K and P are shown, never tagged.
     opts.forMe (trade_fit.lineupGains().forMe) adds the best real player available at each position: the largest
     lineup gain one player on another team would give this team.
   pairGains(gains, other): the drilldown between my team and one other team, read from trade_fit.lineupGains (same
     numbers as the lists): their players with the gain each would give MY lineup, and my available players with the
     gain each would give THEIR lineup.
   selectionToDraft(sel): the players an owner ticked on either side → the Trade builder's openDraft draft (#1419: my
     players move to them, theirs to me). The builder opens it as an editable, UNSENT draft; nothing is sent.
*/
(function () {
  "use strict";

  var POSITIONS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  var EXCLUDED = { PK: 1, PN: 1 };
  var TOP = 3;

  function standing(table, fid, opts) {
    opts = opts || {};
    var tr = table && table.teams && table.teams[fid];
    if (!tr) return null;
    var n = table.order.length, top = opts.top || TOP;
    var best = {};
    (opts.forMe || []).forEach(function (x) { if (!best[x.group] || x.gain > best[x.group].gain) best[x.group] = x; });
    var rows = POSITIONS.filter(function (g) { return tr[g]; }).map(function (g) {
      var c = tr[g], L = table.league[g] || {}, avg = L.meanPpg == null ? 0 : L.meanPpg;
      var ex = !!EXCLUDED[g];
      var tag = ex ? "" : c.rank <= top ? "strong" : c.rank > n - top ? "short" : "";
      var b = !ex && best[g] ? { pid: best[g].pid, fid: best[g].fid, gain: best[g].gain, v: best[g].v } : null;
      return { g: g, ppg: c.ppg, avg: avg, gap: c.ppg - avg, rank: c.rank, tag: tag, excluded: ex, best: b };
    });
    var pick = function (tag, dir) {
      return rows.filter(function (r) { return r.tag === tag; }).sort(function (a, b) { return dir * (a.rank - b.rank); }).map(function (r) { return r.g; });
    };
    return { fid: fid, n: n, top: top, rows: rows, strong: pick("strong", 1), short: pick("short", -1) };
  }

  function pairGains(gains, other) {
    if (!gains || !other || other === gains.fid) return null;
    var theirs = gains.forMe.filter(function (x) { return x.fid === other; })
      .map(function (x) { return { pid: x.pid, group: x.group, v: x.v, gain: x.gain }; });
    var mine = [];
    gains.fromMe.forEach(function (x) {
      var g = x.gains.filter(function (y) { return y.fid === other; })[0];
      if (g) mine.push({ pid: x.pid, group: x.group, v: x.v, starter: !!x.starter, gain: g.gain });
    });
    mine.sort(function (a, b) { return (b.gain - a.gain) || (b.v - a.v); });
    return { me: gains.fid, other: other, minGain: gains.minGain, theirs: theirs, mine: mine };
  }

  // sel: {me, other, mine:[pid], theirs:[pid]} → the Trade builder's openDraft shape (#1419 contract,
  // builder_opendraft_api.md): { source: "Trade finder", movements: [{from, to, tokens:["P_<pid>"]}] }, one movement per
  // direction that has players; or null (no players, one team, or a player listed twice). No cap money, no picks.
  function selectionToDraft(sel) {
    if (!sel || !sel.me || !sel.other || sel.me === sel.other) return null;
    var mine = (sel.mine || []).map(String), theirs = (sel.theirs || []).map(String);
    if (!mine.length && !theirs.length) return null;
    var seen = {};
    var all = mine.concat(theirs);
    for (var i = 0; i < all.length; i++) { if (seen[all[i]]) return null; seen[all[i]] = 1; }
    var tok = function (pid) { return "P_" + pid; };
    var movements = [];
    if (mine.length) movements.push({ from: sel.me, to: sel.other, tokens: mine.map(tok) });
    if (theirs.length) movements.push({ from: sel.other, to: sel.me, tokens: theirs.map(tok) });
    return { source: "Trade finder", movements: movements };
  }

  var api = { POSITIONS: POSITIONS, TOP: TOP, standing: standing, pairGains: pairGains, selectionToDraft: selectionToDraft };
  if (typeof window !== "undefined") window.UPS_TRADE_FINDER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
