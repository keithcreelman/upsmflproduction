/* UPS 2027 beta (R7): positional stat ranks for the Breakdown's season stats. Pure functions: no network, no storage, no DOM.

   Source: the UPS Worker's /api/position-season-stats answer for ONE position group, season and week W* (the shared cutoff,
   tabviews.seasonCutoff): per player, the season SUMS of each count over Weeks 1..W*, the team denominators over his games, and per-field
   coverage (`cov`: weeks with a value, given only when fewer than his weeks). The pool is exactly that answer's `players` list
   (accepted MFL id map rows by MFL position: QB, RB, WR, TE, PK, PN, DL = DE+DT, LB, DB = CB+S).

   Rules:
     - a rank is 1 + the number of players strictly better, so tied players share a rank ("K1" for every kicker at 100%);
     - direction per stat (fewer is better for INT rate, sacks taken and sack yards);
     - totals and shares rank as descriptions of volume or role, not quality (Help says so);
     - a rate (and a fewer-is-better total) ranks only players whose OWN denominator reaches the bar in RATE_BARS: per team game x the fewest
       games any NFL club has played through W*. A rate rank is withheld only when his denominator is missing or below the bar, never
       because of ties;
     - a competitor whose figure is missing or incomplete, and who could be ahead of him (or, for a rate, might reach the minimum), is
       "unplaced": the rank is then "—" and Rank details give the bounds and the cause; no range is ever displayed (R7b final). A competitor
       whose incomplete total is already ahead (totals only grow) is counted as ahead;
     - his own figure in the answer must equal the figure the season table shows, else the rank is withheld (the two reads disagree). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.statranks = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var DASH = "—";

  // ---------- THE threshold table (one place). Proposed, pending Keith's approval. ----------
  // perGame: the bar per team game, per position group. The bar at W* = perGame x the fewest games any NFL club has played through W*
  // (the pool answer does not carry each player's club, so every player of a group gets the same bar). Week 10 evidence: r7r_thresholds.md.
  // min: an absolute floor per group (WR/TE carries), so the bar is max(perGame x G, min). Exact minimums are proposals pending evidence review.
  // No range is ever displayed (R7b final: "missing underlying stats: show — for affected ranks"; the four-place range rule is retired for every
  // stat). A rank is exact when no incomplete competitor could change his place, else "—" with the bounds and the cause in Rank details.
  // No minimum number of qualifiers: a small qualifying group alone never withholds a valid rank (R7b final).
  var RATE_BARS = {
    status: "proposed, pending Keith's approval",
    teamGames: "fewest games any NFL club has played through W* (all final), from the MFL schedule",
    bars: {
      cmp_pct: { den: "pass attempts", perGame: { QB: 15 } },
      ypa: { den: "pass attempts", perGame: { QB: 15 } },
      air_per_att: { den: "pass attempts", perGame: { QB: 15 } },
      // R8: interceptions rank as a RATE (INT rate = interceptions / pass attempts x 100, fewer is better); the raw count is shown without a rank.
      // Week 10 evidence (r8c.md): bar 135 attempts, 31 of 66 QBs with an attempt qualify, the same on the recorded pool and on nflverse.
      // R9 (Keith: keep 15 per team game provisionally). G is the FEWEST games any club has played (9 at Week 10), not the player's own club's
      // games (9 or 10): the pool answer carries no club. Snapshot check (r9c.md): 14/g 126 -> 31 QBs, 15/g 135 -> 31, 20/g 180 -> 27, fixed 150 -> 30.
      int_rate: { den: "pass attempts", perGame: { QB: 15 } },
      sacks_taken: { den: "pass attempts + sacks (dropbacks without scrambles; scrambles are not stored)", perGame: { QB: 17 } },
      sack_yds: { den: "pass attempts + sacks", perGame: { QB: 17 } },
      ypc: { den: "carries", perGame: { RB: 5, WR: 0.5, TE: 0.3 }, min: { WR: 8, TE: 5 } },
      catch_rate: { den: "targets", perGame: { RB: 1.5, WR: 3, TE: 2 } },
      y_rec: { den: "receptions", perGame: { RB: 1, WR: 2, TE: 1.5 } },
      y_tgt: { den: "targets", perGame: { RB: 1.5, WR: 3, TE: 2 } },
      adot: { den: "targets", perGame: { RB: 1.5, WR: 3, TE: 2 } },
      snap_share: { den: "games with a snap row (the share is his snaps over his club's snaps in those games)", perGame: { QB: 0.5, RB: 0.5, WR: 0.5, TE: 0.5 } },
      def_share: { den: "games with a snap row (his defensive snaps over his club's in those games)", perGame: { DL: 0.5, LB: 0.5, DB: 0.5 } },
      tackles_per_snap: { den: "defensive snaps", perGame: { DL: 25, LB: 25, DB: 25 } },
      pressure_rate: { den: null, perGame: null, withheld: "No pass-rush snap count exists (snap counts are offense, defense and special teams only; the PFR ingest stores pressures only), so pressure rate is not ranked." },
      fg_pct: { den: "field goal attempts", perGame: { PK: 1 } },
      xp_pct: { den: "extra point attempts", perGame: { PK: 1 } },
      gross: { den: "punts", perGame: { PN: 2 } },
      i20_pct: { den: "punts", perGame: { PN: 2 } }
    }
  };

  var GROUPS = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", K: "PK", PN: "PN", P: "PN", DE: "DL", DT: "DL", DL: "DL", LB: "LB", CB: "DB", S: "DB", DB: "DB" };
  var PREFIX = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", PN: "P", DL: "DL", LB: "LB", DB: "DB" };
  function groupOf(pos) { return GROUPS[String(pos || "").toUpperCase()] || ""; }

  // ---------- the metrics ----------
  // kind: "count" (more ranks higher), "low" (fewer ranks higher; only players over the bar), "rate" (n/d; only players over the bar).
  // what: "volume" | "role" (descriptive) or "quality". f: the answer's fields it reads. val(s) -> count, or [n, d]. q(e) -> the qualifying denominator.
  var M = {};
  // qf: the fields the qualifying denominator is made of (a partial one may still reach the bar).
  function def(id, kind, what, f, val, q, qf) { M[id] = { id: id, kind: kind, what: what, f: f, val: val, q: q || null, qf: qf || [] }; }
  function fld(k) { return function (s) { return s[k]; }; }
  function cnt(id, k) { def(id, "count", "volume", [k], fld(k)); }
  function sum2(a, b) { return function (s) { return s[a] + s[b]; }; }
  function rt(id, what, a, b, q) { def(id, "rate", what, [a, b], function (s) { return [s[a], s[b]]; }, q ? q.fn : function (e) { return e.s[b]; }, q ? q.f : [b]); }
  function qOf(fields, fn) { return { f: fields, fn: fn }; }
  // counts (volume), as the season table names them
  ["pass_cmp", "pass_att", "pass_yds", "pass_tds", "passing_air_yards", "rush_att", "rush_yds", "rush_tds", "targets", "receptions", "rec_yds", "rec_tds", "receiving_air_yards",
    "pass_att_i20", "pass_cmp_i20", "pass_tds_i20", "pass_att_ez", "rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_tds_i20", "targets_i20", "targets_i10", "targets_i5", "rec_i20", "rec_tds_i20", "targets_ez",
    "def_tackles_solo", "def_tackles_ast", "def_tfl", "def_sacks", "def_sack_yds", "def_qb_hits", "def_pressures", "def_ints", "def_pass_def", "def_ff", "def_fr", "def_tds",
    "off_snaps", "def_snaps", "st_snaps", "fg_made", "fg_att_0_39", "fg_att_40_49", "fg_att_50_59", "fg_att_60plus", "punts", "punt_inside20"].forEach(function (k) { cnt(k, k); });
  def("total_td", "count", "volume", ["rush_tds", "rec_tds"], sum2("rush_tds", "rec_tds"));
  def("tackles_mfl", "count", "volume", ["def_tackles_total", "def_tackles_ast"], function (s) { var v = s.def_tackles_total - s.def_tackles_ast; return v >= 0 ? v : null; });
  // fewer is better: totals ranked among players over the bar
  def("sacks_taken", "low", "quality", ["pass_sacks"], fld("pass_sacks"), function (e) { return add(e.s.pass_att, e.s.pass_sacks); }, ["pass_att", "pass_sacks"]);
  def("sack_yds", "low", "quality", ["pass_sack_yds"], function (s) { return Math.abs(s.pass_sack_yds); }, function (e) { return add(e.s.pass_att, e.s.pass_sacks); }, ["pass_att", "pass_sacks"]);
  // R8: fumbles lost are no longer displayed (Keith, display decision only: MFL points still count them), so they have no rank metric or bar here.
  // rates
  rt("cmp_pct", "quality", "pass_cmp", "pass_att");
  rt("int_rate", "quality", "pass_ints", "pass_att"); M.int_rate.low = true;   // INT rate: fewer is better
  rt("ypa", "quality", "pass_yds", "pass_att"); rt("air_per_att", "role", "passing_air_yards", "pass_att");
  rt("ypc", "quality", "rush_yds", "rush_att"); rt("catch_rate", "quality", "receptions", "targets"); rt("y_rec", "quality", "rec_yds", "receptions");
  rt("y_tgt", "quality", "rec_yds", "targets"); rt("adot", "role", "receiving_air_yards", "targets");
  rt("snap_share", "role", "off_snaps", "team_off_snaps", qOf([], function (e) { return e.snap_games; }));
  rt("def_share", "role", "def_snaps", "team_def_snaps", qOf([], function (e) { return e.snap_games; }));
  rt("tackles_per_snap", "role", "def_tackles_total", "def_snaps");
  rt("fg_pct", "quality", "fg_made", "fg_att"); rt("xp_pct", "quality", "xp_made", "xp_att");   // distance bands rank on attempts (counts above), not accuracy
  rt("gross", "quality", "punt_yds", "punts"); rt("i20_pct", "quality", "punt_inside20", "punts");

  function add(a, b) { return a == null || b == null ? null : a + b; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // ---------- the pool answer ----------
  // -> { ok: true, players, byId } or { ok: false, why }. The answer must be for this season, week W* and group.
  function checkPool(j, season, through, group) {
    if (!j || typeof j !== "object" || j.ok !== true || !Array.isArray(j.players)) return { ok: false, why: "unexpected answer" };
    if (Number(j.season) !== Number(season) || Number(j.through) !== Number(through) || String(j.group) !== String(group)) return { ok: false, why: "answer for other weeks or another group" };
    var byId = {};
    for (var i = 0; i < j.players.length; i++) {
      var e = j.players[i];
      if (!e || e.mfl_id == null || !e.s || typeof e.s !== "object") return { ok: false, why: "unexpected answer" };
      var id = String(e.mfl_id);
      if (byId[id]) return { ok: false, why: "a player listed twice" };
      byId[id] = e;
    }
    return { ok: true, players: j.players, byId: byId, dataMaxWeek: isNum(j.data_max_week) ? j.data_max_week : null };
  }

  // a field of one entry: "full" | "partial" (missing in some of his weeks) | "missing"
  function fieldState(e, k) {
    if (k === "snap_games") return "full";
    if (!isNum(e.s[k])) return "missing";
    return e.cov && e.cov[k] != null ? "partial" : "full";
  }
  // one entry's value for metric m: { st: "full" | "partial" | "missing", v (count) or n, d (rate), q (qualifying denominator), qst }
  function valueOf(m, e) {
    var st = "full";
    for (var i = 0; i < m.f.length; i++) { var s = fieldState(e, m.f[i]); if (s === "missing") { st = "missing"; break; } if (s === "partial") st = "partial"; }
    var out = { st: st };
    if (m.q) {
      var q = m.q(e), qs = "full";
      if (!isNum(q) || m.qf.some(function (k) { return fieldState(e, k) === "missing"; })) qs = "missing";
      else if (m.qf.some(function (k) { return fieldState(e, k) === "partial"; })) qs = "partial";
      out.q = qs === "missing" ? null : q; out.qst = qs;
    }
    if (st === "missing") return out;
    var x = m.val(e.s);
    if (m.kind === "rate") { if (!x || !isNum(x[0]) || !isNum(x[1]) || !(x[1] > 0)) { out.st = st === "partial" ? "partial" : "nodiv"; return out; } out.n = x[0]; out.d = x[1]; }
    else { if (!isNum(x)) { out.st = "missing"; return out; } out.v = x; }
    return out;
  }
  // a is strictly better than b (exact: rates are compared by cross-multiplying the sums)
  function better(m, a, b) {
    if (m.kind === "rate") return m.low ? a.n * b.d < b.n * a.d : a.n * b.d > b.n * a.d;
    return m.kind === "low" ? a.v < b.v : a.v > b.v;
  }
  function same(m, a, b) { return m.kind === "rate" ? a.n * b.d === b.n * a.d : a.v === b.v; }

  // The fewest games any NFL club has played through week W: from the schedule's games per week ({ week: [{ teams: [{ id }] }] }),
  // or, without it, from the clubs' bye weeks (one game a week except the bye). null when neither is known.
  function teamGames(days, byeOf, through) {
    var W = Number(through), count = {}, any = false;
    if (!(W >= 1)) return null;
    if (days && typeof days === "object") {
      for (var w = 1; w <= W; w++) {
        var list = Array.isArray(days[w]) ? days[w] : null;
        if (!list) { count = null; break; }
        list.forEach(function (g) { (g && Array.isArray(g.teams) ? g.teams : []).forEach(function (t) { var id = String(t && t.id || "").toUpperCase(); if (id) { count[id] = (count[id] || 0) + 1; any = true; } }); });
      }
      if (count && any) { var mn = null; Object.keys(count).forEach(function (k) { if (mn == null || count[k] < mn) mn = count[k]; }); return mn; }
    }
    if (byeOf && typeof byeOf === "object") {
      var keys = Object.keys(byeOf), m2 = null;
      keys.forEach(function (k) { var b = Number(byeOf[k]), g2 = W - (b >= 1 && b <= W ? 1 : 0); if (m2 == null || g2 < m2) m2 = g2; });
      return keys.length ? m2 : null;
    }
    return null;
  }
  function barOf(id, group, G) {
    var b = RATE_BARS.bars[id];
    if (!b || !b.perGame || b.perGame[group] == null || !(G >= 1)) return null;
    var floor = b.min && b.min[group] != null ? b.min[group] : 0;
    return Math.max(b.perGame[group] * G, floor);
  }
  function f1(x) { return String(Math.round(x * 10) / 10); }

  // One rank. pool = checkPool(...) result; ctx = { group, G (team games for the bar), raw (the figure the season table shows, optional) }.
  // -> { text: "WR3" | "—", why, what, lo, hi, cause: { missing, partial, eligibility } when competitors are unplaced }
  function rankOf(pool, mflId, id, ctx) {
    var m = M[id], group = ctx.group, P = PREFIX[group] || group;
    var bar0 = RATE_BARS.bars[id];
    if (bar0 && bar0.withheld) return { text: DASH, why: bar0.withheld };
    if (!m) return { text: DASH, why: "No rank for this stat." };
    if (!pool || !pool.ok) return { text: DASH, why: "Position figures are not available." };
    var me = pool.byId[String(mflId)];
    if (!me) return { text: DASH, why: "He is not in the position figures." };
    var mv = valueOf(m, me);
    if (mv.st === "missing") return { text: DASH, why: "Not in the position figures for him." };
    if (mv.st === "partial") return { text: DASH, why: "His figure is missing some games, so it is not ranked." };
    if (mv.st === "nodiv") return { text: DASH, why: "No attempts, so no rate." };
    if (ctx.raw != null && isNum(ctx.raw)) {
      var mine = m.kind === "rate" ? mv.n / mv.d : mv.v;
      if (Math.abs(mine - ctx.raw) > 1e-6 * Math.max(1, Math.abs(mine))) return { text: DASH, why: "The position figures and his game stats disagree." };
    }
    var bar = null;
    if (m.kind !== "count") {
      bar = barOf(id, group, ctx.G);
      if (bar == null) return { text: DASH, why: ctx.G >= 1 ? "No minimum is set for this stat." : "Team games through this week are not known." };
      if (mv.qst === "missing") return { text: DASH, why: "His " + RATE_BARS.bars[id].den + " are missing." };
      if (mv.q < bar - 1e-9 && mv.qst === "partial") return { text: DASH, why: "His " + RATE_BARS.bars[id].den + " are missing some games." };
      if (mv.q < bar - 1e-9) return { text: DASH, why: "Ranked at " + f1(bar) + " " + RATE_BARS.bars[id].den + " or more; he has " + f1(mv.q) + "." };
    }
    // unplaced competitors, by cause: missing (no figure at all), partial (a figure missing some games, he qualifies), eligibility (his denominator is
    // missing or incomplete and under the bar, so whether he qualifies at all is unknown). Every cause is missing underlying stats; "eligibility" is
    // the subset where the missing stats also decide whether he is in the rate's group.
    var ahead = 0, unplaced = 0, cause = { missing: 0, partial: 0, eligibility: 0 };
    pool.players.forEach(function (e) {
      if (e === me) return;
      var v = valueOf(m, e);
      if (m.kind !== "count") {
        // over the bar? A denominator only grows, so a partial one already over the bar qualifies; a missing or partial one under it might.
        if (v.qst === "missing") { unplaced++; cause.eligibility++; return; }
        if (v.q < bar - 1e-9) { if (v.qst === "partial") { unplaced++; cause.eligibility++; } return; }
      }
      if (v.st === "missing" || v.st === "nodiv") { if (v.st === "missing") { unplaced++; cause.missing++; } return; }
      if (v.st === "partial") {
        // totals only grow: a partial total already ahead (more-is-better) is ahead; a partial total already behind a fewer-is-better leader stays behind
        if (m.kind === "count" && better(m, v, mv)) { ahead++; return; }
        if (m.kind === "low" && (better(m, mv, v) || same(m, mv, v))) return;
        unplaced++; cause.partial++; return;
      }
      if (better(m, v, mv)) ahead++;
    });
    var lo = 1 + ahead, hi = lo + unplaced;
    // exact or "—": any incomplete competitor who could be ahead (or, for a rate, might reach the minimum) makes the rank unsupported; the bounds
    // and the cause go to Rank details. A missing figure is never counted as zero.
    if (hi > lo) return { text: DASH, why: unplaced + (unplaced === 1 ? " player's figure is" : " players' figures are") + " incomplete, so he could rank anywhere from " + P + lo + " to " + P + hi + "." + (cause.eligibility ? " For " + cause.eligibility + " of them it is also unknown whether they reach the minimum." : ""), lo: lo, hi: hi, coverage: true, cause: cause };
    return { text: P + lo, what: m.what, lo: lo, hi: hi };
  }

  // Help text for the season-stats ranks (to be placed in the screen's Help).
  function helpText() {
    return "Season stat ranks compare him with every player at his MFL position group (QB, RB, WR, TE, K, P, DL, LB, DB) through the same week as the season figures. " +
      "Tied players share a rank. A rank shows only when no player's incomplete figure could change his place; " +
      "otherwise it is " + DASH + " and Rank details say why, including when it is unknown whether a player with incomplete figures reaches a rate's minimum. " +
      "An incomplete figure is never counted as zero; in the Breakdown, " + DASH + " for a stat means it is not recorded (or, for a rate, that there were no attempts), never a zero. Kicking distance bands rank on attempts from that distance, not accuracy. " +
      "Ranks on totals (yards, targets, snaps, tackles), shares and depth (air yards per attempt or target) describe volume or role, not quality. " +
      "Fewer is better for INT rate (interceptions per 100 pass attempts), sacks taken and sack yards lost; the interception count itself is not ranked. " +
      "INT rate shows two decimals; the rank uses the exact rate, so only identical rates share a rank. " +
      "Rates (and the fewer-is-better totals) rank only players with enough attempts, carries, targets, receptions, punts or snaps of their own: " +
      "a minimum per team game times the fewest games any NFL club has played through that week (for example 15 pass attempts × 9 games = 135), with a fixed floor for wide receiver and tight end carries (proposed, pending approval); below it the value shows and the rank is " + DASH + ". " +
      "Pressure rate is not ranked: no pass-rush snap count exists.";
  }

  return { RATE_BARS: RATE_BARS, METRICS: M, groupOf: groupOf, prefix: function (g) { return PREFIX[g] || g; }, checkPool: checkPool, teamGames: teamGames, barOf: barOf, rankOf: rankOf, helpText: helpText };
});
