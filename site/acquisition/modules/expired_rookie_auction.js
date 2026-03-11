(function () {
  "use strict";

  window.UPS_ACQ_MODULES = window.UPS_ACQ_MODULES || {};

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function safeFloat(value, fallback) {
    if (value == null || value === "") return fallback == null ? 0 : fallback;
    var n = Number(value);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function getLocal(moduleState) {
    return (moduleState && moduleState.local) || {};
  }

  function getPage(moduleState) {
    return safeStr(getLocal(moduleState).page).toLowerCase() === "reports" ? "reports" : "live";
  }

  function reportOptions() {
    return [
      { key: "historical-winners", label: "Historical Winners" },
      { key: "post-auction-results", label: "Post-Auction Results" }
    ];
  }

  function currentReport(moduleState) {
    return safeStr(getLocal(moduleState).reportKey).toLowerCase() === "post-auction-results"
      ? "post-auction-results"
      : "historical-winners";
  }

  function filters(moduleState, prefix) {
    var local = getLocal(moduleState);
    var base = prefix === "report" ? "report" : "live";
    return {
      search: safeStr(local[base + "Search"]).toLowerCase(),
      teamId: safeStr(local[base + "TeamId"]),
      position: safeStr(local[base + "Position"]).toUpperCase(),
      nflTeam: safeStr(local[base + "NflTeam"]).toUpperCase(),
      sortKey: safeStr(local[base + "SortKey"]),
      sortDir: safeStr(local[base + "SortDir"]).toLowerCase() === "asc" ? "asc" : "desc"
    };
  }

  function dropdownOptions(values) {
    var seen = {};
    var out = [];
    (values || []).forEach(function (value) {
      var text = safeStr(value);
      if (!text || seen[text]) return;
      seen[text] = true;
      out.push(text);
    });
    return out.sort();
  }

  function renderSelect(id, label, value, options, includeBlank, blankLabel, h, dataAttr) {
    return '' +
      '<label class="acq-field"><span>' + h.escapeHtml(label) + '</span>' +
        '<select id="' + h.escapeHtml(id) + '"' + (dataAttr ? ' ' + dataAttr : "") + '>' +
          (includeBlank ? '<option value="">' + h.escapeHtml(blankLabel || "All") + "</option>" : "") +
          (options || []).map(function (option) {
            var optionValue = typeof option === "object" ? option.key : option;
            var optionLabel = typeof option === "object" ? option.label : option;
            return '<option value="' + h.escapeHtml(safeStr(optionValue)) + '"' + (safeStr(optionValue) === safeStr(value) ? " selected" : "") + '>' + h.escapeHtml(safeStr(optionLabel)) + "</option>";
          }).join("") +
        "</select>" +
      "</label>";
  }

  function teamIconHtml(row, h) {
    var icon = safeStr(row && row.icon_url);
    var label = safeStr(row && (row.franchise_name || row.team_name || row.franchise_abbrev || row.franchise_id || "Team"));
    var abbr = safeStr(row && (row.franchise_abbrev || row.franchise_id || label)).slice(0, 3).toUpperCase();
    return icon
      ? '<img class="acq-teamIcon" src="' + h.escapeHtml(icon) + '" alt="' + h.escapeHtml(label) + '" title="' + h.escapeHtml(label) + '">'
      : '<span class="acq-teamIconFallback" title="' + h.escapeHtml(label) + '">' + h.escapeHtml(abbr) + "</span>";
  }

  function playerCellHtml(row, h) {
    var meta = [safeStr(row && row.position), safeStr(row && row.nfl_team)].filter(Boolean).join(" · ");
    return '' +
      '<div class="acq-playerCell">' +
        '<strong>' + h.escapeHtml(safeStr(row && row.player_name)) + "</strong>" +
        (meta ? '<span class="acq-playerCell-meta">' + h.escapeHtml(meta) + "</span>" : "") +
      "</div>";
  }

  function rowSearchText(row) {
    return [
      row && row.player_name,
      row && row.position,
      row && row.nfl_team,
      row && row.franchise_name,
      row && row.team_name,
      row && row.contract_type,
      row && row.high_bidder_label
    ].join(" ").toLowerCase();
  }

  function filterRows(rows, appliedFilters, teamKey) {
    var key = teamKey || "franchise_id";
    return (rows || []).filter(function (row) {
      if (appliedFilters.teamId && safeStr(row && row[key]) !== appliedFilters.teamId) return false;
      if (appliedFilters.position && safeStr(row && (row.pos_group || row.position)).toUpperCase() !== appliedFilters.position && safeStr(row && row.position).toUpperCase() !== appliedFilters.position) return false;
      if (appliedFilters.nflTeam && safeStr(row && row.nfl_team).toUpperCase() !== appliedFilters.nflTeam) return false;
      if (appliedFilters.search && rowSearchText(row).indexOf(appliedFilters.search) === -1) return false;
      return true;
    });
  }

  function sortRows(rows, key, dir) {
    var sortKey = safeStr(key);
    var direction = dir === "asc" ? 1 : -1;
    return (rows || []).slice().sort(function (a, b) {
      var aValue = a && a[sortKey];
      var bValue = b && b[sortKey];
      var aNum = Number(aValue);
      var bNum = Number(bValue);
      if (isFinite(aNum) && isFinite(bNum)) return (aNum - bNum) * direction;
      return safeStr(aValue).localeCompare(safeStr(bValue)) * direction;
    });
  }

  function reportSortOptions(reportKey) {
    if (reportKey === "post-auction-results") {
      return [
        { key: "season", label: "Season" },
        { key: "player_name", label: "Player" },
        { key: "bid_amount", label: "Bid" },
        { key: "points_y1", label: "Y1 Points" },
        { key: "points_y2", label: "Y2 Points" },
        { key: "points_y3", label: "Y3 Points" }
      ];
    }
    return [
      { key: "season", label: "Season" },
      { key: "player_name", label: "Player" },
      { key: "position", label: "Position" },
      { key: "team_name", label: "Winner" },
      { key: "bid_amount", label: "Bid" }
    ];
  }

  function defaultReportSort() {
    return "season";
  }

  function renderPageSwitch(active, h) {
    return '' +
      '<div class="acq-inline-actions acq-subviewSwitch">' +
        '<button type="button" class="acq-btn ' + (active === "live" ? "acq-btn-primary" : "acq-btn-secondary") + '" data-acq-exp-page="live">Live / Event</button>' +
        '<button type="button" class="acq-btn ' + (active === "reports" ? "acq-btn-primary" : "acq-btn-secondary") + '" data-acq-exp-page="reports">Reports</button>' +
      '</div>';
  }

  function pickerPool(live) {
    var seen = {};
    var out = [];
    function pushRow(row, mode) {
      var playerId = safeStr(row && row.player_id);
      if (!playerId || seen[playerId]) return;
      seen[playerId] = true;
      out.push({
        player_id: playerId,
        player_name: safeStr(row && row.player_name),
        position: safeStr(row && row.position),
        nfl_team: safeStr(row && row.nfl_team),
        contract_type: safeStr(row && row.contract_type),
        displayed_bid: row && row.high_bid_amount,
        source_mode: mode
      });
    }
    (live.active_auctions || []).forEach(function (row) { pushRow(row, "active"); });
    (live.eligible_players || []).forEach(function (row) { pushRow(row, "eligible"); });
    return out.sort(function (a, b) {
      return safeFloat(a.displayed_bid, 0) - safeFloat(b.displayed_bid, 0) ||
        safeStr(a.player_name).localeCompare(safeStr(b.player_name));
    });
  }

  function selectedPlayer(moduleState, live) {
    var selectedId = safeStr(getLocal(moduleState).selectedPlayerId);
    var pool = pickerPool(live);
    for (var i = 0; i < pool.length; i += 1) {
      if (safeStr(pool[i].player_id) === selectedId) return pool[i];
    }
    return null;
  }

  function pickerRows(moduleState, live) {
    var query = safeStr(getLocal(moduleState).pickerQuery).toLowerCase();
    return pickerPool(live).filter(function (row) {
      if (!query) return true;
      return [row.player_name, row.position, row.nfl_team].join(" ").toLowerCase().indexOf(query) !== -1;
    }).slice(0, 18);
  }

  function renderLiveFilters(ctx, live) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var appliedFilters = filters(moduleState, "live");
    var teamOptions = (((ctx.bootstrap && ctx.bootstrap.league && ctx.bootstrap.league.franchises) || []).map(function (row) {
      return { key: safeStr(row.franchise_id), label: safeStr(row.franchise_name) };
    }));
    var allRows = []
      .concat(live.eligible_players || [])
      .concat(live.active_auctions || []);
    var positionOptions = dropdownOptions(allRows.map(function (row) { return safeStr(row && row.position).toUpperCase(); }).filter(Boolean));
    var nflTeamOptions = dropdownOptions(allRows.map(function (row) { return safeStr(row && row.nfl_team).toUpperCase(); }).filter(Boolean));
    return '' +
      '<section class="acq-card acq-card-filters">' +
        '<div class="acq-filterStrip">' +
          '<label class="acq-field acq-field-search"><span>Search</span><input id="acqExpLiveSearch" type="search" value="' + h.escapeHtml(appliedFilters.search) + '" placeholder="Search player, team, contract"></label>' +
          renderSelect("acqExpLiveTeam", "Team", appliedFilters.teamId, teamOptions, true, "All Teams", h) +
          renderSelect("acqExpLivePos", "Position", appliedFilters.position, positionOptions, true, "All Positions", h) +
          renderSelect("acqExpLiveNfl", "NFL Team", appliedFilters.nflTeam, nflTeamOptions, true, "All NFL Teams", h) +
        '</div>' +
      '</section>';
  }

  function renderReportFilters(ctx, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var reportKey = currentReport(moduleState);
    var appliedFilters = filters(moduleState, "report");
    var teamOptions = (((ctx.bootstrap && ctx.bootstrap.league && ctx.bootstrap.league.franchises) || []).map(function (row) {
      return { key: safeStr(row.franchise_id), label: safeStr(row.franchise_name) };
    }));
    var sourceRows = reportKey === "post-auction-results" ? (history.post_auction_rows || []) : (history.history_rows || []);
    var positionOptions = dropdownOptions(sourceRows.map(function (row) { return safeStr(row && row.position).toUpperCase(); }).filter(Boolean));
    return '' +
      '<section class="acq-card acq-card-filters">' +
        '<div class="acq-filterStrip">' +
          renderSelect("acqExpReportKey", "Report", reportKey, reportOptions(), false, "", h) +
          '<label class="acq-field acq-field-search"><span>Search</span><input id="acqExpReportSearch" type="search" value="' + h.escapeHtml(appliedFilters.search) + '" placeholder="Search player, team"></label>' +
          renderSelect("acqExpReportTeam", "Team", appliedFilters.teamId, teamOptions, true, "All Teams", h) +
          renderSelect("acqExpReportPos", "Position", appliedFilters.position, positionOptions, true, "All Positions", h) +
          renderSelect("acqExpReportSort", "Sort By", appliedFilters.sortKey || defaultReportSort(reportKey), reportSortOptions(reportKey), false, "", h) +
          renderSelect("acqExpReportDir", "Direction", appliedFilters.sortDir || "desc", [{ key: "desc", label: "Desc" }, { key: "asc", label: "Asc" }], false, "", h) +
        '</div>' +
      '</section>';
  }

  function renderActionCard(ctx, live) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var local = getLocal(moduleState);
    var selected = selectedPlayer(moduleState, live);
    var rows = pickerRows(moduleState, live);
    return '' +
      '<section class="acq-card">' +
        '<div class="acq-card-head"><h3>Bid / Nominate</h3></div>' +
        '<form id="acqExpActionForm" class="acq-form-grid">' +
          '<label class="acq-field"><span>Player</span><input id="acqExpPickerInput" type="search" autocomplete="off" placeholder="Search eligible or active players" value="' + h.escapeHtml(selected ? selected.player_name : safeStr(local.pickerQuery)) + '"></label>' +
          '<div class="acq-pickerResults">' +
            (selected
              ? '<div class="acq-pickerSelected"><div><strong>' + h.escapeHtml(selected.player_name) + '</strong><span>' + h.escapeHtml([selected.position, selected.nfl_team, selected.contract_type, selected.source_mode === "active" ? "Active auction" : "Eligible"].filter(Boolean).join(" · ")) + '</span></div><button type="button" class="acq-btn acq-btn-secondary" data-acq-exp-clear="1">Change</button></div>'
              : (rows.length
                ? rows.map(function (row) {
                    return '' +
                      '<button type="button" class="acq-pickerRow" data-acq-exp-pick="' + h.escapeHtml(row.player_id) + '" data-acq-exp-name="' + h.escapeHtml(row.player_name) + '">' +
                        '<strong>' + h.escapeHtml(row.player_name) + '</strong>' +
                        '<span>' + h.escapeHtml([row.position, row.nfl_team, row.contract_type, row.source_mode === "active" ? "Active auction" : "Eligible"].filter(Boolean).join(" · ")) + '</span>' +
                      '</button>';
                  }).join("")
                : '<div class="acq-empty">No expired-rookie candidates match the current search.</div>')) +
          '</div>' +
          '<label class="acq-field"><span>Amount</span><input name="amount" type="number" min="1" step="1" value="' + h.escapeHtml(safeStr(local.bidAmount || "1000")) + '" placeholder="1000"></label>' +
          '<div class="acq-inline-actions">' +
            '<button type="submit" class="acq-btn acq-btn-primary" name="mode" value="bid">Submit Bid</button>' +
            '<button type="submit" class="acq-btn acq-btn-secondary" name="mode" value="nominate">Nominate Player</button>' +
          '</div>' +
        '</form>' +
        '<div id="acqExpActionStatus" class="acq-note"></div>' +
      '</section>';
  }

  function renderLivePage(ctx, live) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var appliedFilters = filters(moduleState, "live");
    var eligibleRows = filterRows(live.eligible_players || [], appliedFilters);
    var eligibleByPlayer = {};
    eligibleRows.forEach(function (row) {
      eligibleByPlayer[safeStr(row.player_id)] = row;
    });
    var activeRows = filterRows((live.active_auctions || []).map(function (row) {
      var currentOwner = eligibleByPlayer[safeStr(row.player_id)] || {};
      return Object.assign({}, row, {
        franchise_id: row.franchise_id || currentOwner.franchise_id,
        franchise_name: row.franchise_name || currentOwner.franchise_name,
        franchise_abbrev: row.franchise_abbrev || currentOwner.franchise_abbrev,
        icon_url: row.icon_url || currentOwner.icon_url,
        contract_type: row.contract_type || currentOwner.contract_type
      });
    }), appliedFilters);
    return '' +
      '<div class="acq-page">' +
        '<section class="acq-card acq-card-hero">' +
          '<div>' +
            '<div class="acq-kicker">Expired Rookie Auction</div>' +
            '<h2 class="acq-section-title">Live / Event</h2>' +
            '<p class="acq-muted">Eligibility is derived live from rookie-like contracts with zero years remaining, excluding tagged, extended, and already-awarded players.</p>' +
          '</div>' +
          renderPageSwitch("live", h) +
          '<div class="acq-kpi-grid">' +
            '<div class="acq-kpi"><span class="acq-kpi-label">Eligible Pool</span><strong>' + String((live.eligible_players || []).length) + '</strong></div>' +
            '<div class="acq-kpi"><span class="acq-kpi-label">Active Auctions</span><strong>' + String((live.active_auctions || []).length) + '</strong></div>' +
            '<div class="acq-kpi"><span class="acq-kpi-label">Extension Markers</span><strong>' + String((live.extension_markers || []).length) + '</strong></div>' +
          '</div>' +
        '</section>' +
        renderLiveFilters(ctx, live) +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Eligible Pool</h3><span class="acq-pill">' + String(eligibleRows.length) + ' players</span></div>' +
          h.renderTable([
            { key: "franchise_id", label: "Current Team", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
            { key: "contract_type", label: "Contract" },
            { key: "years_remaining", label: "Years" }
          ], eligibleRows, "No eligible expired rookies match the current filters.", { wrapClass: "acq-table-wrap-scroll acq-table-wrap-tall" }) +
        '</section>' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Active Auctions</h3><span class="acq-pill">' + String(activeRows.length) + ' auctions</span></div>' +
          h.renderTable([
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
            { key: "high_bid_amount", label: "High Bid" },
            { key: "high_bidder_label", label: "Leader" },
            { key: "timer_text", label: "Clock" }
          ], activeRows, "No expired-rookie auction rows match the current filters.", { wrapClass: "acq-table-wrap-scroll" }) +
        '</section>' +
        renderActionCard(ctx, live) +
      '</div>';
  }

  function renderReportsPage(ctx, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var reportKey = currentReport(moduleState);
    var appliedFilters = filters(moduleState, "report");
    var rows = reportKey === "post-auction-results" ? (history.post_auction_rows || []) : (history.history_rows || []);
    var filtered = filterRows(rows, appliedFilters, "franchise_id");
    var sorted = sortRows(filtered, appliedFilters.sortKey || defaultReportSort(reportKey), appliedFilters.sortDir);
    var reportHtml = reportKey === "post-auction-results"
      ? h.renderTable([
          { key: "season", label: "Season" },
          { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
          { key: "franchise_id", label: "Winner", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
          { key: "bid_amount", label: "Bid" },
          { key: "points_y1", label: "Y1 Pts" },
          { key: "points_y2", label: "Y2 Pts" },
          { key: "points_y3", label: "Y3 Pts" }
        ], sorted, "No post-auction rows match the current filters.", { wrapClass: "acq-table-wrap-scroll acq-table-wrap-tall" })
      : h.renderTable([
          { key: "season", label: "Season" },
          { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
          { key: "franchise_id", label: "Winner", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
          { key: "bid_amount", label: "Bid" },
          { key: "datetime_et", label: "Finalized" }
        ], sorted, "No historical winner rows match the current filters.", { wrapClass: "acq-table-wrap-scroll acq-table-wrap-tall" });
    return '' +
      '<div class="acq-page">' +
        '<section class="acq-card acq-card-hero">' +
          '<div>' +
            '<div class="acq-kicker">Expired Rookie Reports</div>' +
            '<h2 class="acq-section-title">Reports</h2>' +
            '<p class="acq-muted">Use one report at a time for cleaner scrolling and sorting across the full history set.</p>' +
          '</div>' +
          renderPageSwitch("reports", h) +
        '</section>' +
        renderReportFilters(ctx, history) +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>' + h.escapeHtml((reportOptions().find(function (row) { return row.key === reportKey; }) || {}).label || "Report") + '</h3><span class="acq-pill">' + String(sorted.length) + ' rows</span></div>' +
          reportHtml +
        '</section>' +
      '</div>';
  }

  window.UPS_ACQ_MODULES["expired-rookie-auction"] = {
    key: "expired-rookie-auction",
    title: "Expired Rookie Auction",
    historyPath: "/acquisition-hub/expired-rookie-auction/history",
    livePath: "/acquisition-hub/expired-rookie-auction/live",
    refresh: { visibleMs: 30000, hiddenMs: 60000 },
    render: function (ctx) {
      var moduleState = ctx.moduleState || {};
      return getPage(moduleState) === "reports"
        ? renderReportsPage(ctx, moduleState.history || {})
        : renderLivePage(ctx, moduleState.live || {});
    },
    bind: function (root, ctx) {
      var statusEl = root.querySelector("#acqExpActionStatus");

      function setStatus(message, tone) {
        if (!statusEl) return;
        statusEl.className = "acq-note" + (tone ? (" is-" + tone) : "");
        statusEl.textContent = message;
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-exp-page]"), function (button) {
        button.addEventListener("click", function () {
          ctx.setLocalState({ page: safeStr(button.getAttribute("data-acq-exp-page")) === "reports" ? "reports" : "live" });
        });
      });

      var liveSearch = root.querySelector("#acqExpLiveSearch");
      if (liveSearch) liveSearch.addEventListener("input", function () { ctx.setLocalState({ liveSearch: safeStr(liveSearch.value) }); });
      var liveTeam = root.querySelector("#acqExpLiveTeam");
      if (liveTeam) liveTeam.addEventListener("change", function () { ctx.setLocalState({ liveTeamId: safeStr(liveTeam.value) }); });
      var livePos = root.querySelector("#acqExpLivePos");
      if (livePos) livePos.addEventListener("change", function () { ctx.setLocalState({ livePosition: safeStr(livePos.value) }); });
      var liveNfl = root.querySelector("#acqExpLiveNfl");
      if (liveNfl) liveNfl.addEventListener("change", function () { ctx.setLocalState({ liveNflTeam: safeStr(liveNfl.value) }); });

      var reportKey = root.querySelector("#acqExpReportKey");
      if (reportKey) reportKey.addEventListener("change", function () { ctx.setLocalState({ reportKey: safeStr(reportKey.value) }); });
      var reportSearch = root.querySelector("#acqExpReportSearch");
      if (reportSearch) reportSearch.addEventListener("input", function () { ctx.setLocalState({ reportSearch: safeStr(reportSearch.value) }); });
      var reportTeam = root.querySelector("#acqExpReportTeam");
      if (reportTeam) reportTeam.addEventListener("change", function () { ctx.setLocalState({ reportTeamId: safeStr(reportTeam.value) }); });
      var reportPos = root.querySelector("#acqExpReportPos");
      if (reportPos) reportPos.addEventListener("change", function () { ctx.setLocalState({ reportPosition: safeStr(reportPos.value) }); });
      var reportSort = root.querySelector("#acqExpReportSort");
      if (reportSort) reportSort.addEventListener("change", function () { ctx.setLocalState({ reportSortKey: safeStr(reportSort.value) }); });
      var reportDir = root.querySelector("#acqExpReportDir");
      if (reportDir) reportDir.addEventListener("change", function () { ctx.setLocalState({ reportSortDir: safeStr(reportDir.value) }); });

      var pickerInput = root.querySelector("#acqExpPickerInput");
      if (pickerInput) {
        pickerInput.addEventListener("input", function () {
          ctx.setLocalState({
            pickerQuery: safeStr(pickerInput.value),
            selectedPlayerId: "",
            selectedPlayerName: ""
          });
        });
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-exp-pick]"), function (button) {
        button.addEventListener("click", function () {
          ctx.setLocalState({
            selectedPlayerId: safeStr(button.getAttribute("data-acq-exp-pick")),
            selectedPlayerName: safeStr(button.getAttribute("data-acq-exp-name")),
            pickerQuery: safeStr(button.getAttribute("data-acq-exp-name"))
          });
        });
      });

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-exp-clear]"), function (button) {
        button.addEventListener("click", function () {
          ctx.setLocalState({ selectedPlayerId: "", selectedPlayerName: "", pickerQuery: "" });
        });
      });

      var form = root.querySelector("#acqExpActionForm");
      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var submitter = event.submitter;
          var mode = safeStr(submitter && submitter.value).toLowerCase() === "nominate" ? "nominate" : "bid";
          var fd = new FormData(form);
          var local = getLocal(ctx.moduleState || {});
          if (!safeStr(local.selectedPlayerId)) {
            setStatus("Select a player by name before submitting the auction action.", "bad");
            return;
          }
          setStatus("Submitting expired-rookie auction action...", "info");
          ctx.postAction("/acquisition-hub/expired-rookie-auction/action", {
            action: mode,
            player_id: safeStr(local.selectedPlayerId),
            player_name: safeStr(local.selectedPlayerName || local.pickerQuery),
            amount: safeStr(fd.get("amount"))
          }).then(function () {
            ctx.setLocalState({
              selectedPlayerId: "",
              selectedPlayerName: "",
              pickerQuery: "",
              bidAmount: safeStr(fd.get("amount"))
            });
            setStatus("Expired-rookie action submitted. Refreshing live board...", "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Expired-rookie action failed.", "bad");
          });
        });
      }
    }
  };
})();
