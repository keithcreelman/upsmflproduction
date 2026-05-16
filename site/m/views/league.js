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

  function renderRosters(mount) {
    if (!state.selectedFid) {
      state.selectedFid = M.state.viewerFranchiseId || ((M.state.franchises || [])[0] || {}).id;
    }
    mount.innerHTML = subTabs("rosters") + renderFranchiseDropdown() + renderRosterCards(state.selectedFid);
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
        var isPlayer = token.indexOf("DP_") !== 0 && token.indexOf("FP_") !== 0 && token.indexOf("BB_") !== 0;
        var label = DATA.describeTradeBaitToken(token);
        if (isPlayer) {
          var p = DATA.playerById(token);
          var pos = U.safeStr(p && p.position).toUpperCase();
          var team = U.safeStr(p && p.team);
          html += '<button class="ups-m-otb-row" data-pid="' + U.escapeHtml(token) + '">' +
            '<div class="body">' +
              '<div class="name">' + U.escapeHtml(label) + '</div>' +
              '<div class="sub">' +
                (pos ? '<span>' + U.escapeHtml(pos) + '</span>' : '') +
                (team ? '<span>' + U.escapeHtml(team) + '</span>' : '') +
              '</div>' +
            '</div>' +
          '</button>';
        } else {
          // Draft pick or BB$ — not tappable
          html += '<div class="ups-m-otb-row" style="cursor:default;-webkit-tap-highlight-color:transparent">' +
            '<div class="body">' +
              '<div class="name">' + U.escapeHtml(label) + '</div>' +
              '<div class="sub"><span>Pick / BB</span></div>' +
            '</div>' +
          '</div>';
        }
      });
      html += '</div>';
    });
    mount.innerHTML = html;
    var rows = mount.querySelectorAll(".ups-m-otb-row[data-pid]");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
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
