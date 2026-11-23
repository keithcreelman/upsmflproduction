/* UPS 2027 beta (R6): the Breakdown, drawn as HTML strings. A player's season stats (rollup), his weekly game log in position-specific views, and
   each game's detail. Pure functions of the state object; every value from a data source goes through esc(). The numbers come from lib/boxlog.js.

   What it uses from the state: the player's game-stats read (S.intel.box[id], one per player and season), MFL's weekly scores (S.intel.scores, the reads
   Team > Performance already makes), the whole-season schedule (S.intel.cal.data.days, with kickoffs) and the clubs' byes, and the season cutoff W*
   (tabviews.seasonCutoff when it exists; until then the completed-week check, tabviews.completion). Nothing here asks for anything: lib/data.js does. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(
    req ? require("./format.js") : root.UPS2027.format,
    req ? require("./boxlog.js") : root.UPS2027.boxlog,
    req ? require("./tabviews.js") : root.UPS2027.tabviews,
    req ? require("./clubhist.js") : root.UPS2027.clubhist
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.breakdown = api; }
})(typeof self !== "undefined" ? self : this, function (F, BL, TV, CH) {
  "use strict";
  var esc = F.esc, DASH = "—", ENDASH = "–";

  // The one season cutoff (W*): Team > Performance's shared week when it is available, else the completed-week check. -> { state, week }
  function cutoffOf(S) {
    if (TV && typeof TV.seasonCutoff === "function") {
      var c = TV.seasonCutoff(S);
      if (typeof c === "number") return c >= 1 ? { state: "ok", week: c } : { state: "none" };
      if (c && typeof c === "object") return c.state ? c : typeof c.week === "number" ? { state: "ok", week: c.week } : { state: "loading" };
      return { state: "loading" };
    }
    return TV && TV.completion ? TV.completion(S) : { state: "error" };
  }
  function boxOf(S, pid) { var h = S.intel && S.intel.box; return h && h[pid] ? h[pid] : null; }
  function bdState(S) { return S.bd || { v: {}, g: {} }; }

  // The exact weekly position rank from the same weekly score read ("WR1"), or "" (not exact, no position, no score). One rank calculation, shared with Team > Performance.
  function weekRanker(S, pid) {
    if (!TV || !TV.perfInput || !TV.rankData) return null;
    var ctx; try { ctx = TV.perfInput(S, [pid]); } catch (e) { return null; }
    if (!ctx || ctx.read !== "ok") return null;
    var rd = TV.rankData(S, ctx);
    if (!rd || rd.state !== "ok" || !rd.weekRank) return null;
    return function (w) { var t = rd.weekRank(w, pid); return t ? String(t).replace(/\s+/g, "") : ""; };
  }

  // Bye weeks the team history establishes (club identity known that week), used only for a week with no stat or snap row of his own.
  function historyByes(S, pid, C) {
    var out = {};
    if (!TV || !TV.perfInput || !CH || !CH.logFor) return out;
    var ctx; try { ctx = TV.perfInput(S, [pid]); } catch (e) { return out; }
    if (!ctx || ctx.read !== "ok" || !ctx.input || !(ctx.input.latestFinal >= 1)) return out;
    CH.logFor(ctx.input, pid, { fromWeek: 1, toWeek: Math.min(C.week, ctx.input.latestFinal) }).forEach(function (e) { if (e.kind === "bye" && e.byeKnown) out[e.week] = true; });
    return out;
  }
  function inputFor(S, p, C) {
    var sc = (S.intel && S.intel.scores) || {}, scores = {}, scoreState = {};
    Object.keys(sc).forEach(function (w) {
      var r = sc[w]; scoreState[w] = r ? r.state : undefined;
      if (r && r.state === "ok" && r.data && r.data.scores && Object.prototype.hasOwnProperty.call(r.data.scores, p.id)) scores[w] = r.data.scores[p.id];
    });
    var cal = S.intel && S.intel.cal && S.intel.cal.state === "ok" ? S.intel.cal.data : null, rec = boxOf(S, p.id);
    return { pos: p.pos, season: Number(S.model.season), cutoff: C.week, lineupWeek: S.model.week, currentClub: p.nflTeam, box: rec && rec.state === "ok" ? rec.data : null,
      scores: scores, scoreState: scoreState, games: cal && cal.days ? BL.gameIndex(cal.days, Number(S.model.season)) : null, byeOf: cal ? cal.byeOf : null, weekRank: weekRanker(S, p.id),
      histBye: historyByes(S, p.id, C) };
  }

  // ---------- small text helpers ----------
  function oppText(g) { return !g ? "" : (g.neutral ? "vs " : g.home === true ? "vs " : g.home === false ? "@ " : "") + F.commonCode(g.opp); }
  function resultText(g) {
    if (!g) return "";
    if (g.status !== "final") return g.status === "live" ? "In progress" : g.status === "scheduled" ? "Scheduled" : "Status unknown";
    var a = g.score, b = g.oppScore; return (a > b ? "W " : a < b ? "L " : "T ") + a + ENDASH + b;
  }
  function ptsText(r) {
    if (r.ptsKind === "score") return BL.f1(r.pts);
    if (r.ptsKind === "unreadable") return "?";
    if (r.ptsKind === "loading") return "…";
    if (r.ptsKind === "error") return "n/a";
    return DASH;
  }
  // the game identity, pinned in the first column of every view: week and opponent, then the game's date in Eastern Time
  function pinHtml(r) {
    var g = r.game, opp = r.bye ? "BYE" : g ? oppText(g) : DASH, d = g && g.kickoff ? BL.shortDate(g.kickoff) : "";
    return "<b>W" + r.week + '</b> <span class="nw">' + esc(opp) + "</span><small>" + esc(d || (r.bye ? "Bye week" : "Date not available")) + "</small>";
  }
  function cell(v) { return v == null ? '<td class="n mu">' + DASH + "</td>" : '<td class="n">' + esc(v) + "</td>"; }
  function partShort(r) { return r.part && r.part !== "Played" ? r.part : ""; }

  // ---------- the season rollup ----------
  function rollupHtml(R, notes) {
    if (!R) return "";
    if (!R.to) return '<div class="ex">No settled week has game stats yet.</div>';
    var out = '<div class="sec2">Season stats · ' + (R.to > 1 ? "Weeks 1" + ENDASH + R.to : "Week 1") + '</div><div class="card bdr"><table><tr><th>Stat</th><th class="n">Season</th><th class="n">Rank</th></tr>';
    R.sections.forEach(function (sec) {
      out += '<tr class="bdh"><th colspan="3">' + esc(sec.h) + "</th></tr>";
      sec.items.forEach(function (it) {
        var part = it.value != null && it.of != null && it.n != null && it.n < it.of ? "<small>" + it.n + " of " + it.of + " games</small>" : "";
        out += "<tr><td>" + esc(it.label) + '</td><td class="n">' + (it.value == null ? '<span class="mu">Not available</span>' : "<b>" + esc(it.value) + "</b>" + part) + '</td><td class="n mu">' + DASH + "</td></tr>";
      });
    });
    out += "</table></div>";
    out += '<div class="ex">' + (R.games === 1 ? "1 game" : R.games + " games") + " with a stat line." + (notes.length ? " " + notes.map(esc).join(" ") : "") + "</div>";
    return out;
  }

  // ---------- one game's detail ----------
  var HOW = { row: "", between: " (between his games for this club)", current: " (his current club)", carried: " (his latest club)" };
  function detailHtml(S, p, r, inp, boxRec) {
    var g = r.game, kv = [];
    function add(k, v) { kv.push("<b>" + esc(k) + "</b><span>" + v + "</span>"); }
    add("Season and week", esc(S.model.season) + " · NFL Week " + r.week + " (MFL Week " + r.week + ")");
    add("Kickoff", g && g.kickoff ? esc(BL.longDate(g.kickoff)) : r.bye ? "Bye week" : "Not available");
    add("Team that week", r.club ? esc(F.commonCode(r.club)) + esc(HOW[r.clubHow] || "") : r.clubHow === "conflict" ? "Records conflict" : r.clubHow === "history" ? "Known from team history (his club’s bye)" : "Not established");
    if (g) {
      add("Opponent", esc(F.commonCode(g.opp)));
      add("Site", g.neutral ? "Neutral site" : g.home === true ? "Home" : g.home === false ? "Away" : "Not available");
      add("Game", esc(g.status === "final" ? "Final · " + resultText(g) : resultText(g)));
    }
    add("Participation", esc(r.part || "Not available"));
    add("MFL points", esc(ptsText(r)) + (r.rank ? " · " + esc(r.rank) + " that week" : "") + (r.newer ? " · not in the season figures yet" : ""));
    var haveStats = !!(boxRec && boxRec.state === "ok" && (r.box || r.snaps || r.rz)), stats = haveStats ? BL.detailStats(p.pos, r) : [];
    var g0 = BL.groupOf(p.pos);
    var out = '<div class="kv">' + kv.join("") + "</div>";
    if (stats.length) out += '<div class="kv mt6">' + stats.map(function (s) { return "<b>" + esc(s[0]) + "</b><span>" + (s[1] == null ? '<span class="mu">' + DASH + "</span>" : esc(s[1])) + "</span>"; }).join("") + (g0.kind === "p" ? '<b>Blocked punts</b><span class="mu">Not available</span>' : "") + "</div>";
    else if (boxRec && boxRec.state === "ok") out += '<div class="ex mt6">' + (r.statsIn ? "No stat line for this game." : "Game stats for this week are not in yet.") + "</div>";
    var asof = [];
    if (boxRec && boxRec.state === "ok") asof.push("Game stats through Week " + (boxRec.data.through == null ? "unknown" : boxRec.data.through) + (boxRec.at ? ", read " + F.etStamp(new Date(boxRec.at).toISOString()) : ""));
    asof.push("Points: MFL");
    if (g0.kind === "k") asof.push("Missed-kick distances are not in the stats feed");
    if (g0.pos === "QB") asof.push("Fumbles lost do not include fumbles on sacks");
    out += '<div class="ex mt6">' + esc(asof.join(". ")) + ".</div>";
    return out;
  }

  // ---------- the panel ----------
  // opts.summary === false leaves out the "Through Week N · points · scored games" line (for a call site whose card already shows those figures).
  function panel(S, p, opts) {
    if (!S.model || !p) return "";
    opts = opts || {};
    var pid = String(p.id), C = cutoffOf(S), boxRec = boxOf(S, pid);
    var head = '<div class="bdx" data-bdpid="' + esc(pid) + '">';
    if (C.state === "loading" || !C.state) return head + '<div class="ex">Loading the breakdown…</div></div>';
    if (C.state === "none") return head + '<div class="ex">No week has been completed yet.</div></div>';
    if (C.state !== "ok") return head + (TV && TV.failCard ? TV.failCard("retryperf") : "") + "</div>";
    var inp = inputFor(S, p, C), rs = BL.rows(inp), R = BL.rollup(inp, rs), g = BL.groupOf(p.pos);
    var views = boxRec && boxRec.state === "ok" ? BL.viewsFor(p.pos) : [["fan", "Fantasy"]];
    var st = bdState(S), v = st.v[pid] && views.some(function (x) { return x[0] === st.v[pid]; }) ? st.v[pid] : "fan";
    var out = head;
    // the settled fantasy season, from the same weekly reads and the same cutoff as Team > Performance
    var settled = rs.filter(function (r) { return !r.newer; }), tot = 0, nsc = 0, nLoad = 0, nErr = 0, nBad = 0;
    settled.forEach(function (r) { if (r.ptsKind === "score") { tot += Math.round(r.pts * 100); nsc++; } else if (r.ptsKind === "loading") nLoad++; else if (r.ptsKind === "error") nErr++; else if (r.ptsKind === "unreadable") nBad++; });
    var nBadAll = rs.filter(function (r) { return r.ptsKind === "unreadable"; }).length;
    if (opts.summary !== false) out += '<div class="bdsum"><b>Through Week ' + C.week + "</b> · " + (nBad || nErr || nLoad ? '<span class="mu">' + (nLoad ? "points still loading" : "season points not shown") + "</span>" : esc(BL.f1(tot / 100)) + " pts · " + nsc + (nsc === 1 ? " scored game" : " scored games")) + "</div>";
    if (nBadAll) out += '<div class="ex wn">' + (nBadAll === 1 ? "1 score" : nBadAll + " scores") + " could not be read, so his season figures are not shown.</div>";
    if (nErr) out += '<div class="ex wn">' + (nErr === 1 ? "1 week" : nErr + " weeks") + ' of scores could not be read and show n/a. <button class="link" data-act="retrylog">Try again</button></div>';
    // the game-stats read: one line when it is not there
    if (!boxRec || boxRec.state === "loading") out += '<div class="ex">Loading game stats…</div>';
    else if (boxRec.state === "absent") out += '<div class="ex">Game stats aren’t in this recording; the log shows fantasy points only.</div>';
    else if (boxRec.state === "error") out += '<div class="ex wn">Game stats didn’t load' + (boxRec.error ? " (" + esc(boxRec.error) + ")" : "") + '. <button class="link" data-act="retrybox" data-pid="' + esc(pid) + '">Try again</button></div>';
    else {
      var notes = [];
      if (boxRec.data.through != null && boxRec.data.through < C.week) notes.push("Game stats are in through Week " + boxRec.data.through + ".");
      if (g.kind === "k") notes.push("Missed-kick distances are not in the stats feed.");
      out += rollupHtml(R, notes);
    }
    // the weekly log
    out += '<div class="sec2">Game log</div>';
    if (views.length > 1) out += '<div class="seg' + (views.length === 4 ? " seg4" : "") + '" role="group" aria-label="Game log view">' + views.map(function (x) { return '<button data-act="bdv" data-v="' + x[0] + '" data-pid="' + esc(pid) + '" aria-pressed="' + (v === x[0]) + '">' + x[1] + "</button>"; }).join("") + "</div>";
    var cols = v === "fan" ? [] : BL.columns(p.pos, v), heads;
    if (v === "fan") heads = ['<th class="n">Pts</th>', '<th class="n" title="Rank among players at his position that week (exact only)">Rank</th>', "<th>Result</th>"];
    else heads = cols.map(function (c) { return '<th class="n" title="' + esc(c.t) + '">' + esc(c.h) + "</th>"; });
    var ncol = heads.length + 1, openW = st.g[pid];
    out += '<div class="bdw"><table class="bdt"><thead><tr><th class="pin">Game</th>' + heads.join("") + "</tr></thead><tbody>";
    var shown = rs.slice().reverse(), drew = false;
    shown.forEach(function (r) {
      if (r.newer && r.ptsKind !== "score" && !r.game && !r.box && !r.bye) return;   // a newer week with nothing to show yet is left out
      drew = true;
      var open = openW === r.week, cls = (r.newer ? "newer" : "") + (open ? " open" : "");
      var row = '<tr class="' + cls.trim() + '"><th class="pin"><button data-act="bdg" data-v="' + r.week + '" data-pid="' + esc(pid) + '" aria-expanded="' + open + '" aria-label="Week ' + r.week + ' game details">' + pinHtml(r) + "</button></th>";
      if (v === "fan") {
        var ps = ptsText(r), res = r.bye ? "Bye" : resultText(r.game), pt = partShort(r);
        if (r.newer) res = (res ? res + " · " : "") + "not in season figures";
        row += '<td class="n">' + (r.ptsKind === "score" ? "<b>" + esc(ps) + "</b>" : '<span class="mu"' + (r.ptsKind === "unreadable" ? ' title="This score could not be read"' : "") + ">" + esc(ps) + "</span>") + "</td>" + cell(r.rank || null) +
          "<td>" + esc(res || DASH) + (pt && pt !== "Bye" ? '<small>' + esc(pt) + "</small>" : "") + "</td>";
      } else {
        row += cols.map(function (c) { return cell(r.box || r.rz || r.snaps ? c.get(r) : null); }).join("");
      }
      row += "</tr>";
      if (open) row += '<tr class="bdd"><td colspan="' + ncol + '"><div class="bdin">' + detailHtml(S, p, r, inp, boxRec) + "</div></td></tr>";
      out += row;
    });
    out += "</tbody></table></div>";
    if (!drew) out += '<div class="ex">No games yet.</div>';
    out += '<div class="ex">' + DASH + " is not recorded, never a zero. Tap a game for its details.</div>";
    return out + "</div>";
  }

  return { panel: panel, cutoffOf: cutoffOf, inputFor: inputFor };
});
