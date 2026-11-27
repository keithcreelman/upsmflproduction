/* UPS 2027 Trades: Lineup impact (Keith 2026-11-26: "visibility into the points changing hands … a drill down to see the points and improvement/
   decrease in projected starting lineup points week over week and in total … top of class"). TEST TARGET ONLY. Pure: no network, no storage, no DOM.

   For each team in a trade and each week from the current lineup week through Week 17, the BEST projected starting lineup is built twice, from the
   team's roster before and after the trade, with MFL's own weekly projections (projectedScores) and the league's lineup slots (roster.js SLOTS:
   each one-position slot takes the best at its position, then the flex slots by exact search, as planner.optimal does). The difference is what the
   trade does to that team's projected starters. Who may start: the team's active players (taxi and injured reserve can't); a player received in
   a trade counts as active (MFL puts every traded player on the active roster). A player with no projection for a week counts 0 that week.
   Points changing hands: each moving player's points this season in this league (playerScores YTD and per-game AVG), next week's projection and
   the projected total for the weeks shown. Nothing here is a ruling or a promise: these are projections, labeled as such on screen. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(req ? require("./format.js") : root.UPS2027.format, req ? require("./roster.js") : root.UPS2027.roster);
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.tradeimpact = api; }
})(typeof self !== "undefined" ? self : this, function (F, R) {
  "use strict";
  var esc = F.esc, SLOTS = R.SLOTS, LAST_WEEK = 17;
  function pad4(x) { var s = String(x == null ? "" : x).trim(); return s ? ("0000" + s).slice(-4) : ""; }
  function num(x) { var n = parseFloat(x); return isFinite(n) ? n : null; }
  function r1(n) { return Math.round(n * 10) / 10; }
  function pts(n) { return n == null ? "—" : r1(n).toFixed(1); }
  function signed(n) { var v = r1(n); return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(1); }

  function weeks(S) { var w = parseInt(S.model && S.model.week, 10), out = []; if (!(w >= 1)) return out; for (var k = w; k <= LAST_WEEK; k++) out.push(k); return out; }

  // The best projected starting lineup from a pool [{ id, pos, v }]: { total, ids: [starter ids] }. Mirrors planner.optimal (no locks: it is a projection).
  function best(pool) {
    var used = {}, out = [], total = 0;
    var sorted = pool.slice().sort(function (a, b) { return b.v - a.v || (a.id < b.id ? -1 : 1); });
    SLOTS.filter(function (s) { return s.acc.length === 1; }).forEach(function (s) {
      for (var i = 0; i < sorted.length; i++) if (!used[sorted[i].id] && sorted[i].pos === s.acc[0]) { used[sorted[i].id] = 1; out.push(sorted[i].id); total += sorted[i].v; return; }
    });
    var flex = SLOTS.filter(function (s) { return s.acc.length > 1; }), top = { total: -Infinity, pick: [] };
    (function search(i, t, pick) {
      if (i === flex.length) { if (t > top.total) top = { total: t, pick: pick.slice() }; return; }
      var s = flex[i], tried = 0;
      for (var j = 0; j < sorted.length && tried < 6; j++) {
        var x = sorted[j]; if (used[x.id] || s.acc.indexOf(x.pos) < 0) continue;
        tried++; used[x.id] = 1; pick.push(x); search(i + 1, t + x.v, pick); pick.pop(); used[x.id] = 0;
      }
      if (!tried) search(i + 1, t, pick);
    })(0, 0, []);
    top.pick.forEach(function (x) { out.push(x.id); total += x.v; });
    return { total: total, ids: out };
  }

  // moves: [{ pid, from, to }] (players only). data: { proj: { [week]: { [pid]: points } }, ytd: { [pid]: points }, avg: { [pid]: points } }.
  function compute(S, fids, moves, data) {
    var W = weeks(S), byId = (S.model && S.model.byId) || {}, proj = (data && data.proj) || {};
    var out = { weeks: W, teams: {}, players: [], complete: W.every(function (w) { return !!proj[w]; }) };
    fids.forEach(function (fid) {
      var t = S.model.teams.filter(function (x) { return x.id === fid; })[0]; if (!t) return;
      var leaving = {}, coming = [];
      moves.forEach(function (m) { if (m.from === fid) leaving[m.pid] = 1; if (m.to === fid) coming.push(m.pid); });
      var beforeIds = t.players.filter(function (p) { return p.status === "active"; }).map(function (p) { return String(p.id); });
      var afterIds = beforeIds.filter(function (id) { return !leaving[id]; }).concat(coming.filter(function (id) { return beforeIds.indexOf(id) < 0; }));
      var pool = function (ids, w) { return ids.map(function (id) { var p = byId[id]; return p ? { id: id, pos: p.pos, v: num(proj[w] && proj[w][id]) || 0 } : null; }).filter(Boolean); };
      var rows = [], starts = {};
      W.forEach(function (w) {
        if (!proj[w]) { rows.push({ w: w, before: null, after: null, delta: null }); return; }
        var b = best(pool(beforeIds, w)), a = best(pool(afterIds, w));
        rows.push({ w: w, before: b.total, after: a.total, delta: a.total - b.total });
        a.ids.forEach(function (id) { if (b.ids.indexOf(id) < 0) (starts[id] = starts[id] || { inn: 0, out: 0 }).inn++; });
        b.ids.forEach(function (id) { if (a.ids.indexOf(id) < 0) (starts[id] = starts[id] || { inn: 0, out: 0 }).out++; });
      });
      var known = rows.filter(function (r) { return r.delta != null; });
      var sum = function (k) { return known.reduce(function (n, r) { return n + r[k]; }, 0); };
      var lineup = Object.keys(starts).map(function (id) { var p = byId[id]; return { pid: id, name: p ? p.name : "Player " + id, pos: p ? p.pos : "", inn: starts[id].inn, out: starts[id].out }; })
        .sort(function (a, b) { return (b.inn - b.out) - (a.inn - a.out) || (a.name < b.name ? -1 : 1); });
      out.teams[fid] = { fid: fid, name: t.name, rows: rows, weeksKnown: known.length, before: sum("before"), after: sum("after"), delta: sum("delta"),
        perWeek: known.length ? sum("delta") / known.length : null, lineup: lineup };
    });
    out.players = moves.map(function (m) {
      var p = byId[m.pid], next = W.length && proj[W[0]] ? num(proj[W[0]][m.pid]) : null, ros = 0, any = false;
      W.forEach(function (w) { var v = proj[w] ? num(proj[w][m.pid]) : null; if (v != null) { ros += v; any = true; } });
      return { pid: m.pid, name: p ? p.name : "Player " + m.pid, pos: p ? p.pos : "", from: m.from, to: m.to,
        ytd: data && data.ytd ? num(data.ytd[m.pid]) : null, avg: data && data.avg ? num(data.avg[m.pid]) : null, next: next, ros: any ? ros : null };
    }).sort(function (a, b) { return (b.ros || 0) - (a.ros || 0); });
    return out;
  }

  // ---- drawing ----
  function tone(d) { return d == null ? "" : r1(d) > 0 ? "up" : r1(d) < 0 ? "dn" : "eq"; }
  // The Review's summary: one line per team, the projected change per week and over the weeks shown. Tap → the drill-down.
  function summary(S, I, me) {
    if (!I) return '<div class="card"><h2>Lineup impact</h2><div class="ex">Loading projections…</div></div>';
    var fids = Object.keys(I.teams);
    return '<button class="card trimp trtap" data-act="trimpact" data-v="' + esc(me) + '"><span class="trh"><b>Lineup impact</b><span class="trgo">Details ›</span></span>' +
      fids.map(function (f) {
        var T = I.teams[f];
        return '<span class="impl"><span class="trnm">' + esc(f === me ? "You" : T.name) + '</span><span class="impv ' + tone(T.perWeek) + '">' + (T.perWeek == null ? "—" : signed(T.perWeek) + "/wk") +
          '</span><span class="impt ' + tone(T.delta) + '">' + (T.weeksKnown ? signed(T.delta) + " in " + T.weeksKnown + " wk" + (T.weeksKnown === 1 ? "" : "s") : "") + "</span></span>";
      }).join("") + (function () {
        var get = 0, give = 0, any = false;
        I.players.forEach(function (p) { if (p.ytd == null) return; any = true; if (p.to === me) get += p.ytd; if (p.from === me) give += p.ytd; });
        return any ? '<span class="ex">Season points: you get <b>' + pts(get) + "</b> · give <b>" + pts(give) + "</b></span>" : "";
      })() + '<span class="ex">Projected best starting lineup, before vs after (MFL projections).</span></button>';
  }
  function bar(d, maxAbs) {
    if (d == null) return '<span class="ibar"></span>';
    var steps = maxAbs > 0 ? Math.min(10, Math.round(Math.abs(d) / maxAbs * 10)) : 0;
    return '<span class="ibar"><span class="ihalf l">' + (d < 0 ? '<span class="ifill dn w' + steps + '"></span>' : "") + '</span><span class="ihalf r">' + (d > 0 ? '<span class="ifill up w' + steps + '"></span>' : "") + "</span></span>";
  }
  // The drill-down: team chips, a hero figure, week by week, who moves in and out of the lineup, and every moving player's points.
  function detail(S, I, me, sel, nameOf) {
    if (!I) return '<div class="ex pad">Loading projections…</div>';
    var fids = Object.keys(I.teams); if (fids.indexOf(sel) < 0) sel = fids[0];
    var T = I.teams[sel]; if (!T) return '<div class="ex pad">No projections for this team.</div>';
    var h = '<div class="chs trmode" role="group" aria-label="Team">' + fids.map(function (f) {
      return '<button class="ch" data-act="trimpteam" data-v="' + esc(f) + '" aria-pressed="' + (f === sel) + '">' + esc(f === me ? "You" : I.teams[f].name) + "</button>";
    }).join("") + "</div>";
    h += '<div class="card imphero"><div class="impbig ' + tone(T.perWeek) + '">' + (T.perWeek == null ? "—" : signed(T.perWeek)) + '<small> pts/wk</small></div>' +
      '<div class="impsub"><span><b class="' + tone(T.delta) + '">' + signed(T.delta) + "</b> over " + T.weeksKnown + " week" + (T.weeksKnown === 1 ? "" : "s") + "</span><span>" + pts(T.before) + " → " + pts(T.after) + " projected</span></div>" +
      '<div class="ex">Best projected starting lineup each week, before vs after the trade.</div></div>';
    var maxAbs = T.rows.reduce(function (m, r) { return r.delta == null ? m : Math.max(m, Math.abs(r.delta)); }, 0);
    h += '<div class="card"><h2>Week by week</h2><div class="iwk ihead"><span>Wk</span><span>Before</span><span>After</span><span></span><span>Change</span></div>' + T.rows.map(function (r) {
      return '<div class="iwk"><span>' + r.w + (r.w === parseInt(S.model.week, 10) ? '<small> now</small>' : "") + "</span><span>" + pts(r.before) + "</span><span>" + pts(r.after) + "</span>" + bar(r.delta, maxAbs) +
        '<span class="' + tone(r.delta) + '">' + (r.delta == null ? "—" : signed(r.delta)) + "</span></div>";
    }).join("") + (I.complete ? "" : '<div class="ex wn">Some weeks have no MFL projections yet.</div>') + "</div>";
    var inn = T.lineup.filter(function (x) { return x.inn; }), out = T.lineup.filter(function (x) { return x.out; });
    if (inn.length || out.length) h += '<div class="card"><h2>Lineup changes</h2>' +
      inn.map(function (x) { return '<div class="trd"><span class="in"><span class="up">▲</span> <b>' + esc(x.name) + "</b> " + esc(x.pos) + '</span><span class="mu">starts ' + x.inn + " of " + T.weeksKnown + "</span></div>"; }).join("") +
      out.map(function (x) { return '<div class="trd"><span class="in"><span class="dn">▼</span> <b>' + esc(x.name) + "</b> " + esc(x.pos) + '</span><span class="mu">' + x.out + " start" + (x.out === 1 ? "" : "s") + " lost</span></div>"; }).join("") + "</div>";
    h += '<div class="card"><h2>Points changing hands</h2><div class="itbl"><div class="irow ihead"><span class="in">Player</span><span>Season</span><span>PPG</span><span>Next</span><span>Proj</span></div>' + I.players.map(function (p) {
      return '<div class="irow"><span class="in"><b>' + esc(p.name) + "</b> " + esc(p.pos) + "<small>" + esc(nameOf(p.from) + " → " + nameOf(p.to)) + "</small></span><span>" + pts(p.ytd) + "</span><span>" + pts(p.avg) + "</span><span>" + pts(p.next) + "</span><span><b>" + pts(p.ros) + "</b></span></div>";
    }).join("") + '</div><div class="ex">Season: points in this league so far. Proj: MFL projections, weeks ' + (I.weeks[0] || "") + "–" + LAST_WEEK + ".</div></div>";
    return h;
  }

  return { LAST_WEEK: LAST_WEEK, weeks: weeks, best: best, compute: compute, summary: summary, detail: detail, signed: signed };
});
