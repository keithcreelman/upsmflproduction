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

  function statusBadges(rosterRow, otbIds, fid) {
    // Contract-type badge (e.g. BL, Rookie) is already rendered as a
    // typed chip in the chips row, so we intentionally skip it here to
    // avoid the duplicate Keith called out (BL/BL, Rookie/Rookie).
    var out = [];
    // safeInt guards against null/undefined contractYear so the strict
    // === 0 / === 1 comparisons can't silently fail on NaN.
    var cy = U.safeInt(rosterRow.contractYear, -1);
    var status = U.safeStr(rosterRow.status);
    if (cy === 0) out.push('<span class="badge exp">Expired</span>');
    // Taxi badge with call-up counter (canon §B2 + tracker Q10).
    // Renders "Taxi · N/3" when N > 0; plain "Taxi" otherwise.
    var callup = DATA.taxiCallupsFor && DATA.taxiCallupsFor(rosterRow.id);
    var isTaxiNow = /taxi/i.test(status);
    // Taxi-eligibility (Keith 2026-05-18): show the call-up budget chip
    // on active-roster rookies who are still in the 3-year window so
    // owners can see how many call-ups remain. Match canon §A1 / §B2:
    // drafted R2-5, season - draft_year < 3.
    var taxiEligibleNow = false;
    if (!isTaxiNow && DATA.isTaxiEligibleFor) {
      taxiEligibleNow = !!DATA.isTaxiEligibleFor(rosterRow.id);
    }
    if (isTaxiNow || taxiEligibleNow) {
      var used = callup ? U.safeInt(callup.used, 0) : 0;
      var pending = callup ? U.safeInt(callup.pending, 0) : 0;
      var max = callup ? U.safeInt(callup.max, 3) || 3 : 3;
      if (isTaxiNow) {
        // Canon §B2 — always show the counter on taxi players (Keith
        // 2026-05-18) so the remaining budget is visible at a glance.
        var label = "Taxi · " + used + "/" + max;
        if (pending > 0) label += " + " + pending + " pending";
        out.push('<span class="badge tx">' + label + '</span>');
      } else if (taxiEligibleNow) {
        var eligLabel = "Taxi-Elig · " + used + "/" + max;
        if (pending > 0) eligLabel += " + " + pending + " pending";
        out.push('<span class="badge tx">' + eligLabel + '</span>');
      }
    }
    if (/ir|injured/i.test(status)) out.push('<span class="badge ir">IR</span>');
    if (otbIds && otbIds.has(String(rosterRow.id))) out.push('<span class="badge otb">On Block</span>');
    // "Ext Eligible" requires more than cy===1 — desktop's rosterContractEligibility
    // gates on tag status + "no further extensions" + rookie-option state, and
    // RULE-EXT-003 blocks the SAME UPS franchise from extending twice. Without
    // this gate, tagged players (Trevor Lawrence on LH) and already-extended-by-
    // current-owner players show false-positive eligibility badges.
    var FOA = window.UPS_FRONT_OFFICE_ACTIONS;
    if (FOA && FOA.extensionAvailableFor) {
      if (FOA.extensionAvailableFor(rosterRow, fid).ok) {
        out.push('<span class="badge ext">Ext Eligible</span>');
      }
    } else if (cy === 1) {
      // Fallback only if the actions mirror failed to load — shouldn't happen.
      out.push('<span class="badge ext">Ext Eligible</span>');
    }
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

  function renderRoster(rosterRows, fid) {
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
        var cy = U.safeInt(r.contractYear, 0);
        var yr = cy;
        var cl = ct.cl || yr;  // fall back to cy when CL token absent
        var tcv = ct.tcv;
        var typeRaw = U.safeStr(r.contractStatus);
        var logo = nflLogoUrl(team);
        // Skip YR chip when expired — the EXPIRED badge below already
        // conveys it, and "YR 0" is more useful than "YR exp" when
        // someone genuinely has 0 years remaining (the Keith call out).
        var chips = [
          (cl ? '<span class="chip">CL ' + cl + '</span>' : ''),
          (yr > 0 ? '<span class="chip">YR ' + yr + '</span>' : ''),
          (tcv ? '<span class="chip">TCV ' + U.fmtUsd(tcv) + '</span>' : ''),
          (typeRaw ? '<span class="chip type">' + U.escapeHtml(typeRaw) + '</span>' : ''),
          statusBadges(r, otbIds, fid)
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
      tab("taxi", "Taxi", "taxi") +
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
      renderRoster(roster, fid);
    bindRowClicks(mount);
  }

  // Taxi subtab — read-only listing of taxi-squad players. Per Keith
  // 2026-05-16, taxi rule changes are pending finalization; no mutating
  // actions (promote / cut) are wired up yet.
  //
  // SALARY DERIVATION (Keith 2026-05-16):
  // MFL nulls salary for taxi players in both rosters + salaries exports.
  // Per §A1.4 rookie salary is deterministic by UPS draft slot, so we
  // derive it via DATA.deriveTaxiSalary which:
  //   1. Parses `drafted: "R.PP (YYYY)"` for players this franchise drafted
  //   2. Falls back to a pid-keyed lookup against past 3 years of
  //      draftResults for trade-acquired taxi players ("Trade (YYYY)")
  //   3. Returns the §A1.4 salary for the resolved pick
  // Coverage in live data (2026-05-16): 63/85 direct + ~22 via historical
  // lookup = effectively 100% of rookie-origin taxi.
  function renderTaxi(mount) {
    var fid = M.state.viewerFranchiseId;
    if (!fid) {
      mount.innerHTML = subTabs("taxi") +
        '<div class="ups-m-stub"><h3>Sign in to MFL</h3><div>We couldn\'t resolve your franchise.</div></div>';
      return;
    }
    var rows = DATA.getRosterFor(fid).filter(function (r) {
      return /taxi/i.test(U.safeStr(r.status));
    });
    var banner =
      '<div class="ups-m-card" style="border-color:var(--warn);background:rgba(255,184,107,0.06)">' +
        '<div class="ups-m-card-title" style="color:var(--warn)">Rule change pending</div>' +
        '<div style="font-size:13px">Due to a change in rule, waiting to apply logic before allowing changes to taxi squad players. This view is read-only for now.</div>' +
        '<div style="font-size:11px;margin-top:8px;color:var(--fg-muted)">Salaries are derived from the §A1.4 rookie pay table using each player\'s UPS draft slot. Off-cap while on taxi.</div>' +
      '</div>';

    if (!rows.length) {
      mount.innerHTML = subTabs("taxi") + banner +
        '<div class="ups-m-stub"><div>No players on taxi.</div></div>';
      return;
    }

    // Derive salaries first so we can sort by them (MFL gives us $0).
    var enriched = rows.map(function (r) {
      var derived = DATA.deriveTaxiSalary ? DATA.deriveTaxiSalary(r) : { ok: false, salary: 0 };
      return { row: r, derived: derived };
    });
    enriched.sort(function (a, b) {
      return Number(b.derived.salary || 0) - Number(a.derived.salary || 0);
    });

    var html = subTabs("taxi") + banner + '<div class="ups-m-player-list">';
    html += '<div class="ups-m-pos-group">Taxi · ' + rows.length + '</div>';
    enriched.forEach(function (entry) {
      var r = entry.row;
      var d = entry.derived;
      var p = DATA.playerById(r.id);
      var rawPos = U.safeStr(p && p.position).toUpperCase();
      var name = U.safeStr(p && p.name) || ("Player " + r.id);
      // Re-orient "Last, First" → "First Last"
      if (name.indexOf(",") >= 0) {
        var parts = name.split(",");
        name = (parts[1] || "").trim() + " " + (parts[0] || "").trim();
        name = name.trim();
      }
      var team = U.safeStr(p && p.team);
      // Chip: show the derived UPS draft slot for clarity. Falls back
      // to the MFL `drafted` string when derivation didn't resolve.
      var slotChip = "";
      if (d.ok && d.round && d.pick) {
        var pickStr = d.round + "." + (d.pick < 10 ? "0" + d.pick : d.pick);
        slotChip = '<span class="chip">' + U.escapeHtml(pickStr) +
          (d.year ? ' \'' + String(d.year).slice(-2) : '') + '</span>';
      } else if (r.drafted) {
        slotChip = '<span class="chip">' + U.escapeHtml(U.safeStr(r.drafted)) + '</span>';
      }
      var salaryHtml = d.ok
        ? '<div class="salary" style="color:var(--teal)">' + U.fmtUsd(d.salary) + '</div>'
        : '<div class="salary" style="color:var(--fg-muted);font-size:11px">—</div>';
      html += '<div class="ups-m-player-row" data-pid="' + U.escapeHtml(r.id) + '">' +
        '<div class="pos">' + U.escapeHtml(rawPos) + '</div>' +
        '<div class="body">' +
          '<div class="name">' + U.escapeHtml(name) +
            (team ? '<span class="nfl-team">' + U.escapeHtml(team) + '</span>' : '') +
          '</div>' +
          '<div class="sub chips-row">' + slotChip + '</div>' +
        '</div>' +
        '<div class="right">' + salaryHtml + '</div>' +
      '</div>';
    });
    html += '</div>';
    mount.innerHTML = html;
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
    if (sub === "taxi") return renderTaxi(mount);
    if (sub === "tagging" && M.taggingView && M.taggingView.render) {
      return M.taggingView.render(mount);
    }
    return renderContracts(mount);
  }

  M.route.registerView("myteam", render);
})();
