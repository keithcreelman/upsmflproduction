/* Trade finder core (#1338, Keith 2026-10-28; Explore a position 2026-10-30). Pure: no fetch, no DOM. Exploration only — nothing here says a
   trade is fair or that an owner would accept one.

   standing(table, fid, opts): one team's positional strengths and needs from the lineup-strength table
     (site/shared/lineup_strength.js build(model, {by:"position"}), season PPG): each position's PPG, league average,
     gap and rank; "strong" = Top 3 by PPG, "short" = Bottom 3 (the team view's rule). K and P are shown, never tagged.
     opts.forMe (trade_fit.lineupGains().forMe) adds the best real player available at each position: the largest
     lineup gain one player on another team would give this team.
   pairGains(gains, other): the drilldown between my team and one other team, read from trade_fit.lineupGains (same
     numbers as the lists): their players with the gain each would give MY lineup, and my available players with the
     gain each would give THEIR lineup.
   weakSpots(st): the positions to shop for (Keith 2026-10-30): Bottom 3, or modeled PPG below the league average,
     worst rank first. K and P are never listed. The rest of the positions come back as `others`, best rank first.
   positionOptions(model, table, gains, g, fit): the players at position g on other teams whose addition alone would
     raise MY modeled lineup by gains.minGain or more (the same gains.forMe numbers), split by what moving them would
     cost their team: `surplus` = outside that team's modeled lineup (its lineup loses nothing), `starters` = in it,
     each with `loss` = that team's lineup minus its lineup without him (fit.tradeLineup, the same engine). `teams`
     = the other teams with surplus help at g, most help first, with their own rank at g. Lineup math only: nothing
     says an owner would move anyone or that a trade is fair.
   groupOptions(O): positionOptions' players as one list by team, the shape the screen shows: what their lineup would
     lose, least first (ties by my gain). Players sort within a team and teams by their first player. One fixed order
     (Keith 2026-10-30): sorting by my gain only lists the position's top players. Each cost is one player at a time,
     so they never add up.
   rosUsable(file, season, nowMs): whether the rest-of-season answer may be shown. The worker already refuses a stale
     file; this re-checks what a page held open would otherwise keep showing. Anything missing, another season, older
     than ROS_MAX_AGE_DAYS, or no week left to build a lineup for is false, so the screen stays on season PPG and says so.
   rosWeeks(file, ruledOut): the weeks a lineup is built for, each {week, values: {pid: that week's number}}. A week with
     a game already played is left out: its players have no number left, so most of a lineup would be holes (late Sunday,
     nearly all of it). The players' own numbers still cover the rest of that week.
   rosRuledOut(file, teams, availableNow): players the file treats as healthy but MFL now lists out, on IR or suspended.
     The file is up to four days old and the status isn't: they count for no week until a build sees a return date.
   rosTags(file, p, ruledOut): why a rostered player's weeks start late or never: [{text, counted}]. counted false = he
     adds nothing to any lineup. A taxi player's tag says only that: he counts for a team receiving him.
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

  function weakSpots(st) {
    if (!st) return null;
    var rows = st.rows.filter(function (r) { return !r.excluded; });
    var weak = rows.filter(function (r) { return r.tag === "short" || r.gap < -0.05; }).sort(function (a, b) { return (b.rank - a.rank) || (a.gap - b.gap); });
    var others = rows.filter(function (r) { return weak.indexOf(r) === -1; }).sort(function (a, b) { return a.rank - b.rank; });
    return { n: st.n, weak: weak, others: others };
  }

  function round1(n) { return Math.round(n * 10) / 10; }
  function positionOptions(model, table, gains, g, fit) {
    if (!model || !gains || !fit || EXCLUDED[g]) return null;
    var me = gains.fid, surplus = [], starters = [], byTeam = {};
    var playerOf = function (fid, pid) { return (model.teams[fid].team.players || []).filter(function (p) { return p.pid === pid; })[0]; };
    gains.forMe.forEach(function (x) {
      if (x.group !== g) return;
      var tm = model.teams[x.fid], p = playerOf(x.fid, x.pid);
      if (!tm || !p) return;
      var bench = !tm.starterIds[x.pid];
      var loss = bench ? 0 : round1(Math.max(0, tm.total - fit.tradeLineup(model, x.fid, [x.pid], []).total));
      // A weekly model: starting for a bye and costing nothing is still bench.
      if (model.weekly && !loss) bench = true;
      var row = { pid: x.pid, fid: x.fid, v: x.v, gain: x.gain, loss: loss, bench: bench, taxi: String(p.status || "").toUpperCase() === "TAXI_SQUAD",
        rank: table && table.teams[x.fid] && table.teams[x.fid][g] ? table.teams[x.fid][g].rank : null };
      if (bench) {
        surplus.push(row);
        var T = byTeam[x.fid] || (byTeam[x.fid] = { fid: x.fid, n: 0, best: 0, rank: row.rank });
        T.n += 1; if (x.gain > T.best) T.best = x.gain;
      } else starters.push(row);
    });
    surplus.sort(function (a, b) { return (b.gain - a.gain) || (b.v - a.v); });
    starters.sort(function (a, b) { return (b.gain - a.gain) || (a.loss - b.loss); });
    var teams = Object.keys(byTeam).map(function (k) { return byTeam[k]; }).sort(function (a, b) { return (b.best - a.best) || (b.n - a.n); });
    var mine = table && table.teams[me] && table.teams[me][g];
    return { g: g, me: me, minGain: gains.minGain, rank: mine ? mine.rank : null, ppg: mine ? mine.ppg : null, n: table ? table.order.length : null,
      surplus: surplus, starters: starters, teams: teams };
  }

  function groupOptions(O) {
    if (!O) return [];
    var cmp = function (a, b) { return (a.loss - b.loss) || (b.gain - a.gain) || (b.v - a.v); };
    var by = {};
    O.surplus.concat(O.starters).forEach(function (x) {
      (by[x.fid] = by[x.fid] || { fid: x.fid, rank: x.rank, players: [] }).players.push(x);
    });
    var teams = Object.keys(by).map(function (k) { by[k].players.sort(cmp); return by[k]; });
    return teams.sort(function (a, b) { return cmp(a.players[0], b.players[0]); });
  }

  var ROS_MAX_AGE_DAYS = 8;
  function rosUsable(file, season, nowMs) {
    if (!file || file.ok !== true || !file.players || !file.weekly || !file.avail || !file.label || !file.nWeeks || !file.weeks) return false;
    if (Object.keys(file.players).length === 0) return false;
    if (String(file.season) !== String(season)) return false;
    var at = Date.parse(file.asOf);
    return isFinite(at) && nowMs - at <= ROS_MAX_AGE_DAYS * 86400000 && rosWeeks(file).length > 0;
  }
  function rosWeeks(file, ruledOut) {
    var played = file.playedExcluded || {}, pids = Object.keys(file.weekly), out = [];
    for (var i = 0; i < file.nWeeks; i++) {
      var week = file.weeks[0] + i, values = {};
      if (played[week] && played[week].length) continue;
      for (var j = 0; j < pids.length; j++) {
        var v = file.weekly[pids[j]][i];
        if (v != null && !(ruledOut && ruledOut[pids[j]])) values[pids[j]] = v;
      }
      out.push({ week: week, values: values });
    }
    return out;
  }
  function rosRuledOut(file, teams, availableNow) {
    var out = {};
    teams.forEach(function (t) {
      (t.players || []).forEach(function (p) {
        var healthy = availableNow(p) || (String(p.status).toUpperCase() === "TAXI_SQUAD" && availableNow({ chip: p.chip }));
        if (!healthy && !file.avail[p.pid]) out[p.pid] = 1;
      });
    });
    return out;
  }
  function rosTags(file, p, ruledOut) {
    var a = file.avail[p.pid], tags = [];
    if (ruledOut && ruledOut[p.pid]) tags.push({ text: "Status changed: not counted", counted: false });
    else if (a && a.k === "none") tags.push({ text: "No return on file", counted: false });
    else if (a && a.wk && file.weekly[p.pid]) tags.push({ text: "Back Wk " + a.wk + " (MFL)", counted: true });
    else if (a) tags.push({ text: "Return listed, no projection", counted: false });
    if (String(p.status || "").toUpperCase() === "TAXI_SQUAD") tags.push({ text: "Taxi", counted: true });
    return tags;
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

  var api = { POSITIONS: POSITIONS, TOP: TOP, standing: standing, weakSpots: weakSpots, positionOptions: positionOptions, groupOptions: groupOptions, rosUsable: rosUsable, rosWeeks: rosWeeks, rosRuledOut: rosRuledOut, rosTags: rosTags, pairGains: pairGains, selectionToDraft: selectionToDraft };
  if (typeof window !== "undefined") window.UPS_TRADE_FINDER = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
