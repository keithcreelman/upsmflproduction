/* League → Draft view.
 *
 * Mobile mirror of the Rookie Draft results + available pool. Data
 * sources:
 *   - /api/mfl-export?TYPE=draftResults — pick list with player IDs as
 *     they're made (player="" until drafted).
 *   - state.players (TYPE=players DETAILS=1) — rookie filter via
 *     draft_year === current year.
 *
 * Three sub-views (toggle at top): "Picks" (chronological), "Drafted by
 * Team", and "Available" (rookie pool with simple position filter).
 *
 * Mobile only displays current-year draft (per Keith — no historical).
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  var view = { mode: "picks", posFilter: "ALL", teamFilter: "ALL" };
  var POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var POS_GROUP = { DT: "DL", DE: "DL", LB: "LB", CB: "DB", S: "DB" };

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      return ((parts[1] || "").trim() + " " + (parts[0] || "").trim()).trim();
    }
    return raw;
  }
  function franchiseName(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Team " + fid);
  }

  // Extract pick list from the draftResults export. Returns an array of
  //   { round, pick, overall, franchise_id, player_id, ts, comments }
  function buildPicks() {
    var dr = M.state.draftResults;
    if (!dr || !dr.draftResults) return [];
    var root = dr.draftResults;
    var units = U.asArray(root.draftUnit);
    var picks = [];
    units.forEach(function (u) {
      U.asArray(u && u.draftPick).forEach(function (p) {
        var round = parseInt(p.round, 10) || 0;
        var pickInRound = parseInt(p.pick, 10) || 0;
        picks.push({
          round: round,
          pick: pickInRound,
          overall: (round - 1) * 12 + pickInRound,
          franchise_id: U.pad4(p.franchise),
          player_id: U.safeStr(p.player),
          ts: U.safeStr(p.timestamp),
          comments: U.safeStr(p.comments)
        });
      });
    });
    picks.sort(function (a, b) { return a.overall - b.overall; });
    return picks;
  }

  function buildRookiePool() {
    var year = U.safeStr(M.state.ctx.year);
    var players = (M.state.players && M.state.players.players) || null;
    if (!players) return [];
    return U.asArray(players.player).filter(function (p) {
      return p && U.safeStr(p.draft_year) === year;
    });
  }

  // ---------- Sub-views ----------
  function renderToolbar() {
    function btn(mode, label) {
      return '<button class="ups-m-sort-btn' + (view.mode === mode ? " on" : "") +
        '" data-mode="' + mode + '">' + label + '</button>';
    }
    return '<div class="ups-m-players-toolbar" style="top:calc(var(--hdr-h) + var(--safe-top));">' +
      '<div class="ups-m-sort-row">' +
        btn("picks", "Picks") +
        btn("teams", "By Team") +
        btn("available", "Available") +
      '</div>' +
      (view.mode === "available"
        ? '<div class="ups-m-pos-chips" style="margin-top:8px">' +
          POSITIONS.map(function (p) {
            return '<button class="ups-m-pos-chip' + (view.posFilter === p ? " on" : "") +
              '" data-pos="' + p + '">' + (p === "ALL" ? "All" : p) + '</button>';
          }).join("") +
        '</div>'
        : '') +
    '</div>';
  }

  function renderPickRow(pick) {
    var player = pick.player_id ? M.data.playerById(pick.player_id) : null;
    var pName = player ? nameFor(player) : "";
    var pPos = player ? U.safeStr(player.position).toUpperCase() : "";
    var pTeam = player ? U.safeStr(player.team) : "";
    var pickLabel = pick.round + "." + (pick.pick < 10 ? "0" : "") + pick.pick;
    var hasPlayer = !!pick.player_id;
    return '<div class="ups-m-draft-pick' + (hasPlayer ? " filled" : "") + '" data-pid="' + U.escapeHtml(pick.player_id) + '">' +
      '<div class="pick">' + pickLabel + '</div>' +
      '<div class="body">' +
        '<div class="franchise">' + U.escapeHtml(franchiseName(pick.franchise_id)) + '</div>' +
        (hasPlayer
          ? '<div class="player">' + U.escapeHtml(pName) +
              (pPos ? ' <span class="muted">· ' + U.escapeHtml(pPos) + '</span>' : '') +
              (pTeam ? ' <span class="muted">· ' + U.escapeHtml(pTeam) + '</span>' : '') +
            '</div>'
          : '<div class="player muted">— on the clock —</div>') +
      '</div>' +
    '</div>';
  }

  function renderPicksList(picks) {
    if (!picks.length) {
      return '<div class="ups-m-stub"><div>No draft picks loaded yet for ' + U.escapeHtml(M.state.ctx.year) + '.</div></div>';
    }
    var byRound = {};
    picks.forEach(function (p) {
      var r = p.round || 0;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(p);
    });
    var rounds = Object.keys(byRound).map(Number).sort(function (a, b) { return a - b; });
    var made = picks.filter(function (p) { return p.player_id; }).length;
    var html = '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">' +
      '<strong>' + made + ' / ' + picks.length + '</strong> picks made' +
      '</div></div>';
    rounds.forEach(function (r) {
      html += '<div class="ups-m-pos-group">Round ' + r + '</div>';
      byRound[r].forEach(function (p) { html += renderPickRow(p); });
    });
    return html;
  }

  function renderByTeam(picks) {
    if (!picks.length) {
      return '<div class="ups-m-stub"><div>No draft picks yet.</div></div>';
    }
    var byFid = {};
    picks.forEach(function (p) {
      var fid = p.franchise_id;
      if (!byFid[fid]) byFid[fid] = [];
      byFid[fid].push(p);
    });
    var fids = Object.keys(byFid).sort(function (a, b) {
      return franchiseName(a).localeCompare(franchiseName(b));
    });
    var html = "";
    fids.forEach(function (fid) {
      var teamPicks = byFid[fid].sort(function (a, b) { return a.overall - b.overall; });
      var made = teamPicks.filter(function (p) { return p.player_id; }).length;
      html += '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(franchiseName(fid)) +
        '  <span class="muted">· ' + made + '/' + teamPicks.length + '</span>' +
        '</div>';
      teamPicks.forEach(function (p) { html += renderPickRow(p); });
      html += '</div>';
    });
    return html;
  }

  function renderAvailable(picks, rookies) {
    var draftedPids = new Set();
    picks.forEach(function (p) { if (p.player_id) draftedPids.add(String(p.player_id)); });
    var available = rookies.filter(function (r) { return !draftedPids.has(String(r.id)); });

    if (view.posFilter !== "ALL") {
      available = available.filter(function (r) {
        var pos = U.safeStr(r.position).toUpperCase();
        var group = POS_GROUP[pos] || pos;
        return group === view.posFilter;
      });
    }
    // Group by position then by NFL draft slot
    available.sort(function (a, b) {
      var posA = U.safeStr(a.position);
      var posB = U.safeStr(b.position);
      if (posA !== posB) return posA.localeCompare(posB);
      var roundA = parseInt(a.draft_round || 99, 10);
      var roundB = parseInt(b.draft_round || 99, 10);
      if (roundA !== roundB) return roundA - roundB;
      return parseInt(a.draft_pick || 99, 10) - parseInt(b.draft_pick || 99, 10);
    });
    if (!available.length) {
      return '<div class="ups-m-stub"><div>No available ' +
        (view.posFilter === "ALL" ? "" : view.posFilter + " ") +
        'rookies remaining.</div></div>';
    }
    var byPos = {};
    available.forEach(function (r) {
      var pos = U.safeStr(r.position).toUpperCase() || "?";
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push(r);
    });
    var positions = Object.keys(byPos).sort();
    var html = '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">' +
      '<strong>' + available.length + '</strong> rookies available' +
      (view.posFilter === "ALL" ? "" : ' · ' + U.escapeHtml(view.posFilter) + ' filter') +
      '</div></div>';
    positions.forEach(function (pos) {
      html += '<div class="ups-m-pos-group">' + U.escapeHtml(pos) + ' · ' + byPos[pos].length + '</div>';
      byPos[pos].forEach(function (r) {
        var nflInfo = "";
        if (r.draft_round) nflInfo += "NFL R" + r.draft_round;
        if (r.draft_pick) nflInfo += (nflInfo ? "." + r.draft_pick : "P" + r.draft_pick);
        if (r.draft_team) nflInfo += (nflInfo ? " · " : "") + r.draft_team;
        html += '<div class="ups-m-player-row" data-pid="' + U.escapeHtml(r.id) + '">' +
          '<div class="pos">' + U.escapeHtml(pos) + '</div>' +
          '<div class="body">' +
            '<div class="name">' + U.escapeHtml(nameFor(r)) + '</div>' +
            '<div class="sub">' +
              (r.college ? '<span>' + U.escapeHtml(r.college) + '</span>' : '') +
              (nflInfo ? '<span>' + U.escapeHtml(nflInfo) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      });
    });
    return html;
  }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#league/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("rosters", "Rosters", "rosters") +
      tab("standings", "Standings", "standings") +
      tab("otb", "On the Block", "otb") +
      tab("draft", "Draft", "draft") +
      '</div>';
  }

  function bind(mount) {
    var modeBtns = mount.querySelectorAll(".ups-m-sort-btn[data-mode]");
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener("click", function () {
        view.mode = this.getAttribute("data-mode");
        M.route.renderRoute();
      });
    }
    var posBtns = mount.querySelectorAll(".ups-m-pos-chip[data-pos]");
    for (var j = 0; j < posBtns.length; j++) {
      posBtns[j].addEventListener("click", function () {
        view.posFilter = this.getAttribute("data-pos");
        M.route.renderRoute();
      });
    }
    // Tap any player row → open the slim player sheet.
    var rows = mount.querySelectorAll("[data-pid]");
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function render(mount) {
    var picks = buildPicks();
    var rookies = buildRookiePool();
    var body;
    if (view.mode === "teams") body = renderByTeam(picks);
    else if (view.mode === "available") body = renderAvailable(picks, rookies);
    else body = renderPicksList(picks);
    mount.innerHTML = subTabs("draft") + renderToolbar() + body;
    bind(mount);
  }

  M.draftView = { render: render };
})();
