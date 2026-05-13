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

  function pickLabel(row) {
    return safeInt(row && row.draft_round, safeInt(row && row.round, 0)) +
      "." +
      String(safeInt(row && row.pick_in_round, safeInt(row && row.pick, 0))).padStart(2, "0");
  }

  function numberText(value, digits) {
    var n = Number(value);
    if (!isFinite(n)) return safeStr(value);
    if (digits == null) digits = 2;
    return n.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function teamBadgeHtml(row, h) {
    var icon = safeStr(row && (row.icon_url || row.franchise_icon_url));
    var name = safeStr(row && row.franchise_name);
    var abbr = safeStr(row && row.franchise_abbrev);
    var label = name || abbr || safeStr(row && row.franchise_id) || "Team";
    return '' +
      '<span class="acq-teamBadge">' +
        (icon
          ? '<img class="acq-teamBadge-icon" src="' + h.escapeHtml(icon) + '" alt="' + h.escapeHtml(label) + '">'
          : '<span class="acq-teamBadge-fallback">' + h.escapeHtml((abbr || label).slice(0, 3).toUpperCase()) + "</span>") +
        '<span class="acq-teamBadge-label">' + h.escapeHtml(label) + "</span>" +
      "</span>";
  }

  function playerSummaryHtml(row, h) {
    var name = safeStr(row && row.player_name);
    var meta = [safeStr(row && row.position), safeStr(row && row.nfl_team)].filter(Boolean).join(" · ");
    return '' +
      '<div class="acq-playerCell">' +
        '<strong>' + h.escapeHtml(name) + "</strong>" +
        (meta ? '<span class="acq-playerCell-meta">' + h.escapeHtml(meta) + "</span>" : "") +
      "</div>";
  }

  function filterTextFromRow(row) {
    return [
      row && row.player_name,
      row && row.franchise_name,
      row && row.owner_name,
      row && row.position,
      row && row.nfl_team,
      row && row.player_id,
      row && row.pick_label
    ].join(" ").toLowerCase();
  }

  function getSubview(moduleState) {
    return safeStr(moduleState && moduleState.local && moduleState.local.subview).toLowerCase() === "history"
      ? "history"
      : "live";
  }

  function getSeasonContext(moduleState) {
    var value = safeStr(moduleState && moduleState.local && moduleState.local.seasonContext);
    return value || "all";
  }

  function safeNumber(value) {
    if (value == null || value === "") return NaN;
    var n = Number(value);
    return isFinite(n) ? n : NaN;
  }

  function adpSortValue(row) {
    var values = [
      safeNumber(row && row.normalized_adp),
      safeNumber(row && row.superflex_source_adp),
      safeNumber(row && row.mfl_average_pick)
    ];
    for (var i = 0; i < values.length; i += 1) {
      if (isFinite(values[i]) && values[i] > 0) return values[i];
    }
    return Number.POSITIVE_INFINITY;
  }

  function adpMetaLabel(row) {
    var normalized = safeNumber(row && row.normalized_adp);
    if (isFinite(normalized) && normalized > 0) return "ADP " + numberText(normalized, 2);
    var superflex = safeNumber(row && row.superflex_source_adp);
    if (isFinite(superflex) && superflex > 0) return "SF ADP " + numberText(superflex, 2);
    var mflAdp = safeNumber(row && row.mfl_average_pick);
    if (isFinite(mflAdp) && mflAdp > 0) return "MFL ADP " + numberText(mflAdp, 2);
    var sentiment = safeNumber(row && row.public_sentiment_score);
    if (isFinite(sentiment) && sentiment > 0) return "Sentiment " + numberText(sentiment, 2);
    return "";
  }

  function compareDraftableRookies(a, b) {
    var adpA = adpSortValue(a);
    var adpB = adpSortValue(b);
    var rankedA = isFinite(adpA);
    var rankedB = isFinite(adpB);
    if (rankedA && rankedB && adpA !== adpB) return adpA - adpB;
    if (rankedA !== rankedB) return rankedA ? -1 : 1;
    var sentimentDelta = safeNumber(b && b.public_sentiment_score) - safeNumber(a && a.public_sentiment_score);
    if (isFinite(sentimentDelta) && sentimentDelta !== 0) return sentimentDelta;
    return safeStr(a && a.player_name).localeCompare(safeStr(b && b.player_name));
  }

  function adpByPlayer(history) {
    var rows = Array.isArray(history && history.adp_board) ? history.adp_board : [];
    var map = {};
    rows.forEach(function (row) {
      var playerId = safeStr(row && row.player_id);
      if (!playerId) return;
      map[playerId] = row;
    });
    return map;
  }

  function enrichWithAdp(row, adpMap) {
    var playerId = safeStr(row && row.player_id);
    var overlay = (adpMap && adpMap[playerId]) || {};
    return {
      player_id: playerId,
      player_name: safeStr(row && row.player_name) || safeStr(overlay.player_name),
      position: safeStr(row && row.position) || safeStr(overlay.position),
      pos_group: safeStr(row && row.pos_group) || safeStr(overlay.pos_group),
      nfl_team: safeStr(row && row.nfl_team) || safeStr(overlay.nfl_team),
      rookie_class_season: safeInt(row && row.rookie_class_season, safeInt(overlay && overlay.season, 0)),
      normalized_adp: row && row.normalized_adp != null && row.normalized_adp !== "" ? row.normalized_adp : overlay.normalized_adp,
      superflex_source_adp: row && row.superflex_source_adp != null && row.superflex_source_adp !== "" ? row.superflex_source_adp : overlay.superflex_source_adp,
      mfl_average_pick: row && row.mfl_average_pick != null && row.mfl_average_pick !== "" ? row.mfl_average_pick : overlay.mfl_average_pick,
      public_sentiment_score: row && row.public_sentiment_score != null && row.public_sentiment_score !== "" ? row.public_sentiment_score : overlay.public_sentiment_score,
      adp_tier: safeStr(row && row.adp_tier) || safeStr(overlay.adp_tier),
      adp_period_used: safeStr(row && row.adp_period_used) || safeStr(overlay.adp_period_used)
    };
  }

  function resolveDraftableRookies(live, history) {
    var liveRows = Array.isArray(live && live.draftable_rookies) ? live.draftable_rookies : [];
    var sourceRows = liveRows.length
      ? liveRows
      : (Array.isArray(history && history.draftable_rookies_seed) ? history.draftable_rookies_seed : []);
    var adpMap = adpByPlayer(history);
    return sourceRows.map(function (row) {
      return enrichWithAdp(row, adpMap);
    }).sort(compareDraftableRookies);
  }

  function filterHistoryRows(rows, teamFilter, search) {
    return (rows || []).filter(function (row) {
      if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
      if (search && filterTextFromRow(row).indexOf(search) === -1) return false;
      return true;
    });
  }

  function buildPickerRows(draftableRookies, liveBoard, pickerQuery) {
    var drafted = {};
    (liveBoard || []).forEach(function (row) {
      drafted[safeStr(row.player_id)] = true;
    });
    var q = safeStr(pickerQuery).toLowerCase();
    return (draftableRookies || []).filter(function (row) {
      var playerId = safeStr(row.player_id);
      if (!playerId || drafted[playerId]) return false;
      if (!q) return true;
      return [
        row.player_name,
        row.position,
        row.nfl_team,
        row.player_id
      ].join(" ").toLowerCase().indexOf(q) !== -1;
    }).sort(compareDraftableRookies).slice(0, 14);
  }

  function selectedRookie(moduleState, draftableRookies) {
    var selectedId = safeStr(moduleState && moduleState.local && moduleState.local.selectedPlayerId);
    if (!selectedId) return null;
    for (var i = 0; i < draftableRookies.length; i += 1) {
      if (safeStr(draftableRookies[i] && draftableRookies[i].player_id) === selectedId) return draftableRookies[i];
    }
    return null;
  }

  function renderSubviewButtons(active, h) {
    var items = [
      { key: "live", label: "Live Draft + ADP" },
      { key: "history", label: "History + Rookie Lab" }
    ];
    return '' +
      '<div class="acq-inline-actions acq-subviewSwitch">' +
        items.map(function (item) {
          return '<button type="button" class="acq-btn ' + (item.key === active ? "acq-btn-primary" : "acq-btn-secondary") + '" data-acq-rookie-subview="' + h.escapeHtml(item.key) + '">' + h.escapeHtml(item.label) + "</button>";
        }).join("") +
      "</div>";
  }

  function renderLiveView(ctx, live, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var search = safeStr(ctx.shared.search).toLowerCase();
    var teamFilter = safeStr(ctx.shared.teamId);
    var liveBoard = filterHistoryRows(live.live_board || [], teamFilter, search);
    var draftOrder = (live.draft_order || []).filter(function (row) {
      if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
      if (search && filterTextFromRow(row).indexOf(search) === -1) return false;
      return true;
    });
    var adpRows = (history.adp_board || []).filter(function (row) {
      if (search && filterTextFromRow(row).indexOf(search) === -1) return false;
      return true;
    }).sort(compareDraftableRookies).slice(0, 24);
    var draftable = resolveDraftableRookies(live, history);
    var pickerQuery = safeStr(moduleState.local && moduleState.local.pickerQuery);
    var pickerRows = buildPickerRows(draftable, live.live_board || [], pickerQuery);
    var selected = selectedRookie(moduleState, draftable);
    var currentPick = live.current_pick || {};
    var currentPickLabel = currentPick.round
      ? (safeInt(currentPick.round, 0) + "." + String(safeInt(currentPick.pick, 0)).padStart(2, "0"))
      : "Waiting on live draft status";
    var onClockTeam = (live.draft_status && live.draft_status.current_pick_team_name) || safeStr(currentPick.franchise_name || "");
    var reconcileStatus = live.contract_reconcile_status || {};
    var eventLabel = safeStr(live && live.draft_event && live.draft_event.start_label);
    var refreshBlurb = safeStr(live && live.refresh_mode) === "offseason"
      ? "Live rookie draft polling slows down outside the scheduled draft window and speeds up automatically on draft night."
      : "Live rookie draft data refreshes continuously while this tab is active.";
    return '' +
      '<section class="acq-card acq-card-hero">' +
        '<div>' +
          '<div class="acq-kicker">Live rookie board</div>' +
          '<h2 class="acq-section-title">Live Draft + Rookie ADP</h2>' +
          '<p class="acq-muted">' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.message) || refreshBlurb) + '</p>' +
        '</div>' +
        renderSubviewButtons("live", h) +
        '<div class="acq-kpi-grid">' +
          '<div class="acq-kpi"><span class="acq-kpi-label">On the Clock</span><strong>' + h.escapeHtml(currentPickLabel) + '</strong><span class="acq-muted">' + h.escapeHtml(onClockTeam || "Waiting") + '</span></div>' +
          '<div class="acq-kpi"><span class="acq-kpi-label">Picks Logged</span><strong>' + String((live.live_board || []).length) + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.timer_text) || "Live") + '</span></div>' +
          '<div class="acq-kpi"><span class="acq-kpi-label">Contract Reconcile</span><strong>' + h.escapeHtml(safeStr(reconcileStatus.label || "Ready")) + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(reconcileStatus.summary || "Drafted rookies will receive contracts immediately after confirmation.")) + '</span></div>' +
          '<div class="acq-kpi"><span class="acq-kpi-label">Draft Event</span><strong>' + h.escapeHtml(eventLabel || "League Calendar") + '</strong><span class="acq-muted">' + h.escapeHtml(safeStr(live && live.refresh_mode) === "offseason" ? "Slow refresh until draft night." : "Fast refresh active.") + '</span></div>' +
        '</div>' +
      '</section>' +
      '<div class="acq-grid acq-grid-two">' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Draft Entry</h3><span class="acq-pill">Player Name Only</span></div>' +
          '<form id="acqRookieDraftForm" class="acq-form-grid">' +
            '<label class="acq-field"><span>Player</span><input id="acqRookiePickerInput" name="player_picker" type="search" autocomplete="off" placeholder="Search the current rookie class" value="' + h.escapeHtml(selected ? safeStr(selected.player_name) : pickerQuery) + '"></label>' +
            '<div class="acq-pickerResults">' +
              (selected
                ? '<div class="acq-pickerSelected">' +
                    '<strong>' + h.escapeHtml(safeStr(selected.player_name)) + '</strong>' +
                    '<span>' + h.escapeHtml([safeStr(selected.position), safeStr(selected.nfl_team), adpMetaLabel(selected)].filter(Boolean).join(" · ")) + '</span>' +
                    '<button type="button" class="acq-btn acq-btn-secondary" data-acq-rookie-clear="1">Change</button>' +
                  '</div>'
                : (pickerRows.length
                    ? pickerRows.map(function (row) {
                        return '' +
                          '<button type="button" class="acq-pickerRow" data-acq-rookie-pick="' + h.escapeHtml(safeStr(row.player_id)) + '" data-acq-rookie-name="' + h.escapeHtml(safeStr(row.player_name)) + '">' +
                            '<strong>' + h.escapeHtml(safeStr(row.player_name)) + '</strong>' +
                            '<span>' + h.escapeHtml([safeStr(row.position), safeStr(row.nfl_team), adpMetaLabel(row)].filter(Boolean).join(" · ")) + '</span>' +
                          '</button>';
                      }).join("")
                    : '<div class="acq-empty">No undrafted rookies match the current search.</div>')) +
            '</div>' +
            '<div class="acq-grid acq-grid-two">' +
              '<label class="acq-field"><span>Round</span><input name="round" type="number" min="1" value="' + h.escapeHtml(safeStr(currentPick.round || "")) + '"></label>' +
              '<label class="acq-field"><span>Pick</span><input name="pick" type="number" min="1" value="' + h.escapeHtml(safeStr(currentPick.pick || "")) + '"></label>' +
            '</div>' +
            '<button type="submit" class="acq-btn acq-btn-primary">Submit Draft Pick</button>' +
          '</form>' +
          '<div id="acqRookieDraftActionStatus" class="acq-note"></div>' +
        '</section>' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Current Draft Order</h3><span class="acq-pill">' + String((live.draft_order || []).length) + ' picks</span></div>' +
          '<div class="acq-list acq-list-compact">' +
            draftOrder.slice(0, 24).map(function (row) {
              return '<div class="acq-list-row"><strong>' + h.escapeHtml(safeStr(row.pick_label)) + '</strong><span>' + teamBadgeHtml(row, h) + '</span></div>';
            }).join("") +
            (draftOrder.length ? "" : '<div class="acq-empty">No draft order rows are available yet.</div>') +
          '</div>' +
        '</section>' +
      '</div>' +
      '<div class="acq-grid acq-grid-two">' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Live Board</h3><span class="acq-pill">' + String(liveBoard.length) + ' shown</span></div>' +
          h.renderTable([
            { key: "pick_label", label: "Pick" },
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerSummaryHtml(row, h); } },
            { key: "franchise_name", label: "Drafted By", renderHtml: function (row) { return teamBadgeHtml(row, h); } }
          ], liveBoard.slice(0, 36).map(function (row) {
            return {
              pick_label: pickLabel(row),
              player_name: row.player_name,
              position: row.position,
              nfl_team: row.nfl_team,
              franchise_name: row.franchise_name,
              franchise_abbrev: row.franchise_abbrev,
              icon_url: row.icon_url || row.franchise_icon_url
            };
          }), "No live picks yet.") +
        '</section>' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Rookie ADP Board</h3><span class="acq-pill">Current Class Only</span></div>' +
          h.renderTable([
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerSummaryHtml(row, h); } },
            { key: "normalized_adp", label: "ADP" },
            { key: "adp_tier", label: "Tier" }
          ], adpRows.map(function (row) {
            return {
              player_name: row.player_name,
              position: row.position,
              nfl_team: row.nfl_team,
              normalized_adp: row.normalized_adp,
              adp_tier: row.adp_tier || row.adp_period_used || ""
            };
          }), "No rookie ADP rows are available.") +
        '</section>' +
      '</div>';
  }

  function renderHistoryView(ctx, history) {
    var h = ctx.helpers;
    var moduleState = ctx.moduleState || {};
    var search = safeStr(ctx.shared.search).toLowerCase();
    var teamFilter = safeStr(ctx.shared.teamId);
    var seasonContext = getSeasonContext(moduleState);
    var availableSeasons = Array.isArray(history.available_seasons) ? history.available_seasons : [];
    var historyRows = filterHistoryRows(history.history_rows || [], teamFilter, search).slice(0, 60);
    var ownerRows = filterHistoryRows(history.owner_summary_rows || [], teamFilter, search).slice(0, 36);
    var pickRows = filterHistoryRows(history.pick_summary_rows || [], "", search).slice(0, 36);
    var topHits = filterHistoryRows(history.top_hits || [], teamFilter, search).slice(0, 18);
    var valueSummary = (history.value_summary || []).slice(0, 18);
    return '' +
      '<section class="acq-card acq-card-hero">' +
        '<div>' +
          '<div class="acq-kicker">Historical rookie research</div>' +
          '<h2 class="acq-section-title">History + Rookie Lab</h2>' +
          '<p class="acq-muted">Filter by year context, review outcomes by drafting owner and pick slot, and compare early, middle, and late round performance across the league history.</p>' +
        '</div>' +
        renderSubviewButtons("history", h) +
        '<div class="acq-toolbar-grid">' +
          '<label class="acq-field"><span>Historical Year</span><select id="acqRookieSeasonContext"><option value="all"' + (seasonContext === "all" ? " selected" : "") + '>All Years</option>' +
            availableSeasons.map(function (season) {
              var value = safeStr(season);
              return '<option value="' + h.escapeHtml(value) + '"' + (value === seasonContext ? " selected" : "") + '>' + h.escapeHtml(value) + '</option>';
            }).join("") +
          '</select></label>' +
          '<div class="acq-note">Round segmentation: Early 1-4, Middle 5-8, Late 9-12 within each round.</div>' +
        '</div>' +
      '</section>' +
      '<div class="acq-grid acq-grid-two">' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Historical Picks</h3><span class="acq-pill">' + (seasonContext === "all" ? "All Years" : h.escapeHtml(seasonContext)) + '</span></div>' +
          h.renderTable([
            { key: "pick_label", label: "Pick" },
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerSummaryHtml(row, h); } },
            { key: "franchise_name", label: "Drafted By", renderHtml: function (row) { return teamBadgeHtml(row, h); } },
            { key: "points_rookiecontract", label: "3Y Pts" },
            { key: "rookie_value_score", label: "Score" }
          ], historyRows.map(function (row) {
            return {
              pick_label: pickLabel(row),
              player_name: row.player_name,
              position: row.position,
              nfl_team: "",
              franchise_name: row.franchise_name,
              franchise_abbrev: row.franchise_abbrev,
              icon_url: row.icon_url || row.franchise_icon_url,
              points_rookiecontract: row.points_rookiecontract,
              rookie_value_score: row.rookie_value_score
            };
          }), "No historical rookie picks match the current filters.") +
        '</section>' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Owner Summary</h3><span class="acq-pill">Historical Results</span></div>' +
          h.renderTable([
            { key: "franchise_name", label: "Owner", renderHtml: function (row) { return teamBadgeHtml(row, h); } },
            { key: "picks_made", label: "Picks" },
            { key: "avg_points_3yr", label: "Avg 3Y Pts" },
            { key: "avg_rookie_value_score", label: "Avg Score" },
            { key: "hit_rate", label: "Hit Rate" },
            { key: "best_pick", label: "Best Pick" }
          ], ownerRows, "No owner summary rows match the current filters.") +
        '</section>' +
      '</div>' +
      '<div class="acq-grid acq-grid-two">' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Pick Summary</h3><span class="acq-pill">By Slot</span></div>' +
          h.renderTable([
            { key: "pick_label", label: "Pick" },
            { key: "round_segment", label: "Segment" },
            { key: "sample_size", label: "Samples" },
            { key: "avg_points_3yr", label: "Avg 3Y Pts" },
            { key: "avg_rookie_value_score", label: "Avg Score" },
            { key: "hit_rate", label: "Hit Rate" }
          ], pickRows, "No pick summary rows are available.") +
        '</section>' +
        '<section class="acq-card">' +
          '<div class="acq-card-head"><h3>Rookie Lab</h3><span class="acq-pill">Top Hits</span></div>' +
          h.renderTable([
            { key: "player_name", label: "Player", renderHtml: function (row) { return playerSummaryHtml(row, h); } },
            { key: "pick_label", label: "Pick" },
            { key: "round_segment", label: "Segment" },
            { key: "points_rookiecontract", label: "3Y Pts" },
            { key: "rookie_value_score", label: "Score" }
          ], topHits.map(function (row) {
            return {
              player_name: row.player_name,
              position: row.position,
              nfl_team: "",
              pick_label: pickLabel(row),
              round_segment: row.round_segment,
              points_rookiecontract: row.points_rookiecontract,
              rookie_value_score: row.rookie_value_score
            };
          }), "No top-hit rows match the current filters.") +
        '</section>' +
      '</div>' +
      '<section class="acq-card">' +
        '<div class="acq-card-head"><h3>Pick Bucket Baseline</h3><span class="acq-pill">Expectation vs. Outcome</span></div>' +
        h.renderTable([
          { key: "pick_bucket", label: "Bucket" },
          { key: "expected_points_3yr", label: "Expected 3Y Pts" },
          { key: "avg_points_3yr", label: "Avg 3Y Pts" },
          { key: "avg_rookie_value_score", label: "Avg Score" },
          { key: "sample_size", label: "Samples" }
        ], valueSummary, "No value summary rows are available.") +
      '</section>';
  }

  window.UPS_ACQ_MODULES["rookie-draft"] = {
    key: "rookie-draft",
    title: "Rookie Draft Room",
    historyPath: "/acquisition-hub/rookie-draft/history",
    livePath: "/acquisition-hub/rookie-draft/live",
    refresh: { visibleMs: 60000, hiddenMs: 300000 },
    getHistoryParams: function (ctx) {
      return {
        season_context: getSeasonContext(ctx && ctx.moduleState)
      };
    },
    render: function (ctx) {
      var moduleState = ctx.moduleState || {};
      var live = moduleState.live || {};
      var history = moduleState.history || {};
      return '' +
        '<div class="acq-page acq-rookiePage">' +
          (getSubview(moduleState) === "history" ? renderHistoryView(ctx, history) : renderLiveView(ctx, live, history)) +
        '</div>';
    },
    bind: function (root, ctx) {
      var moduleState = ctx.moduleState || {};
      var local = moduleState.local || {};
      var statusEl = root.querySelector("#acqRookieDraftActionStatus");
      var seasonSelect = root.querySelector("#acqRookieSeasonContext");
      var form = root.querySelector("#acqRookieDraftForm");
      var pickerInput = root.querySelector("#acqRookiePickerInput");

      function setStatus(message, tone) {
        if (!statusEl) return;
        statusEl.className = "acq-note" + (tone ? (" is-" + tone) : "");
        statusEl.textContent = message;
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-rookie-subview]"), function (button) {
        button.addEventListener("click", function () {
          var next = safeStr(button.getAttribute("data-acq-rookie-subview")).toLowerCase() === "history" ? "history" : "live";
          ctx.setLocalState({ subview: next });
          if (next === "history") ctx.reloadHistory(true).catch(function () {});
        });
      });

      if (seasonSelect) {
        seasonSelect.addEventListener("change", function () {
          ctx.setLocalState({ seasonContext: safeStr(seasonSelect.value) || "all" }, { reloadHistory: true });
        });
      }

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
          ctx.setLocalState({
            selectedPlayerId: "",
            selectedPlayerName: "",
            pickerQuery: ""
          });
        });
      });

      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var fd = new FormData(form);
          var playerId = safeStr(local.selectedPlayerId || (ctx.moduleState && ctx.moduleState.local && ctx.moduleState.local.selectedPlayerId));
          var playerName = safeStr(local.selectedPlayerName || (ctx.moduleState && ctx.moduleState.local && ctx.moduleState.local.selectedPlayerName));
          if (!playerId) {
            setStatus("Select a rookie by name before submitting the draft pick.", "bad");
            return;
          }
          setStatus("Submitting draft pick and rookie contract...", "info");
          ctx.postAction("/acquisition-hub/rookie-draft/action", {
            action: "draft",
            player_id: playerId,
            player_name: playerName,
            round: safeStr(fd.get("round")),
            pick: safeStr(fd.get("pick"))
          }).then(function (payload) {
            var contractResult = payload && payload.contract_apply_result ? payload.contract_apply_result : null;
            var message = "Draft pick submitted.";
            if (contractResult && safeStr(contractResult.status_label)) {
              message += " " + safeStr(contractResult.status_label);
            }
            ctx.setLocalState({
              selectedPlayerId: "",
              selectedPlayerName: "",
              pickerQuery: ""
            });
            setStatus(message, contractResult && contractResult.ok === false ? "bad" : "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Draft action failed.", "bad");
          });
        });
      }
    }
  };
})();
