/* My Team → Contracts view.
   Cap card mirrors team_operations.js:670-708 numbers exactly. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;

  var POS_ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "DEF", "TMQB", "TMRB", "TMWR", "TMTE", "TMPK"];

  function posClass(pos) {
    var p = (pos || "").toUpperCase();
    if (p === "QB") return "qb";
    if (p === "RB") return "rb";
    if (p === "WR") return "wr";
    if (p === "TE") return "te";
    if (p === "PK") return "pk";
    if (p === "DEF" || p === "DEFENSE") return "def";
    if (p === "DL" || p === "DE" || p === "DT") return "dl";
    if (p === "LB" || p === "ILB" || p === "OLB") return "lb";
    if (p === "DB" || p === "CB" || p === "S" || p === "SAF") return "db";
    return "";
  }

  function nameFor(player) {
    var raw = U.safeStr(player && player.name);
    if (!raw) return "";
    if (raw.indexOf(",") >= 0) {
      var parts = raw.split(",");
      var last = (parts[0] || "").trim();
      var rest = (parts[1] || "").trim();
      return rest ? rest + " " + last : last;
    }
    return raw;
  }

  function statusBadges(rosterRow, otbIds) {
    var out = [];
    var cy = parseInt(rosterRow.contractYear, 10);
    var status = U.safeStr(rosterRow.status);
    var contractStatus = U.safeStr(rosterRow.contractStatus);
    if (cy === 0) out.push('<span class="badge exp">Expired</span>');
    if (/taxi/i.test(status)) out.push('<span class="badge tx">Taxi</span>');
    if (/ir|injured/i.test(status)) out.push('<span class="badge ir">IR</span>');
    if (otbIds && otbIds.has(String(rosterRow.id))) out.push('<span class="badge otb">On Block</span>');
    if (cy === 1) out.push('<span class="badge ext">Ext Eligible</span>');
    if (contractStatus) out.push('<span class="badge">' + U.escapeHtml(contractStatus) + '</span>');
    return out.join(" ");
  }

  function renderCapCard(cap) {
    var pct = cap.pct;
    var overCap = cap.capRoom < 0;
    var capRoomClass = overCap ? "danger" : (pct >= 95 ? "warn" : "ok");
    var adjLine = "";
    if (cap.adjustmentTotal !== 0) {
      var sign = cap.adjustmentTotal > 0 ? "+" : "−";
      adjLine = '<span class="chip">Adj ' + sign + U.fmtUsd(Math.abs(cap.adjustmentTotal)) + '</span>';
    }
    return '' +
      '<div class="ups-m-cap-card">' +
        '<div class="ups-m-cap-grid">' +
          '<div class="ups-m-cap-kv">' +
            '<div class="lbl">Cap Used</div>' +
            '<div class="val">' + U.fmtUsd(cap.capTotal) + '</div>' +
          '</div>' +
          '<div class="ups-m-cap-kv">' +
            '<div class="lbl">Cap Room</div>' +
            '<div class="val ' + capRoomClass + '">' + U.fmtUsd(cap.capRoom) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ups-m-cap-bar"><div class="ups-m-cap-bar-fill ' + (overCap ? "over" : "") + '" style="width:' + pct + '%"></div></div>' +
        '<div class="ups-m-cap-foot">' +
          '<span class="chip">' + pct + '% used</span>' +
          '<span class="chip">Cap ' + U.fmtUsd(cap.capAmount) + '</span>' +
          '<span class="chip">' + cap.rosterCount + ' roster · ' + cap.activeCount + ' active</span>' +
          (cap.irCount ? '<span class="chip">' + cap.irCount + ' IR · ' + U.fmtUsd(cap.irSalaryFull) + ' @50%</span>' : '') +
          (cap.taxiCount ? '<span class="chip">' + cap.taxiCount + ' Taxi · ' + U.fmtUsd(cap.taxiSalary) + ' off-cap</span>' : '') +
          adjLine +
        '</div>' +
      '</div>';
  }

  function renderRoster(rosterRows) {
    if (!rosterRows.length) return '<div class="ups-m-stub"><div>No roster found.</div></div>';
    var otbIds = DATA.getMyTradeBaitIds();
    // Group by position using MFL players export
    var byPos = {};
    rosterRows.forEach(function (r) {
      var player = DATA.playerById(r.id);
      var pos = U.safeStr(player && player.position).toUpperCase() || "Other";
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({ row: r, player: player });
    });

    // Order positions per POS_ORDER, then any remaining alphabetically.
    var seen = {};
    var ordered = [];
    POS_ORDER.forEach(function (p) {
      if (byPos[p]) { ordered.push(p); seen[p] = true; }
    });
    Object.keys(byPos).sort().forEach(function (p) {
      if (!seen[p]) ordered.push(p);
    });

    // Parse contractInfo for CL / TCV (years remaining = cy directly).
    // Reuse the FO penalty mirror's helpers so the values match what the
    // desktop Roster Workbench renders.
    var FO_PENALTY = window.UPS_FRONT_OFFICE;
    function parseCT(infoStr) {
      var out = { cl: 0, tcv: 0 };
      var s = String(infoStr || "");
      var m = s.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
      if (m) out.cl = parseInt(m[1], 10) || 0;
      var mm = s.match(/(?:^|\|)\s*TCV\s+([^|]+)/i);
      if (mm) {
        var raw = String(mm[1]).trim().replace(/[$,]/g, "");
        var mult = /K$/i.test(raw) ? 1000 : (/M$/i.test(raw) ? 1000000 : 1);
        raw = raw.replace(/[KM]$/i, "");
        var n = Number(raw);
        if (isFinite(n)) out.tcv = Math.round(n * mult);
      }
      return out;
    }
    function nflLogoUrl(team) {
      var t = U.safeStr(team).toLowerCase();
      if (!t || t.length < 2 || t.length > 4) return "";
      // ESPN team logos — small and cached. Public CDN, CORS-friendly.
      return "https://a.espncdn.com/i/teamlogos/nfl/500/" + t + ".png";
    }

    var html = '<div class="ups-m-player-list">';
    ordered.forEach(function (pos) {
      var list = byPos[pos].slice().sort(function (a, b) {
        return Number(b.row.salary || 0) - Number(a.row.salary || 0);
      });
      html += '<div class="ups-m-pos-group">' + U.escapeHtml(pos) + ' · ' + list.length + '</div>';
      list.forEach(function (entry) {
        var r = entry.row;
        var p = entry.player;
        var name = nameFor(p) || ("Player " + r.id);
        var team = U.safeStr(p && p.team);
        var ct = parseCT(r.contractInfo);
        var cy = parseInt(r.contractYear, 10);
        var yr = isFinite(cy) ? cy : 0;
        var cl = ct.cl || yr;  // fall back to cy when CL token absent
        var tcv = ct.tcv;
        var typeRaw = U.safeStr(r.contractStatus);
        var logo = nflLogoUrl(team);
        var chips = [
          (cl ? '<span class="chip">CL ' + cl + '</span>' : ''),
          '<span class="chip">YR ' + (yr === 0 ? "exp" : yr) + '</span>',
          (tcv ? '<span class="chip">TCV ' + U.fmtUsd(tcv) + '</span>' : ''),
          (typeRaw ? '<span class="chip type">' + U.escapeHtml(typeRaw) + '</span>' : ''),
          statusBadges(r, otbIds)
        ].filter(Boolean).join(" ");
        html += '' +
          '<div class="ups-m-player-row rich" data-pid="' + U.escapeHtml(r.id) + '">' +
            '<div class="pos ' + posClass(pos) + '">' + U.escapeHtml(pos) + '</div>' +
            '<div class="body">' +
              '<div class="name">' +
                (logo ? '<img class="ups-m-nfl-logo" src="' + U.escapeHtml(logo) + '" alt="" onerror="this.style.display=\'none\'" />' : '') +
                U.escapeHtml(name) +
                (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') +
              '</div>' +
              '<div class="sub chips-row">' + chips + '</div>' +
            '</div>' +
            '<div class="right">' +
              '<div class="salary">' + U.fmtUsd(r.salary) + '</div>' +
            '</div>' +
          '</div>';
      });
    });
    html += '</div>';
    return html;
  }

  function subTabs(active) {
    function tab(href, label, key) {
      return '<a class="ups-m-subtab' + (key === active ? ' active' : '') + '" href="#myteam/' + href + '">' + label + '</a>';
    }
    return '<div class="ups-m-subtabs">' +
      tab("contracts", "Contracts", "contracts") +
      tab("lineup", "Lineup", "lineup") +
      tab("tagging", "Tagging", "tagging") +
      '</div>';
  }

  function renderContracts(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("contracts") +
        '<div class="ups-m-stub">' +
          '<h3>Sign in to MFL</h3>' +
          '<div>We couldn\'t resolve your franchise. Sign in on the desktop site first, then return here.</div>' +
        '</div>';
      return;
    }
    var cap = DATA.computeCap(fid);
    var roster = DATA.getRosterFor(fid);
    mount.innerHTML =
      subTabs("contracts") +
      renderCapCard(cap) +
      renderRoster(roster);
    bindRowClicks(mount);
  }

  function renderLineupStub(mount) {
    // Delegate to lineup.js (Phase 2). Falls back to a stub if the view
    // hasn't loaded yet (script-order safety).
    if (M.lineupView && M.lineupView.render) {
      M.lineupView.render(mount);
      return;
    }
    mount.innerHTML =
      subTabs("lineup") +
      '<div class="ups-m-stub">' +
        '<h3>Lineup editor</h3>' +
        '<div>Loading…</div>' +
      '</div>';
  }

  function bindRowClicks(scope) {
    var rows = scope.querySelectorAll(".ups-m-player-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var pid = this.getAttribute("data-pid");
        if (pid && M.sheet) M.sheet.open(pid);
      });
    }
  }

  function render(mount, subParts) {
    var sub = (subParts && subParts[0]) || "contracts";
    if (sub === "lineup") return renderLineupStub(mount);
    if (sub === "tagging" && M.taggingView && M.taggingView.render) {
      return M.taggingView.render(mount);
    }
    return renderContracts(mount);
  }

  M.route.registerView("myteam", render);
})();
