/* UPS 2027 preview: League › Standings screens (#1503). Pure functions of the state object, HTML strings out (like views.js). Every text that comes
   from data goes through esc(). Nothing here changes anything: a tab, a toggle, a team name (opens its detail) and that is all.
   The model is lib/standings.js (built once by the controller when its reads land, kept in S.lgd.model). */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format, req ? require("./standings.js") : root.UPS2027.standings);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.standview = api; }
})(typeof self !== "undefined" ? self : this, function (F, ST) {
  "use strict";
  var esc = F.esc;

  // ---- formatting: points and Pts/Wk one decimal with thousands separators; ranks with "T" when shared
  function t1(x) { if (x == null || !isFinite(Number(x))) return "—"; var v = Math.round(Number(x) * 10) / 10; return v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function t2(x) { return x == null || !isFinite(Number(x)) ? "—" : (Math.round(Number(x) * 100) / 100).toFixed(2); }
  function rec(a) { return a ? a.w + "–" + a.l + (a.t ? "–" + a.t : "") : "—"; }
  function appct(a) { var n = a ? a.w + a.l + (a.t || 0) : 0; return n ? (100 * (a.w + 0.5 * (a.t || 0)) / n).toFixed(1) : "—"; }
  function rk(r, tie) { return r == null ? "—" : (tie ? "T" : "") + r; }
  function sharedRank(map, f) { var n = 0; Object.keys(map).forEach(function (g) { if (map[g] === map[f]) n++; }); return n > 1; }
  function signed(x) { var v = Math.round(Number(x) * 10) / 10; return v > 0 ? '<span class="ok">+' + v.toFixed(1) + "</span>" : v < 0 ? '<span class="wn">−' + Math.abs(v).toFixed(1) + "</span>" : "0.0"; }
  function posLabel(p) { return p === "PK" ? "K" : p === "PN" ? "P" : p; }
  function on(S, k) { return !!(S.lg && S.lg.open && S.lg.open[k]); }
  function tog(S, k, label, cls) { var o = on(S, k); return '<button class="lgtg' + (cls ? " " + cls : "") + '" data-act="lgt" data-v="' + esc(k) + '" aria-expanded="' + o + '"><span>' + label + '</span><span class="go" aria-hidden="true">' + (o ? "Hide" : "Show") + "</span></button>"; }
  function plus(S, k, label) { var o = on(S, k); return '<button class="lgx" data-act="lgt" data-v="' + esc(k) + '" aria-expanded="' + o + '" aria-label="' + esc(label) + '">' + (o ? "−" : "+") + "</button>"; }
  function tn(M, f) { return '<button class="lgtn" data-act="lgteam" data-fid="' + esc(f) + '">' + esc(M.names[f] || f) + "</button>"; }
  function nm(M, f) { return esc(M.names[f] || f); }

  var SUBS = [["race", "Race"], ["div", "Divisions"], ["scoring", "Scoring"]];
  function tabs(S) {
    var cur = (S.lg && S.lg.sub) || "race";
    return '<div class="tabs stk" role="tablist" aria-label="Standings">' + SUBS.map(function (t) { return '<button role="tab" data-act="lgsub" data-v="' + t[0] + '" aria-selected="' + (cur === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</div>";
  }
  function asOf(S) {
    var M = S.lgd && S.lgd.model;
    if (!M || M.state !== "ok") return "";
    return esc(String(M.season)) + " · through Week " + M.through + " of " + M.lastReg + " · regular season";
  }

  function body(S) {
    var L = S.lgd || {}, M = L.model;
    if (!M) {
      if (L.st && L.st.state === "error") return '<div class="card hl"><h2>Standings</h2><div class="big2"><b>Couldn’t read the standings. Try again.</b></div><div class="ex">' + esc(L.st.error || "") + '</div><button class="btn pri blk" data-act="lgretry">Try again</button></div>';
      return '<div class="card" aria-busy="true"><div class="mu ctr sm">Loading the standings…</div></div>';
    }
    if (M.state !== "ok") return '<div class="card warnc"><h2>Standings</h2><div class="ex">' + esc(typeof M.why === "string" ? M.why : "The standings are not available.") + "</div></div>";
    var sub = (S.lg && S.lg.sub) || "race";
    return sub === "div" ? divisions(S, M) : sub === "scoring" ? scoring(S, M) : race(S, M);
  }

  // ---------- Race ----------
  var LBL = { overall: "overall record", points_for: "total Points For", head_to_head: "the games between them" };
  // the pairs the Worker separated on a step after All-Play % (seed_reason), each shown once on both teams' rows
  function tiePairs(M) {
    var out = {};
    M.rows.forEach(function (r) {
      var sr = r.seed_reason || {}, pairs = [];
      if (sr.step && LBL[sr.step] && sr.rival_franchise_id) pairs.push({ rival: sr.rival_franchise_id, step: sr.step, ahead: sr.position === "ahead" });
      if (sr.vs_above && LBL[sr.vs_above.step]) pairs.push({ rival: sr.vs_above.franchise_id, step: sr.vs_above.step, ahead: false });
      pairs.forEach(function (p) {
        var a = r.franchise_id, b = p.rival; if (!b) return;
        (out[a] = out[a] || {})[b] = { step: p.step, ahead: p.ahead };
        (out[b] = out[b] || {})[a] = { step: p.step, ahead: !p.ahead };
      });
    });
    return out;
  }
  function tieTable(M, a, b, step) {
    var A = M.byFid[a].regular_season, B = M.byFid[b].regular_season, order = ["all_play", "overall", "points_for", "head_to_head"], si = order.indexOf(step);
    var cells = { all_play: [rec(A.all_play) + " (" + appct(A.all_play) + "%)", rec(B.all_play) + " (" + appct(B.all_play) + "%)"], overall: [rec(A.record), rec(B.record)], points_for: [t1(A.points_for), t1(B.points_for)], head_to_head: ["", ""] };
    var names = { all_play: "All-Play", overall: "Overall record", points_for: "Points For", head_to_head: "Games between them" };
    var h = '<table class="lgtie"><thead><tr><th class="t">Step</th><th>' + esc(M.abbr[a] || M.names[a]) + "</th><th>" + esc(M.abbr[b] || M.names[b]) + "</th><th></th></tr></thead><tbody>";
    order.forEach(function (k, i) { h += '<tr><td class="t">' + names[k] + "</td><td>" + (i <= si ? cells[k][0] : "") + "</td><td>" + (i <= si ? cells[k][1] : "") + "</td><td>" + (i < si ? "level" : i === si ? "<b>decides</b>" : "not needed") + "</td></tr>"; });
    return h + '</tbody></table><div class="ex mt4">Compared on exact records and Points For to the tenth, as MFL scores them, not on the rounded percentages.</div>';
  }
  function race(S, M) {
    var TL = tiePairs(M), W = M.withheld, h = "", anyClinch = false;
    M.rows.forEach(function (r, i) {
      var f = r.franchise_id, rs = r.regular_season, c = M.clinch[f] || {}, held = !!W.fids[f], pos = i + 1;
      var clinched = c.z ? "Clinched bye" : c.y ? "Clinched division" : c.x ? "Clinched playoffs" : c.e ? "Eliminated" : "";
      if (clinched) anyClinch = true;
      var tag = held ? "" : r.playoff_status === "bye" ? "Bye" : r.playoff_status === "division_winner" ? "Division" : r.playoff_status === "wild_card" ? "Wild card" : "";
      var seed = held && W.seeds[pos] ? "—" : r.playoff_seed || "";
      if (c.lock) seed = String(c.lock);
      if (i === 6 && !W.cutHidden) h += '<tr class="lgcut"><td colspan="5">Playoff line</td></tr>';
      var lines = "", panels = "";
      if (!held) Object.keys(TL[f] || {}).forEach(function (o) {
        var t = TL[f][o], k = "tie:" + f + ":" + o, op = on(S, k);
        lines += '<button class="lgwhy" data-act="lgt" data-v="' + esc(k) + '" aria-expanded="' + op + '">' + (t.ahead ? "Ahead of " : "Behind ") + nm(M, o) + " on " + LBL[t.step] + (op ? " ▾" : " ›") + "</button>";
        if (op) panels += '<tr class="lgsubrow"><td colspan="5"><div class="lgwhyx">' + tieTable(M, f, o, t.step) + "</div></td></tr>";
      });
      h += '<tr><td class="rk">' + esc(String(seed)) + '</td><td class="t">' + tn(M, f) + (clinched ? ' <span class="lgtag cl">' + clinched + "</span>" : tag ? ' <span class="lgtag">' + tag + "</span>" : "") + lines + "</td><td>" + appct(rs.all_play) + "</td><td>" + rec(rs.record) + "</td><td>" + (held ? "—" : esc(M.forecast.by[f].playoffs)) + "</td></tr>" + panels;
    });
    var out = '<div class="card"><div class="lgtw"><table class="lgt"><thead><tr><th class="t">Seed</th><th class="t">Team</th><th>AP%</th><th>W–L</th><th>Playoff %</th></tr></thead><tbody>' + h + "</tbody></table></div>";
    if (W.any) out += '<div class="lgnote wn">Some teams are level on All-Play %, overall record and total Points For, and the rules don’t say how to order them. Their seeds, tags, Playoff % and magic numbers are not shown until they separate. Records and verified clinches still show.</div>';
    out += '<p class="lgn">Through Week ' + M.through + " of " + M.lastReg + ". " + (M.forecast.fresh ? "Playoff % from the forecast run after Week " + M.forecast.throughWeek + "." : esc(M.forecast.why || "")) + (anyClinch ? "" : " No team has clinched yet, so every tag is a current position.") + "</p>";
    out += tog(S, "rd", "Race details") + (on(S, "rd") ? '<div class="lgxb">' + raceDetails(M) + "</div>" : "") + "</div>";
    return out;
  }
  function raceDetails(M) {
    var m = M.magic, W = M.withheld, d = "";
    if (!m || m.status !== "ok") return '<div class="ex">Magic numbers are not available (' + esc(m && m.status || "no schedule") + ").</div>";
    d += '<div><b>Division magic numbers</b><div class="lgn">Wins by the leader plus losses by the closest rival that settle the division.</div></div>';
    Object.keys(m.division.byDivision).forEach(function (k) { var x = m.division.byDivision[k]; if (W.fids[x.leader] || W.fids[x.vs]) return;
      d += '<div class="lgl">' + esc(M.divisions[k] || k) + ": " + nm(M, x.leader) + " <b>" + esc(String(x.magic)) + '</b> <span class="mu">vs ' + nm(M, x.vs) + "</span></div>"; });
    if (!W.fids[m.wildCard.vs]) {
      d += '<div><b>Wild-card magic numbers</b><div class="lgn">All-Play wins by the wild card plus All-Play losses by ' + nm(M, m.wildCard.vs) + ", the first team out, that keep it ahead.</div></div>";
      m.wildCard.teams.forEach(function (x) { if (!W.fids[x.franchise_id]) d += '<div class="lgl">' + nm(M, x.franchise_id) + " <b>" + esc(String(x.magic)) + "</b></div>"; });
    }
    var last = M.rows[5] && M.rows[5].franchise_id;
    d += '<div><b>Behind the last wild card</b><div class="lgn">All-Play wins behind ' + nm(M, last) + ". Ties count half.</div></div>";
    M.rows.filter(function (r) { return r.playoff_seed == null && !W.fids[r.franchise_id]; }).forEach(function (r) { d += '<div class="lgl">' + nm(M, r.franchise_id) + " <b>" + esc(String(r.ap_back)) + "</b>" + (r.ap_back === 0 ? ' <span class="mu">level on All-Play; behind on overall record</span>' : "") + "</div>"; });
    var out = M.fids.filter(function (f) { var v = M.forecast.by[f].verdicts; return v && v.division === "impossible"; });
    if (out.length) d += '<div class="lgn">Can no longer win the division: ' + out.map(function (f) { return nm(M, f); }).join(", ") + ".</div>";
    return d;
  }

  // ---------- Divisions ----------
  var DSTEP = { DIVPCT: "division record", H2H: "the games between them", PTS: "Points For", ALL_PLAY_PCT: "All-Play %", PWR: "power rank" };
  function gamesBetween(M, a, b) {
    var out = [];
    for (var w = 1; w <= M.through; w++) { var t = M.weeks[w]; var r = t && t.rows ? t.rows.filter(function (x) { return x.franchise_id === a; })[0] : null; (r && r.games || []).forEach(function (g) { if (g.opp === b) out.push({ w: w, ts: g.ts, os: g.os }); }); }
    return out;
  }
  function divisions(S, M) {
    var h = "", anyLine = false;
    Object.keys(M.divisions).sort().forEach(function (d) {
      var rows = M.rows.filter(function (r) { return String(r.division) === d; }).sort(function (a, b) { return a.division_rank - b.division_rank; });
      h += '<div class="card"><h2>' + esc(M.divisions[d]) + '</h2><div class="lgtw"><table class="lgt"><thead><tr><th class="t">Team</th><th>W–L</th><th>Div</th><th>GB</th><th>PF</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var rs = r.regular_season, va = r.division_reason && r.division_reason.vs_above, line = "";
        if (va && va.step && va.step !== "PCT" && DSTEP[va.step]) { anyLine = true; line = '<span class="lgsub">Behind ' + nm(M, va.franchise_id) + " on " + DSTEP[va.step] + "</span>"; }
        h += '<tr><td class="t">' + tn(M, r.franchise_id) + line + "</td><td>" + rec(rs.record) + "</td><td>" + rec(rs.division) + "</td><td>" + (r.division_games_back === 0 || r.division_games_back == null ? "—" : esc(String(r.division_games_back))) + "</td><td>" + t1(rs.points_for) + "</td></tr>";
      });
      h += "</tbody></table></div>" + tog(S, "h2h:" + d, "Head-to-head", "sm");
      if (on(S, "h2h:" + d)) {
        h += '<div class="lgxb">';
        for (var i = 0; i < rows.length; i++) for (var j = i + 1; j < rows.length; j++) {
          var a = rows[i].franchise_id, b = rows[j].franchise_id, g = gamesBetween(M, a, b), wa = g.filter(function (x) { return x.ts > x.os; }).length, wb = g.filter(function (x) { return x.ts < x.os; }).length, tt = g.length - wa - wb, k = "pr:" + a + ":" + b;
          h += tog(S, k, nm(M, a) + " " + wa + "–" + wb + (tt ? "–" + tt : "") + " " + nm(M, b), "sm");
          if (on(S, k)) h += '<div class="lgser">' + (g.length ? g.map(function (x) { return "<div>Week " + x.w + ": " + esc(M.abbr[a] || M.names[a]) + " " + t1(x.ts) + " – " + t1(x.os) + " " + esc(M.abbr[b] || M.names[b]) + "</div>"; }).join("") : "<div>No games yet.</div>") + "</div>";
        }
        h += "</div>";
      }
      h += "</div>";
    });
    h += '<p class="lgn">Order: MFL’s division rules for this season (win %, division win %, the games between the tied teams, Points For, All-Play %). ' + (anyLine ? "A short line shows where records are level." : "Every division is decided on win % this week, so no tiebreak line shows.") + "</p>";
    return h;
  }

  // ---------- Scoring ----------
  function scoring(S, M) {
    var per = S.lg.per || "season";
    var h = '<div class="card"><div class="lgrow"><div class="seg lgseg" role="group" aria-label="Period"><button data-act="lgper" data-v="season" aria-pressed="' + (per === "season") + '">Season</button><button data-act="lgper" data-v="week" aria-pressed="' + (per === "week") + '">Week</button></div></div>';
    return h + (per === "week" ? week(S, M) : season(S, M)) + "</div>";
  }
  function season(S, M) {
    var cset = S.lg.cset || "pts", B = M.sf.byFranchise, h = "";
    h += '<div class="chs" role="group" aria-label="View">' + [["pts", "Points"], ["fin", "Weekly finishes"], ["grp", "Contributions"]].map(function (o) { return '<button class="ch" data-act="lgset" data-v="' + o[0] + '" aria-pressed="' + (cset === o[0]) + '">' + o[1] + "</button>"; }).join("") + "</div>";
    var ids = M.fids.slice().sort(function (a, b) { return B[a].scored.pfRank - B[b].scored.pfRank || String(M.names[a]).localeCompare(String(M.names[b])); });
    if (cset === "pts") {
      var pr = {}; ids.forEach(function (f) { pr[f] = B[f].scored.pfRank; });
      h += '<div class="lgscope">Regular season · Weeks 1–' + M.through + ' completed</div><div class="lgtw"><table class="lgt"><thead><tr><th class="t">Rank</th><th class="t">Team</th><th>Total Pts</th><th>Pts/Wk</th></tr></thead><tbody>' +
        ids.map(function (f) { var s = B[f].scored; return '<tr><td class="rk">' + rk(s.pfRank, sharedRank(pr, f)) + '</td><td class="t">' + tn(M, f) + "</td><td>" + t1(s.pf) + "</td><td>" + t1(s.pfPerWeek) + "</td></tr>"; }).join("") + "</tbody></table></div>" +
        '<p class="lgn">Each week counts once, including two- and three-game weeks. Opponents’ points and luck are in each team’s detail.</p>';
    } else if (cset === "fin") {
      var Lb = M.leaders.byFranchise, ord = M.fids.slice().sort(function (a, b) { return (Lb[a].avgRank - Lb[b].avgRank) || String(M.names[a]).localeCompare(String(M.names[b])); }), ar = {};
      ord.forEach(function (f) { ar[f] = 1 + ord.filter(function (g) { return Lb[g].avgRank < Lb[f].avgRank; }).length; });
      h += '<div class="lgrow"><span class="lgscope">Regular season · Weeks 1–' + M.through + '</span><div class="seg lgseg sm" role="group" aria-label="Weeks"><button aria-pressed="true">Regular</button><button aria-pressed="false" aria-disabled="true">Playoffs</button><button aria-pressed="false" aria-disabled="true">All</button></div></div>' +
        '<div class="lgtw"><table class="lgt"><thead><tr><th class="t">#</th><th class="t">Team</th><th>Top</th><th>Top 3</th><th>Bot 3</th><th>Avg rk</th></tr></thead><tbody>' +
        ord.map(function (f) { var v = Lb[f]; return '<tr><td class="rk">' + rk(ar[f], sharedRank(ar, f)) + '</td><td class="t">' + tn(M, f) + "</td><td>" + v.topWeeks + "</td><td>" + v.top3 + "</td><td>" + v.bottom3 + "</td><td>" + t2(v.avgRank) + "</td></tr>"; }).join("") + "</tbody></table></div>" +
        '<p class="lgn">Sorted by average weekly rank (ties from the exact averages). Playoffs and All open once playoff weeks are played.</p>';
    } else {
      var C = M.contrib;
      if (!C || (C.state !== "ok" && C.state !== "partial")) return h + '<div class="ex">' + esc(C && C.why || "Contributions are not available.") + "</div>";
      h += '<div class="lgscope">Pts/Wk and league rank · Regular season · Weeks 1–' + M.through + '</div><div class="lgtw"><table class="lgt"><thead><tr><th class="t">Team</th><th>Offense</th><th>IDP</th><th>K &amp; P</th><th><span class="vh">Season totals</span></th></tr></thead><tbody>';
      ids.forEach(function (f) {
        var k = "ct:" + f;
        function cell(g) { var x = C.groups[g][f]; return t1(x.pw) + '<span class="lgsub">#' + rk(x.rank, x.tie) + "</span>"; }
        h += '<tr><td class="t">' + tn(M, f) + "</td><td>" + cell("off") + "</td><td>" + cell("idp") + "</td><td>" + cell("kp") + "</td><td>" + plus(S, k, "Season totals for " + (M.names[f] || f)) + "</td></tr>";
        if (on(S, k)) h += '<tr class="lgsubrow"><td colspan="5">Season totals: Offense <b>' + t1(C.groups.off[f].pts) + "</b> · IDP <b>" + t1(C.groups.idp[f].pts) + "</b> · K &amp; P <b>" + t1(C.groups.kp[f].pts) + "</b> · Team <b>" + t1(B[f].scored.pf) + "</b></td></tr>";
      });
      h += "</tbody></table></div>" + (C.state === "partial" ? '<div class="lgnote wn">' + esc(C.why) + "</div>" : "") +
        '<p class="lgn">Points per week, with league rank (#) underneath; + shows season totals. Offense is QB, RB, WR, TE; IDP is DL, LB, DB; K &amp; P is kicker and punter. The three add up to each team’s total.</p>';
    }
    return h;
  }
  function week(S, M) {
    var sel = S.lg.wk && S.lg.wk <= M.through ? S.lg.wk : M.through, c = "", h = "";
    for (var w = 1; w <= 17; w++) {
      if (w === M.lastReg + 1) c += '<span class="lglab">Playoffs</span>';
      var done = w <= M.through;
      c += '<button data-act="lgwk" data-v="' + w + '" aria-pressed="' + (w === sel) + '"' + (done ? "" : ' aria-disabled="true"') + ' aria-label="Week ' + w + (done ? "" : ", not played yet") + '">' + w + "</button>";
    }
    var T = M.weeks[sel];
    if (!T || T.status !== "ok") return '<div class="lgwkc" role="group" aria-label="Week">' + c + '</div><div class="ex">This week’s table is not available.</div>';
    var tp = T.top, lo = T.low, rkm = {};
    T.rows.forEach(function (r) { rkm[r.franchise_id] = r.rank; });
    h += '<div class="lgwkc" role="group" aria-label="Week">' + c + "</div>";
    h += '<div class="lgsum"><div>Week ' + sel + (T.isPlayoff ? " · Playoffs" : " · Regular season") + '</div><div><span class="mu">Top score</span> ' + tp.franchise_ids.map(function (f) { return nm(M, f); }).join(", ") + " " + t1(tp.score) + (tp.margin_over_second > 0 ? ' <span class="mu">by ' + t1(tp.margin_over_second) + "</span>" : "") + '</div><div><span class="mu">Low score</span> ' + lo.franchise_ids.map(function (f) { return nm(M, f); }).join(", ") + " " + t1(lo.score) + "</div></div>";
    h += '<div class="lgtw"><table class="lgt lgwt"><thead><tr><th class="t">Rk</th><th class="t">Team</th><th>Pts</th><th class="lgwide">All-Play</th><th class="lgwide">H2H</th><th><span class="vh">Games</span></th></tr></thead><tbody>';
    T.rows.forEach(function (r) {
      var f = r.franchise_id, k = "wg:" + sel + ":" + f, gs = r.games || [], has = gs.length > 0;
      var wl = { w: 0, l: 0, t: 0 }; gs.forEach(function (g) { if (g.result === "W") wl.w++; else if (g.result === "L") wl.l++; else wl.t++; });
      var h2h = has ? rec(wl) : T.isPlayoff ? "Bye" : "—";
      h += '<tr><td class="rk">' + rk(r.rank, sharedRank(rkm, f)) + '</td><td class="t">' + tn(M, f) + '<span class="lgsub lgnarrow"><span class="lgnw">All-Play ' + rec(r.ap) + '</span> · <span class="lgnw">H2H ' + h2h + "</span></span></td><td>" + t1(r.score) + '</td><td class="lgwide">' + rec(r.ap) + '</td><td class="lgwide">' + h2h + "</td><td>" + plus(S, k, "Games for " + (M.names[f] || f)) + "</td></tr>";
      if (on(S, k)) h += '<tr class="lgsubrow"><td colspan="6">' + (has ? gs.map(function (g) { return "<div><b>" + esc(g.result) + "</b> vs " + nm(M, g.opp) + " · " + t1(g.os) + "</div>"; }).join("") : T.isPlayoff ? "Bye this week." : "No game recorded. Shown as missing, not 0–0.") + "</td></tr>";
    });
    h += '</tbody></table></div><p class="lgn">All-Play: the week’s score against every other team’s that week. H2H: that week’s scheduled games combined. Tap a team for its detail; + shows its games.</p>';
    return h;
  }

  // ---------- Team detail (sheet) ----------
  var CG = [["off", "Offense"], ["idp", "IDP"], ["kp", "Kicking & Punting"]];
  function teamSheet(S) {
    var M = S.lgd && S.lgd.model, f = S.lg.team;
    if (!M || M.state !== "ok" || !M.byFid[f]) return sheet("Team", '<div class="ex">This team is not in the standings that loaded.</div>');
    var r = M.byFid[f], rs = r.regular_season, Sf = M.sf.byFranchise[f], L = M.leaders.byFranchise[f], C = M.contrib, held = !!M.withheld.fids[f];
    var tag = held ? "Seed not shown (unresolved tie)" : r.playoff_status === "bye" ? "Bye" : r.playoff_status === "division_winner" ? "Division" : r.playoff_status === "wild_card" ? "Wild card" : "Outside the field";
    var h = '<div class="ex">' + esc(M.divisions[String(r.division)] || "") + " · " + (r.playoff_seed && !held ? "Seed " + r.playoff_seed + " · " : "") + esc(tag) + " (current position)</div>";
    h += '<div class="card"><div class="lgkv"><div class="h">Through Week ' + M.through + '</div><div class="h n">Value</div><div class="h n">Rank</div>' +
      "<div>Total Pts</div><div class=\"n\">" + t1(Sf.scored.pf) + '</div><div class="n">' + esc(String(Sf.scored.pfRank)) + "</div>" +
      '<div>Pts/Wk</div><div class="n">' + t1(Sf.scored.pfPerWeek) + '</div><div class="n"></div>' +
      '<div>Opponents’ Pts/game</div><div class="n">' + t1(Sf.faced.paPerGame) + '</div><div class="n">' + esc(String(Sf.faced.paRank)) + "</div>" +
      '<div>W–L</div><div class="n">' + rec(rs.record) + '</div><div class="n"></div>' +
      '<div>Wins expected from All-Play</div><div class="n">' + t1(Sf.overall.expectedWins) + '</div><div class="n"></div>' +
      '<div>Luck (wins above expected)</div><div class="n">' + signed(Sf.overall.luck) + '</div><div class="n"></div></div><p class="lgn">Opponents’ rank: 1 = faced the most points.</p></div>';
    h += '<div class="card"><h2>Contributions</h2>';
    if (C && (C.state === "ok" || C.state === "partial")) {
      h += '<div class="lgkv"><div class="h">Group</div><div class="h n">Pts/Wk</div><div class="h n">Rank</div>' + CG.map(function (g) { var x = C.groups[g[0]][f]; return "<div>" + g[1] + '</div><div class="n">' + t1(x.pw) + '</div><div class="n">' + rk(x.rank, x.tie) + "</div>"; }).join("") + "</div>";
      h += tog(S, "tst", "Season totals", "sm") + (on(S, "tst") ? '<div class="lgkv">' + CG.map(function (g) { return "<div>" + g[1] + '</div><div class="n">' + t1(C.groups[g[0]][f].pts) + '</div><div class="n"></div>'; }).join("") + '<div>Team</div><div class="n">' + t1(Sf.scored.pf) + '</div><div class="n"></div></div>' : "");
      h += '<button class="lglink" data-act="lgbrk" data-fid="' + esc(f) + '">By position or lineup slot ›</button>';
    } else h += '<div class="ex">' + esc(C && C.why || "Not available.") + "</div>";
    h += "</div>";
    h += '<div class="card"><h2>Weekly scoring</h2><div class="lgcounts"><div><b>' + L.topWeeks + "</b><span>Top-score weeks</span></div><div><b>" + L.top3 + "</b><span>Top 3</span></div><div><b>" + L.bottom3 + "</b><span>Bottom 3</span></div></div>";
    h += tog(S, "twk", "Weekly points");
    if (on(S, "twk")) {
      var max = 0, rowsH = "";
      for (var w = 1; w <= M.through; w++) { var x = M.weeks[w].rows.filter(function (y) { return y.franchise_id === f; })[0]; max = Math.max(max, x ? x.score : 0, M.leagueAvg[w] || 0); }
      for (var w2 = 1; w2 <= M.through; w2++) {
        var y = M.weeks[w2].rows.filter(function (z) { return z.franchise_id === f; })[0]; if (!y) continue;
        var pct = max ? Math.max(1, Math.min(20, Math.round(y.score / max * 20))) : 1;
        rowsH += '<div class="lgbar"><span class="lgbw">Wk ' + w2 + '</span><i class="lgb w' + pct + '"></i><span class="lgbv">' + t1(y.score) + ' <span class="mu">avg ' + t1(M.leagueAvg[w2]) + " · #" + y.rank + "</span></span></div>";
      }
      h += '<div class="lgxb">' + rowsH + '<div class="lgkv mt6"><div>Average weekly rank</div><div class="n">' + t2(L.avgRank) + '</div><div class="n"></div><div>Best week</div><div class="n">' + t1(L.highScore.score) + '</div><div class="n">Wk ' + L.highScore.week + '</div><div>Worst week</div><div class="n">' + t1(L.lowScore.score) + '</div><div class="n">Wk ' + L.lowScore.week + '</div></div><p class="lgn">Avg = the league’s average score that week. Best and worst are observed weeks, not a forecast.</p></div>';
    }
    h += "</div>";
    return sheet(M.names[f] || "Team", h);
  }

  // ---------- Points breakdown (sheet): By position | By lineup slot ----------
  var POSL = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["DL", "DL"], ["LB", "LB"], ["DB", "DB"], ["PK", "K"], ["PN", "P"]];
  function playerName(S, id) {
    var p = S.intel && S.intel.players && S.intel.players.state === "ok" ? S.intel.players.data.byId[id] : null;
    if (!p || !p.name) return "Player " + id;
    var i = p.name.indexOf(", "); return i > 0 ? p.name.slice(i + 2) + " " + p.name.slice(0, i) : p.name;
  }
  function brkSheet(S) {
    var M = S.lgd && S.lgd.model, f = S.lg.team, C = M && M.contrib;
    if (!M || M.state !== "ok" || !M.byFid[f] || !C || (C.state !== "ok" && C.state !== "partial")) return sheet("Points breakdown", '<div class="ex">' + esc(C && C.why || "Not available.") + "</div>");
    var byPos = (S.lg.brk || "pos") === "pos";
    var groups = byPos ? POSL.map(function (p) { return { k: p[0], label: p[1], tbl: C.byPos[p[0]], pick: function (a) { return a.list.filter(function (s) { return s.pos === p[0]; }).map(function (s) { return { slot: "", s: s }; }); } }; })
      : ST.SLOT_GROUPS.map(function (g) { return { k: g[0], label: g[2], tbl: C.bySlot[g[0]], pick: function (a) { return g[1].filter(function (s) { return a.slots[s]; }).map(function (s) { return { slot: s.replace(/[12]$/, ""), s: a.slots[s] }; }); } }; });
    var h = '<div class="ex">' + esc(M.names[f]) + "</div>";
    h += '<div class="seg" role="group" aria-label="Breakdown"><button data-act="lgbv" data-v="pos" aria-pressed="' + byPos + '">By position</button><button data-act="lgbv" data-v="slot" aria-pressed="' + !byPos + '">By lineup slot</button></div>';
    h += '<div class="lgscope">Regular season · Weeks 1–' + M.through + " · starters only, points credited to this team</div>";
    h += '<div class="lgbrow h"><span>' + (byPos ? "Position" : "Slot") + '</span><span class="n">Pts/Wk</span><span class="n">Rank</span><span></span></div>';
    groups.forEach(function (g) {
      var x = g.tbl[f], k = "b:" + (byPos ? "p" : "s") + ":" + g.k, o = on(S, k);
      h += '<button class="lgbrow" data-act="lgt" data-v="' + esc(k) + '" aria-expanded="' + o + '"><span>' + esc(g.label) + '</span><span class="n">' + t1(x.pw) + '</span><span class="n">' + rk(x.rank, x.tie) + '</span><span class="go">' + (o ? "Hide" : "Show") + "</span></button>";
      if (!o) return;
      h += '<div class="lgxb"><div class="lgpl"><b>Season total</b><span>' + t1(x.pts) + "</span></div>";
      for (var w = 1; w <= M.through; w++) {
        var a = C.audit[f] && C.audit[f][w]; if (!a) continue;
        if (!byPos && a.status !== "ok") { h += '<div class="lgpl"><b>Week ' + w + "</b><span>Not allocated: " + esc(a.why) + "</span></div>"; continue; }
        var ps = g.pick(a), sum = 0, miss = false; ps.forEach(function (p) { if (p.s.score == null) miss = true; else sum += p.s.score; });
        var wk = k + ":" + w, wo = on(S, wk);
        h += '<button class="lgtg sm" data-act="lgt" data-v="' + esc(wk) + '" aria-expanded="' + wo + '"><span>Week ' + w + " · " + t1(sum) + '</span><span class="go">' + (wo ? "Hide" : "Show") + "</span></button>";
        if (wo) {
          h += ps.map(function (p) { return '<div class="lgpl"><b>' + esc(playerName(S, p.s.id)) + "</b><span>" + (p.slot ? esc(p.slot) + " · " : "") + esc(posLabel(p.s.pos)) + " · " + (p.s.score == null ? "—" : t1(p.s.score)) + "</span></div>"; }).join("") || '<div class="lgpl"><span>No starter here this week.</span></div>';
          if (miss) h += '<p class="lgn">— MFL lists this player as a starter with no score; nothing is added to the total. It isn’t a recorded zero.</p>';
        }
      }
      h += "</div>";
    });
    h += '<p class="lgn">' + (byPos ? "Grouped by the player’s MFL position (list " + esc(C.version) + ")." : "Slots are assigned from each week’s scores (see Help); they are derived, not the owner’s own choice of slot.") + " Position and slot are separate views of the same points; don’t add them together. Rank: 1–12 among the league’s teams over the same weeks, T = shared.</p>";
    return sheet("Points breakdown", h);
  }

  function sheet(title, inner) {
    return '<div class="layer"><div class="scrim" data-act="close"></div><div class="sheet full" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" tabindex="-1"><div class="grab"></div><div class="top"><h3>' + esc(title) + '</h3><button class="btn" data-act="close">Close</button></div>' + inner + "</div></div>";
  }

  // ---------- Help ----------
  function help(S) {
    var M = S.lgd && S.lgd.model, C = M && M.contrib, fc = M && M.forecast;
    function h(t, x) { return "<h4>" + esc(t) + "</h4><p>" + x + "</p>"; }
    var rec0 = S.recorded ? h("Recorded data", "This preview uses recordings, so nothing moves. The weekly lineups and scores were recorded " + esc(S.recorded.label) + ". The standings are generated offline from committed files with the Worker’s own seeding code (not a live answer)" + (M && M.through ? ", through Week " + M.through : "") + "." + (fc && fc.at ? " The forecast was run " + esc(F.etStamp(fc.at) || fc.at) + "." : "")) : "";
    return rec0 +
      h("Seed", "Where a team stands if the season ended today. Seeds 1–2 are the two best division winners; seeds 3–6 are the other division winners and the two wild cards. A green tag is clinched; an outlined tag is only the current position.") +
      h("Seeding order", "All-Play %, then overall record, then total Points For, then the games between the tied teams. Division winners are placed first, whatever their All-Play %. Exact records are compared, not the rounded percentages. A line under a team names the step that separated it from its neighbor; tap it for the figures.") +
      h("Seeds not shown", "If teams are still level after total Points For and the rules don’t say how to order them (three or more teams, or two that haven’t met or split their games), the seeds they could hold show “—”, with their tags, Playoff % and magic numbers, until they separate. Records and verified clinches still show.") +
      h("Division order", "MFL’s own order for this season: win %, division win %, the games between the tied teams, Points For, then All-Play %.") +
      h("Playoff %", "Share of " + (fc && fc.runs ? Number(fc.runs).toLocaleString("en-US") : "the") + " simulated seasons that reach the playoffs. 100% or 0% only when clinched or ruled out by the clinch rules; otherwise &gt;99% and &lt;1% mark the ends.") +
      h("Total Pts, Pts/Wk", "Points scored in completed regular-season weeks. Each week counts once, even in two- and three-game weeks. Pts/Wk describes past weeks, not a projection.") +
      h("Top / Top 3 / Bot 3, Avg rk", "Weeks with the league’s highest score, a top-3 score or a bottom-3 score. Avg rk is the average weekly score rank (1 = highest), shown to two decimals; ties come from the exact averages.") +
      h("All-Play and H2H", "All-Play: a week’s score against every other team’s that week (11 results). H2H: the week’s scheduled games combined, e.g. 2–1.") +
      h("Offense, IDP, Kicking & Punting", "Official MFL points credited to each team’s actual starters that week, grouped by the player’s position. A return touchdown by a receiver stays with WR. The three add up to the team’s total.") +
      h("By lineup slot", "MFL records which players started, not which slot each filled, so these slots are derived, not recorded owner choices. Each week, required positions are filled first with the highest scorers, then SFX (the second QB if two started, otherwise the best remaining RB, WR or TE), then OFX, then DFX; weeks are then added up. Equal scores go to the lower MFL player id. Zero and negative scores count.") +
      h("—", "At player level: MFL’s weekly results list the player as a starter but give no score. Nothing is added to the team’s total, and it isn’t a recorded zero. A real 0.0 shows as 0.0." + (C && C.noScore ? " This season: " + C.noScore.length + " such starters." : "")) +
      h("Positions", C && C.version ? "Each player’s MFL position from a fixed, versioned list saved with this data (" + esc(C.version) + "), so past weeks don’t change if a player’s position changes later. MFL’s weekly results don’t say what position a player had that week." : "Not available in this mode: contributions need a dated position list.") +
      (C && C.problems && C.problems.length ? h("Team-weeks left out", C.problems.map(function (p) { return "Week " + p.w + ", " + esc(M.names[p.fid] || p.fid) + ": " + esc(p.why); }).join("<br>")) : "") +
      h("Best / worst week", "Observed scores, not a forecast of a ceiling or floor.") + h("T", "Shared rank.");
  }
  function helpSheet(S) { return sheet("Help", '<div class="helpb">' + help(S) + "</div>"); }

  return { tabs: tabs, body: body, asOf: asOf, teamSheet: teamSheet, brkSheet: brkSheet, helpSheet: helpSheet, t1: t1, t2: t2 };
});
