(function () {
  "use strict";

  window.UPS_ACQ_MODULES = window.UPS_ACQ_MODULES || {};

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  window.UPS_ACQ_MODULES["expired-rookie-auction"] = {
    key: "expired-rookie-auction",
    title: "Expired Rookie Auction",
    historyPath: "/acquisition-hub/expired-rookie-auction/history",
    livePath: "/acquisition-hub/expired-rookie-auction/live",
    refresh: { visibleMs: 30000, hiddenMs: 60000 },
    render: function (ctx) {
      var h = ctx.helpers;
      var moduleState = ctx.moduleState || {};
      var live = moduleState.live || {};
      var history = moduleState.history || {};
      var search = safeStr(ctx.shared.search).toLowerCase();
      var activeRows = (live.active_auctions || []).filter(function (row) {
        var text = [row.player_name, row.position, row.player_id].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      });
      var eligibleRows = (live.eligible_players || []).filter(function (row) {
        var text = [row.player_name, row.position, row.player_id, row.franchise_name].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      }).slice(0, 50);
      var historyRows = (history.history_rows || []).filter(function (row) {
        var text = [row.player_name, row.team_name, row.position].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      }).slice(0, 40);

      return '' +
        '<div class="acq-page">' +
          '<section class="acq-card acq-card-hero">' +
            '<div>' +
              '<div class="acq-kicker">Extension-sensitive live pool</div>' +
              '<h2 class="acq-section-title">Expired Rookie Auction</h2>' +
              '<p class="acq-muted">Eligibility is recomputed from current contract state each refresh. New high bids should reset the clock to 36 hours.</p>' +
            '</div>' +
            '<div class="acq-kpi-grid">' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Eligible</span><strong>' + String((live.eligible_players || []).length) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Active Auctions</span><strong>' + String(activeRows.length) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Extension Markers</span><strong>' + String((live.extension_markers || []).length) + '</strong></div>' +
            '</div>' +
          '</section>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Bid / Nominate</h3><span class="acq-pill">36h reset</span></div>' +
              '<form id="acqExpiredAuctionForm" class="acq-form-grid">' +
                '<label class="acq-field"><span>Player ID</span><input name="player_id" type="text" placeholder="MFL player id"></label>' +
                '<label class="acq-field"><span>Bid / Open</span><input name="amount" type="number" min="1" placeholder="1000"></label>' +
                '<div class="acq-inline-actions">' +
                  '<button type="submit" name="mode" value="bid" class="acq-btn acq-btn-primary">Submit Bid</button>' +
                  '<button type="submit" name="mode" value="nominate" class="acq-btn acq-btn-secondary">Nominate Player</button>' +
                '</div>' +
              '</form>' +
              '<div id="acqExpiredAuctionStatus" class="acq-note"></div>' +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Active Expired Rookie Auctions</h3><span class="acq-pill">Live clock</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "high_bid_amount", label: "High Bid" },
                { key: "high_bidder_label", label: "Leader" },
                { key: "timer_text", label: "Clock" }
              ], activeRows, "No active expired-rookie auctions are visible right now.") +
            '</section>' +
          '</div>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Eligible Pool</h3><span class="acq-pill">Updated live</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "nfl_team", label: "NFL" },
                { key: "franchise_name", label: "Current Team" }
              ], eligibleRows, "No eligible expired rookies match the current filter.") +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Historical Winners</h3><span class="acq-pill">Final bids</span></div>' +
              h.renderTable([
                { key: "season", label: "Season" },
                { key: "player_name", label: "Player" },
                { key: "team_name", label: "Winner" },
                { key: "bid_amount", label: "Bid" }
              ], historyRows, "No expired-rookie auction history rows available.") +
            '</section>' +
          '</div>' +
        '</div>';
    },
    bind: function (root, ctx) {
      var form = root.querySelector("#acqExpiredAuctionForm");
      var statusEl = root.querySelector("#acqExpiredAuctionStatus");

      function setStatus(message, tone) {
        if (!statusEl) return;
        statusEl.className = "acq-note" + (tone ? (" is-" + tone) : "");
        statusEl.textContent = message;
      }

      if (!form) return;
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var submitter = event.submitter;
        var mode = safeStr(submitter && submitter.value).toLowerCase() || "bid";
        var fd = new FormData(form);
        setStatus("Submitting expired rookie auction action...", "info");
        ctx.postAction("/acquisition-hub/expired-rookie-auction/action", {
          action: mode,
          player_id: safeStr(fd.get("player_id")),
          amount: safeStr(fd.get("amount"))
        }).then(function () {
          setStatus("Expired rookie action submitted. Refreshing board...", "good");
        }).catch(function (err) {
          setStatus(err && err.message ? err.message : "Expired rookie action failed.", "bad");
        });
      });
    }
  };
})();
