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
      tab("auction", "Auction", "auction") +
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
    fetch(url, {
      method: "POST", mode: "cors", credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) {}
        return { ok: r.ok, status: r.status, body: parsed };
      });
    }).then(function (resp) {
      builderState.submitting = false;
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

  function handleAction(action, tradeId) {
    if (action === "decline") { openDeclineSheet(tradeId); return; }
    var prompt = action === "accept" ? "Accept this trade?\n\nWrites to MFL." :
                 "Cancel this outgoing offer?";
    if (!window.confirm(prompt)) return;
    runTradeAction(action, tradeId, "");
  }

  // ════════════════════════ 3-WAY (RING) TRADE BUILDER ════════════════════════
  // A dedicated ring: You(A) → Partner B → Partner C → You(A). Three legs — you
  // send to B, B sends to C, C sends back to you. MFL only does 2-party trades,
  // so the worker (worker/src/trade_3way.js) executes this as two chained commish
  // trades once BOTH partners accept their Discord DM. This builder just composes
  // the ring and POSTs it to /api/trades/3way. Players + future picks only for v1
  // (cap money in a leg needs the salary-adjustment handling the ring engine
  // doesn't do yet — desktop Trade War Room / Phase 2).
  var b3 = null;
  function fresh3() {
    return {
      step: 1,              // 1 pick B · 2 pick C · 3 assets · 4 review
      fidB: "", fidC: "",
      inv: {}, loadingInv: false, invError: "",
      sel: { AB: {}, BC: {}, CA: {} },
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
  // Tokens + display names for a leg's current selection. The selected ids ARE
  // the MFL-ready tokens (P_<id> / FP_<orig>_<yr>_<rd>) — the ring engine's
  // toMflAsset normalizes them server-side.
  function leg3Assets(fid, idMap) {
    var inv = b3.inv[U.pad4(fid)] || { players: [], future_picks: [] };
    var tokens = [], names = [];
    (inv.players || []).forEach(function (p) {
      if (idMap["P_" + p.player_id]) { tokens.push("P_" + p.player_id); names.push(p.display || ("Player #" + p.player_id)); }
    });
    (inv.future_picks || []).forEach(function (fp) {
      var t = futurePickToken(fp);
      if (idMap[t]) { tokens.push(t); names.push(fp.display || (fp.year + " R" + fp.round)); }
    });
    return { tokens: tokens, names: names };
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
            '<div class="title">3-Way Ring Trade</div>' +
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
      '<span class="you">' + U.escapeHtml(A) + '</span><span class="arr">→</span>' +
      '<span>' + U.escapeHtml(B) + '</span><span class="arr">→</span>' +
      '<span>' + U.escapeHtml(C) + '</span><span class="arr">→</span>' +
      '<span class="you">' + U.escapeHtml(A) + '</span>' +
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

  // ── Steps 1 & 2: pick partner B (you send to) then C (sends back to you) ──
  function render3PickPartner(body, slot) {
    var myFid = U.pad4(M.state.viewerFranchiseId);
    var taken = slot === "C" ? [myFid, U.pad4(b3.fidB)] : [myFid];
    var others = (M.state.franchises || []).filter(function (f) { return taken.indexOf(f.id) === -1; });
    var prompt = slot === "B" ? "Who do you send to? (Partner 1)" : "Who sends back to you? (Partner 2)";
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

  // ── Step 3: pick each leg's assets (each section = that leg's giver's roster) ──
  function render3Assets(body) {
    if (b3.loadingInv) { body.innerHTML = ringLine() + '<div class="ups-m-loading">Loading rosters…</div>'; return; }
    if (b3.invError) { body.innerHTML = ringLine() + '<div class="ups-m-sheet-empty">Couldn\'t load assets: ' + U.escapeHtml(b3.invError) + '</div>'; return; }
    var A = U.pad4(M.state.viewerFranchiseId), B = U.pad4(b3.fidB), C = U.pad4(b3.fidC);
    var legs = [
      { key: "AB", fid: A, label: "You send → " + franchiseName(B) },
      { key: "BC", fid: B, label: franchiseName(B) + " sends → " + franchiseName(C) },
      { key: "CA", fid: C, label: franchiseName(C) + " sends → you" }
    ];
    function sectionHtml(leg) {
      var inv = b3.inv[U.pad4(leg.fid)] || { players: [], future_picks: [] };
      var idMap = b3.sel[leg.key];
      var playersHtml = (inv.players || []).map(function (p) {
        var id = "P_" + p.player_id, on = !!idMap[id];
        var meta = [p.position, p.nfl_team, (U.safeInt(p.salary, 0) > 0 ? U.fmtUsd(p.salary) : null), (p.taxi ? "Taxi" : null)].filter(Boolean).join(" · ");
        return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-leg="' + leg.key + '" data-id="' + U.escapeHtml(id) +
          '" data-name="' + U.escapeHtml(String(p.display || "").toLowerCase()) + '"><span class="nm">' + U.escapeHtml(p.display || ("Player #" + p.player_id)) +
          '</span><span class="mt">' + U.escapeHtml(meta) + '</span></button>';
      }).join("");
      var picksHtml = (inv.future_picks || []).map(function (fp) {
        var id = futurePickToken(fp), on = !!idMap[id];
        return '<button class="ups-m-tb-asset' + (on ? ' on' : '') + '" data-leg="' + leg.key + '" data-id="' + U.escapeHtml(id) +
          '" data-name="pick ' + U.escapeHtml(String(fp.year)) + '"><span class="nm">' + U.escapeHtml(fp.display || (fp.year + " R" + fp.round)) +
          '</span><span class="mt">Future pick</span></button>';
      }).join("");
      return '<div class="ups-m-3w-leg">' +
        '<div class="ups-m-tb-subhead">' + U.escapeHtml(leg.label) + ' <span class="cnt" data-cnt="' + leg.key + '">' + countSelected(idMap) + ' selected</span></div>' +
        '<div class="ups-m-tb-assets">' + (playersHtml || '<div class="ups-m-auc-empty">No players.</div>') +
          (picksHtml ? '<div class="ups-m-tb-subhead">Future picks</div>' + picksHtml : '') + '</div>' +
      '</div>';
    }
    body.innerHTML =
      ringLine() +
      '<div class="ups-m-tb-steptitle">Build the ring — pick what each team sends</div>' +
      legs.map(sectionHtml).join("") +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-3w-back">Back</button>' +
        '<button class="btn-act otb on" id="ups-m-3w-next">Review</button>' +
      '</div>';
    var assetBtns = body.querySelectorAll(".ups-m-tb-asset");
    for (var i = 0; i < assetBtns.length; i++) {
      assetBtns[i].addEventListener("click", function () {
        var leg = this.getAttribute("data-leg"), id = this.getAttribute("data-id");
        var idMap = b3.sel[leg];
        if (idMap[id]) { delete idMap[id]; this.classList.remove("on"); }
        else { idMap[id] = true; this.classList.add("on"); }
        var cnt = body.querySelector('[data-cnt="' + leg + '"]');
        if (cnt) cnt.textContent = countSelected(idMap) + " selected";
      });
    }
    document.getElementById("ups-m-3w-back").addEventListener("click", function () { b3.step = 2; render3(); });
    document.getElementById("ups-m-3w-next").addEventListener("click", function () { b3.step = 4; render3(); });
  }

  // ── Step 4: review the ring + submit ──
  function render3Review(body) {
    var A = U.pad4(M.state.viewerFranchiseId), B = U.pad4(b3.fidB), C = U.pad4(b3.fidC);
    var ab = leg3Assets(A, b3.sel.AB), bc = leg3Assets(B, b3.sel.BC), ca = leg3Assets(C, b3.sel.CA);
    var allFull = ab.tokens.length && bc.tokens.length && ca.tokens.length;
    function legRow(fromN, toN, names) {
      return '<div class="ups-m-3w-revrow"><div class="lbl">' + U.escapeHtml(fromN) + ' → ' + U.escapeHtml(toN) + '</div>' +
        '<div class="val">' + (names.length ? U.escapeHtml(names.join(", ")) : '<span class="muted">— nothing —</span>') + '</div></div>';
    }
    body.innerHTML =
      ringLine() +
      '<div class="ups-m-tb-steptitle">Review the ring</div>' +
      '<div class="ups-m-3w-review">' +
        legRow(franchiseName(A), franchiseName(B), ab.names) +
        legRow(franchiseName(B), franchiseName(C), bc.names) +
        legRow(franchiseName(C), franchiseName(A), ca.names) +
      '</div>' +
      (!allFull ? '<div class="ups-m-tb-warn">Each team needs to send at least one asset for a balanced ring.</div>' : '') +
      (b3.error ? '<div class="ups-m-rstr-err">' + U.escapeHtml(b3.error) + '</div>' : '') +
      '<div class="ups-m-tb-warn">When you submit, ' + U.escapeHtml(franchiseName(B)) + ' and ' + U.escapeHtml(franchiseName(C)) +
        ' each get a Discord DM to Accept or Decline. Once BOTH accept, the commish runs it as two linked MFL trades. MFL can\'t undo a completed trade.</div>' +
      '<div class="ups-m-tb-nav">' +
        '<button class="btn-act" id="ups-m-3w-back"' + (b3.submitting ? ' disabled' : '') + '>Back</button>' +
        '<button class="btn-act otb on" id="ups-m-3w-submit"' + (allFull && !b3.submitting ? '' : ' disabled') + '>' +
          (b3.submitting ? "Sending…" : "Send 3-way") + '</button>' +
      '</div>';
    document.getElementById("ups-m-3w-back").addEventListener("click", function () { if (!b3.submitting) { b3.step = 3; render3(); } });
    var submit = document.getElementById("ups-m-3w-submit");
    if (submit) submit.addEventListener("click", function () { if (allFull && !b3.submitting) submit3Way(); });
  }

  function submit3Way() {
    b3.submitting = true; b3.error = ""; render3();
    var ctx = M.state.ctx;
    var A = U.pad4(M.state.viewerFranchiseId), B = U.pad4(b3.fidB), C = U.pad4(b3.fidC);
    var ab = leg3Assets(A, b3.sel.AB), bc = leg3Assets(B, b3.sel.BC), ca = leg3Assets(C, b3.sel.CA);
    var bodyObj = {
      league_id: ctx.leagueId, season: ctx.year,
      initiator: { fid: A, name: franchiseName(A) },
      team_b: { fid: B, name: franchiseName(B) },
      team_c: { fid: C, name: franchiseName(C) },
      legs: [
        { from: A, to: B, asset_tokens: ab.tokens, cap_k: 0, summary: ab.names.join(", ") },
        { from: B, to: C, asset_tokens: bc.tokens, cap_k: 0, summary: bc.names.join(", ") },
        { from: C, to: A, asset_tokens: ca.tokens, cap_k: 0, summary: ca.names.join(", ") }
      ]
    };
    var url = M.api.workerUrl("/api/trades/3way?L=" + encodeURIComponent(ctx.leagueId) + "&YEAR=" + encodeURIComponent(ctx.year));
    var stored = M.api.getStoredMflUserId && M.api.getStoredMflUserId();
    if (stored) url += "&MFL_USER_ID=" + encodeURIComponent(stored);
    fetch(url, {
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
      } else {
        b3.error = (resp.body && (resp.body.error || resp.body.message)) || ("HTTP " + resp.status);
        render3();
      }
    }).catch(function (err) {
      b3.submitting = false;
      b3.error = (err && err.message) || String(err);
      render3();
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
    // CTA — native in-app builder (players + future picks + cap money).
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">Build a new offer</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'Trade players, future picks, and cap money right here.' +
      '</div>' +
      '<button class="btn-act otb on" id="ups-m-tb-open" style="width:100%">+ Build offer</button>' +
    '</div>';

    // CTA — 3-way ring trade (You → B → C → You; executed as two linked MFL trades).
    html += '<div class="ups-m-card">' +
      '<div class="ups-m-card-title">3-way ring trade</div>' +
      '<div style="font-size:12px;color:var(--fg-muted);margin-bottom:10px">' +
        'If you\'ve never had a 3-way, now\'s your chance. Three teams, one ring — you send, they send, and a player comes back to you.' +
      '</div>' +
      '<button class="btn-act otb on" id="ups-m-3w-open" style="width:100%">+ Build 3-way</button>' +
    '</div>';

    html += '<div class="ups-m-pos-group">Incoming · ' + incoming.length + '</div>';
    html += renderOffersList(incoming, "incoming");
    html += '<div class="ups-m-pos-group" style="margin-top:18px">Outgoing · ' + outgoing.length + '</div>';
    html += renderOffersList(outgoing, "outgoing");

    mount.innerHTML = html;

    var openBtn = mount.querySelector("#ups-m-tb-open");
    if (openBtn) openBtn.addEventListener("click", openBuilder);
    var open3Btn = mount.querySelector("#ups-m-3w-open");
    if (open3Btn) open3Btn.addEventListener("click", open3WayBuilder);

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
