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
      tab("auction", "Auction", "auction") +
      tab("stats", "Stats", "stats") +
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

  // Helpers shared with the My Team Contracts view — parse contractInfo
  // for CL + TCV tokens, build NFL ESPN logo URL, classify position for
  // colored pos badges. Mirrors `parseCT` / `nflLogoUrl` / `posClass`
  // from views/contracts.js so any team's roster renders identically to
  // the viewer's own My Team page.
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
    return "https://a.espncdn.com/i/teamlogos/nfl/500/" + t + ".png";
  }
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

  // Team-header card — shows franchise icon + name + owner. Anchors the
  // detail view so it's clear which team you're looking at when drilling
  // in from the Salary Summary.
  function renderTeamHeader(franchise) {
    if (!franchise) return "";
    var icon = U.safeStr(franchise.icon || franchise.logo);
    var owner = U.safeStr(franchise.owner);
    return '<div class="ups-m-team-header">' +
      (icon ? '<img class="ups-m-team-icon" src="' + U.escapeHtml(icon) + '" alt="" onerror="this.style.display=\'none\'" />' : '') +
      '<div class="ups-m-team-header-text">' +
        '<div class="ups-m-team-header-name">' + U.escapeHtml(franchise.name || ("Franchise " + franchise.id)) + '</div>' +
        (owner ? '<div class="ups-m-team-header-owner">' + U.escapeHtml(owner) + '</div>' : '') +
      '</div>' +
    '</div>';
  }

  // Re-render of the My Team Contracts cap card, scoped to any franchise
  // so other-team detail views show the same cap context as your own.
  function renderTeamCapCard(fid) {
    var cap = DATA.computeCap(fid);
    if (!cap || !cap.capAmount) return "";
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

  function renderRosterCards(fid) {
    var rows = DATA.getRosterFor(fid);
    if (!rows.length) {
      return '<div class="ups-m-stub"><div>No roster data.</div></div>';
    }
    var franchise = (M.state.franchises || []).find(function (f) { return f.id === fid; });
    var byPos = {};
    rows.forEach(function (r) {
      var p = DATA.playerById(r.id);
      var pos = U.safeStr(p && p.position).toUpperCase() || "Other";
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({ row: r, player: p });
    });
    var seen = {};
    var ordered = [];
    POS_ORDER.forEach(function (p) { if (byPos[p]) { ordered.push(p); seen[p] = true; } });
    Object.keys(byPos).sort().forEach(function (p) { if (!seen[p]) ordered.push(p); });

    var listHtml = '<div class="ups-m-player-list">';
    ordered.forEach(function (pos) {
      var list = byPos[pos].slice().sort(function (a, b) {
        return Number(b.row.salary || 0) - Number(a.row.salary || 0);
      });
      listHtml += '<div class="ups-m-pos-group">' + U.escapeHtml(pos) + ' · ' + list.length + '</div>';
      list.forEach(function (entry) {
        var r = entry.row;
        var p = entry.player;
        var name = nameFor(p) || ("Player " + r.id);
        var team = U.safeStr(p && p.team);
        var ct = parseCT(r.contractInfo);
        var cy = U.safeInt(r.contractYear, 0);
        var yr = cy;
        var cl = ct.cl || yr;
        var tcv = ct.tcv;
        var typeRaw = U.safeStr(r.contractStatus);
        var logo = nflLogoUrl(team);
        // Status badges — limited subset for the league/rosters context.
        // We DON'T render the viewer-specific "On Block" badge here since
        // OTB is per-franchise (only the viewer's OTB list applies). The
        // CL/YR/TCV/Type chips remain identical to My Team Contracts.
        var status = U.safeStr(r.status);
        var isTaxi = /taxi/i.test(status);
        var statusBits = [];
        if (cy === 0) statusBits.push('<span class="badge exp">Expired</span>');
        if (isTaxi) statusBits.push('<span class="badge tx">Taxi</span>');
        if (/ir|injured/i.test(status)) statusBits.push('<span class="badge ir">IR</span>');
        var chips = [
          (cl ? '<span class="chip">CL ' + cl + '</span>' : ''),
          (yr > 0 ? '<span class="chip">YR ' + yr + '</span>' : ''),
          (tcv ? '<span class="chip">TCV ' + U.fmtUsd(tcv) + '</span>' : ''),
          (typeRaw ? '<span class="chip type">' + U.escapeHtml(typeRaw) + '</span>' : ''),
          statusBits.join(" ")
        ].filter(Boolean).join(" ");
        // Taxi salary derivation: MFL strips salary from taxi players in
        // the rosters export (verified 2026-05-16). Use the §A1.4 rookie
        // pay table via DATA.deriveTaxiSalary for taxi rows. For active /
        // IR rows, the MFL row.salary is authoritative.
        var displaySalary = Number(r.salary || 0);
        var salaryColor = "";
        if (isTaxi && DATA.deriveTaxiSalary) {
          var derived = DATA.deriveTaxiSalary(r);
          if (derived && derived.ok) {
            displaySalary = derived.salary;
            salaryColor = "var(--teal)";  // teal = derived/off-cap
          }
        }
        var salaryHtml = (isTaxi && salaryColor)
          ? '<div class="salary" style="color:' + salaryColor + '">' + U.fmtUsd(displaySalary) + '</div>'
          : '<div class="salary">' + U.fmtUsd(displaySalary) + '</div>';
        listHtml += '' +
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
            '<div class="right">' + salaryHtml +
            '</div>' +
          '</div>';
      });
    });
    listHtml += '</div>';

    return renderTeamHeader(franchise) + renderTeamCapCard(fid) + listHtml;
  }

  // Two views for the Rosters tab — defaults to TEAM DETAIL of the viewer's
  // own franchise (Keith 2026-06-08); Salary Summary is the secondary view.
  //   "team"    — individual roster detail (default)
  //   "summary" — league-wide cap summary, one row per team
  state.rostersMode = state.rostersMode || "team";

  function renderRostersModeToggle() {
    var modes = [
      { key: "team", label: "Team Detail" },
      { key: "summary", label: "Salary Summary" }
    ];
    return '<div class="ups-m-segctl">' + modes.map(function (m) {
      return '<button class="ups-m-segctl-btn' + (state.rostersMode === m.key ? " on" : "") +
        '" data-mode="' + m.key + '">' + m.label + '</button>';
    }).join("") + '</div>';
  }

  // League-wide salary summary — one row per franchise. Numbers come from
  // the verbatim Front Office cap mirror (DATA.computeCap), so the values
  // match the cap card on each team's own Contracts page exactly.
  // Contract-limit chips (Loaded N/5, 3Y N/6) mirror desktop's
  // §6G compliance warnings — see contractLimitsFor in app.js.
  // Sum salary for expiring (cy=1) players on a franchise — useful for
  // FA Auction prep ("how much cap am I freeing up by not extending?").
  // Keith MobileNotesV1: "Add a column for Expiring Salary in the
  // summary roster tables."
  function expiringSalaryFor(fid) {
    var rows = DATA.getRosterFor ? DATA.getRosterFor(fid) : [];
    var total = 0;
    rows.forEach(function (r) {
      if (!r) return;
      if (U.safeInt(r.contractYear, 0) === 1) {
        total += Number(r.salary || 0);
      }
    });
    return total;
  }

  function renderSalarySummary() {
    var franchises = (M.state.franchises || []).slice();
    var rows = franchises.map(function (f) {
      var cap = DATA.computeCap(f.id) || {};
      var limits = DATA.contractLimitsFor ? DATA.contractLimitsFor(f.id) : { loaded: 0, threeYearNonRookie: 0 };
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
        adjustmentTotal: cap.adjustmentTotal || 0,
        loaded: limits.loaded,
        threeYearNonRookie: limits.threeYearNonRookie,
        expiring: expiringSalaryFor(f.id)
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
        '<div class="num">Exp</div>' +
        '<div class="num">%</div>' +
        '<div class="num">Ros</div>' +
      '</div>';
    rows.forEach(function (r) {
      var overCap = r.capRoom < 0;
      var roomClass = overCap ? "danger" : (r.pct >= 95 ? "warn" : "ok");
      var isMe = r.fid === viewerFid;
      // §6G compliance chips. The 3Y cap counts contracts with years
      // REMAINING == 3 (fresh MYACs in the current cycle), so it's
      // typically 0 outside the post-auction → contract-deadline window;
      // only render when > 0 to avoid noise. Loaded counts FL/BL contracts
      // year-round so we render it whenever non-zero. Red when over cap.
      var loadedOver = r.loaded > 5;
      var threeYrOver = r.threeYearNonRookie > 6;
      var limitChips = '';
      if (r.loaded > 0) {
        limitChips += ' <span class="tag ' + (loadedOver ? "danger" : "neutral") + '">Loaded ' + r.loaded + '/5</span>';
      }
      if (r.threeYearNonRookie > 0) {
        limitChips += ' <span class="tag ' + (threeYrOver ? "danger" : "neutral") + '">3Y ' + r.threeYearNonRookie + '/6</span>';
      }
      html += '<div class="ups-m-salsum-row' + (isMe ? " me" : "") + '" data-fid="' + U.escapeHtml(r.fid) + '">' +
        '<div class="team">' + U.escapeHtml(r.name) +
          (r.irCount ? ' <span class="tag ir">' + r.irCount + ' IR</span>' : '') +
          (r.taxiCount ? ' <span class="tag tx">' + r.taxiCount + ' TX</span>' : '') +
          (r.adjustmentTotal ? ' <span class="tag adj">Adj ' + (r.adjustmentTotal > 0 ? "+" : "−") +
            U.fmtUsd(Math.abs(r.adjustmentTotal)) + '</span>' : '') +
          limitChips +
        '</div>' +
        '<div class="num">' + U.fmtUsd(r.capTotal) + '</div>' +
        '<div class="num ' + roomClass + '">' + U.fmtUsd(r.capRoom) + '</div>' +
        '<div class="num">' + (r.expiring > 0 ? U.fmtUsd(r.expiring) : '—') + '</div>' +
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
  // "league" (flat, ordered by final finish) or "divisions" (grouped).
  // Mobile only ever had the flat table, so an owner could see a crown on a
  // row but never which division it belonged to, or who he was actually
  // racing. Divisional opponents are played twice and decide a seed, so this
  // is the view that matters most during the season.
  state.standingsMode = state.standingsMode || "league";
  state.championsByYear = state.championsByYear || null; // pid → year-of-title map; loaded lazily
  state.finalFinishByYear = state.finalFinishByYear || null; // { [year]: { [fid]: final_finish } }

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

  // Lazy-load /api/historical-finishes — the END-OF-SEASON ranking
  // (final_finish 1=champion, 12=toilet bowl) which is what determines
  // next-season draft order. Per Keith 2026-05-16: standings on mobile
  // should sort by this, NOT by regular-season h2h%/pf.
  // Canonical data source: src_final_standings D1 table populated from
  // metadata_finalstandings (see worker/migrations/0033_final_standings.sql).
  // Cached as { [year]: { [fid]: final_finish } }.
  function loadFinalFinishes() {
    if (state.finalFinishByYear) return Promise.resolve(state.finalFinishByYear);
    if (state._finalFinishLoading) return state._finalFinishLoading;
    state._finalFinishLoading = fetch(API.workerUrl("/api/historical-finishes"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var map = {};
        var rows = (j && j.rows) || [];
        rows.forEach(function (row) {
          if (!row || row.season == null || !row.franchise_id) return;
          var y = String(row.season);
          if (!map[y]) map[y] = {};
          map[y][U.pad4(row.franchise_id)] = parseInt(row.final_finish, 10) || 0;
        });
        state.finalFinishByYear = map;
        return map;
      })
      .catch(function () {
        state.finalFinishByYear = {};
        return {};
      })
      .then(function (m) { state._finalFinishLoading = null; renderRoute(); return m; });
    return state._finalFinishLoading;
  }

  // Lazy-load the champions panel JSON for trophy badges. Maps:
  //   { [year]: { franchise_id, franchise, title_number, icon } }
  // Returns a cached promise so concurrent renders don't double-fetch.
  function loadChampions() {
    if (state.championsByYear) return Promise.resolve(state.championsByYear);
    if (state._championsLoading) return state._championsLoading;
    state._championsLoading = fetch("/upsmflproduction/champions_panels.json", { mode: "cors", credentials: "omit", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var map = {};
        var rec = (j && j.recent_winners) || [];
        rec.forEach(function (w) {
          if (w && w.year != null) map[String(w.year)] = w;
        });
        state.championsByYear = map;
        return map;
      })
      .catch(function () {
        state.championsByYear = {};
        return {};
      })
      .then(function (m) { state._championsLoading = null; renderRoute(); return m; });
    return state._championsLoading;
  }

  function availableYears() {
    var cur = parseInt(M.state.ctx.year, 10) || (new Date().getUTCFullYear());
    // UPS league started in 2012 per memory. Show every year through current.
    var out = [];
    for (var y = cur; y >= 2012; y--) out.push(y);
    return out;
  }

  // Default year resolver: prefer the current cap-year UNLESS its
  // standings response has zero rows (preseason / no data), in which
  // case fall back to the prior year. Auto-flips once 2026 has real
  // data without any code change. Manual selection via the year
  // dropdown still overrides.
  function defaultStandingsYear() {
    var cur = parseInt(M.state.ctx.year, 10) || (new Date().getUTCFullYear());
    var curKey = String(cur);
    var curResp = state.standingsByYear[curKey];
    if (curResp && Array.isArray(curResp.rows) && curResp.rows.length > 0) return cur;
    // Prior year — assume it has data (UPS started 2012, every prior
    // year has a completed regular season).
    return cur - 1;
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
    // Several flag aliases — be defensive. The worker returns
    // `is_division_leader` (2026-05-16 verified against /api/standings).
    return !!(row && (row.is_division_leader || row._isDivLeader ||
              row.is_div_winner || row.division_winner || row.divisional_winner));
  }
  function isChampion(row, year) {
    var champs = state.championsByYear || {};
    var c = champs[String(year)];
    if (!c) return false;
    return U.pad4(c.franchise_id) === U.pad4(row && row.franchise_id);
  }
  // Champion title number for this franchise as of this season — pulls
  // from champions_panels.json `recent_winners[].title_number` which
  // counts cumulative titles for that owner. e.g. Pure Greatness winning
  // 2025 with title_number=1 means it's their 1st championship.
  function championTitleNumber(row, year) {
    var champs = state.championsByYear || {};
    var c = champs[String(year)];
    if (!c || U.pad4(c.franchise_id) !== U.pad4(row && row.franchise_id)) return 0;
    return parseInt(c.title_number, 10) || 0;
  }
  function ordinal(n) {
    if (!n) return "";
    var s = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Phase II-A1 — status chip + last-3 form chips. Mirrors the desktop
  // versions in site/standings/mfl_hpm_standings_v2.html (same wording,
  // same data source — site/shared/standings_race.js — kept as small
  // independent formatters per surface since formatting is presentation,
  // not "race calculation").
  var STATUS_LABEL = { BYE: "Bye", DIV: "Division winner", WC: "Wild card" };
  // projected (Keith 2026-10-09, port decision 3): until the season ends the chip is where the team stands now.
  function statusChipHtml(status, projected) {
    if (!status) return "";
    return ' <span class="ups-m-status-chip ' + status.toLowerCase() + (projected ? ' projected' : '') + '" aria-label="' + (projected ? 'Projected playoff status: ' : 'Playoff status: ') + STATUS_LABEL[status] + '">' + status + (projected ? '<small>proj</small>' : '') + '</span>';
  }
  function formChipsHtml(form3) {
    if (!form3 || !form3.length) return "";
    return form3.map(function (r) {
      return '<span class="ups-m-form-chip ' + r + '">' + r + '</span>';
    }).join("");
  }

  function renderStandings(mount) {
    // Lazy-load champion panels (trophy badges).
    if (!state.championsByYear && !state._championsLoading) loadChampions();
    // Lazy-load final-finish data (end-of-season draft order).
    if (!state.finalFinishByYear && !state._finalFinishLoading) loadFinalFinishes();

    // Default year resolution. If user manually picked a year (state.standingsYear),
    // honor it. Otherwise resolve from data — fall back to prior year when
    // the current cap-year has no rows. Kicks off a fetch of the current
    // year so the resolver has data to inspect on the next render.
    var curYear = parseInt(M.state.ctx.year, 10) || (new Date().getUTCFullYear());
    var curKey = String(curYear);
    if (!state.standingsByYear[curKey]) {
      loadStandingsForYear(curYear);
    }
    var year = state.standingsYear || defaultStandingsYear();
    var y = String(year);
    if (!state.standingsByYear[y]) {
      loadStandingsForYear(year);
      mount.innerHTML = subTabs("standings") +
        renderYearPicker(year) +
        renderStandingsModeToggle(state.standingsMode) +
        '<div class="ups-m-loading">Loading standings…</div>';
      bindYearPicker(mount);
      bindStandingsModeToggle(mount);
      return;
    }
    var rows = (state.standingsByYear[y].rows || []).slice();
    if (!rows.length) {
      mount.innerHTML = subTabs("standings") +
        renderYearPicker(year) +
        renderStandingsModeToggle(state.standingsMode) +
        '<div class="ups-m-stub"><div>No standings data for ' + U.escapeHtml(y) + '.</div></div>';
      bindYearPicker(mount);
      bindStandingsModeToggle(mount);
      return;
    }

    // DIVISIONS MODE — grouped by MFL division, sorted by that season's own
    // standings_sort chain. Shares the year picker and the same response, so
    // switching modes costs no extra fetch.
    if (state.standingsMode === "divisions") {
      mount.innerHTML = subTabs("standings") +
        renderYearPicker(year) +
        renderStandingsModeToggle("divisions") +
        renderDivisionBlocks(rows, state.standingsByYear[y], year) +
        '<div class="ups-m-standings-legend">👑 division leader · DIV = record inside the division<br>' +
        'Each division rival is played five times — this is the race that sets a playoff seed.</div>';
      bindYearPicker(mount);
      bindStandingsModeToggle(mount);
      return;
    }

    // PRIMARY SORT: end-of-season draft order (final_finish). Per Keith
    // 2026-05-16: standings should show the END finish, not regular-
    // season standings. Sources from /api/historical-finishes which
    // mirrors src_final_standings.final_finish (1 = champion, 12 = toilet
    // bowl champion). This IS the next-season draft order.
    //
    // FALLBACK: when final_finish is unavailable (current season pre-
    // playoffs, or any year missing from the table), keep the WORKER's order:
    // /api/standings sends rows in playoff-seed order, then the league's
    // ladder (worker/src/seeding.js). Re-sorting here would be a second,
    // different ladder (it was division winners → H2H% → PF).
    var finishMap = (state.finalFinishByYear || {})[y] || {};
    var hasFinishData = Object.keys(finishMap).length > 0;
    rows.forEach(function (r) {
      r._finalFinish = finishMap[U.pad4(r.franchise_id)] || 0;
    });
    if (hasFinishData) {
      rows.forEach(function (r, i) { r._workerOrder = i; });
      rows.sort(function (a, b) {
        // Both have final_finish → straight ascending. Zero/missing
        // values go to the bottom, in the worker's order.
        var af = a._finalFinish || 999;
        var bf = b._finalFinish || 999;
        return (af - bf) || (a._workerOrder - b._workerOrder);
      });
    }

    // Phase II-A1 — standings race (status chips, AP GB, last-3 form, and
    // the data the team sheet's Luck/seed-explanation/division-race blocks
    // need). Reads the SAME /api/standings response already cached on
    // state.standingsByYear[y] — rows/weekly/weeklyScores were fetched
    // already, just unused by this view until now.
    var raceData = window.UPS_STANDINGS_RACE
      ? window.UPS_STANDINGS_RACE.race({
          rows: state.standingsByYear[y].rows || [],
          // a failed query arrives as null and stays null — the race module then says "unavailable", never 0-0
          weekly: state.standingsByYear[y].weekly,
          weeklyScores: state.standingsByYear[y].weeklyScores,
          preseason: state.standingsByYear[y].preseason,
          season_complete: state.standingsByYear[y].season_complete
        })
      : null;
    // Divider lines only mean something when the table's own display order
    // IS playoff-seed order — that's only the in-season fallback path.
    // Once final_finish exists, rows are sorted by END-OF-SEASON placement
    // (a different ordering entirely — finish 1 is the champion, not
    // necessarily seed 1), so drawing a seed-boundary divider there would
    // be actively misleading.
    var canonicalSeedOrder = !hasFinishData && !!raceData;

    var trParts = [];
    rows.forEach(function (r, i) {
      var name = U.safeStr(r.franchise_name) || ("F" + r.franchise_id);
      var winner = isDivWinner(r);
      var champ = isChampion(r, year);
      var fid = U.pad4(r.franchise_id);
      var isYou = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
      var rr = raceData ? raceData.byFranchise[fid] : null;
      // Champion's row gets a gold-tinted class on top of the div-winner
      // class so styling layers cleanly.
      var rowClass = (champ ? "champion" : "") + (winner ? " div-winner" : "") + (isYou ? " you-row" : "") + (rr ? " race-row" : "");
      var badges = "";
      if (champ) {
        // Title count shown after the trophy: "🏆 3rd title" etc. Pulled
        // from champions_panels.json title_number for that year row.
        var titleN = championTitleNumber(r, year);
        var titleSuffix = titleN > 0 ? ' <span class="title-num">' + ordinal(titleN) + ' title</span>' : '';
        badges += '<span class="div-crown" title="League Champion">🏆</span>' + titleSuffix + ' ';
      }
      if (winner) badges += '<span class="div-crown" title="Division Winner">👑</span> ';
      // Rank column shows the END-OF-SEASON FINISH when available
      // (1-12, where 1 = champion). Falls back to display order when
      // finish data isn't present (current season pre-playoffs).
      var rankDisplay = r._finalFinish > 0 ? r._finalFinish : (i + 1);
      var projected = !!(raceData && raceData.projected && !raceData.preseason);
      var seedIcon = (!hasFinishData && r.playoff_seed)
        ? '<span class="seed-chip ' + (r.playoff_seed <= 6 ? "champ" : "hawk") + '" title="' +
          (r.playoff_seed <= 6 ? "UPS Championship seed" : "Hawktuah Bowl seed") + (projected ? " (projected)" : "") + '">' +
          (r.playoff_seed <= 6 ? "🏆" : "🦅") + '</span>'
        : '';
      var statusChip = statusChipHtml(rr && rr.status, projected);
      var gbCell = rr ? '<td class="num">' + (rr.apGB == null ? "—" : rr.apGB.toFixed(1)) + '</td>' : '<td class="num">—</td>';
      var formCell = rr ? '<span class="ups-m-form3">' + formChipsHtml(rr.form3) + '</span>' : '';
      trParts.push('<tr class="' + rowClass + '"' + (rr ? ' data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(name) + ' details"' : '') + '>' +
        '<td class="rank">' + rankDisplay + seedIcon + '</td>' +
        '<td class="team">' + badges + U.escapeHtml(name) + statusChip + '<br>' + formCell + '</td>' +
        '<td>' + (r.h2h_w || 0) + '-' + (r.h2h_l || 0) + (r.h2h_t ? "-" + r.h2h_t : "") + '</td>' +
        '<td>' + fmtPct(r.h2h_pct) + '</td>' +
        '<td>' + fmtPct(r.allplay_pct) + '</td>' +
        gbCell +
        '<td>' + fmtPts(r.pf) + '</td>' +
      '</tr>');
      if (canonicalSeedOrder) {
        if (Number(r.playoff_seed) === 2) trParts.push('<tr class="seed-divider"><td colspan="7"></td></tr>');
        if (Number(r.playoff_seed) === 6) trParts.push('<tr class="seed-divider hawk-divider"><td colspan="7">Hawktuah Bowl · seeds 7–12</td></tr>');
      }
    });
    var trs = trParts.join("");

    var recordedSeeds = rows.some(function (r) { return r.seed_reason && r.seed_reason.basis === "recorded_final_standings"; });
    var orderingNote = hasFinishData
      ? 'Ordered by end-of-season finish (next-season draft order).'
      : recordedSeeds
        ? 'Ordered by the recorded final standings.'
        : 'Ordered by playoff seed — All-Play % → Overall → season PF → head-to-head (league rule).' +
          (raceData && raceData.projected && !raceData.preseason ? ' Seeds and BYE / DIV / WC are projected until the season ends.' : '');
    var weekNote = "";
    if (!hasFinishData) {
      var wkRows = state.standingsByYear[y].weekly;
      if (!Array.isArray(wkRows) || !Array.isArray(state.standingsByYear[y].weeklyScores)) {
        weekNote = 'Weekly results couldn\u2019t be read — GB, form and luck show —. ';
      } else {
        var maxWk = 0;
        wkRows.forEach(function (m) { if (m.w > maxWk) maxWk = m.w; });
        if (maxWk > 0) weekNote = 'Through Week ' + maxWk + '. ';
      }
    }

    var html = subTabs("standings") +
      renderYearPicker(year) +
      renderStandingsModeToggle("league") +
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(y) + (hasFinishData ? ' · Final Standings' : ' · Standings') + '</div>' +
        '<table class="ups-m-standings-table">' +
          '<thead><tr><th>#</th><th class="team">Team</th><th>W-L</th><th>H2H%</th><th>AP%</th><th>GB</th><th>PF</th></tr></thead>' +
          '<tbody>' + trs + '</tbody>' +
        '</table>' +
        '<div class="ups-m-standings-legend">🏆 league champion · 👑 division winner · AP% = All-Play % · GB = AP games back of the 6-seed' + (raceData ? ' · tap a team for details' : '') + '<br>' + U.escapeHtml(weekNote + orderingNote) + '</div>' +
      '</div>';
    mount.innerHTML = html;
    bindYearPicker(mount);
    bindStandingsModeToggle(mount);
    if (raceData) {
      Array.prototype.forEach.call(mount.querySelectorAll("tr.race-row[data-fid]"), function (tr) {
        var openSheet = function () {
          var fid = tr.getAttribute("data-fid");
          var srcRow = rows.filter(function (r) { return U.pad4(r.franchise_id) === fid; })[0];
          if (M.teamSheet) M.teamSheet.open(fid, { row: srcRow, raceRow: raceData.byFranchise[fid], year: year, trigger: tr });
        };
        tr.addEventListener("click", openSheet);
        tr.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); openSheet(); }
        });
      });
    }
  }

  // MFL's own tiebreaker chain, per season, from the standings response.
  // Same tokens the desktop Divisions view uses; H2H is pairwise and cannot be
  // resolved from a single row, so it is skipped rather than guessed at.
  var DIV_SORT_FIELD = {
    PCT: "h2h_pct", DIVPCT: "div_pct", PTS: "pf", ALL_PLAY_PCT: "allplay_pct", PWR: "pwr"
  };

  function sortWithinDivision(teams, sortStr) {
    var tokens = String(sortStr || "PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR")
      .split(",").map(function (t) { return t.trim().toUpperCase(); }).filter(Boolean);
    return teams.sort(function (a, b) {
      for (var i = 0; i < tokens.length; i++) {
        var f = DIV_SORT_FIELD[tokens[i]];
        if (!f) continue;
        var av = Number(a[f] || 0), bv = Number(b[f] || 0);
        if (av !== bv) return bv - av;
      }
      return 0;
    });
  }

  function renderDivisionBlocks(rows, resp, year) {
    var withDiv = rows.filter(function (r) { return r.division != null && r.division !== ""; });
    if (!withDiv.length) {
      return '<div class="ups-m-stub"><div>Division alignment not available for ' +
             U.escapeHtml(String(year)) + '.</div></div>';
    }
    var byDiv = {};
    withDiv.forEach(function (r) {
      var k = String(r.division);
      if (!byDiv[k]) byDiv[k] = {
        // division_name comes from MFL's league export via the worker; fall
        // back to the bare code rather than inventing a label.
        name: r.division_name || ("Division " + k),
        teams: []
      };
      byDiv[k].teams.push(r);
    });
    var seasonComplete = !!resp.season_complete;
    var leaderTag = seasonComplete ? "WINNER" : "LEADER";
    return Object.keys(byDiv).sort().map(function (k) {
      var d = byDiv[k];
      sortWithinDivision(d.teams, resp.standings_sort);
      var trs = d.teams.map(function (r, i) {
        var name = U.safeStr(r.franchise_name) || ("F" + r.franchise_id);
        var leader = isDivWinner(r) || i === 0;
        var champ = isChampion(r, year);
        var cls = (champ ? "champion" : "") + (isDivWinner(r) ? " div-winner" : "");
        var badge = isDivWinner(r)
          ? ' <span class="ups-m-div-tag">' + leaderTag + '</span>'
          : "";
        return '<tr class="' + cls + '">' +
          '<td class="rank">' + (i + 1) + '</td>' +
          '<td class="team">' + (champ ? '<span class="div-crown">🏆</span> ' : "") +
            U.escapeHtml(name) + badge + '</td>' +
          '<td>' + (r.h2h_w || 0) + '-' + (r.h2h_l || 0) + (r.h2h_t ? "-" + r.h2h_t : "") + '</td>' +
          '<td>' + (r.div_w != null ? (r.div_w || 0) + '-' + (r.div_l || 0) : '—') + '</td>' +
          '<td>' + fmtPts(r.pf) + '</td>' +
        '</tr>';
      }).join("");
      return '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">' + U.escapeHtml(d.name) + '</div>' +
        '<table class="ups-m-standings-table">' +
          '<thead><tr><th>#</th><th class="team">Team</th><th>W-L</th><th>DIV</th><th>PF</th></tr></thead>' +
          '<tbody>' + trs + '</tbody>' +
        '</table>' +
      '</div>';
    }).join("");
  }

  function renderStandingsModeToggle(mode) {
    function b(key, label) {
      return '<a class="ups-m-subtab' + (key === mode ? ' active' : '') +
             '" href="#" data-sw-mode="' + key + '">' + label + '</a>';
    }
    return '<div class="ups-m-action-chips">' + b("league", "League") + b("divisions", "Divisions") + '</div>';
  }
  function bindStandingsModeToggle(mount) {
    Array.prototype.forEach.call(mount.querySelectorAll("[data-sw-mode]"), function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        state.standingsMode = el.getAttribute("data-sw-mode");
        renderRoute();
      });
    });
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
      return M.tradeView.render(mount, subParts.slice(1));
    }
    if (sub === "draft" && M.draftView && M.draftView.render) {
      return M.draftView.render(mount);
    }
    if (sub === "auction" && M.auctionView && M.auctionView.render) {
      return M.auctionView.render(mount);
    }
    if (sub === "stats" && M.statsView && M.statsView.render) {
      return M.statsView.render(mount);
    }
    return renderStandings(mount);
  }

  // Lets the team sheet's "View roster" link (site/m/team_sheet.js) land on
  // a specific franchise instead of whatever renderRosters() would default
  // to. No such preset mechanism existed before Phase II-A4 — rosters
  // navigation was always "go to #league/rosters, see your own team."
  M.leagueView = {
    presetRoster: function (fid) {
      state.selectedFid = U.pad4(fid);
      state.rostersMode = "team";
    }
  };

  M.route.registerView("league", render);
})();
