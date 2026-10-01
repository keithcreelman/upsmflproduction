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
  // 3-way trades: rendered by the SHARED module (site/shared/trade_3way_view.js) from
  // the canonical server object, identically to the desktop War Room.
  var T = window.UPS_TRADE_3WAY;
  var tw = {
    listStatus: "idle", list: [], listProblem: null,           // idle | loading | ok | error
    wantConfirm: "", openSeq: 0,
    detailStatus: "idle", detail: null, detailProblem: null, detailId: "",
    lastRoute: "list", cancel: {}, ack: {}, seq: 0
  };

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

  function franchiseName(fid) {
    var f = (M.state.franchises || []).find(function (x) { return x.id === U.pad4(fid); });
    return f ? f.name : ("Team " + fid);
  }

  // The inbox is ALWAYS one of three honest states (see app.js fetchTradeOffers): "ok" (a real list —
  // an empty one really means 0 offers), "signed_out" (no/invalid session → "Sign in to view trades"),
  // "error" (couldn't load → explicit error + Try again). An unavailable inbox is never shown as "0 offers".
  function unavailable(status, message) { return { incoming: [], outgoing: [], status: status, error: message || "" }; }

  function loadOffers() {
    if (state.loading) return Promise.resolve();
    var storedTok = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (!storedTok) { state.offers = unavailable("signed_out", "Sign in to view trades"); return Promise.resolve(); }
    if (!M.state.viewerFranchiseId) { state.offers = unavailable("error", "Couldn't tell which team is yours yet"); return Promise.resolve(); }
    state.loading = true; state.error = null;
    // Listing offers reads MFL's pendingTrades AS THE OWNER — forward
    // MFL_USER_ID + YEAR or the worker returns 401/empty (the just-created
    // offer is in MFL but won't render). Same pattern as the write paths.
    var url = M.api.workerUrl("/api/trades/proposals?L=" +
      encodeURIComponent(M.state.ctx.leagueId) +
      "&YEAR=" + encodeURIComponent(M.state.ctx.year) +
      "&franchise_id=" + encodeURIComponent(M.state.viewerFranchiseId) +
      // include_payload=1 → offers carry payload.extension_requests so the
      // cards can show pre-trade extensions (twb_meta isn't written in prod).
      "&include_payload=1");
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, { mode: "cors", credentials: "omit" })
      // A failed fetch must NOT read as "you have no offers". The worker returns
      // 401 when the MFL owner session is missing/expired, and the old code
      // mapped that to null -> empty arrays, so a signed-out owner was shown a
      // confident "0 incoming / 0 outgoing" (Keith 2026-07-25: Pure Greatness
      // couldn't see a real offer from Blake and we spent the morning hunting a
      // phantom submit bug). Carry the status through and surface it instead.
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (body) {
          return { status: r.status, ok: r.ok, body: body };
        });
      })
      .then(function (res) {
        var body = res.body;
        var failed = !res.ok || (body && body.ok === false);
        if (failed) {
          var upLookup = Number(body && body.pending_lookup && body.pending_lookup.upstream_status);
          var isAuth = res.status === 401 || res.status === 403 || upLookup === 401 || upLookup === 403 ||
            /MFL_USER_ID|owner session|missing_owner_session/i.test(
              (body && (body.error || body.reason)) || "");
          state.error = null;
          state.offers = isAuth
            ? unavailable("signed_out", "Sign in to view trades")
            : unavailable("error", "Couldn't load trade offers" + (res.status >= 500 || !(body && (body.error || body.reason)) ? " (HTTP " + res.status + ")" : ""));
          state.loading = false;
          return;
        }
        state.error = null;
        // A body without both lists is a bad answer, not an empty inbox.
        state.offers = (body && Array.isArray(body.incoming) && Array.isArray(body.outgoing))
          ? { incoming: body.incoming, outgoing: body.outgoing, status: "ok" }
          : unavailable("error", "Couldn't load trade offers");
        state.loading = false;
      })
      .catch(function () {
        state.error = null;
        state.offers = unavailable("error", "Couldn't reach the server to load trade offers");
        state.loading = false;
      });
  }

  function renderInboxUnavailable(offers) {
    if (offers.status === "signed_out") {
      return '<div class="ups-m-card" data-inbox-state="signed_out">' +
        '<div class="ups-m-card-title">Sign in to view trades</div>' +
        '<div style="font-size:13px;color:var(--fg-muted);line-height:1.45">Your trades live in MFL, so you have to be signed in to see them. Open this page from inside the MFL site (or sign in to MFL) and they\'ll load here.</div>' +
      '</div>';
    }
    return '<div class="ups-m-card" data-inbox-state="error">' +
      '<div class="ups-m-card-title">Couldn\'t load your trades</div>' +
      '<div style="font-size:13px;color:var(--fg-muted);line-height:1.45;margin-bottom:10px">' + U.escapeHtml(offers.error || "Something went wrong loading your trade offers.") + ' Nothing has been changed.</div>' +
      '<button class="btn-act otb on" id="ups-m-trade-retry" style="width:100%">Try again</button>' +
    '</div>';
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
    // The worker (normalizePendingProposal) sends `will_give_up` / `will_receive`
    // CSVs from the OFFERING franchise's perspective. Outgoing: you = the
    // offerer, so you give `will_give_up` and get `will_receive`. Incoming: you
    // = the recipient, so it flips. (Older `*_assets`/`*_give` names kept as
    // fallbacks in case the shape ever changes.)
    var myAssetsCsv = direction === "incoming"
      ? (offer.will_receive || offer.requested_assets || offer.will_give_up_b || offer.you_give || "")
      : (offer.will_give_up || offer.offered_assets || offer.will_give_up_a || offer.you_give || "");
    var theirAssetsCsv = direction === "incoming"
      ? (offer.will_give_up || offer.offered_assets || offer.will_give_up_a || offer.they_give || "")
      : (offer.will_receive || offer.requested_assets || offer.will_give_up_b || offer.they_give || "");
    var note = U.safeStr(offer.note || offer.message || offer.comments || "");
    var other = direction === "incoming" ? fromFid : toFid;

    var myAssets = describeAssetCsv(myAssetsCsv);
    var theirAssets = describeAssetCsv(theirAssetsCsv);

    // Pre-trade extensions ride in the stored payload (the [UPS_TWB_META] comment
    // tag isn't written in prod, so twb_meta is null) — hence include_payload=1 on
    // the list fetch. Surface them so BOTH owners see the extension that's part of
    // the deal; each is applied by the franchise giving that player up.
    var exts = (offer.payload && Array.isArray(offer.payload.extension_requests))
      ? offer.payload.extension_requests : [];
    var extHtml = "";
    if (exts.length) {
      extHtml = '<div class="ups-m-trade-ext"><span class="lbl">' +
        (exts.length > 1 ? "Pre-trade extensions" : "Pre-trade extension") + '</span><ul>' +
        exts.map(function (e) {
          var term = U.safeStr(e.extension_term) === "2YR" ? "+2 yr" : "+1 yr";
          var aav = U.safeInt(e.new_aav_future, 0);
          var who = franchiseName(U.pad4(e.from_franchise_id));
          return '<li>' + U.escapeHtml(U.safeStr(e.player_name) || U.safeStr(e.player_id)) +
            ' <span class="term">' + term + '</span>' +
            (aav > 0 ? ' → ' + U.escapeHtml(U.fmtUsd(aav)) + ' AAV' : '') +
            ' <span class="by">by ' + U.escapeHtml(who) + '</span></li>';
        }).join("") + '</ul></div>';
    }

    var actionsHtml = '';
    if (direction === "incoming") {
      actionsHtml = '<div class="ups-m-trade-actions">' +
        '<button class="btn-act otb on" data-act="accept" data-trade-id="' + U.escapeHtml(tradeId) + '">Accept</button>' +
        '<button class="btn-act ext" data-act="counter" data-trade-id="' + U.escapeHtml(tradeId) + '" data-from-fid="' + U.escapeHtml(fromFid) + '">Counter</button>' +
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
      extHtml +
      (note ? '<div class="ups-m-trade-note"><span class="lbl">Note:</span> ' + U.escapeHtml(note) + '</div>' : '') +
      actionsHtml +
    '</div>';
  }

  // Deep-link to desktop Trade War Room (MFL home MODULE=MESSAGE6=N with
  // twb_* params). Retained as an escape hatch for trades that include a
  // CURRENT-YEAR draft pick (DP_), which the native builder intentionally
  // doesn't offer (see the builder header comment).
  function buildTradeWarRoomUrl() {
    var ctx = M.state.ctx;
    var fid = U.pad4(M.state.viewerFranchiseId);
    var base = "https://www48.myfantasyleague.com/" + encodeURIComponent(ctx.year) +
               "/home/" + encodeURIComponent(ctx.leagueId);
    var qs = "MODULE=MESSAGE6%3DN";
    var hash = "twb_left_team=" + encodeURIComponent(fid) + "&twb_side=left";
    return base + "?" + qs + "#" + hash;
  }

  // ════════════════════ Native trade offer builder ════════════════════
  // Builds a proposal IN-APP and POSTs the SAME /api/trades/proposals payload
  // the desktop Trade War Room uses. Asset → MFL-token mapping mirrors the
  // worker's buildTradeProposalAssetLists (worker/src/index.js:18858):
  //   • Player        → token is the bare player_id  (type:"PLAYER")
  //   • Future pick   → FP_<origfid>_<year>_<round>   (type:"PICK")
  //   • Cap money     → set traded_salary_adjustment_k; the worker derives the
  //                     BB_ blind-bid token from the per-side net.
  // The two sides are role:"left" (me, giving) and role:"right" (them, giving
  // to me) — the worker keys on `role`.
  //
  // IMPORTANT: this creates a REAL, cancellable pending MFL offer — there is
  // NO dry-run for trade proposals. CURRENT-YEAR draft picks (DP_) are
  // deliberately NOT selectable: their MFL token is a 0-indexed re-encoding
  // that can't be safely confirmed without a dry-run, and a wrong-but-valid
  // token would silently propose the WRONG pick. Trade those on desktop via
  // the Trade War Room link instead.
  var builderState = null;
  function freshBuilderState() {
    return {
      step: 1, counterpartyFid: "",
      counterMode: false, counterTradeId: "",
      inv: {}, loadingInv: false, invError: "",
      giveIds: {}, getIds: {},
      myCapK: 0, theirCapK: 0,
      comment: "", submitting: false, error: "",
      // Pre-trade extensions on give-side players: { asset_id: { enabled, option_key } }.
      extensions: {}
    };
  }

  function inventoryUrl(fid) {
    return M.api.workerUrl("/api/franchise-assets?L=" +
      encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" +
      encodeURIComponent(M.state.ctx.year) + "&fid=" + encodeURIComponent(U.pad4(fid)));
  }
  function loadInventoryFor(fid) {
    var key = U.pad4(fid);
    if (builderState.inv[key]) return Promise.resolve(builderState.inv[key]);
    return fetch(inventoryUrl(key), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var inv = {
          players: (data && data.players) || [],
          future_picks: (data && data.future_picks) || []
        };
        builderState.inv[key] = inv;
        return inv;
      });
  }

  function playerToSelectedAsset(p) {
    return {
      asset_id: "P_" + p.player_id, type: "PLAYER",
      player_id: String(p.player_id), player_name: p.display || null,
      description: null, position: p.position || null, nfl_team: p.nfl_team || null,
      salary: U.safeInt(p.salary, 0),
      // years = MFL contractYear = years-remaining (cy). Do NOT also set a
      // `contract_year` field here — the shared extension module would then
      // mis-derive years_remaining from (contract_length - contract_year).
      years: (p.contract_year == null ? null : p.contract_year),
      contract_type: p.contract_status || null,
      contract_info: p.contract_info || null,
      contract_length: (p.contract_length == null ? null : p.contract_length),
      already_extended_by_this_franchise: !!p.already_extended_by_this_franchise,
      taxi: !!p.taxi,
      pick_key: null, pick_season: null, pick_round: null, pick_slot: null
    };
  }
  function futurePickToken(fp) {
    return "FP_" + U.pad4(fp.original_fid) + "_" + fp.year + "_" + fp.round;
  }
  function futurePickToSelectedAsset(fp) {
    var token = futurePickToken(fp);
    return {
      asset_id: token, type: "PICK",
      player_id: null, player_name: null,
      description: fp.display || (fp.year + " R" + fp.round),
      position: null, nfl_team: null, salary: 0, years: null,
      contract_type: null, contract_info: null, taxi: false,
      pick_key: token, pick_season: U.safeInt(fp.year, 0),
      pick_round: U.safeInt(fp.round, 0), pick_slot: null
    };
  }
  function selectedAssetsFor(fid, idMap) {
    var inv = builderState.inv[U.pad4(fid)] || { players: [], future_picks: [] };
    var out = [];
    (inv.players || []).forEach(function (p) {
      if (idMap["P_" + p.player_id]) out.push(playerToSelectedAsset(p));
    });
    (inv.future_picks || []).forEach(function (fp) {
      if (idMap[futurePickToken(fp)]) out.push(futurePickToSelectedAsset(fp));
    });
    return out;
  }
  function countSelected(idMap) {
    var n = 0; for (var k in idMap) { if (idMap[k]) n += 1; } return n;
  }

  // §A6 — the cap money a side may attach is ≤ 50% of the summed salary of the
  // NON-TAXI PLAYERS it trades away: floor(sumNonTaxiSalary / 2000) in $K.
  // Picks and taxi players don't unlock cap money, so a side with no non-taxi
  // player can attach $0 (this also enforces "can't send money-only / money +
  // pick only", league_context §A6). Mirrors the worker backstop
  // (worker/src/index.js:24939) and desktop getTradeSalaryMaxK.
  function maxCapKFor(fid, idMap) {
    var inv = builderState.inv[U.pad4(fid)] || { players: [] };
    var sum = 0;
    (inv.players || []).forEach(function (p) {
      if (idMap["P_" + p.player_id] && !p.taxi) sum += U.safeInt(p.salary, 0);
    });
    return Math.floor(sum / 2000);
  }

  // ── Overlay shell ──
  function openBuilder(opts) {
    opts = opts || {};
    if (!M.state.viewerFranchiseId) { M.ui.showToast("Pick your franchise first.", "err"); return; }
    builderState = freshBuilderState();
    var counter = !!opts.counterFid;
    var preFid = opts.counterFid || opts.toFid;  // pre-select counterparty (counter OR propose-to-team)
    if (counter) {
      builderState.counterMode = true;
      builderState.counterTradeId = U.safeStr(opts.counterTradeId);
    }
    if (preFid) builderState.counterpartyFid = U.pad4(preFid);
    var existing = document.getElementById("ups-m-tb-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-tb-overlay">' +
        '<div class="ups-m-drop-sheet ups-m-tb-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-tb-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">' + (counter ? "Counter offer" : "Build trade offer") + '</div>' +
            '<div class="sub" id="ups-m-tb-stepsub"></div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-tb-body"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    document.getElementById("ups-m-tb-close").addEventListener("click", closeBuilder);
    if (preFid) {
      // Pre-selected counterparty (counter back to the offerer, or "Propose
      // trade" from a rostered player) — skip the picker, load both
      // inventories, and jump straight to asset selection.
      builderState.step = 2;
      builderState.loadingInv = true;
      renderBuilder();
      Promise.all([
        loadInventoryFor(M.state.viewerFranchiseId),
        loadInventoryFor(builderState.counterpartyFid)
      ]).then(function () {
        builderState.loadingInv = false;
        if (opts.preGetPid) builderState.getIds["P_" + opts.preGetPid] = true;
        renderBuilder();
      }).catch(function (e) {
        builderState.loadingInv = false;
        builderState.invError = (e && e.message) || String(e);
        renderBuilder();
      });
    } else {
      renderBuilder();
    }
  }
  function closeBuilder() {
    var ov = document.getElementById("ups-m-tb-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
    builderState = null;
  }

  function renderBuilder() {
    var sub = document.getElementById("ups-m-tb-stepsub");
    var body = document.getElementById("ups-m-tb-body");
    if (!body) return;
    if (sub) sub.textContent = "Step " + builderState.step + " of 4";
    if (builderState.step === 1) return renderStepCounterparty(body);
    if (builderState.step === 2) return renderStepAssets(body, "get");
    if (builderState.step === 3) return renderStepAssets(body, "give");
    return renderStepReview(body);
  }

  // ── Step 1: counterparty ──
  function renderStepCounterparty(body) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var others = (M.state.franchises || []).filter(function (f) { return f.id !== myFid; });
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">Who are you trading with?</div>' +
      '<div class="ups-m-tb-flist">' +
        others.map(function (f) {
          return '<button class="ups-m-tb-frow" data-fid="' + U.escapeHtml(f.id) + '">' +
            U.escapeHtml(f.name) + '</button>';
        }).join("") +
      '</div>';
    var rows = body.querySelectorAll(".ups-m-tb-frow");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        builderState.counterpartyFid = this.getAttribute("data-fid");
        builderState.step = 2;
        builderState.loadingInv = true;
        renderBuilder();
        Promise.all([
          loadInventoryFor(M.state.viewerFranchiseId),
          loadInventoryFor(builderState.counterpartyFid)
        ]).then(function () {
          builderState.loadingInv = false;
          renderBuilder();
        }).catch(function (e) {
          builderState.loadingInv = false;
          builderState.invError = (e && e.message) || String(e);
          renderBuilder();
        });
      });
    }
  }

  // ── Steps 2 & 3: asset picker (get = their assets, give = my assets) ──
  function renderStepAssets(body, mode) {
    var isGet = mode === "get";
    var fid = isGet ? builderState.counterpartyFid : M.state.viewerFranchiseId;
    var idMap = isGet ? builderState.getIds : builderState.giveIds;
    var capLabel = isGet ? "Cap money you receive" : "Cap money you give";
    var capVal = isGet ? builderState.theirCapK : builderState.myCapK;
    var who = franchiseName(fid);
    if (builderState.loadingInv) {
      body.innerHTML = '<div class="ups-m-loading">Loading rosters…</div>';
      return;
    }
    if (builderState.invError) {
      body.innerHTML = '<div class="ups-m-sheet-empty">Couldn\'t load assets: ' + U.escapeHtml(builderState.invError) + '</div>';
      return;
    }
    var inv = builderState.inv[U.pad4(fid)] || { players: [], future_picks: [] };
    var players = inv.players || [];
    var picks = inv.future_picks || [];
    var rowsHtml = players.map(function (p) {
      var id = "P_" + p.player_id;
      var on = !!idMap[id];
      var meta = [p.position, p.nfl_team, (U.safeInt(p.salary, 0) > 0 ? U.fmtUsd(p.salary) : null), (p.taxi ? "Taxi" : null)]
        .filter(Boolean).join(" · ");
      return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-id="' + U.escapeHtml(id) +
        '" data-name="' + U.escapeHtml(String(p.display || "").toLowerCase()) + '">' +
        '<span class="nm">' + U.escapeHtml(p.display || ("Player #" + p.player_id)) + '</span>' +
        '<span class="mt">' + U.escapeHtml(meta) + '</span></button>';
    }).join("");
    var pickHtml = picks.map(function (fp) {
      var id = futurePickToken(fp);
      var on = !!idMap[id];
      return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-id="' + U.escapeHtml(id) +
        '" data-name="pick ' + U.escapeHtml(String(fp.year)) + '">' +
        '<span class="nm">' + U.escapeHtml(fp.display || (fp.year + " R" + fp.round)) + '</span>' +
        '<span class="mt">Future pick</span></button>';
    }).join("");
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">' + (isGet ? "Select " : "Select your ") +
        U.escapeHtml(isGet ? who + "'s" : "") + ' assets <span class="cnt" id="ups-m-tb-cnt">' + countSelected(idMap) + ' selected</span></div>' +
      '<input class="ups-m-tb-search" id="ups-m-tb-search" type="search" placeholder="Search players…" autocomplete="off" />' +
      '<div class="ups-m-tb-assets">' +
        (rowsHtml || '<div class="ups-m-auc-empty">No players.</div>') +
        (pickHtml ? '<div class="ups-m-tb-subhead">Future picks</div>' + pickHtml : '') +
      '</div>' +
      '<div class="ups-m-tb-cap">' +
        '<label>' + capLabel + ' ($000s) <span class="mx" id="ups-m-tb-capmax"></span></label>' +
        '<input type="number" min="0" step="1" inputmode="numeric" id="ups-m-tb-cap" value="' + (capVal || 0) + '" />' +
        '<div class="hint" id="ups-m-tb-caphint"></div>' +
      '</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-tb-back">Back</button>' +
        '<button class="btn-act otb on" id="ups-m-tb-next">Next</button>' +
      '</div>';

    // Keep the cap-money input bounded by §A6 (50% of selected non-taxi
    // salary) and refresh the max/hint as players are toggled.
    function syncCapUi(clamp) {
      var mx = maxCapKFor(fid, idMap);
      var capInput = document.getElementById("ups-m-tb-cap");
      var maxEl = document.getElementById("ups-m-tb-capmax");
      var hintEl = document.getElementById("ups-m-tb-caphint");
      if (maxEl) maxEl.textContent = "· max $" + mx + "K";
      if (hintEl) hintEl.textContent = mx > 0
        ? "Up to 50% of the non-taxi salary you " + (isGet ? "receive" : "give") + " (§A6)."
        : "Pick a non-taxi player on this side to attach cap money (§A6).";
      if (capInput) {
        capInput.max = String(mx);
        capInput.disabled = mx <= 0;
        var cur = Math.max(0, parseInt(capInput.value, 10) || 0);
        if (cur > mx) { cur = mx; if (clamp) capInput.value = String(mx); }
        if (isGet) builderState.theirCapK = cur; else builderState.myCapK = cur;
      }
    }

    var assetBtns = body.querySelectorAll(".ups-m-tb-asset");
    for (var i = 0; i < assetBtns.length; i++) {
      assetBtns[i].addEventListener("click", function () {
        var id = this.getAttribute("data-id");
        if (idMap[id]) { delete idMap[id]; this.classList.remove("on"); }
        else { idMap[id] = true; this.classList.add("on"); }
        var cnt = document.getElementById("ups-m-tb-cnt");
        if (cnt) cnt.textContent = countSelected(idMap) + " selected";
        syncCapUi(true);
      });
    }
    var search = document.getElementById("ups-m-tb-search");
    if (search) search.addEventListener("input", function () {
      var q = this.value.toLowerCase();
      var all = body.querySelectorAll(".ups-m-tb-asset");
      for (var j = 0; j < all.length; j++) {
        var nm = all[j].getAttribute("data-name") || "";
        all[j].style.display = (!q || nm.indexOf(q) !== -1) ? "" : "none";
      }
    });
    var cap = document.getElementById("ups-m-tb-cap");
    if (cap) cap.addEventListener("input", function () {
      var mx = maxCapKFor(fid, idMap);
      var v = Math.max(0, parseInt(this.value, 10) || 0);
      if (v > mx) { v = mx; this.value = String(mx); }
      if (isGet) builderState.theirCapK = v; else builderState.myCapK = v;
    });
    syncCapUi(true);
    document.getElementById("ups-m-tb-back").addEventListener("click", function () {
      // In counter mode the counterparty is fixed (the offerer), so step 2's
      // Back closes the builder instead of returning to the counterparty picker.
      if (builderState.counterMode && isGet) { closeBuilder(); return; }
      builderState.step = isGet ? 1 : 2; renderBuilder();
    });
    document.getElementById("ups-m-tb-next").addEventListener("click", function () {
      builderState.step = isGet ? 3 : 4; renderBuilder();
    });
  }

  // ── Step 4: review + submit ──
  function renderStepReview(body) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var give = selectedAssetsFor(myFid, builderState.giveIds);
    var get = selectedAssetsFor(theirFid, builderState.getIds);
    // §A6-clamped cap values — match exactly what buildOfferPayload sends.
    var myCapK = Math.min(U.safeInt(builderState.myCapK, 0), maxCapKFor(myFid, builderState.giveIds));
    var theirCapK = Math.min(U.safeInt(builderState.theirCapK, 0), maxCapKFor(theirFid, builderState.getIds));
    // Renders one trade side's assets. Eligible outgoing PLAYER assets also show
    // the pre-trade extension control (extControlFor) — on either side.
    function colList(assets, capK) {
      var items = assets.map(function (a) {
        return '<li>' +
          U.escapeHtml(a.type === "PLAYER" ? (a.player_name || a.player_id) : (a.description || a.asset_id)) +
          (a.type === "PLAYER" && U.safeInt(a.salary, 0) > 0 ? ' <span class="sal">' + U.fmtUsd(a.salary) + '</span>' : "") +
          extControlFor(a) + '</li>';
      }).join("");
      if (capK > 0) items += '<li class="cap">+ ' + U.fmtUsd(capK * 1000) + ' cap money</li>';
      return items || '<li class="muted">—</li>';
    }
    // Pre-trade extension control — shown on ANY eligible outgoing PLAYER asset,
    // either side. Each player is extended by the franchise GIVING it up (canon
    // §C4): your give-side players by you; the partner's get-side players by them
    // as part of the deal you propose. Options come from the shared canon module;
    // the worker re-derives + re-validates on submit, so this is selection only.
    function extControlFor(a) {
      if (a.type !== "PLAYER") return "";
      var PX = window.UPS_PRETRADE_EXT;
      var opts = (PX && PX.buildSyntheticExtensionOptions(a)) || [];
      if (!opts.length) return "";
      var cur = builderState.extensions[a.asset_id];
      var curKey = (cur && cur.enabled) ? cur.option_key : "";
      function seg(key, label, sub) {
        return '<button type="button" class="ups-m-tb-extseg' + (curKey === key ? " on" : "") + '" data-asset="' + U.escapeHtml(a.asset_id) + '" data-key="' + U.escapeHtml(key) + '">' +
          '<span class="l">' + U.escapeHtml(label) + '</span>' + (sub ? '<span class="s">' + U.escapeHtml(sub) + '</span>' : "") + '</button>';
      }
      var segs = seg("", "No ext", "");
      opts.forEach(function (o) {
        segs += seg(o.option_key, (o.extension_term === "1YR" ? "+1 yr" : "+2 yr"), U.fmtUsd(o.new_aav_future) + " AAV");
      });
      var preview = "";
      if (curKey) {
        var chosen = opts.filter(function (o) { return o.option_key === curKey; })[0];
        if (chosen) preview = '<div class="ups-m-tb-extprev">→ ' + U.escapeHtml(String(chosen.preview_contract_info_string).replace(/\|\s*/g, " · ")) + '</div>';
      }
      return '<div class="ups-m-tb-extwrap"><div class="ups-m-tb-extlbl">Pre-trade extension</div>' +
        '<div class="ups-m-tb-extctl">' + segs + '</div>' + preview + '</div>';
    }
    var canSubmit = (give.length || myCapK > 0) && (get.length || theirCapK > 0);
    body.innerHTML =
      '<div class="ups-m-tb-steptitle">Review offer</div>' +
      '<div class="ups-m-tb-review">' +
        '<div class="col"><div class="lbl">You give → ' + U.escapeHtml(franchiseName(theirFid)) + '</div>' +
          '<ul>' + colList(give, myCapK) + '</ul></div>' +
        '<div class="col"><div class="lbl">You get</div>' +
          '<ul>' + colList(get, theirCapK) + '</ul></div>' +
      '</div>' +
      '<textarea class="ups-m-tb-comment" id="ups-m-tb-comment" rows="2" maxlength="2000" placeholder="Optional message to ' + U.escapeHtml(franchiseName(theirFid)) + '…">' + U.escapeHtml(builderState.comment) + '</textarea>' +
      (builderState.error ? '<div class="ups-m-rstr-err">' + U.escapeHtml(builderState.error) + '</div>' : '') +
      '<div class="ups-m-tb-warn">Submitting creates a real pending offer in MFL (' + U.escapeHtml(franchiseName(theirFid)) + ' can accept it). You can cancel it from the offers list.</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-tb-back"' + (builderState.submitting ? ' disabled' : '') + '>Back</button>' +
        '<button class="btn-act otb on" id="ups-m-tb-submit"' + (canSubmit && !builderState.submitting ? '' : ' disabled') + '>' +
          (builderState.submitting ? "Submitting…" : (builderState.counterMode ? "Send counter" : "Send offer")) + '</button>' +
      '</div>';
    var c = document.getElementById("ups-m-tb-comment");
    if (c) c.addEventListener("input", function () { builderState.comment = this.value; });
    var extSegs = body.querySelectorAll(".ups-m-tb-extseg");
    for (var ei = 0; ei < extSegs.length; ei++) {
      extSegs[ei].addEventListener("click", function () {
        var asset = this.getAttribute("data-asset");
        var key = this.getAttribute("data-key");
        if (key) builderState.extensions[asset] = { enabled: true, option_key: key };
        else delete builderState.extensions[asset];
        renderBuilder();
      });
    }
    document.getElementById("ups-m-tb-back").addEventListener("click", function () {
      if (builderState.submitting) return;
      builderState.step = 3; renderBuilder();
    });
    var submit = document.getElementById("ups-m-tb-submit");
    if (submit) submit.addEventListener("click", function () {
      if (!canSubmit || builderState.submitting) return;
      submitOffer();
    });
  }

  function buildOfferPayload() {
    var ctx = M.state.ctx;
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var giveAssets = selectedAssetsFor(myFid, builderState.giveIds);
    var getAssets = selectedAssetsFor(theirFid, builderState.getIds);
    function nonTaxi(assets) {
      return assets.reduce(function (s, a) {
        return (a.type === "PLAYER" && !a.taxi) ? s + U.safeInt(a.salary, 0) : s;
      }, 0);
    }
    // §A6 final guard — cap money never exceeds 50% of that side's traded
    // non-taxi salary, regardless of any UI state drift.
    var myCapK = Math.min(U.safeInt(builderState.myCapK, 0), maxCapKFor(myFid, builderState.giveIds));
    var theirCapK = Math.min(U.safeInt(builderState.theirCapK, 0), maxCapKFor(theirFid, builderState.getIds));
    // Pre-trade extensions (Keith 2026-06-11; two-sided 2026-06-12): an outgoing
    // player on EITHER side can be extended by the franchise giving it up (canon
    // §C4 — the desktop serializeExtensionRequests collects from both teams). For
    // each marked player, RE-DERIVE the option from the asset (never trust a
    // stale option_key) and push the exact desktop row shape. The worker
    // re-derives + re-validates salary-by-year from preview_contract_info_string.
    var extensionRequests = [];
    var PX = window.UPS_PRETRADE_EXT;
    if (PX) {
      var pushExtensions = function (assets, fromFid, toFid) {
        assets.forEach(function (a) {
          if (a.type !== "PLAYER") return;
          var sel = builderState.extensions[a.asset_id];
          if (!sel || !sel.enabled) return;
          var opts = PX.buildSyntheticExtensionOptions(a) || [];
          var opt = opts.filter(function (o) { return o.option_key === sel.option_key; })[0];
          if (!opt) return;
          extensionRequests.push({
            player_id: a.player_id, player_name: a.player_name,
            from_franchise_id: fromFid, to_franchise_id: toFid,
            applies_to_acquirer: true,
            option_key: opt.option_key, extension_term: opt.extension_term,
            loaded_indicator: opt.loaded_indicator, preview_id: opt.preview_id,
            preview_contract_info_string: opt.preview_contract_info_string,
            new_contract_status: opt.new_contract_status,
            new_contract_length: opt.new_contract_length,
            new_TCV: opt.new_TCV,
            new_aav_future: opt.new_aav_future
          });
        });
      };
      // Give-side players are extended by you; get-side by the partner.
      pushExtensions(giveAssets, myFid, theirFid);
      pushExtensions(getAssets, theirFid, myFid);
    }
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source: "ups-mobile-trade-builder",
      league_id: ctx.leagueId,
      season: ctx.year,
      teams: [
        {
          role: "left", franchise_id: myFid, franchise_name: franchiseName(myFid),
          selected_assets: giveAssets,
          traded_salary_adjustment_dollars: myCapK * 1000,
          traded_salary_adjustment_k: myCapK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: nonTaxi(giveAssets)
        },
        {
          role: "right", franchise_id: theirFid, franchise_name: franchiseName(theirFid),
          selected_assets: getAssets,
          traded_salary_adjustment_dollars: theirCapK * 1000,
          traded_salary_adjustment_k: theirCapK,
          traded_salary_adjustment_max_k: 999,
          selected_non_taxi_salary_dollars: nonTaxi(getAssets)
        }
      ],
      extension_requests: extensionRequests,
      filters: { search: "" },
      ui: { left_team_id: myFid, right_team_id: theirFid }
    };
  }

  // The INITIATOR's own overage, shown at offer CREATION: the worker refuses to create the
  // offer (409 cap_overage_ack_required) until the sender explicitly acknowledges the exact
  // projected figure. `errData` is that refusal's body ({error, cap_ack_needed:{amount_over,
  // cap_dollars, projected_used, signature}}). Resolves true only when the owner confirms; the
  // caller then retries with { cap_ack: { signature } } attached.
  function openCreateCapAckSheet(errData) {
    var need = (errData && errData.cap_ack_needed) || {};
    var money = T && T.money ? T.money : function (n) { return "$" + Math.round(Number(n) || 0).toLocaleString("en-US"); };
    var existing = document.getElementById("ups-m-capack-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-capack-overlay">' +
        '<div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-capack-close" aria-label="Close">\u00d7</button>' +
            '<div class="grip"></div>' +
            '<div class="title">Over the salary cap</div>' +
            '<div class="sub">' + U.escapeHtml(errData && errData.error) + '</div>' +
          '</div>' +
          '<div class="ups-m-drop-body">' +
            '<p style="font-weight:700;font-size:16px;margin:0 0 8px">' + U.escapeHtml(money(need.amount_over)) + ' over the ' + U.escapeHtml(money(need.cap_dollars)) + ' salary cap</p>' +
            '<p style="color:var(--fg-muted,#8a97ad);font-size:13px;margin:0 0 12px">This doesn\'t block the trade \u2014 MFL will still process it \u2014 but you\'re acknowledging you\'ll be over before it\'s sent.</p>' +
            '<div class="ups-m-tb-nav">' +
              '<button class="btn-act" id="ups-m-capack-cancel">Cancel</button>' +
              '<button class="btn-act otb on" id="ups-m-capack-go">Acknowledge and send</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return Promise.resolve(false);
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    return new Promise(function (resolve) {
      var settled = false;
      function close(v) {
        if (settled) return; settled = true;
        var ov = document.getElementById("ups-m-capack-overlay");
        if (ov) ov.remove();
        document.body.style.overflow = "";
        resolve(v);
      }
      document.getElementById("ups-m-capack-close").addEventListener("click", function () { close(false); });
      document.getElementById("ups-m-capack-cancel").addEventListener("click", function () { close(false); });
      document.getElementById("ups-m-capack-go").addEventListener("click", function () { close(true); });
    });
  }

  // The loaded-contract HARD BLOCK, shown at offer CREATE/COUNTER (Keith's ruling, 2026-10-01,
  // REPLACING the conditional-drop-picker flow of 2026-09-29/30 -- mirrors desktop's
  // showLoadedContractBlock exactly). `errData` is the 409 refusal's body ({error, message,
  // teams: [{franchise_id, franchise_name, projected, max}]}). A plain, honest notice -- team(s),
  // projected count, limit -- with only a Close button. No picker, no selection, no retry: the
  // caller always treats this as a refusal and must revise the offer or make a separate roster
  // move before trying again.
  function showLoadedContractBlockSheet(errData) {
    var mount = document.getElementById("ups-m-app");
    if (!mount) return Promise.resolve();
    var existing = document.getElementById("ups-m-drops-overlay");
    if (existing) existing.remove();
    var teams = (errData && errData.teams) || [];
    var rows = teams.map(function (t) {
      return '<li><span class="t3w-cr-name">' + U.escapeHtml(t.franchise_name || t.franchise_id) + '</span>' +
        '<span class="t3w-cr-flag">' + U.escapeHtml(t.projected) + ' of ' + U.escapeHtml(t.max) + ' max</span></li>';
    }).join("");
    return new Promise(function (resolve) {
      var settled = false;
      function close() {
        if (settled) return; settled = true;
        var ov = document.getElementById("ups-m-drops-overlay");
        if (ov) ov.remove();
        document.body.style.overflow = "";
        resolve();
      }
      var html =
        '<div class="ups-m-drop-overlay" id="ups-m-drops-overlay">' +
          '<div class="ups-m-drop-sheet">' +
            '<div class="ups-m-drop-head">' +
              '<button class="ups-m-drop-close" id="ups-m-drops-close" aria-label="Close">×</button>' +
              '<div class="grip"></div>' +
              '<div class="title">Loaded-contract limit</div>' +
            '</div>' +
            '<div class="ups-m-drop-body">' +
              '<p class="sub">' + U.escapeHtml((errData && (errData.message || errData.error)) || "This trade would leave a team over the loaded-contract limit.") + '</p>' +
              (rows ? '<ul class="t3w-crows" aria-label="Teams over the loaded-contract limit">' + rows + '</ul>' : '') +
              '<p class="sub">Revise the offer, or make a separate roster move first, then try again.</p>' +
              '<div class="ups-m-tb-nav"><button class="btn-act otb on" id="ups-m-drops-close-ok">Close</button></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      mount.insertAdjacentHTML("beforeend", html);
      document.body.style.overflow = "hidden";
      document.getElementById("ups-m-drops-close").addEventListener("click", close);
      document.getElementById("ups-m-drops-close-ok").addEventListener("click", close);
    });
  }

  // Attempts a trade-offer CREATE, showing the loaded-contract hard block and/or resolving the
  // cap-overage-acknowledgment gate in whichever order the worker raises them. Returns the FINAL
  // {ok, status, body} response, or null if the owner cancelled a dialog (matching the existing
  // "the owner declined to acknowledge" no-op convention in submitOffer's .then chain).
  function submitTradeCreateWithGatesMobile(url, initialBody, fromFranchiseId, attempt) {
    attempt = attempt || 1;
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialBody)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    }).then(function (resp) {
      if (attempt > 5) return resp;
      // RULING (Keith, 2026-10-01): a hard block, never an in-trade fix -- show it, then always
      // return the refusal unchanged so submitOffer's existing "offer wasn't sent" handling
      // takes over. Mirrors desktop's submitTradeCreateWithGates exactly.
      if (resp.status === 409 && resp.body && resp.body.code === "loaded_contract_limit_exceeded") {
        return showLoadedContractBlockSheet(resp.body).then(function () { return resp; });
      }
      if (resp.status === 409 && resp.body && resp.body.code === "cap_overage_ack_required" && resp.body.cap_ack_needed) {
        return openCreateCapAckSheet(resp.body).then(function (acknowledged) {
          if (!acknowledged) return null;
          var nextBody = Object.assign({}, initialBody, { cap_ack: { signature: resp.body.cap_ack_needed.signature } });
          return submitTradeCreateWithGatesMobile(url, nextBody, fromFranchiseId, attempt + 1);
        });
      }
      // ---- 🔒 CUTOVER (2026-09-29): the legacy endpoint refused to CREATE ----
      // Keith's ruling: the NORMAL Send button must itself stage once cutover is on, with the
      // compliance popup shown as part of THIS SAME flow. submitOffer() calls this same
      // function unchanged, so a stale/cached client ends up staged automatically the moment
      // the server says so -- never a silent native-MFL send.
      if (resp.status === 409 && resp.body && resp.body.code === "staging_required") {
        return submitViaStagingFallbackMobile(initialBody, fromFranchiseId);
      }
      return resp;
    });
  }

  // The SAME payload the direct-MFL create already built (initialBody.payload), staged
  // instead -- runs the SAME pre-send popup (runPreSendPreview) the dedicated "Stage via War
  // Room" button uses. Resolves { ok:true, status:201, body:{ok:true, staged:true, id} } on
  // success (submitOffer's .then must check body.staged before reading any direct-MFL-only
  // field), { ok:true, status:0, body:{ok:false, code:"staging_declined_by_owner"} } if the
  // owner chose "Don't send" on the popup (not a network/server failure -- a deliberate,
  // calm no-op), or a normal failed-response shape otherwise. Never throws (matches every
  // other branch of this function).
  function submitViaStagingFallbackMobile(directBody, fromFranchiseId) {
    var payload = directBody.payload || {};
    var movements = tw2sMovementsFromPayload(payload);
    if (!movements.length) return Promise.resolve({ ok: false, status: 400, body: { ok: false, code: "no_assets", error: "Add at least one asset to stage." } });
    var toFid = U.pad4(directBody.to_franchise_id);
    return runPreSendPreview(fromFranchiseId, movements, payload.extension_requests).then(function (pre) {
      if (!pre.proceed) return { ok: true, status: 0, body: { ok: false, code: "staging_declined_by_owner" } };
      var url2 = M.api.workerUrl("/api/trades/2way?L=" + encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" + encodeURIComponent(M.state.ctx.year));
      var stored2 = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
      if (stored2) url2 += "&MFL_USER_ID=" + encodeURIComponent(stored2);
      var body2 = {
        from: { fid: fromFranchiseId, name: directBody.from_franchise_name },
        to: { fid: toFid, name: directBody.to_franchise_name },
        movements: movements, extension_requests: payload.extension_requests || [],
        loaded_contract_drops: pre.drops, notes: directBody.message || ""
      };
      return tw2sFetch(url2, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body2) }).then(function (res) {
        if (res && res.networkError) return { ok: false, status: 0, body: { ok: false, error: "Couldn't reach the server." } };
        if (res.ok && res.body && res.body.ok) return { ok: true, status: res.status, body: { ok: true, staged: true, id: res.body.id } };
        return { ok: false, status: res.status, body: res.body || { ok: false, error: "Couldn't stage this offer." } };
      });
    });
  }

  // ---- 🔒 CUTOVER (2026-09-29) for COUNTER ----
  // Keith's ruling (2026-09-30): "A bare 409 is not an acceptable release experience" -- the
  // counter path must give the owner a clear route to revise and submit a staged offer, same
  // as Send already does. Staging has no "counter" primitive (TWO_WAY_STAGED_ROUTES is only
  // create/accept/cancel/recheck/select-drops/queue/execute) -- a legacy COUNTER means "reject
  // the original AND propose a new one" as ONE atomic native-MFL action, and staging cannot
  // replicate that atomically. The honest thing this fallback does, without taking an action
  // the owner never asked for, is exactly what desktop's own counter UI already does today
  // (trade_workbench.js's submitOfferToQueue reuses the plain CREATE path regardless of
  // counterMode, so it inherits this same behavior by construction): stage the REVISED terms
  // as a brand-new offer, and say PLAINLY that the original offer is untouched -- never
  // silently decline it as a side effect of what the owner thought was "submit my counter."
  function submitTradeCounterWithGatesMobile(url, initialBody, fromFranchiseId) {
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initialBody)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    }).then(function (resp) {
      // RULING (Keith, 2026-10-01): COUNTER is now gated identically to CREATE (it previously
      // had no loaded-contract check at all) -- same 409 shape, same hard-block treatment.
      if (resp.status === 409 && resp.body && resp.body.code === "loaded_contract_limit_exceeded") {
        return showLoadedContractBlockSheet(resp.body).then(function () { return resp; });
      }
      if (resp.status === 409 && resp.body && resp.body.code === "staging_required") {
        return submitCounterViaStagingFallbackMobile(initialBody, fromFranchiseId);
      }
      return resp;
    });
  }

  // The counter's revised terms, staged as a brand-new offer -- reuses the SAME staged-create
  // mechanism submitViaStagingFallbackMobile uses for CREATE (including the real pre-send
  // loaded-contract popup via runPreSendPreview), just reading the counter's own payload shape
  // (initialBody.counter_offer.*) instead of the plain-create body's. Never touches the
  // original offer being countered. Resolves { ok:true, status:201, body:{ok:true, staged:true,
  // id, counter_staged:true} } on success (submitOffer's .then must check body.staged before
  // reading any direct-MFL-only field, exactly like the CREATE fallback), { ok:true, status:0,
  // body:{ok:false, code:"staging_declined_by_owner"} } if the owner chose "Don't send" on the
  // pre-send popup, or a normal failed-response shape otherwise.
  function submitCounterViaStagingFallbackMobile(counterBody, fromFranchiseId) {
    var counter = (counterBody && counterBody.counter_offer) || {};
    var payload = counter.payload || {};
    var movements = tw2sMovementsFromPayload(payload);
    if (!movements.length) return Promise.resolve({ ok: false, status: 400, body: { ok: false, code: "no_assets", error: "Add at least one asset to stage." } });
    var toFid = U.pad4(counter.to_franchise_id);
    return runPreSendPreview(fromFranchiseId, movements, payload.extension_requests).then(function (pre) {
      if (!pre.proceed) return { ok: true, status: 0, body: { ok: false, code: "staging_declined_by_owner" } };
      var url2 = M.api.workerUrl("/api/trades/2way?L=" + encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" + encodeURIComponent(M.state.ctx.year));
      var stored2 = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
      if (stored2) url2 += "&MFL_USER_ID=" + encodeURIComponent(stored2);
      var body2 = {
        from: { fid: fromFranchiseId, name: franchiseName(fromFranchiseId) },
        to: { fid: toFid, name: franchiseName(toFid) },
        movements: movements, extension_requests: payload.extension_requests || [],
        loaded_contract_drops: pre.drops, notes: counterBody.message || ""
      };
      return tw2sFetch(url2, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body2) }).then(function (res) {
        if (res && res.networkError) return { ok: false, status: 0, body: { ok: false, error: "Couldn't reach the server." } };
        if (res.ok && res.body && res.body.ok) return { ok: true, status: res.status, body: { ok: true, staged: true, id: res.body.id, counter_staged: true } };
        return { ok: false, status: res.status, body: res.body || { ok: false, error: "Couldn't stage this offer." } };
      });
    });
  }

  function submitOffer() {
    builderState.submitting = true; builderState.error = ""; renderBuilder();
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var payload = buildOfferPayload();
    var url, body;
    if (builderState.counterMode) {
      // COUNTER: the worker rejects the original offer + sends this new
      // proposal back to the offerer (worker /action COUNTER).
      url = M.api.workerUrl("/api/trades/proposals/action");
      body = {
        action: "COUNTER",
        trade_id: builderState.counterTradeId,
        league_id: M.state.ctx.leagueId,
        season: M.state.ctx.year,
        year: M.state.ctx.year,
        franchise_id: myFid,
        message: builderState.comment || "",
        counter_offer: {
          from_franchise_id: myFid,
          to_franchise_id: theirFid,
          payload: payload,
          message: builderState.comment || ""
        }
      };
    } else {
      url = M.api.workerUrl("/api/trades/proposals?L=" +
        encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" + encodeURIComponent(M.state.ctx.year));
      body = {
        league_id: M.state.ctx.leagueId,
        season: M.state.ctx.year,
        from_franchise_id: myFid,
        to_franchise_id: theirFid,
        from_franchise_name: franchiseName(myFid),
        to_franchise_name: franchiseName(theirFid),
        message: builderState.comment || "",
        payload: payload
      };
    }
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += (url.indexOf("?") >= 0 ? "&" : "?") + "MFL_USER_ID=" + encodeURIComponent(stored);
    // COUNTER goes through a different worker route/response shape that doesn't implement the
    // create-time loaded-contract or cap gates (those are re-checked at accept regardless) --
    // exactly the same scope this cap-ack gate already had before this change (`!counterMode`).
    // It DOES need the cutover staging_required fallback though (submitTradeCounterWithGatesMobile),
    // same as CREATE -- a bare 409 here would be a dead end once cutover is on.
    var submitPromise = builderState.counterMode
      ? submitTradeCounterWithGatesMobile(url, body, myFid)
      : submitTradeCreateWithGatesMobile(url, body, myFid);
    submitPromise.then(function (resp) {
      if (!resp) { builderState.submitting = false; renderBuilder(); return; }   // the owner declined to acknowledge/select -- already repainted above
      builderState.submitting = false;
      if (resp.body && resp.body.code === "staging_declined_by_owner") {
        // A deliberate "Don't send" on the cutover-fallback popup -- calm, not an error.
        builderState.error = "";
        M.ui.showToast("Not sent.", "info");
        renderBuilder();
        return;
      }
      if (resp.ok && resp.body && resp.body.ok !== false && resp.body.staged) {
        M.ui.showToast(resp.body.counter_staged
          ? "Staged as a new offer — awaiting review. The original offer was NOT declined; decline it separately if you want it gone."
          : "Staged — awaiting review. Held server-side; not sent to MFL. ✓", "ok");
        closeBuilder();
        refreshStaged2WayList().then(function () { M.route.renderRoute(); });
        return;
      }
      if (resp.ok && resp.body && resp.body.ok !== false) {
        M.ui.showToast(builderState.counterMode ? "Counter sent ✓" : "Offer sent ✓", "ok");
        closeBuilder();
        state.offers = null;
        if (M.actions && M.actions.reloadData) {
          return M.actions.reloadData().then(function () { M.route.renderRoute(); });
        }
        return loadOffers().then(function () { M.route.renderRoute(); });
      }
      builderState.error = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
      renderBuilder();
    }).catch(function (err) {
      builderState.submitting = false;
      builderState.error = (err && err.message) || String(err);
      renderBuilder();
    });
  }

  // Map the mobile UI verb to MFL's direct-mode verb. The worker's action
  // route accepts only ACCEPT / REJECT / REVOKE / COUNTER (index.js:25916),
  // so "decline" (an incoming offer) → reject, and "cancel" (your own
  // outgoing offer) → revoke. "accept" passes through.
  function mflActionVerb(action) {
    if (action === "decline") return "reject";
    if (action === "cancel") return "revoke";
    return action;
  }

  function postTradeAction(action, tradeId, message) {
    // Forward the viewer's MFL_USER_ID — the action route writes to MFL as the
    // acting franchise and rejects with "Missing MFL owner session" without it
    // (worker viewerCookieHeader gate). Same query-param pattern as the builder.
    var url = M.api.workerUrl("/api/trades/proposals/action");
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "?MFL_USER_ID=" + encodeURIComponent(stored);
    return fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: mflActionVerb(action),
        trade_id: tradeId,
        league_id: M.state.ctx.leagueId,
        franchise_id: M.state.viewerFranchiseId,
        year: M.state.ctx.year,
        // Decline note → worker forwards body.message to MFL's tradeResponse
        // COMMENTS (index.js:25711). Harmless empty string for accept/cancel.
        message: U.safeStr(message)
      })
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    });
  }

  // Fire a trade action + toast + full reload. Shared by accept/cancel
  // (window.confirm) and decline (reason sheet). `message` is the optional
  // decline note; ignored by the worker for accept/cancel.
  function runTradeAction(action, tradeId, message) {
    M.ui.showToast(action[0].toUpperCase() + action.slice(1) + "ing…", "info");
    return postTradeAction(action, tradeId, message).then(function (resp) {
      // ONE reading of what actually happened (never a bare "Done"): executed / executed-but-needs-review / unconfirmed / not accepted.
      var out = T && T.interpretAction ? T.interpretAction(action, resp) : null;
      if (out && (out.kind === "executed_needs_review" || out.kind === "unconfirmed")) {
        M.ui.showToast(out.message, "warn");
        state.offers = null;
        return loadOffers().then(function () { M.route.renderRoute(); });
      }
      if (resp.ok) {
        M.ui.showToast(out && out.kind === "already" ? out.message : "Done ✓", "ok");
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

  // Decline → a small sheet so the owner can attach an optional note that
  // lands in MFL's native trade history (and, later, the offerer's DM).
  function openDeclineSheet(tradeId) {
    var existing = document.getElementById("ups-m-decline-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-decline-overlay">' +
        '<div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-decline-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">Decline offer</div>' +
            '<div class="sub">Add an optional note for the other owner.</div>' +
          '</div>' +
          '<div class="ups-m-drop-body">' +
            '<textarea class="ups-m-tb-comment" id="ups-m-decline-reason" rows="3" maxlength="2000" ' +
              'placeholder="Reason (optional) — e.g. too rich for me, but keep \'em coming."></textarea>' +
            '<div class="ups-m-tb-nav">' +
              '<button class="btn-act" id="ups-m-decline-cancel">Cancel</button>' +
              '<button class="btn-act otb on" id="ups-m-decline-go">Decline trade</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    function close() {
      var ov = document.getElementById("ups-m-decline-overlay");
      if (ov) ov.remove();
      document.body.style.overflow = "";
    }
    document.getElementById("ups-m-decline-close").addEventListener("click", close);
    document.getElementById("ups-m-decline-cancel").addEventListener("click", close);
    document.getElementById("ups-m-decline-go").addEventListener("click", function () {
      var el = document.getElementById("ups-m-decline-reason");
      var reason = el ? U.safeStr(el.value) : "";
      close();
      runTradeAction("decline", tradeId, reason);
    });
  }

  // Accept = a REVIEW first. The worker recomputes the post-trade salary cap (a hard rule: a trade that would put
  // any team over the cap can't be accepted) and the roster counts (advisory) from live MFL data and returns them
  // (POST …/proposals/action, action "preview" — read-only). Nothing is computed here; the sheet only presents it.
  // The Accept button exists ONLY when the server says the cap is fine, and the accept is re-checked server-side.
  function previewAccept(tradeId) {
    return postTradeAction("preview", tradeId, "").then(function (resp) {
      return T.interpretPreview({ ok: resp.ok, status: resp.status, body: resp.body });
    }).catch(function () { return T.interpretPreview({ networkError: true }); });
  }
  // The caller's own overage acknowledgment (Keith's ruling, 2026-09-28): never writes to MFL,
  // never itself accepts anything — it just records that this owner has seen the exact projected
  // figure. Mirrors previewAccept's shape.
  function ackCapAccept(tradeId) {
    return postTradeAction("ack_cap", tradeId, "").then(function (resp) {
      return T.interpretAckCap({ ok: resp.ok, status: resp.status, body: resp.body });
    }).catch(function () { return T.interpretAckCap({ networkError: true }); });
  }
  function openAcceptReview(tradeId) {
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    var old = document.getElementById("ups-m-accept-overlay");
    if (old) old.remove();
    T.ensureStyles();
    mount.insertAdjacentHTML("beforeend",
      '<div class="ups-m-drop-overlay" id="ups-m-accept-overlay"><div class="ups-m-drop-sheet" role="dialog" aria-modal="true" aria-label="Review before accepting">' +
        '<div class="ups-m-drop-head"><button class="ups-m-drop-close" data-t3w-act="accept-close" aria-label="Close">×</button>' +
          '<div class="title">Accept this trade?</div><div class="sub">Checked against the salary cap right now. Accepting writes to MFL.</div></div>' +
        '<div class="ups-m-drop-body" id="ups-m-accept-body" style="padding:12px 14px"></div></div></div>');
    document.body.style.overflow = "hidden";
    var body = document.getElementById("ups-m-accept-body");
    var overlay = document.getElementById("ups-m-accept-overlay");
    var ack = { busy: false, message: "", ok: false };
    function close() { var ov = document.getElementById("ups-m-accept-overlay"); if (ov) ov.remove(); document.body.style.overflow = ""; }
    function paint(review, busy) {
      body.innerHTML = T.renderAcceptReview(review, { busy: busy, viewerFid: M.state.viewerFranchiseId, ackBusy: ack.busy, ackMessage: ack.message, ackOk: ack.ok });
    }
    var lastReview = null;
    function load() {
      paint(null);
      previewAccept(tradeId).then(function (review) { lastReview = review; if (document.getElementById("ups-m-accept-overlay") === overlay) paint(review); });
    }
    function acknowledgeCap() {
      if (ack.busy) return;
      ack.busy = true; ack.message = ""; paint(lastReview, false);
      ackCapAccept(tradeId).then(function (out) {
        ack.busy = false; ack.message = out.message; ack.ok = !!out.ok;
        load();
      });
    }
    T.bind(overlay, {
      "accept-close": close,
      "accept-retry": load,
      "accept-confirm": function () { close(); runTradeAction("accept", tradeId, ""); },
      "ack-cap": acknowledgeCap
    });
    load();
  }

  function handleAction(action, tradeId) {
    if (action === "decline") { openDeclineSheet(tradeId); return; }
    if (action === "accept") { openAcceptReview(tradeId); return; }
    if (!window.confirm("Cancel this outgoing offer?")) return;
    runTradeAction(action, tradeId, "");
  }

  // ════════════════════════════ 3-WAY TRADE BUILDER ═══════════════════════════
  // Three teams — You (A) + two partners (B, C). Free-form: any team can send any
  // asset to either of the other two (movements). MFL only does 2-party trades,
  // so the worker (worker/src/trade_3way.js) decomposes the movements into chained
  // commish trades (2-trade hub for a clean cycle, else pairwise) once BOTH
  // partners accept their Discord DM. This builder composes the movements + an
  // optional note and POSTs to /api/trades/3way. Players, future picks, and cap
  // money (BlindBid$, §A6-clamped per movement) are supported; the engine injects
  // a BB_ token on the giving side so each leg carries the cap to MFL.
  var b3 = null;
  function fresh3() {
    return {
      step: 1,              // 1 pick B · 2 pick C · 3 assets · 4 review
      fidB: "", fidC: "",
      inv: {}, loadingInv: false, invError: "",
      // give[giverFid] = { [assetToken]: destFid } — each selected asset points
      // at the team that receives it (defaults to the ring-next team). Free-form:
      // any of the 3 teams can send any asset to either of the other two.
      give: {},
      // ext[giverFid] = { [assetToken]: { enabled, option_key } } — pre-trade
      // extension chosen for a give-side player (extended by the giver for the
      // acquirer it's routed to). Mirrors the 2-party builder's extensions map.
      ext: {},
      // cap[giverFid] = { [destFid]: capK } — cap money (BlindBid$) the giver
      // sends to that destination, clamped to §A6 (≤50% of non-taxi salary sent).
      cap: {},
      notes: "",
      submitting: false, error: ""
    };
  }
  // Inventory loader for the ring — caches into b3.inv (reuses the 2-party
  // inventoryUrl, which is builder-state independent).
  function load3InvFor(fid) {
    var key = U.pad4(fid);
    if (b3.inv[key]) return Promise.resolve(b3.inv[key]);
    return fetch(inventoryUrl(key), { mode: "cors", credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var inv = { players: (data && data.players) || [], future_picks: (data && data.future_picks) || [] };
        b3.inv[key] = inv; return inv;
      });
  }
  // The three franchises in ring order: You (A), then B, then C.
  function teamFids() {
    return [U.pad4(M.state.viewerFranchiseId), U.pad4(b3.fidB), U.pad4(b3.fidC)];
  }
  // Default destination for an asset from `giverFid`: the next team in the ring
  // (You→B, B→C, C→You). The user can re-point it to the third team.
  function ringNext(giverFid) {
    var t = teamFids(); var i = t.indexOf(U.pad4(giverFid));
    return i === -1 ? t[0] : t[(i + 1) % 3];
  }
  function otherTwo(fid) {
    return teamFids().filter(function (x) { return x !== U.pad4(fid); });
  }
  // Display name for a selected asset token, from the giver's loaded inventory.
  // The selected tokens ARE the MFL-ready ids (P_<id> / FP_<orig>_<yr>_<rd>) —
  // the engine's toMflAsset normalizes them server-side.
  function assetDisplay(giverFid, token) {
    var inv = b3.inv[U.pad4(giverFid)] || { players: [], future_picks: [] };
    if (token.indexOf("P_") === 0) {
      var pid = token.slice(2);
      var p = (inv.players || []).filter(function (x) { return String(x.player_id) === pid; })[0];
      return p ? (p.display || ("Player #" + pid)) : token;
    }
    var fp = (inv.future_picks || []).filter(function (x) { return futurePickToken(x) === token; })[0];
    return fp ? (fp.display || (fp.year + " R" + fp.round)) : token;
  }
  // §A6 — cap money a giver may send to a destination ≤ floor(sum of the NON-TAXI
  // player salary it routes there / 2000) in $K. Picks + taxi don't unlock cap.
  // Mirrors maxCapKFor (the 2-party version) but scoped to one movement's players.
  function movementMaxCapK(giver, dest) {
    giver = U.pad4(giver); dest = U.pad4(dest);
    var map = b3.give[giver] || {};
    var inv = b3.inv[giver] || { players: [] };
    var sum = 0;
    (inv.players || []).forEach(function (p) {
      if (U.pad4(map["P_" + p.player_id]) === dest && !p.taxi) sum += U.safeInt(p.salary, 0);
    });
    return Math.floor(sum / 2000);
  }
  // The §A6-clamped cap the giver actually sends to dest (re-clamps when players change).
  function cap3KFor(giver, dest) {
    var raw = U.safeInt((b3.cap[U.pad4(giver)] || {})[U.pad4(dest)], 0);
    return Math.max(0, Math.min(raw, movementMaxCapK(giver, dest)));
  }

  // Build movements from state: for each giver, group its selected assets by
  // destination → one movement {from, to, asset_tokens, cap_k, summary} per pair.
  function movementsFromState() {
    var out = [];
    teamFids().forEach(function (giver) {
      var map = b3.give[giver] || {};
      var byDest = {};
      Object.keys(map).forEach(function (token) {
        var dest = U.pad4(map[token]);
        if (!dest || dest === giver) return;
        (byDest[dest] = byDest[dest] || []).push(token);
      });
      Object.keys(byDest).forEach(function (dest) {
        var tokens = byDest[dest];
        var names = tokens.map(function (t) { return assetDisplay(giver, t); });
        out.push({ from: giver, to: dest, asset_tokens: tokens, cap_k: cap3KFor(giver, dest), summary: names.join(", "), _names: names });
      });
    });
    return out;
  }
  function countGiven() {
    var n = 0; teamFids().forEach(function (f) { n += Object.keys(b3.give[f] || {}).length; }); return n;
  }

  function open3WayBuilder() {
    if (!M.state.viewerFranchiseId) { M.ui.showToast("Pick your franchise first.", "err"); return; }
    b3 = fresh3();
    var existing = document.getElementById("ups-m-3w-overlay");
    if (existing) existing.remove();
    var html =
      '<div class="ups-m-drop-overlay" id="ups-m-3w-overlay">' +
        '<div class="ups-m-drop-sheet ups-m-tb-sheet">' +
          '<div class="ups-m-drop-head">' +
            '<button class="ups-m-drop-close" id="ups-m-3w-close" aria-label="Close">×</button>' +
            '<div class="grip"></div>' +
            '<div class="title">3-Way Trade</div>' +
            '<div class="sub" id="ups-m-3w-stepsub"></div>' +
          '</div>' +
          '<div class="ups-m-drop-body" id="ups-m-3w-body"></div>' +
        '</div>' +
      '</div>';
    var mount = document.getElementById("ups-m-app");
    if (!mount) return;
    mount.insertAdjacentHTML("beforeend", html);
    document.body.style.overflow = "hidden";
    document.getElementById("ups-m-3w-close").addEventListener("click", close3Way);
    render3();
  }
  function close3Way() {
    var ov = document.getElementById("ups-m-3w-overlay");
    if (ov) ov.remove();
    document.body.style.overflow = "";
    b3 = null;
  }
  function ringLine() {
    var A = franchiseName(M.state.viewerFranchiseId);
    var B = b3.fidB ? franchiseName(b3.fidB) : "Partner 1";
    var C = b3.fidC ? franchiseName(b3.fidC) : "Partner 2";
    return '<div class="ups-m-3w-ring">' +
      '<span class="tag">3-way</span>' +
      '<span class="you">' + U.escapeHtml(A) + '</span><span class="arr">·</span>' +
      '<span>' + U.escapeHtml(B) + '</span><span class="arr">·</span>' +
      '<span>' + U.escapeHtml(C) + '</span>' +
    '</div>';
  }
  function render3() {
    var sub = document.getElementById("ups-m-3w-stepsub");
    var body = document.getElementById("ups-m-3w-body");
    if (!body) return;
    if (sub) sub.textContent = "Step " + b3.step + " of 4";
    if (b3.step === 1) return render3PickPartner(body, "B");
    if (b3.step === 2) return render3PickPartner(body, "C");
    if (b3.step === 3) return render3Assets(body);
    return render3Review(body);
  }

  // ── Steps 1 & 2: pick the two trade partners ──
  function render3PickPartner(body, slot) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var taken = slot === "C" ? [myFid, U.pad4(b3.fidB)] : [myFid];
    var others = (M.state.franchises || []).filter(function (f) { return taken.indexOf(f.id) === -1; });
    var prompt = slot === "B" ? "Pick Partner 1" : "Pick Partner 2";
    body.innerHTML =
      ringLine() +
      '<div class="ups-m-tb-steptitle">' + prompt + '</div>' +
      '<div class="ups-m-tb-flist">' +
        others.map(function (f) {
          return '<button class="ups-m-tb-frow" data-fid="' + U.escapeHtml(f.id) + '">' + U.escapeHtml(f.name) + '</button>';
        }).join("") +
      '</div>' +
      (slot === "C" ? '<div class="ups-m-tb-nav"><button class="btn-act" id="ups-m-3w-back">Back</button><span></span></div>' : '');
    var rows = body.querySelectorAll(".ups-m-tb-frow");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var fid = this.getAttribute("data-fid");
        if (slot === "B") { b3.fidB = fid; b3.step = 2; render3(); return; }
        b3.fidC = fid; b3.step = 3; b3.loadingInv = true; render3();
        Promise.all([
          load3InvFor(M.state.viewerFranchiseId),
          load3InvFor(b3.fidB),
          load3InvFor(b3.fidC)
        ]).then(function () { b3.loadingInv = false; render3(); })
          .catch(function (e) { b3.loadingInv = false; b3.invError = (e && e.message) || String(e); render3(); });
      });
    }
    var back = document.getElementById("ups-m-3w-back");
    if (back) back.addEventListener("click", function () { b3.step = 1; render3(); });
  }

  // ── Step 3: pick each team's assets + where each one goes (free-form) ──
  // One section per team's roster. Selecting an asset opens a destination
  // chooser (the other two teams), defaulting to the ring-next team. Toggles
  // update in place so the (long) combined roster doesn't scroll-jump.
  function destChooserHtml(giver, token) {
    var cur = U.pad4((b3.give[giver] || {})[token]);
    var pills = otherTwo(giver).map(function (d) {
      return '<button type="button" class="ups-m-3w-dest' + (cur === d ? ' on' : '') + '" data-giver="' + giver +
        '" data-token="' + U.escapeHtml(token) + '" data-dest="' + d + '">' + U.escapeHtml(franchiseName(d)) + '</button>';
    }).join("");
    return '<div class="ups-m-3w-destrow"><span class="to">to</span>' + pills + '</div>';
  }
  function onDestPillClick() {
    var giver = this.getAttribute("data-giver"), token = this.getAttribute("data-token"), dest = this.getAttribute("data-dest");
    b3.give[giver] = b3.give[giver] || {}; b3.give[giver][token] = dest;
    var sibs = this.parentNode.querySelectorAll(".ups-m-3w-dest");
    for (var m = 0; m < sibs.length; m++) sibs[m].classList.toggle("on", sibs[m] === this);
  }
  function wireDestPills(scope) {
    var pills = scope.querySelectorAll(".ups-m-3w-dest");
    for (var k = 0; k < pills.length; k++) pills[k].addEventListener("click", onDestPillClick);
  }
  // Look up the inventory player object for a P_<id> token under a giver.
  function playerForToken(giver, token) {
    if (String(token).indexOf("P_") !== 0) return null;
    var pid = String(token).slice(2);
    var inv = b3.inv[U.pad4(giver)] || { players: [] };
    return (inv.players || []).filter(function (x) { return String(x.player_id) === pid; })[0] || null;
  }
  // Pre-trade extension control for a selected give-side PLAYER. Reuses the
  // shared canon module (UPS_PRETRADE_EXT) + the 2-party builder's ext CSS.
  function ext3ControlHtml(giver, token, p) {
    var PX = window.UPS_PRETRADE_EXT;
    if (!PX || !p) return "";
    var asset = playerToSelectedAsset(p);
    var opts = PX.buildSyntheticExtensionOptions(asset) || [];
    if (!opts.length) return "";
    var cur = (b3.ext[giver] || {})[token];
    var curKey = (cur && cur.enabled) ? cur.option_key : "";
    function seg(key, label, sub) {
      return '<button type="button" class="ups-m-tb-extseg' + (curKey === key ? " on" : "") + '" data-extgiver="' + giver +
        '" data-exttoken="' + U.escapeHtml(token) + '" data-extkey="' + U.escapeHtml(key) + '"><span class="l">' + U.escapeHtml(label) + '</span>' +
        (sub ? '<span class="s">' + U.escapeHtml(sub) + '</span>' : "") + '</button>';
    }
    var segs = seg("", "No ext", "");
    opts.forEach(function (o) {
      segs += seg(o.option_key, (o.extension_term === "1YR" ? "+1 yr" : "+2 yr"), U.fmtUsd(o.new_aav_future) + " AAV");
    });
    var preview = "";
    if (curKey) {
      var chosen = opts.filter(function (o) { return o.option_key === curKey; })[0];
      if (chosen) preview = '<div class="ups-m-tb-extprev">→ ' + U.escapeHtml(String(chosen.preview_contract_info_string).replace(/\|\s*/g, " · ")) + '</div>';
    }
    return '<div class="ups-m-tb-extwrap"><div class="ups-m-tb-extlbl">Pre-trade extension</div><div class="ups-m-tb-extctl">' + segs + '</div>' + preview + '</div>';
  }
  function onExt3SegClick() {
    var giver = this.getAttribute("data-extgiver"), token = this.getAttribute("data-exttoken"), key = this.getAttribute("data-extkey");
    b3.ext[giver] = b3.ext[giver] || {};
    if (key) b3.ext[giver][token] = { enabled: true, option_key: key };
    else delete b3.ext[giver][token];
    // Full re-render of the step (the preview changes) but keep scroll position.
    var sy = window.scrollY;
    render3();
    window.scrollTo(0, sy);
  }
  function wireExt3Segs(scope) {
    var segs = scope.querySelectorAll(".ups-m-tb-extseg");
    for (var k = 0; k < segs.length; k++) segs[k].addEventListener("click", onExt3SegClick);
  }
  function render3Assets(body) {
    if (b3.loadingInv) { body.innerHTML = ringLine() + '<div class="ups-m-loading">Loading rosters…</div>'; return; }
    if (b3.invError) { body.innerHTML = ringLine() + '<div class="ups-m-sheet-empty">Couldn\'t load assets: ' + U.escapeHtml(b3.invError) + '</div>'; return; }
    var teams = teamFids();
    function assetRowHtml(giver, token, name, meta, playerObj) {
      var on = !!(b3.give[giver] || {})[token];
      return '<div class="ups-m-3w-assetwrap">' +
        '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-giver="' + giver + '" data-token="' + U.escapeHtml(token) +
          '" data-name="' + U.escapeHtml(String(name || "").toLowerCase()) + '"><span class="nm">' + U.escapeHtml(name) +
          '</span><span class="mt">' + U.escapeHtml(meta) + '</span></button>' +
        (on ? destChooserHtml(giver, token) : '') +
        (on && playerObj ? ext3ControlHtml(giver, token, playerObj) : '') +
      '</div>';
    }
    function sectionHtml(giver, idx) {
      var inv = b3.inv[U.pad4(giver)] || { players: [], future_picks: [] };
      var label = idx === 0 ? "You send" : franchiseName(giver) + " sends";
      var count = Object.keys(b3.give[giver] || {}).length;
      var playersHtml = (inv.players || []).map(function (p) {
        var meta = [p.position, p.nfl_team, (U.safeInt(p.salary, 0) > 0 ? U.fmtUsd(p.salary) : null), (p.taxi ? "Taxi" : null)].filter(Boolean).join(" · ");
        return assetRowHtml(giver, "P_" + p.player_id, p.display || ("Player #" + p.player_id), meta, p);
      }).join("");
      var picksHtml = (inv.future_picks || []).map(function (fp) {
        return assetRowHtml(giver, futurePickToken(fp), fp.display || (fp.year + " R" + fp.round), "Future pick");
      }).join("");
      return '<div class="ups-m-3w-leg">' +
        '<div class="ups-m-tb-subhead">' + U.escapeHtml(label) + ' <span class="cnt" data-cnt="' + giver + '">' + count + ' selected</span></div>' +
        '<div class="ups-m-tb-assets">' + (playersHtml || '<div class="ups-m-auc-empty">No players.</div>') +
          (picksHtml ? '<div class="ups-m-tb-subhead">Future picks</div>' + picksHtml : '') + '</div>' +
      '</div>';
    }
    body.innerHTML =
      ringLine() +
      '<div class="ups-m-tb-steptitle">Pick assets &amp; where each one goes</div>' +
      teams.map(function (g, i) { return sectionHtml(g, i); }).join("") +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-3w-back">Back</button>' +
        '<button class="btn-act otb on" id="ups-m-3w-next">Review</button>' +
      '</div>';
    wireDestPills(body); // already-selected assets render with their chooser
    wireExt3Segs(body);  // …and their extension control, if eligible
    var assetBtns = body.querySelectorAll(".ups-m-tb-asset");
    for (var i = 0; i < assetBtns.length; i++) {
      assetBtns[i].addEventListener("click", function () {
        var giver = this.getAttribute("data-giver"), token = this.getAttribute("data-token");
        var wrap = this.parentNode; // .ups-m-3w-assetwrap
        b3.give[giver] = b3.give[giver] || {};
        if (b3.give[giver][token]) {
          delete b3.give[giver][token];
          if (b3.ext[giver]) delete b3.ext[giver][token];
          this.classList.remove("on");
          var dr = wrap.querySelector(".ups-m-3w-destrow"); if (dr) dr.remove();
          var ew = wrap.querySelector(".ups-m-tb-extwrap"); if (ew) ew.remove();
        } else {
          b3.give[giver][token] = ringNext(giver); this.classList.add("on");
          this.insertAdjacentHTML("afterend", destChooserHtml(giver, token));
          var p = playerForToken(giver, token);
          var extHtml = p ? ext3ControlHtml(giver, token, p) : "";
          if (extHtml) wrap.insertAdjacentHTML("beforeend", extHtml);
          wireDestPills(wrap); wireExt3Segs(wrap);
        }
        var cnt = body.querySelector('[data-cnt="' + giver + '"]');
        if (cnt) cnt.textContent = Object.keys(b3.give[giver]).length + " selected";
      });
    }
    document.getElementById("ups-m-3w-back").addEventListener("click", function () { b3.step = 2; render3(); });
    document.getElementById("ups-m-3w-next").addEventListener("click", function () { b3.step = 4; render3(); });
  }

  // Cap-money inputs live in the review; clamp to §A6 on input + store. No
  // re-render here (review only re-renders on Back/Submit), so focus is kept.
  function wireCap3Inputs(scope) {
    if (!scope) return;
    var ins = scope.querySelectorAll(".ups-m-3w-capin");
    for (var i = 0; i < ins.length; i++) {
      ins[i].addEventListener("input", function () {
        var giver = U.pad4(this.getAttribute("data-capgiver")), dest = U.pad4(this.getAttribute("data-capdest"));
        var maxK = movementMaxCapK(giver, dest);
        var v = Math.max(0, Math.min(U.safeInt(this.value, 0), maxK));
        if (String(v) !== String(this.value)) this.value = String(v);
        b3.cap[giver] = b3.cap[giver] || {};
        b3.cap[giver][dest] = v;
      });
    }
  }

  // ── Step 4: review the deal + notes + submit ──
  function render3Review(body) {
    var teams = teamFids();
    var movements = movementsFromState();
    var participating = {};
    movements.forEach(function (m) { participating[m.from] = 1; participating[m.to] = 1; });
    var allIn = teams.every(function (f) { return participating[f]; });
    var missing = teams.filter(function (f) { return !participating[f]; }).map(franchiseName);
    // A real 3-way: ≥2 movements and every team is in the deal (giving or getting).
    var canSubmit = movements.length >= 2 && allIn;
    function movRow(m) {
      var maxK = movementMaxCapK(m.from, m.to);
      var capCtl = maxK > 0
        ? '<div class="ups-m-3w-capctl"><span class="cl">+ cap $</span>' +
            '<input type="number" class="ups-m-3w-capin" min="0" max="' + maxK + '" step="1" inputmode="numeric" value="' + U.safeInt(m.cap_k, 0) + '" data-capgiver="' + m.from + '" data-capdest="' + m.to + '" aria-label="Cap money ' + U.escapeHtml(franchiseName(m.from)) + ' sends ' + U.escapeHtml(franchiseName(m.to)) + '" />' +
            '<span class="ck">K</span><span class="cm">max $' + maxK + 'K · §A6</span></div>'
        : '';
      return '<div class="ups-m-3w-revrow"><div class="lbl">' + U.escapeHtml(franchiseName(m.from)) + ' → ' + U.escapeHtml(franchiseName(m.to)) + '</div>' +
        '<div class="val">' + U.escapeHtml(m._names.join(", ")) + '</div>' + capCtl + '</div>';
    }
    var rowsHtml = movements.length
      ? movements.map(movRow).join("")
      : '<div class="ups-m-3w-revrow"><div class="val"><span class="muted">Nothing routed yet — go back and pick assets.</span></div></div>';
    // Pre-trade extensions chosen in step 3 (re-derived for the confirmation list).
    function extBlock() {
      var PX = window.UPS_PRETRADE_EXT;
      if (!PX) return "";
      var rows = [];
      teamFids().forEach(function (giver) {
        var extMap = b3.ext[giver] || {}, giveMap = b3.give[giver] || {};
        Object.keys(extMap).forEach(function (token) {
          var sel = extMap[token]; if (!sel || !sel.enabled) return;
          var dest = U.pad4(giveMap[token]); if (!dest) return;
          var p = playerForToken(giver, token); if (!p) return;
          var opts = PX.buildSyntheticExtensionOptions(playerToSelectedAsset(p)) || [];
          var opt = opts.filter(function (o) { return o.option_key === sel.option_key; })[0];
          if (!opt) return;
          rows.push('<div class="ups-m-3w-revrow"><div class="lbl">✨ ' + U.escapeHtml(p.display || ("Player " + p.player_id)) +
            ' (' + (opt.extension_term === "1YR" ? "+1 yr" : "+2 yr") + ')</div><div class="val">' +
            U.escapeHtml(franchiseName(giver)) + ' extends → ' + U.escapeHtml(franchiseName(dest)) + '</div></div>');
        });
      });
      return rows.length ? '<div class="ups-m-tb-subhead" style="margin-top:12px">Pre-trade extensions</div><div class="ups-m-3w-review">' + rows.join("") + '</div>' : "";
    }
    body.innerHTML =
      ringLine() +
      '<div class="ups-m-tb-steptitle">Review the trade</div>' +
      '<div class="ups-m-3w-review">' + rowsHtml + '</div>' +
      extBlock() +
      '<label class="ups-m-3w-noteslbl" for="ups-m-3w-notes">Notes <span class="opt">optional · both partners see this</span></label>' +
      '<textarea class="ups-m-tb-comment" id="ups-m-3w-notes" rows="2" maxlength="500" placeholder="Add a note for the other two teams…">' + U.escapeHtml(b3.notes) + '</textarea>' +
      (!allIn ? '<div class="ups-m-tb-warn">A 3-way needs all three teams in the deal' + (missing.length ? ' — ' + U.escapeHtml(missing.join(" & ")) + ' isn\'t involved yet.' : '.') + '</div>' : '') +
      (b3.error ? '<div class="ups-m-rstr-err">' + U.escapeHtml(b3.error) + '</div>' : '') +
      '<div class="ups-m-tb-warn">When you submit, the other two teams each get a Discord DM to Accept or Decline. Once BOTH accept, the commish runs it as linked MFL trades. MFL can\'t undo a completed trade.</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-3w-back"' + (b3.submitting ? ' disabled' : '') + '>Back</button>' +
        '<button class="btn-act otb on" id="ups-m-3w-submit"' + (canSubmit && !b3.submitting ? '' : ' disabled') + '>' +
          (b3.submitting ? "Sending…" : "Send 3-way") + '</button>' +
      '</div>';
    var notesEl = document.getElementById("ups-m-3w-notes");
    if (notesEl) notesEl.addEventListener("input", function () { b3.notes = this.value; });
    wireCap3Inputs(body);
    document.getElementById("ups-m-3w-back").addEventListener("click", function () { if (!b3.submitting) { b3.step = 3; render3(); } });
    var submit = document.getElementById("ups-m-3w-submit");
    if (submit) submit.addEventListener("click", function () { if (canSubmit && !b3.submitting) submit3Way(); });
  }

  function submit3Way() {
    b3.submitting = true; b3.error = ""; render3();
    var ctx = M.state.ctx;
    var A = U.pad4(M.state.viewerFranchiseId), B = U.pad4(b3.fidB), C = U.pad4(b3.fidC);
    var movements = movementsFromState().map(function (m) {
      return { from: m.from, to: m.to, asset_tokens: m.asset_tokens, cap_k: U.safeInt(m.cap_k, 0), summary: m.summary };
    });
    // Pre-trade extensions: for each marked give-side player still being sent,
    // re-derive the option from the asset (never trust a stale key) and push the
    // same row shape the 2-party builder uses. from=giver, to=its acquirer.
    var extension_requests = [];
    var PX = window.UPS_PRETRADE_EXT;
    if (PX) {
      teamFids().forEach(function (giver) {
        var extMap = b3.ext[giver] || {};
        var giveMap = b3.give[giver] || {};
        Object.keys(extMap).forEach(function (token) {
          var sel = extMap[token];
          if (!sel || !sel.enabled) return;
          var dest = U.pad4(giveMap[token]);
          if (!dest) return; // only if the player is actually being sent
          var p = playerForToken(giver, token);
          if (!p) return;
          var asset = playerToSelectedAsset(p);
          var opts = PX.buildSyntheticExtensionOptions(asset) || [];
          var opt = opts.filter(function (o) { return o.option_key === sel.option_key; })[0];
          if (!opt) return;
          extension_requests.push({
            player_id: asset.player_id, player_name: asset.player_name,
            from_franchise_id: giver, to_franchise_id: dest,
            applies_to_acquirer: true,
            option_key: opt.option_key, extension_term: opt.extension_term,
            loaded_indicator: opt.loaded_indicator, preview_id: opt.preview_id,
            preview_contract_info_string: opt.preview_contract_info_string,
            new_contract_status: opt.new_contract_status,
            new_contract_length: opt.new_contract_length,
            new_TCV: opt.new_TCV, new_aav_future: opt.new_aav_future
          });
        });
      });
    }
    var bodyObj = {
      league_id: ctx.leagueId, season: ctx.year,
      initiator: { fid: A, name: franchiseName(A) },
      team_b: { fid: B, name: franchiseName(B) },
      team_c: { fid: C, name: franchiseName(C) },
      movements: movements,
      extension_requests: extension_requests,
      notes: b3.notes || ""
    };
    var url = M.api.workerUrl("/api/trades/3way?L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    // "Before an owner sends a two-team OR three-team offer that would put either franchise
    // over five loaded contracts, show a clear popup" (Keith's ruling, 2026-09-29) -- purely
    // informational; 3-way creation itself is unchanged (it never took a create-time
    // loaded-contract selection and still doesn't -- the real gate stays post-creation, via
    // the existing accept-review/detail flows).
    runPreSendPreview(A, movements, extension_requests).then(function (pre) {
      if (!pre.proceed) { b3.submitting = false; render3(); return; }
      return fetch(url, {
        method: "POST", mode: "cors", credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj)
      }).then(function (r) {
        return r.text().then(function (txt) {
          var parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
          return { ok: r.ok, status: r.status, body: parsed };
        });
      }).then(function (resp) {
        b3.submitting = false;
        if (resp.ok && resp.body && resp.body.ok !== false) {
          M.ui.showToast("3-way sent — partners notified ✓", "ok");
          close3Way();
          tw.listStatus = "idle"; // refresh the outbox so the new 3-way shows
          loadThreeWays().then(function () { M.route.renderRoute(); });
        } else {
          b3.error = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
          render3();
        }
      });
    }).catch(function (err) {
      b3.submitting = false;
      b3.error = (err && err.message) || String(err);
      render3();
    });
  }

  // ── 3-way trades (canonical server object; see worker/src/trade_3way_model.js) ──
  // Every request forwards the MFL session (?MFL_USER_ID=) and the league (?L=). The
  // server PROVES identity from that session; franchise ids we send are only an
  // "acting as" request, honored for the commissioner alone.
  function tw3Url(pathAndQuery) {
    var ctx = M.state.ctx;
    var url = M.api.workerUrl(pathAndQuery + (pathAndQuery.indexOf("?") >= 0 ? "&" : "?") +
      "L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    var fid = U.pad4(M.state.viewerFranchiseId);
    if (fid) url += "&acting_franchise_id=" + encodeURIComponent(fid);
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return url;
  }
  // Wraps fetch so callers always get { status, ok, body } or { networkError:true } —
  // a failed request can never masquerade as an empty result.
  function tw3Fetch(url, init) {
    init = init || {};
    init.mode = "cors"; init.credentials = "omit";
    return fetch(url, init).then(function (r) {
      return r.text().then(function (txt) {
        var body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { status: r.status, ok: r.ok, body: body };
      });
    }).catch(function () { return { networkError: true }; });
  }
  function loadThreeWays() {
    if (tw.listStatus === "loading") return Promise.resolve();
    if (!T || !M.state.viewerFranchiseId) { tw.listStatus = "ok"; tw.list = []; return Promise.resolve(); }
    tw.listStatus = "loading";
    var mySeq = ++tw.seq;
    var url = tw3Url("/api/trades/3way?franchise_id=" + encodeURIComponent(U.pad4(M.state.viewerFranchiseId)));
    return tw3Fetch(url).then(function (res) {
      if (mySeq !== tw.seq) return;                               // superseded by a newer request
      var out = T.interpretList(res);
      if (out.kind === "ok") { tw.list = out.trades; tw.listProblem = null; tw.listStatus = "ok"; }
      else { tw.listProblem = out; tw.listStatus = "error"; }   // keep the last good list; do NOT assert "none"
    });
  }
  function loadThreeWayDetail(id) {
    var my = ++tw.openSeq;
    tw.detailStatus = "loading"; tw.detailId = id; tw.detailProblem = null;
    return tw3Fetch(tw3Url("/api/trades/3way?id=" + encodeURIComponent(id))).then(function (res) {
      if (my !== tw.openSeq) return;                              // a newer open superseded this response
      var out = T.interpretLoad(res);
      // On (re)entry the SERVER always wins: whatever was cached is only shown while this request is in flight.
      if (out.kind === "ok") { tw.detail = out.trade; tw.detailStatus = "ok"; }
      else { tw.detail = null; tw.detailProblem = out; tw.detailStatus = "error"; }
    });
  }
  function renderThreeWaySection() {
    if (!T) return "";
    var h = "";
    if (tw.listStatus === "error" && tw.listProblem) {
      h += '<div class="ups-m-pos-group">3-Way Trades</div><div style="padding:0 12px">' + T.renderProblem(tw.listProblem, { title: "Couldn't load your 3-way trades" }) + '</div>';
    }
    if (tw.list.length) {
      h += '<div class="ups-m-pos-group">3-Way Trades · ' + tw.list.length + '</div><div style="padding:0 12px">' + tw.list.map(T.renderCard).join("") + '</div>';
    }
    return h;
  }
  function refreshThreeWayList() { tw.listStatus = "idle"; tw.seq++; return loadThreeWays().then(function () { M.route.renderRoute(); }); }

  // Re-check a trade both partners accepted that the salary cap is holding. The server recomputes the cap from scratch and runs it if it's fine.
  function doRecheckThreeWay(id) {
    if (tw.recheck && tw.recheck.busy) return;
    tw.recheck = { busy: true };
    M.route.renderRoute();
    var body = { id: id };
    var fid = U.pad4(M.state.viewerFranchiseId);
    if (fid) body.acting_franchise_id = fid;
    tw3Fetch(tw3Url("/api/trades/3way/recheck"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      var out = T.interpretRecheck(res);
      tw.recheck = { ok: out.ok, message: out.message };
      tw.listStatus = "idle";
      M.ui.showToast(out.message, out.ok ? "ok" : "err");
      return loadThreeWayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }

  // Acknowledge THIS caller's own currently-projected cap overage on a 3-way trade (Keith's
  // ruling, 2026-09-28) — never writes to MFL, never itself re-checks; mirrors doRecheckThreeWay.
  function doAckCapThreeWay(id) {
    if (tw.ack && tw.ack.busy) return;
    tw.ack = { busy: true };
    M.route.renderRoute();
    var body = { id: id };
    var fid = U.pad4(M.state.viewerFranchiseId);
    if (fid) body.acting_franchise_id = fid;
    tw3Fetch(tw3Url("/api/trades/3way/ack-cap"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      var out = T.interpretAckCap(res);
      tw.ack = { ok: out.ok, message: out.message };
      M.ui.showToast(out.message, out.ok ? "ok" : "err");
      return loadThreeWayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }


  function doCancelThreeWay(id) {
    if (tw.cancel.busy) return;
    tw.cancel = { busy: true, confirming: true };
    M.route.renderRoute();
    var body = { id: id };
    var fid = U.pad4(M.state.viewerFranchiseId);
    if (fid) body.acting_franchise_id = fid;
    tw3Fetch(tw3Url("/api/trades/3way/cancel"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      var out = T.interpretCancel(res);
      if (out.applied) {                                            // server-confirmed ONLY
        tw.detail = T.preferNewer(tw.detail, out.trade);
        tw.cancel = { success: out.message };
        tw.listStatus = "idle";
        M.ui.showToast(out.message, "ok");
      } else if (out.kind === "unconfirmed") {
        tw.cancel = { error: out.message };
        return loadThreeWayDetail(id);
      } else {
        if (out.trade) tw.detail = T.preferNewer(tw.detail, out.trade);   // e.g. it moved on to 'executing'
        tw.cancel = { error: out.message };
        M.ui.showToast(out.message, "err");
      }
    }).then(function () { M.route.renderRoute(); });
  }

  function renderThreeWayDetail(mount, id) {
    var head = subTabs("trade") + '<a class="ups-m-subtab" href="#league/trade" style="display:inline-block;margin:0 0 10px">← All trades</a>';
    if (!T) { mount.innerHTML = head + '<div class="ups-m-error">3-way view failed to load. Reload the app.</div>'; return; }
    // Entering the detail route (fresh navigation, Back/Forward, or refresh) always
    // asks the server; a cached copy is only shown while that request is in flight.
    if (tw.lastRoute !== "detail" || tw.detailId !== id) {
      tw.lastRoute = "detail";
      if (tw.detailId !== id) tw.detail = null;
      var wantConfirm = tw.wantConfirm === id; tw.wantConfirm = "";
      tw.cancel = {};
      loadThreeWayDetail(id).then(function () {
        // Card "Cancel" opens straight to the confirmation — but only if the SERVER says it's allowed.
        if (wantConfirm && tw.detail && tw.detail.permissions && tw.detail.permissions.can_cancel) tw.cancel = { confirming: true };
        M.route.renderRoute();
      });
    }
    var body;
    if (tw.detailStatus === "loading" && !tw.detail) body = '<div class="ups-m-loading" role="status">Loading trade…</div>';
    else if (tw.detailStatus === "error" && tw.detailProblem) body = T.renderProblem(tw.detailProblem);
    else if (tw.detail) body = T.renderDetail(tw.detail, { cancel: tw.cancel, recheck: tw.recheck || {}, ackBusy: tw.ack && tw.ack.busy, ackMessage: tw.ack && tw.ack.message, ackOk: tw.ack && tw.ack.ok });
    else body = '<div class="ups-m-loading" role="status">Loading trade…</div>';
    mount.innerHTML = head + '<div style="padding:0 12px">' + body + '</div>';
    T.ensureStyles();
    T.bind(mount, {
      cancel: function () { tw.cancel = { confirming: true }; M.route.renderRoute(); },
      keep: function () { tw.cancel = {}; M.route.renderRoute(); },
      "confirm-cancel": function () { doCancelThreeWay(id); },
      recheck: function () { doRecheckThreeWay(id); },
      "ack-cap": function () { doAckCapThreeWay(id); },
      retry: function () { tw.lastRoute = "list"; M.route.renderRoute(); }
    });
    if (tw.detail && tw.cancel.confirming && !tw.cancel.busy) T.revealConfirm(mount);
  }

  // ── STAGED 2-way trades (worker/src/trade_2way.js / trade_2way_http.js) ──
  // Keith's ruling (2026-09-29, docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §8): a staged
  // 2-way trade is held server-side (D1 only) and never becomes a native MFL tradeProposal
  // while pending -- accepting it is an HTTP action through this app, not a Discord button like
  // 3-way, and every gate is re-checked at each acceptance. This is ADDITIVE: submitOffer()
  // above (the existing direct-to-MFL path, POST /api/trades/proposals) is completely
  // untouched -- this block only ever calls /api/trades/2way* and
  // /api/trades/compliance-preview, so the two paths never cross. "Stage via War Room" is its
  // own CTA next to "+ Build offer", mirroring how 3-way already has its own separate entry
  // point rather than a toggle bolted onto the 2-team builder.
  var tw2s = {
    listStatus: "idle", list: [], listProblem: null, wantConfirm: "", openSeq: 0,
    detailStatus: "idle", detail: null, detailProblem: null, detailId: "",
    lastRoute: "list", cancel: {}, accept: {}, ack: {}, recheck: {}, seq: 0,
    drops: { selections: {} }
  };
  function tw2sUrl(pathAndQuery) {
    var ctx = M.state.ctx;
    var url = M.api.workerUrl(pathAndQuery + (pathAndQuery.indexOf("?") >= 0 ? "&" : "?") +
      "L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    var fid = U.pad4(M.state.viewerFranchiseId);
    if (fid) url += "&acting_franchise_id=" + encodeURIComponent(fid);
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    return url;
  }
  function tw2sFetch(url, init) {
    init = init || {};
    init.mode = "cors"; init.credentials = "omit";
    return fetch(url, init).then(function (r) {
      return r.text().then(function (txt) {
        var body = null; try { body = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { status: r.status, ok: r.ok, body: body };
      });
    }).catch(function () { return { networkError: true }; });
  }
  function tw2sTone(trade) {
    var code = trade && trade.state_view && trade.state_view.code;
    return ({ pending_response: "wait", awaiting_review: "warn", declined: "off", executing: "busy", completed: "ok", failed: "bad", cancelled: "off" })[code] || "off";
  }
  function tw2sTokenLabel(tok) {
    var mm = /^P_(\d+)$/.exec(tok);
    if (mm) return "Player " + mm[1];
    if (/^(FP|DP)_/.test(tok)) return tok.replace(/^FP_/, "Pick ").replace(/^DP_/, "Pick ");
    var bb = /^BB_(\d+)$/.exec(tok);
    if (bb) return "$" + Number(bb[1]).toLocaleString("en-US") + " cap money";
    return tok;
  }
  function tw2sMovementLines(trade) {
    return (trade.movements || []).map(function (m) {
      var names = (m.asset_tokens || []).map(tw2sTokenLabel);
      return '<div class="t3w-mov"><span class="t3w-route">' + U.escapeHtml(franchiseName(m.from)) + ' → ' + U.escapeHtml(franchiseName(m.to)) + '</span>' +
        '<span class="t3w-what">' + names.map(U.escapeHtml).join(", ") + '</span></div>';
    }).join("");
  }
  function loadStaged2Way() {
    if (tw2s.listStatus === "loading") return Promise.resolve();
    if (!T || !M.state.viewerFranchiseId) { tw2s.listStatus = "ok"; tw2s.list = []; return Promise.resolve(); }
    tw2s.listStatus = "loading";
    var mySeq = ++tw2s.seq;
    var url = tw2sUrl("/api/trades/2way?franchise_id=" + encodeURIComponent(U.pad4(M.state.viewerFranchiseId)));
    return tw2sFetch(url).then(function (res) {
      if (mySeq !== tw2s.seq) return;
      if (res && !res.networkError && res.ok && res.body && res.body.ok !== false && Array.isArray(res.body.trades)) {
        tw2s.list = res.body.trades; tw2s.listProblem = null; tw2s.listStatus = "ok";
      } else { tw2s.listProblem = { kind: "error", message: "Couldn't load your staged trades.", retryable: true }; tw2s.listStatus = "error"; }
    });
  }
  function loadStaged2WayDetail(id) {
    var my = ++tw2s.openSeq;
    tw2s.detailStatus = "loading"; tw2s.detailId = id; tw2s.detailProblem = null;
    return tw2sFetch(tw2sUrl("/api/trades/2way?id=" + encodeURIComponent(id))).then(function (res) {
      if (my !== tw2s.openSeq) return;
      if (res && !res.networkError && res.ok && res.body && res.body.ok !== false && res.body.trade) { tw2s.detail = res.body.trade; tw2s.detailStatus = "ok"; }
      else { tw2s.detail = null; tw2s.detailProblem = { kind: "error", message: (res && res.body && (res.body.message || res.body.error)) || "Couldn't load this trade.", retryable: true }; tw2s.detailStatus = "error"; }
    });
  }
  function renderStaged2WaySection() {
    if (!T) return "";
    var h = "";
    if (tw2s.listStatus === "error" && tw2s.listProblem) {
      h += '<div class="ups-m-pos-group">Staged Trades</div><div style="padding:0 12px">' + T.renderProblem(tw2s.listProblem, { title: "Couldn't load your staged trades" }) + '</div>';
    }
    if (tw2s.list.length) {
      h += '<div class="ups-m-pos-group">Staged Trades · ' + tw2s.list.length + '</div><div style="padding:0 12px">' + tw2s.list.map(function (trade) {
        var sv = trade.state_view || {};
        var mine = U.pad4(M.state.viewerFranchiseId) === U.pad4(trade.from_fid);
        return '<div class="t3w-card" data-tw2s-id="' + U.escapeHtml(trade.id) + '">' +
          '<div class="t3w-head"><span class="t3w-pill t3w-tone-' + tw2sTone(trade) + '">' + U.escapeHtml(sv.label) + '</span>' +
          '<span class="t3w-role">' + (mine ? "You sent this" : "Sent to you") + '</span></div>' +
          '<div class="t3w-movs">' + tw2sMovementLines(trade) + '</div>' +
          '<div class="t3w-btns"><button type="button" class="t3w-btn" data-tw2s-act="open" data-tw2s-id="' + U.escapeHtml(trade.id) + '">Details</button></div></div>';
      }).join("") + '</div>';
    }
    return h;
  }
  function refreshStaged2WayList() { tw2s.listStatus = "idle"; tw2s.seq++; return loadStaged2Way().then(function () { M.route.renderRoute(); }); }

  function doAccept2WayStaged(id) {
    if (tw2s.accept.busy) return;
    tw2s.accept = { busy: true };
    M.route.renderRoute();
    tw2sFetch(tw2sUrl("/api/trades/2way/accept"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) }).then(function (res) {
      var ok = !!(res && !res.networkError && res.ok && res.body && res.body.ok);
      var msg = (res && res.body && (res.body.message || res.body.error)) || (res && res.networkError ? "Couldn't reach the server." : "Couldn't accept this trade.");
      tw2s.accept = { ok: ok, message: ok ? (res.body.executing ? "Accepted — clearing final checks…" : msg) : msg };
      M.ui.showToast(tw2s.accept.message, ok ? "ok" : "err");
      return loadStaged2WayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }
  function doCancel2WayStaged(id) {
    if (tw2s.cancel.busy) return;
    tw2s.cancel = { busy: true, confirming: true };
    M.route.renderRoute();
    tw2sFetch(tw2sUrl("/api/trades/2way/cancel"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, reason: "cancelled from mobile" }) }).then(function (res) {
      var ok = !!(res && !res.networkError && res.ok && res.body && res.body.ok);
      if (ok) { tw2s.cancel = { success: "Cancelled." }; tw2s.listStatus = "idle"; M.ui.showToast("Cancelled.", "ok"); }
      else { var msg = (res && res.body && (res.body.message || res.body.error)) || "Couldn't cancel this trade."; tw2s.cancel = { error: msg }; M.ui.showToast(msg, "err"); }
      return loadStaged2WayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }
  function doRecheck2WayStaged(id) {
    if (tw2s.recheck.busy) return;
    tw2s.recheck = { busy: true };
    M.route.renderRoute();
    tw2sFetch(tw2sUrl("/api/trades/2way/recheck"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) }).then(function (res) {
      var ok = !!(res && !res.networkError && res.ok && res.body && res.body.ok);
      var msg = (res && res.body && (res.body.message || res.body.error)) || (res && res.networkError ? "Couldn't reach the server." : "");
      tw2s.recheck = { ok: ok, message: msg };
      M.ui.showToast(msg || (ok ? "Rechecking…" : "Couldn't re-check."), ok ? "ok" : "err");
      return loadStaged2WayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }
  function doSelectDrops2WayStaged(id, fid) {
    if (tw2s.ack.dropBusy) return;
    var picked = (fid && tw2s.drops.selections[fid]) || [];
    tw2s.ack = Object.assign({}, tw2s.ack, { dropBusy: true });
    M.route.renderRoute();
    tw2sFetch(tw2sUrl("/api/trades/2way/select-drops"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, player_ids: picked }) }).then(function (res) {
      var ok = !!(res && !res.networkError && res.ok && res.body && res.body.ok);
      var msg = (res && res.body && (res.body.message || res.body.error)) || (res && res.networkError ? "Couldn't reach the server." : "");
      tw2s.ack = { dropOk: ok, dropMessage: msg, selections: tw2s.drops.selections };
      M.ui.showToast(msg || (ok ? "Selection saved." : "Couldn't save."), ok ? "ok" : "err");
      return loadStaged2WayDetail(id);
    }).then(function () { M.route.renderRoute(); });
  }

  function renderStaged2WayDetailHtml(trade) {
    var sv = trade.state_view || {};
    var perms = trade.permissions || {};
    var cs = tw2s.cancel || {}, ac = tw2s.accept || {};
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var role = myFid === U.pad4(trade.from_fid) ? "You sent this" : myFid === U.pad4(trade.to_fid) ? "Sent to you" : "Commissioner view";
    var h = '<section class="t3w" data-tw2s-id="' + U.escapeHtml(trade.id) + '">';
    h += '<header class="t3w-head"><span class="t3w-pill t3w-tone-' + tw2sTone(trade) + '">' + U.escapeHtml(sv.label) + '</span><span class="t3w-role">' + role + '</span></header>';
    h += '<p class="t3w-msg"><b>Staged — held server-side.</b> This has never been proposed to MFL and will not be, unless and until it clears every check below.</p>';
    if (sv.message) h += '<p class="t3w-msg">' + U.escapeHtml(sv.message) + '</p>';
    h += '<div class="t3w-sides"><article class="t3w-side"><h4 class="t3w-team">' + U.escapeHtml(trade.from_name) + ' <span class="t3w-tag">Sender</span></h4></article>' +
      '<article class="t3w-side"><h4 class="t3w-team">' + U.escapeHtml(trade.to_name) +
      ' <span class="t3w-tag t3w-tag-' + (trade.to_state === "accepted" ? "accepted" : trade.to_state === "declined" ? "declined" : "") + '">' +
      (trade.to_state === "accepted" ? "Accepted" : trade.to_state === "declined" ? "Declined" : "Waiting") + '</span></h4></article></div>';
    h += '<div class="t3w-movs">' + tw2sMovementLines(trade) + '</div>';
    if (trade.compliance) h += T.renderCompliance(trade.compliance, { gate: sv.code === "pending_response" || sv.code === "awaiting_review", capAck: trade.cap_ack, viewerFid: myFid, dropBusy: tw2s.ack.dropBusy, dropMessage: tw2s.ack.dropMessage, dropOk: tw2s.ack.dropOk, selections: tw2s.drops.selections });
    if (trade.notes) h += '<div class="t3w-note"><b>Note:</b> ' + U.escapeHtml(trade.notes) + '</div>';
    if (perms.can_accept) {
      h += '<div class="t3w-btns"><button type="button" class="t3w-btn t3w-btn-primary" data-tw2s-act="accept"' + (ac.busy ? " disabled" : "") + '>' + (ac.busy ? "Accepting…" : "Accept") + '</button>' +
        '<button type="button" class="t3w-btn" data-tw2s-act="decline"' + (ac.busy ? " disabled" : "") + '>Decline</button></div>';
    }
    if (perms.can_recheck) h += '<div class="t3w-btns"><button type="button" class="t3w-btn t3w-btn-primary" data-tw2s-act="recheck"' + (tw2s.recheck.busy ? " disabled" : "") + '>' + (tw2s.recheck.busy ? "Checking…" : "Re-check now") + '</button></div>';
    if (perms.can_cancel) {
      if (cs.confirming) {
        h += '<div class="t3w-confirm"><p><b>Cancel this staged trade?</b> The other team will be told it\'s off.</p><div class="t3w-btns">' +
          '<button type="button" class="t3w-btn" data-tw2s-act="keep"' + (cs.busy ? " disabled" : "") + '>Keep it</button>' +
          '<button type="button" class="t3w-btn t3w-btn-danger" data-tw2s-act="confirm-cancel"' + (cs.busy ? " disabled" : "") + '>' + (cs.busy ? "Cancelling…" : "Yes, cancel it") + '</button></div></div>';
      } else {
        h += '<div class="t3w-btns"><button type="button" class="t3w-btn t3w-btn-danger" data-tw2s-act="cancel"' + (cs.busy ? " disabled" : "") + '>Cancel</button></div>';
      }
    }
    h += '</section>';
    return h;
  }
  function renderStaged2WayDetail(mount, id) {
    var head = subTabs("trade") + '<a class="ups-m-subtab" href="#league/trade" style="display:inline-block;margin:0 0 10px">← All trades</a>';
    if (!T) { mount.innerHTML = head + '<div class="ups-m-error">Trade view failed to load. Reload the app.</div>'; return; }
    if (tw2s.lastRoute !== "detail" || tw2s.detailId !== id) {
      tw2s.lastRoute = "detail";
      if (tw2s.detailId !== id) tw2s.detail = null;
      var wantConfirm = tw2s.wantConfirm === id; tw2s.wantConfirm = "";
      tw2s.cancel = {};
      loadStaged2WayDetail(id).then(function () {
        if (wantConfirm && tw2s.detail && tw2s.detail.permissions && tw2s.detail.permissions.can_cancel) tw2s.cancel = { confirming: true };
        M.route.renderRoute();
      });
    }
    var body;
    if (tw2s.detailStatus === "loading" && !tw2s.detail) body = '<div class="ups-m-loading" role="status">Loading trade…</div>';
    else if (tw2s.detailStatus === "error" && tw2s.detailProblem) body = T.renderProblem(tw2s.detailProblem, { title: "Couldn't load this staged trade" });
    else if (tw2s.detail) body = renderStaged2WayDetailHtml(tw2s.detail);
    else body = '<div class="ups-m-loading" role="status">Loading trade…</div>';
    mount.innerHTML = head + '<div style="padding:0 12px">' + body + '</div>';
    T.ensureStyles();
    var clickHandlers = {
      cancel: function () { tw2s.cancel = { confirming: true }; M.route.renderRoute(); },
      keep: function () { tw2s.cancel = {}; M.route.renderRoute(); },
      "confirm-cancel": function () { doCancel2WayStaged(id); },
      accept: function () { doAccept2WayStaged(id); },
      decline: function () { doCancel2WayStaged(id); },
      recheck: function () { doRecheck2WayStaged(id); },
      "select-drops": function (bid, el) { doSelectDrops2WayStaged(id, el && el.getAttribute ? el.getAttribute("data-t3w-drop-fid") : ""); }
    };
    if (!mount.__tw2sBound) {
      mount.__tw2sBound = true;
      mount.addEventListener("click", function (ev) {
        var el = ev.target && ev.target.closest ? ev.target.closest("[data-tw2s-act]") : null;
        if (!el || el.disabled) return;
        var fn = clickHandlers[el.getAttribute("data-tw2s-act")];
        if (typeof fn === "function") { ev.preventDefault(); fn(el.getAttribute("data-tw2s-id") || "", el); }
      });
      mount.addEventListener("change", function (ev) {
        var box = ev.target;
        if (!box || !box.matches || !box.matches("input[data-t3w-drop-pid]")) return;
        var pfid = box.getAttribute("data-t3w-drop-fid");
        var pid = box.getAttribute("data-t3w-drop-pid");
        var cur = tw2s.drops.selections[pfid] || [];
        if (box.checked) { if (cur.indexOf(pid) === -1) cur = cur.concat([pid]); } else { cur = cur.filter(function (x) { return x !== pid; }); }
        tw2s.drops.selections[pfid] = cur;
        M.route.renderRoute();
      });
    }
    if (tw2s.detail && tw2s.cancel.confirming && !tw2s.cancel.busy) T.revealConfirm(mount);
  }

  // ── pre-send notice (mobile), mirrors desktop's showPreSendLoadedContractPopup exactly
  // (Keith's ruling, 2026-10-01, REPLACING the pre-send picker of 2026-09-29): a franchise over
  // the loaded-contract limit is a hard stop. Uses /api/trades/compliance-preview -- a trade
  // that hasn't been created yet -- so the sender finds out BEFORE wasting a round trip to the
  // real gate (create/accept, which refuses it either way). Purely informational and never
  // itself the enforcement point: it offers no picker and no in-trade fix, just the team(s),
  // projected count, limit, and the instruction to revise the offer or make a separate roster
  // move first -- with the choice to go back and fix it now, or send anyway and let the real
  // gate refuse it.
  function showPreSendLoadedContractSheet(compliance) {
    var lc = compliance && compliance.loaded_contracts;
    if (!lc || lc.status !== "blocked") return Promise.resolve({ proceed: true });
    var mount = document.getElementById("ups-m-app");
    if (!mount) return Promise.resolve({ proceed: true });
    var existing = document.getElementById("ups-m-presend-overlay");
    if (existing) existing.remove();
    var rows = (lc.violations || []).map(function (v) {
      return '<li><span class="t3w-cr-name">' + U.escapeHtml(v.franchise_name || v.franchise_id) + '</span>' +
        '<span class="t3w-cr-flag">' + U.escapeHtml(v.projected) + ' of ' + U.escapeHtml(v.max) + ' max</span></li>';
    }).join("");
    return new Promise(function (resolve) {
      var settled = false;
      function close(v) { if (settled) return; settled = true; var ov = document.getElementById("ups-m-presend-overlay"); if (ov) ov.remove(); document.body.style.overflow = ""; resolve(v); }
      var html =
        '<div class="ups-m-drop-overlay" id="ups-m-presend-overlay"><div class="ups-m-drop-sheet">' +
          '<div class="ups-m-drop-head"><button class="ups-m-drop-close" id="ups-m-presend-close" aria-label="Close">×</button><div class="grip"></div>' +
          '<div class="title">Loaded-contract limit — before you send</div></div>' +
          '<div class="ups-m-drop-body">' +
            '<p class="sub">' + U.escapeHtml(lc.message || "This trade would leave a team over the loaded-contract limit.") + '</p>' +
            (rows ? '<ul class="t3w-crows" aria-label="Teams over the loaded-contract limit">' + rows + '</ul>' : '') +
            '<p class="sub">Revise the offer, or make a separate roster move first, then try again.</p>' +
            '<div class="ups-m-tb-nav"><button class="btn-act" id="ups-m-presend-cancel">Go back</button><button class="btn-act otb on" id="ups-m-presend-go">Send anyway</button></div>' +
          '</div></div></div>';
      mount.insertAdjacentHTML("beforeend", html);
      document.body.style.overflow = "hidden";
      document.getElementById("ups-m-presend-close").addEventListener("click", function () { close({ proceed: false }); });
      document.getElementById("ups-m-presend-cancel").addEventListener("click", function () { close({ proceed: false }); });
      document.getElementById("ups-m-presend-go").addEventListener("click", function () { close({ proceed: true }); });
    });
  }
  function runPreSendPreview(fromFid, movements, extensionRequests) {
    var ctx = M.state.ctx;
    var url = M.api.workerUrl("/api/trades/compliance-preview?L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    var body = { league_id: ctx.leagueId, season: ctx.year, from_franchise_id: U.pad4(fromFid), movements: movements, extension_requests: extensionRequests || [] };
    return tw2sFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (res) {
      if (!res || res.networkError || !res.ok || !res.body || res.body.ok === false || !res.body.compliance) return { proceed: true };
      return showPreSendLoadedContractSheet(res.body.compliance);
    }).catch(function () { return { proceed: true }; });
  }

  // Stages a new 2-team offer via the War Room instead of direct-to-MFL. Reuses the EXISTING
  // builder's own payload (buildOfferPayload) -- a separate CTA/function from submitOffer, so
  // there is no shared decision point where the two paths could cross.
  function tw2sAssetToken(a) {
    if (!a) return "";
    if (String(a.type || "").toUpperCase() === "PLAYER") return "P_" + String(a.player_id || "").replace(/\D/g, "");
    if (String(a.type || "").toUpperCase() === "PICK") return String(a.pick_key || a.asset_id || "");
    return "";
  }
  function tw2sMovementsFromPayload(payload) {
    var teams = (payload && payload.teams) || [];
    var left = teams[0], right = teams[1];
    if (!left || !right || !left.franchise_id || !right.franchise_id) return [];
    var out = [];
    function push(from, to, side) {
      var tokens = (side.selected_assets || []).map(tw2sAssetToken).filter(Boolean);
      var capK = U.safeInt(side.traded_salary_adjustment_k, 0);
      if (!tokens.length && capK <= 0) return;
      out.push({ from: U.pad4(from), to: U.pad4(to), asset_tokens: tokens, cap_k: capK });
    }
    push(left.franchise_id, right.franchise_id, left);
    push(right.franchise_id, left.franchise_id, right);
    return out;
  }
  function submitStagedOffer() {
    builderState.submitting = true; builderState.error = ""; renderBuilder();
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var theirFid = U.pad4(builderState.counterpartyFid);
    var payload = buildOfferPayload();
    var movements = tw2sMovementsFromPayload(payload);
    if (!movements.length) { builderState.submitting = false; builderState.error = "Add at least one asset to stage."; renderBuilder(); return; }
    runPreSendPreview(myFid, movements, payload.extension_requests).then(function (pre) {
      if (!pre.proceed) { builderState.submitting = false; renderBuilder(); return; }
      var url = M.api.workerUrl("/api/trades/2way?L=" + encodeURIComponent(M.state.ctx.leagueId) + "&YEAR=" + encodeURIComponent(M.state.ctx.year));
      var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
      if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
      var body = {
        from: { fid: myFid, name: franchiseName(myFid) },
        to: { fid: theirFid, name: franchiseName(theirFid) },
        movements: movements,
        extension_requests: payload.extension_requests,
        loaded_contract_drops: pre.drops,
        notes: builderState.comment || ""
      };
      return tw2sFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (res) {
        builderState.submitting = false;
        if (res && !res.networkError && res.ok && res.body && res.body.ok) {
          M.ui.showToast("Staged — awaiting review. Held server-side; not sent to MFL. ✓", "ok");
          closeBuilder();
          refreshStaged2WayList();
        } else {
          builderState.error = (res && res.body && (res.body.message || res.body.error)) || (res && res.networkError ? "Couldn't reach the server." : "Couldn't stage this offer.");
          renderBuilder();
        }
      });
    }).catch(function (err) {
      builderState.submitting = false;
      builderState.error = (err && err.message) || String(err);
      renderBuilder();
    });
  }

  function render(mount, parts) {
    // Staged Trades removed from the normal UI, Keith's ruling 2026-10-01 -- see
    // trade_workbench.html's matching removal comment on desktop. A stale #league/trade/2s/<id>
    // link (old bookmark, old chat link) now just falls through to the normal trade list below,
    // same as any other unrecognized route, rather than opening a staged-trade detail.
    // #league/trade/3w/<id> — a single 3-way trade, deep-linkable and refresh-safe.
    if (parts && parts[0] === "3w" && parts[1]) return renderThreeWayDetail(mount, parts[1]);
    // Back on the list: any earlier detail is stale by definition; refetch the outbox.
    if (tw.lastRoute === "detail") { tw.lastRoute = "list"; tw.listStatus = "idle"; }
    // Pre-load: loadAllData fetches trade offers as part of its
    // post-franchise-resolve step, so the badge on the League nav can
    // appear before the user navigates here. Always prefer the global
    // M.state.tradeOffers copy so reloadData() bust-invalidates the cache.
    // Kick off the 3-way load in parallel (independent of the offers fetch);
    // it re-renders when done so the outbox section appears.
    if (tw.listStatus === "idle") {
      loadThreeWays().then(function () { M.route.renderRoute(); });
    }
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
    // Unavailable is not empty: signed-out → "Sign in to view trades"; a failed load → an explicit error
    // with Try again. Only status "ok" (or a legacy list from an older worker cache) renders "0 offers".
    if (data.status === "signed_out" || data.status === "error") {
      mount.innerHTML = subTabs("trade") + renderInboxUnavailable(data);
      var retryBtn = mount.querySelector("#ups-m-trade-retry");
      if (retryBtn) retryBtn.addEventListener("click", function () {
        state.offers = null; state.error = null;
        if (M.actions && M.actions.reloadData) M.actions.reloadData().then(function () { M.route.renderRoute(); });
        else loadOffers().then(function () { M.route.renderRoute(); });
      });
      return;
    }
    var incoming = data.incoming || [];
    var outgoing = data.outgoing || [];

    var html = subTabs("trade");
    // CTA — native in-app builder (players + future picks + cap money).
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Build a new offer</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'Trade players, future picks, and cap money right here.' +
      '</div>' +
      '<button class="btn-act otb on" id="ups-m-tb-open" style="width:100%">+ Build offer</button>' +
    '</div>';

    // CTA — 3-way trade (free-form: route any asset among the three teams).
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">3-way trade</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'If you\'ve never had a 3-way, now\'s your chance. Three teams, one deal — route any player or pick to whoever\'s getting it.' +
      '</div>' +
      '<button class="btn-act otb on" id="ups-m-3w-open" style="width:100%">+ Build 3-way</button>' +
    '</div>';

    // Active 3-way trades the viewer is part of (initiator or partner).
    html += renderThreeWaySection();

    // Staged Trades section removed from the normal UI, Keith's ruling 2026-10-01 -- see
    // trade_workbench.html's matching removal comment on desktop.

    html += '<div class="ups-m-pos-group" style="margin-top:18px">Incoming · ' + incoming.length + '</div>';
    html += renderOffersList(incoming, "incoming");
    html += '<div class="ups-m-pos-group" style="margin-top:18px">Outgoing · ' + outgoing.length + '</div>';
    html += renderOffersList(outgoing, "outgoing");

    mount.innerHTML = html;

    var openBtn = mount.querySelector("#ups-m-tb-open");
    if (openBtn) openBtn.addEventListener("click", openBuilder);
    var open3Btn = mount.querySelector("#ups-m-3w-open");
    if (open3Btn) open3Btn.addEventListener("click", open3WayBuilder);
    if (T) {
      T.ensureStyles();
      T.bind(mount, {
        open: function (id) { M.route.navigate("#league/trade/3w/" + encodeURIComponent(id)); },
        "open-cancel": function (id) { tw.wantConfirm = id; M.route.navigate("#league/trade/3w/" + encodeURIComponent(id)); },
        retry: function () { refreshThreeWayList(); }
      });
      mount.addEventListener("click", function (ev) {
        var el = ev.target && ev.target.closest ? ev.target.closest("[data-tw2s-act]") : null;
        if (!el) return;
        var act = el.getAttribute("data-tw2s-act");
        var id = el.getAttribute("data-tw2s-id") || "";
        if (act === "open") { M.route.navigate("#league/trade/2s/" + encodeURIComponent(id)); }
        else if (act === "open-cancel") { tw2s.wantConfirm = id; M.route.navigate("#league/trade/2s/" + encodeURIComponent(id)); }
      });
    }

    var btns = mount.querySelectorAll(".btn-act[data-act]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        var act = this.getAttribute("data-act");
        var tid = this.getAttribute("data-trade-id");
        if (act === "counter") {
          openBuilder({ counterFid: this.getAttribute("data-from-fid"), counterTradeId: tid });
          return;
        }
        handleAction(act, tid);
      });
    }

    // Trade-DM deep-link consumption: if we arrived via a Discord DM button
    // (?focus_trade=<id>&intent=…, captured in app.js detectContext), act on
    // that specific incoming offer now that its card is rendered. Consumed
    // (cleared) immediately so it can't re-fire on the next renderRoute().
    var focus = M.state.pendingTradeFocus;
    if (focus && focus.tradeId) {
      M.state.pendingTradeFocus = null;
      var fmatch = incoming.filter(function (o) {
        return String(o.trade_id || o.id || "").replace(/\D/g, "") === focus.tradeId;
      })[0];
      if (fmatch) {
        var ftid = String(fmatch.trade_id || fmatch.id || "");
        if (focus.intent === "decline") {
          openDeclineSheet(ftid);
        } else if (focus.intent === "counter") {
          openBuilder({ counterFid: U.pad4(fmatch.offered_by || fmatch.from_franchise_id || ""), counterTradeId: ftid });
        } else {
          var fcard = mount.querySelector('[data-trade-id="' + ftid + '"]');
          var fhost = fcard && fcard.closest ? fcard.closest(".ups-m-card") : null;
          if (fhost && fhost.scrollIntoView) fhost.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } else if (M.ui && M.ui.showToast) {
        M.ui.showToast("That offer isn't in your inbox anymore.", "info");
      }
    }
  }

  M.tradeView = { render: render, openBuilder: openBuilder, open3WayBuilder: open3WayBuilder };
})();
