(function () {
  "use strict";

  window.UPS_ACQ_MODULES = window.UPS_ACQ_MODULES || {};

  function safeStr(value) {
    return value == null ? "" : String(value).trim();
  }

  window.UPS_ACQ_MODULES["free-agent-auction"] = {
    key: "free-agent-auction",
    title: "Free Agent Auction",
    historyPath: "/acquisition-hub/free-agent-auction/history",
    livePath: "/acquisition-hub/free-agent-auction/live",
    refresh: { visibleMs: 20000, hiddenMs: 60000 },
    render: function (ctx) {
      var h = ctx.helpers;
      var moduleState = ctx.moduleState || {};
      var live = moduleState.live || {};
      var history = moduleState.history || {};
      var search = safeStr(ctx.shared.search).toLowerCase();
      var teamFilter = safeStr(ctx.shared.teamId);
      var activeRows = (live.active_auctions || []).filter(function (row) {
        var text = [row.player_name, row.position, row.high_bidder_label].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      });
      var budgetRows = (live.team_budget_rows || []).filter(function (row) {
        var text = [row.franchise_name, row.franchise_id].join(" ").toLowerCase();
        if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
        return !search || text.indexOf(search) !== -1;
      });
      var needsRows = (live.team_need_rows || []).filter(function (row) {
        if (teamFilter && safeStr(row.franchise_id) !== teamFilter) return false;
        return true;
      });
      var availablePlayers = (live.available_players || []).filter(function (row) {
        var text = [row.player_name, row.position, row.team, row.player_id].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      }).slice(0, 36);
      var historyRows = (history.history_rows || []).filter(function (row) {
        var text = [row.player_name, row.team_name, row.position, row.player_id].join(" ").toLowerCase();
        return !search || text.indexOf(search) !== -1;
      }).slice(0, 40);
      var contractRows = (history.contract_rows || []).slice(0, 24);

      return '' +
        '<div class="acq-page">' +
          '<section class="acq-card acq-card-hero">' +
            '<div>' +
              '<div class="acq-kicker">Proxy auction tracking</div>' +
              '<h2 class="acq-section-title">Free Agent Auction</h2>' +
              '<p class="acq-muted">Live bids refresh every 20 seconds while visible. New high bids should reset the clock to 24 hours.</p>' +
            '</div>' +
            '<div class="acq-kpi-grid">' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Active Auctions</span><strong>' + String(activeRows.length) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">Top Board Size</span><strong>' + String((live.available_players || []).length) + '</strong></div>' +
              '<div class="acq-kpi"><span class="acq-kpi-label">History Rows</span><strong>' + String((history.history_rows || []).length) + '</strong></div>' +
            '</div>' +
          '</section>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Bid / Nominate</h3><span class="acq-pill">Native UI relay</span></div>' +
              '<form id="acqAuctionBidForm" class="acq-form-grid">' +
                '<label class="acq-field"><span>Player ID</span><input name="player_id" type="text" placeholder="MFL player id"></label>' +
                '<label class="acq-field"><span>Bid / Open</span><input name="amount" type="number" min="1" placeholder="1000"></label>' +
                '<div class="acq-inline-actions">' +
                  '<button type="submit" name="mode" value="bid" class="acq-btn acq-btn-primary">Submit Bid</button>' +
                  '<button type="submit" name="mode" value="nominate" class="acq-btn acq-btn-secondary">Nominate Player</button>' +
                '</div>' +
              '</form>' +
              '<div id="acqAuctionActionStatus" class="acq-note"></div>' +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Active Auctions</h3><span class="acq-pill">24h reset</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "high_bid_amount", label: "High Bid" },
                { key: "high_bidder_label", label: "Leader" },
                { key: "timer_text", label: "Clock" }
              ], activeRows, "No active auction rows were parsed from MFL.") +
            '</section>' +
          '</div>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Team Budgets</h3><span class="acq-pill">Legal max bid</span></div>' +
              h.renderTable([
                { key: "franchise_name", label: "Team" },
                { key: "available_funds_dollars", label: "$$" },
                { key: "scenario_27_max_bid", label: "Max @27" },
                { key: "scenario_35_max_bid", label: "Max @35" }
              ], budgetRows, "No team budget rows available.") +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Team Needs</h3><span class="acq-pill">Lineup deficits</span></div>' +
              h.renderTable([
                { key: "franchise_name", label: "Team" },
                { key: "roster_count", label: "Roster" },
                { key: "total_deficit", label: "Need" },
                { key: "lineup_text", label: "Deficits" }
              ], needsRows.map(function (row) {
                var deficits = row.lineup_deficits || {};
                var lineupText = Object.keys(deficits).filter(function (key) {
                  return deficits[key];
                }).map(function (key) {
                  return key + ":" + deficits[key];
                }).join(" | ");
                return {
                  franchise_name: row.franchise_name,
                  roster_count: row.roster_count,
                  total_deficit: row.total_deficit,
                  lineup_text: lineupText || "Ready"
                };
              }), "No team need rows available.") +
            '</section>' +
          '</div>' +

          '<div class="acq-grid acq-grid-two">' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Top Available Players</h3><span class="acq-pill">Value board</span></div>' +
              h.renderTable([
                { key: "player_name", label: "Player" },
                { key: "position", label: "Pos" },
                { key: "team", label: "NFL" },
                { key: "upcoming_auction_value", label: "Model $" }
              ], availablePlayers, "No available-player value rows available.") +
            '</section>' +
            '<section class="acq-card">' +
              '<div class="acq-card-head"><h3>Historical Winning Bids</h3><span class="acq-pill">Final bids</span></div>' +
              h.renderTable([
                { key: "season", label: "Season" },
                { key: "player_name", label: "Player" },
                { key: "team_name", label: "Winner" },
                { key: "bid_amount", label: "Bid" }
              ], historyRows, "No historical free-agent auction rows available.") +
            '</section>' +
          '</div>' +

          '<section class="acq-card">' +
            '<div class="acq-card-head"><h3>Historical Contracts</h3><span class="acq-pill">Manual review source</span></div>' +
            h.renderTable([
              { key: "season", label: "Season" },
              { key: "player_name", label: "Player" },
              { key: "franchise_name", label: "Team" },
              { key: "contract_length", label: "Years" },
              { key: "aav", label: "AAV" }
            ], contractRows, "No historical auction contract rows available.") +
          '</section>' +
        '</div>';
    },
    bind: function (root, ctx) {
      var form = root.querySelector("#acqAuctionBidForm");
      var statusEl = root.querySelector("#acqAuctionActionStatus");

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
        setStatus("Submitting auction action...", "info");
        ctx.postAction("/acquisition-hub/free-agent-auction/action", {
          action: mode,
          player_id: safeStr(fd.get("player_id")),
          amount: safeStr(fd.get("amount"))
        }).then(function () {
          setStatus("Auction action submitted. Refreshing board...", "good");
        }).catch(function (err) {
          setStatus(err && err.message ? err.message : "Auction action failed.", "bad");
        });
      });
    }
  };
})();
