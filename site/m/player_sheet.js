/* Mobile player sheet — slim bottom-sheet view of a player.
   Independent of site/shared/player_profile_master.js (per plan: do not
   touch the regular site). Loads /api/player-bundle for season stats. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;

  var U = window.UPS_MOBILE.util;
  var API = window.UPS_MOBILE.api;
  var DATA = window.UPS_MOBILE.data;

  var bundleCache = {};

  function ensureMount() {
    var mount = document.getElementById("ups-m-sheet-mount");
    if (!mount) return null;
    if (!mount.firstChild) {
      mount.innerHTML =
        '<div class="ups-m-sheet-overlay" id="ups-m-sheet-overlay">' +
        '  <div class="ups-m-sheet" id="ups-m-sheet" role="dialog" aria-modal="true" aria-label="Player details">' +
        '    <button class="ups-m-sheet-close" id="ups-m-sheet-close" aria-label="Close">×</button>' +
        '    <div class="ups-m-sheet-grip"></div>' +
        '    <div class="ups-m-sheet-head" id="ups-m-sheet-head"></div>' +
        '    <div class="ups-m-sheet-body" id="ups-m-sheet-body"></div>' +
        '    <div class="ups-m-sheet-foot"><button class="btn" id="ups-m-sheet-foot-close">Close</button></div>' +
        '  </div>' +
        '</div>';
      var overlay = document.getElementById("ups-m-sheet-overlay");
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) close();
      });
      document.getElementById("ups-m-sheet-close").addEventListener("click", close);
      document.getElementById("ups-m-sheet-foot-close").addEventListener("click", close);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && overlay.classList.contains("open")) close();
      });
    }
    return mount;
  }

  function close() {
    var overlay = document.getElementById("ups-m-sheet-overlay");
    if (overlay) overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  function fmtPlayerName(raw) {
    // MFL stores names as "Lastname, Firstname [Suffix]".
    var s = U.safeStr(raw);
    if (!s) return "";
    if (s.indexOf(",") >= 0) {
      var parts = s.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return s;
  }

  function rowContractBlock(rosterRow) {
    if (!rosterRow) return '';
    var salary = U.fmtUsd(rosterRow.salary);
    var cy = U.safeStr(rosterRow.contractYear);
    var status = U.safeStr(rosterRow.contractStatus);
    var info = U.safeStr(rosterRow.contractInfo);
    var live = U.safeStr(rosterRow.status);
    var yrsRem = (cy && Number(cy) > 0) ? cy + " yr" + (cy === "1" ? "" : "s") + " left" :
                 (cy === "0" ? "Expired" : "—");
    return '' +
      '<div class="ups-m-sheet-block">' +
        '<h4>Contract</h4>' +
        '<div class="ups-m-sheet-kv">' +
          '<div class="lbl">Salary</div><div class="val">' + U.escapeHtml(salary) + '</div>' +
          '<div class="lbl">Years left</div><div class="val">' + U.escapeHtml(yrsRem) + '</div>' +
          (status ? '<div class="lbl">Type</div><div class="val">' + U.escapeHtml(status) + '</div>' : '') +
          (live ? '<div class="lbl">Status</div><div class="val">' + U.escapeHtml(live) + '</div>' : '') +
          (info ? '<div class="lbl">Notes</div><div class="val">' + U.escapeHtml(info) + '</div>' : '') +
        '</div>' +
      '</div>';
  }

  function findRosterRowAcrossLeague(pid) {
    // Search every franchise's roster for this pid. Returns { row, fid } or null.
    var s = window.UPS_MOBILE.state;
    if (!s.rosters || !s.rosters.rosters) return null;
    var fr = U.asArray(s.rosters.rosters.franchise);
    for (var i = 0; i < fr.length; i++) {
      var players = U.asArray(fr[i].player);
      for (var j = 0; j < players.length; j++) {
        if (String(players[j].id) === String(pid)) {
          return {
            fid: U.pad4(fr[i].id),
            row: {
              id: String(players[j].id),
              status: U.safeStr(players[j].status),
              salary: Number(players[j].salary || 0),
              contractYear: U.safeStr(players[j].contractYear),
              contractStatus: U.safeStr(players[j].contractStatus),
              contractInfo: U.safeStr(players[j].contractInfo)
            }
          };
        }
      }
    }
    return null;
  }

  function renderStatsBlock(profile) {
    // playerProfile.seasons.season is an array of season summaries with
    // games + total fantasy points + ppg.
    if (!profile) return '<div class="ups-m-sheet-empty">No season stats available.</div>';
    var pp = profile.playerProfile || {};
    var seasons = U.asArray(pp.seasons && pp.seasons.season);
    if (!seasons.length) return '<div class="ups-m-sheet-empty">No season stats available.</div>';
    // Take the most recent N seasons, sort descending by year.
    seasons = seasons.slice().sort(function (a, b) {
      return Number(b.year || b.season || 0) - Number(a.year || a.season || 0);
    }).slice(0, 6);
    var rows = seasons.map(function (s) {
      var yr = U.safeStr(s.year || s.season);
      var gm = Number(s.games || s.gamesPlayed || 0);
      var pts = Number(s.fantasyPoints || s.points || s.total || 0);
      var ppg = gm > 0 ? (pts / gm) : 0;
      return '<tr>' +
        '<td>' + U.escapeHtml(yr) + '</td>' +
        '<td>' + (gm || 0) + '</td>' +
        '<td>' + (Math.round(pts * 10) / 10).toFixed(1) + '</td>' +
        '<td>' + (Math.round(ppg * 10) / 10).toFixed(1) + '</td>' +
        '</tr>';
    }).join("");
    return '' +
      '<table class="ups-m-stat-table">' +
        '<thead><tr><th>Year</th><th>G</th><th>Pts</th><th>PPG</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  function loadBundle(pid) {
    if (bundleCache[pid]) return Promise.resolve(bundleCache[pid]);
    return fetch(API.workerUrl("/api/player-bundle?pid=" + encodeURIComponent(pid)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { if (b) bundleCache[pid] = b; return b; })
      .catch(function () { return null; });
  }

  function open(pid, opts) {
    opts = opts || {};
    ensureMount();
    var overlay = document.getElementById("ups-m-sheet-overlay");
    var head = document.getElementById("ups-m-sheet-head");
    var body = document.getElementById("ups-m-sheet-body");
    if (!overlay || !head || !body) return;

    overlay.classList.add("open");
    document.body.style.overflow = "hidden";

    var player = DATA.playerById(pid);
    var name = fmtPlayerName(player && player.name);
    var pos = U.safeStr(player && player.position);
    var team = U.safeStr(player && player.team);

    head.innerHTML =
      '<div class="name">' + (U.escapeHtml(name) || ('Player ' + U.escapeHtml(pid))) + '</div>' +
      '<div class="sub">' + U.escapeHtml(pos) + (team ? ' · ' + U.escapeHtml(team) : '') + '</div>';

    var rosterRow = opts.rosterRow || (findRosterRowAcrossLeague(pid) || {}).row || null;
    body.innerHTML =
      rowContractBlock(rosterRow) +
      '<div class="ups-m-sheet-block">' +
        '<h4>Season Stats</h4>' +
        '<div id="ups-m-sheet-stats"><div class="ups-m-sheet-loading">Loading…</div></div>' +
      '</div>';

    loadBundle(pid).then(function (bundle) {
      var slot = document.getElementById("ups-m-sheet-stats");
      if (!slot) return;
      slot.innerHTML = renderStatsBlock(bundle && bundle.profile);
    });
  }

  window.UPS_MOBILE.sheet = {
    open: open,
    close: close
  };
})();
