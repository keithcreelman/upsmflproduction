/* UPS 2027 beta (R6): the Breakdown, drawn as HTML strings. A player's season stats (rollup), his weekly game log in position-specific views, and
   each game's detail. Pure functions of the state object; every value from a data source goes through esc(). The numbers come from lib/boxlog.js.

   What it uses from the state: the player's game-stats read (S.intel.box[id], one per player and season), MFL's weekly scores (S.intel.scores, the reads
   Team > Performance already makes), the whole-season schedule (S.intel.cal.data.days, with kickoffs) and the clubs' byes, and the season cutoff W*
   (tabviews.seasonCutoff, shared with the main card). Nothing here asks for anything: lib/data.js does. */
(function (root, factory) {
  var req = typeof require === "function";
  var api = factory(
    req ? require("./format.js") : root.UPS2027.format,
    req ? require("./boxlog.js") : root.UPS2027.boxlog,
    req ? require("./tabviews.js") : root.UPS2027.tabviews,
    req ? require("./clubhist.js") : root.UPS2027.clubhist,
    req ? require("./statranks.js") : root.UPS2027.statranks,
    req ? require("./oppctx.js") : root.UPS2027.oppctx
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.breakdown = api; }
})(typeof self !== "undefined" ? self : this, function (F, BL, TV, CH, SR, OC) {
  "use strict";
  var esc = F.esc, DASH = "—", ENDASH = "–";

  // The one season cutoff W*: Team > Performance's shared week (tabviews.seasonCutoff), the same week as the main card's figures and ranks.
  // -> { state, week, allFinal, reason }. Weeks after W* (a newer all-final week, the lineup week) are drawn in the log as newer, outside the summary.
  function cutoffOf(S) {
    var c = TV.seasonCutoff(S);
    if (!c || !c.state) return { state: "loading" };
    if (c.state === "ok" && !(c.week >= 1)) return { state: "none" };
    return c;
  }
  function boxOf(S, pid) { var h = S.intel && S.intel.box; return h && h[pid] ? h[pid] : null; }
  // per player: v = game-log view, g = the open game's week, t = the section ("season" | "log"; R8)
  function bdState(S) { return S.bd || { v: {}, g: {}, t: {} }; }

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
    return "<b>W" + r.week + '</b> <span class="nw">' + esc(opp) + "</span><small>" + esc(d || (r.bye ? "Bye week" : "")) + "</small>";   // no date: the line stays empty (the detail says Not available)
  }
  function cell(v) { return v == null ? '<td class="n mu">' + DASH + "</td>" : '<td class="n">' + esc(v) + "</td>"; }
  function partShort(r) { return r.part && r.part !== "Played" ? r.part : ""; }

  // ---------- season stat ranks (lib/statranks.js) ----------
  // The position pool is the Worker's /api/position-season-stats answer for (season, W*, group), kept by app.js in S.intel.pss under
  // statKey(...) ("2026|10|WR"); the panel names the key it needs in data-pss. -> function (item) -> { text, why } or null (no rank column values).
  function statKey(S, C, group) { return S.model.season + "|" + C.week + "|" + group; }
  function statRanker(S, p, C, R) {
    var group = SR ? SR.groupOf(p.pos) : "";
    if (!group || !R || !R.to) return null;
    var rec = S.intel && S.intel.pss ? S.intel.pss[statKey(S, C, group)] : null;
    if (!rec) return function () { return null; };
    if (rec.state === "loading") return function () { return { text: "…", why: "Position ranks are loading." }; };
    if (rec.state !== "ok") return function () { return { text: DASH, why: rec.state === "absent" ? "Position ranks are not in this recording." : "Position ranks did not load." }; };
    var pool = SR.checkPool(rec.data, S.model.season, C.week, group);
    if (pool.ok && pool.dataMaxWeek != null && Math.min(C.week, pool.dataMaxWeek) !== R.to) pool = { ok: false, why: "for other weeks" };
    var cal = S.intel.cal && S.intel.cal.state === "ok" ? S.intel.cal.data : null;
    var G = SR.teamGames(cal ? cal.days : null, cal ? cal.byeOf : null, C.week);
    return function (it) { return it.key ? SR.rankOf(pool, p.id, it.key, { group: group, G: G, raw: it.raw }) : null; };
  }
  function rankCell(rk) {
    if (!rk || rk.text === DASH) return '<td class="n rk mu"' + (rk && rk.why ? ' title="' + esc(rk.why) + '"' : "") + ">" + DASH + "</td>";
    return '<td class="n rk' + (rk.text === "…" ? " mu" : "") + '"' + (rk.why ? ' title="' + esc(rk.why) + '"' : "") + ">" + esc(rk.text) + "</td>";
  }

  // ---------- the season rollup ----------
  // R8: drawn under the Breakdown's "Season stats" tab, so its heading names only the weeks. A rate whose denominator is recorded and zero (no
  // attempts) reads "—" (no rate); a figure that is not recorded reads "Not available". Neither is ever shown as 0.
  function rollupHtml(R, notes, ranker, pssKey) {
    if (!R) return "";
    if (!R.to) return '<div class="ex">No settled week has game stats yet.</div>';
    var out = '<div class="sec2">' + (R.to > 1 ? "Weeks 1" + ENDASH + R.to : "Week 1") + '</div><div class="card bdr"' + (pssKey ? ' data-pss="' + esc(pssKey) + '"' : "") + '><table><tr><th>Stat</th><th class="n">Season</th><th class="n rk">Rank</th></tr>';
    var why = {}, whyOrder = [];   // Rank details: each reason once, with the stats it applies to
    R.sections.forEach(function (sec) {
      out += '<tr class="bdh"><th colspan="3">' + esc(sec.h) + "</th></tr>";
      sec.items.forEach(function (it) {
        var part = it.value != null && it.of != null && it.n != null && it.n < it.of ? "<small>" + it.n + " of " + it.of + " games</small>" : "";
        var rk = it.value == null || !ranker ? null : ranker(it);
        if (rk && rk.text === DASH && rk.why) { if (!why[rk.why]) { why[rk.why] = []; whyOrder.push(rk.why); } why[rk.why].push(it.label); }
        out += "<tr><td>" + esc(it.label) + '</td><td class="n">' + (it.value == null ? '<span class="mu">' + (it.nodiv ? DASH : "Not available") + "</span>" : "<b>" + esc(it.value) + "</b>" + part) + "</td>" + rankCell(rk) + "</tr>";
      });
    });
    out += "</table></div>";
    if (whyOrder.length) out += '<details class="bdwhy"><summary>Rank details</summary><ul>' + whyOrder.map(function (w) { return "<li><b>" + esc(why[w].join(", ")) + ":</b> " + esc(w) + "</li>"; }).join("") + "</ul></details>";
    out += '<div class="ex">' + (R.games === 1 ? "1 game" : R.games + " games") + " with a stat line." + (notes.length ? " " + notes.map(esc).join(" ") : "") + "</div>";
    return out;
  }

  // ---------- one game's detail ----------
  var HOW = { row: "", between: " (between his games for this club)", current: " (his current club)", carried: " (his latest club)" };
  // R8: the game's identity in one compact line, Date · Matchup · Status ("Sun 11/15 · SEA @ LV · Final W 21–13"). The week is already on the row.
  // Date in Eastern Time; the matchup uses the club he played for THAT week (his own stat or snap row), never his current club unless it is the lineup
  // week; a completed game shows no kickoff time, an upcoming or live one keeps it.
  function identityLine(r) {
    var g = r.game, club = r.club ? F.commonCode(r.club) : "";
    if (r.bye) return "Bye week" + (club ? " · " + club : "");
    var date = g && g.kickoff ? BL.shortDate(g.kickoff) : "Date not available";
    if (!g) return date === "Date not available" ? (club ? club + " · Game not found in the schedule" : "Game not established") : date;
    var site = g.neutral ? " vs " : g.home === false ? " @ " : " vs ", matchup = (club || F.commonCode(g.club)) + site + F.commonCode(g.opp) + (g.neutral ? " (neutral site)" : "");
    var t = g.kickoff ? BL.timeET(g.kickoff) : "", status;
    if (g.status === "final") status = "Final " + resultText(g);
    else if (g.status === "live") status = "In progress" + (t ? " · kicked off " + t : "");
    else if (g.status === "scheduled") status = t || "Scheduled";
    else status = "Status unknown";
    return date + " · " + matchup + " · " + status;
  }
  function detailHtml(S, p, r, inp, boxRec) {
    var kv = [];
    function add(k, v) { kv.push("<b>" + esc(k) + "</b><span>" + v + "</span>"); }
    // the club line only when it adds something: how the club was established, or why it was not (a row of his own is shown in the matchup)
    if (!r.club || r.clubHow !== "row") add("Team that week", r.club ? esc(F.commonCode(r.club)) + esc(HOW[r.clubHow] || "") : r.clubHow === "conflict" ? "Records conflict" : r.clubHow === "history" ? "Known from team history (his club’s bye)" : "Not established");
    add("Participation", esc(r.part || "Not available"));
    add("MFL points", esc(ptsText(r)) + (r.rank ? " · " + esc(r.rank) + " that week" : "") + (r.newer ? " · not in the season figures yet" : ""));
    var haveStats = !!(boxRec && boxRec.state === "ok" && (r.box || r.snaps || r.rz)), stats = haveStats ? BL.detailStats(p.pos, r) : [];
    var g0 = BL.groupOf(p.pos);
    var out = '<div class="bdid">' + esc(identityLine(r)) + '</div><div class="kv mt6">' + kv.join("") + "</div>";
    if (stats.length) out += '<div class="kv bdk mt6">' + stats.map(function (s) { return "<b>" + esc(s[0]) + "</b><span>" + (s[1] == null ? '<span class="mu">' + DASH + "</span>" : esc(s[1])) + "</span>"; }).join("") + (g0.kind === "p" ? '<b>Blocked punts</b><span class="mu">Not available</span>' : "") + "</div>";
    else if (boxRec && boxRec.state === "ok") out += '<div class="ex mt6">' + (r.statsIn ? "No stat line for this game." : "Game stats for this week are not in yet.") + "</div>";
    var asof = [];
    if (boxRec && boxRec.state === "ok") asof.push("Game stats through Week " + (boxRec.data.through == null ? "unknown" : boxRec.data.through) + (S.recorded ? (S.recorded.box ? ", recorded " + S.recorded.box : "") : boxRec.at ? ", read " + F.etStamp(new Date(boxRec.at).toISOString()) : ""));   // recorded mode: the capture window, not the time the page served it
    asof.push("Points: MFL");
    if (g0.kind === "k") asof.push("Missed-kick distances are not in the stats feed");
    out += '<div class="ex mt6">' + esc(asof.join(". ")) + ".</div>";
    return out;
  }

  // ---------- the panel ----------
  // opts.summary === false leaves out the "Through Week N · points · scored games" line (for a call site whose card already shows those figures).
  // opts.rankLines: [label, value, reason] lines the Season stats tab shows first (Team > Performance's rank detail).
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
    // an unreadable score after W* is outside the season figures: its row shows "?" and the figures stand
    if (opts.summary !== false) out += '<div class="bdsum"><b>Through Week ' + C.week + "</b> · " + (nBad || nErr || nLoad ? '<span class="mu">' + (nLoad ? "points still loading" : "season points not shown") + "</span>" : esc(BL.f1(tot / 100)) + " pts · " + nsc + (nsc === 1 ? " scored game" : " scored games")) + "</div>";
    if (nBad && opts.summary !== false) out += '<div class="ex wn">' + (nBad === 1 ? "1 score" : nBad + " scores") + " could not be read, so his season figures are not shown.</div>";
    if (nErr) out += '<div class="ex wn">' + (nErr === 1 ? "1 week" : nErr + " weeks") + ' of scores could not be read and show n/a. <button class="link" data-act="retrylog">Try again</button></div>';
    // R8: Season stats | Game log, one at a time (Season stats by default). The choice lives in the same per-player Breakdown state as the
    // game-log view (S.bd.t[pid], beside S.bd.v[pid]); switching replaces the content below the control.
    var tab = st.t && st.t[pid] === "log" ? "log" : "season";
    out += '<div class="seg bdtab" role="group" aria-label="Breakdown section">' + [["season", "Season stats"], ["log", "Game log"]].map(function (x) { return '<button data-act="bdt" data-v="' + x[0] + '" data-pid="' + esc(pid) + '" aria-pressed="' + (tab === x[0]) + '">' + x[1] + "</button>"; }).join("") + "</div>";
    if (tab === "season") return out + seasonHtml(S, p, C, R, g, boxRec, opts) + "</div>";
    return out + logHtml(S, p, rs, inp, boxRec, views, v, st) + "</div>";
  }

  // The Season stats tab: the rank detail the card abbreviates (opts.rankLines: only lines that explain something), then the season table.
  function seasonHtml(S, p, C, R, g, boxRec, opts) {
    var pid = String(p.id), out = "", lines = opts.rankLines || [];
    if (lines.length) out += '<div class="kv">' + lines.map(function (d) { return "<b>" + esc(d[0]) + "</b><span>" + esc(d[1]) + (d[2] ? '<small class="mu">' + esc(d[2]) + "</small>" : "") + "</span>"; }).join("") + "</div>";
    // the game-stats read: one line when it is not there
    if (!boxRec || boxRec.state === "loading") return out + '<div class="ex">Loading game stats…</div>';
    if (boxRec.state === "absent") return out + '<div class="ex">Game stats aren’t in this recording; the game log shows fantasy points only.</div>';
    if (boxRec.state === "error") return out + '<div class="ex wn">Game stats didn’t load' + (boxRec.error ? " (" + esc(boxRec.error) + ")" : "") + '. <button class="link" data-act="retrybox" data-pid="' + esc(pid) + '">Try again</button></div>';
    var notes = [];
    if (boxRec.data.through != null && boxRec.data.through < C.week) notes.push("Game stats are in through Week " + boxRec.data.through + ".");
    if (g.kind === "k") notes.push("Missed-kick distances are not in the stats feed.");
    var sg = SR ? SR.groupOf(p.pos) : "";
    return out + rollupHtml(R, notes, statRanker(S, p, C, R), sg ? statKey(S, C, sg) : "");
  }

  // The Fantasy view's columns after the pinned Game column, through ONE function so a column can be swapped in one place (R8 seam: the
  // integrator replaces Result with the opponent-matchup column; the NFL result stays in each game's detail line). [{ head, cell(r) }]
  // R8 item 10: the opponent matchup column ("Opp vs QB: 24th", lib/oppctx.js) replaces Result ONLY when a supported matchup source is loaded
  // (S.intel.opp: { state: "ok", index } built by oppctx.build from a weekly points-against answer). Without one (this recording has none: no
  // game-day club per scorer per week), the log keeps its Result column and nothing is invented; the NFL result is also in each game's detail.
  function oppColumn(S, p) {
    var o = S && S.intel && S.intel.opp;
    if (!OC || !o || o.state !== "ok" || !o.index) return null;
    var grp = OC.group(p.pos);
    if (!grp) return null;
    return { head: '<th title="Opponent: UPS fantasy points allowed per game to this position, before this game (1 = fewest)">' + esc("Opp vs " + (OC.label ? OC.label(grp) : grp)) + "</th>",
      cell: function (r) {
        if (r.bye || !r.game) return "<td>" + DASH + "</td>";
        var k = OC.rankFor(o.index, { pos: p.pos, oppClub: r.game.opp, week: r.week });
        return k && k.state === "ok" ? "<td>" + esc(OC.ordinal(k.rank)) + "</td>" : '<td class="mu">' + DASH + "</td>";
      } };
  }
  function fantasyColumns(S, p) {
    var opp = S && p ? oppColumn(S, p) : null;
    var cols = [
      { head: '<th class="n">Pts</th>', cell: function (r) { var ps = ptsText(r); return '<td class="n">' + (r.ptsKind === "score" ? "<b>" + esc(ps) + "</b>" : '<span class="mu"' + (r.ptsKind === "unreadable" ? ' title="This score could not be read"' : "") + ">" + esc(ps) + "</span>") + "</td>"; } },
      { head: '<th class="n" title="Rank among players at his position that week (exact only)">Rank</th>', cell: function (r) { return cell(r.rank || null); } },
      { head: "<th>Result</th>", cell: function (r) {
        var res = r.bye ? "Bye" : resultText(r.game), pt = partShort(r);
        if (r.newer && !r.bye && r.ptsKind === "score") res = (res ? res + " · " : "") + "not in season figures";
        return "<td>" + esc(res || DASH) + (pt && pt !== "Bye" ? "<small>" + esc(pt) + "</small>" : "") + "</td>";
      } }
    ];
    if (opp) cols[2] = opp;   // the matchup column replaces Result; the result stays in the game's detail line
    return cols;
  }

  // The Game log tab: the view control (Fantasy / Stats / Usage / Red zone, or the position's alternatives), the weekly table, each game's detail.
  function logHtml(S, p, rs, inp, boxRec, views, v, st) {
    var pid = String(p.id), out = "";
    if (views.length > 1) out += '<div class="seg' + (views.length === 4 ? " seg4" : "") + '" role="group" aria-label="Game log view">' + views.map(function (x) { return '<button data-act="bdv" data-v="' + x[0] + '" data-pid="' + esc(pid) + '" aria-pressed="' + (v === x[0]) + '">' + x[1] + "</button>"; }).join("") + "</div>";
    var fan = v === "fan" ? fantasyColumns(S, p) : null, cols = fan ? [] : BL.columns(p.pos, v);
    var heads = fan ? fan.map(function (c) { return c.head; }) : cols.map(function (c) { return '<th class="n" title="' + esc(c.t) + '">' + esc(c.h) + "</th>"; });
    var ncol = heads.length + 1, openW = st.g[pid];
    out += '<div class="bdw"><table class="bdt"><thead><tr><th class="pin">Game</th>' + heads.join("") + "</tr></thead><tbody>";
    var drew = false;
    rs.slice().reverse().forEach(function (r) {
      if (r.newer && r.ptsKind !== "score" && !r.game && !r.box && !r.bye) return;   // a newer week with nothing to show yet is left out
      drew = true;
      // R8 (item 4): a verified bye (his club's bye from the schedule, or team history) has no game to detail: plain text, no control, no detail row.
      // A week whose club is unknown is not a verified bye and keeps its detail control.
      var open = !r.bye && openW === r.week, cls = (r.newer ? "newer" : "") + (open ? " open" : "") + (r.bye ? " bye" : "");
      var row = '<tr class="' + cls.trim() + '"><th class="pin">' + (r.bye ? '<span class="pinx" data-week="' + r.week + '">' + pinHtml(r) + "</span>" :
        '<button data-act="bdg" data-v="' + r.week + '" data-pid="' + esc(pid) + '" aria-expanded="' + open + '" aria-label="Week ' + r.week + ' game details">' + pinHtml(r) + "</button>") + "</th>";
      // a missing value is "—" in the cell (never 0); Help explains it once
      row += fan ? fan.map(function (c) { return c.cell(r); }).join("") : cols.map(function (c) { return cell(r.box || r.rz || r.snaps ? c.get(r) : null); }).join("");
      row += "</tr>";
      if (open) row += '<tr class="bdd"><td colspan="' + ncol + '"><div class="bdin">' + detailHtml(S, p, r, inp, boxRec) + "</div></td></tr>";
      out += row;
    });
    out += "</tbody></table></div>";
    if (!drew) out += '<div class="ex">No games yet.</div>';
    return out;
  }

  return { panel: panel, cutoffOf: cutoffOf, inputFor: inputFor, statKey: statKey, statRanker: statRanker, rollupHtml: rollupHtml, fantasyColumns: fantasyColumns, identityLine: identityLine };
});
