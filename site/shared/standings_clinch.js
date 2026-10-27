/* standings_clinch.js — UPS clinching and elimination letters (Phase 2; X and Y shipped in Phase 1).
   Pure and side-effect free: records in, designations out. No DOM, no fetch.

   Designations (highest applicable wins):  locked seed 1-6  >  Z  >  Y  >  X;  E is separate.
     X  clinched a playoff spot        Y  clinched the division title      Z  clinched a first-round bye
     E  eliminated from EVERY playoff path (no division title, no wild card)
     lock  the exact final seed, 1-6, can no longer change

   THE RULES (docs/league_context_v1.md §F.1/§F.2). 4 divisions of 3; the 4 division winners and the 2 best
   non-winners make the field. Seeds 1-2 (the byes) go to the 2 division winners with the best All-Play; seeds 3-6
   are the other 2 winners and the 2 wild cards in All-Play order. A division is decided by MFL's standingsSort,
   whose first step is H2H win % (PCT). All-Play wins and H2H wins are the only things this module reasons about.

   THE GUARANTEE. A letter is shown only if it holds in EVERY possible finish, never because a forecast is high.
   The futures considered are a superset of the real ones, so a letter can only be late, never wrong:
     - each team's remaining games are independent (a team's All-Play wins may rise by up to the games left, its
       H2H wins by up to the games it has left; the zero-sum link between teams is ignored);
     - any tie is unresolved: a tie on H2H win % never decides a division, a tie on All-Play wins is ordered either
       way (the tiebreakers need points, which the future decides);
     - a division's winner may be anyone who can still finish with the best H2H win % (ties included).
   Every designation is computed twice, by closed-form counting (the "fast" path) and by walking every possible
   division-winner assignment and every All-Play order the intervals allow (the "walk"); a letter needs both to
   agree. The walk gives the exact-seed locks, and refuses (no lock) when the state is too open to finish within
   `maxVisits`.

   analyze(input) -> { status, reason, byFid: { <fid>: { x, y, z, e, lock, label } }, walk: { complete, visits },
                       disagreements: [...] }
   input: {
     teams:      [{ fid, division, h2h: {w,l,t}, ap: {w,l,t} }]   current records (regular season)
     h2hGames:   { <fid>: regular-season H2H games in the season } | null    (null = no schedule: no division claims)
     apGamesLeft: All-Play games each team still has (one result per other team per remaining week)
     byes: 2, wildCards: 2   (the league's format; tests use smaller leagues)
     maxVisits:  walk budget (default 100000)
   }
*/
(function (global) {
  'use strict';

  function analyze(input) {
    var out = { status: 'unavailable', reason: null, byFid: {}, walk: { complete: false, visits: 0 }, disagreements: [] };
    var teamsIn = input && Array.isArray(input.teams) ? input.teams : null;
    if (!teamsIn || teamsIn.length < 4) { out.reason = 'no_teams'; return out; }
    var byes = input.byes == null ? 2 : input.byes, wcN = input.wildCards == null ? 2 : input.wildCards;
    var maxVisits = input.maxVisits == null ? 100000 : input.maxVisits;
    var apLeft = Number(input.apGamesLeft);
    if (!(apLeft >= 0) || !isFinite(apLeft)) { out.reason = 'no_all_play_games_left'; return out; }
    var h2hGames = input.h2hGames && typeof input.h2hGames === 'object' ? input.h2hGames : null;

    var n = teamsIn.length, T = [], divIds = [], divIdx = {};
    for (var i = 0; i < n; i++) {
      var s = teamsIn[i];
      var h = s && s.h2h, a = s && s.ap;
      if (!s || s.fid == null || s.division == null || !rec(h) || !rec(a)) { out.reason = 'records_unreadable'; return out; }
      var d = String(s.division);
      if (divIdx[d] == null) { divIdx[d] = divIds.length; divIds.push(d); }
      var g = h2hGames ? Number(h2hGames[s.fid]) : NaN;
      var played = h.w + h.l + h.t;
      if (h2hGames && (!(g >= played) || !isFinite(g))) { out.reason = 'schedule_unreadable'; return out; }
      T.push({
        fid: String(s.fid), div: divIdx[d],
        // everything in half-wins (a tie is half a win) so comparisons are exact integers
        apMin: 2 * a.w + a.t, apMax: 2 * a.w + a.t + 2 * apLeft,
        hasH2H: !!h2hGames, G: g,
        hMin: 2 * h.w + h.t, hMax: h2hGames ? 2 * (g - h.l) - h.t : null
      });
    }
    if (divIds.length < 2) { out.reason = 'divisions_unreadable'; return out; }
    var divs = divIds.map(function () { return []; });
    T.forEach(function (t, i) { divs[t.div].push(i); });
    if (divs.length < byes || divs.length + wcN > n) { out.reason = 'format_unsupported'; return out; }

    // ── division race (H2H win %; strict, ties unresolved) ──
    // a/b as fractions of the season's games: x beats y outright when xMin/2Gx > yMax/2Gy
    function beatsOutright(x, y) { return x.hMin * y.G > y.hMax * x.G; } // x surely finishes ahead of y on H2H win %
    var canWin = T.map(function (t, i) {
      if (!t.hasH2H) return true;
      return !divs[t.div].some(function (j) { return j !== i && beatsOutright(T[j], t); });
    });
    var surelyWins = T.map(function (t, i) {
      if (!t.hasH2H) return false;
      return divs[t.div].every(function (j) { return j === i || beatsOutright(t, T[j]); });
    });
    var cand = divs.map(function (members) { return members.filter(function (i) { return canWin[i]; }); });
    // a division whose winner cannot be named (no schedule) has all its members as candidates (canWin is true)

    // team x surely finishes strictly ahead of y on All-Play wins
    function apAhead(x, y) { return T[x].apMin > T[y].apMax; }

    // ── fast path (closed forms) ──
    var fast = T.map(function (t, i) {
      var A = i, f = { x: false, y: false, z: false, e: false };
      f.y = surelyWins[A];
      // z: a division winner, and at most (byes-1) other divisions could produce a winner at or above A's All-Play
      var threats = 0;
      divs.forEach(function (_m, d) {
        if (d === t.div) return;
        if (cand[d].some(function (j) { return T[j].apMax >= T[A].apMin; })) threats++;
      });
      f.z = f.y && threats <= byes - 1;
      // x: in the field whatever happens. A winner is in; otherwise at most (wcN-1) non-winners may be at or above A.
      var worst = 0;
      divs.forEach(function (members, d) {
        var P = members.filter(function (j) { return j !== A && T[j].apMax >= T[A].apMin; });
        if (!P.length) return;
        var others = cand[d].filter(function (j) { return j !== A; });
        var winnerSurelyInP = others.length > 0 && others.every(function (j) { return P.indexOf(j) >= 0; });
        worst += P.length - (winnerSurelyInP ? 1 : 0);
      });
      f.x = f.y || worst <= wcN - 1;
      // e: no division title possible, and at least wcN non-winners are surely ahead
      if (!canWin[A]) {
        var lb = 0;
        divs.forEach(function (members, d) {
          var U = members.filter(function (j) { return j !== A && apAhead(j, A); });
          if (!U.length) return;
          var winnerMayBeInU = cand[d].some(function (j) { return U.indexOf(j) >= 0; });
          lb += U.length - (winnerMayBeInU ? 1 : 0);
        });
        f.e = lb >= wcN;
      }
      return f;
    });

    // ── walk: every winner assignment x every All-Play order the intervals allow ──
    var dom = T.map(function (_t, i) { return T.map(function (_u, j) { return i !== j && apAhead(i, j); }); });
    var seen = T.map(function () { return { mask: 0, dwAlways: true, alive: true }; });
    var OUT = 1 << 7, BYE_BITS = 0;
    for (var by = 1; by <= byes; by++) BYE_BITS |= 1 << by;
    var assigns = [[]];
    cand.forEach(function (c) {
      var next = [];
      assigns.forEach(function (a) { c.forEach(function (j) { next.push(a.concat([j])); }); });
      assigns = next;
    });
    var visits = 0, aborted = false, done = false, order = [];
    var seedOf = new Array(n);
    function leaf() {
      for (var ai = 0; ai < assigns.length; ai++) {
        visits++;
        if (visits > maxVisits) { aborted = true; return; }
        var isDW = new Array(n);
        for (var q = 0; q < n; q++) isDW[q] = false;
        assigns[ai].forEach(function (j) { isDW[j] = true; });
        var dws = [], rest = [];
        for (var p = 0; p < n; p++) { var tm = order[p]; (isDW[tm] ? dws : rest).push(tm); }
        var seed = 0;
        for (var z = 0; z < n; z++) seedOf[z] = 0;
        // seeds 1..byes: best division winners; then the other winners and the best wild cards in order
        var pool = dws.slice(byes).concat(rest.slice(0, wcN));
        var posOf = {};
        order.forEach(function (tm, ix) { posOf[tm] = ix; });
        pool.sort(function (u, v) { return posOf[u] - posOf[v]; });
        dws.slice(0, byes).forEach(function (tm) { seedOf[tm] = ++seed; });
        pool.forEach(function (tm) { seedOf[tm] = ++seed; });
        var anyAlive = false;
        for (var m = 0; m < n; m++) {
          var sd = seen[m];
          sd.mask |= seedOf[m] ? (1 << seedOf[m]) : OUT;
          if (!isDW[m]) sd.dwAlways = false;
          if (sd.alive) {
            var bits = sd.mask, nb = 0;
            for (var b = 0; b < 8; b++) if (bits & (1 << b)) nb++;
            // alive while some letter or lock could still hold for this team
            var lockOk = nb === 1;
            var xOk = !(bits & OUT);
            var eOk = !(bits & ~OUT);
            var zOk = xOk && !(bits & ~BYE_BITS);
            var yOk = sd.dwAlways;
            sd.alive = lockOk || xOk || eOk || zOk || yOk;
          }
          if (sd.alive) anyAlive = true;
        }
        if (!anyAlive) { done = true; return; }
      }
    }
    function dfs(depth, remaining) {
      if (aborted || done) return;
      if (depth === n) { leaf(); return; }
      for (var e = 0; e < n; e++) {
        if (!(remaining & (1 << e))) continue;
        var blocked = false;
        for (var r = 0; r < n; r++) if ((remaining & (1 << r)) && dom[r][e]) { blocked = true; break; }
        if (blocked) continue;
        order[depth] = e;
        dfs(depth + 1, remaining & ~(1 << e));
        if (aborted || done) return;
      }
    }
    // A lock needs a team that is in the field whatever happens; with no such team there is nothing to find, so don't walk.
    var anyX = fast.some(function (f) { return f.x; });
    if (anyX && n <= 30) dfs(0, (1 << n) - 1); else aborted = true;
    var complete = !aborted;
    out.walk = { complete: complete || done, visits: visits, stoppedEarly: done };

    out.status = 'ok';
    T.forEach(function (t, i) {
      var f = fast[i], sd = seen[i], w = out.walk.complete;
      var inFieldAlways = !(sd.mask & OUT), onlyOut = !(sd.mask & ~OUT);
      var oneSeed = 0, nbits = 0;
      for (var b = 1; b <= 6; b++) if (sd.mask & (1 << b)) { nbits++; oneSeed = b; }
      var wv = {
        x: w && inFieldAlways, y: w && sd.dwAlways, z: w && inFieldAlways && !(sd.mask & ~BYE_BITS) && nbits >= 1,
        e: w && onlyOut, lock: w && !(sd.mask & OUT) && nbits === 1 ? oneSeed : null
      };
      // a letter needs the fast path; when the walk finished it must agree
      var r = { x: f.x, y: f.y, z: f.z, e: f.e, lock: null };
      if (w) {
        ['x', 'y', 'z', 'e'].forEach(function (k) {
          if (f[k] !== wv[k]) out.disagreements.push({ fid: t.fid, letter: k, fast: f[k], walk: wv[k] });
          r[k] = f[k] && wv[k];
        });
        r.lock = wv.lock;
      }
      // implications keep the hierarchy honest
      if (r.lock) { r.x = true; }
      r.label = r.lock ? String(r.lock) : r.z ? 'Z' : r.y ? 'Y' : r.x ? 'X' : r.e ? 'E' : null;
      out.byFid[t.fid] = r;
    });
    return out;
  }

  function rec(r) {
    return !!r && Number.isInteger(r.w) && Number.isInteger(r.l) && Number.isInteger(r.t) && r.w >= 0 && r.l >= 0 && r.t >= 0;
  }

  var api = { analyze: analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.UPS_STANDINGS_CLINCH = api;
})(typeof window !== 'undefined' ? window : this);
