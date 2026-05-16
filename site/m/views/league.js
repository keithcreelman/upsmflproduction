/* League view — three sub-tabs:
   - Rosters: franchise dropdown, view any team's roster cards (read-only)
   - Standings: current season W-L, PF, PA, div+seed (from /api/standings)
   - On the Block: league-wide trade-bait list with notes
   Current-season only per the mobile plan (no historical league data). */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;
  var API = M.api;

  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  var POS_GROUP_FOR = {
    QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN",
    DT: "DL", DE: "DL", LB: "LB", CB: "DB", S: "DB"
  };
  var state = {
    selectedFid: null,
    standings: null,
    standingsLoading: false
  };

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
    var f = (M.state.franchises || []).find(function (x) { return x.id === fid; });
    return f ? f.name : "Franchise " + fid;
  }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') +
             '" href="#league/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("standings", "Standings", "standings") +
      tab("rosters", "Rosters", "rosters") +
      tab("trade", "Trade", "trade") +
      tab("otb", "On the Block", "otb") +
      tab("draft", "Draft", "draft") +
      '</div>';
  }

  // ---------- Rosters sub-view ----------
  function renderFranchiseDropdown() {
    var opts = (M.state.franchises || []).map(function (f) {
      var sel = f.id === state.selectedFid ? " selected" : "";
      return '<option value="' + U.escapeHtml(f.id) + '"' + sel + '>' +
        U.escapeHtml(f.name) + '</option>';
    }).join("");
    return '<div class="ups-m-league-pick">' +
      '<label>Team</label>' +
      '<select id="ups-m-league-fid">' + opts + '</select>' +
    '</div>';
  }

  function renderRosterCards(fid) {
    var rows = DATA.getRosterFor(fid);
    if (!rows.length) {
      return '<div class="ups-m-stub"><div>No roster data.</div></div>';
    }
    var byPos = {};
    rows.forEach(function (r) {
      var p = DATA.playerById(r.id);
      var rawPos = U.safeStr(p && p.position).toUpperCase();
      var group = POS_GROUP_FOR[rawPos] || rawPos || "Other";
      if (!byPos[group]) byPos[group] = [];
      byPos[group].push({ row: r, player: p, pos: rawPos });
    });
    var seen = {};
    var ordered = [];
    POS_ORDER.forEach(function (p) { if (byPos[p]) { ordered.push(p); seen[p] = true; } });
    Object.keys(byPos).sort().forEach(function (p) { if (!seen[p]) ordered.push(p); });

    var html = '<div class="ups-m-player-list">';
    ordered.forEach(function (group) {
      var list = byPos[group].slice().sort(function (a, b) {
        return Number(b.row.salary || 0) - Number(a.row.salary || 0);
      });
      html += '<div class="ups-m-pos-group">' + U.escapeHtml(group) + ' · ' + list.length + '</div>';
      list.forEach(function (entry) {
        var r = entry.row;
        var name = nameFor(entry.player) || ("Player " + r.id);
        var team = U.safeStr(entry.player && entry.player.team);
        var cy = U.safeStr(r.contractYear);
        var cyLabel = cy === "0" ? "expired" : (cy ? cy + "yr" : "—");
        html += '<div class="ups-m-player-row" data-pid="' + U.escapeHtml(r.id) + '">' +
          '<div class="pos">' + U.escapeHtml(entry.pos || group) + '</div>' +
          '<div class="body">' +
            '<div class="name">' + U.escapeHtml(name) + '</div>' +
            '<div class="sub">' + (team ? '<span>' + U.escapeHtml(team) + '</span>' : '') + '</div>' +
          '</div>' +
          '<div class="right">' +
            '<div class="salary">' + U.fmtUsd(r.salary) + '</div>' +
            '<div class="cy">' + U.escapeHtml(cyLabel) + '</div>' +
          '</div>' +
        '</div>';
      });
    });
    html += '</div>';
    return html;
  }

  // Two views for the Rosters tab:
  //   "summary" — league-wide cap summary, one row per team
  //   "team"    — individual roster detail (existing)
  state.rostersMode = state.rostersMode || "summary";

  function renderRostersModeToggle() {
    var modes = [
      { key: "summary", label: "Salary Summary" },
      { key: "team", label: "Team Detail" }
    ];
    return '<div class="ups-m-segctl">' + modes.map(function (m) {
      return '<button class="ups-m-segctl-btn' + (state.rostersMode === m.key ? " on" : "") +
        '" data-mode="' + m.key + '">' + m.label + '</button>';
    }).join("") + '</div>';
  }

  // League-wide salary summary — one row per franchise. Numbers come from
  // the verbatim Front Office cap mirror (DATA.computeCap), so the values
  // match the cap card on each team's own Contracts page exactly.
  function renderSalarySummary() {
    var franchises = (M.state.franchises || []).slice();
    var rows = franchises.map(function (f) {
      var cap = DATA.computeCap(f.id) || {};
      return {
        fid: f.id,
        name: f.name,
        capTotal: cap.capTotal || 0,
        capRoom: cap.capRoom || 0,
        capAmount: cap.capAmount || 0,
        pct: cap.pct || 0,
        rosterCount: cap.rosterCount || 0,
        activeCount: cap.activeCount || 0,
        irCount: cap.irCount || 0,
        taxiCount: cap.taxiCount || 0,
        adjustmentTotal: cap.adjustmentTotal || 0
      };
    });
    // Sort: viewer first, then by cap used descending so over-cap teams
    // float to the top.
    var viewerFid = M.state.viewerFranchiseId;
    rows.sort(function (a, b) {
      if (a.fid === viewerFid && b.fid !== viewerFid) return -1;
      if (b.fid === viewerFid && a.fid !== viewerFid) return 1;
      return b.capTotal - a.capTotal;
    });

    if (!rows.length) {
      return '<div class="ups-m-stub"><div>No franchise data.</div></div>';
    }

    var html = '<div class="ups-m-salsum">' +
      '<div class="ups-m-salsum-head">' +
        '<div class="team">Team</div>' +
        '<div class="num">Used</div>' +
        '<div class="num">Room</div>' +
        '<div class="num">%</div>' +
        '<div class="num">Ros</div>' +
      '</div>';
    rows.forEach(function (r) {
      var overCap = r.capRoom < 0;
      var roomClass = overCap ? "danger" : (r.pct >= 95 ? "warn" : "ok");
      var isMe = r.fid === viewerFid;
      html += '<div class="ups-m-salsum-row' + (isMe ? " me" : "") + '" data-fid="' + U.escapeHtml(r.fid) + '">' +
        '<div class="team">' + U.escapeHtml(r.name) +
          (r.irCount ? ' <span class="tag ir">' + r.irCount + ' IR</span>' : '') +
          (r.taxiCount ? ' <span class="tag tx">' + r.taxiCount + ' TX</span>' : '') +
          (r.adjustmentTotal ? ' <span class="tag adj">Adj ' + (r.adjustmentTotal > 0 ? "+" : "−") +
            U.fmtUsd(Math.abs(r.adjustmentTotal)) + '</span>' : '') +
        '</div>' +
        '<div class="num">' + U.fmtUsd(r.capTotal) + '</div>' +
        '<div class="num ' + roomClass + '">' + U.fmtUsd(r.capRoom) + '</div>' +
        '<div class="num">' + r.pct + '%</div>' +
        '<div class="num">' + r.activeCount + '/' + r.rosterCount + '</div>' +
      '</div>';
    });
    html += '</div>' +
      '<div class="ups-m-salsum-foot">' +
        'Cap ceiling ' + U.fmtUsd(rows[0].capAmount) + ' · tap a team to view their roster' +
      '</div>';
    return html;
  }

  function renderRosters(mount) {
    if (!state.selectedFid) {
      state.selectedFid = M.state.viewerFranchiseId || ((M.state.franchises || [])[0] || {}).id;
    }
    var body = state.rostersMode === "summary"
      ? renderSalarySummary()
      : (renderFranchiseDropdown() + renderRosterCards(state.selectedFid));
    mount.innerHTML = subTabs("rosters") + renderRostersModeToggle() + body;
    // Mode toggle
    var modeBtns = mount.querySelectorAll(".ups-m-segctl-btn");
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener("click", function () {
        state.rostersMode = this.getAttribute("data-mode");
        renderRoute();
      });
    }
    if (state.rostersMode === "summary") {
      // Tap a salary-summary row → drill into that team's detail view.
      var sumRows = mount.querySelectorAll(".ups-m-salsum-row[data-fid]");
      for (var j = 0; j < sumRows.length; j++) {
        sumRows[j].addEventListener("click", function () {
          state.selectedFid = U.pad4(this.getAttribute("data-fid"));
          state.rostersMode = "team";
          renderRoute();
        });
      }
      return;
    }
    var sel = document.getElementById("ups-m-league-fid");
    if (sel) sel.addEventListener("change", function (e) {
      state.selectedFid = U.pad4(e.target.value);
      renderRoute();
    });
    var rows = mount.querySelectorAll(".ups-m-player-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  // ---------- Standings sub-view ----------
  // Multi-year standings — mirrors the desktop Standings Module's "final
  // finish" table. Cached per year on view.state.standingsByYear so
  // switching years doesn't refetch.
  state.standingsByYear = state.standingsByYear || {};
  state.standingsYear = state.standingsYear || null;

  function loadStandingsForYear(year) {
    var y = String(year);
    if (state.standingsByYear[y] || (state.standingsLoading === y)) return Promise.resolve();
    state.standingsLoading = y;
    return fetch(API.workerUrl("/api/standings?year=" + encodeURIComponent(y)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (resp) { state.standingsByYear[y] = resp || { rows: [] }; })
      .catch(function () { state.standingsByYear[y] = { rows: [], error: "fetch failed" }; })
      .then(function () { state.standingsLoading = null; renderRoute(); });
  }

  function availableYears() {
    var cur = parseInt(M.state.ctx.year, 10) || (new Date().getUTCFullYear());
    // UPS league started in 2012 per memory. Show every year through current.
    var out = [];
    for (var y = cur; y >= 2012; y--) out.push(y);
    return out;
  }

  function fmtPct(v) {
    var n = Number(v || 0);
    if (!isFinite(n)) return ".000";
    return n.toFixed(3).replace(/^0\./, ".");
  }
  function fmtPts(v) {
    var n = Number(v || 0);
    return isFinite(n) ? n.toFixed(1) : "—";
  }
  function isDivWinner(row) {
    // Several flag aliases — be defensive.
    return !!(row && (row._isDivLeader || row.is_div_winner ||
              row.division_winner || row.divisional_winner));
  }

  function renderStandings(mount) {
    var year = state.standingsYear || M.state.ctx.year;
    var y = String(year);
    if (!state.standingsByYear[y]) {
      loadStandingsForYear(year);
      mount.innerHTML = subTabs("standings") +
        renderYearPicker(year) +
        '<div class="ups-m-loading">Loading standings…</div>';
      bindYearPicker(mount);
      return;
    }
    var rows = (state.standingsByYear[y].rows || []).slice();
    if (!rows.length) {
      mount.innerHTML = subTabs("standings") +
        renderYearPicker(year) +
        '<div class="ups-m-stub"><div>No standings data for ' + U.escapeHtml(y) + '.</div></div>';
      bindYearPicker(mount);
      return;
    }

    // Sort: division winners first by h2h%, then everyone else by h2h%
    // → pf. Mirrors desktop's final-finish ordering.
    rows.sort(function (a, b) {
      var aw = isDivWinner(a) ? 0 : 1;
      var bw = isDivWinner(b) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      var d = Number(b.h2h_pct || 0) - Number(a.h2h_pct || 0);
      if (d !== 0) return d;
      return Number(b.pf || 0) - Number(a.pf || 0);
    });

    var trs = rows.map(function (r, i) {
      var name = U.safeStr(r.franchise_name) || ("F" + r.franchise_id);
      var winner = isDivWinner(r);
      return '<tr' + (winner ? ' class="div-winner"' : '') + '>' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="team">' + (winner ? '<span class="div-crown" title="Division Winner">👑</span> ' : '') + U.escapeHtml(name) + '</td>' +
        '<td>' + (r.h2h_w || 0) + '-' + (r.h2h_l || 0) + (r.h2h_t ? "-" + r.h2h_t : "") + '</td>' +
        '<td>' + fmtPct(r.h2h_pct) + '</td>' +
        '<td>' + fmtPct(r.allplay_pct) + '</td>' +
        '<td>' + fmtPts(r.pf) + '</td>' +
      '</tr>';
    }).join("");

    var html = subTabs("standings") +
      renderYearPicker(year) +
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(y) + ' · Final Standings</div>' +
        '<table class="ups-m-standings-table">' +
          '<thead><tr><th>#</th><th class="team">Team</th><th>W-L</th><th>H2H%</th><th>AP%</th><th>PF</th></tr></thead>' +
          '<tbody>' + trs + '</tbody>' +
        '</table>' +
        '<div class="ups-m-standings-legend">👑 division winner · AP% = All-Play %</div>' +
      '</div>';
    mount.innerHTML = html;
    bindYearPicker(mount);
  }

  function renderYearPicker(currentYear) {
    var years = availableYears();
    var opts = years.map(function (y) {
      return '<option value="' + y + '"' + (String(y) === String(currentYear) ? " selected" : "") + '>' + y + '</option>';
    }).join("");
    return '<div class="ups-m-league-pick">' +
      '<label>Season</label>' +
      '<select id="ups-m-standings-year">' + opts + '</select>' +
    '</div>';
  }
  function bindYearPicker(mount) {
    var sel = mount.querySelector("#ups-m-standings-year");
    if (sel) sel.addEventListener("change", function (e) {
      state.standingsYear = e.target.value;
      renderRoute();
    });
  }

  // ---------- On the Block sub-view ----------
  function renderOtb(mount) {
    // Parsing delegated to DATA.tradeBaitEntries (handles the canonical
    // tradeBaits.tradeBait shape + inExchangeFor field).
    var raw = (DATA.tradeBaitEntries && DATA.tradeBaitEntries()) || [];
    var entries = [];
    raw.forEach(function (e) {
      if (!e) return;
      var fid = U.pad4(e.franchise_id || e.id || "");
      var csv = U.safeStr(e.willGiveUp || e.will_give_up || "");
      var tokens = csv.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var lookingFor = U.safeStr(e.inExchangeFor || e.willTake || e.willTakeText || e.WILL_TAKE_TEXT || "");
      if (!tokens.length) return;
      entries.push({ fid: fid, tokens: tokens, lookingFor: lookingFor });
    });

    if (!entries.length) {
      mount.innerHTML = subTabs("otb") +
        '<div class="ups-m-stub"><div>No players on the block league-wide right now.</div></div>';
      return;
    }

    // Group by franchise (already grouped by export shape, but enforce
    // a stable visual order: viewer's team first, then alpha).
    var viewerFid = M.state.viewerFranchiseId;
    entries.sort(function (a, b) {
      if (a.fid === viewerFid && b.fid !== viewerFid) return -1;
      if (b.fid === viewerFid && a.fid !== viewerFid) return 1;
      return franchiseName(a.fid).localeCompare(franchiseName(b.fid));
    });

    var html = subTabs("otb");
    entries.forEach(function (e) {
      html += '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(franchiseName(e.fid)) + '</div>';
      if (e.lookingFor) {
        html += '<div class="ups-m-otb-lookingfor"><span class="lbl">Wants:</span> ' +
          U.escapeHtml(e.lookingFor) + '</div>';
      }
      e.tokens.forEach(function (token) {
        // Keith 2026-05-16 — drop DP_/FP_/BB_ tokens entirely. Picks and
        // blind-bid dollars in trade bait are noise: the player rows are
        // the actionable items; pick clutter just makes the list longer.
        var isPlayer = token.indexOf("DP_") !== 0 && token.indexOf("FP_") !== 0 && token.indexOf("BB_") !== 0;
        if (!isPlayer) return;
        var label = DATA.describeTradeBaitToken(token);
        var p = DATA.playerById(token);
        var pos = U.safeStr(p && p.position).toUpperCase();
        var team = U.safeStr(p && p.team);
        // Click → open Trade War Room with this player pre-set on the
        // OTHER team's side (keith 2026-05-15). data-fid carries the
        // OTB-posting franchise so the URL builder can pin twb_right_team.
        html += '<button class="ups-m-otb-row" data-pid="' + U.escapeHtml(token) +
          '" data-fid="' + U.escapeHtml(e.fid) + '">' +
          '<div class="body">' +
            '<div class="name">' + U.escapeHtml(label) + '</div>' +
            '<div class="sub">' +
              (pos ? '<span>' + U.escapeHtml(pos) + '</span>' : '') +
              (team ? '<span>' + U.escapeHtml(team) + '</span>' : '') +
              '<span class="muted">tap to trade →</span>' +
            '</div>' +
          '</div>' +
        '</button>';
      });
      html += '</div>';
    });
    mount.innerHTML = html;
    var rows = mount.querySelectorAll(".ups-m-otb-row[data-pid]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        var partnerFid = this.getAttribute("data-fid");
        if (!pid) return;
        // Build the desktop Trade War Room URL with the player + partner
        // pre-selected on the right side. Matches buildTradeModuleUrl in
        // site/rosters/roster_workbench.js:7245.
        var viewerFid = U.pad4(M.state.viewerFranchiseId || "");
        var ctx = M.state.ctx;
        var base = "https://www48.myfantasyleague.com/" +
          encodeURIComponent(ctx.year) + "/home/" +
          encodeURIComponent(ctx.leagueId);
        var qs = "MODULE=MESSAGE6%3DN";
        var hashParams = [
          "twb_player_id=" + encodeURIComponent(pid),
          "twb_team_id=" + encodeURIComponent(U.pad4(partnerFid))
        ];
        if (viewerFid) hashParams.push("twb_left_team=" + encodeURIComponent(viewerFid));
        if (partnerFid) {
          hashParams.push("twb_right_team=" + encodeURIComponent(U.pad4(partnerFid)));
          hashParams.push("twb_side=partner");
        }
        var url = base + "?" + qs + "#" + hashParams.join("&");
        window.open(url, "_blank");
      });
    }
  }

  function renderRoute() { M.route.renderRoute(); }

  function render(mount, subParts) {
    var sub = (subParts && subParts[0]) || "standings";
    if (sub === "rosters") return renderRosters(mount);
    if (sub === "otb") return renderOtb(mount);
    if (sub === "trade" && M.tradeView && M.tradeView.render) {
      return M.tradeView.render(mount);
    }
    if (sub === "draft" && M.draftView && M.draftView.render) {
      return M.draftView.render(mount);
    }
    return renderStandings(mount);
  }

  M.route.registerView("league", render);
})();
