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
  function fmtSignedLuck(v) {
    if (v == null || isNaN(v)) return "—";
    var n = Number(v);
    return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(3).replace(/^0\./, ".");
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

  // open(fid, opts) — opts: { row (an /api/standings row), raceRow
  // (UPS_STANDINGS_RACE.race(...).byFranchise[fid]), year, trigger (the
  // element that was tapped, for focus-restore on close) }
  function open(fid, opts) {
    var mount = ensureMount();
    if (!mount) return;
    opts = opts || {};
    var row = opts.row || {};
    var rr = opts.raceRow || {};
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

    body.innerHTML =
      '<div class="ups-m-card">' +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv"><div class="lbl">Overall</div><div class="val">' + rec(row.h2h_w, row.h2h_l, row.h2h_t) + ' (' + fmtPct(row.h2h_pct) + ')</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">All-Play</div><div class="val">' + rec(row.allplay_w, row.allplay_l, row.allplay_t) + ' (' + fmtPct(row.allplay_pct) + ')</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Luck</div><div class="val">' + fmtSignedLuck(rr.luck) + '</div></div>' +
          '<div class="ups-m-cap-kv"><div class="lbl">Expected wins</div><div class="val">' + (rr.expectedWins == null ? "—" : rr.expectedWins.toFixed(1)) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="ups-m-card">' + whySeedHtml(rr.whySeed) + '</div>' +
      '<div class="ups-m-card">' + gameLogHtml(rr.gameLog) + '</div>' +
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
