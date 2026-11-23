/* UPS 2027 beta (R6): a player's NFL game stats, week by week, and the season rollup. Pure functions: no network, no storage, no DOM.

   Sources, each kept to its own job:
     - official fantasy points: MFL playerScores (one read per week, shared with Team > Performance); never rebuilt from stat columns;
     - counting stats, red zone and snaps: the UPS Worker's /api/player-weekly-box answer for ONE player and season (nflverse box score,
       nflverse red-zone and snap counts, joined to the MFL id by the Worker's verified id map; this module never joins by name or club);
     - the game (date, kickoff, opponent, home or away, score, status): MFL nflSchedule (all weeks), found by (season, week, the club he
       played for THAT week). The club comes from his own stat or snap row that week, never from his current MFL club, except for the lineup
       week itself before any row exists.
   Rules: a missing value is missing, never 0; a missing stat row is not "did not play"; rates come from season sums, never from averaging weekly
   rates; overlapping stats (red zone inside the season, end-zone targets beside red-zone targets) are never added together. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./complete.js") : root.UPS2027.complete);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.boxlog = api; }
})(typeof self !== "undefined" ? self : this, function (X) {
  "use strict";

  // nflverse club codes to MFL's (copied from worker/src/fpa_engine.js:44, NFLV_TO_MFL). Every other code is the same in both. v3 found it
  // complete for 2026: every one of 10,992 nflverse player-week rows translated to a club in the MFL schedule.
  var NFLV_TO_MFL = { GB: "GBP", KC: "KCC", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB", LV: "LVR", JAX: "JAC", LA: "LAR" };
  function toMfl(code) { var c = String(code == null ? "" : code).trim().toUpperCase(); return c ? (NFLV_TO_MFL[c] || c) : ""; }

  // 2026 games played at a neutral site (nflverse games.csv location = Neutral, research v3 section 2a). MFL still lists one club as home in each,
  // so its home flag is kept internally and the game is shown as neutral. Keyed by season:week:the two MFL codes in order. No other season is claimed.
  var NEUTRAL = { "2026:1:LAR-SFO": 1, "2026:3:BAL-DAL": 1, "2026:4:IND-WAS": 1, "2026:5:JAC-PHI": 1, "2026:6:HOU-JAC": 1, "2026:7:NOS-PIT": 1, "2026:9:ATL-CIN": 1, "2026:10:DET-NEP": 1, "2026:11:MIN-SFO": 1 };
  function neutralKey(season, week, a, b) { var p = [a, b].sort(); return season + ":" + week + ":" + p[0] + "-" + p[1]; }

  // The stat fields this module reads. Anything else in the answer is ignored (and not kept).
  var BOX_NUM = ["pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks", "pass_sack_yds", "pass_long", "passing_air_yards",
    "rush_att", "rush_yds", "rush_tds", "rush_long", "rush_fumbles_lost", "targets", "receptions", "rec_yds", "rec_tds", "rec_long", "rec_fumbles_lost", "receiving_air_yards",
    "def_tackles_solo", "def_tackles_ast", "def_tackles_total", "def_tfl", "def_qb_hits", "def_sacks", "def_sack_yds", "def_ff", "def_fr", "def_ints", "def_pass_def", "def_tds", "def_pressures",
    "fg_att", "fg_made", "fg_long", "fg_att_0_39", "fg_made_0_39", "fg_att_40_49", "fg_made_40_49", "fg_att_50_59", "fg_made_50_59", "fg_att_60plus", "fg_made_60plus", "xp_att", "xp_made",
    "punts", "punt_yds", "punt_inside20"];
  var RZ_NUM = ["rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_tds_i20", "targets_i20", "targets_i10", "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20", "pass_att_i20", "pass_cmp_i20", "pass_tds_i20", "pass_att_ez"];
  var SNAP_NUM = ["off", "def", "st", "team_off", "team_def"];

  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }
  // a finite number, or null (absent, null, text that is not a plain number). Never 0 in place of a missing value.
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
    return null;
  }
  function pick(o, keys) { var out = {}; keys.forEach(function (k) { out[k] = own(o, k) ? num(o[k]) : null; }); return out; }

  // The Worker's answer for one player -> { state: "ok", mflId, gsis, idSource, through, weeks: { w: { box, rz, snaps } } } or { state: "error", why }.
  // The answer must be for THIS player and season; an answer for another id is refused (nothing is joined by name).
  function parseBox(j, mflId, season) {
    if (!j || typeof j !== "object" || j.ok !== true || !Array.isArray(j.weeks)) return { state: "error", why: "unexpected answer" };
    if (String(j.mfl_id) !== String(mflId)) return { state: "error", why: "answer for another player" };
    if (season != null && Number(j.season) !== Number(season)) return { state: "error", why: "answer for another season" };
    var idSource = typeof j.id_source === "string" ? j.id_source : "";
    if (!idSource || !j.gsis_id) return { state: "error", why: "player not matched to NFL records" };
    var through = isInt(num(j.box_through_week)) ? num(j.box_through_week) : null, weeks = {};
    for (var i = 0; i < j.weeks.length; i++) {
      var e = j.weeks[i], w = e ? num(e.week) : null;
      if (!isInt(w) || w < 1 || w > 22) return { state: "error", why: "unexpected answer" };
      if (own(weeks, w)) return { state: "error", why: "a week listed twice" };
      var b = e.box && typeof e.box === "object" ? e.box : null, r = e.redzone && typeof e.redzone === "object" ? e.redzone : null, s = e.snaps && typeof e.snaps === "object" ? e.snaps : null;
      var box = b ? pick(b, BOX_NUM) : null;
      if (box) { box.team = toMfl(b.team); box.opp = toMfl(b.opponent); box.position = String(b.position == null ? "" : b.position); }
      var snaps = s ? pick(s, SNAP_NUM) : null;
      if (snaps) snaps.team = toMfl(s.team);
      weeks[w] = { box: box, rz: r ? pick(r, RZ_NUM) : null, snaps: snaps };
    }
    return { state: "ok", mflId: String(mflId), gsis: String(j.gsis_id), pfr: j.pfr_id ? String(j.pfr_id) : "", idSource: idSource, through: through, weeks: weeks };
  }

  // The loader's reduced schedule ({ week: [{ kickoff, secs, teams: [{ id, isHome, score }] }] }) -> { week: { club: game } } with the game from that club's side.
  function gameIndex(days, season) {
    var out = {};
    if (!days || typeof days !== "object") return out;
    Object.keys(days).forEach(function (wk) {
      var w = Number(wk), list = Array.isArray(days[wk]) ? days[wk] : [];
      if (!isInt(w)) return;
      var idx = {};
      list.forEach(function (m) {
        var t = m && Array.isArray(m.teams) ? m.teams : [];
        if (t.length !== 2) return;
        var a = String(t[0].id || "").toUpperCase(), b = String(t[1].id || "").toUpperCase();
        if (!a || !b) return;
        var secs = num(m.secs), sa = num(t[0].score), sb = num(t[1].score), ko = num(m.kickoff);
        var game = { clubs: [a, b], secondsRemaining: secs, scored: sa != null && sb != null, final: secs === 0 && sa != null && sb != null };
        var neutral = !!NEUTRAL[neutralKey(season, w, a, b)];
        function side(me, other, myScore, oppScore, home) {
          return { week: w, club: me, opp: other, home: home === "1" || home === 1 || home === true ? true : home === "0" || home === 0 || home === false ? false : null, neutral: neutral,
            kickoff: ko != null && ko > 0 ? ko : null, score: myScore, oppScore: oppScore, status: X.gameState(game, null) };
        }
        if (own(idx, a) || own(idx, b)) { idx[a] = idx[b] = { conflict: true }; return; }   // a club twice in one week: neither game is trusted
        idx[a] = side(a, b, sa, sb, t[0].isHome);
        idx[b] = side(b, a, sb, sa, t[1].isHome);
      });
      out[w] = idx;
    });
    return out;
  }

  // ---------- dates in Eastern Time ----------
  function etParts(unix, opts) {
    try {
      var parts = new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "America/New_York" }, opts)).formatToParts(new Date(unix * 1000)), m = {};
      parts.forEach(function (p) { m[p.type] = p.value; });
      return m;
    } catch (e) { return null; }
  }
  // "Sun 11/15" (the game's calendar date in Eastern Time), or "" when there is no kickoff.
  function shortDate(unix) { if (!(unix > 0)) return ""; var m = etParts(unix, { weekday: "short", month: "numeric", day: "numeric" }); return m ? m.weekday + " " + m.month + "/" + m.day : ""; }
  // "Sun Nov 15, 2026, 4:05 PM ET"
  function longDate(unix) {
    if (!(unix > 0)) return "";
    var m = etParts(unix, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    return m ? m.weekday + " " + m.month + " " + m.day + ", " + m.year + ", " + m.hour + ":" + m.minute + " " + (m.dayPeriod || "") + " ET" : "";
  }

  // ---------- position groups and views ----------
  var OFF = { QB: 1, RB: 1, WR: 1, TE: 1 }, IDP = { DE: "DL", DT: "DL", DL: "DL", LB: "LB", CB: "DB", S: "DB", DB: "DB" };
  function groupOf(pos) {
    var p = String(pos || "").toUpperCase();
    if (OFF[p]) return { kind: "off", pos: p };
    if (IDP[p]) return { kind: "idp", pos: IDP[p] };
    if (p === "PK" || p === "K") return { kind: "k", pos: "K" };
    if (p === "PN" || p === "P") return { kind: "p", pos: "P" };
    return { kind: "", pos: p };
  }
  var VIEWS = {
    off: [["fan", "Fantasy"], ["st", "Stats"], ["use", "Usage"], ["rz", "Red zone"]],
    idp: [["fan", "Fantasy"], ["st", "Stats"], ["use", "Usage"], ["pr", "Pass rush"]],
    k: [["fan", "Fantasy"], ["kick", "Kicking"]],
    p: [["fan", "Fantasy"], ["punt", "Punting"]],
    "": [["fan", "Fantasy"]]
  };
  function viewsFor(pos) { return VIEWS[groupOf(pos).kind]; }

  // ---------- one week's derived values (null when not established) ----------
  function bx(r, k) { return r && r.box ? r.box[k] : null; }
  function rz(r, k) { return r && r.rz ? r.rz[k] : null; }
  function add(a, b) { return a == null || b == null ? null : a + b; }
  // MFL's TK (tackles) is solo tackles plus tackles made with an assist; AS is the assists. The answer's total is solo + with-assist + assists (research v2,
  // proven for every 2026 IDP week checked), so with-assist = total - solo - assists. A negative or incomplete result is unreadable, never 0.
  function withAssist(b) {
    if (!b || b.def_tackles_total == null || b.def_tackles_solo == null || b.def_tackles_ast == null) return null;
    var w = b.def_tackles_total - b.def_tackles_solo - b.def_tackles_ast;
    return w >= 0 ? w : null;
  }
  function scoredTackles(b) { var w = withAssist(b); return w == null ? null : b.def_tackles_solo + w; }
  function fumblesLost(b) { return b ? add(b.rush_fumbles_lost, b.rec_fumbles_lost) : null; }
  function snapsOf(r, side) { var s = r && r.snaps; if (!s) return null; return side === "def" ? s.def : side === "st" ? s.st : s.off; }
  function teamSnaps(r, side) { var s = r && r.snaps; if (!s) return null; return side === "def" ? s.team_def : side === "st" ? null : s.team_off; }
  function sideOf(kind) { return kind === "idp" ? "def" : kind === "k" || kind === "p" ? "st" : "off"; }

  // ---------- the week rows ----------
  // in: { pos, season, cutoff (W*), lineupWeek, currentClub, box (parseBox result or null), scores: { w: number | "text" (unreadable) }, scoreState: { w: "ok"|"loading"|"error" },
  //       games (gameIndex) or null, byeOf: { club: week } or null, weekRank: function (w) -> "WR1" or "" }
  function rows(inp) {
    var box = inp.box && inp.box.state === "ok" ? inp.box : null, through = box ? box.through : null, weeks = box ? box.weeks : {};
    var last = Math.max(inp.cutoff || 0, inp.lineupWeek || 0), out = [];
    var rowClub = {};   // the club named by his own stat/snap row that week
    var anySnapRow = false;
    Object.keys(weeks).forEach(function (k) {
      var e = weeks[k], a = e.box ? e.box.team : "", b = e.snaps ? e.snaps.team : "";
      if (e.snaps) anySnapRow = true;
      rowClub[k] = a && b && a !== b ? { conflict: true } : a || b ? { club: a || b } : null;
    });
    function nearest(w, dir) { for (var x = w + dir; x >= 1 && x <= 22; x += dir) if (rowClub[x]) return rowClub[x]; return null; }
    for (var w = 1; w <= last; w++) {
      var e = own(weeks, w) ? weeks[w] : { box: null, rz: null, snaps: null };
      var club = "", how = "unknown", rc = rowClub[w];
      if (rc && rc.conflict) how = "conflict";
      else if (rc) { club = rc.club; how = "row"; }
      else {
        var before = nearest(w, -1), after = nearest(w, 1);
        if (before && after && !before.conflict && !after.conflict && before.club === after.club) { club = before.club; how = "between"; }
        else if (!after && w === inp.lineupWeek && inp.currentClub) { club = String(inp.currentClub).toUpperCase(); how = "current"; }
        // after his last row, his latest club is taken only when it is also his current MFL club (two sources agree); before his first row nothing is assumed
        else if (!after && before && !before.conflict && inp.currentClub && before.club === String(inp.currentClub).toUpperCase()) { club = before.club; how = "carried"; }
      }
      var gi = inp.games && inp.games[w], game = club && gi && own(gi, club) && !gi[club].conflict ? gi[club] : null;
      var bye = !!(club && inp.byeOf && inp.byeOf[club] === w);
      if (!club && !e.box && !(e.snaps && (e.snaps.off || e.snaps.def || e.snaps.st)) && inp.histBye && inp.histBye[w]) { bye = true; how = "history"; }   // team history knows his club that week and it had its bye
      var sc = inp.scores && own(inp.scores, w) ? inp.scores[w] : undefined, st = inp.scoreState ? inp.scoreState[w] : undefined;
      var pts = typeof sc === "number" ? sc : null, ptsKind = typeof sc === "number" ? "score" : typeof sc === "string" ? "unreadable" : st === "ok" ? "none" : st === "error" ? "error" : "loading";
      var snapTot = e.snaps ? (e.snaps.off || 0) + (e.snaps.def || 0) + (e.snaps.st || 0) : null;
      var statsIn = through != null && w <= through;
      var part;
      if (e.box) part = "Played";
      else if (snapTot != null && snapTot > 0) part = "Played, no stat line";
      else if (bye) part = "Bye";
      else if (!box) part = "";   // no game-stats read: participation is not claimed
      else if (!statsIn) part = game && game.status === "scheduled" ? "Not played yet" : "Stats not in yet";
      else if (pts != null && pts > 0) part = "Scored, stats missing";
      else if (how === "conflict") part = "Records conflict";
      else if (!club) part = "Club not established";
      else if (game && game.status === "final" && e.snaps && snapTot === 0) part = "No snaps";
      else if (game && game.status === "final" && !e.snaps && anySnapRow && box.pfr) part = "No snaps recorded";
      else part = "Unknown";
      out.push({ week: w, newer: !(w <= inp.cutoff), club: club, clubHow: how, game: game, bye: bye, box: e.box, rz: e.rz, snaps: e.snaps, statsIn: statsIn, part: part,
        pts: pts, ptsKind: ptsKind, ptsText: typeof sc === "string" ? sc : "", rank: !(w <= inp.cutoff) || ptsKind !== "score" || !inp.weekRank ? "" : inp.weekRank(w) || "" });
    }
    return out;
  }

  // ---------- the season rollup ----------
  // Sums over the settled weeks (1..cutoff) that have the value; `n` = weeks that had it, `of` = weeks with a row of that kind. A field
  // missing in some weeks is shown with its coverage, never as a complete figure.
  function sumOf(list, get) {
    var v = 0, n = 0;
    list.forEach(function (r) { var x = get(r); if (x != null) { v += x; n++; } });
    return { v: n ? v : null, n: n };
  }
  function ratioOf(list, top, bot) {
    var a = 0, b = 0, n = 0;
    list.forEach(function (r) { var x = top(r), y = bot(r); if (x != null && y != null) { a += x; b += y; n++; } });
    return { v: n && b > 0 ? a / b : null, top: a, bot: b, n: n };
  }
  function maxOf(list, get) {   // the longest: only when EVERY row has the value (a max over part of the season is not the season's longest)
    var m = null;
    for (var i = 0; i < list.length; i++) { var x = get(list[i]); if (x == null) return null; m = m == null || x > m ? x : m; }
    return m;
  }
  function f1(v) { return v == null ? null : (Math.round(v * 10 + 1e-9) / 10).toFixed(1); }
  function pct(v) { return v == null ? null : (Math.round(v * 1000 + 1e-9) / 10).toFixed(1) + "%"; }
  function int(v) { return v == null ? null : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }   // 1,207

  function rollup(inp, rs) {
    var g = groupOf(inp.pos), box = inp.box && inp.box.state === "ok" ? inp.box : null;
    if (!box) return null;
    var upTo = box.through == null ? 0 : Math.min(inp.cutoff || 0, box.through);
    var settled = rs.filter(function (r) { return r.week <= upTo; });
    var withBox = settled.filter(function (r) { return !!r.box; }), withRz = settled.filter(function (r) { return !!r.rz; });
    var side = sideOf(g.kind), withSnap = settled.filter(function (r) { var s = snapsOf(r, side); return s != null && s > 0; });
    var nb = withBox.length;
    function item(label, s, fmt) {   // s: { v, n } from sumOf, over `rowsOf` rows
      return { label: label, value: s.v == null ? null : fmt ? fmt(s.v) : int(s.v), n: s.n, of: s.of };
    }
    function S(label, k, from) { var list = from || withBox, s = sumOf(list, function (r) { return from === withRz ? rz(r, k) : bx(r, k); }); s.of = list.length; return item(label, s); }
    function D(label, get, fmt, from) { var list = from || withBox, s = sumOf(list, get); s.of = list.length; return item(label, s, fmt); }
    function R(label, top, bot, fmt, from) { var list = from || withBox, r = ratioOf(list, top, bot); return { label: label, value: r.v == null ? null : fmt(r.v), n: r.n, of: list.length }; }
    function plain(label, value) { return { label: label, value: value, n: null, of: null }; }
    function b(k) { return function (r) { return bx(r, k); }; }
    function z(k) { return function (r) { return rz(r, k); }; }
    var snapItems = [
      D("Snaps", function (r) { return snapsOf(r, side); }, null, withSnap),
      side === "st" ? null : R("Snap share", function (r) { return snapsOf(r, side); }, function (r) { return teamSnaps(r, side); }, pct, withSnap)
    ].filter(Boolean);
    var secs = [];
    var longest = function (k) { var m = maxOf(withBox, b(k)); return m == null ? null : plain("Longest", int(m)); };
    if (g.kind === "off" && g.pos === "QB") {
      secs.push({ h: "Passing", items: [
        (function () { var both = withBox.filter(function (r) { return bx(r, "pass_cmp") != null && bx(r, "pass_att") != null; }); return { label: "Completions/attempts", value: both.length ? int(sumOf(both, b("pass_cmp")).v) + "/" + int(sumOf(both, b("pass_att")).v) : null, n: both.length, of: withBox.length }; })(),
        R("Completion rate", b("pass_cmp"), b("pass_att"), pct), S("Passing yards", "pass_yds"), R("Yards per attempt", b("pass_yds"), b("pass_att"), function (v) { return v.toFixed(2); }),
        S("Passing TD", "pass_tds"), S("Interceptions", "pass_ints"), S("Air yards", "passing_air_yards"), R("Air yards per attempt", b("passing_air_yards"), b("pass_att"), function (v) { return v.toFixed(2); }),
        D("Sacks taken", b("pass_sacks")), D("Sack yards lost", function (r) { var v = bx(r, "pass_sack_yds"); return v == null ? null : Math.abs(v); }), longest("pass_long")].filter(Boolean) });
      secs.push({ h: "Rushing", items: [S("Carries", "rush_att"), S("Rushing yards", "rush_yds"), S("Rushing TD", "rush_tds"), D("Fumbles lost (not on sacks)", function (r) { return fumblesLost(r.box); })] });
      secs.push({ h: "Usage", items: snapItems.concat([plain("Team PROE", null)]) });
      secs.push({ h: "Red zone", items: [S("Red-zone attempts", "pass_att_i20", withRz), S("Red-zone completions", "pass_cmp_i20", withRz), S("Red-zone passing TD", "pass_tds_i20", withRz), S("End-zone attempts (any distance)", "pass_att_ez", withRz), S("Red-zone carries", "rush_att_i20", withRz), S("Red-zone rushing TD", "rush_tds_i20", withRz)] });
    } else if (g.kind === "off") {
      var rush = [S("Carries", "rush_att"), S("Rushing yards", "rush_yds"), R("Yards per carry", b("rush_yds"), b("rush_att"), function (v) { return v.toFixed(1); }), S("Rushing TD", "rush_tds"), longest("rush_long")].filter(Boolean);
      var rec = [S("Targets", "targets"), S("Receptions", "receptions"), S("Receiving yards", "rec_yds"), S("Receiving TD", "rec_tds"), R("Catch rate", b("receptions"), b("targets"), pct),
        R("Yards per reception", b("rec_yds"), b("receptions"), function (v) { return v.toFixed(1); }), R("Yards per target", b("rec_yds"), b("targets"), function (v) { return v.toFixed(1); }),
        S("Air yards", "receiving_air_yards"), R("Air yards per target", b("receiving_air_yards"), b("targets"), function (v) { return v.toFixed(1); }), longest("rec_long")].filter(Boolean);
      var tot = { h: "Totals", items: [D("Total TD (rushing + receiving)", function (r) { return add(bx(r, "rush_tds"), bx(r, "rec_tds")); }), D("Fumbles lost", function (r) { return fumblesLost(r.box); })] };
      if (g.pos === "RB") { secs.push({ h: "Rushing", items: rush }); secs.push({ h: "Receiving", items: rec }); }
      else { secs.push({ h: "Receiving", items: rec }); secs.push({ h: "Rushing", items: rush }); }
      secs.push(tot);
      secs.push({ h: "Usage", items: snapItems.concat([plain("Routes", null)]) });
      secs.push({ h: "Red zone", items: g.pos === "RB" ?
        [S("Red-zone carries", "rush_att_i20", withRz), S("Carries inside the 10", "rush_att_i10", withRz), S("Carries inside the 5", "rush_att_i5", withRz), S("Red-zone rushing TD", "rush_tds_i20", withRz), S("Red-zone targets", "targets_i20", withRz), S("Red-zone receiving TD", "rec_tds_i20", withRz)] :
        [S("Red-zone targets", "targets_i20", withRz), S("Targets inside the 10", "targets_i10", withRz), S("Targets inside the 5", "targets_i5", withRz), S("Red-zone receptions", "rec_i20", withRz), S("Red-zone receiving TD", "rec_tds_i20", withRz), S("End-zone targets (any distance)", "targets_ez", withRz)] });
    } else if (g.kind === "idp") {
      secs.push({ h: "Tackles", items: [S("Solo tackles", "def_tackles_solo"), S("Assists", "def_tackles_ast"), D("Tackles as MFL scores them", function (r) { return scoredTackles(r.box); }), S("Tackles for loss", "def_tfl")] });
      secs.push({ h: "Pass rush", items: [S("Sacks", "def_sacks"), S("Sack yards", "def_sack_yds"), S("QB hits", "def_qb_hits"), S("Pressures", "def_pressures")] });
      secs.push({ h: "Takeaways and passes", items: [S("Interceptions", "def_ints"), S("Passes defended", "def_pass_def"), S("Forced fumbles", "def_ff"), S("Fumble recoveries", "def_fr"), S("Defensive TD", "def_tds")] });
      secs.push({ h: "Usage", items: snapItems.concat([D("Special-teams snaps", function (r) { return snapsOf(r, "st"); }, null, settled.filter(function (r) { return !!r.snaps; }))]) });
    } else if (g.kind === "k") {
      // made/attempted over the weeks where both are recorded; 0/0 is a real answer (no attempt from that distance), a week with neither is not counted
      var ma = function (m, a) {
        var both = withBox.filter(function (r) { return bx(r, m) != null && bx(r, a) != null; });
        return { label: null, value: both.length ? int(sumOf(both, b(m)).v) + "/" + int(sumOf(both, b(a)).v) : null, n: both.length, of: withBox.length };
      };
      var fg = ma("fg_made", "fg_att"); fg.label = "Field goals made/attempted";
      var b1 = ma("fg_made_0_39", "fg_att_0_39"); b1.label = "0 to 39 yards";
      var b2 = ma("fg_made_40_49", "fg_att_40_49"); b2.label = "40 to 49 yards";
      var b3 = ma("fg_made_50_59", "fg_att_50_59"); b3.label = "50 to 59 yards";
      var b4 = ma("fg_made_60plus", "fg_att_60plus"); b4.label = "60 yards or more";
      var xp = ma("xp_made", "xp_att"); xp.label = "Extra points made/attempted";
      secs.push({ h: "Kicking", items: [fg, R("Field goal rate", b("fg_made"), b("fg_att"), pct), b1, b2, b3, b4, xp, longest("fg_long")].filter(Boolean) });
    } else if (g.kind === "p") {
      secs.push({ h: "Punting", items: [S("Punts", "punts"), R("Gross average", b("punt_yds"), b("punts"), function (v) { return v.toFixed(1); }), S("Inside 20", "punt_inside20"), R("Inside 20 rate", b("punt_inside20"), b("punts"), pct)] });
    }
    return { from: 1, to: upTo, games: nb, settledWeeks: settled.length, sections: secs, through: box.through };
  }

  // The punter's inside-20 bands (inside 5, 5 to under 10, 10 to under 20) are NOT shown: the punt-level ending spots, the boundaries and the reconciliation
  // to the official inside-20 count have not been verified (R6 assignment section 8). This hook returns the state the screen checks; it never infers bands.
  function punterBands() { return { state: "not_reconciled" }; }

  // ---------- weekly view columns: [header, function (row) -> text or null] ----------
  function ma2(r, m, a) { var x = bx(r, m), y = bx(r, a); return x == null || y == null ? null : x + "/" + y; }
  function share(r, side) { var s = snapsOf(r, side), t = teamSnaps(r, side); return s == null || t == null || !(t > 0) ? null : Math.round(100 * s / t) + "%"; }
  function c(h, get, title) { return { h: h, t: title || h, get: get }; }
  function n(k) { return function (r) { var v = bx(r, k); return v == null ? null : String(v); }; }
  function zr(k) { return function (r) { var v = rz(r, k); return v == null ? null : String(v); }; }
  function columns(pos, view) {
    var g = groupOf(pos), side = sideOf(g.kind), FL = c("FL", function (r) { var v = fumblesLost(r.box); return v == null ? null : String(v); }, "Fumbles lost");
    var snapsC = c(side === "def" ? "Def snaps" : side === "st" ? "ST snaps" : "Snaps", function (r) { var v = snapsOf(r, side); return v == null ? null : String(v); });
    var shareC = c(side === "def" ? "Def %" : "Snap %", function (r) { return share(r, side); }, "Share of team snaps");
    if (view === "st" && g.kind === "off" && g.pos === "QB") return [c("C/A", function (r) { return ma2(r, "pass_cmp", "pass_att"); }, "Completions/attempts"), c("Yds", n("pass_yds"), "Passing yards"), c("TD", n("pass_tds"), "Passing TD"), c("INT", n("pass_ints"), "Interceptions"),
      c("Sk", function (r) { var s = bx(r, "pass_sacks"), y = bx(r, "pass_sack_yds"); return s == null ? null : y == null ? String(s) : s + "-" + Math.abs(y); }, "Sacks taken and yards lost"), c("Car", n("rush_att"), "Carries"), c("RuYd", n("rush_yds"), "Rushing yards"), c("RuTD", n("rush_tds"), "Rushing TD"), FL];
    if (view === "st" && g.kind === "off" && g.pos === "RB") return [c("Car", n("rush_att"), "Carries"), c("Yds", n("rush_yds"), "Rushing yards"), c("TD", n("rush_tds"), "Rushing TD"), c("Tgt", n("targets"), "Targets"), c("Rec", n("receptions"), "Receptions"), c("ReYd", n("rec_yds"), "Receiving yards"), c("ReTD", n("rec_tds"), "Receiving TD"), FL];
    if (view === "st" && g.kind === "off") return [c("Tgt", n("targets"), "Targets"), c("Rec", n("receptions"), "Receptions"), c("Yds", n("rec_yds"), "Receiving yards"), c("TD", n("rec_tds"), "Receiving TD"), c("Car", n("rush_att"), "Carries"), c("RuYd", n("rush_yds"), "Rushing yards"), c("RuTD", n("rush_tds"), "Rushing TD"), FL];
    if (view === "use" && g.kind === "off" && g.pos === "QB") return [snapsC, shareC, c("Att", n("pass_att"), "Pass attempts"), c("Air", n("passing_air_yards"), "Air yards")];
    if (view === "use" && g.kind === "off" && g.pos === "RB") return [snapsC, shareC, c("Car", n("rush_att"), "Carries"), c("Tgt", n("targets"), "Targets")];
    if (view === "use" && g.kind === "off") return [snapsC, shareC, c("Tgt", n("targets"), "Targets"), c("Air", n("receiving_air_yards"), "Air yards"), c("aDOT", function (r) { var a = bx(r, "receiving_air_yards"), t = bx(r, "targets"); return a == null || !(t > 0) ? null : (a / t).toFixed(1); }, "Air yards per target")];
    if (view === "rz" && g.pos === "QB") return [c("Att", zr("pass_att_i20"), "Red-zone attempts"), c("Cmp", zr("pass_cmp_i20"), "Red-zone completions"), c("TD", zr("pass_tds_i20"), "Red-zone passing TD"), c("EZ att", zr("pass_att_ez"), "End-zone attempts (any distance)"), c("Car", zr("rush_att_i20"), "Red-zone carries"), c("RuTD", zr("rush_tds_i20"), "Red-zone rushing TD")];
    if (view === "rz" && g.pos === "RB") return [c("Car", zr("rush_att_i20"), "Red-zone carries"), c("In 10", zr("rush_att_i10"), "Carries inside the 10"), c("In 5", zr("rush_att_i5"), "Carries inside the 5"), c("RuTD", zr("rush_tds_i20"), "Red-zone rushing TD"), c("Tgt", zr("targets_i20"), "Red-zone targets"), c("ReTD", zr("rec_tds_i20"), "Red-zone receiving TD")];
    if (view === "rz") return [c("Tgt", zr("targets_i20"), "Red-zone targets"), c("In 10", zr("targets_i10"), "Targets inside the 10"), c("In 5", zr("targets_i5"), "Targets inside the 5"), c("Rec", zr("rec_i20"), "Red-zone receptions"), c("TD", zr("rec_tds_i20"), "Red-zone receiving TD"), c("EZ tgt", zr("targets_ez"), "End-zone targets (any distance)")];
    if (view === "st" && g.kind === "idp") return [c("Solo", n("def_tackles_solo"), "Solo tackles"), c("Ast", n("def_tackles_ast"), "Assists"), c("TFL", n("def_tfl"), "Tackles for loss"), c("Sk", n("def_sacks"), "Sacks"), c("INT", n("def_ints"), "Interceptions"), c("PD", n("def_pass_def"), "Passes defended"), c("FF", n("def_ff"), "Forced fumbles"), c("FR", n("def_fr"), "Fumble recoveries"), c("TD", n("def_tds"), "Defensive TD")];
    if (view === "use" && g.kind === "idp") return [snapsC, shareC, c("ST snaps", function (r) { var v = snapsOf(r, "st"); return v == null ? null : String(v); }, "Special-teams snaps")];
    if (view === "pr") return [c("Sk", n("def_sacks"), "Sacks"), c("Sk yds", n("def_sack_yds"), "Sack yards"), c("QB hits", n("def_qb_hits"), "QB hits"), c("Press.", n("def_pressures"), "Pressures"), c("TFL", n("def_tfl"), "Tackles for loss")];
    if (view === "kick") return [c("FG", function (r) { return ma2(r, "fg_made", "fg_att"); }, "Field goals made/attempted"), c("0-39", function (r) { return ma2(r, "fg_made_0_39", "fg_att_0_39"); }, "0 to 39 yards"), c("40-49", function (r) { return ma2(r, "fg_made_40_49", "fg_att_40_49"); }, "40 to 49 yards"),
      c("50-59", function (r) { return ma2(r, "fg_made_50_59", "fg_att_50_59"); }, "50 to 59 yards"), c("60+", function (r) { return ma2(r, "fg_made_60plus", "fg_att_60plus"); }, "60 yards or more"), c("XP", function (r) { return ma2(r, "xp_made", "xp_att"); }, "Extra points made/attempted")];
    if (view === "punt") return [c("Punts", n("punts")), c("Gross", function (r) { var y = bx(r, "punt_yds"), p = bx(r, "punts"); return y == null || !(p > 0) ? null : (y / p).toFixed(1); }, "Gross average"), c("In 20", n("punt_inside20"), "Inside 20"),
      c("In 20%", function (r) { var i = bx(r, "punt_inside20"), p = bx(r, "punts"); return i == null || !(p > 0) ? null : Math.round(100 * i / p) + "%"; }, "Inside 20 rate")];
    return [];
  }

  // Everything one game's detail can say about the stats, as [label, text] pairs (only fields that apply to his position; a missing value is null).
  function detailStats(pos, r) {
    var g = groupOf(pos), out = [], views = viewsFor(pos);
    views.forEach(function (v) { if (v[0] === "fan") return; columns(pos, v[0]).forEach(function (col) { out.push([col.t, col.get(r)]); }); });
    if (g.kind === "idp") { var t = scoredTackles(r.box); out.splice(2, 0, ["Tackles as MFL scores them", t == null ? null : String(t)]); }
    var seen = {};
    return out.filter(function (p) { if (seen[p[0]]) return false; seen[p[0]] = 1; return true; });
  }

  return { NFLV_TO_MFL: NFLV_TO_MFL, toMfl: toMfl, NEUTRAL: NEUTRAL, parseBox: parseBox, gameIndex: gameIndex, shortDate: shortDate, longDate: longDate, groupOf: groupOf, viewsFor: viewsFor,
    rows: rows, rollup: rollup, columns: columns, detailStats: detailStats, withAssist: withAssist, scoredTackles: scoredTackles, punterBands: punterBands, f1: f1, pct: pct };
});
