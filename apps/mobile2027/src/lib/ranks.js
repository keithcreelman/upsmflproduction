/* UPS 2027 beta (PR B): season totals, per-game figures and ranks. Pure functions: no network, no storage, no DOM.

   Exactness. Every score is held as an integer number of hundredths ("cents"). Two per-game figures are compared by cross-multiplying integers, never by
   rounding: 8.3375 and 8.3401 are different, two players with exactly equal figures share a rank, and nobody is pushed down by a tie.

   Ranks (owner rulings 2026-11-21):
   - Season-points rank and weekly rank have no minimum-game rule. They are exact only while the pool is covered: a competitor who cannot be placed in a
     position group (or whose score is not a valid number) and who has a higher total widens the rank to a range instead of being ignored.
   - Per-game rank needs scores in at least half of the historically supported completed team games, rounded up. Where weeks of a player's history are
     unknown, the supported games S and an upper bound U (the unknown weeks counted as possible games) are both kept: if every denominator from S to U gives
     the same answer it is used; if not the player is UNSETTLED and his rank is withheld. An unsettled player who could qualify is an uncertain competitor:
         best  = 1 + definitely eligible players with a strictly higher per-game figure
         worst = best + unsettled players with a strictly higher figure (they could all qualify)
         pool  = settled eligible count up to settled plus unsettled
     Equal figures never change a rank (they can change the pool bounds). The worst case is a conservative bound: unsettled players' outcomes can be linked,
     so no single case may reach it. No score, total or team-game count is ever invented. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.ranks = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function isInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }
  // A recorded MFL score as integer hundredths, or null (not a number, or more precision than MFL records).
  function toCents(v) {
    if (v == null || typeof v === "boolean" || (typeof v === "string" && v.trim() === "")) return null;
    var x = Number(v);
    if (!isFinite(x)) return null;
    var c = Math.round(x * 100);
    return Math.abs(x * 100 - c) < 1e-6 ? c : null;
  }
  function fmtCents(c, digits) { return c == null ? "—" : (c / 100).toFixed(digits == null ? 1 : digits); }
  // Compare two per-game figures total/n exactly: 1, 0 or -1 (a higher than b).
  function cmpPPG(a, b) { var x = a.total * b.n, y = b.total * a.n; return x > y ? 1 : x < y ? -1 : 0; }

  // ---------- eligibility for the per-game rank ----------
  // n: scored games; S: supported team games; U: S plus the unknown weeks that could have been games. All integers.
  // -> { status: "eligible" | "below" | "unsettled" | "none", need, why }
  function eligibility(n, S, U, history) {
    if (history && history !== "ok") return { status: "unsettled", need: null, why: history === "conflict" ? "Team history conflict" : history === "unavailable" ? "Team history unavailable" : "Team history incomplete" };
    if (!isInt(n) || n < 0) return { status: "unsettled", need: null, why: "Scored games unavailable" };
    if (n === 0) return { status: "none", need: null, why: "No scores recorded" };
    if (!isInt(S) || !isInt(U) || S < 0 || U < S) return { status: "unsettled", need: null, why: "Team history incomplete" };
    if (n > U) return { status: "unsettled", need: null, why: "Team history conflict" };   // more scores than games he could have played
    if (S === U) { // every week is known
      var need = Math.ceil(S / 2);
      return n >= need ? { status: "eligible", need: need, why: "" } : { status: "below", need: need, why: "Needs " + need + " of " + S + " team games" };
    }
    if (n >= Math.ceil(U / 2)) return { status: "eligible", need: Math.ceil(U / 2), why: "" };          // enough under the largest possible count, so under every smaller one
    if (n < Math.ceil(S / 2)) return { status: "below", need: Math.ceil(S / 2), why: "Needs " + Math.ceil(S / 2) + " of " + S + " team games" }; // short even under the smallest count
    return { status: "unsettled", need: null, why: "Team history incomplete" };
  }

  // ---------- per-game rank ----------
  // entries: [{ id, group, total (cents), n, status }] where status comes from eligibility(). Returns null unless the player is eligible.
  function perGameRank(entries, id) {
    var me = null, i;
    for (i = 0; i < entries.length; i++) if (entries[i].id === id) { me = entries[i]; break; }
    if (!me || me.status !== "eligible") return null;
    var best = 1, worst = 0, lo = 0, hi = 0;
    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.group !== me.group) continue;
      if (e.status === "eligible") { lo++; if (e.id !== me.id && cmpPPG(e, me) > 0) best++; }
      else if (e.status === "unsettled" && e.n > 0) { hi++; if (cmpPPG(e, me) > 0) worst++; }
    }
    return { group: me.group, best: best, worst: best + worst, poolLo: lo, poolHi: lo + hi, exact: worst === 0 };
  }

  // ---------- season and weekly ranks (no minimum-game rule) ----------
  // entries: [{ id, group, value (cents) }] for players placed in a group with a valid value; unplaced: [{ value }] competitors who could not be placed.
  function totalRank(entries, id, unplaced) {
    var me = null, i;
    for (i = 0; i < entries.length; i++) if (entries[i].id === id) { me = entries[i]; break; }
    if (!me) return null;
    var best = 1, pool = 0, up = 0, un = (unplaced || []);
    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.group !== me.group) continue;
      pool++; if (e.id !== me.id && e.value > me.value) best++;
    }
    for (i = 0; i < un.length; i++) if (typeof un[i].value === "number" ? un[i].value > me.value : true) up++; // an unplaced competitor with no usable value could be ahead
    return { group: me.group, best: best, worst: best + up, poolLo: pool, poolHi: pool + un.length, exact: up === 0 };
  }

  // ---------- season totals from weekly reads ----------
  // weeks: { week: { id: score } } for weeks 1..N (a week that failed to load must not be in `weeks`: the caller withholds instead of passing a partial set).
  // groupOf: id -> position group or "" (unplaced). Returns { totals: { id: { total, n } }, entries, unplaced, invalid }.
  function seasonFrom(weeks, upTo, groupOf) {
    var totals = {}, invalid = {}, w, id;
    for (w = 1; w <= upTo; w++) {
      var wk = weeks[w] || {};
      for (id in wk) {
        if (!Object.prototype.hasOwnProperty.call(wk, id)) continue;
        var c = toCents(wk[id]);
        if (c == null) { invalid[id] = true; continue; }
        var t = totals[id] || (totals[id] = { total: 0, n: 0 }); t.total += c; t.n += 1;
      }
    }
    var entries = [], unplaced = [];
    for (id in totals) {
      if (!Object.prototype.hasOwnProperty.call(totals, id)) continue;
      var g = groupOf(id);
      if (invalid[id] || !g) unplaced.push({ id: id, value: invalid[id] ? null : totals[id].total });
      else entries.push({ id: id, group: g, value: totals[id].total });
    }
    for (id in invalid) if (Object.prototype.hasOwnProperty.call(invalid, id) && !totals[id]) unplaced.push({ id: id, value: null });
    return { totals: totals, entries: entries, unplaced: unplaced, invalid: invalid };
  }
  // One completed week: { id: score } -> the same shapes for a weekly rank.
  function weekFrom(scores, groupOf) {
    var entries = [], unplaced = [], id;
    for (id in scores) {
      if (!Object.prototype.hasOwnProperty.call(scores, id)) continue;
      var c = toCents(scores[id]), g = groupOf(id);
      if (c == null || !g) unplaced.push({ id: id, value: c });
      else entries.push({ id: id, group: g, value: c });
    }
    return { entries: entries, unplaced: unplaced };
  }

  // ---------- text ----------
  function range(a, b) { return a === b ? String(a) : a + "–" + b; }
  // "QB 3 of 35–56", "WR 63–66 of 169–210", "QB 4 of 73". r comes from perGameRank or totalRank.
  function rankText(r) {
    if (!r) return "";
    return r.group + " " + range(r.best, r.worst) + " of " + range(r.poolLo, r.poolHi);
  }
  // The expansion text: what is exact, what is a bound, and how many players are unsettled.
  function rankDetail(r, label) {
    if (!r) return "";
    var unsettled = r.poolHi - r.poolLo;
    var head = r.exact ? (r.best + " is exact" + (unsettled ? ": no " + r.group + " with unsettled eligibility could rank ahead" : "")) : ("Best " + r.best + ", worst " + r.worst + ": " + (r.best - 1) + " settled " + r.group + (r.best - 1 === 1 ? " is" : "s are") + " ahead, and up to " + (r.worst - r.best) + " with unsettled eligibility could also be. The worst case is a bound, not a result");
    return head + ". " + r.poolLo + " " + r.group + (r.poolLo === 1 ? " is" : "s are") + " settled" + (unsettled ? "; up to " + unsettled + " more are unsettled" : "") + ".";
  }

  return { toCents: toCents, fmtCents: fmtCents, cmpPPG: cmpPPG, eligibility: eligibility, perGameRank: perGameRank, totalRank: totalRank, seasonFrom: seasonFrom, weekFrom: weekFrom, rankText: rankText, rankDetail: rankDetail, isInt: isInt };
});
