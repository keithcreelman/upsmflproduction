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
      tab("rosters", "Rosters", "rosters") +
      tab("standings", "Standings", "standings") +
      tab("otb", "On the Block", "otb") +
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
  function loadStandings() {
    if (state.standings || state.standingsLoading) return;
    state.standingsLoading = true;
    fetch(API.workerUrl("/api/standings?year=" + encodeURIComponent(M.state.ctx.year)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (resp) {
        state.standings = resp || { rows: [] };
      }).catch(function () {
        state.standings = { rows: [], error: "fetch failed" };
      }).then(function () {
        state.standingsLoading = false;
        renderRoute();
      });
  }

  function renderStandings(mount) {
    if (!state.standings) {
      loadStandings();
      mount.innerHTML = subTabs("standings") +
        '<div class="ups-m-loading">Loading standings…</div>';
      return;
    }
    var rows = (state.standings.rows || []).slice();
    if (!rows.length) {
      mount.innerHTML = subTabs("standings") +
        '<div class="ups-m-stub"><div>No standings data yet for ' + U.escapeHtml(M.state.ctx.year) + '.</div></div>';
      return;
    }
    // Group by division
    var byDiv = {};
    rows.forEach(function (r) {
      var key = r.division_name || ("Div " + (r.division != null ? r.division : "?"));
      if (!byDiv[key]) byDiv[key] = [];
      byDiv[key].push(r);
    });
    function fmtPct(v) {
      var n = Number(v || 0);
      if (!isFinite(n)) return ".000";
      return n.toFixed(3).replace(/^0\./, ".");
    }
    function fmtPts(v) {
      var n = Number(v || 0);
      return isFinite(n) ? n.toFixed(1) : "—";
    }
    function divisionTable(divName, divRows) {
      divRows.sort(function (a, b) {
        var d = Number(b.h2h_pct || 0) - Number(a.h2h_pct || 0);
        if (d !== 0) return d;
        return Number(b.pf || 0) - Number(a.pf || 0);
      });
      var trs = divRows.map(function (r) {
        var name = U.safeStr(r.franchise_name) || ("F" + r.franchise_id);
        return '<tr>' +
          '<td class="team">' + U.escapeHtml(name) + '</td>' +
          '<td>' + (r.h2h_w || 0) + '-' + (r.h2h_l || 0) + (r.h2h_t ? "-" + r.h2h_t : "") + '</td>' +
          '<td>' + fmtPct(r.h2h_pct) + '</td>' +
          '<td>' + fmtPts(r.pf) + '</td>' +
          '<td>' + fmtPts(r.pa) + '</td>' +
        '</tr>';
      }).join("");
      return '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(divName) + '</div>' +
        '<table class="ups-m-standings-table">' +
          '<thead><tr><th class="team">Team</th><th>W-L</th><th>Pct</th><th>PF</th><th>PA</th></tr></thead>' +
          '<tbody>' + trs + '</tbody>' +
        '</table>' +
      '</div>';
    }
    // Overall seed table — sort by div_w then h2h_pct then pf
    rows.sort(function (a, b) {
      // 1) division leaders first
      var aLead = a._isDivLeader ? 0 : 1;
      var bLead = b._isDivLeader ? 0 : 1;
      if (aLead !== bLead) return aLead - bLead;
      var d = Number(b.h2h_pct || 0) - Number(a.h2h_pct || 0);
      if (d !== 0) return d;
      return Number(b.pf || 0) - Number(a.pf || 0);
    });
    var seedTrs = rows.map(function (r, i) {
      var name = U.safeStr(r.franchise_name) || ("F" + r.franchise_id);
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="team">' + U.escapeHtml(name) + '</td>' +
        '<td>' + (r.h2h_w || 0) + '-' + (r.h2h_l || 0) + (r.h2h_t ? "-" + r.h2h_t : "") + '</td>' +
        '<td>' + fmtPts(r.pf) + '</td>' +
      '</tr>';
    }).join("");

    var html = subTabs("standings");
    Object.keys(byDiv).sort().forEach(function (d) {
      html += divisionTable(d, byDiv[d]);
    });
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Overall · Projected seed</div>' +
      '<table class="ups-m-standings-table">' +
        '<thead><tr><th>#</th><th class="team">Team</th><th>W-L</th><th>PF</th></tr></thead>' +
        '<tbody>' + seedTrs + '</tbody>' +
      '</table>' +
    '</div>';
    mount.innerHTML = html;
  }

  // ---------- On the Block sub-view ----------
  function renderOtb(mount) {
    var tb = M.state.tradeBait;
    var entries = [];
    if (tb && (tb.tradeBait || tb.franchise || tb)) {
      var root = tb.tradeBait || tb;
      var raw = U.asArray(root.franchise || root.tradeBait || []);
      raw.forEach(function (e) {
        if (!e) return;
        var fid = U.pad4(e.franchise_id || e.id || "");
        var ids = U.safeStr(e.willGiveUp || e.will_give_up || "");
        var pids = ids.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var lookingFor = U.safeStr(e.willTake || e.willTakeText || e.WILL_TAKE_TEXT || "");
        if (!pids.length) return;
        entries.push({ fid: fid, pids: pids, lookingFor: lookingFor });
      });
    }

    if (!entries.length) {
      mount.innerHTML = subTabs("otb") +
        '<div class="ups-m-stub"><div>No players on the block league-wide right now.</div></div>';
      return;
    }

    // Group by franchise
    entries.sort(function (a, b) { return a.fid.localeCompare(b.fid); });
    var html = subTabs("otb");
    entries.forEach(function (e) {
      html += '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(franchiseName(e.fid)) + '</div>';
      if (e.lookingFor) {
        html += '<div class="ups-m-otb-lookingfor"><span class="lbl">Wants:</span> ' +
          U.escapeHtml(e.lookingFor) + '</div>';
      }
      e.pids.forEach(function (pid) {
        var p = DATA.playerById(pid);
        var name = nameFor(p) || ("Player " + pid);
        var pos = U.safeStr(p && p.position).toUpperCase();
        var team = U.safeStr(p && p.team);
        html += '<button class="ups-m-otb-row" data-pid="' + U.escapeHtml(pid) + '">' +
          '<div class="body">' +
            '<div class="name">' + U.escapeHtml(name) + '</div>' +
            '<div class="sub">' +
              (pos ? '<span>' + U.escapeHtml(pos) + '</span>' : '') +
              (team ? '<span>' + U.escapeHtml(team) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</button>';
      });
      html += '</div>';
    });
    mount.innerHTML = html;
    var rows = mount.querySelectorAll(".ups-m-otb-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function renderRoute() { M.route.renderRoute(); }

  function render(mount, subParts) {
    var sub = (subParts && subParts[0]) || "rosters";
    if (sub === "standings") return renderStandings(mount);
    if (sub === "otb") return renderOtb(mount);
    return renderRosters(mount);
  }

  M.route.registerView("league", render);
})();
