/* League → Trade view (mobile mirror of Trade War Room offer list).
 *
 * Phase 1: surfaces the viewer's incoming + outgoing offers from
 * /api/trades/proposals, with inline Accept / Decline / Cancel
 * controls. Building NEW offers from scratch on mobile is deferred
 * (the desktop Trade War Room has a complex player/pick picker
 * across two columns; mobile gets a deep-link to the desktop view
 * for now).
 *
 * Worker endpoints used (verbatim from desktop trade_workbench.js):
 *   GET  /api/trades/proposals?L=<lid>&franchise_id=<fid>
 *   POST /api/trades/proposals/action  (accept / decline / cancel)
 */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  var state = { offers: null, loading: false, error: null };

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
      '</div>';
  }

  function franchiseName(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Team " + fid);
  }

  function loadOffers() {
    if (state.loading) return Promise.resolve();
    if (!M.state.viewerFranchiseId) return Promise.resolve();
    state.loading = true; state.error = null;
    var url = M.api.workerUrl("/api/trades/proposals?L=" +
      encodeURIComponent(M.state.ctx.leagueId) +
      "&franchise_id=" + encodeURIComponent(M.state.viewerFranchiseId));
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        state.offers = data || { incoming: [], outgoing: [] };
        state.loading = false;
      })
      .catch(function (err) {
        state.error = (err && err.message) || String(err);
        state.loading = false;
      });
  }

  // Render a list of offer rows.
  function renderOffersList(offers, direction) {
    if (!offers || !offers.length) {
      return '<div class="ups-m-stub"><div>No ' + direction + ' offers.</div></div>';
    }
    return offers.map(function (o) {
      return renderOfferCard(o, direction);
    }).join("");
  }

  // Parse the trade-asset CSV (same shape as tradeBait — pids + DP_/FP_/BB_).
  function describeAssetCsv(csv) {
    var tokens = U.safeStr(csv).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return tokens.map(function (t) {
      return M.data.describeTradeBaitToken
        ? M.data.describeTradeBaitToken(t)
        : t;
    });
  }

  function renderOfferCard(offer, direction) {
    // offer fields (defensive against shape drift):
    //   trade_id / id
    //   offered_by / from_franchise_id, offered_to / to_franchise_id
    //   offered_assets / will_give_up_a (CSV)
    //   requested_assets / will_give_up_b (CSV)
    //   note / message / comments
    //   timestamp / submitted_at
    var tradeId = U.safeStr(offer.trade_id || offer.id || "");
    var fromFid = U.pad4(offer.offered_by || offer.from_franchise_id || offer.franchise_id || "");
    var toFid = U.pad4(offer.offered_to || offer.to_franchise_id || "");
    var myAssetsCsv = direction === "incoming"
      ? (offer.requested_assets || offer.will_give_up_b || offer.you_give || "")
      : (offer.offered_assets || offer.will_give_up_a || offer.you_give || "");
    var theirAssetsCsv = direction === "incoming"
      ? (offer.offered_assets || offer.will_give_up_a || offer.they_give || "")
      : (offer.requested_assets || offer.will_give_up_b || offer.they_give || "");
    var note = U.safeStr(offer.note || offer.message || offer.comments || "");
    var other = direction === "incoming" ? fromFid : toFid;

    var myAssets = describeAssetCsv(myAssetsCsv);
    var theirAssets = describeAssetCsv(theirAssetsCsv);

    var actionsHtml = '';
    if (direction === "incoming") {
      actionsHtml = '<div class="ups-m-trade-actions">' +
        '<button class="btn-act otb on" data-act="accept" data-trade-id="' + U.escapeHtml(tradeId) + '">Accept</button>' +
        '<button class="btn-act drop" data-act="decline" data-trade-id="' + U.escapeHtml(tradeId) + '">Decline</button>' +
      '</div>';
    } else {
      actionsHtml = '<div class="ups-m-trade-actions">' +
        '<button class="btn-act" data-act="cancel" data-trade-id="' + U.escapeHtml(tradeId) + '">Cancel offer</button>' +
      '</div>';
    }

    return '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">' +
        (direction === "incoming" ? "From: " : "To: ") + U.escapeHtml(franchiseName(other)) +
      '</div>' +
      '<div class="ups-m-trade-cols">' +
        '<div class="ups-m-trade-col">' +
          '<div class="lbl">' + (direction === "incoming" ? "You give" : "You give") + '</div>' +
          (myAssets.length
            ? '<ul>' + myAssets.map(function (a) { return '<li>' + U.escapeHtml(a) + '</li>'; }).join("") + '</ul>'
            : '<div class="muted">—</div>') +
        '</div>' +
        '<div class="ups-m-trade-col">' +
          '<div class="lbl">You get</div>' +
          (theirAssets.length
            ? '<ul>' + theirAssets.map(function (a) { return '<li>' + U.escapeHtml(a) + '</li>'; }).join("") + '</ul>'
            : '<div class="muted">—</div>') +
        '</div>' +
      '</div>' +
      (note ? '<div class="ups-m-trade-note"><span class="lbl">Note:</span> ' + U.escapeHtml(note) + '</div>' : '') +
      actionsHtml +
    '</div>';
  }

  // Deep-link to desktop Trade War Room (MFL home MODULE=MESSAGE6=N with
  // twb_* params) for building a new offer from scratch.
  function buildTradeWarRoomUrl() {
    var ctx = M.state.ctx;
    var fid = U.pad4(M.state.viewerFranchiseId);
    var base = "https://www48.myfantasyleague.com/" + encodeURIComponent(ctx.year) +
               "/home/" + encodeURIComponent(ctx.leagueId);
    var qs = "MODULE=MESSAGE6%3DN";
    var hash = "twb_left_team=" + encodeURIComponent(fid) + "&twb_side=left";
    return base + "?" + qs + "#" + hash;
  }

  function postTradeAction(action, tradeId) {
    var url = M.api.workerUrl("/api/trades/proposals/action");
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: action,
        trade_id: tradeId,
        league_id: M.state.ctx.leagueId,
        franchise_id: M.state.viewerFranchiseId,
        year: M.state.ctx.year
      })
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    });
  }

  function handleAction(action, tradeId) {
    var prompt = action === "accept" ? "Accept this trade?\n\nWrites to MFL." :
                 action === "decline" ? "Decline this trade?" :
                 "Cancel this outgoing offer?";
    if (!window.confirm(prompt)) return;
    M.ui.showToast(action[0].toUpperCase() + action.slice(1) + "ing…", "info");
    postTradeAction(action, tradeId).then(function (resp) {
      if (resp.ok) {
        M.ui.showToast("Done ✓", "ok");
        state.offers = null;
        // Reload everything: trade actions can mutate roster + cap, and we
        // need fresh trade offers + nav badge count.
        if (M.actions && M.actions.reloadData) {
          return M.actions.reloadData().then(function () { M.route.renderRoute(); });
        }
        return loadOffers().then(function () { M.route.renderRoute(); });
      }
      var err = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      M.ui.showToast("Failed: " + err, "err");
    }).catch(function (err) {
      M.ui.showToast("Failed: " + (err && err.message || err), "err");
    });
  }

  function render(mount) {
    // Pre-load: loadAllData fetches trade offers as part of its
    // post-franchise-resolve step, so the badge on the League nav can
    // appear before the user navigates here. Always prefer the global
    // M.state.tradeOffers copy so reloadData() bust-invalidates the cache.
    if (M.state.tradeOffers) {
      state.offers = M.state.tradeOffers;
    } else if (!state.offers && !state.loading) {
      loadOffers().then(function () { M.route.renderRoute(); });
      mount.innerHTML = subTabs("trade") + '<div class="ups-m-loading">Loading offers…</div>';
      return;
    }
    if (state.loading) {
      mount.innerHTML = subTabs("trade") + '<div class="ups-m-loading">Loading offers…</div>';
      return;
    }
    if (state.error) {
      mount.innerHTML = subTabs("trade") +
        '<div class="ups-m-error">Failed to load: ' + U.escapeHtml(state.error) + '</div>';
      return;
    }
    var data = state.offers || {};
    var incoming = data.incoming || [];
    var outgoing = data.outgoing || [];

    var html = subTabs("trade");
    // CTA — open desktop builder.
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Build a new offer</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'Mobile shows offers + accept/decline. The full picker (drag players + picks) lives on desktop.' +
      '</div>' +
      '<a class="ups-m-desktop-link" style="margin:0" href="' + buildTradeWarRoomUrl() + '" target="_blank">Open Trade War Room (desktop)</a>' +
    '</div>';

    html += '<div class="ups-m-pos-group">Incoming · ' + incoming.length + '</div>';
    html += renderOffersList(incoming, "incoming");
    html += '<div class="ups-m-pos-group" style="margin-top:18px">Outgoing · ' + outgoing.length + '</div>';
    html += renderOffersList(outgoing, "outgoing");

    mount.innerHTML = html;

    var btns = mount.querySelectorAll(".btn-act[data-act]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        handleAction(this.getAttribute("data-act"), this.getAttribute("data-trade-id"));
      });
    }
  }

  M.tradeView = { render: render };
})();
