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

  // ---------- Playoffs: vertical brackets (Standings v3, #1329) ----------
  // Bracket fetch, cached per year like state.standingsByYear — but a
  // FAILED fetch is never cached as permanent "no data": it's retried
  // automatically after a short cooldown (state.bracketErrorAt), so a
  // transient outage can't look identical to a legitimately empty
  // pre-playoff bracket for the rest of the session.
  state.bracketByYear = state.bracketByYear || {};
  state.bracketLoading = state.bracketLoading || null;
  state.bracketErrorAt = state.bracketErrorAt || {};
  state.playoffSide = state.playoffSide || "champ"; // "champ" (UPS Playoffs) | "hawk" (Hawk Tuah Bowl) | "seeds"
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

  // Tale of the Tape inputs, both lazy (only when a matchup is opened) and free of D1 reads:
  //  · offensive-player / IDP points: MFL's public leagueStandings (op / dp) through the worker's export proxy;
  //    seasons before 2017 were other MFL leagues, so they show "not available";
  //  · head-to-head history of finished seasons: the static site/standings/h2h_history.json.
  state.offIdpByYear = state.offIdpByYear || {};
  state.offIdpLoading = state.offIdpLoading || {};
  function loadOffenseIdp(year) {
    var y = String(year);
    if (Object.prototype.hasOwnProperty.call(state.offIdpByYear, y)) return Promise.resolve(state.offIdpByYear[y]);
    if (state.offIdpLoading[y]) return state.offIdpLoading[y];
    if (Number(y) < 2017) { state.offIdpByYear[y] = null; return Promise.resolve(null); }
    state.offIdpLoading[y] = fetch(API.workerUrl("/api/mfl-export?TYPE=leagueStandings&L=74598&YEAR=" + encodeURIComponent(y) + "&JSON=1"), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var fr = j && j.leagueStandings && j.leagueStandings.franchise;
        fr = Array.isArray(fr) ? fr : (fr ? [fr] : null);
        var map = null;
        if (fr) { map = {}; fr.forEach(function (f) { if (f && f.id != null) map[U.pad4(f.id)] = { op: f.op, dp: f.dp }; }); }
        return map;
      })
      .catch(function () { return null; })
      .then(function (m) { state.offIdpByYear[y] = m; delete state.offIdpLoading[y]; return m; });
    return state.offIdpLoading[y];
  }
  function loadH2hHistory() {
    if (state.h2hHistory !== undefined) return Promise.resolve(state.h2hHistory);
    if (state._h2hLoading) return state._h2hLoading;
    state._h2hLoading = fetch("/upsmflproduction/standings/h2h_history.json", { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) { state.h2hHistory = j; state._h2hLoading = null; return j; });
    return state._h2hLoading;
  }

  // Seeds read 1-6 on the UPS Playoffs side and H1-H6 on the Hawk Tuah Bowl side (overall 7th-12th).
  function seedText(seed, sideKey) {
    var n = Number(seed);
    if (!n) return "";
    return sideKey === "hawk" || n >= 7 ? "H" + (n - 6) : String(n);
  }
  function finishOrd(n) { return ordinal(n); }
  // What a game decides, from the shared finish/pick table (never a hand-written copy).
  function decidesLine(sideKey, gameKey) {
    var slots = (window.UPS_STANDINGS_RACE.BRACKET_FINISH_SLOTS || []).filter(function (s) { return s.side === sideKey && s.game === gameKey; });
    var w = slots.filter(function (s) { return s.role === "winner"; })[0], l = slots.filter(function (s) { return s.role === "loser"; })[0];
    if (!w || !l) return "";
    return "Winner " + finishOrd(w.finish) + " (pick " + w.pick + ") · loser " + finishOrd(l.finish) + " (pick " + l.pick + ")";
  }
  // Kept for the desktop-parity wiring tests: the winner/loser pick of one game.
  function pickLabelsForGame(sideKey, gameKey) {
    var slots = (window.UPS_STANDINGS_RACE.BRACKET_FINISH_SLOTS || []).filter(function (s) { return s.side === sideKey && s.game === gameKey; });
    var winnerSlot = slots.filter(function (s) { return s.role === "winner"; })[0];
    var loserSlot = slots.filter(function (s) { return s.role === "loser"; })[0];
    if (!winnerSlot) return null; // R1/semis games don't directly decide a single pick — don't fabricate one
    return "Winner → " + winnerSlot.pick + (loserSlot ? " · Loser → " + loserSlot.pick : "");
  }
  // One team line in a bracket game. kind "projected": no score, "advances (proj.)" on the chalk winner;
  // kind "actual": the score, "✓ won" on the winner of a decided game.
  function bkTeamHtml(e, score, isWin, o, src) {
    if (!e) return '<div class="ups-m-bk-team tbd"><span class="seed"></span><span class="nm">' + U.escapeHtml(src || "To be decided") + '</span></div>';
    var proj = o.kind === "projected";
    var you = M.state.viewerFranchiseId && U.pad4(e.franchise_id) === M.state.viewerFranchiseId;
    return '<div class="ups-m-bk-team' + (isWin ? " win" : "") + (you ? " you" : "") + '">' +
      '<span class="seed">' + U.escapeHtml(seedText(e.seed, o.sideKey)) + '</span>' +
      '<span class="nm">' + U.escapeHtml(e.franchise_name || e.franchise_id) + (src ? '<span class="src">' + U.escapeHtml(src) + '</span>' : '') + '</span>' +
      (proj ? '' : '<span class="sc">' + (score == null ? "—" : Number(score).toFixed(1)) + '</span>') +
      (isWin ? (proj ? '<span class="adv proj">advances (proj.)</span>' : '<span class="adv">✓ won</span>') : '') +
    '</div>';
  }
  // One bracket game (shared-module game shape). Tapping it, or its Tale of the Tape button, opens the matchup sheet.
  function bkGameHtml(g, o) {
    var proj = o.kind === "projected";
    var done = !proj && g && !g.pending;
    var tag = proj ? '<span class="ups-m-bk-tag proj">Projected</span>' : (done ? '<span class="ups-m-bk-tag final">Final</span>' : '<span class="ups-m-bk-tag">Not final</span>');
    var aWin = !!(g && g.winner && g.a && g.winner.franchise_id === g.a.franchise_id);
    var bWin = !!(g && g.winner && g.b && g.winner.franchise_id === g.b.franchise_id);
    var canTape = !!(g && g.a && g.b);
    var round = o.title + (o.week ? " · Week " + o.week : "");
    var attrs = canTape
      ? ' data-tape-a="' + U.escapeHtml(g.a.franchise_id) + '" data-tape-b="' + U.escapeHtml(g.b.franchise_id) + '" data-tape-side="' + o.sideKey + '"' +
        ' data-tape-kind="' + (proj ? "projected" : (done ? "final" : "scheduled")) + '" data-tape-round="' + U.escapeHtml(round) + '"' +
        ' role="button" tabindex="0" aria-label="' + U.escapeHtml(round + ": " + (g.a.franchise_name || g.a.franchise_id) + " vs " + (g.b.franchise_name || g.b.franchise_id) + ". Open the Tale of the Tape") + '"'
      : '';
    return '<div class="ups-m-bk-game' + (proj ? " proj" : "") + (o.minor ? " minor" : "") + '"' + attrs + '>' +
      '<div class="ups-m-bk-meta"><span>' + U.escapeHtml(o.title) + '</span>' + tag + '</div>' +
      bkTeamHtml(g && g.a, g && g.scoreA, aWin, o, o.srcA) +
      bkTeamHtml(g && g.b, g && g.scoreB, bWin, o, o.srcB) +
      ((o.decides || canTape) ? '<div class="ups-m-bk-foot"><span class="decides">' + U.escapeHtml(o.decides || "") + '</span>' +
        (canTape ? '<button type="button" class="ups-m-bk-tape" tabindex="-1" aria-hidden="true">Tale of the Tape</button>' : '') + '</div>' : '') +
    '</div>';
  }
  function bkRoundHtml(title, week, inner) {
    return '<section class="ups-m-bk-round"><h3 class="ups-m-bk-rh">' + U.escapeHtml(title) + (week ? ' <span>Week ' + week + '</span>' : '') + '</h3>' + inner + '</section>';
  }
  function bkEmpty(text) { return '<div class="ups-m-bk-empty">' + U.escapeHtml(text) + '</div>'; }
  var BK_ARROW = '<div class="ups-m-bk-arrow" aria-hidden="true">↓ winners advance</div>';
  function playoffWeeksOf(raw) {
    return (Array.isArray(raw) && raw.length === 3) ? raw.map(Number).sort(function (a, b) { return a - b; }) : [15, 16, 17];
  }
  // One side's bracket, top to bottom: Round 1 (+ byes) → semifinals (+ 5th-place game) → final (+ 3rd-place game).
  // side = the shared module's { r1, semis, placement, final, third }; byes = the side's top two seeds.
  function sideBracketHtml(side, sideKey, kind, weeks, byes) {
    var hawk = sideKey === "hawk", proj = kind === "projected";
    var w1 = weeks[0], w2 = weeks[1], w3 = weeks[2];
    var r1 = side.r1 || [], semis = side.semis || [];
    function feederText(g) { return g && g.a && g.b ? "winner of " + seedText(g.a.seed, sideKey) + " v " + seedText(g.b.seed, sideKey) + " (projected)" : ""; }
    var r1Html = r1.length ? r1.map(function (g) { return bkGameHtml(g, { kind: kind, sideKey: sideKey, title: "Round 1", week: w1 }); }).join("") : bkEmpty("Round 1 games appear once MFL sets them.");
    var byeHtml = (byes && byes.length) ? '<div class="ups-m-bk-byes"><b>First-round byes:</b> ' + byes.map(function (e) {
      return '<span class="seed">' + U.escapeHtml(seedText(e.seed, sideKey)) + '</span> ' + U.escapeHtml(e.franchise_name || e.franchise_id);
    }).join(" · ") + '</div>' : "";
    // Projected semifinals: seed 1 meets the winner of 4 v 5, seed 2 the winner of 3 v 6 (the shared chalk bracket).
    var semiHtml = semis.length ? semis.map(function (g, i) {
      return bkGameHtml(g, { kind: kind, sideKey: sideKey, title: "Semifinal", week: w2, srcB: proj ? feederText(i === 0 ? r1[1] : r1[0]) : "" });
    }).join("") : bkEmpty("Set after Week " + w1 + "’s games.");
    var placeHtml = side.placement ? bkGameHtml(side.placement, { kind: kind, sideKey: sideKey, title: "5th-place game · Round 1 losers", week: w2, minor: true, decides: decidesLine(sideKey, "placement") }) : "";
    var finalHtml = side.final ? bkGameHtml(side.final, { kind: kind, sideKey: sideKey, title: hawk ? "Hawk Tuah Bowl final" : "Championship", week: w3, decides: decidesLine(sideKey, "final") }) : bkEmpty("Set after Week " + w2 + "’s games.");
    var thirdHtml = side.third ? bkGameHtml(side.third, { kind: kind, sideKey: sideKey, title: "3rd-place game · semifinal losers", week: w3, minor: true, decides: decidesLine(sideKey, "third") }) : "";
    return '<div class="ups-m-bk ' + sideKey + '">' +
      bkRoundHtml("Round 1", w1, r1Html + byeHtml) + BK_ARROW +
      bkRoundHtml("Semifinals", w2, semiHtml + placeHtml) + BK_ARROW +
      bkRoundHtml(hawk ? "Final" : "Championship", w3, finalHtml + thirdHtml) +
    '</div>';
  }
  function sideSeeds(seeds, sideKey) {
    var v = window.UPS_STANDINGS_RACE.validateBracketSeeds(seeds);
    if (!v.ok) return [];
    return v.seeds.filter(function (s) { return sideKey === "hawk" ? s.seed >= 7 : s.seed <= 6; }).sort(function (a, b) { return a.seed - b.seed; });
  }
  // Real results (playoff weeks under way, or a finished season): only decided games carry a winner; a round MFL
  // hasn't set yet says so (never a projection drawn over real results).
  function renderActualMatchupCards(seeds, matchups, playoffWeeksRaw, sideKey, complete) {
    var result = window.UPS_STANDINGS_RACE.buildActualBracketResult(seeds, matchups, playoffWeeksRaw);
    if (result.status !== "ok") {
      return '<div class="ups-m-stub"><div>Playoff bracket data unavailable' + (result.reason ? (": " + U.escapeHtml(result.reason)) : ".") + '</div></div>';
    }
    var side = sideKey === "hawk" ? result.hawk : result.champ;
    var byes = sideSeeds(seeds, sideKey).slice(0, 2);
    return '<div class="ups-m-bk-status">' + (complete ? '<b>Final results.</b>' : '<b>Results so far.</b> Later rounds fill in as games are played; nothing here is projected.') + '</div>' +
      sideBracketHtml(side, sideKey, "actual", playoffWeeksOf(playoffWeeksRaw), byes);
  }
  // Projected bracket (A2's chalk helper over the worker's validated seeds; never re-seeded here).
  function renderProjectedBracket(seeds, bresp, sideKey) {
    var R = window.UPS_STANDINGS_RACE;
    var p = R.projectChalkBracket(seeds);
    if (!p || p.status !== "ok") {
      var why = bresp && bresp.seeding_status === "unavailable" ? "the weekly results couldn’t be verified" : (p && p.reason) || "no seeds yet";
      return '<div class="ups-m-stub" role="alert"><div>Projected bracket unavailable: ' + U.escapeHtml(why) + '.</div></div>';
    }
    var side = sideKey === "hawk" ? p.hawk : p.champ;
    return '<div class="ups-m-bk-status proj"><b>If the season ended today.</b> Projection: the higher seed wins every game. Nothing here is decided until it’s played.</div>' +
      sideBracketHtml(side, sideKey, "projected", playoffWeeksOf(bresp && bresp.playoff_weeks), side.semis.map(function (g) { return g.a; }));
  }
  // The Hawk Tuah Bowl's own seeds, order and tiebreaks, above its bracket.
  function hawkIntroHtml(seeds, y, recorded) {
    var list = sideSeeds(seeds, "hawk");
    var raw = {};
    (seeds || []).forEach(function (s) { if (s && s.franchise_id != null) raw[U.pad4(s.franchise_id)] = s; });
    var lis = list.map(function (s) {
      var r = raw[s.franchise_id] || {};
      var ap = r.regular_season && r.regular_season.all_play;
      var va = r.seed_reason && r.seed_reason.vs_above;
      var tie = (!recorded && va && va.step && va.step !== "all_play" && s.seed > 7) ? ' <span class="why">behind ' + U.escapeHtml(va.name || "") + ': ' + U.escapeHtml(STEP_WORDS[va.step] || va.step) + '</span>' : '';
      return '<li><span class="seed">' + seedText(s.seed, "hawk") + '</span> ' + U.escapeHtml(s.franchise_name) + (ap ? ' <span class="sub">' + recStr(ap) + ' AP</span>' : '') + tie + '</li>';
    }).join("");
    return '<div class="ups-m-card ups-m-hawk-intro"><div class="ups-m-card-title">Hawk Tuah Bowl <span class="sub">· the toilet bowl</span></div>' +
      '<div class="line">' + (recorded ? 'The recorded Hawk Tuah Bowl seeds.' : 'The six teams outside the playoff field, seeded H1–H6 (7th–12th) in standings order: All-Play %, then H2H record, then Points For.') +
        ' H1 and H2 get a first-round bye. The winner finishes 7th and picks 1.01 in the ' + (Number(y) + 1) + ' rookie draft.</div>' +
      (lis ? '<ol class="ups-m-hawk-seeds">' + lis + '</ol>' : '') + '</div>';
  }
  // The compact Seeds option of the Playoffs view: 1-12 in order, each with its seed explanation.
  function playoffSeedsListHtml(bresp, resp, recorded) {
    var R = RACE();
    var rr = (!recorded && resp && R) ? raceFor(resp) : null;
    var v = window.UPS_STANDINGS_RACE.validateBracketSeeds(bresp.seeds || []);
    if (!v.ok) return '<div class="ups-m-stub"><div>Seeds unavailable.</div></div>';
    var lis = v.seeds.slice().sort(function (a, b) { return a.seed - b.seed; }).map(function (s) {
      var why = rr && rr.byFranchise[s.franchise_id] && rr.byFranchise[s.franchise_id].whySeed;
      var txt = recorded ? "Recorded seed (MFL’s bracket)." : (why && !why.blocked ? why.text : "");
      return '<li class="' + (s.seed >= 7 ? "hawk" : "") + '"><span class="seed">' + seedText(s.seed) + '</span><div><div class="nm">' + U.escapeHtml(s.franchise_name) + '</div>' +
        (txt ? '<div class="why">' + U.escapeHtml(txt) + '</div>' : '') + '</div></li>' +
        (s.seed === 6 ? '<li class="line">Playoff line · H1–H6 play the Hawk Tuah Bowl</li>' : '');
    }).join("");
    return '<div class="ups-m-card"><div class="ups-m-card-title">' + (recorded ? "Recorded seeds" : "Seeds and why") + '</div><ol class="ups-m-seed-why">' + lis + '</ol></div>';
  }
  function renderPlayoffSideToggle(side) {
    function b(key, label) {
      return '<button type="button" class="ups-m-seg' + (key === side ? " active" : "") + '" aria-pressed="' + (key === side) + '" data-po-side="' + key + '">' + label + '</button>';
    }
    return '<div class="ups-m-segs" role="group" aria-label="Bracket">' + b("champ", "UPS Playoffs") + b("hawk", "Hawk Tuah Bowl") + b("seeds", "Seeds") + '</div>';
  }

  // Top-level Playoffs-mode render — loading / actual / projected /
  // unavailable are FOUR distinct, textually-distinguishable states (never a
  // false empty picture while the fetch is in flight, and a failed fetch is
  // never indistinguishable from a legitimately empty bracket — see
  // loadPlayoffBracketForYear's cooldown-retry above).
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
    var side = state.playoffSide;
    // F9 (Phase II-A2 correction pass): the SAME shared gating decision
    // desktop's renderBracket()/renderDraftOrder() use — never a mobile-
    // local "matchups.length / !season_complete" conditional pair.
    var mode = window.UPS_STANDINGS_RACE.projectionMode({ seasonComplete: bresp.season_complete, matchups: matchups, seeds: seeds });
    var recorded = bresp.season_complete === true;
    var body;
    if (side === "seeds") {
      body = (mode === "unavailable" && !seeds.length) ? '<div class="ups-m-stub"><div>No seeds for ' + U.escapeHtml(y) + '.</div></div>' : playoffSeedsListHtml(bresp, state.standingsByYear[y], recorded);
    } else if (mode === "actual") {
      body = (side === "hawk" ? hawkIntroHtml(seeds, y, recorded) : "") + renderActualMatchupCards(seeds, matchups, bresp.playoff_weeks, side, recorded);
    } else if (mode === "projected") {
      // In season: the bracket the worker's seeds make if the season ended today (higher seed wins every game, labeled
      // as a projection) and what each game decides.
      body = (side === "hawk" ? hawkIntroHtml(seeds, y, false) : "") + renderProjectedBracket(seeds, bresp, side);
    } else {
      body = '<div class="ups-m-stub"><div>No playoff data for ' + U.escapeHtml(y) + '.</div></div>';
    }
    mount.innerHTML = shell + renderPlayoffSideToggle(side) + body;
    bindYearPicker(mount);
    bindStandingsModeToggle(mount);
    Array.prototype.forEach.call(mount.querySelectorAll("[data-po-side]"), function (b) {
      b.addEventListener("click", function () { state.playoffSide = b.getAttribute("data-po-side"); renderRoute(); });
    });
    bindTapeGames(mount, year, y);
  }

  // ── Tale of the Tape (a full-width sheet over the bracket) ──
  function bindTapeGames(mount, year, y) {
    Array.prototype.forEach.call(mount.querySelectorAll("[data-tape-a]"), function (el) {
      var go = function () {
        openTape(y, el.getAttribute("data-tape-a"), el.getAttribute("data-tape-b"), {
          side: el.getAttribute("data-tape-side"), kind: el.getAttribute("data-tape-kind"), round: el.getAttribute("data-tape-round")
        }, el);
      };
      el.addEventListener("click", go);
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); go(); }
      });
    });
  }
  var tapeToken = 0;
  function openTape(y, aFid, bFid, meta, trigger) {
    var R = RACE(), resp = state.standingsByYear[y];
    if (!R || !R.matchupTape || !resp || !M.standingsSheet) return;
    var token = ++tapeToken;
    var by = rowByFid(resp.rows);
    var seedOf = {};
    ((state.bracketByYear[y] || {}).seeds || []).forEach(function (s) { if (s) seedOf[U.pad4(s.franchise_id)] = s.seed; });
    var a = U.pad4(aFid), b = U.pad4(bFid);
    var ownerA = (by[a] && by[a].owner_name) || "", ownerB = (by[b] && by[b].owner_name) || "";
    function body() {
      var t = R.matchupTape(resp, a, b, { offenseIdp: state.offIdpByYear[y] || null });
      var hist = state.h2hHistory;
      var current = (hist && t.status === "ok" && Number(y) > Number(hist.through_season))
        ? { season: Number(y), games: t.meetings.map(function (g) { return { week: g.week, isPlayoff: g.isPlayoff, aScore: g.aScore, bScore: g.bScore }; }) } : null;
      var series = hist === undefined ? { status: "loading" } : R.ownerSeries(hist, ownerA, ownerB, { current: current });
      return M.standingsSheet.tapeHtml(t, {
        kind: meta.kind, roundLabel: meta.round, aSeed: seedText(seedOf[a], meta.side), bSeed: seedText(seedOf[b], meta.side),
        aOwner: ownerA, bOwner: ownerB, series: series, offenseIdpLoading: !Object.prototype.hasOwnProperty.call(state.offIdpByYear, String(y))
      });
    }
    M.standingsSheet.open({ title: "Tale of the Tape", sub: nm(by[a]) + " vs " + nm(by[b]), body: body(), trigger: trigger });
    Promise.all([loadOffenseIdp(y), loadH2hHistory()]).then(function () { if (token === tapeToken) M.standingsSheet.setBody(body()); });
  }

  // ---------- Standings v3 (2026-10-17, #1329) ----------
  // One source: the worker's /api/standings. In season it sends rows in playoff-seed order with each seed's status
  // and reason (worker/src/standings_truth.js); this view never ranks a team itself. Finished seasons show the
  // recorded final standings (finish after the playoffs + the recorded regular-season seed), never a recomputed seed.
  var RACE = function () { return window.UPS_STANDINGS_RACE || null; };
  var STEP_WORDS = {
    all_play: "a better All-Play %",
    overall: "a better H2H record",
    points_for: "more Points For",
    head_to_head: "the H2H games between them",
    name: "a tie on every step (listed alphabetically)",
    franchise_id: "a tie on every step",
    bye_requires_division_title: "a first-round bye needs a division title",
    division_winner_in_field: "division winners are in the field"
  };
  var DIV_STEP_WORDS = {
    PCT: "a better H2H record", DIVPCT: "a better division record", H2H: "the H2H games between them",
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

  // ── Explanations live in drawers, opened from compact buttons at the top of each view ──
  function infoButtonsHtml(keys) {
    return '<div class="ups-m-info-row">' + keys.map(function (k) {
      return '<button type="button" class="ups-m-info-btn" data-info="' + k[0] + '" aria-haspopup="dialog">' + U.escapeHtml(k[1]) + '</button>';
    }).join("") + '</div>';
  }
  function bindInfoButtons(mount, contentFor) {
    Array.prototype.forEach.call(mount.querySelectorAll("[data-info]"), function (b) {
      b.addEventListener("click", function () {
        var c = contentFor(b.getAttribute("data-info"));
        if (c && M.standingsSheet) M.standingsSheet.open({ title: c.title, body: c.body, trigger: b });
      });
    });
  }
  function howSeedingHtml() {
    return '<ol class="ups-m-drawer-list">' +
      '<li>The four division winners make the playoffs. A division is won on H2H record, then division record, then the H2H games between the tied teams (MFL’s order).</li>' +
      '<li>The two best division winners are seeds 1 and 2 and get a first-round bye.</li>' +
      '<li>Seeds 3–6 are the other two division winners and the two best other teams (wild cards), in ladder order.</li>' +
      '<li>Ladder: All-Play %, then H2H record, then Points For, then the H2H games between the tied teams. Only regular-season weeks count.</li>' +
      '<li>The other six teams play the Hawk Tuah Bowl (the toilet bowl), seeded H1–H6 in standings order. H1 and H2 get a first-round bye.</li>' +
      '</ol>' +
      '<div class="ups-m-drawer-p"><b>Draft order comes from the final finish.</b> Hawk Tuah Bowl champion (7th) 1.01 · 8th 1.02 · 9th 1.03 · 10th 1.04 · 11th 1.05 · 12th 1.06 · 5th-place game winner (5th) 1.07 · its loser (6th) 1.08 · 4th 1.09 · 3rd 1.10 · runner-up 1.11 · champion 1.12.</div>' +
      '<div class="ups-m-drawer-p sub">All-Play = your score against all 11 other teams every week (11 results a week). League rule §F.1.</div>';
  }
  function aboutSeedsHtml(final) {
    return '<dl class="ups-m-drawer-dl">' +
      '<dt>AP%</dt><dd>All-Play %: the share of the other 11 teams you outscored, every regular-season week.</dd>' +
      '<dt>H2H</dt><dd>Head-to-head record: your games against your scheduled opponents (two or three a week).</dd>' +
      '<dt>Back</dt><dd>All-Play wins behind the 6th seed (ties count half).</dd>' +
      '<dt>▲▼</dt><dd>Places gained or lost since last week.</dd>' +
      '<dt>BYE · DIV · WC</dt><dd>First-round bye · division winner · wild card.' + (final ? '' : ' “proj” = where a team would be if the season ended today.') + '</dd>' +
      '<dt>H1–H6</dt><dd>Hawk Tuah Bowl seed (7th–12th).</dd>' +
      '</dl><div class="ups-m-drawer-p sub">Final MFL scores only. MFL can change a score with a stat correction. Tap a team for its details.</div>';
  }
  // Every place in the order that a tiebreak (not All-Play %) decided, the next team out, and the byes.
  function whyOrderHtml(resp, rows) {
    var by = rowByFid(rows);
    var lines = [];
    var seeded = rows.filter(function (r) { return r.playoff_seed != null; }).sort(function (a, b) { return a.playoff_seed - b.playoff_seed; });
    var final = seasonState(resp) !== "in_season";
    if (seeded.length >= 2) lines.push('<b>' + (final ? "Byes:" : "Byes if the season ended today:") + '</b> ' + U.escapeHtml(seeded.filter(function (r) { return r.playoff_seed <= 2; }).map(nm).join(" and ")) + ' (the two best division winners).');
    var rs = resp.regular_season || {};
    var out = rs.next_out ? by[U.pad4(rs.next_out)] : null;
    if (out && seeded[5] && !final) lines.push('<b>Next out:</b> ' + U.escapeHtml(nm(out)) + (out.ap_back != null ? ", " + U.escapeHtml(String(out.ap_back)) + " All-Play win" + (out.ap_back === 1 ? "" : "s") + " behind " + U.escapeHtml(nm(seeded[5])) + " (6th)" : "") + '.');
    var ties = [];
    rows.forEach(function (r) {
      var va = r.seed_reason && r.seed_reason.vs_above;
      if (!va || !va.step || va.step === "all_play") return;
      var up = by[U.pad4(va.franchise_id)];
      if (!up) return;
      var rr = regRec(r), ru = regRec(up), detail = "";
      if (va.step === "overall" && rr && ru) detail = "(" + recStr(ru.record) + " vs " + recStr(rr.record) + ")";
      if (va.step === "points_for" && rr && ru) detail = "(" + fmtPts(ru.points_for) + " vs " + fmtPts(rr.points_for) + ")";
      var same = va.step === "overall" || va.step === "points_for" || va.step === "head_to_head" ? "same All-Play, " : "";
      ties.push('<li>' + U.escapeHtml(nm(up)) + " over " + U.escapeHtml(nm(r)) + ": " + same + U.escapeHtml(STEP_WORDS[va.step] || va.step) + (detail ? " " + U.escapeHtml(detail) : "") + '.</li>');
    });
    lines.push(ties.length ? '<b>Decided by a tiebreak:</b><ul class="ups-m-drawer-list">' + ties.join("") + '</ul>' : '<b>Tiebreaks:</b> none — every place is decided by All-Play %.');
    return lines.map(function (l) { return '<div class="ups-m-drawer-p">' + l + '</div>'; }).join("");
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
  // Facts that stay on the page: the byes and the next team out. Everything explanatory is in a drawer.
  function factsHtml(resp, rows) {
    var by = rowByFid(rows);
    var seeded = rows.filter(function (r) { return r.playoff_seed != null; }).sort(function (a, b) { return a.playoff_seed - b.playoff_seed; });
    if (seeded.length < 6) return "";
    var final = seasonState(resp) !== "in_season";
    var rs = resp.regular_season || {};
    var out = rs.next_out ? by[U.pad4(rs.next_out)] : null;
    var bits = ['<b>Byes:</b> ' + U.escapeHtml(seeded.filter(function (r) { return r.playoff_seed <= 2; }).map(nm).join(" and "))];
    if (out && !final) bits.push('<b>Next out:</b> ' + U.escapeHtml(nm(out)) + (out.ap_back != null ? ", " + U.escapeHtml(String(out.ap_back)) + " AP win" + (out.ap_back === 1 ? "" : "s") + " back" : ""));
    return '<div class="ups-m-facts">' + bits.join(' · ') + '</div>';
  }
  function bindSeedsInfo(mount, resp, rows, final) {
    bindInfoButtons(mount, function (k) {
      if (k === "how") return { title: "How seeding works", body: howSeedingHtml() };
      if (k === "why") return { title: "Why this order", body: whyOrderHtml(resp, rows) };
      if (k === "about") return { title: "About the seeds table", body: aboutSeedsHtml(final) };
      return null;
    });
  }
  function bindJumps(mount) {
    Array.prototype.forEach.call(mount.querySelectorAll("[data-jump-side]"), function (b) {
      b.addEventListener("click", function () {
        state.standingsMode = "playoffs";
        state.playoffSide = b.getAttribute("data-jump-side");
        renderRoute();
      });
    });
  }
  function renderSeedsMode(mount, year, y, resp) {
    var rows = (resp.rows || []).slice();
    var shell = standingsShell(year, y, "seeds");
    var info = infoButtonsHtml([["how", "How seeding works"], ["why", "Why this order"], ["about", "About"]]);
    if (resp.preseason || resp.standings_basis === "preseason") {
      mount.innerHTML = shell + info + '<div class="ups-m-stub"><div>No games played yet. Seeds start after Week 1.</div></div>';
      bindShell(mount); bindSeedsInfo(mount, resp, rows, false);
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
    rows.forEach(function (r, i) {
      var fid = U.pad4(r.franchise_id);
      var reg = regRec(r);
      var st = RACE() ? RACE().statusForRow(r) : null;
      var you = M.state.viewerFranchiseId && fid === M.state.viewerFranchiseId;
      var ap = reg ? reg.all_play : { w: r.allplay_w, l: r.allplay_l, t: r.allplay_t, pct: r.allplay_pct };
      var rec = reg ? reg.record : { w: r.h2h_w, l: r.h2h_l, t: r.h2h_t };
      // Rows arrive in the worker's order: seeds 1-6, then the Hawk Tuah Bowl seeds H1-H6 (7th-12th).
      var seedCell = r.playoff_seed != null ? String(r.playoff_seed) : (i >= 6 && i < 12 ? "H" + (i - 5) : "—");
      trs.push('<tr class="race-row' + (you ? " you-row" : "") + (r.playoff_seed == null ? " hawk-row" : "") + '" data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(r)) + ' details">' +
        '<td class="rank">' + seedCell + '</td>' +
        '<td class="team"><span class="name-text">' + U.escapeHtml(nm(r)) + '</span>' + moveHtml(r) + statusChipHtml(st, !final) + '</td>' +
        '<td class="num">' + fmtPct(ap.pct) + '</td>' +
        '<td class="num">' + recStr(rec) + '</td>' +
        '<td class="num">' + (r.ap_back == null ? "—" : U.escapeHtml(String(r.ap_back))) + '</td>' +
      '</tr>');
      if (Number(r.playoff_seed) === 2) trs.push('<tr class="seed-divider"><td colspan="5">First-round byes above</td></tr>');
      if (Number(r.playoff_seed) === 6) trs.push('<tr class="seed-divider hawk-divider"><td colspan="5">Playoff line · H1–H6 play the Hawk Tuah Bowl</td></tr>');
    });
    var jumps = '<div class="ups-m-jumps"><button type="button" class="ups-m-jump" data-jump-side="champ">Playoff bracket</button>' +
      '<button type="button" class="ups-m-jump hawk" data-jump-side="hawk">Hawk Tuah Bowl</button></div>';
    mount.innerHTML = shell + info + jumps +
      '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(y) + (final ? ' · final seeds' : ' · seeds if the season ended today') + '</div>' +
      '<table class="ups-m-standings-table ups-m-seeds-table"><thead><tr><th>Seed</th><th class="team">Team</th><th class="num">AP%</th><th class="num">H2H</th><th class="num">Back</th></tr></thead>' +
      '<tbody>' + trs.join("") + '</tbody></table>' + factsHtml(resp, rows) + '</div>';
    bindShell(mount);
    bindSeedsInfo(mount, resp, rows, final);
    bindJumps(mount);
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
      var badge = (champ ? '<span class="div-crown" title="Champion">🏆</span> ' : "") + (f === 7 && Number(y) >= 2011 ? '<span class="div-crown" title="Hawk Tuah Bowl champion">🚽</span> ' : "");
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
    mount.innerHTML = shell + infoButtonsHtml([["about", "About"]]) +
      '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(y) + ' · final standings</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th>Fin</th><th class="team">Team</th>' + (showSeed ? '<th class="num">Seed</th>' : "") + '<th class="num">H2H</th><th class="num">AP%</th></tr></thead>' +
      '<tbody>' + trs + '</tbody></table>' +
      '<div class="ups-m-facts">Recorded final standings.</div></div>';
    bindShell(mount);
    bindInfoButtons(mount, function () {
      return { title: "About final standings", body: '<dl class="ups-m-drawer-dl">' +
        '<dt>Fin</dt><dd>Place after the playoffs: 1 champion · 7 Hawk Tuah Bowl champion (🚽).</dd>' +
        '<dt>Seed</dt><dd>' + U.escapeHtml(era) + '</dd>' +
        '<dt>H2H · AP%</dt><dd>The recorded regular-season head-to-head record and All-Play %.</dd>' +
        '<dt>DIV</dt><dd>Division winner.</dd></dl>' +
        '<div class="ups-m-drawer-p sub">These are the stored results. Corrections found in the #1329 history audit are waiting on the commissioner’s ruling.</div>' };
    });
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
      // One reason line when a tie (not plain H2H record) decided an order inside the division.
      var reasons = [];
      if (inSeason) d.teams.forEach(function (r) {
        var vb = r.division_reason && r.division_reason.vs_below;
        if (!vb || !vb.step || vb.step === "PCT") return;
        var below = by[U.pad4(vb.franchise_id)];
        if (!below) return;
        var a = regRec(r), b = regRec(below);
        var det = vb.step === "DIVPCT" && a && b ? "(" + recStr(a.division) + " vs " + recStr(b.division) + ")" : "";
        reasons.push(U.escapeHtml(nm(r)) + " over " + U.escapeHtml(nm(below)) + ": same H2H record, " + U.escapeHtml(DIV_STEP_WORDS[vb.step] || vb.step) + (det ? " " + U.escapeHtml(det) : "") + ".");
      });
      return '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(d.name) + '</div>' +
        '<table class="ups-m-standings-table"><thead><tr><th class="team">Team</th><th class="num">H2H</th><th class="num">Div</th><th class="num">GB</th><th class="num">AP%</th></tr></thead><tbody>' + trs + '</tbody></table>' +
        (reasons.length ? '<div class="ups-m-facts">' + reasons.join(" ") + '</div>' : "") + '</div>';
    }).join("");
    mount.innerHTML = shell + infoButtonsHtml([["about", "About divisions"]]) + (unavailable ? '<div class="ups-m-stub" role="alert"><div>Division order unavailable: the weekly results couldn’t be verified.</div></div>' : "") + cards;
    bindShell(mount);
    bindInfoButtons(mount, function () {
      return { title: "About divisions", body: '<dl class="ups-m-drawer-dl">' +
        '<dt>H2H</dt><dd>Head-to-head record.</dd>' +
        '<dt>Div</dt><dd>H2H record against the two division rivals (each played five times).</dd>' +
        '<dt>GB</dt><dd>H2H games behind the division leader.</dd>' +
        '<dt>Order</dt><dd>H2H record, then division record, then the H2H games between the tied teams (MFL’s rule).</dd>' +
        '<dt>LEADS · WON</dt><dd>Division leader now · division winner (season over).</dd></dl>' };
    });
    bindTeamRows(mount, "tr.race-row[data-fid]", resp, year);
  }

  // ── Weekly ──
  function aboutWeeklyHtml() {
    return '<dl class="ups-m-drawer-dl">' +
      '<dt>Rk</dt><dd>Scoring rank that week (1 = highest; ties share a rank).</dd>' +
      '<dt>Pts</dt><dd>MFL’s final score for the week. A stat correction can change it.</dd>' +
      '<dt>Wk AP</dt><dd>That week’s All-Play record: your score against all 11 other teams.</dd>' +
      '<dt>H2H</dt><dd>Head-to-head record that week (two or three games a week).</dd>' +
      '<dt>Top score</dt><dd>The week’s highest score and its margin over the second-highest.</dd>' +
      '<dt>Season summary</dt><dd>Top = weeks with the top score · Top 3 / Bot 3 = weeks among the three highest / lowest scores · Avg rk = average weekly scoring rank. Regular-season and playoff weeks are counted separately.</dd>' +
      '</dl>';
  }
  function renderWeeklyMode(mount, year, y, resp) {
    var shell = standingsShell(year, y, "weekly") + infoButtonsHtml([["weekly", "About weekly"]]);
    var R = RACE();
    var bindAbout = function () { bindInfoButtons(mount, function () { return { title: "About weekly", body: aboutWeeklyHtml() }; }); };
    if (!R || !R.weekTable || !R.completedWeeks) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>Weekly results unavailable (shared module not loaded).</div></div>';
      bindShell(mount); bindAbout();
      return;
    }
    var cw = R.completedWeeks(resp);
    if (cw.status === "preseason" || (cw.status === "ok" && !cw.regular.length && !cw.playoff.length)) {
      mount.innerHTML = shell + '<div class="ups-m-stub"><div>No completed weeks yet.</div></div>';
      bindShell(mount); bindAbout();
      return;
    }
    if (cw.status !== "ok") {
      mount.innerHTML = shell + '<div class="ups-m-stub" role="alert"><div>Weekly results couldn’t be verified, so nothing is ranked.</div></div>';
      bindShell(mount); bindAbout();
      return;
    }
    var weeks = cw.regular.concat(cw.playoff);
    var wk = state.weeklyWeek && weeks.indexOf(state.weeklyWeek) >= 0 ? state.weeklyWeek : cw.regular[cw.regular.length - 1] || weeks[weeks.length - 1];
    var season = state.weeklyScope === "season";
    function chip(w) {
      var on = w === wk && !season;
      return '<button type="button" class="ups-m-week-chip' + (on ? " active" : "") + '" data-week="' + w + '" aria-pressed="' + on + '">' + w + '</button>';
    }
    var chips = '<div class="ups-m-week-groups">' +
      '<div class="ups-m-week-group"><span class="lbl">Regular season</span><div class="ups-m-week-chips" role="group" aria-label="Regular-season week">' + cw.regular.map(chip).join("") + '</div></div>' +
      (cw.playoff.length ? '<div class="ups-m-week-group po"><span class="lbl">Playoff weeks</span><div class="ups-m-week-chips" role="group" aria-label="Playoff week">' + cw.playoff.map(chip).join("") + '</div></div>' : '') +
      '<div class="ups-m-week-group"><div class="ups-m-week-chips"><button type="button" class="ups-m-week-chip season' + (season ? " active" : "") + '" data-week="season" aria-pressed="' + season + '">Season summary</button></div></div>' +
    '</div>';
    var body = season ? seasonLeadersHtml(R, resp, cw) : weekTableHtml(R, resp, wk);
    mount.innerHTML = shell + chips + body;
    bindShell(mount); bindAbout();
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
      var played = (r.games || []).length > 0;
      return '<tr class="race-row' + (you ? " you-row" : "") + '" data-fid="' + fid + '" tabindex="0" role="button" aria-label="' + U.escapeHtml(nm(by[fid] || r)) + ' details">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="team">' + U.escapeHtml(nm(by[fid] || r)) + '</td>' +
        '<td class="num">' + fmtPts(r.score) + '</td>' +
        '<td class="num">' + recStr(r.ap) + '</td>' +
        '<td class="num">' + (played ? recStr(r.record) : "—") + '</td>' +
      '</tr>';
    }).join("");
    return card + '<div class="ups-m-card"><table class="ups-m-standings-table"><thead><tr><th>Rk</th><th class="team">Team</th><th class="num">Pts</th><th class="num">Wk AP</th><th class="num">H2H</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      (t.isPlayoff ? '<div class="ups-m-facts">Playoff week: not part of the regular-season All-Play.</div>' : '') + '</div>';
  }
  function leadersTableHtml(R, resp, mode, title) {
    var s = R.seasonWeeklyLeaders ? R.seasonWeeklyLeaders(resp, { weeks: mode }) : null;
    if (!s || s.status !== "ok") return '<div class="ups-m-stub" role="alert"><div>' + U.escapeHtml(title) + ': unavailable.</div></div>';
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
      return 'Wk ' + w.week + ' ' + U.escapeHtml((w.top_franchise_ids || []).map(function (f) { return nm(by[U.pad4(f)]); }).join(" & ")) + ' ' + fmtPts(w.score);
    }).join(" · ");
    var span = s.weeks.length ? " (Weeks " + s.weeks[0].week + (s.weeks.length > 1 ? "–" + s.weeks[s.weeks.length - 1].week : "") + ")" : "";
    return '<div class="ups-m-card"><div class="ups-m-card-title">' + U.escapeHtml(title + span) + '</div>' +
      '<table class="ups-m-standings-table"><thead><tr><th class="team">Team</th><th class="num">Top</th><th class="num">Top 3</th><th class="num">Bot 3</th><th class="num">Avg rk</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="ups-m-facts"><b>Top score each week:</b> ' + weeksLine + '</div></div>';
  }
  function seasonLeadersHtml(R, resp, cw) {
    return leadersTableHtml(R, resp, "regular", "Regular season") + (cw && cw.playoff && cw.playoff.length ? leadersTableHtml(R, resp, "playoff", "Playoff weeks") : "");
  }

  function renderStandingsModeToggle(mode) {
    function b(key, label) {
      return '<a class="ups-m-subtab' + (key === mode ? ' active' : '') +
             '" href="#" role="button" aria-pressed="' + (key === mode ? "true" : "false") +
             '" data-sw-mode="' + key + '">' + label + '</a>';
    }
    // "ups-m-mode-toggle" scopes the >=44px touch-target CSS to this control only.
    return '<div class="ups-m-action-chips ups-m-mode-toggle">' + b("seeds", "Seeds") + b("playoffs", "Playoffs") + b("weekly", "Weekly") + b("divisions", "Divisions") + '</div>';
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
