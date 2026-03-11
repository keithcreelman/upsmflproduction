(function () {
  "use strict";

  window.UPS_ACQ_MODULES = window.UPS_ACQ_MODULES || {};

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  function safeInt(value, fallback) {
    var n = parseInt(String(value == null ? "" : value), 10);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function safeFloat(value, fallback) {
    if (value == null || value === "") return fallback == null ? 0 : fallback;
    var n = Number(value);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function pickLabel(row) {
    return safeInt(row && row.round, safeInt(row && row.draft_round, 0)) +
      "." +
      String(safeInt(row && row.pick_in_round, safeInt(row && row.pick, 0))).padStart(2, "0");
  }

  function compactAdp(row) {
    var value = row && (row.displayed_adp != null ? row.displayed_adp : row.normalized_adp);
    if (value == null || value === "") return "—";
    var n = Number(value);
    return isFinite(n) ? String(Math.round(n * 100) / 100) : safeStr(value);
  }

  function teamIconHtml(row, h) {
    var icon = safeStr(row && (row.icon_url || row.franchise_icon_url));
    var label = safeStr(row && (row.franchise_name || row.franchise_abbrev || row.franchise_id || row.owner_name || "Team"));
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
      row && row.owner_name,
      row && row.pick_label,
      row && row.status
    ].join(" ").toLowerCase();
  }

  function getLocal(moduleState) {
    return (moduleState && moduleState.local) || {};
  }

  function getPage(moduleState) {
    return safeStr(getLocal(moduleState).page).toLowerCase() === "reports" ? "reports" : "live";
  }

  function reportOptions() {
    return [
      { key: "historical-picks", label: "Historical Picks" },
      { key: "owner-results", label: "Owner Results" },
      { key: "pick-slot-results", label: "Pick Slot Results" },
      { key: "pick-bucket-baseline", label: "Pick Bucket Baseline" },
      { key: "value-score-methodology", label: "Value Score Methodology" }
    ];
  }

  function currentReportKey(moduleState) {
    var selected = safeStr(getLocal(moduleState).reportKey).toLowerCase();
    var allowed = reportOptions().map(function (row) { return row.key; });
    return allowed.indexOf(selected) >= 0 ? selected : "historical-picks";
  }

  function currentSeason(moduleState, history) {
    var requested = safeStr(getLocal(moduleState).reportSeason);
    if (requested) return requested;
    return safeStr(history && history.selected_season) || safeStr((history && history.available_seasons && history.available_seasons[0]) || "");
  }

  function liveFilters(moduleState) {
    var local = getLocal(moduleState);
    return {
      teamId: safeStr(local.liveTeamId),
      position: safeStr(local.livePosition).toUpperCase(),
      nflTeam: safeStr(local.liveNflTeam).toUpperCase(),
      search: safeStr(local.liveSearch).toLowerCase(),
      orderView: safeStr(local.orderView).toLowerCase() === "drafted" ? "drafted" : "upcoming"
    };
  }

  function reportFilters(moduleState) {
    var local = getLocal(moduleState);
    return {
      teamId: safeStr(local.reportTeamId),
      position: safeStr(local.reportPosition).toUpperCase(),
      search: safeStr(local.reportSearch).toLowerCase(),
      sortKey: safeStr(local.reportSortKey),
      sortDir: safeStr(local.reportSortDir).toLowerCase() === "asc" ? "asc" : "desc"
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

  function filterRows(rows, filters, teamKey) {
    var teamField = teamKey || "franchise_id";
    return (rows || []).filter(function (row) {
      if (filters.teamId && safeStr(row && row[teamField]) !== filters.teamId) return false;
      if (filters.position && safeStr(row && (row.pos_group || row.position)).toUpperCase() !== filters.position && safeStr(row && row.position).toUpperCase() !== filters.position) return false;
      if (filters.nflTeam && safeStr(row && row.nfl_team).toUpperCase() !== filters.nflTeam) return false;
      if (filters.search && rowSearchText(row).indexOf(filters.search) === -1) return false;
      return true;
    });
  }

  function sortRows(rows, sortKey, sortDir) {
    var dir = sortDir === "asc" ? 1 : -1;
    return (rows || []).slice().sort(function (a, b) {
      var aValue = a && a[sortKey];
      var bValue = b && b[sortKey];
      var aNum = Number(aValue);
      var bNum = Number(bValue);
      if (isFinite(aNum) && isFinite(bNum)) {
        return (aNum - bNum) * dir;
      }
      return safeStr(aValue).localeCompare(safeStr(bValue)) * dir;
    });
  }

  function sortOptions(reportKey) {
    var map = {
      "historical-picks": [
        { key: "pick_label", label: "Pick" },
        { key: "player_name", label: "Player" },
        { key: "position", label: "Position" },
        { key: "points_rookiecontract", label: "3Y Pts" },
        { key: "rookie_value_score", label: "Value Score" }
      ],
      "owner-results": [
        { key: "franchise_name", label: "Owner" },
        { key: "picks_made", label: "Picks" },
        { key: "avg_points_3yr", label: "Avg 3Y Pts" },
        { key: "avg_rookie_value_score", label: "Avg Value Score" },
        { key: "hit_rate", label: "Hit Rate" }
      ],
      "pick-slot-results": [
        { key: "pick_label", label: "Pick" },
        { key: "round_segment", label: "Segment" },
        { key: "sample_size", label: "Samples" },
        { key: "avg_points_3yr", label: "Avg 3Y Pts" },
        { key: "avg_rookie_value_score", label: "Avg Value Score" },
        { key: "hit_rate", label: "Hit Rate" }
      ],
      "pick-bucket-baseline": [
        { key: "pick_bucket", label: "Bucket" },
        { key: "expected_points_3yr", label: "Expected 3Y Pts" },
        { key: "avg_points_3yr", label: "Avg 3Y Pts" },
        { key: "avg_rookie_value_score", label: "Avg Value Score" },
        { key: "sample_size", label: "Samples" }
      ]
    };
    return map[reportKey] || [];
  }

  function defaultSortKey(reportKey) {
    var defaults = {
      "historical-picks": "pick_label",
      "owner-results": "avg_rookie_value_score",
      "pick-slot-results": "pick_label",
      "pick-bucket-baseline": "pick_bucket"
    };
    return defaults[reportKey] || "";
  }

  function roundOptions() {
    var out = [];
    for (var i = 1; i <= 6; i += 1) out.push(i);
    return out;
  }

  function pickOptions() {
    var out = [];
    for (var i = 1; i <= 12; i += 1) out.push(i);
    return out;
  }

  function selectedRookie(moduleState, draftableRows) {
    var selectedId = safeStr(getLocal(moduleState).selectedPlayerId);
    for (var i = 0; i < draftableRows.length; i += 1) {
      if (safeStr(draftableRows[i] && draftableRows[i].player_id) === selectedId) return draftableRows[i];
    }
    return null;
  }

  function pickerRows(moduleState, draftableRows) {
    var q = safeStr(getLocal(moduleState).pickerQuery).toLowerCase();
    return (draftableRows || []).filter(function (row) {
      if (!q) return true;
      return [row.player_name, row.position, row.nfl_team].join(" ").toLowerCase().indexOf(q) !== -1;
    }).slice(0, 18);
  }

  function renderPageSwitch(active, h) {
    return '' +
      '<div class="acq-inline-actions acq-subviewSwitch">' +
        '<button type="button" class="acq-btn ' + (active === "live" ? "acq-btn-primary" : "acq-btn-secondary") + '" data-acq-rookie-page="live">Live / Event</button>' +
        '<button type="button" class="acq-btn ' + (active === "reports" ? "acq-btn-primary" : "acq-btn-secondary") + '" data-acq-rookie-page="reports">Reports</button>' +
      "</div>";
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

  function renderLiveFilters(ctx, live, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var filters = liveFilters(moduleState);
    var draftableRows = live.draftable_rookies || [];
    var allRows = []
      .concat(live.draft_order || [])
      .concat(live.live_board || [])
      .concat(history.adp_board || [])
      .concat(draftableRows);
    var teamOptions = (((ctx.bootstrap && ctx.bootstrap.league && ctx.bootstrap.league.franchises) || []).map(function (row) {
      return { key: safeStr(row.franchise_id), label: safeStr(row.franchise_name) };
    }));
    var positionOptions = dropdownOptions(allRows.map(function (row) { return safeStr(row && (row.pos_group || row.position)).toUpperCase(); }).filter(Boolean));
    var nflTeamOptions = dropdownOptions(allRows.map(function (row) { return safeStr(row && row.nfl_team).toUpperCase(); }).filter(Boolean));
    return '' +
      '<section class="acq-card acq-card-filters">' +
        '<div class="acq-filterStrip">' +
          '<label class="acq-field acq-field-search"><span>Player Search</span><input id="acqRookieLiveSearch" type="search" value="' + h.escapeHtml(filters.search) + '" placeholder="Search player, pick, owner"></label>' +
          renderSelect("acqRookieLiveTeam", "Team", filters.teamId, teamOptions, true, "All Teams", h) +
          renderSelect("acqRookieLivePos", "Position", filters.position, positionOptions, true, "All Positions", h) +
          renderSelect("acqRookieLiveNfl", "NFL Team", filters.nflTeam, nflTeamOptions, true, "All NFL Teams", h) +
          renderSelect("acqRookieOrderView", "Draft Order View", filters.orderView, [
            { key: "upcoming", label: "Upcoming" },
            { key: "drafted", label: "Drafted" }
          ], false, "", h) +
        "</div>" +
      "</section>";
  }

  function renderDraftEntry(ctx, live) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var local = getLocal(moduleState);
    var selected = selectedRookie(moduleState, live.draftable_rookies || []);
    var picker = pickerRows(moduleState, live.draftable_rookies || []);
    var roundValue = safeStr(local.selectedRound || (live.current_pick && live.current_pick.round) || "1");
    var pickValue = safeStr(local.selectedPick || (live.current_pick && live.current_pick.pick) || "1");
    var undoVisible = !!(live.undo_available || (ctx.bootstrap && ctx.bootstrap.viewer && ctx.bootstrap.viewer.is_commish));
    return '' +
      '<section class="acq-card">' +
        '<div class="acq-card-head"><h3>Draft Entry</h3>' +
          (undoVisible && live.last_pick
            ? '<button type="button" class="acq-btn acq-btn-secondary" id="acqUndoLastPick">Undo Last Pick</button>'
            : "") +
        '</div>' +
        '<form id="acqRookieDraftForm" class="acq-form-grid">' +
          '<label class="acq-field"><span>Player</span><input id="acqRookiePickerInput" name="player_picker" type="search" autocomplete="off" placeholder="Search the current rookie class" value="' + h.escapeHtml(selected ? safeStr(selected.player_name) : safeStr(local.pickerQuery)) + '"></label>' +
          '<div class="acq-pickerResults">' +
            (selected
              ? '<div class="acq-pickerSelected"><div><strong>' + h.escapeHtml(safeStr(selected.player_name)) + '</strong><span>' + h.escapeHtml([safeStr(selected.position), safeStr(selected.nfl_team), "ADP " + compactAdp(selected)].join(" · ")) + '</span></div><button type="button" class="acq-btn acq-btn-secondary" data-acq-rookie-clear="1">Change</button></div>'
              : (picker.length
                ? picker.map(function (row) {
                    return '' +
                      '<button type="button" class="acq-pickerRow" data-acq-rookie-pick="' + h.escapeHtml(safeStr(row.player_id)) + '" data-acq-rookie-name="' + h.escapeHtml(safeStr(row.player_name)) + '">' +
                        '<strong>' + h.escapeHtml(safeStr(row.player_name)) + '</strong>' +
                        '<span>' + h.escapeHtml([safeStr(row.position), safeStr(row.nfl_team), "ADP " + compactAdp(row)].filter(Boolean).join(" · ")) + '</span>' +
                      "</button>";
                  }).join("")
                : '<div class="acq-empty">No undrafted rookies match the current search.</div>')) +
          "</div>" +
          '<div class="acq-grid acq-grid-two">' +
            renderSelect("acqRookieRound", "Round", roundValue, roundOptions(), false, "", h, 'name="round"') +
            renderSelect("acqRookiePick", "Pick", pickValue, pickOptions(), false, "", h, 'name="pick"') +
          "</div>" +
          '<button type="submit" class="acq-btn acq-btn-primary">Submit Draft Pick</button>' +
        "</form>" +
        '<div id="acqRookieDraftActionStatus" class="acq-note"></div>' +
      "</section>";
  }

  function renderLivePage(ctx, live, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var filters = liveFilters(moduleState);
    var orderRows = filterRows((live.draft_order || []).filter(function (row) {
      return safeStr(row.status || "upcoming") === filters.orderView;
    }), filters);
    var liveBoardRows = filterRows(live.live_board || [], filters);
    var adpRows = filterRows(history.adp_board || [], filters).map(function (row) {
      return Object.assign({}, row, {
        displayed_adp: row.displayed_adp != null ? row.displayed_adp : row.normalized_adp
      });
    });
    var refreshMode = safeStr(live.refresh_mode).replace(/-/g, " ");
    var eventLabel = safeStr(live.draft_event && live.draft_event.start_label) || "Draft event not found";
    return '' +
      '<div class="acq-page acq-rookiePage">' +
        '<section class="acq-card acq-card-hero">' +
          '<div>' +
            '<div class="acq-kicker">Rookie Draft</div>' +
            '<h2 class="acq-section-title">Live / Event</h2>' +
            '<p class="acq-muted">Draft event: ' + h.escapeHtml(eventLabel) + '. Refresh mode: ' + h.escapeHtml(refreshMode || "dormant") + '.</p>' +
            (safeStr(live.refresh_mode) === "dormant" && safeStr(live.next_live_poll_at)
              ? '<p class="acq-muted">Next live polling begins on ' + h.escapeHtml(safeStr(live.draft_event && live.draft_event.start_label)) + '.</p>'
              : "") +
          '</div>' +
          renderPageSwitch("live", h) +
          '<div class="acq-kpi-grid">' +
            '<div class="acq-kpi"><span class="acq-kpi-label">On the Clock</span><strong>' + h.escapeHtml(live.current_pick ? pickLabel(live.current_pick) : "Waiting") + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.current_pick_team_name) || "Waiting") + '</span></div>' +
            '<div class="acq-kpi"><span class="acq-kpi-label">Live Picks</span><strong>' + String((live.live_board || []).length) + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.timer_text) || "No active clock") + '</span></div>' +
            '<div class="acq-kpi"><span class="acq-kpi-label">Contract Reconcile</span><strong>' + h.escapeHtml(safeStr(live.contract_reconcile_status && live.contract_reconcile_status.label) || "Ready") + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(live.contract_reconcile_status && live.contract_reconcile_status.summary) || "Draft contracts synced.") + '</span></div>' +
          '</div>' +
        '</section>' +
        renderLiveFilters(ctx, live, history) +
        (live.draft_order_integrity && live.draft_order_integrity.has_fallback
          ? '<div class="acq-note">A small number of draft-order rows are using artifact fallback because live asset ownership could not be resolved.</div>'
          : "") +
        '<div class="acq-grid acq-grid-two">' +
          renderDraftEntry(ctx, live) +
          '<section class="acq-card">' +
            '<div class="acq-card-head"><h3>Current Draft Order</h3><span class="acq-pill">' + String(orderRows.length) + ' rows</span></div>' +
            h.renderTable([
              {
                key: "pick_label",
                label: "Pick",
                renderHtml: function (row) {
                  return '<button type="button" class="acq-linkBtn" data-acq-draft-slot="' + h.escapeHtml(safeStr(row.pick_label)) + '">' + h.escapeHtml(safeStr(row.pick_label)) + "</button>";
                }
              },
              { key: "franchise_id", label: "Owner", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
              { key: "status", label: "Status" },
              { key: "player_name", label: "Player", renderHtml: function (row) { return row.player_name ? playerCellHtml(row, h) : '<span class="acq-muted">Upcoming</span>'; } }
            ], orderRows, "No draft-order rows match the current filters.", { wrapClass: "acq-table-wrap-scroll" }) +
          '</section>' +
        '</div>' +
        '<div class="acq-grid acq-grid-two">' +
          '<section class="acq-card">' +
            '<div class="acq-card-head"><h3>Live Board</h3><span class="acq-pill">' + String(liveBoardRows.length) + ' rows</span></div>' +
            h.renderTable([
              { key: "pick_label", label: "Pick" },
              { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
              { key: "franchise_id", label: "Drafted By", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
              { key: "timestamp", label: "Time" }
            ], liveBoardRows.map(function (row) {
              return {
                pick_label: pickLabel(row),
                player_name: row.player_name,
                position: row.position,
                nfl_team: row.nfl_team,
                franchise_id: row.franchise_id,
                franchise_name: row.franchise_name,
                franchise_abbrev: row.franchise_abbrev,
                icon_url: row.icon_url,
                timestamp: row.timestamp
              };
            }), "No live picks match the current filters.", { wrapClass: "acq-table-wrap-scroll" }) +
          '</section>' +
          '<section class="acq-card">' +
            '<div class="acq-card-head"><h3>Rookie ADP Board</h3><span class="acq-pill">' + String(adpRows.length) + ' rookies</span></div>' +
            h.renderTable([
              { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
              { key: "displayed_adp", label: "ADP" },
              { key: "displayed_adp_source", label: "Source" }
            ], adpRows, "No rookie ADP rows match the current filters.", { wrapClass: "acq-table-wrap-scroll" }) +
          '</section>' +
        '</div>' +
      '</div>';
  }

  function renderReportFilters(ctx, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var filters = reportFilters(moduleState);
    var selectedReport = currentReportKey(moduleState);
    var selectedSeason = currentSeason(moduleState, history);
    var teamOptions = (((ctx.bootstrap && ctx.bootstrap.league && ctx.bootstrap.league.franchises) || []).map(function (row) {
      return { key: safeStr(row.franchise_id), label: safeStr(row.franchise_name) };
    }));
    var positionOptions = dropdownOptions((history.historical_picks || history.history_rows || []).map(function (row) {
      return safeStr(row && (row.pos_group || row.position)).toUpperCase();
    }).filter(Boolean));
    var sortFieldOptions = sortOptions(selectedReport);
    var showPosition = selectedReport === "historical-picks" || selectedReport === "pick-bucket-baseline";
    var showTeam = selectedReport === "historical-picks" || selectedReport === "owner-results";
    var showSort = selectedReport !== "value-score-methodology";
    return '' +
      '<section class="acq-card acq-card-filters">' +
        '<div class="acq-filterStrip">' +
          renderSelect("acqRookieReportSeason", "Season", selectedSeason, history.available_seasons || [], false, "", h) +
          renderSelect("acqRookieReportKey", "Report", selectedReport, reportOptions(), false, "", h) +
          '<label class="acq-field acq-field-search"><span>Search</span><input id="acqRookieReportSearch" type="search" value="' + h.escapeHtml(filters.search) + '" placeholder="Search player, owner, pick"></label>' +
          (showTeam ? renderSelect("acqRookieReportTeam", "Team", filters.teamId, teamOptions, true, "All Teams", h) : "") +
          (showPosition ? renderSelect("acqRookieReportPos", "Position", filters.position, positionOptions, true, "All Positions", h) : "") +
          (showSort ? renderSelect("acqRookieReportSort", "Sort By", filters.sortKey || defaultSortKey(selectedReport), sortFieldOptions, false, "", h) : "") +
          (showSort ? renderSelect("acqRookieReportDir", "Direction", filters.sortDir || "desc", [{ key: "desc", label: "Desc" }, { key: "asc", label: "Asc" }], false, "", h) : "") +
        "</div>" +
      "</section>";
  }

  function renderReportsPage(ctx, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var reportKey = currentReportKey(moduleState);
    var selectedSeason = currentSeason(moduleState, history);
    var filters = reportFilters(moduleState);
    var sortKey = filters.sortKey || defaultSortKey(reportKey);
    var sortedRows;
    var reportHtml = "";

    if (reportKey === "historical-picks") {
      sortedRows = sortRows(filterRows(history.historical_picks || history.history_rows || [], {
        teamId: filters.teamId,
        position: filters.position,
        nflTeam: "",
        search: filters.search
      }), sortKey, filters.sortDir);
      reportHtml = h.renderTable([
        { key: "pick_label", label: "Pick" },
        { key: "player_name", label: "Player", renderHtml: function (row) { return playerCellHtml(row, h); } },
        { key: "franchise_id", label: "Drafted By", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
        { key: "points_rookiecontract", label: "3Y Pts" },
        { key: "rookie_value_score", label: "Value Score" }
      ], sortedRows.map(function (row) {
        return {
          pick_label: safeStr(row.pick_label || pickLabel(row)),
          player_name: row.player_name,
          position: row.position,
          nfl_team: row.nfl_team,
          franchise_id: row.franchise_id,
          franchise_name: row.franchise_name,
          franchise_abbrev: row.franchise_abbrev,
          icon_url: row.icon_url,
          points_rookiecontract: row.points_rookiecontract,
          rookie_value_score: row.rookie_value_score
        };
      }), "No historical rookie picks match the current filters.", { wrapClass: "acq-table-wrap-scroll acq-table-wrap-tall" });
    } else if (reportKey === "owner-results") {
      sortedRows = sortRows((history.owner_summary_rows || []).filter(function (row) {
        if (filters.teamId && safeStr(row.franchise_id) !== filters.teamId) return false;
        if (filters.search && rowSearchText(row).indexOf(filters.search) === -1) return false;
        return true;
      }), sortKey, filters.sortDir);
      reportHtml = h.renderTable([
        { key: "franchise_id", label: "Owner", renderHtml: function (row) { return teamIconHtml(row, h); }, cellClass: "acq-cell-icon" },
        { key: "picks_made", label: "Picks" },
        { key: "avg_points_3yr", label: "Avg 3Y Pts" },
        { key: "avg_rookie_value_score", label: "Avg Value Score" },
        { key: "hit_rate", label: "Hit Rate" },
        { key: "best_pick", label: "Best Pick" }
      ], sortedRows, "No owner results match the current filters.", { wrapClass: "acq-table-wrap-scroll" });
    } else if (reportKey === "pick-slot-results") {
      sortedRows = sortRows((history.pick_summary_rows || []).filter(function (row) {
        return !filters.search || rowSearchText(row).indexOf(filters.search) !== -1;
      }), sortKey, filters.sortDir);
      reportHtml = h.renderTable([
        { key: "pick_label", label: "Pick" },
        { key: "round_segment", label: "Segment" },
        { key: "sample_size", label: "Samples" },
        { key: "avg_points_3yr", label: "Avg 3Y Pts" },
        { key: "avg_rookie_value_score", label: "Avg Value Score" },
        { key: "hit_rate", label: "Hit Rate" }
      ], sortedRows, "No pick-slot rows are available.", { wrapClass: "acq-table-wrap-scroll" });
    } else if (reportKey === "pick-bucket-baseline") {
      var baselineRows = (filters.position && history.pick_bucket_baseline_by_pos_group && history.pick_bucket_baseline_by_pos_group.length
        ? history.pick_bucket_baseline_by_pos_group.filter(function (row) { return safeStr(row.pos_group).toUpperCase() === filters.position; })
        : history.pick_bucket_baseline_rows || []);
      sortedRows = sortRows((baselineRows || []).filter(function (row) {
        return !filters.search || rowSearchText(row).indexOf(filters.search) !== -1;
      }), sortKey, filters.sortDir);
      reportHtml = '' +
        '<div class="acq-note">Cross-season baseline report. ' + (filters.position ? ('Filtered to ' + h.escapeHtml(filters.position) + '.') : "Use the position filter for a position-specific view.") + '</div>' +
        h.renderTable([
          { key: "pick_bucket", label: "Bucket" },
          { key: "pos_group", label: "Position" },
          { key: "expected_points_3yr", label: "Expected 3Y Pts" },
          { key: "avg_points_3yr", label: "Avg 3Y Pts" },
          { key: "avg_rookie_value_score", label: "Avg Value Score" },
          { key: "sample_size", label: "Samples" }
        ], sortedRows.map(function (row) {
          return Object.assign({ pos_group: row.pos_group || "ALL" }, row);
        }), "No pick-bucket rows are available.", { wrapClass: "acq-table-wrap-scroll" });
    } else {
      reportHtml = '' +
        '<div class="acq-reportCopy">' +
          '<p><strong>Value Score</strong> uses the exact weighted model from the acquisition artifact builder.</p>' +
          h.renderTable([
            { key: "label", label: "Metric" },
            { key: "pct", label: "Weight %" }
          ], ((history.value_score_methodology && history.value_score_methodology.weights) || []).map(function (row) {
            return { label: row.label, pct: row.pct };
          }), "No methodology rows are available.") +
        "</div>";
    }

    return '' +
      '<div class="acq-page acq-rookiePage">' +
        '<section class="acq-card acq-card-hero">' +
          '<div>' +
            '<div class="acq-kicker">Rookie Draft Reports</div>' +
            '<h2 class="acq-section-title">Reports</h2>' +
            '<p class="acq-muted">Selected season: ' + h.escapeHtml(selectedSeason || "—") + '. One report is shown at a time so the full table can scroll and sort cleanly.</p>' +
          '</div>' +
          renderPageSwitch("reports", h) +
        '</section>' +
        renderReportFilters(ctx, history) +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>' + h.escapeHtml((reportOptions().find(function (row) { return row.key === reportKey; }) || {}).label || "Report") + '</h3><span class="acq-pill">' + h.escapeHtml(selectedSeason || "—") + '</span></div>' +
          reportHtml +
        '</section>' +
      '</div>';
  }

  window.UPS_ACQ_MODULES["rookie-draft"] = {
    key: "rookie-draft",
    title: "Rookie Draft",
    historyPath: "/acquisition-hub/rookie-draft/history",
    livePath: "/acquisition-hub/rookie-draft/live",
    refresh: { visibleMs: 60000, hiddenMs: 300000 },
    getHistoryParams: function (ctx) {
      var moduleState = ctx && ctx.moduleState;
      return {
        season: currentSeason(moduleState, ctx && ctx.moduleState && ctx.moduleState.history),
        report: currentReportKey(moduleState)
      };
    },
    render: function (ctx) {
      var moduleState = ctx.moduleState || {};
      var live = moduleState.live || {};
      var history = moduleState.history || {};
      return getPage(moduleState) === "reports"
        ? renderReportsPage(ctx, history)
        : renderLivePage(ctx, live, history);
    },
    bind: function (root, ctx) {
      var statusEl = root.querySelector("#acqRookieDraftActionStatus");

      function local() {
        return getLocal(ctx.moduleState || {});
      }

      function setStatus(message, tone) {
        if (!statusEl) return;
        statusEl.className = "acq-note" + (tone ? (" is-" + tone) : "");
        statusEl.textContent = message;
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-rookie-page]"), function (button) {
        button.addEventListener("click", function () {
          var page = safeStr(button.getAttribute("data-acq-rookie-page")).toLowerCase() === "reports" ? "reports" : "live";
          ctx.setLocalState({ page: page });
          if (page === "reports") ctx.reloadHistory(true).catch(function () {});
        });
      });

      var liveSearch = root.querySelector("#acqRookieLiveSearch");
      if (liveSearch) liveSearch.addEventListener("input", function () { ctx.setLocalState({ liveSearch: safeStr(liveSearch.value) }); });
      var liveTeam = root.querySelector("#acqRookieLiveTeam");
      if (liveTeam) liveTeam.addEventListener("change", function () { ctx.setLocalState({ liveTeamId: safeStr(liveTeam.value) }); });
      var livePos = root.querySelector("#acqRookieLivePos");
      if (livePos) livePos.addEventListener("change", function () { ctx.setLocalState({ livePosition: safeStr(livePos.value) }); });
      var liveNfl = root.querySelector("#acqRookieLiveNfl");
      if (liveNfl) liveNfl.addEventListener("change", function () { ctx.setLocalState({ liveNflTeam: safeStr(liveNfl.value) }); });
      var orderView = root.querySelector("#acqRookieOrderView");
      if (orderView) orderView.addEventListener("change", function () { ctx.setLocalState({ orderView: safeStr(orderView.value) }); });

      var pickerInput = root.querySelector("#acqRookiePickerInput");
      if (pickerInput) {
        pickerInput.addEventListener("input", function () {
          ctx.setLocalState({
            pickerQuery: safeStr(pickerInput.value),
            selectedPlayerId: "",
            selectedPlayerName: ""
          });
        });
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-rookie-pick]"), function (button) {
        button.addEventListener("click", function () {
          ctx.setLocalState({
            selectedPlayerId: safeStr(button.getAttribute("data-acq-rookie-pick")),
            selectedPlayerName: safeStr(button.getAttribute("data-acq-rookie-name")),
            pickerQuery: safeStr(button.getAttribute("data-acq-rookie-name"))
          });
        });
      });

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-rookie-clear]"), function (button) {
        button.addEventListener("click", function () {
          ctx.setLocalState({ selectedPlayerId: "", selectedPlayerName: "", pickerQuery: "" });
        });
      });

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-draft-slot]"), function (button) {
        button.addEventListener("click", function () {
          var pick = safeStr(button.getAttribute("data-acq-draft-slot")).split(".");
          ctx.setLocalState({
            selectedRound: safeStr(pick[0] || ""),
            selectedPick: String(safeInt(pick[1], 0) || "")
          });
        });
      });

      var reportSeason = root.querySelector("#acqRookieReportSeason");
      if (reportSeason) reportSeason.addEventListener("change", function () { ctx.setLocalState({ reportSeason: safeStr(reportSeason.value) }, { reloadHistory: true }); });
      var reportKey = root.querySelector("#acqRookieReportKey");
      if (reportKey) reportKey.addEventListener("change", function () { ctx.setLocalState({ reportKey: safeStr(reportKey.value) }, { reloadHistory: true }); });
      var reportSearch = root.querySelector("#acqRookieReportSearch");
      if (reportSearch) reportSearch.addEventListener("input", function () { ctx.setLocalState({ reportSearch: safeStr(reportSearch.value) }); });
      var reportTeam = root.querySelector("#acqRookieReportTeam");
      if (reportTeam) reportTeam.addEventListener("change", function () { ctx.setLocalState({ reportTeamId: safeStr(reportTeam.value) }); });
      var reportPos = root.querySelector("#acqRookieReportPos");
      if (reportPos) reportPos.addEventListener("change", function () { ctx.setLocalState({ reportPosition: safeStr(reportPos.value) }); });
      var reportSort = root.querySelector("#acqRookieReportSort");
      if (reportSort) reportSort.addEventListener("change", function () { ctx.setLocalState({ reportSortKey: safeStr(reportSort.value) }); });
      var reportDir = root.querySelector("#acqRookieReportDir");
      if (reportDir) reportDir.addEventListener("change", function () { ctx.setLocalState({ reportSortDir: safeStr(reportDir.value) }); });

      var roundSelect = root.querySelector("#acqRookieRound");
      if (roundSelect) roundSelect.addEventListener("change", function () { ctx.setLocalState({ selectedRound: safeStr(roundSelect.value) }); });
      var pickSelect = root.querySelector("#acqRookiePick");
      if (pickSelect) pickSelect.addEventListener("change", function () { ctx.setLocalState({ selectedPick: safeStr(pickSelect.value) }); });

      var undoBtn = root.querySelector("#acqUndoLastPick");
      if (undoBtn) {
        undoBtn.addEventListener("click", function () {
          setStatus("Undoing the most recent rookie draft pick...", "info");
          ctx.postAction("/acquisition-hub/rookie-draft/action", { action: "undo" }).then(function (payload) {
            var cleanup = payload && payload.contract_cleanup_result;
            var message = payload && payload.undone_pick
              ? ("Undid pick " + safeStr(payload.undone_pick.player_name) + " at " + safeStr(pickLabel(payload.undone_pick)) + ".")
              : "Undo submitted.";
            if (cleanup && safeStr(cleanup.status_label)) message += " " + safeStr(cleanup.status_label);
            setStatus(message, cleanup && cleanup.ok === false ? "bad" : "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Undo failed.", "bad");
          });
        });
      }

      var form = root.querySelector("#acqRookieDraftForm");
      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var fd = new FormData(form);
          var localState = local();
          if (!safeStr(localState.selectedPlayerId)) {
            setStatus("Select a rookie by name before submitting the draft pick.", "bad");
            return;
          }
          setStatus("Submitting rookie draft pick...", "info");
          ctx.postAction("/acquisition-hub/rookie-draft/action", {
            action: "draft",
            player_id: safeStr(localState.selectedPlayerId),
            player_name: safeStr(localState.selectedPlayerName || localState.pickerQuery),
            round: safeStr(fd.get("round")),
            pick: safeStr(fd.get("pick"))
          }).then(function (payload) {
            var contractResult = payload && payload.contract_apply_result;
            var message = "Draft pick submitted.";
            if (contractResult && safeStr(contractResult.status_label)) message += " " + safeStr(contractResult.status_label);
            ctx.setLocalState({
              selectedPlayerId: "",
              selectedPlayerName: "",
              pickerQuery: ""
            });
            setStatus(message, contractResult && contractResult.ok === false ? "bad" : "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Draft pick failed.", "bad");
          });
        });
      }
    }
  };
})();
