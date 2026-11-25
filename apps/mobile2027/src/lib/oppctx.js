/* UPS 2027 beta: opponent matchup context for the Fantasy game log ("Opp vs QB: 24th").
   Plain script (browser) and CommonJS (tests). Pure: no network, no DOM, no storage, no clock. ES5 only.

   The metric (one definition per position group, Keith's revision 10, R8):
     Points allowed per game = UPS (MFL) points scored by players of that group against the opponent club, divided by the
     opponent's COMPLETED games, using only weeks BEFORE the matchup week (Weeks 1 to W-1). The matchup itself and every later
     game are never in the sample. Rank 1 = the FEWEST points allowed (the hardest matchup). Ties share a rank (1 + the number of
     clubs that allowed strictly fewer). Ranked among the clubs with at least one completed game in that window; a bye week is
     not a game. Week 1, or an opponent with no completed game yet, has no rank ("—"); last season is never used.
     Offense groups (QB RB WR TE K P): the opponent is the DEFENSE those players faced.
     IDP groups (DL LB DB): the opponent is the OFFENSE those defenders faced: "points allowed to DL" by an offense = the UPS
     points opposing DL scored in games against it. It is a separate metric with its own validation, never a defensive rank.
   Attribution: a player's points go to the club his game-day club played THAT week. The game-day club must come from evidence
   for that week (nflverse weekly team, box score); today's club is never used for a past week. A scored row whose week club is
   unknown, or whose club had no game that week, makes every rank that depends on that week "—" (a missing row is never zero).
   The scorer pool must be complete (every UPS-scored player, not rostered-only) for every week used; the producer says so per
   week (poolComplete), otherwise the rank is "—".

   UPS2027.oppctx.group(position) -> "QB"|"RB"|"WR"|"TE"|"PK"|"PN"|"DL"|"LB"|"DB"|""
   UPS2027.oppctx.build(input) -> index
     input (raw form): { schedule: { week: [{ a, b, final }] }       NFL games that week (MFL club codes; byes are absent)
                         scores: { week: [{ id, score }] }            every UPS-scored player that week
                         positions: { id: "WR" }                       MFL position
                         clubOf: { id: { week: "KCC" } }              game-day club from evidence; absent = unknown
                         poolComplete: { week: true } }
     or (pre-attributed form, e.g. a Worker route built from worker/src/fpa_engine.js fpaCompute's pg rows):
                       { schedule, cells: { week: { def: { grp: { pts, n } } } }, unverified: { week: { grp: n } }, poolComplete }
       def = the club the players faced; unverified = rows credited by a fallback club (today's club) or not credited at all.
   UPS2027.oppctx.rankFor(index, { pos, oppClub, week }) ->
       { state: "ok", text: "Opp vs QB: 24th", label, grp, rank, ofTeams, tied, ppg, pts, games, throughWeek, weeksUsed,
         definition, details: [lines] }
     | { state: "none", text: "—", why, detail }   why: bad_position | bye | no_week | no_prior_games | opp_no_games |
                                                       pool_incomplete | club_unknown
*/
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.oppctx = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var GROUPS = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var IDP = { DL: 1, LB: 1, DB: 1 };
  var LABEL = { PK: "K", PN: "P" };
  var PLURAL = { QB: "quarterbacks", RB: "running backs", WR: "wide receivers", TE: "tight ends", PK: "kickers", PN: "punters",
    DL: "defensive linemen", LB: "linebackers", DB: "defensive backs" };
  var EPS = 1e-9;

  function str(v) { return v == null ? "" : String(v).replace(/^\s+|\s+$/g, ""); }
  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function list(x) { return Object.prototype.toString.call(x) === "[object Array]" ? x : (x == null ? [] : [x]); }
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function ordinal(n) { var v = n % 100, t = n % 10; return n + (v >= 11 && v <= 13 ? "th" : t === 1 ? "st" : t === 2 ? "nd" : t === 3 ? "rd" : "th"); }

  // Same grouping as the Pts Agst engine (worker/src/fpa_engine.js fpaPosGroup).
  function group(p) {
    p = str(p).toUpperCase();
    if (p === "QB") return "QB";
    if (p === "RB" || p === "FB" || p === "HB") return "RB";
    if (p === "WR") return "WR";
    if (p === "TE") return "TE";
    if (p === "PK" || p === "K") return "PK";
    if (p === "PN" || p === "P") return "PN";
    if (p === "DT" || p === "DE" || p === "NT" || p === "DL") return "DL";
    if (p === "LB" || p === "OLB" || p === "ILB" || p === "MLB") return "LB";
    if (p === "CB" || p === "S" || p === "FS" || p === "SS" || p === "DB") return "DB";
    return "";
  }
  function label(grp) { return LABEL[grp] || grp; }

  function weekKeys(o) {
    var out = [], k;
    for (k in o) if (own(o, k) && /^\d+$/.test(k)) out.push(Number(k));
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function bump(o, k, by) { o[k] = (o[k] || 0) + (by == null ? 1 : by); }

  // index.weeks[w] = { games: {club: {opp, final}}, cells: {def: {grp: {pts, n}}}, unverified: {grp: n}, pool: bool }
  function build(input) {
    input = input || {};
    var sched = input.schedule || {}, pool = input.poolComplete || {};
    var weeks = {}, all = {}, i, w, k;
    var ws = weekKeys(sched);
    if (input.cells) { var cw = weekKeys(input.cells); for (i = 0; i < cw.length; i++) all[cw[i]] = 1; }
    if (input.scores) { var sw = weekKeys(input.scores); for (i = 0; i < sw.length; i++) all[sw[i]] = 1; }
    for (i = 0; i < ws.length; i++) all[ws[i]] = 1;
    for (k in all) if (own(all, k)) {
      w = Number(k);
      var games = {}, ms = list(sched[k]);
      for (i = 0; i < ms.length; i++) {
        var a = str(ms[i] && ms[i].a).toUpperCase(), b = str(ms[i] && ms[i].b).toUpperCase();
        if (!a || !b) continue;
        var fin = ms[i].final === true;
        games[a] = { opp: b, final: fin };
        games[b] = { opp: a, final: fin };
      }
      weeks[w] = { games: games, cells: {}, unverified: {}, pool: pool[k] === true };
    }
    if (input.cells) {
      for (k in input.cells) if (own(input.cells, k) && weeks[k]) {
        var C = input.cells[k], d, g;
        for (d in C) if (own(C, d)) for (g in C[d]) if (own(C[d], g)) {
          var pts = num(C[d][g] && C[d][g].pts);
          if (pts == null || GROUPS.indexOf(g) < 0) continue;
          var D = str(d).toUpperCase();
          var cell = (weeks[k].cells[D] = weeks[k].cells[D] || {})[g] = weeks[k].cells[D][g] || { pts: 0, n: 0 };
          cell.pts += pts; cell.n += num(C[d][g].n) || 0;
        }
        var U = input.unverified && input.unverified[k];
        if (U) for (g in U) if (own(U, g) && num(U[g]) > 0) bump(weeks[k].unverified, g, num(U[g]));
      }
    } else if (input.scores) {
      var pos = input.positions || {}, clubOf = input.clubOf || {};
      for (k in input.scores) if (own(input.scores, k) && weeks[k]) {
        var rows = list(input.scores[k]), W = weeks[k];
        for (i = 0; i < rows.length; i++) {
          var id = str(rows[i] && rows[i].id), sc = num(rows[i] && rows[i].score);
          if (!id || sc == null) continue;
          var grp = group(pos[id]);
          if (!grp) continue;
          var club = str(clubOf[id] && clubOf[id][k]).toUpperCase();
          var gm = club ? W.games[club] : null;
          // Unknown game-day club, or a club with no game that week: the row cannot be credited. Never today's club.
          if (!gm) { bump(W.unverified, grp); continue; }
          if (!gm.final) continue;   // not a completed game: never counted
          var c2 = (W.cells[gm.opp] = W.cells[gm.opp] || {})[grp] = W.cells[gm.opp][grp] || { pts: 0, n: 0 };
          c2.pts += sc; c2.n++;
        }
      }
    }
    return { weeks: weeks };
  }

  function none(why, detail) { return { state: "none", text: "—", why: why, detail: detail || "" }; }

  function definition(grp, opp, hi) {
    var through = hi === 1 ? "Week 1" : "Weeks 1–" + hi;
    var who = PLURAL[grp] || grp;
    if (IDP[grp]) return "UPS points scored by opposing " + who + " against " + opp + "'s offense per completed game, " + through +
      " (before this game). Rank 1 = the offense that allowed the fewest. An offense's figure, not a defensive rank.";
    return "UPS points scored by " + who + " against " + opp + "'s defense per completed game, " + through +
      " (before this game). Rank 1 = the defense that allowed the fewest.";
  }

  function rankFor(index, q) {
    q = q || {};
    var grp = group(q.pos);
    if (!grp) return none("bad_position", "No opponent figure for this position.");
    var opp = str(q.oppClub).toUpperCase();
    if (!opp) return none("bye", "No game this week.");
    var week = Math.floor(num(q.week) || 0);
    if (week < 1) return none("no_week", "The matchup week is unknown.");
    var W = (index && index.weeks) || {};
    var tot = {}, games = {}, used = [], hi = 0, w, c;
    for (w = 1; w < week; w++) {
      var X = W[w];
      if (!X) continue;
      var any = false;
      for (c in X.games) if (own(X.games, c) && X.games[c].final) { any = true; break; }
      if (!any) continue;   // no completed game that week (not started, or no data): nothing to count
      if (!X.pool) return none("pool_incomplete", "Week " + w + " scores are not the full league pool, so no rank is shown.");
      if (X.unverified[grp] > 0) return none("club_unknown", "Week " + w + ": " + X.unverified[grp] + " " + label(grp) +
        " score" + (X.unverified[grp] === 1 ? "" : "s") + " without a known game-day club, so no rank is shown.");
      for (c in X.games) if (own(X.games, c) && X.games[c].final) {
        games[c] = (games[c] || 0) + 1;
        var cell = X.cells[c] && X.cells[c][grp];
        tot[c] = (tot[c] || 0) + (cell ? cell.pts : 0);   // a completed game with a complete pool and no scorer = 0 allowed
      }
      used.push(w); hi = w;
    }
    if (!used.length) return none("no_prior_games", "No completed games before Week " + week + ".");
    if (!games[opp]) return none("opp_no_games", opp + " has no completed game before Week " + week + ".");
    var ppg = {}, clubs = [];
    for (c in games) if (own(games, c) && games[c] > 0) { ppg[c] = tot[c] / games[c]; clubs.push(c); }
    var mine = ppg[opp], fewer = 0, same = 0;
    for (var i = 0; i < clubs.length; i++) {
      if (ppg[clubs[i]] < mine - EPS) fewer++;
      else if (Math.abs(ppg[clubs[i]] - mine) <= EPS) same++;
    }
    var rank = fewer + 1, of = clubs.length, L = label(grp);
    var through = hi === 1 ? "Week 1" : "Weeks 1–" + hi;
    return {
      state: "ok", text: "Opp vs " + L + ": " + ordinal(rank), label: L, grp: grp, idp: !!IDP[grp], opp: opp, week: week,
      rank: rank, ofTeams: of, tied: same > 1, ppg: r1(mine), pts: r1(tot[opp]), games: games[opp], throughWeek: hi, weeksUsed: used,
      definition: definition(grp, opp, hi),
      details: [
        opp + (IDP[grp] ? "'s offense" : "") + " allowed " + r1(mine).toFixed(1) + " points per game to " + L + " (" + r1(tot[opp]).toFixed(1) +
          " in " + games[opp] + " game" + (games[opp] === 1 ? "" : "s") + ").",
        "Rank " + ordinal(rank) + " of " + of + (same > 1 ? " (tied)" : "") + "; 1st = fewest allowed.",
        "Sample: completed games, " + through + ". Week " + week + " and later are not included."
      ]
    };
  }

  return { GROUPS: GROUPS, group: group, label: label, build: build, rankFor: rankFor, ordinal: ordinal };
});
