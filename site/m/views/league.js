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
  // Modes (2026-10-17, #1329): "seeds" (default: playoff-seed order in season, the recorded final standings for a
  // finished season), "divisions", "weekly" (one week's whole league + the season's top scores), "playoffs" (A2).
  state.standingsMode = (state.standingsMode === "league" ? "seeds" : state.standingsMode) || "seeds";
  state.weeklyWeek = state.weeklyWeek || null;          // the week the Weekly view shows (null = latest completed)
  state.weeklyScope = state.weeklyScope || "week";       // "week" | "season"
  state.championsByYear = state.championsByYear || null; // pid → year-of-title map; loaded lazily
  state.finalFinishByYear = state.finalFinishByYear || null; // { [year]: { [fid]: final_finish } }
  state.recordedSeedByYear = state.recordedSeedByYear || {}; // { [year]: { [fid]: regular_season_finish } }

  function loadStandingsForYear(year) {
    var y = String(year);
    if (state.standingsByYear[y] || (state.standingsLoading === y)) return Promise.resolve();
    state.standingsLoading = y;
    return fetch(API.workerUrl("/api/standings?year=" + encodeURIComponent(y)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (resp) { state.standingsByYear[y] = (resp && resp.ok !== false) ? resp : { rows: [], error: "unavailable" }; })
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
          if (!state.recordedSeedByYear[y]) state.recordedSeedByYear[y] = {};
          state.recordedSeedByYear[y][U.pad4(row.franchise_id)] = parseInt(row.regular_season_finish, 10) || 0;
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
    // Every season with standings: 2010 (the one-year redraft league) onward.
    var out = [];
    for (var y = cur; y >= 2010; y--) out.push(y);
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

  // ---------- Phase II-A2 — Playoffs mode (mobile A6) ----------
  // Bracket fetch, cached per year like state.standingsByYear — but a
  // FAILED fetch is never cached as permanent "no data": it's retried
  // automatically after a short cooldown (state.bracketErrorAt), so a
  // transient outage can't look identical to a legitimately empty
  // pre-playoff bracket for the rest of the session.
  state.bracketByYear = state.bracketByYear || {};
  state.bracketLoading = state.bracketLoading || null;
  state.bracketErrorAt = state.bracketErrorAt || {};
  var BRACKET_RETRY_COOLDOWN_MS = 20000;
  function loadPlayoffBracketForYear(year) {
    var y = String(year);
    if (state.bracketByYear[y]) return Promise.resolve();
    if (state.bracketLoading === y) return Promise.resolve();
    var lastFail = state.bracketErrorAt[y];
    if (lastFail && (Date.now() - lastFail) < BRACKET_RETRY_COOLDOWN_MS) return Promise.resolve();
    state.bracketLoading = y;
    return fetch(API.workerUrl("/api/playoff-bracket?year=" + encodeURIComponent(y)), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (resp) {
        if (resp && resp.ok) { state.bracketByYear[y] = resp; delete state.bracketErrorAt[y]; }
        else { state.bracketErrorAt[y] = Date.now(); }
      })
      .catch(function () { state.bracketErrorAt[y] = Date.now(); })
      .then(function () { state.bracketLoading = null; renderRoute(); });
  }

  function playoffGroupRowHtml(entry) {
    var chip = statusChipHtml(entry.status, true);
    var gb = entry.apGB == null ? "—" : entry.apGB.toFixed(1);
    var rec = (entry.overall.w || 0) + "-" + (entry.overall.l || 0) + (entry.overall.t ? "-" + entry.overall.t : "");
    return '<div class="ups-m-playoff-row" data-fid="' + U.escapeHtml(entry.franchise_id) + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(entry.franchise_name) + ' details">' +
      '<div class="rank">' + (entry.seed != null ? "#" + entry.seed : "—") + '</div>' +
      '<div class="team"><span class="name-text">' + U.escapeHtml(entry.franchise_name) + '</span>' + chip + '</div>' +
      '<div class="num">' + rec + '</div>' +
      '<div class="num">' + fmtPct(entry.allplay_pct) + '</div>' +
      '<div class="num">' + gb + '</div>' +
    '</div>';
  }
  function playoffGroupSectionHtml(title, entries) {
    if (!entries.length) return "";
    return '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(title) + '</div>' +
      '<div class="ups-m-playoff-group-head"><div class="rank">#</div><div class="team">Team</div><div class="num">W-L</div><div class="num">AP%</div><div class="num">GB</div></div>' +
      '<div class="ups-m-playoff-group">' + entries.map(playoffGroupRowHtml).join("") + '</div></div>';
  }
  // Pre-playoff presentation: four stacked groups from projectedPlayoffGroups
  // (BYES / DIVISION WINNERS / WILD CARDS / IN THE HUNT) — same race helper
  // (statusForRow / apGamesBack, via projectedPlayoffGroups) the A1 tables
  // already use, never a separate computation.
  function renderPrePlayoffGroups(groups) {
    // F4 (Phase II-A2 correction pass): owner-facing copy only — the
    // previous legend text was a developer note that literally named the
    // very elimination language it was trying to disclaim, defeating
    // its own intent.
    return playoffGroupSectionHtml("BYES", groups.byes) +
      playoffGroupSectionHtml("DIVISION WINNERS", groups.divisionWinners) +
      playoffGroupSectionHtml("WILD CARDS", groups.wildCards) +
      playoffGroupSectionHtml("IN THE HUNT", groups.inTheHunt) +
      '<div class="ups-m-standings-legend">Projected from current seeds. AP GB shows All-Play wins behind the sixth seed.</div>';
  }

  // Playoff-period / completed-season presentation: real matchup cards
  // from /api/playoff-bracket, grouped/labeled via the SAME shared
  // bracket-topology function A5's desktop projected bracket uses
  // (window.UPS_STANDINGS_RACE.buildActualBracketResult) — not scattered
  // mobile conditionals.
  function pickLabelsForGame(sideKey, gameKey) {
    var slots = (window.UPS_STANDINGS_RACE.BRACKET_FINISH_SLOTS || []).filter(function (s) { return s.side === sideKey && s.game === gameKey; });
    var winnerSlot = slots.filter(function (s) { return s.role === "winner"; })[0];
    var loserSlot = slots.filter(function (s) { return s.role === "loser"; })[0];
    if (!winnerSlot) return null; // R1/semis games don't directly decide a single pick — don't fabricate one
    return "Winner → " + winnerSlot.pick + (loserSlot ? " · Loser → " + loserSlot.pick : "");
  }
  function matchupCardHtml(game, roundLabel, pickLabel) {
    function teamHtml(seedEntry, score, isWinner) {
      if (!seedEntry) return '<div class="ups-m-matchup-team dim">TBD</div>';
      return '<div class="ups-m-matchup-team' + (isWinner ? " winner" : "") + '">' +
        '<span class="seed">#' + seedEntry.seed + '</span>' +
        '<span class="name">' + U.escapeHtml(seedEntry.franchise_name || seedEntry.franchise_id) + '</span>' +
        '<span class="score">' + (score == null ? "—" : Number(score).toFixed(1)) + '</span>' +
      '</div>';
    }
    var aWin = !!(game.winner && game.a && game.winner.franchise_id === game.a.franchise_id);
    var bWin = !!(game.winner && game.b && game.winner.franchise_id === game.b.franchise_id);
    return '<div class="ups-m-matchup-card">' +
      '<div class="ups-m-matchup-meta">' + U.escapeHtml(roundLabel) + (game.week ? " · Week " + game.week : "") +
        (game.pending ? ' · <span class="pending">pending</span>' : ' · <span class="final">final</span>') + '</div>' +
      teamHtml(game.a, game.scoreA, aWin) +
      teamHtml(game.b, game.scoreB, bWin) +
      (pickLabel ? '<div class="ups-m-matchup-determines">Determines: ' + U.escapeHtml(pickLabel) + '</div>' : "") +
    '</div>';
  }
  function renderActualMatchupCards(seeds, matchups, playoffWeeksRaw) {
    var result = window.UPS_STANDINGS_RACE.buildActualBracketResult(seeds, matchups, playoffWeeksRaw);
    if (result.status !== "ok") {
      return '<div class="ups-m-stub"><div>Playoff bracket data unavailable' + (result.reason ? (": " + U.escapeHtml(result.reason)) : ".") + '</div></div>';
    }
    function sideHtml(label, side, sideKey) {
      var cards = [];
      side.r1.forEach(function (g) { cards.push(matchupCardHtml(g, label + " · Round 1", null)); });
      side.semis.forEach(function (g) { cards.push(matchupCardHtml(g, label + " · Semifinal", null)); });
      if (side.placement) cards.push(matchupCardHtml(side.placement, label + " · Placement", pickLabelsForGame(sideKey, "placement")));
      // F7 (Phase II-A2 correction pass): "Title Game" here, never the
      // side's own name again — `label` is already "UPS Championship" /
      // "Hawktuah Bowl", so repeating it produced a literal duplicate
      // ("Hawktuah Bowl · Hawktuah Bowl") on the real 2025 final card.
      if (side.final) cards.push(matchupCardHtml(side.final, label + " · Title Game", pickLabelsForGame(sideKey, "final")));
      if (side.third) cards.push(matchupCardHtml(side.third, label + " · 3rd place", pickLabelsForGame(sideKey, "third")));
      if (!cards.length) return "";
      return '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(label) + '</div>' + cards.join("") + '</div>';
    }
    var html = sideHtml("UPS Championship", result.champ, "champ") + sideHtml("Hawktuah Bowl", result.hawk, "hawk");
    return html || '<div class="ups-m-stub"><div>No playoff games recorded yet.</div></div>';
  }

  // Top-level Playoffs-mode render — loading / actual-cards / projected-
  // groups / unavailable are FOUR distinct, textually-distinguishable
  // states (never a false empty picture while the fetch is in flight,
  // and a failed fetch is never indistinguishable from a legitimately
  // empty bracket — see loadPlayoffBracketForYear's cooldown-retry above).
  function renderPlayoffsMode(mount, year, y) {
    if (!state.bracketByYear[y] && state.bracketLoading !== y) loadPlayoffBracketForYear(year);
    var shell = standingsShell(year, y, "playoffs");
    if (state.bracketLoading === y || (!state.bracketByYear[y] && !state.bracketErrorAt[y])) {
      mount.innerHTML = shell + '<div class="ups-m-loading">Loading playoff bracket…</div>';
      bindYearPicker(mount); bindStandingsModeToggle(mount);
      return;
    }
    var bresp = state.bracketByYear[y];
    if (!bresp) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>Couldn’t load playoff data for ' + U.escapeHtml(y) + ' right now. It will retry automatically.</div></div>';
      bindYearPicker(mount); bindStandingsModeToggle(mount);
      return;
    }
    if (!window.UPS_STANDINGS_RACE) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>Playoff projections unavailable (shared module not loaded).</div></div>';
      bindYearPicker(mount); bindStandingsModeToggle(mount);
      return;
    }
    var seeds = bresp.seeds || [];
    var matchups = bresp.matchups || [];
    // F9 (Phase II-A2 correction pass): the SAME shared gating decision
    // desktop's renderBracket()/renderDraftOrder() use — never a mobile-
    // local "matchups.length / !season_complete" conditional pair.
    var mode = window.UPS_STANDINGS_RACE.projectionMode({ seasonComplete: bresp.season_complete, matchups: matchups, seeds: seeds });
    var body;
    if (mode === "actual") {
      body = renderActualMatchupCards(seeds, matchups, bresp.playoff_weeks);
    } else if (mode === "projected") {
      var stdResp = state.standingsByYear[y] || { rows: [], weeklyScores: [] };
      // weeklyScores passes through as-is: a failed query (null) makes AP games back unavailable, never a preseason 0.0
      var groups = window.UPS_STANDINGS_RACE.projectedPlayoffGroups(stdResp.rows || [], stdResp.weeklyScores);
      body = renderPrePlayoffGroups(groups);
    } else {
      body = '<div class="ups-m-stub"><div>No playoff data for ' + U.escapeHtml(y) + '.</div></div>';
    }
    mount.innerHTML = shell + body;
    bindYearPicker(mount);
    bindStandingsModeToggle(mount);
    // Playoff-group rows can open the same A1 team sheet as League mode —
    // never a separate/duplicated team-detail surface.
    Array.prototype.forEach.call(mount.querySelectorAll(".ups-m-playoff-row[data-fid]"), function (rowEl) {
      var openSheet = function () {
        var stdResp2 = state.standingsByYear[y];
        if (stdResp2) openTeam(rowEl.getAttribute("data-fid"), stdResp2, year, rowEl);
      };
      rowEl.addEventListener("click", openSheet);
      rowEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); openSheet(); }
      });
    });
  }

  // ---------- Standings v3 (2026-10-17, #1329) ----------
  // One source: the worker's /api/standings. In season it sends rows in playoff-seed order with each seed's status
  // and reason (worker/src/standings_truth.js); this view never ranks a team itself. Finished seasons show the
  // recorded final standings (finish after the playoffs + the recorded regular-season seed), never a recomputed seed.
  var RACE = function () { return window.UPS_STANDINGS_RACE || null; };
  var STEP_WORDS = {
    all_play: "a better All-Play %",
    overall: "a better record",
    points_for: "more Points For",
    head_to_head: "the head-to-head games between them",
    name: "a tie on every step (listed alphabetically)",
    franchise_id: "a tie on every step",
    bye_requires_division_title: "a first-round bye needs a division title",
    division_winner_in_field: "division winners are in the field"
  };
  var DIV_STEP_WORDS = {
    PCT: "a better record", DIVPCT: "a better division record", H2H: "the head-to-head games between them",
    PTS: "more Points For", ALL_PLAY_PCT: "a better All-Play %", name: "a tie on every step",
    name_after_pwr_unavailable: "a tie on every step MFL publishes"
  };
  function recStr(r) { return r ? (r.w || 0) + "-" + (r.l || 0) + (r.t ? "-" + r.t : "") : "—"; }
  function rowByFid(rows) {
    var m = {};
    (rows || []).forEach(function (r) { m[U.pad4(r.franchise_id)] = r; });
    return m;
  }
  function nm(r) { return U.safeStr(r && r.franchise_name) || ("F" + (r && r.franchise_id)); }
  function regRec(r) { return (r && r.regular_season) || null; }
  function moveHtml(r) {
    var c = r && r.order_change;
    if (c == null || c === 0) return "";
    var up = c > 0;
    return ' <span class="ups-m-move ' + (up ? "up" : "down") + '" aria-label="' + (up ? "up " : "down ") + Math.abs(c) +
      ' since last week">' + (up ? "▲" : "▼") + Math.abs(c) + '</span>';
  }
  function seasonState(resp) {
    var rs = resp && resp.regular_season;
    if (resp && resp.standings_basis === "recorded_final_standings") return "final";
    if (resp && resp.season_complete) return "final";
    if (rs && rs.complete) return "regular_over";
    return "in_season";
  }
  function freshnessHtml(resp, y) {
    var rs = resp && resp.regular_season;
    var st = seasonState(resp);
    var txt;
    if (st === "final") txt = y + " · season complete";
    else if (resp && resp.preseason) txt = y + " · no games played yet";
    else if (rs && rs.through_week) txt = "Through Week " + rs.through_week + (rs.last_regular_season_week ? " of " + rs.last_regular_season_week : "") + " · final scores" + (st === "regular_over" ? " · seeds are set" : "");
    else txt = y;
    return '<div class="ups-m-fresh">' + U.escapeHtml(txt) + '</div>';
  }
  function standingsShell(year, y, mode) {
    return subTabs("standings") + renderYearPicker(year) + renderStandingsModeToggle(mode) +
      (state.standingsByYear[y] ? freshnessHtml(state.standingsByYear[y], y) : "");
  }
  function failureHtml(y) {
    return '<div class="ups-m-stub" role="alert"><div>Couldn’t load the ' + U.escapeHtml(y) + ' standings.</div>' +
      '<button class="btn" type="button" data-standings-retry="' + U.escapeHtml(y) + '">Try again</button></div>';
  }
  function bindRetry(mount) {
    Array.prototype.forEach.call(mount.querySelectorAll("[data-standings-retry]"), function (b) {
      b.addEventListener("click", function () {
        var y = b.getAttribute("data-standings-retry");
        delete state.standingsByYear[y];
        renderRoute();
      });
    });
  }
  function bindShell(mount) { bindYearPicker(mount); bindStandingsModeToggle(mount); bindRetry(mount); }
  function raceFor(resp) {
    var R = RACE();
    if (!R) return null;
    try { return R.race(resp); } catch (e) { return null; }
  }
  // Tap a row → the team sheet with every block computed by the shared module (never a re-ranking).
  function openTeam(fid, resp, year, trigger) {
    if (!M.teamSheet) return;
    var R = RACE();
    var rr = raceFor(resp);
    var sf = null, hist = null;
    try { sf = R && R.scoredFaced ? R.scoredFaced(resp) : null; } catch (e) { sf = null; }
    try { hist = R && R.teamWeeklyHistory ? R.teamWeeklyHistory(resp, fid) : null; } catch (e) { hist = null; }
    M.teamSheet.open(fid, {
      row: rowByFid(resp.rows)[fid], raceRow: rr ? rr.byFranchise[fid] : null,
      scoredFaced: sf && sf.status === "ok" ? sf.byFranchise[fid] : null, scoredFacedStatus: sf ? sf.status : "unavailable",
      history: hist, year: year, trigger: trigger, seasonState: seasonState(resp)
    });
  }
  function bindTeamRows(mount, sel, resp, year) {
    Array.prototype.forEach.call(mount.querySelectorAll(sel), function (el) {
      var go = function () { openTeam(el.getAttribute("data-fid"), resp, year, el); };
      el.addEventListener("click", go);
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); go(); }
      });
    });
  }

  function renderStandings(mount) {
    if (!state.championsByYear && !state._championsLoading) loadChampions();
    if (!state.finalFinishByYear && !state._finalFinishLoading) loadFinalFinishes();
    var curYear = parseInt(M.state.ctx.year, 10) || (new Date().getUTCFullYear());
    if (!state.standingsByYear[String(curYear)]) loadStandingsForYear(curYear);
    var year = state.standingsYear || defaultStandingsYear();
    var y = String(year);
    var mode = state.standingsMode;
    if (!state.standingsByYear[y]) {
      loadStandingsForYear(year);
      mount.innerHTML = standingsShell(year, y, mode) + '<div class="ups-m-loading">Loading standings…</div>';
      bindShell(mount);
      return;
    }
    var resp = state.standingsByYear[y];
    if (resp.error) {
      mount.innerHTML = standingsShell(year, y, mode) + failureHtml(y);
      bindShell(mount);
      return;
    }
    if (mode === "playoffs") { renderPlayoffsMode(mount, year, y); return; }
    if (mode === "divisions") { renderDivisionsMode(mount, year, y, resp); return; }
    if (mode === "weekly") { renderWeeklyMode(mount, year, y, resp); return; }
    if (resp.standings_basis === "recorded_final_standings" || (resp.season_complete && resp.standings_basis !== "regular_season_ladder")) {
      renderFinalStandings(mount, year, y, resp);
      return;
    }
    renderSeedsMode(mount, year, y, resp);
  }

  // ── Seeds (in season) ──
  function summaryCardHtml(resp, rows) {
    var by = rowByFid(rows);
    var seeded = rows.filter(function (r) { return r.playoff_seed != null; }).sort(function (a, b) { return a.playoff_seed - b.playoff_seed; });
    if (seeded.length < 6) return "";
    var final = seasonState(resp) !== "in_season";
    var lines = [];
    var byes = seeded.filter(function (r) { return r.playoff_seed <= 2; }).map(nm);
    lines.push('<b>' + (final ? "Byes:" : "If the season ended today, byes:") + '</b> ' + U.escapeHtml(byes.join(" and ")) + ".");
    var rs = resp.regular_season || {};
    var out = rs.next_out ? by[U.pad4(rs.next_out)] : null;
    var sixth = seeded[5];
    if (out && sixth && !final) {
      var back = out.ap_back;
      lines.push('<b>Next out:</b> ' + U.escapeHtml(nm(out)) + (back != null ? ", " + U.escapeHtml(String(back)) + " All-Play win" + (back === 1 ? "" : "s") + " behind " + U.escapeHtml(nm(sixth)) + " (6th)" : "") + ".");
    }
    // Ties that decided a place: show the step whenever it wasn't All-Play (that's the "why is he ahead?" question).
    var ties = [];
    rows.forEach(function (r) {
      var va = r.seed_reason && r.seed_reason.vs_above;
      if (!va || !va.step || va.step === "all_play") return;
      var up = by[U.pad4(va.franchise_id)];
      if (!up) return;
      var rr = regRec(r), ru = regRec(up);
      var detail = "";
      if (va.step === "overall" && rr && ru) detail = "(" + recStr(ru.record) + " vs " + recStr(rr.record) + ")";
      if (va.step === "points_for" && rr && ru) detail = "(" + fmtPts(ru.points_for) + " vs " + fmtPts(rr.points_for) + ")";
      var same = va.step === "overall" || va.step === "points_for" || va.step === "head_to_head" ? "same All-Play, " : "";
      ties.push(U.escapeHtml(nm(up)) + " over " + U.escapeHtml(nm(r)) + ": " + same + U.escapeHtml(STEP_WORDS[va.step] || va.step) + (detail ? " " + U.escapeHtml(detail) : "") + ".");
    });
    if (ties.length) lines.push('<b>Tiebreak' + (ties.length > 1 ? "s" : "") + ':</b> ' + ties.slice(0, 3).join(" "));
    return '<div class="ups-m-card ups-m-standings-summary">' + lines.map(function (l) { return '<div class="line">' + l + '</div>'; }).join("") + '</div>';
  }
  function howSeedsWorkHtml() {
    return '<details class="ups-m-how"><summary>How seeds work</summary><ol>' +
      '<li>The four division winners make the playoffs. Division winners are decided by record, then division record, then head-to-head (MFL’s order).</li>' +
      '<li>The two best division winners get seeds 1 and 2 and a first-round bye.</li>' +
      '<li>The other two division winners and the two best other teams (wild cards) are seeds 3-6, in ladder order.</li>' +
      '<li>Ladder: All-Play %, then record, then Points For, then head-to-head among the tied teams. Only regular-season weeks count.</li>' +
      '</ol><div class="sub">All-Play = your score against all 11 other teams every week (11 games a week). Seeds 7-12 play the Hawktuah Bowl; finish 7 picks 1.01.</div></details>';
  }
  function renderSeedsMode(mount, year, y, resp) {
    var rows = (resp.rows || []).slice();
    var shell = standingsShell(year, y, "seeds");
    if (resp.preseason || resp.standings_basis === "preseason") {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>No games played yet. Seeds start after Week 1.</div></div>' + howSeedsWorkHtml();
      bindShell(mount);
      return;
    }
    if (resp.standings_basis === "unavailable") {
      var probs = ((resp.regular_season && resp.regular_season.problems) || []).slice(0, 3).map(function (p) {
        return U.escapeHtml(String(p.code || "").replace(/_/g, " ") + (p.week ? " (Week " + p.week + ")" : ""));
      });
      mount.innerHTML = shell + '<div class="ups-m-stub" role="alert"><div><b>Seeds unavailable.</b> The weekly results couldn’t be verified, so no team is ranked.' +
        (probs.length ? '<br><span class="sub">' + probs.join(" · ") + '</span>' : "") + '</div></div>';
      bindShell(mount);
      return;
    }
    var final = seasonState(resp) !== "in_season";
    var trs = [];
    rows.forEach(function (r) {
      var fid = U.pad4(r.franchise_id);
      var reg = regRec(r);
      var st = RACE() ? RACE().statusForRow(r) : null;
      var you = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
      var ap = reg ? reg.all_play : { w: r.allplay_w, l: r.allplay_l, t: r.allplay_t, pct: r.allplay_pct };
      var rec = reg ? reg.record : { w: r.h2h_w, l: r.h2h_l, t: r.h2h_t };
      trs.push('<tr class="race-row' + (you ? " you-row" : "") + '" data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(r)) + ' details">' +
        '<td class="rank">' + (r.playoff_seed != null ? r.playoff_seed : "—") + '</td>' +
        '<td class="team"><span class="name-text">' + U.escapeHtml(nm(r)) + '</span>' + moveHtml(r) + statusChipHtml(st, !final) + '</td>' +
        '<td class="num">' + fmtPct(ap.pct) + '</td>' +
        '<td class="num">' + recStr(rec) + '</td>' +
        '<td class="num">' + (r.ap_back == null ? "—" : U.escapeHtml(String(r.ap_back))) + '</td>' +
      '</tr>');
      if (Number(r.playoff_seed) === 2) trs.push('<tr class="seed-divider"><td colspan="5">First-round byes above</td></tr>');
      if (Number(r.playoff_seed) === 6) trs.push('<tr class="seed-divider hawk-divider"><td colspan="5">Playoff line · 7-12 play the Hawktuah Bowl</td></tr>');
    });
    var legend = 'AP% = All-Play % (your score vs all 11 others, every week) · W-L = record · Back = All-Play wins behind the 6th seed · ▲▼ = since last week' +
      (final ? '' : ' · BYE / DIV / WC say where a team would be if the season ended today') + ' · tap a team for details';
    mount.innerHTML = shell + summaryCardHtml(resp, rows) +
      '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(y) + (final ? ' · final seeds' : ' · seeds if the season ended today') + '</div>' +
      '<table class="ups-m-standings-table ups-m-seeds-table"><thead><tr><th>Seed</th><th class="team">Team</th><th class="num">AP%</th><th class="num">W-L</th><th class="num">Back</th></tr></thead>' +
      '<tbody>' + trs.join("") + '</tbody></table>' +
      '<div class="ups-m-standings-legend">' + U.escapeHtml(legend) + '</div></div>' + howSeedsWorkHtml();
    bindShell(mount);
    bindTeamRows(mount, "tr.race-row[data-fid]", resp, year);
  }

  // ── Final standings (finished seasons) ──
  function renderFinalStandings(mount, year, y, resp) {
    var shell = standingsShell(year, y, "seeds");
    var finishes = (state.finalFinishByYear || {})[y];
    if (!finishes) {
      mount.innerHTML = shell + (state._finalFinishLoading ? '<div class="ups-m-loading">Loading final standings…</div>' : failureHtml(y));
      bindShell(mount);
      return;
    }
    var seeds = state.recordedSeedByYear[y] || {};
    // 2010-2013: the recorded regular-season rank is not a playoff seed (conference brackets, #1329 history audit).
    var showSeed = Number(y) >= 2014;
    var rows = (resp.rows || []).slice().sort(function (a, b) {
      return ((finishes[U.pad4(a.franchise_id)] || 99) - (finishes[U.pad4(b.franchise_id)] || 99));
    });
    var trs = rows.map(function (r) {
      var fid = U.pad4(r.franchise_id);
      var f = finishes[fid] || 0;
      var champ = isChampion(r, year) || f === 1;
      var you = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
      var badge = (champ ? '<span class="div-crown" title="Champion">🏆</span> ' : "") + (f === 7 && Number(y) >= 2011 ? '<span class="div-crown" title="Hawktuah Bowl champion">🚽</span> ' : "");
      return '<tr class="' + (champ ? "champion" : "") + (you ? " you-row" : "") + (r.is_division_leader ? " div-winner" : "") + '">' +
        '<td class="rank">' + (f || "—") + '</td>' +
        '<td class="team">' + badge + U.escapeHtml(nm(r)) + (r.is_division_leader ? ' <span class="ups-m-div-tag">DIV</span>' : "") + '</td>' +
        (showSeed ? '<td class="num">' + (seeds[fid] ? seeds[fid] : "—") + '</td>' : "") +
        '<td class="num">' + recStr({ w: r.h2h_w, l: r.h2h_l, t: r.h2h_t }) + '</td>' +
        '<td class="num">' + fmtPct(r.allplay_pct) + '</td>' +
      '</tr>';
    }).join("");
    var era = Number(y) <= 2013
      ? '2010-2013 used different playoff formats (2011-2013: conference brackets), so the recorded regular-season rank isn’t shown as a seed.'
      : 'Seed = the recorded regular-season seed.';
    mount.innerHTML = shell +
      '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(y) + ' · final standings</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th>Fin</th><th class="team">Team</th>' + (showSeed ? '<th class="num">Seed</th>' : "") + '<th class="num">W-L</th><th class="num">AP%</th></tr></thead>' +
      '<tbody>' + trs + '</tbody></table>' +
      '<div class="ups-m-standings-legend">Fin = place after the playoffs (1 champion · 7 Hawktuah Bowl champion) · DIV = division winner · ' + U.escapeHtml(era) + ' Recorded final standings.</div></div>';
    bindShell(mount);
  }

  // ── Divisions ──
  function renderDivisionsMode(mount, year, y, resp) {
    var shell = standingsShell(year, y, "divisions");
    var rows = (resp.rows || []).filter(function (r) { return r.division != null && r.division !== ""; });
    if (!rows.length) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>Division alignment not available for ' + U.escapeHtml(y) + '.</div></div>';
      bindShell(mount);
      return;
    }
    var inSeason = resp.standings_basis === "regular_season_ladder";
    var unavailable = resp.standings_basis === "unavailable";
    var final = seasonState(resp) !== "in_season";
    var by = rowByFid(resp.rows);
    var byDiv = {};
    rows.forEach(function (r) {
      var k = String(r.division);
      if (!byDiv[k]) byDiv[k] = { name: r.division_name || ("Division " + k), teams: [] };
      byDiv[k].teams.push(r);
    });
    var cards = Object.keys(byDiv).sort().map(function (k) {
      var d = byDiv[k];
      // The worker's division order (MFL standingsSort); never re-sorted here.
      d.teams.sort(function (a, b) { return (a.division_rank || 99) - (b.division_rank || 99); });
      var lead = d.teams[0];
      var trs = d.teams.map(function (r) {
        var fid = U.pad4(r.franchise_id);
        var reg = regRec(r);
        var rec = reg ? reg.record : { w: r.h2h_w, l: r.h2h_l, t: r.h2h_t };
        var dv = reg ? reg.division : { w: r.div_w, l: r.div_l, t: 0 };
        var gb = r.division_games_back;
        if (gb == null && lead && !unavailable) gb = (((lead.h2h_w || 0) - (r.h2h_w || 0)) + ((r.h2h_l || 0) - (lead.h2h_l || 0))) / 2;
        var tag = r.is_division_leader ? ' <span class="ups-m-div-tag">' + (final ? "WON" : "LEADS") + '</span>' : "";
        var you = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
        return '<tr class="race-row' + (r.is_division_leader ? " div-winner" : "") + (you ? " you-row" : "") + '" data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(r)) + ' details">' +
          '<td class="team">' + U.escapeHtml(nm(r)) + tag + '</td>' +
          '<td class="num">' + recStr(rec) + '</td>' +
          '<td class="num">' + recStr(dv) + '</td>' +
          '<td class="num">' + (unavailable || gb == null ? "—" : (gb === 0 ? "—" : gb.toFixed(1).replace(/\.0$/, ""))) + '</td>' +
          '<td class="num">' + fmtPct(reg ? reg.all_play.pct : r.allplay_pct) + '</td>' +
        '</tr>';
      }).join("");
      // One reason line when a tie (not plain record) decided an order inside the division.
      var reasons = [];
      if (inSeason) d.teams.forEach(function (r) {
        var vb = r.division_reason && r.division_reason.vs_below;
        if (!vb || !vb.step || vb.step === "PCT") return;
        var below = by[U.pad4(vb.franchise_id)];
        if (!below) return;
        var a = regRec(r), b = regRec(below);
        var det = vb.step === "DIVPCT" && a && b ? "(" + recStr(a.division) + " vs " + recStr(b.division) + ")" : "";
        reasons.push(U.escapeHtml(nm(r)) + " over " + U.escapeHtml(nm(below)) + ": same record, " + U.escapeHtml(DIV_STEP_WORDS[vb.step] || vb.step) + (det ? " " + U.escapeHtml(det) : "") + ".");
      });
      return '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(d.name) + '</div>' +
        '<table class="ups-m-standings-table"><thead><tr><th class="team">Team</th><th class="num">W-L</th><th class="num">Div</th><th class="num">GB</th><th class="num">AP%</th></tr></thead><tbody>' + trs + '</tbody></table>' +
        (reasons.length ? '<div class="ups-m-standings-legend">' + reasons.join(" ") + '</div>' : "") + '</div>';
    }).join("");
    mount.innerHTML = shell + (unavailable ? '<div class="ups-m-stub" role="alert"><div>Division order unavailable: the weekly results couldn’t be verified.</div></div>' : "") + cards +
      '<div class="ups-m-standings-legend">Div = record against the two division rivals (each played five times) · GB = games behind the division leader · Order = record, then division record, then head-to-head (MFL’s rule)</div>';
    bindShell(mount);
    bindTeamRows(mount, "tr.race-row[data-fid]", resp, year);
  }

  // ── Weekly ──
  function renderWeeklyMode(mount, year, y, resp) {
    var shell = standingsShell(year, y, "weekly");
    var R = RACE();
    if (!R || !R.weekTable || !R.completedWeeks) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>Weekly results unavailable (shared module not loaded).</div></div>';
      bindShell(mount);
      return;
    }
    var cw = R.completedWeeks(resp);
    if (cw.status === "preseason" || (cw.status === "ok" && !cw.regular.length && !cw.playoff.length)) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>No completed weeks yet.</div></div>';
      bindShell(mount);
      return;
    }
    if (cw.status !== "ok") {
      mount.innerHTML = shell + '<div class="ups-m-stub" role="alert"><div>Weekly results couldn’t be verified, so nothing is ranked.</div></div>';
      bindShell(mount);
      return;
    }
    var weeks = cw.regular.concat(cw.playoff);
    var wk = state.weeklyWeek && weeks.indexOf(state.weeklyWeek) >= 0 ? state.weeklyWeek : cw.regular[cw.regular.length - 1] || weeks[weeks.length - 1];
    var chips = '<div class="ups-m-week-chips" role="group" aria-label="Week">' + weeks.map(function (w) {
      var po = cw.playoff.indexOf(w) >= 0;
      return '<button type="button" class="ups-m-week-chip' + (w === wk && state.weeklyScope === "week" ? " active" : "") + (po ? " po" : "") + '" data-week="' + w + '" aria-pressed="' + (w === wk && state.weeklyScope === "week") + '">' + (po ? "P" : "") + w + '</button>';
    }).join("") + '<button type="button" class="ups-m-week-chip season' + (state.weeklyScope === "season" ? " active" : "") + '" data-week="season" aria-pressed="' + (state.weeklyScope === "season") + '">Season</button></div>';
    var body = state.weeklyScope === "season" ? seasonLeadersHtml(R, resp) : weekTableHtml(R, resp, wk);
    mount.innerHTML = shell + chips + body;
    bindShell(mount);
    Array.prototype.forEach.call(mount.querySelectorAll("[data-week]"), function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-week");
        if (v === "season") state.weeklyScope = "season";
        else { state.weeklyScope = "week"; state.weeklyWeek = Number(v); }
        renderRoute();
      });
    });
    bindTeamRows(mount, "tr.race-row[data-fid]", resp, year);
  }
  // Season All-Play rank after this week and its change (descriptive; not the seed).
  function apRankLine(r) {
    if (!r || r.seasonApRank == null) return "";
    var c = r.apRankChange;
    var mv = c ? ' <span class="ups-m-move ' + (c > 0 ? "up" : "down") + '">' + (c > 0 ? "▲" : "▼") + Math.abs(c) + '</span>' : "";
    return '<div class="ups-m-apline">Season All-Play rank ' + r.seasonApRank + mv + '</div>';
  }
  function weekTableHtml(R, resp, wk) {
    var t = R.weekTable(resp, wk);
    if (!t || t.status !== "ok") return '<div class="ups-m-stub" role="alert"><div>Week ' + U.escapeHtml(String(wk)) + ' couldn’t be verified, so nothing is ranked.</div></div>';
    var by = rowByFid(resp.rows);
    var topNames = (t.top.franchise_ids || []).map(function (f) { return nm(by[U.pad4(f)]); }).join(" & ");
    var second = t.top.second_franchise_id ? nm(by[U.pad4(t.top.second_franchise_id)]) : "";
    var lowNames = (t.low.franchise_ids || []).map(function (f) { return nm(by[U.pad4(f)]); }).join(" & ");
    var card = '<div class="ups-m-card ups-m-standings-summary"><div class="line"><b>' + (t.isPlayoff ? "Playoff week " : "Week ") + wk + ' top score:</b> ' + U.escapeHtml(topNames) + ' ' + fmtPts(t.top.score) +
      (t.top.franchise_ids && t.top.franchise_ids.length === 1 && second ? ', +' + fmtPts(t.top.margin_over_second) + ' over ' + U.escapeHtml(second) : ' (tie)') + '.</div>' +
      '<div class="line"><b>Low:</b> ' + U.escapeHtml(lowNames) + ' ' + fmtPts(t.low.score) + '.</div></div>';
    var trs = t.rows.map(function (r) {
      var fid = U.pad4(r.franchise_id);
      var you = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
      var games = (r.games || []).map(function (g) { return g.result; }).join("");
      return '<tr class="race-row' + (you ? " you-row" : "") + '" data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(by[fid] || r)) + ' details">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="team">' + U.escapeHtml(nm(by[fid] || r)) + apRankLine(r) + '</td>' +
        '<td class="num">' + fmtPts(r.score) + '</td>' +
        '<td class="num">' + recStr(r.ap) + '</td>' +
        '<td class="num">' + (games ? recStr(r.record) : "—") + '</td>' +
      '</tr>';
    }).join("");
    return card + '<div class="ups-m-card"><table class="ups-m-standings-table"><thead><tr><th>Rk</th><th class="team">Team</th><th class="num">Pts</th><th class="num">Wk AP</th><th class="num">Games</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="ups-m-standings-legend">Rk = scoring rank that week · Wk AP = that week’s score against all 11 others · Games = head-to-head results that week · ▲▼ = change in season All-Play rank' + (t.isPlayoff ? ' · playoff week: not part of the regular-season All-Play' : '') + ' · scores are MFL’s and can change with stat corrections</div></div>';
  }
  function seasonLeadersHtml(R, resp) {
    var s = R.seasonWeeklyLeaders ? R.seasonWeeklyLeaders(resp, { weeks: "regular" }) : null;
    if (!s || s.status !== "ok") return '<div class="ups-m-stub" role="alert"><div>Season weekly leaders unavailable.</div></div>';
    var by = rowByFid(resp.rows);
    var list = Object.keys(s.byFranchise).map(function (fid) { return { fid: U.pad4(fid), v: s.byFranchise[fid] }; });
    // Descriptive list: most top-score weeks first, then best average weekly rank.
    list.sort(function (a, b) { return (b.v.topWeeks - a.v.topWeeks) || (a.v.avgRank - b.v.avgRank); });
    var trs = list.map(function (e) {
      var you = M.state.viewerFranchiseId && e.fid === M.state.viewerFranchiseId;
      return '<tr class="race-row' + (you ? " you-row" : "") + '" data-fid="' + e.fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(by[e.fid])) + ' details">' +
        '<td class="team">' + U.escapeHtml(nm(by[e.fid])) + '</td>' +
        '<td class="num">' + e.v.topWeeks + '</td>' +
        '<td class="num">' + e.v.top3 + '</td>' +
        '<td class="num">' + e.v.bottom3 + '</td>' +
        '<td class="num">' + (e.v.avgRank == null ? "—" : e.v.avgRank.toFixed(1)) + '</td>' +
      '</tr>';
    }).join("");
    var weeksLine = s.weeks.map(function (w) {
      return 'W' + w.week + ' ' + U.escapeHtml((w.top_franchise_ids || []).map(function (f) { return nm(by[U.pad4(f)]); }).join(" & ")) + ' ' + fmtPts(w.score);
    }).join(" · ");
    return '<div class="ups-m-card ups-m-standings-summary"><div class="line"><b>Top score each week:</b> ' + weeksLine + '</div></div>' +
      '<div class="ups-m-card"><table class="ups-m-standings-table"><thead><tr><th class="team">Team</th><th class="num">Top</th><th class="num">Top 3</th><th class="num">Bot 3</th><th class="num">Avg rk</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="ups-m-standings-legend">Regular-season weeks · Top = weeks with the league’s top score · Top 3 / Bot 3 = weeks among the three highest / lowest scores · Avg rk = average weekly scoring rank (1 best)</div></div>';
  }

  function renderStandingsModeToggle(mode) {
    function b(key, label) {
      return '<a class="ups-m-subtab' + (key === mode ? ' active' : '') +
             '" href="#" role="button" aria-pressed="' + (key === mode ? "true" : "false") +
             '" data-sw-mode="' + key + '">' + label + '</a>';
    }
    // "ups-m-mode-toggle" scopes the >=44px touch-target CSS to this control only.
    return '<div class="ups-m-action-chips ups-m-mode-toggle">' + b("seeds", "Seeds") + b("divisions", "Divisions") + b("weekly", "Weekly") + b("playoffs", "Playoffs") + '</div>';
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
