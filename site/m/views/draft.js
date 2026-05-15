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
    // Prefer rookie_prospects_<year>.json (Rookie Draft Hub source) with
    // consensus_rank. Falls back to MFL player export when prospects file
    // isn't loaded yet.
    var prospects = (M.data.getRookieProspects && M.data.getRookieProspects()) || [];
    if (prospects.length) {
      // Normalize prospect fields to the shape downstream renderers expect.
      return prospects.map(function (pr) {
        return {
          id: pr.player_id,
          name: pr.name,
          position: pr.position,
          team: pr.nfl_team,
          college: pr.college,
          draft_round: pr.nfl_draft_round,
          draft_pick: pr.nfl_draft_pick_in_round,
          draft_team: pr.nfl_draft_team,
          consensus_rank: pr.consensus_rank,
          consensus_n_sources: pr.consensus_n_sources,
          rookie_adp: pr.rookie_adp,
          rookie_adp_rank: pr.rookie_adp_rank,
          age: pr.age,
          height: pr.height,
          _prospect: true
        };
      });
    }
    var year = U.safeStr(M.state.ctx.year);
    var players = (M.state.players && M.state.players.players) || null;
    if (!players) return [];
    return U.asArray(players.player).filter(function (p) {
      return p && U.safeStr(p.draft_year) === year;
    });
  }

  function onClockPick(picks) {
    if (!picks || !picks.length) return null;
    for (var i = 0; i < picks.length; i++) {
      if (!picks[i].player_id) return picks[i];
    }
    return null;
  }
  // "Live" means at least one pick has been made + an empty pick still on
  // the clock. (No picks made → draft hasn't started.)
  function liveOnClockPick(picks) {
    if (!picks || !picks.length) return null;
    var anyMade = picks.some(function (p) { return p.player_id; });
    var onClock = onClockPick(picks);
    return (anyMade && onClock) ? onClock : null;
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
    // Sort by consensus_rank when available (from rookie_prospects JSON),
    // otherwise fall back to NFL draft slot.
    available.sort(function (a, b) {
      var ar = Number(a.consensus_rank || 0);
      var br = Number(b.consensus_rank || 0);
      if (ar > 0 && br > 0) return ar - br;
      if (ar > 0) return -1;
      if (br > 0) return 1;
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

    // Pick gating: button only renders for the viewer's own pick when the
    // draft is live (≥1 made + an empty pick still on the clock).
    var onClock = liveOnClockPick(picks);
    var viewerFid = M.state.viewerFranchiseId;
    var viewerOnClock = !!(onClock && onClock.franchise_id === viewerFid);
    var clockLabel = onClock ? onClock.round + "." + (onClock.pick < 10 ? "0" : "") + onClock.pick : "";

    var html = '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">' +
      '<strong>' + available.length + '</strong> rookies available' +
      (view.posFilter === "ALL" ? "" : ' · ' + U.escapeHtml(view.posFilter) + ' filter') +
      '</div>';
    if (viewerOnClock) {
      html += '<div class="ups-m-draft-clock you">' +
        '<strong>You\'re on the clock</strong> · pick ' + U.escapeHtml(clockLabel) +
        '</div>';
    } else if (onClock) {
      html += '<div class="ups-m-draft-clock">' +
        'On the clock: ' + U.escapeHtml(franchiseName(onClock.franchise_id)) +
        ' · pick ' + U.escapeHtml(clockLabel) +
        '</div>';
    }
    html += '</div>';

    available.forEach(function (r) {
      var pos = U.safeStr(r.position).toUpperCase() || "?";
      var nflInfo = "";
      if (r.draft_round) nflInfo += "NFL R" + r.draft_round;
      if (r.draft_pick) nflInfo += (nflInfo ? "." + r.draft_pick : "P" + r.draft_pick);
      if (r.draft_team) nflInfo += (nflInfo ? " · " : "") + r.draft_team;
      var rankBadge = r.consensus_rank > 0
        ? '<span class="ups-m-rank-badge">#' + r.consensus_rank + '</span>'
        : '';
      var pickBtn = viewerOnClock
        ? '<button class="ups-m-tag-btn tag" data-pick-pid="' + U.escapeHtml(r.id) + '">Pick</button>'
        : '';
      html += '<div class="ups-m-player-row" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="pos">' + U.escapeHtml(pos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + rankBadge + U.escapeHtml(nameFor(r)) + '</div>' +
          '<div class="sub">' +
            (r.college ? '<span>' + U.escapeHtml(r.college) + '</span>' : '') +
            (nflInfo ? '<span>' + U.escapeHtml(nflInfo) + '</span>' : '') +
            (r.age ? '<span>Age ' + (Math.round(r.age * 10) / 10) + '</span>' : '') +
          '</div>' +
        '</div>' +
        (pickBtn ? '<div class="right">' + pickBtn + '</div>' : '') +
      '</div>';
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
    // Pick button — intercept BEFORE the row click handler.
    var pickBtns = mount.querySelectorAll("[data-pick-pid]");
    for (var p = 0; p < pickBtns.length; p++) {
      pickBtns[p].addEventListener("click", function (e) {
        e.stopPropagation();
        var pid = this.getAttribute("data-pick-pid");
        if (pid) confirmAndSubmitPick(pid);
      });
    }
    // Tap any player row → open the slim player sheet.
    var rows = mount.querySelectorAll("[data-pid]");
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener("click", function (e) {
        if (e.target.closest("button[data-pick-pid]")) return;
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function confirmAndSubmitPick(pid) {
    var picks = buildPicks();
    var onClock = liveOnClockPick(picks);
    if (!onClock) {
      M.ui.showToast("Draft isn't live or no pick is on the clock.", "err");
      return;
    }
    if (onClock.franchise_id !== M.state.viewerFranchiseId) {
      M.ui.showToast("Not your pick — " + franchiseName(onClock.franchise_id) + " is on the clock.", "err");
      return;
    }
    var rookies = buildRookiePool();
    var player = rookies.filter(function (r) { return String(r.id) === String(pid); })[0];
    var name = player ? nameFor(player) : "Player " + pid;
    var pos = player ? U.safeStr(player.position) : "";
    var clockLabel = onClock.round + "." + (onClock.pick < 10 ? "0" : "") + onClock.pick;
    if (!window.confirm(
      "Draft " + name + (pos ? " (" + pos + ")" : "") + " with pick " + clockLabel + "?\n\n" +
      "This writes to MFL and posts to Discord. Cannot be undone from the app."
    )) return;

    M.ui.showToast("Drafting…", "info");
    fetch(M.api.workerUrl("/api/pick"), {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        franchise_id: M.state.viewerFranchiseId,
        player_id: pid,
        simulate: false
      })
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    }).then(function (resp) {
      if (resp.ok) {
        M.ui.showToast(name + " drafted ✓", "ok");
        return M.actions.reloadData().then(function () { M.route.renderRoute(); });
      }
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      M.ui.showToast("Pick failed: " + err, "err");
    }).catch(function (err) {
      M.ui.showToast("Pick failed: " + (err && err.message || err), "err");
    });
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
