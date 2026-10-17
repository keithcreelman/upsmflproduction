/* Mobile team bottom sheet — Phase II-A4.
   Reuses the .ups-m-sheet overlay pattern (site/m/player_sheet.js) with
   its OWN mount/element ids so it doesn't collide with the player sheet
   (both can't be open at once in practice, but ids must stay unique).
   Pure view module: every value it renders is passed in by the caller
   (site/m/views/league.js), already computed via
   site/shared/standings_race.js — this file does no fetching of its own. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  var lastTrigger = null;

  function ensureMount() {
    var mount = document.getElementById("ups-m-team-sheet-mount");
    if (!mount) return null;
    if (!mount.firstChild) {
      mount.innerHTML =
        '<div class="ups-m-sheet-overlay" id="ups-m-team-sheet-overlay">' +
        '  <div class="ups-m-sheet" id="ups-m-team-sheet" role="dialog" aria-modal="true" aria-label="Team details">' +
        '    <button class="ups-m-sheet-close" id="ups-m-team-sheet-close" aria-label="Close">×</button>' +
        '    <div class="ups-m-sheet-head" id="ups-m-team-sheet-head"></div>' +
        '    <div class="ups-m-sheet-body" id="ups-m-team-sheet-body"></div>' +
        '    <div class="ups-m-sheet-foot" id="ups-m-team-sheet-foot"></div>' +
        '  </div>' +
        '</div>';
      var overlay = document.getElementById("ups-m-team-sheet-overlay");
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
      document.getElementById("ups-m-team-sheet-close").addEventListener("click", close);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && overlay.classList.contains("open")) close();
      });
    }
    return mount;
  }

  // Focus-restore: player_sheet.js (the pattern this is copied from) has
  // none — added fresh here since A4 explicitly requires it.
  function close() {
    var overlay = document.getElementById("ups-m-team-sheet-overlay");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
    if (lastTrigger && typeof lastTrigger.focus === "function") {
      try { lastTrigger.focus(); } catch (e) {}
    }
    lastTrigger = null;
  }

  function fmtPct(v) {
    var n = Number(v || 0);
    return isFinite(n) ? n.toFixed(3).replace(/^0\./, ".") : ".000";
  }
  function rec(w, l, t) { return (w || 0) + "-" + (l || 0) + (t ? "-" + t : ""); }

  function gameLogHtml(log) {
    if (log == null) return '<div class="ups-m-stub"><div>Weekly results couldn\u2019t be read.</div></div>';
    if (!log.length) return '<div class="ups-m-stub"><div>No games played yet.</div></div>';
    var rows = log.map(function (g) {
      return '<tr><td>' + g.week + (g.is_playoff ? ' <span class="tag">PO</span>' : '') + '</td>' +
        '<td class="team">' + U.escapeHtml(g.opponent_name) + '</td>' +
        '<td class="num">' + U.escapeHtml(g.result) + '</td></tr>';
    }).join("");
    return '<div class="ups-m-card-title">Week-by-week</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th>Wk</th><th class="team">Opp</th><th class="num">Result</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function whySeedHtml(why) {
    if (!why) return "";
    if (why.blocked) return '<div class="ups-m-card-title">Seed explanation</div><div class="ups-m-stub"><div>' + U.escapeHtml(why.reason) + '</div></div>';
    return '<div class="ups-m-card-title">Seed explanation</div><div class="sub">' + U.escapeHtml(why.text) + '</div>';
  }
  function divisionRaceHtml(dr) {
    if (!dr || !dr.length) return "";
    var rows = dr.map(function (d) {
      return '<tr><td class="team">' + (d.is_division_leader ? "👑 " : "") + U.escapeHtml(d.franchise_name) + '</td>' +
        '<td class="num">' + rec(d.overall.w, d.overall.l, d.overall.t) + '</td>' +
        '<td class="num">' + (d.ap_gb == null ? "—" : d.ap_gb.toFixed(1)) + '</td></tr>';
    }).join("");
    return '<div class="ups-m-card-title">Division race</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th class="team">Team</th><th class="num">Overall</th><th class="num">AP GB</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function pts(v) { var n = Number(v); return v == null || !isFinite(n) ? "—" : n.toFixed(1); }
  function signed(v, digits) {
    if (v == null || !isFinite(Number(v))) return "—";
    var n = Number(v);
    return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(digits == null ? 1 : digits);
  }
  function ordinalRank(n) {
    if (!n) return "—";
    var s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  // Scored = what the manager controls; Faced = the schedule drawn (never called "defense": in UPS, MFL's
  // Defense column is the points your IDP players score); Luck = record vs what the weekly scores earned.
  function scoredFacedHtml(sf, status) {
    if (!sf) {
      return '<div class="ups-m-card"><div class="ups-m-card-title">Scored · Faced · Luck</div><div class="ups-m-stub"><div>' +
        (status === "preseason" ? "No games played yet." : "Weekly results couldn\u2019t be verified, so these aren\u2019t shown.") + '</div></div></div>';
    }
    var s = sf.scored || {}, f = sf.faced || {}, o = sf.overall || {};
    var l3 = s.last3 || null;
    return '<div class="ups-m-card"><div class="ups-m-card-title">Scored <span class="sub">· what the manager controls</span></div>' +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv"><div class="lbl">Points For</div><div class="val">' + pts(s.pf) + ' <span class="sub">' + ordinalRank(s.pfRank) + '</span></div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Per week</div><div class="val">' + pts(s.pfPerWeek) + '</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Avg weekly rank</div><div class="val">' + (s.avgWeeklyRank == null ? "—" : Number(s.avgWeeklyRank).toFixed(1)) + '</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Best / worst week</div><div class="val">' + (s.highWeek ? "W" + s.highWeek.week + " " + pts(s.highWeek.score) : "—") + ' / ' + (s.lowWeek ? "W" + s.lowWeek.week + " " + pts(s.lowWeek.score) : "—") + '</div></div>' +
        '</div>' +
        (l3 ? '<div class="sub">Last 3 weeks: average rank ' + (l3.avgRank == null ? "—" : Number(l3.avgRank).toFixed(1)) + ', All-Play ' + rec(l3.ap && l3.ap.w, l3.ap && l3.ap.l, l3.ap && l3.ap.t) + '. Recent form describes what happened; it predicts the rest of the season less well than the full season does.</div>' : '') +
      '</div>' +
      '<div class="ups-m-card"><div class="ups-m-card-title">Faced <span class="sub">· schedule, not skill</span></div>' +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv"><div class="lbl">Opponents per game</div><div class="val">' + pts(f.paPerGame) + ' <span class="sub">' + (f.paRank ? ordinalRank(f.paRank) + " most" : "") + '</span></div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Opponents vs their usual</div><div class="val">' + signed(f.oppVsUsual) + '</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Close games (&lt;10)</div><div class="val">' + (f.closeGames ? rec(f.closeGames.w, f.closeGames.l, f.closeGames.t) : "—") + '</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Schedule luck</div><div class="val">' + signed(o.luck) + ' <span class="sub">wins</span></div></div>' +
        '</div>' +
        '<div class="sub">Luck = actual wins (' + (o.record ? rec(o.record.w, o.record.l, o.record.t) : "—") + ') minus expected wins (' + (o.expectedWins == null ? "—" : Number(o.expectedWins).toFixed(1)) + ': for each game, the share of the league you outscored that week). A positive number means the matchups helped.</div>' +
      '</div>';
  }
  function historyHtml(h, gameLog) {
    if (!h || h.status !== "ok" || !h.weeks || !h.weeks.length) return '<div class="ups-m-card">' + gameLogHtml(gameLog) + '</div>';
    var seedAfter = {};
    (h.seedByWeek || []).forEach(function (s) { seedAfter[s.week] = s; });
    var rows = h.weeks.map(function (w) {
      var res = (w.games || []).map(function (g) { return g.result; }).join("") || "—";
      var sa = seedAfter[w.week];
      return '<tr><td>' + (w.isPlayoff ? "P" : "") + w.week + '</td><td class="num">' + pts(w.score) + '</td><td class="num">' + (w.rank || "—") + '</td>' +
        '<td class="num">' + rec(w.ap && w.ap.w, w.ap && w.ap.l, w.ap && w.ap.t) + '</td><td class="num">' + U.escapeHtml(res) + '</td>' +
        '<td class="num">' + (sa ? (sa.seed ? sa.seed : (sa.orderIndex != null ? "(" + (sa.orderIndex + 1) + ")" : "—")) : "—") + '</td></tr>';
    }).join("");
    return '<div class="ups-m-card"><div class="ups-m-card-title">Week by week</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th>Wk</th><th class="num">Pts</th><th class="num">Rk</th><th class="num">Wk AP</th><th class="num">Games</th><th class="num">Seed</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="ups-m-standings-legend">Rk = scoring rank that week · Seed = seed after that week; (8) = 8th, outside the field</div></div>';
  }

  // open(fid, opts) — opts: { row (an /api/standings row), raceRow (UPS_STANDINGS_RACE.race(...).byFranchise[fid]),
  // scoredFaced (UPS_STANDINGS_RACE.scoredFaced(resp).byFranchise[fid]) + scoredFacedStatus, history
  // (UPS_STANDINGS_RACE.teamWeeklyHistory(resp, fid)), year, trigger (focus-restore on close), seasonState }
  function open(fid, opts) {
    var mount = ensureMount();
    if (!mount) return;
    opts = opts || {};
    var row = opts.row || {};
    var rr = opts.raceRow || {};
    var reg = row.regular_season || null;
    lastTrigger = opts.trigger || document.activeElement;

    var head = document.getElementById("ups-m-team-sheet-head");
    var body = document.getElementById("ups-m-team-sheet-body");
    var foot = document.getElementById("ups-m-team-sheet-foot");

    head.innerHTML =
      '<div class="ups-m-sheet-head-row">' +
        (row.logo ? '<img class="ups-m-sheet-photo" src="' + U.escapeHtml(row.logo) + '" alt="" onerror="this.style.display=\'none\'" />' : '') +
        '<div class="ups-m-sheet-head-text">' +
          '<div class="name">' + U.escapeHtml(row.franchise_name || ("Franchise " + fid)) + '</div>' +
          '<div class="sub">' + U.escapeHtml(row.owner_name || "") + (opts.year ? ' · ' + opts.year : '') + '</div>' +
        '</div>' +
      '</div>';

    var ap = reg ? reg.all_play : { w: row.allplay_w, l: row.allplay_l, t: row.allplay_t, pct: row.allplay_pct };
    var ovr = reg ? reg.record : { w: row.h2h_w, l: row.h2h_l, t: row.h2h_t, pct: row.h2h_pct };
    body.innerHTML =
      '<div class="ups-m-card">' + whySeedHtml(rr.whySeed) +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv"><div class="lbl">Record</div><div class="val">' + rec(ovr.w, ovr.l, ovr.t) + ' (' + fmtPct(ovr.pct) + ')</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">All-Play</div><div class="val">' + rec(ap.w, ap.l, ap.t) + ' (' + fmtPct(ap.pct) + ')</div></div>' +
        '</div>' +
      '</div>' +
      (opts.seasonState === "final" ? "" : scoredFacedHtml(opts.scoredFaced, opts.scoredFacedStatus)) +
      historyHtml(opts.history, rr.gameLog) +
      (rr.divisionRace && rr.divisionRace.length ? '<div class="ups-m-card">' + divisionRaceHtml(rr.divisionRace) + '</div>' : '');

    foot.innerHTML = '<button class="btn" id="ups-m-team-sheet-roster" type="button">View roster →</button>';
    var rosterBtn = document.getElementById("ups-m-team-sheet-roster");
    if (rosterBtn) rosterBtn.addEventListener("click", function () {
      close();
      if (M.leagueView && M.leagueView.presetRoster) M.leagueView.presetRoster(fid);
      M.route.navigate("#league/rosters");
    });

    document.getElementById("ups-m-team-sheet-overlay").classList.add("open");
    document.body.style.overflow = "hidden";
  }

  M.teamSheet = { open: open, close: close };
})();
