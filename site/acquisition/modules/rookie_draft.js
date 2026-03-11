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

  window.UPS_ACQ_MODULES["rookie-draft"] = {
    key: "rookie-draft",
    title: "Rookie Draft Room",
    historyPath: "/acquisition-hub/rookie-draft/history",
    livePath: "/acquisition-hub/rookie-draft/live",
    refresh: { visibleMs: 5000, hiddenMs: 15000 },
    render: function (ctx) {
      var h = ctx.helpers;
      var moduleState = ctx.moduleState || {};
      var live = moduleState.live || {};
      var history = moduleState.history || {};
      var search = safeStr(ctx.shared.search).toLowerCase();
      var teamFilter = safeStr(ctx.shared.teamId);
      var boardRows = (live.live_board || []).filter(function (row) {
        var text = [row.player_name, row.franchise_name, row.position, row.player_id].join(" ").toLowerCase();
        if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
        if (search && text.indexOf(search) === -1) return false;
        return true;
      });
      var historyRows = (history.history_rows || []).filter(function (row) {
        var text = [row.player_name, row.franchise_name, row.position, row.player_id].join(" ").toLowerCase();
        if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
        if (search && text.indexOf(search) === -1) return false;
        return true;
      }).slice(0, 40);
      var adpRows = (history.adp_board || []).filter(function (row) {
        var text = [row.player_name, row.position, row.player_id].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      }).slice(0, 24);
      var topHits = (history.top_hits || []).slice(0, 12);
      var currentPick = live.current_pick || {};
      var viewer = ctx.bootstrap && ctx.bootstrap.viewer ? ctx.bootstrap.viewer : {};
      var currentPickLabel = currentPick.round
        ? (safeInt(currentPick.round, 0) + "." + String(safeInt(currentPick.pick, 0)).padStart(2, "0"))
        : "Waiting on live draft status";

      return '' +
        '<div class="acq-page">' +
          '<section class="acq-card acq-card-hero">' +
            '<div>' +
              '<div class="acq-kicker">Live rookie board</div>' +
              '<h2 class="acq-section-title">Rookie Draft Room</h2>' +
              '<p class="acq-muted">' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.message) || "Live draft data updates every 5 seconds while this tab is visible.") + '</p>' +
            '</div>' +
            '<div class="acq-kpi-grid">' +
              '<div class="acq-kpi"><span class="acq-kpi-label">On the Clock</span><strong>' + h.escapeHtml(currentPickLabel) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Picks Logged</span><strong>' + String((live.live_board || []).length) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Timer</span><strong>' + h.escapeHtml(safeStr(live.draft_status && live.draft_status.timer_text) || "Live") + '</strong></div>' +
            '</div>' +
          '</section>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Draft Controls</h3><span class="acq-pill">' + (viewer.is_commish ? "Commish" : "Owner") + '</span></div>' +
              '<form id="acqRookieDraftForm" class="acq-form-grid">' +
                '<label class="acq-field"><span>Player ID</span><input name="player_id" type="text" placeholder="MFL player id"></label>' +
                '<label class="acq-field"><span>Round</span><input name="round" type="number" min="1" value="' + h.escapeHtml(safeStr(currentPick.round || "")) + '"></label>' +
                '<label class="acq-field"><span>Pick</span><input name="pick" type="number" min="1" value="' + h.escapeHtml(safeStr(currentPick.pick || "")) + '"></label>' +
                '<button type="submit" class="acq-btn acq-btn-primary">Submit Draft Pick</button>' +
              '</form>' +
              (viewer.is_commish ? (
                '<div class="acq-inline-actions">' +
                  '<button type="button" class="acq-btn acq-btn-secondary" data-acq-commissioner="pause">Pause</button>' +
                  '<button type="button" class="acq-btn acq-btn-secondary" data-acq-commissioner="resume">Resume</button>' +
                  '<button type="button" class="acq-btn acq-btn-secondary" data-acq-commissioner="skip">Skip</button>' +
                  '<button type="button" class="acq-btn acq-btn-secondary" data-acq-commissioner="undo">Undo</button>' +
                '</div>'
              ) : "") +
              '<div id="acqRookieDraftActionStatus" class="acq-note"></div>' +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Draft Order</h3><span class="acq-pill">' + String((live.draft_order || []).length) + ' picks</span></div>' +
              '<div class="acq-list acq-list-compact">' +
                (live.draft_order || []).slice(0, 24).map(function (row) {
                  return '<div class="acq-list-row"><strong>' + h.escapeHtml(safeStr(row.pick_label)) + '</strong><span>' + h.escapeHtml(safeStr(row.franchise_name)) + '</span></div>';
                }).join("") +
              '</div>' +
            '</section>' +
          '</div>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Live Board</h3><span class="acq-pill">' + String(boardRows.length) + ' shown</span></div>' +
              h.renderTable([
                { key: "pick", label: "Pick" },
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "franchise_name", label: "Team" }
              ], boardRows.slice(0, 32).map(function (row) {
                return {
                  pick: pickLabel(row),
                  player_name: row.player_name,
                  position: row.position,
                  franchise_name: row.franchise_name
                };
              }), "No live picks yet.") +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>ADP Board</h3><span class="acq-pill">Dynasty / SF</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "season", label: "Season" },
                { key: "normalized_adp", label: "ADP" }
              ], adpRows, "No ADP rows available.") +
            '</section>' +
          '</div>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Rookie Value Lab</h3><span class="acq-pill">Top hits</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "pick_overall", label: "Pick" },
                { key: "rookie_value_score", label: "Score" },
                { key: "points_rookiecontract", label: "3Y Pts" }
              ], topHits, "No rookie value rows available.") +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Historical Picks</h3><span class="acq-pill">1st 3 years</span></div>' +
              h.renderTable([
                { key: "pick_label", label: "Pick" },
                { key: "player_name", label: "Player" },
                { key: "franchise_name", label: "Team" },
                { key: "points_rookiecontract", label: "3Y Pts" },
                { key: "rookie_value_score", label: "Score" }
              ], historyRows.map(function (row) {
                return {
                  pick_label: pickLabel(row),
                  player_name: row.player_name,
                  franchise_name: row.franchise_name,
                  points_rookiecontract: row.points_rookiecontract,
                  rookie_value_score: row.rookie_value_score
                };
              }), "No historical rookie picks match the current filters.") +
            '</section>' +
          '</div>' +
        '</div>';
    },
    bind: function (root, ctx) {
      var form = root.querySelector("#acqRookieDraftForm");
      var statusEl = root.querySelector("#acqRookieDraftActionStatus");

      function setStatus(message, tone) {
        if (!statusEl) return;
        statusEl.className = "acq-note" + (tone ? (" is-" + tone) : "");
        statusEl.textContent = message;
      }

      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var fd = new FormData(form);
          setStatus("Submitting draft pick...", "info");
          ctx.postAction("/acquisition-hub/rookie-draft/action", {
            action: "draft",
            player_id: safeStr(fd.get("player_id")),
            round: safeStr(fd.get("round")),
            pick: safeStr(fd.get("pick"))
          }).then(function () {
            setStatus("Draft action submitted. Refreshing board...", "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Draft action failed.", "bad");
          });
        });
      }

      Array.prototype.forEach.call(root.querySelectorAll("[data-acq-commissioner]"), function (button) {
        button.addEventListener("click", function () {
          var action = safeStr(button.getAttribute("data-acq-commissioner")).toLowerCase();
          setStatus("Submitting commissioner action...", "info");
          ctx.postAction("/acquisition-hub/rookie-draft/action", { action: action }).then(function () {
            setStatus("Commissioner action submitted. Refreshing board...", "good");
          }).catch(function (err) {
            setStatus(err && err.message ? err.message : "Commissioner action failed.", "bad");
          });
        });
      });
    }
  };
})();
